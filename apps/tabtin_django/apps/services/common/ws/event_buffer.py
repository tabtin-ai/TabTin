"""
Event buffer service — Redis Stream-based event persistence for WS resume/replay.

Design:
  - One Redis Stream per topic (key = ``ws:evt:{topic}``)
  - Atomic Lua append with per-event and per-topic byte budgets
  - Message six-piece entries collapse into ``message_committed`` checkpoints
  - XRANGE for gap-fill replay; unresolved gaps fail closed
  - Periodic XTRIM via Celery beat for time-based expiration
  - Fully non-blocking publish path: buffer failures never block live delivery
"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-topic retention configuration
# ---------------------------------------------------------------------------

BUFFER_CONFIG: Dict[str, Dict[str, int]] = {
    "table.events":     {"max_len": 500, "max_age_seconds": 300},
    "table.open":       {"max_len": 500, "max_age_seconds": 300},
    "doc.events":       {"max_len": 200, "max_age_seconds": 300},
    "context.sync":     {"max_len": 200, "max_age_seconds": 300},
    "agent.stream":     {"max_len": 5000, "max_age_seconds": 3600},
    "agent.action":     {"max_len": 5000, "max_age_seconds": 3600},
    "agent.external":   {"max_len": 5000, "max_age_seconds": 3600},
    "trace.stream":     {"max_len": 300, "max_age_seconds": 300},
    "scheduled.tasks":  {"max_len": 50,  "max_age_seconds": 300},
    "channel":          {"max_len": 200, "max_age_seconds": 300},
    "asr.stream":       {"max_len": 200, "max_age_seconds": 120},
    "tts.stream":       {"max_len": 200, "max_age_seconds": 120},
    "ssh.stream":       {"max_len": 500, "max_age_seconds": 300},
    "docparse.events":  {"max_len": 100, "max_age_seconds": 300},
    # Tracker：波次 4 Stage 2.3 一刀切，legacy goal.events / agenda.events 已下线
    "tracker.events":   {"max_len": 500, "max_age_seconds": 86400},
    "slide.events":     {"max_len": 200, "max_age_seconds": 300},
    "billing.events":   {"max_len": 100, "max_age_seconds": 300},
    "git.status":       {"max_len": 50,  "max_age_seconds": 300},
    "notifications":    {"max_len": 200, "max_age_seconds": 600},
    "extension.events": {"max_len": 100, "max_age_seconds": 300},
    "device.capabilities.refresh": {"max_len": 50, "max_age_seconds": 120},
    # CMI-035: phone.* topics — TabPhone 断线重连 resume 缓冲
    "phone.sms":          {"max_len": 200, "max_age_seconds": 300},
    "phone.media":        {"max_len": 100, "max_age_seconds": 300},
    "phone.call":         {"max_len": 100, "max_age_seconds": 300},
    "phone.notification": {"max_len": 200, "max_age_seconds": 300},
    "phone.agent":        {"max_len": 500, "max_age_seconds": 300},
    "phone.sync":         {"max_len": 100, "max_age_seconds": 120},
    "phone.mirror":       {"max_len": 50,  "max_age_seconds": 120},
    "phone.emulator":     {"max_len": 50,  "max_age_seconds": 120},
}

DEFAULT_BUFFER_CONFIG: Dict[str, int] = {
    "max_len": 200,
    "max_age_seconds": 300,
}

STREAM_KEY_PREFIX = "ws:evt:"
_META_KEY_PREFIX = "ws:meta:evt:"

# 单 envelope 的防御性硬上限。完整 LLM 请求在序列化前即被判定为 local-only；
# 未知业务事件不得被字段截断，超限时记录 replay gap 并保持实时广播。
BUFFER_EVENT_MAX_BYTES = 256 * 1024
BUFFER_DELTA_MAX_CHARS = 48 * 1024

# Ledger 同时计入每条 Stream entry 的保守元数据成本，避免大量极小事件绕过字节预算。
_STREAM_ENTRY_ACCOUNTING_BYTES = 512

_AGENT_TOPIC_SOFT_BYTES = 16 * 1024 * 1024
_AGENT_TOPIC_HARD_BYTES = 20 * 1024 * 1024
_DEFAULT_TOPIC_SOFT_BYTES = 4 * 1024 * 1024
_DEFAULT_TOPIC_HARD_BYTES = 5 * 1024 * 1024


class BufferRetentionClass(str, Enum):
    """Event Buffer 的恢复语义，而不是业务重要性枚举。"""

    MESSAGE_RECONSTRUCTABLE = "message_reconstructable"
    MESSAGE_COMMIT = "message_commit"
    LATEST_SNAPSHOT = "latest_snapshot"
    CRITICAL_REPLAY = "critical_replay"


@dataclass(frozen=True)
class BufferEventPlan:
    envelope: Dict[str, Any]
    retention: BufferRetentionClass
    message_id: str = ""
    latest_key: str = ""


class ReplayGapError(RuntimeError):
    """该 topic 存在未被权威终态修复的 replay 缺口。"""

    def __init__(self, topic: str):
        super().__init__(f"unresolved replay gap for topic {topic}")
        self.topic = topic


_MESSAGE_RECONSTRUCTABLE_TYPES = frozenset({
    "agent.stream.message_start",
    "agent.stream.message_delta",
    "agent.stream.message_stop",
    "agent.stream.content_block_start",
    "agent.stream.content_block_delta",
    "agent.stream.content_block_stop",
})


def _prepare_buffer_event(envelope: Dict[str, Any]) -> Optional[BufferEventPlan]:
    """把 wire envelope 映射到显式恢复语义；``None`` 表示只保留本地。"""
    event_type = envelope.get("type")
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        payload = {}

    if event_type == "agent.stream.llm_request":
        return None
    if event_type == "agent.stream.subagent_stream_event":
        child_event = payload.get("child_event")
        if isinstance(child_event, dict) and child_event.get("type") == "agent.stream.llm_request":
            return None

    message_id = payload.get("message_id")
    normalized_message_id = message_id if isinstance(message_id, str) else ""
    if event_type in _MESSAGE_RECONSTRUCTABLE_TYPES and normalized_message_id:
        return BufferEventPlan(
            envelope=envelope,
            retention=BufferRetentionClass.MESSAGE_RECONSTRUCTABLE,
            message_id=normalized_message_id,
        )
    if event_type == "agent.stream.message_committed" and normalized_message_id:
        return BufferEventPlan(
            envelope=envelope,
            retention=BufferRetentionClass.MESSAGE_COMMIT,
            message_id=normalized_message_id,
        )
    if event_type == "agent.stream.subagent_progress":
        run_id = payload.get("subagent_run_id") or payload.get("run_id")
        if isinstance(run_id, str) and run_id:
            return BufferEventPlan(
                envelope=envelope,
                retention=BufferRetentionClass.LATEST_SNAPSHOT,
                latest_key=f"subagent_progress:{run_id}",
            )
    return BufferEventPlan(
        envelope=envelope,
        retention=BufferRetentionClass.CRITICAL_REPLAY,
        message_id=normalized_message_id,
    )


def _oversize_delta_body(envelope: Dict[str, Any]) -> bool:
    if envelope.get("type") != "agent.stream.content_block_delta":
        return False
    payload = envelope.get("payload")
    delta = payload.get("delta") if isinstance(payload, dict) else None
    if not isinstance(delta, dict):
        return False
    for field in ("text", "thinking", "partial_json", "signature", "connector_text"):
        value = delta.get(field)
        if isinstance(value, str) and len(value) > BUFFER_DELTA_MAX_CHARS:
            return True
    return False


_APPEND_BOUNDED_EVENT_LUA = r"""
local stream_key = KEYS[1]
local ledger_key = KEYS[2]
local message_index_key = KEYS[3]
local latest_index_key = KEYS[4]
local gap_key = KEYS[5]
local gap_message_index_key = KEYS[6]

local envelope = ARGV[1]
local event_bytes = tonumber(ARGV[2])
local soft_budget = tonumber(ARGV[3])
local hard_budget = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local mode = ARGV[6]
local message_id = ARGV[7]
local latest_key = ARGV[8]
local gap_identity = ARGV[9]
local event_type = ARGV[10]
local observed_bytes = tonumber(ARGV[11])

local function record_gap(reason, boundary)
    redis.call('HSET', gap_key, gap_identity, cjson.encode({
        reason = reason,
        boundary = boundary,
        message_id = message_id,
        event_type = event_type,
        observed_bytes = observed_bytes
    }))
    redis.call('EXPIRE', gap_key, ttl)
    if message_id ~= '' then
        redis.call('SADD', gap_message_index_key, gap_identity)
        redis.call('EXPIRE', gap_message_index_key, ttl)
    end
end

local function clear_message_gaps()
    if message_id == '' then
        return
    end
    redis.call('HDEL', gap_key, message_id)
    local gap_identities = redis.call('SMEMBERS', gap_message_index_key)
    for index = 1, #gap_identities do
        redis.call('HDEL', gap_key, gap_identities[index])
    end
    redis.call('DEL', gap_message_index_key)
end

local current = redis.call('GET', ledger_key)
if current then
    current = tonumber(current)
elseif redis.call('EXISTS', stream_key) == 1 then
    current = tonumber(redis.call('MEMORY', 'USAGE', stream_key) or 0)
else
    current = 0
end

local reclaimed = 0
local indexed = {}
if mode == 'message_commit' and message_id ~= '' then
    indexed = redis.call('HGETALL', message_index_key)
elseif mode == 'latest_snapshot' and latest_key ~= '' then
    local previous = redis.call('HGET', latest_index_key, latest_key)
    if previous then
        local separator = string.find(previous, '|', 1, true)
        if separator then
            reclaimed = tonumber(string.sub(previous, separator + 1)) or 0
        end
    end
end

-- Commit 是权威恢复 checkpoint：必须先写 checkpoint，再删该 message 的六件套。
-- time trim 可能已删除部分 indexed ID，因此 commit 后用真实内存重建 ledger，
-- 避免对已删除 entry 二次减账。若一条旧流没有任何可替换 entry 且已超硬预算，
-- 原子撤回刚写的 commit 并保留原流，不制造“删了旧状态却没有 checkpoint”的窗口。
if mode == 'message_commit' and message_id ~= '' then
    local stream_id = redis.call(
        'XADD', stream_key, '*',
        'e', envelope,
        'b', tostring(event_bytes),
        'r', mode,
        'm', message_id
    )
    local deleted = 0
    for index = 1, #indexed, 2 do
        deleted = deleted + redis.call('XDEL', stream_key, indexed[index])
    end
    local actual = tonumber(redis.call('MEMORY', 'USAGE', stream_key) or 0)
    if actual > hard_budget and deleted == 0 then
        redis.call('XDEL', stream_key, stream_id)
        actual = tonumber(redis.call('MEMORY', 'USAGE', stream_key) or 0)
        redis.call('SET', ledger_key, tostring(actual), 'EX', ttl)
        local tail = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
        local boundary = '0-0'
        if #tail > 0 then boundary = tail[1][1] end
        record_gap('topic_byte_budget_exceeded', boundary)
        return {'gap', boundary}
    end
    redis.call('DEL', message_index_key)
    clear_message_gaps()
    if redis.call('HLEN', gap_key) == 0 then
        redis.call('DEL', gap_key)
    end
    redis.call('SET', ledger_key, tostring(actual), 'EX', ttl)
    redis.call('EXPIRE', stream_key, ttl)
    return {'ok', stream_id}
end

local projected = math.max(0, current - reclaimed) + event_bytes
local event_budget = hard_budget
if mode == 'message_reconstructable' or mode == 'latest_snapshot' then
    event_budget = soft_budget
end
if projected > event_budget then
    local tail = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
    local boundary = '0-0'
    if #tail > 0 then boundary = tail[1][1] end
    record_gap('topic_byte_budget_exceeded', boundary)
    return {'gap', boundary}
end

local stream_id = redis.call(
    'XADD', stream_key, '*',
    'e', envelope,
    'b', tostring(event_bytes),
    'r', mode,
    'm', message_id
)

if mode == 'message_reconstructable' and message_id ~= '' then
    redis.call('HSET', message_index_key, stream_id, tostring(event_bytes))
    redis.call('EXPIRE', message_index_key, ttl)
elseif mode == 'latest_snapshot' and latest_key ~= '' then
    local previous = redis.call('HGET', latest_index_key, latest_key)
    if previous then
        local separator = string.find(previous, '|', 1, true)
        if separator then redis.call('XDEL', stream_key, string.sub(previous, 1, separator - 1)) end
    end
    redis.call('HSET', latest_index_key, latest_key, stream_id .. '|' .. tostring(event_bytes))
    redis.call('HDEL', gap_key, latest_key)
    if redis.call('HLEN', gap_key) == 0 then
        redis.call('DEL', gap_key)
    end
    redis.call('EXPIRE', latest_index_key, ttl)
end

redis.call('SET', ledger_key, tostring(projected), 'EX', ttl)
redis.call('EXPIRE', stream_key, ttl)
return {'ok', stream_id}
"""

# Maximum events returned by a single replay request
MAX_REPLAY_LIMIT = 500

# Periodic health-check interval to detect stale Redis connections (PF-21)
_REDIS_HEALTH_CHECK_INTERVAL = 30  # seconds

# Threshold for logging heavy trim warnings (PF-5)
_HEAVY_TRIM_THRESHOLD = 50

# Key-level TTL for the Stream key itself .
# Content retention still follows per-topic max_age via XTRIM MINID;
# this only ensures abandoned keys disappear even if trim lags.
# 24h >> agent.stream max_age(1h)，不影响短窗 resume / Agent 最终落库结果。
_STREAM_KEY_TTL_SECONDS = 86400

# Default per-invocation stream budget for trim_expired. 50 was too small for
# prod (thousands of abandoned agent.stream keys) and left tails untrimmed.
_DEFAULT_TRIM_MAX_STREAMS = 500

# One Redis script captures all topic tails before Channels group membership is
# established. For an empty stream, the boundary is the greatest ID in the
# millisecond immediately before Redis TIME, so the first post-boundary XADD is
# strictly greater without replaying all retained history via ``0-0``.
_CAPTURE_SUBSCRIPTION_BOUNDARIES_LUA = r"""
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local empty_cursor = string.format('%.0f', now_ms - 1) .. '-18446744073709551615'
local boundaries = {}
for index, key in ipairs(KEYS) do
    local latest = redis.call('XREVRANGE', key, '+', '-', 'COUNT', 1)
    if #latest > 0 then
        boundaries[index] = latest[1][1]
    else
        boundaries[index] = empty_cursor
    end
end
return boundaries
"""


def _is_redis_connection_error(exc: Exception) -> bool:
    """Check if *exc* indicates a lost/broken Redis connection."""
    try:
        from redis.exceptions import ConnectionError as RedisConnError, TimeoutError as RedisTimeout
        return isinstance(exc, (RedisConnError, RedisTimeout))
    except ImportError:
        return "connection" in str(exc).lower()


class EventBufferService:
    """Redis Stream-based event buffer for WS resume/replay."""

    def __init__(self):
        self._redis = None
        self._last_health_check: float = 0.0

    def _reset_redis(self) -> None:
        """Discard cached client so the next access triggers reconnection."""
        self._redis = None
        self._last_health_check = 0.0

    @property
    def redis_client(self):
        """Lazy-init Redis client with periodic health-check.

        If the cached connection becomes stale (network blip, server restart),
        the periodic ``PING`` detects it and forces reconnection instead of
        permanently caching a dead socket (PF-21 / PF-5).
        """
        now = time.time()

        if self._redis is not None and (now - self._last_health_check) > _REDIS_HEALTH_CHECK_INTERVAL:
            try:
                self._redis.ping()
                self._last_health_check = now
            except Exception:
                logger.warning("[EventBuffer] stale Redis connection detected, reconnecting")
                self._redis = None

        if self._redis is None:
            try:
                from django_redis import get_redis_connection
                self._redis = get_redis_connection("default")
                self._last_health_check = now
            except Exception as exc:
                logger.warning("[EventBuffer] Redis connection failed: %s", exc)
                return None
        return self._redis

    # ------------------------------------------------------------------
    # Write path
    # ------------------------------------------------------------------

    def append_event(self, topic: str, envelope: Dict[str, Any]) -> Optional[str]:
        """
        Append an event to the topic's Redis Stream.

        Returns the Redis Stream auto-ID (e.g. ``1702000000000-0``) on success,
        or ``None`` on failure. Failures are logged but never propagated.
        """
        plan = _prepare_buffer_event(envelope)
        if plan is None:
            logger.debug("[EventBuffer] local-only event skipped: type=%s", envelope.get("type"))
            return None

        client = self.redis_client
        if client is None:
            return None

        stream_key = f"{STREAM_KEY_PREFIX}{topic}"
        serialized = json.dumps(plan.envelope, ensure_ascii=False, separators=(",", ":"))
        serialized_bytes = len(serialized.encode("utf-8"))
        if _oversize_delta_body(plan.envelope):
            self._record_gap(
                client,
                topic,
                plan,
                reason="delta_body_too_large",
                boundary="0-0",
                observed_bytes=serialized_bytes,
            )
            return None
        if serialized_bytes > BUFFER_EVENT_MAX_BYTES:
            self._record_gap(
                client,
                topic,
                plan,
                reason="event_too_large",
                boundary="0-0",
                observed_bytes=serialized_bytes,
            )
            logger.warning(
                "[EventBuffer] event rejected by size cap: topic=%s type=%s bytes=%d",
                topic, envelope.get("type"), serialized_bytes,
            )
            return None

        accounted_bytes = serialized_bytes + _STREAM_ENTRY_ACCOUNTING_BYTES
        ledger_key = self._ledger_key(topic)
        message_index_key = self._message_index_key(topic, plan.message_id)
        latest_index_key = self._latest_index_key(topic)
        gap_key = self._gap_key(topic)

        try:
            result = client.eval(
                _APPEND_BOUNDED_EVENT_LUA,
                6,
                stream_key,
                ledger_key,
                message_index_key,
                latest_index_key,
                gap_key,
                self._gap_message_index_key(topic, plan.message_id),
                serialized,
                accounted_bytes,
                self._soft_byte_budget(topic),
                self._hard_byte_budget(topic),
                _STREAM_KEY_TTL_SECONDS,
                plan.retention.value,
                plan.message_id,
                plan.latest_key,
                self._gap_identity(plan),
                str(plan.envelope.get("type") or ""),
                serialized_bytes,
            )
            status, value = self._parse_append_result(result)
            if status == "gap":
                logger.warning(
                    "[EventBuffer] event rejected by topic byte budget: topic=%s type=%s",
                    topic, envelope.get("type"),
                )
                return None
            if status != "ok" or not value:
                logger.warning("[EventBuffer] unexpected append result for %s: %r", stream_key, result)
                return None
            return value
        except Exception as exc:
            if _is_redis_connection_error(exc):
                self._reset_redis()
            logger.warning("[EventBuffer] bounded append failed for %s: %s", stream_key, exc)
            return None

    # ------------------------------------------------------------------
    # Read path (resume/replay)
    # ------------------------------------------------------------------

    def capture_subscription_boundaries(self, topics: List[str]) -> Dict[str, str]:
        """Atomically capture the current Redis Stream tail for each topic.

        The caller must invoke this before joining realtime delivery groups.
        Events racing after this script are therefore covered by replay, live
        delivery, or both. An unavailable boundary fails closed as ``{}``.
        """
        if not topics:
            return {}
        client = self.redis_client
        if client is None:
            return {}

        keys = [f"{STREAM_KEY_PREFIX}{topic}" for topic in topics]
        try:
            raw_boundaries = client.eval(
                _CAPTURE_SUBSCRIPTION_BOUNDARIES_LUA,
                len(keys),
                *keys,
            )
            if not isinstance(raw_boundaries, (list, tuple)) or len(raw_boundaries) != len(topics):
                logger.warning(
                    "[EventBuffer] subscription boundary result mismatch: topics=%d results=%s",
                    len(topics),
                    len(raw_boundaries) if isinstance(raw_boundaries, (list, tuple)) else "invalid",
                )
                return {}
            boundaries: Dict[str, str] = {}
            for topic, boundary in zip(topics, raw_boundaries):
                if isinstance(boundary, bytes):
                    boundary = boundary.decode("utf-8")
                if not isinstance(boundary, str) or not boundary:
                    return {}
                boundaries[topic] = boundary
            return boundaries
        except Exception as exc:
            if _is_redis_connection_error(exc):
                self._reset_redis()
            logger.warning("[EventBuffer] subscription boundary capture failed: %s", exc)
            return {}

    def read_after(
        self,
        topic: str,
        last_event_id: str,
        limit: int = 200,
    ) -> List[Tuple[str, Dict[str, Any]]]:
        """
        Read events from the stream after *last_event_id* (exclusive).

        Returns a list of ``(stream_id, envelope_dict)`` tuples.
        """
        client = self.redis_client
        if client is None:
            return []

        stream_key = f"{STREAM_KEY_PREFIX}{topic}"
        effective_limit = min(limit, MAX_REPLAY_LIMIT)

        try:
            self._assert_no_replay_gap(client, topic)
            # Exclusive range: "(" prefix means "strictly after this ID"
            entries = client.xrange(
                stream_key,
                min=f"({last_event_id}",
                max="+",
                count=effective_limit,
            )
            result: List[Tuple[str, Dict[str, Any]]] = []
            for entry_id, fields in entries:
                # Normalize bytes → str
                if isinstance(entry_id, bytes):
                    entry_id = entry_id.decode("utf-8")
                raw = fields.get("e") or fields.get(b"e")
                if raw is None:
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                try:
                    envelope = json.loads(raw)
                    result.append((entry_id, envelope))
                except (json.JSONDecodeError, TypeError):
                    logger.warning("[EventBuffer] bad envelope in %s/%s", stream_key, entry_id)
            return result
        except ReplayGapError:
            raise
        except Exception as exc:
            if _is_redis_connection_error(exc):
                self._reset_redis()
            logger.warning("[EventBuffer] XRANGE failed for %s: %s", stream_key, exc)
            return []

    def read_after_many(
        self,
        topic_cursors: List[Tuple[str, str]],
        limit: int = 200,
        *,
        raise_on_error: bool = False,
    ) -> Tuple[Dict[str, List[Tuple[str, Dict[str, Any]]]], bool]:
        """Batch XRANGE for multiple topics via Redis Pipeline (G-036).

        *topic_cursors* is a list of ``(topic, last_event_id)`` pairs.

        Returns ``(results, any_truncated)`` where *results* maps each topic
        to its ``(stream_id, envelope)`` list, and *any_truncated* is True
        when at least one topic returned exactly *limit* events (G-059).
        """
        client = self.redis_client
        if client is None:
            if raise_on_error:
                raise RuntimeError("event buffer unavailable")
            return {}, False

        if not topic_cursors:
            return {}, False

        effective_limit = min(limit, MAX_REPLAY_LIMIT)

        try:
            for topic, _last_event_id in topic_cursors:
                self._assert_no_replay_gap(client, topic)
            pipe = client.pipeline(transaction=False)
            ordered_topics: List[str] = []
            for topic, last_event_id in topic_cursors:
                stream_key = f"{STREAM_KEY_PREFIX}{topic}"
                pipe.xrange(stream_key, min=f"({last_event_id}", max="+", count=effective_limit)
                ordered_topics.append(topic)
            raw_results = pipe.execute()
        except ReplayGapError:
            raise
        except Exception as exc:
            if _is_redis_connection_error(exc):
                self._reset_redis()
            logger.warning("[EventBuffer] pipeline XRANGE failed: %s", exc)
            if raise_on_error:
                raise
            return {}, False

        output: Dict[str, List[Tuple[str, Dict[str, Any]]]] = {}
        any_truncated = False

        for topic, entries in zip(ordered_topics, raw_results):
            if not entries:
                continue
            if len(entries) >= effective_limit:
                any_truncated = True

            parsed: List[Tuple[str, Dict[str, Any]]] = []
            stream_key = f"{STREAM_KEY_PREFIX}{topic}"
            for entry_id, fields in entries:
                if isinstance(entry_id, bytes):
                    entry_id = entry_id.decode("utf-8")
                raw = fields.get("e") or fields.get(b"e")
                if raw is None:
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                try:
                    envelope = json.loads(raw)
                    parsed.append((entry_id, envelope))
                except (json.JSONDecodeError, TypeError):
                    logger.warning("[EventBuffer] bad envelope in %s/%s", stream_key, entry_id)
            if parsed:
                output[topic] = parsed

        return output, any_truncated

    # ------------------------------------------------------------------
    # Maintenance
    # ------------------------------------------------------------------

    def trim_expired(self, max_streams: int = _DEFAULT_TRIM_MAX_STREAMS) -> int:
        """Trim ``ws:evt:*`` streams by MINID based on each topic's max_age.

        Returns total number of trimmed entries (approximate). Empty streams are
        unlinked; remaining keys get a key-level TTL so abandoned topics cannot
        pin Redis memory .

        G-058: processes at most *max_streams* streams per invocation to avoid
        exceeding the Celery ``time_limit`` when the number of streams is large.

        NP-02: collect ALL matching keys first, then shuffle before truncating
        to *max_streams*.  Without shuffling, SCAN always starts from the same
        slot range, so the same leading streams get trimmed every cycle while
        tail streams accumulate indefinitely.
        """
        import random

        client = self.redis_client
        if client is None:
            return 0

        # --- Phase 1: collect all matching stream keys (full SCAN) ---
        all_keys: List[str] = []
        try:
            cursor = "0"
            while True:
                cursor, keys = client.scan(
                    cursor=cursor,
                    match=f"{STREAM_KEY_PREFIX}*",
                    count=100,
                )
                for key in keys:
                    if isinstance(key, bytes):
                        key = key.decode("utf-8")
                    all_keys.append(key)
                # G-064: unified cursor comparison — handles bytes/str/int
                if int(cursor) == 0:
                    break
        except Exception as exc:
            if _is_redis_connection_error(exc):
                self._reset_redis()
            logger.warning("[EventBuffer] trim_expired scan failed: %s", exc)
            return 0

        if not all_keys:
            return 0

        # --- Phase 2: shuffle → fair coverage across Celery invocations ---
        random.shuffle(all_keys)
        batch = all_keys[:max_streams]

        if len(all_keys) > max_streams:
            logger.info(
                "[EventBuffer] trim batch: processing %d of %d streams (shuffled)",
                max_streams, len(all_keys),
            )

        # --- Phase 3: XTRIM + expire / unlink empty ---
        trimmed_total = 0
        unlinked_total = 0
        for key in batch:
            topic = key[len(STREAM_KEY_PREFIX):]
            config = self._resolve_config(topic)
            max_age = config["max_age_seconds"]
            min_id_ms = int((time.time() - max_age) * 1000)
            try:
                trimmed = client.xtrim(key, minid=min_id_ms, approximate=True)
                trimmed_total += trimmed or 0
                if trimmed and trimmed >= _HEAVY_TRIM_THRESHOLD:
                    logger.warning(
                        "[EventBuffer] heavy trim on %s: %d events dropped (max_age=%ds)",
                        key, trimmed, max_age,
                    )
                try:
                    length = client.xlen(key)
                except Exception:
                    length = None
                if length == 0:
                    client.unlink(key)
                    client.delete(
                        self._ledger_key(topic),
                        self._latest_index_key(topic),
                        self._gap_key(topic),
                    )
                    unlinked_total += 1
                else:
                    self._refresh_stream_ttl(client, key)
                    if trimmed:
                        client.delete(self._latest_index_key(topic))
                    # XTRIM 发生在 Lua 之外；用真实 Stream 占用重建保守 ledger，
                    # 避免已过期 entry 被删后账本仍永久卡在硬上限。
                    try:
                        memory_bytes = client.memory_usage(key, samples=0)
                        if isinstance(memory_bytes, int) and memory_bytes >= 0:
                            client.set(
                                self._ledger_key(topic),
                                memory_bytes,
                                ex=_STREAM_KEY_TTL_SECONDS,
                            )
                    except Exception as exc:
                        logger.debug("[EventBuffer] ledger reconcile failed for %s: %s", key, exc)
            except Exception as exc:
                if _is_redis_connection_error(exc):
                    self._reset_redis()
                    client = self.redis_client
                    if client is None:
                        return trimmed_total
                logger.warning("[EventBuffer] XTRIM failed for %s: %s", key, exc)

        if unlinked_total:
            logger.info(
                "[EventBuffer] unlinked %d empty ws:evt streams after trim",
                unlinked_total,
            )
        return trimmed_total

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _refresh_stream_ttl(client, stream_key: str) -> None:
        """Set/refresh key-level TTL (24h). Failures are non-fatal."""
        try:
            client.expire(stream_key, _STREAM_KEY_TTL_SECONDS)
        except Exception as exc:
            logger.debug("[EventBuffer] EXPIRE failed for %s: %s", stream_key, exc)

    def _resolve_config(self, topic: str) -> Dict[str, int]:
        """Resolve retention config by longest prefix match (consistent with protocol.resolve_required_capability)."""
        best_prefix = ""
        best_config = None
        for prefix, config in BUFFER_CONFIG.items():
            if (topic == prefix or topic.startswith(f"{prefix}.")) and len(prefix) > len(best_prefix):
                best_prefix = prefix
                best_config = config
        return best_config if best_config is not None else DEFAULT_BUFFER_CONFIG

    @staticmethod
    def _parse_append_result(result: Any) -> Tuple[str, str]:
        if not isinstance(result, (list, tuple)) or len(result) < 2:
            return "", ""
        normalized: list[str] = []
        for value in result[:2]:
            if isinstance(value, bytes):
                value = value.decode("utf-8")
            normalized.append(str(value))
        return normalized[0], normalized[1]

    @staticmethod
    def _redis_slot_anchor(topic: str) -> str:
        """Return the exact hash input Redis uses for the existing Stream key.

        Metadata keys wrap this value in ``{...}``, so all five keys passed to
        the atomic Lua append share a Redis Cluster slot without renaming the
        backwards-compatible ``ws:evt:<topic>`` Stream.
        """
        stream_key = f"{STREAM_KEY_PREFIX}{topic}"
        opening = stream_key.find("{")
        if opening >= 0:
            closing = stream_key.find("}", opening + 1)
            if closing > opening + 1:
                return stream_key[opening + 1:closing]
        return stream_key

    @classmethod
    def _ledger_key(cls, topic: str) -> str:
        return f"{_META_KEY_PREFIX}{{{cls._redis_slot_anchor(topic)}}}:bytes:{topic}"

    @classmethod
    def _gap_key(cls, topic: str) -> str:
        return f"{_META_KEY_PREFIX}{{{cls._redis_slot_anchor(topic)}}}:gap:{topic}"

    @classmethod
    def _gap_message_index_key(cls, topic: str, message_id: str) -> str:
        suffix = message_id or "__none__"
        return (
            f"{_META_KEY_PREFIX}{{{cls._redis_slot_anchor(topic)}}}:"
            f"gap-message:{topic}:{suffix}"
        )

    @classmethod
    def _latest_index_key(cls, topic: str) -> str:
        return f"{_META_KEY_PREFIX}{{{cls._redis_slot_anchor(topic)}}}:latest:{topic}"

    @classmethod
    def _message_index_key(cls, topic: str, message_id: str) -> str:
        suffix = message_id or "__none__"
        return (
            f"{_META_KEY_PREFIX}{{{cls._redis_slot_anchor(topic)}}}:"
            f"message:{topic}:{suffix}"
        )

    @staticmethod
    def _gap_identity(plan: BufferEventPlan) -> str:
        return plan.message_id or plan.latest_key or "__topic__"

    @staticmethod
    def _hard_byte_budget(topic: str) -> int:
        if topic == "agent.stream" or topic.startswith("agent.stream."):
            return _AGENT_TOPIC_HARD_BYTES
        if topic == "agent.action" or topic.startswith("agent.action."):
            return _AGENT_TOPIC_HARD_BYTES
        if topic == "agent.external" or topic.startswith("agent.external."):
            return _AGENT_TOPIC_HARD_BYTES
        return _DEFAULT_TOPIC_HARD_BYTES

    @staticmethod
    def _soft_byte_budget(topic: str) -> int:
        if topic == "agent.stream" or topic.startswith("agent.stream."):
            return _AGENT_TOPIC_SOFT_BYTES
        if topic == "agent.action" or topic.startswith("agent.action."):
            return _AGENT_TOPIC_SOFT_BYTES
        if topic == "agent.external" or topic.startswith("agent.external."):
            return _AGENT_TOPIC_SOFT_BYTES
        return _DEFAULT_TOPIC_SOFT_BYTES

    def _record_gap(
        self,
        client,
        topic: str,
        plan: BufferEventPlan,
        *,
        reason: str,
        boundary: str,
        observed_bytes: int,
    ) -> None:
        gap_key = self._gap_key(topic)
        identity = self._gap_identity(plan)
        detail = json.dumps(
            {
                "reason": reason,
                "boundary": boundary,
                "message_id": plan.message_id,
                "event_type": plan.envelope.get("type"),
                "observed_bytes": observed_bytes,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        try:
            client.hset(gap_key, key=identity, value=detail)
            client.expire(gap_key, _STREAM_KEY_TTL_SECONDS)
            if plan.message_id:
                gap_message_index_key = self._gap_message_index_key(topic, plan.message_id)
                client.sadd(gap_message_index_key, identity)
                client.expire(gap_message_index_key, _STREAM_KEY_TTL_SECONDS)
        except Exception as exc:
            logger.error(
                "[EventBuffer] failed to persist replay gap: topic=%s reason=%s error=%s",
                topic, reason, exc,
            )

    def _assert_no_replay_gap(self, client, topic: str) -> None:
        gap_count = client.hlen(self._gap_key(topic))
        if isinstance(gap_count, (int, float)) and gap_count > 0:
            raise ReplayGapError(topic)


# ---------------------------------------------------------------------------
# Module-level lazy singleton (G-063: thread-safe double-checked locking)
# ---------------------------------------------------------------------------

_event_buffer_instance: Optional[EventBufferService] = None
_event_buffer_lock = threading.Lock()


def get_event_buffer() -> EventBufferService:
    """Get or create the singleton EventBufferService (thread-safe)."""
    global _event_buffer_instance
    if _event_buffer_instance is None:
        with _event_buffer_lock:
            if _event_buffer_instance is None:
                _event_buffer_instance = EventBufferService()
    return _event_buffer_instance


__all__ = [
    "BUFFER_EVENT_MAX_BYTES",
    "BUFFER_DELTA_MAX_CHARS",
    "BufferEventPlan",
    "BufferRetentionClass",
    "EventBufferService",
    "ReplayGapError",
    "get_event_buffer",
]

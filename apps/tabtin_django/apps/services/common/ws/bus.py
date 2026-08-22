"""
WS event bus helpers.

Publishes events to both:
  1. Redis Stream (persistent buffer for resume/replay)
  2. Channel-layer group (real-time delivery to connected clients)
"""

import logging
import asyncio
import random
import sys
import threading
import time
from contextlib import nullcontext
from typing import Any, Dict, Optional

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from .circuit_breaker import CircuitBreaker
from .metrics import (
    record_message_sent,
    record_publish_skipped_breaker_open,
)
from .protocol import CHANNEL_SAFE_PATTERN, is_stream_event_id

logger = logging.getLogger(__name__)
_group_safe_pattern = CHANNEL_SAFE_PATTERN

_MAX_RETRIES = 2
_RETRY_BACKOFF_BASE = 0.015  # 15ms base → ~15ms, ~30ms with jitter
_RETRY_BACKOFF_CAP = 0.1  # G-060: cap backoff to limit thread pool impact

RECOVERY_SIGNAL_GROUP = "ws.recovery.signal"
RECOVERY_REDIS_CHANNEL = "tabtin:channel_layer:recovered"


def _publish_recovery_signal_sync() -> None:
    """Best-effort Redis Pub/Sub signal for cross-process observability."""
    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")
        redis_client.publish(RECOVERY_REDIS_CHANNEL, "1")
        logger.info("[WS Bus] Channel layer recovered, published recovery signal")
    except Exception as exc:
        logger.warning("[WS Bus] Failed to publish recovery signal: %s", exc)


def _build_recovery_resume_hint() -> Dict[str, Any]:
    from .protocol import build_envelope, new_event_id

    return build_envelope(
        "connection.resume_hint",
        new_event_id(),
        {"reason": "channel_layer_recovered"},
    )


def _on_channel_layer_recovery_sync() -> None:
    """Sync compatibility path for non-ASGI callers."""
    _publish_recovery_signal_sync()

    try:
        channel_layer = get_channel_layer()
        if channel_layer:
            group_name = _normalize_group_name(RECOVERY_SIGNAL_GROUP)
            async_to_sync(channel_layer.group_send)(
                group_name,
                {"type": "broadcast_message", "message": _build_recovery_resume_hint()},
            )
            logger.info("[WS Bus] Broadcast resume_hint to recovery signal group")
    except Exception as exc:
        logger.warning("[WS Bus] Failed to broadcast resume_hint: %s", exc)


async def _on_channel_layer_recovery_async() -> None:
    """Async-safe recovery notification for ASGI runtime."""
    from .async_io import run_sync_io

    await run_sync_io(_publish_recovery_signal_sync)

    try:
        channel_layer = get_channel_layer()
        if channel_layer:
            group_name = _normalize_group_name(RECOVERY_SIGNAL_GROUP)
            await channel_layer.group_send(
                group_name,
                {"type": "broadcast_message", "message": _build_recovery_resume_hint()},
            )
            logger.info("[WS Bus] Broadcast async resume_hint to recovery signal group")
    except Exception as exc:
        logger.warning("[WS Bus] Failed to broadcast async resume_hint: %s", exc)


def _log_async_recovery_failure(task: asyncio.Task) -> None:
    try:
        task.result()
    except Exception:
        logger.warning("[WS Bus] async recovery callback failed", exc_info=True)


def _on_channel_layer_recovery() -> None:
    """Circuit breaker callback for channel-layer recovery.

    Circuit breaker callbacks may run from async publish inside Daphne's event
    loop. Do not perform blocking I/O directly here: schedule the async-safe
    path when a loop is running, and keep the sync implementation only for
    non-ASGI callers.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _on_channel_layer_recovery_sync()
        return

    task = loop.create_task(_on_channel_layer_recovery_async())
    task.add_done_callback(_log_async_recovery_failure)


_channel_layer_breaker = CircuitBreaker(
    failure_threshold=5,
    recovery_timeout=30.0,
    name="channel_layer",
    on_recovery=_on_channel_layer_recovery,
)


class WsPublishError(Exception):
    """Raised by publish_ws_event_reliable when all retries are exhausted."""

    def __init__(self, topic: str, message_type: str, cause: Exception):
        self.topic = topic
        self.message_type = message_type
        self.cause = cause
        super().__init__(f"WS publish failed after retries: topic={topic} type={message_type} cause={cause}")


def _normalize_group_name(name: str) -> str:
    return _group_safe_pattern.sub(".", name)


def _get_event_buffer():
    """Lazy import to avoid circular dependency at module load."""
    from .event_buffer import get_event_buffer
    return get_event_buffer()


def _get_sensitive_device_actions():
    from apps.services.common.agent_protocol.constants import SENSITIVE_DEVICE_ACTIONS
    return SENSITIVE_DEVICE_ACTIONS


def _get_credential_sensitive_tools():
    from apps.services.common.agent_protocol.constants import CREDENTIAL_SENSITIVE_TOOLS
    return CREDENTIAL_SENSITIVE_TOOLS


# G-062: expanded deny-list for sensitive parameter names.
# Covers common credential-carrying keys across existing and future tools.
_SENSITIVE_PARAM_KEYS = frozenset({
    "text", "password", "secret", "credential_data",
    "token", "api_key", "auth_data", "access_token", "refresh_token",
    "private_key", "secret_key", "passphrase", "auth_token",
    "client_secret", "api_secret", "bearer_token",
})

_REDACTED = "[REDACTED]"


def _sanitize_envelope_for_buffer(envelope: Dict[str, Any]) -> Dict[str, Any]:
    """Strip sensitive data from envelopes before buffering to Redis Stream.

    Two sanitization layers:
    1. Device action envelopes: strip deny-listed param keys.
    2. agent.stream.tool envelopes: redact ``input``/``output`` for
       credential-sensitive tools (e.g. ``credential_retrieve``).
    """
    payload = envelope.get("payload") or envelope.get("data")
    if not isinstance(payload, dict):
        return envelope

    # Layer 1: device action params
    action = payload.get("action", "")
    if action in _get_sensitive_device_actions():
        safe = {**envelope}
        safe_payload = {**payload}
        safe_params = {**safe_payload.get("params", {})}
        for key in _SENSITIVE_PARAM_KEYS:
            safe_params.pop(key, None)
        safe_payload["params"] = safe_params
        safe[("payload" if "payload" in envelope else "data")] = safe_payload
        return safe

    # Layer 2: agent.stream.tool with credential-sensitive tool names
    env_type = envelope.get("type", "")
    tool_name = payload.get("tool_name", "")
    if "stream.tool" in env_type and tool_name in _get_credential_sensitive_tools():
        safe = {**envelope}
        safe_payload = {**payload}
        if "input" in safe_payload:
            safe_payload["input"] = _REDACTED
        if "output" in safe_payload:
            safe_payload["output"] = _REDACTED
        safe[("payload" if "payload" in envelope else "data")] = safe_payload
        return safe

    return envelope


def _append_to_buffer(topic: str, envelope: Dict[str, Any]) -> Optional[str]:
    """Append to Redis Stream buffer (fire-and-forget), return the stream ID.

    Device action envelopes with sensitive params (e.g. plaintext passwords)
    are sanitized before being persisted to Redis.

    G-026: idempotent — if envelope already carries a *stream* ``event_id``
    (a Redis Stream ID like ``1702000000000-0``, set by a previous successful
    buffer write), skip the write to avoid duplicates on caller retry.
    UUID-style ``evt_*`` IDs from ``new_event_id()`` are NOT stream IDs and
    must not suppress the initial write.

    G-027: returns the event_id instead of mutating *envelope* in-place —
    callers inject ``event_id`` explicitly to preserve function purity.
    """
    existing = envelope.get("event_id")
    if existing and is_stream_event_id(existing):
        return existing
    try:
        buffer = _get_event_buffer()
        safe_envelope = _sanitize_envelope_for_buffer(envelope)
        return buffer.append_event(topic, safe_envelope)
    except Exception as exc:
        logger.debug("[WS Bus] event buffer append skipped: %s", exc)
        return None


def _broadcast_layer_payload(
    envelope: Dict[str, Any],
    *,
    exclude_channel: Optional[str] = None,
) -> Dict[str, Any]:
    """Build channel-layer ``broadcast_message`` event.

    ``exclude_channel`` lives on the layer event (sibling of ``message``), not
    inside the client envelope — consumers skip self-echo without leaking the
    field to the wire payload.
    """
    payload: Dict[str, Any] = {"type": "broadcast_message", "message": envelope}
    if exclude_channel:
        payload["exclude_channel"] = exclude_channel
    return payload


def _group_send_with_retry(
    group_name: str,
    payload: Dict[str, Any],
    max_retries: int = _MAX_RETRIES,
) -> bool:
    """Send to channel-layer group with exponential backoff retry.

    返回值（L_OBS_1 修订）：
      - ``True`` —— group_send 实际已发起（首次或 retry 后成功）
      - ``False`` —— 断路器 OPEN，跳过实时推送（buffer/inbox 仍可走 resume 兜底）
      - 抛 ``Exception`` —— retry 全部耗尽（断路器 record_failure）

    历史问题：旧版断路器 OPEN 时静默 ``return None``，上层 try/except 拦不
    到，会调 ``record_message_sent`` 误报"成功"——监控只看 messages_sent 时
    完全发现不了实时链路已断。现在通过返回值让调用方决策（不计 sent metric
    + 计 skip metric + log warning）。
    """
    if not _channel_layer_breaker.allow_request():
        logger.warning(
            "[WS Bus] Channel Layer 断路器开启，跳过实时推送: group=%s", group_name,
        )
        return False

    channel_layer = get_channel_layer()
    if channel_layer is None:
        raise RuntimeError("channel layer not configured")

    last_exc: Exception = RuntimeError("no attempt made")
    for attempt in range(1 + max_retries):
        try:
            async_to_sync(channel_layer.group_send)(group_name, payload)
            _channel_layer_breaker.record_success()
            return True
        except Exception as exc:
            last_exc = exc
            if attempt < max_retries:
                backoff = min(_RETRY_BACKOFF_BASE * (2 ** attempt), _RETRY_BACKOFF_CAP)
                jitter = random.uniform(0, backoff * 0.5)
                sleep_time = backoff + jitter
                logger.warning(
                    "[WS Bus] publish attempt %d/%d failed (backoff=%.3fs): %s",
                    attempt + 1, 1 + max_retries, sleep_time, exc,
                )
                time.sleep(sleep_time)
    _channel_layer_breaker.record_failure()
    raise last_exc


async def _group_send_with_retry_async(
    group_name: str,
    payload: Dict[str, Any],
    max_retries: int = _MAX_RETRIES,
) -> bool:
    """Async channel-layer publish path for ASGI handlers.

    Keeps retry sleeps and ``group_send`` on the event loop instead of bouncing
    through ``async_to_sync`` and occupying the shared sync thread pool.
    """
    if not _channel_layer_breaker.allow_request():
        logger.warning(
            "[WS Bus] Channel Layer 断路器开启，跳过实时推送: group=%s", group_name,
        )
        return False

    channel_layer = get_channel_layer()
    if channel_layer is None:
        raise RuntimeError("channel layer not configured")

    last_exc: Exception = RuntimeError("no attempt made")
    for attempt in range(1 + max_retries):
        try:
            await channel_layer.group_send(group_name, payload)
            _channel_layer_breaker.record_success()
            return True
        except Exception as exc:
            last_exc = exc
            if attempt < max_retries:
                backoff = min(_RETRY_BACKOFF_BASE * (2 ** attempt), _RETRY_BACKOFF_CAP)
                jitter = random.uniform(0, backoff * 0.5)
                sleep_time = backoff + jitter
                logger.warning(
                    "[WS Bus] async publish attempt %d/%d failed (backoff=%.3fs): %s",
                    attempt + 1, 1 + max_retries, sleep_time, exc,
                )
                await asyncio.sleep(sleep_time)
    _channel_layer_breaker.record_failure()
    raise last_exc


def publish_ws_event(
    topic: str,
    envelope: Dict[str, Any],
    *,
    exclude_channel: Optional[str] = None,
) -> bool:
    """
    Publish a WS event to the given topic.

    Steps:
      1. Append to Redis Stream (fire-and-forget, never blocks).
      2. Broadcast via channel-layer ``group_send`` with retry.

    ``exclude_channel``：可选，Channels ``channel_name``。匹配的连接在
    ``broadcast_message`` 投递时跳过（relay 同源回环抑制）。不影响 buffer /
    resume；同账号其它连接仍会收到。

    返回值（L_OBS_1 修订）：
      - ``True`` —— group_send 实际已发起（含 retry 后成功）；buffer 未写不
        影响返回值（buffer 本身就是 fire-and-forget）
      - ``False`` —— 断路器 OPEN（跳过实时分发）或 retry 全部耗尽。两种 False
        语义不同（前者无异常 + log warning + skip metric；后者捕获异常 + log
        warning），但对调用方都是"实时未发起，依赖 buffer + resume 兜底"
    """
    envelope = {**envelope}

    event_id = _append_to_buffer(topic, envelope)
    if event_id:
        envelope["event_id"] = event_id

    envelope["_topic"] = topic
    msg_type = envelope.get("type", "unknown")

    group_name = _normalize_group_name(f"topic.{topic}")
    try:
        delivered = _group_send_with_retry(
            group_name,
            _broadcast_layer_payload(envelope, exclude_channel=exclude_channel),
        )
        if delivered:
            record_message_sent(msg_type)
            logger.debug("[WS Bus] published to group=%s, type=%s", group_name, msg_type)
            return True
        record_publish_skipped_breaker_open(msg_type)
        return False
    except Exception as exc:
        logger.warning(
            "[WS Bus] publish failed after %d retries: topic=%s type=%s error=%s",
            _MAX_RETRIES, topic, msg_type, exc,
        )
        return False


async def publish_ws_event_async(
    topic: str,
    envelope: Dict[str, Any],
    *,
    exclude_channel: Optional[str] = None,
) -> bool:
    """Async variant of :func:`publish_ws_event` for WS handlers."""
    envelope = {**envelope}

    from .async_io import run_sync_io

    event_id = await run_sync_io(_append_to_buffer, topic, envelope)
    if event_id:
        envelope["event_id"] = event_id

    envelope["_topic"] = topic
    msg_type = envelope.get("type", "unknown")

    group_name = _normalize_group_name(f"topic.{topic}")
    try:
        delivered = await _group_send_with_retry_async(
            group_name,
            _broadcast_layer_payload(envelope, exclude_channel=exclude_channel),
        )
        if delivered:
            record_message_sent(msg_type)
            logger.debug("[WS Bus] published async to group=%s, type=%s", group_name, msg_type)
            return True
        record_publish_skipped_breaker_open(msg_type)
        return False
    except Exception as exc:
        logger.warning(
            "[WS Bus] async publish failed after %d retries: topic=%s type=%s error=%s",
            _MAX_RETRIES, topic, msg_type, exc,
        )
        return False


def publish_ws_event_reliable(
    topic: str,
    envelope: Dict[str, Any],
    *,
    exclude_channel: Optional[str] = None,
) -> None:
    """Like ``publish_ws_event`` but raises ``WsPublishError`` on failure.

    Use for critical paths where silent failure is unacceptable
    (e.g. agent runtime prompt forwarding).

    L_OBS_1：断路器 OPEN 时**不抛**——buffer 已写（agent runtime 用户重连
    可 resume），符合 "reliable" 的最终一致语义；抛异常会让调用方误以为
    buffer 也未写而触发上层重试，反而可能重复写 buffer。仅 retry 耗尽
    （channel layer 真异常）才抛 WsPublishError。skip 行为通过 metric +
    warning 日志暴露，不通过异常通道。
    """
    envelope = {**envelope}

    event_id = _append_to_buffer(topic, envelope)
    if event_id:
        envelope["event_id"] = event_id

    envelope["_topic"] = topic
    msg_type = envelope.get("type", "unknown")

    group_name = _normalize_group_name(f"topic.{topic}")
    try:
        delivered = _group_send_with_retry(
            group_name,
            _broadcast_layer_payload(envelope, exclude_channel=exclude_channel),
        )
        if delivered:
            record_message_sent(msg_type)
            logger.debug("[WS Bus] published (reliable) to group=%s, type=%s", group_name, msg_type)
        else:
            record_publish_skipped_breaker_open(msg_type)
    except Exception as exc:
        logger.error(
            "[WS Bus] CRITICAL publish failed: topic=%s type=%s error=%s",
            topic, msg_type, exc,
        )
        raise WsPublishError(topic, msg_type, exc) from exc


async def publish_ws_event_reliable_async(
    topic: str,
    envelope: Dict[str, Any],
    *,
    exclude_channel: Optional[str] = None,
) -> None:
    """Async variant of ``publish_ws_event_reliable`` for ASGI handlers."""
    envelope = {**envelope}

    from .async_io import run_sync_io

    event_id = await run_sync_io(_append_to_buffer, topic, envelope)
    if event_id:
        envelope["event_id"] = event_id

    envelope["_topic"] = topic
    msg_type = envelope.get("type", "unknown")

    group_name = _normalize_group_name(f"topic.{topic}")
    try:
        delivered = await _group_send_with_retry_async(
            group_name,
            _broadcast_layer_payload(envelope, exclude_channel=exclude_channel),
        )
        if delivered:
            record_message_sent(msg_type)
            logger.debug("[WS Bus] published reliable async to group=%s, type=%s", group_name, msg_type)
        else:
            record_publish_skipped_breaker_open(msg_type)
    except Exception as exc:
        logger.error(
            "[WS Bus] CRITICAL async publish failed: topic=%s type=%s error=%s",
            topic, msg_type, exc,
        )
        raise WsPublishError(topic, msg_type, exc) from exc


def publish_to_user(
    user_id: str,
    envelope: Dict[str, Any],
) -> bool:
    """直接广播到用户级 group ``user.{user_id}``。

    与 :func:`publish_ws_event` 的关键区别：
      - publish_ws_event 把 topic 包装为 ``topic.{topic}`` group，依赖前端
        显式 ``subscribe`` 后 join 对应 group；
      - publish_to_user 直接发到 ``user.{user_id}`` group —— 前端 auth 时
        已 join 该 group（详见 ``ws/handlers/auth.py``），无需订阅即可
        24/7 接收用户级广播。

    适用场景：``agent.user.*`` 三类用户级事件——
      - ``title_updated``（LLM 生成会话标题）
      - ``notification.new``（通知中心实时推送，跨平台共用）
      - ``permission.changed``（权限变更广播）
      - ``approval_preferences_changed``（跨设备审批偏好同步）

    历史背景：早期（Wave 5/6/7）该函数用于"跨 wt 任务通知 + 离线 inbox 补送 +
    offline_recovery_hint"机制，2026-05 整套删除（详见 PR 标题"删除全局聚合
    通知"）；现在仅负责 ``agent.user.*`` 三类的实时分发，不再写 inbox /
    last_event_at，重连不补送，离线期间错过即错过——具体入口（对话 / Agenda /
    Agent 详情）由各自的"打开拉最新"路径自洽。

    Envelope 协议契约（W1 用户级事件治理）
    -----------------------------------

    传入的 ``envelope`` dict 的 ``type`` 字段**必须是完整 ``agent.user.*`` 路径**，
    禁止使用短名 / 旧 topic 名（如 ``"title_updated"`` / ``"notification.new"``
    / ``"permission.changed"``）—— 前端 router 按完整 type 路径分发，短名会
    被识别为 unknown 并丢弃。

    正确写法（使用 helper 拼接）::

        from apps.services.common.agent_protocol.constants import AgentUserEvent
        from apps.services.common.agent_protocol.namespace import user_event_type
        envelope = build_envelope(
            user_event_type(AgentUserEvent.TITLE_UPDATED),  # → "agent.user.title_updated"
            request_id, payload,
        )
        publish_to_user(user_id, envelope)

    禁止写法（直接传字面量短名）::

        # ❌ 短名/旧 topic 名都不行；前端 router 不会识别
        envelope = build_envelope("title_updated", request_id, payload)
        envelope = build_envelope("notifications.<user>", request_id, payload)

    返回值：
      - ``True`` —— group_send 实际已发起（含 retry 后成功）。注意 ``True``
        **不保证**任何客户端已收到（channel layer 异步，且对应 user 当前可能
        没有任何 consumer 在线）；只表示"实时分发链路尚未故障"
      - ``False`` —— 三种情况之一：
          1. ``user_id`` 为空
          2. 断路器 OPEN，跳过实时推送（已记 ``ws_publish_skipped_breaker_open``）
          3. retry 全部耗尽（已记 warning）

    **关键**：本方法不抛异常——失败语义全部通过返回值 + metric + log 暴露。
    """
    if not user_id:
        return False
    safe_envelope = {**envelope}
    msg_type = safe_envelope.get("type", "unknown")

    group_name = _normalize_group_name(f"user.{user_id}")
    try:
        delivered = _group_send_with_retry(
            group_name,
            {"type": "broadcast_message", "message": safe_envelope},
        )
        if delivered:
            record_message_sent(msg_type)
            logger.debug(
                "[WS Bus] published to user group=%s type=%s",
                group_name, msg_type,
            )
            return True
        record_publish_skipped_breaker_open(msg_type)
        return False
    except Exception as exc:
        logger.warning(
            "[WS Bus] publish_to_user failed: user=%s type=%s error=%s",
            user_id, msg_type, exc,
        )
        return False


async def publish_to_user_async(
    user_id: str,
    envelope: Dict[str, Any],
) -> bool:
    """Async variant of :func:`publish_to_user` for ASGI handlers."""
    if not user_id:
        return False
    safe_envelope = {**envelope}
    msg_type = safe_envelope.get("type", "unknown")

    group_name = _normalize_group_name(f"user.{user_id}")
    try:
        delivered = await _group_send_with_retry_async(
            group_name,
            {"type": "broadcast_message", "message": safe_envelope},
        )
        if delivered:
            record_message_sent(msg_type)
            logger.debug(
                "[WS Bus] published async to user group=%s type=%s",
                group_name, msg_type,
            )
            return True
        record_publish_skipped_breaker_open(msg_type)
        return False
    except Exception as exc:
        logger.warning(
            "[WS Bus] publish_to_user_async failed: user=%s type=%s error=%s",
            user_id, msg_type, exc,
        )
        return False


DEVICE_ACTION_READY_TTL = 120  # DEV-P1-03: 120s TTL, 依赖心跳续期
DEVICE_ACTION_LAST_SEEN_TTL = 30 * 24 * 60 * 60
DEVICE_CONN_KEY_PREFIX = "ws:device_conns:"
DEVICE_CONN_TTL = 600

# DEV-P1-19: 预订阅缓冲（auth→subscribe 窗口期保护）
PRE_SUBSCRIBE_FLAG_PREFIX = "device_pre_subscribed:"
PRE_SUBSCRIBE_FLAG_TTL = 30  # CA-005: 预订阅标志位 TTL，需覆盖高负载/网络抖动下 auth→subscribe 窗口
PRE_SUBSCRIBE_BUFFER_PREFIX = "agent:pre_sub_buffer:"
PRE_SUBSCRIBE_BUFFER_TTL = 60  # CA-005: 预缓冲 TTL，需大于 flag TTL 以保证 flag 过期前 buffer 仍可读
PRE_SUBSCRIBE_BUFFER_MAX_LEN = 20

# DEV-P1-07: 进程内设备状态缓存，Redis 故障时 fail-open
_device_state_cache: dict[str, tuple[bool, float]] = {}
_device_state_lock = threading.Lock()
_DEVICE_STATE_CACHE_TTL = 300  # 缓存最大存活 5 分钟
_DEVICE_STATE_CACHE_MAX = 10000


def _update_device_state_cache(fingerprint: str, online: bool) -> None:
    with _device_state_lock:
        _device_state_cache[fingerprint] = (online, time.time())
        if len(_device_state_cache) > _DEVICE_STATE_CACHE_MAX:
            cutoff = time.time() - _DEVICE_STATE_CACHE_TTL
            stale = [k for k, (_, ts) in _device_state_cache.items() if ts < cutoff]
            for k in stale:
                del _device_state_cache[k]


def _get_cached_device_state(fingerprint: str) -> Optional[bool]:
    with _device_state_lock:
        entry = _device_state_cache.get(fingerprint)
        if entry is None:
            return None
        online, ts = entry
        if time.time() - ts > _DEVICE_STATE_CACHE_TTL:
            del _device_state_cache[fingerprint]
            return None
        return online


def device_action_ready_key(fingerprint: str) -> str:
    return f"device_action_ready:{fingerprint}"


def device_action_last_seen_key(fingerprint: str) -> str:
    return f"device_action_last_seen:{fingerprint}"


def device_connection_count_key(fingerprint: str) -> str:
    return f"{DEVICE_CONN_KEY_PREFIX}{fingerprint}"


def _device_action_ready_generation_key(fingerprint: str) -> str:
    return f"device_action_ready_generation:{fingerprint}"


def _device_action_ready_sequence_key(fingerprint: str) -> str:
    return f"device_action_ready_sequence:{fingerprint}"


def _device_action_ready_lock(cache: Any, fingerprint: str):
    lock = getattr(cache, "lock", None)
    if not callable(lock):
        return nullcontext()
    return lock(
        f"device_action_ready_lock:{fingerprint}",
        timeout=5,
        blocking_timeout=2,
        thread_local=False,
    )


def _claim_device_action_ready_locked(
    cache: Any,
    fingerprint: str,
    channel_name: str,
) -> int:
    sequence_key = _device_action_ready_sequence_key(fingerprint)
    if cache.get(sequence_key) is None:
        cache.add(sequence_key, 0, timeout=None)
    connection_generation = int(cache.incr(sequence_key))
    cache.set(
        device_action_ready_key(fingerprint),
        channel_name,
        timeout=DEVICE_ACTION_READY_TTL,
    )
    cache.set(
        _device_action_ready_generation_key(fingerprint),
        connection_generation,
        timeout=DEVICE_ACTION_READY_TTL,
    )
    cache.set(
        device_action_last_seen_key(fingerprint),
        time.time(),
        timeout=DEVICE_ACTION_LAST_SEEN_TTL,
    )
    return connection_generation


def claim_device_action_ready(
    fingerprint: str,
    channel_name: str,
) -> int:
    """让最新订阅的同设备连接成为唯一 action 接收者。"""
    from django.core.cache import cache

    with _device_action_ready_lock(cache, fingerprint):
        return _claim_device_action_ready_locked(
            cache,
            fingerprint,
            channel_name,
        )


def renew_device_action_ready(
    fingerprint: str,
    channel_name: str,
    connection_generation: int,
) -> Optional[int]:
    """仅续期当前路由；路由过期时允许存活连接抢占恢复。"""
    from django.core.cache import cache

    ready_key = device_action_ready_key(fingerprint)
    generation_key = _device_action_ready_generation_key(fingerprint)
    with _device_action_ready_lock(cache, fingerprint):
        current_channel = cache.get(ready_key)
        current_generation = cache.get(generation_key)
        if current_channel is None:
            return _claim_device_action_ready_locked(
                cache,
                fingerprint,
                channel_name,
            )
        if current_channel != channel_name:
            return None
        if current_generation not in (None, connection_generation):
            return None
        if current_generation is None:
            return _claim_device_action_ready_locked(
                cache,
                fingerprint,
                channel_name,
            )
        cache.set(ready_key, channel_name, timeout=DEVICE_ACTION_READY_TTL)
        cache.set(
            generation_key,
            connection_generation,
            timeout=DEVICE_ACTION_READY_TTL,
        )
        cache.set(
            device_action_last_seen_key(fingerprint),
            time.time(),
            timeout=DEVICE_ACTION_LAST_SEEN_TTL,
        )
        return connection_generation


def release_device_action_ready(
    fingerprint: str,
    channel_name: str,
    connection_generation: Optional[int],
) -> bool:
    """仅释放本连接持有的 readiness。"""
    from django.core.cache import cache

    ready_key = device_action_ready_key(fingerprint)
    generation_key = _device_action_ready_generation_key(fingerprint)
    with _device_action_ready_lock(cache, fingerprint):
        if cache.get(ready_key) != channel_name:
            return False
        current_generation = cache.get(generation_key)
        if (
            current_generation is not None
            and current_generation != connection_generation
        ):
            return False
        cache.delete(ready_key)
        cache.delete(generation_key)
        return True


def clear_device_action_ready(fingerprint: str) -> None:
    """服务端确认设备已离线时清理路由所有权。"""
    from django.core.cache import cache

    with _device_action_ready_lock(cache, fingerprint):
        cache.delete(device_action_ready_key(fingerprint))
        cache.delete(_device_action_ready_generation_key(fingerprint))


def _get_device_action_ready_owner_locked(
    cache: Any,
    fingerprint: str,
) -> Optional[tuple[str, int]]:
    channel_name = cache.get(device_action_ready_key(fingerprint))
    connection_generation = cache.get(
        _device_action_ready_generation_key(fingerprint)
    )
    if not isinstance(channel_name, str) or not channel_name:
        return None
    try:
        return channel_name, int(connection_generation)
    except (TypeError, ValueError):
        return None


def get_device_action_ready_owner(
    fingerprint: str,
) -> Optional[tuple[str, int]]:
    """Return the current single action receiver and its fencing generation."""
    from django.core.cache import cache

    with _device_action_ready_lock(cache, fingerprint):
        return _get_device_action_ready_owner_locked(cache, fingerprint)


def is_device_action_ready_owner(
    fingerprint: str,
    channel_name: str,
    connection_generation: Optional[int],
) -> bool:
    """Check that a Gateway connection still owns the exact device route."""
    if connection_generation is None:
        return False
    return get_device_action_ready_owner(fingerprint) == (
        channel_name,
        connection_generation,
    )


def acquire_device_action_delivery_lock(
    fingerprint: str,
    channel_name: str,
    connection_generation: Optional[int],
):
    """Lock the route only when this connection still owns its generation."""
    if connection_generation is None:
        return None
    from django.core.cache import cache

    lock = _device_action_ready_lock(cache, fingerprint)
    lock.__enter__()
    try:
        owner = _get_device_action_ready_owner_locked(cache, fingerprint)
        if owner == (channel_name, connection_generation):
            return lock
    except Exception:
        lock.__exit__(*sys.exc_info())
        raise
    lock.__exit__(None, None, None)
    return None


def release_device_action_delivery_lock(lock: Any) -> None:
    lock.__exit__(None, None, None)


def is_device_ws_connected(fingerprint: str) -> bool:
    """Check if a device runtime is ready to receive device action events.

    DEV-P1-07: Redis 故障时 fail-open — 对上次已知在线的设备保持在线状态，
    仅对未知设备降级为离线，避免 Redis 短暂不可用时全量错误降级。
    """
    try:
        from django.core.cache import cache
        result = cache.get(device_action_ready_key(fingerprint)) is not None
        _update_device_state_cache(fingerprint, result)
        return result
    except Exception as exc:
        cached = _get_cached_device_state(fingerprint)
        if cached is not None:
            logger.error(
                "[bus] Redis read failed for device_action_ready:%s, fail-open with cached state=%s: %s",
                fingerprint, cached, exc,
            )
            return cached
        logger.error(
            "[bus] Redis read failed for device_action_ready:%s, no cached state, assuming offline: %s",
            fingerprint, exc,
        )
        return False


def is_daemon_ws_connected(fingerprint: str) -> bool:
    """Backward-compatible alias for daemon-only callers."""
    return is_device_ws_connected(fingerprint)


def publish_device_ws_event_exact(
    fingerprint: str,
    envelope: Dict[str, Any],
    *,
    reliable: bool = False,
) -> bool:
    """Send to the single Gateway channel currently ready for this installation.

    ``channel_layer.send`` only confirms that the channel queue accepted the
    event; a crashed Gateway worker can leave its readiness lease behind while
    no consumer remains.  Reliable sends therefore enter the device topic's
    resume stream before the point-to-point enqueue.  The readiness lock keeps
    a reconnect from claiming the route and completing resume between those
    two operations.
    """
    from apps.services.common.agent_protocol.namespace import device_action_topic
    from django.core.cache import cache

    topic = device_action_topic(fingerprint)
    message_type = envelope.get("type", "unknown")
    with _device_action_ready_lock(cache, fingerprint):
        owner = _get_device_action_ready_owner_locked(cache, fingerprint)
        if owner is None:
            return False
        channel_name, connection_generation = owner
        channel_layer = get_channel_layer()
        if channel_layer is None:
            raise WsPublishError(
                topic,
                message_type,
                RuntimeError("channel layer not configured"),
            )

        message = {**envelope, "_topic": topic}
        if reliable:
            event_id = _append_to_buffer(topic, message)
            if not event_id:
                raise WsPublishError(
                    topic,
                    message_type,
                    RuntimeError("event buffer append failed"),
                )
            message["event_id"] = event_id

        layer_event = _broadcast_layer_payload(message)
        layer_event["device_action_fingerprint"] = fingerprint
        layer_event["device_action_generation"] = connection_generation
        try:
            async_to_sync(channel_layer.send)(channel_name, layer_event)
        except Exception as exc:
            raise WsPublishError(topic, message_type, exc) from exc

    record_message_sent(envelope.get("type", "unknown"))
    return True


def is_device_pre_subscribed(fingerprint: str) -> bool:
    """DEV-P1-19: 检查设备是否处于 auth→subscribe 预订阅窗口期。"""
    try:
        from django.core.cache import cache
        return cache.get(f"{PRE_SUBSCRIBE_FLAG_PREFIX}{fingerprint}") is not None
    except Exception:
        return False


def set_pre_subscribe_flag(fingerprint: str) -> None:
    """DEV-P1-19: auth 完成后设置预订阅标志，标记 auth→subscribe 窗口期。"""
    try:
        from django.core.cache import cache
        cache.set(f"{PRE_SUBSCRIBE_FLAG_PREFIX}{fingerprint}", "1", timeout=PRE_SUBSCRIBE_FLAG_TTL)
    except Exception as exc:
        logger.warning("[bus] set_pre_subscribe_flag failed for %s: %s", fingerprint, exc)


def clear_pre_subscribe_flag(fingerprint: str) -> None:
    """DEV-P1-19: subscribe 完成后清除预订阅标志。"""
    try:
        from django.core.cache import cache
        cache.delete(f"{PRE_SUBSCRIBE_FLAG_PREFIX}{fingerprint}")
    except Exception as exc:
        logger.warning("[bus] clear_pre_subscribe_flag failed for %s: %s", fingerprint, exc)


def buffer_pre_subscribe_action(fingerprint: str, envelope: Dict[str, Any]) -> None:
    """DEV-P1-19: 将 auth→subscribe 窗口期到达的 action 写入预缓冲区。"""
    import json as _json
    try:
        from django_redis import get_redis_connection
        rc = get_redis_connection("default")
        key = f"{PRE_SUBSCRIBE_BUFFER_PREFIX}{fingerprint}"
        if "ts" not in envelope or not isinstance(envelope.get("ts"), (int, float)):
            envelope.setdefault("ts", time.time())
        pipe = rc.pipeline(transaction=True)
        pipe.rpush(key, _json.dumps(envelope, ensure_ascii=False))
        pipe.ltrim(key, -PRE_SUBSCRIBE_BUFFER_MAX_LEN, -1)
        pipe.expire(key, PRE_SUBSCRIBE_BUFFER_TTL)
        pipe.execute()
        logger.info("[bus] pre-subscribe buffered action for device %s", fingerprint)
    except Exception as exc:
        logger.warning("[bus] pre-subscribe buffer write failed for %s: %s", fingerprint, exc)


def drain_pre_subscribe_buffer(fingerprint: str) -> list:
    """DEV-P1-19: subscribe 完成后 drain 预缓冲区，返回 envelope 列表。"""
    import json as _json
    key = f"{PRE_SUBSCRIBE_BUFFER_PREFIX}{fingerprint}"
    actions = []
    try:
        from django_redis import get_redis_connection
        rc = get_redis_connection("default")
        while True:
            raw = rc.lpop(key)
            if raw is None:
                break
            try:
                actions.append(_json.loads(raw))
            except Exception:
                pass
        if actions:
            logger.info("[bus] drained %d pre-subscribe buffered action(s) for %s", len(actions), fingerprint)
    except Exception as exc:
        logger.warning("[bus] pre-subscribe buffer drain failed for %s: %s", fingerprint, exc)
    return actions


__all__ = [
    "publish_ws_event",
    "publish_ws_event_async",
    "publish_ws_event_reliable",
    "publish_ws_event_reliable_async",
    "publish_to_user",
    "publish_to_user_async",
    "WsPublishError",
    "device_action_ready_key",
    "device_action_last_seen_key",
    "claim_device_action_ready",
    "renew_device_action_ready",
    "release_device_action_ready",
    "clear_device_action_ready",
    "publish_device_ws_event_exact",
    "is_daemon_ws_connected",
    "is_device_ws_connected",
    "is_device_pre_subscribed",
    "set_pre_subscribe_flag",
    "clear_pre_subscribe_flag",
    "buffer_pre_subscribe_action",
    "drain_pre_subscribe_buffer",
]

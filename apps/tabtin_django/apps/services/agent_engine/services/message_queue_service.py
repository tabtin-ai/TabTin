"""
MessageQueueService - 统一管理会话级消息排队/去重/防抖。
"""

from __future__ import annotations

import enum
import json
import logging
import threading
import time
from typing import Any, Dict, List, NamedTuple, Optional, Union

import redis as _redis_lib

from apps.services.common.agent_protocol.namespace import redis_key
from apps.services.agent_engine.legacy_env import agent_engine_setting
from apps.services.agent_engine.services.frontend_action_service import get_frontend_action_service

logger = logging.getLogger(__name__)

DEFAULT_LOCK_TTL = 600
DEFAULT_QUEUE_TTL = 60 * 60
DEFAULT_DEDUPE_TTL = 300
DEFAULT_DEBOUNCE_MS = 0
DEFAULT_QUEUE_MAX = 50

_WAIT_REPLICATION_TIMEOUT_MS = 5000

_REDIS_CONN_ERRORS = (
    _redis_lib.ConnectionError,
    _redis_lib.TimeoutError,
    ConnectionError,
    OSError,
)


class LockLostError(Exception):
    """LockWatchdog 检测到锁续期失败时抛出，通知业务线程立即中止。"""


class QueueHandoffError(RuntimeError):
    """原子队列交接失败，调用方必须停止 drain 并执行兜底释放。"""


class QueueEnqueueError(RuntimeError):
    """原子幂等入队失败；调用方不得返回 queued ACK。"""


class QueueEnqueueStatus(enum.Enum):
    """原子幂等入队的三态结果。"""

    ENQUEUED = "enqueued"
    DUPLICATE = "duplicate"
    FULL = "full"


class QueueEnqueueResult(NamedTuple):
    status: QueueEnqueueStatus
    cached_result: Optional[Union[Dict[str, Any], str]] = None


class LockResult(enum.Enum):
    """acquire_lock 的三态返回值。"""
    ACQUIRED = "acquired"
    HELD_BY_OTHER = "held_by_other"
    REDIS_ERROR = "redis_error"


class ProcessLevelLockFallback:
    """Redis 不可用时的进程级内存互斥锁。

    每个 thread_id 维护一把 threading.Lock，超时不阻塞、直接拒绝。
    通过 LRU 淘汰防止内存泄漏。
    """

    _MAX_ENTRIES = 2048

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: Dict[str, threading.Lock] = {}

    def try_acquire(self, thread_id: str) -> bool:
        with self._guard:
            if len(self._locks) >= self._MAX_ENTRIES:
                self._evict_unlocked()
            if thread_id not in self._locks:
                self._locks[thread_id] = threading.Lock()
            lock = self._locks[thread_id]
        return lock.acquire(blocking=False)

    def release(self, thread_id: str) -> None:
        with self._guard:
            lock = self._locks.get(thread_id)
        if lock is not None:
            try:
                lock.release()
            except RuntimeError:
                pass

    def _evict_unlocked(self) -> None:
        to_remove = [
            tid for tid, lk in self._locks.items() if not lk.locked()
        ]
        for tid in to_remove[:len(to_remove) // 2 or 1]:
            self._locks.pop(tid, None)


_process_lock_fallback = ProcessLevelLockFallback()


_replica_check_cache: Dict[str, bool] = {}
_REPLICA_CACHE_TTL = 60


class MessageQueueService:
    def __init__(self):
        self._redis = get_frontend_action_service().redis_client

    def _has_replicas(self) -> bool:
        """检测 Redis 是否有副本，结果缓存 60 秒。"""
        import time as _time
        cache_key = "replica_check"
        cached = _replica_check_cache.get(cache_key)
        if cached is not None:
            ts, val = cached
            if _time.monotonic() - ts < _REPLICA_CACHE_TTL:
                return val
        try:
            info = self._redis.info("replication")
            connected = info.get("connected_slaves", 0)
            result = connected > 0
        except Exception:
            result = False
        _replica_check_cache[cache_key] = (_time.monotonic(), result)
        return result

    @staticmethod
    def _lock_key(thread_id: str) -> str:
        return redis_key(["run", "lock", thread_id])

    @staticmethod
    def _queue_key(thread_id: str) -> str:
        return redis_key(["queue", thread_id])

    @staticmethod
    def _collect_key(thread_id: str) -> str:
        return redis_key(["queue", "collect", thread_id])

    @staticmethod
    def _debounce_key(thread_id: str) -> str:
        return redis_key(["queue", "debounce", thread_id])

    @staticmethod
    def _debounce_active_key(thread_id: str) -> str:
        return redis_key(["queue", "debounce", "active", thread_id])

    @staticmethod
    def _dedupe_key(thread_id: str, client_message_id: str) -> str:
        return redis_key(["dedupe", thread_id, client_message_id])

    def acquire_lock(self, thread_id: str, token: str, ttl: int = DEFAULT_LOCK_TTL) -> LockResult:
        """尝试获取分布式锁。

        P0-11: SET NX EX 成功后追加 WAIT 1 确保写入已复制到至少一个副本，
        防止 Redis Cluster 主从切换时新主缺少锁 key 导致双持有。

        当 settings.AGENT_ENGINE_LOCK_STRICT_REPLICATION = True 时（生产集群推荐，
        legacy 名 ORCHESTRATION_LOCK_STRICT_REPLICATION 仍兼容），
        若 WAIT 返回 0 副本确认，主动释放锁并返回 REDIS_ERROR，
        防止持有未复制的锁在 failover 后导致双持有。

        Returns:
            LockResult.ACQUIRED      — 成功获取锁
            LockResult.HELD_BY_OTHER — 锁被其他持有者占用
            LockResult.REDIS_ERROR   — Redis 连接/超时异常
        """
        if not thread_id:
            return LockResult.HELD_BY_OTHER
        lock_key = self._lock_key(thread_id)
        try:
            ok = self._redis.set(lock_key, token, nx=True, ex=ttl)
            if not ok:
                return LockResult.HELD_BY_OTHER
            try:
                if not self._has_replicas():
                    logger.debug(
                        "[MessageQueue] No replicas detected, skipping WAIT: thread=%s",
                        thread_id,
                    )
                else:
                    ack_count = self._redis.execute_command(
                        "WAIT", 1, _WAIT_REPLICATION_TIMEOUT_MS,
                    )
                    if ack_count < 1:
                        strict = agent_engine_setting(
                            "AGENT_ENGINE_LOCK_STRICT_REPLICATION", False,
                        )
                        if strict:
                            logger.critical(
                                "[MessageQueue] WAIT returned %d replicas in strict "
                                "replication mode; releasing lock to prevent unsafe "
                                "hold during failover: thread=%s",
                                ack_count, thread_id,
                            )
                            try:
                                self._redis.eval(
                                    self._RELEASE_LOCK_SCRIPT, 1, lock_key, token,
                                )
                            except Exception:
                                pass  # defensive: failover 场景下强制释放锁脚本失败，避免阻塞
                            return LockResult.REDIS_ERROR
                        logger.warning(
                            "[MessageQueue] WAIT acknowledged by %d replicas; "
                            "lock safety degraded during failover: thread=%s",
                            ack_count, thread_id,
                        )
            except Exception as wait_exc:
                logger.debug(
                    "[MessageQueue] WAIT command skipped (standalone Redis?): %s",
                    wait_exc,
                )
            return LockResult.ACQUIRED
        except _REDIS_CONN_ERRORS as exc:
            logger.error("[MessageQueue] acquire lock Redis connection error: %s", exc)
            return LockResult.REDIS_ERROR
        except Exception as exc:
            logger.warning("[MessageQueue] acquire lock failed: %s", exc)
            return LockResult.REDIS_ERROR

    _RELEASE_LOCK_SCRIPT = """
    if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
    else
        return 0
    end
    """

    _RELEASE_LOCK_IF_QUEUES_EMPTY_SCRIPT = """
    if redis.call('get', KEYS[1]) ~= ARGV[1] then
        return -1
    end
    if redis.call('llen', KEYS[2]) > 0
        or redis.call('llen', KEYS[3]) > 0
        or redis.call('llen', KEYS[4]) > 0 then
        return 0
    end
    redis.call('del', KEYS[1])
    return 1
    """

    _RENEW_LOCK_SCRIPT = """
    if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('expire', KEYS[1], tonumber(ARGV[2]))
    else
        return 0
    end
    """

    _DRAIN_LIST_SCRIPT = """
    local items = redis.call('lrange', KEYS[1], 0, -1)
    if #items > 0 then
        redis.call('del', KEYS[1])
    end
    return items
    """

    _DRAIN_DEBOUNCE_SCRIPT = """
    local items = redis.call('lrange', KEYS[1], 0, -1)
    if #items > 0 then
        redis.call('del', KEYS[1])
        if redis.call('exists', KEYS[2]) == 1 then
            redis.call('del', KEYS[2])
        end
    end
    return items
    """

    _ENQUEUE_DEBOUNCE_SCRIPT = """
    redis.call('rpush', KEYS[1], ARGV[1])
    redis.call('expire', KEYS[1], tonumber(ARGV[3]))
    local is_first = redis.call('set', KEYS[2], ARGV[4], 'NX', 'PX', tonumber(ARGV[2]))
    if is_first then
        return 1
    else
        return 0
    end
    """

    # ``client_event_id`` 同时保护去重结果与队列 append。过去的实现先复用
    # ChatMessage，再独立 RPUSH；两个同 ID 请求都会成功 RPUSH，最终执行两次。
    # 这里把 GET dedupe、容量检查、RPUSH 与 queued 结果写入放进同一段 Lua：
    # Redis 串行执行脚本，因此同一个稳定事件 ID 最多只有一个 payload 入队。
    _ENQUEUE_ONCE_SCRIPT = """
    local existing = redis.call('get', KEYS[1])
    if existing then
        return {0, existing}
    end

    local queue_max = tonumber(ARGV[5]) or 0
    if queue_max > 0 and redis.call('llen', KEYS[2]) >= queue_max then
        return {-1, ''}
    end

    if ARGV[6] == '1' then
        redis.call('lpush', KEYS[2], ARGV[1])
    else
        redis.call('rpush', KEYS[2], ARGV[1])
    end

    local debounce_ms = tonumber(ARGV[7]) or 0
    if debounce_ms > 0 then
        redis.call('expire', KEYS[2], tonumber(ARGV[9]))
        redis.call('set', KEYS[3], ARGV[8], 'NX', 'PX', debounce_ms)
    else
        redis.call('expire', KEYS[2], tonumber(ARGV[3]))
    end

    redis.call('set', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[4]))
    return {1, ARGV[2]}
    """

    _DEDUPE_RESULT_PREFIX = "result:v2:"

    @classmethod
    def encode_dedupe_result(cls, result: Dict[str, Any]) -> str:
        """把完整 ChatService 结果编码为带版本的 Redis 值。"""
        if not isinstance(result, dict):
            raise TypeError("dedupe result must be a dict")
        return cls._DEDUPE_RESULT_PREFIX + json.dumps(
            result,
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        )

    @classmethod
    def decode_dedupe_result(
        cls,
        value: Any,
    ) -> Optional[Union[Dict[str, Any], str]]:
        """解码 v2 结果，同时保留旧版纯 message_id 缓存兼容。"""
        if isinstance(value, bytes):
            value = value.decode("utf-8", errors="replace")
        if not isinstance(value, str) or not value:
            return None
        if value == "pending" or value.startswith("pending:"):
            return None
        if not value.startswith(cls._DEDUPE_RESULT_PREFIX):
            return value
        try:
            decoded = json.loads(value[len(cls._DEDUPE_RESULT_PREFIX):])
        except (TypeError, ValueError):
            logger.warning("[MessageQueue] invalid v2 dedupe result payload")
            return None
        return decoded if isinstance(decoded, dict) else None

    def release_lock(self, thread_id: str, token: str) -> None:
        if not thread_id:
            return
        try:
            key = self._lock_key(thread_id)
            self._redis.eval(self._RELEASE_LOCK_SCRIPT, 1, key, token)
        except Exception as exc:
            logger.warning("[MessageQueue] release lock failed: %s", exc)

    def release_lock_if_queues_empty(self, thread_id: str, token: str) -> bool:
        """Atomically hand off the run lock only when no queued work exists.

        ``drain -> empty -> release`` used to be three separate operations.
        A concurrent sender could observe the lock, enqueue immediately after
        the empty read, and then watch the owner release the lock, leaving the
        payload orphaned until another message happened to arrive.  Redis
        serializes this Lua script with every RPUSH/LPUSH: an enqueue before the
        script keeps the lock for another drain; an enqueue after the script can
        acquire the now-free lock and recover the queue itself.

        Returns ``False`` only when this caller still owns the lock and queued
        work is present.  Lost ownership returns ``True`` because this caller
        must stop touching the queue; the watchdog reports that condition.
        """
        if not thread_id:
            return True
        try:
            result = int(self._redis.eval(
                self._RELEASE_LOCK_IF_QUEUES_EMPTY_SCRIPT,
                4,
                self._lock_key(thread_id),
                self._queue_key(thread_id),
                self._collect_key(thread_id),
                self._debounce_key(thread_id),
                token,
            ))
            if result < 0:
                logger.warning(
                    "[MessageQueue] lock ownership lost during queue handoff: thread=%s",
                    thread_id,
                )
                return True
            return result == 1
        except Exception as exc:
            # 不能返回 False：调用方会把它解释成“队列仍有消息”并立即重试，
            # Redis 故障期间形成无上限热循环。显式抛出后由上层 finally 做
            # best-effort release，同时保留异常供日志归因。
            logger.warning(
                "[MessageQueue] atomic queue handoff failed: %s",
                exc,
            )
            raise QueueHandoffError(
                f"atomic queue handoff failed for thread={thread_id}"
            ) from exc

    def renew_lock(self, thread_id: str, token: str, ttl: int = DEFAULT_LOCK_TTL) -> bool:
        if not thread_id:
            return False
        try:
            key = self._lock_key(thread_id)
            result = self._redis.eval(self._RENEW_LOCK_SCRIPT, 1, key, token, ttl)
            return bool(result)
        except Exception as exc:
            logger.warning("[MessageQueue] renew lock failed: %s", exc)
            return False

    def is_locked(self, thread_id: str) -> bool:
        if not thread_id:
            return False
        try:
            return bool(self._redis.exists(self._lock_key(thread_id)))
        except Exception:
            logger.warning("[MessageQueue] is_locked check failed for thread %s", thread_id, exc_info=True)
            return False

    def enqueue_followup(
        self,
        thread_id: str,
        payload: Dict[str, Any],
        ttl: int = DEFAULT_QUEUE_TTL,
        priority: bool = False,
    ) -> None:
        if not thread_id:
            return
        key = self._queue_key(thread_id)
        data = json.dumps(payload, ensure_ascii=False)
        try:
            if priority:
                self._redis.lpush(key, data)
            else:
                self._redis.rpush(key, data)
            self._redis.expire(key, ttl)
        except Exception as exc:
            logger.warning("[MessageQueue] enqueue followup failed: %s", exc)

    def enqueue_collect(
        self,
        thread_id: str,
        payload: Dict[str, Any],
        ttl: int = DEFAULT_QUEUE_TTL,
    ) -> None:
        if not thread_id:
            return
        key = self._collect_key(thread_id)
        data = json.dumps(payload, ensure_ascii=False)
        try:
            self._redis.rpush(key, data)
            self._redis.expire(key, ttl)
        except Exception as exc:
            logger.warning("[MessageQueue] enqueue collect failed: %s", exc)

    def enqueue_once(
        self,
        *,
        thread_id: str,
        client_event_id: str,
        payload: Dict[str, Any],
        queued_result: Dict[str, Any],
        mode: str,
        queue_max: int = DEFAULT_QUEUE_MAX,
        queue_ttl: int = DEFAULT_QUEUE_TTL,
        dedupe_ttl: int = DEFAULT_DEDUPE_TTL,
        debounce_ms: int = DEFAULT_DEBOUNCE_MS,
        priority: bool = False,
    ) -> QueueEnqueueResult:
        """按稳定客户端事件 ID 原子地最多入队一次。

        ``DUPLICATE`` 会携带第一次写入的 queued 或最终完整结果，调用方直接
        恢复该结果即可；``FULL`` 不写 dedupe marker，队列腾出后同一事件仍可
        重试。Redis 异常显式抛出，禁止上层把未入队误报为 queued。
        """
        if not thread_id or not client_event_id:
            raise QueueEnqueueError("thread_id and client_event_id are required")

        normalized_mode = str(mode or "collect").strip().lower()
        use_debounce = int(debounce_ms or 0) > 0
        if use_debounce:
            queue_key = self._debounce_key(thread_id)
        elif normalized_mode == "collect":
            queue_key = self._collect_key(thread_id)
        else:
            queue_key = self._queue_key(thread_id)

        payload_json = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        )
        result_json = self.encode_dedupe_result(queued_result)
        queue_ttl = max(int(queue_ttl or DEFAULT_QUEUE_TTL), 1)
        # queued marker 至少和队列本身同寿命，否则 payload 尚未处理时 marker
        # 已过期，同一 client_event_id 会再次入队。
        idempotency_ttl = max(int(dedupe_ttl or DEFAULT_DEDUPE_TTL), queue_ttl)
        debounce_ms = max(int(debounce_ms or 0), 0)
        debounce_ttl = max(int(debounce_ms / 1000) + 60, 60)

        try:
            raw = self._redis.eval(
                self._ENQUEUE_ONCE_SCRIPT,
                3,
                self._dedupe_key(thread_id, client_event_id),
                queue_key,
                self._debounce_active_key(thread_id),
                payload_json,
                result_json,
                str(queue_ttl),
                str(idempotency_ttl),
                str(max(int(queue_max or 0), 0)),
                "1" if priority else "0",
                str(debounce_ms),
                str(int(time.time() * 1000)),
                str(debounce_ttl),
            )
        except Exception as exc:
            logger.error(
                "[MessageQueue] atomic enqueue failed: thread=%s client_event_id=%s error=%s",
                thread_id,
                client_event_id,
                exc,
            )
            raise QueueEnqueueError(
                f"atomic enqueue failed for thread={thread_id}"
            ) from exc

        if not isinstance(raw, (list, tuple)) or not raw:
            raise QueueEnqueueError(
                f"invalid atomic enqueue response for thread={thread_id}"
            )
        try:
            code = int(raw[0])
        except (TypeError, ValueError, IndexError) as exc:
            raise QueueEnqueueError(
                f"invalid atomic enqueue status for thread={thread_id}"
            ) from exc

        cached = self.decode_dedupe_result(raw[1] if len(raw) > 1 else None)
        if code == 1:
            return QueueEnqueueResult(QueueEnqueueStatus.ENQUEUED, cached)
        if code == 0:
            return QueueEnqueueResult(QueueEnqueueStatus.DUPLICATE, cached)
        if code == -1:
            return QueueEnqueueResult(QueueEnqueueStatus.FULL, None)
        raise QueueEnqueueError(
            f"unknown atomic enqueue status={code} for thread={thread_id}"
        )

    def drain_collect(self, thread_id: str) -> List[Dict[str, Any]]:
        if not thread_id:
            return []
        key = self._collect_key(thread_id)
        try:
            raw_items = self._redis.eval(self._DRAIN_LIST_SCRIPT, 1, key)
            if not raw_items:
                return []
        except Exception as exc:
            logger.warning("[MessageQueue] drain collect failed: %s", exc)
            return []

        items: List[Dict[str, Any]] = []
        for raw in raw_items:
            try:
                payload = json.loads(raw)
            except Exception:
                payload = None
            if isinstance(payload, dict):
                items.append(payload)
        return items

    def pop_followup(self, thread_id: str) -> Optional[Dict[str, Any]]:
        if not thread_id:
            return None
        key = self._queue_key(thread_id)
        try:
            raw = self._redis.lpop(key)
        except Exception as exc:
            logger.warning("[MessageQueue] pop followup failed: %s", exc)
            return None
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except Exception:
            payload = None
        return payload if isinstance(payload, dict) else None

    def clear_queue(self, thread_id: str) -> None:
        if not thread_id:
            return
        try:
            self._redis.delete(self._queue_key(thread_id))
        except Exception as exc:
            logger.warning("[MessageQueue] clear queue failed: %s", exc)

    def clear_collect(self, thread_id: str) -> None:
        if not thread_id:
            return
        try:
            self._redis.delete(self._collect_key(thread_id))
        except Exception as exc:
            logger.warning("[MessageQueue] clear collect failed: %s", exc)

    def enqueue_debounce(self, thread_id: str, payload: Dict[str, Any], debounce_ms: int) -> bool:
        if not thread_id:
            return False
        if debounce_ms <= 0:
            return False
        list_key = self._debounce_key(thread_id)
        active_key = self._debounce_active_key(thread_id)
        data = json.dumps(payload, ensure_ascii=False)
        ttl_seconds = max(int(debounce_ms / 1000) + 60, 60)
        try:
            result = self._redis.eval(
                self._ENQUEUE_DEBOUNCE_SCRIPT,
                2,
                list_key, active_key,
                data,
                str(debounce_ms),
                str(ttl_seconds),
                str(int(time.time() * 1000)),
            )
            return bool(result)
        except _REDIS_CONN_ERRORS as exc:
            logger.error(
                "[MessageQueue] enqueue debounce Redis connection error "
                "(propagating to caller): %s", exc,
            )
            raise
        except Exception as exc:
            logger.warning("[MessageQueue] enqueue debounce failed: %s", exc)
            return False

    def drain_debounce(self, thread_id: str) -> List[Dict[str, Any]]:
        if not thread_id:
            return []
        list_key = self._debounce_key(thread_id)
        active_key = self._debounce_active_key(thread_id)
        try:
            raw_items = self._redis.eval(self._DRAIN_DEBOUNCE_SCRIPT, 2, list_key, active_key)
            if not raw_items:
                return []
        except Exception as exc:
            logger.warning("[MessageQueue] drain debounce failed: %s", exc)
            return []

        items: List[Dict[str, Any]] = []
        for raw in raw_items:
            try:
                payload = json.loads(raw)
            except Exception:
                payload = None
            if isinstance(payload, dict):
                items.append(payload)
        return items

    def get_queue_size(self, thread_id: str) -> int:
        if not thread_id:
            return 0
        try:
            return int(self._redis.llen(self._queue_key(thread_id)))
        except Exception:
            logger.warning("[MessageQueue] get_queue_size failed for thread %s", thread_id, exc_info=True)
            return 0

    def get_collect_size(self, thread_id: str) -> int:
        if not thread_id:
            return 0
        try:
            return int(self._redis.llen(self._collect_key(thread_id)))
        except Exception:
            logger.warning("[MessageQueue] get_collect_size failed for thread %s", thread_id, exc_info=True)
            return 0

    _GC_DEBOUNCE_SCRIPT = """
    local ttl = redis.call('ttl', KEYS[1])
    local active_exists = redis.call('exists', KEYS[2])
    if active_exists == 0 and ttl == -1 then
        local length = redis.call('llen', KEYS[1])
        if length > 0 then
            redis.call('expire', KEYS[1], tonumber(ARGV[1]))
            return length
        end
    end
    return 0
    """

    _GC_FALLBACK_TTL_S = 120

    def gc_orphaned_debounce_keys(self, thread_ids: List[str]) -> int:
        """扫描给定 thread_id 列表，清理孤立的 debounce list key。

        当 list_key 存在且无 TTL、同时 active_key 已不存在时，
        说明之前的 enqueue 操作在 Lua 原子化之前因中途故障留下了残留。
        为这些 key 补设安全 TTL，防止 Redis 内存永久泄漏。

        Returns: 被补设 TTL 的孤立 key 数量。
        """
        cleaned = 0
        for tid in thread_ids:
            if not tid:
                continue
            list_key = self._debounce_key(tid)
            active_key = self._debounce_active_key(tid)
            try:
                result = self._redis.eval(
                    self._GC_DEBOUNCE_SCRIPT,
                    2,
                    list_key, active_key,
                    str(self._GC_FALLBACK_TTL_S),
                )
                if result and int(result) > 0:
                    cleaned += 1
                    logger.warning(
                        "[MessageQueue] GC: set fallback TTL on orphaned debounce list_key: "
                        "thread=%s, msgs=%s",
                        tid, result,
                    )
            except Exception as exc:
                logger.warning(
                    "[MessageQueue] GC: failed to check debounce key for thread=%s: %s",
                    tid, exc,
                )
        return cleaned

    def gc_scan_debounce_keys(self) -> int:
        """全量 SCAN 扫描所有 debounce list key，清理孤立者。

        适合由定期 Beat 任务或管理命令调用。
        """
        prefix = redis_key(["queue", "debounce"])
        active_infix = ":active:"
        cleaned = 0
        cursor = 0
        try:
            while True:
                cursor, keys = self._redis.scan(
                    cursor=cursor,
                    match=f"{prefix}:*",
                    count=200,
                )
                for key_bytes in keys:
                    key = key_bytes if isinstance(key_bytes, str) else key_bytes.decode("utf-8", errors="replace")
                    if active_infix in key:
                        continue
                    suffix = key[len(prefix) + 1:]
                    active_key = self._debounce_active_key(suffix)
                    try:
                        result = self._redis.eval(
                            self._GC_DEBOUNCE_SCRIPT,
                            2,
                            key, active_key,
                            str(self._GC_FALLBACK_TTL_S),
                        )
                        if result and int(result) > 0:
                            cleaned += 1
                            logger.warning(
                                "[MessageQueue] GC scan: set fallback TTL on orphaned key=%s, msgs=%s",
                                key, result,
                            )
                    except Exception as exc:
                        logger.warning("[MessageQueue] GC scan: failed for key=%s: %s", key, exc)
                if cursor == 0:
                    break
        except Exception as exc:
            logger.warning("[MessageQueue] GC scan: iteration error: %s", exc)
        if cleaned > 0:
            logger.info("[MessageQueue] GC scan complete: cleaned %d orphaned debounce keys", cleaned)
        return cleaned

    def get_debounce_remaining_ms(self, thread_id: str) -> Optional[int]:
        if not thread_id:
            return None
        try:
            ttl = int(self._redis.pttl(self._debounce_active_key(thread_id)))
        except Exception:
            return None
        if ttl <= 0:
            return None
        return ttl

    def get_debounce_list_len(self, thread_id: str) -> int:
        """返回 debounce list 中的待处理消息数量。"""
        if not thread_id:
            return 0
        try:
            return int(self._redis.llen(self._debounce_key(thread_id)))
        except Exception:
            return 0

    _MAX_PENDING_DURATION_S = 300

    def set_dedupe_pending(
        self,
        thread_id: str,
        client_message_id: str,
        ttl: int = DEFAULT_DEDUPE_TTL,
        worker_id: Optional[str] = None,
    ) -> bool:
        """标记 dedupe key 为 pending 状态（SET NX）。

        value 格式为 ``pending:<worker_id>:<deadline_ts>``，供后续检测持有者是否存活。
        """
        if not thread_id or not client_message_id:
            return False
        key = self._dedupe_key(thread_id, client_message_id)
        _wid = worker_id or "unknown"
        deadline = time.time() + self._MAX_PENDING_DURATION_S
        value = f"pending:{_wid}:{deadline:.0f}"
        try:
            return bool(self._redis.set(key, value, nx=True, ex=ttl))
        except Exception as exc:
            logger.warning("[MessageQueue] set dedupe pending failed: %s", exc)
            return False

    _RECLAIM_STALE_PENDING_SCRIPT = """
    local val = redis.call('get', KEYS[1])
    if not val then return 1 end
    if string.sub(val, 1, 8) ~= 'pending:' then return 0 end
    local last_colon = val:find(':', 9)
    if not last_colon then return 0 end
    local deadline = tonumber(string.sub(val, last_colon + 1))
    if not deadline then return 0 end
    if tonumber(ARGV[1]) > deadline then
        redis.call('del', KEYS[1])
        return 1
    end
    return 0
    """

    def try_reclaim_stale_pending(self, thread_id: str, client_message_id: str, ttl: int = DEFAULT_DEDUPE_TTL) -> bool:
        """若 dedupe key 处于 stale pending 状态（持有者超时），原子检查并删除。

        使用 Lua 脚本保证 GET + deadline 判断 + DEL 在单次 Redis 操作中完成，
        防止非原子实现中原始 worker 在 GET 与 DELETE 之间完成处理、DELETE 误删
        有效结果导致双写的 TOCTOU 竞态。

        Returns True 表示已清除 stale key（或 key 不存在），调用方可重新 set_dedupe_pending。
        """
        if not thread_id or not client_message_id:
            return False
        key = self._dedupe_key(thread_id, client_message_id)
        try:
            result = self._redis.eval(
                self._RECLAIM_STALE_PENDING_SCRIPT, 1, key,
                str(time.time()),
            )
            reclaimed = bool(result)
            if reclaimed:
                logger.warning(
                    "[MessageQueue] Reclaimed stale dedupe pending: thread=%s, key=%s",
                    thread_id, client_message_id,
                )
            return reclaimed
        except Exception as exc:
            logger.warning("[MessageQueue] try_reclaim_stale_pending failed: %s", exc)
        return False

    def get_dedupe_result(
        self,
        thread_id: str,
        client_message_id: str,
    ) -> Optional[Union[Dict[str, Any], str]]:
        if not thread_id or not client_message_id:
            return None
        key = self._dedupe_key(thread_id, client_message_id)
        try:
            value = self._redis.get(key)
        except Exception:
            logger.warning("[MessageQueue] get_dedupe_result failed for thread %s", thread_id, exc_info=True)
            return None
        if not value:
            return None
        if isinstance(value, bytes):
            value = value.decode("utf-8", errors="replace")
        if value.startswith("pending:") or value == "pending":
            return None
        return self.decode_dedupe_result(value)

    def set_dedupe_result(
        self,
        thread_id: str,
        client_message_id: str,
        result: Union[Dict[str, Any], str],
        ttl: int = DEFAULT_DEDUPE_TTL,
    ) -> bool:
        if not thread_id or not client_message_id or not result:
            return False
        key = self._dedupe_key(thread_id, client_message_id)
        value = self.encode_dedupe_result(result) if isinstance(result, dict) else str(result)
        try:
            return bool(self._redis.set(key, value, ex=max(int(ttl or 0), 1)))
        except Exception as exc:
            logger.warning("[MessageQueue] set dedupe result failed: %s", exc)
            return False

    _CLEAR_DEDUPE_PENDING_SCRIPT = """
    local value = redis.call('get', KEYS[1])
    if not value then return 1 end
    local expected = 'pending:' .. ARGV[1] .. ':'
    if string.sub(value, 1, string.len(expected)) ~= expected then
        return 0
    end
    redis.call('del', KEYS[1])
    return 1
    """

    def clear_dedupe_pending(
        self,
        thread_id: str,
        client_message_id: str,
        worker_id: str,
    ) -> bool:
        """仅清理当前 worker 持有的 pending，允许 retryable 失败再次执行。"""
        if not thread_id or not client_message_id or not worker_id:
            return False
        try:
            return bool(self._redis.eval(
                self._CLEAR_DEDUPE_PENDING_SCRIPT,
                1,
                self._dedupe_key(thread_id, client_message_id),
                worker_id,
            ))
        except Exception as exc:
            logger.warning("[MessageQueue] clear dedupe pending failed: %s", exc)
            return False

    def load_settings(self) -> Dict[str, Any]:
        return {
            "queue_mode": agent_engine_setting("AGENT_ENGINE_QUEUE_MODE", "collect"),
            "queue_max": int(agent_engine_setting("AGENT_ENGINE_QUEUE_MAX", DEFAULT_QUEUE_MAX)),
            "queue_ttl": int(agent_engine_setting("AGENT_ENGINE_QUEUE_TTL_SECONDS", DEFAULT_QUEUE_TTL)),
            "lock_ttl": int(agent_engine_setting("AGENT_ENGINE_QUEUE_LOCK_TTL_SECONDS", DEFAULT_LOCK_TTL)),
            "dedupe_ttl": int(agent_engine_setting("AGENT_ENGINE_DEDUPE_TTL_SECONDS", DEFAULT_DEDUPE_TTL)),
            "debounce_ms": int(agent_engine_setting("AGENT_ENGINE_QUEUE_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS)),
        }


class LockWatchdog:
    """后台线程定期续期 Redis 分布式锁，防止长任务执行期间锁过期。

    P0-12: 续期失败时通过 lock_lost_event 通知业务线程，防止锁过期后
    第二个 Worker 获锁导致双写。业务线程应在关键检查点调用 is_lock_lost()。

    推荐用法（context manager，保证 stop() 必被调用）：
        with LockWatchdog(queue_service, thread_id, token, ttl) as wd:
            ... # 长时间处理，关键点检查 wd.is_lock_lost()

    也可手动管理（需自行确保 finally stop()）：
        watchdog = LockWatchdog(queue_service, thread_id, token, ttl)
        watchdog.start()
        try:
            ... # 关键点检查 watchdog.is_lock_lost()
        finally:
            watchdog.stop()
    """

    def __init__(
        self,
        queue_service: MessageQueueService,
        thread_id: str,
        token: str,
        ttl: int,
        interval: Optional[int] = None,
    ):
        self._queue_service = queue_service
        self._thread_id = thread_id
        self._token = token
        self._ttl = ttl
        self._interval = interval or max(ttl // 3, 1)
        self._stop_event = threading.Event()
        self._lock_lost_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._token_lock = threading.Lock()
        self._paused = threading.Event()

    @property
    def lock_lost_event(self) -> threading.Event:
        """业务线程可 wait() 此 Event，在锁丢失时被唤醒。"""
        return self._lock_lost_event

    def is_lock_lost(self) -> bool:
        """非阻塞检查锁是否已丢失。"""
        return self._lock_lost_event.is_set()

    def pause(self) -> None:
        """P1-18: 暂停续期（debounce sleep 前调用，锁即将被主动释放）。

        暂停期间 _run() 跳过续期尝试，续期失败不会触发 lock_lost_event。
        """
        self._paused.set()

    def resume(self, new_token: str) -> None:
        """P1-18: 恢复续期并更新 token（锁重新获取后调用）。"""
        with self._token_lock:
            self._token = new_token
        self._paused.clear()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def __enter__(self) -> "LockWatchdog":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.stop()
        if self._lock_lost_event.is_set():
            if exc_type is None:
                raise LockLostError(
                    f"Lock lost during execution, aborting to prevent dual-write: "
                    f"thread={self._thread_id}"
                )
            logger.warning(
                "[LockWatchdog] Lock was lost during execution "
                "(concurrent with %s), dual-write risk: thread=%s",
                exc_type.__name__, self._thread_id,
            )

    def _run(self) -> None:
        while not self._stop_event.wait(self._interval):
            if self._paused.is_set():
                continue
            with self._token_lock:
                token = self._token
            try:
                renewed = self._queue_service.renew_lock(
                    self._thread_id, token, self._ttl,
                )
                if not renewed:
                    if self._paused.is_set():
                        continue
                    logger.critical(
                        "[LockWatchdog] Lock renewal failed (ownership lost), "
                        "notifying business thread to abort: thread=%s",
                        self._thread_id,
                    )
                    self._lock_lost_event.set()
                    break
            except Exception as exc:
                if self._paused.is_set():
                    continue
                logger.critical(
                    "[LockWatchdog] Lock renewal error, notifying business thread "
                    "to abort: thread=%s error=%s",
                    self._thread_id, exc,
                )
                self._lock_lost_event.set()
                break


__all__ = ["MessageQueueService", "LockWatchdog", "LockResult", "LockLostError"]

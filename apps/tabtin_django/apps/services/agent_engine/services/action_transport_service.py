from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Dict, Optional

import redis
from django.conf import settings

from apps.services.common.agent_protocol.namespace import action_topic, device_action_topic, redis_key
from apps.services.common.ws.bus import (
    is_device_ws_connected,
    publish_device_ws_event_exact,
    publish_ws_event,
)

logger = logging.getLogger(__name__)

DEFAULT_RESULT_TTL = 300
ORPHAN_RESULT_TTL = 600
ACTION_DEVICE_TTL = 60 * 60
ACTION_BUFFER_PREFIX = "agent:action_buffer:"
ACTION_BUFFER_TTL = 300
ACTION_BUFFER_MAX_LEN = 50
DEDUP_KEY_PREFIX = "agent:dedup:"
DEDUP_TTL = 300
MAX_RESULT_PAYLOAD_BYTES = 512 * 1024  # 512 KB

# 智能截断常量：output 字段超限时保留头尾（尾部优先，编译错误/安装日志的关键信息通常在末尾）
OUTPUT_TRUNCATE_HEAD_CHARS = 12_000
OUTPUT_TRUNCATE_TAIL_CHARS = 28_000

# DEV-P1-05: BRPOP 轮询模式配置 + 并发限制
BRPOP_POLL_INTERVAL = 2  # 单次 BRPOP 最长阻塞 2 秒
MAX_CONCURRENT_BRPOP = 8  # 进程级信号量，防止同时阻塞超过 N 个线程
_brpop_semaphore = threading.Semaphore(MAX_CONCURRENT_BRPOP)


class ActionTransportService:
    """动作传输层：只负责怎么发、怎么等结果、怎么缓冲。"""

    def __init__(self) -> None:
        self._redis_client: Optional[redis.Redis] = None

    @property
    def redis_client(self) -> redis.Redis:
        if self._redis_client is None:
            try:
                from django_redis import get_redis_connection
                self._redis_client = get_redis_connection("default")
                logger.debug("[ActionTransport] Redis connection established (via django_redis)")
            except Exception:
                try:
                    self._redis_client = redis.Redis(
                        host=getattr(settings, "REDIS_HOST", "localhost"),
                        port=getattr(settings, "REDIS_PORT", 6379),
                        db=getattr(settings, "REDIS_DB", 0),
                        decode_responses=True,
                    )
                    self._redis_client.ping()
                    logger.debug("[ActionTransport] Redis connection established (direct)")
                except Exception as exc:
                    logger.error("[ActionTransport] Redis connection failed: %s", exc)
                    raise RuntimeError(f"Redis 连接失败: {exc}") from exc
        return self._redis_client

    @staticmethod
    def build_action_channel(thread_id: str) -> str:
        return action_topic(thread_id)

    @staticmethod
    def build_result_key(thread_id: str, task_id: str) -> str:
        return redis_key(["result", thread_id, task_id])

    @staticmethod
    def build_action_device_key(thread_id: str) -> str:
        return redis_key(["action_device", thread_id])

    @staticmethod
    def normalize_redis_string(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)

    def publish_session_action(self, thread_id: str, envelope: Dict[str, Any]) -> int:
        self._warn_if_oversized(envelope, f"session_action:{thread_id}")
        return 1 if publish_ws_event(action_topic(thread_id), envelope) else 0

    def publish_device_action(self, device_fingerprint: str, envelope: Dict[str, Any]) -> int:
        self._warn_if_oversized(envelope, f"device_action:{device_fingerprint}")
        # DEV-P1-19: auth→subscribe 窗口期保护 —— 设备已认证但尚未订阅 topic，
        # group_send 会静默丢弃消息。将 action 写入预缓冲区，on_subscribed 后 drain。
        from apps.services.common.ws.bus import (
            is_device_pre_subscribed,
            buffer_pre_subscribe_action,
        )
        if is_device_pre_subscribed(device_fingerprint):
            buffer_pre_subscribe_action(device_fingerprint, envelope)
            return 1
        return 1 if publish_device_ws_event_exact(device_fingerprint, envelope) else 0

    @staticmethod
    def _warn_if_oversized(envelope: Dict[str, Any], label: str) -> None:
        try:
            raw = json.dumps(envelope, ensure_ascii=False)
            size = len(raw.encode("utf-8"))
            if size > MAX_RESULT_PAYLOAD_BYTES:
                logger.warning(
                    "[ActionTransport] oversized WS envelope: %s size=%d limit=%d",
                    label, size, MAX_RESULT_PAYLOAD_BYTES,
                )
        except Exception:
            pass  # defensive: json.dumps/size 失败不应影响主路径（仅诊断日志）

    def is_device_connected(self, device_fingerprint: str) -> bool:
        return is_device_ws_connected(device_fingerprint)

    def buffer_action(self, device_fingerprint: str, envelope: Dict[str, Any]) -> None:
        key = f"{ACTION_BUFFER_PREFIX}{device_fingerprint}"
        if "ts" not in envelope or not isinstance(envelope.get("ts"), (int, float)):
            envelope.setdefault("ts", time.time())
        # E2E-012: 记录入缓冲时刻，drain 时可与当前策略版本对比检测过期
        if "_policy_buffered_at" not in envelope:
            envelope["_policy_buffered_at"] = time.time()
        try:
            pipe = self.redis_client.pipeline(transaction=True)
            pipe.rpush(key, json.dumps(envelope))
            pipe.ltrim(key, -ACTION_BUFFER_MAX_LEN, -1)
            pipe.expire(key, ACTION_BUFFER_TTL)
            pipe.execute()
            logger.info("[ActionTransport] buffered action for offline device: %s", device_fingerprint)
        except Exception as exc:
            logger.debug("[ActionTransport] action buffer failed: %s", exc)

    def drain_buffered_actions(self, device_fingerprint: str) -> list:
        key = f"{ACTION_BUFFER_PREFIX}{device_fingerprint}"
        actions = []
        try:
            while True:
                raw = self.redis_client.lpop(key)
                if raw is None:
                    break
                actions.append(json.loads(raw))
        except Exception as exc:
            logger.debug("[ActionTransport] drain buffer failed: %s", exc)
        if actions:
            actions.sort(key=lambda a: a.get("ts", 0))
            logger.info("[ActionTransport] drained %d buffered actions for %s", len(actions), device_fingerprint)
        return actions

    def bind_action_device(self, thread_id: str, device_id: str, ttl: int = ACTION_DEVICE_TTL) -> None:
        self.redis_client.set(self.build_action_device_key(thread_id), device_id, ex=ttl)

    def get_action_device(self, thread_id: str) -> Optional[str]:
        return self.normalize_redis_string(
            self.redis_client.get(self.build_action_device_key(thread_id))
        )

    def touch_action_device(self, thread_id: str, device_id: str, ttl: int = ACTION_DEVICE_TTL) -> bool:
        key = self.build_action_device_key(thread_id)
        current = self.normalize_redis_string(self.redis_client.get(key))
        if current != device_id:
            return False
        self.redis_client.expire(key, ttl)
        return True

    def release_action_device(self, thread_id: str, device_id: str) -> bool:
        key = self.build_action_device_key(thread_id)
        current = self.normalize_redis_string(self.redis_client.get(key))
        if current != device_id:
            return False
        self.redis_client.delete(key)
        return True

    def force_release_action_device(self, thread_id: str) -> bool:
        key = self.build_action_device_key(thread_id)
        return bool(self.redis_client.delete(key))

    def wait_for_result(
        self,
        thread_id: str,
        task_id: str,
        timeout: int,
        cancel_event: Optional[threading.Event] = None,
    ) -> Optional[Dict[str, Any]]:
        """轮询等待结果（短 BRPOP 循环），配合并发信号量防止线程池耗尽。

        P1-8 fix: 支持 cancel_event 参数，ToolExecutor 超时时会 set cancel_event，
        使本方法在下一个 BRPOP 轮询周期（≤2s）内退出，避免僵尸线程占用线程池。
        """
        key = self.build_result_key(thread_id, task_id)
        acquired = _brpop_semaphore.acquire(timeout=min(5, timeout))
        if not acquired:
            logger.warning("[ActionTransport] concurrent BRPOP limit reached (%d), rejecting: task=%s", MAX_CONCURRENT_BRPOP, task_id)
            return None
        try:
            deadline = time.time() + timeout
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    logger.info("[ActionTransport] wait_for_result cancelled via cancel_event: key=%s", key)
                    break
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                poll_timeout = min(BRPOP_POLL_INTERVAL, max(1, int(remaining)))
                result = self.redis_client.brpop([key], timeout=poll_timeout)
                if result is not None:
                    _, result_json = result
                    try:
                        return json.loads(result_json)
                    except (json.JSONDecodeError, TypeError, UnicodeDecodeError) as exc:
                        logger.error(
                            "[ActionTransport] corrupted result JSON: key=%s error=%s raw_len=%s",
                            key, exc, len(result_json) if result_json else 0,
                        )
                        return {"success": False, "error": f"result_json_corrupted: {exc}", "error_code": "RESULT_CORRUPTED"}
            self._try_send_cancel_signal(thread_id, task_id)
            try:
                orphan_marker = f"{key}:orphan"
                pipe = self.redis_client.pipeline(transaction=False)
                pipe.set(orphan_marker, "1", ex=ORPHAN_RESULT_TTL)
                pipe.expire(key, ORPHAN_RESULT_TTL)
                pipe.execute()
            except Exception:
                logger.warning(
                    "[ActionTransport] orphan marker pipeline failed: thread=%s task=%s",
                    thread_id,
                    task_id,
                    exc_info=True,
                )
            return None
        finally:
            _brpop_semaphore.release()

    def store_result(
        self,
        thread_id: str,
        task_id: str,
        result_data: Dict[str, Any],
        ttl: int = DEFAULT_RESULT_TTL,
    ) -> str:
        key = self.build_result_key(thread_id, task_id)
        try:
            payload = json.dumps(result_data, ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            logger.error("[ActionTransport] store_result serialization failed: key=%s error=%s", key, exc)
            payload = json.dumps({"success": False, "error": f"serialization_failed: {exc}"})

        payload_len = len(payload.encode("utf-8")) if isinstance(payload, str) else len(payload)
        if payload_len > MAX_RESULT_PAYLOAD_BYTES:
            logger.warning(
                "[ActionTransport] result payload oversized: key=%s size=%d limit=%d, truncating data fields",
                key, payload_len, MAX_RESULT_PAYLOAD_BYTES,
            )
            truncated = dict(result_data)
            for field in ("ui_tree", "clean_html", "skeleton_html", "snapshot", "data", "output"):
                if field not in truncated or not isinstance(truncated[field], (str, dict, list)):
                    continue
                if field == "output" and isinstance(truncated[field], str):
                    original = truncated[field]
                    head = original[:OUTPUT_TRUNCATE_HEAD_CHARS]
                    tail = original[-OUTPUT_TRUNCATE_TAIL_CHARS:]
                    truncated[field] = (
                        head
                        + f"\n\n[... truncated: {len(original)} chars → ~{OUTPUT_TRUNCATE_HEAD_CHARS + OUTPUT_TRUNCATE_TAIL_CHARS} chars ...]\n\n"
                        + tail
                    )
                else:
                    truncated[field] = f"[truncated: original {field} too large]"
            truncated["_size_truncated"] = True

            recheck = json.dumps(truncated, ensure_ascii=False).encode("utf-8")
            if len(recheck) > MAX_RESULT_PAYLOAD_BYTES:
                logger.warning(
                    "[ActionTransport] still oversized after smart truncation: key=%s size=%d, falling back to full replace",
                    key, len(recheck),
                )
                for field in ("output", "data"):
                    if field in truncated and isinstance(truncated[field], str):
                        truncated[field] = "[truncated: still oversized after smart truncation]"

            payload = json.dumps(truncated, ensure_ascii=False)

        effective_ttl = max(ttl, ORPHAN_RESULT_TTL)
        orphan_marker = f"{key}:orphan"
        try:
            pipe_check = self.redis_client.pipeline(transaction=False)
            pipe_check.ttl(key)
            pipe_check.get(orphan_marker)
            check_results = pipe_check.execute()
            existing_ttl = check_results[0]
            orphan_flag = check_results[1]
            is_late_arrival = existing_ttl > 0 or bool(orphan_flag)
        except Exception:
            logger.debug(
                "[ActionTransport] is_late_arrival 判定失败，回退 False: key=%s",
                key,
                exc_info=True,
            )
            is_late_arrival = False

        try:
            pipe = self.redis_client.pipeline(transaction=True)
            pipe.lpush(key, payload)
            pipe.expire(key, effective_ttl)
            pipe.execute()
        except Exception as exc:
            logger.error("[ActionTransport] store_result Redis write failed: key=%s error=%s", key, exc)
            raise

        if is_late_arrival:
            logger.warning(
                "[ActionTransport] result arrived after wait timeout (no active listener): key=%s",
                key,
            )
            try:
                self.redis_client.delete(orphan_marker)
            except Exception:
                pass  # defensive: 清理 orphan 标记失败不应影响已成功写入的结果返回
        return key

    def check_task_dedup(self, task_id: str) -> bool:
        """检查 task_id 是否已被处理过（SET NX 原子去重）。返回 True 表示首次，False 表示重复。"""
        dedup_key = f"{DEDUP_KEY_PREFIX}{task_id}"
        try:
            acquired = self.redis_client.set(dedup_key, "1", nx=True, ex=DEDUP_TTL)
            return bool(acquired)
        except Exception as exc:
            logger.warning("[ActionTransport] dedup check failed (allowing): task_id=%s error=%s", task_id, exc)
            return True

    def clear_task_dedup(self, task_id: str) -> None:
        """清除 task_id 的 dedup 标记，允许重试（如 store_result 失败后）。"""
        dedup_key = f"{DEDUP_KEY_PREFIX}{task_id}"
        try:
            self.redis_client.delete(dedup_key)
        except Exception as exc:
            logger.debug("[ActionTransport] dedup clear failed: task_id=%s error=%s", task_id, exc)

    def _try_send_cancel_signal(self, thread_id: str, task_id: str) -> None:
        """Best-effort: 查找已绑定设备并发送 cancel 信号。"""
        try:
            device_fp = self.normalize_redis_string(self.redis_client.get(self.build_action_device_key(thread_id)))
            if device_fp:
                self._send_cancel_signal(device_fp, thread_id, task_id)
        except Exception as exc:
            logger.debug("[ActionTransport] _try_send_cancel_signal failed: %s", exc)

    def _send_cancel_signal(self, device_fingerprint: str, thread_id: str, task_id: str) -> None:
        """通过 WS 通知 Daemon 取消工具执行。"""
        try:
            from apps.services.common.ws.protocol import build_envelope, new_event_id
            event_id = new_event_id()
            envelope = build_envelope(
                "agent.action.cancel",
                event_id,
                {"task_id": task_id, "thread_id": thread_id},
                event_id=event_id,
                thread_id=thread_id,
            )
            publish_ws_event(device_action_topic(device_fingerprint), envelope)
            logger.info(
                "[ActionTransport] cancel signal sent: device=%s task=%s thread=%s",
                device_fingerprint, task_id, thread_id,
            )
        except Exception as exc:
            logger.warning("[ActionTransport] cancel signal failed: task=%s error=%s", task_id, exc)


__all__ = [
    "ACTION_BUFFER_MAX_LEN",
    "ACTION_BUFFER_PREFIX",
    "ACTION_BUFFER_TTL",
    "ACTION_DEVICE_TTL",
    "DEDUP_KEY_PREFIX",
    "DEDUP_TTL",
    "DEFAULT_RESULT_TTL",
    "MAX_RESULT_PAYLOAD_BYTES",
    "ORPHAN_RESULT_TTL",
    "OUTPUT_TRUNCATE_HEAD_CHARS",
    "OUTPUT_TRUNCATE_TAIL_CHARS",
    "ActionTransportService",
]

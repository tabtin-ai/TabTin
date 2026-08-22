"""
MonitorService — 进程监管的核心服务层

职责：
- 创建/停止/查询 MonitorTask
- Redis 事件队列（设备端推 stdout 行 → 这里入队 → MonitorEventMiddleware 出队注入对话）
- 空闲唤醒（Agent 没在跑时收到 Monitor 事件 → 触发一轮推理）
- 心跳超时检测
- 子 Agent 级联清理
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import timedelta
from typing import Any, Dict, List, Optional

from django.utils import timezone

from apps.services.common.agent_protocol.namespace import redis_key
from apps.services.agent_engine.services.frontend_action_service import get_frontend_action_service

logger = logging.getLogger(__name__)

MONITOR_QUEUE_KEY_PREFIX = "monitor:events"
MONITOR_QUEUE_TTL = 60 * 60
MAX_QUEUE_SIZE = 500
MONITOR_WAKE_DEBOUNCE_KEY_PREFIX = "monitor:wake_debounce"
MONITOR_WAKE_DEBOUNCE_SECONDS = 60
HEARTBEAT_TIMEOUT_SECONDS = 60


def _queue_key(thread_id: str) -> str:
    return redis_key([MONITOR_QUEUE_KEY_PREFIX, thread_id])


def _wake_debounce_key(thread_id: str) -> str:
    return redis_key([MONITOR_WAKE_DEBOUNCE_KEY_PREFIX, thread_id])


class MonitorService:
    """进程监管服务（单例，通过 get_monitor_service() 获取）。"""

    def __init__(self):
        self._redis = None

    @property
    def redis(self):
        if self._redis is None:
            self._redis = get_frontend_action_service().redis_client
        return self._redis

    # ── 创建 ──────────────────────────────────────────────────────────

    def create_monitor(
        self,
        *,
        thread_id: str,
        command: str,
        description: str,
        device_fingerprint: str,
        notify_on: str = "every_line",
        pattern: Optional[str] = None,
        working_directory: Optional[str] = None,
        parent_subagent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """创建 MonitorTask 并返回序列化 dict。

        Raises ValueError if the per-thread limit is exceeded.
        """
        from apps.services.agent_engine.models import MonitorTask

        active_count = MonitorTask.objects.filter(
            thread_id=thread_id, status="running",
        ).count()
        if active_count >= MonitorTask.MAX_MONITORS_PER_THREAD:
            raise ValueError(
                f"Thread already has {active_count} active monitors "
                f"(max {MonitorTask.MAX_MONITORS_PER_THREAD}). "
                f"Stop an existing monitor before starting a new one."
            )

        task = MonitorTask.objects.create(
            thread_id=thread_id,
            command=command,
            description=description,
            device_fingerprint=device_fingerprint,
            notify_on=notify_on,
            pattern=pattern,
            working_directory=working_directory,
            parent_subagent_id=uuid.UUID(parent_subagent_id) if parent_subagent_id else None,
            status="running",
        )
        logger.info(
            "[MonitorService] Created monitor %s for thread=%s: %s",
            task.monitor_id, thread_id, description,
        )
        return self._serialize(task)

    # ── 停止 ──────────────────────────────────────────────────────────

    def stop_monitor(self, monitor_id: str, *, reason: str = "user_stop") -> bool:
        """Stop a running monitor. Returns True if status was changed."""
        from apps.services.agent_engine.models import MonitorTask

        updated = MonitorTask.objects.filter(
            monitor_id=monitor_id, status="running",
        ).update(
            status="stopped",
            fail_reason=reason,
            updated_at=timezone.now(),
        )
        if updated:
            logger.info("[MonitorService] Stopped monitor %s reason=%s", monitor_id, reason)
        return updated > 0

    def mark_stream_ended(
        self, monitor_id: str, *, exit_code: Optional[int] = None,
    ) -> bool:
        """Mark a monitor as stream_ended (process exited)."""
        from apps.services.agent_engine.models import MonitorTask

        fail_reason = f"exit_{exit_code}" if exit_code and exit_code != 0 else None
        status = "failed" if exit_code and exit_code != 0 else "stream_ended"
        updated = MonitorTask.objects.filter(
            monitor_id=monitor_id, status="running",
        ).update(
            status=status,
            fail_reason=fail_reason,
            updated_at=timezone.now(),
        )
        if updated:
            logger.info(
                "[MonitorService] Monitor %s %s (exit_code=%s)",
                monitor_id, status, exit_code,
            )
        return updated > 0

    def mark_device_disconnected(self, monitor_id: str) -> bool:
        """Mark a monitor as failed due to device disconnection."""
        from apps.services.agent_engine.models import MonitorTask

        updated = MonitorTask.objects.filter(
            monitor_id=monitor_id, status="running",
        ).update(
            status="failed",
            fail_reason="device_disconnected",
            updated_at=timezone.now(),
        )
        return updated > 0

    # ── 子 Agent 级联清理 ─────────────────────────────────────────────

    def cleanup_by_subagent(self, subagent_id: str) -> int:
        """Stop all running monitors created by a specific subagent."""
        from apps.services.agent_engine.models import MonitorTask

        updated = MonitorTask.objects.filter(
            parent_subagent_id=subagent_id, status="running",
        ).update(
            status="stopped",
            fail_reason="parent_subagent_exited",
            updated_at=timezone.now(),
        )
        if updated:
            logger.info(
                "[MonitorService] Cleaned up %d monitors for subagent %s",
                updated, subagent_id,
            )
        return updated

    # ── 查询 ──────────────────────────────────────────────────────────

    def get_monitor(self, monitor_id: str) -> Optional[Dict[str, Any]]:
        from apps.services.agent_engine.models import MonitorTask

        try:
            task = MonitorTask.objects.get(monitor_id=monitor_id)
            return self._serialize(task)
        except MonitorTask.DoesNotExist:
            return None

    def list_monitors(self, thread_id: str, *, status: Optional[str] = None) -> List[Dict[str, Any]]:
        from apps.services.agent_engine.models import MonitorTask

        qs = MonitorTask.objects.filter(thread_id=thread_id)
        if status:
            qs = qs.filter(status=status)
        return [self._serialize(t) for t in qs.order_by("-created_at")]

    # ── 心跳 ──────────────────────────────────────────────────────────

    def update_heartbeat(self, monitor_id: str) -> None:
        from apps.services.agent_engine.models import MonitorTask

        MonitorTask.objects.filter(
            monitor_id=monitor_id, status="running",
        ).update(last_heartbeat_at=timezone.now())

    def check_heartbeat_timeouts(self) -> int:
        """Mark stale monitors as failed. Returns number of monitors marked."""
        from apps.services.agent_engine.models import MonitorTask

        threshold = timezone.now() - timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)

        stale_qs = MonitorTask.objects.filter(
            status="running",
            last_heartbeat_at__isnull=False,
            last_heartbeat_at__lt=threshold,
        )
        stale_info = list(stale_qs.values("monitor_id", "thread_id", "description"))
        updated = stale_qs.update(
            status="failed",
            fail_reason="device_disconnected",
            updated_at=timezone.now(),
        )

        for info in stale_info:
            self._push_notification(info["thread_id"], {
                "type": "monitor_notification",
                "monitor_id": str(info["monitor_id"]),
                "description": info["description"],
                "status": "failed",
                "reason": "device_disconnected",
            })

        never_started = MonitorTask.objects.filter(
            status="running",
            last_heartbeat_at__isnull=True,
            created_at__lt=timezone.now() - timedelta(seconds=120),
        ).update(
            status="failed",
            fail_reason="never_started",
            updated_at=timezone.now(),
        )

        total = updated + never_started
        if total:
            logger.info(
                "[MonitorService] Marked %d monitors as disconnected, %d as never_started",
                updated, never_started,
            )
        return total

    # ── 事件队列 ──────────────────────────────────────────────────────

    def push_event(self, thread_id: str, event: Dict[str, Any]) -> None:
        """Push a Monitor event into the Redis queue for a thread.

        Uses pipeline to batch RPUSH + LTRIM + EXPIRE in one round trip.
        LTRIM caps the queue at MAX_QUEUE_SIZE, keeping only the newest events.
        Also triggers Agent wake if the thread is idle (debounced).
        """
        key = _queue_key(thread_id)
        try:
            pipe = self.redis.pipeline(False)
            pipe.rpush(key, json.dumps(event, ensure_ascii=False))
            pipe.ltrim(key, -MAX_QUEUE_SIZE, -1)
            pipe.expire(key, MONITOR_QUEUE_TTL)
            pipe.execute()
        except Exception as exc:
            logger.warning("[MonitorService] push_event failed: %s", exc)
            return

        is_terminal = event.get("type") == "monitor_notification"
        if is_terminal:
            self._trigger_agent_wake(thread_id)
        else:
            self._maybe_wake_agent(thread_id)

    def drain_events(self, thread_id: str) -> List[Dict[str, Any]]:
        """Atomically drain all pending events for a thread."""
        key = _queue_key(thread_id)
        try:
            pipe = self.redis.pipeline(True)
            pipe.lrange(key, 0, -1)
            pipe.delete(key)
            results = pipe.execute()
            raw_items = results[0] or []
            return [json.loads(item) for item in raw_items]
        except Exception as exc:
            logger.warning("[MonitorService] drain_events failed: %s", exc)
            return []

    def _push_notification(self, thread_id: str, notification: Dict[str, Any]) -> None:
        """Push a terminal notification (stream_ended / failed) into the event queue."""
        self.push_event(thread_id, notification)

    # ── 空闲唤醒 ──────────────────────────────────────────────────────

    def _maybe_wake_agent(self, thread_id: str) -> None:
        """If the Agent's thread has no active run, trigger a wake.

        Debounced: at most once per MONITOR_WAKE_DEBOUNCE_SECONDS per thread.
        Only sets debounce key when actually triggering a wake — avoids blocking
        future wakes if the agent was active at check time.
        """
        debounce_key = _wake_debounce_key(thread_id)
        try:
            if self._is_thread_active(thread_id):
                return

            acquired = self.redis.set(
                debounce_key, "1", nx=True, ex=MONITOR_WAKE_DEBOUNCE_SECONDS,
            )
            if not acquired:
                return

            self._trigger_agent_wake(thread_id)
        except Exception as exc:
            logger.debug("[MonitorService] _maybe_wake_agent error: %s", exc)

    def _is_thread_active(self, thread_id: str) -> bool:
        """Check if there's an active run lock for this thread."""
        from apps.services.agent_engine.services.message_queue_service import MessageQueueService

        lock_key = MessageQueueService._lock_key(thread_id)
        try:
            return bool(self.redis.exists(lock_key))
        except Exception:
            return True

    def _trigger_agent_wake(self, thread_id: str) -> None:
        """Enqueue a system-level wake message for the thread.

        Uses the same MessageQueueService enqueue path that user messages use,
        so the frontend queue processor (or backend run loop) picks it up and
        starts a new inference turn.
        """
        from apps.services.agent_engine.services.message_queue_service import MessageQueueService

        svc = MessageQueueService()
        wake_payload = json.dumps({
            "type": "monitor_wake",
            "thread_id": thread_id,
            "timestamp": time.time(),
        })
        queue_key = svc._queue_key(thread_id)
        try:
            self.redis.rpush(queue_key, wake_payload)
            self.redis.expire(queue_key, 3600)
            logger.info("[MonitorService] Triggered agent wake for thread=%s", thread_id)
        except Exception as exc:
            logger.warning("[MonitorService] _trigger_agent_wake failed: %s", exc)

    # ── 序列化 ────────────────────────────────────────────────────────

    @staticmethod
    def _serialize(task) -> Dict[str, Any]:
        return {
            "monitor_id": str(task.monitor_id),
            "thread_id": task.thread_id,
            "command": task.command,
            "description": task.description,
            "status": task.status,
            "fail_reason": task.fail_reason,
            "notify_on": task.notify_on,
            "pattern": task.pattern,
            "device_fingerprint": task.device_fingerprint,
            "session_id": task.session_id,
            "parent_subagent_id": str(task.parent_subagent_id) if task.parent_subagent_id else None,
            "working_directory": task.working_directory,
            "created_at": task.created_at.isoformat() if task.created_at else None,
        }


# ── 单例 ──────────────────────────────────────────────────────────────

_instance: Optional[MonitorService] = None


def get_monitor_service() -> MonitorService:
    global _instance
    if _instance is None:
        _instance = MonitorService()
    return _instance

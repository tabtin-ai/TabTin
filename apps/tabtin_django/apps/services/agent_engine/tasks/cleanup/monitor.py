"""
Monitor Cleanup Tasks — 心跳超时检测与僵尸 Monitor 清理

Celery Beat 定期执行，检测无心跳的 Monitor 并标记为 failed。
"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(bind=True, ignore_result=True, time_limit=60, soft_time_limit=50)
def check_monitor_heartbeats(self):
    """Check for stale monitors and mark them as device_disconnected.

    Runs every 60 seconds via Celery Beat.
    """
    from apps.services.agent_engine.services.monitor_service import get_monitor_service

    try:
        svc = get_monitor_service()
        marked = svc.check_heartbeat_timeouts()
        if marked > 0:
            logger.info("[MonitorCleanup] Marked %d monitors as disconnected", marked)
        return {"success": True, "marked": marked}
    except Exception as exc:
        logger.error("[MonitorCleanup] check_monitor_heartbeats failed: %s", exc, exc_info=True)
        return {"success": False, "error": str(exc)}


MONITOR_BEAT_SCHEDULE = {
    "check-monitor-heartbeats": {
        "task": "apps.services.agent_engine.tasks.cleanup.monitor.check_monitor_heartbeats",
        "schedule": 60.0,
        "options": {"queue": "default"},
    },
}

"""
Multiagent Trace Cleanup Tasks
"""

from datetime import timedelta
import logging
from celery import shared_task
from celery.schedules import crontab
from django.utils import timezone

from apps.services.agent_engine.models import ExecutionTrace

logger = logging.getLogger(__name__)

_DELETE_BATCH_SIZE = 500


_DEFAULT_TRACE_RETENTION_DAYS = 14


@shared_task(bind=True, ignore_result=True, time_limit=600, soft_time_limit=560)
def cleanup_expired_agent_traces(self, retention_days: int | None = None):
    """清理过期的 Agent Trace 数据（分批删除避免长事务和级联风暴）。

    `retention_days` 优先级：调用方显式传参 > EngineRuntimeConfig 单例 > 14（默认）。
    宪法 v0.1 §5.8：清理策略字段 `cleanup_trace_retention_days` 已从旧
    chat 全局配置 迁入 EngineRuntimeConfig（pk=1 单例）。
    """
    try:
        if retention_days is None:
            try:
                from apps.chat.conversation.models import EngineRuntimeConfig
                config = EngineRuntimeConfig.objects.filter(pk=1).first()
                retention_days = (
                    config.cleanup_trace_retention_days
                    if config and config.cleanup_trace_retention_days
                    else _DEFAULT_TRACE_RETENTION_DAYS
                )
            except Exception:
                retention_days = _DEFAULT_TRACE_RETENTION_DAYS

        cutoff = timezone.now() - timedelta(days=retention_days)
        total_deleted = 0

        while True:
            batch_ids = list(
                ExecutionTrace.objects.filter(started_at__lt=cutoff)
                .values_list('id', flat=True)[:_DELETE_BATCH_SIZE]
            )
            if not batch_ids:
                break
            deleted, _ = ExecutionTrace.objects.filter(id__in=batch_ids).delete()
            total_deleted += deleted

        logger.info("[ExecutionTrace] Expired trace cleanup completed: deleted=%s cutoff=%s", total_deleted, cutoff)
        return {"success": True, "deleted": total_deleted}
    except Exception as exc:
        logger.error("[ExecutionTrace] Trace cleanup failed: %s", exc, exc_info=True)
        return {"success": False, "error": str(exc)}


TRACE_BEAT_SCHEDULE = {
    "cleanup-agent-traces": {
        "task": "apps.services.agent_engine.tasks.cleanup.trace.cleanup_expired_agent_traces",
        "schedule": crontab(hour=4, minute=10),
        "options": {"expires": 3600},
    }
}

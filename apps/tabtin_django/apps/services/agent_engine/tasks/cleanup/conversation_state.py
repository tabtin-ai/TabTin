"""
ConversationState 定期清理 — 删除长期未活跃的对话状态记录。
"""

import logging
from datetime import timedelta

from celery import shared_task
from celery.schedules import crontab
from django.utils import timezone

from apps.services.agent_engine.models import ConversationState

logger = logging.getLogger(__name__)

_DELETE_BATCH_SIZE = 500
_DEFAULT_RETENTION_DAYS = 90
_MAX_TOTAL_DELETED = 50_000


@shared_task(
    bind=True,
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
)
def cleanup_stale_conversation_states(self, retention_days: int = _DEFAULT_RETENTION_DAYS):
    """删除超过 retention_days 未更新的 ConversationState 记录（分批删除）"""
    from celery.exceptions import SoftTimeLimitExceeded

    cutoff = timezone.now() - timedelta(days=retention_days)
    total_deleted = 0

    try:
        while total_deleted < _MAX_TOTAL_DELETED:
            batch_ids = list(
                ConversationState.objects.using("postgresql")
                .filter(updated_at__lt=cutoff)
                .values_list("id", flat=True)[:_DELETE_BATCH_SIZE]
            )
            if not batch_ids:
                break
            deleted, _ = (
                ConversationState.objects.using("postgresql")
                .filter(id__in=batch_ids)
                .delete()
            )
            total_deleted += deleted
    except SoftTimeLimitExceeded:
        logger.warning(
            "[ConversationState] Cleanup interrupted by SoftTimeLimitExceeded: "
            "deleted=%d so far, cutoff=%s — will continue next schedule",
            total_deleted, cutoff,
        )
        return {"success": True, "deleted": total_deleted, "interrupted": True}

    if total_deleted:
        logger.info(
            "[ConversationState] Cleanup completed: deleted=%d cutoff=%s",
            total_deleted, cutoff,
        )
    return {"success": True, "deleted": total_deleted}


CONVERSATION_STATE_BEAT_SCHEDULE = {
    "cleanup-stale-conversation-states": {
        "task": "apps.services.agent_engine.tasks.cleanup.conversation_state.cleanup_stale_conversation_states",
        "schedule": crontab(hour=4, minute=30),
        "options": {"expires": 3600},
    },
}

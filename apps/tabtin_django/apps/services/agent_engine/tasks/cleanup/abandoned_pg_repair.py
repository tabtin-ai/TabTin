"""修复 cleanup abandoned 后 PG messages_json 与 MySQL 不一致的会话。"""

import logging
from celery import shared_task
from celery.schedules import crontab

logger = logging.getLogger(__name__)


@shared_task(name="repair_abandoned_pg_states", bind=True, max_retries=0)
def repair_abandoned_pg_states(self):
    from apps.chat.conversation.models import ChatSession
    from apps.services.agent_engine.models import ConversationState

    repaired = 0
    failed = 0

    sessions = ChatSession.objects.filter(
        revert_history__isnull=False,
    ).exclude(revert_history=[]).only('id', 'thread_id', 'revert_history')

    for session in sessions:
        if not session.thread_id:
            continue

        history = list(session.revert_history or [])
        has_abandoned = any(
            e.get('type') == 'cleanup' and e.get('cleanup_status') == 'abandoned'
            for e in history
        )
        has_repaired = any(
            e.get('type') == 'cleanup' and e.get('cleanup_status') == 'repaired'
            for e in history
        )
        if not has_abandoned or has_repaired:
            continue

        try:
            mysql_count = session.messages.exclude(role='system').count()

            conv_state = ConversationState.objects.using('postgresql').filter(
                thread_id=session.thread_id
            ).first()
            if not conv_state or not isinstance(conv_state.messages_json, list):
                continue

            pg_count = len(conv_state.messages_json)

            if pg_count <= mysql_count * 2 + 5:
                continue

            target_len = mysql_count * 2
            if target_len < pg_count:
                conv_state.messages_json = conv_state.messages_json[:target_len]
                conv_state.save(using='postgresql', update_fields=['messages_json'])

                from django.utils import timezone
                session.append_revert_history({
                    'type': 'cleanup',
                    'cleanup_status': 'repaired',
                    'pg_truncated_from': pg_count,
                    'pg_truncated_to': target_len,
                    'created_at': timezone.now().isoformat(),
                })
                session.save(update_fields=['revert_history', 'updated_at'])
                repaired += 1
                logger.info("repair_abandoned_pg_states: repaired session=%s pg=%d->%d", session.id, pg_count, target_len)
        except Exception:
            failed += 1
            logger.warning("repair_abandoned_pg_states: failed for session=%s", session.id, exc_info=True)

    logger.info("repair_abandoned_pg_states: done repaired=%d failed=%d", repaired, failed)
    return {'repaired': repaired, 'failed': failed}


ABANDONED_PG_REPAIR_BEAT_SCHEDULE = {
    "repair-abandoned-pg-states": {
        "task": "repair_abandoned_pg_states",
        "schedule": crontab(hour=3, minute=0),
        "options": {"expires": 3600},
    },
}

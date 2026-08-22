"""
WS event buffer maintenance tasks.
"""

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(name="ws.trim_event_buffers", ignore_result=True, time_limit=90, soft_time_limit=75)
def trim_event_buffers():
    """
    Periodic task: trim expired entries from all ``ws:evt:*`` Redis Streams.

    Runs every 60 seconds via Celery beat. Uses XTRIM MINID to remove events
    older than each topic's configured ``max_age_seconds``, refreshes key TTL,
    and unlinks empty streams .
    """
    from .event_buffer import get_event_buffer

    try:
        trimmed = get_event_buffer().trim_expired()
        if trimmed > 0:
            logger.info("[WS EventBuffer] trimmed %d expired stream entries", trimmed)
    except Exception as exc:
        logger.warning("[WS EventBuffer] trim task failed: %s", exc)


# Celery beat schedule entry — merged into get_beat_schedule() in celery.py
WS_BEAT_SCHEDULE = {
    "ws-trim-event-buffers": {
        "task": "ws.trim_event_buffers",
        "schedule": 60.0,
        "options": {"expires": 50},
    },
}

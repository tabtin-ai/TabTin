"""Tins background tasks."""

from __future__ import annotations

import logging
from datetime import timedelta

from celery import shared_task

logger = logging.getLogger(__name__)

TINS_BEAT_SCHEDULE = {
    "tins-cleanup-run-logs": {
        "task": "tins.cleanup_run_logs",
        "schedule": timedelta(hours=12),
        "options": {"expires": 600, "queue": "default"},
    },
}


@shared_task(name="tins.cleanup_run_logs", ignore_result=True, time_limit=660, soft_time_limit=600)
def cleanup_run_logs(retention_days: int = 30) -> dict:
    """Purge TinRunLog records older than *retention_days* in batches."""
    import time

    from django.utils import timezone

    from apps.tins.models import TinRunLog

    cutoff = timezone.now() - timedelta(days=retention_days)
    batch_size = 1000
    max_batches = 500
    deleted_total = 0

    for _ in range(max_batches):
        ids = list(
            TinRunLog.objects.filter(created_at__lt=cutoff)
            .values_list("id", flat=True)[:batch_size]
        )
        if not ids:
            break
        count, _ = TinRunLog.objects.filter(id__in=ids).delete()
        deleted_total += count
        time.sleep(0.05)

    if deleted_total:
        logger.info("Cleaned up %d TinRunLog records older than %d days", deleted_total, retention_days)

    return {"deleted": deleted_total, "retention_days": retention_days}

"""
客户端错误监控 - 定时清理任务
"""

from __future__ import annotations

import logging
from datetime import timedelta

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from celery.schedules import crontab
from django.db import models
from django.db.models import Count
from django.utils import timezone

logger = logging.getLogger(__name__)

_BATCH_SIZE = 5000


@shared_task(
    bind=True,
    max_retries=1,
    default_retry_delay=120,
    ignore_result=True,
    time_limit=900,
    soft_time_limit=840,
)
def cleanup_old_client_errors(self, retention_days: int = 30) -> dict:
    """清理过期的客户端错误事件和空分组。分批删除防止锁表。"""
    from .models import ClientErrorEvent, ClientErrorGroup

    cutoff = timezone.now() - timedelta(days=retention_days)
    deleted_events = 0
    stale_count = 0
    deleted_sourcemaps = 0

    try:
        # 分批删除过期事件
        while True:
            ids = list(
                ClientErrorEvent.objects.using("postgresql")
                .filter(occurred_at__lt=cutoff)
                .values_list("id", flat=True)[:_BATCH_SIZE]
            )
            if not ids:
                break
            ClientErrorEvent.objects.using("postgresql").filter(id__in=ids).delete()
            deleted_events += len(ids)

        # 删除没有关联事件的分组（含过期空分组）
        stale_count, _ = (
            ClientErrorGroup.objects.using("postgresql")
            .filter(last_seen__lt=cutoff)
            .filter(events__isnull=True)
            .delete()
        )

        # 重算存活分组的 event_count 和 user_count（防止累计值与实际事件数偏移）
        if deleted_events > 0:
            surviving_groups = (
                ClientErrorGroup.objects.using("postgresql")
                .annotate(
                    real_event_count=Count("events"),
                    real_user_count=Count("events__user_id", distinct=True),
                )
                .exclude(real_event_count=models.F("event_count"))
            )
            recalc_count = 0
            for g in surviving_groups.iterator():
                ClientErrorGroup.objects.using("postgresql").filter(pk=g.pk).update(
                    event_count=g.real_event_count,
                    user_count=g.real_user_count or 1,
                )
                recalc_count += 1
            if recalc_count > 0:
                logger.info("[ClientErrors] 重算了 %d 个分组的计数", recalc_count)

        # 清理 90 天前的旧版本 SourceMap（保留比事件更久，方便回查）
        from .models import SourceMapFile

        sourcemap_cutoff = timezone.now() - timedelta(days=90)
        deleted_sourcemaps, _ = (
            SourceMapFile.objects.using("postgresql")
            .filter(uploaded_at__lt=sourcemap_cutoff)
            .delete()
        )
    except SoftTimeLimitExceeded:
        logger.warning(
            "[ClientErrors] cleanup_old_client_errors 超时，已完成部分清理: "
            "deleted_events=%d deleted_groups=%d deleted_sourcemaps=%d",
            deleted_events, stale_count, deleted_sourcemaps,
        )
        return {
            "deleted_events": deleted_events,
            "deleted_groups": stale_count,
            "deleted_sourcemaps": deleted_sourcemaps,
            "retention_days": retention_days,
            "partial": True,
        }

    if deleted_events > 0 or stale_count > 0 or deleted_sourcemaps > 0:
        logger.info(
            "[ClientErrors] 清理完成: 删除 %d 条事件, %d 个分组, %d 个SourceMap (事件保留 %d 天, SourceMap 保留 90 天)",
            deleted_events, stale_count, deleted_sourcemaps, retention_days,
        )

    return {
        "deleted_events": deleted_events,
        "deleted_groups": stale_count,
        "deleted_sourcemaps": deleted_sourcemaps,
        "retention_days": retention_days,
    }


CLIENT_ERRORS_BEAT_SCHEDULE = {
    "cleanup-old-client-errors": {
        "task": "apps.client_errors.tasks.cleanup_old_client_errors",
        "schedule": crontab(hour=4, minute=30),
        "kwargs": {"retention_days": 30},
        "options": {"expires": 3600},
    },
}

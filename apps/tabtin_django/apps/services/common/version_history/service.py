"""
HistoryServiceBase — 版本历史服务基类

提供通用的版本历史操作：
- should_create_snapshot()  判断是否需要创建全量锚点
- cleanup_expired()         清理过期版本
- downsample()              分级降采样

子类需实现：
- _get_history_queryset(resource)  返回资源关联的 History QuerySet
- _get_db_alias()                  返回数据库别名（默认 "postgresql"）
"""
import logging
from datetime import timedelta
from typing import Optional

from django.db import transaction
from django.db.models import Count, QuerySet
from django.db.models.functions import TruncDay, TruncHour
from django.utils import timezone

from .constants import (
    HISTORY_MIN_INTERVAL,
    HISTORY_SNAPSHOT_INTERVAL,
    HISTORY_SNAPSHOT_MAX_AGE,
)

logger = logging.getLogger("version_history.service")


class HistoryServiceBase:
    """版本历史操作通用基类"""

    def _get_db_alias(self) -> str:
        return "postgresql"

    def should_create_snapshot(
        self,
        history_qs: QuerySet,
        *,
        force: bool = False,
    ) -> bool:
        """
        判断是否应创建全量快照（而非增量 diff）。

        返回 True 的条件:
        - force=True
        - 尚无任何快照（首次）
        - 自上次快照的 diff 数 >= HISTORY_SNAPSHOT_INTERVAL
        - 距上次快照 >= HISTORY_SNAPSHOT_MAX_AGE 秒
        """
        if force:
            return True

        db = self._get_db_alias()
        last_snapshot = (
            history_qs.using(db)
            .filter(is_snapshot=True)
            .order_by("-created_at")
            .first()
        )

        if not last_snapshot:
            return True

        diff_count = (
            history_qs.using(db)
            .filter(is_snapshot=False, created_at__gt=last_snapshot.created_at)
            .count()
        )
        if diff_count >= HISTORY_SNAPSHOT_INTERVAL:
            return True

        elapsed = (timezone.now() - last_snapshot.created_at).total_seconds()
        if elapsed >= HISTORY_SNAPSHOT_MAX_AGE:
            return True

        return False

    def is_too_recent(self, history_qs: QuerySet) -> bool:
        """如果距上次 History < HISTORY_MIN_INTERVAL，返回 True（应跳过）。"""
        db = self._get_db_alias()
        last = history_qs.using(db).order_by("-created_at").first()
        if not last:
            return False
        return (timezone.now() - last.created_at).total_seconds() < HISTORY_MIN_INTERVAL

    def find_last_snapshot(self, history_qs: QuerySet):
        """查找最近的全量快照。"""
        db = self._get_db_alias()
        return (
            history_qs.using(db)
            .filter(is_snapshot=True)
            .order_by("-created_at")
            .first()
        )

    def cleanup_expired(self, history_model) -> int:
        """
        清理过期的历史记录。

        保护：
        - 命名版本（is_named=True）
        - 置顶版本（pinned=True）
        - 被增量 diff 引用的全量锚点

        使用 transaction.atomic + select_for_update(skip_locked=True)
        确保 referenced_ids 快照与 delete 的原子性，
        避免与 downsample 的 TOCTOU 竞态。
        """
        db = self._get_db_alias()
        now = timezone.now()

        with transaction.atomic(using=db):
            expired_qs = history_model.objects.using(db).filter(
                expired_at__lt=now,
                is_named=False,
                pinned=False,
            ).select_for_update(skip_locked=True)

            referenced_ids = set(
                history_model.objects.using(db).filter(
                    base_history__isnull=False,
                ).values_list("base_history_id", flat=True)
            )

            if referenced_ids:
                expired_qs = expired_qs.exclude(id__in=referenced_ids)

            count = expired_qs.count()
            if count > 0:
                expired_qs.delete()

        return count

    def downsample(self, history_model) -> int:
        """
        分级降采样。

        策略:
        - 1-7 天前: 每小时保留 1 个
        - 7-30 天前: 每天保留 1 个
        """
        now = timezone.now()
        total = 0

        total += self._downsample_range(
            history_model,
            now - timedelta(days=7),
            now - timedelta(days=1),
            "hour",
        )
        total += self._downsample_range(
            history_model,
            now - timedelta(days=30),
            now - timedelta(days=7),
            "day",
        )
        return total

    def _downsample_range(
        self,
        history_model,
        start,
        end,
        truncate_to: str,
    ) -> int:
        db = self._get_db_alias()

        qs = history_model.objects.using(db).filter(
            created_at__gte=start,
            created_at__lt=end,
            is_named=False,
            pinned=False,
        )

        if not qs.exists():
            return 0

        TruncFunc = TruncHour if truncate_to == "hour" else TruncDay

        # 需要一个可分组的资源字段名。通过子类不同的 FK 名来分组。
        # 通用做法：按 (resource FK, bucket) 分组
        # 这里使用通用字段发现：找到第一个 ForeignKey
        resource_field = self._find_resource_field(history_model)
        if not resource_field:
            return 0

        groups = (
            qs.annotate(bucket=TruncFunc("created_at"))
            .values(resource_field, "bucket")
            .annotate(cnt=Count("id"))
            .filter(cnt__gt=1)
        )

        deleted_count = 0
        referenced_ids = set(
            history_model.objects.using(db).filter(
                base_history__isnull=False,
            ).values_list("base_history_id", flat=True)
        )

        for group in groups:
            bucket_qs = qs.filter(
                **{resource_field: group[resource_field]},
            ).annotate(
                bucket=TruncFunc("created_at"),
            ).filter(
                bucket=group["bucket"],
            )

            keep_id = (
                bucket_qs.order_by("-created_at", "-id")
                .values_list("id", flat=True)
                .first()
            )

            to_delete = bucket_qs.exclude(id=keep_id)
            if referenced_ids:
                to_delete = to_delete.exclude(id__in=referenced_ids)

            cnt = to_delete.count()
            if cnt > 0:
                to_delete.delete()
                deleted_count += cnt

        return deleted_count

    @staticmethod
    def _find_resource_field(model) -> Optional[str]:
        """找到 History Model 上的资源 FK 字段名（如 document_id, project_id, file_id）。"""
        from django.db.models import ForeignKey

        for field in model._meta.get_fields():
            if isinstance(field, ForeignKey) and field.name not in ("base_history",):
                if field.related_model != model:
                    return f"{field.name}_id"
        return None

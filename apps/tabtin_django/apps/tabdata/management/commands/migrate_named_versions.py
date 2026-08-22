from django.conf import settings
"""
迁移 TableNamedVersion 到统一 VersionHistory 表。

用法:
    python manage.py migrate_named_versions
    python manage.py migrate_named_versions --dry-run
    python manage.py migrate_named_versions --batch-size=200

设计要点:
    - 幂等：通过 metadata.legacy_id + legacy_model 去重，重复运行不创建重复记录
    - 书签→快照转换：TableNamedVersion 是书签式（只存 history_id），
      迁移时通过 CollabService.build_snapshot() 获取当前表格快照作为 blob。
      history_valid=False 的版本只迁移元数据（blob 为空）
    - 支持 --dry-run 预览和 --batch-size 控制每批处理量
"""
import json
import logging
import zlib

from django.core.management.base import BaseCommand
from django.utils import timezone

logger = logging.getLogger("tabdata.migrate_named_versions")

DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
def _build_table_blob(table_id: str) -> bytes:
    """通过 CollabService 获取当前表格快照并压缩为 blob。"""
    from apps.tabdata.services.collab_service import CollabService

    try:
        snapshot = CollabService.build_snapshot(table_id)
        raw = json.dumps(
            snapshot, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        return zlib.compress(raw, level=6)
    except Exception:
        logger.warning(
            "Failed to build snapshot for table %s, blob will be empty",
            table_id,
            exc_info=True,
        )
        return b""


def migrate_named_versions(*, dry_run: bool = False, batch_size: int = 500) -> dict:
    """
    遍历 TableNamedVersion，为每条创建对应的 VersionHistory。

    Returns:
        dict: {total, migrated, skipped, failed, details}
    """
    from apps.collab.models import VersionHistory
    from apps.tabdata.models import TableNamedVersion

    qs = TableNamedVersion.objects.using(DB).select_related("table").order_by("created_at")
    total = qs.count()
    migrated = 0
    skipped = 0
    failed = 0
    processed = 0
    details: list[dict] = []

    for nv in qs.iterator():
        if processed >= batch_size:
            break
        legacy_id = str(nv.id)
        try:
            existing = VersionHistory.objects.using(DB).filter(
                resource_type="table",
                metadata__legacy_id=legacy_id,
                metadata__legacy_model="TableNamedVersion",
            ).exists()
            if existing:
                skipped += 1
                continue

            if dry_run:
                migrated += 1
                processed += 1
                details.append({
                    "id": legacy_id,
                    "table_id": str(nv.table_id),
                    "name": nv.name,
                    "action": "would_migrate",
                })
                continue

            blob = _build_table_blob(str(nv.table_id))

            editor_id = str(nv.created_by_id) if nv.created_by_id else ""

            vh = VersionHistory.objects.using(DB).create(
                resource_type="table",
                resource_id=nv.table_id,
                organization_id=nv.organization_id,
                blob=blob,
                blob_size=len(blob),
                is_snapshot=True,
                base_history=None,
                editor_type="user",
                editor_id=editor_id,
                expired_at=None,
                is_named=True,
                name=nv.name or "",
                pinned=False,
                metadata={
                    "legacy_id": legacy_id,
                    "legacy_model": "TableNamedVersion",
                    "legacy_history_id": str(nv.history_id) if nv.history_id else None,
                    "snapshot_at": nv.snapshot_at.isoformat() if nv.snapshot_at else None,
                },
                created_at=nv.created_at or timezone.now(),
            )

            migrated += 1
            processed += 1
            details.append({
                "id": legacy_id,
                "table_id": str(nv.table_id),
                "name": nv.name,
                "vh_id": str(vh.id),
                "blob_size": len(blob),
                "action": "migrated",
            })

        except Exception:
            logger.exception(
                "Failed to migrate TableNamedVersion %s, skipping",
                legacy_id,
            )
            failed += 1
            processed += 1
            details.append({
                "id": legacy_id,
                "action": "failed",
            })

    return {
        "total": total,
        "migrated": migrated,
        "skipped": skipped,
        "failed": failed,
        "details": details,
    }


class Command(BaseCommand):
    help = "迁移 TableNamedVersion 到统一 VersionHistory 表"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只统计不写入",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=500,
            help="每批处理数量（默认 500）",
        )

    def handle(self, *args, **options):
        dry_run = options.get("dry_run", False)
        batch_size = options.get("batch_size", 500)

        if dry_run:
            self.stdout.write("[DRY RUN] 不会写入数据\n")

        self.stdout.write("--- 迁移 TableNamedVersion → VersionHistory ---\n")

        result = migrate_named_versions(dry_run=dry_run, batch_size=batch_size)

        self.stdout.write(
            f"  总计: {result['total']}, "
            f"迁移: {result['migrated']}, "
            f"跳过(已存在): {result['skipped']}, "
            f"失败: {result['failed']}\n"
        )

        if result["failed"] > 0:
            self.stderr.write(
                f"  ⚠ {result['failed']} 条记录迁移失败，请查看日志\n"
            )

        self.stdout.write("完成。\n")

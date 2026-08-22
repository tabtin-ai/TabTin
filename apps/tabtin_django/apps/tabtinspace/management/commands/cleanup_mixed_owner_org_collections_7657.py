"""#7657：Organization 云盘文件夹私有化清理（无主 + 跨创建者嵌套，保资源）。

发布路径以 migration ``0133_collection_privacy_cleanup_7657`` 为准
（``safe_migrate`` 自动执行）。本命令用于 dry-run / 补跑 / 单 org 审计。

用法::

    python manage.py cleanup_mixed_owner_org_collections_7657 --dry-run
    python manage.py cleanup_mixed_owner_org_collections_7657
    python manage.py cleanup_mixed_owner_org_collections_7657 --organization-id <uuid>
"""
from __future__ import annotations

import csv
from pathlib import Path

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.services.collection_mixed_owner_cleanup import (
    assert_no_null_owner_org_collections,
    cleanup_org_collection_privacy_7657,
)


class Command(BaseCommand):
    help = (
        "清理 org 云盘无主文件夹与跨创建者嵌套；资源先移到云盘根。"
        "正式发布由 migration 0133 自动执行。"
    )

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="预览模式，不写库")
        parser.add_argument("--organization-id", type=str, default=None)
        parser.add_argument(
            "--audit-path",
            type=str,
            default="",
            help="审计 CSV 路径；缺省写到 logs/",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        organization_id = options.get("organization_id")
        audit_path = options.get("audit_path") or ""

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY-RUN] 预览模式，不会执行修改"))

        alias = postgres_app_db_alias()
        with transaction.atomic(using=alias):
            stats = cleanup_org_collection_privacy_7657(
                organization_id=organization_id,
                dry_run=dry_run,
                batch_log=lambda msg: self.stdout.write(msg),
            )
            if dry_run:
                transaction.set_rollback(True, using=alias)

        if stats.audit_rows:
            path = self._write_audit(stats.audit_rows, audit_path)
            self.stdout.write(
                self.style.WARNING(f"审计清单: {path} ({len(stats.audit_rows)} 条)")
            )

        remaining_null = assert_no_null_owner_org_collections(
            organization_id=organization_id,
        )
        self.stdout.write(
            self.style.SUCCESS(
                "完成: "
                f"null_scanned={stats.null_owner_scanned} "
                f"null_deleted={stats.null_owner_folders_deleted} "
                f"owned_reparented={stats.owned_reparented} "
                f"mixed_topmost={stats.topmost_roots} "
                f"folders_deleted={stats.folders_deleted} "
                f"items_detached={stats.items_detached} "
                f"orphan_items_detached={stats.orphan_items_detached} "
                f"skipped={stats.skipped} "
                f"remaining_null_owner={remaining_null}"
            )
        )
        if not dry_run and remaining_null:
            raise SystemExit(
                f"#7657 gate failed: {remaining_null} org Collection still "
                "have created_by IS NULL"
            )

    def _write_audit(self, rows: list[dict], audit_path: str) -> Path:
        if audit_path:
            path = Path(audit_path)
        else:
            stamp = timezone.now().strftime("%Y%m%d-%H%M%S")
            path = Path("logs") / f"org-collection-privacy-7657-{stamp}.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        fieldnames = [
            "collection_id",
            "name",
            "organization_id",
            "created_by_id",
            "parent_created_by_id",
            "subtree_folder_count",
            "items_detached",
            "orphan_items_detached",
            "reason",
        ]
        with path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        return path

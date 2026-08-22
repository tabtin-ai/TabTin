"""#7140：把因云资产引用而"该属于组织"的历史 Collection 树收敛到 organization。

用法::

    python manage.py backfill_cloud_collection_org_host_7140 --dry-run
    python manage.py backfill_cloud_collection_org_host_7140
    python manage.py backfill_cloud_collection_org_host_7140 --organization-id <uuid>
"""

from __future__ import annotations

import csv
from pathlib import Path

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.services.cloud_collection_org_rehost import (
    rehost_cloud_collections_to_organization,
)


class Command(BaseCommand):
    help = "把被云资产引用的 legacy workspace/project Collection 树收敛到 organization 宿主"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="预览模式，不写库")
        parser.add_argument("--organization-id", type=str, default=None)
        parser.add_argument(
            "--audit-path",
            type=str,
            default="",
            help="无法解析 org 的候选根文件夹审计 CSV；缺省写到 logs/",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        organization_id = options.get("organization_id")
        audit_path = options.get("audit_path") or ""

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY-RUN] 预览模式，不会执行修改"))

        alias = postgres_app_db_alias()
        with transaction.atomic(using=alias):
            stats = rehost_cloud_collections_to_organization(
                organization_id=organization_id,
                dry_run=dry_run,
                batch_log=lambda msg: self.stdout.write(msg),
            )
            if dry_run:
                transaction.set_rollback(True, using=alias)

        if stats.audit_rows:
            path = self._write_audit(stats.audit_rows, audit_path)
            self.stdout.write(
                self.style.WARNING(f"跳过项审计清单: {path} ({len(stats.audit_rows)} 条)")
            )

        self.stdout.write(
            self.style.SUCCESS(
                "完成: "
                f"scanned={stats.scanned} rehosted={stats.rehosted} "
                f"renamed={stats.renamed} "
                f"items_rehosted={stats.items_rehosted} "
                f"items_deduped_deleted={stats.items_deduped_deleted} "
                f"created_by_filled={stats.created_by_filled} "
                f"skipped_no_org={stats.skipped_no_org}"
            )
        )

    def _write_audit(self, rows: list[dict], audit_path: str) -> Path:
        if audit_path:
            path = Path(audit_path)
        else:
            stamp = timezone.now().strftime("%Y%m%d-%H%M%S")
            path = Path("logs") / f"cloud-collection-org-host-7140-{stamp}.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(
                fh,
                fieldnames=["collection_id", "name", "organization_id", "reason"],
            )
            writer.writeheader()
            writer.writerows(rows)
        return path

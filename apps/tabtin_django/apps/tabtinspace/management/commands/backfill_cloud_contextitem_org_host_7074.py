"""#7074：历史云资产 ContextItem 宿主收敛到 organization_id。

用法::

    python manage.py backfill_cloud_contextitem_org_host_7074 --dry-run
    python manage.py backfill_cloud_contextitem_org_host_7074
    python manage.py backfill_cloud_contextitem_org_host_7074 --organization-id <uuid>
"""

from __future__ import annotations

import csv
from pathlib import Path

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.services.cloud_org_host_rehost import rehost_legacy_cloud_context_items


class Command(BaseCommand):
    help = "把 legacy workspace/project 云资产 ContextItem 收敛到 organization 宿主"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="预览模式，不写库")
        parser.add_argument("--organization-id", type=str, default=None)
        parser.add_argument(
            "--audit-path",
            type=str,
            default="",
            help="无法解析 org / 缺 resource 的审计 CSV；缺省写到 logs/",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        organization_id = options.get("organization_id")
        audit_path = options.get("audit_path") or ""

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY-RUN] 预览模式，不会执行修改"))

        alias = postgres_app_db_alias()
        with transaction.atomic(using=alias):
            stats = rehost_legacy_cloud_context_items(
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
                f"deduped_deleted={stats.deduped_deleted} "
                f"created_by_filled={stats.created_by_filled} "
                f"skipped_no_org={stats.skipped_no_org} "
                f"skipped_no_resource_id={stats.skipped_no_resource_id}"
            )
        )

    def _write_audit(self, rows: list[dict], audit_path: str) -> Path:
        if audit_path:
            path = Path(audit_path)
        else:
            stamp = timezone.now().strftime("%Y%m%d-%H%M%S")
            path = Path("logs") / f"cloud-contextitem-org-host-7074-{stamp}.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(
                fh,
                fieldnames=[
                    "item_type",
                    "context_item_id",
                    "resource_id",
                    "organization_id",
                    "title",
                    "reason",
                ],
            )
            writer.writeheader()
            writer.writerows(rows)
        return path

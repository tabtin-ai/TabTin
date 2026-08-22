"""#6863：回填云盘资源 owner，收紧默认私有，不自动扩权。

策略（宁可收紧、不猜测共享）：
1. tabfiles：ContextItem.created_by 为空时，用 FileRecord.upload_user 回填；
2. tabdoc：Document.owner_id 为空时，用 DocumentPermission(owner) / created_by / ContextItem.created_by；
3. tabdata：Table.owner_id 为空时，用 ContextItem.created_by；
4. 仍无法确定 owner 的资源写入审计清单，保持不可见，**不**给组织成员 grant。

用法::

    python manage.py backfill_cloud_resource_owners_6863 --dry-run
    python manage.py backfill_cloud_resource_owners_6863
    python manage.py backfill_cloud_resource_owners_6863 --organization-id <uuid>
"""

from __future__ import annotations

import csv
import logging
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import ContextItem

logger = logging.getLogger(__name__)
User = get_user_model()


class Command(BaseCommand):
    help = "回填云盘资源 owner，无法确定的项仅产出审计清单"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="预览模式，不写库")
        parser.add_argument("--organization-id", type=str, default=None)
        parser.add_argument(
            "--audit-path",
            type=str,
            default="",
            help="无主资源审计 CSV 路径；缺省写到 logs/",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        organization_id = options.get("organization_id")
        audit_path = options.get("audit_path") or ""

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY-RUN] 预览模式，不会执行修改"))

        stats = {
            "files_fixed": 0,
            "docs_fixed": 0,
            "tables_fixed": 0,
            "orphan_files": 0,
            "orphan_docs": 0,
            "orphan_tables": 0,
        }
        orphans: list[dict] = []

        alias = postgres_app_db_alias()
        with transaction.atomic(using=alias):
            stats["files_fixed"], file_orphans = self._backfill_tabfiles(
                organization_id=organization_id, dry_run=dry_run,
            )
            orphans.extend(file_orphans)
            stats["orphan_files"] = len(file_orphans)

            stats["docs_fixed"], doc_orphans = self._backfill_tabdocs(
                organization_id=organization_id, dry_run=dry_run,
            )
            orphans.extend(doc_orphans)
            stats["orphan_docs"] = len(doc_orphans)

            stats["tables_fixed"], table_orphans = self._backfill_tabdata(
                organization_id=organization_id, dry_run=dry_run,
            )
            orphans.extend(table_orphans)
            stats["orphan_tables"] = len(table_orphans)

            if dry_run:
                transaction.set_rollback(True, using=alias)

        if orphans:
            path = self._write_audit(orphans, audit_path)
            self.stdout.write(self.style.WARNING(f"无主资源审计清单: {path} ({len(orphans)} 条)"))

        self.stdout.write(
            self.style.SUCCESS(
                "完成: "
                f"files_fixed={stats['files_fixed']} docs_fixed={stats['docs_fixed']} "
                f"tables_fixed={stats['tables_fixed']} "
                f"orphans(files/docs/tables)="
                f"{stats['orphan_files']}/{stats['orphan_docs']}/{stats['orphan_tables']}"
            )
        )

    def _backfill_tabfiles(self, *, organization_id, dry_run: bool):
        from apps.services.oss.models import FileRecord

        qs = ContextItem.objects.filter(
            item_type="tabfiles",
            created_by__isnull=True,
            trashed_at__isnull=True,
        ).exclude(status="trashed")
        if organization_id:
            qs = qs.filter(organization_id=organization_id)

        fixed = 0
        orphans: list[dict] = []
        for item in qs.iterator():
            upload_user = (
                FileRecord.objects.filter(id=item.resource_id)
                .values_list("upload_user", flat=True)
                .first()
            )
            owner_id = str(upload_user or "").strip()
            if not owner_id or not User.objects.filter(id=owner_id).exists():
                orphans.append(
                    {
                        "item_type": "tabfiles",
                        "context_item_id": str(item.id),
                        "resource_id": str(item.resource_id or ""),
                        "organization_id": str(item.organization_id or ""),
                        "title": item.title or "",
                        "reason": "missing_created_by_and_upload_user",
                    }
                )
                continue
            self.stdout.write(
                f"  tabfiles item={item.id} <- upload_user={owner_id}"
            )
            if not dry_run:
                ContextItem.objects.filter(id=item.id).update(
                    created_by_id=owner_id,
                    updated_by_id=owner_id,
                )
            fixed += 1
        return fixed, orphans

    def _backfill_tabdocs(self, *, organization_id, dry_run: bool):
        from apps.tabdoc.models import Document, DocumentPermission

        qs = Document.objects.filter(owner_id__isnull=True)
        if organization_id:
            qs = qs.filter(organization_id=organization_id)

        fixed = 0
        orphans: list[dict] = []
        for doc in qs.iterator():
            owner_id = (
                DocumentPermission.objects.filter(
                    document_id=doc.id,
                    subject_type="user",
                    permission="owner",
                    is_active=True,
                )
                .values_list("subject_id", flat=True)
                .first()
            )
            if not owner_id and doc.created_by_id:
                owner_id = str(doc.created_by_id)
            if not owner_id:
                owner_id = (
                    ContextItem.objects.filter(
                        item_type="tabdoc",
                        resource_id=str(doc.id),
                        created_by__isnull=False,
                    )
                    .values_list("created_by_id", flat=True)
                    .first()
                )
            owner_id = str(owner_id or "").strip()
            if not owner_id or not User.objects.filter(id=owner_id).exists():
                orphans.append(
                    {
                        "item_type": "tabdoc",
                        "context_item_id": "",
                        "resource_id": str(doc.id),
                        "organization_id": str(doc.organization_id or ""),
                        "title": getattr(doc, "title", "") or "",
                        "reason": "missing_owner",
                    }
                )
                continue
            self.stdout.write(f"  tabdoc doc={doc.id} <- owner={owner_id}")
            if not dry_run:
                Document.objects.filter(id=doc.id).update(owner_id=owner_id)
                # 确保有显式 owner permission 行（不扩权给他人）
                existing = DocumentPermission.objects.filter(
                    document_id=doc.id,
                    subject_type="user",
                    subject_id=owner_id,
                ).first()
                if existing:
                    if not existing.is_active or existing.permission != "owner":
                        existing.is_active = True
                        existing.permission = "owner"
                        existing.save(update_fields=["is_active", "permission", "updated_at"])
                else:
                    DocumentPermission.objects.create(
                        document_id=doc.id,
                        subject_type="user",
                        subject_id=owner_id,
                        permission="owner",
                        is_active=True,
                        granted_by=owner_id,
                    )
            fixed += 1
        return fixed, orphans

    def _backfill_tabdata(self, *, organization_id, dry_run: bool):
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table

        qs = Table.objects.using(TABDATA_DB_ALIAS).filter(owner_id__isnull=True)
        if organization_id:
            qs = qs.filter(organization_id=organization_id)

        fixed = 0
        orphans: list[dict] = []
        for table in qs.iterator():
            owner_id = (
                ContextItem.objects.filter(
                    item_type="tabdata",
                    resource_id=str(table.id),
                    created_by__isnull=False,
                )
                .values_list("created_by_id", flat=True)
                .first()
            )
            owner_id = str(owner_id or "").strip()
            if not owner_id or not User.objects.filter(id=owner_id).exists():
                orphans.append(
                    {
                        "item_type": "tabdata",
                        "context_item_id": "",
                        "resource_id": str(table.id),
                        "organization_id": str(getattr(table, "organization_id", "") or ""),
                        "title": getattr(table, "name", "") or "",
                        "reason": "missing_owner",
                    }
                )
                continue
            self.stdout.write(f"  tabdata table={table.id} <- owner={owner_id}")
            if not dry_run:
                Table.objects.using(TABDATA_DB_ALIAS).filter(id=table.id).update(
                    owner_id=owner_id,
                )
            fixed += 1
        return fixed, orphans

    def _write_audit(self, orphans: list[dict], audit_path: str) -> Path:
        if audit_path:
            path = Path(audit_path)
        else:
            stamp = timezone.now().strftime("%Y%m%d-%H%M%S")
            path = Path("logs") / f"cloud-resource-orphans-6863-{stamp}.csv"
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
            writer.writerows(orphans)
        return path

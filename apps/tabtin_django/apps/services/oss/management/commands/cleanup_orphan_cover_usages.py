"""
清理 TabDoc 封面历史泄漏的 FileUsage（TD-6）。

在 context_type 不一致 bug 修复前，更换封面时旧封面的 FileUsage 未被正确
deactivate（创建用 document_cover，删除按 document 过滤），导致泄漏。

本命令扫描 module='tabdoc', context_type='document_cover', is_active=True
的 FileUsage，检查对应 Document 的当前封面 URL 是否仍匹配该 FileRecord。
若已更换（不匹配），则 deactivate 并释放计量。

用法:
    python manage.py cleanup_orphan_cover_usages --dry-run
    python manage.py cleanup_orphan_cover_usages
    python manage.py cleanup_orphan_cover_usages --batch-size 500
"""
import logging

from django.core.management.base import BaseCommand
from django.db import transaction
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger("oss.cleanup_cover")


class Command(BaseCommand):
    help = "清理 TabDoc 封面历史泄漏的 FileUsage (TD-6)"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="仅报告，不修改")
        parser.add_argument("--batch-size", type=int, default=1000, help="每批处理数量")

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        batch_size = options["batch_size"]

        from apps.services.oss.models import FileUsage

        usages = (
            FileUsage.objects.filter(
                module="tabdoc",
                context_type="document_cover",
                is_active=True,
            )
            .select_related("file_record")[:batch_size]
        )

        total = 0
        deactivated = 0
        skipped = 0
        errors = 0

        for usage in usages:
            total += 1
            doc_id = usage.context_id
            fr = usage.file_record

            if not fr:
                if not dry_run:
                    usage.deactivate()
                deactivated += 1
                continue

            try:
                from apps.tabdoc.models import Document
                doc = Document.objects.using(postgres_app_db_alias()).filter(id=doc_id).values("cover_image").first()
            except Exception as exc:
                logger.warning("查询 Document 失败: doc_id=%s, err=%s", doc_id, exc)
                errors += 1
                continue

            if not doc:
                if not dry_run:
                    self._deactivate_with_billing(usage, fr)
                deactivated += 1
                logger.info("文档已删除，deactivate: usage=%s, doc=%s", usage.id, doc_id)
                continue

            cover_url = doc.get("cover_image", "") or ""
            file_urls = {fr.access_url or "", fr.cdn_url or ""} - {""}

            if not file_urls.intersection({cover_url}):
                if not dry_run:
                    self._deactivate_with_billing(usage, fr)
                deactivated += 1
                logger.info("封面已更换，deactivate: usage=%s, doc=%s", usage.id, doc_id)
            else:
                skipped += 1

        mode = "[DRY-RUN] " if dry_run else ""
        self.stdout.write(
            f"{mode}扫描 {total} 条 document_cover FileUsage，"
            f"deactivated {deactivated}，skipped {skipped}，errors {errors}"
        )

    @staticmethod
    def _deactivate_with_billing(usage, fr):
        organization_id = str(fr.organization_id or "")
        file_size = int(fr.file_size or 0)
        with transaction.atomic():
            usage.deactivate()
            if organization_id and file_size > 0:
                try:
                    from apps.services.billing.services import OrganizationStorageBillingService
                    OrganizationStorageBillingService.apply_storage_delta(
                        organization_id=organization_id,
                        file_id=str(fr.id),
                        delta_bytes=-file_size,
                        user_id="system",
                        biz_type="td6_cover_cleanup",
                        biz_id=str(usage.id),
                    )
                except Exception as exc:
                    logger.warning("计量释放失败: usage=%s, err=%s", usage.id, exc)

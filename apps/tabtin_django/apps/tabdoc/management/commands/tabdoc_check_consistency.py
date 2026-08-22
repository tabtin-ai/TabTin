"""
检查 TabDoc 四格式一致性：description_binary / json / markdown / plaintext。

用法:
    python manage.py tabdoc_check_consistency
    python manage.py tabdoc_check_consistency --limit 500
    python manage.py tabdoc_check_consistency --fix
"""
import logging
from textwrap import shorten

from django.core.management.base import BaseCommand
from django.db.models import Q
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger("tabdoc.management")


class Command(BaseCommand):
    help = "检查 TabDoc 文档的四格式字段一致性"

    def add_arguments(self, parser):
        parser.add_argument(
            "--limit", type=int, default=1000,
            help="最多扫描的文档数量（默认 1000）",
        )
        parser.add_argument(
            "--fix", action="store_true",
            help="尝试修复不一致的文档（从 json → markdown → plaintext 重新推导）",
        )
        parser.add_argument(
            "--organization", type=str, default=None,
            help="只检查指定 organization_id 的文档",
        )

    def handle(self, *args, **options):
        from apps.tabdoc.models import Document

        limit = options["limit"]
        fix_mode = options["fix"]
        organization_id = options["organization"]

        qs = Document.objects.using(postgres_app_db_alias()).filter(status="active")
        if organization_id:
            qs = qs.filter(organization_id=organization_id)

        qs = qs.only(
            "id", "title", "organization_id", "latest_version",
            "description_binary", "description_json",
            "description_markdown", "description_plaintext",
        ).order_by("-updated_at")[:limit]

        docs = list(qs)
        self.stdout.write(f"扫描 {len(docs)} 篇文档...\n")

        issues = {
            "binary_missing": [],
            "json_empty_but_markdown_exists": [],
            "markdown_empty_but_json_exists": [],
            "plaintext_mismatch": [],
        }
        fixed_count = 0

        for doc in docs:
            has_binary = doc.description_binary is not None and len(bytes(doc.description_binary)) > 0
            has_json = bool(doc.description_json) and doc.description_json != {}
            has_json_content = has_json and bool(doc.description_json.get("content"))
            has_markdown = bool(doc.description_markdown and doc.description_markdown.strip())
            has_plaintext = bool(doc.description_plaintext and doc.description_plaintext.strip())

            doc_ref = f"doc={doc.id} title={shorten(doc.title or '(无标题)', 30)}"

            if (has_json_content or has_markdown) and not has_binary:
                issues["binary_missing"].append(doc_ref)

            if not has_json_content and has_markdown:
                issues["json_empty_but_markdown_exists"].append(doc_ref)

            if has_json_content and not has_markdown:
                issues["markdown_empty_but_json_exists"].append(doc_ref)
                if fix_mode:
                    fixed_count += self._try_fix_markdown(doc)

            if has_markdown and not has_plaintext:
                issues["plaintext_mismatch"].append(doc_ref)
                if fix_mode:
                    fixed_count += self._try_fix_plaintext(doc)

        self.stdout.write("\n===== 检查结果 =====\n")

        total_issues = 0
        for category, doc_list in issues.items():
            count = len(doc_list)
            total_issues += count
            if count > 0:
                self.stdout.write(self.style.WARNING(f"\n{category}: {count} 篇"))
                for ref in doc_list[:10]:
                    self.stdout.write(f"  - {ref}")
                if count > 10:
                    self.stdout.write(f"  ... 还有 {count - 10} 篇")

        if total_issues == 0:
            self.stdout.write(self.style.SUCCESS("\n所有文档四格式一致 ✓"))
        else:
            self.stdout.write(self.style.WARNING(f"\n共发现 {total_issues} 个不一致项"))

        if fix_mode:
            self.stdout.write(self.style.SUCCESS(f"\n已修复 {fixed_count} 篇文档"))

    @staticmethod
    def _try_fix_markdown(doc) -> int:
        """从 description_json 重建 markdown（需要 doc-editor 的转换工具）。"""
        try:
            json_data = doc.description_json
            if not json_data:
                return 0
            from apps.tabdoc.services.markdown_exchange import pm_json_to_markdown
            markdown = pm_json_to_markdown(json_data)
            if markdown:
                from apps.tabdoc.models import Document
                Document.objects.using(postgres_app_db_alias()).filter(id=doc.id).update(
                    description_markdown=markdown,
                )
                logger.info("Fixed markdown for doc=%s", doc.id)
                return 1
        except Exception:
            logger.debug("Failed to fix markdown for doc=%s", doc.id, exc_info=True)
        return 0

    @staticmethod
    def _try_fix_plaintext(doc) -> int:
        """从 markdown 提取 plaintext。"""
        try:
            import re
            markdown = doc.description_markdown or ""
            plaintext = re.sub(r'<[^>]+>', '', markdown)
            plaintext = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', plaintext)
            plaintext = re.sub(r'[#*_~`>|]', '', plaintext)
            plaintext = re.sub(r'\n{3,}', '\n\n', plaintext).strip()
            if plaintext:
                from apps.tabdoc.models import Document
                Document.objects.using(postgres_app_db_alias()).filter(id=doc.id).update(
                    description_plaintext=plaintext,
                )
                logger.info("Fixed plaintext for doc=%s", doc.id)
                return 1
        except Exception:
            logger.debug("Failed to fix plaintext for doc=%s", doc.id, exc_info=True)
        return 0

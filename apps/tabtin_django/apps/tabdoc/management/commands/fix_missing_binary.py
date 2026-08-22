"""
修复缺失 description_binary 的文档

当 collab-live 不可达时创建的文档可能缺失 description_binary，
此命令批量调用 ensure_description_binary 进行修复。

前置条件：collab-live 服务必须在线（需调用 /convert/markdown-to-update）。

用法：
    python manage.py fix_missing_binary
    python manage.py fix_missing_binary --limit 100
    python manage.py fix_missing_binary --dry-run
    python manage.py fix_missing_binary --organization <organization_id>
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from apps.services.common.db_router import postgres_app_db_alias


class Command(BaseCommand):
    help = "修复缺失 description_binary 的文档（批量生成 Y.js binary）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--limit",
            type=int,
            default=500,
            help="单次处理上限（默认 500）",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="仅统计，不实际修复",
        )
        parser.add_argument(
            "--organization",
            type=str,
            default="",
            help="仅处理指定 organization 下的文档",
        )

    def handle(self, *args, **options):
        from django.db.models import Q
        from apps.tabdoc.models import Document
        from apps.tabdoc.services.document_service import DocumentService

        limit = options["limit"]
        dry_run = options["dry_run"]
        organization_id = options["organization"]

        qs = Document.objects.using(postgres_app_db_alias()).filter(
            status="active",
        ).filter(
            Q(description_binary__isnull=True) | Q(description_binary=b""),
        ).exclude(
            description_markdown="",
        ).exclude(
            description_markdown__isnull=True,
        )

        if organization_id:
            qs = qs.filter(organization_id=organization_id)

        total = qs.count()
        self.stdout.write(f"发现 {total} 个缺失 binary 的文档")

        if dry_run:
            self.stdout.write(self.style.WARNING("(dry-run 模式，不执行修复)"))
            for doc in qs.only("id", "title")[:limit]:
                self.stdout.write(f"  - {doc.id}: {doc.title}")
            return

        if total == 0:
            self.stdout.write(self.style.SUCCESS("无需修复"))
            return

        docs = qs.only("id", "title")[:limit]
        fixed = 0
        failed = 0

        for doc in docs:
            try:
                ok = DocumentService.ensure_description_binary(doc.id)
                if ok:
                    fixed += 1
                    self.stdout.write(f"  ✓ {doc.id}: {doc.title}")
                else:
                    failed += 1
                    self.stdout.write(
                        self.style.WARNING(f"  ✗ {doc.id}: {doc.title} (修复失败)")
                    )
            except Exception as exc:
                failed += 1
                self.stdout.write(
                    self.style.ERROR(f"  ✗ {doc.id}: {doc.title} — {exc}")
                )

        self.stdout.write("")
        self.stdout.write(
            self.style.SUCCESS(
                f"完成: {fixed} 修复成功, {failed} 失败, "
                f"{max(0, total - limit)} 剩余未处理"
            )
        )
        if total > limit:
            self.stdout.write(
                self.style.WARNING(
                    f"仍有 {total - limit} 个文档未处理，请再次运行命令"
                )
            )

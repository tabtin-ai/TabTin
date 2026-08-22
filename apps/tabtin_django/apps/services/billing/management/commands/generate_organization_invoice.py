"""历史命令：月度 invoice 生成已停用。"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "历史命令：月度 invoice 生成已停用，当前请使用 Statement 对账单"

    def add_arguments(self, parser):
        parser.add_argument("--organization-id", type=str, default="", help="指定组织ID")
        parser.add_argument("--year", type=int, required=False, help="账单年份")
        parser.add_argument("--month", type=int, required=False, help="账单月份(1-12)")
        parser.add_argument(
            "--overwrite-draft",
            action="store_true",
            help="覆盖同账期草稿账单并重新生成",
        )

    def handle(self, *args, **options):
        month = int(options.get("month") or 1)

        if month < 1 or month > 12:
            raise CommandError("month 必须在 1-12 之间")

        self.stdout.write(
            self.style.WARNING("月度 BillingInvoice 生成已停用；请使用只读 Statement 对账单。")
        )

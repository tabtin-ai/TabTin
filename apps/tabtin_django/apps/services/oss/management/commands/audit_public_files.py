"""按模块盘点仍为 public 的 OSS 文件。"""

from __future__ import annotations

import json

from django.core.management.base import BaseCommand
from django.db.models import Count, Sum

from apps.services.oss.models import FileRecord


class Command(BaseCommand):
    help = "统计 is_public=True 的 FileRecord 数量和字节数，辅助收敛历史公开文件。"

    def add_arguments(self, parser):
        parser.add_argument(
            "--include-deleted",
            action="store_true",
            help="包含 status=deleted 的历史记录。",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="以 JSON 输出，方便脚本消费。",
        )

    def handle(self, *args, **options):
        qs = FileRecord.objects.filter(is_public=True)
        if not options["include_deleted"]:
            qs = qs.exclude(status="deleted")

        rows = []
        for row in qs.values("metadata__module").annotate(
            file_count=Count("id"),
            total_bytes=Sum("file_size"),
        ).order_by("metadata__module"):
            rows.append({
                "module": row["metadata__module"] or "unknown",
                "file_count": row["file_count"],
                "total_bytes": int(row["total_bytes"] or 0),
            })

        total_files = sum(row["file_count"] for row in rows)
        total_bytes = sum(row["total_bytes"] for row in rows)

        if options["json"]:
            self.stdout.write(json.dumps({
                "total_files": total_files,
                "total_bytes": total_bytes,
                "by_module": rows,
            }, ensure_ascii=False, indent=2))
            return

        self.stdout.write("Public OSS files by module")
        self.stdout.write(f"TOTAL\t{total_files}\t{total_bytes}")
        for row in rows:
            self.stdout.write(
                f"{row['module']}\t{row['file_count']}\t{row['total_bytes']}"
            )

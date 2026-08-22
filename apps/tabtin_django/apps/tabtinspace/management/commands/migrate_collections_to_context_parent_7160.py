"""#7160：Collection → ContextItem.parent 知识库树迁移。

用法::

    python manage.py migrate_collections_to_context_parent_7160 --dry-run
    python manage.py migrate_collections_to_context_parent_7160
    python manage.py migrate_collections_to_context_parent_7160 --organization-id <uuid>
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.tabtinspace.services.migrate_collections_to_context_parent import (
    migrate_collections_to_context_parent,
)


class Command(BaseCommand):
    help = "将 Collection 文件夹迁移为同名空 tabdoc 节点，并挂接 ContextItem.parent"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="预览模式，不写库")
        parser.add_argument("--organization-id", type=str, default=None)
        parser.add_argument(
            "--mapping-path",
            type=str,
            default="",
            help="collection_id→context_item_id 映射日志；缺省写到 logs/",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        organization_id = options.get("organization_id")
        mapping_path = options.get("mapping_path") or ""

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY-RUN] 预览模式，不会执行修改"))

        stats = migrate_collections_to_context_parent(
            organization_id=organization_id,
            dry_run=dry_run,
            batch_log=lambda msg: self.stdout.write(msg),
        )

        path = self._write_mapping(stats.mapping, mapping_path)
        self.stdout.write(self.style.NOTICE(f"映射日志: {path} ({len(stats.mapping)} 条)"))

        self.stdout.write(
            self.style.SUCCESS(
                "完成: "
                f"scanned={stats.scanned_collections} "
                f"created_docs={stats.created_docs} "
                f"reused_docs={stats.reused_docs} "
                f"items_relinked={stats.items_relinked} "
                f"items_skipped={stats.items_skipped} "
                f"nested_parents_set={stats.nested_parents_set}"
            )
        )

    def _write_mapping(self, mapping: dict, mapping_path: str) -> Path:
        stamp = timezone.now().strftime("%Y%m%d-%H%M%S")
        if mapping_path:
            path = Path(mapping_path)
        else:
            path = Path("logs") / f"collections-to-context-parent-7160-{stamp}.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(
                fh,
                fieldnames=["collection_id", "context_item_id"],
            )
            writer.writeheader()
            for collection_id, context_item_id in mapping.items():
                writer.writerow({
                    "collection_id": collection_id,
                    "context_item_id": context_item_id,
                })
        # 同步写一份 json 方便脚本消费
        json_path = path.with_suffix(".json")
        json_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

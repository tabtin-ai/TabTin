"""
refresh_context_previews — 批量刷新 ContextItem 的 preview 和 metadata 字段。

用于：模型的 get_context_preview() / get_context_metadata() 改进后，
需要回填已有 ContextItem 使其 preview/metadata 与最新逻辑一致。

Usage:
    python manage.py refresh_context_previews                     # 刷新所有
    python manage.py refresh_context_previews --type tabdata      # 仅刷新 tabdata
    python manage.py refresh_context_previews --dry-run           # 仅统计不写入
    python manage.py refresh_context_previews --empty-only        # 仅刷新 preview 为空的
"""
import logging
from uuid import UUID

from django.core.management.base import BaseCommand

from apps.tabtinspace.models import ContextItem
from apps.tabtinspace.resource_registry import get_resource_model
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "批量刷新 ContextItem 的 preview 和 metadata 字段"

    def add_arguments(self, parser):
        parser.add_argument(
            "--type", dest="item_type", default=None,
            help="仅刷新指定 item_type（如 tabdata、tabdoc）",
        )
        parser.add_argument(
            "--dry-run", action="store_true", default=False,
            help="仅统计，不实际写入",
        )
        parser.add_argument(
            "--empty-only", action="store_true", default=False,
            help="仅刷新 preview 为空的 ContextItem",
        )

    def handle(self, *args, **options):
        item_type = options["item_type"]
        dry_run = options["dry_run"]
        empty_only = options["empty_only"]

        qs = ContextItem.objects.using(postgres_app_db_alias()).filter(is_archived=False)
        if item_type:
            qs = qs.filter(item_type=item_type)
        if empty_only:
            qs = qs.filter(preview="")

        total = qs.count()
        self.stdout.write(f"待处理 ContextItem: {total} 条")

        if dry_run:
            type_counts = {}
            for item in qs.only("item_type").iterator():
                type_counts[item.item_type] = type_counts.get(item.item_type, 0) + 1
            for t, c in sorted(type_counts.items()):
                self.stdout.write(f"  {t}: {c}")
            self.stdout.write("--dry-run 模式，未做任何写入")
            return

        updated = 0
        skipped = 0
        errors = 0
        model_cache: dict = {}

        for item in qs.iterator(chunk_size=200):
            model_cls = model_cache.get(item.item_type)
            if model_cls is None:
                model_cls = get_resource_model(item.item_type)
                model_cache[item.item_type] = model_cls or False

            if not model_cls:
                skipped += 1
                continue

            try:
                rid = item.resource_id
                if not rid:
                    skipped += 1
                    continue

                resource = model_cls.objects.using(postgres_app_db_alias()).filter(id=UUID(rid)).first()
                if not resource:
                    skipped += 1
                    continue

                new_preview = resource.get_context_preview()
                new_metadata = resource.get_context_metadata()
                new_title = resource.get_context_title()

                changed = False
                if item.preview != new_preview:
                    item.preview = new_preview
                    changed = True
                if item.metadata != new_metadata:
                    item.metadata = new_metadata
                    changed = True
                if item.title != new_title:
                    item.title = new_title
                    changed = True

                if changed:
                    item.save(
                        using=postgres_app_db_alias(),
                        update_fields=["preview", "metadata", "title", "updated_at"],
                    )
                    updated += 1
                else:
                    skipped += 1

            except Exception as exc:
                errors += 1
                logger.warning(
                    "refresh_context_previews: item=%s type=%s error=%s",
                    item.id, item.item_type, exc,
                )

        self.stdout.write(self.style.SUCCESS(
            f"完成: 更新 {updated}, 跳过 {skipped}, 错误 {errors}"
        ))

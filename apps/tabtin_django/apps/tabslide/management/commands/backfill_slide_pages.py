"""
一次性回填：将现有 SlideProject.pages_data 拆分写入 SlidePage 行存储。

用法:
    python manage.py backfill_slide_pages
    python manage.py backfill_slide_pages --batch-size=50
    python manage.py backfill_slide_pages --dry-run

功能:
  - 遍历所有 SlideProject（pages_data 非空且尚无 SlidePage 行的项目）
  - 将 pages_data + page_meta 合并后拆分为 SlidePage 行
  - 幂等：已有 SlidePage 行的项目跳过
  - 支持 --dry-run 预览
"""

import logging

from django.core.management.base import BaseCommand

from apps.tabslide.models import SlidePage, SlideProject
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "将 SlideProject.pages_data 回填到 SlidePage 行存储（Phase 1 数据迁移）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--batch-size",
            type=int,
            default=100,
            help="每批处理的项目数（默认 100）",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只预览，不实际写入",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="强制重新回填（覆盖已有 SlidePage 行）",
        )

    def handle(self, *args, **options):
        batch_size = options["batch_size"]
        dry_run = options["dry_run"]
        force = options["force"]

        if dry_run:
            self.stdout.write(self.style.WARNING("🔍 DRY RUN 模式 — 不会实际写入数据"))

        # 查找需要回填的项目
        projects_qs = (
            SlideProject.objects.using(postgres_app_db_alias())
            .exclude(pages_data=None)
            .order_by("created_at")
        )

        total = projects_qs.count()
        self.stdout.write(f"📊 共 {total} 个项目有 pages_data")

        migrated = 0
        skipped = 0
        errors = 0
        offset = 0

        while offset < total:
            batch = list(projects_qs[offset:offset + batch_size])
            if not batch:
                break

            for project in batch:
                try:
                    # 检查是否已有 SlidePage 行
                    existing_count = (
                        SlidePage.objects.using(postgres_app_db_alias())
                        .filter(project=project)
                        .count()
                    )
                    if existing_count > 0 and not force:
                        skipped += 1
                        continue

                    pages_data = project.pages_data
                    if not isinstance(pages_data, list) or not pages_data:
                        skipped += 1
                        continue

                    # 合并 page_meta 回 pages（与 get_project_detail 一致）
                    page_meta = project.page_meta
                    if isinstance(page_meta, dict):
                        for page in pages_data:
                            page_id = page.get("id")
                            if page_id and page_id in page_meta:
                                entry = page_meta[page_id]
                                if isinstance(entry, dict):
                                    if "animations" in entry:
                                        page["animations"] = entry["animations"]
                                    if "turningMode" in entry:
                                        page["turningMode"] = entry["turningMode"]

                    if dry_run:
                        self.stdout.write(
                            f"  [DRY] {project.id} — {project.name} — "
                            f"{len(pages_data)} 页"
                        )
                        migrated += 1
                        continue

                    # 如果 force，先清除旧行
                    if force and existing_count > 0:
                        SlidePage.objects.using(postgres_app_db_alias()).filter(
                            project=project,
                        ).delete()

                    # 写入 SlidePage 行
                    slide_pages = []
                    for idx, page in enumerate(pages_data):
                        page_id = page.get("id")
                        if not page_id:
                            continue

                        from apps.tabslide.field_mapping import frontend_page_to_full_defaults
                        defaults = frontend_page_to_full_defaults(page)
                        slide_pages.append(SlidePage(
                            project=project,
                            page_id=page_id,
                            **defaults,
                            order=float(idx),
                            version=project.latest_version,
                        ))

                    if slide_pages:
                        SlidePage.objects.using(postgres_app_db_alias()).bulk_create(
                            slide_pages,
                            ignore_conflicts=False,
                        )

                    migrated += 1

                    if migrated % 20 == 0:
                        self.stdout.write(f"  ✅ 已迁移 {migrated} 个项目...")

                except Exception as e:
                    errors += 1
                    logger.error(
                        "backfill_slide_pages failed for project %s: %s",
                        project.id, e, exc_info=True,
                    )
                    self.stdout.write(
                        self.style.ERROR(f"  ❌ {project.id} — {e}")
                    )

            offset += batch_size

        self.stdout.write(self.style.SUCCESS(
            f"\n📋 回填完成: 迁移={migrated}, 跳过={skipped}, 错误={errors}"
        ))

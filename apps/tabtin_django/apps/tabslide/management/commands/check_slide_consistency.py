"""
TabSlide 数据一致性校验与迁移工具

确保所有项目的 SlidePage 行存储完整（SlidePage 是唯一 source of truth）。

用法:
    # 检查：报告缺少 SlidePage 的项目
    python manage.py check_slide_consistency --database=postgresql

    # 迁移：为所有缺少 SlidePage 的项目从 pages_data 回填（一次性操作）
    python manage.py check_slide_consistency --migrate-all --database=postgresql

    # 仅检查单个项目
    python manage.py check_slide_consistency --project-id=<uuid> --database=postgresql

校验内容:
  1. SlidePage 完整性：项目是否有 SlidePage 行
  2. 孤儿检测：pages_data 为空但 SlidePage 存在（SlidePage 为准，属正常）
  3. 缺失检测：pages_data 有数据但 SlidePage 无行（需要迁移）
"""

import json
import logging

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabslide.models import SlidePage, SlideProject

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "校验 SlidePage 完整性，确保所有项目的 SlidePage 已就位"

    def add_arguments(self, parser):
        parser.add_argument(
            "--migrate-all",
            action="store_true",
            help="为所有缺少 SlidePage 的项目从 pages_data 一次性回填",
        )
        parser.add_argument(
            "--project-id",
            type=str,
            default="",
            help="仅检查指定项目（UUID）",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=100,
            help="每批处理的项目数（默认 100）",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="仅报告需要迁移的项目数，不实际执行",
        )
        parser.add_argument(
            "--verbose",
            action="store_true",
            help="输出每个项目的详细校验结果",
        )

    def handle(self, *args, **options):
        migrate_all = options["migrate_all"]
        project_id = options["project_id"].strip()
        batch_size = options["batch_size"]
        dry_run = options["dry_run"]
        verbose = options["verbose"]

        db = postgres_app_db_alias()

        if migrate_all and not dry_run:
            self.stdout.write(self.style.WARNING(
                "⚠️  MIGRATE 模式 — 将为缺少 SlidePage 的项目从 pages_data 回填"
            ))
        elif dry_run:
            self.stdout.write("🔍 DRY-RUN 模式 — 仅报告，不修改数据")
        else:
            self.stdout.write("🔍 CHECK 模式 — 仅报告，不修改数据")

        qs = SlideProject.objects.using(db).filter(status="active")
        if project_id:
            qs = qs.filter(id=project_id)

        total = qs.count()
        self.stdout.write(f"📊 共 {total} 个活跃项目待检查\n")

        stats = {
            "checked": 0,
            "has_slide_pages": 0,
            "empty_project": 0,
            "needs_migration": 0,
            "migrated": 0,
            "migration_failed": 0,
            "errors": 0,
        }

        offset = 0
        while offset < total:
            batch = list(qs.order_by("created_at")[offset:offset + batch_size])
            if not batch:
                break

            for project in batch:
                try:
                    self._check_and_migrate(
                        project, db=db, migrate=migrate_all and not dry_run,
                        verbose=verbose, stats=stats,
                    )
                except Exception as e:
                    stats["errors"] += 1
                    logger.error(
                        "check_slide_consistency error for project %s: %s",
                        project.id, e, exc_info=True,
                    )
                    self.stdout.write(self.style.ERROR(f"  ❌ {project.id} — {e}"))

            offset += batch_size
            if offset % 500 == 0:
                self.stdout.write(f"  ... 已检查 {offset}/{total}")

        self.stdout.write("\n" + "=" * 60)
        self.stdout.write(self.style.SUCCESS("📋 SlidePage 一致性报告"))
        self.stdout.write("=" * 60)
        self.stdout.write(f"  检查总数:           {stats['checked']}")
        self.stdout.write(f"  已有 SlidePage:     {stats['has_slide_pages']}")
        self.stdout.write(f"  空项目（无页面）:   {stats['empty_project']}")
        self.stdout.write(f"  需要迁移:           {stats['needs_migration']}")
        self.stdout.write(f"  已迁移:             {stats['migrated']}")
        self.stdout.write(f"  迁移失败:           {stats['migration_failed']}")
        self.stdout.write(f"  错误:               {stats['errors']}")
        self.stdout.write("=" * 60)

        if stats["needs_migration"] > 0 and not migrate_all:
            self.stdout.write(self.style.WARNING(
                f"\n💡 有 {stats['needs_migration']} 个项目缺少 SlidePage，"
                f"使用 --migrate-all 执行一次性回填"
            ))

        if stats["needs_migration"] == 0 and stats["migration_failed"] == 0:
            self.stdout.write(self.style.SUCCESS(
                "\n✅ 所有项目的 SlidePage 已就位，可以安全部署 fallback 移除代码"
            ))

    def _check_and_migrate(
        self,
        project: SlideProject,
        *,
        db: str,
        migrate: bool,
        verbose: bool,
        stats: dict,
    ):
        stats["checked"] += 1

        sp_count = SlidePage.objects.using(db).filter(project=project).count()

        if sp_count > 0:
            stats["has_slide_pages"] += 1
            if verbose:
                self.stdout.write(
                    f"  ✅ {project.id} [{project.name}] — {sp_count} 页 SlidePage"
                )
            return

        # SlidePage 为空 — 检查 pages_data 是否有数据可迁移
        pages_data = project.pages_data
        if not isinstance(pages_data, list) or not pages_data:
            stats["empty_project"] += 1
            if verbose:
                self.stdout.write(
                    f"  ⬜ {project.id} [{project.name}] — 空项目（无页面数据）"
                )
            return

        # 需要迁移：有 pages_data 但无 SlidePage
        stats["needs_migration"] += 1
        self.stdout.write(self.style.WARNING(
            f"  ⚠️  {project.id} [{project.name}] — "
            f"有 {len(pages_data)} 页 pages_data 但无 SlidePage"
        ))

        if not migrate:
            return

        # 执行迁移
        try:
            self._do_migrate(project, pages_data, db=db)
            stats["migrated"] += 1
            self.stdout.write(self.style.SUCCESS(
                f"  🔧 已迁移 {project.id} — {len(pages_data)} 页"
            ))
        except Exception as e:
            stats["migration_failed"] += 1
            self.stdout.write(self.style.ERROR(
                f"  ❌ 迁移失败 {project.id} — {e}"
            ))

    @staticmethod
    def _do_migrate(project: SlideProject, pages_data: list, *, db: str):
        """原子事务：从 pages_data 创建 SlidePage 行"""

        # 合并 page_meta 到 pages
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

        with transaction.atomic(using=db):
            SlidePage.objects.using(db).filter(project=project).delete()

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
                SlidePage.objects.using(db).bulk_create(slide_pages)

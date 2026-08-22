"""
一次性回填：为旧项目从 OSS/文件迁移 font_meta 到 DB 字段。

用法:
    python manage.py backfill_pages_cache

功能:
  1. 为 pages_data 为空的项目，从 PPTX 解析并填充
  2. 为 font_meta 为空的项目，从 OSS/本地文件迁移到 DB
"""

import json
import logging
import tempfile
from pathlib import Path

from django.core.management.base import BaseCommand

from apps.tabslide.models import SlideProject

logger = logging.getLogger("tabslide")

FONT_META_OSS_PREFIX = "tabslide/font-meta"
LEGACY_FONT_META_DIR = Path(tempfile.gettempdir()) / "tabslide-font-meta"


class Command(BaseCommand):
    help = "为旧项目回填 pages_data 和 font_meta"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只统计，不写入",
        )
        parser.add_argument(
            "--font-meta-only",
            action="store_true",
            help="只回填 font_meta",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        font_meta_only = options["font_meta_only"]

        if not font_meta_only:
            self._backfill_pages_data(dry_run)

        self._backfill_font_meta(dry_run)

    def _backfill_pages_data(self, dry_run: bool):
        projects = SlideProject.objects.filter(pages_data__isnull=True).exclude(pptx_file="")
        total = projects.count()
        self.stdout.write(f"\n[pages_data] 需要回填: {total}")

        if dry_run or total == 0:
            return

        from apps.tabslide.services.pptx_io import read
        from apps.tabslide.services.slide_service import build_oss_image_handler

        image_handler = build_oss_image_handler()
        success = skipped = failed = 0

        for project in projects.iterator():
            pptx_path = project.pptx_file
            if not pptx_path or not Path(pptx_path).exists():
                skipped += 1
                continue

            try:
                pages = read(pptx_path, project.canvas_width, project.canvas_height, image_handler=image_handler)
                project.pages_data = pages
                project.save(update_fields=["pages_data"])
                success += 1
                self.stdout.write(f"  ✅ {project.id}: {len(pages)} 页")
            except Exception as e:
                failed += 1
                self.stdout.write(self.style.ERROR(f"  ❌ {project.id}: {e}"))

        self.stdout.write(self.style.SUCCESS(f"[pages_data] 成功 {success}, 跳过 {skipped}, 失败 {failed}"))

    def _backfill_font_meta(self, dry_run: bool):
        projects = SlideProject.objects.filter(font_meta__isnull=True)
        total = projects.count()
        self.stdout.write(f"\n[font_meta] 需要检查: {total}")

        if dry_run or total == 0:
            return

        success = skipped = failed = 0

        for project in projects.iterator():
            try:
                font_meta = self._load_font_meta_from_legacy_or_oss(project)
                if font_meta and (font_meta.get("embedded_fonts") or font_meta.get("theme_fonts")):
                    project.font_meta = font_meta
                    project.save(update_fields=["font_meta"])
                    success += 1
                    self.stdout.write(f"  ✅ {project.id}: font_meta 已迁移")
                else:
                    skipped += 1
            except Exception as e:
                failed += 1
                self.stdout.write(self.style.ERROR(f"  ❌ {project.id}: {e}"))

        self.stdout.write(self.style.SUCCESS(f"[font_meta] 迁移 {success}, 无数据 {skipped}, 失败 {failed}"))

    @staticmethod
    def _load_font_meta_from_legacy_or_oss(project: SlideProject) -> dict | None:
        """先试本地遗留文件，再试 OSS"""
        legacy_path = LEGACY_FONT_META_DIR / f"{project.id}.json"
        if legacy_path.exists():
            try:
                return json.loads(legacy_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        try:
            from apps.services.oss.services.factory import get_oss_service
            oss_service = get_oss_service()
            if not oss_service:
                return None

            object_key = f"{FONT_META_OSS_PREFIX}/{project.organization_id}/{project.space_id}/{project.id}.json"
            if not oss_service.file_exists(object_key):
                return None

            result = oss_service.download_file(object_key)
            if not result.get("success"):
                return None

            content = result.get("data", {}).get("content")
            if isinstance(content, bytes):
                return json.loads(content.decode("utf-8", errors="ignore"))
            if isinstance(content, str):
                return json.loads(content)
        except Exception:
            pass

        return None

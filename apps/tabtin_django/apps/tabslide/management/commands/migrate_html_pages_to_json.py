"""
存量 HTML 页面迁移：将 SlidePage(content_format='html') 转换为 JSON 模式。

设计哲学（必读）：
  TabSlide 的真相源是 PPTElement[]（JSON 模式）。
  HTML 模式自 2026-02 引入，用于让 Agent 直出 HTML，但已在 2026-05 全面下线。
  前端不再渲染 page.html / page.contentFormat，后端 read 路径不再透出这两个字段。
  存量 content_format='html' 的页面打开后会变成空白画布（elements_data 通常为空）。

  本命令的职责：把 html_source 通过 dom_extractor 提取为 PPTElement[] 写入 elements_data，
  并将 content_format 切换为 'json'。html_source 字段 **保留不变**，作为 Agent 后续创作时
  的"风格参考语料"（read-only after creation）。

用法:
    python manage.py migrate_html_pages_to_json
    python manage.py migrate_html_pages_to_json --dry-run
    python manage.py migrate_html_pages_to_json --project-id=<uuid>
    python manage.py migrate_html_pages_to_json --batch-size=20

行为:
  - 幂等：已是 JSON 模式的页面跳过（按 content_format 过滤）
  - 失败兜底：页面提取失败时注入"⚠ 转换失败"占位元素，避免空白画布
  - 版本号：每个被迁移的项目 latest_version + 1，标 last_editor_type='system'
  - PPTX 缓存：标记 pages dirty，下次导出会重建
"""

from __future__ import annotations

from django.conf import settings
import logging
import time as _time
from collections import defaultdict
from typing import Optional

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.tabslide.models import SlidePage, SlideProject

logger = logging.getLogger(__name__)

DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
# 占位元素：转换失败时注入页面，避免用户看到空白画布
_FAILURE_PLACEHOLDER_TEMPLATE = {
    "type": "text",
    "x": 80,
    "y": 300,
    "width": 1760,
    "height": 200,
    "rotate": 0,
    "opacity": 1,
    "locked": False,
    "visible": True,
    "props": {
        "content": (
            '<p><span style="color:#CC0000;font-size:18pt">'
            "⚠ 该页 HTML 自动转换失败，原始 HTML 已保留作 Agent 创作参考。"
            "请通过 tabtin slide generate 重新提交此页。"
            "</span></p>"
        ),
        "defaultFontSize": 18,
        "defaultColor": "#CC0000",
    },
}


class Command(BaseCommand):
    help = (
        "将存量 content_format='html' 的 SlidePage 通过 dom_extractor 转为 JSON 模式。"
        "html_source 字段保留作 Agent 创作上下文，不参与渲染。"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只预览不写入；输出每页的预计提取元素数",
        )
        parser.add_argument(
            "--project-id",
            type=str,
            default=None,
            help="只处理指定项目（默认全库）",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=20,
            help="每批处理多少页（默认 20）",
        )
        parser.add_argument(
            "--max-pages",
            type=int,
            default=None,
            help="最多处理多少页（用于灰度试跑）",
        )

    def handle(self, *args, **options):
        dry_run: bool = options["dry_run"]
        project_id: Optional[str] = options["project_id"]
        batch_size: int = options["batch_size"]
        max_pages: Optional[int] = options["max_pages"]

        if dry_run:
            self.stdout.write(self.style.WARNING(
                "🔍 DRY RUN — 不会写入数据"
            ))

        qs = (
            SlidePage.objects.using(DB)
            .filter(content_format="html")
            .select_related("project")
            .order_by("project_id", "order")
        )
        if project_id:
            qs = qs.filter(project_id=project_id)

        total = qs.count()
        if max_pages is not None:
            total = min(total, max_pages)

        self.stdout.write(
            f"📊 待迁移 HTML 页面: {total}"
            + (f" (project={project_id})" if project_id else "")
        )
        if total == 0:
            self.stdout.write(self.style.SUCCESS("✨ 没有需要迁移的页面"))
            return

        ok = 0
        failed = 0
        skipped_empty = 0
        affected_projects: dict[str, list[str]] = defaultdict(list)
        per_project_first_seen_version: dict[str, int] = {}

        offset = 0
        processed = 0
        t_start = _time.monotonic()

        while processed < total:
            limit = min(batch_size, total - processed)
            batch = list(qs[offset:offset + limit])
            if not batch:
                break

            for page_row in batch:
                processed += 1
                project = page_row.project
                page_id = page_row.page_id
                html_src = page_row.html_source or ""

                if not html_src.strip():
                    skipped_empty += 1
                    self.stdout.write(self.style.WARNING(
                        f"  ⚠ 跳过 {project.id}/{page_id}: html_source 为空"
                    ))
                    if not dry_run:
                        # 即便 html 为空，也要把 content_format 翻成 'json'，
                        # 避免存量行卡在 'html' 状态被前端识别成异常
                        SlidePage.objects.using(DB).filter(pk=page_row.pk).update(
                            content_format="json",
                        )
                        affected_projects[str(project.id)].append(page_id)
                        per_project_first_seen_version.setdefault(
                            str(project.id), project.latest_version,
                        )
                    continue

                try:
                    elements = self._extract_elements_for_page(
                        html=html_src,
                        canvas_w=project.canvas_width or 1920,
                        canvas_h=project.canvas_height or 1080,
                    )
                except Exception as exc:
                    failed += 1
                    logger.error(
                        "migrate_html: extract failed for %s/%s: %s",
                        project.id, page_id, exc, exc_info=True,
                    )
                    self.stdout.write(self.style.ERROR(
                        f"  ❌ {project.id}/{page_id}: 提取失败 ({exc!r})"
                    ))
                    elements = [
                        {**_FAILURE_PLACEHOLDER_TEMPLATE, "id": f"err_{page_id}"},
                    ]

                if not elements:
                    self.stdout.write(self.style.WARNING(
                        f"  ⚠ {project.id}/{page_id}: 提取得到 0 元素，注入占位"
                    ))
                    elements = [
                        {**_FAILURE_PLACEHOLDER_TEMPLATE, "id": f"empty_{page_id}"},
                    ]

                self.stdout.write(
                    f"  ✓ {project.id}/{page_id}: {len(elements)} 元素 "
                    + ("(预览)" if dry_run else "")
                )

                if not dry_run:
                    SlidePage.objects.using(DB).filter(pk=page_row.pk).update(
                        elements_data=elements,
                        content_format="json",
                        # html_source 保留不变（创作上下文）
                    )
                    affected_projects[str(project.id)].append(page_id)
                    per_project_first_seen_version.setdefault(
                        str(project.id), project.latest_version,
                    )

                ok += 1

            offset += limit

            if processed % (batch_size * 5) == 0:
                elapsed = _time.monotonic() - t_start
                self.stdout.write(
                    f"  [progress] {processed}/{total} elapsed={elapsed:.1f}s"
                )

        # 项目级版本 bump + pptx 缓存失效
        if not dry_run and affected_projects:
            self.stdout.write("\n🔧 更新项目版本 + PPTX 缓存失效...")
            self._bump_projects(affected_projects, per_project_first_seen_version)

        elapsed = _time.monotonic() - t_start
        summary = (
            f"\n📋 迁移完成 (elapsed={elapsed:.1f}s)\n"
            f"   ✅ 成功: {ok}\n"
            f"   ❌ 失败兜底: {failed}\n"
            f"   ⚠ 空 html_source 跳过: {skipped_empty}\n"
            f"   📦 影响项目: {len(affected_projects)}\n"
        )
        if dry_run:
            summary += "\n   🔍 (DRY RUN，未实际写入)\n"
        self.stdout.write(self.style.SUCCESS(summary))

    @staticmethod
    def _extract_elements_for_page(
        html: str,
        canvas_w: int,
        canvas_h: int,
    ) -> list[dict]:
        """对单页 html_source 跑 dom_extractor，返回 PPTElement[]。"""
        from apps.tabslide.services.dom_extractor import extract_elements_from_html
        from apps.tabslide.services.slide_service import (
            _flat_element_to_props_wrapped,
            _sanitize_elements_data,
        )

        # image_handler=None：data URI 图片保留原值，前端可直接渲染 base64。
        # 极少数 file:// 链接会保留为 broken，但这是存量数据的固有问题，不是迁移引入。
        pages = extract_elements_from_html(
            html=html,
            canvas_width=canvas_w,
            canvas_height=canvas_h,
            image_handler=None,
        )

        # dom_extractor 可能返回多页（按 .ppt-slide 数量），取第一页
        first_page = pages[0] if pages else {}
        raw_elements = first_page.get("elements", []) if isinstance(first_page, dict) else []

        if not isinstance(raw_elements, list):
            return []

        _sanitize_elements_data(raw_elements)
        return [
            _flat_element_to_props_wrapped(el)
            for el in raw_elements
            if isinstance(el, dict)
        ]

    @staticmethod
    def _bump_projects(
        affected_projects: dict[str, list[str]],
        first_seen_version: dict[str, int],
    ) -> None:
        """对每个被迁移的项目 bump version + 标记 pptx dirty + 触发 cache 失效。"""
        from apps.tabslide.services.pptx_cache import mark_pages_dirty

        with transaction.atomic(using=DB):
            for project_id, page_ids in affected_projects.items():
                # 重新读 latest_version（可能在迁移期间被并发改过）
                project = (
                    SlideProject.objects.using(DB)
                    .select_for_update()
                    .get(id=project_id)
                )
                next_version = project.latest_version + 1
                SlideProject.objects.using(DB).filter(id=project_id).update(
                    latest_version=next_version,
                    pptx_dirty=True,
                    last_editor_type="system",
                    last_editor_id="migrate_html_pages_to_json",
                    updated_at=timezone.now(),
                )
                # 同步 SlidePage.version
                SlidePage.objects.using(DB).filter(
                    project_id=project_id,
                    page_id__in=page_ids,
                ).update(version=next_version)
                mark_pages_dirty(project_id, page_ids)

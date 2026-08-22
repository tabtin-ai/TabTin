from django.conf import settings
"""
TabSlide Collab Adapter

将 TabSlide 的版本管理和协作逻辑适配到统一 collab 框架。
委托 SlideService 的已有实现处理数据序列化、diff 和恢复。
"""
import base64
import copy
import datetime
import json
import logging
import re
import uuid as uuid_mod
import zlib
from decimal import Decimal
from typing import Any, Optional

from django.db.models import Case, FloatField, Value, When
from django.utils import timezone

from .base import CollabAdapter

logger = logging.getLogger("collab.adapters.slide")

DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
_BASE64_DATA_URL_RE = re.compile(r"^data:image/[^;]+;base64,", re.IGNORECASE)


def _snapshot_json_default(obj):
    """P3-5: 防御性 JSON 序列化回调，处理非 JSON 原生类型。"""
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    if isinstance(obj, uuid_mod.UUID):
        return str(obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    if isinstance(obj, set):
        return list(obj)
    if isinstance(obj, Decimal):
        return float(obj)
    return str(obj)


class SlideCollabAdapter(CollabAdapter):
    resource_type = "slide"

    # ── 版本历史：序列化 ─────────────────────────────

    @staticmethod
    def _extract_pages(data: Any) -> list:
        """从版本数据中提取 pages 列表，兼容旧格式（list）和新格式（dict）。"""
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return data.get("pages", [])
        return []

    def serialize_snapshot(self, data: Any) -> bytes:
        """版本数据 → zlib 压缩 JSON bytes"""
        if isinstance(data, dict):
            data = {**data, "_format_version": 1}
        return zlib.compress(
            json.dumps(
                data, ensure_ascii=False, separators=(",", ":"),
                default=_snapshot_json_default,
            ).encode("utf-8"),
            level=6,
        )

    def deserialize_snapshot(self, blob: bytes) -> Optional[Any]:
        """zlib 压缩 bytes → 版本数据（dict 或旧格式 list）"""
        try:
            raw = blob if isinstance(blob, bytes) else bytes(blob)
            return json.loads(zlib.decompress(raw).decode("utf-8"))
        except Exception as e:
            logger.error("Failed to deserialize slide snapshot: %s", e)
            return None

    # ── 版本历史：增量 diff ──────────────────────────

    def compute_diff(self, base_data: Any, current_data: Any) -> Optional[bytes]:
        from apps.tabslide.services.slide_service import SlideService

        base_pages = self._extract_pages(base_data)
        current_pages = self._extract_pages(current_data)
        diff = SlideService._compute_page_diff(base_pages, current_pages)

        base_theme = base_data.get("theme") if isinstance(base_data, dict) else None
        current_theme = current_data.get("theme") if isinstance(current_data, dict) else None
        base_font_meta = base_data.get("font_meta") if isinstance(base_data, dict) else None
        current_font_meta = current_data.get("font_meta") if isinstance(current_data, dict) else None

        _CANVAS_FIELDS = ("canvas_width", "canvas_height", "preset")
        canvas_diffs = {}
        if isinstance(base_data, dict) and isinstance(current_data, dict):
            for key in _CANVAS_FIELDS:
                if base_data.get(key) != current_data.get(key):
                    canvas_diffs[key] = current_data.get(key)

        has_page_diff = bool(diff["added"] or diff["removed"] or diff["changed"])
        has_theme_diff = base_theme != current_theme
        has_font_meta_diff = base_font_meta != current_font_meta
        has_canvas_diff = bool(canvas_diffs)

        if not has_page_diff and not has_theme_diff and not has_font_meta_diff and not has_canvas_diff:
            return None

        if has_theme_diff:
            diff["theme"] = current_theme
        if has_font_meta_diff:
            diff["font_meta"] = current_font_meta
        diff.update(canvas_diffs)

        return zlib.compress(
            json.dumps(diff, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            level=6,
        )

    def apply_diff(self, base_data: Any, diff_blob: bytes) -> Optional[Any]:
        """将增量 diff 应用到 base_data 上，返回完整版本数据。

        CL-024: 加防御性 try/except，失败返回 None 让 rebuild_data 正确检测。
        """
        try:
            raw = diff_blob if isinstance(diff_blob, bytes) else bytes(diff_blob)
            diff = json.loads(zlib.decompress(raw).decode("utf-8"))
        except Exception:
            logger.exception("Failed to decompress slide diff")
            return None

        try:
            from apps.tabslide.services.slide_service import SlideService

            base_pages = self._extract_pages(base_data)
            result_pages = SlideService._apply_page_diff(base_pages, diff)

            # CSC-034: 旧格式 base_data（list）不含 theme/font_meta，
            # 不应将其初始化为 None 写入 result，否则 restore 时会清空主题。
            # 仅当 base_data 是 dict 时才继承其 theme/font_meta；
            # 旧格式时只在 diff 中明确携带时才写入，否则省略该键（restore 时保持当前值）。
            _INHERITABLE_FIELDS = ("theme", "font_meta", "canvas_width", "canvas_height", "preset")

            result: dict = {"pages": result_pages}

            if isinstance(base_data, dict):
                for key in _INHERITABLE_FIELDS:
                    if key in base_data:
                        result[key] = base_data[key]

            for key in _INHERITABLE_FIELDS:
                if key in diff:
                    result[key] = diff[key]

            return result
        except Exception:
            logger.exception("Failed to apply slide diff")
            return None

    # ── 版本历史：元数据 ─────────────────────────────

    def get_content_stats(self, data: Any) -> dict:
        pages = self._extract_pages(data)
        element_count = sum(len(p.get("elements", [])) for p in pages if isinstance(p, dict))
        return {"page_count": len(pages), "element_count": element_count}

    # ── 协作：资源与权限 ─────────────────────────────

    def get_resource(self, resource_id: str) -> Optional[Any]:
        from apps.tabslide.models import SlideProject

        try:
            return SlideProject.objects.using(DB).get(
                id=resource_id, status="active"
            )
        except SlideProject.DoesNotExist:
            return None

    def get_resource_for_rollback(self, resource_id: str) -> Optional[Any]:
        from apps.tabslide.models import SlideProject

        try:
            return SlideProject.objects.using(DB).get(id=resource_id)
        except SlideProject.DoesNotExist:
            return None

    def check_permission(self, user, resource: Any, action: str = "edit") -> bool:
        if not user:
            return False
        try:
            from apps.tabtinspace.services.base import BaseService

            svc = BaseService(user=user)
            required_role = "editor" if action == "edit" else "viewer"
            return svc.check_space_permission(
                str(resource.space_id), required_role=required_role
            )
        except Exception:
            logger.exception("Permission check failed for slide %s", resource.id)
            return False

    # ── 协作：快照与持久化 ────────────────────────────

    MAX_SLIDE_PAGES = 200

    def build_snapshot(self, resource: Any) -> dict:
        from apps.tabslide.field_mapping import model_row_to_frontend_page
        from apps.tabslide.models import SlidePage

        rows = list(
            SlidePage.objects.using(DB)
            .filter(project=resource)
            .order_by("order")[: self.MAX_SLIDE_PAGES + 1]
        )

        is_truncated = len(rows) > self.MAX_SLIDE_PAGES
        if is_truncated:
            rows = rows[: self.MAX_SLIDE_PAGES]
            total_pages = (
                SlidePage.objects.using(DB)
                .filter(project=resource)
                .count()
            )
            logger.warning(
                "build_snapshot truncated: slide=%s total_pages=%d max=%d",
                resource.id, total_pages, self.MAX_SLIDE_PAGES,
            )
        else:
            total_pages = len(rows)

        pages = [model_row_to_frontend_page(row) for row in rows]
        page_order = [row.page_id for row in rows]

        return {
            "project_id": str(resource.id),
            "project_name": resource.name,
            "version": resource.latest_version,
            "canvas_width": resource.canvas_width,
            "canvas_height": resource.canvas_height,
            "preset": resource.preset,
            "theme": resource.theme,
            "font_meta": resource.font_meta,
            "pages": pages,
            "page_order": page_order,
            "page_count": len(pages),
            "is_truncated": is_truncated,
            "total_pages": total_pages,
        }

    def persist_changes(self, resource: Any, changes: dict, editor_info: dict) -> dict:
        """
        处理 collab-live onStore 传入的变更。
        使用 select_for_update + base_version 乐观锁防止并发写入覆盖。
        """
        from django.db import transaction
        from django.db.models import F

        from apps.tabslide.field_mapping import (
            frontend_page_to_defaults,
            frontend_page_to_full_defaults,
        )
        from apps.tabslide.models import SlidePage, SlideProject
        from apps.tabslide.post_save import run_post_save_hooks
        from apps.tabslide.services.slide_service import SlideService

        changed_pages = changes.get("changed_pages", {})
        new_pages = changes.get("new_pages", {})
        deleted_page_ids = changes.get("deleted_page_ids", [])
        page_order = changes.get("page_order", [])
        meta = changes.get("meta", {})

        has_changes = bool(changed_pages or new_pages or deleted_page_ids)
        has_meta = bool(meta)
        has_order = bool(page_order)

        if not has_changes and not has_order and not has_meta:
            return {"version": resource.latest_version, "skipped": True}

        ed_type = editor_info.get("editor_type", "")
        ed_id = editor_info.get("editor_id", "")
        base_version = changes.get("base_version")

        with transaction.atomic(using=DB):
            project = (
                SlideProject.objects.using(DB)
                .select_for_update()
                .filter(id=resource.id)
                .first()
            )
            if not project:
                return {"error": "SlideProject not found"}

            if base_version is not None and base_version < project.latest_version:
                logger.info(
                    "persist_changes conflict: base_version %s < DB version %s for slide %s",
                    base_version, project.latest_version, project.id,
                )
                return {"conflict": True, "current_version": project.latest_version}

            existing_page_ids = set(
                SlidePage.objects.using(DB)
                .filter(project=project)
                .values_list("page_id", flat=True)
            )

            if deleted_page_ids and not changed_pages and not new_pages:
                deleted_page_id_set = set(deleted_page_ids)
                if existing_page_ids and deleted_page_id_set.issuperset(existing_page_ids) and not page_order:
                    logger.warning(
                        "persist_changes blocked: deletion-only payload would wipe all pages | "
                        "project=%s base_version=%s deleted=%s existing=%s",
                        project.id,
                        base_version,
                        deleted_page_id_set,
                        existing_page_ids,
                    )
                    return {
                        "version": project.latest_version,
                        "skipped": True,
                        "reason": "delete_all_guard",
                    }

            if changed_pages and not deleted_page_ids:
                empty_page_ids = [
                    pid for pid, pg in changed_pages.items()
                    if isinstance(pg, dict) and not (pg.get("elements") or pg.get("elements_data"))
                ]
                if empty_page_ids:
                    db_nonempty_ids = set(
                        SlidePage.objects.using(DB)
                        .filter(project=project, page_id__in=empty_page_ids)
                        .exclude(elements_data__in=[None, [], "[]", "null"])
                        .values_list("page_id", flat=True)
                    )
                    if db_nonempty_ids:
                        for pid in db_nonempty_ids:
                            changed_pages.pop(pid, None)
                        logger.warning(
                            "persist_changes: dropped %d empty-element pages that have DB content | "
                            "project=%s dropped=%s",
                            len(db_nonempty_ids), project.id, db_nonempty_ids,
                        )
                        if not changed_pages and not new_pages:
                            has_changes = bool(deleted_page_ids)
                            if not has_changes and not has_order and not has_meta:
                                return {"version": project.latest_version, "skipped": True, "reason": "empty_elements_guard"}

            update_kwargs = {
                "latest_version": F("latest_version") + 1,
                "updated_at": timezone.now(),
                "last_editor_type": ed_type,
                "last_editor_id": ed_id,
            }
            if has_changes:
                update_kwargs["pptx_dirty"] = True
            if meta.get("theme"):
                update_kwargs["theme"] = meta["theme"]
            if meta.get("name"):
                update_kwargs["name"] = meta["name"]
            if "font_meta" in meta:
                update_kwargs["font_meta"] = meta["font_meta"]

            SlideProject.objects.using(DB).filter(id=project.id).update(**update_kwargs)
            project.refresh_from_db(using=DB)
            next_version = project.latest_version

            # JSON-first：html_source / content_format 在 frontend_page_to_defaults 内
            # 被 _SEALED_AFTER_CREATION_MODEL_FIELDS 守卫丢弃，无需在此查询/校验。

            for page_id, page_data in changed_pages.items():
                defaults = frontend_page_to_defaults(page_data)
                defaults["version"] = next_version
                updated = SlidePage.objects.using(DB).filter(
                    project=project, page_id=page_id
                ).update(**defaults)
                if not updated:
                    logger.warning(
                        "changed_pages page_id=%s not found, creating: project=%s",
                        page_id, project.id,
                    )
                    full_defaults = frontend_page_to_full_defaults(page_data)
                    full_defaults["page_id"] = page_id
                    full_defaults["version"] = next_version
                    full_defaults["order"] = float(page_data.get("order", 0))
                    SlidePage.objects.using(DB).update_or_create(
                        project=project,
                        page_id=page_id,
                        defaults=full_defaults,
                    )

            for page_id, page_data in new_pages.items():
                defaults = frontend_page_to_full_defaults(page_data)
                defaults["page_id"] = page_id
                defaults["version"] = next_version
                defaults["order"] = float(page_data.get("order", 0))
                SlidePage.objects.using(DB).update_or_create(
                    project=project,
                    page_id=page_id,
                    defaults=defaults,
                )

            if deleted_page_ids:
                SlidePage.objects.using(DB).filter(
                    project=project, page_id__in=deleted_page_ids
                ).delete()

            if page_order:
                order_cases = [
                    When(page_id=pid, then=Value(float(idx)))
                    for idx, pid in enumerate(page_order)
                ]
                SlidePage.objects.using(DB).filter(
                    project=project, page_id__in=page_order
                ).update(order=Case(*order_cases, output_field=FloatField()))

        dirty_page_ids = list(changed_pages.keys()) + list(new_pages.keys())

        # E2E-019: 使用 on_commit 延迟 hooks 到最外层事务提交后执行。
        # api.py:collab_persist 的外层 transaction.atomic 包裹 persist+VH+CL，
        # 若 VH 写入失败事务回滚，on_commit 不会触发，避免副作用与 DB 状态不一致。
        _project = project
        _next_version = next_version
        _dirty_page_ids = dirty_page_ids
        _ed_type = ed_type
        _ed_id = ed_id

        def _deferred_post_save():
            try:
                run_post_save_hooks(
                    project=_project,
                    version=_next_version,
                    pages_affected=_dirty_page_ids or None,
                    change_type="collab_persist",
                    summary="",
                    editor_type=_ed_type,
                    editor_id=_ed_id,
                    create_history=False,
                )
            except Exception:
                logger.exception("post_save_hooks failed for slide %s", _project.id)

        transaction.on_commit(_deferred_post_save, using=DB)

        return {
            "version": next_version,
            "persisted": len(changed_pages),
            "created": len(new_pages),
            "deleted": len(deleted_page_ids),
        }

    # ── 恢复 ────────────────────────────────────────

    def restore(self, resource: Any, data: Any, *, prepared: Any = None, user=None) -> None:
        """
        将幻灯片项目恢复到指定版本的数据。

        data 可以是：
        - dict（新格式）: {"pages": [...], "theme": ..., "font_meta": ...}
        - list（旧格式）: 纯 pages 列表

        AP-021: 不过滤 status，允许 rollback 恢复已删除/归档的 SlideProject。
        事务保护和行锁由 SlideService._cas_save_pages 内部的 transaction.atomic +
        select_for_update().get(id=project.id) 提供，无需在此层重复。
        调用方（_do_restore）已通过 get_resource_for_rollback 验证资源合法性。
        """
        from apps.tabslide.services.slide_service import SlideService

        pages = self._extract_pages(data)
        extra_fields = {}
        if isinstance(data, dict):
            if "theme" in data:
                extra_fields["theme"] = data["theme"]
            if "font_meta" in data:
                extra_fields["font_meta"] = data["font_meta"]
            for key in ("canvas_width", "canvas_height", "preset"):
                if key in data:
                    extra_fields[key] = data[key]

        svc = SlideService(user=user)
        svc.restore_pages_from_snapshot(
            resource,
            pages=pages,
            page_meta=None,
            extra_fields=extra_fields or None,
            create_history=False,
            editor_type="system",
        )

    def get_version_data(self, resource: Any) -> dict:
        """返回页面、主题、字体元数据及画布尺寸（用于版本存储和恢复）。

        序列化时将 elements_data 中的 base64 内嵌图片上传到 OSS 并替换为 URL，
        避免每个版本快照都冗余存储大量 base64 数据。
        """
        pages = self.get_pages_data(resource)
        pages = self._strip_base64_images(pages, resource)

        # TODO: P2-8 — 引入 FileUsage 引用计数，pin 快照中的 OSS 资源防止释放。
        # 当前仅记录日志，为后续实现提供观测数据。
        oss_urls = self._collect_oss_urls(pages)
        if oss_urls:
            logger.info(
                "版本快照 OSS 资源引用: slide=%s url_count=%d",
                resource.id, len(oss_urls),
            )

        return {
            "pages": pages,
            "theme": resource.theme,
            "font_meta": resource.font_meta,
            "canvas_width": resource.canvas_width,
            "canvas_height": resource.canvas_height,
            "preset": resource.preset,
        }

    @staticmethod
    def _collect_oss_urls(pages: list) -> list[str]:
        """提取 pages 中所有 OSS 图片 URL（http(s) 开头、非 base64）。"""
        _HTTP_RE = re.compile(r"^https?://", re.IGNORECASE)
        urls: list[str] = []
        for page in pages:
            for element in page.get("elements", []):
                for src_val in (
                    element.get("src", ""),
                    (element.get("props") or {}).get("src", ""),
                ):
                    if isinstance(src_val, str) and _HTTP_RE.match(src_val):
                        urls.append(src_val)
            bg = page.get("background")
            if isinstance(bg, dict):
                for key in ("image", "imageUrl", "src"):
                    val = bg.get(key, "")
                    if isinstance(val, str) and _HTTP_RE.match(val):
                        urls.append(val)
        return urls

    # ── base64 图片分离 ────────────────────────────────

    def _strip_base64_images(self, pages: list, resource: Any) -> list:
        """遍历 pages 中所有元素，将 base64 图片上传到 OSS 并替换为 URL。

        best-effort：OSS 不可用或上传失败时保留原始 base64 数据并记录日志。
        不修改入参原始数据——在深拷贝上操作。
        """
        from apps.tabslide.services.slide_service import build_oss_image_handler

        base64_count = self._count_base64_in_pages(pages)
        if base64_count == 0:
            return pages

        handler = build_oss_image_handler(
            organization_id=str(getattr(resource, "organization_id", "")),
            user_id=str(getattr(resource, "created_by_id", "") or ""),
            context_type="slide_version_snapshot",
            context_id=str(resource.id),
        )

        if not handler:
            logger.warning(
                "版本快照中检测到 %d 个 base64 图片，但 OSS 不可用，无法替换: slide=%s",
                base64_count, resource.id,
            )
            return pages

        pages_copy = copy.deepcopy(pages)
        replaced = 0
        failed = 0

        for page in pages_copy:
            for element in page.get("elements", []):
                r, f = self._replace_base64_in_element(element, handler)
                replaced += r
                failed += f

            bg = page.get("background")
            if isinstance(bg, dict):
                for key in ("image", "imageUrl", "src"):
                    val = bg.get(key, "")
                    if isinstance(val, str) and _BASE64_DATA_URL_RE.match(val):
                        new_url = self._upload_base64_image(val, handler)
                        if new_url:
                            bg[key] = new_url
                            replaced += 1
                        else:
                            failed += 1

        if replaced > 0 or failed > 0:
            logger.info(
                "版本快照 base64 图片处理: slide=%s replaced=%d failed=%d",
                resource.id, replaced, failed,
            )

        return pages_copy

    @staticmethod
    def _replace_base64_in_element(element: dict, handler) -> tuple:
        """检查元素的 src 字段（flat 和 props-wrapped 格式），替换 base64 为 OSS URL。

        返回 (replaced_count, failed_count)。
        """
        replaced = 0
        failed = 0

        src = element.get("src", "")
        if isinstance(src, str) and _BASE64_DATA_URL_RE.match(src):
            new_url = SlideCollabAdapter._upload_base64_image(src, handler)
            if new_url:
                element["src"] = new_url
                replaced += 1
            else:
                failed += 1

        props = element.get("props")
        if isinstance(props, dict):
            prop_src = props.get("src", "")
            if isinstance(prop_src, str) and _BASE64_DATA_URL_RE.match(prop_src):
                new_url = SlideCollabAdapter._upload_base64_image(prop_src, handler)
                if new_url:
                    props["src"] = new_url
                    replaced += 1
                else:
                    failed += 1

        return replaced, failed

    @staticmethod
    def _upload_base64_image(data_url: str, handler) -> str | None:
        """将 base64 data URL 解码后上传到 OSS，返回 CDN URL 或 None。"""
        try:
            if "," not in data_url:
                return None
            header, b64_data = data_url.split(",", 1)
            mime = "image/png"
            if header.startswith("data:"):
                mime = header[5:].split(";", 1)[0].strip().lower()

            image_bytes = base64.b64decode(b64_data)
            if not image_bytes:
                return None

            return handler(image_bytes, mime)
        except Exception:
            logger.warning(
                "版本快照 base64 图片上传失败: data_url_len=%d",
                len(data_url), exc_info=True,
            )
            return None

    @staticmethod
    def _count_base64_in_pages(pages: list) -> int:
        """统计 pages 中 base64 data URL 图片的数量。"""
        count = 0
        for page in pages:
            for element in page.get("elements", []):
                src = element.get("src", "")
                if isinstance(src, str) and _BASE64_DATA_URL_RE.match(src):
                    count += 1
                props = element.get("props")
                if isinstance(props, dict):
                    prop_src = props.get("src", "")
                    if isinstance(prop_src, str) and _BASE64_DATA_URL_RE.match(prop_src):
                        count += 1
            bg = page.get("background")
            if isinstance(bg, dict):
                for key in ("image", "imageUrl", "src"):
                    val = bg.get(key, "")
                    if isinstance(val, str) and _BASE64_DATA_URL_RE.match(val):
                        count += 1
        return count

    # ── 工具方法 ─────────────────────────────────────

    def get_pages_data(self, resource: Any) -> list:
        """获取当前 pages 数据（用于创建版本时）。"""
        from apps.tabslide.services.slide_service import SlideService

        return SlideService._read_pages_from_slide_pages(resource)

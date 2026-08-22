"""
TabSlide PPTX 智能缓存服务（Phase 3）

解决的问题：
  - 当前每次导出都全量重新生成 PPTX（10-30 秒/100 页）
  - 改一个元素就 pptx_dirty=True，下次导出全量重新生成

策略：
  1. 内容哈希缓存：对 pages + 画布尺寸 + 主题计算 SHA256，
     相同内容复用已有 PPTX OSS URL
  2. 页面级脏标记：dirty_page_ids 追踪变更页面
  3. 页面级内容哈希：SlidePageCache 存储每页的 content_hash，
     只有内容实际变化时才需要重新生成 PPTX
  4. 异步预生成：保存后异步生成 PPTX，用户导出时直接返回
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from typing import Optional

from apps.tabslide.models import SlidePageCache, SlideProject
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

# v4：lineWidth 按导出 slide 物理尺寸缩放，保持与编辑器视觉粗细一致。
# v5：文本框 bodyPr 内边距始终显式写出（无 margin 写 0），避免 PowerPoint
#   套默认 0.1in/0.05in 幽灵内边距导致文字提前换行、纵向撑出固定框。
# v6：导出期从本地 TTF 资产内嵌平台内置字体（Noto Sans SC / Inter），
#   解决 PowerPoint 缺字替换致字体不一致、文本意外换行。
# v7：内嵌字体改为写原始 TTF 字节（不再 XOR 混淆）。此前混淆破坏 sfnt 头，
#   导致 PowerPoint/Keynote/WPS 打开导出的 pptx 时解析内嵌字体崩溃；旧缓存需重生成。
# v8：内嵌字体时在 presentation 上置 embedTrueTypeFonts="1"、saveSubsetFonts="0"。
#   缺 embedTrueTypeFonts（默认 false）会与 embeddedFontLst 自相矛盾，令打开方判定损坏/闪退。
# v9：导出彻底不内嵌字体。WPS pptxrw 解析内嵌字体空指针崩溃，pptx 在 WPS
#   打开即闪退（LibreOffice/Keynote 可容忍但 WPS 不能）。缺字回退替换字体优于崩溃。
# v10：文本框/形状内文字默认 shrink-to-fit（normAutofit）。不内嵌字体后，缺字
#   机器回退更宽字体会换行撑破框跑版；shrink-to-fit 让打开方自动缩小字号塞回框，保文字可编辑。
# v11：清洗 python-pptx 输出以兼容 Apple Keynote/macOS——修 sldSz 尺寸/type 矛盾、
#   补 notesMasterIdLst、删 Windows printerSettings 桩。此前 Keynote 直接"文件格式无效"打不开。
# v12：导出时用字体度量预算 normAutofit fontScale 并写死。WPS/PowerPoint 打开不重算
#   autofit，仅写 normAutofit 无效；预算 fontScale 后缺字机器按缩放渲染，避免换行跑版。
PPTX_EXPORT_CONTRACT_VERSION = "visual-fidelity-v12"


def compute_page_content_hash(page: dict, export_context: dict | None = None) -> str:
    """计算单个页面的内容哈希（SHA256），用于页面级缓存失效判断。"""
    payload = {
        "export_contract": PPTX_EXPORT_CONTRACT_VERSION,
        "export_context": export_context or {},
        "page": page,
    }
    content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def compute_pptx_content_hash(
    pages: list[dict],
    canvas_width: int,
    canvas_height: int,
    theme: dict | None = None,
    font_meta: dict | None = None,
) -> str:
    """
    计算 PPTX 内容的 SHA256 哈希。

    包含影响 PPTX 输出的所有因素：pages + 画布尺寸 + 主题。
    相同哈希 → 相同 PPTX 输出 → 可复用缓存。
    """
    payload = {
        "export_contract": PPTX_EXPORT_CONTRACT_VERSION,
        "pages": pages,
        "canvas_width": canvas_width,
        "canvas_height": canvas_height,
        "theme": theme,
        "font_meta": font_meta,
    }
    content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _build_export_hash_context(project: SlideProject, pages: list[dict]) -> dict:
    """影响 PPTX 输出但不一定改变 page dict 的项目级输入。"""
    return {
        "canvas_width": project.canvas_width,
        "canvas_height": project.canvas_height,
        "theme": project.theme,
        "font_meta": project.font_meta,
        "page_ids": [
            str(page.get("id", ""))
            for page in pages
            if isinstance(page, dict)
        ],
    }


def update_page_hashes(
    project: SlideProject,
    pages: list[dict],
    *,
    persist: bool = True,
    export_context: dict | None = None,
) -> set[str]:
    """
    更新 SlidePageCache 中的页面内容哈希。

    返回内容实际发生变化的 page_id 集合（真正 dirty 的页面）。
    对比 dirty_page_ids 与实际内容哈希，可以排除"标记脏但内容未变"的误报。

    persist=False 只做比较不写库；导出生成成功后再 persist=True，
    避免生成/上传失败时提前升级哈希并重新放行旧坏缓存。
    """
    if not pages:
        return set()

    # 获取已有缓存
    cached = {
        row.page_id: row
        for row in SlidePageCache.objects.using(postgres_app_db_alias()).filter(
            project=project,
        )
    }

    actually_changed = set()
    to_create = []
    to_update = []

    for page in pages:
        page_id = page.get("id", "")
        if not page_id:
            continue

        new_hash = compute_page_content_hash(page, export_context=export_context)
        existing = cached.get(page_id)

        if existing:
            if existing.content_hash != new_hash:
                actually_changed.add(page_id)
                existing.content_hash = new_hash
                existing.version = project.latest_version
                to_update.append(existing)
        else:
            actually_changed.add(page_id)
            to_create.append(
                SlidePageCache(
                    project=project,
                    page_id=page_id,
                    content_hash=new_hash,
                    slide_xml=b"",  # 将来存放缓存的 slide XML
                    version=project.latest_version,
                )
            )

    if not persist:
        return actually_changed

    if to_create:
        SlidePageCache.objects.using(postgres_app_db_alias()).bulk_create(
            to_create,
            update_conflicts=True,
            unique_fields=["project", "page_id"],
            update_fields=["content_hash", "version", "updated_at"],
        )
    if to_update:
        SlidePageCache.objects.using(postgres_app_db_alias()).bulk_update(
            to_update,
            fields=["content_hash", "version", "updated_at"],
        )

    return actually_changed


def mark_pages_dirty(project_id, page_ids: list[str]) -> None:
    """
    将指定页面标记为脏（增量），替代全局 pptx_dirty=True。

    追踪哪些页面变更了，为未来增量 PPTX 生成提供依据。

    CRT-15: 使用 PostgreSQL jsonb 原子操作合并 dirty_page_ids，
    避免并发读改写导致的脏页面丢失。
    """
    if not page_ids:
        return
    try:
        from django.db import connections

        new_ids_json = json.dumps(list(set(page_ids)))
        with connections[postgres_app_db_alias()].cursor() as cursor:
            cursor.execute(
                """
                UPDATE tabslide_project
                SET pptx_dirty = TRUE,
                    dirty_page_ids = (
                        SELECT jsonb_agg(DISTINCT elem)
                        FROM jsonb_array_elements(
                            COALESCE(dirty_page_ids, '[]'::jsonb) || %s::jsonb
                        ) AS elem
                    )
                WHERE id = %s
                """,
                [new_ids_json, str(project_id)],
            )
            if cursor.rowcount == 0:
                logger.warning("mark_pages_dirty: project %s not found", project_id)
    except Exception:
        logger.warning("mark_pages_dirty failed for %s, falling back to global dirty", project_id, exc_info=True)
        SlideProject.objects.using(postgres_app_db_alias()).filter(id=project_id).update(pptx_dirty=True)


def generate_and_cache_pptx(
    project: SlideProject,
    pages: list[dict],
    *,
    force: bool = False,
) -> Optional[str]:
    """
    智能 PPTX 生成 + 缓存。

    流程：
      1. 计算项目级内容哈希
      2. 如果 pptx_oss_url 存在且内容未变 → 直接返回（快速路径）
      3. 更新页面级哈希，判断是否有页面真正变化
      4. 如果无页面内容变化（仅元数据变化） → 清除脏标记，返回已有 URL
      5. 否则生成 PPTX → 上传 OSS → 更新缓存标记

    返回 OSS URL（成功）或 None（OSS 不可用时降级到本地路径）。
    """
    from apps.tabslide.services.slide_service import SlideService

    pages = SlideService._normalize_pages_for_pptx_export(pages)
    export_context = _build_export_hash_context(project, pages)
    content_hash = compute_pptx_content_hash(
        pages,
        project.canvas_width,
        project.canvas_height,
        project.theme,
        project.font_meta,
    )

    # 页面级哈希检查：判断是否有页面内容真正变化
    actually_changed: set[str] = set()
    try:
        actually_changed = update_page_hashes(
            project,
            pages,
            persist=False,
            export_context=export_context,
        )
        if not force and not actually_changed and project.pptx_oss_url:
            # 页面内容未变化（可能只是元数据变化），清除脏标记，返回已有 PPTX
            SlideProject.objects.using(postgres_app_db_alias()).filter(id=project.id).update(
                pptx_dirty=False,
                dirty_page_ids=None,
            )
            logger.info(
                "PPTX skip: project=%s — dirty_page_ids 标记的页面内容未实际变化",
                project.id,
            )
            return project.pptx_oss_url
    except Exception:
        logger.warning("update_page_hashes failed for %s, proceeding with full generation", project.id, exc_info=True)

    # JSON-first：pages 已是 PPTElement[] 真相源，直接序列化即可（无 HTML 反向回退）。
    source_w_emu, source_h_emu = SlideService._extract_source_slide_emu(project.theme)

    from apps.tabslide.services.pptx_io import write

    # 不内嵌字体导出：WPS Office 的 pptxrw 解析内嵌字体时空指针崩溃（EXC_BAD_ACCESS），
    # 导致导出的 pptx 在 WPS 打开即闪退。内嵌字体只是缺字机器上的视觉一致性
    # 增强，代价却是主力应用崩溃——故导出不内嵌字体，缺字时优雅回退到替换字体。
    # 待有 WPS 安全的方案（如字体子集化）再重新启用。
    effective_font_meta = None

    output_fd, output_path = tempfile.mkstemp(suffix=".pptx")
    os.close(output_fd)
    try:
        write(
            pages=pages,
            output_path=output_path,
            canvas_width=project.canvas_width,
            canvas_height=project.canvas_height,
            template_path=None,
            source_slide_width_emu=source_w_emu,
            source_slide_height_emu=source_h_emu,
            font_meta=effective_font_meta,
            aigc_metadata={
                "projectId": str(project.id),
                "organizationId": str(getattr(project, "organization_id", "") or ""),
                "spaceId": str(getattr(project, "space_id", "") or ""),
                "name": project.name or "",
            },
        )

        # 上传 OSS
        oss_url = SlideService._upload_pptx_to_oss(
            output_path, str(project.id),
            organization_id=str(getattr(project, "organization_id", "")),
            user_id=str(getattr(project, "created_by_id", "") or ""),
        )
    finally:
        try:
            os.unlink(output_path)
        except OSError:
            pass

    if oss_url:
        try:
            update_page_hashes(
                project,
                pages,
                persist=True,
                export_context=export_context,
            )
        except Exception:
            logger.warning("update_page_hashes after generation failed for %s", project.id, exc_info=True)
        SlideProject.objects.using(postgres_app_db_alias()).filter(id=project.id).update(
            pptx_oss_url=oss_url,
            pptx_dirty=False,
            dirty_page_ids=None,
        )
        logger.info(
            "PPTX generated and cached: project=%s hash=%s dirty_pages=%s actually_changed=%s",
            project.id, content_hash[:12],
            len(project.dirty_page_ids or []),
            len(actually_changed),
        )
        return oss_url

    # OSS 不可用，仅清除脏标记
    SlideProject.objects.using(postgres_app_db_alias()).filter(id=project.id).update(
        pptx_dirty=False,
        dirty_page_ids=None,
    )
    return None


def get_cached_or_generate_pptx(
    project: SlideProject,
    pages: list[dict],
) -> tuple[str, bool]:
    """
    获取 PPTX（优先缓存）。

    返回: (path_or_url, is_oss_url)
      - 缓存命中: (oss_url, True)
      - 需要生成: 生成后 (oss_url, True) 或 (local_path, False)
    """
    # 生成 + 缓存。即使项目未标脏，也要进入页面哈希校验：
    # 导出契约版本变化时，旧 OSS 缓存必须自动失效并重生成。
    oss_url = generate_and_cache_pptx(project, pages)
    if oss_url:
        return oss_url, True

    # OSS 不可用时不降级到本地路径（多服务器部署下本地路径不可跨机访问）
    raise RuntimeError("PPTX 生成后上传 OSS 失败，无法导出")

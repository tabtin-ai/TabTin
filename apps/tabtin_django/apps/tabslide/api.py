"""
TabSlide 模块 API — Django Ninja Router

薄 API 层：参数解析 → 调用 SlideService → 格式化响应。
业务逻辑全部在 services/slide_service.py 中。

存储架构：DB 即数据源，CAS 版本控制，版本历史，变更记录。

端点:
  # 项目 CRUD
  POST   /projects/                    创建项目
  GET    /projects/                    项目列表
  GET    /projects/{id}/               项目详情（含 SlideElement[] + version）
  GET    /projects/{id}/page-outline/  页面大纲（不含 elements，轻量级）
  GET    /projects/{id}/pages/{pid}/   单页详情（含 elements）
  PUT    /projects/{id}/               更新项目元数据
  PATCH  /projects/{id}/               部分更新（别名）
  DELETE /projects/{id}/               归档项目

  # 内容操作
  POST   /projects/{id}/create-slides/ 创建模式：HTML → pages（替换全部页面）
  POST   /projects/{id}/append-slides/  追加模式：HTML → 新页面
  POST   /projects/{id}/save-pages/    保存编辑器修改（CAS 版本校验）
  POST   /projects/import-pptx/        导入 PPTX
  POST   /projects/{id}/export/        导出（按需生成 PPTX）
  PATCH  /projects/{id}/pages/{page}/elements/{eid}/  精准修改元素

  # 版本历史
  GET    /projects/{id}/histories/     版本历史列表
  POST   /projects/{id}/versions/      创建命名版本
  POST   /projects/{id}/restore-history/ 恢复历史版本

  # 变更记录 & 增量同步
  GET    /projects/{id}/changes/       变更记录列表
  POST   /projects/{id}/sync-check/    增量同步检查

  # 工具
  POST   /upload-image/                上传图片到 OSS
  POST   /normalize-image/             图片归一化（导出降级）
  POST   /parse-pptx/                  纯解析 PPTX（不创建项目）
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from uuid import UUID, uuid4

from django.http import FileResponse, HttpRequest
from ninja import File, Router, UploadedFile

from apps.tabtinspace.models import Collection
from apps.tabtinspace.services.asset_host import asset_host_q
from apps.tabtinspace.services.base import ensure_space_in_organization
from apps.tabslide.error_codes import ErrorCode
from apps.tabslide.field_mapping import fe_key_to_model
from apps.tabslide.models import SlidePage, SlideProject
from apps.tabslide.services.slide_service import (
    ConflictError,
    ElementNotFoundError,
    HistoryNotFoundError,
    PageNotFoundError,
    PatchValidationError,
    SlideNotFoundError,
    SlideService,
)
from apps.i18n import get_text as _
from apps.i18n.response import (
    error_response_with_status as error_response,
    not_found_response,
    permission_denied_response,
    success_response,
    validation_error_response,
)
from apps.services.common.base_schemas import ErrorResponse
from apps.services.common.executor import run_in_agent_io_executor
from apps.services.oss.services.reactivate_utils import StorageQuotaExceededError
from apps.users.auth.permissions import JWTAuth

from .schemas import (
    AppendSlidesRequest,
    BatchUpdateElementsRequest,
    CreateNamedVersionRequest,
    CreateSlidesRequest,
    ExportRequest,
    GrepRequest,
    LintRequest,
    NormalizeImageRequest,
    ParsePptxRequest,
    PreviewRequest,
    ProjectCreateRequest,
    ProjectUpdateRequest,
    RestoreHistoryRequest,
    SavePagesRequest,
    SavePagesV2Request,
    SyncCheckRequest,
    UpdateElementByPageIdRequest,
    UpdateElementRequest,
)

logger = logging.getLogger(__name__)
router = Router(tags=["TabSlide"])
jwt_auth = JWTAuth()

# 协作路由已迁移到统一 Collab API (/api/collab/v1/slide/...)


# ============================================================================
# 序列化
# ============================================================================


from apps.tabtinspace.services.space_utils import resolve_space_names as _resolve_space_names
from apps.services.common.db_router import postgres_app_db_alias


def _serialize_project_summary(project: SlideProject, space_name_map: dict[str, str] | None = None) -> dict[str, Any]:
    space_id_str = str(project.space_id)
    result = {
        "id": str(project.id),
        "organization_id": str(project.organization_id),
        "space_id": space_id_str,
        "name": project.name,
        "preset": project.preset,
        "canvas_width": project.canvas_width,
        "canvas_height": project.canvas_height,
        "page_count": project.page_count,
        "thumbnail": project.thumbnail,
        "theme": project.theme,
        "latest_version": project.latest_version,
        "last_editor_type": project.last_editor_type,
        "last_editor_id": project.last_editor_id,
        "created_by": str(project.created_by_id) if project.created_by_id else None,
        "updated_by": str(project.updated_by_id) if project.updated_by_id else None,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
    }
    if space_name_map is not None:
        result["space_name"] = space_name_map.get(space_id_str, "")
    return result


def _serialize_project_detail(
    project: SlideProject,
    pages: list,
    *,
    embedded_fonts: list[dict[str, Any]] | None = None,
    theme_fonts: dict[str, str] | None = None,
) -> dict[str, Any]:
    summary = _serialize_project_summary(project)
    summary["pages"] = pages
    if embedded_fonts:
        summary["embedded_fonts"] = embedded_fonts
    if theme_fonts:
        summary["theme_fonts"] = theme_fonts
    return summary


def _serialize_history(history) -> dict[str, Any]:
    return {
        "id": str(history.id),
        "version": history.version,
        "page_count": history.page_count,
        "editor_type": history.editor_type,
        "editor_id": history.editor_id,
        "is_named": history.is_named,
        "name": history.name,
        "pinned": history.pinned,
        "created_at": history.created_at.isoformat() if history.created_at else None,
    }


def _serialize_change(change) -> dict[str, Any]:
    return {
        "id": str(change.id),
        "version": change.version,
        "change_type": change.change_type,
        "summary": change.summary,
        "pages_affected": change.pages_affected,
        "editor_type": change.editor_type,
        "editor_id": change.editor_id,
        "created_at": change.created_at.isoformat() if change.created_at else None,
    }


# ============================================================================
# Service 工厂
# ============================================================================


def _build_service(request: HttpRequest) -> SlideService:
    return SlideService(user=request.auth)


def _conflict_response(e: ConflictError):
    """409 Conflict 响应（统一使用 error_response_with_status 格式）"""
    return error_response(ErrorCode.VERSION_CONFLICT, str(e), status_code=409)


def _patch_validation_response(e: PatchValidationError):
    """400 PatchValidation 响应：把每个非法字段的 hint 完整返回给 Agent。"""
    return error_response(
        ErrorCode.PATCH_SCHEMA_INVALID,
        message=f"patch schema invalid: {e}",
        status_code=400,
        data={"validation_errors": e.errors},
    )


def _sanitize_element_patch(patch: dict) -> dict:
    """对单条 patch 做 XSS 净化（仅净化 content/src/href 等敏感字段）。

    `_sanitize_elements_data` 期望 element 列表，临时套个 `type: text` 复用它。
    """
    from apps.tabslide.services.slide_service import _sanitize_elements_data
    wrapped = _sanitize_elements_data([{"type": "text", **patch}])[0]
    wrapped.pop("type", None)
    return wrapped


def _try_dispatch_element_changes_yjs_first(
    *,
    project_id: str,
    sanitized_updates: list[dict],
    editor_id: str,
) -> dict | None:
    """尝试 Y.js-first 推送元素变更。

    成功条件：无 error 且 applied == total 且 applied > 0。
    任何一项不满足 → 返回 None 让上层降级 DB-first。

    返回成功结果 dict 或 None。
    """
    from apps.tabslide.services.collab_service import SlideCollabService
    from apps.services.common.config import is_yjs_first_enabled

    if not is_yjs_first_enabled("tabslide"):
        return None

    total = len(sanitized_updates)
    result = SlideCollabService.push_element_changes(
        project_id=project_id,
        changes=[
            {
                "page_id": u["page_id"],
                "type": "update",
                "element_id": u["element_id"],
                "patch": u["patch"],
            }
            for u in sanitized_updates
        ],
        agent_id=editor_id,
        editor_type="user",
    )
    applied = int(result.get("applied", 0) or 0)
    reported_total = int(result.get("total", total) or total)
    if result.get("error"):
        logger.warning(
            "Y.js-first push failed (project=%s updates=%d), falling back to DB-first: %s",
            project_id, total, result.get("error"),
        )
        return None
    if applied < reported_total or applied <= 0:
        logger.warning(
            "Y.js-first partial/empty apply (project=%s applied=%d/%d), falling back to DB-first "
            "(Y.Doc may lack page data)",
            project_id, applied, reported_total,
        )
        return None
    return {
        "updated": True,
        "applied": applied,
        "total": reported_total,
    }


# ============================================================================
# 项目 CRUD
# ============================================================================


@router.post("/projects/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="创建演示文稿项目")
def create_project(request: HttpRequest, body: ProjectCreateRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    try:
        ensure_space_in_organization(body.organization_id, body.space_id)
    except ValueError:
        return not_found_response(_("tabslide.agent_space_not_found"))

    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        organization_control_blocked_response,
    )

    svc = _build_service(request)
    try:
        project = svc.create_project(
            organization_id=body.organization_id,
            space_id=body.space_id,
            name=body.name,
            preset=body.preset,
            canvas_width=body.canvas_width,
            canvas_height=body.canvas_height,
            theme=body.theme,
            embedded_fonts=body.embedded_fonts,
            theme_fonts=body.theme_fonts,
        )
        return success_response(_serialize_project_summary(project))
    except OrganizationControlBlockedError as e:
        return organization_control_blocked_response(e)
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))


@router.get("/projects/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="项目列表")
def list_projects(request: HttpRequest, organization_id: str, space_id: str, scope: str = "space", limit: int = 50, offset: int = 0):
    if not request.auth:
        return permission_denied_response("Need login")

    try:
        ensure_space_in_organization(organization_id, space_id)
    except ValueError:
        return not_found_response(_("tabslide.agent_space_not_found"))

    safe_limit = min(max(1, limit), 100)
    safe_offset = max(0, offset)

    svc = _build_service(request)
    try:
        projects, total = svc.list_projects(
            organization_id=organization_id,
            space_id=space_id,
            scope=scope,
            limit=safe_limit,
            offset=safe_offset,
        )
        sn_map = _resolve_space_names(
            [p.space_id for p in projects]
        ) if scope == "organization" else None
        return success_response({
            "projects": [_serialize_project_summary(p, sn_map) for p in projects],
            "total": total,
            "limit": safe_limit,
            "offset": safe_offset,
        })
    except PermissionError as e:
        return permission_denied_response(str(e))


# ⚠️ 路由顺序：``/projects/import-pptx/`` 字面量必须在 ``/projects/{slide_project_id}/``
# 通配符**之前**注册（详见 tabtinspace/routers/approval_memo.py 同类注释）。否则 ninja
# 把 ``import-pptx`` 当成 slide_project_id 命中只有 GET/PUT/PATCH/DELETE 的通配符路由
# → POST 永远 405。dogfood 验证铁证：修复前 405。
@router.post("/projects/import-pptx/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="导入 PPTX 文件（异步）")
def import_pptx(
    request: HttpRequest,
    organization_id: str,
    space_id: str,
    collection_id: Optional[UUID] = None,
    file: UploadedFile = File(...),
):
    """CRT-01: PPTX 导入异步化。

    文件校验后派发 Celery 任务，立即返回 task_id。
    前端通过 GET /import-pptx-status/{task_id}/ 轮询进度和结果。
    """
    if not request.auth:
        return permission_denied_response("Need login")

    MAX_IMPORT_SIZE = 50 * 1024 * 1024  # 50 MB
    file_size = file.size
    if file_size is not None and file_size > MAX_IMPORT_SIZE:
        return validation_error_response(
            f"文件大小 {file_size / 1024 / 1024:.1f}MB 超过上限 50MB"
        )

    PPTX_MAGIC = b"PK\x03\x04"
    header = file.read(4)
    file.seek(0)
    if header[:4] != PPTX_MAGIC:
        return validation_error_response(_("tabslide.pptx_invalid_zip_signature"))

    try:
        ensure_space_in_organization(organization_id, space_id)
    except ValueError:
        return not_found_response(_("tabslide.agent_space_not_found"))

    svc = _build_service(request)
    if not svc.check_space_permission(space_id, required_role="editor"):
        return permission_denied_response(_("tabslide.no_permission_to_import"))

    if collection_id and not Collection.objects.filter(asset_host_q(space_id), id=collection_id).exists():
        return not_found_response(_("tabtinspace.collection_not_found"))

    from apps.tabslide.tasks import (
        PPTX_IMPORT_OSS_OBJECT_KEY_PREFIX,
        import_pptx_oss_task,
    )

    # API 与 Celery worker 在 ACK 中属于不同 Pod，不能把 API Pod 的 /tmp
    # 路径交给 worker。源文件先落到带生命周期兜底的临时 OSS 通道，
    # worker 再下载到自己的本地临时目录。
    temp_object_key = (
        f"{PPTX_IMPORT_OSS_OBJECT_KEY_PREFIX}/{uuid4().hex}.pptx"
    )
    oss_service = None

    def _cleanup_staged_object(reason: str) -> None:
        if oss_service is None:
            return
        try:
            delete_result = oss_service.delete_file(temp_object_key)
            if not delete_result.get("success"):
                logger.warning(
                    "import_pptx cleanup rejected: stage=%s space=%s",
                    reason,
                    space_id,
                )
        except Exception as cleanup_error:
            logger.warning(
                "import_pptx cleanup failed: stage=%s space=%s error_type=%s",
                reason,
                space_id,
                type(cleanup_error).__name__,
            )

    try:
        from apps.services.oss.services.factory import get_oss_service

        logger.info(
            "import_pptx stage: stage=staging organization=%s space=%s",
            organization_id,
            space_id,
        )
        oss_service = get_oss_service()
        file.seek(0)
        upload_result = oss_service.upload_file(
            file,
            temp_object_key,
            content_type=(
                "application/vnd.openxmlformats-officedocument."
                "presentationml.presentation"
            ),
        )
        if not upload_result.get("success"):
            raise RuntimeError(upload_result.get("message") or "OSS upload failed")
        logger.info(
            "import_pptx stage: stage=staged organization=%s space=%s",
            organization_id,
            space_id,
        )
    except Exception as e:
        _cleanup_staged_object("staging_failed")
        logger.error(
            "import_pptx staging failed: organization=%s space=%s error_type=%s",
            organization_id,
            space_id,
            type(e).__name__,
        )
        return error_response(
            ErrorCode.PPTX_IMPORT_FAILED,
            "文件暂存失败，请稍后重试",
        )

    agent_run_id = ""
    try:
        from apps.services.common.platform_context import get_current_run_id
        agent_run_id = get_current_run_id() or ""
    except ImportError:
        pass

    try:
        result = import_pptx_oss_task.delay(
            object_key=temp_object_key,
            organization_id=organization_id,
            space_id=space_id,
            file_name=file.name or "",
            user_id=str(request.auth.id),
            agent_run_id=agent_run_id,
            collection_id=str(collection_id) if collection_id else "",
        )
        logger.info(
            "import_pptx stage: stage=dispatched task=%s organization=%s space=%s",
            result.id,
            organization_id,
            space_id,
        )
        return success_response({
            "task_id": result.id,
            "status": "processing",
        })
    except Exception as e:
        _cleanup_staged_object("dispatch_failed")
        logger.error(
            "import_pptx dispatch failed: organization=%s space=%s error_type=%s",
            organization_id,
            space_id,
            type(e).__name__,
        )
        return error_response(
            ErrorCode.PPTX_IMPORT_FAILED,
            "PPTX 导入任务派发失败，请稍后重试",
        )


@router.get("/projects/{slide_project_id}/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="项目详情（含 SlideElement[] + version）")
def get_project(request: HttpRequest, slide_project_id: str):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        project, pages = svc.get_project_detail(slide_project_id)
        font_meta = svc.get_font_meta(project)
        return success_response(
            _serialize_project_detail(
                project,
                pages,
                embedded_fonts=font_meta.get("embedded_fonts"),
                theme_fonts=font_meta.get("theme_fonts"),
            )
        )
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError:
        return not_found_response(_("tabslide.project_not_found"))


# ── 按需加载（Phase 2）──


@router.get(
    "/projects/{slide_project_id}/page-outline/",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="获取页面大纲（不含 elements，轻量级）",
)
def get_page_outline(request: HttpRequest, slide_project_id: str):
    """
    返回所有页面的轻量级大纲（id/order/background/remark），不含 elements_data。

    100 页大纲 < 10KB（vs 全量项目详情 ~6MB），适用于：
      - 前端缩略图面板初始化
      - Agent 选择目标页面
      - 快速判断页面数量和排序
    """
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        outline = svc.get_pages_outline(slide_project_id)
        return success_response({"pages": outline, "total": len(outline)})
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError:
        return not_found_response(_("tabslide.project_not_found"))


@router.get(
    "/projects/{slide_project_id}/pages/{page_id}/",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="获取单页完整数据（含 elements）",
)
def get_page_detail(request: HttpRequest, slide_project_id: str, page_id: str):
    """
    返回单个页面的完整数据（含 elements_data）。

    单页通常 5-60KB（vs 全量 ~6MB），适用于：
      - Agent 元素编辑前只加载目标页
      - 前端懒加载页面内容
    """
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        page_data = svc.get_page_detail(slide_project_id, page_id)
        return success_response(page_data)
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return not_found_response(str(e))


@router.put("/projects/{slide_project_id}/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="更新项目元数据")
def update_project(request: HttpRequest, slide_project_id: str, body: ProjectUpdateRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        project = svc.update_project(
            slide_project_id,
            name=body.name,
            preset=body.preset,
            canvas_width=body.canvas_width,
            canvas_height=body.canvas_height,
            theme=body.theme,
            thumbnail=body.thumbnail,
            embedded_fonts=body.embedded_fonts,
            theme_fonts=body.theme_fonts,
        )
        return success_response(_serialize_project_summary(project))
    except SlideNotFoundError:
        return not_found_response(_("tabslide.project_not_found"))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))


@router.patch("/projects/{slide_project_id}/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="部分更新项目元数据")
def patch_project(request: HttpRequest, slide_project_id: str, body: ProjectUpdateRequest):
    """PATCH 别名，与 PUT 行为相同（前端习惯用 PATCH 做部分更新）"""
    return update_project(request, slide_project_id, body)


@router.delete("/projects/{slide_project_id}/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="归档项目")
def delete_project(request: HttpRequest, slide_project_id: str):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        svc.archive_project(slide_project_id)
        return success_response({"deleted": True})
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError:
        return not_found_response(_("tabslide.project_not_found"))


@router.post("/projects/{slide_project_id}/trash/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="移入回收站")
def trash_project(request: HttpRequest, slide_project_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    svc = _build_service(request)
    try:
        svc.trash_project(slide_project_id)
        return success_response({"trashed": True})
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError:
        return not_found_response(_("tabslide.project_not_found"))


@router.post("/projects/{slide_project_id}/restore-from-trash/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="从回收站恢复")
def restore_project_from_trash(request: HttpRequest, slide_project_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    svc = _build_service(request)
    try:
        svc.restore_project(slide_project_id)
        return success_response({"restored": True})
    except StorageQuotaExceededError as exc:
        return validation_error_response(
            f"存储空间不足，无法恢复。需要 {exc.required_bytes} 字节，可用 {exc.available_bytes} 字节。"
        )
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))


@router.delete("/projects/{slide_project_id}/permanent/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="永久删除")
def permanent_delete_project(request: HttpRequest, slide_project_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    svc = _build_service(request)
    try:
        svc.permanent_delete_project(slide_project_id)
        return success_response({"deleted": True})
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))


# ============================================================================
# 创建模式：HTML → PPTX → SlideElement[]
# ============================================================================


@router.post("/projects/{slide_project_id}/create-slides/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="创建模式：HTML → PPTX")
def create_slides(request: HttpRequest, slide_project_id: str, body: CreateSlidesRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        project, _created_pages = svc.create_slides(
            slide_project_id,
            html=body.html,
            title=body.title,
            mode=body.mode or "direct",
            inline_images=bool(body.inline_images),
        )
        font_meta = svc.get_font_meta(project)
        summary = _serialize_project_summary(project)
        if font_meta.get("embedded_fonts"):
            summary["embedded_fonts"] = font_meta["embedded_fonts"]
        if font_meta.get("theme_fonts"):
            summary["theme_fonts"] = font_meta["theme_fonts"]
        layout_problems = getattr(svc, "_last_html_layout_problems", None) or []
        if layout_problems:
            summary["layout_problems"] = layout_problems
            summary["layout_hint"] = (
                "HTML 内容超出 1280×720 画布（html_overflow）。"
                "请精简该页或拆页后重新 render；勿用导出缩放掩盖。"
            )
        return success_response(summary)
    except SlideNotFoundError:
        return not_found_response(_("tabslide.project_not_found"))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))
    except Exception:
        logger.error("create_slides failed | failure_kind=render_internal_error")
        return error_response(
            ErrorCode.SLIDES_CREATION_FAILED,
            _("tabslide.slides_creation_failed_retry"),
        )


@router.post("/projects/{slide_project_id}/append-slides/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: dict}, auth=jwt_auth, summary="追加模式：HTML → 新页面")
def append_slides(request: HttpRequest, slide_project_id: str, body: AppendSlidesRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        project, pages = svc.append_slides(
            slide_project_id,
            html=body.html,
            title=body.title,
            mode=body.mode or "direct",
            page_id=body.page_id,
            after_page_id=body.after_page_id,
            base_version=body.base_version,
        )
        font_meta = svc.get_font_meta(project)
        return success_response(
            _serialize_project_detail(
                project,
                pages,
                embedded_fonts=font_meta.get("embedded_fonts"),
                theme_fonts=font_meta.get("theme_fonts"),
            )
        )
    except ConflictError as e:
        return _conflict_response(e)
    except SlideNotFoundError:
        return not_found_response(_("tabslide.project_not_found"))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))
    except Exception as e:
        logger.error("append_slides failed: %s", e, exc_info=True)
        return error_response(ErrorCode.SLIDES_CREATION_FAILED, f"幻灯片追加失败: {e}")


# ============================================================================
# 保存编辑器修改：SlideElement[] → CAS 写 DB
# ============================================================================


@router.post("/projects/{slide_project_id}/save-pages/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: dict}, auth=jwt_auth, summary="保存页面修改（CAS 版本校验）")
def save_pages(request: HttpRequest, slide_project_id: str, body: SavePagesRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        project = svc.save_pages(
            slide_project_id,
            pages=body.pages,
            base_version=body.base_version,
        )
        return success_response({
            "saved": True,
            "pageCount": project.page_count,
            "latest_version": project.latest_version,
        })
    except ConflictError as e:
        return _conflict_response(e)
    except (SlideNotFoundError, PageNotFoundError) as e:
        return not_found_response(str(e))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))
    except Exception as e:
        logger.error("save_pages failed: %s", e, exc_info=True)
        return error_response(ErrorCode.PAGES_SAVE_FAILED, f"页面保存失败: {e}")


# ============================================================================
# 增量保存 V2：只更新变更的页面
# ============================================================================


@router.post(
    "/projects/{slide_project_id}/save-pages-v2/",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: dict},
    auth=jwt_auth,
    summary="增量保存页面（V2，只传变更页面）",
)
def save_pages_v2(request: HttpRequest, slide_project_id: str, body: SavePagesV2Request):
    """
    增量保存（V2）：只更新变更的页面，不全量覆盖。

    与 save-pages 的区别：
      - save-pages: 传全量 pages[]，全量覆盖
      - save-pages-v2: 只传 changed_pages + deleted_page_ids，增量更新

    前提：项目的 SlidePage 行存储已初始化（通过 backfill 或新建项目时双写）。
    如果 SlidePage 无数据，返回 400 提示使用 save-pages 全量保存。
    """
    if not request.auth:
        return permission_denied_response("Need login")

    if not body.changed_pages and not body.deleted_page_ids and not body.page_order:
        return validation_error_response(_("tabslide.page_save_payload_required"))

    svc = _build_service(request)
    try:
        project = svc.save_pages_incremental(
            slide_project_id,
            changed_pages=body.changed_pages,
            deleted_page_ids=body.deleted_page_ids,
            page_order=body.page_order,
            base_version=body.base_version,
        )
        return success_response({
            "saved": True,
            "pageCount": project.page_count,
            "latest_version": project.latest_version,
        })
    except ConflictError as e:
        return _conflict_response(e)
    except (SlideNotFoundError, PageNotFoundError) as e:
        return not_found_response(str(e))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))
    except Exception as e:
        logger.error("save_pages_v2 failed: %s", e, exc_info=True)
        return error_response(ErrorCode.PAGES_SAVE_FAILED, f"增量保存失败: {e}")


# ============================================================================
# 导入 PPTX
# ============================================================================


# ``/projects/import-pptx/`` 已上移到 ``/projects/{slide_project_id}/`` 通配符之前注册
# （解决 ninja 路由顺序冲突导致 405）。这里仅保留 status 端点。


@router.get("/import-pptx-status/{task_id}/", response={200: dict, 404: ErrorResponse}, auth=jwt_auth, summary="查询 PPTX 导入进度")
def get_import_pptx_status(request: HttpRequest, task_id: str):
    """CRT-01: 轮询 PPTX 异步导入任务的进度和结果。"""
    if not request.auth:
        return permission_denied_response("Need login")

    from django.core.cache import cache
    from apps.tabslide.tasks import IMPORT_PPTX_CACHE_PREFIX

    cache_key = f"{IMPORT_PPTX_CACHE_PREFIX}{task_id}"
    data = cache.get(cache_key)
    if data is None:
        return not_found_response(_("tabslide.import_task_not_found"))

    if data.get("status") == "completed":
        project_id = data.get("project_id")
        if not project_id:
            return error_response(ErrorCode.PPTX_IMPORT_FAILED, "导入结果中缺少 project_id")
        try:
            project = SlideProject.objects.using(postgres_app_db_alias()).get(id=project_id)
            svc = _build_service(request)
            if not svc.check_space_permission(str(project.space_id), required_role="viewer"):
                return permission_denied_response(_("tabslide.no_permission_to_access_project_space"))
            pages = svc._read_pages_from_slide_pages(project)
            return success_response({
                "status": "completed",
                "task_id": task_id,
                "result": _serialize_project_detail(
                    project,
                    pages,
                    embedded_fonts=data.get("embedded_fonts"),
                    theme_fonts=data.get("theme_fonts"),
                ),
            })
        except SlideProject.DoesNotExist:
            return error_response(ErrorCode.PPTX_IMPORT_FAILED, "导入完成但项目未找到")
        except Exception as e:
            logger.error("get_import_pptx_status: serialize failed: %s", e, exc_info=True)
            return error_response(ErrorCode.PPTX_IMPORT_FAILED, f"结果序列化失败: {e}")

    return success_response({
        "status": data.get("status", "unknown"),
        "task_id": task_id,
        "stage": data.get("stage", ""),
        "error": data.get("error", ""),
    })


@router.post("/parse-pptx/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="纯解析 PPTX（不创建项目）")
def parse_pptx(request: HttpRequest, body: ParsePptxRequest):
    """
    纯解析 PPTX 文件，返回 SlideElement[] + 画布元数据。
    不创建后端项目，适合前端纯编辑器导入场景。

    通过 JSON body 接收 base64 编码的 PPTX 文件内容。
    （Electron IPC 代理仅支持 JSON 传输，无法 multipart/form-data）

    大小校验已在 ParsePptxRequest Schema 的 model_validator 中提前拦截，
    避免在 handler 层才执行完整 base64 解码。
    """
    if not request.auth:
        return permission_denied_response("Need login")

    # SDI-019: per-user rate limit — 10 req/min, 防止资源滥用
    from django.core.cache import cache as _cache

    _user_id = str(request.auth.id)
    _rate_key = f"tabslide:parse_pptx:rate:{_user_id}"
    _PARSE_PPTX_RATE_LIMIT = 10
    _PARSE_PPTX_RATE_WINDOW = 60
    _current = _cache.get(_rate_key, 0)
    if _current >= _PARSE_PPTX_RATE_LIMIT:
        return error_response(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            "PPTX 解析请求过于频繁，请稍后再试",
            status_code=429,
        )
    try:
        _cache.incr(_rate_key)
    except ValueError:
        _cache.set(_rate_key, 1, _PARSE_PPTX_RATE_WINDOW)

    try:
        result = SlideService.parse_pptx_content(
            body.file_base64,
            file_name=body.file_name or "import.pptx",
            canvas_width=body.canvas_width,
            canvas_height=body.canvas_height,
        )
        return success_response(result)
    except ValueError as e:
        return validation_error_response(str(e))
    except Exception as e:
        logger.error("parse_pptx failed: %s", e, exc_info=True)
        return error_response(ErrorCode.PPTX_IMPORT_FAILED, f"PPTX 解析失败: {e}")


# ============================================================================
# 导出
# ============================================================================


@router.post("/projects/{slide_project_id}/export/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="导出文件")
async def export_project(request: HttpRequest, slide_project_id: str, body: ExportRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    if body.format != "pptx":
        return validation_error_response(_("tabslide.export_format_not_pptx", format=body.format))

    def _run_sync():
        svc = _build_service(request)
        try:
            project, pptx_path_or_url = svc.get_export_pptx_path(slide_project_id)
        except SlideNotFoundError:
            return not_found_response(_("tabslide.project_not_found"))
        except PermissionError as e:
            return permission_denied_response(str(e))
        except ValueError:
            return error_response(ErrorCode.PPTX_FILE_NOT_FOUND, "PPTX 文件不存在")

        if body.format == "pptx":
            return success_response({
                "download_url": pptx_path_or_url,
                "filename": f"{project.name}.pptx",
            })

        return error_response(ErrorCode.EXPORT_FORMAT_NOT_SUPPORTED, f"导出格式 '{body.format}' 尚未支持")

    return await run_in_agent_io_executor(_run_sync)


# ============================================================================
# 版本历史
# ============================================================================


@router.get("/projects/{slide_project_id}/histories/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="版本历史列表")
def list_histories(request: HttpRequest, slide_project_id: str, named_only: bool = False, limit: int = 50):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        histories = svc.list_histories(
            slide_project_id,
            include_named_only=named_only,
            limit=min(limit, 100),
        )
        return success_response({
            "histories": [_serialize_history(h) for h in histories],
        })
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError:
        return not_found_response(_("tabslide.project_not_found"))


@router.post("/projects/{slide_project_id}/versions/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="创建命名版本")
def create_named_version(request: HttpRequest, slide_project_id: str, body: CreateNamedVersionRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        history = svc.create_named_version(slide_project_id, name=body.name)
        return success_response(_serialize_history(history))
    except SlideNotFoundError:
        return not_found_response(_("tabslide.project_not_found"))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))


@router.post("/projects/{slide_project_id}/restore-history/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: dict}, auth=jwt_auth, summary="恢复历史版本")
def restore_history(request: HttpRequest, slide_project_id: str, body: RestoreHistoryRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        project, pages = svc.restore_history(slide_project_id, history_id=body.history_id)
        font_meta = svc.get_font_meta(project)
        return success_response(
            _serialize_project_detail(
                project,
                pages,
                embedded_fonts=font_meta.get("embedded_fonts"),
                theme_fonts=font_meta.get("theme_fonts"),
            )
        )
    except ConflictError as e:
        return _conflict_response(e)
    except (SlideNotFoundError, HistoryNotFoundError) as e:
        return not_found_response(str(e))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return error_response(ErrorCode.HISTORY_RESTORE_FAILED, str(e))


# ============================================================================
# 变更记录 & 增量同步
# ============================================================================


@router.get("/projects/{slide_project_id}/changes/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="变更记录列表")
def list_changes(request: HttpRequest, slide_project_id: str, since_version: Optional[int] = None, limit: int = 50):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        changes = svc.list_changes(
            slide_project_id,
            since_version=since_version,
            limit=min(limit, 100),
        )
        return success_response({
            "changes": [_serialize_change(c) for c in changes],
        })
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError:
        return not_found_response(_("tabslide.project_not_found"))


@router.post("/projects/{slide_project_id}/sync-check/", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="增量同步检查")
def sync_check(request: HttpRequest, slide_project_id: str, body: SyncCheckRequest):
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        status = svc.check_sync_status(slide_project_id, client_version=body.client_version)
        return success_response(status)
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError:
        return not_found_response(_("tabslide.project_not_found"))


@router.post(
    "/upload-image/",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse},
    auth=jwt_auth,
    summary="上传图片到 OSS",
)
def upload_image(
    request: HttpRequest,
    organization_id: str = "",
    slide_project_id: str = "",
    file: UploadedFile = File(...),
):
    """
    将图片文件上传到 OSS，返回可访问的 URL。

    用于前端/Agent 在幻灯片中插入用户图片。
    支持格式：png / jpg / gif / webp / svg / bmp，上限 20 MB。
    """
    if not request.auth:
        return permission_denied_response("Need login")

    # XC-34: 校验 slide_project_id 不为空，避免 FileUsage context_id 为空永不释放
    if not slide_project_id or not slide_project_id.strip():
        return validation_error_response(_("tabslide.slide_project_id_required"))

    try:
        project = SlideProject.objects.using(postgres_app_db_alias()).get(id=slide_project_id)
    except SlideProject.DoesNotExist:
        return not_found_response(_("tabslide.project_not_found"))
    svc = _build_service(request)
    if not svc.check_space_permission(str(project.space_id), required_role="editor"):
        return permission_denied_response(_("tabslide.no_permission_to_access_project_space"))

    MAX_IMAGE_SIZE = 20 * 1024 * 1024  # 20 MB

    ALLOWED_CONTENT_TYPES = {
        "image/png", "image/jpeg", "image/gif",
        "image/webp", "image/svg+xml", "image/bmp",
    }

    _IMAGE_MAGIC_BYTES = {
        b'\x89PNG\r\n\x1a\n': "image/png",
        b'\xff\xd8\xff': "image/jpeg",
        b'GIF87a': "image/gif",
        b'GIF89a': "image/gif",
        b'RIFF': "image/webp",  # WebP: RIFF....WEBP
        b'BM': "image/bmp",
    }

    content_type = (getattr(file, "content_type", "") or "").split(";", 1)[0].strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        return validation_error_response(
            f"不支持的图片格式: {content_type}，"
            f"允许: {', '.join(sorted(ALLOWED_CONTENT_TYPES))}"
        )

    file_bytes = file.read()
    if len(file_bytes) > MAX_IMAGE_SIZE:
        return validation_error_response(
            f"文件大小 {len(file_bytes) / 1024 / 1024:.1f}MB 超过上限 20MB"
        )

    if content_type != "image/svg+xml":
        magic_ok = False
        for magic, expected_mime in _IMAGE_MAGIC_BYTES.items():
            if file_bytes[:len(magic)] == magic:
                if expected_mime == "image/webp":
                    magic_ok = len(file_bytes) >= 12 and file_bytes[8:12] == b'WEBP'
                else:
                    magic_ok = True
                break
        if not magic_ok:
            return validation_error_response(
                "文件内容与声明的图片格式不匹配，请上传有效的图片文件"
            )

    from apps.tabslide.services.slide_service import build_oss_image_handler

    handler = build_oss_image_handler(
        organization_id=organization_id,
        user_id=str(request.auth.id) if request.auth else "",
        context_type="slide_upload",
        context_id=slide_project_id,
    )
    if handler is None:
        return error_response(ErrorCode.IMAGE_UPLOAD_FAILED, "OSS 服务不可用，无法上传图片")

    try:
        url = handler(file_bytes, content_type)
        return success_response({
            "url": url,
            "filename": file.name or "",
            "size": len(file_bytes),
            "content_type": content_type,
        })
    except Exception as e:
        logger.error("upload_image failed: %s", e, exc_info=True)
        return error_response(ErrorCode.IMAGE_UPLOAD_FAILED, f"图片上传失败: {e}")


@router.post("/normalize-image/", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="导出前图片归一化")
def normalize_image(request: HttpRequest, body: NormalizeImageRequest):
    """
    将图片 src（data URL 或 http(s) URL）归一化成标准 data URL。
    用于前端导出链路在跨域/格式受限时的自动降级。
    """
    if not request.auth:
        return permission_denied_response("Need login")

    # P2-16: per-user rate limit — 30 req/min, 防止 SSRF / 资源滥用
    from django.core.cache import cache as _cache

    _user_id = str(request.auth.id)
    _rate_key = f"tabslide:normalize_image:rate:{_user_id}"
    _NORMALIZE_IMAGE_RATE_LIMIT = 30
    _NORMALIZE_IMAGE_RATE_WINDOW = 60
    _current = _cache.get(_rate_key, 0)
    if _current >= _NORMALIZE_IMAGE_RATE_LIMIT:
        return error_response(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            "图片归一化请求过于频繁，请稍后再试",
            status_code=429,
        )
    try:
        _cache.incr(_rate_key)
    except ValueError:
        _cache.set(_rate_key, 1, _NORMALIZE_IMAGE_RATE_WINDOW)

    svc = _build_service(request)
    try:
        result = svc.normalize_image_for_export(body.src)
        return success_response(result)
    except ValueError as e:
        return validation_error_response(str(e))
    except Exception as e:
        logger.error("normalize_image failed: %s", e, exc_info=True)
        return error_response(ErrorCode.SLIDES_CREATION_FAILED, f"图片归一化失败: {e}")


# ============================================================================
# Preview & Lint (Agent self-inspection)
# ============================================================================


@router.post(
    "/projects/{slide_project_id}/preview/",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="渲染页面截图（Agent 自检用，Playwright 服务端渲染）",
)
def preview_page(request: HttpRequest, slide_project_id: str, body: PreviewRequest):
    """
    Server-side render a slide page to a PNG screenshot.

    Uses Playwright headless Chromium to render PPTElement data as HTML, then
    screenshots the result. Useful for Agent self-inspection after generation.

    Returns either an OSS URL (response_format='url') or base64-encoded PNG
    (response_format='base64').
    """
    if not request.auth:
        return permission_denied_response("Need login")

    svc = _build_service(request)
    try:
        project = svc._get_project(slide_project_id, required_role="viewer")
        canvas_w = project.canvas_width or 1280
        canvas_h = project.canvas_height or 720

        if body.page_id:
            page_obj = SlidePage.objects.using(postgres_app_db_alias()).get(
                project=project, page_id=body.page_id,
            )
        else:
            page_obj = (
                SlidePage.objects.using(postgres_app_db_alias())
                .filter(project=project)
                .order_by("order")
                .first()
            )
            if not page_obj:
                return error_response(ErrorCode.SLIDES_CREATION_FAILED, "项目没有页面")

        # JSON-first：所有页面都已是 PPTElement[] 真相源，统一走元素渲染路径。
        from apps.tabslide.services.preview_service import render_slide_preview_safe
        png_bytes = render_slide_preview_safe(
            elements=page_obj.elements_data or [],
            background=page_obj.background,
            canvas_width=canvas_w,
            canvas_height=canvas_h,
        )

        if body.response_format == "base64":
            import base64
            b64 = base64.b64encode(png_bytes).decode("ascii")
            return success_response({
                "page_id": page_obj.page_id,
                "format": "base64",
                "image": f"data:image/png;base64,{b64}",
                "width": canvas_w,
                "height": canvas_h,
            })

        # Upload to OSS — deactivate old previews first to prevent unbounded accumulation
        from apps.tabslide.services.slide_service import build_oss_image_handler
        ws_id = str(getattr(project, "organization_id", "") or "")
        uid = str(request.auth.id) if request.auth else ""
        try:
            from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
            deactivate_file_usages_and_release_storage(
                module="tabslide",
                context_filter={"context_type": "preview_image", "context_id": str(project.id)},
                organization_id=ws_id,
                user_id=uid,
                biz_type="tabslide_preview_cleanup",
                biz_id=str(project.id),
                log_prefix="TabSlide preview",
            )
        except Exception:
            logger.warning("TabSlide 清理旧 preview FileUsage 失败: project=%s", project.id, exc_info=True)

        handler = build_oss_image_handler(
            organization_id=ws_id,
            user_id=uid,
            context_type="preview_image",
            context_id=str(project.id),
        )
        if handler:
            url = handler(png_bytes, "image/png")
            return success_response({
                "page_id": page_obj.page_id,
                "format": "url",
                "image": url,
                "width": canvas_w,
                "height": canvas_h,
            })

        # Fallback to base64 if OSS unavailable
        import base64
        b64 = base64.b64encode(png_bytes).decode("ascii")
        return success_response({
            "page_id": page_obj.page_id,
            "format": "base64",
            "image": f"data:image/png;base64,{b64}",
            "width": canvas_w,
            "height": canvas_h,
        })

    except SlidePage.DoesNotExist:
        return not_found_response(_("tabslide.page_not_found_with_id", page_id=body.page_id))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return not_found_response(str(e))
    except Exception as e:
        logger.error("preview_page failed: %s", e, exc_info=True)
        return error_response(ErrorCode.SLIDES_CREATION_FAILED, f"截图渲染失败: {e}")


@router.post(
    "/projects/{slide_project_id}/lint/",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="视觉质量检查（Agent 自检用，检测溢出/超界/小字/重叠等）",
)
def lint_page(request: HttpRequest, slide_project_id: str, body: LintRequest):
    """
    Run visual lint checks on slide pages using Playwright.

    Renders PPTElement data as HTML, then injects JavaScript checks for:
      - text_overflow: text content overflows its container
      - out_of_bounds: element completely outside slide canvas
      - partially_out_of_bounds: element partially clipped
      - font_too_small: font size below 12px
      - zero_size: element with near-zero dimensions
      - significant_overlap: two elements overlap more than 50%
      - sparse_layout: very few elements covering less than 10% of slide
      - low_contrast: text/background contrast ratio below WCAG AA (4.5:1)

    Returns a list of problems with type, severity, element_id, and message.
    """
    import time as _time

    if not request.auth:
        return permission_denied_response("Need login")

    t_start = _time.monotonic()
    svc = _build_service(request)
    try:
        project = svc._get_project(slide_project_id, required_role="viewer")
        canvas_w = project.canvas_width or 1280
        canvas_h = project.canvas_height or 720

        if body.page_id:
            pages = [
                SlidePage.objects.using(postgres_app_db_alias()).get(
                    project=project, page_id=body.page_id,
                )
            ]
        else:
            pages = list(
                SlidePage.objects.using(postgres_app_db_alias())
                .filter(project=project)
                .order_by("order")
            )

        from apps.tabslide.services.preview_service import run_visual_lint, run_visual_lint_batch
        from apps.tabslide.services.structural_lint import check_structural_issues

        all_problems: list[dict] = []

        # ① structural lint — 纯 JSON 检查，毫秒级（不依赖 Playwright），先跑
        structural_input = [
            {"id": p.page_id, "elements": p.elements_data or []}
            for p in pages
        ]
        structural_problems = check_structural_issues(
            structural_input, canvas_w=canvas_w, canvas_h=canvas_h,
        )
        all_problems.extend(structural_problems)

        # ①b HTML 布局 lint（create_slides 抽取前量到的撑破问题）
        all_problems.extend(svc.get_html_layout_problems(project))

        # ② visual lint — Playwright DOM 渲染检查（可选跳过，Agent 高频自检时用）
        if getattr(body, "skip_visual", False):
            pass  # structural-only fast path
        elif len(pages) > 1:
            page_dicts = [
                {"elements": p.elements_data or [], "background": p.background}
                for p in pages
            ]
            batch_results = run_visual_lint_batch(
                page_dicts, canvas_width=canvas_w, canvas_height=canvas_h,
            )
            for page_obj, problems in zip(pages, batch_results):
                for p in problems:
                    p["page_id"] = page_obj.page_id
                all_problems.extend(problems)
        else:
            for page_obj in pages:
                problems = run_visual_lint(
                    elements=page_obj.elements_data or [],
                    background=page_obj.background,
                    canvas_width=canvas_w,
                    canvas_height=canvas_h,
                )
                for p in problems:
                    p["page_id"] = page_obj.page_id
                all_problems.extend(problems)

        if body.problems_only:
            all_problems = [p for p in all_problems if p.get("severity") in ("error", "warning")]

        # Phase-3 Wave-3：min_severity 过滤
        min_sev = getattr(body, "min_severity", None)
        if min_sev:
            sev_order = {"error": 3, "warning": 2, "info": 1}
            threshold = sev_order.get(min_sev, 0)
            if threshold:
                all_problems = [
                    p for p in all_problems
                    if sev_order.get(p.get("severity", ""), 0) >= threshold
                ]

        lint_ms = round((_time.monotonic() - t_start) * 1000)
        errors = sum(1 for p in all_problems if p.get("severity") == "error")
        warnings = sum(1 for p in all_problems if p.get("severity") == "warning")
        infos = sum(1 for p in all_problems if p.get("severity") == "info")
        logger.info(
            "lint_page done | project=%s pages=%d problems=%d (errors=%d warnings=%d infos=%d) lint_ms=%d",
            slide_project_id, len(pages), len(all_problems),
            errors, warnings, infos, lint_ms,
        )

        # 按 severity 分类的统计，让 Agent 一眼看到 error/warning 优先
        return success_response({
            "problems": all_problems,
            "pages_checked": len(pages),
            "total_problems": len(all_problems),
            "summary": {
                "errors": errors,
                "warnings": warnings,
                "infos": infos,
            },
        })

    except SlidePage.DoesNotExist:
        return not_found_response(_("tabslide.page_not_found_with_id", page_id=body.page_id))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return not_found_response(str(e))
    except Exception as e:
        logger.error("lint_page failed: %s", e, exc_info=True)
        return error_response(ErrorCode.SLIDES_CREATION_FAILED, f"视觉检查失败: {e}")


@router.post(
    "/projects/{slide_project_id}/grep/",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="全文本搜索（Agent 找某段文字在哪一页/哪个元素）",
)
def grep_project(request: HttpRequest, slide_project_id: str, body: GrepRequest):
    """跨页元素文字子串匹配。

    用途：Agent 想编辑某段文字时，比"逐页 outline + page"快上 10x；
    返回 page_id + element_id 让 Agent 直接用 slide update 改。

    搜索范围：text 元素 props.content（HTML 剥标签后）+ shape 元素 props.text.content。
    """
    if not request.auth:
        return permission_denied_response("Need login")

    if not body.query or not body.query.strip():
        return validation_error_response("query 不能为空")

    svc = _build_service(request)
    try:
        project = svc._get_project(slide_project_id, required_role="viewer")
    except SlideNotFoundError:
        return not_found_response(_("tabslide.project_not_found"))
    except PermissionError as e:
        return permission_denied_response(str(e))

    pages_qs = (
        SlidePage.objects.using(postgres_app_db_alias())
        .filter(project=project)
        .order_by("order")
    )
    if body.page_id:
        pages_qs = pages_qs.filter(page_id=body.page_id)

    page_dicts = [
        {
            "page_id": p.page_id,
            "elements_data": p.elements_data or [],
            "order": p.order,
        }
        for p in pages_qs
    ]

    from apps.tabslide.services.grep_service import grep_pages

    result = grep_pages(
        page_dicts,
        query=body.query,
        element_types=body.element_types,
        max_results=body.max_results,
    )
    return success_response(result)


# ============================================================================
# 编辑模式：Agent 精准修改元素
# ============================================================================


@router.patch(
    "/projects/{slide_project_id}/pages/{page_index}/elements/{element_id}/",
    response={200: dict, 410: dict},
    auth=jwt_auth,
    summary="[已废弃] 编辑模式：精准修改元素（page_index 寻址）",
)
def update_element(
    request: HttpRequest,
    slide_project_id: str,
    page_index: int,
    element_id: str,
    body: UpdateElementRequest,
):
    """P2-17: 此端点已废弃，page_index 寻址在并发编辑场景下不稳定。
    请使用 V2 端点：PATCH /projects/{id}/pages-by-id/{page_id}/elements/{element_id}/"""
    logger.warning(
        "[DEPRECATED] update_element via page_index called: project=%s page_index=%d element=%s. "
        "Returning 410 Gone.",
        slide_project_id, page_index, element_id,
    )
    return 410, {
        "status": "error",
        "message": (
            "This endpoint is deprecated. Use PATCH "
            f"/projects/{slide_project_id}/pages-by-id/{{page_id}}/elements/{element_id}/ instead."
        ),
    }


# ============================================================================
# Agent 精准编辑 V2（Phase 5：page_id 寻址 + 批量）
# ============================================================================


@router.patch(
    "/projects/{slide_project_id}/pages-by-id/{page_id}/elements/{element_id}/",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: dict},
    auth=jwt_auth,
    summary="精准修改元素（Y.js-first：通过 CRDT 协作链路）",
)
def update_element_v2(
    request: HttpRequest,
    slide_project_id: str,
    page_id: str,
    element_id: str,
    body: UpdateElementByPageIdRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")

    from apps.tabslide.services.slide_service import validate_element_patch

    # P0 — schema 校验：未知顶层字段直接 400，给 Agent 明确的迁移提示
    # （之前的 `_deep_merge` 会静默吞下任意 key，导致 patch 写错却返回 success）
    try:
        validate_element_patch(body.patch)
    except PatchValidationError as e:
        return _patch_validation_response(e)

    svc = _build_service(request)
    try:
        svc._get_project(slide_project_id, required_role="editor")
    except SlideNotFoundError as e:
        return not_found_response(str(e))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except Exception as e:
        return error_response(ErrorCode.ELEMENT_UPDATE_FAILED, f"项目校验失败: {e}")

    editor_id = str(getattr(request.auth, 'id', ''))

    try:
        SlidePage.objects.using(postgres_app_db_alias()).get(
            project_id=slide_project_id, page_id=page_id,
        )
    except SlidePage.DoesNotExist:
        pass

    sanitized_patch = _sanitize_element_patch(body.patch)

    # Y.js-first 路径（成功条件 = 无 error + applied == total + applied > 0）
    yjs_result = _try_dispatch_element_changes_yjs_first(
        project_id=slide_project_id,
        sanitized_updates=[{
            "page_id": page_id,
            "element_id": element_id,
            "patch": sanitized_patch,
        }],
        editor_id=editor_id,
    )
    if yjs_result is not None:
        yjs_result["element_id"] = element_id
        return success_response(yjs_result)

    # DB-first 降级路径（feature flag 关闭 或 Y.js-first 失败/未生效）
    try:
        svc.update_element_by_page_id(
            slide_project_id,
            page_id=page_id,
            element_id=element_id,
            patch=sanitized_patch,
            base_version=body.base_version,
        )
        return success_response({
            "updated": True,
            "applied": 1,
            "total": 1,
            "element_id": element_id,
            "_fallback": True,
        })
    except ConflictError as ce:
        return _conflict_response(ce)
    except (SlideNotFoundError, PageNotFoundError, ElementNotFoundError) as e:
        return not_found_response(str(e))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))
    except Exception as e:
        logger.error("update_element_v2 failed: %s", e, exc_info=True)
        return error_response(ErrorCode.ELEMENT_UPDATE_FAILED, f"元素更新失败: {e}")


@router.post(
    "/projects/{slide_project_id}/batch-update-elements/",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 409: dict},
    auth=jwt_auth,
    summary="批量修改元素（Y.js-first：通过 CRDT 协作链路）",
)
def batch_update_elements(
    request: HttpRequest,
    slide_project_id: str,
    body: BatchUpdateElementsRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")

    if not body.updates:
        return validation_error_response(_("tabslide.updates_required"))

    if len(body.updates) > 200:
        return validation_error_response(_("tabslide.batch_update_limit_exceeded", count=len(body.updates)))

    from apps.tabslide.services.slide_service import validate_element_patch

    # P0 — 每条 patch 都做 schema 校验：任何一条非法 → 整批拒绝并返回完整错误清单
    # 这样 Agent 不会出现"前 N 条成功、第 N+1 条失败、整体回滚却以为部分成功"的混乱
    invalid: list[dict] = []
    for i, u in enumerate(body.updates):
        try:
            validate_element_patch(u.patch)
        except PatchValidationError as ve:
            for err in ve.errors:
                invalid.append({**err, "update_index": i, "element_id": u.element_id})
    if invalid:
        return error_response(
            ErrorCode.PATCH_SCHEMA_INVALID,
            message=f"{len(invalid)} patch validation error(s) across {len({e['update_index'] for e in invalid})} updates",
            status_code=400,
            data={"validation_errors": invalid},
        )

    svc = _build_service(request)
    try:
        svc._get_project(slide_project_id, required_role="editor")
    except SlideNotFoundError as e:
        return not_found_response(str(e))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except Exception as e:
        return error_response(ErrorCode.ELEMENT_UPDATE_FAILED, f"项目校验失败: {e}")

    editor_id = str(getattr(request.auth, 'id', ''))

    sanitized_updates = [
        {
            "page_id": u.page_id,
            "element_id": u.element_id,
            "patch": _sanitize_element_patch(u.patch),
        }
        for u in body.updates
    ]

    # Y.js-first 路径（成功条件 = 无 error + applied == total + applied > 0）
    # 关键修复：之前 batch-update 只判断 `not error` 就认为成功，导致 Y.Doc
    # 没初始化时 applied=0 也返回 ok=true，Agent 误以为改了。
    yjs_result = _try_dispatch_element_changes_yjs_first(
        project_id=slide_project_id,
        sanitized_updates=sanitized_updates,
        editor_id=editor_id,
    )
    if yjs_result is not None:
        return success_response(yjs_result)

    # DB-first 降级路径
    try:
        db_result = svc.batch_update_elements(
            slide_project_id,
            updates=sanitized_updates,
            base_version=body.base_version,
        )
        db_result["_fallback"] = True
        return success_response(db_result)
    except ConflictError as ce:
        return _conflict_response(ce)
    except (SlideNotFoundError, PageNotFoundError) as e:
        return not_found_response(str(e))
    except PermissionError as e:
        return permission_denied_response(str(e))
    except ValueError as e:
        return validation_error_response(str(e))
    except Exception as e:
        logger.error("batch_update_elements failed: %s", e, exc_info=True)
        return error_response(ErrorCode.ELEMENT_UPDATE_FAILED, f"批量更新失败: {e}")

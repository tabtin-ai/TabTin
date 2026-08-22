from __future__ import annotations

from typing import Any, List, Optional
from uuid import UUID

from django.http import HttpRequest
from ninja import Field, Router, Schema

from apps.tabdoc.schemas import (
    AgentWriteRequest,
    BlockHighlightRequest,
    BlockInsertRequest,
    BlockTextFormatRequest,
    BlockUpdateRequest,
    CommentAttachmentConfirmRequest,
    CommentAttachmentUploadRequest,
    CommentThreadCreateRequest,
    CommentMessageCreateRequest,
    CommentThreadAnchorRequest,
    CommentThreadStatusRequest,
    CreateNamedVersionRequest,
    DocHistoryOut,
    DocumentCreateRequest,
    DocumentImportFileRequest,
    DocumentImportJobCreateRequest,
    DocumentImportMarkdownRequest,
    DocumentOut,
    DocumentPermissionsUpdateRequest,
    DocumentRestoreRequest,
    DocumentRecoveryDraftCreateRequest,
    DocumentRecoveryDraftRestoreRequest,
    DocumentSaveContentRequest,
    DocumentUpdateRequest,
    DocumentVersionOut,
    ExportContentOut,
    HistoryRestoreRequest,
    ImportDraftOut,
    PermissionEntryOut,
    RenameVersionRequest,
    RevisionOut,
    SearchHitOut,
)
from apps.tabdoc.services import (
    COMMENT_THREADS_CAPABILITY,
    ConflictError,
    DocumentExchangeService,
    DocumentCommentService,
    DocumentSearchHit,
    DocumentSearchService,
    DocumentService,
    DocumentImportJobService,
    get_tabdoc_metrics,
)
from apps.tabdoc.services.document_service import (
    normalize_tabdata_snapshot,
)
from apps.tabdoc.services.block_service import (
    BlockNotFoundError,
    BlockService,
    BACKGROUND_COLORS,
    HIGHLIGHT_COLORS,
    SectionAnchorNotHeadingError,
    TEXT_COLORS,
)
from apps.tabdoc.services.share_service import DocumentShareService
from apps.tabdoc.services.comment_attachment_service import CommentAttachmentService
from apps.tabdoc.error_codes import ErrorCode
from apps.services.common.base_schemas import ErrorResponse
from apps.services.oss.services.reactivate_utils import StorageQuotaExceededError
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.services.billing.services.entitlement_limits_service import EntitlementLimitExceeded
from apps.users.membership.exceptions import MembershipException
from apps.i18n import get_text as _
from apps.i18n.response import (
    error_response_with_status as error_response,
    not_found_response,
    permission_denied_response,
    success_response,
    validation_error_response,
)
from apps.services.common.executor import run_in_agent_io_executor
from apps.users.auth.permissions import JWTAuth
from apps.services.common.auth import InternalServiceAuth

import base64
import logging
import re

router = Router(tags=["TabDoc"])
jwt_auth = JWTAuth()
internal_service_auth = InternalServiceAuth()

logger = logging.getLogger("tabdoc.api")

from apps.tabtinspace.services.space_utils import resolve_space_names as _resolve_space_names


def _organization_resource_write_block_response(organization_id: str):
    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        assert_organization_resource_write_allowed,
    )

    try:
        assert_organization_resource_write_allowed(organization_id)
        return None
    except OrganizationControlBlockedError as exc:
        return error_response(
            exc.code,
            message=exc.message,
            status_code=exc.http_status,
            data=exc.to_response_data(),
        )


@router.post(
    "/documents/{document_id}/comment-attachments/presign-upload",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="获取文档评论图片私有上传凭证",
)
def create_document_comment_attachment_upload(
    request: HttpRequest,
    document_id: str,
    payload: CommentAttachmentUploadRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        credential = CommentAttachmentService.issue_upload(
            document,
            user=request.auth,
            file_name=payload.file_name,
            content_type=payload.content_type,
            file_size=payload.file_size,
        )
        return success_response(credential)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post(
    "/documents/{document_id}/comment-attachments/confirm-upload",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="确认文档评论图片私有上传",
)
def confirm_document_comment_attachment_upload(
    request: HttpRequest,
    document_id: str,
    payload: CommentAttachmentConfirmRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        file_record = CommentAttachmentService.confirm_upload(
            document,
            user=request.auth,
            upload_token=payload.upload_token,
        )
        return success_response({
            "attachment": CommentAttachmentService.serialize_confirmed(
                file_record,
                document=document,
            )
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.get(
    "/documents/{document_id}/comment-attachments/{file_id}/preview",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="获取文档评论图片短时预览地址",
)
def preview_document_comment_attachment(
    request: HttpRequest,
    document_id: str,
    file_id: str,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        return success_response(CommentAttachmentService.preview(document, file_id=file_id))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return not_found_response(str(exc))


def _serialize_document(
    document,
    space_name_map: dict[str, str] | None = None,
    *,
    current_user_role: str | None = None,
) -> dict[str, Any]:
    """将 Document ORM 实例序列化为 DocumentOut 兼容字典。

    ``current_user_role``（Wave 5 §D）当 caller 已计算过角色时透传到响应顶层，
    让前端 ``canManage = role in {'admin', 'owner'}`` 不再靠 owner_id 兜底。
    """
    space_id_str = str(document.space_id) if document.space_id else None
    from apps.tabdoc.services.image_asset_service import ImageAssetService

    result = {
        "id": str(document.id),
        "organization_id": str(document.organization_id),
        "space_id": space_id_str,
        "parent_id": str(document.parent_id) if document.parent_id else None,
        "title": document.title,
        "status": document.status,
        "latest_version": document.latest_version,
        # 文档属性
        "icon": document.icon or "",
        "cover_image": ImageAssetService.resolve_cover_url(document),
        "cover_position": document.cover_position if document.cover_position is not None else 0.5,
        "tags": document.tags or [],
        "properties": document.properties or {},
        "is_full_width": bool(document.is_full_width),
        "is_private": bool(getattr(document, "is_private", False)),
        "font_style": document.font_style or "default",
        # 回收站
        "trashed_at": document.trashed_at.isoformat() if getattr(document, "trashed_at", None) else None,
        "trashed_by": str(document.trashed_by) if getattr(document, "trashed_by", None) else None,
        "previous_status": getattr(document, "previous_status", "") or "",
        # 编辑者追踪
        "last_editor_type": getattr(document, "last_editor_type", "") or "",
        "last_editor_id": getattr(document, "last_editor_id", "") or "",
        # 审计
        "owner_id": str(document.owner_id) if getattr(document, "owner_id", None) else None,
        "created_by": str(document.created_by_id) if document.created_by_id else None,
        "updated_by": str(document.updated_by_id) if document.updated_by_id else None,
        "created_at": document.created_at.isoformat() if document.created_at else None,
        "updated_at": document.updated_at.isoformat() if document.updated_at else None,
    }
    if space_name_map is not None:
        result["space_name"] = space_name_map.get(space_id_str, "")
    if current_user_role is not None:
        result["current_user_role"] = current_user_role
    return result


def _document_write_response(
    document,
    *,
    service=None,
    current_user_role: str | None = None,
    **extra_fields: Any,
):
    """写操作成功响应：只返 document 元数据，不回显正文（ CLI/Agent token 优化）。

    Wave 5 §D / ：写响应也必须回填 ``current_user_role``。前端
    ``canManage`` 只认该字段；若保存后整对象替换文档元数据时丢掉角色，
    所有者会偶现「分享面板只读」。
    """
    role = current_user_role
    if role is None and service is not None:
        role = service.compute_user_document_role(document)
    data: dict[str, Any] = {
        "document": _serialize_document(document, current_user_role=role),
    }
    data.update(extra_fields)
    return success_response(data)


def _serialize_revision(revision) -> dict[str, Any]:
    """将 DocumentRevision ORM 实例序列化为 RevisionOut 兼容字典。"""
    content_pm_json, content_markdown = normalize_tabdata_snapshot(
        revision.content_pm_json or {},
        revision.content_markdown or "",
    )
    return {
        "id": str(revision.id),
        "document_id": str(revision.document_id),
        "version": revision.version,
        "content_pm_json": content_pm_json,
        "content_markdown": content_markdown,
        "content_plaintext": revision.content_plaintext,
        "editor_id": str(revision.editor_id) if revision.editor_id else None,
        "created_at": revision.created_at.isoformat() if revision.created_at else None,
    }


def _serialize_version(version) -> dict[str, Any]:
    """将 DocumentVersion ORM 实例序列化为 DocumentVersionOut 兼容字典。"""
    description_json, description_markdown = normalize_tabdata_snapshot(
        version.description_json or {},
        version.description_markdown or "",
    )
    return {
        "id": str(version.id),
        "document_id": str(version.document_id),
        "version": version.version,
        "description_markdown": description_markdown,
        "description_json": description_json,
        "description_plaintext": version.description_plaintext or "",
        "last_saved_at": version.last_saved_at.isoformat() if version.last_saved_at else None,
        "created_by": str(version.created_by_id) if version.created_by_id else None,
        "created_at": version.created_at.isoformat() if version.created_at else None,
    }


def _serialize_version_or_revision(item) -> dict[str, Any]:
    """兼容序列化：DocumentVersion 或 DocumentRevision"""
    from apps.tabdoc.models import DocumentVersion
    if isinstance(item, DocumentVersion):
        return _serialize_version(item)
    return _serialize_revision(item)


def _serialize_permission(entry) -> dict[str, Any]:
    """将 DocumentPermission ORM 实例序列化为 PermissionEntryOut 兼容字典。"""
    return {
        "id": str(entry.id),
        "document_id": str(entry.document_id),
        "subject_type": entry.subject_type,
        "subject_id": entry.subject_id,
        "permission": entry.permission,
        "is_active": entry.is_active,
        "created_by": str(entry.created_by_id) if entry.created_by_id else None,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
        "updated_at": entry.updated_at.isoformat() if entry.updated_at else None,
    }


def _serialize_recovery_draft(draft, *, include_content: bool = False) -> dict[str, Any]:
    data = {
        "id": str(draft.id),
        "document_id": str(draft.document_id),
        "base_version": draft.base_version,
        "status": draft.status,
        "created_at": draft.created_at.isoformat() if draft.created_at else None,
        "expires_at": draft.expires_at.isoformat() if draft.expires_at else None,
        "restored_at": draft.restored_at.isoformat() if draft.restored_at else None,
        "creator_id": str(draft.creator_id) if draft.creator_id else None,
    }
    if include_content:
        data.update({
            "content_pm_json": draft.content_pm_json or {},
            "content_markdown": draft.content_markdown or "",
            "content_plaintext": draft.content_plaintext or "",
        })
    return data


def _serialize_search_hit(hit: DocumentSearchHit, space_name_map: dict[str, str] | None = None) -> dict[str, Any]:
    """将 DocumentSearchHit 序列化为 SearchHitOut 兼容字典。"""
    return {
        "document": _serialize_document(hit.document, space_name_map),
        "snippet": hit.snippet,
        "relevance_score": hit.relevance_score,
        "matched_on_title": hit.matched_on_title,
        "block_id": hit.block_id,
        "block_type": hit.block_type,
        "block_index": hit.block_index,
        "block_preview": hit.block_preview,
    }


def _build_service(request: HttpRequest) -> DocumentService:
    return DocumentService(user=request.auth)


def _build_search_service(request: HttpRequest) -> DocumentSearchService:
    return DocumentSearchService(user=request.auth)


def _build_exchange_service(request: HttpRequest) -> DocumentExchangeService:
    return DocumentExchangeService(user=request.auth)


def _build_import_job_service(request: HttpRequest) -> DocumentImportJobService:
    return DocumentImportJobService(user=request.auth)


class DocumentCommentCreateRequest(Schema):
    """登录后在文档详情内新增评论。"""

    body: str
    selected_text: str = ""
    author_name: str = ""
    mention_user_ids: List[str] = Field(default_factory=list)


@router.post("/import/markdown", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="导入 Markdown 草稿")
def import_markdown_draft(request: HttpRequest, payload: DocumentImportMarkdownRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_exchange_service(request)
    try:
        result = service.import_markdown_draft(
            organization_id=payload.organization_id,
            markdown=payload.markdown or "",
        )
        return success_response(result)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except EntitlementLimitExceeded as exc:
        return error_response(exc.code, message=str(exc), status_code=403, data=exc.to_response_data())
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post(
    "/import/jobs",
    response={202: dict, 400: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="创建 TabDoc 文件导入任务",
)
def create_import_job(request: HttpRequest, payload: DocumentImportJobCreateRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_import_job_service(request)
    try:
        create_kwargs = {
            "organization_id": payload.organization_id,
            "file_record_id": payload.file_record_id,
        }
        if payload.selected_model_id is not None:
            create_kwargs["selected_model_id"] = payload.selected_model_id
        job, created = service.create_job(
            **create_kwargs,
        )
        return 202, success_response({
            "job": service.serialize_job(job),
            "created": created,
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except EntitlementLimitExceeded as exc:
        return error_response(exc.code, message=str(exc), status_code=403, data=exc.to_response_data())
    except ValueError as exc:
        return validation_error_response(str(exc))
    except Exception as exc:
        logger.exception("create_import_job failed: %s", exc)
        return error_response(ErrorCode.INTERNAL_ERROR, str(exc), status_code=500)


@router.post(
    "/import/file",
    response={202: dict, 400: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="从 PDF/Word 文件导入文档（兼容：返回后台任务）",
)
def import_from_file(request: HttpRequest, payload: DocumentImportFileRequest):
    return create_import_job(request, DocumentImportJobCreateRequest(**payload.model_dump()))


@router.get(
    "/import/jobs/{job_id}",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="获取 TabDoc 文件导入任务状态",
)
def get_import_job(request: HttpRequest, job_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_import_job_service(request)
    try:
        job = service.get_job(job_id)
        return success_response({"job": service.serialize_job(job)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))
    except Exception as exc:
        from apps.services.docparse.models import DocumentImportJob
        if isinstance(exc, DocumentImportJob.DoesNotExist):
            return not_found_response("导入任务")
        logger.exception("get_import_job failed: %s", exc)
        return error_response(ErrorCode.INTERNAL_ERROR, str(exc), status_code=500)


@router.get(
    "/import/jobs/{job_id}/result",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="获取 TabDoc 文件导入任务结果",
)
def get_import_job_result(request: HttpRequest, job_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_import_job_service(request)
    try:
        job = service.get_result(job_id)
        return success_response({"job": service.serialize_result(job)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return error_response("IMPORT_JOB_NOT_READY", message=str(exc), status_code=409)
    except Exception as exc:
        from apps.services.docparse.models import DocumentImportJob
        if isinstance(exc, DocumentImportJob.DoesNotExist):
            return not_found_response("导入任务")
        logger.exception("get_import_job_result failed: %s", exc)
        return error_response(ErrorCode.INTERNAL_ERROR, str(exc), status_code=500)


@router.post(
    "/import/jobs/{job_id}/retry",
    response={202: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="重试 TabDoc 文件导入任务",
)
def retry_import_job(request: HttpRequest, job_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_import_job_service(request)
    try:
        job, created = service.retry_job(job_id)
        return 202, success_response({
            "job": service.serialize_job(job),
            "created": created,
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))
    except Exception as exc:
        from apps.services.docparse.models import DocumentImportJob
        if isinstance(exc, DocumentImportJob.DoesNotExist):
            return not_found_response("导入任务")
        logger.exception("retry_import_job failed: %s", exc)
        return error_response(ErrorCode.INTERNAL_ERROR, str(exc), status_code=500)


@router.post(
    "/import/jobs/{job_id}/cancel",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="取消 TabDoc 文件导入任务",
)
def cancel_import_job(request: HttpRequest, job_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_import_job_service(request)
    try:
        job = service.cancel_job(job_id)
        return success_response({"job": service.serialize_job(job)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))
    except Exception as exc:
        from apps.services.docparse.models import DocumentImportJob
        if isinstance(exc, DocumentImportJob.DoesNotExist):
            return not_found_response("导入任务")
        logger.exception("cancel_import_job failed: %s", exc)
        return error_response(ErrorCode.INTERNAL_ERROR, str(exc), status_code=500)


@router.get("/search", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="全文检索文档")
def search_documents(
    request: HttpRequest,
    organization_id: str,
    q: str,
    space_id: str | None = None,
    page: int = 1,
    page_size: int = 20,
    scope: str = "organization",
):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_search_service(request)
    try:
        effective_scope = "organization" if not space_id else scope
        result = service.search_documents(
            organization_id=organization_id,
            space_id=space_id,
            keyword=q,
            page=page,
            page_size=page_size,
            scope=effective_scope,
        )
        sn_map = _resolve_space_names(
            [hit.document.space_id for hit in result["items"] if hit.document.space_id]
        ) if effective_scope == "organization" else None
        return success_response(
            {
                "items": [_serialize_search_hit(item, sn_map) for item in result["items"]],
                "total": result["total"],
                "page": result["page"],
                "page_size": result["page_size"],
                "total_pages": result["total_pages"],
                "query": result["query"],
            }
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.get("/metrics/summary", response={200: dict, 403: ErrorResponse}, auth=jwt_auth, summary="Tabdoc 指标摘要")
def get_tabdoc_metrics_summary(request: HttpRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    return success_response(get_tabdoc_metrics().snapshot())


def _build_attachment_disposition(filename: str) -> str:
    """构造 DOCX 导出的 Content-Disposition（仅 RFC 5987 ``filename*``）。

    统一走 ``filename*=UTF-8''`` + 百分号编码，避免 ``filename=`` 的 Latin-1
    限制或中文被替成下划线；不另设自定义响应头。
    """
    from urllib.parse import quote

    return f"attachment; filename*=UTF-8''{quote(filename, safe='')}"


@router.get("/documents/{document_id}/export", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="导出文档内容")
def export_document_content(request: HttpRequest, document_id: str, format: str = "markdown"):
    from django.http import HttpResponse as DjangoHttpResponse

    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_exchange_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        result = service.export_document_content(document, export_format=format)

        if result.get("content_bytes") is not None:
            response = DjangoHttpResponse(
                result["content_bytes"],
                content_type=result["mime_type"],
            )
            response["Content-Disposition"] = _build_attachment_disposition(result["filename"])
            return response

        return success_response(result)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        logger.exception("文档导出校验错误: document_id=%s, format=%s", document_id, format)
        return validation_error_response(str(exc))
    except RuntimeError as exc:
        logger.exception("文档导出运行时错误: document_id=%s, format=%s", document_id, format)
        return validation_error_response(str(exc))
    except Exception as exc:
        logger.exception("文档导出异常: document_id=%s, format=%s", document_id, format)
        return error_response(ErrorCode.INTERNAL_ERROR, _("tabdoc.export_internal_error"), status_code=500)


@router.get("/documents", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="列出项目文档")
def list_documents(
    request: HttpRequest,
    organization_id: str,
    space_id: str | None = None,
    parent_id: str | None = None,
    include_archived: bool = False,
    scope: str = "organization",
    page: int = 1,
    page_size: int = 200,
):
    if not request.auth:
        return permission_denied_response("Need login")
    page_size = min(page_size, 500)
    service = _build_service(request)
    try:
        effective_scope = "organization" if not space_id else scope
        page_docs, total = service.list_documents(
            organization_id=organization_id,
            space_id=space_id,
            parent_id=parent_id,
            include_archived=include_archived,
            scope=effective_scope,
            page=page,
            page_size=page_size,
        )
        sn_map = _resolve_space_names(
            [doc.space_id for doc in page_docs if doc.space_id]
        ) if effective_scope == "organization" else None
        return success_response({
            "documents": [_serialize_document(doc, sn_map) for doc in page_docs],
            "total": total,
            "page": page,
            "page_size": page_size,
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="创建文档")
def create_document(request: HttpRequest, payload: DocumentCreateRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        block_response = _organization_resource_write_block_response(payload.organization_id)
        if block_response is not None:
            return block_response
        document = service.create_document(
            organization_id=payload.organization_id,
            parent_id=payload.parent_id,
            collection_id=payload.collection_id,
            parent_item_id=payload.parent_item_id,
            title=payload.title or "",
            icon=payload.icon or "",
            cover_image=payload.cover_image or "",
            initial_content_pm_json=payload.initial_content_pm_json,
            initial_content_markdown=payload.initial_content_markdown,
            initial_content_plaintext=payload.initial_content_plaintext,
        )
        return _document_write_response(document, service=service, latest_revision=None)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except EntitlementLimitExceeded as exc:
        return error_response(exc.code, message=str(exc), status_code=403, data=exc.to_response_data())
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.get("/documents/{document_id}", response={200: dict, 403: ErrorResponse, 404: ErrorResponse}, auth=jwt_auth, summary="获取文档详情")
def get_document(request: HttpRequest, document_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        # 新架构: 内容直接在 Document 上。兼容旧数据: 如果 Document 没有内容，回退到 Revision。
        latest_revision = service.get_latest_revision(document)
        description_json, description_markdown = normalize_tabdata_snapshot(
            document.description_json or {},
            document.description_markdown or "",
        )
        content = {
            "description_json": description_json,
            "description_markdown": description_markdown,
            "description_plaintext": document.description_plaintext or "",
        }
        if latest_revision:
            revision_json, revision_markdown = normalize_tabdata_snapshot(
                latest_revision.content_pm_json or {},
                latest_revision.content_markdown or "",
            )
            content = {
                "description_json": revision_json,
                "description_markdown": revision_markdown,
                "description_plaintext": latest_revision.content_plaintext or "",
            }
        from apps.tabdoc.services.image_asset_service import ImageAssetService
        from apps.tabdoc.services.markdown_exchange import pm_json_to_markdown

        materialized_json = ImageAssetService.materialize_pm_json(
            document,
            content["description_json"],
        )
        content["description_json"] = materialized_json
        materialized_markdown = pm_json_to_markdown(materialized_json)
        if materialized_markdown:
            content["description_markdown"] = materialized_markdown
        # Wave 5 §D：回填 current_user_role 让前端 canManage 不再兜底
        current_user_role = service.compute_user_document_role(document)
        return success_response(
            {
                "document": _serialize_document(document, current_user_role=current_user_role),
                "content": content,
                # 兼容旧前端 — latest_revision 字段仍保留
                "latest_revision": _serialize_revision(latest_revision) if latest_revision else None,
            }
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        msg = str(exc)
        # R-B8：agent 经常误把完整文档 URL 当 document_id 传进来
        # （如 https://www.example.com/space/.../docs/<uuid>），原响应给的是
        # 干净的 404/400 但没有提示 agent"剥出真实 ID 后重试"。
        # 这里在 URL 形态下提前给一条 actionable hint，并统一返 404 让
        # 上层逻辑（CLI exit code、retry policy）按"找不到资源"处理。
        if "://" in str(document_id):
            import re

            doc_match = re.search(r"doc_[a-zA-Z0-9_-]+", str(document_id))
            uuid_match = re.search(
                r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
                str(document_id),
            )
            extracted = (
                doc_match.group(0) if doc_match
                else uuid_match.group(0) if uuid_match
                else None
            )
            hint = (
                f"看起来你传了 URL 而不是 document_id；尝试用 '{extracted}' 重试。"
                if extracted else
                "看起来你传了 URL 而不是 document_id。请从 URL 中提取真实 "
                "document_id（UUID 或 doc_xxx 形式）后重试。"
            )
            return error_response(
                "NOT_FOUND",
                message=msg or _("tabdoc.document_not_found"),
                status_code=404,
                data={"hint": hint},
            )
        if "uuid" in msg.lower() or "format" in msg.lower():
            return validation_error_response(msg)
        return not_found_response(msg)


@router.get(
    "/documents/{document_id}/html-artifacts/{file_id}",
    auth=jwt_auth,
    summary="受控读取文档 HTML 嵌入块内容",
)
def get_document_html_artifact(request: HttpRequest, document_id: UUID, file_id: UUID):
    """登录成员按文档 viewer 权限读取私有 HTML artifact 字节。"""
    from apps.tabdoc.services.html_artifact_service import (
        HtmlArtifactAccessError,
        HtmlArtifactService,
        build_html_artifact_response,
    )

    if not request.auth:
        return permission_denied_response("Need login")
    try:
        payload = HtmlArtifactService.load_for_document_member(
            document_id=document_id,
            file_id=file_id,
            user=request.auth,
        )
    except HtmlArtifactAccessError:
        return not_found_response(_("tabdoc.document_not_found"))
    return build_html_artifact_response(payload)


@router.get(
    "/documents/{document_id}/image-assets/{file_id}",
    auth=jwt_auth,
    summary="按文档权限获取私有图片短期地址",
)
def get_document_image_asset(request: HttpRequest, document_id: UUID, file_id: UUID):
    from apps.tabdoc.services.image_asset_service import (
        ImageAssetAccessError,
        ImageAssetService,
    )

    if not request.auth:
        return permission_denied_response("Need login")
    try:
        accessible = ImageAssetService.resolve_for_document_member(
            document_id=document_id,
            file_id=file_id,
            user=request.auth,
        )
    except ImageAssetAccessError:
        return not_found_response(_("tabdoc.document_not_found"))
    return success_response({
        "url": accessible.url,
        "access_mode": accessible.access_mode,
        "expires_in": accessible.expires_in,
        "expires_at": accessible.expires_at,
    })


@router.get(
    "/documents/{document_id}/html-blocks/{block_id}/browser-link",
    auth=jwt_auth,
    summary="获取 HTML 块「在浏览器打开」链接上下文",
)
def get_html_block_browser_link(
    request: HttpRequest,
    document_id: UUID,
    block_id: str,
    file_id: str = "",
):
    """登录 viewer 返回 documentId + blockId + 当前文档 effective share_id（可空）。

    不授予分享管理权；块不存在 → 404。
    ``file_id`` 可选：协作未落库时由编辑器传入，仅成员 ACL 校验绑定后作短期兜底。
    """
    from apps.tabdoc.services.html_artifact_service import (
        HtmlArtifactAccessError,
        HtmlArtifactService,
    )

    if not request.auth:
        return permission_denied_response("Need login")
    try:
        payload = HtmlArtifactService.get_browser_link_context(
            document_id=document_id,
            block_id=block_id,
            user=request.auth,
            client_file_id=file_id or "",
        )
    except HtmlArtifactAccessError as exc:
        if exc.reason == "block_missing":
            return not_found_response(_("tabdoc.html_block_not_found"))
        if exc.reason == "permission_denied":
            return not_found_response(_("tabdoc.document_not_found"))
        return not_found_response(_("tabdoc.document_not_found"))
    return success_response(payload)


@router.get(
    "/documents/{document_id}/comments",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="获取文档评论",
)
def list_document_comments(request: HttpRequest, document_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        comments = DocumentShareService.list_document_comments(document)
        return success_response({
            "comments": comments,
            "capabilities": [COMMENT_THREADS_CAPABILITY],
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return not_found_response(str(exc))


@router.post(
    "/documents/{document_id}/comments",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="新增文档评论",
)
def create_document_comment(
    request: HttpRequest,
    document_id: str,
    payload: DocumentCommentCreateRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        comment = DocumentShareService.create_document_comment(
            document,
            user=request.auth,
            body=payload.body,
            selected_text=payload.selected_text,
            author_name=payload.author_name,
            mention_user_ids=payload.mention_user_ids,
        )
        return success_response({"comment": DocumentShareService.serialize_comment(comment)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        message = str(exc)
        if "评论" in message:
            return validation_error_response(message)
        return not_found_response(message)


@router.delete(
    "/documents/{document_id}/comments/{comment_id}",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="删除文档评论",
)
def delete_document_comment(request: HttpRequest, document_id: str, comment_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        comment = DocumentShareService.delete_document_comment(
            document,
            comment_id=comment_id,
            user=request.auth,
        )
        return success_response({"deleted": True, "comment_id": str(comment.id)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return not_found_response(str(exc))


@router.get(
    "/documents/{document_id}/comment-threads",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="获取文档评论线程",
)
def list_document_comment_threads(request: HttpRequest, document_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        return success_response({
            "threads": DocumentCommentService.list_threads(document),
            "capabilities": [COMMENT_THREADS_CAPABILITY],
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return not_found_response(str(exc))


@router.post(
    "/documents/{document_id}/comment-threads",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="新增文档评论线程",
)
def create_document_comment_thread(
    request: HttpRequest,
    document_id: str,
    payload: CommentThreadCreateRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        thread = DocumentCommentService.create_thread(
            document,
            user=request.auth,
            body=payload.body,
            scope=payload.scope,
            anchor=payload.anchor,
            selected_text=payload.selected_text,
            author_name=payload.author_name,
            mention_user_ids=payload.mention_user_ids,
            attachment_ids=payload.attachment_ids,
            client_request_id=payload.client_request_id,
        )
        return success_response({"thread": DocumentCommentService.serialize_thread(thread)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        message = str(exc)
        if "评论" in message:
            return validation_error_response(message)
        return not_found_response(message)


@router.post(
    "/documents/{document_id}/comment-threads/{thread_id}/messages",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="回复文档评论线程",
)
def create_document_comment_message(
    request: HttpRequest,
    document_id: str,
    thread_id: str,
    payload: CommentMessageCreateRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        message = DocumentCommentService.reply(
            document,
            thread_id,
            user=request.auth,
            body=payload.body,
            author_name=payload.author_name,
            mention_user_ids=payload.mention_user_ids,
            attachment_ids=payload.attachment_ids,
            client_request_id=payload.client_request_id,
        )
        return success_response({"message": DocumentCommentService.serialize_message(message)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        if "不存在" in str(exc):
            return not_found_response(str(exc))
        return validation_error_response(str(exc))


@router.patch(
    "/documents/{document_id}/comment-threads/{thread_id}/status",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="解决或重开文档评论线程",
)
def update_document_comment_thread_status(
    request: HttpRequest,
    document_id: str,
    thread_id: str,
    payload: CommentThreadStatusRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        thread = DocumentCommentService.update_status(
            document,
            thread_id,
            user=request.auth,
            status=payload.status,
        )
        return success_response({"thread": DocumentCommentService.serialize_thread(thread)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        if "不存在" in str(exc):
            return not_found_response(str(exc))
        return validation_error_response(str(exc))


@router.patch(
    "/documents/{document_id}/comment-threads/{thread_id}/anchor",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="重新关联文档评论线程锚点",
)
def reanchor_document_comment_thread(
    request: HttpRequest,
    document_id: str,
    thread_id: str,
    payload: CommentThreadAnchorRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        thread = DocumentCommentService.reanchor(
            document,
            thread_id,
            user=request.auth,
            scope=payload.scope,
            anchor=payload.anchor,
        )
        return success_response({"thread": DocumentCommentService.serialize_thread(thread)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        if "不存在" in str(exc):
            return not_found_response(str(exc))
        return validation_error_response(str(exc))


@router.delete(
    "/documents/{document_id}/comment-threads/{thread_id}",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="删除文档评论线程",
)
def delete_document_comment_thread(
    request: HttpRequest,
    document_id: str,
    thread_id: str,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        deleted_thread_id = DocumentCommentService.delete_thread(
            document,
            thread_id,
            user=request.auth,
        )
        return success_response({"deleted": True, "thread_id": deleted_thread_id})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return not_found_response(str(exc))


@router.delete(
    "/documents/{document_id}/comment-threads/{thread_id}/messages/{message_id}",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="删除文档评论消息",
)
def delete_document_comment_message(
    request: HttpRequest,
    document_id: str,
    thread_id: str,
    message_id: str,
):
    if not request.auth:
        return permission_denied_response("Need login")
    try:
        document = _build_service(request).get_document(document_id, required_role="viewer")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        message = DocumentCommentService.delete_message(
            document,
            thread_id,
            message_id,
            user=request.auth,
        )
        return success_response({"deleted": True, "message_id": str(message.id)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return not_found_response(str(exc))


@router.get(
    "/documents/{document_id}/blocks",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="列出文档 Block 大纲",
)
def list_document_blocks(request: HttpRequest, document_id: str):
    """返回顶层 block 大纲（id / type / level / preview / index）。

    比 GET /documents/{id} 取完整 PM JSON 省 token，适合 LLM 决定下一步读哪个段落。
    """
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        blocks = service.list_outline_blocks(document)
        return success_response(
            {
                "document": _serialize_document(document),
                "blocks": blocks,
                "total": len(blocks),
            }
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        msg = str(exc)
        if "uuid" in msg.lower() or "format" in msg.lower():
            return validation_error_response(msg)
        return not_found_response(msg)


@router.get(
    "/documents/{document_id}/search-blocks",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="在文档内搜索 Block",
)
def search_document_blocks(request: HttpRequest, document_id: str, q: str, limit: int = 20):
    """在单篇文档的顶层 block 内做关键词搜索，返回可直接用于 read-block 的 block_id。"""
    if not request.auth:
        return permission_denied_response("Need login")
    if not (q or "").strip():
        return validation_error_response("q 不能为空")
    if limit <= 0:
        return validation_error_response("limit 必须为正整数")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        result = BlockService(service).search_blocks(document, q, limit=limit)
        return success_response(
            {
                "document": _serialize_document(document),
                "blocks": result["items"],
                "total": result["total"],
                "query": result["query"],
                "limit": result["limit"],
            }
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        msg = str(exc)
        if "uuid" in msg.lower() or "format" in msg.lower():
            return validation_error_response(msg)
        return not_found_response(msg)


# ── Block 级编辑（TD-3）──
# 精准读 / 改 / 插 / 删单个顶层 block，省 token、缩小冲突面；写操作统一经
# BlockService → DocumentService.save_content，继承 TD-1 VH + agent 归因、TD-2 replace。
# agent 归因沿用现有内容端点链路（用户 JWT + X-Tabtin-Agent-Run-Id 头 +
# AgentRunContextMiddleware），save_content 内部按 context 记 editor_type=agent。

@router.get(
    "/documents/{document_id}/blocks/{block_id}",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="读取单个 block 的 Markdown",
)
def read_document_block(request: HttpRequest, document_id: str, block_id: str):
    """读取指定顶层 block 的 markdown（比整篇读省 token）。block_id 取自 list-blocks。"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        result = BlockService(service).read_block(document, block_id)
        return success_response(
            {
                "document": _serialize_document(document),
                "block_id": result["block_id"],
                "block_type": result["block_type"],
                "markdown": result["markdown"],
            }
        )
    except BlockNotFoundError as exc:
        return not_found_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        msg = str(exc)
        if "uuid" in msg.lower() or "format" in msg.lower():
            return validation_error_response(msg)
        return not_found_response(msg)


@router.get(
    "/documents/{document_id}/sections/{heading_block_id}",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="读取章节（heading 锚点起，到下一个同级/更高级 heading 前）",
)
def read_document_section(
    request: HttpRequest,
    document_id: str,
    heading_block_id: str,
    format: str = "markdown",
    max_depth: Optional[int] = None,
):
    """读取以 heading_block_id 为锚点的完整章节：标题本身 + 其后正文，直到下一个同级/
    更高级标题前。format=markdown 返回整段 Markdown，outline 返回逐块明细；max_depth
    限制只收集到 L+max_depth 级子标题。锚点非 heading 返回 400，锚点不存在返回 404。"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        result = BlockService(service).read_section(
            document,
            heading_block_id,
            fmt=format,
            max_depth=max_depth,
        )
        payload = {
            "document": _serialize_document(document),
            "heading_block_id": result["heading_block_id"],
            "heading_level": result["heading_level"],
            "block_ids": result["block_ids"],
            "block_count": result["block_count"],
            "format": result["format"],
            "base_version": result["base_version"],
            "base_updated_at": result["base_updated_at"],
        }
        if result["format"] == "outline":
            payload["blocks"] = result["blocks"]
        else:
            payload["markdown"] = result["markdown"]
        return success_response(payload)
    except SectionAnchorNotHeadingError as exc:
        return validation_error_response(str(exc))
    except BlockNotFoundError as exc:
        return not_found_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.patch(
    "/documents/{document_id}/blocks/{block_id}",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="更新单个 block（Markdown 替换）",
)
def update_document_block(request: HttpRequest, document_id: str, block_id: str, payload: BlockUpdateRequest):
    """用一段 markdown 替换指定 block；其余 block 原样不动。"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        result = BlockService(service).update_block(
            document,
            block_id,
            payload.markdown,
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
        )
        updated_doc = result["document"]
        return success_response(
            {
                "document": _serialize_document(updated_doc),
                "block_id": result["block_id"],
                "updated_blocks": result["updated_blocks"],
            }
        )
    except BlockNotFoundError as exc:
        return not_found_response(str(exc))
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post(
    "/documents/{document_id}/blocks/{block_id}/highlight",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="给 block 内精确文本添加原生高亮",
)
def highlight_document_block_text(
    request: HttpRequest,
    document_id: str,
    block_id: str,
    payload: BlockHighlightRequest,
):
    """仅修改一段已精确定位的文本，保留现有富文本 marks 与其余文档内容。"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        result = BlockService(service).highlight_text(
            document,
            block_id,
            payload.text,
            color=HIGHLIGHT_COLORS[payload.color],
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
        )
        return success_response(
            {
                "document": _serialize_document(result["document"]),
                "block_id": result["block_id"],
                "matched_text": result["matched_text"],
                "matched_occurrences": result["matched_occurrences"],
                "color": payload.color,
            }
        )
    except BlockNotFoundError as exc:
        return not_found_response(str(exc))
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post(
    "/documents/{document_id}/blocks/{block_id}/format-text",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="配置 block 内精确文本的原生富文本样式",
)
def format_document_block_text(
    request: HttpRequest,
    document_id: str,
    block_id: str,
    payload: BlockTextFormatRequest,
):
    """按 TabDoc 文字工具栏的能力局部配置唯一文本范围，不重写 Markdown。"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        result = BlockService(service).format_text(
            document,
            block_id,
            payload.text,
            bold=payload.bold,
            italic=payload.italic,
            underline=payload.underline,
            strike=payload.strike,
            code=payload.code,
            text_color=TEXT_COLORS.get(payload.text_color) if payload.text_color not in {None, "default"} else None,
            clear_text_color=payload.text_color == "default",
            background_color=BACKGROUND_COLORS.get(payload.background_color) if payload.background_color not in {None, "default"} else None,
            clear_background_color=payload.background_color == "default",
            link_url=payload.link_url,
            remove_link=payload.remove_link,
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
        )
        return success_response(
            {
                "document": _serialize_document(result["document"]),
                "block_id": result["block_id"],
                "matched_text": result["matched_text"],
                "matched_occurrences": result["matched_occurrences"],
                "applied": result["applied"],
            }
        )
    except BlockNotFoundError as exc:
        return not_found_response(str(exc))
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post(
    "/documents/{document_id}/blocks",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="插入 block（可指定 after_block_id 或 at_start，缺省末尾追加）",
)
def insert_document_block(request: HttpRequest, document_id: str, payload: BlockInsertRequest):
    """在指定位置插入 markdown；不传位置即末尾追加（append）。"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        result = BlockService(service).insert_block(
            document,
            payload.markdown,
            after_block_id=payload.after_block_id,
            at_start=payload.at_start,
            image_file_id=payload.image_file_id,
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
        )
        updated_doc = result["document"]
        return success_response(
            {
                "document": _serialize_document(updated_doc),
                "inserted_block_ids": result["inserted_block_ids"],
                "after_block_id": result["after_block_id"],
            }
        )
    except BlockNotFoundError as exc:
        return not_found_response(str(exc))
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.delete(
    "/documents/{document_id}/blocks/{block_id}",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="删除单个 block",
)
def delete_document_block(
    request: HttpRequest,
    document_id: str,
    block_id: str,
    base_version: int | None = None,
    base_updated_at: str | None = None,
):
    """删除指定 block；相邻 block 顺序保持不变。base_version 走 query 参做可选并发保护。"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        result = BlockService(service).delete_block(
            document,
            block_id,
            base_version=base_version,
            base_updated_at=base_updated_at,
        )
        updated_doc = result["document"]
        return success_response(
            {
                "document": _serialize_document(updated_doc),
                "deleted_block_id": result["deleted_block_id"],
            }
        )
    except BlockNotFoundError as exc:
        return not_found_response(str(exc))
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.patch("/documents/{document_id}", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse}, auth=jwt_auth, summary="更新文档元数据")
def update_document(request: HttpRequest, document_id: str, payload: DocumentUpdateRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        updated = service.update_document(
            document,
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
            title=payload.title,
            parent_id=payload.parent_id,
            collection_id=payload.collection_id,
            status=payload.status,
            icon=payload.icon,
            cover_image=payload.cover_image,
            cover_position=payload.cover_position,
            tags=payload.tags,
            properties=payload.properties,
            is_full_width=payload.is_full_width,
            font_style=payload.font_style,
            is_private=payload.is_private,
        )
        # ：元数据 PATCH 同样回填 current_user_role，避免前端 patch 整文档时丢角色
        current_user_role = service.compute_user_document_role(updated)
        return success_response(
            {"document": _serialize_document(updated, current_user_role=current_user_role)}
        )
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.delete("/documents/{document_id}", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="归档文档")
def archive_document(request: HttpRequest, document_id: str):
    """
    归档文档（软删除）。

    ⚠️ 语义说明：此 DELETE 端点执行的是"归档"操作而非永久删除。
    文档归档后状态变为 archived，仍可通过 restore 恢复。
    真正的永久删除请使用 DELETE /documents/{document_id}/permanent。

    这是出于业务安全考量的设计决策：防止误操作导致数据不可恢复。
    """
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        archived = service.archive_document(document)
        return success_response({"document": _serialize_document(archived)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents/{document_id}/unarchive", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="从归档恢复")
def unarchive_document(request: HttpRequest, document_id: str):
    """TDOC-6: 从归档状态恢复文档，reactivate FileUsage。"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        if document.status != "archived":
            return validation_error_response(_("tabdoc.document_not_archived"))
        restored = service.unarchive_document(document)
        return success_response({"document": _serialize_document(restored)})
    except StorageQuotaExceededError as exc:
        return validation_error_response(
            f"存储空间不足，无法恢复。需要 {exc.required_bytes} 字节，可用 {exc.available_bytes} 字节。"
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents/{document_id}/trash", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="移入回收站")
def trash_document(request: HttpRequest, document_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        # ：与 trash_document 服务层一致，要求 resource admin
        # ：允许取已 trashed 文档，服务层幂等补齐 ContextItem 投影
        document = service.get_document(document_id, required_role="admin", allow_trashed=True)
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        trashed = service.trash_document(document)
        return success_response({"document": _serialize_document(trashed)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents/{document_id}/restore-from-trash", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="从回收站恢复")
def restore_document_from_trash(request: HttpRequest, document_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        # 个人回收站：删除者可恢复
        document = service.get_trashed_document_for_personal_trash(document_id)
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        restored = service.restore_document(document)
        return success_response({"document": _serialize_document(restored)})
    except StorageQuotaExceededError as exc:
        return validation_error_response(
            f"存储空间不足，无法恢复。需要 {exc.required_bytes} 字节，可用 {exc.available_bytes} 字节。"
        )
    except MembershipException as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.delete("/documents/{document_id}/permanent", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="永久删除")
def permanent_delete_document(request: HttpRequest, document_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_trashed_document_for_personal_trash(document_id)
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        service.permanent_delete_document(document)
        return success_response({"deleted": True})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents/{document_id}/content", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse}, auth=jwt_auth, summary="保存文档内容")
def save_document_content(request: HttpRequest, document_id: str, payload: DocumentSaveContentRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        if payload.write_intent != "replace":
            # Migration window: old callers remain safe behind their existing
            # version checks, while every first-party caller now sends the
            # explicit intent.  Metrics/logs identify remaining callers before
            # the final hard rejection is enabled.
            logger.warning(
                "deprecated implicit whole-document write: doc=%s user=%s",
                document_id,
                getattr(request.auth, "id", None),
            )
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        updated_doc = service.save_content(
            document,
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
            title=payload.title,
            content_pm_json=payload.content_pm_json,
            content_markdown=payload.content_markdown,
            content_plaintext=payload.content_plaintext,
        )
        return _document_write_response(updated_doc, service=service)
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents/{document_id}/recovery-drafts", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="保全无法自动合并的本地草稿")
def create_document_recovery_draft(request: HttpRequest, document_id: str, payload: DocumentRecoveryDraftCreateRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        draft = service.create_recovery_draft(
            document,
            base_version=payload.base_version,
            content_pm_json=payload.content_pm_json,
            content_markdown=payload.content_markdown,
            content_plaintext=payload.content_plaintext,
        )
        return success_response({"recovery_draft": _serialize_recovery_draft(draft)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.get("/documents/{document_id}/recovery-drafts", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="列出文档恢复草稿")
def list_document_recovery_drafts(request: HttpRequest, document_id: str, limit: int = 50):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        drafts = service.list_recovery_drafts(document, limit=limit)
        return success_response({"recovery_drafts": [_serialize_recovery_draft(draft) for draft in drafts]})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents/{document_id}/recovery-drafts/{recovery_id}/restore", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse}, auth=jwt_auth, summary="显式恢复本地草稿")
def restore_document_recovery_draft(
    request: HttpRequest,
    document_id: str,
    recovery_id: str,
    payload: DocumentRecoveryDraftRestoreRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        updated = service.restore_recovery_draft(
            document,
            recovery_id,
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
        )
        return _document_write_response(updated, service=service, recovery_id=recovery_id)
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.get("/documents/{document_id}/revisions", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="获取版本列表")
def list_document_revisions(request: HttpRequest, document_id: str, limit: int = 20, offset: int = 0):
    """
    获取文档版本列表。

    Args:
        limit: 每页条数，默认 20，最大 200
        offset: 偏移量，用于翻页，默认 0
    """
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        items = service.list_revisions(document, limit=limit, offset=offset)
        return success_response({
            "revisions": [_serialize_version_or_revision(item) for item in items],
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents/{document_id}/restore", response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse}, auth=jwt_auth, summary="恢复到指定版本")
def restore_document_revision(request: HttpRequest, document_id: str, payload: DocumentRestoreRequest):
    """@deprecated: Use collab API POST /collab/v1/docs/{id}/restore instead.

    P0-05: 此端点为还原路径 C/D，已补全三件套但仍建议使用统一的 collab 路径。
    """
    if not request.auth:
        return permission_denied_response("Need login")
    logger.warning(
        "Deprecated restore path C/D used via POST /documents/%s/restore, "
        "prefer collab API POST /collab/v1/docs/{id}/restore",
        document_id,
    )
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        # 支持两种恢复方式: version_id（新 DocumentVersion）或 version（旧 Revision 版本号）
        if payload.version_id:
            updated_doc = service.restore_version(
                document,
                version_id=payload.version_id,
                base_version=payload.base_version,
                base_updated_at=payload.base_updated_at,
            )
        elif payload.version is not None:
            updated_doc = service.restore_revision(
                document,
                version=payload.version,
                base_version=payload.base_version,
                base_updated_at=payload.base_updated_at,
            )
        else:
            return validation_error_response(_("tabdoc.version_or_version_id_required"))
        return _document_write_response(updated_doc, service=service)
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.get("/documents/{document_id}/permissions", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="获取文档权限覆盖")
def get_document_permissions(request: HttpRequest, document_id: str):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="admin")
        entries = service.list_permissions(document)
        return success_response({"entries": [_serialize_permission(item) for item in entries]})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post("/documents/{document_id}/permissions", response={200: dict, 400: ErrorResponse, 403: ErrorResponse}, auth=jwt_auth, summary="覆盖更新文档权限")
def update_document_permissions(
    request: HttpRequest,
    document_id: str,
    payload: DocumentPermissionsUpdateRequest,
):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="admin")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        entries = service.replace_permissions(
            document,
            entries=[entry.dict() for entry in payload.entries],
        )
        return success_response({"entries": [_serialize_permission(item) for item in entries]})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


# ═══════════════════════════════════════════════════════════════════
# V3 API 端点 — Hocuspocus / Agent / History
# ═══════════════════════════════════════════════════════════════════

def _serialize_history(history) -> dict:
    """将 DocHistory 或 VersionHistory ORM 实例序列化为统一格式"""
    doc_id = getattr(history, "document_id", None) or getattr(history, "resource_id", "")
    return {
        "id": str(history.id),
        "document_id": str(doc_id),
        "is_snapshot": history.is_snapshot,
        "editor_type": history.editor_type or "",
        "editor_id": history.editor_id or "",
        "expired_at": history.expired_at.isoformat() if history.expired_at else None,
        "created_at": history.created_at.isoformat() if history.created_at else None,
        "is_named": history.is_named,
        "name": history.name or "",
        "pinned": history.pinned,
    }


@router.get(
    "/documents/{document_id}/binary",
    response={200: dict, 403: ErrorResponse, 404: ErrorResponse},
    auth=[jwt_auth, internal_service_auth],
    summary="获取文档 Y.js binary（供 Hocuspocus fetchDocument）",
)
async def get_document_binary(request: HttpRequest, document_id: str):
    """
    Hocuspocus Database Extension 的 onFetchDocument 回调调用此端点。
    返回 Base64 编码的 Y.js binary。
    支持 JWT 认证（用户端）和 X-Live-Secret（collab-live 内部调用）。
    """

    def _run_sync():
        # : binary GET 是只读路径。已有 binary 必须原样返回；缺 binary 时仅把
        # 已有 PM JSON / Markdown 作为 fallback 字段返回，由 collab-live 做一次性
        # 迁移并在 persist 成功后再交付。禁止在 GET 内 normalize / 清空 binary / push。
        if request.auth == "collab-live-service":
            # 内部调用，跳过权限检查
            from apps.tabdoc.models import Document
            try:
                document = Document.objects.get(id=document_id)
            except Document.DoesNotExist:
                return not_found_response(_("tabdoc.document_not_found"))
            service = DocumentService(user=None)
            try:
                service.assert_document_collab_writable(document)
            except ValueError as exc:
                return validation_error_response(str(exc))
        elif request.auth:
            service = _build_service(request)
            try:
                document = service.get_document(document_id, required_role="viewer")
                service.assert_document_collab_writable(document)
            except PermissionError as exc:
                return permission_denied_response(str(exc))
            except ValueError as exc:
                return validation_error_response(str(exc))
        else:
            return permission_denied_response(_("tabdoc.auth_required"))

        binary_data = document.description_binary
        if binary_data:
            try:
                from apps.collab.adapters.docs import unwrap_binary_snapshot
                original_binary = bytes(binary_data)
                normalized_binary, was_wrapped = unwrap_binary_snapshot(binary_data)
            except ValueError as exc:
                logger.warning(
                    "Invalid TabDoc description_binary wrapper: doc=%s error=%s",
                    document.id,
                    exc,
                )
                return validation_error_response(str(exc))
            if was_wrapped:
                from apps.tabdoc.models import Document
                rows = Document.objects.using("postgresql").filter(
                    id=document.id,
                    description_binary=original_binary,
                ).update(
                    description_binary=normalized_binary,
                )
                if rows == 0:
                    try:
                        latest_doc = (
                            Document.objects.using("postgresql")
                            .only("description_binary")
                            .get(id=document.id)
                        )
                    except Document.DoesNotExist:
                        return not_found_response(_("tabdoc.document_not_found"))
                    latest_binary = latest_doc.description_binary
                    if latest_binary:
                        try:
                            normalized_binary, _latest_was_wrapped = unwrap_binary_snapshot(
                                latest_binary
                            )
                        except ValueError as exc:
                            logger.warning(
                                "Invalid latest TabDoc description_binary wrapper after CAS miss: doc=%s error=%s",
                                document.id,
                                exc,
                            )
                            return validation_error_response(str(exc))
                        binary_data = normalized_binary
                    else:
                        binary_data = None
                else:
                    binary_data = normalized_binary
                logger.info(
                    "Normalized TabDoc binary_snapshot wrapper: doc=%s bytes=%d",
                    document.id,
                    len(binary_data or b""),
                )
        b64_data = base64.b64encode(bytes(binary_data)).decode() if binary_data else ""

        # 无 binary 时把 pm_json 一并返回：collab-live 首次打开若只靠 markdown 迁移，
        # 会把导入草稿里的字色/下划线等洗掉（markdown 本身就不保真）。
        markdown_content = ""
        description_json = None
        if not binary_data:
            markdown_content = document.description_markdown or ""
            raw_json = document.description_json
            if isinstance(raw_json, dict) and raw_json.get("content"):
                from apps.tabdoc.services.image_asset_service import ImageAssetService

                # Collaboration persistence must receive only stable identities.
                # Signed URLs are response-time credentials and must never enter
                # the Y.js binary/source-of-truth path.
                description_json = ImageAssetService.normalize_pm_json_for_storage(
                    document,
                    raw_json,
                    existing_pm_json=raw_json,
                )

        return success_response({
            "document_id": str(document.id),
            "binary_b64": b64_data,
            "has_binary": bool(binary_data),
            "latest_version": document.latest_version,
            "description_markdown": markdown_content,
            "description_json": description_json,
        })

    return await run_in_agent_io_executor(_run_sync)


@router.get(
    "/auth/verify",
    response={200: dict, 403: ErrorResponse},
    auth=jwt_auth,
    summary="验证用户文档访问权限（供 Hocuspocus onAuthenticate）",
)
def verify_document_access(request: HttpRequest, document_id: str, required_role: str = "editor"):
    """
    Hocuspocus Auth Extension 的 onAuthenticate 回调调用此端点。
    验证用户对指定文档的访问权限。
    """
    if not request.auth:
        return permission_denied_response("Need login")

    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role=required_role)
        if required_role == "viewer":
            service.assert_document_viewable(document)
        else:
            service.assert_document_collab_writable(document)
        return success_response({
            "authorized": True,
            "user_id": str(request.auth.id),
            "document_id": str(document.id),
            "role": required_role,
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return permission_denied_response(str(exc))


@router.post(
    "/documents/{document_id}/agent-write",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="Agent 写入文档内容（Markdown）",
)
async def agent_write_document(request: HttpRequest, document_id: str, payload: AgentWriteRequest):
    """
    Agent 通过 REST API 写入文档内容。

    接收 Markdown，转换为 PM JSON 后更新 Document 快照。
    同时推送到 Hocuspocus 让人类编辑器实时看到。
    """

    def _run_sync():
        if not request.auth:
            return permission_denied_response("Need login")

        service = _build_service(request)

        try:
            document = service.get_document(document_id, required_role="editor")
            block_response = _organization_resource_write_block_response(str(document.organization_id))
            if block_response is not None:
                return block_response

            # 通过 collab-live 做完整转换：Markdown → Y.js update → binary-to-formats
            # 先获取 Y.js update binary
            from apps.services.common.live_api import call_live_api
            try:
                convert_result = call_live_api("/convert/markdown-to-update", {
                    "markdown": payload.content_markdown,
                })
                update_b64 = convert_result.get("update_b64", "")

                if update_b64:
                    # 再转回各格式（确保 round-trip 一致性）
                    formats = call_live_api("/convert/binary-to-formats", {
                        "binary_b64": update_b64,
                    })
                    content_pm_json = formats.get("json", {})
                    content_html = formats.get("html", "")
                    content_plaintext = formats.get("plaintext", payload.content_markdown)
                else:
                    # fallback：本地转换
                    from apps.tabdoc.services.markdown_exchange import markdown_to_pm_json, pm_json_to_html
                    content_pm_json = markdown_to_pm_json(payload.content_markdown) or {}
                    content_html = pm_json_to_html(content_pm_json) if content_pm_json else ""
                    content_plaintext = payload.content_markdown
            except (RuntimeError, Exception) as exc:
                # collab-live 不可用时的 fallback：本地转换（保留内容语义）
                import logging
                logging.getLogger("tabdoc.api").warning(
                    "collab-live 不可用，Agent 写入降级为本地转换: doc=%s err=%s",
                    document_id, exc,
                )
                from apps.tabdoc.services.markdown_exchange import markdown_to_pm_json, pm_json_to_html
                content_pm_json = markdown_to_pm_json(payload.content_markdown) or {}
                content_html = pm_json_to_html(content_pm_json) if content_pm_json else ""
                content_plaintext = payload.content_markdown

            updated_doc = service.push_from_agent(
                document,
                content_pm_json=content_pm_json,
                content_html=content_html,
                content_plaintext=content_plaintext,
                agent_id=payload.agent_id,
            )

            return success_response({
                "document": _serialize_document(updated_doc),
            })
        except ConflictError as exc:
            return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
        except PermissionError as exc:
            return permission_denied_response(str(exc))
        except ValueError as exc:
            return validation_error_response(str(exc))

    return await run_in_agent_io_executor(_run_sync)


# ── DocHistory API ──

@router.get(
    "/documents/{document_id}/histories",
    response={200: dict, 403: ErrorResponse},
    auth=jwt_auth,
    summary="获取文档版本历史（V3 DocHistory）",
)
def list_document_histories(request: HttpRequest, document_id: str, limit: int = 50, offset: int = 0):
    """列出文档的 DocHistory 版本历史记录"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        result = service.list_histories(document, limit=limit, offset=offset)
        return success_response({
            "histories": [_serialize_history(h) for h in result["items"]],
            "total": result["total"],
            "limit": result["limit"],
            "offset": result["offset"],
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.get(
    "/documents/{document_id}/histories/{history_id}/preview",
    response={200: dict, 400: dict, 403: ErrorResponse, 404: dict},
    auth=jwt_auth,
    summary="预览某个版本的文档内容（Markdown）",
)
async def preview_document_history(request: HttpRequest, document_id: str, history_id: str):
    """解析 DocHistory blob，返回该版本的 Markdown 内容供预览。"""
    if not request.auth:
        return permission_denied_response("Need login")

    def _run_sync():
        try:
            service = _build_service(request)
            document = service.get_document(document_id, required_role="viewer")
            resolved = service._resolve_history_content_by_id(document, history_id)
            if not resolved:
                return 404, {"status": "error", "message": _("resource.history_not_found")}

            markdown = ""
            if resolved.get("format") == "json_snapshot":
                markdown = resolved.get("description_markdown", "")
            elif resolved.get("format") == "yjs_binary" and resolved.get("binary"):
                try:
                    import base64
                    from apps.services.common.live_api import call_live_api
                    b64 = base64.b64encode(resolved["binary"]).decode()
                    result = call_live_api("/convert/binary-to-formats", {"binary_b64": b64})
                    markdown = result.get("markdown", "") or result.get("html", "")
                except Exception as exc:
                    logger.warning(
                        "yjs binary to markdown failed: doc=%s history=%s err=%s",
                        document_id, history_id, exc,
                    )
                    # R-A2：原来这里静默 markdown="" + 返回 200，CLI / agent
                    # 把空 markdown 当"该版本就是空文档"，与"上游 collab-live
                    # 不可用"无法区分。改为显式 503，让 CLI 退非 0、agent
                    # 能感知降级并退避/在 web 端打开历史版本。
                    # json_snapshot 路径不依赖 collab-live，仍走 200 → markdown 兜底。
                    return error_response(
                        "UPSTREAM_UNAVAILABLE",
                        message=(
                            f"collab-live 不可用，无法把 yjs binary 历史版本转为 markdown: {exc}"
                        ),
                        status_code=503,
                        data={
                            "hint": (
                                "稍后重试；或在 Web 端打开该历史版本（不依赖 collab-live binary 转换）"
                            ),
                            "document_id": str(document_id),
                            "history_id": str(history_id),
                        },
                    )

            return success_response({"markdown": markdown, "history_id": history_id})
        except PermissionError as exc:
            return permission_denied_response(str(exc))
        except ValueError as exc:
            return 400, {"status": "error", "message": str(exc)}

    return await run_in_agent_io_executor(_run_sync)


@router.get(
    "/documents/{document_id}/chunks",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse},
    auth=jwt_auth,
    summary="获取文档分块列表（大文档按需加载）",
)
def list_document_chunks(
    request: HttpRequest,
    document_id: str,
    start: int = 0,
    limit: int = 10,
):
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="viewer")
        from apps.tabdoc.models import DocChunk
        chunks = (
            DocChunk.objects.filter(document=document)
            .order_by("chunk_index")
            .filter(chunk_index__gte=start, chunk_index__lt=start + limit)
        )
        import base64
        return success_response({
            "chunks": [
                {
                    "id": str(c.id),
                    "chunk_index": c.chunk_index,
                    "chunk_key": c.chunk_key,
                    "blob_b64": base64.b64encode(bytes(c.blob)).decode() if c.blob else "",
                    "blob_size": c.blob_size,
                    "block_count": c.block_count,
                    "plaintext_preview": c.plaintext_preview,
                }
                for c in chunks
            ],
            "total": DocChunk.objects.filter(document=document).count(),
            "start": start,
            "limit": limit,
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post(
    "/documents/{document_id}/restore-history",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="从 DocHistory 恢复文档",
)
def restore_document_history(request: HttpRequest, document_id: str, payload: HistoryRestoreRequest):
    """从 DocHistory 版本记录恢复文档内容"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        updated_doc = service.restore_history(
            document,
            history_id=payload.history_id,
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
        )
        extra_fields: dict[str, Any] = {}
        # CRT-21: collab-live 不可用时，告知前端文本格式待转换
        if getattr(updated_doc, "_restore_format_degraded", False):
            extra_fields["warning"] = "format_conversion_pending"
        # NEW-002: force-close 失败时，告知前端协作状态可能未同步
        collab_sync_warning = getattr(updated_doc, "_restore_collab_sync_warning", None)
        if collab_sync_warning and collab_sync_warning != "document_not_loaded":
            extra_fields["collab_sync_warning"] = collab_sync_warning
        # P1-03: VH+CL 写入失败时，告知前端审计记录缺失
        audit_warning = getattr(updated_doc, "_restore_audit_warning", None)
        if audit_warning:
            extra_fields["audit_warning"] = audit_warning
        return _document_write_response(updated_doc, service=service, **extra_fields)
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


# ── 命名版本 API ──

@router.post(
    "/documents/{document_id}/versions",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse},
    auth=jwt_auth,
    summary="创建命名版本",
)
def create_named_version(request: HttpRequest, document_id: str, payload: CreateNamedVersionRequest):
    """用户手动保存当前文档为命名版本（永久保留）"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        history = service.create_named_version(
            document,
            name=payload.name,
            base_version=payload.base_version,
            base_updated_at=payload.base_updated_at,
        )
        return success_response({"version": _serialize_history(history)})
    except ConflictError as exc:
        return error_response(ErrorCode.VERSION_CONFLICT, str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.patch(
    "/documents/{document_id}/versions/{version_id}",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse},
    auth=jwt_auth,
    summary="重命名版本",
)
def rename_named_version(request: HttpRequest, document_id: str, version_id: str, payload: RenameVersionRequest):
    """修改命名版本的名称"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        history = service.rename_version(document, history_id=version_id, name=payload.name)
        return success_response({"version": _serialize_history(history)})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.delete(
    "/documents/{document_id}/versions/{version_id}",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse},
    auth=jwt_auth,
    summary="删除命名版本",
)
def delete_named_version(request: HttpRequest, document_id: str, version_id: str):
    """删除一个命名版本（仅手动保存的版本可删除）"""
    if not request.auth:
        return permission_denied_response("Need login")
    service = _build_service(request)
    try:
        document = service.get_document(document_id, required_role="editor")
        block_response = _organization_resource_write_block_response(str(document.organization_id))
        if block_response is not None:
            return block_response
        service.delete_named_version(document, history_id=version_id)
        return success_response({"deleted": True})
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


__all__ = ["router"]

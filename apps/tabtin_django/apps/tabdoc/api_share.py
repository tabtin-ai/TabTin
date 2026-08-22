"""
TabDoc 分享 API

分为两组端点：
1. 管理端点（需 JWT）：创建/查询/关闭/轮换分享
2. 公开端点（无需认证）：获取分享内容、验证密码
"""

from __future__ import annotations

from django.conf import settings
import json
import logging
from uuid import UUID

from django.http import HttpRequest
from ninja import Router, Schema, Field
from typing import List, Optional

from apps.services.common.public_share.auth import get_authenticated_user
from apps.services.common.public_share.exceptions import (
    ShareExpiredError,
    ShareManagementPermissionDeniedError,
    ShareNotFoundError,
    SharePasswordIncorrectError,
    SharePasswordRequiredError,
    SharePermissionDeniedError,
    ShareOrganizationMismatchError,
    SharePublicExposureAcknowledgementRequiredError,
)
from apps.tabdoc.models import DocumentShare
from apps.tabdoc.schemas import (
    CommentAttachmentConfirmRequest,
    CommentAttachmentPreviewRequest,
    CommentAttachmentUploadRequest,
    CommentMessageCreateRequest,
    CommentMessageDeleteRequest,
    CommentThreadAnchorRequest,
    CommentThreadCreateRequest,
    CommentThreadStatusRequest,
)
from apps.tabdoc.services.share_service import (
    CollaboratorError,
    DocumentShareService,
    SHARE_COMMENTABLE_PERMISSIONS,
    invite_collaborators,
    list_collaborators,
    list_documents_shared_with_me,
    remove_collaborator,
    update_collaborator_permission,
)
from apps.tabdoc.services import ConflictError
from apps.tabdoc.services.comment_service import (
    COMMENT_THREADS_CAPABILITY,
    DocumentCommentService,
)
from apps.tabdoc.services.comment_attachment_service import CommentAttachmentService
from apps.i18n import get_text as _
from apps.i18n.response import (
    error_response_with_status as error_response,
    not_found_response,
    permission_denied_response,
    success_response,
    validation_error_response,
)
from apps.users.auth.permissions import JWTAuth, JWTAuthOptional

logger = logging.getLogger("tabdoc.api.share")

router = Router(tags=["TabDoc Share"])
jwt_auth = JWTAuth()
# 可选 JWT 认证：用于 3 个公开端点，让登录用户被识别（organization 校验时用），
# 未登录访问返回 ANONYMOUS_USER_MARKER（view 层走 get_authenticated_user 还原成 None）。
jwt_auth_optional = JWTAuthOptional()

TABDOC_DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')


def _interactive_share_auth_required_response(share: DocumentShare, user):
    """可编辑/可评论公开分享必须登录后才能打开或交互。"""
    if DocumentShareService.share_requires_authenticated_user(share) and not getattr(user, "id", None):
        return permission_denied_response("Need login")
    return None


def _commentable_share_context(request: HttpRequest, share_id: str, password: str):
    """复用既有分享登录、密码、权限和 Organization 校验。"""
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return None, None, not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return None, None, error_response(
            "SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410
        )

    user = get_authenticated_user(request)
    auth_response = _interactive_share_auth_required_response(share, user)
    if auth_response is not None:
        return None, None, auth_response
    try:
        DocumentShareService.verify_share_access(share, password=password, user=user)
        if share.permission not in SHARE_COMMENTABLE_PERMISSIONS:
            raise SharePermissionDeniedError("Share link does not allow commenting")
    except SharePasswordRequiredError:
        return None, None, error_response(
            "PASSWORD_REQUIRED", _("tabdoc.share_password_required"), status_code=403
        )
    except SharePasswordIncorrectError:
        return None, None, error_response(
            "INCORRECT_PASSWORD", _("tabdoc.share_password_incorrect"), status_code=403
        )
    except (SharePermissionDeniedError, ShareOrganizationMismatchError) as exc:
        return None, None, permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied")
        )
    return share, user, None


def _share_management_error_to_response(exc):
    """统一映射 PublicShareService 管理端点异常 → 国际化错误响应。

    映射规则（PRD §5 Phase 1.3）：
    - ``ShareNotFoundError`` → 404 NOT_FOUND（资源不存在）
    - ``ShareManagementPermissionDeniedError`` → 403 PERMISSION_DENIED
      （未登录或非 owner / 非 admin —— 含 R7 organization admin fallback）

    本 helper 仅服务于 share 管理端点（create/get/close/refresh）；
    collaborator 端点继续走原有的 ``_collaborator_error_to_response``。
    """
    if isinstance(exc, ShareNotFoundError):
        return not_found_response(_("tabdoc.document_not_found"))
    if isinstance(exc, ShareManagementPermissionDeniedError):
        return permission_denied_response(
            _("tabdoc.share_permission_denied"),
        )
    return error_response("INTERNAL_ERROR", str(exc), status_code=500)


def _share_type_from_request(request: HttpRequest, query_value: str) -> str:
    """解析 share_type，兼容两类调用方：

    - 前端 / 默认：从 URL query 读（``query_value``，ninja 已解析）。
    - tabtin CLI 写命令：``DELETE``/``POST`` 把参数放进 JSON body（CLI 声明式
      管线只对 GET 做 body→query），故这里再看一眼 body，body 显式给了就优先。

    让 ``close_share`` / ``refresh_share`` 能可靠区分 public / organization 两种类型
    （否则 CLI 关闭/轮换 organization 分享会被静默当成 public）。
    """
    try:
        raw = request.body
    except Exception:
        raw = b""
    if raw:
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict) and data.get("share_type"):
            return str(data["share_type"])
    return query_value


# ── Schemas ──


class CreateShareRequest(Schema):
    """创建/更新文档分享请求。

    PATCH 语义（Wave 5 §C）：
    - ``password=None`` （字段未传）→ 不动密码（保留旧 hash）
    - ``password=""``   （显式空字符串）→ 清空密码
    - ``password="abc"``（非空）→ 设新密码（hash 化）

    安全缺省：
    - 省略 ``share_type`` 时默认 ``organization``（组织内）
    - 扩大到 ``public`` 须 ``acknowledge_public_exposure=true``
    """

    share_type: str = "organization"
    permission: str = "view"
    password: Optional[str] = None
    expire_hours: Optional[int] = None
    allow_download: bool = True
    allow_copy: bool = True
    organization_id: str = ""
    acknowledge_public_exposure: bool = False


class ShareOut(Schema):
    share_id: str
    share_type: str
    permission: str
    has_password: bool
    expire_at: Optional[str] = None
    allow_download: bool
    allow_copy: bool
    organization_id: str
    visit_count: int
    is_active: bool
    created_at: Optional[str] = None


class VerifyPasswordRequest(Schema):
    password: str


class ShareCollabTokenRequest(Schema):
    password: str = ""


class SharedHtmlArtifactRequest(Schema):
    """分享页读取 HTML artifact；密码只走 body，避免进 Referer / 访问日志。"""

    password: str = ""


class HtmlBlockBrowserOpenRequest(Schema):
    """「在浏览器打开」：可选文档 share_id + password，密码只走 POST body。"""

    share_id: str = ""
    password: str = ""
    # 协作未落库短期兜底；ACL / 已校验 DocumentShare 均须经 FileUsage 绑定
    file_id: str = ""


class SaveSharedContentRequest(Schema):
    """公开分享页保存正文（permission=edit 时）。"""

    password: Optional[str] = None
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None
    content_pm_json: dict = Field(default_factory=dict)
    content_markdown: str = ""
    content_plaintext: str = ""


class CreateSharedCommentRequest(Schema):
    """公开分享页新增评论（permission=comment/edit 时）。"""

    password: Optional[str] = None
    body: str
    selected_text: str = ""
    author_name: str = ""
    mention_user_ids: List[str] = Field(default_factory=list)


# ── 协作者 Schemas (E1-E7) ──


class UserBrief(Schema):
    user_id: str
    nickname: str
    avatar: Optional[str] = None
    email: str  # 后端 mask 后返回


class CollaboratorOut(UserBrief):
    permission: str  # viewer/editor/admin
    created_at: Optional[str] = None


class CollaboratorListOut(Schema):
    owner: UserBrief
    collaborators: List[CollaboratorOut]


class InviteCollaboratorsRequest(Schema):
    user_ids: List[str]
    permission: str


class UpdateCollaboratorRequest(Schema):
    permission: str


class SkippedItem(Schema):
    user_id: str
    reason: str  # 'not_in_organization' | 'is_owner' | 'self'


class InviteCollaboratorsResponse(Schema):
    notified: int
    skipped: List[SkippedItem]


# ── 管理端点（需 JWT） ──


def _resolve_share_type_or_effective(
    request: HttpRequest,
    document,
    query_value: str,
) -> str | None:
    """解析管理端 share_type。

    - 省略 / 空串：回退到当前唯一有效分享类型（无则 ``None``）
    - ``public`` / ``organization``：原样返回
    - 非空非法值：抛 ``ValueError``，调用方转 400（避免拼写错误误关/误轮换）
    """
    share_type = (_share_type_from_request(request, query_value) or "").strip()
    if not share_type:
        effective = DocumentShareService.get_effective_active_share(document)
        return effective.share_type if effective else None
    if share_type in ("public", "organization"):
        return share_type
    raise ValueError("invalid_share_type")


def _audit_document_share(
    request: HttpRequest,
    *,
    document,
    action: str,
    previous_share_type: str | None,
    next_share_type: str | None,
    permission: str | None = None,
):
    """非阻断审计：记录分享范围变更，不写入 share_id / 密码 / 正文。"""
    try:
        from apps.tabtinspace.services.audit_service import AuditService

        AuditService.log(
            action_type="resource_share",
            target_type="document",
            target_id=document.id,
            organization_id=getattr(document, "organization_id", None),
            space_id=getattr(document, "space_id", None),
            operator=getattr(request, "auth", None),
            ip_address=request.META.get("REMOTE_ADDR"),
            user_agent=request.META.get("HTTP_USER_AGENT", "") or "",
            message=f"document share {action}",
            request_payload={
                "action": action,
                "previous_share_type": previous_share_type,
                "share_type": next_share_type,
                "permission": permission,
            },
        )
    except Exception:
        logger.warning(
            "[tabdoc.share] audit log failed action=%s document=%s",
            action,
            getattr(document, "id", None),
            exc_info=True,
        )


@router.post(
    "/documents/{document_id}/share",
    auth=jwt_auth,
    summary="创建或更新文档分享",
)
def create_share(request: HttpRequest, document_id: UUID, data: CreateShareRequest):
    if data.share_type not in ("public", "organization"):
        return validation_error_response(_("tabdoc.invalid_share_type"))

    if data.permission not in ("view", "comment", "edit"):
        return validation_error_response(_("tabdoc.invalid_share_permission"))

    try:
        document = DocumentShareService.load_resource_for_management(
            document_id, request.auth,
        )
    except (ShareNotFoundError, ShareManagementPermissionDeniedError) as exc:
        return _share_management_error_to_response(exc)

    organization_id = (data.organization_id or "").strip()
    if data.share_type == "organization":
        # 安全缺省：未传 organization_id 时从文档归属推导。
        if not organization_id:
            organization_id = str(getattr(document, "organization_id", "") or "")
        if not organization_id:
            return validation_error_response(
                _("tabdoc.organization_required_for_organization_share"),
            )
        try:
            DocumentShareService.validate_organization_scope(document, organization_id)
        except ShareOrganizationMismatchError as exc:
            return error_response(
                "INVALID_ORGANIZATION_ID",
                str(exc) or _("tabdoc.organization_required_for_organization_share"),
                status_code=400,
            )

    from django.utils import timezone
    import datetime

    expire_at = None
    if data.expire_hours and data.expire_hours > 0:
        expire_at = timezone.now() + datetime.timedelta(hours=data.expire_hours)

    previous = DocumentShareService.get_effective_active_share(document)
    previous_type = previous.share_type if previous else None

    try:
        share = DocumentShareService.create_or_update_share_exclusive(
            document,
            request.auth,
            share_type=data.share_type,
            permission=data.permission,
            password=data.password,
            expire_at=expire_at,
            allow_download=data.allow_download,
            allow_copy=data.allow_copy,
            organization_id=organization_id if data.share_type == "organization" else "",
            acknowledge_public_exposure=bool(data.acknowledge_public_exposure),
        )
    except SharePublicExposureAcknowledgementRequiredError:
        return error_response(
            "PUBLIC_EXPOSURE_ACK_REQUIRED",
            _("tabdoc.public_exposure_ack_required"),
            status_code=409,
        )
    except Exception as exc:
        # ValidationError（非法 permission）等 → 400
        from django.core.exceptions import ValidationError as DjangoValidationError

        if isinstance(exc, DjangoValidationError):
            return validation_error_response(str(exc))
        raise

    if previous_type is None:
        action = "enable"
    elif previous_type != share.share_type:
        action = "scope_change"
    else:
        action = "update"
    _audit_document_share(
        request,
        document=document,
        action=action,
        previous_share_type=previous_type,
        next_share_type=share.share_type,
        permission=share.permission,
    )

    return success_response({"share": _serialize_share(share)})


@router.get(
    "/documents/{document_id}/share",
    auth=jwt_auth,
    summary="获取文档分享设置",
)
def get_share(request: HttpRequest, document_id: UUID, share_type: str = ""):
    """获取当前有效分享。

    - 未传 / 空 ``share_type``：返回文档当前唯一 active share
    - 显式 ``public`` / ``organization``：按类型查询（兼容旧客户端）
    - 非空非法值：400（不回退到有效分享）
    """
    try:
        document = DocumentShareService.load_resource_for_management(
            document_id, request.auth,
        )
    except (ShareNotFoundError, ShareManagementPermissionDeniedError) as exc:
        return _share_management_error_to_response(exc)

    try:
        resolved = _resolve_share_type_or_effective(request, document, share_type)
    except ValueError:
        return validation_error_response(_("tabdoc.invalid_share_type"))

    if not resolved:
        return success_response({"share": None, "enabled": False})

    share = DocumentShareService.get_active_share(document, resolved)
    if not share:
        return success_response({"share": None, "enabled": False})

    return success_response({"share": _serialize_share(share), "enabled": True})


@router.delete(
    "/documents/{document_id}/share",
    auth=jwt_auth,
    summary="关闭文档分享",
)
def close_share(request: HttpRequest, document_id: UUID, share_type: str = ""):
    try:
        document = DocumentShareService.load_resource_for_management(
            document_id, request.auth,
        )
    except (ShareNotFoundError, ShareManagementPermissionDeniedError) as exc:
        return _share_management_error_to_response(exc)

    try:
        resolved = _resolve_share_type_or_effective(request, document, share_type)
    except ValueError:
        return validation_error_response(_("tabdoc.invalid_share_type"))

    if not resolved:
        return success_response({"disabled_count": 0})

    previous = DocumentShareService.get_active_share(document, resolved)
    count = DocumentShareService.disable_share(document, resolved)
    if count:
        _audit_document_share(
            request,
            document=document,
            action="disable",
            previous_share_type=previous.share_type if previous else resolved,
            next_share_type=None,
            permission=previous.permission if previous else None,
        )
    return success_response({"disabled_count": count})


@router.post(
    "/documents/{document_id}/share/refresh",
    auth=jwt_auth,
    summary="轮换文档分享链接",
)
def refresh_share(request: HttpRequest, document_id: UUID, share_type: str = ""):
    try:
        document = DocumentShareService.load_resource_for_management(
            document_id, request.auth,
        )
    except (ShareNotFoundError, ShareManagementPermissionDeniedError) as exc:
        return _share_management_error_to_response(exc)

    try:
        resolved = _resolve_share_type_or_effective(request, document, share_type)
    except ValueError:
        return validation_error_response(_("tabdoc.invalid_share_type"))

    if not resolved:
        return not_found_response(_("tabdoc.active_share_not_found"))

    share = DocumentShareService.refresh_share_id(document, resolved)
    if not share:
        return not_found_response(_("tabdoc.active_share_not_found"))

    _audit_document_share(
        request,
        document=document,
        action="refresh",
        previous_share_type=share.share_type,
        next_share_type=share.share_type,
        permission=share.permission,
    )
    return success_response({"share": _serialize_share(share)})


# ── 公开端点（无需认证） ──


@router.get(
    "/shared/{share_id}",
    auth=jwt_auth_optional,
    summary="获取公开文档元数据（可选登录，organization 分享识别身份）",
)
def get_shared_meta(request: HttpRequest, share_id: str, password: str = ""):
    """获取分享元信息。

    PRD §4.3 P0-3 修复：
    - 走 ``verify_share_access`` 鉴权门（organization → password 顺序）
    - organization 校验失败 → 403（不再裸露 meta）
    - 密码未通过 / 未提供 → 降级到只返"非敏感装饰字段"
      （title / icon / cover_image / cover_position + has_password），
      隐藏 ``permission`` / ``allow_*`` / ``created_at`` 等次敏感字段
    """
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)

    user = get_authenticated_user(request)
    try:
        DocumentShareService.verify_share_access(share, password=password, user=user)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )
    except (SharePasswordRequiredError, SharePasswordIncorrectError):
        # 密码未通过 → 降级到 include_protected=False，保留装饰字段供前端
        # 渲染密码态 UI，但隐藏 permission/allow_*/created_at 等次敏感字段
        meta = DocumentShareService.serialize_meta(share, include_protected=False)
        return success_response(meta)

    meta = DocumentShareService.serialize_meta(share, include_protected=True)
    return success_response(meta)


@router.post(
    "/shared/{share_id}/verify",
    auth=jwt_auth_optional,
    summary="验证分享密码",
)
def verify_password(request: HttpRequest, share_id: str, data: VerifyPasswordRequest):
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)

    user = get_authenticated_user(request)
    auth_required_response = _interactive_share_auth_required_response(share, user)
    if auth_required_response is not None:
        return auth_required_response

    try:
        content = DocumentShareService.get_shared_content(
            share,
            user=user,
            password=data.password,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePermissionDeniedError as exc:
        # PRD §5 Phase 1.5：organization 限定分享应返回 403，而不是冒泡 500
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )

    return success_response(content)


@router.get(
    "/shared/{share_id}/content",
    auth=jwt_auth_optional,
    summary="获取公开文档内容（可选登录，organization 分享识别身份）",
)
def get_shared_content(request: HttpRequest, share_id: str, password: str = ""):
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)

    user = get_authenticated_user(request)
    auth_required_response = _interactive_share_auth_required_response(share, user)
    if auth_required_response is not None:
        return auth_required_response

    try:
        content = DocumentShareService.get_shared_content(
            share,
            user=user,
            password=password,
        )
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )

    return success_response(content)


@router.post(
    "/shared/{share_id}/collab-token",
    auth=jwt_auth_optional,
    summary="签发分享页协作 token（只读实时同步）",
)
def issue_doc_share_collab_token(
    request: HttpRequest,
    share_id: str,
    data: ShareCollabTokenRequest,
    password: str = "",
):
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)

    user = get_authenticated_user(request)
    effective_password = password or data.password
    try:
        DocumentShareService.verify_share_access(
            share, password=effective_password, user=user,
        )
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )

    try:
        payload = DocumentShareService.issue_share_collab_token(share, user=user)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(str(exc) or _("tabdoc.share_permission_denied"))

    return success_response(payload)


@router.post(
    "/shared/{share_id}/image-assets/{file_id}",
    auth=jwt_auth_optional,
    summary="按文档分享权限获取私有图片短期地址",
)
def get_shared_image_asset(
    request: HttpRequest,
    share_id: str,
    file_id: UUID,
    data: SharedHtmlArtifactRequest,
):
    from apps.tabdoc.services.image_asset_service import (
        ImageAssetAccessError,
        ImageAssetService,
    )

    user = get_authenticated_user(request)
    try:
        accessible = ImageAssetService.resolve_for_share(
            share_id=share_id,
            file_id=file_id,
            user=user,
            password=data.password or "",
        )
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(str(exc) or _("tabdoc.share_permission_denied"))
    except SharePasswordRequiredError:
        return error_response("PASSWORD_REQUIRED", _("tabdoc.share_password_required"), status_code=403)
    except SharePasswordIncorrectError:
        return error_response("INCORRECT_PASSWORD", _("tabdoc.share_password_incorrect"), status_code=403)
    except ImageAssetAccessError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    return success_response({
        "url": accessible.url,
        "access_mode": accessible.access_mode,
        "expires_in": accessible.expires_in,
        "expires_at": accessible.expires_at,
    })


@router.post(
    "/shared/{share_id}/html-artifacts/{file_id}",
    auth=jwt_auth_optional,
    summary="受控读取分享文档 HTML 嵌入块内容",
)
def get_shared_html_artifact(
    request: HttpRequest,
    share_id: str,
    file_id: UUID,
    data: SharedHtmlArtifactRequest,
):
    """复用 DocumentShareService 单活 / 密码 / organization fail-closed 语义。"""
    from apps.tabdoc.services.html_artifact_service import (
        HtmlArtifactAccessError,
        HtmlArtifactService,
        build_html_artifact_response,
    )

    user = get_authenticated_user(request)
    try:
        payload = HtmlArtifactService.load_for_share(
            share_id=share_id,
            file_id=file_id,
            user=user,
            password=data.password or "",
        )
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )
    except HtmlArtifactAccessError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    return build_html_artifact_response(payload)


@router.post(
    "/documents/{document_id}/html-blocks/{block_id}/browser",
    auth=jwt_auth_optional,
    summary="「在浏览器打开」读取 HTML 块内容",
)
def open_html_block_in_browser(
    request: HttpRequest,
    document_id: UUID,
    block_id: str,
    data: HtmlBlockBrowserOpenRequest,
):
    """双通道：文档 viewer ACL，或有效 DocumentShare（share_id 属于该文档）。

    密码只放 body；可选 JWT 供 organization share / 成员 ACL 识别。
    """
    from apps.tabdoc.services.html_artifact_service import (
        HtmlArtifactAccessError,
        HtmlArtifactService,
        build_html_artifact_response,
    )

    user = get_authenticated_user(request)
    try:
        payload = HtmlArtifactService.load_for_browser_open(
            document_id=document_id,
            block_id=block_id,
            user=user,
            share_id=data.share_id or "",
            password=data.password or "",
            client_file_id=data.file_id or "",
        )
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )
    except HtmlArtifactAccessError as exc:
        if exc.reason == "block_missing":
            return not_found_response(_("tabdoc.html_block_not_found"))
        if exc.reason == "permission_denied":
            # 未登录 / 坏 token 按匿名 → 403 + Need login（前端映射 login_required）；
            # 已登录无权限 → 403（勿与「分享关闭」404 混淆）。勿改成真 401 却不改前端。
            if not user or not getattr(user, "id", None):
                return permission_denied_response("Need login")
            return permission_denied_response(_("tabdoc.share_permission_denied"))
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    return build_html_artifact_response(payload)


@router.post(
    "/shared/{share_id}/content",
    auth=jwt_auth_optional,
    summary="保存公开分享文档内容（permission=edit 时）",
)
def save_shared_content(request: HttpRequest, share_id: str, data: SaveSharedContentRequest):
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)

    user = get_authenticated_user(request)
    auth_required_response = _interactive_share_auth_required_response(share, user)
    if auth_required_response is not None:
        return auth_required_response

    try:
        updated_doc = DocumentShareService.save_shared_content(
            share,
            user=user,
            password=data.password or "",
            base_version=data.base_version,
            base_updated_at=data.base_updated_at,
            content_pm_json=data.content_pm_json,
            content_markdown=data.content_markdown,
            content_plaintext=data.content_plaintext,
        )
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )
    except ConflictError as exc:
        return error_response("VERSION_CONFLICT", str(exc), status_code=409)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))

    return success_response({
        "latest_version": int(updated_doc.latest_version or 0),
        "updated_at": updated_doc.updated_at.isoformat() if updated_doc.updated_at else None,
    })


@router.get(
    "/shared/{share_id}/comments",
    auth=jwt_auth_optional,
    summary="获取公开分享文档评论（可选登录，organization 分享识别身份）",
)
def list_shared_comments(request: HttpRequest, share_id: str, password: str = ""):
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)

    user = get_authenticated_user(request)
    auth_required_response = _interactive_share_auth_required_response(share, user)
    if auth_required_response is not None:
        return auth_required_response

    try:
        DocumentShareService.verify_share_access(share, password=password, user=user)
        comments = DocumentShareService.list_share_comments(share, user=user)
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )
    return success_response({
        "comments": comments,
        "capabilities": [COMMENT_THREADS_CAPABILITY],
    })


@router.get(
    "/shared/{share_id}/mention-candidates",
    auth=jwt_auth_optional,
    summary="获取公开分享评论可用的 @ 成员候选（permission=comment/edit）",
)
def list_shared_mention_candidates(request: HttpRequest, share_id: str, password: str = ""):
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)

    user = get_authenticated_user(request)
    auth_required_response = _interactive_share_auth_required_response(share, user)
    if auth_required_response is not None:
        return auth_required_response

    try:
        candidates = DocumentShareService.list_share_mention_candidates(
            share,
            user=user,
            password=password or "",
        )
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )
    return success_response({"candidates": candidates})


@router.post(
    "/shared/{share_id}/comments",
    auth=jwt_auth_optional,
    summary="通过公开分享文档新增评论（permission=comment/edit 时）",
)
def create_shared_comment(request: HttpRequest, share_id: str, data: CreateSharedCommentRequest):
    try:
        share = DocumentShareService.get_share_by_id(share_id)
    except ShareNotFoundError:
        return not_found_response(_("tabdoc.share_invalid_or_expired"))
    except ShareExpiredError:
        return error_response("SHARE_EXPIRED", _("tabdoc.share_expired"), status_code=410)

    user = get_authenticated_user(request)
    auth_required_response = _interactive_share_auth_required_response(share, user)
    if auth_required_response is not None:
        return auth_required_response

    try:
        comment = DocumentShareService.create_share_comment(
            share,
            user=user,
            password=data.password or "",
            body=data.body,
            selected_text=data.selected_text,
            author_name=data.author_name,
            mention_user_ids=data.mention_user_ids,
        )
    except SharePasswordRequiredError:
        return error_response(
            "PASSWORD_REQUIRED",
            _("tabdoc.share_password_required"),
            status_code=403,
        )
    except SharePasswordIncorrectError:
        return error_response(
            "INCORRECT_PASSWORD",
            _("tabdoc.share_password_incorrect"),
            status_code=403,
        )
    except SharePermissionDeniedError as exc:
        return permission_denied_response(
            str(exc) or _("tabdoc.share_permission_denied"),
        )
    except ValueError as exc:
        return validation_error_response(str(exc))

    return success_response({"comment": DocumentShareService.serialize_comment(comment)})


@router.post(
    "/shared/{share_id}/comment-attachments/presign-upload",
    auth=jwt_auth_optional,
    summary="获取分享评论图片私有上传凭证",
)
def create_shared_comment_attachment_upload(
    request: HttpRequest,
    share_id: str,
    data: CommentAttachmentUploadRequest,
):
    share, user, error = _commentable_share_context(request, share_id, data.password or "")
    if error is not None:
        return error
    try:
        return success_response(CommentAttachmentService.issue_upload(
            share.document,
            user=user,
            file_name=data.file_name,
            content_type=data.content_type,
            file_size=data.file_size,
        ))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post(
    "/shared/{share_id}/comment-attachments/confirm-upload",
    auth=jwt_auth_optional,
    summary="确认分享评论图片私有上传",
)
def confirm_shared_comment_attachment_upload(
    request: HttpRequest,
    share_id: str,
    data: CommentAttachmentConfirmRequest,
):
    share, user, error = _commentable_share_context(request, share_id, data.password or "")
    if error is not None:
        return error
    try:
        file_record = CommentAttachmentService.confirm_upload(
            share.document,
            user=user,
            upload_token=data.upload_token,
        )
        return success_response({
            "attachment": CommentAttachmentService.serialize_confirmed(
                file_record,
                document=share.document,
                share_id=str(share.share_id),
            )
        })
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))


@router.post(
    "/shared/{share_id}/comment-attachments/{file_id}/preview",
    auth=jwt_auth_optional,
    summary="获取分享评论图片短时预览地址",
)
def preview_shared_comment_attachment(
    request: HttpRequest,
    share_id: str,
    file_id: str,
    data: CommentAttachmentPreviewRequest,
):
    share, _user, error = _commentable_share_context(request, share_id, data.password or "")
    if error is not None:
        return error
    try:
        return success_response(CommentAttachmentService.preview(share.document, file_id=file_id))
    except ValueError as exc:
        return not_found_response(str(exc))


@router.get(
    "/shared/{share_id}/comment-threads",
    auth=jwt_auth_optional,
    summary="获取分享文档评论线程",
)
def list_shared_comment_threads(request: HttpRequest, share_id: str, password: str = ""):
    share, _user, error = _commentable_share_context(request, share_id, password)
    if error is not None:
        return error
    return success_response({
        "threads": DocumentCommentService.list_threads(share.document, preview_share=share),
        "capabilities": [COMMENT_THREADS_CAPABILITY],
    })


@router.post(
    "/shared/{share_id}/comment-threads",
    auth=jwt_auth_optional,
    summary="通过分享文档新增评论线程",
)
def create_shared_comment_thread(
    request: HttpRequest,
    share_id: str,
    data: CommentThreadCreateRequest,
):
    share, user, error = _commentable_share_context(request, share_id, data.password or "")
    if error is not None:
        return error
    try:
        thread = DocumentCommentService.create_thread(
            share.document,
            user=user,
            body=data.body,
            scope=data.scope,
            anchor=data.anchor,
            selected_text=data.selected_text,
            author_name=data.author_name,
            mention_user_ids=data.mention_user_ids,
            attachment_ids=data.attachment_ids,
            client_request_id=data.client_request_id,
            share=share,
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return validation_error_response(str(exc))
    return success_response({
        "thread": DocumentCommentService.serialize_thread(thread, preview_share=share)
    })


@router.post(
    "/shared/{share_id}/comment-threads/{thread_id}/messages",
    auth=jwt_auth_optional,
    summary="通过分享文档回复评论线程",
)
def create_shared_comment_message(
    request: HttpRequest,
    share_id: str,
    thread_id: str,
    data: CommentMessageCreateRequest,
):
    share, user, error = _commentable_share_context(request, share_id, data.password or "")
    if error is not None:
        return error
    try:
        message = DocumentCommentService.reply(
            share.document,
            thread_id,
            user=user,
            body=data.body,
            author_name=data.author_name,
            mention_user_ids=data.mention_user_ids,
            attachment_ids=data.attachment_ids,
            client_request_id=data.client_request_id,
            share=share,
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        if "不存在" in str(exc):
            return not_found_response(str(exc))
        return validation_error_response(str(exc))
    return success_response({
        "message": DocumentCommentService.serialize_message(message, preview_share=share)
    })


@router.patch(
    "/shared/{share_id}/comment-threads/{thread_id}/status",
    auth=jwt_auth_optional,
    summary="通过分享文档解决或重开评论线程",
)
def update_shared_comment_thread_status(
    request: HttpRequest,
    share_id: str,
    thread_id: str,
    data: CommentThreadStatusRequest,
):
    share, user, error = _commentable_share_context(request, share_id, data.password or "")
    if error is not None:
        return error
    try:
        thread = DocumentCommentService.update_status(
            share.document,
            thread_id,
            user=user,
            status=data.status,
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        if "不存在" in str(exc):
            return not_found_response(str(exc))
        return validation_error_response(str(exc))
    return success_response({"thread": DocumentCommentService.serialize_thread(thread)})


@router.patch(
    "/shared/{share_id}/comment-threads/{thread_id}/anchor",
    auth=jwt_auth_optional,
    summary="通过分享文档重新关联评论锚点",
)
def reanchor_shared_comment_thread(
    request: HttpRequest,
    share_id: str,
    thread_id: str,
    data: CommentThreadAnchorRequest,
):
    share, user, error = _commentable_share_context(request, share_id, data.password or "")
    if error is not None:
        return error
    try:
        thread = DocumentCommentService.reanchor(
            share.document,
            thread_id,
            user=user,
            scope=data.scope,
            anchor=data.anchor,
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        if "不存在" in str(exc):
            return not_found_response(str(exc))
        return validation_error_response(str(exc))
    return success_response({"thread": DocumentCommentService.serialize_thread(thread)})


@router.delete(
    "/shared/{share_id}/comment-threads/{thread_id}/messages/{message_id}",
    auth=jwt_auth_optional,
    summary="通过分享文档删除评论消息",
)
def delete_shared_comment_message(
    request: HttpRequest,
    share_id: str,
    thread_id: str,
    message_id: str,
    data: CommentMessageDeleteRequest,
):
    # 密码只接受 body，避免落入 access log / Referer
    share, user, error = _commentable_share_context(request, share_id, data.password or "")
    if error is not None:
        return error
    try:
        message = DocumentCommentService.delete_message(
            share.document,
            thread_id,
            message_id,
            user=user,
        )
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValueError as exc:
        return not_found_response(str(exc))
    return success_response({"deleted": True, "message_id": str(message.id)})


# ── 辅助函数 ──


def _serialize_share(share: DocumentShare) -> dict:
    return {
        "share_id": share.share_id,
        "share_type": share.share_type,
        "permission": share.permission,
        "has_password": share.has_password,
        "expire_at": share.expire_at.isoformat() if share.expire_at else None,
        "allow_download": share.allow_download,
        "allow_copy": share.allow_copy,
        "organization_id": share.organization_id or "",
        "visit_count": share.visit_count,
        "is_active": share.is_active,
        "created_at": share.created_at.isoformat() if share.created_at else None,
    }


# ── 协作者管理端点（PRD §五块 1, C1-C4） ──


def _collaborator_error_to_response(exc: CollaboratorError):
    """统一映射 CollaboratorError → 国际化错误响应。

    走 error_response_with_status 而非 not_found/permission_denied，
    以便保留 service 层抛出的精确 code（如 DOCUMENT_NOT_FOUND / CANNOT_REMOVE_OWNER /
    RATE_LIMIT_EXCEEDED），方便前端按 code 做差异化提示。
    """
    return error_response(
        exc.code,
        exc.message,
        status_code=exc.status,
        data=exc.data,
    )


@router.post(
    "/documents/{document_id}/collaborators",
    auth=jwt_auth,
    summary="邀请协作者（批量）",
)
def invite_collaborators_endpoint(
    request: HttpRequest, document_id: UUID, data: InviteCollaboratorsRequest,
):
    try:
        result = invite_collaborators(
            document_id=document_id,
            user_ids=data.user_ids,
            permission=data.permission,
            inviter=request.auth,
        )
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response(result)


@router.get(
    "/shared-with-me",
    auth=jwt_auth,
    summary="列出分享给我的文档（资源级协作，不依赖 Space 成员身份）",
)
def list_shared_with_me_endpoint(request: HttpRequest, organization_id: str = ""):
    """Agent 私有化后协作者无法进入他人 bot Space，只能按资源权限独立访问。

    本端点是该独立访问通道的发现入口：返回当前用户具备有效
    DocumentPermission 但本人非 owner 的活跃文档。路径用静态 ``/shared-with-me``
    刻意避开 ``/documents/{document_id}`` 的 catch-all 匹配。
    """
    try:
        documents = list_documents_shared_with_me(
            viewer=request.auth,
            organization_id=(organization_id or None),
        )
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response({"documents": documents, "total": len(documents)})


@router.get(
    "/documents/{document_id}/collaborators",
    auth=jwt_auth,
    summary="列出协作者（含 owner）",
)
def list_collaborators_endpoint(request: HttpRequest, document_id: UUID):
    try:
        result = list_collaborators(document_id=document_id, viewer=request.auth)
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response(result)


@router.patch(
    "/documents/{document_id}/collaborators/{user_id}",
    auth=jwt_auth,
    summary="修改协作者权限",
)
def update_collaborator_endpoint(
    request: HttpRequest, document_id: UUID, user_id: str, data: UpdateCollaboratorRequest,
):
    try:
        result = update_collaborator_permission(
            document_id=document_id,
            user_id=user_id,
            permission=data.permission,
            operator=request.auth,
        )
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response(result)


@router.delete(
    "/documents/{document_id}/collaborators/{user_id}",
    auth=jwt_auth,
    summary="移除协作者",
)
def remove_collaborator_endpoint(
    request: HttpRequest, document_id: UUID, user_id: str,
):
    try:
        remove_collaborator(
            document_id=document_id,
            user_id=user_id,
            operator=request.auth,
        )
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response({"removed": True})

"""
OSS对象存储服务API接口
"""

import os
import re
import uuid
import hashlib
import mimetypes
from typing import List, Optional
from urllib.parse import urlparse
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.core.files.uploadedfile import UploadedFile
from django.conf import settings
from django.db import models
from django.core.signing import BadSignature, SignatureExpired, TimestampSigner
from django.utils import timezone
from ninja import Router, File, Form, UploadedFile as NinjaUploadedFile

from django.core.cache import cache as django_cache
from .services.factory import get_oss_service
from .services.file_access import (
    FileAccessNotFound,
    resolve_authorized_file,
    resolve_file_access,
)
from .models import FileRecord, OSSConfig, UploadTask
from .utils.mime_utils import detect_mime_from_buffer
from .schemas import (
    FileUploadRequest, FileUploadResponse, BatchUploadRequest, BatchUploadResponse,
    FileListRequest, FileListResponse, FileInfo, FileUpdateRequest,
    FileCopyRequest, FileMoveRequest, BatchDeleteRequest, BatchDeleteResponse,
    PresignedUrlRequest, PresignedUrlResponse, TaskInfo, TaskListRequest, TaskListResponse,
    BucketInfo, StatisticsRequest, StatisticsResponse, SuccessResponse, ErrorResponse,
    StorageBatchDeleteRequest,
)
from ..common.utils import generate_request_id, get_file_type_from_extension
from ..common.exceptions import OSSServiceException, ValidationException
from apps.users.auth.permissions import JWTAuth
from apps.services.billing.services.guard_service import BillingBlockedError
from apps.i18n import _
import logging

logger = logging.getLogger(__name__)
router = Router()
jwt_auth = JWTAuth()


def _check_business_resource_file_access(file_record: FileRecord, user) -> bool:
    """旧客户端兼容：仅接受业务域已有引用和资源权限，不接受组织成员兜底。"""
    try:
        from apps.tabdata.services.attachment_service import AttachmentService

        if AttachmentService(user=user).can_access_existing_reference(file_record):
            return True
    except Exception:
        logger.warning(
            "TabData business file access check failed closed: file=%s user=%s",
            file_record.id,
            getattr(user, 'id', None),
            exc_info=True,
        )

    try:
        from apps.chat.conversation.api._common import user_can_access_session
        from apps.chat.conversation.models import ChatMessage
        from .models import FileUsage

        message_ids = FileUsage.objects.filter(
            file_record=file_record,
            module='chat',
            context_type='message',
            is_active=True,
        ).exclude(context_id='').values_list('context_id', flat=True)
        session_ids = ChatMessage.objects.filter(
            id__in=message_ids,
        ).values_list('session_id', flat=True).distinct()
        return any(user_can_access_session(session_id, user) for session_id in session_ids)
    except Exception:
        logger.warning(
            "Chat business file access check failed closed: file=%s user=%s",
            file_record.id,
            getattr(user, 'id', None),
            exc_info=True,
        )
        return False


def _model_field_was_set(model, field_name: str) -> bool:
    """兼容 Pydantic v1/v2 判断客户端是否显式传入字段。"""
    fields_set = getattr(model, "model_fields_set", None)
    if fields_set is None:
        fields_set = getattr(model, "__fields_set__", set())
    return field_name in fields_set


def _log_implicit_is_public_default(
    *,
    endpoint: str,
    module: str = "",
    context_type: str = "",
    context_id: str = "",
    user_id: str = "",
) -> None:
    logger.warning(
        "OSS is_public 未显式声明，Phase1 使用安全默认值或兼容默认值: "
        "endpoint=%s module=%s context=%s/%s user=%s",
        endpoint,
        module or "other",
        context_type or "",
        context_id or "",
        user_id or "",
    )


_LONG_LIVED_PUBLIC_MODULES = {'tabfiles'}


def _effective_is_public_for_module(module: str = '', requested_is_public: bool | None = False) -> bool:
    """Return the OSS visibility expected by the product for a module.

    TabFiles is the user's cloud drive: product permissions live in Space/file
    records, while the stored object URL should remain long-lived like avatars.

    TabData and TabDoc's current clients explicitly request private objects.
    Preserve an explicit public request from an already-released client: old
    TabDoc versions persist image URLs and cannot refresh a private URL by
    ``file_id``.  Silently forcing those requests private would turn the first
    signed upload response into an expiring persisted URL.
    """
    normalized_module = (module or '').strip()
    if normalized_module in _LONG_LIVED_PUBLIC_MODULES:
        return True
    return bool(requested_is_public)


def _ensure_instant_hit_public_if_needed(file_record: FileRecord, *, is_public: bool) -> bool:
    """Ensure hash-dedup instant uploads respect public asset requests.

    A new chat/table/doc upload can hit an older private FileRecord by hash. In
    that case we either upgrade the existing object to public-read or skip
    instant upload so the caller creates a fresh public object.
    """
    if not is_public or file_record.is_public:
        return True

    oss_service = get_oss_service()
    public_acl_ok = oss_service.set_object_public_read(file_record.file_key)
    if not public_acl_ok:
        logger.warning(
            "秒传命中私有文件但 public-read ACL 升级失败，回落新上传: file_id=%s file_key=%s",
            file_record.id,
            file_record.file_key,
        )
        return False

    file_record.is_public = True
    file_record.save(update_fields=["is_public", "updated_at"])
    return True


def _is_instant_hit_compatible_with_upload_scope(
    file_record: FileRecord,
    *,
    module: str | None,
    context_type: str | None,
    is_public: bool,
    folder: str | None = None,
    object_key: str | None = None,
) -> bool:
    """私有云盘 / TabDoc HTML 不能复用公开 FileRecord，其他入口保持既有秒传行为。

    ：私有 TabDoc HTML 若秒传命中历史公开对象，会把「新块」绑到仍可匿名读的
    永久 URL 上；与强制 private + set_object_private 的目标冲突，故禁止秒传。
    """
    if not is_public and file_record.is_public:
        if _is_space_tabfiles_upload(module, context_type):
            return False
        if _is_tabdoc_html_upload(module=module, folder=folder, object_key=object_key):
            return False
        # Also refuse when the existing record itself lives under tabdoc/html/
        # (hash hit without folder on confirm path).
        existing_key = (getattr(file_record, "file_key", None) or "").lstrip("/")
        if (module or "").strip() == "tabdoc" and existing_key.startswith(_HTML_EMBED_KEY_PREFIX):
            return False
    return _ensure_instant_hit_public_if_needed(file_record, is_public=is_public)


def _safe_error_response(
    e: Exception,
    default_msg: str,
    *,
    error_code: str = "INTERNAL_ERROR",
    status_code: int = 500,
    log_context: str = "",
    detail: Optional[str] = None,
) -> dict:
    """P1-16: 记录完整异常到日志，返回脱敏的通用错误消息给客户端。"""
    logger.error("%s: %s", log_context or default_msg, e, exc_info=True)
    response = {
        "success": False,
        "message": default_msg,
        "data": None,
        "error_code": error_code,
        "timestamp": "",
    }
    if detail:
        response["detail"] = detail
    return response


_PRESIGN_CONFIG_DETAIL = "OSS 配置不完整"
_PRESIGN_PERMISSION_DETAIL = "OSS 权限不足"
_PRESIGN_BUCKET_DETAIL = "OSS Bucket 配置不可用"
_PRESIGN_ENDPOINT_DETAIL = "OSS Endpoint 网络或配置不可用"
_PRESIGN_GENERIC_DETAIL = "OSS 签名服务异常，请查看服务端日志"

_PRESIGN_FAILURE_DETAIL_PATTERNS = (
    (
        re.compile(
            r"access[_-]?key|secret|credential|token|password|未配置|缺少|missing|required|empty|config",
            re.I,
        ),
        _PRESIGN_CONFIG_DETAIL,
    ),
    (
        re.compile(r"accessdenied|forbidden|permission|unauthori[sz]ed|acl|权限", re.I),
        _PRESIGN_PERMISSION_DETAIL,
    ),
    (re.compile(r"bucket|nosuchbucket", re.I), _PRESIGN_BUCKET_DETAIL),
    (
        re.compile(r"endpoint|host|dns|connect|connection|timeout|network", re.I),
        _PRESIGN_ENDPOINT_DETAIL,
    ),
)


def _safe_presign_failure_detail(e: Exception) -> str:
    """Return a diagnostic OSS presign detail without exposing credentials or internal paths."""
    raw_message = str(e or "")
    for pattern, detail in _PRESIGN_FAILURE_DETAIL_PATTERNS:
        if pattern.search(raw_message):
            return detail
    return _PRESIGN_GENERIC_DETAIL


# ---------------------------------------------------------------------------
# 辅助：获取当前用户 ID（认证接口中 request.auth 是 User 实例）
# ---------------------------------------------------------------------------
def _get_user_id(request: HttpRequest) -> str:
    auth = getattr(request, 'auth', None)
    if auth is not None:
        return str(auth.id)
    return ''


def _try_authenticate_jwt(request: HttpRequest):
    """尝试从 Authorization header 提取 JWT 认证，不强制要求。

    成功时设置 request.auth 并返回 User 实例；
    失败或无 header 时返回 None（不拒绝请求）。
    """
    auth_header = request.META.get('HTTP_AUTHORIZATION', '')
    if not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:]
    try:
        user = jwt_auth.authenticate(request, token)
        if user is not None:
            request.auth = user
        return user
    except Exception:
        return None


_UPLOAD_CONFIG_SAFE_DEFAULTS = {
    "presets": {},
    "allowed_extensions": [],
    "max_file_size": 100 * 1024 * 1024,
}


def _oss_resolve_organization(organization_id: str, request: HttpRequest) -> str:
    """解析显式 organization 上下文；OSS 不隐式 fallback 到 personal organization。"""
    if organization_id:
        return organization_id
    from apps.services.billing.organization_resolver import resolve_organization_id_from_request
    return resolve_organization_id_from_request(request)


def _check_organization_membership(user, organization_id: str) -> bool:
    """P1-14: 校验用户在指定 organization 中是否有成员身份。

    fail-closed: user 为空时拒绝；organization_id 为空时拒绝
    （调用方对历史无 organization 文件应在函数外单独处理）。
    """
    if not user:
        return False
    if not organization_id:
        return False
    try:
        from apps.tabtinspace.models import OrganizationMember
        return OrganizationMember.objects.filter(
            organization_id=organization_id,
            user_id=user.id,
        ).exists()
    except Exception:
        return False


def _billing_blocked_response():
    return {
        "success": False,
        "message": _("billing.billing_blocked"),
        "data": None,
        "error_code": "BILLING_BLOCKED",
        "timestamp": "",
    }


def _compute_quota_warning(decision: dict | None) -> dict | None:
    """根据配额评估结果计算阶梯式预警（80%/90%/95%）。

    复用 assert_storage_with_reservation / assert_storage_upload_allowed
    已返回的 decision dict，不引入额外 DB 查询。
    """
    if not decision:
        return None
    package_bytes = decision.get('storage_package_bytes', 0)
    if not package_bytes or package_bytes <= 0:
        return None
    projected_bytes = decision.get('projected_storage_bytes', 0)
    usage_ratio = projected_bytes / package_bytes
    if usage_ratio >= 0.95:
        return {'level': 'critical', 'usage_percent': round(usage_ratio * 100)}
    if usage_ratio >= 0.90:
        return {'level': 'warning', 'usage_percent': round(usage_ratio * 100)}
    if usage_ratio >= 0.80:
        return {'level': 'info', 'usage_percent': round(usage_ratio * 100)}
    return None


def _is_hash_algorithm_compatible(stored_algo: str, request_algo: str) -> bool:
    """判断秒传时存储的 hash_algorithm 与请求声明的是否兼容。

    规则：
    - 两者都非空且相等 → 兼容（同算法匹配）
    - 两者都为 sha256-sampled → 兼容
    - 任一为空（旧数据 / 未声明） → 不兼容（避免跨算法误匹配）
    """
    if not stored_algo or not request_algo:
        return False
    return stored_algo == request_algo


# ---------------------------------------------------------------------------
# Deprecated 中转上传路径 — 统一 Deprecation 响应包装
# ---------------------------------------------------------------------------
_RELAY_SUNSET_DATE = "Wed, 30 Sep 2026 23:59:59 GMT"
_RELAY_DEPRECATION_NOTICE = (
    "This relay-upload endpoint is deprecated. "
    "Migrate to direct upload: POST /presign-upload -> PUT to OSS -> POST /confirm-upload."
)


def _make_deprecated_json_response(body: dict, status: int = 200) -> JsonResponse:
    """将响应字典包装为带 Deprecation / Sunset header 的 JsonResponse（RFC 8594）。"""
    resp = JsonResponse(body, status=status)
    resp["Deprecation"] = "true"
    resp["Sunset"] = _RELAY_SUNSET_DATE
    resp["X-Deprecation-Notice"] = _RELAY_DEPRECATION_NOTICE
    return resp


def _require_context_id(
    context_id: str,
    endpoint_name: str,
    user_id: str,
    request_id: str,
) -> JsonResponse | None:
    """CROSS-1: context_id 必填校验。返回 None 表示通过，否则返回 400 错误响应。"""
    if context_id and context_id.strip():
        return None
    logger.error(
        "%s: context_id 为空，拒绝请求 (CROSS-1): user=%s, request_id=%s",
        endpoint_name, user_id, request_id,
    )
    return _make_deprecated_json_response({
        "success": False,
        "message": "context_id is required (CROSS-1 policy). "
                   "Please provide a valid context_id for file tracking. "
                   "Migrate to direct upload: POST /presign-upload -> PUT to OSS -> POST /confirm-upload.",
        "data": None,
        "error_code": "CONTEXT_ID_REQUIRED",
        "timestamp": "",
    }, status=400)


_PRESIGN_CACHE_PREFIX = "oss:presign:"
_PRESIGN_CACHE_BUFFER_SECONDS = 600

# ---------------------------------------------------------------------------
# PA-2: 上传接口 Organization 角色检查
# ---------------------------------------------------------------------------

def _check_upload_permission(request: HttpRequest, organization_id: str) -> dict | None:
    """检查用户是否有在指定 Organization 上传文件的权限。

    viewer 角色不允许上传。返回 None 表示通过，否则返回 403 错误响应。
    当 organization_id 为空时（个人/无归属上传）跳过检查。
    """
    if not organization_id:
        return None
    user_role = _get_user_role(request, organization_id)
    if user_role == "viewer":
        return {
            "success": False,
            "message": "查看者无权上传文件",
            "data": None,
            "error_code": "PERMISSION_DENIED",
            "timestamp": "",
        }
    return None


def _check_organization_resource_write_policy(organization_id: str) -> dict | None:
    if not organization_id:
        return None
    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        assert_organization_resource_write_allowed,
    )

    try:
        assert_organization_resource_write_allowed(organization_id)
        return None
    except OrganizationControlBlockedError as exc:
        return {
            "success": False,
            "message": exc.message,
            "data": exc.to_response_data(),
            "error_code": exc.code,
            "timestamp": "",
        }


# ---------------------------------------------------------------------------
# TA-7: Content-Type 安全校验
# ---------------------------------------------------------------------------

from .constants import DANGEROUS_EXECUTABLE_MIMES, DANGEROUS_WEB_CONTENT_MIMES


def _is_dangerous_mime(content_type: str) -> bool:
    """检查 content_type 是否为已知危险可执行类型（PHP/Shell/EXE 等）。

    Web 内容类型（HTML/JS）在 TabSite 等场景中合法，仅记录告警不拦截。
    """
    if not content_type:
        return False
    ct_lower = content_type.lower().split(';')[0].strip()
    if ct_lower in DANGEROUS_EXECUTABLE_MIMES:
        return True
    if ct_lower in DANGEROUS_WEB_CONTENT_MIMES:
        logger.info("上传 web 内容类型文件（允许但记录）: content_type=%s", content_type)
    return False


def _resolve_confirmed_content_type(
    declared_ct: str | None,
    oss_info: dict,
) -> str:
    """从 OSS head_object 结果和前端声明中确定最终 content_type。

    OSS 返回的 content_type 是客户端 PUT 时实际携带的值，
    当它与前端声明不一致时优先使用 OSS 值。
    """
    oss_ct = ''
    if oss_info.get('success') and oss_info.get('data'):
        oss_ct = oss_info['data'].get('content_type', '')

    if oss_ct and oss_ct != 'application/octet-stream':
        return oss_ct

    return declared_ct or 'application/octet-stream'


def _cache_presign_token(
    object_key: str,
    user_id: str,
    expires_in: int,
    reserved_bytes: int = 0,
    *,
    module: str = "",
    context_type: str = "",
    context_id: str = "",
    organization_id: str = "",
    is_public: bool = False,
) -> None:
    """presign 时缓存结构化数据，供 confirm 阶段校验归属和释放预留。

    P1-3: 存储 reserved_bytes 以便 confirm 释放时与 presign 预留对齐。
    """
    cache_key = f"{_PRESIGN_CACHE_PREFIX}{object_key}"
    django_cache.set(cache_key, {
        "user_id": user_id,
        "reserved_bytes": reserved_bytes,
        "module": module or "other",
        "context_type": context_type or "",
        "context_id": context_id or "",
        "organization_id": organization_id or "",
        "is_public": bool(is_public),
    }, timeout=expires_in + _PRESIGN_CACHE_BUFFER_SECONDS)


def _verify_presign_ownership(
    object_key: str,
    user_id: str,
    *,
    module: str | None = None,
    context_type: str | None = None,
    context_id: str | None = None,
    organization_id: str | None = None,
    is_public: bool | None = None,
) -> dict | None:
    """校验 object_key 是否由当前用户 presign。

    P1-15 fail-closed: Redis 异常时拒绝请求，不降级放行。
    - Redis 连接异常 → 返回错误响应（拒绝）
    - Key 不存在（过期或从未 presign）→ 返回错误响应（拒绝）
    - Key 存在但归属不匹配 → 返回错误响应（拒绝）
    - Key 存在且归属匹配 → 返回 None（校验通过）

    Returns:
        None — 校验通过。
        dict — 校验失败时的错误响应。
    """
    cache_key = f"{_PRESIGN_CACHE_PREFIX}{object_key}"
    try:
        cached = django_cache.get(cache_key)
    except Exception as exc:
        logger.error(
            "presign 缓存连接异常（fail-closed 拒绝请求）: object_key=%s, user=%s, error=%s",
            object_key, user_id, exc,
        )
        return {
            "success": False,
            "message": "presign 校验服务暂不可用，请稍后重试",
            "data": None,
            "error_code": "PRESIGN_CHECK_UNAVAILABLE",
            "timestamp": "",
        }
    if cached is None:
        logger.warning(
            "presign 缓存 key 不存在（拒绝，请重新 presign）: object_key=%s, user=%s",
            object_key, user_id,
        )
        return {
            "success": False,
            "message": "presign 凭证已过期或不存在，请重新获取上传签名",
            "data": None,
            "error_code": "PRESIGN_TOKEN_EXPIRED",
            "timestamp": "",
        }
    # 8.3: 兼容新旧两种缓存格式（旧: str(user_id), 新: {"user_id": ..., "reserved_bytes": ...}）
    if isinstance(cached, dict):
        presign_owner = cached.get("user_id", "")
    else:
        presign_owner = str(cached)
    if str(presign_owner) != str(user_id):
        logger.warning(
            "confirm-upload object_key 归属校验失败: object_key=%s, presign_owner=%s, confirm_user=%s",
            object_key, presign_owner, user_id,
        )
        return {
            "success": False,
            "message": "object_key 归属校验失败，无权确认此文件上传",
            "data": None,
            "error_code": "OBJECT_KEY_OWNERSHIP_MISMATCH",
            "timestamp": "",
        }
    if module is not None:
        expected_scope = (
            module or "other",
            context_type or "",
            context_id or "",
            organization_id or "",
            bool(is_public),
        )
        cached_scope = (
            cached.get("module", "") if isinstance(cached, dict) else "",
            cached.get("context_type", "") if isinstance(cached, dict) else "",
            cached.get("context_id", "") if isinstance(cached, dict) else "",
            cached.get("organization_id", "") if isinstance(cached, dict) else "",
            bool(cached.get("is_public", False)) if isinstance(cached, dict) else False,
        )
        if cached_scope != expected_scope:
            logger.warning(
                "confirm-upload scope 与 presign 不一致: object_key=%s, "
                "presign_scope=%s/%s/%s org=%s public=%s, "
                "confirm_scope=%s/%s/%s org=%s public=%s",
                object_key,
                cached_scope[0],
                cached_scope[1],
                cached_scope[2],
                cached_scope[3],
                cached_scope[4],
                expected_scope[0],
                expected_scope[1],
                expected_scope[2],
                expected_scope[3],
                expected_scope[4],
            )
            return {
                "success": False,
                "message": "上传确认范围与签名不一致，请重新获取上传签名",
                "data": None,
                "error_code": "PRESIGN_SCOPE_MISMATCH",
                "timestamp": "",
            }
    return None


@router.get("/health", auth=jwt_auth, response=SuccessResponse, tags=["健康检查"])
def health_check(request):
    """OSS服务健康检查（XC-22: 需认证，脱敏返回）"""
    try:
        oss_service = get_oss_service()
        bucket_info = oss_service.get_bucket_info()

        if bucket_info['success']:
            return {
                "success": True,
                "message": _("oss.service_healthy"),
                "data": {
                    "service": "OSS Storage",
                    "status": "healthy",
                },
                "timestamp": oss_service._get_timestamp()
            }
        else:
            logger.warning("OSS 健康检查失败: %s", bucket_info['message'])
            return {
                "success": False,
                "message": _("oss.service_error"),
                "error_code": "OSS_SERVICE_ERROR",
                "timestamp": oss_service._get_timestamp()
            }
    except Exception as e:
        return _safe_error_response(
            e, _("oss.service_unavailable"),
            error_code="OSS_SERVICE_UNAVAILABLE",
            log_context="OSS健康检查失败",
        )


@router.get("/upload-config", auth=None, response=SuccessResponse, tags=["客户端配置"])
def upload_config(request: HttpRequest):
    """返回统一上传预设，三端启动时拉取并缓存。

    已认证用户返回完整配置；未认证返回安全默认值（前端已有硬编码 fallback）。
    保留 auth=None 以兼容 app 启动时尚未登录的场景，通过 _try_authenticate_jwt
    手动尝试认证。
    """
    authenticated_user = _try_authenticate_jwt(request)

    try:
        oss_service = get_oss_service()
        timestamp = oss_service._get_timestamp()
    except Exception:
        timestamp = ""

    if authenticated_user is None:
        logger.debug("upload-config: 未认证请求，返回安全默认值")
        return {
            "success": True,
            "message": "ok",
            "data": _UPLOAD_CONFIG_SAFE_DEFAULTS,
            "timestamp": timestamp,
        }

    return {
        "success": True,
        "message": "ok",
        "data": {
            "presets": settings.OSS_UPLOAD_PRESETS,
            "allowed_extensions": settings.OSS_ALLOWED_EXTENSIONS,
            "max_file_size": settings.OSS_MAX_FILE_SIZE,
        },
        "timestamp": timestamp,
    }


def _is_local_oss_provider() -> bool:
    return getattr(settings, "SERVICES_OSS_PROVIDER", "").lower() == "local"


def _verify_local_oss_signature(
    object_key: str,
    method: str,
    signature: str,
    expires: int,
    content_length: int | None = None,
) -> bool:
    ttl = max(1, min(int(expires), 86400))
    try:
        signed_value = TimestampSigner().unsign(signature, max_age=ttl)
    except (BadSignature, SignatureExpired, ValueError):
        return False
    expected = f"{method.upper()}:{object_key}:{ttl}"
    if content_length is not None:
        expected = f"{expected}:{content_length}"
    return signed_value == expected


@router.put("/local-upload", auth=None, tags=["本地存储"])
def local_presigned_upload(
    request: HttpRequest,
    object_key: str,
    method: str = "PUT",
    expires: int = 3600,
    signature: str = "",
    content_type: str = "",
    content_length: int | None = None,
):
    """Receive a signed local-provider PUT without buffering the request payload."""
    if not _is_local_oss_provider():
        return HttpResponse("not found", status=404)
    if method.upper() != "PUT" or not _verify_local_oss_signature(
        object_key, "PUT", signature, expires, content_length
    ):
        return HttpResponse("invalid local upload signature", status=403)
    raw_request_length = request.META.get("CONTENT_LENGTH", "")
    try:
        request_length = int(raw_request_length) if raw_request_length else None
    except (TypeError, ValueError):
        return HttpResponse("invalid content length", status=400)
    if request_length is not None and request_length > settings.OSS_MAX_FILE_SIZE:
        return HttpResponse("file too large", status=413)
    if content_length is not None and request_length != content_length:
        return HttpResponse("content length mismatch", status=413)

    oss_service = get_oss_service()
    result = oss_service.upload_file(
        request,
        object_key,
        content_type=request.META.get("CONTENT_TYPE") or content_type or "application/octet-stream",
    )
    if not result.get("success") or not result.get("data"):
        if "超过限制" in str(result.get("message", "")):
            return HttpResponse("file too large", status=413)
        return HttpResponse("local storage unavailable", status=503)
    actual_size = int(result["data"].get("file_size") or 0)
    if content_length is not None and actual_size != content_length:
        oss_service.delete_file(object_key)
        return HttpResponse("content length mismatch", status=413)
    return HttpResponse(status=204)


def _is_html_content_type(content_type: str) -> bool:
    return content_type.split(";")[0].strip().lower() == "text/html"


# htmlBlock artifact 的 object_key 命名空间（上传侧写死：Electron 的 folder='tabdoc/html'、
# Go CLI 的 docHTMLUploadFolder）。放宽策略只认这个前缀，不能只看 content_type——
# local_presigned_upload 原样存下客户端声明的 Content-Type 且不校验，否则任何登录用户
# 都能把一个聊天附件声明成 text/html，白捡一份可被宿主嵌入、可执行脚本的宽松策略。
_HTML_EMBED_KEY_PREFIX = "tabdoc/html/"


def _normalize_oss_folder(folder: str | None) -> str:
    value = (folder or "").strip().strip("/")
    return f"{value}/" if value else ""


def _is_tabdoc_html_upload(
    *,
    module: str | None = None,
    folder: str | None = None,
    object_key: str | None = None,
) -> bool:
    """Detect TabDoc HTML artifact uploads (module=tabdoc + tabdoc/html/ namespace)."""
    if (module or "").strip() != "tabdoc":
        return False
    key = (object_key or "").lstrip("/")
    if key.startswith(_HTML_EMBED_KEY_PREFIX):
        return True
    return _normalize_oss_folder(folder).startswith(_HTML_EMBED_KEY_PREFIX)


def _assert_tabdoc_html_upload_private(
    *,
    module: str | None,
    folder: str | None = None,
    object_key: str | None = None,
    requested_is_public: bool | None,
) -> None:
    """#7767: refuse public TabDoc HTML uploads so old clients cannot keep leaking."""
    if not _is_tabdoc_html_upload(module=module, folder=folder, object_key=object_key):
        return
    if requested_is_public:
        raise ValidationException(
            "TabDoc HTML artifacts must be private. "
            "Upgrade the client and upload with is_public=false."
        )


def _tabdoc_html_public_upload_error_response() -> dict:
    return {
        "success": False,
        "message": (
            "TabDoc HTML artifacts must be private. "
            "Upgrade the client and upload with is_public=false."
        ),
        "data": None,
        "error_code": "TABDOC_HTML_PUBLIC_UPLOAD_FORBIDDEN",
        "timestamp": "",
    }


# TabDoc htmlBlock的 HTML artifact 嵌入策略 —— local provider（原生开发、
# LAN 与单服务器部署）走这条路径；aliyun provider 的 artifact 仍由 OSS 域名提供。
#
# `sandbox` 指令是这里的安全核心：dev 下 artifact 与 Django API 同源，一旦 URL 泄露
# 并被直接在浏览器打开（绕过 iframe 的 sandbox 属性），未受约束的脚本就能以登录态读
# API origin 的 cookie、调用 /api/**，等同于 API 域上的存储型 XSS。服务端下发 sandbox
# 后浏览器无条件把文档放进 opaque origin，两条加载路径的隔离强度就一致了。
#
# 但 sandbox 只管 origin 与 DOM 权限，**不管网络出口**：artifact 是「自包含 HTML」
# （见 Go CLI insert-html 的定义），没有联网理由，而 local-object 免认证、dev CORS 又对
# opaque origin 的 `Origin: null` 放行——留着 connect-src 等于给被污染的 artifact 一条
# 「读本机任意免认证端点 → 外传」的通路。故显式 'none'，静态资源仍可从 CDN 加载。
def _html_embed_frame_ancestors() -> str:
    """允许嵌入 artifact 的宿主来源。

    钉死已知宿主而非用端口通配（``http://127.0.0.1:*``）——通配等于允许本机任意端口的
    页面框住它做点击劫持。端口从根 ``.env`` 读，改了端口不会变成又一个「只有特定环境
    才白屏」的坑；``tabtin-file:`` 是打包态 renderer 的 scheme（tabtin-file://app/index.html）。
    """
    # 两个已知 dev 入口（Electron Vite 5175 / tabtin-web 5176）无条件兜底：
    # 各 dev profile 对 VITE_PUBLIC_WEB_BASE_URL 的赋值并不一致，只认 env 会漏。
    ports = {'5175', '5176'}
    ports.add(os.getenv('VITE_DEV_SERVER_PORT', '').strip() or '5175')
    web_base = os.getenv('VITE_PUBLIC_WEB_BASE_URL', '').strip()
    if web_base:
        try:
            parsed = urlparse(web_base)
            if parsed.port:
                ports.add(str(parsed.port))
        except ValueError:
            pass
    sources = [f'http://{host}:{port}' for port in sorted(ports) for host in ('localhost', '127.0.0.1')]
    sources.append('tabtin-file:')
    return ' '.join(sources)


_LOCAL_OBJECT_HTML_EMBED_CSP = (
    "sandbox allow-scripts allow-popups; "
    f"frame-ancestors {_html_embed_frame_ancestors()}; "
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; "
    "script-src * 'unsafe-inline' 'unsafe-eval'; "
    "style-src * 'unsafe-inline'; "
    "img-src * data: blob:; "
    "font-src * data:; "
    "connect-src 'none'; "
    "media-src * blob:; "
    "object-src 'none'; "
    # opaque origin 下 'self' 匹配不到任何来源，写 'none' 让意图直白
    "base-uri 'none'; "
    "form-action 'none'"
)


@router.get("/local-object", auth=None, tags=["本地存储"])
def local_object(
    request: HttpRequest,
    object_key: str,
    download: bool = False,
    method: str = "GET",
    expires: int = 3600,
    signature: str = "",
):
    """Serve signed or public local-provider objects over HTTP."""
    if not _is_local_oss_provider():
        return HttpResponse("not found", status=404)
    # : private FileRecords require the same short-lived signature gate as
    # remote private objects; a bare object_key remains undiscoverable.
    file_record = (
        FileRecord.objects.filter(file_key=object_key)
        .only("id", "status", "is_public")
        .first()
    )
    # A soft-deleted record can remain on the shared volume until the deferred
    # cleanup runs.  Do not let either a previously valid signature or a bare
    # object URL bypass that logical deletion window.
    if file_record is not None and file_record.status != "completed":
        return HttpResponse("not found", status=404)
    private_hit = file_record if file_record is not None and not file_record.is_public else None
    if private_hit is not None and (
        method.upper() != "GET"
        or not _verify_local_oss_signature(object_key, "GET", signature, expires)
    ):
        return HttpResponse("not found", status=404)
    result = get_oss_service().download_file(object_key)
    if not result.get("success") or not result.get("data"):
        return HttpResponse("not found", status=404)
    data = result["data"]
    content_type = data.get("content_type") or mimetypes.guess_type(object_key)[0] or "application/octet-stream"
    content = data.get("content", b"")
    response = HttpResponse(content, content_type=content_type)

    if object_key.startswith(_HTML_EMBED_KEY_PREFIX) and _is_html_content_type(content_type):
        # 嵌入策略由**视图**声明，中间件只补默认值——避免 SecurityHeaders 放宽、
        # XFrameOptions 又写回 DENY 的互搏（见 SecurityHeadersMiddleware）。
        # 条件豁免没法用 @xframe_options_exempt 装饰器表达（它是整个视图级的），
        # 故直接设属性——两者认的是同一个 response 属性。
        response.xframe_options_exempt = True
        response.csp_override = True
        response["Content-Security-Policy"] = _LOCAL_OBJECT_HTML_EMBED_CSP
        # 安全头是服务端策略而非对象内容，不能跟内容一起冻进客户端缓存：
        #  实测——放宽 CSP 前加载过一次的 artifact，被 immutable 锁着复用旧的
        # `frame-ancestors 'none'`，7 天内 Electron 连请求都不发，修复对存量客户端不生效。
        response["Cache-Control"] = "private, no-cache"
        # no-cache 要求每次 revalidate，ETag 必须跟着**内容**走。用 object_key 派生的话，
        # AI 原地重写同一个 artifact 后会 304 命中旧内容（当前无 ConditionalGetMiddleware
        # 兜不住，一旦补上或前面挂 CDN 就会踩）。
        response["ETag"] = f'"{hashlib.sha256(content).hexdigest()[:32]}"'
    else:
        # 聊天附件按 object_key 不可变；允许客户端 / 浏览器 HTTP 缓存，减少切换会话重复拉取。
        response["Cache-Control"] = "private, max-age=604800, immutable"
        response["ETag"] = f'"{hashlib.sha256(object_key.encode()).hexdigest()[:32]}"'

    if private_hit is not None:
        # Signed URLs expire, so neither HTML nor attachment responses may outlive
        # the authorization represented by the signature.
        response["Cache-Control"] = "private, no-store"

    if download:
        response["Content-Disposition"] = "attachment"
    return response


@router.post("/upload", auth=jwt_auth, response=SuccessResponse, tags=["文件操作"])
def upload_file(
    request: HttpRequest,
    file: NinjaUploadedFile = File(...),
    folder: str = Form(""),
    filename: Optional[str] = Form(None),
    tags: Optional[str] = Form(""),
    is_public: bool = Form(True),
    organization_id: str = Form(""),
    module: str = Form(""),
    context_type: str = Form(""),
    context_id: str = Form(""),
):
    """
    [DEPRECATED] 单文件上传（中转模式）。

    此接口已废弃，请迁移至直传模式：
        POST /presign-upload → PUT 直传 OSS → POST /confirm-upload
    Sunset: 2026-09-30
    """
    request_id = generate_request_id()
    user_id = _get_user_id(request)

    organization_id = _oss_resolve_organization(organization_id, request)
    policy_err = _check_organization_resource_write_policy(organization_id)
    if policy_err is not None:
        return _make_deprecated_json_response(policy_err)

    logger.warning(
        "[DEPRECATED] 中转上传 POST /upload 被调用: user=%s, request_id=%s, "
        "请迁移至直传模式 (presign-upload → PUT → confirm-upload)",
        user_id, request_id,
    )
    if 'is_public' not in request.POST:
        _log_implicit_is_public_default(
            endpoint="POST /upload",
            module=module,
            context_type=context_type,
            context_id=context_id,
            user_id=user_id,
        )

    ctx_err = _require_context_id(context_id, "upload_file", user_id, request_id)
    if ctx_err is not None:
        return ctx_err

    try:
        logger.info(f"开始文件上传 - 请求ID: {request_id}, 用户: {user_id}")

        if not file:
            raise ValidationException(_("oss.no_file_provided"))

        _assert_tabdoc_html_upload_private(
            module=module,
            folder=folder,
            requested_is_public=bool(is_public),
        )
        if _is_tabdoc_html_upload(module=module, folder=folder):
            is_public = False

        max_size = settings.OSS_MAX_FILE_SIZE
        if file.size > max_size:
            raise ValidationException(_("oss.file_size_exceeded", size=file.size, max_size=max_size))

        if organization_id and file.size > 0:
            try:
                from .services.storage_reservation import assert_storage_with_reservation
                assert_storage_with_reservation(
                    organization_id=organization_id,
                    incoming_bytes=file.size,
                )
            except BillingBlockedError as blocked_exc:
                return _make_deprecated_json_response(_billing_blocked_response())
            except ValueError as quota_exc:
                return _make_deprecated_json_response({
                    "success": False,
                    "message": str(quota_exc),
                    "data": None,
                    "error_code": "STORAGE_QUOTA_EXCEEDED",
                    "timestamp": "",
                })
            except Exception as exc:
                logger.error("upload_file 配额检查系统异常: organization=%s, err=%s", organization_id, exc)
                return _make_deprecated_json_response({
                    "success": False,
                    "message": _("oss.storage_check_failed"),
                    "data": None,
                    "error_code": "STORAGE_CHECK_ERROR",
                    "timestamp": "",
                })

        original_filename = filename or file.name
        file_extension = os.path.splitext(original_filename)[1].lower().lstrip('.')

        allowed_extensions = getattr(settings, 'OSS_ALLOWED_EXTENSIONS', [])
        if allowed_extensions and file_extension not in allowed_extensions:
            raise ValidationException(_("oss.file_type_unsupported", ext=file_extension))

        folder = folder.strip('/') + '/' if folder.strip('/') else ''
        file_key = f"{folder}{uuid.uuid4().hex}.{file_extension}"

        # 只读取一次文件内容：计算 hash + 检测 MIME
        file.seek(0)
        file_content = file.read()
        file_hash = hashlib.md5(file_content).hexdigest()
        file.seek(0)

        mime_type = detect_mime_from_buffer(
            file_content,
            file.content_type or 'application/octet-stream',
        )

        oss_service = get_oss_service()

        # 将 hash 传给 OSS 服务，避免内部再次读取计算
        upload_result = oss_service.upload_file(
            file,
            file_key,
            content_type=mime_type,
            file_hash=file_hash,
        )

        if not upload_result['success']:
            raise OSSServiceException(_("oss.upload_failed", detail=upload_result['message']))

        # 私有对象必须显式钉 object ACL；不能依赖 bucket 默认值。
        if not is_public:
            if not oss_service.set_object_private(file_key):
                logger.warning(
                    "私有对象 ACL 设置失败: object_key=%s request_id=%s",
                    file_key,
                    request_id,
                )
                try:
                    oss_service.delete_file(file_key)
                except Exception:
                    logger.error(
                        "私有对象 ACL 失败后清理 OSS 文件失败: object_key=%s request_id=%s",
                        file_key,
                        request_id,
                    )
                if organization_id and file.size > 0:
                    try:
                        from .services.storage_reservation import release_bytes
                        release_bytes(organization_id, int(file.size))
                    except Exception:
                        logger.warning(
                            "私有对象 ACL 失败后释放预留失败: organization=%s size=%s",
                            organization_id,
                            file.size,
                        )
                return _make_deprecated_json_response({
                    "success": False,
                    "message": "私有 HTML 资产访问权限设置失败，请检查 OSS Bucket/AK 权限",
                    "data": None,
                    "error_code": "PRIVATE_ACL_FAILED",
                    "timestamp": "",
                })

        file_record = FileRecord.objects.create(
            file_name=original_filename,
            file_key=file_key,
            file_path=folder,
            file_size=file.size,
            file_type=get_file_type_from_extension(file_extension),
            mime_type=mime_type,
            file_extension=file_extension,
            file_hash=file_hash,
            bucket_name=oss_service.config.get('bucket_name'),
            access_url=upload_result['data']['access_url'],
            cdn_url=upload_result['data'].get('cdn_url', ''),
            is_public=is_public,
            upload_user=user_id,
            upload_source='api',
            upload_ip=request.META.get('REMOTE_ADDR'),
            tags=tags.split(',') if tags else [],
            metadata={
                'request_id': request_id,
                'upload_method': 'single',
            },
        )

        file_record.mark_as_completed(
            access_url=upload_result['data']['access_url'],
            cdn_url=upload_result['data'].get('cdn_url', ''),
        )

        effective_uid = str(user_id)
        if module:
            try:
                from .models import FileUsage
                FileUsage.add_usage(
                    file_record=file_record,
                    user_id=effective_uid,
                    module=module,
                    context_type=context_type,
                    context_id=context_id,
                )
            except Exception as usage_exc:
                logger.warning("upload_file FileUsage 创建失败（不影响上传）: %s", usage_exc)

        if organization_id and file.size > 0:
            try:
                file_record.organization_id = organization_id
                file_record.save(update_fields=["organization_id"])
                from apps.services.billing.services import OrganizationStorageBillingService
                OrganizationStorageBillingService.apply_storage_delta(
                    organization_id=organization_id,
                    file_id=str(file_record.id),
                    delta_bytes=int(file.size),
                    user_id=effective_uid,
                    biz_type="oss_upload",
                    biz_id=str(file_record.id),
                )
                # QTA-10: 快照已更新，释放 Redis 预留
                try:
                    from .services.storage_reservation import release_bytes
                    release_bytes(organization_id, int(file.size))
                except Exception:
                    pass
            except Exception as billing_exc:
                logger.error(
                    "upload_file 存储计量失败（计量泄漏待补偿）: file=%s, organization=%s, delta=%d, err=%s",
                    file_record.id, organization_id, file.size, billing_exc,
                )
                compensation_meta = file_record.metadata or {}
                compensation_meta['billing_compensation'] = {
                    'pending': True,
                    'organization_id': organization_id,
                    'delta_bytes': int(file.size),
                    'biz_type': 'oss_upload',
                    'error': str(billing_exc)[:500],
                }
                file_record.metadata = compensation_meta
                file_record.save(update_fields=['metadata', 'updated_at'])
                try:
                    from apps.services.billing.services.degradation_tracker import track_billing_degradation
                    track_billing_degradation(
                        meter_key="storage.upload",
                        organization_id=organization_id,
                        biz_type="oss_upload",
                        error=str(billing_exc),
                    )
                except Exception:
                    pass

        logger.info(f"文件上传成功 - 文件ID: {file_record.id}, 请求ID: {request_id}")

        response_data = file_record.to_response_dict()
        if not file_record.is_public:
            accessible = resolve_authorized_file(
                file_record,
                expiration=3600,
                oss_service=oss_service,
            )
            response_data.update({
                "access_url": accessible.url,
                "cdn_url": "",
                "resolved_url": accessible.url,
                "access_mode": accessible.access_mode,
                "expires_in": accessible.expires_in,
                "expires_at": accessible.expires_at,
            })

        return _make_deprecated_json_response({
            "success": True,
            "message": _("oss.upload_success"),
            "data": response_data,
            "timestamp": oss_service._get_timestamp(),
        })

    except Exception as e:
        logger.error("文件上传失败 - 请求ID: %s, 错误: %s", request_id, e, exc_info=True)
        return _make_deprecated_json_response({
            "success": False,
            "message": _("oss.upload_failed"),
            "data": None,
            "error_code": "UPLOAD_FAILED",
            "timestamp": "",
        })


@router.get("/files", auth=jwt_auth, response=SuccessResponse, tags=["文件操作"])
def list_files(
    request: HttpRequest,
    folder: str = "",
    file_type: Optional[str] = None,
    search: str = "",
    page: int = 1,
    page_size: int = 20,
    sort_by: str = "created_at",
    sort_order: str = "desc"
):
    """
    获取文件列表

    Args:
        folder: 文件夹路径过滤
        file_type: 文件类型过滤
        search: 搜索关键词
        page: 页码
        page_size: 每页数量
        sort_by: 排序字段
        sort_order: 排序方向
    """
    try:
        user_id = str(request.auth.id)
        queryset = FileRecord.objects.filter(
            status='completed',
            upload_user=user_id,
        )

        if folder:
            folder = folder.strip('/') + '/'
            queryset = queryset.filter(file_path__startswith=folder)

        # 文件类型过滤
        if file_type:
            queryset = queryset.filter(file_type=file_type)

        # 搜索过滤
        if search:
            queryset = queryset.filter(file_name__icontains=search)

        # 排序
        if sort_order == 'desc':
            sort_by = f'-{sort_by}'
        queryset = queryset.order_by(sort_by)

        # 分页
        total = queryset.count()
        start = (page - 1) * page_size
        end = start + page_size
        files = queryset[start:end]

        file_list = [fr.to_response_dict() for fr in files]

        response_data = {
            'files': file_list,
            'total': total,
            'page': page,
            'page_size': page_size,
            'total_pages': (total + page_size - 1) // page_size
        }

        return {
            "success": True,
            "message": _("oss.file_list_success", total=total),
            "data": response_data,
            "timestamp": ""
        }

    except Exception as e:
        return _safe_error_response(
            e, _("oss.file_list_failed"),
            error_code="LIST_FILES_FAILED",
            log_context="获取文件列表失败",
        )


@router.get(
    "/files/{file_id}",
    auth=jwt_auth,
    response={200: SuccessResponse, 404: SuccessResponse},
    tags=["文件操作"],
)
def get_file_info(request: HttpRequest, response: HttpResponse, file_id: str):
    """获取文件详情"""
    try:
        file_record = FileRecord.objects.get(id=file_id, status='completed')
        accessible = resolve_file_access(
            file_record,
            request.auth,
            membership_checker=_check_organization_membership,
            business_access_checker=_check_business_resource_file_access,
        )
        if not file_record.is_public:
            response["Cache-Control"] = "private, no-store"
            response["Vary"] = "Authorization"

        file_record.increment_view_count()
        response_data = file_record.to_response_dict()
        if not file_record.is_public:
            response_data.update({
                # Keep old clients working without changing the persisted URL.
                "access_url": accessible.url,
                # Electron currently prefers cdn_url, so private records must
                # not expose a bare CDN URL ahead of the signed access_url.
                "cdn_url": "",
            })
        response_data.update({
            "resolved_url": accessible.url,
            "access_mode": accessible.access_mode,
            "expires_at": accessible.expires_at,
            "expires_in": accessible.expires_in,
        })

        return {
            "success": True,
            "message": _("oss.file_info_success"),
            "data": response_data,
            "timestamp": "",
        }

    except (FileRecord.DoesNotExist, FileAccessNotFound):
        response["Cache-Control"] = "private, no-store"
        response["Vary"] = "Authorization"
        return 404, {
            "success": False,
            "message": _("oss.file_not_found"),
            "data": None,
            "error_code": "FILE_NOT_FOUND",
            "timestamp": "",
        }
    except Exception as e:
        return _safe_error_response(
            e, _("oss.file_info_failed"),
            error_code="GET_FILE_INFO_FAILED",
            log_context="获取文件信息失败",
        )


@router.get("/download/{file_id}", auth=jwt_auth, tags=["文件操作"])
def download_file(request: HttpRequest, file_id: str):
    """
    下载文件

    Args:
        file_id: 文件ID
    """
    try:
        file_record = FileRecord.objects.get(id=file_id, status='completed')
        accessible = resolve_file_access(
            file_record,
            request.auth,
            membership_checker=_check_organization_membership,
            business_access_checker=_check_business_resource_file_access,
        )

        file_record.increment_download_count()

        from django.shortcuts import redirect
        response = redirect(accessible.url)
        if not file_record.is_public:
            response["Cache-Control"] = "private, no-store"
            response["Vary"] = "Authorization"
        return response

    except (FileRecord.DoesNotExist, FileAccessNotFound):
        return HttpResponse(_("oss.file_not_found"), status=404)
    except OSSServiceException:
        return HttpResponse(_("oss.download_failed"), status=500)
    except Exception as e:
        logger.error(f"文件下载失败: {e}")
        return HttpResponse(_("oss.download_failed"), status=500)


def _release_storage_on_delete(ws_id: str, file_id: str, file_size: int, user_id: str) -> None:
    """事务提交后释放存储配额，失败则标记补偿（方案 2.4）。"""
    try:
        from apps.services.billing.services import OrganizationStorageBillingService
        OrganizationStorageBillingService.apply_storage_delta(
            organization_id=ws_id,
            file_id=file_id,
            delta_bytes=-file_size,
            user_id=user_id,
            biz_type="oss_file_delete",
            biz_id=file_id,
        )
    except Exception as billing_exc:
        logger.warning("文件删除存储计量释放失败（不影响删除）: %s", billing_exc)
        try:
            from apps.services.billing.services.degradation_tracker import track_billing_degradation
            track_billing_degradation(meter_key="storage.release", organization_id=ws_id, error=str(billing_exc))
        except Exception:
            pass
        try:
            from apps.services.oss.models import FileRecord as _FR
            fr = _FR.objects.filter(id=file_id).first()
            if fr:
                comp = dict(fr.metadata or {})
                comp['billing_compensation'] = {
                    'pending': True,
                    'organization_id': ws_id,
                    'delta_bytes': -file_size,
                    'biz_type': 'oss_file_delete',
                    'error': str(billing_exc)[:500],
                }
                fr.metadata = comp
                fr.save(update_fields=['metadata', 'updated_at'])
        except Exception:
            pass


@router.delete("/files/{file_id}", auth=jwt_auth, response=SuccessResponse, tags=["文件操作"])
def delete_file(request: HttpRequest, file_id: str):
    """
    删除文件（引用安全模式）。

    如果 ref_count > 1，说明其他地方仍在引用，仅返回提示。
    如果 ref_count <= 1，软删除 FileRecord 并标记待清理
    （物理文件由定时任务延迟删除）。

    DEL-9: 使用 transaction.atomic + select_for_update 防止并发竞态。
    """
    from django.db import transaction as db_transaction
    from .models import FileUsage

    try:
        user_id = str(request.auth.id)

        with db_transaction.atomic():
            try:
                file_record = FileRecord.objects.select_for_update().get(id=file_id)
            except FileRecord.DoesNotExist:
                return {
                    "success": False,
                    "message": _("oss.file_not_found"),
                    "data": None,
                    "error_code": "FILE_NOT_FOUND",
                    "timestamp": "",
                }

            is_owner = file_record.upload_user == user_id
            has_usage = FileUsage.objects.filter(
                file_record=file_record, user_id=user_id, is_active=True,
            ).exists() if not is_owner else False
            if not is_owner and not has_usage:
                return {
                    "success": False,
                    "message": _("oss.file_not_found"),
                    "data": None,
                    "error_code": "FILE_NOT_FOUND",
                    "timestamp": "",
                }

            policy_err = _check_organization_resource_write_policy(str(file_record.organization_id or ""))
            if policy_err is not None:
                return policy_err

            if file_record.ref_count > 1:
                return {
                    "success": False,
                    "message": _("oss.file_still_referenced", ref_count=file_record.ref_count),
                    "data": {"file_id": file_id, "ref_count": file_record.ref_count},
                    "error_code": "FILE_STILL_REFERENCED",
                    "timestamp": "",
                }

            active_usages = FileUsage.objects.filter(
                file_record=file_record, is_active=True,
            )
            for usage in active_usages:
                usage.deactivate()

            file_record.refresh_from_db(fields=['ref_count'])
            file_record.soft_delete()

            # 在事务内解析 ws_id，事务提交后再执行计量释放（方案 2.4）
            ws_id = (
                getattr(file_record, 'organization_id', '')
                or (file_record.metadata or {}).get('organization_id', '')
            )
            if not ws_id:
                try:
                    upload_task = UploadTask.objects.filter(
                        files=file_record,
                        organization_id__gt='',
                    ).values_list('organization_id', flat=True).first()
                    if upload_task:
                        ws_id = upload_task
                except Exception:
                    pass
            if not ws_id and file_record.file_size > 0:
                logger.warning(
                    "delete_file 无法确定 organization_id，跳过计量释放: file=%s",
                    file_record.id,
                )

            _del_ws_id = ws_id
            _del_file_id = str(file_record.id)
            _del_file_size = int(file_record.file_size)
            _del_user_id = user_id
            if _del_ws_id and _del_file_size > 0:
                db_transaction.on_commit(
                    lambda: _release_storage_on_delete(
                        _del_ws_id, _del_file_id, _del_file_size, _del_user_id,
                    )
                )

        return {
            "success": True,
            "message": _("oss.file_marked_deleted"),
            "data": {"file_id": file_id},
            "timestamp": "",
        }

    except Exception as e:
        return _safe_error_response(
            e, _("oss.delete_failed"),
            error_code="DELETE_FAILED",
            log_context="删除文件失败",
        )


@router.post("/presigned-url", auth=jwt_auth, response=SuccessResponse, tags=["文件操作"])
def generate_presigned_url(request: HttpRequest, data: PresignedUrlRequest):
    """
    生成预签名URL

    Args:
        data: 预签名URL请求数据
    """
    try:
        file_record = FileRecord.objects.get(id=data.file_id, status='completed')

        # 安全（P0 IDOR / 数据泄漏）：与 /files/{file_id} (line 729) / /download/{file_id} (line 778)
        # 保持一致的 organization 校验，防止跨 organization agent 拿到别人 file_id 后直接调本端点
        # 拿签名 URL 越权下载。本端点比 download 更敏感（URL 可被分发 / 缓存 / 嵌入），
        # 因此放在 owner/public 判断之前，即使 is_public=True 也要先过 organization 校验。
        # 详见 apps/services/oss/PRD-presign-organization-isolation-fix.md。
        if file_record.organization_id and not _check_organization_membership(request.auth, file_record.organization_id):
            return {
                "success": False,
                "message": _("oss.file_not_found"),
                "data": None,
                "error_code": "FILE_NOT_FOUND",
                "timestamp": "",
            }

        user_id = _get_user_id(request)
        is_owner = file_record.upload_user == user_id
        if data.method == 'PUT' and not is_owner:
            return {
                "success": False,
                "message": "无权为该文件生成写入签名",
                "data": None,
                "error_code": "FILE_ACCESS_DENIED",
                "timestamp": "",
            }
        if not file_record.is_public and not is_owner:
            return {
                "success": False,
                "message": "无权访问该私有文件",
                "data": None,
                "error_code": "FILE_ACCESS_DENIED",
                "timestamp": "",
            }

        oss_service = get_oss_service()
        ct = getattr(file_record, 'mime_type', None) if data.method == 'PUT' else None
        try:
            presigned_url = oss_service.generate_presigned_url(
                file_record.file_key,
                expiration=data.expiration,
                method=data.method,
                content_type=ct,
            )
        except OSSServiceException as oss_exc:
            return {
                "success": False,
                "message": _("oss.presign_failed"),
                "data": None,
                "error_code": "PRESIGNED_URL_FAILED",
                "timestamp": "",
            }

        from datetime import datetime, timedelta
        expires_at = datetime.now() + timedelta(seconds=data.expiration)

        response_data = {
            'file_id': data.file_id,
            'presigned_url': presigned_url,
            'expiration': data.expiration,
            'expires_at': expires_at
        }

        return {
            "success": True,
            "message": _("oss.presign_success"),
            "data": response_data,
            "timestamp": ""
        }

    except FileRecord.DoesNotExist:
        return {
            "success": False,
            "message": _("oss.file_not_found"),
            "data": None,
            "error_code": "FILE_NOT_FOUND",
            "timestamp": ""
        }
    except Exception as e:
        return _safe_error_response(
            e, _("oss.presign_generate_failed"),
            error_code="PRESIGNED_URL_FAILED",
            log_context="生成预签名URL失败",
        )


@router.post("/batch-upload", auth=jwt_auth, response=SuccessResponse, tags=["文件操作"])
def batch_upload_files_api(
    request: HttpRequest,
    files: List[NinjaUploadedFile] = File(...),
    folder: str = Form(""),
    tags: Optional[str] = Form(""),
    is_public: bool = Form(True),
    sync: bool = Form(False),
    module: str = Form(""),
    context_type: str = Form(""),
    context_id: str = Form(""),
    organization_id: str = Form(""),
):
    """
    [DEPRECATED] 批量上传文件（中转模式）。

    此接口已废弃，请迁移至直传模式：
        POST /presign-upload-batch → PUT 直传 OSS → POST /confirm-upload-batch
    Sunset: 2026-09-30

    - sync=True：适合少量文件（<=10个），立即上传并返回详细结果
    - sync=False：适合大量文件，创建异步任务，需要轮询查询进度
    """
    request_id = generate_request_id()
    user_id = _get_user_id(request)

    organization_id = _oss_resolve_organization(organization_id, request)
    policy_err = _check_organization_resource_write_policy(organization_id)
    if policy_err is not None:
        return _make_deprecated_json_response(policy_err)

    logger.warning(
        "[DEPRECATED] 中转批量上传 POST /batch-upload 被调用: user=%s, request_id=%s, "
        "文件数=%d, 请迁移至直传模式 (presign-upload-batch → PUT → confirm-upload-batch)",
        user_id, request_id, len(files) if files else 0,
    )
    if 'is_public' not in request.POST:
        _log_implicit_is_public_default(
            endpoint="POST /batch-upload",
            module=module,
            context_type=context_type,
            context_id=context_id,
            user_id=user_id,
        )

    ctx_err = _require_context_id(context_id, "batch_upload", user_id, request_id)
    if ctx_err is not None:
        return ctx_err

    try:
        logger.info(f"开始批量文件上传 - 请求ID: {request_id}, 用户: {user_id}, 文件数: {len(files)}, 模式: {'同步' if sync else '异步'}")

        if not files or len(files) == 0:
            raise ValidationException(_("oss.no_file_provided"))

        max_batch_size = getattr(settings, 'OSS_MAX_BATCH_SIZE', 50)
        if len(files) > max_batch_size:
            raise ValidationException(_("oss.batch_count_exceeded", count=len(files), max=max_batch_size))

        file_tags = tags.split(',') if tags else []
        folder_path = folder.strip('/') + '/' if folder.strip('/') else ''

        if sync:
            # 同步模式：立即上传所有文件
            from .services.factory import get_oss_service
            from ..common.utils import get_file_type_from_extension
            import hashlib

            oss_service = get_oss_service()
            results = []
            total_size = 0
            success_count = 0
            failed_count = 0

            if organization_id:
                total_incoming = sum(f.size for f in files)
                if total_incoming > 0:
                    try:
                        from apps.services.billing.services import OrganizationStorageBillingService
                        OrganizationStorageBillingService.assert_storage_upload_allowed(
                            organization_id=organization_id,
                            incoming_bytes=total_incoming,
                        )
                    except BillingBlockedError as blocked_exc:
                        return _make_deprecated_json_response(_billing_blocked_response())
                    except ValueError as quota_exc:
                        return _make_deprecated_json_response({
                            "success": False,
                            "message": str(quota_exc),
                            "data": None,
                            "error_code": "STORAGE_QUOTA_EXCEEDED",
                            "timestamp": "",
                        })

            for idx, file in enumerate(files):
                try:
                    # 检查文件大小
                    max_size = settings.OSS_MAX_FILE_SIZE  # 100MB
                    if file.size > max_size:
                        logger.warning(f"文件 {file.name} 大小超过限制: {file.size} > {max_size}")
                        failed_count += 1
                        results.append({
                            'file_name': file.name,
                            'success': False,
                            'message': _("oss.file_size_exceeded", size=file.size, max_size=max_size)
                        })
                        continue

                    # 获取文件信息
                    original_filename = file.name
                    file_extension = os.path.splitext(original_filename)[1].lower().lstrip('.')

                    # 生成文件键
                    file_key = f"{folder_path}{uuid.uuid4().hex}.{file_extension}"

                    # 计算文件哈希
                    file.seek(0)
                    file_content = file.read()
                    file_hash = hashlib.md5(file_content).hexdigest()
                    file.seek(0)

                    # 检测MIME类型
                    mime_type = detect_mime_from_buffer(
                        file_content,
                        file.content_type or 'application/octet-stream',
                    )

                    upload_result = oss_service.upload_file(
                        file,
                        file_key,
                        content_type=mime_type,
                        file_hash=file_hash,
                    )

                    if not upload_result['success']:
                        failed_count += 1
                        results.append({
                            'file_name': original_filename,
                            'success': False,
                            'message': upload_result['message'],
                        })
                        continue

                    file_record = FileRecord.objects.create(
                        file_name=original_filename,
                        file_key=file_key,
                        file_path=folder_path,
                        file_size=file.size,
                        file_type=get_file_type_from_extension(file_extension),
                        mime_type=mime_type,
                        file_extension=file_extension,
                        file_hash=file_hash,
                        bucket_name=oss_service.config.get('bucket_name'),
                        access_url=upload_result['data']['access_url'],
                        cdn_url=upload_result['data'].get('cdn_url', ''),
                        is_public=is_public,
                        upload_user=user_id,
                        upload_source='api_batch',
                        upload_ip=request.META.get('REMOTE_ADDR'),
                        tags=file_tags,
                        metadata={
                            'request_id': request_id,
                            'upload_method': 'batch_sync',
                            'batch_index': idx,
                            'module': module or 'other',
                            'context_type': context_type,
                            'context_id': context_id,
                        },
                    )

                    file_record.mark_as_completed(
                        access_url=upload_result['data']['access_url'],
                        cdn_url=upload_result['data'].get('cdn_url', ''),
                    )

                    effective_uid = str(user_id)
                    if module:
                        from .models import FileUsage
                        FileUsage.add_usage(
                            file_record=file_record,
                            user_id=effective_uid,
                            module=module,
                            context_type=context_type,
                            context_id=context_id,
                        )

                    if organization_id and file.size > 0:
                        try:
                            file_record.organization_id = organization_id
                            file_record.save(update_fields=["organization_id"])
                            from apps.services.billing.services import OrganizationStorageBillingService
                            OrganizationStorageBillingService.apply_storage_delta(
                                organization_id=organization_id,
                                file_id=str(file_record.id),
                                delta_bytes=int(file.size),
                                user_id=effective_uid,
                                biz_type="oss_batch_upload",
                                biz_id=str(file_record.id),
                            )
                        except Exception as billing_exc:
                            logger.warning("batch_upload 存储计量失败（不影响上传）: %s", billing_exc)
                            try:
                                from apps.services.billing.services.degradation_tracker import track_billing_degradation
                                track_billing_degradation(meter_key="storage.batch_upload", organization_id=organization_id, error=str(billing_exc))
                            except Exception:
                                pass

                    success_count += 1
                    total_size += file.size
                    results.append({
                        'file_name': original_filename,
                        'success': True,
                        'file_id': str(file_record.id),
                        'file_key': file_record.file_key,
                        'file_size': file_record.file_size,
                        'file_type': file_record.file_type,
                        'access_url': file_record.access_url,
                        'cdn_url': file_record.cdn_url,
                    })

                    logger.info(f"文件上传成功 ({idx+1}/{len(files)}): {original_filename}")

                except Exception as e:
                    logger.error("上传文件失败: %s, 错误: %s", file.name, e, exc_info=True)
                    failed_count += 1
                    results.append({
                        'file_name': file.name,
                        'success': False,
                        'message': _("oss.upload_failed"),
                    })

            logger.info(f"批量上传完成 - 请求ID: {request_id}, 成功: {success_count}, 失败: {failed_count}")

            return _make_deprecated_json_response({
                "success": True,
                "message": _("oss.batch_upload_complete", success_count=success_count, failed_count=failed_count),
                "data": {
                    'total_files': len(files),
                    'success_count': success_count,
                    'failed_count': failed_count,
                    'total_size': total_size,
                    'results': results,
                    'request_id': request_id
                },
                "timestamp": ""
            })

        else:
            # 异步模式：先同步上传到 OSS 暂存区，再由 Celery 任务移动到正式路径
            from .tasks import batch_process_staged_files

            oss_service = get_oss_service()
            staging_keys = []
            file_metas = []
            total_size = 0

            # P1-7: 配额前置 — 在 staging 上传之前检查，避免超额后 staging 文件泄漏
            if organization_id:
                max_size_limit = settings.OSS_MAX_FILE_SIZE
                pre_check_size = sum(f.size for f in files if f.size <= max_size_limit)
                if pre_check_size > 0:
                    try:
                        from apps.services.billing.services import OrganizationStorageBillingService
                        OrganizationStorageBillingService.assert_storage_upload_allowed(
                            organization_id=organization_id,
                            incoming_bytes=pre_check_size,
                        )
                    except BillingBlockedError:
                        return _make_deprecated_json_response(_billing_blocked_response())
                    except ValueError as quota_exc:
                        return _make_deprecated_json_response({
                            "success": False,
                            "message": str(quota_exc),
                            "data": None,
                            "error_code": "STORAGE_QUOTA_EXCEEDED",
                            "timestamp": "",
                        })

            for file in files:
                max_size = settings.OSS_MAX_FILE_SIZE  # 100MB
                if file.size > max_size:
                    logger.warning(f"文件 {file.name} 大小超过限制: {file.size} > {max_size}")
                    continue

                file_extension = os.path.splitext(file.name)[1].lower().lstrip('.')
                staging_key = f"_staging/{request_id}/{uuid.uuid4().hex}.{file_extension}"

                upload_result = oss_service.upload_file(
                    file, staging_key,
                    content_type=getattr(file, 'content_type', 'application/octet-stream'),
                )
                if not upload_result['success']:
                    logger.error(f"暂存上传失败: {file.name}, {upload_result['message']}")
                    continue

                staging_keys.append(staging_key)
                file_metas.append({
                    'original_name': file.name,
                    'file_size': file.size,
                    'content_type': getattr(file, 'content_type', 'application/octet-stream'),
                    'file_extension': file_extension,
                })
                total_size += file.size

            if not staging_keys:
                raise ValidationException(_("oss.no_valid_files"))

            task = batch_process_staged_files.apply_async(
                args=[staging_keys, file_metas, folder],
                kwargs={
                    'tags': file_tags,
                    'is_public': is_public,
                    'created_by': user_id or getattr(request.user, 'username', 'anonymous'),
                    'organization_id': organization_id,
                    'module': module,
                    'context_type': context_type,
                    'context_id': context_id,
                    'user_id': user_id,
                }
            )

            logger.info(f"批量上传任务已提交 - 请求ID: {request_id}, 任务ID: {task.id}")

            return _make_deprecated_json_response({
                "success": True,
                "message": _("oss.batch_upload_submitted", count=len(staging_keys)),
                "data": {
                    'celery_task_id': task.id,
                    'total_files': len(staging_keys),
                    'total_size': total_size,
                    'request_id': request_id
                },
                "timestamp": ""
            })

    except Exception as e:
        logger.error("批量文件上传失败 - 请求ID: %s, 错误: %s", request_id, e, exc_info=True)
        return _make_deprecated_json_response({
            "success": False,
            "message": _("oss.batch_upload_failed"),
            "data": None,
            "error_code": "BATCH_UPLOAD_FAILED",
            "timestamp": "",
        })


@router.post("/batch-upload-urls", auth=jwt_auth, response=SuccessResponse, tags=["文件操作"])
def batch_upload_from_urls(request: HttpRequest, data: BatchUploadRequest):
    """
    [DEPRECATED] 批量从 URL 上传文件（中转模式）。

    此接口已废弃，请迁移至直传模式：
        POST /presign-upload-batch → PUT 直传 OSS → POST /confirm-upload-batch
    Sunset: 2026-09-30

    Args:
        data: 批量上传请求数据（包含URL列表）

    说明：
        - ≤20 个 URL：使用同步模式，在一个 Celery 任务内完成所有上传，返回详细结果
        - >20 个 URL：使用异步模式，创建多个子任务，需要通过 task_id 查询进度
    """
    request_id = generate_request_id()
    user_id = _get_user_id(request)

    resolved_organization_id = _oss_resolve_organization(data.organization_id or '', request)
    policy_err = _check_organization_resource_write_policy(resolved_organization_id)
    if policy_err is not None:
        return _make_deprecated_json_response(policy_err)

    logger.warning(
        "[DEPRECATED] 中转批量URL上传 POST /batch-upload-urls 被调用: user=%s, request_id=%s, "
        "URL数=%d, 请迁移至直传模式",
        user_id, request_id, len(data.urls) if data.urls else 0,
    )

    ctx_err = _require_context_id(data.context_id or '', "batch_upload_from_urls", user_id, request_id)
    if ctx_err is not None:
        return ctx_err

    try:
        logger.info(f"开始从URL批量上传 - 请求ID: {request_id}")

        urls = data.urls or []
        if not urls:
            raise ValidationException(_("oss.no_urls_provided"))

        # 检查URL数量限制
        max_batch_size = getattr(settings, 'OSS_MAX_BATCH_SIZE', 50)
        if len(urls) > max_batch_size:
            raise ValidationException(_("oss.batch_url_count_exceeded", count=len(urls), max=max_batch_size))

        ws_id = resolved_organization_id
        if ws_id:
            try:
                from apps.services.billing.services import OrganizationStorageBillingService
                OrganizationStorageBillingService.assert_storage_upload_allowed(
                    organization_id=ws_id,
                    incoming_bytes=0,
                )
            except BillingBlockedError:
                return _make_deprecated_json_response(_billing_blocked_response())
            except ValueError as quota_exc:
                return _make_deprecated_json_response({
                    "success": False,
                    "message": str(quota_exc),
                    "data": None,
                    "error_code": "STORAGE_QUOTA_EXCEEDED",
                    "timestamp": "",
                })
            except Exception as exc:
                logger.warning("batch_upload_from_urls 存储预检异常（Celery 任务将逐文件重检）: %s", exc)

        from .tasks import batch_download_and_upload_from_urls

        sync_mode = len(urls) <= 20

        task = batch_download_and_upload_from_urls.apply_async(
            args=[urls],
            kwargs={
                'folder': data.folder,
                'tags': data.tags,
                'is_public': data.is_public,
                'created_by': user_id or getattr(request.user, 'username', 'anonymous'),
                'sync_mode': sync_mode,
                'organization_id': resolved_organization_id,
                'module': data.module or '',
                'context_type': data.context_type or '',
                'context_id': data.context_id or '',
                'user_id': user_id or '',
            }
        )

        logger.info(f"批量URL上传任务已提交 - 请求ID: {request_id}, 任务ID: {task.id}, 模式: {'同步' if sync_mode else '异步'}")

        return _make_deprecated_json_response({
            "success": True,
            "message": _("oss.batch_url_submitted", count=len(urls)),
            "data": {
                'celery_task_id': task.id,
                'total_urls': len(urls),
                'sync_mode': sync_mode,
                'request_id': request_id,
                'tips': 'sync mode: results available after task completion' if sync_mode else 'async mode: poll /api/services/oss/tasks/{task_id} for progress'
            },
            "timestamp": ""
        })

    except Exception as e:
        logger.error("批量URL上传失败 - 请求ID: %s, 错误: %s", request_id, e, exc_info=True)
        return _make_deprecated_json_response({
            "success": False,
            "message": _("oss.batch_url_failed"),
            "data": None,
            "error_code": "BATCH_URL_UPLOAD_FAILED",
            "timestamp": "",
        })


@router.get("/tasks", auth=jwt_auth, response=SuccessResponse, tags=["任务管理"])
def list_upload_tasks(
    request: HttpRequest,
    task_type: Optional[str] = None,
    status: Optional[str] = None,
    page: int = 1,
    page_size: int = 20
):
    """
    获取上传任务列表

    Args:
        task_type: 任务类型过滤
        status: 状态过滤
        page: 页码
        page_size: 每页数量
    """
    try:
        user_id = _get_user_id(request)
        queryset = UploadTask.objects.filter(created_by=user_id)

        if task_type:
            queryset = queryset.filter(task_type=task_type)

        if status:
            queryset = queryset.filter(status=status)

        queryset = queryset.order_by('-created_at')[:1000]

        # 分页
        total = queryset.count()
        start = (page - 1) * page_size
        end = start + page_size
        tasks = queryset[start:end]

        # 构建响应数据
        task_list = []
        for task in tasks:
            task_list.append({
                'task_id': str(task.id),
                'task_name': task.task_name,
                'task_type': task.task_type,
                'status': task.status,
                'progress': task.progress,
                'total_files': task.total_files,
                'completed_files': task.completed_files,
                'failed_files': task.failed_files,
                'total_size': task.total_size,
                'uploaded_size': task.uploaded_size,
                'error_message': task.error_message,
                'result_data': task.result_data,
                'created_by': task.created_by,
                'created_at': task.created_at,
                'updated_at': task.updated_at,
                'started_at': task.started_at,
                'completed_at': task.completed_at
            })

        response_data = {
            'tasks': task_list,
            'total': total,
            'page': page,
            'page_size': page_size,
            'total_pages': (total + page_size - 1) // page_size
        }

        return {
            "success": True,
            "message": _("oss.task_list_success", total=total),
            "data": response_data,
            "timestamp": ""
        }

    except Exception as e:
        return _safe_error_response(
            e, _("oss.task_list_failed"),
            error_code="LIST_TASKS_FAILED",
            log_context="获取任务列表失败",
        )


@router.get("/tasks/{task_id}", auth=jwt_auth, response=SuccessResponse, tags=["任务管理"])
def get_upload_task_info(request: HttpRequest, task_id: str):
    """
    获取上传任务详情

    Args:
        task_id: 任务ID
    """
    try:
        task = UploadTask.objects.get(id=task_id)

        user_id = _get_user_id(request)
        if task.created_by != user_id:
            return {
                "success": False,
                "message": "无权查看该任务",
                "data": None,
                "error_code": "TASK_ACCESS_DENIED",
                "timestamp": "",
            }

        files = task.files.all()[:100]
        file_list = []
        for file_record in files:
            file_list.append({
                'file_id': str(file_record.id),
                'file_name': file_record.file_name,
                'file_key': file_record.file_key,
                'file_size': file_record.file_size,
                'file_type': file_record.file_type,
                'access_url': file_record.access_url,
                'cdn_url': file_record.cdn_url,
                'status': file_record.status,
                'created_at': file_record.created_at
            })

        response_data = {
            'task_id': str(task.id),
            'task_name': task.task_name,
            'task_type': task.task_type,
            'status': task.status,
            'progress': task.progress,
            'total_files': task.total_files,
            'completed_files': task.completed_files,
            'failed_files': task.failed_files,
            'total_size': task.total_size,
            'uploaded_size': task.uploaded_size,
            'error_message': task.error_message,
            'result_data': task.result_data,
            'created_by': task.created_by,
            'created_at': task.created_at,
            'updated_at': task.updated_at,
            'started_at': task.started_at,
            'completed_at': task.completed_at,
            'files': file_list,
            'file_count': len(file_list)
        }

        return {
            "success": True,
            "message": _("oss.task_info_success"),
            "data": response_data,
            "timestamp": ""
        }

    except UploadTask.DoesNotExist:
        return {
            "success": False,
            "message": _("oss.task_not_found"),
            "data": None,
            "error_code": "TASK_NOT_FOUND",
            "timestamp": ""
        }
    except Exception as e:
        return _safe_error_response(
            e, _("oss.task_info_failed"),
            error_code="GET_TASK_INFO_FAILED",
            log_context="获取任务信息失败",
        )


@router.delete("/tasks/{task_id}", auth=jwt_auth, response=SuccessResponse, tags=["任务管理"])
def cancel_upload_task(request: HttpRequest, task_id: str):
    """
    取消上传任务

    Args:
        task_id: 任务ID
    """
    try:
        task = UploadTask.objects.get(id=task_id)

        user_id = _get_user_id(request)
        if task.created_by != user_id:
            return {
                "success": False,
                "message": "无权取消该任务",
                "data": None,
                "error_code": "TASK_ACCESS_DENIED",
                "timestamp": "",
            }

        if task.status in ['completed', 'failed', 'cancelled']:
            return {
                "success": False,
                "message": _("oss.task_cannot_cancel"),
                "error_code": "TASK_CANNOT_CANCEL",
                "timestamp": ""
            }

        task.mark_as_cancelled()

        return {
            "success": True,
            "message": _("oss.task_cancelled"),
            "data": {"task_id": task_id},
            "timestamp": ""
        }

    except UploadTask.DoesNotExist:
        return {
            "success": False,
            "message": _("oss.task_not_found"),
            "data": None,
            "error_code": "TASK_NOT_FOUND",
            "timestamp": ""
        }
    except Exception as e:
        return _safe_error_response(
            e, _("oss.task_cancel_failed"),
            error_code="CANCEL_TASK_FAILED",
            log_context="取消任务失败",
        )


@router.get("/bucket/info", auth=jwt_auth, response=SuccessResponse, tags=["存储桶管理"])
def get_bucket_info(request: HttpRequest):
    """获取存储桶信息"""
    try:
        oss_service = get_oss_service()
        bucket_result = oss_service.get_bucket_info()

        if bucket_result['success']:
            # 获取文件统计
            total_files = FileRecord.objects.filter(status='completed').count()
            total_size = FileRecord.objects.filter(status='completed').aggregate(
                total=models.Sum('file_size')
            )['total'] or 0

            bucket_data = bucket_result['data']
            bucket_data.update({
                'total_files': total_files,
                'total_size': total_size,
                'created_at': bucket_data.get('creation_date')
            })

            return {
                "success": True,
                "message": _("oss.bucket_info_success"),
                "data": bucket_data,
                "timestamp": ""
            }
        else:
            logger.warning("获取存储桶信息失败: %s", bucket_result['message'])
            return {
                "success": False,
                "message": _("oss.bucket_info_failed"),
                "error_code": "BUCKET_INFO_FAILED",
                "timestamp": ""
            }

    except Exception as e:
        return _safe_error_response(
            e, _("oss.bucket_info_failed"),
            error_code="BUCKET_INFO_FAILED",
            log_context="获取存储桶信息失败",
        )


# ===================================================================
# 直传模式接口 — 前端获取签名后直接上传到 OSS，不经过 Django 中转
# ===================================================================

from .schemas import (
    PresignUploadRequest,
    PresignUploadBatchRequest,
    ConfirmUploadRequest,
    ConfirmUploadBatchRequest,
)


_SAFE_OBJECT_KEY_EXTENSION_RE = re.compile(r'^[a-z0-9][a-z0-9._-]*$')
# 与 FileRecord.file_extension(max_length=10) 对齐；更长后缀只保留在元数据。
_MAX_OBJECT_KEY_EXTENSION_LENGTH = 10


def _is_space_tabfiles_upload(module: str | None, context_type: str | None) -> bool:
    """识别云盘裸文件直传通道，不让相似字符串获得宽松策略。

    ：ContextItem 归属改为 organization-only，``context_type`` 的主值改为
    ``'organization'``；``'space'`` 是过渡期兼容值（旧版 Electron / CLI 调用方
    仍传它），待这些调用方切换完成后删除。函数名沿用历史命名，避免无谓改动
    调用方引用面。
    """
    return module == 'tabfiles' and context_type in ('organization', 'space')


def _validate_upload_scope(
    *,
    module: str | None,
    context_type: str | None,
    is_public: bool | None,
) -> bool:
    """校验直传作用域，返回是否启用私有云盘普通文件策略。"""
    is_space_tabfiles = _is_space_tabfiles_upload(module, context_type)
    return is_space_tabfiles


def _object_key_extension(filename: str) -> tuple[str, str]:
    """返回原始规范化扩展名和可安全用于随机对象键的后缀。"""
    declared_extension = os.path.splitext(os.path.basename(filename))[1].lower().lstrip('.')
    if (
        declared_extension
        and len(declared_extension) <= _MAX_OBJECT_KEY_EXTENSION_LENGTH
        and _SAFE_OBJECT_KEY_EXTENSION_RE.fullmatch(declared_extension)
    ):
        return declared_extension, declared_extension
    return declared_extension, 'bin'


def _validate_upload_params(
    filename: str,
    file_size: int,
    content_type: str | None = None,
    *,
    module: str | None = None,
    context_type: str | None = None,
    is_public: bool | None = None,
) -> str:
    """校验上传参数，返回 file_extension。

    当同时传入 content_type 和 filename 时，额外校验 MIME 与扩展名的一致性，
    防止客户端声明 content_type=image/png 但文件名为 .exe 等伪装攻击。
    """
    if not filename or not filename.strip():
        raise ValidationException(_("oss.filename_empty"))
    if (
        '/' in filename
        or '\\' in filename
        or '\0' in filename
        or filename == '..'
        or '../' in filename
        or '..\\' in filename
    ):
        raise ValidationException(_("oss.filename_invalid_chars"))
    if len(filename) > 255:
        raise ValidationException(_("oss.filename_too_long"))

    allow_arbitrary_file_type = _validate_upload_scope(
        module=module,
        context_type=context_type,
        is_public=is_public,
    )
    declared_extension, object_key_extension = _object_key_extension(filename)

    allowed_extensions = getattr(settings, 'OSS_ALLOWED_EXTENSIONS', [])
    if (
        not allow_arbitrary_file_type
        and allowed_extensions
        and declared_extension not in allowed_extensions
    ):
        raise ValidationException(_("oss.file_type_unsupported", ext=declared_extension or ''))

    if file_size < 0:
        raise ValidationException(_("oss.filesize_negative"))
    max_size = settings.OSS_MAX_FILE_SIZE
    if file_size > max_size:
        raise ValidationException(_("oss.file_size_exceeded", size=file_size, max_size=max_size))

    if content_type:
        if '/' not in content_type:
            raise ValidationException(_("oss.content_type_invalid", content_type=content_type))
        if not allow_arbitrary_file_type and _is_dangerous_mime(content_type):
            raise ValidationException(
                f"不允许上传危险类型文件: {content_type}"
            )
        if not allow_arbitrary_file_type and content_type != 'application/octet-stream':
            mime_map = getattr(settings, 'OSS_MIME_TO_EXTENSIONS', {})
            valid_exts = mime_map.get(content_type)
            if declared_extension and valid_exts and declared_extension not in valid_exts:
                raise ValidationException(
                    _("oss.mime_extension_mismatch", content_type=content_type, ext=declared_extension)
                )

    return object_key_extension


def _validate_confirmed_file_size(actual_size: object) -> int:
    """对 OSS HEAD 返回的权威大小重复执行直传体积边界。"""
    if isinstance(actual_size, bool):
        raise ValidationException(_("oss.filesize_negative"))
    try:
        normalized_size = int(actual_size)
    except (TypeError, ValueError):
        raise ValidationException(_("oss.filesize_negative"))
    if normalized_size < 0:
        raise ValidationException(_("oss.filesize_negative"))
    max_size = settings.OSS_MAX_FILE_SIZE
    if normalized_size > max_size:
        raise ValidationException(
            _("oss.file_size_exceeded", size=normalized_size, max_size=max_size)
        )
    return normalized_size


_FOLDER_PATTERN = re.compile(r'^[a-zA-Z0-9_\-]+(/[a-zA-Z0-9_\-]+)*$')


def _validate_folder(folder: str) -> None:
    """XC-23: 校验 folder 参数，防止路径穿越和覆写其他模块数据。"""
    if not folder:
        return
    folder = folder.strip('/')
    if not folder:
        return
    if '..' in folder or '\\' in folder or '\0' in folder or '//' in folder:
        raise ValidationException("folder 包含非法路径字符")
    if not _FOLDER_PATTERN.match(folder):
        raise ValidationException(
            "folder 仅允许字母、数字、-、_（用 / 分隔层级）"
        )


_OBJECT_KEY_PATTERN = re.compile(r'^[a-zA-Z0-9._\-/]+$')
_ALLOWED_KEY_PREFIXES = ('tabsite/', '_staging/', 'package_registry/')
_TABSITE_SITE_KEY_RE = re.compile(r'^tabsite/sites/([^/]+)/')
_STAGING_USER_KEY_RE = re.compile(r'^_staging/([^/]+)/')
_PACKAGE_REGISTRY_KEY_RE = re.compile(r'^package_registry/([^/]+)/')


def _validate_object_key(key: str) -> None:
    """校验自定义 object_key，防止路径穿越和覆写其他模块数据。"""
    if not key or not key.strip():
        raise ValidationException(_("oss.filename_empty"))
    if len(key) > 1024:
        raise ValidationException("object_key 过长（最大 1024 字符）")
    if '..' in key or key.startswith('/') or '\\' in key or '\0' in key or '//' in key:
        raise ValidationException(_("oss.filename_invalid_chars"))
    if not _OBJECT_KEY_PATTERN.match(key):
        raise ValidationException("object_key 包含非法字符（仅允许字母、数字、.、_、-、/）")
    if not key.startswith(_ALLOWED_KEY_PREFIXES):
        raise ValidationException(
            f"object_key 必须以 {' 或 '.join(_ALLOWED_KEY_PREFIXES)} 开头"
        )


def _validate_tabsite_key_ownership(object_key: str, user_id: str) -> None:
    """DU-001: 校验 tabsite/sites/{siteId}/ 路径中 siteId 归属当前用户。

    仅当 object_key 匹配 tabsite/sites/{siteId}/ 格式时进行归属校验；
    其他 tabsite/ 子路径或 _staging/ 前缀不受影响。
    """
    match = _TABSITE_SITE_KEY_RE.match(object_key)
    if not match:
        return

    if not user_id:
        raise ValidationException("无法校验站点文件归属：用户未认证")

    site_id = match.group(1)
    try:
        from apps.tabsite.models import Site
    except ImportError:
        logger.error("_validate_tabsite_key_ownership: 无法导入 Site 模型")
        raise ValidationException("服务端配置异常，无法校验站点归属")

    site = Site.objects.filter(id=site_id).first()
    if site is None:
        raise ValidationException(f"object_key 引用的站点不存在")

    if str(site.created_by_id) == user_id:
        return
    if site.owner_id and str(site.owner_id) == user_id:
        return

    logger.warning(
        "presign-upload siteId 归属校验失败: site_id=%s, user=%s, owner=%s, created_by=%s",
        site_id, user_id, site.owner_id, site.created_by_id,
    )
    raise ValidationException("无权操作该站点的 OSS 文件")


def _validate_staging_key_ownership(object_key: str, user_id: str) -> None:
    """3.3: 校验 _staging/{user_id}/ 路径归属当前用户，防止覆盖他人暂存文件。

    仅当 object_key 以 _staging/ 开头时进行校验；
    服务端批量上传（直接调用 oss_service.upload_file）不经过此函数。
    """
    match = _STAGING_USER_KEY_RE.match(object_key)
    if not match:
        return

    if not user_id:
        raise ValidationException("无法校验暂存文件归属：用户未认证")

    key_user_id = match.group(1)
    if key_user_id != user_id:
        logger.warning(
            "presign-upload _staging 路径归属校验失败: object_key=%s, key_user=%s, request_user=%s",
            object_key, key_user_id, user_id,
        )
        raise ValidationException("无权操作其他用户的暂存文件")


def _validate_package_registry_key_ownership(object_key: str, user_id: str) -> None:
    """校验 package_registry/{package_id}/ 路径中 package_id 归属当前用户的 organization。

    仅当 object_key 匹配 package_registry/{package_id}/ 格式时进行归属校验。
    """
    match = _PACKAGE_REGISTRY_KEY_RE.match(object_key)
    if not match:
        return

    if not user_id:
        raise ValidationException("无法校验包文件归属：用户未认证")

    package_id = match.group(1)
    try:
        from apps.services.package_registry.models import Package
    except ImportError:
        logger.error("_validate_package_registry_key_ownership: 无法导入 Package 模型")
        raise ValidationException("服务端配置异常，无法校验包归属")

    package = Package.objects.filter(id=package_id).first()
    if package is None:
        raise ValidationException("object_key 引用的包不存在")

    try:
        from apps.tabtinspace.models import OrganizationMember
    except ImportError:
        logger.error("_validate_package_registry_key_ownership: 无法导入 OrganizationMember 模型")
        raise ValidationException("服务端配置异常，无法校验包归属")

    if not OrganizationMember.objects.filter(
        organization_id=package.organization_id,
        user_id=user_id,
        role__in=["owner", "admin", "editor"],
    ).exists():
        logger.warning(
            "presign-upload package_registry 归属校验失败: package_id=%s, organization=%s, user=%s",
            package_id, package.organization_id, user_id,
        )
        raise ValidationException("无权操作该包的 OSS 文件")


def _calculate_presign_expiration(file_size: int) -> int:
    """根据文件大小动态计算 presign URL 有效期（秒）。

    基础 300 秒，每 10MB 增加 60 秒，上限 3600 秒（1 小时）。
    解决大文件弱网场景下 presign URL 过期导致 403 的问题。
    """
    base = 300
    extra = (file_size // (10 * 1024 * 1024)) * 60
    return min(base + extra, 3600)


def _generate_presign_item(
    oss_service,
    filename: str,
    folder: str,
    content_type: str | None,
    file_size: int,
    expiration: int = 0,
    object_key_override: str | None = None,
    user_id: str = '',
    module: str | None = None,
    context_type: str | None = None,
    is_public: bool | None = None,
) -> dict:
    """为单个文件生成预签名上传信息。"""
    file_extension = _validate_upload_params(
        filename,
        file_size,
        content_type,
        module=module,
        context_type=context_type,
        is_public=is_public,
    )

    if expiration <= 0:
        expiration = _calculate_presign_expiration(file_size)

    if object_key_override:
        _validate_object_key(object_key_override)
        _validate_tabsite_key_ownership(object_key_override, user_id)
        _validate_staging_key_ownership(object_key_override, user_id)
        _validate_package_registry_key_ownership(object_key_override, user_id)
        object_key = object_key_override
    else:
        _validate_folder(folder)
        folder = folder.strip('/') + '/' if folder.strip('/') else ''
        object_key = f"{folder}{uuid.uuid4().hex}.{file_extension}"

    ct = content_type or 'application/octet-stream'
    presigned_url = oss_service.generate_presigned_url(
        object_key, expiration=expiration, method='PUT', content_type=ct,
    )
    access_url = oss_service.build_access_url(object_key)
    cdn_url = oss_service.build_cdn_url(object_key)

    return {
        'object_key': object_key,
        'presigned_url': presigned_url,
        'access_url': access_url,
        'cdn_url': cdn_url,
        'content_type': ct,
        'expires_in': expiration,
    }


@router.post("/presign-upload", auth=jwt_auth, response=SuccessResponse, tags=["直传模式"])
def presign_upload(request: HttpRequest, data: PresignUploadRequest):
    """
    获取单文件直传签名 URL。

    如果前端传了 file_hash 且后端已存在相同 hash 的已完成文件，
    直接返回秒传结果（instant=true），无需实际上传。
    否则返回 presigned PUT URL 供前端直传。
    """
    user_id = _get_user_id(request)
    organization_id = _oss_resolve_organization(data.organization_id or '', request)

    policy_err = _check_organization_resource_write_policy(organization_id)
    if policy_err is not None:
        return policy_err

    perm_err = _check_upload_permission(request, organization_id)
    if perm_err is not None:
        return perm_err
    policy_err = _check_organization_resource_write_policy(organization_id)
    if policy_err is not None:
        return policy_err

    try:
        if not _model_field_was_set(data, "is_public"):
            _log_implicit_is_public_default(
                endpoint="POST /presign-upload",
                module=data.module or "other",
                context_type=data.context_type or "",
                context_id=data.context_id or "",
                user_id=str(user_id),
            )
        try:
            _assert_tabdoc_html_upload_private(
                module=data.module,
                folder=data.folder,
                object_key=data.object_key,
                requested_is_public=bool(data.is_public),
            )
        except ValidationException as exc:
            return {
                "success": False,
                "message": str(exc),
                "data": None,
                "error_code": "TABDOC_HTML_PUBLIC_UPLOAD_FORBIDDEN",
                "timestamp": "",
            }
        effective_is_public = _effective_is_public_for_module(data.module or '', data.is_public)
        if _is_tabdoc_html_upload(
            module=data.module,
            folder=data.folder,
            object_key=data.object_key,
        ):
            effective_is_public = False
        _validate_upload_params(
            data.filename,
            data.file_size,
            data.content_type,
            module=data.module,
            context_type=data.context_type,
            is_public=effective_is_public,
        )

        quota_decision = None
        if organization_id and data.file_size > 0:
            try:
                from .services.storage_reservation import assert_storage_with_reservation
                quota_decision = assert_storage_with_reservation(
                    organization_id=organization_id,
                    incoming_bytes=data.file_size,
                )
            except BillingBlockedError as blocked_exc:
                return _billing_blocked_response()
            except ValueError as quota_exc:
                return {
                    "success": False,
                    "message": str(quota_exc),
                    "data": None,
                    "error_code": "STORAGE_QUOTA_EXCEEDED",
                    "timestamp": "",
                }

        # 秒传检查：如果提供了 file_hash，查找已有文件
        if data.file_hash:
            req_algo = data.hash_algorithm or ''
            # 安全（P0 IDOR / 数据泄漏）：秒传必须按 organization 隔离，否则跨 organization 拿到别人 FileRecord
            # 构成越权 — 直接拿到 file_id 后可走 /files/{id} / /download/{id} / /presigned-url 链路
            # 拉取对方文件数据，同时把别人 organization 的存储计费按自己 hit 的方式叠加。
            # 详见 apps/services/oss/PRD-presign-organization-isolation-fix.md。
            # organization_id 为空时直接跳过秒传，避免错误匹配历史无 organization 记录。
            existing = None
            if organization_id:
                existing = FileRecord.objects.filter(
                    file_hash=data.file_hash,
                    organization_id=organization_id,
                    status='completed',
                ).first()

            if (
                existing
                and _is_hash_algorithm_compatible(existing.hash_algorithm, req_algo)
                and _is_instant_hit_compatible_with_upload_scope(
                    existing,
                    module=data.module,
                    context_type=data.context_type,
                    is_public=effective_is_public,
                    folder=data.folder,
                    object_key=data.object_key or getattr(existing, "file_key", None),
                )
            ):
                from django.db import transaction as db_transaction
                from .models import FileUsage
                if not user_id:
                    logger.error(
                        "presign_upload: user_id 为空，跳过秒传 FileUsage 创建 (CROSS-1): hash=%s",
                        data.file_hash,
                    )
                else:
                    with db_transaction.atomic():
                        FileUsage.add_usage(
                            file_record=existing,
                            user_id=str(user_id),
                            module=data.module or 'other',
                            context_type=data.context_type or 'presign_dedup',
                            context_id=data.context_id or str(existing.id),
                        )

                if organization_id and existing.file_size and existing.file_size > 0:
                    try:
                        from apps.services.billing.services import OrganizationStorageBillingService
                        OrganizationStorageBillingService.apply_storage_delta(
                            organization_id=organization_id,
                            file_id=str(existing.id),
                            delta_bytes=int(existing.file_size),
                            user_id=str(user_id or ""),
                            biz_type="oss_instant_upload",
                            biz_id=f"{existing.id}_{data.context_id or 'dedup'}",
                        )
                    except Exception as billing_exc:
                        logger.warning("秒传命中存储计量失败（不影响秒传）: %s", billing_exc)

                logger.info(f"秒传命中: file_hash={data.file_hash}, file_id={existing.id}")
                instant_data = {
                    'instant': True,
                    **existing.to_response_dict(),
                }
                if not existing.is_public:
                    accessible = resolve_authorized_file(existing, expiration=3600)
                    instant_data.update({
                        'access_url': accessible.url,
                        'cdn_url': '',
                        'resolved_url': accessible.url,
                        'access_mode': accessible.access_mode,
                        'expires_in': accessible.expires_in,
                        'expires_at': accessible.expires_at,
                    })
                quota_warning = _compute_quota_warning(quota_decision)
                if quota_warning:
                    instant_data['quota_warning'] = quota_warning
                return {
                    "success": True,
                    "message": _("oss.instant_upload_success"),
                    "data": instant_data,
                    "timestamp": "",
                }

        oss_service = get_oss_service()
        item = _generate_presign_item(
            oss_service,
            filename=data.filename,
            folder=data.folder or '',
            content_type=data.content_type,
            file_size=data.file_size,
            object_key_override=data.object_key,
            user_id=str(user_id),
            module=data.module,
            context_type=data.context_type,
            is_public=effective_is_public,
        )
        item['instant'] = False
        item['is_public'] = effective_is_public

        _cache_presign_token(
            item['object_key'],
            str(user_id),
            item['expires_in'],
            reserved_bytes=data.file_size,
            module=data.module or 'other',
            context_type=data.context_type or '',
            context_id=data.context_id or '',
            organization_id=organization_id,
            is_public=effective_is_public,
        )

        quota_warning = _compute_quota_warning(quota_decision)
        if quota_warning:
            item['quota_warning'] = quota_warning

        return {
            "success": True,
            "message": _("oss.presign_upload_success"),
            "data": item,
            "timestamp": "",
        }

    except ValidationException as e:
        return {
            "success": False,
            "message": str(e),
            "data": None,
            "error_code": "VALIDATION_ERROR",
            "timestamp": "",
        }
    except Exception as e:
        safe_detail = _safe_presign_failure_detail(e)
        return _safe_error_response(
            e, _("oss.presign_upload_failed", detail=safe_detail),
            error_code="PRESIGN_FAILED",
            log_context="生成上传签名失败",
            detail=safe_detail,
        )


@router.post("/presign-upload-batch", auth=jwt_auth, response=SuccessResponse, tags=["直传模式"])
def presign_upload_batch(request: HttpRequest, data: PresignUploadBatchRequest):
    """批量获取直传签名 URL。"""
    organization_id = _oss_resolve_organization(data.organization_id or '', request)

    policy_err = _check_organization_resource_write_policy(organization_id)
    if policy_err is not None:
        return policy_err

    perm_err = _check_upload_permission(request, organization_id)
    if perm_err is not None:
        return perm_err

    try:
        batch_quota_decision = None
        if organization_id:
            total_incoming = sum(f.file_size for f in data.files if f.file_size > 0)
            if total_incoming > 0:
                try:
                    from .services.storage_reservation import assert_storage_with_reservation
                    batch_quota_decision = assert_storage_with_reservation(
                        organization_id=organization_id,
                        incoming_bytes=total_incoming,
                    )
                except BillingBlockedError as blocked_exc:
                    return _billing_blocked_response()
                except ValueError as quota_exc:
                    return {
                        "success": False,
                        "message": str(quota_exc),
                        "data": None,
                        "error_code": "STORAGE_QUOTA_EXCEEDED",
                        "timestamp": "",
                    }
                except Exception as quota_exc:
                    logger.error("presign_upload_batch 配额检查系统异常: organization=%s, err=%s", organization_id, quota_exc)
                    return {
                        "success": False,
                        "message": _("oss.storage_check_failed"),
                        "data": None,
                        "error_code": "STORAGE_CHECK_ERROR",
                        "timestamp": "",
                    }

        oss_service = get_oss_service()
        folder = data.folder or ''
        items = []
        errors = []
        batch_user_id = _get_user_id(request)

        for idx, f in enumerate(data.files):
            try:
                if not _model_field_was_set(f, "is_public"):
                    _log_implicit_is_public_default(
                        endpoint="POST /presign-upload-batch",
                        module=getattr(f, 'module', None) or "other",
                        context_type=getattr(f, 'context_type', None) or "",
                        context_id=getattr(f, 'context_id', None) or "",
                        user_id=str(batch_user_id),
                    )
                effective_is_public = _effective_is_public_for_module(
                    getattr(f, 'module', None) or '',
                    getattr(f, 'is_public', False),
                )
                _validate_upload_params(
                    f.filename,
                    f.file_size,
                    f.content_type,
                    module=f.module,
                    context_type=f.context_type,
                    is_public=effective_is_public,
                )
                file_hash = getattr(f, 'file_hash', None) or ''
                req_algo = getattr(f, 'hash_algorithm', None) or ''
                if file_hash:
                    # 安全（P0 IDOR / 数据泄漏）：同 presign_upload，秒传必须按 organization 隔离。
                    # 见 apps/services/oss/PRD-presign-organization-isolation-fix.md。
                    existing = None
                    if organization_id:
                        existing = FileRecord.objects.filter(
                            file_hash=file_hash,
                            organization_id=organization_id,
                            status='completed',
                        ).first()
                    if (
                        existing
                        and _is_hash_algorithm_compatible(existing.hash_algorithm, req_algo)
                        and _is_instant_hit_compatible_with_upload_scope(
                            existing,
                            module=f.module,
                            context_type=f.context_type,
                            is_public=effective_is_public,
                            folder=f.folder,
                            object_key=getattr(f, "object_key", None) or getattr(existing, "file_key", None),
                        )
                    ):
                        from .models import FileUsage
                        if not batch_user_id:
                            logger.error(
                                "presign_upload_batch: batch_user_id 为空，跳过秒传 FileUsage 创建 (CROSS-1): file=%s",
                                f.filename,
                            )
                            if organization_id and existing.file_size and existing.file_size > 0:
                                try:
                                    from apps.services.billing.services import OrganizationStorageBillingService
                                    OrganizationStorageBillingService.apply_storage_delta(
                                        organization_id=organization_id,
                                        file_id=str(existing.id),
                                        delta_bytes=int(existing.file_size),
                                        user_id=str(batch_user_id or ""),
                                        biz_type="oss_instant_upload_batch",
                                        biz_id=f"{existing.id}_{getattr(f, 'context_id', '') or 'dedup_batch'}",
                                    )
                                except Exception as billing_exc:
                                    logger.warning("批量秒传存储计量失败: %s", billing_exc)
                            items.append({
                                'filename': f.filename,
                                'instant': True,
                                **existing.to_response_dict(),
                            })
                            continue
                        FileUsage.add_usage(
                            file_record=existing,
                            user_id=str(batch_user_id),
                            module=getattr(f, 'module', None) or 'other',
                            context_type=getattr(f, 'context_type', None) or 'presign_batch_dedup',
                            context_id=getattr(f, 'context_id', None) or str(existing.id),
                        )
                        if organization_id and existing.file_size and existing.file_size > 0:
                            try:
                                from apps.services.billing.services import OrganizationStorageBillingService
                                OrganizationStorageBillingService.apply_storage_delta(
                                    organization_id=organization_id,
                                    file_id=str(existing.id),
                                    delta_bytes=int(existing.file_size),
                                    user_id=str(batch_user_id or ""),
                                    biz_type="oss_instant_upload_batch",
                                    biz_id=f"{existing.id}_{getattr(f, 'context_id', '') or 'dedup_batch'}",
                                )
                            except Exception as billing_exc:
                                logger.warning("批量秒传存储计量失败: %s", billing_exc)
                        item = {
                            'filename': f.filename,
                            'instant': True,
                            **existing.to_response_dict(),
                        }
                        items.append(item)
                        continue

                item = _generate_presign_item(
                    oss_service,
                    filename=f.filename,
                    folder=folder,
                    content_type=f.content_type,
                    file_size=f.file_size,
                    user_id=str(batch_user_id),
                    module=f.module,
                    context_type=f.context_type,
                    is_public=effective_is_public,
                )
                item['filename'] = f.filename
                item['instant'] = False
                item['is_public'] = effective_is_public
                _cache_presign_token(
                    item['object_key'],
                    str(batch_user_id),
                    item['expires_in'],
                    reserved_bytes=f.file_size,
                    module=f.module or 'other',
                    context_type=f.context_type or '',
                    context_id=f.context_id or '',
                    organization_id=organization_id,
                    is_public=effective_is_public,
                )
                items.append(item)
            except ValidationException as e:
                errors.append({'index': idx, 'filename': f.filename, 'error': str(e)})

        batch_response_data = {'items': items, 'errors': errors, 'organization_id': organization_id}
        batch_quota_warning = _compute_quota_warning(batch_quota_decision)
        if batch_quota_warning:
            batch_response_data['quota_warning'] = batch_quota_warning

        return {
            "success": True,
            "message": _("oss.presign_batch_complete", success_count=len(items), failed_count=len(errors)),
            "data": batch_response_data,
            "timestamp": "",
        }

    except Exception as e:
        return _safe_error_response(
            e, _("oss.presign_batch_failed"),
            error_code="PRESIGN_BATCH_FAILED",
            log_context="批量生成上传签名失败",
        )


@router.post("/confirm-upload", auth=jwt_auth, response=SuccessResponse, tags=["直传模式"])
def confirm_upload(request: HttpRequest, data: ConfirmUploadRequest):
    """
    前端直传 OSS 完成后的回调。

    验证文件确实已到达 OSS，然后通过 FileRegistryService 创建 FileRecord。
    """
    user_id = _get_user_id(request)
    organization_id = _oss_resolve_organization(data.organization_id or '', request)

    perm_err = _check_upload_permission(request, organization_id)
    if perm_err is not None:
        return perm_err
    policy_err = _check_organization_resource_write_policy(organization_id)
    if policy_err is not None:
        return policy_err

    try:
        if not _model_field_was_set(data, "is_public"):
            _log_implicit_is_public_default(
                endpoint="POST /confirm-upload",
                module=data.module or "other",
                context_type=data.context_type or "",
                context_id=data.context_id or "",
                user_id=str(user_id),
            )
        try:
            _assert_tabdoc_html_upload_private(
                module=data.module,
                object_key=data.object_key,
                requested_is_public=bool(data.is_public),
            )
        except ValidationException as exc:
            return {
                "success": False,
                "message": str(exc),
                "data": None,
                "error_code": "TABDOC_HTML_PUBLIC_UPLOAD_FORBIDDEN",
                "timestamp": "",
            }
        effective_is_public = _effective_is_public_for_module(data.module or '', data.is_public)
        is_tabdoc_html = _is_tabdoc_html_upload(module=data.module, object_key=data.object_key)
        if is_tabdoc_html:
            effective_is_public = False
        if not data.context_id or not data.context_id.strip():
            return {
                "success": False,
                "message": "context_id is required and cannot be empty",
                "data": None,
                "error_code": "VALIDATION_ERROR",
                "timestamp": "",
            }

        _validate_upload_params(
            data.file_name,
            data.file_size,
            data.content_type,
            module=data.module,
            context_type=data.context_type,
            is_public=effective_is_public,
        )
        is_space_tabfiles = _is_space_tabfiles_upload(data.module, data.context_type)

        ownership_error = _verify_presign_ownership(
            data.object_key,
            str(user_id),
            module=data.module or 'other',
            context_type=data.context_type or '',
            context_id=data.context_id or '',
            organization_id=organization_id,
            is_public=effective_is_public,
        )
        if ownership_error is not None:
            return ownership_error

        oss_service = get_oss_service()

        try:
            file_on_oss = oss_service.file_exists(data.object_key)
        except OSSServiceException:
            return {
                "success": False,
                "message": _("oss.service_unavailable_verify"),
                "data": None,
                "error_code": "OSS_SERVICE_UNAVAILABLE",
                "timestamp": "",
            }

        if not file_on_oss:
            return {
                "success": False,
                "message": _("oss.file_not_on_oss"),
                "data": None,
                "error_code": "FILE_NOT_FOUND_ON_OSS",
                "timestamp": "",
            }

        oss_info = oss_service.get_file_info(data.object_key)
        if (
            not oss_info.get('success')
            or not isinstance(oss_info.get('data'), dict)
            or oss_info['data'].get('content_length') is None
        ):
            return {
                "success": False,
                "message": "OSS 服务不可用，无法核验文件真实大小",
                "data": None,
                "error_code": "OSS_FILE_INFO_UNAVAILABLE",
                "timestamp": "",
            }
        actual_size = oss_info['data']['content_length']
        actual_size = _validate_confirmed_file_size(actual_size)

        # TA-7: 使用 OSS 返回的真实 content_type 交叉校验
        confirmed_ct = _resolve_confirmed_content_type(data.content_type, oss_info)
        if not is_space_tabfiles and _is_dangerous_mime(confirmed_ct):
            logger.warning(
                "confirm-upload 拒绝危险 MIME: object_key=%s, declared=%s, oss=%s",
                data.object_key, data.content_type, confirmed_ct,
            )
            return {
                "success": False,
                "message": f"不允许上传危险类型文件: {confirmed_ct}",
                "data": None,
                "error_code": "DANGEROUS_CONTENT_TYPE",
                "timestamp": "",
            }

        if effective_is_public:
            public_acl_ok = oss_service.set_object_public_read(data.object_key)
            if not public_acl_ok and getattr(oss_service, "config", {}).get("access_mode") == "private":
                logger.warning("公开资产 ACL 设置失败: object_key=%s", data.object_key)
                try:
                    oss_service.delete_file(data.object_key)
                except Exception:
                    logger.error("公开资产 ACL 失败后清理 OSS 文件失败: object_key=%s", data.object_key)
                return {
                    "success": False,
                    "message": "公开资产访问权限设置失败，请检查 OSS Bucket/AK 权限",
                    "data": None,
                    "error_code": "PUBLIC_ACL_FAILED",
                    "timestamp": "",
                }
        elif not effective_is_public:
            private_acl_ok = oss_service.set_object_private(data.object_key)
            if not private_acl_ok:
                logger.warning("私有对象 ACL 设置失败: object_key=%s", data.object_key)
                try:
                    oss_service.delete_file(data.object_key)
                except Exception:
                    logger.error(
                        "TabDoc HTML private ACL 失败后清理 OSS 文件失败: object_key=%s",
                        data.object_key,
                    )
                return {
                    "success": False,
                    "message": "私有 HTML 资产访问权限设置失败，请检查 OSS Bucket/AK 权限",
                    "data": None,
                    "error_code": "PRIVATE_ACL_FAILED",
                    "timestamp": "",
                }

        from apps.services.oss.services.file_registry import FileRegistryService

        reservation_released = False
        try:
            file_record = FileRegistryService.register_uploaded_file(
                object_key=data.object_key,
                file_name=data.file_name,
                file_size=actual_size,
                content_type=confirmed_ct,
                module=data.module or 'other',
                user_id=str(user_id or ""),
                organization_id=organization_id,
                context_type=data.context_type or '',
                context_id=data.context_id,
                upload_source='direct_upload',
                file_hash=data.file_hash or '',
                hash_algorithm=data.hash_algorithm or '',
                upload_ip=request.META.get('REMOTE_ADDR', ''),
                metadata={
                    'upload_method': 'direct',
                    'organization_id': organization_id,
                },
                enforce_storage_quota=bool(organization_id and actual_size > 0),
                is_public=effective_is_public,
            )

            if organization_id and data.file_size > 0:
                try:
                    from .services.storage_reservation import release_bytes
                    release_bytes(organization_id, data.file_size)
                except Exception:
                    pass
            reservation_released = True

            logger.info(f"直传确认成功 - 文件ID: {file_record.id}, object_key: {data.object_key}")

            response_data = file_record.to_response_dict()
            if not file_record.is_public:
                accessible = resolve_authorized_file(
                    file_record,
                    expiration=3600,
                    oss_service=oss_service,
                )
                response_data.update({
                    "access_url": accessible.url,
                    "cdn_url": "",
                    "resolved_url": accessible.url,
                    "access_mode": accessible.access_mode,
                    "expires_in": accessible.expires_in,
                    "expires_at": accessible.expires_at,
                })

            return {
                "success": True,
                "message": _("oss.confirm_success"),
                "data": response_data,
                "timestamp": "",
            }

        except BillingBlockedError:
            return _billing_blocked_response()
        except ValueError as quota_exc:
            return {
                "success": False,
                "message": str(quota_exc),
                "data": None,
                "error_code": "STORAGE_QUOTA_EXCEEDED",
                "timestamp": "",
            }
        finally:
            if not reservation_released and organization_id and data.file_size > 0:
                try:
                    from .services.storage_reservation import release_bytes
                    release_bytes(organization_id, data.file_size)
                except Exception:
                    pass

    except ValidationException as e:
        return {
            "success": False,
            "message": str(e),
            "data": None,
            "error_code": "VALIDATION_ERROR",
            "timestamp": "",
        }
    except Exception as e:
        return _safe_error_response(
            e, _("oss.confirm_failed"),
            error_code="CONFIRM_UPLOAD_FAILED",
            log_context="直传确认失败",
        )


@router.post("/confirm-upload-batch", auth=jwt_auth, response=SuccessResponse, tags=["直传模式"])
def confirm_upload_batch(request: HttpRequest, data: ConfirmUploadBatchRequest):
    """批量直传确认。"""
    user_id = _get_user_id(request)
    default_organization_id = _oss_resolve_organization('', request)

    perm_err = _check_upload_permission(request, default_organization_id)
    if perm_err is not None:
        return perm_err
    policy_err = _check_organization_resource_write_policy(default_organization_id)
    if policy_err is not None:
        return policy_err

    results = []
    success_count = 0
    failed_count = 0

    try:
        oss_service = get_oss_service()
        upload_ip = request.META.get('REMOTE_ADDR', '')

        from apps.services.oss.services.file_registry import FileRegistryService

        # DVC-021: 批次级前置配额校验，防止中间某文件超配额导致已注册文件成孤儿
        from collections import defaultdict
        _batch_organization_sizes = defaultdict(int)
        for item in data.items:
            _ws = getattr(item, 'organization_id', None) or default_organization_id
            perm_err = _check_upload_permission(request, _ws)
            if perm_err is not None:
                return perm_err
            policy_err = _check_organization_resource_write_policy(_ws)
            if policy_err is not None:
                return policy_err
            if _ws and item.file_size > 0:
                _batch_organization_sizes[_ws] += item.file_size
        if _batch_organization_sizes:
            from apps.services.billing.services import OrganizationStorageBillingService
            for _ws, _total_bytes in _batch_organization_sizes.items():
                try:
                    OrganizationStorageBillingService.assert_storage_upload_allowed(
                        organization_id=_ws,
                        incoming_bytes=_total_bytes,
                    )
                except BillingBlockedError:
                    return _billing_blocked_response()
                except ValueError as quota_exc:
                    return {
                        "success": False,
                        "message": str(quota_exc),
                        "data": None,
                        "error_code": "STORAGE_QUOTA_EXCEEDED",
                        "timestamp": "",
                    }
                except Exception as exc:
                    logger.error(
                        "confirm-upload-batch 批次配额预检异常: organization=%s, err=%s",
                        _ws, exc,
                    )
                    return {
                        "success": False,
                        "message": _("oss.storage_check_failed"),
                        "data": None,
                        "error_code": "STORAGE_CHECK_ERROR",
                        "timestamp": "",
                    }

        for item in data.items:
            try:
                item_ws_id = getattr(item, 'organization_id', None) or default_organization_id
                if not _model_field_was_set(item, "is_public"):
                    _log_implicit_is_public_default(
                        endpoint="POST /confirm-upload-batch",
                        module=item.module or "other",
                        context_type=item.context_type or "",
                        context_id=item.context_id or "",
                        user_id=str(user_id),
                    )
                try:
                    _assert_tabdoc_html_upload_private(
                        module=item.module,
                        object_key=item.object_key,
                        requested_is_public=bool(item.is_public),
                    )
                except ValidationException as exc:
                    failed_count += 1
                    results.append({
                        'object_key': item.object_key,
                        'success': False,
                        'message': str(exc),
                        'error_code': 'TABDOC_HTML_PUBLIC_UPLOAD_FORBIDDEN',
                    })
                    continue
                effective_is_public = _effective_is_public_for_module(item.module or '', item.is_public)
                is_tabdoc_html = _is_tabdoc_html_upload(
                    module=item.module,
                    object_key=item.object_key,
                )
                if is_tabdoc_html:
                    effective_is_public = False
                if not item.context_id or not item.context_id.strip():
                    failed_count += 1
                    results.append({
                        'object_key': item.object_key,
                        'success': False,
                        'message': 'context_id is required and cannot be empty',
                        'error_code': 'VALIDATION_ERROR',
                    })
                    continue

                _validate_upload_params(
                    item.file_name,
                    item.file_size,
                    item.content_type,
                    module=item.module,
                    context_type=item.context_type,
                    is_public=effective_is_public,
                )
                is_space_tabfiles = _is_space_tabfiles_upload(item.module, item.context_type)

                ownership_error = _verify_presign_ownership(
                    item.object_key,
                    str(user_id),
                    module=item.module or 'other',
                    context_type=item.context_type or '',
                    context_id=item.context_id or '',
                    organization_id=item_ws_id,
                    is_public=effective_is_public,
                )
                if ownership_error is not None:
                    failed_count += 1
                    results.append({
                        'object_key': item.object_key,
                        'success': False,
                        'message': ownership_error['message'],
                        'error_code': ownership_error.get('error_code', 'OBJECT_KEY_OWNERSHIP_MISMATCH'),
                    })
                    continue

                try:
                    file_on_oss = oss_service.file_exists(item.object_key)
                except OSSServiceException:
                    failed_count += 1
                    results.append({
                        'object_key': item.object_key,
                        'success': False,
                        'message': 'OSS 服务不可用，无法验证文件',
                        'error_code': 'OSS_SERVICE_UNAVAILABLE',
                    })
                    continue

                if not file_on_oss:
                    failed_count += 1
                    results.append({
                        'object_key': item.object_key,
                        'success': False,
                        'message': _("oss.file_not_on_oss_short"),
                    })
                    continue

                oss_info = oss_service.get_file_info(item.object_key)
                if (
                    not oss_info.get('success')
                    or not isinstance(oss_info.get('data'), dict)
                    or oss_info['data'].get('content_length') is None
                ):
                    failed_count += 1
                    results.append({
                        'object_key': item.object_key,
                        'success': False,
                        'message': 'OSS 服务不可用，无法核验文件真实大小',
                        'error_code': 'OSS_FILE_INFO_UNAVAILABLE',
                    })
                    continue
                actual_size = oss_info['data']['content_length']
                actual_size = _validate_confirmed_file_size(actual_size)

                # TA-7: Content-Type 交叉校验
                confirmed_ct = _resolve_confirmed_content_type(item.content_type, oss_info)
                if not is_space_tabfiles and _is_dangerous_mime(confirmed_ct):
                    failed_count += 1
                    results.append({
                        'object_key': item.object_key,
                        'success': False,
                        'message': f"不允许上传危险类型文件: {confirmed_ct}",
                        'error_code': 'DANGEROUS_CONTENT_TYPE',
                    })
                    continue

                if effective_is_public:
                    public_acl_ok = oss_service.set_object_public_read(item.object_key)
                    if not public_acl_ok and getattr(oss_service, "config", {}).get("access_mode") == "private":
                        try:
                            oss_service.delete_file(item.object_key)
                        except Exception:
                            logger.error("公开资产 ACL 失败后清理 OSS 文件失败: object_key=%s", item.object_key)
                        failed_count += 1
                        results.append({
                            'object_key': item.object_key,
                            'success': False,
                            'message': '公开资产访问权限设置失败，请检查 OSS Bucket/AK 权限',
                            'error_code': 'PUBLIC_ACL_FAILED',
                        })
                        continue
                elif is_tabdoc_html:
                    private_acl_ok = oss_service.set_object_private(item.object_key)
                    if not private_acl_ok:
                        try:
                            oss_service.delete_file(item.object_key)
                        except Exception:
                            logger.error(
                                "TabDoc HTML private ACL 失败后清理 OSS 文件失败: object_key=%s",
                                item.object_key,
                            )
                        failed_count += 1
                        results.append({
                            'object_key': item.object_key,
                            'success': False,
                            'message': '私有 HTML 资产访问权限设置失败，请检查 OSS Bucket/AK 权限',
                            'error_code': 'PRIVATE_ACL_FAILED',
                        })
                        continue

                # DVC-021: 逐文件配额已在批次级前置校验，此处仅记录 actual_size 偏差告警
                if item_ws_id and actual_size > 0 and actual_size != item.file_size:
                    size_diff = actual_size - item.file_size
                    if size_diff > 0:
                        logger.warning(
                            "confirm-upload-batch 文件实际大小大于声明值: "
                            "object_key=%s, declared=%d, actual=%d, diff=+%d",
                            item.object_key, item.file_size, actual_size, size_diff,
                        )

                file_record = FileRegistryService.register_uploaded_file(
                    object_key=item.object_key,
                    file_name=item.file_name,
                    file_size=actual_size,
                    content_type=confirmed_ct,
                    module=item.module or 'other',
                    user_id=str(user_id or ""),
                    organization_id=item_ws_id,
                    context_type=item.context_type or '',
                    context_id=item.context_id,
                    upload_source='direct_upload_batch',
                    file_hash=item.file_hash or '',
                    hash_algorithm=item.hash_algorithm or '',
                    upload_ip=upload_ip,
                    metadata={
                        'upload_method': 'direct_batch',
                        'organization_id': item_ws_id,
                    },
                    enforce_storage_quota=bool(item_ws_id and actual_size > 0),
                    is_public=effective_is_public,
                )

                success_count += 1
                results.append({
                    'object_key': item.object_key,
                    'success': True,
                    **file_record.to_response_dict(),
                })

            except ValidationException as e:
                failed_count += 1
                results.append({
                    'object_key': item.object_key,
                    'success': False,
                    'message': str(e),
                    'error_code': 'VALIDATION_ERROR',
                })
            except Exception as e:
                logger.error("confirm-upload-batch 单文件处理失败: object_key=%s, err=%s", item.object_key, e, exc_info=True)
                failed_count += 1
                results.append({
                    'object_key': item.object_key,
                    'success': False,
                    'message': _("oss.confirm_failed"),
                })

        return {
            "success": True,
            "message": _("oss.batch_confirm_complete", success_count=success_count, failed_count=failed_count),
            "data": {
                'success_count': success_count,
                'failed_count': failed_count,
                'results': results,
            },
            "timestamp": "",
        }

    except Exception as e:
        return _safe_error_response(
            e, _("oss.batch_confirm_failed"),
            error_code="CONFIRM_BATCH_FAILED",
            log_context="批量直传确认失败",
        )


# ---------------------------------------------------------------------------
# 存储分析 API — Phase 1
# ---------------------------------------------------------------------------

def _check_organization_role(request: HttpRequest, organization_id: str, required_role: str = "viewer") -> bool:
    """校验当前用户在指定 organization 中的角色是否满足要求。"""
    auth = getattr(request, 'auth', None)
    if not auth:
        return False
    try:
        from apps.tabtinspace.services.base import BaseService
        svc = BaseService(user=auth)
        return svc.check_organization_permission(organization_id, required_role)
    except Exception:
        return False


def _get_user_role(request: HttpRequest, organization_id: str) -> str:
    """获取当前用户在 organization 中的角色（统一走 BaseService + DB Router）。"""
    auth = getattr(request, 'auth', None)
    if not auth:
        return "viewer"
    try:
        from apps.tabtinspace.models import Organization
        from apps.tabtinspace.services.base import BaseService
        svc = BaseService(user=auth)
        organization = Organization.objects.get(id=organization_id)
        role = svc._get_operator_role(organization)
        return role or "viewer"
    except Exception:
        pass
    return "viewer"


def _storage_api(request, organization_id, fn, **kwargs):
    """存储分析端点通用封装：organization 解析 + 成员校验 + 异常处理。"""
    wt = _oss_resolve_organization(organization_id, request)
    if not wt:
        return {"success": False, "message": "organization_id required", "data": None, "timestamp": ""}
    if not _check_organization_role(request, wt, "viewer"):
        return {"success": False, "message": "无权访问", "data": None, "error_code": "PERMISSION_DENIED", "timestamp": ""}
    try:
        from .services.storage_analytics import StorageAnalyticsService
        data = getattr(StorageAnalyticsService, fn)(wt, **kwargs)
        return {"success": True, "message": "ok", "data": data, "timestamp": ""}
    except Exception as e:
        logger.error("存储分析接口异常 (%s): %s", fn, e, exc_info=True)
        return {"success": False, "message": "存储分析服务异常，请稍后重试", "data": None, "error_code": "STORAGE_ANALYTICS_ERROR", "timestamp": ""}


@router.get("/storage/overview", auth=jwt_auth, response=SuccessResponse, tags=["存储分析"])
def storage_overview(request: HttpRequest, organization_id: str = ""):
    """存储总览：配额、已用、按模块占比摘要。"""
    return _storage_api(request, organization_id, "get_overview")


@router.get("/storage/by-module", auth=jwt_auth, response=SuccessResponse, tags=["存储分析"])
def storage_by_module(request: HttpRequest, organization_id: str = ""):
    """按来源模块分组的存储占用明细。"""
    return _storage_api(request, organization_id, "get_by_module")


@router.get("/storage/by-member", auth=jwt_auth, response=SuccessResponse, tags=["存储分析"])
def storage_by_member(request: HttpRequest, organization_id: str = "", limit: int = 20):
    """按成员分组的存储占用明细（仅 admin/owner）。"""
    wt = _oss_resolve_organization(organization_id, request)
    if not wt:
        return {"success": False, "message": "organization_id required", "data": None, "timestamp": ""}
    if not _check_organization_role(request, wt, "admin"):
        return {"success": False, "message": "需要管理员权限", "data": None, "error_code": "PERMISSION_DENIED", "timestamp": ""}
    return _storage_api(request, organization_id, "get_by_member", limit=min(limit, 50))


@router.get("/storage/by-file-type", auth=jwt_auth, response=SuccessResponse, tags=["存储分析"])
def storage_by_file_type(request: HttpRequest, organization_id: str = ""):
    """按文件类型分组的存储占用明细。"""
    return _storage_api(request, organization_id, "get_by_file_type")


@router.get("/storage/large-files", auth=jwt_auth, response=SuccessResponse, tags=["存储分析"])
def storage_large_files(request: HttpRequest, organization_id: str = "", min_size: int = 1_048_576, limit: int = 10):
    """大文件列表（默认 ≥1MB，Top 10）。"""
    return _storage_api(request, organization_id, "get_large_files", min_size=max(0, min_size), limit=min(limit, 50))


# ---------------------------------------------------------------------------
# 存储文件管理 API — Phase 2
# ---------------------------------------------------------------------------

@router.get("/storage/files", auth=jwt_auth, response=SuccessResponse, tags=["存储文件管理"])
def storage_file_list(
    request: HttpRequest,
    organization_id: str = "",
    module: str = "",
    file_type: str = "",
    min_size: int = 0,
    max_size: int = 0,
    uploaded_after: str = "",
    uploaded_before: str = "",
    search: str = "",
    sort: str = "-file_size",
    cursor: str = "",
    limit: int = 20,
):
    """文件列表：多维筛选 + 游标分页。"""
    wt = _oss_resolve_organization(organization_id, request)
    if not wt:
        return {"success": False, "message": "organization_id required", "data": None, "timestamp": ""}
    if not _check_organization_role(request, wt, "viewer"):
        return {"success": False, "message": "无权访问", "data": None, "error_code": "PERMISSION_DENIED", "timestamp": ""}
    user_role = _get_user_role(request, wt)
    try:
        from .services.storage_file_service import StorageFileService
        data = StorageFileService.list_files(
            wt,
            current_user_id=_get_user_id(request),
            user_role=user_role,
            module=module,
            file_type=file_type,
            min_size=min_size,
            max_size=max_size,
            uploaded_after=uploaded_after,
            uploaded_before=uploaded_before,
            search=search,
            sort=sort,
            cursor=cursor,
            limit=limit,
        )
        return {"success": True, "message": "ok", "data": data, "timestamp": ""}
    except Exception as e:
        logger.error("storage_file_list error: %s", e, exc_info=True)
        return {"success": False, "message": "文件列表查询失败，请稍后重试", "data": None, "error_code": "STORAGE_FILE_LIST_ERROR", "timestamp": ""}


@router.get("/storage/files/{file_id}/usages", auth=jwt_auth, response=SuccessResponse, tags=["存储文件管理"])
def storage_file_usages(request: HttpRequest, file_id: str, organization_id: str = ""):
    """查看文件的引用关系列表。"""
    wt = _oss_resolve_organization(organization_id, request)
    if not wt:
        return {"success": False, "message": "organization_id required", "data": None, "timestamp": ""}
    if not _check_organization_role(request, wt, "viewer"):
        return {"success": False, "message": "无权访问", "data": None, "error_code": "PERMISSION_DENIED", "timestamp": ""}
    try:
        from .services.storage_file_service import StorageFileService
        data = StorageFileService.get_file_usages(wt, file_id)
        return {"success": True, "message": "ok", "data": data, "timestamp": ""}
    except Exception as e:
        logger.error("storage_file_usages error: %s", e, exc_info=True)
        return {"success": False, "message": "文件引用查询失败，请稍后重试", "data": None, "error_code": "STORAGE_FILE_USAGES_ERROR", "timestamp": ""}


@router.post("/storage/files/batch-delete", auth=jwt_auth, response=SuccessResponse, tags=["存储文件管理"])
def storage_batch_delete(request: HttpRequest, data: StorageBatchDeleteRequest, organization_id: str = ""):
    """批量安全删除文件（deactivate 引用 + 释放计量）。"""
    wt = _oss_resolve_organization(organization_id, request)
    if not wt:
        return {"success": False, "message": "organization_id required", "data": None, "timestamp": ""}
    user_id = _get_user_id(request)
    user_role = _get_user_role(request, wt)
    if user_role == "viewer":
        return {"success": False, "message": "查看者无权删除文件", "data": None, "error_code": "PERMISSION_DENIED", "timestamp": ""}
    policy_err = _check_organization_resource_write_policy(wt)
    if policy_err is not None:
        return policy_err
    try:
        from .services.storage_file_service import StorageFileService
        result = StorageFileService.batch_delete_files(
            wt,
            file_ids=data.file_ids,
            user_id=user_id,
            user_role=user_role,
        )
        return {"success": True, "message": "ok", "data": result, "timestamp": ""}
    except Exception as e:
        logger.error("storage_batch_delete error: %s", e, exc_info=True)
        return {"success": False, "message": "批量删除操作失败，请稍后重试", "data": None, "error_code": "STORAGE_DELETE_ERROR", "timestamp": ""}

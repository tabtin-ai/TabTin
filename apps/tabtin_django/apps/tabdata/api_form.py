"""
Form API - 公开表单接口

提供表单视图的公开访问（无需登录即可获取表单元数据和提交数据）。
表单通过 TableShare 的 share_id 分发，share 关联的 view 必须为 form 类型。
"""
import logging
import secrets
from typing import Optional, Set
from uuid import UUID

from django.core.cache import cache
from django.db.models import F, Q as models_Q
from django.http import HttpRequest
from django.utils import timezone
from ninja import Router

from apps.users.auth.permissions import JWTAuth
from apps.users.membership.exceptions import QuotaExceededError

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableView, TableField, TableShare, TableRecord
from apps.tabdata.schemas import FormSubmitRequest, FormPasswordVerifyRequest, ErrorResponse
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.api_helpers import (
    success_response, error_response, not_found_response,
    validation_error_response,
    api_error_handler,
)
from apps.i18n import _

logger = logging.getLogger(__name__)

router = Router(tags=["TabData Form"])
jwt_auth = JWTAuth()

SYSTEM_FIELD_TYPES = frozenset({
    'created_time', 'last_modified_time', 'created_by', 'last_modified_by',
})

MAX_PASSWORD_ATTEMPTS = 5
PASSWORD_LOCKOUT_SECONDS = 900


def _get_client_ip(request: HttpRequest) -> str:
    xff = request.META.get('HTTP_X_FORWARDED_FOR')
    if xff:
        return xff.split(',')[0].strip()
    return request.META.get('HTTP_X_REAL_IP') or request.META.get('REMOTE_ADDR', 'unknown')


def _is_password_rate_limited(share_id: str, ip: str) -> bool:
    try:
        key = f"form_pwd_attempts:{share_id}:{ip}"
        return cache.get(key, 0) >= MAX_PASSWORD_ATTEMPTS
    except Exception:
        return False


def _record_password_failure(share_id: str, ip: str) -> None:
    try:
        key = f"form_pwd_attempts:{share_id}:{ip}"
        attempts = cache.get(key, 0)
        cache.set(key, attempts + 1, timeout=PASSWORD_LOCKOUT_SECONDS)
    except Exception:
        pass


def _generate_share_id() -> str:
    return secrets.token_urlsafe(12)[:16]


def _validate_share(share: TableShare) -> Optional[dict]:
    """校验分享是否有效，返回 None 表示有效，否则返回错误响应 dict。"""
    if share.is_expired():
        return error_response(ErrorCode.FORM_EXPIRED, message="表单已过期或超出访问次数限制", status_code=410)
    if not share.view:
        return error_response(ErrorCode.FORM_NOT_FOUND, message="分享未关联视图", status_code=404)
    if share.view.view_type != 'form':
        return error_response(ErrorCode.FORM_NOT_FOUND, message="关联的视图不是表单类型", status_code=404)
    return None


def _get_visible_field_ids(view: TableView) -> Set[str]:
    """从视图的 column_meta / visible_fields 推导可见字段 ID 集合。

    兼容两种可见性协议：
    - TabTin 后端写入 ``hidden`` (bool, True=隐藏)
    - 前端 table-ui 对 form 视图写入 ``visible`` (bool, True=可见)
    优先级：hidden > visible；都缺省时默认可见。
    """
    visible = set()
    if view.column_meta:
        for fid, meta in view.column_meta.items():
            if not meta.get('hidden', not meta.get('visible', True)):
                visible.add(str(fid))
    elif view.visible_fields:
        visible = {str(fid) for fid in view.visible_fields}
    return visible


def _serialize_form_meta(share: TableShare, fields: list, view: TableView) -> dict:
    """序列化表单元数据供前端渲染。"""
    from apps.tabdata.utils.default_values import get_effective_default_value

    config = view.config or {}
    field_configs = config.get('field_configs', {})
    visible_field_ids = _get_visible_field_ids(view)

    form_fields = []
    for f in fields:
        if f.field_type in SYSTEM_FIELD_TYPES:
            continue
        if visible_field_ids and str(f.id) not in visible_field_ids:
            continue
        fc = field_configs.get(str(f.id), {})
        form_fields.append({
            'id': str(f.id),
            'name': f.name,
            'field_type': f.field_type,
            'config': f.config or {},
            'description': fc.get('description', ''),
            'default_value': get_effective_default_value(
                f.field_type,
                f.default_value,
            ),
        })

    field_order = view.field_order or []
    if field_order:
        order_map = {str(fid): i for i, fid in enumerate(field_order)}
        form_fields.sort(key=lambda ff: order_map.get(ff['id'], 9999))

    return {
        'share_id': share.share_id,
        'title': config.get('title', view.name),
        'description': config.get('description', view.description or ''),
        'cover_url': config.get('cover_url', ''),
        'logo_url': config.get('logo_url', ''),
        'submit_label': config.get('submit_label', '提交'),
        'success_message': config.get('success_message', '提交成功！感谢您的填写。'),
        'redirect_url': config.get('redirect_url', ''),
        'allow_multiple_submit': bool(config.get('allow_multiple_submit', True)),
        'login_required': bool(config.get('login_required', False)),
        'has_password': share.has_password,
        'fields': form_fields,
    }


# ==================== 表单创建分享 ====================

@router.post(
    "/views/{view_id}/form-share",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="为表单视图创建/获取分享链接"
)
@api_error_handler
def create_or_get_form_share(request: HttpRequest, view_id: UUID):
    """为表单视图创建分享链接。如果该视图已存在未过期的分享，直接返回。"""
    try:
        view = TableView.objects.using(TABDATA_DB_ALIAS).select_related('table').get(id=view_id)
    except TableView.DoesNotExist:
        return not_found_response("视图")

    if view.view_type != 'form':
        return validation_error_response("只有表单视图可以创建表单分享链接")

    from apps.tabdata.services import TableService
    table_service = TableService(user=request.auth)
    if not table_service.check_table_permission(str(view.table_id), 'editor'):
        return error_response(ErrorCode.PERMISSION_DENIED, message="无权限操作", status_code=403)

    existing = TableShare.objects.using(TABDATA_DB_ALIAS).filter(
        view=view,
        table=view.table,
    ).order_by('-created_at').first()

    if existing and not existing.is_expired():
        fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table=view.table, is_deleted=False,
        ).order_by('order'))
        return 201, success_response({
            'share': {
                'id': str(existing.id),
                'share_id': existing.share_id,
                'has_password': existing.has_password,
                'expire_at': existing.expire_at.isoformat() if existing.expire_at else None,
            },
            'form_meta': _serialize_form_meta(existing, fields, view),
        })

    share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
        table=view.table,
        view=view,
        share_id=_generate_share_id(),
        permission='edit',
        created_by=request.auth,
    )

    fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table=view.table, is_deleted=False,
    ).order_by('order'))

    return 201, success_response({
        'share': {
            'id': str(share.id),
            'share_id': share.share_id,
            'has_password': share.has_password,
            'expire_at': None,
        },
        'form_meta': _serialize_form_meta(share, fields, view),
    })


# ==================== 公开表单访问（无需登录） ====================

@router.get(
    "/forms/{share_id}",
    response={200: dict, 404: ErrorResponse, 410: ErrorResponse},
    auth=None,
    summary="获取公开表单元数据"
)
@api_error_handler
def get_public_form(request: HttpRequest, share_id: str):
    """通过 share_id 获取表单元数据（无需登录）。"""
    try:
        share = TableShare.objects.using(TABDATA_DB_ALIAS).select_related(
            'view', 'view__table',
        ).get(share_id=share_id)
    except TableShare.DoesNotExist:
        return error_response(ErrorCode.FORM_NOT_FOUND, message="表单不存在", status_code=404)

    err = _validate_share(share)
    if err:
        return err

    if share.has_password:
        return success_response({
            'has_password': True,
            'title': (share.view.config or {}).get('title', share.view.name),
        })

    TableShare.objects.using(TABDATA_DB_ALIAS).filter(
        id=share.id,
    ).update(visit_count=F('visit_count') + 1)

    fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table=share.view.table, is_deleted=False,
    ).order_by('order'))

    return success_response(_serialize_form_meta(share, fields, share.view))


@router.post(
    "/forms/{share_id}/verify",
    response={200: dict, 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 410: ErrorResponse, 429: ErrorResponse},
    auth=None,
    summary="验证表单密码"
)
@api_error_handler
def verify_form_password(request: HttpRequest, share_id: str, data: FormPasswordVerifyRequest):
    """验证表单密码并返回表单元数据。"""
    try:
        share = TableShare.objects.using(TABDATA_DB_ALIAS).select_related(
            'view', 'view__table',
        ).get(share_id=share_id)
    except TableShare.DoesNotExist:
        return error_response(ErrorCode.FORM_NOT_FOUND, message="表单不存在", status_code=404)

    err = _validate_share(share)
    if err:
        return err

    ip = _get_client_ip(request)
    if _is_password_rate_limited(share_id, ip):
        return error_response(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            message="密码尝试次数过多，请15分钟后再试",
            status_code=429,
        )

    if share.has_password and not share.check_password(data.password):
        _record_password_failure(share_id, ip)
        return error_response(ErrorCode.FORM_PASSWORD_INCORRECT, message="密码错误", status_code=403)

    TableShare.objects.using(TABDATA_DB_ALIAS).filter(
        id=share.id,
    ).update(visit_count=F('visit_count') + 1)

    fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table=share.view.table, is_deleted=False,
    ).order_by('order'))

    return success_response(_serialize_form_meta(share, fields, share.view))


@router.post(
    "/forms/{share_id}/submit",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 410: ErrorResponse, 429: ErrorResponse},
    auth=None,
    summary="提交公开表单数据"
)
@api_error_handler
def submit_public_form(request: HttpRequest, share_id: str, data: FormSubmitRequest):
    """提交表单数据 — 无需登录（除非 login_required）。每次提交创建一条记录。"""
    try:
        share = TableShare.objects.using(TABDATA_DB_ALIAS).select_related(
            'view', 'view__table',
        ).get(share_id=share_id)
    except TableShare.DoesNotExist:
        return error_response(ErrorCode.FORM_NOT_FOUND, message="表单不存在", status_code=404)

    err = _validate_share(share)
    if err:
        return err

    # 密码保护校验：有密码的表单提交时也需要验证
    if share.has_password:
        submitted_password = request.headers.get('X-Form-Password', '')
        ip = _get_client_ip(request)
        if _is_password_rate_limited(share_id, ip):
            return error_response(
                ErrorCode.RATE_LIMIT_EXCEEDED,
                message="密码尝试次数过多，请15分钟后再试",
                status_code=429,
            )
        if not share.check_password(submitted_password):
            _record_password_failure(share_id, ip)
            return error_response(ErrorCode.FORM_PASSWORD_INCORRECT, message="密码错误", status_code=403)

    view = share.view
    config = view.config or {}

    if config.get('login_required', False):
        try:
            user = JWTAuth()(request)
        except Exception:
            user = None
        if not user:
            return error_response(ErrorCode.LOGIN_REQUIRED, message="此表单要求登录后填写", status_code=401)
        request.auth = user

    table = view.table
    fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table=table, is_deleted=False,
    ).order_by('order'))
    field_map = {str(f.id): f for f in fields}

    visible_field_ids = _get_visible_field_ids(view)

    record_data = {}
    for fid, val in data.fields.items():
        field_obj = field_map.get(fid)
        if not field_obj:
            for f in fields:
                if f.name == fid:
                    field_obj = f
                    break
        if not field_obj:
            continue
        if field_obj.field_type in SYSTEM_FIELD_TYPES:
            continue
        if visible_field_ids and str(field_obj.id) not in visible_field_ids:
            continue
        record_data[str(field_obj.id)] = val

    owner = share.created_by
    if not owner:
        logger.error("表单分享创建者已被删除 share_id=%s", share_id)
        return error_response(
            ErrorCode.FORM_SUBMIT_FAILED,
            message="表单分享已失效（创建者不存在），请联系表单管理员重新分享",
            status_code=403,
        )

    # P1-6 修复（PRD §4.5）：submit 时刻实时校验 owner 仍对 table 拥有 editor 及以上权限。
    # 不校验会让"owner 已被移除/降权但 share 仍可用"——新提交记录依然以 owner 身份写入。
    # 注意：check_table_permission 内部已含 owner / TablePermission / space / organization 权限链；
    # 若无显式资源权限，organization owner 走 wt fallback 仍可通过，符合
    # "创建分享后退出协作但仍是 wt admin"的边界。
    from apps.tabdata.services.base import BaseService
    if not BaseService(user=owner).check_table_permission(str(table.id), required_role='editor'):
        logger.warning(
            "表单提交 owner 失权：share_id=%s owner_id=%s table_id=%s",
            share_id, owner.id, table.id,
        )
        return error_response(
            "OWNER_REVOKED",
            message="表单分享已失效（创建者已失去对此表的写权限），请联系管理员",
            status_code=403,
        )

    try:
        from apps.tabdata.services.record_service import RecordService
        from apps.tabdata.services.rls_service import RLSContext
        record_service = RecordService(user=owner)
        rls_ctx = RLSContext(user_id=str(owner.id) if owner else None)
        result = record_service.create_record(
            table_id=table.id,
            data=record_data,
            rls_context=rls_ctx,
            default_actor_id=(
                str(request.auth.id)
                if getattr(request, 'auth', None) is not None
                else None
            ),
        )
        record, error_msg = result
        if error_msg:
            return validation_error_response(error_msg)
    except QuotaExceededError as exc:
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message=str(exc), status_code=403)
    except PermissionError as exc:
        logger.warning("表单提交权限异常 share_id=%s: %s", share_id, exc)
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message=str(exc), status_code=403)
    except ValueError as exc:
        logger.warning("表单提交业务异常 share_id=%s: %s", share_id, exc)
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message=str(exc), status_code=400)
    except Exception:
        logger.exception("表单提交失败 share_id=%s", share_id)
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message="提交失败，请稍后重试", status_code=500)

    return 201, success_response({
        'success': True,
        'message': config.get('success_message', '提交成功！感谢您的填写。'),
        'redirect_url': config.get('redirect_url', ''),
    })


# ==================== 表内表单提交（已登录用户，无需分享链接） ====================

@router.post(
    "/tables/{table_id}/views/{view_id}/form-submit",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="已登录用户表内表单提交（无需分享链接）"
)
@api_error_handler
def submit_form_direct(request: HttpRequest, table_id: UUID, view_id: UUID, data: FormSubmitRequest):
    """已登录用户在表单视图中直接提交记录，不需要分享链接。触发与公开提交相同的记录创建逻辑。"""
    try:
        view = TableView.objects.using(TABDATA_DB_ALIAS).select_related('table').get(
            id=view_id, table_id=table_id, is_deleted=False
        )
    except TableView.DoesNotExist:
        return not_found_response("视图不存在")

    if view.view_type != 'form':
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message="该视图不是表单视图", status_code=400)

    table = view.table
    config = view.config or {}

    fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table=table, is_deleted=False,
    ).order_by('order'))
    field_map = {str(f.id): f for f in fields}

    visible_field_ids = _get_visible_field_ids(view)

    record_data = {}
    for fid, val in data.fields.items():
        field_obj = field_map.get(fid)
        if not field_obj:
            for f in fields:
                if f.name == fid:
                    field_obj = f
                    break
        if not field_obj:
            continue
        if field_obj.field_type in SYSTEM_FIELD_TYPES:
            continue
        if visible_field_ids and str(field_obj.id) not in visible_field_ids:
            continue
        record_data[str(field_obj.id)] = val

    try:
        from apps.tabdata.services.record_service import RecordService
        from apps.tabdata.services.rls_service import RLSContext
        record_service = RecordService(user=request.auth)
        rls_ctx = RLSContext.from_request(request)
        result = record_service.create_record(
            table_id=table.id,
            data=record_data,
            rls_context=rls_ctx,
        )
        record, error_msg = result
        if error_msg:
            return validation_error_response(error_msg)
    except QuotaExceededError as exc:
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message=str(exc), status_code=403)
    except PermissionError as exc:
        logger.warning("表内表单提交权限异常 view_id=%s: %s", view_id, exc)
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message=str(exc), status_code=403)
    except ValueError as exc:
        logger.warning("表内表单提交业务异常 view_id=%s: %s", view_id, exc)
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message=str(exc), status_code=400)
    except Exception:
        logger.exception("表内表单提交失败 view_id=%s", view_id)
        return error_response(ErrorCode.FORM_SUBMIT_FAILED, message="提交失败，请稍后重试", status_code=500)

    return 201, success_response({
        'success': True,
        'message': config.get('success_message', '提交成功！感谢您的填写。'),
        'redirect_url': config.get('redirect_url', ''),
    })


# ==================== 表单 Link 字段候选记录 ====================

@router.get(
    "/forms/{share_id}/link-records/{field_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 410: ErrorResponse, 429: ErrorResponse},
    auth=None,
    summary="获取表单 link 字段的候选关联记录"
)
@api_error_handler
def get_form_link_records(
    request: HttpRequest,
    share_id: str,
    field_id: UUID,
    search: str = '',
    page: int = 1,
    page_size: int = 50,
):
    """匿名获取 link 字段的候选记录，供表单填写者选择关联。

    安全策略：使用 share owner 的权限调用 LinkFieldService。
    仅允许访问表单可见的 link 字段。有密码保护时需要 X-Form-Password header。
    """
    try:
        share = TableShare.objects.using(TABDATA_DB_ALIAS).select_related(
            'view', 'view__table',
        ).get(share_id=share_id)
    except TableShare.DoesNotExist:
        return error_response(ErrorCode.FORM_NOT_FOUND, message="表单不存在", status_code=404)

    err = _validate_share(share)
    if err:
        return err

    if share.has_password:
        submitted_password = request.headers.get('X-Form-Password', '')
        ip = _get_client_ip(request)
        if _is_password_rate_limited(share_id, ip):
            return error_response(
                ErrorCode.RATE_LIMIT_EXCEEDED,
                message="密码尝试次数过多，请15分钟后再试",
                status_code=429,
            )
        if not share.check_password(submitted_password):
            _record_password_failure(share_id, ip)
            return error_response(ErrorCode.FORM_PASSWORD_INCORRECT, message="密码错误", status_code=403)

    view = share.view
    config = view.config or {}

    if config.get('login_required', False):
        try:
            user = JWTAuth()(request)
        except Exception:
            user = None
        if not user:
            return error_response(ErrorCode.LOGIN_REQUIRED, message="此表单要求登录后填写", status_code=401)
        request.auth = user

    visible_field_ids = _get_visible_field_ids(share.view)

    try:
        field = TableField.objects.using(TABDATA_DB_ALIAS).get(
            id=field_id, table=share.view.table, is_deleted=False,
        )
    except TableField.DoesNotExist:
        return not_found_response("字段")

    if field.field_type != 'link':
        return validation_error_response("该字段不是关联字段")

    if visible_field_ids and str(field.id) not in visible_field_ids:
        return error_response(ErrorCode.PERMISSION_DENIED, message="该字段不在表单可见范围内", status_code=403)

    if not share.created_by:
        return error_response(
            ErrorCode.FORM_SUBMIT_FAILED,
            message="表单分享已失效（创建者不存在），请联系表单管理员",
            status_code=403,
        )

    page_size = min(max(page_size, 1), 200)
    page = max(page, 1)

    from apps.tabdata.services.link_field_service import LinkFieldService
    try:
        records, total = LinkFieldService.get_linkable_records(
            field,
            search=search,
            page=page,
            page_size=page_size,
            user=share.created_by,
        )
    except PermissionError:
        logger.warning(
            "表单 link 字段查询权限不足: share_id=%s field_id=%s (share owner 可能已失去目标表权限)",
            share_id, field_id,
        )
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message="无法获取关联记录（表单创建者对目标表权限不足），请联系管理员",
            status_code=403,
        )

    return success_response({
        'records': records,
        'total': total,
    })


# ==================== 公开表单协作者（User 字段候选列表） ====================

@router.get(
    "/forms/{share_id}/collaborators",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 410: ErrorResponse, 429: ErrorResponse},
    auth=jwt_auth,
    summary="获取该表的协作者列表（供 User 字段选择，仅协作者可查）",
)
@api_error_handler
def get_form_collaborators(
    request: HttpRequest,
    share_id: str,
    search: str = '',
    page: int = 1,
    page_size: int = 50,
):
    """P1-5 修复（PRD §4.4）：
    返回 table 的协作者列表（owner + TablePermission 中 subject_type='user' 的活跃记录），
    **不再裸列 organization 全员**——避免任何已登录用户拿到 share_id 就能拉整团队通讯录。

    访问控制：
    - 匿名 → ninja jwt_auth 自动返 401
    - 登录但非该表协作者 → 403（避免变成"任意登录用户都能查任意表协作者列表"）
    - 协作者 → 200，返 owner + TablePermission 列表
    """
    try:
        share = TableShare.objects.using(TABDATA_DB_ALIAS).select_related(
            'view', 'view__table',
        ).get(share_id=share_id)
    except TableShare.DoesNotExist:
        return error_response(ErrorCode.FORM_NOT_FOUND, message="表单不存在", status_code=404)

    err = _validate_share(share)
    if err:
        return err

    if share.has_password:
        submitted_password = request.headers.get('X-Form-Password', '')
        ip = _get_client_ip(request)
        if _is_password_rate_limited(share_id, ip):
            return error_response(
                ErrorCode.RATE_LIMIT_EXCEEDED,
                message="密码尝试次数过多，请15分钟后再试",
                status_code=429,
            )
        if not share.check_password(submitted_password):
            _record_password_failure(share_id, ip)
            return error_response(ErrorCode.FORM_PASSWORD_INCORRECT, message="密码错误", status_code=403)

    table = share.view.table

    # 协作者集合 = TablePermission(subject_type='user', is_active=True) + table owner
    from apps.tabdata.models import TablePermission

    collaborator_ids: set[str] = {
        str(uid)
        for uid in TablePermission.objects.using(TABDATA_DB_ALIAS)
        .filter(table=table, subject_type='user', is_active=True)
        .values_list('subject_id', flat=True)
    }
    owner_id = getattr(table, 'owner_id', None)
    if owner_id:
        collaborator_ids.add(str(owner_id))

    # 访问者必须在协作者集合内——避免任意登录用户查任意表的协作者列表
    current_user_id = str(getattr(request.auth, 'id', '') or '')
    if not current_user_id or current_user_id not in collaborator_ids:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message="你不是该表协作者，无权查看协作者列表",
            status_code=403,
        )

    if not collaborator_ids:
        return success_response({'collaborators': [], 'total': 0})

    from django.contrib.auth import get_user_model
    User = get_user_model()

    users_qs = User.objects.filter(id__in=list(collaborator_ids))
    if search:
        users_qs = users_qs.filter(
            models_Q(nickname__icontains=search)
            | models_Q(username__icontains=search)
        )

    total = users_qs.count()
    page_size = min(max(page_size, 1), 200)
    page = max(page, 1)
    offset = (page - 1) * page_size
    users = users_qs.order_by('nickname', 'username')[offset:offset + page_size]

    collaborators = [
        {
            'id': str(u.id),
            'name': u.nickname or u.username or str(u.id),
            'avatar_url': getattr(u, 'avatar', '') or '',
        }
        for u in users
    ]

    return success_response({
        'collaborators': collaborators,
        'total': total,
    })


# ==================== 关闭分享 / 轮换分享链接 ====================

@router.delete(
    "/views/{view_id}/form-share",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="关闭表单分享（软删除，标记过期）"
)
@api_error_handler
def disable_form_share(request: HttpRequest, view_id: UUID):
    """关闭表单视图的分享链接。将所有未过期的分享标记为已过期。"""
    try:
        view = TableView.objects.using(TABDATA_DB_ALIAS).select_related('table').get(id=view_id)
    except TableView.DoesNotExist:
        return not_found_response("视图")

    if view.view_type != 'form':
        return validation_error_response("只有表单视图可以操作分享链接")

    from apps.tabdata.services import TableService
    table_service = TableService(user=request.auth)
    if not table_service.check_table_permission(str(view.table_id), 'editor'):
        return error_response(ErrorCode.PERMISSION_DENIED, message="无权限操作", status_code=403)

    updated = TableShare.objects.using(TABDATA_DB_ALIAS).filter(
        view=view,
        table=view.table,
    ).filter(
        models_Q(expire_at__isnull=True) | models_Q(expire_at__gt=timezone.now())
    ).update(expire_at=timezone.now())

    return success_response({
        'disabled_count': updated,
        'message': '分享已关闭' if updated > 0 else '没有活跃的分享链接',
    })


@router.post(
    "/views/{view_id}/form-share/refresh",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=jwt_auth,
    summary="轮换表单分享链接（生成新 share_id）"
)
@api_error_handler
def refresh_form_share(request: HttpRequest, view_id: UUID):
    """重新生成表单视图的分享链接。旧链接标记过期，创建新分享（继承密码）。"""
    try:
        view = TableView.objects.using(TABDATA_DB_ALIAS).select_related('table').get(id=view_id)
    except TableView.DoesNotExist:
        return not_found_response("视图")

    if view.view_type != 'form':
        return validation_error_response("只有表单视图可以操作分享链接")

    from apps.tabdata.services import TableService
    table_service = TableService(user=request.auth)
    if not table_service.check_table_permission(str(view.table_id), 'editor'):
        return error_response(ErrorCode.PERMISSION_DENIED, message="无权限操作", status_code=403)

    from django.db import connections
    with connections[TABDATA_DB_ALIAS].cursor() as _:
        pass  # ensure connection
    from django.db import transaction
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        active_shares = TableShare.objects.using(TABDATA_DB_ALIAS).filter(
            view=view,
            table=view.table,
        ).filter(
            models_Q(expire_at__isnull=True) | models_Q(expire_at__gt=timezone.now())
        ).select_for_update()

        # 轮换分享链接时把旧分享的 hash 串原样搬到新分享 —— hash 本身是确定字符串，
        # check_password 仍能 verify 用户输入的原始密码。新分享走 password_hash 字段。
        inherited_hash = ''
        for s in active_shares:
            if s.password_hash:
                inherited_hash = s.password_hash
                break

        active_shares.update(expire_at=timezone.now())

        new_share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=view.table,
            view=view,
            share_id=_generate_share_id(),
            permission='edit',
            password_hash=inherited_hash,
            created_by=request.auth,
        )

    fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table=view.table, is_deleted=False,
    ).order_by('order'))

    return success_response({
        'share': {
            'id': str(new_share.id),
            'share_id': new_share.share_id,
            'has_password': new_share.has_password,
            'expire_at': None,
        },
        'form_meta': _serialize_form_meta(new_share, fields, view),
    })

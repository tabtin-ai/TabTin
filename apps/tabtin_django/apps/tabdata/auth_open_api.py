"""
Open API Token 认证

兼容 JWT 和 API Token 的统一认证器，用于 Open API 路由。
- Bearer ttn_xxx → API Token 认证
- Bearer eyJxxx → JWT 认证（现有逻辑）
"""

import logging
import hashlib
import json
import re
import time
from functools import wraps
from typing import Optional

from django.http import HttpRequest
from ninja.security import HttpBearer

from apps.tabtinspace.services.base import ROLE_LEVELS as _ROLE_HIERARCHY
from apps.users.auth.utils import verify_jwt_token
from django.contrib.auth import get_user_model

from apps.tabdata.error_codes import ErrorCode, get_error_response

User = get_user_model()
logger = logging.getLogger(__name__)

# Token 前缀
TOKEN_PREFIX = 'ttn_'


class OpenApiAuth(HttpBearer):
    """
    兼容 JWT 和 API Token 的认证器。

    用法：
        @router.get("/xxx", auth=open_api_auth)
        def my_endpoint(request):
            user = request.auth          # User 实例
            token = getattr(request, 'api_token', None)  # TableApiToken 或 None
    """

    def authenticate(self, request: HttpRequest, token: str) -> Optional[User]:
        if not token:
            return None

        # API Token
        if token.startswith(TOKEN_PREFIX):
            return self._authenticate_api_token(request, token)

        # JWT (fallback)
        return self._authenticate_jwt(request, token)

    def _authenticate_api_token(self, request: HttpRequest, raw_token: str) -> Optional[User]:
        """API Token 认证"""
        from apps.tabdata.models_token import TableApiToken

        result = TableApiToken.verify_token(raw_token)
        if result is None:
            return None

        token_instance, user = result

        # 将 token 实例挂到 request 上，供后续权限检查使用
        request.api_token = token_instance

        # 日志中间件所需属性
        request._api_token_id = token_instance.token_id
        request._api_auth_type = 'token'
        request._api_user_id = str(token_instance.user_id)

        # 提取 organization_id / space_id 供日志中间件使用
        organization_id, space_id = self._extract_context_ids(request, token_instance)
        request._api_organization_id = organization_id
        request._api_space_id = space_id

        return user

    def _authenticate_jwt(self, request: HttpRequest, token: str) -> Optional[User]:
        """JWT 认证（复用现有逻辑，含 session 绑定校验 — DS-006）"""
        from apps.users.auth.session_manager import SessionManager

        payload = verify_jwt_token(token)
        if not payload:
            return None

        token_type = payload.get('token_type')

        if token_type == 'daemon':
            return self._authenticate_daemon_token(request, payload)

        if token_type != 'access':
            return None

        # DS-006: JTI 吊销检查（与 JWTAuth 对齐）
        jti = payload.get('jti')
        if jti:
            from apps.tabtinspace.services.daemon_token_service import is_daemon_token_revoked
            if is_daemon_token_revoked(jti):
                return None

        # DS-006: session 绑定校验（与 JWTAuth 对齐）
        session_key = payload.get('sid')
        if not session_key:
            return None

        user_id = payload.get('user_id')
        if not user_id:
            return None

        try:
            user = User.objects.get(id=user_id, is_active=True)
        except User.DoesNotExist:
            return None

        session = SessionManager.validate_session(session_key)
        if not session or str(session.user_id) != str(user.id):
            return None

        request.api_token = None

        # 日志中间件所需属性
        request._api_token_id = ''
        request._api_auth_type = 'jwt'
        request._api_user_id = str(user.id)

        # 提取 organization_id / space_id 供日志中间件使用
        organization_id, space_id = self._extract_context_ids(request, None)
        request._api_organization_id = organization_id
        request._api_space_id = space_id

        return user

    def _authenticate_daemon_token(self, request: HttpRequest, payload: dict) -> Optional[User]:
        """Daemon token authentication for Open API endpoints.

        Daemon tokens carry the owning user's identity, validated via
        JTI revocation check + device_id claim.
        """
        from apps.tabtinspace.services.daemon_token_service import is_daemon_token_revoked

        jti = payload.get('jti')
        if not jti:
            return None

        if is_daemon_token_revoked(jti):
            return None

        if not payload.get('device_id'):
            return None
        from apps.tabtinspace.services.device_control_guard import is_device_blocked
        if is_device_blocked(payload.get('device_id')):
            return None

        user_id = payload.get('user_id')
        if not user_id:
            return None

        try:
            user = User.objects.get(id=user_id, is_active=True)
        except User.DoesNotExist:
            return None

        request.api_token = None
        request.daemon_device_id = payload.get('device_id')
        request._api_token_id = ''
        request._api_auth_type = 'daemon'
        request._api_user_id = str(user.id)

        organization_id, space_id = self._extract_context_ids(request, None)
        request._api_organization_id = organization_id
        request._api_space_id = space_id

        return user

    @staticmethod
    def _extract_context_ids(request: HttpRequest, token_instance) -> tuple:
        """
        Extract organization_id and space_id from query params or URL path.

        Lookup priority:
        1. Query params: organization_id / space_id
        2. URL path segments: /organizations/{id}/ and /spaces/{id}/
        3. Token's first space from space_ids → resolve organization via Space model

        Returns:
            (organization_id: str, space_id: str) — empty strings when not found.
        """
        organization_id = ''
        space_id = ''

        # 1. Query params
        organization_id = request.GET.get('organization_id', '') or ''
        space_id = request.GET.get('space_id', '') or ''

        # 2. URL path extraction
        if not organization_id:
            m = re.search(r'/organizations/([^/]+)', request.path)
            if m:
                organization_id = m.group(1)

        if not space_id:
            m = re.search(r'/spaces/([^/]+)', request.path)
            if m:
                space_id = m.group(1)

        # 3. Resolve organization_id from space_id via Space model
        if space_id and not organization_id:
            try:
                from apps.tabtinspace.services.host_resolver import host_organization_id
                org_id = host_organization_id(space_id)
                if org_id:
                    organization_id = str(org_id)
            except Exception:
                pass

        # 4. Fallback: resolve organization from token's space_ids
        if not organization_id and token_instance:
            space_ids = getattr(token_instance, 'space_ids', None)
            if space_ids and len(space_ids) > 0:
                try:
                    from apps.tabtinspace.services.host_resolver import host_organization_id
                    org_id = host_organization_id(space_ids[0])
                    if org_id:
                        organization_id = str(org_id)
                except Exception:
                    pass

        return organization_id, space_id


# 全局单例
open_api_auth = OpenApiAuth()


# ── 限流配置 ──
# [QTA-26] 限流架构说明：
# 本文件实现的是 **唯一生效的** Open API 限流机制：
#   - 维度：次/分钟（滑动窗口）
#   - API Token 用户：使用 ApiToken.rate_limit 字段值（默认 60 次/分钟）
#   - JWT 用户：使用下方 JWT_DEFAULT_RATE_LIMIT（120 次/分钟）
#   - 后端：Redis 滑动窗口，Redis 不可用时退化到进程内计数器
#
# MembershipTier.max_api_calls_per_day 是另一套字段，但该字段为 Legacy 死配额
# (D5/QTA-12)，全局无任何调用点执行日级限制。前端/文档不应引用该字段做套餐差异展示。
JWT_DEFAULT_RATE_LIMIT = 120  # JWT 用户默认限流：120 次/分钟
RATE_LIMIT_WINDOW = 60  # 滑动窗口大小（秒）

# ── 进程内降级限流（Redis 不可用时兜底） ──
import threading
from collections import defaultdict

_fallback_lock = threading.Lock()
_fallback_counters: dict = defaultdict(list)  # key -> [timestamp, ...]


def _build_open_api_error(code: str, message: str, **extra) -> dict:
    """
    统一 Open API 错误响应形状。

    `code` 是规范字段，`error_code` 作为兼容别名保留，
    方便已有客户端平滑过渡。
    """
    payload = get_error_response(code, message)
    payload['error_code'] = code
    payload.update(extra)
    return payload


def _inject_rate_limit_headers(response, rate_info: dict):
    """将限流信息注入到 HTTP 响应头中。"""
    if not rate_info:
        return
    response['X-RateLimit-Limit'] = str(rate_info.get('limit', 0))
    response['X-RateLimit-Remaining'] = str(rate_info.get('remaining', 0))
    response['X-RateLimit-Reset'] = str(rate_info.get('reset', 0))


def _check_rate_limit(request: HttpRequest) -> tuple:
    """
    基于 Redis 滑动窗口的限流检查（次/分钟维度）。

    返回 (error_or_none, rate_info_dict)。
    rate_info_dict 始终填充，包含 limit / remaining / reset，
    可用于注入 X-RateLimit-* 响应头。

    P1-13 (QTA-25): 导出配额已通过 check_export_quota 装饰器实现日次数限制。
    """
    api_token = getattr(request, 'api_token', None)

    if api_token:
        limit = api_token.rate_limit or 60
        key = f'openapi_rl:token:{api_token.id}'
    else:
        user = request.auth
        limit = JWT_DEFAULT_RATE_LIMIT
        key = f'openapi_rl:user:{user.id}'

    fallback_info = {'limit': limit, 'remaining': limit, 'reset': 0}

    try:
        from django.core.cache import cache

        now = time.time()

        count_key = f'{key}:count'
        reset_key = f'{key}:reset'

        # 原子递增：先 INCR 再判断，避免 GET→判断→INCR 竞态
        is_new_window = cache.add(count_key, 0, RATE_LIMIT_WINDOW)
        if is_new_window:
            cache.set(reset_key, int(now + RATE_LIMIT_WINDOW), RATE_LIMIT_WINDOW)

        try:
            current_count = cache.incr(count_key)
        except ValueError:
            cache.set(count_key, 1, RATE_LIMIT_WINDOW)
            cache.set(reset_key, int(now + RATE_LIMIT_WINDOW), RATE_LIMIT_WINDOW)
            current_count = 1

        reset_time = cache.get(reset_key) or int(now + RATE_LIMIT_WINDOW)

        if current_count > limit:
            rate_info = {'limit': limit, 'remaining': 0, 'reset': int(reset_time)}
            error = _build_open_api_error(
                ErrorCode.RATE_LIMIT_EXCEEDED,
                f'请求频率超限（{limit} 次/分钟），请稍后重试',
                retry_after=max(0, int(reset_time) - int(now)),
                limit=limit,
                window_seconds=RATE_LIMIT_WINDOW,
            )
            return error, rate_info

        remaining = max(0, limit - current_count)
        rate_info = {'limit': limit, 'remaining': remaining, 'reset': int(reset_time)}
        return None, rate_info

    except Exception as e:
        logger.warning('Redis 限流异常，降级到进程内计数器: %s', e)
        return _check_rate_limit_fallback(key, limit)


def _check_rate_limit_fallback(key: str, limit: int) -> tuple:
    """
    进程内滑动窗口限流（Redis 不可用时的降级方案）。

    使用 list 记录请求时间戳，清理过期条目后判断是否超限。
    多 Worker 部署时各进程独立计数，等效限流阈值 = limit × worker 数。
    """
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW

    with _fallback_lock:
        timestamps = _fallback_counters[key]
        # 清理窗口外的旧条目
        _fallback_counters[key] = [ts for ts in timestamps if ts > window_start]
        timestamps = _fallback_counters[key]

        if len(timestamps) >= limit:
            rate_info = {'limit': limit, 'remaining': 0, 'reset': int(now + RATE_LIMIT_WINDOW)}
            error = _build_open_api_error(
                ErrorCode.RATE_LIMIT_EXCEEDED,
                f'请求频率超限（{limit} 次/分钟），请稍后重试',
                retry_after=RATE_LIMIT_WINDOW,
                limit=limit,
                window_seconds=RATE_LIMIT_WINDOW,
            )
            return error, rate_info

        timestamps.append(now)
        remaining = max(0, limit - len(timestamps))
        rate_info = {'limit': limit, 'remaining': remaining, 'reset': int(now + RATE_LIMIT_WINDOW)}
        return None, rate_info


# ── JWT 用户 scope 映射 ──

_ROLE_SCOPE_MAP = {
    'owner': 'full',
    'admin': 'full',
    'editor': 'readwrite',
    'viewer': 'readonly',
}


def _resolve_jwt_user_scopes(request, *, override_space_id: str = '') -> set:
    """
    为 JWT 用户派生 Open API scope 集合。

    根据用户在目标 organization/space 中的角色映射到 scope 预设：
    - owner/admin → full
    - editor → readwrite
    - viewer → readonly
    - 无法确定时 → readonly（fail-secure）

    [DE-19] 当 space 上下文可用时，取 organization 角色与 space 角色中
    更低的一方作为有效角色，防止 organization admin 在仅有 viewer
    space 成员身份时获得超出 space 角色的 scope。

    override_space_id: 由 require_space_access / require_table_access 传入，
    优先于 URL 中提取的 _api_space_id，并强制绕过缓存以收窄 scope。
    """
    if not override_space_id:
        cached = getattr(request, '_jwt_effective_scopes', None)
        if cached is not None:
            return cached

    from apps.tabdata.models_token import SCOPE_PRESETS

    default_scopes = set(SCOPE_PRESETS.get('readonly', []))
    user = request.auth
    if not user:
        request._jwt_effective_scopes = default_scopes
        return default_scopes

    organization_id = getattr(request, '_api_organization_id', '') or ''
    space_id = override_space_id or getattr(request, '_api_space_id', '') or ''

    if not organization_id and not space_id:
        request._jwt_effective_scopes = default_scopes
        return default_scopes

    try:
        role = None

        if space_id and not organization_id:
            try:
                from apps.tabtinspace.services.host_resolver import host_organization_id
                org_id = host_organization_id(space_id)
                if org_id:
                    organization_id = str(org_id)
            except Exception:
                pass

        if organization_id:
            from apps.tabtinspace.models import Organization, OrganizationMember
            try:
                ws = Organization.objects.only('owner_id').get(id=organization_id)
                if str(ws.owner_id) == str(user.id):
                    role = 'owner'
            except Organization.DoesNotExist:
                pass

            if role is None:
                member_role = OrganizationMember.objects.filter(
                    organization_id=organization_id, user_id=user.id,
                ).values_list('role', flat=True).first()
                if member_role:
                    role = member_role

        # [DE-19] Space 级别角色收窄：取 organization 与 host 角色中较低者
        if space_id and role:
            from apps.tabtinspace.services.membership_utils import get_host_member_role

            space_role = get_host_member_role(space_id, user.id)

            if space_role:
                ws_level = _ROLE_HIERARCHY.get(role, 0)
                sp_level = _ROLE_HIERARCHY.get(space_role, 0)
                if sp_level < ws_level:
                    role = space_role

        preset_key = _ROLE_SCOPE_MAP.get(role, 'readonly') if role else 'readonly'
        result = set(SCOPE_PRESETS.get(preset_key, []))
    except Exception as e:
        logger.warning('JWT scope 解析失败，降级为 readonly: %s', e)
        result = default_scopes

    # override_space_id 路径不覆写通用缓存，避免污染后续非 space 上下文的调用
    if not override_space_id:
        request._jwt_effective_scopes = result
    return result


def require_scope(*scopes: str):
    """
    装饰器：要求请求具有指定 scope，并执行限流检查。

    - API Token：检查 token.scopes 是否包含所需权限
    - JWT 用户：根据 organization 角色派生 scope 集合
      (owner/admin→full, editor→readwrite, viewer→readonly)

    支持同步和异步视图函数。

    用法：
        @router.get("/xxx", auth=open_api_auth)
        @require_scope('record:read')
        def my_endpoint(request):
            ...
    """
    def _check_scope_and_rate(request):
        rate_limit_error, rate_info = _check_rate_limit(request)
        request._rate_limit_info = rate_info

        if rate_limit_error:
            from django.http import JsonResponse
            response = JsonResponse(rate_limit_error, status=429)
            if 'retry_after' in rate_limit_error:
                response['Retry-After'] = str(rate_limit_error['retry_after'])
            _inject_rate_limit_headers(response, rate_info)
            return response

        # [DE-19] 记录本次检查的 scope，供 require_space_access / require_table_access 交叉验证
        if not hasattr(request, '_required_api_scopes'):
            request._required_api_scopes = set()
        request._required_api_scopes.update(scopes)

        api_token = getattr(request, 'api_token', None)
        if api_token is not None:
            if not api_token.has_any_scope(list(scopes)):
                return 403, _build_open_api_error(
                    'INSUFFICIENT_SCOPE',
                    f'Token 缺少所需权限: {", ".join(scopes)}',
                    required_scopes=list(scopes),
                )
        else:
            jwt_scopes = _resolve_jwt_user_scopes(request)
            if not any(s in jwt_scopes for s in scopes):
                return 403, _build_open_api_error(
                    'INSUFFICIENT_SCOPE',
                    f'当前用户角色权限不足: {", ".join(scopes)}',
                    required_scopes=list(scopes),
                )
        return None

    def decorator(func):
        import inspect

        if inspect.iscoroutinefunction(func):
            @wraps(func)
            async def async_wrapper(request, *args, **kwargs):
                denied = _check_scope_and_rate(request)
                if denied is not None:
                    return denied
                return await func(request, *args, **kwargs)
            return async_wrapper

        @wraps(func)
        def wrapper(request, *args, **kwargs):
            denied = _check_scope_and_rate(request)
            if denied is not None:
                return denied
            return func(request, *args, **kwargs)
        return wrapper

    return decorator


_EXPORT_QUOTA_DEFAULT = 10
_EXPORT_QUOTA_PAID = 100
_EXPORT_QUOTA_WINDOW = 86400


_export_fallback_lock = threading.Lock()
_export_fallback_counters: dict = defaultdict(list)


def _check_export_quota_fallback(quota_key: str, daily_limit: int) -> bool:
    """进程内滑动窗口降级（Redis 不可用时）。返回 True 表示超限。"""
    now = time.time()
    window_start = now - _EXPORT_QUOTA_WINDOW
    with _export_fallback_lock:
        timestamps = _export_fallback_counters[quota_key]
        _export_fallback_counters[quota_key] = [ts for ts in timestamps if ts > window_start]
        timestamps = _export_fallback_counters[quota_key]
        if len(timestamps) >= daily_limit:
            return True
        timestamps.append(now)
        return False


def check_export_quota(func):
    """装饰器：校验 Open API 导出配额（日次数限制）。

    基于 API Token rate_limit 或 organization 计费权益推导日导出上限，
    使用 Redis 计数器跟踪。超限返回 429。
    Redis 故障时降级到进程内计数器（fail-closed）。
    """
    @wraps(func)
    def wrapper(request, *args, **kwargs):
        daily_limit, quota_key = _resolve_export_quota(request)
        if daily_limit <= 0:
            return func(request, *args, **kwargs)
        try:
            from django.core.cache import cache
            count_key = f'openapi_export_quota:{quota_key}'
            cache.add(count_key, 0, _EXPORT_QUOTA_WINDOW)
            try:
                current = cache.incr(count_key)
            except ValueError:
                cache.set(count_key, 1, _EXPORT_QUOTA_WINDOW)
                current = 1
            if current > daily_limit:
                return 429, _build_open_api_error(
                    'EXPORT_QUOTA_EXCEEDED',
                    f'每日导出配额已用尽（限制 {daily_limit} 次/天）',
                    limit=daily_limit,
                    used=current,
                )
        except Exception as exc:
            logger.warning('导出配额 Redis 异常，降级到进程内计数器: %s', exc)
            if _check_export_quota_fallback(quota_key, daily_limit):
                return 429, _build_open_api_error(
                    'EXPORT_QUOTA_EXCEEDED',
                    f'每日导出配额已用尽（限制 {daily_limit} 次/天）',
                    limit=daily_limit,
                )
        return func(request, *args, **kwargs)
    return wrapper


def _resolve_export_quota(request) -> tuple:
    """返回 (daily_limit, quota_key)。

    API Token: 高 rate_limit (>60) 视为付费用户，提升配额。
    JWT: 查询 organization 计费权益决定配额。
    """
    api_token = getattr(request, 'api_token', None)
    if api_token:
        limit = _EXPORT_QUOTA_PAID if (api_token.rate_limit or 60) > 60 else _EXPORT_QUOTA_DEFAULT
        space_id = getattr(api_token, 'space_id', None)
        if space_id:
            wt_limit = _organization_export_limit_from_space(str(space_id))
            if wt_limit is not None:
                limit = wt_limit
        return limit, f'token:{api_token.id}'
    user = getattr(request, 'auth', None)
    if user:
        if getattr(user, 'is_superuser', False):
            return -1, f'user:{user.id}'
        return _EXPORT_QUOTA_DEFAULT, f'user:{user.id}'
    return _EXPORT_QUOTA_DEFAULT, 'anon'


def _organization_export_limit_from_space(space_id: str) -> int | None:
    """通过 Space → Organization → BillingEntitlement 推导配额。"""
    try:
        from apps.tabtinspace.services.host_resolver import host_organization_id
        wt_id = host_organization_id(space_id)
        if not wt_id:
            return None
        from apps.services.billing.models import OrganizationBillingEntitlement
        ent = OrganizationBillingEntitlement.objects.filter(organization_id=str(wt_id)).first()
        if ent and (ent.included_storage_bytes > 0 or ent.purchased_storage_bytes > 0):
            return _EXPORT_QUOTA_PAID
    except Exception:
        pass
    return None


def require_space_access(_func=None, *, required_role: str = 'viewer'):
    """
    装饰器：检查当前用户是否可访问指定 Space。

    对所有用户（JWT 和 API Token）都执行 Space 访问校验：
    - JWT 用户：走统一的 Space 权限服务（支持 user membership + agent membership）
    - API Token：额外校验 token 的 space_ids 范围
    """
    def decorator(func):
        @wraps(func)
        def wrapper(request, *args, **kwargs):
            from apps.tabtinspace.models import Space
            from apps.tabtinspace.services.base import BaseService

            space_id = kwargs.get('space_id')
            if not space_id:
                return 400, _build_open_api_error(
                    'MISSING_PARAMETER',
                    'space_id 参数缺失，无法执行 Space 访问校验',
                )

            user = request.auth
            try:
                from apps.tabtinspace.services.host_resolver import host_exists
                space_exists = host_exists(space_id)
                has_permission = (
                    space_exists
                    and BaseService(user=user).check_space_permission(str(space_id), required_role)
                )
                if not has_permission:
                    return 403, _build_open_api_error(
                        'SPACE_ACCESS_DENIED',
                        '无权访问该 Space 或 Space 不存在',
                        required_role=required_role,
                    )
            except Exception:
                return 403, _build_open_api_error(
                    'SPACE_ACCESS_DENIED',
                    '无权访问该 Space 或 Space 不存在',
                    required_role=required_role,
                )

            api_token = getattr(request, 'api_token', None)
            if api_token is not None:
                if not api_token.can_access_space(str(space_id)):
                    return 403, _build_open_api_error(
                        'SPACE_ACCESS_DENIED',
                        f'Token 无权访问 Space {space_id}',
                        space_id=str(space_id),
                    )
            else:
                # [DE-19] JWT 用户：基于 space 级别角色收窄 scope 并交叉验证
                space_scopes = _resolve_jwt_user_scopes(
                    request, override_space_id=str(space_id),
                )
                previously_required = getattr(request, '_required_api_scopes', None)
                if previously_required and not any(s in space_scopes for s in previously_required):
                    return 403, _build_open_api_error(
                        'INSUFFICIENT_SCOPE',
                        f'当前角色在 Space {space_id} 中权限不足',
                        space_id=str(space_id),
                        required_scopes=list(previously_required),
                    )

            return func(request, *args, **kwargs)

        return wrapper

    if _func is None:
        return decorator
    return decorator(_func)


def require_organization_access(_func=None, *, required_role: str = 'viewer'):
    """
    装饰器：检查当前用户是否可访问指定 Organization（ Open API org 入口）。

    - JWT / API Token 用户：走组织权限（BaseService.check_organization_permission）
    - API Token 若声明了 space_ids：额外校验这些 Space 均属于该 Organization
      （防止跨组织放大）；space_ids 为 None 表示不限制 Space，仅看组织权限
    """
    def decorator(func):
        @wraps(func)
        def wrapper(request, *args, **kwargs):
            from apps.tabdata.services.base import BaseService as TabDataBaseService
            from apps.tabtinspace.services.host_resolver import host_organization_id

            organization_id = kwargs.get('organization_id')
            if not organization_id:
                return 400, _build_open_api_error(
                    'MISSING_PARAMETER',
                    'organization_id 参数缺失，无法执行组织访问校验',
                )

            user = request.auth
            try:
                has_permission = TabDataBaseService(user=user).check_organization_permission(
                    str(organization_id), required_role,
                )
                if not has_permission:
                    return 403, _build_open_api_error(
                        'ORGANIZATION_ACCESS_DENIED',
                        '无权访问该 Organization 或 Organization 不存在',
                        required_role=required_role,
                    )
            except Exception:
                return 403, _build_open_api_error(
                    'ORGANIZATION_ACCESS_DENIED',
                    '无权访问该 Organization 或 Organization 不存在',
                    required_role=required_role,
                )

            api_token = getattr(request, 'api_token', None)
            if api_token is not None and api_token.space_ids is not None:
                org_id_str = str(organization_id)
                for sid in api_token.space_ids:
                    try:
                        resolved = host_organization_id(sid)
                    except Exception:
                        resolved = None
                    if resolved is None or str(resolved) != org_id_str:
                        return 403, _build_open_api_error(
                            'ORGANIZATION_ACCESS_DENIED',
                            f'Token 的 Space 范围未覆盖 Organization {organization_id}',
                            organization_id=org_id_str,
                        )

            return func(request, *args, **kwargs)

        return wrapper

    if _func is None:
        return decorator
    return decorator(_func)


def require_table_access(_func=None, *, required_role: str = 'viewer'):
    """
    装饰器：检查指定 table_id 的访问权限。
    要求路由参数中有 table_id。
    """
    def decorator(func):
        @wraps(func)
        def wrapper(request, *args, **kwargs):
            api_token = getattr(request, 'api_token', None)
            table_id = kwargs.get('table_id')
            if not table_id:
                return 400, _build_open_api_error(
                    'MISSING_PARAMETER',
                    'table_id 参数缺失，无法执行表格访问校验',
                )

            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.models import Table
            from apps.tabdata.services.base import BaseService as TabDataBaseService

            table = (
                Table.objects.using(TABDATA_DB_ALIAS)
                .filter(id=table_id)
                .only('id', 'space_id', 'organization_id')
                .first()
            )
            if table is None:
                return 404, _build_open_api_error(
                    'TABLE_NOT_FOUND',
                    f'表格不存在: {table_id}',
                    table_id=str(table_id),
                )

            service = TabDataBaseService(user=request.auth)
            if table.space_id:
                has_permission = service.check_space_permission(
                    str(table.space_id),
                    required_role,
                )
            else:
                has_permission = service.check_organization_permission(
                    str(table.organization_id),
                    required_role,
                )

            if not has_permission:
                return 403, _build_open_api_error(
                    'TABLE_ACCESS_DENIED',
                    f'无权以 {required_role} 权限访问表格 {table_id}',
                    table_id=str(table_id),
                    required_role=required_role,
                )

            if api_token is not None:
                space_id = str(table.space_id) if table and table.space_id else None
                if not api_token.can_access_table(str(table_id), space_id=space_id):
                    return 403, _build_open_api_error(
                        'TABLE_ACCESS_DENIED',
                        f'Token 无权访问表格 {table_id}',
                        table_id=str(table_id),
                    )
            else:
                # [DE-19] JWT 用户：基于 table 所属 space 角色收窄 scope 并交叉验证
                table_space_id = str(table.space_id) if table.space_id else None
                if table_space_id:
                    space_scopes = _resolve_jwt_user_scopes(
                        request, override_space_id=table_space_id,
                    )
                    previously_required = getattr(request, '_required_api_scopes', None)
                    if previously_required and not any(s in space_scopes for s in previously_required):
                        return 403, _build_open_api_error(
                            'INSUFFICIENT_SCOPE',
                            f'当前角色在表格 {table_id} 所属 Space 中权限不足',
                            table_id=str(table_id),
                            required_scopes=list(previously_required),
                        )

            return func(request, *args, **kwargs)

        return wrapper

    if _func is None:
        return decorator
    return decorator(_func)


def check_agent_space_constraint(
    api_token_space_ids: list,
    target_space_id: str,
) -> Optional[str]:
    """
    校验目标 space_id 是否在 API Token 的 space_ids 授权范围内。

    供 Agent 工具执行层调用（AC-009），弥补 HTTP 装饰器 (require_space_access)
    不覆盖 Agent 工具调用链路的缺口。

    Returns:
        None 表示允许；字符串表示拒绝原因。
    """
    if not api_token_space_ids:
        return None
    if not target_space_id:
        return None
    normalized = [str(sid) for sid in api_token_space_ids]
    if str(target_space_id) in normalized:
        return None
    return (
        f"API Token 无权访问 Space {target_space_id}，"
        f"Token 授权范围: {', '.join(normalized)}"
    )


def validate_space_access_for_agent(
    user_id: str,
    space_id: str,
    api_token_space_ids: Optional[list] = None,
) -> Optional[str]:
    """
    验证用户对指定 Space 的访问权限（非 HTTP 上下文）。

    将 require_space_access 装饰器的核心逻辑提取为独立函数，
    供 Agent 工具执行层在非 HTTP 请求路径中复用（AC-009）。

    Returns:
        None 表示允许；字符串表示拒绝原因。
    """
    if not user_id or not space_id:
        return None

    if api_token_space_ids is not None:
        token_denied = check_agent_space_constraint(
            api_token_space_ids, space_id,
        )
        if token_denied:
            return token_denied

    try:
        from apps.tabtinspace.services.base import BaseService
        user_obj = User.objects.filter(id=user_id, is_active=True).first()
        if not user_obj:
            return f"用户不存在或已禁用: {user_id}"
        if not BaseService(user=user_obj).check_space_permission(
            str(space_id), 'viewer',
        ):
            return f"用户 {user_id} 无权访问 Space {space_id}"
    except Exception as exc:
        logger.warning(
            "[auth_open_api] validate_space_access_for_agent failed: %s", exc,
        )
        return f"Space 访问权限校验异常: {exc}"
    return None


def idempotent(func):
    """
    装饰器：幂等性保证。

    如果请求携带 Idempotency-Key header，服务端用 Redis 缓存 key→response，
    TTL 24 小时，相同 key 的重复请求直接返回缓存结果。

    用法：
        @router.post("/xxx", auth=open_api_auth)
        @idempotent
        def my_endpoint(request, ...):
            ...
    """
    IDEMPOTENCY_TTL = 86400  # 24 小时

    def _normalize_value(value):
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, dict):
            return {
                str(k): _normalize_value(v)
                for k, v in sorted(value.items(), key=lambda item: str(item[0]))
            }
        if isinstance(value, (list, tuple, set)):
            return [_normalize_value(v) for v in value]
        if hasattr(value, 'model_dump'):
            return _normalize_value(value.model_dump())
        if hasattr(value, 'dict'):
            return _normalize_value(value.dict())
        return str(value)

    @wraps(func)
    def wrapper(request, *args, **kwargs):
        idem_key = request.headers.get('Idempotency-Key') or request.headers.get('idempotency-key')
        if not idem_key:
            # 无 key → 正常执行
            return func(request, *args, **kwargs)

        from django.core.cache import cache
        from django.http import JsonResponse as _JsonResponse

        api_token = getattr(request, 'api_token', None)
        principal = (
            f'token:{getattr(api_token, "token_id", getattr(api_token, "id", ""))}'
            if api_token
            else f'user:{getattr(getattr(request, "auth", None), "id", "")}'
        )
        signature_payload = {
            'principal': principal,
            'method': getattr(request, 'method', ''),
            'path': getattr(request, 'path', ''),
            'query': request.META.get('QUERY_STRING', ''),
            'args': _normalize_value(args),
            'kwargs': _normalize_value(kwargs),
        }
        signature = hashlib.sha256(
            json.dumps(signature_payload, sort_keys=True, ensure_ascii=True).encode('utf-8')
        ).hexdigest()
        cache_key = f'idempotency:{signature}:{idem_key}'

        # 检查缓存
        cached = cache.get(cache_key)
        if cached is not None:
            resp = _JsonResponse(
                cached['body'],
                status=cached['status'],
            )
            resp['X-Idempotent-Replayed'] = 'true'
            return resp

        # 执行原始请求
        response = func(request, *args, **kwargs)

        # 短暂失败必须允许客户端用同一个幂等键重试，不能固化成 24 小时失败。
        status_code = getattr(response, 'status_code', None)
        should_cache = (
            isinstance(status_code, int)
            and status_code < 500
            and status_code != 429
        )
        if should_cache and hasattr(response, 'content'):
            try:
                body = json.loads(response.content)
                cache.set(cache_key, {
                    'body': body,
                    'status': status_code,
                }, IDEMPOTENCY_TTL)
            except (ValueError, TypeError):
                pass  # 非 JSON 响应不缓存

        return response

    return wrapper

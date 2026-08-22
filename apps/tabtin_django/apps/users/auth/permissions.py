"""
权限控制
"""
import logging

from ninja.errors import HttpError
from ninja.security import HttpBearer
from apps.i18n import _
from django.contrib.auth import get_user_model
from django.http import HttpRequest

from .utils import verify_jwt_token, check_simple_rate_limit
from .session_manager import SessionManager

logger = logging.getLogger(__name__)

User = get_user_model()


class JWTAuth(HttpBearer):
    """JWT 认证（含 session 绑定校验 + ttn_ API Key 自动识别）。

    所有使用 JWTAuth 的路由自动支持 API Key 登录，无需逐个修改。
    """

    def authenticate(self, request: HttpRequest, token: str):
        if token.startswith('ttn_'):
            user = self._authenticate_api_key(request, token)
            if user is not None:
                self._enforce_api_key_scope(request)
                self._apply_organization_constraint(request)
            return user
        return self._authenticate_jwt(request, token)

    @staticmethod
    def _enforce_api_key_scope(request: HttpRequest):
        """P0-9: 根据请求路径和方法校验 API Key scope。"""
        from .api_key_context import resolve_required_scope

        api_key = getattr(request, 'api_key', None)
        if api_key is None:
            return
        required = resolve_required_scope(request.path, request.method)
        if required and not api_key.has_scope(required):
            logger.warning(
                "[PermissionDenied] %s",
                {"check": "api_key_scope",
                 "user_id": str(api_key.user_id),
                 "api_key_id": api_key.key_id,
                 "required_scope": required,
                 "actual_scopes": api_key.scopes,
                 "path": request.path, "method": request.method,
                 "reason": "insufficient_scope"},
            )
            from ninja.errors import HttpError
            raise HttpError(
                403,
                f"API Key scope 不足，需要 '{required}'",
            )

    @staticmethod
    def _apply_organization_constraint(request: HttpRequest):
        """P0-10: 将 API Key organization_id 写入 ContextVar 供 BaseService 读取。"""
        from .api_key_context import set_api_key_organization_constraint

        api_key = getattr(request, 'api_key', None)
        if api_key and api_key.organization_id:
            set_api_key_organization_constraint(api_key.organization_id)

    @staticmethod
    def _authenticate_api_key(request: HttpRequest, raw_key: str):
        from .models import UserApiKey
        result = UserApiKey.verify_key(raw_key)
        if result is None:
            return None
        key_instance, user = result

        rate_key = f"api_key_rate:{key_instance.key_id}"
        if not check_simple_rate_limit(rate_key, key_instance.rate_limit, 60, fail_close=True):
            from ninja.errors import HttpError as _HttpError
            raise _HttpError(429, "API Key 请求频率超限，请稍后重试")

        request.api_key = key_instance
        if key_instance.organization_id:
            request.api_key_organization_id = key_instance.organization_id
        return user

    @staticmethod
    def _authenticate_jwt(request: HttpRequest, token: str):
        payload = verify_jwt_token(token)
        if not payload:
            return None

        jti = payload.get('jti')
        if jti:
            from apps.tabtinspace.services.daemon_token_service import is_daemon_token_revoked
            if is_daemon_token_revoked(jti):
                return None

        token_type = payload.get('token_type')

        if token_type == 'daemon':
            return JWTAuth._authenticate_daemon_as_user(request, payload)

        if token_type != 'access':
            return None

        user_id = payload.get('user_id')
        if not user_id:
            return None

        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return None

        if not user.is_active:
            return None

        session_key = payload.get('sid')
        if not session_key:
            return None

        session = SessionManager.validate_session(session_key)
        if not session or str(session.user_id) != str(user.id):
            return None

        return user

    @staticmethod
    def _authenticate_daemon_as_user(request: HttpRequest, payload: dict):
        """Allow daemon tokens to access user-level APIs.

        Daemon tokens carry the owning user's identity and are subject to
        JTI revocation + device_id claim validation, providing equivalent
        security to session-bound access tokens.
        """
        if not payload.get('device_id'):
            return None
        from apps.tabtinspace.services.device_control_guard import is_device_blocked
        if is_device_blocked(payload.get('device_id')):
            return None

        user_id = payload.get('user_id')
        if not user_id:
            return None

        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return None

        if not user.is_active:
            return None

        request.daemon_device_id = payload.get('device_id')
        request.daemon_jti = payload.get('jti')
        return user


def authenticate_django_bearer_request(request: HttpRequest):
    """Authenticate a plain Django view request with the same semantics as JWTAuth.

    Some non-Ninja views still need to accept ``Authorization: Bearer`` directly.
    They must not hand-roll JWT parsing because that misses token type, session
    revocation, daemon JTI, API key scope, and organization constraints.
    """
    auth_header = request.META.get("HTTP_AUTHORIZATION", "")
    if not auth_header.startswith("Bearer "):
        return None

    token = auth_header[7:].strip()
    if not token:
        return None

    try:
        return JWTAuth().authenticate(request, token)
    except HttpError as exc:
        request.django_bearer_auth_error = exc
        logger.info(
            "[Auth] django bearer rejected by JWTAuth",
            extra={
                "path": getattr(request, "path", ""),
                "method": getattr(request, "method", ""),
                "status_code": getattr(exc, "status_code", 401),
            },
        )
        return None
    except Exception:
        logger.warning(
            "[Auth] django bearer authentication failed",
            exc_info=True,
            extra={
                "path": getattr(request, "path", ""),
                "method": getattr(request, "method", ""),
            },
        )
        return None


# 向后兼容别名
UserApiKeyAuth = JWTAuth


# ── Optional JWT 认证（public share 等「可选登录」端点）──────────────────

class _AnonymousUserMarker:
    """匿名访问标记（PRD §5 Phase 0.3）。

    django-ninja 1.5.3 的 ``auth=`` 语义是：callback 返回 truthy 即认证通过
    并把返回值赋给 ``request.auth``；返回 falsy（None / False / ""）则抛
    ``AuthenticationError`` 返 401。

    public share 等场景需要「未登录也能访问、但已登录要识别身份」语义，
    因此不能用裸 ``JWTAuth``（无 token 必抛 401），也不能用
    ``lambda r: None``（None 同样会被 ninja 视为认证失败）。

    本 sentinel 提供一个具名的「匿名通过」标识，避免使用 ``True`` /
    ``object()`` 等无意义的 truthy 值，view 层通过
    ``apps.services.common.public_share.auth.get_authenticated_user``
    把 marker 还原成 ``None`` 后再传给 service。

    设计上**禁止暴露给业务 view 直接判断** —— 一律走 helper，避免散落
    ``if request.auth is ANONYMOUS_USER_MARKER`` 的"魔法值"判断。
    """

    __slots__ = ()

    def __bool__(self):
        return True

    def __repr__(self):
        return "<ANONYMOUS_USER_MARKER>"


ANONYMOUS_USER_MARKER = _AnonymousUserMarker()


class JWTAuthOptional(JWTAuth):
    """可选 JWT 认证 —— PRD §5 Phase 0.3 / R1 决策落地。

    - 带合法 token → ``request.auth = User`` 实例（同 JWTAuth）
    - 带过期 / 非法 token → ``request.auth = ANONYMOUS_USER_MARKER``
      （**不**抛 401，符合 optional 语义；token 失效=匿名访问）
    - 不带 token → ``request.auth = ANONYMOUS_USER_MARKER``

    用法（公开端点）::

        from apps.users.auth.permissions import JWTAuthOptional
        from apps.services.common.public_share.auth import get_authenticated_user

        jwt_auth_optional = JWTAuthOptional()

        @router.get("/shared/{share_id}/content", auth=jwt_auth_optional)
        def get_shared_content(request, share_id: str):
            user = get_authenticated_user(request)  # None or User
            ...

    为什么不用 ninja 的 ``auth=[JWTAuth(), anon_callback]`` list 语法？
    实测 1.5.3 把 list 解释为「逐个尝试，首个 truthy 即接受」，需要写一个
    ``lambda r: True`` 兜底 —— 但这样 ``request.auth = True``，比 sentinel
    更不可读，且需要业务 view 散落 ``request.auth is True`` 判断；
    新写子类可以集中维护语义、配合 ``get_authenticated_user`` helper 暴露
    干净 API，长期收益更高。

    安全注意：
    - **公开数据不应**仅靠本类做访问控制 —— 后续必须再过
      ``PublicShareService.verify_share_access`` 才返回敏感内容（meta/content）。
    - **管理端点严禁使用本类** —— 必须用 ``JWTAuth``（强制登录）+
      ``PublicShareService.load_resource_for_management``（admin 校验）。
    """

    def __call__(self, request: HttpRequest):
        result = super().__call__(request)
        if result is None:
            return ANONYMOUS_USER_MARKER
        return result


def _get_usable_admin_account(user):
    from .models import AdminAccount

    return (
        AdminAccount.objects.filter(
            user=user,
            admin_login_enabled=True,
            status=AdminAccount.STATUS_ACTIVE,
        )
        .select_related("user")
        .first()
    )


def user_has_admin_staff_access(user) -> bool:
    """User.is_staff，或存在可用 AdminAccount（覆盖历史未回写脏数据）。"""
    if getattr(user, "is_staff", False):
        return True
    return _get_usable_admin_account(user) is not None


def user_has_admin_superuser_access(user) -> bool:
    """User.is_superuser，或可用 AdminAccount 绑定 active super_admin。"""
    if getattr(user, "is_superuser", False):
        return True
    account = _get_usable_admin_account(user)
    if account is None:
        return False
    return account.role_assignments.filter(
        role__code="super_admin",
        role__is_active=True,
    ).exists()


class StaffAuth(JWTAuth):
    """Admin API 认证：要求 is_staff，或可用后台账号。

    用于 Admin Router 级别 auth=StaffAuth()，统一替代各模块
    _ensure_staff_user / _ensure_staff 内联检查。
    """

    def authenticate(self, request: HttpRequest, token: str):
        user = super().authenticate(request, token)
        if user and not user_has_admin_staff_access(user):
            raise HttpError(403, _("admin.staff_only"))
        return user


class SuperuserAuth(JWTAuth):
    """Admin API 认证：要求 is_superuser，或 RBAC super_admin。

    适用于全部端点都要求超管权限的 Router。
    """

    def authenticate(self, request: HttpRequest, token: str):
        user = super().authenticate(request, token)
        if user and not user_has_admin_superuser_access(user):
            raise HttpError(403, _("admin.superadmin_only_v2"))
        return user


class AdminPermissionAuth(JWTAuth):
    """AdminDash 细粒度权限认证。

    认证链路：
    1. JWT / API Key 解析出 User。
    2. User 必须 active。
    3. 必须存在启用的 AdminAccount。
    4. Super Admin 或拥有指定 permission code 才能通过。
    """

    def __init__(self, permission_codes=None, *, require_all: bool = False):
        super().__init__()
        if permission_codes is None:
            self.permission_codes = []
        elif isinstance(permission_codes, str):
            self.permission_codes = [permission_codes]
        else:
            self.permission_codes = list(permission_codes)
        self.require_all = require_all

    def authenticate(self, request: HttpRequest, token: str):
        user = super().authenticate(request, token)
        if not user:
            return user

        account = _get_usable_admin_account(user)
        if account is None:
            raise HttpError(
                403,
                {
                    "code": "ADMIN_ACCOUNT_REQUIRED",
                    "message": "当前用户没有可用后台账号",
                    "missing_permission": self.permission_codes[0] if self.permission_codes else "",
                },
            )

        request.admin_account = account

        if getattr(user, "is_superuser", False) or account.role_assignments.filter(
            role__code="super_admin",
            role__is_active=True,
        ).exists():
            request.admin_permissions = {"*"}
            return user

        permissions = set(
            account.role_assignments.filter(role__is_active=True)
            .filter(role__permissions__is_active=True)
            .values_list("role__permissions__code", flat=True)
            .distinct()
        )
        permissions.discard(None)
        request.admin_permissions = permissions

        if not self.permission_codes:
            return user

        if self.require_all:
            allowed = all(code in permissions for code in self.permission_codes)
        else:
            allowed = any(code in permissions for code in self.permission_codes)

        if not allowed:
            missing = [
                code
                for code in self.permission_codes
                if code not in permissions
            ]
            raise HttpError(
                403,
                {
                    "code": "ADMIN_PERMISSION_DENIED",
                    "message": "缺少后台权限",
                    "missing_permission": missing[0] if missing else self.permission_codes[0],
                    "required_permissions": self.permission_codes,
                },
            )

        return user


class DaemonJWTAuth(HttpBearer):
    """Daemon 专用 JWT 认证器（CD-001/CD-004）

    接受 token_type='daemon'，跳过 session 绑定校验，
    使用 JTI 吊销状态验证 + device_id claim 校验。
    """

    def authenticate(self, request: HttpRequest, token: str):
        payload = verify_jwt_token(token)
        if not payload:
            return None

        if payload.get('token_type') != 'daemon':
            return None

        jti = payload.get('jti')
        if not jti:
            return None

        from apps.tabtinspace.services.daemon_token_service import is_daemon_token_revoked
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
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return None

        if not user.is_active:
            return None

        request.daemon_device_id = payload.get('device_id')
        request.daemon_jti = jti

        return user


class IsOwnerOrReadOnly:
    """只有所有者可以编辑，其他人只读"""

    def has_permission(self, request: HttpRequest, user, obj=None):
        """检查权限"""
        if request.method in ['GET', 'HEAD', 'OPTIONS']:
            return True

        if obj is None:
            return True

        return obj.user == user or user.is_staff


class IsVerifiedUser:
    """只有验证用户可以访问"""

    def has_permission(self, request: HttpRequest, user, obj=None):
        """检查权限"""
        return user.is_verified_email or user.is_verified_phone


class IsActiveUser:
    """只有激活用户可以访问"""

    def has_permission(self, request: HttpRequest, user, obj=None):
        """检查权限"""
        return user.is_active


class IsStaffUser:
    """只有员工可以访问"""

    def has_permission(self, request: HttpRequest, user, obj=None):
        """检查权限"""
        return user.is_staff


class IsSuperUser:
    """只有超级用户可以访问"""

    def has_permission(self, request: HttpRequest, user, obj=None):
        """检查权限"""
        return user.is_superuser


def check_user_permission(user, permission_name):
    """检查用户是否有指定权限"""
    if user.is_superuser:
        return True

    return user.has_perm(permission_name)


def check_group_permission(user, group_name):
    """检查用户是否在指定组中"""
    return user.groups.filter(name=group_name).exists()


def require_permissions(*permissions):
    """装饰器：要求用户有指定权限"""
    def decorator(func):
        def wrapper(request, *args, **kwargs):
            user = getattr(request, 'auth', None)
            if not user:
                return {"success": False, "message": _("auth.unauthenticated"), "code": 401}

            for permission in permissions:
                if not check_user_permission(user, permission):
                    return {"success": False, "message": _("auth.insufficient_permissions"), "code": 403}

            return func(request, *args, **kwargs)
        return wrapper
    return decorator


def require_groups(*groups):
    """装饰器：要求用户在指定组中"""
    def decorator(func):
        def wrapper(request, *args, **kwargs):
            user = getattr(request, 'auth', None)
            if not user:
                return {"success": False, "message": _("auth.unauthenticated"), "code": 401}

            for group in groups:
                if not check_group_permission(user, group):
                    return {"success": False, "message": _("auth.insufficient_permissions"), "code": 403}

            return func(request, *args, **kwargs)
        return wrapper
    return decorator


def require_verified_user(func):
    """装饰器：要求用户已验证"""
    def wrapper(request, *args, **kwargs):
        user = getattr(request, 'auth', None)
        if not user:
            return {"success": False, "message": _("auth.unauthenticated"), "code": 401}

        if not (user.is_verified_email or user.is_verified_phone):
            return {"success": False, "message": _("auth.verify_email_or_phone"), "code": 403}

        return func(request, *args, **kwargs)
    return wrapper


def require_staff_user(func):
    """装饰器：要求员工权限"""
    def wrapper(request, *args, **kwargs):
        user = getattr(request, 'auth', None)
        if not user:
            return {"success": False, "message": _("auth.unauthenticated"), "code": 401}

        if not user.is_staff:
            return {"success": False, "message": _("auth.staff_required"), "code": 403}

        return func(request, *args, **kwargs)
    return wrapper

"""
auth API 子模块共享的工具函数、常量和对象。

所有路由子模块（auth_routes / profile_routes / ...）从此处导入公共依赖，
避免循环导入和重复代码。
"""

import logging
import re
from datetime import timedelta
from typing import Tuple

from django.contrib.auth import authenticate, get_user_model
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone
from ninja import Router
from apps.i18n.response import success_response
from apps.i18n import _

from ..schemas import (
    UserRegisterSchema, UserLoginSchema, VerificationCodeLoginSchema, PhoneReservationSchema,
    SendVerificationCodeSchema, ForgotPasswordSchema, PasswordResetSchema,
    CurrentUserPasswordResetSchema, PasswordChangeSchema,
    UserProfileUpdateSchema, UserProfileSettingsSchema, UISettingsUpdateSchema,
    EmailVerificationSchema, PhoneVerificationSchema,
    BindEmailSendSchema, BindEmailSchema,
    UserInfoSchema, UserProfileSchema, LoginResponseSchema,
    UserSessionSchema, UserActionLogSchema, ApiResponseSchema, LoginErrorResponseSchema,
    PasswordStrengthCheckSchema, PasswordStrengthSchema, PaginatedResponseSchema,
    RefreshTokenSchema, RefreshTokenResponseSchema,
    CreateApiKeySchema, ApiKeyInfoSchema, UpdateApiKeySchema,
)
from ..utils import (
    generate_jwt_token, verify_jwt_token, get_client_ip, get_user_agent,
    parse_user_agent, mask_email, mask_phone, mask_identifier, get_password_strength_score,
    generate_password_reset_token, verify_password_reset_token,
    check_login_rate_limit, check_password_reset_rate_limit,
    check_verification_code_rate_limit,
    record_rate_limit_hit,
    is_suspicious_password_reset_activity,
    validate_password_reset_context, hash_string, log_security_event,
    check_simple_rate_limit,
)
from ..session_manager import SessionManager
from ..permissions import JWTAuth
from ..verification_manager import VerificationCodeManager
from ..validators import (
    validate_unique_email, validate_unique_phone, validate_unique_username,
    validate_user_password, validate_verification_code,
    is_phone_number, PHONE_REGEX,
)
from ..models import UserProfile, UserSession, UserActionLog, UserApiKey
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.oss.services.public_assets import (
    build_public_asset_url,
    public_asset_object_key_from_ref,
)

try:
    from apps.services.email.services.factory import get_email_service
    from apps.services.sms.services.factory import get_sms_service
except ImportError:
    get_email_service = None
    get_sms_service = None

logger = logging.getLogger(__name__)
User = get_user_model()
jwt_auth = JWTAuth()

# ── 限流常量 ──

VERIFY_SUBMIT_IP_MAX = 20
VERIFY_SUBMIT_IP_WINDOW = 900

REFRESH_TOKEN_IP_MAX = 20
REFRESH_TOKEN_IP_WINDOW = 60
REFRESH_TOKEN_SESSION_MAX = 5
REFRESH_TOKEN_SESSION_WINDOW = 60
REFRESH_GRACE_WINDOW_SECONDS = 5


# ── 公共工具函数 ──

def format_validation_error(e: ValidationError) -> str:
    """格式化ValidationError消息为友好的字符串"""
    if hasattr(e, 'messages') and e.messages:
        if isinstance(e.messages, list):
            return e.messages[0]
        return str(e.messages)
    return str(e).strip("[]'\"").replace("['", "").replace("']", "")


def _notify_logout_revocations(user_id: str) -> None:
    """RB-004: 通知 collab-live 和 Centrifugo 断开用户连接。

    在 logout / change_password / reset_password 路径中调用。
    失败不阻塞主流程（best-effort）。
    """
    try:
        from apps.collab.tasks import async_revoke_collab_access
        async_revoke_collab_access.delay(user_id, "__credential_change__")
    except Exception:
        logger.warning(
            "Failed to schedule collab revocation on credential change: user=%s",
            user_id, exc_info=True,
        )
    try:
        from apps.tabchat.centrifugo_proxy import disconnect_centrifugo_user
        disconnect_centrifugo_user(user_id)
    except Exception:
        logger.warning(
            "Failed to disconnect Centrifugo on credential change: user=%s",
            user_id, exc_info=True,
        )
    try:
        from apps.tabtinspace.models import Device
        from apps.tabtinspace.services.daemon_token_service import revoke_device_tokens
        fps = list(Device.objects.using(postgres_app_db_alias()).filter(
            user_id=user_id
        ).values_list('fingerprint', flat=True))
        for fp in fps:
            revoke_device_tokens(fp)
        if fps:
            logger.info(
                "凭据变更后吊销 %d 个设备的 daemon tokens: user=%s",
                len(fps), user_id,
            )
    except Exception:
        logger.warning(
            "Failed to revoke daemon tokens on credential change: user=%s",
            user_id, exc_info=True,
        )


def log_user_action(user, action_type, request, success=True, description="", error_message=""):
    """记录用户操作日志"""
    UserActionLog.objects.create(
        user=user,
        action_type=action_type,
        description=description,
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request),
        success=success,
        error_message=error_message,
    )


def _avatar_object_key_from_ref(avatar_ref: str) -> str | None:
    """将头像存储引用归一为 OSS object key。

    新数据保存的是 FileRecord.file_key（相对 key）；旧数据可能保存完整 OSS/CDN URL。
    外部 URL 不属于平台文件资产，保持原样返回，不参与签名。
    """
    return public_asset_object_key_from_ref(avatar_ref)


def _maybe_presign_avatar(avatar_ref: str) -> str:
    """头像按 object key 存储，输出时生成长期公共资产 URL。

    兼容旧数据：
    - 旧 OSS/CDN 完整 URL：提取 path 后拼统一公共域名
    - 外部 URL：原样返回
    """
    if not avatar_ref:
        return ""
    return build_public_asset_url(avatar_ref)


def _build_user_info(user) -> UserInfoSchema:
    """构建标准化的用户信息 Schema（登录、注册、验证码登录共享）。"""
    from apps.users.auth.models import RegistrationInviteRedemption
    from apps.users.auth.services.invite_code_service import is_invite_gate_enabled

    invite_code_required = is_invite_gate_enabled()
    invite_code_redeemed = True
    if invite_code_required:
        invite_code_redeemed = RegistrationInviteRedemption.objects.filter(user=user).exists()

    role = "admin" if user.is_superuser else "operator" if user.is_staff else "user"
    return UserInfoSchema(
        id=str(user.id),
        username=user.username or "",
        email=mask_email(user.email) if user.email else None,
        phone=mask_phone(user.phone) if user.phone else None,
        nickname=user.nickname or "",
        avatar=_maybe_presign_avatar(user.avatar),
        bio=user.bio or "",
        is_verified_email=user.is_verified_email,
        is_verified_phone=user.is_verified_phone,
        date_joined=user.date_joined,
        last_login=user.last_login,
        login_count=user.login_count,
        invite_code_required=invite_code_required,
        invite_code_redeemed=invite_code_redeemed,
        has_usable_password=user.has_usable_password(),
        is_staff=user.is_staff,
        is_superuser=user.is_superuser,
        role=role,
    )


def _create_auth_session(user, request, remember_me: bool = False, session_type: str = 'web'):
    """创建认证会话并生成 JWT Token 对。

    复用于密码登录、验证码登录、注册后自动登录，以及 CLI Device Flow 登录
    （session_type='api'，见 UserSession.SESSION_TYPE_CHOICES）。
    返回 (access_token, refresh_token, access_expire_hours)。
    """
    access_expire_hours = 24 * 7 if remember_me else 24
    refresh_expire_hours = 24 * 30 if remember_me else 24 * 7

    session = SessionManager.create_session(user, request, session_type, refresh_expire_hours)

    access_token = generate_jwt_token(
        user,
        access_expire_hours,
        token_type='access',
        session_key=session.session_key,
        remember_me=remember_me,
    )
    refresh_token = generate_jwt_token(
        user,
        refresh_expire_hours,
        token_type='refresh',
        session_key=session.session_key,
        remember_me=remember_me,
    )

    session.refresh_token_hash = hash_string(refresh_token)
    session.refresh_token_updated_at = timezone.now()
    session.save(update_fields=['refresh_token_hash', 'refresh_token_updated_at'])

    return access_token, refresh_token, access_expire_hours


def _check_verify_submit_ip_rate(ip_address: str) -> Tuple[bool, str]:
    """IP 级别验证码提交速率限制（20次/15分钟）"""
    if not ip_address:
        return True, ""
    cache_key = f"verify_submit_ip:{ip_address}"
    if not check_simple_rate_limit(cache_key, VERIFY_SUBMIT_IP_MAX, VERIFY_SUBMIT_IP_WINDOW):
        return False, _("auth.rate_limited")
    return True, ""


def _check_refresh_token_rate(ip_address: str, session_key: str = None) -> Tuple[bool, str]:
    """Refresh token 速率限制：IP 级别 20 次/分钟，session 级别 5 次/分钟"""
    if ip_address:
        cache_key = f"refresh_rate_ip:{ip_address}"
        if not check_simple_rate_limit(cache_key, REFRESH_TOKEN_IP_MAX, REFRESH_TOKEN_IP_WINDOW):
            return False, _("auth.rate_limited")

    if session_key:
        cache_key = f"refresh_rate_sess:{session_key}"
        if not check_simple_rate_limit(cache_key, REFRESH_TOKEN_SESSION_MAX, REFRESH_TOKEN_SESSION_WINDOW):
            return False, _("auth.rate_limited")

    return True, ""

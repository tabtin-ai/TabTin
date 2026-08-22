"""用户资料相关 API 路由"""
import logging
import re
import time

from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpRequest, JsonResponse
from ninja import Router, Schema
from pydantic import Field

from ._shared import (
    success_response, _,
    jwt_auth,
    UserProfileSchema,
    UserProfileUpdateSchema, UserProfileSettingsSchema, UISettingsUpdateSchema,
    ApiResponseSchema,
    _maybe_presign_avatar, log_user_action, format_validation_error,
    validate_unique_username,
    UserProfile,
    _build_user_info,
)
from ..models import RegistrationInviteRedemption
from ..schemas import RateLimitResponseSchema, RedeemInviteCodeSchema
from ..services.invite_code_service import InviteCodeValidationError, consume_after_user_created
from ..utils import check_simple_rate_limit, get_client_ip
from ..invite_gate_middleware import clear_invite_gate_cache
from ..phone import resolve_user_by_phone
from ..validators import is_phone_number

logger = logging.getLogger(__name__)

router = Router(tags=["用户管理"])

INVITE_REDEEM_HTTP_ERROR_CAPABILITY = "standard"
INVITE_REDEEM_RATE_LIMIT_SECONDS = 15 * 60


class ContactDiscoverySchema(Schema):
    phone: str = Field(..., min_length=7, max_length=20)


@router.post("/contact-discovery", response={200: ApiResponseSchema, 400: ApiResponseSchema, 404: ApiResponseSchema, 429: ApiResponseSchema}, auth=jwt_auth, tags=["用户管理"])
def discover_contact_by_phone(request: HttpRequest, data: ContactDiscoverySchema):
    """仅按完整手机号精确返回可建立外部联系关系的公开资料。"""
    phone = data.phone.strip()
    if not is_phone_number(phone):
        return 400, ApiResponseSchema(success=False, message="手机号格式无效", code="INVALID_PHONE")
    if not check_simple_rate_limit(f"contact_discovery:user:{request.auth.id}", 30, 10 * 60):
        return 429, ApiResponseSchema(success=False, message="请求过于频繁", code="RATE_LIMITED")
    user = resolve_user_by_phone(phone, active_only=True)
    if user is None:
        return 404, ApiResponseSchema(success=False, message="未找到账号", code="NOT_FOUND")
    return 200, ApiResponseSchema(
        success=True,
        message="ok",
        data={
            "user_id": str(user.id),
            "display_name": user.get_display_name(),
            "avatar_url": _maybe_presign_avatar(user.avatar),
        },
    )


@router.get("/profile", auth=jwt_auth, tags=["用户管理"])
def get_user_profile(request: HttpRequest):
    """获取用户资料"""
    user = request.auth
    return success_response(data=_build_user_info(user).model_dump())


@router.post(
    "/invite-code/redeem",
    response={200: ApiResponseSchema, 429: RateLimitResponseSchema},
    auth=jwt_auth,
    tags=["认证"],
)
def redeem_invite_code(request: HttpRequest, data: RedeemInviteCodeSchema):
    """登录后兑换邀请码，解除内测准入拦截。"""
    user = request.auth
    if RegistrationInviteRedemption.objects.filter(user=user).exists():
        return ApiResponseSchema(
            success=True,
            message="邀请码已验证",
            data={"user": _build_user_info(user).model_dump()},
            code="SUCCESS",
        )

    ip_address = get_client_ip(request)
    if not check_simple_rate_limit(f"invite_redeem:user:{user.id}", 10, 15 * 60) or (
        ip_address and not check_simple_rate_limit(f"invite_redeem:ip:{ip_address}", 60, 15 * 60)
    ):
        message = _("middleware.rate_limited")
        response = RateLimitResponseSchema(
            success=False,
            message=message,
            code="RATE_LIMITED",
            retry_after_seconds=INVITE_REDEEM_RATE_LIMIT_SECONDS,
        )
        if request.META.get("HTTP_X_TABTIN_ERROR_STATUS") == INVITE_REDEEM_HTTP_ERROR_CAPABILITY:
            http_response = JsonResponse(response.model_dump(), status=429)
            http_response["Retry-After"] = str(response.retry_after_seconds)
            return http_response
        # 已发布客户端把这个业务错误作为 200 信封解析。只有显式声明能力的新客户端
        # 才切换到标准 HTTP 状态，避免后端独立发布后破坏旧版本准入流程。
        return ApiResponseSchema(success=False, message=message, code="RATE_LIMITED")

    try:
        consume_after_user_created(
            code=data.invite_code,
            user=user,
            identifier=user.email or user.phone or str(user.id),
            request=request,
            entrypoint="post_auth_gate",
        )
    except InviteCodeValidationError as invite_error:
        return ApiResponseSchema(
            success=False,
            message=invite_error.message,
            code=invite_error.code,
        )
    except Exception:
        logger.exception("redeem invite code failed: user=%s", getattr(user, "id", ""))
        return ApiResponseSchema(
            success=False,
            message=_("common.operation_failed"),
            code="INTERNAL_ERROR",
        )

    log_user_action(user, "invite_code_redeem", request, description="兑换注册邀请码")
    clear_invite_gate_cache(user.id)
    return ApiResponseSchema(
        success=True,
        message="邀请码已验证",
        data={"user": _build_user_info(user).model_dump()},
        code="SUCCESS",
    )


def _normalize_theme_value(value) -> str:
    """统一主题值域为 system/light/dark。旧 theme 列的 ``auto`` 兼容映射为 ``system``。"""
    return 'system' if value == 'auto' else value


def _resolve_theme(profile) -> str:
    """主题收口：以 ``ui_settings.theme.value`` 为新 SSoT，回退旧 ``theme`` 列。

    设置 IA Phase 2 起，前端把主题写进 ``ui_settings`` 的 ``theme`` namespace
    （值域 system/light/dark）。此处优先读它；存量用户 ui_settings 里没有
    theme 时回退旧 ``theme`` 列，并把旧值域的 ``auto`` 映射为 ``system``。
    """
    ui = profile.ui_settings or {}
    entry = ui.get('theme')
    if isinstance(entry, dict):
        value = entry.get('value')
        if isinstance(value, str) and value:
            return _normalize_theme_value(value)
    return _normalize_theme_value(profile.theme)


@router.get("/profile/settings", auth=jwt_auth, tags=["用户管理"])
def get_user_profile_settings(request: HttpRequest):
    """获取用户设置"""
    user = request.auth
    profile, _ = UserProfile.objects.get_or_create(user=user)
    return success_response(data=UserProfileSchema(
        is_public_profile=profile.is_public_profile,
        allow_email_notifications=profile.allow_email_notifications,
        allow_sms_notifications=profile.allow_sms_notifications,
        timezone=profile.timezone,
        language=profile.language,
        theme=_resolve_theme(profile),
        homepage_template=profile.homepage_template,
        max_collections=profile.max_collections,
    ).model_dump())


@router.put("/profile", response=ApiResponseSchema, auth=jwt_auth, tags=["用户管理"])
def update_user_profile(request: HttpRequest, data: UserProfileUpdateSchema):
    """更新用户资料"""
    try:
        user = request.auth

        # 验证用户名格式和唯一性
        if data.username:
            if not re.match(r'^[a-zA-Z0-9_]+$', data.username):
                return ApiResponseSchema(
                    success=False,
                    message=_("auth.username_alphanumeric_only"),
                    code="VALIDATION_ERROR"
                )
            if data.username[0].isdigit():
                return ApiResponseSchema(
                    success=False,
                    message=_("auth.username_no_leading_digit"),
                    code="VALIDATION_ERROR"
                )
            if data.username != user.username:
                validate_unique_username(data.username, user.id)

        # User、头像 FileUsage 和 IM Outbox 必须同库原子提交：失败时不能留下
        # 「已保存但未通知」的资料版本。单库模式下它们均在 default PostgreSQL 连接上。
        with transaction.atomic():
            # 串行化同一用户的资料保存，保证 profile_revision 严格单调且不丢并发更新。
            user = user.__class__.objects.select_for_update().get(pk=user.pk)
            previous_identity = (user.nickname or "", user.username or "", user.avatar or "")
            if data.nickname is not None:
                user.nickname = data.nickname
            if data.username is not None:
                user.username = data.username
            if data.bio is not None:
                user.bio = data.bio

            # UAVTR-1 + UAVTR-2: 头像通过 file_id 关联 FileRecord，
            # 更换时先 deactivate 旧头像的 FileUsage 再注册新引用。
            if data.avatar_file_id and data.avatar_file_id.strip():
                _update_avatar_via_file_id(user, data.avatar_file_id.strip())

            identity_changed = (
                previous_identity != (user.nickname or "", user.username or "", user.avatar or "")
                # 即使同一 object key 被上传层覆盖，新的 file_id 也代表新头像内容。
                or bool(data.avatar_file_id and data.avatar_file_id.strip())
            )
            if identity_changed:
                user.profile_revision += 1
            user.save()

            if identity_changed:
                # IM 的 DM 身份只由 User profile 解释；经 Outbox 推给同会话参与者，
                # 让未打开的会话列表也能立即回灌最新资料。
                from apps.tabchat.services.profile_sync_service import publish_user_profile_updated
                publish_user_profile_updated(user)

        # 记录操作日志
        log_user_action(user, 'profile_update', request, description="更新用户资料")

        return ApiResponseSchema(
            success=True,
            message=_("auth.profile_updated")
        )

    except ValidationError as e:
        return ApiResponseSchema(
            success=False,
            message=format_validation_error(e),
            code="VALIDATION_ERROR"
        )
    except Exception:
        logger.exception("update_user_profile 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


def _update_avatar_via_file_id(user, avatar_file_id: str) -> None:
    """通过 file_id 更新用户头像，同时管理 FileUsage 生命周期。

    1. 校验 file_id 对应的 FileRecord 存在且已完成上传
    2. Deactivate 旧头像的 FileUsage（UAVTR-2）
    3. 将 FileRecord.file_key 赋值给 user.avatar，避免业务表持久化 OSS 域名
    4. 注册新的 FileUsage（UAVTR-1）
    """
    from apps.services.oss.models import FileRecord, FileUsage

    try:
        file_record = FileRecord.objects.get(id=avatar_file_id, status='completed')
    except (FileRecord.DoesNotExist, ValueError):
        raise ValidationError("头像文件不存在或尚未完成上传")

    user_id_str = str(user.id)

    # UAVTR-2: deactivate 旧头像的所有活跃 FileUsage
    old_usages = FileUsage.objects.filter(
        module='user',
        context_type='avatar',
        context_id=user_id_str,
        is_active=True,
    )
    deactivated_count = 0
    for usage in old_usages:
        try:
            usage.deactivate()
            deactivated_count += 1
        except Exception as exc:
            logger.error(
                "deactivate 旧头像 FileUsage 失败: usage=%s, err=%s",
                usage.id, exc, exc_info=True,
            )

    if deactivated_count:
        logger.info(
            "用户 %s 更换头像: deactivated %d 条旧头像 FileUsage",
            user_id_str, deactivated_count,
        )

    # UAVTR-1: 只持久化 object key。访问域名/签名由输出层统一生成，便于后续 OSS/CDN 迁移。
    user.avatar = file_record.file_key

    # UAVTR-1: 注册新的 FileUsage
    FileUsage.add_usage(
        file_record=file_record,
        user_id=user_id_str,
        module='user',
        context_type='avatar',
        context_id=user_id_str,
    )


@router.put("/profile/settings", response=ApiResponseSchema, auth=jwt_auth, tags=["用户管理"])
def update_user_profile_settings(request: HttpRequest, data: UserProfileSettingsSchema):
    """更新用户设置"""
    try:
        user = request.auth
        # 不能用 `_` 接收 created 标志：本函数末尾要调用 i18n 的 `_()` 翻译，
        # 用 `_` 会把翻译函数遮蔽成 bool 导致 `_(...)` 抛 TypeError。
        profile, created = UserProfile.objects.get_or_create(user=user)

        if data.is_public_profile is not None:
            profile.is_public_profile = data.is_public_profile
        if data.allow_email_notifications is not None:
            profile.allow_email_notifications = data.allow_email_notifications
        if data.allow_sms_notifications is not None:
            profile.allow_sms_notifications = data.allow_sms_notifications
        if data.timezone is not None:
            profile.timezone = data.timezone
        if data.language is not None:
            profile.language = data.language
        if data.theme is not None:
            profile.theme = data.theme
        if data.homepage_template is not None:
            profile.homepage_template = data.homepage_template
        if data.max_collections is not None:
            profile.max_collections = data.max_collections

        profile.save()

        # 记录操作日志
        log_user_action(user, 'profile_update', request, description="更新用户设置")

        return ApiResponseSchema(
            success=True,
            message=_("auth.settings_updated")
        )

    except Exception:
        logger.exception("update_user_profile_settings 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


# ── 审批偏好 跨设备同步 (#20) ──────────────────────────────────────

_APPROVAL_PREFS_MAX_ENTRIES = 200

_VALID_APPROVAL_KEYS = re.compile(r'^[a-zA-Z0-9_:./\-]{1,120}$')


class ApprovalPreferencesUpdateSchema(Schema):
    """PUT 请求体：待合并的审批偏好增量。"""
    preferences: dict


def _validate_preference_entry(key: str, value) -> bool:
    if not isinstance(key, str) or not _VALID_APPROVAL_KEYS.match(key):
        return False
    if not isinstance(value, dict):
        return False
    if 'approved' not in value or not isinstance(value['approved'], bool):
        return False
    if 'updatedAt' in value and not isinstance(value['updatedAt'], (int, float)):
        return False
    return True


@router.get("/profile/approval-preferences", auth=jwt_auth, tags=["审批偏好"])
def get_approval_preferences(request: HttpRequest):
    """获取当前用户的审批偏好（跨设备同步）。"""
    user = request.auth
    profile, _ = UserProfile.objects.get_or_create(user=user)
    return success_response(data=profile.approval_preferences or {})


@router.put("/profile/approval-preferences", response=ApiResponseSchema, auth=jwt_auth, tags=["审批偏好"])
def update_approval_preferences(request: HttpRequest, data: ApprovalPreferencesUpdateSchema):
    """合并写入审批偏好。按 updatedAt 时间戳取较新一方，不覆盖无关条目。"""
    try:
        user = request.auth
        incoming = data.preferences
        if not isinstance(incoming, dict) or not incoming:
            return ApiResponseSchema(success=False, message="preferences 不能为空", code="VALIDATION_ERROR")

        invalid_keys = [k for k, v in incoming.items() if not _validate_preference_entry(k, v)]
        if invalid_keys:
            return ApiResponseSchema(
                success=False,
                message=f"无效的偏好条目: {', '.join(invalid_keys[:5])}",
                code="VALIDATION_ERROR",
            )

        profile, _ = UserProfile.objects.get_or_create(user=user)
        existing: dict = profile.approval_preferences or {}

        now_ms = int(time.time() * 1000)

        for key, new_entry in incoming.items():
            new_entry.setdefault('updatedAt', now_ms)
            old_entry = existing.get(key)
            if old_entry and old_entry.get('updatedAt', 0) >= new_entry.get('updatedAt', 0):
                continue
            existing[key] = new_entry

        if len(existing) > _APPROVAL_PREFS_MAX_ENTRIES:
            sorted_keys = sorted(existing.keys(), key=lambda k: existing[k].get('updatedAt', 0))
            for k in sorted_keys[:len(existing) - _APPROVAL_PREFS_MAX_ENTRIES]:
                del existing[k]

        profile.approval_preferences = existing
        profile.save(update_fields=['approval_preferences'])

        _broadcast_approval_preferences_changed(str(user.id), existing)

        return ApiResponseSchema(success=True, message="审批偏好已更新")

    except Exception:
        logger.exception("update_approval_preferences 内部异常")
        return ApiResponseSchema(success=False, message="操作失败，请稍后重试", code="INTERNAL_ERROR")


def _broadcast_approval_preferences_changed(user_id: str, preferences: dict) -> None:
    """写入成功后通过 WS 广播变更事件到用户的所有已连接设备。

    Wave 5：之前用 publish_ws_event(f"user.{user_id}", ...) 实际发到 `topic.user.{user_id}`
    group，但前端 auth 仅 join `user.{user_id}` group → 该事件实际不到前端。
    改用 publish_to_user 直发到用户 group。
    """
    try:
        from apps.services.common.ws.bus import publish_to_user
        from apps.services.common.ws.protocol import build_envelope, new_event_id
        envelope = build_envelope(
            "approval_preferences_changed",
            new_event_id(),
            {"data": preferences},
        )
        publish_to_user(user_id, envelope)
    except Exception:
        logger.debug("广播审批偏好变更事件失败: user=%s", user_id, exc_info=True)


# ── 个人偏好（UI settings）跨设备同步（设置 IA Phase 2）─────────────────
# 与审批偏好同构：UserProfile.ui_settings 作为 JSONField 承载，per-namespace
# last-write-wins，写成功后 WS 广播到用户的所有设备。后端只是通用承载——
# 各 namespace 的 value 语义由前端定义（如 notificationPrefs 由前端主进程写入），
# 后端不校验 value 的内部结构，只校验 namespace 白名单 + envelope 外壳。

# namespace 白名单（与前端共享契约严格一致）。
_UI_SETTINGS_NAMESPACES = frozenset({
    'theme',
    'fontSize',
    'colorScheme',
    'notificationPrefs',
    'mobilePushPrefs',
    'voiceHotwords',
    'resourceOpenPrefs',
})


def _validate_ui_settings_entry(namespace: str, envelope) -> bool:
    """校验单个 namespace 条目：白名单 + envelope 外壳 {value, updatedAt?}。

    value 允许任意 JSON（含 null）——后端是通用承载，不约束业务语义。
    updatedAt 若存在必须是数字（缺失则由服务端 now_ms 兜底）。
    """
    if namespace not in _UI_SETTINGS_NAMESPACES:
        return False
    if not isinstance(envelope, dict):
        return False
    if 'value' not in envelope:
        return False
    if 'updatedAt' in envelope and not isinstance(envelope['updatedAt'], (int, float)):
        return False
    return True


@router.get("/profile/ui-settings", auth=jwt_auth, tags=["个人偏好"])
def get_ui_settings(request: HttpRequest):
    """获取当前用户的个人偏好（跨设备同步）。返回 {settings: {<namespace>: {value, updatedAt}}}。"""
    user = request.auth
    profile, _ = UserProfile.objects.get_or_create(user=user)
    return success_response(data={"settings": profile.ui_settings or {}})


@router.put("/profile/ui-settings", response=ApiResponseSchema, auth=jwt_auth, tags=["个人偏好"])
def update_ui_settings(request: HttpRequest, data: UISettingsUpdateSchema):
    """合并写入个人偏好。增量提交，按 namespace 做 last-write-wins。"""
    try:
        user = request.auth
        incoming = data.settings
        if not isinstance(incoming, dict) or not incoming:
            return ApiResponseSchema(success=False, message="settings 不能为空", code="VALIDATION_ERROR")

        invalid = [k for k, v in incoming.items() if not _validate_ui_settings_entry(k, v)]
        if invalid:
            return ApiResponseSchema(
                success=False,
                message=f"无效的偏好条目: {', '.join(invalid[:5])}",
                code="VALIDATION_ERROR",
            )

        profile, _ = UserProfile.objects.get_or_create(user=user)
        existing: dict = profile.ui_settings or {}

        now_ms = int(time.time() * 1000)

        for namespace, new_entry in incoming.items():
            incoming_updated = new_entry.get('updatedAt')
            if not isinstance(incoming_updated, (int, float)):
                incoming_updated = now_ms  # 缺 updatedAt 用服务端 now_ms 兜底
            old_entry = existing.get(namespace)
            if isinstance(old_entry, dict) and old_entry.get('updatedAt', 0) >= incoming_updated:
                continue  # last-write-wins：旧的不更旧才跳过
            existing[namespace] = {'value': new_entry['value'], 'updatedAt': incoming_updated}

        profile.ui_settings = existing
        profile.save(update_fields=['ui_settings'])

        _broadcast_ui_settings_changed(str(user.id), existing)

        return ApiResponseSchema(success=True, message="个人偏好已更新")

    except Exception:
        logger.exception("update_ui_settings 内部异常")
        return ApiResponseSchema(success=False, message="操作失败，请稍后重试", code="INTERNAL_ERROR")


def _broadcast_ui_settings_changed(user_id: str, settings: dict) -> None:
    """写入成功后通过 WS 广播 ``ui_settings_changed`` 到用户的所有已连接设备。

    与 :func:`_broadcast_approval_preferences_changed` 同构（publish_to_user 直发
    用户 group）。payload 沿用 GET/PUT 契约外壳 {settings: {...}}，前端可与
    GET 响应复用同一套 apply 逻辑。
    """
    try:
        from apps.services.common.ws.bus import publish_to_user
        from apps.services.common.ws.protocol import build_envelope, new_event_id
        envelope = build_envelope(
            "ui_settings_changed",
            new_event_id(),
            {"data": {"settings": settings}},
        )
        publish_to_user(user_id, envelope)
    except Exception:
        logger.debug("广播个人偏好变更事件失败: user=%s", user_id, exc_info=True)


# ── 个人 Agent 规则（设置 IA Phase 3 §8.6 分层规则·个人基线层）────────────
# per-User 全局（跨 Organization），运行时按 个人→Agent 顺序拼进 system prompt
# （Agent 专属层 = Agent.custom_rules）。原团队层 Organization.agent_rules 已下线。
# 与审批偏好 / UI 偏好同处 UserProfile，但语义是纯文本规则（非 namespace JSON）：
# 整体替换、空串=清空。上限 5000 字与 Agent.custom_rules schema 对齐（超限 ninja 422）。

_PERSONAL_RULES_MAX_CHARS = 5000


class PersonalRulesUpdateSchema(Schema):
    """PUT 请求体：个人 Agent 规则全文（整体替换）。"""
    personal_rules: str = Field(
        default="",
        max_length=_PERSONAL_RULES_MAX_CHARS,
        description="个人 Agent 规则全文（≤5000 字），空串=清空个人基线层",
    )


@router.get("/profile/personal-rules", auth=jwt_auth, tags=["个人偏好"])
def get_personal_rules(request: HttpRequest):
    """获取当前用户的个人 Agent 规则（三层规则·个人基线层，跨 Organization 全局）。"""
    user = request.auth
    profile, _ = UserProfile.objects.get_or_create(user=user)
    return success_response(data={"personal_rules": profile.personal_rules or ""})


@router.put("/profile/personal-rules", response=ApiResponseSchema, auth=jwt_auth, tags=["个人偏好"])
def update_personal_rules(request: HttpRequest, data: PersonalRulesUpdateSchema):
    """整体替换个人 Agent 规则。空串=清空个人基线层。"""
    try:
        user = request.auth
        profile, _ = UserProfile.objects.get_or_create(user=user)
        profile.personal_rules = data.personal_rules or ""
        profile.save(update_fields=['personal_rules'])

        from apps.tabtinspace.services.host_state_invalidation import (
            publish_user_host_state_invalidated,
        )
        transaction.on_commit(
            lambda: publish_user_host_state_invalidated(
                user.id,
                reason="personal_rules_changed",
            )
        )

        log_user_action(user, 'profile_update', request, description="更新个人 Agent 规则")

        return ApiResponseSchema(success=True, message="个人 Agent 规则已更新")

    except Exception:
        logger.exception("update_personal_rules 内部异常")
        return ApiResponseSchema(success=False, message="操作失败，请稍后重试", code="INTERNAL_ERROR")

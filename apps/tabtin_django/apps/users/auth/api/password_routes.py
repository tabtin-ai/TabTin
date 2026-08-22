"""密码管理相关 API 路由"""
import logging

from django.conf import settings
from django.core.exceptions import ValidationError
from django.http import HttpRequest
from django.utils import timezone
from ninja import Router

from ._shared import (
    success_response, _,
    jwt_auth, User,
    PasswordChangeSchema, PasswordStrengthCheckSchema, PasswordStrengthSchema,
    ForgotPasswordSchema, PasswordResetSchema, CurrentUserPasswordResetSchema, ApiResponseSchema,
    get_client_ip, get_user_agent, mask_identifier, get_password_strength_score,
    check_password_reset_rate_limit, check_verification_code_rate_limit,
    is_suspicious_password_reset_activity,
    validate_password_reset_context, log_security_event,
    VerificationCodeManager,
    validate_user_password,
    UserSession, UserApiKey,
    _notify_logout_revocations, log_user_action, format_validation_error,
    _check_verify_submit_ip_rate,
    get_email_service,
)

logger = logging.getLogger(__name__)

router = Router()


def _is_masked_identifier(identifier: str) -> bool:
    """展示层脱敏值不能作为认证凭据继续提交。"""
    return "*" in (identifier or "")


def _current_user_password_reset_identifier(user) -> str:
    """已登录改密验证码只使用后端可信的当前用户联系方式。"""
    return (getattr(user, 'phone', None) or getattr(user, 'email', None) or '').strip()


@router.post("/change-password", response=ApiResponseSchema, auth=jwt_auth, tags=["用户管理"])
def change_password(request: HttpRequest, data: PasswordChangeSchema):
    """修改密码"""
    try:
        user = request.auth

        # 验证原密码
        if not user.check_password(data.old_password):
            return ApiResponseSchema(
                success=False,
                message=_("auth.old_password_wrong"),
                code="VALIDATION_ERROR"
            )

        if user.check_password(data.new_password):
            return ApiResponseSchema(
                success=False,
                message=_("auth.new_password_same_as_old"),
                code="VALIDATION_ERROR",
            )

        if data.verification_code:
            is_valid = VerificationCodeManager.verify_code(
                user.email or user.phone or str(user.id),
                data.verification_code,
                'change_password',
                delete_after_verify=True,
            )
            if not is_valid:
                return ApiResponseSchema(
                    success=False,
                    message='验证码无效或已过期',
                    code="VALIDATION_ERROR"
                )

        # 验证新密码
        validate_user_password(data.new_password, user)

        # 更新密码
        user.set_password(data.new_password)
        user.save()
        user.reset_login_failures()

        # 使所有会话失效
        UserSession.objects.filter(user=user, is_active=True).update(is_active=False)

        # RB-004: 通知 collab-live 撤销协作连接 + Centrifugo 断连
        _notify_logout_revocations(str(user.id))

        # 记录操作日志
        log_user_action(user, 'password_change', request, description="修改密码成功")

        active_key_count = UserApiKey.objects.using('default').filter(user=user, is_active=True).count()
        return ApiResponseSchema(
            success=True,
            message=_("auth.password_changed"),
            data={'active_api_keys': active_key_count} if active_key_count > 0 else None,
        )

    except ValidationError as e:
        return ApiResponseSchema(
            success=False,
            message=format_validation_error(e),
            code="VALIDATION_ERROR"
        )
    except Exception:
        logger.exception("change_password 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


@router.post("/password-strength", auth=None, tags=["工具"])
def check_password_strength(request: HttpRequest, data: PasswordStrengthCheckSchema):
    """检查密码强度（CA-5: POST 方法，密码通过 body 传输）"""
    score = get_password_strength_score(data.password)

    if score >= 80:
        level = _("auth.password_strength_strong")
        suggestions = [_("auth.suggestion_good")]
    elif score >= 60:
        level = _("auth.password_strength_medium")
        suggestions = [_("auth.suggestion_longer"), _("auth.suggestion_more_types")]
    elif score >= 40:
        level = _("auth.password_strength_weak")
        suggestions = [_("auth.suggestion_too_simple"), _("auth.suggestion_mixed_chars"), _("auth.suggestion_longer")]
    else:
        level = _("auth.password_strength_very_weak")
        suggestions = [_("auth.suggestion_way_too_simple"), _("auth.suggestion_upper_lower"), _("auth.suggestion_digits"), _("auth.suggestion_special"), _("auth.suggestion_min_length")]

    return success_response(data=PasswordStrengthSchema(
        score=score,
        level=level,
        suggestions=suggestions
    ).model_dump())


@router.post("/send-current-password-reset-code", response=ApiResponseSchema, auth=jwt_auth, tags=["密码管理"])
def send_current_password_reset_code(request: HttpRequest):
    """已登录用户忘记当前密码 - 给当前用户绑定手机号/邮箱发送改密验证码"""
    try:
        user = request.auth
        identifier = _current_user_password_reset_identifier(user)
        if not identifier:
            return ApiResponseSchema(
                success=False,
                message=_("auth.phone_or_email_required"),
                code="VALIDATION_ERROR",
            )

        ip_address = get_client_ip(request)
        rate_limit_ok, rate_limit_msg = check_verification_code_rate_limit(identifier, ip_address)
        if not rate_limit_ok:
            log_security_event(
                "current_password_reset_rate_limited",
                request,
                user=user,
                success=False,
                reason="rate_limited",
                extra={"identifier": mask_identifier(identifier), "code_type": "change_password"},
            )
            return ApiResponseSchema(
                success=False,
                message=rate_limit_msg,
                code="RATE_LIMITED",
            )

        success, message, code = VerificationCodeManager.send_code(
            identifier,
            'change_password',
            ip_address=ip_address,
            skip_rate_limit=True,
        )
        if not success:
            log_security_event(
                "current_password_reset_send_failed",
                request,
                user=user,
                success=False,
                reason=message,
                extra={"identifier": mask_identifier(identifier), "code_type": "change_password"},
            )
            return ApiResponseSchema(
                success=False,
                message=message,
                code="INTERNAL_ERROR",
            )

        return ApiResponseSchema(
            success=True,
            message=_("auth.verification_code_sent"),
        )
    except Exception:
        logger.exception("send_current_password_reset_code 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR",
        )


@router.post("/reset-current-password", response=ApiResponseSchema, auth=jwt_auth, tags=["密码管理"])
def reset_current_password(request: HttpRequest, data: CurrentUserPasswordResetSchema):
    """已登录用户忘记当前密码 - 使用当前用户验证码重置密码"""
    try:
        user = request.auth
        identifier = _current_user_password_reset_identifier(user)
        if not identifier:
            return ApiResponseSchema(
                success=False,
                message=_("auth.phone_or_email_required"),
                code="VALIDATION_ERROR",
            )

        validate_user_password(data.new_password)

        if user.check_password(data.new_password):
            return ApiResponseSchema(
                success=False,
                message=_("auth.new_password_same_as_old"),
                code="VALIDATION_ERROR",
            )

        validate_user_password(data.new_password, user)

        is_valid = VerificationCodeManager.verify_code(
            identifier,
            data.verification_code,
            'change_password',
            delete_after_verify=True,
        )
        if not is_valid:
            log_security_event(
                "current_password_reset_failed",
                request,
                user=user,
                success=False,
                reason="invalid_verification_code",
                extra={"identifier": mask_identifier(identifier)},
            )
            return ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VALIDATION_ERROR",
            )

        user.set_password(data.new_password)
        user.save()
        user.reset_login_failures()

        UserSession.objects.filter(user=user, is_active=True).update(is_active=False)
        _notify_logout_revocations(str(user.id))
        log_user_action(user, 'password_reset', request, description="当前用户验证码重置密码成功")

        active_key_count = UserApiKey.objects.using('default').filter(user=user, is_active=True).count()
        return ApiResponseSchema(
            success=True,
            message=_("auth.password_reset_success"),
            data={'active_api_keys': active_key_count} if active_key_count > 0 else None,
        )
    except ValidationError as e:
        return ApiResponseSchema(
            success=False,
            message=format_validation_error(e),
            code="VALIDATION_ERROR",
        )
    except Exception:
        logger.exception("reset_current_password 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR",
        )


@router.post("/forgot-password", response=ApiResponseSchema, auth=None, tags=["密码管理"])
def forgot_password(request: HttpRequest, data: ForgotPasswordSchema):
    """忘记密码 - 发送重置验证码"""
    try:
        # 获取请求信息
        ip_address = get_client_ip(request)
        user_agent = get_user_agent(request)
        username = data.username.strip()

        if _is_masked_identifier(username):
            log_security_event(
                "password_reset_masked_identifier",
                request,
                success=False,
                reason="masked_identifier",
                extra={"identifier": mask_identifier(username)}
            )
            return ApiResponseSchema(
                success=False,
                message="请输入完整的邮箱或手机号",
                code="VALIDATION_ERROR"
            )

        # 验证请求上下文
        context_valid, context_msg = validate_password_reset_context(username, user_agent, ip_address)
        if not context_valid:
            return ApiResponseSchema(
                success=False,
                message=context_msg,
                code="VALIDATION_ERROR"
            )

        # 检查密码重置频率限制
        rate_limit_ok, rate_limit_msg = check_password_reset_rate_limit(username, ip_address)
        if not rate_limit_ok:
            log_security_event(
                "password_reset_rate_limited",
                request,
                success=False,
                reason="rate_limited",
                extra={"identifier": mask_identifier(username)}
            )
            return ApiResponseSchema(
                success=False,
                message=rate_limit_msg,
                code="RATE_LIMITED"
            )

        # 检查可疑活动
        is_suspicious, suspicious_msg = is_suspicious_password_reset_activity(username, ip_address)
        if is_suspicious:
            log_security_event(
                "password_reset_suspicious",
                request,
                success=False,
                reason=suspicious_msg,
                extra={"identifier": mask_identifier(username)}
            )
            return ApiResponseSchema(
                success=False,
                message=suspicious_msg,
                code="RATE_LIMITED"
            )

        # 验证用户是否存在（手机号含 +86 / 11 位互认）
        try:
            if '@' in username:
                user = User.objects.get(email=username, is_active=True)
            else:
                from apps.users.auth.phone import resolve_user_by_phone

                user = resolve_user_by_phone(username, active_only=True)
                if user is None:
                    raise User.DoesNotExist
        except User.DoesNotExist:
            # 为了安全，不暴露用户是否存在
            return ApiResponseSchema(
                success=True,
                message=_("auth.password_reset_sent")
            )

        # 发送验证码（使用VerificationCodeManager统一管理）
        success, message, code = VerificationCodeManager.send_code(
            username,
            'reset_password',
            ip_address=ip_address,
            skip_rate_limit=True
        )

        if not success:
            log_security_event(
                "password_reset_send_failed",
                request,
                success=False,
                reason=message,
                extra={"identifier": mask_identifier(username)}
            )
            return ApiResponseSchema(
                success=True,
                message=_("auth.password_reset_sent")
            )

        # 记录操作日志
        log_user_action(user, 'password_reset', request, description="请求密码重置")

        return ApiResponseSchema(
            success=True,
            message=_("auth.password_reset_sent")
        )

    except Exception:
        logger.exception("forgot_password 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


@router.post("/reset-password", response=ApiResponseSchema, auth=None, tags=["密码管理"])
def reset_password(request: HttpRequest, data: PasswordResetSchema):
    """重置密码"""
    try:
        # IP 级别速率限制
        ip_address = get_client_ip(request)
        rate_ok, rate_msg = _check_verify_submit_ip_rate(ip_address)
        if not rate_ok:
            return ApiResponseSchema(
                success=False,
                message=rate_msg,
                code="RATE_LIMITED"
            )

        # 先做不依赖验证码的密码复杂度校验，避免弱密码请求消费短信验证码。
        validate_user_password(data.new_password)

        # 获取用户（统一错误消息，防止账号枚举；手机号含 +86 / 11 位互认）
        try:
            if '@' in data.username:
                user = User.objects.get(email=data.username, is_active=True)
            else:
                from apps.users.auth.phone import resolve_user_by_phone

                user = resolve_user_by_phone(data.username, active_only=True)
                if user is None:
                    raise User.DoesNotExist
        except User.DoesNotExist:
            return ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VALIDATION_ERROR"
            )

        if user.check_password(data.new_password):
            return ApiResponseSchema(
                success=False,
                message=_("auth.new_password_same_as_old"),
                code="VALIDATION_ERROR",
            )

        # 验证新密码
        validate_user_password(data.new_password, user)

        # 所有密码相关校验通过后，最后验证并消费验证码。
        is_valid = VerificationCodeManager.verify_code(
            data.username,
            data.verification_code,
            'reset_password',
            delete_after_verify=True,
        )
        if not is_valid:
            log_security_event(
                "password_reset_failed",
                request,
                success=False,
                reason="invalid_verification_code",
                extra={"identifier": mask_identifier(data.username)}
            )
            return ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VALIDATION_ERROR"
            )

        # 更新密码
        user.set_password(data.new_password)
        user.save()
        user.reset_login_failures()

        # 使所有会话失效
        UserSession.objects.filter(user=user, is_active=True).update(is_active=False)

        # RB-004: 通知 collab-live 撤销协作连接 + Centrifugo 断连
        _notify_logout_revocations(str(user.id))

        # 记录操作日志
        log_user_action(user, 'password_reset', request, description="密码重置成功")

        # 发送密码修改通知邮件/短信
        try:
            if '@' in data.username and get_email_service:
                email_service = get_email_service()
                email_service.send_email(
                    to_email=data.username,
                    subject=f"【{getattr(settings, 'COMPANY_NAME', 'TabTin')}】密码重置成功通知",
                    content=f"""
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2>密码重置成功</h2>
                        <p>您好，</p>
                        <p>您的账号密码已成功重置。如果这不是您本人的操作，请立即联系客服。</p>
                        <p>重置时间：{timezone.now().strftime('%Y-%m-%d %H:%M:%S')}</p>
                        <p>如有疑问，请联系客服。</p>
                        <hr>
                        <p style="color: ; font-size: 12px;">此邮件由系统自动发送，请勿回复。</p>
                    </div>
                    """,
                    content_type='html'
                )
        except Exception as e:
            # 通知发送失败不影响密码重置成功
            pass

        active_key_count = UserApiKey.objects.using('default').filter(user=user, is_active=True).count()
        return ApiResponseSchema(
            success=True,
            message=_("auth.password_reset_success"),
            data={'active_api_keys': active_key_count} if active_key_count > 0 else None,
        )

    except ValidationError as e:
        return ApiResponseSchema(
            success=False,
            message=format_validation_error(e),
            code="VALIDATION_ERROR"
        )
    except Exception:
        logger.exception("reset_password 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )

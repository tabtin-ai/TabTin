"""验证码发送与验证相关 API 路由"""
from ninja import Router

from ._shared import (
    VerificationCodeManager,
    mask_identifier,
    mask_email,
    mask_phone,
    get_client_ip,
    log_security_event,
    log_user_action,
    _check_verify_submit_ip_rate,
    check_verification_code_rate_limit,
    User,
    jwt_auth,
    SendVerificationCodeSchema,
    EmailVerificationSchema,
    PhoneVerificationSchema,
    BindEmailSendSchema,
    BindEmailSchema,
    ApiResponseSchema,
    validate_unique_email,
    format_validation_error,
    _,
    re,
    logger,
    HttpRequest,
    is_phone_number,
    PHONE_REGEX,
)
from django.core.exceptions import ValidationError
router = Router(tags=["认证"])


@router.post("/send-verification-code", response=ApiResponseSchema, auth=None, tags=["认证"])
def send_verification_code(request: HttpRequest, data: SendVerificationCodeSchema):
    """
    发送验证码

    ## 功能说明
    根据不同的验证码类型发送相应的验证码到用户邮箱或手机。

    ## 验证码类型
    - `register`: 注册验证码（有效期10分钟）- 要求用户不存在
    - `login`: 登录验证码（有效期5分钟）- 支持自动注册，无需预先注册
    - `reset_password`: 密码重置验证码（有效期10分钟）- 要求用户已存在

    ## 安全限制
    - 每小时最多发送10次验证码
    - 注册类型会检查用户是否已存在
    - 自动识别邮箱/手机号并选择对应服务
    """
    identifier = mask_identifier(data.username)
    logger.info("发送验证码函数开始: username=%s, code_type=%s", identifier, data.code_type)
    try:
        # 使用统一的验证码管理器
        # 检查频率限制（账号/IP/组合）
        ip_address = get_client_ip(request)
        rate_ok, rate_msg = VerificationCodeManager.check_rate_limit(data.username, ip_address)
        if not rate_ok:
            identifier = data.username
            if '@' in identifier:
                identifier = mask_email(identifier)
            elif is_phone_number(identifier):
                identifier = mask_phone(identifier)
            log_security_event(
                "verification_rate_limited",
                request,
                success=False,
                reason="rate_limited",
                extra={"identifier": identifier, "code_type": data.code_type}
            )
            return ApiResponseSchema(
                success=False,
                message=rate_msg,
                code="RATE_LIMITED"
            )

        # 如果是注册验证码，检查用户是否已存在（手机号含 +86 / 11 位互认）
        if data.code_type == "register":
            already_registered = False
            if '@' in data.username:
                already_registered = User.objects.filter(email=data.username).exists()
            else:
                from apps.users.auth.phone import resolve_user_by_phone

                already_registered = (
                    resolve_user_by_phone(data.username, active_only=False) is not None
                )
            if already_registered:
                return ApiResponseSchema(
                    success=False,
                    message=_("auth.email_phone_already_registered"),
                    code="VALIDATION_ERROR"
                )

        if data.code_type == "phone_reservation" and not is_phone_number(data.username):
            return ApiResponseSchema(
                success=False,
                message=_("auth.phone_format_invalid"),
                code="PHONE_FORMAT_INVALID",
            )

        # 生成、缓存并发送验证码
        success, message, code = VerificationCodeManager.send_code(
            data.username,
            data.code_type,
            ip_address=ip_address,
            skip_rate_limit=True,
            challenge_key=data.challenge_key,
        )
        if not success:
            log_security_event(
                "verification_send_failed",
                request,
                success=False,
                reason=message,
                extra={"code_type": data.code_type}
            )
            error_code = "CONFIG_ERROR" if "未配置" in message else "INTERNAL_ERROR"
            return ApiResponseSchema(
                success=False,
                message=message,
                code=error_code
            )

        client_message = _("auth.verification_code_sent")
        if VerificationCodeManager.get_community_fixed_code(
            data.username, data.code_type
        ):
            client_message = message

        return ApiResponseSchema(
            success=True,
            message=client_message
        )

    except Exception:
        logger.exception("send_verification_code 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


@router.post("/verify-email", response=ApiResponseSchema, auth=None, tags=["认证"])
def verify_email(request: HttpRequest, data: EmailVerificationSchema):
    """邮箱验证"""
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

        # CA-15: 先查用户，再验证码；统一错误响应不泄露账号存在性
        try:
            user = User.objects.get(email=data.email)
        except User.DoesNotExist:
            return ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VALIDATION_ERROR"
            )

        is_valid = VerificationCodeManager.verify_code(data.email, data.verification_code, 'verify_email', delete_after_verify=True)
        if not is_valid:
            return ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VALIDATION_ERROR"
            )

        # 更新邮箱验证状态
        user.is_verified_email = True
        user.save()

        log_user_action(user, 'email_verify', request, description="邮箱验证成功")

        return ApiResponseSchema(
            success=True,
            message=_("auth.email_verified")
        )

    except Exception as e:
        logger.exception("邮箱验证异常")
        return ApiResponseSchema(
            success=False,
            message=_("auth.verification_failed"),
            code="INTERNAL_ERROR"
        )


@router.post("/verify-phone", response=ApiResponseSchema, auth=None, tags=["认证"])
def verify_phone(request: HttpRequest, data: PhoneVerificationSchema):
    """手机号验证"""
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

        # 验证手机号格式
        if not re.match(PHONE_REGEX, data.phone):
            return ApiResponseSchema(
                success=False,
                message=_("auth.phone_format_invalid"),
                code="VALIDATION_ERROR"
            )

        # CA-15: 先查用户，再验证码；统一错误响应不泄露账号存在性
        from apps.users.auth.phone import resolve_user_by_phone

        user = resolve_user_by_phone(data.phone, active_only=False)
        if user is None:
            return ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VALIDATION_ERROR"
            )

        is_valid = VerificationCodeManager.verify_code(data.phone, data.verification_code, 'verify_phone', delete_after_verify=True)
        if not is_valid:
            return ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VALIDATION_ERROR"
            )

        # 更新手机号验证状态
        user.is_verified_phone = True
        user.save()

        log_user_action(user, 'phone_verify', request, description="手机号验证成功")

        return ApiResponseSchema(
            success=True,
            message=_("auth.phone_verified")
        )

    except Exception as e:
        logger.exception("手机号验证异常")
        return ApiResponseSchema(
            success=False,
            message=_("auth.verification_failed"),
            code="INTERNAL_ERROR"
        )


@router.post("/send-email-verification", response=ApiResponseSchema, auth=jwt_auth, tags=["认证"])
def send_email_verification(request: HttpRequest):
    """发送邮箱验证码（已登录用户）"""
    try:
        user = request.auth

        if not user.email:
            return ApiResponseSchema(
                success=False,
                message=_("auth.email_not_bound"),
                code="VALIDATION_ERROR"
            )

        if user.is_verified_email:
            return ApiResponseSchema(
                success=False,
                message=_("auth.email_already_verified"),
                code="VALIDATION_ERROR"
            )

        # 检查频率限制
        ip_address = get_client_ip(request)
        rate_limit_ok, rate_limit_msg = check_verification_code_rate_limit(user.email, ip_address)
        if not rate_limit_ok:
            log_security_event(
                "verification_rate_limited",
                request,
                user=user,
                success=False,
                reason="rate_limited",
                extra={"identifier": mask_email(user.email), "code_type": "verify_email"}
            )
            return ApiResponseSchema(
                success=False,
                message=rate_limit_msg,
                code="RATE_LIMITED"
            )

        # 发送验证码（使用VerificationCodeManager统一管理）
        success, message, code = VerificationCodeManager.send_code(
            user.email,
            'verify_email',
            ip_address=ip_address,
            skip_rate_limit=True
        )

        if not success:
            log_security_event(
                "verification_send_failed",
                request,
                user=user,
                success=False,
                reason=message,
                extra={"code_type": "verify_email"}
            )
            return ApiResponseSchema(
                success=False,
                message=message,
                code="INTERNAL_ERROR"
            )

        return ApiResponseSchema(
            success=True,
            message=_("auth.code_sent_to_email")
        )

    except Exception:
        logger.exception("send_email_verification 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


@router.post("/send-phone-verification", response=ApiResponseSchema, auth=jwt_auth, tags=["认证"])
def send_phone_verification(request: HttpRequest):
    """发送手机验证码（已登录用户）"""
    try:
        user = request.auth

        if not user.phone:
            return ApiResponseSchema(
                success=False,
                message=_("auth.phone_not_bound"),
                code="VALIDATION_ERROR"
            )

        if user.is_verified_phone:
            return ApiResponseSchema(
                success=False,
                message=_("auth.phone_already_verified"),
                code="VALIDATION_ERROR"
            )

        # 检查频率限制
        ip_address = get_client_ip(request)
        rate_limit_ok, rate_limit_msg = check_verification_code_rate_limit(user.phone, ip_address)
        if not rate_limit_ok:
            log_security_event(
                "verification_rate_limited",
                request,
                user=user,
                success=False,
                reason="rate_limited",
                extra={"identifier": mask_phone(user.phone), "code_type": "verify_phone"}
            )
            return ApiResponseSchema(
                success=False,
                message=rate_limit_msg,
                code="RATE_LIMITED"
            )

        # 发送验证码（VerificationCodeManager已包含完整流程）
        success, message, code = VerificationCodeManager.send_code(
            user.phone,
            'verify_phone',
            ip_address=ip_address,
            skip_rate_limit=True
        )

        if not success:
            log_security_event(
                "verification_send_failed",
                request,
                user=user,
                success=False,
                reason=message,
                extra={"code_type": "verify_phone"}
            )
            return ApiResponseSchema(
                success=False,
                message=message,
                code="INTERNAL_ERROR"
            )

        return ApiResponseSchema(
            success=True,
            message=_("auth.code_sent_to_phone")
        )

    except Exception:
        logger.exception("send_phone_verification 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


@router.post("/send-bind-email-code", response=ApiResponseSchema, auth=jwt_auth, tags=["认证"])
def send_bind_email_code(request: HttpRequest, data: BindEmailSendSchema):
    """已登录且尚未绑定邮箱的用户：向待绑定邮箱发送验证码。"""
    try:
        user = request.auth
        if user.email:
            return ApiResponseSchema(
                success=False,
                message=_("auth.email_already_bound"),
                code="VALIDATION_ERROR",
            )

        email = str(data.email).strip().lower()
        try:
            validate_unique_email(email, user_id=str(user.id))
        except ValidationError as exc:
            return ApiResponseSchema(
                success=False,
                message=format_validation_error(exc),
                code="VALIDATION_ERROR",
            )

        ip_address = get_client_ip(request)
        rate_limit_ok, rate_limit_msg = check_verification_code_rate_limit(email, ip_address)
        if not rate_limit_ok:
            log_security_event(
                "verification_rate_limited",
                request,
                user=user,
                success=False,
                reason="rate_limited",
                extra={"identifier": mask_email(email), "code_type": "bind_email"},
            )
            return ApiResponseSchema(
                success=False,
                message=rate_limit_msg,
                code="RATE_LIMITED",
            )

        success, message, _code = VerificationCodeManager.send_code(
            email,
            "bind_email",
            ip_address=ip_address,
            skip_rate_limit=True,
        )
        if not success:
            log_security_event(
                "verification_send_failed",
                request,
                user=user,
                success=False,
                reason=message,
                extra={"code_type": "bind_email"},
            )
            return ApiResponseSchema(
                success=False,
                message=message,
                code="INTERNAL_ERROR",
            )

        return ApiResponseSchema(
            success=True,
            message=_("auth.code_sent_to_email"),
        )
    except Exception:
        logger.exception("send_bind_email_code 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR",
        )


@router.post("/bind-email", response=ApiResponseSchema, auth=jwt_auth, tags=["认证"])
def bind_email(request: HttpRequest, data: BindEmailSchema):
    """已登录用户：校验验证码后绑定邮箱。"""
    try:
        user = request.auth
        if user.email:
            return ApiResponseSchema(
                success=False,
                message=_("auth.email_already_bound"),
                code="VALIDATION_ERROR",
            )

        email = str(data.email).strip().lower()
        try:
            validate_unique_email(email, user_id=str(user.id))
        except ValidationError as exc:
            return ApiResponseSchema(
                success=False,
                message=format_validation_error(exc),
                code="VALIDATION_ERROR",
            )

        ip_address = get_client_ip(request)
        rate_ok, rate_msg = _check_verify_submit_ip_rate(ip_address)
        if not rate_ok:
            return ApiResponseSchema(
                success=False,
                message=rate_msg,
                code="RATE_LIMITED",
            )

        is_valid = VerificationCodeManager.verify_code(
            email,
            data.verification_code,
            "bind_email",
            delete_after_verify=True,
        )
        if not is_valid:
            return ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VALIDATION_ERROR",
            )

        user.email = email
        user.is_verified_email = True
        user.save(update_fields=["email", "is_verified_email"])

        log_user_action(user, "email_verify", request, description="绑定邮箱成功")

        return ApiResponseSchema(
            success=True,
            message=_("auth.email_bound"),
        )
    except Exception:
        logger.exception("bind_email 内部异常")
        return ApiResponseSchema(
            success=False,
            message=_("auth.verification_failed"),
            code="INTERNAL_ERROR",
        )

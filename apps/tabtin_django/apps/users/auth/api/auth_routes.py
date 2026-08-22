"""核心认证 API 路由（注册 / 登录 / 登出）"""
from ninja import Router
from django.db import IntegrityError

from ._shared import (
    re,
    authenticate,
    ValidationError,
    HttpRequest,
    _,
    success_response,
    logger,
    User,
    jwt_auth,
    UserRegisterSchema,
    UserLoginSchema,
    VerificationCodeLoginSchema,
    PhoneReservationSchema,
    ApiResponseSchema,
    LoginErrorResponseSchema,
    LoginResponseSchema,
    get_client_ip,
    check_simple_rate_limit,
    hash_string,
    mask_email,
    mask_phone,
    mask_identifier,
    check_login_rate_limit,
    record_rate_limit_hit,
    log_security_event,
    SessionManager,
    VerificationCodeManager,
    validate_unique_email,
    validate_unique_phone,
    validate_unique_username,
    validate_user_password,
    format_validation_error,
    _notify_logout_revocations,
    log_user_action,
    _build_user_info,
    _create_auth_session,
    _check_verify_submit_ip_rate,
    verify_jwt_token,
    is_phone_number,
    PHONE_REGEX,
)
from ..models import IntentUser
router = Router(tags=["认证"])

PHONE_RESERVATION_IP_MAX = 30
PHONE_RESERVATION_IP_WINDOW = 3600


def _account_locked_response(user):
    """构造带真实剩余时间的账号锁定响应。"""
    remaining_seconds = max(1, user.account_lockout_remaining_seconds())
    if remaining_seconds >= 60:
        message = _(
            "auth.account_locked_minutes",
            minutes=(remaining_seconds + 59) // 60,
        )
    else:
        message = _(
            "auth.account_locked_seconds",
            seconds=remaining_seconds,
        )
    return 401, LoginErrorResponseSchema(
        success=False,
        message=message,
        code="ACCOUNT_LOCKED",
        retry_after_seconds=remaining_seconds,
    )


@router.post(
    "/phone-reservations",
    response={
        200: ApiResponseSchema,
        400: ApiResponseSchema,
        409: ApiResponseSchema,
        429: ApiResponseSchema,
        500: ApiResponseSchema,
    },
    auth=None,
    tags=["认证"],
)
def reserve_phone(request: HttpRequest, data: PhoneReservationSchema):
    """客户端手机号预约。"""

    from apps.users.auth.phone import canonicalize_phone, phone_lookup_aliases

    # 验证码按用户输入字面量缓存；入库用规范手机号（CN → 11 位）
    phone_input = data.phone.strip()
    phone = canonicalize_phone(phone_input) or phone_input
    ip_address = get_client_ip(request)
    rate_key = f"rate_limit:phone_reservation:ip:{hash_string(ip_address)}"
    if not check_simple_rate_limit(rate_key, PHONE_RESERVATION_IP_MAX, PHONE_RESERVATION_IP_WINDOW):
        return 429, ApiResponseSchema(
            success=False,
            message="预约请求过于频繁，请稍后再试",
            code="RATE_LIMITED",
        )

    if not re.match(PHONE_REGEX, phone_input):
        return 400, ApiResponseSchema(
            success=False,
            message=_("auth.phone_format_invalid"),
            code="PHONE_FORMAT_INVALID",
        )

    try:
        if IntentUser.objects.filter(phone__in=phone_lookup_aliases(phone_input)).exists():
            return 409, ApiResponseSchema(
                success=False,
                message="该手机号已预约",
                data={"phone": phone},
                code="PHONE_ALREADY_RESERVED",
            )

        if not data.verification_code.isdigit() or len(data.verification_code) != 6:
            return 400, ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_must_be_6_digits"),
                code="VERIFICATION_CODE_INVALID",
            )

        is_valid = VerificationCodeManager.verify_code(
            phone_input,
            data.verification_code,
            "phone_reservation",
            delete_after_verify=True,
        )
        if not is_valid:
            return 400, ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="VERIFICATION_CODE_INVALID",
            )

        intent_user = IntentUser.objects.create(phone=phone)
    except IntegrityError:
        return 409, ApiResponseSchema(
            success=False,
            message="该手机号已预约",
            data={"phone": phone},
            code="PHONE_ALREADY_RESERVED",
        )
    except Exception:
        logger.exception("reserve phone failed")
        return 500, ApiResponseSchema(
            success=False,
            message="预约失败，请稍后重试",
            code="PHONE_RESERVATION_FAILED",
        )

    return ApiResponseSchema(
        success=True,
        message="预约成功",
        data={"phone": intent_user.phone},
        code="PHONE_RESERVED",
    )


def _ensure_personal_organization_before_login(user: User, *, cleanup_new_user: bool = False) -> bool:
    """登录态签发前强制确保 personal organization 存在。"""
    try:
        from apps.tabtinspace.services.organization_service import OrganizationService
        OrganizationService.ensure_personal_organization(user)
        return True
    except Exception:
        logger.exception(
            "ensure personal organization failed before login: user=%s cleanup=%s",
            getattr(user, "id", ""), cleanup_new_user,
        )
        if cleanup_new_user:
            try:
                user.delete()
            except Exception:
                logger.exception("cleanup new user after personal organization failure failed: user=%s", getattr(user, "id", ""))
        return False


def _generate_unique_username(*, email: str | None = None, phone: str | None = None) -> str:
    """按「邮箱前缀 / 手机后4位」生成唯一 username。

    口径与验证码自动注册保持一致，作为唯一来源：邮箱取 @ 前缀截 15 字符，
    手机取 ``user_{后4位}``；若已存在则追加 ``_1``、``_2`` 直到唯一。

    生成后清洗非法字符：username 仅允许 ``[a-zA-Z0-9_]``（资料页
    ``RegexValidator ^[a-zA-Z0-9_]+$``），邮箱前缀里的点 / 连字符等非法字符
    统一替成下划线（如 ``chengyue.jin`` → ``chengyue_jin``），否则自动生成的
    用户名通不过格式校验、用户后续改资料时会被拦。
    """
    if email and "@" in email:
        base_username = email.split("@")[0][:15]
    elif phone:
        base_username = f"user_{phone[-4:]}"
    else:
        base_username = "user"

    # 非 [a-zA-Z0-9_] 字符统一替成下划线；清洗后若为空则兜底 ``user``。
    base_username = re.sub(r"[^a-zA-Z0-9_]", "_", base_username) or "user"

    username = base_username
    counter = 1
    while User.objects.filter(username=username).exists():
        username = f"{base_username}_{counter}"
        counter += 1
    return username


@router.post(
    "/register",
    response={200: dict, 400: ApiResponseSchema, 429: ApiResponseSchema, 500: ApiResponseSchema},
    auth=None,
    tags=["认证"],
)
def register_user(request: HttpRequest, data: UserRegisterSchema):
    """
    用户注册（注册成功后自动登录）

    ## 功能说明
    用户注册需要先通过发送验证码接口获取验证码，然后提交注册信息完成注册。
    注册成功后自动颁发 JWT Token，无需二次登录。

    ## 注册流程
    1. 调用 `/api/auth/send-verification-code` 发送注册验证码
    2. 用户收到验证码后，调用此接口完成注册
    3. 注册成功后，对应的邮箱或手机号自动设置为已验证状态
    4. 自动创建认证会话并返回 Token（与 login 响应格式一致）

    ## 注意事项
    - 必须提供邮箱或手机号之一
    - 验证码有效期为10分钟
    - 密码需满足强度要求
    - 用户名可选，用于@username主页标识
    """
    try:
        # IP 级别速率限制
        ip_address = get_client_ip(request)
        rate_ok, rate_msg = _check_verify_submit_ip_rate(ip_address)
        if not rate_ok:
            return 429, ApiResponseSchema(
                success=False,
                message=rate_msg,
                code="RATE_LIMITED"
            )

        # 验证必须提供邮箱或手机号
        if not data.email and not data.phone:
            return 400, ApiResponseSchema(
                success=False,
                message=_("auth.email_or_phone_required"),
                code="VALIDATION_ERROR"
            )

        # 验证数据格式（移除Schema validator后的业务逻辑验证）
        if data.phone and not re.match(PHONE_REGEX, data.phone):
            return 400, ApiResponseSchema(
                success=False,
                message=_("auth.phone_format_invalid"),
                code="VALIDATION_ERROR"
            )

        if data.username:
            if not re.match(r'^[a-zA-Z0-9_]+$', data.username):
                return 400, ApiResponseSchema(
                    success=False,
                    message=_("auth.username_alphanumeric_only"),
                    code="VALIDATION_ERROR"
                )
            if data.username[0].isdigit():
                return 400, ApiResponseSchema(
                    success=False,
                    message=_("auth.username_no_leading_digit"),
                    code="VALIDATION_ERROR"
                )

        if not data.verification_code.isdigit() or len(data.verification_code) != 6:
            return 400, ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_must_be_6_digits"),
                code="VALIDATION_ERROR"
            )

        # 验证密码强度
        validate_user_password(data.password)

        # 确定验证码缓存键
        username = data.email if data.email else data.phone

        # 所有不依赖验证码的校验都通过后，再验证验证码。这里先不删除，
        # 等用户创建和 onboarding 成功后再消费，避免密码/唯一性等后续失败
        # 让用户反复收新验证码。
        is_valid = VerificationCodeManager.verify_code(
            username,
            data.verification_code,
            'register',
            delete_after_verify=False,
        )
        if not is_valid:
            return 400, ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="AUTH_VERIFICATION_CODE_INVALID"
            )

        from apps.users.auth.phone import canonicalize_phone

        # 中国大陆号统一存 11 位，避免 +86 与国内号并存成两个账号
        normalized_phone = canonicalize_phone(data.phone) if data.phone else data.phone

        # 验证唯一性。放在验证码确认之后，保持原有账号枚举口径；同时因为
        # 上面没有删除验证码，唯一性失败也不会让用户重新收码。
        if data.email:
            validate_unique_email(data.email)
        if normalized_phone:
            validate_unique_phone(normalized_phone)
        if data.username:
            validate_unique_username(data.username)

        # 创建用户
        user_data = {
            'email': data.email,
            'phone': normalized_phone,
            'password': data.password,
        }

        # username：用户填了就用；没填则按邮箱前缀 / 手机后4位自动补一个，
        # 与验证码自动注册口径一致，避免出现「有的账号没有 @用户名」的不一致。
        if data.username:
            user_data['username'] = data.username
        else:
            user_data['username'] = _generate_unique_username(
                email=data.email, phone=normalized_phone
            )
        if data.nickname:
            user_data['nickname'] = data.nickname

        from apps.users.auth.user_onboarding import create_user_with_personal_onboarding

        profile_language = data.language if data.language and data.language != 'system' else None
        user = create_user_with_personal_onboarding(
            request,
            user_data=user_data,
            profile_language=profile_language,
        )

        # 根据注册方式设置验证状态
        if data.email:
            user.is_verified_email = True
        if data.phone:
            user.is_verified_phone = True
        user.save(update_fields=['is_verified_email', 'is_verified_phone'])

        if not _ensure_personal_organization_before_login(user, cleanup_new_user=True):
            return 500, ApiResponseSchema(
                success=False,
                message=_("common.operation_failed"),
                code="PERSONAL_ORGANIZATION_REQUIRED",
            )

        # 记录注册日志
        log_user_action(user, 'register', request, description="用户注册成功")

        VerificationCodeManager.delete_code(username, 'register')

        # 注册后自动登录：复用统一的会话创建逻辑
        access_token, refresh_token, access_expire_hours = _create_auth_session(
            user, request, remember_me=False,
        )

        log_user_action(user, 'login', request, description="注册后自动登录")

        return success_response(data=LoginResponseSchema(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=access_expire_hours * 3600,
            user=_build_user_info(user),
            is_new_user=True,
        ).model_dump())

    except ValidationError as e:
        return 400, ApiResponseSchema(
            success=False,
            message=format_validation_error(e),
            code="VALIDATION_ERROR"
        )
    except Exception:
        logger.exception("register_user 内部异常")
        return 500, ApiResponseSchema(
            success=False,
            message=_("common.operation_failed"),
            code="INTERNAL_ERROR"
        )


@router.post("/login", response={200: dict, 400: ApiResponseSchema, 401: LoginErrorResponseSchema, 429: ApiResponseSchema, 500: ApiResponseSchema}, auth=None, tags=["认证"])
def login_user(request: HttpRequest, data: UserLoginSchema):
    """用户登录"""
    try:
        # ==================== IP/账号 级限流（防暴力破解） ====================
        ip_address = get_client_ip(request)
        rate_ok, rate_msg = check_login_rate_limit(data.username, ip_address)
        if not rate_ok:
            identifier = data.username
            if '@' in identifier:
                identifier = mask_email(identifier)
            elif is_phone_number(identifier):
                identifier = mask_phone(identifier)
            log_security_event(
                "login_rate_limited",
                request,
                success=False,
                reason="rate_limited",
                extra={"identifier": identifier}
            )
            return 429, ApiResponseSchema(
                success=False,
                message=rate_msg,
                code="RATE_LIMITED"
            )

        from ..authentication import MultiFieldAuthBackend

        # 锁定窗口内的重试只返回剩余时间，不验证密码、不累计新的失败次数，
        # 因而不会因为用户反复点击而延长锁定窗口。
        probed_user = MultiFieldAuthBackend()._get_user_by_identifier(data.username)
        if probed_user is not None and probed_user.is_account_locked():
            log_security_event(
                "login_failed",
                request,
                user=probed_user,
                success=False,
                reason="account_locked",
            )
            return _account_locked_response(probed_user)

        user = authenticate(
            request=request,
            username=data.username,
            password=data.password
        )

        if user is None:
            # authenticate() 对「账号锁定」与「凭据错误」都返回 None（见 authentication.py
            # MultiFieldAuthBackend：锁定直接 return None，密码错误也 return None）。
            # 这里补查一次用户：若账号存在且已被锁定，返回明确的「账号已锁定」提示，
            # 而不是和密码错误一样笼统报「用户名或密码错误」（否则用户被锁后毫无感知）。
            probed_user = MultiFieldAuthBackend()._get_user_by_identifier(data.username)

            record_rate_limit_hit("login", data.username, ip_address)
            identifier = data.username
            if '@' in identifier:
                identifier = mask_email(identifier)
            elif is_phone_number(identifier):
                identifier = mask_phone(identifier)

            if probed_user is not None and probed_user.is_account_locked():
                log_security_event(
                    "login_failed",
                    request,
                    user=probed_user,
                    success=False,
                    reason="account_locked"
                )
                return _account_locked_response(probed_user)

            log_security_event(
                "login_failed",
                request,
                success=False,
                reason="invalid_credentials",
                extra={"identifier": identifier}
            )
            return 401, ApiResponseSchema(
                success=False,
                message=_("auth.invalid_credentials"),
                code="AUTH_INVALID"
            )

        if not user.is_active:
            record_rate_limit_hit("login", data.username, ip_address)
            log_security_event(
                "login_failed",
                request,
                user=user,
                success=False,
                reason="user_disabled"
            )
            return 401, ApiResponseSchema(
                success=False,
                message=_("auth.account_disabled"),
                code="UNAUTHORIZED"
            )

        # 注：账号锁定已在上方 `user is None` 分支内处理（authenticate 会把锁定账号
        # 吞成 None），故此处无需再判 is_account_locked —— 能走到这里的 user 必然未锁定。

        if not _ensure_personal_organization_before_login(user):
            return 500, ApiResponseSchema(
                success=False,
                message=_("common.operation_failed"),
                code="PERSONAL_ORGANIZATION_REQUIRED",
            )

        # 创建认证会话并生成 Token
        access_token, refresh_token, access_expire_hours = _create_auth_session(
            user, request, remember_me=data.remember_me,
        )

        # 记录操作日志
        log_user_action(user, 'login', request, description="用户登录成功")

        return success_response(data=LoginResponseSchema(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=access_expire_hours * 3600,
            user=_build_user_info(user),
        ).model_dump())

    except Exception:
        logger.exception("login_user 内部异常")
        return 500, ApiResponseSchema(
            success=False,
            message=_("common.operation_failed"),
            code="INTERNAL_ERROR"
        )



@router.post(
    "/login/verification-code",
    response={200: dict, 400: ApiResponseSchema, 401: ApiResponseSchema, 500: ApiResponseSchema},
    auth=None,
    tags=["认证"]
)
def login_with_verification_code(request: HttpRequest, data: VerificationCodeLoginSchema):
    """
    验证码登录/自动注册

    ## 功能说明
    使用验证码进行登录，如果用户不存在则自动注册。

    ## 自动注册逻辑
    - 如果邮箱/手机号已注册，直接登录
    - 如果邮箱/手机号未注册，自动创建新用户并登录
    - 自动注册的用户对应的邮箱/手机号会自动设置为已验证状态

    ## 注意事项
    - 验证码有效期为5分钟
    - 自动注册的用户会生成随机用户名
    - 可以降低用户注册门槛，提升用户体验
    """
    identifier = mask_identifier(data.username)
    logger.info("验证码登录请求: username=%s", identifier)

    try:
        # IP 级别速率限制
        ip_address = get_client_ip(request)
        rate_ok, rate_msg = _check_verify_submit_ip_rate(ip_address)
        if not rate_ok:
            return 400, ApiResponseSchema(
                success=False,
                message=rate_msg,
                code="RATE_LIMITED"
            )

        # 使用统一的验证码管理器验证
        is_valid = VerificationCodeManager.verify_code(
            data.username,
            data.verification_code,
            'login',
            delete_after_verify=True,
            challenge_key=data.challenge_key,
        )

        if not is_valid:
            identifier = data.username
            if '@' in identifier:
                identifier = mask_email(identifier)
            elif is_phone_number(identifier):
                identifier = mask_phone(identifier)
            log_security_event(
                "code_login_failed",
                request,
                success=False,
                reason="invalid_verification_code",
                extra={"identifier": identifier}
            )
            return 400, ApiResponseSchema(
                success=False,
                message=_("auth.verification_code_invalid"),
                code="AUTH_VERIFICATION_CODE_INVALID"
            )

        # 获取或创建用户
        from apps.users.auth.phone import (
            canonicalize_phone,
            maybe_canonicalize_stored_phone,
            resolve_user_by_phone,
        )

        user = None
        is_new_user = False

        if '@' in data.username:
            try:
                user = User.objects.get(email=data.username, is_active=True)
            except User.DoesNotExist:
                user = None
        else:
            # +86 / 11 位互认，避免同一号再自动注册出一个账号
            user = resolve_user_by_phone(data.username, active_only=True)

        # 验证码有独立的校验与限流，是密码锁定后的安全恢复通道。
        # 验证成功后下方 increment_login_count() 会清理密码失败状态。
        if user is None:
            # 用户不存在，自动注册
            is_new_user = True
            user_data = {}

            if '@' in data.username:
                # 邮箱注册
                user_data['email'] = data.username
                user_data['is_verified_email'] = True
                username = _generate_unique_username(email=data.username)
            else:
                # 手机号注册：规范入库
                normalized_phone = canonicalize_phone(data.username) or data.username.strip()
                user_data['phone'] = normalized_phone
                user_data['is_verified_phone'] = True
                username = _generate_unique_username(phone=normalized_phone)

            user_data['username'] = username
            user_data['nickname'] = username  # 默认昵称与用户名相同

            from apps.users.auth.user_onboarding import create_user_with_personal_onboarding

            user = create_user_with_personal_onboarding(request, user_data=user_data)

            log_user_action(user, 'auto_register', request, description="验证码登录自动注册")
        elif '@' not in data.username:
            maybe_canonicalize_stored_phone(user)

        if not _ensure_personal_organization_before_login(user):
            return 500, ApiResponseSchema(
                success=False,
                message=_("common.operation_failed"),
                code="PERSONAL_ORGANIZATION_REQUIRED",
            )

        # 更新登录统计
        user.increment_login_count()

        # 创建认证会话并生成 Token
        access_token, refresh_token, access_expire_hours = _create_auth_session(
            user, request, remember_me=data.remember_me,
        )

        # 记录操作日志
        action_description = "验证码登录自动注册并登录成功" if is_new_user else "验证码登录成功"
        log_user_action(user, 'login', request, description=action_description)

        return success_response(data=LoginResponseSchema(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=access_expire_hours * 3600,
            user=_build_user_info(user),
            is_new_user=is_new_user,
        ).model_dump())

    except Exception:
        logger.exception("login_with_verification_code 内部异常")
        return 500, ApiResponseSchema(
            success=False,
            message=_("common.operation_failed"),
            code="INTERNAL_ERROR"
        )


@router.post("/logout", response=ApiResponseSchema, auth=jwt_auth, tags=["认证"])
def logout_user(request: HttpRequest):
    """用户登出"""
    try:
        user = request.auth

        # 获取当前会话并设为非活跃（优先使用 sid 绑定）
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:]
            payload = verify_jwt_token(token)
            session_key = payload.get('sid') if payload else None
            if session_key:
                SessionManager.invalidate_session(session_key)

        # RB-004: 通知 collab-live 撤销协作连接 + Centrifugo 断连
        _notify_logout_revocations(str(user.id))

        # 记录操作日志
        log_user_action(user, 'logout', request, description="用户登出")

        return ApiResponseSchema(
            success=True,
            message=_("auth.logout_success")
        )

    except Exception:
        logger.exception("logout_user 内部异常")
        return ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )

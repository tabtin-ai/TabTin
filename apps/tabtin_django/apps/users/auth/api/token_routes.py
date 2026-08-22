"""Token 刷新相关 API 路由"""
from ninja import Router

from ._shared import (
    verify_jwt_token,
    generate_jwt_token,
    User,
    UserSession,
    SessionManager,
    hash_string,
    get_client_ip,
    log_security_event,
    log_user_action,
    _check_refresh_token_rate,
    REFRESH_GRACE_WINDOW_SECONDS,
    success_response,
    RefreshTokenResponseSchema,
    RefreshTokenSchema,
    ApiResponseSchema,
    _,
    timezone,
    timedelta,
    transaction,
    logger,
    HttpRequest,
)

router = Router(tags=["认证"])


@router.post("/refresh-token", response={200: dict, 401: ApiResponseSchema, 403: ApiResponseSchema, 404: ApiResponseSchema, 409: ApiResponseSchema, 429: ApiResponseSchema, 500: ApiResponseSchema}, auth=None, tags=["认证"])
def refresh_token(request: HttpRequest, data: RefreshTokenSchema):
    """
    刷新Token

    ## 功能说明
    使用有效的 refresh_token 换取新的 access_token 和 refresh_token。

    ## Token 生命周期
    - **Access Token**:
      - 默认有效期：24小时（86400秒）
      - 记住我：7天（604800秒）
    - **Refresh Token**:
      - 默认有效期：7天（604800秒）
      - 记住我：30天（2592000秒）

    ## 刷新策略
    1. 每次刷新都会生成新的 access_token 和 refresh_token
    2. 前端应在收到新token后立即更新本地存储
    3. 会话过期或失效将拒绝刷新

    ## 安全特性
    - Token 类型检查与用户状态校验
    - 会话绑定校验（sid）
    - 记录刷新日志用于审计

    ## 最佳实践
    - 在 access_token 过期前（建议提前5分钟）主动刷新
    - 刷新失败时清空本地存储并引导用户重新登录
    - 使用安全存储方式保存 tokens（如 Keytar）

    ## 错误处理
    - `401`: Refresh Token 无效或已过期 → 需要重新登录
    - `403`: Token 类型错误（提交了 access_token 而非 refresh_token）
    - `404`: 用户不存在或已被禁用 → 需要重新登录
    - `429`: 刷新过于频繁（`RATE_LIMITED`）→ 保留凭证稍后重试，勿当登出
    - `500`: 服务器内部错误 → 稍后重试
    """
    try:
        ip_address = get_client_ip(request)
        rate_ok, rate_msg = _check_refresh_token_rate(ip_address)
        if not rate_ok:
            log_security_event(
                "refresh_token_rate_limited",
                request,
                success=False,
                reason="rate_limited",
            )
            return 429, ApiResponseSchema(
                success=False,
                message=rate_msg,
                code="RATE_LIMITED"
            )

        # 验证 refresh_token
        payload = verify_jwt_token(data.refresh_token)
        if not payload:
            log_security_event(
                "refresh_token_failed",
                request,
                success=False,
                reason="invalid_or_expired"
            )
            return 401, ApiResponseSchema(
                success=False,
                message=_("auth.refresh_token_invalid"),
                code="UNAUTHORIZED"
            )

        # 检查 token 类型
        token_type = payload.get('token_type')
        if token_type != 'refresh':
            log_security_event(
                "refresh_token_failed",
                request,
                success=False,
                reason="wrong_token_type"
            )
            return 403, ApiResponseSchema(
                success=False,
                message=_("auth.wrong_token_type"),
                code="FORBIDDEN"
            )

        # 获取用户
        try:
            user = User.objects.get(id=payload['user_id'])
        except User.DoesNotExist:
            log_security_event(
                "refresh_token_failed",
                request,
                success=False,
                reason="user_not_found",
                extra={"user_id": payload.get('user_id')}
            )
            return 404, ApiResponseSchema(
                success=False,
                message=_("auth.user_not_found_relogin"),
                code="NOT_FOUND"
            )

        # 检查用户状态
        if not user.is_active:
            log_security_event(
                "refresh_token_failed",
                request,
                user=user,
                success=False,
                reason="user_disabled"
            )
            return 403, ApiResponseSchema(
                success=False,
                message=_("auth.account_disabled"),
                code="FORBIDDEN"
            )

        # 记住我语义（优先 token 标记，兼容旧token用iat/exp推断）
        remember_me = payload.get('remember_me')
        if remember_me is None:
            exp_ts = payload.get('exp')
            iat_ts = payload.get('iat')
            if isinstance(exp_ts, (int, float)) and isinstance(iat_ts, (int, float)):
                ttl_hours = (exp_ts - iat_ts) / 3600
                remember_me = ttl_hours >= 24 * 14
            else:
                remember_me = False

        # 生成新的 tokens（与登录一致）
        access_expire_hours = 24 * 7 if remember_me else 24
        refresh_expire_hours = 24 * 30 if remember_me else 24 * 7

        # 绑定会话校验（要求 sid）
        session_key = payload.get('sid')
        session = None
        if not session_key:
            log_security_event(
                "refresh_token_failed",
                request,
                user=user,
                success=False,
                reason="missing_sid"
            )
            return 401, ApiResponseSchema(
                success=False,
                message=_("auth.session_expired"),
                code="UNAUTHORIZED"
            )

        rate_ok, rate_msg = _check_refresh_token_rate(None, session_key=session_key)
        if not rate_ok:
            log_security_event(
                "refresh_token_rate_limited",
                request,
                user=user,
                success=False,
                reason="session_rate_limited",
                extra={"session_key": session_key[:10]}
            )
            return 429, ApiResponseSchema(
                success=False,
                message=rate_msg,
                code="RATE_LIMITED"
            )

        # CR-001/CR-002/CR-003/CR-004/CR-005:
        # 整个 validate → hash 检测 → token 生成 → DB 写入 在同一事务+行锁内完成，
        # 消除 TOCTOU 窗口；仅在 DB 写入成功后才返回新 token 给客户端。
        with transaction.atomic():
            session = SessionManager.validate_session_for_refresh(session_key)
            if not session or str(session.user_id) != str(user.id):
                log_security_event(
                    "refresh_token_failed",
                    request,
                    user=user,
                    success=False,
                    reason="session_invalid",
                    extra={"session_key": session_key[:10] if session_key else None}
                )
                return 401, ApiResponseSchema(
                    success=False,
                    message=_("auth.session_expired"),
                    code="UNAUTHORIZED"
                )

            if not session.refresh_token_hash:
                UserSession.objects.filter(pk=session.pk).update(is_active=False)
                log_security_event(
                    "refresh_token_failed",
                    request,
                    user=user,
                    success=False,
                    reason="missing_refresh_token_hash",
                    extra={"session_key": session_key[:10]}
                )
                return 401, ApiResponseSchema(
                    success=False,
                    message=_("auth.session_expired"),
                    code="UNAUTHORIZED"
                )

            current_hash = hash_string(data.refresh_token)
            if session.refresh_token_hash != current_hash:
                # CR-004: 宽限窗口——若 refresh_token_updated_at 在近几秒内被更新，
                # 说明是合法的多标签页并发刷新，返回 409 而非误杀 session。
                if (session.refresh_token_updated_at and
                        (timezone.now() - session.refresh_token_updated_at).total_seconds()
                        < REFRESH_GRACE_WINDOW_SECONDS):
                    log_security_event(
                        "refresh_token_conflict",
                        request,
                        user=user,
                        success=False,
                        reason="concurrent_refresh",
                        extra={"session_key": session_key[:10]}
                    )
                    return 409, ApiResponseSchema(
                        success=False,
                        message="Token 刷新冲突，请重试",
                        code="REFRESH_CONFLICT"
                    )
                UserSession.objects.filter(pk=session.pk).update(is_active=False)
                log_security_event(
                    "refresh_token_reuse",
                    request,
                    user=user,
                    success=False,
                    reason="refresh_token_reused",
                    extra={"session_key": session_key[:10]}
                )
                return 401, ApiResponseSchema(
                    success=False,
                    message=_("auth.refresh_token_revoked"),
                    code="UNAUTHORIZED"
                )

            new_access_token = generate_jwt_token(
                user,
                access_expire_hours,
                token_type='access',
                session_key=session_key,
                remember_me=remember_me
            )
            new_refresh_token = generate_jwt_token(
                user,
                refresh_expire_hours,
                token_type='refresh',
                session_key=session_key,
                remember_me=remember_me
            )

            # CR-003: 乐观锁 UPDATE — WHERE 条件包含 refresh_token_hash=<old_hash>，
            # 防止 last-write-wins 覆盖。即使 select_for_update 已序列化访问，
            # 此条件作为纵深防御确保不会覆盖他人的写入。
            now = timezone.now()
            new_hash = hash_string(new_refresh_token)
            updated = UserSession.objects.filter(
                pk=session.pk,
                refresh_token_hash=current_hash,
            ).update(
                expires_at=now + timedelta(hours=refresh_expire_hours),
                refresh_token_hash=new_hash,
                refresh_token_updated_at=now,
                last_activity=now,
            )

            if updated == 0:
                log_security_event(
                    "refresh_token_conflict",
                    request,
                    user=user,
                    success=False,
                    reason="optimistic_lock_failed",
                    extra={"session_key": session_key[:10]}
                )
                return 409, ApiResponseSchema(
                    success=False,
                    message="Token 刷新冲突，请重试",
                    code="REFRESH_CONFLICT"
                )

        # CR-005: 仅在事务成功提交后才返回新 token 给客户端
        log_user_action(user, 'refresh_token', request, description="Token刷新成功")

        return success_response(data=RefreshTokenResponseSchema(
            access_token=new_access_token,
            refresh_token=new_refresh_token,
            token_type="Bearer",
            expires_in=access_expire_hours * 3600
        ).model_dump())

    except Exception:
        logger.exception("refresh_token 内部异常")
        return 500, ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR"
        )


@router.post("/refresh", response={200: dict, 401: ApiResponseSchema, 403: ApiResponseSchema, 404: ApiResponseSchema, 409: ApiResponseSchema, 500: ApiResponseSchema}, auth=None, tags=["认证"])
def refresh_token_compat(request: HttpRequest, data: RefreshTokenSchema):
    """兼容旧客户端的 refresh 接口"""
    return refresh_token(request, data)

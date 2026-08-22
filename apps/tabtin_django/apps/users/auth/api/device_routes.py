"""
OAuth Device Authorization Flow（，简化版 RFC 8628）

给独立 CLI（无浏览器、无 Electron/Daemon）提供设备授权登录：
1. POST /device/code    — CLI 申请 device_code + user_code，auth=None
2. POST /device/approve — 已登录用户在授权确认页确认/拒绝，auth=jwt_auth
3. POST /device/token   — CLI 轮询用 device_code 换取 access/refresh，auth=None

存储：优先使用 Django cache（生产环境为 Redis，见 settings.CACHES），
借助 cache 的 TTL 天然实现 900 秒过期语义，不新增数据库表。
签发：复用现有 UserSession / JWT，approve 阶段不签发任何 token，
仅在 token 端点内对 status=approved 的记录调用 `_create_auth_session`，
成功后立即删除 cache 记录，防止 device_code / user_code 被重放。
"""
import secrets

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from ninja import Router

from ._shared import (
    HttpRequest,
    success_response,
    logger,
    User,
    jwt_auth,
    get_client_ip,
    hash_string,
    check_simple_rate_limit,
    log_security_event,
    log_user_action,
    _build_user_info,
    _create_auth_session,
    ApiResponseSchema,
    LoginResponseSchema,
)
from ..schemas import (
    DeviceCodeRequestSchema,
    DeviceCodeResponseSchema,
    DeviceApproveSchema,
    DeviceTokenRequestSchema,
)

router = Router(tags=["认证"])

# ── 限流常量 ──
# device_code 申请端点未鉴权，按 IP 限流防止被用来批量占用 user_code 命名空间。
DEVICE_CODE_IP_MAX = 20
DEVICE_CODE_IP_WINDOW = 300


class DeviceAuthorizationStore:
    """基于 Django cache 的 device_code 状态存储（pending/approved/denied）。

    Key 设计：
    - device_auth:code:<device_code>     -> 完整状态 dict（CLI 轮询用）
    - device_auth:usercode:<user_code>   -> device_code（授权确认页按短码反查用）

    两个 key 的 TTL 保持一致，成功换取 token 或状态非法时需要成对删除，
    避免 user_code 索引失效后 device_code 记录仍可被访问（或反之）。
    """

    TTL_SECONDS = 900
    MIN_POLL_INTERVAL_SECONDS = 5
    # 排除易混淆字符 0/O、1/I，人工抄码时不易出错
    _USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789"

    @classmethod
    def _device_key(cls, device_code: str) -> str:
        return f"device_auth:code:{device_code}"

    @classmethod
    def _user_code_key(cls, user_code: str) -> str:
        return f"device_auth:usercode:{user_code}"

    @classmethod
    def _generate_user_code(cls) -> str:
        for _attempt in range(5):
            raw = ''.join(secrets.choice(cls._USER_CODE_ALPHABET) for _ in range(8))
            user_code = f"{raw[:4]}-{raw[4:]}"
            if cache.get(cls._user_code_key(user_code)) is None:
                return user_code
        # 极端情况下（5 次均撞码）直接使用最后一次生成结果，
        # 冲突概率约 (1/29^8)^5，可忽略。
        return user_code

    @classmethod
    def create(cls, client_id: str, device_name: str) -> dict:
        """生成新的 device_code/user_code 并写入 cache，状态初始为 pending。"""
        device_code = secrets.token_urlsafe(32)
        user_code = cls._generate_user_code()
        record = {
            "device_code": device_code,
            "user_code": user_code,
            "client_id": client_id or "",
            "device_name": device_name or "",
            "status": "pending",
            "user_id": None,
            "created_at": timezone.now().isoformat(),
            "last_poll_ts": None,
        }
        cache.set(cls._device_key(device_code), record, cls.TTL_SECONDS)
        cache.set(cls._user_code_key(user_code), device_code, cls.TTL_SECONDS)
        return record

    @classmethod
    def get_by_device_code(cls, device_code: str) -> dict | None:
        return cache.get(cls._device_key(device_code))

    @classmethod
    def get_by_user_code(cls, user_code: str) -> dict | None:
        device_code = cache.get(cls._user_code_key(user_code))
        if not device_code:
            return None
        return cls.get_by_device_code(device_code)

    @classmethod
    def save(cls, record: dict) -> None:
        """按剩余 TTL 覆写记录；不重置过期时间，防止无限续期绕开 900s 上限。"""
        cache.set(cls._device_key(record["device_code"]), record, cls.TTL_SECONDS)

    @classmethod
    def delete(cls, record: dict) -> None:
        cache.delete(cls._device_key(record["device_code"]))
        cache.delete(cls._user_code_key(record["user_code"]))


def _verification_uri() -> str:
    return getattr(settings, 'TABTIN_DEVICE_VERIFY_URL', 'http://localhost:5175/device')


@router.post(
    "/device/code",
    response={200: dict, 429: ApiResponseSchema, 500: ApiResponseSchema},
    auth=None,
    tags=["认证"],
)
def request_device_code(request: HttpRequest, data: DeviceCodeRequestSchema):
    """CLI 独立登录 Step 1：申请 device_code + user_code。

    对齐 RFC 8628 Device Authorization Request/Response 语义，未鉴权，
    仅按 IP 限流防止滥用。
    """
    try:
        ip_address = get_client_ip(request)
        rate_key = f"device_code_rate:{hash_string(ip_address)}"
        if not check_simple_rate_limit(rate_key, DEVICE_CODE_IP_MAX, DEVICE_CODE_IP_WINDOW):
            return 429, ApiResponseSchema(
                success=False,
                message="申请过于频繁，请稍后再试",
                code="RATE_LIMITED",
            )

        record = DeviceAuthorizationStore.create(
            client_id=data.client_id,
            device_name=data.device_name or "",
        )

        verify_uri = _verification_uri()
        payload = DeviceCodeResponseSchema(
            device_code=record["device_code"],
            user_code=record["user_code"],
            verification_uri=verify_uri,
            verification_uri_complete=f"{verify_uri}?user_code={record['user_code']}",
            expires_in=DeviceAuthorizationStore.TTL_SECONDS,
            interval=DeviceAuthorizationStore.MIN_POLL_INTERVAL_SECONDS,
        )

        log_security_event(
            "device_code_issued",
            request,
            success=True,
            extra={"client_id": data.client_id, "device_name": data.device_name or ""},
        )
        return success_response(data=payload.model_dump())

    except Exception:
        logger.exception("request_device_code 内部异常")
        return 500, ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR",
        )


@router.post(
    "/device/approve",
    response={200: dict, 404: ApiResponseSchema, 409: ApiResponseSchema, 500: ApiResponseSchema},
    auth=jwt_auth,
    tags=["认证"],
)
def approve_device_code(request: HttpRequest, data: DeviceApproveSchema):
    """CLI 独立登录 Step 2：已登录用户在授权确认页确认/拒绝该 user_code。

    仅记录状态，不在此签发任何 token —— token 统一由 /device/token 签发，
    避免用户浏览器和 CLI 两处都拿到凭据。
    """
    try:
        user = request.auth
        record = DeviceAuthorizationStore.get_by_user_code(data.user_code)
        if record is None:
            return 404, ApiResponseSchema(
                success=False,
                message="授权码不存在或已过期，请在 CLI 重新发起登录",
                code="NOT_FOUND",
            )

        if record["status"] != "pending":
            return 409, ApiResponseSchema(
                success=False,
                message="该授权码已被处理，请在 CLI 重新发起登录",
                code="ALREADY_PROCESSED",
            )

        record["status"] = "approved" if data.approve else "denied"
        record["user_id"] = str(user.id) if data.approve else None
        DeviceAuthorizationStore.save(record)

        log_security_event(
            "device_code_approved" if data.approve else "device_code_denied",
            request,
            user=user,
            success=True,
            extra={"user_code": data.user_code, "client_id": record.get("client_id", "")},
        )

        return success_response(
            message="已同意授权" if data.approve else "已拒绝授权",
            data={"status": record["status"], "device_name": record.get("device_name", "")},
        )

    except Exception:
        logger.exception("approve_device_code 内部异常")
        return 500, ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR",
        )


@router.post(
    "/device/token",
    response={200: dict, 400: ApiResponseSchema, 403: ApiResponseSchema, 404: ApiResponseSchema, 500: ApiResponseSchema},
    auth=None,
    tags=["认证"],
)
def device_token(request: HttpRequest, data: DeviceTokenRequestSchema):
    """CLI 独立登录 Step 3：轮询用 device_code 换取 access/refresh token。

    对齐 RFC 8628 Device Access Token Response 错误语义：
    pending -> AUTHORIZATION_PENDING；denied -> ACCESS_DENIED；
    过期/不存在 -> EXPIRED_TOKEN；轮询过快 -> SLOW_DOWN。
    """
    try:
        record = DeviceAuthorizationStore.get_by_device_code(data.device_code)
        if record is None:
            return 400, ApiResponseSchema(
                success=False,
                message="device_code 不存在或已过期，请重新登录",
                code="EXPIRED_TOKEN",
            )

        now_ts = timezone.now().timestamp()
        last_poll_ts = record.get("last_poll_ts")
        if last_poll_ts is not None and (now_ts - last_poll_ts) < DeviceAuthorizationStore.MIN_POLL_INTERVAL_SECONDS:
            return 400, ApiResponseSchema(
                success=False,
                message="轮询过于频繁，请放慢速度",
                code="SLOW_DOWN",
            )
        record["last_poll_ts"] = now_ts
        DeviceAuthorizationStore.save(record)

        if record["status"] == "pending":
            return 400, ApiResponseSchema(
                success=False,
                message="等待用户在浏览器完成授权确认",
                code="AUTHORIZATION_PENDING",
            )

        if record["status"] == "denied":
            # 拒绝态一次性消费：删除记录防止重复轮询继续拿到 ACCESS_DENIED 之外的信息
            DeviceAuthorizationStore.delete(record)
            return 400, ApiResponseSchema(
                success=False,
                message="用户已拒绝授权",
                code="ACCESS_DENIED",
            )

        # status == "approved"
        user_id = record.get("user_id")
        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            DeviceAuthorizationStore.delete(record)
            return 404, ApiResponseSchema(
                success=False,
                message="用户不存在，请重新登录",
                code="NOT_FOUND",
            )

        if not user.is_active:
            DeviceAuthorizationStore.delete(record)
            return 403, ApiResponseSchema(
                success=False,
                message="账号已禁用",
                code="FORBIDDEN",
            )

        access_token, refresh_token, access_expire_hours = _create_auth_session(
            user, request, remember_me=False, session_type='api',
        )

        # 成功换取后立即删除，防止 device_code / user_code 被重放
        DeviceAuthorizationStore.delete(record)

        log_user_action(user, 'device_flow_login', request, description="CLI Device Flow 登录成功")
        log_security_event(
            "device_flow_token_issued",
            request,
            user=user,
            success=True,
            extra={"client_id": record.get("client_id", "")},
        )

        return success_response(data=LoginResponseSchema(
            access_token=access_token,
            refresh_token=refresh_token,
            token_type="Bearer",
            expires_in=access_expire_hours * 3600,
            user=_build_user_info(user),
            is_new_user=False,
        ).model_dump())

    except Exception:
        logger.exception("device_token 内部异常")
        return 500, ApiResponseSchema(
            success=False,
            message="操作失败，请稍后重试",
            code="INTERNAL_ERROR",
        )

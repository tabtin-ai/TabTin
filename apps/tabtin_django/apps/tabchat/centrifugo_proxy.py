"""Centrifugo Proxy 回调端点。

Centrifugo 在连接、订阅、发布时回调这些端点，由 Django 进行鉴权。
这些端点不走 JWT 认证，通过 X-Centrifugo-Proxy-Secret header 校验来源。
"""

from __future__ import annotations

import hmac
import ipaddress
import logging
import time
import uuid

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.http import JsonResponse
from django.utils import timezone
from ninja import Router, Schema

from apps.users.auth.utils import verify_jwt_token
from apps.users.auth.session_manager import SessionManager

logger = logging.getLogger(__name__)
User = get_user_model()

_PROXY_SECRET_HEADER = "X-Centrifugo-Proxy-Secret"

_DEFAULT_ALLOWED_IPS = ("127.0.0.1", "::1")
_CENTRIFUGO_CONNECT_PATH = "/api/im/centrifugo/connect"


def _is_centrifugo_connect_request(request) -> bool:
    return getattr(request, "path", "") == _CENTRIFUGO_CONNECT_PATH


def _get_centrifugo_trace_id(request) -> str:
    trace_id = getattr(request, "_centrifugo_trace_id", "")
    if trace_id:
        return trace_id
    trace_id = uuid.uuid4().hex[:8]
    request._centrifugo_trace_id = trace_id
    return trace_id


def _get_centrifugo_connect_started_at(request) -> float:
    started_at = getattr(request, "_centrifugo_connect_started_at", 0.0)
    if started_at:
        return started_at
    started_at = time.perf_counter()
    request._centrifugo_connect_started_at = started_at
    return started_at


def _format_trace_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None or value == "":
        return "-"
    return str(value)


def _log_centrifugo_connect(request, stage: str, level: int = logging.INFO, **fields) -> None:
    if not _is_centrifugo_connect_request(request):
        return

    trace_id = _get_centrifugo_trace_id(request)
    elapsed_ms = (time.perf_counter() - _get_centrifugo_connect_started_at(request)) * 1000
    details = " ".join(
        f"{key}={_format_trace_value(value)}" for key, value in fields.items()
    )
    message = (
        f"[CentrifugoConnect:{trace_id}] {stage} elapsed_ms={elapsed_ms:.1f}"
        if not details
        else f"[CentrifugoConnect:{trace_id}] {stage} elapsed_ms={elapsed_ms:.1f} {details}"
    )
    logger.log(level, message)


def _ip_matches_list(
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address,
    entries,
) -> bool:
    """检查 *ip* 是否命中白名单 *entries* 中的任何条目（支持单 IP 和 CIDR）。"""
    for entry in entries:
        try:
            if "/" in entry:
                if ip in ipaddress.ip_network(entry, strict=False):
                    return True
            else:
                if ip == ipaddress.ip_address(entry):
                    return True
        except ValueError:
            continue
    return False


def _resolve_source_ip(request, remote_addr: str) -> str:
    """在反向代理场景下，从可信代理头提取真实来源 IP（FP-003 修复）。

    当 REMOTE_ADDR 属于 CENTRIFUGO_TRUSTED_PROXIES 时，
    优先读取 X-Real-IP，回退到 X-Forwarded-For 最右侧非代理 IP。
    未配置可信代理或 REMOTE_ADDR 不在可信列表中时，原样返回 REMOTE_ADDR。
    """
    trusted_proxies = getattr(settings, "CENTRIFUGO_TRUSTED_PROXIES", [])
    if not trusted_proxies:
        return remote_addr

    try:
        remote_ip = ipaddress.ip_address(remote_addr)
    except ValueError:
        return remote_addr

    if not _ip_matches_list(remote_ip, trusted_proxies):
        return remote_addr

    x_real_ip = request.META.get("HTTP_X_REAL_IP", "").strip()
    if x_real_ip:
        try:
            ipaddress.ip_address(x_real_ip)
            return x_real_ip
        except ValueError:
            pass

    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        for ip_str in reversed(parts):
            try:
                ip = ipaddress.ip_address(ip_str)
            except ValueError:
                continue
            if not _ip_matches_list(ip, trusted_proxies):
                return ip_str

    return remote_addr


def _check_proxy_ip(request) -> JsonResponse | None:
    """校验请求来源 IP 是否在 Centrifugo 代理白名单内（RT-10 纵深防御）。

    支持反向代理穿透：当 CENTRIFUGO_TRUSTED_PROXIES 已配置且 REMOTE_ADDR
    属于可信代理时，从 X-Real-IP / X-Forwarded-For 提取真实来源 IP 再做白名单校验。
    """
    allowed_raw = getattr(settings, "CENTRIFUGO_ALLOWED_PROXY_IPS", None)
    if allowed_raw is None:
        allowed_raw = _DEFAULT_ALLOWED_IPS

    remote_addr = request.META.get("REMOTE_ADDR", "")
    source_addr = _resolve_source_ip(request, remote_addr)

    try:
        source_ip = ipaddress.ip_address(source_addr)
    except ValueError:
        _log_centrifugo_connect(
            request,
            "stage=proxy_ip invalid_source_ip",
            level=logging.WARNING,
            remote_addr=remote_addr,
            source_addr=source_addr,
        )
        logger.warning(
            "Centrifugo proxy: invalid source IP %r (REMOTE_ADDR=%r)",
            source_addr, remote_addr,
        )
        return JsonResponse(
            {"error": {"code": 403, "message": "forbidden"}}, status=403,
        )

    if _ip_matches_list(source_ip, allowed_raw):
        _log_centrifugo_connect(
            request,
            "stage=proxy_ip pass",
            remote_addr=remote_addr,
            source_addr=source_addr,
            allow_count=len(tuple(allowed_raw)),
        )
        return None

    _log_centrifugo_connect(
        request,
        "stage=proxy_ip forbidden",
        level=logging.WARNING,
        remote_addr=remote_addr,
        source_addr=source_addr,
        allow_count=len(tuple(allowed_raw)),
    )
    logger.warning(
        "Centrifugo proxy request from non-whitelisted IP %s (REMOTE_ADDR=%s)",
        source_addr, remote_addr,
    )
    return JsonResponse(
        {"error": {"code": 403, "message": "forbidden"}}, status=403,
    )


def _check_proxy_secret(request) -> JsonResponse | None:
    """校验 Centrifugo Proxy 请求的来源 IP 和 shared secret。

    通过则返回 None，失败返回错误 JsonResponse。
    """
    if err := _check_proxy_ip(request):
        return err

    expected = getattr(settings, "CENTRIFUGO_PROXY_SECRET", "")
    if not expected:
        _log_centrifugo_connect(
            request,
            "stage=proxy_secret missing_server_secret",
            level=logging.ERROR,
        )
        logger.error("CENTRIFUGO_PROXY_SECRET not configured — rejecting proxy request")
        return JsonResponse(
            {"error": {"code": 500, "message": "proxy secret not configured"}},
            status=500,
        )
    actual = request.headers.get(_PROXY_SECRET_HEADER, "")
    if not hmac.compare_digest(actual, expected):
        _log_centrifugo_connect(
            request,
            "stage=proxy_secret mismatch",
            level=logging.WARNING,
            remote_addr=request.META.get("REMOTE_ADDR"),
            provided=bool(actual),
            provided_len=len(actual),
        )
        logger.warning(
            "Centrifugo proxy secret mismatch from %s",
            request.META.get("REMOTE_ADDR"),
        )
        return JsonResponse(
            {"error": {"code": 403, "message": "invalid proxy secret"}},
            status=403,
        )
    _log_centrifugo_connect(
        request,
        "stage=proxy_secret pass",
        remote_addr=request.META.get("REMOTE_ADDR"),
    )
    return None


router = Router()


def _parse_chat_conv_id(channel: str) -> str | None:
    """从 chat:{conv_id} 频道名中提取并校验 UUID 格式的 conv_id。"""
    raw = channel.split(":", 1)[1] if ":" in channel else ""
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


def _parse_space_channel_space_id(channel: str) -> str | None:
    """从 space:{space_id} 频道名中提取并校验 UUID 格式的 space_id。"""
    raw = channel.split(":", 1)[1] if ":" in channel else ""
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


def _check_space_channel_access(user_id: str, space_id: str) -> tuple[bool, str | None]:
    """校验用户是否有权订阅团队 Space presence 频道。

    只对 team_space 开放（presence 在场感是团队协作能力）；要求当前用户
    在该 Project 有活跃 ProjectMembership。Fail-close：DB 异常时拒绝。
    """
    try:
        from apps.tabtinspace.models import ProjectMembership
        from apps.tabtinspace.services.host_resolver import host_type

        htype = host_type(space_id)
        if not htype:
            return False, "space not found"
        if htype != "team_space":
            return False, "presence channel is only available for team spaces"

        is_member = ProjectMembership.objects.filter(
            project_id=space_id,
            user_id=user_id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).exists()
        if not is_member:
            return False, "not a member of this space"

        return True, None
    except Exception:
        logger.warning(
            "DB error in _check_space_channel_access user=%s space=%s",
            user_id, space_id, exc_info=True,
        )
        return False, "internal error"


def _check_chat_channel_access(user_id: str, conv_id: str) -> tuple[bool, str | None]:
    """校验用户是否有权访问 chat 频道。

    Team Space 频道以 ProjectMembership 为准（与 list/send_message 一致），
    不能只查 ConversationMember——否则后加入成员能发消息但订不上 chat:{id}。

    Returns (allowed, error_message)。
    Fail-close：DB 异常时拒绝访问，避免权限校验被绕过。
    """
    try:
        from apps.tabchat.models import Conversation
        from apps.tabchat.services.conversation_access import ConversationAccessResolver

        conversation = Conversation.objects.filter(id=conv_id).first()
        if conversation is None:
            return False, "conversation not found"

        if not ConversationAccessResolver.resolve(conversation, user_id).can_subscribe:
            return False, "not a member of this conversation"

        return True, None
    except Exception:
        logger.warning(
            "DB error in _check_chat_channel_access user=%s conv=%s",
            user_id, conv_id, exc_info=True,
        )
        return False, "internal error"


class ConnectRequest(Schema):
    client: str
    transport: str = ""
    protocol: str = ""
    encoding: str = ""
    data: dict | None = None


class ConnectResultData(Schema):
    organization_id: str = ""
    display_name: str = ""


class ConnectResult(Schema):
    user: str
    expire_at: int = 0
    channels: list[str] = []
    data: ConnectResultData | None = None


class ConnectResponse(Schema):
    result: ConnectResult | None = None
    error: dict | None = None
    disconnect: dict | None = None


class SubscribeRequest(Schema):
    client: str
    transport: str = ""
    protocol: str = ""
    encoding: str = ""
    user: str
    channel: str


class SubscribeResponse(Schema):
    result: dict | None = None
    error: dict | None = None


@router.post("/connect", response=ConnectResponse, auth=None)
def centrifugo_connect_proxy(request, payload: ConnectRequest):
    """Connect Proxy：Centrifugo 新连接鉴权。

    从客户端传来的 data.token 中解析 TabTin JWT，
    返回用户身份和初始订阅频道。

    Wave 4：连接绑用户级，不再校验 ``data.organization_id``。Centrifugo 频道
    ``personal:{userId}`` / ``chat:{convId}`` 本就用户级；conversation
    membership 校验由 subscribe handler 通过统一 ConversationAccessResolver 兜底，
    覆盖面与原 connect-时校验等价、
    且粒度更细（对单个 chat 频道精确到底）。
    """
    request._centrifugo_connect_started_at = time.perf_counter()
    data = payload.data or {}
    token = data.get("token", "")

    def _disconnect(code: int, reason: str, level: int = logging.INFO, **fields):
        _log_centrifugo_connect(
            request,
            "view=connect disconnect",
            level=level,
            code=code,
            reason=reason,
            **fields,
        )
        return ConnectResponse(disconnect={"code": code, "reason": reason})

    _log_centrifugo_connect(
        request,
        "view=connect enter",
        client=payload.client,
        transport=payload.transport,
        protocol=payload.protocol,
        encoding=payload.encoding,
        token_present=bool(token),
    )

    try:
        if err := _check_proxy_secret(request):
            _log_centrifugo_connect(
                request,
                "view=connect reject_proxy_secret",
                level=logging.WARNING,
                status=getattr(err, "status_code", ""),
            )
            return err

        if not token:
            return _disconnect(4001, "no token provided", token_present=False)

        jwt_started_at = time.perf_counter()
        jwt_payload = verify_jwt_token(token)
        _log_centrifugo_connect(
            request,
            "stage=verify_jwt done",
            token_len=len(token),
            jwt_valid=bool(jwt_payload),
            stage_ms=f"{(time.perf_counter() - jwt_started_at) * 1000:.1f}",
        )
        if not jwt_payload:
            return _disconnect(4002, "invalid or expired token", token_len=len(token))

        token_type = jwt_payload.get("token_type")
        if token_type != "access":
            return _disconnect(4003, "not an access token", token_type=token_type)

        user_id = jwt_payload.get("user_id", "")
        if not user_id:
            return _disconnect(4004, "missing user_id in token")

        jti = jwt_payload.get("jti")
        if jti:
            revoke_started_at = time.perf_counter()
            from apps.tabtinspace.services.daemon_token_service import is_daemon_token_revoked

            revoked = is_daemon_token_revoked(jti)
            _log_centrifugo_connect(
                request,
                "stage=check_jti done",
                user_id=user_id,
                revoked=revoked,
                stage_ms=f"{(time.perf_counter() - revoke_started_at) * 1000:.1f}",
            )
            if revoked:
                return _disconnect(4007, "token revoked", user_id=user_id)
        else:
            _log_centrifugo_connect(
                request,
                "stage=check_jti skipped",
                user_id=user_id,
                jti_present=False,
            )

        user_lookup_started_at = time.perf_counter()
        try:
            user = User.objects.get(id=user_id, is_active=True)
        except User.DoesNotExist:
            _log_centrifugo_connect(
                request,
                "stage=user_lookup missing",
                level=logging.WARNING,
                user_id=user_id,
                stage_ms=f"{(time.perf_counter() - user_lookup_started_at) * 1000:.1f}",
            )
            return _disconnect(4005, "user not found or inactive", user_id=user_id)

        _log_centrifugo_connect(
            request,
            "stage=user_lookup done",
            user_id=user_id,
            stage_ms=f"{(time.perf_counter() - user_lookup_started_at) * 1000:.1f}",
        )

        session_key = jwt_payload.get("sid")
        if not session_key:
            return _disconnect(4008, "missing session binding", user_id=user_id)

        session_started_at = time.perf_counter()
        session = SessionManager.validate_session(session_key)
        session_valid = bool(session) and str(session.user_id) == str(user.id)
        _log_centrifugo_connect(
            request,
            "stage=session_validate done",
            user_id=user_id,
            session_valid=session_valid,
            stage_ms=f"{(time.perf_counter() - session_started_at) * 1000:.1f}",
        )
        if not session_valid:
            logger.info(
                "Centrifugo connect denied for user %s: session invalid or revoked",
                user_id,
            )
            return _disconnect(4009, "session revoked or expired", user_id=user_id)

        conn_limit = getattr(settings, "CENTRIFUGO_USER_CONNECTION_LIMIT", 20)
        conn_set_key = f"centrifugo:conn_set:{user_id}"
        conn_set_ttl = 300

        # NOTE: 连接数限制完全交给 Centrifugo 内建的 user_connection_limit 配置。
        # Django 侧无法感知 WebSocket 断开，用 Redis Set 追踪会产生 stale 累积
        # 导致合法用户被永久锁死（client_id 只增不减，TTL 被重连不断刷新）。
        # 这里仅做日志采样，不做拒绝。
        try:
            redis_started_at = time.perf_counter()
            from django_redis import get_redis_connection

            redis_conn = get_redis_connection("default")
            client_id = payload.client
            pipe = redis_conn.pipeline()
            pipe.sadd(conn_set_key, client_id)
            pipe.expire(conn_set_key, conn_set_ttl)
            pipe.scard(conn_set_key)
            _, _, current_count = pipe.execute()
            _log_centrifugo_connect(
                request,
                "stage=redis_sample done",
                user_id=user_id,
                client_id=client_id,
                conn_count=current_count,
                conn_limit=conn_limit,
                stage_ms=f"{(time.perf_counter() - redis_started_at) * 1000:.1f}",
            )
            if current_count > conn_limit:
                logger.info(
                    "Centrifugo connect: user %s has ~%d tracked client_ids (approx, may include stale) "
                    "(limit=%d), relying on Centrifugo built-in user_connection_limit",
                    user_id, current_count, conn_limit,
                )
        except Exception as exc:
            _log_centrifugo_connect(
                request,
                "stage=redis_sample error",
                level=logging.WARNING,
                user_id=user_id,
                exc_type=type(exc).__name__,
            )

        exp = jwt_payload.get("exp")
        ttl = getattr(settings, "CENTRIFUGO_TOKEN_TTL", 86400)
        expire_at = int(exp) if exp else int(time.time()) + ttl

        display_name = ""
        if hasattr(user, "display_name"):
            display_name = user.display_name or ""
        elif hasattr(user, "username"):
            display_name = user.username or ""

        # Wave 4：去掉 connect 阶段的 organization membership 校验。
        # ``ConnectResultData.organization_id`` 字段保留为空字符串以维持
        # 已部署 Centrifugo 实例与本接口契约的二进制兼容（schema 不变化）。
        # 真正的访问控制由 subscribe handler 在 ``chat:{conv_id}`` 订阅时
        # 通过统一 ``ConversationAccessResolver`` 校验完成。
        #
        # TC-22：connect 阶段**不再**下发 ``personal:{userId}`` 作为 connect-result
        # server-side subscription。该频道改由前端 client-side 订阅
        # （``useCentrifugoClient.subscribePersonal`` → 触发本文件 subscribe proxy
        # 的 ``owner_id == user_id`` 鉴权，覆盖等价）。
        #
        # 此前两条路径并存（connect 下发 server-side + 前端 client-side）在 personal
        # namespace ``force_recovery`` 下冲突：稳态报 105 already subscribed；重连时
        # centrifuge-js 把 client-side 订阅打包进 connect 命令的 ``subs``（带 recovery
        # offset），与 connect-result 同名 server-side channel 冲突 → Centrifugo 回
        # ``code:100 internal server error`` → 客户端疯狂重连 + 反复 recover history，
        # 导致 ``im.unread.update`` / ``im.mention`` 等通知被重复推送。收敛为单一
        # client-side 订阅路径后，recovery 只走一条、不再冲突。
        _log_centrifugo_connect(
            request,
            "view=connect success",
            user_id=user_id,
            expire_at=expire_at,
            channel="-",
        )
        return ConnectResponse(
            result=ConnectResult(
                user=str(user.id),
                expire_at=expire_at,
                channels=[],
                data=ConnectResultData(
                    organization_id="",
                    display_name=display_name,
                ),
            )
        )
    except Exception:
        logger.exception(
            "[CentrifugoConnect:%s] view=connect unexpected_error",
            _get_centrifugo_trace_id(request),
        )
        raise


@router.post("/subscribe", response=SubscribeResponse, auth=None)
def centrifugo_subscribe_proxy(request, payload: SubscribeRequest):
    """Subscribe Proxy：校验用户是否有权订阅指定频道。

    支持 chat:{conv_id} 和 personal:{user_id} 两种命名空间。
    """
    if err := _check_proxy_secret(request):
        return err
    channel = payload.channel
    user_id = payload.user

    if not user_id:
        return SubscribeResponse(
            error={"code": 403, "message": "missing user_id"}
        )

    # P1-NEW-S5: 校验用户活跃状态，与 connect proxy 保持一致
    if not User.objects.filter(id=user_id, is_active=True).exists():
        return SubscribeResponse(
            error={"code": 403, "message": "user inactive or not found"}
        )

    if channel.startswith("personal:"):
        raw_owner_id = channel.split(":", 1)[1]
        try:
            owner_id = str(uuid.UUID(raw_owner_id))
        except ValueError:
            return SubscribeResponse(
                error={"code": 400, "message": "invalid personal channel format"}
            )
        if owner_id != user_id:
            return SubscribeResponse(
                error={"code": 403, "message": "cannot subscribe to another user's personal channel"}
            )
        return SubscribeResponse(result={})

    if channel.startswith("space:"):
        space_id = _parse_space_channel_space_id(channel)
        if not space_id:
            return SubscribeResponse(
                error={"code": 400, "message": "invalid space id format"}
            )
        allowed, err_msg = _check_space_channel_access(user_id, space_id)
        if not allowed:
            code = 404 if err_msg == "space not found" else 403
            return SubscribeResponse(error={"code": code, "message": err_msg})
        return SubscribeResponse(result={})

    if not channel.startswith("chat:"):
        return SubscribeResponse(
            error={"code": 403, "message": "unknown channel namespace"}
        )

    conv_id = _parse_chat_conv_id(channel)
    if not conv_id:
        return SubscribeResponse(
            error={"code": 400, "message": "invalid conversation id format"}
        )

    allowed, err_msg = _check_chat_channel_access(user_id, conv_id)
    if not allowed:
        code = 404 if err_msg == "conversation not found" else 403
        return SubscribeResponse(error={"code": code, "message": err_msg})

    return SubscribeResponse(result={})


# ── Sub Refresh Proxy (DS-027) ────────────────────────────────────────


class SubRefreshRequest(Schema):
    client: str
    transport: str = ""
    protocol: str = ""
    encoding: str = ""
    user: str
    channel: str


class SubRefreshResult(Schema):
    expired: bool = False


class SubRefreshResponse(Schema):
    result: SubRefreshResult | None = None
    error: dict | None = None


@router.post("/sub_refresh", response=SubRefreshResponse, auth=None)
def centrifugo_sub_refresh_proxy(request, payload: SubRefreshRequest):
    """Sub Refresh Proxy：周期性重验用户对频道的订阅权限（DS-027）。

    Centrifugo 按 sub_refresh_interval 周期性回调此端点。
    如果用户已不再是频道成员，返回 expired=True 令 Centrifugo 自动取消订阅。
    """
    if err := _check_proxy_secret(request):
        return err

    channel = payload.channel
    user_id = payload.user

    if not user_id:
        return SubRefreshResponse(result=SubRefreshResult(expired=True))

    # P1-NEW-S5: 校验用户活跃状态，被禁用用户的订阅应立即过期
    if not User.objects.filter(id=user_id, is_active=True).exists():
        return SubRefreshResponse(result=SubRefreshResult(expired=True))

    if channel.startswith("personal:"):
        raw_owner_id = channel.split(":", 1)[1]
        try:
            owner_id = str(uuid.UUID(raw_owner_id))
        except ValueError:
            return SubRefreshResponse(result=SubRefreshResult(expired=True))
        expired = owner_id != user_id
        return SubRefreshResponse(result=SubRefreshResult(expired=expired))

    if channel.startswith("space:"):
        space_id = _parse_space_channel_space_id(channel)
        if not space_id:
            return SubRefreshResponse(result=SubRefreshResult(expired=True))
        allowed, err_msg = _check_space_channel_access(user_id, space_id)
        if not allowed:
            logger.info(
                "Centrifugo sub_refresh: revoking space subscription user=%s channel=%s reason=%s",
                user_id, channel, err_msg,
            )
            return SubRefreshResponse(result=SubRefreshResult(expired=True))
        return SubRefreshResponse(result=SubRefreshResult(expired=False))

    if not channel.startswith("chat:"):
        return SubRefreshResponse(result=SubRefreshResult(expired=True))

    conv_id = _parse_chat_conv_id(channel)
    if not conv_id:
        return SubRefreshResponse(result=SubRefreshResult(expired=True))

    allowed, err_msg = _check_chat_channel_access(user_id, conv_id)
    if not allowed:
        logger.info(
            "Centrifugo sub_refresh: revoking subscription user=%s channel=%s reason=%s",
            user_id, channel, err_msg,
        )
        return SubRefreshResponse(result=SubRefreshResult(expired=True))

    return SubRefreshResponse(result=SubRefreshResult(expired=False))


# ── Refresh Proxy ─────────────────────────────────────────────────────


class RefreshRequest(Schema):
    client: str
    transport: str = ""
    protocol: str = ""
    encoding: str = ""
    user: str


class RefreshResult(Schema):
    expire_at: int = 0
    expired: bool = False


class RefreshResponse(Schema):
    result: RefreshResult | None = None
    error: dict | None = None
    disconnect: dict | None = None


@router.post("/refresh", response=RefreshResponse, auth=None)
def centrifugo_refresh_proxy(request, payload: RefreshRequest):
    """Refresh Proxy：Centrifugo 会话即将过期时续期。

    校验用户活跃状态 + 会话有效性（密码修改后所有 session 被吊销）。
    """
    if err := _check_proxy_secret(request):
        return err

    user_id = payload.user
    if not user_id:
        return RefreshResponse(result=RefreshResult(expired=True))

    try:
        user = User.objects.get(id=user_id, is_active=True)
    except User.DoesNotExist:
        return RefreshResponse(
            disconnect={"code": 4005, "reason": "user not found or inactive"}
        )

    from apps.users.auth.models import UserSession

    has_active_session = UserSession.objects.filter(
        user=user, is_active=True, expires_at__gt=timezone.now(),
    ).exists()
    if not has_active_session:
        logger.info(
            "Centrifugo refresh denied for user %s: no active session (likely password change)",
            user_id,
        )
        return RefreshResponse(
            disconnect={"code": 4006, "reason": "session revoked"}
        )

    ttl = getattr(settings, "CENTRIFUGO_TOKEN_TTL", 86400)
    return RefreshResponse(
        result=RefreshResult(expire_at=int(time.time()) + ttl)
    )


# ── Publish Proxy ──────────────────────────────────────────────────────

def disconnect_centrifugo_user(user_id: str) -> None:
    """通过 Centrifugo HTTP API 主动断开指定用户的所有连接。

    用于登出、改密等用户级安全事件；组织成员变更不可调用本函数，
    以免影响该用户在其它组织的合法实时协作。
    """
    try:
        from apps.tabchat.services.centrifugo_service import get_centrifugo_service
        service = get_centrifugo_service()
        service.disconnect(str(user_id))
        logger.info("Centrifugo disconnect issued for user %s", user_id)
    except Exception:
        logger.exception(
            "Failed to disconnect Centrifugo user %s (non-blocking)", user_id,
        )


def unsubscribe_centrifugo_user_from_organization(
    user_id: str,
    organization_id: str,
    *,
    synchronous: bool = False,
) -> None:
    """主动取消用户对 organization 下所有 chat 频道的 Centrifugo 订阅（DS-027）。

    组织成员被移除时传入 ``synchronous=True``，确保撤销完成后才允许返回，
    消除异步队列导致的「界面已无权限、系统通知仍收到消息」窗口。
    """
    try:
        from apps.tabchat.models import Conversation
        from apps.tabchat.services.centrifugo_service import get_centrifugo_service

        conv_ids = list(
            Conversation.objects.filter(organization_id=organization_id)
            .values_list("id", flat=True)
        )
        if not conv_ids:
            return

        service = get_centrifugo_service()
        for conv_id in conv_ids:
            channel = f"chat:{conv_id}"
            if synchronous:
                service.unsubscribe_sync(str(user_id), channel)
            else:
                service.unsubscribe(str(user_id), channel)

        logger.info(
            "Centrifugo unsubscribe issued for user %s across %d channels in organization %s (synchronous=%s)",
            user_id, len(conv_ids), organization_id, synchronous,
        )
    except Exception:
        logger.exception(
            "Failed to unsubscribe Centrifugo user %s from organization %s (non-blocking)",
            user_id, organization_id,
        )


PUBLISH_ALLOWED_TYPES = {"im.typing"}


class PublishRequest(Schema):
    client: str
    user: str
    channel: str
    data: dict | None = None


class PublishResponse(Schema):
    result: dict | None = None
    error: dict | None = None


@router.post("/publish", response=PublishResponse, auth=None)
def centrifugo_publish_proxy(request, payload: PublishRequest):
    """Publish Proxy：限制客户端仅能发布白名单内的事件类型。

    防止恶意客户端通过 Centrifugo publish 伪造 im.message 等关键事件。
    """
    if err := _check_proxy_secret(request):
        return err
    data = payload.data or {}
    event_type = data.get("type", "")

    if event_type not in PUBLISH_ALLOWED_TYPES:
        return PublishResponse(
            error={"code": 403, "message": f"publish type '{event_type}' not allowed"}
        )

    if not payload.channel.startswith("chat:"):
        return PublishResponse(
            error={"code": 403, "message": "publish only allowed on chat channels"}
        )

    conv_id = _parse_chat_conv_id(payload.channel)
    if not conv_id:
        return PublishResponse(
            error={"code": 400, "message": "invalid conversation id format"}
        )
    allowed, err_msg = _check_chat_channel_access(payload.user, conv_id)
    if not allowed:
        return PublishResponse(
            error={"code": 403, "message": err_msg or "not a member of this conversation"}
        )

    return PublishResponse(result={})

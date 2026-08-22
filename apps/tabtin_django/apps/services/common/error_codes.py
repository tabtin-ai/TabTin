"""
通用错误码定义

跨模块共享的错误码。模块特有的错误码应留在各模块自己的 error_codes.py 中。

使用方式:
    from apps.services.common.error_codes import CommonErrorCode, CommonErrorMessage

    # 生成标准错误响应
    resp = get_error_response(CommonErrorCode.PERMISSION_DENIED)


─── Unified ErrorCode Mirror（Wave 0 / contract 项目）────────────────

文件下方还维护了一份 ``ERROR_CODES`` tuple + ``ErrorCode`` Literal，**与**
``packages/agent-wire/src/error-codes.ts`` 和
``packages/tabtin-cli-go/internal/errcode/codes.go`` 是**严格三端镜像**。

修改规则（违反则 ``scripts/check-error-codes-sync.py`` 阻断 CI）::

    1. 不得单独修改本镜像区——任何增删改必须同时改三端。
    2. 顺序无所谓（同步脚本按集合比对），但保持与 TS / Go 一致便于 review。
    3. 不要把已有 ``CommonErrorCode`` 类的常量直接搬进 ``ERROR_CODES``。
       该类是历史遗留 + 业务码池（含 ``ORGANIZATION_NOT_FOUND`` 等业务前缀），
       由 ``get_error_response()`` 这条调用链消费；W6 surface 框架到位后
       会按"surface 各自声明 errorCodes"重新组织业务码。
    4. 业务码命名规则：``<DOMAIN_PREFIX>_<DETAIL>``（参见 TS 镜像头部）。
"""

from typing import Any, Literal, Optional


class CommonErrorCode:
    """
    通用错误码常量

    分段规则:
      - 通用错误:       SUCCESS / UNKNOWN_ERROR / INTERNAL_ERROR / INVALID_REQUEST / VALIDATION_ERROR
      - 认证和授权:     UNAUTHORIZED / TOKEN_EXPIRED / TOKEN_INVALID / PERMISSION_DENIED
      - 资源不存在:     *_NOT_FOUND
      - 操作限制:       RATE_LIMIT_EXCEEDED / QUOTA_EXCEEDED
    """

    # ── 通用 ──
    SUCCESS = "SUCCESS"
    UNKNOWN_ERROR = "UNKNOWN_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    INVALID_REQUEST = "INVALID_REQUEST"
    VALIDATION_ERROR = "VALIDATION_ERROR"

    # ── 认证和授权 ──
    UNAUTHORIZED = "UNAUTHORIZED"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    TOKEN_INVALID = "TOKEN_INVALID"
    PERMISSION_DENIED = "PERMISSION_DENIED"

    # ── 资源不存在 ──
    ORGANIZATION_NOT_FOUND = "ORGANIZATION_NOT_FOUND"
    PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND"
    RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND"

    # ── 操作限制 ──
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"

    # ── 冲突 ──
    CONFLICT = "CONFLICT"
    VERSION_CONFLICT = "VERSION_CONFLICT"
    # 行锁 / 资源忙（非乐观锁版本号冲突）
    SAVE_BUSY = "SAVE_BUSY"


class CommonErrorMessage:
    """通用错误消息模板"""

    _CODE_TO_I18N = {
        CommonErrorCode.SUCCESS: "common.success",
        CommonErrorCode.UNKNOWN_ERROR: "common.unknown_error",
        CommonErrorCode.INTERNAL_ERROR: "common.internal_error",
        CommonErrorCode.INVALID_REQUEST: "common.invalid_request",
        CommonErrorCode.VALIDATION_ERROR: "common.validation_error",
        CommonErrorCode.UNAUTHORIZED: "auth.unauthorized",
        CommonErrorCode.TOKEN_EXPIRED: "auth.token_expired",
        CommonErrorCode.TOKEN_INVALID: "auth.token_invalid",
        CommonErrorCode.PERMISSION_DENIED: "auth.permission_denied",
        CommonErrorCode.ORGANIZATION_NOT_FOUND: "resource.organization_not_found",
        CommonErrorCode.PROJECT_NOT_FOUND: "resource.project_not_found",
        CommonErrorCode.RESOURCE_NOT_FOUND: "common.resource_not_found",
        CommonErrorCode.RATE_LIMIT_EXCEEDED: "middleware.rate_limited",
        CommonErrorCode.QUOTA_EXCEEDED: "common.quota_exceeded",
        CommonErrorCode.CONFLICT: "common.conflict",
        CommonErrorCode.VERSION_CONFLICT: "common.version_conflict",
        CommonErrorCode.SAVE_BUSY: "common.save_busy",
    }

    MESSAGES = {
        CommonErrorCode.SUCCESS: "操作成功",
        CommonErrorCode.UNKNOWN_ERROR: "未知错误",
        CommonErrorCode.INTERNAL_ERROR: "服务器内部错误: {detail}",
        CommonErrorCode.INVALID_REQUEST: "请求参数无效",
        CommonErrorCode.VALIDATION_ERROR: "数据验证失败: {detail}",
        CommonErrorCode.UNAUTHORIZED: "请先登录",
        CommonErrorCode.TOKEN_EXPIRED: "登录已过期，请重新登录",
        CommonErrorCode.TOKEN_INVALID: "登录凭证无效",
        CommonErrorCode.PERMISSION_DENIED: "您没有权限执行此操作",
        CommonErrorCode.ORGANIZATION_NOT_FOUND: "组织不存在",
        CommonErrorCode.PROJECT_NOT_FOUND: "项目不存在",
        CommonErrorCode.RESOURCE_NOT_FOUND: "{resource}不存在",
        CommonErrorCode.RATE_LIMIT_EXCEEDED: "操作过于频繁，请稍后再试",
        CommonErrorCode.QUOTA_EXCEEDED: "配额不足: {detail}",
        CommonErrorCode.CONFLICT: "资源冲突: {detail}",
        CommonErrorCode.VERSION_CONFLICT: "版本冲突，请刷新后重试",
        CommonErrorCode.SAVE_BUSY: "资源正在保存，请稍后重试",
    }

    @classmethod
    def get(cls, code: str, **kwargs) -> str:
        i18n_key = cls._CODE_TO_I18N.get(code)
        if i18n_key:
            try:
                from apps.i18n import _
                return _(i18n_key, **kwargs)
            except Exception:
                pass
        message = cls.MESSAGES.get(code, cls.MESSAGES[CommonErrorCode.UNKNOWN_ERROR])
        try:
            return message.format(**kwargs)
        except KeyError:
            return message


# ── 辅助函数 ──


def get_error_response(
    code: str,
    message: Optional[str] = None,
    data: Optional[Any] = None,
    **kwargs,
) -> dict:
    """
    生成标准错误响应字典

    Args:
        code: 错误码
        message: 自定义错误消息（可选，默认从 CommonErrorMessage 查找）
        data: 附加数据
        **kwargs: 消息模板参数
    """
    if message is None:
        message = CommonErrorMessage.get(code, **kwargs)
    return {
        "success": False,
        "code": code,
        "message": message,
        "data": data,
    }


def get_success_response(data: Any = None, message: str = "") -> dict:
    """生成标准成功响应字典"""
    if not message:
        try:
            from apps.i18n import _
            message = _("common.success")
        except Exception:
            message = "操作成功"
    return {
        "success": True,
        "code": CommonErrorCode.SUCCESS,
        "message": message,
        "data": data,
    }


# ─── Unified ErrorCode Mirror ─────────────────────────────────────────
# **DO NOT EDIT IN ISOLATION** — kept byte-equivalent (as a set) with:
#   - packages/agent-wire/src/error-codes.ts  (TypeScript canonical source)
#   - packages/tabtin-cli-go/internal/errcode/codes.go  (Go mirror)
# Sync enforced by scripts/check-error-codes-sync.py (blocking step in
# scripts/infra-gate.sh). See file docstring for the rules.

ERROR_CODES: tuple[str, ...] = (
    # Authentication & Authorization
    "AUTH_INVALID",
    "AUTH_EXPIRED",
    "UNAUTHORIZED",
    "PERMISSION_DENIED",
    "FORBIDDEN",

    # Resource lookup / shape
    "NOT_FOUND",
    "VALIDATION_ERROR",
    "CONFLICT",

    # Throttling / availability
    "RATE_LIMIT_EXCEEDED",
    "QUOTA_EXCEEDED",
    "TIMEOUT",
    "UNAVAILABLE",
    "NETWORK_ERROR",

    # User / cooperative cancellation
    "CANCELLED",

    # Capability gating
    "NOT_IMPLEMENTED",

    # Server-side / catch-all
    "INTERNAL_ERROR",

    # Soft-fail discipline (D-1)
    "SOFT_FAIL",

    # Transitional safety (D-2)
    "LEGACY_SHAPE",

    # IPC lazy-load infrastructure (Wave 2 W2-δ)
    "LOAD_FAILED",
    "HANDLER_NOT_FOUND",
)

ErrorCode = Literal[
    "AUTH_INVALID",
    "AUTH_EXPIRED",
    "UNAUTHORIZED",
    "PERMISSION_DENIED",
    "FORBIDDEN",
    "NOT_FOUND",
    "VALIDATION_ERROR",
    "CONFLICT",
    "RATE_LIMIT_EXCEEDED",
    "QUOTA_EXCEEDED",
    "TIMEOUT",
    "UNAVAILABLE",
    "NETWORK_ERROR",
    "CANCELLED",
    "NOT_IMPLEMENTED",
    "INTERNAL_ERROR",
    "SOFT_FAIL",
    "LEGACY_SHAPE",
    "LOAD_FAILED",
    "HANDLER_NOT_FOUND",
]


def is_error_code(value: object) -> bool:
    """Runtime guard — checks whether a value is a recognized generic
    ErrorCode. Useful at the IPC / HTTP boundary where the field has been
    deserialized from JSON and erased to ``str``.
    """
    return isinstance(value, str) and value in ERROR_CODES


# ─── Wire Envelope Helpers (Wave 0 contract / cli-envelope.ts mirror) ─
#
# These helpers produce ``{ok, data}`` / ``{ok, error}`` envelopes that
# match @tabtin/agent-wire's ``CliResponse`` shape exactly. Use them for
# any new HTTP route or service-layer return value that crosses the
# Daemon / Electron boundary.
#
# Why both these AND ``get_success_response`` / ``get_error_response``
# (above)? The legacy helpers return the older
# ``{success, code, message, data}`` shape that the existing Django
# ninja routers consume; flipping every router in one go is W6 surface
# work. Wave 0 ships both flavors so new code can opt in to the wire
# envelope without forcing a global rewrite. The two flavors will
# converge once W6 surfaces sweep the routers.


def err_response(
    code: str,
    message: str,
    *,
    request: Any = None,
    retryable: bool = False,
    suggestions: Optional[list] = None,
    trace_id: Optional[str] = None,
    duration_ms: Optional[int] = None,
    detail: Optional[dict] = None,
) -> dict:
    """Build a wire-format error envelope (`{ok: False, error, ...}`).

    ``code`` SHOULD be one of ``ERROR_CODES`` (or a domain-prefixed
    business code following ``<DOMAIN>_<DETAIL>`` convention).  This
    helper does NOT enforce membership — that decision lives at the
    surface boundary; here we just emit the bytes.

    ``trace_id`` is auto-resolved from ``request.request_id`` (set by
    ``services.common.middleware.RequestIdMiddleware``) when ``request``
    is passed and ``trace_id`` is not. This is the only sanctioned way
    to attach trace_id to error envelopes — every other call-site
    forgetting to thread the request would produce ``trace_id=None``.

    ``detail`` carries structured diagnostic data alongside the user-
    facing ``message``. The most common use is ``SOFT_FAIL`` paths that
    still want to expose a fallback payload (D-1 contract decision)::

        err_response(
            'SOFT_FAIL', '标题生成失败',
            request=request,
            detail={'fallback': {'title': session.title}},
        )

    Renderer can then opt-in: ``if (!resp.ok && resp.error.detail?.fallback)
    use(resp.error.detail.fallback)``. The default behaviour stays
    "throw on ok:false", so missing the opt-in keeps the failure visible.

    Args:
        code: ``ErrorCode`` literal or domain-prefixed business code.
        message: User-facing message; pair with ``suggestions`` for hints.
        request: Optional Django HttpRequest (or django-ninja request)
            used to auto-pull ``trace_id`` from the request middleware.
            Pass-through is preferred over manually wiring ``trace_id=``.
        retryable: Hint to caller that retrying may succeed.
        suggestions: List of human-readable next-step hints.
        trace_id: Override / explicit trace identifier. If set, takes
            precedence over ``request.request_id``.
        duration_ms: Server-measured execution time, milliseconds.
        detail: Structured diagnostic payload attached to ``error.detail``.
            Convention: SOFT_FAIL paths put the original fallback data
            under ``detail['fallback']`` so renderer can opt-in instead
            of being silently misled (D-1 / W1 A2 改造).

    Returns:
        ``dict`` ready to be ``JsonResponse``-serialized at the route layer.
    """
    error_obj: dict = {"code": code, "message": message, "retryable": retryable}
    if suggestions:
        error_obj["suggestions"] = list(suggestions)
    if detail is not None:
        error_obj["detail"] = detail

    envelope: dict = {"ok": False, "error": error_obj}

    resolved_trace_id = trace_id
    if resolved_trace_id is None and request is not None:
        resolved_trace_id = getattr(request, "request_id", None)
    # Use ``is not None`` instead of plain truthiness so an empty-string
    # ``trace_id``/``request_id`` round-trips identically to the TS side
    # (TS uses ``!== undefined`` — a present-but-empty trace_id is part of
    # the wire shape). W5 audit log joins on this field across languages,
    # so silent string→None coercion was a future cross-stack drift bug.
    if resolved_trace_id is not None:
        envelope["trace_id"] = resolved_trace_id
    if duration_ms is not None:
        envelope["duration_ms"] = duration_ms
    return envelope


def ok_response(
    data: Any = None,
    *,
    request: Any = None,
    trace_id: Optional[str] = None,
    duration_ms: Optional[int] = None,
) -> dict:
    """Build a wire-format success envelope (`{ok: True, data, ...}`).

    Mirror of TS ``okResponse``. Same auto-trace_id semantic as
    ``err_response``.

    Args:
        data: Response payload. ``None`` is preserved as ``data: None``
            (don't drop the field — the wire shape requires it).
        request: Optional Django HttpRequest, used to auto-pull
            ``trace_id`` from the request middleware.
        trace_id: Override / explicit trace identifier.
        duration_ms: Server-measured execution time, milliseconds.
    """
    envelope: dict = {"ok": True, "data": data}

    resolved_trace_id = trace_id
    if resolved_trace_id is None and request is not None:
        resolved_trace_id = getattr(request, "request_id", None)
    # See ``err_response`` for why we use ``is not None`` instead of
    # plain truthiness — keeps the wire shape strictly aligned with TS.
    if resolved_trace_id is not None:
        envelope["trace_id"] = resolved_trace_id
    if duration_ms is not None:
        envelope["duration_ms"] = duration_ms
    return envelope

"""Sentry 错误监控接入（errors-only）。

启用条件：env 注入 ``SENTRY_DSN=https://...``（不注入时不初始化 → 零开销，
与 OTel 接入同款 opt-in 模式）。sentry-sdk 未安装时同样静默降级。

字段契约（tags 白名单 / 脱敏红线 / 各端取值来源）见
``docs/agent/error-context-schema.md``——本模块只允许上报契约里登记过的字段。

三个接入点：
1. ``init_sentry()``            —— wsgi / asgi / celery 三个进程入口调用
   （管理命令与 ``scripts/*.py`` 独立脚本不初始化——错误监控只覆盖常驻服务）；
2. ``before_send``              —— 全局事件钩子：注入 ContextVar 业务 tags + 脱敏 + 同指纹限频；
3. ``capture_api_exception()``  —— ninja 兜底 handler 显式上报（ninja 会把未捕获
   异常转成 500 响应吞掉，不发 ``got_request_exception`` 信号，Django 集成抓不到）。
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

_initialized = False

# ── tags 白名单（跨端契约，新字段先改 error-context-schema.md 再登记到这里） ──

#: ContextVar getter → tag 键 的映射。取不到值（None/空）的键不上报。
_THREAD_CONTEXT_TAGS = (
    ("organization_id", "get_current_organization_id"),
    ("space_id", "get_current_space_id"),
    ("agent_id", "get_current_execution_agent_id"),
)
_PLATFORM_CONTEXT_TAGS = (
    ("session_id", "get_current_session_id"),
    ("run_id", "get_current_run_id"),
)

# ── 脱敏（结构性现场原则：token / 手机号 / 邮箱 / 家目录用户名不出境） ──

_SCRUB_RULES: tuple[tuple[re.Pattern[str], Any], ...] = (
    (re.compile(r"(bearer\s+)[A-Za-z0-9\-._~+/]{8,}=*", re.IGNORECASE), r"\1<redacted>"),
    (
        re.compile(
            r"(\"?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token"
            r"|refresh[_-]?token|authorization|cookie|set-cookie)\"?\s*[:=]\s*\"?)"
            r"([^\s\"',}]{4,})",
            re.IGNORECASE,
        ),
        r"\1<redacted>",
    ),
    (re.compile(r"\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+"), "<redacted-jwt>"),
    (
        re.compile(r"([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})"),
        lambda m: f"{m.group(1)[:1]}***@{m.group(2)}",
    ),
    (
        re.compile(r"\b1[3-9]\d{9}\b"),
        lambda m: f"{m.group(0)[:3]}****{m.group(0)[7:]}",
    ),
    (re.compile(r"(/Users/)[^/\s]+"), r"\1<user>"),
    (re.compile(r"(/home/)[^/\s]+"), r"\1<user>"),
    (re.compile(r"([A-Za-z]:\\Users\\)[^\\/\s]+"), r"\1<user>"),
)


def scrub_text(text: str) -> str:
    """对一段文本做脱敏（与 Electron 诊断包 ``diagnostics-redact.ts`` 同款规则）。"""
    if not isinstance(text, str) or not text:
        return text or ""
    for pattern, replacement in _SCRUB_RULES:
        text = pattern.sub(replacement, text)
    return text


# ── 同指纹限频（洪水保护）────────────────────────────────────────────
# 仓库里已有高频 capture_message 调用点（如 relay silent-drop，dogfood 实测
# 每秒可达上百条），DSN 一配置就会被激活；SDK 自带的 dedupe 只拦完全相同的
# 异常对象。这里按消息/异常指纹做进程内限频兜底：同指纹每窗口最多放行
# _RATE_LIMIT_MAX 条，超出的在 before_send 里直接丢弃。

_RATE_LIMIT_WINDOW_S = 60.0
_RATE_LIMIT_MAX = 5
_RATE_LIMIT_TABLE_CAP = 512

#: fingerprint -> (窗口起点时间戳, 窗口内已放行条数)
_fingerprint_hits: dict[str, tuple[float, int]] = {}


def _event_fingerprint(event: dict) -> str:
    exception = event.get("exception")
    if isinstance(exception, dict):
        values = exception.get("values") or []
        if values and isinstance(values[0], dict):
            first = values[0]
            return f"exc:{first.get('type')}:{str(first.get('value'))[:120]}"
    logentry = event.get("logentry")
    if isinstance(logentry, dict) and logentry.get("message"):
        return f"log:{str(logentry['message'])[:160]}"
    return f"msg:{str(event.get('message'))[:160]}"


def _rate_limited(event: dict, now: Optional[float] = None) -> bool:
    """同指纹限频判定。返回 True 表示该事件应被丢弃。"""
    now = time.monotonic() if now is None else now
    key = _event_fingerprint(event)
    started, count = _fingerprint_hits.get(key, (0.0, 0))
    if now - started >= _RATE_LIMIT_WINDOW_S:
        started, count = now, 0
    if count >= _RATE_LIMIT_MAX:
        _fingerprint_hits[key] = (started, count)
        return True
    if len(_fingerprint_hits) >= _RATE_LIMIT_TABLE_CAP and key not in _fingerprint_hits:
        # 表满先清过期项；仍满则整表重置（宁可放行也不无界增长）
        expired = [k for k, (ts, _) in _fingerprint_hits.items() if now - ts >= _RATE_LIMIT_WINDOW_S]
        for k in expired:
            del _fingerprint_hits[k]
        if len(_fingerprint_hits) >= _RATE_LIMIT_TABLE_CAP:
            _fingerprint_hits.clear()
    _fingerprint_hits[key] = (started, count + 1)
    return False


def collect_context_tags() -> dict[str, str]:
    """从平台 ContextVar 收集当前执行现场的业务 tags（白名单内、非空才带）。

    Agent 执行链路的 middleware（AgentRunContextMiddleware 等）与 runtime
    会填充这些 ContextVar；普通 API 请求大多为空——空值不上报，不算异常。
    """
    tags: dict[str, str] = {}
    try:
        from apps.services.common import thread_context

        for tag_key, getter_name in _THREAD_CONTEXT_TAGS:
            value = getattr(thread_context, getter_name)()
            if value:
                tags[tag_key] = str(value)
    except Exception:  # ContextVar 读取绝不能反过来弄坏错误上报
        logger.debug("[Sentry] thread_context tags 收集失败", exc_info=True)
    try:
        from apps.services.common import platform_context

        for tag_key, getter_name in _PLATFORM_CONTEXT_TAGS:
            value = getattr(platform_context, getter_name)()
            if value:
                tags[tag_key] = str(value)
    except Exception:
        logger.debug("[Sentry] platform_context tags 收集失败", exc_info=True)
    return tags


def scrub_event(event: dict, _hint: Optional[dict] = None) -> Optional[dict]:
    """``before_send`` 钩子：同指纹限频 + 注入业务 tags + 全事件脱敏。

    返回 None 表示丢弃事件（限频命中）。除 ContextVar / 限频表外为纯函数，
    单测直接构造 event dict 验证。
    """
    if _rate_limited(event):
        return None

    tags = event.setdefault("tags", {})
    for key, value in collect_context_tags().items():
        tags.setdefault(key, value)

    # message / logentry
    if isinstance(event.get("message"), str):
        event["message"] = scrub_text(event["message"])
    logentry = event.get("logentry")
    if isinstance(logentry, dict) and isinstance(logentry.get("message"), str):
        logentry["message"] = scrub_text(logentry["message"])

    # exception values
    exception = event.get("exception")
    if isinstance(exception, dict):
        for value in exception.get("values") or []:
            if isinstance(value, dict) and isinstance(value.get("value"), str):
                value["value"] = scrub_text(value["value"])

    # breadcrumbs（Sentry 集成会把 logging 面包屑带进来）——message 和
    # data 里的字符串值都要脱敏（http 面包屑的 url query 可能带 token/邮箱）
    breadcrumbs = event.get("breadcrumbs")
    crumb_list = breadcrumbs.get("values") if isinstance(breadcrumbs, dict) else breadcrumbs
    if isinstance(crumb_list, list):
        for crumb in crumb_list:
            if not isinstance(crumb, dict):
                continue
            if isinstance(crumb.get("message"), str):
                crumb["message"] = scrub_text(crumb["message"])
            data = crumb.get("data")
            if isinstance(data, dict):
                for key, value in data.items():
                    if isinstance(value, str):
                        data[key] = scrub_text(value)

    # 请求体不出境（结构性现场原则）；url/headers 由 send_default_pii=False 兜底
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("data", None)
        if isinstance(request.get("query_string"), str):
            request["query_string"] = scrub_text(request["query_string"])

    return event


def resolve_sentry_environment() -> str:
    """Return the governed observability environment.

    ``test`` remains readable for already-running legacy deployments, but new
    test deployments must use ``test-new`` so their signal is isolated from
    the historical pool.
    """
    configured = os.getenv("SENTRY_ENVIRONMENT", "").strip()
    if configured:
        if configured not in {"test", "test-new", "production"}:
            raise ValueError(
                "SENTRY_ENVIRONMENT must be 'test', 'test-new', or 'production'"
            )
        return configured
    return "test-new" if os.getenv("DEBUG", "False").lower() == "true" else "production"


def resolve_sentry_release() -> str | None:
    """事件必须能回到镜像源码；显式 release 仅作为兼容覆盖。"""
    configured = os.getenv("SENTRY_RELEASE", "").strip()
    if configured:
        return configured
    source_sha = os.getenv("TABTIN_SOURCE_SHA", os.getenv("TABTIN_GIT_SHA", "")).strip()
    return f"tabtin-django@{source_sha}" if source_sha else None


def resolve_sentry_initial_scope() -> dict[str, dict[str, str]]:
    """为每个 Django 事件保留实际镜像源码 SHA，供告警归因使用。"""
    source_sha = os.getenv("TABTIN_SOURCE_SHA", os.getenv("TABTIN_GIT_SHA", "")).strip()
    return {"tags": {"source_sha": source_sha}} if source_sha else {}


def resolve_sentry_release() -> str | None:
    """事件必须能回到镜像源码；显式 release 仅作为兼容覆盖。"""
    configured = os.getenv("SENTRY_RELEASE", "").strip()
    if configured:
        return configured
    source_sha = os.getenv("TABTIN_SOURCE_SHA", os.getenv("TABTIN_GIT_SHA", "")).strip()
    return f"tabtin-django@{source_sha}" if source_sha else None


def resolve_sentry_initial_scope() -> dict[str, dict[str, str]]:
    """为每个 Django 事件保留实际镜像源码 SHA，供告警归因使用。"""
    source_sha = os.getenv("TABTIN_SOURCE_SHA", os.getenv("TABTIN_GIT_SHA", "")).strip()
    return {"tags": {"source_sha": source_sha}} if source_sha else {}


def init_sentry() -> bool:
    """按 env 初始化 sentry-sdk。返回是否真正启用（供自检/测试断言）。"""
    global _initialized
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    from tabtin.startup_policy import (
        StartupCapability,
        resolve_endpoint_setting,
        resolve_startup_policy,
    )

    policy = resolve_startup_policy(os.environ)
    if not policy.allows(
        StartupCapability.SENTRY,
        explicitly_configured=True,
    ):
        return False
    try:
        resolve_endpoint_setting(
            os.environ,
            "SENTRY_DSN",
            saas_default="",
        )
    except ValueError:
        logger.warning("[Sentry] Community company endpoint blocked; error reporting disabled")
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.celery import CeleryIntegration
        from sentry_sdk.integrations.django import DjangoIntegration
    except ImportError:
        logger.warning("[Sentry] SENTRY_DSN 已配置但 sentry-sdk 未安装，错误上报未启用")
        return False

    try:
        environment = resolve_sentry_environment()
    except ValueError as error:
        logger.error("[Sentry] %s；错误上报未启用", error)
        return False
    release = resolve_sentry_release()

    sentry_sdk.init(
        dsn=dsn,
        environment=environment,
        release=release,
        integrations=[DjangoIntegration(), CeleryIntegration()],
        # errors-only：不采集性能事务（自部署也按 errors-only 模式跑）
        traces_sample_rate=0,
        # 结构性现场原则：不自动带 PII（cookies / auth headers / user ip）
        send_default_pii=False,
        # 结构性现场原则：栈帧局部变量常含用户消息/文档内容（内容性现场），
        # 且 SDK 默认 scrubber 只按变量名打码、拦不住值——整体关闭。
        include_local_variables=False,
        before_send=scrub_event,
    )
    # ``initial_scope`` is not accepted by every supported sentry-sdk 2.x
    # release. Set the deployment tag through the long-standing public API
    # after initialization instead, so an observability setting can never
    # prevent the API process from starting.
    for key, value in resolve_sentry_initial_scope().get("tags", {}).items():
        sentry_sdk.set_tag(key, value)
    _initialized = True
    logger.info("[Sentry] 已启用 environment=%s release=%s", environment, release or "<unset>")
    return True


def is_enabled() -> bool:
    return _initialized


def capture_api_exception(request: Any, exc: Exception) -> None:
    """在 ninja 兜底异常 handler 里显式上报未捕获异常。

    ninja 把异常转成 500 JSON 后 Django 不再抛出，``got_request_exception``
    信号不触发，Sentry Django 集成抓不到——必须在 handler 里显式 capture。
    user 从 ``request.auth``（JWTAuth 放置的 User 实例）取，只带内部 ID 与
    昵称（契约：绝不上报手机号/邮箱）。
    """
    if not _initialized:
        return
    try:
        import sentry_sdk

        with sentry_sdk.isolation_scope() as scope:
            auth_user = getattr(request, "auth", None)
            user_id = getattr(auth_user, "id", None)
            if user_id is not None:
                scope.set_user(
                    {
                        "id": str(user_id),
                        "username": str(getattr(auth_user, "nickname", "") or ""),
                    }
                )
            scope.set_tag("handled_by", "ninja_generic_handler")
            sentry_sdk.capture_exception(exc)
    except Exception:
        logger.debug("[Sentry] capture_api_exception 失败", exc_info=True)

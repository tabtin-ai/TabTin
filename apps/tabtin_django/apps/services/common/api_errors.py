"""Multiagent API 统一错误常量与 helper。

将散落在各 API 文件中的 raise HttpError(status, message) 统一为常量引用，
减少硬编码、方便 i18n、降低拼写错误风险。
"""

from __future__ import annotations

from ninja.errors import HttpError


def _t(key: str, **kwargs) -> str:
    """安全获取 i18n 翻译文本。"""
    try:
        from apps.i18n import get_text
        return get_text(key, **kwargs)
    except Exception:
        return key


# ── 通用错误消息（惰性求值，每次访问时获取当前语言的翻译） ──

class _LazyMsg:
    """延迟翻译的消息描述符，每次访问时根据当前请求语言求值。"""
    def __init__(self, key: str, fallback: str = ""):
        self._key = key
        self._fallback = fallback

    def __str__(self) -> str:
        result = _t(self._key)
        return result if result != self._key else (self._fallback or self._key)

    def __repr__(self) -> str:
        return str(self)


MSG_UNAUTHORIZED = _LazyMsg("auth.unauthorized", "Unauthorized")
MSG_SUPERUSER_ONLY = _LazyMsg("auth.admin_only", "Admin access only")
MSG_CURSOR_INVALID_UUID = _LazyMsg("validation.invalid_cursor", "Invalid cursor UUID")
MSG_CURSOR_NOT_FOUND = _LazyMsg("resource.cursor_not_found", "Cursor not found")
MSG_LIMIT_OFFSET_INVALID = _LazyMsg("validation.invalid_limit", "Invalid limit/offset parameter")

# ── 资源级错误消息 ──────────────────────────────────────────────

MSG_TRACE_NOT_FOUND = _LazyMsg("resource.trace_not_found", "Trace not found")
MSG_RUN_NOT_FOUND = _LazyMsg("resource.run_not_found", "Run not found")
MSG_SUBAGENT_NOT_FOUND = _LazyMsg("resource.subagent_not_found", "Subagent not found")
MSG_STATE_NOT_FOUND = _LazyMsg("resource.state_not_found", "State not found")
MSG_THREAD_NOT_FOUND = _LazyMsg("resource.thread_not_found", "Thread not found")

# ── 权限 ────────────────────────────────────────────────────────

MSG_NO_ACCESS_TRACE = _LazyMsg("auth.no_access_trace", "Access denied for this trace")
MSG_NO_ACCESS_RUN = _LazyMsg("auth.no_access_run", "Access denied for this run")
MSG_NO_ACCESS_SUBAGENT = _LazyMsg("auth.no_access_subagent", "Access denied for this subagent")

# ── 参数校验 ────────────────────────────────────────────────────

MSG_MESSAGES_REQUIRED = _LazyMsg("validation.messages_required", "Messages cannot be empty")
MSG_SESSION_NOT_FOUND = _LazyMsg("resource.session_not_found", "Session not found or access denied")
MSG_THREAD_ID_REQUIRED = _LazyMsg("validation.thread_id_required", "thread_id is required")
MSG_DECISIONS_REQUIRED = _LazyMsg("validation.decisions_required", "Decisions cannot be empty")
MSG_ANSWERS_REQUIRED = _LazyMsg("validation.answers_required", "Answers cannot be empty")
MSG_PROMPT_REQUIRED = _LazyMsg("validation.prompt_required", "Prompt is required")
MSG_APP_TYPE_REQUIRED = _LazyMsg("validation.app_type_required", "app_type is required for oneshot generation")
MSG_RUN_ID_INVALID_UUID = _LazyMsg("validation.invalid_run_id", "Invalid run_id UUID")


# ── helper ──────────────────────────────────────────────────────

def raise_unauthorized() -> None:
    raise HttpError(401, str(MSG_UNAUTHORIZED))


def raise_superuser_only() -> None:
    raise HttpError(403, str(MSG_SUPERUSER_ONLY))


def raise_forbidden(message: str) -> None:
    raise HttpError(403, message)


def raise_not_found(message: str) -> None:
    raise HttpError(404, message)


def raise_bad_request(message: str) -> None:
    raise HttpError(400, message)


def raise_internal(message: str) -> None:
    raise HttpError(500, message)


# ── Wave 9 i18n 治理:强制走 i18n key 的 helper ────────────────────
#
# 背景:`apps.tabdata.api_helpers.permission_denied_response` 接受裸字符串,
# caller 容易写 `permission_denied_response("权限不足")` 中文硬编码,绕过
# i18n。这组 helper **要求传入 i18n key**(如 "scheduler.no_permission"),
# 由 caller 显式传 key,避免裸字符串扩散。
#
# 现存 caller(scheduler / agenda / goal API)Wave 9 已就近改写为
# `permission_denied_response(_("key"))`,新代码推荐直接用本模块 helper。

def raise_forbidden_i18n(detail_key: str, **kwargs) -> None:
    """403 — 强制传 i18n key。

    例::

        raise_forbidden_i18n("scheduler.tracker_dry_run_no_permission")
        raise_forbidden_i18n("auth.no_access_run", run_id=run_id)

    `detail_key` 必须是 i18n key 字符串(如 ``"scheduler.no_permission"``),
    不是裸消息;运行时通过 ``apps.i18n.get_text`` 翻译并替换 ``**kwargs``。
    """
    raise HttpError(403, _t(detail_key, **kwargs))


def raise_not_found_i18n(detail_key: str, **kwargs) -> None:
    """404 — 强制传 i18n key。"""
    raise HttpError(404, _t(detail_key, **kwargs))


def raise_bad_request_i18n(detail_key: str, **kwargs) -> None:
    """400 — 强制传 i18n key。"""
    raise HttpError(400, _t(detail_key, **kwargs))


def raise_internal_i18n(detail_key: str, **kwargs) -> None:
    """500 — 强制传 i18n key。"""
    raise HttpError(500, _t(detail_key, **kwargs))

"""
TabData 请求上下文

用于在一次请求生命周期内透传前端窗口维度信息（X-Window-Id），
供 signals/service 在无 request 参数时读取。

使用 ContextVar 而非 threading.local，避免 Celery 线程复用时
上一个 task 的 window_id 残留到下一个 task。
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

_window_id_var: ContextVar[Optional[str]] = ContextVar("window_id", default=None)
_table_share_grant_var: ContextVar[object | None] = ContextVar("table_share_grant", default=None)
_table_share_password_var: ContextVar[Optional[str]] = ContextVar("table_share_password", default=None)
_parent_document_id_var: ContextVar[Optional[str]] = ContextVar(
    "parent_document_id",
    default=None,
)
_embedded_access_verification_unavailable_var: ContextVar[bool] = ContextVar(
    "embedded_access_verification_unavailable",
    default=False,
)


def set_current_window_id(window_id: Optional[str]) -> None:
    """设置当前请求 window_id（会做基础规范化）。"""
    if window_id is None:
        _window_id_var.set(None)
        return

    normalized = str(window_id).strip()
    if not normalized:
        _window_id_var.set(None)
        return

    _window_id_var.set(normalized[:128])


def get_current_window_id() -> Optional[str]:
    """获取当前请求 window_id。"""
    value = _window_id_var.get()
    if not value:
        return None
    return str(value)


def set_current_table_share_grant(share_grant: object | None) -> None:
    """设置当前请求的表格分享授权。"""
    _table_share_grant_var.set(share_grant)


def get_current_table_share_grant() -> object | None:
    """获取当前请求的表格分享授权。"""
    return _table_share_grant_var.get()


def set_current_table_share_password(password: Optional[str]) -> None:
    """设置当前请求的表格分享密码。"""
    normalized = (password or "").strip()
    _table_share_password_var.set(normalized or None)


def get_current_table_share_password() -> str:
    """获取当前请求的表格分享密码。"""
    return _table_share_password_var.get() or ""


def set_current_parent_document_id(document_id: Optional[str]) -> None:
    """Set the TabDoc that hosts an embedded resource for this request."""
    normalized = (document_id or "").strip()
    _parent_document_id_var.set(normalized[:64] or None)


def get_current_parent_document_id() -> Optional[str]:
    """Return the TabDoc hosting the current embedded-resource request."""
    return _parent_document_id_var.get()


@contextmanager
def parent_document_access_context(document_id: Optional[str]) -> Iterator[None]:
    """Temporarily scope embedded-resource checks to one parent document.

    WebSocket subscriptions and other non-HTTP entry points use this helper so
    concurrent permission checks cannot leak a client-supplied parent context.
    """
    normalized = (document_id or "").strip()
    parent_token = _parent_document_id_var.set(normalized[:64] or None)
    unavailable_token = _embedded_access_verification_unavailable_var.set(False)
    try:
        yield
    finally:
        _embedded_access_verification_unavailable_var.reset(unavailable_token)
        _parent_document_id_var.reset(parent_token)


def mark_embedded_access_verification_unavailable() -> None:
    """Record that the parent-child relationship could not be verified."""
    _embedded_access_verification_unavailable_var.set(True)


def is_embedded_access_verification_unavailable() -> bool:
    return _embedded_access_verification_unavailable_var.get()


def clear_request_context() -> None:
    """清理请求上下文，避免线程复用污染。"""
    _window_id_var.set(None)
    _table_share_grant_var.set(None)
    _table_share_password_var.set(None)
    _parent_document_id_var.set(None)
    _embedded_access_verification_unavailable_var.set(False)

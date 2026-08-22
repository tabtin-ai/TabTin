"""
Platform-wide context helpers.

横切关注点：在单次 Agent 运行周期内传递 run_id / session_id 等 ContextVar，
供 tabdata / tabdoc / collab / tabslide / tabvideo / tabwhiteboard 等模块使用。

从 orchestration.context.run_context 迁移而来（Wave 11），
调用方统一使用 `from apps.services.common.platform_context import ...`。
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Optional

logger = logging.getLogger(__name__)


run_id_var: ContextVar[Optional[str]] = ContextVar("run_id", default=None)
session_id_var: ContextVar[Optional[str]] = ContextVar("session_id", default=None)


def get_current_run_id() -> Optional[str]:
    return run_id_var.get()


def set_current_run_id(run_id: Optional[str]):
    return run_id_var.set(run_id)


def reset_current_run_id(token) -> None:
    run_id_var.reset(token)


def get_current_session_id() -> Optional[str]:
    return session_id_var.get()


def set_current_session_id(session_id: Optional[str]):
    return session_id_var.set(session_id)


def reset_current_session_id(token) -> None:
    session_id_var.reset(token)


def reset_all_context() -> None:
    """Reset ALL ContextVars across modules to prevent cross-session leakage.

    Consolidates cleanup for:
    - run_id_var (this module)
    - thread_context vars (thread_id, workspace_root, space_id, etc.)
    - tool permission vars (authorization_rules, permission_decisions, deny_tools)
    - skill env vars (_skill_env_ctx)
    - LLM context vars (request_id, trace_id, source)
    - delegation object_scope (PR7/A-1)
    - API Key organization constraint (PR7/ATK-2)
    - trace middleware vars (safety net for TraceContext.close)

    Every finally/cleanup path that ends a request or task MUST call this
    instead of individual clear functions to guarantee no ContextVar is missed.
    Uses lazy imports to avoid circular dependencies.
    """
    run_id_var.set(None)
    session_id_var.set(None)

    try:
        from apps.services.common.thread_context import clear_context
        clear_context()
    except Exception:
        logger.debug("Failed to reset thread_context", exc_info=True)

    try:
        from apps.services.tools.base import reset_tool_permission_context
        reset_tool_permission_context()
    except Exception:
        logger.debug("Failed to reset tool_permission_context", exc_info=True)

    try:
        from apps.services.llm.context import _llm_request_id_var, _llm_trace_id_var, _llm_source_var
        _llm_request_id_var.set(None)
        _llm_trace_id_var.set(None)
        _llm_source_var.set(None)
    except Exception:
        logger.debug("Failed to reset llm context vars", exc_info=True)

    # ATK-2 / PR7: API Key organization 约束 ContextVar
    try:
        from apps.users.auth.api_key_context import _api_key_organization_var
        _api_key_organization_var.set('')
    except Exception:
        logger.debug("Failed to reset api_key_organization", exc_info=True)

    # PR7: Trace middleware ContextVar（安全网：TraceContext.close() 可能因异常跳过）
    try:
        from apps.services.common.observability.trace import (
            trace_id_var, thread_id_var as trace_thread_id_var,
            graph_type_var, user_id_var as trace_user_id_var,
            parent_event_id_var, last_node_event_id_var,
        )
        trace_id_var.set(None)
        trace_thread_id_var.set(None)
        graph_type_var.set(None)
        trace_user_id_var.set(None)
        parent_event_id_var.set(None)
        last_node_event_id_var.set(None)
    except Exception:
        logger.debug("Failed to reset trace middleware vars", exc_info=True)

    try:
        from apps.tabdata.request_context import clear_request_context as _crc
        _crc()
    except Exception:
        logger.debug("Failed to reset tabdata request_context", exc_info=True)
    try:
        from apps.extensions.event_bus import _recursion_depth
        _recursion_depth.set(0)
    except Exception:
        logger.debug("Failed to reset event_bus recursion_depth", exc_info=True)


__all__ = [
    "get_current_run_id", "set_current_run_id", "reset_current_run_id",
    "get_current_session_id", "set_current_session_id", "reset_current_session_id",
    "reset_all_context",
]

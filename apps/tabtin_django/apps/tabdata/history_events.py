"""
TabData 历史事件

目标：
1. 提供统一的历史事件入口，逐步替代散落在各处的 RecordHistory 直接写入
2. 为“业务写入 -> 事件 -> 历史/Undo/推送”分层改造提供基础设施
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional
from uuid import UUID

from django.dispatch import Signal

logger = logging.getLogger(__name__)

# 历史事件信号：接收方负责落库与后续副作用（如 push undo 栈）
record_history_event = Signal()


def normalize_editor_type_for_response(editor_type: Optional[str]) -> str:
    """序列化/API 输出：将 RecordHistory 等 DB 中的 legacy ``human`` 归一为 ``user``。"""
    et = (editor_type or "").strip() or "user"
    return "user" if et == "human" else et


def get_editor_type() -> str:
    """根据运行时上下文推断 editor_type: 'agent' / 'user'。

    当前处于 Agent run 上下文中时返回 "agent"，否则返回 "user"。
    适用于无法静态确定 editor_type 的调用方（如 record_service / import_service 等），
    静态可确定的场景（如 AI 字段计算 → "agent"，公式引擎 → "system"）应直接传字面量。
    """
    try:
        from apps.services.common.platform_context import get_current_run_id
        if get_current_run_id():
            return "agent"
    except ImportError:
        pass
    return "user"


@dataclass(frozen=True)
class RecordHistoryEvent:
    """记录历史事件载荷。

    D8 / Wave 1.1：新增 ``agent_run_id`` / ``session_id`` 字段，
    在 keyword-only 函数签名末尾、默认值后追加，所有现有调用方
    （不传两字段）保持向后兼容。
    """

    record: Any
    action: str
    field_changes: Dict[str, Any]
    user: Optional[Any] = None
    window_id: Optional[str] = None
    operation_group_id: Optional[UUID] = None
    push_to_stack: bool = True
    editor_type: str = "user"  # "user" / "agent" / "system"
    agent_run_id: str = ""  # D8：关联 turn / agent_run，未在 ContextVar 中时回填 ''
    session_id: str = ""  # D8：关联 ChatSession，未在 ContextVar 中时回填 ''


def _resolve_run_context() -> tuple[str, str]:
    """读取 ContextVar 中的 agent_run_id / session_id，失败返回空串对。

    集中化此处避免每个调用方都写 try/except——history_event_listeners /
    batch_write_record_histories 内的兜底也复用。
    """
    try:
        from apps.services.common.platform_context import (
            get_current_run_id, get_current_session_id,
        )
        return (get_current_run_id() or "", get_current_session_id() or "")
    except Exception:
        return ("", "")


def emit_record_history_event(
    *,
    record: Any,
    action: str,
    field_changes: Dict[str, Any],
    user: Optional[Any] = None,
    window_id: Optional[str] = None,
    operation_group_id: Optional[UUID] = None,
    push_to_stack: bool = True,
    editor_type: str = "user",
    agent_run_id: Optional[str] = None,
    session_id: Optional[str] = None,
    sender: Any = None,
) -> None:
    """发送历史事件（robust 模式，监听器异常不阻断主流程）。

    D8：``agent_run_id`` / ``session_id`` 显式传 None 时自动从 ContextVar
    取值；调用方显式传空串视为"明知无关联"，跳过 ContextVar 兜底。
    """
    if record is None:
        return

    if agent_run_id is None or session_id is None:
        ctx_run, ctx_sess = _resolve_run_context()
        if agent_run_id is None:
            agent_run_id = ctx_run
        if session_id is None:
            session_id = ctx_sess

    event = RecordHistoryEvent(
        record=record,
        action=str(action or "").strip(),
        field_changes=field_changes or {},
        user=user,
        window_id=(str(window_id).strip()[:128] if window_id else None),
        operation_group_id=operation_group_id,
        push_to_stack=bool(push_to_stack),
        editor_type=editor_type,
        agent_run_id=str(agent_run_id or "")[:64],
        session_id=str(session_id or "")[:64],
    )

    if not event.action:
        logger.warning("[HistoryEvent] 忽略空 action 事件: record=%s", getattr(record, "id", None))
        return

    responses = record_history_event.send_robust(
        sender=sender or emit_record_history_event,
        event=event,
    )
    for receiver, response in responses:
        if isinstance(response, Exception):
            logger.warning(
                "[HistoryEvent] 监听器执行失败 receiver=%s record=%s action=%s err=%s",
                getattr(receiver, "__name__", str(receiver)),
                getattr(record, "id", None),
                event.action,
                response,
            )


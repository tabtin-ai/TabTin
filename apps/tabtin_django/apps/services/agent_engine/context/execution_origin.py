"""
ExecutionOrigin — 统一执行上下文协议
============================================

当 Tracker 步骤 / 普通 Chat 触发 Agent 执行时，通过 ExecutionOrigin 携带来源
标识和共享上下文，使下游（NativeReactLoop / ToolHub）能获知"谁发起了这次
执行"，并回传进度/结果到正确的来源。

波次 4 Stage 2.4 一刀切（2026-05-25）：
- ``AgendaGoalOrigin`` → ``TrackerOrigin``
- ``EXECUTION_SOURCE_TABAGENDA = "tabagenda"`` → ``EXECUTION_SOURCE_TRACKER = "tracker"``
- ``AGENDA_GOAL_STATE_PREFIX = "_agenda_goal_"`` / ``TABGOAL_STATE_PREFIX = "_tabgoal_"``
  全部下线，统一 ``TRACKER_STATE_PREFIX = "_tracker_"``
- ``from_state_dict`` **只识别新 source/prefix**（一刀切，不双读；产品未上线）

使用方式::

    origin = ExecutionOrigin(
        source="chat",
        organization_id="ws-xxx",
        user_id="u-xxx",
        chat=ChatOrigin(session_id="s-xxx"),
    )
    call_react_agent_sync(..., execution_origin=origin)
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, Optional

from apps.services.common.agent_protocol.constants import (
    EXECUTION_SOURCE_TRACKER,
    ORIGIN_STATE_PREFIX,
    TRACKER_STATE_PREFIX,
)


@dataclass(frozen=True)
class TrackerOrigin:
    """Tracker 来源标识。

    单 Skill 执行模型下不再有「步骤」概念，``step_run_id`` / ``step_name``
    字段已移除。
    """
    tracker_id: str = ""
    tracker_run_id: str = ""


@dataclass(frozen=True)
class ChatOrigin:
    """普通 Chat 来源标识。"""
    session_id: str = ""
    thread_id: str = ""


@dataclass
class ExecutionOrigin:
    """
    统一执行上下文。

    source 枚举:
        "chat"     — 用户直接对话触发
        "tracker"  — Tracker 步骤触发（canonical，波次 4 一刀切后唯一值）
    """
    source: str = "chat"
    organization_id: str = ""
    user_id: str = ""

    tracker: Optional[TrackerOrigin] = None
    chat: Optional[ChatOrigin] = None

    extra: Dict[str, Any] = field(default_factory=dict)

    def to_state_dict(self) -> Dict[str, Any]:
        """序列化为可注入 AgentState 的 dict。

        以 ``_origin_`` / ``_tracker_`` 前缀写入 Tracker 字段，供工具或中间件
        读取（charter v1.8 §3.4）。
        """
        d: Dict[str, Any] = {
            f"{ORIGIN_STATE_PREFIX}source": self.source,
            f"{ORIGIN_STATE_PREFIX}organization_id": self.organization_id,
            f"{ORIGIN_STATE_PREFIX}user_id": self.user_id,
        }
        if self.tracker:
            for k, v in asdict(self.tracker).items():
                d[f"{TRACKER_STATE_PREFIX}{k}"] = v
        if self.chat:
            for k, v in asdict(self.chat).items():
                d[f"{ORIGIN_STATE_PREFIX}chat_{k}"] = v
        if self.extra:
            d.update(self.extra)
        return d

    @classmethod
    def from_state_dict(cls, state: Dict[str, Any]) -> ExecutionOrigin:
        """从 AgentState dict 中还原 ExecutionOrigin。

        波次 4 Stage 2.4 一刀切：只识别新 ``_tracker_`` 前缀 + ``EXECUTION_SOURCE_TRACKER``
        source，不再兼容历史 ``_tabgoal_`` / ``_agenda_goal_`` / "tabagenda" 路径。
        """
        source = state.get(f"{ORIGIN_STATE_PREFIX}source", "chat")
        origin = cls(
            source=source,
            organization_id=state.get(f"{ORIGIN_STATE_PREFIX}organization_id", state.get("organization_id", "")),
            user_id=state.get(f"{ORIGIN_STATE_PREFIX}user_id", state.get("user_id", "")),
        )
        if source == EXECUTION_SOURCE_TRACKER or state.get(f"{TRACKER_STATE_PREFIX}tracker_id"):
            origin.tracker = TrackerOrigin(
                tracker_id=state.get(f"{TRACKER_STATE_PREFIX}tracker_id", ""),
                tracker_run_id=state.get(f"{TRACKER_STATE_PREFIX}tracker_run_id", ""),
            )
            origin.source = EXECUTION_SOURCE_TRACKER
        if source == "chat" or state.get(f"{ORIGIN_STATE_PREFIX}chat_session_id"):
            origin.chat = ChatOrigin(
                session_id=state.get(f"{ORIGIN_STATE_PREFIX}chat_session_id", state.get("session_id", "")),
                thread_id=state.get(f"{ORIGIN_STATE_PREFIX}chat_thread_id", state.get("thread_id", "")),
            )
        return origin


__all__ = [
    "ExecutionOrigin",
    "TrackerOrigin",
    "ChatOrigin",
]

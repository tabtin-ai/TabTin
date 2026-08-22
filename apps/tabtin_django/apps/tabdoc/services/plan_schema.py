"""
Plan 模式结构化 Schema 定义（Wave 1-C）

Plan 文档把"规划"作为 TabDoc Document 一等存储，结构化字段挂在
``Document.properties.plan`` 下，正文 TaskList 是其派生视图。

本模块提供 ``PlanProperties`` Pydantic 模型作为该 JSONField 的官方契约：
- 三件套工具（plan_create / plan_update_todos / plan_exit）共享
- HTTP API 校验 / 序列化的入口
- 后续 Runtime / 审批 UI 的数据约定

Schema 与 harness 总控笔记 §三 数据示例严格对齐：版本号、状态、
session/agent 标识、初始 todos 快照、approve 元数据等。
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


# ── 枚举类型 ──

PlanStatus = Literal["draft", "approved", "rejected"]
"""Plan 文档生命周期状态。

- ``draft``: 创建后尚未审批；agent 仍可调 ``plan_update_todos`` 修订；
- ``approved``: 已通过 ``plan_exit`` 审批；agent 不可再改文档；
- ``rejected``: 已被用户拒绝；agent 不可再调 ``plan_update_todos``，
  但可发新的 ``plan_create``。
"""


PlanTodoStatus = Literal["pending", "in_progress", "completed", "cancelled"]
"""Plan 内 todo 项状态，复用 todo_write 的语义。

注意：Plan 文档的 todos 是**初始快照**，执行期 ``todo_write`` 流事件
不回写 plan 文档（Plan vs Todo 严格分工）。本枚举存在仅为允许
``plan_create`` 时携带初始状态（一般为 pending），以及 draft 期通过
``plan_update_todos`` 局部调整。
"""


PlanAgentMode = Literal["plan", "study", "agent", "ask", "group"]
"""Agent 模式枚举。

记录创建 plan 时所处的 agentMode，以便后续审计/调试。
保持与 Django 端 ``apps.services.agent_engine.agent_mode.AgentMode`` 同步。
"""


# ── 子模型 ──


class PlanTodo(BaseModel):
    """Plan 文档内的单个 todo 项。

    与 ``apps.services.tools.domains.common.todo_tool.TodoItem`` 字段对齐，
    便于后续 ``todo_write`` 复用。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(
        default_factory=lambda: f"todo_{uuid4().hex[:12]}",
        description="todo 唯一标识；merge 模式下用于按 id 匹配。",
        max_length=64,
    )
    content: str = Field(description="todo 描述文本。", min_length=1, max_length=2000)
    status: PlanTodoStatus = Field(default="pending", description="todo 状态。")

    @field_validator("id")
    @classmethod
    def _id_not_blank(cls, value: str) -> str:
        v = (value or "").strip()
        if not v:
            raise ValueError("todo id 不能为空字符串")
        return v


class PlanPhase(BaseModel):
    """Plan 内的阶段划分（可选，is_project=True 时通常使用）。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(
        default_factory=lambda: f"phase_{uuid4().hex[:12]}",
        description="阶段唯一标识。",
        max_length=64,
    )
    name: str = Field(description="阶段名称。", min_length=1, max_length=200)
    summary: str = Field(default="", description="阶段简述。", max_length=2000)
    todo_ids: List[str] = Field(
        default_factory=list,
        description="该阶段关联的 todo id 列表（指向 ``PlanProperties.todos``）。",
    )

    @field_validator("id")
    @classmethod
    def _id_not_blank(cls, value: str) -> str:
        v = (value or "").strip()
        if not v:
            raise ValueError("phase id 不能为空字符串")
        return v


# ── 主体模型 ──


# 当前 Plan schema 版本，方便未来字段扩展时做向前/向后兼容判定
PLAN_PROPERTIES_VERSION = 1


class PlanProperties(BaseModel):
    """``Document.properties.plan`` 的结构化模型。

    保存后会被序列化为 dict 写入 JSONField；读取时通过
    :meth:`PlanProperties.from_document` 还原为模型实例。
    """

    model_config = ConfigDict(extra="forbid")

    version: int = Field(
        default=PLAN_PROPERTIES_VERSION,
        description="schema 版本号；字段扩展时同步递增。",
        ge=1,
    )
    status: PlanStatus = Field(default="draft", description="Plan 文档生命周期状态。")

    session_id: str = Field(
        default="",
        description="发起本次规划的会话 ID（chat session）；本期允许为空，"
        "由 Runtime 透传后填入。",
        max_length=128,
    )
    agent_id: str = Field(
        default="",
        description="发起本次规划的 Agent ID；同 session_id，允许空。",
        max_length=128,
    )
    agent_mode_at_create: PlanAgentMode = Field(
        default="plan",
        description="创建时 Agent 所处的模式。",
    )

    name: str = Field(description="Plan 名称；同步到 Document.title。", min_length=1, max_length=200)
    overview: str = Field(default="", description="Plan 概述（一段话）。", max_length=4000)

    is_project: bool = Field(
        default=False,
        description="是否为项目型 Plan（多阶段、长周期）。"
        "当 True 时建议提供 ``phases``。",
    )
    phases: List[PlanPhase] = Field(
        default_factory=list,
        description="阶段划分（可选）。",
    )

    todos: List[PlanTodo] = Field(
        default_factory=list,
        description="Plan 内的初始 todo 快照。"
        "执行期 todo_write 流事件不会回写本字段（Plan vs Todo 严格分工）。",
    )

    # ── approve / reject 元数据 ──

    approved_at: Optional[str] = Field(
        default=None,
        description="审批通过时间，ISO 8601 字符串。",
    )
    approved_by_user_id: Optional[str] = Field(
        default=None,
        description="批准 Plan 的用户 ID。",
        max_length=128,
    )
    rejected_at: Optional[str] = Field(
        default=None,
        description="拒绝时间，ISO 8601 字符串。",
    )
    rejected_by_user_id: Optional[str] = Field(
        default=None,
        description="拒绝 Plan 的用户 ID。",
        max_length=128,
    )
    plan_was_edited_by_user: bool = Field(
        default=False,
        description="approve 时用户是否修改过 plan 正文。",
    )

    # ── P1 预留字段（本 Wave 仅接收存储，不消费） ──

    allowed_prompts: List[str] = Field(
        default_factory=list,
        description="P1：approve 后允许追加的快捷指令；本期接收但不处理。",
    )

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        v = (value or "").strip()
        if not v:
            raise ValueError("plan name 不能为空")
        return v

    # ── 转换辅助 ──

    @classmethod
    def from_document(cls, document) -> "PlanProperties":
        """从 Document.properties.plan 还原 PlanProperties。

        Document 不带 plan 结构时抛 ValueError，由调用方处理。
        """
        plan_dict = (document.properties or {}).get("plan") if document else None
        if not isinstance(plan_dict, dict) or not plan_dict:
            raise ValueError("文档不是一个 Plan 文档（缺少 properties.plan）")
        return cls.model_validate(plan_dict)

    def to_document_properties(self, base_properties: Optional[dict] = None) -> dict:
        """生成可直接写入 Document.properties 的 dict。

        会保留 base_properties 中除 ``plan`` 外的其他键，避免冲掉用户/系统
        在 Document.properties 上写入的其他字段。
        """
        merged: dict = dict(base_properties or {})
        merged["plan"] = self.model_dump(mode="json", exclude_none=False)
        return merged


# ── 公共常量 ──

PLAN_DOCUMENT_TAG = "plan"
"""Plan 文档在 Document.tags 中的统一标签，便于后续筛选/检索。"""

PLANNING_COLLECTION_SYSTEM_KEY = "planning_root"
"""系统预置「规划」Collection 的 system_key 锚点，查找时优先使用。"""

PLANNING_COLLECTION_NAME = "规划"
"""Plan 文档归属的 Collection 默认显示名（用户可重命名，不影响查找）。"""

PLANNING_COLLECTION_ICON = "📋"
"""Plan Collection 的默认 icon。"""


def now_iso() -> str:
    """返回当前 UTC 时间的 ISO 8601 字符串（带 Z 后缀）。"""
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


__all__ = [
    "PlanStatus",
    "PlanTodoStatus",
    "PlanAgentMode",
    "PlanTodo",
    "PlanPhase",
    "PlanProperties",
    "PLAN_PROPERTIES_VERSION",
    "PLAN_DOCUMENT_TAG",
    "PLANNING_COLLECTION_SYSTEM_KEY",
    "PLANNING_COLLECTION_NAME",
    "PLANNING_COLLECTION_ICON",
    "now_iso",
]

"""
Plan 模式二件套工具实现（Wave 1-C）

工具层职责非常薄：
- 把 LLM/HTTP 入参经 Pydantic 校验后转给 ``PlanService``；
- 把 ``PlanServiceError`` 等异常映射成标准 error envelope
  （``success/error/error_kind/hint``，业务码走 ``upstream_code``）；
- 序列化 Plan 文档（id / title / 当前 status / markdown 等）方便上层消费。

具体业务规则全部在 ``apps.tabdoc.services.plan_service`` 内：
- Plan vs Todo 分工；
- approved 后禁止 update_todos；
- ContextItem 自动绑定「规划」Collection；
- 用户点击执行后由产品链路结算 Plan，不再把退出动作暴露成 LLM 工具。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.domains._shared import load_user as _load_user
from apps.services.tools.error_envelope import build_tool_error
from apps.tabdoc.services.plan_schema import PlanPhase, PlanTodo
from apps.tabdoc.services.plan_service import (
    PlanService,
    PlanServiceError,
)

logger = logging.getLogger(__name__)


PLAN_AVAILABLE_MODES: tuple = ("plan", "study")
"""Plan 二件套统一暴露给 LLM 的 AgentMode 范围。

与 harness 总控笔记 §三 "Wave 1-C" 验收标准对齐。Agent 模式下
Plan 工具从 LLM 视角隐藏（但 HTTP API 仍可被外部调用）。
"""


def _serialize_plan_document(document) -> Dict[str, Any]:
    return {
        "id": str(document.id),
        "organization_id": str(document.organization_id),
        "space_id": str(document.space_id),
        "title": document.title,
        "tags": list(document.tags or []),
        "latest_version": int(document.latest_version or 0),
        "updated_at": document.updated_at.isoformat() if document.updated_at else None,
    }


def _map_plan_error_code(code: str) -> tuple[str, str, bool]:
    normalized = (code or "").strip().upper()
    if normalized in {"PLAN_NOT_FOUND", "PLAN_NOT_A_PLAN"}:
        return (
            "resource_not_found",
            "Confirm the plan_document_id from plan_create still exists, then retry.",
            False,
        )
    if normalized in {"PLAN_PERMISSION_DENIED", "PLAN_NO_USER"}:
        return (
            "permission_denied",
            "Ask the user to grant TabDoc/Plan access for this Space, then retry.",
            False,
        )
    if normalized == "PLAN_NOT_DRAFT":
        return (
            "mode_restricted",
            "Only draft Plans can update todos. Create a new plan_create draft if needed.",
            False,
        )
    if normalized in {
        "PLAN_INVALID_INPUT",
        "PLAN_INVALID_TODOS",
        "PLAN_INVALID_TODO",
        "PLAN_DUPLICATE_TODO_ID",
        "PLAN_MISSING_SCOPE",
    }:
        return (
            "invalid_param_format",
            "Fix the invalid Plan fields/todos and retry.",
            False,
        )
    return (
        "upstream_error",
        "Retry once. If it fails again, tell the user Plan is temporarily unavailable.",
        True,
    )


def _service_error_to_response(exc: PlanServiceError) -> Dict[str, Any]:
    code = str(getattr(exc, "code", "") or "")
    kind, hint, retryable = _map_plan_error_code(code)
    return build_tool_error(
        getattr(exc, "message", None) or code or "Plan operation failed.",
        error_kind=kind,
        hint=hint,
        retryable=retryable,
        upstream_code=code or None,
    )


def _plan_internal_error(tool_name: str) -> Dict[str, Any]:
    return build_tool_error(
        f"{tool_name} failed due to an internal error.",
        error_kind="internal_error",
        hint="Retry once. If it fails again, ask the user to continue from the Plan UI.",
        retryable=True,
    )


# ── 共享 schema 子模型 ──


class _ToolPlanTodoInput(BaseModel):
    """LLM/HTTP 入参侧的 todo schema（与服务层 PlanTodo 字段对齐，但允许默认值）。"""

    id: Optional[str] = Field(default=None, description="todo 唯一标识；不传则自动生成。")
    content: str = Field(description="todo 描述文本。", min_length=1, max_length=2000)
    status: Optional[str] = Field(
        default="pending",
        description="todo 状态：pending | in_progress | completed | cancelled。",
    )


class _ToolPlanPhaseInput(BaseModel):
    id: Optional[str] = Field(default=None, description="阶段唯一标识。")
    name: str = Field(description="阶段名称。", min_length=1, max_length=200)
    summary: Optional[str] = Field(default="", description="阶段简述。")
    todo_ids: Optional[List[str]] = Field(default=None, description="该阶段关联的 todo id。")


# ── plan_create ──


class PlanCreateInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="用户 ID（自动从 state 注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None,
        description="工作区 ID（自动从 state 注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None,
        description="Space ID（自动从 state 注入）",
    )
    session_id: Annotated[Optional[str], InjectedState("session_id")] = Field(
        default=None,
        description="会话 ID（可选，由 Runtime 透传）",
    )
    agent_id: Annotated[Optional[str], InjectedState("execution_agent_id")] = Field(
        default=None,
        description="发起 plan 的 Agent ID（可选）",
    )
    agent_mode: Annotated[Optional[str], InjectedState("agent_mode")] = Field(
        default=None,
        description="创建时 Agent 所处的 mode（plan/study）",
    )

    name: str = Field(description="Plan 名称（同步到 Document.title）", min_length=1, max_length=200)
    overview: str = Field(default="", description="Plan 概述（一段话）", max_length=4000)
    plan: str = Field(default="", description="Plan 正文 Markdown（包含 TaskList）")
    todos: List[_ToolPlanTodoInput] = Field(
        default_factory=list,
        description="初始 todos 快照；执行期不会回写本字段（Plan vs Todo 分工）。",
    )
    is_project: bool = Field(
        default=False,
        description="是否为项目型 Plan（多阶段、长周期）。",
    )
    phases: Optional[List[_ToolPlanPhaseInput]] = Field(
        default=None,
        description="阶段划分（可选，is_project=True 时建议提供）。",
    )
    allowed_prompts: Optional[List[str]] = Field(
        default=None,
        description="P1 字段：approve 后允许的快捷指令；本期接收后存档但不消费。",
    )


class PlanCreateTool(BaseTool):
    name: str = "plan_create"
    app_id: str = "plan"
    category: str = "data_mutation"
    description: str = (
        "创建一份 Plan（规划）文档并归档到 Space 的「规划」Collection。"
        "调用时机：Plan 模式下，agent 完成需求消化、给出可审批的规划草稿时。"
        "Plan 文档结构化字段保存到 Document.properties.plan，正文 Markdown 中的 TaskList 由 todos 派生。"
        "todos 是初始快照；执行期 todo_write 流事件不会回写本工具，请配合 plan_update_todos 修订。"
    )
    # risk_level=safe：plan_create 写出的是「草稿」，不是已生效的副作用。
    # 如果设为 'review' 会被 PermissionRuleEngine 在 'cautious' 预设下分类成
    # 'write' → 'confirm' 行为，导致 Django builtin agent 路径下每次创建草稿
    # 都被强制 HITL，违反产品决策「plan_create 非 HITL（草稿随时可改，不打断
    # agent turn）」。
    risk_level: str = "safe"
    available_modes: tuple = PLAN_AVAILABLE_MODES
    required_permissions: list = ["tabdoc"]
    args_schema: type[PlanCreateInput] = PlanCreateInput

    def run(  # type: ignore[override]
        self,
        name: str,
        overview: str = "",
        plan: str = "",
        todos: Optional[List[Any]] = None,
        is_project: bool = False,
        phases: Optional[List[Any]] = None,
        allowed_prompts: Optional[List[str]] = None,
        user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        space_id: Optional[str] = None,
        session_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        agent_mode: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        user = _load_user(user_id)
        if not user:
            return build_tool_error(
                "未登录用户，无法创建 Plan",
                error_kind="runtime_misconfig",
                hint="Ensure the Agent session injects user_id before calling plan_create.",
                retryable=False,
            )
        if not organization_id or not space_id:
            return build_tool_error(
                "缺少 organization_id / space_id 上下文",
                error_kind="runtime_misconfig",
                hint="Start the Agent inside a Space so organization_id and space_id are injected.",
                retryable=False,
            )

        normalized_todos: List[Dict[str, Any]] = []
        for raw in todos or []:
            if isinstance(raw, BaseModel):
                payload = raw.model_dump(exclude_none=True)
            elif isinstance(raw, dict):
                payload = {k: v for k, v in raw.items() if v is not None}
            else:
                return build_tool_error(
                    f"todos 元素必须是 dict，收到 {type(raw).__name__}",
                    error_kind="invalid_param_format",
                    hint="Pass todos as a list of objects with content/status fields.",
                    retryable=False,
                )
            payload.pop("id", None) if not payload.get("id") else None
            normalized_todos.append(payload)

        normalized_phases: List[Dict[str, Any]] = []
        for raw in phases or []:
            if isinstance(raw, BaseModel):
                payload = raw.model_dump(exclude_none=True)
            elif isinstance(raw, dict):
                payload = {k: v for k, v in raw.items() if v is not None}
            else:
                return build_tool_error(
                    f"phases 元素必须是 dict，收到 {type(raw).__name__}",
                    error_kind="invalid_param_format",
                    hint="Pass phases as a list of objects with name/summary/todo_ids.",
                    retryable=False,
                )
            payload.pop("id", None) if not payload.get("id") else None
            normalized_phases.append(payload)

        try:
            service = PlanService(user=user)
            result = service.create_plan(
                organization_id=organization_id,
                space_id=space_id,
                name=name,
                overview=overview or "",
                plan_markdown=plan or "",
                todos=normalized_todos,
                is_project=bool(is_project),
                phases=normalized_phases,
                agent_mode_at_create=(agent_mode or "plan"),
                session_id=(session_id or ""),
                agent_id=(agent_id or ""),
                allowed_prompts=allowed_prompts,
            )
        except PlanServiceError as exc:
            return _service_error_to_response(exc)
        except Exception:  # pragma: no cover — 兜底
            logger.exception("[PlanCreateTool] unexpected failure")
            return _plan_internal_error("plan_create")

        document = result["document"]
        plan_props = result["plan"]
        return {
            "success": True,
            "document_id": str(document.id),
            "space_id": str(document.space_id),
            "organization_id": str(document.organization_id),
            "collection_id": result.get("collection_id"),
            "document": _serialize_plan_document(document),
            "plan": plan_props.model_dump(mode="json"),
        }


# ── plan_update_todos ──


class PlanUpdateTodosInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="用户 ID（自动从 state 注入）",
    )
    plan_document_id: str = Field(description="Plan 文档 ID（来自 plan_create 返回）")
    todos: List[_ToolPlanTodoInput] = Field(
        description="本次更新的 todos；merge=true 时按 id 合并，false 时全量替换。",
        min_length=1,
    )
    merge: bool = Field(
        default=True,
        description="True=按 id 合并到现有 todos；False=全量替换 todos。",
    )


class PlanUpdateTodosTool(BaseTool):
    name: str = "plan_update_todos"
    app_id: str = "plan"
    category: str = "data_mutation"
    description: str = (
        "更新 Plan 文档的 todos 结构化字段（仅在 status=draft 期可用）。"
        "merge=true 时按 id 合并；merge=false 时全量替换。"
        "调用时机：用户点击执行前对规划草稿做修订；执行期 todo_write 流事件请勿调本工具。"
    )
    # risk_level=safe：与 plan_create 同理，本工具只在 draft 期生效（service 层
    # 已硬性校验 status='draft' 才允许）；改的是尚未审批的草稿，不需要 HITL
    # confirm。Service 层另有 PLAN_NOT_DRAFT(409) 守卫保证 approved 后冻结，
    # 比 risk_level 兜底更精确。
    risk_level: str = "safe"
    available_modes: tuple = PLAN_AVAILABLE_MODES
    required_permissions: list = ["tabdoc"]
    args_schema: type[PlanUpdateTodosInput] = PlanUpdateTodosInput

    def run(  # type: ignore[override]
        self,
        plan_document_id: str,
        todos: List[Any],
        merge: bool = True,
        user_id: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        user = _load_user(user_id)
        if not user:
            return build_tool_error(
                "未登录用户，无法更新 Plan",
                error_kind="runtime_misconfig",
                hint="Ensure the Agent session injects user_id before calling plan_update_todos.",
                retryable=False,
            )

        normalized_todos: List[Dict[str, Any]] = []
        for raw in todos or []:
            if isinstance(raw, BaseModel):
                payload = raw.model_dump(exclude_none=True)
            elif isinstance(raw, dict):
                payload = {k: v for k, v in raw.items() if v is not None}
            else:
                return build_tool_error(
                    f"todos 元素必须是 dict，收到 {type(raw).__name__}",
                    error_kind="invalid_param_format",
                    hint="Pass todos as a list of objects with id/content/status fields.",
                    retryable=False,
                )
            if not payload.get("id"):
                payload.pop("id", None)
            normalized_todos.append(payload)

        try:
            service = PlanService(user=user)
            result = service.update_todos(
                plan_document_id=plan_document_id,
                todos=normalized_todos,
                merge=bool(merge),
            )
        except PlanServiceError as exc:
            return _service_error_to_response(exc)
        except Exception:  # pragma: no cover — 兜底
            logger.exception("[PlanUpdateTodosTool] unexpected failure")
            return _plan_internal_error("plan_update_todos")

        document = result["document"]
        plan_props = result["plan"]
        return {
            "success": True,
            "document_id": str(document.id),
            "document": _serialize_plan_document(document),
            "todos_after_update": result["todos_after_update"],
            "plan": plan_props.model_dump(mode="json"),
        }


# ── 注册入口 ──


def get_plan_tools() -> list[BaseTool]:
    return [
        PlanCreateTool(),
        PlanUpdateTodosTool(),
    ]


__all__ = [
    "PlanCreateTool",
    "PlanUpdateTodosTool",
    "get_plan_tools",
    "PLAN_AVAILABLE_MODES",
]

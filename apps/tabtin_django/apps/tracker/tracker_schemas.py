"""Tracker Pydantic schemas for API validation.

Wave 2 (charter v1.8 §6.4 / §7.1)：移除多步骤 DAG schema——

- 删除多步骤 DAG 相关 input / output schema：V2 已废弃，Tracker 通过单 Skill 执行。
- 删除 ``DecomposeRequest`` / ``DecomposeResponse``：AI 拆解功能在 V2 已删除。
- 删除 ``CheckpointProvideRequest``：step 级 checkpoint 已 deprecated。
- ``TrackerCreate`` 字段对齐 charter §7.1：去掉 ``steps`` / ``project_mode``
  / ``token_budget``，新增 ``skill_params`` / ``intent_snapshot``。

Wave 2 收尾 (charter v1.8 §7.1)：drop 5 个 [DEPRECATED] 字段——
``execution_config`` / ``project_mode`` / ``token_budget`` / ``max_concurrent_runs``
（Tracker）+ ``cycle_history``（TrackerRun）。schema 中所有兜底位置一并删除，回归
charter 终局形态。

Tracker 模块改名波次 3a/4：``TrackerRunOut`` / ``TrackerRunListOut`` 的 ``tracker_id``
字段（HTTP/JSON 输出字段）与 model attribute ``TrackerRun.tracker_id`` 保持一致，
避免序列化时双向 alias。
"""

from __future__ import annotations

from pydantic import BaseModel, Field, ConfigDict
from typing import Optional
from uuid import UUID
from datetime import datetime


# ─── Input ────────────────────────────────────────────────────


class TrackerCreate(BaseModel):
    """charter v1.8 §7.1 Tracker 终局创建 schema。"""

    name: str
    description: str = ""
    trigger_type: str = "manual"
    trigger_config: dict = Field(default_factory=dict)
    skill_key: str = ""
    # Wave 1 新增（charter v1.8 §7.1）：与 skill_key 配套的 Skill 启动参数。
    skill_params: Optional[dict] = None
    # Wave 1 新增（charter v1.8 §7.1 / §4.1 / §6.6）：对话路径创建时的意图快照。
    intent_snapshot: Optional[dict] = None
    # Wave 1 新增（charter v1.8 §7.1）：Tracker 必须绑定 Agent。
    # 本期 Service 层校验「创建时必填」，model 层 nullable=True 仅为兼容存量数据。
    agent_id: Optional[str] = None
    workspace_id: Optional[str] = None
    # 新版一方入口在同一事务内完成「创建 + 启用」，避免两次请求之间残留草稿。
    # 默认 False 保持旧客户端 / 旧脚本的创建契约不变。
    activate_on_create: bool = False


class TrackerUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    trigger_type: Optional[str] = None
    trigger_config: Optional[dict] = None
    skill_key: Optional[str] = None
    skill_params: Optional[dict] = None
    intent_snapshot: Optional[dict] = None
    agent_id: Optional[str] = None
    workspace_id: Optional[str] = None


class TriggerRequest(BaseModel):
    trigger_context: dict = Field(default_factory=dict)


class ScheduleOccurrenceOut(BaseModel):
    """日历预览中的虚拟未来执行点（不落库、非 TrackerRun）。"""

    tracker_id: str
    name: str
    space_id: Optional[str] = None
    space_name: Optional[str] = None
    scheduled_at: str
    status: str
    trigger_type: str
    timezone: str


class SchedulePreviewOut(BaseModel):
    occurrences: list[ScheduleOccurrenceOut] = Field(default_factory=list)
    truncated: bool = False


# ─── Output ───────────────────────────────────────────────────


class TrackerCapabilities(BaseModel):
    """当前请求用户对 Tracker / Run 的服务端权威动作能力。

    capability 只描述授权边界，不替代资源状态机。Tracker 级 ``can_trigger``
    因此只看 editor 权限；Run 级 ``can_cancel`` 由 API 额外叠加可取消状态。
    """

    can_edit: bool = False
    can_trigger: bool = False
    can_cancel: bool = False


class TrackerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    description: str
    trigger_type: str
    trigger_config: dict
    status: str
    skill_key: str = ""
    skill_params: Optional[dict] = None
    intent_snapshot: Optional[dict] = None
    # 历史遗留字段（前端 TrackerTask.execution_type 仍透传，但实际已无消费方）；
    # 兼容老 Tracker 数据，从 skill_params['execution_type'] 浅读。
    execution_type: str = ""
    space_id: Optional[UUID] = None
    # 所属 Workspace 显示名；列表/详情跨 Space 筛选时前端直接展示，避免只见 UUID。
    space_name: Optional[str] = None
    agent_id: Optional[UUID] = None
    workspace_id: Optional[UUID] = None
    total_runs: int
    success_runs: int
    fail_runs: int
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    capabilities: TrackerCapabilities = Field(default_factory=TrackerCapabilities)
    created_at: datetime
    updated_at: datetime


class TrackerListOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    description: str
    trigger_type: str
    # 列表卡片展示调度频率所需的安全子集；不返回 webhook secret 等完整触发配置。
    schedule_config: dict = Field(default_factory=dict)
    status: str
    skill_key: str = ""
    # 同 TrackerOut.execution_type；前端 trackerApi.mapListRowToTask 读取本字段。
    execution_type: str = ""
    # 纯 Agent 模式下列表「指令摘要」列用；从 skill_params.instructions 浅读，不另存。
    instructions: str = ""
    space_id: Optional[UUID] = None
    # 同 TrackerOut.space_name；organization scope 下列表行展示所属 Workspace。
    space_name: Optional[str] = None
    agent_id: Optional[UUID] = None
    workspace_id: Optional[UUID] = None
    total_runs: int
    success_runs: int
    fail_runs: int
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    capabilities: TrackerCapabilities = Field(default_factory=TrackerCapabilities)
    created_at: datetime
    updated_at: datetime


class TrackerRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    tracker_id: UUID
    chat_session_id: Optional[UUID] = None
    trigger_type: str
    trigger_context: dict = Field(default_factory=dict)
    status: str
    progress: int
    progress_pct: int = 0
    progress_message: str = ""
    tokens_used: int = 0
    current_cycle: int = 1
    max_cycles: int = 3
    artifacts: list = Field(default_factory=list)
    report_doc_id: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    duration: Optional[float] = None
    error_summary: str
    # TS-28：completed 时透出 Agent 回复正文（context.agent_result.response 截断），
    # 让详情页能看到执行结果；非 completed 为空串。
    result_summary: str = ""
    capabilities: TrackerCapabilities = Field(default_factory=TrackerCapabilities)
    created_at: datetime


class TrackerRunListOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    tracker_id: UUID
    chat_session_id: Optional[UUID] = None
    trigger_type: str
    trigger_context: dict = Field(default_factory=dict)
    status: str
    progress: int
    progress_pct: int = 0
    progress_message: str = ""
    tokens_used: int = 0
    current_cycle: int = 1
    max_cycles: int = 3
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    duration: Optional[float] = None
    error_summary: str
    # TS-28：同 TrackerRunOut.result_summary，列表接口也透出执行结果正文。
    result_summary: str = ""
    capabilities: TrackerCapabilities = Field(default_factory=TrackerCapabilities)
    created_at: datetime

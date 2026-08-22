"""Agent 领域 API schema（身份 / 规则 / 配置）。

执行现场相关校验（working_dir 等）不属于本模块；见 tabtinspace.schemas.space。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from ninja import Schema
from pydantic import BaseModel, ConfigDict, Field

# 治理配置强类型仍暂住 tabtinspace（agent_config_v3 体积大、与 Organization 天花板耦合）。
from apps.tabtinspace.schemas.agent_config_v3 import AgentConfigUpdateSchema


class AgentCreate(BaseModel):
    organization_id: UUID = Field(..., description="所属组织 ID")
    name: str = Field(default="", max_length=100, description="Agent 名称")
    type: Literal["bot"] = Field(default="bot", description="Agent 类型")
    custom_rules: Optional[str] = Field(None, max_length=5000, description="自定义规则")
    goal: Optional[str] = Field(None, max_length=5000, description="Agent 目标")
    template_id: Optional[str] = Field(
        None,
        max_length=64,
        pattern=r"^[a-z0-9][a-z0-9-]*$",
        description="平台 Agent 模板 slug",
    )
    avatar_key: Optional[str] = Field(
        None,
        max_length=64,
        pattern=r"^[a-z0-9][a-z0-9-]*$",
        description="平台品牌头像标识；创建时写入 settings.avatar_key",
    )
    agent_config: Optional[Dict[str, Any]] = Field(
        default=None, description="Agent 能力/安全配置",
    )


class AgentUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100, description="Agent 名称")
    custom_rules: Optional[str] = Field(None, max_length=5000, description="自定义规则")
    goal: Optional[str] = Field(None, max_length=5000, description="Agent 目标")
    suggested_prompts: Optional[List[str]] = Field(
        None,
        max_length=20,
        description="推荐问题",
    )
    avatar_url: Optional[str] = Field(
        None,
        max_length=2048,
        description="自定义头像 URL；写入 settings.avatar_url。空字符串清除，客户端回退默认 logo。未传则不动。",
    )
    avatar_key: Optional[str] = Field(
        None,
        max_length=64,
        pattern=r"^[a-z0-9][a-z0-9-]*$",
        description="平台品牌头像标识；写入 settings.avatar_key，并清除旧 avatar_url。未传则不动。",
    )
    agent_config: Optional[AgentConfigUpdateSchema] = None


class AgentOut(BaseModel):
    id: UUID
    organization_id: UUID
    owner_user_id: Optional[str] = None
    name: str
    display_name: str = Field(default="", description="展开模板 owner 占位符后的显示名")
    type: str
    is_active: bool
    is_default: bool = Field(default=False, description="是否为用户在该组织的默认 Agent")
    settings: Dict[str, Any] = Field(default_factory=dict, description="Agent 展示配置")
    custom_rules: str = Field(default="", description="自定义规则")
    goal: str = Field(default="", description="Agent 目标")
    personal_rules: Optional[str] = Field(
        default=None,
        description="Agent owner 的个人通用规则（UserProfile.personal_rules，per-owner）",
    )
    agent_config: Dict[str, Any] = Field(default_factory=dict, description="Agent 能力/安全配置")
    suggested_prompts: List[str] = Field(
        default_factory=list, description="推荐问题（对话空状态展示）",
    )
    preferred_model_id: str = Field(default="", description="用户偏好模型 ID（新对话优先使用）")
    template_id: str = Field(default="", description="来源模板 ID")
    template_version: str = Field(default="", description="来源模板版本")
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class AgentSummaryOut(BaseModel):
    """Agent 列表专用摘要投影。

    保留 ``custom_rules``：它是 Agent 表字段，无 N+1，Composer 下拉副行
    直接依赖它展示人设。刻意不含 ``personal_rules`` / ``agent_config`` /
    ``suggested_prompts`` / ``preferred_model_id``——这些体积大或依赖
    per-owner 查询，只在详情（``GET /agents/{id}``）里解析。
    """

    id: UUID
    organization_id: UUID
    owner_user_id: Optional[str] = None
    name: str
    display_name: str = Field(default="", description="展开模板 owner 占位符后的显示名")
    type: str
    is_active: bool
    is_default: bool = Field(default=False, description="是否为用户在该组织的默认 Agent")
    settings: Dict[str, Any] = Field(default_factory=dict, description="Agent 展示配置")
    custom_rules: str = Field(default="", description="自定义规则（人设）")
    goal: str = Field(default="", description="Agent 目标")
    template_id: str = Field(default="", description="来源模板 ID")
    template_version: str = Field(default="", description="来源模板版本")
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class AgentPreferredModelUpdate(BaseModel):
    model_id: str = Field(default="", description="偏好模型 ID")


class AgentSkillAttach(BaseModel):
    skill_canonical_key: str = Field(..., min_length=3, max_length=160)
    space_id: Optional[UUID] = Field(
        None,
        description="SubAgentTemplate 同步用 workspace；缺省则从最近会话推断，仍无则跳过 sync",
    )
    enabled: bool = Field(
        True,
        description=(
            "挂载后的 Agent 子开关。默认 True。"
            "工作区目录 Skill（workspace:）关闭时传 False 写入 opt-out 行。"
        ),
    )


class AgentSkillUpdate(BaseModel):
    enabled: Optional[bool] = None
    config_json: Optional[Dict[str, Any]] = None
    space_id: Optional[UUID] = Field(
        None,
        description="SubAgentTemplate 同步用 workspace；缺省则从最近会话推断，仍无则跳过 sync",
    )


class ErrorResponse(Schema):
    success: bool = False
    message: str
    code: Optional[str] = None


__all__ = [
    "AgentCreate",
    "AgentUpdate",
    "AgentOut",
    "AgentSummaryOut",
    "AgentPreferredModelUpdate",
    "AgentSkillAttach",
    "AgentSkillUpdate",
    "ErrorResponse",
    "AgentConfigUpdateSchema",
]

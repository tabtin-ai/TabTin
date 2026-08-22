"""Tins Pydantic schemas for API validation."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ─── Input ────────────────────────────────────────────────────


ActivationRuleType = Literal["url_pattern", "page_language", "page_content", "always"]
VariableFieldType = Literal["text", "select", "number", "boolean"]
ActivationMode = Literal["auto", "suggest", "manual"]
ActivationMatch = Literal["any", "all"]
PanelPosition = Literal["sidebar_right", "sidebar_left", "bottom_panel", "overlay"]
TinSource = Literal["agent_generated", "user_created", "market", "shared"]
TinStatus = Literal["draft", "active", "disabled"]


class ActivationRuleInput(BaseModel):
    type: ActivationRuleType = "url_pattern"
    patterns: List[str] = Field(default_factory=list)
    languages: List[str] = Field(default_factory=list)
    keywords: List[str] = Field(default_factory=list)


class VariableSchemaInput(BaseModel):
    type: VariableFieldType = "text"
    label: str = ""
    default: Any = None
    options: List[str] = Field(default_factory=list)


class TinCreate(BaseModel):
    name: str
    description: str = ""
    icon_url: str = ""

    activation_mode: ActivationMode = "auto"
    activation_rules: List[ActivationRuleInput] = Field(default_factory=list)
    activation_match: ActivationMatch = "any"
    variables_schema: Dict[str, VariableSchemaInput] = Field(default_factory=dict)
    permissions: List[str] = Field(default_factory=list)
    panel_position: PanelPosition = "sidebar_right"
    panel_width: int = 360

    panel_html: str = ""
    content_script: str = ""
    background_script: str = ""
    agent_instructions: str = ""

    # source 由 API 层/FC 工具层硬编码，不允许客户端设置


class TinUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon_url: Optional[str] = None

    activation_mode: Optional[ActivationMode] = None
    activation_rules: Optional[List[ActivationRuleInput]] = None
    activation_match: Optional[ActivationMatch] = None
    variables_schema: Optional[Dict[str, VariableSchemaInput]] = None
    permissions: Optional[List[str]] = None
    panel_position: Optional[PanelPosition] = None
    panel_width: Optional[int] = None

    panel_html: Optional[str] = None
    content_script: Optional[str] = None
    background_script: Optional[str] = None
    agent_instructions: Optional[str] = None


class TinFileUpdate(BaseModel):
    """更新 Tin 的单个文件。"""
    file_type: Literal["panel_html", "content_script", "background_script", "agent_instructions"]
    content: str


class TinInstanceCreate(BaseModel):
    tin_id: UUID
    space_id: UUID
    user_variables: Dict[str, Any] = Field(default_factory=dict)
    is_enabled: bool = True
    pinned: bool = False


class TinInstanceUpdate(BaseModel):
    is_enabled: Optional[bool] = None
    pinned: Optional[bool] = None
    user_variables: Optional[Dict[str, Any]] = None


# ─── Output ───────────────────────────────────────────────────


class TinOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    space_id: Optional[UUID] = None
    name: str
    description: str
    icon_url: str
    version: str
    status: TinStatus
    source: TinSource

    activation_mode: ActivationMode
    activation_rules: list
    activation_match: ActivationMatch
    variables_schema: dict
    permissions: list
    panel_position: PanelPosition
    panel_width: int

    created_by: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime


class TinDetailOut(TinOut):
    """包含完整文件内容的详情输出。"""
    panel_html: str
    content_script: str
    background_script: str
    agent_instructions: str
    manifest: dict
    package_url: str


class TinInstanceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    tin_id: UUID
    organization_id: UUID
    space_id: UUID
    is_enabled: bool
    pinned: bool
    user_variables: dict
    last_activated_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class TinSummaryOut(TinOut):
    """列表级 Tin 摘要，含 panel_html 和 content_script（sandbox 渲染和页面注入必需），不含其他大字段。"""
    panel_html: str
    content_script: str


class TinInstanceListOut(TinInstanceOut):
    """列表接口使用的轻量实例输出，内嵌 TinSummaryOut（仅含 panel_html）。"""
    tin: TinSummaryOut


class TinInstanceDetailOut(TinInstanceOut):
    """带 Tin 详情的实例输出（用于单个实例详情渲染）。"""
    tin: TinDetailOut


class TinRunLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    instance_id: UUID
    action: str
    input_data: dict
    output_data: dict
    error: str
    duration_ms: Optional[int] = None
    created_at: datetime

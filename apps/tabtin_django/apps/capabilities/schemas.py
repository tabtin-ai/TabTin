"""Capabilities API Schemas"""

import re
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from ninja import Schema
from pydantic import validator, Field

from apps.capabilities.constants import DEFAULT_TOP_K, MAX_TOP_K, MAX_PAGE_SIZE


# ─── 枚举常量 ────────────────────────────────────────

ToolCategoryLiteral = Literal["app", "runtime", "service", "extension", "platform", "custom"]
InterfaceTypeLiteral = Literal["function_call", "cli", "api", "hybrid"]
ExecutionTargetLiteral = Literal["frontend", "backend", "hybrid"]
RiskLevelLiteral = Literal["safe", "review", "strict"]
ToolStatusLiteral = Literal["active", "deprecated", "disabled"]
LinkRelationLiteral = Literal["required", "optional", "activates", "references"]


# ─── Tool Schemas ────────────────────────────────────────

class ToolOut(Schema):
    """工具详情输出。"""
    id: UUID
    name: str
    display_name: str
    description: str
    category: ToolCategoryLiteral
    provider_id: str
    domain: str
    tags: List[str]
    interface_type: InterfaceTypeLiteral
    execution_target: ExecutionTargetLiteral
    parameters_schema: Dict[str, Any]
    return_schema: Dict[str, Any]
    risk_level: RiskLevelLiteral
    permissions: List[str]
    optional: bool
    source: str
    source_ref: str
    version: str
    documentation: str
    examples: List[Any]
    status: ToolStatusLiteral
    created_at: str
    updated_at: str


class ToolBrief(Schema):
    """工具简要信息（列表用）。"""
    id: UUID
    name: str
    display_name: str
    description: str
    category: ToolCategoryLiteral
    provider_id: str
    domain: str
    tags: List[str]
    interface_type: InterfaceTypeLiteral
    execution_target: ExecutionTargetLiteral
    risk_level: RiskLevelLiteral
    optional: bool
    source: str
    status: ToolStatusLiteral


_TOOL_NAME_RE = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_.\-]{1,127}$')


class ToolCreateIn(Schema):
    """创建自定义工具。"""
    name: str
    display_name: str
    description: str
    category: ToolCategoryLiteral = "custom"

    @validator("name")
    def validate_name(cls, v):
        if not _TOOL_NAME_RE.match(v):
            raise ValueError("name 格式无效：仅允许字母、数字、下划线、点、横线，2-128 字符")
        return v
    provider_id: str = "custom"
    domain: str = "custom"
    tags: List[str] = []
    interface_type: InterfaceTypeLiteral = "function_call"
    execution_target: ExecutionTargetLiteral = "backend"
    parameters_schema: Dict[str, Any] = {}
    return_schema: Dict[str, Any] = {}
    risk_level: RiskLevelLiteral = "safe"
    permissions: List[str] = []
    optional: bool = False
    documentation: str = ""
    examples: List[Any] = []


class ToolUpdateIn(Schema):
    """更新工具（部分字段）。"""
    display_name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[ToolCategoryLiteral] = None
    provider_id: Optional[str] = None
    domain: Optional[str] = None
    tags: Optional[List[str]] = None
    interface_type: Optional[InterfaceTypeLiteral] = None
    execution_target: Optional[ExecutionTargetLiteral] = None
    parameters_schema: Optional[Dict[str, Any]] = None
    return_schema: Optional[Dict[str, Any]] = None
    risk_level: Optional[RiskLevelLiteral] = None
    permissions: Optional[List[str]] = None
    optional: Optional[bool] = None
    documentation: Optional[str] = None
    examples: Optional[List[Any]] = None
    status: Optional[ToolStatusLiteral] = None


class ToolSearchIn(Schema):
    """语义检索请求。"""
    query: str
    top_k: int = Field(default=DEFAULT_TOP_K, ge=1, le=MAX_TOP_K)
    category: Optional[ToolCategoryLiteral] = None
    provider_id: Optional[str] = None
    domain: Optional[str] = None


class ToolSearchResult(Schema):
    """语义检索结果。"""
    tool: ToolBrief
    score: float


# ─── Sync Schemas ────────────────────────────────────────

class SyncResult(Schema):
    """同步结果统计。"""
    total: int
    created: int
    updated: int
    deprecated: int
    skipped: int


# ─── Link Schemas ────────────────────────────────────────

class ToolSkillLinkOut(Schema):
    """工具-Skill 关联。"""
    tool_name: str
    skill_key: str
    relation_type: LinkRelationLiteral


class ToolSkillLinkIn(Schema):
    """创建工具-Skill 关联。"""
    tool_name: str
    skill_key: str
    relation_type: LinkRelationLiteral = "references"


# ─── Discovery Schemas ───────────────────────────────────

class DiscoverIn(Schema):
    """统一发现请求。"""
    query: str
    top_k: int = Field(default=DEFAULT_TOP_K, ge=1, le=MAX_TOP_K // 2)
    include_tools: bool = True
    include_skills: bool = True
    category: Optional[ToolCategoryLiteral] = None


class CategoryStat(Schema):
    """分类统计。"""
    category: str
    tool_count: int


class ProviderStat(Schema):
    """提供者统计。"""
    provider_id: str
    category: str
    tool_count: int
    domains: List[str]

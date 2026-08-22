"""FTS API Pydantic schemas（PRD 4.6 严格对齐）。

设计要点：
    - SearchParams：django-ninja Query 自动绑定 GET 参数；可选字段全部
      `Optional[...] = None`，避免误把 "" 当成有值
    - SearchResultItem：覆盖 6 类对象的 superset 字段（PRD 4.6 响应示例
      给出的字段全部齐备）；不同类型按需填充，不强制每个字段都有值
    - SearchResponse：含 PRD 3.12 降级三级反馈所需的全部数据契约
      （degraded / degraded_reason / partial_indices）

短语搜索说明：
    schemas 只负责数据结构，`q` 是否带引号的解析放在 search_service。
    这里不预先剥引号，让 search_service 看到原始 query 决定走 match
    还是 match_phrase。

字段命名约定：
    - 时间字段统一 `*_at`，ISO 8601 字符串
    - id 字段统一 `*_id`，类型 `Optional[str]`（UUID 文本形式）
    - 高亮字段 `highlight: dict[str, list[str]]`，key 是字段名，value 是
      含 `<em>...</em>` 标签的片段列表

兼容性：
    - SearchResponse 字段命名严格匹配 PRD 8.1 前端 `UnifiedSearchResponse`
      接口，Wave 3 前端不需要再做适配层
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from ninja import Schema
from pydantic import Field, field_validator

# PRD 4.6 covered types（前端需要根据这个 union 判断卡片渲染分支）
SearchType = Literal["messages", "resources", "agents", "spaces", "memos", "im"]
ResultType = Literal["message", "resource", "agent", "space", "memo", "im"]
CreatorType = Literal["user", "agent", "any"]
RoleFilter = Literal["user", "assistant", "any"]
SearchModeRequest = Literal["fast", "fallback_ok"]
SearchModeResponse = Literal["normal", "fallback"]


# ── 请求 schema ───────────────────────────────────────────────
class SearchParams(Schema):
    """`GET /api/search` 请求参数（PRD 4.6）。

    ninja-Query 自动从 querystring 绑定。`types` / `item_type` 等多值
    字段约定走逗号分隔字符串（避免 GET 多值带数组参数难处理），由
    search_service 在内部 split。
    """

    q: str = Field(..., min_length=1, max_length=512, description="搜索关键词，带引号视为短语精确搜索")
    organization_id: str = Field(..., min_length=1, description="租户隔离必填（PRD 5.1）")
    types: Optional[str] = Field(None, description="逗号分隔：messages,resources,agents,spaces,memos,im")
    item_type: Optional[str] = Field(None, description="resources 子类：tabdoc/tabdata/tabslide/tabcode/...")
    space_id: Optional[str] = Field(None, description="收窄到指定 Space")
    agent_id: Optional[str] = Field(None, description="按 Agent 筛（Agent-first）")
    creator_type: Optional[CreatorType] = Field(None, description="user/agent/any，默认 any")
    role: Optional[RoleFilter] = Field(None, description="消息 role 过滤：user/assistant/any")
    created_after: Optional[str] = Field(None, description="ISO datetime 下限")
    created_before: Optional[str] = Field(None, description="ISO datetime 上限")
    limit: int = Field(20, ge=1, le=100, description="单类型条数上限；全部 tab 默认 5（前端控制）")
    offset: int = Field(0, ge=0, le=10_000, description="分页偏移")
    mode: SearchModeRequest = Field("fast", description="fast 仅 ES，fallback_ok 允许直接走降级响应")

    @field_validator("organization_id")
    @classmethod
    def _validate_organization_id(cls, v: str) -> str:
        # 拒绝可疑空白；UUID 格式校验留给 service 层（避免 schemas 强耦合 UUID）
        if not v.strip():
            raise ValueError("organization_id 不能是空白")
        return v.strip()

    @field_validator("types", "item_type", "space_id", "agent_id", mode="before")
    @classmethod
    def _empty_to_none(cls, v: Any) -> Any:
        """空串归一为 None，避免下游误把 "" 当作有效过滤值。"""
        if isinstance(v, str) and not v.strip():
            return None
        return v


# ── 响应：单条结果 ────────────────────────────────────────────
class SearchResultItem(Schema):
    """统一搜索结果项（PRD 4.6 响应示例的 superset）。

    各类型按需填充：
        - message：title=session_title / snippet=content highlight / session_id 必填
        - resource：title=item title / resource_id 必填 / item_type 反映资源子类
        - agent：title=agent name / metadata 含 agent type
        - space：title=space name / space_id 必填
        - memo：title 取首行（hydration 截断）
        - im：title=conversation_name / session_id=conversation_id（前端导航复用）
    """

    id: str
    type: ResultType
    title: str
    snippet: str = ""
    highlight: dict[str, list[str]] = Field(default_factory=dict, description="字段名 → 含 <em> 标签片段列表")

    creator_type: Optional[Literal["user", "agent"]] = None
    creator_id: Optional[str] = None
    creator_name: Optional[str] = None
    creator_avatar: Optional[str] = None

    space_id: Optional[str] = None
    space_name: Optional[str] = None

    # message / im 共用：消息所属会话（im 这里填 conversation_id）
    session_id: Optional[str] = None
    session_title: Optional[str] = None

    # resource 专用
    resource_id: Optional[str] = None

    # 排序与时间
    score: float = 0.0
    rrf_score: float = 0.0
    created_at: Optional[str] = None

    # message 专用
    role: Optional[str] = None

    # 透传字段（前端可读：item_type、tags、source 等）
    metadata: dict[str, Any] = Field(default_factory=dict)


# ── 响应：整体 ────────────────────────────────────────────────
class SearchResponse(Schema):
    """统一搜索响应（PRD 4.6 + 3.12 降级数据契约）。

    `degraded` / `degraded_reason` / `partial_indices` 是 Wave 3 前端三级
    降级 UI 的必填数据，必须在所有路径（normal / fallback）正确填充。
    """

    results: list[SearchResultItem] = Field(default_factory=list)
    total: int = 0
    facets: dict[str, int] = Field(default_factory=dict, description="按类型计数：messages/resources/agents/...")
    suggestions: list[str] = Field(default_factory=list, description="ES suggest 拼写建议（空结果场景）")
    took_ms: int = 0
    search_mode: SearchModeResponse = "normal"
    degraded: bool = False
    degraded_reason: Optional[str] = Field(
        None,
        description=(
            "降级原因（封闭枚举）：\n"
            "  - engine_disabled: SEARCH_ENGINE_ENABLED=false\n"
            "  - health_red: ES 集群 unreachable / red\n"
            "  - circuit_open: pybreaker open（5 次连续失败）\n"
            "  - error_rate_breach: 1min 滑窗错误率 > 50%（PRD 4.8.B）\n"
            "  - opensearch_unavailable: ES 主路径异常被自动降级\n"
            "  - partial_failure: msearch 子查询单索引失败，partial_indices 列出受影响索引\n"
            "  - rate_limited: 降级模式下用户每分钟超 10 次\n"
            "  - auth_missing: 鉴权通过但 request.auth 为空\n"
            "  - internal_error: 主路径 + 降级路径都失败"
        ),
    )
    partial_indices: list[str] = Field(
        default_factory=list,
        description="本次响应未覆盖的索引：messages / im / ...",
    )
    # Wave 5 R2-15：fallback PG 路径里某个索引调用失败（swallow 返回空）时，
    # 把索引名追加到 partial_errors。前端可据此提示"资源搜索本次失败，请重试"，
    # 区别于 partial_indices（"本期不覆盖"语义）。空列表即"无错误"。
    partial_errors: list[str] = Field(
        default_factory=list,
        description="本次响应中调用失败的索引（fallback PG 路径专用）",
    )
    # Wave 5 R4-09：明确区分"无访问 Space"vs"真零结果"
    # 后端在 search_service / fallback_service / api 任意路径检测到"用户对当前
    # organization 完全无 Space 访问"时填 'no_accessible_spaces'，让 CLI / Web 能
    # 给用户友好提示而不是误读为"团队真没数据"。
    notice: Optional[str] = Field(
        None,
        description=(
            "状态附加说明（可选）。封闭枚举：\n"
            "  - no_accessible_spaces: 用户在该 Organization 内无任何 Space 访问权限"
        ),
    )

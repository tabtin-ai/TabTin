"""
tabtin.search — Function Call 工具：让 Agent 直接调用统一搜索引擎。

PRD 3.9.B Wave 4 落地：
    - Agent 通过此工具能搜消息 / 资源 / Agent / Space / 备忘录 / IM
    - 结果与用户在 Cmd+K 看到的完全一致：相同的权限边界、相同的 RRF 排序、
      相同的降级语义
    - 不走 HTTP 一跳：直接 import `apps.fts.services.search_service.search`
      和 `fallback_service.fallback_search`，省掉序列化往返开销

权限模型（关键）：
    - `user_id` / `organization_id` 由 ToolExecutor 在 LLM 调用前**自动从运行时上下文
      注入**（agent 持有人的 user_id + agent 所属 organization_id），等同于桌面端
      用户 JWT 解出的身份
    - **重要**：`tool_executor._inject_args` 用 `if param_name not in args`
      条件注入——若 LLM 在 args 里显式传 `organization_id`，**不会**被覆盖
    - 因此本工具用 `apps.services.common.thread_context.get_current_organization_id`
      作为**真权威**身份源；如果与 LLM 显式传值不一致 → 拒绝（PERMISSION_DENIED）
    - 如果 thread_context 未注入（不应发生于生产；可能在测试 / 子线程未传播
      ContextVar 等场景） → 一律拒绝（AUTH_MISSING），**不**降级使用 LLM 输入

降级处理（ADR-09）：
    - 调 `fallback_service.should_fallback()` 决策走 ES 还是 PG 兜底
    - 降级响应原样保留 `degraded=true` 与 `degraded_reason`，让 LLM 知道
      当前在降级模式（可能影响其判断"为什么搜不到 X"）

返回格式：
    JSON 字符串，含 results / total / facets / degraded / degraded_reason /
    suggestions / partial_indices / **notice**（Wave 4 Review 修复 B2 新增字段，
    用于明确"无访问 Space"vs"真零结果"）；results 限 10 条避免超 token
"""

from __future__ import annotations

import json
import logging
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool

# Wave 5：metrics + OTel trace（fts 内部 only，不污染 capabilities 其他工具）
try:
    from apps.fts.metrics import record_fc_invoke, search_timer
    from apps.fts.otel_trace import start_search_span
    _FTS_OBSERVABILITY_AVAILABLE = True
except ImportError:  # pragma: no cover - fts 模块缺失时降级
    _FTS_OBSERVABILITY_AVAILABLE = False
    record_fc_invoke = lambda **kwargs: None  # noqa: E731
    search_timer = None  # type: ignore[assignment]
    start_search_span = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


# 单工具响应硬上限（避免 LLM context window 被一次搜索吃掉）
SEARCH_TOOL_RESULTS_LIMIT = 10


class SearchToolInput(BaseModel):
    """tabtin.search 参数（与 PRD 4.6 SearchParams 1:1 对齐）。

    **故意省略字段**：
        - `mode`（fast/fallback_ok）：Agent 不应主动让自己降级；由
          `fallback_service.should_fallback()` 自动决策
    """

    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="用户 ID（自动注入，无需 LLM 传）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None,
        description=(
            "Organization ID。**Agent 不能跨 Organization 搜索**：若显式传值，"
            "必须等于当前 Agent 所属 Organization，否则被拒绝"
        ),
    )

    q: str = Field(
        min_length=1,
        max_length=512,
        description=(
            "搜索关键词。带双引号的 q（如 `\"Cannot read property\"`）走短语精确"
            "匹配；否则按关键词召回"
        ),
    )
    types: Optional[str] = Field(
        default=None,
        description=(
            "逗号分隔，限定搜索类型：`messages,resources,agents,spaces,memos,im`。"
            "不传则搜全部 6 类"
        ),
    )
    item_type: Optional[str] = Field(
        default=None,
        description="resources 子类过滤：tabdoc / tabdata / tabslide / tabcode 等",
    )
    space_id: Optional[str] = Field(
        default=None,
        description="收窄到指定 Space",
    )
    agent_id: Optional[str] = Field(
        default=None,
        description=(
            "按 Agent 筛。**P0 限制**：仅对 messages 和 agents 索引精准生效；"
            "对 resources / memos / im 索引，后端 mapping 尚未索引此字段，"
            "会按'不限制'处理"
        ),
    )
    creator_type: Optional[Literal["user", "agent", "any"]] = Field(
        default=None,
        description=(
            "user / agent / any（默认 any）。**P0 限制**同 agent_id："
            "仅 messages / agents 索引精准生效"
        ),
    )
    role: Optional[Literal["user", "assistant", "any"]] = Field(
        default=None,
        description="消息 role 过滤：user / assistant / any",
    )
    created_after: Optional[str] = Field(
        default=None,
        description="ISO datetime 下限（如 `2026-01-01T00:00:00Z`）",
    )
    created_before: Optional[str] = Field(
        default=None,
        description="ISO datetime 上限",
    )
    limit: int = Field(
        default=SEARCH_TOOL_RESULTS_LIMIT,
        ge=1,
        le=SEARCH_TOOL_RESULTS_LIMIT,
        description=f"单次返回条数上限（最多 {SEARCH_TOOL_RESULTS_LIMIT}，防止超 token）",
    )
    offset: int = Field(
        default=0,
        ge=0,
        le=10_000,
        description="分页偏移（如总命中 > limit，用 offset=10/20/... 翻页）",
    )


class SearchTool(BaseTool):
    name: str = "tabtin_search"
    description: str = (
        "搜索**当前** Organization 下的消息、资源、Agent、Space、备忘录、IM 内容。"
        "结果与用户 Cmd+K 完全一致（相同权限、相同排序、相同降级语义）。\n\n"
        "适用场景：\n"
        "- 用户问'我之前是不是讨论过 X'、'有没有相关文档' → 调 tabtin_search\n"
        "- Agent 自我回顾'我以前回答过类似问题吗' → 传 creator_type=\"agent\"\n"
        "- 在指定 Space 内搜 → 传 space_id 参数\n"
        "- 短语精确匹配 → q 用 \"...\" 双引号包裹（如 q='\"Cannot read property\"'）\n\n"
        "**重要约束**：\n"
        "- **不能跨 Organization 搜索**——若用户问'搜另一个团队的 X'，请告知用户先切换\n"
        "- **单次最多返回 10 条**——若 total > 10 需更多结果，请用 offset=10/20/...\n"
        "  分页（如 `tabtin_search(q='...', offset=10)`）\n"
        "- snippet 字段含 `<em>关键词</em>` HTML 高亮标签——向用户复述时请剥离\n"
        "  或转 markdown 加粗（如 `<em>性能</em>` → `**性能**`）\n"
        "- `degraded=true` 表示搜索引擎降级（结果可能仅来自 PG 兜底，不含消息搜索）；"
        "请告诉用户后再陈述结果，避免把降级误传为'真没相关内容'\n"
        "- `notice` 字段（如有）：明确说明特殊场景，请向用户复述，"
        "如 'no_accessible_spaces' = 该 Organization 内无任何可访问 Space\n\n"
        "返回 JSON：results / total / facets / degraded / suggestions / notice"
    )
    args_schema: type[SearchToolInput] = SearchToolInput
    execution_mode: str = "server"
    risk_level: str = "safe"
    cacheable: bool = False  # 搜索结果时效性强，不缓存
    timeout: int = 10
    category: str = "search"
    required_permissions: list[str] = []

    def run(
        self,
        q: str,
        types: Optional[str] = None,
        item_type: Optional[str] = None,
        space_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        creator_type: Optional[str] = None,
        role: Optional[str] = None,
        created_after: Optional[str] = None,
        created_before: Optional[str] = None,
        limit: int = SEARCH_TOOL_RESULTS_LIMIT,
        offset: int = 0,
        user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        **_kwargs: Any,
    ) -> str:
        # Wave 5 R4-04：FC 调用 metric（用 try/finally 模式确保哪个分支退出都打点）
        # `_meta` 收集结束时的 notice，由各 return 路径 set 后统一发指标
        _meta: dict = {"notice": "normal"}
        try:
            return self._do_run(
                q=q, types=types, item_type=item_type, space_id=space_id,
                agent_id=agent_id, creator_type=creator_type, role=role,
                created_after=created_after, created_before=created_before,
                limit=limit, offset=offset,
                user_id=user_id, organization_id=organization_id,
                _meta=_meta,
            )
        finally:
            try:
                record_fc_invoke(notice=_meta.get("notice"))
            except Exception:
                pass

    def _do_run(
        self,
        q: str,
        types: Optional[str],
        item_type: Optional[str],
        space_id: Optional[str],
        agent_id: Optional[str],
        creator_type: Optional[str],
        role: Optional[str],
        created_after: Optional[str],
        created_before: Optional[str],
        limit: int,
        offset: int,
        user_id: Optional[str],
        organization_id: Optional[str],
        _meta: dict,
    ) -> str:
        # ── 1. 校验：身份必须存在
        if not user_id:
            _meta["notice"] = "error"
            return _error_response(
                "AUTH_MISSING",
                "Agent 缺失 user_id（运行时上下文未正确注入）",
            )

        # ── 2. 校验：organization_id 必须从 thread_context 获取（强 fail-close 防御）
        # Wave 4 Review C1 修复：tool_executor._inject_args 用 `if not in args` 注入，
        # LLM 显式传 organization_id 时 InjectedState **不会覆盖**。因此 thread_context
        # 才是真权威，**不允许**用 LLM 输入兜底（兜底等于自废武功）
        try:
            from apps.services.common.thread_context import get_current_organization_id
        except ImportError:
            logger.error("[SearchTool] thread_context module unavailable; fail-close")
            _meta["notice"] = "error"
            return _error_response(
                "AUTH_MISSING",
                "运行时身份模块不可用，搜索拒绝（系统异常，请联系管理员）",
            )

        ctx_organization = (get_current_organization_id() or "").strip()
        if not ctx_organization:
            _meta["notice"] = "error"
            return _error_response(
                "AUTH_MISSING",
                "Agent 运行时未注入 organization_id（thread_context 为空）",
            )

        agent_organization = ctx_organization
        injected_organization = (organization_id or "").strip() or None

        # 越权防御：LLM 若显式传 organization_id 且与 thread_context 不一致 → 拒绝
        if injected_organization and injected_organization != agent_organization:
            logger.warning(
                "[SearchTool] cross-organization attempt detected: kwargs=%s ctx=%s",
                injected_organization, agent_organization,
            )
            _meta["notice"] = "error"
            return _error_response(
                "PERMISSION_DENIED",
                "Agent 不能跨 Organization 搜索（你只能搜你所属 Organization 的内容）",
            )

        # ── 3. 校验：q 不能空（防御性，pydantic 已校验 min_length=1）
        q = (q or "").strip()
        if not q:
            _meta["notice"] = "error"
            return _error_response("VALIDATION_ERROR", "q 不能为空")

        # ── 4. 构造 SearchParams（用 fts.schemas，1:1 对齐 HTTP API）
        try:
            from apps.fts.schemas import SearchParams
            params = SearchParams(
                q=q,
                organization_id=agent_organization,
                types=types,
                item_type=item_type,
                space_id=space_id,
                agent_id=agent_id,
                creator_type=creator_type,  # type: ignore[arg-type]
                role=role,  # type: ignore[arg-type]
                created_after=created_after,
                created_before=created_before,
                limit=min(int(limit), SEARCH_TOOL_RESULTS_LIMIT),
                offset=int(offset),
                mode="fast",
            )
        except Exception as exc:
            # pydantic ValidationError 详情过长，保留 1 行核心错误
            err_msg = str(exc).split("\n", 1)[0][:200]
            _meta["notice"] = "error"
            return _error_response("VALIDATION_ERROR", f"参数校验失败: {err_msg}")

        # ── 5. Wave 4 Review B2 修复：预 call acl_service 判"无访问 Space"
        # 与"真零结果"做明确区分，避免 LLM 把"权限错配"误读为"用户没数据"
        try:
            from apps.fts.services import acl_service
            accessible = acl_service.get_user_accessible_spaces(user_id, agent_organization)
            if not accessible.has_any_access():
                logger.info(
                    "[SearchTool] no_accessible_spaces user=%s organization=%s",
                    user_id, agent_organization,
                )
                _meta["notice"] = "no_accessible_spaces"
                return _no_access_response(agent_organization, params.types)
        except Exception:  # pragma: no cover - acl 失败不阻塞主路径
            logger.warning("[SearchTool] pre-check acl failed; continue to search")

        # Wave 5：FC 入口的 root span（OTel）+ 整段计时（Prometheus）
        # 注意：search_timer / start_search_span 在 try-import 缺失时是 None；
        # 用 contextlib.nullcontext 兜底，避免 with None 报错
        from contextlib import nullcontext as _nc
        timer_ctx = search_timer(path="fc") if search_timer else _nc({"degraded": False})
        span_ctx = start_search_span(
            user_id=user_id, organization_id=agent_organization, path="fc",
            query_length=len(q), types=params.types or "",
        ) if start_search_span else _nc(None)

        try:
            with timer_ctx as tmeta, span_ctx as _span:
                # ── 6. 走 fallback_service.should_fallback() 决策
                try:
                    from apps.fts.services import fallback_service, search_service

                    decision = fallback_service.should_fallback()
                    if decision.fallback:
                        if isinstance(tmeta, dict):
                            tmeta["degraded"] = True
                        response = fallback_service.fallback_search(
                            params,
                            user_id=user_id,
                            reason=decision.reason or "engine_unavailable",
                        )
                    else:
                        try:
                            response = search_service.search(params, user_id=user_id)
                            if getattr(response, "degraded", False) and isinstance(tmeta, dict):
                                tmeta["degraded"] = True
                        except Exception as exc:
                            logger.warning("[SearchTool] primary search failed; fallback once: %s", exc)
                            if isinstance(tmeta, dict):
                                tmeta["degraded"] = True
                            response = fallback_service.fallback_search(
                                params,
                                user_id=user_id,
                                reason="opensearch_unavailable",
                            )
                except Exception as exc:
                    logger.exception("[SearchTool] all paths failed")
                    _meta["notice"] = "error"
                    return _error_response(
                        "INTERNAL_ERROR",
                        f"搜索服务异常: {exc}",
                    )
        except Exception as exc:  # pragma: no cover
            # ctx manager 自身异常（极少）
            logger.exception("[SearchTool] observability context failed")
            _meta["notice"] = "error"
            return _error_response("INTERNAL_ERROR", f"搜索服务异常: {exc}")

        # ── 7. 序列化（结果限 10 条；保留所有元信息字段）
        try:
            payload = response.model_dump(mode="json")
        except AttributeError:
            payload = response.dict()

        # 二次截断（防御性：fallback / partial_failure 路径偶尔会超）
        results = payload.get("results") or []
        if len(results) > SEARCH_TOOL_RESULTS_LIMIT:
            payload["results"] = results[:SEARCH_TOOL_RESULTS_LIMIT]

        # Wave 5：搜索响应携带 notice → 同步到 metric label（区分权限错配）
        notice_value = payload.get("notice")
        if notice_value:
            _meta["notice"] = str(notice_value)

        return json.dumps(payload, ensure_ascii=False)


def _error_response(code: str, message: str) -> str:
    """统一错误返回格式（与 BaseTool error 契约对齐）。"""
    return json.dumps(
        {"success": False, "error": message, "error_code": code},
        ensure_ascii=False,
    )


def _no_access_response(organization_id: str, types: Optional[str]) -> str:
    """Wave 4 Review B2：明确区分"无访问 Space" vs "真零结果"。

    以合法 SearchResponse 形态返回（results=[] + facets 全 0 + 新 notice 字段），
    让 LLM 能基于 notice 给用户讲清楚"我没有该 Organization 的访问权"。
    """
    type_list = [t.strip() for t in (types or "").split(",") if t.strip()]
    if not type_list:
        type_list = ["messages", "resources", "agents", "spaces", "memos", "im"]
    facets = {t: 0 for t in type_list}
    return json.dumps(
        {
            "results": [],
            "total": 0,
            "facets": facets,
            "suggestions": [],
            "took_ms": 0,
            "search_mode": "normal",
            "degraded": False,
            "degraded_reason": None,
            "partial_indices": [],
            "notice": "no_accessible_spaces",
            "notice_message": (
                f"该 Organization（{organization_id}）下没有任何对当前 Agent 可访问的 Space。"
                "请向用户说明：搜索范围内无授权数据，可能需要先加入相关 Space 或确认登录身份。"
            ),
        },
        ensure_ascii=False,
    )


__all__ = ["SearchTool", "SearchToolInput", "SEARCH_TOOL_RESULTS_LIMIT"]

"""GET /api/search 统一搜索端点（PRD 4.6）。

职责：
    - 用 JWTAuth 认证（复用 apps.users.auth.permissions.JWTAuth）
    - Query 参数解析为 SearchParams（ninja 自动绑定）
    - 走 fallback_service.should_fallback()：决定走 ES 还是降级
    - 异常兜底：所有未预期异常归 degraded=True / degraded_reason='internal_error'，
      **绝不 raise 500**（PRD 4.8 + ADR-12）

可访问性：
    - 路由器在 `tabtin/urls.py` 末尾通过 `_safe_add_router('/search', router)`
      挂载到 `/api/search`（Wave 2 启动时验证）
    - flag `SEARCH_ENGINE_ENABLED=false` 时本端点仍可调用，会走 fallback
      路径（degraded=True, reason='engine_disabled'），保证前端 Wave 3 在
      ES 没起来时也能拿到合理响应（仅 PG 资源/备忘录）
"""

from __future__ import annotations

import logging

from ninja import Query, Router, Schema

from apps.users.auth.permissions import JWTAuth
from apps.fts.metrics import record_degrade, search_timer
from apps.fts.otel_trace import start_search_span
from apps.fts.schemas import SearchParams, SearchResponse
from apps.fts.services import fallback_service, search_service
from apps.fts.services import analytics_service

logger = logging.getLogger(__name__)

router = Router()
jwt_auth = JWTAuth()


@router.get("", auth=jwt_auth, response=SearchResponse, tags=["Unified Search"])
def unified_search(request, params: Query[SearchParams]):
    """统一搜索：6 索引 RRF 融合 + ACL + 降级。

    返回 SearchResponse；任何异常都转成 degraded 响应不抛 500。

    Wave 5 接入：
        - Prometheus search_timer（path=web）
        - OpenTelemetry root span（user_id / organization_id 作为属性）
        - SearchAnalytics 异步落库（on_commit / 失败 swallow）
    """
    user = request.auth
    user_id = str(getattr(user, "id", "")) if user else ""

    request_id = getattr(request, "request_id", None) or request.META.get("HTTP_X_REQUEST_ID", "")

    if not user_id:
        # JWTAuth 通过但 request.auth 为空（理论不应发生）；按降级返回
        record_degrade("auth_missing")
        return SearchResponse(
            results=[], total=0, facets={}, took_ms=0,
            search_mode="fallback", degraded=True,
            degraded_reason="auth_missing",
            partial_indices=list(fallback_service.PARTIAL_INDICES_DEGRADED),
        )

    with search_timer(path="web") as meta, start_search_span(
        user_id=user_id, organization_id=str(params.organization_id),
        request_id=str(request_id), path="web",
    ):
        response = _run_search(params, user_id, meta)

    # SearchAnalytics 异步落库（PRD 6.4）；失败 swallow 保 API 不挂
    try:
        analytics_service.record_search_event(
            user_id=user_id,
            organization_id=str(params.organization_id),
            query=params.q,
            types=params.types or "",
            response=response,
        )
    except Exception:  # pragma: no cover
        logger.warning("[FTS][api] analytics record swallow", exc_info=True)

    return response


def _run_search(params: SearchParams, user_id: str, meta: dict) -> SearchResponse:
    """主搜索流程：决策 fallback → ES → 兜底 → 兜底"""
    # 决策：是否直接走降级
    decision = fallback_service.should_fallback()

    if decision.fallback:
        meta["degraded"] = True
        try:
            return fallback_service.fallback_search(
                params, user_id=user_id, reason=decision.reason or "engine_unavailable",
            )
        except Exception:  # pragma: no cover
            logger.exception("[FTS][api] fallback search threw")
            return _internal_error_response(params)

    try:
        resp = search_service.search(params, user_id=user_id)
        if resp.degraded:
            meta["degraded"] = True
        return resp
    except Exception as exc:
        # ES 调用失败（CircuitBreakerError / ConnectionError）→ 降级一次
        meta["degraded"] = True
        logger.warning("[FTS][api] primary search failed; trying fallback once: %s", exc)
        try:
            return fallback_service.fallback_search(
                params, user_id=user_id, reason="opensearch_unavailable",
            )
        except Exception:  # pragma: no cover
            logger.exception("[FTS][api] fallback after primary failure also threw")
            return _internal_error_response(params)


def _internal_error_response(params: SearchParams) -> SearchResponse:
    """内部错误兜底：永远返回合法 SearchResponse，degraded_reason='internal_error'。"""
    record_degrade("internal_error")
    return SearchResponse(
        results=[],
        total=0,
        facets={},
        suggestions=[],
        took_ms=0,
        search_mode="fallback",
        degraded=True,
        degraded_reason="internal_error",
        partial_indices=list(fallback_service.PARTIAL_INDICES_DEGRADED),
    )


# ── Wave 5：搜索结果点击埋点（PRD 6.4 SearchAnalytics） ────────
class SearchClickLogIn(Schema):
    """前端在用户点击搜索结果时上报。"""
    organization_id: str
    query: str
    clicked_result_id: str
    clicked_result_type: str
    clicked_position: int


@router.post("/click_log", auth=jwt_auth, tags=["Unified Search"])
def click_log(request, payload: SearchClickLogIn):
    """记录用户点击搜索结果（用于后续 CTR 分析、零结果改进等）。

    简化策略：找最近 5min 内同 user + organization + query 的最新一条 SearchAnalytics，
    更新 clicked_* 字段。找不到则忽略（用户在历史搜索界面点击的场景，无关联）。
    返回 `{"ok": true}` 即可。
    """
    user = request.auth
    user_id = str(getattr(user, "id", "")) if user else ""
    if not user_id:
        return {"ok": False, "error": "auth_missing"}
    try:
        analytics_service.record_click(
            user_id=user_id,
            organization_id=str(payload.organization_id),
            query=payload.query,
            clicked_result_id=payload.clicked_result_id,
            clicked_result_type=payload.clicked_result_type,
            clicked_position=payload.clicked_position,
        )
    except Exception:  # pragma: no cover
        logger.warning("[FTS][api] click_log record swallow", exc_info=True)
    return {"ok": True}

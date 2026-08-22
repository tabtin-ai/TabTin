"""降级路径（PRD 4.8 + ADR-09）。

设计原则（不许越位）：
    - **绝不调 MySQL FULLTEXT**（PRD 4.8.C 明令）：那是 Level 3 降级，
      Wave 5 才接；现在 ES 不可用时只走 PG 的 ContextItemService /
      MemoService，避免 ChatMessage 雪崩
    - 所有降级响应都带 `degraded=True` 和明确的 `degraded_reason`，前端
      据此显示 PRD 3.12 三级反馈
    - rate limit `fts:fallback_rl:{user_id}` 每分钟 10 次；超额仍返回
      合法 SearchResponse（degraded_reason='rate_limited'），不抛 429

ramp-up 决策（已选简化版）：
    - PRD 4.8.C 完整方案：half-open → 1% → 10% → 100% 渐进采样
    - Wave 2 选简化：依赖 pybreaker 内置 half-open 状态
      （`reset_timeout` 后单次试探，成功即关闭，失败再次 open）
    - 理由：Redis 共享 breaker 已经避免了多 worker "雪崩涌入"；
      复杂的随机采样 ramp-up 在 Wave 2 测试覆盖不足时反而引入 bug
    - **后续可演进**：Wave 5 加 metric 看 half-open → close 失败率
      若高于 20% 再补完整 ramp-up

降级触发判定（多源决策）：
    1. SEARCH_ENGINE_ENABLED=false   → engine_disabled
    2. Redis fts:health = unreachable / red → health_red
    3. Breaker.current_state = 'open' → circuit_open
    4. 1min 滑窗错误率 > 阈值 → error_rate_breach
    5. ES msearch 抛 CircuitBreakerError / ConnectionError → opensearch_unavailable

R1-05 落地：health_probe_task（Wave 1 已交付）每 10s 写 Redis
`fts:health` (TTL 30s)；本服务在每次请求前直接读取，避免每次都打超时
的 ES 实例（见 PRD 4.8.D）。
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from django.conf import settings

from apps.fts.client import get_breaker, is_engine_enabled
from apps.fts.metrics import record_degrade, record_zero_result
from apps.fts.schemas import SearchParams, SearchResponse, SearchResultItem

logger = logging.getLogger(__name__)

__all__ = [
    "FallbackDecision",
    "should_fallback",
    "fallback_search",
    "RATE_LIMIT_KEY_PREFIX",
    "RATE_LIMIT_PER_MIN",
    "PARTIAL_INDICES_DEGRADED",
]

# 降级路径下不返回的索引（PRD 4.8.C 明令"messages 完全跳过"，
# IM 同源 PG 但暂不接，简化）
PARTIAL_INDICES_DEGRADED: list[str] = ["messages", "im", "agents", "spaces"]

RATE_LIMIT_KEY_PREFIX = "fts:fallback_rl:"
RATE_LIMIT_PER_MIN = 10


# ── 降级决策 ───────────────────────────────────────────────────
@dataclass
class FallbackDecision:
    fallback: bool
    reason: Optional[str] = None  # engine_disabled / health_red / circuit_open / error_rate_breach
    health_value: Optional[str] = None


def should_fallback() -> FallbackDecision:
    """检查是否应该走降级路径。

    顺序：flag → fts:health → breaker → 错误率（client._error_rate_check）。
    """
    if not is_engine_enabled():
        return FallbackDecision(fallback=True, reason="engine_disabled")

    health = _read_health_redis()
    if health in {"unreachable", "red"}:
        return FallbackDecision(fallback=True, reason="health_red", health_value=health)

    try:
        breaker = get_breaker()
        state = getattr(breaker, "current_state", None)
        # pybreaker open 状态字符串
        if state == "open":
            return FallbackDecision(fallback=True, reason="circuit_open")
    except Exception:  # pragma: no cover - breaker 异常本身就是问题
        logger.warning("[FTS][fallback] breaker introspection failed", exc_info=True)
        return FallbackDecision(fallback=True, reason="circuit_open")

    # 1min 滑窗错误率（R0-04）；client.should_open_circuit 只读
    try:
        from apps.fts.client import should_open_circuit
        if should_open_circuit():
            return FallbackDecision(fallback=True, reason="error_rate_breach")
    except Exception:  # pragma: no cover
        pass

    return FallbackDecision(fallback=False)


def _read_health_redis() -> str | None:
    """读 Redis fts:health（health_probe_task 写入；TTL 30s）。"""
    try:
        from django_redis import get_redis_connection
        conn = get_redis_connection("default")
        v = conn.get("fts:health")
        if v is None:
            # key 不存在意味着 probe 还没跑（或 Redis 抖动）；不做激进决策
            return None
        if isinstance(v, (bytes, bytearray)):
            return v.decode()
        return str(v)
    except Exception:  # pragma: no cover
        return None


# ── Rate Limiter（Redis INCR） ────────────────────────────────
def _check_rate_limit(user_id: str) -> bool:
    """每分钟桶 INCR；返回 True 表示允许通过。"""
    if not user_id:
        return True
    minute_bucket = int(time.time() // 60)
    key = f"{RATE_LIMIT_KEY_PREFIX}{user_id}:{minute_bucket}"
    try:
        from django_redis import get_redis_connection
        conn = get_redis_connection("default")
        cnt = int(conn.incr(key) or 0)
        # 第一次 INCR 后立即设置 TTL 70s（覆盖跨分钟边界场景）
        if cnt == 1:
            conn.expire(key, 70)
        return cnt <= RATE_LIMIT_PER_MIN
    except Exception:  # pragma: no cover
        # Redis 失败时不卡住降级（保守开放）
        return True


# ── 降级搜索主入口 ────────────────────────────────────────────
def fallback_search(params: SearchParams, user_id: str, *, reason: str) -> SearchResponse:
    """走 PG 的降级搜索。

    覆盖策略：
        - resources：调 `ContextItemService.organization_search`
        - memos：调 `MemoService.list_memos(search=...)`
        - 其他类型（messages / agents / spaces / im）：本期不返回，标
          `partial_indices`

    rate limit 超额：返回 0 结果 + degraded_reason='rate_limited'。

    Wave 5 R4-09 BLOCKER 修复（产品 Review B1）：
        fallback 路径同样要做 ACL 预查并填 notice='no_accessible_spaces'，
        否则 ES 降级 + 用户无权限场景下用户被双重误导（"以为搜索功能本身坏了"）。
        这层短路在 rate_limit 检查后立刻执行（rate_limited 优先级最高保留）。
    """
    started = time.monotonic()

    # Wave 5：所有降级路径计数（reason 已经是封闭枚举）
    record_degrade(reason)

    # 1) rate limit
    if not _check_rate_limit(user_id):
        # rate_limited 优先级最高（即便上层传了别的 reason，rate_limited 后期更准确）
        record_degrade("rate_limited")
        # rate_limited 也填全 facets 0（前端 6 类 Tab 计数一致性）
        rl_requested = _parse_types(params.types)
        return SearchResponse(
            results=[],
            total=0,
            facets={t: 0 for t in rl_requested},
            took_ms=int((time.monotonic() - started) * 1000),
            search_mode="fallback",
            degraded=True,
            degraded_reason="rate_limited",
            partial_indices=[t for t in rl_requested if t not in {"resources", "memos"}],
        )

    # 2) Wave 5 R4-09 修复：fallback 路径同样要做 ACL 预查
    # 区分"用户无 Space 访问权限"vs"真零结果"，避免 fallback 时把"权限错配"
    # 误读为"搜索功能本身坏了"
    requested = _parse_types(params.types)
    try:
        from apps.fts.services import acl_service
        accessible = acl_service.get_user_accessible_spaces(user_id, params.organization_id)
    except Exception:  # pragma: no cover - acl 失败不阻塞降级主路径
        logger.warning("[FTS][fallback] acl pre-check failed; continue without notice", exc_info=True)
        accessible = None

    if accessible is not None and not accessible.has_any_access():
        logger.info(
            "[FTS][fallback] no_accessible_spaces user=%s organization=%s reason=%s",
            user_id, params.organization_id, reason,
        )
        return SearchResponse(
            results=[],
            total=0,
            facets={t: 0 for t in requested},
            took_ms=int((time.monotonic() - started) * 1000),
            search_mode="fallback",
            degraded=True,
            degraded_reason=reason,
            partial_indices=[t for t in requested if t not in {"resources", "memos"}],
            notice="no_accessible_spaces",
        )

    # 3) 解析目标 types（Wave 2 Review 修复：facets 全 6 类齐全，缺失类型填 0）
    types = [t for t in requested if t in {"resources", "memos"}]
    skipped = [t for t in requested if t not in {"resources", "memos"}]

    items: list[SearchResultItem] = []
    # 先把所有 requested types 填 0（PRD 3.12 Level 2 前端可对齐 Tab 计数）
    facets: dict[str, int] = {t: 0 for t in requested}
    # Wave 5 R2-15：哪些索引在 PG 路径上失败（区别于 partial_indices=未覆盖）
    pg_errors: list[str] = []

    # 4) resources（PG）
    if "resources" in types:
        rs_items, rs_total, rs_err = _pg_search_resources(params, user_id)
        facets["resources"] = rs_total
        items.extend(rs_items)
        if rs_err:
            pg_errors.append("resources")

    # 5) memos（PG）
    if "memos" in types:
        m_items, m_total, m_err = _pg_search_memos(params, user_id)
        facets["memos"] = m_total
        items.extend(m_items)
        if m_err:
            pg_errors.append("memos")

    # 6) 截断（先按各自 score 排序）
    items.sort(key=lambda x: -x.score)
    limit = max(int(params.limit), 1)
    offset = max(int(params.offset), 0)
    items = items[offset: offset + limit]

    if sum(facets.values()) == 0:
        record_zero_result()

    return SearchResponse(
        results=items,
        total=sum(facets.values()),
        facets=facets,
        suggestions=[],
        took_ms=int((time.monotonic() - started) * 1000),
        search_mode="fallback",
        degraded=True,
        degraded_reason=reason,
        partial_indices=skipped,
        partial_errors=pg_errors,
    )


def _parse_types(raw: str | None) -> list[str]:
    if not raw:
        return ["messages", "resources", "agents", "spaces", "memos", "im"]
    return [t.strip() for t in raw.split(",") if t.strip()]


# ── PG resources 降级 ─────────────────────────────────────────
def _pg_search_resources(
    params: SearchParams, user_id: str,
) -> tuple[list[SearchResultItem], int, bool]:
    """复用 ContextItemService.organization_search；构造一个临时的 user 上下文。

    Wave 5 R2-15：返回三元组 `(items, total, error)`：
        - error=False：成功（含真零结果）
        - error=True：内部失败（如 PG 不可达）；上层据此填 partial_errors
    """
    try:
        from apps.tabtinspace.services.context_item_service import ContextItemService
        from django.contrib.auth import get_user_model
        User = get_user_model()
        user = User.objects.filter(id=user_id).first() if user_id else None
        if user is None:
            return [], 0, False  # 用户不存在不算"PG 失败"
        from uuid import UUID
        try:
            wt_uuid = UUID(str(params.organization_id))
        except Exception:
            return [], 0, False  # 入参非法不算"PG 失败"
        svc = ContextItemService(user=user)
        page = max(1, int(params.offset // max(int(params.limit), 1)) + 1)
        results, total = svc.organization_search(
            organization_id=wt_uuid,
            query=_strip_phrase(params.q),
            item_type=params.item_type or None,
            page=page,
            page_size=max(int(params.limit), 1),
        )
        items: list[SearchResultItem] = []
        for r in results:
            items.append(SearchResultItem(
                id=str(r.id),
                type="resource",
                title=r.title or "",
                snippet=(r.preview or "")[:200],
                highlight={},
                creator_type="user",
                creator_id=str(r.created_by_id) if r.created_by_id else None,
                space_id=str(r.workspace_id or r.project_id) if (r.workspace_id or r.project_id) else None,
                space_name=getattr(r.workspace or r.project, "name", None),
                resource_id=r.resource_id or None,
                score=float(getattr(r, "rank", 0) or 0),
                rrf_score=0.0,
                created_at=r.created_at.isoformat() if r.created_at else None,
                metadata={"item_type": r.item_type, "is_archived": bool(r.is_archived)},
            ))
        return items, total, False
    except Exception:
        logger.warning("[FTS][fallback] PG resources search failed", exc_info=True)
        return [], 0, True


def _pg_search_memos(
    params: SearchParams, user_id: str,
) -> tuple[list[SearchResultItem], int, bool]:
    """复用 MemoService.list_memos(search=...)。

    Wave 5 R2-15：返回三元组 `(items, total, error)`，error=True 表示 PG 调用失败。
    """
    try:
        from apps.tabmemo.services.memo_service import MemoService
        from django.contrib.auth import get_user_model
        User = get_user_model()
        user = User.objects.filter(id=user_id).first() if user_id else None
        if user is None:
            return [], 0, False
        svc = MemoService(user=user)
        out = svc.list_memos(
            organization_id=str(params.organization_id),
            space_id=params.space_id or None,
            search=_strip_phrase(params.q),
            limit=max(int(params.limit), 1),
        )
        memos = out.get("memos") or out.get("items") or []
        total = int(out.get("total") or len(memos))
        items: list[SearchResultItem] = []
        for m in memos:
            content = getattr(m, "content_plaintext", "") or ""
            first_line = content.split("\n", 1)[0]
            items.append(SearchResultItem(
                id=str(m.id),
                type="memo",
                title=first_line[:80],
                snippet=content[:200],
                highlight={},
                creator_type="agent" if (getattr(m, "source", "") or "") == "agent" else "user",
                creator_id=str(m.owner_id) if getattr(m, "owner_id", None) else None,
                space_id=str(m.space_id) if getattr(m, "space_id", None) else None,
                score=0.0,
                rrf_score=0.0,
                created_at=m.created_at.isoformat() if m.created_at else None,
                metadata={
                    "memo_type": getattr(m, "memo_type", ""),
                    "source": getattr(m, "source", ""),
                    "tags": list(getattr(m, "tags", None) or []),
                    "is_pinned": bool(getattr(m, "is_pinned", False)),
                },
            ))
        return items, total, False
    except Exception:
        logger.warning("[FTS][fallback] PG memos search failed", exc_info=True)
        return [], 0, True


def _strip_phrase(q: str) -> str:
    """降级路径不做短语精确，去掉首尾引号交给 PG SearchQuery / icontains。"""
    if not q:
        return ""
    qs = q.strip()
    if len(qs) >= 2 and qs.startswith('"') and qs.endswith('"'):
        return qs[1:-1].strip()
    return qs

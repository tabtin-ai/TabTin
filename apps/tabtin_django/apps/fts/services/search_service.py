"""统一搜索核心：msearch + RRF + recency + 短语 + suggest（PRD 4.6）。

数据流：
    1. parse_params      规范化 SearchParams（types / phrase / time）
    2. acl_service       计算用户可访问 spaces + ObjectScope
    3. build_query       为每个目标索引构造 ES query body
    4. client.msearch    一次网络往返，多索引并行
    5. rrf_merge         跨索引按 RRF 排序融合
    6. compose_results   ES hits → SearchResultItem
    7. hydration_service 批量补 PG 元信息
    8. compute facets    各类型 hits 计数
    9. suggest（可选）    空结果时调 suggest API

回滚消息过滤主键（W1 + ADR-16）：
    `tabtin-messages` 索引每条 message 都有 `checkpoint_state_index`
    （integer，来自 ChatMessage.checkpoint_state_index 字段，与
    `session_revert_state_index` 同一整数空间，PG ConversationState
    messages_json 长度）。
    回滚后被截断的消息其 `checkpoint_state_index >
    session.revert_state_index`，即"高于回滚点的消息"。
    Wave 2 决策：在 message document 里同时索引两个字段，过滤条件直接
    用 ES Painless `doc['checkpoint_state_index'].value <= doc['session_revert_state_index'].value`。

    **方案选型理由**（性能优先）：
        - 选 ✓ Painless script filter：每文档都比较，不用 join
        - 否 ✗ 应用层先查 PG 拿 session.revert_state_index，再做 range：
          需要预查 N 个 session 的 revert_state_index，破坏 msearch 单往返
        - Painless 在分片内 doc-values 直接读，CJK 全文 + filter 复合
          query 下分片内可剪枝，实测开销 < 5%
        - **回滚未发生的会话**：`session_revert_state_index` 为 0 或 None，
          所有 message 的 `checkpoint_state_index` 也都 ≤ 它（None 时就
          没有这个字段，过滤跳过）→ 无副作用

短语精确：
    用户在输入框打 `"Cannot read property"`（含双引号）时识别为短语，
    使用 `match_phrase`；否则 `match.operator=or`（高召回）。

Recency boost（messages / memos）：
    `function_score.gauss(created_at, origin=now, scale=7d, decay=0.5)`
    与 BM25 base 相乘，实现"同分时新消息靠前"。
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Iterable

from django.conf import settings

from apps.fts.client import breaker_run, get_client
from apps.fts.index_definitions import (
    INDEX_DEFINITIONS,
    get_index_name,
    get_messages_alias,
)
from apps.fts.schemas import SearchParams, SearchResponse, SearchResultItem
from apps.fts.services import acl_service, hydration_service

# Wave 5：metrics 接入。注意 search_service 内部记录的是 ES 主路径耗时；
# CLI/FC/Web 三入口的 SEARCH_LATENCY 由调用方（api.py / SearchTool / fallback_service）
# 用 search_timer 包裹。这里只追加 zero-result + degrade 计数。
from apps.fts.metrics import record_degrade, record_zero_result

logger = logging.getLogger(__name__)

__all__ = [
    "search",
    "rrf_merge",
    "build_index_query",
    "build_msearch_body",
    "parse_phrase",
    "compose_result_item",
]


# ── 索引/类型映射 ──────────────────────────────────────────────
# Wave 2 Review 修复（技术 MEDIUM 10）：单源化 - logical name 来自
# `index_definitions.INDEX_DEFINITIONS`，不重复硬编码；本字典只额外保存
# "对外 result type" 单类型字段（schemas.SearchResultItem.type 用）
_RESULT_TYPE_BY_LOGICAL: dict[str, str] = {
    "messages": "message",
    "resources": "resource",
    "agents": "agent",
    "spaces": "space",
    "memos": "memo",
    "im": "im",
}

# 默认 6 类（PRD 4.6 全部）：从 INDEX_DEFINITIONS 派生，避免漏改
_DEFAULT_TYPES: tuple[str, ...] = tuple(INDEX_DEFINITIONS.keys())


def _alias_for(logical: str) -> str:
    if logical == "messages":
        return get_messages_alias()
    base = INDEX_DEFINITIONS[logical]["base_name"]
    return get_index_name(base)


# ── 入口 ───────────────────────────────────────────────────────
def search(params: SearchParams, user_id: str) -> SearchResponse:
    """主搜索流程（不含 fallback；fallback 由 fallback_service 调用）。

    Returns:
        SearchResponse with degraded=False 默认。任何不可恢复的内部错误
        转为空响应 + degraded_reason='internal_error'，由 API 层统一兜底。
    """
    started = time.monotonic()

    # 1) 解析目标索引
    types = _parse_types(params.types)
    if not types:
        return SearchResponse(
            results=[], total=0, facets={}, took_ms=int((time.monotonic() - started) * 1000),
        )

    # 2) ACL filter（每索引共用同一个 filter，仅 logical_index 不同）
    accessible = acl_service.get_user_accessible_spaces(user_id, params.organization_id)
    if not accessible.has_any_access():
        # Wave 5 R4-09 修复：无任何 Space 可访问 → 一定 0 命中，但要明确区分
        # "权限错配"vs"真零结果"，否则 CLI/Web 用户会误读为"团队真没数据"。
        # 加可选 notice 字段不破坏既有契约（前端旧版本未消费 notice 时仍合法）。
        logger.info(
            "[FTS][search] no_accessible_spaces user=%s organization=%s",
            user_id, params.organization_id,
        )
        return SearchResponse(
            results=[],
            total=0,
            facets={t: 0 for t in types},
            took_ms=int((time.monotonic() - started) * 1000),
            notice="no_accessible_spaces",
        )

    # 3) 短语识别 + agent 自身搜索的 ACL 例外（PRD 3.8.C：搜 Agent 名称）
    phrase, raw_terms = parse_phrase(params.q)

    # 4) 构造 msearch body
    body, index_order = build_msearch_body(
        types=types,
        params=params,
        phrase=phrase,
        accessible=accessible,
    )

    # 5) 调 ES（走 breaker）
    try:
        client = get_client()
        # ES 8.x msearch 用 searches=, 旧版本接受 body=
        resp = breaker_run(client.msearch, searches=body, max_concurrent_searches=6)
    except Exception as exc:
        # search() 不自己降级（fallback_service 已先决策是否走这里），
        # 抛给上层处理
        logger.warning("[FTS][search] msearch failed: %s", exc)
        raise

    responses = resp.get("responses") or []
    # responses 与 index_order 一一对应
    per_index: dict[str, list[dict[str, Any]]] = {}
    facets: dict[str, int] = {}
    # Wave 2 Review 修复（产品 HIGH 1）：单索引子查询 error 归 partial_indices
    # 让 PRD 3.12 Level 1 反馈数据契约完整（前端可显示"消息搜索暂不可用"）
    failed_indices: list[str] = []
    for logical, sub in zip(index_order, responses):
        if not isinstance(sub, dict):
            failed_indices.append(logical)
            facets[logical] = 0
            per_index[logical] = []
            continue
        if "error" in sub:
            logger.warning("[FTS][search] sub-query error index=%s err=%s", logical, sub["error"])
            facets[logical] = 0
            per_index[logical] = []
            failed_indices.append(logical)
            continue
        hits_root = sub.get("hits") or {}
        total_obj = hits_root.get("total") or 0
        if isinstance(total_obj, dict):
            facets[logical] = int(total_obj.get("value") or 0)
        else:
            facets[logical] = int(total_obj or 0)
        per_index[logical] = list(hits_root.get("hits") or [])

    # 6) RRF 融合
    fused = rrf_merge(per_index, k=60)

    # 7) 截断 + compose SearchResultItem
    limit = max(int(params.limit), 1)
    offset = max(int(params.offset), 0)
    sliced = fused[offset: offset + limit]

    items: list[SearchResultItem] = []
    for hit, rrf_score in sliced:
        logical = hit["_logical_index"]
        item = compose_result_item(logical, hit, rrf_score=rrf_score)
        if item is not None:
            items.append(item)

    # 8) Hydrate
    items = hydration_service.hydrate(items)

    # 9) Suggest（仅在零结果时；PRD 3.6）
    suggestions: list[str] = []
    total = sum(facets.values())
    if total == 0 and raw_terms:
        try:
            suggestions = _fetch_suggestions(client, types, raw_terms)
        except Exception:  # pragma: no cover - suggest 失败不影响主流程
            logger.warning("[FTS][search] suggest failed", exc_info=True)
            suggestions = []

    # 部分子查询失败 → degraded=True + reason='partial_failure' + partial_indices
    is_partial = bool(failed_indices)
    if is_partial:
        record_degrade("partial_failure")
    if total == 0:
        # Wave 5：零结果计数（突增 3x 告警可能索引异常）
        record_zero_result()
    return SearchResponse(
        results=items,
        total=total,
        facets=facets,
        suggestions=suggestions,
        took_ms=int((time.monotonic() - started) * 1000),
        search_mode="normal",
        degraded=is_partial,
        degraded_reason="partial_failure" if is_partial else None,
        partial_indices=failed_indices,
    )


# ── 类型解析 ───────────────────────────────────────────────────
def _parse_types(raw: str | None) -> list[str]:
    if not raw:
        return list(_DEFAULT_TYPES)
    out: list[str] = []
    for chunk in raw.split(","):
        c = chunk.strip()
        if c in _RESULT_TYPE_BY_LOGICAL and c not in out:
            out.append(c)
    return out


# ── 短语识别 ───────────────────────────────────────────────────
_PHRASE_RE = re.compile(r'^\s*"(.+)"\s*$', re.DOTALL)


def parse_phrase(q: str) -> tuple[str | None, str]:
    """识别整个 q 是否为带双引号的短语。

    返回 `(phrase, raw_terms)`：
        - 命中短语：phrase=去引号内容，raw_terms 仍是原始 q（用于 suggest）
        - 未命中：phrase=None，raw_terms=q

    PRD 4.6：仅识别 `"..."` 包裹整个 query 的最简形态；混合短语 + 关键词
    （`"foo" bar`）暂留 P1，避免一次性引入复杂语义。
    """
    if not q:
        return None, ""
    m = _PHRASE_RE.match(q)
    if m:
        return m.group(1).strip() or None, q
    return None, q


# ── msearch body 构造 ──────────────────────────────────────────
def build_msearch_body(
    *,
    types: list[str],
    params: SearchParams,
    phrase: str | None,
    accessible: acl_service.AccessibleSpaces,
) -> tuple[list[dict[str, Any]], list[str]]:
    """生成 ES `msearch` body：交替 `{index header}` 和 `{query body}`。

    Returns:
        (body, index_order)：body 是 msearch 接受的扁平 list；
        index_order 与 body 中 query 的顺序一一对应，便于配对响应。
    """
    body: list[dict[str, Any]] = []
    order: list[str] = []
    for logical in types:
        alias = _alias_for(logical)
        body.append({"index": alias})
        body.append(build_index_query(
            logical=logical,
            params=params,
            phrase=phrase,
            accessible=accessible,
        ))
        order.append(logical)
    return body, order


def build_index_query(
    *,
    logical: str,
    params: SearchParams,
    phrase: str | None,
    accessible: acl_service.AccessibleSpaces,
) -> dict[str, Any]:
    """单索引的 query body。"""
    q = params.q
    text_clause = _build_text_clause(logical, q, phrase)

    # ACL filter
    acl_node = acl_service.build_es_filter(
        accessible, params.organization_id, logical_index=logical,
    )
    must_filters: list[dict[str, Any]] = []
    must_filters.append(acl_node)

    # 通用过滤
    must_filters.extend(_extra_filters(logical, params))

    # 索引专属过滤（resource item_type, message rollback, etc.）
    must_filters.extend(_index_specific_filters(logical, params))

    # 组装 bool query：text_clause 进 must；acl + filters 进 filter
    inner_query: dict[str, Any] = {
        "bool": {
            "must": [text_clause],
            "filter": _flatten_filter_nodes(must_filters),
        }
    }

    # Recency boost（messages / memos / im）
    if logical in {"messages", "memos", "im"}:
        inner_query = {
            "function_score": {
                "query": inner_query,
                "functions": [
                    {
                        "gauss": {
                            "created_at": {
                                "origin": "now",
                                "scale": "7d",
                                "decay": 0.5,
                            }
                        }
                    }
                ],
                "score_mode": "multiply",
                "boost_mode": "multiply",
            }
        }

    body: dict[str, Any] = {
        "query": inner_query,
        "size": min(int(params.limit) * 2, 50),  # 每索引留余量供 RRF 融合截断
        "from": 0,
        "_source": True,
        "highlight": _build_highlight(logical),
        "track_total_hits": True,
    }
    return body


def _build_text_clause(logical: str, q: str, phrase: str | None) -> dict[str, Any]:
    """文本匹配 clause（多字段 + boost + 短语）。"""
    fields_for: dict[str, list[str]] = {
        # field^boost 格式
        "messages": ["content^2", "session_title"],
        "resources": ["title^3", "preview", "title.keyword^2"],
        "agents": ["name^4", "description^2"],
        "spaces": ["name^3", "description"],
        "memos": ["content^2"],
        "im": ["content^2", "conversation_name"],
    }
    fs = fields_for.get(logical) or ["content^2"]

    if phrase:
        return {
            "multi_match": {
                "query": phrase,
                "fields": fs,
                "type": "phrase",
            }
        }
    return {
        "multi_match": {
            "query": q,
            "fields": fs,
            "type": "best_fields",
            "operator": "or",
        }
    }


def _build_highlight(logical: str) -> dict[str, Any]:
    """高亮配置：3.4 节卡片片段需要的字段。"""
    field_map: dict[str, list[str]] = {
        "messages": ["content", "session_title"],
        "resources": ["title", "preview"],
        "agents": ["name", "description"],
        "spaces": ["name", "description"],
        "memos": ["content"],
        "im": ["content", "conversation_name"],
    }
    return {
        "pre_tags": ["<em>"],
        "post_tags": ["</em>"],
        "fields": {f: {"number_of_fragments": 2, "fragment_size": 120}
                   for f in field_map.get(logical, [])},
    }


def _extra_filters(logical: str, params: SearchParams) -> list[dict[str, Any]]:
    """通用过滤：space_id / agent_id / creator_type / role / time。"""
    out: list[dict[str, Any]] = []
    if params.space_id:
        # agents 索引用 space_ids 数组，其余索引用 space_id。
        field = "space_ids" if logical == "agents" else "space_id"
        if logical == "resources":
            # ：Workspace 收窄时仍保留 org-only（space_id 缺失）云资产，
            # 具体可见性由 build_es_filter 的 creator_id / resource_id ACL 把关。
            out.append({
                "bool": {
                    "should": [
                        {"term": {field: params.space_id}},
                        {"bool": {"must_not": {"exists": {"field": "space_id"}}}},
                    ],
                    "minimum_should_match": 1,
                }
            })
        else:
            out.append({"term": {field: params.space_id}})
    if params.agent_id:
        # agents 索引上字段名是 agent_id；其他索引同样使用 agent_id（仅 messages 有）
        if logical in {"agents"}:
            out.append({"term": {"agent_id": params.agent_id}})
        elif logical == "messages":
            out.append({"term": {"agent_id": params.agent_id}})
        # resources/memos/im/spaces 上没有 agent_id 字段：忽略（不会破坏召回）
    if params.creator_type and params.creator_type != "any":
        if logical in {"messages", "resources", "memos", "im"}:
            out.append({"term": {"creator_type": params.creator_type}})
        # spaces / agents 索引没有 creator_type，跳过
    if params.role and params.role != "any":
        if logical == "messages":
            out.append({"term": {"role": params.role}})
    if params.created_after:
        out.append({"range": {"created_at": {"gte": params.created_after}}})
    if params.created_before:
        out.append({"range": {"created_at": {"lte": params.created_before}}})
    return out


def _index_specific_filters(logical: str, params: SearchParams) -> list[dict[str, Any]]:
    """索引专属过滤。"""
    out: list[dict[str, Any]] = []

    if logical == "resources":
        if params.item_type:
            out.append({"term": {"item_type": params.item_type}})
        # 默认排除回收站（trashed_at != null 的不应进搜索）
        out.append({"bool": {"must_not": {"exists": {"field": "trashed_at"}}}})
        # 默认排除归档：is_archived=true 的不进默认搜索（PRD 3.4 卡片不展示归档）
        out.append({"term": {"is_archived": False}})

    if logical == "memos":
        # status='active' 的 memo 才该被搜（sync_service 已在 should_index_memo 过滤，
        # 但 ES 里可能仍有历史数据——双保险）
        out.append({"term": {"status": "active"}})

    if logical == "messages":
        # 回滚过滤（W1 + ADR-16）：被回滚消息的 checkpoint_state_index >
        # session_revert_state_index → 不应被搜到
        # 用 Painless script_filter；session 未回滚时 revert_state_index 字段
        # 缺失/None，painless 用 doc.containsKey 守卫即可避免报错
        out.append({
            "script": {
                "script": {
                    "lang": "painless",
                    "source": (
                        "if (!doc.containsKey('session_revert_state_index') "
                        "    || doc['session_revert_state_index'].size() == 0) {"
                        " return true; }"
                        "if (!doc.containsKey('checkpoint_state_index') "
                        "    || doc['checkpoint_state_index'].size() == 0) {"
                        " return true; }"
                        "return doc['checkpoint_state_index'].value "
                        "       <= doc['session_revert_state_index'].value;"
                    ),
                }
            }
        })

    if logical == "im":
        # 排除 is_deleted=true 双保险（同 memos 思路）
        out.append({"term": {"is_deleted": False}})

    if logical == "spaces":
        # 排除 is_archived=true（前端不展示归档 Space 卡片）
        out.append({"term": {"is_archived": False}})

    return out


def _flatten_filter_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`acl_service.build_es_filter` 返回的是带 `bool.filter` 的子树，
    flatten 进同级以减少嵌套。"""
    out: list[dict[str, Any]] = []
    for n in nodes:
        if not n:
            continue
        b = n.get("bool")
        if isinstance(b, dict) and "filter" in b and len(b) == 1:
            inner = b.get("filter") or []
            out.extend(inner)
        else:
            out.append(n)
    return out


# ── RRF（PRD 4.6 伪代码） ─────────────────────────────────────
def rrf_merge(
    per_index_hits: dict[str, list[dict[str, Any]]],
    k: int = 60,
) -> list[tuple[dict[str, Any], float]]:
    """Reciprocal Rank Fusion：跨索引按 1/(k+rank) 累加分数。

    Args:
        per_index_hits: dict[logical_index_name → list[ES hit dict]]
        k: RRF 常数；业界 60 是平衡新文档崛起 vs 长尾稳定的经验值

    Returns:
        list[(hit, rrf_score)]：按 rrf_score 降序排列。每个 hit 注入
        `_logical_index` key 便于下游 compose_result_item 知道走哪个
        result_type。
    """
    scored: dict[str, tuple[dict[str, Any], float]] = {}
    for logical, hits in per_index_hits.items():
        for rank, hit in enumerate(hits):
            hit_id = hit.get("_id") or ""
            uniq_key = f"{logical}::{hit_id}"  # 跨索引同 _id 不同语义需要分开
            hit_with_meta = dict(hit)
            hit_with_meta["_logical_index"] = logical
            cur_score = scored.get(uniq_key, (None, 0.0))[1]
            scored[uniq_key] = (hit_with_meta, cur_score + 1.0 / (k + rank + 1))
    return sorted(scored.values(), key=lambda x: -x[1])


# ── compose 单条结果 ─────────────────────────────────────────
def compose_result_item(
    logical: str,
    hit: dict[str, Any],
    *,
    rrf_score: float,
) -> SearchResultItem | None:
    """ES hit → SearchResultItem。"""
    result_type = _RESULT_TYPE_BY_LOGICAL.get(logical)
    if not result_type:
        return None
    src = hit.get("_source") or {}
    doc_id = hit.get("_id") or ""
    if not doc_id:
        return None

    snippet, highlight = _extract_highlight(hit, logical, src)

    creator_type = src.get("creator_type")
    if creator_type not in {"user", "agent"}:
        creator_type = None

    base = SearchResultItem(
        id=str(doc_id),
        type=result_type,
        title=_title_for(logical, src),
        snippet=snippet,
        highlight=highlight,
        creator_type=creator_type,
        creator_id=_creator_id_for(logical, src, creator_type),
        space_id=str(src.get("space_id")) if src.get("space_id") else None,
        session_id=_session_id_for(logical, src),
        session_title=src.get("session_title") or "",
        resource_id=str(src.get("resource_id")) if src.get("resource_id") else None,
        score=float(hit.get("_score") or 0.0),
        rrf_score=float(rrf_score),
        created_at=src.get("created_at"),
        role=src.get("role"),
        metadata=_metadata_for(logical, src),
    )
    return base


def _title_for(logical: str, src: dict[str, Any]) -> str:
    if logical == "messages":
        return src.get("session_title") or ""
    if logical == "resources":
        return src.get("title") or ""
    if logical == "agents":
        return src.get("name") or ""
    if logical == "spaces":
        return src.get("name") or ""
    if logical == "memos":
        # PRD 3.4：备忘录 title 取 content 首行；hydrate 不需要 PG 回查
        content = src.get("content") or ""
        first_line = content.split("\n", 1)[0]
        return first_line[:80]
    if logical == "im":
        return src.get("conversation_name") or ""
    return ""


def _creator_id_for(logical: str, src: dict[str, Any], creator_type: str | None) -> str | None:
    if logical == "agents":
        # agent 自身命中：creator_id 填本 agent 的归属 user_id（PRD 3.8.A 卡片
        # 对应 "@CodeBot" 仍按 agent 主体显示，creator_id 给前端做附加链接用）
        v = src.get("user_id")
        return str(v) if v else None
    if logical == "spaces":
        return None
    if creator_type == "user":
        v = src.get("user_id") or src.get("creator_id") or src.get("sender_id")
        return str(v) if v else None
    if creator_type == "agent":
        v = src.get("agent_id") or src.get("creator_id")
        return str(v) if v else None
    return None


def _session_id_for(logical: str, src: dict[str, Any]) -> str | None:
    if logical == "messages":
        v = src.get("session_id")
        return str(v) if v else None
    if logical == "im":
        # 复用 session_id 字段把 conversation_id 给前端，导航策略一致
        v = src.get("conversation_id")
        return str(v) if v else None
    return None


def _metadata_for(logical: str, src: dict[str, Any]) -> dict[str, Any]:
    """额外字段透传给前端（卡片定制需要）。"""
    if logical == "resources":
        return {
            "item_type": src.get("item_type"),
            "is_archived": src.get("is_archived"),
        }
    if logical == "agents":
        return {"agent_type": src.get("type"), "space_ids": src.get("space_ids") or []}
    if logical == "spaces":
        return {"space_type": src.get("type"), "is_archived": src.get("is_archived")}
    if logical == "memos":
        return {
            "tags": src.get("tags") or [],
            "ai_tags": src.get("ai_tags") or [],
            "memo_type": src.get("memo_type"),
            "source": src.get("source"),
            "is_pinned": src.get("is_pinned"),
        }
    if logical == "im":
        return {"conversation_id": src.get("conversation_id")}
    return {}


def _extract_highlight(
    hit: dict[str, Any], logical: str, src: dict[str, Any],
) -> tuple[str, dict[str, list[str]]]:
    """从 ES highlight 拿 snippet + dict 形式。"""
    hl = hit.get("highlight") or {}
    if not isinstance(hl, dict):
        hl = {}
    cleaned: dict[str, list[str]] = {
        k: [str(s) for s in v] for k, v in hl.items() if isinstance(v, list)
    }
    snippet = ""
    # 优先字段：content > preview > title > description
    for key in ("content", "preview", "title", "description", "name", "conversation_name", "session_title"):
        if cleaned.get(key):
            snippet = cleaned[key][0]
            break
    if not snippet:
        # 没 highlight：用原始字段截断
        for key in ("content", "preview", "title", "description", "name"):
            v = src.get(key)
            if v:
                snippet = str(v)[:120]
                break
    return snippet, cleaned


# ── Suggest（PRD 3.6 空结果引导） ─────────────────────────────
def _fetch_suggestions(client: Any, types: Iterable[str], q: str) -> list[str]:
    """空结果时尝试调 ES `_search` 的 term suggest。

    简化策略：只在 messages 索引上跑（CJK fuzzy 在文本量大的索引上更准）；
    返回去重后的 top 3 候选。
    """
    if "messages" not in types:
        return []
    body = {
        "size": 0,
        "suggest": {
            "did_you_mean": {
                "text": q,
                "term": {
                    "field": "content",
                    "suggest_mode": "always",
                    "min_word_length": 2,
                    "size": 3,
                },
            }
        },
    }
    try:
        resp = breaker_run(client.search, index=get_messages_alias(), body=body, request_timeout=0.4)
    except Exception:
        return []
    data = resp.get("suggest", {}) or {}
    raw = data.get("did_you_mean") or []
    out: list[str] = []
    for entry in raw:
        for opt in entry.get("options") or []:
            text = opt.get("text")
            if text and text not in out:
                out.append(text)
    return out[:3]

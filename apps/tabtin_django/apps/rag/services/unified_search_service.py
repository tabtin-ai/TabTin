"""
统一检索服务

聚合 TableEmbedding / RecordEmbedding / SkillEmbedding / ToolEmbedding
的检索逻辑，提供单一入口的跨内容类型语义检索。

v1.0: table, record, skill, tool
v1.1+: document；代码语义检索已退役
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, List, Optional

from django.conf import settings
from django.db import connections

logger = logging.getLogger(__name__)

_SEARCHER_REGISTRY: Dict[str, Callable] = {}


def _filter_valid_uuids(ids: List[str]) -> List[str]:
    """过滤掉非合法 UUID 字符串，防止 UUIDField 过滤时 ORM 报错（RC-028）。"""
    import uuid as _uuid
    result = []
    for id_str in ids:
        try:
            _uuid.UUID(str(id_str))
            result.append(id_str)
        except (ValueError, AttributeError):
            logger.warning("RC-028: invalid UUID in accessible_organization_ids: %r, skipping", id_str)
    return result


def _apply_organization_filter(filters: Dict[str, Any], organization_ids: List[str]) -> None:
    """PVEC-003: 将 organization_id 过滤条件写入 filters 字典。

    当 organization_ids 只有一个值时使用精确过滤（`organization_id=`），让 pgvector
    HNSW 索引的 pre-filtering 正常生效；多值时退化为 `organization_id__in`（pgvector
    >= 0.8 iterative scan 会缓解其性能损耗）。
    """
    if len(organization_ids) == 1:
        filters["organization_id"] = organization_ids[0]
    else:
        filters["organization_id__in"] = organization_ids


@contextlib.contextmanager
def _hnsw_iterative_scan(db_alias: str = "postgresql"):
    """PVEC-006: 在当前数据库连接上启用 HNSW iterative scan（pre-filtering）。

    pgvector >= 0.7 支持 `hnsw.iterative_scan = 'relaxed_order'`，允许
    带 WHERE 条件的 HNSW 查询使用 pre-filtering 而非 post-filter，避免
    organization 内数据稀疏时结果数量远少于 top_k。

    使用 `SET LOCAL` 使参数仅作用于当前事务；autocommit 模式下
    `SET LOCAL` 等同于 `SET`，连接归还连接池前会被 reset，无副作用。
    """
    iterative_scan = getattr(settings, "RAG_HNSW_ITERATIVE_SCAN", "relaxed_order")
    if not iterative_scan:
        yield
        return

    _VALID_ITERATIVE_SCAN_VALUES = frozenset({"relaxed_order", "strict_order", "off"})
    if iterative_scan not in _VALID_ITERATIVE_SCAN_VALUES:
        logger.error("RAG_HNSW_ITERATIVE_SCAN 配置值无效: %r，已跳过", iterative_scan)
        yield
        return

    conn = connections[db_alias]
    try:
        with conn.cursor() as cur:
            cur.execute(f"SET LOCAL hnsw.iterative_scan = '{iterative_scan}'")
        yield
    except Exception as exc:
        logger.debug("[UnifiedSearch] failed to set hnsw.iterative_scan: %s", exc)
        yield


def register_searcher(content_type: str):
    """装饰器：将函数注册为某 content_type 的子检索器。"""

    def decorator(fn: Callable):
        _SEARCHER_REGISTRY[content_type] = fn
        return fn

    return decorator


class SearchHitDict:
    """统一检索结果的 dict 构造辅助。"""

    @staticmethod
    def build(
        content_type: str,
        source_id: str,
        title: str,
        content: str,
        similarity: float,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return {
            "content_type": content_type,
            "source_id": str(source_id),
            "title": title or "",
            "content": content or "",
            "similarity": round(float(similarity), 4),
            "metadata": metadata or {},
        }


def _get_user_accessible_organizations(user_id: str) -> List[str]:
    """获取用户有权访问的所有 organization ID（owner + member）。

    USS-05: 添加 60s Django cache 缓存，避免每次请求执行 2 条 SQL。
    """
    from django.core.cache import cache

    cache_key = f"rag:accessible_organizations:{user_id}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    from apps.tabtinspace.models import Organization, OrganizationMember

    owned = Organization.objects.filter(owner_id=user_id).values_list("id", flat=True)
    member_of = OrganizationMember.objects.filter(
        user_id=user_id
    ).values_list("organization_id", flat=True)
    result = [str(wid) for wid in set(list(owned) + list(member_of))]
    cache.set(cache_key, result, timeout=60)
    return result


class UnifiedSearchService:
    """
    统一检索服务。

    设计要点：
    - 查询向量只生成一次，复用给所有子检索器
    - 各子检索器独立，失败不影响其他类型
    - 结果合并后按 similarity 全局排序
    - organization 级别权限隔离
    """

    AVAILABLE_TYPES = {"table", "record", "skill", "tool", "document"}

    def __init__(self):
        self.default_top_k = getattr(settings, "RAG_DEFAULT_TOP_K", 10)
        self.default_threshold = getattr(settings, "RAG_SIMILARITY_THRESHOLD", 0.7)

    def search(
        self,
        query: str,
        user_id: str,
        organization_id: Optional[str] = None,
        content_types: Optional[List[str]] = None,
        top_k: int = 10,
        similarity_threshold: Optional[float] = None,
        scope: Optional[Dict[str, str]] = None,
        max_content_length: Optional[int] = 300,
    ) -> Dict[str, Any]:
        start = time.time()

        if not getattr(settings, "RAG_ENABLED", True):
            return self._empty_result(query, error="RAG service is disabled")

        if not query or not query.strip():
            return self._empty_result(query)

        threshold = similarity_threshold if similarity_threshold is not None else self.default_threshold
        effective_types = self._resolve_types(content_types)

        accessible_organization_ids = _get_user_accessible_organizations(user_id)
        if organization_id and organization_id not in accessible_organization_ids:
            return self._empty_result(query, error="No access to organization")

        try:
            from apps.services.llm.services.embedding import embed_text as _embed_text
            _emb_result = _embed_text(
                scene_key="rag_search_query",
                texts=[query],
                user_id=user_id,
                organization_id=organization_id or "",
            )
            query_vector = _emb_result.vectors[0]
        except Exception as exc:
            try:
                from apps.services.llm.services.billed_call import InsufficientBalanceError
                if isinstance(exc, InsufficientBalanceError):
                    raise
            except ImportError:
                pass
            logger.error("[UnifiedSearch] embedding failed: %s", exc)
            return self._empty_result(query, error=str(exc))

        all_hits: List[Dict[str, Any]] = []
        type_counts: Dict[str, int] = {}

        # PVEC-009: 将串行子检索器循环改为并发执行，响应时间降至 max(各子检索耗时)
        _max_workers = getattr(settings, "RAG_SEARCH_MAX_WORKERS", 8)

        def _run_searcher(ct: str):
            searcher = _SEARCHER_REGISTRY.get(ct)
            if searcher is None:
                return ct, []
            try:
                hits = searcher(
                    query=query,
                    query_vector=query_vector,
                    user_id=user_id,
                    organization_id=organization_id,
                    accessible_organization_ids=accessible_organization_ids,
                    top_k=top_k,
                    threshold=threshold,
                    scope=scope,
                    max_content_length=max_content_length,
                )
                return ct, hits
            except Exception as exc:
                logger.warning("[UnifiedSearch] %s search failed: %s", ct, exc)
                return ct, []

        with ThreadPoolExecutor(max_workers=min(_max_workers, len(effective_types) or 1)) as executor:
            futures = {executor.submit(_run_searcher, ct): ct for ct in effective_types}
            for future in as_completed(futures):
                ct, hits = future.result()
                type_counts[ct] = len(hits)
                all_hits.extend(hits)

        all_hits.sort(key=lambda h: h["similarity"], reverse=True)
        all_hits = all_hits[:top_k]

        final_counts: Dict[str, int] = defaultdict(int)
        for h in all_hits:
            final_counts[h["content_type"]] += 1

        elapsed_ms = int((time.time() - start) * 1000)

        # PVEC-010: 异步写入 SearchLog，避免同步写入增加 PostgreSQL 额外延迟
        try:
            from apps.rag.tasks import log_search_async
            log_search_async.delay(
                query=query,
                user_id=user_id,
                results_count=len(all_hits),
                top_similarity=all_hits[0]["similarity"] if all_hits else 0.0,
                response_time_ms=elapsed_ms,
                organization_id=organization_id,
                content_types=content_types,
                scope=scope,
                threshold=threshold,
                top_k=top_k,
            )
        except Exception as exc:
            logger.warning("[UnifiedSearch] failed to schedule log_search_async: %s", exc)

        return {
            "query": query,
            "hits": all_hits,
            "total": len(all_hits),
            "type_counts": dict(final_counts),
            "response_time_ms": elapsed_ms,
        }

    def get_available_types(self) -> List[str]:
        return sorted(_SEARCHER_REGISTRY.keys())

    def _resolve_types(self, content_types: Optional[List[str]]) -> List[str]:
        registered = set(_SEARCHER_REGISTRY.keys())
        if not content_types:
            return sorted(registered)
        return [ct for ct in content_types if ct in registered]

    @staticmethod
    def _empty_result(query: str, error: str = "") -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "query": query or "",
            "hits": [],
            "total": 0,
            "type_counts": {},
            "response_time_ms": 0,
        }
        if error:
            result["error"] = error
        return result

    @staticmethod
    def _log_search(
        query: str,
        user_id: str,
        results_count: int,
        top_similarity: float,
        response_time_ms: int,
        organization_id: Optional[str] = None,
        content_types: Optional[List[str]] = None,
        scope: Optional[Dict[str, str]] = None,
        threshold: Optional[float] = None,
        top_k: Optional[int] = None,
    ) -> None:
        """USS-06: 记录完整检索参数到 SearchLog.filters。

        SS-006: 写入失败时以结构化日志记录关键指标，确保 PostgreSQL 故障期间
        监控数据仍有可观测性，而非静默丢弃。
        """
        try:
            from apps.rag.models import SearchLog
            SearchLog.objects.using("postgresql").create(
                user_id=user_id,
                query=query,
                results_count=results_count,
                top_similarity_score=top_similarity,
                response_time_ms=response_time_ms,
                filters={
                    "source": "unified_search_v2",
                    "organization_id": organization_id,
                    "content_types": content_types,
                    "scope": scope,
                    "threshold": threshold,
                    "top_k": top_k,
                },
            )
        except Exception as exc:
            # SS-006: 写入 SearchLog 失败时，以结构化格式记录关键指标到日志，
            # 保障 PostgreSQL 故障期间监控数据不完全丢失，便于后续离线统计恢复。
            logger.warning(
                "[UnifiedSearch] failed to log search: %s | "
                "search_metric user_id=%s results_count=%d response_time_ms=%d "
                "top_similarity=%.4f organization_id=%s",
                exc,
                user_id,
                results_count,
                response_time_ms,
                top_similarity,
                organization_id,
            )


# ======================================================================
# 子检索器实现 — 所有子检索器均接收 accessible_organization_ids 做权限过滤
# ======================================================================


def _truncate(text: Optional[str], max_length: Optional[int]) -> str:
    """按 max_length 截断文本，None 表示不截断。"""
    if not text:
        return ""
    if max_length is None:
        return text
    return text[:max_length]

@register_searcher("table")
def _search_tables(
    query_vector: List[float],
    user_id: str,
    organization_id: Optional[str],
    accessible_organization_ids: List[str],
    top_k: int,
    threshold: float,
    scope: Optional[Dict[str, str]],
    max_content_length: Optional[int] = 300,
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    from pgvector.django import CosineDistance

    from apps.rag.models import TableEmbedding

    filters: Dict[str, Any] = {}

    # DS-033: 使用顶层字段过滤，避免依赖 metadata JSON 准确性导致隔离穿透
    if scope and scope.get("table_id"):
        if not accessible_organization_ids:
            return []
        filters["table_id"] = scope["table_id"]
        # PVEC-003: 单值时精确过滤，多值时 __in
        _apply_organization_filter(filters, accessible_organization_ids)
    elif scope and scope.get("space_id"):
        if not accessible_organization_ids:
            return []
        filters["space_id"] = scope["space_id"]
        # PVEC-003: 单值时精确过滤，多值时 __in
        _apply_organization_filter(filters, accessible_organization_ids)
    elif organization_id:
        filters["organization_id"] = organization_id
    elif accessible_organization_ids:
        # PVEC-003: 单值时精确过滤，多值时 __in
        _apply_organization_filter(filters, accessible_organization_ids)
    else:
        return []

    # PVEC-006: 启用 HNSW iterative scan，让 pre-filtering 生效
    with _hnsw_iterative_scan():
        results = (
            TableEmbedding.objects.filter(**filters)
            .annotate(distance=CosineDistance("embedding", query_vector))
            # PVEC-007: 用 distance__lte 前置过滤代替 similarity__gte 后置过滤，
            # 避免 LIMIT 截断后再过滤导致结果静默少于 top_k，
            # 且 distance 是原始计算列，规划器可直接识别。
            .filter(distance__lte=1 - threshold)
            .order_by("distance")[:top_k]
        )

    return [
        SearchHitDict.build(
            content_type="table",
            source_id=r.table_id,
            title=r.metadata.get("table_name", ""),
            content=_truncate(r.content, max_content_length),
            similarity=round(1 - float(r.distance), 4),
            metadata={
                "table_id": str(r.table_id),
                "organization_id": str(r.organization_id) if r.organization_id else r.metadata.get("organization_id", ""),
                "space_id": str(r.space_id) if r.space_id else r.metadata.get("space_id", ""),
                "record_count": r.metadata.get("record_count", 0),
            },
        )
        for r in results
    ]


@register_searcher("record")
def _search_records(
    query_vector: List[float],
    user_id: str,
    organization_id: Optional[str],
    accessible_organization_ids: List[str],
    top_k: int,
    threshold: float,
    scope: Optional[Dict[str, str]],
    max_content_length: Optional[int] = 300,
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    from pgvector.django import CosineDistance

    from apps.rag.models import RecordEmbedding

    filters: Dict[str, Any] = {}

    # DS-033: 使用顶层字段过滤，避免依赖 metadata JSON 准确性导致隔离穿透
    if scope and scope.get("table_id"):
        if not accessible_organization_ids:
            return []
        filters["table_id"] = scope["table_id"]
        # PVEC-003: 单值时精确过滤，多值时 __in
        _apply_organization_filter(filters, accessible_organization_ids)
    elif scope and scope.get("space_id"):
        if not accessible_organization_ids:
            return []
        filters["space_id"] = scope["space_id"]
        # PVEC-003: 单值时精确过滤，多值时 __in
        _apply_organization_filter(filters, accessible_organization_ids)
    elif organization_id:
        filters["organization_id"] = organization_id
    elif accessible_organization_ids:
        # PVEC-003: 单值时精确过滤，多值时 __in
        _apply_organization_filter(filters, accessible_organization_ids)
    else:
        return []

    # PVEC-006: 启用 HNSW iterative scan，让 pre-filtering 生效
    with _hnsw_iterative_scan():
        results = (
            RecordEmbedding.objects.filter(**filters)
            .annotate(distance=CosineDistance("embedding", query_vector))
            # PVEC-007: 用 distance__lte 前置过滤代替 similarity__gte 后置过滤
            .filter(distance__lte=1 - threshold)
            .order_by("distance")[:top_k]
        )

    return [
        SearchHitDict.build(
            content_type="record",
            source_id=r.record_id,
            title=r.metadata.get("table_name", ""),
            content=_truncate(r.content, max_content_length),
            similarity=round(1 - float(r.distance), 4),
            metadata={
                "record_id": str(r.record_id),
                "table_id": str(r.table_id),
                "table_name": r.metadata.get("table_name", ""),
                "space_id": str(r.space_id) if r.space_id else r.metadata.get("space_id", ""),
            },
        )
        for r in results
    ]


@register_searcher("skill")
def _search_skills(
    query_vector: List[float],
    user_id: str,
    organization_id: Optional[str],
    accessible_organization_ids: List[str],
    top_k: int,
    threshold: float,
    scope: Optional[Dict[str, str]],
    query: str = "",
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    """#7118：Skill 检索的租户键改为 organization_id；不再通过 space_id 反查。"""
    from apps.skills.services.embedding_service import SkillEmbeddingService

    # 优先使用调用方显式 scope（有可能带 organization_id 定制过滤），否则回落
    # 顶层 organization_id（当前登录上下文）。scope["space_id"] 仅在极少数
    # 老调用点残留时被识别成兼容读；`_search_skills` 内部不再据此决定过滤。
    scope_org_id = None
    if scope:
        scope_org_id = scope.get("organization_id") or None

    effective_org_id = scope_org_id or organization_id

    # SC-007：显式 organization_id 必须落在当前用户可访问的组织集合内，
    # 防止跨组织越权。
    if effective_org_id and effective_org_id not in accessible_organization_ids:
        logger.warning(
            "[UnifiedSearch] skill IDOR blocked: organization=%s "
            "not in user accessible organizations",
            effective_org_id,
        )
        return []

    if not query:
        logger.warning(
            "[UnifiedSearch] _search_skills called without query text; "
            "vector-only search will be used (no keyword fallback)"
        )
    query_text = query

    results = SkillEmbeddingService.search(
        query=query_text,
        top_k=top_k,
        similarity_threshold=threshold,
        organization_id=effective_org_id,
        _query_vector=query_vector,
    )

    return [
        SearchHitDict.build(
            content_type="skill",
            source_id=r["skill_key"],
            title=r.get("name", r["skill_key"]),
            content=r.get("description", ""),
            similarity=r.get("similarity_score") or r.get("similarity", 0.0),
            metadata={
                "skill_key": r["skill_key"],
                "source": r.get("source", ""),
                "tags": r.get("tags", []),
                "location": r.get("location", ""),
            },
        )
        for r in results
    ]


@register_searcher("tool")
def _search_tools(
    query_vector: List[float],
    user_id: str,
    organization_id: Optional[str],
    accessible_organization_ids: List[str],
    top_k: int,
    threshold: float,
    scope: Optional[Dict[str, str]],
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    # SC-020 / DEC-07 / Stage-1 D1:
    # RegisteredTool 是平台级能力注册表，全局可见，无 organization 私有概念，不加租户隔离。
    # accessible_organization_ids / organization_id 参数在此函数中**不使用**，保留签名仅为接口一致。
    from pgvector.django import CosineDistance

    try:
        from apps.capabilities.models import ToolEmbedding, RegisteredTool
    except ImportError:
        return []

    from apps.capabilities.constants import CAPABILITIES_DB as DB

    max_distance = 1 - threshold

    embeddings = list(
        ToolEmbedding.objects.using(DB)
        .annotate(distance=CosineDistance("embedding", query_vector))
        .filter(distance__lte=max_distance)
        .order_by("distance")
        .values_list("tool_name", "distance")[:top_k * 2]
    )
    if not embeddings:
        return []

    candidate_names = [e[0] for e in embeddings]
    distance_map = {e[0]: float(e[1]) for e in embeddings}

    tools = {
        t.name: t
        for t in RegisteredTool.objects.using(DB).filter(
            name__in=candidate_names, status="active",
        )
    }

    ranked = sorted(
        (n for n in candidate_names if n in tools),
        key=lambda n: distance_map[n],
    )

    return [
        SearchHitDict.build(
            content_type="tool",
            source_id=tools[name].id,
            title=tools[name].display_name,
            content=tools[name].description or "",
            similarity=1 - distance_map[name],
            metadata={
                "tool_name": name,
                "category": tools[name].category,
                "domain": tools[name].domain,
                "provider_id": tools[name].provider_id,
            },
        )
        for name in ranked[:top_k]
    ]


@register_searcher("document")
def _search_documents(
    query_vector: List[float],
    user_id: str,
    organization_id: Optional[str],
    accessible_organization_ids: List[str],
    top_k: int,
    threshold: float,
    scope: Optional[Dict[str, str]],
    max_content_length: Optional[int] = 300,
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    from pgvector.django import CosineDistance

    from apps.rag.models import DocumentEmbedding

    filters: Dict[str, Any] = {}

    if scope and scope.get("space_id"):
        if not accessible_organization_ids:
            return []
        filters["space_id"] = scope["space_id"]
        # PVEC-003: 单值时精确过滤，多值时 __in
        _apply_organization_filter(filters, accessible_organization_ids)
    elif organization_id:
        filters["organization_id"] = organization_id
    elif accessible_organization_ids:
        # PVEC-003: 单值时精确过滤，多值时 __in
        _apply_organization_filter(filters, accessible_organization_ids)
    else:
        return []

    filters["status"] = "success"

    # PVEC-006: 启用 HNSW iterative scan，让 pre-filtering 生效
    with _hnsw_iterative_scan():
        results = (
            DocumentEmbedding.objects.filter(**filters)
            .annotate(distance=CosineDistance("embedding", query_vector))
            # PVEC-007: 用 distance__lte 前置过滤代替 similarity__gte 后置过滤
            .filter(distance__lte=1 - threshold)
            .order_by("distance")[:top_k]
        )

    return [
        SearchHitDict.build(
            content_type="document",
            source_id=r.document_id,
            title=r.metadata.get("title", ""),
            content=_truncate(r.content, max_content_length),
            similarity=round(1 - float(r.distance), 4),
            metadata={
                "document_id": str(r.document_id),
                "organization_id": str(r.organization_id),
                "space_id": str(r.space_id),
            },
        )
        for r in results
    ]


# ======================================================================
# 单例（USS-04: 添加 threading.Lock 防止多线程下重复创建实例）
# ======================================================================

_unified_search_instance: Optional[UnifiedSearchService] = None
_unified_search_lock = threading.Lock()


def get_unified_search_service(*, force_new: bool = False) -> UnifiedSearchService:
    global _unified_search_instance
    if _unified_search_instance is None or force_new:
        with _unified_search_lock:
            if _unified_search_instance is None or force_new:
                _unified_search_instance = UnifiedSearchService()
    return _unified_search_instance

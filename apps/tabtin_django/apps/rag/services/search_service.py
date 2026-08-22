"""
检索服务（v1 兼容层）

v1 API 的检索方法委托给 UnifiedSearchService，
保留原有接口签名和返回格式，自动获得 organization 权限校验。
"""

import logging
import time
from typing import Dict, Any, List, Optional

from django.conf import settings

logger = logging.getLogger(__name__)


class SearchService:
    """
    v1 检索服务 — 内部委托 UnifiedSearchService。

    保留 v1 的 search / search_tables / search_records 接口，
    但实际执行交给 v2 的 UnifiedSearchService，从而：
    - 消除重复的 pgvector 查询代码
    - 自动获得 organization 权限校验
    - 统一 SearchLog 记录
    """

    def __init__(self):
        from .unified_search_service import get_unified_search_service
        self._unified = get_unified_search_service()
        self.default_top_k = getattr(settings, "RAG_DEFAULT_TOP_K", 10)
        self.similarity_threshold = getattr(settings, "RAG_SIMILARITY_THRESHOLD", 0.7)

    def search(
        self,
        query: str,
        user_id: str,
        top_k: Optional[int] = None,
        scope: str = "organization",
        scope_id: Optional[str] = None,
        filters: Optional[Dict] = None,
        similarity_threshold: Optional[float] = None,
    ) -> Dict[str, Any]:
        top_k = top_k or self.default_top_k
        threshold = similarity_threshold if similarity_threshold is not None else self.similarity_threshold

        v2_scope: Optional[Dict[str, str]] = None
        organization_id: Optional[str] = None

        if scope == "table" and scope_id:
            v2_scope = {"table_id": scope_id}
        elif scope == "space" and scope_id:
            v2_scope = {"space_id": scope_id}
        elif scope == "organization" and scope_id:
            organization_id = scope_id

        result = self._unified.search(
            query=query,
            user_id=user_id,
            organization_id=organization_id,
            content_types=["table", "record"],
            top_k=top_k,
            similarity_threshold=threshold,
            scope=v2_scope,
        )

        formatted_results = self._convert_hits_to_v1(result.get("hits", []))

        return {
            "query": query,
            "results": formatted_results,
            "total": len(formatted_results),
            "response_time_ms": result.get("response_time_ms", 0),
        }

    def search_tables(
        self,
        query: str,
        user_id: str,
        organization_id: Optional[str] = None,
        top_k: int = 5,
        similarity_threshold: Optional[float] = None,
    ) -> List[Dict]:
        threshold = similarity_threshold if similarity_threshold is not None else self.similarity_threshold

        result = self._unified.search(
            query=query,
            user_id=user_id,
            organization_id=organization_id,
            content_types=["table"],
            top_k=top_k,
            similarity_threshold=threshold,
        )

        return [
            {
                "table_id": h["source_id"],
                "table_name": h.get("title", ""),
                "similarity_score": h["similarity"],
                "metadata": h.get("metadata", {}),
                "content_preview": (
                    h["content"][:200] + "..." if len(h.get("content", "")) > 200
                    else h.get("content", "")
                ),
            }
            for h in result.get("hits", [])
        ]

    def search_records(
        self,
        query: str,
        user_id: str,
        table_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        top_k: int = 10,
        similarity_threshold: Optional[float] = None,
        max_content_length: Optional[int] = 300,
    ) -> List[Dict]:
        threshold = similarity_threshold if similarity_threshold is not None else self.similarity_threshold

        v2_scope: Optional[Dict[str, str]] = None
        if table_id:
            v2_scope = {"table_id": table_id}

        result = self._unified.search(
            query=query,
            user_id=user_id,
            organization_id=organization_id,
            content_types=["record"],
            top_k=top_k,
            similarity_threshold=threshold,
            scope=v2_scope,
            max_content_length=max_content_length,
        )

        return [
            {
                "record_id": h["source_id"],
                "table_id": h.get("metadata", {}).get("table_id", ""),
                "table_name": h.get("title", ""),
                "similarity_score": h["similarity"],
                "content": h.get("content", ""),
                "metadata": h.get("metadata", {}),
                "created_at": h.get("metadata", {}).get("created_at", ""),
            }
            for h in result.get("hits", [])
        ]

    @staticmethod
    def _convert_hits_to_v1(hits: List[Dict]) -> List[Dict]:
        """将 v2 SearchHit 转换为 v1 record-style 结果格式。"""
        formatted = []
        for h in hits:
            meta = h.get("metadata", {})
            formatted.append({
                "record_id": meta.get("record_id", h["source_id"]),
                "table_id": meta.get("table_id", ""),
                "table_name": meta.get("table_name", h.get("title", "")),
                "content": h.get("content", ""),
                "similarity_score": h["similarity"],
                "metadata": meta,
                "created_at": meta.get("created_at", ""),
            })
        return formatted

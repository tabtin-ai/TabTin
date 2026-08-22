from __future__ import annotations

import logging
import re
from time import perf_counter
from dataclasses import dataclass
from typing import Any

from django.db.models import Case, FloatField, IntegerField, Q, Value, When
from django.db.models.functions import Coalesce

from apps.tabdoc.models import Document
from apps.tabdoc.services.block_service import BlockService
from apps.tabdoc.services.document_service import DocumentService
from apps.tabdoc.services.metrics import get_tabdoc_metrics

logger = logging.getLogger(__name__)


@dataclass
class DocumentSearchHit:
    document: Document
    snippet: str
    relevance_score: float
    matched_on_title: bool
    block_id: str | None = None
    block_type: str | None = None
    block_index: int | None = None
    block_preview: str = ""


class DocumentSearchService:
    """
    文档全文检索服务（组合模式）

    使用 DocumentService 进行权限检查和项目上下文验证，
    自身只负责搜索逻辑，不暴露写操作方法。

    架构说明（CAP-023 决策）：
    本服务仅使用 PostgreSQL FTS（+ icontains 回退）实现用户搜索路径。
    DocumentEmbeddingService 维护的向量索引不在此消费——它被 RAG 模块
    （rag/services/unified_search_service.py）用于 Agent 语义检索，
    两套索引服务不同场景，向量索引并非"空跑"。
    中期规划：当 FTS 无结果时 fallback 到向量搜索以提升长尾查询质量。
    """

    MAX_PAGE_SIZE = 50
    DEFAULT_PAGE_SIZE = 20
    PLAINTEXT_SEPARATOR_RE = re.compile(r"[#>*_\-\[\]\(\)]")

    def __init__(self, user=None):
        self._doc_service = DocumentService(user=user)

    KEYWORD_MAX_LENGTH = 200

    def _normalize_keyword(self, keyword: str) -> str:
        value = (keyword or "").strip()
        if not value:
            raise ValueError("q 不能为空")
        if len(value) > self.KEYWORD_MAX_LENGTH:
            value = value[:self.KEYWORD_MAX_LENGTH]
        return value

    def _build_plaintext_query_variants(self, keyword: str) -> tuple[str, ...]:
        variants = [keyword]
        separator_normalized = self.PLAINTEXT_SEPARATOR_RE.sub(" ", keyword)
        separator_normalized = re.sub(r"\s+", " ", separator_normalized).strip()
        if separator_normalized and separator_normalized.casefold() != keyword.casefold():
            variants.append(separator_normalized)
        return tuple(variants)

    def _build_plaintext_fallback_q(self, variants: tuple[str, ...]) -> Q:
        fallback_q = Q(description_plaintext__icontains=variants[0])
        for variant in variants[1:]:
            fallback_q |= Q(description_plaintext__icontains=variant)
        return fallback_q

    def _build_title_fallback_q(self, variants: tuple[str, ...]) -> Q:
        fallback_q = Q(title__icontains=variants[0])
        for variant in variants[1:]:
            fallback_q |= Q(title__icontains=variant)
        return fallback_q

    MAX_PAGE = 1000

    def _normalize_page(self, page: int) -> int:
        try:
            return max(1, min(int(page or 1), self.MAX_PAGE))
        except (TypeError, ValueError) as exc:
            raise ValueError("page 必须为正整数") from exc

    def _normalize_page_size(self, page_size: int) -> int:
        if page_size is None:
            return self.DEFAULT_PAGE_SIZE
        try:
            normalized = int(page_size)
        except (TypeError, ValueError) as exc:
            raise ValueError("page_size 必须为正整数") from exc
        return max(1, min(normalized, self.MAX_PAGE_SIZE))

    def _find_snippet_match(self, source: str, query: str) -> tuple[int, int] | None:
        lower_source = source.lower()
        lower_query = query.lower()
        match_index = lower_source.find(lower_query)
        if match_index >= 0:
            return match_index, len(query)

        terms = [
            term
            for term in re.findall(r"[\w\u4e00-\u9fff]+", lower_query)
            if len(term) >= 2
        ]
        for term in terms:
            match_index = lower_source.find(term)
            if match_index >= 0:
                return match_index, len(term)
        return None

    def _build_snippet(self, plaintext: str, keyword: str) -> str:
        query = keyword.strip()
        source = (plaintext or "").strip()
        if not source:
            return ""

        match = self._find_snippet_match(source, query)
        if match is None:
            return source[:140]

        match_index, match_length = match
        start = max(0, match_index - 32)
        end = min(len(source), match_index + match_length + 96)
        snippet = source[start:end]
        snippet = re.sub(r"\s+", " ", snippet).strip()

        if start > 0:
            snippet = f"...{snippet}"
        if end < len(source):
            snippet = f"{snippet}..."
        return snippet

    def _build_organization_base_qs(self, svc: DocumentService, organization_uuid):
        if not svc.user:
            raise PermissionError("无权访问组织文档")
        combined_q, has_access = svc.build_organization_permission_q(organization_uuid)
        if not has_access:
            return Document.objects.none()
        return Document.objects.filter(
            organization_id=organization_uuid,
            status="active",
        ).filter(combined_q).distinct()

    def _find_first_block_hit(self, document: Document, keyword: str) -> dict[str, Any] | None:
        try:
            result = BlockService(self._doc_service).search_blocks(document, keyword, limit=1)
        except Exception:
            logger.warning(
                "[TabDocSearch] block anchor lookup failed: doc=%s",
                getattr(document, "id", None),
                exc_info=True,
            )
            return None
        items = result.get("items") or []
        first = items[0] if items else None
        return first if isinstance(first, dict) else None

    def search_documents(
        self,
        *,
        organization_id: str,
        space_id: str | None = None,
        keyword: str,
        page: int = 1,
        page_size: int = DEFAULT_PAGE_SIZE,
        scope: str = "organization",
    ) -> dict[str, Any]:
        started_at = perf_counter()
        try:
            normalized_keyword = self._normalize_keyword(keyword)
            normalized_page = self._normalize_page(page)
            normalized_page_size = self._normalize_page_size(page_size)
            plaintext_query_variants = self._build_plaintext_query_variants(normalized_keyword)
            plaintext_fallback_q = self._build_plaintext_fallback_q(plaintext_query_variants)
            title_fallback_q = self._build_title_fallback_q(plaintext_query_variants)

            svc = self._doc_service
            organization_uuid = svc._parse_uuid(organization_id, "organization_id")
            effective_scope = "organization" if not space_id else scope

            if effective_scope == "organization":
                base_qs = self._build_organization_base_qs(svc, organization_uuid)
            else:
                if not space_id:
                    raise ValueError("space_id is required when scope=space")
                svc._ensure_space_context(organization_id, space_id)
                if not svc.check_organization_permission(organization_id, required_role="viewer"):
                    raise PermissionError("无权访问该组织文档")
                space_uuid = svc._parse_uuid(space_id, "space_id")
                base_qs = Document.objects.filter(
                    organization_id=organization_uuid,
                    space_id=space_uuid,
                    status="active",
                )
                perm_q = svc._build_permission_filter_q(
                    space_uuid,
                    required_role="viewer",
                    organization_id=organization_uuid,
                )
                base_qs = base_qs.filter(perm_q).distinct()

            from django.db import connections, router as db_router
            _doc_db_alias = db_router.db_for_read(Document) or "postgresql"
            _use_pg_fts = connections[_doc_db_alias].vendor == 'postgresql'

            candidates_qs = None
            if _use_pg_fts:
                from django.contrib.postgres.search import SearchQuery, SearchRank
                search_query = SearchQuery(normalized_keyword, config="simple")
                rank_expr = Coalesce(
                    SearchRank("search_vector", search_query),
                    Value(0.0),
                    output_field=FloatField(),
                )
                # FTS 是主路径，但不能成为唯一入口：新建文档或格式转换失败时
                # search_vector 可能短暂为空，Agent 仍应能用正文关键词找到文档。
                candidates_qs = (
                    base_qs.filter(
                        Q(search_vector=search_query)
                        | title_fallback_q
                        | plaintext_fallback_q
                    )
                    .annotate(
                        ts_rank=rank_expr,
                        title_hit=Case(
                            When(title_fallback_q, then=Value(2)),
                            default=Value(0),
                            output_field=IntegerField(),
                        ),
                        text_hit=Case(
                            When(description_plaintext__icontains=normalized_keyword, then=Value(1)),
                            default=Value(0),
                            output_field=IntegerField(),
                        ),
                        # TD-11: SearchRank 不接受 output_field 关键字（传了会 TypeError → 端点 500）；
                        # 它本就返回 float，无需声明。content_hit 用于 relevance_score（见下方 page_hits）。
                        content_hit=rank_expr,
                        content_text_hit=Case(
                            When(plaintext_fallback_q, then=Value(1)),
                            default=Value(0),
                            output_field=IntegerField(),
                        ),
                    )
                    .order_by("-title_hit", "-ts_rank", "-content_text_hit", "-updated_at")
                )

            if candidates_qs is None:
                candidates_qs = (
                    base_qs.annotate(
                        title_hit=Case(
                            When(title_fallback_q, then=Value(2)),
                            default=Value(0),
                            output_field=IntegerField(),
                        ),
                        content_hit=Case(
                            When(plaintext_fallback_q, then=Value(1)),
                            default=Value(0),
                            output_field=IntegerField(),
                        ),
                    )
                    .filter(title_fallback_q | plaintext_fallback_q)
                    .order_by("-title_hit", "-content_hit", "-updated_at")
                )

            # DB 层分页：先 count 再切片，避免全量加载
            total = candidates_qs.count()
            offset = (normalized_page - 1) * normalized_page_size
            page_docs = list(candidates_qs[offset:offset + normalized_page_size])
            total_pages = max(1, (total + normalized_page_size - 1) // normalized_page_size)

            page_hits: list[DocumentSearchHit] = []
            for document in page_docs:
                plaintext = document.description_plaintext or ""
                content_match = self._find_snippet_match(plaintext, normalized_keyword) is not None
                title_hit = float(getattr(document, "title_hit", 0) or 0)
                title_matched = title_hit > 0
                snippet = self._build_snippet(
                    plaintext=plaintext,
                    keyword=normalized_keyword,
                )
                if not snippet.strip() and title_matched:
                    snippet = self._build_snippet(
                        plaintext=document.title or "",
                        keyword=normalized_keyword,
                    )
                    if not snippet.strip() and (document.title or "").strip():
                        snippet = (document.title or "").strip()[:140]
                content_hit = float(getattr(document, "content_hit", 0) or 0)
                content_text_hit = float(getattr(document, "content_text_hit", 0) or 0)
                relevance_score = title_hit + content_hit + content_text_hit
                block_hit = self._find_first_block_hit(document, normalized_keyword) if content_match else None

                page_hits.append(
                    DocumentSearchHit(
                        document=document,
                        snippet=snippet,
                        relevance_score=relevance_score,
                        matched_on_title=title_hit > 0,
                        block_id=str(block_hit.get("block_id")) if block_hit and block_hit.get("block_id") else None,
                        block_type=str(block_hit.get("block_type")) if block_hit and block_hit.get("block_type") else None,
                        block_index=int(block_hit["index"]) if block_hit and block_hit.get("index") is not None else None,
                        block_preview=str(block_hit.get("preview") or "") if block_hit else "",
                    )
                )

            return {
                "items": page_hits,
                "total": total,
                "page": normalized_page,
                "page_size": normalized_page_size,
                "total_pages": total_pages,
                "query": normalized_keyword,
            }
        finally:
            elapsed_ms = (perf_counter() - started_at) * 1000
            get_tabdoc_metrics().record_search_latency(elapsed_ms)

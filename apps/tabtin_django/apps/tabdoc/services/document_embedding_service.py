"""
DocumentEmbeddingService — 文档向量索引与管理

职责：
- 将 Document 的 title + plaintext 向量化并存入 DocumentEmbedding
- 支持增量检测（content_hash 跳过无变化文档）
- 提供删除和批量索引接口
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Dict, List, Optional

from django.core.exceptions import ImproperlyConfigured
from django.db import transaction

from apps.services.llm.scenes.exceptions import SceneRoutingDisabled

logger = logging.getLogger(__name__)

try:
    import sentry_sdk
    _has_sentry = True
except ImportError:
    _has_sentry = False

# v0.1 宪法 06 §1：所有 embedding scene capability_requirements.embedding_dimensions
# 统一硬约束 1024。这里以 ``rag_index_document`` scene 为权威单源，避免业务侧再
# 读 settings.RAG_EMBEDDING_DIMENSIONS。
_DOC_EMBEDDING_FALLBACK_DIM = 1024
_DOC_EMBEDDING_DDL_SCENE = 'rag_index_document'


def _classify_embedding_exception(exc: Exception) -> tuple[str, bool]:
    """Return (failure_reason, retryable) for embedding failures."""
    cursor: BaseException | None = exc
    while cursor is not None:
        if cursor.__class__.__name__ in {
            "SceneBindingUnavailable",
            "SceneBindingViolatesByokBoundary",
            "NoProviderHealthy",
            "CapabilityMismatch",
            "EmbeddingDimensionMismatch",
        }:
            return cursor.__class__.__name__, False
        cursor = cursor.__cause__ or cursor.__context__

    if isinstance(exc, ImproperlyConfigured):
        return "embedding_configuration_error", False
    return "embedding_runtime_error", True


def _resolve_doc_embedding_ddl_dim() -> int:
    """从 SceneRegistry 读取 ``rag_index_document`` 约定的 embedding 维度。

    SceneRegistry 不可用或字段缺失时回落到 v0.1 硬约束 1024，避免在 import 早期
    阶段触发循环依赖。
    """
    try:
        from apps.services.llm.scenes.registry import SCENES
    except Exception:
        return _DOC_EMBEDDING_FALLBACK_DIM
    spec = SCENES.get(_DOC_EMBEDDING_DDL_SCENE)
    if spec is None:
        return _DOC_EMBEDDING_FALLBACK_DIM
    cap_reqs = spec.capability_requirements or {}
    dim = cap_reqs.get('embedding_dimensions')
    try:
        return int(dim) if dim else _DOC_EMBEDDING_FALLBACK_DIM
    except (TypeError, ValueError):
        return _DOC_EMBEDDING_FALLBACK_DIM


class DocumentEmbeddingService:
    """Index TabDoc documents into RAG DocumentEmbedding."""

    @classmethod
    def index_document(
        cls,
        document_id: str,
        force: bool = False,
        user_id: str = "",
    ) -> Dict[str, Any]:
        """Index a single document. Returns status dict."""
        from apps.tabdoc.models import Document
        from apps.rag.models import DocumentEmbedding
        from apps.rag.services.embedding_service import get_embedding_service
        from apps.rag.utils import calculate_content_hash

        try:
            doc = Document.objects.filter(id=document_id).only(
                "id", "title", "description_plaintext", "description_json",
                "organization_id", "space_id", "status", "trashed_at",
                "created_by_id",
            ).first()
        except Exception as exc:
            logger.error(
                "[DocEmbedding] DB query failed for %s, skipping (not deleting index): %s",
                document_id, exc,
            )
            return {"status": "failed", "error": f"db_query_error: {exc}", "document_id": str(document_id)}

        if not doc:
            DocumentEmbedding.objects.filter(document_id=document_id).delete()
            return {"status": "not_found", "document_id": str(document_id)}

        is_inactive = (
            doc.status in ("archived", "trashed")
            or getattr(doc, "trashed_at", None) is not None
        )
        if is_inactive:
            DocumentEmbedding.objects.filter(document_id=document_id).delete()
            return {"status": "skipped", "reason": "archived/trashed", "document_id": str(document_id)}

        if not doc.organization_id:
            logger.warning("[DocEmbedding] missing organization_id for %s, skip", document_id)
            # INT-102: 删除可能已存在的旧索引，防止孤立索引记录
            DocumentEmbedding.objects.filter(document_id=document_id).delete()
            return {"status": "skipped", "reason": "missing_organization", "document_id": str(document_id)}

        content = cls._build_content(doc)
        if not content.strip():
            # TD-004: 内容为空时清理已存在的旧索引，防止孤立向量污染搜索结果
            DocumentEmbedding.objects.filter(document_id=document_id).delete()
            return {"status": "skipped", "reason": "empty_content", "document_id": str(document_id)}

        # INT-30: content_hash 纳入 organization_id 和 space_id，
        # 文档跨空间移动后索引的空间归属需要更新
        ws_id = str(doc.organization_id) if doc.organization_id else ""
        sp_id = str(doc.space_id) if doc.space_id else ""
        content_for_hash = f"{ws_id}:{sp_id}:{content}"
        content_hash = calculate_content_hash(content_for_hash)

        if not force:
            existing = DocumentEmbedding.objects.filter(
                document_id=document_id, content_hash=content_hash,
            ).first()
            if existing:
                return {"status": "skipped", "reason": "unchanged", "document_id": str(document_id)}

        # TD-001: 加 cache 分布式锁，防止并发双路径同时通过哈希检查后各自调用 embed_text
        # 两条路径（路径A: signal→rag.index_document_task，路径B: merge_doc_updates→tabdoc.index_document_embedding）
        # 可能同时通过哈希检查（TOCTOU），锁保证只有一个进入 embed 阶段，另一个直接跳过。
        # 锁 TTL = 120s（覆盖单次 embed 最长耗时 90s + 余量），锁 key 包含 content_hash 使不同内容互不影响。
        from django.core.cache import cache as _cache
        _lock_key = f"rag:doc_embed_lock:{document_id}:{content_hash}"
        _lock_acquired = _cache.add(_lock_key, "1", timeout=120)
        if not _lock_acquired:
            logger.debug(
                "[DocEmbedding] concurrent embed detected for %s (hash=%s...), skipping duplicate call",
                document_id, content_hash[:8],
            )
            return {"status": "skipped", "reason": "concurrent_embed", "document_id": str(document_id)}

        try:
            svc = get_embedding_service()
            # ECI-007: 调用方可能不传 user_id（如 Celery 任务路径），
            # 优先用调用方传入的 user_id，否则从文档的 created_by_id 自动解析。
            effective_user_id = user_id or (str(doc.created_by_id) if doc.created_by_id else "")
            # EB-005: DDL 维度守卫 — v0.1 单源从 SceneRegistry 读取约定维度
            # （宪法 06 §1：所有 embedding scene 强制 1024）。
            _doc_embedding_ddl_dim = _resolve_doc_embedding_ddl_dim()
            if svc.dimensions != _doc_embedding_ddl_dim:
                dim_err = (
                    f"[DocEmbedding] DDL 维度不匹配: svc.dimensions={svc.dimensions}, "
                    f"DocumentEmbedding DDL={_doc_embedding_ddl_dim}，跳过 document_id={document_id}。"
                    f"请同步更新迁移文件并重建向量索引后再启用。"
                )
                logger.error(dim_err)
                if _has_sentry:
                    sentry_sdk.capture_message(
                        f"[DocEmbedding] DDL 维度不匹配: svc={svc.dimensions}, ddl={_doc_embedding_ddl_dim}",
                        level="error",
                        extras={
                            "document_id": str(document_id),
                            "svc_dimensions": svc.dimensions,
                            "ddl_dimensions": _doc_embedding_ddl_dim,
                        },
                    )
                _cache.delete(_lock_key)
                return {"status": "failed", "error": dim_err, "document_id": str(document_id)}
            vector = svc.embed_text(content, organization_id=ws_id, user_id=effective_user_id)
        except SceneRoutingDisabled:
            logger.info("[DocEmbedding] skipped %s because scene routing is disabled", document_id)
            _cache.delete(_lock_key)
            return {
                "status": "skipped", "reason": "scene_routing_disabled",
                "document_id": str(document_id),
            }
        except Exception as exc:
            failure_reason, retryable = _classify_embedding_exception(exc)
            logger.error(
                "[DocEmbedding] embed failed for %s: reason=%s retryable=%s error=%s",
                document_id, failure_reason, retryable, exc,
            )
            _cache.delete(_lock_key)
            return {
                "status": "failed",
                "error": str(exc),
                "document_id": str(document_id),
                "failure_reason": failure_reason,
                "retryable": retryable,
            }

        # INT-29: embedding 成功后 DB 写入失败时 token 已消费，记录 warning 返回 failed
        try:
            # INT-96: DocumentEmbedding 在 PostgreSQL，显式指定 using 避免依赖 Router
            with transaction.atomic(using="postgresql"):
                DocumentEmbedding.objects.update_or_create(
                    document_id=document_id,
                    version=1,
                    defaults={
                        "organization_id": doc.organization_id,
                        "space_id": doc.space_id,
                        "content": content,
                        "content_hash": content_hash,
                        "embedding": vector,
                        "metadata": {
                            "title": doc.title or "",
                            "document_id": str(document_id),
                            "organization_id": ws_id,
                            "space_id": sp_id,
                            "embedding_provider": getattr(svc, "provider", ""),
                            "embedding_model": getattr(svc, "model", ""),
                            "embedding_dimensions": getattr(svc, "dimensions", 0),
                        },
                        "status": "success",
                    },
                )
        except Exception as exc:
            logger.warning(
                "[DocEmbedding] DB write failed after embedding for %s (token consumed): %s",
                document_id, exc,
            )
            _cache.delete(_lock_key)
            return {"status": "failed", "error": f"db_write_error: {exc}", "document_id": str(document_id)}

        logger.info("[DocEmbedding] indexed %s", document_id)
        return {"status": "success", "document_id": str(document_id)}

    @classmethod
    def index_documents_batch(
        cls,
        document_ids: List[str],
        force: bool = False,
        user_id: str = "",
        max_workers: int | None = None,
    ) -> Dict[str, int]:
        """Batch index documents using bulk embed_texts to minimise HTTP round-trips.

        RAG-BATCH: replaces the old ThreadPoolExecutor(4) × embed_text path.
        Flow: batch DB query → filter/hash dedup → group by organization_id →
              embed_texts per group → bulk upsert.

        ``max_workers`` is kept for call-site compatibility but no longer used.
        """
        from apps.tabdoc.models import Document
        from apps.rag.models import DocumentEmbedding
        from apps.rag.services.embedding_service import get_embedding_service
        from apps.rag.utils import calculate_content_hash

        counts: Dict[str, int] = {"success": 0, "skipped": 0, "failed": 0, "no_billing": 0}
        if not document_ids:
            return counts

        # --- Phase 1: batch DB query -------------------------------------------
        try:
            docs_qs = Document.objects.filter(id__in=document_ids).only(
                "id", "title", "description_plaintext", "description_json",
                "organization_id", "space_id", "status", "trashed_at",
                "created_by_id",
            )
            docs_map: Dict[str, Any] = {str(doc.id): doc for doc in docs_qs}
        except Exception as exc:
            logger.error("[DocEmbedding] batch DB query failed: %s", exc)
            counts["failed"] = len(document_ids)
            return counts

        # --- Phase 2: pre-filter, build content, compute hashes ----------------
        stale_ids: List[str] = []
        organization_groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

        for doc_id in document_ids:
            doc = docs_map.get(str(doc_id))

            if not doc:
                stale_ids.append(str(doc_id))
                counts["skipped"] += 1
                continue

            is_inactive = (
                doc.status in ("archived", "trashed")
                or getattr(doc, "trashed_at", None) is not None
            )
            if is_inactive:
                stale_ids.append(str(doc_id))
                counts["skipped"] += 1
                continue

            if not doc.organization_id:
                stale_ids.append(str(doc_id))
                counts["skipped"] += 1
                continue

            content = cls._build_content(doc)
            if not content.strip():
                stale_ids.append(str(doc_id))
                counts["skipped"] += 1
                continue

            ws_id = str(doc.organization_id) if doc.organization_id else ""
            sp_id = str(doc.space_id) if doc.space_id else ""
            content_hash = calculate_content_hash(f"{ws_id}:{sp_id}:{content}")

            if not force:
                existing = DocumentEmbedding.objects.filter(
                    document_id=doc_id, content_hash=content_hash,
                ).first()
                if existing:
                    counts["skipped"] += 1
                    continue

            effective_user_id = user_id or (
                str(doc.created_by_id) if doc.created_by_id else ""
            )
            # BL-003: 系统导入文档（created_by_id=None）且调用方未传 user_id 时计费将被静默跳过。
            # 此处显式记录 warning，使运维可感知哪些文档未被计费覆盖。
            if not effective_user_id:
                logger.warning(
                    "[DocEmbedding] BL-003: doc_id=%s organization_id=%s has no user_id "
                    "(created_by_id=None, caller did not pass user_id); "
                    "embedding billing will be skipped for this document.",
                    doc_id, ws_id,
                )
                counts["no_billing"] += 1
            organization_groups[ws_id].append({
                "doc_id": str(doc_id),
                "doc": doc,
                "content": content,
                "content_hash": content_hash,
                "ws_id": ws_id,
                "sp_id": sp_id,
                "effective_user_id": effective_user_id,
            })

        # Bulk-delete stale embeddings in one query
        if stale_ids:
            DocumentEmbedding.objects.filter(document_id__in=stale_ids).delete()

        if not organization_groups:
            return counts

        # --- Phase 3: batch embed per organization group --------------------------
        svc = get_embedding_service()

        for ws_id, candidates in organization_groups.items():
            texts = [c["content"] for c in candidates]
            batch_user_id = candidates[0]["effective_user_id"]

            try:
                vectors = svc.embed_texts(
                    texts, organization_id=ws_id, user_id=batch_user_id,
                )
            except SceneRoutingDisabled:
                logger.info(
                    "[DocEmbedding] batch skipped because scene routing is disabled: "
                    "organization=%s docs=%d", ws_id, len(candidates),
                )
                counts["skipped"] += len(candidates)
                continue
            except Exception as exc:
                logger.error(
                    "[DocEmbedding] batch embed failed for organization %s (%d docs): %s",
                    ws_id, len(candidates), exc,
                )
                counts["failed"] += len(candidates)
                continue

            # --- Phase 4: upsert embeddings ------------------------------------
            for candidate, vector in zip(candidates, vectors):
                try:
                    with transaction.atomic(using="postgresql"):
                        DocumentEmbedding.objects.update_or_create(
                            document_id=candidate["doc_id"],
                            version=1,
                            defaults={
                                "organization_id": candidate["doc"].organization_id,
                                "space_id": candidate["doc"].space_id,
                                "content": candidate["content"],
                                "content_hash": candidate["content_hash"],
                                "embedding": vector,
                                "metadata": {
                                    "title": candidate["doc"].title or "",
                                    "document_id": candidate["doc_id"],
                                    "organization_id": candidate["ws_id"],
                                    "space_id": candidate["sp_id"],
                                    "embedding_provider": getattr(svc, "provider", ""),
                                    "embedding_model": getattr(svc, "model", ""),
                                    "embedding_dimensions": getattr(svc, "dimensions", 0),
                                },
                                "status": "success",
                            },
                        )
                    counts["success"] += 1
                    logger.info("[DocEmbedding] indexed %s", candidate["doc_id"])
                except Exception as exc:
                    logger.warning(
                        "[DocEmbedding] DB write failed after embedding for %s "
                        "(token consumed): %s",
                        candidate["doc_id"], exc,
                    )
                    counts["failed"] += 1

        return counts

    @classmethod
    def delete_document_index(cls, document_id: str) -> Dict[str, Any]:
        from apps.rag.models import DocumentEmbedding
        deleted, _ = DocumentEmbedding.objects.filter(document_id=document_id).delete()
        if deleted:
            logger.info("[DocEmbedding] deleted index for %s (%d rows)", document_id, deleted)
        return {"deleted": deleted, "document_id": str(document_id)}

    @staticmethod
    def _build_content(doc) -> str:
        """Build embedding text from document title + body.

        RAG-4: 优先从 description_json（ProseMirror JSON）提取全文，
        仅当 JSON 为空时退回到 description_plaintext。
        """
        import re as _re

        parts = []
        if doc.title:
            parts.append(doc.title)

        body_text = ""
        pm_json = getattr(doc, "description_json", None)
        if pm_json and isinstance(pm_json, dict):
            body_text = DocumentEmbeddingService._extract_text_from_pm_json(pm_json)

        if not body_text.strip():
            plaintext = getattr(doc, "description_plaintext", "") or ""
            if plaintext.strip():
                cleaned = _re.sub(r"<[^>]+>", " ", plaintext)
                body_text = _re.sub(r"\s+", " ", cleaned).strip()

        if body_text.strip():
            parts.append(body_text.strip())
        return "\n".join(parts)

    _PM_JSON_MAX_DEPTH = 100

    @staticmethod
    def _extract_text_from_pm_json(pm_json: dict, *, max_depth: int = 100) -> str:
        """Recursively extract plain text from ProseMirror JSON node tree.

        RAG-BATCH: ``max_depth`` guards against pathologically deep or
        circular JSON structures that would blow the Python call stack.
        """
        def _extract(node: dict, depth: int = 0) -> str:
            if depth >= max_depth:
                return ""
            node_type = node.get("type", "")
            if node_type == "text":
                return node.get("text", "")
            if node_type == "hardBreak":
                return "\n"
            if node_type == "mathematics":
                attrs = node.get("attrs") or {}
                return str(attrs.get("latex") or attrs.get("value") or "")
            if node_type == "image":
                attrs = node.get("attrs") or {}
                alt = str(attrs.get("alt") or "")
                return f"[{alt}]" if alt else ""
            if node_type == "tabdataBlock":
                attrs = node.get("attrs") or {}
                title = str(attrs.get("title") or "")
                return f"[表格: {title}]" if title else ""
            if node_type == "htmlBlock":
                attrs = node.get("attrs") or {}
                title = str(attrs.get("title") or "")
                return f"[HTML: {title}]" if title else ""
            children = node.get("content", [])
            if not isinstance(children, list):
                return ""
            child_parts = [_extract(c, depth + 1) for c in children if isinstance(c, dict)]
            if node_type in ("paragraph", "heading", "blockquote", "listItem", "taskItem"):
                return "".join(child_parts) + "\n"
            return "".join(child_parts)

        return _extract(pm_json)

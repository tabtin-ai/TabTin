"""
ToolEmbeddingService — 工具向量索引与语义检索

复用 RAG EmbeddingService（qwen text-embedding-v4）生成向量，
存储在 ToolEmbedding 模型（pgvector），支持基于余弦距离的语义检索。
"""

import hashlib
import logging
from typing import Any, Dict, List, Optional

from apps.capabilities.constants import CAPABILITIES_DB as DB, DEFAULT_TOP_K

logger = logging.getLogger(__name__)

try:
    import sentry_sdk
    _has_sentry = True
except ImportError:
    _has_sentry = False

# EQ-018: 平台级 embedding 操作的系统标识（Tool 注册是平台级能力，无用户归属，D1 决策：全局可见）
# organization_id="system" 传入 embed_text 以区分系统调用，user_id="" 确保不扣用户点券
_SYSTEM_ORGANIZATION_ID = "system"


class ToolEmbeddingService:
    """工具向量索引和语义检索服务。"""

    # ── 索引 ────────────────────────────────────────────

    @staticmethod
    def index_tool(
        tool_id: str,
        tool_name: str,
        display_name: str,
        description: str,
        tags: Optional[List[str]] = None,
        category: str = "",
        provider_id: str = "",
        documentation: str = "",
    ) -> bool:
        """为单个工具创建/更新向量索引。返回是否实际写入。"""
        from apps.capabilities.models import ToolEmbedding

        content = build_content_text(
            tool_name, display_name, description, tags, category, provider_id,
            documentation,
        )
        # EQ-020: 使用完整 64 字符 hexdigest，避免旧的 16 字符（8 字节）截断带来的碰撞风险
        content_hash = hashlib.sha256(content.encode()).hexdigest()

        existing = (
            ToolEmbedding.objects.using(DB)
            .filter(tool_name=tool_name)
            .values_list("content_hash", flat=True)
            .first()
        )
        # EQ-020: 兼容存量的 16 字符短 hash——完整 hash 或旧短 hash 命中均跳过重新 embedding
        if existing == content_hash or existing == content_hash[:16]:
            return False

        try:
            from apps.services.llm.scenes.exceptions import NoProviderHealthy
            from apps.services.llm.services.embedding import embed_text as _unified_embed
            _emb_result = _unified_embed(
                scene_key="rag_index_tool",
                texts=[content],
                user_id="",
                organization_id=_SYSTEM_ORGANIZATION_ID,
            )
            vector = _emb_result.vectors[0]
            logger.info(
                "[ToolEmbedding][SYSTEM] 平台级索引 embedding: tool=%s, content_len=%d",
                tool_name, len(content),
            )
        except NoProviderHealthy as exc:
            logger.warning(
                "[ToolEmbedding] 向量化跳过（LLM provider 未就绪）: %s (%s)",
                tool_name,
                exc,
            )
            return False
        except Exception:
            logger.warning(
                "[ToolEmbedding] 向量化失败: %s", tool_name, exc_info=True,
            )
            return False

        ToolEmbedding.objects.using(DB).update_or_create(
            tool_name=tool_name,
            defaults={
                "tool_id": tool_id,
                "content_hash": content_hash,
                "embedding": vector,
            },
        )
        return True

    @staticmethod
    def index_all() -> Dict[str, int]:
        """为所有 active 的 RegisteredTool 创建向量索引。"""
        from apps.capabilities.models import RegisteredTool

        stats = {"total": 0, "indexed": 0, "skipped": 0, "failed": 0}

        tools = RegisteredTool.objects.using(DB).filter(status="active")
        stats["total"] = tools.count()

        for tool in tools.iterator():
            try:
                written = ToolEmbeddingService.index_tool(
                    tool_id=str(tool.id),
                    tool_name=tool.name,
                    display_name=tool.display_name,
                    description=tool.description or "",
                    tags=tool.tags,
                    category=tool.category,
                    provider_id=tool.provider_id,
                    documentation=tool.documentation or "",
                )
                if written:
                    stats["indexed"] += 1
                else:
                    stats["skipped"] += 1
            except Exception:
                stats["failed"] += 1
                logger.warning(
                    "[ToolEmbedding] 索引失败: %s", tool.name, exc_info=True,
                )

        logger.info(
            "[ToolEmbedding] 全量索引完成: %s", stats,
        )
        return stats

    # ── 语义检索 ────────────────────────────────────────

    @staticmethod
    def search(
        query: str,
        top_k: int = DEFAULT_TOP_K,
        category: Optional[str] = None,
        provider_id: Optional[str] = None,
        domain: Optional[str] = None,
        similarity_threshold: float = 0.5,
    ) -> List[Dict[str, Any]]:
        """语义检索工具。返回按相似度降序排列的工具列表。"""
        from pgvector.django import CosineDistance
        from apps.capabilities.models import ToolEmbedding, RegisteredTool

        try:
            from apps.services.llm.services.embedding import embed_text as _unified_embed
            _emb_result = _unified_embed(
                scene_key="rag_search_query",
                texts=[query],
                user_id="",
                organization_id=_SYSTEM_ORGANIZATION_ID,
            )
            query_vector = _emb_result.vectors[0]
            logger.info(
                "[ToolEmbedding][SYSTEM] 平台级搜索 embedding: query_len=%d", len(query),
            )
        except Exception:
            logger.warning("[ToolEmbedding] 查询向量化失败", exc_info=True)
            return []

        max_distance = 1 - similarity_threshold

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

        tool_qs = RegisteredTool.objects.using(DB).filter(
            name__in=candidate_names, status="active",
        )
        if category:
            tool_qs = tool_qs.filter(category=category)
        if provider_id:
            tool_qs = tool_qs.filter(provider_id=provider_id)
        if domain:
            tool_qs = tool_qs.filter(domain=domain)

        tool_map = {t.name: t for t in tool_qs}

        ranked = sorted(
            (n for n in candidate_names if n in tool_map),
            key=lambda n: distance_map[n],
        )

        results = []
        for name in ranked[:top_k]:
            tool = tool_map[name]
            results.append({
                "tool": {
                    "id": str(tool.id),
                    "name": tool.name,
                    "display_name": tool.display_name,
                    "description": tool.description,
                    "category": tool.category,
                    "provider_id": tool.provider_id,
                    "domain": tool.domain,
                    "tags": tool.tags or [],
                    "interface_type": tool.interface_type,
                    "execution_target": tool.execution_target,
                    "risk_level": tool.risk_level,
                    "optional": tool.optional,
                    "source": tool.source,
                    "status": tool.status,
                },
                "score": round(1 - distance_map[name], 4),
            })

        return results

    # ── 清理 ────────────────────────────────────────────

    @staticmethod
    def remove_tool(tool_name: str) -> bool:
        from apps.capabilities.models import ToolEmbedding
        deleted, _ = ToolEmbedding.objects.using(DB).filter(tool_name=tool_name).delete()
        return deleted > 0


def build_content_text(
    tool_name: str,
    display_name: str,
    description: str,
    tags: Optional[List[str]] = None,
    category: str = "",
    provider_id: str = "",
    documentation: str = "",
) -> str:
    """拼接用于 embedding 的文本（同时被 RegisteredTool.content_for_embedding 引用）。"""
    parts = [tool_name, display_name]
    if description:
        parts.append(description)
    if tags:
        parts.append("tags: " + ", ".join(tags))
    if category:
        parts.append(f"category: {category}")
    if provider_id:
        parts.append(f"provider: {provider_id}")
    if documentation:
        from apps.capabilities.constants import MAX_DOC_FOR_EMBEDDING
        parts.append(documentation[:MAX_DOC_FOR_EMBEDDING])
    return " | ".join(parts)


# ── EQ-019: RegisteredTool post_delete 信号兜底 ────────────────────────────────
# 通过 Admin 或 ORM 直接删除 RegisteredTool 时自动清理对应的 ToolEmbedding，
# 防止 pgvector 索引膨胀（向量孤儿）。
# 注意：该信号在本模块被首次 import 时连接（通常由 tool_sync 在启动 3 秒后触发）。
# 测试场景中请在 setUp 中显式调用 _connect_registered_tool_signals() 以确保信号就绪。

def _cleanup_tool_embedding_on_delete(sender, instance, **kwargs):
    """RegisteredTool 删除时自动清理对应的 ToolEmbedding 记录，防止向量孤儿。"""
    try:
        deleted = ToolEmbeddingService.remove_tool(instance.name)
        if deleted:
            logger.info(
                "[ToolEmbedding] 随 RegisteredTool 删除清理向量: %s", instance.name,
            )
        else:
            logger.debug(
                "[ToolEmbedding] RegisteredTool 删除但无对应向量记录: %s", instance.name,
            )
    except Exception:
        logger.warning(
            "[ToolEmbedding] 清理向量失败 (工具: %s)", instance.name, exc_info=True,
        )


def _connect_registered_tool_signals():
    """连接 RegisteredTool post_delete 信号。模块加载时自动调用，测试中也可手动调用。"""
    try:
        from django.db.models.signals import post_delete
        from apps.capabilities.models import RegisteredTool
        post_delete.connect(
            _cleanup_tool_embedding_on_delete,
            sender=RegisteredTool,
            weak=False,
            dispatch_uid="tool_embedding.cleanup_on_registered_tool_delete",
        )
        logger.debug("[ToolEmbedding] post_delete 信号已连接 (RegisteredTool)")
    except Exception:
        logger.warning("[ToolEmbedding] post_delete 信号连接失败", exc_info=True)


_connect_registered_tool_signals()

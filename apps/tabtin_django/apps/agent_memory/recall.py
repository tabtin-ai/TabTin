"""Agent 记忆召回读取（ W5 终态清偿：从 TabMemo 迁入本领域）。

服务端内部管道的**多-agent、无当前登录 subject 上下文**读取入口——召回注入
（memory-injector）与 ``memory_search`` 工具的多-agent 读取都经此。与领域
``AgentMemoryService`` 的分工：

- ``AgentMemoryService``（services.py）：面板 / 治理面的**强隔离**读写，
  ``resolve_scope`` 强制 (organization, agent, subject) 三元组，subject 恒为
  当前登录用户。
- ``AgentMemoryRecall``（本模块）：按调用方解析出的 **agent 集合 + 显式 owner**
  圈定范围，供无「当前登录用户」上下文的服务端管道用。

统一经 ``AgentMemoryRepository.base_qs()`` 取数——AgentMemory 的唯一读写 seam，
禁止裸 ``AgentMemory.objects.*``。

历史：这些函数曾住在 ``apps.tabmemo.services.agent_memory_service``（ 分家
拆表的过渡兼容层）。#4118 W5 随 TabMemo 彻底解耦迁入本领域，TabMemo 从此只留
纯用户笔记路径，不再承载任何 Agent 记忆逻辑。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from apps.agent_memory.repository import AgentMemoryRepository
from apps.agent_memory.models import AgentMemory
from apps.agent_memory.search import apply_keyword_search, rank_by_search_score, read_score

logger = logging.getLogger(__name__)


class AgentMemoryRecall:
    """Agent 记忆召回读取（多 agent、按显式 owner 圈定，服务端内部管道用）。"""

    @staticmethod
    def resolve_recall_agent_ids(space_id) -> List[str]:
        """解析某 space 召回可见的 agent 集合（分家前后召回等价覆盖）。

        ：只并集该 workspace 历史会话直挂过的 ``ChatSession.agent_id``；
        不再读已删除的 ``Workspace.agent``。

        解析失败返回空列表（调用方按无记忆处理）。
        """
        if not space_id:
            return []
        agent_ids: set = set()
        try:
            from apps.chat.conversation.models import ChatSession

            for aid in (
                ChatSession.objects.filter(
                    workspace_id=space_id, agent_id__isnull=False,
                )
                .values_list("agent_id", flat=True)
                .distinct()
            ):
                agent_ids.add(str(aid))
        except Exception:
            logger.warning(
                "[AgentMemory] recall agent resolve (sessions) failed: %s",
                space_id, exc_info=True,
            )
        return sorted(agent_ids)

    @staticmethod
    def list_memories(
        *,
        agent_ids,
        organization_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        memo_type: str = "",
        status: str = "active",
        search: str = "",
        created_after: Optional[str] = None,
        created_before: Optional[str] = None,
        sort: str = "-created_at",
        cursor: str = "",
        limit: int = 30,
        for_recall: bool = False,
    ) -> Dict[str, Any]:
        """列出一组 Agent 的记忆（召回注入 / memory_search 工具）。

        ``agent_ids``：单个 id（str/UUID）或 id 集合。召回场景应传
        ``resolve_recall_agent_ids(space_id)`` 的结果——保证与分家前
        space 维度召回等价覆盖（含会话直挂分身的记忆）。

        ``organization_id`` 与 ``owner_id`` 都必须显式提供；无法确认
        subject 时返回空集，避免跨用户读取。

        返回 ``{"items": [dict...], "next_cursor": str, "has_more": bool}``。

        ``for_recall=True``（Agent 召回注入 / memory_search 工具）时命中行
        异步递增 access_count；用户 UI 浏览不传，不污染归档信号。
        """
        if not organization_id or not owner_id:
            return {"items": [], "next_cursor": "", "has_more": False}
        if isinstance(agent_ids, (str, bytes)) or not hasattr(agent_ids, "__iter__"):
            agent_ids = [agent_ids] if agent_ids else []
        agent_ids = [str(a) for a in agent_ids if a]
        if not agent_ids:
            return {"items": [], "next_cursor": "", "has_more": False}

        status_val = (
            AgentMemory.Status.ARCHIVED
            if status == "archived"
            else AgentMemory.Status.ACTIVE
        )
        qs = AgentMemoryRepository.base_qs().filter(
            organization_id=organization_id,
            agent_id__in=agent_ids,
            owner_id=owner_id,
            status=status_val,
            forgotten_at__isnull=True,
        )

        if memo_type:
            types = [
                t.strip() for t in memo_type.split(",")
                if t.strip() in set(AgentMemory.MemoType.values)
            ]
            if types:
                qs = qs.filter(memo_type__in=types)

        if created_after:
            qs = qs.filter(created_at__gte=created_after)
        if created_before:
            qs = qs.filter(created_at__lte=created_before)

        if sort not in {"-created_at", "created_at", "-updated_at", "updated_at"}:
            sort = "-created_at"
        qs = qs.order_by(sort, "id")

        offset = int(cursor) if cursor and cursor.isdigit() else 0
        limit = max(1, min(limit, 100))
        filtered = apply_keyword_search(qs, search) if search else qs
        if filtered is not qs:
            rows = rank_by_search_score(list(filtered), search)
            has_more = len(rows) > offset + limit
            rows = rows[offset : offset + limit]
        else:
            rows = list(qs[offset : offset + limit + 1])
            has_more = len(rows) > limit
            if has_more:
                rows = rows[:limit]
        next_cursor = str(offset + limit) if has_more else ""

        if for_recall and status_val == AgentMemory.Status.ACTIVE and rows:
            hit_ids = [str(r.id) for r in rows]
            try:
                from apps.services.agent_engine.tasks.memory.access_count import (
                    increment_access_count_task,
                )
                increment_access_count_task.delay(hit_ids)
            except Exception:
                logger.warning(
                    "[AgentMemory] access_count dispatch failed for %d rows",
                    len(hit_ids), exc_info=True,
                )

        return {
            "items": [AgentMemoryRecall.serialize(r) for r in rows],
            "next_cursor": next_cursor,
            "has_more": has_more,
        }

    @staticmethod
    def serialize(memory: AgentMemory) -> Dict[str, Any]:
        """序列化为召回条目 dict（含 Memo 兼容字段，供召回消费方复用）。

        ``score``： 统一检索层打分（命中的不同关键词个数）——只在
        ``search`` 分词非空时由 ``rank_by_search_score`` 写入；未搜索时为
        ``None``。调用方可用它做更严格的二次注入阈值判断。
        """
        return {
            "id": str(memory.id),
            "agent_id": str(memory.agent_id),
            "organization_id": str(memory.organization_id),
            "owner_id": str(memory.owner_id) if memory.owner_id else None,
            "memo_type": memory.memo_type,
            "title": memory.title or "",
            "content_json": memory.content_json or {},
            "content_plaintext": memory.content_plaintext,
            "content_markdown": memory.content_markdown,
            "importance": memory.importance,
            "access_count": memory.access_count,
            "tags": memory.tags or [],
            "ai_tags": memory.ai_tags or [],
            "source": "agent",
            "source_url": memory.source_url,
            "status": memory.status,
            "created_at": memory.created_at.isoformat() if memory.created_at else None,
            "updated_at": memory.updated_at.isoformat() if memory.updated_at else None,
            "score": read_score(memory),
        }


__all__ = ["AgentMemoryRecall"]

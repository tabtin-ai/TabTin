from __future__ import annotations

from typing import Any, Optional

from apps.agent_memory.models import AgentMemory
from apps.agent_memory.repository import AgentMemoryRepository


PORTRAIT_MEMORY_TYPES = (
    AgentMemory.MemoType.ABOUT_YOU,
    AgentMemory.MemoType.INSIGHT,
    AgentMemory.MemoType.DIARY,
)


class PortraitMemorySource:
    """Per-Agent input contract for the future per-Agent portrait model.

    The current UserPortrait row lacks an Agent dimension. Callers that cannot
    supply ``agent_id`` get no memory input rather than an unsafe cross-Agent
    aggregate.
    """

    @staticmethod
    def collect(
        *,
        organization_id: str,
        agent_id: Optional[str],
        subject_user_id: str,
        since: Optional[Any],
        limit: int,
    ) -> tuple[list[dict[str, Any]], int, int]:
        if not organization_id or not agent_id or not subject_user_id:
            return [], 0, 0

        queryset = AgentMemoryRepository.aggregate_scope(
            organization_id=organization_id,
            agent_id=agent_id,
            subject_user_id=subject_user_id,
        ).filter(
            status=AgentMemory.Status.ACTIVE,
            memo_type__in=PORTRAIT_MEMORY_TYPES,
        )
        if since:
            queryset = queryset.filter(created_at__gt=since)

        total = queryset.count()
        rows = list(
            queryset.order_by("-created_at").values(
                "id",
                "memo_type",
                "content_plaintext",
                "content_markdown",
                "created_at",
            )[:limit]
        )
        rows.reverse()
        return rows, total, max(0, total - len(rows))

    @staticmethod
    def has_new(
        *,
        organization_id: str,
        agent_id: Optional[str],
        subject_user_id: str,
        since: Optional[Any],
    ) -> bool:
        """是否存在可进入蒸馏 prompt 的新记忆（与 ``collect`` 空内容过滤一致）。"""
        if not organization_id or not agent_id or not subject_user_id:
            return False
        queryset = AgentMemoryRepository.aggregate_scope(
            organization_id=organization_id,
            agent_id=agent_id,
            subject_user_id=subject_user_id,
        ).filter(
            status=AgentMemory.Status.ACTIVE,
            memo_type__in=PORTRAIT_MEMORY_TYPES,
        )
        if since:
            queryset = queryset.filter(created_at__gt=since)
        for memo in queryset.only("content_plaintext", "content_markdown").iterator():
            content = memo.content_plaintext or memo.content_markdown or ""
            if content.strip():
                return True
        return False

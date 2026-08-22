"""
access_count — 异步递增 Agent 记忆的访问计数

当 MemoryInjection 注入记忆后，异步递增命中记忆行的 access_count 字段。

#3266 M4.5/C5：操作独立 AgentMemory 表（经 memory_constants 工厂路由）。
"""

from __future__ import annotations

import logging
from typing import List

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(
    ignore_result=True,
    time_limit=30,
    soft_time_limit=25,
)
def increment_access_count_task(memo_ids: List[str]) -> None:
    """批量递增 Memo 的 access_count 字段。"""
    if not memo_ids:
        return

    try:
        from django.db.models import F
        from apps.services.agent_engine.utils.memory_constants import get_memo_queryset
        from apps.agent_memory.models import AgentMemory

        updated = get_memo_queryset().filter(
            id__in=memo_ids,
            status=AgentMemory.Status.ACTIVE,
            forgotten_at__isnull=True,
        ).update(access_count=F("access_count") + 1)

        if updated:
            logger.info(
                "[AccessCount] Incremented %d/%d memos",
                updated, len(memo_ids),
            )
    except Exception as exc:
        logger.warning("[AccessCount] Task failed: %s", exc)

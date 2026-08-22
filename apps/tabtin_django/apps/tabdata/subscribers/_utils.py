"""订阅者共享工具函数 + 非 DDD 路径的副作用补偿函数。

Signal 删除后，非 DDD 路径（collab、undo_redo 等）需要主动调用
这些函数来触发之前由 Django signal 自动完成的副作用。
"""
from __future__ import annotations

import logging
from typing import Callable, List, Union
from uuid import UUID

from apps.tabdata.domain.events import DomainEventBase

logger = logging.getLogger(__name__)


def run_after_commit(callback: Callable[[], None]) -> None:
    """在 TABDATA 事务提交后执行回调；若不在事务内则立即执行。"""
    from django.db import connections, transaction
    from apps.tabdata.constants import TABDATA_DB_ALIAS

    if connections[TABDATA_DB_ALIAS].in_atomic_block:
        transaction.on_commit(callback, using=TABDATA_DB_ALIAS)
    else:
        callback()


def extract_record_ids(event: DomainEventBase) -> List[str]:
    """从事件中提取 record_id 列表。"""
    if hasattr(event, "record_id") and event.record_id is not None:
        return [str(event.record_id)]
    if hasattr(event, "records"):
        return [str(p.record_id) for p in event.records]
    return []


# ── 非 DDD 路径副作用补偿（替代已删除的 Django Signal） ────────────

def notify_record_changed_for_rag(table_id: Union[UUID, str], record_id: Union[UUID, str]) -> None:
    """记录数据变更后触发 RAG 索引排队。替代已删除的 auto_index_record signal。"""
    try:
        from django.conf import settings
        if not getattr(settings, 'RAG_ENABLED', False):
            return
        if not getattr(settings, 'RAG_AUTO_EMBED_RECORDS', False):
            return
        from apps.rag.signals import _debounce_record_index
        tid, rid = str(table_id), str(record_id)
        run_after_commit(lambda: _debounce_record_index(tid, rid))
    except Exception:
        logger.debug("RAG index notification skipped", exc_info=True)


def refresh_table_row_count(table_id: Union[UUID, str]) -> None:
    """原子刷新表行数。替代已删除的 update_table_record_count signal。"""
    try:
        from apps.tabdata.models import Table, TableRecord
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
            row_count=TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id, is_deleted=False,
            ).count()
        )
    except Exception:
        logger.warning("refresh_table_row_count failed table=%s", table_id, exc_info=True)

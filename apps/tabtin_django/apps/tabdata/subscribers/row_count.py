"""
RowCountSubscriber — 表格行数计数更新

提取自:
  - signals.py: update_table_record_count / decrease_table_record_count
  - record_service.py: _refresh_row_count_after_bulk

同步执行 (priority=20)，行数更新要先于前端推送。
"""

from __future__ import annotations

import logging
from typing import List

from apps.tabdata.domain.events import (
    DomainEventBase,
    RecordCreated,
    RecordDeleted,
    RecordsBatchCreated,
    RecordsBatchDeleted,
)
from apps.tabdata.domain.ports import IEventSubscriber

logger = logging.getLogger(__name__)


class RowCountSubscriber(IEventSubscriber):

    def handles(self) -> List[type]:
        return [RecordCreated, RecordDeleted, RecordsBatchCreated, RecordsBatchDeleted]

    def priority(self) -> int:
        return 20

    def handle(self, event: DomainEventBase) -> None:
        try:
            if isinstance(event, (RecordCreated, RecordDeleted,
                                  RecordsBatchCreated, RecordsBatchDeleted)):
                self._refresh_row_count(event.table_id)
        except Exception:
            logger.error(
                "[RowCountSubscriber] failed: table=%s event=%s",
                event.table_id, type(event).__name__, exc_info=True,
            )

    @staticmethod
    def _refresh_row_count(table_id) -> None:
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table, TableRecord

        try:
            Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
                row_count=TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id, is_deleted=False,
                ).count()
            )
        except Exception as exc:
            logger.warning(
                "[RowCountSubscriber] refresh failed: table=%s err=%s",
                table_id, exc,
            )

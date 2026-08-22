"""
ChangeLogSubscriber — VersionHistory + ChangeLog 写入
提取自 RecordService._trigger_record_change_log
同步执行 (priority=100)。实际写入在 on_commit 后执行。

W3.0 / D27：``run_after_commit`` 触发的回调不再 inline 执行 VH + ChangeLog
写入，而是 dispatch 给 Celery 任务（默认开启 ``TABDATA_BULK_UPDATE_ASYNC_COLLAB``
flag）。同步降级路径仍由 :func:`apps.tabdata.services.async_changelog.perform_changelog_write`
单源实现，保证两条路径行为完全一致。
"""
from __future__ import annotations

import logging
from typing import List, Optional

from apps.tabdata.domain.events import (
    ALL_RECORD_EVENTS, DomainEventBase,
    RecordCreated, RecordDeleted, RecordUpdated,
    RecordsBatchCreated, RecordsBatchDeleted, RecordsBatchUpdated,
)
from apps.tabdata.domain.ports import IEventSubscriber
from apps.tabdata.subscribers._utils import extract_record_ids, run_after_commit

logger = logging.getLogger(__name__)

_EVENT_CHANGE_TYPE = {
    RecordCreated: "create_record", RecordUpdated: "update_record",
    RecordDeleted: "delete_record",
    RecordsBatchCreated: "batch_create_records", RecordsBatchUpdated: "batch_update_records",
    RecordsBatchDeleted: "batch_delete_records",
}


class ChangeLogSubscriber(IEventSubscriber):

    def handles(self) -> List[type]:
        return list(ALL_RECORD_EVENTS)

    def priority(self) -> int:
        return 100

    def handle(self, event: DomainEventBase) -> None:
        try:
            change_type = _EVENT_CHANGE_TYPE.get(type(event), "update_record")
            table_id = str(event.table_id)
            record_ids = extract_record_ids(event)
            record_count = len(record_ids)
            user_id = event.triggered_by

            self._write_change_log(
                table_id=table_id,
                change_type=change_type,
                record_ids=record_ids,
                record_count=record_count,
                user_id=user_id,
            )
        except Exception:
            logger.error(
                "[ChangeLogSubscriber] failed: event=%s",
                type(event).__name__, exc_info=True,
            )

    @staticmethod
    def _write_change_log(
        *,
        table_id: str,
        change_type: str,
        record_ids: List[str],
        record_count: int,
        user_id: Optional[str],
    ) -> None:
        from apps.services.common.platform_context import (
            get_current_run_id, get_current_session_id,
        )
        from apps.tabdata.services.async_changelog import dispatch_collab_changelog

        agent_run_id = get_current_run_id() or ""
        session_id = get_current_session_id() or ""  # QC-05

        def _dispatch() -> None:
            dispatch_collab_changelog(
                table_id=table_id,
                change_type=change_type,
                record_ids=record_ids,
                record_count=record_count,
                user_id=user_id,
                agent_run_id=agent_run_id,
                session_id=session_id,
            )

        run_after_commit(_dispatch)

"""SchedulerSubscriber — Record 事件 → EventBus 桥接订阅者。

2026-05-28 收编：原实现把 record 事件投递到
``apps.tracker.tasks.process_table_event``（ScheduledJob.table_automation
子系统），现已改成直接 emit 到 EventBus（``tabdata.record.*``）。下游
Tracker.trigger_type='table_event' via apps/extensions/consumers.py
``_on_event_for_tracker`` 消费；EventBus.emit 内部异步分发，不阻塞
RecordService 写入主路径。

文件名 ``scheduler.py`` + 类名 ``SchedulerSubscriber`` 是历史命名遗留——
为减少 import 改动面本期不改名，语义已是"emit 到 EventBus"。
"""

from __future__ import annotations

import logging
from typing import List, Optional, Set

from apps.tabdata.domain.events import (
    ALL_RECORD_EVENTS,
    DomainEventBase,
    RecordCreated,
    RecordDeleted,
    RecordUpdated,
    RecordsBatchCreated,
    RecordsBatchDeleted,
    RecordsBatchUpdated,
)
from apps.tabdata.domain.ports import IEventSubscriber
from apps.tabdata.subscribers._utils import extract_record_ids, run_after_commit

logger = logging.getLogger(__name__)

_EVENT_TYPE_MAP = {
    RecordCreated: "record_created",
    RecordUpdated: "record_updated",
    RecordDeleted: "record_deleted",
    RecordsBatchCreated: "records_batch_created",
    RecordsBatchUpdated: "records_batch_updated",
    RecordsBatchDeleted: "records_batch_deleted",
}


class SchedulerSubscriber(IEventSubscriber):

    def handles(self) -> List[type]:
        return list(ALL_RECORD_EVENTS)

    def priority(self) -> int:
        return 200

    def handle(self, event: DomainEventBase) -> None:
        try:
            if isinstance(event, RecordsBatchUpdated):
                # W3.0 / D27：原实现 per-payload 注册 on_commit 回调（500 行 →
                # 500 个 callback × Table 单查询 = 阻塞）。改为 1 次 batch
                # on_commit 回调，内部 Table 查询只做一次，per-record emit
                # EventBus（同步入队，~0.3ms × 500 = 150ms 总耗时）。
                per_record_payloads = [
                    (str(p.record_id), set(p.changes.keys()))
                    for p in event.records
                    if set(p.changes.keys())  # 跳过无变化记录，与原 changed_ids 检查对齐
                ]
                if per_record_payloads:
                    self._batch_dispatch(
                        table_id=event.table_id,
                        per_record=per_record_payloads,
                        event_type="record_updated",
                    )
                return

            event_type = _EVENT_TYPE_MAP.get(type(event))
            if not event_type:
                return

            record_ids = extract_record_ids(event)
            changed_field_ids = self._extract_changed_field_ids(event)

            if not record_ids:
                return

            # 非 RecordsBatchUpdated 路径：所有记录 changed_field_ids 相同
            shared_changed = (
                list(changed_field_ids) if changed_field_ids else None
            )
            self._batch_dispatch(
                table_id=event.table_id,
                per_record=[
                    (rid, set(shared_changed) if shared_changed else None)
                    for rid in record_ids
                ],
                event_type=event_type,
            )
        except Exception:
            logger.error(
                "[SchedulerSubscriber] failed: event=%s",
                type(event).__name__, exc_info=True,
            )

    def _batch_dispatch(
        self,
        table_id,
        per_record: List,
        event_type: str,
    ) -> None:
        """W3.0 优化：N 个 per-record on_commit 合并为 1 个 batch on_commit。

        ``per_record`` 为 ``[(record_id, changed_field_ids|None), ...]``，
        回调内共享 1 次 ``Table`` 查询，per-record emit EventBus。
        """
        table_id_str = str(table_id)

        def _do_batch_dispatch() -> None:
            try:
                from apps.tabdata.models import Table
                from apps.tabdata.constants import TABDATA_DB_ALIAS
                from apps.tabdata.utils.scheduler_bridge import (
                    emit_record_event_to_eventbus,
                )

                table = Table.objects.using(TABDATA_DB_ALIAS).only(
                    "space_id", "organization_id",
                ).filter(id=table_id_str).first()
                if not table or not table.space_id:
                    return

                space_id_str = str(table.space_id)
                organization_id_str = (
                    str(table.organization_id) if table.organization_id else ""
                )

                for record_id, changed_field_ids in per_record:
                    try:
                        emit_record_event_to_eventbus(
                            table_id=table_id_str,
                            space_id=space_id_str,
                            event_type=event_type,
                            record_id=record_id,
                            changed_field_ids=changed_field_ids,
                            organization_id=organization_id_str,
                        )
                    except Exception:
                        logger.debug(
                            "[SchedulerSubscriber] per-record emit failed: "
                            "table=%s record=%s event=%s",
                            table_id_str, record_id, event_type, exc_info=True,
                        )
            except Exception:
                logger.debug(
                    "[SchedulerSubscriber] batch dispatch failed: table=%s event=%s",
                    table_id_str, event_type, exc_info=True,
                )

        run_after_commit(_do_batch_dispatch)

    @staticmethod
    def _extract_changed_field_ids(event: DomainEventBase) -> Optional[Set[str]]:
        if isinstance(event, RecordUpdated):
            return event.changed_field_ids or set()
        return None

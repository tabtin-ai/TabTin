"""
RealtimeSubscriber — WebSocket 实时推送 + Webhook 投递
提取自 RecordService._publish_table_event / _dispatch_webhook_event
同步执行 (priority=50)。实际发布延迟到事务提交后。
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

_EVENT_TO_ACTION = {
    RecordCreated: "create_record",
    RecordUpdated: "update_record",
    RecordDeleted: "delete_record",
    RecordsBatchCreated: "batch_create_records",
    RecordsBatchUpdated: "batch_update_records",
    RecordsBatchDeleted: "batch_delete_records",
}

_ACTION_TO_WEBHOOK_EVENT = {
    "create_record": "record.created",
    "update_record": "record.updated",
    "delete_record": "record.deleted",
    "batch_create_records": "record.batch_created",
    "batch_update_records": "record.batch_updated",
    "batch_delete_records": "record.batch_deleted",
}


class RealtimeSubscriber(IEventSubscriber):

    def handles(self) -> List[type]:
        return list(ALL_RECORD_EVENTS)

    def priority(self) -> int:
        return 50

    def handle(self, event: DomainEventBase) -> None:
        skip = getattr(event, "skip_flags", None) or {}
        if skip.get("ws_notification") or skip.get("table_event"):
            return

        try:
            action = _EVENT_TO_ACTION.get(type(event), "records_updated")
            table_id = str(event.table_id)
            record_ids = extract_record_ids(event)
            user_id = event.triggered_by

            rls_enabled = True
            space_id: Optional[str] = None
            try:
                from apps.tabdata.models import Table
                from apps.tabdata.constants import TABDATA_DB_ALIAS
                row = Table.objects.using(TABDATA_DB_ALIAS).filter(
                    id=table_id,
                ).values_list('rls_enabled', 'space_id').first()
                if row is not None:
                    rls_enabled = bool(row[0])
                    space_id = str(row[1]) if row[1] else None
            except Exception:
                logger.warning(
                    "[RealtimeSubscriber] Table 查询失败，fail-closed: table=%s",
                    table_id, exc_info=True,
                )

            self._publish_ws(
                table_id, record_ids, action, user_id,
                rls_enabled=rls_enabled,
            )
            self._dispatch_webhook(
                table_id, record_ids, action,
                rls_enabled=rls_enabled, space_id=space_id,
            )
        except Exception:
            logger.error(
                "[RealtimeSubscriber] failed: event=%s",
                type(event).__name__, exc_info=True,
            )

    # ------------------------------------------------------------------
    # WS 推送
    # ------------------------------------------------------------------

    @staticmethod
    def _publish_ws(
        table_id: str,
        record_ids: List[str],
        action: str,
        user_id: Optional[str],
        *,
        rls_enabled: bool,
    ) -> None:
        from apps.tabdata.services.table_event_service import table_event_service

        def _publish_after_commit() -> None:
            try:
                serialized_records: Optional[list] = None
                latest_version: Optional[int] = None
                _metadata: dict = {"user_id": user_id}

                if rls_enabled:
                    _metadata["rls_affected"] = True
                    _metadata["count"] = len(record_ids)
                    table_event_service.publish_table_update(
                        table_id=table_id,
                        record_ids=[],
                        action=action,
                        metadata=_metadata,
                    )
                    return

                if record_ids:
                    try:
                        from apps.tabdata.utils.record_serializers import serialize_records as _serialize_records_batch
                        from apps.tabdata.models import TableRecord
                        from apps.tabdata.constants import TABDATA_DB_ALIAS

                        orm_records = list(
                            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                                id__in=record_ids,
                            )
                        )
                        if orm_records:
                            serialized_records = _serialize_records_batch(
                                orm_records,
                                field_key_type='id',
                            )
                            versions = [int(getattr(r, 'version', 0) or 0) for r in orm_records]
                            if versions:
                                max_ver = max(versions)
                                try:
                                    from apps.tabdata.services.record_service import RecordService
                                    latest_version = RecordService._encode_monotonic_version_token(max_ver)
                                except Exception:
                                    latest_version = max_ver
                    except Exception as ser_exc:
                        logger.warning("[RealtimeSubscriber] 序列化增量记录失败，降级为纯通知: %s", ser_exc)

                table_event_service.publish_table_update(
                    table_id=table_id,
                    record_ids=record_ids,
                    action=action,
                    metadata=_metadata,
                    records=serialized_records,
                    latest_version=latest_version,
                )
            except Exception as exc:
                logger.warning("[RealtimeSubscriber] WS publish failed: %s", exc)

        run_after_commit(_publish_after_commit)

    # ------------------------------------------------------------------
    # Webhook
    # ------------------------------------------------------------------

    @staticmethod
    def _dispatch_webhook(
        table_id: str,
        record_ids: List[str],
        action: str,
        *,
        rls_enabled: bool,
        space_id: Optional[str],
    ) -> None:
        event_type = _ACTION_TO_WEBHOOK_EVENT.get(action)
        if not event_type:
            return

        def _dispatch_after_commit() -> None:
            if space_id is None:
                logger.warning(
                    "[RealtimeSubscriber] Webhook 跳过：space_id 未知，table=%s",
                    table_id,
                )
                return
            try:
                if rls_enabled:
                    data = {"action": action, "rls_affected": True}
                else:
                    data = {"record_ids": record_ids, "action": action}

                from apps.tabdata.tasks.webhook_tasks import deliver_webhook_event
                deliver_webhook_event.delay(
                    space_id=space_id,
                    event_type=event_type,
                    table_id=table_id,
                    data=data,
                )
            except Exception as exc:
                logger.warning("[RealtimeSubscriber] Webhook dispatch failed: %s", exc)

        run_after_commit(_dispatch_after_commit)

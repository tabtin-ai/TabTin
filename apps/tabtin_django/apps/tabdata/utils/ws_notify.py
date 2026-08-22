"""表格记录变更 WS/Webhook 通知工具。

从 RecordService._publish_table_event / _dispatch_webhook_event 提取。
所有调用方（reorder_records、record_replay_helper 等）改为直接使用此模块，
不再依赖 RecordService 实例方法。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from apps.tabdata.subscribers._utils import run_after_commit

logger = logging.getLogger(__name__)

_ACTION_TO_WEBHOOK_EVENT = {
    'create_record': 'record.created',
    'update_record': 'record.updated',
    'delete_record': 'record.deleted',
    'reorder_records': 'record.updated',
    'bulk_create': 'record.batch_created',
    'batch_create': 'record.batch_created',
    'batch_create_records': 'record.batch_created',
    'bulk_update': 'record.batch_updated',
    'batch_update': 'record.batch_updated',
    'batch_update_records': 'record.batch_updated',
    'bulk_delete': 'record.batch_deleted',
    'batch_delete': 'record.batch_deleted',
    'batch_delete_records': 'record.batch_deleted',
}


def publish_table_record_event(
    table_id,
    record_ids: List[str],
    action: str,
    records=None,
    user_id: Optional[str] = None,
) -> None:
    """发布表格记录变更事件到 WebSocket + Webhook（事务提交后执行）。"""
    table_id_str = str(table_id)
    record_ids_copy = list(record_ids)
    records_copy = list(records) if records else None

    def _after_commit() -> None:
        rls_enabled = True
        space_id: Optional[str] = None
        try:
            from apps.tabdata.models import Table
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            row = Table.objects.using(TABDATA_DB_ALIAS).filter(
                id=table_id_str,
            ).values_list('rls_enabled', 'space_id').first()
            if row is not None:
                rls_enabled = bool(row[0])
                space_id = str(row[1]) if row[1] else None
        except Exception:
            logger.warning(
                "[ws_notify] Table 查询失败，fail-closed: table=%s",
                table_id_str, exc_info=True,
            )

        _publish_ws(
            table_id_str, record_ids_copy, action, records_copy, user_id,
            rls_enabled=rls_enabled,
        )
        _dispatch_webhook(
            table_id_str, record_ids_copy, action,
            rls_enabled=rls_enabled, space_id=space_id,
        )

    run_after_commit(_after_commit)


def _publish_ws(
    table_id: str,
    record_ids: List[str],
    action: str,
    records,
    user_id: Optional[str],
    *,
    rls_enabled: bool,
) -> None:
    try:
        from apps.tabdata.services.table_event_service import table_event_service

        metadata: Dict[str, Any] = {"user_id": user_id}

        if rls_enabled:
            metadata["rls_affected"] = True
            metadata["count"] = len(record_ids)
            table_event_service.publish_table_update(
                table_id=table_id,
                record_ids=[],
                action=action,
                metadata=metadata,
                records=None,
                latest_version=None,
            )
            return

        serialized: Optional[List[Dict[str, Any]]] = None
        latest_version: Optional[int] = None

        if records:
            try:
                from apps.tabdata.utils.record_serializers import serialize_records
                serialized = serialize_records(
                    records, field_key_type='id',
                )
                versions = [int(getattr(r, 'version', 0) or 0) for r in records]
                if versions:
                    from apps.tabdata.services.view_version_sync import (
                        encode_monotonic_version_token,
                    )
                    latest_version = encode_monotonic_version_token(max(versions))
            except Exception as exc:
                logger.warning("序列化增量记录失败，降级为纯通知: %s", exc)

        table_event_service.publish_table_update(
            table_id=table_id,
            record_ids=record_ids,
            action=action,
            metadata=metadata,
            records=serialized,
            latest_version=latest_version,
        )
    except Exception as exc:
        logger.warning("WS publish failed: %s", exc)


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
    if space_id is None:
        logger.warning("[ws_notify] Webhook 跳过：space_id 未知，table=%s", table_id)
        return
    try:
        payload: Dict[str, Any] = {'action': action}
        if rls_enabled:
            payload['rls_affected'] = True
            payload['count'] = len(record_ids)
        else:
            payload['record_ids'] = record_ids
        from apps.tabdata.tasks.webhook_tasks import deliver_webhook_event
        deliver_webhook_event.delay(
            space_id=space_id,
            event_type=event_type,
            table_id=table_id,
            data=payload,
        )
    except Exception as exc:
        logger.warning("Webhook dispatch failed: %s", exc)

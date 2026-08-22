"""
RecordHistorySubscriber — 记录操作历史写入

提取自 RecordService._emit_record_history_event / _defer_history
以及 signals.py: create_record_history / save_record_history

同步执行 (priority=10)，保证 Undo 数据完整。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from apps.tabdata.domain.events import (
    ALL_RECORD_EVENTS, DomainEventBase,
    RecordCreated, RecordDeleted, RecordUpdated,
    RecordsBatchCreated, RecordsBatchDeleted, RecordsBatchUpdated,
)
from apps.tabdata.domain.ports import IEventSubscriber

logger = logging.getLogger(__name__)


class _RecordStub:
    """Lightweight stand-in for TableRecord in batch history paths.

    Only exposes ``id``, ``pk``, and ``table_id`` — enough for
    RecordHistory/RecordHistoryItem FK assignment (via ``record_id``)
    and field-type-map lookup. Avoids loading N ORM objects from DB
    when the event already carries all needed identifiers.
    """

    __slots__ = ('id', 'pk', 'table_id')

    def __init__(self, id: UUID, table_id: UUID):
        self.id = self.pk = id
        self.table_id = table_id


def _resolve_editor_type(event: DomainEventBase) -> str:
    """根据领域事件上下文推断 editor_type: 'user' / 'agent' / 'system'。"""
    from apps.services.common.platform_context import get_current_run_id

    if get_current_run_id():
        return "agent"
    if event.triggered_by:
        return "user"
    return "system"

_DELETE_CHANGES = {"_deleted": {"old": False, "new": True}}


class RecordHistorySubscriber(IEventSubscriber):

    def handles(self) -> List[type]:
        return list(ALL_RECORD_EVENTS)

    def priority(self) -> int:
        return 10

    def handle(self, event: DomainEventBase) -> None:
        try:
            if isinstance(event, RecordCreated):
                self._emit(event.record_id, event, "create", {"data": event.after})
            elif isinstance(event, RecordUpdated):
                fc = {str(k): {"old": v.old, "new": v.new} for k, v in event.changes.items()}
                if fc:
                    self._emit(event.record_id, event, "update", fc)
            elif isinstance(event, RecordDeleted):
                # 记录删除已经不可恢复，ORM 行及其 FK 历史会一并物理清理。
                return
            elif isinstance(event, RecordsBatchDeleted):
                return
            elif isinstance(event, (RecordsBatchCreated, RecordsBatchUpdated)):
                self._handle_batch(event)
        except Exception:
            logger.error(
                "[RecordHistorySubscriber] 历史写入失败，数据可能丢失: event=%s, record_id=%s, action=%s",
                type(event).__name__,
                getattr(event, 'record_id', None) or getattr(getattr(event, 'record', None), 'id', None),
                getattr(event, 'action', None),
                exc_info=True,
            )

    @staticmethod
    def _resolve_run_session(event: DomainEventBase) -> tuple[str, str]:
        """优先取 DomainEvent 自身字段（未来可扩展），fallback 到 ContextVar。

        D8 / Wave 1.1：当前 DomainEventBase 不含 agent_run_id / session_id，
        Subscriber 从 ContextVar 兜底取值；若后续 events.py 扩展到事件载荷，
        本方法可顺势先读 event 字段（getattr fallback）保持向前兼容。
        """
        run_id = getattr(event, "agent_run_id", "") or ""
        session_id = getattr(event, "session_id", "") or ""
        if run_id and session_id:
            return run_id, session_id
        from apps.tabdata.history_events import _resolve_run_context
        ctx_run, ctx_sess = _resolve_run_context()
        return (run_id or ctx_run, session_id or ctx_sess)

    def _handle_batch(self, event: DomainEventBase) -> None:
        from apps.tabdata.history_events import RecordHistoryEvent
        from apps.tabdata.history_event_listeners import batch_write_record_histories

        items: List[RecordHistoryEvent] = []
        user = self._resolve_user(event.triggered_by)
        window_id = self._get_window_id()
        editor_type = _resolve_editor_type(event)
        table_id = event.table_id

        record_count = len(event.records)
        if record_count > 50:
            record_map = {
                p.record_id: _RecordStub(p.record_id, table_id)
                for p in event.records
            }
        else:
            record_map = self._bulk_load_records([p.record_id for p in event.records])

        op_group_id = getattr(event, 'operation_group_id', None)
        skip = getattr(event, 'skip_flags', None) or {}
        push_to_stack = not skip.get('skip_undo_stack', False)
        agent_run_id, session_id = self._resolve_run_session(event)

        for payload in event.records:
            record = record_map.get(payload.record_id)
            if record is None:
                continue
            if isinstance(event, RecordsBatchCreated):
                fc = {"data": payload.after}
                action = "create"
            elif isinstance(event, RecordsBatchUpdated):
                fc = {str(k): {"old": v.old, "new": v.new} for k, v in payload.changes.items()}
                if not fc:
                    continue
                action = "update"
            else:
                fc = _DELETE_CHANGES
                action = "delete"
            items.append(RecordHistoryEvent(
                record=record, action=action, field_changes=fc,
                user=user, window_id=window_id,
                operation_group_id=UUID(op_group_id) if op_group_id else None,
                push_to_stack=push_to_stack,
                editor_type=editor_type,
                agent_run_id=agent_run_id,
                session_id=session_id,
            ))

        if items:
            batch_write_record_histories(items)

    def _emit(self, record_id: UUID, event: DomainEventBase, action: str, fc: Dict[str, Any]) -> None:
        from apps.tabdata.history_events import emit_record_history_event
        from apps.tabdata.models import TableRecord
        from apps.tabdata.constants import TABDATA_DB_ALIAS

        record = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id=record_id).first()
        if record is None:
            logger.warning("[RecordHistorySubscriber] record not found: %s", record_id)
            return

        op_group_id = getattr(event, 'operation_group_id', None)
        skip = getattr(event, 'skip_flags', None) or {}
        push_to_stack = not skip.get('skip_undo_stack', False)
        agent_run_id, session_id = self._resolve_run_session(event)

        emit_record_history_event(
            record=record, action=action, field_changes=fc,
            user=self._resolve_user(event.triggered_by),
            window_id=self._get_window_id(),
            operation_group_id=UUID(op_group_id) if op_group_id else None,
            push_to_stack=push_to_stack,
            editor_type=_resolve_editor_type(event),
            agent_run_id=agent_run_id,
            session_id=session_id,
            sender=self.__class__,
        )

    @staticmethod
    def _bulk_load_records(record_ids: List[UUID]) -> Dict[UUID, Any]:
        from apps.tabdata.models import TableRecord
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id__in=record_ids)
        return {r.id: r for r in qs}

    @staticmethod
    def _resolve_user(user_id: Optional[str]) -> Any:
        if not user_id:
            return None
        try:
            from django.contrib.auth import get_user_model
            return get_user_model().objects.filter(id=user_id).first()
        except Exception:
            return None

    @staticmethod
    def _get_window_id() -> Optional[str]:
        from apps.tabdata.request_context import get_current_window_id
        return get_current_window_id()

"""
RAGIndexSubscriber — RAG 记录索引触发
提取自 rag/signals.py 和 record_service._trigger_rag_after_bulk
after_commit → Celery 模式 (priority=200)。
"""
from __future__ import annotations

import logging
from typing import List

from apps.tabdata.domain.events import (
    ALL_RECORD_EVENTS, DomainEventBase,
    RecordCreated, RecordDeleted, RecordUpdated,
    RecordsBatchCreated, RecordsBatchDeleted, RecordsBatchUpdated,
)
from apps.tabdata.domain.ports import IEventSubscriber
from apps.tabdata.subscribers._utils import run_after_commit

logger = logging.getLogger(__name__)


def _should_log_exc(exc: BaseException) -> bool:
    from apps.maintenance.celery_utils import is_broker_connection_error
    return not is_broker_connection_error(exc)


class RAGIndexSubscriber(IEventSubscriber):

    def handles(self) -> List[type]:
        return list(ALL_RECORD_EVENTS)

    def priority(self) -> int:
        return 200

    def handle(self, event: DomainEventBase) -> None:
        try:
            if isinstance(event, (RecordCreated, RecordUpdated)):
                self._index_single(event)
            elif isinstance(event, RecordDeleted):
                self._delete_single(event)
            elif isinstance(event, (RecordsBatchCreated, RecordsBatchUpdated)):
                self._index_batch(event)
            elif isinstance(event, RecordsBatchDeleted):
                self._delete_batch(event)
        except Exception:
            logger.error(
                "[RAGIndexSubscriber] failed: event=%s",
                type(event).__name__, exc_info=True,
            )

    def _index_single(self, event: DomainEventBase) -> None:
        record_id = str(event.record_id)
        table_id = str(event.table_id)

        def _do_index() -> None:
            if not self._is_rag_enabled():
                return
            try:
                from apps.rag.signals import _debounce_record_index
                _debounce_record_index(table_id, record_id)
            except Exception as exc:
                if _should_log_exc(exc):
                    logger.warning(
                        "[RAGIndexSubscriber] index failed: record=%s",
                        record_id, exc_info=True,
                    )

        run_after_commit(_do_index)

    def _delete_single(self, event: RecordDeleted) -> None:
        record_id = str(event.record_id)

        def _do_delete() -> None:
            if not self._is_rag_enabled():
                return
            try:
                from apps.rag.tasks import _async_delete_record_index
                _async_delete_record_index.delay(record_id)
            except Exception as exc:
                if _should_log_exc(exc):
                    logger.warning(
                        "[RAGIndexSubscriber] delete failed: record=%s",
                        record_id, exc_info=True,
                    )

        run_after_commit(_do_delete)

    def _index_batch(self, event: DomainEventBase) -> None:
        table_id = str(event.table_id)

        def _do_index() -> None:
            if not self._is_rag_enabled():
                return
            try:
                from apps.rag.tasks import index_table_records_task
                index_table_records_task.apply_async(
                    args=[table_id], kwargs={"force": False}, countdown=5,
                )
            except Exception as exc:
                if _should_log_exc(exc):
                    logger.warning(
                        "[RAGIndexSubscriber] batch index failed: table=%s",
                        table_id, exc_info=True,
                    )

        run_after_commit(_do_index)

    def _delete_batch(self, event: RecordsBatchDeleted) -> None:
        record_ids = [str(p.record_id) for p in event.records]

        def _do_delete() -> None:
            if not self._is_rag_enabled():
                return
            try:
                from apps.rag.tasks import _async_delete_record_index
                for rid in record_ids:
                    _async_delete_record_index.delay(rid)
            except Exception as exc:
                if _should_log_exc(exc):
                    logger.warning(
                        "[RAGIndexSubscriber] batch delete failed: table=%s",
                        event.table_id, exc_info=True,
                    )

        run_after_commit(_do_delete)

    @staticmethod
    def _is_rag_enabled() -> bool:
        from django.conf import settings
        return (
            getattr(settings, "RAG_ENABLED", True)
            and getattr(settings, "RAG_AUTO_EMBED_RECORDS", True)
        )

"""#4805 / ：批量删除逐条 savepoint 与显式删除优先语义。

用内存模拟 UoW savepoint 回滚，避免依赖本机 test_tabtin_single 建库状态。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable, List, Optional, TypeVar
from unittest.mock import MagicMock
from uuid import UUID, uuid4

from django.test import SimpleTestCase

from apps.tabdata.domain.value_objects import RecordCommandContext, RecordSnapshot
from apps.tabdata.handlers.batch_delete_records import BatchDeleteRecordsHandler

T = TypeVar("T")


class _SavepointUnitOfWork:
    """模拟 Django nested atomic：savepoint 失败时回滚本段副作用。"""

    def __init__(self, soft_deleted: List[UUID]):
        self._soft_deleted = soft_deleted

    def with_transaction(self, work: Callable[[], T]) -> T:
        return work()

    def with_savepoint(self, work: Callable[[], T]) -> T:
        snapshot = list(self._soft_deleted)
        try:
            return work()
        except Exception:
            self._soft_deleted[:] = snapshot
            raise


class TestBatchDeleteSavepoint4805(SimpleTestCase):
    def _snapshot(self, *, record_id: UUID, table_id: UUID, version: int = 2) -> RecordSnapshot:
        now = datetime.now(timezone.utc)
        return RecordSnapshot(
            id=record_id,
            table_id=table_id,
            formatted_data={"标题": "x"},
            version=version,
            created_by="user-1",
            updated_by="user-1",
            created_at=now,
            updated_at=now,
        )

    def _build_handler(
        self,
        *,
        soft_deleted: List[UUID],
        native_io: MagicMock,
        records: dict,
    ) -> BatchDeleteRecordsHandler:
        repo = MagicMock()
        repo.next_version.return_value = 100
        repo.get_by_id.side_effect = lambda rid: records.get(UUID(str(rid)))
        repo.get_by_ids_for_update.side_effect = lambda ids: [
            records[rid] for rid in sorted(ids) if rid in records
        ]

        def delete(record_id):
            soft_deleted.append(UUID(str(record_id)))
            return True

        repo.delete.side_effect = delete

        handler = BatchDeleteRecordsHandler(
            record_repository=repo,
            native_io=native_io,
            unit_of_work=_SavepointUnitOfWork(soft_deleted),
            event_bus=MagicMock(),
            field_repository=MagicMock(),
            link_service=MagicMock(),
            cascade_service=MagicMock(),
            attachment_service=MagicMock(),
        )
        handler._prepare_native_io = MagicMock()
        handler._link_svc.cleanup_record_links.return_value = []
        handler._handle_cascade_after_delete = MagicMock()
        handler._should_publish_event = MagicMock(return_value=False)
        handler._publish_cross_table_ws = MagicMock()
        handler._build_link_affected_update_events = MagicMock(return_value=[])
        return handler

    def test_native_version_drift_does_not_block_explicit_delete(self):
        table_id = uuid4()
        ok_id = uuid4()
        conflict_id = uuid4()
        soft_deleted: List[UUID] = []
        records = {
            ok_id: self._snapshot(record_id=ok_id, table_id=table_id),
            conflict_id: self._snapshot(record_id=conflict_id, table_id=table_id),
        }

        native_io = MagicMock()

        def soft_delete_side_effect(*, record_id, version, updated_by=None):
            if version != 0:
                raise RuntimeError(
                    f"并发冲突：记录 {record_id} 版本已变更（期望 version={version}），删除被拒绝"
                )
            return True

        native_io.delete_record.side_effect = soft_delete_side_effect
        handler = self._build_handler(
            soft_deleted=soft_deleted,
            native_io=native_io,
            records=records,
        )

        context = RecordCommandContext(
            table_id=table_id,
            record_ids=[ok_id, conflict_id],
            user_id="user-1",
        )
        deleted_count, errors, deleted_ids, failed_ids = handler.handle(context)

        self.assertEqual(deleted_count, 2)
        self.assertEqual(errors, [])
        self.assertEqual(deleted_ids, [ok_id, conflict_id])
        self.assertEqual(failed_ids, [])
        self.assertEqual(soft_deleted, [ok_id, conflict_id])
        self.assertEqual(
            [call.kwargs["version"] for call in native_io.delete_record.call_args_list],
            [0, 0],
            "显式删除必须按记录 ID 清理原生投影，不能被内部版本漂移阻断",
        )
        handler._repo.mark_delete_version.assert_called_once_with(table_id, 100)

    def test_version_consistent_batch_deletes_all(self):
        table_id = uuid4()
        ids = [uuid4() for _ in range(3)]
        soft_deleted: List[UUID] = []
        records = {
            rid: self._snapshot(record_id=rid, table_id=table_id, version=1)
            for rid in ids
        }
        native_io = MagicMock()
        native_io.delete_record.return_value = True
        handler = self._build_handler(
            soft_deleted=soft_deleted,
            native_io=native_io,
            records=records,
        )

        context = RecordCommandContext(
            table_id=table_id,
            record_ids=ids,
            user_id="user-1",
        )
        deleted_count, errors, deleted_ids, failed_ids = handler.handle(context)

        self.assertEqual(deleted_count, 3)
        self.assertEqual(errors, [])
        self.assertEqual(deleted_ids, ids)
        self.assertEqual(failed_ids, [])
        self.assertEqual(soft_deleted, ids)
        handler._repo.mark_delete_version.assert_called_once_with(table_id, 100)

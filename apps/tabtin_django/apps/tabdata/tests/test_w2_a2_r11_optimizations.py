"""Wave 2 单元测试：A2 batch update native SQL。

测试覆盖：
  A2-1: BatchUpdateRecordsHandler 三阶段流水线（validate → batch persist → cascade）
  A2-2: 批量 native SQL 写入路径验证
  A2-3: 部分成功语义（单条失败不影响整批）
"""

import uuid
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Set, Tuple
from unittest.mock import MagicMock, call, patch

from django.test import SimpleTestCase

# ═══════════════════════════════════════════════════════════════════
# A2: BatchUpdateRecordsHandler 测试
# ═══════════════════════════════════════════════════════════════════


def _make_field_schema(fid: str, field_type: str = 'singleLineText', **kwargs) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.UUID(fid),
        field_type=field_type,
        name=f'field_{fid[:8]}',
        is_primary=kwargs.get('is_primary', False),
        config=kwargs.get('config', {}),
    )


def _make_snapshot(rid: uuid.UUID, table_id: uuid.UUID, data: dict, version: int = 1):
    from datetime import datetime, timezone as tz
    return SimpleNamespace(
        id=rid,
        table_id=table_id,
        formatted_data=data,
        version=version,
        created_by='user1',
        updated_by='user1',
        created_at=datetime.now(tz.utc),
        updated_at=datetime.now(tz.utc),
        is_deleted=False,
        order_value=1.0,
        clone_data=lambda: dict(data),
    )


def _make_event(changed_field_ids: list, record_id: Optional[uuid.UUID] = None):
    return SimpleNamespace(
        changed_field_ids=frozenset(changed_field_ids),
        record_id=record_id or uuid.uuid4(),
        before={},
        after={},
        changes={fid: {"old": None, "new": None} for fid in changed_field_ids},
    )


class TestBatchUpdateHandlerA2(SimpleTestCase):
    """A2: BatchUpdateRecordsHandler 三阶段流水线。"""

    def _build_handler(self):
        from apps.tabdata.handlers.batch_update_records import BatchUpdateRecordsHandler

        handler = BatchUpdateRecordsHandler(
            record_repository=MagicMock(),
            native_io=MagicMock(),
            unit_of_work=MagicMock(),
            event_bus=MagicMock(),
            field_repository=MagicMock(),
            link_service=MagicMock(),
            cascade_service=MagicMock(),
            attachment_service=MagicMock(),
        )
        handler._uow.with_transaction.side_effect = lambda fn: fn()
        handler._uow.with_savepoint.side_effect = lambda fn: fn()
        return handler

    def test_a2_1_empty_input(self):
        handler = self._build_handler()
        ctx = SimpleNamespace(
            table_id=uuid.uuid4(),
            records_data=[],
            user_id='user1',
            skip_flags=None,
            operation_group_id=None,
            should_skip=lambda x: False,
        )
        snapshots, errors = handler.handle(ctx)
        self.assertEqual(snapshots, [])
        self.assertEqual(len(errors), 1)

    @patch('apps.tabdata.handlers.batch_update_records.TableRecord')
    @patch('apps.tabdata.handlers.batch_update_records.python_to_pg')
    def test_a2_2_native_bulk_called(self, mock_pg, mock_tr_cls):
        handler = self._build_handler()
        table_id = uuid.uuid4()
        rid1 = uuid.uuid4()
        fid = str(uuid.uuid4())

        fields = [_make_field_schema(fid)]
        handler._field_repo.get_fields.return_value = fields
        handler._repo.next_version.return_value = 10

        existing = _make_snapshot(rid1, table_id, {fid: 'old'}, version=9)
        handler._repo.get_by_id.return_value = existing

        updated = _make_snapshot(rid1, table_id, {fid: 'new'}, version=10)
        event = _make_event([fid])

        with patch('apps.tabdata.domain.aggregates.RecordAggregate.update', return_value=(updated, event)):
            mock_orm = MagicMock()
            mock_orm.id = rid1
            mock_tr_cls.objects.using.return_value.filter.return_value = [mock_orm]
            mock_pg.return_value = 'new_pg'

            ctx = SimpleNamespace(
                table_id=table_id,
                records_data=[{'record_id': str(rid1), 'data': {fid: 'new'}}],
                user_id='user1',
                skip_flags=None,
                operation_group_id=uuid.uuid4(),
                should_skip=lambda x: False,
            )
            with patch.object(handler, '_prepare_native_io'):
                snapshots, errors = handler.handle(ctx)

        self.assertEqual(len(snapshots), 1)
        handler._native_io.bulk_update_records.assert_called_once()

    def test_a2_3_cascade_aggregated(self):
        """级联调用聚合为单次而非 per-record。"""
        from contextlib import contextmanager

        handler = self._build_handler()
        table_id = uuid.uuid4()
        fid1 = str(uuid.uuid4())
        fid2 = str(uuid.uuid4())

        fields = [_make_field_schema(fid1), _make_field_schema(fid2)]
        handler._field_repo.get_fields.return_value = fields
        handler._repo.next_version.return_value = 12

        rid1, rid2 = uuid.uuid4(), uuid.uuid4()
        snap1 = _make_snapshot(rid1, table_id, {fid1: 'a'}, version=11)
        snap2 = _make_snapshot(rid2, table_id, {fid2: 'b'}, version=12)
        ev1 = _make_event([fid1])
        ev2 = _make_event([fid2])

        call_count = [0]
        original_get = handler._repo.get_by_id

        def _get_by_id(rid):
            call_count[0] += 1
            if rid == rid1:
                return _make_snapshot(rid1, table_id, {fid1: 'old1'}, version=10)
            return _make_snapshot(rid2, table_id, {fid2: 'old2'}, version=10)

        handler._repo.get_by_id.side_effect = _get_by_id

        update_results = [(snap1, ev1), (snap2, ev2)]
        update_call_idx = [0]

        def _mock_update(**kwargs):
            idx = update_call_idx[0]
            update_call_idx[0] += 1
            return update_results[idx]

        # L71 / W0-4 §3.3:`_handle_cascade_compute` 现在用 `with transaction.atomic(
        # savepoint=True)` 包裹 cascade 调用,SimpleTestCase 沙箱不允许真 DB 连接,
        # mock atomic 为 noop context manager 让 cascade mock 可被调用。
        @contextmanager
        def _noop_atomic(using=None, savepoint=True):
            yield

        with (
            patch('apps.tabdata.domain.aggregates.RecordAggregate.update', side_effect=_mock_update),
            patch('apps.tabdata.handlers.batch_update_records.TableRecord') as mock_tr,
            patch('apps.tabdata.handlers.batch_update_records.python_to_pg', return_value=None),
            patch.object(handler, '_prepare_native_io'),
            patch('apps.tabdata.handlers._base.transaction.atomic', _noop_atomic),
        ):
            mock_orm1, mock_orm2 = MagicMock(), MagicMock()
            mock_orm1.id, mock_orm2.id = rid1, rid2
            mock_tr.objects.using.return_value.filter.return_value = [mock_orm1, mock_orm2]

            ctx = SimpleNamespace(
                table_id=table_id,
                records_data=[
                    {'record_id': str(rid1), 'data': {fid1: 'a'}},
                    {'record_id': str(rid2), 'data': {fid2: 'b'}},
                ],
                user_id='user1',
                skip_flags=None,
                operation_group_id=uuid.uuid4(),
                should_skip=lambda x: False,
            )
            snapshots, errors = handler.handle(ctx)

        self.assertEqual(len(snapshots), 2)
        cascade_svc = handler._cascade_svc
        cascade_svc.propagate_cell_changes.assert_called_once()
        cascade_args = cascade_svc.propagate_cell_changes.call_args
        passed_record_ids = cascade_args.kwargs.get('record_ids', cascade_args[1].get('record_ids', []))
        self.assertEqual(len(passed_record_ids), 2)

    @patch('apps.tabdata.handlers.batch_update_records.TableRecord')
    @patch('apps.tabdata.handlers.batch_update_records.python_to_pg')
    def test_a2_4_batch_updated_event_publishes_for_rh(self, mock_pg, mock_tr_cls):
        """A2 Phase 3 之后 EventBus 发布 RecordsBatchUpdated，确保 RH 链路完整。

        验证：
        1. _event_bus.publish 被调用且事件类型为 RecordsBatchUpdated
        2. 事件包含正确的 records payload（changes 非空）
        3. RecordHistorySubscriber.handles() 覆盖 RecordsBatchUpdated
        """
        from apps.tabdata.domain.events import RecordsBatchUpdated
        from apps.tabdata.subscribers.record_history import RecordHistorySubscriber

        handler = self._build_handler()
        table_id = uuid.uuid4()
        rid1 = uuid.uuid4()
        fid = str(uuid.uuid4())

        fields = [_make_field_schema(fid)]
        handler._field_repo.get_fields.return_value = fields
        handler._repo.next_version.return_value = 10

        existing = _make_snapshot(rid1, table_id, {fid: 'old'}, version=9)
        handler._repo.get_by_id.return_value = existing
        updated = _make_snapshot(rid1, table_id, {fid: 'new'}, version=10)
        event = _make_event([fid])

        with (
            patch('apps.tabdata.domain.aggregates.RecordAggregate.update', return_value=(updated, event)),
            patch.object(handler, '_prepare_native_io'),
        ):
            mock_orm = MagicMock()
            mock_orm.id = rid1
            mock_tr_cls.objects.using.return_value.filter.return_value = [mock_orm]
            mock_pg.return_value = 'new_pg'

            ctx = SimpleNamespace(
                table_id=table_id,
                records_data=[{'record_id': str(rid1), 'data': {fid: 'new'}}],
                user_id='user1',
                skip_flags=None,
                operation_group_id=uuid.uuid4(),
                should_skip=lambda x: False,
            )
            handler.handle(ctx)

        handler._event_bus.publish.assert_called_once()
        published_event = handler._event_bus.publish.call_args[0][0]
        self.assertIsInstance(published_event, RecordsBatchUpdated)
        self.assertEqual(published_event.count, 1)
        self.assertEqual(len(published_event.records), 1)

        subscriber = RecordHistorySubscriber()
        self.assertIn(RecordsBatchUpdated, subscriber.handles())

    @patch('apps.tabdata.handlers.batch_update_records.python_to_pg')
    def test_deleted_record_is_dropped_before_native_write_and_event_publish(self, mock_pg):
        """#9698：ORM tombstone 抢先落库后，迟到的批量修改应整体舍弃。"""
        handler = self._build_handler()
        table_id = uuid.uuid4()
        record_id = uuid.uuid4()
        field_id = str(uuid.uuid4())
        fields = [_make_field_schema(field_id)]
        existing = _make_snapshot(record_id, table_id, {field_id: 'old'}, version=9)
        updated = _make_snapshot(record_id, table_id, {field_id: 'late'}, version=10)
        event = _make_event([field_id], record_id=record_id)

        handler._field_repo.get_fields.return_value = fields
        handler._repo.next_version.return_value = 10
        handler._repo.get_by_id.return_value = existing
        handler._handle_cascade_compute = MagicMock()
        handler._handle_batch_link_title = MagicMock()
        handler._publish_cross_table_ws = MagicMock()

        context = SimpleNamespace(
            table_id=table_id,
            records_data=[{
                'record_id': str(record_id),
                'data': {field_id: 'late'},
            }],
            user_id='user1',
            skip_flags=None,
            operation_group_id=uuid.uuid4(),
            should_skip=lambda _name: False,
        )

        with (
            patch('apps.tabdata.domain.aggregates.RecordAggregate.update', return_value=(updated, event)),
            patch.object(handler, '_prepare_native_io'),
            patch.object(handler, '_raw_orm_batch_update', return_value=set()),
        ):
            snapshots, errors = handler.handle(context)

        self.assertEqual(snapshots, [])
        self.assertEqual(errors, [])
        handler._native_io.bulk_update_records.assert_not_called()
        handler._event_bus.publish.assert_not_called()
        handler._handle_cascade_compute.assert_not_called()
        handler._handle_batch_link_title.assert_not_called()

    def test_a2_5_skip_record_history_independent_of_eventbus_rh(self):
        """_skip_record_history 仅阻止旧 post_save signal，不影响 EventBus RH 链路。

        Phase 3 事件链：RecordsBatchUpdated → RecordHistorySubscriber._handle_batch
        → batch_write_record_histories 完全通过 EventBus 分发，不检查 ORM 实例上
        的 _skip_record_history 标记。此测试验证该路径独立性。
        """
        from apps.tabdata.domain.events import RecordsBatchUpdated, RecordUpdatedPayload
        from apps.tabdata.subscribers.record_history import RecordHistorySubscriber

        subscriber = RecordHistorySubscriber()

        fid = str(uuid.uuid4())
        rid = uuid.uuid4()
        table_id = uuid.uuid4()
        change = SimpleNamespace(old='before', new='after')
        payload = RecordUpdatedPayload(
            record_id=rid,
            before={fid: 'before'},
            after={fid: 'after'},
            changes={fid: change},
        )
        from datetime import datetime, timezone as tz
        event = RecordsBatchUpdated(
            event_id=uuid.uuid4().hex,
            table_id=table_id,
            occurred_at=datetime.now(tz.utc),
            records=(payload,),
            count=1,
            triggered_by='user_1',
        )

        mock_record = MagicMock()
        mock_record.id = rid
        mock_record.table_id = table_id
        mock_record._skip_record_history = True

        with (
            patch.object(subscriber, '_bulk_load_records', return_value={rid: mock_record}),
            patch.object(subscriber, '_resolve_user', return_value=None),
            patch.object(subscriber, '_get_window_id', return_value=None),
            patch('apps.tabdata.subscribers.record_history._resolve_editor_type', return_value='user'),
            patch('apps.tabdata.history_event_listeners.batch_write_record_histories') as mock_batch_write,
        ):
            subscriber._handle_batch(event)

        mock_batch_write.assert_called_once()
        written_events = mock_batch_write.call_args[0][0]
        self.assertEqual(len(written_events), 1)
        self.assertEqual(written_events[0].action, 'update')

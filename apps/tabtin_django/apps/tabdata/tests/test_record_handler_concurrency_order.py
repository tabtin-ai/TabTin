"""#9698：DDD 记录写路径的生命周期锁与版本顺序回归。"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.domain.value_objects import (
    FieldSchema,
    RecordCommandContext,
    RecordSnapshot,
)
from apps.tabdata.exceptions import RecordVersionConflictError
from apps.tabdata.handlers.batch_delete_records import BatchDeleteRecordsHandler
from apps.tabdata.handlers.batch_update_records import BatchUpdateRecordsHandler
from apps.tabdata.handlers.create_record import CreateRecordHandler
from apps.tabdata.handlers.delete_record import DeleteRecordHandler
from apps.tabdata.handlers.update_record import UpdateRecordHandler
from apps.tabdata.infrastructure.django_field_repository import DjangoFieldRepository
from apps.tabdata.infrastructure.django_record_repository import DjangoRecordRepository


def _snapshot(*, record_id, table_id, version):
    now = datetime.now(timezone.utc)
    return RecordSnapshot(
        id=record_id,
        table_id=table_id,
        formatted_data={"title": f"v{version}"},
        version=version,
        created_by="user-1",
        updated_by="user-1",
        created_at=now,
        updated_at=now,
    )


def _handler(handler_cls):
    handler = handler_cls(
        record_repository=MagicMock(),
        native_io=MagicMock(),
        unit_of_work=MagicMock(),
        event_bus=MagicMock(),
        field_repository=MagicMock(),
        link_service=MagicMock(),
        cascade_service=MagicMock(),
        attachment_service=MagicMock(),
    )
    handler._prepare_native_io = MagicMock()
    handler._uow.with_transaction.side_effect = lambda work: work()
    handler._uow.with_savepoint.side_effect = lambda work: work()
    handler._should_publish_event = MagicMock(return_value=False)
    handler._publish_cross_table_ws = MagicMock()
    handler._build_link_affected_update_events = MagicMock(return_value=[])
    handler._handle_cascade_after_delete = MagicMock()
    handler._link_svc.cleanup_record_links.return_value = []
    return handler


class TestRepositoryDeleteGate(SimpleTestCase):
    @patch("apps.tabdata.infrastructure.django_record_repository.TableRecord.objects")
    def test_delete_is_one_atomic_active_row_delete(
        self,
        records,
    ):
        active_rows = records.using.return_value.filter.return_value
        active_rows.delete.side_effect = [(1, {}), (0, {})]
        repo = DjangoRecordRepository()
        record_id = uuid4()

        self.assertTrue(repo.delete(record_id))
        self.assertFalse(repo.delete(record_id))

        records.using.return_value.filter.assert_called_with(
            id=record_id,
            is_deleted=False,
        )
        self.assertEqual(active_rows.delete.call_count, 2)

    @patch("apps.tabdata.infrastructure.django_record_repository.TableRecord.objects")
    def test_batch_lifecycle_lock_has_deterministic_id_order(self, records):
        queryset = records.using.return_value.select_for_update.return_value
        filtered = queryset.filter.return_value
        filtered.order_by.return_value = []

        DjangoRecordRepository().get_by_ids_for_update([uuid4(), uuid4()])

        filtered.order_by.assert_called_once_with("id")

    @patch("apps.tabdata.infrastructure.django_record_repository.Table.objects")
    def test_table_fence_uses_select_for_update(self, tables):
        table_id = uuid4()
        locked = tables.using.return_value.select_for_update.return_value

        DjangoRecordRepository().lock_table(table_id)

        locked.only.return_value.get.assert_called_once_with(id=table_id)


class TestFieldChoiceRepository(SimpleTestCase):
    @patch("apps.tabdata.infrastructure.django_field_repository.TableField.objects")
    def test_merge_choices_locks_only_target_table_fields_in_id_order(self, fields):
        table_id = uuid4()
        field_id = uuid4()
        locked = fields.using.return_value.select_for_update.return_value
        filtered = locked.filter.return_value
        filtered.order_by.return_value = []

        DjangoFieldRepository().merge_select_choices(
            table_id,
            {str(field_id): ["doing"]},
        )

        locked.filter.assert_called_once_with(
            table_id=table_id,
            id__in=[str(field_id)],
            field_type__in=("select", "multi_select"),
            is_deleted=False,
        )
        filtered.order_by.assert_called_once_with("id")

    def test_field_schema_snapshot_keeps_validation_rules_for_locked_revalidation(self):
        field_id = uuid4()
        orm_field = MagicMock(
            id=field_id,
            name="数量",
            field_type="number",
            config={},
            is_primary=False,
            default_value=None,
            is_lookup=False,
            is_deleted=False,
            validation_rules={"max_value": 10},
        )

        schema = DjangoFieldRepository._orm_to_schema(orm_field)

        self.assertEqual(schema.validation_rules, {"max_value": 10})


class TestSingleDeleteOrdering(SimpleTestCase):
    def test_expected_version_is_checked_after_locks_before_any_write(self):
        table_id = uuid4()
        record_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        locked = _snapshot(record_id=record_id, table_id=table_id, version=6)
        calls = []
        handler = _handler(DeleteRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._repo.get_by_id_for_update.side_effect = lambda _rid: (
            calls.append("record") or locked
        )

        with self.assertRaises(RecordVersionConflictError) as raised:
            handler.handle(RecordCommandContext(
                table_id=table_id,
                record_id=record_id,
                user_id="user-1",
                expected_version=5,
            ))

        self.assertEqual(calls, ["table", "record"])
        self.assertEqual(raised.exception.record_id, record_id)
        self.assertEqual(raised.exception.expected_version, 5)
        handler._repo.next_version.assert_not_called()
        handler._repo.delete.assert_not_called()
        handler._native_io.delete_record.assert_not_called()
        handler._link_svc.cleanup_record_links.assert_not_called()
        handler._attachment_svc.cleanup_record_attachments.assert_not_called()
        handler._handle_cascade_after_delete.assert_not_called()
        handler._event_bus.publish.assert_not_called()
        handler._publish_cross_table_ws.assert_not_called()

    def test_matching_expected_version_keeps_delete_flow(self):
        table_id = uuid4()
        record_id = uuid4()
        existing = _snapshot(record_id=record_id, table_id=table_id, version=5)
        handler = _handler(DeleteRecordHandler)
        handler._repo.get_by_id.return_value = existing
        handler._repo.get_by_id_for_update.return_value = existing
        handler._repo.next_version.return_value = 6
        handler._repo.delete.return_value = True

        deleted = handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            user_id="user-1",
            expected_version=5,
        ))

        self.assertTrue(deleted)
        handler._repo.delete.assert_called_once_with(record_id)

    def test_link_and_attachment_cleanup_run_while_record_still_exists(self):
        table_id = uuid4()
        record_id = uuid4()
        existing = _snapshot(record_id=record_id, table_id=table_id, version=5)
        calls = []
        handler = _handler(DeleteRecordHandler)
        handler._repo.get_by_id.return_value = existing
        handler._repo.get_by_id_for_update.return_value = existing
        handler._repo.next_version.return_value = 6
        handler._link_svc.cleanup_record_links.side_effect = lambda _record: (
            calls.append("links") or []
        )
        handler._attachment_svc.cleanup_record_attachments.side_effect = lambda _record_id: (
            calls.append("attachments")
        )
        handler._repo.delete.side_effect = lambda _record_id: (
            calls.append("record") or True
        )

        self.assertTrue(handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            user_id="user-1",
        )))

        self.assertEqual(calls, ["links", "attachments", "record"])

    def test_loser_rolls_back_link_cleanup_and_does_not_publish_event(self):
        table_id = uuid4()
        record_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        locked = _snapshot(record_id=record_id, table_id=table_id, version=12)
        calls = []
        handler = _handler(DeleteRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._repo.get_by_id_for_update.side_effect = lambda _rid: (
            calls.append("record") or locked
        )
        handler._repo.next_version.side_effect = lambda *_args, **_kwargs: (
            calls.append("version") or 13
        )
        handler._repo.delete.return_value = False

        deleted = handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            user_id="user-2",
        ))

        self.assertFalse(deleted)
        self.assertEqual(calls, ["table", "record", "version"])
        handler._repo.delete.assert_called_once_with(record_id)
        handler._native_io.delete_record.assert_not_called()
        handler._link_svc.cleanup_record_links.assert_called_once_with(locked)
        handler._event_bus.publish.assert_not_called()

    def test_version_allocator_repairs_sequence_below_locked_record(self):
        handler = _handler(DeleteRecordHandler)
        handler._repo.next_version.side_effect = [8, 13]

        start, end = handler._allocate_versions_after(uuid4(), 12)

        self.assertEqual((start, end), (13, 13))
        self.assertEqual(
            [call.kwargs["count"] for call in handler._repo.next_version.call_args_list],
            [1, 5],
        )


class TestSingleUpdateExpectedVersion(SimpleTestCase):
    def test_expected_version_is_checked_after_table_and_record_locks_before_any_write(self):
        table_id = uuid4()
        record_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        locked = _snapshot(record_id=record_id, table_id=table_id, version=6)
        calls = []
        handler = _handler(UpdateRecordHandler)
        handler._apply_link_fields = MagicMock()
        handler._handle_link_title_propagation = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._repo.get_by_id.return_value = initial
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._repo.get_by_id_for_update.side_effect = lambda _rid: (
            calls.append("record") or locked
        )

        with self.assertRaises(RecordVersionConflictError) as raised:
            handler.handle(RecordCommandContext(
                table_id=table_id,
                record_id=record_id,
                data={"title": "stale update"},
                user_id="user-1",
                expected_version=5,
            ))

        self.assertEqual(calls, ["table", "record"])
        self.assertEqual(raised.exception.expected_version, 5)
        handler._field_repo.get_fields.assert_not_called()
        handler._repo.next_version.assert_not_called()
        handler._repo.update_one.assert_not_called()
        handler._field_repo.merge_select_choices.assert_not_called()
        handler._apply_link_fields.assert_not_called()
        handler._native_io.update_record.assert_not_called()
        handler._event_bus.publish.assert_not_called()
        handler._attachment_svc.sync_record_attachments.assert_not_called()
        handler._handle_link_title_propagation.assert_not_called()
        handler._handle_cascade_compute.assert_not_called()

    def test_table_fence_precedes_record_cas_and_select_field_write(self):
        table_id = uuid4()
        record_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        choice_values = {str(uuid4()): ["doing"]}
        calls = []
        handler = _handler(UpdateRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._repo.get_by_id_for_update.side_effect = lambda _rid: (
            calls.append("record") or initial
        )
        handler._allocate_versions_after = MagicMock(
            side_effect=lambda *_args: (calls.append("version") or (6, 6))
        )
        handler._field_repo.merge_select_choices.side_effect = lambda *_args: (
            calls.append("field")
        )
        handler._apply_link_fields = MagicMock(return_value=set())
        handler._handle_link_title_propagation = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._repo.update_one.return_value = True

        handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            data={"status": "doing"},
            user_id="user-1",
            expected_version=5,
            select_choice_values=choice_values,
        ))

        self.assertEqual(calls[:4], ["table", "record", "field", "version"])
        handler._field_repo.merge_select_choices.assert_called_once_with(
            table_id,
            choice_values,
        )

    def test_legacy_handler_context_without_raw_data_keeps_formatted_patch_compatibility(self):
        table_id = uuid4()
        record_id = uuid4()
        field_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        field = FieldSchema(
            id=field_id,
            name="数量",
            field_type="number",
            config={},
            db_field_name=field_id.hex,
        )
        handler = _handler(UpdateRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.get_by_id_for_update.return_value = initial
        handler._field_repo.get_fields.return_value = [field]
        handler._allocate_versions_after = MagicMock(return_value=(6, 6))
        handler._apply_link_fields = MagicMock(return_value=set())
        handler._handle_link_title_propagation = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._repo.update_one.return_value = True

        snapshot, error = handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            data={field_id.hex: 12.0},
            user_id="user-1",
        ))

        self.assertIsNone(error)
        self.assertEqual(snapshot.formatted_data[str(field_id)], 12.0)

    def test_schema_is_refreshed_after_table_and_record_locks(self):
        table_id = uuid4()
        record_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        calls = []
        handler = _handler(UpdateRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._repo.get_by_id_for_update.side_effect = lambda _rid: (
            calls.append("record") or initial
        )
        handler._field_repo.get_fields.side_effect = lambda _tid: (
            calls.append("fields") or []
        )
        handler._allocate_versions_after = MagicMock(return_value=(6, 6))
        handler._apply_link_fields = MagicMock(return_value=set())
        handler._handle_link_title_propagation = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._repo.update_one.return_value = True

        handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            data={"title": "after"},
            user_id="user-1",
        ))

        self.assertEqual(calls[:3], ["table", "record", "fields"])

    def test_invalid_raw_value_is_rejected_against_locked_schema_before_any_write(self):
        table_id = uuid4()
        record_id = uuid4()
        field_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        handler = _handler(UpdateRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.get_by_id_for_update.return_value = initial
        handler._field_repo.get_fields.return_value = [
            FieldSchema(
                id=field_id,
                name="数量",
                field_type="number",
                config={},
                db_field_name=field_id.hex,
            )
        ]
        context = RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            # 等锁前的旧 text schema 会把该值原样格式化。
            data={field_id.hex: "not-a-number"},
            raw_data={field_id.hex: "not-a-number"},
            user_id="user-1",
        )

        snapshot, error = handler.handle(context)

        self.assertIsNone(snapshot)
        self.assertIn("字段 '数量' 格式不符", error)
        handler._repo.next_version.assert_not_called()
        handler._repo.update_one.assert_not_called()
        handler._field_repo.merge_select_choices.assert_not_called()
        handler._native_io.update_record.assert_not_called()
        handler._event_bus.publish.assert_not_called()
        handler._attachment_svc.sync_record_attachments.assert_not_called()

    def test_raw_value_is_reformatted_once_for_orm_and_native_locked_schema(self):
        table_id = uuid4()
        record_id = uuid4()
        field_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        field = FieldSchema(
            id=field_id,
            name="数量",
            field_type="number",
            config={},
            db_field_name=field_id.hex,
        )
        handler = _handler(UpdateRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.get_by_id_for_update.return_value = initial
        handler._field_repo.get_fields.return_value = [field]
        handler._allocate_versions_after = MagicMock(return_value=(6, 6))
        handler._apply_link_fields = MagicMock(return_value=set())
        handler._handle_link_title_propagation = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._repo.update_one.return_value = True

        snapshot, error = handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            # 旧 text schema 的锁外结果不能再作为写入来源。
            data={field_id.hex: "0012"},
            raw_data={field_id.hex: "0012"},
            user_id="user-1",
        ))

        self.assertIsNone(error)
        self.assertEqual(snapshot.formatted_data[str(field_id)], 12.0)
        persisted_data = handler._repo.update_one.call_args.kwargs["data"]
        self.assertEqual(persisted_data[str(field_id)], 12.0)
        native_values = handler._native_io.update_record.call_args.kwargs["field_values"]
        self.assertEqual(native_values[field_id.hex], 12.0)

    def test_field_deleted_while_waiting_is_rejected_without_writing_unknown_key(self):
        table_id = uuid4()
        record_id = uuid4()
        deleted_field_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        handler = _handler(UpdateRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.get_by_id_for_update.return_value = initial
        handler._field_repo.get_fields.return_value = []

        snapshot, error = handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            data={deleted_field_id.hex: "old formatted value"},
            raw_data={deleted_field_id.hex: "user input"},
            user_id="user-1",
        ))

        self.assertIsNone(snapshot)
        self.assertIn("无有效字段匹配", error)
        handler._repo.next_version.assert_not_called()
        handler._repo.update_one.assert_not_called()
        handler._native_io.update_record.assert_not_called()

    def test_select_choices_are_recomputed_from_raw_value_and_locked_schema(self):
        table_id = uuid4()
        record_id = uuid4()
        field_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        handler = _handler(UpdateRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.get_by_id_for_update.return_value = initial
        handler._field_repo.get_fields.return_value = [
            FieldSchema(
                id=field_id,
                name="状态",
                field_type="select",
                config={"choices": []},
                db_field_name=field_id.hex,
            )
        ]
        handler._allocate_versions_after = MagicMock(return_value=(6, 6))
        handler._apply_link_fields = MagicMock(return_value=set())
        handler._handle_link_title_propagation = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._repo.update_one.return_value = True

        snapshot, error = handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            data={field_id.hex: "进行中"},
            raw_data={field_id.hex: "进行中"},
            user_id="user-1",
            # 事务外旧 schema 把该字段视为另一个 select；锁内必须忽略。
            select_choice_values={str(uuid4()): ["旧选项"]},
        ))

        self.assertIsNone(error)
        self.assertEqual(snapshot.formatted_data[str(field_id)], "进行中")
        handler._field_repo.merge_select_choices.assert_called_once_with(
            table_id,
            {str(field_id): ["进行中"]},
        )

    def test_locked_schema_last_modified_default_is_reapplied(self):
        table_id = uuid4()
        record_id = uuid4()
        title_field_id = uuid4()
        modified_field_id = uuid4()
        initial = _snapshot(record_id=record_id, table_id=table_id, version=5)
        handler = _handler(UpdateRecordHandler)
        handler._repo.get_by_id.return_value = initial
        handler._repo.get_by_id_for_update.return_value = initial
        handler._field_repo.get_fields.return_value = [
            FieldSchema(
                id=title_field_id,
                name="标题",
                field_type="text",
                config={},
                db_field_name=title_field_id.hex,
            ),
            FieldSchema(
                id=modified_field_id,
                name="最后修改时间",
                field_type="date",
                config={"formatting": {"time": "HH:mm:ss", "timeZone": "Asia/Shanghai"}},
                default_value={"mode": "last_modified_time"},
                db_field_name=modified_field_id.hex,
            ),
        ]
        handler._allocate_versions_after = MagicMock(return_value=(6, 6))
        handler._apply_link_fields = MagicMock(return_value=set())
        handler._handle_link_title_propagation = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._repo.update_one.return_value = True

        snapshot, error = handler.handle(RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            data={title_field_id.hex: "after"},
            raw_data={title_field_id.hex: "after"},
            user_id="user-1",
        ))

        self.assertIsNone(error)
        self.assertEqual(snapshot.formatted_data[str(title_field_id)], "after")
        self.assertIn(str(modified_field_id), snapshot.formatted_data)


class TestCreateWriteOrdering(SimpleTestCase):
    def test_create_locks_table_before_schema_field_write_and_version(self):
        table_id = uuid4()
        field_id = uuid4()
        calls = []
        handler = _handler(CreateRecordHandler)
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._field_repo.get_fields.side_effect = lambda _tid: (
            calls.append("fields") or []
        )
        handler._field_repo.merge_select_choices.side_effect = lambda *_args: (
            calls.append("field")
        )
        handler._repo.next_version.side_effect = lambda *_args, **_kwargs: (
            calls.append("version") or 1
        )
        handler._repo.insert.side_effect = lambda _snapshot: calls.append("record")
        handler._apply_link_fields = MagicMock(return_value=[])

        handler.handle(RecordCommandContext(
            table_id=table_id,
            data={str(field_id): "doing"},
            user_id="user-1",
            select_choice_values={str(field_id): ["doing"]},
        ))

        self.assertEqual(
            calls[:5],
            ["table", "fields", "version", "field", "record"],
        )
        handler._field_repo.merge_select_choices.assert_called_once_with(
            table_id,
            {str(field_id): ["doing"]},
        )


class TestBatchWriteOrdering(SimpleTestCase):
    def test_batch_update_locks_before_allocating_versions_above_current_rows(self):
        table_id = uuid4()
        ids = [uuid4(), uuid4()]
        snapshots = [
            _snapshot(record_id=ids[0], table_id=table_id, version=9),
            _snapshot(record_id=ids[1], table_id=table_id, version=10),
        ]
        calls = []
        handler = _handler(BatchUpdateRecordsHandler)
        handler._field_repo.get_fields.return_value = []
        handler._repo.get_by_ids.return_value = snapshots
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._repo.get_by_ids_for_update.side_effect = lambda _ids: (
            calls.append("record") or snapshots
        )
        handler._repo.next_version.side_effect = lambda *_args, **_kwargs: (
            calls.append("version") or 12
        )
        seen_versions = []
        handler._validate_single = MagicMock(
            side_effect=lambda *_args, version, **_kwargs: (
                seen_versions.append(version) or None
            ),
        )

        handler.handle(RecordCommandContext(
            table_id=table_id,
            records_data=[
                {"record_id": str(ids[0]), "data": {"title": "a"}},
                {"record_id": str(ids[1]), "data": {"title": "b"}},
            ],
            user_id="user-1",
        ))

        self.assertEqual(calls, ["table", "record", "version"])
        self.assertEqual(seen_versions, [11, 12])

    def test_batch_update_writes_choices_only_after_locked_record_is_validated(self):
        table_id = uuid4()
        record_id = uuid4()
        field_id = uuid4()
        snapshot = _snapshot(record_id=record_id, table_id=table_id, version=9)
        calls = []
        handler = _handler(BatchUpdateRecordsHandler)
        handler._field_repo.get_fields.return_value = []
        handler._repo.get_by_ids.return_value = [snapshot]
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._repo.get_by_ids_for_update.side_effect = lambda _ids: (
            calls.append("record") or [snapshot]
        )
        handler._allocate_versions_after = MagicMock(return_value=(10, 10))
        handler._validate_single = MagicMock(
            side_effect=lambda *_args, **_kwargs: calls.append("validate") or (
                snapshot,
                MagicMock(changed_field_ids=frozenset()),
                [],
            )
        )
        handler._field_repo.merge_select_choices.side_effect = lambda *_args: (
            calls.append("field")
        )
        handler._batch_persist = MagicMock(side_effect=lambda *_args: calls.append("write"))
        handler._handle_batch_link_title = MagicMock()
        handler._should_publish_event = MagicMock(return_value=False)

        handler.handle(RecordCommandContext(
            table_id=table_id,
            records_data=[{
                "record_id": str(record_id),
                "data": {str(field_id): "doing"},
            }],
            user_id="user-1",
            select_choice_values={str(field_id): ["doing"]},
        ))

        self.assertEqual(
            calls[:5],
            ["table", "record", "validate", "field", "write"],
        )

    def test_batch_update_rejects_invalid_raw_value_against_locked_schema_without_writes(self):
        table_id = uuid4()
        record_id = uuid4()
        field_id = uuid4()
        snapshot = _snapshot(record_id=record_id, table_id=table_id, version=9)
        handler = _handler(BatchUpdateRecordsHandler)
        handler._repo.get_by_ids.return_value = [snapshot]
        handler._repo.get_by_ids_for_update.return_value = [snapshot]
        handler._allocate_versions_after = MagicMock(return_value=(10, 10))
        handler._batch_persist = MagicMock()
        handler._field_repo.get_fields.return_value = [
            FieldSchema(
                id=field_id,
                name="数量",
                field_type="number",
                config={},
                db_field_name=field_id.hex,
            )
        ]

        snapshots, errors = handler.handle(RecordCommandContext(
            table_id=table_id,
            records_data=[{
                "record_id": str(record_id),
                # 锁外旧 text schema 的格式化结果。
                "data": {field_id.hex: "not-a-number"},
                "raw_data": {field_id.hex: "not-a-number"},
            }],
            user_id="user-1",
            select_choice_values={str(uuid4()): ["旧选项"]},
        ))

        self.assertEqual(snapshots, [])
        self.assertTrue(any("字段 '数量' 格式不符" in error for error in errors))
        handler._repo.next_version.assert_not_called()
        handler._field_repo.merge_select_choices.assert_not_called()
        handler._batch_persist.assert_not_called()
        handler._native_io.bulk_update_records.assert_not_called()
        handler._event_bus.publish.assert_not_called()

    def test_batch_update_reformats_raw_value_for_same_orm_and_native_number(self):
        table_id = uuid4()
        record_id = uuid4()
        field_id = uuid4()
        snapshot = _snapshot(record_id=record_id, table_id=table_id, version=9)
        handler = _handler(BatchUpdateRecordsHandler)
        handler._repo.get_by_ids.return_value = [snapshot]
        handler._repo.get_by_ids_for_update.return_value = [snapshot]
        handler._allocate_versions_after = MagicMock(return_value=(10, 10))
        handler._field_repo.get_fields.return_value = [
            FieldSchema(
                id=field_id,
                name="数量",
                field_type="number",
                config={},
                db_field_name=field_id.hex,
            )
        ]
        persisted = []

        def _persist(results, fields):
            persisted.extend(results)
            handler._native_io.bulk_update_records([{
                "__id": results[0][0].id,
                field_id.hex: results[0][0].formatted_data[str(field_id)],
            }])

        handler._batch_persist = MagicMock(side_effect=_persist)
        handler._handle_cascade_compute = MagicMock()
        handler._handle_batch_link_title = MagicMock()

        snapshots, errors = handler.handle(RecordCommandContext(
            table_id=table_id,
            records_data=[{
                "record_id": str(record_id),
                "data": {field_id.hex: "0012"},
                "raw_data": {field_id.hex: "0012"},
            }],
            user_id="user-1",
        ))

        self.assertEqual(errors, [])
        self.assertEqual(snapshots[0].formatted_data[str(field_id)], 12.0)
        self.assertEqual(persisted[0][0].formatted_data[str(field_id)], 12.0)
        native_row = handler._native_io.bulk_update_records.call_args.args[0][0]
        self.assertEqual(native_row[field_id.hex], 12.0)

    def test_batch_partial_success_does_not_merge_choices_from_failed_schema_row(self):
        table_id = uuid4()
        ok_record_id = uuid4()
        failed_record_id = uuid4()
        select_field_id = uuid4()
        number_field_id = uuid4()
        snapshots = [
            _snapshot(record_id=ok_record_id, table_id=table_id, version=8),
            _snapshot(record_id=failed_record_id, table_id=table_id, version=9),
        ]
        handler = _handler(BatchUpdateRecordsHandler)
        handler._repo.get_by_ids.return_value = snapshots
        handler._repo.get_by_ids_for_update.return_value = snapshots
        handler._allocate_versions_after = MagicMock(return_value=(10, 11))
        handler._field_repo.get_fields.return_value = [
            FieldSchema(
                id=select_field_id,
                name="状态",
                field_type="select",
                config={"choices": []},
                db_field_name=select_field_id.hex,
            ),
            FieldSchema(
                id=number_field_id,
                name="数量",
                field_type="number",
                config={},
                db_field_name=number_field_id.hex,
            ),
        ]
        handler._batch_persist = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._handle_batch_link_title = MagicMock()

        updated, errors = handler.handle(RecordCommandContext(
            table_id=table_id,
            records_data=[
                {
                    "record_id": str(ok_record_id),
                    "data": {select_field_id.hex: "进行中"},
                    "raw_data": {select_field_id.hex: "进行中"},
                },
                {
                    "record_id": str(failed_record_id),
                    "data": {number_field_id.hex: "失败选项"},
                    "raw_data": {number_field_id.hex: "失败选项"},
                },
            ],
            user_id="user-1",
            select_choice_values={str(number_field_id): ["失败选项"]},
        ))

        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0].id, ok_record_id)
        self.assertTrue(any("字段 '数量' 格式不符" in error for error in errors))
        handler._field_repo.merge_select_choices.assert_called_once_with(
            table_id,
            {str(select_field_id): ["进行中"]},
        )

    def test_batch_locked_schema_silently_drops_system_managed_input(self):
        table_id = uuid4()
        record_id = uuid4()
        title_field_id = uuid4()
        created_time_field_id = uuid4()
        snapshot = _snapshot(record_id=record_id, table_id=table_id, version=9)
        handler = _handler(BatchUpdateRecordsHandler)
        handler._repo.get_by_ids.return_value = [snapshot]
        handler._repo.get_by_ids_for_update.return_value = [snapshot]
        handler._allocate_versions_after = MagicMock(return_value=(10, 10))
        handler._field_repo.get_fields.return_value = [
            FieldSchema(
                id=title_field_id,
                name="标题",
                field_type="text",
                config={},
                db_field_name=title_field_id.hex,
            ),
            FieldSchema(
                id=created_time_field_id,
                name="创建时间",
                field_type="created_time",
                config={},
                db_field_name=created_time_field_id.hex,
            ),
        ]
        handler._batch_persist = MagicMock()
        handler._handle_cascade_compute = MagicMock()
        handler._handle_batch_link_title = MagicMock()

        updated, errors = handler.handle(RecordCommandContext(
            table_id=table_id,
            records_data=[{
                "record_id": str(record_id),
                "data": {title_field_id.hex: "after"},
                "raw_data": {
                    title_field_id.hex: "after",
                    created_time_field_id.hex: "client-overwrite",
                },
            }],
            user_id="user-1",
        ))

        self.assertEqual(errors, [])
        self.assertEqual(updated[0].formatted_data[str(title_field_id)], "after")
        self.assertNotIn(str(created_time_field_id), updated[0].formatted_data)

    def test_batch_delete_locks_all_rows_before_allocating_and_deleting(self):
        table_id = uuid4()
        ids = [uuid4(), uuid4()]
        snapshots = [
            _snapshot(record_id=ids[0], table_id=table_id, version=9),
            _snapshot(record_id=ids[1], table_id=table_id, version=10),
        ]
        calls = []
        handler = _handler(BatchDeleteRecordsHandler)
        handler._repo.lock_table.side_effect = lambda _tid: calls.append("table")
        handler._repo.get_by_ids_for_update.side_effect = lambda _ids: (
            calls.append("record") or snapshots
        )
        handler._repo.next_version.side_effect = lambda *_args, **_kwargs: (
            calls.append("version") or 12
        )
        handler._link_svc.cleanup_record_links.side_effect = lambda record: (
            calls.append(f"links:{record.id}") or []
        )
        handler._attachment_svc.cleanup_record_attachments.side_effect = lambda record_id: (
            calls.append(f"attachments:{record_id}")
        )
        handler._repo.delete.side_effect = lambda record_id: (
            calls.append(f"record:{record_id}") or True
        )

        deleted_count, errors, _, _ = handler.handle(RecordCommandContext(
            table_id=table_id,
            record_ids=ids,
            user_id="user-1",
        ))

        self.assertEqual(calls, [
            "table",
            "record",
            "version",
            f"links:{ids[0]}",
            f"attachments:{ids[0]}",
            f"record:{ids[0]}",
            f"links:{ids[1]}",
            f"attachments:{ids[1]}",
            f"record:{ids[1]}",
        ])
        self.assertEqual(deleted_count, 2)
        self.assertEqual(errors, [])
        self.assertEqual(
            [call.args[0] for call in handler._repo.delete.call_args_list],
            ids,
        )

"""#9698：删除优先（delete-wins）生命周期回归测试。"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.domain.value_objects import RecordCommandContext, RecordSnapshot
from apps.tabdata.handlers.batch_update_records import BatchUpdateRecordsHandler
from apps.tabdata.handlers.update_record import UpdateRecordHandler
from apps.tabdata.infrastructure.django_record_repository import DjangoRecordRepository
from apps.tabdata.services.collab_service import CollabService
from apps.tabdata.services.record_service import RecordService


class TestLateUpdateAfterDelete(SimpleTestCase):
    def test_single_update_is_discarded_before_side_effects_when_tombstone_wins(self):
        table_id = uuid4()
        record_id = uuid4()
        now = datetime.now(timezone.utc)
        existing = RecordSnapshot(
            id=record_id,
            table_id=table_id,
            formatted_data={"title": "before"},
            version=9,
            created_by="user-1",
            updated_by="user-1",
            created_at=now,
            updated_at=now,
        )
        updated = RecordSnapshot(
            id=record_id,
            table_id=table_id,
            formatted_data={"title": "late"},
            version=10,
            created_by="user-1",
            updated_by="user-1",
            created_at=now,
            updated_at=now,
        )
        event = MagicMock(changed_field_ids=frozenset({"title"}))

        handler = UpdateRecordHandler(
            record_repository=MagicMock(),
            native_io=MagicMock(),
            unit_of_work=MagicMock(),
            event_bus=MagicMock(),
            field_repository=MagicMock(),
            link_service=MagicMock(),
            cascade_service=MagicMock(),
            attachment_service=MagicMock(),
        )
        handler._repo.get_by_id.return_value = existing
        handler._repo.get_by_id_for_update.return_value = None
        handler._repo.next_version.return_value = 10
        handler._field_repo.get_fields.return_value = []
        handler._uow.with_transaction.side_effect = lambda work: work()
        handler._apply_link_fields = MagicMock(return_value=[])
        handler._prepare_native_io = MagicMock()

        with patch(
            "apps.tabdata.handlers.update_record.RecordAggregate.update",
            return_value=(updated, event),
        ):
            snapshot, error = handler.handle(RecordCommandContext(
                table_id=table_id,
                record_id=record_id,
                data={"title": "late"},
                user_id="user-1",
            ))

        self.assertIsNone(snapshot)
        self.assertIsNone(error)
        handler._native_io.update_record.assert_not_called()
        handler._event_bus.publish.assert_not_called()
        handler._attachment_svc.sync_record_attachments.assert_not_called()
        handler._apply_link_fields.assert_not_called()
        handler._repo.update_one.assert_not_called()

    @patch("apps.tabdata.handlers.RecordHandlerFactory.update_handler")
    @patch("apps.tabdata.services.record_service.Table.objects")
    @patch("apps.tabdata.services.record_service.TableRecord.objects")
    def test_record_service_returns_named_legacy_error_when_delete_wins(
        self,
        records,
        tables,
        update_handler,
    ):
        record_id = uuid4()
        table_id = uuid4()
        user = MagicMock(id=uuid4())
        active_record = MagicMock(id=record_id, table_id=table_id)
        table = MagicMock(id=table_id, organization_id=uuid4(), rls_enabled=False)
        deleter = MagicMock()
        deleter.get_display_name.return_value = "王小明"
        tombstone = MagicMock(updated_by=deleter)

        record_manager = records.using.return_value
        record_manager.get.return_value = active_record
        record_manager.select_related.return_value.filter.return_value.first.return_value = tombstone
        tables.using.return_value.get.return_value = table
        update_handler.return_value.handle.return_value = (None, None)

        service = RecordService(user=user)
        with (
            patch.object(service, "check_table_permission", return_value=True),
            patch.object(service, "_ensure_select_choices_from_data"),
            patch.object(service, "_find_system_managed_input_keys", return_value=[]),
            patch.object(service, "_validate_record_data", return_value=(True, None)),
            patch.object(service, "_format_record_data", return_value={"title": "late"}),
            patch(
                "apps.tabdata.services.record_service."
                "assert_organization_resource_write_allowed_optional",
            ),
            patch(
                "apps.tabdata.services.field_visibility.reject_invisible_field_writes",
                return_value=None,
            ),
            patch("apps.tabdata.utils.default_values.apply_record_defaults"),
        ):
            record, error = service.update_record(
                record_id,
                {"title": "late"},
                _preloaded_fields=[MagicMock()],
            )

        self.assertIsNone(record)
        self.assertEqual(
            error,
            "该记录已被王小明删除，您刚才的修改未保存",
        )


class TestRecordRepositoryTombstoneGate(SimpleTestCase):
    @patch("apps.tabdata.infrastructure.django_record_repository.TableRecord.objects")
    def test_update_one_only_updates_active_record(self, records):
        record_id = uuid4()
        active_rows = records.using.return_value.filter.return_value
        active_rows.update.return_value = 0

        updated = DjangoRecordRepository().update_one(
            record_id=record_id,
            data={"title": "late"},
            version=10,
            updated_by="user-1",
        )

        self.assertFalse(updated)
        records.using.return_value.filter.assert_called_once_with(
            id=record_id,
            is_deleted=False,
        )


class TestRestoreReusesRecordId(SimpleTestCase):
    @patch("apps.tabdata.infrastructure.get_event_bus")
    @patch("apps.tabdata.utils.record_data_access.read_data", return_value={"f1": "value"})
    @patch("apps.tabdata.services.record_replay_helper.replay_record_state")
    @patch("apps.tabdata.models.TableRecord.objects")
    @patch("apps.tabdata.services.record_service.Table.objects")
    def test_restore_replays_the_tombstone_with_its_original_id(
        self,
        tables,
        records,
        replay_record_state,
        _read_data,
        _event_bus,
    ):
        original_id = uuid4()
        tombstone = MagicMock(
            id=original_id,
            table_id=uuid4(),
            order=1.0,
            is_deleted=True,
        )
        records.using.return_value.select_for_update.return_value.get.return_value = tombstone
        tables.using.return_value.filter.return_value.values_list.return_value.first.return_value = uuid4()
        replay_record_state.return_value = MagicMock(changed=True, action="create")

        with (
            patch.object(RecordService, "check_table_permission", return_value=True),
            patch(
                "apps.tabdata.services.record_service."
                "assert_organization_resource_write_allowed_optional",
            ),
        ):
            service = RecordService(user=MagicMock(id="user-1"))
            restored, error = RecordService.restore_record.__wrapped__(
                service,
                original_id,
            )

        self.assertIsNone(error)
        self.assertIsNotNone(restored)
        replayed_record = replay_record_state.call_args.kwargs["record"]
        self.assertIs(replayed_record, tombstone)
        self.assertEqual(replayed_record.id, original_id)


class TestBatchUpdateTombstoneGate(SimpleTestCase):
    @patch("django.db.connections")
    def test_raw_batch_update_returns_only_active_rows(self, connections):
        table_id = uuid4()
        record_id = uuid4()
        now = datetime.now(timezone.utc)
        snapshot = RecordSnapshot(
            id=record_id,
            table_id=table_id,
            formatted_data={"title": "late"},
            version=10,
            created_by="user-1",
            updated_by="user-1",
            created_at=now,
            updated_at=now,
        )
        cursor = connections.__getitem__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchall.return_value = [(record_id,)]

        persisted_ids = BatchUpdateRecordsHandler._raw_orm_batch_update_sql([
            (snapshot, MagicMock()),
        ])

        self.assertEqual(persisted_ids, {record_id})
        sql = cursor.execute.call_args.args[0]
        self.assertIn("r.is_deleted = FALSE", sql)
        self.assertIn("RETURNING r.id", sql)


class TestCollabDeleteWins(SimpleTestCase):
    @patch("apps.tabdata.services.collab_service.TableRecord.objects")
    def test_collab_delete_creates_tombstone_before_unconditional_native_cleanup(
        self, records,
    ):
        table = MagicMock()
        record_id = uuid4()
        native_io = MagicMock()
        tombstone_created = False

        def create_tombstone(**_updates):
            nonlocal tombstone_created
            tombstone_created = True
            return 1

        records.using.return_value.filter.return_value.update.side_effect = create_tombstone

        def assert_tombstone_first(*_args, **kwargs):
            self.assertTrue(tombstone_created)
            self.assertEqual(kwargs["version"], 0)
            return True

        native_io.delete_record.side_effect = assert_tombstone_first

        deleted = CollabService._delete_active_record(
            table=table,
            record_id=record_id,
            tombstone_version=10,
            deleted_at=datetime.now(timezone.utc),
            deleted_by="user-1",
            native_io=native_io,
        )

        self.assertTrue(deleted)
        native_io.delete_record.assert_called_once()

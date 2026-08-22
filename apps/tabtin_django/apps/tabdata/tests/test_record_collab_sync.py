from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import RecordHistory, RecordHistoryItem, Table, TableField, TableRecord, TableView
from apps.tabdata.services.collab_service import CollabService, _derive_operation_group_id
from apps.tabdata.services.record_service import RecordService, _sync_records_to_ydoc
from apps.tabdata.utils.record_serializers import serialize_record
from apps.tabtinspace.models import Organization, Project

User = get_user_model()


class RecordCollabSyncTestCase(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        self.user = User.objects.create_user(
            username="record_collab_sync_user",
            email="record_collab_sync_user@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Record Collab Sync Organization",
            owner=self.user,
        )
        # ：Space 表已 DROP；Table.space_id 挂 Project.id
        self.space = Project.objects.create(
            name="Record Collab Sync Space",
            organization=self.organization,
        )
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="事务同步表",
            owner=self.user,
        )
        self.field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="标题",
            field_type="text",
            order=0,
        )
        self.record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field.id): "提交后再推"},
        )
        self.service = RecordService(user=self.user)

    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_sync_records_to_ydoc_defers_push_until_commit(self, mock_push_cells):
        with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=False) as callbacks:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                _sync_records_to_ydoc(
                    self.table.id,
                    [self.record],
                    [self.field],
                    source="create_record",
                )
                self.assertFalse(mock_push_cells.called)

        self.assertEqual(len(callbacks), 1)
        callbacks[0]()

        mock_push_cells.assert_called_once_with(
            table_id=self.table.id,
            changes=[
                {
                    "record_id": str(self.record.id),
                    "field_id_hex": self.field.id.hex,
                    "value": "提交后再推",
                }
            ],
            agent_id="system:create_record",
            editor_type="system",
        )

    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_sync_records_to_ydoc_pushes_null_for_cleared_hex_field(self, mock_push_cells):
        self.record.__dict__["data"] = {self.field.id.hex: None}
        self.record.save(update_fields=["data"])

        with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=False) as callbacks:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                _sync_records_to_ydoc(
                    self.table.id,
                    [self.record],
                    [self.field],
                    source="convert_field_type",
                )
                self.assertFalse(mock_push_cells.called)

        self.assertEqual(len(callbacks), 1)
        callbacks[0]()

        mock_push_cells.assert_called_once_with(
            table_id=self.table.id,
            changes=[
                {
                    "record_id": str(self.record.id),
                    "field_id_hex": self.field.id.hex,
                    "value": None,
                }
            ],
            agent_id="system:convert_field_type",
            editor_type="system",
        )

    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_sync_records_to_ydoc_ignores_unknown_null_fields(self, mock_push_cells):
        self.record.__dict__["data"] = {uuid4().hex: None}
        self.record.save(update_fields=["data"])

        with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=False) as callbacks:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                _sync_records_to_ydoc(
                    self.table.id,
                    [self.record],
                    [self.field],
                    source="convert_field_type",
                )

        self.assertEqual(callbacks, [])
        mock_push_cells.assert_not_called()

    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_sync_records_to_ydoc_upserts_restored_record(self, mock_push_cells):
        self.record.order = 7
        self.record.save(update_fields=["order"])

        with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=False) as callbacks:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                _sync_records_to_ydoc(
                    self.table.id,
                    [self.record],
                    [self.field],
                    upsert_record_ids=[str(self.record.id)],
                    source="undo",
                )
                self.assertFalse(mock_push_cells.called)

        self.assertEqual(len(callbacks), 1)
        callbacks[0]()

        mock_push_cells.assert_called_once_with(
            table_id=self.table.id,
            changes=[
                {
                    "record_id": str(self.record.id),
                    "type": "upsert_record",
                    "fields": {
                        self.field.id.hex: "提交后再推",
                    },
                    "order": 7.0,
                    "after_record_id": None,
                }
            ],
            agent_id="system:undo",
            editor_type="system",
        )

    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_sync_records_to_ydoc_pushes_precise_reorder_intent_after_commit(
        self,
        mock_push_cells,
    ):
        first = self.record
        second = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field.id): "第二行"},
            order=20,
        )
        first.order = 10
        first.save(update_fields=["order"])

        with (
            patch("apps.tabdata.utils.ydoc_sync.read_data") as mock_read_data,
            self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=False) as callbacks,
        ):
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                _sync_records_to_ydoc(
                    self.table.id,
                    [first, second],
                    fields=[],
                    reorder_record_ids=[str(first.id), str(second.id)],
                    source="reorder_records",
                )
                self.assertFalse(mock_push_cells.called)
            mock_read_data.assert_not_called()

        self.assertEqual(len(callbacks), 1)
        callbacks[0]()

        mock_push_cells.assert_called_once_with(
            table_id=self.table.id,
            changes=[
                {
                    "record_id": str(first.id),
                    "type": "reorder_record",
                    "order": 10.0,
                    "after_record_id": None,
                },
                {
                    "record_id": str(second.id),
                    "type": "reorder_record",
                    "order": 20.0,
                    "after_record_id": str(first.id),
                },
            ],
            agent_id="system:reorder_records",
            editor_type="system",
        )

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=0)
    def test_create_record_defers_side_effects_until_outer_commit(self):
        with (
            patch(
                "apps.tabdata.services.record_service.QuotaService",
                MagicMock(return_value=MagicMock(check_quota=MagicMock())),
            ),
            patch.object(RecordService, "_native_get_io", return_value=MagicMock()),
            patch(
                "apps.tabdata.infrastructure.native_io_adapter."
                "NativeRecordIOAdapter.insert_record",
                return_value=None,
            ),
            patch.object(RecordService, "_sync_attachments", return_value=None),
            patch("apps.tabdata.services.record_service.table_event_service.publish_table_update") as mock_publish,
            patch("apps.tabdata.services.collab_service.CollabService.push_cells") as mock_collab_push,
            patch("apps.tabdata.utils.scheduler_bridge.emit_record_event_to_eventbus") as mock_scheduler_delay,
        ):
            with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=False) as callbacks:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    result = self.service.create_record(
                        self.table.id,
                        {"标题": "外层事务创建"},
                    )
                    self.assertIsNotNone(result)
                    record, error = result
                    self.assertIsNone(error)
                    self.assertIsNotNone(record)

                    self.assertFalse(mock_publish.called)
                    self.assertFalse(mock_collab_push.called)
                    self.assertFalse(mock_scheduler_delay.called)

            self.assertGreaterEqual(len(callbacks), 4)
            for callback in callbacks:
                callback()

            mock_publish.assert_called_once()
            mock_collab_push.assert_called_once()
            mock_scheduler_delay.assert_called_once()

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.subscribers._utils.notify_record_changed_for_rag")
    @patch("apps.tabdata.subscribers._utils.refresh_table_row_count")
    def test_collab_persist_returns_system_time_cells(
        self,
        _refresh_row_count,
        _notify_rag,
        _native_io_cls,
        _publish_table_update,
    ):
        """系统时间字段（created_time/last_modified_time）值存系统列、不进 Y.Doc 用户 cell。
        persist 后须在 result.record_system_cells 按字段 hex 回写，供 collab-live 写进 Y.Doc，
        避免看板/grid 新建时创建时间「闪一下又消失」。"""
        created_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, name="创建时间", field_type="created_time", order=1,
        )
        modified_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, name="修改时间", field_type="last_modified_time", order=2,
        )
        new_id = uuid4()

        # 新建：created_time + last_modified_time 都回写
        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={str(new_id): {self.field.id.hex: "协作新增"}},
            deleted_record_ids=[],
            source="collab_persist",
        )
        cells = result.get("record_system_cells", {})
        self.assertIn(str(new_id), cells)
        self.assertIn(created_field.id.hex, cells[str(new_id)])
        self.assertIn(modified_field.id.hex, cells[str(new_id)])

        # 更新：仅刷新 last_modified_time，不回写 created_time（值不变）
        result2 = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {self.field.id.hex: "改一下"}},
            new_records={},
            deleted_record_ids=[],
            source="collab_persist",
        )
        cells2 = result2.get("record_system_cells", {})
        self.assertIn(str(self.record.id), cells2)
        self.assertIn(modified_field.id.hex, cells2[str(self.record.id)])
        self.assertNotIn(created_field.id.hex, cells2[str(self.record.id)])

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_collab_position_id_persists_and_clears_for_changed_record(
        self,
        native_io_cls,
        _publish_table_update,
    ):
        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {"__position_id": "p1:a0"}},
            new_records={},
            deleted_record_ids=[],
            source="collab_persist",
        )
        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.record.position_id, "p1:a0")
        native_io_cls.return_value.update_record.assert_called_once()

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {"__position_id": 42}},
            new_records={},
            deleted_record_ids=[],
            source="collab_persist",
        )
        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.record.position_id, "p1:a0")

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {"__position_id": "p2:not-supported"}},
            new_records={},
            deleted_record_ids=[],
            source="collab_persist",
        )
        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(self.record.position_id)

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {"__position_id": "p1:a0"}},
            new_records={},
            deleted_record_ids=[],
            source="collab_persist",
        )

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {"__position_id": None}},
            new_records={},
            deleted_record_ids=[],
            source="collab_persist",
        )
        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(self.record.position_id)

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.subscribers._utils.notify_record_changed_for_rag")
    @patch("apps.tabdata.subscribers._utils.refresh_table_row_count")
    def test_collab_position_id_persists_for_new_record(
        self,
        _refresh_row_count,
        _notify_rag,
        _native_io_cls,
        _publish_table_update,
    ):
        record_id = uuid4()
        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={str(record_id): {"__position_id": "p1:a1"}},
            deleted_record_ids=[],
            source="collab_persist",
        )

        record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id)
        self.assertEqual(record.position_id, "p1:a1")

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_collab_exact_legacy_order_persists_without_renumbering_untouched_rows(
        self,
        native_io_cls,
        _publish_table_update,
    ):
        self.record.order = 1000
        self.record.position_id = "p1:a0"
        self.record.save(
            using=TABDATA_DB_ALIAS,
            update_fields=["order", "position_id"],
        )
        untouched = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            order=2000,
            position_id="p1:a2",
        )

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={
                str(self.record.id): {
                    "__order": 2500.0,
                    "__position_id": "p1:a3",
                },
            },
            new_records={},
            deleted_record_ids=[],
            row_order=[str(untouched.id), str(self.record.id)],
            source="collab_persist",
        )

        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        untouched.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.record.order, 2500.0)
        self.assertEqual(self.record.position_id, "p1:a3")
        self.assertEqual(untouched.order, 2000.0)
        self.assertEqual(untouched.position_id, "p1:a2")
        native_io_cls.return_value.update_record.assert_called_with(
            self.record.id,
            field_values={},
            system_updates=self._system_updates_containing_order(2500.0),
        )

    def _system_updates_containing_order(self, order):
        """Match helper kept local to avoid coupling the assertion to timestamps."""
        from unittest.mock import ANY

        return {
            "__version": ANY,
            "__updated_at": ANY,
            "__updated_by": ANY,
            "__order": order,
        }

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.subscribers._utils.notify_record_changed_for_rag")
    @patch("apps.tabdata.subscribers._utils.refresh_table_row_count")
    def test_collab_new_record_prefers_explicit_legacy_order_over_row_order_spacing(
        self,
        _refresh_row_count,
        _notify_rag,
        _native_io_cls,
        _publish_table_update,
    ):
        record_id = uuid4()

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={
                str(record_id): {
                    "__order": 321.5,
                    "__position_id": "p1:a1",
                },
            },
            deleted_record_ids=[],
            row_order=[str(self.record.id), str(record_id)],
            source="collab_persist",
        )

        created = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id)
        self.assertEqual(created.order, 321.5)
        self.assertEqual(created.position_id, "p1:a1")

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_collab_row_order_clears_only_explicitly_invalidated_position_ids(
        self,
        _native_io_cls,
        _publish_table_update,
    ):
        second = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            order=1000,
            position_id="pos-second",
        )
        untouched = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            order=2000,
            position_id="pos-untouched",
        )
        self.record.position_id = "pos-first"
        self.record.save(using=TABDATA_DB_ALIAS, update_fields=["position_id"])

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {"__position_id": None}},
            new_records={},
            deleted_record_ids=[],
            row_order=[str(second.id), str(self.record.id)],
            source="legacy_collab_persist",
        )

        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        second.refresh_from_db(using=TABDATA_DB_ALIAS)
        untouched.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(self.record.position_id)
        self.assertEqual(second.position_id, "pos-second")
        self.assertEqual(untouched.position_id, "pos-untouched")

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_collab_row_order_invalidates_only_the_actual_moved_position_id(
        self,
        _native_io_cls,
        _publish_table_update,
    ):
        second = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            order=1000,
            position_id="p1:a2",
        )
        self.record.position_id = "p1:a1"
        self.record.save(using=TABDATA_DB_ALIAS, update_fields=["position_id"])

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={},
            deleted_record_ids=[],
            row_order=[str(second.id), str(self.record.id)],
            source="collab_persist",
        )

        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        second.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(self.record.position_id)
        self.assertEqual(second.position_id, "p1:a2")

        native_io_cls = _native_io_cls
        native_io_cls.return_value.read_records.return_value = ([
            {"__id": second.id, "__order": second.order, "__version": second.version},
            {"__id": self.record.id, "__order": self.record.order, "__version": self.record.version},
        ], 2)
        with patch("apps.tabdata.services.collab_service.DDLManager") as ddl_cls:
            ddl_cls.return_value.native_table_exists.return_value = True
            snapshot = CollabService.build_snapshot(self.table.id)
        self.assertNotIn("__position_id", snapshot["records"][str(self.record.id)])
        self.assertEqual(snapshot["records"][str(second.id)]["__position_id"], "p1:a2")

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_collab_row_order_keeps_explicit_position_id_update(
        self,
        _native_io_cls,
        _publish_table_update,
    ):
        second = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            order=1000,
        )
        self.record.position_id = "pos-before"
        self.record.save(using=TABDATA_DB_ALIAS, update_fields=["position_id"])

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {"__position_id": "p1:a3"}},
            new_records={},
            deleted_record_ids=[],
            row_order=[str(second.id), str(self.record.id)],
            source="collab_persist",
        )

        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.record.position_id, "p1:a3")

    @patch("apps.tabdata.services.collab_service.DDLManager")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_collab_snapshot_includes_non_null_position_id(self, native_io_cls, ddl_cls):
        self.record.position_id = "p1:a1"
        self.record.save(using=TABDATA_DB_ALIAS, update_fields=["position_id"])
        ddl_cls.return_value.native_table_exists.return_value = True
        native_io_cls.return_value.read_records.return_value = (
            [{
                "__id": self.record.id,
                "__order": 0,
                "__version": 1,
                self.field.id.hex: "提交后再接",
            }],
            1,
        )

        snapshot = CollabService.build_snapshot(self.table.id)

        self.assertEqual(
            snapshot["records"][str(self.record.id)]["__position_id"],
            "p1:a1",
        )

        self.record.position_id = "p2:not-supported"
        self.record.save(using=TABDATA_DB_ALIAS, update_fields=["position_id"])
        snapshot_with_invalid_position_id = CollabService.build_snapshot(self.table.id)
        self.assertNotIn(
            "__position_id",
            snapshot_with_invalid_position_id["records"][str(self.record.id)],
        )

        self.record.position_id = None
        self.record.save(using=TABDATA_DB_ALIAS, update_fields=["position_id"])
        snapshot_without_position_id = CollabService.build_snapshot(self.table.id)
        self.assertNotIn(
            "__position_id",
            snapshot_without_position_id["records"][str(self.record.id)],
        )

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_restore_snapshot_restores_position_id(self, _native_io_cls, _publish_table_update):
        snapshot = {
            "fields": [{"id": str(self.field.id), "id_hex": self.field.id.hex}],
            "records": {
                str(self.record.id): {
                    self.field.id.hex: "恢复后的值",
                    "__order": 4321.5,
                    "__position_id": "p1:a2",
                },
            },
            "row_order": [str(self.record.id)],
            "total_records": 1,
        }

        CollabService.restore_from_snapshot(self.table.id, snapshot)

        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.record.position_id, "p1:a2")
        self.assertEqual(self.record.order, 4321.5)

        snapshot["records"][str(self.record.id)]["__position_id"] = "p2:not-supported"
        CollabService.restore_from_snapshot(self.table.id, snapshot)
        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(self.record.position_id)

        snapshot["records"][str(self.record.id)].pop("__position_id")
        CollabService.restore_from_snapshot(self.table.id, snapshot)

        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(self.record.position_id)

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_restore_snapshot_inserts_empty_record_into_native_storage(
        self,
        native_io_cls,
        _publish_table_update,
    ):
        empty_record_id = uuid4()
        snapshot = {
            "fields": [{"id": str(self.field.id), "id_hex": self.field.id.hex}],
            "records": {
                str(self.record.id): {
                    self.field.id.hex: "提交后再接",
                    "__order": 1000,
                },
                str(empty_record_id): {
                    "__order": 2000,
                    "__position_id": "p1:a2",
                },
            },
            "row_order": [str(self.record.id), str(empty_record_id)],
            "total_records": 2,
        }

        with patch("apps.tabdata.utils.record_serializers.serialize_records", return_value=[]):
            CollabService.restore_from_snapshot(self.table.id, snapshot)

        restored = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=empty_record_id)
        self.assertEqual(restored.position_id, "p1:a2")
        native_io_cls.return_value.insert_record.assert_called_once_with(
            record_id=empty_record_id,
            field_values={},
            system_values={"__order": 2000.0, "__version": restored.version},
        )
        native_io_cls.return_value.read_records.return_value = ([
            {
                "__id": self.record.id,
                "__order": 1000.0,
                "__version": self.record.version,
            },
            {
                "__id": empty_record_id,
                "__order": 2000.0,
                "__version": restored.version,
            },
        ], 2)
        with patch("apps.tabdata.services.collab_service.DDLManager") as ddl_cls:
            ddl_cls.return_value.native_table_exists.return_value = True
            roundtrip = CollabService.build_snapshot(self.table.id)
        self.assertEqual(roundtrip["records"][str(empty_record_id)]["__position_id"], "p1:a2")

    def test_collab_position_id_is_hidden_from_rest_serializer(self):
        self.record.position_id = "pos-private"
        self.record.save(using=TABDATA_DB_ALIAS, update_fields=["position_id"])

        payload = serialize_record(self.record)

        self.assertNotIn("position_id", payload)
        self.assertNotIn("__position_id", payload["data"])
        self.assertNotIn("__position_id", payload["fields"])

    @patch("apps.tabdata.services.collab_service.connections")
    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_late_collab_update_reports_who_deleted_the_record(
        self,
        _native_io_cls,
        _publish_table_update,
        connections,
    ):
        # tombstone 不在 active ORM preload 中，会触发 native 孤儿探测；测试不创建
        # 物理 native 表，因此把只读取证结果固定为空，避免预期 SQL 错误污染外层事务。
        connections.__getitem__.return_value.cursor.return_value.__enter__.return_value.fetchall.return_value = []
        # 复用 setUp 已提交到双库测试现场的用户，避免额外 User 写入跨 alias
        # 事务后，FK 可见性差异污染本测试关注的 delete-wins 断言。
        deleter = self.user
        deleted_at = timezone.now()
        TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id=self.record.id).update(
            is_deleted=True,
            deleted_at=deleted_at,
            updated_by=deleter,
        )

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={str(self.record.id): {self.field.id.hex: "迟到修改"}},
            new_records={},
            deleted_record_ids=[],
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.user.id),
            record_editor_ids={str(self.record.id): str(self.user.id)},
        )

        self.assertEqual(result["persisted"], 0)
        self.assertEqual(result["discarded_record_updates"], [{
            "event_id": (
                f"{self.table.id}:{self.record.id}:"
                f"{deleted_at.isoformat()}:{self.user.id}"
            ),
            "record_id": str(self.record.id),
            "target_editor_id": str(self.user.id),
            "deleted_by_id": str(deleter.id),
            "deleted_by_name": "@record_collab_sync_user",
        }])

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.subscribers._utils.notify_record_changed_for_rag")
    @patch("apps.tabdata.subscribers._utils.refresh_table_row_count")
    def test_collab_create_discards_soft_deleted_id_without_blocking_healthy_sibling(
        self,
        _refresh_row_count,
        _notify_rag,
        native_io_cls,
        _publish_table_update,
    ):
        tombstone_id = uuid4()
        healthy_id = uuid4()
        TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            id=tombstone_id,
            table=self.table,
            data={self.field.id.hex: "已删除"},
            is_deleted=True,
            deleted_at=timezone.now(),
        )

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={
                str(tombstone_id): {self.field.id.hex: "协作残留"},
                str(healthy_id): {self.field.id.hex: "正常新增"},
            },
            deleted_record_ids=[],
            source="collab_persist",
        )

        self.assertEqual(result["created"], 1)
        self.assertEqual(result["discarded_new_record_ids"], [str(tombstone_id)])
        self.assertTrue(
            TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=tombstone_id).is_deleted
        )
        self.assertTrue(
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id=healthy_id,
                is_deleted=False,
            ).exists()
        )
        native_io_cls.return_value.insert_record.assert_called_once()
        self.assertEqual(
            native_io_cls.return_value.insert_record.call_args.args[0],
            healthy_id,
        )

    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_collab_create_returns_cleanup_ack_when_batch_only_contains_tombstone(
        self,
        native_io_cls,
    ):
        tombstone_id = uuid4()
        TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            id=tombstone_id,
            table=self.table,
            is_deleted=True,
            deleted_at=timezone.now(),
        )

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={str(tombstone_id): {self.field.id.hex: "协作残留"}},
            deleted_record_ids=[],
            source="collab_persist",
        )

        self.assertEqual(result["created"], 0)
        self.assertEqual(result["discarded_new_record_ids"], [str(tombstone_id)])
        native_io_cls.return_value.insert_record.assert_not_called()

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.subscribers._utils.notify_record_changed_for_rag")
    @patch("apps.tabdata.subscribers._utils.refresh_table_row_count")
    def test_lifecycle_revalidation_fails_closed_without_blocking_normal_create(
        self,
        _refresh_row_count,
        _notify_rag,
        native_io_cls,
        _publish_table_update,
    ):
        missing_candidate_id = uuid4()
        foreign_candidate_id = uuid4()
        healthy_id = uuid4()
        other_table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="Other table",
            owner=self.user,
        )
        TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            id=foreign_candidate_id,
            table=other_table,
            is_deleted=False,
        )

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={
                str(missing_candidate_id): {self.field.id.hex: "must not revive"},
                str(foreign_candidate_id): {self.field.id.hex: "wrong owner"},
                str(healthy_id): {self.field.id.hex: "healthy create"},
            },
            deleted_record_ids=[],
            source="collab_persist",
            record_lifecycle_revalidation_ids=[
                str(missing_candidate_id),
                str(foreign_candidate_id),
            ],
        )

        self.assertEqual(result["created"], 1)
        self.assertEqual(
            result["unconfirmed_record_lifecycle_ids"],
            [str(missing_candidate_id), str(foreign_candidate_id)],
        )
        self.assertFalse(
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id=missing_candidate_id
            ).exists()
        )
        self.assertEqual(
            TableRecord.objects.using(TABDATA_DB_ALIAS).get(
                id=foreign_candidate_id
            ).table_id,
            other_table.id,
        )
        self.assertTrue(
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id=healthy_id,
                table=self.table,
                is_deleted=False,
            ).exists()
        )
        native_io_cls.return_value.insert_record.assert_called_once()
        self.assertEqual(
            native_io_cls.return_value.insert_record.call_args.args[0],
            healthy_id,
        )

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_collab_delete_uses_the_record_authenticated_editor(
        self,
        _native_io_cls,
        _publish_table_update,
    ):
        document_level_editor = uuid4()

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={},
            deleted_record_ids=[str(self.record.id)],
            source="collab_persist",
            editor_type="user",
            editor_id=str(document_level_editor),
            record_editor_ids={str(self.record.id): str(self.user.id)},
        )

        self.assertEqual(result["deleted"], 1)
        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.table.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertTrue(self.record.is_deleted)
        self.assertEqual(self.record.updated_by_id, self.user.id)
        self.assertEqual(self.table.record_delete_version, result["version"])

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    def test_restore_snapshot_advances_delete_watermark(
        self,
        _native_io_cls,
        _publish_table_update,
    ):
        CollabService.restore_from_snapshot(
            self.table.id,
            {
                "fields": [{"id": str(self.field.id), "id_hex": self.field.id.hex}],
                "records": {},
                "row_order": [],
                "total_records": 0,
            },
        )

        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.table.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertTrue(self.record.is_deleted)
        self.assertEqual(self.table.record_delete_version, self.record.version)

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.subscribers._utils.notify_record_changed_for_rag")
    @patch("apps.tabdata.subscribers._utils.refresh_table_row_count")
    def test_collab_create_history_keeps_storage_keys_deduplicated(
        self,
        _refresh_row_count,
        _notify_rag,
        native_io_cls,
        _publish_table_update,
    ):
        created_time_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="创建时间",
            field_type="date",
            config={
                "auto_fill": "created_time",
                "formatting": {"time": "HH:mm:ss", "timeZone": "Asia/Shanghai"},
            },
            order=1,
        )
        record_id = uuid4()

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={
                str(record_id): {
                    self.field.id.hex: "协作新增",
                },
            },
            deleted_record_ids=[],
            source="collab_persist",
        )

        self.assertEqual(result["created"], 1)
        native_io_cls.return_value.insert_record.assert_called_once()

        record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id)
        self.assertEqual(record.data[self.field.id.hex], "协作新增")
        self.assertIn(created_time_field.id.hex, record.data)
        self.assertNotIn(str(created_time_field.id), record.data)

        history = RecordHistory.objects.using(TABDATA_DB_ALIAS).get(
            record=record,
            action="create",
        )
        self.assertIn("data", history.field_changes)
        self.assertIn(self.field.id.hex, history.field_changes["data"])
        self.assertIn(created_time_field.id.hex, history.field_changes["data"])
        self.assertNotIn(str(self.field.id), history.field_changes["data"])
        self.assertNotIn(str(created_time_field.id), history.field_changes["data"])

        item_keys = set(
            RecordHistoryItem.objects.using(TABDATA_DB_ALIAS)
            .filter(history=history)
            .values_list("field_key", flat=True)
        )
        self.assertIn(self.field.id.hex, item_keys)
        self.assertIn(created_time_field.id.hex, item_keys)
        self.assertNotIn(str(self.field.id), item_keys)
        self.assertNotIn(str(created_time_field.id), item_keys)

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.table_service.TableService._native_drop_column")
    def test_collab_fields_snapshot_does_not_delete_missing_field(
        self,
        _native_drop_column,
        _publish_table_update,
    ):
        """#4200: Y.Doc meta 缺字段不得驱动 delete_field（REST 删除/撤销恢复竞态）。"""
        copied_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="标题 副本",
            field_type="text",
            order=1,
        )
        trailing_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="描述",
            field_type="text",
            order=2,
        )
        schema_version_before = Table.objects.using(TABDATA_DB_ALIAS).get(
            id=self.table.id,
        ).schema_version

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={},
            deleted_record_ids=[],
            collab_fields=[
                {
                    "id": str(self.field.id),
                    "id_hex": self.field.id.hex,
                    "name": self.field.name,
                    "field_type": self.field.field_type,
                    "config": self.field.config or {},
                    "order": 0,
                },
                {
                    "id": str(trailing_field.id),
                    "id_hex": trailing_field.id.hex,
                    "name": trailing_field.name,
                    "field_type": trailing_field.field_type,
                    "config": trailing_field.config or {},
                    "order": 1,
                },
            ],
            source="collab_persist",
        )

        returned_field_ids = {item["id"] for item in result["fields"]}
        # DB 权威 fields 仍含 Y.Doc 未列出的 copied_field；不得被软删。
        self.assertIn(str(copied_field.id), returned_field_ids)
        copied_field.refresh_from_db(using=TABDATA_DB_ALIAS)
        trailing_field.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertFalse(copied_field.is_deleted)
        # payload 里 trailing order=1 仍可更新元数据；缺字段不得触发删除。
        self.assertEqual(trailing_field.order, 1)
        schema_version_after = Table.objects.using(TABDATA_DB_ALIAS).get(
            id=self.table.id,
        ).schema_version
        self.assertEqual(schema_version_after, schema_version_before + 1)

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    def test_collab_select_config_change_reconciles_unchanged_default_snapshot(
        self,
        _publish_table_update,
    ):
        select_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="状态",
            field_type="select",
            order=1,
            config={"choices": [{"id": "todo", "value": "待办"}]},
            default_value={"mode": "literal", "value": "待办"},
        )

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={},
            deleted_record_ids=[],
            collab_fields=[
                {
                    "id": str(self.field.id),
                    "name": self.field.name,
                    "field_type": self.field.field_type,
                    "config": self.field.config or {},
                    "order": 0,
                },
                {
                    "id": str(select_field.id),
                    "name": select_field.name,
                    "field_type": select_field.field_type,
                    "config": {
                        "choices": [{"id": "todo", "value": "进行中"}],
                    },
                    # Collab snapshots normally repeat the old default even
                    # when only config changed; it must still be reconciled.
                    "default_value": {"mode": "literal", "value": "待办"},
                    "order": 1,
                },
            ],
            source="collab_persist",
        )

        select_field.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(
            select_field.default_value,
            {"mode": "literal", "value": "进行中"},
        )

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.table_service.TableService.create_field")
    def test_collab_fields_snapshot_skips_soft_deleted_field_recreate(
        self,
        create_field_mock,
        _publish_table_update,
    ):
        """软删同 ID 不得经 collab create_field 复活（会撞 pkey / 绕过 undo）。"""
        soft_deleted = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="已删列",
            field_type="text",
            order=1,
            is_deleted=True,
        )
        create_field_mock.return_value = None

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={},
            deleted_record_ids=[],
            collab_fields=[
                {
                    "id": str(self.field.id),
                    "id_hex": self.field.id.hex,
                    "name": self.field.name,
                    "field_type": self.field.field_type,
                    "config": self.field.config or {},
                    "order": 0,
                },
                {
                    "id": str(soft_deleted.id),
                    "id_hex": soft_deleted.id.hex,
                    "name": soft_deleted.name,
                    "field_type": soft_deleted.field_type,
                    "config": {},
                    "order": 1,
                },
            ],
            source="collab_persist",
        )

        create_field_mock.assert_not_called()
        soft_deleted.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertTrue(soft_deleted.is_deleted)
        returned_field_ids = {item["id"] for item in result["fields"]}
        self.assertNotIn(str(soft_deleted.id), returned_field_ids)

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.services.table_service.TableService._native_add_column")
    def test_collab_field_created_in_same_payload_can_receive_cell_value(
        self,
        _native_add_column,
        native_io_cls,
        _publish_table_update,
    ):
        """A duplicated field can be created and edited before the first persist."""
        new_field_id = uuid4()

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={
                str(self.record.id): {
                    new_field_id.hex: "副本字段内容",
                },
            },
            new_records={},
            deleted_record_ids=[],
            collab_fields=[
                {
                    "id": str(self.field.id),
                    "id_hex": self.field.id.hex,
                    "name": self.field.name,
                    "field_type": self.field.field_type,
                    "config": self.field.config or {},
                    "order": 0,
                },
                {
                    "id": str(new_field_id),
                    "id_hex": new_field_id.hex,
                    "name": "标题 副本",
                    "field_type": "text",
                    "config": {},
                    "order": 1,
                },
            ],
            source="collab_persist",
        )

        self.assertEqual(result["persisted"], 1)
        returned_field_ids = {item["id"] for item in result["fields"]}
        self.assertIn(str(new_field_id), returned_field_ids)
        self.assertTrue(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                id=new_field_id,
                is_deleted=False,
            ).exists()
        )
        self.record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.record.data[new_field_id.hex], "副本字段内容")
        native_io_cls.return_value.update_record.assert_called_once()
        update_kwargs = native_io_cls.return_value.update_record.call_args.kwargs
        self.assertEqual(
            update_kwargs["field_values"][new_field_id.hex],
            "副本字段内容",
        )

    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.subscribers._utils.notify_record_changed_for_rag")
    @patch("apps.tabdata.subscribers._utils.refresh_table_row_count")
    def test_collab_batch_delete_with_non_uuid_op_id_shares_operation_group(
        self,
        _refresh_row_count,
        _notify_rag,
        _native_io_cls,
        _publish_table_update,
    ):
        """collab-live 的 op_id 形如 collab_<ts>_<rand>，非合法 UUID。
        persist_changes 须为其派生一个确定性 operation_group_id，使同一次批量删除
        产生的多条 RecordHistory 能共享分组，供前端聚合为一条、undo 栈按组撤销。"""
        second_record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field.id): "待删除记录二"},
        )
        third_record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field.id): "待删除记录三"},
        )
        collab_op_id = "collab_1751777777_ab12cd"
        expected_group_id = _derive_operation_group_id(collab_op_id)
        self.assertIsNotNone(expected_group_id)

        def assert_tombstone_before_projection_cleanup(
            record_id, version, updated_by=None,
        ):
            tombstone = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id)
            self.assertTrue(
                tombstone.is_deleted,
                "协作删除必须先建立 ORM tombstone，再清理 native 投影",
            )
            self.assertEqual(
                version,
                0,
                "协作显式删除不能被 native 内部版本漂移阻断",
            )
            return True

        _native_io_cls.return_value.delete_record.side_effect = (
            assert_tombstone_before_projection_cleanup
        )

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={},
            deleted_record_ids=[str(second_record.id), str(third_record.id)],
            op_id=collab_op_id,
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.user.id),
        )

        self.assertEqual(result["deleted"], 2)
        histories = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record_id__in=[second_record.id, third_record.id],
            action="delete",
        )
        self.assertEqual(histories.count(), 2)
        group_ids = {history.operation_group_id for history in histories}
        self.assertEqual(group_ids, {expected_group_id})

        # 同一 op_id 重放（幂等重试）须派生出同一个分组 ID
        self.assertEqual(_derive_operation_group_id(collab_op_id), expected_group_id)

        # 合法 UUID 形式的 op_id 不受影响，直接原样使用
        legit_op_id = str(uuid4())
        self.assertEqual(str(_derive_operation_group_id(legit_op_id)), legit_op_id)

    def test_persist_collab_views_keeps_existing_view_missing_from_snapshot(self):
        """#10856：不完整 Y.Doc 快照不得删除 REST 已有视图，也不改 default_view。"""
        first_view = TableView.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="表格视图",
            view_type="grid",
            created_by=self.user,
            order=0,
            config={},
        )
        self.table.default_view = first_view
        self.table.save(using=TABDATA_DB_ALIAS, update_fields=["default_view"])

        kanban_view_id = uuid4()
        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={},
            deleted_record_ids=[],
            collab_views={
                str(kanban_view_id): {
                    "id": str(kanban_view_id),
                    "name": "看板视图",
                    "view_type": "kanban",
                    "config": {},
                    "filters": [],
                    "sorts": [],
                    "groups": [],
                    "visible_fields": [],
                    "field_order": [],
                    "order": 1,
                },
            },
            editor_id=str(self.user.id),
        )

        self.assertTrue(
            TableView.objects.using(TABDATA_DB_ALIAS).filter(id=first_view.id).exists()
        )
        kanban_view = TableView.objects.using(TABDATA_DB_ALIAS).get(id=kanban_view_id)
        self.table.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.table.default_view_id, first_view.id)
        self.assertEqual(
            {view["id"] for view in result["views"]},
            {str(first_view.id), str(kanban_view.id)},
        )

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=0)
    def test_update_record_defers_side_effects_until_outer_commit(self):
        with (
            patch.object(RecordService, "_native_get_io", return_value=MagicMock()),
            patch(
                "apps.tabdata.infrastructure.native_io_adapter."
                "NativeRecordIOAdapter.update_record",
                return_value=None,
            ),
            patch("apps.tabdata.services.record_service.table_event_service.publish_table_update") as mock_publish,
            patch("apps.tabdata.services.collab_service.CollabService.push_cells") as mock_collab_push,
            patch("apps.tabdata.utils.scheduler_bridge.emit_record_event_to_eventbus") as mock_scheduler_delay,
            patch(
                "apps.tabdata.services.cascade_service.CascadeService.propagate_cell_changes",
                return_value=[],
            ),
        ):
            with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=False) as callbacks:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    result = self.service.update_record(
                        self.record.id,
                        {"标题": "外层事务更新"},
                    )
                    self.assertIsNotNone(result)
                    record, error = result
                    self.assertIsNone(error)
                    self.assertIsNotNone(record)

                    self.assertFalse(mock_publish.called)
                    self.assertFalse(mock_collab_push.called)
                    self.assertFalse(mock_scheduler_delay.called)

            self.assertGreaterEqual(len(callbacks), 4)
            for callback in callbacks:
                callback()

            mock_publish.assert_called_once()
            mock_collab_push.assert_called_once()
            mock_scheduler_delay.assert_called_once()

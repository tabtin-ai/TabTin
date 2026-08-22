"""
回归测试：SR-005 / SR-010

验证 restore_from_snapshot 执行后：
1. Table.schema_version 被递增（SR-005）
2. WS 广播 metadata 携带 schema_version（SR-010）
"""
from __future__ import annotations

from uuid import UUID, uuid4
from unittest import TestCase
from unittest.mock import patch, MagicMock, PropertyMock

from apps.tabdata.services.collab_service import CollabService


def _make_mock_table(table_id: UUID, schema_version: int = 3):
    """构造 Table mock 对象"""
    table = MagicMock()
    table.id = table_id
    table.space_id = uuid4()
    table.name = "test_table"
    table.record_version_seq = 10
    table.schema_version = schema_version
    table.is_archived = False
    return table


def _make_mock_field(hex_id: str = "abcd1234abcd1234abcd1234abcd1234"):
    """构造 TableField mock 对象"""
    field = MagicMock()
    field_uuid = UUID(hex_id)
    field.id = field_uuid
    field.name = "test_field"
    field.field_type = "text"
    field.config = {}
    field.order = 0
    field.is_deleted = False
    return field


class RestoreSchemaVersionTests(TestCase):
    """SR-005: restore_from_snapshot 必须递增 schema_version"""

    @patch("apps.tabdata.services.collab_service.table_event_service")
    @patch("apps.tabdata.services.collab_service.next_record_version", return_value=100)
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.services.collab_service.TableRecord")
    @patch("apps.tabdata.services.collab_service.TableField")
    @patch("apps.tabdata.services.collab_service.Table")
    @patch("apps.tabdata.services.collab_service.transaction")
    def test_schema_version_incremented_after_restore(
        self,
        mock_transaction,
        mock_table_cls,
        mock_field_cls,
        mock_record_cls,
        mock_native_io_cls,
        mock_next_version,
        mock_event_service,
    ):
        table_id = uuid4()
        mock_table = _make_mock_table(table_id, schema_version=5)

        mock_table_cls.objects.using.return_value.filter.return_value.first.return_value = mock_table
        mock_table_cls.objects.using.return_value.filter.return_value.update.return_value = 1

        mock_field = _make_mock_field()
        mock_field_cls.objects.using.return_value.filter.return_value = [mock_field]

        mock_record_cls.objects.using.return_value.filter.return_value.values_list.return_value = []
        mock_record_cls.objects.using.return_value.filter.return_value.update.return_value = 0

        mock_transaction.atomic.return_value.__enter__ = MagicMock(return_value=None)
        mock_transaction.atomic.return_value.__exit__ = MagicMock(return_value=False)

        mock_native_io_cls.return_value = MagicMock()

        snapshot_data = {
            "records": {},
            "row_order": [],
            "fields": [],
        }

        CollabService.restore_from_snapshot(table_id, snapshot_data)

        update_calls = mock_table_cls.objects.using.return_value.filter.return_value.update.call_args_list
        schema_version_updated = any(
            'schema_version' in str(call)
            for call in update_calls
        )
        self.assertTrue(
            schema_version_updated,
            "restore_from_snapshot must increment Table.schema_version (SR-005)"
        )


class RestoreWSNotificationSchemaVersionTests(TestCase):
    """SR-010: WS 通知必须携带 schema_version"""

    @patch("apps.tabdata.services.collab_service.table_event_service")
    @patch("apps.tabdata.services.collab_service.next_record_version", return_value=100)
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.services.collab_service.TableRecord")
    @patch("apps.tabdata.services.collab_service.TableField")
    @patch("apps.tabdata.services.collab_service.Table")
    @patch("apps.tabdata.services.collab_service.transaction")
    def test_ws_notification_carries_schema_version(
        self,
        mock_transaction,
        mock_table_cls,
        mock_field_cls,
        mock_record_cls,
        mock_native_io_cls,
        mock_next_version,
        mock_event_service,
    ):
        table_id = uuid4()
        mock_table = _make_mock_table(table_id, schema_version=7)

        mock_table_cls.objects.using.return_value.filter.return_value.first.return_value = mock_table
        mock_table_cls.objects.using.return_value.filter.return_value.update.return_value = 1

        mock_field_cls.objects.using.return_value.filter.return_value = []

        mock_record_cls.objects.using.return_value.filter.return_value.values_list.return_value = []
        mock_record_cls.objects.using.return_value.filter.return_value.update.return_value = 0

        mock_transaction.atomic.return_value.__enter__ = MagicMock(return_value=None)
        mock_transaction.atomic.return_value.__exit__ = MagicMock(return_value=False)

        mock_native_io_cls.return_value = MagicMock()

        snapshot_data = {
            "records": {},
            "row_order": [],
            "fields": [],
        }

        CollabService.restore_from_snapshot(table_id, snapshot_data)

        mock_event_service.publish_table_update.assert_called_once()
        call_kwargs = mock_event_service.publish_table_update.call_args
        metadata = call_kwargs.kwargs.get("metadata") or call_kwargs[1].get("metadata", {})

        self.assertIn(
            "schema_version",
            metadata,
            "WS notification metadata must include schema_version (SR-010)"
        )

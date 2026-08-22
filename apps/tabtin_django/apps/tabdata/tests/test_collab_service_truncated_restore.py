"""SR-003 回归测试：截断快照恢复必须被拒绝，防止永久数据丢失。"""
from __future__ import annotations

from uuid import UUID, uuid4
from unittest import TestCase
from unittest.mock import patch, MagicMock

from apps.tabdata.services.collab_service import CollabService


class TruncatedSnapshotRestoreTests(TestCase):
    """restore_from_snapshot 必须拒绝截断快照，避免 to_delete 误删被截断记录。"""

    TABLE_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")

    def _mock_table(self):
        table = MagicMock()
        table.id = self.TABLE_ID
        table.space_id = uuid4()
        table.record_version_seq = 1
        return table

    @patch("apps.tabdata.services.collab_service.Table.objects.using")
    def test_rejects_snapshot_with_is_truncated_true(self, using_mock):
        """is_truncated=True 的快照必须被拒绝。"""
        using_mock.return_value.filter.return_value.first.return_value = self._mock_table()

        snapshot = {
            "records": {str(uuid4()): {"abc": 1} for _ in range(5000)},
            "row_order": [],
            "fields": [],
            "is_truncated": True,
            "total_records": 8000,
        }

        with self.assertRaises(ValueError) as ctx:
            CollabService.restore_from_snapshot(self.TABLE_ID, snapshot)

        self.assertIn("截断快照", str(ctx.exception))
        self.assertIn("5000", str(ctx.exception))
        self.assertIn("8000", str(ctx.exception))

    @patch("apps.tabdata.services.collab_service.Table.objects.using")
    def test_rejects_snapshot_when_total_records_exceeds_actual(self, using_mock):
        """即使 is_truncated 缺失，total_records > len(records) 也必须被拒绝。"""
        using_mock.return_value.filter.return_value.first.return_value = self._mock_table()

        snapshot = {
            "records": {str(uuid4()): {"abc": 1} for _ in range(100)},
            "row_order": [],
            "fields": [],
            "total_records": 500,
        }

        with self.assertRaises(ValueError) as ctx:
            CollabService.restore_from_snapshot(self.TABLE_ID, snapshot)

        self.assertIn("截断快照", str(ctx.exception))

    @patch("apps.tabdata.services.collab_service.Table.objects.using")
    def test_allows_complete_snapshot(self, using_mock):
        """完整快照（is_truncated=False，total_records == len(records)）不应被拒绝。
        验证检查通过后代码继续执行（会进入后续逻辑，这里 mock 掉 DB 层即可）。"""
        table = self._mock_table()
        using_mock.return_value.filter.return_value.first.return_value = table

        rid = str(uuid4())
        snapshot = {
            "records": {rid: {"abc": 1}},
            "row_order": [rid],
            "fields": [],
            "is_truncated": False,
            "total_records": 1,
        }

        with patch("apps.tabdata.services.collab_service.TableField.objects.using") as field_mock, \
             patch("apps.tabdata.services.collab_service.NativeRecordIO"), \
             patch("apps.tabdata.services.collab_service.TableRecord.objects.using") as record_mock, \
             patch("apps.tabdata.services.collab_service.next_record_version", return_value=2), \
             patch("apps.tabdata.services.collab_service.table_event_service"), \
             patch("apps.tabdata.services.collab_service.transaction"):

            field_mock.return_value.filter.return_value = []
            record_mock.return_value.filter.return_value.values_list.return_value = set()

            result = CollabService.restore_from_snapshot(self.TABLE_ID, snapshot)

        self.assertIn("created", result)

    @patch("apps.tabdata.services.collab_service.Table.objects.using")
    def test_allows_snapshot_without_truncation_metadata(self, using_mock):
        """没有 is_truncated/total_records 字段的旧格式快照，默认视为完整快照。"""
        table = self._mock_table()
        using_mock.return_value.filter.return_value.first.return_value = table

        rid = str(uuid4())
        snapshot = {
            "records": {rid: {"abc": 1}},
            "row_order": [rid],
            "fields": [],
        }

        with patch("apps.tabdata.services.collab_service.TableField.objects.using") as field_mock, \
             patch("apps.tabdata.services.collab_service.NativeRecordIO"), \
             patch("apps.tabdata.services.collab_service.TableRecord.objects.using") as record_mock, \
             patch("apps.tabdata.services.collab_service.next_record_version", return_value=2), \
             patch("apps.tabdata.services.collab_service.table_event_service"), \
             patch("apps.tabdata.services.collab_service.transaction"):

            field_mock.return_value.filter.return_value = []
            record_mock.return_value.filter.return_value.values_list.return_value = set()

            result = CollabService.restore_from_snapshot(self.TABLE_ID, snapshot)

        self.assertIn("created", result)

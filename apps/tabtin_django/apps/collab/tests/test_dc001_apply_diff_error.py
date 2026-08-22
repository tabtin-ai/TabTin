"""
DC-001 回归测试

验证 TableCollabAdapter.apply_diff 在解压/反序列化失败时返回 None，
使 rebuild_data 的失败检测（if data is None）能正确中止 diff 链回放。

根因：修复前 apply_diff 解压失败时返回 base_data（非 None），
绕过了 rebuild_data 的两层保护，导致损坏 diff 被静默跳过。
"""
import json
import uuid
import zlib
from unittest.mock import MagicMock, patch

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.table import TableCollabAdapter  # noqa: E402


class TestDC001ApplyDiffReturnsNoneOnError:
    """DC-001: apply_diff 解压失败必须返回 None 而非 base_data。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()
        self.base_data = {
            "fields": [{"id": "f1", "name": "Name"}],
            "records": {"r1": {"f1": "Alice"}, "r2": {"f1": "Bob"}},
            "row_order": ["r1", "r2"],
            "total_records": 2,
        }

    def test_corrupted_blob_returns_none(self):
        """完全损坏的 blob（非 zlib 格式）应返回 None。"""
        result = self.adapter.apply_diff(self.base_data, b"not-valid-zlib-data")
        assert result is None

    def test_truncated_blob_returns_none(self):
        """被截断的 zlib blob 应返回 None。"""
        valid = zlib.compress(json.dumps({"added_records": {}}).encode())
        truncated = valid[:len(valid) // 2]
        result = self.adapter.apply_diff(self.base_data, truncated)
        assert result is None

    def test_valid_zlib_invalid_json_returns_none(self):
        """合法 zlib 但非 JSON 内容应返回 None。"""
        blob = zlib.compress(b"this is not json {{{")
        result = self.adapter.apply_diff(self.base_data, blob)
        assert result is None

    def test_empty_blob_returns_none(self):
        """空 bytes 应返回 None。"""
        result = self.adapter.apply_diff(self.base_data, b"")
        assert result is None

    def test_valid_diff_still_works(self):
        """正常 diff blob 应正确应用，不受本次修复影响。"""
        diff = {
            "added_records": {"r3": {"f1": "Charlie"}},
            "removed_records": ["r1"],
            "changed_records": {"r2": {"f1": "Bobby"}},
            "row_order": ["r2", "r3"],
        }
        blob = zlib.compress(json.dumps(diff).encode())
        result = self.adapter.apply_diff(self.base_data, blob)

        assert result is not None
        assert "r1" not in result["records"]
        assert result["records"]["r2"]["f1"] == "Bobby"
        assert result["records"]["r3"]["f1"] == "Charlie"
        assert result["row_order"] == ["r2", "r3"]
        assert result["total_records"] == 2

    def test_rebuild_data_detects_none_from_corrupted_diff(self):
        """rebuild_data 应在 apply_diff 返回 None 时中止并返回 None。"""
        from apps.collab.service import VersionHistoryService
        from apps.collab.models import VersionHistory

        adapter = self.adapter
        svc = VersionHistoryService(adapter)

        snapshot_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        resource_id = uuid.uuid4()

        mock_snapshot = MagicMock()
        mock_snapshot.id = snapshot_id
        mock_snapshot.is_snapshot = True
        mock_snapshot.blob = adapter.serialize_snapshot(self.base_data)

        mock_diff = MagicMock()
        mock_diff.id = diff_id
        mock_diff.is_snapshot = False
        mock_diff.resource_id = resource_id
        mock_diff.blob = b"corrupted-data"

        mock_history_input = MagicMock()
        mock_history_input.id = diff_id
        mock_history_input.is_snapshot = False
        mock_history_input.resource_id = resource_id
        mock_history_input.base_history_id = snapshot_id

        mock_entries_qs = MagicMock()
        mock_entries_qs.__iter__ = MagicMock(
            return_value=iter([mock_snapshot, mock_diff])
        )

        def mock_filter(**kwargs):
            if "id__in" in kwargs:
                return mock_entries_qs
            if "id" in kwargs:
                row_qs = MagicMock()
                row_qs.values_list.return_value.first.return_value = (True, None)
                return row_qs
            return MagicMock()

        from apps.collab.service import RebuildError

        with patch.object(VersionHistory, "objects") as mock_objects, \
             patch("apps.collab.service.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_using = MagicMock()
            mock_using.filter = mock_filter
            mock_objects.using.return_value = mock_using

            with pytest.raises((RebuildError, TypeError)):
                svc.rebuild_data(mock_history_input)

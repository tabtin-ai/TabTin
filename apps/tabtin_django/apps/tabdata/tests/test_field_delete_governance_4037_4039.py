"""#4037 /  字段删除治理单元测试。

覆盖：
1. 版本历史 get_version_data 含软删字段定义（自包含快照）
2. 协作 build_snapshot 默认不含软删字段
3. DC-005 不剥 is_deleted=true 字段的 cell key
4. delete_field 入栈失败时向上抛出（不再吞异常）
"""
from __future__ import annotations

import json
import zlib
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest


class TestBuildSnapshotIncludeDeletedFields:
    def test_version_data_includes_soft_deleted_field_defs(self):
        from apps.collab.adapters.table import TableCollabAdapter

        table_id = uuid4()
        active_id = uuid4()
        deleted_id = uuid4()
        resource = MagicMock()
        resource.id = table_id

        snapshot = {
            "table_id": str(table_id),
            "fields": [
                {
                    "id": str(active_id),
                    "id_hex": active_id.hex,
                    "name": "活跃列",
                    "field_type": "text",
                    "config": {},
                    "order": 0,
                    "is_deleted": False,
                },
                {
                    "id": str(deleted_id),
                    "id_hex": deleted_id.hex,
                    "name": "已删列",
                    "field_type": "text",
                    "config": {},
                    "order": 1,
                    "is_deleted": True,
                },
            ],
            "records": {},
            "row_order": [],
        }

        with patch(
            "apps.tabdata.services.collab_service.CollabService.build_snapshot",
            return_value=snapshot,
        ) as mock_build:
            adapter = TableCollabAdapter()
            result = adapter.get_version_data(resource)

        mock_build.assert_called_once_with(
            str(table_id),
            include_deleted_fields=True,
        )
        assert len(result["fields"]) == 2
        assert result["fields"][1]["is_deleted"] is True

    def test_collab_build_snapshot_defaults_to_active_only(self):
        from apps.collab.adapters.table import TableCollabAdapter

        table_id = uuid4()
        resource = MagicMock()
        resource.id = table_id

        with patch(
            "apps.tabdata.services.collab_service.CollabService.build_snapshot",
            return_value={"fields": [], "records": {}, "row_order": []},
        ) as mock_build:
            adapter = TableCollabAdapter()
            adapter.build_snapshot(resource)

        mock_build.assert_called_once_with(str(table_id))


class TestApplyDiffKeepsSoftDeletedFieldKeys:
    def test_dc005_keeps_keys_for_is_deleted_fields(self):
        from apps.collab.adapters.table import TableCollabAdapter

        active_id = uuid4()
        deleted_id = uuid4()
        record_id = str(uuid4())

        base = {
            "fields": [
                {
                    "id": str(active_id),
                    "id_hex": active_id.hex,
                    "name": "A",
                    "is_deleted": False,
                },
                {
                    "id": str(deleted_id),
                    "id_hex": deleted_id.hex,
                    "name": "B",
                    "is_deleted": True,
                },
            ],
            "records": {
                record_id: {
                    active_id.hex: "keep-active",
                    deleted_id.hex: "keep-deleted",
                    "ghost_hex": "should-drop",
                    "__order": 1,
                },
            },
            "row_order": [record_id],
        }
        # 空 diff：只触发 DC-005 幽灵剥离
        diff_blob = zlib.compress(
            json.dumps({"_diff_format": "field_delta"}).encode("utf-8"),
            level=6,
        )

        adapter = TableCollabAdapter()
        result = adapter.apply_diff(base, diff_blob)

        assert result is not None
        row = result["records"][record_id]
        assert row[active_id.hex] == "keep-active"
        assert row[deleted_id.hex] == "keep-deleted"
        assert "ghost_hex" not in row
        assert row["__order"] == 1


class TestDeleteFieldUndoStackFailurePropagates:
    def test_push_delete_fields_no_longer_swallowed(self):
        """#4039: delete_field 源码中 push_delete_fields 不再被 try/except 吞掉。"""
        import inspect
        from apps.tabdata.services import table_service as ts_mod

        source = inspect.getsource(ts_mod.TableService.delete_field)
        assert "push_delete_fields(" in source
        # 旧实现：try + push + except Exception + warning「入栈失败」
        assert "字段删除操作入栈失败" not in source
        # 入栈调用应在 publish / version history 之前（失败则不继续）
        push_pos = source.index("push_delete_fields(")
        publish_pos = source.index("_publish_field_event(")
        history_pos = source.index("_trigger_field_version_history(")
        assert push_pos < publish_pos < history_pos

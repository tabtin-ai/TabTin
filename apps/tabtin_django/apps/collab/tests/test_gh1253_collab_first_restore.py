""": 表格 collab-first 版本还原回归测试。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from apps.collab.service import VersionHistoryService


@pytest.mark.django_db
class TestCollabFirstTableRestore:
    """try_collab_first_table_restore 优先级与回退语义。"""

    def test_non_table_returns_none(self):
        adapter = MagicMock()
        adapter.resource_type = "docs"
        svc = VersionHistoryService(adapter)
        assert svc.try_collab_first_table_restore(uuid4(), uuid4(), {}) is None

    @patch("apps.collab.service._call_collab_live_collab_first_restore")
    @patch("apps.collab.service.VersionHistoryService.acquire_restore_lock")
    @patch("apps.collab.service.VersionHistoryService.release_restore_lock")
    @patch("apps.collab.service.VersionHistoryService.get_version")
    @patch("apps.collab.service.VersionHistoryService.rebuild_data")
    @patch("apps.collab.service.VersionHistoryService._do_create_history")
    def test_loaded_updates_ydoc_then_restore_from_snapshot(
        self,
        mock_create_history,
        mock_rebuild,
        mock_get_version,
        mock_release,
        mock_acquire,
        mock_live,
    ):
        adapter = MagicMock()
        adapter.resource_type = "table"
        adapter.prepare_collab_first_restore_snapshot = MagicMock(
            side_effect=lambda resource, data: {**data, "table_id": str(resource.id)},
        )
        adapter.prepare_restore.return_value = {}
        resource = MagicMock()
        resource.id = uuid4()
        adapter.get_resource.return_value = resource

        target_vh = MagicMock()
        target_vh.id = uuid4()
        target_vh.metadata = {}
        target_vh.name = "v1"
        target_vh.created_at = None
        mock_get_version.return_value = target_vh
        mock_rebuild.return_value = {
            "fields": [{"id": "f1"}],
            "records": {},
            "row_order": [],
        }
        mock_live.return_value = {"success": True, "loaded": True}
        created_vh = MagicMock()
        created_vh.id = uuid4()
        mock_create_history.return_value = created_vh

        svc = VersionHistoryService(adapter)
        editor_info = {"editor_type": "user", "editor_id": "u1", "editor_name": "U"}
        result = svc.try_collab_first_table_restore(
            resource.id, target_vh.id, editor_info, resource=resource,
        )

        assert result is created_vh
        mock_live.assert_called_once()
        adapter.restore.assert_called_once()

    @patch("apps.collab.service._call_collab_live_collab_first_restore")
    @patch("apps.collab.service.VersionHistoryService.acquire_restore_lock")
    @patch("apps.collab.service.VersionHistoryService.release_restore_lock")
    @patch("apps.collab.service.VersionHistoryService.get_version")
    @patch("apps.collab.service.VersionHistoryService.rebuild_data")
    def test_not_loaded_returns_none_for_db_first_fallback(
        self,
        mock_rebuild,
        mock_get_version,
        mock_release,
        mock_acquire,
        mock_live,
    ):
        adapter = MagicMock()
        adapter.resource_type = "table"
        adapter.prepare_collab_first_restore_snapshot = MagicMock(
            side_effect=lambda resource, data: data,
        )
        resource = MagicMock()
        resource.id = uuid4()
        adapter.get_resource.return_value = resource

        mock_get_version.return_value = MagicMock(metadata={}, name="v1")
        mock_rebuild.return_value = {
            "fields": [{"id": "f1"}],
            "records": {},
            "row_order": [],
        }
        mock_live.return_value = {"success": True, "loaded": False}

        svc = VersionHistoryService(adapter)
        assert svc.try_collab_first_table_restore(
            resource.id, uuid4(), {}, resource=resource,
        ) is None

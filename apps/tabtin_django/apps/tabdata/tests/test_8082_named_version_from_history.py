"""#8082：从选中历史快照创建命名版本。"""
from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import uuid4

from apps.tabdata.api_undo_redo import (
    _normalize_record_field_keys,
    _version_data_from_history_id,
)


class NormalizeRecordFieldKeysTests(TestCase):
    def test_maps_uuid_and_hex_aliases_to_id_hex(self):
        field_id = "71988425-7b83-410c-b20e-e0fcbde8a359"
        id_hex = field_id.replace("-", "")
        hex_by_alias = {
            field_id: id_hex,
            id_hex: id_hex,
        }
        raw = {field_id: "567", "unknown": 1}
        out = _normalize_record_field_keys(raw, hex_by_alias)
        self.assertEqual(out[id_hex], "567")
        self.assertEqual(out["unknown"], 1)


class VersionDataFromHistoryIdTests(TestCase):
    @patch("apps.tabdata.api_undo_redo.UndoRedoService")
    @patch("apps.collab.models.VersionHistory")
    def test_prefers_version_history_blob(self, mock_vh_model, _mock_svc):
        table_id = uuid4()
        history_id = uuid4()
        blob_data = {
            "fields": [],
            "records": {"r1": {"abc": "from-vh"}},
            "row_order": ["r1"],
        }

        vh = MagicMock()
        vh.id = history_id
        vh.blob = b"not-empty"
        mock_vh_model.objects.using.return_value.filter.return_value.only.return_value.first.return_value = vh

        with patch(
            "apps.collab.adapters.table.TableCollabAdapter.deserialize_snapshot",
            return_value=blob_data,
        ):
            data, source_id, set_legacy = _version_data_from_history_id(
                table_id,
                history_id,
                user=MagicMock(),
                window_id=None,
            )

        self.assertEqual(data, blob_data)
        self.assertEqual(source_id, str(history_id))
        self.assertFalse(set_legacy)

    @patch("apps.tabdata.services.collab_service.CollabService.build_snapshot")
    @patch("apps.tabdata.api_undo_redo.UndoRedoService")
    @patch("apps.collab.models.VersionHistory")
    def test_falls_back_to_reconstruct(self, mock_vh_model, mock_svc_cls, mock_build):
        table_id = uuid4()
        history_id = uuid4()
        field_id = "71988425-7b83-410c-b20e-e0fcbde8a359"
        id_hex = field_id.replace("-", "")

        mock_vh_model.objects.using.return_value.filter.return_value.only.return_value.first.return_value = None
        mock_svc_cls.return_value.reconstruct_table_at_history.return_value = [
            {
                "record_id": "r1",
                "order": 0,
                "is_deleted": False,
                "data": {field_id: "3"},
            },
            {
                "record_id": "r2",
                "order": 1,
                "is_deleted": True,
                "data": {field_id: "gone"},
            },
        ]
        mock_build.return_value = {
            "fields": [{"id": field_id, "id_hex": id_hex, "name": "标题"}],
            "records": {"live": {}},
            "row_order": ["live"],
        }

        data, source_id, set_legacy = _version_data_from_history_id(
            table_id,
            history_id,
            user=MagicMock(),
            window_id="win-1",
        )

        self.assertTrue(set_legacy)
        self.assertEqual(source_id, str(history_id))
        self.assertEqual(data["row_order"], ["r1"])
        self.assertEqual(data["records"]["r1"][id_hex], "3")
        self.assertNotIn("r2", data["records"])

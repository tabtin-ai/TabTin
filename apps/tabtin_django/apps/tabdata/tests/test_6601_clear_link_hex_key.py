"""#6601: foreignTableId 变更时必须清掉 collab hex key cell。

协作落库只写 field.id.hex；旧实现 _clear_link_cell_values 只 pop
dashed UUID，导致切换关联表后网格仍显示旧关联。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.services.link_field_service import LinkFieldService


class ClearLinkCellValuesHexKeyTests(SimpleTestCase):
    @patch.object(LinkFieldService, "_sync_native_cells")
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    @patch("apps.tabdata.services.link_field_service.TableRecord.objects")
    def test_clears_hex_keyed_cells_and_pushes_ydoc_null(
        self,
        mock_records,
        mock_push_cells,
        mock_sync_native,
    ):
        field_id = uuid4()
        table_id = uuid4()
        record_id = uuid4()
        field = SimpleNamespace(id=field_id, table_id=table_id)
        record = SimpleNamespace(id=record_id)
        record.__dict__["data"] = {
            field_id.hex: [{"id": str(uuid4()), "title": "旧关联"}],
        }

        qs = MagicMock()
        qs.filter.return_value = qs
        qs.iterator.return_value = iter([record])
        mock_records.using.return_value = qs

        LinkFieldService._clear_link_cell_values(field)

        self.assertNotIn(field_id.hex, record.__dict__["data"])
        self.assertNotIn(str(field_id), record.__dict__["data"])
        mock_records.using.return_value.bulk_update.assert_called()
        mock_sync_native.assert_called_once()
        native_map = mock_sync_native.call_args.args[1]
        self.assertEqual(native_map, {record_id: None})
        mock_push_cells.assert_called_once()
        changes = mock_push_cells.call_args.kwargs["changes"]
        self.assertEqual(
            changes,
            [{
                "record_id": str(record_id),
                "field_id_hex": field_id.hex,
                "value": None,
            }],
        )

    @patch.object(LinkFieldService, "_sync_native_cells")
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    @patch("apps.tabdata.services.link_field_service.TableRecord.objects")
    def test_clears_both_hex_and_dashed_when_both_present(
        self,
        mock_records,
        mock_push_cells,
        mock_sync_native,
    ):
        field_id = uuid4()
        table_id = uuid4()
        record_id = uuid4()
        cell = [{"id": str(uuid4()), "title": "双键"}]
        field = SimpleNamespace(id=field_id, table_id=table_id)
        record = SimpleNamespace(id=record_id)
        record.__dict__["data"] = {
            str(field_id): cell,
            field_id.hex: cell,
        }

        qs = MagicMock()
        qs.filter.return_value = qs
        qs.iterator.return_value = iter([record])
        mock_records.using.return_value = qs

        LinkFieldService._clear_link_cell_values(field)

        data = record.__dict__["data"]
        self.assertNotIn(str(field_id), data)
        self.assertNotIn(field_id.hex, data)
        mock_sync_native.assert_called_once()
        mock_push_cells.assert_called_once()

    @patch.object(LinkFieldService, "_sync_native_cells")
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    @patch("apps.tabdata.services.link_field_service.TableRecord.objects")
    def test_skips_records_without_link_keys(
        self,
        mock_records,
        mock_push_cells,
        mock_sync_native,
    ):
        field_id = uuid4()
        field = SimpleNamespace(id=field_id, table_id=uuid4())
        record = SimpleNamespace(id=uuid4())
        record.__dict__["data"] = {uuid4().hex: "other"}

        qs = MagicMock()
        qs.filter.return_value = qs
        qs.iterator.return_value = iter([record])
        mock_records.using.return_value = qs

        LinkFieldService._clear_link_cell_values(field)

        mock_records.using.return_value.bulk_update.assert_not_called()
        mock_sync_native.assert_not_called()
        mock_push_cells.assert_not_called()

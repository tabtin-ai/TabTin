"""Regression: bulk/record update pre-formats link keys as field.id.hex.

RecordService._format_record_data writes ``field.id.hex``; if
``_apply_link_fields`` only looks for dashed UUID / field name, set_link_cell
is skipped and LinkField.format's empty ``title: ""`` lands in storage — the
grid then renders bare record UUIDs instead of lookup titles.
"""
from __future__ import annotations

from unittest.mock import MagicMock
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.domain.value_objects import FieldSchema, RecordSnapshot
from apps.tabdata.handlers._base import RecordHandlerBase


def _handler_with_link_svc(link_svc) -> RecordHandlerBase:
    return RecordHandlerBase(
        record_repository=MagicMock(),
        native_io=MagicMock(),
        unit_of_work=MagicMock(),
        event_bus=MagicMock(),
        field_repository=MagicMock(),
        link_service=link_svc,
        cascade_service=MagicMock(),
        attachment_service=MagicMock(),
    )


class ApplyLinkFieldsHexKeyTests(SimpleTestCase):
    def test_hex_key_triggers_set_link_cell_and_rebuilds_title(self):
        field_id = uuid4()
        record_id = uuid4()
        target_id = str(uuid4())
        link_field = FieldSchema(
            id=field_id,
            name="关联字段",
            field_type="link",
            config={"relationship": "ManyMany", "foreignTableId": str(uuid4())},
        )
        existing = RecordSnapshot(
            id=record_id,
            table_id=uuid4(),
            formatted_data={},
            version=1,
        )
        rebuilt = [{"id": target_id, "title": "REC-EDT-001"}]
        link_svc = MagicMock()
        link_svc.set_link_cell.return_value = rebuilt

        handler = _handler_with_link_svc(link_svc)
        patch = {
            field_id.hex: [{"id": target_id}],  # _format_record_data shape
        }

        updated = handler._apply_link_fields(patch, existing, [link_field])

        self.assertEqual(updated, [str(field_id)])
        link_svc.set_link_cell.assert_called_once()
        self.assertEqual(patch[str(field_id)], rebuilt)
        self.assertNotIn(field_id.hex, patch)

    def test_explicit_null_on_hex_key_still_clears_links(self):
        field_id = uuid4()
        link_field = FieldSchema(
            id=field_id,
            name="关联字段",
            field_type="link",
            config={"relationship": "ManyMany"},
        )
        existing = RecordSnapshot(
            id=uuid4(),
            table_id=uuid4(),
            formatted_data={},
            version=1,
        )
        link_svc = MagicMock()
        link_svc.set_link_cell.return_value = []

        handler = _handler_with_link_svc(link_svc)
        patch = {field_id.hex: None}

        handler._apply_link_fields(patch, existing, [link_field])

        link_svc.set_link_cell.assert_called_once()
        args = link_svc.set_link_cell.call_args
        self.assertEqual(args.args[2], [])  # linked_ids
        self.assertEqual(patch[str(field_id)], [])
        self.assertNotIn(field_id.hex, patch)

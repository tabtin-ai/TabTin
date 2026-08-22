"""
#5898：整表 restore 副作用合并为常数次

目标：
  - 逐行仍写 ORM / native / RecordHistory
  - 批处理抑制逐行 YDoc / WS / row_count
  - finalize 后 row_count 一次、WS 按 action 聚合（≤3）

运行方式:
    cd apps/tabtin_django
    USE_SQLITE_FOR_TESTS=0 python -m pytest \\
      apps/tabdata/tests/test_5898_restore_batch_side_effects.py -v
"""
from __future__ import annotations

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

import uuid
from unittest import TestCase
from unittest.mock import MagicMock, patch

_REPLAY_MOD = "apps.tabdata.services.record_replay_helper"
_MODELS_MOD = "apps.tabdata.models"
_RECORD_SVC_MOD = "apps.tabdata.services.record_service"
_NATIVE_IO_MOD = "apps.tabdata.native.record_io"


def _fake_record(*, version: int = 1, is_deleted: bool = False, data=None):
    rec = MagicMock()
    rec.id = uuid.uuid4()
    rec.table_id = uuid.uuid4()
    rec.order = 1000.0
    rec.version = version
    rec.is_deleted = is_deleted
    rec.__dict__["data"] = data or {"fld": "old"}
    rec.table = MagicMock()
    rec.table.space_id = uuid.uuid4()
    rec.table.id = rec.table_id
    return rec


class Test5898ReplayBatchSuppress(TestCase):
    def test_batch_suppresses_per_row_side_effects(self):
        from apps.tabdata.services.record_replay_helper import (
            ReplayBatchContext,
            replay_record_state,
        )

        record = _fake_record(version=3, is_deleted=False, data={"fld": "old"})
        native_io = MagicMock()
        field_qs = MagicMock()
        field_qs.__iter__ = MagicMock(return_value=iter([]))
        field_using = MagicMock()
        field_using.filter.return_value = field_qs
        preloaded_fields: list = []

        svc = MagicMock()
        svc.user = None
        batch = ReplayBatchContext(
            table=record.table,
            fields=preloaded_fields,
            suppress_ydoc=True,
            suppress_ws=True,
            suppress_row_count=True,
        )

        with (
            patch(f"{_MODELS_MOD}.RecordHistory.objects") as mock_rh_objects,
            patch(f"{_MODELS_MOD}.RecordHistoryItem.objects") as mock_rhi_objects,
            patch(f"{_REPLAY_MOD}.TableField.objects.using") as mock_field_using,
            patch(f"{_RECORD_SVC_MOD}.next_record_version", return_value=4),
            patch(f"{_NATIVE_IO_MOD}.NativeRecordIO", return_value=native_io),
            patch(f"{_REPLAY_MOD}.read_data", return_value=dict(record.__dict__["data"])),
            patch(
                "apps.tabdata.subscribers._utils.refresh_table_row_count",
            ) as mock_row_count,
            patch(
                "apps.tabdata.subscribers._utils.notify_record_changed_for_rag",
            ),
            patch("apps.tabdata.utils.ydoc_sync.sync_records_to_ydoc") as mock_ydoc,
            patch("apps.tabdata.utils.ws_notify.publish_table_record_event") as mock_ws,
        ):
            mock_rh = MagicMock()
            mock_rh_objects.using.return_value = mock_rh
            mock_rh.create.return_value = MagicMock()
            mock_rhi_objects.using.return_value = MagicMock()

            result = replay_record_state(
                svc,
                record=record,
                next_data={"fld": "new"},
                next_is_deleted=False,
                next_order=float(record.order),
                emit_history=True,
                source="restore_table_to_history",
                version_override=4,
                force_native_sync=True,
                batch=batch,
            )

        self.assertTrue(result.changed)
        self.assertEqual(result.action, "update")
        record.save.assert_called_once()
        mock_rh.create.assert_called_once()
        mock_field_using.assert_not_called()
        mock_row_count.assert_not_called()
        mock_ydoc.assert_not_called()
        mock_ws.assert_not_called()


class Test5898FinalizeRestoreBatch(TestCase):
    def test_finalize_refreshes_row_count_once_and_batches_ws(self):
        from apps.tabdata.services.record_replay_helper import (
            ReplayResult,
            finalize_restore_batch_side_effects,
        )

        table_id = uuid.uuid4()
        create_rec = _fake_record()
        update_rec = _fake_record()
        delete_rec = _fake_record()
        results = [
            ReplayResult(record=create_rec, changed=True, action="create"),
            ReplayResult(record=update_rec, changed=True, action="update"),
            ReplayResult(record=delete_rec, changed=True, action="delete"),
            ReplayResult(record=_fake_record(), changed=False, action="noop"),
        ]

        with (
            patch(
                "apps.tabdata.subscribers._utils.refresh_table_row_count",
            ) as mock_row_count,
            patch("apps.tabdata.utils.ws_notify.publish_table_record_event") as mock_ws,
        ):
            finalize_restore_batch_side_effects(
                table_id=table_id,
                changed_results=results,
                user_id="u1",
            )

        mock_row_count.assert_called_once_with(table_id)
        self.assertEqual(mock_ws.call_count, 3)
        actions = {call.kwargs["action"] for call in mock_ws.call_args_list}
        self.assertEqual(
            actions,
            {"create_record", "update_record", "delete_record"},
        )
        for call in mock_ws.call_args_list:
            self.assertEqual(call.kwargs["table_id"], table_id)
            self.assertEqual(len(call.kwargs["record_ids"]), 1)

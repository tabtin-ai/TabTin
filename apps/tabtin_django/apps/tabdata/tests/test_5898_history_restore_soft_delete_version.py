"""
#5898 / ：history-restore 软删必须跳过 native 乐观锁

根因：
  TableHistoryModal → POST .../history-restore → restore_table_to_history
  → replay_record_state(action=delete) 曾用 ORM old_version 调 delete_record。
  增量导入后 native __version 与 ORM 分叉时，软删撞乐观锁 → RuntimeError，
  再被吞成 None → API「表格不存在」/ 前端「还原失败」。

修复：
  source 含 restore 时 soft_delete 用 version=0（与 collab restore_from_snapshot 对齐）。

运行方式:
    cd apps/tabtin_django
    USE_SQLITE_FOR_TESTS=0 python -m pytest \\
      apps/tabdata/tests/test_5898_history_restore_soft_delete_version.py -v
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


def _fake_record(*, version: int = 33, is_deleted: bool = False):
    rec = MagicMock()
    rec.id = uuid.uuid4()
    rec.table_id = uuid.uuid4()
    rec.order = 1000.0
    rec.version = version
    rec.is_deleted = is_deleted
    rec.__dict__["data"] = {"fld": "val"}
    rec.table = MagicMock()
    rec.table.space_id = uuid.uuid4()
    rec.table.id = rec.table_id
    return rec


def _run_delete_replay(*, source: str, version: int = 33):
    from apps.tabdata.services.record_replay_helper import replay_record_state

    record = _fake_record(version=version, is_deleted=False)
    native_io = MagicMock()
    field_qs = MagicMock()
    field_qs.__iter__ = MagicMock(return_value=iter([]))
    field_using = MagicMock()
    field_using.filter.return_value = field_qs

    svc = MagicMock()
    svc.user = None
    svc._publish_table_event = MagicMock()

    with (
        patch(f"{_MODELS_MOD}.RecordHistory.objects") as mock_rh_objects,
        patch(f"{_MODELS_MOD}.RecordHistoryItem.objects") as mock_rhi_objects,
        patch(f"{_REPLAY_MOD}.TableField.objects.using", return_value=field_using),
        patch(f"{_RECORD_SVC_MOD}.next_record_version", return_value=version + 1),
        patch(f"{_NATIVE_IO_MOD}.NativeRecordIO", return_value=native_io),
        patch(f"{_RECORD_SVC_MOD}._sync_records_to_ydoc"),
        patch("apps.tabdata.services.view_version_sync.mark_table_record_delete_version"),
        patch(f"{_REPLAY_MOD}.read_data", return_value=dict(record.__dict__["data"])),
        patch(f"{_REPLAY_MOD}.refresh_table_row_count", create=True),
    ):
        mock_rh_objects.using.return_value = MagicMock()
        mock_rhi_objects.using.return_value = MagicMock()
        # refresh_table_row_count / notify 在 save 后从 subscribers 导入；一并挡住
        with (
            patch(
                "apps.tabdata.subscribers._utils.refresh_table_row_count",
            ),
            patch(
                "apps.tabdata.subscribers._utils.notify_record_changed_for_rag",
            ),
            patch(f"{_REPLAY_MOD}.publish_table_record_event", create=True),
            patch("apps.tabdata.utils.ws_notify.publish_table_record_event"),
        ):
            result = replay_record_state(
                svc,
                record=record,
                next_data=dict(record.__dict__["data"]),
                next_is_deleted=True,
                next_order=float(record.order),
                emit_history=False,
                source=source,
                user=None,
            )

    return result, native_io, record


class Test5898HistoryRestoreSoftDeleteVersion(TestCase):
    """#5898: restore 路径软删必须 version=0；非 restore 仍走乐观锁。"""

    def test_restore_table_source_soft_deletes_with_version_zero(self):
        result, native_io, record = _run_delete_replay(
            source="restore_table_to_history",
            version=33,
        )

        self.assertTrue(result.changed)
        self.assertEqual(result.action, "delete")
        native_io.delete_record.assert_called_once()
        kwargs = native_io.delete_record.call_args.kwargs
        self.assertEqual(kwargs["record_id"], record.id)
        self.assertEqual(
            kwargs["version"],
            0,
            "#5898: restore 软删必须 version=0，跳过 native 乐观锁",
        )

    def test_restore_record_source_soft_deletes_with_version_zero(self):
        result, native_io, _record = _run_delete_replay(
            source="restore_record_to_history",
            version=5,
        )

        self.assertTrue(result.changed)
        self.assertEqual(
            native_io.delete_record.call_args.kwargs["version"],
            0,
        )

    def test_undo_delete_keeps_optimistic_lock_version(self):
        result, native_io, record = _run_delete_replay(
            source="undo",
            version=33,
        )

        self.assertTrue(result.changed)
        self.assertEqual(
            native_io.delete_record.call_args.kwargs["version"],
            33,
            "非 restore 删除仍应携带 ORM old_version 做乐观锁",
        )
        self.assertEqual(
            native_io.delete_record.call_args.kwargs["record_id"],
            record.id,
        )


class Test5898HistoryRestoreSyncMode(TestCase):
    """整表还原必须把服务端协作同步模式透给前端。"""

    @patch("apps.collab.api._resync_or_force_close")
    def test_returns_resync_mode(self, mock_resync):
        from apps.tabdata.api_undo_redo import _resync_collab_after_history_restore

        table_id = uuid.uuid4()
        mock_resync.return_value = {
            "success": True,
            "sync_mode": "resync",
            "fc": None,
        }

        self.assertEqual(_resync_collab_after_history_restore(table_id), "resync")
        mock_resync.assert_called_once_with("table", str(table_id))

    @patch("apps.collab.api._resync_or_force_close", side_effect=RuntimeError("boom"))
    def test_returns_failed_mode_when_collab_notification_raises(self, _mock_resync):
        from apps.tabdata.api_undo_redo import _resync_collab_after_history_restore

        self.assertEqual(
            _resync_collab_after_history_restore(uuid.uuid4()),
            "failed",
        )

    def test_restore_response_serializes_sync_mode(self):
        from apps.tabdata.schemas import RestoreTableResponse

        response = RestoreTableResponse(
            table_id=str(uuid.uuid4()),
            history_id=str(uuid.uuid4()),
            changed_records=11,
            changed_histories=11,
            sync_mode="resync",
        )

        self.assertEqual(response.model_dump()["sync_mode"], "resync")

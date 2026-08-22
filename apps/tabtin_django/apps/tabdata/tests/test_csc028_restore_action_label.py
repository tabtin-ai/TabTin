"""
CSC-028 回归测试

问题：_resolve_replay_action 只返回 'create'/'delete'/'update'，
      restore 操作在历史时间线上显示为 'update'，用户无法识别哪些操作是"还原"操作。

修复：replay_record_state 在 source 包含 "restore" 时，
      写入 RecordHistory 的 action 字段使用 "restore" 而非 _resolve_replay_action 的返回值。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/tabdata/tests/test_csc028_restore_action_label.py -v
"""
from __future__ import annotations

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import uuid
from unittest import TestCase
from unittest.mock import MagicMock, patch, call

_REPLAY_MOD = "apps.tabdata.services.record_replay_helper"


def _fake_record(data=None, order=1000.0, is_deleted=False):
    rec = MagicMock()
    rec.id = uuid.uuid4()
    rec.table_id = uuid.uuid4()
    rec.order = order
    rec.is_deleted = is_deleted
    rec.__dict__["data"] = data or {}
    rec.table = MagicMock()
    rec.table.space_id = uuid.uuid4()
    rec.table.id = rec.table_id
    return rec


def _fake_field(field_type="text"):
    f = MagicMock()
    f.id = uuid.uuid4()
    f.field_type = field_type
    f.config = {}
    f.is_deleted = False
    return f


def _run_replay(record, next_data, next_is_deleted, source, emit_history=True):
    """
    执行 replay_record_state 并返回写入 RecordHistory 的参数。

    注意：RecordHistory / RecordHistoryItem 是在函数内部通过
    `from apps.tabdata.models import ...` 延迟导入的，
    因此需要 mock apps.tabdata.models 中的对象，而非 replay_mod 中的属性。
    """
    from apps.tabdata.services.record_replay_helper import replay_record_state

    history_created = []
    history_using = MagicMock()

    def _create_history(**kwargs):
        h = MagicMock()
        h.action = kwargs.get("action")
        h.field_changes = kwargs.get("field_changes", {})
        history_created.append(h)
        return h

    history_using.create.side_effect = _create_history

    items_using = MagicMock()
    items_using.bulk_create.return_value = []

    field_qs = MagicMock()
    field_qs.__iter__ = MagicMock(return_value=iter([]))
    field_using = MagicMock()
    field_using.filter.return_value = field_qs

    svc = MagicMock()
    svc.user = None
    svc._publish_table_event = MagicMock()

    _MODELS_MOD = "apps.tabdata.models"
    _RECORD_SVC_MOD = "apps.tabdata.services.record_service"
    _NATIVE_IO_MOD = "apps.tabdata.native.record_io"

    with (
        patch(f"{_MODELS_MOD}.RecordHistory.objects") as mock_rh_objects,
        patch(f"{_MODELS_MOD}.RecordHistoryItem.objects") as mock_rhi_objects,
        patch(f"{_REPLAY_MOD}.TableField.objects.using", return_value=field_using),
        patch(f"{_RECORD_SVC_MOD}.next_record_version", return_value=100),
        patch(f"{_NATIVE_IO_MOD}.NativeRecordIO", return_value=MagicMock()),
        patch(f"{_RECORD_SVC_MOD}._sync_records_to_ydoc"),
        patch(f"{_REPLAY_MOD}.read_data", return_value=record.__dict__.get("data", {})),
    ):
        mock_rh_objects.using.return_value = history_using
        mock_rhi_objects.using.return_value = items_using

        result = replay_record_state(
            svc,
            record=record,
            next_data=next_data,
            next_is_deleted=next_is_deleted,
            next_order=float(record.order),
            emit_history=emit_history,
            source=source,
            user=None,
        )

    return result, history_created


class TestCSC028RestoreActionLabel(TestCase):
    """CSC-028: restore 操作产生的 RecordHistory.action 必须为 'restore'"""

    def test_restore_source_produces_restore_action_on_update(self):
        """source='restore_table_to_history' 时，字段更新应产生 action='restore' 而非 'update'"""
        field_id = uuid.uuid4().hex
        record = _fake_record(data={field_id: "old_value"}, is_deleted=False)

        result, histories = _run_replay(
            record,
            next_data={field_id: "new_value"},
            next_is_deleted=False,
            source="restore_table_to_history",
        )

        self.assertTrue(result.changed, "数据有变更，changed 应为 True")
        self.assertEqual(len(histories), 1, "应写入一条 RecordHistory")
        self.assertEqual(histories[0].action, "restore",
                         "CSC-028: restore 操作的 action 必须为 'restore' 而非 'update'")

    def test_restore_source_produces_restore_action_on_create(self):
        """source='restore_table_to_history' 时，从删除恢复的记录应产生 action='restore' 而非 'create'"""
        field_id = uuid.uuid4().hex
        record = _fake_record(data={field_id: "val"}, is_deleted=True)

        result, histories = _run_replay(
            record,
            next_data={field_id: "val"},
            next_is_deleted=False,
            source="restore_table_to_history",
        )

        self.assertTrue(result.changed, "is_deleted 变化，changed 应为 True")
        self.assertEqual(len(histories), 1)
        self.assertEqual(histories[0].action, "restore",
                         "CSC-028: 从删除恢复的记录 action 必须为 'restore' 而非 'create'")

    def test_restore_source_produces_restore_action_on_delete(self):
        """source='restore_table_to_history' 时，快照中不存在的记录（软删）应产生 action='restore'"""
        field_id = uuid.uuid4().hex
        record = _fake_record(data={field_id: "val"}, is_deleted=False)

        result, histories = _run_replay(
            record,
            next_data={field_id: "val"},
            next_is_deleted=True,
            source="restore_table_to_history",
        )

        self.assertTrue(result.changed)
        self.assertEqual(len(histories), 1)
        self.assertEqual(histories[0].action, "restore",
                         "CSC-028: restore 路径软删记录的 action 必须为 'restore' 而非 'delete'")

    def test_restore_record_source_also_produces_restore_action(self):
        """source='restore_record_to_history' 也应产生 action='restore'"""
        field_id = uuid.uuid4().hex
        record = _fake_record(data={field_id: "before"}, is_deleted=False)

        result, histories = _run_replay(
            record,
            next_data={field_id: "after"},
            next_is_deleted=False,
            source="restore_record_to_history",
        )

        self.assertTrue(result.changed)
        self.assertEqual(len(histories), 1)
        self.assertEqual(histories[0].action, "restore",
                         "CSC-028: restore_record_to_history 的 action 必须为 'restore'")

    def test_non_restore_source_produces_update_action(self):
        """非 restore source（如 'undo'、'replay'）不应受影响，仍产生 'update'"""
        field_id = uuid.uuid4().hex
        record = _fake_record(data={field_id: "old"}, is_deleted=False)

        result, histories = _run_replay(
            record,
            next_data={field_id: "new"},
            next_is_deleted=False,
            source="replay",
        )

        self.assertTrue(result.changed)
        self.assertEqual(len(histories), 1)
        self.assertEqual(histories[0].action, "update",
                         "非 restore source 的 action 应为 'update'")

    def test_undo_source_produces_update_action(self):
        """source='undo' 不应产生 'restore' action"""
        field_id = uuid.uuid4().hex
        record = _fake_record(data={field_id: "old"}, is_deleted=False)

        result, histories = _run_replay(
            record,
            next_data={field_id: "new"},
            next_is_deleted=False,
            source="undo",
        )

        self.assertTrue(result.changed)
        self.assertEqual(len(histories), 1)
        self.assertEqual(histories[0].action, "update",
                         "undo source 的 action 应为 'update'，不应误判为 restore")

    def test_no_change_skips_history(self):
        """数据无变更时不写入 RecordHistory（noop 路径不受影响）"""
        field_id = uuid.uuid4().hex
        record = _fake_record(data={field_id: "same"}, is_deleted=False)

        result, histories = _run_replay(
            record,
            next_data={field_id: "same"},
            next_is_deleted=False,
            source="restore_table_to_history",
        )

        self.assertFalse(result.changed)
        self.assertEqual(result.action, "noop")
        self.assertEqual(len(histories), 0, "noop 时不应写入 RecordHistory")

    def test_emit_history_false_skips_history_regardless_of_source(self):
        """emit_history=False 时，无论 source 是否为 restore，都不写入 RecordHistory"""
        field_id = uuid.uuid4().hex
        record = _fake_record(data={field_id: "old"}, is_deleted=False)

        result, histories = _run_replay(
            record,
            next_data={field_id: "new"},
            next_is_deleted=False,
            source="restore_table_to_history",
            emit_history=False,
        )

        self.assertTrue(result.changed)
        self.assertEqual(len(histories), 0, "emit_history=False 时不应写入 RecordHistory")

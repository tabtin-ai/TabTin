"""
DV-006 / DV-010 / DV-022 回归测试

DV-006: restore_from_snapshot 必须写入 action="restore" 的 RecordHistory，
        使 reconstruct_table_at_history 能跨越 restore 节点正确反向回放。
DV-010: reconstruct_table_at_history 不应过滤 is_undone=False，
        已撤销操作必须参与反向回放以保证时间点重建的正确性。
DV-022: (DV-006 联动修复) reconstruct_table_at_history 跨越 restore 节点时
        应正确利用 restore 历史条目还原到 restore 之前的状态。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/tabdata/tests/test_dv006_dv010_dv022_restore_history.py -v
"""
from __future__ import annotations

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import uuid
from contextlib import contextmanager
from datetime import datetime, timezone as dt_tz
from unittest import TestCase
from unittest.mock import MagicMock, patch

_COLLAB_MOD = "apps.tabdata.services.collab_service"
_UNDO_MOD = "apps.tabdata.services.undo_redo_service"


@contextmanager
def _noop_atomic(using=None, savepoint=True, durable=False):
    yield


def _fake_field(name: str, field_type: str = "text", order: int = 0) -> MagicMock:
    field = MagicMock()
    field.id = uuid.uuid4()
    field.name = name
    field.field_type = field_type
    field.order = order
    field.config = {}
    field.is_deleted = False
    return field


def _fake_table() -> MagicMock:
    t = MagicMock()
    t.id = uuid.uuid4()
    t.space_id = uuid.uuid4()
    t.record_version_seq = 10
    t.schema_version = 1
    t.is_archived = False
    return t


def _hex(uid: uuid.UUID) -> str:
    return uid.hex


def _fake_record(rid, data=None, order=0.0, is_deleted=False):
    rec = MagicMock()
    rec.id = rid if isinstance(rid, uuid.UUID) else uuid.UUID(rid)
    rec.data = data or {}
    rec.order = order
    rec.is_deleted = is_deleted
    rec.__dict__["data"] = rec.data
    return rec


# ====================================================================
# DV-006: restore_from_snapshot 写入 RecordHistory
# ====================================================================

def _run_restore_with_history(table, fields, existing_id_strs, snapshot,
                              existing_records=None, *, version_ret=42):
    """
    运行 restore_from_snapshot 并捕获 RecordHistory / RecordHistoryItem 的写入。
    """
    from apps.tabdata.services.collab_service import CollabService

    existing_uuids = {uuid.UUID(s) for s in existing_id_strs}
    old_recs = existing_records or []
    old_rec_map = {str(r.id): r for r in old_recs}

    record_using = MagicMock()

    def _rec_filter(**kwargs):
        qs = MagicMock()
        if 'id__in' in kwargs:
            matched = [old_rec_map[str(uid)] for uid in kwargs['id__in']
                       if str(uid) in old_rec_map]

            def _only(*_fields):
                result = MagicMock()
                result.__iter__ = MagicMock(return_value=iter(matched))
                return result
            qs.only = _only
            qs.__iter__ = MagicMock(return_value=iter(matched))
            return qs
        qs.select_for_update.return_value.values_list.return_value = existing_uuids
        qs.values_list.return_value = existing_uuids
        qs.update.return_value = 1
        return qs

    record_using.filter.side_effect = _rec_filter
    record_using.create.side_effect = lambda **kw: MagicMock(id=kw.get("id"))

    field_qs = MagicMock()
    field_qs.__iter__ = MagicMock(return_value=iter(fields))
    field_qs.update.return_value = 0
    field_using = MagicMock()
    field_using.filter.return_value = field_qs

    history_created: list = []
    history_using = MagicMock()
    history_using.bulk_create.side_effect = lambda objs, **kw: history_created.extend(objs)

    items_created: list = []
    items_using = MagicMock()
    items_using.bulk_create.side_effect = lambda objs, **kw: items_created.extend(objs)

    with (
        patch(f"{_COLLAB_MOD}.Table.objects.using") as t_using,
        patch(f"{_COLLAB_MOD}.TableField.objects.using", return_value=field_using),
        patch(f"{_COLLAB_MOD}.TableRecord.objects.using", return_value=record_using),
        patch(f"{_COLLAB_MOD}.NativeRecordIO", return_value=MagicMock()),
        patch(f"{_COLLAB_MOD}.next_record_version", return_value=version_ret),
        patch(f"{_COLLAB_MOD}.table_event_service"),
        patch(f"{_COLLAB_MOD}.python_to_pg", side_effect=lambda v, ft, cfg: v),
        patch(f"{_COLLAB_MOD}.transaction.atomic", side_effect=_noop_atomic),
        patch(f"{_COLLAB_MOD}.RecordHistory.objects.using", return_value=history_using),
        patch(f"{_COLLAB_MOD}.RecordHistoryItem.objects.using", return_value=items_using),
    ):
        t_using.return_value.filter.return_value.first.return_value = table
        t_using.return_value.filter.return_value.update.return_value = 1

        CollabService.restore_from_snapshot(table.id, snapshot)

    return {
        "histories": history_created,
        "items": items_created,
    }


class TestDV006RestoreWritesHistory(TestCase):
    """DV-006: restore_from_snapshot 必须写入 RecordHistory 标记 restore 节点"""

    def test_deleted_records_produce_restore_history(self):
        """被删除的记录应产生 action=restore、_deleted={old:False,new:True} 的历史"""
        table = _fake_table()
        field_a = _fake_field("A")
        del_rid = str(uuid.uuid4())

        old_rec = _fake_record(del_rid, data={_hex(field_a.id): "v1"}, order=1000.0)
        snapshot = {"records": {}, "row_order": [], "fields": []}

        result = _run_restore_with_history(
            table, [field_a], {del_rid}, snapshot,
            existing_records=[old_rec],
        )

        hists = result["histories"]
        self.assertTrue(len(hists) > 0, "DV-006: restore 应写入 RecordHistory")
        h = next(h for h in hists if str(h.record_id) == del_rid)
        self.assertEqual(h.action, "restore")
        self.assertEqual(h.field_changes["_deleted"], {"old": False, "new": True})
        self.assertIn(_hex(field_a.id), h.field_changes)
        self.assertEqual(h.field_changes[_hex(field_a.id)]["old"], "v1")
        self.assertIsNone(h.field_changes[_hex(field_a.id)]["new"])

    def test_created_records_produce_restore_history(self):
        """新增的记录应产生 action=restore、_deleted={old:True,new:False} 的历史"""
        table = _fake_table()
        field_a = _fake_field("A")
        new_rid = str(uuid.uuid4())

        snapshot = {
            "records": {new_rid: {_hex(field_a.id): "val"}},
            "row_order": [new_rid],
            "fields": [],
        }
        result = _run_restore_with_history(table, [field_a], set(), snapshot)

        hists = result["histories"]
        h = next(h for h in hists if str(h.record_id) == new_rid)
        self.assertEqual(h.action, "restore")
        self.assertEqual(h.field_changes["_deleted"], {"old": True, "new": False})
        self.assertEqual(h.field_changes[_hex(field_a.id)], {"old": None, "new": "val"})

    def test_updated_records_produce_restore_history_with_diff(self):
        """更新的记录应产生包含字段级 diff 的 restore 历史"""
        table = _fake_table()
        field_a = _fake_field("A")
        upd_rid = str(uuid.uuid4())

        old_rec = _fake_record(upd_rid, data={_hex(field_a.id): "old"}, order=1000.0)
        snapshot = {
            "records": {upd_rid: {_hex(field_a.id): "new"}},
            "row_order": [upd_rid],
            "fields": [],
        }
        result = _run_restore_with_history(
            table, [field_a], {upd_rid}, snapshot,
            existing_records=[old_rec],
        )

        hists = result["histories"]
        h = next(h for h in hists if str(h.record_id) == upd_rid)
        self.assertEqual(h.action, "restore")
        fc = h.field_changes
        self.assertEqual(fc[_hex(field_a.id)], {"old": "old", "new": "new"})

    def test_no_change_records_skip_history(self):
        """数据未变更的记录不应产生 restore 历史"""
        table = _fake_table()
        field_a = _fake_field("A")
        rid = str(uuid.uuid4())

        old_rec = _fake_record(rid, data={_hex(field_a.id): "same"}, order=1000.0)
        snapshot = {
            "records": {rid: {_hex(field_a.id): "same"}},
            "row_order": [rid],
            "fields": [],
        }
        result = _run_restore_with_history(
            table, [field_a], {rid}, snapshot,
            existing_records=[old_rec],
        )

        hists = [h for h in result["histories"] if str(h.record_id) == rid]
        self.assertEqual(len(hists), 0, "数据未变更的记录不应产生 restore 历史")

    def test_all_histories_share_operation_group(self):
        """同一次 restore 产生的所有历史应共享 operation_group_id"""
        table = _fake_table()
        field_a = _fake_field("A")
        del_rid = str(uuid.uuid4())
        new_rid = str(uuid.uuid4())

        old_rec = _fake_record(del_rid, data={_hex(field_a.id): "x"}, order=1000.0)
        snapshot = {
            "records": {new_rid: {_hex(field_a.id): "y"}},
            "row_order": [new_rid],
            "fields": [],
        }
        result = _run_restore_with_history(
            table, [field_a], {del_rid}, snapshot,
            existing_records=[old_rec],
        )

        hists = result["histories"]
        self.assertEqual(len(hists), 2)
        groups = {h.operation_group_id for h in hists}
        self.assertEqual(len(groups), 1, "所有 restore 历史应共享同一 operation_group_id")
        self.assertIsNotNone(list(groups)[0])

    def test_history_items_created(self):
        """restore 应同时写入 RecordHistoryItem 字段级明细"""
        table = _fake_table()
        field_a = _fake_field("A")
        new_rid = str(uuid.uuid4())

        snapshot = {
            "records": {new_rid: {_hex(field_a.id): "v"}},
            "row_order": [new_rid],
            "fields": [],
        }
        result = _run_restore_with_history(table, [field_a], set(), snapshot)

        items = result["items"]
        self.assertTrue(len(items) > 0, "DV-006: restore 应写入 RecordHistoryItem")
        field_keys = {item.field_key for item in items}
        self.assertIn("_deleted", field_keys)
        self.assertIn(_hex(field_a.id), field_keys)


# ====================================================================
# DV-010: reconstruct_table_at_history 不应过滤 is_undone
# ====================================================================

class TestDV010ReconstructIncludesUndone(TestCase):
    """DV-010: reconstruct_table_at_history 不应过滤 is_undone=False"""

    def _make_service(self):
        from apps.tabdata.services.undo_redo_service import UndoRedoService
        svc = UndoRedoService.__new__(UndoRedoService)
        svc.user = MagicMock()
        svc.user.id = uuid.uuid4()
        svc.window_id = None
        svc._record_service = None
        svc.stack_service = MagicMock()
        svc.operation_service = MagicMock()
        return svc

    def test_query_does_not_filter_is_undone(self):
        """后续历史查询不应包含 is_undone 过滤条件"""
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        history_id = uuid.uuid4()

        target_hist = MagicMock()
        target_hist.id = history_id
        target_hist.created_at = datetime(2026, 1, 1, tzinfo=dt_tz.utc)

        filter_kwargs_log: list = []

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_hist,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_rec,
        ):
            hist_using = MagicMock()

            def _capture_filter(**kw):
                filter_kwargs_log.append(kw)
                qs = MagicMock()
                if 'id' in kw:
                    qs.only.return_value = qs
                    qs.first.return_value = target_hist
                else:
                    qs.only.return_value.order_by.return_value = iter([])
                return qs

            hist_using.filter.side_effect = _capture_filter
            mock_hist.using.return_value = hist_using

            rec_using = MagicMock()
            rec_using.filter.return_value.only.return_value = iter([])
            mock_rec.using.return_value = rec_using

            svc.reconstruct_table_at_history(table_id, history_id)

        later_q = [k for k in filter_kwargs_log if 'created_at__gt' in k]
        self.assertTrue(len(later_q) > 0, "应有 created_at__gt 查询")
        for kw in later_q:
            self.assertNotIn(
                'is_undone', kw,
                "DV-010: 后续历史查询不应包含 is_undone 过滤条件",
            )

    def test_undone_ops_reverse_correctly(self):
        """
        DV-010 数据级回归：
        Op A(T1, undone): x 0→1; Op B(T2, active): x 1→2
        undo A 后 current x=0. 重建 T0 应得 x=0（反向回放 A+B），
        若错误过滤 is_undone 只回放 B，则得 x=1。
        """
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        record_id = uuid.uuid4()

        target_hist = MagicMock()
        target_hist.id = uuid.uuid4()
        target_hist.created_at = datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt_tz.utc)

        hist_a = MagicMock()
        hist_a.record_id = record_id
        hist_a.action = "update"
        hist_a.field_changes = {"fx": {"old": 0, "new": 1}}
        hist_a.created_at = datetime(2026, 1, 1, 1, 0, 0, tzinfo=dt_tz.utc)
        hist_a.is_undone = True

        hist_b = MagicMock()
        hist_b.record_id = record_id
        hist_b.action = "update"
        hist_b.field_changes = {"fx": {"old": 1, "new": 2}}
        hist_b.created_at = datetime(2026, 1, 1, 2, 0, 0, tzinfo=dt_tz.utc)
        hist_b.is_undone = False

        cur_rec = MagicMock()
        cur_rec.id = record_id
        cur_rec.data = {"fx": 0}
        cur_rec.order = 1000.0
        cur_rec.is_deleted = False
        cur_rec.__dict__["data"] = {"fx": 0}

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_hist,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_rec,
            patch(f"{_UNDO_MOD}.read_data", return_value={"fx": 0}),
        ):
            hist_using = MagicMock()

            def _filter(**kw):
                qs = MagicMock()
                if 'id' in kw:
                    qs.only.return_value = qs
                    qs.first.return_value = target_hist
                else:
                    qs.only.return_value.order_by.return_value = [hist_b, hist_a]
                return qs

            hist_using.filter.side_effect = _filter
            mock_hist.using.return_value = hist_using

            rec_using = MagicMock()
            rec_using.filter.return_value.only.return_value = [cur_rec]
            mock_rec.using.return_value = rec_using

            result = svc.reconstruct_table_at_history(table_id, target_hist.id)

        self.assertIsNotNone(result)
        self.assertEqual(len(result), 1)
        self.assertEqual(
            result[0]["data"]["fx"], 0,
            "DV-010: 反向回放应包含已撤销操作 A，得到 x=0 而非 x=1",
        )

    def test_delete_history_preview_can_include_target_deleted_row(self):
        """删除版本预览可返回刚删除的行，但默认重建仍只返回未删除行。"""
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        record_id = uuid.uuid4()

        target_hist = MagicMock()
        target_hist.id = uuid.uuid4()
        target_hist.record_id = record_id
        target_hist.action = "delete"
        target_hist.field_changes = {"_deleted": {"old": False, "new": True}}
        target_hist.created_at = datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt_tz.utc)
        target_hist.operation_group_id = None

        cur_rec = MagicMock()
        cur_rec.id = record_id
        cur_rec.data = {"fx": "deleted-row"}
        cur_rec.order = 1000.0
        cur_rec.is_deleted = True
        cur_rec.__dict__["data"] = {"fx": "deleted-row"}

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_hist,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_rec,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field,
            patch(f"{_UNDO_MOD}.read_data", return_value={"fx": "deleted-row"}),
        ):
            hist_using = MagicMock()

            def _filter(**kw):
                qs = MagicMock()
                if 'id' in kw:
                    qs.only.return_value = qs
                    qs.first.return_value = target_hist
                else:
                    qs.only.return_value.order_by.return_value = []
                return qs

            hist_using.filter.side_effect = _filter
            mock_hist.using.return_value = hist_using

            rec_using = MagicMock()
            rec_using.filter.return_value.only.return_value = [cur_rec]
            mock_rec.using.return_value = rec_using
            mock_field.using.return_value.filter.return_value.only.return_value = []

            default_result = svc.reconstruct_table_at_history(table_id, target_hist.id)
            preview_result = svc.reconstruct_table_at_history(
                table_id,
                target_hist.id,
                include_target_deleted_records=True,
            )

        self.assertEqual(default_result, [])
        self.assertIsNotNone(preview_result)
        self.assertEqual(len(preview_result), 1)
        self.assertEqual(preview_result[0]["record_id"], str(record_id))
        self.assertTrue(preview_result[0]["is_deleted"])
        self.assertEqual(preview_result[0]["data"]["fx"], "deleted-row")

    def test_preview_snapshot_includes_records_deleted_before_target(self):
        """历史预览应包含目标时间点已存在但处于删除态的记录。"""
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        deleted_record_id = uuid.uuid4()

        target_hist = MagicMock()
        target_hist.id = uuid.uuid4()
        target_hist.record_id = uuid.uuid4()
        target_hist.action = "update"
        target_hist.field_changes = {"fx": {"old": "a", "new": "b"}}
        target_hist.created_at = datetime(2026, 1, 2, 0, 0, 0, tzinfo=dt_tz.utc)
        target_hist.operation_group_id = None

        cur_rec = MagicMock()
        cur_rec.id = deleted_record_id
        cur_rec.data = {"fx": "deleted-before-target"}
        cur_rec.order = 1000.0
        cur_rec.is_deleted = True
        cur_rec.__dict__["data"] = {"fx": "deleted-before-target"}

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_hist,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_rec,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field,
            patch(f"{_UNDO_MOD}.read_data", return_value={"fx": "deleted-before-target"}),
        ):
            hist_using = MagicMock()

            def _filter(**kw):
                qs = MagicMock()
                if 'id' in kw:
                    qs.only.return_value = qs
                    qs.first.return_value = target_hist
                else:
                    qs.only.return_value.order_by.return_value = []
                return qs

            hist_using.filter.side_effect = _filter
            mock_hist.using.return_value = hist_using

            rec_using = MagicMock()
            rec_using.filter.return_value.only.return_value = [cur_rec]
            mock_rec.using.return_value = rec_using
            mock_field.using.return_value.filter.return_value.only.return_value = []

            default_result = svc.reconstruct_table_at_history(table_id, target_hist.id)
            preview_result = svc.reconstruct_table_at_history(
                table_id,
                target_hist.id,
                include_target_deleted_records=True,
            )

        self.assertEqual(default_result, [])
        self.assertEqual(len(preview_result), 1)
        self.assertEqual(preview_result[0]["record_id"], str(deleted_record_id))
        self.assertTrue(preview_result[0]["is_deleted"])

    def test_preview_snapshot_excludes_records_created_after_target(self):
        """历史预览不应把目标时间点之后才新增的未来记录带回来。"""
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        future_record_id = uuid.uuid4()

        target_hist = MagicMock()
        target_hist.id = uuid.uuid4()
        target_hist.record_id = uuid.uuid4()
        target_hist.action = "update"
        target_hist.field_changes = {"fx": {"old": "a", "new": "b"}}
        target_hist.created_at = datetime(2026, 1, 2, 0, 0, 0, tzinfo=dt_tz.utc)

        create_hist = MagicMock()
        create_hist.record_id = future_record_id
        create_hist.action = "create"
        create_hist.field_changes = {"fx": {"old": None, "new": "future"}}
        create_hist.created_at = datetime(2026, 1, 3, 0, 0, 0, tzinfo=dt_tz.utc)

        cur_rec = MagicMock()
        cur_rec.id = future_record_id
        cur_rec.data = {"fx": "future"}
        cur_rec.order = 1000.0
        cur_rec.is_deleted = False
        cur_rec.__dict__["data"] = {"fx": "future"}

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_hist,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_rec,
            patch(f"{_UNDO_MOD}.read_data", return_value={"fx": "future"}),
        ):
            hist_using = MagicMock()

            def _filter(**kw):
                qs = MagicMock()
                if 'id' in kw:
                    qs.only.return_value = qs
                    qs.first.return_value = target_hist
                else:
                    qs.only.return_value.order_by.return_value = [create_hist]
                return qs

            hist_using.filter.side_effect = _filter
            mock_hist.using.return_value = hist_using

            rec_using = MagicMock()
            rec_using.filter.return_value.only.return_value = [cur_rec]
            mock_rec.using.return_value = rec_using

            preview_result = svc.reconstruct_table_at_history(
                table_id,
                target_hist.id,
                include_target_deleted_records=True,
            )

        self.assertEqual(preview_result, [])


# ====================================================================
# DV-022: reconstruct_table_at_history 跨越 restore 节点
# ====================================================================

class TestDV022ReconstructAcrossRestore(TestCase):
    """DV-022: reconstruct_table_at_history 应能正确跨越 restore 节点"""

    def _make_service(self):
        from apps.tabdata.services.undo_redo_service import UndoRedoService
        svc = UndoRedoService.__new__(UndoRedoService)
        svc.user = MagicMock()
        svc.user.id = uuid.uuid4()
        svc.window_id = None
        svc._record_service = None
        svc.stack_service = MagicMock()
        svc.operation_service = MagicMock()
        return svc

    def test_restore_changelog_is_included_in_table_history(self):
        """还原操作写入 ChangeLog 后，也应进入表格历史版本列表。"""
        svc = self._make_service()
        table_id = uuid.uuid4()
        target_history_id = uuid.uuid4()
        restore_log_id = uuid.uuid4()

        change_log = MagicMock()
        change_log.id = restore_log_id
        change_log.change_type = "restore"
        change_log.changes = {
            "history_id": str(target_history_id),
            "changed_records": 0,
            "changed_fields": 1,
        }
        change_log.editor_id = str(svc.user.id)
        change_log.editor_name = "Alice"
        change_log.editor_type = "user"
        change_log.agent_run_id = ""
        change_log.created_at = datetime(2026, 6, 20, 4, 30, 0, tzinfo=dt_tz.utc)

        with patch("apps.collab.models.ChangeLog.objects") as mock_change_log:
            query = MagicMock()
            query.order_by.return_value = [change_log]
            mock_change_log.using.return_value.filter.return_value = query

            operations = svc._build_field_change_history_operations(table_id)

        self.assertEqual(len(operations), 1)
        self.assertEqual(operations[0]["id"], str(restore_log_id))
        self.assertEqual(operations[0]["action"], "restore")
        self.assertEqual(
            operations[0]["action_display"],
            f"还原到版本 {str(target_history_id)[:8]}",
        )
        self.assertEqual(operations[0]["items"][0]["field_name"], "版本还原")

    def test_restore_history_entry_reversed_correctly(self):
        """
        DV-022 回归：restore 将 x 从 "A" 覆写为 "B"，
        reconstruct 到 restore 之前的时间点应还原为 "A"。
        """
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        record_id = uuid.uuid4()

        target_hist = MagicMock()
        target_hist.id = uuid.uuid4()
        target_hist.created_at = datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt_tz.utc)

        restore_hist = MagicMock()
        restore_hist.record_id = record_id
        restore_hist.action = "restore"
        restore_hist.field_changes = {"fx": {"old": "A", "new": "B"}}
        restore_hist.created_at = datetime(2026, 1, 1, 5, 0, 0, tzinfo=dt_tz.utc)
        restore_hist.is_undone = False

        cur_rec = MagicMock()
        cur_rec.id = record_id
        cur_rec.data = {"fx": "B"}
        cur_rec.order = 1000.0
        cur_rec.is_deleted = False
        cur_rec.__dict__["data"] = {"fx": "B"}

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_hist,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_rec,
            patch(f"{_UNDO_MOD}.read_data", return_value={"fx": "B"}),
        ):
            hist_using = MagicMock()

            def _filter(**kw):
                qs = MagicMock()
                if 'id' in kw:
                    qs.only.return_value = qs
                    qs.first.return_value = target_hist
                else:
                    qs.only.return_value.order_by.return_value = [restore_hist]
                return qs

            hist_using.filter.side_effect = _filter
            mock_hist.using.return_value = hist_using

            rec_using = MagicMock()
            rec_using.filter.return_value.only.return_value = [cur_rec]
            mock_rec.using.return_value = rec_using

            result = svc.reconstruct_table_at_history(table_id, target_hist.id)

        self.assertIsNotNone(result)
        self.assertEqual(len(result), 1)
        self.assertEqual(
            result[0]["data"]["fx"], "A",
            "DV-022: reconstruct 应通过 restore 历史条目的 field_changes 还原为 restore 前的值",
        )

    def test_restore_delete_reversed_to_alive(self):
        """
        DV-022: restore 删除了一条记录（_deleted: False→True），
        重建 restore 之前的时间点应看到该记录（is_deleted=False）。
        """
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        record_id = uuid.uuid4()

        target_hist = MagicMock()
        target_hist.id = uuid.uuid4()
        target_hist.created_at = datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt_tz.utc)

        restore_hist = MagicMock()
        restore_hist.record_id = record_id
        restore_hist.action = "restore"
        restore_hist.field_changes = {
            "_deleted": {"old": False, "new": True},
            "fx": {"old": "alive", "new": None},
        }
        restore_hist.created_at = datetime(2026, 1, 1, 5, 0, 0, tzinfo=dt_tz.utc)
        restore_hist.is_undone = False

        cur_rec = MagicMock()
        cur_rec.id = record_id
        cur_rec.data = {}
        cur_rec.order = 0.0
        cur_rec.is_deleted = True
        cur_rec.__dict__["data"] = {}

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_hist,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_rec,
            patch(f"{_UNDO_MOD}.read_data", return_value={}),
        ):
            hist_using = MagicMock()

            def _filter(**kw):
                qs = MagicMock()
                if 'id' in kw:
                    qs.only.return_value = qs
                    qs.first.return_value = target_hist
                else:
                    qs.only.return_value.order_by.return_value = [restore_hist]
                return qs

            hist_using.filter.side_effect = _filter
            mock_hist.using.return_value = hist_using

            rec_using = MagicMock()
            rec_using.filter.return_value.only.return_value = [cur_rec]
            mock_rec.using.return_value = rec_using

            result = svc.reconstruct_table_at_history(table_id, target_hist.id)

        self.assertIsNotNone(result)
        alive_rows = [r for r in result if r["record_id"] == str(record_id)]
        self.assertEqual(
            len(alive_rows), 1,
            "DV-022: restore 删除的记录在 restore 前的时间点应可见",
        )
        self.assertEqual(alive_rows[0]["data"]["fx"], "alive")

    def test_restore_table_to_delete_field_changelog_applies_deleted_version(self):
        """删除列历史是版本点：还原到该版本应软删字段且不 DROP。"""
        svc = self._make_service()

        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        history_id = uuid.uuid4()
        anchor_at = datetime(2026, 6, 20, 4, 34, 0, tzinfo=dt_tz.utc)

        change_log = MagicMock()
        change_log.id = history_id
        change_log.change_type = "delete_field"
        change_log.created_at = anchor_at
        change_log.changes = {
            "fields": [{
                "id": str(field_id),
                "name": "ABC",
                "field_type": "text",
            }],
        }

        create_log = MagicMock()
        create_log.id = uuid.uuid4()
        create_log.change_type = "create_field"
        create_log.created_at = datetime(2026, 6, 20, 4, 30, 0, tzinfo=dt_tz.utc)
        create_log.changes = change_log.changes

        field = _fake_field("ABC")
        field.id = field_id
        field.table_id = table_id
        field.is_deleted = False
        field.is_primary = False
        field.created_at = create_log.created_at

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_history_objects,
            patch("apps.collab.models.ChangeLog.objects") as mock_change_log,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field_objects,
            patch("apps.tabdata.services.table_service.TableService") as mock_table_service_cls,
        ):
            history_qs = MagicMock()
            history_qs.filter.return_value.only.return_value.first.return_value = None
            mock_history_objects.using.return_value = history_qs

            change_log_manager = MagicMock()
            target_qs = MagicMock()
            target_qs.only.return_value.first.return_value = change_log
            structure_qs = MagicMock()
            structure_qs.only.return_value.order_by.return_value = [create_log, change_log]
            change_log_manager.filter.side_effect = [target_qs, structure_qs]
            mock_change_log.using.return_value = change_log_manager

            field_qs = MagicMock()
            field_qs.select_for_update.return_value.filter.return_value.order_by.return_value = [field]
            mock_field_objects.using.return_value = field_qs

            table_service = MagicMock()
            mock_table_service_cls.return_value = table_service

            result = svc._apply_field_structure_at_history(table_id, history_id)

        self.assertTrue(field.is_deleted)
        field.save.assert_called_once_with(update_fields=["is_deleted"])
        table_service._native_drop_column.assert_not_called()
        table_service._remove_field_from_views.assert_called_once_with(table_id, str(field_id))
        table_service._refresh_field_count.assert_called_once_with(table_id)
        table_service._increment_schema_version.assert_called_once_with(table_id)
        self.assertEqual(result["changed_fields"], 1)
        self.assertEqual(result["hidden_field_ids"], [str(field_id)])

    def test_restore_to_record_history_before_field_create_removes_later_field(self):
        """还原到新增字段之前的记录版本时，后续新增字段应软删且不 DROP。"""
        svc = self._make_service()

        table_id = uuid.uuid4()
        history_id = uuid.uuid4()
        field_id = uuid.uuid4()

        target_history = MagicMock()
        target_history.id = history_id
        target_history.created_at = datetime(2026, 6, 20, 4, 33, 29, tzinfo=dt_tz.utc)

        create_log = MagicMock()
        create_log.id = uuid.uuid4()
        create_log.change_type = "create_field"
        create_log.created_at = datetime(2026, 6, 20, 4, 34, 0, tzinfo=dt_tz.utc)
        create_log.changes = {
            "fields": [{
                "id": str(field_id),
                "name": "UUU",
                "field_type": "text",
            }],
        }

        field = _fake_field("UUU")
        field.id = field_id
        field.table_id = table_id
        field.is_deleted = False
        field.is_primary = False
        field.created_at = create_log.created_at

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_history_objects,
            patch("apps.collab.models.ChangeLog.objects") as mock_change_log,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field_objects,
            patch("apps.tabdata.services.table_service.TableService") as mock_table_service_cls,
        ):
            history_qs = MagicMock()
            history_qs.filter.return_value.only.return_value.first.return_value = target_history
            mock_history_objects.using.return_value = history_qs

            change_log_manager = MagicMock()
            structure_qs = MagicMock()
            structure_qs.only.return_value.order_by.return_value = [create_log]
            change_log_manager.filter.return_value = structure_qs
            mock_change_log.using.return_value = change_log_manager

            field_qs = MagicMock()
            field_qs.select_for_update.return_value.filter.return_value.order_by.return_value = [field]
            mock_field_objects.using.return_value = field_qs

            table_service = MagicMock()
            mock_table_service_cls.return_value = table_service

            result = svc._apply_field_structure_at_history(table_id, history_id)

        self.assertIsNone(result.get("field_restore_error"))
        self.assertEqual(result["changed_fields"], 1)
        self.assertTrue(field.is_deleted)
        field.save.assert_called_once_with(update_fields=["is_deleted"])
        table_service._native_drop_column.assert_not_called()
        table_service._remove_field_from_views.assert_called_once_with(table_id, str(field_id))
        table_service._refresh_field_count.assert_called_once_with(table_id)
        table_service._increment_schema_version.assert_called_once_with(table_id)
        self.assertEqual(result["hidden_field_ids"], [str(field_id)])

    def test_restore_snapshot_prunes_data_for_fields_absent_at_target_version(self):
        """记录 replay 前应归一目标字段 key，并移除目标版本不存在的字段。"""
        from apps.tabdata.services.undo_redo_service import UndoRedoService

        active_uuid = uuid.uuid4()
        active_field_id = str(active_uuid)
        active_field_hex = active_uuid.hex
        active_field_name = "ASAS"
        active_field_api_name = "asas_api"
        later_field_id = str(uuid.uuid4())
        rows = [{
            "record_id": str(uuid.uuid4()),
            "row_id": str(uuid.uuid4()),
            "order": 1,
            "data": {
                active_field_hex: "hex-key-value",
                active_field_name: "name-key-value",
                later_field_id: "should disappear",
                "_meta:source": "keep",
            },
        }, {
            "record_id": str(uuid.uuid4()),
            "row_id": str(uuid.uuid4()),
            "order": 2,
            "data": {
                active_field_name: "name-key-only-value",
            },
        }, {
            "record_id": str(uuid.uuid4()),
            "row_id": str(uuid.uuid4()),
            "order": 3,
            "data": {
                active_field_api_name: "api-name-key-only-value",
            },
        }]

        pruned = UndoRedoService._prune_snapshot_rows_to_active_fields(
            rows,
            {
                active_field_id: (active_field_id, 0),
                active_field_hex: (active_field_id, 1),
                active_field_api_name: (active_field_id, 2),
                active_field_name: (active_field_id, 3),
            },
        )

        self.assertEqual(pruned[0]["data"], {
            active_field_id: "hex-key-value",
            "_meta:source": "keep",
        })
        self.assertEqual(pruned[1]["data"], {
            active_field_id: "name-key-only-value",
        })
        self.assertEqual(pruned[2]["data"], {
            active_field_id: "api-name-key-only-value",
        })
        self.assertIn(later_field_id, rows[0]["data"], "helper 不应原地修改输入")

    def test_reconstruct_history_field_name_change_overrides_current_uuid_key(self):
        """字段名历史回放应覆盖同字段当前 UUID key，避免后续值残留。"""
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        record_id = uuid.uuid4()
        target_hist = MagicMock()
        target_hist.id = uuid.uuid4()
        target_hist.created_at = datetime(2026, 6, 20, 5, 52, 0, tzinfo=dt_tz.utc)
        target_hist.operation_group_id = None

        later_hist = MagicMock()
        later_hist.id = uuid.uuid4()
        later_hist.record_id = record_id
        later_hist.action = "update"
        later_hist.created_at = datetime(2026, 6, 20, 5, 53, 0, tzinfo=dt_tz.utc)
        later_hist.field_changes = {
            "ASAS": {"old": "target-version-value", "new": "future-value"},
        }

        field = _fake_field("ASAS")
        field.id = field_id
        field.api_name = ""
        cur_rec = _fake_record(
            str(record_id),
            data={str(field_id): "future-value"},
            order=1000.0,
        )

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_history_objects,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field_objects,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_record_objects,
        ):
            history_manager = MagicMock()
            target_qs = MagicMock()
            target_qs.only.return_value.first.return_value = target_hist
            later_qs = MagicMock()
            later_qs.only.return_value.order_by.return_value = [later_hist]
            history_manager.filter.side_effect = [target_qs, later_qs]
            mock_history_objects.using.return_value = history_manager

            field_manager = MagicMock()
            field_manager.filter.return_value.only.return_value = [field]
            mock_field_objects.using.return_value = field_manager

            record_manager = MagicMock()
            record_manager.filter.return_value.only.return_value = [cur_rec]
            mock_record_objects.using.return_value = record_manager

            result = svc.reconstruct_table_at_history(table_id, target_hist.id)

        self.assertIsNotNone(result)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["data"], {
            str(field_id): "target-version-value",
        })

    def test_reconstruct_history_collapses_duplicate_alias_changes(self):
        """同一 history 同字段多 alias 变化时，应保留非空目标旧值。"""
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        record_id = uuid.uuid4()
        target_hist = MagicMock()
        target_hist.id = uuid.uuid4()
        target_hist.created_at = datetime(2026, 6, 20, 5, 52, 0, tzinfo=dt_tz.utc)
        target_hist.operation_group_id = None

        later_hist = MagicMock()
        later_hist.id = uuid.uuid4()
        later_hist.record_id = record_id
        later_hist.action = "restore"
        later_hist.created_at = datetime(2026, 6, 20, 6, 4, 0, tzinfo=dt_tz.utc)
        later_hist.field_changes = {
            field_id.hex: {"old": "target-version-value", "new": None},
            str(field_id): {"old": None, "new": "target-version-value"},
        }

        field = _fake_field("ASAS")
        field.id = field_id
        field.api_name = ""
        cur_rec = _fake_record(
            str(record_id),
            data={str(field_id): "target-version-value"},
            order=1000.0,
        )

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_history_objects,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field_objects,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_record_objects,
        ):
            history_manager = MagicMock()
            target_qs = MagicMock()
            target_qs.only.return_value.first.return_value = target_hist
            later_qs = MagicMock()
            later_qs.only.return_value.order_by.return_value = [later_hist]
            history_manager.filter.side_effect = [target_qs, later_qs]
            mock_history_objects.using.return_value = history_manager

            field_manager = MagicMock()
            field_manager.filter.return_value.only.return_value = [field]
            mock_field_objects.using.return_value = field_manager

            record_manager = MagicMock()
            record_manager.filter.return_value.only.return_value = [cur_rec]
            mock_record_objects.using.return_value = record_manager

            result = svc.reconstruct_table_at_history(table_id, target_hist.id)

        self.assertIsNotNone(result)
        self.assertEqual(result[0]["data"], {
            str(field_id): "target-version-value",
        })

    def test_restore_replay_force_syncs_native_when_json_is_unchanged(self):
        """JSON 已是目标值时，restore 仍应强制同步 native 列以修复历史分叉。"""
        from apps.tabdata.services.record_replay_helper import replay_record_state

        table_id = uuid.uuid4()
        space_id = uuid.uuid4()
        field_id = uuid.uuid4()
        record_id = uuid.uuid4()

        field = _fake_field("ASAS")
        field.id = field_id
        field.table_id = table_id
        field.is_deleted = False

        record = _fake_record(
            str(record_id),
            data={str(field_id): None},
            order=1000.0,
        )
        record.table_id = table_id
        record.table = MagicMock()
        record.table.id = table_id
        record.table.space_id = space_id
        record.version = 1
        record.is_deleted = False

        service = MagicMock()
        service.user = None

        with (
            patch(
                "apps.tabdata.services.record_replay_helper.read_data",
                return_value={str(field_id): None},
            ),
            patch("apps.tabdata.services.record_replay_helper.TableField.objects") as mock_field_objects,
            patch("apps.tabdata.native.record_io.NativeRecordIO") as mock_native_io_cls,
        ):
            field_manager = MagicMock()
            field_manager.filter.return_value = [field]
            mock_field_objects.using.return_value = field_manager
            native_io = MagicMock()
            native_io.update_record.return_value = True
            mock_native_io_cls.return_value = native_io

            result = replay_record_state(
                service,
                record=record,
                next_data={str(field_id): None},
                next_is_deleted=False,
                next_order=1000.0,
                emit_history=False,
                source="restore_table_to_history",
                force_native_sync=True,
            )

        self.assertFalse(result.changed)
        self.assertTrue(result.native_synced)
        native_io.update_record.assert_called_once_with(
            record_id=record.id,
            field_values={field_id.hex: None},
        )

    def test_restore_replay_force_sync_reads_hex_field_alias(self):
        """强制 native 同步应识别快照里的 hex 字段 key，不能误清目标值。"""
        from apps.tabdata.services.record_replay_helper import replay_record_state

        table_id = uuid.uuid4()
        space_id = uuid.uuid4()
        field_id = uuid.uuid4()
        record_id = uuid.uuid4()

        field = _fake_field("ASAS")
        field.id = field_id
        field.table_id = table_id
        field.is_deleted = False

        record = _fake_record(
            str(record_id),
            data={field_id.hex: "日日日日日日"},
            order=1000.0,
        )
        record.table_id = table_id
        record.table = MagicMock()
        record.table.id = table_id
        record.table.space_id = space_id
        record.version = 1
        record.is_deleted = False

        service = MagicMock()
        service.user = None

        with (
            patch(
                "apps.tabdata.services.record_replay_helper.read_data",
                return_value={field_id.hex: "日日日日日日"},
            ),
            patch("apps.tabdata.services.record_replay_helper.TableField.objects") as mock_field_objects,
            patch("apps.tabdata.native.record_io.NativeRecordIO") as mock_native_io_cls,
        ):
            field_manager = MagicMock()
            field_manager.filter.return_value = [field]
            mock_field_objects.using.return_value = field_manager
            native_io = MagicMock()
            native_io.update_record.return_value = True
            mock_native_io_cls.return_value = native_io

            result = replay_record_state(
                service,
                record=record,
                next_data={field_id.hex: "日日日日日日"},
                next_is_deleted=False,
                next_order=1000.0,
                emit_history=False,
                source="restore_table_to_history",
                force_native_sync=True,
            )

        self.assertFalse(result.changed)
        self.assertTrue(result.native_synced)
        native_io.update_record.assert_called_once_with(
            record_id=record.id,
            field_values={field_id.hex: "日日日日日日"},
        )

    def test_delete_field_changelog_structure_failure_does_not_fallback_to_snapshot(self):
        """结构版本对齐失败时不能继续回退到记录快照还原。"""
        svc = self._make_service()
        svc.check_table_permission = MagicMock(return_value=True)

        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        history_id = uuid.uuid4()
        anchor_at = datetime(2026, 6, 20, 4, 34, 0, tzinfo=dt_tz.utc)

        change_log = MagicMock()
        change_log.id = history_id
        change_log.change_type = "delete_field"
        change_log.created_at = anchor_at
        change_log.changes = {
            "fields": [{
                "id": str(field_id),
                "name": "ABC",
                "field_type": "text",
            }],
        }

        create_log = MagicMock()
        create_log.id = uuid.uuid4()
        create_log.change_type = "create_field"
        create_log.created_at = datetime(2026, 6, 20, 4, 30, 0, tzinfo=dt_tz.utc)
        create_log.changes = change_log.changes

        field = _fake_field("ABC")
        field.id = field_id
        field.table_id = table_id
        field.is_deleted = False
        field.is_primary = False
        field.created_at = create_log.created_at

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_history_objects,
            patch("apps.collab.models.ChangeLog.objects") as mock_change_log,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field_objects,
            patch(f"{_UNDO_MOD}.TableRecord.objects") as mock_record_objects,
            patch("apps.tabdata.services.table_service.TableService") as mock_table_service_cls,
            patch.object(svc, "reconstruct_table_at_history") as mock_reconstruct,
        ):
            history_qs = MagicMock()
            history_qs.filter.return_value.only.return_value.first.return_value = None
            mock_history_objects.using.return_value = history_qs

            change_log_manager = MagicMock()
            target_qs = MagicMock()
            target_qs.only.return_value.first.return_value = change_log
            structure_qs = MagicMock()
            structure_qs.only.return_value.order_by.return_value = [create_log, change_log]
            change_log_manager.filter.side_effect = [target_qs, structure_qs]
            mock_change_log.using.return_value = change_log_manager

            field_qs = MagicMock()
            field_qs.select_for_update.return_value.filter.return_value.order_by.return_value = [field]
            mock_field_objects.using.return_value = field_qs

            record_qs = MagicMock()
            record_qs.select_for_update.return_value.filter.return_value = []
            mock_record_objects.using.return_value = record_qs

            table_service = MagicMock()
            table_service._remove_field_from_views.side_effect = RuntimeError("structure boom")
            mock_table_service_cls.return_value = table_service

            result = svc.restore_table_to_history.__wrapped__(svc, table_id, history_id)

        mock_reconstruct.assert_not_called()
        self.assertEqual(result["changed_fields"], 0)
        self.assertIn("structure boom", result["field_restore_error"])

    def test_restore_after_hide_then_revive_field_created_between_versions(self):
        """先还原到建字段前再还原到建字段后，应重新激活字段且不写 DROP。"""
        svc = self._make_service()
        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        before_history_id = uuid.uuid4()
        after_history_id = uuid.uuid4()

        before_history = MagicMock()
        before_history.id = before_history_id
        before_history.created_at = datetime(2026, 6, 20, 4, 33, 0, tzinfo=dt_tz.utc)

        after_history = MagicMock()
        after_history.id = after_history_id
        after_history.created_at = datetime(2026, 6, 20, 4, 35, 0, tzinfo=dt_tz.utc)

        create_log = MagicMock()
        create_log.id = uuid.uuid4()
        create_log.change_type = "create_field"
        create_log.created_at = datetime(2026, 6, 20, 4, 34, 0, tzinfo=dt_tz.utc)
        create_log.changes = {
            "fields": [{
                "id": str(field_id),
                "name": "UUU",
                "field_type": "text",
            }],
        }

        field = _fake_field("UUU")
        field.id = field_id
        field.table_id = table_id
        field.is_deleted = False
        field.is_primary = False
        field.created_at = create_log.created_at

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_history_objects,
            patch("apps.collab.models.ChangeLog.objects") as mock_change_log,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field_objects,
            patch("apps.tabdata.services.table_service.TableService") as mock_table_service_cls,
            patch(
                "apps.tabdata.services.undo_redo_field_restore.restore_fields",
                return_value=([str(field_id)], []),
            ) as mock_restore_fields,
            patch(
                f"{_UNDO_MOD}.UndoRedoOperationService.serialize_field",
                return_value={"id": str(field_id), "table_id": str(table_id), "name": "UUU"},
            ),
        ):
            history_qs = MagicMock()
            history_qs.filter.return_value.only.return_value.first.side_effect = [
                before_history,
                after_history,
            ]
            mock_history_objects.using.return_value = history_qs

            structure_qs = MagicMock()
            structure_qs.only.return_value.order_by.return_value = [create_log]
            mock_change_log.using.return_value.filter.return_value = structure_qs

            field_qs = MagicMock()
            field_qs.select_for_update.return_value.filter.return_value.order_by.return_value = [field]
            mock_field_objects.using.return_value = field_qs

            table_service = MagicMock()
            mock_table_service_cls.return_value = table_service

            hide_result = svc._apply_field_structure_at_history(table_id, before_history_id)
            self.assertEqual(hide_result["hidden_field_ids"], [str(field_id)])
            self.assertTrue(field.is_deleted)
            table_service._native_drop_column.assert_not_called()

            revive_result = svc._apply_field_structure_at_history(table_id, after_history_id)

        self.assertIsNone(revive_result.get("field_restore_error"))
        self.assertEqual(revive_result["revived_field_ids"], [str(field_id)])
        mock_restore_fields.assert_called_once()
        table_service._native_drop_column.assert_not_called()

    def test_restore_from_restore_changelog_recurses_to_target_schema(self):
        """还原到 restore 节点时，schema 应对齐到 changes.history_id 的目标时刻。"""
        svc = self._make_service()
        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        target_history_id = uuid.uuid4()
        restore_log_id = uuid.uuid4()

        target_history = MagicMock()
        target_history.id = target_history_id
        target_history.created_at = datetime(2026, 6, 20, 4, 33, 0, tzinfo=dt_tz.utc)

        restore_log = MagicMock()
        restore_log.id = restore_log_id
        restore_log.change_type = "restore"
        restore_log.created_at = datetime(2026, 6, 20, 5, 0, 0, tzinfo=dt_tz.utc)
        restore_log.changes = {"history_id": str(target_history_id)}

        create_log = MagicMock()
        create_log.id = uuid.uuid4()
        create_log.change_type = "create_field"
        create_log.created_at = datetime(2026, 6, 20, 4, 40, 0, tzinfo=dt_tz.utc)
        create_log.changes = {
            "fields": [{
                "id": str(field_id),
                "name": "UUU",
                "field_type": "text",
            }],
        }

        field = _fake_field("UUU")
        field.id = field_id
        field.table_id = table_id
        field.is_deleted = False
        field.is_primary = False
        field.created_at = create_log.created_at

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_history_objects,
            patch("apps.collab.models.ChangeLog.objects") as mock_change_log,
            patch(f"{_UNDO_MOD}.TableField.objects") as mock_field_objects,
            patch("apps.tabdata.services.table_service.TableService") as mock_table_service_cls,
        ):
            def _history_filter(**kwargs):
                qs = MagicMock()
                hist_id = kwargs.get("id")
                if hist_id == restore_log_id:
                    qs.only.return_value.first.return_value = None
                elif hist_id == target_history_id:
                    qs.only.return_value.first.return_value = target_history
                else:
                    qs.only.return_value.first.return_value = None
                return qs

            mock_history_objects.using.return_value.filter.side_effect = _history_filter

            def _change_filter(**kwargs):
                qs = MagicMock()
                if kwargs.get("id") == restore_log_id:
                    qs.only.return_value.first.return_value = restore_log
                    return qs
                qs.only.return_value.order_by.return_value = [create_log]
                return qs

            mock_change_log.using.return_value.filter.side_effect = _change_filter

            field_qs = MagicMock()
            field_qs.select_for_update.return_value.filter.return_value.order_by.return_value = [field]
            mock_field_objects.using.return_value = field_qs

            table_service = MagicMock()
            mock_table_service_cls.return_value = table_service

            result = svc._apply_field_structure_at_history(table_id, restore_log_id)

        # 若错误地用 restore 墙钟(5:00)，create(4:40) 会被算作应存在；
        # 递归到 4:33 后应隐藏该字段。
        self.assertIsNone(result.get("field_restore_error"))
        self.assertEqual(result["hidden_field_ids"], [str(field_id)])
        table_service._native_drop_column.assert_not_called()

    def test_schema_anchor_detects_restore_cycle(self):
        """restore 锚点递归遇到环时应安全停止。"""
        svc = self._make_service()
        table_id = uuid.uuid4()
        a_id = uuid.uuid4()
        b_id = uuid.uuid4()

        restore_a = MagicMock()
        restore_a.id = a_id
        restore_a.change_type = "restore"
        restore_a.created_at = datetime(2026, 6, 20, 5, 0, 0, tzinfo=dt_tz.utc)
        restore_a.changes = {"history_id": str(b_id)}

        restore_b = MagicMock()
        restore_b.id = b_id
        restore_b.change_type = "restore"
        restore_b.created_at = datetime(2026, 6, 20, 5, 1, 0, tzinfo=dt_tz.utc)
        restore_b.changes = {"history_id": str(a_id)}

        with (
            patch(f"{_UNDO_MOD}.RecordHistory.objects") as mock_history_objects,
            patch("apps.collab.models.ChangeLog.objects") as mock_change_log,
        ):
            mock_history_objects.using.return_value.filter.return_value.only.return_value.first.return_value = None

            def _change_filter(**kwargs):
                qs = MagicMock()
                hist_id = kwargs.get("id")
                if hist_id == a_id:
                    qs.only.return_value.first.return_value = restore_a
                elif hist_id == b_id:
                    qs.only.return_value.first.return_value = restore_b
                else:
                    qs.only.return_value.first.return_value = None
                return qs

            mock_change_log.using.return_value.filter.side_effect = _change_filter
            anchor = svc._resolve_effective_schema_anchor(table_id, a_id)

        self.assertIs(anchor, svc._SCHEMA_ANCHOR_CYCLE)

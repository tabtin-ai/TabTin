"""
回归测试：SR-007 / SR-008 / SR-009

SR-007: to_update 路径应保留快照中所有字段数据（含非当前 schema 字段），
        而非只保留 field_map_hex 匹配的字段。
SR-008: version 应在 delete 之前分配；ORM 删除同步写 version。
SR-009: row_order 不应被双重循环处理，to_create/to_update 已设好 order。
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from unittest import TestCase
from unittest.mock import MagicMock, patch

_MOD = "apps.tabdata.services.collab_service"


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


def _run_restore(table, fields, existing_id_strs, snapshot, *, version_ret=42):
    """
    运行 CollabService.restore_from_snapshot 并返回各 mock 以供断言。

    关键 mock 链:
      TableRecord.objects.using().filter().select_for_update().values_list() → existing UUIDs
      TableRecord.objects.using().filter().update() → 捕获 kwargs
      TableRecord.objects.using().create() → 捕获 kwargs
    """
    from apps.tabdata.services.collab_service import CollabService

    existing_uuids = {uuid.UUID(s) for s in existing_id_strs}

    orm_update_calls: list[dict] = []
    orm_create_calls: list[dict] = []

    record_qs = MagicMock()
    record_qs.select_for_update.return_value.values_list.return_value = existing_uuids
    record_qs.values_list.return_value = existing_uuids

    def _capture_update(**ukw):
        orm_update_calls.append(ukw)
        return 1

    record_qs.update.side_effect = _capture_update

    record_using = MagicMock()
    record_using.filter.return_value = record_qs

    def _capture_create(**kw):
        orm_create_calls.append(kw)
        return MagicMock(id=kw.get("id"))

    record_using.create.side_effect = _capture_create

    mock_nio = MagicMock()

    field_qs = MagicMock()
    field_qs.__iter__ = MagicMock(return_value=iter(fields))
    field_qs.update.return_value = 0

    field_using = MagicMock()
    field_using.filter.return_value = field_qs

    with (
        patch(f"{_MOD}.Table.objects.using") as t_using,
        patch(f"{_MOD}.TableField.objects.using", return_value=field_using),
        patch(f"{_MOD}.TableRecord.objects.using", return_value=record_using),
        patch(f"{_MOD}.NativeRecordIO", return_value=mock_nio),
        patch(f"{_MOD}.next_record_version", return_value=version_ret) as mock_nrv,
        patch(f"{_MOD}.table_event_service"),
        patch(f"{_MOD}.python_to_pg", side_effect=lambda v, ft, cfg: v),
        patch(f"{_MOD}.transaction.atomic", side_effect=_noop_atomic),
    ):
        t_using.return_value.filter.return_value.first.return_value = table
        t_using.return_value.filter.return_value.update.return_value = 1

        CollabService.restore_from_snapshot(table.id, snapshot)

    return {
        "orm_update_calls": orm_update_calls,
        "orm_create_calls": orm_create_calls,
        "native_io": mock_nio,
        "next_record_version": mock_nrv,
    }


# ── SR-007 ──────────────────────────────────────────────────────

class SR007Tests(TestCase):
    """SR-007: to_update 路径 ORM data 应保留快照中所有字段值"""

    def test_orm_data_preserves_non_schema_fields(self):
        """快照中不在当前 field_map_hex 的字段值应保留在 orm_data"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        deleted_field_hex = uuid.uuid4().hex
        rid = str(uuid.uuid4())

        snapshot = {
            "records": {
                rid: {
                    _hex(field_a.id): "new_a",
                    deleted_field_hex: "should_survive",
                },
            },
            "row_order": [rid],
            "fields": [],
        }

        result = _run_restore(table, [field_a], {rid}, snapshot)

        data_found = None
        for kw in result["orm_update_calls"]:
            if "data" in kw:
                data_found = kw["data"]
                break

        self.assertIsNotNone(data_found, "应调用 ORM update(data=...)")
        self.assertEqual(data_found.get(_hex(field_a.id)), "new_a")
        self.assertEqual(
            data_found.get(deleted_field_hex),
            "should_survive",
            "SR-007: 非当前 schema 字段值应保留在 orm_data 中",
        )

    def test_native_io_excludes_deleted_field(self):
        """native I/O 只写当前 schema 字段，不写已删除字段"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        deleted_field_hex = uuid.uuid4().hex
        rid = str(uuid.uuid4())

        snapshot = {
            "records": {
                rid: {
                    _hex(field_a.id): "val_a",
                    deleted_field_hex: "ghost",
                },
            },
            "row_order": [rid],
            "fields": [],
        }

        result = _run_restore(table, [field_a], {rid}, snapshot)
        nio = result["native_io"]

        self.assertTrue(nio.update_record.called, "应调用 native update_record")
        fv = nio.update_record.call_args.kwargs.get("field_values", {})
        self.assertIn(_hex(field_a.id), fv, "当前字段应写入 native")
        self.assertNotIn(deleted_field_hex, fv, "SR-007: 已删除字段不应写入 native")


# ── SR-008 ──────────────────────────────────────────────────────

class SR008Tests(TestCase):
    """SR-008: version 分配应在 delete 之前；ORM 删除应写 version"""

    def test_delete_orm_update_includes_version(self):
        """ORM 删除记录时应同步设置 version"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        del_rid = str(uuid.uuid4())

        snapshot = {"records": {}, "row_order": [], "fields": []}
        result = _run_restore(table, [field_a], {del_rid}, snapshot)

        delete_update = None
        for kw in result["orm_update_calls"]:
            if kw.get("is_deleted") is True:
                delete_update = kw
                break

        self.assertIsNotNone(delete_update, "应调用 ORM update(is_deleted=True, ...)")
        self.assertEqual(
            delete_update.get("version"),
            42,
            "SR-008: ORM 删除应同步写入 version",
        )

    def test_soft_delete_uses_version_zero(self):
        """delete_record 应使用 version=0（快照恢复需无条件删除原生行）"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        del_rid = str(uuid.uuid4())

        snapshot = {"records": {}, "row_order": [], "fields": []}
        result = _run_restore(table, [field_a], {del_rid}, snapshot)
        nio = result["native_io"]

        nio.delete_record.assert_called_once()
        self.assertEqual(
            nio.delete_record.call_args.kwargs["version"],
            0,
            "SR-008: restore 删除应使用 version=0 无条件删除",
        )

    def test_version_count_includes_deletes(self):
        """next_record_version count 应包含 to_delete 数量"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        del_r1 = str(uuid.uuid4())
        del_r2 = str(uuid.uuid4())
        new_r3 = str(uuid.uuid4())

        snapshot = {
            "records": {new_r3: {_hex(field_a.id): "val"}},
            "row_order": [new_r3],
            "fields": [],
        }

        result = _run_restore(
            table, [field_a], {del_r1, del_r2}, snapshot, version_ret=100
        )
        nrv = result["next_record_version"]

        nrv.assert_called_once()
        count_arg = nrv.call_args[0][1]
        self.assertEqual(
            count_arg,
            3,
            "SR-008: version count 应为 to_create(1) + to_update(0) + to_delete(2) = 3",
        )


# ── SR-009 ──────────────────────────────────────────────────────

class SR009Tests(TestCase):
    """SR-009: 不应存在 row_order 双重循环"""

    def test_new_records_not_updated_by_row_order_loop(self):
        """新建记录不应被额外的 update_record 调用"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        r1 = str(uuid.uuid4())
        r2 = str(uuid.uuid4())

        snapshot = {
            "records": {
                r1: {_hex(field_a.id): "v1"},
                r2: {_hex(field_a.id): "v2"},
            },
            "row_order": [r1, r2],
            "fields": [],
        }

        result = _run_restore(table, [field_a], set(), snapshot)
        nio = result["native_io"]

        self.assertEqual(
            nio.update_record.call_count,
            0,
            "SR-009: 全新建记录不应触发 update_record",
        )
        self.assertEqual(
            nio.insert_record.call_count,
            2,
            "SR-009: 两条新建记录各调用一次 insert_record",
        )

    def test_existing_records_updated_once_only(self):
        """已存在记录只被 to_update 路径 update 一次"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        r1 = str(uuid.uuid4())

        snapshot = {
            "records": {r1: {_hex(field_a.id): "new_val"}},
            "row_order": [r1],
            "fields": [],
        }

        result = _run_restore(table, [field_a], {r1}, snapshot)
        nio = result["native_io"]

        self.assertEqual(
            nio.update_record.call_count,
            1,
            "SR-009: to_update 中的记录应只被 native update_record 调用一次",
        )
        sys_updates = nio.update_record.call_args.kwargs.get("system_updates", {})
        self.assertIn("__version", sys_updates, "system_updates 应包含 __version")
        self.assertIn("__order", sys_updates, "system_updates 应包含 __order")

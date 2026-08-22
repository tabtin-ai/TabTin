"""
回归测试：SR-001 / SR-002 / DC-003 / FH-002 / FH-003

SR-001 + DC-003 + FH-002: restore_from_snapshot 应基于快照 fields 定义构建 field_map_hex，
    而非仅读取当前 DB 活跃字段。
SR-002: to_create / to_update 路径无法映射的 field_hex 应输出 warning，而非静默丢弃。
FH-003: 快照中存在但当前已删除的字段应被恢复（undelete），
    当前活跃但快照中不存在的字段应被软删除。
"""
from __future__ import annotations

import logging
import uuid
from contextlib import contextmanager
from unittest import TestCase
from unittest.mock import MagicMock, patch, call

_MOD = "apps.tabdata.services.collab_service"


@contextmanager
def _noop_atomic(using=None, savepoint=True, durable=False):
    yield


def _fake_field(name: str, field_type: str = "text", order: int = 0,
                is_deleted: bool = False, field_id: uuid.UUID = None) -> MagicMock:
    field = MagicMock()
    field.id = field_id or uuid.uuid4()
    field.name = name
    field.field_type = field_type
    field.order = order
    field.config = {}
    field.is_deleted = is_deleted
    return field


def _fake_table(schema_version: int = 1) -> MagicMock:
    t = MagicMock()
    t.id = uuid.uuid4()
    t.space_id = uuid.uuid4()
    t.record_version_seq = 10
    t.schema_version = schema_version
    t.is_archived = False
    return t


def _hex(uid: uuid.UUID) -> str:
    return uid.hex


def _make_field_def(field: MagicMock) -> dict:
    return {
        "id": str(field.id),
        "id_hex": field.id.hex,
        "name": field.name,
        "field_type": field.field_type,
        "config": field.config or {},
        "order": field.order,
    }


def _run_restore_with_field_sync(
    table, all_db_fields, snapshot, *,
    existing_record_ids=None, version_ret=42,
):
    """
    运行 restore_from_snapshot，支持字段同步逻辑的 mock 验证。

    all_db_fields: 模拟 DB 中所有字段（含 is_deleted=True 的）。
    注意：不修改传入的 mock 对象，通过预测算出恢复后的活跃字段集。
    """
    from apps.tabdata.services.collab_service import CollabService

    existing_record_ids = existing_record_ids or set()
    existing_uuids = {uuid.UUID(s) if isinstance(s, str) else s for s in existing_record_ids}

    record_qs = MagicMock()
    record_qs.select_for_update.return_value = record_qs
    record_qs.values_list.return_value = existing_uuids

    orm_update_calls: list[dict] = []
    orm_create_calls: list[dict] = []

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

    field_update_calls: list[dict] = []

    snapshot_field_hex_set = set()
    for fdef in snapshot.get("fields", []):
        fhex = fdef.get("id_hex") or fdef.get("id", "").replace("-", "")
        if fhex:
            snapshot_field_hex_set.add(fhex)

    predicted_active: list = []
    if snapshot_field_hex_set:
        for f in all_db_fields:
            if f.id.hex in snapshot_field_hex_set:
                predicted_active.append(f)
    else:
        predicted_active = [f for f in all_db_fields if not f.is_deleted]

    def _field_filter(**kwargs):
        qs = MagicMock()
        if "id__in" in kwargs:
            def _field_update(**ukw):
                field_update_calls.append({"ids": kwargs["id__in"], **ukw})
                return len(kwargs["id__in"])
            qs.update.side_effect = _field_update
            return qs

        if kwargs.get("is_deleted") is False:
            return predicted_active
        elif "is_deleted" not in kwargs:
            return all_db_fields
        return qs

    with (
        patch(f"{_MOD}.Table.objects.using") as t_using,
        patch(f"{_MOD}.TableField.objects.using") as f_using,
        patch(f"{_MOD}.TableRecord.objects.using", return_value=record_using),
        patch(f"{_MOD}.NativeRecordIO", return_value=mock_nio),
        patch(f"{_MOD}.next_record_version", return_value=version_ret) as mock_nrv,
        patch(f"{_MOD}.table_event_service"),
        patch(f"{_MOD}.python_to_pg", side_effect=lambda v, ft, cfg: v),
        patch(f"{_MOD}.transaction.atomic", side_effect=_noop_atomic),
    ):
        t_using.return_value.filter.return_value.first.return_value = table
        t_using.return_value.filter.return_value.update.return_value = 1
        f_using.return_value.filter.side_effect = _field_filter

        CollabService.restore_from_snapshot(table.id, snapshot)

    return {
        "orm_update_calls": orm_update_calls,
        "orm_create_calls": orm_create_calls,
        "native_io": mock_nio,
        "next_record_version": mock_nrv,
        "field_update_calls": field_update_calls,
        "active_fields_after_sync": predicted_active,
    }


# ── SR-001 / DC-003 / FH-002: restore 使用快照 fields ──────────


class TestRestoreUsesSnapshotFields(TestCase):
    """restore_from_snapshot 应基于快照 fields 构建 field_map_hex"""

    def test_deleted_field_data_restored_via_snapshot_fields(self):
        """快照中存在但已删除的字段数据应被正确映射到 ORM 和 native IO"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        field_b = _fake_field("FieldB", is_deleted=True)

        rid = str(uuid.uuid4())
        snapshot = {
            "records": {
                rid: {
                    _hex(field_a.id): "val_a",
                    _hex(field_b.id): "val_b_restored",
                },
            },
            "row_order": [rid],
            "fields": [_make_field_def(field_a), _make_field_def(field_b)],
        }

        result = _run_restore_with_field_sync(
            table, [field_a, field_b], snapshot,
        )

        self.assertTrue(
            len(result["orm_create_calls"]) > 0,
            "应创建记录",
        )
        created = result["orm_create_calls"][0]
        orm_data = created.get("data", {})

        self.assertEqual(
            orm_data.get(_hex(field_b.id)),
            "val_b_restored",
            "SR-001: 已删除字段恢复后，其记录数据应出现在 orm_data 中",
        )

    def test_native_io_writes_restored_field_data(self):
        """native IO 应包含已恢复字段的数据"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        field_b = _fake_field("FieldB", is_deleted=True)

        rid = str(uuid.uuid4())
        snapshot = {
            "records": {
                rid: {
                    _hex(field_a.id): "val_a",
                    _hex(field_b.id): "val_b",
                },
            },
            "row_order": [rid],
            "fields": [_make_field_def(field_a), _make_field_def(field_b)],
        }

        result = _run_restore_with_field_sync(
            table, [field_a, field_b], snapshot,
        )

        nio = result["native_io"]
        insert_calls = nio.insert_record.call_args_list
        self.assertTrue(len(insert_calls) > 0, "应调用 insert_record")

        field_values = insert_calls[0].kwargs.get("field_values", {})
        self.assertIn(
            _hex(field_b.id),
            field_values,
            "SR-001: native IO 应写入已恢复字段的值",
        )


# ── FH-003: 字段结构同步 ────────────────────────────────────────


class TestFieldStructureSync(TestCase):
    """FH-003: 恢复时同步字段结构（undelete / soft-delete）"""

    def test_deleted_field_undeleted_when_in_snapshot(self):
        """快照中存在但已删除的字段应被 undelete"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        field_b = _fake_field("FieldB", is_deleted=True)

        snapshot = {
            "records": {},
            "row_order": [],
            "fields": [_make_field_def(field_a), _make_field_def(field_b)],
        }

        result = _run_restore_with_field_sync(
            table, [field_a, field_b], snapshot,
        )

        undelete_updates = [
            c for c in result["field_update_calls"]
            if c.get("is_deleted") is False
        ]
        self.assertTrue(
            len(undelete_updates) > 0,
            "FH-003: 应调用 update(is_deleted=False) 恢复已删除字段",
        )

        undeleted_ids = set()
        for u in undelete_updates:
            for uid in u.get("ids", []):
                undeleted_ids.add(uid)
        self.assertIn(
            field_b.id,
            undeleted_ids,
            "FH-003: FieldB 应在 undelete 列表中",
        )

    def test_post_snapshot_field_soft_deleted(self):
        """当前活跃但快照中不存在的字段应被软删除"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        field_c = _fake_field("FieldC")

        snapshot = {
            "records": {},
            "row_order": [],
            "fields": [_make_field_def(field_a)],
        }

        result = _run_restore_with_field_sync(
            table, [field_a, field_c], snapshot,
        )

        soft_delete_updates = [
            c for c in result["field_update_calls"]
            if c.get("is_deleted") is True
        ]
        self.assertTrue(
            len(soft_delete_updates) > 0,
            "FH-003: 应调用 update(is_deleted=True) 删除快照中不存在的字段",
        )

        soft_deleted_ids = set()
        for u in soft_delete_updates:
            for uid in u.get("ids", []):
                soft_deleted_ids.add(uid)
        self.assertIn(
            field_c.id,
            soft_deleted_ids,
            "FH-003: FieldC（快照后新增）应被软删除",
        )

    def test_no_field_sync_when_snapshot_has_no_fields(self):
        """快照无 fields 时不触发字段同步（向后兼容）"""
        table = _fake_table()
        field_a = _fake_field("FieldA")

        rid = str(uuid.uuid4())
        snapshot = {
            "records": {rid: {_hex(field_a.id): "val"}},
            "row_order": [rid],
        }

        result = _run_restore_with_field_sync(
            table, [field_a], snapshot,
        )

        self.assertEqual(
            len(result["field_update_calls"]),
            0,
            "无 fields 定义时不应触发任何字段同步操作",
        )

    def test_schema_version_incremented_on_field_change(self):
        """字段结构变更时应递增 schema_version"""
        table = _fake_table(schema_version=5)
        field_a = _fake_field("FieldA")
        field_b = _fake_field("FieldB", is_deleted=True)

        snapshot = {
            "records": {},
            "row_order": [],
            "fields": [_make_field_def(field_a), _make_field_def(field_b)],
        }

        with (
            patch(f"{_MOD}.Table.objects.using") as t_using,
            patch(f"{_MOD}.TableField.objects.using") as f_using,
            patch(f"{_MOD}.TableRecord.objects.using") as r_using,
            patch(f"{_MOD}.NativeRecordIO"),
            patch(f"{_MOD}.next_record_version", return_value=42),
            patch(f"{_MOD}.table_event_service"),
            patch(f"{_MOD}.python_to_pg", side_effect=lambda v, ft, cfg: v),
            patch(f"{_MOD}.transaction.atomic", side_effect=_noop_atomic),
        ):
            t_using.return_value.filter.return_value.first.return_value = table
            t_using.return_value.filter.return_value.update.return_value = 1

            def _field_filter(**kwargs):
                if "id__in" in kwargs:
                    qs = MagicMock()
                    qs.update.return_value = 1
                    return qs
                if kwargs.get("is_deleted") is False:
                    field_b.is_deleted = False
                    return [field_a, field_b]
                return [field_a, field_b]

            f_using.return_value.filter.side_effect = _field_filter

            r_qs = MagicMock()
            r_qs.select_for_update.return_value = r_qs
            r_qs.values_list.return_value = set()
            r_using.return_value.filter.return_value = r_qs

            from apps.tabdata.services.collab_service import CollabService
            CollabService.restore_from_snapshot(table.id, snapshot)

            t_update_calls = t_using.return_value.filter.return_value.update.call_args_list
            schema_increment_found = any(
                "schema_version" in str(c) for c in t_update_calls
            )
            self.assertTrue(
                schema_increment_found,
                "FH-003: 字段结构变更后应递增 schema_version",
            )


# ── SR-002: 静默丢弃改为 warning ─────────────────────────────


class TestSR002WarningOnUnresolvableField(TestCase):
    """SR-002: 无法映射的 field_hex 应输出 warning"""

    def test_warning_logged_for_unknown_field_in_to_create(self):
        """to_create 路径中无法映射的 field_hex 应输出 warning"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        unknown_hex = uuid.uuid4().hex

        rid = str(uuid.uuid4())
        snapshot = {
            "records": {
                rid: {
                    _hex(field_a.id): "good",
                    unknown_hex: "orphan_value",
                },
            },
            "row_order": [rid],
            "fields": [_make_field_def(field_a)],
        }

        with self.assertLogs(_MOD, level="WARNING") as cm:
            _run_restore_with_field_sync(
                table, [field_a], snapshot,
            )

        warning_messages = [m for m in cm.output if unknown_hex in m]
        self.assertTrue(
            len(warning_messages) > 0,
            f"SR-002: 应输出包含 field_hex={unknown_hex} 的 warning",
        )

    def test_warning_logged_for_unknown_field_in_to_update(self):
        """to_update 路径中无法映射的 field_hex 应输出 warning"""
        table = _fake_table()
        field_a = _fake_field("FieldA")
        unknown_hex = uuid.uuid4().hex

        rid = str(uuid.uuid4())
        snapshot = {
            "records": {
                rid: {
                    _hex(field_a.id): "updated",
                    unknown_hex: "orphan_value",
                },
            },
            "row_order": [rid],
            "fields": [_make_field_def(field_a)],
        }

        with self.assertLogs(_MOD, level="WARNING") as cm:
            _run_restore_with_field_sync(
                table, [field_a], snapshot,
                existing_record_ids={rid},
            )

        warning_messages = [m for m in cm.output if unknown_hex in m]
        self.assertTrue(
            len(warning_messages) > 0,
            f"SR-002: to_update 应输出包含 field_hex={unknown_hex} 的 warning",
        )

    def test_raises_for_snapshot_field_not_in_db(self):
        """CL-008: 快照字段在 DB 中完全不存在（物理删除）时应 raise ValueError"""
        table = _fake_table()
        field_a = _fake_field("FieldA")

        ghost_field_id = uuid.uuid4()
        ghost_field_def = {
            "id": str(ghost_field_id),
            "id_hex": ghost_field_id.hex,
            "name": "GhostField",
            "field_type": "text",
            "config": {},
            "order": 2,
        }

        snapshot = {
            "records": {},
            "row_order": [],
            "fields": [_make_field_def(field_a), ghost_field_def],
        }

        with self.assertRaises(ValueError) as ctx:
            _run_restore_with_field_sync(
                table, [field_a], snapshot,
            )

        self.assertIn(
            "physically deleted",
            str(ctx.exception),
            "CL-008: 错误消息应指明字段已被物理删除",
        )


# ── 端到端场景：字段删除后恢复 ──────────────────────────────


class TestFullScenarioDeleteFieldThenRestore(TestCase):
    """完整场景：删除字段后恢复到含该字段的快照"""

    def test_delete_field_then_restore_to_old_snapshot(self):
        """
        场景：
        1. 表有 FieldA + FieldB
        2. 快照包含 FieldA + FieldB 的记录数据
        3. 用户删除 FieldB → is_deleted=True
        4. 新增 FieldC
        5. restore 到步骤 2 的快照
        期望：FieldB undelete，FieldC soft-delete，记录数据完整
        """
        table = _fake_table()
        field_a = _fake_field("FieldA")
        field_b = _fake_field("FieldB", field_type="number", is_deleted=True)
        field_c = _fake_field("FieldC")

        rid = str(uuid.uuid4())
        snapshot = {
            "records": {
                rid: {
                    _hex(field_a.id): "hello",
                    _hex(field_b.id): 42,
                },
            },
            "row_order": [rid],
            "fields": [_make_field_def(field_a), _make_field_def(field_b)],
        }

        result = _run_restore_with_field_sync(
            table, [field_a, field_b, field_c], snapshot,
        )

        undelete_updates = [
            c for c in result["field_update_calls"]
            if c.get("is_deleted") is False
        ]
        soft_delete_updates = [
            c for c in result["field_update_calls"]
            if c.get("is_deleted") is True
        ]

        self.assertTrue(len(undelete_updates) > 0, "应有 undelete 操作")
        self.assertTrue(len(soft_delete_updates) > 0, "应有 soft-delete 操作")

        all_undeleted_ids = set()
        for u in undelete_updates:
            all_undeleted_ids.update(u.get("ids", []))
        self.assertIn(field_b.id, all_undeleted_ids, "FieldB 应被 undelete")

        all_soft_deleted_ids = set()
        for u in soft_delete_updates:
            all_soft_deleted_ids.update(u.get("ids", []))
        self.assertIn(field_c.id, all_soft_deleted_ids, "FieldC 应被 soft-delete")

        active = result["active_fields_after_sync"]
        active_ids = {f.id for f in active}
        self.assertEqual(
            active_ids,
            {field_a.id, field_b.id},
            "恢复后活跃字段应精确匹配快照定义",
        )

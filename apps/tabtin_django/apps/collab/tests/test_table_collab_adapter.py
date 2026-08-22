"""
TableCollabAdapter 专属测试

覆盖:
- CMS-008: TableCollabAdapter 基础功能测试（序列化、diff、stats）
- CMS-009: compute_diff 字段删除后 roundtrip 行为
- CMS-011: diff chain 跨 schema 版本 rebuild_data
- CMS-020: compute_diff 感知 fields 变更，apply_diff 清除幽灵字段
"""
import json
import uuid
import zlib
from unittest.mock import MagicMock, patch

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.table import TableCollabAdapter  # noqa: E402


def _make_snapshot(fields, records, row_order=None, schema_version=None):
    """构造标准 table 快照结构。"""
    data = {
        "fields": fields,
        "records": records,
        "row_order": row_order or list(records.keys()),
        "total_records": len(records),
    }
    if schema_version is not None:
        data["schema_version"] = schema_version
    return data


def _decompress(blob: bytes) -> dict:
    return json.loads(zlib.decompress(blob).decode("utf-8"))


# ══════════════════════════════════════════════════════════
# CMS-008: TableCollabAdapter 基础功能测试
# ══════════════════════════════════════════════════════════


class TestTableCollabAdapterBasic:
    """CMS-008: TableCollabAdapter 序列化 / 反序列化 / content_stats 基础路径。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_resource_type(self):
        assert self.adapter.resource_type == "table"

    def test_serialize_deserialize_roundtrip(self):
        data = _make_snapshot(
            fields=[{"id": "f1", "name": "Name", "type": "text"}],
            records={"r1": {"f1": "Alice"}, "r2": {"f1": "Bob"}},
        )
        blob = self.adapter.serialize_snapshot(data)
        assert isinstance(blob, bytes)
        assert len(blob) > 0

        restored = self.adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_serialize_empty_snapshot(self):
        data = _make_snapshot(fields=[], records={})
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_deserialize_corrupted_returns_none(self):
        result = self.adapter.deserialize_snapshot(b"not-valid-data")
        assert result is None

    def test_serialize_with_unicode(self):
        data = _make_snapshot(
            fields=[{"id": "f1", "name": "名前", "type": "text"}],
            records={"r1": {"f1": "太郎"}},
        )
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored["records"]["r1"]["f1"] == "太郎"

    def test_get_content_stats(self):
        data = _make_snapshot(
            fields=[
                {"id": "f1", "name": "Name"},
                {"id": "f2", "name": "Age"},
            ],
            records={"r1": {"f1": "A", "f2": 20}, "r2": {"f1": "B", "f2": 30}},
        )
        stats = self.adapter.get_content_stats(data)
        assert stats["record_count"] == 2
        assert stats["field_count"] == 2

    def test_get_content_stats_uses_total_records(self):
        data = {"fields": [{"id": "f1"}], "records": {"r1": {}}, "total_records": 100}
        stats = self.adapter.get_content_stats(data)
        assert stats["record_count"] == 100

    def test_get_content_stats_invalid_data(self):
        assert self.adapter.get_content_stats("not a dict") == {}
        assert self.adapter.get_content_stats(None) == {}

    @patch("django.db.transaction.atomic")
    @patch("apps.tabdata.services.collab_service.CollabService.persist_changes")
    @patch("apps.tabdata.models.Table")
    def test_persist_database_error_propagates_to_http_boundary(
        self,
        mock_table,
        mock_persist,
        _mock_atomic,
    ):
        """表格 adapter 不得把数据库失败吞成可被误判为成功的普通结果。"""
        table_id = uuid.uuid4()
        resource = MagicMock(id=table_id)
        locked_table = MagicMock(id=table_id, record_version_seq=1)
        (
            mock_table.objects.using.return_value
            .select_for_update.return_value
            .filter.return_value
            .first.return_value
        ) = locked_table
        mock_persist.side_effect = RuntimeError("database write failed")

        with pytest.raises(RuntimeError, match="database write failed"):
            self.adapter.persist_changes(
                resource,
                {"base_version": 1, "changed_records": {}},
                {"editor_type": "user", "editor_id": "", "editor_name": ""},
            )

    @patch("django.db.transaction.atomic")
    @patch("apps.tabdata.services.collab_service.CollabService.persist_changes")
    @patch("apps.tabdata.models.Table")
    def test_persist_forwards_per_record_authenticated_editors(
        self,
        mock_table,
        mock_persist,
        _mock_atomic,
    ):
        table_id = uuid.uuid4()
        record_id = str(uuid.uuid4())
        editor_id = str(uuid.uuid4())
        lifecycle_candidate_id = str(uuid.uuid4())
        resource = MagicMock(id=table_id)
        locked_table = MagicMock(id=table_id, record_version_seq=1)
        (
            mock_table.objects.using.return_value
            .select_for_update.return_value
            .filter.return_value
            .first.return_value
        ) = locked_table
        mock_persist.return_value = {"persisted": 1, "version": 2}

        self.adapter.persist_changes(
            resource,
            {
                "base_version": 1,
                "changed_records": {record_id: {"f1": "late"}},
                "record_editor_ids": {record_id: editor_id},
                "record_lifecycle_revalidation_ids": [lifecycle_candidate_id],
            },
            {"editor_type": "user", "editor_id": editor_id, "editor_name": "Alice"},
        )

        assert mock_persist.call_args.kwargs["record_editor_ids"] == {
            record_id: editor_id,
        }
        assert mock_persist.call_args.kwargs["record_lifecycle_revalidation_ids"] == [
            lifecycle_candidate_id,
        ]


# ══════════════════════════════════════════════════════════
# CMS-008: compute_diff / apply_diff 基础路径
# ══════════════════════════════════════════════════════════


class TestTableCollabAdapterDiffBasic:
    """CMS-008: compute_diff / apply_diff 正常路径。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_no_change_returns_none(self):
        data = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}},
        )
        assert self.adapter.compute_diff(data, data) is None

    def test_invalid_input_returns_none(self):
        assert self.adapter.compute_diff("not dict", {}) is None
        assert self.adapter.compute_diff({}, "not dict") is None

    def test_add_record_roundtrip(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}, "r2": {"f1": "v2"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["records"] == current["records"]
        assert result["total_records"] == 2

    def test_remove_record_roundtrip(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}, "r2": {"f1": "v2"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        result = self.adapter.apply_diff(base, diff_blob)
        assert "r2" not in result["records"]
        assert result["total_records"] == 1

    def test_change_record_roundtrip(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "old"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "new"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)
        assert result["records"]["r1"]["f1"] == "new"

    def test_position_id_roundtrip_survives_history_diff_filter(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "old", "__position_id": "pos-old"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "old", "__position_id": "pos-new"}},
        )

        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)

        assert result["records"]["r1"]["__position_id"] == "pos-new"

    def test_row_order_change_roundtrip(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}, "r2": {"f1": "b"}},
            row_order=["r1", "r2"],
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}, "r2": {"f1": "b"}},
            row_order=["r2", "r1"],
        )
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["row_order"] == ["r2", "r1"]

    def test_complex_roundtrip(self):
        """同时增删改记录 + 改行序。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={
                "r1": {"f1": "a", "f2": 1},
                "r2": {"f1": "b", "f2": 2},
                "r3": {"f1": "c", "f2": 3},
            },
            row_order=["r1", "r2", "r3"],
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={
                "r1": {"f1": "a_modified", "f2": 1},
                "r3": {"f1": "c", "f2": 3},
                "r4": {"f1": "d", "f2": 4},
            },
            row_order=["r3", "r1", "r4"],
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)
        assert result["records"] == current["records"]
        assert result["row_order"] == current["row_order"]
        assert result["total_records"] == 3


# ══════════════════════════════════════════════════════════
# CMS-009: 字段删除后 roundtrip 测试
# ══════════════════════════════════════════════════════════


class TestTableDiffFieldDeletionRoundtrip:
    """CMS-009: compute_diff → apply_diff 在字段删除场景下的行为。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_field_deletion_captured_in_diff(self):
        """字段被删除时，diff 中应包含 fields 快照。"""
        base = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fC"}],
            records={"r1": {"fA": 1, "fB": 2, "fC": 3}},
        )
        current = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}],
            records={"r1": {"fA": 1, "fB": 2}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = _decompress(diff_blob)
        assert "fields" in diff, "字段删除应生成 fields diff"
        assert len(diff["fields"]) == 2

    def test_field_deletion_roundtrip_strips_ghost(self):
        """字段删除后 roundtrip，records 中不应残留已删字段的值。"""
        base = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fC"}],
            records={
                "r1": {"fA": "x", "fB": "y", "fC": "z"},
                "r2": {"fA": "a", "fB": "b", "fC": "c"},
            },
        )
        current = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}],
            records={
                "r1": {"fA": "x", "fB": "y"},
                "r2": {"fA": "a", "fB": "b"},
            },
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)

        assert result["fields"] == current["fields"]
        for rid, rdata in result["records"].items():
            assert "fC" not in rdata, f"record {rid} 仍含已删字段 fC"

    def test_field_addition_roundtrip(self):
        """新增字段时，diff 中应包含更新后的 fields。"""
        base = _make_snapshot(
            fields=[{"id": "fA"}],
            records={"r1": {"fA": 1}},
        )
        current = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fD", "name": "New Field"}],
            records={"r1": {"fA": 1, "fD": "hello"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)

        assert len(result["fields"]) == 2
        assert result["records"]["r1"]["fD"] == "hello"

    def test_field_type_change_captured(self):
        """字段类型变更（同 id 但属性不同）应被 diff 捕获。"""
        base = _make_snapshot(
            fields=[{"id": "f1", "type": "text"}],
            records={"r1": {"f1": "hello"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1", "type": "number"}],
            records={"r1": {"f1": 42}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = _decompress(diff_blob)
        assert "fields" in diff
        assert diff["fields"][0]["type"] == "number"

    def test_only_fields_change_no_records_change(self):
        """仅字段结构变更（records 不变）时仍应生成 diff。"""
        base = _make_snapshot(
            fields=[{"id": "f1", "name": "Old"}],
            records={"r1": {"f1": "v"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1", "name": "Renamed"}],
            records={"r1": {"f1": "v"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None, "仅字段元数据变更应生成 diff"

        diff = _decompress(diff_blob)
        assert diff["added_records"] == {}
        assert diff["removed_records"] == []
        assert diff["changed_records"] == {}
        assert diff["fields"][0]["name"] == "Renamed"

    def test_ghost_field_in_changed_records_stripped(self):
        """apply_diff 时，changed_records 中含已删字段的值应被清除。"""
        base = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fC"}],
            records={"r1": {"fA": 1, "fB": 2, "fC": 3}},
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {"fA": 10, "fB": 20, "fC": 30}},
            "fields": [{"id": "fA"}, {"id": "fB"}],
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)

        assert "fC" not in result["records"]["r1"]
        assert result["records"]["r1"]["fA"] == 10
        assert result["records"]["r1"]["fB"] == 20


# ══════════════════════════════════════════════════════════
# CMS-011: diff chain 跨 schema 版本 rebuild_data
# ══════════════════════════════════════════════════════════


class TestTableDiffChainCrossSchemaRebuild:
    """CMS-011: 跨 schema 版本的 diff chain rebuild 测试。

    场景: V1(fields={A,B,C}) → V2(删除 C, records 含 C 的变更)
          → V3(新增字段 D, records 含 D 的值)

    通过 adapter 的 compute_diff/apply_diff 链模拟 rebuild_data 行为。
    """

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_cross_schema_rebuild_v1_to_v3(self):
        """V1→V2→V3 rebuild：字段 C 被删除后不应残留，字段 D 正确出现。"""
        v1 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fC"}],
            records={
                "r1": {"fA": "a1", "fB": "b1", "fC": "c1"},
                "r2": {"fA": "a2", "fB": "b2", "fC": "c2"},
            },
            row_order=["r1", "r2"],
            schema_version=1,
        )
        v2 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}],
            records={
                "r1": {"fA": "a1_mod", "fB": "b1"},
                "r2": {"fA": "a2", "fB": "b2_mod"},
            },
            row_order=["r1", "r2"],
            schema_version=2,
        )
        v3 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fD"}],
            records={
                "r1": {"fA": "a1_mod", "fB": "b1", "fD": "d1"},
                "r2": {"fA": "a2", "fB": "b2_mod", "fD": "d2"},
                "r3": {"fA": "a3", "fB": "b3", "fD": "d3"},
            },
            row_order=["r1", "r2", "r3"],
            schema_version=3,
        )

        diff_v1_v2 = self.adapter.compute_diff(v1, v2)
        diff_v2_v3 = self.adapter.compute_diff(v2, v3)
        assert diff_v1_v2 is not None
        assert diff_v2_v3 is not None

        rebuilt = self.adapter.apply_diff(v1, diff_v1_v2)
        rebuilt = self.adapter.apply_diff(rebuilt, diff_v2_v3)

        assert rebuilt["fields"] == v3["fields"]
        assert rebuilt["schema_version"] == 3
        assert rebuilt["records"] == v3["records"]

        for rid, rdata in rebuilt["records"].items():
            assert "fC" not in rdata, f"幽灵字段 fC 残留在 record {rid}"
            assert "fD" in rdata, f"新字段 fD 缺失于 record {rid}"

    def test_cross_schema_multiple_deletions(self):
        """多次字段删除: V1={A,B,C,D} → V2={A,B,C} → V3={A,B}。"""
        v1 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fC"}, {"id": "fD"}],
            records={"r1": {"fA": 1, "fB": 2, "fC": 3, "fD": 4}},
            schema_version=1,
        )
        v2 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fC"}],
            records={"r1": {"fA": 1, "fB": 2, "fC": 3}},
            schema_version=2,
        )
        v3 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}],
            records={"r1": {"fA": 1, "fB": 2}},
            schema_version=3,
        )

        rebuilt = v1
        rebuilt = self.adapter.apply_diff(rebuilt, self.adapter.compute_diff(v1, v2))
        rebuilt = self.adapter.apply_diff(rebuilt, self.adapter.compute_diff(v2, v3))

        assert len(rebuilt["fields"]) == 2
        assert set(f["id"] for f in rebuilt["fields"]) == {"fA", "fB"}
        assert set(rebuilt["records"]["r1"].keys()) == {"fA", "fB"}

    def test_cross_schema_add_delete_add(self):
        """字段 C: 存在→删除→重新添加（同 id 不同属性）。"""
        v1 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fC", "type": "text"}],
            records={"r1": {"fA": "a", "fC": "old_text"}},
            schema_version=1,
        )
        v2 = _make_snapshot(
            fields=[{"id": "fA"}],
            records={"r1": {"fA": "a"}},
            schema_version=2,
        )
        v3 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fC", "type": "number"}],
            records={"r1": {"fA": "a", "fC": 42}},
            schema_version=3,
        )

        rebuilt = v1
        rebuilt = self.adapter.apply_diff(rebuilt, self.adapter.compute_diff(v1, v2))
        rebuilt = self.adapter.apply_diff(rebuilt, self.adapter.compute_diff(v2, v3))

        assert rebuilt["records"]["r1"]["fC"] == 42
        fc_field = next(f for f in rebuilt["fields"] if f["id"] == "fC")
        assert fc_field["type"] == "number"

    def test_rebuild_preserves_row_order_across_schema(self):
        """跨 schema 版本时 row_order 应正确传播。"""
        v1 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}],
            records={"r1": {"fA": 1}, "r2": {"fA": 2}},
            row_order=["r1", "r2"],
        )
        v2 = _make_snapshot(
            fields=[{"id": "fA"}],
            records={"r1": {"fA": 1}, "r2": {"fA": 2}, "r3": {"fA": 3}},
            row_order=["r3", "r1", "r2"],
        )

        diff = self.adapter.compute_diff(v1, v2)
        rebuilt = self.adapter.apply_diff(v1, diff)
        assert rebuilt["row_order"] == ["r3", "r1", "r2"]


# ══════════════════════════════════════════════════════════
# CMS-020: compute_diff fields 感知 + 幽灵字段清除
# ══════════════════════════════════════════════════════════


class TestTableDiffGhostFieldProtection:
    """CMS-020: compute_diff 感知 fields 变更，apply_diff 清除幽灵字段。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_diff_includes_fields_on_field_removal(self):
        """字段被删除时 diff 中必须包含 fields 快照。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={"r1": {"f1": "a", "f2": "b", "f3": "c"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a", "f2": "b"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        diff = _decompress(diff_blob)

        assert "fields" in diff
        field_ids = {f["id"] for f in diff["fields"]}
        assert field_ids == {"f1", "f2"}

    def test_diff_includes_fields_on_field_addition(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a", "f2": "new"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        diff = _decompress(diff_blob)
        assert "fields" in diff

    def test_no_fields_in_diff_when_unchanged(self):
        base = _make_snapshot(
            fields=[{"id": "f1", "name": "X"}],
            records={"r1": {"f1": "a"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1", "name": "X"}],
            records={"r1": {"f1": "b"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        diff = _decompress(diff_blob)
        assert "fields" not in diff

    def test_apply_diff_removes_ghost_field_from_existing_records(self):
        """base 的 records 含字段 C 值，diff 删除了字段 C → apply 后 C 被清除。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={
                "r1": {"f1": "a", "f2": "b", "f3": "ghost"},
                "r2": {"f1": "x", "f2": "y", "f3": "ghost2"},
            },
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {},
            "fields": [{"id": "f1"}, {"id": "f2"}],
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)

        for rid, rdata in result["records"].items():
            assert "f3" not in rdata, f"幽灵字段 f3 残留在 {rid}"

    def test_apply_diff_removes_ghost_from_added_records(self):
        """added_records 中含已删字段的值也应被清除。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={},
        )
        diff_dict = {
            "added_records": {"r_new": {"f1": "ok", "f2": "ok", "f_gone": "ghost"}},
            "removed_records": [],
            "changed_records": {},
            "fields": [{"id": "f1"}, {"id": "f2"}],
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)

        assert "f_gone" not in result["records"]["r_new"]
        assert result["records"]["r_new"]["f1"] == "ok"

    def test_apply_diff_without_fields_still_strips_ghosts(self):
        """DC-005: 即使 diff 不含 fields，也应根据 base fields 清除幽灵字段。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a", "f2": "b", "extra": "preserved"}},
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {"f1": "a2", "f2": "b2", "extra": "preserved"}},
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)

        assert "extra" not in result["records"]["r1"]
        assert result["records"]["r1"]["f1"] == "a2"
        assert result["records"]["r1"]["f2"] == "b2"

    def test_schema_version_propagated_through_diff(self):
        """schema_version 应通过 diff 正确传播。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}},
            schema_version=1,
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a", "f2": "new"}},
            schema_version=2,
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)

        assert result["schema_version"] == 2

    def test_fields_to_map_helper(self):
        """_fields_to_map 应正确处理 id 和 id_hex 两种格式。"""
        fields = [
            {"id": "f1", "name": "A"},
            {"id_hex": "f2", "name": "B"},
            {"name": "NoId"},
        ]
        result = TableCollabAdapter._fields_to_map(fields)
        assert "f1" in result
        assert "f2" in result
        assert len(result) == 2

    def test_empty_fields_no_ghost_stripping(self):
        """fields=[] 时 valid_hex 为空，不应清除任何 record 值。"""
        adapter = TableCollabAdapter()
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a", "f2": "b"}},
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {},
            "fields": [],
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())
        result = adapter.apply_diff(base, diff_blob)

        assert result["fields"] == []
        assert result["records"]["r1"]["f1"] == "a"
        assert result["records"]["r1"]["f2"] == "b"

    def test_fields_order_only_change_not_detected(self):
        """仅 fields 顺序变更（内容相同）时不应生成 diff。"""
        adapter = TableCollabAdapter()
        base = _make_snapshot(
            fields=[{"id": "f1", "name": "A"}, {"id": "f2", "name": "B"}],
            records={"r1": {"f1": "x", "f2": "y"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f2", "name": "B"}, {"id": "f1", "name": "A"}],
            records={"r1": {"f1": "x", "f2": "y"}},
        )
        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is None, "仅顺序变更不应产生 diff（当前设计）"


# ══════════════════════════════════════════════════════════
# CMS-011: 通过 VersionHistoryService.rebuild_data 集成验证
# ══════════════════════════════════════════════════════════


class TestTableRebuildDataIntegration:
    """CMS-011: 模拟 rebuild_data 的 diff chain 回放路径。

    不依赖数据库，通过 mock VersionHistory 对象验证
    adapter 在 rebuild_data 链路中的行为。

    rebuild_data 使用迭代式单步回溯（DC-019）：
    从 target diff 开始，逐步查询 parent 直到找到 snapshot anchor，
    然后批量获取链路条目，依次 apply_diff。
    """

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_rebuild_three_version_chain(self):
        """V1(快照) → V2(diff, 删字段C) → V3(diff, 加字段D) rebuild 正确。"""
        from apps.collab.models import VersionHistory
        from apps.collab.service import VersionHistoryService

        svc = VersionHistoryService(self.adapter)

        v1_data = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fC"}],
            records={"r1": {"fA": "a1", "fB": "b1", "fC": "c1"}},
            schema_version=1,
        )
        v2_data = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}],
            records={"r1": {"fA": "a1_v2", "fB": "b1"}},
            schema_version=2,
        )
        v3_data = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fD"}],
            records={
                "r1": {"fA": "a1_v2", "fB": "b1", "fD": "d1"},
                "r2": {"fA": "a2", "fB": "b2", "fD": "d2"},
            },
            row_order=["r1", "r2"],
            schema_version=3,
        )

        snap_id = uuid.uuid4()
        diff1_id = uuid.uuid4()
        diff2_id = uuid.uuid4()
        resource_id = uuid.uuid4()

        snap_blob = self.adapter.serialize_snapshot(v1_data)
        diff1_blob = self.adapter.compute_diff(v1_data, v2_data)
        diff2_blob = self.adapter.compute_diff(v2_data, v3_data)

        mock_snap = MagicMock()
        mock_snap.id = snap_id
        mock_snap.is_snapshot = True
        mock_snap.blob = snap_blob

        mock_diff1 = MagicMock()
        mock_diff1.id = diff1_id
        mock_diff1.is_snapshot = False
        mock_diff1.blob = diff1_blob

        mock_diff2 = MagicMock()
        mock_diff2.id = diff2_id
        mock_diff2.is_snapshot = False
        mock_diff2.blob = diff2_blob

        mock_target = MagicMock()
        mock_target.id = diff2_id
        mock_target.is_snapshot = False
        mock_target.resource_id = resource_id
        mock_target.base_history_id = diff1_id

        iterative_lookup = {
            diff1_id: (False, snap_id),
            snap_id: (True, None),
        }
        entries_by_id = {
            snap_id: mock_snap,
            diff1_id: mock_diff1,
            diff2_id: mock_diff2,
        }

        def mock_filter(**kwargs):
            if "id" in kwargs:
                row_id = kwargs["id"]
                vl_mock = MagicMock()
                row = iterative_lookup.get(row_id)
                vl_mock.first.return_value = row
                filter_qs = MagicMock()
                filter_qs.values_list.return_value = vl_mock
                return filter_qs
            if "id__in" in kwargs:
                needed = kwargs["id__in"]
                return [entries_by_id[eid] for eid in needed if eid in entries_by_id]
            return MagicMock()

        with patch.object(VersionHistory, "objects") as mock_objects, \
             patch("apps.collab.service.transaction"):
            mock_using = MagicMock()
            mock_using.filter = mock_filter
            mock_objects.using.return_value = mock_using

            result = svc.rebuild_data(mock_target)

        assert result is not None, "rebuild_data 不应返回 None"
        assert result["schema_version"] == 3
        assert len(result["fields"]) == 3
        field_ids = {f["id"] for f in result["fields"]}
        assert field_ids == {"fA", "fB", "fD"}
        assert "fC" not in field_ids

        for rid, rdata in result["records"].items():
            assert "fC" not in rdata, f"幽灵字段 fC 残留于 record {rid}"

        assert "r2" in result["records"]
        assert result["records"]["r2"]["fD"] == "d2"


# ══════════════════════════════════════════════════════════
# CL-008: restore 遇空 fields 快照时应 raise
# ══════════════════════════════════════════════════════════


class TestCL008RestoreEmptyFields:
    """CL-008 回归测试：快照无 fields 定义时 restore 不应静默继续。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_restore_raises_on_missing_fields(self):
        """快照完全没有 fields 键时，restore 应 raise ValueError。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()
        data = {"records": {"r1": {"f1": "val"}}, "row_order": ["r1"]}
        with pytest.raises(ValueError, match="no field definitions"):
            self.adapter.restore(resource, data)

    def test_restore_raises_on_empty_fields_list(self):
        """快照 fields 为空列表时，restore 应 raise ValueError。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()
        data = {"fields": [], "records": {"r1": {"f1": "val"}}, "row_order": ["r1"]}
        with pytest.raises(ValueError, match="no field definitions"):
            self.adapter.restore(resource, data)

    @patch("apps.tabdata.services.collab_service.CollabService.restore_from_snapshot")
    def test_restore_proceeds_with_valid_fields(self, mock_restore):
        """快照有有效 fields 时，restore 应正常调用 restore_from_snapshot。"""
        resource = MagicMock()
        resource.id = uuid.uuid4()
        data = {
            "fields": [{"id": "f1", "name": "Name", "field_type": "text"}],
            "records": {"r1": {"f1": "val"}},
            "row_order": ["r1"],
        }
        self.adapter.restore(resource, data)
        mock_restore.assert_called_once_with(str(resource.id), data, user=None)


# ══════════════════════════════════════════════════════════
# CL-014: ghost field 过滤不应误删非 UUID 格式字段
# ══════════════════════════════════════════════════════════


class TestCL014GhostFieldNonUUIDFormat:
    """CL-014 回归测试：apply_diff ghost 过滤对非 UUID 格式字段 id 的处理。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_non_uuid_field_id_not_treated_as_ghost(self):
        """字段 id 为短格式（非 UUID）时，records 中对应 key 不应被误删。"""
        base = _make_snapshot(
            fields=[{"id": "custom_field_1"}, {"id": "custom_field_2"}],
            records={"r1": {"custom_field_1": "val1", "custom_field_2": "val2"}},
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {"custom_field_1": "updated", "custom_field_2": "val2"}},
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)

        assert result["records"]["r1"]["custom_field_1"] == "updated"
        assert result["records"]["r1"]["custom_field_2"] == "val2"

    def test_uuid_field_with_id_hex_works(self):
        """标准场景：字段同时有 id（UUID）和 id_hex，records 用 hex key。"""
        fid = str(uuid.uuid4())
        fhex = fid.replace("-", "")
        base = _make_snapshot(
            fields=[{"id": fid, "id_hex": fhex}],
            records={"r1": {fhex: "val"}},
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {fhex: "new_val"}},
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["records"]["r1"][fhex] == "new_val"

    def test_uuid_field_without_id_hex_uses_replace(self):
        """字段只有 id（UUID 格式）无 id_hex，records 用去 `-` 的 hex key。"""
        fid = str(uuid.uuid4())
        fhex = fid.replace("-", "")
        base = _make_snapshot(
            fields=[{"id": fid}],
            records={"r1": {fhex: "val"}},
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {fhex: "new_val"}},
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["records"]["r1"][fhex] == "new_val"

    def test_field_id_with_special_chars_preserved(self):
        """字段 id 含非 hex 字符时（如下划线），records 使用原始 id 作为 key。"""
        base = _make_snapshot(
            fields=[{"id": "my_field"}, {"id": "another-field"}],
            records={
                "r1": {"my_field": "a", "another-field": "b"},
            },
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {},
            "fields": [{"id": "my_field"}, {"id": "another-field"}],
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)

        assert "my_field" in result["records"]["r1"]
        assert "another-field" in result["records"]["r1"]

    def test_mixed_format_fields_all_preserved(self):
        """混合格式字段（UUID + 短格式 + 含特殊字符），全部正确保留。"""
        fid_uuid = str(uuid.uuid4())
        fhex_uuid = fid_uuid.replace("-", "")
        base = _make_snapshot(
            fields=[
                {"id": fid_uuid, "id_hex": fhex_uuid},
                {"id": "short_id"},
                {"id": "with-dashes"},
            ],
            records={
                "r1": {fhex_uuid: "uuid_val", "short_id": "short_val", "with-dashes": "dash_val"},
            },
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {},
            "fields": [
                {"id": fid_uuid, "id_hex": fhex_uuid},
                {"id": "short_id"},
                {"id": "with-dashes"},
            ],
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)

        assert result["records"]["r1"][fhex_uuid] == "uuid_val"
        assert result["records"]["r1"]["short_id"] == "short_val"
        assert result["records"]["r1"]["with-dashes"] == "dash_val"

    def test_actual_ghost_field_still_removed(self):
        """真正的 ghost 字段仍应被正确清除。"""
        base = _make_snapshot(
            fields=[{"id": "keep_me"}],
            records={"r1": {"keep_me": "good", "ghost_field": "should_go"}},
        )
        diff_dict = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {},
        }
        diff_blob = zlib.compress(json.dumps(diff_dict).encode())

        result = self.adapter.apply_diff(base, diff_blob)

        assert "keep_me" in result["records"]["r1"]
        assert "ghost_field" not in result["records"]["r1"]

# ============================================================
# : persist_changes rejects base_version=0 / mass row delete
# ============================================================


class TestPersistChangesMassDeleteGuard:
    """Empty Y.Doc diff after schema undo must not soft-delete all rows."""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_base_version_zero_conflicts_when_db_version_positive(self):
        table = MagicMock()
        table.id = uuid.uuid4()
        table.record_version_seq = 64
        qs = MagicMock()
        qs.select_for_update.return_value.filter.return_value.first.return_value = table

        with patch("django.db.transaction.atomic"), patch(
            "apps.tabdata.models.Table.objects"
        ) as mock_objects, patch(
            "apps.tabdata.services.collab_service.CollabService.persist_changes"
        ) as mock_persist:
            mock_objects.using.return_value = qs
            result = self.adapter.persist_changes(
                table,
                {"base_version": 0, "deleted_record_ids": ["r1"]},
                {"editor_type": "user", "editor_id": "u1"},
            )

        assert result == {"conflict": True, "current_version": 64}
        mock_persist.assert_not_called()

    def test_mass_delete_of_all_active_rows_rejected(self):
        table = MagicMock()
        table.id = uuid.uuid4()
        table.record_version_seq = 10
        table_qs = MagicMock()
        table_qs.select_for_update.return_value.filter.return_value.first.return_value = table

        record_qs = MagicMock()
        record_qs.filter.return_value.count.return_value = 2

        with patch("django.db.transaction.atomic"), patch(
            "apps.tabdata.models.Table.objects"
        ) as mock_table_objects, patch(
            "apps.tabdata.models.TableRecord.objects"
        ) as mock_record_objects, patch(
            "apps.tabdata.services.collab_service.CollabService.persist_changes"
        ) as mock_persist:
            mock_table_objects.using.return_value = table_qs
            mock_record_objects.using.return_value = record_qs
            result = self.adapter.persist_changes(
                table,
                {
                    "base_version": 10,
                    "deleted_record_ids": ["r1", "r2"],
                    "new_records": {},
                },
                {"editor_type": "user", "editor_id": "u1"},
            )

        assert result.get("rejected_mass_delete") is True
        assert result.get("conflict") is True
        mock_persist.assert_not_called()

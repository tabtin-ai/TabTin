"""
TabData 协作 Adapter 对称性测试

覆盖:
- RT-001: serialize_snapshot / deserialize_snapshot 对称性（含特殊类型）
- RT-002: compute_diff / apply_diff 对称性（含多步链、字段变更、边界场景）
"""
import copy
import json
import os
import uuid
import zlib
from datetime import date, datetime
from decimal import Decimal

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.table import TableCollabAdapter  # noqa: E402


def _make_snapshot(fields, records, row_order=None, schema_version=None, **extra):
    data = {
        "fields": fields,
        "records": records,
        "row_order": row_order or list(records.keys()),
        "total_records": len(records),
    }
    if schema_version is not None:
        data["schema_version"] = schema_version
    data.update(extra)
    return data


# ══════════════════════════════════════════════════════════
# RT-001: serialize / deserialize 对称性
# ══════════════════════════════════════════════════════════


class TestSerializeDeserializeSymmetry:
    """RT-001: 多种数据类型经 serialize → deserialize 后应与原始数据一致。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def _roundtrip(self, data):
        blob = self.adapter.serialize_snapshot(data)
        assert isinstance(blob, bytes)
        restored = self.adapter.deserialize_snapshot(blob)
        return restored

    def test_basic_roundtrip(self):
        data = _make_snapshot(
            fields=[{"id": "f1", "name": "Name", "type": "text"}],
            records={"r1": {"f1": "Alice"}, "r2": {"f1": "Bob"}},
        )
        assert self._roundtrip(data) == data

    def test_empty_snapshot_roundtrip(self):
        data = _make_snapshot(fields=[], records={})
        assert self._roundtrip(data) == data

    def test_unicode_roundtrip(self):
        data = _make_snapshot(
            fields=[{"id": "f1", "name": "名前"}],
            records={"r1": {"f1": "日本語テスト🎌"}},
        )
        restored = self._roundtrip(data)
        assert restored["records"]["r1"]["f1"] == "日本語テスト🎌"

    def test_special_json_types_roundtrip(self):
        """Decimal / datetime / date / UUID 经 _snapshot_json_default 序列化后可往返。"""
        data = {
            "fields": [{"id": "f1"}],
            "records": {
                "r1": {
                    "decimal_val": Decimal("3.14159"),
                    "datetime_val": datetime(2025, 6, 15, 10, 30, 0),
                    "date_val": date(2025, 6, 15),
                    "uuid_val": uuid.UUID("12345678-1234-5678-1234-567812345678"),
                }
            },
            "row_order": ["r1"],
            "total_records": 1,
        }
        restored = self._roundtrip(data)
        assert restored["records"]["r1"]["decimal_val"] == pytest.approx(3.14159)
        assert restored["records"]["r1"]["datetime_val"] == "2025-06-15T10:30:00"
        assert restored["records"]["r1"]["date_val"] == "2025-06-15"
        assert restored["records"]["r1"]["uuid_val"] == "12345678-1234-5678-1234-567812345678"

    def test_nested_structure_roundtrip(self):
        data = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={
                "r1": {
                    "f1": ["tag1", "tag2", "tag3"],
                    "f2": {"nested": {"deep": True}, "count": 42},
                }
            },
        )
        assert self._roundtrip(data) == data

    def test_null_values_roundtrip(self):
        data = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": None, "f2": ""}},
        )
        restored = self._roundtrip(data)
        assert restored["records"]["r1"]["f1"] is None
        assert restored["records"]["r1"]["f2"] == ""

    def test_large_snapshot_roundtrip(self):
        """100 条记录 × 10 字段。"""
        fields = [{"id": f"f{i}"} for i in range(10)]
        records = {}
        for r in range(100):
            rid = f"r{r:03d}"
            records[rid] = {f"f{i}": f"val-{r}-{i}" for i in range(10)}
        data = _make_snapshot(fields=fields, records=records)
        assert self._roundtrip(data) == data

    def test_boolean_and_numeric_roundtrip(self):
        data = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}, {"id": "f4"}],
            records={
                "r1": {
                    "f1": True,
                    "f2": False,
                    "f3": 0,
                    "f4": -999.5,
                }
            },
        )
        restored = self._roundtrip(data)
        assert restored["records"]["r1"]["f1"] is True
        assert restored["records"]["r1"]["f2"] is False
        assert restored["records"]["r1"]["f3"] == 0
        assert restored["records"]["r1"]["f4"] == -999.5

    def test_corrupted_blob_returns_none(self):
        assert self.adapter.deserialize_snapshot(b"garbage") is None

    def test_double_serialize_idempotent(self):
        """两次 serialize → deserialize 结果相同（幂等性）。"""
        data = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "test"}},
        )
        restored1 = self._roundtrip(data)
        restored2 = self._roundtrip(restored1)
        assert restored1 == restored2


# ══════════════════════════════════════════════════════════
# RT-002: compute_diff / apply_diff 对称性
# ══════════════════════════════════════════════════════════


class TestComputeApplyDiffSymmetry:
    """RT-002: 对称性：compute_diff(A, B) → apply_diff(A, diff) ≈ B"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def _assert_roundtrip(self, base, current, *, check_total=True):
        """验证 compute_diff → apply_diff 的对称性。"""
        diff_blob = self.adapter.compute_diff(base, current)
        if diff_blob is None:
            assert base.get("records") == current.get("records")
            assert base.get("row_order") == current.get("row_order")
            return

        result = self.adapter.apply_diff(base, diff_blob)
        assert result is not None, "apply_diff 不应返回 None"
        assert result["records"] == current["records"]
        if "row_order" in current:
            assert result["row_order"] == current["row_order"]
        if "fields" in current:
            assert result["fields"] == current["fields"]
        if "schema_version" in current and current.get("schema_version") is not None:
            assert result.get("schema_version") == current["schema_version"]
        if check_total:
            assert result["total_records"] == len(current["records"])

    # ── 基本对称性 ──

    def test_identical_data_no_diff(self):
        data = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}},
        )
        assert self.adapter.compute_diff(data, data) is None

    def test_add_single_record(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}, "r2": {"f1": "v2"}},
        )
        self._assert_roundtrip(base, current)

    def test_remove_single_record(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}, "r2": {"f1": "v2"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}},
        )
        self._assert_roundtrip(base, current)

    def test_change_single_field(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "old"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "new"}},
        )
        self._assert_roundtrip(base, current)

    def test_add_field_to_record(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "v1"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "v1", "f2": "new-field-value"}},
        )
        self._assert_roundtrip(base, current)

    def test_remove_field_from_record(self):
        """record 内删除字段（不删字段定义，仅清空值）。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "v1", "f2": "v2"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "v1"}},
        )
        self._assert_roundtrip(base, current)

    # ── 行序变更 ──

    def test_row_order_change_only(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}, "r2": {"f1": "b"}, "r3": {"f1": "c"}},
            row_order=["r1", "r2", "r3"],
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}, "r2": {"f1": "b"}, "r3": {"f1": "c"}},
            row_order=["r3", "r1", "r2"],
        )
        self._assert_roundtrip(base, current)

    # ── schema 变更 ──

    def test_schema_field_addition(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}},
            schema_version=1,
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2", "name": "New"}],
            records={"r1": {"f1": "v1", "f2": "new-val"}},
            schema_version=2,
        )
        self._assert_roundtrip(base, current)

    def test_schema_field_removal(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "v1", "f2": "v2"}},
            schema_version=1,
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}},
            schema_version=2,
        )
        self._assert_roundtrip(base, current)

    # ── 复合场景 ──

    def test_complex_mixed_operations(self):
        """同时增删改记录 + 行序变更 + 字段变更。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={
                "r1": {"f1": "a1", "f2": "b1", "f3": "c1"},
                "r2": {"f1": "a2", "f2": "b2", "f3": "c2"},
                "r3": {"f1": "a3", "f2": "b3", "f3": "c3"},
            },
            row_order=["r1", "r2", "r3"],
            schema_version=1,
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f4"}],
            records={
                "r1": {"f1": "a1_mod", "f2": "b1", "f4": "d1"},
                "r3": {"f1": "a3", "f2": "b3_mod", "f4": "d3"},
                "r4": {"f1": "a4", "f2": "b4", "f4": "d4"},
            },
            row_order=["r3", "r4", "r1"],
            schema_version=2,
        )
        self._assert_roundtrip(base, current)

    # ── 多步 diff chain ──

    def test_three_step_diff_chain(self):
        """V1 → V2 → V3 逐步 diff，连续 apply 后结果与 V3 一致。"""
        v1 = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={
                "r1": {"f1": "a", "f2": 1},
                "r2": {"f1": "b", "f2": 2},
            },
            row_order=["r1", "r2"],
            schema_version=1,
        )
        v2 = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={
                "r1": {"f1": "a_v2", "f2": 1},
                "r2": {"f1": "b", "f2": 2},
                "r3": {"f1": "c", "f2": 3},
            },
            row_order=["r1", "r2", "r3"],
            schema_version=1,
        )
        v3 = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={
                "r1": {"f1": "a_v3", "f2": 10, "f3": "x"},
                "r3": {"f1": "c", "f2": 3, "f3": "z"},
            },
            row_order=["r3", "r1"],
            schema_version=2,
        )

        diff_12 = self.adapter.compute_diff(v1, v2)
        diff_23 = self.adapter.compute_diff(v2, v3)
        assert diff_12 is not None
        assert diff_23 is not None

        rebuilt = self.adapter.apply_diff(v1, diff_12)
        rebuilt = self.adapter.apply_diff(rebuilt, diff_23)

        assert rebuilt["records"] == v3["records"]
        assert rebuilt["row_order"] == v3["row_order"]
        assert rebuilt["fields"] == v3["fields"]
        assert rebuilt["schema_version"] == 2

    # ── 边界情况 ──

    def test_empty_to_populated(self):
        base = _make_snapshot(fields=[], records={})
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "hello"}},
        )
        self._assert_roundtrip(base, current)

    def test_populated_to_empty(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "v1"}, "r2": {"f1": "v2"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={},
        )
        self._assert_roundtrip(base, current)

    def test_all_records_replaced(self):
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}, "r2": {"f1": "b"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r3": {"f1": "c"}, "r4": {"f1": "d"}},
        )
        self._assert_roundtrip(base, current)

    def test_diff_preserves_deepcopy_isolation(self):
        """DC-006: apply_diff 不应修改 base_data。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "original"}},
        )
        base_copy = copy.deepcopy(base)
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "changed"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        self.adapter.apply_diff(base, diff_blob)

        assert base == base_copy, "apply_diff 不应修改 base_data（DC-006）"

    def test_corrupted_diff_returns_none(self):
        base = _make_snapshot(fields=[], records={})
        result = self.adapter.apply_diff(base, b"invalid-data")
        assert result is None

    def test_value_type_changes_in_records(self):
        """同一字段值从字符串变为数字、从列表变为 null。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "text", "f2": [1, 2, 3]}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": 42, "f2": None}},
        )
        self._assert_roundtrip(base, current)

    def test_compute_diff_with_invalid_types(self):
        assert self.adapter.compute_diff("string", {}) is None
        assert self.adapter.compute_diff({}, [1, 2]) is None
        assert self.adapter.compute_diff(None, None) is None

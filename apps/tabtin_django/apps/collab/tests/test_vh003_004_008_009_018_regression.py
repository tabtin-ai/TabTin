"""
VH-003 / VH-004 / VH-008 / VH-009 / VH-018 回归测试

VH-003: serialize_snapshot 的 default=str 类型丢失
VH-004: changed_records 全量覆盖而非字段级 delta
VH-008: default=str 无告警，跨模块序列化行为不一致
VH-009: apply_diff 覆盖 total_records 截断语义
VH-018: restore_from_snapshot 中 field_key 格式不一致
"""
import json
import logging
import os
import zlib
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.table import TableCollabAdapter, _snapshot_json_default  # noqa: E402


def _make_snapshot(fields, records, row_order=None, schema_version=None,
                   total_records=None, is_truncated=False):
    data = {
        "fields": fields,
        "records": records,
        "row_order": row_order or list(records.keys()),
        "total_records": total_records if total_records is not None else len(records),
    }
    if is_truncated:
        data["is_truncated"] = True
    if schema_version is not None:
        data["schema_version"] = schema_version
    return data


def _decompress(blob: bytes) -> dict:
    return json.loads(zlib.decompress(blob).decode("utf-8"))


# ══════════════════════════════════════════════════════════
# VH-003: serialize_snapshot 类型感知序列化
# ══════════════════════════════════════════════════════════


class TestVH003TypeAwareSerialization:
    """VH-003 回归：_snapshot_json_default 对已知类型明确转换，不再静默 str()。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_datetime_serialized_as_isoformat(self):
        dt = datetime(2024, 6, 15, 10, 30, 0)
        result = _snapshot_json_default(dt)
        assert result == "2024-06-15T10:30:00"

    def test_date_serialized_as_isoformat(self):
        d = date(2024, 6, 15)
        result = _snapshot_json_default(d)
        assert result == "2024-06-15"

    def test_decimal_serialized_as_float(self):
        result = _snapshot_json_default(Decimal("3.14"))
        assert isinstance(result, float)
        assert abs(result - 3.14) < 1e-9

    def test_uuid_serialized_as_string(self):
        uid = uuid4()
        result = _snapshot_json_default(uid)
        assert result == str(uid)

    def test_bytes_serialized_as_string(self):
        result = _snapshot_json_default(b"hello world")
        assert result == "hello world"

    def test_set_serialized_as_list(self):
        result = _snapshot_json_default({"b", "a", "c"})
        assert result == ["a", "b", "c"]

    def test_unknown_type_logs_warning(self, caplog):
        class CustomObj:
            def __str__(self):
                return "custom"

        with caplog.at_level(logging.WARNING, logger="collab.adapters.table"):
            result = _snapshot_json_default(CustomObj())
        assert result == "custom"
        assert "unexpected type" in caplog.text

    def test_snapshot_roundtrip_with_non_native_types(self):
        """快照包含非 JSON 原生类型时，序列化-反序列化后值保持语义一致。"""
        data = _make_snapshot(
            fields=[{"id": "f1", "field_type": "number"}],
            records={"r1": {"f1": Decimal("42.5")}},
        )
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored["records"]["r1"]["f1"] == 42.5
        assert isinstance(restored["records"]["r1"]["f1"], float)

    def test_snapshot_with_datetime_values(self):
        data = _make_snapshot(
            fields=[{"id": "f1", "field_type": "datetime"}],
            records={"r1": {"f1": datetime(2024, 1, 15, 8, 30, 0)}},
        )
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored["records"]["r1"]["f1"] == "2024-01-15T08:30:00"

    def test_snapshot_with_uuid_values(self):
        uid = uuid4()
        data = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": uid}},
        )
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored["records"]["r1"]["f1"] == str(uid)


# ══════════════════════════════════════════════════════════
# VH-004: changed_records 字段级 delta
# ══════════════════════════════════════════════════════════


class TestVH004FieldLevelDelta:
    """VH-004 回归：compute_diff 产生字段级 delta，apply_diff merge 而非全量覆盖。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_diff_format_marker_present(self):
        """新 diff 必须包含 _diff_format: field_delta 标记。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "old"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "new"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        diff = _decompress(diff_blob)
        assert diff.get("_diff_format") == "field_delta"

    def test_changed_records_contains_delta_not_full(self):
        """changed_records 只包含变更的字段，不是完整记录。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={"r1": {"f1": "a", "f2": "b", "f3": "c"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={"r1": {"f1": "a_new", "f2": "b", "f3": "c"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        diff = _decompress(diff_blob)
        assert diff["changed_records"]["r1"] == {"f1": "a_new"}

    def test_field_delta_roundtrip(self):
        """字段级 delta compute → apply 结果正确。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a", "f2": "b"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a_new", "f2": "b"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)
        assert result["records"]["r1"] == {"f1": "a_new", "f2": "b"}

    def test_field_removal_tracked_in_diff(self):
        """记录中字段被删除时，diff 包含 changed_records_removed_fields。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a", "f2": "b"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        diff = _decompress(diff_blob)
        assert "r1" in diff.get("changed_records_removed_fields", {})
        assert "f2" in diff["changed_records_removed_fields"]["r1"]

    def test_field_removal_applied_correctly(self):
        """apply_diff 正确删除 changed_records_removed_fields 中指定的字段。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={"r1": {"f1": "a", "f2": "b", "f3": "c"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a_new"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)
        assert "f2" not in result["records"]["r1"]
        assert "f3" not in result["records"]["r1"]
        assert result["records"]["r1"]["f1"] == "a_new"

    def test_cross_schema_field_add_delete_preserves_existing(self):
        """VH-004 核心场景：跨 schema diff chain 中字段级 merge 保留 base 中的有效字段。

        V1: fields={A, B, C}, R1={A:1, B:2, C:3}
        V2: fields={A, B}, R1={A:10, B:2}  (删除 C, 修改 A)
        V3: fields={A, B, D}, R1={A:10, B:2, D:4}  (新增 D)

        diff(V1→V2) 对 R1: delta={A:10}, removed_fields=[C]
        diff(V2→V3) 对 R1: delta={D:4}

        apply(V1, diff12) → R1={A:10, B:2}  (C 被 remove + ghost filter)
        apply(上述, diff23) → R1={A:10, B:2, D:4}  (B 不会丢失)
        """
        v1 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fC"}],
            records={"r1": {"fA": 1, "fB": 2, "fC": 3}},
            schema_version=1,
        )
        v2 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}],
            records={"r1": {"fA": 10, "fB": 2}},
            schema_version=2,
        )
        v3 = _make_snapshot(
            fields=[{"id": "fA"}, {"id": "fB"}, {"id": "fD"}],
            records={"r1": {"fA": 10, "fB": 2, "fD": 4}},
            schema_version=3,
        )

        diff12 = self.adapter.compute_diff(v1, v2)
        diff23 = self.adapter.compute_diff(v2, v3)

        rebuilt = self.adapter.apply_diff(v1, diff12)
        rebuilt = self.adapter.apply_diff(rebuilt, diff23)

        assert rebuilt["records"]["r1"] == {"fA": 10, "fB": 2, "fD": 4}
        assert rebuilt["schema_version"] == 3

    def test_backward_compat_old_format_full_overwrite(self):
        """旧格式 diff（无 _diff_format 标记）仍使用全量覆盖。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}],
            records={"r1": {"f1": "a", "f2": "b"}},
        )
        old_diff = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {"f1": "new_a"}},
        }
        diff_blob = zlib.compress(json.dumps(old_diff).encode())
        result = self.adapter.apply_diff(base, diff_blob)
        # 旧格式全量覆盖：f2 丢失（这是旧行为，向后兼容）
        assert result["records"]["r1"] == {"f1": "new_a"}

    def test_complex_multi_record_delta(self):
        """多条记录同时有不同字段的变更。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={
                "r1": {"f1": "a", "f2": "b", "f3": "c"},
                "r2": {"f1": "x", "f2": "y", "f3": "z"},
            },
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={
                "r1": {"f1": "a_new", "f2": "b", "f3": "c"},
                "r2": {"f1": "x", "f2": "y_new", "f3": "z_new"},
            },
        )
        diff_blob = self.adapter.compute_diff(base, current)
        diff = _decompress(diff_blob)
        assert diff["changed_records"]["r1"] == {"f1": "a_new"}
        assert diff["changed_records"]["r2"] == {"f2": "y_new", "f3": "z_new"}

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["records"] == current["records"]


# ══════════════════════════════════════════════════════════
# VH-008: default=str 告警
# ══════════════════════════════════════════════════════════


class TestVH008SerializationWarning:
    """VH-008 回归：未知类型序列化时产生 warning，不再静默。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_unknown_type_in_snapshot_logs_warning(self, caplog):
        class WeirdType:
            def __str__(self):
                return "weird"

        data = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": WeirdType()}},
        )
        with caplog.at_level(logging.WARNING, logger="collab.adapters.table"):
            blob = self.adapter.serialize_snapshot(data)

        assert "unexpected type" in caplog.text
        assert "WeirdType" in caplog.text
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored["records"]["r1"]["f1"] == "weird"

    def test_known_types_no_warning(self, caplog):
        data = _make_snapshot(
            fields=[{"id": "f1"}, {"id": "f2"}, {"id": "f3"}],
            records={"r1": {
                "f1": Decimal("1.5"),
                "f2": datetime(2024, 1, 1),
                "f3": uuid4(),
            }},
        )
        with caplog.at_level(logging.WARNING, logger="collab.adapters.table"):
            self.adapter.serialize_snapshot(data)
        assert "unexpected type" not in caplog.text

    def test_compute_diff_also_uses_safe_serializer(self, caplog):
        """compute_diff 中的 JSON 序列化也应使用 _snapshot_json_default。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": Decimal("1.0")}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": Decimal("2.0")}},
        )
        with caplog.at_level(logging.WARNING, logger="collab.adapters.table"):
            diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None
        assert "unexpected type" not in caplog.text

        diff = _decompress(diff_blob)
        assert diff["changed_records"]["r1"]["f1"] == 2.0


# ══════════════════════════════════════════════════════════
# VH-009: apply_diff 保留截断语义
# ══════════════════════════════════════════════════════════


class TestVH009TruncationSemantics:
    """VH-009 回归：截断快照的 total_records 和 is_truncated 在 apply_diff 后保留。"""

    def setup_method(self):
        self.adapter = TableCollabAdapter()

    def test_truncated_snapshot_preserves_total_records(self):
        """截断快照 apply_diff 后 total_records 不被覆盖。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}, "r2": {"f1": "b"}},
            total_records=50000,
            is_truncated=True,
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a_new"}, "r2": {"f1": "b"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)

        assert result["total_records"] == 50000
        assert result["is_truncated"] is True

    def test_non_truncated_snapshot_updates_total_records(self):
        """非截断快照 apply_diff 后 total_records 正常更新。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}, "r2": {"f1": "b"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)

        assert result["total_records"] == 2

    def test_truncated_base_with_record_addition(self):
        """截断快照上新增记录，total_records 仍保留原始值。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}},
            total_records=10000,
            is_truncated=True,
        )
        current_records = dict(base["records"])
        current_records["r2"] = {"f1": "b"}
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records=current_records,
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)

        assert result["total_records"] == 10000
        assert result["is_truncated"] is True
        assert "r2" in result["records"]

    def test_no_truncation_marker_updates_normally(self):
        """没有 is_truncated 标记的快照，total_records 按实际数量更新。"""
        base = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}, "r2": {"f1": "b"}, "r3": {"f1": "c"}},
        )
        current = _make_snapshot(
            fields=[{"id": "f1"}],
            records={"r1": {"f1": "a"}},
        )
        diff_blob = self.adapter.compute_diff(base, current)
        result = self.adapter.apply_diff(base, diff_blob)
        assert result["total_records"] == 1


# ══════════════════════════════════════════════════════════
# VH-018: field_key 格式一致性（单元测试模拟）
# ══════════════════════════════════════════════════════════


class TestVH018FieldKeyNormalization:
    """VH-018 回归：restore_from_snapshot 中 RecordHistory 的 field_key 格式一致性。

    这里测试的是 key 标准化逻辑的正确性，不依赖数据库。
    通过模拟 old_data 和 snap_data 验证标准化行为。
    """

    @staticmethod
    def _normalize_old_data_keys(old_data: dict) -> dict:
        """模拟修复后的 to_delete / to_update 分支的键标准化逻辑。"""
        result = {}
        for k, v in old_data.items():
            nk = str(k).replace("-", "")
            if not nk.startswith('_'):
                result[nk] = v
        return result

    @staticmethod
    def _normalize_snap_data_keys(snap_data: dict) -> dict:
        """模拟 to_create 分支的键标准化逻辑。"""
        result = {}
        for fh, fv in snap_data.items():
            if fh.startswith("__"):
                continue
            result[fh.replace("-", "")] = fv
        return result

    def test_uuid_with_dashes_normalized(self):
        """UUID 格式 key（含连字符）标准化后去连字符。"""
        fid = str(uuid4())
        old_data = {fid: "value", "_internal": "skip"}
        normalized = self._normalize_old_data_keys(old_data)
        assert fid.replace("-", "") in normalized
        assert fid not in normalized
        assert "_internal" not in normalized

    def test_hex_key_unchanged(self):
        """已经是 hex 格式的 key 标准化后不变。"""
        fhex = uuid4().hex
        old_data = {fhex: "value"}
        normalized = self._normalize_old_data_keys(old_data)
        assert fhex in normalized

    def test_create_and_update_produce_same_keys(self):
        """to_create 和 to_update 分支对同一个 UUID 字段产生相同的 key 格式。"""
        fid = str(uuid4())
        fhex = fid.replace("-", "")
        snap_data = {fid: "new_val", "__order": 1000}
        old_data = {fid: "old_val"}

        create_keys = set(self._normalize_snap_data_keys(snap_data).keys())
        update_keys = set(self._normalize_old_data_keys(old_data).keys())

        assert create_keys == {fhex}
        assert update_keys == {fhex}
        assert create_keys == update_keys

    def test_mixed_format_keys_unified(self):
        """old_data 中混合 UUID 和 hex 格式的 key，标准化后统一为 hex。"""
        fid_uuid = str(uuid4())
        fid_hex = uuid4().hex
        old_data = {fid_uuid: "val1", fid_hex: "val2"}
        normalized = self._normalize_old_data_keys(old_data)
        assert fid_uuid.replace("-", "") in normalized
        assert fid_hex in normalized
        assert len(normalized) == 2

    def test_field_change_detection_with_normalized_keys(self):
        """模拟 to_update 分支的变更检测逻辑（使用标准化键后能正确匹配）。"""
        fid = str(uuid4())
        fhex = fid.replace("-", "")

        old_data = {fid: "old_value"}
        snap_data = {fid: "new_value", "__order": 1000}

        normalized_old = self._normalize_old_data_keys(old_data)
        new_data = self._normalize_snap_data_keys(snap_data)

        fc = {}
        for k in set(normalized_old.keys()) | set(new_data.keys()):
            ov = normalized_old.get(k)
            nv = new_data.get(k)
            if ov != nv:
                fc[k] = {"old": ov, "new": nv}

        assert len(fc) == 1
        assert fhex in fc
        assert fc[fhex] == {"old": "old_value", "new": "new_value"}

    def test_no_false_positive_changes_after_normalization(self):
        """old_data 和 snap_data 值相同但 key 格式不同时，
        标准化后不应产生虚假变更。"""
        fid = str(uuid4())
        fhex = fid.replace("-", "")

        old_data = {fid: "same_value"}
        snap_data = {fhex: "same_value"}

        normalized_old = self._normalize_old_data_keys(old_data)
        new_data = self._normalize_snap_data_keys(snap_data)

        fc = {}
        for k in set(normalized_old.keys()) | set(new_data.keys()):
            ov = normalized_old.get(k)
            nv = new_data.get(k)
            if ov != nv:
                fc[k] = {"old": ov, "new": nv}

        assert len(fc) == 0, "值相同的字段不应产生变更记录"

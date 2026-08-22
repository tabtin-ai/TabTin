"""
回归测试：DC-003 关联 — TableCollabAdapter compute_diff / apply_diff 字段追踪

DC-003: restore_from_snapshot 应使用快照 fields 定义。
为确保 rebuild_data 路径（compute_diff → apply_diff 链）也能产生正确的 fields，
验证 diff 正确携带并还原字段定义变更。
"""
import os
import json
import uuid
import zlib

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from apps.collab.adapters.table import TableCollabAdapter  # noqa: E402


@pytest.fixture
def adapter():
    return TableCollabAdapter()


def _field_def(name="F1", ftype="text", fid=None):
    fid = fid or uuid.uuid4()
    return {
        "id": str(fid),
        "id_hex": fid.hex,
        "name": name,
        "field_type": ftype,
        "config": {},
        "order": 0,
    }


class TestComputeDiffFieldsTracking:
    """compute_diff 应追踪 fields 变更"""

    def test_fields_change_included_in_diff(self, adapter):
        """字段增删应出现在 diff 中"""
        f1 = _field_def("F1")
        f2 = _field_def("F2")

        base = {"records": {}, "row_order": [], "fields": [f1]}
        curr = {"records": {}, "row_order": [], "fields": [f1, f2]}

        diff_blob = adapter.compute_diff(base, curr)
        assert diff_blob is not None, "字段变更应产生非 None diff"

        diff = json.loads(zlib.decompress(diff_blob))
        assert "fields" in diff, "diff 应包含 fields 键"
        assert len(diff["fields"]) == 2

    def test_no_diff_when_fields_unchanged(self, adapter):
        f1 = _field_def("F1")
        base = {"records": {}, "row_order": [], "fields": [f1]}
        curr = {"records": {}, "row_order": [], "fields": [f1]}

        diff_blob = adapter.compute_diff(base, curr)
        assert diff_blob is None, "无变更应返回 None"

    def test_field_removal_tracked(self, adapter):
        f1 = _field_def("F1")
        f2 = _field_def("F2")

        base = {"records": {}, "row_order": [], "fields": [f1, f2]}
        curr = {"records": {}, "row_order": [], "fields": [f1]}

        diff_blob = adapter.compute_diff(base, curr)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert "fields" in diff
        assert len(diff["fields"]) == 1
        assert diff["fields"][0]["name"] == "F1"

    def test_schema_version_change_tracked(self, adapter):
        base = {"records": {}, "row_order": [], "fields": [], "schema_version": 1}
        curr = {"records": {}, "row_order": [], "fields": [], "schema_version": 2}

        diff_blob = adapter.compute_diff(base, curr)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert diff.get("schema_version") == 2


class TestApplyDiffFieldsTracking:
    """apply_diff 应正确还原 fields"""

    def test_fields_applied_from_diff(self, adapter):
        f1 = _field_def("F1")
        f2 = _field_def("F2")

        base = {"records": {}, "row_order": [], "fields": [f1]}
        curr = {"records": {}, "row_order": [], "fields": [f1, f2]}

        diff_blob = adapter.compute_diff(base, curr)
        result = adapter.apply_diff(base, diff_blob)

        assert len(result["fields"]) == 2
        field_names = {f["name"] for f in result["fields"]}
        assert field_names == {"F1", "F2"}

    def test_fields_absent_in_diff_preserves_base(self, adapter):
        """diff 不含 fields 时应保留 base 的 fields"""
        f1 = _field_def("F1")

        base = {"records": {"r1": {"a": 1}}, "row_order": ["r1"], "fields": [f1]}

        diff_data = {"added_records": {}, "removed_records": [], "changed_records": {"r1": {"a": 2}}}
        diff_blob = zlib.compress(json.dumps(diff_data).encode())

        result = adapter.apply_diff(base, diff_blob)
        assert result["fields"] == [f1]

    def test_apply_diff_returns_none_on_corrupt_blob(self, adapter):
        """损坏的 diff blob 应返回 None（DC-001 修复验证）"""
        base = {"records": {}, "row_order": [], "fields": []}
        result = adapter.apply_diff(base, b"corrupt data")
        assert result is None

    def test_ghost_fields_cleaned_after_field_removal(self, adapter):
        """字段删除后，记录中的幽灵字段 hex 应被清除"""
        f1_id = uuid.uuid4()
        f2_id = uuid.uuid4()
        f1 = _field_def("F1", fid=f1_id)
        f2 = _field_def("F2", fid=f2_id)

        base = {
            "records": {"r1": {f1_id.hex: "v1", f2_id.hex: "v2", "__order": 0}},
            "row_order": ["r1"],
            "fields": [f1, f2],
        }

        diff_data = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {},
            "fields": [f1],
        }
        diff_blob = zlib.compress(json.dumps(diff_data).encode())

        result = adapter.apply_diff(base, diff_blob)
        r1_data = result["records"]["r1"]
        assert f1_id.hex in r1_data, "保留的字段值应存在"
        assert f2_id.hex not in r1_data, "已删除字段的幽灵值应被清除"
        assert "__order" in r1_data, "系统字段不受幽灵清理影响"


class TestRoundTripFieldsDiff:
    """compute_diff + apply_diff 往返对称性验证"""

    def test_roundtrip_with_field_changes(self, adapter):
        """字段增删 + 记录变更的 diff 往返应完全对称"""
        f1_id = uuid.uuid4()
        f2_id = uuid.uuid4()
        f3_id = uuid.uuid4()

        f1 = _field_def("F1", fid=f1_id)
        f2 = _field_def("F2", fid=f2_id)
        f3 = _field_def("F3", fid=f3_id)

        base = {
            "records": {
                "r1": {f1_id.hex: "a", f2_id.hex: "b"},
            },
            "row_order": ["r1"],
            "fields": [f1, f2],
            "schema_version": 1,
        }

        current = {
            "records": {
                "r1": {f1_id.hex: "a_modified", f3_id.hex: "c"},
                "r2": {f1_id.hex: "new", f3_id.hex: "new_c"},
            },
            "row_order": ["r1", "r2"],
            "fields": [f1, f3],
            "schema_version": 2,
        }

        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        rebuilt = adapter.apply_diff(base, diff_blob)

        assert set(rebuilt["records"].keys()) == {"r1", "r2"}
        assert rebuilt["row_order"] == ["r1", "r2"]
        assert len(rebuilt["fields"]) == 2
        rebuilt_field_names = {f["name"] for f in rebuilt["fields"]}
        assert rebuilt_field_names == {"F1", "F3"}
        assert rebuilt["schema_version"] == 2

        assert f2_id.hex not in rebuilt["records"]["r1"], \
            "F2 幽灵值应被 apply_diff 清除"

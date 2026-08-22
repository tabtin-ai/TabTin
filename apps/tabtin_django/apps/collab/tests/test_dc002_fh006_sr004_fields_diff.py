"""
DC-002 / FH-006 / SR-004 回归测试：compute_diff / apply_diff 字段（fields）追踪

验证 TableCollabAdapter 的 compute_diff 和 apply_diff 在字段结构变更时
正确记录和还原 fields 与 schema_version，以及幽灵字段清理逻辑。
"""
import json
import zlib

import pytest

from apps.collab.adapters.table import TableCollabAdapter


def _make_field(fid: str, name: str, field_type: str = "text", order: int = 0):
    hex_id = fid.replace("-", "")
    return {
        "id": fid,
        "id_hex": hex_id,
        "name": name,
        "field_type": field_type,
        "config": {},
        "order": order,
    }


FIELD_A = _make_field("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Name", "text", 0)
FIELD_B = _make_field("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Age", "number", 1)
FIELD_C = _make_field("cccccccc-cccc-cccc-cccc-cccccccccccc", "Email", "email", 2)

HEX_A = FIELD_A["id_hex"]
HEX_B = FIELD_B["id_hex"]
HEX_C = FIELD_C["id_hex"]


def _base_snapshot():
    return {
        "table_id": "t-001",
        "table_name": "Users",
        "table_version": 1,
        "schema_version": 1,
        "fields": [FIELD_A, FIELD_B],
        "records": {
            "r1": {HEX_A: "Alice", HEX_B: 30, "__order": 0, "__version": 1},
            "r2": {HEX_A: "Bob", HEX_B: 25, "__order": 1, "__version": 1},
        },
        "row_order": ["r1", "r2"],
        "total_records": 2,
    }


@pytest.fixture
def adapter():
    return TableCollabAdapter()


class TestFieldsDiffRoundtrip:
    """DC-002 / FH-006: compute_diff 追踪 fields 变更 + apply_diff 还原。"""

    def test_field_added(self, adapter: TableCollabAdapter):
        """新增字段时 diff 应包含完整 fields 列表。"""
        base = _base_snapshot()
        current = {**base, "fields": [FIELD_A, FIELD_B, FIELD_C], "schema_version": 2}

        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert "fields" in diff
        assert len(diff["fields"]) == 3
        assert diff["schema_version"] == 2

    def test_field_removed(self, adapter: TableCollabAdapter):
        """删除字段时 diff 应包含新的 fields 列表。"""
        base = _base_snapshot()
        current = {**base, "fields": [FIELD_A], "schema_version": 2}

        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert "fields" in diff
        assert len(diff["fields"]) == 1

    def test_field_renamed(self, adapter: TableCollabAdapter):
        """字段重命名时 diff 应包含更新后的 fields。"""
        base = _base_snapshot()
        renamed_b = {**FIELD_B, "name": "Years"}
        current = {**base, "fields": [FIELD_A, renamed_b], "schema_version": 2}

        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert "fields" in diff
        found = [f for f in diff["fields"] if f["id_hex"] == HEX_B]
        assert found[0]["name"] == "Years"

    def test_no_field_change_returns_none(self, adapter: TableCollabAdapter):
        """fields 未变更且 records 也没有变化时应返回 None。"""
        base = _base_snapshot()
        current = {**base}
        assert adapter.compute_diff(base, current) is None

    def test_only_fields_changed_produces_diff(self, adapter: TableCollabAdapter):
        """仅 fields 变更（records 不变）也应生成 diff。"""
        base = _base_snapshot()
        current = {**base, "fields": [FIELD_A, FIELD_B, FIELD_C], "schema_version": 2}

        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert diff["added_records"] == {}
        assert diff["removed_records"] == []
        assert diff["changed_records"] == {}
        assert "fields" in diff

    def test_roundtrip_field_added(self, adapter: TableCollabAdapter):
        """compute_diff → apply_diff 往返：新增字段后重建结果与 current 一致。"""
        base = _base_snapshot()
        current = {
            **base,
            "fields": [FIELD_A, FIELD_B, FIELD_C],
            "schema_version": 2,
            "records": {
                "r1": {HEX_A: "Alice", HEX_B: 30, HEX_C: "alice@test.com", "__order": 0, "__version": 1},
                "r2": {HEX_A: "Bob", HEX_B: 25, HEX_C: "bob@test.com", "__order": 1, "__version": 1},
            },
        }

        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        rebuilt = adapter.apply_diff(base, diff_blob)
        assert rebuilt["fields"] == current["fields"]
        assert rebuilt["schema_version"] == 2
        assert rebuilt["records"]["r1"][HEX_C] == "alice@test.com"

    def test_roundtrip_field_removed(self, adapter: TableCollabAdapter):
        """compute_diff → apply_diff 往返：删除字段后重建结果正确。"""
        base = _base_snapshot()
        current = {
            **base,
            "fields": [FIELD_A],
            "schema_version": 2,
            "records": {
                "r1": {HEX_A: "Alice", "__order": 0, "__version": 1},
                "r2": {HEX_A: "Bob", "__order": 1, "__version": 1},
            },
        }

        diff_blob = adapter.compute_diff(base, current)
        rebuilt = adapter.apply_diff(base, diff_blob)

        assert rebuilt["fields"] == [FIELD_A]
        assert rebuilt["schema_version"] == 2
        assert HEX_B not in rebuilt["records"]["r1"]
        assert rebuilt["records"]["r1"][HEX_A] == "Alice"

    def test_roundtrip_schema_version(self, adapter: TableCollabAdapter):
        """schema_version 变更应被追踪和还原。"""
        base = _base_snapshot()
        current = {**base, "schema_version": 5}

        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        rebuilt = adapter.apply_diff(base, diff_blob)
        assert rebuilt["schema_version"] == 5


class TestApplyDiffFieldsGhostCleanup:
    """DC-002 补充：apply_diff 中幽灵字段清理正确性。"""

    def test_ghost_field_cleaned(self, adapter: TableCollabAdapter):
        """字段删除后 records 中对应 hex 键应被清除。"""
        base = _base_snapshot()
        current = {
            **base,
            "fields": [FIELD_A],
            "schema_version": 2,
        }

        diff_blob = adapter.compute_diff(base, current)
        rebuilt = adapter.apply_diff(base, diff_blob)

        for rid, rdata in rebuilt["records"].items():
            assert HEX_B not in rdata, f"record {rid} still has ghost field {HEX_B}"

    def test_system_fields_preserved(self, adapter: TableCollabAdapter):
        """幽灵字段清理不应删除 __order / __version 等系统字段。"""
        base = _base_snapshot()
        current = {**base, "fields": [FIELD_A], "schema_version": 2}

        diff_blob = adapter.compute_diff(base, current)
        rebuilt = adapter.apply_diff(base, diff_blob)

        for rid, rdata in rebuilt["records"].items():
            assert "__order" in rdata, f"record {rid} lost __order"
            assert "__version" in rdata, f"record {rid} lost __version"

    def test_valid_fields_preserved(self, adapter: TableCollabAdapter):
        """幽灵字段清理不应删除仍然有效的字段值。"""
        base = _base_snapshot()
        current = {**base, "fields": [FIELD_A], "schema_version": 2}

        diff_blob = adapter.compute_diff(base, current)
        rebuilt = adapter.apply_diff(base, diff_blob)

        assert rebuilt["records"]["r1"][HEX_A] == "Alice"
        assert rebuilt["records"]["r2"][HEX_A] == "Bob"

    def test_ghost_cleanup_uses_hex_not_uuid(self, adapter: TableCollabAdapter):
        """验证幽灵字段清理使用 id_hex（无连字符）匹配 record keys。"""
        base = _base_snapshot()
        field_only_id = {
            "id": "dddddddd-dddd-dddd-dddd-dddddddddddd",
            "name": "New",
            "field_type": "text",
            "config": {},
            "order": 0,
        }
        hex_d = "dddddddddddddddddddddddddddddddd"
        current = {
            **base,
            "fields": [field_only_id],
            "schema_version": 2,
            "records": {
                "r1": {hex_d: "val", "__order": 0, "__version": 1},
            },
            "row_order": ["r1"],
        }

        diff_blob = adapter.compute_diff(base, current)
        rebuilt = adapter.apply_diff(base, diff_blob)

        assert hex_d in rebuilt["records"]["r1"]
        assert rebuilt["records"]["r1"][hex_d] == "val"


class TestMultiStepRebuild:
    """SR-004: 多步 apply_diff 链式重建中 fields 正确演进。"""

    def test_three_step_field_evolution(self, adapter: TableCollabAdapter):
        """模拟 anchor → diff1(加字段) → diff2(删字段) 三步重建。"""
        anchor = _base_snapshot()

        step1 = {
            **anchor,
            "fields": [FIELD_A, FIELD_B, FIELD_C],
            "schema_version": 2,
            "records": {
                "r1": {HEX_A: "Alice", HEX_B: 30, HEX_C: "a@t.com", "__order": 0, "__version": 2},
                "r2": {HEX_A: "Bob", HEX_B: 25, HEX_C: "b@t.com", "__order": 1, "__version": 2},
            },
        }

        step2 = {
            **step1,
            "fields": [FIELD_A, FIELD_C],
            "schema_version": 3,
            "records": {
                "r1": {HEX_A: "Alice", HEX_C: "a@t.com", "__order": 0, "__version": 3},
                "r2": {HEX_A: "Bob", HEX_C: "b@t.com", "__order": 1, "__version": 3},
            },
        }

        diff1 = adapter.compute_diff(anchor, step1)
        diff2 = adapter.compute_diff(step1, step2)

        assert diff1 is not None
        assert diff2 is not None

        rebuilt_1 = adapter.apply_diff(anchor, diff1)
        assert len(rebuilt_1["fields"]) == 3
        assert rebuilt_1["schema_version"] == 2

        rebuilt_2 = adapter.apply_diff(rebuilt_1, diff2)
        assert len(rebuilt_2["fields"]) == 2
        assert rebuilt_2["schema_version"] == 3
        field_ids = {f["id"] for f in rebuilt_2["fields"]}
        assert FIELD_A["id"] in field_ids
        assert FIELD_C["id"] in field_ids
        assert FIELD_B["id"] not in field_ids
        assert HEX_B not in rebuilt_2["records"]["r1"]

    def test_rebuild_without_fields_in_diff_preserves_base(self, adapter: TableCollabAdapter):
        """旧版 diff（不含 fields 键）不应破坏 base_data 的 fields。"""
        base = _base_snapshot()
        old_diff = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {HEX_A: "Alice Updated", HEX_B: 31, "__order": 0, "__version": 2}},
        }
        old_diff_blob = zlib.compress(json.dumps(old_diff).encode())

        rebuilt = adapter.apply_diff(base, old_diff_blob)
        assert rebuilt["fields"] == base["fields"]
        assert rebuilt["schema_version"] == base["schema_version"]


class TestFieldsToMap:
    """_fields_to_map 辅助方法的正确性。"""

    def test_map_by_id(self):
        fields = [FIELD_A, FIELD_B]
        m = TableCollabAdapter._fields_to_map(fields)
        assert FIELD_A["id"] in m
        assert FIELD_B["id"] in m

    def test_fallback_to_id_hex(self):
        field_no_id = {"id_hex": "aabb", "name": "X", "field_type": "text", "config": {}, "order": 0}
        m = TableCollabAdapter._fields_to_map([field_no_id])
        assert "aabb" in m

    def test_empty_fields(self):
        assert TableCollabAdapter._fields_to_map([]) == {}

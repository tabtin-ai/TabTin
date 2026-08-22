"""
DC-004 / DC-006 回归测试 — TableCollabAdapter

DC-004: compute_diff 在新增行时强制补全 row_order；
        apply_diff 防御性处理历史 diff（有 added_records 但无 row_order）。
DC-006: apply_diff 使用 deepcopy，多步回放不共享引用。
"""
import json
import os
import zlib

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from apps.collab.adapters.table import TableCollabAdapter  # noqa: E402


@pytest.fixture
def adapter():
    return TableCollabAdapter()


def _decompress(blob: bytes) -> dict:
    return json.loads(zlib.decompress(blob).decode("utf-8"))


def _compress(data: dict) -> bytes:
    return zlib.compress(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        level=6,
    )


# ══════════════════════════════════════════════════════════
# DC-004: compute_diff 新增行必须同步 row_order
# ══════════════════════════════════════════════════════════

class TestDC004ComputeDiffRowOrderSync:
    """compute_diff 在存在 added_records 时强制将缺失的行 ID 追加到 row_order。"""

    def test_added_records_missing_from_curr_order_are_appended(self, adapter):
        """新增行不在 curr_order 中时，diff 的 row_order 应包含所有新增行 ID。"""
        base = {
            "records": {"r1": {"f1": "a"}, "r2": {"f1": "b"}},
            "row_order": ["r1", "r2"],
        }
        current = {
            "records": {"r1": {"f1": "a"}, "r2": {"f1": "b"}, "r3": {"f1": "c"}},
            "row_order": ["r1", "r2"],  # 前端漏同步，没有 r3
        }
        blob = adapter.compute_diff(base, current)
        assert blob is not None
        diff = _decompress(blob)

        assert "r3" in diff["added_records"]
        assert "row_order" in diff, "有新增行时 diff 必须携带 row_order"
        assert "r3" in diff["row_order"]
        assert diff["row_order"] == ["r1", "r2", "r3"]

    def test_added_records_already_in_curr_order(self, adapter):
        """新增行已在 curr_order 中时，不重复追加。"""
        base = {
            "records": {"r1": {"f1": "a"}},
            "row_order": ["r1"],
        }
        current = {
            "records": {"r1": {"f1": "a"}, "r2": {"f1": "b"}},
            "row_order": ["r1", "r2"],
        }
        blob = adapter.compute_diff(base, current)
        diff = _decompress(blob)
        assert diff["row_order"] == ["r1", "r2"]

    def test_multiple_added_records_missing_from_order(self, adapter):
        """多行新增均不在 curr_order 中时，全部追加且保持稳定顺序。"""
        base = {
            "records": {"r1": {"f1": "a"}},
            "row_order": ["r1"],
        }
        current = {
            "records": {
                "r1": {"f1": "a"},
                "r2": {"f1": "b"},
                "r3": {"f1": "c"},
            },
            "row_order": ["r1"],  # r2, r3 均缺失
        }
        blob = adapter.compute_diff(base, current)
        diff = _decompress(blob)
        assert "r2" in diff["row_order"]
        assert "r3" in diff["row_order"]
        assert diff["row_order"][:1] == ["r1"]


# ══════════════════════════════════════════════════════════
# DC-004: apply_diff 防御性处理历史 diff
# ══════════════════════════════════════════════════════════

class TestDC004ApplyDiffRowOrderDefense:
    """apply_diff 处理历史 diff（有 added_records 但无 row_order）时追加新行到 row_order。"""

    def test_legacy_diff_without_row_order_appends_added(self, adapter):
        """历史 diff 无 row_order 键时，added_records 中的行 ID 应追加到 base row_order。"""
        base = {
            "records": {"r1": {"f1": "a"}},
            "row_order": ["r1"],
            "total_records": 1,
        }
        legacy_diff = {
            "added_records": {"r2": {"f1": "b"}},
            "removed_records": [],
            "changed_records": {},
        }
        diff_blob = _compress(legacy_diff)
        result = adapter.apply_diff(base, diff_blob)

        assert "r2" in result["records"]
        assert "r2" in result["row_order"]
        assert result["row_order"] == ["r1", "r2"]

    def test_diff_with_row_order_no_double_append(self, adapter):
        """diff 已带 row_order 时，不重复追加已存在的行 ID。"""
        base = {
            "records": {"r1": {"f1": "a"}},
            "row_order": ["r1"],
            "total_records": 1,
        }
        diff_with_order = {
            "added_records": {"r2": {"f1": "b"}},
            "removed_records": [],
            "changed_records": {},
            "row_order": ["r1", "r2"],
        }
        diff_blob = _compress(diff_with_order)
        result = adapter.apply_diff(base, diff_blob)

        assert result["row_order"] == ["r1", "r2"]
        assert result["row_order"].count("r2") == 1


# ══════════════════════════════════════════════════════════
# DC-006: apply_diff deepcopy 防止多步回放共享引用
# ══════════════════════════════════════════════════════════

class TestDC006ApplyDiffDeepCopy:
    """apply_diff 使用 deepcopy，确保多步回放中前一步输出不被后续步骤篡改。"""

    def test_apply_diff_does_not_mutate_base_data(self, adapter):
        """apply_diff 不应修改传入的 base_data。"""
        base = {
            "records": {"r1": {"f1": "original"}},
            "row_order": ["r1"],
            "total_records": 1,
        }
        original_rdata = base["records"]["r1"]

        diff_data = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {"f1": "modified"}},
        }
        diff_blob = _compress(diff_data)
        result = adapter.apply_diff(base, diff_blob)

        assert result["records"]["r1"]["f1"] == "modified"
        assert base["records"]["r1"]["f1"] == "original"
        assert original_rdata["f1"] == "original"

    def test_multi_step_replay_no_shared_reference(self, adapter):
        """模拟 rebuild_data 多步回放，验证各步输出独立。"""
        base = {
            "records": {"r1": {"f1": "v0", "f2": "stable"}},
            "row_order": ["r1"],
            "total_records": 1,
        }

        diff1 = _compress({
            "added_records": {"r2": {"f1": "new"}},
            "removed_records": [],
            "changed_records": {},
            "row_order": ["r1", "r2"],
        })

        diff2 = _compress({
            "added_records": {},
            "removed_records": [],
            "changed_records": {"r1": {"f1": "v2", "f2": "changed"}},
        })

        step1 = adapter.apply_diff(base, diff1)
        step2 = adapter.apply_diff(step1, diff2)

        assert step1["records"]["r1"]["f1"] == "v0", "step1 的 r1 不应被 step2 修改"
        assert step1["records"]["r1"]["f2"] == "stable"
        assert step2["records"]["r1"]["f1"] == "v2"
        assert step2["records"]["r1"]["f2"] == "changed"

        assert base["records"]["r1"]["f1"] == "v0", "原始 base 不应被修改"

    def test_row_order_not_shared(self, adapter):
        """apply_diff 后 row_order 应为独立副本。"""
        base = {
            "records": {"r1": {"f1": "a"}},
            "row_order": ["r1"],
            "total_records": 1,
        }
        diff_data = {
            "added_records": {},
            "removed_records": [],
            "changed_records": {},
            "row_order": ["r1"],
        }
        diff_blob = _compress(diff_data)
        result = adapter.apply_diff(base, diff_blob)

        result["row_order"].append("r_extra")
        assert "r_extra" not in base["row_order"], "修改 result 不应影响 base"


# ══════════════════════════════════════════════════════════
# 往返对称性：compute_diff → apply_diff
# ══════════════════════════════════════════════════════════

class TestRoundTrip:
    """验证 compute_diff → apply_diff 往返对称。"""

    def test_added_records_roundtrip(self, adapter):
        """新增行的 compute→apply 往返应重建出与 current 一致的数据。"""
        base = {
            "records": {"r1": {"f1": "a"}},
            "row_order": ["r1"],
            "total_records": 1,
        }
        current = {
            "records": {"r1": {"f1": "a"}, "r2": {"f1": "b"}, "r3": {"f1": "c"}},
            "row_order": ["r1"],  # 前端漏同步
            "total_records": 3,
        }
        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        rebuilt = adapter.apply_diff(base, diff_blob)
        assert rebuilt["records"] == current["records"]
        assert set(rebuilt["row_order"]) == {"r1", "r2", "r3"}
        assert rebuilt["row_order"][:1] == ["r1"]

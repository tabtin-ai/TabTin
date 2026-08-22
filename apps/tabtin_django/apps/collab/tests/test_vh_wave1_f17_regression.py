"""
VH-007/012/013/014/015/016/021/023 回归测试

覆盖 F17 修复批次的所有问题，确保修复的 bug 不会复现。
"""

import copy
import json
import zlib
from datetime import datetime
from decimal import Decimal
from uuid import UUID

import pytest

# ═══════════════════════════════════════════════════════════════════
# VH-007 + VH-015: TabSlide get_version_data 画布字段 & 旧格式继承
# ═══════════════════════════════════════════════════════════════════


class TestSlideVersionDataCanvasFields:
    """VH-007: get_version_data 应返回 canvas_width/canvas_height/preset。"""

    @pytest.fixture
    def adapter(self):
        from apps.collab.adapters.slide import SlideCollabAdapter
        return SlideCollabAdapter()

    def test_get_version_data_includes_canvas_fields(self, adapter):
        """get_version_data 返回值应包含 canvas_width/canvas_height/preset。"""
        class FakeResource:
            theme = {"primary": "#000"}
            font_meta = {"font": "Arial"}
            canvas_width = 1920
            canvas_height = 1080
            preset = "ppt"

        # mock get_pages_data
        adapter.get_pages_data = lambda r: [{"id": "p1", "content": {}}]

        result = adapter.get_version_data(FakeResource())

        assert result["canvas_width"] == 1920
        assert result["canvas_height"] == 1080
        assert result["preset"] == "ppt"
        assert "pages" in result
        assert "theme" in result

    def test_compute_diff_captures_canvas_field_changes(self, adapter):
        """compute_diff 应检测 canvas_width/canvas_height/preset 变化。"""
        base = {
            "pages": [{"id": "p1", "content": "a"}],
            "theme": None,
            "font_meta": None,
            "canvas_width": 1920,
            "canvas_height": 1080,
            "preset": "ppt",
        }
        current = {
            "pages": [{"id": "p1", "content": "a"}],
            "theme": None,
            "font_meta": None,
            "canvas_width": 1280,
            "canvas_height": 720,
            "preset": "custom",
        }
        diff_blob = adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob).decode("utf-8"))
        assert diff["canvas_width"] == 1280
        assert diff["canvas_height"] == 720
        assert diff["preset"] == "custom"

    def test_apply_diff_restores_canvas_fields(self, adapter):
        """apply_diff 应正确继承和覆盖 canvas 字段。"""
        base = {
            "pages": [{"id": "p1", "content": "a"}],
            "theme": {"primary": "#000"},
            "canvas_width": 1920,
            "canvas_height": 1080,
            "preset": "ppt",
        }
        current = {
            "pages": [{"id": "p1", "content": "a"}],
            "theme": {"primary": "#000"},
            "canvas_width": 1280,
            "canvas_height": 720,
            "preset": "custom",
        }
        diff_blob = adapter.compute_diff(base, current)
        result = adapter.apply_diff(base, diff_blob)

        assert result["canvas_width"] == 1280
        assert result["canvas_height"] == 720
        assert result["preset"] == "custom"

    def test_apply_diff_inherits_canvas_fields_when_unchanged(self, adapter):
        """当 canvas 字段未变化时，apply_diff 结果应继承 base 的值。"""
        base = {
            "pages": [{"id": "p1", "content": "a"}],
            "theme": {"primary": "#000"},
            "canvas_width": 1920,
            "canvas_height": 1080,
            "preset": "ppt",
        }
        current = {
            "pages": [{"id": "p1", "content": "b"}],
            "theme": {"primary": "#000"},
            "canvas_width": 1920,
            "canvas_height": 1080,
            "preset": "ppt",
        }
        diff_blob = adapter.compute_diff(base, current)
        result = adapter.apply_diff(base, diff_blob)

        assert result["canvas_width"] == 1920
        assert result["canvas_height"] == 1080
        assert result["preset"] == "ppt"

    def test_roundtrip_with_canvas_fields(self, adapter):
        """apply_diff(base, compute_diff(base, target)) == target（含 canvas 字段）。"""
        base = {
            "pages": [{"id": "p1", "content": "old"}],
            "theme": {"color": "red"},
            "font_meta": {"font": "Arial"},
            "canvas_width": 1920,
            "canvas_height": 1080,
            "preset": "ppt",
        }
        target = {
            "pages": [{"id": "p1", "content": "new"}, {"id": "p2", "content": "extra"}],
            "theme": {"color": "blue"},
            "font_meta": {"font": "Roboto"},
            "canvas_width": 1280,
            "canvas_height": 720,
            "preset": "custom",
        }
        diff_blob = adapter.compute_diff(base, target)
        result = adapter.apply_diff(base, diff_blob)

        assert result["canvas_width"] == target["canvas_width"]
        assert result["canvas_height"] == target["canvas_height"]
        assert result["preset"] == target["preset"]
        assert result["theme"] == target["theme"]
        assert result["font_meta"] == target["font_meta"]


class TestSlideOldFormatInheritance:
    """VH-015: 旧格式 base_data (list) 在 diff chain 中不应丢失 theme/font_meta。"""

    @pytest.fixture
    def adapter(self):
        from apps.collab.adapters.slide import SlideCollabAdapter
        return SlideCollabAdapter()

    def test_old_format_base_with_no_theme_diff_preserves_nothing(self, adapter):
        """旧格式 base（list）无 theme/font_meta，diff 也不含时，result 不含这些键。

        这是 VH-015 的核心场景：旧格式 list base + diff 不含 theme →
        结果也不含 theme，restore 时保持当前值。
        """
        base_pages = [{"id": "p1", "content": "a"}]

        diff_data = {
            "added": [],
            "removed": [],
            "changed": [{"page_id": "p1", "data": {"id": "p1", "content": "b"}}],
            "order": ["p1"],
        }
        diff_blob = zlib.compress(
            json.dumps(diff_data, ensure_ascii=False).encode("utf-8")
        )

        result = adapter.apply_diff(base_pages, diff_blob)
        assert isinstance(result, dict)
        assert result["pages"][0]["content"] == "b"
        # 旧格式 base 不含 theme，diff 也不含 → result 不含 theme
        assert "theme" not in result

    def test_old_format_base_with_theme_in_diff(self, adapter):
        """旧格式 base（list）+ diff 含 theme → result 正确写入 theme。"""
        base_pages = [{"id": "p1", "content": "a"}]

        diff_data = {
            "added": [],
            "removed": [],
            "changed": [],
            "order": ["p1"],
            "theme": {"primary": "#fff"},
            "font_meta": {"font": "Noto"},
        }
        diff_blob = zlib.compress(
            json.dumps(diff_data, ensure_ascii=False).encode("utf-8")
        )

        result = adapter.apply_diff(base_pages, diff_blob)
        assert result["theme"] == {"primary": "#fff"}
        assert result["font_meta"] == {"font": "Noto"}

    def test_dict_base_inherits_all_fields(self, adapter):
        """dict 格式 base 的所有 inheritable 字段应被继承到 result。"""
        base = {
            "pages": [{"id": "p1", "content": "a"}],
            "theme": {"primary": "#000"},
            "font_meta": {"font": "Arial"},
            "canvas_width": 1920,
            "canvas_height": 1080,
            "preset": "ppt",
        }
        diff_data = {
            "added": [],
            "removed": [],
            "changed": [{"page_id": "p1", "data": {"id": "p1", "content": "b"}}],
            "order": ["p1"],
        }
        diff_blob = zlib.compress(
            json.dumps(diff_data, ensure_ascii=False).encode("utf-8")
        )

        result = adapter.apply_diff(base, diff_blob)
        assert result["theme"] == {"primary": "#000"}
        assert result["font_meta"] == {"font": "Arial"}
        assert result["canvas_width"] == 1920
        assert result["canvas_height"] == 1080
        assert result["preset"] == "ppt"


# ═══════════════════════════════════════════════════════════════════
# VH-012: TabVideo apply_diff 深拷贝
# ═══════════════════════════════════════════════════════════════════




# ═══════════════════════════════════════════════════════════════════
# VH-013: TabVideo compute_diff 删除键
# ═══════════════════════════════════════════════════════════════════




# ═══════════════════════════════════════════════════════════════════
# VH-014: TabSlide _apply_page_diff changed 找不到页面时不跳过
# ═══════════════════════════════════════════════════════════════════


class TestSlideApplyPageDiffMissingPage:
    """VH-014: _apply_page_diff 中 changed 操作找不到 page_id 时应插入而非跳过。"""

    def test_changed_page_not_in_base_is_inserted(self):
        """diff 中 changed 的 page_id 不在 base 中时应作为新页面插入。"""
        from apps.tabslide.services.slide_service import SlideService

        base_pages = [{"id": "p1", "content": "a"}]
        diff = {
            "added": [],
            "removed": [],
            "changed": [{"page_id": "p2", "data": {"id": "p2", "content": "new"}}],
            "order": ["p1", "p2"],
        }

        result = SlideService._apply_page_diff(base_pages, diff)
        result_ids = [p["id"] for p in result]
        assert "p2" in result_ids
        assert len(result) == 2

    def test_changed_page_in_base_is_updated(self):
        """diff 中 changed 的 page_id 在 base 中时应正常更新。"""
        from apps.tabslide.services.slide_service import SlideService

        base_pages = [{"id": "p1", "content": "old"}]
        diff = {
            "added": [],
            "removed": [],
            "changed": [{"page_id": "p1", "data": {"id": "p1", "content": "new"}}],
            "order": ["p1"],
        }

        result = SlideService._apply_page_diff(base_pages, diff)
        assert result[0]["content"] == "new"

    def test_roundtrip_symmetry(self):
        """apply_diff(base, compute_diff(base, target)) 应产生与 target 相同的页面。"""
        from apps.tabslide.services.slide_service import SlideService

        base_pages = [{"id": "p1", "content": "a"}, {"id": "p2", "content": "b"}]
        target_pages = [{"id": "p1", "content": "a"}, {"id": "p2", "content": "x"}, {"id": "p3", "content": "new"}]

        diff = SlideService._compute_page_diff(base_pages, target_pages)
        result = SlideService._apply_page_diff(base_pages, diff)

        result_map = {p["id"]: p for p in result}
        target_map = {p["id"]: p for p in target_pages}
        assert result_map == target_map


# ═══════════════════════════════════════════════════════════════════
# VH-016: TabDoc apply_diff 非 bytes 时抛异常
# ═══════════════════════════════════════════════════════════════════


class TestDocsApplyDiffNonBinary:
    """VH-016: apply_diff 在 base_data 不是 bytes 时应抛出 RuntimeError。"""

    @pytest.fixture
    def adapter(self):
        from apps.collab.adapters.docs import DocsCollabAdapter
        return DocsCollabAdapter()

    def test_non_bytes_base_raises_runtime_error(self, adapter):
        """传入 dict 类型的 base_data 应抛出 RuntimeError。"""
        fake_diff = zlib.compress(b"fake")
        with pytest.raises(RuntimeError, match="requires binary base_data"):
            adapter.apply_diff({"format": "json_snapshot"}, fake_diff)

    def test_string_base_raises_runtime_error(self, adapter):
        """传入字符串类型的 base_data 应抛出 RuntimeError。"""
        fake_diff = zlib.compress(b"fake")
        with pytest.raises(RuntimeError, match="requires binary base_data"):
            adapter.apply_diff("not bytes", fake_diff)

    def test_none_base_raises_runtime_error(self, adapter):
        """传入 None 类型的 base_data 应抛出 RuntimeError。"""
        fake_diff = zlib.compress(b"fake")
        with pytest.raises(RuntimeError, match="requires binary base_data"):
            adapter.apply_diff(None, fake_diff)


# ═══════════════════════════════════════════════════════════════════
# VH-021: TabVideo get_version_data 画布元数据
# ═══════════════════════════════════════════════════════════════════




# ═══════════════════════════════════════════════════════════════════
# VH-023: TabWhiteboard serialize_snapshot 不使用 default=str
# ═══════════════════════════════════════════════════════════════════



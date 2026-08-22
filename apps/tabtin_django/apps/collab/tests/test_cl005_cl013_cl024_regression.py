"""
CL-005 / CL-013 / CL-024 回归测试

CL-005: SlideCollabAdapter.get_version_data 补充 theme 和 font_meta；
        compute_diff / apply_diff 正确处理主题和字体元数据；
        restore 同步恢复 theme/font_meta 到 SlideProject。
CL-013: SlideService._apply_page_diff 对 changed 中不存在于 base_pages
        的 page_id 跳过并 warning，不再静默创建新页面。
CL-024: SlideCollabAdapter.apply_diff 加防御性 try/except，失败返回 None。
"""
import json
import logging
import os
import zlib
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.slide import SlideCollabAdapter  # noqa: E402
from apps.tabslide.services.slide_service import SlideService  # noqa: E402


# ══════════════════════════════════════════════════════════
# 工具
# ══════════════════════════════════════════════════════════

def _make_pages(*ids):
    return [{"id": pid, "elements": [{"type": "text", "content": f"page-{pid}"}]} for pid in ids]


def _make_version_data(pages, theme=None, font_meta=None):
    return {"pages": pages, "theme": theme, "font_meta": font_meta}


# ══════════════════════════════════════════════════════════
# CL-005: get_version_data 包含 theme / font_meta
# ══════════════════════════════════════════════════════════

class TestCL005GetVersionDataIncludesThemeAndFontMeta:
    """CL-005: get_version_data 必须返回 theme 和 font_meta。"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    @patch("apps.tabslide.services.slide_service.SlideService._read_pages_from_slide_pages")
    def test_returns_dict_with_theme_and_font_meta(self, mock_read):
        pages = _make_pages("p1", "p2")
        mock_read.return_value = pages
        resource = MagicMock()
        resource.theme = {"primary": "#ff0000", "fonts": {"heading": "Arial"}}
        resource.font_meta = {"embedded_fonts": ["CustomFont.ttf"]}

        result = self.adapter.get_version_data(resource)

        assert isinstance(result, dict)
        assert result["pages"] == pages
        assert result["theme"] == {"primary": "#ff0000", "fonts": {"heading": "Arial"}}
        assert result["font_meta"] == {"embedded_fonts": ["CustomFont.ttf"]}

    @patch("apps.tabslide.services.slide_service.SlideService._read_pages_from_slide_pages")
    def test_returns_none_theme_when_not_set(self, mock_read):
        mock_read.return_value = []
        resource = MagicMock()
        resource.theme = None
        resource.font_meta = None

        result = self.adapter.get_version_data(resource)

        assert result["theme"] is None
        assert result["font_meta"] is None


# ══════════════════════════════════════════════════════════
# CL-005: compute_diff 检测 theme / font_meta 变更
# ══════════════════════════════════════════════════════════

class TestCL005ComputeDiffThemeFontMeta:
    """CL-005: compute_diff 必须检测 theme 和 font_meta 的变更。"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    def test_theme_only_change_produces_diff(self):
        base = _make_version_data(_make_pages("p1"), theme={"color": "blue"})
        current = _make_version_data(_make_pages("p1"), theme={"color": "red"})

        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert diff["theme"] == {"color": "red"}
        assert not diff["added"]
        assert not diff["removed"]
        assert not diff["changed"]

    def test_font_meta_only_change_produces_diff(self):
        base = _make_version_data(_make_pages("p1"), font_meta={"embedded_fonts": []})
        current = _make_version_data(_make_pages("p1"), font_meta={"embedded_fonts": ["Font.ttf"]})

        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert diff["font_meta"] == {"embedded_fonts": ["Font.ttf"]}

    def test_no_change_returns_none(self):
        data = _make_version_data(_make_pages("p1"), theme={"x": 1}, font_meta={"y": 2})
        result = self.adapter.compute_diff(data, data)
        assert result is None

    def test_backward_compat_list_format(self):
        """旧格式（list）作为 base_data 时 compute_diff 仍然正常工作。"""
        base = _make_pages("p1")  # 旧格式: list
        current = _make_version_data(_make_pages("p1", "p2"), theme={"color": "blue"})

        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff = json.loads(zlib.decompress(diff_blob))
        assert len(diff["added"]) == 1
        assert diff["theme"] == {"color": "blue"}


# ══════════════════════════════════════════════════════════
# CL-005: apply_diff 传递 theme / font_meta
# ══════════════════════════════════════════════════════════

class TestCL005ApplyDiffThemeFontMeta:
    """CL-005: apply_diff 必须在结果中包含 theme/font_meta。"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    def test_apply_diff_preserves_base_theme(self):
        """diff 不含 theme 时，结果保留 base 的 theme。"""
        base = _make_version_data(_make_pages("p1"), theme={"color": "blue"})
        diff = {"added": [], "removed": [], "changed": [], "order": ["p1"]}
        diff_blob = zlib.compress(json.dumps(diff).encode())

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["theme"] == {"color": "blue"}

    def test_apply_diff_updates_theme_from_diff(self):
        """diff 含 theme 时，结果使用 diff 中的 theme。"""
        base = _make_version_data(_make_pages("p1"), theme={"color": "blue"})
        diff = {"added": [], "removed": [], "changed": [], "order": ["p1"],
                "theme": {"color": "red"}}
        diff_blob = zlib.compress(json.dumps(diff).encode())

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["theme"] == {"color": "red"}

    def test_apply_diff_updates_font_meta_from_diff(self):
        base = _make_version_data(_make_pages("p1"), font_meta=None)
        diff = {"added": [], "removed": [], "changed": [], "order": ["p1"],
                "font_meta": {"embedded_fonts": ["X.ttf"]}}
        diff_blob = zlib.compress(json.dumps(diff).encode())

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["font_meta"] == {"embedded_fonts": ["X.ttf"]}

    def test_apply_diff_backward_compat_list_base(self):
        """旧格式 list base → apply_diff 仍能工作，结果升级为 dict。"""
        base = _make_pages("p1")  # 旧格式
        diff = {"added": [{"page_id": "p2", "data": {"id": "p2"}}],
                "removed": [], "changed": [], "order": ["p1", "p2"]}
        diff_blob = zlib.compress(json.dumps(diff).encode())

        result = self.adapter.apply_diff(base, diff_blob)
        assert isinstance(result, dict)
        assert len(result["pages"]) == 2
        assert result.get("theme") is None
        assert result.get("font_meta") is None

    def test_roundtrip_compute_apply(self):
        """compute_diff → apply_diff 全链路往返验证。"""
        base = _make_version_data(
            _make_pages("p1", "p2"),
            theme={"color": "blue"},
            font_meta={"embedded_fonts": ["A.ttf"]},
        )
        current = _make_version_data(
            _make_pages("p1", "p3"),
            theme={"color": "green"},
            font_meta={"embedded_fonts": ["A.ttf", "B.ttf"]},
        )

        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        result = self.adapter.apply_diff(base, diff_blob)
        assert result["theme"] == {"color": "green"}
        assert result["font_meta"] == {"embedded_fonts": ["A.ttf", "B.ttf"]}
        result_page_ids = {p.get("id") for p in result["pages"]}
        assert "p1" in result_page_ids
        assert "p3" in result_page_ids
        assert "p2" not in result_page_ids


# ══════════════════════════════════════════════════════════
# CL-005: restore 传递 theme / font_meta
# ══════════════════════════════════════════════════════════

class TestCL005RestoreThemeFontMeta:
    """CL-005: restore 必须将 theme/font_meta 通过 extra_fields 传递。"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    @patch("apps.tabslide.services.slide_service.SlideService.restore_pages_from_snapshot")
    def test_restore_passes_theme_and_font_meta(self, mock_restore):
        resource = MagicMock()
        data = {
            "pages": _make_pages("p1"),
            "theme": {"color": "red"},
            "font_meta": {"embedded_fonts": ["X.ttf"]},
        }

        self.adapter.restore(resource, data)

        mock_restore.assert_called_once()
        _, kwargs = mock_restore.call_args
        assert kwargs["extra_fields"] == {"theme": {"color": "red"}, "font_meta": {"embedded_fonts": ["X.ttf"]}}

    @patch("apps.tabslide.services.slide_service.SlideService.restore_pages_from_snapshot")
    def test_restore_old_list_format_no_extra_fields(self, mock_restore):
        """旧格式 list 不传 extra_fields。"""
        resource = MagicMock()
        data = _make_pages("p1")

        self.adapter.restore(resource, data)

        mock_restore.assert_called_once()
        _, kwargs = mock_restore.call_args
        assert kwargs["extra_fields"] is None

    @patch("apps.tabslide.services.slide_service.SlideService.restore_pages_from_snapshot")
    def test_restore_with_none_theme_passes_none(self, mock_restore):
        """theme 为 None 也应显式传递（恢复到无主题状态）。"""
        resource = MagicMock()
        data = {"pages": _make_pages("p1"), "theme": None, "font_meta": None}

        self.adapter.restore(resource, data)

        _, kwargs = mock_restore.call_args
        assert kwargs["extra_fields"] == {"theme": None, "font_meta": None}


# ══════════════════════════════════════════════════════════
# CL-005: get_content_stats 兼容新旧格式
# ══════════════════════════════════════════════════════════

class TestCL005ContentStats:
    """CL-005: get_content_stats 兼容 dict 和 list 格式。"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    def test_dict_format(self):
        data = _make_version_data(_make_pages("p1", "p2"))
        assert self.adapter.get_content_stats(data) == {"page_count": 2}

    def test_list_format(self):
        data = _make_pages("p1", "p2", "p3")
        assert self.adapter.get_content_stats(data) == {"page_count": 3}

    def test_none_returns_zero(self):
        assert self.adapter.get_content_stats(None) == {"page_count": 0}


# ══════════════════════════════════════════════════════════
# CL-013: _apply_page_diff changed 存在性检查
# ══════════════════════════════════════════════════════════

class TestCL013ApplyPageDiffChangedExistenceCheck:
    """CL-013: changed 中的 page_id 不在 base_pages 时应跳过并 warning。"""

    @patch("apps.tabslide.services.slide_service.logger")
    def test_changed_nonexistent_page_is_skipped(self, mock_logger):
        base_pages = _make_pages("p1", "p2")
        diff = {
            "added": [],
            "removed": [],
            "changed": [{"page_id": "p999", "data": {"id": "p999", "content": "ghost"}}],
            "order": ["p1", "p2"],
        }

        result = SlideService._apply_page_diff(base_pages, diff)

        result_ids = {p.get("id") for p in result}
        assert "p1" in result_ids
        assert "p2" in result_ids
        mock_logger.warning.assert_called()
        warn_args = mock_logger.warning.call_args[0]
        assert "p999" in str(warn_args)

    def test_changed_existing_page_still_works(self):
        base_pages = _make_pages("p1", "p2")
        new_p1 = {"id": "p1", "elements": [{"type": "text", "content": "updated"}]}
        diff = {
            "added": [],
            "removed": [],
            "changed": [{"page_id": "p1", "data": new_p1}],
            "order": ["p1", "p2"],
        }

        result = SlideService._apply_page_diff(base_pages, diff)

        p1_result = next(p for p in result if p.get("id") == "p1")
        assert p1_result["elements"][0]["content"] == "updated"

    @patch("apps.tabslide.services.slide_service.logger")
    def test_mixed_valid_and_invalid_changed(self, mock_logger):
        """既有合法 changed 又有非法 changed 时，非法的会被作为新页面插入并 warning。"""
        base_pages = _make_pages("p1")
        diff = {
            "added": [],
            "removed": [],
            "changed": [
                {"page_id": "p1", "data": {"id": "p1", "elements": []}},
                {"page_id": "ghost", "data": {"id": "ghost", "elements": []}},
            ],
            "order": ["p1"],
        }

        result = SlideService._apply_page_diff(base_pages, diff)

        ordered = [p for p in result if p["id"] == "p1"]
        assert len(ordered) == 1
        assert ordered[0]["elements"] == []
        mock_logger.warning.assert_called()
        warn_args = mock_logger.warning.call_args[0]
        assert "ghost" in str(warn_args)


# ══════════════════════════════════════════════════════════
# CL-024: apply_diff 防御性 try/except
# ══════════════════════════════════════════════════════════

class TestCL024ApplyDiffDefensive:
    """CL-024: apply_diff 失败时返回 None 而非抛异常。"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    def test_corrupted_blob_returns_none(self):
        result = self.adapter.apply_diff(
            _make_version_data(_make_pages("p1")),
            b"not-valid-zlib",
        )
        assert result is None

    def test_truncated_blob_returns_none(self):
        valid = zlib.compress(json.dumps({"added": []}).encode())
        result = self.adapter.apply_diff(
            _make_version_data(_make_pages("p1")),
            valid[:len(valid) // 2],
        )
        assert result is None

    def test_valid_zlib_invalid_json_returns_none(self):
        blob = zlib.compress(b"not json {{{")
        result = self.adapter.apply_diff(
            _make_version_data(_make_pages("p1")),
            blob,
        )
        assert result is None

    def test_empty_blob_returns_none(self):
        result = self.adapter.apply_diff(
            _make_version_data(_make_pages("p1")),
            b"",
        )
        assert result is None

    @patch("apps.tabslide.services.slide_service.SlideService._apply_page_diff")
    def test_apply_page_diff_exception_returns_none(self, mock_apply):
        """_apply_page_diff 内部异常也应被捕获。"""
        mock_apply.side_effect = RuntimeError("unexpected error in page diff")
        diff = {"added": [], "removed": [], "changed": [], "order": []}
        blob = zlib.compress(json.dumps(diff).encode())

        result = self.adapter.apply_diff(
            _make_version_data(_make_pages("p1")),
            blob,
        )
        assert result is None

    def test_valid_diff_works_normally(self):
        """正常 diff 应正确应用。"""
        base = _make_version_data(_make_pages("p1"), theme={"color": "blue"})
        diff = {
            "added": [{"page_id": "p2", "data": {"id": "p2", "elements": []}}],
            "removed": [],
            "changed": [],
            "order": ["p1", "p2"],
        }
        blob = zlib.compress(json.dumps(diff).encode())

        result = self.adapter.apply_diff(base, blob)
        assert result is not None
        assert len(result["pages"]) == 2
        assert result["theme"] == {"color": "blue"}

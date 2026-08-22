"""
V2 P1 Wave2-11 修复回归测试

- T-03:  SlidePreset 前后端枚举映射（normalize_preset）
- A2-06: get_pages_outline / model_row_to_* 背景格式规范化
- A2-08: SavePagesRequest.pages 结构校验（id 必填）
- A3-#3: SlideProject 复合索引 (organization_id, space_id, status)
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase

from pydantic import ValidationError

from apps.tabslide.field_mapping import (
    model_row_to_frontend_page,
    model_row_to_full_frontend_page,
    normalize_background_for_api,
)
from apps.tabslide.models import SlideProject
from apps.tabslide.schemas import SavePagesRequest


# ============================================================================
# T-03: SlideProject.normalize_preset
# ============================================================================


class NormalizePresetTests(TestCase):
    """SlideProject.normalize_preset 将前端 '16:9' 规范化为后端 'ppt'。"""

    def test_16_9_to_ppt(self):
        self.assertEqual(SlideProject.normalize_preset("16:9"), "ppt")

    def test_ppt_passthrough(self):
        self.assertEqual(SlideProject.normalize_preset("ppt"), "ppt")

    def test_4_3_passthrough(self):
        self.assertEqual(SlideProject.normalize_preset("4:3"), "4:3")

    def test_xiaohongshu_passthrough(self):
        self.assertEqual(SlideProject.normalize_preset("xiaohongshu"), "xiaohongshu")

    def test_poster_passthrough(self):
        self.assertEqual(SlideProject.normalize_preset("poster"), "poster")

    def test_custom_passthrough(self):
        self.assertEqual(SlideProject.normalize_preset("custom"), "custom")

    def test_unknown_defaults_to_ppt(self):
        self.assertEqual(SlideProject.normalize_preset("bogus"), "ppt")

    def test_empty_string_defaults_to_ppt(self):
        self.assertEqual(SlideProject.normalize_preset(""), "ppt")

    def test_roundtrip_all_presets(self):
        """所有后端 preset 值规范化后不变（幂等性）。"""
        for be_value in ("ppt", "4:3", "xiaohongshu", "poster", "custom"):
            self.assertEqual(
                SlideProject.normalize_preset(be_value), be_value,
                f"normalize_preset('{be_value}') 应返回自身"
            )


# ============================================================================
# A2-06: normalize_background_for_api
# ============================================================================


class NormalizeBackgroundForApiTests(TestCase):
    """normalize_background_for_api 将 DB 存储的后端背景格式转为前端兼容格式。"""

    def test_none_returns_none(self):
        self.assertIsNone(normalize_background_for_api(None))

    def test_empty_dict_returns_empty_dict(self):
        self.assertEqual(normalize_background_for_api({}), {})

    def test_color_without_theme_becomes_solid(self):
        bg = {"type": "color", "value": "#ff0000"}
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "solid")
        self.assertEqual(result["color"], "#ff0000")
        self.assertNotIn("value", result)

    def test_color_with_theme_becomes_theme(self):
        bg = {
            "type": "color",
            "value": "#4472c4",
            "theme": {"key": "accent1", "color": "#4472c4"},
        }
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "theme")
        self.assertEqual(result["color"], "#4472c4")
        self.assertIn("theme", result)
        self.assertEqual(result["theme"]["key"], "accent1")

    def test_color_with_empty_theme_becomes_solid(self):
        bg = {"type": "color", "value": "#123456", "theme": {}}
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "solid")
        self.assertEqual(result["color"], "#123456")

    def test_theme_type_with_valid_theme(self):
        bg = {
            "type": "theme",
            "theme": {"key": "bg1", "color": "#ffffff"},
        }
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "theme")
        self.assertEqual(result["color"], "#ffffff")

    def test_theme_type_without_valid_theme_falls_to_solid(self):
        bg = {"type": "theme", "value": "#aabbcc"}
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "solid")
        self.assertEqual(result["color"], "#aabbcc")

    def test_gradient_passthrough(self):
        bg = {
            "type": "gradient",
            "gradient": {"type": "linear", "rotate": 90, "colors": []},
        }
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "gradient")
        self.assertIn("gradient", result)

    def test_image_passthrough(self):
        bg = {"type": "image", "image": {"src": "https://example.com/bg.jpg"}}
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "image")

    def test_inherited_flag_preserved(self):
        bg = {"type": "color", "value": "#000", "inherited": True}
        result = normalize_background_for_api(bg)
        self.assertTrue(result.get("inherited"))

    def test_solid_type_without_theme_remains_solid(self):
        bg = {"type": "solid", "value": "#abcdef"}
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "solid")

    def test_missing_value_defaults_to_white(self):
        bg = {"type": "color"}
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "solid")
        self.assertEqual(result["color"], "#ffffff")

    def test_non_dict_returns_as_is(self):
        self.assertEqual(normalize_background_for_api("not_a_dict"), "not_a_dict")

    def test_theme_color_fallback_chain(self):
        """theme.color > value > '#ffffff' 的优先级。"""
        bg = {
            "type": "color",
            "value": "#111111",
            "theme": {"key": "accent2", "color": "#222222"},
        }
        result = normalize_background_for_api(bg)
        self.assertEqual(result["color"], "#222222")

    def test_color_with_theme_transforms_preserved(self):
        bg = {
            "type": "color",
            "value": "#5b9bd5",
            "theme": {
                "key": "accent1",
                "color": "#5b9bd5",
                "transforms": {"lumMod": 0.6, "lumOff": 0.4},
            },
        }
        result = normalize_background_for_api(bg)
        self.assertEqual(result["type"], "theme")
        self.assertIn("transforms", result["theme"])


# ============================================================================
# A2-06: model_row_to_frontend_page / model_row_to_full_frontend_page
#         背景经 normalize_background_for_api 转换
# ============================================================================


def _fake_slide_page(**overrides):
    """构造轻量 SlidePage 替身，避免依赖 DB。"""
    defaults = dict(
        page_id="pg-1",
        elements_data=[{"id": "e1", "type": "text"}],
        html_source="",
        content_format="json",
        background=None,
        master_elements=None,
        layout_ref=None,
        remark="",
        animations=None,
        turning_mode="",
        section_tag=None,
        slide_type="",
        slide_notes=None,
        version=1,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class ModelRowToFrontendPageBackgroundTests(TestCase):
    """A2-06: model_row_to_frontend_page 返回值的 background 已经过规范化。"""

    def test_color_background_normalized_to_solid(self):
        row = _fake_slide_page(background={"type": "color", "value": "#ff0000"})
        result = model_row_to_frontend_page(row)
        self.assertEqual(result["background"]["type"], "solid")
        self.assertEqual(result["background"]["color"], "#ff0000")

    def test_none_background_omitted(self):
        row = _fake_slide_page(background=None)
        result = model_row_to_frontend_page(row)
        self.assertNotIn("background", result)

    def test_gradient_passthrough(self):
        bg = {"type": "gradient", "gradient": {"type": "linear"}}
        row = _fake_slide_page(background=bg)
        result = model_row_to_frontend_page(row)
        self.assertEqual(result["background"]["type"], "gradient")

    def test_theme_background_with_key(self):
        bg = {
            "type": "color",
            "value": "#4472c4",
            "theme": {"key": "accent1", "color": "#4472c4"},
        }
        row = _fake_slide_page(background=bg)
        result = model_row_to_frontend_page(row)
        self.assertEqual(result["background"]["type"], "theme")


class ModelRowToFullFrontendPageBackgroundTests(TestCase):
    """A2-06: model_row_to_full_frontend_page 的 background 也经过规范化。"""

    def test_color_background_normalized_to_solid(self):
        row = _fake_slide_page(background={"type": "color", "value": "#abcdef"})
        result = model_row_to_full_frontend_page(row)
        self.assertEqual(result["background"]["type"], "solid")
        self.assertEqual(result["background"]["color"], "#abcdef")

    def test_none_background_stays_none(self):
        row = _fake_slide_page(background=None)
        result = model_row_to_full_frontend_page(row)
        self.assertIsNone(result["background"])


# ============================================================================
# A2-08: SavePagesRequest.pages 结构校验
# ============================================================================


class SavePagesRequestValidationTests(TestCase):
    """A2-08: SavePagesRequest 要求每个 page 包含有效字符串 id。"""

    def test_valid_pages_accepted(self):
        req = SavePagesRequest(pages=[{"id": "pg-1"}, {"id": "pg-2"}])
        self.assertEqual(len(req.pages), 2)

    def test_missing_id_raises(self):
        with self.assertRaises(ValidationError) as ctx:
            SavePagesRequest(pages=[{"elements": []}])
        self.assertIn("pages[0]", str(ctx.exception))

    def test_empty_string_id_raises(self):
        with self.assertRaises(ValidationError):
            SavePagesRequest(pages=[{"id": ""}])

    def test_non_string_id_raises(self):
        with self.assertRaises(ValidationError):
            SavePagesRequest(pages=[{"id": 123}])

    def test_mixed_valid_and_invalid(self):
        with self.assertRaises(ValidationError) as ctx:
            SavePagesRequest(pages=[{"id": "ok"}, {"elements": []}, {"id": "ok2"}])
        self.assertIn("pages[1]", str(ctx.exception))

    def test_empty_pages_list_accepted(self):
        req = SavePagesRequest(pages=[])
        self.assertEqual(len(req.pages), 0)

    def test_multiple_invalid_reported(self):
        with self.assertRaises(ValidationError) as ctx:
            SavePagesRequest(pages=[{}, {"id": "ok"}, {"id": 42}])
        err_str = str(ctx.exception)
        self.assertIn("0", err_str)
        self.assertIn("2", err_str)


# ============================================================================
# A3-#3: SlideProject Meta 复合索引
# ============================================================================


class SlideProjectIndexTests(TestCase):
    """A3-#3: SlideProject.Meta.indexes 包含 (organization_id, space_id, status) 复合索引。"""

    def test_composite_index_exists(self):
        index_field_sets = [
            tuple(idx.fields) for idx in SlideProject._meta.indexes
        ]
        self.assertIn(
            ("organization_id", "space_id", "status"),
            index_field_sets,
            "缺少 (organization_id, space_id, status) 复合索引",
        )

"""
V2 数据基座 P0 回归测试 — A2-01 ~ A2-05

验证 section_tag / slide_type / slide_notes 三个字段在写入和读取链路均正确映射。
"""

from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock


# ══════════════════════════════════════════════════════════════════════════
# A2-01/02/03: SlidePage 模型新增字段验证
# ══════════════════════════════════════════════════════════════════════════

class TestSlidePageModelNewFields(TestCase):
    """验证 SlidePage 模型包含 section_tag / slide_type / slide_notes 字段。"""

    def test_section_tag_field_exists(self):
        from apps.tabslide.models import SlidePage

        field = SlidePage._meta.get_field("section_tag")
        self.assertTrue(field.null)
        self.assertTrue(field.blank)
        self.assertIsNone(field.default)

    def test_slide_type_field_exists(self):
        from apps.tabslide.models import SlidePage

        field = SlidePage._meta.get_field("slide_type")
        self.assertEqual(field.max_length, 32)
        self.assertTrue(field.blank)
        self.assertEqual(field.default, "")

    def test_slide_notes_field_exists(self):
        from apps.tabslide.models import SlidePage

        field = SlidePage._meta.get_field("slide_notes")
        self.assertTrue(field.null)
        self.assertTrue(field.blank)
        self.assertIsNone(field.default)


# ══════════════════════════════════════════════════════════════════════════
# A2-01/02/03 + A2-04: field_mapping 写入方向
# ══════════════════════════════════════════════════════════════════════════

class TestFieldMappingWriteDirection(TestCase):
    """验证前端数据通过 field_mapping 正确转换为模型字段。"""

    def test_fe_to_model_contains_three_new_mappings(self):
        from apps.tabslide.field_mapping import _FE_TO_MODEL

        self.assertEqual(_FE_TO_MODEL["sectionTag"], "section_tag")
        self.assertEqual(_FE_TO_MODEL["slideType"], "slide_type")
        self.assertEqual(_FE_TO_MODEL["slideNotes"], "slide_notes")

    def test_frontend_page_to_defaults_maps_camelCase(self):
        from apps.tabslide.field_mapping import frontend_page_to_defaults

        page_data = {
            "sectionTag": {"id": "s1", "title": "第一章"},
            "slideType": "cover",
            "slideNotes": [{"id": "n1", "content": "批注"}],
        }
        defaults = frontend_page_to_defaults(page_data)

        self.assertEqual(defaults["section_tag"], {"id": "s1", "title": "第一章"})
        self.assertEqual(defaults["slide_type"], "cover")
        self.assertEqual(defaults["slide_notes"], [{"id": "n1", "content": "批注"}])

    def test_frontend_page_to_defaults_maps_snake_case_via_alias(self):
        """前端 backend-adapter 以 snake_case 发送，通过别名正确映射。"""
        from apps.tabslide.field_mapping import frontend_page_to_defaults

        page_data = {
            "section_tag": {"id": "s2", "title": "第二章"},
            "slide_type": "contents",
            "slide_notes": [{"id": "n2", "content": "另一条批注", "elId": "el_1"}],
        }
        defaults = frontend_page_to_defaults(page_data)

        self.assertEqual(defaults["section_tag"], {"id": "s2", "title": "第二章"})
        self.assertEqual(defaults["slide_type"], "contents")
        self.assertEqual(defaults["slide_notes"], [{"id": "n2", "content": "另一条批注", "elId": "el_1"}])

    def test_frontend_page_to_full_defaults_includes_new_fields(self):
        from apps.tabslide.field_mapping import frontend_page_to_full_defaults

        page_data = {
            "elements": [],
            "sectionTag": {"id": "s1", "title": "章节"},
            "slideType": "end",
            "slideNotes": [{"id": "n1", "content": "完"}],
        }
        full = frontend_page_to_full_defaults(page_data)

        self.assertEqual(full["section_tag"], {"id": "s1", "title": "章节"})
        self.assertEqual(full["slide_type"], "end")
        self.assertEqual(full["slide_notes"], [{"id": "n1", "content": "完"}])

    def test_frontend_page_to_full_defaults_new_fields_default(self):
        """缺失三字段时填充默认值。"""
        from apps.tabslide.field_mapping import frontend_page_to_full_defaults

        full = frontend_page_to_full_defaults({"elements": []})

        self.assertIsNone(full["section_tag"])
        self.assertEqual(full["slide_type"], "")
        self.assertIsNone(full["slide_notes"])

    def test_model_content_update_fields_includes_new_fields(self):
        """bulk_create update_fields 列表包含新字段。"""
        from apps.tabslide.field_mapping import MODEL_CONTENT_UPDATE_FIELDS

        self.assertIn("section_tag", MODEL_CONTENT_UPDATE_FIELDS)
        self.assertIn("slide_type", MODEL_CONTENT_UPDATE_FIELDS)
        self.assertIn("slide_notes", MODEL_CONTENT_UPDATE_FIELDS)


# ══════════════════════════════════════════════════════════════════════════
# A2-04: field_mapping 读取方向
# ══════════════════════════════════════════════════════════════════════════

class TestFieldMappingReadDirection(TestCase):
    """验证 model_row_to_frontend_page / model_row_to_full_frontend_page 返回三字段。"""

    @staticmethod
    def _make_mock_row(**overrides):
        row = MagicMock()
        row.page_id = "page-1"
        row.elements_data = [{"type": "text"}]
        row.content_format = "json"
        row.background = None
        row.master_elements = None
        row.layout_ref = None
        row.remark = ""
        row.animations = None
        row.turning_mode = ""
        row.html_source = ""
        row.section_tag = None
        row.slide_type = ""
        row.slide_notes = None
        for k, v in overrides.items():
            setattr(row, k, v)
        return row

    def test_model_row_to_frontend_page_returns_section_tag(self):
        from apps.tabslide.field_mapping import model_row_to_frontend_page

        row = self._make_mock_row(section_tag={"id": "s1", "title": "章节A"})
        page = model_row_to_frontend_page(row)

        self.assertEqual(page["sectionTag"], {"id": "s1", "title": "章节A"})

    def test_model_row_to_frontend_page_returns_slide_type(self):
        from apps.tabslide.field_mapping import model_row_to_frontend_page

        row = self._make_mock_row(slide_type="cover")
        page = model_row_to_frontend_page(row)

        self.assertEqual(page["slideType"], "cover")

    def test_model_row_to_frontend_page_returns_slide_notes(self):
        from apps.tabslide.field_mapping import model_row_to_frontend_page

        notes = [{"id": "n1", "content": "测试批注"}]
        row = self._make_mock_row(slide_notes=notes)
        page = model_row_to_frontend_page(row)

        self.assertEqual(page["slideNotes"], notes)

    def test_model_row_to_frontend_page_omits_empty_fields(self):
        """空值时不包含三字段（与其他可选字段一致的稀疏策略）。"""
        from apps.tabslide.field_mapping import model_row_to_frontend_page

        row = self._make_mock_row()
        page = model_row_to_frontend_page(row)

        self.assertNotIn("sectionTag", page)
        self.assertNotIn("slideType", page)
        self.assertNotIn("slideNotes", page)

    def test_model_row_to_full_frontend_page_always_includes_three_fields(self):
        from apps.tabslide.field_mapping import model_row_to_full_frontend_page

        row = self._make_mock_row(
            section_tag={"id": "s1", "title": "T"},
            slide_type="transition",
            slide_notes=[{"id": "n1", "content": "x"}],
        )
        page = model_row_to_full_frontend_page(row)

        self.assertEqual(page["sectionTag"], {"id": "s1", "title": "T"})
        self.assertEqual(page["slideType"], "transition")
        self.assertEqual(page["slideNotes"], [{"id": "n1", "content": "x"}])

    def test_model_row_to_full_frontend_page_defaults(self):
        from apps.tabslide.field_mapping import model_row_to_full_frontend_page

        row = self._make_mock_row()
        page = model_row_to_full_frontend_page(row)

        self.assertIsNone(page["sectionTag"])
        self.assertEqual(page["slideType"], "")
        self.assertIsNone(page["slideNotes"])


# ══════════════════════════════════════════════════════════════════════════
# 端到端往返一致性
# ══════════════════════════════════════════════════════════════════════════

class TestRoundTripConsistency(TestCase):
    """验证写入 → 读取往返中三字段数据不丢失。"""

    def test_full_roundtrip(self):
        """模拟 frontend_page_to_full_defaults → 写入模型 → model_row_to_frontend_page 往返。"""
        from apps.tabslide.field_mapping import (
            frontend_page_to_full_defaults,
            model_row_to_frontend_page,
        )

        input_page = {
            "elements": [{"type": "text", "content": "hello"}],
            "section_tag": {"id": "sec-01", "title": "引言"},
            "slide_type": "cover",
            "slide_notes": [
                {"id": "n1", "content": "重要批注"},
                {"id": "n2", "content": "补充说明", "elId": "el_img_01"},
            ],
        }

        defaults = frontend_page_to_full_defaults(input_page)

        row = MagicMock()
        row.page_id = "page-rt"
        row.content_format = "json"
        row.html_source = ""
        for k, v in defaults.items():
            setattr(row, k, v)

        output = model_row_to_frontend_page(row)

        self.assertEqual(output["sectionTag"], {"id": "sec-01", "title": "引言"})
        self.assertEqual(output["slideType"], "cover")
        self.assertEqual(len(output["slideNotes"]), 2)
        self.assertEqual(output["slideNotes"][0]["id"], "n1")
        self.assertEqual(output["slideNotes"][1]["elId"], "el_img_01")

"""
A2-04 / A2-05 回归测试 — 三字段读取链路完整性

A2-04: model_row_to_frontend_page / model_row_to_full_frontend_page
       必须以 snake_case 返回 section_tag / slide_type / slide_notes，
       匹配前端 BackendSlidePage 接口。

A2-05: get_pages_outline 轻量端点同样须返回三字段（snake_case）。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase

from apps.tabslide.field_mapping import (
    _FE_TO_MODEL,
    _ALIASES_TO_FE,
    MODEL_CONTENT_UPDATE_FIELDS,
    frontend_page_to_defaults,
    frontend_page_to_full_defaults,
    model_row_to_frontend_page,
    model_row_to_full_frontend_page,
)


def _make_fake_row(**overrides):
    """构造一个鸭子类型的 SlidePage 行对象，用于纯内存测试。"""
    defaults = dict(
        page_id="page-test-01",
        elements_data=[{"type": "text", "id": "el1"}],
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
        order=0.0,
        version=1,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# ══════════════════════════════════════════════════════════════════════════
# 模型字段存在性
# ══════════════════════════════════════════════════════════════════════════

class TestSlidePageModelFields(TestCase):
    """验证 SlidePage 模型包含三个新字段。"""

    def test_section_tag_field_exists(self):
        from apps.tabslide.models import SlidePage
        field = SlidePage._meta.get_field("section_tag")
        self.assertTrue(field.null)
        self.assertTrue(field.blank)

    def test_slide_type_field_exists(self):
        from apps.tabslide.models import SlidePage
        field = SlidePage._meta.get_field("slide_type")
        self.assertEqual(field.max_length, 32)
        self.assertEqual(field.default, "")

    def test_slide_notes_field_exists(self):
        from apps.tabslide.models import SlidePage
        field = SlidePage._meta.get_field("slide_notes")
        self.assertTrue(field.null)
        self.assertTrue(field.blank)


# ══════════════════════════════════════════════════════════════════════════
# 映射表完整性
# ══════════════════════════════════════════════════════════════════════════

class TestMappingTableCompleteness(TestCase):
    """验证 _FE_TO_MODEL 和 _ALIASES_TO_FE 包含三字段映射。"""

    def test_fe_to_model_has_section_tag(self):
        self.assertEqual(_FE_TO_MODEL["sectionTag"], "section_tag")

    def test_fe_to_model_has_slide_type(self):
        self.assertEqual(_FE_TO_MODEL["slideType"], "slide_type")

    def test_fe_to_model_has_slide_notes(self):
        self.assertEqual(_FE_TO_MODEL["slideNotes"], "slide_notes")

    def test_aliases_section_tag(self):
        self.assertEqual(_ALIASES_TO_FE["section_tag"], "sectionTag")

    def test_aliases_slide_type(self):
        self.assertEqual(_ALIASES_TO_FE["slide_type"], "slideType")

    def test_aliases_slide_notes(self):
        self.assertEqual(_ALIASES_TO_FE["slide_notes"], "slideNotes")

    def test_model_content_update_fields_includes_new(self):
        self.assertIn("section_tag", MODEL_CONTENT_UPDATE_FIELDS)
        self.assertIn("slide_type", MODEL_CONTENT_UPDATE_FIELDS)
        self.assertIn("slide_notes", MODEL_CONTENT_UPDATE_FIELDS)


# ══════════════════════════════════════════════════════════════════════════
# A2-04: 读取方向 — model_row → 前端 dict
# ══════════════════════════════════════════════════════════════════════════

class TestModelRowToFrontendPage(TestCase):
    """A2-04: model_row_to_frontend_page 返回 snake_case 键。"""

    def test_section_tag_returned_as_snake_case(self):
        row = _make_fake_row(section_tag={"id": "sec-1", "title": "引言"})
        result = model_row_to_frontend_page(row)
        self.assertEqual(result["section_tag"], {"id": "sec-1", "title": "引言"})
        self.assertNotIn("sectionTag", result)

    def test_slide_type_returned_as_snake_case(self):
        row = _make_fake_row(slide_type="cover")
        result = model_row_to_frontend_page(row)
        self.assertEqual(result["slide_type"], "cover")
        self.assertNotIn("slideType", result)

    def test_slide_notes_returned_as_snake_case(self):
        notes = [{"id": "n1", "content": "批注内容"}]
        row = _make_fake_row(slide_notes=notes)
        result = model_row_to_frontend_page(row)
        self.assertEqual(result["slide_notes"], notes)
        self.assertNotIn("slideNotes", result)

    def test_empty_fields_omitted(self):
        row = _make_fake_row()
        result = model_row_to_frontend_page(row)
        self.assertNotIn("section_tag", result)
        self.assertNotIn("slide_type", result)
        self.assertNotIn("slide_notes", result)

    def test_slide_type_empty_string_omitted(self):
        row = _make_fake_row(slide_type="")
        result = model_row_to_frontend_page(row)
        self.assertNotIn("slide_type", result)


class TestModelRowToFullFrontendPage(TestCase):
    """A2-04: model_row_to_full_frontend_page 总是包含三字段（snake_case）。"""

    def test_all_three_fields_present(self):
        row = _make_fake_row(
            section_tag={"id": "sec-2", "title": "正文"},
            slide_type="content",
            slide_notes=[{"id": "n1", "content": "ok"}],
        )
        result = model_row_to_full_frontend_page(row)
        self.assertEqual(result["section_tag"], {"id": "sec-2", "title": "正文"})
        self.assertEqual(result["slide_type"], "content")
        self.assertEqual(result["slide_notes"], [{"id": "n1", "content": "ok"}])

    def test_null_defaults(self):
        row = _make_fake_row()
        result = model_row_to_full_frontend_page(row)
        self.assertIsNone(result["section_tag"])
        self.assertEqual(result["slide_type"], "")
        self.assertIsNone(result["slide_notes"])

    def test_no_camel_case_keys(self):
        row = _make_fake_row(section_tag={"id": "s", "title": "T"})
        result = model_row_to_full_frontend_page(row)
        self.assertNotIn("sectionTag", result)
        self.assertNotIn("slideType", result)
        self.assertNotIn("slideNotes", result)


# ══════════════════════════════════════════════════════════════════════════
# 写入方向 — 前端 dict → 模型 defaults
# ══════════════════════════════════════════════════════════════════════════

class TestWritePath(TestCase):
    """验证写入方向映射（前置修复，A2-01/02/03 配套）。"""

    def test_full_defaults_camelCase_input(self):
        page = {
            "elements": [],
            "sectionTag": {"id": "sec-a", "title": "A"},
            "slideType": "cover",
            "slideNotes": [{"id": "n1", "content": "x"}],
        }
        defaults = frontend_page_to_full_defaults(page)
        self.assertEqual(defaults["section_tag"], {"id": "sec-a", "title": "A"})
        self.assertEqual(defaults["slide_type"], "cover")
        self.assertEqual(defaults["slide_notes"], [{"id": "n1", "content": "x"}])

    def test_full_defaults_snake_case_via_alias(self):
        """backend-adapter 发送 snake_case，通过别名转换。"""
        page = {
            "elements": [],
            "section_tag": {"id": "sec-b", "title": "B"},
            "slide_type": "end",
            "slide_notes": [{"id": "n2", "content": "y"}],
        }
        defaults = frontend_page_to_full_defaults(page)
        self.assertEqual(defaults["section_tag"], {"id": "sec-b", "title": "B"})
        self.assertEqual(defaults["slide_type"], "end")
        self.assertEqual(defaults["slide_notes"], [{"id": "n2", "content": "y"}])

    def test_incremental_defaults_snake_case(self):
        page = {"slide_type": "transition"}
        defaults = frontend_page_to_defaults(page)
        self.assertEqual(defaults["slide_type"], "transition")

    def test_missing_fields_get_defaults(self):
        defaults = frontend_page_to_full_defaults({"elements": []})
        self.assertIsNone(defaults["section_tag"])
        self.assertEqual(defaults["slide_type"], "")
        self.assertIsNone(defaults["slide_notes"])


# ══════════════════════════════════════════════════════════════════════════
# 读写往返
# ══════════════════════════════════════════════════════════════════════════

class TestRoundTrip(TestCase):
    """验证 write → read 往返不丢失数据。"""

    def test_full_roundtrip_with_all_three_fields(self):
        input_page = {
            "id": "page-rt-1",
            "elements": [{"type": "shape", "id": "s1"}],
            "sectionTag": {"id": "sec-rt", "title": "往返章节"},
            "slideType": "contents",
            "slideNotes": [
                {"id": "note-1", "content": "第一条批注"},
                {"id": "note-2", "content": "第二条", "elId": "s1"},
            ],
            "remark": "演讲者备注",
        }
        defaults = frontend_page_to_full_defaults(input_page)
        row = _make_fake_row(page_id="page-rt-1", **defaults)
        output = model_row_to_frontend_page(row)

        self.assertEqual(output["section_tag"], {"id": "sec-rt", "title": "往返章节"})
        self.assertEqual(output["slide_type"], "contents")
        self.assertEqual(len(output["slide_notes"]), 2)
        self.assertEqual(output["slide_notes"][0]["content"], "第一条批注")
        self.assertEqual(output["remark"], "演讲者备注")

    def test_roundtrip_empty_fields(self):
        input_page = {"id": "page-rt-2", "elements": []}
        defaults = frontend_page_to_full_defaults(input_page)
        row = _make_fake_row(page_id="page-rt-2", **defaults)
        output = model_row_to_frontend_page(row)

        self.assertNotIn("section_tag", output)
        self.assertNotIn("slide_type", output)
        self.assertNotIn("slide_notes", output)

"""Phase-2 Wave-3 修复回归：dom_extractor._postprocess_slide_elements 保留 element 自身 bbox.

Bug 1（已修）：之前 text_layout 携带的 containerX / containerWidth 会强制把 element 的 x / width
覆盖成"最近块级祖先的几何"，在 grid / flex 嵌套场景下祖先经常是覆盖整个 slide 内容区的主容器，
导致一行小标题被强制撑成全宽块级，丢失原始 getBoundingClientRect 几何。

Bug 2（保护性）：_EXTRACT_BG_JS 在 Tailwind 编译完成后应返回 {type: 'solid', value: '#xxx'}，
normalize 后应该是 {type: 'solid', color: '#xxx'}，绝不能在 .ppt-slide 有显式 bg-[...] 类时
fallback 到 #FFFFFF。
"""
from __future__ import annotations

from unittest import TestCase

from apps.tabslide.field_mapping import normalize_background_for_api
from apps.tabslide.services.dom_extractor import _postprocess_slide_elements


def _text_el(*, id_: str, x: int, y: int, w: int, h: int, content: str = "<p>txt</p>") -> dict:
    return {
        "id": id_,
        "type": "text",
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "content": content,
        "rotate": 0,
        "opacity": 1,
        "locked": False,
        "visible": True,
        "defaultFontSize": 12,
        "defaultColor": "#000000",
    }


class PostprocessPreservesTextBboxTests(TestCase):
    """Phase-2 Wave-3 Bug 1：postprocess 不应该用 layout.containerX/Width 替换 element bbox。"""

    def test_center_text_keeps_own_bbox_not_container(self):
        """对 textAlign=center 的元素，保留元素自身 bbox，不替换为最近块级祖先几何。"""
        el = _text_el(id_="h1", x=620, y=361, w=680, h=108)
        layout = [{
            "x": 620, "y": 361, "width": 680, "height": 108,
            "textAlign": "center",
            "containerX": 60, "containerWidth": 1800,
            "fontSize": 72, "fontWeight": "bold",
            "color": "#E8E8E8", "fontFamily": "Inter",
            "runs": [{"text": "人工智能简介", "bold": True, "italic": False,
                      "underline": False, "color": "#E8E8E8", "fontSize": 72}],
        }]
        out = _postprocess_slide_elements([el], canvas_w=1920, text_layout_data=layout)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["x"], 620, "x 不应被替换为 container_x")
        self.assertEqual(out[0]["width"], 680, "width 不应被替换为 container_width")
        self.assertEqual(out[0]["y"], 361)
        self.assertEqual(out[0]["height"], 108)
        # defaultTextAlign 标记仍要存在（要么 element 自带，要么 postprocess 兜底）
        self.assertEqual(out[0].get("defaultTextAlign"), "center")

    def test_left_text_no_width_expansion(self):
        """对 textAlign=left 的元素，width 也不应根据 available_w 扩展为 w*1.5。"""
        el = _text_el(id_="h2", x=90, y=60, w=593, h=60)
        layout = [{
            "x": 90, "y": 60, "width": 593, "height": 60,
            "textAlign": "left",
            "containerX": 60, "containerWidth": 1800,
            "fontSize": 48, "fontWeight": "bold",
            "color": "#E8E8E8", "fontFamily": "Inter",
            "runs": [{"text": "人工智能：从概念到现实", "bold": True}],
        }]
        out = _postprocess_slide_elements([el], canvas_w=1920, text_layout_data=layout)
        self.assertEqual(out[0]["x"], 90)
        self.assertEqual(out[0]["width"], 593, "left 时 width 不应扩展为 w*1.5")

    def test_walker_text_in_flex_centered_keeps_bbox(self):
        """walker 来源的 element（自带 defaultTextAlign='center'）也要保留 bbox。"""
        el = _text_el(id_="span1", x=852, y=740, w=216, h=30)
        el["defaultTextAlign"] = "center"
        layout = [{
            "x": 852, "y": 740, "width": 216, "height": 30,
            "textAlign": "center",
            "containerX": 756, "containerWidth": 408,
            "fontSize": 14, "fontWeight": "normal",
            "color": "#8E9A9D", "fontFamily": "Inter",
            "runs": [{"text": "INTRODUCTION TO AI"}],
        }]
        out = _postprocess_slide_elements([el], canvas_w=1920, text_layout_data=layout)
        self.assertEqual(out[0]["x"], 852)
        self.assertEqual(out[0]["width"], 216)
        self.assertEqual(out[0]["defaultTextAlign"], "center")

    def test_postprocess_still_enriches_text(self):
        """postprocess 仍要触发 _enrich_text_element_from_layout（bold runs 等）。"""
        el = _text_el(id_="p1", x=100, y=200, w=500, h=40)
        layout = [{
            "x": 100, "y": 200, "width": 500, "height": 40,
            "textAlign": "left",
            "containerX": 60, "containerWidth": 800,
            "fontSize": 16, "fontWeight": "700",
            "color": "#000000", "fontFamily": "Inter",
            "runs": [
                {"text": "Bold prefix ", "bold": True, "italic": False,
                 "underline": False, "color": "#000000", "fontSize": 16},
                {"text": "normal text", "bold": False, "italic": False,
                 "underline": False, "color": "#000000", "fontSize": 16},
            ],
        }]
        out = _postprocess_slide_elements([el], canvas_w=1920, text_layout_data=layout)
        self.assertEqual(out[0].get("defaultFontWeight"), "bold")

    def test_postprocess_no_layout_keeps_bbox(self):
        """没有 layout 时不动 bbox。"""
        el = _text_el(id_="lonely", x=10, y=20, w=30, h=40)
        out = _postprocess_slide_elements([el], canvas_w=1920, text_layout_data=None)
        self.assertEqual(out[0]["x"], 10)
        self.assertEqual(out[0]["y"], 20)
        self.assertEqual(out[0]["width"], 30)
        self.assertEqual(out[0]["height"], 40)


class BackgroundNormalizationTests(TestCase):
    """Phase-2 Wave-3 Bug 2 保护：_EXTRACT_BG_JS → DB → normalize 链路 #1A1D24 不丢失。"""

    def test_dom_extract_bg_solid_normalizes_to_color_key(self):
        """dom_extractor 输出 {type:solid, value:'#1A1D24'} → normalize 后是 {type:solid, color:'#1A1D24'}."""
        raw = {"type": "solid", "value": "#1A1D24"}
        result = normalize_background_for_api(raw)
        self.assertEqual(result, {"type": "solid", "color": "#1A1D24"})

    def test_dom_extract_bg_solid_fallback_white_normalizes(self):
        """如果 dom_extractor 真的 fallback 到 #FFFFFF，normalize 也保留。"""
        raw = {"type": "solid", "value": "#FFFFFF"}
        result = normalize_background_for_api(raw)
        self.assertEqual(result, {"type": "solid", "color": "#FFFFFF"})

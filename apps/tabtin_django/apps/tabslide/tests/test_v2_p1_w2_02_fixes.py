"""
V2 P1 Wave2-02 修复回归测试

- I5-25: _build_data_ts JSON 单引号属性 → 双引号 + _html_attr 转义
- I5-20: text defaultFontSize _safe_float 校验
- I5-30: text lineHeight / wordSpace _safe_float 校验
- I5-31: text paragraphSpace _safe_float 校验
- I5-21: table cell fontSize _safe_float / align / verticalAlign 白名单
- I5-24: table colspan / rowspan int 校验
- I5-14: shape viewBox _safe_float 校验
- I5-15: shape stroke-linecap / stroke-linejoin 白名单
"""

from __future__ import annotations

import importlib
import importlib.util
import inspect
import re
import sys
import types
from pathlib import Path
from unittest import TestCase

_BASE = Path(__file__).resolve().parents[1]
_PREVIEW_SRC = (_BASE / "services" / "preview_service.py").read_text(encoding="utf-8")


def _load_preview():
    """Load preview_service as a standalone module (no Django dependency)."""
    path = _BASE / "services" / "preview_service.py"
    spec = importlib.util.spec_from_file_location("test_preview_svc", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["test_preview_svc"] = mod
    spec.loader.exec_module(mod)
    return mod


_preview = _load_preview()


# ============================================================================
# I5-25: _build_data_ts JSON 属性转义
# ============================================================================


class BuildDataTsEscapeTests(TestCase):
    """_build_data_ts 输出必须使用双引号包裹、JSON 内容经 _html_attr 转义。"""

    def test_no_single_quote_wrapping(self):
        """源码中不应出现 attr='..json.dumps..' 形式的单引号属性。"""
        fn_src = inspect.getsource(_preview._build_data_ts)
        self.assertNotIn("='\\'{", fn_src, "仍存在单引号包裹 JSON 属性")
        self.assertNotIn("=\\'{", fn_src)

    def test_uses_html_attr_for_json(self):
        """JSON 值必须通过 _html_attr 转义后插入双引号属性。"""
        fn_src = inspect.getsource(_preview._build_data_ts)
        self.assertIn("_html_attr(json.dumps(", fn_src)

    def test_colormask_with_special_chars(self):
        """colorMask 含 < > & " ' 时输出安全。"""
        el = {"colorMask": {"overlay": "red", "note": "test'\"<>&"}}
        result = _preview._build_data_ts(el)
        self.assertNotIn("'", result.split("=", 1)[-1].strip('"'))
        self.assertNotIn("<", result.split("=", 1)[-1].strip('"').replace("&lt;", ""))

    def test_output_uses_double_quotes(self):
        """输出属性值使用双引号。"""
        el = {"colorMask": {"type": "solid", "color": "#ff0000"}}
        result = _preview._build_data_ts(el)
        self.assertTrue(
            'data-ts-color-mask="' in result,
            f"属性未使用双引号: {result}",
        )

    def test_points_escaped(self):
        """points 含 JSON 时同样使用 _html_attr + 双引号。"""
        el = {"points": [["arrow", "dot"]]}
        result = _preview._build_data_ts(el)
        if "data-ts-points" in result:
            self.assertIn('data-ts-points="', result)

    def test_line_control_escaped(self):
        """broken line control 使用 _html_attr + 双引号。"""
        el = {"broken": [[10, 20], [30, 40]]}
        result = _preview._build_data_ts(el)
        if "data-ts-line-control" in result:
            self.assertIn('data-ts-line-control="', result)


# ============================================================================
# I5-20: text defaultFontSize _safe_float
# ============================================================================


class TextFontSizeSafeFloatTests(TestCase):
    """_render_text_element 中 defaultFontSize 必须经 _safe_float 校验。"""

    def test_source_uses_safe_float_for_font_size(self):
        fn_src = inspect.getsource(_preview._render_text_element)
        self.assertIn("_safe_float(font_size", fn_src)

    def test_normal_font_size_renders(self):
        el = {"type": "text", "content": "hello", "defaultFontSize": 24}
        html = _preview._render_text_element(el, "", "")
        self.assertIn("font-size: 24.0pt", html)

    def test_malicious_font_size_rejected(self):
        el = {"type": "text", "content": "hello", "defaultFontSize": "16pt; background: url(evil)"}
        html = _preview._render_text_element(el, "", "")
        self.assertNotIn("url(evil)", html)
        self.assertIn("font-size: 16.0pt", html)

    def test_non_numeric_font_size_fallback(self):
        el = {"type": "text", "content": "hello", "defaultFontSize": "abc"}
        html = _preview._render_text_element(el, "", "")
        self.assertIn("font-size: 16.0pt", html)


# ============================================================================
# I5-30: text lineHeight / wordSpace _safe_float
# ============================================================================


class TextLineHeightWordSpaceTests(TestCase):
    """lineHeight 和 wordSpace 必须经 _safe_float 校验。"""

    def test_source_uses_safe_float_for_line_height(self):
        fn_src = inspect.getsource(_preview._render_text_element)
        self.assertRegex(fn_src, r'_safe_float\(lh')

    def test_source_uses_safe_float_for_word_space(self):
        fn_src = inspect.getsource(_preview._render_text_element)
        self.assertRegex(fn_src, r'_safe_float\(ws')

    def test_normal_line_height(self):
        el = {"type": "text", "content": "hi", "lineHeight": 1.8}
        html = _preview._render_text_element(el, "", "")
        self.assertIn("line-height: 1.8", html)

    def test_malicious_line_height_rejected(self):
        el = {"type": "text", "content": "hi", "lineHeight": "2; background: red"}
        html = _preview._render_text_element(el, "", "")
        self.assertNotIn("background: red", html)

    def test_normal_word_space(self):
        el = {"type": "text", "content": "hi", "wordSpace": 3}
        html = _preview._render_text_element(el, "", "")
        self.assertIn("letter-spacing: 3.0px", html)

    def test_malicious_word_space_rejected(self):
        el = {"type": "text", "content": "hi", "wordSpace": "5px; color: red"}
        html = _preview._render_text_element(el, "", "")
        self.assertNotIn("color: red", html)


# ============================================================================
# I5-31: text paragraphSpace _safe_float
# ============================================================================


class TextParagraphSpaceTests(TestCase):
    """paragraphSpace 必须经 _safe_float 校验。"""

    def test_source_uses_safe_float_for_paragraph_space(self):
        fn_src = inspect.getsource(_preview._render_text_element)
        self.assertRegex(fn_src, r'_safe_float\(ps')

    def test_normal_paragraph_space(self):
        el = {"type": "text", "content": "hi", "paragraphSpace": 12}
        html = _preview._render_text_element(el, "", "")
        self.assertIn("--ts-para-space: 12.0px", html)

    def test_malicious_paragraph_space_rejected(self):
        el = {"type": "text", "content": "hi", "paragraphSpace": "10px; } .evil { color: red"}
        html = _preview._render_text_element(el, "", "")
        self.assertNotIn(".evil", html)
        self.assertIn("--ts-para-space: 0.0px", html)


# ============================================================================
# I5-21: table cell fontSize / align / verticalAlign
# ============================================================================


class TableCellValidationTests(TestCase):
    """table cell 的 fontSize/align/verticalAlign 必须经校验。"""

    def _render_table(self, cell_style: dict) -> str:
        el = {
            "type": "table",
            "data": [[{"text": "Header", "style": cell_style}]],
        }
        return _preview._render_table_element(el, "", "")

    def test_source_uses_safe_float_for_cell_font_size(self):
        fn_src = inspect.getsource(_preview._render_table_element)
        self.assertIn("_safe_float(cs['fontSize']", fn_src)

    def test_normal_cell_font_size(self):
        html = self._render_table({"fontSize": 18})
        self.assertIn("font-size: 18.0pt", html)

    def test_malicious_cell_font_size_rejected(self):
        html = self._render_table({"fontSize": "14pt; background: url(evil)"})
        self.assertNotIn("url(evil)", html)

    def test_valid_align_accepted(self):
        html = self._render_table({"align": "center"})
        self.assertIn("text-align: center", html)

    def test_malicious_align_rejected(self):
        html = self._render_table({"align": "center; background: url(evil)"})
        self.assertNotIn("text-align:", html)
        self.assertNotIn("url(evil)", html)

    def test_valid_vertical_align_accepted(self):
        html = self._render_table({"verticalAlign": "middle"})
        self.assertIn("vertical-align: middle", html)

    def test_malicious_vertical_align_rejected(self):
        html = self._render_table({"verticalAlign": "top; color: red"})
        self.assertNotIn("vertical-align:", html)
        self.assertNotIn("color: red", html)

    def test_source_uses_whitelist_for_align(self):
        fn_src = inspect.getsource(_preview._render_table_element)
        self.assertIn("_TEXT_ALIGN_VALUES", fn_src)

    def test_source_uses_whitelist_for_vertical_align(self):
        fn_src = inspect.getsource(_preview._render_table_element)
        self.assertIn("_VERTICAL_ALIGN_VALUES", fn_src)


# ============================================================================
# I5-24: table colspan / rowspan int 校验
# ============================================================================


class TableSpanIntValidationTests(TestCase):
    """colspan/rowspan 必须转为 int，拒绝注入。"""

    def _render_table(self, cell: dict) -> str:
        el = {
            "type": "table",
            "data": [[cell]],
        }
        return _preview._render_table_element(el, "", "")

    def test_normal_colspan(self):
        html = self._render_table({"text": "X", "colspan": 3})
        self.assertIn('colspan="3"', html)

    def test_normal_rowspan(self):
        html = self._render_table({"text": "X", "rowspan": 2})
        self.assertIn('rowspan="2"', html)

    def test_string_colspan_rejected(self):
        html = self._render_table({"text": "X", "colspan": '3" onclick="alert(1)'})
        self.assertNotIn("onclick", html)

    def test_non_numeric_colspan_fallback(self):
        html = self._render_table({"text": "X", "colspan": "abc"})
        self.assertNotIn("colspan", html)

    def test_float_colspan_truncated(self):
        html = self._render_table({"text": "X", "colspan": 2.9})
        self.assertIn('colspan="2"', html)

    def test_source_uses_int_conversion(self):
        fn_src = inspect.getsource(_preview._render_table_element)
        self.assertIn("int(cell.get(\"colspan\"", fn_src)
        self.assertIn("int(cell.get(\"rowspan\"", fn_src)


# ============================================================================
# I5-14: shape viewBox _safe_float
# ============================================================================


class ShapeViewBoxSafeFloatTests(TestCase):
    """shape SVG viewBox 值必须经 _safe_float 校验。"""

    def test_source_uses_safe_float_for_viewbox(self):
        fn_src = inspect.getsource(_preview._render_shape_element)
        self.assertIn("_safe_float(view_box[0]", fn_src)
        self.assertIn("_safe_float(view_box[1]", fn_src)

    def test_normal_viewbox(self):
        el = {
            "type": "shape",
            "path": "M0 0L100 100",
            "viewBox": [200, 150],
        }
        html = _preview._render_shape_element(el, "", "")
        self.assertIn('viewBox="0 0 200.0 150.0"', html)

    def test_malicious_viewbox_rejected(self):
        el = {
            "type": "shape",
            "path": "M0 0L100 100",
            "viewBox": ['200" onload="alert(1)', 150],
        }
        html = _preview._render_shape_element(el, "", "")
        self.assertNotIn("onload", html)
        self.assertIn("viewBox=", html)


# ============================================================================
# I5-15: shape stroke-linecap / stroke-linejoin 白名单
# ============================================================================


class ShapeStrokeCapJoinWhitelistTests(TestCase):
    """shape outline 的 lineCap/lineJoin 必须经白名单校验。"""

    def test_source_uses_line_cap_whitelist(self):
        fn_src = inspect.getsource(_preview._render_shape_element)
        self.assertIn("_LINE_CAP_VALUES", fn_src)

    def test_source_uses_line_join_whitelist(self):
        fn_src = inspect.getsource(_preview._render_shape_element)
        self.assertIn("_LINE_JOIN_VALUES", fn_src)

    def test_valid_linecap_accepted(self):
        el = {
            "type": "shape",
            "path": "M0 0L100 0",
            "viewBox": [100, 10],
            "outline": {"width": 2, "color": "#333", "lineCap": "round"},
        }
        html = _preview._render_shape_element(el, "", "")
        self.assertIn('stroke-linecap="round"', html)

    def test_malicious_linecap_rejected(self):
        el = {
            "type": "shape",
            "path": "M0 0L100 0",
            "viewBox": [100, 10],
            "outline": {"width": 2, "color": "#333", "lineCap": 'round" onload="alert(1)'},
        }
        html = _preview._render_shape_element(el, "", "")
        self.assertNotIn("onload", html)
        self.assertNotIn("alert", html)

    def test_valid_linejoin_accepted(self):
        el = {
            "type": "shape",
            "path": "M0 0L50 50L100 0",
            "viewBox": [100, 50],
            "outline": {"width": 2, "color": "#333", "lineJoin": "bevel"},
        }
        html = _preview._render_shape_element(el, "", "")
        self.assertIn('stroke-linejoin="bevel"', html)

    def test_malicious_linejoin_rejected(self):
        el = {
            "type": "shape",
            "path": "M0 0L50 50L100 0",
            "viewBox": [100, 50],
            "outline": {"width": 2, "color": "#333", "lineJoin": 'miter" style="evil'},
        }
        html = _preview._render_shape_element(el, "", "")
        self.assertNotIn("evil", html)

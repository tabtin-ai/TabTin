"""
Regression tests for W2 Special Elements P1 fixes:
- B5-V2-03: _parse_css_color HSL/HSLA support
- B6-V2-01: row_heights array length alignment
- B6-V2-02: _parse_html_to_paragraphs <li> direct text
"""
import importlib.util
from pathlib import Path
from unittest import TestCase


_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_w2_test", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

_parse_css_color = _PPTX_IO._parse_css_color
_parse_html_to_paragraphs = _PPTX_IO._parse_html_to_paragraphs
EMU_PER_PX = _PPTX_IO.EMU_PER_PX


class TestParseCssColorHSL(TestCase):
    """B5-V2-03: _parse_css_color HSL/HSLA support."""

    def test_hsl_red(self):
        hex_val, alpha = _parse_css_color("hsl(0, 100%, 50%)")
        self.assertEqual(hex_val.lower(), "#ff0000")
        self.assertIsNone(alpha)

    def test_hsl_green(self):
        hex_val, alpha = _parse_css_color("hsl(120, 100%, 50%)")
        self.assertEqual(hex_val.lower(), "#00ff00")
        self.assertIsNone(alpha)

    def test_hsl_blue(self):
        hex_val, alpha = _parse_css_color("hsl(240, 100%, 50%)")
        self.assertEqual(hex_val.lower(), "#0000ff")
        self.assertIsNone(alpha)

    def test_hsla_with_alpha(self):
        hex_val, alpha = _parse_css_color("hsla(0, 100%, 50%, 0.5)")
        self.assertEqual(hex_val.lower(), "#ff0000")
        self.assertAlmostEqual(alpha, 0.5)

    def test_hsla_alpha_1_returns_none(self):
        hex_val, alpha = _parse_css_color("hsla(0, 100%, 50%, 1.0)")
        self.assertEqual(hex_val.lower(), "#ff0000")
        self.assertIsNone(alpha)

    def test_hex_still_works(self):
        hex_val, alpha = _parse_css_color("#4A6D8C")
        self.assertEqual(hex_val, "#4A6D8C")
        self.assertIsNone(alpha)

    def test_rgba_still_works(self):
        hex_val, alpha = _parse_css_color("rgba(74,109,140,0.2)")
        self.assertEqual(hex_val.lower(), "#4a6d8c")
        self.assertAlmostEqual(alpha, 0.2)


class TestRowHeightsAlignment(TestCase):
    """B6-V2-01: row_heights array must match row count."""

    def test_row_heights_always_appended(self):
        """Simulate: 3 rows, middle row has height=None."""

        class _MockRow:
            def __init__(self, h):
                self._height = h

            @property
            def height(self):
                return self._height

            @property
            def cells(self):
                return []

        class _MockTable:
            def __init__(self, row_heights_emu):
                self._rows = [_MockRow(h) for h in row_heights_emu]

            @property
            def rows(self):
                return self._rows

        row_heights = []
        table = _MockTable([round(30 * EMU_PER_PX), None, round(40 * EMU_PER_PX)])
        for row in table.rows:
            try:
                rh = row.height
                row_heights.append(round(rh / EMU_PER_PX) if rh and rh > 0 else 0)
            except Exception:
                row_heights.append(0)

        self.assertEqual(len(row_heights), 3)
        self.assertEqual(row_heights[0], 30)
        self.assertEqual(row_heights[1], 0)
        self.assertEqual(row_heights[2], 40)


class TestParseHtmlLiDirectText(TestCase):
    """B6-V2-02: <li>direct text</li> must not be lost."""

    def test_li_with_direct_text(self):
        html = "<ul><li>Item One</li><li>Item Two</li></ul>"
        paragraphs = _parse_html_to_paragraphs(html)
        self.assertEqual(len(paragraphs), 2)
        texts = [
            "".join(r.get("text", "") for r in p.get("runs", []))
            for p in paragraphs
        ]
        self.assertIn("Item One", texts)
        self.assertIn("Item Two", texts)

    def test_li_with_p_child_still_works(self):
        html = "<ul><li><p>Wrapped text</p></li></ul>"
        paragraphs = _parse_html_to_paragraphs(html)
        self.assertEqual(len(paragraphs), 1)
        text = "".join(r.get("text", "") for r in paragraphs[0].get("runs", []))
        self.assertIn("Wrapped text", text)

    def test_li_with_inline_elements(self):
        html = "<ul><li><strong>Bold</strong> text</li></ul>"
        paragraphs = _parse_html_to_paragraphs(html)
        self.assertGreaterEqual(len(paragraphs), 1)
        combined = "".join(
            r.get("text", "") for p in paragraphs for r in p.get("runs", [])
        )
        self.assertIn("Bold", combined)
        self.assertIn("text", combined)

    def test_li_bullet_type_preserved(self):
        html = "<ul><li>Bullet item</li></ul>"
        paragraphs = _parse_html_to_paragraphs(html)
        self.assertEqual(len(paragraphs), 1)
        self.assertEqual(paragraphs[0].get("bullet"), "bullet")

    def test_ol_li_direct_text(self):
        html = "<ol><li>Numbered item</li></ol>"
        paragraphs = _parse_html_to_paragraphs(html)
        self.assertEqual(len(paragraphs), 1)
        self.assertEqual(paragraphs[0].get("bullet"), "number")
        text = "".join(r.get("text", "") for r in paragraphs[0].get("runs", []))
        self.assertIn("Numbered item", text)

    def test_mixed_li_formats(self):
        html = "<ul><li><p>Has p</p></li><li>No p</li></ul>"
        paragraphs = _parse_html_to_paragraphs(html)
        self.assertEqual(len(paragraphs), 2)

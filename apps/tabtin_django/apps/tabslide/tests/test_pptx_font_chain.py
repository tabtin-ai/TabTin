import importlib.util
from pathlib import Path
from unittest import TestCase

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_font_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

_strip_font_fallback = _PPTX_IO._strip_font_fallback
_resolve_theme_font_reference = _PPTX_IO._resolve_theme_font_reference
_font_with_fallback = _PPTX_IO._font_with_fallback


class TestPptxFontChain(TestCase):
    def test_strip_font_fallback_supports_quotes_and_functions(self):
        self.assertEqual(_strip_font_fallback('"Segoe UI", Arial, sans-serif'), "Segoe UI")
        self.assertEqual(_strip_font_fallback("'A, B', Arial, sans-serif"), "A, B")
        self.assertIsNone(_strip_font_fallback("var(--tabslide-minor-font, 'Microsoft YaHei', sans-serif)"))
        self.assertIsNone(_strip_font_fallback("inherit"))

    def test_resolve_theme_font_reference_is_case_insensitive(self):
        theme_fonts = {
            "major_latin": "Calibri Light",
            "major_ea": "等线 Light",
            "minor_latin": "Calibri",
            "minor_ea": "等线",
        }
        self.assertEqual(_resolve_theme_font_reference(" +MJ-EA ", theme_fonts), "等线 Light")
        self.assertEqual(_resolve_theme_font_reference("+mn-lt", theme_fonts), "Calibri")
        self.assertEqual(_resolve_theme_font_reference("Calibri", theme_fonts), "Calibri")

    def test_font_with_fallback_uses_primary_font_and_escapes_quotes(self):
        self.assertEqual(
            _font_with_fallback("Calibri, 'Segoe UI', Arial, sans-serif"),
            "Calibri, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
        )
        self.assertIsNone(_font_with_fallback("serif"))

        escaped = _font_with_fallback("D'Nealian, serif")
        self.assertIsNotNone(escaped)
        assert escaped is not None
        self.assertIn("'D\\'Nealian'", escaped)
        self.assertIn("'Microsoft YaHei'", escaped)

"""
Tests for P0 security fixes in preview_service.py (wave1 batch F02).

Covers:
  I5-02: _render_latex_element SVG sanitization
  I5-03: _render_chart_element </script> injection
  I5-04: _build_background_css color validation
  I5-05: Background image URL single-quote escape
  I5-06: Background imageSize whitelist
"""

import importlib.util
import sys
from pathlib import Path
from unittest import TestCase

_PREVIEW_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "preview_service.py"
_SPEC = importlib.util.spec_from_file_location(
    "tabslide_preview_service_p0_f02_test", _PREVIEW_MODULE_PATH
)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_PREVIEW_MODULE_PATH}")

_mod = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _mod
_SPEC.loader.exec_module(_mod)

_build_background_css = _mod._build_background_css
_render_chart_element = _mod._render_chart_element
_render_latex_element = _mod._render_latex_element
_sanitize_svg = _mod._sanitize_svg
build_slide_html = _mod.build_slide_html


# ── I5-02: _sanitize_svg & _render_latex_element ──────────────────────

class TestSanitizeSvg(TestCase):
    def test_strips_script_tags(self):
        svg = '<svg><script>alert(1)</script><circle r="10"/></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("<script", result)
        self.assertNotIn("alert(1)", result)
        self.assertIn('<circle r="10"/>', result)

    def test_strips_script_tags_case_insensitive(self):
        svg = '<svg><SCRIPT>alert(1)</SCRIPT></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("alert(1)", result)

    def test_strips_event_handlers_double_quoted(self):
        svg = '<svg><rect onmouseover="alert(1)" width="10"/></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("onmouseover", result)

    def test_strips_event_handlers_single_quoted(self):
        svg = "<svg><rect onclick='alert(1)' width='10'/></svg>"
        result = _sanitize_svg(svg)
        self.assertNotIn("onclick", result)

    def test_strips_javascript_uri_in_href(self):
        svg = '<svg><a href="javascript:alert(1)"><text>X</text></a></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("javascript:", result)

    def test_strips_javascript_uri_in_xlink_href(self):
        svg = '<svg><a xlink:href="javascript:alert(1)"><text>X</text></a></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("javascript:", result)

    def test_strips_data_uri_in_href(self):
        svg = '<svg><a href="data:text/html,<script>alert(1)</script>"><text>X</text></a></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("data:text/html", result)

    def test_strips_foreignObject(self):
        svg = '<svg><foreignObject><body><script>alert(1)</script></body></foreignObject><circle r="5"/></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("foreignObject", result)
        self.assertIn('<circle r="5"/>', result)

    def test_preserves_safe_svg(self):
        svg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"/></svg>'
        result = _sanitize_svg(svg)
        self.assertEqual(result, svg)

    def test_strips_self_closing_script(self):
        svg = '<svg><script src="//evil.com/x.js"/><circle r="5"/></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("<script", result)
        self.assertIn('<circle r="5"/>', result)

    def test_strips_null_bytes(self):
        svg = '<svg><scr\x00ipt>alert(1)</scr\x00ipt></svg>'
        result = _sanitize_svg(svg)
        self.assertNotIn("\x00", result)

    def test_non_string_returns_empty(self):
        self.assertEqual(_sanitize_svg(None), "")
        self.assertEqual(_sanitize_svg(123), "")


class TestRenderLatexElementSanitization(TestCase):
    def _make_el(self, **kwargs):
        base = {"type": "latex", "id": "el1", "left": 0, "top": 0, "width": 200, "height": 100}
        base.update(kwargs)
        return base

    def test_svg_script_stripped(self):
        el = self._make_el(
            latex="x^2",
            svg='<svg><script>alert("xss")</script><text>x²</text></svg>',
        )
        html = _render_latex_element(el, "left:0;top:0;", "")
        self.assertNotIn("<script", html)
        self.assertNotIn("alert", html)
        self.assertIn("<text>x²</text>", html)

    def test_svg_event_handler_stripped(self):
        el = self._make_el(
            latex="y",
            svg='<svg onload="alert(1)"><text>y</text></svg>',
        )
        html = _render_latex_element(el, "left:0;top:0;", "")
        self.assertNotIn("onload", html)

    def test_latex_color_malicious_blocked(self):
        """Malicious color value must not inject CSS or HTML attributes."""
        el = self._make_el(latex="z", color='" onclick="alert(1)')
        html = _render_latex_element(el, "left:0;", "")
        self.assertNotIn('onclick="alert', html)
        self.assertNotIn('color:" onclick', html)

    def test_latex_color_safe_value_passes(self):
        el = self._make_el(latex="z", color="#ff0000")
        html = _render_latex_element(el, "left:0;", "")
        self.assertIn("color:#ff0000", html)


# ── I5-03: _render_chart_element </script> injection ──────────────────

class TestRenderChartScriptEscape(TestCase):
    def _make_chart_el(self, chart_data=None, **kwargs):
        base = {
            "type": "chart",
            "id": "chart1",
            "left": 0, "top": 0, "width": 400, "height": 300,
            "chartType": "bar",
            "data": chart_data or {"labels": ["A"], "series": [{"data": [1]}]},
        }
        base.update(kwargs)
        return base

    def test_script_close_tag_escaped(self):
        malicious_data = {
            "labels": ["</script><img src=x onerror=alert(1)>"],
            "series": [{"data": [1]}],
        }
        el = self._make_chart_el(chart_data=malicious_data)
        html = _render_chart_element(el, "left:0;", "")
        self.assertNotIn("</script><img", html)

    def test_escaped_form_present(self):
        malicious_data = {
            "labels": ["</script>"],
            "series": [{"data": [1]}],
        }
        el = self._make_chart_el(chart_data=malicious_data)
        html = _render_chart_element(el, "left:0;", "")
        self.assertIn("<\\/script>", html)

    def test_normal_chart_renders(self):
        el = self._make_chart_el()
        html = _render_chart_element(el, "left:0;", "")
        self.assertIn("echarts.init", html)
        self.assertIn("setOption", html)


# ── I5-04: _build_background_css color validation ─────────────────────

class TestBuildBackgroundCssColorValidation(TestCase):
    def test_solid_safe_hex_color(self):
        css = _build_background_css({"type": "solid", "color": "#ff0000"})
        self.assertIn("#ff0000", css)

    def test_solid_malicious_color_blocked(self):
        css = _build_background_css({"type": "solid", "color": "red; } body { display:none } .x {"})
        self.assertNotIn("display:none", css)
        self.assertIn("#ffffff", css)

    def test_solid_named_color_passes(self):
        css = _build_background_css({"type": "solid", "color": "cornflowerblue"})
        self.assertIn("cornflowerblue", css)

    def test_solid_rgb_color_passes(self):
        css = _build_background_css({"type": "solid", "color": "rgb(100, 200, 50)"})
        self.assertIn("rgb(100, 200, 50)", css)

    def test_gradient_colors_validated(self):
        bg = {
            "type": "gradient",
            "gradient": {
                "rotate": 45,
                "colors": [
                    {"color": "#f00", "pos": 0},
                    {"color": "blue; } .x {", "pos": 1},
                ],
            },
        }
        css = _build_background_css(bg)
        self.assertIn("#f00", css)
        self.assertNotIn("} .x {", css)
        self.assertIn("#fff", css)

    def test_gradient_angle_validated(self):
        bg = {
            "type": "gradient",
            "gradient": {
                "rotate": "90deg; background:red",
                "colors": [{"color": "#fff", "pos": 0}],
            },
        }
        css = _build_background_css(bg)
        self.assertNotIn("background:red", css)
        self.assertIn("0.0deg", css)

    def test_none_bg_returns_default(self):
        css = _build_background_css(None)
        self.assertIn("#ffffff", css)


# ── I5-05 / I5-06: Background image URL & imageSize ──────────────────

class TestBuildBackgroundImageSecurity(TestCase):
    def test_url_single_quote_escaped(self):
        bg = {
            "type": "image",
            "image": "https://example.com/img.jpg'); background:red; .x('",
        }
        css = _build_background_css(bg)
        self.assertNotIn("'); background:red", css)
        self.assertIn("%27", css)

    def test_url_backslash_escaped(self):
        bg = {"type": "image", "image": "https://example.com/img\\evil"}
        css = _build_background_css(bg)
        self.assertIn("%5C", css)

    def test_imageSize_whitelist_cover(self):
        bg = {"type": "image", "image": "https://example.com/img.jpg", "imageSize": "cover"}
        css = _build_background_css(bg)
        self.assertIn("background-size: cover", css)

    def test_imageSize_whitelist_contain(self):
        bg = {"type": "image", "image": "https://example.com/img.jpg", "imageSize": "contain"}
        css = _build_background_css(bg)
        self.assertIn("background-size: contain", css)

    def test_imageSize_whitelist_auto(self):
        bg = {"type": "image", "image": "https://example.com/img.jpg", "imageSize": "auto"}
        css = _build_background_css(bg)
        self.assertIn("background-size: auto", css)

    def test_imageSize_whitelist_100_percent(self):
        bg = {"type": "image", "image": "https://example.com/img.jpg", "imageSize": "100% 100%"}
        css = _build_background_css(bg)
        self.assertIn("background-size: 100% 100%", css)

    def test_imageSize_malicious_blocked(self):
        bg = {
            "type": "image",
            "image": "https://example.com/img.jpg",
            "imageSize": "cover; } body { display:none } .x {",
        }
        css = _build_background_css(bg)
        self.assertNotIn("display:none", css)
        self.assertIn("background-size: cover", css)

    def test_imageSize_default_cover(self):
        bg = {"type": "image", "image": "https://example.com/img.jpg"}
        css = _build_background_css(bg)
        self.assertIn("background-size: cover", css)


# ── Integration: build_slide_html with malicious elements ────────────

class TestBuildSlideHtmlSecurityIntegration(TestCase):
    def test_latex_xss_in_full_html(self):
        elements = [
            {
                "type": "latex",
                "id": "latex1",
                "left": 100, "top": 100, "width": 300, "height": 100,
                "latex": "x^2",
                "svg": '<svg><script>document.cookie</script><text>x²</text></svg>',
            }
        ]
        html = build_slide_html(elements)
        self.assertNotIn("<script>document.cookie</script>", html)

    def test_chart_script_escape_in_full_html(self):
        elements = [
            {
                "type": "chart",
                "id": "chart1",
                "left": 0, "top": 0, "width": 400, "height": 300,
                "chartType": "bar",
                "data": {
                    "labels": ["</script><script>alert(1)</script>"],
                    "series": [{"data": [42]}],
                },
            }
        ]
        html = build_slide_html(elements)
        self.assertNotIn("</script><script>alert(1)</script>", html)

    def test_background_css_injection_in_full_html(self):
        bg = {"type": "solid", "color": "#333; } * { visibility: hidden } .a {"}
        html = build_slide_html([], background=bg)
        self.assertNotIn("visibility: hidden", html)

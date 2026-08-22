"""
P0 安全修复测试：I5-06 / I5-07 / I5-08 / I5-09 / I5-10

I5-06: 背景 imageSize 白名单校验
I5-07: _render_table_element display_content HTML 转义
I5-08: _render_shape_element shape text content HTML 转义
I5-09: _render_line_element color _safe_css_color 校验
I5-10: _render_line_element 折线/曲线坐标 _safe_float 校验
"""

from __future__ import annotations

from unittest import TestCase

from apps.tabslide.services.preview_service import (
    _build_background_css,
    _render_line_element,
    _render_shape_element,
    _render_table_element,
    build_slide_html,
)


# ============================================================================
# I5-06: 背景 imageSize 白名单
# ============================================================================


class I506BackgroundImageSizeWhitelistTests(TestCase):
    """I5-06: imageSize 值必须经过白名单校验，恶意值回退为 cover。"""

    def test_valid_cover(self):
        css = _build_background_css({"type": "image", "image": "https://example.com/bg.jpg", "imageSize": "cover"})
        self.assertIn("background-size: cover", css)

    def test_valid_contain(self):
        css = _build_background_css({"type": "image", "image": "https://example.com/bg.jpg", "imageSize": "contain"})
        self.assertIn("background-size: contain", css)

    def test_valid_auto(self):
        css = _build_background_css({"type": "image", "image": "https://example.com/bg.jpg", "imageSize": "auto"})
        self.assertIn("background-size: auto", css)

    def test_valid_100_percent(self):
        css = _build_background_css({"type": "image", "image": "https://example.com/bg.jpg", "imageSize": "100% 100%"})
        self.assertIn("background-size: 100% 100%", css)

    def test_injection_falls_back_to_cover(self):
        """恶意 imageSize 值不应直接插入 CSS。"""
        malicious = "cover; } body { background: url(evil) } .x {"
        css = _build_background_css({"type": "image", "image": "https://example.com/bg.jpg", "imageSize": malicious})
        self.assertNotIn("evil", css)
        self.assertIn("background-size: cover", css)

    def test_arbitrary_css_blocked(self):
        css = _build_background_css({"type": "image", "image": "https://example.com/bg.jpg", "imageSize": "200px 300px"})
        self.assertNotIn("200px", css)
        self.assertIn("background-size: cover", css)

    def test_default_when_missing(self):
        css = _build_background_css({"type": "image", "image": "https://example.com/bg.jpg"})
        self.assertIn("background-size: cover", css)


# ============================================================================
# I5-07: table display_content 转义
# ============================================================================


class I507TableDisplayContentEscapeTests(TestCase):
    """I5-07: table cell content 必须 HTML 转义，防止 XSS。"""

    def _make_table_el(self, cell_data):
        return {
            "type": "table",
            "id": "tbl-1",
            "left": 0, "top": 0, "width": 400, "height": 200,
            "data": [[cell_data]],
        }

    def test_script_in_text_escaped(self):
        el = self._make_table_el({"text": '<script>alert("xss")</script>'})
        html = _render_table_element(el, "left:0;top:0;width:400px;height:200px;", 'data-element-type="table"')
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_script_in_richtext_escaped(self):
        el = self._make_table_el({"richText": '<img src=x onerror="alert(1)">'})
        html = _render_table_element(el, "left:0;top:0;width:400px;height:200px;", 'data-element-type="table"')
        self.assertNotIn('onerror="alert(1)"', html)
        self.assertIn("&lt;img", html)

    def test_normal_text_renders(self):
        el = self._make_table_el({"text": "Hello World"})
        html = _render_table_element(el, "left:0;top:0;width:400px;height:200px;", 'data-element-type="table"')
        self.assertIn("Hello World", html)

    def test_ampersand_escaped(self):
        el = self._make_table_el({"text": "A & B < C"})
        html = _render_table_element(el, "left:0;top:0;width:400px;height:200px;", 'data-element-type="table"')
        self.assertIn("A &amp; B &lt; C", html)

    def test_non_dict_cell_escaped(self):
        """非 dict 的 cell 值也应转义。"""
        el = {
            "type": "table",
            "id": "tbl-2",
            "left": 0, "top": 0, "width": 400, "height": 200,
            "data": [["<b>bold</b>"]],
        }
        html = _render_table_element(el, "left:0;top:0;", 'data-element-type="table"')
        self.assertNotIn("<b>bold</b>", html)
        self.assertIn("&lt;b&gt;bold&lt;/b&gt;", html)


# ============================================================================
# I5-08: shape text content 转义
# ============================================================================


class I508ShapeTextContentEscapeTests(TestCase):
    """I5-08: shape 内部 text.content 必须 HTML 转义。"""

    def _make_shape_el(self, text_content):
        return {
            "type": "shape",
            "id": "shape-1",
            "left": 0, "top": 0, "width": 200, "height": 100,
            "fill": "#e0e0e0",
            "text": {"content": text_content, "defaultFontSize": 14, "defaultColor": "#333"},
        }

    def test_script_injection_escaped(self):
        el = self._make_shape_el('<script>alert("xss")</script>')
        html = _render_shape_element(el, "left:0;top:0;width:200px;height:100px;", 'data-element-type="shape"')
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_img_onerror_escaped(self):
        el = self._make_shape_el('<img src=x onerror="alert(1)">')
        html = _render_shape_element(el, "left:0;top:0;width:200px;height:100px;", 'data-element-type="shape"')
        self.assertNotIn('<img src=x', html)
        self.assertIn("&lt;img", html)
        self.assertIn("onerror=&quot;", html)

    def test_normal_text_preserved(self):
        el = self._make_shape_el("Hello Shape")
        html = _render_shape_element(el, "left:0;top:0;width:200px;height:100px;", 'data-element-type="shape"')
        self.assertIn("Hello Shape", html)

    def test_angle_brackets_escaped(self):
        el = self._make_shape_el("x < y && y > z")
        html = _render_shape_element(el, "left:0;top:0;width:200px;height:100px;", 'data-element-type="shape"')
        self.assertIn("&lt;", html)
        self.assertIn("&gt;", html)
        self.assertIn("&amp;&amp;", html)

    def test_txt_color_validated(self):
        """txt_color 含恶意值时应回退到 。"""
        el = {
            "type": "shape",
            "id": "shape-2",
            "left": 0, "top": 0, "width": 200, "height": 100,
            "fill": "#e0e0e0",
            "text": {
                "content": "test",
                "defaultFontSize": 14,
                "defaultColor": '#333; } .evil { background: url(x)',
            },
        }
        html = _render_shape_element(el, "left:0;top:0;width:200px;height:100px;", 'data-element-type="shape"')
        self.assertNotIn("evil", html)
        self.assertIn("color:", html)

    def test_txt_font_attr_escaped(self):
        """txt_font 含 CSS 注入字符时应被净化。"""
        el = {
            "type": "shape",
            "id": "shape-3",
            "left": 0, "top": 0, "width": 200, "height": 100,
            "fill": "#e0e0e0",
            "text": {
                "content": "test",
                "defaultFontSize": 14,
                "defaultColor": "#333",
                "defaultFontName": "Evil'; } .hack { color: red; } .x { font-family: '",
            },
        }
        html = _render_shape_element(el, "left:0;top:0;width:200px;height:100px;", 'data-element-type="shape"')
        self.assertNotIn("'Evil'", html)
        self.assertNotIn("{ color:", html)
        self.assertNotIn("}", html.split("font-family")[1].split("sans-serif")[0])


# ============================================================================
# I5-09: line color 校验
# ============================================================================


class I509LineColorValidationTests(TestCase):
    """I5-09: line element color 必须经过 _safe_css_color 校验。"""

    def _make_line_el(self, color="#333", **kwargs):
        el = {
            "type": "line",
            "id": "line-1",
            "left": 0, "top": 0, "width": 200, "height": 0,
            "color": color,
            "start": [0, 0],
            "end": [200, 0],
        }
        el.update(kwargs)
        return el

    def test_valid_hex_color(self):
        el = self._make_line_el(color="#ff0000")
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertIn('stroke="#ff0000"', html)

    def test_valid_named_color(self):
        el = self._make_line_el(color="red")
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertIn('stroke="red"', html)

    def test_malicious_color_rejected(self):
        """恶意 color 值不应直接插入 SVG stroke 属性。"""
        malicious = '#333" onload="alert(1)" x="'
        el = self._make_line_el(color=malicious)
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertNotIn("onload", html)
        self.assertIn('stroke="#333"', html)  # fallback

    def test_css_injection_blocked(self):
        el = self._make_line_el(color="red; } .evil { background: url(x)")
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertNotIn("evil", html)

    def test_line_cap_whitelist(self):
        """非法 lineCap 值不应出现在 SVG 中。"""
        el = self._make_line_el(lineCap='round" onload="alert(1)')
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertNotIn("onload", html)

    def test_line_join_whitelist(self):
        """合法 lineJoin 值应正常输出。"""
        el = self._make_line_el(lineJoin="bevel")
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertIn('stroke-linejoin="bevel"', html)

    def test_invalid_line_join_rejected(self):
        el = self._make_line_el(lineJoin="bevel\" malicious=\"true")
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertNotIn("malicious", html)


# ============================================================================
# I5-10: line 折线/曲线坐标 _safe_float 校验
# ============================================================================


class I510LineCoordinateValidationTests(TestCase):
    """I5-10: 折线/曲线坐标必须经过 _safe_float 校验，防止 SVG path 注入。"""

    def _make_line_el(self, **kwargs):
        el = {
            "type": "line",
            "id": "line-coord",
            "left": 0, "top": 0, "width": 200, "height": 100,
            "color": "#333",
            "start": [0, 0],
            "end": [200, 100],
        }
        el.update(kwargs)
        return el

    def test_broken_line_with_valid_coords(self):
        el = self._make_line_el(broken=[100, 50])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertIn("L 100.0 50.0", html)

    def test_broken_line_malicious_coords_sanitized(self):
        """恶意坐标值应被 _safe_float 转为 0.0，SVG path 中不含注入。"""
        el = self._make_line_el(broken=['100" /><script>alert(1)</script><path d="M 0 0', 50])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        svg_match = html[html.index('<svg'):html.index('</svg>') + 6]
        self.assertNotIn("<script>", svg_match)
        self.assertIn("L 0.0 50.0", svg_match)

    def test_broken2_double_midpoint(self):
        el = self._make_line_el(broken=[50, 25], broken2=[150, 75])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertIn("L 50.0 25.0 L 150.0 75.0", html)

    def test_curve_with_valid_control_point(self):
        el = self._make_line_el(curve=[100, 0])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertIn("Q 100.0 0.0", html)

    def test_curve_malicious_control_point(self):
        el = self._make_line_el(curve=["50 0 Z\"><script>alert(1)</script><path d=\"M 0", 25])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        svg_match = html[html.index('<svg'):html.index('</svg>') + 6]
        self.assertNotIn("<script>", svg_match)
        self.assertIn("Q 0.0 25.0", svg_match)

    def test_cubic_flat_control_points(self):
        el = self._make_line_el(cubic=[50, 25])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertIn("C 50.0 25.0 50.0 25.0", html)

    def test_cubic_nested_control_points(self):
        el = self._make_line_el(cubic=[[50, 10], [150, 90]])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertIn("C 50.0 10.0 150.0 90.0", html)

    def test_cubic_malicious_nested(self):
        el = self._make_line_el(cubic=[["0\"/><animate>", 10], [150, 90]])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        svg_match = html[html.index('<svg'):html.index('</svg>') + 6]
        self.assertNotIn("<animate>", svg_match)
        self.assertIn("C 0.0 10.0 150.0 90.0", svg_match)

    def test_start_end_coords_validated(self):
        """start/end 坐标也应经过 _safe_float 校验。"""
        el = self._make_line_el(start=["evil", 0], end=[200, "bad"])
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertNotIn("evil", html)
        self.assertNotIn("bad", html)

    def test_line_width_validated(self):
        """lineWidth 应经过 _safe_float 校验。"""
        el = self._make_line_el(lineWidth='2" onload="alert(1)')
        html = _render_line_element(el, "left:0;top:0;", 'data-element-type="line"')
        self.assertNotIn("onload", html)


# ============================================================================
# 集成测试：build_slide_html 端到端
# ============================================================================


class IntegrationBuildSlideHtmlTests(TestCase):
    """端到端验证 build_slide_html 在包含恶意数据时不产生可执行的注入。"""

    def test_malicious_bg_imagesize(self):
        bg = {
            "type": "image",
            "image": "https://example.com/bg.jpg",
            "imageSize": "cover; } body { background: url(evil); } .x {",
        }
        html = build_slide_html([], background=bg)
        self.assertNotIn("evil", html)
        self.assertIn("background-size: cover", html)

    def test_malicious_table_cell(self):
        elements = [
            {
                "type": "table",
                "id": "t1",
                "left": 0, "top": 0, "width": 400, "height": 200,
                "data": [[{"text": '<script>alert("xss")</script>'}]],
            }
        ]
        html = build_slide_html(elements)
        self.assertNotIn('<script>alert("xss")</script>', html)
        self.assertIn("&lt;script&gt;", html)

    def test_malicious_shape_text(self):
        elements = [
            {
                "type": "shape",
                "id": "s1",
                "left": 0, "top": 0, "width": 200, "height": 100,
                "fill": "#ddd",
                "text": {"content": '<img src=x onerror="alert(1)">'},
            }
        ]
        html = build_slide_html(elements)
        self.assertNotIn('<img src=x', html)
        self.assertIn('&lt;img', html)

    def test_malicious_line_color_and_coords(self):
        elements = [
            {
                "type": "line",
                "id": "l1",
                "left": 0, "top": 0, "width": 200, "height": 100,
                "color": '#333" onload="alert(1)',
                "broken": ['100"/><script>alert(1)</script><path d="M 0 0', 50],
            }
        ]
        html = build_slide_html(elements)
        svg_start = html.index('<svg')
        svg_end = html.index('</svg>') + 6
        svg_section = html[svg_start:svg_end]
        self.assertNotIn("<script>", svg_section)
        self.assertNotIn("onload", svg_section)
        self.assertIn('stroke="#333"', svg_section)

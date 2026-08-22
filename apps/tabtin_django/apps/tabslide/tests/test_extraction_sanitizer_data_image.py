"""抽取入口 sanitizer 对 data: 协议的放行 / 拦截回归测试。

锁定 `_sanitize_slide_html_for_extraction` 的行为契约：
- 放行光栅图 data:image(png/jpeg/gif/webp/bmp)，让作者/agent 的 base64 图能走到
  dom_extractor postprocess 的 data:→OSS 上传路（图落 slide 自己的存储、durable）。
- 仍拦 data:image/svg+xml（可带脚本）、data:text/html、javascript:、vbscript:。
- 光栅 MIME 后必须跟 `;` 或 `,`（真实 data URI 形态），堵掉 data:image/png2foo 之类冒充。
"""

from __future__ import annotations

from unittest import TestCase


class ExtractionSanitizerDataImageTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabslide.services.slide_service import _sanitize_slide_html_for_extraction
        cls.sanitize = staticmethod(_sanitize_slide_html_for_extraction)

    def test_raster_data_image_preserved(self):
        for mime in ("png", "jpeg", "jpg", "gif", "webp", "bmp"):
            html = f'<img src="data:image/{mime};base64,AAAA">'
            self.assertEqual(self.sanitize(html), html, f"{mime} 应原样保留")

    def test_raster_data_image_single_quote_preserved(self):
        html = "<img src='data:image/png;base64,AAAA'>"
        self.assertEqual(self.sanitize(html), html)

    def test_svg_data_uri_stripped(self):
        result = self.sanitize('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">')
        self.assertNotIn("data:", result.lower())

    def test_html_data_uri_stripped(self):
        result = self.sanitize('<a href="data:text/html,<script>alert(1)</script>">x</a>')
        self.assertNotIn("data:text/html", result.lower())

    def test_javascript_protocol_stripped(self):
        result = self.sanitize('<a href="javascript:alert(1)">x</a>')
        self.assertNotIn("javascript:", result.lower())

    def test_vbscript_protocol_stripped(self):
        result = self.sanitize('<img src="vbscript:run()">')
        self.assertNotIn("vbscript:", result.lower())

    def test_fake_raster_mime_stripped(self):
        """光栅 MIME 后无 `;`/`,` 分隔（如 data:image/png2foo）不算光栅，应拦掉。"""
        result = self.sanitize('<img src="data:image/png2foo,AAAA">')
        self.assertNotIn("data:image/png2", result.lower())

    def test_external_http_url_untouched(self):
        html = '<img src="https://example.com/x.png!webp">'
        self.assertEqual(self.sanitize(html), html)

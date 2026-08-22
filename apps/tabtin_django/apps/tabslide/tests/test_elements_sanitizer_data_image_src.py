"""elements_data 落库 sanitizer 对 src 字段 data:image 的放行 / 拦截回归测试。

锁定 `_sanitize_url` / `_sanitize_dict_urls` 的行为契约：
- src 字段放行真实 data URI 形态的 data:image/*（含 svg+xml——dom_extractor
  inline_images 模式自产的内嵌 SVG 正是该形态；img 上下文 SVG 禁脚本）。
- src 字段仍拦 data:text/html、javascript:、vbscript:、伪装 MIME。
- href / link / url 字段保持全量拦（导航语义，data: 一律替换 '#'）。
"""

from __future__ import annotations

from unittest import TestCase


class ElementsSanitizerDataImageSrcTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabslide.services.slide_service import _sanitize_dict_urls
        cls.sanitize_dict = staticmethod(_sanitize_dict_urls)

    def _run(self, key: str, value: str) -> str:
        d = {key: value}
        self.sanitize_dict(d)
        return d[key]

    def test_src_raster_data_image_preserved(self):
        for mime in ("png", "jpeg", "jpg", "gif", "webp", "bmp"):
            uri = f"data:image/{mime};base64,AAAA"
            self.assertEqual(self._run("src", uri), uri, f"src {mime} 应放行")

    def test_src_svg_data_image_preserved(self):
        uri = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
        self.assertEqual(self._run("src", uri), uri)

    def test_src_data_text_html_blocked(self):
        self.assertEqual(self._run("src", "data:text/html,<script>alert(1)</script>"), "#")

    def test_src_javascript_blocked(self):
        self.assertEqual(self._run("src", "javascript:alert(1)"), "#")

    def test_src_fake_raster_mime_blocked(self):
        self.assertEqual(self._run("src", "data:image/png2foo,AAAA"), "#")

    def test_href_data_image_still_blocked(self):
        for key in ("href", "link", "url"):
            self.assertEqual(
                self._run(key, "data:image/png;base64,AAAA"), "#",
                f"{key} 是导航语义，data: 应保持全量拦",
            )

    def test_src_normal_url_untouched(self):
        url = "https://example.com/x.png"
        self.assertEqual(self._run("src", url), url)

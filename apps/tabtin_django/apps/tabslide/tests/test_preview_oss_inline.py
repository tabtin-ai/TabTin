"""
TC-PREVIEW-OSS-INLINE-01 — preview_service._inline_oss_image_urls

回归用例覆盖：
  - <img src="..."> 中命中我们 OSS bucket 的 URL → 替换为 base64 data: URI
  - background-image: url(...) 命中 OSS → 替换为 data: URI
  - 外部域名（example.com / CDN）→ 保持原 URL 不动
  - 已经是 data: URL → 保持原状
  - SDK 下载失败（返回 None）→ 保持原 URL（不破坏 HTML）
  - 同一 HTML 中重复出现的 URL 只下载一次（缓存）
  - 不同扩展名推断对应 MIME（.jpg → image/jpeg，.webp → image/webp 等）
  - build_slide_html 端到端：image 元素的 OSS src 被替换为 data: URI

修复前 bug：
  preview_service 用 Playwright headless 渲染 HTML。本地开发环境若跑透明代理
  （ClashX/Surge），所有公网域名被 DNS 劫持到 198.18.x.x 假 IP（RFC 5735
  reserved），Playwright 加载 OSS 图片 URL 时连不上，导致截图里 raster 图
  只显示占位框。pptx_io 已经通过 _download_image_smart 走 OSS SDK 绕开
  DNS，preview 应该保持一致。
"""

from __future__ import annotations

import base64
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings


@override_settings(
    ALIYUN_OSS_BUCKET_NAME="example-assets",
    ALIYUN_OSS_ENDPOINT="oss-cn-wuhan-lr.aliyuncs.com",
    ALIYUN_OSS_CDN_DOMAIN="",
)
class InlineOSSImageURLsTests(SimpleTestCase):
    """_inline_oss_image_urls — HTML 中 OSS URL → data: URI 内联。"""

    OSS_URL = "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/img/a.png"
    OSS_URL_JPG = "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/img/b.jpg"
    OSS_URL_WEBP = "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/img/c.webp"
    EXT_URL = "https://example.com/external.png"

    # ── <img src="..."> 替换 ──

    def test_img_src_oss_replaced_with_data_uri(self):
        from apps.tabslide.services import preview_service
        html = f'<img src="{self.OSS_URL}" alt="x" />'
        with patch.object(preview_service, "_inline_oss_image_urls", wraps=preview_service._inline_oss_image_urls), \
             patch("apps.tabslide.services.pptx_io._download_image_smart", return_value=b"PNG-BYTES"):
            out = preview_service._inline_oss_image_urls(html)
        expected_b64 = base64.b64encode(b"PNG-BYTES").decode("ascii")
        self.assertIn(f"data:image/png;base64,{expected_b64}", out)
        self.assertNotIn(self.OSS_URL, out)
        self.assertIn('alt="x"', out)  # 其他属性保留

    def test_img_src_external_url_left_alone(self):
        from apps.tabslide.services import preview_service
        html = f'<img src="{self.EXT_URL}" />'
        with patch("apps.tabslide.services.pptx_io._download_image_smart", return_value=b"X"):
            out = preview_service._inline_oss_image_urls(html)
        self.assertIn(self.EXT_URL, out)
        self.assertNotIn("data:image/png;base64", out)

    def test_img_src_data_url_left_alone(self):
        from apps.tabslide.services import preview_service
        existing = "data:image/png;base64,AAAA"
        html = f'<img src="{existing}" />'
        with patch("apps.tabslide.services.pptx_io._download_image_smart") as mock_dl:
            out = preview_service._inline_oss_image_urls(html)
        self.assertEqual(out, html)
        mock_dl.assert_not_called()

    # ── background-image: url(...) 替换 ──

    def test_background_image_oss_replaced(self):
        from apps.tabslide.services import preview_service
        html = (
            f"<div style=\"background-image: url('{self.OSS_URL}'); background-size: cover;\">"
            "</div>"
        )
        with patch("apps.tabslide.services.pptx_io._download_image_smart", return_value=b"BG"):
            out = preview_service._inline_oss_image_urls(html)
        expected_b64 = base64.b64encode(b"BG").decode("ascii")
        self.assertIn(f"data:image/png;base64,{expected_b64}", out)
        self.assertNotIn(self.OSS_URL, out)
        self.assertIn("background-size: cover", out)

    def test_background_image_external_left_alone(self):
        from apps.tabslide.services import preview_service
        html = f"<div style=\"background-image: url('{self.EXT_URL}');\"></div>"
        with patch("apps.tabslide.services.pptx_io._download_image_smart") as mock_dl:
            out = preview_service._inline_oss_image_urls(html)
        self.assertEqual(out, html)
        mock_dl.assert_not_called()

    # ── 异常 / 边界 ──

    def test_sdk_download_failure_keeps_original_url(self):
        """SDK + HTTPS fallback 都返回 None 时，原 URL 保持不变（不破坏 HTML）。"""
        from apps.tabslide.services import preview_service
        html = f'<img src="{self.OSS_URL}" />'
        with patch("apps.tabslide.services.pptx_io._download_image_smart", return_value=None):
            out = preview_service._inline_oss_image_urls(html)
        self.assertIn(self.OSS_URL, out)
        self.assertNotIn("data:image/png;base64", out)

    def test_download_exception_keeps_original_url(self):
        """下载抛异常时也只是降级到原 URL，preview 流程不应中断。"""
        from apps.tabslide.services import preview_service
        html = f'<img src="{self.OSS_URL}" />'
        with patch(
            "apps.tabslide.services.pptx_io._download_image_smart",
            side_effect=RuntimeError("boom"),
        ):
            out = preview_service._inline_oss_image_urls(html)
        self.assertIn(self.OSS_URL, out)

    def test_repeated_oss_url_downloaded_once(self):
        """同一 HTML 中重复出现的 URL 只触发一次下载（缓存）。"""
        from apps.tabslide.services import preview_service
        html = (
            f'<img src="{self.OSS_URL}" />'
            f'<div style="background-image: url(\'{self.OSS_URL}\');"></div>'
            f'<img src="{self.OSS_URL}" />'
        )
        with patch(
            "apps.tabslide.services.pptx_io._download_image_smart",
            return_value=b"ONE",
        ) as mock_dl:
            out = preview_service._inline_oss_image_urls(html)
        self.assertEqual(mock_dl.call_count, 1)
        self.assertNotIn(self.OSS_URL, out)
        self.assertEqual(out.count("data:image/png;base64,"), 3)

    # ── MIME 推断 ──

    def test_mime_inferred_from_jpg_extension(self):
        from apps.tabslide.services import preview_service
        html = f'<img src="{self.OSS_URL_JPG}" />'
        with patch("apps.tabslide.services.pptx_io._download_image_smart", return_value=b"JPG"):
            out = preview_service._inline_oss_image_urls(html)
        self.assertIn("data:image/jpeg;base64,", out)

    def test_mime_inferred_from_webp_extension(self):
        from apps.tabslide.services import preview_service
        html = f'<img src="{self.OSS_URL_WEBP}" />'
        with patch("apps.tabslide.services.pptx_io._download_image_smart", return_value=b"WEBP"):
            out = preview_service._inline_oss_image_urls(html)
        self.assertIn("data:image/webp;base64,", out)

    def test_mime_oss_url_with_signature_still_recognized(self):
        """OSS 签名 URL（含 ?Expires=...&Signature=...）也能正确处理。"""
        from apps.tabslide.services import preview_service
        signed = self.OSS_URL_JPG + "?Expires=123&OSSAccessKeyId=abc&Signature=xyz"
        html = f'<img src="{signed}" />'
        with patch("apps.tabslide.services.pptx_io._download_image_smart", return_value=b"S"):
            out = preview_service._inline_oss_image_urls(html)
        self.assertIn("data:image/jpeg;base64,", out)
        self.assertNotIn(signed, out)

    def test_html_escaped_amp_in_signed_url(self):
        """OSS URL 经过 _html_attr 转义后 & → &amp;，应能识别并替换。"""
        from apps.tabslide.services import preview_service
        # 模拟 _render_image_element 输出（& 已被转义）
        escaped_url = self.OSS_URL_JPG + "?a=1&amp;Signature=xyz"
        html = f'<img src="{escaped_url}" />'
        with patch("apps.tabslide.services.pptx_io._download_image_smart", return_value=b"S2"):
            out = preview_service._inline_oss_image_urls(html)
        self.assertIn("data:image/jpeg;base64,", out)
        self.assertNotIn(escaped_url, out)


@override_settings(
    ALIYUN_OSS_BUCKET_NAME="example-assets",
    ALIYUN_OSS_ENDPOINT="oss-cn-wuhan-lr.aliyuncs.com",
    ALIYUN_OSS_CDN_DOMAIN="",
)
class BuildSlideHTMLInlinesOSSTests(SimpleTestCase):
    """build_slide_html 端到端：image 元素 / 背景图的 OSS URL 都被内联。"""

    OSS_URL = "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/img/e2e.png"
    EXT_URL = "https://example.com/external.png"

    def test_build_slide_html_inlines_oss_image_element(self):
        from apps.tabslide.services.preview_service import build_slide_html
        elements = [
            {
                "type": "image",
                "id": "i1",
                "x": 0, "y": 0, "width": 200, "height": 200,
                "src": self.OSS_URL,
            },
        ]
        with patch(
            "apps.tabslide.services.pptx_io._download_image_smart",
            return_value=b"PNG",
        ):
            html = build_slide_html(elements, background=None)
        self.assertIn("data:image/png;base64,", html)
        self.assertNotIn(self.OSS_URL, html)

    def test_build_slide_html_keeps_external_image(self):
        from apps.tabslide.services.preview_service import build_slide_html
        elements = [
            {
                "type": "image",
                "id": "i2",
                "x": 0, "y": 0, "width": 100, "height": 100,
                "src": self.EXT_URL,
            },
        ]
        with patch(
            "apps.tabslide.services.pptx_io._download_image_smart",
        ) as mock_dl:
            html = build_slide_html(elements, background=None)
        self.assertIn(self.EXT_URL, html)
        mock_dl.assert_not_called()

    def test_build_slide_html_inlines_oss_background(self):
        from apps.tabslide.services.preview_service import build_slide_html
        with patch(
            "apps.tabslide.services.pptx_io._download_image_smart",
            return_value=b"BG-BYTES",
        ):
            html = build_slide_html(
                elements=[],
                background={
                    "type": "image",
                    "image": {"src": self.OSS_URL, "size": "cover"},
                },
            )
        self.assertIn("data:image/png;base64,", html)
        self.assertNotIn(self.OSS_URL, html)


if __name__ == "__main__":
    import unittest
    unittest.main()

"""
TC-PPTX-IO-OSS-01 — pptx_io 图片下载选路

回归用例覆盖：
  - _parse_oss_url_to_object_key：标准 OSS URL / 含签名 / 内网 endpoint / CDN 域名 / 非 OSS URL
  - _download_image_smart：data URL / OSS URL（走 SDK） / 外部 URL（走 SSRF）

修复前 bug：
  pptx_io 所有图片下载都走 ssrf_safe_urlopen。本地开发环境如果跑了
  透明代理（ClashX/Surge），DNS 被劫持到 198.18.x.x 假 IP（RFC 5735 reserved），
  SSRF 防护正确判定为私有网段拒绝。其他业务模块用 OSS SDK 直接传 object_key，
  不受影响——pptx_io 应该跟它们行为一致。
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
class ParseOSSURLTests(SimpleTestCase):
    """_parse_oss_url_to_object_key — URL 识别。"""

    def _patched_settings(self, **kwargs):
        if kwargs:
            return override_settings(**kwargs)
        from contextlib import nullcontext
        return nullcontext()

    def test_accept_standard_oss_url(self):
        from apps.tabslide.services.pptx_io import _parse_oss_url_to_object_key
        with self._patched_settings():
            url = "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/import/abc/1.png"
            self.assertEqual(_parse_oss_url_to_object_key(url), "tabslide/import/abc/1.png")

    def test_accept_internal_endpoint(self):
        from apps.tabslide.services.pptx_io import _parse_oss_url_to_object_key
        with self._patched_settings():
            url = "https://example-assets.oss-cn-wuhan-lr-internal.aliyuncs.com/tabslide/import/abc/1.png"
            self.assertEqual(_parse_oss_url_to_object_key(url), "tabslide/import/abc/1.png")

    def test_accept_url_with_signature(self):
        from apps.tabslide.services.pptx_io import _parse_oss_url_to_object_key
        with self._patched_settings():
            url = "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/x/1.png?Expires=123&OSSAccessKeyId=abc&Signature=xyz"
            self.assertEqual(_parse_oss_url_to_object_key(url), "tabslide/x/1.png")

    def test_accept_cdn_domain(self):
        from apps.tabslide.services.pptx_io import _parse_oss_url_to_object_key
        with self._patched_settings(ALIYUN_OSS_CDN_DOMAIN="cdn.example.com"):
            url = "https://cdn.example.com/tabslide/x/1.png"
            self.assertEqual(_parse_oss_url_to_object_key(url), "tabslide/x/1.png")

    def test_reject_external_url(self):
        from apps.tabslide.services.pptx_io import _parse_oss_url_to_object_key
        with self._patched_settings():
            self.assertIsNone(_parse_oss_url_to_object_key("https://example.com/x.png"))

    def test_reject_other_bucket(self):
        from apps.tabslide.services.pptx_io import _parse_oss_url_to_object_key
        with self._patched_settings():
            self.assertIsNone(_parse_oss_url_to_object_key("https://other-bucket.oss-cn-wuhan-lr.aliyuncs.com/x.png"))

    def test_reject_non_http(self):
        from apps.tabslide.services.pptx_io import _parse_oss_url_to_object_key
        with self._patched_settings():
            self.assertIsNone(_parse_oss_url_to_object_key("data:image/png;base64,abc"))
            self.assertIsNone(_parse_oss_url_to_object_key("file:///tmp/x.png"))

    def test_reject_empty(self):
        from apps.tabslide.services.pptx_io import _parse_oss_url_to_object_key
        with self._patched_settings():
            self.assertIsNone(_parse_oss_url_to_object_key(""))
            self.assertIsNone(_parse_oss_url_to_object_key(None))


@override_settings(
    ALIYUN_OSS_BUCKET_NAME="example-assets",
    ALIYUN_OSS_ENDPOINT="oss-cn-wuhan-lr.aliyuncs.com",
    ALIYUN_OSS_CDN_DOMAIN="",
)
class DownloadImageSmartTests(SimpleTestCase):
    """_download_image_smart — 三路径分发。"""

    def _patched_settings(self):
        from contextlib import nullcontext
        return nullcontext()

    def test_data_url_decoded_directly(self):
        from apps.tabslide.services.pptx_io import _download_image_smart
        payload = b"hello"
        src = "data:image/png;base64," + base64.b64encode(payload).decode()
        with self._patched_settings():
            self.assertEqual(_download_image_smart(src), payload)

    def test_data_url_max_bytes(self):
        from apps.tabslide.services.pptx_io import _download_image_smart
        payload = b"A" * 100
        src = "data:image/png;base64," + base64.b64encode(payload).decode()
        with self._patched_settings():
            self.assertIsNone(_download_image_smart(src, max_bytes=50))
            self.assertEqual(_download_image_smart(src, max_bytes=200), payload)

    def test_oss_url_goes_via_sdk(self):
        """OSS URL 命中我们 bucket → 走 SDK，不走 ssrf_safe_urlopen。"""
        from apps.tabslide.services.pptx_io import _download_image_smart
        with self._patched_settings(), \
             patch("apps.tabslide.services.pptx_io._download_oss_via_sdk") as mock_sdk, \
             patch("apps.services.common.url_security.ssrf_safe_urlopen") as mock_ssrf:
            mock_sdk.return_value = b"oss-bytes"
            url = "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabslide/x/1.png"
            self.assertEqual(_download_image_smart(url), b"oss-bytes")
            mock_sdk.assert_called_once_with("tabslide/x/1.png")
            mock_ssrf.assert_not_called()

    def test_external_url_goes_via_ssrf(self):
        """非我们 OSS 的 URL → 走 SSRF 安全的 ssrf_safe_urlopen。"""
        from apps.tabslide.services.pptx_io import _download_image_smart
        with self._patched_settings(), \
             patch("apps.tabslide.services.pptx_io._download_oss_via_sdk") as mock_sdk, \
             patch("apps.services.common.url_security.ssrf_safe_urlopen") as mock_ssrf:
            mock_ssrf.return_value = b"https-bytes"
            url = "https://example.com/x.png"
            self.assertEqual(_download_image_smart(url), b"https-bytes")
            mock_sdk.assert_not_called()
            mock_ssrf.assert_called_once()

    def test_oss_sdk_fail_falls_back_to_https(self):
        """SDK 失败时回退 HTTPS（兼容 OSS bucket 配置变更等场景）。"""
        from apps.tabslide.services.pptx_io import _download_image_smart
        with self._patched_settings(), \
             patch("apps.tabslide.services.pptx_io._download_oss_via_sdk") as mock_sdk, \
             patch("apps.services.common.url_security.ssrf_safe_urlopen") as mock_ssrf:
            mock_sdk.return_value = None
            mock_ssrf.return_value = b"https-fallback"
            url = "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/x.png"
            self.assertEqual(_download_image_smart(url), b"https-fallback")
            mock_sdk.assert_called_once()
            mock_ssrf.assert_called_once()

    def test_ssrf_blocked_returns_none(self):
        from apps.tabslide.services.pptx_io import _download_image_smart
        with self._patched_settings(), \
             patch("apps.services.common.url_security.ssrf_safe_urlopen") as mock_ssrf:
            mock_ssrf.side_effect = ValueError("目标地址属于受限网段")
            self.assertIsNone(_download_image_smart("https://example.com/x.png"))

    def test_unsupported_scheme(self):
        from apps.tabslide.services.pptx_io import _download_image_smart
        with self._patched_settings():
            self.assertIsNone(_download_image_smart("file:///etc/passwd"))
            self.assertIsNone(_download_image_smart("ftp://example.com/x.png"))


if __name__ == "__main__":
    import unittest
    unittest.main()

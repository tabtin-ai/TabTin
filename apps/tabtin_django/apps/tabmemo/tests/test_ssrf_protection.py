"""
_is_safe_url SSRF 防护专项测试

覆盖内网地址、云元数据端点、非法 scheme 等边界情况。
使用 mock 控制 DNS 解析，避免测试依赖外部网络。
"""

from unittest.mock import patch

from django.test import SimpleTestCase


class IsSafeUrlTests(SimpleTestCase):
    """验证 _is_safe_url 对各类 SSRF 攻击向量的拦截能力"""

    def _is_safe(self, url: str, resolved_ips: list[str] | None = None) -> bool:
        from apps.tabmemo.api import _is_safe_url

        if resolved_ips is not None:
            fake_addrinfo = [
                (None, None, None, None, (ip, 0))
                for ip in resolved_ips
            ]
            with patch("socket.getaddrinfo", return_value=fake_addrinfo):
                return _is_safe_url(url)
        return _is_safe_url(url)

    def test_safe_url_should_pass(self):
        self.assertTrue(self._is_safe("https://example.com", ["93.184.216.34"]))

    def test_http_should_also_pass(self):
        self.assertTrue(self._is_safe("http://example.com/page", ["93.184.216.34"]))

    def test_localhost_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://localhost/secret"))

    def test_127_0_0_1_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://127.0.0.1:8080"))

    def test_ipv6_loopback_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://[::1]/secret"))

    def test_zero_addr_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://0.0.0.0/secret"))

    def test_cloud_metadata_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://169.254.169.254/latest/meta-data/"))

    def test_private_10_x_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://internal.corp", ["10.0.0.1"]))

    def test_private_172_16_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://internal.corp", ["172.16.0.5"]))

    def test_private_192_168_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://internal.corp", ["192.168.1.100"]))

    def test_link_local_169_254_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://internal.corp", ["169.254.1.1"]))

    def test_ftp_scheme_should_be_blocked(self):
        self.assertFalse(self._is_safe("ftp://example.com/file"))

    def test_file_scheme_should_be_blocked(self):
        self.assertFalse(self._is_safe("file:///etc/passwd"))

    def test_empty_url_should_be_blocked(self):
        self.assertFalse(self._is_safe(""))

    def test_no_hostname_should_be_blocked(self):
        self.assertFalse(self._is_safe("http://"))

    def test_dns_resolution_failure_should_be_blocked(self):
        with patch("socket.getaddrinfo", side_effect=OSError("DNS failed")):
            from apps.tabmemo.api import _is_safe_url
            self.assertFalse(_is_safe_url("http://nonexistent.invalid"))

    def test_mixed_ips_with_one_private_should_be_blocked(self):
        self.assertFalse(
            self._is_safe("http://dual.example.com", ["93.184.216.34", "10.0.0.1"])
        )

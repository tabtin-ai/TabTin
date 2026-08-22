from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.common.url_security import resolve_and_validate


class TrustedHostResolutionTests(SimpleTestCase):
    @patch("apps.services.common.url_security.socket.getaddrinfo")
    def test_trusted_host_can_use_local_proxy_fake_ip(self, mocked_getaddrinfo):
        mocked_getaddrinfo.return_value = [
            (2, 1, 6, "", ("198.18.0.113", 443)),
        ]

        resolved = resolve_and_validate(
            "https://open.feishu.cn/open-apis/bot/v2/hook/test-id",
            trusted_hosts={"open.feishu.cn"},
        )

        self.assertEqual(resolved.resolved_ip, "198.18.0.113")

    @patch("apps.services.common.url_security.socket.getaddrinfo")
    def test_untrusted_host_still_rejects_local_proxy_fake_ip(self, mocked_getaddrinfo):
        mocked_getaddrinfo.return_value = [
            (2, 1, 6, "", ("198.18.0.113", 443)),
        ]

        with self.assertRaisesMessage(ValueError, "目标地址属于受限网段"):
            resolve_and_validate("https://example.com/webhook")

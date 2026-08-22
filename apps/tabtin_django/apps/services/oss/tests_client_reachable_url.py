"""Local OSS 环回 URL → 客户端可达 Host 改写（ 方案 A）。"""

from django.test import RequestFactory, SimpleTestCase

from apps.services.oss.services.client_reachable_url import (
    is_loopback_host,
    rewrite_loopback_absolute_url_for_request,
)


class ClientReachableUrlTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def test_is_loopback_host(self):
        self.assertTrue(is_loopback_host("127.0.0.1"))
        self.assertTrue(is_loopback_host("localhost:6060"))
        self.assertTrue(is_loopback_host("[::1]:6060"))
        self.assertFalse(is_loopback_host("192.168.8.10:6060"))
        self.assertFalse(is_loopback_host("api.example.com"))

    def test_rewrite_loopback_to_lan_request_host(self):
        request = self.factory.get(
            "/api/chat/sessions/x/shared-file-preview",
            HTTP_HOST="192.168.8.10:6060",
        )
        src = (
            "http://127.0.0.1:6060/api/services/oss/local-object"
            "?object_key=session-share%2Fa&signature=sig"
        )
        out = rewrite_loopback_absolute_url_for_request(src, request)
        self.assertTrue(
            out.startswith(
                "http://192.168.8.10:6060/api/services/oss/local-object?"
            ),
            out,
        )
        self.assertIn("object_key=session-share%2Fa", out)
        self.assertIn("signature=sig", out)

    def test_keep_when_request_also_loopback(self):
        request = self.factory.get("/", HTTP_HOST="127.0.0.1:6060")
        src = "http://127.0.0.1:6060/api/services/oss/local-object?object_key=a"
        self.assertEqual(
            rewrite_loopback_absolute_url_for_request(src, request),
            src,
        )

    def test_keep_non_loopback_url(self):
        request = self.factory.get("/", HTTP_HOST="192.168.8.10:6060")
        src = "https://cdn.example.com/obj?sig=1"
        self.assertEqual(
            rewrite_loopback_absolute_url_for_request(src, request),
            src,
        )

    def test_keep_without_request(self):
        src = "http://127.0.0.1:6060/api/services/oss/local-object?object_key=a"
        self.assertEqual(
            rewrite_loopback_absolute_url_for_request(src, None),
            src,
        )

    def test_localhost_rewritten(self):
        request = self.factory.get("/", HTTP_HOST="10.0.0.2:6060")
        src = "http://localhost:6060/api/services/oss/local-object?object_key=a"
        out = rewrite_loopback_absolute_url_for_request(src, request)
        self.assertEqual(
            out,
            "http://10.0.0.2:6060/api/services/oss/local-object?object_key=a",
        )

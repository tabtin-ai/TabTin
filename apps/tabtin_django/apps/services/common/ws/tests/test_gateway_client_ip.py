"""WS 网关客户端 IP 解析与 HTTP 可信代理口径保持一致。"""

from django.test import SimpleTestCase, override_settings

from apps.services.common.ws.gateway import _resolve_gateway_client_ip


class GatewayClientIPResolutionTests(SimpleTestCase):
    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_uses_rightmost_trusted_xff_hop(self) -> None:
        scope = {
            "client": ("10.149.0.135", 12345),
            "headers": [(b"x-forwarded-for", b"198.51.100.7, 203.0.113.25")],
        }

        self.assertEqual(_resolve_gateway_client_ip(scope), "203.0.113.25")

    @override_settings(TRUSTED_PROXY_COUNT=0)
    def test_direct_connection_ignores_spoofed_xff(self) -> None:
        scope = {
            "client": ("198.51.100.20", 12345),
            "headers": [(b"x-forwarded-for", b"203.0.113.99")],
        }

        self.assertEqual(_resolve_gateway_client_ip(scope), "198.51.100.20")

    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_invalid_trusted_hop_falls_back_to_peer_ip(self) -> None:
        scope = {
            "client": ("10.149.0.135", 12345),
            "headers": [(b"x-forwarded-for", b"not-an-ip")],
        }

        self.assertEqual(_resolve_gateway_client_ip(scope), "10.149.0.135")

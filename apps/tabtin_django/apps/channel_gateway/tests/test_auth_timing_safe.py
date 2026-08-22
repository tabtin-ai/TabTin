"""BI-2 / DE-04 回归测试：ChannelGatewayTokenAuth 使用 hmac.compare_digest。"""

from __future__ import annotations

import inspect
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.channel_gateway.auth import ChannelGatewayTokenAuth


class ChannelGatewayTokenAuthTimingSafeTest(SimpleTestCase):
    """确保 token 比较使用 hmac.compare_digest（时序安全）。"""

    def test_uses_hmac_compare_digest(self):
        """源码中应使用 hmac.compare_digest 而非 != 进行 token 比较。"""
        source = inspect.getsource(ChannelGatewayTokenAuth.authenticate)
        self.assertIn("hmac.compare_digest", source)
        self.assertNotIn("token != expected", source)

    @override_settings(CHANNEL_GATEWAY_TOKEN="test-secret-token")
    def test_valid_token_authenticates(self):
        auth = ChannelGatewayTokenAuth()
        request = MagicMock()
        result = auth.authenticate(request, "test-secret-token")
        self.assertEqual(result, {"role": "channel"})

    @override_settings(CHANNEL_GATEWAY_TOKEN="test-secret-token")
    def test_invalid_token_rejected(self):
        auth = ChannelGatewayTokenAuth()
        request = MagicMock()
        result = auth.authenticate(request, "wrong-token")
        self.assertIsNone(result)

    @override_settings(CHANNEL_GATEWAY_TOKEN="")
    def test_empty_expected_token_rejects_all(self):
        auth = ChannelGatewayTokenAuth()
        request = MagicMock()
        result = auth.authenticate(request, "any-token")
        self.assertIsNone(result)

    @override_settings(CHANNEL_GATEWAY_TOKEN="test-secret-token")
    def test_empty_input_token_rejected(self):
        auth = ChannelGatewayTokenAuth()
        request = MagicMock()
        result = auth.authenticate(request, "")
        self.assertIsNone(result)

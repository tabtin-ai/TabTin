"""Daemon install token 校验回归测试。"""
from __future__ import annotations

from django.test import SimpleTestCase, override_settings


@override_settings(DEBUG=True, SECRET_KEY="test-secret")
class VerifyDaemonInstallTokenTests(SimpleTestCase):
    def test_verify_token_rejects_malformed_signature_base64(self):
        from apps.tabtinspace.services.daemon_token_service import _verify_token

        self.assertIsNone(_verify_token("header.payload.z"))

    def test_verify_token_rejects_invalid_expires_at(self):
        from apps.tabtinspace.services.daemon_token_service import _sign_token, _verify_token

        token = _sign_token(
            {
                "organization_id": "wt-1",
                "user_id": "user-1",
                "device_name": "Daemon",
                "expires_at": "not-an-iso-datetime",
                "scope": "device_register",
                "server_url": "http://127.0.0.1:7070",
                "ws_url": "ws://127.0.0.1:7070",
            }
        )

        self.assertIsNone(_verify_token(token))

    def test_verify_token_rejects_missing_required_fields(self):
        from apps.tabtinspace.services.daemon_token_service import _sign_token, _verify_token

        token = _sign_token(
            {
                "organization_id": "wt-1",
                "user_id": "user-1",
                "expires_at": "2099-01-01T00:00:00+00:00",
                "scope": "device_register",
                "server_url": "http://127.0.0.1:7070",
                "ws_url": "ws://127.0.0.1:7070",
            }
        )

        self.assertIsNone(_verify_token(token))

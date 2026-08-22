"""CA-7 残留: JWT_SECRET_KEY 回退模式清理回归测试。

验证：
1. _verify_jwt_for_ws 使用 settings.JWT_SECRET_KEY（不回退到 SECRET_KEY）
2. _generate_daemon_access_token 使用 settings.JWT_SECRET_KEY
"""

from __future__ import annotations

import time
import unittest
from unittest.mock import MagicMock, patch

import jwt as _jwt

from apps.services.common.ws.handlers.auth import _verify_jwt_for_ws
from apps.tabtinspace.services.daemon_token_service import _generate_daemon_access_token


class TestCA7_VerifyJwtUsesJwtSecretKey(unittest.TestCase):
    """CA-7: 验证 _verify_jwt_for_ws 使用 JWT_SECRET_KEY，不回退到 SECRET_KEY。"""

    def test_accepts_token_signed_with_jwt_secret_key(self):
        """使用 JWT_SECRET_KEY 签名的 token 应验证通过。"""
        jwt_secret = "jwt-secret-key-for-ws-auth"
        secret_key = "django-secret-key-different"
        with patch("apps.services.common.ws.handlers.auth.settings") as mock_settings:
            mock_settings.JWT_SECRET_KEY = jwt_secret
            mock_settings.SECRET_KEY = secret_key

            payload = {
                "user_id": "u1",
                "token_type": "access",
                "exp": time.time() + 3600,
                "iat": time.time(),
            }
            token = _jwt.encode(payload, jwt_secret, algorithm="HS256")
            if isinstance(token, bytes):
                token = token.decode("utf-8")

            result_payload, error = _verify_jwt_for_ws(token)
            self.assertIsNone(error, f"JWT_SECRET_KEY 签名的 token 应通过验证，error={error}")
            self.assertEqual(result_payload.get("user_id"), "u1")

    def test_rejects_token_signed_with_secret_key(self):
        """使用 SECRET_KEY 签名的 token 应验证失败（证明未回退到 SECRET_KEY）。"""
        jwt_secret = "jwt-secret-key-for-ws-auth"
        secret_key = "django-secret-key-different"
        with patch("apps.services.common.ws.handlers.auth.settings") as mock_settings:
            mock_settings.JWT_SECRET_KEY = jwt_secret
            mock_settings.SECRET_KEY = secret_key

            payload = {
                "user_id": "u1",
                "token_type": "access",
                "exp": time.time() + 3600,
                "iat": time.time(),
            }
            # 故意用 SECRET_KEY 签名
            token = _jwt.encode(payload, secret_key, algorithm="HS256")
            if isinstance(token, bytes):
                token = token.decode("utf-8")

            result_payload, error = _verify_jwt_for_ws(token)
            self.assertIsNotNone(error, "SECRET_KEY 签名的 token 必须被拒绝")
            self.assertIsNone(result_payload)


class TestCA7_GenerateDaemonTokenUsesJwtSecretKey(unittest.TestCase):
    """CA-7: 验证 _generate_daemon_access_token 使用 JWT_SECRET_KEY。"""

    def test_encode_called_with_jwt_secret_key(self):
        """_pyjwt.encode 必须使用 settings.JWT_SECRET_KEY 作为密钥。"""
        jwt_secret = "jwt-secret-for-daemon-tokens"
        mock_user = MagicMock()
        mock_user.id = "user-123"

        with patch(
            "apps.tabtinspace.services.daemon_token_service._pyjwt.encode"
        ) as mock_encode, patch(
            "apps.tabtinspace.services.daemon_token_service._register_daemon_jti"
        ), patch(
            "apps.tabtinspace.services.daemon_token_service.settings"
        ) as mock_settings:
            mock_settings.JWT_SECRET_KEY = jwt_secret
            mock_encode.return_value = "mock.token.string"

            _generate_daemon_access_token(mock_user, "device-fp-1", expire_hours=24)

            mock_encode.assert_called_once()
            call_args = mock_encode.call_args
            # encode(payload, secret, algorithm=...)
            self.assertEqual(
                call_args[0][1],
                jwt_secret,
                "_generate_daemon_access_token 必须使用 settings.JWT_SECRET_KEY",
            )

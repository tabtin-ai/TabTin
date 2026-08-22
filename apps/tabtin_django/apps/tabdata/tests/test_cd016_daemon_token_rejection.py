"""CD-016 回归测试: OpenApiAuth 必须拒绝 daemon 类型的 token"""

from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase

from apps.tabdata.auth_open_api import OpenApiAuth


class TestCD016DaemonTokenRejection(SimpleTestCase):
    """OpenApiAuth._authenticate_jwt 必须拒绝 daemon 类型 token"""

    @patch("apps.tabdata.auth_open_api.verify_jwt_token")
    def test_daemon_token_rejected(self, mock_verify):
        mock_verify.return_value = {
            "token_type": "daemon",
            "user_id": "some-user-id",
            "sid": "some-session-key",
        }

        auth = OpenApiAuth()
        request = MagicMock()
        result = auth._authenticate_jwt(request, "fake-daemon-token")

        self.assertIsNone(result, "daemon token 不应通过 OpenApiAuth 认证")

    @patch("apps.tabdata.auth_open_api.verify_jwt_token")
    def test_refresh_token_rejected(self, mock_verify):
        mock_verify.return_value = {
            "token_type": "refresh",
            "user_id": "some-user-id",
        }

        auth = OpenApiAuth()
        request = MagicMock()
        result = auth._authenticate_jwt(request, "fake-refresh-token")

        self.assertIsNone(result, "refresh token 不应通过 OpenApiAuth 认证")

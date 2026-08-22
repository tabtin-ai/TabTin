"""CD-005 回归测试：renew_daemon_token 函数正确性。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase


class RenewDaemonTokenTests(SimpleTestCase):
    """验证 renew_daemon_token 的设备归属校验和 token 签发逻辑。"""

    def _make_user(self, user_id="user-1"):
        return SimpleNamespace(id=user_id)

    def _make_device(self, fingerprint="daemon-abc", user_id="user-1", status="online"):
        return SimpleNamespace(
            id="device-uuid-1",
            fingerprint=fingerprint,
            user_id=user_id,
            status=status,
        )

    @patch("apps.tabtinspace.services.daemon_token_service._generate_daemon_access_token")
    @patch("apps.tabtinspace.services.daemon_token_service.revoke_device_tokens")
    @patch("apps.tabtinspace.services.daemon_token_service.Device")
    def test_renew_success_revokes_old_and_issues_new(self, mock_device_model, mock_revoke, mock_generate):
        from apps.tabtinspace.services.daemon_token_service import renew_daemon_token

        user = self._make_user()
        device = self._make_device()
        mock_device_model.objects.get.return_value = device
        mock_generate.return_value = "new-jwt-token"

        result = renew_daemon_token(user, "daemon-abc")

        self.assertEqual(result, "new-jwt-token")
        mock_revoke.assert_called_once_with("daemon-abc")
        mock_generate.assert_called_once_with(user, "daemon-abc", expire_hours=24)

    @patch("apps.tabtinspace.services.daemon_token_service.Device")
    def test_renew_fails_for_nonexistent_device(self, mock_device_model):
        from apps.tabtinspace.services.daemon_token_service import renew_daemon_token
        from apps.tabtinspace.models import Device

        mock_device_model.DoesNotExist = Device.DoesNotExist
        mock_device_model.objects.get.side_effect = Device.DoesNotExist()

        user = self._make_user()
        result = renew_daemon_token(user, "nonexistent-fp")
        self.assertIsNone(result)

    @patch("apps.tabtinspace.services.daemon_token_service.Device")
    def test_renew_fails_for_deleted_device(self, mock_device_model):
        from apps.tabtinspace.services.daemon_token_service import renew_daemon_token

        user = self._make_user()
        device = self._make_device(status="deleted")
        mock_device_model.objects.get.return_value = device

        result = renew_daemon_token(user, "daemon-abc")
        self.assertIsNone(result)

    @patch("apps.tabtinspace.services.daemon_token_service._generate_daemon_access_token")
    @patch("apps.tabtinspace.services.daemon_token_service.revoke_device_tokens")
    @patch("apps.tabtinspace.services.daemon_token_service.Device")
    def test_renew_respects_custom_expire_hours(self, mock_device_model, mock_revoke, mock_generate):
        from apps.tabtinspace.services.daemon_token_service import renew_daemon_token

        user = self._make_user()
        device = self._make_device()
        mock_device_model.objects.get.return_value = device
        mock_generate.return_value = "token-48h"

        renew_daemon_token(user, "daemon-abc", expire_hours=48)

        mock_generate.assert_called_once_with(user, "daemon-abc", expire_hours=48)

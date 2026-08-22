import json
from unittest.mock import patch

from django.test import Client, SimpleTestCase, override_settings


@override_settings(DEBUG=True)
class TestDaemonRoutes(SimpleTestCase):
    def setUp(self):
        self.client = Client()

    def test_activate_route_not_shadowed_by_device_detail(self):
        payload = {
            "token": "invalid.token.value",
            "fingerprint": "daemon-test",
            "device_type": "daemon",
        }

        with (
            patch("apps.tabtinspace.routers.daemon._check_activate_rate_limit", return_value=True),
            patch(
                "apps.tabtinspace.services.daemon_token_service.DaemonTokenService.activate_device",
                return_value={"device_id": "dev-1", "access_token": "token"},
            ) as mock_activate_device,
        ):
            response = self.client.post(
                "/api/context/devices/activate",
                data=json.dumps(payload),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200)
        mock_activate_device.assert_called_once()

    def test_activate_route_returns_403_for_malformed_token(self):
        payload = {
            "token": "x.y.z",
            "fingerprint": "daemon-test",
            "device_type": "daemon",
        }

        with patch("apps.tabtinspace.routers.daemon._check_activate_rate_limit", return_value=True):
            response = self.client.post(
                "/api/context/devices/activate",
                data=json.dumps(payload),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 403)
        self.assertJSONEqual(
            response.content.decode("utf-8"),
            {
                "success": False,
                "code": "INVALID_TOKEN",
                "message": "Token 无效或已过期",
                "data": None,
            },
        )

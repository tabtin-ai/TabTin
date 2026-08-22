from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

TEST_SERVICE_TOKEN = "test-daemon-control-service-token-32"


class _UnavailableCache:
    def get_many(self, keys):
        raise RuntimeError("cache unavailable")


class _ConnectionRedis:
    def __init__(self, values=None, unavailable=False):
        self.values = values or {}
        self.unavailable = unavailable

    def mget(self, keys):
        if self.unavailable:
            raise RuntimeError("redis unavailable")
        return [self.values.get(key) for key in keys]


@override_settings(DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN=TEST_SERVICE_TOKEN)
class DevicePresenceApiTests(SimpleTestCase):
    url = "/internal/daemon-control/v1/device-presence/query"

    @patch(
        "apps.services.daemon_control.api.cache",
        SimpleNamespace(
            get_many=lambda keys: {
                "device_action_ready:online-device": "channel.online",
                "device_action_last_seen:online-device": 1_786_579_200.0,
            }
        ),
    )
    @patch(
        "apps.services.daemon_control.api.get_redis_connection",
        return_value=_ConnectionRedis(),
    )
    def test_reports_runtime_readiness_for_each_installation(self, _connection):
        response = self.client.post(
            self.url,
            data={"installation_ids": ["online-device", "offline-device"]},
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {TEST_SERVICE_TOKEN}",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "success": True,
                "message": "OK",
                "code": 200,
                "data": {
                    "items": [
                        {
                            "installation_id": "online-device",
                            "presence": {
                                "state": 1,
                                "last_seen_at": "2026-08-13T00:00:00Z",
                            },
                        },
                        {
                            "installation_id": "offline-device",
                            "presence": {"state": 2},
                        },
                    ]
                },
            },
        )

    @patch(
        "apps.services.daemon_control.api.cache",
        SimpleNamespace(get_many=lambda keys: {}),
    )
    @patch(
        "apps.services.daemon_control.api.get_redis_connection",
        return_value=_ConnectionRedis({"ws:device_conns:mobile-device": b"1"}),
    )
    def test_reports_controller_device_with_gateway_connection_online(self, _connection):
        response = self.client.post(
            self.url,
            data={"installation_ids": ["mobile-device"]},
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {TEST_SERVICE_TOKEN}",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["data"]["items"][0]["presence"],
            {"state": 1},
        )

    @patch("apps.services.daemon_control.api.cache", _UnavailableCache())
    @patch(
        "apps.services.daemon_control.api.get_redis_connection",
        return_value=_ConnectionRedis(unavailable=True),
    )
    def test_reports_unknown_when_gateway_state_cannot_be_read(self, _connection):
        response = self.client.post(
            self.url,
            data={"installation_ids": ["uncertain-device"]},
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {TEST_SERVICE_TOKEN}",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["data"]["items"],
            [
                {
                    "installation_id": "uncertain-device",
                    "presence": {"state": 3},
                }
            ],
        )

    def test_rejects_requests_without_the_shared_service_token(self):
        response = self.client.post(
            self.url,
            data={"installation_ids": ["online-device"]},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], 401)
        self.assertEqual(response.json()["message"], "Unauthorized")

    def test_rejects_installation_ids_that_cannot_be_gateway_fingerprints(self):
        response = self.client.post(
            self.url,
            data={"installation_ids": ["invalid/device"]},
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {TEST_SERVICE_TOKEN}",
        )

        self.assertEqual(response.status_code, 400)

from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from .client import (
    DaemonControlUnavailable,
    TargetDeviceUnavailable,
    resolve_device,
    resolve_device_by_installation,
    verify_device_credential,
)


TOKEN = "test-daemon-control-service-token-32"
VALID_DEVICE_CREDENTIAL = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
VALID_CREDENTIAL_SHA256 = (
    "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"
)


@override_settings(
    DAEMON_CONTROL_HTTP_ADDR="127.0.0.1:6080",
    DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN=TOKEN,
)
class ResolveDeviceClientTests(SimpleTestCase):
    @patch("apps.services.daemon_control.client.requests.post")
    def test_resolves_device_to_gateway_installation(self, post):
        post.return_value = Mock(
            status_code=200,
            json=lambda: {
                "success": True,
                "data": {
                    "device": {
                        "device_id": "device-1",
                        "owner_user_id": "user-1",
                        "installation_id": "daemon-installation-1",
                    }
                },
            },
        )

        device = resolve_device(owner_user_id="user-1", device_id="device-1")

        self.assertEqual(device["installation_id"], "daemon-installation-1")
        self.assertEqual(
            post.call_args.args[0],
            "http://127.0.0.1:6080/internal/daemon-control/v1/devices/device-1/resolve",
        )
        self.assertEqual(post.call_args.kwargs["json"], {"owner_user_id": "user-1"})
        self.assertEqual(
            post.call_args.kwargs["headers"],
            {"Authorization": f"Bearer {TOKEN}"},
        )
        self.assertFalse(post.call_args.kwargs["allow_redirects"])

    @patch("apps.services.daemon_control.client.requests.post")
    def test_reports_device_that_cannot_accept_work(self, post):
        post.return_value = Mock(status_code=409)

        with self.assertRaises(TargetDeviceUnavailable):
            resolve_device(owner_user_id="user-1", device_id="device-1")

    @patch("apps.services.daemon_control.client.requests.post")
    def test_resolves_workspace_installation_to_control_plane_device(self, post):
        post.return_value = Mock(
            status_code=200,
            json=lambda: {
                "success": True,
                "data": {
                    "device": {
                        "device_id": "device-1",
                        "owner_user_id": "user-1",
                        "installation_id": "electron-installation-1",
                    }
                },
            },
        )

        device = resolve_device_by_installation(
            owner_user_id="user-1",
            installation_id="electron-installation-1",
        )

        self.assertEqual(device["device_id"], "device-1")
        self.assertEqual(
            post.call_args.args[0],
            "http://127.0.0.1:6080/internal/daemon-control/v1/installations/"
            "electron-installation-1/resolve",
        )
        self.assertEqual(post.call_args.kwargs["json"], {"owner_user_id": "user-1"})

    @patch("apps.services.daemon_control.client.requests.post")
    def test_workspace_installation_must_be_active(self, post):
        post.return_value = Mock(status_code=409)

        with self.assertRaises(TargetDeviceUnavailable):
            resolve_device_by_installation(
                owner_user_id="user-1",
                installation_id="electron-installation-1",
            )

    @patch("apps.services.daemon_control.client.requests.post")
    def test_workspace_installation_must_match_owner_and_installation(self, post):
        invalid_devices = (
            {
                "device_id": "device-1",
                "owner_user_id": "another-user",
                "installation_id": "electron-installation-1",
            },
            {
                "device_id": "device-1",
                "owner_user_id": "user-1",
                "installation_id": "another-installation",
            },
        )

        for device in invalid_devices:
            with self.subTest(device=device):
                post.return_value = Mock(
                    status_code=200,
                    json=lambda device=device: {
                        "success": True,
                        "data": {"device": device},
                    },
                )
                with self.assertRaises(DaemonControlUnavailable):
                    resolve_device_by_installation(
                        owner_user_id="user-1",
                        installation_id="electron-installation-1",
                    )

    @override_settings(DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN="")
    def test_fails_closed_without_service_token(self):
        with self.assertRaises(DaemonControlUnavailable):
            resolve_device(owner_user_id="user-1", device_id="device-1")

    @patch("apps.services.daemon_control.client.requests.post")
    def test_verifies_device_credential_without_following_redirects(self, post):
        post.return_value = Mock(
            status_code=200,
            json=lambda: {
                "success": True,
                "data": {
                    "device": {
                        "owner_user_id": "user-1",
                        "installation_id": "electron-installation-1",
                    }
                },
            },
        )

        verified = verify_device_credential(
            owner_user_id="user-1",
            installation_id="electron-installation-1",
            device_credential=VALID_DEVICE_CREDENTIAL,
        )

        self.assertTrue(verified)
        self.assertEqual(
            post.call_args.kwargs["headers"],
            {
                "Authorization": f"Bearer {TOKEN}",
                "X-TabTin-Device-Credential-SHA256": VALID_CREDENTIAL_SHA256,
            },
        )
        self.assertFalse(post.call_args.kwargs["allow_redirects"])

    @patch("apps.services.daemon_control.client.requests.post")
    def test_rejects_invalid_device_credential(self, post):
        for credential in (
            "",
            "too-short",
            "not+base64url/not+base64url/not+base64url",
            VALID_DEVICE_CREDENTIAL + "A",
            f" {VALID_DEVICE_CREDENTIAL}",
        ):
            self.assertFalse(
                verify_device_credential(
                    owner_user_id="user-1",
                    installation_id="electron-installation-1",
                    device_credential=credential,
                )
            )
        post.assert_not_called()

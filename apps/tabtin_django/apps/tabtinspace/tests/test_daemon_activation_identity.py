import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase, override_settings

from apps.tabtinspace.models import Device, Organization
from apps.tabtinspace.services.daemon_token_service import (
    DaemonTokenService,
    DeviceFingerprintConflictError,
)


class DaemonActivationIdentityTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="daemon-activation-owner",
            email="daemon-activation-owner@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name="Daemon activation org",
            owner=self.user,
        )
        self.payload = {
            "organization_id": str(self.organization.id),
            "user_id": str(self.user.id),
            "device_name": "Home Mac",
        }

    @override_settings(DAEMON_CONTROL_ENABLED=False)
    def test_legacy_activation_accepts_a_new_valid_token_for_the_same_device(self):
        service = DaemonTokenService()
        with (
            patch(
                "apps.tabtinspace.services.daemon_token_service._verify_token",
                return_value=self.payload,
            ),
            patch.object(service, "_claim_token", return_value=True),
            patch(
                "apps.tabtinspace.services.daemon_token_service._generate_daemon_access_token",
                return_value="daemon-access-token",
            ),
        ):
            first = service.activate_device("install-token-a", "daemon-home-mac")
            retry = service.activate_device("install-token-a", "daemon-home-mac")
            replacement = service.activate_device("install-token-b", "daemon-home-mac")

        self.assertEqual(first["device_id"], retry["device_id"])
        self.assertEqual(first["device_id"], replacement["device_id"])
        self.assertEqual(Device.objects.filter(fingerprint="daemon-home-mac").count(), 1)

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    def test_enabled_control_plane_keeps_the_original_install_token_binding(self):
        service = DaemonTokenService()
        with (
            patch(
                "apps.tabtinspace.services.daemon_token_service._verify_token",
                return_value=self.payload,
            ),
            patch.object(service, "_claim_token", return_value=True),
            patch(
                "apps.tabtinspace.services.daemon_token_service._generate_daemon_access_token",
                return_value="daemon-access-token",
            ),
        ):
            first = service.activate_device("install-token-a", "daemon-home-mac")
            retry = service.activate_device("install-token-a", "daemon-home-mac")
            with self.assertRaises(DeviceFingerprintConflictError):
                service.activate_device("install-token-b", "daemon-home-mac")

        self.assertEqual(first["device_id"], retry["device_id"])

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    def test_enabled_control_plane_rejects_unbound_legacy_daemon_identity(self):
        Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="Legacy daemon",
            device_type="daemon",
            role="control",
            fingerprint="daemon-legacy",
        )
        service = DaemonTokenService()
        with (
            patch(
                "apps.tabtinspace.services.daemon_token_service._verify_token",
                return_value=self.payload,
            ),
            patch.object(service, "_claim_token", return_value=True),
        ):
            with self.assertRaises(DeviceFingerprintConflictError):
                service.activate_device("new-install-token", "daemon-legacy")


class DaemonTokenRenewCompatibilityTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @patch(
        "apps.tabtinspace.services.device_control_guard.is_device_blocked",
        return_value=False,
    )
    @patch(
        "apps.tabtinspace.services.daemon_token_service.renew_daemon_token",
        return_value="renewed-token",
    )
    def test_legacy_account_token_still_renews_while_rollout_is_disabled(
        self,
        _mock_renew,
        _mock_blocked,
    ):
        from apps.tabtinspace.routers.device import device_token_renew
        from apps.tabtinspace.schemas.device import DeviceTokenRenew

        request = self.factory.post("/api/context/devices/token/renew")
        request.auth = object()
        result = device_token_renew(
            request,
            DeviceTokenRenew(fingerprint="daemon-legacy"),
        )
        self.assertIn("renewed-token", str(result))

    @patch(
        "apps.tabtinspace.services.device_control_guard.is_device_blocked",
        return_value=False,
    )
    def test_daemon_claim_must_match_even_while_rollout_is_disabled(self, _mock_blocked):
        from apps.tabtinspace.routers.device import device_token_renew
        from apps.tabtinspace.schemas.device import DeviceTokenRenew

        request = self.factory.post("/api/context/devices/token/renew")
        request.auth = object()
        request.daemon_device_id = "daemon-other"
        result = device_token_renew(
            request,
            DeviceTokenRenew(fingerprint="daemon-target"),
        )

        self.assertEqual(result.status_code, 401)
        self.assertEqual(json.loads(result.content)["code"], "DEVICE_MISMATCH")

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch(
        "apps.tabtinspace.services.device_control_guard.is_device_blocked",
        return_value=False,
    )
    def test_enabled_control_plane_requires_matching_daemon_claim(self, _mock_blocked):
        from apps.tabtinspace.routers.device import device_token_renew
        from apps.tabtinspace.schemas.device import DeviceTokenRenew

        request = self.factory.post("/api/context/devices/token/renew")
        request.auth = object()
        request.daemon_device_id = "daemon-other"
        result = device_token_renew(
            request,
            DeviceTokenRenew(fingerprint="daemon-target"),
        )
        self.assertEqual(result.status_code, 401)
        self.assertEqual(json.loads(result.content)["code"], "DEVICE_MISMATCH")

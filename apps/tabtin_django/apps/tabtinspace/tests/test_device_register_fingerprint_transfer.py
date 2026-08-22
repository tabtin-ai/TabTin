"""Electron 设备投影的旧注册兼容与控制面身份门禁。"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings

from apps.tabtinspace.models import Device
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.device_service import DeviceService
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token


class DeviceRegisterFingerprintTransferTests(SimpleTestCase):
    @override_settings(DAEMON_CONTROL_ENABLED=True)
    def test_electron_register_rejects_device_owned_by_another_user(self):
        organization_id = uuid.uuid4()
        fingerprint = f"electron-{uuid.uuid4()}"
        user_b = SimpleNamespace(id=uuid.uuid4())
        organization = SimpleNamespace(id=organization_id)
        other_device = SimpleNamespace(
            id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            organization_id=uuid.uuid4(),
            name="Old Mac",
            device_type="electron",
            role="control",
            fingerprint=fingerprint,
            status="offline",
            capabilities=[],
            os_info={},
            save=Mock(),
        )

        other_qs = Mock()
        other_qs.exclude.return_value.select_related.return_value.first.return_value = (
            other_device
        )
        same_user_qs = Mock()
        same_user_qs.select_related.return_value.first.return_value = None

        def filter_side_effect(**kwargs):
            if "user_id" in kwargs:
                return same_user_qs
            return other_qs

        service = DeviceService(user=user_b)

        with self.assertRaises(ServiceError) as raised, patch.object(
            type(service), "check_organization_permission", return_value=True
        ), patch(
            "apps.tabtinspace.services.device_service.Organization.objects.get",
            return_value=organization,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            side_effect=filter_side_effect,
        ):
            service.register_device(
                organization_id=organization_id,
                fingerprint=fingerprint,
                device_type="electron",
                name="New Mac",
                os_info={"os": "darwin"},
                capabilities=["terminal_execute"],
            )

        self.assertEqual(raised.exception.code, "DEVICE_FINGERPRINT_CONFLICT")
        self.assertEqual(raised.exception.status, 409)
        self.assertNotEqual(other_device.user_id, user_b.id)
        other_device.save.assert_not_called()

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    def test_verified_electron_can_repair_a_stale_cross_account_projection(self):
        organization_id = uuid.uuid4()
        fingerprint = f"electron-{uuid.uuid4()}"
        user_b = SimpleNamespace(id=uuid.uuid4())
        organization = SimpleNamespace(id=organization_id)
        other_device = SimpleNamespace(
            id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            organization_id=uuid.uuid4(),
            name="Old Mac",
            device_type="electron",
            role="control",
            fingerprint=fingerprint,
            machine_key="",
            status="offline",
            capabilities=[],
            os_info={},
            save=Mock(),
        )
        other_qs = Mock()
        other_qs.exclude.return_value.select_related.return_value.first.return_value = (
            other_device
        )

        service = DeviceService(user=user_b)
        with patch.object(
            type(service), "check_organization_permission", return_value=True
        ), patch(
            "apps.tabtinspace.services.device_service.Organization.objects.get",
            return_value=organization,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            return_value=other_qs,
        ), patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status",
        ):
            registered = service.register_device(
                organization_id=organization_id,
                fingerprint=fingerprint,
                device_type="electron",
                name="New Mac",
                os_info={"os": "darwin"},
                capabilities=["terminal_execute"],
                identity_verified=True,
            )

        self.assertIs(registered, other_device)
        self.assertEqual(other_device.user_id, user_b.id)
        self.assertEqual(other_device.organization, organization)
        self.assertEqual(other_device.status, "online")
        other_device.save.assert_called_once()


@override_settings(DAEMON_CONTROL_ENABLED=False)
class LegacyDeviceRegisterApiCompatibilityTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.factory = RequestFactory()
        self.old_owner = create_test_user(prefix="legacy_device_old")
        self.new_owner = create_test_user(prefix="legacy_device_new")
        self.old_organization = create_test_organization(
            owner=self.old_owner,
            prefix="legacy_device_old",
        )
        self.new_organization = create_test_organization(
            owner=self.new_owner,
            prefix="legacy_device_new",
        )
        self.fingerprint = f"electron-legacy-transfer-{uuid.uuid4().hex[:8]}"
        self.device = Device.objects.create(
            organization=self.old_organization,
            user=self.old_owner,
            name="Old account Mac",
            device_type="electron",
            role="control",
            fingerprint=self.fingerprint,
            status="offline",
        )
        session_request = self.factory.post(
            "/api/auth/login",
            REMOTE_ADDR="127.0.0.1",
            HTTP_USER_AGENT="legacy-electron",
        )
        session = SessionManager.create_session(
            self.new_owner,
            session_request,
            session_type="desktop",
        )
        self.access_token = generate_jwt_token(
            self.new_owner,
            session_key=session.session_key,
        )

    def test_legacy_register_request_keeps_cross_account_installation_transfer(self):
        response = self._register_device()

        self.assertEqual(response.status_code, 200, response.content)
        self.device.refresh_from_db()
        self.assertEqual(self.device.user_id, self.new_owner.id)
        self.assertEqual(self.device.organization_id, self.new_organization.id)

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    def test_enabled_control_plane_rejects_unverified_legacy_register_request(self):
        response = self._register_device()

        self.assertEqual(response.status_code, 409, response.content)
        self.device.refresh_from_db()
        self.assertEqual(self.device.user_id, self.old_owner.id)
        self.assertEqual(self.device.organization_id, self.old_organization.id)

    def _register_device(self):
        with patch(
            "apps.users.auth.invite_gate_middleware.is_invite_gate_enabled",
            return_value=False,
        ):
            response = self.client.post(
                "/api/context/devices/register",
                data=json.dumps(
                    {
                        "organization_id": str(self.new_organization.id),
                        "fingerprint": self.fingerprint,
                        "device_type": "electron",
                        "name": "New account Mac",
                        "os_info": {"os": "darwin"},
                        "capabilities": ["terminal_execute"],
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {self.access_token}",
            )
        return response

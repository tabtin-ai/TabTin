from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import Client, TestCase, override_settings
from django.urls import path
from django.utils import timezone
from ninja import NinjaAPI

from apps.login_relay.api import router as login_relay_router
from apps.login_relay.models import LoginRelayPackage
from apps.login_relay.timeout_contract import (
    IMPORT_WAIT_TIMEOUT_SECONDS,
    LOGIN_RELAY_PROTOCOL_VERSION,
)
from apps.services.agent_engine.api.action_api import ActionResultSchema
from apps.tabtinspace.models import Device, Organization, SpaceMembership, Workspace
from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption


User = get_user_model()

_test_api = NinjaAPI(title="LoginRelayTestAPI", urls_namespace="login_relay_test")
_test_api.add_router("/login-relay", login_relay_router)
urlpatterns = [path("api/", _test_api.urls)]


def _auth_as(user):
    return patch(
        "apps.users.auth.permissions.JWTAuth.authenticate",
        return_value=user,
    )


@override_settings(ROOT_URLCONF="apps.login_relay.tests")
class LoginRelayApiTests(TestCase):
    def setUp(self):
        self.client = Client()
        suffix = uuid.uuid4().hex[:10]
        self.user = User.objects.create_user(
            username=f"relay_{suffix}",
            email=f"relay_{suffix}@example.com",
            password="test-pass-123",
        )
        self.other_user = User.objects.create_user(
            username=f"relay_other_{suffix}",
            email=f"relay_other_{suffix}@example.com",
            password="test-pass-456",
        )
        invite = RegistrationInviteCode.objects.create(
            code=f"LOGIN-RELAY-{suffix}",
            description="Login relay API tests",
            created_by=self.user,
        )
        RegistrationInviteRedemption.objects.bulk_create([
            RegistrationInviteRedemption(
                invite_code=invite,
                user=self.user,
                entrypoint="test",
            ),
            RegistrationInviteRedemption(
                invite_code=invite,
                user=self.other_user,
                entrypoint="test",
            ),
        ])
        self.organization = Organization.objects.create(
            name="Relay Organization",
            owner=self.user,
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="Relay Mac",
            fingerprint=f"relay-device-{suffix}",
            status="online",
        )
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            name="Relay Workspace",
            working_dir=f"/tmp/relay-{suffix}",
            normalized_working_dir=f"/tmp/relay-{suffix}",
            created_by=self.user,
        )
        SpaceMembership.objects.create(
            workspace=self.workspace,
            user=self.user,
            role="owner",
            is_active=True,
        )
        self.thread_id = f"chat-session-{uuid.uuid4()}"

    def _payload(self, **overrides):
        payload = {
            "space_id": str(self.workspace.id),
            "thread_id": self.thread_id,
            "domain": "login.example.com",
            "cookies": [
                {
                    "name": "session",
                    "value": "cookie-secret-value",
                    "domain": ".example.com",
                    "path": "/",
                    "secure": True,
                    "httpOnly": True,
                    "sameSite": "lax",
                    "expirationDate": timezone.now().timestamp() + 3600,
                }
            ],
        }
        payload.update(overrides)
        return payload

    def _post_create(
        self,
        payload=None,
        *,
        user=None,
        action_service=None,
        device=None,
        protocol_version=None,
    ):
        service = action_service
        if service is None:
            service = MagicMock()
            service.publish_action.return_value = 1
            action_result = ActionResultSchema(
                success=True,
                data={"imported_count": 1},
            )
            service.wait_for_result.return_value = {
                "success": action_result.success,
                "error": action_result.error or None,
                "error_code": action_result.error_code or None,
                "data": action_result.data,
            }
        with (
            _auth_as(user or self.user),
            patch(
                "apps.login_relay.api.resolve_control_device",
                return_value=self.device if device is None else device,
            ),
            patch(
                "apps.login_relay.api.get_frontend_action_service",
                return_value=service,
            ),
        ):
            request_headers = {}
            if protocol_version is not None:
                request_headers["HTTP_X_TABTIN_LOGIN_RELAY_PROTOCOL_VERSION"] = protocol_version
            response = self.client.post(
                "/api/login-relay/packages",
                data=json.dumps(payload or self._payload()),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
                **request_headers,
            )
        return response, service

    def _consume(self, package_id, *, user=None):
        with _auth_as(user or self.user):
            return self.client.post(
                f"/api/login-relay/packages/{package_id}/consume",
                data="{}",
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

    def test_create_dispatches_import_and_returns_import_result_then_consumes_once(self):
        payload = self._payload()
        response, action_service = self._post_create(payload)

        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(body["import_result"], {"success": True, "imported_count": 1})
        package = LoginRelayPackage.objects.get(id=body["package_id"])
        self.assertEqual(package.user, self.user)
        self.assertEqual(package.space, self.workspace)
        action_service.publish_action.assert_called_once()
        thread_id, event = action_service.publish_action.call_args.args[:2]
        self.assertEqual(thread_id, self.thread_id)
        self.assertEqual(event["data"]["type"], "login_relay.import")
        self.assertEqual(
            event["data"]["params"],
            {
                "package_id": str(package.id),
                "space_id": str(self.workspace.id),
                "organization_id": str(self.organization.id),
                "domain": "login.example.com",
            },
        )
        self.assertEqual(
            action_service.publish_action.call_args.kwargs["target_device_fingerprint"],
            self.device.fingerprint,
        )
        action_service.wait_for_result.assert_called_once_with(
            self.thread_id,
            event["data"]["task_id"],
            15,
        )

        first = self._consume(package.id)
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(first.json()["cookies"], payload["cookies"])

        package.refresh_from_db()
        self.assertEqual(package.status, LoginRelayPackage.Status.CONSUMED)
        self.assertEqual(package.encrypted_payload, [])
        self.assertIsNotNone(package.consumed_at)

        second = self._consume(package.id)
        self.assertEqual(second.status_code, 410, second.content)
        self.assertNotIn("cookie-secret-value", second.content.decode())

    def test_create_forwards_target_tab_and_returns_reloaded_result(self):
        service = MagicMock()
        service.publish_action.return_value = 1
        service.wait_for_result.return_value = {
            "success": True,
            "data": {"imported_count": 1, "reloaded": True},
        }

        response, service = self._post_create(
            self._payload(tab_id="view-login-wall"),
            action_service=service,
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["import_result"], {
            "success": True,
            "imported_count": 1,
            "reloaded": True,
        })
        event = service.publish_action.call_args.args[1]
        self.assertEqual(event["data"]["params"]["tab_id"], "view-login-wall")

    def test_payload_is_encrypted_at_rest(self):
        response, _ = self._post_create()
        self.assertEqual(response.status_code, 200, response.content)

        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT encrypted_payload FROM login_relay_package WHERE id = %s",
                [response.json()["package_id"]],
            )
            raw_payload = cursor.fetchone()[0]

        self.assertNotIn("cookie-secret-value", raw_payload)
        self.assertNotIn('"session"', raw_payload)

    def test_expired_package_returns_410_and_clears_payload(self):
        response, _ = self._post_create()
        package_id = response.json()["package_id"]
        LoginRelayPackage.objects.filter(id=package_id).update(
            created_at=timezone.now() - timedelta(seconds=301),
        )

        consumed = self._consume(package_id)

        self.assertEqual(consumed.status_code, 410, consumed.content)
        package = LoginRelayPackage.objects.get(id=package_id)
        self.assertEqual(package.status, LoginRelayPackage.Status.CONSUMED)
        self.assertEqual(package.encrypted_payload, [])

    def test_package_expires_at_exactly_300_seconds(self):
        response, _ = self._post_create()
        package_id = response.json()["package_id"]
        exact_now = timezone.now()
        LoginRelayPackage.objects.filter(id=package_id).update(
            created_at=exact_now - timedelta(seconds=300),
        )

        with patch("apps.login_relay.models.timezone.now", return_value=exact_now):
            consumed = self._consume(package_id)

        self.assertEqual(consumed.status_code, 410, consumed.content)

    def test_wrong_user_cannot_discover_or_consume_package(self):
        response, _ = self._post_create()

        consumed = self._consume(response.json()["package_id"], user=self.other_user)

        self.assertEqual(consumed.status_code, 404, consumed.content)
        self.assertNotIn("cookie-secret-value", consumed.content.decode())

    def test_user_without_space_access_gets_404(self):
        response, _ = self._post_create(user=self.other_user)

        self.assertEqual(response.status_code, 404, response.content)
        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_missing_control_device_returns_409_without_creating_package(self):
        response, _ = self._post_create(device=False)

        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_offline_control_device_returns_409_without_creating_package(self):
        self.device.status = "offline"
        self.device.save(update_fields=["status"])

        response, _ = self._post_create(device=self.device)

        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_control_device_without_fingerprint_returns_409(self):
        device = MagicMock(
            status="online",
            fingerprint="",
            user_id=self.user.id,
            device_type=self.device.device_type,
            role=self.device.role,
            control_status=self.device.control_status,
        )

        response, _ = self._post_create(device=device)

        self.assertEqual(response.status_code, 409, response.content)
        self.assertIn("缺少可用标识", response.content.decode())
        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_control_device_owned_by_another_user_returns_409(self):
        device = MagicMock(
            status="online",
            fingerprint="other-user-device",
            user_id=self.other_user.id,
            device_type=self.device.device_type,
            role=self.device.role,
            control_status=self.device.control_status,
        )

        response, _ = self._post_create(device=device)

        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_rejects_non_control_or_governance_disabled_devices(self):
        role_field = Device._meta.get_field("role")
        control_status_field = Device._meta.get_field("control_status")
        valid_role = role_field.default
        active_control_status = control_status_field.default
        rejected_values = [
            ("role", value)
            for value, _label in role_field.choices
            if value != valid_role
        ] + [
            ("control_status", value)
            for value, _label in control_status_field.choices
            if value != active_control_status
        ]

        for field_name, value in rejected_values:
            with self.subTest(field_name=field_name, value=value):
                setattr(self.device, field_name, value)
                self.device.save(update_fields=[field_name])
                response, service = self._post_create(device=self.device)
                self.assertEqual(response.status_code, 409, response.content)
                service.publish_action.assert_not_called()
                setattr(
                    self.device,
                    field_name,
                    valid_role if field_name == "role" else active_control_status,
                )
                self.device.save(update_fields=[field_name])

        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_rejects_every_non_electron_device_type_including_daemon(self):
        device_type_field = Device._meta.get_field("device_type")
        electron_type = device_type_field.default

        for device_type, _label in device_type_field.choices:
            if device_type == electron_type:
                continue
            with self.subTest(device_type=device_type):
                self.device.device_type = device_type
                self.device.save(update_fields=["device_type"])
                response, service = self._post_create(device=self.device)
                self.assertEqual(response.status_code, 409, response.content)
                service.publish_action.assert_not_called()

        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_publish_failure_returns_safe_failure_and_keeps_package_consumable(self):
        service = MagicMock()
        service.publish_action.return_value = 0

        response, service = self._post_create(action_service=service)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json()["import_result"],
            {"success": False, "error": "publish_failed"},
        )
        service.wait_for_result.assert_not_called()
        package = LoginRelayPackage.objects.get(id=response.json()["package_id"])
        self.assertEqual(package.status, LoginRelayPackage.Status.PENDING)

    def test_wait_timeout_returns_safe_failure_and_keeps_package_consumable(self):
        service = MagicMock()
        service.publish_action.return_value = 1
        service.wait_for_result.return_value = None

        response, _ = self._post_create(action_service=service)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json()["import_result"],
            {"success": False, "error": "timeout"},
        )
        package = LoginRelayPackage.objects.get(id=response.json()["package_id"])
        self.assertEqual(package.status, LoginRelayPackage.Status.PENDING)

    def test_old_client_without_protocol_header_keeps_the_frozen_v1_wait_cap(self):
        service = MagicMock()
        service.publish_action.return_value = 1
        service.wait_for_result.return_value = {"success": True, "data": {"imported_count": 0}}

        with patch("apps.login_relay.api.IMPORT_WAIT_TIMEOUT_SECONDS", 30):
            response, service = self._post_create(action_service=service)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(service.wait_for_result.call_args.args[2], 15)

    def test_explicit_v1_protocol_keeps_the_frozen_wait_cap(self):
        service = MagicMock()
        service.publish_action.return_value = 1
        service.wait_for_result.return_value = {"success": True, "data": {"imported_count": 0}}

        with patch("apps.login_relay.api.IMPORT_WAIT_TIMEOUT_SECONDS", 30):
            response, service = self._post_create(
                action_service=service,
                protocol_version="v1",
            )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(service.wait_for_result.call_args.args[2], 15)

    def test_current_protocol_uses_the_shared_cross_runtime_contract_window(self):
        service = MagicMock()
        service.publish_action.return_value = 1
        service.wait_for_result.return_value = {"success": True, "data": {"imported_count": 0}}

        response, service = self._post_create(
            action_service=service,
            protocol_version=LOGIN_RELAY_PROTOCOL_VERSION,
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(service.wait_for_result.call_args.args[2], IMPORT_WAIT_TIMEOUT_SECONDS)

    def test_import_failure_is_normalized_without_leaking_sensitive_details(self):
        service = MagicMock()
        service.publish_action.return_value = 1
        service.wait_for_result.return_value = {
            "success": False,
            "error": "cookie-secret-value internal stack trace",
        }

        response, _ = self._post_create(action_service=service)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json()["import_result"],
            {"success": False, "error": "import_failed"},
        )
        self.assertNotIn("cookie-secret-value", response.content.decode())

    def test_import_failure_preserves_only_the_whitelisted_safe_error_code(self):
        service = MagicMock()
        service.publish_action.return_value = 1
        service.wait_for_result.return_value = {
            "success": False,
            "error": "cookie-secret-value internal stack trace",
            "error_code": "cookie_write_failed",
        }

        response, _ = self._post_create(action_service=service)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json()["import_result"],
            {
                "success": False,
                "error": "import_failed",
                "error_code": "cookie_write_failed",
            },
        )
        self.assertNotIn("cookie-secret-value", response.content.decode())

    def test_rejects_thread_id_not_accepted_by_action_result_handler(self):
        response, service = self._post_create(
            self._payload(thread_id="arbitrary-thread"),
        )

        self.assertEqual(response.status_code, 422, response.content)
        service.publish_action.assert_not_called()
        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_rejects_idn_whose_punycode_exceeds_dns_total_length(self):
        unicode_label = "é" * 20
        oversized_after_idna = ".".join([unicode_label] * 10)
        cookie = {
            **self._payload()["cookies"][0],
            "domain": oversized_after_idna,
        }

        response, service = self._post_create(
            self._payload(domain=oversized_after_idna, cookies=[cookie]),
        )

        self.assertEqual(response.status_code, 422, response.content)
        service.publish_action.assert_not_called()
        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_relay_payload_limit_counts_compact_json_utf8_bytes(self):
        multibyte_cookies = [
            {
                "name": f"cookie-{index}",
                "value": "😀" * 1024,
                "domain": ".example.com",
                "path": "/",
                "secure": True,
                "httpOnly": True,
            }
            for index in range(64)
        ]

        response, service = self._post_create(
            self._payload(cookies=multibyte_cookies),
        )

        self.assertEqual(response.status_code, 422, response.content)
        service.publish_action.assert_not_called()
        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_rejects_payload_boundaries_and_cross_domain_cookies(self):
        invalid_payloads = [
            self._payload(cookies=[]),
            self._payload(cookies=self._payload()["cookies"] * 101),
            self._payload(domain="https://example.com/login"),
            self._payload(
                cookies=[
                    {
                        **self._payload()["cookies"][0],
                        "domain": ".not-example.com",
                    }
                ]
            ),
            self._payload(
                cookies=[
                    {
                        **self._payload()["cookies"][0],
                        "name": "",
                    }
                ]
            ),
            self._payload(
                cookies=[
                    {
                        **self._payload()["cookies"][0],
                        "value": "x" * 4097,
                    }
                ]
            ),
        ]

        for payload in invalid_payloads:
            with self.subTest(payload_domain=payload["domain"], cookie_count=len(payload["cookies"])):
                response, _ = self._post_create(payload)
                self.assertEqual(response.status_code, 422, response.content)

        self.assertEqual(LoginRelayPackage.objects.count(), 0)

    def test_atomic_claim_returns_sensitive_payload_only_once(self):
        expected_cookies = self._payload()["cookies"]
        package = LoginRelayPackage.objects.create(
            user=self.user,
            space=self.workspace,
            target_device=self.device,
            domain="example.com",
            encrypted_payload=expected_cookies,
        )
        from apps.login_relay.api import claim_package_payload

        # TestCase's outer transaction adds SAVEPOINT/RELEASE around each
        # explicit atomic block: claim = lock/read + update, retry = lock/read.
        with self.assertNumQueries(4):
            first = claim_package_payload(package_id=package.id, user=self.user)
        with self.assertNumQueries(3):
            second = claim_package_payload(package_id=package.id, user=self.user)

        self.assertIsNotNone(first)
        self.assertEqual(first.cookies, expected_cookies)
        self.assertIsNone(second)

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.services.common.ws.handlers.auth import create_auth_handler
from apps.services.common.ws.organization_context import OrganizationContext
from apps.services.common.ws.handlers.subscription_validators import (
    AgentActionDeviceValidator,
)


def _consumer():
    consumer = MagicMock()
    consumer.authed = False
    consumer.user = None
    consumer.user_id = None
    consumer.organization_ctx = OrganizationContext(None, set())
    consumer.role = None
    consumer.device_fingerprint = None
    consumer.connection_scope = None
    consumer.capabilities = set()
    consumer._send_error = AsyncMock()
    consumer._send_envelope = AsyncMock()
    consumer._increment_connection_count = AsyncMock(return_value=True)
    consumer._increment_device_conn_count = AsyncMock()
    consumer._join_group = AsyncMock()
    consumer._start_heartbeat = AsyncMock()
    consumer._mark_runtime_snapshot_connected = AsyncMock()
    consumer._cancel_auth_timeout = MagicMock()
    consumer._extend_auth_handler = MagicMock()
    consumer._auto_join_update_group = AsyncMock()
    consumer.scope = {"client": ("127.0.0.1", 12345)}
    consumer.channel_name = "credential-auth-channel"
    consumer.joined_groups = set()
    return consumer


@override_settings(DAEMON_CONTROL_ENABLED=True)
class DeviceCredentialAuthTests(SimpleTestCase):
    @override_settings(DAEMON_CONTROL_ENABLED=False)
    async def test_legacy_electron_without_credential_keeps_execution_route(self):
        consumer = _consumer()
        envelope = {
            "payload": {
                "access_token": "access-token",
                "organization_id": "org-1",
                "capabilities": ["agent.action"],
            },
            "request_id": "request-1",
            "role": "electron",
            "device_id": "electron-legacy",
        }
        user = SimpleNamespace(id="user-1", is_active=True)
        ensure_registered = AsyncMock(return_value=True)
        update_status = AsyncMock()

        with (
            patch(
                "apps.services.common.ws.handlers.auth._daemon_control_enabled_for_connection",
                new=AsyncMock(return_value=False),
            ),
            patch(
                "apps.services.common.ws.handlers.auth._verify_jwt_for_ws",
                return_value=(
                    {
                        "user_id": "user-1",
                        "token_type": "access",
                        "sid": "session-1",
                    },
                    None,
                ),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.database_sync_to_async",
                side_effect=lambda fn: AsyncMock(side_effect=fn),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.User.objects.get",
                return_value=user,
            ),
            patch(
                "apps.services.common.ws.handlers.auth.SessionManager.validate_session",
                return_value=SimpleNamespace(user_id="user-1"),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.OrganizationService.check_organization_permission",
                return_value=True,
            ),
            patch(
                "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
                new=AsyncMock(return_value={"org-1"}),
            ),
            patch(
                "apps.services.common.ws.handlers.auth._ensure_electron_device_registered",
                new=ensure_registered,
            ),
            patch(
                "apps.services.common.ws.handlers.auth._update_device_status",
                new=update_status,
            ),
        ):
            await create_auth_handler(consumer)(envelope)

        self.assertTrue(consumer.authed)
        self.assertTrue(consumer.device_identity_verified)
        ensure_registered.assert_awaited_once()
        update_status.assert_awaited_once()
        consumer._increment_device_conn_count.assert_awaited_once()
        with patch(
            "apps.services.common.ws.handlers.subscription_validators._verify_device_ownership",
            new=AsyncMock(return_value=True),
        ):
            error = await AgentActionDeviceValidator().validate(
                consumer,
                "agent.action.device.electron-legacy",
                ["agent", "action", "device.electron-legacy"],
            )
        self.assertIsNone(error)

    async def test_verified_credential_marks_electron_execution_identity(self):
        consumer = _consumer()
        envelope = {
            "payload": {
                "access_token": "access-token",
                "organization_id": "org-1",
                "capabilities": ["agent.action"],
                "device_credential": "c" * 43,
                "device": {"name": "Home Mac"},
            },
            "request_id": "request-1",
            "role": "electron",
            "device_id": "electron-home-mac",
        }
        user = SimpleNamespace(id="user-1", is_active=True)

        with (
            patch(
                "apps.services.common.ws.handlers.auth._daemon_control_enabled_for_connection",
                new=AsyncMock(return_value=True),
            ),
            patch(
                "apps.services.common.ws.handlers.auth._verify_jwt_for_ws",
                return_value=(
                    {
                        "user_id": "user-1",
                        "token_type": "access",
                        "sid": "session-1",
                    },
                    None,
                ),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.database_sync_to_async",
                side_effect=lambda fn: AsyncMock(side_effect=fn),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.User.objects.get",
                return_value=user,
            ),
            patch(
                "apps.services.common.ws.handlers.auth.SessionManager.validate_session",
                return_value=SimpleNamespace(user_id="user-1"),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.OrganizationService.check_organization_permission",
                return_value=True,
            ),
            patch(
                "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
                new=AsyncMock(return_value={"org-1"}),
            ),
            patch(
                "apps.services.common.ws.handlers.auth._ensure_electron_device_registered",
                new=AsyncMock(return_value=True),
            ),
            patch(
                "apps.services.common.ws.handlers.auth._update_device_status",
                new=AsyncMock(),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.run_sync_io",
                new=AsyncMock(return_value=True),
            ) as run_sync,
        ):
            await create_auth_handler(consumer)(envelope)

        self.assertTrue(consumer.authed)
        self.assertTrue(consumer.device_identity_verified)
        run_sync.assert_awaited_once()
        self.assertEqual(run_sync.await_args.kwargs["installation_id"], "electron-home-mac")
        consumer._send_error.assert_not_awaited()

    async def test_unverified_electron_cannot_claim_legacy_device_projection(self):
        consumer = _consumer()
        envelope = {
            "payload": {
                "access_token": "access-token",
                "organization_id": "org-1",
                "capabilities": ["agent.action"],
            },
            "request_id": "request-1",
            "role": "electron",
            "device_id": "electron-victim",
        }
        user = SimpleNamespace(id="user-1", is_active=True)
        ensure_registered = AsyncMock(return_value=True)
        update_status = AsyncMock()

        with (
            patch(
                "apps.services.common.ws.handlers.auth._daemon_control_enabled_for_connection",
                new=AsyncMock(return_value=True),
            ),
            patch(
                "apps.services.common.ws.handlers.auth._verify_jwt_for_ws",
                return_value=(
                    {
                        "user_id": "user-1",
                        "token_type": "access",
                        "sid": "session-1",
                    },
                    None,
                ),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.database_sync_to_async",
                side_effect=lambda fn: AsyncMock(side_effect=fn),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.User.objects.get",
                return_value=user,
            ),
            patch(
                "apps.services.common.ws.handlers.auth.SessionManager.validate_session",
                return_value=SimpleNamespace(user_id="user-1"),
            ),
            patch(
                "apps.services.common.ws.handlers.auth.OrganizationService.check_organization_permission",
                return_value=True,
            ),
            patch(
                "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
                new=AsyncMock(return_value={"org-1"}),
            ),
            patch(
                "apps.services.common.ws.handlers.auth._ensure_electron_device_registered",
                new=ensure_registered,
            ),
            patch(
                "apps.services.common.ws.handlers.auth._update_device_status",
                new=update_status,
            ),
        ):
            await create_auth_handler(consumer)(envelope)

        self.assertTrue(consumer.authed)
        self.assertFalse(consumer.device_identity_verified)
        ensure_registered.assert_not_awaited()
        update_status.assert_not_awaited()
        consumer._increment_device_conn_count.assert_not_awaited()
        consumer._send_error.assert_not_awaited()

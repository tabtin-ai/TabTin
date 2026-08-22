from __future__ import annotations

from datetime import datetime, timezone as dt_tz
from types import SimpleNamespace
from uuid import UUID
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase
from pydantic import ValidationError

from apps.channel_gateway.api import create_binding, list_bindings, update_binding
from apps.channel_gateway.api_schemas import ChannelBindingCreateRequest, ChannelBindingUpdateRequest


def _request():
    return SimpleNamespace(auth=SimpleNamespace(id="user_1"))


def _binding_obj():
    now = datetime.now(dt_tz.utc)
    binding = SimpleNamespace(
        id="binding_1",
        channel="telegram",
        account_id="default",
        peer_kind="dm",
        peer_id="peer_1",
        organization_id="ws_1",
        identity_user_id="user_1",
        execution_agent_id="agent_old",
        handling_space_id=None,
        space_id=None,
        session_id=str(UUID("11111111-1111-1111-1111-111111111111")),
        thread_id="chat-session-old",
        status="active",
        last_message_id=None,
        created_at=now,
        updated_at=now,
        metadata=None,
    )
    binding.save = MagicMock()
    return binding


class ChannelBindingApiTests(SimpleTestCase):
    def test_update_schema_rejects_conflicting_session_options(self):
        with self.assertRaises(ValidationError):
            ChannelBindingUpdateRequest(
                session_id="33333333-3333-3333-3333-333333333333",
                create_new_session=True,
            )

    def test_create_schema_rejects_invalid_status(self):
        with self.assertRaises(ValidationError):
            ChannelBindingCreateRequest(
                channel="telegram",
                peer_kind="dm",
                peer_id="peer_1",
                organization_id="ws_1",
                status="invalid",
            )

    def test_create_schema_preserves_execution_agent_id(self):
        data = ChannelBindingCreateRequest(
            channel="telegram",
            peer_kind="dm",
            peer_id="peer_1",
            organization_id="ws_1",
            execution_agent_id="agent_exec",
        )

        self.assertEqual(data.execution_agent_id, "agent_exec")

    @patch("apps.channel_gateway.api.ChannelBindingService")
    @patch("apps.channel_gateway.api._ensure_organization_permission")
    @patch("apps.channel_gateway.api.ChannelBinding")
    def test_create_binding_conflict_returns_409(self, mock_binding_model, _permission, mock_service_cls):
        from django.db import IntegrityError

        organization = SimpleNamespace(id="ws_1")
        session = SimpleNamespace(
            id=UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            thread_id="chat-session-aaaa",
            space_id=None,
        )

        service = mock_service_cls.return_value
        service.ensure_organization.return_value = organization
        service.resolve_space.return_value = None
        service.resolve_identity_user.return_value = SimpleNamespace(id="user_1")
        service.create_session.return_value = session
        service.sync_session_space.return_value = None
        mock_binding_model.objects.create.side_effect = IntegrityError("duplicate key")

        data = ChannelBindingCreateRequest(
            channel="telegram",
            account_id="default",
            peer_kind="dm",
            peer_id="peer_1",
            organization_id="ws_1",
        )

        result = create_binding(_request(), data)
        status_code, body = result
        self.assertEqual(status_code, 409)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "CONFLICT")

    @patch("apps.channel_gateway.api.ChannelBindingService")
    @patch("apps.channel_gateway.api._ensure_organization_permission")
    @patch("apps.channel_gateway.api.ChannelBinding")
    def test_update_binding_create_new_session(self, mock_binding_model, _permission, mock_service_cls):
        binding = _binding_obj()
        mock_binding_model.objects.filter.return_value.first.return_value = binding

        service = mock_service_cls.return_value
        space = SimpleNamespace(id="space_new")
        session = SimpleNamespace(
            id=str(UUID("22222222-2222-2222-2222-222222222222")),
            thread_id="chat-session-2222",
            space_id="space_new",
            user_id="user_1",
        )
        service.resolve_space.return_value = space
        service.ensure_organization.return_value = SimpleNamespace(id="ws_1")
        service.resolve_identity_user.return_value = SimpleNamespace(id="user_1")
        service.create_session.return_value = session

        data = ChannelBindingUpdateRequest(space_id="space_new", create_new_session=True)
        result = update_binding(_request(), "binding_1", data)

        self.assertTrue(result["success"])
        self.assertEqual(binding.space_id, "space_new")
        self.assertEqual(binding.session_id, session.id)
        self.assertEqual(binding.thread_id, session.thread_id)
        binding.save.assert_called_once()
        service.create_session.assert_called_once()
        service.sync_session_space.assert_called_once_with(session, space)

    @patch("apps.channel_gateway.api.ChannelBindingService")
    @patch("apps.channel_gateway.api._ensure_organization_permission")
    @patch("apps.channel_gateway.api.ChannelBinding")
    def test_update_binding_conflict_returns_409(self, mock_binding_model, _permission, mock_service_cls):
        binding = _binding_obj()
        binding.save.side_effect = Exception("should be replaced")
        mock_binding_model.objects.filter.return_value.first.return_value = binding

        from django.db import IntegrityError
        binding.save.side_effect = IntegrityError("duplicate key")

        service = mock_service_cls.return_value
        service.resolve_space.return_value = None
        service.ensure_session.return_value = SimpleNamespace(
            id=UUID("11111111-1111-1111-1111-111111111111"),
            thread_id="chat-session-old",
            space_id=None,
            user_id="user_1",
        )

        data = ChannelBindingUpdateRequest(status="paused")
        result = update_binding(_request(), "binding_1", data)
        status_code, body = result
        self.assertEqual(status_code, 409)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "CONFLICT")

    @patch("apps.channel_gateway.api.ChannelBindingService")
    @patch("apps.channel_gateway.api._ensure_organization_permission")
    @patch("apps.channel_gateway.api.ChannelBinding")
    def test_update_binding_follow_session_space(self, mock_binding_model, _permission, mock_service_cls):
        binding = _binding_obj()
        mock_binding_model.objects.filter.return_value.first.return_value = binding

        service = mock_service_cls.return_value
        session = SimpleNamespace(
            id=str(UUID("33333333-3333-3333-3333-333333333333")),
            thread_id="chat-session-3333",
            space_id="space_from_session",
            user_id="user_1",
        )
        space = SimpleNamespace(id="space_from_session")
        service.ensure_session.return_value = session
        service.resolve_space.return_value = space

        data = ChannelBindingUpdateRequest(session_id="33333333-3333-3333-3333-333333333333")
        result = update_binding(_request(), "binding_1", data)

        self.assertTrue(result["success"])
        self.assertEqual(binding.space_id, "space_from_session")
        self.assertEqual(binding.session_id, session.id)
        self.assertEqual(binding.thread_id, session.thread_id)
        binding.save.assert_called_once()
        service.sync_session_space.assert_called_once_with(session, space)

    @patch("apps.channel_gateway.api._ensure_organization_permission")
    @patch("apps.channel_gateway.api.ChannelBinding")
    def test_list_bindings_invalid_session_id(self, mock_binding_model, _permission):
        mock_binding_model.objects.filter.return_value = MagicMock()

        result = list_bindings(
            _request(),
            organization_id="ws_1",
            session_id="not-a-uuid",
        )
        status_code, body = result
        self.assertEqual(status_code, 400)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")

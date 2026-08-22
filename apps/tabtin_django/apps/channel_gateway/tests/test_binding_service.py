from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch, MagicMock
from uuid import uuid4

from django.test import SimpleTestCase, TestCase

from apps.channel_gateway.api_schemas import ChannelBindingSchema
from apps.channel_gateway.services.binding_service import ChannelBindingService
from apps.tabtinspace.models import Project, Workspace


class _DummySession:
    def __init__(self, session_id: str, thread_id: str | None, workspace_id: str | None, context=None):
        self.id = session_id
        self.pk = session_id
        self.thread_id = thread_id
        self.workspace_id = workspace_id
        self.workspace = None
        self.project_id = None
        self.project = None
        self.context = context
        self.saved_update_fields = None

    def save(self, *, update_fields):
        self.saved_update_fields = list(update_fields)
        if self.workspace is not None:
            self.workspace_id = str(self.workspace.id)
        elif self.workspace is None and "workspace" in update_fields:
            self.workspace_id = None
        if self.project is not None:
            self.project_id = str(self.project.id)
        elif "project" in update_fields:
            self.project_id = None


class _DummyContext:
    def __init__(self, current_space_id: str, current_project_id: str | None = None):
        self.current_space_id = current_space_id
        self.current_project_id = current_project_id
        self.current_project = None
        self.saved_update_fields = None

    def save(self, *, update_fields):
        self.saved_update_fields = list(update_fields)
        if self.current_project is not None:
            self.current_project_id = str(self.current_project.id)
        elif "current_project" in update_fields:
            self.current_project_id = None


class ChannelBindingServiceTests(SimpleTestCase):
    def setUp(self):
        self.service = ChannelBindingService(organization_id="ws_123")

    def test_ensure_thread_id_sets_default_when_missing(self):
        session = _DummySession(session_id="abc123", thread_id=None, workspace_id=None)
        self.service.ensure_thread_id(session)

        self.assertEqual(session.thread_id, "chat-session-abc123")
        self.assertEqual(session.saved_update_fields, ["thread_id"])

    def test_sync_session_space_updates_workspace_when_host_is_workspace(self):
        old_ws = str(uuid4())
        new_ws = str(uuid4())
        # 预置 context，避免 sync 走 ChatContext.get_or_create（本测只验 workspace FK）
        context = _DummyContext(current_space_id=new_ws)
        session = _DummySession(
            session_id="abc123",
            thread_id="chat-session-abc123",
            workspace_id=old_ws,
            context=context,
        )
        target_workspace = Workspace(id=new_ws)

        self.service.sync_session_space(session, target_workspace)

        self.assertEqual(session.workspace_id, new_ws)
        self.assertEqual(session.saved_update_fields, ["workspace", "updated_at"])

    def test_sync_session_space_skips_session_when_same_workspace(self):
        same_ws = str(uuid4())
        context = _DummyContext(current_space_id=same_ws)
        session = _DummySession(
            session_id="abc123",
            thread_id="chat-session-abc123",
            workspace_id=same_ws,
            context=context,
        )
        target_workspace = Workspace(id=same_ws)

        self.service.sync_session_space(session, target_workspace)

        self.assertIsNone(session.saved_update_fields)

    def test_sync_session_space_updates_context_for_non_workspace_host(self):
        context = _DummyContext(current_space_id="old_space")
        session = _DummySession(
            session_id="abc123",
            thread_id="chat-session-abc123",
            workspace_id="exec_ws",
            context=context,
        )
        # Project / handling host：只同步 ChatContext，不改写 workspace FK。
        target_space = SimpleNamespace(id="same_space")

        self.service.sync_session_space(session, target_space)

        self.assertIsNone(session.saved_update_fields)
        self.assertEqual(session.workspace_id, "exec_ws")
        self.assertEqual(context.current_space_id, "same_space")
        self.assertEqual(context.saved_update_fields, ["current_space_id", "updated_at"])

    def test_sync_session_space_separates_project_from_resource_host(self):
        project_id = str(uuid4())
        context = _DummyContext(current_space_id="resource-host")
        session = _DummySession(
            session_id="abc123",
            thread_id="chat-session-abc123",
            workspace_id="exec_ws",
            context=context,
        )
        project = Project(id=project_id)

        self.service.sync_session_space(session, project)

        self.assertEqual(session.workspace_id, "exec_ws")
        self.assertEqual(session.project_id, project_id)
        self.assertEqual(context.current_space_id, "resource-host")
        self.assertEqual(context.current_project_id, project_id)
        self.assertIs(context.current_project, project)
        self.assertEqual(context.saved_update_fields, ["current_project", "updated_at"])

    @patch("apps.channel_gateway.services.binding_service.ChatSession.objects.create")
    @patch("apps.channel_gateway.services.binding_service.LLMModel.objects.filter")
    def test_create_session_syncs_space_context(self, mock_filter, mock_create):
        model_qs = MagicMock()
        model_qs.first.return_value = MagicMock()
        mock_filter.return_value = model_qs
        session = _DummySession(
            session_id="abc123",
            thread_id="chat-session-abc123",
            workspace_id="ws_1",
        )
        mock_create.return_value = session
        identity_user = SimpleNamespace(id="user_1")
        organization = SimpleNamespace(id="ws_123", owner=SimpleNamespace())
        space = SimpleNamespace(id="space_1")
        agent = SimpleNamespace(id="agent_1")
        workspace = SimpleNamespace(id="ws_1")

        with patch.object(self.service, "ensure_thread_id") as ensure_thread_id, \
             patch.object(self.service, "sync_session_space") as sync_session_space, \
             patch("apps.tabtinspace.models.Agent.objects.filter") as agent_filter, \
             patch("apps.tabtinspace.models.Workspace.objects.filter") as workspace_filter, \
             patch(
                 "apps.services.llm.services.capability_guard.apply_chat_model_filter",
                 side_effect=lambda qs: qs,
             ):
            agent_filter.return_value.first.return_value = agent
            workspace_filter.return_value.first.return_value = workspace
            created = self.service.create_session(
                organization,
                space,
                identity_user=identity_user,
                agent_id="agent_1",
                workspace_id="ws_1",
            )

        self.assertIs(created, session)
        ensure_thread_id.assert_called_once_with(session)
        sync_session_space.assert_called_once_with(session, space)
        _, kwargs = mock_create.call_args
        self.assertNotIn("space_id", kwargs)
        self.assertIs(kwargs.get("workspace"), workspace)


class ChannelBindingSchemaTests(SimpleTestCase):
    def test_space_id_reads_from_space_id_attribute(self):
        now = datetime.now()
        binding = SimpleNamespace(
            id="binding_1",
            channel="telegram",
            account_id="default",
            peer_kind="dm",
            peer_id="peer_1",
            organization_id="ws_1",
            space_id="space_1",
            session_id="session_1",
            thread_id="thread_1",
            execution_agent_id=None,
            status="active",
            last_message_id="msg_1",
            created_at=now,
            updated_at=now,
        )

        payload = ChannelBindingSchema.model_validate(binding, from_attributes=True)

        self.assertEqual(payload.space_id, "space_1")
        self.assertEqual(payload.handling_space_id, "space_1")


class GetBindingRoutingTests(TestCase):
    def test_returns_routing_when_present(self):
        from apps.channel_gateway.models import ChannelBinding

        ChannelBinding.objects.create(
            channel="dingtalk",
            account_id="acc_1",
            peer_id="peer_1",
            organization_id="ws_1",
            peer_kind="dm",
            status="active",
            metadata={"_routing": {"conversation_type": "1", "sender_staff_id": "u1"}},
        )
        result = ChannelBindingService.get_binding_routing("dingtalk", "acc_1", "peer_1", "ws_1")
        self.assertEqual(result, {"conversation_type": "1", "sender_staff_id": "u1"})

    def test_returns_none_when_no_binding(self):
        result = ChannelBindingService.get_binding_routing("dingtalk", "acc_x", "peer_x", "ws_x")
        self.assertIsNone(result)

    def test_returns_none_when_no_routing_key(self):
        from apps.channel_gateway.models import ChannelBinding

        ChannelBinding.objects.create(
            channel="dingtalk",
            account_id="acc_2",
            peer_id="peer_2",
            organization_id="ws_2",
            peer_kind="dm",
            status="active",
            metadata={"some_key": "value"},
        )
        result = ChannelBindingService.get_binding_routing("dingtalk", "acc_2", "peer_2", "ws_2")
        self.assertIsNone(result)

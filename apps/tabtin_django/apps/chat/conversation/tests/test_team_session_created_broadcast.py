"""Project create_session privacy regressions."""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase, override_settings

from apps.chat.conversation.api.session import create_session, list_sessions, quick_start_session, update_session
from apps.chat.conversation.models import ChatContext, ChatSession
from apps.chat.conversation.schemas import CreateSessionRequest, QuickStartSessionRequest, UpdateSessionRequest
from apps.services.llm.api_common import _write_user_default_model_id
from apps.services.llm.models import LLMModel, LLMProvider
from apps.tabtinspace.models import (
    Agent,
    Device,
    Space,
    SpaceMembership,
    Organization,
    OrganizationMember,
    Workspace,

    Project,
    ProjectMembership,)

User = get_user_model()


def _make_exec_workspace(organization, user, name="Owner Workspace", fingerprint=None):
    from apps.tabtinspace.models import Device, Workspace
    fp = fingerprint or f"exec-{organization.id}-{user.id}"
    device = Device.objects.create(
        organization=organization,
        user=user,
        name=f"{name} Device",
        device_type="electron",
        role="control",
        fingerprint=fp,
        status="online",
    )
    return Workspace.objects.create(
        organization=organization,
        device=device,
        created_by=user,
        name=name,
        working_dir=f"/tmp/{fp}",
        normalized_working_dir=f"/tmp/{fp}",
        kind=Workspace.Kind.STANDARD,
    )


def _make_project(organization, name="Team Room", visibility="private"):
    from apps.tabtinspace.models import Project
    return Project.objects.create(
        organization=organization,
        name=name,
        status=Project.Status.ACTIVE,
        visibility=visibility,
    )


def _pm(project, user, role="owner"):
    from apps.tabtinspace.models import ProjectMembership
    return ProjectMembership.objects.create(
        project=project,
        user=user,
        role=role,
        is_active=True,
        status=ProjectMembership.Status.ACTIVE,
    )


def _sm(workspace, user, role="owner"):
    from apps.tabtinspace.models import SpaceMembership
    return SpaceMembership.objects.create(
        workspace=workspace,
        user=user,
        role=role,
        is_active=True,
    )


@override_settings(DAEMON_CONTROL_ENABLED=True)
class TeamSessionCreatedBroadcastTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.feature_patch = patch(
            "apps.platform_config.services.PlatformRuntimeConfigService.evaluate_feature",
            return_value=SimpleNamespace(enabled=True),
        )
        self.feature_patch.start()
        self.addCleanup(self.feature_patch.stop)
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="team_session_created_owner",
            email="team_session_created_owner@test.com",
            password="pass123",
        )
        self.member = User.objects.create_user(
            username="team_session_created_member",
            email="team_session_created_member@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="Team Session Created",
            owner=self.owner,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.member, role="editor")
        self.execution_space = _make_exec_workspace(self.organization, self.owner, name="Owner Workspace")
        self.team_space = _make_project(self.organization, name="Team Room", visibility="shared")
        _pm(self.team_space, self.owner, role="owner")
        _pm(self.team_space, self.member, role="editor")
        _sm(self.execution_space, self.owner, role="owner")
        self.bindings = {}
        for label, user in (("owner", self.owner), ("member", self.member)):
            device = Device.objects.create(
                organization=self.organization,
                user=user,
                name=f"{label} device",
                device_type="electron",
                role="control",
                fingerprint=f"team-session-{label}",
                status="online",
            )
            agent = Agent.objects.create(
                organization=self.organization,
                owner_user=user,
                name=f"{label} agent",
                type="bot",
            )
            workspace = Workspace.objects.create(
                organization=self.organization,
                device=device,
                created_by=user,
                name=f"{label} workspace",
                working_dir=f"/Users/{label}/project",
                normalized_working_dir=f"/Users/{label}/project",
            )
            _sm(workspace, user, role="owner")
            self.bindings[user.id] = (agent, workspace)
        resolve_by_installation_patcher = patch(
            "apps.services.daemon_control.client.resolve_device_by_installation"
        )
        self.resolve_by_installation = resolve_by_installation_patcher.start()
        self.addCleanup(resolve_by_installation_patcher.stop)
        self.resolve_by_installation.side_effect = lambda **kwargs: {
            "device_id": str(
                uuid.uuid5(uuid.NAMESPACE_URL, kwargs["installation_id"])
            ),
            "owner_user_id": kwargs["owner_user_id"],
            "installation_id": kwargs["installation_id"],
        }

    def _create(
        self,
        user,
        *,
        session_id=None,
        agent_mode=None,
        approval_mode=None,
        target_device_id=None,
    ):
        request = self.factory.post("/api/chat/sessions")
        request.auth = user
        agent, workspace = self.bindings[user.id]
        data = CreateSessionRequest(
            session_id=session_id,
            agent_id=str(agent.id),
            workspace_id=str(workspace.id),
            project_id=str(self.team_space.id),
            organization_id=str(self.organization.id),
            agent_mode=agent_mode,
            approval_mode=approval_mode,
            target_device_id=target_device_id,
        )
        return create_session(request, data)

    @patch("apps.services.daemon_control.client.resolve_device")
    def test_target_device_is_validated_and_frozen_on_session(self, resolve_device):
        session_id = str(uuid.uuid4())
        _agent, workspace = self.bindings[self.member.id]
        resolve_device.return_value = {
            "device_id": "control-device-1",
            "owner_user_id": str(self.member.id),
            "installation_id": workspace.device.fingerprint,
        }

        created = self._create(
            self.member,
            session_id=session_id,
            target_device_id="control-device-1",
        )
        retried = self._create(
            self.member,
            session_id=session_id,
            target_device_id="control-device-1",
        )

        self.assertTrue(created["success"])
        self.assertTrue(retried["success"])
        self.assertEqual(created["data"]["target_device_id"], "control-device-1")
        self.assertEqual(retried["data"]["id"], session_id)
        session = ChatSession.objects.get(id=created["data"]["id"])
        self.assertEqual(session.target_device_id, "control-device-1")
        self.assertEqual(
            session.target_device_installation_id,
            workspace.device.fingerprint,
        )
        resolve_device.assert_called_once_with(
            owner_user_id=str(self.member.id),
            device_id="control-device-1",
        )

    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    def test_workspace_device_is_automatically_frozen_for_old_clients(self, resolve):
        session_id = str(uuid.uuid4())
        _agent, workspace = self.bindings[self.member.id]
        resolve.return_value = {
            "device_id": "control-device-auto",
            "owner_user_id": str(self.member.id),
            "installation_id": workspace.device.fingerprint,
        }

        created = self._create(self.member, session_id=session_id)
        retried = self._create(self.member, session_id=session_id)

        self.assertTrue(created["success"])
        self.assertTrue(retried["success"])
        session = ChatSession.objects.get(id=session_id)
        self.assertEqual(session.target_device_id, "control-device-auto")
        self.assertEqual(
            session.target_device_installation_id,
            workspace.device.fingerprint,
        )
        resolve.assert_called_once_with(
            owner_user_id=str(self.member.id),
            installation_id=workspace.device.fingerprint,
        )

    @override_settings(DAEMON_CONTROL_ENABLED=False)
    def test_workspace_session_keeps_legacy_route_until_control_plane_is_enabled(self):
        created = self._create(self.member)

        self.assertTrue(created["success"])
        self.assertIsNone(created["data"]["target_device_id"])
        self.resolve_by_installation.assert_not_called()

    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    def test_unregistered_workspace_device_fails_closed_when_enabled(self, resolve):
        from apps.services.daemon_control.client import TargetDeviceUnavailable

        resolve.side_effect = TargetDeviceUnavailable("目标设备不存在或当前不可接单")

        response = self._create(self.member)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.content)["code"], "DEVICE_UNAVAILABLE")
        self.assertFalse(ChatSession.objects.filter(user=self.member).exists())

    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    def test_implicit_daemon_control_failure_fails_closed_when_enabled(self, resolve):
        from apps.services.daemon_control.client import DaemonControlUnavailable

        resolve.side_effect = DaemonControlUnavailable("request failed")

        response = self._create(self.member)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.content)["code"], "SERVICE_UNAVAILABLE")
        self.assertFalse(ChatSession.objects.filter(user=self.member).exists())

    @patch("apps.services.daemon_control.client.resolve_device")
    def test_explicit_target_device_remains_fail_closed(self, resolve):
        from apps.services.daemon_control.client import TargetDeviceUnavailable

        resolve.side_effect = TargetDeviceUnavailable("目标设备不存在或当前不可接单")

        response = self._create(
            self.member,
            target_device_id="missing-control-device",
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.content)["code"], "DEVICE_UNAVAILABLE")
        self.assertFalse(ChatSession.objects.filter(user=self.member).exists())

    @patch("apps.services.daemon_control.client.resolve_device")
    def test_explicit_target_control_failure_remains_fail_closed(self, resolve):
        from apps.services.daemon_control.client import DaemonControlUnavailable

        resolve.side_effect = DaemonControlUnavailable("request failed")

        response = self._create(
            self.member,
            target_device_id="control-device-unreachable",
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.content)["code"], "SERVICE_UNAVAILABLE")
        self.assertFalse(ChatSession.objects.filter(user=self.member).exists())

    def test_observer_session_without_workspace_does_not_resolve_device(self):
        request = self.factory.post("/api/chat/sessions")
        request.auth = self.member
        agent, _workspace = self.bindings[self.member.id]

        response = create_session(
            request,
            CreateSessionRequest(
                agent_id=str(agent.id),
                organization_id=str(self.organization.id),
            ),
        )

        self.assertTrue(response["success"])
        self.assertIsNone(response["data"]["target_device_id"])
        self.resolve_by_installation.assert_not_called()

    def test_observer_first_workspace_binding_freezes_its_device(self):
        agent, workspace = self.bindings[self.member.id]
        request = self.factory.post("/api/chat/sessions")
        request.auth = self.member
        created = create_session(
            request,
            CreateSessionRequest(
                agent_id=str(agent.id),
                organization_id=str(self.organization.id),
            ),
        )

        request = self.factory.put(f"/api/chat/sessions/{created['data']['id']}")
        request.auth = self.member
        response = update_session(
            request,
            created["data"]["id"],
            UpdateSessionRequest(workspace_id=str(workspace.id)),
        )

        self.assertTrue(response["success"])
        session = ChatSession.objects.get(id=created["data"]["id"])
        self.assertEqual(session.workspace_id, workspace.id)
        self.assertEqual(
            session.target_device_installation_id,
            workspace.device.fingerprint,
        )
        self.assertTrue(session.target_device_id)
        self.resolve_by_installation.assert_called_once_with(
            owner_user_id=str(self.member.id),
            installation_id=workspace.device.fingerprint,
        )

    def test_observer_workspace_binding_fails_closed_when_device_is_unavailable(self):
        from apps.services.daemon_control.client import TargetDeviceUnavailable

        agent, workspace = self.bindings[self.member.id]
        request = self.factory.post("/api/chat/sessions")
        request.auth = self.member
        created = create_session(
            request,
            CreateSessionRequest(
                agent_id=str(agent.id),
                organization_id=str(self.organization.id),
            ),
        )
        self.resolve_by_installation.side_effect = TargetDeviceUnavailable(
            "目标设备不存在或当前不可接单"
        )

        request = self.factory.put(f"/api/chat/sessions/{created['data']['id']}")
        request.auth = self.member
        response = update_session(
            request,
            created["data"]["id"],
            UpdateSessionRequest(
                workspace_id=str(workspace.id),
                title="must not be saved",
            ),
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.content)["code"], "DEVICE_UNAVAILABLE")
        session = ChatSession.objects.get(id=created["data"]["id"])
        self.assertIsNone(session.workspace_id)
        self.assertFalse(session.target_device_id)
        self.assertFalse(session.target_device_installation_id)
        self.assertNotEqual(session.title, "must not be saved")

    @override_settings(DAEMON_CONTROL_ENABLED=False)
    def test_observer_workspace_binding_keeps_legacy_behavior_when_disabled(self):
        agent, workspace = self.bindings[self.member.id]
        request = self.factory.post("/api/chat/sessions")
        request.auth = self.member
        created = create_session(
            request,
            CreateSessionRequest(
                agent_id=str(agent.id),
                organization_id=str(self.organization.id),
            ),
        )

        request = self.factory.put(f"/api/chat/sessions/{created['data']['id']}")
        request.auth = self.member
        response = update_session(
            request,
            created["data"]["id"],
            UpdateSessionRequest(workspace_id=str(workspace.id)),
        )

        self.assertTrue(response["success"])
        session = ChatSession.objects.get(id=created["data"]["id"])
        self.assertEqual(session.workspace_id, workspace.id)
        self.assertFalse(session.target_device_id)
        self.assertFalse(session.target_device_installation_id)
        self.resolve_by_installation.assert_not_called()

    @patch("apps.services.daemon_control.client.resolve_device")
    def test_target_device_must_match_workspace_device(self, resolve_device):
        resolve_device.return_value = {
            "device_id": "control-device-other",
            "owner_user_id": str(self.member.id),
            "installation_id": "daemon-installation-other",
        }

        response = self._create(
            self.member,
            target_device_id="control-device-other",
        )

        self.assertEqual(response.status_code, 400)
        body = json.loads(response.content)
        self.assertEqual(body["code"], "VALIDATION_ERROR")
        self.assertIn("Workspace", body["message"])
        self.assertFalse(
            ChatSession.objects.filter(
                target_device_id="control-device-other",
            ).exists()
        )

    def test_frozen_session_can_only_switch_workspace_on_same_device(self):
        created = self._create(self.member)
        session = ChatSession.objects.get(id=created["data"]["id"])
        original_workspace = session.workspace
        same_device_workspace = Workspace.objects.create(
            organization=self.organization,
            device=original_workspace.device,
            created_by=self.member,
            name="same device workspace",
            working_dir="/Users/member/other",
            normalized_working_dir="/Users/member/other",
        )
        _sm(same_device_workspace, self.member, role="owner")

        request = self.factory.put(f"/api/chat/sessions/{session.id}")
        request.auth = self.member
        same_device = update_session(
            request,
            str(session.id),
            UpdateSessionRequest(workspace_id=str(same_device_workspace.id)),
        )
        self.assertTrue(same_device["success"])

        other_device = Device.objects.create(
            organization=self.organization,
            user=self.member,
            name="other execution device",
            device_type="electron",
            role="control",
            fingerprint="team-session-member-other",
            status="online",
        )
        other_device_workspace = Workspace.objects.create(
            organization=self.organization,
            device=other_device,
            created_by=self.member,
            name="other device workspace",
            working_dir="/Users/member/other-device",
            normalized_working_dir="/Users/member/other-device",
        )
        _sm(other_device_workspace, self.member, role="owner")
        request = self.factory.put(f"/api/chat/sessions/{session.id}")
        request.auth = self.member
        other_device = update_session(
            request,
            str(session.id),
            UpdateSessionRequest(workspace_id=str(other_device_workspace.id)),
        )
        self.assertEqual(other_device.status_code, 409)

        request = self.factory.put(f"/api/chat/sessions/{session.id}")
        request.auth = self.member
        observer = update_session(
            request,
            str(session.id),
            UpdateSessionRequest(workspace_id=None),
        )
        self.assertEqual(observer.status_code, 409)

    def test_client_session_id_reuses_exact_create_request(self) -> None:
        session_id = str(uuid.uuid4())

        first = self._create(
            self.member,
            session_id=session_id,
            agent_mode="agent",
            approval_mode="auto",
        )
        second = self._create(
            self.member,
            session_id=session_id,
            agent_mode="agent",
            approval_mode="auto",
        )

        self.assertTrue(first["success"])
        self.assertTrue(second["success"])
        self.assertEqual(first["data"]["id"], session_id)
        self.assertEqual(second["data"]["id"], session_id)
        self.assertEqual(ChatSession.objects.filter(id=session_id).count(), 1)

        unkeyed_first = self._create(self.member)
        unkeyed_second = self._create(self.member)
        self.assertNotEqual(unkeyed_first["data"]["id"], unkeyed_second["data"]["id"])

    def test_legacy_approval_mode_does_not_change_idempotent_session(self) -> None:
        session_id = str(uuid.uuid4())
        first = self._create(
            self.member,
            session_id=session_id,
            agent_mode="agent",
            approval_mode="auto",
        )
        conflicting = self._create(
            self.member,
            session_id=session_id,
            agent_mode="agent",
            approval_mode="always_ask",
        )

        self.assertTrue(first["success"])
        self.assertTrue(conflicting["success"])
        session = ChatSession.objects.get(id=session_id)
        self.assertFalse(hasattr(session, "approval_mode"))
        self.assertEqual(conflicting["data"]["approval_mode"], "always_ask")

    def test_client_session_id_without_explicit_model_survives_default_model_change(self) -> None:
        """未指定 model_id 的重试应返回创建时冻结的模型，而不是 409。"""
        provider = LLMProvider.objects.create(
            name=f"session-idempotency-{uuid.uuid4().hex[:20]}",
            display_name="Session Idempotency",
            api_key="test-key",
            base_url="https://example.com/v1",
            capability_domains=["chat"],
            is_global=True,
            is_active=True,
        )
        first_default = LLMModel.objects.create(
            provider=provider,
            model_name=f"first-default-{uuid.uuid4().hex}",
            display_name="First Default",
            max_tokens=8_192,
            supports_streaming=True,
            is_active=True,
        )
        second_default = LLMModel.objects.create(
            provider=provider,
            model_name=f"second-default-{uuid.uuid4().hex}",
            display_name="Second Default",
            max_tokens=8_192,
            supports_streaming=True,
            is_active=True,
        )
        session_id = str(uuid.uuid4())

        with patch(
            "apps.chat.conversation.api.session._get_organization_default_model_id",
            side_effect=[str(first_default.id), str(second_default.id)],
        ):
            first = self._create(self.member, session_id=session_id)
            retried = self._create(self.member, session_id=session_id)

        self.assertTrue(first["success"])
        self.assertTrue(retried["success"])
        self.assertEqual(retried["data"]["id"], session_id)
        self.assertEqual(retried["data"]["current_model_id"], str(first_default.id))
        self.assertEqual(retried["data"]["default_model_id"], str(first_default.id))
        session = ChatSession.objects.get(id=session_id)
        self.assertEqual(session.current_model_id, first_default.id)
        self.assertEqual(session.default_model_id, first_default.id)

    def test_create_session_without_explicit_model_uses_user_default_first(self) -> None:
        provider = LLMProvider.objects.create(
            name=f"user-default-{uuid.uuid4().hex[:20]}",
            display_name="User Default",
            api_key="test-key",
            base_url="https://example.com/v1",
            capability_domains=["chat"],
            is_global=True,
            is_active=True,
        )
        organization_default = LLMModel.objects.create(
            provider=provider,
            model_name=f"organization-default-{uuid.uuid4().hex}",
            display_name="Organization Default",
            max_tokens=8_192,
            supports_streaming=True,
            is_active=True,
        )
        user_default = LLMModel.objects.create(
            provider=provider,
            model_name=f"user-default-{uuid.uuid4().hex}",
            display_name="User Default",
            max_tokens=8_192,
            supports_streaming=True,
            is_active=True,
        )
        _write_user_default_model_id(
            self.member,
            str(self.organization.id),
            str(user_default.id),
        )

        with patch(
            "apps.chat.conversation.api.session._get_organization_default_model_id",
            return_value=str(organization_default.id),
        ):
            created = self._create(self.member)

        self.assertTrue(created["success"])
        self.assertEqual(created["data"]["current_model_id"], str(user_default.id))
        self.assertEqual(created["data"]["default_model_id"], str(user_default.id))
        session = ChatSession.objects.get(id=created["data"]["id"])
        self.assertEqual(session.current_model_id, user_default.id)
        self.assertEqual(session.default_model_id, user_default.id)

    def test_client_session_id_cannot_be_reused_by_another_user(self) -> None:
        session_id = str(uuid.uuid4())
        first = self._create(self.member, session_id=session_id)
        other_user_attempt = self._create(self.owner, session_id=session_id)

        self.assertTrue(first["success"])
        self.assertEqual(other_user_attempt.status_code, 409)
        self.assertEqual(json.loads(other_user_attempt.content)["code"], "CONFLICT")
        self.assertEqual(ChatSession.objects.filter(id=session_id).count(), 1)

    @patch("apps.chat.conversation.api.session.create_session")
    def test_quick_start_forwards_client_session_id(self, mock_create_session) -> None:
        session_id = str(uuid.uuid4())
        mock_create_session.return_value = {
            "success": True,
            "data": {"id": session_id},
        }
        request = self.factory.post("/api/chat/sessions/quick-start")
        request.auth = self.member
        agent, workspace = self.bindings[self.member.id]

        response = quick_start_session(
            request,
            QuickStartSessionRequest(
                session_id=session_id,
                agent_id=str(agent.id),
                workspace_id=str(workspace.id),
                project_id=str(self.team_space.id),
                organization_id=str(self.organization.id),
            ),
        )

        self.assertTrue(response["success"])
        forwarded_request = mock_create_session.call_args.args[1]
        self.assertEqual(forwarded_request.session_id, session_id)

    @patch("apps.services.common.chat_stream_publisher.publish_to_user")
    def test_project_session_does_not_broadcast_to_other_members(self, mock_publish) -> None:
        response = self._create(self.member)

        self.assertTrue(response["success"])
        session = ChatSession.objects.get(id=response["data"]["id"])
        self.assertEqual(session.workspace_id, self.bindings[self.member.id][1].id)
        self.assertEqual(session.project_id, self.team_space.id)
        self.assertEqual(ChatContext.objects.get(session=session).current_space_id, "")
        self.assertEqual(ChatContext.objects.get(session=session).current_project_id, self.team_space.id)
        mock_publish.assert_not_called()

    def test_project_session_requires_execution_workspace(self) -> None:
        request = self.factory.post("/api/chat/sessions")
        request.auth = self.member
        agent, _workspace = self.bindings[self.member.id]

        response = create_session(
            request,
            CreateSessionRequest(
                agent_id=str(agent.id),
                project_id=str(self.team_space.id),
                organization_id=str(self.organization.id),
            ),
        )

        self.assertFalse(json.loads(response.content)["success"])
        self.assertEqual(response.status_code, 400)

    def test_legacy_space_id_is_normalized_to_project_for_released_clients(self) -> None:
        request = self.factory.post("/api/chat/sessions")
        request.auth = self.member
        agent, workspace = self.bindings[self.member.id]

        response = create_session(
            request,
            CreateSessionRequest(
                agent_id=str(agent.id),
                workspace_id=str(workspace.id),
                space_id=str(self.team_space.id),
                organization_id=str(self.organization.id),
            ),
        )

        self.assertTrue(response["success"])
        session = ChatSession.objects.get(id=response["data"]["id"])
        self.assertEqual(session.workspace_id, workspace.id)
        self.assertEqual(session.project_id, self.team_space.id)
        context = ChatContext.objects.get(session=session)
        self.assertEqual(context.current_project_id, self.team_space.id)
        self.assertEqual(context.current_space_id, "")

    @patch("apps.services.common.chat_stream_publisher.publish_to_user")
    def test_personal_workspace_session_does_not_broadcast(self, mock_publish) -> None:
        request = self.factory.post("/api/chat/sessions")
        request.auth = self.owner
        agent, workspace = self.bindings[self.owner.id]
        data = CreateSessionRequest(
            agent_id=str(agent.id),
            workspace_id=str(workspace.id),
            organization_id=str(self.organization.id),
        )
        response = create_session(request, data)

        self.assertTrue(response["success"])
        mock_publish.assert_not_called()

    @patch("apps.services.common.chat_stream_publisher.publish_to_user")
    def test_workspace_without_legacy_space_shell_can_create_session(
        self,
        mock_publish,
    ) -> None:
        request = self.factory.post("/api/chat/sessions")
        request.auth = self.owner
        agent, workspace = self.bindings[self.owner.id]
        data = CreateSessionRequest(
            agent_id=str(agent.id),
            workspace_id=str(workspace.id),
            organization_id=str(self.organization.id),
        )

        response = create_session(request, data)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["workspace_id"], str(workspace.id))
        self.assertEqual(response["data"]["space_id"], str(workspace.id))
        self.assertIsNone(response["data"]["project_id"])
        mock_publish.assert_not_called()

        list_request = self.factory.get(
            f"/api/chat/sessions?space_id={workspace.id}"
        )
        list_request.auth = self.owner
        listed = list_sessions(list_request, workspace_id=str(workspace.id))
        self.assertEqual(
            [item["id"] for item in listed["data"]["sessions"]],
            [response["data"]["id"]],
        )

"""Team Space ChatSession listing regressions."""

from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase

from apps.chat.conversation.api.message import get_messages
from apps.chat.conversation.api.context import update_context
from apps.chat.conversation.api.session import list_sessions
from apps.chat.conversation.models import ChatContext, ChatMessage, ChatSession
from apps.chat.conversation.schemas import UpdateContextRequest
from apps.services.agent_execution.context_assembler import get_session_context
from apps.tabtinspace.models import (
    Space,
    SpaceMembership,
    Organization,
    OrganizationMember,

    Project,
    ProjectMembership,
    Workspace,
    Device,)


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


class TeamSpaceSessionListTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="team_space_session_owner",
            email="team_space_session_owner@test.com",
            password="pass123",
        )
        self.member = User.objects.create_user(
            username="team_space_session_member",
            email="team_space_session_member@test.com",
            password="pass123",
        )
        self.non_member = User.objects.create_user(
            username="team_space_session_non_member",
            email="team_space_session_non_member@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="Team Space Sessions",
            owner=self.owner,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.member, role="editor")
        from apps.tabtinspace.models import ProjectMemberWorkspace

        self.execution_space = _make_exec_workspace(self.organization, self.owner, name="Owner Workspace")
        self.team_space = _make_project(self.organization, name="Team Room", visibility="shared")
        _pm(self.team_space, self.owner, role="owner")
        _pm(self.team_space, self.member, role="editor")
        ProjectMemberWorkspace.objects.create(
            project=self.team_space,
            user=self.owner,
            workspace=self.execution_space,
        )
        # Project 会话必须显式写 project；不能再由成员 Workspace 反推协作归属。
        self.owner_session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            workspace=self.execution_space,
            project=self.team_space,
            title="Owner-created team AI session",
        )

    def _list_for(self, user):
        request = self.factory.get("/api/chat/sessions")
        request.auth = user
        return list_sessions(request, project_id=str(self.team_space.id))

    def _messages_for(self, user):
        request = self.factory.get(f"/api/chat/sessions/{self.owner_session.id}/messages")
        request.auth = user
        return get_messages(request, str(self.owner_session.id))

    def test_project_member_does_not_list_another_members_ai_sessions(self) -> None:
        response = self._list_for(self.member)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["sessions"], [])

    def test_project_session_owner_lists_own_ai_sessions(self) -> None:
        response = self._list_for(self.owner)

        self.assertTrue(response["success"])
        sessions = response["data"]["sessions"]
        self.assertEqual([item["id"] for item in sessions], [str(self.owner_session.id)])
        self.assertEqual(sessions[0]["project_id"], str(self.team_space.id))
        self.assertEqual(sessions[0]["space_id"], str(self.team_space.id))

    def test_project_list_does_not_infer_project_from_workspace(self) -> None:
        ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            workspace=self.execution_space,
            title="Personal session using the same workspace",
        )

        response = self._list_for(self.owner)

        self.assertTrue(response["success"])
        self.assertEqual(
            [item["id"] for item in response["data"]["sessions"]],
            [str(self.owner_session.id)],
        )

    def test_context_exposes_project_separately_from_resource_space(self) -> None:
        context = get_session_context(self.owner_session)

        self.assertEqual(context["current_project_id"], str(self.team_space.id))
        self.assertEqual(context["current_space_id"], "")

    def test_context_api_updates_project_without_overwriting_resource_host(self) -> None:
        ChatContext.objects.create(
            session=self.owner_session,
            current_space_id="tabdata-resource-host",
        )
        request = self.factory.put(f"/api/chat/sessions/{self.owner_session.id}/context")
        request.auth = self.owner

        response = update_context(
            request,
            str(self.owner_session.id),
            UpdateContextRequest(current_project_id=str(self.team_space.id)),
        )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["current_project_id"], str(self.team_space.id))
        context = ChatContext.objects.get(session=self.owner_session)
        self.assertEqual(context.current_project_id, self.team_space.id)
        self.assertEqual(context.current_space_id, "tabdata-resource-host")

    def test_context_api_rejects_invalid_project_id(self) -> None:
        request = self.factory.put(f"/api/chat/sessions/{self.owner_session.id}/context")
        request.auth = self.owner

        response = update_context(
            request,
            str(self.owner_session.id),
            UpdateContextRequest(current_project_id="not-a-uuid"),
        )
        payload = json.loads(response.content)

        self.assertEqual(response.status_code, 400)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("非法", payload.get("message", ""))

    def test_team_space_non_member_cannot_list_sessions(self) -> None:
        response = self._list_for(self.non_member)
        payload = json.loads(response.content)

        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], "FORBIDDEN")
        self.assertEqual(response.status_code, 403)

    def test_messages_with_non_uuid_session_id_returns_not_found(self) -> None:
        request = self.factory.get(
            "/api/chat/sessions/prompt_ee1c98777b47/messages?expand_artifacts=true",
        )
        request.auth = self.owner

        response = get_messages(request, "prompt_ee1c98777b47")
        payload = json.loads(response.content)

        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(response.status_code, 404)

    def test_team_space_messages_include_sender_display_names(self) -> None:
        ChatMessage.objects.create(
            session=self.owner_session,
            role="user",
            sender_user_id=str(self.owner.id),
            text_summary="owner says hi",
            content_blocks_json=[{"type": "text", "text": "owner says hi"}],
        )
        ChatMessage.objects.create(
            session=self.owner_session,
            role="user",
            sender_user_id=str(self.member.id),
            text_summary="member says hi",
            content_blocks_json=[{"type": "text", "text": "member says hi"}],
        )
        ChatMessage.objects.create(
            session=self.owner_session,
            role="assistant",
            sender_user_id=str(self.owner.id),
            text_summary="assistant answer",
            content_blocks_json=[{"type": "text", "text": "assistant answer"}],
        )

        response = self._messages_for(self.owner)

        self.assertTrue(response["success"])
        messages = response["data"]["messages"]
        user_messages = [message for message in messages if message["role"] == "user"]
        self.assertEqual(
            [message["sender_user_id"] for message in user_messages],
            [str(self.owner.id), str(self.member.id)],
        )
        self.assertEqual(
            [message["sender_display_name"] for message in user_messages],
            [self.owner.get_display_name(), self.member.get_display_name()],
        )
        assistant_message = next(message for message in messages if message["role"] == "assistant")
        self.assertIsNone(assistant_message["sender_user_id"])
        self.assertIsNone(assistant_message["sender_display_name"])

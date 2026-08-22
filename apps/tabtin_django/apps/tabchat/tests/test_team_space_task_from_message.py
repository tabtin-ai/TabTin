from __future__ import annotations

from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase

from apps.agent.models import Agent
from apps.chat.conversation.models import ChatContext, ChatSession
from apps.tabchat.api import create_agent_task_from_message
from apps.tabchat.models import Conversation, ConversationMember
from apps.tabchat.schemas import CreateAgentTaskFromMessageRequest
from apps.tabchat.services.message_service import MessageService
from apps.tabchat.services.team_space_task_service import (
    create_agent_task_thread_from_channel_message,
)
from apps.tabtinspace.models import Organization, OrganizationMember, Project, ProjectMembership, Workspace


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


class TeamSpaceTaskFromMessageTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="task_from_msg_owner",
            email="task_from_msg_owner@test.com",
            password="pass123",
            nickname="Owner",
        )
        self.member = User.objects.create_user(
            username="task_from_msg_member",
            email="task_from_msg_member@test.com",
            password="pass123",
            nickname="Member",
        )
        self.outsider = User.objects.create_user(
            username="task_from_msg_outsider",
            email="task_from_msg_outsider@test.com",
            password="pass123",
            nickname="Outsider",
        )
        self.organization = Organization.objects.create(name="Task From Message", owner=self.owner)
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.member, role="editor")
        OrganizationMember.objects.create(organization=self.organization, user=self.outsider, role="editor")
        self.execution_space = _make_exec_workspace(self.organization, self.owner, name="Owner Workspace")
        self.member_workspace = _make_exec_workspace(
            self.organization,
            self.member,
            name="Member Workspace",
            fingerprint=f"member-{self.organization.id}",
        )
        self.owner_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Owner Agent",
            type="bot",
        )
        self.member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.member,
            name="Member Agent",
            type="bot",
        )
        self.team_space = _make_project(self.organization, name="Launch Room", visibility="private")
        _pm(self.team_space, self.owner, role="owner")
        _pm(self.team_space, self.member, role="editor")
        self.channel = Conversation.objects.create(
            organization_id=str(self.organization.id),
            space_id=self.team_space.id,
            name="#general",
            created_by=str(self.owner.id),
            member_count=2,
        )
        ConversationMember.objects.create(
            conversation=self.channel,
            user_id=str(self.owner.id),
            role=3,
        )
        ConversationMember.objects.create(
            conversation=self.channel,
            user_id=str(self.member.id),
            role=1,
        )

    def test_creates_team_space_task_thread_with_selected_message_and_replies(self):
        unrelated = MessageService.send_message(
            str(self.channel.id),
            str(self.owner.id),
            "unrelated channel history",
        )
        source = MessageService.send_message(
            str(self.channel.id),
            str(self.member.id),
            "please turn this discussion into a launch checklist",
        )
        reply = MessageService.send_message(
            str(self.channel.id),
            str(self.owner.id),
            "include risk owners",
            reply_to_id=source.id,
        )

        result = create_agent_task_thread_from_channel_message(
            conversation_id=str(self.channel.id),
            message_id=source.id,
            actor_user=self.member,
            additional_context="Keep it concise.",
            agent_id=str(self.member_agent.id),
        )

        self.assertIsInstance(result.session, ChatSession)
        self.assertEqual(result.session.workspace_id, self.member_workspace.id)
        self.assertEqual(result.session.project_id, self.team_space.id)
        self.assertEqual(result.session.organization_id, str(self.organization.id))
        self.assertEqual(result.session.user_id, self.member.id)
        self.assertEqual(result.session.agent_id, self.member_agent.id)
        context = ChatContext.objects.get(session=result.session)
        self.assertEqual(context.current_project_id, self.team_space.id)
        self.assertEqual(context.current_space_id, "")
        self.assertEqual(result.source_message_ids, [source.id, reply.id])
        self.assertIn("please turn this discussion", result.prompt)
        self.assertIn("include risk owners", result.prompt)
        self.assertIn("Keep it concise.", result.prompt)
        self.assertIn("一次性问询", result.prompt)
        self.assertIn("不要自行判断为长期/追踪类任务", result.prompt)
        self.assertNotIn("创建并执行一个任务", result.prompt)
        self.assertNotIn(str(unrelated.id), result.prompt)
        self.assertNotIn("unrelated channel history", result.prompt)

    def test_non_space_member_cannot_create_task_thread(self):
        source = MessageService.send_message(
            str(self.channel.id),
            str(self.owner.id),
            "make a task",
        )

        with self.assertRaises(PermissionError):
            create_agent_task_thread_from_channel_message(
                conversation_id=str(self.channel.id),
                message_id=source.id,
                actor_user=self.outsider,
                agent_id=str(self.member_agent.id),
            )

    def test_rejects_non_team_space_conversation(self):
        group = Conversation.objects.create(
            organization_id=str(self.organization.id),
            name="ordinary group",
            created_by=str(self.owner.id),
            member_count=1,
        )
        ConversationMember.objects.create(conversation=group, user_id=str(self.owner.id), role=3)
        source = MessageService.send_message(str(group.id), str(self.owner.id), "not a team channel")

        with self.assertRaises(ValueError):
            create_agent_task_thread_from_channel_message(
                conversation_id=str(group.id),
                message_id=source.id,
                actor_user=self.owner,
                agent_id=str(self.owner_agent.id),
            )

    def test_rejects_missing_agent_without_creating_a_broken_session(self):
        source = MessageService.send_message(
            str(self.channel.id),
            str(self.member.id),
            "make a task",
        )
        before = ChatSession.objects.count()

        with self.assertRaisesRegex(ValueError, "请先选择一个 Agent"):
            create_agent_task_thread_from_channel_message(
                conversation_id=str(self.channel.id),
                message_id=source.id,
                actor_user=self.member,
            )

        self.assertEqual(ChatSession.objects.count(), before)

    def test_rejects_another_users_agent(self):
        source = MessageService.send_message(
            str(self.channel.id),
            str(self.member.id),
            "make a task",
        )

        with self.assertRaisesRegex(PermissionError, "不属于当前用户"):
            create_agent_task_thread_from_channel_message(
                conversation_id=str(self.channel.id),
                message_id=source.id,
                actor_user=self.member,
                agent_id=str(self.owner_agent.id),
            )

    def test_api_does_not_broadcast_private_session_to_other_members(self):
        """#6889：频道升级 Agent 任务的私有执行 session 不得广播给其他成员。"""
        source = MessageService.send_message(
            str(self.channel.id),
            str(self.member.id),
            "sync this task to owner sidebar",
        )
        request = self.factory.post("/api/tabchat/conversations/x/messages/y/agent-task")
        request.auth = self.member
        payload = CreateAgentTaskFromMessageRequest(
            additional_context="",
            agent_id=str(self.member_agent.id),
        )

        with patch(
            "apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_team_session_created",
        ) as mock_publish:
            response = create_agent_task_from_message(
                request,
                str(self.channel.id),
                source.id,
                payload,
            )

        self.assertEqual(response.code, 201)
        self.assertIn("session_id", response.data or {})
        self.assertEqual(response.data["session"]["agent_id"], str(self.member_agent.id))
        mock_publish.assert_not_called()

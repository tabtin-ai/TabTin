"""开源 Django IM：@Agent 建 job、回写 AGENT 消息、不打 tabtin-im。"""

from unittest.mock import patch

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.tabchat.constants import AGENT_MENTION_ACK_EMOJI, MessageType, SenderType
from apps.tabchat.models import (
    AgentMentionJob,
    ConversationAgentWorkspace,
    ConversationMember,
    Message,
    MessageReaction,
)
from apps.tabchat.services.conversation_agent_workspace_service import (
    REBIND_REQUIRED_REASON,
)
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabchat.services import ai_mention_service
from apps.tabchat.tasks import dispatch_agent_mention
from apps.tabtinspace.models import (
    Agent,
    Device,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)
from apps.tabtinspace.tests.fixtures import create_test_user


class OpensourceDjangoImMentionTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="os-im-owner")
        self.organization = Organization.objects.create(name="OS IM", owner=self.owner)
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="开源助手",
            type="bot",
        )
        device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="OS Device",
            device_type="electron",
            role="control",
            fingerprint=f"os-im-{self.owner.id}",
            status="online",
        )
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.owner,
            name="OS Home",
            working_dir="/tmp/os-im-home",
            normalized_working_dir="/tmp/os-im-home",
            kind=Workspace.Kind.HOME,
            trust_status=Workspace.TrustStatus.TRUSTED,
            trust_source=Workspace.TrustSource.SYSTEM_PROVISIONED,
            trusted_at=timezone.now(),
        )
        SpaceMembership.objects.create(
            workspace=self.workspace,
            user=self.owner,
            role="owner",
            is_active=True,
        )
        SpaceMembership.objects.create(
            workspace=self.workspace,
            agent=self.agent,
            role="owner",
            is_active=True,
        )
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.owner.id),
            name="开源群",
            member_ids=[],
        )
        ConversationService.add_agents(
            str(self.conv.id),
            str(self.owner.id),
            [str(self.agent.id)],
        )
        ConversationAgentWorkspace.objects.create(
            organization_id=str(self.organization.id),
            conversation=self.conv,
            agent_id=str(self.agent.id),
            workspace=self.workspace,
            bound_by_user_id=str(self.owner.id),
            bound_at=timezone.now(),
        )

    def test_owned_group_agent_mention_creates_pending_job(self):
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.owner.id),
            content="@开源助手 你好",
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id)]},
        )

        job = AgentMentionJob.objects.get(
            source_message=msg,
            agent_id=str(self.agent.id),
        )
        self.assertEqual(job.status, AgentMentionJob.Status.PENDING)
        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [str(self.agent.id)])
        ack = MessageReaction.objects.get(message=msg, emoji=AGENT_MENTION_ACK_EMOJI)
        self.assertEqual(ack.user_id, str(self.agent.id))

    def test_deployed_peer_agent_mention_creates_job(self):
        other = create_test_user(prefix="os-im-other")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=other,
            role="editor",
        )
        stranger_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=other,
            name="别人的助手",
            type="bot",
        )
        ConversationMember.objects.create(
            conversation=self.conv,
            user_id=str(other.id),
        )
        ConversationMember.objects.create(
            conversation=self.conv,
            agent_id=str(stranger_agent.id),
        )
        ConversationAgentWorkspace.objects.create(
            organization_id=str(self.organization.id),
            conversation=self.conv,
            agent_id=str(stranger_agent.id),
            workspace=self.workspace,
            bound_by_user_id=str(other.id),
            bound_at=timezone.now(),
        )

        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.owner.id),
            content="@别人的助手 你好",
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(stranger_agent.id)]},
        )

        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [str(stranger_agent.id)])
        job = AgentMentionJob.objects.get(
            source_message=msg,
            agent_id=str(stranger_agent.id),
        )
        self.assertEqual(job.status, AgentMentionJob.Status.PENDING)
        ack = MessageReaction.objects.get(message=msg, emoji=AGENT_MENTION_ACK_EMOJI)
        self.assertEqual(ack.user_id, str(stranger_agent.id))

    def test_non_member_agent_mention_is_stripped(self):
        other = create_test_user(prefix="os-im-outsider")
        outsider_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=other,
            name="未入群助手",
            type="bot",
        )

        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.owner.id),
            content="@未入群助手 你好",
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(outsider_agent.id)]},
        )

        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [])
        self.assertFalse(AgentMentionJob.objects.filter(source_message=msg).exists())
        self.assertFalse(
            MessageReaction.objects.filter(
                message=msg,
                emoji=AGENT_MENTION_ACK_EMOJI,
            ).exists()
        )

    def test_peer_member_mention_runs_on_bound_workspace(self):
        other = create_test_user(prefix="os-im-peer")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=other,
            role="editor",
        )
        ConversationMember.objects.create(
            conversation=self.conv,
            user_id=str(other.id),
        )

        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(other.id),
            content="@开源助手 总结",
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id)]},
        )
        job = AgentMentionJob.objects.get(source_message=msg, agent_id=str(self.agent.id))

        with (
            patch(
                "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
                return_value={"reply": "群成员唤起"},
            ) as dispatch,
            patch("apps.tabchat.tasks._enqueue_agent_message_reference"),
            patch(
                "apps.tabchat.services.agent_message_projection.publish_agent_message_final",
            ),
        ):
            result = ai_mention_service.dispatch_agent_mention(job)

        self.assertEqual(result.content, "群成员唤起")
        self.assertEqual(dispatch.call_args.kwargs["user"], self.owner)
        self.assertEqual(
            dispatch.call_args.kwargs["app_context"]["execution_space_id"],
            str(self.workspace.id),
        )
        ai_msg = Message.objects.get(conversation=self.conv, sender_type=SenderType.AGENT)
        self.assertEqual(ai_msg.content, "群成员唤起")
        self.assertEqual(ai_msg.sender_id, str(self.agent.id))

    @override_settings(RUNNING_TESTS=False)
    def test_mention_enqueues_tracker_agent_queue(self):
        with patch(
            "apps.tabchat.tasks.dispatch_agent_mention.apply_async",
        ) as enqueue:
            with self.captureOnCommitCallbacks(execute=True):
                MessageService.send_message(
                    conversation_id=str(self.conv.id),
                    sender_id=str(self.owner.id),
                    content="@开源助手 入队",
                    message_type=MessageType.TEXT,
                    metadata={"mentioned_agent_ids": [str(self.agent.id)]},
                )

        enqueue.assert_called_once()
        self.assertEqual(enqueue.call_args.kwargs["queue"], "tracker_agent")

    def test_task_writes_agent_reply_without_tabtin_im_bridge(self):
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.owner.id),
            content="@开源助手 总结",
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id)]},
        )
        job = AgentMentionJob.objects.get(source_message=msg, agent_id=str(self.agent.id))

        with (
            patch(
                "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
                return_value={"reply": "Django 回写"},
            ),
            patch("apps.tabchat.tasks._enqueue_agent_message_reference") as bridge,
            patch(
                "apps.tabchat.services.agent_message_projection.publish_agent_message_final",
            ) as project,
        ):
            dispatch_agent_mention.run(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, AgentMentionJob.Status.SUCCEEDED)
        self.assertEqual(job.final_content, "Django 回写")
        bridge.assert_not_called()
        project.assert_not_called()
        ai_msg = Message.objects.get(conversation=self.conv, sender_type=SenderType.AGENT)
        self.assertEqual(ai_msg.content, "Django 回写")
        self.assertEqual(ai_msg.sender_id, str(self.agent.id))

    def test_mention_without_binding_does_not_call_dispatcher(self):
        ConversationAgentWorkspace.objects.filter(
            conversation=self.conv,
            agent_id=str(self.agent.id),
        ).delete()
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.owner.id),
            content="@开源助手 总结",
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id)]},
        )
        job = AgentMentionJob.objects.get(source_message=msg, agent_id=str(self.agent.id))

        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
            return_value={"reply": "不应回写"},
        ) as dispatch:
            result = ai_mention_service.dispatch_agent_mention(job)

        self.assertIsNotNone(result)
        self.assertEqual(result.content, REBIND_REQUIRED_REASON)
        dispatch.assert_not_called()
        self.assertTrue(
            Message.objects.filter(
                conversation=self.conv,
                sender_type=SenderType.AGENT,
                content=REBIND_REQUIRED_REASON,
            ).exists()
        )
        self.assertTrue(
            MessageReaction.objects.filter(
                message=msg,
                user_id=str(self.agent.id),
                emoji=AGENT_MENTION_ACK_EMOJI,
            ).exists()
        )

    def test_agent_reaction_rejects_non_member(self):
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.owner.id),
            content="普通消息",
            message_type=MessageType.TEXT,
        )
        outsider = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="未入群助手",
            type="bot",
        )
        with self.assertRaises(PermissionError):
            MessageService.add_agent_reaction(
                str(self.conv.id),
                msg.id,
                str(outsider.id),
                AGENT_MENTION_ACK_EMOJI,
            )

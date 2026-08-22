"""TC-8 P3.2：群聊 @AI 唤起编排测试。

覆盖：成功回流（mock dispatcher）、防递归、错误/空回复不写回、触发器 enqueue 判定。
"""

import os
import sys
from unittest.mock import patch


def _ensure_django():
    django_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir)
    )
    if django_root not in sys.path:
        sys.path.insert(0, django_root)
    if "DJANGO_SETTINGS_MODULE" not in os.environ:
        os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"
    import django
    from django.apps import apps
    if not apps.ready:
        django.setup()


_ensure_django()

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.tabchat.constants import MessageType, SenderType
from apps.tabchat.models import (
    AgentMentionJob,
    ConversationAgentWorkspace,
    ConversationMember,
    IMEventOutbox,
    Message,
)
from apps.tabchat.services import ai_mention_service
from apps.tabchat.services.conversation_agent_workspace_service import (
    DEVICE_OFFLINE_OR_UNAVAILABLE_REASON,
    REBIND_REQUIRED_REASON,
)
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import (
    Agent,
    Device,
    Space,
    SpaceMembership,
    Workspace,
    Organization,
    OrganizationMember,

    Project,
    ProjectMembership,)
from apps.users.membership.models import MembershipTier

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
        trust_status=Workspace.TrustStatus.TRUSTED,
        trust_source=Workspace.TrustSource.USER_CONFIRMED,
        trusted_at=timezone.now(),
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


def _run_agent_job(message: Message, agent_id: str):
    job = AgentMentionJob.objects.get(
        source_message=message,
        agent_id=agent_id,
    )
    return ai_mention_service.dispatch_agent_mention(job)


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版', 'description': 'tc8 ai tests', 'max_tables': -1,
            'max_records_per_table': -1, 'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1, 'features': {}, 'sort_order': 0,
            'is_active': True,
        },
    )


class AiMentionDispatchTests(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(username='tc8ai_a', email='tc8ai_a@test.com', password='p')
        self.user_b = User.objects.create_user(username='tc8ai_b', email='tc8ai_b@test.com', password='p')
        self.organization = Organization.objects.create(name='TC8 AI', owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role='owner')
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role='editor')
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user_a,
            name='进宝助手',
            type='bot',
        )
        device = Device.objects.create(
            organization=self.organization,
            user=self.user_a,
            name="TC8 Device",
            device_type="electron",
            role="control",
            fingerprint=f"tc8-{self.user_a.id}",
            status="online",
        )
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=device,
            name="TC8 Home",
            working_dir="/tmp/tc8-home",
            normalized_working_dir="/tmp/tc8-home",
            working_dir_type="code",
            created_by=self.user_a,
            kind=Workspace.Kind.HOME,
            trust_status=Workspace.TrustStatus.TRUSTED,
            trust_source=Workspace.TrustSource.SYSTEM_PROVISIONED,
            trusted_at=timezone.now(),
        )
        self.bot_space = self.workspace
        _sm(self.workspace, self.user_a)
        SpaceMembership.objects.get_or_create(
            workspace=self.bot_space,
            agent=self.agent,
            defaults={"role": "owner", "is_active": True},
        )
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[],
        )
        ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(self.agent.id)],
        )
        ConversationAgentWorkspace.objects.create(
            organization_id=str(self.organization.id),
            conversation=self.conv,
            agent_id=str(self.agent.id),
            workspace=self.workspace,
            bound_by_user_id=str(self.user_a.id),
            bound_at=timezone.now(),
        )

    def _send_user_msg(self, content, metadata=None):
        return MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_a.id),
            content=content,
            message_type=MessageType.TEXT,
            metadata=metadata,
        )

    def test_successful_reply_written_back_as_agent(self):
        msg = self._send_user_msg('@进宝助手 总结一下', {"mentioned_agent_ids": [str(self.agent.id)]})
        with patch(
            'apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync',
            return_value={'reply': '这是AI的总结回复'},
        ) as dispatch:
            _run_agent_job(msg, str(self.agent.id))

        ai_msgs = Message.objects.filter(
            conversation=self.conv, sender_type=SenderType.AGENT,
        )
        self.assertEqual(ai_msgs.count(), 1)
        ai_msg = ai_msgs.first()
        self.assertEqual(ai_msg.sender_id, str(self.agent.id))
        self.assertEqual(ai_msg.content, '这是AI的总结回复')
        self.assertTrue(ai_msg.metadata.get('ai_reply'))
        job = AgentMentionJob.objects.get(source_message=msg, agent_id=str(self.agent.id))
        self.assertEqual(ai_msg.metadata["message_ref"], str(job.id))
        self.assertEqual(ai_msg.metadata["agent_session_ref"], str(job.session_id))
        self.assertEqual(ai_msg.metadata["source_message_id"], str(msg.id))
        self.assertEqual(ai_msg.metadata["kind"], "tabtin_ref")
        app_context = dispatch.call_args.kwargs["app_context"]
        self.assertEqual(app_context["idempotency_key"], job.billing_idempotency_key)
        self.assertEqual(
            app_context["billing_idempotency_key"],
            job.billing_idempotency_key,
        )
        self.conv.refresh_from_db()
        self.assertIsNone(self.conv.space_id)

    def test_any_group_member_runs_agent_on_owner_workspace_without_interrupting(self):
        OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.user_b,
        ).delete()
        ConversationMember.objects.create(
            conversation=self.conv,
            user_id=str(self.user_b.id),
        )
        job = AgentMentionJob.objects.create(
            source_message_ref="tencent-message-1",
            source_message_seq=42,
            source_sender_id=str(self.user_b.id),
            source_content="@进宝助手 先处理这个",
            context_messages=[{"sender_name": "成员B", "content": "先处理这个"}],
            agent_id=str(self.agent.id),
            organization_id=str(self.organization.id),
            conversation_ref=str(self.conv.id),
            billing_idempotency_key="mention:any-member",
        )

        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
            return_value={"reply": "收到"},
        ) as dispatch:
            result = ai_mention_service.dispatch_agent_mention(job)

        self.assertEqual(result.content, "收到")
        self.assertEqual(dispatch.call_args.kwargs["user"], self.user_a)
        session = dispatch.call_args.kwargs["session_id"]
        from apps.chat.conversation.models import ChatSession
        created = ChatSession.objects.get(id=session)
        self.assertEqual(created.user_id, self.user_a.id)
        self.assertEqual(created.workspace_id, self.workspace.id)
        app_context = dispatch.call_args.kwargs["app_context"]
        self.assertEqual(app_context["_shared_chat_by"], str(self.user_b.id))
        self.assertNotIn("_interrupt_agent_active", app_context)

    def test_ownerless_agent_does_not_fall_back_to_the_organization_owner(self):
        self.agent.owner_user = None
        self.agent.save(update_fields=["owner_user"])
        job = AgentMentionJob.objects.create(
            source_message_ref="tencent-message-ownerless",
            source_sender_id=str(self.user_a.id),
            source_content="@进宝助手 处理一下",
            agent_id=str(self.agent.id),
            organization_id=str(self.organization.id),
            conversation_ref=str(self.conv.id),
            billing_idempotency_key="mention:ownerless",
        )

        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
        ) as dispatch:
            result = ai_mention_service.dispatch_agent_mention(job)

        self.assertIsNone(result)
        dispatch.assert_not_called()

    def test_referenced_message_is_kept_outside_the_recent_message_limit(self):
        recent = [
            {"sender_name": f"成员{index}", "content": f"历史{index}"}
            for index in range(20)
        ]
        job = AgentMentionJob.objects.create(
            source_message_ref="tencent-message-with-reference",
            source_sender_id=str(self.user_a.id),
            source_content="@进宝助手 这里是什么意思",
            context_messages=[
                *recent,
                {
                    "sender_name": "原作者",
                    "content": "必须保留的引用内容",
                    "is_referenced": True,
                },
            ],
            agent_id=str(self.agent.id),
            organization_id=str(self.organization.id),
            conversation_ref=str(self.conv.id),
            billing_idempotency_key="mention:referenced-context",
        )

        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
            return_value={"reply": "收到"},
        ) as dispatch:
            ai_mention_service.dispatch_agent_mention(job)

        prompt = dispatch.call_args.kwargs["message"]
        self.assertIn("## 当前消息引用\n原作者: 必须保留的引用内容", prompt)
        self.assertIn("成员0: 历史0", prompt)
        self.assertIn("成员19: 历史19", prompt)

    def test_retried_dispatch_reuses_final_reply_and_billing_key(self):
        msg = self._send_user_msg(
            "@进宝助手 重试也只能回复一次",
            {"mentioned_agent_ids": [str(self.agent.id)]},
        )
        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
            return_value={"reply": "唯一回复"},
        ) as dispatch:
            first = _run_agent_job(msg, str(self.agent.id))
            second = _run_agent_job(msg, str(self.agent.id))

        self.assertIsNotNone(first)
        self.assertEqual(first.content, second.content)
        self.assertEqual(first.content, "唯一回复")
        self.assertEqual(
            Message.objects.filter(
                conversation=self.conv,
                sender_type=SenderType.AGENT,
            ).count(),
            1,
        )
        billing_keys = [
            call.kwargs["app_context"]["billing_idempotency_key"]
            for call in dispatch.call_args_list
        ]
        self.assertEqual(len(set(billing_keys)), 1)
    def test_team_space_channel_does_not_implicitly_dispatch_agent(self):
        team_space = _make_project(self.organization, name='发布项目', visibility='private')
        _pm(team_space, self.user_a, role='owner')
        self.conv.name = '#general'
        self.conv.space_id = team_space.id
        self.conv.save(update_fields=['name', 'space_id'])
        msg = self._send_user_msg('@进宝助手 帮我把上线事项都做完', {"mentioned_agent_ids": [str(self.agent.id)]})

        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [])
        self.assertFalse(AgentMentionJob.objects.filter(source_message=msg).exists())

    def test_team_space_heavy_mention_requires_explicit_task_flow(self):
        team_space = _make_project(self.organization, name='发布项目', visibility='private')
        _pm(team_space, self.user_a, role='owner')
        self.conv.name = '#general'
        self.conv.space_id = team_space.id
        self.conv.save(update_fields=['name', 'space_id'])
        msg = self._send_user_msg(
            '@进宝助手 帮我写个完整的用户登录模块代码',
            {"mentioned_agent_ids": [str(self.agent.id)]},
        )
        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [])
        self.assertFalse(AgentMentionJob.objects.filter(source_message=msg).exists())
        self.assertFalse(
            IMEventOutbox.objects.filter(event_type='im.ai.suggest_task').exists()
        )

    def test_team_space_channel_cannot_mention_unbound_agent(self):
        team_space = _make_project(self.organization, name='旧频道', visibility='private')
        _pm(team_space, self.user_a, role='owner')
        _pm(team_space, self.user_b, role='editor')
        ConversationMember.objects.filter(conversation=self.conv, agent_id=str(self.agent.id)).delete()
        self.conv.name = '#general'
        self.conv.space_id = team_space.id
        self.conv.save(update_fields=['name', 'space_id'])
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_b.id),
            content='@进宝助手 给个短建议',
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id)]},
        )
        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [])
        self.assertFalse(AgentMentionJob.objects.filter(source_message=msg).exists())

    def test_agent_without_space_shell_uses_bound_workspace(self):
        orphan_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user_a,
            name='缺空间助手',
            type='bot',
        )
        ConversationMember.objects.create(conversation=self.conv, agent_id=str(orphan_agent.id))
        ConversationAgentWorkspace.objects.create(
            organization_id=str(self.organization.id),
            conversation=self.conv,
            agent_id=str(orphan_agent.id),
            workspace=self.workspace,
            bound_by_user_id=str(self.user_a.id),
            bound_at=timezone.now(),
        )
        import uuid as _uuid
        self.conv.space_id = _uuid.uuid4()
        self.conv.save(update_fields=['space_id'])
        msg = self._send_user_msg('@缺空间助手 在吗', {"mentioned_agent_ids": [str(orphan_agent.id)]})

        with patch(
            'apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync',
            return_value={'reply': '在'},
        ) as mock_dispatch:
            _run_agent_job(msg, str(orphan_agent.id))

        mock_dispatch.assert_called_once()
        app_context = mock_dispatch.call_args.kwargs["app_context"]
        self.assertEqual(app_context["current_space_id"], "")
        self.assertEqual(app_context["execution_space_id"], str(self.workspace.id))

    def test_member_without_binding_does_not_dispatch(self):
        ConversationAgentWorkspace.objects.filter(
            conversation=self.conv,
            agent_id=str(self.agent.id),
        ).delete()
        msg = self._send_user_msg(
            "@进宝助手 今日要闻",
            {"mentioned_agent_ids": [str(self.agent.id)]},
        )
        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
            return_value={"reply": "不应执行"},
        ) as mock_dispatch:
            result = _run_agent_job(msg, str(self.agent.id))

        self.assertIsNotNone(result)
        self.assertEqual(result.content, REBIND_REQUIRED_REASON)
        mock_dispatch.assert_not_called()
        self.assertTrue(
            Message.objects.filter(
                conversation=self.conv,
                sender_type=SenderType.AGENT,
                content=REBIND_REQUIRED_REASON,
            ).exists()
        )

    def test_bound_standard_workspace_allows_agent_mention(self):
        """绑定到 standard 个人现场时，群聊 @Agent 可以执行。"""
        self.workspace.kind = Workspace.Kind.STANDARD
        self.workspace.save(update_fields=["kind", "updated_at"])
        newer_workspace = _make_exec_workspace(
            self.organization,
            self.user_a,
            name="Later Workspace",
            fingerprint=f"tc8-later-{self.user_a.id}",
        )
        _sm(newer_workspace, self.user_a)

        msg = self._send_user_msg(
            "@进宝助手 今日要闻",
            {"mentioned_agent_ids": [str(self.agent.id)]},
        )
        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
            return_value={"reply": "今日要闻已整理"},
        ) as mock_dispatch:
            _run_agent_job(msg, str(self.agent.id))

        mock_dispatch.assert_called_once()
        app_context = mock_dispatch.call_args.kwargs["app_context"]
        self.assertEqual(app_context["execution_space_id"], str(self.workspace.id))
        self.assertFalse(
            IMEventOutbox.objects.filter(
                event_type="im.ai.error",
                payload__data__reason="请重新指定执行现场",
            ).exists()
        )

    def test_stale_project_provisioned_binding_does_not_dispatch(self):
        """绑定现场后来变成 Project 供给目录时，普通群聊不再执行。"""
        self.workspace.kind = Workspace.Kind.STANDARD
        self.workspace.provisioning_source = Workspace.ProvisioningSource.SYSTEM_PROJECT
        self.workspace.save(
            update_fields=["kind", "provisioning_source", "updated_at"]
        )
        legacy_workspace = _make_exec_workspace(
            self.organization,
            self.user_a,
            name="Legacy Personal Workspace",
            fingerprint=f"tc8-legacy-personal-{self.user_a.id}",
        )
        _sm(legacy_workspace, self.user_a)

        msg = self._send_user_msg(
            "@进宝助手 今日要闻",
            {"mentioned_agent_ids": [str(self.agent.id)]},
        )
        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
            return_value={"reply": "今日要闻已整理"},
        ) as mock_dispatch:
            result = _run_agent_job(msg, str(self.agent.id))

        self.assertIsNotNone(result)
        self.assertEqual(result.content, REBIND_REQUIRED_REASON)
        mock_dispatch.assert_not_called()
        self.assertTrue(
            Message.objects.filter(
                conversation=self.conv,
                sender_type=SenderType.AGENT,
                content=REBIND_REQUIRED_REASON,
            ).exists()
        )

    def test_untrusted_bound_workspace_does_not_dispatch(self):
        """绑定现场取消信任后，普通群聊不再执行。"""
        self.workspace.kind = Workspace.Kind.STANDARD
        self.workspace.trust_status = Workspace.TrustStatus.UNTRUSTED
        self.workspace.save(update_fields=["kind", "trust_status", "updated_at"])

        valid_workspace = _make_exec_workspace(
            self.organization,
            self.user_a,
            name="Valid Legacy Workspace",
            fingerprint=f"tc8-valid-legacy-{self.user_a.id}",
        )
        _sm(valid_workspace, self.user_a)

        msg = self._send_user_msg(
            "@进宝助手 今日要闻",
            {"mentioned_agent_ids": [str(self.agent.id)]},
        )
        with patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
            return_value={"reply": "今日要闻已整理"},
        ) as mock_dispatch:
            result = _run_agent_job(msg, str(self.agent.id))

        self.assertIsNotNone(result)
        self.assertEqual(result.content, REBIND_REQUIRED_REASON)
        mock_dispatch.assert_not_called()
        self.assertTrue(
            Message.objects.filter(
                conversation=self.conv,
                sender_type=SenderType.AGENT,
                content=REBIND_REQUIRED_REASON,
            ).exists()
        )

    def test_peer_deployed_agent_mention_runs_on_bound_workspace(self):
        private_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user_b,
            name='别人的助手',
            type='bot',
        )
        private_ws = _make_exec_workspace(
            self.organization, self.user_b, name='别人的助手',
            fingerprint=f'tc8-private-{self.user_b.id}',
        )
        _sm(private_ws, self.user_b)
        SpaceMembership.objects.get_or_create(
            workspace=private_ws,
            agent=private_agent,
            defaults={"role": "owner", "is_active": True},
        )
        ConversationMember.objects.create(conversation=self.conv, user_id=str(self.user_b.id))
        ConversationMember.objects.create(conversation=self.conv, agent_id=str(private_agent.id))
        ConversationAgentWorkspace.objects.create(
            organization_id=str(self.organization.id),
            conversation=self.conv,
            agent_id=str(private_agent.id),
            workspace=private_ws,
            bound_by_user_id=str(self.user_b.id),
            bound_at=timezone.now(),
        )
        msg = self._send_user_msg('@别人的助手 在吗', {"mentioned_agent_ids": [str(private_agent.id)]})
        msg.refresh_from_db()
        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [str(private_agent.id)])

        with patch(
            'apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync',
            return_value={'reply': '我是别人的助手'},
        ) as mock_dispatch:
            result = _run_agent_job(msg, str(private_agent.id))

        self.assertEqual(result.content, '我是别人的助手')
        mock_dispatch.assert_called_once()
        self.assertEqual(mock_dispatch.call_args.kwargs['user'], self.user_b)
        app_context = mock_dispatch.call_args.kwargs['app_context']
        self.assertEqual(app_context['execution_space_id'], str(private_ws.id))
        self.assertTrue(
            Message.objects.filter(
                conversation=self.conv,
                sender_type=SenderType.AGENT,
                sender_id=str(private_agent.id),
                content='我是别人的助手',
            ).exists()
        )

    def test_no_recursion_on_agent_message(self):
        # Agent 发的消息（sender_type=agent）不应再触发
        agent_msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.agent.id),
            content='AI 说的话',
            message_type=MessageType.TEXT,
            sender_type=SenderType.AGENT,
        )
        with patch(
            'apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync',
        ) as mock_dispatch:
            self.assertFalse(
                AgentMentionJob.objects.filter(source_message=agent_msg).exists()
            )
        mock_dispatch.assert_not_called()

    def test_device_registered_to_other_user_writes_offline_error(self):
        self.workspace.device.user = self.user_b
        self.workspace.device.save(update_fields=["user"])
        msg = self._send_user_msg('@进宝助手 在吗', {"mentioned_agent_ids": [str(self.agent.id)]})
        with patch(
            'apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync',
            return_value={'reply': '不应执行'},
        ) as mock_dispatch:
            result = _run_agent_job(msg, str(self.agent.id))
        self.assertIsNotNone(result)
        self.assertEqual(result.content, DEVICE_OFFLINE_OR_UNAVAILABLE_REASON)
        mock_dispatch.assert_not_called()
        self.assertTrue(
            Message.objects.filter(
                conversation=self.conv,
                sender_type=SenderType.AGENT,
                content=DEVICE_OFFLINE_OR_UNAVAILABLE_REASON,
            ).exists()
        )

    def test_error_category_writes_offline_error(self):
        msg = self._send_user_msg('@进宝助手 在吗', {"mentioned_agent_ids": [str(self.agent.id)]})
        with patch(
            'apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync',
            return_value={'error_category': 'device_offline', 'error_message': 'offline'},
        ):
            result = _run_agent_job(msg, str(self.agent.id))
        self.assertIsNotNone(result)
        self.assertEqual(result.content, DEVICE_OFFLINE_OR_UNAVAILABLE_REASON)
        self.assertTrue(
            Message.objects.filter(
                conversation=self.conv,
                sender_type=SenderType.AGENT,
                content=DEVICE_OFFLINE_OR_UNAVAILABLE_REASON,
            ).exists()
        )

    def test_empty_reply_does_not_write_back(self):
        msg = self._send_user_msg('@进宝助手 ?', {"mentioned_agent_ids": [str(self.agent.id)]})
        with patch(
            'apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync',
            return_value={'reply': '   '},
        ):
            _run_agent_job(msg, str(self.agent.id))
        self.assertFalse(
            Message.objects.filter(conversation=self.conv, sender_type=SenderType.AGENT).exists()
        )

    def test_non_member_agent_skipped(self):
        other_agent = Agent.objects.create(organization=self.organization, name='外部', type='bot')
        msg = self._send_user_msg('hi')
        with patch(
            'apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync',
        ) as mock_dispatch:
            self.assertFalse(
                AgentMentionJob.objects.filter(
                    source_message=msg,
                    agent_id=str(other_agent.id),
                ).exists()
            )
        mock_dispatch.assert_not_called()


class AiMentionTriggerTests(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(username='tc8tr_a', email='tc8tr_a@test.com', password='p')
        self.organization = Organization.objects.create(name='TC8 Trigger', owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role='owner')
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user_a,
            name='助手',
            type='bot',
        )
        self.bot_space = _make_exec_workspace(self.organization, self.user_a, name='助手')
        SpaceMembership.objects.get_or_create(
            workspace=self.bot_space,
            agent=self.agent,
            defaults={"role": "owner", "is_active": True},
        )
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='群', member_ids=[],
        )
        ConversationService.add_agents(str(self.conv.id), str(self.user_a.id), [str(self.agent.id)])

    def test_mention_enqueues_task(self):
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id), sender_id=str(self.user_a.id),
            content='@助手 hi', message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id)]},
        )
        job = AgentMentionJob.objects.get(source_message=msg, agent_id=str(self.agent.id))
        self.assertEqual(job.status, AgentMentionJob.Status.PENDING)

    def test_team_space_does_not_enqueue_without_explicit_task_agent(self):
        team_space = _make_project(self.organization, name='旧频道', visibility='private')
        _pm(team_space, self.user_a, role='owner')
        self.conv.name = '#general'
        self.conv.space_id = team_space.id
        self.conv.save(update_fields=['name', 'space_id'])
        ConversationMember.objects.filter(
            conversation=self.conv,
            agent_id=str(self.agent.id),
        ).delete()
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_a.id),
            content='@助手 hi',
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id)]},
        )

        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [])
        self.assertFalse(AgentMentionJob.objects.filter(source_message=msg).exists())

    def test_team_space_unbound_execution_agent_is_not_mentionable(self):
        team_space = _make_project(self.organization, name='已解绑执行 Agent', visibility='private')
        _pm(team_space, self.user_a, role='owner')
        self.conv.name = '#general'
        self.conv.space_id = team_space.id
        self.conv.save(update_fields=['name', 'space_id'])
        # Project 不再有 execution_space；空绑定场景由 get_team_space_execution_agent_id 返回空串覆盖

        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_a.id),
            content='@助手 hi',
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id)]},
        )

        self.assertEqual(msg.metadata.get("mentioned_agent_ids"), [])
        self.assertFalse(AgentMentionJob.objects.filter(source_message=msg).exists())

    def test_no_mention_no_enqueue(self):
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id), sender_id=str(self.user_a.id),
            content='普通消息', message_type=MessageType.TEXT,
        )
        self.assertFalse(AgentMentionJob.objects.filter(source_message=msg).exists())

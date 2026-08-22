"""TC-8 P3.1 身份地基测试。

覆盖：把 AI Agent 作为一等参与者加入群聊、成员详情 enrich、
发消息不产生逐用户状态、@Agent 校验、移除 Agent。
"""

import os
import sys
from types import SimpleNamespace


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

from apps.tabchat.api import search_organization_agents
from apps.tabchat.constants import MessageType, SenderType
from apps.tabchat.models import (
    ConversationMember,
    Message,
    MessageMention,
    MessageUserState,
)
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Agent, Organization, OrganizationMember, Project
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'tc8 tests bootstrap',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        },
    )


class AgentIdentityFoundationTests(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username='tc8_a', email='tc8_a@test.com', password='pass123',
        )
        self.user_b = User.objects.create_user(
            username='tc8_b', email='tc8_b@test.com', password='pass123',
        )
        self.organization = Organization.objects.create(name='TC8 Test', owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role='owner')
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role='editor')
        self.agent = Agent.objects.create(
            organization=self.organization, owner_user=self.user_a, name='进宝助手', type='bot',
        )
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )

    def test_add_agent_to_group(self):
        added = ConversationService.add_agents(
            conversation_id=str(self.conv.id),
            operator_id=str(self.user_a.id),
            agent_ids=[str(self.agent.id)],
        )
        self.assertEqual(added, [str(self.agent.id)])
        self.assertTrue(
            ConversationMember.objects.filter(
                conversation_id=self.conv.id, agent_id=str(self.agent.id)
            ).exists()
        )
        self.conv.refresh_from_db()
        self.assertEqual(self.conv.member_count, 3)

    def test_add_agent_idempotent(self):
        ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(self.agent.id)],
        )
        again = ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(self.agent.id)],
        )
        self.assertEqual(again, [])

    def test_add_agent_deduplicates_request_ids(self):
        added = ConversationService.add_agents(
            str(self.conv.id),
            str(self.user_a.id),
            [str(self.agent.id), str(self.agent.id)],
        )
        self.assertEqual(added, [str(self.agent.id)])
        self.assertEqual(
            ConversationMember.objects.filter(
                conversation_id=self.conv.id,
                agent_id=str(self.agent.id),
            ).count(),
            1,
        )

    def test_add_foreign_agent_rejected(self):
        other_team = Organization.objects.create(name='Other', owner=self.user_b)
        foreign_agent = Agent.objects.create(
            organization=other_team, name='外部助手', type='bot',
        )
        with self.assertRaises(ValueError):
            ConversationService.add_agents(
                str(self.conv.id), str(self.user_a.id), [str(foreign_agent.id)],
            )

    def test_add_owned_agent_without_workspace_allowed(self):
        standalone_agent = Agent.objects.create(
            organization=self.organization, owner_user=self.user_a, name='缺空间助手', type='bot',
        )
        added = ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(standalone_agent.id)],
        )
        self.assertEqual(added, [str(standalone_agent.id)])

    def test_add_other_users_private_agent_rejected(self):
        owner_c = User.objects.create_user(
            username='tc8_c', email='tc8_c@test.com', password='pass123',
        )
        OrganizationMember.objects.create(organization=self.organization, user=owner_c, role='editor')
        private_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=owner_c,
            name='别人的助手',
            type='bot',
        )
        with self.assertRaises(ValueError):
            ConversationService.add_agents(
                str(self.conv.id), str(self.user_a.id), [str(private_agent.id)],
            )

    def test_search_agents_only_returns_owned_active_bots(self):
        owner_c = User.objects.create_user(
            username='tc8_search_c', email='tc8_search_c@test.com', password='pass123',
        )
        OrganizationMember.objects.create(organization=self.organization, user=owner_c, role='editor')
        private_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=owner_c,
            name='Search Private',
            type='bot',
        )
        standalone_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user_a,
            name='Search Standalone',
            type='bot',
        )

        response = search_organization_agents(
            SimpleNamespace(auth=self.user_a),
            organization_id=str(self.organization.id),
            q='Search',
            limit=20,
        )

        self.assertTrue(response.success)
        returned_ids = {row["id"] for row in response.data}
        self.assertNotIn(str(private_agent.id), returned_ids)
        self.assertIn(str(standalone_agent.id), returned_ids)

    def test_search_agents_filters_owner_before_limit(self):
        owner_c = User.objects.create_user(
            username='tc8_page_c', email='tc8_page_c@test.com', password='pass123',
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=owner_c, role='editor',
        )
        for idx in range(6):
            Agent.objects.create(
                organization=self.organization,
                owner_user=owner_c,
                name=f'Page {idx:02d} foreign',
                type='bot',
            )
        available = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user_a,
            name='Page 99 available',
            type='bot',
        )
        response = search_organization_agents(
            SimpleNamespace(auth=self.user_a),
            organization_id=str(self.organization.id),
            q='Page',
            limit=1,
        )

        self.assertTrue(response.success)
        self.assertEqual([row["id"] for row in response.data], [str(available.id)])

    def test_conversation_detail_includes_agent_member(self):
        ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(self.agent.id)],
        )
        detail = ConversationService.get_conversation_detail(
            str(self.conv.id), str(self.user_a.id),
        )
        agent_members = [m for m in detail["members"] if m["member_type"] == "agent"]
        self.assertEqual(len(agent_members), 1)
        am = agent_members[0]
        self.assertEqual(am["agent_id"], str(self.agent.id))
        self.assertIsNone(am["user_id"])
        self.assertEqual(am["nickname"], '进宝助手')

    def test_send_message_does_not_create_per_recipient_state(self):
        ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(self.agent.id)],
        )
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_a.id),
            content='hello',
            message_type=MessageType.TEXT,
        )
        self.assertFalse(MessageUserState.objects.filter(message=msg).exists())
        self.assertFalse(MessageMention.objects.filter(message=msg).exists())

    def test_history_replay_keeps_agent_sender_name(self):
        ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(self.agent.id)],
        )
        MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.agent.id),
            content='收到，我来处理。',
            message_type=MessageType.TEXT,
            sender_type=SenderType.AGENT,
        )

        messages = MessageService.get_messages(
            conversation_id=str(self.conv.id),
            user_id=str(self.user_a.id),
        )

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["sender_type"], SenderType.AGENT)
        self.assertEqual(messages[0]["sender_id"], str(self.agent.id))
        self.assertEqual(messages[0]["sender_name"], "进宝助手")

    def test_history_replay_does_not_hydrate_foreign_agent_name(self):
        other_team = Organization.objects.create(name='TC8 Foreign', owner=self.user_b)
        foreign_agent = Agent.objects.create(
            organization=other_team,
            owner_user=self.user_b,
            name='外部助手',
            type='bot',
        )
        Message.objects.create(
            conversation=self.conv,
            seq=1,
            sender_id=str(foreign_agent.id),
            sender_type=SenderType.AGENT,
            content='dirty historical row',
            message_type=MessageType.TEXT,
        )

        messages = MessageService.get_messages(
            conversation_id=str(self.conv.id),
            user_id=str(self.user_a.id),
        )

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["sender_type"], SenderType.AGENT)
        self.assertEqual(messages[0]["sender_id"], str(foreign_agent.id))
        self.assertEqual(messages[0]["sender_name"], "")

    def test_mentioned_agent_ids_validated_and_filtered(self):
        ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(self.agent.id)],
        )
        bogus = '00000000-0000-0000-0000-0000000000ff'
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_a.id),
            content='@进宝助手 hi',
            message_type=MessageType.TEXT,
            metadata={"mentioned_agent_ids": [str(self.agent.id), bogus]},
        )
        msg.refresh_from_db()
        self.assertEqual(
            msg.metadata.get("mentioned_agent_ids"), [str(self.agent.id)]
        )

    def test_remove_agent(self):
        ConversationService.add_agents(
            str(self.conv.id), str(self.user_a.id), [str(self.agent.id)],
        )
        removed = ConversationService.remove_agent(
            str(self.conv.id), str(self.user_a.id), str(self.agent.id),
        )
        self.assertTrue(removed)
        self.assertFalse(
            ConversationMember.objects.filter(
                conversation_id=self.conv.id, agent_id=str(self.agent.id)
            ).exists()
        )

    def test_member_xor_constraint(self):
        """同一行不能同时无 user_id 与 agent_id（DB check 约束）。"""
        from django.db import IntegrityError, transaction
        from apps.services.common.db_router import postgres_app_db_alias

        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=postgres_app_db_alias()):
                ConversationMember.objects.create(
                    conversation=self.conv, user_id=None, agent_id=None,
                )


class RegularMemberAddAgentTests(TestCase):
    """普通群成员可加自己的 bot；不依赖已删除的 Space 表。"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.owner = User.objects.create_user(
            username='tc8_owner', email='tc8_owner@test.com', password='pass123',
        )
        self.member = User.objects.create_user(
            username='tc8_member', email='tc8_member@test.com', password='pass123',
        )
        self.organization = Organization.objects.create(name='TC8 Member Add', owner=self.owner)
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role='owner',
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.member, role='editor',
        )
        self.owner_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name='群主助手',
            type='bot',
        )
        self.member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.member,
            name='成员助手',
            type='bot',
        )
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.owner.id),
            name='协作群',
            member_ids=[str(self.member.id)],
        )

    def test_regular_member_can_add_own_agent(self):
        added = ConversationService.add_agents(
            str(self.conv.id), str(self.member.id), [str(self.member_agent.id)],
        )
        self.assertEqual(added, [str(self.member_agent.id)])
        self.assertTrue(
            ConversationMember.objects.filter(
                conversation_id=self.conv.id, agent_id=str(self.member_agent.id)
            ).exists()
        )

    def test_regular_member_cannot_add_others_agent(self):
        with self.assertRaises(ValueError):
            ConversationService.add_agents(
                str(self.conv.id), str(self.member.id), [str(self.owner_agent.id)],
            )

    def test_non_member_cannot_add_agent(self):
        outsider = User.objects.create_user(
            username='tc8_out', email='tc8_out@test.com', password='pass123',
        )
        with self.assertRaises(PermissionError):
            ConversationService.add_agents(
                str(self.conv.id), str(outsider.id), [str(self.member_agent.id)],
            )

    def test_team_space_channel_rejects_add_agent(self):
        project = Project.objects.create(
            organization=self.organization,
            name='发布项目',
            status=Project.Status.ACTIVE,
            visibility='private',
        )
        self.conv.space_id = project.id
        self.conv.save(update_fields=['space_id'])
        with self.assertRaises(ValueError):
            ConversationService.add_agents(
                str(self.conv.id), str(self.member.id), [str(self.member_agent.id)],
            )

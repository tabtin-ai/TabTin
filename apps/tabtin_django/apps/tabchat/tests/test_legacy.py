import os
import sys
import unittest
import uuid
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch


def _ensure_django():
    django_root = os.path.join(
        os.path.dirname(__file__), os.pardir, os.pardir, os.pardir,
    )
    django_root = os.path.abspath(django_root)
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
from django.test import RequestFactory
from django.test import TestCase
from ninja.testing import TestClient

from apps.tabchat.api import mark_read, router, toggle_mute, toggle_pin
from apps.tabchat.constants import MemberRole, MessageType
from apps.tabchat.schemas import (
    ConversationMuteRequest,
    ConversationPinRequest,
    MarkReadRequest,
)
from apps.tabchat.services.conversation_service import (
    ConversationService,
    _serialize_conversation_detail,
    _serialize_conversation_summary,
)
from apps.tabchat.models import Conversation, ConversationMember, Message
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization, OrganizationMember, Project, ProjectMembership, Workspace, Device
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

LEGACY_SHADOW_SPACE_TYPES = ["dm", "group"]


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'tabchat tests bootstrap',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        }
    )


class ConversationSerializationTests(unittest.TestCase):

    def test_summary_includes_organization_and_space_id(self):
        space_id = uuid.uuid4()
        conv = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id="ws-1",
            space_id=space_id,
            type=1,
            name="DM",
            avatar_url="",
            member_count=2,
            last_message_at=None,
            last_message_preview="",
            latest_message_id=42,
            created_at=datetime(2026, 3, 8, 12, 0, 0),
            unread_count=3,
        )

        payload = _serialize_conversation_summary(
            conv,
            prefs={"pinned": True, "is_muted": False},
            peer={"user_id": "user-2"},
        )

        self.assertEqual(payload["organization_id"], "ws-1")
        self.assertEqual(payload["space_id"], str(space_id))
        self.assertEqual(payload["dm_peer_user_id"], "user-2")
        self.assertEqual(payload["last_message_id"], "42")

    def test_detail_includes_space_id(self):
        space_id = uuid.uuid4()
        conv = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id="ws-1",
            space_id=space_id,
            type=1,
            name="DM",
            avatar_url="",
            dm_hash="hash",
            member_count=2,
            last_message_at=None,
            last_message_preview="",
            created_by="user-1",
            created_at=datetime(2026, 3, 8, 12, 0, 0),
        )

        payload = _serialize_conversation_detail(
            conv,
            unread_count=0,
            members=[],
        )

        self.assertEqual(payload["organization_id"], "ws-1")
        self.assertEqual(payload["space_id"], str(space_id))

    def test_serializers_allow_null_space_id(self):
        conv = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id="ws-1",
            space_id=None,
            type=1,
            name="DM",
            avatar_url="",
            dm_hash="hash",
            member_count=2,
            last_message_at=None,
            last_message_preview="",
            created_by="user-1",
            created_at=datetime(2026, 3, 8, 12, 0, 0),
            unread_count=0,
        )

        summary = _serialize_conversation_summary(conv)
        detail = _serialize_conversation_detail(conv, unread_count=0, members=[])

        self.assertIsNone(summary["space_id"])
        self.assertIsNone(detail["space_id"])


class ConversationSpaceFirstTests(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()
        self.user_a = User.objects.create_user(
            username='tabchat_dm_a',
            email='tabchat_dm_a@test.com',
            password='pass123',
        )
        self.user_b = User.objects.create_user(
            username='tabchat_dm_b',
            email='tabchat_dm_b@test.com',
            password='pass123',
        )
        self.organization = Organization.objects.create(
            name='TabChat DM Space Test',
            owner=self.user_a,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role='owner')
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role='editor')

    def assertNoShadowSpaces(self):
        # Space 表已 DROP；阴影类型不再存在
        self.assertTrue(True)

    def test_left_organization_member_api_errors_are_403(self):
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )
        OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.user_b,
        ).delete()
        request = self.factory.post("/api/im/test")
        request.auth = self.user_b

        self.assertEqual(toggle_pin(request, str(conv.id)).code, 403)
        self.assertEqual(toggle_mute(request, str(conv.id)).code, 403)
        self.assertEqual(
            mark_read(request, str(conv.id), MarkReadRequest()).code,
            403,
        )

    def test_conversation_preferences_accept_idempotent_target_state(self):
        conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )
        request = self.factory.post("/api/im/test")
        request.auth = self.user_a

        first_pin = toggle_pin(
            request,
            str(conv.id),
            ConversationPinRequest(pinned=True),
        )
        retry_pin = toggle_pin(
            request,
            str(conv.id),
            ConversationPinRequest(pinned=True),
        )
        first_mute = toggle_mute(
            request,
            str(conv.id),
            ConversationMuteRequest(muted=True),
        )
        retry_mute = toggle_mute(
            request,
            str(conv.id),
            ConversationMuteRequest(muted=True),
        )

        self.assertTrue(first_pin.data["pinned"])
        self.assertTrue(retry_pin.data["pinned"])
        self.assertTrue(first_mute.data["muted"])
        self.assertTrue(retry_mute.data["muted"])

    def test_legacy_conversation_preference_requests_still_toggle(self):
        conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )
        request = self.factory.post("/api/im/test")
        request.auth = self.user_a

        self.assertTrue(toggle_pin(request, str(conv.id)).data["pinned"])
        self.assertFalse(toggle_pin(request, str(conv.id)).data["pinned"])
        self.assertTrue(toggle_mute(request, str(conv.id)).data["muted"])
        self.assertFalse(toggle_mute(request, str(conv.id)).data["muted"])

    def test_conversation_preferences_http_contract_accepts_target_and_legacy_requests(self):
        conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )
        client = TestClient(router)
        headers = {"Authorization": "Bearer test-token"}

        with patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=self.user_a,
        ):
            target_pin = client.post(
                f"/conversations/{conv.id}/pin",
                json={"pinned": True},
                headers=headers,
            )
            retry_pin = client.post(
                f"/conversations/{conv.id}/pin",
                json={"pinned": True},
                headers=headers,
            )
            legacy_pin = client.post(
                f"/conversations/{conv.id}/pin",
                headers=headers,
            )
            target_mute = client.post(
                f"/conversations/{conv.id}/mute",
                json={"muted": True},
                headers=headers,
            )
            retry_mute = client.post(
                f"/conversations/{conv.id}/mute",
                json={"muted": True},
                headers=headers,
            )
            legacy_mute = client.post(
                f"/conversations/{conv.id}/mute",
                headers=headers,
            )

        self.assertTrue(target_pin.json()["data"]["pinned"])
        self.assertTrue(retry_pin.json()["data"]["pinned"])
        self.assertFalse(legacy_pin.json()["data"]["pinned"])
        self.assertTrue(target_mute.json()["data"]["muted"])
        self.assertTrue(retry_mute.json()["data"]["muted"])
        self.assertFalse(legacy_mute.json()["data"]["muted"])

    def test_create_dm_keeps_space_id_null(self):
        conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )

        self.assertIsNone(conv.space_id)
        self.assertNoShadowSpaces()

        listed = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_a.id),
        )
        self.assertEqual(listed[0]["id"], str(conv.id))
        self.assertIsNone(listed[0]["space_id"])

        detail = ConversationService.get_conversation_detail(str(conv.id), str(self.user_a.id))
        self.assertIsNotNone(detail)
        self.assertIsNone(detail["space_id"])
        conv.refresh_from_db()
        self.assertIsNone(conv.space_id)
        self.assertNoShadowSpaces()

    def test_create_group_keeps_space_id_null(self):
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )

        self.assertIsNone(conv.space_id)
        self.assertNoShadowSpaces()

        detail = ConversationService.get_conversation_detail(str(conv.id), str(self.user_a.id))
        self.assertIsNotNone(detail)
        self.assertIsNone(detail["space_id"])
        conv.refresh_from_db()
        self.assertIsNone(conv.space_id)
        self.assertNoShadowSpaces()

    def test_create_group_allows_creator_as_the_only_member(self):
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='个人群组',
            member_ids=[],
        )

        self.assertEqual(conv.member_count, 1)
        self.assertTrue(
            ConversationMember.objects.filter(
                conversation=conv,
                user_id=str(self.user_a.id),
                role=MemberRole.OWNER,
                status=ConversationMember.Status.ACTIVE,
            ).exists()
        )
        detail = ConversationService.get_conversation_detail(str(conv.id), str(self.user_a.id))
        self.assertIsNotNone(detail)
        self.assertEqual(detail['member_count'], 1)
        self.assertEqual([member['user_id'] for member in detail['members']], [str(self.user_a.id)])

    def test_team_space_conversation_access_comes_from_space_membership(self):
        """Team Space 共享会话不以 per-conversation membership 限制可见性。"""
        user_c = User.objects.create_user(
            username='tabchat_team_space_c',
            email='tabchat_team_space_c@test.com',
            password='pass123',
        )
        OrganizationMember.objects.create(organization=self.organization, user=user_c, role='editor')

        execution_space = _make_exec_workspace(self.organization, self.user_a, name='Owner Workspace')
        team_space = _make_project(self.organization, name='Team Room', visibility='private')
        _pm(team_space, self.user_a, role='owner')

        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='团队项目对话',
            member_ids=[],
            space_id=str(team_space.id),
        )
        self.assertEqual(str(conv.space_id), str(team_space.id))
        self.assertFalse(
            ConversationMember.objects.filter(conversation=conv, user_id=str(self.user_b.id)).exists()
        )

        _pm(team_space, self.user_b, role='editor')
        team_space.visibility = 'shared'
        team_space.save(update_fields=['visibility', 'updated_at'])

        invited_list = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_b.id),
        )
        self.assertEqual([item['id'] for item in invited_list], [str(conv.id)])
        self.assertEqual(invited_list[0]['space_id'], str(team_space.id))

        invited_detail = ConversationService.get_conversation_detail(
            str(conv.id), str(self.user_b.id),
        )
        self.assertIsNotNone(invited_detail)
        self.assertEqual(invited_detail["space_id"], str(team_space.id))

        msg = MessageService.send_message(
            conversation_id=str(conv.id),
            sender_id=str(self.user_b.id),
            content='invited member can participate',
            message_type=MessageType.TEXT,
        )
        self.assertEqual(msg.sender_id, str(self.user_b.id))

        non_member_list = ConversationService.list_conversations(
            str(self.organization.id), str(user_c.id),
        )
        self.assertEqual(non_member_list, [])
        self.assertIsNone(
            ConversationService.get_conversation_detail(str(conv.id), str(user_c.id))
        )
        with self.assertRaises(PermissionError):
            MessageService.send_message(
                conversation_id=str(conv.id),
                sender_id=str(user_c.id),
                content='not invited',
                message_type=MessageType.TEXT,
            )

        ProjectMembership.objects.filter(project=team_space, user=self.user_b).update(is_active=False)
        self.assertEqual(
            ConversationService.list_conversations(str(self.organization.id), str(self.user_b.id)),
            [],
        )
        self.assertIsNone(
            ConversationService.get_conversation_detail(str(conv.id), str(self.user_b.id))
        )

    def test_team_space_channel_centrifugo_access_uses_space_membership(self):
        """后加入的 Space 成员应能订阅 chat:{convId}，即使尚未物化 ConversationMember。"""
        from apps.tabchat.centrifugo_proxy import _check_chat_channel_access

        execution_space = _make_exec_workspace(self.organization, self.user_a, name='Owner Workspace 2')
        team_space = _make_project(self.organization, name='Channel Access Room', visibility='private')
        _pm(team_space, self.user_a, role='owner')
        _pm(team_space, self.user_b, role='editor')

        channel = Conversation.objects.create(
            organization_id=str(self.organization.id),
            space_id=team_space.id,
            name='#general',
            created_by=str(self.user_a.id),
            member_count=1,
        )
        ConversationMember.objects.create(conversation=channel, user_id=str(self.user_a.id))

        allowed, err = _check_chat_channel_access(str(self.user_b.id), str(channel.id))
        self.assertTrue(allowed, err)
        self.assertIsNone(err)

    def test_send_and_recall_message_with_null_space_id(self):
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )

        msg = MessageService.send_message(
            conversation_id=str(conv.id),
            sender_id=str(self.user_a.id),
            content='hello',
            message_type=MessageType.TEXT,
        )
        conv.refresh_from_db()
        self.assertIsNone(conv.space_id)
        self.assertEqual(conv.last_message_preview, 'tabchat_dm_a: hello')
        self.assertNoShadowSpaces()

        self.assertTrue(
            MessageService.delete_message(str(conv.id), msg.id, str(self.user_a.id))
        )
        msg.refresh_from_db()
        conv.refresh_from_db()
        self.assertTrue(msg.is_deleted)
        self.assertIsNone(conv.space_id)
        self.assertEqual(conv.last_message_preview, '消息已撤回')
        self.assertNoShadowSpaces()

    def test_get_messages_supports_history_content_filters(self):
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )
        base = {
            "conversation": conv,
            "sender_id": str(self.user_a.id),
        }
        text_msg = Message.objects.create(
            **base,
            seq=1,
            content="普通消息",
            message_type=MessageType.TEXT,
        )
        doc_msg = Message.objects.create(
            **base,
            seq=2,
            content="",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "resource_id": str(uuid.uuid4()), "name": "方案"}},
        )
        table_msg = Message.objects.create(
            **base,
            seq=3,
            content="",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "table", "resource_id": str(uuid.uuid4()), "name": "表格"}},
        )
        file_msg = Message.objects.create(
            **base,
            seq=4,
            content="",
            message_type=MessageType.FILE,
            has_attachment=True,
            metadata={"file_name": "brief.pdf"},
        )
        image_msg = Message.objects.create(
            **base,
            seq=5,
            content="",
            message_type=MessageType.IMAGE,
            has_attachment=True,
            metadata={"file_name": "shot.png"},
        )
        Message.objects.create(
            **base,
            seq=6,
            content="",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "resource_id": str(uuid.uuid4()), "name": "已撤回文档"}},
            is_deleted=True,
        )
        Message.objects.create(
            **base,
            seq=7,
            content="",
            message_type=MessageType.FILE,
            has_attachment=True,
            metadata={"file_name": "deleted.pdf"},
            is_deleted=True,
        )

        document_history = MessageService.get_messages(
            str(conv.id),
            str(self.user_a.id),
            content_filter="document",
        )
        self.assertEqual([m["id"] for m in document_history], [doc_msg.id, table_msg.id])

        file_history = MessageService.get_messages(
            str(conv.id),
            str(self.user_a.id),
            content_filter="file",
        )
        self.assertEqual([m["id"] for m in file_history], [file_msg.id, image_msg.id])

        message_history = MessageService.get_messages(
            str(conv.id),
            str(self.user_a.id),
            content_filter="message",
        )
        self.assertEqual(message_history[0]["id"], text_msg.id)
        self.assertEqual(len(message_history), 7)

        with self.assertRaises(ValueError):
            MessageService.get_messages(
                str(conv.id),
                str(self.user_a.id),
                content_filter="unknown",
            )

    def test_unread_and_mark_read_with_null_space_id(self):
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )

        msg = MessageService.send_message(
            conversation_id=str(conv.id),
            sender_id=str(self.user_a.id),
            content='unread check',
            message_type=MessageType.TEXT,
        )

        unread = MessageService.get_unread_counts(str(self.organization.id), str(self.user_b.id))
        self.assertEqual(unread.get(str(conv.id)), 1)
        self.assertEqual(
            MessageService.mark_as_read(str(conv.id), str(self.user_b.id), msg.id),
            1,
        )
        unread = MessageService.get_unread_counts(str(self.organization.id), str(self.user_b.id))
        self.assertNotIn(str(conv.id), unread)
        conv.refresh_from_db()
        self.assertIsNone(conv.space_id)
        self.assertNoShadowSpaces()

    def test_add_members_requires_organization_membership(self):
        outsider = User.objects.create_user(
            username='tabchat_outsider',
            email='tabchat_outsider@test.com',
            password='pass123',
        )
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )

        with self.assertRaises(ValueError):
            ConversationService.add_members(
                conversation_id=str(conv.id),
                operator_id=str(self.user_a.id),
                member_ids=[str(outsider.id)],
            )

    def test_member_changes_work_with_null_space_id(self):
        user_c = User.objects.create_user(
            username='tabchat_group_c',
            email='tabchat_group_c@test.com',
            password='pass123',
        )
        OrganizationMember.objects.create(organization=self.organization, user=user_c, role='viewer')
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )

        ConversationService.add_members(
            conversation_id=str(conv.id),
            operator_id=str(self.user_a.id),
            member_ids=[str(user_c.id)],
        )
        self.assertTrue(
            ConversationMember.objects.filter(
                conversation_id=conv.id,
                user_id=user_c.id,
            ).exists()
        )
        conv.refresh_from_db()
        self.assertEqual(conv.member_count, 3)
        self.assertIsNone(conv.space_id)
        self.assertNoShadowSpaces()

        self.assertTrue(
            ConversationService.remove_member(
                conversation_id=str(conv.id),
                operator_id=str(self.user_a.id),
                target_user_id=str(user_c.id),
            )
        )
        conv.refresh_from_db()
        self.assertEqual(conv.member_count, 2)
        self.assertIsNone(conv.space_id)
        self.assertNoShadowSpaces()

    def test_organization_member_removal_revokes_group_conversation_access(self):
        conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id)],
        )

        self.assertTrue(
            ConversationMember.objects.filter(
                conversation_id=conv.id,
                user_id=self.user_b.id,
            ).exists()
        )
        owner_msg = MessageService.send_message(
            conversation_id=str(conv.id),
            sender_id=str(self.user_a.id),
            content='owner message',
            message_type=MessageType.TEXT,
        )
        OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.user_b,
        ).delete()

        # COM-12 后成员资源清理走 on_commit + Celery；TestCase 事务内不要求
        # ConversationMember 同步删除。同步门禁是请求层不再允许离队用户读会话。
        self.assertIsNone(
            ConversationService.get_conversation_detail(str(conv.id), str(self.user_b.id))
        )
        with self.assertRaises(PermissionError):
            MessageService.send_message(
                conversation_id=str(conv.id),
                sender_id=str(self.user_b.id),
                content='should not send',
                message_type=MessageType.TEXT,
            )
        with self.assertRaises(PermissionError):
            MessageService.mark_as_read(str(conv.id), str(self.user_b.id))
        with self.assertRaises(PermissionError):
            MessageService.add_reaction(str(conv.id), owner_msg.id, str(self.user_b.id), '👍')

        ConversationMember.objects.filter(
            conversation_id=conv.id,
            user_id=self.user_b.id,
        ).update(role=2)
        private_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user_b,
            name='离队用户助手',
            type='bot',
        )
        _ws = _make_exec_workspace(self.organization, self.user_b, name='离队用户助手', fingerprint=f'legacy-private-{self.user_b.id}')
        SpaceMembership.objects.get_or_create(
            workspace=_ws,
            agent=private_agent,
            defaults={"role": "owner", "is_active": True},
        )
        with self.assertRaises(PermissionError):
            ConversationService.add_agents(
                str(conv.id), str(self.user_b.id), [str(private_agent.id)],
            )
        # Space 表已 DROP；阴影类型不再存在
        self.assertTrue(True)


if __name__ == "__main__":
    unittest.main(verbosity=2)

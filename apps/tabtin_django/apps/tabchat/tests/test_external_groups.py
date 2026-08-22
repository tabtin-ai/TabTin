from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.db import close_old_connections
from django.test import TestCase, TransactionTestCase

from apps.tabchat.constants import IMEventType, MessageType
from apps.tabchat.centrifugo_proxy import _check_chat_channel_access
from apps.tabchat.models import (
    Conversation,
    ConversationMember,
    ConversationMembershipWindow,
    ExternalContact,
    IMEventOutbox,
)
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.label_service import LabelService
from apps.tabchat.services.message_service import MessageService
from apps.tabchat.services.profile_sync_service import publish_user_profile_updated
from apps.tabchat.services.team_space_task_service import (
    create_agent_task_thread_from_channel_message,
)
from apps.tabtinspace.models import Organization, OrganizationMember


User = get_user_model()


class ExternalGroupTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        self.owner = User.objects.create_user(
            email="external-group-owner@example.com",
            password="pass123",
            nickname="Owner",
        )
        self.internal = User.objects.create_user(
            email="external-group-internal@example.com",
            password="pass123",
            nickname="Internal",
        )
        self.later_member = User.objects.create_user(
            email="external-group-later@example.com",
            password="pass123",
            nickname="Later",
        )
        self.external = User.objects.create_user(
            email="external-group-peer@example.com",
            password="pass123",
            nickname="External",
        )
        self.host_organization = Organization.objects.create(
            name="Host Organization",
            owner=self.owner,
        )
        self.peer_organization = Organization.objects.create(
            name="Peer Organization",
            owner=self.external,
        )
        for user, role in (
            (self.owner, "owner"),
            (self.internal, "editor"),
            (self.later_member, "editor"),
        ):
            OrganizationMember.objects.create(
                organization=self.host_organization,
                user=user,
                role=role,
            )
        OrganizationMember.objects.create(
            organization=self.peer_organization,
            user=self.external,
            role="owner",
        )
        self.contact = ExternalContact.objects.create(
            owner_user=self.owner,
            peer_user=self.external,
            peer_organization=self.peer_organization,
            relationship=ExternalContact.Relationship.FRIEND,
        )

    def create_external_group(self):
        with patch(
            "apps.services.billing.services.entitlement_limits_service."
            "EntitlementLimitsService.check_group_limit",
        ):
            return ConversationService.create_group(
                organization_id=str(self.host_organization.id),
                creator_id=str(self.owner.id),
                name="External Project",
                member_ids=[str(self.internal.id)],
                external_contact_ids=[str(self.contact.id)],
            )

    def test_create_external_group_keeps_external_user_out_of_host_organization(self):
        conversation = self.create_external_group()

        self.assertTrue(conversation.is_external)
        self.assertFalse(
            OrganizationMember.objects.filter(
                organization=self.host_organization,
                user=self.external,
            ).exists(),
        )
        members = {
            str(member.user_id): member
            for member in ConversationMember.objects.filter(conversation=conversation)
        }
        self.assertEqual(
            members[str(self.external.id)].participant_organization_id,
            str(self.peer_organization.id),
        )
        self.assertEqual(
            members[str(self.external.id)].status,
            ConversationMember.Status.ACTIVE,
        )
        self.assertEqual(
            ConversationMembershipWindow.objects.filter(
                conversation_member__conversation=conversation,
            ).count(),
            3,
        )

    def test_external_member_can_access_without_host_organization_membership(self):
        conversation = self.create_external_group()

        access = ConversationAccessResolver.resolve(conversation, str(self.external.id))

        self.assertTrue(access.can_view_history)
        self.assertTrue(access.can_subscribe)
        self.assertTrue(access.can_send)
        self.assertFalse(access.can_manage)

        non_member_access = ConversationAccessResolver.resolve(
            conversation,
            str(self.later_member.id),
        )
        self.assertFalse(non_member_access.can_view_history)
        self.assertEqual(
            _check_chat_channel_access(
                str(self.later_member.id),
                str(conversation.id),
            ),
            (False, "not a member of this conversation"),
        )
        with self.assertRaises(PermissionError):
            MessageService.get_messages(
                str(conversation.id),
                str(self.later_member.id),
            )

    def test_external_directory_keeps_recalled_latest_message_as_latest(self):
        conversation = self.create_external_group()
        MessageService.send_message(
            str(conversation.id),
            str(self.owner.id),
            "外部群上一条",
        )
        latest = MessageService.send_message(
            str(conversation.id),
            str(self.owner.id),
            "外部群最新待撤回",
        )

        MessageService.delete_message(
            str(conversation.id),
            latest.id,
            str(self.owner.id),
        )

        item = next(
            item
            for item in ConversationService.list_conversations(
                str(self.peer_organization.id),
                str(self.external.id),
            )
            if item["id"] == str(conversation.id)
        )
        self.assertEqual(item["last_message_id"], str(latest.id))
        self.assertEqual(item["last_message_seq"], latest.seq)
        self.assertEqual(item["last_message_preview"], "消息已撤回")

    def test_personal_realtime_events_use_each_external_members_directory_scope(self):
        conversation = self.create_external_group()
        external_channel = f"personal:{self.external.id}"
        created_event = next(
            event
            for event in IMEventOutbox.objects.filter(
                conversation=conversation,
                event_type=IMEventType.CONVERSATION_NEW,
            )
            if external_channel in event.target_channels
        )
        self.assertEqual(
            created_event.payload["data"]["organization_id"],
            str(self.host_organization.id),
        )
        self.assertEqual(
            created_event.payload["data"]["directory_scope_id"],
            str(self.peer_organization.id),
        )

        message = MessageService.send_message(
            conversation_id=str(conversation.id),
            sender_id=str(self.owner.id),
            content="跨组织实时更新",
        )
        unread_event = next(
            event
            for event in IMEventOutbox.objects.filter(
                conversation=conversation,
                message=message,
                event_type=IMEventType.UNREAD_UPDATE,
            )
            if external_channel in event.target_channels
        )
        self.assertEqual(
            unread_event.payload["data"]["directory_scope_id"],
            str(self.peer_organization.id),
        )

    def test_external_group_management_uses_group_roles(self):
        conversation = self.create_external_group()

        with self.assertRaisesRegex(PermissionError, "只有管理员"):
            ConversationService.update_conversation(
                str(conversation.id),
                str(self.internal.id),
                name="not allowed",
            )
        with self.assertRaisesRegex(PermissionError, "只有管理员"):
            ConversationService.remove_member(
                conversation_id=str(conversation.id),
                operator_id=str(self.internal.id),
                target_user_id=str(self.external.id),
            )

        updated = ConversationService.update_conversation(
            str(conversation.id),
            str(self.owner.id),
            name="Owner Updated",
        )
        self.assertEqual(updated.name, "Owner Updated")

    def test_external_group_rejects_contact_not_owned_by_creator(self):
        unrelated = ExternalContact.objects.create(
            owner_user=self.internal,
            peer_user=self.external,
            peer_organization=self.peer_organization,
            relationship=ExternalContact.Relationship.FRIEND,
        )

        with self.assertRaisesRegex(PermissionError, "外部联系人不可邀请") as raised:
            self.create_group_with_contacts([str(unrelated.id)])
        self.assertEqual(raised.exception.error_code, "EXTERNAL_CONTACT_NOT_INVITABLE")

    def test_external_group_rejects_non_friend_contact(self):
        self.contact.relationship = ExternalContact.Relationship.REMOVED
        self.contact.save(update_fields=["relationship", "updated_at"])

        with self.assertRaisesRegex(PermissionError, "外部联系人不可邀请") as raised:
            self.create_group_with_contacts([str(self.contact.id)])
        self.assertEqual(raised.exception.error_code, "EXTERNAL_CONTACT_NOT_INVITABLE")

    def test_external_group_creation_is_idempotent(self):
        request_id = "external-group-create-1"

        first = self.create_group_with_contacts(
            [str(self.contact.id)],
            client_request_id=request_id,
        )
        second = self.create_group_with_contacts(
            [str(self.contact.id)],
            client_request_id=request_id,
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(
            ConversationMember.objects.filter(conversation=first).count(),
            3,
        )
        self.assertEqual(
            ConversationMembershipWindow.objects.filter(
                conversation_member__conversation=first,
            ).count(),
            3,
        )

    def test_join_and_leave_windows_limit_message_history(self):
        conversation = self.create_external_group()
        before_message = MessageService.send_message(
            conversation_id=str(conversation.id),
            sender_id=str(self.owner.id),
            content="before later member",
        )
        MessageService.pin_message(
            str(conversation.id),
            before_message.id,
            str(self.owner.id),
        )

        ConversationService.add_members(
            conversation_id=str(conversation.id),
            operator_id=str(self.owner.id),
            member_ids=[str(self.later_member.id)],
        )
        visible_message = MessageService.send_message(
            conversation_id=str(conversation.id),
            sender_id=str(self.owner.id),
            content="visible to later member",
            reply_to_id=before_message.id,
        )

        later_contents = {
            message["content"]
            for message in MessageService.get_messages(
                str(conversation.id),
                str(self.later_member.id),
            )
        }
        self.assertNotIn("before later member", later_contents)
        self.assertIn("visible to later member", later_contents)
        later_messages = MessageService.get_messages(
            str(conversation.id),
            str(self.later_member.id),
        )
        visible_payload = next(
            message for message in later_messages
            if message["id"] == visible_message.id
        )
        self.assertTrue(visible_payload["reply_to_preview"]["is_unavailable"])
        self.assertEqual(
            MessageService.list_pinned_messages(
                str(conversation.id),
                str(self.later_member.id),
            ),
            [],
        )
        self.assertEqual(
            MessageService.search_messages(
                str(self.host_organization.id),
                str(self.later_member.id),
                "before later",
                conversation_id=str(conversation.id),
            ),
            [],
        )
        with self.assertRaisesRegex(ValueError, "当前成员不可见"):
            MessageService.send_message(
                conversation_id=str(conversation.id),
                sender_id=str(self.later_member.id),
                content="invalid reply",
                reply_to_id=before_message.id,
            )
        with patch(
            "apps.services.billing.services.entitlement_limits_service."
            "EntitlementLimitsService.check_group_limit",
        ):
            internal_target = ConversationService.create_group(
                organization_id=str(self.host_organization.id),
                creator_id=str(self.later_member.id),
                name="Internal target",
                member_ids=[str(self.owner.id)],
            )
        with self.assertRaisesRegex(PermissionError, "无权转发"):
            MessageService.send_message(
                conversation_id=str(internal_target.id),
                sender_id=str(self.later_member.id),
                content="invalid forward",
                metadata={
                    "forwarded_from": {
                        "original_message_id": before_message.id,
                        "original_conversation_id": str(conversation.id),
                    },
                },
            )

        ConversationService.remove_member(
            conversation_id=str(conversation.id),
            operator_id=str(self.owner.id),
            target_user_id=str(self.external.id),
        )
        after_message = MessageService.send_message(
            conversation_id=str(conversation.id),
            sender_id=str(self.owner.id),
            content="after external removal",
            metadata={"mention_all": True},
        )

        external_contents = {
            message["content"]
            for message in MessageService.get_messages(
                str(conversation.id),
                str(self.external.id),
            )
        }
        self.assertNotIn("after external removal", external_contents)
        self.assertIn("visible to later member", external_contents)
        removed_access = ConversationAccessResolver.resolve(
            conversation,
            str(self.external.id),
        )
        self.assertTrue(removed_access.can_view_history)
        self.assertFalse(removed_access.can_subscribe)
        self.assertFalse(removed_access.can_send)
        external_list_item = next(
            item
            for item in ConversationService.list_conversations(
                str(self.peer_organization.id),
                str(self.external.id),
            )
            if item["id"] == str(conversation.id)
        )
        self.assertNotIn(
            "after external removal",
            external_list_item["last_message_preview"],
        )
        self.assertNotEqual(
            external_list_item["last_message_id"],
            str(after_message.id),
        )
        external_detail = ConversationService.get_conversation_detail(
            str(conversation.id),
            str(self.external.id),
        )
        self.assertNotIn(
            "after external removal",
            external_detail["last_message_preview"],
        )
        self.assertFalse(
            LabelService.has_unread_mention(
                str(conversation.id),
                str(self.external.id),
            ),
        )
        with patch(
            "apps.tabchat.services.profile_sync_service.IMOutboxService.enqueue",
        ) as enqueue:
            publish_user_profile_updated(self.external)
        enqueue.assert_not_called()

    def test_external_group_rejects_rich_messages_and_agents(self):
        conversation = self.create_external_group()

        with self.assertRaisesRegex(ValueError, "外部群仅支持普通消息") as raised:
            MessageService.send_message(
                conversation_id=str(conversation.id),
                sender_id=str(self.owner.id),
                content="file",
                message_type=MessageType.FILE,
                metadata={"file_id": "fake-file"},
            )
        self.assertEqual(
            raised.exception.error_code,
            "EXTERNAL_GROUP_CAPABILITY_NOT_SUPPORTED",
        )

        with self.assertRaisesRegex(ValueError, "外部群仅支持普通消息"):
            MessageService.send_message(
                conversation_id=str(conversation.id),
                sender_id=str(self.owner.id),
                content="resource card",
                metadata={"card": {"type": "document", "resource_id": "fake"}},
            )

        with self.assertRaisesRegex(ValueError, "外部群仅支持普通消息"):
            MessageService.send_message(
                conversation_id=str(conversation.id),
                sender_id=str(self.owner.id),
                content="@Agent",
                metadata={"mentioned_agent_ids": ["00000000-0000-0000-0000-000000000001"]},
            )

        with self.assertRaisesRegex(ValueError, "外部群不能添加 AI 助手"):
            ConversationService.add_agents(
                conversation_id=str(conversation.id),
                operator_id=str(self.owner.id),
                agent_ids=["00000000-0000-0000-0000-000000000001"],
            )

        with self.assertRaisesRegex(ValueError, "外部群不能发起 Agent 任务"):
            create_agent_task_thread_from_channel_message(
                conversation_id=str(conversation.id),
                message_id=0,
                actor_user=self.owner,
            )

    def test_external_group_allows_plain_text_forward(self):
        target = self.create_external_group()
        with patch(
            "apps.services.billing.services.entitlement_limits_service."
            "EntitlementLimitsService.check_group_limit",
        ):
            source_conversation = ConversationService.create_group(
                organization_id=str(self.host_organization.id),
                creator_id=str(self.owner.id),
                name="Internal Source",
                member_ids=[str(self.internal.id)],
            )
        source_message = MessageService.send_message(
            conversation_id=str(source_conversation.id),
            sender_id=str(self.owner.id),
            content="plain source text",
        )

        forwarded = MessageService.send_message(
            conversation_id=str(target.id),
            sender_id=str(self.owner.id),
            content=source_message.content,
            metadata={
                "forwarded_from": {
                    "original_message_id": source_message.id,
                    "original_conversation_id": str(source_conversation.id),
                    "original_conversation_name": "Forged Conversation",
                    "original_sender_id": str(self.external.id),
                    "original_sender_name": "Forged Sender",
                },
            },
        )

        self.assertEqual(forwarded.content, "plain source text")
        self.assertEqual(
            forwarded.metadata["forwarded_from"]["original_message_id"],
            source_message.id,
        )
        self.assertEqual(
            forwarded.metadata["forwarded_from"]["original_conversation_id"],
            str(source_conversation.id),
        )
        self.assertEqual(
            forwarded.metadata["forwarded_from"]["original_conversation_name"],
            source_conversation.name,
        )
        self.assertEqual(
            forwarded.metadata["forwarded_from"]["original_sender_id"],
            str(self.owner.id),
        )

    def test_external_member_lists_group_from_their_organization_context(self):
        conversation = self.create_external_group()
        unrelated_organization = Organization.objects.create(
            name="Unrelated External Organization",
            owner=self.external,
        )

        listed = ConversationService.list_conversations(
            str(self.peer_organization.id),
            str(self.external.id),
        )

        self.assertIn(str(conversation.id), {item["id"] for item in listed})
        item = next(item for item in listed if item["id"] == str(conversation.id))
        self.assertTrue(item["is_external"])
        self.assertEqual(item["organization_id"], str(self.host_organization.id))
        self.assertEqual(
            item["participant_organization_id"],
            str(self.peer_organization.id),
        )
        self.assertEqual(
            item["directory_scope_id"],
            str(self.peer_organization.id),
        )
        self.assertNotIn(
            str(conversation.id),
            {
                item["id"]
                for item in ConversationService.list_conversations(
                    str(unrelated_organization.id),
                    str(self.external.id),
                )
            },
        )
        detail = ConversationService.get_conversation_detail(
            str(conversation.id),
            str(self.external.id),
        )
        self.assertEqual(
            detail["participant_organization_id"],
            str(self.peer_organization.id),
        )

    def test_unread_and_search_use_external_member_directory_scope(self):
        conversation = self.create_external_group()
        MessageService.send_message(
            conversation_id=str(conversation.id),
            sender_id=str(self.owner.id),
            content="目录隔离标记",
        )
        unrelated_organization = Organization.objects.create(
            name="Unrelated Search Organization",
            owner=self.external,
        )
        OrganizationMember.objects.create(
            organization=unrelated_organization,
            user=self.external,
            role="owner",
        )

        self.assertIn(
            str(conversation.id),
            MessageService.get_unread_counts(
                str(self.peer_organization.id),
                str(self.external.id),
            ),
        )
        self.assertNotIn(
            str(conversation.id),
            MessageService.get_unread_counts(
                str(unrelated_organization.id),
                str(self.external.id),
            ),
        )
        self.assertEqual(
            {
                item["conversation_id"]
                for item in MessageService.search_messages(
                    str(self.peer_organization.id),
                    str(self.external.id),
                    "目录隔离标记",
                )
            },
            {str(conversation.id)},
        )
        self.assertEqual(
            MessageService.search_messages(
                str(unrelated_organization.id),
                str(self.external.id),
                "目录隔离标记",
            ),
            [],
        )
        self.assertEqual(
            {
                group["conversation_id"]
                for group in MessageService.search_message_groups(
                    str(self.peer_organization.id),
                    str(self.external.id),
                    "目录隔离标记",
                )["groups"]
            },
            {str(conversation.id)},
        )
        self.assertEqual(
            MessageService.search_message_groups(
                str(unrelated_organization.id),
                str(self.external.id),
                "目录隔离标记",
            )["groups"],
            [],
        )

    def create_group_with_contacts(self, external_contact_ids, **kwargs):
        with patch(
            "apps.services.billing.services.entitlement_limits_service."
            "EntitlementLimitsService.check_group_limit",
        ):
            return ConversationService.create_group(
                organization_id=str(self.host_organization.id),
                creator_id=str(self.owner.id),
                name="External Project",
                member_ids=[str(self.internal.id)],
                external_contact_ids=external_contact_ids,
                **kwargs,
            )


class ExternalGroupConcurrencyTests(TransactionTestCase):
    databases = ["default", "postgresql"]
    # TabData 的退役辅助表按设计保留在数据库中，但已不在 Django 模型状态里。
    # 显式声明可用 App 会让 TransactionTestCase teardown 使用 TRUNCATE CASCADE，
    # 避免这些历史表的外键阻断并发用例清库。
    available_apps = [app.name for app in django_apps.get_app_configs()]

    def setUp(self):
        self.owner = User.objects.create_user(
            email="external-group-concurrent-owner@example.com",
            password="pass123",
            nickname="Owner",
        )
        self.external = User.objects.create_user(
            email="external-group-concurrent-peer@example.com",
            password="pass123",
            nickname="External",
        )
        self.host_organization = Organization.objects.create(
            name="Concurrent Host Organization",
            owner=self.owner,
        )
        self.peer_organization = Organization.objects.create(
            name="Concurrent Peer Organization",
            owner=self.external,
        )
        OrganizationMember.objects.create(
            organization=self.host_organization,
            user=self.owner,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.peer_organization,
            user=self.external,
            role="owner",
        )
        self.contact = ExternalContact.objects.create(
            owner_user=self.owner,
            peer_user=self.external,
            peer_organization=self.peer_organization,
            relationship=ExternalContact.Relationship.FRIEND,
        )

    def test_concurrent_group_creation_reuses_idempotency_key(self):
        barrier = Barrier(2)
        request_id = "external-group-concurrent-create"

        def create_group() -> str:
            close_old_connections()
            try:
                barrier.wait()
                conversation = ConversationService.create_group(
                    organization_id=str(self.host_organization.id),
                    creator_id=str(self.owner.id),
                    name="Concurrent External Group",
                    member_ids=[],
                    external_contact_ids=[str(self.contact.id)],
                    client_request_id=request_id,
                )
                return str(conversation.id)
            finally:
                close_old_connections()

        with patch(
            "apps.services.billing.services.entitlement_limits_service."
            "EntitlementLimitsService.check_group_limit",
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(create_group) for _ in range(2)]
                conversation_ids = [future.result(timeout=20) for future in futures]

        self.assertEqual(len(set(conversation_ids)), 1)
        conversation = Conversation.objects.get(
            organization_id=self.host_organization.id,
            created_by=str(self.owner.id),
            creation_request_id=request_id,
        )
        self.assertEqual(
            ConversationMember.objects.filter(conversation=conversation).count(),
            2,
        )
        self.assertEqual(
            ConversationMembershipWindow.objects.filter(
                conversation_member__conversation=conversation,
            ).count(),
            2,
        )

"""DM/GROUP 精简消息模型、幂等、水位和 IM Outbox 核心契约。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import MagicMock, patch

import requests
from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from apps.tabchat.constants import ConversationType, IMEventType, MemberRole, MessageType
from apps.tabchat.models import (
    Conversation,
    ConversationMember,
    ConversationUserState,
    IMEventOutbox,
    Message,
    MessageMention,
    MessageUserState,
)
from apps.tabchat.services.im_outbox_service import (
    OUTBOX_MAX_ATTEMPTS,
    IMOutboxService,
)
from apps.tabchat.services.centrifugo_service import CentrifugoService
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import (
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
)
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "tabchat message refactor tests",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


class MessageRefactorContractTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.sender = User.objects.create_user(
            username="msg_refactor_sender",
            email="msg-refactor-sender@test.com",
            password="pass123",
        )
        self.receiver = User.objects.create_user(
            username="msg_refactor_receiver",
            email="msg-refactor-receiver@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="Message Refactor",
            owner=self.sender,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.sender,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.receiver,
            role="editor",
        )
        self.conversation = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="消息重构群",
            created_by=str(self.sender.id),
            member_count=2,
        )
        ConversationMember.objects.bulk_create(
            [
                ConversationMember(
                    conversation=self.conversation,
                    user_id=str(self.sender.id),
                    role=MemberRole.OWNER,
                ),
                ConversationMember(
                    conversation=self.conversation,
                    user_id=str(self.receiver.id),
                    role=MemberRole.MEMBER,
                ),
            ]
        )

    def test_plain_message_writes_one_message_and_three_outbox_batches(self):
        extra_users = [
            User(
                username=f"msg_refactor_member_{index}",
                email=f"msg-refactor-member-{index}@test.com",
            )
            for index in range(1, 49)
        ]
        User.objects.bulk_create(extra_users)
        OrganizationMember.objects.bulk_create(
            [
                OrganizationMember(
                    organization=self.organization,
                    user=user,
                    role="editor",
                )
                for user in extra_users
            ]
        )
        ConversationMember.objects.bulk_create(
            [
                ConversationMember(
                    conversation=self.conversation,
                    user_id=str(user.id),
                    role=MemberRole.MEMBER,
                )
                for user in extra_users
            ]
        )
        self.conversation.member_count = 50
        self.conversation.save(update_fields=["member_count"])

        message = MessageService.send_message(
            conversation_id=str(self.conversation.id),
            sender_id=str(self.sender.id),
            content="50 人群普通消息",
            client_request_id="plain-50-members",
        )

        self.assertEqual(Message.objects.filter(conversation=self.conversation).count(), 1)
        self.assertEqual(message.seq, 1)
        self.assertFalse(MessageUserState.objects.filter(message=message).exists())
        self.assertFalse(MessageMention.objects.filter(message=message).exists())
        outboxes = list(IMEventOutbox.objects.filter(message=message))
        self.assertEqual(len(outboxes), 3)
        chat = next(row for row in outboxes if row.event_type == IMEventType.MESSAGE)
        personal = next(
            row for row in outboxes if row.event_type == IMEventType.UNREAD_UPDATE
        )
        self.assertEqual(chat.target_channels, [f"chat:{self.conversation.id}"])
        self.assertEqual(len(personal.target_channels), 49)
        self.assertEqual(
            personal.payload["data"]["last_message_at"],
            message.created_at.isoformat(),
        )

    def test_send_notifies_sender_directory_without_incrementing_own_unread(self):
        message = MessageService.send_message(
            conversation_id=str(self.conversation.id),
            sender_id=str(self.sender.id),
            content="我发出的最新消息",
            client_request_id="sender-directory-preview",
        )

        sender_update = IMEventOutbox.objects.get(
            message=message,
            event_type=IMEventType.CONVERSATION_PREVIEW_UPDATED,
        )
        self.conversation.refresh_from_db()
        self.assertEqual(sender_update.target_channels, [f"personal:{self.sender.id}"])
        self.assertEqual(sender_update.payload["data"]["message_seq"], message.seq)
        self.assertEqual(
            sender_update.payload["data"]["last_message_at"],
            message.created_at.isoformat(),
        )
        self.assertEqual(
            sender_update.payload["data"]["preview"],
            self.conversation.last_message_preview,
        )
        self.assertFalse(
            IMEventOutbox.objects.filter(
                message=message,
                event_type=IMEventType.UNREAD_UPDATE,
                target_channels__contains=[f"personal:{self.sender.id}"],
            ).exists()
        )

    def test_duplicate_client_request_returns_canonical_message(self):
        first = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "第一次",
            client_request_id="same-request",
        )
        second = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "重复请求不应覆盖",
            client_request_id="same-request",
        )

        self.assertEqual(second.id, first.id)
        self.assertEqual(second.seq, first.seq)
        self.assertEqual(Message.objects.filter(conversation=self.conversation).count(), 1)
        self.assertEqual(IMEventOutbox.objects.filter(message=first).count(), 3)
        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.latest_message_seq, 1)

    def test_resolve_message_references_returns_string_ids_in_request_order(self):
        first = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "第一条正文",
            metadata={
                "message_ref": "11111111-1111-4111-8111-111111111111",
                "source_message_id": "9007199254740993",
            },
            client_request_id="resolve-first",
        )
        second = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "第二条正文",
            metadata={"message_ref": "22222222-2222-4222-8222-222222222222"},
            client_request_id="resolve-second",
        )

        items = MessageService.resolve_message_references(
            conversation_id=str(self.conversation.id),
            user_id=str(self.receiver.id),
            message_ids=[str(second.id), str(first.id)],
        )

        self.assertEqual([item["id"] for item in items], [str(second.id), str(first.id)])
        self.assertTrue(all(isinstance(item["id"], str) for item in items))
        self.assertEqual(items[1]["metadata"]["source_message_id"], "9007199254740993")
        self.assertEqual(items[0]["metadata"]["kind"], "tabtin_ref")
        self.assertEqual(items[0]["metadata"]["tabtin_message_id"], str(second.id))
        self.assertEqual(
            items[0]["metadata"]["message_ref"],
            "22222222-2222-4222-8222-222222222222",
        )
        self.assertEqual(items[0]["sender"]["id"], str(self.sender.id))
        self.assertEqual(items[0]["sender"]["type"], "user")

    def test_resolve_message_references_rejects_cross_conversation_ids(self):
        referenced = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "本群消息",
            client_request_id="resolve-own-conversation",
        )
        other_conversation = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="另一个群",
            created_by=str(self.sender.id),
            member_count=1,
        )
        ConversationMember.objects.create(
            conversation=other_conversation,
            user_id=str(self.sender.id),
            role=MemberRole.OWNER,
        )
        foreign = MessageService.send_message(
            str(other_conversation.id),
            str(self.sender.id),
            "另一个群的消息",
            client_request_id="resolve-foreign-conversation",
        )

        with self.assertRaisesRegex(ValueError, "不属于该会话"):
            MessageService.resolve_message_references(
                conversation_id=str(self.conversation.id),
                user_id=str(self.receiver.id),
                message_ids=[str(referenced.id), str(foreign.id)],
            )

    def test_resolve_message_references_honors_personal_visibility(self):
        hidden = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "已对当前用户隐藏",
            client_request_id="resolve-hidden",
        )
        MessageUserState.objects.create(
            message=hidden,
            user_id=str(self.receiver.id),
            hidden=True,
        )

        items = MessageService.resolve_message_references(
            conversation_id=str(self.conversation.id),
            user_id=str(self.receiver.id),
            message_ids=[str(hidden.id)],
        )

        self.assertEqual(items, [])

    def test_resolve_message_references_rejects_invalid_message_ref(self):
        invalid = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "不是有效引用",
            metadata={"message_ref": "not-a-uuid"},
            client_request_id="resolve-invalid-message-ref",
        )

        with self.assertRaisesRegex(ValueError, "有效的 message_ref"):
            MessageService.resolve_message_references(
                conversation_id=str(self.conversation.id),
                user_id=str(self.receiver.id),
                message_ids=[str(invalid.id)],
            )

    def test_resolve_message_references_validates_decimal_strings_and_limit(self):
        for invalid in (["0"], ["01"], ["1.5"], ["９"]):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    MessageService.resolve_message_references(
                        conversation_id=str(self.conversation.id),
                        user_id=str(self.receiver.id),
                        message_ids=invalid,
                    )
        with self.assertRaisesRegex(ValueError, "最多 50 条"):
            MessageService.resolve_message_references(
                conversation_id=str(self.conversation.id),
                user_id=str(self.receiver.id),
                message_ids=[str(index) for index in range(1, 52)],
            )

    def test_reply_preview_marks_recalled_source_unavailable_without_calling_it_attachment(self):
        source = MessageService.send_message(
            str(self.conversation.id), str(self.sender.id), "原始文本", client_request_id="reply-source"
        )
        reply = MessageService.send_message(
            str(self.conversation.id),
            str(self.receiver.id),
            "回复原始文本",
            reply_to_id=source.id,
            client_request_id="reply-child",
        )

        history = MessageService.get_messages(str(self.conversation.id), str(self.sender.id))
        preview = next(item for item in history if item["id"] == reply.id)["reply_to_preview"]
        self.assertEqual(preview["content"], "原始文本")
        self.assertFalse(preview["is_unavailable"])
        self.assertEqual(preview["message_type"], MessageType.TEXT)

        Message.objects.filter(pk=source.id).update(is_deleted=True)
        history = MessageService.get_messages(str(self.conversation.id), str(self.sender.id))
        preview = next(item for item in history if item["id"] == reply.id)["reply_to_preview"]
        self.assertEqual(preview["content"], "消息内容不可用")
        self.assertTrue(preview["is_unavailable"])
        self.assertFalse(preview["has_attachment"])

    def test_reply_preview_does_not_restore_cleared_history(self):
        source = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "清空后不可恢复的引用原文",
        )
        ConversationService.clear_history(
            str(self.conversation.id),
            str(self.receiver.id),
        )
        reply = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "新消息仍可回复旧消息",
            reply_to_id=source.id,
        )

        history = MessageService.get_messages(
            str(self.conversation.id),
            str(self.receiver.id),
        )
        preview = next(item for item in history if item["id"] == reply.id)["reply_to_preview"]

        self.assertEqual(preview["content"], "消息内容不可用")
        self.assertEqual(preview["sender_id"], "")
        self.assertTrue(preview["is_unavailable"])
        self.assertFalse(preview["has_attachment"])

    def test_reply_preview_does_not_restore_hidden_message(self):
        source = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "隐藏后不可恢复的引用原文",
        )
        MessageService.set_message_hidden(
            str(self.conversation.id),
            source.id,
            str(self.receiver.id),
            True,
        )
        reply = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "新消息仍可回复隐藏消息",
            reply_to_id=source.id,
        )

        history = MessageService.get_messages(
            str(self.conversation.id),
            str(self.receiver.id),
        )
        preview = next(item for item in history if item["id"] == reply.id)["reply_to_preview"]

        self.assertEqual(preview["content"], "消息内容不可用")
        self.assertEqual(preview["sender_id"], "")
        self.assertTrue(preview["is_unavailable"])
        self.assertFalse(preview["has_attachment"])

    def test_realtime_reply_preview_never_contains_source_content(self):
        source = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "实时通道不可泄露的引用原文",
        )
        reply = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "实时回复",
            reply_to_id=source.id,
        )

        event = IMEventOutbox.objects.get(
            message=reply,
            event_type=IMEventType.MESSAGE,
        )
        preview = event.payload["data"]["reply_to_preview"]

        self.assertEqual(preview["content"], "消息内容不可用")
        self.assertEqual(preview["sender_id"], "")
        self.assertTrue(preview["is_unavailable"])
        self.assertFalse(preview["has_attachment"])
        self.assertNotIn(source.content, str(event.payload))

    def test_read_watermark_is_monotonic_and_single_row(self):
        first = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "第一条",
        )
        second = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "第二条",
        )

        self.assertEqual(
            MessageService.mark_as_read(
                str(self.conversation.id),
                str(self.receiver.id),
                second.id,
            ),
            2,
        )
        self.assertEqual(
            MessageService.mark_as_read(
                str(self.conversation.id),
                str(self.receiver.id),
                first.id,
            ),
            0,
        )
        states = ConversationUserState.objects.filter(
            conversation=self.conversation,
            user_id=str(self.receiver.id),
        )
        self.assertEqual(states.count(), 1)
        self.assertEqual(states.get().last_read_seq, second.seq)

    def test_mark_read_without_message_id_emits_canonical_receipt_message(self):
        dm = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.DM,
            created_by=str(self.sender.id),
            member_count=2,
        )
        ConversationMember.objects.bulk_create(
            [
                ConversationMember(conversation=dm, user_id=str(self.sender.id)),
                ConversationMember(conversation=dm, user_id=str(self.receiver.id)),
            ]
        )
        message = MessageService.send_message(
            str(dm.id),
            str(self.sender.id),
            "需要已读回执",
        )

        MessageService.mark_as_read(str(dm.id), str(self.receiver.id), None)

        receipt = IMEventOutbox.objects.get(
            conversation=dm,
            event_type=IMEventType.READ_RECEIPT,
        )
        self.assertEqual(receipt.payload["data"]["last_read_message_id"], message.id)
        self.assertEqual(receipt.payload["data"]["last_read_seq"], message.seq)
        self.assertEqual(receipt.payload["data"]["previous_last_read_seq"], 0)

    def test_retracted_message_no_longer_counts_as_unread(self):
        message = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "撤回后不应继续计未读",
        )
        self.assertEqual(
            MessageService.get_unread_counts(
                str(self.organization.id),
                str(self.receiver.id),
            )[str(self.conversation.id)],
            1,
        )

        MessageService.delete_message(
            str(self.conversation.id),
            message.id,
            str(self.sender.id),
        )

        self.assertNotIn(
            str(self.conversation.id),
            MessageService.get_unread_counts(
                str(self.organization.id),
                str(self.receiver.id),
            ),
        )

    def test_retracting_latest_message_keeps_latest_summary_and_notifies_directory(self):
        previous = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "上一条消息",
        )
        latest = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "将被撤回的最新消息",
        )

        MessageService.delete_message(
            str(self.conversation.id),
            latest.id,
            str(self.sender.id),
        )

        self.conversation.refresh_from_db()
        self.assertNotEqual(self.conversation.latest_message_id, previous.id)
        self.assertEqual(self.conversation.latest_message_id, latest.id)
        self.assertEqual(self.conversation.last_message_preview, "消息已撤回")
        self.assertEqual(self.conversation.last_message_at, latest.created_at)

        update = IMEventOutbox.objects.get(
            conversation=self.conversation,
            message=latest,
            event_type=IMEventType.CONVERSATION_PREVIEW_UPDATED,
            payload__data__preview="消息已撤回",
        )
        self.assertEqual(
            update.target_channels,
            sorted(
                [
                    f"personal:{self.sender.id}",
                    f"personal:{self.receiver.id}",
                ]
            ),
        )
        self.assertEqual(update.payload["data"]["message_seq"], latest.seq)
        self.assertEqual(update.payload["data"]["preview"], "消息已撤回")

    def test_recalled_reply_source_uses_unavailable_preview_after_reload(self):
        source = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "将被撤回的原消息",
        )
        reply = MessageService.send_message(
            str(self.conversation.id),
            str(self.receiver.id),
            "回复原消息",
            reply_to_id=source.id,
        )

        MessageService.delete_message(
            str(self.conversation.id),
            source.id,
            str(self.sender.id),
        )

        messages = MessageService.get_messages(
            str(self.conversation.id),
            str(self.receiver.id),
        )
        reply_payload = next(item for item in messages if item["id"] == reply.id)
        preview = reply_payload["reply_to_preview"]
        self.assertEqual(preview["content"], "消息内容不可用")
        self.assertEqual(preview["sender_id"], str(self.sender.id))
        self.assertTrue(preview["is_unavailable"])
        self.assertFalse(preview["has_attachment"])

    def test_get_unread_snapshots_pairs_count_with_consistent_waterline(self):
        # 回归 ：移动端加载在途做 baseline/delta 合并需要 unread_count 与 last_message_seq 水位
        # 来自同一致快照。get_unread_snapshots 用「先取水位、未读计数限制 seq<=水位」构造性对齐，
        # 保证 count 恒等于「seq<=水位 的未读消息数」，不受查询间插入影响。
        m1 = MessageService.send_message(str(self.conversation.id), str(self.sender.id), "一")
        m2 = MessageService.send_message(str(self.conversation.id), str(self.sender.id), "二")
        m3 = MessageService.send_message(str(self.conversation.id), str(self.sender.id), "三")

        snaps = MessageService.get_unread_snapshots(
            str(self.organization.id), str(self.receiver.id)
        )
        count, waterline = snaps[str(self.conversation.id)]
        self.assertEqual(count, 3, "三条未读")
        self.assertEqual(waterline, m3.seq, "水位=会话已见的最高 seq")

        # receiver 读到 m2：未读降为 1（只剩 m3），水位仍是快照已见的最高 seq。
        MessageService.mark_as_read(str(self.conversation.id), str(self.receiver.id), m2.id)
        snaps2 = MessageService.get_unread_snapshots(
            str(self.organization.id), str(self.receiver.id)
        )
        count2, waterline2 = snaps2[str(self.conversation.id)]
        self.assertEqual(count2, 1, "读到 m2 后只剩 m3 未读")
        self.assertEqual(waterline2, m3.seq, "水位不随已读回退")
        # 关键不变式：count 恒 = seq<=水位 的未读数（当前即 m3 一条）。
        self.assertLessEqual(m3.seq, waterline2)

    def test_deleted_message_still_requires_sender_and_membership_to_recall_again(self):
        message = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "已经撤回的消息",
        )
        self.assertTrue(
            MessageService.delete_message(
                str(self.conversation.id),
                message.id,
                str(self.sender.id),
            )
        )
        outsider = User.objects.create_user(
            username="recall_outsider",
            email="recall-outsider@test.com",
            password="pass123",
        )

        with self.assertRaises(PermissionError):
            MessageService.delete_message(
                str(self.conversation.id),
                message.id,
                str(outsider.id),
            )

    def test_remove_reaction_validates_conversation_before_deleting(self):
        from apps.tabchat.models import MessageReaction

        message = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "reaction 所属会话",
        )
        MessageService.add_reaction(
            str(self.conversation.id),
            message.id,
            str(self.receiver.id),
            "👍",
        )
        other_conversation = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="另一个群",
            created_by=str(self.sender.id),
            member_count=2,
        )
        ConversationMember.objects.bulk_create(
            [
                ConversationMember(
                    conversation=other_conversation,
                    user_id=str(self.sender.id),
                    role=MemberRole.OWNER,
                ),
                ConversationMember(
                    conversation=other_conversation,
                    user_id=str(self.receiver.id),
                    role=MemberRole.MEMBER,
                ),
            ]
        )

        with self.assertRaises(ValueError):
            MessageService.remove_reaction(
                str(other_conversation.id),
                message.id,
                str(self.receiver.id),
                "👍",
            )

        self.assertTrue(
            MessageReaction.objects.filter(
                message=message,
                user_id=str(self.receiver.id),
                emoji="👍",
            ).exists()
        )

    def test_mentions_and_sparse_message_state(self):
        direct = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "@接收者",
            metadata={"mentioned_user_ids": [str(self.receiver.id)]},
        )
        mention = MessageMention.objects.get(message=direct)
        self.assertEqual(mention.user_id, str(self.receiver.id))
        self.assertEqual(mention.mention_type, MessageMention.MentionType.USER)

        mention_all = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "@所有人",
            metadata={"mention_all": True},
        )
        self.assertTrue(mention_all.mention_all)
        self.assertFalse(MessageMention.objects.filter(message=mention_all).exists())
        personal_rows = IMEventOutbox.objects.filter(
            message=mention_all,
            event_type=IMEventType.UNREAD_UPDATE,
        )
        self.assertEqual(personal_rows.count(), 1)
        self.assertTrue(personal_rows.get().payload["data"]["mention"])

        MessageService.set_message_starred(
            str(self.conversation.id),
            direct.id,
            str(self.receiver.id),
            True,
        )
        self.assertTrue(
            MessageUserState.objects.filter(
                message=direct,
                user_id=str(self.receiver.id),
                starred=True,
            ).exists()
        )
        MessageService.set_message_starred(
            str(self.conversation.id),
            direct.id,
            str(self.receiver.id),
            False,
        )
        self.assertFalse(MessageUserState.objects.filter(message=direct).exists())

    def test_message_mention_enforces_user_or_agent_xor(self):
        direct = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "非法双目标 mention",
        )

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                MessageMention.objects.create(
                    message=direct,
                    conversation=self.conversation,
                    user_id=str(self.receiver.id),
                    agent_id="agent-double-target",
                    mention_type=MessageMention.MentionType.USER,
                )

    def test_history_cleared_and_hidden_filter_history_and_search(self):
        old_message = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "历史隐藏针-old",
        )
        visible_message = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "历史隐藏针-visible",
        )
        hidden_message = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "历史隐藏针-hidden",
        )
        ConversationUserState.objects.update_or_create(
            conversation=self.conversation,
            user_id=str(self.receiver.id),
            defaults={"history_cleared_seq": old_message.seq},
        )
        MessageService.set_message_hidden(
            str(self.conversation.id),
            hidden_message.id,
            str(self.receiver.id),
            True,
        )

        history_ids = {
            item["id"]
            for item in MessageService.get_messages(
                str(self.conversation.id),
                str(self.receiver.id),
            )
        }
        search_ids = {
            item["id"]
            for item in MessageService.search_messages(
                str(self.organization.id),
                str(self.receiver.id),
                "历史隐藏针",
            )
        }

        self.assertNotIn(old_message.id, history_ids)
        self.assertNotIn(hidden_message.id, history_ids)
        self.assertIn(visible_message.id, history_ids)
        self.assertNotIn(old_message.id, search_ids)
        self.assertNotIn(hidden_message.id, search_ids)
        self.assertIn(visible_message.id, search_ids)

    def test_send_message_rolls_back_message_when_outbox_fails(self):
        with patch.object(
            IMOutboxService,
            "enqueue",
            side_effect=RuntimeError("outbox failure"),
        ):
            with self.assertRaises(RuntimeError):
                MessageService.send_message(
                    str(self.conversation.id),
                    str(self.sender.id),
                    "事务中途失败",
                    client_request_id="rollback-on-outbox-failure",
                )

        self.assertFalse(
            Message.objects.filter(
                conversation=self.conversation,
                client_request_id="rollback-on-outbox-failure",
            ).exists()
        )
        self.conversation.refresh_from_db()
        self.assertEqual(self.conversation.latest_message_seq, 0)

    def test_explicit_and_team_space_access_share_one_resolver(self):
        explicit = ConversationAccessResolver.resolve(
            self.conversation,
            str(self.receiver.id),
        )
        self.assertTrue(explicit.can_view)
        ConversationMember.objects.filter(
            conversation=self.conversation,
            user_id=str(self.receiver.id),
        ).delete()
        self.assertFalse(
            ConversationAccessResolver.resolve(
                self.conversation,
                str(self.receiver.id),
            ).can_view
        )

        team_space = Project.objects.create(
            organization=self.organization,
            name="继承访问",
            status=Project.Status.ACTIVE,
            visibility=Project.Visibility.PRIVATE,
        )
        self.conversation.space_id = team_space.id
        self.conversation.save(update_fields=["space_id"])
        membership = ProjectMembership.objects.create(
            project=team_space,
            user=self.receiver,
            role="editor",
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )
        ProjectMembership.objects.create(
            project=team_space,
            user=self.sender,
            role="owner",
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )
        inherited = ConversationAccessResolver.resolve(
            self.conversation,
            str(self.receiver.id),
        )
        self.assertTrue(inherited.can_view)
        self.assertIsNone(inherited.explicit_member)
        self.assertIsNotNone(inherited.space_membership)
        message = MessageService.send_message(
            str(self.conversation.id),
            str(self.sender.id),
            "撤权后不可见的检索内容",
            client_request_id="team-space-revocation",
        )
        self.assertEqual(
            MessageService.get_unread_counts(
                str(self.organization.id),
                str(self.receiver.id),
            )[str(self.conversation.id)],
            1,
        )
        self.assertEqual(
            MessageService.search_messages(
                str(self.organization.id),
                str(self.receiver.id),
                message.content,
            )[0]["id"],
            message.id,
        )

        membership.is_active = False
        membership.save(update_fields=["is_active"])
        self.assertFalse(
            ConversationAccessResolver.resolve(
                self.conversation,
                str(self.receiver.id),
            ).can_view
        )
        self.assertNotIn(
            str(self.conversation.id),
            MessageService.get_unread_counts(
                str(self.organization.id),
                str(self.receiver.id),
            ),
        )
        self.assertEqual(
            MessageService.search_messages(
                str(self.organization.id),
                str(self.receiver.id),
                message.content,
            ),
            [],
        )


class IMOutboxStateMachineTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.user = User.objects.create_user(
            username="outbox_user",
            email="outbox-user@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(name="Outbox", owner=self.user)
        self.conversation = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="Outbox",
            created_by=str(self.user.id),
        )

    def _enqueue(self) -> IMEventOutbox:
        return IMOutboxService.enqueue(
            organization_id=str(self.organization.id),
            event_type=IMEventType.CONVERSATION_UPDATED,
            target_channels=[f"chat:{self.conversation.id}"],
            data={"conversation_id": str(self.conversation.id)},
            conversation=self.conversation,
        )

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    def test_stale_claim_cannot_overwrite_new_worker(self, get_service):
        get_service.return_value.publish_sync.return_value = {"result": {}}
        record = self._enqueue()
        first_record, first_token = IMOutboxService.claim(str(record.id))
        IMEventOutbox.objects.filter(id=record.id).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.assertEqual(IMOutboxService.recover_expired_leases(), 1)
        second_record, second_token = IMOutboxService.claim(str(record.id))

        self.assertFalse(
            IMOutboxService.deliver_claimed(first_record, first_token)
        )
        self.assertTrue(
            IMOutboxService.deliver_claimed(second_record, second_token)
        )
        record.refresh_from_db()
        self.assertEqual(record.status, IMEventOutbox.Status.DELIVERED)

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    def test_repeated_publish_failure_reaches_dead_letter(self, get_service):
        get_service.return_value.publish_sync.side_effect = TimeoutError("timeout")
        record = self._enqueue()
        IMEventOutbox.objects.filter(id=record.id).update(
            attempts=OUTBOX_MAX_ATTEMPTS - 1
        )
        claimed_record, claim_token = IMOutboxService.claim(str(record.id))

        self.assertFalse(
            IMOutboxService.deliver_claimed(claimed_record, claim_token)
        )
        record.refresh_from_db()
        self.assertEqual(record.status, IMEventOutbox.Status.DEAD)
        self.assertIn("timeout", record.last_error)

    def test_expired_lease_at_attempt_limit_reaches_dead_letter(self):
        record = self._enqueue()
        claimed_record, _ = IMOutboxService.claim(str(record.id))
        IMEventOutbox.objects.filter(id=claimed_record.id).update(
            attempts=OUTBOX_MAX_ATTEMPTS,
            lease_expires_at=timezone.now() - timedelta(seconds=1),
        )

        self.assertEqual(IMOutboxService.recover_expired_leases(), 1)

        record.refresh_from_db()
        self.assertEqual(record.status, IMEventOutbox.Status.DEAD)
        self.assertIsNone(record.next_retry_at)

    @patch("apps.tabchat.services.centrifugo_service._breaker")
    def test_sync_publish_propagates_network_failure(self, breaker):
        breaker.allow_request.return_value = True
        service = CentrifugoService()
        session = MagicMock()
        session.post.side_effect = requests.Timeout("centrifugo unavailable")

        with patch.object(service, "_get_session", return_value=session):
            with self.assertRaises(requests.Timeout):
                service.publish_sync(
                    f"chat:{self.conversation.id}",
                    {"type": "im.test", "data": {}},
                )

class ConcurrentMessageSequenceTests(TransactionTestCase):
    databases = ["default", "postgresql"]
    reset_sequences = True

    def setUp(self):
        _ensure_free_tier()
        self.user = User.objects.create_user(
            username="sequence_sender",
            email="sequence-sender@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(name="Sequence", owner=self.user)
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )
        self.group_conversation = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="Sequence",
            created_by=str(self.user.id),
            member_count=1,
        )
        ConversationMember.objects.create(
            conversation=self.group_conversation,
            user_id=str(self.user.id),
            role=MemberRole.OWNER,
        )
        self.dm_conversation = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.DM,
            created_by=str(self.user.id),
            member_count=1,
        )
        ConversationMember.objects.create(
            conversation=self.dm_conversation,
            user_id=str(self.user.id),
            role=MemberRole.OWNER,
        )

    def _send_concurrently(self, conversation: Conversation, count: int) -> list[int]:
        def send(index: int) -> int:
            close_old_connections()
            try:
                return MessageService.send_message(
                    str(conversation.id),
                    str(self.user.id),
                    f"并发消息 {index}",
                    client_request_id=f"concurrent-{conversation.id}-{index}",
                ).seq
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=count) as executor:
            return sorted(executor.map(send, range(1, count + 1)))

    def test_concurrent_sends_allocate_unique_sequences(self):
        sequences = self._send_concurrently(self.group_conversation, 2)

        self.assertEqual(sequences, [1, 2])
        self.assertEqual(
            Message.objects.filter(conversation=self.group_conversation)
            .values("seq")
            .distinct()
            .count(),
            2,
        )

    def test_dm_and_group_concurrent_sends_allocate_10_20_50_sequences(self):
        scenarios = [
            (self.dm_conversation, 10),
            (self.group_conversation, 20),
        ]
        for conversation, count in scenarios:
            sequences = self._send_concurrently(conversation, count)
            self.assertEqual(sequences, list(range(1, count + 1)))
            conversation.refresh_from_db()
            self.assertEqual(conversation.latest_message_seq, count)

        fifty_group = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="Sequence 50",
            created_by=str(self.user.id),
            member_count=1,
        )
        ConversationMember.objects.create(
            conversation=fifty_group,
            user_id=str(self.user.id),
            role=MemberRole.OWNER,
        )
        sequences = self._send_concurrently(fifty_group, 50)
        self.assertEqual(sequences, list(range(1, 51)))
        fifty_group.refresh_from_db()
        self.assertEqual(fifty_group.latest_message_seq, 50)

    def test_concurrent_duplicate_client_request_returns_one_message(self):
        request_id = "duplicate-concurrent-request"

        def send_duplicate(index: int) -> int:
            close_old_connections()
            try:
                return MessageService.send_message(
                    str(self.group_conversation.id),
                    str(self.user.id),
                    f"重复发送 {index}",
                    client_request_id=request_id,
                ).id
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=10) as executor:
            message_ids = list(executor.map(send_duplicate, range(10)))

        self.assertEqual(len(set(message_ids)), 1)
        self.assertEqual(
            Message.objects.filter(
                conversation=self.group_conversation,
                client_request_id=request_id,
            ).count(),
            1,
        )
        message = Message.objects.get(
            conversation=self.group_conversation,
            client_request_id=request_id,
        )
        self.assertEqual(message.seq, 1)
        self.assertEqual(IMEventOutbox.objects.filter(message=message).count(), 2)

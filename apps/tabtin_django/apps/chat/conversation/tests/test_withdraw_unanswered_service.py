"""#9614 未答轮次撤回：服务端权威删除 + 实质输出复判 + 审计快照。"""

from __future__ import annotations

import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.chat.conversation.models import (
    ChatMessage,
    ChatMessageWithdrawEvent,
    ChatSession,
)
from apps.chat.conversation.services.withdraw_unanswered import (
    REASON_HAS_SUBSTANTIVE_OUTPUT,
    withdraw_unanswered_messages,
)


class WithdrawUnansweredServiceTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create(
            username=f"withdraw-svc-{uuid.uuid4().hex[:8]}",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id="withdraw-org",
            title="撤回服务测试",
        )

    def _user(self, text: str, *, client_event_id=None) -> ChatMessage:
        return ChatMessage.objects.create(
            session=self.session,
            role="user",
            text_summary=text,
            content_blocks_json=[{"type": "text", "text": text}],
            message_kind="llm",
            client_event_id=client_event_id or uuid.uuid4(),
        )

    def _assistant(
        self,
        *,
        text_summary: str = "",
        blocks=None,
    ) -> ChatMessage:
        return ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary=text_summary,
            content_blocks_json=blocks if blocks is not None else [],
            message_kind="llm",
        )

    def test_rejects_when_substantive_text_exists(self):
        target = self._user("发错了")
        self._assistant(
            text_summary="已经开始答",
            blocks=[{"type": "text", "text": "已经开始答"}],
        )

        result = withdraw_unanswered_messages(
            session=self.session,
            client_message_id=str(target.client_event_id),
            actor=self.user,
            source="mobile_cancel",
        )

        self.assertFalse(result["withdraw_applied"])
        self.assertEqual(result["reason"], REASON_HAS_SUBSTANTIVE_OUTPUT)
        self.assertEqual(result["deleted_count"], 0)
        self.assertTrue(
            self.session.messages.filter(id=target.id).exists(),
        )
        self.assertEqual(ChatMessageWithdrawEvent.objects.count(), 0)

    def test_rejects_when_tool_use_block_exists(self):
        target = self._user("发错了")
        self._assistant(
            text_summary="[工具调用]",
            blocks=[{
                "type": "tool_use",
                "id": "tool-1",
                "name": "run_terminal_command",
                "input": {},
            }],
        )

        result = withdraw_unanswered_messages(
            session=self.session,
            client_message_id=str(target.client_event_id),
            actor=self.user,
            source="mobile_cancel",
        )

        self.assertFalse(result["withdraw_applied"])
        self.assertEqual(result["reason"], REASON_HAS_SUBSTANTIVE_OUTPUT)
        self.assertEqual(ChatMessageWithdrawEvent.objects.count(), 0)

    def test_allows_thinking_only_and_writes_audit(self):
        kept = self._user("上一轮")
        target = self._user("发错了")
        thinking = self._assistant(
            text_summary="[思考中]",
            blocks=[{"type": "thinking", "thinking": "先想想"}],
        )

        with patch(
            "apps.chat.conversation.services.title_generator.TitleGeneratorService"
            ".cancel_title_generation_for_empty_session",
            return_value=None,
        ):
            result = withdraw_unanswered_messages(
                session=self.session,
                client_message_id=str(target.client_event_id),
                actor=self.user,
                source="mobile_cancel",
            )

        self.assertTrue(result["withdraw_applied"])
        self.assertIsNone(result["reason"])
        self.assertEqual(result["deleted_count"], 2)
        self.assertEqual(
            list(self.session.messages.values_list("id", flat=True)),
            [kept.id],
        )

        event = ChatMessageWithdrawEvent.objects.get()
        self.assertEqual(event.session_id, self.session.id)
        self.assertEqual(event.organization_id, "withdraw-org")
        self.assertEqual(event.actor_user_id, str(self.user.id))
        self.assertEqual(event.source, "mobile_cancel")
        self.assertEqual(event.client_message_id, str(target.client_event_id))
        self.assertEqual(event.deleted_count, 2)
        self.assertEqual(len(event.payload_json), 2)
        snapshot_ids = {item["id"] for item in event.payload_json}
        self.assertEqual(snapshot_ids, {str(target.id), str(thinking.id)})
        target_snap = next(
            item for item in event.payload_json if item["id"] == str(target.id)
        )
        self.assertEqual(target_snap["role"], "user")
        self.assertEqual(target_snap["text_summary"], "发错了")
        self.assertIn("content_blocks_json", target_snap)
        self.assertIn("created_at", target_snap)

    def test_idempotent_repeat_returns_zero_without_new_audit(self):
        target = self._user("发错了")
        client_id = str(target.client_event_id)

        with patch(
            "apps.chat.conversation.services.title_generator.TitleGeneratorService"
            ".cancel_title_generation_for_empty_session",
            return_value=None,
        ):
            first = withdraw_unanswered_messages(
                session=self.session,
                client_message_id=client_id,
                actor=self.user,
                source="electron_runtime",
            )
            second = withdraw_unanswered_messages(
                session=self.session,
                client_message_id=client_id,
                actor=self.user,
                source="electron_runtime",
            )

        self.assertTrue(first["withdraw_applied"])
        self.assertEqual(first["deleted_count"], 1)
        self.assertTrue(second["withdraw_applied"])
        self.assertEqual(second["deleted_count"], 0)
        self.assertEqual(ChatMessageWithdrawEvent.objects.count(), 1)

    def test_lookup_by_message_id_uuid(self):
        target = self._user("发错了")

        with patch(
            "apps.chat.conversation.services.title_generator.TitleGeneratorService"
            ".cancel_title_generation_for_empty_session",
            return_value=None,
        ):
            result = withdraw_unanswered_messages(
                session=self.session,
                client_message_id=str(target.id),
                actor=self.user,
                source="electron_runtime",
            )

        self.assertTrue(result["withdraw_applied"])
        self.assertEqual(result["deleted_count"], 1)

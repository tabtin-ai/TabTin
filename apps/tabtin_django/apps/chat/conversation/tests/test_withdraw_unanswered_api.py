"""Composer Stop 撤回未答轮次的 API 回归测试。"""

import uuid
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.chat.conversation.schemas import WithdrawUnansweredRequest


class WithdrawUnansweredApiTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create(
            username=f"withdraw-{uuid.uuid4().hex[:8]}",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id="withdraw-org",
            title="撤回测试",
        )

    def _message(self, role: str, text: str) -> ChatMessage:
        return ChatMessage.objects.create(
            session=self.session,
            role=role,
            text_summary=text,
            content_blocks_json=[{"type": "text", "text": text}],
            message_kind="llm",
            client_event_id=uuid.uuid4(),
        )

    def test_withdraw_returns_success_after_deleting_target_turn(self):
        """删除结果的明细字典不能覆盖国际化函数 `_`，否则事务提交后响应仍 500。

        ：半截 assistant 仅 thinking 不算实质输出，仍允许撤回。
        """
        from apps.chat.conversation.api.message import withdraw_unanswered_turn

        kept = self._message("user", "上一轮")
        target = self._message("user", "发错了")
        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary="[思考中]",
            content_blocks_json=[{"type": "thinking", "thinking": "尚未完成"}],
            message_kind="llm",
        )
        request = MagicMock()
        request.auth = self.user

        with patch(
            "apps.chat.conversation.api.message._get_session_with_shared_access",
            return_value=(self.session, False),
        ), patch(
            "apps.chat.conversation.services.title_generator.TitleGeneratorService"
            ".cancel_title_generation_for_empty_session",
            return_value=None,
        ):
            response = withdraw_unanswered_turn(
                request,
                str(self.session.id),
                WithdrawUnansweredRequest(
                    client_message_id=str(target.client_event_id),
                    runtime_withdraw_applied=True,
                ),
            )

        self.assertIs(response["success"], True)
        self.assertEqual(response["code"], "SUCCESS")
        self.assertEqual(response["data"]["deleted_count"], 2)
        self.assertEqual(
            list(self.session.messages.values_list("id", flat=True)),
            [kept.id],
        )

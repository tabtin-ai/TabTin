"""#8322：跨轮 history 必须按本轮 client_event_id 排除，不能猜「最新是不是 user」。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _msg(
    *,
    msg_id,
    role: str,
    content: str,
    client_event_id=None,
    message_kind: str = "llm",
    metadata=None,
):
    return SimpleNamespace(
        id=msg_id,
        role=role,
        text_summary=content,
        content_blocks_json=[{"type": "text", "text": content}],
        message_kind=message_kind,
        client_event_id=client_event_id,
        metadata=metadata or {},
    )


class CrossTurnHistoryExcludeCurrentTests(SimpleTestCase):
    @patch("apps.chat.conversation.models.ChatMessage.objects")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    @patch("apps.agent.models.Agent.objects")
    def test_persisted_system_context_projects_to_user_history(
        self,
        agent_objects,
        session_objects,
        message_objects,
    ):
        from apps.services.agent_engine.services.prompt_forward_service import (
            PromptForwardService,
        )

        session_objects.filter.return_value.first.return_value = SimpleNamespace(
            id="sess-system",
            agent_id="agent-system",
        )
        agent_objects.filter.return_value.values_list.return_value.first.return_value = {
            "schema_version": 2,
            "conversation": {"cross_turn_memory": True},
        }
        qs = MagicMock()
        message_objects.filter.return_value = qs
        qs.exclude.return_value = qs
        qs.order_by.return_value = [
            _msg(
                msg_id=uuid.uuid4(),
                role="system",
                content='<context type="environment">env</context>',
                message_kind="environment_context",
            ),
        ]

        result = PromptForwardService._assemble_cross_turn_history(
            thread_id="thread-system",
            space=SimpleNamespace(id="ws-system"),
            exclude_client_event_id=str(uuid.uuid4()),
        )

        self.assertEqual(result[0]["role"], "user")
        message_objects.filter.assert_called_once_with(
            session=session_objects.filter.return_value.first.return_value,
            role__in=["user", "assistant", "system"],
        )

    @patch("apps.chat.conversation.models.ChatMessage.objects")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    @patch("apps.agent.models.Agent.objects")
    def test_exclude_client_event_id_drops_current_user_even_if_latest_is_assistant(
        self,
        agent_objects,
        session_objects,
        message_objects,
    ):
        """本轮 user 已落库后，即便最新一条是上一轮 assistant，仍按身份排除本轮 user。

        旧逻辑猜「最新是不是 user」会失效，把 display_message 放进 history，
        与本轮 prompt 模板形成双份用户意图。
        """
        from apps.services.agent_engine.services.prompt_forward_service import (
            PromptForwardService,
        )

        current_id = uuid.uuid4()
        prev_assistant_id = uuid.uuid4()
        session_objects.filter.return_value.first.return_value = SimpleNamespace(
            id="sess-1",
            agent_id="agent-1",
        )
        agent_objects.filter.return_value.values_list.return_value.first.return_value = {
            "schema_version": 2,
            "conversation": {"cross_turn_memory": True},
        }

        qs = MagicMock()
        message_objects.filter.return_value = qs
        qs.exclude.return_value = qs
        # 身份排除后只剩上一轮真实 assistant（本轮 user 已被 ORM exclude）
        qs.order_by.return_value = [
            _msg(
                msg_id=prev_assistant_id,
                role="assistant",
                content="上一轮已完成汇报。",
            ),
        ]

        result = PromptForwardService._assemble_cross_turn_history(
            thread_id="thread-1",
            space=SimpleNamespace(id="ws-1"),
            exclude_client_event_id=str(current_id),
        )

        self.assertIsNotNone(result)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["role"], "assistant")
        self.assertIn("上一轮已完成", result[0]["content"])
        self.assertFalse(any(entry.get("content") == "test" for entry in result))

        kwargs_list = [c.kwargs for c in qs.exclude.call_args_list]
        self.assertTrue(
            any(kwargs.get("client_event_id") == current_id for kwargs in kwargs_list),
            msg=f"expected exclude(client_event_id=...), got {kwargs_list}",
        )
        self.assertTrue(
            any(kwargs.get("id") == current_id for kwargs in kwargs_list),
            msg=f"expected exclude(id=...), got {kwargs_list}",
        )

    @patch("apps.chat.conversation.models.ChatMessage.objects")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    @patch("apps.agent.models.Agent.objects")
    def test_without_exclude_id_still_drops_newest_user(
        self,
        agent_objects,
        session_objects,
        message_objects,
    ):
        """未传本轮身份时保留旧行为：最新一条 user 仍裁掉。"""
        from apps.services.agent_engine.services.prompt_forward_service import (
            PromptForwardService,
        )

        current_id = uuid.uuid4()
        prev_assistant_id = uuid.uuid4()
        session_objects.filter.return_value.first.return_value = SimpleNamespace(
            id="sess-2",
            agent_id="agent-2",
        )
        agent_objects.filter.return_value.values_list.return_value.first.return_value = {
            "schema_version": 2,
            "conversation": {"cross_turn_memory": True},
        }

        qs = MagicMock()
        message_objects.filter.return_value = qs
        qs.exclude.return_value = qs
        qs.order_by.return_value = [
            _msg(msg_id=current_id, role="user", content="new turn", client_event_id=current_id),
            _msg(msg_id=prev_assistant_id, role="assistant", content="prev reply"),
        ]

        result = PromptForwardService._assemble_cross_turn_history(
            thread_id="thread-2",
            space=SimpleNamespace(id="ws-2"),
            exclude_client_event_id=None,
        )

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["role"], "assistant")
        self.assertEqual(result[0]["content"], "prev reply")

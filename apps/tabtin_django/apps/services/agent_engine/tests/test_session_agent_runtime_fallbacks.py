"""低频执行入口也必须以 ChatSession.agent_id 为身份真相。"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


class SessionAgentRuntimeFallbackTests(SimpleTestCase):
    @patch("apps.chat.conversation.models.ChatSession.objects")
    @patch("apps.agent.models.Agent.objects")
    def test_cross_turn_memory_reads_session_agent_config(
        self,
        agent_objects,
        session_objects,
    ):
        from apps.services.agent_engine.services.prompt_forward_service import (
            PromptForwardService,
        )

        session_objects.filter.return_value.first.return_value = SimpleNamespace(
            agent_id="session-agent",
        )
        agent_objects.filter.return_value.values_list.return_value.first.return_value = {
            "conversation": {"cross_turn_memory": False},
        }
        workspace = SimpleNamespace(
            id="workspace-1",
            agent=SimpleNamespace(
                agent_config={"conversation": {"cross_turn_memory": True}}
            ),
        )

        result = PromptForwardService._assemble_cross_turn_history(
            thread_id="chat-session-1",
            space=workspace,
        )

        self.assertIsNone(result)
        agent_objects.filter.assert_called_once_with(id="session-agent")

    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "get_cached_execution_agent_id",
        return_value=None,
    )
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_frontend_action_falls_back_to_session_agent(
        self,
        session_objects,
        _cached_agent,
    ):
        from apps.services.agent_engine.services.frontend_action_service import (
            FrontendActionService,
        )

        values = MagicMock()
        values.first.return_value = "session-agent"
        session_objects.filter.return_value.values_list.return_value = values

        with patch(
            "apps.services.common.thread_context.get_current_thread_id",
            return_value=None,
        ), patch(
            "apps.services.common.thread_context.get_current_execution_agent_id",
            return_value=None,
        ):
            result = FrontendActionService._get_explicit_agent_id_for_thread(
                "chat-session-session-id"
            )

        self.assertEqual(result, "session-agent")
        session_objects.filter.assert_called_once_with(id="session-id")


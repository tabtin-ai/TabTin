"""#6356：记忆提取链路必须接受并消费显式 agent_id。"""

import inspect
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.agent_engine.tasks.memory.capture import (
    _do_extract_memories,
    _resolve_effective_agent_id,
    extract_memories_task,
)


class ResolveEffectiveAgentIdTests(SimpleTestCase):
    def test_explicit_agent_id_wins(self):
        with patch(
            "apps.services.agent_engine.utils.memory_constants"
            ".resolve_space_execution_agent_id",
            return_value="session-agent",
        ) as mock_resolve:
            result = _resolve_effective_agent_id(
                "space-1",
                thread_id="thread-1",
                agent_id="agent-a",
            )
        self.assertEqual(result, "agent-a")
        mock_resolve.assert_not_called()

    def test_blank_agent_id_falls_back_to_resolve(self):
        with patch(
            "apps.services.agent_engine.utils.memory_constants"
            ".resolve_space_execution_agent_id",
            return_value="session-agent",
        ) as mock_resolve:
            result = _resolve_effective_agent_id(
                "space-1",
                thread_id="thread-1",
                agent_id="",
            )
        self.assertEqual(result, "session-agent")
        mock_resolve.assert_called_once_with("space-1", thread_id="thread-1")


class ExtractMemoriesAgentIdTests(SimpleTestCase):
    def setUp(self):
        super().setUp()
        self.capture_guard = patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            return_value=type(
                "Execution",
                (),
                {"enabled": True, "selected_model_id": "workspace-model"},
            )(),
        )
        self.capture_guard.start()
        self.addCleanup(self.capture_guard.stop)

    def test_task_signature_declares_agent_id(self):
        # Celery 包装后仍可通过 run 看到原始参数；缺声明会导致 Relay kwargs 失败。
        params = inspect.signature(extract_memories_task.run).parameters
        self.assertIn("agent_id", params)

    @patch("apps.services.agent_engine.tasks.memory.capture._write_to_table")
    @patch("apps.services.agent_engine.tasks.memory.capture._deduplicate")
    @patch("apps.services.agent_engine.tasks.memory.capture._extract_with_llm")
    def test_do_extract_forwards_explicit_agent_id(
        self, mock_llm, mock_dedup, mock_write,
    ):
        mock_llm.return_value = [{"content": "remember this", "type": "事实"}]
        mock_dedup.side_effect = lambda fragments, *args, **kwargs: fragments

        ok = _do_extract_memories(
            None,
            "space-1",
            "user-1",
            "thread-1",
            [{"role": "assistant", "content": "ok"}],
            0.9,
            "auto",
            agent_id="agent-b",
        )

        self.assertTrue(ok)
        self.assertEqual(mock_dedup.call_args.kwargs.get("agent_id"), "agent-b")
        self.assertEqual(mock_write.call_args.kwargs.get("agent_id"), "agent-b")

    @patch("apps.services.agent_engine.tasks.memory.capture._write_to_table")
    @patch("apps.services.agent_engine.tasks.memory.capture._deduplicate")
    @patch("apps.services.agent_engine.tasks.memory.capture._extract_with_llm")
    @patch(
        "apps.services.agent_engine.tasks.memory.capture._resolve_effective_agent_id",
        return_value="fallback-agent",
    )
    def test_do_extract_falls_back_when_agent_id_blank(
        self, mock_resolve, mock_llm, mock_dedup, mock_write,
    ):
        mock_llm.return_value = [{"content": "remember this", "type": "事实"}]
        mock_dedup.side_effect = lambda fragments, *args, **kwargs: fragments

        ok = _do_extract_memories(
            None,
            "space-1",
            "user-1",
            "thread-1",
            [{"role": "assistant", "content": "ok"}],
            0.9,
            "auto",
            agent_id="",
        )

        self.assertTrue(ok)
        mock_resolve.assert_called()
        self.assertEqual(
            mock_dedup.call_args.kwargs.get("agent_id"), "fallback-agent",
        )
        self.assertEqual(
            mock_write.call_args.kwargs.get("agent_id"), "fallback-agent",
        )


class IdleSettlementAgentIdCompatTests(SimpleTestCase):
    """L4 同步路径已传 agent_id=...，签名必须兼容。"""

    def setUp(self):
        super().setUp()
        self.capture_guard = patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            return_value=type(
                "Execution",
                (),
                {"enabled": True, "selected_model_id": "workspace-model"},
            )(),
        )
        self.capture_guard.start()
        self.addCleanup(self.capture_guard.stop)

    @patch("apps.services.agent_engine.tasks.memory.capture._write_to_table")
    @patch("apps.services.agent_engine.tasks.memory.capture._deduplicate")
    @patch(
        "apps.services.agent_engine.tasks.memory.capture._extract_with_llm",
        return_value=[],
    )
    def test_keyword_agent_id_does_not_raise(self, _llm, _dedup, _write):
        ok = _do_extract_memories(
            None,
            "space-1",
            "user-1",
            "session-1",
            [{"role": "user", "content": "x"}],
            0.85,
            "auto",
            agent_id="agent-from-group",
        )
        self.assertTrue(ok)

"""``AgentDispatcher.dispatch_external`` 把 ``ConversationState.interrupt_state``
透传给 ``PromptForwardService.forward_prompt`` 的窄修补单测。

PRD 05 v0.4 §7.1（W3-轮 1 L3-1-A）：用户重发 prompt 时 caller 必须读 PG 里的
crash 快照（``pending_approvals``），daemon 才能在 runtime.query 入口回灌
``PendingApprovalRegistry`` —— 否则空轮触发 ``Maximum tool re-emit``，北极星
§1.4 失效。

本文件不连真实 DB（``SimpleTestCase``）：``ConversationStore.peek_interrupt_state``
和 ``PromptForwardService`` 都被 mock，单测仅校验 caller 层读 + 透传逻辑。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.engine.agent_dispatcher import AgentDispatcher


def _make_space(space_id="space-1", organization_id="wt-1"):
    space = MagicMock()
    space.id = space_id
    space.organization_id = organization_id

    agent = MagicMock()
    agent.id = "agent-1"
    agent.custom_rules = ""
    agent.agent_config = {}
    space.agent = agent
    return space


def _make_session(session_id="sess-1", thread_id="chat-session-sess-1"):
    session = MagicMock()
    session.id = session_id
    session.user_id = "user-1"
    session.effective_thread_id = thread_id
    return session


def _mock_runtime_config():
    return SimpleNamespace(
        agent_id="agent-1",
        agent_owner_user_id="user-1",
        agent_config={},
        agent_name="agent",
        custom_rules="",
        workspace_root="/tmp",
        approval_mode="always_ask",
        approval_grant="always_ask",
        agent_mode="agent",
    )


@patch("apps.services.agent_engine.engine.agent_dispatcher._resolve_disabled_apps_for_space", return_value=[])
@patch("apps.services.agent_engine.engine.agent_dispatcher._resolve_disabled_tool_prefixes", return_value=[])
class AgentDispatcherInterruptStateTests(SimpleTestCase):
    """覆盖 W3-轮 1 L3-1-A 两个核心场景：
    1. ConversationState 含 pending_approvals → forward_prompt 收到 interrupt_state
    2. ConversationState 不存在（新会话）→ forward_prompt 收到 interrupt_state=None
    """

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    @patch(
        "apps.services.agent_execution.effective_runtime_config."
        "resolve_effective_runtime_config",
        return_value=_mock_runtime_config(),
    )
    @patch(
        "apps.services.agent_engine.persistence.conversation_store."
        "ConversationStore.peek_interrupt_state"
    )
    def test_pending_approvals_in_conversation_state_forwarded_to_prompt(
        self, mock_peek, _mock_effective_config, mock_pfs_cls, _disabled_prefixes, _disabled_apps,
    ):
        nested_interrupt = {
            "pending_approvals": [
                {
                    "batch_id": "b-7",
                    "runtime_mode": "interactive",
                    "approval_type": "tool_permission",
                    "entries": [
                        {
                            "request_id": "req-7",
                            "tool_call_id": "tc-7",
                            "tool_name": "shell.run",
                            "status": "pending",
                        }
                    ],
                }
            ],
        }
        mock_peek.return_value = nested_interrupt

        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-pending", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "resume me",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-1",
            model_id="model-1",
        )

        mock_peek.assert_called_once_with("chat-session-sess-1")
        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs["interrupt_state"], nested_interrupt)

    @patch("apps.services.agent_engine.services.prompt_forward_service.PromptForwardService")
    @patch(
        "apps.services.agent_execution.effective_runtime_config."
        "resolve_effective_runtime_config",
        return_value=_mock_runtime_config(),
    )
    @patch(
        "apps.services.agent_engine.persistence.conversation_store."
        "ConversationStore.peek_interrupt_state",
        return_value=None,
    )
    def test_missing_conversation_state_passes_none_interrupt_state(
        self, _mock_peek, _mock_effective_config, mock_pfs_cls, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid-fresh", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "first turn",
            _make_space(),
            attachments=None,
            thread_id="chat-session-sess-fresh",
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertIn("interrupt_state", kwargs)
        self.assertIsNone(kwargs["interrupt_state"])

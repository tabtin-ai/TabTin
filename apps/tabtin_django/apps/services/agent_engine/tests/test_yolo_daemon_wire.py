"""
test_yolo_daemon_wire.py — PR4-yolo Daemon 路径 wire 链路打通 + ContextVar 接通。

钉死本 PR (fix/yolo-daemon-wire-and-contextvar) 的 4 条 Python 侧 wire / 防御覆盖：

1. PromptForwardService.forward_prompt 真正把入参 agent_mode / is_group_space
   落到 payload（任务 1）。
2. AgentDispatcher.dispatch_external 不再从 Space.type 派生 is_group_space；
   Space-first Phase 4 后该字段保留 wire 兼容，当前显式 false。
3. FrontendActionService._resolve_sandbox_policy **不再**信任 LLM 可控的
   ``params.get("agent_mode")``——改读 ContextVar 权威源（任务 5 / H4 防御）。
4. ContextVar 命中时 params 中的 agent_mode 被忽略；mismatch 会触发 warning
   log 但不阻断业务。

不连 DB（SimpleTestCase）：所有外部依赖都被 mock。
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.engine.agent_dispatcher import AgentDispatcher
from apps.services.agent_engine.services.frontend_action_service import (
    FrontendActionService,
)
from apps.services.agent_engine.services.prompt_forward_service import (
    PromptForwardService,
)
from apps.services.common.thread_context import (
    set_current_agent_mode,
    get_current_agent_mode,
    set_current_thread_id,
)


def _make_space(space_id="space-1", organization_id="wt-1", space_type="solo"):
    space = MagicMock()
    space.id = space_id
    space.organization_id = organization_id
    space.type = space_type

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


class ForwardPromptPropagatesAgentModeTests(SimpleTestCase):
    """任务 1 — forward_prompt 把 agent_mode / is_group_space 写入 payload。"""

    def _build_envelope_capture(self):
        """patch build_envelope 截获 payload，避免实际 publish。"""
        captured = {}

        def fake_build_envelope(_type, _event_id, payload, **kwargs):
            captured["payload"] = payload
            return {"type": _type, "payload": payload, **kwargs}

        return captured, fake_build_envelope

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService._route_to_device",
        return_value=1,
    )
    def test_agent_mode_yolo_written_to_payload(self, _route):
        captured, fake_build = self._build_envelope_capture()
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.build_envelope",
            side_effect=fake_build,
        ):
            svc = PromptForwardService()
            svc.forward_prompt(
                thread_id="thread-yolo",
                space=_make_space(),
                prompt="run",
                attachments=[],
                agent_backend_config={"type": "claude"},
                agent_mode="yolo",
                is_group_space=False,
            )
        self.assertEqual(captured["payload"].get("agent_mode"), "yolo")
        self.assertEqual(captured["payload"].get("is_group_space"), False)

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService._route_to_device",
        return_value=1,
    )
    def test_organization_id_written_to_payload(self, _route):
        captured, fake_build = self._build_envelope_capture()
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.build_envelope",
            side_effect=fake_build,
        ):
            svc = PromptForwardService()
            svc.forward_prompt(
                thread_id="thread-organization",
                space=_make_space(organization_id="wt-forward"),
                prompt="run",
                attachments=[],
                agent_backend_config={"type": "claude"},
            )
        self.assertEqual(captured["payload"].get("organization_id"), "wt-forward")

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService._route_to_device",
        return_value=1,
    )
    def test_agent_mode_none_omitted_from_payload(self, _route):
        captured, fake_build = self._build_envelope_capture()
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.build_envelope",
            side_effect=fake_build,
        ):
            svc = PromptForwardService()
            svc.forward_prompt(
                thread_id="thread-no-mode",
                space=_make_space(),
                prompt="run",
                attachments=[],
                agent_backend_config={"type": "claude"},
                agent_mode=None,
                is_group_space=True,
            )
        # 缺省时不写 agent_mode（向后兼容旧客户端）
        self.assertNotIn("agent_mode", captured["payload"])
        # is_group_space 即使 False 也始终写入（避免下游 default 漂移）
        self.assertEqual(captured["payload"].get("is_group_space"), True)

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService._route_to_device",
        return_value=1,
    )
    def test_skill_slash_invoke_written_to_payload(self, _route):
        captured, fake_build = self._build_envelope_capture()
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.build_envelope",
            side_effect=fake_build,
        ):
            PromptForwardService().forward_prompt(
                thread_id="thread-skill",
                space=_make_space(),
                prompt="/meeting-notes 整理今天的会议",
                attachments=[],
                agent_backend_config={"type": "claude"},
                skill_slash_invoke={
                    "skill_key": "app:office/meeting-notes",
                    "args": "整理今天的会议",
                },
            )
        self.assertEqual(captured["payload"].get("skill_slash_invoke"), {
            "skill_key": "app:office/meeting-notes",
            "args": "整理今天的会议",
        })


@patch(
    "apps.services.agent_engine.engine.agent_dispatcher._resolve_disabled_apps_for_space",
    return_value=[],
)
@patch(
    "apps.services.agent_engine.engine.agent_dispatcher._resolve_disabled_tool_prefixes",
    return_value=[],
)
@patch(
    "apps.services.agent_engine.persistence.conversation_store."
    "ConversationStore.peek_interrupt_state",
    return_value=None,
)
class AgentDispatcherPassesAgentModeAndGroupSpaceTests(SimpleTestCase):
    """任务 1 调用方端到端 — dispatch_external 透传 agent_mode 与 retired group flag。"""

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService"
    )
    def test_legacy_group_space_does_not_drive_group_runtime_flag(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "msg",
            _make_space(space_type="group"),
            attachments=None,
            thread_id="chat-session-sess-1",
            agent_mode="yolo",
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs.get("agent_mode"), "yolo")
        self.assertFalse(kwargs.get("is_group_space"))

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService"
    )
    def test_solo_space_passes_is_group_space_false(
        self, mock_pfs_cls, _peek, _disabled_prefixes, _disabled_apps,
    ):
        instance = mock_pfs_cls.return_value
        instance.forward_prompt.return_value = {"task_id": "tid", "published": 1}

        AgentDispatcher().dispatch_external(
            _make_session(),
            "msg",
            _make_space(space_type="solo"),
            attachments=None,
            thread_id="chat-session-sess-1",
            agent_mode="agent",
        )

        kwargs = instance.forward_prompt.call_args.kwargs
        self.assertEqual(kwargs.get("agent_mode"), "agent")
        self.assertFalse(kwargs.get("is_group_space"))


class ResolveSandboxPolicyAuthoritativeAgentModeTests(SimpleTestCase):
    """任务 5 / H4 — _resolve_sandbox_policy 改读 ContextVar 权威源不读 params。"""

    def setup_method(self, method):
        set_current_agent_mode(None, None)
        set_current_thread_id(None)

    def teardown_method(self, method):
        set_current_agent_mode(None, None)
        set_current_thread_id(None)

    def _mock_resolver_capture(self):
        """patch SandboxPolicyResolver.from_agent_config 截获 requested_agent_mode。"""
        captured = {}

        class _FakeResolver:
            def resolve(self, *_a, **_kw):
                d = MagicMock()
                d.to_dict.return_value = {"route": "regular"}
                return d

        def fake_from_agent_config(*args, **kwargs):
            captured["kwargs"] = kwargs
            return _FakeResolver()

        return captured, fake_from_agent_config

    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "FrontendActionService._get_space_for_thread"
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "FrontendActionService._get_explicit_agent_id_for_thread",
        return_value=None,
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "resolve_execution_agent"
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "resolve_control_device",
        return_value=None,
    )
    def test_contextvar_yolo_takes_precedence_over_params_agent(
        self, _bound_dev, _exec_agent, _explicit_agent, _space_lookup,
    ):
        """ContextVar='yolo' 时 params.agent_mode='agent' 被忽略，权威源胜出。"""
        # ContextVar 设 yolo
        set_current_thread_id("thread-yolo")
        set_current_agent_mode("thread-yolo", "yolo")

        space = _make_space(space_type="solo")
        _space_lookup.return_value = space
        _exec_agent.return_value = space.agent

        captured, fake_factory = self._mock_resolver_capture()
        with patch(
            "apps.services.common.sandbox_policy.SandboxPolicyResolver.from_agent_config",
            side_effect=fake_factory,
        ):
            FrontendActionService._resolve_sandbox_policy(
                "thread-yolo",
                "read_file",
                {"path": "/tmp/x", "agent_mode": "agent"},  # LLM 注入低权限
            )
        # 关键：requested_agent_mode 走 ContextVar 的 yolo，不是 params 的 'agent'。
        self.assertEqual(captured["kwargs"].get("requested_agent_mode"), "yolo")

    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "FrontendActionService._get_space_for_thread"
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "FrontendActionService._get_explicit_agent_id_for_thread",
        return_value=None,
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "resolve_execution_agent"
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "resolve_control_device",
        return_value=None,
    )
    def test_contextvar_agent_blocks_params_yolo_prompt_injection(
        self, _bound_dev, _exec_agent, _explicit_agent, _space_lookup,
    ):
        """ContextVar='agent' 时 params.agent_mode='yolo' 不会让攻击者提权。"""
        set_current_thread_id("thread-attack")
        set_current_agent_mode("thread-attack", "agent")

        space = _make_space(space_type="solo")
        _space_lookup.return_value = space
        _exec_agent.return_value = space.agent

        captured, fake_factory = self._mock_resolver_capture()
        with patch(
            "apps.services.common.sandbox_policy.SandboxPolicyResolver.from_agent_config",
            side_effect=fake_factory,
        ):
            with self.assertLogs(
                "apps.services.agent_engine.services.frontend_action_service",
                level=logging.WARNING,
            ) as logs:
                FrontendActionService._resolve_sandbox_policy(
                    "thread-attack",
                    "write_file",
                    {"path": "/etc/passwd", "agent_mode": "yolo"},  # prompt injection
                )

        # ContextVar 权威：'agent'，params 的 'yolo' 被丢弃
        self.assertEqual(captured["kwargs"].get("requested_agent_mode"), "agent")
        # 防御性 warning 必须被记录（供安全审计）
        joined = "\n".join(logs.output)
        self.assertIn("不一致", joined)
        self.assertIn("yolo", joined)

    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "FrontendActionService._get_space_for_thread"
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "FrontendActionService._get_explicit_agent_id_for_thread",
        return_value=None,
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "resolve_execution_agent"
    )
    @patch(
        "apps.services.agent_engine.services.frontend_action_service."
        "resolve_control_device",
        return_value=None,
    )
    def test_contextvar_unset_fallbacks_to_agent_ignoring_params(
        self, _bound_dev, _exec_agent, _explicit_agent, _space_lookup,
    ):
        """ContextVar 未命中 → fail-safe 'agent'，params 端的 yolo 不会被采纳。"""
        # 显式清空 ContextVar
        set_current_thread_id("thread-cold")
        set_current_agent_mode(None, None)

        space = _make_space(space_type="solo")
        _space_lookup.return_value = space
        _exec_agent.return_value = space.agent

        captured, fake_factory = self._mock_resolver_capture()
        with patch(
            "apps.services.common.sandbox_policy.SandboxPolicyResolver.from_agent_config",
            side_effect=fake_factory,
        ):
            FrontendActionService._resolve_sandbox_policy(
                "thread-cold",
                "read_file",
                {"path": "/tmp/x", "agent_mode": "yolo"},
            )

        # fail-safe 'agent'
        self.assertEqual(captured["kwargs"].get("requested_agent_mode"), "agent")
        # is_group_space 来自 Space.type == 'solo' → False
        self.assertFalse(captured["kwargs"].get("is_group_space"))


class ContextVarThreadIdGuardTests(SimpleTestCase):
    """CA-007 治理：thread_id 不一致 → 返回 None，防 prefork worker 残留串台。"""

    def teardown_method(self, method):
        set_current_agent_mode(None, None)

    def test_thread_id_mismatch_returns_none(self):
        set_current_agent_mode("alice-thread", "yolo")
        # bob 进来读自己的 thread
        self.assertIsNone(get_current_agent_mode(expected_thread_id="bob-thread"))

    def test_thread_id_match_returns_value(self):
        set_current_agent_mode("alice-thread", "yolo")
        self.assertEqual(get_current_agent_mode(expected_thread_id="alice-thread"), "yolo")

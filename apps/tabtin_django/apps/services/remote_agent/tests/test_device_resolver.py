"""``device_resolver.resolve_dispatch_target`` 的边界条件测试。"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.remote_agent.device_resolver import (
    DispatchTarget,
    format_device_name,
    resolve_dispatch_target,
)
from apps.tabtinspace.services.execution_binding import ExecutionBinding


def _make_session(*, session_id="sess-1", workspace=None, agent_id=None):
    session = MagicMock()
    session.id = session_id
    session.workspace = workspace
    session.agent_id = agent_id
    return session


class ResolveDispatchTargetTests(SimpleTestCase):
    @patch("apps.services.remote_agent.device_resolver.resolve_execution_binding")
    def test_extracts_explicit_agent_id_from_app_context(self, mock_resolve):
        mock_resolve.return_value = ExecutionBinding(
            device=None, source="none", agent=MagicMock(),
        )
        session = _make_session(workspace=MagicMock())

        resolve_dispatch_target(
            session,
            app_context={"_execution_agent_id": "agent-explicit-7"},
        )

        kwargs = mock_resolve.call_args.kwargs
        self.assertEqual(kwargs["agent_id"], "agent-explicit-7")
        self.assertEqual(kwargs["space"], session.workspace)

    @patch("apps.services.remote_agent.device_resolver.resolve_execution_binding")
    def test_alt_app_context_key_execution_agent_id(self, mock_resolve):
        mock_resolve.return_value = ExecutionBinding(
            device=None, source="none", agent=MagicMock(),
        )
        resolve_dispatch_target(
            _make_session(workspace=MagicMock()),
            app_context={"execution_agent_id": "agent-from-alt-key"},
        )
        kwargs = mock_resolve.call_args.kwargs
        self.assertEqual(kwargs["agent_id"], "agent-from-alt-key")

    @patch("apps.services.remote_agent.device_resolver.resolve_execution_binding")
    def test_explicit_agent_id_unresolvable_logs_warning(self, mock_resolve):
        mock_resolve.return_value = ExecutionBinding(
            device=None, source="none", agent=None,
        )
        session = _make_session(workspace=MagicMock())

        with self.assertLogs(
            "apps.services.remote_agent.device_resolver", level="WARNING",
        ) as captured:
            target = resolve_dispatch_target(
                session,
                app_context={"_execution_agent_id": "agent-missing"},
            )

        self.assertIsNone(target.agent)
        self.assertIsNone(target.control_device)
        self.assertTrue(
            any("agent-missing" in msg for msg in captured.output),
            f"expected warning to mention missing agent_id, got: {captured.output}",
        )

    @patch("apps.services.remote_agent.device_resolver.resolve_execution_binding")
    def test_no_explicit_agent_id_does_not_log_warning(self, mock_resolve):
        mock_resolve.return_value = ExecutionBinding(
            device=None, source="none", agent=None,
        )
        # 当 control_device 解析为 None 但是没传 explicit agent_id，
        # 这就是用户主动选"轻量模式"——不应该报 warning。
        with self.assertNoLogs(
            "apps.services.remote_agent.device_resolver", level="WARNING",
        ):
            resolve_dispatch_target(_make_session(workspace=MagicMock()), app_context=None)

    @patch("apps.services.remote_agent.device_resolver.resolve_execution_binding")
    def test_returns_dispatch_target_with_binding_source(self, mock_resolve):
        device = MagicMock()
        agent = MagicMock()
        mock_resolve.return_value = ExecutionBinding(
            device=device, source="workspace.device", agent=agent,
        )

        target = resolve_dispatch_target(_make_session(workspace=MagicMock()))

        self.assertIsInstance(target, DispatchTarget)
        self.assertEqual(target.control_device, device)
        self.assertEqual(target.agent, agent)
        self.assertEqual(target.binding_source, "workspace.device")

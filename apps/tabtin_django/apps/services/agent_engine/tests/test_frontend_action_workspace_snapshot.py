"""
test_frontend_action_workspace_snapshot.py — 路径权限治理 Wave 4。

钉死 FrontendActionService._resolve_sandbox_policy 在 publish_action 时从
ContextVar 取主控端透传上来的 v3 WorkspaceSnapshot，并把它透给
SandboxPolicyResolver.resolve(workspace_snapshot=...)。

业务对齐：
  - chat.send_message handler 收到的 app_context.workspace_snapshot 经
    AgentDispatcher.dispatch_external 写到 ContextVar，
    FrontendActionService.publish_action 在同一 ContextVar scope 内取出
  - workspace_snapshot 为 None 时 _resolve_sandbox_policy 应仍能正常返回
    （向后兼容；与"未传 workspace_snapshot"等价）

策略：直接 mock SandboxPolicyResolver，验证 _resolve_sandbox_policy 在
ContextVar 注入后调 resolver.resolve 时携带正确的 workspace_snapshot 参数。
"""

from __future__ import annotations

from unittest.mock import patch, MagicMock

from apps.services.agent_engine.services.frontend_action_service import (
    FrontendActionService,
)
from apps.services.common.thread_context import (
    set_current_workspace_snapshot,
    get_current_workspace_snapshot,
)


def _ws(allowed_paths):
    return {
        "sources": {
            "sandbox": "/tmp",
            "tabcodeProjects": list(allowed_paths),
            "tabfolderDirs": [],
            "attachedFiles": [],
        },
        "allowedPaths": list(allowed_paths),
        "allowedFiles": [],
        "spaceSessionId": "test-sess",
    }


class TestGetWorkspaceSnapshotFromContext:
    def teardown_method(self):
        # 防泄漏到其他测试
        set_current_workspace_snapshot(None, None)

    def test_reads_from_context_var(self):
        snap = _ws(["/proj/a"])
        set_current_workspace_snapshot("thread-1", snap)
        # P1-4：必须传 expected_thread_id 才能拿到值
        assert FrontendActionService._get_workspace_snapshot_from_context("thread-1") == snap

    def test_returns_none_when_unset(self):
        set_current_workspace_snapshot(None, None)
        assert FrontendActionService._get_workspace_snapshot_from_context("any-thread") is None

    def test_thread_id_mismatch_returns_none_p1_4(self):
        """P1-4 修复：不同 thread_id 时拿不到 ContextVar 残留 —— 防 prefork worker 串台"""
        snap = _ws(["/alice/secrets"])
        set_current_workspace_snapshot("alice-thread", snap)
        # 切到下一个用户的请求，读自己的 thread_id
        result = FrontendActionService._get_workspace_snapshot_from_context("bob-thread")
        assert result is None


class TestResolveSandboxPolicyTransitsWorkspaceSnapshot:
    def setup_method(self):
        # 提前清空，避免被其他测试遗留污染
        set_current_workspace_snapshot(None, None)

    def teardown_method(self):
        set_current_workspace_snapshot(None, None)

    def test_workspace_snapshot_passed_to_resolver_when_action_type_unknown(self):
        snap = _ws(["/proj/a"])
        set_current_workspace_snapshot("thread-1", snap)
        # 关键：set ContextVar 后还要 set thread_id 让 _get_workspace_snapshot_from_context
        # 二次校验通过
        from apps.services.common.thread_context import set_current_thread_id
        set_current_thread_id("thread-1")
        try:
            with patch(
                "apps.services.common.sandbox_policy.SandboxPolicyResolver"
            ) as mock_cls:
                mock_resolver = MagicMock()
                mock_resolver.resolve.return_value.to_dict.return_value = {
                    "route": "regular"
                }
                mock_cls.return_value = mock_resolver
                FrontendActionService._resolve_sandbox_policy(
                    "thread-1",
                    None,  # 触发 "if not action_type" 分支
                    {},
                )
                mock_resolver.resolve.assert_called_once()
                call_kwargs = mock_resolver.resolve.call_args.kwargs
                assert call_kwargs.get("workspace_snapshot") == snap
        finally:
            set_current_thread_id(None)

    def test_no_workspace_snapshot_passes_none(self):
        set_current_workspace_snapshot(None, None)
        with patch(
            "apps.services.common.sandbox_policy.SandboxPolicyResolver"
        ) as mock_cls:
            mock_resolver = MagicMock()
            mock_resolver.resolve.return_value.to_dict.return_value = {
                "route": "regular"
            }
            mock_cls.return_value = mock_resolver
            FrontendActionService._resolve_sandbox_policy(
                "thread-1", None, {}
            )
            mock_resolver.resolve.assert_called_once()
            assert (
                mock_resolver.resolve.call_args.kwargs.get("workspace_snapshot")
                is None
            )

    def test_thread_id_mismatch_blocks_stale_snapshot_p1_4(self):
        """P1-4：上一个用户残留的 ContextVar 不会被新 thread 误读"""
        snap = _ws(["/alice/secrets"])
        set_current_workspace_snapshot("alice-thread", snap)
        from apps.services.common.thread_context import set_current_thread_id
        set_current_thread_id("alice-thread")  # 模拟残留
        try:
            with patch(
                "apps.services.common.sandbox_policy.SandboxPolicyResolver"
            ) as mock_cls:
                mock_resolver = MagicMock()
                mock_resolver.resolve.return_value.to_dict.return_value = {
                    "route": "regular"
                }
                mock_cls.return_value = mock_resolver
                # bob 进来调用
                FrontendActionService._resolve_sandbox_policy(
                    "bob-thread", None, {}
                )
                # 关键：alice 的 snapshot 不应被 bob 拿到
                assert (
                    mock_resolver.resolve.call_args.kwargs.get("workspace_snapshot")
                    is None
                )
        finally:
            set_current_thread_id(None)


class TestContextVarBasic:
    def teardown_method(self):
        set_current_workspace_snapshot(None, None)

    def test_set_and_get_round_trip(self):
        snap = _ws(["/proj/x"])
        set_current_workspace_snapshot("tid", snap)
        assert get_current_workspace_snapshot("tid") == snap

    def test_reset_via_none(self):
        set_current_workspace_snapshot("tid", _ws(["/proj/x"]))
        set_current_workspace_snapshot(None, None)
        assert get_current_workspace_snapshot("tid") is None

    def test_clear_context_resets_workspace_snapshot_p1_4(self):
        """P1-4：clear_context() 必须 reset workspace_snapshot"""
        from apps.services.common.thread_context import clear_context
        snap = _ws(["/proj/x"])
        set_current_workspace_snapshot("tid", snap)
        clear_context()
        assert get_current_workspace_snapshot("tid") is None

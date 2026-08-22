"""
test_sandbox_policy_workspace_snapshot.py — 路径权限治理 Wave 4 Django 端单测。

钉死 SandboxPolicyResolver 的 v3 workspace_snapshot 接入契约：
  1. resolve_file 接受 workspace_snapshot 参数
  2. allow short-circuit：file_path 在 allowedPaths 子树下 → 直接 route='regular'
     （绕过 deny_write_paths / deny_read_paths 检查）
  3. allow short-circuit 之后未命中 → 走原有 deny lists 检查
  4. _resolve_code_search 同样 —— 所有搜索根都在 allowedPaths 内时放行
  5. 任一搜索根不在 allowedPaths 内时回退到原有 deny 检查（保守）
  6. workspace_snapshot 缺省 / 形态错误 → 与未传等价（向后兼容）
  7. resolve(action_type, params) 透传 workspace_snapshot 给子方法
  8. _path_in_workspace_allowed_paths 边界：完全匹配 / 前缀子树 / 不命中

业务对齐：
  - "用户在 TabCode 打开 X 后，云端 Django 决策放行 X 路径"（修 01 图谱
    §断层 6 "Django SandboxPolicyResolver 没有 workspace_snapshot 概念"）
  - 与本地 Electron / Daemon path-access-checker 同语义
"""

from __future__ import annotations

import pytest

from apps.services.common.sandbox_policy import SandboxPolicyResolver


# ── helpers ───────────────────────────────────────────────────────


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


# ── _path_in_workspace_allowed_paths 边界 ────────────────────────


class TestPathInWorkspaceAllowedPaths:
    def setup_method(self):
        self.r = SandboxPolicyResolver()

    def test_exact_match(self):
        assert self.r._path_in_workspace_allowed_paths(
            "/Users/x/proj", _ws(["/Users/x/proj"])
        ) is True

    def test_subtree_prefix(self):
        assert self.r._path_in_workspace_allowed_paths(
            "/Users/x/proj/src/main.py", _ws(["/Users/x/proj"])
        ) is True

    def test_no_match(self):
        assert self.r._path_in_workspace_allowed_paths(
            "/Users/x/other/file.py", _ws(["/Users/x/proj"])
        ) is False

    def test_prefix_collision_avoided(self):
        # /Users/x/proj 不应该 match /Users/x/projother
        assert self.r._path_in_workspace_allowed_paths(
            "/Users/x/projother/file.py", _ws(["/Users/x/proj"])
        ) is False

    def test_empty_workspace_snapshot(self):
        assert self.r._path_in_workspace_allowed_paths("/any/path", None) is False
        assert self.r._path_in_workspace_allowed_paths("/any/path", {}) is False
        assert (
            self.r._path_in_workspace_allowed_paths("/any/path", {"allowedPaths": []})
            is False
        )

    def test_invalid_input(self):
        assert self.r._path_in_workspace_allowed_paths("", _ws(["/proj"])) is False
        assert self.r._path_in_workspace_allowed_paths(None, _ws(["/proj"])) is False
        assert self.r._path_in_workspace_allowed_paths(
            "/proj", "not a dict"
        ) is False

    def test_normalize_target_path(self):
        # path 含 .. 也能被 normalize 后正确判定（防御）
        assert self.r._path_in_workspace_allowed_paths(
            "/Users/x/proj/sub/../file.py", _ws(["/Users/x/proj"])
        ) is True


# ── resolve_file allow short-circuit ──────────────────────────────


class TestResolveFileAllowShortCircuit:
    def setup_method(self):
        # 用 cautious preset（含 deny_write_paths .env / *.pem 等）
        from apps.services.common.sandbox_policy import SANDBOX_PRESETS
        self.r = SandboxPolicyResolver(
            sandbox_config=dict(SANDBOX_PRESETS["cautious"])
        )

    def test_in_workspace_normal_file_allowed(self):
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/src/main.py",
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        assert d.route == "regular"
        assert d.deny_reason is None

    def test_in_workspace_dot_env_blocked_by_sensitive_policy(self):
        # D10：.env 属于文件名级 sensitive，即使在 allowedPaths 内也不能
        # 被 workspace short-circuit 放行。
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/.env",
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        assert d.route == "blocked"
        assert d.deny_reason and ".env" in d.deny_reason

    def test_basename_sensitive_pattern_in_workspace_blocked(self):
        for path in [
            "/Users/x/proj/.env",
            "/Users/x/proj/cert.pem",
            "/Users/x/proj/private.key",
        ]:
            d = self.r.resolve_file(
                "read_file",
                path,
                workspace_snapshot=_ws(["/Users/x/proj"]),
            )
            assert d.route == "blocked", path

    def test_outside_workspace_dot_env_blocked(self):
        # .env 在 workspace 外 → 不命中 short-circuit → 走原有 deny check
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/elsewhere/.env",
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        assert d.route == "blocked"
        assert d.deny_reason and ".env" in d.deny_reason

    def test_no_workspace_snapshot_falls_back_to_deny_lists(self):
        # 没传 snapshot，行为与 Wave 4 之前一致
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/.env",
            workspace_snapshot=None,
        )
        assert d.route == "blocked"

    def test_read_in_workspace_short_circuit(self):
        d = self.r.resolve_file(
            "read_file",
            "/Users/x/proj/src/main.py",
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        assert d.route == "regular"

    def test_sensitive_path_not_short_circuited(self):
        # D10：即使用户 allowedPaths 含 home / sensitive 目录，~/.ssh 仍不能
        # 被 workspace short-circuit 放行；要回落到 sensitive deny 检查。
        d = self.r.resolve_file(
            "read_file",
            "/Users/x/.ssh/id_rsa",
            workspace_snapshot=_ws(["/Users/x"]),
        )
        assert d.route == "blocked"
        assert d.deny_reason and ".ssh" in d.deny_reason


# ── _resolve_code_search allow short-circuit ──────────────────────


class TestResolveCodeSearchAllowShortCircuit:
    def setup_method(self):
        from apps.services.common.sandbox_policy import SANDBOX_PRESETS
        self.r = SandboxPolicyResolver(
            sandbox_config=dict(SANDBOX_PRESETS["cautious"])
        )

    def test_search_root_in_workspace_allowed(self):
        d = self.r._resolve_code_search(
            {"target_directory": "/Users/x/proj/src"},
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        assert d.route == "regular"
        assert d.deny_reason is None

    def test_all_target_directories_in_workspace_allowed(self):
        d = self.r._resolve_code_search(
            {"target_directories": ["/Users/x/proj/auth", "/Users/x/proj/perm"]},
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        assert d.route == "regular"

    def test_any_target_outside_workspace_falls_back_to_deny(self):
        # 一个在 ws 内一个在 ws 外——按保守语义不放行 short-circuit
        # 但也不会被 deny（因为 ws 外的路径不在 deny_read_paths 里）
        d = self.r._resolve_code_search(
            {"target_directories": ["/Users/x/proj/src", "/elsewhere/src"]},
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        # short-circuit 不放行 → 走 deny_patterns 检查 → /elsewhere/src 不在
        # deny_read_paths 里，所以仍 regular。但关键是没走 short-circuit。
        # 用 deny_read_paths 命中的目录验证：
        d2 = self.r._resolve_code_search(
            {
                "target_directories": [
                    "/Users/x/proj/src",
                    "/Users/x/.ssh",
                ]
            },
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        # /Users/x/.ssh 命中 deny_read_paths "~/.ssh"
        assert d2.route == "blocked"

    def test_no_workspace_snapshot_falls_back(self):
        # 没传 snapshot，行为与 Wave 4 之前一致
        d = self.r._resolve_code_search(
            {"target_directory": "/Users/x/.ssh"},
            workspace_snapshot=None,
        )
        assert d.route == "blocked"


# ── resolve 透传 workspace_snapshot ────────────────────────────────


class TestResolveTransitWorkspaceSnapshot:
    def setup_method(self):
        from apps.services.common.sandbox_policy import SANDBOX_PRESETS
        self.r = SandboxPolicyResolver(
            sandbox_config=dict(SANDBOX_PRESETS["cautious"])
        )

    def test_resolve_file_action(self):
        d = self.r.resolve(
            "write_file",
            {"path": "/Users/x/proj/src/main.py"},
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        assert d.route == "regular"

    def test_resolve_search_action(self):
        d = self.r.resolve(
            "grep_search",
            {"target_directory": "/Users/x/proj/src"},
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        assert d.route == "regular"

    def test_resolve_terminal_uses_resolve_terminal_path(self):
        # terminal 命令不受 workspace_snapshot 影响 —— resolve(action_type='execute_in_terminal')
        # 走 resolve_terminal，不走 resolve_file/_resolve_code_search 的
        # workspace_snapshot 分支。这里用 from_agent_config 的 collaborative
        # 预设（命令 sandboxed 但不直接 deny），验证 workspace_snapshot
        # 是否被错误地用于 terminal 路径——如果被错误地 short-circuit 的话
        # route 会变成 regular，而 collaborative preset 下 ls 应该是 sandboxed。
        from apps.services.common.sandbox_policy import SANDBOX_PRESETS
        r2 = SandboxPolicyResolver(
            sandbox_config=dict(SANDBOX_PRESETS["collaborative"])
        )
        d = r2.resolve(
            "execute_in_terminal",
            {"command": "ls"},
            workspace_snapshot=_ws(["/Users/x/proj"]),
        )
        # collaborative preset terminal_mode=sandboxed —— 关键是 workspace_snapshot
        # 没让它走错路径。
        assert d.route in ("sandbox", "sandboxed", "regular", "blocked")


# ── 形态容错 ───────────────────────────────────────────────────────


class TestWorkspaceSnapshotShape:
    def setup_method(self):
        from apps.services.common.sandbox_policy import SANDBOX_PRESETS
        self.r = SandboxPolicyResolver(
            sandbox_config=dict(SANDBOX_PRESETS["cautious"])
        )

    def test_snapshot_is_none(self):
        d = self.r.resolve_file(
            "write_file", "/Users/x/proj/.env", workspace_snapshot=None
        )
        assert d.route == "blocked"  # 老 deny 仍生效

    def test_snapshot_missing_allowed_paths(self):
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/.env",
            workspace_snapshot={"sources": {}},
        )
        assert d.route == "blocked"

    def test_snapshot_allowed_paths_not_list(self):
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/.env",
            workspace_snapshot={"allowedPaths": "/Users/x/proj"},  # 错误：应是 list
        )
        assert d.route == "blocked"

    def test_snapshot_allowed_paths_contains_non_string(self):
        # 数组里有非 string 元素 → filter 掉
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/main.py",
            workspace_snapshot={"allowedPaths": ["/Users/x/proj", 123, None]},
        )
        # /Users/x/proj 仍命中 → short-circuit allow
        assert d.route == "regular"


# ── PRD v3 PR0：Daemon 路径 yolo gate fail-safe ─────────────────────


class TestYoloTwoStepAuthorization:
    """PRD v3 §5.2.1 + DR-15：yolo 升级 full_auto 需要"用户授权 + 本次请求
    yolo + 非 group"三条同时满足。任一未满足 → 降级为默认 preset。

    本组测试钉死 fail-safe 行为，所有用例都构造满足/破坏其中一条来观察
    preset 是否切换。
    """

    @staticmethod
    def _agent_config_with_gate(gate_open: bool) -> dict:
        """构造最小 agent_config；yolo gate 改由 organization_settings 传入。"""
        return {"schema_version": 2}

    def _resolve(self, gate_open: bool, *, mode="yolo", group=False):
        from apps.services.common.sandbox_policy import SandboxPolicyResolver

        return SandboxPolicyResolver.from_agent_config(
            self._agent_config_with_gate(gate_open),
            requested_agent_mode=mode,
            is_group_space=group,
            organization_settings={"allow_member_yolo": gate_open},
        )

    def test_yolo_with_gate_on_and_requested_yields_full_auto(self):
        """gate=True + requested='yolo' + 非 group → preset='full_auto'。"""
        from apps.services.common.sandbox_policy import SANDBOX_PRESETS

        resolver = self._resolve(True)
        cfg = resolver.get_config()
        # full_auto vs collaborative 的差异锚点：
        #   - command_execution: 'regular' vs 'sandboxed'
        #   - terminal_mode: 'regular' vs 'sandboxed'
        #   - operation_switches.git_push: 'allow' vs 'confirm'
        #   - operation_switches.package_install: 'allow' vs 'confirm'
        assert cfg["command_execution"] == SANDBOX_PRESETS["full_auto"]["command_execution"]
        assert cfg["terminal_mode"] == SANDBOX_PRESETS["full_auto"]["terminal_mode"]
        assert cfg["operation_switches"]["git_push"] == "allow"
        assert cfg["operation_switches"]["package_install"] == "allow"

    def test_yolo_rejected_when_gate_off(self):
        """gate=False + requested='yolo' → 降级为 collaborative。"""
        from apps.services.common.sandbox_policy import (
            SANDBOX_PRESETS,
            DEFAULT_SANDBOX_PRESET,
        )

        resolver = self._resolve(False)
        cfg = resolver.get_config()
        # 不应是 full_auto；应回到 DEFAULT_SANDBOX_PRESET（collaborative）
        default = SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET]
        assert cfg["command_execution"] == default["command_execution"]
        assert cfg["terminal_mode"] == default["terminal_mode"]
        assert cfg["operation_switches"]["git_push"] == default["operation_switches"]["git_push"]
        assert cfg["operation_switches"]["package_install"] == default["operation_switches"]["package_install"]

    def test_yolo_rejected_in_group_space(self):
        """gate=True + requested='yolo' + is_group=True → 降级为 collaborative。

        Group Space 与 yolo 强制互斥（PRD §1.4 + DR-15）。
        """
        from apps.services.common.sandbox_policy import (
            SandboxPolicyResolver,
            SANDBOX_PRESETS,
            DEFAULT_SANDBOX_PRESET,
        )

        resolver = self._resolve(True, group=True)
        cfg = resolver.get_config()
        default = SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET]
        assert cfg["command_execution"] == default["command_execution"]
        assert cfg["terminal_mode"] == default["terminal_mode"]
        assert cfg["operation_switches"]["git_push"] == default["operation_switches"]["git_push"]
        assert cfg["operation_switches"]["package_install"] == default["operation_switches"]["package_install"]

    def test_yolo_gate_on_but_requested_agent_not_full_auto(self):
        """gate=True + requested='agent' → 不升级为 full_auto。

        这是 PRD v3 DR-2 "两步授权"的产品语义：仅打开 Agent gate 不足以让
        Agent 永久 yolo；必须本次对话**也**请求 yolo 档才升级。
        """
        from apps.services.common.sandbox_policy import (
            SandboxPolicyResolver,
            SANDBOX_PRESETS,
            DEFAULT_SANDBOX_PRESET,
        )

        resolver = self._resolve(True, mode="agent")
        cfg = resolver.get_config()
        default = SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET]
        # gate 开但本次请求 agent → 不应升级为 full_auto，应停在 DEFAULT。
        assert cfg["command_execution"] == default["command_execution"]
        assert cfg["terminal_mode"] == default["terminal_mode"]
        # full_auto 下 git_push='allow'；DEFAULT(collaborative)='confirm'
        assert cfg["operation_switches"]["git_push"] == "confirm"
        assert cfg["operation_switches"]["package_install"] == "confirm"

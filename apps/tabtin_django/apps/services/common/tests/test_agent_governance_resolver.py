"""agent_governance_resolver 单测（组织天花板 +  approval_grant + fail-safe）。

覆盖：
- ``resolve_allow_yolo_mode``：组织显式 true/false / 缺失 / fail-safe
- ``resolve_approval_grant``：Agent grant ∩ 组织天花板
- ``resolve_execution_limits``：per-key（Agent 显式 ?? None）
- ``compact_execution_limits``：去 None / 全空→None
- 读取点集成：``agent_dispatcher.get_yolo_mode`` /
  ``SandboxPolicyResolver.from_agent_config`` 取到正确 resolved 值

（：组织准入天花板；#3503：三档审批 grant。）
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace

from apps.services.common.agent_governance_resolver import (
    ORG_ALLOW_MEMBER_YOLO_KEY,
    compact_execution_limits,
    resolve_allow_yolo_mode,
    resolve_approval_grant,
    resolve_execution_limits,
)


def _org_settings(allow_member_yolo=None):
    if allow_member_yolo is None:
        return {}
    return {ORG_ALLOW_MEMBER_YOLO_KEY: allow_member_yolo}


def _agent_cfg(
    *,
    allow_yolo=None,
    approval_grant=None,
    max_iter=None,
    max_credits=None,
):
    """构造 v2 形状 agent_config。"""
    security = {}
    if allow_yolo is not None:
        security["allow_yolo_mode"] = allow_yolo
    if approval_grant is not None:
        security["approval_grant"] = approval_grant
    return {
        "schema_version": 2,
        "security": security,
        "capabilities": {
            "overrides": {
                "cost": {
                    "execution_limits": {
                        "max_iterations_per_run": max_iter,
                        "max_credits_per_run": max_credits,
                    },
                },
            },
        },
    }


class ResolveAllowYoloModeTests(unittest.TestCase):
    def test_org_explicit_true(self):
        self.assertTrue(resolve_allow_yolo_mode(_org_settings(True)))

    def test_org_explicit_false(self):
        self.assertFalse(resolve_allow_yolo_mode(_org_settings(False)))

    def test_org_missing_defaults_false(self):
        self.assertFalse(resolve_allow_yolo_mode(_org_settings()))

    def test_none_organization_settings_system_default(self):
        self.assertFalse(resolve_allow_yolo_mode(None))

    def test_dirty_non_dict_organization_settings_normalized_to_default(self):
        self.assertFalse(resolve_allow_yolo_mode("not-a-dict"))

    def test_fail_safe_on_exception_returns_false(self):
        class _BoomDict(dict):
            def get(self, *args, **kwargs):
                raise RuntimeError("boom")

        self.assertFalse(resolve_allow_yolo_mode(_BoomDict()))

    def test_truthy_string_not_allowed(self):
        self.assertFalse(resolve_allow_yolo_mode({ORG_ALLOW_MEMBER_YOLO_KEY: "yes"}))


class ResolveApprovalGrantTests(unittest.TestCase):
    def test_org_closed_clamps_full_access(self):
        self.assertEqual(
            resolve_approval_grant(
                _agent_cfg(approval_grant="full_access"),
                _org_settings(False),
            ),
            "always_ask",
        )

    def test_org_open_keeps_grant(self):
        self.assertEqual(
            resolve_approval_grant(
                _agent_cfg(approval_grant="auto"),
                _org_settings(True),
            ),
            "auto",
        )

    def test_org_open_legacy_yolo_maps_to_auto(self):
        self.assertEqual(
            resolve_approval_grant(
                _agent_cfg(allow_yolo=True),
                _org_settings(True),
            ),
            "auto",
        )

    def test_org_missing_defaults_closed(self):
        self.assertEqual(
            resolve_approval_grant(_agent_cfg(approval_grant="auto"), None),
            "always_ask",
        )

    def test_grant_prefers_approval_grant_over_legacy(self):
        self.assertEqual(
            resolve_approval_grant(
                _agent_cfg(approval_grant="full_access", allow_yolo=False),
                _org_settings(True),
            ),
            "full_access",
        )


class ResolveExecutionLimitsTests(unittest.TestCase):
    def test_agent_values(self):
        out = resolve_execution_limits(_agent_cfg(max_iter=100, max_credits="20"))
        self.assertEqual(out["max_iterations_per_run"], 100)
        self.assertEqual(out["max_credits_per_run"], "20")

    def test_partial_agent_values(self):
        out = resolve_execution_limits(_agent_cfg(max_iter=100))
        self.assertEqual(out["max_iterations_per_run"], 100)
        self.assertIsNone(out["max_credits_per_run"])

    def test_all_unset_returns_none_pair(self):
        out = resolve_execution_limits(_agent_cfg())
        self.assertEqual(
            out, {"max_iterations_per_run": None, "max_credits_per_run": None}
        )

    def test_fail_safe_dirty(self):
        out = resolve_execution_limits("dirty")
        self.assertEqual(
            out, {"max_iterations_per_run": None, "max_credits_per_run": None}
        )

    def test_workspace_disabled_skips_agent_fallback(self):
        out = resolve_execution_limits(
            _agent_cfg(max_iter=100, max_credits="20"),
            workspace_execution_limits={"enabled": False},
        )
        self.assertEqual(
            out, {"max_iterations_per_run": None, "max_credits_per_run": None}
        )

    def test_empty_workspace_skips_agent_fallback(self):
        out = resolve_execution_limits(
            _agent_cfg(max_iter=100, max_credits="20"),
            workspace_execution_limits={},
        )
        self.assertEqual(
            out, {"max_iterations_per_run": None, "max_credits_per_run": None}
        )


class CompactExecutionLimitsTests(unittest.TestCase):
    def test_drops_none_keys(self):
        self.assertEqual(
            compact_execution_limits(
                {"max_iterations_per_run": 100, "max_credits_per_run": None}
            ),
            {"max_iterations_per_run": 100},
        )

    def test_all_none_returns_none(self):
        self.assertIsNone(
            compact_execution_limits(
                {"max_iterations_per_run": None, "max_credits_per_run": None}
            )
        )

    def test_keeps_both(self):
        self.assertEqual(
            compact_execution_limits(
                {"max_iterations_per_run": 1, "max_credits_per_run": "5.0"}
            ),
            {"max_iterations_per_run": 1, "max_credits_per_run": "5.0"},
        )

    def test_non_dict_none(self):
        self.assertIsNone(compact_execution_limits(None))


class GetYoloModeReadPointTests(unittest.TestCase):
    """读取点 1：agent_dispatcher.get_yolo_mode 取组织天花板。"""

    @staticmethod
    def _space(org_settings):
        organization = SimpleNamespace(settings=org_settings)
        return SimpleNamespace(organization=organization)

    def _get_yolo(self, space):
        from apps.services.agent_engine.engine.agent_dispatcher import get_yolo_mode

        return get_yolo_mode(space)

    def test_org_open_true(self):
        self.assertTrue(self._get_yolo(self._space(_org_settings(True))))

    def test_org_closed_false(self):
        self.assertFalse(self._get_yolo(self._space(_org_settings(False))))

    def test_org_missing_false(self):
        self.assertFalse(self._get_yolo(self._space({})))

    def test_no_organization_false(self):
        self.assertFalse(self._get_yolo(SimpleNamespace(organization=None)))


class SandboxFromAgentConfigReadPointTests(unittest.TestCase):
    """读取点 3：SandboxPolicyResolver.from_agent_config 的 yolo gate 走组织天花板。"""

    @staticmethod
    def _is_full_auto(resolver) -> bool:
        return resolver.get_config().get("command_execution") == "regular"

    def _resolve(self, org_open, *, mode="yolo", group=False):
        from apps.services.common.sandbox_policy import SandboxPolicyResolver

        return SandboxPolicyResolver.from_agent_config(
            _agent_cfg(),
            requested_agent_mode=mode,
            is_group_space=group,
            organization_settings=_org_settings(org_open),
        )

    def test_org_gate_opens_yolo_when_requested(self):
        r = self._resolve(True)
        self.assertTrue(self._is_full_auto(r))

    def test_org_gate_off_stays_collaborative(self):
        r = self._resolve(False)
        self.assertFalse(self._is_full_auto(r))

    def test_group_space_blocks_even_with_org_yolo(self):
        r = self._resolve(True, group=True)
        self.assertFalse(self._is_full_auto(r))

    def test_not_requested_yolo_stays_collaborative(self):
        r = self._resolve(True, mode="agent")
        self.assertFalse(self._is_full_auto(r))


class BuildDefaultTests(unittest.TestCase):
    """build_default：新建 Agent 带 security.allow_yolo_mode=None（ legacy）。"""

    def test_default_allow_yolo_is_none(self):
        from apps.tabtinspace.agent_config_v2 import build_default_agent_config_v2

        cfg = build_default_agent_config_v2()
        self.assertIsNone(cfg["security"]["allow_yolo_mode"])

    def test_default_execution_limits_none_pair(self):
        from apps.tabtinspace.agent_config_v2 import (
            build_default_agent_config_v2,
            get_capability_override,
        )

        cfg = build_default_agent_config_v2()
        el = get_capability_override(cfg, "cost", "execution_limits")
        self.assertEqual(
            el, {"max_iterations_per_run": None, "max_credits_per_run": None}
        )


if __name__ == "__main__":
    unittest.main()

"""Phase 2 W2a —— Canonical Runtime Profile Foundation 场景验收。

覆盖:v1→v2 / deep 降级 / max 未声明 / forced thinking / BYOK。
纯函数,不接 Session / Proxy / UI。
"""

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile import (
    parse_profile,
    read_model_capability,
    resolve_user_runtime,
    upgrade_v1_to_v2,
)


class V1ToV2FoundationTests(SimpleTestCase):

    def test_upgrade_and_resolve_preserves_high_strength(self):
        v2 = upgrade_v1_to_v2({"reasoning_effort": "high"})
        self.assertEqual(v2["v"], 2)
        self.assertEqual(v2["thinking_mode"], "deep")
        self.assertIsNone(v2["reasoning_effort"])

        resolved = resolve_user_runtime(
            v2,
            {
                "runtime_profile": {
                    "thinking": {
                        "supported": True,
                        "effort_levels": ["low", "medium", "high"],
                    },
                },
            },
        )
        self.assertEqual(resolved.resolved_effort, "high")
        self.assertEqual(resolved.resolved_thinking_mode, "deep")
        self.assertFalse(resolved.downgraded)
        self.assertIsNone(resolved.notice)

    def test_parse_v1_max_keeps_override(self):
        profile = parse_profile({"reasoning_effort": "max"})
        self.assertEqual(profile.thinking_mode, "deep")
        self.assertEqual(profile.reasoning_effort, "max")


class DeepDowngradeTests(SimpleTestCase):

    def test_deep_downgrades_when_model_only_supports_medium(self):
        resolved = resolve_user_runtime(
            {"v": 2, "thinking_mode": "deep"},
            {
                "runtime_profile": {
                    "thinking": {
                        "supported": True,
                        "effort_levels": ["low", "medium"],
                    },
                },
            },
        )
        self.assertTrue(resolved.thinking_enabled)
        self.assertEqual(resolved.resolved_effort, "medium")
        self.assertEqual(resolved.resolved_thinking_mode, "standard")
        self.assertTrue(resolved.downgraded)
        self.assertEqual(
            resolved.downgrades[0].reason, "effort_level_unavailable",
        )
        self.assertIn("可用档", resolved.notice)


class MaxUnsupportedTests(SimpleTestCase):

    def test_inferred_capability_never_includes_max(self):
        cap = read_model_capability({
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "param_path": "reasoning_effort",
                },
            },
        })
        self.assertNotIn("max", cap.thinking.effort_levels)

    def test_max_intent_downgrades_on_three_level_model(self):
        resolved = resolve_user_runtime(
            {"v": 2, "thinking_mode": "deep", "reasoning_effort": "max"},
            {
                "runtime_profile": {
                    "thinking": {
                        "supported": True,
                        "effort_levels": ["low", "medium", "high"],
                    },
                },
            },
        )
        self.assertEqual(resolved.resolved_effort, "high")
        self.assertTrue(resolved.downgraded)
        self.assertEqual(resolved.downgrades[0].requested, "max")

    def test_max_only_when_explicitly_declared(self):
        resolved = resolve_user_runtime(
            {"v": 2, "thinking_mode": "deep", "reasoning_effort": "max"},
            {
                "runtime_profile": {
                    "thinking": {
                        "supported": True,
                        "effort_levels": ["low", "high", "max"],
                    },
                },
            },
        )
        self.assertEqual(resolved.resolved_effort, "max")
        self.assertFalse(resolved.downgraded)


class ForcedThinkingTests(SimpleTestCase):

    def test_off_falls_to_lowest_with_notice(self):
        resolved = resolve_user_runtime(
            {"v": 2, "thinking_mode": "off"},
            {
                "runtime_profile": {
                    "thinking": {
                        "supported": True,
                        "off_supported": False,
                        "effort_levels": ["low", "high", "max"],
                    },
                },
            },
            model_label="Kimi K3",
        )
        self.assertEqual(resolved.resolved_effort, "low")
        self.assertEqual(resolved.resolved_thinking_mode, "standard")
        self.assertTrue(resolved.downgraded)
        self.assertEqual(
            resolved.downgrades[0].reason, "thinking_off_unsupported",
        )
        self.assertIn("始终思考", resolved.notice)

    def test_capability_hides_off_chip(self):
        cap = read_model_capability({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "off_supported": False,
                    "effort_levels": ["low", "high", "max"],
                },
            },
        })
        self.assertNotIn("off", cap.thinking.user_selectable)


class ByokFoundationTests(SimpleTestCase):

    def test_byok_hidden_without_peer(self):
        resolved = resolve_user_runtime(
            {"v": 2, "thinking_mode": "deep"},
            {"wire_adapter": {"reasoning": {"enabled": False}}},
        )
        self.assertFalse(resolved.thinking_enabled)
        self.assertTrue(resolved.downgraded)
        self.assertEqual(
            resolved.downgrades[0].reason, "thinking_not_controllable",
        )

    def test_byok_inherits_global_same_name(self):
        byok_config = {
            "wire_adapter": {"reasoning": {"enabled": False}},
        }
        global_peer = {
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["low", "medium", "high", "max"],
                    "off_supported": True,
                },
            },
        }
        resolved = resolve_user_runtime(
            {"v": 2, "thinking_mode": "deep"},
            byok_config,
            global_peer_capabilities_config=global_peer,
        )
        self.assertTrue(resolved.thinking_enabled)
        self.assertEqual(resolved.resolved_effort, "high")
        self.assertFalse(resolved.downgraded)

        cap = read_model_capability(
            byok_config, global_peer_capabilities_config=global_peer,
        )
        self.assertTrue(cap.inherited)
        self.assertIn("max", cap.thinking.effort_levels)

    def test_xhigh_never_enters_canonical_profile(self):
        profile = parse_profile({
            "v": 2,
            "thinking_mode": "deep",
            "reasoning_effort": "xhigh",
        })
        self.assertIsNone(profile.reasoning_effort)
        v2 = upgrade_v1_to_v2({"reasoning_effort": "xhigh"})
        self.assertIsNone(v2["reasoning_effort"])
        self.assertEqual(v2["thinking_mode"], "deep")

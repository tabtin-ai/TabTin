"""Phase 2 W2c —— Proxy Runtime Resolution Matrix。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile.feature_flag import is_runtime_profile_enabled
from apps.services.llm.runtime_profile.proxy_resolution import (
    apply_runtime_profile_resolution,
)
from apps.services.llm.services.proxy_service import (
    ProxyContext,
    _apply_runtime_params_for_proxy,
    _merge_model_param_overrides,
)


def _model(*, capabilities_config=None, model_name="test-model"):
    return SimpleNamespace(
        id="model-1",
        model_name=model_name,
        capabilities_config=capabilities_config or {},
    )


def _three_level_cap():
    return {
        "runtime_profile": {
            "thinking": {
                "supported": True,
                "off_supported": True,
                "effort_levels": ["low", "medium", "high"],
                "default_effort": "medium",
            },
        },
    }


def _forced_thinking_cap():
    return {
        "runtime_profile": {
            "thinking": {
                "supported": True,
                "off_supported": False,
                "effort_levels": ["low", "high", "max"],
                "default_effort": "high",
            },
        },
    }


class RuntimeProfileProxyMatrixTests(SimpleTestCase):
    """W2c 要求的 Proxy Matrix。"""

    def test_deep_on_supported_model(self):
        upstream = {"model": "m", "messages": []}
        resolved, events = apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "deep"}},
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.resolved_thinking_mode, "deep")
        self.assertEqual(resolved.resolved_effort, "high")
        self.assertFalse(resolved.downgraded)
        self.assertIsNone(resolved.notice)
        self.assertEqual(upstream["reasoning_effort"], "high")
        self.assertNotIn("thinking_mode", upstream)
        self.assertEqual(events, [])

    def test_deep_downgrade_when_model_only_supports_medium(self):
        upstream = {"model": "m", "messages": []}
        cap = {
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["low", "medium"],
                },
            },
        }
        resolved, events = apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "deep"}},
            model_instance=_model(capabilities_config=cap),
        )
        self.assertEqual(resolved.resolved_effort, "medium")
        self.assertEqual(resolved.resolved_thinking_mode, "standard")
        self.assertTrue(resolved.downgraded)
        self.assertIsNotNone(resolved.notice)
        self.assertEqual(upstream["reasoning_effort"], "medium")
        self.assertEqual(events[0]["reason"], "effort_level_unavailable")
        self.assertEqual(events[0]["stage"], "runtime_profile")

    def test_off_writes_canonical_off(self):
        upstream = {"model": "m", "messages": []}
        resolved, events = apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "off"}},
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        self.assertFalse(resolved.thinking_enabled)
        self.assertEqual(resolved.resolved_thinking_mode, "off")
        self.assertFalse(resolved.downgraded)
        self.assertEqual(upstream["reasoning_effort"], "off")
        self.assertEqual(events, [])

    def test_max_unsupported_downgrades_to_high(self):
        upstream = {"model": "m", "messages": []}
        resolved, _events = apply_runtime_profile_resolution(
            upstream,
            {
                "model_param_overrides": {
                    "v": 2,
                    "thinking_mode": "deep",
                    "reasoning_effort": "max",
                },
            },
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        self.assertEqual(resolved.resolved_effort, "high")
        self.assertTrue(resolved.downgraded)
        self.assertEqual(upstream["reasoning_effort"], "high")

    def test_forced_thinking_off_falls_to_lowest(self):
        upstream = {"model": "m", "messages": []}
        resolved, events = apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "off"}},
            model_instance=_model(
                capabilities_config=_forced_thinking_cap(),
                model_name="kimi-k3",
            ),
            model_label="kimi-k3",
        )
        self.assertEqual(resolved.resolved_effort, "low")
        self.assertTrue(resolved.downgraded)
        self.assertEqual(events[0]["reason"], "thinking_off_unsupported")
        self.assertEqual(upstream["reasoning_effort"], "low")

    def test_tool_choice_required_skips_resolution(self):
        """门禁轮优先级：已有 tool_choice 时不注入 effort。"""
        upstream = {
            "model": "m",
            "messages": [],
            "tool_choice": "required",
            "thinking": {"type": "disabled"},
        }
        resolved, events = apply_runtime_profile_resolution(
            upstream,
            {
                "model_param_overrides": {"v": 2, "thinking_mode": "deep"},
                "tool_choice": "required",
            },
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        self.assertIsNone(resolved)
        self.assertEqual(events, [])
        self.assertNotIn("reasoning_effort", upstream)
        self.assertEqual(upstream["thinking"], {"type": "disabled"})
        self.assertNotIn("thinking_mode", upstream)

    def test_does_not_pass_thinking_mode_to_upstream(self):
        upstream = {"model": "m", "messages": [], "thinking_mode": "deep"}
        apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "deep"}},
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        self.assertNotIn("thinking_mode", upstream)
        self.assertEqual(upstream["reasoning_effort"], "high")

    def test_pp_only_skips_resolve_and_keeps_upstream_clean(self):
        """PP-only + v2：不进 thinking resolve，不出网 PP / effort。"""
        upstream = {
            "model": "m",
            "messages": [],
            "performance_profile": "fast",
        }
        with mock.patch(
            "apps.services.llm.runtime_profile.proxy_resolution.resolve_runtime_profile",
        ) as resolve_mock:
            resolved, events = apply_runtime_profile_resolution(
                upstream,
                {
                    "model_param_overrides": {
                        "v": 2,
                        "performance_profile": "fast",
                    },
                },
                model_instance=_model(capabilities_config=_three_level_cap()),
            )
        resolve_mock.assert_not_called()
        self.assertIsNone(resolved)
        self.assertEqual(events, [])
        self.assertNotIn("reasoning_effort", upstream)
        self.assertNotIn("performance_profile", upstream)
        self.assertNotIn("thinking_mode", upstream)

    def test_thinking_plus_pp_resolves_effort_without_pp_upstream(self):
        upstream = {
            "model": "m",
            "messages": [],
            "performance_profile": "fast",
        }
        resolved, events = apply_runtime_profile_resolution(
            upstream,
            {
                "model_param_overrides": {
                    "v": 2,
                    "thinking_mode": "deep",
                    "performance_profile": "fast",
                },
            },
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.resolved_effort, "high")
        self.assertEqual(upstream["reasoning_effort"], "high")
        self.assertNotIn("performance_profile", upstream)
        self.assertNotIn("thinking_mode", upstream)
        self.assertEqual(events, [])

    def test_v2_only_skips_resolve(self):
        upstream = {"model": "m", "messages": []}
        with mock.patch(
            "apps.services.llm.runtime_profile.proxy_resolution.resolve_runtime_profile",
        ) as resolve_mock:
            resolved, events = apply_runtime_profile_resolution(
                upstream,
                {"model_param_overrides": {"v": 2}},
                model_instance=_model(capabilities_config=_three_level_cap()),
            )
        resolve_mock.assert_not_called()
        self.assertIsNone(resolved)
        self.assertEqual(events, [])
        self.assertNotIn("reasoning_effort", upstream)
        self.assertNotIn("thinking_mode", upstream)


class RuntimeProfileFlagRoutingTests(SimpleTestCase):

    @mock.patch.dict("os.environ", {"LLM_RUNTIME_PROFILE_ENABLED": "false"})
    def test_flag_off_keeps_legacy_merge(self):
        self.assertFalse(is_runtime_profile_enabled(_model()))
        upstream = {"model": "m", "messages": []}
        ctx = ProxyContext(
            request_id="r1",
            model_name="m",
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        events = _apply_runtime_params_for_proxy(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "deep"}},
            ctx,
        )
        # 旧 merge 不认 thinking_mode → 不写 reasoning_effort
        self.assertEqual(events, [])
        self.assertNotIn("reasoning_effort", upstream)

        # 旧路径仍透传 reasoning_effort（含未校验值）
        upstream2 = {"model": "m", "messages": []}
        value = {"provider_specific": True}
        _merge_model_param_overrides(
            upstream2,
            {"model_param_overrides": {"reasoning_effort": value}},
        )
        self.assertEqual(upstream2["reasoning_effort"], value)

    @mock.patch.dict("os.environ", {"LLM_RUNTIME_PROFILE_ENABLED": "true"})
    def test_flag_on_resolves_v2_thinking_mode(self):
        self.assertTrue(is_runtime_profile_enabled(_model()))
        upstream = {"model": "m", "messages": []}
        ctx = ProxyContext(
            request_id="r2",
            model_name="m",
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        events = _apply_runtime_params_for_proxy(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "deep"}},
            ctx,
        )
        self.assertEqual(upstream["reasoning_effort"], "high")
        self.assertEqual(events, [])

    @mock.patch.dict("os.environ", {"LLM_RUNTIME_PROFILE_ENABLED": "true"})
    def test_v1_flat_effort_still_resolves(self):
        upstream = {"model": "m", "messages": []}
        ctx = ProxyContext(
            request_id="r3",
            model_name="m",
            model_instance=_model(capabilities_config=_three_level_cap()),
        )
        _apply_runtime_params_for_proxy(
            upstream,
            {"model_param_overrides": {"reasoning_effort": "high"}},
            ctx,
        )
        self.assertEqual(upstream["reasoning_effort"], "high")

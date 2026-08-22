"""Doubao thinking+reasoning_effort wire 映射。"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile.proxy_resolution import (
    apply_runtime_profile_resolution,
)
from apps.services.llm.wire_adapter.request_adapter import (
    _normalize_reasoning_param,
    _normalize_tool_choice,
)
from apps.services.llm.wire_adapter.resolved_capabilities import (
    ReasoningCaps,
    ResolvedCapabilities,
    ToolCaps,
)


def _ctx(model_name: str = "doubao-seed-evolving"):
    return SimpleNamespace(request_id="test-req", model_name=model_name)


def _doubao_caps() -> ResolvedCapabilities:
    caps = ResolvedCapabilities()
    caps.reasoning = ReasoningCaps(
        enabled=True,
        format="reasoning_content_field",
        param_path="thinking+reasoning_effort",
        budget_param="reasoning_effort",
        visible_to_client=True,
    )
    return caps


def _doubao_model(model_name: str, *, default_effort: str = "high"):
    """模拟 0054 capability + 0055 wire。"""
    return SimpleNamespace(
        id=f"id-{model_name}",
        model_name=model_name,
        capabilities_config={
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "format": "reasoning_content_field",
                    "param_path": "thinking+reasoning_effort",
                    "budget_param": "reasoning_effort",
                    "visible_to_client": True,
                },
            },
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "off_supported": True,
                    "effort_levels": ["low", "medium", "high"],
                    "default_effort": default_effort,
                    "user_selectable": ["off", "standard", "deep"],
                },
            },
        },
    )


def _wire_after_resolve(model_name: str, thinking_mode: str, *, default_effort: str = "high"):
    model = _doubao_model(model_name, default_effort=default_effort)
    upstream = {"model": model_name, "messages": []}
    apply_runtime_profile_resolution(
        upstream,
        {"model_param_overrides": {"v": 2, "thinking_mode": thinking_mode}},
        model_instance=model,
        model_label=model_name,
    )
    return _normalize_reasoning_param(upstream, _doubao_caps(), _ctx(model_name))


class DoubaoNormalizeUnitTests(SimpleTestCase):
    def test_off_writes_thinking_disabled_without_effort(self):
        body = {"reasoning_effort": "off", "messages": []}
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertEqual(out["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", out)

    def test_minimal_also_disables(self):
        body = {"reasoning_effort": "minimal", "messages": []}
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertEqual(out["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", out)

    def test_medium_enables_with_medium_effort(self):
        body = {"reasoning_effort": "medium", "messages": []}
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertEqual(out["thinking"], {"type": "enabled"})
        self.assertEqual(out["reasoning_effort"], "medium")

    def test_high_enables_with_high_effort(self):
        body = {"reasoning_effort": "high", "messages": []}
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertEqual(out["thinking"], {"type": "enabled"})
        self.assertEqual(out["reasoning_effort"], "high")

    def test_low_passthrough(self):
        body = {"reasoning_effort": "low", "messages": []}
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertEqual(out["thinking"]["type"], "enabled")
        self.assertEqual(out["reasoning_effort"], "low")

    def test_does_not_remap_medium_to_high(self):
        """K3 分支会 medium→high；Doubao 必须保留 medium。"""
        body = {"reasoning_effort": "medium", "messages": []}
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertEqual(out["reasoning_effort"], "medium")

    def test_off_does_not_become_max(self):
        """旧 reasoning_effort 分支会把 off 误写成 max。"""
        body = {"reasoning_effort": "off", "messages": []}
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertNotEqual(out.get("reasoning_effort"), "max")
        self.assertNotIn("reasoning_effort", out)

    def test_idempotent_existing_thinking_disabled_without_effort(self):
        body = {"thinking": {"type": "disabled"}, "messages": []}
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertEqual(out["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", out)

    def test_merges_existing_thinking_dict_on_enable(self):
        body = {
            "reasoning_effort": "high",
            "thinking": {"type": "disabled", "keep": "x"},
            "messages": [],
        }
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        self.assertEqual(out["thinking"]["type"], "enabled")
        self.assertEqual(out["thinking"]["keep"], "x")
        self.assertEqual(out["reasoning_effort"], "high")

    def test_unknown_effort_downgrades(self):
        body = {"reasoning_effort": "turbo", "messages": []}
        events = []
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx(), events)
        self.assertEqual(out["reasoning_effort"], "medium")
        self.assertEqual(out["thinking"]["type"], "enabled")
        self.assertEqual(events[0]["reason"], "unknown_reasoning_effort_level")

    def test_no_performance_keys(self):
        body = {
            "reasoning_effort": "high",
            "performance_profile": "fast",
            "messages": [],
        }
        out = _normalize_reasoning_param(body, _doubao_caps(), _ctx())
        # wire 不消费也不清除无关键；确保未写入 performance 出网字段
        self.assertNotIn("performance", out)
        self.assertNotIn("speed_mode", out)


class DoubaoEvolvingPipelineTests(SimpleTestCase):
    def test_off(self):
        out = _wire_after_resolve("doubao-seed-evolving", "off")
        self.assertEqual(out["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", out)
        self.assertNotIn("thinking_mode", out)
        self.assertNotIn("performance_profile", out)

    def test_standard_medium(self):
        out = _wire_after_resolve("doubao-seed-evolving", "standard")
        self.assertEqual(out["thinking"], {"type": "enabled"})
        self.assertEqual(out["reasoning_effort"], "medium")

    def test_deep_high(self):
        out = _wire_after_resolve("doubao-seed-evolving", "deep")
        self.assertEqual(out["thinking"], {"type": "enabled"})
        self.assertEqual(out["reasoning_effort"], "high")


class DoubaoLitePipelineTests(SimpleTestCase):
    def test_off(self):
        out = _wire_after_resolve(
            "doubao-seed-2-0-lite-260428", "off", default_effort="medium",
        )
        self.assertEqual(out["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", out)

    def test_standard_medium(self):
        out = _wire_after_resolve(
            "doubao-seed-2-0-lite-260428", "standard", default_effort="medium",
        )
        self.assertEqual(out["thinking"]["type"], "enabled")
        self.assertEqual(out["reasoning_effort"], "medium")

    def test_deep_high(self):
        out = _wire_after_resolve(
            "doubao-seed-2-0-lite-260428", "deep", default_effort="medium",
        )
        self.assertEqual(out["thinking"]["type"], "enabled")
        self.assertEqual(out["reasoning_effort"], "high")


class NonDoubaoUnchangedTests(SimpleTestCase):
    def test_kimi_k3_still_strips_thinking_and_keeps_effort(self):
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="reasoning_content_field",
            param_path="reasoning_effort",
            budget_param="reasoning_effort",
        )
        body = {
            "reasoning_effort": "low",
            "thinking": {"type": "disabled"},
            "messages": [],
        }
        events = []
        out = _normalize_reasoning_param(body, caps, _ctx("kimi-k3"), events)
        self.assertEqual(out["reasoning_effort"], "low")
        self.assertNotIn("thinking", out)

    def test_kimi_k2_thinking_path_unchanged(self):
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="reasoning_content_field",
            param_path="thinking",
        )
        body = {"reasoning_effort": "off", "messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx("kimi-k2.6"))
        self.assertEqual(out["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", out)


class ToolChoiceMutexTests(SimpleTestCase):
    def test_tool_choice_required_skips_resolve_keeps_disabled_thinking(self):
        """Proxy 对 tool_choice 跳过 resolve；wire 幂等保留 thinking.disabled。"""
        model = _doubao_model("doubao-seed-evolving")
        upstream = {
            "model": "doubao-seed-evolving",
            "messages": [],
            "tool_choice": "required",
            "thinking": {"type": "disabled"},
        }
        resolved, events = apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "deep"}},
            model_instance=model,
            model_label="doubao-seed-evolving",
        )
        self.assertIsNone(resolved)
        self.assertEqual(events, [])
        self.assertEqual(upstream["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", upstream)

        out = _normalize_reasoning_param(
            upstream, _doubao_caps(), _ctx("doubao-seed-evolving"),
        )
        self.assertEqual(out["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", out)

    def test_tool_choice_normalize_not_regressed(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(
            enabled=True,
            choice_modes=("auto", "none", "required", "specific"),
        )
        body = {"tool_choice": "required", "messages": []}
        out = _normalize_tool_choice(body, caps, _ctx())
        self.assertEqual(out["tool_choice"], "required")


class MigrationParamPathTests(SimpleTestCase):
    def test_0055_targets_and_merge_helper(self):
        path = (
            Path(__file__).resolve().parents[2]
            / "migrations"
            / "0055_doubao_thinking_wire_param_path.py"
        )
        spec = importlib.util.spec_from_file_location("mig_0055_doubao_wire", path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        keys = set(module.DOUBAO_WIRE_TARGETS)
        self.assertIn(("volcengine", "doubao-seed-evolving"), keys)
        self.assertIn(("volcengine", "doubao-seed-2-0-lite-260428"), keys)
        self.assertIn(("volcengine_doubao", "doubao-seed-2-1-pro-260628"), keys)
        self.assertIn(("volcengine_doubao", "doubao-seed-2-1-turbo-260628"), keys)

        old = {
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "format": "reasoning_content_field",
                    "param_path": "reasoning_effort",
                    "visible_to_client": True,
                },
                "tool": {"enabled": True},
            },
            "runtime_controls": [{"key": "reasoning_effort"}],
            "runtime_profile": {"thinking": {"supported": True}},
            "billing": {"currency": "CNY"},
        }
        new = module._set_reasoning_param_path(old, module.NEW_PARAM_PATH)
        self.assertEqual(
            new["wire_adapter"]["reasoning"]["param_path"],
            "thinking+reasoning_effort",
        )
        self.assertEqual(new["wire_adapter"]["tool"], old["wire_adapter"]["tool"])
        self.assertEqual(new["runtime_controls"], old["runtime_controls"])
        self.assertEqual(new["runtime_profile"], old["runtime_profile"])
        self.assertEqual(new["billing"], old["billing"])
        self.assertEqual(
            new["wire_adapter"]["reasoning"]["format"],
            "reasoning_content_field",
        )

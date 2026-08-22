"""Kimi Runtime Profile 能力矩阵 + wire 映射（含 0056 K2.x 二进制纠正）。"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile.capability import read_model_capability
from apps.services.llm.runtime_profile.catalog import serialize_runtime_profile_for_client
from apps.services.llm.runtime_profile.proxy_resolution import (
    apply_runtime_profile_resolution,
)
from apps.services.llm.runtime_profile.resolver import resolve_user_runtime
from apps.services.llm.wire_adapter.request_adapter import _normalize_reasoning_param
from apps.services.llm.wire_adapter.resolved_capabilities import (
    ReasoningCaps,
    ResolvedCapabilities,
)


def _load_migration(filename: str, module_name: str):
    path = Path(__file__).resolve().parents[2] / "migrations" / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_MIG_0053 = _load_migration(
    "0053_kimi_runtime_profile_capabilities.py",
    "llm_mig_0053_kimi_runtime_profile",
)
_MIG_0056 = _load_migration(
    "0056_kimi_k2x_binary_thinking_correction.py",
    "llm_mig_0056_kimi_k2x_binary",
)

KIMI_THINKING_PROFILES = dict(_MIG_0053.KIMI_THINKING_PROFILES)
KIMI_THINKING_PROFILES.update(_MIG_0056.KIMI_K2X_THINKING_CORRECTIONS)
KIMI_CONTEXT_PROFILES = _MIG_0053.KIMI_CONTEXT_PROFILES
merge_runtime_profile_thinking = _MIG_0053.merge_runtime_profile_thinking
merge_runtime_profile = _MIG_0053.merge_runtime_profile
merge_thinking_correction = _MIG_0056.merge_thinking_correction

_KIMI_MATRIX_MODELS = (
    "kimi-k3",
    "kimi-k2.6",
    "kimi-k2.5",
    "kimi-k2.7-code",
)


def _caps_with_thinking(model_name: str, *, wire_reasoning: dict | None = None) -> dict:
    thinking = KIMI_THINKING_PROFILES[model_name]
    cfg = {
        "wire_adapter": {
            "reasoning": wire_reasoning
            or {
                "enabled": True,
                "format": "reasoning_content_field",
                "param_path": "thinking",
                "budget_param": None,
                "visible_to_client": True,
            },
        },
        "supports_reasoning": True,
        "billing": {"currency": "CNY"},
        "context_window": 262144,
    }
    return merge_runtime_profile_thinking(cfg, thinking)


def _model(model_name: str, capabilities_config: dict):
    return SimpleNamespace(
        id=f"id-{model_name}",
        model_name=model_name,
        capabilities_config=capabilities_config,
    )


def _kimi_thinking_wire(body: dict) -> dict:
    caps = ResolvedCapabilities()
    caps.reasoning = ReasoningCaps(
        enabled=True,
        format="reasoning_content_field",
        param_path="thinking",
        budget_param=None,
    )
    return _normalize_reasoning_param(dict(body), caps)


class MigrationMergeTests(SimpleTestCase):
    def test_merge_preserves_wire_billing_and_context(self):
        old = {
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "param_path": "reasoning_effort",
                    "format": "reasoning_content_field",
                },
                "tool": {"enabled": True},
            },
            "billing": {"currency": "CNY"},
            "context_window": 1048576,
            "supports_vision": True,
            "runtime_controls": [{"key": "temperature"}],
        }
        thinking = KIMI_THINKING_PROFILES["kimi-k3"]
        new = merge_runtime_profile_thinking(old, thinking)

        self.assertEqual(new["wire_adapter"], old["wire_adapter"])
        self.assertEqual(new["billing"], old["billing"])
        self.assertEqual(new["context_window"], old["context_window"])
        self.assertEqual(new["runtime_controls"], old["runtime_controls"])
        self.assertTrue(new["supports_vision"])
        self.assertEqual(new["runtime_profile"]["thinking"], thinking)

    def test_0056_correction_preserves_unknown_thinking_keys(self):
        old = {
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "notes": "keep-me",
                    "effort_levels": ["medium"],
                },
            },
            "wire_adapter": {"reasoning": {"param_path": "thinking"}},
        }
        new = merge_thinking_correction(
            old, _MIG_0056.KIMI_K2X_THINKING_CORRECTIONS["kimi-k2.5"],
        )
        thinking = new["runtime_profile"]["thinking"]
        self.assertEqual(thinking["notes"], "keep-me")
        self.assertEqual(thinking["effort_levels"], [])
        self.assertEqual(thinking["user_selectable"], ["off", "standard"])
        self.assertEqual(new["wire_adapter"], old["wire_adapter"])


class KimiNoPerformanceCapabilityTests(SimpleTestCase):
    def test_all_kimi_profiles_omit_performance(self):
        for model_name in KIMI_THINKING_PROFILES:
            with self.subTest(model=model_name):
                thinking = KIMI_THINKING_PROFILES[model_name]
                self.assertNotIn("performance", thinking)
                cfg = _caps_with_thinking(model_name)
                rp = cfg["runtime_profile"]
                self.assertNotIn("performance", rp)


class KimiK3CapabilityTests(SimpleTestCase):
    def setUp(self):
        self.cfg = _caps_with_thinking(
            "kimi-k3",
            wire_reasoning={
                "enabled": True,
                "format": "reasoning_content_field",
                "param_path": "reasoning_effort",
                "budget_param": "reasoning_effort",
                "visible_to_client": True,
            },
        )

    def test_capability_supported_no_off_max_present(self):
        cap = read_model_capability(self.cfg)
        self.assertTrue(cap.thinking.supported)
        self.assertFalse(cap.thinking.off_supported)
        self.assertEqual(cap.thinking.effort_levels, ("low", "high", "max"))
        self.assertTrue(cap.thinking.effort_supported)
        self.assertEqual(cap.thinking.user_selectable, ("standard", "deep"))

    def test_catalog_modes_standard_deep_default_deep(self):
        catalog = serialize_runtime_profile_for_client(self.cfg)
        thinking = catalog["thinking"]
        self.assertTrue(thinking["supported"])
        self.assertEqual(thinking["modes"], ["standard", "deep"])
        self.assertEqual(thinking["default_mode"], "deep")
        self.assertNotIn("always_on", thinking)


class KimiK25BinaryCapabilityTests(SimpleTestCase):
    def setUp(self):
        self.cfg = _caps_with_thinking("kimi-k2.5")

    def test_thinking_toggle_no_effort(self):
        cap = read_model_capability(self.cfg)
        self.assertTrue(cap.thinking.supported)
        self.assertTrue(cap.thinking.off_supported)
        self.assertFalse(cap.thinking.effort_supported)
        self.assertEqual(cap.thinking.effort_levels, ())
        self.assertEqual(cap.thinking.user_selectable, ("off", "standard"))
        self.assertNotIn("deep", cap.thinking.user_selectable)

    def test_catalog_binary_modes(self):
        catalog = serialize_runtime_profile_for_client(self.cfg)["thinking"]
        self.assertEqual(catalog["modes"], ["off", "standard"])
        self.assertEqual(catalog["default_mode"], "standard")
        self.assertNotIn("always_on", catalog)

    def test_wire_on_enabled_no_budget_no_effort(self):
        upstream = {"model": "kimi-k2.5", "messages": []}
        apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "standard"}},
            model_instance=_model("kimi-k2.5", self.cfg),
            model_label="kimi-k2.5",
        )
        self.assertEqual(upstream["reasoning_effort"], "on")
        out = _kimi_thinking_wire(upstream)
        self.assertEqual(out["thinking"], {"type": "enabled"})
        self.assertNotIn("budget_tokens", out["thinking"])
        self.assertNotIn("keep", out["thinking"])
        self.assertNotIn("reasoning_effort", out)

    def test_wire_off_disabled(self):
        upstream = {"model": "kimi-k2.5", "messages": []}
        apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "off"}},
            model_instance=_model("kimi-k2.5", self.cfg),
            model_label="kimi-k2.5",
        )
        self.assertEqual(upstream["reasoning_effort"], "off")
        out = _kimi_thinking_wire(upstream)
        self.assertEqual(out["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", out)

    def test_legacy_deep_collapses_to_on_without_banner(self):
        resolved = resolve_user_runtime(
            {"v": 2, "thinking_mode": "deep"},
            self.cfg,
            model_label="kimi-k2.5",
        )
        self.assertTrue(resolved.thinking_enabled)
        self.assertIsNone(resolved.resolved_effort)
        self.assertEqual(resolved.downgrades, ())


class KimiK26BinaryCapabilityTests(SimpleTestCase):
    def setUp(self):
        self.cfg = _caps_with_thinking("kimi-k2.6")

    def test_same_capability_shape_as_k25(self):
        self.assertEqual(
            KIMI_THINKING_PROFILES["kimi-k2.6"],
            KIMI_THINKING_PROFILES["kimi-k2.5"],
        )

    def test_wire_on_off(self):
        for mode, expected_type in (("standard", "enabled"), ("off", "disabled")):
            with self.subTest(mode=mode):
                upstream = {"model": "kimi-k2.6", "messages": []}
                apply_runtime_profile_resolution(
                    upstream,
                    {"model_param_overrides": {"v": 2, "thinking_mode": mode}},
                    model_instance=_model("kimi-k2.6", self.cfg),
                    model_label="kimi-k2.6",
                )
                out = _kimi_thinking_wire(upstream)
                self.assertEqual(out["thinking"], {"type": expected_type})
                self.assertNotIn("reasoning_effort", out)
                self.assertNotIn("budget_tokens", out.get("thinking", {}))


class KimiK27AlwaysOnCapabilityTests(SimpleTestCase):
    def setUp(self):
        self.cfg = _caps_with_thinking("kimi-k2.7-code")

    def test_always_on_no_toggle_no_effort(self):
        raw = KIMI_THINKING_PROFILES["kimi-k2.7-code"]
        self.assertTrue(raw.get("forced") is True)
        self.assertFalse(raw["off_supported"])
        self.assertEqual(raw["user_selectable"], [])
        self.assertEqual(raw["effort_levels"], [])

        cap = read_model_capability(self.cfg)
        self.assertTrue(cap.thinking.supported)
        self.assertFalse(cap.thinking.off_supported)
        self.assertFalse(cap.thinking.effort_supported)
        self.assertEqual(cap.thinking.user_selectable, ())

        catalog = serialize_runtime_profile_for_client(self.cfg)["thinking"]
        self.assertTrue(catalog["supported"])
        self.assertEqual(catalog["modes"], [])
        self.assertTrue(catalog.get("always_on") is True)

    def test_off_intent_stays_on_no_disabled_wire(self):
        resolved = resolve_user_runtime(
            {"v": 2, "thinking_mode": "off"},
            self.cfg,
            model_label="kimi-k2.7-code",
        )
        self.assertTrue(resolved.thinking_enabled)
        self.assertIsNone(resolved.resolved_effort)
        self.assertEqual(resolved.downgrades[0].reason, "thinking_off_unsupported")

        upstream = {"model": "kimi-k2.7-code", "messages": []}
        apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "off"}},
            model_instance=_model("kimi-k2.7-code", self.cfg),
            model_label="kimi-k2.7-code",
        )
        # 始终开启：写 on，绝不写 off → wire 不会产出 disabled
        self.assertEqual(upstream["reasoning_effort"], "on")
        out = _kimi_thinking_wire(upstream)
        self.assertEqual(out["thinking"], {"type": "enabled"})
        self.assertNotEqual(out["thinking"].get("type"), "disabled")
        self.assertNotIn("reasoning_effort", out)

    def test_no_effort_levels_sent(self):
        upstream = {"model": "kimi-k2.7-code", "messages": []}
        apply_runtime_profile_resolution(
            upstream,
            {"model_param_overrides": {"v": 2, "thinking_mode": "standard"}},
            model_instance=_model("kimi-k2.7-code", self.cfg),
            model_label="kimi-k2.7-code",
        )
        out = _kimi_thinking_wire(upstream)
        self.assertNotIn("reasoning_effort", out)
        self.assertNotIn("budget_tokens", out.get("thinking", {}))

    def test_highspeed_profile_matches_k27_code(self):
        self.assertEqual(
            KIMI_THINKING_PROFILES["kimi-k2.7-code-highspeed"],
            KIMI_THINKING_PROFILES["kimi-k2.7-code"],
        )


class KimiMatrixSmokeTests(SimpleTestCase):
    def test_matrix_models_declared(self):
        for name in _KIMI_MATRIX_MODELS:
            self.assertIn(name, KIMI_THINKING_PROFILES)
            self.assertTrue(KIMI_THINKING_PROFILES[name]["supported"])

    def test_k2x_never_sends_reasoning_effort_ladder(self):
        for name in ("kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code"):
            with self.subTest(model=name):
                cfg = _caps_with_thinking(name)
                upstream = {"model": name, "messages": []}
                apply_runtime_profile_resolution(
                    upstream,
                    {"model_param_overrides": {"v": 2, "thinking_mode": "standard"}},
                    model_instance=_model(name, cfg),
                    model_label=name,
                )
                out = _kimi_thinking_wire(upstream)
                self.assertNotIn("reasoning_effort", out)
                self.assertEqual(out["thinking"]["type"], "enabled")

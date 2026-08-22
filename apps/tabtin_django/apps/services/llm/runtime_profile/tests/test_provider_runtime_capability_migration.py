"""0054 Provider Runtime Profile capability migration（Doubao / OpenAI / Qwen）。"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile.capability import read_model_capability
from apps.services.llm.runtime_profile.catalog import serialize_runtime_profile_for_client


def _load_migration_module():
    path = (
        Path(__file__).resolve().parents[2]
        / "migrations"
        / "0054_provider_runtime_profile_capabilities.py"
    )
    spec = importlib.util.spec_from_file_location(
        "llm_mig_0054_provider_runtime_profile", path,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_MIG = _load_migration_module()
merge_runtime_profile = _MIG.merge_runtime_profile
DOUBAO_THINKING = _MIG.DOUBAO_THINKING
DOUBAO_THINKING_HIGH_DEFAULT = _MIG.DOUBAO_THINKING_HIGH_DEFAULT
DOUBAO_THINKING_MEDIUM_DEFAULT = _MIG.DOUBAO_THINKING_MEDIUM_DEFAULT
GPT54_THINKING = _MIG.GPT54_THINKING
THINKING_AND_CONTEXT_TARGETS = _MIG.THINKING_AND_CONTEXT_TARGETS
QWEN_CONTEXT_TARGETS = _MIG.QWEN_CONTEXT_TARGETS


class MergeContractTests(SimpleTestCase):
    def test_merge_preserves_wire_and_runtime_controls(self):
        old = {
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "param_path": "reasoning_effort",
                },
            },
            "runtime_controls": [{"key": "reasoning_effort"}],
            "billing": {"currency": "CNY"},
        }
        new = merge_runtime_profile(
            old,
            thinking=DOUBAO_THINKING,
            context={"supported": True, "window_tokens": 262144},
        )
        self.assertEqual(new["wire_adapter"], old["wire_adapter"])
        self.assertEqual(new["runtime_controls"], old["runtime_controls"])
        self.assertEqual(new["billing"], old["billing"])
        self.assertEqual(new["runtime_profile"]["thinking"], DOUBAO_THINKING)
        self.assertEqual(
            new["runtime_profile"]["context"]["window_tokens"],
            262144,
        )

    def test_merge_strips_performance_never_writes_it(self):
        old = {
            "runtime_profile": {
                "performance": {"supported": True, "modes": ["fast"]},
                "performance_profile": {"x": 1},
            },
        }
        new = merge_runtime_profile(
            old,
            thinking=GPT54_THINKING,
            context={"supported": True, "window_tokens": 128000},
        )
        self.assertNotIn("performance", new["runtime_profile"])
        self.assertNotIn("performance_profile", new["runtime_profile"])
        self.assertNotIn("performance", DOUBAO_THINKING)
        self.assertNotIn("performance", GPT54_THINKING)

    def test_context_only_does_not_invent_thinking(self):
        old = {"wire_adapter": {}}
        new = merge_runtime_profile(
            old,
            thinking=None,
            context={"supported": True, "window_tokens": 20481},
        )
        self.assertNotIn("thinking", new["runtime_profile"])
        self.assertTrue(new["runtime_profile"]["context"]["supported"])
        cap = read_model_capability(new)
        # 无 thinking 声明且无 wire reasoning → unsupported
        self.assertFalse(cap.thinking.supported)


class DoubaoCapabilityTests(SimpleTestCase):
    def test_official_high_default_models(self):
        """方舟文档：thinking.type 可关；evolving/2.1 默认 reasoning_effort=high。"""
        cfg = merge_runtime_profile(
            {
                "wire_adapter": {
                    "reasoning": {
                        "enabled": True,
                        "param_path": "reasoning_effort",
                    },
                },
            },
            thinking=DOUBAO_THINKING_HIGH_DEFAULT,
            context={"supported": True, "window_tokens": 1048576},
        )
        cap = read_model_capability(cfg)
        self.assertTrue(cap.declared)
        self.assertTrue(cap.thinking.supported)
        self.assertTrue(cap.thinking.off_supported)
        self.assertEqual(cap.thinking.effort_levels, ("low", "medium", "high"))
        self.assertEqual(cap.thinking.default_effort, "high")
        catalog = serialize_runtime_profile_for_client(cfg)["thinking"]
        self.assertEqual(catalog["modes"], ["off", "standard", "deep"])
        # default_effort=high → Catalog default_mode=deep
        self.assertEqual(catalog["default_mode"], "deep")
        self.assertNotIn("performance", cfg["runtime_profile"])

    def test_seed_lite_medium_default(self):
        cfg = merge_runtime_profile(
            {"wire_adapter": {"reasoning": {"enabled": True, "param_path": "reasoning_effort"}}},
            thinking=DOUBAO_THINKING_MEDIUM_DEFAULT,
            context={"supported": True, "window_tokens": 262144},
        )
        cap = read_model_capability(cfg)
        self.assertTrue(cap.thinking.off_supported)
        self.assertEqual(cap.thinking.default_effort, "medium")
        catalog = serialize_runtime_profile_for_client(cfg)["thinking"]
        self.assertIn("off", catalog["modes"])
        self.assertEqual(catalog["default_mode"], "standard")


class OpenAICapabilityTests(SimpleTestCase):
    def test_gpt54_has_thinking_with_off(self):
        cfg = merge_runtime_profile(
            {
                "wire_adapter": {
                    "reasoning": {
                        "enabled": True,
                        "param_path": "reasoning_effort",
                    },
                },
                "runtime_controls": [{"key": "reasoning_effort"}],
            },
            thinking=GPT54_THINKING,
            context={"supported": True, "window_tokens": 128000},
        )
        cap = read_model_capability(cfg)
        self.assertTrue(cap.thinking.supported)
        self.assertTrue(cap.thinking.off_supported)
        self.assertEqual(cap.thinking.effort_levels, ("low", "medium", "high"))
        catalog = serialize_runtime_profile_for_client(cfg)["thinking"]
        self.assertIn("off", catalog["modes"])
        self.assertNotIn("xhigh", catalog["modes"])
        self.assertNotIn("performance", cfg["runtime_profile"])

    def test_gpt41_mini_context_only_no_thinking(self):
        cfg = merge_runtime_profile(
            {"wire_adapter": {}},
            thinking=None,
            context={"supported": True, "window_tokens": 20481},
        )
        self.assertNotIn("thinking", cfg["runtime_profile"])
        cap = read_model_capability(cfg)
        self.assertFalse(cap.thinking.supported)
        catalog = serialize_runtime_profile_for_client(cfg)["thinking"]
        self.assertFalse(catalog["supported"])


class QwenAuditTests(SimpleTestCase):
    def test_qwen_targets_are_context_only(self):
        for provider_key, model_name, window in QWEN_CONTEXT_TARGETS:
            with self.subTest(provider=provider_key, model=model_name):
                self.assertGreater(window, 0)
        # 矩阵目标不得误带 thinking
        for provider_key, model_name, thinking, _window in THINKING_AND_CONTEXT_TARGETS:
            if "qwen" in provider_key or "dashscope" in provider_key:
                self.assertIsNone(thinking)

    def test_qwen_plus_context_merge_no_thinking_no_performance(self):
        cfg = merge_runtime_profile(
            {"supports_vision": False},
            thinking=None,
            context={"supported": True, "window_tokens": 1048576},
        )
        rp = cfg["runtime_profile"]
        self.assertEqual(rp["context"]["window_tokens"], 1048576)
        self.assertNotIn("thinking", rp)
        self.assertNotIn("performance", rp)


class TargetMatrixCoverageTests(SimpleTestCase):
    def test_required_models_present(self):
        thinking_keys = {
            (pk, name) for pk, name, thinking, _ in THINKING_AND_CONTEXT_TARGETS if thinking
        }
        context_keys = {
            (pk, name) for pk, name, _, _ in THINKING_AND_CONTEXT_TARGETS
        } | {(pk, name) for pk, name, _ in QWEN_CONTEXT_TARGETS}

        for key in (
            ("volcengine", "doubao-seed-evolving"),
            ("volcengine", "doubao-seed-2-0-lite-260428"),
            ("volcengine_doubao", "doubao-seed-2-1-pro-260628"),
            ("volcengine_doubao", "doubao-seed-2-1-turbo-260628"),
            ("openai-local", "gpt-5.4-mini"),
        ):
            self.assertIn(key, thinking_keys)

        # gpt-4.1：仅 context
        gpt41 = [
            (pk, name, thinking)
            for pk, name, thinking, _ in THINKING_AND_CONTEXT_TARGETS
            if "gpt-4.1" in name
        ]
        self.assertTrue(gpt41)
        for _pk, _name, thinking in gpt41:
            self.assertIsNone(thinking)

        self.assertIn(("qwen", "qwen3.6-plus"), context_keys)
        self.assertIn(("qwen", "qwen3.7-plus"), context_keys)

    def test_context_block_prefers_model_window(self):
        model = SimpleNamespace(context_window_tokens=999)
        block = _MIG._context_block(model, window_hint=262144)
        self.assertEqual(block["window_tokens"], 999)
        self.assertTrue(block["supported"])

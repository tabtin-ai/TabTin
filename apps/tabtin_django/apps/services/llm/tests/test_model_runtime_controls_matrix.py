"""Test-DB model reasoning-effort matrix regression tests."""

from __future__ import annotations

import importlib.util
from pathlib import Path

from django.test import SimpleTestCase


def _load_runtime_controls_migration():
    migration_path = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "0050_model_runtime_controls.py"
    )
    spec = importlib.util.spec_from_file_location(
        "_llm_0050_model_runtime_controls",
        migration_path,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ModelRuntimeControlsMatrixTests(SimpleTestCase):
    """Keep active controls aligned with ready chat models in the test DB."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.migration = _load_runtime_controls_migration()

    def test_all_documented_models_have_the_expected_controls(self):
        expected = {
            ("moonshot", "kimi-k2.7-code"): [],
            ("moonshot", "kimi-k2.6"): [],
            ("moonshot", "kimi-k2.5"): [],
            (
                "volcengine_doubao",
                "doubao-seed-2-1-pro-260628",
            ): ["reasoning_effort"],
            (
                "volcengine_doubao",
                "doubao-seed-2-1-turbo-260628",
            ): ["reasoning_effort"],
            (
                "volcengine",
                "doubao-seed-2-0-lite-260428",
            ): ["reasoning_effort"],
            ("openai", "deepseek-v4-pro"): ["reasoning_effort"],
            ("openai", "gpt-4.1"): [],
            ("openai", "gpt-4.1-mini-2025-04-14"): [],
            ("openai-local", "gpt-5.4-mini"): ["reasoning_effort"],
            ("qwen", "glm-5"): [],
            ("qwen", "kimi-k2.5"): [],
            ("qwen", "qwen3.6-plus"): [],
            ("qwen", "qwen3.7-plus"): [],
        }

        actual = {}
        for provider_key, models in self.migration.MODEL_RUNTIME_CONTROLS.items():
            for model_name, controls in models.items():
                actual[(provider_key, model_name)] = [
                    control["key"] for control in controls
                ]

        self.assertEqual(
            set(actual),
            {model_key for model_key, control_keys in expected.items() if control_keys},
        )
        for model_key, expected_keys in expected.items():
            self.assertEqual(
                actual.get(model_key, []),
                expected_keys,
                f"{model_key} runtime controls drifted from support matrix",
            )

    def test_documented_option_ranges_are_exact(self):
        controls = self.migration.MODEL_RUNTIME_CONTROLS

        deepseek = controls["openai"]["deepseek-v4-pro"]
        self.assertEqual(
            [option["value"] for option in deepseek[0]["options"]],
            [None, "high", "max"],
        )

        gpt = controls["openai-local"]["gpt-5.4-mini"][0]
        self.assertEqual(gpt["default_value"], "none")
        self.assertEqual(
            [option["value"] for option in gpt["options"]],
            ["none", "low", "medium", "high", "xhigh"],
        )

    def test_kimi_k3_research_is_retained_but_not_enabled(self):
        self.assertNotIn("moonshot", self.migration.MODEL_RUNTIME_CONTROLS)
        self.assertEqual(
            [
                option["value"]
                for option in self.migration.KIMI_K3_REASONING_EFFORT_CONTROL[
                    "options"
                ]
            ],
            [None, "low", "high", "max"],
        )

    def test_new_reasoning_models_patch_wire_capabilities(self):
        expected = {
            ("openai", "deepseek-v4-pro"): "reasoning_effort",
            ("openai-local", "gpt-5.4-mini"): "reasoning_effort",
        }

        for model_key, param_path in expected.items():
            patch = self.migration.MODEL_REASONING_PATCHES[model_key]
            self.assertTrue(patch["enabled"])
            self.assertEqual(patch["param_path"], param_path)

        self.assertEqual(
            self.migration.MODEL_REASONING_PATCHES[
                ("openai-local", "gpt-5.4-mini")
            ]["format"],
            "hidden",
        )

"""W1b · feature_flag.is_wire_adapter_enabled 单测。

测试矩阵:
- env LLM_WIRE_ADAPTER_ENABLED 缺省 / true / false / 0 / off / yes / 大小写
- model_instance.wire_adapter_disabled True / False / 缺失字段
- model_instance=None
"""

from __future__ import annotations

from unittest import mock

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter import is_wire_adapter_enabled


class _FakeModel:
    """轻量 LLMModel 替身。"""

    def __init__(self, wire_adapter_disabled: bool = False, model_name: str = "test-model"):
        self.wire_adapter_disabled = wire_adapter_disabled
        self.model_name = model_name


class FeatureFlagEnvTests(SimpleTestCase):
    def test_env_missing_defaults_enabled(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            # 确保 env 缺失
            import os
            os.environ.pop("LLM_WIRE_ADAPTER_ENABLED", None)
            self.assertTrue(is_wire_adapter_enabled(_FakeModel()))

    def test_env_true_enabled(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"}):
            self.assertTrue(is_wire_adapter_enabled(_FakeModel()))

    def test_env_false_disabled(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "false"}):
            self.assertFalse(is_wire_adapter_enabled(_FakeModel()))

    def test_env_zero_disabled(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "0"}):
            self.assertFalse(is_wire_adapter_enabled(_FakeModel()))

    def test_env_off_disabled(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "OFF"}):
            self.assertFalse(is_wire_adapter_enabled(_FakeModel()))

    def test_env_no_disabled(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "no"}):
            self.assertFalse(is_wire_adapter_enabled(_FakeModel()))

    def test_env_disable_keyword_disabled(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "disable"}):
            self.assertFalse(is_wire_adapter_enabled(_FakeModel()))

    def test_env_random_string_treated_enabled(self):
        # 任何非 disable token 都视为启用(防 typo 时默认安全)
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "yeahsure"}):
            self.assertTrue(is_wire_adapter_enabled(_FakeModel()))


class FeatureFlagModelOverrideTests(SimpleTestCase):
    def test_model_disabled_overrides_env_enabled(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"}):
            self.assertFalse(
                is_wire_adapter_enabled(_FakeModel(wire_adapter_disabled=True)),
            )

    def test_model_not_disabled_with_env_enabled(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"}):
            self.assertTrue(
                is_wire_adapter_enabled(_FakeModel(wire_adapter_disabled=False)),
            )

    def test_env_disabled_short_circuits_before_model_check(self):
        # env=false 时不需要看 model 字段(短路)
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "false"}):
            self.assertFalse(
                is_wire_adapter_enabled(_FakeModel(wire_adapter_disabled=False)),
            )

    def test_model_none_passes_through(self):
        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"}):
            self.assertTrue(is_wire_adapter_enabled(None))

    def test_model_missing_attr_treated_enabled(self):
        # 老 LLMModel 实例(W1a-fix-2 之前没 wire_adapter_disabled 字段)
        # → getattr 默认 False → 视为启用
        class OldModel:
            model_name = "legacy"

        with mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"}):
            self.assertTrue(is_wire_adapter_enabled(OldModel()))

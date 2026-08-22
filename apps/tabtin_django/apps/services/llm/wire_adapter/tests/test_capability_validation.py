"""W1c · validator + capability_enums 单元测试。

覆盖:
- 字段 enum 合法性判定
- helper 识别集合
- 必填字段缺失
- 逻辑一致性(image / anthropic_messages / cache / parallel / reasoning)
- 离散字段 drift 对比
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter.capability_enums import (
    REASONING_FORMAT_ENUM,
    REASONING_PARAM_PATH_ENUM,
    WIRE_REQUEST_PROTOCOL_ENUM,
    WIRE_SYSTEM_MESSAGE_STYLE_ENUM,
    helper_recognizes,
    is_valid_enum,
)
from apps.services.llm.wire_adapter.validator import (
    ValidationIssue,
    ValidationReport,
    validate_model,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_model(
    *,
    capabilities_config=None,
    is_active=True,
    model_name="test-model",
    provider_name="openai",
    provider_key=None,
    supports_vision=False,
    supports_function_calling=True,
    supports_reasoning=False,
    wave_status="ready",
    mode="chat",
):
    """构造 mock LLMModel(SimpleNamespace + provider mock)。"""
    provider = SimpleNamespace(
        name=provider_name,
        provider_key=provider_key if provider_key is not None else provider_name,
    )
    return SimpleNamespace(
        id="aabbccdd-1111-2222-3333-aabbccddeeff",
        provider=provider,
        model_name=model_name,
        is_active=is_active,
        capabilities_config=capabilities_config or {},
        supports_vision=supports_vision,
        supports_function_calling=supports_function_calling,
        supports_reasoning=supports_reasoning,
        wave_status=wave_status,
        mode=mode,
    )


def _full_wa(**overrides):
    """构造一份完整的 wire_adapter dict(默认 OpenAI 兼容)。"""
    base = {
        "image": {"enabled": True, "input_via": ["base64", "url"]},
        "tool": {
            "enabled": True,
            "parallel_param_inverted": False,
            "parallel_param_name": "parallel_tool_calls",
        },
        "wire": {
            "system_message_style": "messages_first_role_system",
            "system_placement": "messages_first_role_system",
            "request_protocol": "openai_chat_completions",
            "upstream_path": "/chat/completions",
            "streaming_protocol": "openai_delta",
        },
        "caching": {"mode": "automatic_implicit", "cache_control_strip": False},
        "json_mode": {"modes": ["json_schema"]},
        "reasoning": {"enabled": False},
        "usage": {
            "input_field": "prompt_tokens",
            "output_field": "completion_tokens",
            "input_tokens_field": "prompt_tokens",
            "output_tokens_field": "completion_tokens",
        },
        "limits": {},
    }
    for k, v in overrides.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = {**base[k], **v}
        else:
            base[k] = v
    return base


# ---------------------------------------------------------------------------
# Enum tests
# ---------------------------------------------------------------------------

class CapabilityEnumsTests(SimpleTestCase):

    def test_valid_system_message_style(self):
        for v in WIRE_SYSTEM_MESSAGE_STYLE_ENUM:
            self.assertTrue(is_valid_enum("wire.system_message_style", v))

    def test_invalid_system_message_style(self):
        self.assertFalse(is_valid_enum("wire.system_message_style", "anthropic_top_level"))
        self.assertFalse(is_valid_enum("wire.system_message_style", "garbage"))

    def test_helper_recognizes_known_styles(self):
        self.assertTrue(helper_recognizes("wire.system_message_style", "top_level_system_field"))
        self.assertTrue(helper_recognizes("wire.system_message_style", "messages_first_role_system"))

    def test_reasoning_format_enum(self):
        for v in REASONING_FORMAT_ENUM:
            self.assertTrue(is_valid_enum("reasoning.format", v))

    def test_reasoning_param_path_enum(self):
        for v in REASONING_PARAM_PATH_ENUM:
            # None alias / 空串 都 valid
            self.assertTrue(is_valid_enum("reasoning.param_path", v))

    def test_request_protocol_enum(self):
        for v in WIRE_REQUEST_PROTOCOL_ENUM:
            self.assertTrue(is_valid_enum("wire.request_protocol", v))

    def test_non_string_value_passes(self):
        # bool / int 不参与 enum 校验
        self.assertTrue(is_valid_enum("tool.parallel_param_inverted", True))
        self.assertTrue(is_valid_enum("image.enabled", False))


# ---------------------------------------------------------------------------
# Validator tests
# ---------------------------------------------------------------------------

class ValidatorBasicTests(SimpleTestCase):

    def test_full_valid_model_passes(self):
        wa = _full_wa()
        m = _make_model(capabilities_config={"wire_adapter": wa}, supports_vision=True)
        report = validate_model(m)
        self.assertFalse(report.has_errors)

    def test_invalid_enum_value_reports_error(self):
        wa = _full_wa(wire={"system_message_style": "anthropic_top_level"})
        m = _make_model(capabilities_config={"wire_adapter": wa})
        report = validate_model(m)
        self.assertTrue(report.has_errors)
        rules = {i.rule for i in report.errors}
        self.assertIn("W1c.enum.invalid_value", rules)

    def test_missing_required_field_reports_error(self):
        wa = _full_wa()
        wa["wire"]["upstream_path"] = ""
        m = _make_model(capabilities_config={"wire_adapter": wa})
        report = validate_model(m)
        self.assertTrue(report.has_errors)
        rules = {i.rule for i in report.errors}
        self.assertIn("W1c.required.missing", rules)

    def test_unconfigured_active_model_warns(self):
        m = _make_model(capabilities_config={})
        report = validate_model(m)
        self.assertFalse(report.is_configured)
        rules = {i.rule for i in report.warnings}
        self.assertIn("W1c.config.missing_wire_adapter", rules)


class ValidatorInvariantTests(SimpleTestCase):

    def test_image_enabled_with_empty_input_via_errors(self):
        wa = _full_wa(image={"enabled": True, "input_via": []})
        m = _make_model(capabilities_config={"wire_adapter": wa}, supports_vision=True)
        report = validate_model(m)
        self.assertTrue(report.has_errors)
        rules = {i.rule for i in report.errors}
        self.assertIn("W1c.invariant.image_enabled_without_input_via", rules)

    def test_invalid_input_via_token_errors(self):
        wa = _full_wa(image={"enabled": True, "input_via": ["base64", "ftp"]})
        m = _make_model(capabilities_config={"wire_adapter": wa}, supports_vision=True)
        report = validate_model(m)
        rules = {i.rule for i in report.errors}
        self.assertIn("W1c.invariant.invalid_input_via_token", rules)

    def test_anthropic_messages_path_mismatch_errors(self):
        wa = _full_wa(wire={
            "system_message_style": "top_level_system_field",
            "system_placement": "top_level_system_field",
            "request_protocol": "anthropic_messages",
            "upstream_path": "/chat/completions",  # 错!应该是 /v1/messages
            "streaming_protocol": "anthropic_sse",
        })
        m = _make_model(capabilities_config={"wire_adapter": wa})
        report = validate_model(m)
        rules = {i.rule for i in report.errors}
        self.assertIn("W1c.invariant.anthropic_messages_path_mismatch", rules)

    def test_explicit_cache_with_strip_errors(self):
        wa = _full_wa(caching={"mode": "explicit_cache_control", "cache_control_strip": True})
        m = _make_model(capabilities_config={"wire_adapter": wa})
        report = validate_model(m)
        rules = {i.rule for i in report.errors}
        self.assertIn("W1c.invariant.explicit_cache_with_strip", rules)

    def test_parallel_inverted_name_mismatch_errors(self):
        wa = _full_wa(tool={
            "enabled": True,
            "parallel_param_inverted": True,
            "parallel_param_name": "parallel_tool_calls",  # 错!反向应改名
        })
        m = _make_model(capabilities_config={"wire_adapter": wa})
        report = validate_model(m)
        rules = {i.rule for i in report.errors}
        self.assertIn("W1c.invariant.parallel_inverted_name_mismatch", rules)

    def test_reasoning_kimi_k2_thinking_path_is_allowed(self):
        """#8822: Moonshot K2 = reasoning_content_field + thinking 是合法组合。"""
        wa = _full_wa(reasoning={
            "enabled": True,
            "format": "reasoning_content_field",
            "param_path": "thinking",
        })
        m = _make_model(
            capabilities_config={"wire_adapter": wa},
            provider_name="moonshot",
            model_name="kimi-k2.6",
            supports_reasoning=True,
        )
        report = validate_model(m)
        mismatch = [
            i for i in report.warnings
            if i.rule == "W1c.invariant.reasoning_format_param_mismatch"
            and i.field == "reasoning.param_path"
        ]
        self.assertEqual(mismatch, [], "Kimi K2 不应再被 Invariant 5 误报")
        # 允许无关 warning（如测试夹具 image.enabled vs supports_vision drift）
        self.assertTrue(report.passed(strict=False))
        self.assertFalse(
            any(i.rule == "W1c.invariant.reasoning_format_param_mismatch" for i in report.errors),
        )

    def test_reasoning_content_field_plus_thinking_warns_for_unknown_provider(self):
        """未知厂商仍报警——format 不再单独定罪,但未登记白名单要可见。"""
        wa = _full_wa(reasoning={
            "enabled": True,
            "format": "reasoning_content_field",
            "param_path": "thinking",
        })
        m = _make_model(
            capabilities_config={"wire_adapter": wa},
            provider_name="some-unknown-vendor",
            model_name="mystery-reasoner",
            supports_reasoning=True,
        )
        report = validate_model(m)
        rules = {i.rule for i in report.warnings}
        self.assertIn("W1c.invariant.reasoning_format_param_mismatch", rules)


class ValidatorDiscreteDriftTests(SimpleTestCase):

    def test_image_enabled_vs_supports_vision_drift(self):
        wa = _full_wa(image={"enabled": False, "input_via": []})
        # supports_vision=True 但 image.enabled=False → drift
        m = _make_model(capabilities_config={"wire_adapter": wa}, supports_vision=True)
        report = validate_model(m)
        rules = {i.rule for i in report.warnings}
        self.assertIn("W1c.drift.discrete_vs_wire_adapter", rules)


class ValidationReportTests(SimpleTestCase):

    def test_passed_strict_excludes_warnings(self):
        # 用「未知厂商 + thinking」制造一条仍会触发的 warning（ 后 Moonshot 不再报警）
        wa = _full_wa(reasoning={
            "enabled": True,
            "format": "reasoning_content_field",
            "param_path": "thinking",
        })
        m = _make_model(
            capabilities_config={"wire_adapter": wa},
            provider_name="unknown-vendor",
            model_name="mystery",
            supports_reasoning=True,
        )
        report = validate_model(m)
        self.assertTrue(report.passed(strict=False))
        self.assertFalse(report.passed(strict=True))

    def test_to_json_serializable(self):
        wa = _full_wa()
        m = _make_model(capabilities_config={"wire_adapter": wa})
        report = validate_model(m)
        d = report.to_json()
        self.assertIn("model_id", d)
        self.assertIn("errors", d)
        self.assertIn("warnings", d)

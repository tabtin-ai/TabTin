"""Test wire_adapter.resolved_capabilities — ResolvedCapabilities 数据模型(W1a).

覆盖:
- ResolvedCapabilities 默认值(全保守 + is_configured=False)
- 8 nested dataclass(ImageCaps / ToolCaps / WireFormatCaps / CachingCaps /
  JsonModeCaps / ReasoningCaps / UsageCaps / LimitsCaps)默认值
- to_json / from_json round-trip(tuple ↔ list 互转)
- SystemQuirk Enum 三值
- from_json 容错:None / 非 dict / 未知字段 warn
"""

from __future__ import annotations

import logging

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter.resolved_capabilities import (
    CachingCaps,
    ImageCaps,
    JsonModeCaps,
    LimitsCaps,
    ReasoningCaps,
    ResolvedCapabilities,
    SystemQuirk,
    ToolCaps,
    UsageCaps,
    WireFormatCaps,
)


# ---------------------------------------------------------------------------
# SystemQuirk Enum
# ---------------------------------------------------------------------------

class SystemQuirkEnumTests(SimpleTestCase):
    def test_three_values_exist(self):
        """W1a:三个 quirk 值齐全"""
        self.assertEqual(SystemQuirk.QWQ_STRIP_TO_USER.value, "qwq_strip_to_user")
        self.assertEqual(SystemQuirk.QVQ_DROP.value, "qvq_drop")
        self.assertEqual(
            SystemQuirk.MINIMAX_EXTRA_ROLES_PASSTHROUGH.value,
            "minimax_extra_roles_passthrough",
        )

    def test_is_str_enum(self):
        """SystemQuirk 继承 str → JSON 序列化天然是 string"""
        self.assertIsInstance(SystemQuirk.QWQ_STRIP_TO_USER.value, str)


# ---------------------------------------------------------------------------
# 8 nested dataclass 默认值
# ---------------------------------------------------------------------------

class NestedDataclassDefaultsTests(SimpleTestCase):
    def test_image_caps_defaults_conservative(self):
        """ImageCaps 默认 enabled=False(保守)"""
        caps = ImageCaps()
        self.assertFalse(caps.enabled)
        self.assertEqual(caps.input_via, ())
        self.assertEqual(caps.formats, ())
        self.assertIsNone(caps.max_count_per_request)
        self.assertEqual(caps.request_shape, "openai_image_url")

    def test_tool_caps_defaults_conservative(self):
        """ToolCaps 默认 enabled=False"""
        caps = ToolCaps()
        self.assertFalse(caps.enabled)
        self.assertEqual(caps.choice_modes, ())
        self.assertFalse(caps.parallel_default)
        self.assertEqual(caps.parallel_param_name, "parallel_tool_calls")
        self.assertFalse(caps.parallel_param_inverted)

    def test_wire_format_caps_defaults_openai_compat(self):
        """WireFormatCaps 默认走 OpenAI 兼容"""
        caps = WireFormatCaps()
        self.assertEqual(caps.request_protocol, "openai_chat_completions")
        self.assertEqual(caps.response_protocol, "openai_chat_completions")
        self.assertEqual(caps.system_placement, "messages_first_role_system")
        self.assertEqual(caps.system_quirks, ())
        self.assertTrue(caps.stream_supported)

    def test_caching_caps_defaults_none(self):
        """CachingCaps 默认 mode=none(不支持)"""
        caps = CachingCaps()
        self.assertEqual(caps.mode, "none")
        self.assertIsNone(caps.min_tokens_for_cache)
        self.assertIsNone(caps.cache_ttl_param)

    def test_json_mode_caps_defaults_none(self):
        caps = JsonModeCaps()
        self.assertEqual(caps.mode, "none")
        self.assertFalse(caps.strict_supported)

    def test_reasoning_caps_defaults_disabled(self):
        caps = ReasoningCaps()
        self.assertFalse(caps.enabled)
        self.assertEqual(caps.surface, "hidden")
        self.assertIsNone(caps.budget_param)

    def test_usage_caps_defaults_openai_field_names(self):
        caps = UsageCaps()
        self.assertEqual(caps.input_tokens_field, "prompt_tokens")
        self.assertEqual(caps.output_tokens_field, "completion_tokens")
        self.assertIsNone(caps.cache_read_field)

    def test_limits_caps_defaults_all_none(self):
        caps = LimitsCaps()
        self.assertIsNone(caps.context_window_tokens)
        self.assertIsNone(caps.max_output_tokens)
        self.assertIsNone(caps.max_documents_per_request)
        self.assertIsNone(caps.max_tool_recursion_depth)


# ---------------------------------------------------------------------------
# ResolvedCapabilities 顶层
# ---------------------------------------------------------------------------

class ResolvedCapabilitiesDefaultsTests(SimpleTestCase):
    def test_all_nested_default(self):
        """ResolvedCapabilities() 全部 nested 走默认值"""
        caps = ResolvedCapabilities()
        self.assertIsInstance(caps.image, ImageCaps)
        self.assertIsInstance(caps.tool, ToolCaps)
        self.assertIsInstance(caps.wire, WireFormatCaps)
        self.assertIsInstance(caps.caching, CachingCaps)
        self.assertIsInstance(caps.json_mode, JsonModeCaps)
        self.assertIsInstance(caps.reasoning, ReasoningCaps)
        self.assertIsInstance(caps.usage, UsageCaps)
        self.assertIsInstance(caps.limits, LimitsCaps)
        self.assertEqual(caps.wave_status, "ready")
        self.assertFalse(caps.is_configured)

    def test_not_frozen_can_mutate(self):
        """W1a 关键约束:ResolvedCapabilities 非 frozen,可逐字段 mutate"""
        caps = ResolvedCapabilities()
        # 应该不抛 FrozenInstanceError
        caps.image.enabled = True
        caps.image.input_via = ("base64",)
        caps.is_configured = True
        self.assertTrue(caps.image.enabled)
        self.assertEqual(caps.image.input_via, ("base64",))
        self.assertTrue(caps.is_configured)


# ---------------------------------------------------------------------------
# to_json / from_json round-trip
# ---------------------------------------------------------------------------

class JsonSerializationTests(SimpleTestCase):
    def test_default_round_trip(self):
        """默认值 → to_json → from_json 后仍等价"""
        original = ResolvedCapabilities()
        json_data = original.to_json()
        self.assertIsInstance(json_data, dict)
        # tuple 字段在 JSON 里应该是 list
        self.assertIsInstance(json_data["image"]["input_via"], list)

        restored = ResolvedCapabilities.from_json(json_data)
        self.assertEqual(restored.image.enabled, original.image.enabled)
        self.assertEqual(restored.image.input_via, original.image.input_via)
        self.assertEqual(restored.wave_status, original.wave_status)

    def test_populated_round_trip_preserves_tuple(self):
        """填充值 round-trip,tuple 字段保持 tuple 类型"""
        caps = ResolvedCapabilities(is_configured=True, wave_status="w2_pending")
        caps.image = ImageCaps(
            enabled=True,
            input_via=("base64", "url"),
            formats=("jpeg", "png"),
            max_count_per_request=10,
            max_size_bytes=1024 * 1024,
            request_shape="anthropic_image_source",
        )
        caps.tool = ToolCaps(
            enabled=True,
            choice_modes=("auto", "required"),
            parallel_default=True,
            parallel_param_name="disable_parallel_tool_use",
            parallel_param_inverted=True,
        )
        caps.wire = WireFormatCaps(
            request_protocol="anthropic_messages",
            system_quirks=("minimax_extra_roles_passthrough",),
        )

        json_data = caps.to_json()
        # tuple 序列化为 list
        self.assertEqual(json_data["image"]["input_via"], ["base64", "url"])
        self.assertEqual(json_data["wire"]["system_quirks"], ["minimax_extra_roles_passthrough"])

        restored = ResolvedCapabilities.from_json(json_data)
        # tuple 字段反序列化回 tuple
        self.assertEqual(restored.image.input_via, ("base64", "url"))
        self.assertEqual(restored.image.formats, ("jpeg", "png"))
        self.assertEqual(restored.tool.choice_modes, ("auto", "required"))
        self.assertEqual(restored.wire.system_quirks, ("minimax_extra_roles_passthrough",))
        # 其他字段
        self.assertTrue(restored.is_configured)
        self.assertEqual(restored.wave_status, "w2_pending")
        self.assertEqual(restored.tool.parallel_param_name, "disable_parallel_tool_use")
        self.assertTrue(restored.tool.parallel_param_inverted)

    def test_from_json_none(self):
        """from_json(None) 返回默认值,is_configured=False"""
        caps = ResolvedCapabilities.from_json(None)
        self.assertFalse(caps.is_configured)
        self.assertEqual(caps.wave_status, "ready")

    def test_from_json_empty_dict(self):
        """from_json({}) 返回默认值"""
        caps = ResolvedCapabilities.from_json({})
        self.assertFalse(caps.is_configured)

    def test_from_json_non_dict_returns_default(self):
        """from_json 收到非 dict 类型回退默认值,记 warning"""
        with self.assertLogs(
            "apps.services.llm.wire_adapter.resolved_capabilities",
            level=logging.WARNING,
        ) as log:
            caps = ResolvedCapabilities.from_json("not a dict")  # type: ignore[arg-type]
        self.assertFalse(caps.is_configured)
        self.assertTrue(any("非 dict" in m for m in log.output))

    def test_from_json_unknown_field_warns_but_does_not_break(self):
        """from_json 遇到未知 field warn 后忽略,正常返回"""
        data = ResolvedCapabilities().to_json()
        data["future_field_not_yet_defined"] = {"xyz": 1}

        with self.assertLogs(
            "apps.services.llm.wire_adapter.resolved_capabilities",
            level=logging.WARNING,
        ) as log:
            caps = ResolvedCapabilities.from_json(data)
        self.assertIsInstance(caps, ResolvedCapabilities)
        self.assertTrue(any("未知字段" in m for m in log.output))

    def test_from_json_partial_fields(self):
        """部分字段缺失 → 缺的走默认值,有的正确装载"""
        partial = {
            "image": {"enabled": True, "input_via": ["base64"]},
            "is_configured": True,
        }
        caps = ResolvedCapabilities.from_json(partial)
        self.assertTrue(caps.image.enabled)
        self.assertEqual(caps.image.input_via, ("base64",))
        # 缺失字段走默认
        self.assertFalse(caps.tool.enabled)
        self.assertEqual(caps.wave_status, "ready")
        self.assertTrue(caps.is_configured)

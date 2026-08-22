"""W1a-fix-2 测试套:5 个 Block 修补的端到端覆盖。

- Block 1:0017 migration 字段对同步函数(_sync_field_pairs / _sync_scalar_pair /
  _sync_extra_fields_superset)
- Block 2:resolve_for_wire 第 1 级 wire_adapter JSON 命中后用 service caps
  deep-merge 补缺失字段
- Block 3:9 条细化映射规则按 provider 细分(claude → explicit_cache_control /
  qwen → json_modes 不含 schema / minimax → json_modes 空)
- Block 4:_is_chat_capable 判定 + sanity log 不对 image/audio/video model 触发
- Block 5:ZenMux qwen 子型路由(_resolve_zenmux_profile_v2 含 qwen/* prefix)
"""

from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.llm.utils.capabilities import (
    _build_from_service_capabilities,
    _deep_merge_resolved,
    _is_chat_capable,
    _is_default_value,
    _provider_name,
    resolve_for_wire,
)
from apps.services.llm.wire_adapter.resolved_capabilities import (
    ResolvedCapabilities,
)


def _load_0017_module():
    django_root = Path(__file__).resolve().parents[5]
    migration_path = (
        django_root / "apps" / "services" / "llm" / "migrations"
        / "0017_llm_wire_adapter_field_sync.py"
    )
    spec = importlib.util.spec_from_file_location("llm_0017", str(migration_path))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_mock_model(**kwargs):
    """构造一个 mock LLMModel-like 对象。"""
    defaults = {
        "id": "mock-id",
        "model_name": "mock-model",
        "is_active": True,
        "wire_adapter_disabled": False,
        "wave_status": "ready",
        "mode": "chat",
        "capabilities_config": {},
        "multimodal_limits": {},
        "supports_streaming": None,
        "supports_function_calling": None,
        "supports_vision": None,
        "max_tokens": 128000,
        "max_input_tokens": None,
        "max_output_tokens": 4096,
        "max_image_size": 20 * 1024 * 1024,
        "max_images_per_request": 10,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


# ---------------------------------------------------------------------------
# Block 1:0017 migration 字段对同步函数
# ---------------------------------------------------------------------------

class Block1FieldPairSyncTests(SimpleTestCase):
    """0017 _sync_scalar_pair / _sync_field_pairs / _sync_extra_fields_superset。"""

    def test_sync_scalar_pair_new_value_wins_when_both_filled(self):
        """新旧都填值且不同 → 旧字段对齐到新值"""
        m = _load_0017_module()
        nested = {"old_key": "old_v", "new_key": "new_v"}
        changed = m._sync_scalar_pair(nested, "old_key", "new_key")
        self.assertTrue(changed)
        self.assertEqual(nested["old_key"], "new_v")
        self.assertEqual(nested["new_key"], "new_v")

    def test_sync_scalar_pair_old_filled_new_missing(self):
        """仅旧有值 → 新字段从旧字段补"""
        m = _load_0017_module()
        nested = {"old_key": "old_v"}
        changed = m._sync_scalar_pair(nested, "old_key", "new_key")
        self.assertTrue(changed)
        self.assertEqual(nested["new_key"], "old_v")
        self.assertEqual(nested["old_key"], "old_v")

    def test_sync_scalar_pair_new_filled_old_missing(self):
        """仅新有值 → 旧字段从新字段补"""
        m = _load_0017_module()
        nested = {"new_key": "new_v"}
        changed = m._sync_scalar_pair(nested, "old_key", "new_key")
        self.assertTrue(changed)
        self.assertEqual(nested["old_key"], "new_v")
        self.assertEqual(nested["new_key"], "new_v")

    def test_sync_scalar_pair_both_empty_no_change(self):
        """两边都空 → 不动"""
        m = _load_0017_module()
        nested = {"old_key": None, "new_key": None}
        changed = m._sync_scalar_pair(nested, "old_key", "new_key")
        self.assertFalse(changed)

    def test_sync_scalar_pair_both_equal_no_change(self):
        """两边相等 → 不动(idempotent)"""
        m = _load_0017_module()
        nested = {"old_key": "v", "new_key": "v"}
        changed = m._sync_scalar_pair(nested, "old_key", "new_key")
        self.assertFalse(changed)

    def test_extra_fields_superset_adds_missing_metrics(self):
        """extra_metrics 含 extra_fields 缺失值 → extra_fields 加上"""
        m = _load_0017_module()
        usage = {
            "extra_fields": ["a", "b"],
            "extra_metrics": ["b", "c"],
        }
        changed = m._sync_extra_fields_superset(usage)
        self.assertTrue(changed)
        # extra_fields 已是 superset
        self.assertIn("a", usage["extra_fields"])
        self.assertIn("b", usage["extra_fields"])
        self.assertIn("c", usage["extra_fields"])
        # extra_metrics 不动
        self.assertEqual(usage["extra_metrics"], ["b", "c"])

    def test_extra_fields_already_superset_no_change(self):
        """extra_fields 已 superset → 不动(idempotent)"""
        m = _load_0017_module()
        usage = {
            "extra_fields": ["a", "b", "c"],
            "extra_metrics": ["a", "b"],
        }
        changed = m._sync_extra_fields_superset(usage)
        self.assertFalse(changed)

    def test_sync_field_pairs_minimax_real_data(self):
        """模拟 MiniMax 真实 0015+0016 后的数据,跑 _sync_field_pairs 后字段对一致。

        Fixture 用的字符串值仅用于"两边不一致 → 同步后一致"语义验证,**不**反映
        当前 DB 真值。当前 DB 真值由 0018 migration 同步为权威值
        ``"top_level_system_field"`` (W1b-fix Block C1 修复),见
        ``0018_llm_wire_adapter_system_style_canonicalize.py``。
        """
        m = _load_0017_module()
        wa = {
            "wire": {
                "system_placement": "minimax_user_system_role",  # 0015 旧值
                "system_message_style": "anthropic_top_level",   # 0016 新值(W1b-fix 0018 已规范化)
            },
            "usage": {
                "input_tokens_field": "input_tokens",  # 0015
                "input_field": "input_tokens",         # 0016 (same)
                "extra_metrics": ["total_characters"],  # 0015
                "extra_fields": ["total_characters", "input_sensitive",
                                 "output_sensitive_type"],  # 0016
            },
            "limits": {
                "context_window_tokens": None,  # 0015
                "context_window": 245760,        # 0016
            },
            "caching": {
                "min_tokens_for_cache": None,
                "min_tokens": None,
            },
        }
        changes = m._sync_field_pairs(wa)
        # 同步后 system_placement 取新值 anthropic_top_level
        self.assertEqual(wa["wire"]["system_placement"], "anthropic_top_level")
        # context_window_tokens 从 context_window 补
        self.assertEqual(wa["limits"]["context_window_tokens"], 245760)
        # extra_fields 仍 superset of extra_metrics
        for v in wa["usage"]["extra_metrics"]:
            self.assertIn(v, wa["usage"]["extra_fields"])
        # 至少 2 处改动(system_placement / context_window_tokens)
        self.assertGreaterEqual(len(changes), 2)


# ---------------------------------------------------------------------------
# Block 2:resolve_for_wire 第 1 级命中后 deep-merge 补齐
# ---------------------------------------------------------------------------

class Block2DeepMergeFallbackTests(SimpleTestCase):
    """第 1 级 wire_adapter JSON 命中后,缺失 nested / 字段从 service caps 补齐。"""

    def test_partial_wire_adapter_json_gets_service_caps_fallback(self):
        """admin 只配了部分 wire_adapter(只填 image 块),其他 nested 走 service
        caps fallback,而不是 dataclass 默认值。

        关键:mock model 离散布尔字段保持 None,让 get_capability_flag 跳过第 1
        级 DB 字段直接走 service_caps(否则离散 False 会先于 service_caps 命中)。
        """
        partial = {
            "image": {
                "enabled": True,
                "input_via": ["base64"],
                "formats": ["png"],
                "request_shape": "openai_image_url",
            },
            "is_configured": True,
        }
        model = _make_mock_model(
            capabilities_config={"wire_adapter": partial},
            # 离散字段保持 None,让 service_caps 兜底
            supports_function_calling=None,
            supports_vision=None,
            supports_streaming=None,
        )
        provider = SimpleNamespace(name="openai")

        with patch(
            "apps.services.llm.registry.AIServiceProviderRegistry.get_service_class"
        ) as mock_get:
            mock_get.return_value = SimpleNamespace(CAPABILITIES={
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_tool_choice": True,
                "supports_json_mode": True,
                "supports_reasoning": False,
                "supports_prompt_caching": True,
            })
            caps = resolve_for_wire(model, provider)

        # 第 1 级 image 字段保留
        self.assertTrue(caps.image.enabled)
        self.assertEqual(caps.image.input_via, ("base64",))
        # 但 tool 块从 service caps 补齐(原 ResolvedCapabilities 默认 disabled)
        self.assertTrue(caps.tool.enabled)
        self.assertIn("auto", caps.tool.choice_modes)
        self.assertIn("specific", caps.tool.choice_modes)
        # caching 也补齐(supports_prompt_caching=True + provider=openai)
        self.assertEqual(caps.caching.mode, "automatic_implicit")
        # is_configured 仍 True(第 1 级)
        self.assertTrue(caps.is_configured)

    def test_full_wire_adapter_json_no_fallback_override(self):
        """已经全配了的 wire_adapter,deep-merge 不破坏已有字段。"""
        full_data = {
            "image": {"enabled": True, "input_via": ["base64", "url"]},
            "tool": {
                "enabled": True,
                "choice_modes": ["auto"],
                "parallel_default": True,
                "parallel_param_name": "custom_param",
                "parallel_param_inverted": False,
                "param_field": "input_schema",
            },
            "is_configured": True,
        }
        model = _make_mock_model(
            capabilities_config={"wire_adapter": full_data},
        )
        provider = SimpleNamespace(name="openai")

        with patch(
            "apps.services.llm.registry.AIServiceProviderRegistry.get_service_class"
        ) as mock_get:
            mock_get.return_value = SimpleNamespace(CAPABILITIES={
                "supports_function_calling": True,
                "supports_tool_choice": True,
            })
            caps = resolve_for_wire(model, provider)

        # admin 配的 choice_modes=("auto",) 不被 service caps 的 ("auto","required",
        # "none","specific") 覆盖
        self.assertEqual(caps.tool.choice_modes, ("auto",))
        # admin 配的 param_field=input_schema 不被 service caps 的 parameters 覆盖
        self.assertEqual(caps.tool.param_field, "input_schema")
        # admin 配的 parallel_param_name 也保留
        self.assertEqual(caps.tool.parallel_param_name, "custom_param")


class Block2DeepMergeResolvedTests(SimpleTestCase):
    """_deep_merge_resolved 核心工具单测。"""

    def test_base_default_field_replaced_by_overlay(self):
        """base 是默认值的字段被 overlay 替换"""
        base = ResolvedCapabilities()  # 全默认
        overlay = ResolvedCapabilities()
        from apps.services.llm.wire_adapter.resolved_capabilities import ToolCaps
        overlay.tool = ToolCaps(enabled=True, choice_modes=("auto",))

        _deep_merge_resolved(base, overlay)
        self.assertTrue(base.tool.enabled)
        self.assertEqual(base.tool.choice_modes, ("auto",))

    def test_base_filled_field_keeps_priority(self):
        """base 已显式填值的字段不被 overlay 覆盖"""
        from apps.services.llm.wire_adapter.resolved_capabilities import ToolCaps
        base = ResolvedCapabilities()
        base.tool = ToolCaps(enabled=True, choice_modes=("auto",))

        overlay = ResolvedCapabilities()
        overlay.tool = ToolCaps(enabled=True, choice_modes=("auto", "required", "none"))

        _deep_merge_resolved(base, overlay)
        # base 的 ("auto",) win
        self.assertEqual(base.tool.choice_modes, ("auto",))


class IsDefaultValueTests(SimpleTestCase):
    """_is_default_value 启发式判定。"""

    def test_default_factory_match(self):
        """default_factory() 的值视为默认"""
        from dataclasses import fields as dc_fields
        from apps.services.llm.wire_adapter.resolved_capabilities import ToolCaps
        for f in dc_fields(ToolCaps):
            if f.name == "choice_modes":
                # default_factory=tuple → ()
                self.assertTrue(_is_default_value(f, ()))
                self.assertFalse(_is_default_value(f, ("auto",)))


# ---------------------------------------------------------------------------
# Block 3:9 条映射规则按 provider 细分
# ---------------------------------------------------------------------------

class Block3ProviderSpecificMappingTests(SimpleTestCase):
    """resolve_for_wire 走第 2 级时各 provider 的细化能力。"""

    def _resolve_with(self, provider_name, service_caps):
        """构造 mock model + provider,跑第 2 级"""
        model = _make_mock_model(capabilities_config={})
        provider = SimpleNamespace(name=provider_name)
        with patch(
            "apps.services.llm.registry.AIServiceProviderRegistry.get_service_class"
        ) as mock_get:
            mock_get.return_value = SimpleNamespace(CAPABILITIES=service_caps)
            return _build_from_service_capabilities(model, provider)

    def test_claude_caching_mode_explicit_cache_control(self):
        """Claude provider + supports_prompt_caching=True → explicit_cache_control"""
        caps = self._resolve_with("claude", {"supports_prompt_caching": True})
        self.assertEqual(caps.caching.mode, "explicit_cache_control")
        self.assertEqual(caps.caching.cache_ttl_param, "cache_control.ttl")

    def test_gemini_caching_mode_context_cache(self):
        """Gemini provider + supports_prompt_caching=True → context_cache"""
        caps = self._resolve_with("gemini", {"supports_prompt_caching": True})
        self.assertEqual(caps.caching.mode, "context_cache")

    def test_moonshot_caching_mode_with_prompt_cache_key(self):
        """Moonshot provider + supports_prompt_caching=True → automatic_implicit
        + cache_ttl_param=prompt_cache_key"""
        caps = self._resolve_with("moonshot", {"supports_prompt_caching": True})
        self.assertEqual(caps.caching.mode, "automatic_implicit")
        self.assertEqual(caps.caching.cache_ttl_param, "prompt_cache_key")

    def test_qwen_json_modes_no_schema(self):
        """Qwen + supports_json_mode=True → modes=('text','json_object') 不含 schema,
        schema_fallback=True"""
        caps = self._resolve_with("qwen", {"supports_json_mode": True})
        self.assertNotIn("json_schema", caps.json_mode.modes)
        self.assertIn("text", caps.json_mode.modes)
        self.assertIn("json_object", caps.json_mode.modes)
        self.assertTrue(caps.json_mode.schema_fallback)
        self.assertIsNone(caps.json_mode.schema_field)

    def test_minimax_json_modes_empty(self):
        """MiniMax + supports_json_mode=True → modes=() 兼容端无 json_schema"""
        caps = self._resolve_with("minimax", {"supports_json_mode": True})
        self.assertEqual(caps.json_mode.modes, ())
        # 主 mode 是 'none'
        self.assertEqual(caps.json_mode.mode, "none")

    def test_openai_json_strict_supported(self):
        """OpenAI + supports_json_mode=True → strict_supported=True"""
        caps = self._resolve_with("openai", {"supports_json_mode": True})
        self.assertTrue(caps.json_mode.strict_supported)
        self.assertIn("json_schema", caps.json_mode.modes)

    def test_claude_tool_param_field_input_schema(self):
        """Claude provider + supports_function_calling=True →
        tool.param_field='input_schema',parallel_param_inverted=True"""
        caps = self._resolve_with("claude", {
            "supports_function_calling": True,
        })
        self.assertEqual(caps.tool.param_field, "input_schema")
        self.assertTrue(caps.tool.parallel_param_inverted)
        self.assertEqual(caps.tool.parallel_param_name, "disable_parallel_tool_use")

    def test_qwen_reasoning_format_reasoning_content_field(self):
        """Qwen + supports_reasoning=True → reasoning.format='reasoning_content_field'"""
        caps = self._resolve_with("qwen", {"supports_reasoning": True})
        self.assertEqual(caps.reasoning.format, "reasoning_content_field")
        self.assertEqual(caps.reasoning.surface, "delta_reasoning_content")

    def test_minimax_wire_protocol_anthropic(self):
        """MiniMax wire.request_protocol='anthropic_messages' +
        system_placement='minimax_user_system_role'"""
        caps = self._resolve_with("minimax", {})
        self.assertEqual(caps.wire.request_protocol, "anthropic_messages")
        self.assertEqual(caps.wire.system_placement, "minimax_user_system_role")

    def test_function_calling_unconditional_three_modes(self):
        """W1a-fix-2 修订:supports_function_calling=True 无条件给 3 模式
        (auto/required/none),不再因 supports_tool_choice 限制只 ('auto',)"""
        caps_no_tool_choice = self._resolve_with("openai", {
            "supports_function_calling": True,
            "supports_tool_choice": False,
        })
        for mode in ("auto", "required", "none"):
            self.assertIn(mode, caps_no_tool_choice.tool.choice_modes,
                          f"missing {mode}")
        self.assertNotIn("specific", caps_no_tool_choice.tool.choice_modes)

        caps_with_tool_choice = self._resolve_with("openai", {
            "supports_function_calling": True,
            "supports_tool_choice": True,
        })
        for mode in ("auto", "required", "none", "specific"):
            self.assertIn(mode, caps_with_tool_choice.tool.choice_modes,
                          f"missing {mode}")


# ---------------------------------------------------------------------------
# Block 4:_is_chat_capable 判定 + sanity log 不污染
# ---------------------------------------------------------------------------

class Block4ChatCapableSanityLogTests(SimpleTestCase):
    """_is_chat_capable + sanity log 行为。"""

    def test_chat_mode_is_chat_capable(self):
        m = _make_mock_model(mode="chat")
        self.assertTrue(_is_chat_capable(m))

    def test_completion_mode_is_chat_capable(self):
        m = _make_mock_model(mode="completion")
        self.assertTrue(_is_chat_capable(m))

    def test_image_generation_not_chat_capable(self):
        m = _make_mock_model(mode="image_generation")
        self.assertFalse(_is_chat_capable(m))

    def test_video_generation_not_chat_capable(self):
        m = _make_mock_model(mode="video_generation")
        self.assertFalse(_is_chat_capable(m))

    def test_audio_speech_not_chat_capable(self):
        m = _make_mock_model(mode="audio_speech")
        self.assertFalse(_is_chat_capable(m))

    def test_audio_transcription_not_chat_capable(self):
        m = _make_mock_model(mode="audio_transcription")
        self.assertFalse(_is_chat_capable(m))

    def test_empty_mode_with_streaming_signal_is_chat_capable(self):
        """mode 为空但 supports_streaming=True 兜底视为 chat-capable"""
        m = _make_mock_model(mode=None, supports_streaming=True)
        self.assertTrue(_is_chat_capable(m))

    def test_empty_mode_no_signals_not_chat_capable(self):
        """mode 为空且无 streaming/fc 信号 → 不视为 chat-capable"""
        m = _make_mock_model(
            mode=None,
            supports_streaming=False,
            supports_function_calling=False,
        )
        self.assertFalse(_is_chat_capable(m))

    def test_image_model_unconfigured_no_error_log(self):
        """active 但 mode=image_generation 的 model,即使 wire_adapter 缺配,也不
        触发 logger.error"""
        m = _make_mock_model(
            is_active=True,
            mode="image_generation",
            capabilities_config={},
            model_name="some-image-model",
        )
        with self.assertLogs(
            "apps.services.llm.utils.capabilities",
            level=logging.DEBUG,
        ) as log:
            resolve_for_wire(m, provider=None)
        # 应该有 debug log 但没有 error log
        error_logs = [r for r in log.records if r.levelno >= logging.ERROR]
        self.assertEqual(len(error_logs), 0,
                         f"image model 不应触发 error log: {[r.getMessage() for r in error_logs]}")
        # debug 有(说明分支命中)
        debug_logs = [r for r in log.records
                      if r.levelno == logging.DEBUG and "non" not in r.getMessage().lower()]
        # 至少一条 debug 提及 image-model
        relevant = [r for r in log.records
                    if "some-image-model" in r.getMessage()]
        self.assertGreater(len(relevant), 0)

    def test_chat_model_unconfigured_triggers_error_log(self):
        """active + mode=chat + 缺 wire_adapter → logger.error 提示"""
        m = _make_mock_model(
            is_active=True,
            mode="chat",
            capabilities_config={},
            model_name="some-chat-model",
        )
        with self.assertLogs(
            "apps.services.llm.utils.capabilities",
            level=logging.ERROR,
        ) as log:
            resolve_for_wire(m, provider=None)
        self.assertTrue(any("some-chat-model" in m and "未配置" in m for m in log.output))


# ---------------------------------------------------------------------------
# Block 5:ZenMux qwen 子型路由
# ---------------------------------------------------------------------------

class Block5ZenMuxQwenRoutingTests(SimpleTestCase):
    """0017 _resolve_zenmux_profile_v2 含 qwen 前缀路由。"""

    def test_qwen_prefix_routes_to_qwen_full(self):
        m = _load_0017_module()
        for name in [
            "qwen/qwen3.5-plus",
            "qwen/qwen-vl-max",
            "qwen/qwen-turbo",
        ]:
            profile = m._resolve_zenmux_profile_v2(name)
            self.assertIs(profile, m.ZENMUX_QWEN_FULL,
                          f"{name} 未映射到 ZENMUX_QWEN_FULL")

    def test_anthropic_claude_still_routes_to_claude(self):
        """0017 不破坏 0016 的 Claude 路由"""
        m = _load_0017_module()
        profile = m._resolve_zenmux_profile_v2("anthropic/claude-opus-4.6")
        self.assertIsNotNone(profile)
        # 通过特征字段识别(thinking_block / cache_control_strip=True)
        self.assertEqual(profile["reasoning"]["format"], "thinking_block")

    def test_gemini_still_routes_to_gemini(self):
        m = _load_0017_module()
        profile = m._resolve_zenmux_profile_v2("google/gemini-3.1-pro-preview")
        self.assertIsNotNone(profile)
        self.assertEqual(profile["reasoning"]["format"], "thinking_config")

    def test_openai_gpt_still_routes_to_openai(self):
        m = _load_0017_module()
        profile = m._resolve_zenmux_profile_v2("openai/gpt-5.3-chat")
        self.assertIsNotNone(profile)
        self.assertEqual(profile["reasoning"]["format"], "hidden")

    def test_unknown_returns_none(self):
        m = _load_0017_module()
        self.assertIsNone(m._resolve_zenmux_profile_v2("mistral/mixtral-8x7b"))
        self.assertIsNone(m._resolve_zenmux_profile_v2(""))
        self.assertIsNone(m._resolve_zenmux_profile_v2(None))

    def test_zenmux_qwen_full_has_qwen_traits(self):
        """ZENMUX_QWEN_FULL 关键不变量:json_object 不含 schema /
        parallel_default=False(DashScope OFF)"""
        m = _load_0017_module()
        p = m.ZENMUX_QWEN_FULL
        # Qwen 关键差异
        self.assertEqual(p["json_mode"]["mode"], "json_object")
        self.assertEqual(p["json_mode"]["modes"], ["json_object"])
        self.assertNotIn("json_schema", p["json_mode"]["modes"])
        self.assertTrue(p["json_mode"]["schema_fallback"])
        self.assertFalse(p["tool"]["parallel_default"])
        self.assertEqual(p["reasoning"]["format"], "reasoning_content_field")
        # ZenMux 出口仍是 OpenAI 兼容
        self.assertEqual(p["wire"]["request_protocol"], "openai_chat_completions")
        self.assertEqual(p["wire"]["upstream_path"], "/chat/completions")
        self.assertEqual(p["wire"]["streaming_protocol"], "openai_delta")

    def test_zenmux_qwen_full_round_trips_through_resolved_capabilities(self):
        """ZENMUX_QWEN_FULL 可被 ResolvedCapabilities.from_json 读回"""
        m = _load_0017_module()
        caps = ResolvedCapabilities.from_json(m.ZENMUX_QWEN_FULL)
        self.assertTrue(caps.is_configured)
        self.assertEqual(caps.json_mode.mode, "json_object")
        self.assertFalse(caps.tool.parallel_default)
        self.assertEqual(caps.reasoning.format, "reasoning_content_field")


# ---------------------------------------------------------------------------
# Provider name helper
# ---------------------------------------------------------------------------

class ProviderNameHelperTests(SimpleTestCase):
    def test_provider_name_from_instance(self):
        p = SimpleNamespace(name="OpenAI")
        self.assertEqual(_provider_name(p), "openai")

    def test_provider_name_from_string(self):
        self.assertEqual(_provider_name("Claude"), "claude")

    def test_provider_name_none_returns_empty(self):
        self.assertEqual(_provider_name(None), "")

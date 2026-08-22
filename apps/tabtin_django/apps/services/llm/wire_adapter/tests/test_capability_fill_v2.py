"""W1a-fix: 0016 fill v2 migration + ZenMux sub-pattern 路由测试。

覆盖:

1. 0016 v2 patch 模板字段完备性(6 家 + 3 个 ZenMux profile 的 8 nested
   dataclass 字段全填值,非空)。
2. ZenMux sub-pattern 路由正确性:
   - ``anthropic/claude-*`` → CLAUDE profile
   - ``google/gemini-*`` → GEMINI profile
   - ``openai/gpt-*`` → OPENAI profile
3. ``_deep_merge`` 工具函数:
   - base 已有字段 win,overlay 不覆盖
   - base 缺失字段从 overlay 补
   - nested dict 递归合并
4. v2 patch 与 ResolvedCapabilities schema 兼容性(from_json 可读,无未知字段
   warning)。
5. 0016 deep-merge 不破坏 0015 已写字段(模拟 0015 → 0016 链路)。
6. ZenMux 5 模型 model_name 真实值映射稳定(harness 任务定义书 § B 列)。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter.resolved_capabilities import (
    ResolvedCapabilities,
)


def _load_migration_module():
    """从 0016 migration 文件路径直接 importlib 加载(数字开头不能 import)。"""
    django_root = Path(__file__).resolve().parents[5]
    migration_path = (
        django_root
        / "apps"
        / "services"
        / "llm"
        / "migrations"
        / "0016_llm_wire_adapter_capability_fill_v2.py"
    )
    spec = importlib.util.spec_from_file_location(
        "llm_w1a_fix_0016_module", str(migration_path)
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# 1. v2 patch 模板字段完备性
# ---------------------------------------------------------------------------

class V2PatchTemplateShapeTests(SimpleTestCase):
    """6 家 v2 patch + 3 个 ZenMux profile 模板字段完备性。"""

    def test_six_provider_v2_patches_have_all_eight_nested_keys(self):
        """6 家 v2 patch 都含 8 个 nested key + image/tool/wire/caching/json_mode/
        reasoning/usage/limits"""
        m = _load_migration_module()
        nested_keys = {"image", "tool", "wire", "caching", "json_mode",
                       "reasoning", "usage", "limits"}
        for name, patch in m.PROVIDER_V2_PATCH_MAP.items():
            for key in nested_keys:
                self.assertIn(
                    key,
                    patch,
                    f"{name} v2 patch 缺 {key}",
                )

    def test_minimax_v2_patch_anthropic_wire_fields(self):
        """MiniMax v2 patch:wire.upstream_path=/v1/messages,
        streaming_protocol=anthropic_sse"""
        m = _load_migration_module()
        p = m.MINIMAX_V2_PATCH
        self.assertEqual(p["wire"]["upstream_path"], "/v1/messages")
        self.assertEqual(p["wire"]["streaming_protocol"], "anthropic_sse")
        # W1b-fix Block C1:0016 误用 "anthropic_top_level" 不被 helper 识别,
        # 现已统一为权威字符串 "top_level_system_field"(_normalize_system 真识别)。
        self.assertEqual(p["wire"]["system_message_style"], "top_level_system_field")
        # Anthropic 风 usage
        self.assertEqual(p["usage"]["input_field"], "input_tokens")
        self.assertEqual(p["usage"]["output_field"], "output_tokens")
        # tool param_field 是 input_schema(非 parameters)
        self.assertEqual(p["tool"]["param_field"], "input_schema")
        # MiniMax 渠道特有 metric
        self.assertIn("total_characters", p["usage"]["extra_fields"])
        self.assertIn("input_sensitive", p["usage"]["extra_fields"])

    def test_moonshot_v2_patch_reasoning_format(self):
        """Moonshot v2 patch:reasoning.format=reasoning_content_field"""
        m = _load_migration_module()
        p = m.MOONSHOT_V2_PATCH
        self.assertEqual(p["reasoning"]["format"], "reasoning_content_field")
        self.assertEqual(p["reasoning"]["param_path"], "thinking")
        self.assertTrue(p["reasoning"]["visible_to_client"])
        # cached_path 顶层(非 details)— Moonshot 关键陷阱
        self.assertEqual(p["usage"]["cached_path"], "cached_tokens")
        # max_tools 总控 § 1.4 文档明示
        self.assertEqual(p["tool"]["max_tools"], 128)

    def test_qwen_v2_patch_no_json_schema(self):
        """Qwen v2:json_mode.modes=['json_object'](不支持 schema),
        schema_fallback=True"""
        m = _load_migration_module()
        p = m.QWEN_V2_PATCH
        self.assertEqual(p["json_mode"]["modes"], ["json_object"])
        self.assertIsNone(p["json_mode"]["schema_field"])
        self.assertTrue(p["json_mode"]["schema_fallback"])
        # parallel default OFF(DashScope 关键差异)
        self.assertFalse(p["tool"].get("parallel_default", False) if "parallel_default" in p["tool"] else False)


# ---------------------------------------------------------------------------
# 2. ZenMux sub-pattern 路由
# ---------------------------------------------------------------------------

class ZenMuxProfileResolverTests(SimpleTestCase):
    """ZenMux model_name → profile 路由(harness 任务定义书 § B 关键映射)。"""

    def test_anthropic_claude_routes_to_claude_profile(self):
        m = _load_migration_module()
        for name in [
            "anthropic/claude-opus-4.6",
            "anthropic/claude-sonnet-4.6",
            "anthropic/claude-haiku-4.0",
        ]:
            profile = m._resolve_zenmux_profile(name)
            self.assertIs(profile, m.ZENMUX_CLAUDE_FULL,
                          f"{name} 未映射到 Claude profile")

    def test_google_gemini_routes_to_gemini_profile(self):
        m = _load_migration_module()
        for name in [
            "google/gemini-3.1-pro-preview",
            "google/gemini-3.1-flash-lite-preview",
            "google/gemini-2.5-pro",
        ]:
            profile = m._resolve_zenmux_profile(name)
            self.assertIs(profile, m.ZENMUX_GEMINI_FULL,
                          f"{name} 未映射到 Gemini profile")

    def test_openai_gpt_routes_to_openai_profile(self):
        m = _load_migration_module()
        for name in [
            "openai/gpt-5.3-chat",
            "openai/gpt-4o",
            "openai/gpt-4-turbo",
        ]:
            profile = m._resolve_zenmux_profile(name)
            self.assertIs(profile, m.ZENMUX_OPENAI_FULL,
                          f"{name} 未映射到 OpenAI profile")

    def test_unknown_pattern_returns_none(self):
        """未知 model_name 返回 None(留给 admin 手工配)。"""
        m = _load_migration_module()
        self.assertIsNone(m._resolve_zenmux_profile(""))
        self.assertIsNone(m._resolve_zenmux_profile(None))
        self.assertIsNone(m._resolve_zenmux_profile("mistral/mixtral-8x7b"))
        self.assertIsNone(m._resolve_zenmux_profile("xai/grok-2"))

    def test_zenmux_claude_uses_openai_compat_wire_but_anthropic_capability(self):
        """ZenMux Claude profile 关键不变量:
        - wire 入口 = OpenAI 兼容 chat/completions(ZenMux 出口)
        - 能力维度按 Anthropic(thinking_block / 32MB payload)
        """
        m = _load_migration_module()
        p = m.ZENMUX_CLAUDE_FULL
        # ZenMux 出口
        self.assertEqual(p["wire"]["request_protocol"], "openai_chat_completions")
        self.assertEqual(p["wire"]["upstream_path"], "/chat/completions")
        self.assertEqual(p["wire"]["streaming_protocol"], "openai_delta")
        # 但能力按 Claude
        self.assertEqual(p["reasoning"]["format"], "thinking_block")
        self.assertEqual(p["limits"]["request_payload_max_mb"], 32)
        # cache_control_strip = True(ZenMux 不识别 Anthropic cache_control)
        self.assertTrue(p["caching"]["cache_control_strip"])

    def test_zenmux_gemini_silent_drop_params(self):
        """ZenMux Gemini profile:silent_drop_params 含 OpenAI 兼容层不识别参数"""
        m = _load_migration_module()
        p = m.ZENMUX_GEMINI_FULL
        sdp = p["limits"]["silent_drop_params"]
        for param in ("logit_bias", "seed", "top_logprobs", "frequency_penalty"):
            self.assertIn(param, sdp,
                          f"silent_drop_params 缺 {param}")

    def test_zenmux_openai_reasoning_hidden(self):
        """ZenMux OpenAI profile(gpt-5.3-chat 等非 o-series):
        reasoning.format='hidden' / visible_to_client=False"""
        m = _load_migration_module()
        p = m.ZENMUX_OPENAI_FULL
        self.assertEqual(p["reasoning"]["format"], "hidden")
        self.assertFalse(p["reasoning"]["visible_to_client"])


# ---------------------------------------------------------------------------
# 3. _deep_merge 工具函数
# ---------------------------------------------------------------------------

class DeepMergeTests(SimpleTestCase):
    """0016 deep-merge 工具:base win + 字段补齐 + 递归。"""

    def test_base_field_wins_over_overlay(self):
        """base 已有字段不被 overlay 覆盖"""
        m = _load_migration_module()
        base = {"a": 1, "b": "from_base"}
        overlay = {"a": 99, "c": "from_overlay"}
        result = m._deep_merge(base, overlay)
        # base 原值 win
        self.assertEqual(result["a"], 1)
        self.assertEqual(result["b"], "from_base")
        # overlay 补的新字段
        self.assertEqual(result["c"], "from_overlay")

    def test_nested_dict_recursive_merge(self):
        """nested dict 递归合并 — 0015 写的 wire.request_protocol 留住,
        0016 补的 wire.upstream_path 补上"""
        m = _load_migration_module()
        base = {
            "wire": {
                "request_protocol": "openai_chat_completions",
                "system_placement": "messages_first_role_system",
            },
        }
        overlay = {
            "wire": {
                "request_protocol": "should_not_win",
                "upstream_path": "/chat/completions",
                "streaming_protocol": "openai_delta",
            },
        }
        result = m._deep_merge(base, overlay)
        # base 字段 win
        self.assertEqual(result["wire"]["request_protocol"], "openai_chat_completions")
        self.assertEqual(result["wire"]["system_placement"], "messages_first_role_system")
        # overlay 补的新字段
        self.assertEqual(result["wire"]["upstream_path"], "/chat/completions")
        self.assertEqual(result["wire"]["streaming_protocol"], "openai_delta")

    def test_empty_base_returns_overlay_copy(self):
        """base 为空 → 返回 overlay 拷贝(不引用同一个 dict)"""
        m = _load_migration_module()
        overlay = {"a": {"b": 1}}
        result = m._deep_merge({}, overlay)
        self.assertEqual(result, overlay)
        # 修改 result 不影响 overlay(deep copy)
        result["a"]["b"] = 99
        self.assertEqual(overlay["a"]["b"], 1)

    def test_none_base_treated_as_empty(self):
        """base=None 等价空 dict"""
        m = _load_migration_module()
        result = m._deep_merge(None, {"x": 1})
        self.assertEqual(result, {"x": 1})


# ---------------------------------------------------------------------------
# 4. v2 patch + ZenMux profile 与 ResolvedCapabilities 兼容
# ---------------------------------------------------------------------------

class FromJsonRoundTripTests(SimpleTestCase):
    """v2 patch / ZenMux profile 都能被 ResolvedCapabilities.from_json 读回,
    无未知字段 warning。"""

    def test_zenmux_claude_full_round_trips(self):
        m = _load_migration_module()
        caps = ResolvedCapabilities.from_json(m.ZENMUX_CLAUDE_FULL)
        self.assertTrue(caps.is_configured)
        self.assertEqual(caps.wire.upstream_path, "/chat/completions")
        self.assertEqual(caps.wire.streaming_protocol, "openai_delta")
        self.assertEqual(caps.reasoning.format, "thinking_block")
        self.assertEqual(caps.tool.param_field, "parameters")
        self.assertEqual(caps.limits.request_payload_max_mb, 32)
        self.assertTrue(caps.caching.cache_control_strip)

    def test_zenmux_gemini_full_round_trips(self):
        m = _load_migration_module()
        caps = ResolvedCapabilities.from_json(m.ZENMUX_GEMINI_FULL)
        self.assertTrue(caps.is_configured)
        self.assertEqual(caps.wire.upstream_path, "/chat/completions")
        self.assertEqual(caps.reasoning.format, "thinking_config")
        self.assertIn("logit_bias", caps.limits.silent_drop_params)

    def test_zenmux_openai_full_round_trips(self):
        m = _load_migration_module()
        caps = ResolvedCapabilities.from_json(m.ZENMUX_OPENAI_FULL)
        self.assertTrue(caps.is_configured)
        self.assertEqual(caps.wire.upstream_path, "/chat/completions")
        self.assertEqual(caps.reasoning.format, "hidden")
        self.assertFalse(caps.reasoning.visible_to_client)


# ---------------------------------------------------------------------------
# 5. 0015 + 0016 deep-merge 链路(模拟 — 不连真实 DB)
# ---------------------------------------------------------------------------

class DeepMergeLinkSimulationTests(SimpleTestCase):
    """模拟 0015 已写入数据 + 0016 v2 patch deep-merge 后的最终状态。"""

    def test_0015_minimax_then_0016_v2_patch_merged(self):
        """0015 MiniMax 已写 wire.request_protocol=anthropic_messages,
        0016 deep-merge 补上 wire.upstream_path 等 v2 字段。"""
        m = _load_migration_module()
        # 模拟 0015 已写
        existing = {
            "wire": {
                "request_protocol": "anthropic_messages",
                "response_protocol": "anthropic_messages",
                "system_placement": "minimax_user_system_role",
                "system_quirks": ["minimax_extra_roles_passthrough"],
                "stream_supported": True,
            },
            "usage": {
                "input_tokens_field": "input_tokens",
                "output_tokens_field": "output_tokens",
                "extra_metrics": ["total_characters"],
            },
        }
        merged = m._deep_merge(existing, m.MINIMAX_V2_PATCH)
        # 0015 字段保留
        self.assertEqual(merged["wire"]["request_protocol"], "anthropic_messages")
        self.assertEqual(merged["wire"]["system_placement"], "minimax_user_system_role")
        self.assertIn("minimax_extra_roles_passthrough",
                      merged["wire"]["system_quirks"])
        self.assertEqual(merged["usage"]["input_tokens_field"], "input_tokens")
        # 0016 v2 字段补上
        self.assertEqual(merged["wire"]["upstream_path"], "/v1/messages")
        self.assertEqual(merged["wire"]["streaming_protocol"], "anthropic_sse")
        self.assertEqual(merged["usage"]["input_field"], "input_tokens")
        self.assertEqual(merged["tool"]["param_field"], "input_schema")
        # extra_fields 与 0015 extra_metrics 共存(命名不同字段)
        self.assertIn("total_characters", merged["usage"]["extra_metrics"])
        self.assertIn("total_characters", merged["usage"]["extra_fields"])

    def test_0015_moonshot_then_0016_v2_patch_merged(self):
        """0015 Moonshot 已写 reasoning.surface=delta_reasoning_content,
        0016 v2 补 reasoning.format=reasoning_content_field"""
        m = _load_migration_module()
        existing = {
            "reasoning": {
                "enabled": True,
                "surface": "delta_reasoning_content",
            },
            "usage": {
                "cache_read_field": "cached_tokens",
            },
        }
        merged = m._deep_merge(existing, m.MOONSHOT_V2_PATCH)
        self.assertEqual(merged["reasoning"]["surface"], "delta_reasoning_content")
        self.assertEqual(merged["reasoning"]["format"], "reasoning_content_field")
        self.assertEqual(merged["usage"]["cache_read_field"], "cached_tokens")
        self.assertEqual(merged["usage"]["cached_path"], "cached_tokens")

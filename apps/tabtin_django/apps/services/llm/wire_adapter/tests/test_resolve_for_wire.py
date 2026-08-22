"""Test wire_adapter.utils.capabilities.resolve_for_wire — 4 级 fallback 链(W1a).

覆盖:
- 第 1 级:capabilities_config["wire_adapter"] 命中 → 走 from_json,is_configured=True
- 第 2 级:Provider Service.CAPABILITIES 命中 → 9 条映射规则
- 第 3 级:LLMModel 离散布尔字段命中(get_capability_flag 内部已覆盖)
- 第 4 级:全部缺失 → 默认值 + is_configured=False + active model 走 logger.error
- LiteLLM sync 子键不污染 wire_adapter:capabilities_config 同时含 litellm_sync 子键时
  wire_adapter 子键解析仍正确

测试用 SimpleTestCase + Mock model/provider,不连 DB,跑得快。
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.llm.utils.capabilities import resolve_for_wire
from apps.services.llm.wire_adapter.resolved_capabilities import ResolvedCapabilities


def _make_mock_model(**fields):
    """构造一个 mock LLMModel-like 对象。

    默认值:**离散布尔字段全 None**。这是为了让 ``get_capability_flag``
    第 1 级(DB 字段)无法命中,从而真实走到 service_capabilities 第 2 级。

    需要测第 3 级离散字段命中时,显式传 ``supports_function_calling=True`` 等。
    """
    defaults = {
        "id": "mock-id",
        "model_name": "mock-model",
        "is_active": True,
        "wire_adapter_disabled": False,
        "wave_status": "ready",
        # W1a-fix-2 Block 4:sanity log 只对 chat-capable 触发,默认设 mode='chat'
        "mode": "chat",
        "capabilities_config": {},
        "multimodal_limits": {},
        # 离散布尔字段默认 None — 让 get_capability_flag 跳过第 1 级 DB 字段
        # 直接落到 capabilities_config / service_capabilities / default
        "supports_streaming": None,
        "supports_function_calling": None,
        "supports_vision": None,
        # 多模态限制
        "max_tokens": 128000,
        "max_input_tokens": None,
        "max_output_tokens": 4096,
        "max_image_size": 20 * 1024 * 1024,
        "max_images_per_request": 10,
    }
    defaults.update(fields)
    return SimpleNamespace(**defaults)


def _make_mock_provider(name: str):
    return SimpleNamespace(name=name)


# ---------------------------------------------------------------------------
# 第 1 级:capabilities_config["wire_adapter"]
# ---------------------------------------------------------------------------

class FallbackLevel1WireAdapterSubkeyTests(SimpleTestCase):
    def test_wire_adapter_subkey_takes_precedence(self):
        """有 wire_adapter 子键 → 直接 from_json,is_configured=True"""
        wire_adapter_data = {
            "image": {
                "enabled": True,
                "input_via": ["base64"],
                "formats": ["jpeg", "png"],
                "max_count_per_request": 5,
                "max_size_bytes": 1024 * 1024,
                "request_shape": "openai_image_url",
            },
            "tool": {
                "enabled": True,
                "choice_modes": ["auto", "required"],
                "parallel_default": True,
                "parallel_param_name": "parallel_tool_calls",
                "parallel_param_inverted": False,
            },
            "wave_status": "ready",
            "is_configured": True,
        }
        model = _make_mock_model(
            capabilities_config={"wire_adapter": wire_adapter_data},
            # 同时设了相反的离散字段:第 1 级命中后应该忽略它们
            supports_function_calling=False,
            supports_vision=False,
        )
        provider = _make_mock_provider("openai")

        caps = resolve_for_wire(model, provider)

        self.assertIsInstance(caps, ResolvedCapabilities)
        self.assertTrue(caps.is_configured)
        # wire_adapter 子键里的值赢
        self.assertTrue(caps.image.enabled)
        self.assertEqual(caps.image.input_via, ("base64",))
        self.assertTrue(caps.tool.enabled)
        self.assertEqual(caps.tool.choice_modes, ("auto", "required"))

    def test_litellm_sync_subkey_does_not_pollute(self):
        """capabilities_config 同时含 litellm_sync 和 wire_adapter 子键 →
        resolve_for_wire 只读 wire_adapter 子键,不污染。"""
        wire_adapter_data = {
            "image": {"enabled": True, "input_via": ["base64"]},
            "is_configured": True,
        }
        model = _make_mock_model(
            capabilities_config={
                "wire_adapter": wire_adapter_data,
                "litellm_sync": {"supports_assistant_prefill": True, "supports_pdf_input": False},
                # admin 表单写入的旧 key
                "supports_response_schema": True,
            },
            supports_function_calling=False,
            supports_vision=False,
        )
        provider = _make_mock_provider("claude")

        caps = resolve_for_wire(model, provider)

        # wire_adapter 子键值赢,litellm_sync / 顶层旧 key 不影响
        self.assertTrue(caps.image.enabled)
        self.assertEqual(caps.image.input_via, ("base64",))
        self.assertTrue(caps.is_configured)

    def test_wave_status_from_model_field_overrides_subkey(self):
        """model.wave_status 字段优先级高于 wire_adapter 子键里的 wave_status

        (例:0014 migration 已 set MiniMax model.wave_status='w2_pending',
        即使 0015 预填模板默认 'ready' 也不能回退覆盖)
        """
        wire_adapter_data = {
            "image": {"enabled": False},
            "is_configured": True,
            "wave_status": "ready",  # 子键里默认值
        }
        model = _make_mock_model(
            wave_status="w2_pending",  # model 字段(0014 migration set)
            capabilities_config={"wire_adapter": wire_adapter_data},
        )
        provider = _make_mock_provider("minimax")

        caps = resolve_for_wire(model, provider)

        # model.wave_status 字段赢
        self.assertEqual(caps.wave_status, "w2_pending")


# ---------------------------------------------------------------------------
# 第 2 级:Provider Service.CAPABILITIES 9 条映射规则
# ---------------------------------------------------------------------------

class FallbackLevel2ServiceCapabilitiesMappingTests(SimpleTestCase):
    """每条映射规则单独跑一遍 — 总控 § D5 关键映射 9 条。"""

    def _resolve_with_service_caps(self, service_caps: dict, model_kwargs=None):
        """构造 mock model/provider 让第 1 级缺失,直接落到第 2 级。"""
        model_kwargs = model_kwargs or {}
        model = _make_mock_model(capabilities_config={}, **model_kwargs)
        provider = _make_mock_provider("openai")

        # mock ProviderRegistry.get_service_class 返回带 CAPABILITIES 的桩类
        with patch(
            "apps.services.llm.registry.AIServiceProviderRegistry.get_service_class"
        ) as mock_get:
            mock_get.return_value = SimpleNamespace(CAPABILITIES=service_caps)
            return resolve_for_wire(model, provider)

    def test_rule1_function_calling_enables_tool(self):
        """supports_function_calling=True → tool.enabled=True"""
        caps = self._resolve_with_service_caps({"supports_function_calling": True})
        self.assertTrue(caps.tool.enabled)

    def test_rule2_function_calling_with_tool_choice_sets_choice_modes(self):
        """supports_function_calling=True + supports_tool_choice=True →
        tool.choice_modes 含 'auto'/'required'/'none'/'specific'(W1a-fix-2 修订)"""
        caps = self._resolve_with_service_caps({
            "supports_function_calling": True,
            "supports_tool_choice": True,
        })
        self.assertIn("auto", caps.tool.choice_modes)
        self.assertIn("required", caps.tool.choice_modes)
        self.assertIn("none", caps.tool.choice_modes)
        self.assertIn("specific", caps.tool.choice_modes)

    def test_rule3_function_calling_no_tool_choice(self):
        """supports_function_calling=True 但 supports_tool_choice=False →
        choice_modes 含 ('auto','required','none')(W1a-fix-2 Block 3 修订:
        无条件给 3 模式,supports_tool_choice 仅决定是否扩展含 'specific')。"""
        caps = self._resolve_with_service_caps({
            "supports_function_calling": True,
            "supports_tool_choice": False,
        })
        self.assertTrue(caps.tool.enabled)
        # 3 基础模式无条件给(W1a-fix-2 修订)
        self.assertIn("auto", caps.tool.choice_modes)
        self.assertIn("required", caps.tool.choice_modes)
        self.assertIn("none", caps.tool.choice_modes)
        # supports_tool_choice=False → 不含 specific
        self.assertNotIn("specific", caps.tool.choice_modes)

    def test_rule4_vision_enables_image_with_base64_url(self):
        """supports_vision=True → image.input_via=('base64','url'),
        image.formats=('jpeg','png','webp','gif')"""
        caps = self._resolve_with_service_caps({"supports_vision": True})
        self.assertTrue(caps.image.enabled)
        self.assertIn("base64", caps.image.input_via)
        self.assertIn("url", caps.image.input_via)
        self.assertIn("jpeg", caps.image.formats)
        self.assertIn("png", caps.image.formats)
        self.assertIn("webp", caps.image.formats)
        self.assertIn("gif", caps.image.formats)

    def test_rule5_parallel_function_calling_sets_parallel_default(self):
        """supports_parallel_function_calling=True →
        tool.parallel_default=True"""
        caps = self._resolve_with_service_caps({
            "supports_function_calling": True,
            "supports_parallel_function_calling": True,
        })
        self.assertTrue(caps.tool.parallel_default)

    def test_rule6_prompt_caching_enables_caching_mode(self):
        """supports_prompt_caching=True → caching.mode='automatic_implicit'"""
        caps = self._resolve_with_service_caps({"supports_prompt_caching": True})
        self.assertEqual(caps.caching.mode, "automatic_implicit")

    def test_rule7_reasoning_enables_reasoning(self):
        """supports_reasoning=True → reasoning.enabled=True"""
        caps = self._resolve_with_service_caps({"supports_reasoning": True})
        self.assertTrue(caps.reasoning.enabled)

    def test_rule8_json_mode_enables_json_schema(self):
        """supports_json_mode=True → json_mode.mode='json_schema'"""
        caps = self._resolve_with_service_caps({"supports_json_mode": True})
        self.assertEqual(caps.json_mode.mode, "json_schema")

    def test_rule9_streaming_set_wire_stream_supported(self):
        """supports_streaming=True → wire.stream_supported=True"""
        caps = self._resolve_with_service_caps({"supports_streaming": True})
        self.assertTrue(caps.wire.stream_supported)


# ---------------------------------------------------------------------------
# 第 3 级:LLMModel 离散布尔字段(W3 末删)
# ---------------------------------------------------------------------------

class FallbackLevel3DiscreteBoolFieldsTests(SimpleTestCase):
    def test_discrete_supports_function_calling_picked_when_no_service_caps(self):
        """service_caps 拿不到时,模型离散字段 supports_function_calling=True 仍能驱动 tool"""
        model = _make_mock_model(
            capabilities_config={},
            supports_function_calling=True,
            supports_vision=False,
        )
        # provider=None → service_caps 取不到 → fallback 到 model 离散字段
        caps = resolve_for_wire(model, provider=None)
        self.assertTrue(caps.tool.enabled)

    def test_discrete_supports_vision_drives_image_when_no_service_caps(self):
        model = _make_mock_model(
            capabilities_config={},
            supports_function_calling=False,
            supports_vision=True,
        )
        caps = resolve_for_wire(model, provider=None)
        self.assertTrue(caps.image.enabled)
        self.assertIn("base64", caps.image.input_via)


# ---------------------------------------------------------------------------
# 第 4 级:全部缺失 → 默认值
# ---------------------------------------------------------------------------

class FallbackLevel4DefaultsTests(SimpleTestCase):
    def test_no_config_no_provider_returns_default(self):
        """全空 → ResolvedCapabilities() 默认值,is_configured=False"""
        model = _make_mock_model(
            capabilities_config={},
            supports_function_calling=False,
            supports_vision=False,
        )
        caps = resolve_for_wire(model, provider=None)
        self.assertFalse(caps.is_configured)
        self.assertFalse(caps.tool.enabled)
        self.assertFalse(caps.image.enabled)
        # streaming 默认 True(get_capability_flag default)
        # supports_streaming 离散字段 default True 仍生效
        self.assertTrue(caps.wire.stream_supported)

    def test_active_model_unconfigured_logs_error(self):
        """is_active=True 且 is_configured=False → logger.error 提示"""
        model = _make_mock_model(
            is_active=True,
            capabilities_config={},
            supports_function_calling=False,
            supports_vision=False,
            model_name="dogfood-test-model",
        )
        with self.assertLogs(
            "apps.services.llm.utils.capabilities",
            level=logging.ERROR,
        ) as log:
            resolve_for_wire(model, provider=None)
        self.assertTrue(any("dogfood-test-model" in m and "未配置" in m for m in log.output))

    def test_inactive_model_unconfigured_no_error(self):
        """is_active=False 且 is_configured=False → 不记 error"""
        model = _make_mock_model(
            is_active=False,
            capabilities_config={},
            supports_function_calling=False,
            supports_vision=False,
        )
        # assertNoLogs 是 Python 3.10+,我们用 try/except 替代
        with self.assertLogs(
            "apps.services.llm.utils.capabilities",
            level=logging.ERROR,
        ) as log:
            resolve_for_wire(model, provider=None)
            # 给 logger 加一条额外的 info,避免 assertLogs 因为没记录而抛
            logging.getLogger("apps.services.llm.utils.capabilities").error(
                "_sentinel_for_assert_logs"
            )
        # 检查没有"未配置"的 error
        unconfigured_errors = [m for m in log.output if "未配置" in m]
        self.assertEqual(len(unconfigured_errors), 0)


# ---------------------------------------------------------------------------
# 6 家初值预填 - migration 后的可读性(simulated, 不依赖 DB)
# ---------------------------------------------------------------------------

class SixProviderCapsTemplateShapeTests(SimpleTestCase):
    """验证 migration 0015 6 家初值模板可被 from_json 读回(不连 DB)。"""

    def _get_template(self, provider_name):
        from apps.services.llm.migrations import (
            _0015_llm_wire_adapter_capability_fill as fill_module,  # type: ignore[import-not-found]
        )
        return fill_module.PROVIDER_CAPS_MAP[provider_name]

    def _load_template_directly(self, provider_name):
        """直接从 migration 文件 import,Python 命名规则不允许 0 开头,
        我们用 importlib + 文件路径方式加载。"""
        import importlib.util
        from pathlib import Path

        # services/llm/migrations/0015_llm_wire_adapter_capability_fill.py
        django_root = Path(__file__).resolve().parents[5]
        migration_path = (
            django_root
            / "apps"
            / "services"
            / "llm"
            / "migrations"
            / "0015_llm_wire_adapter_capability_fill.py"
        )
        spec = importlib.util.spec_from_file_location(
            "llm_w1a_0015_module", str(migration_path)
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.PROVIDER_CAPS_MAP[provider_name]

    def test_all_six_providers_have_template(self):
        """6 家 chat-capable provider 都有初值模板"""
        for name in ("openai", "claude", "gemini", "moonshot", "qwen", "minimax"):
            template = self._load_template_directly(name)
            self.assertIsInstance(template, dict)
            # 关键字段必须齐全
            self.assertIn("image", template)
            self.assertIn("tool", template)
            self.assertIn("wire", template)
            self.assertIn("caching", template)
            self.assertIn("json_mode", template)
            self.assertIn("reasoning", template)
            self.assertIn("usage", template)
            self.assertIn("limits", template)
            self.assertIn("wave_status", template)
            self.assertIn("is_configured", template)

    def test_all_six_templates_can_be_loaded_via_from_json(self):
        """6 家初值模板都能被 ResolvedCapabilities.from_json 读回"""
        for name in ("openai", "claude", "gemini", "moonshot", "qwen", "minimax"):
            template = self._load_template_directly(name)
            caps = ResolvedCapabilities.from_json(template)
            self.assertIsInstance(caps, ResolvedCapabilities)
            self.assertTrue(caps.is_configured)

    def test_kimi_image_via_base64_only_dogfood_fix(self):
        """Moonshot 初值不含 'url' input_via — Kimi K2.5 dogfood bug 修复关键约束"""
        template = self._load_template_directly("moonshot")
        self.assertNotIn("url", template["image"]["input_via"])
        self.assertIn("base64", template["image"]["input_via"])

    def test_qwen_parallel_default_off(self):
        """Qwen 初值 tool.parallel_default=False(必须显式开)"""
        template = self._load_template_directly("qwen")
        self.assertFalse(template["tool"]["parallel_default"])

    def test_qwen_no_json_schema(self):
        """Qwen 初值 json_mode.mode='json_object'(不支持 schema)"""
        template = self._load_template_directly("qwen")
        self.assertEqual(template["json_mode"]["mode"], "json_object")

    def test_claude_anthropic_image_source_shape(self):
        """Claude 初值 image.request_shape='anthropic_image_source'"""
        template = self._load_template_directly("claude")
        self.assertEqual(template["image"]["request_shape"], "anthropic_image_source")

    def test_claude_disable_parallel_inverted(self):
        """Claude 初值 tool.parallel_param_inverted=True"""
        template = self._load_template_directly("claude")
        self.assertTrue(template["tool"]["parallel_param_inverted"])
        self.assertEqual(template["tool"]["parallel_param_name"], "disable_parallel_tool_use")

    def test_minimax_anthropic_messages_protocol(self):
        """MiniMax 初值 wire.request_protocol='anthropic_messages',quirks 含
        minimax_extra_roles_passthrough"""
        template = self._load_template_directly("minimax")
        self.assertEqual(template["wire"]["request_protocol"], "anthropic_messages")
        self.assertIn(
            "minimax_extra_roles_passthrough",
            template["wire"]["system_quirks"],
        )

    def test_minimax_wave_status_w2_pending(self):
        """MiniMax 初值 wave_status='w2_pending'"""
        template = self._load_template_directly("minimax")
        self.assertEqual(template["wave_status"], "w2_pending")

    def test_minimax_image_disabled(self):
        """MiniMax OpenAI 兼容端无 image,初值 image.enabled=False"""
        template = self._load_template_directly("minimax")
        self.assertFalse(template["image"]["enabled"])

    def test_minimax_extra_metric_total_characters(self):
        """MiniMax usage.extra_metrics 含 total_characters"""
        template = self._load_template_directly("minimax")
        self.assertIn("total_characters", template["usage"]["extra_metrics"])

    def test_openai_strict_json_supported(self):
        """OpenAI json_mode.strict_supported=True"""
        template = self._load_template_directly("openai")
        self.assertTrue(template["json_mode"]["strict_supported"])

    def test_gemini_only_base64_image_input(self):
        """Gemini 文档只用 base64,初值 image.input_via=['base64']"""
        template = self._load_template_directly("gemini")
        self.assertEqual(template["image"]["input_via"], ["base64"])

    def test_moonshot_cache_read_field_top_level(self):
        """Moonshot cache_read_field 在 usage 顶层(不在 prompt_tokens_details 内)"""
        template = self._load_template_directly("moonshot")
        self.assertEqual(template["usage"]["cache_read_field"], "cached_tokens")

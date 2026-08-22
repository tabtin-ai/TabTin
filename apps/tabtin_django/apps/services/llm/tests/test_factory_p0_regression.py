"""FAC-1 / FAC-2 / FAC-3 P0 回归测试。"""

from unittest.mock import Mock, patch

from django.test import TestCase, override_settings

from ..services.factory import (
    LLMServiceFactory,
    _get_fallback_config,
    _get_default_model_for_provider,
)
from ..services.openai_service import OpenAIService
from ..services.claude_service import ClaudeService
from ..services.gemini_service import GeminiService


# ── FAC-1: 未注册 provider 优雅降级 ──


class FAC1UnknownProviderDegradationTest(TestCase):
    """FAC-1: 未注册的 provider（如 local）不应抛 ValueError，应降级到 OpenAIService。"""

    @patch("openai.OpenAI")
    def test_local_provider_degrades_to_openai(self, mock_openai):
        mock_openai.return_value = Mock()
        service = LLMServiceFactory.create_service(
            "local",
            {
                "name": "local",
                "api_key": "test-key",
                "base_url": "http://localhost:11434/v1",
            },
        )
        self.assertIsInstance(service, OpenAIService)

    @patch("openai.OpenAI")
    def test_arbitrary_unknown_provider_degrades(self, mock_openai):
        mock_openai.return_value = Mock()
        service = LLMServiceFactory.create_service(
            "my_custom_provider",
            {
                "name": "my_custom_provider",
                "api_key": "key",
                "base_url": "https://custom.example.com/v1",
            },
        )
        self.assertIsInstance(service, OpenAIService)

    def test_known_providers_still_use_correct_class(self):
        """确保已注册的 provider 不受降级逻辑影响。"""
        self.assertIs(LLMServiceFactory.SERVICE_CLASSES.get("openai"), OpenAIService)
        self.assertIs(LLMServiceFactory.SERVICE_CLASSES.get("claude"), ClaudeService)
        self.assertIs(LLMServiceFactory.SERVICE_CLASSES.get("gemini"), GeminiService)


# ── FAC-2: _get_fallback_config 支持 claude/gemini ──


class FAC2FallbackConfigTest(TestCase):
    """FAC-2: _get_fallback_config 必须覆盖 claude 和 gemini，DB 故障时不丢服务。"""

    def test_claude_fallback_config(self):
        config = _get_fallback_config("claude")
        self.assertEqual(config["name"], "claude")
        self.assertIn("api_key", config)
        self.assertIn("base_url", config)
        self.assertIn("model_name", config)
        self.assertNotEqual(config["model_name"], "")

    def test_gemini_fallback_config(self):
        config = _get_fallback_config("gemini")
        self.assertEqual(config["name"], "gemini")
        self.assertIn("api_key", config)
        self.assertIn("base_url", config)
        self.assertIn("model_name", config)
        self.assertNotEqual(config["model_name"], "")

    @override_settings(CLAUDE_API_KEY="sk-ant-test", CLAUDE_MODEL="claude-opus-5")
    def test_claude_fallback_reads_settings(self):
        config = _get_fallback_config("claude")
        self.assertEqual(config["api_key"], "sk-ant-test")
        self.assertEqual(config["model_name"], "claude-opus-5")

    @override_settings(GEMINI_API_KEY="AIza-test", GEMINI_MODEL="gemini-3-pro")
    def test_gemini_fallback_reads_settings(self):
        config = _get_fallback_config("gemini")
        self.assertEqual(config["api_key"], "AIza-test")
        self.assertEqual(config["model_name"], "gemini-3-pro")

    def test_unknown_provider_fallback_degrades_to_openai(self):
        """未知 provider 的 fallback 应降级到 openai 配置而非抛异常。"""
        config = _get_fallback_config("nonexistent_provider")
        self.assertEqual(config["name"], "openai")

    def test_all_known_providers_have_fallback(self):
        """所有 SERVICE_CLASSES 中的 provider 都应有 fallback 配置。"""
        for provider_name in LLMServiceFactory.SERVICE_CLASSES:
            config = _get_fallback_config(provider_name)
            self.assertEqual(config["name"], provider_name)
            self.assertIn("model_name", config)


# ── FAC-3: 硬编码模型名更新 ──


class FAC3DefaultModelNamesTest(TestCase):
    """FAC-3: _get_default_model_for_provider 不应返回已下架模型名。"""

    DEPRECATED_MODELS = {
        "gemini-pro",
        "claude-3-sonnet-20240229",
    }

    def test_claude_default_not_deprecated(self):
        model = _get_default_model_for_provider("claude")
        self.assertNotIn(model, self.DEPRECATED_MODELS)

    def test_gemini_default_not_deprecated(self):
        model = _get_default_model_for_provider("gemini")
        self.assertNotIn(model, self.DEPRECATED_MODELS)

    @override_settings(CLAUDE_MODEL="claude-custom-v1")
    def test_claude_default_reads_settings(self):
        model = _get_default_model_for_provider("claude")
        self.assertEqual(model, "claude-custom-v1")

    @override_settings(GEMINI_MODEL="gemini-custom-v1")
    def test_gemini_default_reads_settings(self):
        model = _get_default_model_for_provider("gemini")
        self.assertEqual(model, "gemini-custom-v1")

    def test_all_providers_have_default_model(self):
        """所有已知 provider 都应返回非空默认模型名。"""
        for provider_name in LLMServiceFactory.SERVICE_CLASSES:
            model = _get_default_model_for_provider(provider_name)
            self.assertTrue(model, f"{provider_name} 返回了空模型名")
            self.assertNotEqual(model, "default", f"{provider_name} 返回了 'default' 占位符")

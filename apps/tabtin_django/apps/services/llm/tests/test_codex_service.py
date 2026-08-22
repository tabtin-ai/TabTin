from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from apps.services.llm.models import LLMProvider
from apps.services.llm.services.factory import LLMServiceFactory, _get_fallback_config
from apps.services.llm.services.openai_service import OpenAIService


class CodexServiceTestCase(SimpleTestCase):
    def test_provider_choices_include_codex(self):
        provider_names = {item[0] for item in LLMProvider.get_provider_choices()}
        self.assertIn("codex", provider_names)

    def test_factory_reports_codex_supported(self):
        self.assertIn("codex", LLMServiceFactory.get_supported_providers())

    @patch("openai.OpenAI")
    def test_create_codex_service_uses_openai_service(self, mock_openai):
        mock_openai.return_value = Mock()
        service = LLMServiceFactory.create_service(
            "codex",
            {
                "name": "codex",
                "api_key": "token-test",
                "base_url": "https://api.openai.com/v1",
                "model_name": "gpt-5-codex",
                "max_retries": 0,
                "retry_delay": 0,
            },
        )
        self.assertIsInstance(service, OpenAIService)
        enabled, explicit = service._resolve_responses_api_mode({})
        self.assertTrue(enabled)
        self.assertFalse(explicit)

    @override_settings(
        CODEX_API_KEY="codex-key",
        CODEX_BASE_URL="https://api.openai.com/v1",
        CODEX_MODEL="gpt-5-codex",
    )
    def test_codex_fallback_config(self):
        config = _get_fallback_config("codex")
        self.assertEqual(config["name"], "codex")
        self.assertEqual(config["api_key"], "codex-key")
        self.assertEqual(config["base_url"], "https://api.openai.com/v1")
        self.assertEqual(config["model_name"], "gpt-5-codex")

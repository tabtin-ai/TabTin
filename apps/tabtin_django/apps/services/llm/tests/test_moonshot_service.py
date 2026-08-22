from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from ..models import LLMProvider
from ..services.factory import LLMServiceFactory
from ..services.moonshot_service import MoonshotService
from ..services.proxy_service import ProxyContext, apply_provider_request_policy


class MoonshotServiceTestCase(SimpleTestCase):
    def test_provider_choices_include_moonshot(self):
        provider_names = {item[0] for item in LLMProvider.get_provider_choices()}
        self.assertIn("moonshot", provider_names)

    def test_factory_reports_moonshot_supported(self):
        self.assertIn("moonshot", LLMServiceFactory.get_supported_providers())

    @patch("openai.OpenAI")
    def test_create_moonshot_service(self, mock_openai):
        config = {
            "name": "moonshot",
            "api_key": "sk-test-key",
            "base_url": "https://api.moonshot.cn/v1",
        }

        service = LLMServiceFactory.create_service("moonshot", config)

        self.assertIsInstance(service, MoonshotService)
        self.assertEqual(service.default_model, "kimi-k2-turbo-preview")
        mock_openai.assert_called_once_with(
            api_key="sk-test-key",
            base_url="https://api.moonshot.cn/v1",
        )

    @patch("openai.OpenAI")
    def test_json_mode_for_kimi_model(self, mock_openai):
        config = {
            "name": "moonshot",
            "api_key": "sk-test-key",
            "base_url": "https://api.moonshot.cn/v1",
            "model_name": "kimi-k2-turbo-preview",
        }
        service = MoonshotService(config)

        params = service._prepare_chat_params(
            [{"role": "user", "content": "返回 JSON"}],
            response_format="json_object",
        )

        self.assertEqual(params.get("response_format"), {"type": "json_object"})

    @patch("openai.OpenAI")
    def test_prompt_cache_key_forwarded_and_retention_stripped(self, mock_openai):
        config = {
            "name": "moonshot",
            "api_key": "sk-test-key",
            "base_url": "https://api.moonshot.cn/v1",
            "model_name": "kimi-k2-turbo-preview",
        }
        service = MoonshotService(config)

        params = service._prepare_chat_params(
            [{"role": "user", "content": "请继续"}],
            prompt_cache_key="ws:kimi:chat",
            prompt_cache_retention="24h",
        )

        self.assertEqual(params["extra_body"]["prompt_cache_key"], "ws:kimi:chat")
        self.assertNotIn("prompt_cache_retention", params["extra_body"])

    @patch(
        "apps.services.llm.registry.ProviderRegistry.get_service_class",
        return_value=MoonshotService,
    )
    def test_proxy_policy_derives_cache_key_from_session(self, get_service_class):
        ctx = ProxyContext(
            session_id="conversation-1",
            provider=SimpleNamespace(provider_key="moonshot", name="Moonshot"),
        )

        body = apply_provider_request_policy(
            {"model": "kimi-k3", "messages": []},
            ctx,
        )

        self.assertEqual(body["prompt_cache_key"], "conversation-1")
        get_service_class.assert_called_once_with("moonshot")

    def test_proxy_policy_preserves_legacy_explicit_cache_key(self):
        body = MoonshotService.prepare_proxy_request(
            {"model": "kimi-k3", "messages": []},
            session_id="conversation-1",
            incoming_body={
                "prompt_cache_key": "legacy-client-key",
                "prompt_cache_retention": "24h",
            },
        )

        self.assertEqual(body["prompt_cache_key"], "legacy-client-key")
        self.assertNotIn("prompt_cache_retention", body)

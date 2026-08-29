from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from ..adapter_resolver import resolve_adapter_name, resolve_provider_adapter
from ..services.factory import LLMServiceFactory
from ..services.openai_service import OpenAIService
from ..services.proxy_service import ProxyContext, apply_provider_request_policy
from ..utils.capabilities import _get_service_capabilities


class AdapterResolverTestCase(SimpleTestCase):
    def test_registered_provider_key_wins_over_registered_name(self):
        provider = SimpleNamespace(provider_key="kimi_coding", name="moonshot")

        with patch(
            "apps.services.llm.registry.ProviderRegistry.is_registered",
            side_effect=lambda value: value in {"kimi_coding", "moonshot"},
        ):
            self.assertEqual(resolve_adapter_name(provider), "kimi_coding")

    def test_unregistered_connection_key_uses_registered_name(self):
        provider = SimpleNamespace(provider_key="openai-openrouter", name="openai")

        with patch(
            "apps.services.llm.registry.ProviderRegistry.is_registered",
            side_effect=lambda value: value == "openai",
        ):
            self.assertEqual(resolve_adapter_name(provider), "openai")

    def test_unregistered_pair_falls_back_to_name(self):
        provider = SimpleNamespace(provider_key="custom-gateway", name="local")

        with patch(
            "apps.services.llm.registry.ProviderRegistry.is_registered",
            return_value=False,
        ):
            self.assertEqual(resolve_adapter_name(provider), "local")

    def test_empty_name_falls_back_to_unregistered_key(self):
        provider = SimpleNamespace(provider_key="custom-gateway", name="")

        with patch(
            "apps.services.llm.registry.ProviderRegistry.is_registered",
            return_value=False,
        ):
            self.assertEqual(resolve_adapter_name(provider), "custom-gateway")

    def test_empty_name_still_uses_registered_key(self):
        provider = SimpleNamespace(provider_key="kimi_coding", name="")

        with patch(
            "apps.services.llm.registry.ProviderRegistry.is_registered",
            side_effect=lambda value: value == "kimi_coding",
        ):
            self.assertEqual(resolve_adapter_name(provider), "kimi_coding")

    def test_empty_provider_returns_empty_name(self):
        provider = SimpleNamespace(provider_key="", name="")

        self.assertEqual(resolve_adapter_name(provider), "")

    def test_resolve_provider_adapter_uses_registry_openai_fallback(self):
        provider = SimpleNamespace(provider_key="unknown-connection", name="unknown-vendor")

        self.assertIs(resolve_provider_adapter(provider), OpenAIService)

    def test_real_registry_plan_key_beats_moonshot_name(self):
        provider = SimpleNamespace(provider_key="kimi_coding", name="moonshot")

        self.assertEqual(resolve_adapter_name(provider), "kimi_coding")

    def test_real_registry_openrouter_connection_uses_openai(self):
        provider = SimpleNamespace(provider_key="openai-openrouter", name="openai")

        self.assertEqual(resolve_adapter_name(provider), "openai")

    def test_official_openai_uses_registered_name(self):
        provider = SimpleNamespace(provider_key="openai", name="openai")

        self.assertEqual(resolve_adapter_name(provider), "openai")


class AdapterResolverCallSiteTestCase(SimpleTestCase):
    def test_proxy_policy_uses_registered_plan_key(self):
        ctx = ProxyContext(
            session_id="conversation-1",
            provider=SimpleNamespace(provider_key="kimi_coding", name="moonshot"),
        )

        with patch(
            "apps.services.llm.registry.ProviderRegistry.get_service_class",
        ) as get_service_class:
            get_service_class.return_value = OpenAIService
            apply_provider_request_policy({"model": "kimi-for-coding", "messages": []}, ctx)
            get_service_class.assert_called_once_with("kimi_coding")

    def test_proxy_policy_uses_registered_name_for_connection_slug(self):
        ctx = ProxyContext(
            session_id="conversation-1",
            provider=SimpleNamespace(provider_key="openai-openrouter", name="openai"),
        )

        with patch(
            "apps.services.llm.registry.ProviderRegistry.get_service_class",
        ) as get_service_class:
            get_service_class.return_value = OpenAIService
            apply_provider_request_policy({"model": "gpt-4o", "messages": []}, ctx)
            get_service_class.assert_called_once_with("openai")

    def test_capability_lookup_uses_resolver_for_provider_object(self):
        provider = SimpleNamespace(provider_key="kimi_coding", name="moonshot")

        with patch(
            "apps.services.llm.registry.ProviderRegistry.get_service_class",
            return_value=OpenAIService,
        ) as get_service_class:
            _get_service_capabilities(provider)
            get_service_class.assert_called_once_with("kimi_coding")

    @patch("openai.OpenAI")
    def test_factory_prefers_provider_obj_over_passed_name(self, mock_openai):
        mock_openai.return_value = Mock()
        provider = SimpleNamespace(provider_key="kimi_coding", name="moonshot")

        with patch(
            "apps.services.llm.registry.ProviderRegistry.get_service_class",
            return_value=OpenAIService,
        ) as get_service_class:
            LLMServiceFactory.create_service(
                "openai",
                {
                    "name": "openai",
                    "api_key": "sk-test",
                    "base_url": "https://api.kimi.com/coding/v1",
                    "provider_obj": provider,
                },
            )
            self.assertGreaterEqual(get_service_class.call_count, 1)
            self.assertEqual(get_service_class.call_args_list[0].args[0], "kimi_coding")

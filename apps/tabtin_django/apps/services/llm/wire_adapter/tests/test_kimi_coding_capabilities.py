"""Kimi Coding BYOK 套餐的 wire capability 回归测试。"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.llm.api_config import create_organization_model
from apps.services.llm.providers.openai.service import OpenAIService
from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.schemas import OrganizationModelCreateRequest
from apps.services.llm.utils.capabilities import resolve_for_wire
from apps.services.llm.utils.known_byok_capabilities import (
    ensure_known_byok_wire_capability,
)


class KimiCodingCapabilitiesTests(SimpleTestCase):
    def test_provider_alias_keeps_the_existing_openai_compatible_request_policy(self):
        metadata = ProviderRegistry.get("kimi_coding")

        self.assertEqual(
            metadata.default_base_url,
            "https://api.kimi.com/coding/v1",
        )
        self.assertIs(
            ProviderRegistry.get_service_class("kimi_coding"),
            OpenAIService,
        )

    def test_existing_admin_wire_contract_remains_authoritative(self):
        configured = {
            "wire_adapter": {
                "wire": {"request_protocol": "anthropic_messages"},
            },
        }

        result = ensure_known_byok_wire_capability(
            provider_key="kimi_coding",
            model_name="kimi-for-coding",
            capabilities_config=configured,
        )

        self.assertEqual(result, configured)

    def _resolve(self, model_name: str):
        provider = SimpleNamespace(
            name="moonshot",
            provider_key="kimi_coding",
            scope="organization",
        )
        model = SimpleNamespace(
            id=f"model-{model_name}",
            model_name=model_name,
            capability_domain="chat",
            wave_status="ready",
            capabilities_config={
                "supports_streaming": True,
                "supports_vision": False,
            },
            context_window_tokens=262_144,
            max_input_tokens=None,
            max_output_tokens=None,
            multimodal_limits={},
        )

        with self.assertNoLogs(
            "apps.services.llm.utils.capabilities",
            level="ERROR",
        ):
            return resolve_for_wire(model, provider)

    def test_k27_preset_resolves_explicit_wire_capability_without_error(self):
        capabilities = self._resolve("kimi-for-coding")

        self.assertTrue(capabilities.is_configured)
        self.assertEqual(
            capabilities.wire.request_protocol,
            "openai_chat_completions",
        )
        self.assertTrue(capabilities.tool.enabled)
        self.assertTrue(capabilities.reasoning.enabled)
        self.assertIsNone(capabilities.reasoning.param_path)

    def test_k27_highspeed_uses_the_same_always_thinking_wire_contract(self):
        capabilities = self._resolve("kimi-for-coding-highspeed")

        self.assertTrue(capabilities.is_configured)
        self.assertTrue(capabilities.reasoning.enabled)
        self.assertIsNone(capabilities.reasoning.param_path)

    def test_k3_256k_declares_reasoning_effort_instead_of_falling_back(self):
        capabilities = self._resolve("k3-256k")

        self.assertTrue(capabilities.is_configured)
        self.assertTrue(capabilities.reasoning.enabled)
        self.assertEqual(capabilities.reasoning.param_path, "reasoning_effort")

    @patch("apps.services.llm.api_config.invalidate_models_cache")
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.api_config.LLMModel.objects.create")
    @patch("apps.services.llm.api_config.LLMModel.objects.filter")
    @patch("apps.services.llm.api_config.LLMProvider.objects.get")
    def test_create_api_persists_the_kimi_wire_contract(
        self,
        get_provider,
        filter_models,
        create_model,
        _ensure_permission,
        _invalidate_cache,
    ):
        provider = SimpleNamespace(
            id="provider-kimi-coding",
            name="moonshot",
            provider_key="kimi_coding",
            scope="organization",
            organization_id="organization-1",
            user_id=None,
            capability_domains=["chat"],
            default_base_url="https://api.kimi.com/coding/v1",
            models=MagicMock(),
        )
        get_provider.return_value = provider
        filter_models.return_value.exists.return_value = False
        create_model.return_value = SimpleNamespace(
            id="model-kimi-coding",
            model_name="kimi-for-coding",
            display_name="Kimi K2.7 Code",
        )
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        payload = OrganizationModelCreateRequest(
            provider_id=provider.id,
            model_name="kimi-for-coding",
            display_name="Kimi K2.7 Code",
            context_window_tokens=262_144,
            capabilities_config={
                "supports_streaming": True,
                "supports_vision": False,
            },
        )

        response = create_organization_model.__wrapped__(
            request,
            provider.organization_id,
            payload,
        )

        self.assertTrue(response["success"])
        stored_config = create_model.call_args.kwargs["capabilities_config"]
        self.assertEqual(
            stored_config["wire_adapter"]["wire"]["request_protocol"],
            "openai_chat_completions",
        )

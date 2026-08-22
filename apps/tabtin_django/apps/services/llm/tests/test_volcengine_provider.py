"""Volcengine Ark provider registration + LiteLLM routing hints."""

from importlib import import_module
from types import SimpleNamespace

from apps.services.llm.litellm_config import resolve_litellm_provider, get_litellm_provider_set
from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.utils.token_counter import TokenCounterFactory, TikTokenCounter
from apps.services.llm.wire_adapter.validator import validate_model


class TestVolcengineProviderRegistration:
    def test_volcengine_registered(self):
        meta = ProviderRegistry.get("volcengine")
        assert meta is not None
        assert meta.default_base_url == "https://ark.cn-beijing.volces.com/api/v3"
        assert meta.supports_openai_compat is True
        assert meta.sdk_type == "openai"
        assert "ARK_API_KEY" in meta.fallback_api_key_envs
        assert "llm" in meta.capability_domains
        models = {
            item.model_name: item for item in (meta.static_models or ())
        }
        assert "doubao-seed-2-0-lite-260428" in models
        evolving = models["doubao-seed-evolving"]
        assert evolving.context_window_tokens == 1_048_576
        assert evolving.max_output_tokens == 262_144
        assert evolving.supports_vision is True
        assert evolving.supports_function_calling is True
        assert evolving.input_price_per_1k == 0.006
        assert evolving.output_price_per_1k == 0.03

    def test_service_class_resolves(self):
        cls = ProviderRegistry.get_service_class("volcengine")
        assert cls is not None
        assert cls.__name__ == "VolcengineService"

    def test_seed_evolving_migration_fallback_capabilities_are_valid(self):
        migration = import_module(
            "apps.services.llm.migrations.0050_add_doubao_seed_evolving"
        )
        model = SimpleNamespace(
            id="test-seed-evolving",
            model_name="doubao-seed-evolving",
            provider=SimpleNamespace(name="volcengine"),
            wave_status="ready",
            capabilities_config=migration.DOUBAO_CHAT_CAPABILITIES,
        )

        report = validate_model(model)

        assert report.errors == []
        assert report.warnings == []


class TestVolcengineLitellmResolve:
    def test_volces_base_url_maps_to_volcengine(self):
        """Ark base_url 优先解析为 LiteLLM 原生 volcengine（OpenAI-like）。"""
        provider = SimpleNamespace(name="volcengine", provider_key="volcengine")
        model = SimpleNamespace(
            base_url="https://ark.cn-beijing.volces.com/api/v3",
        )
        resolved = resolve_litellm_provider(
            provider,
            known_providers=get_litellm_provider_set(),
            model=model,
        )
        assert resolved == "volcengine"

    def test_provider_name_resolves_to_volcengine_without_base_url(self):
        provider = SimpleNamespace(name="volcengine", provider_key="volcengine")
        model = SimpleNamespace(base_url="")
        resolved = resolve_litellm_provider(
            provider,
            known_providers=get_litellm_provider_set(),
            model=model,
        )
        assert resolved == "volcengine"


class TestVolcengineTokenCounter:
    def test_volcengine_uses_tiktoken_without_warning_path(self):
        counter = TokenCounterFactory.create_counter("volcengine", "doubao-seed-2-0-lite-260428")
        assert isinstance(counter, TikTokenCounter)

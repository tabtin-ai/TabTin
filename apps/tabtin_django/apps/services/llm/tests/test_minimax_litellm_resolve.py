"""BYOK MiniMax Token Plan：LiteLLM 路由须走 Anthropic 兼容协议。"""

from __future__ import annotations

from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.services.llm.litellm_config import (
    compose_litellm_model_name,
    get_litellm_provider_set,
    resolve_litellm_provider,
)


class MiniMaxLitellmResolveTests(SimpleTestCase):
    def test_minimaxi_anthropic_url_maps_to_anthropic_when_minimax_absent(self):
        """复现  review：LiteLLM 1.79 运行时集合常无 minimax。"""
        known = {"openai", "anthropic", "custom_openai", "moonshot", "dashscope"}
        self.assertNotIn("minimax", known)

        provider = SimpleNamespace(name="minimax", provider_key="minimax_token_plan")
        model = SimpleNamespace(base_url="https://api.minimaxi.com/anthropic")

        resolved = resolve_litellm_provider(provider, known, model=model)

        self.assertEqual(resolved, "anthropic")

    def test_runtime_provider_set_resolves_minimax_token_plan_url(self):
        provider = SimpleNamespace(name="minimax", provider_key="minimax_token_plan")
        model = SimpleNamespace(base_url="https://api.minimaxi.com/anthropic")

        resolved = resolve_litellm_provider(
            provider,
            known_providers=get_litellm_provider_set(),
            model=model,
        )

        self.assertEqual(resolved, "anthropic")
        self.assertIsNotNone(resolved)

    def test_composed_runtime_config_gets_anthropic_provider(self):
        """生成的 litellm model + custom_llm_provider 应对齐 Anthropic 兼容路径。"""
        known = get_litellm_provider_set()
        provider = SimpleNamespace(name="minimax", provider_key="minimax_token_plan")
        model = SimpleNamespace(
            base_url="https://api.minimaxi.com/anthropic",
            model_name="MiniMax-M3",
        )
        litellm_provider = resolve_litellm_provider(provider, known, model=model)
        litellm_model = compose_litellm_model_name(
            model_name=model.model_name,
            litellm_provider=litellm_provider,
            known_providers=known,
        )

        self.assertEqual(litellm_provider, "anthropic")
        self.assertTrue(
            litellm_model.startswith("anthropic/") or litellm_model == "MiniMax-M3",
            litellm_model,
        )
        # 与 build_litellm_config 一致：有 provider 时会写入 custom_llm_provider
        runtime = {
            "model": litellm_model,
            "api_base": model.base_url,
            "custom_llm_provider": litellm_provider,
        }
        self.assertEqual(runtime["custom_llm_provider"], "anthropic")
        self.assertIn("minimaxi.com/anthropic", runtime["api_base"])

    def test_minimax_music_url_does_not_map_to_anthropic(self):
        known = {"openai", "anthropic", "custom_openai"}
        provider = SimpleNamespace(name="minimax_bgm", provider_key="minimax_bgm")
        model = SimpleNamespace(base_url="https://api.minimaxi.com/v1/music_generation")

        resolved = resolve_litellm_provider(provider, known, model=model)

        self.assertIsNone(resolved)

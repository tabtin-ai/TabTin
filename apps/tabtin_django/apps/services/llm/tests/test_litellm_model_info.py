from django.test import SimpleTestCase

from apps.services.llm.services.litellm_model_info import LiteLLMModelInfoService


class LiteLLMModelInfoServiceTestCase(SimpleTestCase):
    def test_extract_prompt_cache_pricing_converts_per_token_to_per_1k(self):
        pricing = LiteLLMModelInfoService.extract_prompt_cache_pricing({
            "cache_read_input_token_cost": 0.00000016,
            "cache_creation_input_token_cost": "0.000002625",
        })

        self.assertEqual(pricing["cache_read_input_price_per_1k"], 0.00016)
        self.assertEqual(pricing["cache_write_input_price_per_1k"], 0.002625)

    def test_extract_prompt_cache_pricing_ignores_negative_and_non_finite_values(self):
        pricing = LiteLLMModelInfoService.extract_prompt_cache_pricing({
            "cache_read_input_token_cost": "-0.01",
            "cache_creation_input_token_cost": "inf",
        })

        self.assertEqual(pricing, {})

    def test_extract_prompt_cache_pricing_uses_alias_fields(self):
        pricing = LiteLLMModelInfoService.extract_prompt_cache_pricing({
            "cache_read_input_token_cost": "nan",
            "cache_read_input_cost_per_token": "0.0000002",
            "cache_write_input_token_cost": "0.0000004",
        })

        self.assertEqual(pricing["cache_read_input_price_per_1k"], 0.0002)
        self.assertEqual(pricing["cache_write_input_price_per_1k"], 0.0004)

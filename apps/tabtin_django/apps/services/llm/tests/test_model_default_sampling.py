"""模型默认采样参数模式的 provider 回归测试。"""

from unittest.mock import patch

from django.test import SimpleTestCase


class ModelDefaultSamplingTests(SimpleTestCase):
    @patch("openai.OpenAI")
    def test_openai_omits_sampling_defaults_in_model_default_mode(self, mock_openai):
        from apps.services.llm.providers.openai.service import OpenAIService

        service = OpenAIService(
            {
                "name": "openai",
                "api_key": "sk-test-key",
                "base_url": "https://api.openai.com/v1",
                "model_name": "fixed-sampling-model",
            }
        )

        params = service._prepare_chat_params(
            [{"role": "user", "content": "hello"}],
            max_tokens=80,
            use_model_default_sampling=True,
        )

        for key in ("temperature", "top_p", "frequency_penalty", "presence_penalty"):
            self.assertNotIn(key, params)
        mock_openai.assert_called_once()

    @patch("anthropic.Anthropic")
    def test_minimax_omits_temperature_in_model_default_mode(self, mock_anthropic):
        from apps.services.llm.providers.minimax.service import MiniMaxService

        service = MiniMaxService(
            {
                "name": "minimax",
                "api_key": "sk-test-key",
                "base_url": "https://api.minimaxi.com/anthropic",
                "model_name": "fixed-sampling-model",
            }
        )

        params = service._prepare_chat_params(
            [{"role": "user", "content": "hello"}],
            max_tokens=80,
            thinking={"type": "disabled"},
            use_model_default_sampling=True,
        )

        self.assertNotIn("temperature", params)
        self.assertNotIn("top_p", params)
        mock_anthropic.assert_called_once()

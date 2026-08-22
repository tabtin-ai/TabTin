from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.llm.services.claude_service import ClaudeService


class ClaudeServiceTests(SimpleTestCase):
    @patch("openai.OpenAI")
    def test_claude_service_reuses_openai_prompt_cache_params(self, _mock_openai):
        service = ClaudeService(
            {
                "name": "claude",
                "api_key": "sk-ant-test",
                "base_url": "https://api.anthropic.com/v1",
                "model_name": "claude-3-5-sonnet-20240620",
            }
        )

        params = service._prepare_chat_params(
            [{"role": "user", "content": "hello"}],
            prompt_cache_key="ws:claude:1",
            prompt_cache_retention="24h",
        )

        self.assertEqual(params["model"], "claude-3-5-sonnet-20240620")
        self.assertEqual(params["extra_body"]["prompt_cache_key"], "ws:claude:1")
        self.assertEqual(params["extra_body"]["prompt_cache_retention"], "24h")

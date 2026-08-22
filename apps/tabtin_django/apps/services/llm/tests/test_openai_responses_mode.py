from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
import openai
from django.test import SimpleTestCase

from apps.services.llm.services.openai_service import OpenAIService


def _chat_response(content: str = "ok") -> SimpleNamespace:
    message = SimpleNamespace(content=content, tool_calls=None)
    choice = SimpleNamespace(message=message, finish_reason="stop")
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15)
    return SimpleNamespace(choices=[choice], usage=usage, model="gpt-4o")


class OpenAIResponsesModeTests(SimpleTestCase):
    def _build_service(self) -> OpenAIService:
        provider_config = {
            "name": "openai",
            "api_key": "sk-test",
            "base_url": "https://api.openai.com/v1",
            "model_name": "gpt-5",
            "max_retries": 0,
            "retry_delay": 0,
        }
        with patch("openai.OpenAI") as mock_openai:
            mock_openai.return_value = Mock()
            service = OpenAIService(provider_config)
        service.max_retries = 0
        service.retry_delay = 0
        return service

    def test_resolve_responses_mode_explicit(self):
        service = self._build_service()
        enabled, explicit = service._resolve_responses_api_mode({"api_variant": "responses"})
        self.assertTrue(enabled)
        self.assertTrue(explicit)

    def test_resolve_responses_mode_from_capability(self):
        service = self._build_service()
        service.model = SimpleNamespace(capabilities_config={"supports_responses_api": True})
        enabled, explicit = service._resolve_responses_api_mode({})
        self.assertTrue(enabled)
        self.assertFalse(explicit)

    def test_prepare_responses_params_maps_format_and_tools(self):
        service = self._build_service()
        params = service._prepare_responses_params(
            messages=[
                {"role": "system", "content": "你是助手"},
                {"role": "user", "content": "hi"},
            ],
            stream=True,
            max_tokens=256,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "person",
                    "strict": True,
                    "schema": {"type": "object", "properties": {"name": {"type": "string"}}},
                },
            },
            functions=[
                {
                    "name": "get_weather",
                    "description": "weather",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                }
            ],
            thinking={"effort": "high"},
            metadata={"trace_id": "t1"},
            prompt_cache_key="ws:1:chat",
            prompt_cache_retention="24h",
        )

        self.assertEqual(params["model"], "gpt-5")
        self.assertTrue(params["stream"])
        self.assertEqual(params["max_output_tokens"], 256)
        self.assertEqual(params["instructions"], "你是助手")
        self.assertEqual(params["input"][0]["role"], "user")
        self.assertEqual(params["text"]["format"]["type"], "json_schema")
        self.assertEqual(params["tools"][0]["name"], "get_weather")
        self.assertEqual(params["reasoning"]["effort"], "high")
        self.assertEqual(params["metadata"]["trace_id"], "t1")
        self.assertEqual(params["extra_body"]["prompt_cache_key"], "ws:1:chat")
        self.assertEqual(params["extra_body"]["prompt_cache_retention"], "24h")

    def test_prepare_chat_params_injects_prompt_cache_options(self):
        service = self._build_service()
        params = service._prepare_chat_params(
            [{"role": "user", "content": "hi"}],
            prompt_cache_key="user:abc",
            prompt_cache_retention="in_memory",
            extra_body={"foo": "bar"},
        )
        self.assertEqual(params["extra_body"]["foo"], "bar")
        self.assertEqual(params["extra_body"]["prompt_cache_key"], "user:abc")
        self.assertEqual(params["extra_body"]["prompt_cache_retention"], "in_memory")

    def test_prepare_chat_params_forwards_thinking_extra_body(self):
        service = self._build_service()
        params = service._prepare_chat_params(
            [{"role": "user", "content": "hi"}],
            thinking={"type": "disabled"},
        )
        self.assertEqual(params["extra_body"]["thinking"], {"type": "disabled"})

    def test_process_responses_chat_response_extracts_tool_calls(self):
        service = self._build_service()
        usage = SimpleNamespace(
            input_tokens=20,
            output_tokens=8,
            total_tokens=28,
            input_tokens_details=SimpleNamespace(cached_tokens=4),
            output_tokens_details=SimpleNamespace(reasoning_tokens=3),
        )
        output = [
            SimpleNamespace(
                type="function_call",
                id="fc_1",
                call_id="call_1",
                name="get_weather",
                arguments='{"city":"shanghai"}',
            ),
            SimpleNamespace(
                type="reasoning",
                encrypted_content="ENC",
                summary=[SimpleNamespace(type="summary_text", text="思考摘要")],
            ),
            SimpleNamespace(
                type="message",
                content=[SimpleNamespace(type="output_text", text="final answer")],
            ),
        ]
        response = SimpleNamespace(
            id="resp_1",
            model="gpt-5",
            status="completed",
            output=output,
            output_text="final answer",
            usage=usage,
        )

        result = service._process_responses_chat_response(response, start_time=0.0)
        self.assertTrue(result["success"])
        self.assertEqual(result["content"], "final answer")
        self.assertEqual(result["usage"]["cache_read_input_tokens"], 4)
        self.assertEqual(result["usage"]["reasoning_tokens"], 3)
        self.assertEqual(result["tool_calls"][0]["function"]["name"], "get_weather")
        self.assertEqual(result["response_id"], "resp_1")

    def test_implicit_responses_failure_falls_back_to_chat_completions(self):
        service = self._build_service()
        service.model = SimpleNamespace(capabilities_config={"supports_responses_api": True})

        request = httpx.Request("POST", "https://api.openai.com/v1/responses")
        response = httpx.Response(404, request=request)
        not_found = openai.NotFoundError("not found", response=response, body={"error": "not found"})

        service.client.responses.create = Mock(side_effect=not_found)
        service.client.chat.completions.create = Mock(return_value=_chat_response("fallback ok"))

        result = service._do_chat(messages=[{"role": "user", "content": "hi"}])
        self.assertTrue(result["success"])
        self.assertEqual(result["content"], "fallback ok")
        self.assertEqual(service.client.chat.completions.create.call_count, 1)

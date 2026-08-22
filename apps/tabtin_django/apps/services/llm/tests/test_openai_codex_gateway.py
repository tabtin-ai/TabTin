from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from apps.services.llm.services.openai_service import OpenAIService


class _FakeSSEResponse:
    def __init__(self, lines, status_code=200, text=""):
        self._lines = lines
        self.status_code = status_code
        self.text = text

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def iter_lines(self, decode_unicode=True):
        for line in self._lines:
            yield line


class OpenAICodexGatewayTests(SimpleTestCase):
    def _build_service(self) -> OpenAIService:
        provider_config = {
            "name": "codex",
            "api_key": "access-token",
            "base_url": "https://chatgpt.com/backend-api/codex",
            "model_name": "gpt-5-codex",
            "max_retries": 0,
            "retry_delay": 0,
        }
        with patch("openai.OpenAI") as mock_openai:
            mock_openai.return_value = Mock()
            service = OpenAIService(provider_config)
        service.max_retries = 0
        service.retry_delay = 0
        service._record_llm_event = Mock()
        return service

    @patch("apps.services.llm.services.openai_service.requests.post")
    def test_request_codex_response_json_builds_headers_and_url(self, mock_post):
        service = self._build_service()
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": "resp_1",
            "model": "gpt-5-codex",
            "output_text": "ok",
            "output": [],
            "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        }
        mock_post.return_value = mock_response

        result = service._request_codex_response_json(
            {"model": "gpt-5-codex", "input": [{"role": "user", "content": []}]},
            kwargs={"codex_originator": "tabtin-tests", "codex_account_id": "acc_1"},
        )

        self.assertEqual(result["id"], "resp_1")
        self.assertEqual(mock_post.call_count, 1)
        args, kwargs = mock_post.call_args
        self.assertEqual(args[0], "https://chatgpt.com/backend-api/codex/responses")
        headers = kwargs.get("headers") or {}
        self.assertEqual(headers.get("Authorization"), "Bearer access-token")
        self.assertEqual(headers.get("originator"), "tabtin-tests")
        self.assertEqual(headers.get("ChatGPT-Account-Id"), "acc_1")
        self.assertTrue(headers.get("session_id"))

    def test_resolve_codex_access_token_uses_static_token(self):
        service = self._build_service()
        token = service._resolve_codex_access_token({"codex_access_token": "Bearer custom-token"})
        self.assertEqual(token, "custom-token")

    @patch("apps.services.llm.services.openai_service.requests.post")
    def test_iter_codex_sse_events_parses_lines(self, mock_post):
        service = self._build_service()
        mock_post.return_value = _FakeSSEResponse(
            lines=[
                "event: message",
                'data: {"type":"response.output_text.delta","delta":"he"}',
                'data: {"type":"response.output_text.delta","delta":"llo"}',
                "data: [DONE]",
            ],
            status_code=200,
        )

        events = list(
            service._iter_codex_sse_events(
                {"model": "gpt-5-codex", "stream": True, "input": [{"role": "user", "content": []}]},
                kwargs={},
            )
        )
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["delta"], "he")
        self.assertEqual(events[1]["delta"], "llo")

    def test_chat_stream_uses_websocket_transport_when_configured(self):
        service = self._build_service()
        ws_events = iter(
            [
                {"type": "response.output_text.delta", "delta": "Hello"},
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_2",
                        "usage": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3},
                        "output": [
                            {
                                "type": "message",
                                "content": [{"type": "output_text", "text": "Hello"}],
                            }
                        ],
                    },
                },
            ]
        )

        with patch.object(service, "_iter_codex_websocket_events", return_value=ws_events) as mock_ws:
            chunks = list(
                service.chat_stream(
                    [{"role": "user", "content": "hi"}],
                    api_variant="responses",
                    codex_gateway=True,
                    codex_transport="websocket",
                )
            )

        self.assertTrue(mock_ws.called)
        self.assertEqual(chunks[0].get("content"), "Hello")
        self.assertTrue(chunks[-1].get("finished"))
        self.assertEqual(chunks[-1].get("response_id"), "resp_2")

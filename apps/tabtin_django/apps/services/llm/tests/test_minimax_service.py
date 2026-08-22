from contextlib import contextmanager
from unittest.mock import patch, MagicMock
import time
import uuid
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase

from ..models import LLMProvider
from ..services.factory import LLMServiceFactory
from ..services.minimax_service import MiniMaxService


class _FakeUsage:
    input_tokens = 120
    output_tokens = 30
    cache_creation_input_tokens = 0
    cache_read_input_tokens = 90


class _FakeTextBlock:
    type = "text"
    text = "hello from minimax"


class _FakeToolUseBlock:
    type = "tool_use"
    id = "toolu_abc123"
    name = "get_weather"
    input = {"location": "Beijing"}


class _FakeThinkingBlock:
    type = "thinking"
    thinking = "Let me think about this step by step..."


class _FakeResponse:
    model = "MiniMax-M2.5"
    stop_reason = "end_turn"
    usage = _FakeUsage()
    content = [_FakeTextBlock()]


class _FakeStreamContext:
    """模拟 Anthropic SDK MessageStream 上下文管理器。"""

    def __init__(self, text_chunks, final_message):
        self._text_chunks = text_chunks
        self._final_message = final_message

    @property
    def text_stream(self):
        yield from self._text_chunks

    def get_final_message(self):
        return self._final_message

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class MiniMaxServiceTestCase(SimpleTestCase):
    def test_provider_choices_include_minimax(self):
        provider_names = {item[0] for item in LLMProvider.get_provider_choices()}
        self.assertIn("minimax", provider_names)

    def test_factory_reports_minimax_supported(self):
        self.assertIn("minimax", LLMServiceFactory.get_supported_providers())

    @patch("anthropic.Anthropic")
    def test_create_minimax_service(self, mock_anthropic_client):
        config = {
            "name": "minimax",
            "api_key": "sk-test-key",
            "base_url": "https://api.minimaxi.com/anthropic",
        }

        service = LLMServiceFactory.create_service("minimax", config)

        self.assertIsInstance(service, MiniMaxService)
        self.assertEqual(service.default_model, "MiniMax-M2.5")
        mock_anthropic_client.assert_called_once_with(
            api_key="sk-test-key",
            auth_token="sk-test-key",
            base_url="https://api.minimaxi.com/anthropic",
        )

    @patch("anthropic.Anthropic")
    def test_response_usage_contains_prompt_cache_metrics(self, mock_anthropic_client):
        config = {
            "name": "minimax",
            "api_key": "sk-test-key",
            "base_url": "https://api.minimaxi.com/anthropic",
            "model_name": "MiniMax-M2.5",
        }
        service = MiniMaxService(config)
        result = service._process_chat_response(_FakeResponse(), time.time())

        self.assertTrue(result["success"])
        self.assertEqual(result["content"], "hello from minimax")
        self.assertEqual(result["usage"]["input_tokens"], 120)
        self.assertEqual(result["usage"]["output_tokens"], 30)
        self.assertEqual(result["usage"]["total_tokens"], 150)
        self.assertEqual(result["usage"]["cache_read_input_tokens"], 90)
        self.assertFalse(result["usage"]["input_tokens_include_cache"])

    @patch("anthropic.Anthropic")
    def test_json_mode_appends_system_hint(self, mock_anthropic_client):
        config = {
            "name": "minimax",
            "api_key": "sk-test-key",
            "base_url": "https://api.minimaxi.com/anthropic",
        }
        service = MiniMaxService(config)
        params = service._prepare_chat_params(
            [{"role": "user", "content": "请按 JSON 输出"}],
            response_format="json_object",
        )
        self.assertIn("JSON Object", params.get("system", ""))

    @patch("anthropic.Anthropic")
    def test_rate_limit_guard_blocks_excess_calls(self, mock_anthropic_client):
        provider_obj = SimpleNamespace(
            id=f"provider-{uuid.uuid4()}",
            display_name="minimax official",
            rate_limit=1,
        )
        mock_anthropic_client.return_value.messages.create.return_value = _FakeResponse()
        service = MiniMaxService({
            "name": "minimax",
            "api_key": "sk-test-key",
            "base_url": "https://api.minimaxi.com/anthropic",
            "provider_obj": provider_obj,
        })

        first = service.chat([{"role": "user", "content": "hi"}])
        second = service.chat([{"role": "user", "content": "hi again"}])

        self.assertTrue(first["success"])
        self.assertFalse(second["success"])
        self.assertEqual(second["error_code"], "RATE_LIMIT")
        self.assertEqual(second["status_code"], 429)
        self.assertEqual(mock_anthropic_client.return_value.messages.create.call_count, 1)

    @patch("anthropic.Anthropic")
    def test_cost_calculation_uses_model_and_cache_pricing(self, mock_anthropic_client):
        service = MiniMaxService({
            "name": "minimax",
            "api_key": "sk-test-key",
            "base_url": "https://api.minimaxi.com/anthropic",
            "input_price_per_1k": 0.0021,
            "output_price_per_1k": 0.0084,
            "custom_billing_config": {
                "cache_read_input_price_per_1k": "0.00021",
                "cache_write_input_price_per_1k": "0.002625",
            },
        })

        cost = service._calculate_cost_from_usage({
            "input_tokens": 1000,
            "output_tokens": 500,
            "cache_read_input_tokens": 1000,
            "cache_creation_input_tokens": 500,
            "input_tokens_include_cache": False,
        })

        self.assertEqual(cost["input_cost"], Decimal("0.0021"))
        self.assertEqual(cost["output_cost"], Decimal("0.0042"))
        self.assertEqual(cost["cache_read_cost"], Decimal("0.00021"))
        self.assertEqual(cost["cache_write_cost"], Decimal("0.0013125"))
        self.assertEqual(cost["total_cost"], Decimal("0.0078225"))

    # ── PROV-6 回归：流式模式必须提取 tool_calls ──

    @patch("anthropic.Anthropic")
    def test_chat_stream_extracts_tool_calls_from_final_message(self, mock_anthropic_cls):
        """PROV-6 回归：chat_stream 的 final_chunk 必须包含 tool_calls。"""
        final_msg = SimpleNamespace(
            model="MiniMax-M2.5",
            stop_reason="tool_use",
            usage=_FakeUsage(),
            content=[_FakeTextBlock(), _FakeToolUseBlock()],
        )
        stream_ctx = _FakeStreamContext(["hello"], final_msg)
        mock_client = mock_anthropic_cls.return_value
        mock_client.messages.stream = MagicMock(return_value=stream_ctx)

        service = MiniMaxService({
            "name": "minimax",
            "api_key": "sk-test",
            "base_url": "https://api.minimaxi.com/anthropic",
        })

        chunks = list(service.chat_stream([{"role": "user", "content": "call a tool"}]))
        final_chunk = chunks[-1]

        self.assertTrue(final_chunk["finished"])
        self.assertIn("tool_calls", final_chunk)
        self.assertEqual(len(final_chunk["tool_calls"]), 1)
        tc = final_chunk["tool_calls"][0]
        self.assertEqual(tc["function"]["name"], "get_weather")
        self.assertEqual(tc["id"], "toolu_abc123")
        self.assertEqual(final_chunk["finish_reason"], "tool_calls")

    # ── PROV-7 回归：流式模式必须提取 reasoning_details ──

    @patch("anthropic.Anthropic")
    def test_chat_stream_extracts_reasoning_details_from_final_message(self, mock_anthropic_cls):
        """PROV-7 回归：chat_stream 的 final_chunk 必须包含 reasoning_details。"""
        final_msg = SimpleNamespace(
            model="MiniMax-M2.5",
            stop_reason="end_turn",
            usage=_FakeUsage(),
            content=[_FakeThinkingBlock(), _FakeTextBlock()],
        )
        stream_ctx = _FakeStreamContext(["hello"], final_msg)
        mock_client = mock_anthropic_cls.return_value
        mock_client.messages.stream = MagicMock(return_value=stream_ctx)

        service = MiniMaxService({
            "name": "minimax",
            "api_key": "sk-test",
            "base_url": "https://api.minimaxi.com/anthropic",
        })

        chunks = list(service.chat_stream([{"role": "user", "content": "think about this"}]))
        final_chunk = chunks[-1]

        self.assertTrue(final_chunk["finished"])
        self.assertIn("reasoning_details", final_chunk)
        self.assertEqual(len(final_chunk["reasoning_details"]), 1)
        self.assertEqual(final_chunk["reasoning_details"][0]["type"], "reasoning.text")
        self.assertIn("step by step", final_chunk["reasoning_details"][0]["text"])

    @patch("anthropic.Anthropic")
    def test_chat_stream_no_tool_calls_when_text_only(self, mock_anthropic_cls):
        """纯文本流式响应不应包含 tool_calls 或 reasoning_details。"""
        final_msg = SimpleNamespace(
            model="MiniMax-M2.5",
            stop_reason="end_turn",
            usage=_FakeUsage(),
            content=[_FakeTextBlock()],
        )
        stream_ctx = _FakeStreamContext(["hello from minimax"], final_msg)
        mock_client = mock_anthropic_cls.return_value
        mock_client.messages.stream = MagicMock(return_value=stream_ctx)

        service = MiniMaxService({
            "name": "minimax",
            "api_key": "sk-test",
            "base_url": "https://api.minimaxi.com/anthropic",
        })

        chunks = list(service.chat_stream([{"role": "user", "content": "hi"}]))
        final_chunk = chunks[-1]

        self.assertTrue(final_chunk["finished"])
        self.assertNotIn("tool_calls", final_chunk)
        self.assertNotIn("reasoning_details", final_chunk)
        self.assertEqual(final_chunk["finish_reason"], "stop")

    @patch("anthropic.Anthropic")
    def test_extract_tool_calls_from_content_blocks(self, mock_anthropic_cls):
        """_extract_tool_calls_from_content_blocks 单元测试。"""
        blocks = [_FakeTextBlock(), _FakeToolUseBlock()]
        result = MiniMaxService._extract_tool_calls_from_content_blocks(blocks)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "toolu_abc123")
        self.assertEqual(result[0]["type"], "function")
        self.assertEqual(result[0]["function"]["name"], "get_weather")
        self.assertIn("Beijing", result[0]["function"]["arguments"])

    @patch("anthropic.Anthropic")
    def test_extract_tool_calls_empty_on_no_tool_use(self, mock_anthropic_cls):
        """没有 tool_use 块时返回空列表。"""
        blocks = [_FakeTextBlock()]
        result = MiniMaxService._extract_tool_calls_from_content_blocks(blocks)
        self.assertEqual(result, [])

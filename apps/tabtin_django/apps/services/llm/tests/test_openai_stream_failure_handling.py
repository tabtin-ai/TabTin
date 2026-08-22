"""
PROV-1 / PROV-2 回归测试
- PROV-1: response.failed / response.incomplete 事件不再被静默忽略
- PROV-2: Responses API 流式回退不再在已发出 chunks 后叠加 Chat Completions 响应
"""

from types import SimpleNamespace
from unittest.mock import Mock, patch, MagicMock

from django.test import SimpleTestCase

from apps.services.llm.services.openai_service import OpenAIService


def _build_service() -> OpenAIService:
    provider_config = {
        "name": "openai",
        "api_key": "sk-test",
        "base_url": "https://api.openai.com/v1",
        "model_name": "gpt-4o",
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


def _make_event(event_type: str, **kwargs) -> dict:
    event = {"type": event_type}
    event.update(kwargs)
    return event


# ---------------------------------------------------------------------------
# PROV-1: response.failed 处理
# ---------------------------------------------------------------------------
class TestResponseFailedEvent(SimpleTestCase):
    """response.failed 事件必须产出 success=False 的错误 chunk 并中止流。"""

    def test_response_failed_yields_error_chunk(self):
        service = _build_service()

        events = [
            _make_event("response.output_text.delta", delta="Hello"),
            _make_event(
                "response.failed",
                response={
                    "id": "resp_fail_1",
                    "status": "failed",
                    "error": {"type": "server_error", "message": "内部处理错误"},
                    "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
                    "output": [],
                },
            ),
        ]

        chunks = list(
            service._stream_responses_events(
                stream=iter(events),
                messages=[{"role": "user", "content": "hi"}],
                params={"model": "gpt-4o"},
                start_time=0.0,
            )
        )

        self.assertTrue(len(chunks) >= 2, f"Expected at least 2 chunks, got {len(chunks)}")

        text_chunk = chunks[0]
        self.assertTrue(text_chunk["success"])
        self.assertEqual(text_chunk["content"], "Hello")

        error_chunk = chunks[-1]
        self.assertFalse(error_chunk["success"])
        self.assertTrue(error_chunk["finished"])
        self.assertEqual(error_chunk["finish_reason"], "error")
        self.assertIn("内部处理错误", error_chunk["error"])
        self.assertEqual(error_chunk.get("response_id"), "resp_fail_1")

        service._record_llm_event.assert_called_once()
        recorded = service._record_llm_event.call_args
        self.assertFalse(recorded.kwargs.get("result", recorded[1].get("result", {})).get("success", True))

    def test_response_failed_without_prior_content(self):
        service = _build_service()

        events = [
            _make_event(
                "response.failed",
                response={
                    "id": "resp_fail_2",
                    "status": "failed",
                    "error": {"type": "rate_limit", "message": "Rate limit exceeded"},
                    "usage": None,
                    "output": [],
                },
            ),
        ]

        chunks = list(
            service._stream_responses_events(
                stream=iter(events),
                messages=[{"role": "user", "content": "hi"}],
                params={"model": "gpt-4o"},
                start_time=0.0,
            )
        )

        self.assertEqual(len(chunks), 1)
        self.assertFalse(chunks[0]["success"])
        self.assertIn("Rate limit", chunks[0]["error"])

    def test_response_failed_no_response_obj(self):
        """response.failed 事件缺少 response 字段时仍应产出错误 chunk。"""
        service = _build_service()

        events = [_make_event("response.failed")]

        chunks = list(
            service._stream_responses_events(
                stream=iter(events),
                messages=[{"role": "user", "content": "hi"}],
                params={"model": "gpt-4o"},
                start_time=0.0,
            )
        )

        self.assertEqual(len(chunks), 1)
        self.assertFalse(chunks[0]["success"])
        self.assertTrue(chunks[0]["finished"])


# ---------------------------------------------------------------------------
# PROV-1: response.incomplete 处理
# ---------------------------------------------------------------------------
class TestResponseIncompleteEvent(SimpleTestCase):
    """response.incomplete 事件必须以 finish_reason='length' 正常完成流。"""

    def test_response_incomplete_yields_length_finish(self):
        service = _build_service()

        events = [
            _make_event("response.output_text.delta", delta="Partial "),
            _make_event("response.output_text.delta", delta="content"),
            _make_event(
                "response.incomplete",
                response={
                    "id": "resp_inc_1",
                    "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"},
                    "usage": {"input_tokens": 50, "output_tokens": 100, "total_tokens": 150},
                    "output": [],
                    "output_text": None,
                },
            ),
        ]

        chunks = list(
            service._stream_responses_events(
                stream=iter(events),
                messages=[{"role": "user", "content": "长文档..."}],
                params={"model": "gpt-4o"},
                start_time=0.0,
            )
        )

        text_chunks = [c for c in chunks if c.get("content")]
        final = chunks[-1]

        self.assertEqual(len(text_chunks), 2)
        self.assertTrue(final["success"])
        self.assertTrue(final["finished"])
        self.assertEqual(final["finish_reason"], "length")
        self.assertEqual(final["usage"]["total_tokens"], 150)
        self.assertEqual(final.get("response_id"), "resp_inc_1")

    def test_response_incomplete_extracts_remaining_output(self):
        """response.incomplete 时如果之前没收到 delta，从 response.output 提取内容。"""
        service = _build_service()

        output_item = {
            "type": "message",
            "content": [{"type": "output_text", "text": "extracted from output"}],
        }

        events = [
            _make_event(
                "response.incomplete",
                response={
                    "id": "resp_inc_2",
                    "status": "incomplete",
                    "incomplete_details": {"reason": "content_filter"},
                    "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
                    "output": [output_item],
                    "output_text": "extracted from output",
                },
            ),
        ]

        chunks = list(
            service._stream_responses_events(
                stream=iter(events),
                messages=[{"role": "user", "content": "test"}],
                params={"model": "gpt-4o"},
                start_time=0.0,
            )
        )

        final = chunks[-1]
        self.assertTrue(final["success"])
        self.assertEqual(final["finish_reason"], "length")

        recorded = service._record_llm_event.call_args
        result = recorded.kwargs.get("result") or recorded[1].get("result", {})
        self.assertIn("extracted from output", result.get("content", ""))


# ---------------------------------------------------------------------------
# PROV-1: response.completed 正常流应保持 finish_reason='stop'
# ---------------------------------------------------------------------------
class TestResponseCompletedNormal(SimpleTestCase):
    """正常完成的流应保持 finish_reason='stop'。"""

    def test_normal_completion_has_stop_finish_reason(self):
        service = _build_service()

        events = [
            _make_event("response.output_text.delta", delta="OK"),
            _make_event(
                "response.completed",
                response={
                    "id": "resp_ok",
                    "status": "completed",
                    "usage": {"input_tokens": 5, "output_tokens": 1, "total_tokens": 6},
                    "output": [],
                    "output_text": "OK",
                },
            ),
        ]

        chunks = list(
            service._stream_responses_events(
                stream=iter(events),
                messages=[{"role": "user", "content": "test"}],
                params={"model": "gpt-4o"},
                start_time=0.0,
            )
        )

        final = chunks[-1]
        self.assertTrue(final["success"])
        self.assertEqual(final["finish_reason"], "stop")


# ---------------------------------------------------------------------------
# PROV-2: 流式回退不再在已发出 chunks 后产生重复内容
# ---------------------------------------------------------------------------
class TestStreamFallbackNoContentDuplication(SimpleTestCase):
    """已 yield chunks 后异常不应回退到 Chat Completions，而应产出错误 chunk。"""

    def test_no_fallback_after_yielded_chunks(self):
        service = _build_service()
        service.model = SimpleNamespace(capabilities_config={"supports_responses_api": True})

        def _failing_stream():
            yield _make_event("response.output_text.delta", delta="partial")
            raise RuntimeError("connection reset")

        original_stream_events = service._stream_responses_events

        def _patched_stream_events(**kwargs):
            kwargs["stream"] = _failing_stream()
            return original_stream_events(**kwargs)

        service._stream_responses_events = _patched_stream_events
        service.client.responses.create = Mock(return_value=iter([]))
        service.client.chat.completions.create = Mock()

        chunks = list(
            service.chat_stream(
                messages=[{"role": "user", "content": "hi"}],
                api_variant="responses",
            )
        )

        service.client.chat.completions.create.assert_not_called()

        errors = [c for c in chunks if c.get("success") is False or c.get("error")]
        self.assertTrue(len(errors) >= 1, "Should contain at least one error chunk")

        contents = "".join(c.get("content", "") for c in chunks)
        self.assertEqual(contents.count("partial"), 1, "Content should not be duplicated")

    def test_fallback_allowed_when_no_chunks_yielded(self):
        """stream 创建阶段异常（无 yield）时，仍允许回退到 Chat Completions。"""
        service = _build_service()
        service.model = SimpleNamespace(capabilities_config={"supports_responses_api": True})

        import httpx
        import openai as openai_mod
        request = httpx.Request("POST", "https://api.openai.com/v1/responses")
        response = httpx.Response(404, request=request)
        not_found = openai_mod.NotFoundError("not found", response=response, body={"error": "not found"})

        service.client.responses.create = Mock(side_effect=not_found)

        def _stream_chunk(content="", finish_reason=None, usage=None):
            delta = SimpleNamespace(content=content, tool_calls=None)
            choice = SimpleNamespace(delta=delta, finish_reason=finish_reason)
            chunk = SimpleNamespace(choices=[choice], usage=usage, model="gpt-4o")
            return chunk

        stream_chunks = [
            _stream_chunk(content="fallback ok"),
            _stream_chunk(
                content="",
                finish_reason="stop",
                usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15),
            ),
        ]
        service.client.chat.completions.create = Mock(return_value=iter(stream_chunks))

        chunks = list(
            service.chat_stream(messages=[{"role": "user", "content": "hi"}])
        )

        service.client.chat.completions.create.assert_called()

        all_content = "".join(c.get("content", "") for c in chunks)
        self.assertIn("fallback ok", all_content)

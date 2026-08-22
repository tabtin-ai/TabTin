"""
Wave 1 F1: BaseLLMService + ContentPruner P0 修复回归测试。

覆盖问题: FND-04, FND-05, BASE-1, BASE-2, BASE-3, BASE-4, BASE-5
"""

import re
from unittest.mock import patch, MagicMock
from decimal import Decimal

from django.test import TestCase

from ..services.base import BaseLLMService, _OVERFLOW_PATTERNS
from ..utils.content_pruner import SimpleContentPruner


# ── 测试辅助 ──

class _StubService(BaseLLMService):
    """不依赖 DB 的基类测试桩。"""

    def _do_chat(self, messages, **kwargs):
        return {
            "success": True,
            "content": "ok",
            "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        }

    def _do_chat_stream(self, messages, **kwargs):
        yield {"success": True, "content": "", "finished": True}

    def _validate_connection(self):
        return {"valid": True, "details": {}}


def _make_stub(**overrides):
    config = {
        "name": "test",
        "api_key": "sk-test",
        "base_url": "https://test.example.com",
        "model_name": "test-model",
        "max_retries": 0,
        "retry_delay": 0,
        "provider_obj": None,
        "model_obj": None,
    }
    config.update(overrides)
    return _StubService(config)


class _ExplodingChatService(BaseLLMService):
    """_do_chat 总是抛异常的测试桩。"""

    def _do_chat(self, messages, **kwargs):
        raise RuntimeError("provider blew up")

    def _do_chat_stream(self, messages, **kwargs):
        yield {"success": True, "content": "", "finished": True}

    def _validate_connection(self):
        return {"valid": True, "details": {}}


class _RateLimitedService(BaseLLMService):
    """模拟渠道限流触发的服务桩。"""

    def _do_chat(self, messages, **kwargs):
        return {"success": True, "content": "ok"}

    def _do_chat_stream(self, messages, **kwargs):
        yield {"success": True, "content": "streamed", "finished": True}

    def _validate_connection(self):
        return {"valid": True, "details": {}}


# ── FND-04: resource exhausted 不应被当做 TOKEN_LIMIT ──

class TestFND04ResourceExhausted(TestCase):

    def test_resource_exhausted_not_in_overflow_patterns(self):
        text = "RESOURCE_EXHAUSTED: 429 Too Many Requests"
        matched = any(p.search(text) for p in _OVERFLOW_PATTERNS)
        self.assertFalse(matched, "resource exhausted 不应匹配 _OVERFLOW_PATTERNS")

    def test_is_token_limit_error_rejects_resource_exhausted(self):
        svc = _make_stub()
        result = {
            "success": False,
            "error": "resource exhausted: quota limit reached",
            "error_code": "RATE_LIMIT",
            "status_code": 429,
        }
        self.assertFalse(svc._is_token_limit_error(result))


# ── FND-05: max tokens 正则不应匹配限流文本 ──

class TestFND05MaxTokensRegex(TestCase):

    def test_max_tokens_per_min_not_matched(self):
        text = "max tokens per min exceeded"
        matched = any(p.search(text) for p in _OVERFLOW_PATTERNS)
        self.assertFalse(matched, "'max tokens per min' 不应匹配")

    def test_max_tokens_per_minute_not_matched(self):
        text = "max tokens per minute reached"
        matched = any(p.search(text) for p in _OVERFLOW_PATTERNS)
        self.assertFalse(matched, "'max tokens per minute' 不应匹配")

    def test_max_tokens_exceeded_still_matched(self):
        text = "Maximum number of max tokens exceeded"
        matched = any(p.search(text) for p in _OVERFLOW_PATTERNS)
        self.assertTrue(matched, "合法的 max tokens 超限应匹配")

    def test_max_tokens_field_error_matched(self):
        text = "max_tokens is too large: 32000"
        matched = any(p.search(text) for p in _OVERFLOW_PATTERNS)
        self.assertTrue(matched, "max_tokens 字段错误应匹配")

    def test_is_token_limit_error_rejects_rate_limit_text(self):
        svc = _make_stub()
        result = {
            "success": False,
            "error": "max tokens per min exceeded, please retry after 60s",
            "error_code": "RATE_LIMIT",
        }
        self.assertFalse(svc._is_token_limit_error(result))


# ── BASE-1: chat_stream() 应包含限流和截断保护 ──

class TestBASE1ChatStreamProtections(TestCase):

    def test_chat_stream_rate_limit_protection(self):
        svc = _RateLimitedService({
            "name": "test", "api_key": "k", "base_url": "http://x",
            "model_name": "m", "max_retries": 0, "retry_delay": 0,
            "provider_obj": None, "model_obj": None,
        })
        with patch.object(svc, '_check_provider_rate_limit', return_value={
            "success": False, "error": "rate limited", "error_code": "RATE_LIMIT",
        }):
            chunks = list(svc.chat_stream([{"role": "user", "content": "hi"}]))

        self.assertEqual(len(chunks), 1)
        self.assertFalse(chunks[0]["success"])
        self.assertEqual(chunks[0]["error_code"], "RATE_LIMIT")
        self.assertTrue(chunks[0].get("finished"))

    def test_chat_stream_truncation_protection(self):
        svc = _make_stub(context_window_tokens=100, max_output_tokens=50)
        with patch.object(svc, '_check_and_truncate_messages', side_effect=ValueError("超限")):
            chunks = list(svc.chat_stream([{"role": "user", "content": "hi"}]))

        self.assertEqual(len(chunks), 1)
        self.assertFalse(chunks[0]["success"])
        self.assertEqual(chunks[0]["error_code"], "TOKEN_LIMIT")

    def test_chat_stream_calls_do_chat_stream(self):
        svc = _make_stub()
        chunks = list(svc.chat_stream([{"role": "user", "content": "hi"}]))
        self.assertTrue(any(c.get("finished") for c in chunks))

    def test_chat_stream_catches_do_chat_stream_exception(self):
        svc = _make_stub()
        with patch.object(svc, '_do_chat_stream', side_effect=RuntimeError("boom")):
            chunks = list(svc.chat_stream([{"role": "user", "content": "hi"}]))

        self.assertEqual(len(chunks), 1)
        self.assertFalse(chunks[0]["success"])
        self.assertTrue(chunks[0].get("finished"))


# ── BASE-2: tool 角色消息不应被丢弃 ──

class TestBASE2ToolMessagesPreserved(TestCase):

    def test_tool_messages_not_dropped(self):
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "What is the weather?"},
            {"role": "assistant", "content": "calling tool"},
            {"role": "tool", "content": '{"temp": 72}'},
            {"role": "assistant", "content": "It is 72F"},
        ]
        pruner = SimpleContentPruner("openai", "gpt-4")
        total_tokens = pruner.token_counter.count_messages_tokens(messages)
        result = pruner.prune_messages(messages, total_tokens)

        roles = [m['role'] for m in result]
        self.assertIn('tool', roles, "tool 消息不应被丢弃")

    def test_tool_messages_preserved_after_pruning(self):
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "long " * 200},
            {"role": "assistant", "content": "calling tool"},
            {"role": "tool", "content": '{"result": "ok"}'},
            {"role": "user", "content": "short"},
            {"role": "assistant", "content": "done"},
        ]
        pruner = SimpleContentPruner("openai", "gpt-4")
        result = pruner.prune_messages(messages, 100)

        roles = [m['role'] for m in result]
        self.assertIn('tool', roles, "裁剪后 tool 消息不应消失")


# ── BASE-3: chat() 应捕获 _do_chat() 异常 ──

class TestBASE3ChatExceptionHandling(TestCase):

    def test_chat_catches_do_chat_exception(self):
        svc = _ExplodingChatService({
            "name": "test", "api_key": "k", "base_url": "http://x",
            "model_name": "m", "max_retries": 0, "retry_delay": 0,
            "provider_obj": None, "model_obj": None,
        })
        result = svc.chat([{"role": "user", "content": "hi"}])

        self.assertIsInstance(result, dict)
        self.assertFalse(result.get("success"))
        self.assertIn("error", result)

    def test_chat_does_not_raise_on_exception(self):
        svc = _ExplodingChatService({
            "name": "test", "api_key": "k", "base_url": "http://x",
            "model_name": "m", "max_retries": 0, "retry_delay": 0,
            "provider_obj": None, "model_obj": None,
        })
        try:
            result = svc.chat([{"role": "user", "content": "test"}])
        except Exception:
            self.fail("chat() 不应向上传播异常")


# ── BASE-4: 多模态 content 为 list 时不应抛 TypeError ──

class TestBASE4MultimodalContent(TestCase):

    def test_prune_content_handles_list(self):
        pruner = SimpleContentPruner("openai", "gpt-4")
        content = [
            {"type": "text", "text": "Hello " * 500},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc123"}},
        ]
        try:
            result = pruner.prune_content(content, 50)
        except TypeError:
            self.fail("prune_content 不应对 list content 抛 TypeError")

        self.assertIsInstance(result, list)

    def test_prune_content_list_preserves_non_text_parts(self):
        pruner = SimpleContentPruner("openai", "gpt-4")
        content = [
            {"type": "text", "text": "Hello " * 500},
            {"type": "image_url", "image_url": {"url": "http://example.com/img.png"}},
        ]
        result = pruner.prune_content(content, 50)

        has_image = any(
            isinstance(p, dict) and p.get('type') == 'image_url'
            for p in result
        )
        self.assertTrue(has_image, "非文本部分应被保留")

    def test_prune_messages_with_multimodal_no_crash(self):
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": [
                {"type": "text", "text": "Describe this image " * 100},
                {"type": "image_url", "image_url": {"url": "http://example.com/img.png"}},
            ]},
            {"role": "assistant", "content": "It's a photo"},
        ]
        pruner = SimpleContentPruner("openai", "gpt-4")
        try:
            result = pruner.prune_messages(messages, 50)
        except TypeError:
            self.fail("prune_messages 不应对 list content 抛 TypeError")

    def test_prune_content_list_without_text_returns_original(self):
        pruner = SimpleContentPruner("openai", "gpt-4")
        content = [
            {"type": "image_url", "image_url": {"url": "http://example.com/img.png"}},
        ]
        result = pruner.prune_content(content, 10)
        self.assertEqual(result, content)


# ── BASE-5: prune_messages 不应在第一条超限消息后丢弃所有后续消息 ──

class TestBASE5PruneMessagesContinue(TestCase):

    def test_small_messages_after_large_one_preserved(self):
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "a " * 5000},
            {"role": "assistant", "content": "huge " * 5000},
            {"role": "user", "content": "tiny"},
            {"role": "assistant", "content": "small"},
        ]
        pruner = SimpleContentPruner("openai", "gpt-4")
        result = pruner.prune_messages(messages, 200)

        non_system = [m for m in result if m['role'] != 'system']
        self.assertTrue(
            len(non_system) >= 2,
            f"应保留多条小消息，但只保留了 {len(non_system)} 条非系统消息"
        )

    def test_does_not_break_on_first_oversized(self):
        messages = [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "x " * 3000},
            {"role": "assistant", "content": "y " * 3000},
            {"role": "user", "content": "final"},
        ]
        pruner = SimpleContentPruner("openai", "gpt-4")
        result = pruner.prune_messages(messages, 100)

        contents = [m.get('content', '') for m in result]
        has_final = any('final' in str(c) for c in contents)
        self.assertTrue(has_final, "最后的小消息 'final' 应被保留")


# ── 排序兼容性：list content 不应导致排序崩溃 ──

class TestSortMessagesByOriginalOrder(TestCase):

    def test_sort_handles_list_content(self):
        pruner = SimpleContentPruner("openai", "gpt-4")
        original = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": [{"type": "text", "text": "hello"}]},
            {"role": "assistant", "content": "world"},
        ]
        result = [
            {"role": "assistant", "content": "world"},
            {"role": "system", "content": "sys"},
            {"role": "user", "content": [{"type": "text", "text": "hello"}]},
        ]
        try:
            sorted_msgs = pruner._sort_messages_by_original_order(result, original)
        except TypeError:
            self.fail("排序不应对 list content 抛 TypeError")

        self.assertEqual(sorted_msgs[0]["role"], "system")

    def test_sort_handles_none_content(self):
        pruner = SimpleContentPruner("openai", "gpt-4")
        original = [
            {"role": "tool", "content": None},
            {"role": "user", "content": "hi"},
        ]
        result = list(reversed(original))
        try:
            sorted_msgs = pruner._sort_messages_by_original_order(result, original)
        except (TypeError, AttributeError):
            self.fail("排序不应对 None content 崩溃")

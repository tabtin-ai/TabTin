"""_parse_usage_from_sse — usage 语义归一化单测。

关键回归：`input_tokens_include_cache` 必须按 provider 语义判定，不能无条件 True。
  - OpenAI-shape（prompt_tokens 已含 cache）→ True
  - Anthropic-shape（input_tokens 不含 cache，cache 在顶层字段）→ False

无条件 True 会让 billing 对 Anthropic 走 base = input - cache（把不含 cache 的 input
又减一遍），非缓存 input 漏计费 → 计费系统性偏低。
"""

import json

from django.test import SimpleTestCase

from apps.services.llm.services.proxy_service import _parse_usage_from_sse


class ParseUsageFromSseTestCase(SimpleTestCase):
    @staticmethod
    def _sse(usage: dict) -> str:
        return json.dumps({"usage": usage})

    def test_openai_shape_includes_cache(self):
        u = _parse_usage_from_sse(self._sse({
            "prompt_tokens": 10000,
            "completion_tokens": 50,
            "total_tokens": 10050,
            "prompt_tokens_details": {"cached_tokens": 8000},
        }))
        self.assertIsNotNone(u)
        self.assertEqual(u["input_tokens"], 10000)
        self.assertEqual(u["cache_read_input_tokens"], 8000)
        self.assertTrue(u["input_tokens_include_cache"])

    def test_anthropic_shape_excludes_cache(self):
        # 关键回归：仅 input_tokens（无 prompt_tokens）+ 顶层 cache 字段 → 不含 cache
        u = _parse_usage_from_sse(self._sse({
            "input_tokens": 2000,
            "output_tokens": 30,
            "total_tokens": 2030,
            "cache_read_input_tokens": 8000,
            "cache_creation_input_tokens": 500,
        }))
        self.assertIsNotNone(u)
        self.assertEqual(u["input_tokens"], 2000)
        self.assertEqual(u["cache_read_input_tokens"], 8000)
        self.assertEqual(u["cache_creation_input_tokens"], 500)
        self.assertFalse(u["input_tokens_include_cache"])

    def test_openai_no_cache_still_include_true(self):
        u = _parse_usage_from_sse(self._sse({
            "prompt_tokens": 5000,
            "completion_tokens": 20,
            "total_tokens": 5020,
        }))
        self.assertIsNotNone(u)
        self.assertEqual(u["input_tokens"], 5000)
        self.assertTrue(u["input_tokens_include_cache"])

    def test_no_usage_returns_none(self):
        self.assertIsNone(_parse_usage_from_sse(json.dumps({"choices": []})))

    def test_malformed_json_returns_none(self):
        self.assertIsNone(_parse_usage_from_sse("not json"))

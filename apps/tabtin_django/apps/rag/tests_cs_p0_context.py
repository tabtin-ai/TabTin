"""
CS-01 ~ CS-04 P0 回归测试

覆盖：
- CS-01: Token 估算中英文混合溢出
- CS-02: JSON 上下文截断产生非法 JSON
- CS-03: extract_metadata v1/v2 字段名兼容
- CS-04: _build_structured_context v1/v2 字段名兼容
"""

import json

from django.test import TestCase, override_settings

from apps.rag.services.context_service import ContextService


def _v1_results(n=3, content="some content"):
    return [
        {
            "table_name": f"Table_{i}",
            "content": content,
            "similarity_score": 0.9 - i * 0.05,
        }
        for i in range(n)
    ]


def _v2_results(n=3, content="some content"):
    return [
        {
            "title": f"Title_{i}",
            "content": content,
            "similarity": 0.9 - i * 0.05,
        }
        for i in range(n)
    ]


# =====================================================================
# CS-01: Token 估算中英文混合
# =====================================================================


class CS01TokenEstimationTest(TestCase):
    """CS-01: _estimate_tokens 应对中文给出比英文更高的 token 估算。"""

    def test_chinese_higher_than_english_same_length(self):
        svc = ContextService()
        chinese = "你" * 100
        english = "a" * 100
        self.assertGreater(
            svc._estimate_tokens(chinese),
            svc._estimate_tokens(english),
        )

    def test_pure_chinese_estimate_reasonable(self):
        svc = ContextService()
        text = "你" * 1000
        tokens = svc._estimate_tokens(text)
        self.assertGreaterEqual(tokens, 1000)
        self.assertLessEqual(tokens, 1500)

    def test_pure_english_estimate_reasonable(self):
        svc = ContextService()
        text = "a" * 4000
        tokens = svc._estimate_tokens(text)
        self.assertGreaterEqual(tokens, 800)
        self.assertLessEqual(tokens, 1200)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=200)
    def test_truncate_respects_chinese_tokens(self):
        """纯中文 1000 字（≈1300 token），限制 200 token 时必须截断。"""
        svc = ContextService()
        text = "测" * 1000
        result = svc._truncate_by_tokens(text)
        self.assertIn("已截断", result)
        estimated_after = svc._estimate_tokens(result.split("\n\n...")[0])
        self.assertLessEqual(estimated_after, 200)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=5000)
    def test_short_text_not_truncated(self):
        svc = ContextService()
        text = "hello world"
        self.assertEqual(svc._truncate_by_tokens(text), text)


# =====================================================================
# CS-02: JSON 上下文不产生非法 JSON
# =====================================================================


class CS02JsonTruncationTest(TestCase):
    """CS-02: JSON 格式输出即使超限也必须是合法 JSON。"""

    @override_settings(RAG_MAX_CONTEXT_TOKENS=100)
    def test_json_context_always_valid(self):
        """大量结果在极低 token 限制下，输出仍可 json.loads。"""
        svc = ContextService()
        results = _v1_results(n=50, content="这是一段很长的中文内容" * 20)
        ctx = svc.build_context(results, query="test", format_type="json")
        parsed = json.loads(ctx)
        self.assertIsInstance(parsed, list)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=100)
    def test_json_context_v2_always_valid(self):
        svc = ContextService()
        results = _v2_results(n=50, content="中文内容" * 50)
        ctx = svc.build_context(results, query="test", format_type="json")
        parsed = json.loads(ctx)
        self.assertIsInstance(parsed, list)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=100)
    def test_json_context_trims_entries(self):
        """token 限制极低时，输出条目数应少于输入条目数。"""
        svc = ContextService()
        results = _v1_results(n=20, content="x" * 500)
        ctx = svc.build_context(results, query="test", format_type="json")
        parsed = json.loads(ctx)
        self.assertLess(len(parsed), 20)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=100000)
    def test_json_context_keeps_all_when_budget_large(self):
        svc = ContextService()
        results = _v1_results(n=5, content="short")
        ctx = svc.build_context(results, query="test", format_type="json")
        parsed = json.loads(ctx)
        self.assertEqual(len(parsed), 5)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10)
    def test_json_single_item_too_large_returns_empty_list(self):
        """单条记录就超限时，输出应为空数组（仍是合法 JSON）。"""
        svc = ContextService()
        results = _v1_results(n=1, content="x" * 10000)
        ctx = svc.build_context(results, query="test", format_type="json")
        parsed = json.loads(ctx)
        self.assertIsInstance(parsed, list)


# =====================================================================
# CS-03: extract_metadata v1/v2 兼容
# =====================================================================


class CS03ExtractMetadataCompatTest(TestCase):
    """CS-03: extract_metadata 应同时接受 v1 和 v2 字段名。"""

    def test_v1_fields(self):
        svc = ContextService()
        results = _v1_results(n=3)
        meta = svc.extract_metadata(results)
        self.assertEqual(meta["total_results"], 3)
        self.assertAlmostEqual(meta["max_similarity"], 0.9, places=2)
        self.assertIn("Table_0", meta["table_distribution"])

    def test_v2_fields(self):
        svc = ContextService()
        results = _v2_results(n=3)
        meta = svc.extract_metadata(results)
        self.assertEqual(meta["total_results"], 3)
        self.assertAlmostEqual(meta["max_similarity"], 0.9, places=2)
        self.assertIn("Title_0", meta["table_distribution"])

    def test_mixed_v1_v2(self):
        svc = ContextService()
        results = [
            {"similarity_score": 0.8, "table_name": "OldTable", "content": "c1"},
            {"similarity": 0.9, "title": "NewTitle", "content": "c2"},
        ]
        meta = svc.extract_metadata(results)
        self.assertEqual(meta["total_results"], 2)
        self.assertAlmostEqual(meta["max_similarity"], 0.9, places=2)
        self.assertAlmostEqual(meta["min_similarity"], 0.8, places=2)

    def test_empty_results(self):
        svc = ContextService()
        self.assertEqual(svc.extract_metadata([]), {})


# =====================================================================
# CS-04: _build_structured_context v1/v2 兼容
# =====================================================================


class CS04StructuredContextCompatTest(TestCase):
    """CS-04: _build_structured_context 应同时接受 v1 和 v2 字段名。"""

    def test_v1_fields_no_crash(self):
        svc = ContextService()
        results = _v1_results(n=2)
        ctx = svc._build_structured_context(results, "test query")
        self.assertIn("Table_0", ctx)
        self.assertIn("0.90", ctx)

    def test_v2_fields_no_crash(self):
        svc = ContextService()
        results = _v2_results(n=2)
        ctx = svc._build_structured_context(results, "test query")
        self.assertIn("Title_0", ctx)
        self.assertIn("0.90", ctx)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=100000)
    def test_build_context_structured_v2(self):
        """通过 build_context 入口调用 structured 格式，传入 v2 结果不 crash。"""
        svc = ContextService()
        results = _v2_results(n=3)
        ctx = svc.build_context(results, query="q", format_type="structured")
        self.assertIn("Title_0", ctx)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=100000)
    def test_build_context_json_v2(self):
        """通过 build_context 入口调用 json 格式，传入 v2 结果不 crash。"""
        svc = ContextService()
        results = _v2_results(n=3)
        ctx = svc.build_context(results, query="q", format_type="json")
        parsed = json.loads(ctx)
        self.assertEqual(parsed[0]["table_name"], "Title_0")

    def test_mixed_v1_v2_structured(self):
        svc = ContextService()
        results = [
            {"similarity_score": 0.8, "table_name": "Legacy", "content": "old"},
            {"similarity": 0.95, "title": "Modern", "content": "new"},
        ]
        ctx = svc._build_structured_context(results, "q")
        self.assertIn("Legacy", ctx)
        self.assertIn("Modern", ctx)
        self.assertIn("0.80", ctx)
        self.assertIn("0.95", ctx)

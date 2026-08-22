"""resolve_usage_event_biz_types 纯函数回归（ 模型调用别名）。"""

from django.test import SimpleTestCase

from apps.services.billing.usage_event_filters import resolve_usage_event_biz_types


class ResolveUsageEventBizTypesTests(SimpleTestCase):
    def test_llm_call_expands_to_include_legacy_llm(self):
        self.assertEqual(
            resolve_usage_event_biz_types("llm_call"),
            ["llm", "llm_call"],
        )

    def test_legacy_llm_expands_symmetrically(self):
        self.assertEqual(
            resolve_usage_event_biz_types("llm"),
            ["llm", "llm_call"],
        )

    def test_comma_separated_merges_aliases(self):
        self.assertEqual(
            resolve_usage_event_biz_types("llm_call,llm_chat"),
            ["llm", "llm_call", "llm_chat"],
        )

    def test_unrelated_passthrough(self):
        self.assertEqual(resolve_usage_event_biz_types("llm_blocked"), ["llm_blocked"])

    def test_empty(self):
        self.assertEqual(resolve_usage_event_biz_types(""), [])
        self.assertEqual(resolve_usage_event_biz_types("   "), [])
        self.assertEqual(resolve_usage_event_biz_types(None), [])

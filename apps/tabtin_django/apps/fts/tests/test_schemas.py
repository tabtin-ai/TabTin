"""schemas 字段约束测试（PRD 4.6）。"""

from __future__ import annotations

import unittest

import apps.fts.tests.conftest  # noqa: F401  - 启动 Django


class SearchParamsValidationTests(unittest.TestCase):
    """请求 schema 校验关键边界。"""

    def test_q_required_min_length(self):
        from apps.fts.schemas import SearchParams
        with self.assertRaises(Exception):
            SearchParams(q="", organization_id="wt-1")

    def test_organization_id_blank_rejected(self):
        from apps.fts.schemas import SearchParams
        with self.assertRaises(Exception):
            SearchParams(q="hello", organization_id="   ")

    def test_empty_strings_normalized_to_none(self):
        from apps.fts.schemas import SearchParams
        p = SearchParams(q="hello", organization_id="wt-1", types="", item_type="", space_id="", agent_id="")
        self.assertIsNone(p.types)
        self.assertIsNone(p.item_type)
        self.assertIsNone(p.space_id)
        self.assertIsNone(p.agent_id)

    def test_limit_offset_bounds(self):
        from apps.fts.schemas import SearchParams
        with self.assertRaises(Exception):
            SearchParams(q="x", organization_id="wt-1", limit=0)
        with self.assertRaises(Exception):
            SearchParams(q="x", organization_id="wt-1", limit=101)
        with self.assertRaises(Exception):
            SearchParams(q="x", organization_id="wt-1", offset=-1)

    def test_creator_type_enum_constraint(self):
        from apps.fts.schemas import SearchParams
        for v in ("user", "agent", "any"):
            p = SearchParams(q="x", organization_id="wt-1", creator_type=v)
            self.assertEqual(p.creator_type, v)
        with self.assertRaises(Exception):
            SearchParams(q="x", organization_id="wt-1", creator_type="bot")

    def test_mode_enum(self):
        from apps.fts.schemas import SearchParams
        p = SearchParams(q="x", organization_id="wt-1", mode="fallback_ok")
        self.assertEqual(p.mode, "fallback_ok")
        with self.assertRaises(Exception):
            SearchParams(q="x", organization_id="wt-1", mode="weird")


class SearchResponseDefaultsTests(unittest.TestCase):
    """响应 schema 默认值符合 Wave 3 前端协议。"""

    def test_defaults_safe(self):
        from apps.fts.schemas import SearchResponse
        r = SearchResponse()
        self.assertEqual(r.results, [])
        self.assertEqual(r.total, 0)
        self.assertEqual(r.facets, {})
        self.assertEqual(r.suggestions, [])
        self.assertFalse(r.degraded)
        self.assertIsNone(r.degraded_reason)
        self.assertEqual(r.partial_indices, [])
        self.assertEqual(r.search_mode, "normal")

    def test_result_item_required_minimum(self):
        from apps.fts.schemas import SearchResultItem
        item = SearchResultItem(id="x", type="message", title="hello")
        self.assertEqual(item.snippet, "")
        self.assertEqual(item.highlight, {})
        self.assertEqual(item.metadata, {})


if __name__ == "__main__":
    unittest.main()

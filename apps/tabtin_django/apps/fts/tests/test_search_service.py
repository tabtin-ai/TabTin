"""search_service 单测：query 构造 / RRF / phrase / compose / recency / 回滚过滤。"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import apps.fts.tests.conftest  # noqa: F401


class ParsePhraseTests(unittest.TestCase):
    def test_no_quotes(self):
        from apps.fts.services.search_service import parse_phrase
        self.assertEqual(parse_phrase("python perf"), (None, "python perf"))

    def test_quoted_string(self):
        from apps.fts.services.search_service import parse_phrase
        self.assertEqual(
            parse_phrase('"Cannot read property"'),
            ("Cannot read property", '"Cannot read property"'),
        )

    def test_partial_quotes_treated_as_normal(self):
        from apps.fts.services.search_service import parse_phrase
        self.assertEqual(parse_phrase('foo "bar'), (None, 'foo "bar'))

    def test_empty_quoted_falls_back(self):
        from apps.fts.services.search_service import parse_phrase
        self.assertEqual(parse_phrase('""'), (None, '""'))


class TypesParseTests(unittest.TestCase):
    def test_default_all_six(self):
        from apps.fts.services.search_service import _DEFAULT_TYPES, _parse_types
        self.assertEqual(set(_parse_types(None)), set(_DEFAULT_TYPES))
        self.assertEqual(set(_parse_types("")), set(_DEFAULT_TYPES))

    def test_split_known(self):
        from apps.fts.services.search_service import _parse_types
        self.assertEqual(_parse_types("messages,memos"), ["messages", "memos"])

    def test_unknown_dropped(self):
        from apps.fts.services.search_service import _parse_types
        self.assertEqual(_parse_types("messages,foo,memos"), ["messages", "memos"])

    def test_dedupe(self):
        from apps.fts.services.search_service import _parse_types
        self.assertEqual(_parse_types("memos,memos,memos"), ["memos"])


class BuildIndexQueryTests(unittest.TestCase):
    def setUp(self):
        from apps.fts.services.acl_service import AccessibleSpaces
        self.access = AccessibleSpaces(full_access_space_ids=["s1"], organization_id="wt-1")

    def _params(self, **overrides):
        from apps.fts.schemas import SearchParams
        defaults = {"q": "perf", "organization_id": "wt-1"}
        defaults.update(overrides)
        return SearchParams(**defaults)

    def test_messages_has_recency_boost_and_rollback_filter(self):
        from apps.fts.services.search_service import build_index_query
        body = build_index_query(
            logical="messages", params=self._params(), phrase=None, accessible=self.access,
        )
        # function_score 包裹
        self.assertIn("function_score", body["query"])
        gauss = body["query"]["function_score"]["functions"][0]["gauss"]
        self.assertEqual(gauss["created_at"]["scale"], "7d")
        # 回滚 painless filter 出现在 inner bool.filter
        inner_filters = body["query"]["function_score"]["query"]["bool"]["filter"]
        scripts = [f for f in inner_filters if "script" in f]
        self.assertTrue(any("checkpoint_state_index" in (s["script"]["script"]["source"]) for s in scripts))

    def test_resources_phrase_uses_match_phrase(self):
        from apps.fts.services.search_service import build_index_query
        body = build_index_query(
            logical="resources", params=self._params(q='"hello world"'),
            phrase="hello world", accessible=self.access,
        )
        must = body["query"]["bool"]["must"]
        self.assertEqual(must[0]["multi_match"]["type"], "phrase")
        self.assertEqual(must[0]["multi_match"]["query"], "hello world")

    def test_resources_excludes_trashed_and_archived_by_default(self):
        from apps.fts.services.search_service import build_index_query
        body = build_index_query(
            logical="resources", params=self._params(), phrase=None, accessible=self.access,
        )
        filters = body["query"]["bool"]["filter"]
        # is_archived: false
        archived = [f for f in filters if f.get("term", {}).get("is_archived") is False]
        self.assertEqual(len(archived), 1)
        # trashed_at must_not exists
        trashed = [f for f in filters if f.get("bool", {}).get("must_not", {}).get("exists", {}).get("field") == "trashed_at"]
        self.assertEqual(len(trashed), 1)

    def test_creator_type_filter_only_on_indices_with_field(self):
        from apps.fts.services.search_service import build_index_query
        body_msg = build_index_query(
            logical="messages",
            params=self._params(creator_type="agent"),
            phrase=None,
            accessible=self.access,
        )
        msg_filters = body_msg["query"]["function_score"]["query"]["bool"]["filter"]
        self.assertTrue(any(f.get("term", {}).get("creator_type") == "agent" for f in msg_filters))

        body_space = build_index_query(
            logical="spaces",
            params=self._params(creator_type="agent"),
            phrase=None,
            accessible=self.access,
        )
        sp_filters = body_space["query"]["bool"]["filter"]
        self.assertFalse(any(f.get("term", {}).get("creator_type") for f in sp_filters))

    def test_agents_space_filters_use_space_ids_field(self):
        from apps.fts.services.search_service import build_index_query
        body = build_index_query(
            logical="agents",
            params=self._params(space_id="s1"),
            phrase=None,
            accessible=self.access,
        )

        filters = body["query"]["bool"]["filter"]
        should_terms = [
            should.get("terms", {})
            for f in filters
            for should in f.get("bool", {}).get("should", [])
        ]
        self.assertIn({"space_ids": ["s1"]}, should_terms)
        self.assertTrue(any(f.get("term", {}).get("space_ids") == "s1" for f in filters))
        self.assertFalse(any("space_id" in terms for terms in should_terms))
        self.assertFalse(any("space_id" in f.get("term", {}) for f in filters))

    def test_role_filter_only_on_messages(self):
        from apps.fts.services.search_service import build_index_query
        body = build_index_query(
            logical="messages",
            params=self._params(role="user"),
            phrase=None,
            accessible=self.access,
        )
        filters = body["query"]["function_score"]["query"]["bool"]["filter"]
        self.assertTrue(any(f.get("term", {}).get("role") == "user" for f in filters))


class RrfMergeTests(unittest.TestCase):
    def test_single_index_keeps_order(self):
        from apps.fts.services.search_service import rrf_merge
        per = {
            "memos": [
                {"_id": "m1", "_score": 5.0},
                {"_id": "m2", "_score": 4.0},
                {"_id": "m3", "_score": 3.0},
            ]
        }
        out = rrf_merge(per, k=60)
        self.assertEqual([h["_id"] for h, _ in out], ["m1", "m2", "m3"])

    def test_two_indices_fuse_first_rank_wins(self):
        from apps.fts.services.search_service import rrf_merge
        per = {
            "memos": [{"_id": "m1"}, {"_id": "m2"}],
            "resources": [{"_id": "r1"}, {"_id": "r2"}, {"_id": "r3"}],
        }
        out = rrf_merge(per, k=60)
        # m1 和 r1 都是 rank=0 → 同分
        scores = {h["_id"]: s for h, s in out}
        self.assertAlmostEqual(scores["m1"], scores["r1"])
        # m2 = 1/(60+2) = 1/62 ；r2 同
        self.assertAlmostEqual(scores["m2"], scores["r2"])
        self.assertGreater(scores["m1"], scores["m2"])

    def test_logical_index_attached(self):
        from apps.fts.services.search_service import rrf_merge
        per = {"memos": [{"_id": "m1"}]}
        out = rrf_merge(per, k=60)
        self.assertEqual(out[0][0]["_logical_index"], "memos")

    def test_same_id_across_indices_kept_separate(self):
        from apps.fts.services.search_service import rrf_merge
        # 同 id 不同索引（极少但可能）：不做去重，保留两条
        per = {
            "memos": [{"_id": "x"}],
            "resources": [{"_id": "x"}],
        }
        out = rrf_merge(per, k=60)
        self.assertEqual(len(out), 2)


class ComposeResultItemTests(unittest.TestCase):
    def test_message_compose(self):
        from apps.fts.services.search_service import compose_result_item
        hit = {
            "_id": "msg-1", "_score": 7.5,
            "_logical_index": "messages",
            "_source": {
                "session_id": "sess-1",
                "session_title": "Python perf",
                "space_id": "sp-1",
                "user_id": "u-1",
                "creator_type": "user",
                "agent_id": None,
                "role": "user",
                "content": "二分查找替代线性扫描",
                "created_at": "2026-04-16T01:00:00Z",
            },
            "highlight": {"content": ["二分<em>查找</em>替代"]},
        }
        item = compose_result_item("messages", hit, rrf_score=0.95)
        self.assertEqual(item.id, "msg-1")
        self.assertEqual(item.type, "message")
        self.assertEqual(item.title, "Python perf")
        self.assertEqual(item.session_id, "sess-1")
        self.assertEqual(item.creator_type, "user")
        self.assertEqual(item.creator_id, "u-1")
        self.assertEqual(item.role, "user")
        self.assertEqual(item.snippet, "二分<em>查找</em>替代")
        self.assertAlmostEqual(item.rrf_score, 0.95)

    def test_im_compose_uses_conversation_id_as_session_id(self):
        from apps.fts.services.search_service import compose_result_item
        hit = {
            "_id": "im-1",
            "_logical_index": "im",
            "_source": {
                "conversation_id": "conv-9",
                "conversation_name": "Project alpha",
                "content": "hello world",
                "creator_type": "user",
                "sender_id": "u-2",
            },
            "_score": 1.0,
        }
        item = compose_result_item("im", hit, rrf_score=0.5)
        self.assertEqual(item.session_id, "conv-9")
        self.assertEqual(item.title, "Project alpha")

    def test_memo_title_first_line(self):
        from apps.fts.services.search_service import compose_result_item
        hit = {
            "_id": "memo-1",
            "_logical_index": "memos",
            "_source": {"content": "first line\nsecond line\nthird"},
        }
        item = compose_result_item("memos", hit, rrf_score=0.1)
        self.assertEqual(item.title, "first line")


class SearchEndToEndStubbedTests(unittest.TestCase):
    """走完 search() 全链：mock ES + ACL + Hydration。"""

    def setUp(self):
        from apps.fts.services.acl_service import AccessibleSpaces
        self.access = AccessibleSpaces(
            full_access_space_ids=["sp-1"], organization_id="wt-1",
        )

    def _params(self, **overrides):
        from apps.fts.schemas import SearchParams
        d = {"q": "perf", "organization_id": "wt-1"}
        d.update(overrides)
        return SearchParams(**d)

    def test_no_access_short_circuits(self):
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.search_service import search
        with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces") as m_acl:
            m_acl.return_value = AccessibleSpaces(organization_id="wt-1")
            resp = search(self._params(), user_id="u1")
        self.assertEqual(resp.results, [])
        self.assertEqual(resp.facets, {t: 0 for t in (
            "messages", "resources", "agents", "spaces", "memos", "im")})

    def test_zero_total_triggers_suggest(self):
        from apps.fts.services.search_service import search
        fake_client = MagicMock()
        fake_client.msearch.return_value = {"responses": [
            {"hits": {"total": {"value": 0}, "hits": []}} for _ in range(6)
        ]}
        # suggest 调 .search 拿建议
        fake_client.search.return_value = {
            "suggest": {"did_you_mean": [
                {"options": [{"text": "performance"}, {"text": "perfect"}]}
            ]}
        }
        with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces", return_value=self.access), \
             patch("apps.fts.services.search_service.get_client", return_value=fake_client), \
             patch("apps.fts.services.search_service.breaker_run", side_effect=lambda fn, *a, **kw: fn(*a, **kw)), \
             patch("apps.fts.services.search_service.hydration_service.hydrate", side_effect=lambda items: items):
            resp = search(self._params(), user_id="u1")
        self.assertEqual(resp.total, 0)
        self.assertEqual(resp.suggestions, ["performance", "perfect"])

    def test_results_compose_with_facets(self):
        from apps.fts.services.search_service import search
        msg_hits = {
            "hits": {
                "total": {"value": 2},
                "hits": [
                    {"_id": "m1", "_score": 5.0, "_source": {
                        "session_id": "s1", "session_title": "T",
                        "space_id": "sp-1", "creator_type": "user", "user_id": "u-1",
                        "content": "abc", "role": "user", "created_at": "2026-04-16T00:00:00Z"}},
                    {"_id": "m2", "_score": 3.0, "_source": {
                        "session_id": "s1", "session_title": "T",
                        "space_id": "sp-1", "creator_type": "user", "user_id": "u-1",
                        "content": "abc2", "role": "user", "created_at": "2026-04-16T00:00:01Z"}},
                ]
            }
        }
        empty = {"hits": {"total": {"value": 0}, "hits": []}}
        fake_client = MagicMock()
        fake_client.msearch.return_value = {"responses": [
            msg_hits, empty, empty, empty, empty, empty,  # 顺序：messages first
        ]}
        with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces", return_value=self.access), \
             patch("apps.fts.services.search_service.get_client", return_value=fake_client), \
             patch("apps.fts.services.search_service.breaker_run", side_effect=lambda fn, *a, **kw: fn(*a, **kw)), \
             patch("apps.fts.services.search_service.hydration_service.hydrate", side_effect=lambda items: items):
            resp = search(self._params(limit=10), user_id="u1")
        self.assertEqual(resp.facets["messages"], 2)
        self.assertEqual(len(resp.results), 2)
        self.assertEqual(resp.results[0].id, "m1")  # rank 0 RRF higher

    def test_es_msearch_failure_propagates_for_api_to_fallback(self):
        """search() 不自己降级，把异常上抛给 API 层。"""
        from apps.fts.services.search_service import search
        fake_client = MagicMock()
        fake_client.msearch.side_effect = RuntimeError("es boom")
        with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces", return_value=self.access), \
             patch("apps.fts.services.search_service.get_client", return_value=fake_client), \
             patch("apps.fts.services.search_service.breaker_run", side_effect=lambda fn, *a, **kw: fn(*a, **kw)):
            with self.assertRaises(RuntimeError):
                search(self._params(), user_id="u1")

    def test_sub_query_error_marks_partial_failure(self):
        """Wave 2 Review 修复：单索引 msearch 子查询 error → degraded + partial_indices。"""
        from apps.fts.services.search_service import search
        ok = {"hits": {"total": {"value": 1}, "hits": [{"_id": "m1", "_score": 5.0,
              "_source": {"session_id": "s1", "session_title": "T", "space_id": "sp-1",
                          "creator_type": "user", "user_id": "u-1", "content": "abc",
                          "role": "user", "created_at": "2026-04-16T00:00:00Z"}}]}}
        err = {"error": {"type": "shard_failure", "reason": "shard down"}}
        empty = {"hits": {"total": {"value": 0}, "hits": []}}
        # 顺序 messages, resources, agents, spaces, memos, im
        # 让 resources + im 出 error
        responses = [ok, err, empty, empty, empty, err]
        fake_client = MagicMock()
        fake_client.msearch.return_value = {"responses": responses}
        with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces", return_value=self.access), \
             patch("apps.fts.services.search_service.get_client", return_value=fake_client), \
             patch("apps.fts.services.search_service.breaker_run", side_effect=lambda fn, *a, **kw: fn(*a, **kw)), \
             patch("apps.fts.services.search_service.hydration_service.hydrate", side_effect=lambda items: items):
            resp = search(self._params(), user_id="u1")
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "partial_failure")
        self.assertEqual(set(resp.partial_indices), {"resources", "im"})
        # facets 仍齐全
        self.assertEqual(resp.facets["resources"], 0)
        self.assertEqual(resp.facets["im"], 0)


class IndexProfileTests(unittest.TestCase):
    """Wave 2 Review 修复：单源化（_RESULT_TYPE_BY_LOGICAL 取代 _INDEX_PROFILE）。"""

    def test_default_types_derived_from_index_definitions(self):
        from apps.fts.services.search_service import _DEFAULT_TYPES
        from apps.fts.index_definitions import INDEX_DEFINITIONS
        self.assertEqual(set(_DEFAULT_TYPES), set(INDEX_DEFINITIONS.keys()))

    def test_result_type_mapping_complete(self):
        from apps.fts.services.search_service import _RESULT_TYPE_BY_LOGICAL, _DEFAULT_TYPES
        # 每个逻辑索引都要有对应 result_type
        for logical in _DEFAULT_TYPES:
            self.assertIn(logical, _RESULT_TYPE_BY_LOGICAL)


class TitleForTests(unittest.TestCase):
    """Wave 2 Review 修复：删除 'message' 死分支，确认 'messages' 即可。"""

    def test_messages_returns_session_title(self):
        from apps.fts.services.search_service import _title_for
        self.assertEqual(_title_for("messages", {"session_title": "x"}), "x")

    def test_message_singular_no_longer_supported(self):
        # 删除死分支后 'message'（单数）走兜底 → 空串
        from apps.fts.services.search_service import _title_for
        self.assertEqual(_title_for("message", {"session_title": "x"}), "")


if __name__ == "__main__":
    unittest.main()

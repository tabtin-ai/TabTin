"""fallback_service 单测：决策 + rate limit + PG 路径 + partial response。"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import apps.fts.tests.conftest  # noqa: F401


class ShouldFallbackTests(unittest.TestCase):
    def setUp(self):
        # 默认 engine on，breaker closed，health green，error rate 正常
        self._patches = []
        self._patch("apps.fts.services.fallback_service.is_engine_enabled", return_value=True)
        self._patch("apps.fts.services.fallback_service._read_health_redis", return_value="green")
        self._fake_breaker = MagicMock(current_state="closed")
        self._patch("apps.fts.services.fallback_service.get_breaker", return_value=self._fake_breaker)
        self._patch("apps.fts.client.should_open_circuit", return_value=False)

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def _patch(self, target, **kwargs):
        p = patch(target, **kwargs)
        self._patches.append(p)
        return p.start()

    def test_normal_no_fallback(self):
        from apps.fts.services.fallback_service import should_fallback
        d = should_fallback()
        self.assertFalse(d.fallback)

    def test_engine_disabled_fallback(self):
        from apps.fts.services.fallback_service import should_fallback
        with patch("apps.fts.services.fallback_service.is_engine_enabled", return_value=False):
            d = should_fallback()
        self.assertTrue(d.fallback)
        self.assertEqual(d.reason, "engine_disabled")

    def test_health_red_fallback(self):
        from apps.fts.services.fallback_service import should_fallback
        with patch("apps.fts.services.fallback_service._read_health_redis", return_value="red"):
            d = should_fallback()
        self.assertTrue(d.fallback)
        self.assertEqual(d.reason, "health_red")

    def test_health_unreachable_fallback(self):
        from apps.fts.services.fallback_service import should_fallback
        with patch("apps.fts.services.fallback_service._read_health_redis", return_value="unreachable"):
            d = should_fallback()
        self.assertTrue(d.fallback)
        self.assertEqual(d.reason, "health_red")

    def test_health_yellow_no_fallback(self):
        from apps.fts.services.fallback_service import should_fallback
        with patch("apps.fts.services.fallback_service._read_health_redis", return_value="yellow"):
            d = should_fallback()
        self.assertFalse(d.fallback)

    def test_breaker_open_fallback(self):
        from apps.fts.services.fallback_service import should_fallback
        self._fake_breaker.current_state = "open"
        d = should_fallback()
        self.assertTrue(d.fallback)
        self.assertEqual(d.reason, "circuit_open")

    def test_error_rate_breach_fallback(self):
        from apps.fts.services.fallback_service import should_fallback
        with patch("apps.fts.client.should_open_circuit", return_value=True):
            d = should_fallback()
        self.assertTrue(d.fallback)
        self.assertEqual(d.reason, "error_rate_breach")


class RateLimitTests(unittest.TestCase):
    def test_no_user_id_passes(self):
        from apps.fts.services.fallback_service import _check_rate_limit
        self.assertTrue(_check_rate_limit(""))

    def test_within_limit(self):
        from apps.fts.services.fallback_service import _check_rate_limit, RATE_LIMIT_PER_MIN
        fake = MagicMock()
        fake.incr.return_value = RATE_LIMIT_PER_MIN  # exactly at limit
        with patch("django_redis.get_redis_connection", return_value=fake):
            self.assertTrue(_check_rate_limit("u1"))

    def test_over_limit(self):
        from apps.fts.services.fallback_service import _check_rate_limit, RATE_LIMIT_PER_MIN
        fake = MagicMock()
        fake.incr.return_value = RATE_LIMIT_PER_MIN + 1
        with patch("django_redis.get_redis_connection", return_value=fake):
            self.assertFalse(_check_rate_limit("u1"))

    def test_redis_error_passes_open(self):
        from apps.fts.services.fallback_service import _check_rate_limit
        with patch("django_redis.get_redis_connection", side_effect=RuntimeError("boom")):
            self.assertTrue(_check_rate_limit("u1"))


class FallbackSearchTests(unittest.TestCase):
    """整体 fallback_search 路径：partial_indices / rate_limited / 资源整合。"""

    def _params(self, **overrides):
        from apps.fts.schemas import SearchParams
        d = {"q": "abc", "organization_id": "wt-1"}
        d.update(overrides)
        return SearchParams(**d)

    def test_rate_limited_returns_empty_with_reason(self):
        from apps.fts.services.fallback_service import fallback_search, PARTIAL_INDICES_DEGRADED
        with patch("apps.fts.services.fallback_service._check_rate_limit", return_value=False):
            resp = fallback_search(self._params(), user_id="u1", reason="opensearch_unavailable")
        self.assertEqual(resp.results, [])
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "rate_limited")
        self.assertEqual(set(resp.partial_indices), set(PARTIAL_INDICES_DEGRADED))

    def test_messages_im_skipped_partial(self):
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.fallback_service import fallback_search
        # 全部 6 类请求，但 fallback 只覆盖 resources/memos
        # Wave 5 R2-15：_pg_search_* 返回三元组 (items, total, error)
        # Wave 5 B1：fallback 路径会调 acl_service；mock 让其有 access
        access = AccessibleSpaces(full_access_space_ids=["sp-1"], organization_id="wt-1")
        with patch("apps.fts.services.fallback_service._check_rate_limit", return_value=True), \
             patch("apps.fts.services.acl_service.get_user_accessible_spaces", return_value=access), \
             patch("apps.fts.services.fallback_service._pg_search_resources", return_value=([], 0, False)), \
             patch("apps.fts.services.fallback_service._pg_search_memos", return_value=([], 0, False)):
            resp = fallback_search(
                self._params(types="messages,resources,memos,im,agents,spaces"),
                user_id="u1", reason="circuit_open",
            )
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "circuit_open")
        # messages / im / agents / spaces 应该被跳过
        self.assertIn("messages", resp.partial_indices)
        self.assertIn("im", resp.partial_indices)
        self.assertIn("agents", resp.partial_indices)
        self.assertIn("spaces", resp.partial_indices)
        self.assertNotIn("resources", resp.partial_indices)
        self.assertNotIn("memos", resp.partial_indices)

    def test_only_resources_only_returns_pg_resources(self):
        from apps.fts.schemas import SearchResultItem
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.fallback_service import fallback_search
        sample_items = [
            SearchResultItem(id="r1", type="resource", title="t1", score=2.0),
            SearchResultItem(id="r2", type="resource", title="t2", score=1.0),
        ]
        # Wave 5 三视角 Review B1 修复后，fallback 路径会调 acl_service；
        # 测试需要 mock acl 让其返回有 access
        access = AccessibleSpaces(full_access_space_ids=["sp-1"], organization_id="wt-1")
        with patch("apps.fts.services.fallback_service._check_rate_limit", return_value=True), \
             patch("apps.fts.services.acl_service.get_user_accessible_spaces", return_value=access), \
             patch("apps.fts.services.fallback_service._pg_search_resources", return_value=(sample_items, 2, False)):
            resp = fallback_search(
                self._params(types="resources"), user_id="u1", reason="health_red",
            )
        self.assertEqual(resp.facets.get("resources"), 2)
        self.assertEqual(len(resp.results), 2)
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "health_red")
        self.assertIsNone(resp.notice)

    def test_strip_phrase_helper(self):
        from apps.fts.services.fallback_service import _strip_phrase
        self.assertEqual(_strip_phrase('"hello world"'), "hello world")
        self.assertEqual(_strip_phrase("hello world"), "hello world")
        self.assertEqual(_strip_phrase('"abc'), '"abc')

    def test_facets_filled_for_all_requested_types(self):
        """Wave 2 Review 修复：fallback facets 要给所有 requested types 填 0。"""
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.fallback_service import fallback_search
        # Wave 5 R2-15：_pg_search_* 返回三元组
        # Wave 5 B1：fallback 路径会调 acl_service
        access = AccessibleSpaces(full_access_space_ids=["sp-1"], organization_id="wt-1")
        with patch("apps.fts.services.fallback_service._check_rate_limit", return_value=True), \
             patch("apps.fts.services.acl_service.get_user_accessible_spaces", return_value=access), \
             patch("apps.fts.services.fallback_service._pg_search_resources", return_value=([], 0, False)), \
             patch("apps.fts.services.fallback_service._pg_search_memos", return_value=([], 0, False)):
            resp = fallback_search(
                self._params(types="messages,resources,memos,im,agents,spaces"),
                user_id="u1", reason="health_red",
            )
        # 6 类全部要在 facets
        self.assertEqual(set(resp.facets.keys()),
                         {"messages", "resources", "memos", "im", "agents", "spaces"})
        # 全部为 0（PG 没结果）
        for v in resp.facets.values():
            self.assertEqual(v, 0)

    def test_rate_limit_facets_full_six(self):
        """rate_limited 也要给 facets 全 6 类填 0。"""
        from apps.fts.services.fallback_service import fallback_search
        with patch("apps.fts.services.fallback_service._check_rate_limit", return_value=False):
            resp = fallback_search(
                self._params(types="messages,resources,memos,im,agents,spaces"),
                user_id="u1", reason="opensearch_unavailable",
            )
        self.assertEqual(resp.degraded_reason, "rate_limited")
        self.assertEqual(set(resp.facets.keys()),
                         {"messages", "resources", "memos", "im", "agents", "spaces"})

    # ── Wave 5 R2-15：partial_errors 字段（PG 失败时让前端能区分） ──
    def test_partial_errors_records_pg_failure(self):
        """Wave 5 R2-15：_pg_search_* 失败时填 partial_errors 让前端可区分'真零'vs'PG 故障'。"""
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.fallback_service import fallback_search
        access = AccessibleSpaces(full_access_space_ids=["sp-1"], organization_id="wt-1")
        with patch("apps.fts.services.fallback_service._check_rate_limit", return_value=True), \
             patch("apps.fts.services.acl_service.get_user_accessible_spaces", return_value=access), \
             patch(
                 "apps.fts.services.fallback_service._pg_search_resources",
                 return_value=([], 0, True),  # error=True
             ), \
             patch(
                 "apps.fts.services.fallback_service._pg_search_memos",
                 return_value=([], 0, False),
             ):
            resp = fallback_search(
                self._params(types="resources,memos"),
                user_id="u1", reason="opensearch_unavailable",
            )
        self.assertIn("resources", resp.partial_errors)
        self.assertNotIn("memos", resp.partial_errors)

    def test_partial_errors_empty_when_no_failures(self):
        """正常路径 partial_errors=[]（向后兼容性 + 默认值）。"""
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.fallback_service import fallback_search
        access = AccessibleSpaces(full_access_space_ids=["sp-1"], organization_id="wt-1")
        with patch("apps.fts.services.fallback_service._check_rate_limit", return_value=True), \
             patch("apps.fts.services.acl_service.get_user_accessible_spaces", return_value=access), \
             patch(
                 "apps.fts.services.fallback_service._pg_search_resources",
                 return_value=([], 0, False),
             ), \
             patch(
                 "apps.fts.services.fallback_service._pg_search_memos",
                 return_value=([], 0, False),
             ):
            resp = fallback_search(
                self._params(types="resources,memos"),
                user_id="u1", reason="opensearch_unavailable",
            )
        self.assertEqual(resp.partial_errors, [])


if __name__ == "__main__":
    unittest.main()

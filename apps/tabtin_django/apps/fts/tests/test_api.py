"""api.py 端到端测试：JWT 认证 / 降级路径 / 异常兜底。"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import apps.fts.tests.conftest  # noqa: F401


class ApiHelperTests(unittest.TestCase):
    def test_internal_error_response_shape(self):
        from apps.fts.api import _internal_error_response
        from apps.fts.schemas import SearchParams
        p = SearchParams(q="x", organization_id="wt-1")
        resp = _internal_error_response(p)
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "internal_error")
        self.assertEqual(resp.results, [])
        self.assertEqual(resp.search_mode, "fallback")


class UnifiedSearchHandlerTests(unittest.TestCase):
    """直接调底层 handler，避免起 Django HTTP 栈。"""

    def setUp(self):
        from apps.fts.schemas import SearchParams
        self.params = SearchParams(q="perf", organization_id="wt-1")

    def _request_with_user(self, user_id="u1"):
        req = MagicMock()
        user = MagicMock()
        user.id = user_id
        req.auth = user
        return req

    def _request_anon(self):
        req = MagicMock()
        req.auth = None
        return req

    def test_no_auth_returns_degraded_auth_missing(self):
        from apps.fts.api import unified_search
        req = self._request_anon()
        with patch("apps.fts.api.fallback_service.should_fallback") as m_decision:
            m_decision.return_value.fallback = False
            resp = unified_search(req, self.params)
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "auth_missing")

    def test_normal_path_calls_search_service(self):
        from apps.fts.api import unified_search
        from apps.fts.schemas import SearchResponse
        normal = SearchResponse(
            results=[], total=0, facets={}, took_ms=10, search_mode="normal", degraded=False,
        )
        with patch("apps.fts.api.fallback_service.should_fallback") as m_decision, \
             patch("apps.fts.api.search_service.search", return_value=normal) as m_search:
            decision = MagicMock(fallback=False, reason=None)
            m_decision.return_value = decision
            resp = unified_search(self._request_with_user(), self.params)
        m_search.assert_called_once()
        self.assertFalse(resp.degraded)

    def test_fallback_decision_skips_es(self):
        from apps.fts.api import unified_search
        from apps.fts.schemas import SearchResponse
        with patch("apps.fts.api.fallback_service.should_fallback") as m_decision, \
             patch("apps.fts.api.fallback_service.fallback_search") as m_fb, \
             patch("apps.fts.api.search_service.search") as m_search:
            m_decision.return_value = MagicMock(fallback=True, reason="circuit_open")
            m_fb.return_value = SearchResponse(
                results=[], total=0, facets={}, degraded=True,
                degraded_reason="circuit_open", search_mode="fallback",
            )
            resp = unified_search(self._request_with_user(), self.params)
        m_search.assert_not_called()
        m_fb.assert_called_once()
        self.assertEqual(resp.degraded_reason, "circuit_open")

    def test_es_failure_falls_back_then_returns(self):
        from apps.fts.api import unified_search
        from apps.fts.schemas import SearchResponse
        with patch("apps.fts.api.fallback_service.should_fallback") as m_decision, \
             patch("apps.fts.api.search_service.search", side_effect=RuntimeError("es boom")), \
             patch("apps.fts.api.fallback_service.fallback_search") as m_fb:
            m_decision.return_value = MagicMock(fallback=False, reason=None)
            m_fb.return_value = SearchResponse(
                results=[], total=0, degraded=True,
                degraded_reason="opensearch_unavailable",
                search_mode="fallback",
            )
            resp = unified_search(self._request_with_user(), self.params)
        self.assertEqual(resp.degraded_reason, "opensearch_unavailable")

    def test_double_failure_returns_internal_error(self):
        from apps.fts.api import unified_search
        with patch("apps.fts.api.fallback_service.should_fallback") as m_decision, \
             patch("apps.fts.api.search_service.search", side_effect=RuntimeError("es")), \
             patch("apps.fts.api.fallback_service.fallback_search", side_effect=RuntimeError("pg too")):
            m_decision.return_value = MagicMock(fallback=False, reason=None)
            resp = unified_search(self._request_with_user(), self.params)
        # 不抛 500，必须 degraded 兜底
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "internal_error")

    def test_fallback_path_failure_returns_internal_error(self):
        from apps.fts.api import unified_search
        with patch("apps.fts.api.fallback_service.should_fallback") as m_decision, \
             patch("apps.fts.api.fallback_service.fallback_search", side_effect=RuntimeError("pg")):
            m_decision.return_value = MagicMock(fallback=True, reason="health_red")
            resp = unified_search(self._request_with_user(), self.params)
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "internal_error")


class RouterRegistrationTests(unittest.TestCase):
    """ensure router has the expected operation."""

    def test_router_has_get_operation(self):
        from apps.fts.api import router
        # ninja Router 内部叫 path_operations
        ops = list(router.path_operations.keys())
        # 路由路径前缀本身是 ""，挂载到 /api/search
        self.assertIn("", ops)


if __name__ == "__main__":
    unittest.main()

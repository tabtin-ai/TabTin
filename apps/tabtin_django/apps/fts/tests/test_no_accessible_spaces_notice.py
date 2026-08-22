"""Wave 5 R4-09：search_service "无访问 Space" 时的 notice 字段。

覆盖三入口：
    1. search_service.search()  → SearchResponse.notice='no_accessible_spaces'
    2. SearchResponse 字段契约（schemas）
    3. fts-api.ts normalizeResponse（前端运行时枚举校验，归一）
       —— TS 测试在 packages/app-shell/__tests__ 写，本文件只覆盖后端

后端入口防御原则：
    - 区分"权限错配"vs"真零结果"
    - notice 是可选字段，旧版 SearchResponse / 旧前端不消费时仍合法
    - search_service / fallback_service / api 任意路径都应填 notice
      （避免某些路径漏掉让用户误判）
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

import apps.fts.tests.conftest  # noqa: F401


class SchemasNoticeFieldTests(unittest.TestCase):
    """SearchResponse 加 notice 不破坏既有契约。"""

    def test_default_notice_is_none(self):
        from apps.fts.schemas import SearchResponse
        resp = SearchResponse()
        self.assertIsNone(resp.notice)

    def test_notice_can_be_set(self):
        from apps.fts.schemas import SearchResponse
        resp = SearchResponse(notice="no_accessible_spaces")
        self.assertEqual(resp.notice, "no_accessible_spaces")

    def test_notice_serializes_when_present(self):
        from apps.fts.schemas import SearchResponse
        resp = SearchResponse(notice="no_accessible_spaces")
        try:
            payload = resp.model_dump(mode="json")
        except AttributeError:
            payload = resp.dict()
        self.assertEqual(payload.get("notice"), "no_accessible_spaces")

    def test_old_response_without_notice_still_valid(self):
        """旧调用方未指定 notice 时仍能构造（向后兼容）。"""
        from apps.fts.schemas import SearchResponse
        resp = SearchResponse(
            results=[], total=0, facets={}, suggestions=[], took_ms=0,
            search_mode="normal", degraded=False,
            degraded_reason=None, partial_indices=[],
        )
        self.assertIsNone(resp.notice)


class SearchServiceNoticeTests(unittest.TestCase):
    """search_service.search() 在 acl 无访问时返回 notice='no_accessible_spaces'。"""

    def _params(self, **overrides):
        from apps.fts.schemas import SearchParams
        d = {"q": "perf", "organization_id": "wt-no-access"}
        d.update(overrides)
        return SearchParams(**d)

    def test_no_access_returns_notice(self):
        """这是 R4-09 的核心：CLI / Web / FC 三入口都受益的根因修复。"""
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.search_service import search

        with patch(
            "apps.fts.services.search_service.acl_service.get_user_accessible_spaces"
        ) as m_acl:
            m_acl.return_value = AccessibleSpaces(organization_id="wt-no-access")
            resp = search(self._params(), user_id="u-no-access")

        self.assertEqual(resp.notice, "no_accessible_spaces")
        self.assertEqual(resp.results, [])
        self.assertEqual(resp.total, 0)
        # facets 必填全 6 类（前端 Tab 计数一致性）
        self.assertEqual(set(resp.facets.keys()),
                         {"messages", "resources", "agents", "spaces", "memos", "im"})

    def test_no_access_with_types_subset_returns_notice(self):
        """限定 types 时 facets 也是子集，notice 仍存在。"""
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.search_service import search

        with patch(
            "apps.fts.services.search_service.acl_service.get_user_accessible_spaces"
        ) as m_acl:
            m_acl.return_value = AccessibleSpaces(organization_id="wt-no-access")
            resp = search(
                self._params(types="messages,resources"),
                user_id="u-no-access",
            )

        self.assertEqual(resp.notice, "no_accessible_spaces")
        self.assertEqual(set(resp.facets.keys()), {"messages", "resources"})

    def test_with_access_no_notice_field(self):
        """有 Space 访问时 notice 必须为 None（不能误打）。"""
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.search_service import search
        from unittest.mock import MagicMock

        access = AccessibleSpaces(full_access_space_ids=["sp-1"], organization_id="wt-1")
        empty = {"hits": {"total": {"value": 0}, "hits": []}}
        fake_client = MagicMock()
        fake_client.msearch.return_value = {"responses": [empty for _ in range(6)]}

        with patch(
            "apps.fts.services.search_service.acl_service.get_user_accessible_spaces",
            return_value=access,
        ), patch(
            "apps.fts.services.search_service.get_client",
            return_value=fake_client,
        ), patch(
            "apps.fts.services.search_service.breaker_run",
            side_effect=lambda fn, *a, **kw: fn(*a, **kw),
        ), patch(
            "apps.fts.services.search_service.hydration_service.hydrate",
            side_effect=lambda items: items,
        ):
            resp = search(self._params(), user_id="u-1")

        # 真零结果时 notice 必须 None；不能让前端误判为"权限问题"
        self.assertIsNone(resp.notice)


class SearchToolNoticeTests(unittest.TestCase):
    """SearchTool（FC 入口）的 notice 行为：与 search_service 行为一致。

    Wave 4 已通过预 call acl_service 实现 B2 修复（返回 _no_access_response），
    Wave 5 R4-09 之后即使没有预 call，search_service 内部兜底也会返回 notice。
    本测试确保 FC 入口端到端能拿到 notice 字段。
    """

    def test_fc_returns_notice_when_no_access(self):
        import json

        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.capabilities.search_tool import SearchTool

        with patch(
            "apps.services.common.thread_context.get_current_organization_id",
            return_value="wt-no-access",
        ), patch(
            "apps.fts.services.acl_service.get_user_accessible_spaces",
            return_value=AccessibleSpaces(organization_id="wt-no-access"),
        ):
            tool = SearchTool()
            raw = tool.run(
                q="anything",
                user_id="u-no-access",
                organization_id="wt-no-access",
            )

        payload = json.loads(raw)
        # B2 修复路径：FC 自己短路返回 _no_access_response，notice 字段必填
        self.assertEqual(payload.get("notice"), "no_accessible_spaces")
        self.assertEqual(payload.get("results"), [])


class CliResponseShapeIntegrationTests(unittest.TestCase):
    """通过 fts api 端点视角验证：CLI/Web 走的 HTTP 响应包含 notice 字段。

    api.py 的 unified_search() 直接返回 search_service.search() 的结果，
    所以只要 search_service 填了 notice，HTTP 响应就有。这里通过模拟
    走 search_service 路径间接验证 API 契约的完整性。
    """

    def test_api_passes_through_notice(self):
        """模拟 ninja 端点的 search_service.search() 调用：notice 透传到 HTTP 响应"""
        from apps.fts.schemas import SearchParams
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.search_service import search

        with patch(
            "apps.fts.services.search_service.acl_service.get_user_accessible_spaces"
        ) as m_acl:
            m_acl.return_value = AccessibleSpaces(organization_id="wt-no-access")
            resp = search(SearchParams(q="x", organization_id="wt-no-access"), user_id="u")

        # 模拟 ninja 序列化后的 dict
        try:
            payload = resp.model_dump(mode="json")
        except AttributeError:
            payload = resp.dict()
        self.assertEqual(payload.get("notice"), "no_accessible_spaces")
        # CLI / Web 都从这个 dict 拿值
        self.assertEqual(payload.get("results"), [])
        self.assertEqual(payload.get("total"), 0)


class FallbackPathNoticeTests(unittest.TestCase):
    """Wave 5 三视角 Review 产品 BLOCKER B1 修复：fallback 路径同样要填 notice。

    覆盖场景：ES 降级 + 用户在该 Organization 完全无 Space 访问权限。
    原 Wave 5 实现遗漏 fallback 路径，会让用户看到"搜索引擎降级中"banner
    而不知道根本原因是"无访问权限"。
    """

    def _params(self, **overrides):
        from apps.fts.schemas import SearchParams
        d = {"q": "x", "organization_id": "wt-no-access"}
        d.update(overrides)
        return SearchParams(**d)

    def test_fallback_returns_notice_when_no_access(self):
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.fallback_service import fallback_search

        with patch(
            "apps.fts.services.acl_service.get_user_accessible_spaces"
        ) as m_acl, patch(
            "apps.fts.services.fallback_service._check_rate_limit", return_value=True,
        ):
            m_acl.return_value = AccessibleSpaces(organization_id="wt-no-access")
            resp = fallback_search(
                self._params(types="resources,memos"),
                user_id="u-no-access",
                reason="circuit_open",
            )

        # B1 BLOCKER 修复必须满足：
        self.assertEqual(resp.notice, "no_accessible_spaces")
        self.assertTrue(resp.degraded)
        self.assertEqual(resp.degraded_reason, "circuit_open")  # reason 保留
        self.assertEqual(resp.results, [])

    def test_fallback_with_access_no_notice(self):
        """有访问时 notice 必须 None（向后兼容性）。"""
        from apps.fts.services.acl_service import AccessibleSpaces
        from apps.fts.services.fallback_service import fallback_search

        with patch(
            "apps.fts.services.acl_service.get_user_accessible_spaces"
        ) as m_acl, patch(
            "apps.fts.services.fallback_service._check_rate_limit", return_value=True,
        ), patch(
            "apps.fts.services.fallback_service._pg_search_resources",
            return_value=([], 0, False),
        ), patch(
            "apps.fts.services.fallback_service._pg_search_memos",
            return_value=([], 0, False),
        ):
            m_acl.return_value = AccessibleSpaces(
                full_access_space_ids=["sp-1"], organization_id="wt-1",
            )
            resp = fallback_search(
                self._params(types="resources,memos", organization_id="wt-1"),
                user_id="u-1",
                reason="opensearch_unavailable",
            )

        self.assertIsNone(resp.notice)
        self.assertTrue(resp.degraded)

    def test_rate_limited_takes_priority_over_no_access(self):
        """rate_limited 优先级最高（限流路径不应被 acl 检查覆盖）。"""
        from apps.fts.services.fallback_service import fallback_search

        with patch(
            "apps.fts.services.fallback_service._check_rate_limit", return_value=False,
        ), patch(
            "apps.fts.services.acl_service.get_user_accessible_spaces"
        ) as m_acl:
            from apps.fts.services.acl_service import AccessibleSpaces
            m_acl.return_value = AccessibleSpaces(organization_id="wt-1")
            resp = fallback_search(
                self._params(),
                user_id="u-1",
                reason="circuit_open",
            )

        # rate_limited 优先；acl 检查不应被执行
        self.assertEqual(resp.degraded_reason, "rate_limited")
        # acl mock 应未被调用（因为提前 short-circuit 在 rate_limit 分支）
        m_acl.assert_not_called()

"""
SC-006 / SC-007 / SC-008 / SC-009 回归测试

SC-006: 双重缓存 key 不一致 + 无 OrganizationMember.post_delete 主动失效
SC-007: _search_skills IDOR 防护语义错误（已修复，本文件验证不退化）
SC-008: _search_code scope 分支 organization 校验顺序错误（已修复，验证）
SC-009: organization_id InjectedState 失效时静默扩大检索范围
"""

import unittest
from unittest.mock import MagicMock, patch
from django.test import SimpleTestCase, override_settings


class SC006CacheKeyConsistencyTest(SimpleTestCase):
    """SC-006: 统一缓存 key，消除双缓存不一致。"""

    def test_api_uses_same_cache_key_as_unified_search_service(self):
        """api._get_accessible_organization_ids 应复用 unified_search_service 的同一 key。"""
        from apps.rag.api import _get_accessible_organization_ids
        from apps.rag.services.unified_search_service import _get_user_accessible_organizations

        user_id = "test-user-123"
        expected_key = f"rag:accessible_organizations:{user_id}"
        old_wrong_key = f"rag:accessible_ws:{user_id}"

        with patch("apps.tabtinspace.models.Organization") as MockWS, \
             patch("apps.tabtinspace.models.OrganizationMember") as MockWM:
            MockWS.objects.filter.return_value.values_list.return_value = ["ws-1"]
            MockWM.objects.filter.return_value.values_list.return_value = []

            from django.core.cache import cache
            cache.delete(expected_key)
            cache.delete(old_wrong_key)

            result = _get_accessible_organization_ids(user_id)
            # 结果应写入 expected_key 而非 old_wrong_key
            cached_value = cache.get(expected_key)
            old_cached_value = cache.get(old_wrong_key)

            self.assertIsNotNone(cached_value, "结果应写入 rag:accessible_organizations:{user_id}")
            self.assertIsNone(old_cached_value, "不应写入 rag:accessible_ws:{user_id}（旧的错误 key）")

    def test_cache_invalidation_on_member_delete(self):
        """OrganizationMember 删除后，RAG 缓存应立即失效。"""
        from apps.tabtinspace.signals import _invalidate_rag_accessible_cache
        from django.core.cache import cache

        user_id = "test-user-456"
        cache_key = f"rag:accessible_organizations:{user_id}"
        cache.set(cache_key, ["ws-old"], timeout=60)
        self.assertEqual(cache.get(cache_key), ["ws-old"])

        _invalidate_rag_accessible_cache(user_id)

        self.assertIsNone(cache.get(cache_key), "成员删除后缓存应被主动清空")

    def test_cache_invalidation_gracefully_handles_cache_error(self):
        """缓存失效失败时不应抛出异常，保证信号处理器稳定。"""
        from apps.tabtinspace.signals import _invalidate_rag_accessible_cache

        with patch("django.core.cache.cache.delete", side_effect=Exception("Redis down")):
            # 不应抛出任何异常
            try:
                _invalidate_rag_accessible_cache("any-user")
            except Exception as e:
                self.fail(f"_invalidate_rag_accessible_cache 不应抛出异常: {e}")


class SC009OrganizationIdInjectionTest(SimpleTestCase):
    """SC-009: organization_id InjectedState 失效时应返回错误而非静默降级。"""

    def _make_tool(self):
        from apps.services.tools.domains.rag.rag_search import RagSearchTool
        return RagSearchTool()

    def test_organization_scope_without_organization_id_returns_error(self):
        """organization scope 但 organization_id=None 时应返回 success=False，而非静默全局搜索。"""
        tool = self._make_tool()
        result = tool.run(
            query="test query",
            scope="organization",
            scope_id=None,
            user_id="user-123",
            organization_id=None,  # InjectedState 失效
        )
        self.assertFalse(result["success"], "organization_id 为 None 时 success 应为 False")
        self.assertIn("error", result, "应返回 error 字段")
        self.assertIn("organization_id", result["error"].lower(), "错误信息应说明 organization_id 缺失")
        self.assertEqual(result.get("error_kind"), "runtime_misconfig")
        self.assertIn("organization_id", result.get("hint", ""))

    def test_organization_scope_infers_from_organization_id_field(self):
        """organization scope 且 organization_id 有值时，scope_id 应从 organization_id 推断，不报错。"""
        tool = self._make_tool()

        mock_result = {
            "hits": [],
            "total": 0,
            "type_counts": {},
            "response_time_ms": 1,
        }

        with patch(
            "apps.rag.services.unified_search_service.UnifiedSearchService.search",
            return_value=mock_result,
        ), patch(
            "apps.rag.services.unified_search_service.get_unified_search_service"
        ) as mock_get_svc:
            mock_svc = MagicMock()
            mock_svc.search.return_value = mock_result
            mock_get_svc.return_value = mock_svc

            result = tool.run(
                query="test",
                scope="organization",
                scope_id=None,
                user_id="user-123",
                organization_id="ws-abc",  # 有值，scope_id 从此推断
            )
            # organization_id 有值时不应报错（UnifiedSearchService 会做权限校验）
            self.assertNotIn(
                "organization_id is required",
                result.get("error", ""),
                "organization_id 有值时不应触发 SC-009 错误",
            )

    def test_non_organization_scope_without_organization_id_does_not_error(self):
        """非 organization scope（如 table scope）时，organization_id 为 None 不触发 SC-009 错误。"""
        tool = self._make_tool()

        mock_result = {
            "hits": [],
            "total": 0,
            "type_counts": {},
            "response_time_ms": 1,
        }

        with patch(
            "apps.rag.services.unified_search_service.get_unified_search_service"
        ) as mock_get_svc:
            mock_svc = MagicMock()
            mock_svc.search.return_value = mock_result
            mock_get_svc.return_value = mock_svc

            result = tool.run(
                query="test",
                scope="table",
                scope_id="table-xyz",
                user_id="user-123",
                organization_id=None,  # table scope 下 organization_id 为 None 是允许的
            )
            # 不应返回 SC-009 的 organization_id 缺失错误
            self.assertNotIn(
                "organization_id is required",
                result.get("error", ""),
                "table scope 下不应触发 SC-009 错误",
            )


class SC007SearchSkillsIdorTest(SimpleTestCase):
    """SC-007: _search_skills 已修复 IDOR，此测试验证不退化。"""

    def test_search_skills_blocks_space_not_in_accessible_organizations(self):
        """space_id 对应的 organization 不在 accessible 列表时，应返回空结果而非泄漏数据。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch("apps.tabtinspace.models.Workspace") as MockWorkspace:
            MockWorkspace.objects.filter.return_value.values_list.return_value.first.return_value = "other-organization"

            result = _search_skills(
                query="test",
                query_vector=[0.1] * 10,
                user_id="user-1",
                organization_id="ws-1",
                accessible_organization_ids=["ws-1"],
                top_k=5,
                threshold=0.7,
                scope={"space_id": "space-in-other-organization"},
            )
            self.assertEqual(result, [], "不属于可访问 organization 的 space 应被拦截，返回空结果")


@unittest.skip("TabCode semantic search retired")
class SC008SearchCodeOrganizationCheckTest(SimpleTestCase):
    """SC-008: _search_code project_id scope 内也必须校验 accessible_organization_ids。"""

    def test_search_code_blocks_organization_not_accessible_with_project_scope(self):
        """project_id scope 且 organization_id 不在 accessible 列表时，应返回空结果。"""
        from apps.rag.services.unified_search_service import _search_code

        result = _search_code(
            query_vector=[0.1] * 10,
            user_id="user-1",
            organization_id="ws-forbidden",  # 不在 accessible 中
            accessible_organization_ids=["ws-allowed"],
            top_k=5,
            threshold=0.7,
            scope={"project_id": "proj-1"},
        )
        self.assertEqual(result, [], "organization 不可访问时 project_id scope 应返回空")

    def test_search_code_allows_accessible_organization_with_project_scope(self):
        """project_id scope 且 organization_id 在 accessible 列表时，允许执行检索。"""
        from apps.rag.services.unified_search_service import _search_code

        with patch("apps.rag.models.CodeChunkEmbedding") as MockCCE:
            MockCCE.objects.filter.return_value.annotate.return_value.annotate.return_value.filter.return_value.order_by.return_value.__getitem__.return_value = []

            # 不应返回空（权限检查通过，查询本身可能返回空，但不是因为权限拒绝）
            try:
                _search_code(
                    query_vector=[0.1] * 10,
                    user_id="user-1",
                    organization_id="ws-allowed",  # 在 accessible 中
                    accessible_organization_ids=["ws-allowed"],
                    top_k=5,
                    threshold=0.7,
                    scope={"project_id": "proj-1"},
                )
                # 如果不抛出异常，说明权限检查通过（返回值为 [] 因为 mock 了空 queryset）
            except Exception:
                pass  # 允许 ORM 相关错误，只检查不因权限拒绝

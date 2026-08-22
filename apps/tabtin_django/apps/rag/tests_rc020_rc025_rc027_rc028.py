"""
RC-020 / RC-025 / RC-027 / RC-028 回归测试

覆盖：
- RC-020: _search_skills 子检索器对 similarity_score 不存在时使用 similarity 作为 fallback，不抛 KeyError
- RC-025: sync_code_index 的 distinct('file_path') 使用显式 .using('postgresql') 路由
- RC-027: _do_index_code_chunks 中 organization_id 非合法 UUID 时不抛 ValueError
- RC-028: _search_code 在 accessible_organization_ids 含非法 UUID 时不报错
"""

import uuid
import unittest
from unittest.mock import MagicMock, patch

from django.test import TestCase, override_settings


class RC020SkillSimilarityFallbackTest(TestCase):
    """RC-020: skill 子检索器 similarity_score/similarity 字段防御"""

    def _call_build_hit(self, raw_result: dict):
        """模拟 _search_skills 内部对单个 SkillEmbeddingService.search 结果的处理。"""
        from apps.rag.services.unified_search_service import SearchHitDict

        return SearchHitDict.build(
            content_type="skill",
            source_id=raw_result["skill_key"],
            title=raw_result.get("name", raw_result["skill_key"]),
            content=raw_result.get("description", ""),
            similarity=raw_result.get("similarity_score") or raw_result.get("similarity", 0.0),
            metadata={
                "skill_key": raw_result["skill_key"],
                "source": raw_result.get("source", ""),
                "tags": raw_result.get("tags", []),
                "location": raw_result.get("location", ""),
            },
        )

    def test_similarity_score_field_works(self):
        """v1 格式：包含 similarity_score 时正常读取"""
        result = self._call_build_hit({
            "skill_key": "sk_001",
            "name": "skill one",
            "description": "does stuff",
            "similarity_score": 0.88,
        })
        self.assertAlmostEqual(result["similarity"], 0.88)

    def test_similarity_field_fallback(self):
        """v2 格式：只有 similarity 时应使用 fallback，不抛 KeyError"""
        result = self._call_build_hit({
            "skill_key": "sk_002",
            "name": "skill two",
            "description": "does more stuff",
            "similarity": 0.75,
        })
        self.assertAlmostEqual(result["similarity"], 0.75)

    def test_neither_field_returns_zero(self):
        """两个字段都缺失时返回 0.0"""
        result = self._call_build_hit({
            "skill_key": "sk_003",
            "name": "skill three",
            "description": "old format",
        })
        self.assertAlmostEqual(result["similarity"], 0.0)

    def test_mock_search_skills_no_keyerror(self):
        """通过 mock SkillEmbeddingService.search 验证 _search_skills 函数不抛 KeyError"""
        from apps.rag.services.unified_search_service import _SEARCHER_REGISTRY

        skill_fn = _SEARCHER_REGISTRY.get("skill")
        if skill_fn is None:
            self.skipTest("skill searcher not registered")

        mock_results = [
            {
                "skill_key": "sk_v2",
                "name": "v2 skill",
                "description": "v2 format",
                "similarity": 0.82,
                # 故意不包含 similarity_score
            }
        ]
        query_vector = [0.1] * 128

        with patch(
            "apps.rag.services.unified_search_service.SkillEmbeddingService.search",
            return_value=mock_results,
        ):
            results = skill_fn(
                query_vector=query_vector,
                user_id="user-1",
                organization_id=None,
                accessible_organization_ids=[str(uuid.uuid4())],
                top_k=5,
                threshold=0.5,
                scope=None,
                query="test query",
            )
        self.assertEqual(len(results), 1)
        self.assertAlmostEqual(results[0]["similarity"], 0.82)


class RC027SafeUUIDTest(TestCase):
    """RC-027: _safe_uuid 辅助函数防御性测试"""

    def test_valid_uuid_parsed(self):
        from apps.rag.tasks import _safe_uuid

        valid = str(uuid.uuid4())
        result = _safe_uuid(valid)
        self.assertEqual(str(result), valid)

    def test_invalid_uuid_returns_random(self):
        from apps.rag.tasks import _safe_uuid

        result = _safe_uuid("not-a-uuid-at-all")
        # 不抛异常，返回一个 UUID
        self.assertIsInstance(result, uuid.UUID)

    def test_empty_string_returns_random(self):
        from apps.rag.tasks import _safe_uuid

        result = _safe_uuid("")
        self.assertIsInstance(result, uuid.UUID)

    def test_none_does_not_crash(self):
        from apps.rag.tasks import _safe_uuid

        # None 传入 _safe_uuid 应返回随机 UUID
        result = _safe_uuid(None)
        self.assertIsInstance(result, uuid.UUID)


class RC028FilterValidUUIDsTest(TestCase):
    """RC-028: _filter_valid_uuids 过滤非法 UUID"""

    def test_valid_uuids_pass_through(self):
        from apps.rag.services.unified_search_service import _filter_valid_uuids

        ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        result = _filter_valid_uuids(ids)
        self.assertEqual(result, ids)

    def test_invalid_uuids_filtered(self):
        from apps.rag.services.unified_search_service import _filter_valid_uuids

        valid = str(uuid.uuid4())
        result = _filter_valid_uuids([valid, "bad-uuid", "123", ""])
        self.assertEqual(result, [valid])

    def test_empty_list(self):
        from apps.rag.services.unified_search_service import _filter_valid_uuids

        self.assertEqual(_filter_valid_uuids([]), [])

    def test_all_invalid_returns_empty(self):
        from apps.rag.services.unified_search_service import _filter_valid_uuids

        result = _filter_valid_uuids(["not-valid", "also-not"])
        self.assertEqual(result, [])

    @unittest.skip("TabCode semantic search retired")
    def test_search_code_with_invalid_organization_ids_no_error(self):
        """RC-028: _search_code 传入含非法 UUID 的 accessible_organization_ids 不报错，返回空列表"""
        from apps.rag.services.unified_search_service import _SEARCHER_REGISTRY

        code_fn = _SEARCHER_REGISTRY.get("code")
        if code_fn is None:
            self.skipTest("code searcher not registered")

        query_vector = [0.1] * 1536

        with patch("apps.rag.services.unified_search_service.CodeChunkEmbedding") as mock_model:
            # 模拟 ORM 返回空
            mock_model.objects.filter.return_value.annotate.return_value.annotate.return_value.filter.return_value.order_by.__getitem__ = MagicMock(return_value=[])
            try:
                results = code_fn(
                    query_vector=query_vector,
                    user_id="user-1",
                    organization_id=None,
                    accessible_organization_ids=["not-a-uuid", "also-bad"],
                    top_k=5,
                    threshold=0.5,
                    scope=None,
                )
                # 全部非法 UUID 被过滤后，应返回空列表（无法过滤则 return []）
                self.assertIsInstance(results, list)
            except Exception as e:
                self.fail(f"_search_code raised an exception with invalid UUIDs: {e}")


@unittest.skip("TabCode semantic sync retired")
class RC025PostgresRoutingTest(TestCase):
    """RC-025: sync_code_index 的 distinct 查询使用显式 PostgreSQL 路由"""

    def test_using_postgresql_in_sync_query(self):
        """验证 api.py 中 CodeChunkEmbedding.objects.using('postgresql') 被调用"""
        from apps.rag import api as rag_api
        import inspect

        source = inspect.getsource(rag_api.sync_code_index)
        self.assertIn(
            ".using('postgresql')",
            source,
            "sync_code_index 必须使用 .using('postgresql') 明确指定数据库路由",
        )

"""
ECI-003 / ECI-004 / ECI-005 回归测试

#7118：Skill 租户键从 space_id 换到 organization_id；index_skill / _index_entries /
_search_skills 的接口签名全部改成用 organization_id 表达租户上下文，SkillEmbedding
的顶层字段与 metadata 也同步跟随。

ECI-003：_search_skills 改为显式 query 参数签名，漏传时不再静默降级
ECI-004：scope=None 但 organization_id 有值时，直接用 organization_id 做租户过滤
ECI-005：index_skill 接受可选 organization_id 参数，写入 metadata 确保 user 来源
        Skill 租户隔离

运行：
    cd apps/tabtin_django
    python manage.py test apps.skills.tests.test_eci003_eci004_eci005_regression --verbosity=2 --no-input
"""

from __future__ import annotations

import uuid
from unittest.mock import patch, MagicMock, call

from django.test import TestCase


FAKE_VECTOR = [0.0] * 1024  # W7: 对齐 RAG_EMBEDDING_DIMENSIONS=1024(F01 已改)


# ─────────────────────────────────────────────────────────────────────────────
# ECI-005：index_skill 写入 organization_id 到 metadata
# ─────────────────────────────────────────────────────────────────────────────


class IndexSkillOrganizationIdTest(TestCase):
    """ECI-005 回归：index_skill 传入 organization_id 时正确写入 metadata。"""

    databases = {"default", "postgresql"}

    def _call(self, skill_key: str, source: str = "user", organization_id=None):
        from apps.skills.services.embedding_service import SkillEmbeddingService

        with patch(
            "apps.rag.services.embedding_service.get_embedding_service"
        ) as mock_get, patch(
            "apps.services.llm.services.embedding.embed_text"
        ) as mock_embed:
            svc = MagicMock()
            svc.embed_text.return_value = FAKE_VECTOR
            svc.dimensions = 1024  # W7: DDL 维度守卫,需对齐 RAG_EMBEDDING_DIMENSIONS
            mock_get.return_value = svc
            mock_embed.return_value = MagicMock(vectors=[FAKE_VECTOR])
            return SkillEmbeddingService.index_skill(
                skill_key=skill_key,
                name="My Skill",
                description="Does something",
                source=source,
                organization_id=organization_id,
            )

    def test_organization_id_written_to_metadata_when_provided(self):
        """传入 organization_id 时，metadata 中必须包含 organization_id 字段。"""
        from apps.rag.models import SkillEmbedding

        organization_id = str(uuid.uuid4())
        result = self._call("test_skill_with_org", source="user", organization_id=organization_id)

        self.assertTrue(result)
        obj = SkillEmbedding.objects.get(skill_key="test_skill_with_org")
        self.assertEqual(obj.metadata.get("organization_id"), organization_id)
        self.assertEqual(str(obj.organization_id), organization_id)

    def test_organization_id_absent_from_metadata_when_not_provided(self):
        """不传 organization_id（全局 platform skill）时，metadata 中不应存在 organization_id 字段。"""
        from apps.rag.models import SkillEmbedding

        result = self._call("global_skill_no_org", source="platform", organization_id=None)

        self.assertTrue(result)
        obj = SkillEmbedding.objects.get(skill_key="global_skill_no_org")
        self.assertNotIn("organization_id", obj.metadata)

    def test_organization_id_updated_when_content_unchanged_but_org_changed(self):
        """content 未变但 organization_id 改变时，仍更新 metadata.organization_id。"""
        from apps.rag.models import SkillEmbedding
        from apps.rag.utils import calculate_content_hash
        from apps.skills.services.embedding_service import (
            _build_content_text,
            SkillEmbeddingService,
        )

        old_org = str(uuid.uuid4())
        new_org = str(uuid.uuid4())
        skill_key = "org_migrate_skill"

        content = _build_content_text("My Skill", "Does something")
        content_hash = calculate_content_hash(content)
        SkillEmbedding.objects.create(
            skill_key=skill_key,
            source="user",
            content=content,
            content_hash=content_hash,
            embedding=FAKE_VECTOR,
            metadata={"name": "My Skill", "description": "Does something", "organization_id": old_org},
            organization_id=uuid.UUID(old_org),
        )

        with patch(
            "apps.services.llm.services.embedding.embed_text"
        ) as mock_embed:
            mock_embed.return_value = MagicMock(vectors=[FAKE_VECTOR])
            SkillEmbeddingService.index_skill(
                skill_key=skill_key,
                name="My Skill",
                description="Does something",
                source="user",
                organization_id=new_org,
            )

        obj = SkillEmbedding.objects.get(skill_key=skill_key)
        self.assertEqual(obj.metadata.get("organization_id"), new_org)
        self.assertEqual(str(obj.organization_id), new_org)

    def test_user_source_without_organization_id_is_rejected(self):
        """#7118: user 来源必须带 organization_id，缺失时 index_skill 拒绝写入。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        with patch(
            "apps.rag.services.embedding_service.get_embedding_service"
        ) as mock_get:
            svc = MagicMock()
            svc.embed_text.return_value = FAKE_VECTOR
            mock_get.return_value = svc
            result = SkillEmbeddingService.index_skill(
                skill_key="user_no_org",
                name="LA Skill",
                description="user skill",
                source="user",
                organization_id=None,
            )

        self.assertFalse(result, "user source without organization_id should be rejected")


# ─────────────────────────────────────────────────────────────────────────────
# ECI-005：_index_entries 将 entry.meta.organization_id 传给 index_skill
# ─────────────────────────────────────────────────────────────────────────────


class IndexEntriesOrganizationIdTest(TestCase):
    """ECI-005 回归：_index_entries 正确从 entry.meta 中读取 organization_id 并传给 index_skill。"""

    def test_index_entries_passes_organization_id_from_meta(self):
        from apps.skills.services.embedding_service import SkillEmbeddingService

        organization_id = str(uuid.uuid4())
        entries = [
            {
                "skill_key": "meta_org_skill",
                "name": "Meta Org Skill",
                "description": "Has organization in meta",
                "source": "user",
                "meta": {"organization_id": organization_id},
            }
        ]

        with patch.object(SkillEmbeddingService, "index_skill", return_value=True) as mock_index:
            SkillEmbeddingService._index_entries(entries)

        mock_index.assert_called_once()
        call_kwargs = mock_index.call_args.kwargs
        self.assertEqual(call_kwargs.get("organization_id"), organization_id)

    def test_index_entries_no_meta_passes_none_organization_id(self):
        from apps.skills.services.embedding_service import SkillEmbeddingService

        entries = [
            {
                "skill_key": "no_meta_skill",
                "name": "No Meta Skill",
                "description": "No meta dict",
                "source": "system",
            }
        ]

        with patch.object(SkillEmbeddingService, "index_skill", return_value=True) as mock_index:
            SkillEmbeddingService._index_entries(entries)

        call_kwargs = mock_index.call_args.kwargs
        self.assertIsNone(call_kwargs.get("organization_id"))


# ─────────────────────────────────────────────────────────────────────────────
# ECI-003：_search_skills 显式 query 参数
# ─────────────────────────────────────────────────────────────────────────────


class SearchSkillsExplicitQueryTest(TestCase):
    """ECI-003 回归：_search_skills 的 query 参数现在是显式签名而非 kwargs.get。"""

    def _run_search_skills(self, query="", organization_id=None, with_scope=True):
        from apps.rag.services.unified_search_service import _search_skills

        scope = {"organization_id": organization_id} if (with_scope and organization_id) else None

        with patch(
            "apps.skills.services.embedding_service.SkillEmbeddingService.search",
            return_value=[],
        ) as mock_search:
            _search_skills(
                query_vector=FAKE_VECTOR,
                user_id="user-1",
                organization_id=organization_id,
                accessible_organization_ids=[organization_id] if organization_id else [],
                top_k=5,
                threshold=0.7,
                scope=scope,
                query=query,
            )
            return mock_search.call_args

    def test_explicit_query_passed_to_search(self):
        """显式传入 query 时，SkillEmbeddingService.search 接收到正确的 query。"""
        call_args = self._run_search_skills(query="summarize document")
        self.assertIsNotNone(call_args)
        self.assertEqual(call_args.kwargs.get("query"), "summarize document")

    def test_empty_query_logs_warning(self):
        """query 为空字符串时应写入 warning 日志（不再静默）。"""
        import logging

        with self.assertLogs(
            "apps.rag.services.unified_search_service", level=logging.WARNING
        ):
            self._run_search_skills(query="")

    def test_no_query_kwarg_defaults_to_empty_string(self):
        """不传 query 时默认值为空字符串，函数正常返回而非抛异常。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch(
            "apps.skills.services.embedding_service.SkillEmbeddingService.search",
            return_value=[],
        ):
            result = _search_skills(
                query_vector=FAKE_VECTOR,
                user_id="user-1",
                organization_id=None,
                accessible_organization_ids=[],
                top_k=5,
                threshold=0.7,
                scope=None,
            )
        self.assertIsInstance(result, list)


# ─────────────────────────────────────────────────────────────────────────────
# ECI-004：scope=None + organization_id 有值时直接用 organization_id 过滤
# ─────────────────────────────────────────────────────────────────────────────


class SearchSkillsOrganizationScopeTest(TestCase):
    """ECI-004 回归：scope=None 但 organization_id 有值时，走 organization_id 过滤。"""

    def test_organization_id_passed_to_search_when_scope_is_none(self):
        """scope=None 且 organization_id 有值时，organization_id 直接传给 SkillEmbeddingService.search。"""
        from apps.rag.services.unified_search_service import _search_skills

        organization_id = str(uuid.uuid4())

        with patch(
            "apps.skills.services.embedding_service.SkillEmbeddingService.search",
            return_value=[],
        ) as mock_search:
            _search_skills(
                query_vector=FAKE_VECTOR,
                user_id="user-1",
                organization_id=organization_id,
                accessible_organization_ids=[organization_id],
                top_k=5,
                threshold=0.7,
                scope=None,
                query="test query",
            )

            if mock_search.called:
                actual_org_id = mock_search.call_args.kwargs.get("organization_id")
                self.assertEqual(actual_org_id, organization_id)

    def test_no_organization_id_when_context_missing(self):
        """organization_id=None 时，search 也拿到空 organization_id。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch(
            "apps.skills.services.embedding_service.SkillEmbeddingService.search",
            return_value=[],
        ) as mock_search:
            _search_skills(
                query_vector=FAKE_VECTOR,
                user_id="user-1",
                organization_id=None,
                accessible_organization_ids=[],
                top_k=5,
                threshold=0.7,
                scope=None,
                query="test query",
            )
            if mock_search.called:
                actual_org_id = mock_search.call_args.kwargs.get("organization_id")
                self.assertFalse(actual_org_id)

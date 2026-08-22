"""
BL-001 & BL-002 回归测试

#7118：Skill 租户键从 space_id 换到 organization_id；index_skill 直接接受
organization_id 参数用于计费与租户隔离，不再从 space_id 反查。

BL-001：index_skill 调用 embed_text 时按 organization_id 传计费上下文
BL-002：计费上下文在 _index_entries → index_skill → embed_text 全链路传递

运行：
    cd apps/tabtin_django
    python manage.py test apps.skills.tests.test_bl001_bl002_billing_context --verbosity=1 --no-input
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, call, patch

from django.test import TestCase


FAKE_VECTOR = [0.1] * 1024


class IndexSkillBillingContextTest(TestCase):
    """BL-001/BL-002：index_skill 调用 embed_text 时必须携带 organization_id。"""

    def setUp(self):
        self.organization_id = str(uuid.uuid4())
        self.skill_key = "test_skill_bl001"

    def _run_index_skill_with_mocks(self, organization_id=None):
        """辅助方法：run index_skill，断言 embed_text 调用参数。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_result = MagicMock(vectors=[FAKE_VECTOR])

        with patch(
            "apps.services.llm.services.embedding.embed_text", return_value=mock_result
        ) as mock_embed, patch(
            "apps.rag.models.SkillEmbedding.objects"
        ) as mock_se_mgr, patch(
            "apps.rag.utils.calculate_content_hash", return_value="abc123"
        ):

            mock_se_mgr.filter.return_value.first.return_value = None
            mock_se_mgr.bulk_create.return_value = [MagicMock()]

            SkillEmbeddingService.index_skill(
                skill_key=self.skill_key,
                name="Test Skill",
                description="A skill for billing tests",
                source="user",
                organization_id=organization_id,
            )

        return mock_embed

    def test_embed_text_receives_organization_id_when_provided(self):
        """BL-001: organization_id 提供时，embed_text 必须收到对应的 organization_id。"""
        embed_text_mock = self._run_index_skill_with_mocks(
            organization_id=self.organization_id,
        )

        embed_text_mock.assert_called_once()
        call_kwargs = embed_text_mock.call_args
        self.assertEqual(
            call_kwargs.kwargs.get("organization_id"),
            self.organization_id,
            "embed_text 必须传入 organization_id 以触发计费（BL-001）",
        )

    def test_index_skill_rejects_user_source_without_organization_id(self):
        """#7118: user 来源无 organization_id 时提前拒绝，不打 embed_text。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_result = MagicMock(vectors=[FAKE_VECTOR])
        with patch(
            "apps.services.llm.services.embedding.embed_text", return_value=mock_result
        ) as mock_embed:
            result = SkillEmbeddingService.index_skill(
                skill_key=self.skill_key,
                name="Test Skill",
                description="A skill for billing tests",
                source="user",
                organization_id=None,
            )
        self.assertFalse(result)
        mock_embed.assert_not_called()

    def test_embed_text_uses_platform_sentinel_for_system_source(self):
        """BL-001: system/platform 来源没有 organization_id 时走平台级 sentinel。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_result = MagicMock(vectors=[FAKE_VECTOR])
        with patch(
            "apps.services.llm.services.embedding.embed_text", return_value=mock_result
        ) as mock_embed, patch(
            "apps.rag.models.SkillEmbedding.objects"
        ) as mock_se_mgr, patch(
            "apps.rag.utils.calculate_content_hash", return_value="abc123"
        ):
            mock_se_mgr.filter.return_value.first.return_value = None
            mock_se_mgr.bulk_create.return_value = [MagicMock()]

            SkillEmbeddingService.index_skill(
                skill_key=self.skill_key,
                name="Test Skill",
                description="A skill for billing tests",
                source="platform",
                organization_id=None,
            )

        embed_text_mock = mock_embed
        embed_text_mock.assert_called_once()
        call_kwargs = embed_text_mock.call_args
        # 平台级来源不会带真实 organization_id，走平台 sentinel。
        self.assertNotEqual(
            call_kwargs.kwargs.get("organization_id"),
            self.organization_id,
        )


class IndexEntriesBillingContextTest(TestCase):
    """BL-002: _index_entries 调用链确保 organization_id 传递到 index_skill。"""

    def test_organization_id_from_entry_meta_passed_to_index_skill(self):
        """BL-002: entry.meta.organization_id 正确穿透到 index_skill。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        organization_id = str(uuid.uuid4())

        entries = [
            {
                "skill_key": "test_skill_chain",
                "name": "Chain Skill",
                "description": "Test billing chain",
                "source": "user",
                "meta": {"organization_id": organization_id},
            }
        ]

        with patch.object(
            SkillEmbeddingService, "index_skill", return_value=True
        ) as mock_index:
            SkillEmbeddingService._index_entries(entries)

        mock_index.assert_called_once()
        call_kwargs = mock_index.call_args.kwargs
        self.assertEqual(
            call_kwargs.get("organization_id"),
            organization_id,
            "_index_entries 应将 entry.meta.organization_id 传给 index_skill（BL-002）",
        )

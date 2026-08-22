"""
SK-001 回归测试 — SkillEmbedding 幽灵记录防护与 repair 工具

#7118：租户键从 space_id 换到 organization_id；index_skill 拒绝无 organization_id
       的 user 来源写入，repair_ghost_local_agent_entries 清理历史遗留的幽灵记录
       （source=user 且 organization_id 为空）。

覆盖场景：
1. index_skill 对 user + 缺失 organization_id 应拒绝写入（返回 False，不打 ERROR）
2. index_skill 对 user + 有 organization_id 应正常索引
3. search() 不返回无 organization_id 的 user 幽灵记录
4. search() 对合法 user 记录按 organization_id 正确隔离
5. repair_ghost_local_agent_entries() 删除幽灵记录并返回正确计数
6. repair_ghost_local_agent_entries() 不影响正常 user 记录
7. repair_ghost_local_agent_entries() 不影响非 user 记录

运行：
    cd apps/tabtin_django
    python manage.py test apps.skills.tests.test_sk001_ghost_record_regression --verbosity=2 --no-input
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import TestCase

FAKE_VECTOR = [0.0] * 1024  # W7: 对齐 RAG_EMBEDDING_DIMENSIONS=1024


def _create_skill_embedding_direct(skill_key, source="system", organization_id=None):
    """直接创建 SkillEmbedding（绕过 index_skill），用于构造历史幽灵记录场景。"""
    from apps.rag.models import SkillEmbedding

    metadata: dict = {"name": skill_key, "description": f"desc for {skill_key}"}
    if organization_id is not None:
        metadata["organization_id"] = str(organization_id)

    org_uuid = None
    if organization_id:
        try:
            org_uuid = uuid.UUID(str(organization_id))
        except (ValueError, TypeError):
            org_uuid = None

    return SkillEmbedding.objects.create(
        skill_key=skill_key,
        source=source,
        content=f"content for {skill_key}",
        content_hash=uuid.uuid4().hex[:64],
        embedding=FAKE_VECTOR,
        metadata=metadata,
        organization_id=org_uuid,
    )


# ─────────────────────────────────────────────────────────────
# 1. index_skill 拒绝幽灵记录产生
# ─────────────────────────────────────────────────────────────

class IndexSkillGhostPreventionTest(TestCase):
    """SK-001: index_skill 对 user + 缺失 organization_id 应拒绝写入。"""

    databases = "__all__"

    @patch("apps.rag.services.embedding_service.get_embedding_service")
    def test_user_without_organization_id_is_rejected(self, mock_get_svc):
        """user 无 organization_id → 返回 False，不写库。"""
        from apps.rag.models import SkillEmbedding
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_svc = MagicMock()
        mock_svc.embed_text.return_value = FAKE_VECTOR
        mock_svc.dimensions = 1024
        mock_get_svc.return_value = mock_svc

        result = SkillEmbeddingService.index_skill(
            skill_key="ghost_skill_no_org",
            name="GhostSkill",
            description="无 organization_id 的 user-source skill",
            source="user",
            organization_id=None,
        )

        self.assertFalse(result, "user 无 organization_id 应返回 False")
        self.assertFalse(
            SkillEmbedding.objects.filter(skill_key="ghost_skill_no_org").exists(),
            "不应写入数据库",
        )
        mock_svc.embed_text.assert_not_called()

    @patch("apps.rag.services.embedding_service.get_embedding_service")
    def test_user_with_empty_string_organization_id_is_rejected(self, mock_get_svc):
        """user + 空字符串 organization_id → 返回 False，不写库。"""
        from apps.rag.models import SkillEmbedding
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_svc = MagicMock()
        mock_svc.embed_text.return_value = FAKE_VECTOR
        mock_svc.dimensions = 1024
        mock_get_svc.return_value = mock_svc

        result = SkillEmbeddingService.index_skill(
            skill_key="ghost_skill_empty_org",
            name="GhostSkillEmpty",
            description="空字符串 organization_id",
            source="user",
            organization_id="",
        )

        self.assertFalse(result, "user 空字符串 organization_id 应返回 False")
        self.assertFalse(
            SkillEmbedding.objects.filter(skill_key="ghost_skill_empty_org").exists(),
        )

    @patch("apps.services.llm.services.embedding.embed_text")
    def test_user_with_valid_organization_id_is_indexed(self, mock_embed):
        """user + 有效 organization_id → 正常写入。"""
        from apps.rag.models import SkillEmbedding
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_embed.return_value = MagicMock(vectors=[FAKE_VECTOR])

        organization_id = str(uuid.uuid4())
        result = SkillEmbeddingService.index_skill(
            skill_key="valid_user_skill",
            name="ValidLocalSkill",
            description="有效的 user skill",
            source="user",
            organization_id=organization_id,
        )

        self.assertTrue(result, "有效 user 应返回 True")
        record = SkillEmbedding.objects.get(skill_key="valid_user_skill")
        self.assertEqual(record.metadata.get("organization_id"), organization_id)
        self.assertEqual(str(record.organization_id), organization_id)

    @patch("apps.services.llm.services.embedding.embed_text")
    def test_platform_skill_without_organization_id_is_indexed(self, mock_embed):
        """platform 类型技能不需要 organization_id，应正常写入。

        : source canonical → platform/app/device/user；`system` 不再是有效
        source（fallback 会归到 user，需强制 organization_id）。
        """
        from apps.rag.models import SkillEmbedding
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_embed.return_value = MagicMock(vectors=[FAKE_VECTOR])

        result = SkillEmbeddingService.index_skill(
            skill_key="platform_skill_no_org",
            name="PlatformSkill",
            description="平台技能不需要 organization_id",
            source="platform",
            organization_id=None,
        )

        self.assertTrue(result, "platform 技能不需要 organization_id，应返回 True")
        self.assertTrue(
            SkillEmbedding.objects.filter(skill_key="platform_skill_no_org").exists()
        )

    @patch("apps.skills.services.embedding_service.logger")
    def test_private_user_skill_skip_does_not_log_error(self, mock_logger):
        """个人技能默认没有 organization_id，跳过写入但不打 ERROR。"""
        from apps.rag.models import SkillEmbedding
        from apps.skills.services.embedding_service import SkillEmbeddingService

        result = SkillEmbeddingService.index_skill(
            skill_key="user:skill-2",
            name="skill",
            description="个人技能",
            source="user",
            organization_id=None,
        )

        self.assertFalse(result)
        self.assertFalse(SkillEmbedding.objects.filter(skill_key="user:skill-2").exists())
        mock_logger.error.assert_not_called()
        mock_logger.info.assert_called()


class CollectAllUserSkillsSkipsPersonalTest(TestCase):
    """全局全量扫描不应把没有组织的个人技能送进向量索引。"""

    databases = "__all__"

    def test_collect_skips_personal_skills_without_organization_id(self):
        from apps.skills.models import Skill
        from apps.skills.services.embedding_service import SkillEmbeddingService

        owner_id = uuid.uuid4()
        org_id = uuid.uuid4()
        Skill.objects.create(
            owner_user_id=owner_id,
            slug="skill-2",
            name="skill",
            visibility=Skill.VISIBILITY_PRIVATE,
            organization_id=None,
        )
        Skill.objects.create(
            owner_user_id=owner_id,
            slug="shared-skill",
            name="Shared",
            visibility=Skill.VISIBILITY_ORGANIZATION,
            organization_id=org_id,
        )

        keys = {
            entry.get("skill_key")
            for entry in SkillEmbeddingService._collect_all_user_skills()
        }

        self.assertNotIn("user:skill-2", keys)
        self.assertIn("user:shared-skill", keys)

    @patch("apps.skills.services.embedding_service.SkillEmbeddingService._index_entries")
    @patch("apps.skills.services.registry_service.SkillsRegistryService.list_user_skills_visible")
    def test_index_organization_does_not_stamp_private_skills(
        self, mock_visible, mock_index,
    ):
        from apps.skills.services.embedding_service import SkillEmbeddingService

        org_id = str(uuid.uuid4())
        mock_visible.return_value = [
            {
                "skill_key": "user:skill-2",
                "source": "user",
                "visibility": "private",
                "organization_id": None,
            },
            {
                "skill_key": "user:shared-skill",
                "source": "user",
                "visibility": "organization",
                "organization_id": org_id,
            },
        ]
        mock_index.return_value = {"indexed": 0, "skipped": 1, "failed": 0}

        SkillEmbeddingService.index_organization_skills(
            user_id=str(uuid.uuid4()),
            organization_id=org_id,
        )

        indexed = mock_index.call_args[0][0]
        keys = {entry.get("skill_key") for entry in indexed}
        self.assertNotIn("user:skill-2", keys)
        self.assertIn("user:shared-skill", keys)


# ─────────────────────────────────────────────────────────────
# 2. search() 幽灵记录不可见
# ─────────────────────────────────────────────────────────────

class SearchGhostRecordIsolationTest(TestCase):
    """SK-001: search() 中幽灵 user 记录不可见，合法记录按 organization_id 隔离。"""

    databases = "__all__"

    def setUp(self):
        self.org_a = str(uuid.uuid4())
        self.org_b = str(uuid.uuid4())
        # 幽灵记录：user 无 organization_id（直接写库模拟历史数据）
        self.ghost = _create_skill_embedding_direct(
            "ghost_visible_test", source="user", organization_id=None
        )
        self.org_a_skill = _create_skill_embedding_direct(
            "org_a_skill", source="user", organization_id=self.org_a,
        )
        self.org_b_skill = _create_skill_embedding_direct(
            "org_b_skill", source="user", organization_id=self.org_b,
        )
        self.system_skill = _create_skill_embedding_direct(
            "system_global", source="system"
        )

    def test_search_with_org_a_excludes_ghost_and_org_b(self):
        """使用 org_a 搜索时：幽灵记录和 org_b 的 user 记录均不可见。"""
        from apps.rag.models import SkillEmbedding
        from django.db.models import Q

        qs = SkillEmbedding.objects.filter(
            ~Q(source="user")
            | Q(source="user", organization_id=uuid.UUID(self.org_a))
        )
        keys = set(qs.values_list("skill_key", flat=True))

        self.assertIn("system_global", keys, "全局系统技能应可见")
        self.assertIn("org_a_skill", keys, "org_a 的合法 user 应可见")
        self.assertNotIn("org_b_skill", keys, "org_b 的 user 不应可见")
        self.assertNotIn("ghost_visible_test", keys, "幽灵记录不应可见（无 organization_id）")

    def test_search_without_organization_id_excludes_all_user(self):
        """不传 organization_id 时：所有 user（包括幽灵）均被排除。"""
        from apps.rag.models import SkillEmbedding

        qs = SkillEmbedding.objects.exclude(source="user")
        keys = set(qs.values_list("skill_key", flat=True))

        self.assertIn("system_global", keys)
        self.assertNotIn("ghost_visible_test", keys)
        self.assertNotIn("org_a_skill", keys)
        self.assertNotIn("org_b_skill", keys)


# ─────────────────────────────────────────────────────────────
# 3. repair_ghost_local_agent_entries()
# ─────────────────────────────────────────────────────────────

class RepairGhostEntriesTest(TestCase):
    """SK-001: repair_ghost_local_agent_entries() 正确删除幽灵记录。"""

    databases = "__all__"

    def test_repair_deletes_ghost_records_and_returns_count(self):
        """幽灵记录（canonical source 'user' 无 organization_id）被删除。"""
        from apps.rag.models import SkillEmbedding
        from apps.skills.services.embedding_service import SkillEmbeddingService

        _create_skill_embedding_direct("ghost-1", source="user", organization_id=None)
        SkillEmbedding.objects.create(
            skill_key="ghost-2",
            source="user",
            content="ghost 2",
            content_hash=uuid.uuid4().hex[:64],
            embedding=FAKE_VECTOR,
            metadata={},
        )
        valid_org = str(uuid.uuid4())
        _create_skill_embedding_direct(
            "valid-local", source="user", organization_id=valid_org,
        )

        count = SkillEmbeddingService.repair_ghost_local_agent_entries()

        self.assertEqual(count, 2, "应删除 2 条幽灵记录")
        self.assertFalse(SkillEmbedding.objects.filter(skill_key="ghost-1").exists())
        self.assertFalse(SkillEmbedding.objects.filter(skill_key="ghost-2").exists())
        self.assertTrue(SkillEmbedding.objects.filter(skill_key="valid-local").exists())

    def test_repair_does_not_affect_non_local_agent_records(self):
        """repair 不影响非 user 类型的技能记录。"""
        from apps.rag.models import SkillEmbedding
        from apps.skills.services.embedding_service import SkillEmbeddingService

        _create_skill_embedding_direct("sys-skill", source="system")
        _create_skill_embedding_direct("market-skill", source="market")
        _create_skill_embedding_direct("managed-skill", source="managed")

        count = SkillEmbeddingService.repair_ghost_local_agent_entries()

        self.assertEqual(count, 0, "无幽灵记录时应返回 0")
        self.assertTrue(SkillEmbedding.objects.filter(skill_key="sys-skill").exists())
        self.assertTrue(SkillEmbedding.objects.filter(skill_key="market-skill").exists())
        self.assertTrue(SkillEmbedding.objects.filter(skill_key="managed-skill").exists())

    def test_repair_returns_zero_when_no_ghosts(self):
        """无幽灵记录时返回 0。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        _create_skill_embedding_direct(
            "la-ok", source="user", organization_id=str(uuid.uuid4()),
        )

        count = SkillEmbeddingService.repair_ghost_local_agent_entries()
        self.assertEqual(count, 0)

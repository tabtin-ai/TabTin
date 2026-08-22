"""
EQ-003 回归测试：_cleanup_stale 跨租户数据删除防护

验证：
1. scope_source="global" 不删除 user 来源数据
2. scope_source="organization" 仅删除指定 organization_id 的 user 数据
3. scope_source=None（无效 scope）拒绝执行，返回 0
4. index_all_skills(user_id, organization_id) 不影响其他 organization 的数据

#7118：租户键从 space_id 换到 organization_id；index_all_skills 用 organization_id
       决定作用域，_cleanup_stale 的 scope 也按 organization_id 过滤。

运行：
    cd apps/tabtin_django
    python manage.py test apps.skills.tests.test_eq003_cleanup_stale --database=postgresql
"""

import uuid
from unittest.mock import patch, MagicMock

from django.test import TestCase


FAKE_VECTOR = [0.0] * 1024  # W7: 对齐 RAG_EMBEDDING_DIMENSIONS=1024


def _create_skill_embedding(skill_key, source="system", organization_id=None):
    """Helper to create a SkillEmbedding record for tests.

     修订：
    - canonical source 是 platform/app/user；旧 'local_agent' 已废，兼容映射到 'user'。
    - 租户键从 space_id 换到 organization_id（原生 UUIDField）。
    """
    from apps.rag.models import SkillEmbedding

    metadata = {"name": skill_key, "description": f"desc for {skill_key}"}
    if organization_id:
        metadata["organization_id"] = str(organization_id)

    canonical_source = "user" if source == "local_agent" else source

    org_uuid = None
    if organization_id:
        try:
            org_uuid = uuid.UUID(str(organization_id))
        except (ValueError, TypeError):
            org_uuid = None

    return SkillEmbedding.objects.create(
        skill_key=skill_key,
        source=canonical_source,
        content=f"content for {skill_key}",
        content_hash=uuid.uuid4().hex[:64],
        embedding=FAKE_VECTOR,
        metadata=metadata,
        organization_id=org_uuid,
    )


class CleanupStaleScopeGlobalTest(TestCase):
    """scope_source='global' 只清理非 user 来源的过时数据。"""

    databases = "__all__"

    def test_global_scope_preserves_local_agent(self):
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        org_a = str(uuid.uuid4())
        org_b = str(uuid.uuid4())
        _create_skill_embedding("sys-active", source="system")
        _create_skill_embedding("sys-stale", source="system")
        _create_skill_embedding("local-ws1", source="local_agent", organization_id=org_a)
        _create_skill_embedding("local-ws2", source="local_agent", organization_id=org_b)

        current = [{"skill_key": "sys-active"}]
        deleted = SkillEmbeddingService._cleanup_stale(
            current, scope_source="global"
        )

        self.assertEqual(deleted, 1)
        remaining_keys = set(
            SkillEmbedding.objects.values_list("skill_key", flat=True)
        )
        self.assertIn("sys-active", remaining_keys)
        self.assertNotIn("sys-stale", remaining_keys)
        self.assertIn("local-ws1", remaining_keys)
        self.assertIn("local-ws2", remaining_keys)


class CleanupStaleOrganizationScopeTest(TestCase):
    """scope_source='organization' 仅清理指定 organization_id 的 user 过时数据。"""

    databases = "__all__"

    def test_organization_scope_only_deletes_target_organization(self):
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        org_a = str(uuid.uuid4())
        org_b = str(uuid.uuid4())
        _create_skill_embedding("local-ws1-a", source="local_agent", organization_id=org_a)
        _create_skill_embedding("local-ws1-stale", source="local_agent", organization_id=org_a)
        _create_skill_embedding("local-ws2-a", source="local_agent", organization_id=org_b)
        _create_skill_embedding("sys-global", source="system")

        current = [{"skill_key": "local-ws1-a"}]
        deleted = SkillEmbeddingService._cleanup_stale(
            current, scope_source="organization", organization_id=org_a
        )

        self.assertEqual(deleted, 1)
        remaining_keys = set(
            SkillEmbedding.objects.values_list("skill_key", flat=True)
        )
        self.assertIn("local-ws1-a", remaining_keys)
        self.assertNotIn("local-ws1-stale", remaining_keys)
        self.assertIn("local-ws2-a", remaining_keys)
        self.assertIn("sys-global", remaining_keys)

    def test_organization_scope_does_not_touch_other_organization(self):
        """关键回归：清理 org_a 不影响 org_b 的任何数据。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        org_a = str(uuid.uuid4())
        org_b = str(uuid.uuid4())
        _create_skill_embedding("local-ws2-x", source="local_agent", organization_id=org_b)
        _create_skill_embedding("local-ws2-y", source="local_agent", organization_id=org_b)

        current = []
        deleted = SkillEmbeddingService._cleanup_stale(
            current, scope_source="organization", organization_id=org_a
        )

        self.assertEqual(deleted, 0)
        self.assertEqual(SkillEmbedding.objects.count(), 2)


class CleanupStaleNullScopeGuardTest(TestCase):
    """scope_source=None（无效 scope）必须拒绝执行，不删除任何数据。"""

    databases = "__all__"

    def test_null_scope_refuses_and_returns_zero(self):
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        _create_skill_embedding("sys-a", source="system")
        _create_skill_embedding(
            "local-a", source="local_agent", organization_id=str(uuid.uuid4()),
        )

        deleted = SkillEmbeddingService._cleanup_stale(
            [], scope_source=None
        )

        self.assertEqual(deleted, 0)
        self.assertEqual(SkillEmbedding.objects.count(), 2)

    def test_organization_scope_without_organization_id_refuses(self):
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        _create_skill_embedding("sys-b", source="system")

        deleted = SkillEmbeddingService._cleanup_stale(
            [], scope_source="organization", organization_id=None
        )

        self.assertEqual(deleted, 0)
        self.assertEqual(SkillEmbedding.objects.count(), 1)


class IndexAllSkillsCrossTenantTest(TestCase):
    """index_all_skills(user_id, organization_id) 不得删除其他 organization 数据。

    这是 EQ-003 的核心回归场景。
    """

    databases = "__all__"

    @patch("apps.skills.services.embedding_service.SkillEmbeddingService._index_entries")
    @patch("apps.skills.services.registry_service.SkillsRegistryService.list_available_skills")
    def test_index_all_with_organization_does_not_delete_other_organization(
        self, mock_list, mock_index
    ):
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        other_org = str(uuid.uuid4())
        target_org = str(uuid.uuid4())
        _create_skill_embedding(
            "other-ws-skill", source="local_agent", organization_id=other_org,
        )
        _create_skill_embedding(
            "target-ws-stale", source="local_agent", organization_id=target_org,
        )
        _create_skill_embedding(
            "target-ws-active", source="local_agent", organization_id=target_org,
        )
        _create_skill_embedding("global-sys", source="system")

        mock_list.return_value = [
            {"skill_key": "target-ws-active", "source": "user"},
            {"skill_key": "global-sys", "source": "system"},
        ]
        mock_index.return_value = {"indexed": 0, "skipped": 2, "failed": 0}

        SkillEmbeddingService.index_all_skills(
            user_id="user-1",
            organization_id=target_org,
            agent_id=str(uuid.uuid4()),
        )

        remaining_keys = set(
            SkillEmbedding.objects.values_list("skill_key", flat=True)
        )
        self.assertIn("other-ws-skill", remaining_keys,
                       "其他 organization 的 user 数据不应被删除")
        self.assertIn("global-sys", remaining_keys,
                       "全局 system skill 不应被删除")
        self.assertIn("target-ws-active", remaining_keys,
                       "当前 organization 的活跃 skill 不应被删除")
        self.assertNotIn("target-ws-stale", remaining_keys,
                         "当前 organization 的过时 user skill 应被清理")

    @patch("apps.skills.services.embedding_service.SkillEmbeddingService._index_entries")
    @patch("apps.skills.services.registry_service.SkillsRegistryService.list_app_skills")
    @patch("apps.skills.services.registry_service.SkillsRegistryService.list_platform_skills")
    @patch("apps.skills.services.embedding_service.SkillEmbeddingService._collect_all_user_skills")
    @patch("apps.skills.services.registry_service.SkillsRegistryService.merge_skills")
    def test_index_all_global_preserves_local_agent(
        self, mock_merge, mock_managed, mock_platform, mock_app, mock_index
    ):
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        _create_skill_embedding(
            "local-ws1", source="local_agent", organization_id=str(uuid.uuid4()),
        )
        _create_skill_embedding("sys-active", source="system")
        _create_skill_embedding("sys-stale", source="system")

        mock_app.return_value = []
        mock_platform.return_value = []
        mock_managed.return_value = []
        mock_merge.return_value = [{"skill_key": "sys-active", "source": "system"}]
        mock_index.return_value = {"indexed": 0, "skipped": 1, "failed": 0}

        SkillEmbeddingService.index_all_skills()

        remaining_keys = set(
            SkillEmbedding.objects.values_list("skill_key", flat=True)
        )
        self.assertIn("local-ws1", remaining_keys,
                       "全局索引不应删除 user 数据")
        self.assertIn("sys-active", remaining_keys)
        self.assertNotIn("sys-stale", remaining_keys,
                         "过时的全局 skill 应被清理")

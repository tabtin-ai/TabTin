"""
回归测试：SK-002、SK-003、SK-004 修复验证

SK-002: SkillEmbedding 添加顶层 organization_id/space_id 字段，迁移到 B-tree 索引查询
SK-003: 补充 TableEmbedding organization_id 回填 Beat 任务，migration 0014 补回填逻辑
SK-004: index_skill() 改用 bulk_create(update_conflicts=True) 消除 TOCTOU 竞态
"""

import uuid
import inspect
from unittest.mock import patch, MagicMock
from django.test import TestCase, override_settings


class TestSK002SkillEmbeddingNativeFields(TestCase):
    """SK-002: SkillEmbedding 模型必须有原生 organization_id/space_id 字段。"""

    def test_skillembedding_has_organization_id_field(self):
        """SkillEmbedding 必须有顶层 organization_id 字段。"""
        from apps.rag.models import SkillEmbedding
        field_names = [f.name for f in SkillEmbedding._meta.get_fields()]
        self.assertIn("organization_id", field_names, "SkillEmbedding 必须有原生 organization_id 字段")

    def test_skillembedding_has_space_id_field(self):
        """SkillEmbedding 必须有顶层 space_id 字段。"""
        from apps.rag.models import SkillEmbedding
        field_names = [f.name for f in SkillEmbedding._meta.get_fields()]
        self.assertIn("space_id", field_names, "SkillEmbedding 必须有原生 space_id 字段")

    def test_skillembedding_organization_id_is_uuid_nullable(self):
        """organization_id 字段必须是 UUIDField，允许 null。"""
        from apps.rag.models import SkillEmbedding
        from django.db import models as dm
        field = SkillEmbedding._meta.get_field("organization_id")
        self.assertIsInstance(field, dm.UUIDField)
        self.assertTrue(field.null, "organization_id 应允许 null（兼容历史数据）")
        self.assertTrue(field.db_index, "organization_id 应有 db_index")

    def test_skillembedding_space_id_is_uuid_nullable(self):
        """space_id 字段必须是 UUIDField，允许 null。"""
        from apps.rag.models import SkillEmbedding
        from django.db import models as dm
        field = SkillEmbedding._meta.get_field("space_id")
        self.assertIsInstance(field, dm.UUIDField)
        self.assertTrue(field.null, "space_id 应允许 null（兼容历史数据）")
        self.assertTrue(field.db_index, "space_id 应有 db_index")

    def test_search_does_not_use_jsonb_space_id(self):
        """search() 方法不应再使用 JSONB metadata__space_id 查询。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService
        src = inspect.getsource(SkillEmbeddingService.search)
        self.assertNotIn(
            "metadata__space_id=space_id",
            src,
            "search() 不应使用 JSONB 路径 metadata__space_id=space_id，应改为原生 space_id 字段"
        )
        self.assertIn(
            "space_id=space_uuid_filter",
            src,
            "search() 应使用原生字段查询 space_id=space_uuid_filter"
        )

    def test_get_all_local_agent_organization_ids_does_not_use_jsonb(self):
        """get_all_local_agent_organization_ids 不应再使用 JSONB 路径查询。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService
        src = inspect.getsource(SkillEmbeddingService.get_all_local_agent_organization_ids)
        self.assertNotIn(
            "metadata__space_id",
            src,
            "get_all_local_agent_organization_ids 不应再使用 JSONB 路径，应改为原生 space_id 字段"
        )

    def test_index_skill_writes_space_id_native_field(self):
        """index_skill() 创建 SkillEmbedding 对象时应设置顶层 space_id 字段。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService
        src = inspect.getsource(SkillEmbeddingService.index_skill)
        self.assertIn("space_id=space_uuid", src, "index_skill 应将 space_id 写入原生字段")


class TestSK003TableEmbeddingOrganizationBackfill(TestCase):
    """SK-003: backfill_table_metadata_task 必须存在并注册到 Beat 调度。"""

    def test_backfill_table_metadata_task_exists(self):
        """backfill_table_metadata_task 任务必须存在于 rag/tasks.py。"""
        from apps.rag import tasks
        self.assertTrue(
            hasattr(tasks, "backfill_table_metadata_task"),
            "backfill_table_metadata_task 任务必须存在于 rag/tasks.py"
        )

    def test_backfill_table_metadata_in_beat_schedule(self):
        """rag-backfill-table-metadata-daily 必须注册在 RAG_BEAT_SCHEDULE 中。"""
        from apps.rag.tasks import RAG_BEAT_SCHEDULE
        self.assertIn(
            "rag-backfill-table-metadata-daily",
            RAG_BEAT_SCHEDULE,
            "rag-backfill-table-metadata-daily 必须在 RAG_BEAT_SCHEDULE 中"
        )
        self.assertEqual(
            RAG_BEAT_SCHEDULE["rag-backfill-table-metadata-daily"]["task"],
            "rag.backfill_table_metadata",
        )

    def test_migration_0014_has_workteam_id_backfill(self):
        """migration 0014 应包含回填 TableEmbedding/RecordEmbedding organization_id 的函数。"""
        import importlib
        migration = importlib.import_module(
            "apps.rag.migrations.0014_skillembedding_workteam_id_space_id"
        )
        self.assertTrue(
            hasattr(migration, "backfill_table_record_workteam_id"),
            "migration 0014 应有 backfill_table_record_workteam_id 函数（SK-003 修复）"
        )

    def test_backfill_task_handles_metadata_organization_id(self):
        """backfill_table_metadata_task 应从 metadata.organization_id 回填。"""
        from apps.rag import tasks
        src = inspect.getsource(tasks.backfill_table_metadata_task)
        self.assertIn("organization_id", src)
        self.assertIn("metadata", src)
        self.assertIn("TableEmbedding", src)


class TestSK004IndexSkillNoConcurrencyRace(TestCase):
    """SK-004: index_skill() 必须使用 bulk_create(update_conflicts=True) 而非 update_or_create。"""

    def test_index_skill_uses_bulk_create_not_update_or_create(self):
        """index_skill 不应再调用 update_or_create（有 TOCTOU 竞态）。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService
        src = inspect.getsource(SkillEmbeddingService.index_skill)
        self.assertNotIn(
            ".update_or_create(",
            src,
            "index_skill 不应使用 update_or_create（TOCTOU 竞态），应改为 bulk_create"
        )

    def test_index_skill_uses_bulk_create_update_conflicts(self):
        """index_skill 必须使用 bulk_create(update_conflicts=True)。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService
        src = inspect.getsource(SkillEmbeddingService.index_skill)
        self.assertIn("bulk_create", src, "index_skill 应使用 bulk_create")
        self.assertIn("update_conflicts=True", src, "必须设置 update_conflicts=True")

    def test_index_skill_unique_fields_is_skill_key(self):
        """bulk_create 的 unique_fields 应为 skill_key。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService
        src = inspect.getsource(SkillEmbeddingService.index_skill)
        self.assertIn('"skill_key"', src, "unique_fields 应包含 skill_key")

    def test_index_skill_with_mock_returns_true_on_new_content(self):
        """index_skill 对新内容应返回 True（成功索引）。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_qs = MagicMock()
        mock_qs.filter.return_value.first.return_value = None

        mock_svc = MagicMock()
        mock_svc.embed_text.return_value = [0.1] * 1024
        mock_svc.dimensions = 1024

        with patch("apps.rag.models.SkillEmbedding.objects", mock_qs), \
             patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc), \
             patch("apps.rag.utils.calculate_content_hash", return_value="abc123"):
            mock_qs.bulk_create = MagicMock()
            result = SkillEmbeddingService.index_skill(
                skill_key="test-skill",
                name="Test Skill",
                description="A test skill",
                source="system",
                space_id=str(uuid.uuid4()),
            )
        self.assertTrue(result)

    def test_index_skill_skips_unchanged_content(self):
        """内容哈希未变化时 index_skill 应返回 False（已跳过）。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        existing = MagicMock()
        existing.content_hash = "same_hash"
        existing.metadata = {}

        mock_qs = MagicMock()
        mock_qs.filter.return_value.first.return_value = existing

        with patch("apps.rag.models.SkillEmbedding.objects", mock_qs), \
             patch("apps.rag.utils.calculate_content_hash", return_value="same_hash"):
            result = SkillEmbeddingService.index_skill(
                skill_key="test-skill",
                name="Test Skill",
                description="A test skill",
                source="system",
            )
        self.assertFalse(result)


class TestSK002SearchUsesNativeField(TestCase):
    """SK-002: search() 方法在 space_id 有效时应使用原生 space_id 字段过滤。"""

    def test_search_filters_local_agent_by_native_space_id(self):
        """search() 传入有效 space_id 时应使用 space_id= 原生字段查询，而非 metadata__space_id。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        # 只验证代码路径（源码检查），不需要数据库
        src = inspect.getsource(SkillEmbeddingService.search)

        # 确认使用 UUID 解析
        self.assertIn("_uuid_mod.UUID", src)
        # 确认使用原生字段
        self.assertIn("space_id=space_uuid_filter", src)
        # 确认旧的 JSONB 查询已被移除
        self.assertNotIn("metadata__space_id=space_id", src)

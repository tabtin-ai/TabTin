"""
DS-033 / DS-034 / DS-035 回归测试

DS-033: TableEmbedding/RecordEmbedding 的 space_id scope 过滤必须使用顶层字段
DS-034: TableEmbedding/RecordEmbedding 模型必须有顶层 space_id 字段
DS-035: list_table_indexes / list_record_indexes API 的 organization 过滤必须使用顶层字段

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/rag/tests/test_ds033_ds034_ds035_fixes.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import uuid
import inspect
from unittest.mock import MagicMock, patch
import pytest


# ━━ DS-034: 模型层必须有 space_id 顶层字段 ━━━━━━━━━━━━━━━━━━━━

class TestDS034ModelSpaceIdField:
    """DS-034: TableEmbedding/RecordEmbedding 必须有顶层 space_id 字段。"""

    def test_table_embedding_has_space_id_field(self):
        from apps.rag.models import TableEmbedding
        field_names = [f.name for f in TableEmbedding._meta.get_fields()]
        assert "space_id" in field_names, (
            "TableEmbedding 缺少顶层 space_id 字段，隔离依赖 metadata JSON"
        )

    def test_record_embedding_has_space_id_field(self):
        from apps.rag.models import RecordEmbedding
        field_names = [f.name for f in RecordEmbedding._meta.get_fields()]
        assert "space_id" in field_names, (
            "RecordEmbedding 缺少顶层 space_id 字段，隔离依赖 metadata JSON"
        )

    def test_table_embedding_space_id_is_uuid_and_indexed(self):
        from apps.rag.models import TableEmbedding
        field = TableEmbedding._meta.get_field("space_id")
        assert field.get_internal_type() == "UUIDField"
        assert field.db_index, "space_id 字段必须有 db_index 用于高效过滤"

    def test_record_embedding_space_id_is_uuid_and_indexed(self):
        from apps.rag.models import RecordEmbedding
        field = RecordEmbedding._meta.get_field("space_id")
        assert field.get_internal_type() == "UUIDField"
        assert field.db_index, "space_id 字段必须有 db_index 用于高效过滤"

    def test_table_embedding_space_id_nullable(self):
        """space_id 允许 null（兼容未回填的历史数据）"""
        from apps.rag.models import TableEmbedding
        field = TableEmbedding._meta.get_field("space_id")
        assert field.null is True

    def test_record_embedding_space_id_nullable(self):
        from apps.rag.models import RecordEmbedding
        field = RecordEmbedding._meta.get_field("space_id")
        assert field.null is True


# ━━ DS-033: 检索层必须使用顶层字段过滤 ━━━━━━━━━━━━━━━━━━━━

class TestDS033SearchUsesTopLevelFields:
    """DS-033: _search_tables / _search_records 必须使用顶层 organization_id/space_id 过滤。"""

    def test_search_tables_no_metadata_organization_filter(self):
        """_search_tables 不得使用 metadata__organization_id 系列过滤。"""
        from apps.rag.services.unified_search_service import _search_tables
        src = inspect.getsource(_search_tables)
        assert "metadata__organization_id" not in src, (
            "_search_tables 仍在使用 metadata__organization_id 做 organization 过滤，"
            "应改用顶层 organization_id 字段"
        )

    def test_search_tables_no_metadata_space_filter(self):
        """_search_tables 不得使用 metadata__space_id 过滤。"""
        from apps.rag.services.unified_search_service import _search_tables
        src = inspect.getsource(_search_tables)
        assert "metadata__space_id" not in src, (
            "_search_tables 仍在使用 metadata__space_id 做 space 过滤，"
            "应改用顶层 space_id 字段"
        )

    def test_search_records_no_metadata_organization_filter(self):
        """_search_records 不得使用 metadata__organization_id 系列过滤。"""
        from apps.rag.services.unified_search_service import _search_records
        src = inspect.getsource(_search_records)
        assert "metadata__organization_id" not in src, (
            "_search_records 仍在使用 metadata__organization_id 做 organization 过滤，"
            "应改用顶层 organization_id 字段"
        )

    def test_search_records_no_metadata_space_filter(self):
        """_search_records 不得使用 metadata__space_id 过滤。"""
        from apps.rag.services.unified_search_service import _search_records
        src = inspect.getsource(_search_records)
        assert "metadata__space_id" not in src, (
            "_search_records 仍在使用 metadata__space_id 做 space 过滤，"
            "应改用顶层 space_id 字段"
        )

    def test_search_tables_uses_toplevel_organization_id(self):
        """_search_tables 必须包含 organization_id__in 或 organization_id 顶层过滤。"""
        from apps.rag.services.unified_search_service import _search_tables
        src = inspect.getsource(_search_tables)
        has_ws_in = 'organization_id__in' in src and 'metadata__organization_id__in' not in src
        has_ws_eq = '"organization_id"' in src or "'organization_id'" in src
        assert has_ws_in or has_ws_eq, (
            "_search_tables 未使用顶层 organization_id 字段做过滤"
        )

    def test_search_tables_uses_toplevel_space_id(self):
        """_search_tables scope(space_id) 分支必须使用顶层 space_id。"""
        from apps.rag.services.unified_search_service import _search_tables
        src = inspect.getsource(_search_tables)
        assert '"space_id"' in src or "'space_id'" in src, (
            "_search_tables scope(space_id) 分支未使用顶层 space_id 字段"
        )

    def test_search_records_uses_toplevel_space_id(self):
        """_search_records scope(space_id) 分支必须使用顶层 space_id。"""
        from apps.rag.services.unified_search_service import _search_records
        src = inspect.getsource(_search_records)
        assert '"space_id"' in src or "'space_id'" in src, (
            "_search_records scope(space_id) 分支未使用顶层 space_id 字段"
        )

    def test_search_records_result_includes_space_id(self):
        """DS-038: _search_records 结果 metadata 应包含 space_id（顺带修复）。"""
        from apps.rag.services.unified_search_service import _search_records
        src = inspect.getsource(_search_records)
        assert "space_id" in src.split("metadata={")[1] if "metadata={" in src else "", (
            "_search_records 结果 metadata 缺少 space_id 字段"
        )


# ━━ DS-035: API 层必须使用顶层字段过滤 ━━━━━━━━━━━━━━━━━━━━

class TestDS035ApiUsesTopLevelFields:
    """DS-035: list_table_indexes / list_record_indexes 必须用顶层 organization_id。"""

    def test_list_table_indexes_no_metadata_filter(self):
        """list_table_indexes 不得使用 metadata__organization_id__in。"""
        from apps.rag.api import list_table_indexes
        src = inspect.getsource(list_table_indexes)
        assert "metadata__organization_id" not in src, (
            "list_table_indexes 仍在使用 metadata__organization_id__in 做过滤，"
            "应改用顶层 organization_id__in"
        )

    def test_list_record_indexes_no_metadata_filter(self):
        """list_record_indexes 不得使用 metadata__organization_id__in。"""
        from apps.rag.api import list_record_indexes
        src = inspect.getsource(list_record_indexes)
        assert "metadata__organization_id" not in src, (
            "list_record_indexes 仍在使用 metadata__organization_id__in 做过滤，"
            "应改用顶层 organization_id__in"
        )

    def test_list_table_indexes_uses_toplevel_organization(self):
        """list_table_indexes 必须包含 organization_id__in 顶层过滤。"""
        from apps.rag.api import list_table_indexes
        src = inspect.getsource(list_table_indexes)
        assert "organization_id__in" in src, (
            "list_table_indexes 未使用顶层 organization_id__in 做过滤"
        )

    def test_list_record_indexes_uses_toplevel_organization(self):
        """list_record_indexes 必须包含 organization_id__in 顶层过滤。"""
        from apps.rag.api import list_record_indexes
        src = inspect.getsource(list_record_indexes)
        assert "organization_id__in" in src, (
            "list_record_indexes 未使用顶层 organization_id__in 做过滤"
        )


# ━━ DS-034 补充: index_service 写入时必须填充 space_id ━━━━━━━━

class TestDS034IndexServiceWritesSpaceId:
    """DS-034: index_service.py 写入 embedding 时必须设置顶层 space_id。"""

    def test_upsert_table_embedding_sets_space_id(self):
        from apps.rag.services.index_service import IndexService
        src = inspect.getsource(IndexService._upsert_table_embedding)
        assert "space_id" in src, (
            "_upsert_table_embedding 未设置顶层 space_id 字段"
        )
        assert "'space_id'" in src or '"space_id"' in src, (
            "_upsert_table_embedding 的 update_fields 未包含 space_id"
        )

    def test_upsert_record_embedding_sets_space_id(self):
        from apps.rag.services.index_service import IndexService
        src = inspect.getsource(IndexService._upsert_record_embedding)
        assert "space_id" in src, (
            "_upsert_record_embedding 未设置顶层 space_id 字段"
        )

    def test_index_table_single_sets_space_id(self):
        from apps.rag.services.index_service import IndexService
        src = inspect.getsource(IndexService.index_table)
        assert "space_id" in src, (
            "index_table 单条写入未设置顶层 space_id 字段"
        )

    def test_index_record_single_sets_space_id(self):
        from apps.rag.services.index_service import IndexService
        src = inspect.getsource(IndexService.index_record)
        assert "_space_uuid_parsed" in src or "space_id=_space" in src, (
            "index_record 单条写入未设置顶层 space_id 字段"
        )


# ━━ DS-034: migration 文件存在性验证 ━━━━━━━━━━━━━━━━━━━━

class TestDS034MigrationExists:
    """DS-034: 确保添加 space_id 的 migration 文件存在。"""

    def test_migration_file_exists(self):
        import importlib
        mod = importlib.import_module(
            "apps.rag.migrations.0013_tableembedding_space_id_recordembedding_space_id"
        )
        ops = mod.Migration.operations
        add_field_models = set()
        for op in ops:
            if hasattr(op, 'model_name') and hasattr(op, 'name'):
                if op.name == 'space_id':
                    add_field_models.add(op.model_name)
        assert "tableembedding" in add_field_models, "Migration 缺少 TableEmbedding.space_id"
        assert "recordembedding" in add_field_models, "Migration 缺少 RecordEmbedding.space_id"

    def test_migration_has_data_backfill(self):
        """数据迁移应包含 RunPython 回填旧数据。"""
        import importlib
        from django.db import migrations as mig_module
        mod = importlib.import_module(
            "apps.rag.migrations.0013_tableembedding_space_id_recordembedding_space_id"
        )
        has_run_python = any(
            isinstance(op, mig_module.RunPython)
            for op in mod.Migration.operations
        )
        assert has_run_python, "Migration 缺少 RunPython 数据回填操作"

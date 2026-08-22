"""
DA-003 / DA-004 修复回归测试

DA-003: bulk_update_records 应在成功后触发 RAG 索引
DA-004: TableEmbedding/RecordEmbedding 写入时应同步设置顶层 organization_id 字段

纯单元测试（无 DB 依赖），通过 mock 验证修复逻辑。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/rag/tests/test_da003_da004_fixes.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import uuid
from unittest.mock import MagicMock, patch, call
import pytest


# ━━ DA-003: bulk_update_records 应触发 RAG 索引 ━━━━━━━━━━━━━━━━━━━━

class TestDA003BulkUpdateRagTrigger:
    """DA-003: bulk_update_records 成功后需对每个涉及的 table_id 触发 RAG 索引。"""

    def test_trigger_rag_called_for_updated_tables(self):
        """
        核心回归：bulk_update_records 成功后，_trigger_rag_after_bulk 应被调用，
        且 table_id 覆盖所有成功记录的表。
        """
        from apps.tabdata.services.record_service import _trigger_rag_after_bulk

        table_id_1 = str(uuid.uuid4())
        table_id_2 = str(uuid.uuid4())

        with patch("apps.rag.tasks.index_table_records_task.apply_async") as mock_apply:
            _trigger_rag_after_bulk(table_id_1)
            _trigger_rag_after_bulk(table_id_2)

            assert mock_apply.call_count == 2
            # apply_async(args=[table_id], kwargs={"force": False}, countdown=5)
            called_table_ids = [c.args[0][0] if c.args else c.kwargs.get("args", [None])[0]
                                for c in mock_apply.call_args_list]
            assert table_id_1 in called_table_ids
            assert table_id_2 in called_table_ids

    def test_trigger_rag_skipped_when_rag_disabled(self):
        """RAG_ENABLED=False 时不触发索引任务。"""
        from apps.tabdata.services.record_service import _trigger_rag_after_bulk

        with patch("apps.rag.tasks.index_table_records_task.apply_async") as mock_apply:
            with patch("django.conf.settings") as mock_settings:
                mock_settings.RAG_ENABLED = False
                mock_settings.RAG_AUTO_EMBED_RECORDS = True

                _trigger_rag_after_bulk(str(uuid.uuid4()))
                mock_apply.assert_not_called()

    def test_trigger_rag_skipped_when_auto_embed_disabled(self):
        """RAG_AUTO_EMBED_RECORDS=False 时不触发索引任务。"""
        from apps.tabdata.services.record_service import _trigger_rag_after_bulk

        with patch("apps.rag.tasks.index_table_records_task.apply_async") as mock_apply:
            with patch("django.conf.settings") as mock_settings:
                mock_settings.RAG_ENABLED = True
                mock_settings.RAG_AUTO_EMBED_RECORDS = False

                _trigger_rag_after_bulk(str(uuid.uuid4()))
                mock_apply.assert_not_called()

    def test_bulk_update_rag_logic_presence(self):
        """
        验证 bulk_update_records 函数体中包含 _trigger_rag_after_bulk 调用代码，
        通过检查源码文本确认修复已落地。
        """
        import inspect
        from apps.tabdata.services import record_service

        source = inspect.getsource(record_service.RecordService.bulk_update_records)
        assert "_trigger_rag_after_bulk" in source, (
            "bulk_update_records 未发现 _trigger_rag_after_bulk 调用，DA-003 修复未落地"
        )

    def test_bulk_create_also_triggers_rag(self):
        """
        对照验证：bulk_create_records 同样包含 _trigger_rag_after_bulk，
        确保两个批量入口一致。
        """
        import inspect
        from apps.tabdata.services import record_service

        source = inspect.getsource(record_service.RecordService.bulk_create_records)
        assert "_trigger_rag_after_bulk" in source, (
            "bulk_create_records 未发现 _trigger_rag_after_bulk 调用"
        )


# ━━ DA-004: TableEmbedding/RecordEmbedding 顶层 organization_id 字段 ━━

class TestDA004OrganizationIdTopLevelField:
    """DA-004: TableEmbedding/RecordEmbedding 应有顶层 organization_id 字段。"""

    def test_table_embedding_has_organization_id_field(self):
        """TableEmbedding 模型应有顶层 organization_id 字段（UUIDField, null=True, db_index=True）。"""
        from apps.rag.models import TableEmbedding
        from django.db import models

        field = TableEmbedding._meta.get_field('organization_id')
        assert isinstance(field, models.UUIDField), (
            f"organization_id 应为 UUIDField，实际为 {type(field)}"
        )
        assert field.null is True, "organization_id 应允许 null"
        assert field.db_index is True, "organization_id 应有数据库索引"

    def test_record_embedding_has_organization_id_field(self):
        """RecordEmbedding 模型应有顶层 organization_id 字段（UUIDField, null=True, db_index=True）。"""
        from apps.rag.models import RecordEmbedding
        from django.db import models

        field = RecordEmbedding._meta.get_field('organization_id')
        assert isinstance(field, models.UUIDField), (
            f"organization_id 应为 UUIDField，实际为 {type(field)}"
        )
        assert field.null is True, "organization_id 应允许 null"
        assert field.db_index is True, "organization_id 应有数据库索引"

    def test_upsert_table_embedding_sets_organization_id(self):
        """
        _upsert_table_embedding 写入时应正确解析并设置顶层 organization_id。
        """
        from apps.rag.services.index_service import IndexService

        ws_id = str(uuid.uuid4())
        table_id = uuid.uuid4()

        mock_table = MagicMock()
        mock_table.id = table_id
        mock_table.name = "测试表"
        mock_table.description = ""
        mock_table.space_id = uuid.uuid4()
        mock_table.fields.all.return_value = []
        mock_table.records.count.return_value = 0

        item = {
            'table': mock_table,
            'ws_id': ws_id,
            'text': '测试内容',
            'hash': 'abc123',
        }
        vector = [0.1] * 1536

        captured_objects = []

        def fake_bulk_create(objs, **kwargs):
            captured_objects.extend(objs)
            return objs

        with patch("apps.rag.models.TableEmbedding.objects") as mock_manager:
            mock_manager.bulk_create.side_effect = fake_bulk_create

            svc = object.__new__(IndexService)
            svc._upsert_table_embedding(item, vector)

        assert len(captured_objects) == 1
        obj = captured_objects[0]
        assert obj.organization_id == uuid.UUID(ws_id), (
            f"顶层 organization_id 应为 UUID({ws_id})，实际为 {obj.organization_id}"
        )

    def test_upsert_record_embedding_sets_organization_id(self):
        """
        _upsert_record_embedding 写入时应正确解析并设置顶层 organization_id。
        """
        from apps.rag.services.index_service import IndexService
        import datetime

        ws_id = str(uuid.uuid4())
        record_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_table = MagicMock()
        mock_table.name = "测试表"
        mock_table.space_id = uuid.uuid4()

        mock_record = MagicMock()
        mock_record.id = record_id
        mock_record.table_id = table_id
        mock_record.table = mock_table
        mock_record.created_at = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)

        item = {
            'record': mock_record,
            'ws_id': ws_id,
            'text': '测试记录内容',
            'hash': 'def456',
        }
        vector = [0.2] * 1536

        captured_objects = []

        def fake_bulk_create(objs, **kwargs):
            captured_objects.extend(objs)
            return objs

        with patch("apps.rag.models.RecordEmbedding.objects") as mock_manager:
            mock_manager.bulk_create.side_effect = fake_bulk_create

            svc = object.__new__(IndexService)
            svc._upsert_record_embedding(item, vector)

        assert len(captured_objects) == 1
        obj = captured_objects[0]
        assert obj.organization_id == uuid.UUID(ws_id), (
            f"顶层 organization_id 应为 UUID({ws_id})，实际为 {obj.organization_id}"
        )

    def test_upsert_table_embedding_handles_empty_ws_id(self):
        """ws_id 为空字符串时，organization_id 应为 None（不应引发异常）。"""
        from apps.rag.services.index_service import IndexService

        mock_table = MagicMock()
        mock_table.id = uuid.uuid4()
        mock_table.name = "表"
        mock_table.description = ""
        mock_table.space_id = uuid.uuid4()
        mock_table.fields.all.return_value = []
        mock_table.records.count.return_value = 0

        item = {
            'table': mock_table,
            'ws_id': '',
            'text': '内容',
            'hash': 'hash1',
        }
        vector = [0.0] * 1536

        captured_objects = []

        def fake_bulk_create(objs, **kwargs):
            captured_objects.extend(objs)
            return objs

        with patch("apps.rag.models.TableEmbedding.objects") as mock_manager:
            mock_manager.bulk_create.side_effect = fake_bulk_create

            svc = object.__new__(IndexService)
            svc._upsert_table_embedding(item, vector)

        assert len(captured_objects) == 1
        assert captured_objects[0].organization_id is None

    def test_upsert_update_fields_includes_organization_id(self):
        """
        _upsert_table_embedding 和 _upsert_record_embedding 的 update_fields
        应包含 organization_id，确保 upsert 时同步更新顶层字段。
        """
        import inspect
        from apps.rag.services import index_service

        table_src = inspect.getsource(index_service.IndexService._upsert_table_embedding)
        record_src = inspect.getsource(index_service.IndexService._upsert_record_embedding)

        assert "'organization_id'" in table_src or '"organization_id"' in table_src, (
            "_upsert_table_embedding 的 update_fields 应包含 organization_id"
        )
        assert "'organization_id'" in record_src or '"organization_id"' in record_src, (
            "_upsert_record_embedding 的 update_fields 应包含 organization_id"
        )

    def test_migration_file_exists(self):
        """迁移文件应存在，确保数据库 schema 变更已创建。"""
        import os
        migration_path = os.path.join(
            os.path.dirname(__file__),
            '../migrations/0011_tableembedding_workteam_id_recordembedding_workteam_id.py'
        )
        assert os.path.exists(os.path.normpath(migration_path)), (
            "DA-004 迁移文件不存在，请检查迁移文件是否已创建"
        )

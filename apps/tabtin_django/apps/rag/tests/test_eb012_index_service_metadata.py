"""
EB-012 回归测试（index_service 部分）

EB-012：IndexService 写入 TableEmbedding / RecordEmbedding 的 metadata 中
必须包含 embedding_provider / embedding_model / embedding_dimensions，
以支持 provider 切换后的增量重建识别。

运行：
    cd apps/tabtin_django
    python manage.py test apps.rag.tests.test_eb012_index_service_metadata --verbosity=1 --no-input
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

from django.test import TestCase


FAKE_VECTOR = [0.1] * 1024
FAKE_PROVIDER = "qwen"
FAKE_MODEL = "text-embedding-v4"
FAKE_DIMENSIONS = 1024


def _make_mock_embedding_service():
    svc = MagicMock()
    svc.embed_text.return_value = FAKE_VECTOR
    svc.embed_texts.return_value = [FAKE_VECTOR]
    svc.provider = FAKE_PROVIDER
    svc.model = FAKE_MODEL
    svc.dimensions = FAKE_DIMENSIONS
    svc.batch_size = 10
    return svc


def _make_mock_table(table_id=None, organization_id=None, space_id=None):
    table = MagicMock()
    table.id = table_id or uuid.uuid4()
    table.name = "Test Table"
    table.description = "Test description"
    table.organization_id = organization_id or uuid.uuid4()
    table.space_id = space_id or uuid.uuid4()
    table.owner_id = uuid.uuid4()
    table.fields.all.return_value = []
    table.records.count.return_value = 5
    return table


def _make_mock_record(record_id=None, table=None):
    record = MagicMock()
    record.id = record_id or uuid.uuid4()
    record.table = table or _make_mock_table()
    record.table_id = record.table.id
    record.created_at = MagicMock()
    record.created_at.isoformat.return_value = "2026-01-01T00:00:00"
    record.get_record_data.return_value = {}
    return record


class IndexServiceTableEmbeddingMetadataTest(TestCase):
    """EB-012: IndexService.index_table 写入 metadata 包含 provider/model/dimensions。"""

    def test_index_table_metadata_contains_embedding_provider(self):
        """EB-012: index_table 写入 TableEmbedding 的 metadata 包含 provider 信息。"""
        from apps.rag.services.index_service import IndexService

        table_id = str(uuid.uuid4())
        mock_table = _make_mock_table(table_id=table_id)

        captured_objs: List[Any] = []

        def fake_bulk_create(objs, **kwargs):
            captured_objs.extend(objs)
            return objs

        mock_embed_svc = _make_mock_embedding_service()

        with patch("apps.rag.services.index_service.IndexService.__init__") as mock_init:
            mock_init.return_value = None
            svc = IndexService.__new__(IndexService)
            svc.embedding_service = mock_embed_svc
            svc.batch_size = 10

        with patch("apps.tabdata.models.Table.objects") as mock_table_mgr, \
             patch("apps.rag.models.TableEmbedding.objects") as mock_te_mgr, \
             patch("apps.rag.services.index_service.IndexService._calculate_hash", return_value="table_hash_eb012"):

            mock_table_mgr.get.return_value = mock_table
            mock_te_mgr.filter.return_value.first.return_value = None
            mock_te_mgr.bulk_create.side_effect = fake_bulk_create

            svc.index_table(table_id=str(table_id), force=True)

        self.assertTrue(len(captured_objs) > 0, "应有 TableEmbedding 对象被创建")
        metadata = captured_objs[0].metadata
        self.assertIn("embedding_provider", metadata, "TableEmbedding.metadata 必须包含 embedding_provider（EB-012）")
        self.assertIn("embedding_model", metadata, "TableEmbedding.metadata 必须包含 embedding_model（EB-012）")
        self.assertIn("embedding_dimensions", metadata, "TableEmbedding.metadata 必须包含 embedding_dimensions（EB-012）")
        self.assertEqual(metadata["embedding_provider"], FAKE_PROVIDER)
        self.assertEqual(metadata["embedding_model"], FAKE_MODEL)
        self.assertEqual(metadata["embedding_dimensions"], FAKE_DIMENSIONS)


class IndexServiceRecordEmbeddingMetadataTest(TestCase):
    """EB-012: IndexService.index_record 写入 metadata 包含 provider/model/dimensions。"""

    def test_index_record_metadata_contains_embedding_provider(self):
        """EB-012: index_record 写入 RecordEmbedding 的 metadata 包含 provider 信息。"""
        from apps.rag.services.index_service import IndexService

        mock_table = _make_mock_table()
        mock_record = _make_mock_record(table=mock_table)

        captured_objs: List[Any] = []

        def fake_bulk_create(objs, **kwargs):
            captured_objs.extend(objs)
            return objs

        mock_embed_svc = _make_mock_embedding_service()

        svc = IndexService.__new__(IndexService)
        svc.embedding_service = mock_embed_svc
        svc.batch_size = 10

        with patch("apps.tabdata.models.TableRecord.objects") as mock_record_mgr, \
             patch("apps.rag.models.RecordEmbedding.objects") as mock_re_mgr, \
             patch("apps.rag.services.index_service.IndexService._calculate_hash", return_value="record_hash_eb012"), \
             patch("apps.rag.services.index_service.IndexService._build_record_text", return_value="record content text"):

            mock_record_mgr.select_related.return_value.get.return_value = mock_record
            mock_re_mgr.filter.return_value.first.return_value = None
            mock_re_mgr.bulk_create.side_effect = fake_bulk_create

            svc.index_record(record_id=str(mock_record.id), force=True)

        self.assertTrue(len(captured_objs) > 0, "应有 RecordEmbedding 对象被创建")
        metadata = captured_objs[0].metadata
        self.assertIn("embedding_provider", metadata, "RecordEmbedding.metadata 必须包含 embedding_provider（EB-012）")
        self.assertIn("embedding_model", metadata, "RecordEmbedding.metadata 必须包含 embedding_model（EB-012）")
        self.assertIn("embedding_dimensions", metadata, "RecordEmbedding.metadata 必须包含 embedding_dimensions（EB-012）")
        self.assertEqual(metadata["embedding_provider"], FAKE_PROVIDER)
        self.assertEqual(metadata["embedding_model"], FAKE_MODEL)
        self.assertEqual(metadata["embedding_dimensions"], FAKE_DIMENSIONS)

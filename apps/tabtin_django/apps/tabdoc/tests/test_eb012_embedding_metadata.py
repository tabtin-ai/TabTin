"""
EB-012 回归测试（document_embedding_service 部分）

EB-012：embedding 写入时必须在 metadata 中记录 provider/model/dimensions，
以支持 provider 切换后的增量重建，避免全量 reindex 成本。

运行：
    cd apps/tabtin_django
    python manage.py test apps.tabdoc.tests.test_eb012_embedding_metadata --verbosity=1 --no-input
"""

from __future__ import annotations

import uuid
from typing import Any, Dict
from unittest.mock import MagicMock, patch

from django.test import TestCase


FAKE_VECTOR = [0.1] * 1024
FAKE_PROVIDER = "qwen"
FAKE_MODEL = "text-embedding-v4"
FAKE_DIMENSIONS = 1024


def _make_mock_svc(provider=FAKE_PROVIDER, model=FAKE_MODEL, dimensions=FAKE_DIMENSIONS):
    svc = MagicMock()
    svc.embed_text.return_value = FAKE_VECTOR
    svc.embed_texts.return_value = [FAKE_VECTOR]
    svc.provider = provider
    svc.model = model
    svc.dimensions = dimensions
    return svc


def _make_mock_doc(doc_id=None, organization_id=None, space_id=None, created_by_id=None):
    doc = MagicMock()
    doc.id = doc_id or uuid.uuid4()
    doc.organization_id = organization_id or uuid.uuid4()
    doc.space_id = space_id or uuid.uuid4()
    doc.created_by_id = created_by_id or uuid.uuid4()
    doc.status = "active"
    doc.trashed_at = None
    doc.title = "Test Document"
    doc.description_plaintext = "Some content"
    doc.description_json = None
    return doc


class DocumentEmbeddingMetadataTest(TestCase):
    """EB-012: index_document 写入 metadata 必须包含 provider/model/dimensions。"""

    def test_index_document_metadata_contains_embedding_provider(self):
        """EB-012: index_document 单文档路径写入 metadata 包含 embedding_provider。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        doc_id = str(uuid.uuid4())
        mock_doc = _make_mock_doc(doc_id=doc_id)
        mock_svc = _make_mock_svc()

        captured_defaults: Dict[str, Any] = {}

        def fake_update_or_create(**kwargs):
            captured_defaults.update(kwargs.get("defaults", {}))
            return (MagicMock(), True)

        with patch("apps.tabdoc.services.document_embedding_service.Document") as mock_doc_model, \
             patch("apps.tabdoc.services.document_embedding_service.DocumentEmbedding") as mock_de_model, \
             patch("apps.tabdoc.services.document_embedding_service.get_embedding_service", return_value=mock_svc), \
             patch("apps.tabdoc.services.document_embedding_service.calculate_content_hash", return_value="hash_eb012"), \
             patch("django.core.cache.cache.add", return_value=True), \
             patch("django.core.cache.cache.delete"), \
             patch("django.db.transaction.atomic"):

            mock_doc_model.objects.filter.return_value.only.return_value.first.return_value = mock_doc
            mock_de_model.objects.filter.return_value.first.return_value = None
            mock_de_model.objects.update_or_create.side_effect = fake_update_or_create

            DocumentEmbeddingService.index_document(document_id=doc_id, user_id="user_123")

        metadata = captured_defaults.get("metadata", {})
        self.assertIn("embedding_provider", metadata, "metadata 必须包含 embedding_provider（EB-012）")
        self.assertIn("embedding_model", metadata, "metadata 必须包含 embedding_model（EB-012）")
        self.assertIn("embedding_dimensions", metadata, "metadata 必须包含 embedding_dimensions（EB-012）")
        self.assertEqual(metadata["embedding_provider"], FAKE_PROVIDER)
        self.assertEqual(metadata["embedding_model"], FAKE_MODEL)
        self.assertEqual(metadata["embedding_dimensions"], FAKE_DIMENSIONS)

    def test_index_documents_batch_metadata_contains_embedding_provider(self):
        """EB-012: index_documents_batch 批量路径写入 metadata 包含 embedding_provider。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        doc_id = str(uuid.uuid4())
        mock_doc = _make_mock_doc(doc_id=doc_id)
        mock_svc = _make_mock_svc()

        captured_defaults_list = []

        def fake_update_or_create(**kwargs):
            captured_defaults_list.append(dict(kwargs.get("defaults", {})))
            return (MagicMock(), True)

        with patch("apps.tabdoc.services.document_embedding_service.Document") as mock_doc_model, \
             patch("apps.tabdoc.services.document_embedding_service.DocumentEmbedding") as mock_de_model, \
             patch("apps.tabdoc.services.document_embedding_service.get_embedding_service", return_value=mock_svc), \
             patch("apps.tabdoc.services.document_embedding_service.calculate_content_hash", return_value="hash_batch_eb012"), \
             patch("django.db.transaction.atomic"):

            mock_doc_model.objects.filter.return_value.only.return_value.__iter__ = lambda s: iter([mock_doc])
            mock_de_model.objects.filter.return_value.first.return_value = None
            mock_de_model.objects.filter.return_value.delete.return_value = None
            mock_de_model.objects.update_or_create.side_effect = fake_update_or_create

            DocumentEmbeddingService.index_documents_batch(document_ids=[doc_id])

        self.assertTrue(len(captured_defaults_list) > 0, "应该有至少一条 upsert 调用")
        metadata = captured_defaults_list[0].get("metadata", {})
        self.assertIn("embedding_provider", metadata, "批量路径 metadata 必须包含 embedding_provider（EB-012）")
        self.assertIn("embedding_model", metadata, "批量路径 metadata 必须包含 embedding_model（EB-012）")
        self.assertIn("embedding_dimensions", metadata, "批量路径 metadata 必须包含 embedding_dimensions（EB-012）")

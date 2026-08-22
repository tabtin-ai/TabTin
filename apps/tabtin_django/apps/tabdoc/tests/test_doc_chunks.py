"""
TabDoc 分块加载集成测试

覆盖:
- DocChunk 模型字段完整性
- list_chunks 返回元数据
- get_chunks 返回指定范围的分块（含解压后 blob）
- DocChunk 唯一约束
"""
from __future__ import annotations

import base64
import uuid
import zlib
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch


class TestDocChunkModel(TestCase):

    def test_model_fields(self):
        from apps.tabdoc.models import DocChunk
        field_names = {f.name for f in DocChunk._meta.get_fields()}
        expected = {
            "id", "document", "chunk_index", "chunk_key",
            "blob", "blob_size", "block_count",
            "plaintext_preview", "updated_at",
        }
        for name in expected:
            self.assertIn(name, field_names, f"Missing field: {name}")

    def test_model_ordering(self):
        from apps.tabdoc.models import DocChunk
        self.assertEqual(DocChunk._meta.ordering, ["chunk_index"])

    def test_unique_constraint(self):
        from apps.tabdoc.models import DocChunk
        constraints = [c.name for c in DocChunk._meta.constraints]
        self.assertIn("doc_chunk_doc_index_unique", constraints)


class TestListChunks(TestCase):

    def _get_service(self):
        from apps.tabdoc.services.document_service import DocumentService
        svc = DocumentService.__new__(DocumentService)
        svc.user = MagicMock()
        svc.db_alias = "postgresql"
        return svc

    @patch("apps.tabdoc.services.document_service.DocChunk")
    def test_list_chunks_returns_metadata(self, MockChunk):
        svc = self._get_service()
        svc.check_document_permission = MagicMock(return_value=True)

        doc = SimpleNamespace(id=uuid.uuid4())

        chunk1 = SimpleNamespace(
            chunk_index=0, chunk_key="heading-1", blob_size=100,
            block_count=5, plaintext_preview="Hello world",
        )
        chunk2 = SimpleNamespace(
            chunk_index=1, chunk_key="heading-2", blob_size=200,
            block_count=10, plaintext_preview="Second section",
        )

        MockChunk.objects.filter.return_value.order_by.return_value = [chunk1, chunk2]

        result = svc.list_chunks(doc)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["chunk_index"], 0)
        self.assertEqual(result[0]["blob_size"], 100)
        self.assertEqual(result[1]["block_count"], 10)
        self.assertNotIn("blob", result[0])

    @patch("apps.tabdoc.services.document_service.DocChunk")
    def test_list_chunks_permission_denied(self, MockChunk):
        svc = self._get_service()
        svc.check_document_permission = MagicMock(return_value=False)

        with self.assertRaises(PermissionError):
            svc.list_chunks(SimpleNamespace(id=uuid.uuid4()))


class TestGetChunks(TestCase):

    def _get_service(self):
        from apps.tabdoc.services.document_service import DocumentService
        svc = DocumentService.__new__(DocumentService)
        svc.user = MagicMock()
        svc.db_alias = "postgresql"
        return svc

    @patch("apps.tabdoc.services.document_service.DocChunk")
    def test_get_chunks_returns_range(self, MockChunk):
        svc = self._get_service()
        svc.check_document_permission = MagicMock(return_value=True)

        doc = SimpleNamespace(id=uuid.uuid4())
        raw_data = b"\x01\x02\x03yjs-chunk-data"
        compressed = zlib.compress(raw_data)

        chunk = SimpleNamespace(
            chunk_index=0, chunk_key="heading-1",
            blob=compressed, blob_size=len(compressed),
            block_count=5,
        )

        order_qs = MagicMock()
        order_qs.filter.return_value = [chunk]  # end_index filter
        MockChunk.objects.filter.return_value.order_by.return_value = order_qs

        result = svc.get_chunks(doc, start_index=0, end_index=1)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["chunk_index"], 0)

        decoded = base64.b64decode(result[0]["blob_b64"])
        self.assertEqual(decoded, raw_data)

    @patch("apps.tabdoc.services.document_service.DocChunk")
    def test_get_chunks_returns_raw_compat(self, MockChunk):
        """旧的未压缩数据也能正确返回"""
        svc = self._get_service()
        svc.check_document_permission = MagicMock(return_value=True)

        doc = SimpleNamespace(id=uuid.uuid4())
        raw_data = b"\x01\x02\x03raw-yjs"

        chunk = SimpleNamespace(
            chunk_index=0, chunk_key="c1",
            blob=raw_data, blob_size=len(raw_data),
            block_count=3,
        )

        order_qs = MagicMock()
        order_qs.__iter__ = MagicMock(return_value=iter([chunk]))
        MockChunk.objects.filter.return_value.order_by.return_value = order_qs

        result = svc.get_chunks(doc, start_index=0)
        decoded = base64.b64decode(result[0]["blob_b64"])
        self.assertEqual(decoded, raw_data)

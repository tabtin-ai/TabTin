"""
回归测试：RAG-BATCH — 批量嵌入接口改造

验证：
1. index_documents_batch 使用 embed_texts（批量）而非 N × embed_text（逐条）
2. 不同 organization_id 的文档分组为独立的 embed_texts 调用
3. 混合场景（not_found / inactive / valid）返回正确 counts
4. _extract_text_from_pm_json 的 max_depth 递归深度守卫
"""
from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django
django.setup()


def _make_doc(
    doc_id="doc-1",
    title="Test Doc",
    plaintext="some content",
    pm_json=None,
    organization_id="ws-1",
    space_id="sp-1",
    status="active",
    trashed_at=None,
    created_by_id="user-1",
):
    return SimpleNamespace(
        id=doc_id,
        title=title,
        description_plaintext=plaintext,
        description_json=pm_json,
        organization_id=organization_id,
        space_id=space_id,
        status=status,
        trashed_at=trashed_at,
        created_by_id=created_by_id,
    )


class TestRagBatchEmbedTexts(unittest.TestCase):
    """RAG-BATCH: batch path 必须调用 embed_texts 而非逐条 embed_text。"""

    def test_batch_calls_embed_texts_not_embed_text(self):
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        docs = [
            _make_doc(doc_id=f"doc-{i}", title=f"Title {i}", plaintext=f"body {i}")
            for i in range(5)
        ]
        docs_map = {str(d.id): d for d in docs}
        doc_ids = list(docs_map.keys())

        fake_vectors = [[0.1] * 8 for _ in range(5)]
        mock_svc = MagicMock()
        mock_svc.embed_texts.return_value = fake_vectors
        mock_svc.embed_text.side_effect = AssertionError("should not call embed_text")

        mock_emb_objects = MagicMock()
        mock_emb_objects.filter.return_value.first.return_value = None
        mock_emb_objects.filter.return_value.delete.return_value = (0, {})

        mock_doc_qs = MagicMock()
        mock_doc_qs.only.return_value = docs

        with (
            patch("apps.tabdoc.models.Document.objects") as mock_doc_cls,
            patch("apps.rag.models.DocumentEmbedding.objects", mock_emb_objects),
            patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc),
            patch("apps.rag.utils.calculate_content_hash", side_effect=lambda t: f"hash-{t[:10]}"),
            patch("django.db.transaction.atomic", MagicMock()),
        ):
            mock_doc_cls.filter.return_value = mock_doc_qs

            counts = DocumentEmbeddingService.index_documents_batch(doc_ids)

        mock_svc.embed_texts.assert_called_once()
        mock_svc.embed_text.assert_not_called()
        self.assertEqual(counts["success"], 5)
        self.assertEqual(counts["failed"], 0)

    def test_batch_groups_by_organization_id(self):
        """不同 organization_id 的文档应分成独立的 embed_texts 调用。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        docs = [
            _make_doc(doc_id="d1", title="A", plaintext="a", organization_id="ws-A"),
            _make_doc(doc_id="d2", title="B", plaintext="b", organization_id="ws-A"),
            _make_doc(doc_id="d3", title="C", plaintext="c", organization_id="ws-B"),
        ]
        docs_map = {str(d.id): d for d in docs}

        mock_svc = MagicMock()
        mock_svc.embed_texts.side_effect = lambda texts, **kw: [[0.5] * 8 for _ in texts]

        mock_emb_objects = MagicMock()
        mock_emb_objects.filter.return_value.first.return_value = None
        mock_emb_objects.filter.return_value.delete.return_value = (0, {})

        mock_doc_qs = MagicMock()
        mock_doc_qs.only.return_value = docs

        with (
            patch("apps.tabdoc.models.Document.objects") as mock_doc_cls,
            patch("apps.rag.models.DocumentEmbedding.objects", mock_emb_objects),
            patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc),
            patch("apps.rag.utils.calculate_content_hash", side_effect=lambda t: f"hash-{t[:8]}"),
            patch("django.db.transaction.atomic", MagicMock()),
        ):
            mock_doc_cls.filter.return_value = mock_doc_qs

            counts = DocumentEmbeddingService.index_documents_batch(["d1", "d2", "d3"])

        self.assertEqual(mock_svc.embed_texts.call_count, 2)

        ws_ids_called = [c.kwargs.get("organization_id") for c in mock_svc.embed_texts.call_args_list]
        self.assertIn("ws-A", ws_ids_called)
        self.assertIn("ws-B", ws_ids_called)
        self.assertEqual(counts["success"], 3)

    def test_batch_mixed_scenarios(self):
        """混合场景：1 个 not_found + 1 个 archived + 1 个 valid → counts 正确。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        valid_doc = _make_doc(doc_id="d-valid", title="Valid", plaintext="content")
        archived_doc = _make_doc(doc_id="d-archived", title="Old", plaintext="old", status="archived")
        docs = [valid_doc, archived_doc]

        mock_svc = MagicMock()
        mock_svc.embed_texts.return_value = [[0.2] * 8]

        mock_emb_objects = MagicMock()
        mock_emb_objects.filter.return_value.first.return_value = None
        mock_emb_objects.filter.return_value.delete.return_value = (0, {})

        mock_doc_qs = MagicMock()
        mock_doc_qs.only.return_value = docs

        with (
            patch("apps.tabdoc.models.Document.objects") as mock_doc_cls,
            patch("apps.rag.models.DocumentEmbedding.objects", mock_emb_objects),
            patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc),
            patch("apps.rag.utils.calculate_content_hash", return_value="hash-x"),
            patch("django.db.transaction.atomic", MagicMock()),
        ):
            mock_doc_cls.filter.return_value = mock_doc_qs

            counts = DocumentEmbeddingService.index_documents_batch(
                ["d-valid", "d-archived", "d-not-exist"],
            )

        self.assertEqual(counts["success"], 1)
        self.assertEqual(counts["skipped"], 2)
        self.assertEqual(counts["failed"], 0)

    def test_batch_embed_failure_counts_all_in_group_as_failed(self):
        """某个 organization 的 embed_texts 整体失败时，该组所有文档计入 failed。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        docs = [
            _make_doc(doc_id="d1", title="A", plaintext="a"),
            _make_doc(doc_id="d2", title="B", plaintext="b"),
        ]

        mock_svc = MagicMock()
        mock_svc.embed_texts.side_effect = RuntimeError("API down")

        mock_emb_objects = MagicMock()
        mock_emb_objects.filter.return_value.first.return_value = None
        mock_emb_objects.filter.return_value.delete.return_value = (0, {})

        mock_doc_qs = MagicMock()
        mock_doc_qs.only.return_value = docs

        with (
            patch("apps.tabdoc.models.Document.objects") as mock_doc_cls,
            patch("apps.rag.models.DocumentEmbedding.objects", mock_emb_objects),
            patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc),
            patch("apps.rag.utils.calculate_content_hash", return_value="hash-y"),
            patch("django.db.transaction.atomic", MagicMock()),
        ):
            mock_doc_cls.filter.return_value = mock_doc_qs

            counts = DocumentEmbeddingService.index_documents_batch(["d1", "d2"])

        self.assertEqual(counts["failed"], 2)
        self.assertEqual(counts["success"], 0)


class TestPmJsonMaxDepthGuard(unittest.TestCase):
    """RAG-BATCH: _extract_text_from_pm_json max_depth 递归深度守卫。"""

    def test_normal_depth_extracts_text(self):
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        pm = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Hello"}]},
            ],
        }
        result = DocumentEmbeddingService._extract_text_from_pm_json(pm)
        self.assertIn("Hello", result)

    def test_exceeds_max_depth_returns_empty(self):
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        node: dict = {"type": "text", "text": "deep leaf"}
        for _ in range(10):
            node = {"type": "paragraph", "content": [node]}
        root = {"type": "doc", "content": [node]}

        result = DocumentEmbeddingService._extract_text_from_pm_json(root, max_depth=5)
        self.assertNotIn("deep leaf", result)

    def test_default_depth_handles_reasonable_nesting(self):
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        node: dict = {"type": "text", "text": "nested ok"}
        for _ in range(50):
            node = {"type": "blockquote", "content": [node]}
        root = {"type": "doc", "content": [node]}

        result = DocumentEmbeddingService._extract_text_from_pm_json(root)
        self.assertIn("nested ok", result)


if __name__ == "__main__":
    unittest.main()

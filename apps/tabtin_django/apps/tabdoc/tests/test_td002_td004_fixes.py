"""
回归测试：TD-002 和 TD-004 修复

TD-004: 空内容时应删除旧的 DocumentEmbedding，防止孤立向量污染搜索结果
TD-002: 路径 B（tabdoc.index_document_embedding）应创建 EmbeddingTask 追踪记录
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import override_settings


class TestTD004EmptyContentDeletesOldEmbedding(unittest.TestCase):
    """TD-004: 用户清空文档内容时，旧的 DocumentEmbedding 应被删除。"""

    def _make_doc(self, title="", plaintext="", pm_json=None, organization_id="ws-1", space_id="sp-1"):
        return SimpleNamespace(
            id="doc-empty-1",
            title=title,
            description_plaintext=plaintext,
            description_json=pm_json,
            organization_id=organization_id,
            space_id=space_id,
            status="active",
            trashed_at=None,
        )

    def test_empty_content_deletes_existing_embedding(self):
        """文档 title 和正文均为空时，应删除已存在的 DocumentEmbedding。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        doc = self._make_doc(title="", plaintext="")
        mock_embedding_qs = MagicMock()
        mock_embedding_objects = MagicMock()
        mock_embedding_objects.filter.return_value = mock_embedding_qs

        with patch("apps.tabdoc.models.Document.objects") as mock_doc_objects, \
             patch("apps.rag.models.DocumentEmbedding.objects", mock_embedding_objects):
            mock_doc_objects.filter.return_value.only.return_value.first.return_value = doc

            result = DocumentEmbeddingService.index_document("doc-empty-1")

        # 应调用 delete 清理旧索引
        mock_embedding_objects.filter.assert_called_with(document_id="doc-empty-1")
        mock_embedding_qs.delete.assert_called_once()
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "empty_content")

    def test_whitespace_only_content_deletes_existing_embedding(self):
        """文档内容仅有空白时，也应删除已存在的 DocumentEmbedding。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        doc = self._make_doc(title="   ", plaintext="   ")
        mock_embedding_qs = MagicMock()
        mock_embedding_objects = MagicMock()
        mock_embedding_objects.filter.return_value = mock_embedding_qs

        with patch("apps.tabdoc.models.Document.objects") as mock_doc_objects, \
             patch("apps.rag.models.DocumentEmbedding.objects", mock_embedding_objects):
            mock_doc_objects.filter.return_value.only.return_value.first.return_value = doc

            result = DocumentEmbeddingService.index_document("doc-empty-1")

        mock_embedding_objects.filter.assert_called_with(document_id="doc-empty-1")
        mock_embedding_qs.delete.assert_called_once()
        self.assertEqual(result["status"], "skipped")

    def test_non_empty_content_does_not_trigger_empty_content_path(self):
        """文档有内容时，不应触发 empty_content 路径（status != skipped/empty_content）。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        doc = self._make_doc(title="My Title", plaintext="Some content")
        mock_embedding_objects = MagicMock()
        mock_embedding_objects.filter.return_value.first.return_value = None
        mock_embedding_objects.update_or_create.return_value = (MagicMock(), True)

        mock_svc = MagicMock()
        mock_svc.embed_text.return_value = [0.1] * 1536

        with patch("apps.tabdoc.models.Document.objects") as mock_doc_objects, \
             patch("apps.rag.models.DocumentEmbedding.objects", mock_embedding_objects), \
             patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc), \
             patch("apps.rag.utils.calculate_content_hash", return_value="hash123"), \
             patch("django.db.transaction.atomic"):
            mock_doc_objects.filter.return_value.only.return_value.first.return_value = doc

            result = DocumentEmbeddingService.index_document("doc-empty-1")

        self.assertNotEqual(result.get("reason"), "empty_content")


class TestTD002PathBEmbeddingTaskTracking(unittest.TestCase):
    """TD-002: tabdoc.index_document_embedding（路径 B）应创建 EmbeddingTask 追踪记录。"""

    @patch("apps.tabdoc.tasks._resolve_document_organization", return_value="ws-uuid-1")
    @patch("apps.rag.models.EmbeddingTask.objects.update_or_create")
    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_document")
    def test_creates_embedding_task_on_success(self, mock_index, mock_uoc, mock_resolve):
        """成功时应创建 EmbeddingTask 并调用 mark_success。"""
        from apps.tabdoc.tasks import index_document_embedding

        mock_index.return_value = {"status": "success", "document_id": "doc-1"}
        task_record = MagicMock()
        mock_uoc.return_value = (task_record, True)

        index_document_embedding.apply(args=["doc-1"], task_id="celery-task-1")

        mock_uoc.assert_called_once()
        call_kwargs = mock_uoc.call_args
        self.assertEqual(call_kwargs[1]["celery_task_id"], "celery-task-1")
        defaults = call_kwargs[1]["defaults"]
        self.assertEqual(defaults["task_type"], "document")
        self.assertEqual(defaults["status"], "processing")
        task_record.mark_success.assert_called_once()

    @patch("apps.tabdoc.tasks._resolve_document_organization", return_value="ws-uuid-1")
    @patch("apps.rag.models.EmbeddingTask.objects.update_or_create")
    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_document")
    def test_creates_embedding_task_on_failure(self, mock_index, mock_uoc, mock_resolve):
        """embedding 失败时应创建 EmbeddingTask 并调用 mark_failed。"""
        from apps.tabdoc.tasks import index_document_embedding

        mock_index.return_value = {"status": "failed", "error": "embed error", "document_id": "doc-1"}
        task_record = MagicMock()
        mock_uoc.return_value = (task_record, True)

        # apply() 在 ALWAYS_EAGER 模式下会触发 retry，需捕获
        try:
            index_document_embedding.apply(args=["doc-1"], task_id="celery-task-fail")
        except Exception:
            pass

        mock_uoc.assert_called()
        task_record.mark_failed.assert_called()

    @patch("apps.tabdoc.tasks._resolve_document_organization", return_value="ws-uuid-1")
    @patch("apps.rag.models.EmbeddingTask.objects.update_or_create")
    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_document")
    def test_non_retryable_embedding_failure_does_not_retry(self, mock_index, mock_uoc, mock_resolve):
        """配置类失败应记录失败但不触发 Celery retry 风暴。"""
        from apps.tabdoc.tasks import index_document_embedding

        mock_index.return_value = {
            "status": "failed",
            "error": "Provider 'qwen_default' routing_enabled=False",
            "document_id": "doc-1",
            "failure_reason": "NoProviderHealthy",
            "retryable": False,
        }
        task_record = MagicMock()
        mock_uoc.return_value = (task_record, True)

        result = index_document_embedding.apply(args=["doc-1"], task_id="celery-task-config-fail")

        self.assertTrue(result.successful())
        task_record.mark_failed.assert_called_once_with("Provider 'qwen_default' routing_enabled=False")

    @patch("apps.tabdoc.tasks._resolve_document_organization", return_value="ws-uuid-1")
    @patch("apps.rag.models.EmbeddingTask.objects.update_or_create")
    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_document")
    def test_creates_embedding_task_on_skipped(self, mock_index, mock_uoc, mock_resolve):
        """skipped 时应创建 EmbeddingTask 并标记为 cancelled。"""
        from apps.tabdoc.tasks import index_document_embedding

        mock_index.return_value = {"status": "skipped", "reason": "unchanged", "document_id": "doc-1"}
        task_record = MagicMock()
        mock_uoc.return_value = (task_record, True)

        index_document_embedding.apply(args=["doc-1"], task_id="celery-task-skip")

        mock_uoc.assert_called_once()
        self.assertEqual(task_record.status, "cancelled")
        task_record.save.assert_called_once()

    @patch("apps.tabdoc.tasks._resolve_document_organization", return_value="ws-uuid-1")
    @patch("apps.rag.models.EmbeddingTask.objects.update_or_create")
    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_document")
    def test_retry_reuses_root_task_id(self, mock_index, mock_uoc, mock_resolve):
        """重试时应复用 root_task_id，使 EmbeddingTask 记录不重复创建（TI-03 模式）。"""
        from apps.tabdoc.tasks import index_document_embedding

        mock_index.return_value = {"status": "success", "document_id": "doc-1"}
        task_record = MagicMock()
        mock_uoc.return_value = (task_record, False)

        index_document_embedding.apply(
            args=["doc-1"],
            kwargs={"root_task_id": "celery-original-task-id"},
            task_id="celery-retry-task-id",
        )

        call_kwargs = mock_uoc.call_args
        self.assertEqual(call_kwargs[1]["celery_task_id"], "celery-original-task-id")

    def test_resolve_document_organization_returns_organization_id(self):
        """_resolve_document_organization 应正确返回文档的 organization_id。"""
        from apps.tabdoc.tasks import _resolve_document_organization

        mock_doc = MagicMock()
        mock_doc.organization_id = "ws-abc-123"

        with patch("apps.tabdoc.models.Document.objects.filter") as mock_filter:
            mock_filter.return_value.only.return_value.first.return_value = mock_doc
            result = _resolve_document_organization("doc-1")

        self.assertEqual(result, "ws-abc-123")

    def test_resolve_document_organization_returns_none_when_not_found(self):
        """_resolve_document_organization 在文档不存在时应返回 None。"""
        from apps.tabdoc.tasks import _resolve_document_organization

        with patch("apps.tabdoc.models.Document.objects.filter") as mock_filter:
            mock_filter.return_value.only.return_value.first.return_value = None
            result = _resolve_document_organization("nonexistent-doc")

        self.assertIsNone(result)


class TestTabDocEmbeddingFeatureGate(unittest.TestCase):
    """关闭 RAG 后，路径 B 不应继续创建或执行文档索引任务。"""

    def test_gate_requires_both_rag_switches(self):
        """总开关与文档自动索引开关必须同时开启。"""
        from apps.tabdoc.tasks import _is_document_embedding_enabled

        switch_cases = (
            (False, False, False),
            (False, True, False),
            (True, False, False),
            (True, True, True),
        )
        for rag_enabled, auto_embed_documents, expected in switch_cases:
            with self.subTest(
                rag_enabled=rag_enabled,
                auto_embed_documents=auto_embed_documents,
            ), override_settings(
                RAG_ENABLED=rag_enabled,
                RAG_AUTO_EMBED_DOCUMENTS=auto_embed_documents,
            ):
                self.assertEqual(_is_document_embedding_enabled(), expected)

    @patch("apps.tabdoc.tasks._is_document_embedding_enabled", return_value=False)
    @patch("apps.rag.models.EmbeddingTask.objects.update_or_create")
    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_document")
    def test_queued_task_skips_when_embedding_is_disabled(
        self,
        mock_index,
        mock_update_or_create,
        mock_enabled,
    ):
        """开关关闭前已入队的任务应安全跳过，不创建失败记录。"""
        from apps.tabdoc.tasks import index_document_embedding

        result = index_document_embedding.apply(
            args=["doc-disabled-1"],
            task_id="celery-task-disabled",
        )

        self.assertTrue(result.successful())
        self.assertEqual(
            result.result,
            {"status": "skipped", "reason": "rag_document_embedding_disabled"},
        )
        mock_update_or_create.assert_not_called()
        mock_index.assert_not_called()

    @patch("apps.tabdoc.tasks.index_document_embedding.apply_async")
    @patch("apps.tabdoc.tasks._is_document_embedding_enabled", return_value=False)
    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("django.core.cache.cache.delete")
    @patch("django.core.cache.cache.add", return_value=True)
    @patch("apps.tabdoc.models.Document.objects.get")
    def test_merge_does_not_dispatch_when_embedding_is_disabled(
        self,
        mock_get_document,
        mock_cache_add,
        mock_cache_delete,
        mock_service_class,
        mock_enabled,
        mock_apply_async,
    ):
        """文档合并成功后，开关关闭时不应投递新的索引任务。"""
        from apps.tabdoc.tasks import _merge_single_document

        document = MagicMock()
        mock_get_document.return_value = document
        mock_service_class.return_value.merge_updates.return_value = True

        result = _merge_single_document("doc-disabled-2")

        self.assertEqual(result, "merged")
        document.refresh_from_db.assert_called_once_with(
            fields=["last_editor_type", "last_editor_id"],
        )
        mock_apply_async.assert_not_called()


if __name__ == "__main__":
    unittest.main()

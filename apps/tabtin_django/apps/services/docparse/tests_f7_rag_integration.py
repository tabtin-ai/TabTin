"""
F7 测试 — docparse → RAG 索引断链修复 (DP-003)

验证：
1. _emit_completed 调用后会触发 trigger_rag_index_task
2. trigger_rag_index_task 在 RAG_ENABLED=True 时正确派发 RAG 索引任务
3. trigger_rag_index_task 在 RAG_ENABLED=False 时不派发
4. index_parsed_document_chunks_task 幂等性（content_hash 未变 → skip）
5. index_parsed_document_chunks_task 无 READY 文档时跳过
6. index_parsed_document_chunks_task 缺少 organization 上下文时跳过
"""

import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings


class EmitCompletedTriggersRAGTest(SimpleTestCase):
    """_emit_completed 触发 RAG 索引"""

    @patch("apps.services.docparse.tasks.trigger_rag_index_task")
    @patch("apps.services.docparse.service.publish_parse_completed", create=True)
    def test_emit_completed_dispatches_rag_task(self, _mock_ws, mock_trigger):
        from apps.services.docparse.service import _emit_completed

        parsed_doc = MagicMock()
        parsed_doc.file_record_id = uuid.uuid4()
        parsed_doc.total_pages = 5
        parsed_doc.parse_method = "text_layer"
        parsed_doc.title = "test.pdf"

        with patch(
            "apps.services.docparse.service._clear_async_dedup"
        ):
            _emit_completed(parsed_doc)

        mock_trigger.delay.assert_called_once_with(str(parsed_doc.file_record_id))

    @patch("apps.services.docparse.tasks.trigger_rag_index_task")
    @patch("apps.services.docparse.service.publish_parse_completed", create=True)
    def test_emit_completed_ws_failure_still_triggers_rag(self, mock_ws, mock_trigger):
        """WebSocket 推送失败不影响 RAG 索引触发"""
        from apps.services.docparse.service import _emit_completed

        mock_ws.side_effect = Exception("ws down")

        parsed_doc = MagicMock()
        parsed_doc.file_record_id = uuid.uuid4()
        parsed_doc.total_pages = 1
        parsed_doc.parse_method = "vision"
        parsed_doc.title = ""

        with patch("apps.services.docparse.service._clear_async_dedup"):
            _emit_completed(parsed_doc)

        mock_trigger.delay.assert_called_once_with(str(parsed_doc.file_record_id))


class TriggerRAGIndexTaskTest(SimpleTestCase):
    """docparse.trigger_rag_index 桥接任务"""

    @override_settings(RAG_ENABLED=True)
    @patch("apps.rag.tasks.index_parsed_document_chunks_task")
    def test_dispatches_when_rag_enabled(self, mock_index_task):
        from apps.services.docparse.tasks import trigger_rag_index_task

        frid = str(uuid.uuid4())
        trigger_rag_index_task.push_request(
            id=str(uuid.uuid4()), retries=0,
        )
        try:
            trigger_rag_index_task.__wrapped__(frid)
        finally:
            trigger_rag_index_task.pop_request()

        mock_index_task.delay.assert_called_once_with(frid)

    @override_settings(RAG_ENABLED=False)
    @patch("apps.rag.tasks.index_parsed_document_chunks_task")
    def test_skips_when_rag_disabled(self, mock_index_task):
        from apps.services.docparse.tasks import trigger_rag_index_task

        trigger_rag_index_task.push_request(
            id=str(uuid.uuid4()), retries=0,
        )
        try:
            trigger_rag_index_task.__wrapped__(str(uuid.uuid4()))
        finally:
            trigger_rag_index_task.pop_request()

        mock_index_task.delay.assert_not_called()


class IndexParsedDocumentChunksTaskTest(SimpleTestCase):
    """rag.index_parsed_document_chunks 核心索引任务（全 mock，无需 DB）"""

    @patch("apps.services.docparse.models.ParsedDocument.objects")
    def test_skip_when_no_ready_doc(self, mock_qs):
        from apps.rag.tasks import index_parsed_document_chunks_task

        mock_qs.filter.return_value.select_related.return_value.first.return_value = None

        index_parsed_document_chunks_task.push_request(
            id=str(uuid.uuid4()), retries=0,
        )
        try:
            result = index_parsed_document_chunks_task.__wrapped__(
                str(uuid.uuid4()),
            )
        finally:
            index_parsed_document_chunks_task.pop_request()

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "not_ready")

    @patch("apps.rag.tasks._resolve_docparse_contexts")
    @patch("apps.services.docparse.models.DocumentChunk.objects")
    @patch("apps.services.docparse.models.ParsedDocument.objects")
    def test_skip_when_missing_context(self, mock_pd_qs, mock_chunk_qs, mock_ctx):
        from apps.rag.tasks import index_parsed_document_chunks_task

        parsed_doc = MagicMock()
        parsed_doc.id = uuid.uuid4()
        parsed_doc.file_record_id = uuid.uuid4()
        parsed_doc.status = "ready"
        mock_pd_qs.filter.return_value.select_related.return_value.first.return_value = parsed_doc

        mock_chunk_qs.filter.return_value.order_by.return_value.values_list.return_value = [
            "chunk content",
        ]

        mock_ctx.return_value = []

        index_parsed_document_chunks_task.push_request(
            id=str(uuid.uuid4()), retries=0,
        )
        try:
            result = index_parsed_document_chunks_task.__wrapped__(
                str(uuid.uuid4()),
            )
        finally:
            index_parsed_document_chunks_task.pop_request()

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "missing_context")

    @patch("apps.rag.tasks._resolve_docparse_contexts")
    @patch("apps.rag.utils.calculate_content_hash", return_value="hash123")
    @patch("apps.rag.models.DocumentEmbedding.objects")
    @patch("apps.services.docparse.models.DocumentChunk.objects")
    @patch("apps.services.docparse.models.ParsedDocument.objects")
    def test_skip_when_content_unchanged(
        self, mock_pd_qs, mock_chunk_qs, mock_emb_qs, mock_hash, mock_ctx,
    ):
        from apps.rag.tasks import index_parsed_document_chunks_task

        parsed_doc = MagicMock()
        parsed_doc.id = uuid.uuid4()
        parsed_doc.file_record_id = uuid.uuid4()
        mock_pd_qs.filter.return_value.select_related.return_value.first.return_value = parsed_doc

        mock_chunk_qs.filter.return_value.order_by.return_value.values_list.return_value = [
            "some content",
        ]

        ws_id = uuid.uuid4()
        sp_id = uuid.uuid4()
        mock_ctx.return_value = [("user1", ws_id, sp_id)]

        mock_filter = MagicMock()
        mock_filter.count.return_value = 1
        mock_filter.exists.return_value = False
        mock_emb_qs.filter.return_value = mock_filter

        index_parsed_document_chunks_task.push_request(
            id=str(uuid.uuid4()), retries=0,
        )
        try:
            result = index_parsed_document_chunks_task.__wrapped__(
                str(uuid.uuid4()),
            )
        finally:
            index_parsed_document_chunks_task.pop_request()

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "unchanged")

    @patch("apps.rag.models.EmbeddingTask.objects")
    @patch("apps.rag.tasks._resolve_docparse_contexts")
    @patch("apps.rag.utils.calculate_content_hash", return_value="newhash")
    @patch("apps.rag.models.DocumentEmbedding.objects")
    @patch("apps.rag.services.embedding_service.get_embedding_service")
    @patch("apps.services.docparse.models.DocumentChunk.objects")
    @patch("apps.services.docparse.models.ParsedDocument.objects")
    def test_success_creates_embedding(
        self, mock_pd_qs, mock_chunk_qs, mock_embed_svc,
        mock_emb_qs, mock_hash, mock_ctx, mock_task_qs,
    ):
        from apps.rag.tasks import index_parsed_document_chunks_task

        parsed_doc = MagicMock()
        parsed_doc.id = uuid.uuid4()
        parsed_doc.file_record_id = uuid.uuid4()
        parsed_doc.title = "Report.pdf"
        parsed_doc.total_pages = 3
        parsed_doc.parse_method = "text_layer"
        mock_pd_qs.filter.return_value.select_related.return_value.first.return_value = parsed_doc

        mock_chunk_qs.filter.return_value.order_by.return_value.values_list.return_value = [
            "Page 1 content",
            "Page 2 content",
        ]

        ws_id = uuid.uuid4()
        sp_id = uuid.uuid4()
        mock_ctx.return_value = [("user1", ws_id, sp_id)]

        mock_filter = MagicMock()
        mock_filter.count.return_value = 0
        mock_filter.exists.return_value = False
        mock_emb_qs.filter.return_value = mock_filter

        mock_svc_instance = MagicMock()
        mock_svc_instance.embed_text.return_value = [0.1] * 1536
        mock_embed_svc.return_value = mock_svc_instance

        mock_task_record = MagicMock()
        mock_task_qs.update_or_create.return_value = (mock_task_record, True)

        index_parsed_document_chunks_task.push_request(
            id=str(uuid.uuid4()), retries=0,
        )
        try:
            with patch("apps.rag.tasks.transaction"):
                result = index_parsed_document_chunks_task.__wrapped__(
                    str(parsed_doc.file_record_id),
                )
        finally:
            index_parsed_document_chunks_task.pop_request()

        self.assertEqual(result["status"], "success")
        mock_svc_instance.embed_text.assert_called_once()
        call_text = mock_svc_instance.embed_text.call_args[0][0]
        self.assertIn("Report.pdf", call_text)
        self.assertIn("Page 1 content", call_text)
        mock_task_record.mark_success.assert_called_once()


class SourceCodeIntegrityTest(SimpleTestCase):
    """源码结构验证"""

    def _read(self, relpath: str) -> str:
        import os
        base = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(base, relpath)) as f:
            return f.read()

    def test_emit_completed_calls_trigger_rag_index(self):
        source = self._read("service.py")
        self.assertIn("_trigger_rag_index", source)
        self.assertIn("trigger_rag_index_task", source)

    def test_tasks_has_trigger_rag_index_task(self):
        source = self._read("tasks.py")
        self.assertIn("def trigger_rag_index_task", source)
        self.assertIn("index_parsed_document_chunks_task", source)

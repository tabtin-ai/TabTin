"""
BL-003 回归测试

问题：incremental_index_all 调用 index_documents_batch 完全不传 user_id，
全依赖 doc.created_by_id 兜底；系统导入文档（created_by_id=None）时
100% 静默跳过计费且无任何可见告警。

修复：
1. index_documents_batch 在 effective_user_id="" 时记录 warning 并累计 no_billing 计数
2. incremental_index_all 在 no_billing_total > 0 时记录汇总 warning
"""

import logging
from unittest.mock import MagicMock, patch, call

from django.test import SimpleTestCase


class BL003NoBillingWarningTest(SimpleTestCase):
    """验证 index_documents_batch 在 created_by_id=None 时记录告警并计入 no_billing 计数。"""

    def _make_doc(self, doc_id, organization_id="ws-1", space_id="sp-1", created_by_id=None):
        doc = MagicMock()
        doc.id = doc_id
        doc.organization_id = organization_id
        doc.space_id = space_id
        doc.created_by_id = created_by_id
        doc.status = "active"
        doc.trashed_at = None
        doc.title = "Test Doc"
        doc.description_plaintext = "some content"
        doc.description_json = None
        return doc

    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService._build_content")
    @patch("apps.rag.utils.calculate_content_hash")
    def test_no_billing_count_incremented_when_created_by_id_is_none(
        self, mock_hash, mock_build_content
    ):
        """当文档 created_by_id=None 且调用方未传 user_id 时，counts['no_billing'] 应为 1。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        doc = self._make_doc("doc-system-1", created_by_id=None)
        mock_build_content.return_value = "some content"
        mock_hash.return_value = "hash-abc"

        # Mock DocumentEmbedding 查询（content_hash 命中，直接 skipped）
        with patch("apps.tabdoc.models.Document") as MockDocument, \
             patch("apps.rag.models.DocumentEmbedding") as MockDocEmbedding, \
             patch("apps.rag.services.embedding_service.get_embedding_service"):

            MockDocument.objects.filter.return_value.only.return_value = [doc]
            # 模拟不命中已有 embedding，触发 embed 流程
            MockDocEmbedding.objects.filter.return_value.first.return_value = None

            mock_svc = MagicMock()
            mock_svc.embed_texts.return_value = [[0.1] * 10]

            with patch(
                "apps.rag.services.embedding_service.get_embedding_service",
                return_value=mock_svc,
            ), patch("apps.rag.models.DocumentEmbedding.objects") as mock_de_objects:
                mock_de_objects.filter.return_value.first.return_value = None

                # 捕获日志告警
                with self.assertLogs(
                    "apps.tabdoc.services.document_embedding_service", level="WARNING"
                ) as log_ctx:
                    counts = DocumentEmbeddingService.index_documents_batch(
                        document_ids=["doc-system-1"], force=False, user_id=""
                    )

        self.assertIn("no_billing", counts)
        self.assertEqual(counts["no_billing"], 1)
        self.assertTrue(
            any("BL-003" in msg for msg in log_ctx.output),
            "应当记录包含 BL-003 标识的 warning 日志",
        )

    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService._build_content")
    @patch("apps.rag.utils.calculate_content_hash")
    def test_no_billing_count_zero_when_created_by_id_is_set(
        self, mock_hash, mock_build_content
    ):
        """当文档 created_by_id 有值时，no_billing 不应增加。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        doc = self._make_doc("doc-owned-1", created_by_id="user-123")
        mock_build_content.return_value = "some content"
        mock_hash.return_value = "hash-xyz"

        with patch("apps.tabdoc.models.Document") as MockDocument, \
             patch("apps.rag.models.DocumentEmbedding") as MockDocEmbedding, \
             patch("apps.rag.services.embedding_service.get_embedding_service"):

            MockDocument.objects.filter.return_value.only.return_value = [doc]
            MockDocEmbedding.objects.filter.return_value.first.return_value = None

            mock_svc = MagicMock()
            mock_svc.embed_texts.return_value = [[0.1] * 10]

            with patch(
                "apps.rag.services.embedding_service.get_embedding_service",
                return_value=mock_svc,
            ), patch("apps.rag.models.DocumentEmbedding.objects") as mock_de_objects:
                mock_de_objects.filter.return_value.first.return_value = None

                counts = DocumentEmbeddingService.index_documents_batch(
                    document_ids=["doc-owned-1"], force=False, user_id=""
                )

        self.assertEqual(counts.get("no_billing", 0), 0)

    def test_no_billing_key_present_in_empty_result(self):
        """即使 document_ids 为空，返回的 counts 也应包含 no_billing 键。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        counts = DocumentEmbeddingService.index_documents_batch(document_ids=[])
        self.assertIn("no_billing", counts)
        self.assertEqual(counts["no_billing"], 0)


class BL003IncrementalIndexAllWarningTest(SimpleTestCase):
    """验证 incremental_index_all 在有 no_billing 文档时记录汇总告警。"""

    def test_incremental_index_all_logs_summary_warning_when_no_billing(self):
        """当 index_documents_batch 返回 no_billing > 0 时，incremental_index_all 应记录汇总 warning。"""
        from apps.rag.tasks import _run_incremental_index_all

        with patch("apps.tabdata.models.Table") as MockTable, \
             patch("apps.rag.services.IndexService") as MockIndexService, \
             patch("apps.tabdoc.models.Document") as MockDocument, \
             patch(
                 "apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_documents_batch",
             ) as mock_batch, \
             patch("apps.rag.tasks._get_checkpoint", return_value=None), \
             patch("apps.rag.tasks._set_checkpoint"), \
             patch("apps.rag.tasks._clear_checkpoint"), \
             patch("apps.rag.tasks._iter_id_batches") as mock_iter, \
             patch("apps.rag.tasks._acquire_target_lock", return_value=(True, "tok")), \
             patch("apps.rag.tasks._release_target_lock"):

            # Phase 1（tables）：返回空批次以快速跳过
            MockTable.objects.order_by.return_value.values_list.return_value = MagicMock()
            MockDocument.objects.filter.return_value.exclude.return_value.exclude.return_value.\
                order_by.return_value.values_list.return_value = MagicMock()

            # 让 _iter_id_batches 对 table 批次返回空，对 doc 批次返回一批
            def iter_side_effect(qs, batch_size):
                # 第一次调用（tables），返回空
                # 第二次调用（docs），返回一批含系统文档的 ID
                yield ["doc-sys-1"]

            mock_iter.side_effect = [iter_side_effect(None, 200), iter_side_effect(None, 200)]

            # Phase 1 表格部分直接不产生迭代（让 tables_done=True 快速通过）
            # 通过让第一个 iter 为空来实现
            mock_iter.side_effect = [
                iter([]),         # tables batch — 空
                iter([["doc-sys-1"]]),  # docs batch — 含一个系统文档 ID
            ]

            mock_batch.return_value = {
                "success": 1, "skipped": 0, "failed": 0, "no_billing": 1
            }

            with self.assertLogs("apps.rag.tasks", level="WARNING") as log_ctx:
                _run_incremental_index_all()

        self.assertTrue(
            any("BL-003" in msg for msg in log_ctx.output),
            "incremental_index_all 应当记录包含 BL-003 标识的汇总 warning 日志",
        )
        self.assertTrue(
            any("1" in msg and "document" in msg.lower() for msg in log_ctx.output),
            "汇总日志应包含跳过计费的文档数量",
        )

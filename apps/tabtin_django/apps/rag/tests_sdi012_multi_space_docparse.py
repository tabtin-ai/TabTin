"""
SDI-012 回归测试 — _resolve_docparse_contexts 多 Space 引用

验证：
1. 单 Space 引用时行为与修复前一致
2. 多 Space 引用时返回全部唯一上下文
3. 重复 Space 引用去重
4. 无活跃 FileUsage 时回退到 metadata
5. index_parsed_document_chunks_task 为每个 Space 创建独立 DocumentEmbedding
6. 向后兼容包装器 _resolve_docparse_context 仍然可用
"""

import uuid
from unittest.mock import MagicMock, patch, PropertyMock

from django.test import SimpleTestCase


class ResolveDocparseContextsTest(SimpleTestCase):
    """_resolve_docparse_contexts 多 Space 上下文解析"""

    def _make_parsed_doc(self, usages=None, metadata=None):
        parsed_doc = MagicMock()
        fr = MagicMock()
        fr.upload_user_id = uuid.uuid4()
        fr.metadata = metadata or {}

        if usages is not None:
            fr.usages.filter.return_value = usages
        else:
            fr.usages.filter.return_value = []

        parsed_doc.file_record = fr
        return parsed_doc

    def _make_usage(self, module, context_id):
        usage = MagicMock()
        usage.module = module
        usage.context_id = str(context_id)
        return usage

    @patch("apps.tabdoc.models.Document.objects")
    def test_single_space_returns_one_context(self, mock_doc_qs):
        from apps.rag.tasks import _resolve_docparse_contexts

        ws_id = uuid.uuid4()
        sp_id = uuid.uuid4()
        doc_id = uuid.uuid4()

        mock_doc = MagicMock()
        mock_doc.organization_id = ws_id
        mock_doc.space_id = sp_id
        mock_doc_qs.filter.return_value.only.return_value.first.return_value = mock_doc

        usage = self._make_usage("tabdoc", doc_id)
        parsed_doc = self._make_parsed_doc(usages=[usage])

        contexts = _resolve_docparse_contexts(parsed_doc)

        self.assertEqual(len(contexts), 1)
        self.assertEqual(contexts[0][1], ws_id)
        self.assertEqual(contexts[0][2], sp_id)

    @patch("apps.tabdata.models.Table.objects")
    @patch("apps.tabdoc.models.Document.objects")
    def test_multi_space_returns_all_contexts(self, mock_doc_qs, mock_table_qs):
        from apps.rag.tasks import _resolve_docparse_contexts

        ws_id = uuid.uuid4()
        sp_id_a = uuid.uuid4()
        sp_id_b = uuid.uuid4()

        mock_doc = MagicMock()
        mock_doc.organization_id = ws_id
        mock_doc.space_id = sp_id_a
        mock_doc_qs.filter.return_value.only.return_value.first.return_value = mock_doc

        mock_table = MagicMock()
        mock_table.organization_id = ws_id
        mock_table.space_id = sp_id_b
        mock_table_qs.filter.return_value.only.return_value.first.return_value = mock_table

        usage_doc = self._make_usage("tabdoc", uuid.uuid4())
        usage_table = self._make_usage("tabdata", uuid.uuid4())
        parsed_doc = self._make_parsed_doc(usages=[usage_doc, usage_table])

        contexts = _resolve_docparse_contexts(parsed_doc)

        self.assertEqual(len(contexts), 2)
        space_ids = {ctx[2] for ctx in contexts}
        self.assertIn(sp_id_a, space_ids)
        self.assertIn(sp_id_b, space_ids)

    @patch("apps.tabdoc.models.Document.objects")
    def test_duplicate_space_deduplication(self, mock_doc_qs):
        from apps.rag.tasks import _resolve_docparse_contexts

        ws_id = uuid.uuid4()
        sp_id = uuid.uuid4()

        mock_doc = MagicMock()
        mock_doc.organization_id = ws_id
        mock_doc.space_id = sp_id
        mock_doc_qs.filter.return_value.only.return_value.first.return_value = mock_doc

        usage_1 = self._make_usage("tabdoc", uuid.uuid4())
        usage_2 = self._make_usage("tabdoc", uuid.uuid4())
        parsed_doc = self._make_parsed_doc(usages=[usage_1, usage_2])

        contexts = _resolve_docparse_contexts(parsed_doc)

        self.assertEqual(len(contexts), 1)

    def test_no_usages_falls_back_to_metadata(self):
        from apps.rag.tasks import _resolve_docparse_contexts

        ws_id = str(uuid.uuid4())
        sp_id = str(uuid.uuid4())
        parsed_doc = self._make_parsed_doc(
            usages=[],
            metadata={"organization_id": ws_id, "space_id": sp_id},
        )

        contexts = _resolve_docparse_contexts(parsed_doc)

        self.assertEqual(len(contexts), 1)
        self.assertEqual(contexts[0][1], ws_id)
        self.assertEqual(contexts[0][2], sp_id)

    def test_no_file_record_returns_empty(self):
        from apps.rag.tasks import _resolve_docparse_contexts

        parsed_doc = MagicMock()
        parsed_doc.file_record = None

        contexts = _resolve_docparse_contexts(parsed_doc)
        self.assertEqual(contexts, [])

    @patch("apps.tabdoc.models.Document.objects")
    def test_contexts_are_sorted_deterministically(self, mock_doc_qs):
        """排序保证：相同输入在不同运行中返回一致顺序（version 分配稳定）"""
        from apps.rag.tasks import _resolve_docparse_contexts

        ws_id = uuid.uuid4()
        sp_id_z = uuid.UUID("ffffffff-ffff-ffff-ffff-ffffffffffff")
        sp_id_a = uuid.UUID("00000000-0000-0000-0000-000000000001")

        def mock_filter_side_effect(**kwargs):
            ctx_id = str(kwargs.get("id", ""))
            result = MagicMock()
            if ctx_id == str(sp_id_z):
                doc = MagicMock(organization_id=ws_id, space_id=sp_id_z)
            else:
                doc = MagicMock(organization_id=ws_id, space_id=sp_id_a)
            result.only.return_value.first.return_value = doc
            return result

        mock_doc_qs.filter.side_effect = mock_filter_side_effect

        usage_z = self._make_usage("tabdoc", sp_id_z)
        usage_a = self._make_usage("tabdoc", sp_id_a)
        parsed_doc = self._make_parsed_doc(usages=[usage_z, usage_a])

        contexts = _resolve_docparse_contexts(parsed_doc)

        self.assertEqual(len(contexts), 2)
        self.assertEqual(contexts[0][2], sp_id_a)
        self.assertEqual(contexts[1][2], sp_id_z)


class BackwardCompatWrapperTest(SimpleTestCase):
    """_resolve_docparse_context 向后兼容包装器"""

    @patch("apps.rag.tasks._resolve_docparse_contexts")
    def test_returns_first_context(self, mock_contexts):
        from apps.rag.tasks import _resolve_docparse_context

        ws_id = uuid.uuid4()
        sp_id = uuid.uuid4()
        mock_contexts.return_value = [("user1", ws_id, sp_id)]

        result = _resolve_docparse_context(MagicMock())

        self.assertEqual(result, ("user1", ws_id, sp_id))

    @patch("apps.rag.tasks._resolve_docparse_contexts")
    def test_returns_empty_when_no_contexts(self, mock_contexts):
        from apps.rag.tasks import _resolve_docparse_context

        mock_contexts.return_value = []

        result = _resolve_docparse_context(MagicMock())

        self.assertEqual(result, ("", None, None))


class IndexTaskMultiSpaceTest(SimpleTestCase):
    """index_parsed_document_chunks_task 多 Space 索引"""

    @patch("apps.rag.tasks._resolve_docparse_contexts")
    @patch("apps.services.docparse.models.DocumentChunk.objects")
    @patch("apps.services.docparse.models.ParsedDocument.objects")
    def test_skip_when_no_contexts(self, mock_pd_qs, mock_chunk_qs, mock_ctx):
        from apps.rag.tasks import index_parsed_document_chunks_task

        parsed_doc = MagicMock()
        parsed_doc.id = uuid.uuid4()
        mock_pd_qs.filter.return_value.select_related.return_value.first.return_value = parsed_doc
        mock_chunk_qs.filter.return_value.order_by.return_value.values_list.return_value = ["content"]
        mock_ctx.return_value = []

        index_parsed_document_chunks_task.push_request(id=str(uuid.uuid4()), retries=0)
        try:
            result = index_parsed_document_chunks_task.__wrapped__(str(uuid.uuid4()))
        finally:
            index_parsed_document_chunks_task.pop_request()

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "missing_context")

    @patch("apps.rag.models.EmbeddingTask.objects")
    @patch("apps.rag.tasks._resolve_docparse_contexts")
    @patch("apps.rag.utils.calculate_content_hash")
    @patch("apps.rag.models.DocumentEmbedding.objects")
    @patch("apps.rag.services.embedding_service.get_embedding_service")
    @patch("apps.services.docparse.models.DocumentChunk.objects")
    @patch("apps.services.docparse.models.ParsedDocument.objects")
    def test_creates_embedding_per_space(
        self, mock_pd_qs, mock_chunk_qs, mock_embed_svc,
        mock_emb_qs, mock_hash, mock_ctx, mock_task_qs,
    ):
        """SDI-012 核心回归：多 Space 引用时为每个 Space 创建独立 DocumentEmbedding"""
        from apps.rag.tasks import index_parsed_document_chunks_task

        parsed_doc = MagicMock()
        parsed_doc.id = uuid.uuid4()
        parsed_doc.file_record_id = uuid.uuid4()
        parsed_doc.title = "Report.pdf"
        parsed_doc.total_pages = 3
        parsed_doc.parse_method = "text_layer"
        mock_pd_qs.filter.return_value.select_related.return_value.first.return_value = parsed_doc

        mock_chunk_qs.filter.return_value.order_by.return_value.values_list.return_value = [
            "Page 1",
            "Page 2",
        ]

        ws_id = uuid.uuid4()
        sp_id_a = uuid.uuid4()
        sp_id_b = uuid.uuid4()
        mock_ctx.return_value = [
            ("user1", ws_id, sp_id_a),
            ("user1", ws_id, sp_id_b),
        ]

        hash_counter = {"n": 0}
        def fake_hash(text):
            hash_counter["n"] += 1
            return f"hash_{hash_counter['n']}"
        mock_hash.side_effect = fake_hash

        mock_emb_qs.filter.return_value.count.return_value = 0
        mock_emb_qs.filter.return_value.exists.return_value = False

        mock_svc_instance = MagicMock()
        mock_svc_instance.embed_text.return_value = [0.1] * 1536
        mock_embed_svc.return_value = mock_svc_instance

        mock_task_record = MagicMock()
        mock_task_qs.update_or_create.return_value = (mock_task_record, True)

        index_parsed_document_chunks_task.push_request(id=str(uuid.uuid4()), retries=0)
        try:
            with patch("apps.rag.tasks.transaction"):
                result = index_parsed_document_chunks_task.__wrapped__(
                    str(parsed_doc.file_record_id),
                )
        finally:
            index_parsed_document_chunks_task.pop_request()

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["spaces_indexed"], 2)

        mock_svc_instance.embed_text.assert_called_once()

        uoc_calls = mock_emb_qs.update_or_create.call_args_list
        self.assertEqual(len(uoc_calls), 2)

        versions_used = {call.kwargs.get("version", call[1].get("version", None))
                         for call in uoc_calls}
        if not versions_used or None in versions_used:
            versions_used = set()
            for call in uoc_calls:
                args, kwargs = call
                if len(args) >= 1:
                    pass
                v = kwargs.get("version")
                if v is None and len(args) >= 2:
                    v = args[1]
                versions_used.add(v)

        space_ids_in_calls = set()
        for call in uoc_calls:
            _, kwargs = call
            defaults = kwargs.get("defaults", {})
            sp = defaults.get("space_id")
            if sp:
                space_ids_in_calls.add(sp)

        self.assertEqual(space_ids_in_calls, {sp_id_a, sp_id_b})
        mock_task_record.mark_success.assert_called_once()

    @patch("apps.rag.models.EmbeddingTask.objects")
    @patch("apps.rag.tasks._resolve_docparse_contexts")
    @patch("apps.rag.utils.calculate_content_hash", return_value="samehash")
    @patch("apps.rag.models.DocumentEmbedding.objects")
    @patch("apps.services.docparse.models.DocumentChunk.objects")
    @patch("apps.services.docparse.models.ParsedDocument.objects")
    def test_skip_when_all_hashes_match_and_no_stale(
        self, mock_pd_qs, mock_chunk_qs, mock_emb_qs, mock_hash, mock_ctx, mock_task_qs,
    ):
        """幂等性：所有 Space 的 content_hash 均已存在且无过期版本时跳过"""
        from apps.rag.tasks import index_parsed_document_chunks_task

        parsed_doc = MagicMock()
        parsed_doc.id = uuid.uuid4()
        mock_pd_qs.filter.return_value.select_related.return_value.first.return_value = parsed_doc
        mock_chunk_qs.filter.return_value.order_by.return_value.values_list.return_value = ["content"]

        mock_ctx.return_value = [("user1", uuid.uuid4(), uuid.uuid4())]

        mock_filter = MagicMock()
        mock_filter.count.return_value = 1
        mock_filter.exists.return_value = False
        mock_emb_qs.filter.return_value = mock_filter

        index_parsed_document_chunks_task.push_request(id=str(uuid.uuid4()), retries=0)
        try:
            result = index_parsed_document_chunks_task.__wrapped__(str(uuid.uuid4()))
        finally:
            index_parsed_document_chunks_task.pop_request()

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "unchanged")

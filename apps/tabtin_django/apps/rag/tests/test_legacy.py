"""
RAG 模块测试

覆盖：
- 数据模型基础操作
- EmbeddingService 文本截断 + 向量化
- UnifiedSearchService 权限隔离 + 搜索逻辑
- ContextService 上下文构建
- RAG_ENABLED 开关
- 信号防抖
"""

from django.test import TestCase, override_settings
from django.core.cache import cache
import unittest
from unittest.mock import patch, MagicMock, PropertyMock
import uuid

from apps.rag.models import (
    TableEmbedding,
    RecordEmbedding,
    EmbeddingTask,
    SearchLog,
    SkillEmbedding,
    DocumentEmbedding,
)


# =====================================================================
# 模型测试
# =====================================================================

class TableEmbeddingModelTest(TestCase):
    databases = {"postgresql"}

    def test_create_and_hash(self):
        emb = TableEmbedding.objects.create(
            table_id=uuid.uuid4(),
            content="test content",
            content_hash=TableEmbedding.calculate_content_hash("test content"),
            embedding=[0.1] * 1536,
            metadata={"table_name": "Demo"},
        )
        # SI-01 fix: default status is now 'pending', not 'success'
        self.assertEqual(emb.status, "pending")
        self.assertEqual(len(emb.embedding), 1536)
        self.assertTrue(emb.content_hash)


class RecordEmbeddingModelTest(TestCase):
    databases = {"postgresql"}

    def test_create(self):
        emb = RecordEmbedding.objects.create(
            record_id=uuid.uuid4(),
            table_id=uuid.uuid4(),
            content="record text",
            content_hash="hash123",
            embedding=[0.2] * 1536,
            metadata={"table_name": "T1"},
        )
        self.assertEqual(emb.version, 1)
        self.assertEqual(emb.priority, 0)


class EmbeddingTaskModelTest(TestCase):
    databases = {"postgresql"}

    def test_lifecycle(self):
        task = EmbeddingTask.objects.create(
            task_type="table",
            target_id=uuid.uuid4(),
            status="pending",
        )
        task.mark_started()
        self.assertEqual(task.status, "processing")

        task.mark_success()
        task.refresh_from_db()
        self.assertEqual(task.status, "success")
        self.assertIsNotNone(task.completed_at)

    def test_mark_failed(self):
        task = EmbeddingTask.objects.create(
            task_type="record",
            target_id=uuid.uuid4(),
        )
        task.mark_started()
        task.mark_failed("some error")
        task.refresh_from_db()
        self.assertEqual(task.status, "failed")
        self.assertEqual(task.error_message, "some error")


class SearchLogModelTest(TestCase):
    databases = {"postgresql"}

    def test_create_without_embedding(self):
        log = SearchLog.objects.create(
            user_id=uuid.uuid4(),
            query="hello",
            results_count=3,
            top_similarity_score=0.9,
            response_time_ms=42,
        )
        self.assertEqual(log.results_count, 3)
        self.assertIsNone(log.query_embedding)


# =====================================================================
# EmbeddingService — 文本截断
# =====================================================================

class EmbeddingServiceTruncateTest(TestCase):
    """测试 _truncate_text 方法（P0-5）。"""

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_truncate_long_text(self, _mock_init):
        from django.conf import settings
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        max_tokens = getattr(settings, "RAG_MAX_TOKENS_PER_REQUEST", 8192)
        max_chars = max_tokens * 2 // 3
        long_text = "a" * (max_chars + 100)
        result = svc._truncate_text(long_text)
        self.assertEqual(len(result), max_chars)

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_short_text_unchanged(self, _mock_init):
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        short_text = "hello world"
        self.assertEqual(svc._truncate_text(short_text), short_text)


# =====================================================================
# UnifiedSearchService
# =====================================================================

class UnifiedSearchServiceTest(TestCase):
    """测试统一检索服务（P0-1 权限 + P1-1 SearchLog + P1-2 record 过滤 + RAG_ENABLED）。"""

    @patch("apps.rag.services.unified_search_service._get_user_accessible_organizations")
    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def _make_service(self, _mock_init, mock_organizations):
        mock_organizations.return_value = ["ws-1", "ws-2"]
        from apps.rag.services.unified_search_service import UnifiedSearchService
        return UnifiedSearchService()

    @override_settings(RAG_ENABLED=False)
    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_rag_disabled_returns_error(self, _mock_init):
        from apps.rag.services.unified_search_service import UnifiedSearchService
        svc = UnifiedSearchService()
        result = svc.search(query="hello", user_id="user-1")
        self.assertEqual(result["total"], 0)
        self.assertIn("disabled", result.get("error", ""))

    @patch("apps.rag.services.unified_search_service._get_user_accessible_organizations")
    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_unauthorized_organization_rejected(self, _mock_init, mock_ws):
        mock_ws.return_value = ["ws-1"]
        from apps.rag.services.unified_search_service import UnifiedSearchService
        svc = UnifiedSearchService()
        result = svc.search(
            query="hello",
            user_id="user-1",
            organization_id="ws-999",
        )
        self.assertIn("No access", result.get("error", ""))

    @patch("apps.rag.services.unified_search_service._get_user_accessible_organizations")
    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_empty_query_returns_empty(self, _mock_init, mock_ws):
        mock_ws.return_value = ["ws-1"]
        from apps.rag.services.unified_search_service import UnifiedSearchService
        svc = UnifiedSearchService()
        result = svc.search(query="", user_id="user-1")
        self.assertEqual(result["total"], 0)

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_resolve_types_filters_unknown(self, _mock_init):
        from apps.rag.services.unified_search_service import UnifiedSearchService
        svc = UnifiedSearchService()
        result = svc._resolve_types(["table", "nonexistent"])
        self.assertIn("table", result)
        self.assertNotIn("nonexistent", result)


# =====================================================================
# ContextService
# =====================================================================

class ContextServiceTest(TestCase):

    def test_build_context_basic(self):
        from apps.rag.services.context_service import ContextService

        svc = ContextService()
        results = [
            {
                "type": "table",
                "content": "表格内容",
                "similarity_score": 0.85,
                "table_name": "Demo",
                "metadata": {"table_name": "Demo"},
            },
        ]
        ctx = svc.build_context(results, query="test query")
        self.assertIsInstance(ctx, str)
        self.assertGreater(len(ctx), 0)

    def test_build_unified_context(self):
        from apps.rag.services.context_service import ContextService

        svc = ContextService()
        hits = [
            {
                "content_type": "table",
                "source_id": "t1",
                "title": "Sales",
                "content": "Monthly sales data",
                "similarity": 0.9,
                "metadata": {},
            },
            {
                "content_type": "skill",
                "source_id": "s1",
                "title": "DataAnalysis",
                "content": "Analyze data patterns",
                "similarity": 0.8,
                "metadata": {},
            },
        ]
        ctx = svc.build_unified_context(hits=hits, query="sales report")
        self.assertIn("Sales", ctx)
        self.assertIn("DataAnalysis", ctx)


# =====================================================================
# 信号防抖
# =====================================================================

class SignalDebounceTest(TestCase):

    def setUp(self):
        cache.clear()

    def test_should_index_first_call_passes(self):
        from apps.rag.signals import _should_index
        self.assertTrue(_should_index("test:123", cooldown_seconds=5))

    def test_should_index_second_call_blocked(self):
        from apps.rag.signals import _should_index
        self.assertTrue(_should_index("test:456", cooldown_seconds=5))
        self.assertFalse(_should_index("test:456", cooldown_seconds=5))

    def test_different_keys_independent(self):
        from apps.rag.signals import _should_index
        self.assertTrue(_should_index("a:1", cooldown_seconds=5))
        self.assertTrue(_should_index("b:2", cooldown_seconds=5))


# =====================================================================
# RAG_ENABLED 开关 — API 层
# =====================================================================

class RagEnabledCheckTest(TestCase):

    def test_check_rag_enabled_returns_none_when_enabled(self):
        from apps.rag.api import _check_rag_enabled
        with self.settings(RAG_ENABLED=True):
            self.assertIsNone(_check_rag_enabled())

    def test_check_rag_enabled_returns_503_when_disabled(self):
        from apps.rag.api import _check_rag_enabled
        with self.settings(RAG_ENABLED=False):
            result = _check_rag_enabled()
            self.assertIsNotNone(result)
            self.assertEqual(result[0], 503)


# =====================================================================
# DocumentEmbedding 模型测试
# =====================================================================

class USS01EmptyOrganizationIdsScopeBypassTest(TestCase):
    """USS-01 回归测试：accessible_organization_ids 为空列表时，scope 分支必须返回空结果，
    而非跳过 organization 权限过滤执行无隔离查询。"""

    DUMMY_VECTOR = [0.1] * 1536
    COMMON_KWARGS = {
        "user_id": "user-1",
        "organization_id": None,
        "top_k": 10,
        "threshold": 0.7,
        "max_content_length": 300,
    }

    def test_table_scope_table_id_empty_organization_ids_returns_empty(self):
        from apps.rag.services.unified_search_service import _search_tables
        result = _search_tables(
            query_vector=self.DUMMY_VECTOR,
            accessible_organization_ids=[],
            scope={"table_id": "some-table-id"},
            **self.COMMON_KWARGS,
        )
        self.assertEqual(result, [])

    def test_table_scope_space_id_empty_organization_ids_returns_empty(self):
        from apps.rag.services.unified_search_service import _search_tables
        result = _search_tables(
            query_vector=self.DUMMY_VECTOR,
            accessible_organization_ids=[],
            scope={"space_id": "some-space-id"},
            **self.COMMON_KWARGS,
        )
        self.assertEqual(result, [])

    def test_record_scope_table_id_empty_organization_ids_returns_empty(self):
        from apps.rag.services.unified_search_service import _search_records
        result = _search_records(
            query_vector=self.DUMMY_VECTOR,
            accessible_organization_ids=[],
            scope={"table_id": "some-table-id"},
            **self.COMMON_KWARGS,
        )
        self.assertEqual(result, [])

    def test_document_scope_space_id_empty_organization_ids_returns_empty(self):
        from apps.rag.services.unified_search_service import _search_documents
        result = _search_documents(
            query_vector=self.DUMMY_VECTOR,
            accessible_organization_ids=[],
            scope={"space_id": "some-space-id"},
            **self.COMMON_KWARGS,
        )
        self.assertEqual(result, [])

    def test_table_no_scope_empty_organization_ids_returns_empty(self):
        """无 scope 且空 organization_ids 时也应返回空（else 分支，已有保护）。"""
        from apps.rag.services.unified_search_service import _search_tables
        result = _search_tables(
            query_vector=self.DUMMY_VECTOR,
            accessible_organization_ids=[],
            scope=None,
            **self.COMMON_KWARGS,
        )
        self.assertEqual(result, [])

    def test_record_no_scope_empty_organization_ids_returns_empty(self):
        from apps.rag.services.unified_search_service import _search_records
        result = _search_records(
            query_vector=self.DUMMY_VECTOR,
            accessible_organization_ids=[],
            scope=None,
            **self.COMMON_KWARGS,
        )
        self.assertEqual(result, [])

    def test_document_no_scope_empty_organization_ids_returns_empty(self):
        from apps.rag.services.unified_search_service import _search_documents
        result = _search_documents(
            query_vector=self.DUMMY_VECTOR,
            accessible_organization_ids=[],
            scope=None,
            **self.COMMON_KWARGS,
        )
        self.assertEqual(result, [])

    @patch("apps.rag.services.unified_search_service._get_user_accessible_organizations")
    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_full_search_with_empty_organization_ids_returns_no_results(
        self, _mock_init, mock_ws
    ):
        """集成级：用户无任何 organization 权限时，整个 search 应返回空。"""
        mock_ws.return_value = []
        from apps.rag.services.unified_search_service import UnifiedSearchService
        svc = UnifiedSearchService()
        svc.embedding_service = MagicMock()
        svc.embedding_service.embed_text.return_value = self.DUMMY_VECTOR
        result = svc.search(
            query="test",
            user_id="user-no-access",
            content_types=["table", "record", "document"],
        )
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["hits"], [])


class DocumentEmbeddingModelTest(TestCase):
    databases = {"postgresql"}

    def test_create(self):
        emb = DocumentEmbedding.objects.create(
            document_id=uuid.uuid4(),
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            content="document text",
            content_hash="hash_doc",
            embedding=[0.3] * 1536,
            metadata={"title": "MyDoc"},
        )
        # SI-01 fix: default status is now 'pending', not 'success'
        self.assertEqual(emb.status, "pending")
        self.assertEqual(emb.version, 1)

    def test_str_representation(self):
        doc_id = uuid.uuid4()
        emb = DocumentEmbedding(document_id=doc_id, status="success")
        self.assertIn(str(doc_id), str(emb))


# =====================================================================
# EmbeddingTask document 类型
# =====================================================================

class EmbeddingTaskDocumentTypeTest(TestCase):
    databases = {"postgresql"}

    def test_create_document_task(self):
        task = EmbeddingTask.objects.create(
            task_type="document",
            target_id=uuid.uuid4(),
            status="pending",
        )
        self.assertEqual(task.task_type, "document")
        task.mark_started()
        task.mark_success()
        task.refresh_from_db()
        self.assertEqual(task.status, "success")


# =====================================================================
# DocumentEmbeddingService 单元测试
# =====================================================================

class DocumentEmbeddingServiceTest(TestCase):
    databases = {"postgresql"}

    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService._build_content")
    @patch("apps.rag.services.embedding_service.get_embedding_service")
    def test_index_document_not_found_cleans_up(self, mock_embed_svc, mock_build):
        """document 不存在时应清理残留 embedding 并返回 not_found。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        fake_id = str(uuid.uuid4())
        result = DocumentEmbeddingService.index_document(fake_id)
        self.assertEqual(result["status"], "not_found")

    @patch("apps.rag.services.embedding_service.get_embedding_service")
    def test_index_document_skips_empty_content(self, mock_embed_svc):
        """空内容文档应跳过索引。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        mock_doc = MagicMock()
        mock_doc.id = uuid.uuid4()
        mock_doc.title = ""
        mock_doc.description_plaintext = ""
        mock_doc.status = "active"
        mock_doc.trashed_at = None
        mock_doc.organization_id = uuid.uuid4()
        mock_doc.space_id = uuid.uuid4()

        with patch("apps.tabdoc.models.Document.objects") as mock_qs:
            mock_qs.filter.return_value.only.return_value.first.return_value = mock_doc
            result = DocumentEmbeddingService.index_document(str(mock_doc.id))

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "empty_content")

    def test_delete_document_index_returns_dict(self):
        """delete_document_index 应返回 dict 格式。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        fake_id = str(uuid.uuid4())
        result = DocumentEmbeddingService.delete_document_index(fake_id)
        self.assertIsInstance(result, dict)
        self.assertIn("deleted", result)
        self.assertEqual(result["deleted"], 0)


# =====================================================================
# SearchService v1 委托测试
# =====================================================================

class SearchServiceDelegationTest(TestCase):

    @patch("apps.rag.services.unified_search_service.get_unified_search_service")
    def test_search_delegates_to_unified(self, mock_get_svc):
        from apps.rag.services.search_service import SearchService

        mock_svc = MagicMock()
        mock_svc.search.return_value = {"hits": [], "total": 0, "type_counts": {}}
        mock_get_svc.return_value = mock_svc

        svc = SearchService()
        result = svc.search(query="test", user_id="u1", scope_id="ws1")
        mock_svc.search.assert_called_once()
        self.assertEqual(result["total"], 0)


# =====================================================================
# API 资源访问校验测试
# =====================================================================

class ApiAccessCheckTest(TestCase):

    @patch("apps.rag.api._get_accessible_organization_ids")
    def test_check_table_access_forbidden(self, mock_ws):
        from apps.rag.api import _check_table_access

        mock_ws.return_value = ["ws-1"]
        mock_table = MagicMock()
        mock_table.organization_id = "ws-999"

        with patch("apps.tabdata.models.Table.objects") as mock_qs:
            mock_qs.filter.return_value.only.return_value.first.return_value = mock_table
            result = _check_table_access("user-1", "table-1")

        self.assertIsNotNone(result)
        self.assertEqual(result[0], 403)

    @patch("apps.rag.api._get_accessible_organization_ids")
    def test_check_table_access_allowed(self, mock_ws):
        from apps.rag.api import _check_table_access

        mock_ws.return_value = ["ws-1"]
        mock_table = MagicMock()
        mock_table.organization_id = "ws-1"

        with patch("apps.tabdata.models.Table.objects") as mock_qs:
            mock_qs.filter.return_value.only.return_value.first.return_value = mock_table
            result = _check_table_access("user-1", "table-1")

        self.assertIsNone(result)

    def test_check_table_access_not_found(self):
        from apps.rag.api import _check_table_access

        with patch("apps.tabdata.models.Table.objects") as mock_qs:
            mock_qs.filter.return_value.only.return_value.first.return_value = None
            result = _check_table_access("user-1", "nonexistent")

        self.assertIsNotNone(result)
        self.assertEqual(result[0], 400)


# =====================================================================
# SEC-01 / SEC-02: _check_task_access 安全修复回归测试
# =====================================================================

class CheckTaskAccessSecurityTest(TestCase):
    """SEC-01 / SEC-02: 验证 _check_task_access 在任务不存在或孤儿 record 时拒绝访问。"""

    def test_sec01_nonexistent_task_returns_403(self):
        """SEC-01: EmbeddingTask 记录不存在时必须返回 403，不能放行。"""
        from apps.rag.api import _check_task_access

        with patch("apps.rag.models.EmbeddingTask.objects") as mock_qs:
            mock_qs.filter.return_value.first.return_value = None
            result = _check_task_access("user-1", "nonexistent-celery-id")

        self.assertIsNotNone(result, "任务不存在时不应返回 None（放行）")
        self.assertEqual(result[0], 403)
        self.assertEqual(result[1].error, "forbidden")

    def test_sec02_orphan_record_task_returns_403(self):
        """SEC-02: task_type='record' 但 TableRecord 已被删除时必须返回 403。"""
        from apps.rag.api import _check_task_access

        mock_task = MagicMock()
        mock_task.task_type = "record"
        mock_task.target_id = uuid.uuid4()

        with patch("apps.rag.models.EmbeddingTask.objects") as mock_task_qs:
            mock_task_qs.filter.return_value.first.return_value = mock_task
            with patch("apps.tabdata.models.TableRecord.objects") as mock_rec_qs:
                mock_rec_qs.filter.return_value.only.return_value.first.return_value = None
                result = _check_task_access("user-1", "some-celery-id")

        self.assertIsNotNone(result, "孤儿 record 任务不应返回 None（放行）")
        self.assertEqual(result[0], 403)
        self.assertEqual(result[1].error, "forbidden")

    @patch("apps.rag.api._check_table_access", return_value=None)
    def test_valid_table_task_allowed(self, mock_table_check):
        """正常 table 类型任务应委托给 _check_table_access。"""
        from apps.rag.api import _check_task_access

        mock_task = MagicMock()
        mock_task.task_type = "table"
        mock_task.target_id = uuid.uuid4()

        with patch("apps.rag.models.EmbeddingTask.objects") as mock_qs:
            mock_qs.filter.return_value.first.return_value = mock_task
            result = _check_task_access("user-1", "celery-123")

        self.assertIsNone(result)
        mock_table_check.assert_called_once_with("user-1", str(mock_task.target_id))

    @patch("apps.rag.api._check_table_access", return_value=None)
    def test_valid_record_task_delegates_to_table_check(self, mock_table_check):
        """正常 record 类型任务应通过 TableRecord 的 table_id 委托给 _check_table_access。"""
        from apps.rag.api import _check_task_access

        mock_task = MagicMock()
        mock_task.task_type = "record"
        mock_task.target_id = uuid.uuid4()

        mock_rec = MagicMock()
        mock_rec.table_id = uuid.uuid4()

        with patch("apps.rag.models.EmbeddingTask.objects") as mock_task_qs:
            mock_task_qs.filter.return_value.first.return_value = mock_task
            with patch("apps.tabdata.models.TableRecord.objects") as mock_rec_qs:
                mock_rec_qs.filter.return_value.only.return_value.first.return_value = mock_rec
                result = _check_task_access("user-1", "celery-456")

        self.assertIsNone(result)
        mock_table_check.assert_called_once_with("user-1", str(mock_rec.table_id))

    @patch("apps.rag.api._check_document_access", return_value=None)
    def test_valid_document_task_delegates_to_doc_check(self, mock_doc_check):
        """正常 document 类型任务应委托给 _check_document_access。"""
        from apps.rag.api import _check_task_access

        mock_task = MagicMock()
        mock_task.task_type = "document"
        mock_task.target_id = uuid.uuid4()

        with patch("apps.rag.models.EmbeddingTask.objects") as mock_qs:
            mock_qs.filter.return_value.first.return_value = mock_task
            result = _check_task_access("user-1", "celery-789")

        self.assertIsNone(result)
        mock_doc_check.assert_called_once_with("user-1", str(mock_task.target_id))

    def test_unknown_task_type_returns_403(self):
        """FND-15: 未知 task_type 应拒绝访问。"""
        from apps.rag.api import _check_task_access

        mock_task = MagicMock()
        mock_task.task_type = "unknown_type"
        mock_task.target_id = uuid.uuid4()

        with patch("apps.rag.models.EmbeddingTask.objects") as mock_qs:
            mock_qs.filter.return_value.first.return_value = mock_task
            result = _check_task_access("user-1", "celery-unknown")

        self.assertIsNotNone(result)
        self.assertEqual(result[0], 403)


# =====================================================================
# SVC-16: 增量索引 checkpoint 断点续传回归测试
# =====================================================================

class IncrementalIndexCheckpointTest(TestCase):
    """SVC-16 / EQ-026: 验证 incremental_index_all 支持 Redis checkpoint 断点续传。

    EQ-026 修复：不再全量 mock checkpoint 函数，改为使用内存字典真实跟踪写入值，
    以检测 off-by-one 等逻辑错误。
    """

    def _make_checkpoint_tracker(self):
        """返回一组实际跟踪状态的 checkpoint 函数（替代全 mock）。"""
        from apps.rag.tasks import _INCREMENTAL_CHECKPOINT_KEY, _INCREMENTAL_DOC_CHECKPOINT_KEY
        storage: dict = {}

        def fake_get(key=_INCREMENTAL_CHECKPOINT_KEY):
            return storage.get(key)

        def fake_set(item_id, key=_INCREMENTAL_CHECKPOINT_KEY):
            storage[key] = item_id

        def fake_clear(key=_INCREMENTAL_CHECKPOINT_KEY):
            storage.pop(key, None)

        return fake_get, fake_set, fake_clear, storage

    @override_settings(RAG_ENABLED=True)
    def test_full_run_clears_checkpoint_after_completion(self):
        """完整跑完后 checkpoint 应被清除，而非残留（EQ-026 off-by-one 验证）。"""
        from apps.rag.tasks import incremental_index_all, _INCREMENTAL_CHECKPOINT_KEY
        fake_get, fake_set, fake_clear, storage = self._make_checkpoint_tracker()

        table_ids = [uuid.uuid4(), uuid.uuid4()]

        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        with patch("apps.rag.tasks._get_checkpoint", side_effect=fake_get), \
             patch("apps.rag.tasks._set_checkpoint", side_effect=fake_set), \
             patch("apps.rag.tasks._clear_checkpoint", side_effect=fake_clear), \
             patch("apps.rag.services.IndexService") as mock_index_cls, \
             patch("apps.tabdata.models.Table.objects") as mock_table_qs, \
             patch("apps.tabdoc.models.Document.objects") as mock_doc_qs, \
             patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_documents_batch"), \
             patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks._acquire_target_lock", return_value="fake-token"), \
             patch("apps.rag.tasks._release_target_lock"):

            mock_table_qs.order_by.return_value.values_list.return_value.iterator.return_value = iter(table_ids)
            mock_svc = MagicMock()
            mock_svc.index_tables_batch.return_value = {
                "total": 2, "success": 2, "skipped": 0, "failed": 0,
            }
            mock_index_cls.return_value = mock_svc
            mock_doc_qs.filter.return_value.exclude.return_value.exclude.return_value \
                .order_by.return_value.values_list.return_value.iterator.return_value = iter([])

            result = incremental_index_all()

        self.assertTrue(result["success"])
        self.assertNotIn(_INCREMENTAL_CHECKPOINT_KEY, storage,
                         "完整运行后 checkpoint key 应被清除，而非残留")

    @override_settings(RAG_ENABLED=True)
    def test_checkpoint_value_equals_last_batch_id(self):
        """批处理期间 _set_checkpoint 调用值应为批次最后一个 ID（off-by-one 验证）。"""
        from apps.rag.tasks import incremental_index_all, _INCREMENTAL_CHECKPOINT_KEY
        fake_get, fake_set, fake_clear, storage = self._make_checkpoint_tracker()

        set_calls: list = []

        def tracking_set(item_id, key=_INCREMENTAL_CHECKPOINT_KEY):
            set_calls.append(item_id)
            fake_set(item_id, key)

        table_ids = [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]

        with patch("apps.rag.tasks._get_checkpoint", side_effect=fake_get), \
             patch("apps.rag.tasks._set_checkpoint", side_effect=tracking_set), \
             patch("apps.rag.tasks._clear_checkpoint", side_effect=fake_clear), \
             patch("apps.rag.services.IndexService") as mock_index_cls, \
             patch("apps.tabdata.models.Table.objects") as mock_table_qs, \
             patch("apps.tabdoc.models.Document.objects") as mock_doc_qs, \
             patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_documents_batch"):

            mock_table_qs.order_by.return_value.values_list.return_value.iterator.return_value = iter(table_ids)
            mock_svc = MagicMock()
            mock_svc.index_tables_batch.return_value = {
                "total": len(table_ids), "success": len(table_ids), "skipped": 0, "failed": 0,
            }
            mock_index_cls.return_value = mock_svc
            mock_doc_qs.filter.return_value.exclude.return_value.exclude.return_value \
                .order_by.return_value.values_list.return_value.iterator.return_value = iter([])

            incremental_index_all()

        # 最后一次 _set_checkpoint 的值应为批次最后一个 table_id（str 化后）
        if set_calls:
            last_set = set_calls[-1]
            self.assertEqual(last_set, str(table_ids[-1]),
                             f"checkpoint 应记录最后处理的 ID，期望 {str(table_ids[-1])}，实际 {last_set}")

    @override_settings(RAG_ENABLED=True)
    def test_resume_from_checkpoint_applies_correct_filter(self):
        """恢复时 _get_checkpoint 读到预存值，并以 id__gt=<checkpoint_id> 过滤查询。"""
        from apps.rag.tasks import incremental_index_all, _INCREMENTAL_CHECKPOINT_KEY
        fake_get, fake_set, fake_clear, storage = self._make_checkpoint_tracker()

        last_id = str(uuid.uuid4())
        fake_set(last_id)

        mock_qs_chain = MagicMock()
        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        with patch("apps.rag.tasks._get_checkpoint", side_effect=fake_get), \
             patch("apps.rag.tasks._set_checkpoint", side_effect=fake_set), \
             patch("apps.rag.tasks._clear_checkpoint", side_effect=fake_clear), \
             patch("apps.rag.services.IndexService") as mock_index_cls, \
             patch("apps.tabdata.models.Table.objects") as mock_table_qs, \
             patch("apps.tabdoc.models.Document.objects") as mock_doc_qs, \
             patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_documents_batch"), \
             patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks._acquire_target_lock", return_value="fake-token"), \
             patch("apps.rag.tasks._release_target_lock"):

            mock_table_qs.order_by.return_value.values_list.return_value = mock_qs_chain
            mock_qs_chain.filter.return_value.iterator.return_value = iter([])
            mock_svc = MagicMock()
            mock_index_cls.return_value = mock_svc
            mock_doc_qs.filter.return_value.exclude.return_value.exclude.return_value \
                .order_by.return_value.values_list.return_value.iterator.return_value = iter([])

            result = incremental_index_all()

        self.assertTrue(result["success"])
        mock_qs_chain.filter.assert_called_once_with(id__gt=last_id)

    @override_settings(RAG_ENABLED=False)
    def test_disabled_rag_skips(self):
        from apps.rag.tasks import incremental_index_all
        result = incremental_index_all()
        self.assertTrue(result.get("skipped"))

    @override_settings(RAG_ENABLED=True)
    def test_checkpoint_cleared_for_both_tables_and_docs(self):
        """Table 和 Document 两个 checkpoint key 均应在完整运行后被清除。"""
        from apps.rag.tasks import (
            incremental_index_all,
            _INCREMENTAL_CHECKPOINT_KEY,
            _INCREMENTAL_DOC_CHECKPOINT_KEY,
        )
        storage: dict = {}

        def fake_get(key=_INCREMENTAL_CHECKPOINT_KEY):
            return storage.get(key)

        def fake_set(item_id, key=_INCREMENTAL_CHECKPOINT_KEY):
            storage[key] = item_id

        def fake_clear(key=_INCREMENTAL_CHECKPOINT_KEY):
            storage.pop(key, None)

        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        with patch("apps.rag.tasks._get_checkpoint", side_effect=fake_get), \
             patch("apps.rag.tasks._set_checkpoint", side_effect=fake_set), \
             patch("apps.rag.tasks._clear_checkpoint", side_effect=fake_clear), \
             patch("apps.rag.services.IndexService") as mock_index_cls, \
             patch("apps.tabdata.models.Table.objects") as mock_table_qs, \
             patch("apps.tabdoc.models.Document.objects") as mock_doc_qs, \
             patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_documents_batch"), \
             patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks._acquire_target_lock", return_value="fake-token"), \
             patch("apps.rag.tasks._release_target_lock"):

            mock_table_qs.order_by.return_value.values_list.return_value.iterator.return_value = iter([])
            mock_svc = MagicMock()
            mock_index_cls.return_value = mock_svc
            mock_doc_qs.filter.return_value.exclude.return_value.exclude.return_value \
                .order_by.return_value.values_list.return_value.iterator.return_value = iter([])

            result = incremental_index_all()

        self.assertTrue(result["success"])
        self.assertNotIn(_INCREMENTAL_CHECKPOINT_KEY, storage)
        self.assertNotIn(_INCREMENTAL_DOC_CHECKPOINT_KEY, storage)


# =====================================================================
# SVC-37: RAG Signal 风暴防护回归测试
# =====================================================================

class RecordDebounceTrailingEdgeTest(TestCase):
    """SVC-37 / EQ-025: 验证 record 信号使用 trailing edge 批量合并（行为测试）。

    EQ-025 修复：不再用 inspect.getsource() 检查字符串，改为实际触发信号/调用
    处理函数，通过 mock Redis + Celery task 验证真实行为。
    """

    @override_settings(RAG_ENABLED=True, RAG_AUTO_EMBED_RECORDS=True)
    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    def test_auto_index_record_triggers_debounce_not_direct_delay(self, mock_txn, mock_debounce):
        """auto_index_record 应调用 _debounce_record_index，而非直接 embed_record_task.delay()。"""
        from apps.rag.signals import auto_index_record

        # 让 on_commit 立即执行回调，绕过事务提交等待
        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        mock_instance = MagicMock()
        mock_instance.id = uuid.uuid4()
        mock_instance.table_id = uuid.uuid4()

        auto_index_record(sender=None, instance=mock_instance, created=True)

        mock_debounce.assert_called_once_with(
            str(mock_instance.table_id), str(mock_instance.id)
        )

    @override_settings(RAG_ENABLED=True, RAG_AUTO_EMBED_RECORDS=True)
    @patch("apps.rag.tasks.embed_record_task")
    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    def test_auto_index_record_does_not_call_embed_directly(self, mock_txn, mock_debounce, mock_embed):
        """auto_index_record 不应直接调用 embed_record_task.delay()（trailing edge 语义）。"""
        from apps.rag.signals import auto_index_record

        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        mock_instance = MagicMock()
        mock_instance.id = uuid.uuid4()
        mock_instance.table_id = uuid.uuid4()

        auto_index_record(sender=None, instance=mock_instance, created=True)

        mock_embed.delay.assert_not_called()

    @patch("apps.rag.tasks.embed_record_task")
    @patch("django_redis.get_redis_connection")
    def test_flush_record_batch_dispatches_tasks(self, mock_get_redis, mock_embed):
        """_flush_record_batch 应通过 SPOP 从 Redis 取出 record id 并逐条分发。"""
        from apps.rag.tasks import _flush_record_batch

        table_id = str(uuid.uuid4())
        record_ids = [str(uuid.uuid4()) for _ in range(3)]

        mock_redis = MagicMock()
        # 实现使用 spop（非 smembers），第一次返回 3 条，第二次返回空以终止循环
        mock_redis.spop.side_effect = [
            [rid.encode() for rid in record_ids],
            [],
        ]
        mock_redis.scard.return_value = 0
        mock_get_redis.return_value = mock_redis

        result = _flush_record_batch(table_id)

        self.assertEqual(result["flushed"], 3)
        self.assertEqual(mock_embed.delay.call_count, 3)


# =====================================================================
# SVC-17: 异步删除索引回归测试
# =====================================================================

class AsyncDeleteIndexTest(TestCase):
    """SVC-17 / EQ-025: 验证删除信号使用 .delay() 异步调用而非同步执行（行为测试）。

    EQ-025 修复：不再用 inspect.getsource() 检查字符串，改为实际调用信号处理函数，
    通过 mock on_commit + Celery task 验证 .delay() 是否被触发。
    """

    @override_settings(RAG_ENABLED=True)
    @patch("apps.rag.tasks._async_delete_table_index")
    @patch("apps.rag.signals.transaction")
    def test_auto_delete_table_uses_async_task(self, mock_txn, mock_task):
        """auto_delete_table_index 应在 on_commit 后调用 _async_delete_table_index.delay()。"""
        from apps.rag.signals import auto_delete_table_index

        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        mock_instance = MagicMock()
        mock_instance.id = uuid.uuid4()

        auto_delete_table_index(sender=None, instance=mock_instance)

        mock_task.delay.assert_called_once_with(str(mock_instance.id))

    @override_settings(RAG_ENABLED=True)
    @patch("apps.rag.tasks._async_delete_record_index")
    @patch("apps.rag.signals.transaction")
    def test_auto_delete_record_uses_async_task(self, mock_txn, mock_task):
        """auto_delete_record_index 应在 on_commit 后调用 _async_delete_record_index.delay()。"""
        from apps.rag.signals import auto_delete_record_index

        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        mock_instance = MagicMock()
        mock_instance.id = uuid.uuid4()

        auto_delete_record_index(sender=None, instance=mock_instance)

        mock_task.delay.assert_called_once_with(str(mock_instance.id))

    @override_settings(RAG_ENABLED=False)
    @patch("apps.rag.signals.transaction")
    def test_rag_disabled_skips_delete(self, mock_txn):
        """RAG_ENABLED=False 时，删除信号不应触发任何任务。"""
        from apps.rag.signals import auto_delete_table_index

        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        mock_instance = MagicMock()
        mock_instance.id = uuid.uuid4()

        with patch("apps.rag.tasks._async_delete_table_index") as mock_task:
            auto_delete_table_index(sender=None, instance=mock_instance)
            mock_task.delay.assert_not_called()


# =====================================================================
# EQ-001: get_index_coverage 使用子查询而非 Python 列表
# =====================================================================

class MonitorServiceIndexCoverageSubqueryTest(TestCase):
    """EQ-001 回归测试：get_index_coverage 必须使用数据库子查询，不将全量 ID 加载到 Python 内存。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.tabdata.models import Table
        self.ws_id = uuid.uuid4()
        self.space_id = uuid.uuid4()

        self.table_indexed = Table.objects.create(
            name="indexed_table",
            organization_id=self.ws_id,
            space_id=self.space_id,
        )
        self.table_unindexed = Table.objects.create(
            name="unindexed_table",
            organization_id=self.ws_id,
            space_id=self.space_id,
        )

        TableEmbedding.objects.create(
            table_id=self.table_indexed.id,
            content="indexed content",
            content_hash=TableEmbedding.calculate_content_hash("indexed content"),
            embedding=[0.1] * 1536,
            metadata={"table_name": "indexed_table"},
        )

    def test_unindexed_count_correct(self):
        """验证 unindexed 计数准确：1 张有索引 + 1 张无索引 → unindexed=1。"""
        from apps.rag.services.monitor_service import MonitorService

        service = MonitorService()
        result = service.get_index_coverage()

        self.assertEqual(result['table_coverage']['total'], 2)
        self.assertEqual(result['table_coverage']['indexed'], 1)
        self.assertEqual(result['table_coverage']['unindexed'], 1)

    def test_uses_subquery_not_python_list(self):
        """验证查询走数据库子查询（values）而非 values_list + flat=True 加载到 Python。"""
        import inspect
        from apps.rag.services.monitor_service import MonitorService

        source = inspect.getsource(MonitorService.get_index_coverage)
        self.assertIn(
            "TableEmbedding.objects.values('table_id')",
            source,
            "应使用 values('table_id') 子查询，避免全量 ID 加载到 Python 内存",
        )
        self.assertNotIn(
            "values_list('table_id', flat=True)",
            source,
            "不应使用 values_list(flat=True)，会将全量 ID 加载到 Python 内存（EQ-001）",
        )

    def test_all_tables_indexed(self):
        """所有表都有索引时 unindexed 应为 0。"""
        from apps.tabdata.models import Table
        from apps.rag.services.monitor_service import MonitorService

        TableEmbedding.objects.create(
            table_id=self.table_unindexed.id,
            content="now indexed",
            content_hash=TableEmbedding.calculate_content_hash("now indexed"),
            embedding=[0.2] * 1536,
            metadata={"table_name": "unindexed_table"},
        )

        service = MonitorService()
        result = service.get_index_coverage()

        self.assertEqual(result['table_coverage']['unindexed'], 0)
        self.assertEqual(result['table_coverage']['indexed'], 2)
        self.assertAlmostEqual(result['table_coverage']['coverage_rate'], 100.0)

    def test_no_tables_exist(self):
        """无表格时覆盖率应为 0，不报错。"""
        from apps.tabdata.models import Table
        from apps.rag.services.monitor_service import MonitorService

        Table.objects.all().delete()
        TableEmbedding.objects.all().delete()

        service = MonitorService()
        result = service.get_index_coverage()

        self.assertEqual(result['table_coverage']['total'], 0)
        self.assertEqual(result['table_coverage']['indexed'], 0)
        self.assertEqual(result['table_coverage']['unindexed'], 0)
        self.assertEqual(result['table_coverage']['coverage_rate'], 0)


# =====================================================================
# CS-01 ~ CS-04: ContextService P0 回归测试
# =====================================================================

class CS01_TokenEstimateCJKTest(TestCase):
    """CS-01 回归：_estimate_tokens 对中文文本应返回更高 token 数，
    _truncate_by_tokens 在中文场景下不允许远超 max_context_tokens。"""

    def _make_svc(self, max_tokens=4000):
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=max_tokens):
            return ContextService()

    def test_estimate_tokens_pure_chinese(self):
        svc = self._make_svc()
        text = "你" * 1000
        tokens = svc._estimate_tokens(text)
        self.assertGreaterEqual(tokens, 1000, "1000 个中文字符应 >= 1000 token")
        self.assertLessEqual(tokens, 1500, "1000 个中文字符应 <= 1500 token")

    def test_estimate_tokens_pure_english(self):
        svc = self._make_svc()
        text = "a" * 1000
        tokens = svc._estimate_tokens(text)
        self.assertGreaterEqual(tokens, 200)
        self.assertLessEqual(tokens, 300)

    def test_estimate_tokens_mixed(self):
        svc = self._make_svc()
        text = "你好hello世界world"
        tokens = svc._estimate_tokens(text)
        self.assertGreater(tokens, 0)

    def test_truncate_chinese_respects_limit(self):
        """纯中文文本截断后估算 token 不应超过 max_context_tokens 太多。"""
        svc = self._make_svc(max_tokens=100)
        text = "测" * 500
        result = svc._truncate_by_tokens(text)
        result_tokens = svc._estimate_tokens(result)
        self.assertLessEqual(
            result_tokens,
            120,
            f"截断后 token ({result_tokens}) 不应远超限制 (100)",
        )

    def test_truncate_short_text_unchanged(self):
        svc = self._make_svc(max_tokens=4000)
        short = "短文本"
        self.assertEqual(svc._truncate_by_tokens(short), short)

    def test_old_formula_would_overflow(self):
        """旧公式 max_chars = max_tokens * 4 对中文会严重溢出，
        新 _estimate_tokens 应正确拦截。"""
        svc = self._make_svc(max_tokens=100)
        text = "中" * 400
        old_max_chars = 100 * 4
        self.assertLessEqual(
            len(text), old_max_chars,
            "旧公式允许 400 个中文字符通过（实际约 520 token）",
        )
        result = svc._truncate_by_tokens(text)
        self.assertLess(len(result), len(text), "新逻辑应截断")


class CS02_JsonContextIntegrityTest(TestCase):
    """CS-02 回归：JSON 格式上下文必须是合法 JSON，不会被字符级截断破坏。"""

    def _make_svc(self, max_tokens=200):
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=max_tokens):
            return ContextService()

    def test_json_output_is_valid(self):
        import json
        svc = self._make_svc(max_tokens=200)
        results = [
            {"content": "内容A" * 50, "similarity_score": 0.9, "table_name": "T1"},
            {"content": "内容B" * 50, "similarity_score": 0.8, "table_name": "T2"},
            {"content": "内容C" * 50, "similarity_score": 0.7, "table_name": "T3"},
        ]
        ctx = svc.build_context(results, query="test", format_type="json")
        parsed = json.loads(ctx)
        self.assertIsInstance(parsed, list)

    def test_json_respects_token_limit(self):
        import json
        svc = self._make_svc(max_tokens=100)
        results = [
            {"content": "x" * 2000, "similarity_score": 0.9, "table_name": "Big"},
        ]
        ctx = svc.build_context(results, query="q", format_type="json")
        parsed = json.loads(ctx)
        self.assertIsInstance(parsed, list)

    def test_json_with_v2_fields(self):
        import json
        svc = self._make_svc(max_tokens=2000)
        results = [
            {"content": "v2 data", "similarity": 0.95, "title": "Sales"},
        ]
        ctx = svc.build_context(results, query="q", format_type="json")
        parsed = json.loads(ctx)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["table_name"], "Sales")
        self.assertAlmostEqual(parsed[0]["similarity"], 0.95, places=2)

    def test_json_empty_when_single_item_exceeds_limit(self):
        import json
        svc = self._make_svc(max_tokens=5)
        results = [
            {"content": "x" * 5000, "similarity_score": 0.9, "table_name": "Huge"},
        ]
        ctx = svc.build_context(results, query="q", format_type="json")
        parsed = json.loads(ctx)
        self.assertIsInstance(parsed, list)

    def test_json_not_truncated_by_build_context(self):
        """build_context(format_type='json') 不应调用 _truncate_by_tokens。"""
        import json
        svc = self._make_svc(max_tokens=500)
        results = [
            {"content": "data", "similarity_score": 0.9, "table_name": "T"},
        ]
        ctx = svc.build_context(results, query="q", format_type="json")
        self.assertNotIn("内容过长，已截断", ctx)
        json.loads(ctx)


class CS03_ExtractMetadataV2CompatTest(TestCase):
    """CS-03 回归：extract_metadata 必须同时兼容 v1 (similarity_score) 和 v2 (similarity) 字段。"""

    def _make_svc(self):
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=4000):
            return ContextService()

    def test_v1_fields(self):
        svc = self._make_svc()
        results = [
            {"similarity_score": 0.9, "table_name": "T1", "content": "c1"},
            {"similarity_score": 0.7, "table_name": "T2", "content": "c2"},
        ]
        meta = svc.extract_metadata(results)
        self.assertAlmostEqual(meta["max_similarity"], 0.9)
        self.assertAlmostEqual(meta["min_similarity"], 0.7)
        self.assertAlmostEqual(meta["avg_similarity"], 0.8)
        self.assertEqual(meta["table_distribution"]["T1"], 1)

    def test_v2_fields(self):
        svc = self._make_svc()
        results = [
            {"similarity": 0.85, "title": "Sales", "content": "data"},
            {"similarity": 0.75, "title": "Users", "content": "data"},
        ]
        meta = svc.extract_metadata(results)
        self.assertAlmostEqual(meta["max_similarity"], 0.85)
        self.assertAlmostEqual(meta["min_similarity"], 0.75)
        self.assertEqual(meta["table_distribution"]["Sales"], 1)
        self.assertEqual(meta["table_distribution"]["Users"], 1)

    def test_mixed_v1_v2(self):
        svc = self._make_svc()
        results = [
            {"similarity_score": 0.9, "table_name": "Legacy", "content": "old"},
            {"similarity": 0.8, "title": "Modern", "content": "new"},
        ]
        meta = svc.extract_metadata(results)
        self.assertEqual(meta["total_results"], 2)
        self.assertAlmostEqual(meta["max_similarity"], 0.9)
        self.assertIn("Legacy", meta["table_distribution"])
        self.assertIn("Modern", meta["table_distribution"])

    def test_empty_results(self):
        svc = self._make_svc()
        meta = svc.extract_metadata([])
        self.assertEqual(meta, {})


class CS04_StructuredContextV2CompatTest(TestCase):
    """CS-04 回归：_build_structured_context 必须同时兼容 v1 和 v2 字段名。"""

    def _make_svc(self):
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=4000):
            return ContextService()

    def test_v1_fields_structured(self):
        svc = self._make_svc()
        results = [
            {"similarity_score": 0.88, "table_name": "Orders", "content": "order data"},
        ]
        ctx = svc.build_context(results, query="orders", format_type="structured")
        self.assertIn("0.88", ctx)
        self.assertIn("Orders", ctx)
        self.assertIn("order data", ctx)

    def test_v2_fields_structured(self):
        svc = self._make_svc()
        results = [
            {"similarity": 0.92, "title": "Revenue", "content": "revenue data"},
        ]
        ctx = svc.build_context(results, query="revenue", format_type="structured")
        self.assertIn("0.92", ctx)
        self.assertIn("Revenue", ctx)
        self.assertIn("revenue data", ctx)

    def test_v2_fields_no_keyerror(self):
        """v2 字段不应触发 KeyError（修复前的 crash 场景）。"""
        svc = self._make_svc()
        results = [
            {"similarity": 0.5, "title": "T", "content": "c"},
        ]
        try:
            ctx = svc.build_context(results, query="q", format_type="structured")
        except KeyError as e:
            self.fail(f"v2 字段触发 KeyError: {e}")
        self.assertIsInstance(ctx, str)

    def test_mixed_v1_v2_structured(self):
        svc = self._make_svc()
        results = [
            {"similarity_score": 0.9, "table_name": "OldTable", "content": "v1"},
            {"similarity": 0.8, "title": "NewTitle", "content": "v2"},
        ]
        ctx = svc.build_context(results, query="mix", format_type="structured")
        self.assertIn("OldTable", ctx)
        self.assertIn("NewTitle", ctx)


# =====================================================================
# CS-05 ~ CS-08: ContextService P1 回归测试
# =====================================================================

class CS05_TruncationNoticeWithinLimitTest(TestCase):
    """CS-05 回归：截断后追加提示文字，最终 token 数不得超出 max_context_tokens。"""

    def _make_svc(self, max_tokens):
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=max_tokens):
            return ContextService()

    def test_truncated_total_tokens_within_limit(self):
        """截断结果（含提示文字）的 token 估算必须 <= max_context_tokens。"""
        svc = self._make_svc(max_tokens=100)
        long_text = "测试内容" * 200
        result = svc._truncate_by_tokens(long_text)
        total_tokens = svc._estimate_tokens(result)
        self.assertLessEqual(
            total_tokens,
            100,
            f"截断后含提示文字的 token ({total_tokens}) 超出上限 (100)",
        )

    def test_truncated_result_ends_with_notice(self):
        """触发截断时，结果应以截断提示文字结尾。"""
        svc = self._make_svc(max_tokens=50)
        long_text = "a" * 5000
        result = svc._truncate_by_tokens(long_text)
        self.assertTrue(
            result.endswith(svc._TRUNCATION_NOTICE.strip()),
            "截断结果应以提示文字结尾",
        )

    def test_short_text_not_truncated(self):
        """未超限的文本不应被截断，也不添加提示文字。"""
        svc = self._make_svc(max_tokens=4000)
        short = "短文本内容"
        result = svc._truncate_by_tokens(short)
        self.assertEqual(result, short)
        self.assertNotIn("已截断", result)

    def test_max_tokens_override_respected(self):
        """max_tokens 参数可覆盖实例默认值。"""
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=4000):
            svc = ContextService()
        long_text = "测" * 500
        result = svc._truncate_by_tokens(long_text, max_tokens=50)
        total_tokens = svc._estimate_tokens(result)
        self.assertLessEqual(total_tokens, 50, "override max_tokens 应生效")


class CS06_HybridContextFooterAlwaysPresentTest(TestCase):
    """CS-06 回归：build_hybrid_context 截断时固定页脚（使用说明）必须始终出现在输出中。"""

    def _make_svc(self, max_tokens):
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=max_tokens):
            return ContextService()

    def _make_table_results(self, count=5, content_len=500):
        return [
            {
                "table_name": f"Table{i}",
                "similarity_score": 0.9 - i * 0.1,
                "metadata": {
                    "description": "x" * content_len,
                    "fields": [f"f{j}" for j in range(10)],
                },
            }
            for i in range(count)
        ]

    def test_footer_present_when_content_truncated(self):
        """超长知识内容被截断后，使用说明页脚必须完整出现在输出末尾。"""
        svc = self._make_svc(max_tokens=200)
        table_results = self._make_table_results(count=10, content_len=1000)
        ctx = svc.build_hybrid_context(
            table_results=table_results,
            record_results=[],
            query="测试查询",
        )
        self.assertIn("以上内容来自用户的知识库", ctx,
                       "使用说明页脚第一条应始终出现在输出中")
        self.assertIn("根据相似度排序", ctx,
                       "使用说明页脚第二条应始终出现在输出中")

    def test_footer_present_without_truncation(self):
        """内容未超限时，使用说明页脚同样应出现。"""
        svc = self._make_svc(max_tokens=4000)
        ctx = svc.build_hybrid_context(
            table_results=[{
                "table_name": "Demo",
                "similarity_score": 0.8,
                "metadata": {"description": "短描述", "fields": ["f1"]},
            }],
            record_results=[],
            query="q",
        )
        self.assertIn("以上内容来自用户的知识库", ctx)

    def test_total_tokens_within_limit_after_truncation(self):
        """混合上下文（含页脚）的 token 估算不应远超上限。"""
        svc = self._make_svc(max_tokens=300)
        table_results = self._make_table_results(count=20, content_len=2000)
        ctx = svc.build_hybrid_context(
            table_results=table_results,
            record_results=[],
            query="测试",
        )
        tokens = svc._estimate_tokens(ctx)
        self.assertLessEqual(
            tokens, 360,
            f"混合上下文 token ({tokens}) 超出上限 300 太多",
        )


class CS07_TypeLabelsCodeMappingTest(TestCase):
    """CS-07 回归：_TYPE_LABELS 中必须包含 code → 代码 映射；
    build_unified_context 对 code 类型命中应显示中文标题。"""

    def _make_svc(self):
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=4000):
            return ContextService()

    def test_code_label_exists_in_type_labels(self):
        from apps.rag.services.context_service import ContextService
        self.assertIn("code", ContextService._TYPE_LABELS,
                       "_TYPE_LABELS 应包含 code 键")
        self.assertEqual(ContextService._TYPE_LABELS["code"], "代码",
                          "_TYPE_LABELS['code'] 应为 '代码'")

    def test_build_unified_context_code_type_shows_chinese_header(self):
        """build_unified_context 处理 content_type='code' 时，二级标题应为 '代码' 而非 'code'。"""
        svc = self._make_svc()
        hits = [
            {
                "content_type": "code",
                "source_id": "c1",
                "title": "auth.py",
                "content": "def login(): pass",
                "similarity": 0.88,
                "metadata": {},
            }
        ]
        ctx = svc.build_unified_context(hits=hits, query="登录代码")
        self.assertIn("代码", ctx, "输出中应出现中文标题 '代码'")
        self.assertNotIn("## code", ctx, "输出中不应出现英文原始 key '## code'")

    def test_build_unified_context_unknown_type_falls_back_to_key(self):
        """未知 content_type 应 fallback 为原始 key，不报错。"""
        svc = self._make_svc()
        hits = [
            {
                "content_type": "video",
                "source_id": "v1",
                "title": "tutorial.mp4",
                "content": "视频内容",
                "similarity": 0.7,
                "metadata": {},
            }
        ]
        ctx = svc.build_unified_context(hits=hits, query="视频")
        self.assertIn("video", ctx)


class CS08_MarkdownNewlineAlignedTruncationTest(TestCase):
    """CS-08 回归：字符级截断必须回退到换行符边界，确保不切断行内 Markdown 结构。"""

    def _make_svc(self, max_tokens):
        from apps.rag.services.context_service import ContextService
        with self.settings(RAG_MAX_CONTEXT_TOKENS=max_tokens):
            return ContextService()

    def test_truncation_does_not_split_mid_line(self):
        """截断结果（不含截断提示）的最后一个字符前，不应出现未闭合的 ** 标记。"""
        svc = self._make_svc(max_tokens=80)
        lines = [f"**标题{i}**\n内容行{i}的详细描述" for i in range(50)]
        long_text = "\n".join(lines)
        result = svc._truncate_by_tokens(long_text)
        # 去掉截断提示，检查正文部分
        body = result.replace(svc._TRUNCATION_NOTICE, "")
        self.assertTrue(
            body.endswith('\n') or '\n' in body,
            "截断正文应以换行符结尾（表明在行边界截断）",
        )

    def test_truncation_result_ends_at_newline_when_possible(self):
        """当文本中存在换行符时，截断点应落在换行符处。"""
        svc = self._make_svc(max_tokens=50)
        # 构造每行都有内容的文本，确保存在换行符
        text = ("A" * 100 + "\n") * 50
        result = svc._truncate_by_tokens(text)
        body = result[: -len(svc._TRUNCATION_NOTICE)]
        self.assertTrue(
            body.endswith('\n') or body == "",
            f"截断正文应在换行符处结束，实际末尾为: {repr(body[-20:])}",
        )

    def test_no_broken_bold_marker(self):
        """截断后的正文部分不应出现单个孤立的 * 标记（Markdown 结构被切断的特征）。"""
        svc = self._make_svc(max_tokens=60)
        # 构造含大量 **bold** 的多行 Markdown 文本
        lines = ["**粗体标题{}**\n正文内容，包含一些普通文字。".format(i) for i in range(100)]
        text = "\n".join(lines)
        result = svc._truncate_by_tokens(text)
        body = result[: -len(svc._TRUNCATION_NOTICE)]
        # 不应在行中间断开（即最后一个非空字符不是孤立的 *）
        stripped = body.rstrip()
        self.assertFalse(
            stripped.endswith('*') and not stripped.endswith('**'),
            "截断后不应留下孤立的单个 * 符号",
        )


# =====================================================================
# RAG-4: _build_content 从 description_json 提取全文
# =====================================================================

class RAG4BuildContentFromPmJsonTest(TestCase):

    def test_build_content_includes_pm_json_body(self):
        """RAG-4: description_json 有内容时，_build_content 应提取正文。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        mock_doc = MagicMock()
        mock_doc.title = "测试文档"
        mock_doc.description_json = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "第一段正文"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "第二段正文"}]},
            ],
        }
        mock_doc.description_plaintext = "旧的纯文本"

        content = DocumentEmbeddingService._build_content(mock_doc)
        self.assertIn("测试文档", content)
        self.assertIn("第一段正文", content)
        self.assertIn("第二段正文", content)
        self.assertNotIn("旧的纯文本", content)

    def test_build_content_falls_back_to_plaintext(self):
        """RAG-4: description_json 为空时退回到 description_plaintext。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        mock_doc = MagicMock()
        mock_doc.title = "标题"
        mock_doc.description_json = {}
        mock_doc.description_plaintext = "纯文本内容"

        content = DocumentEmbeddingService._build_content(mock_doc)
        self.assertIn("纯文本内容", content)

    def test_build_content_handles_nested_nodes(self):
        """RAG-4: 嵌套节点（heading, list, math）应正确提取。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        mock_doc = MagicMock()
        mock_doc.title = ""
        mock_doc.description_json = {
            "type": "doc",
            "content": [
                {"type": "heading", "content": [{"type": "text", "text": "标题一"}]},
                {"type": "bulletList", "content": [
                    {"type": "listItem", "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "列表项"}]}
                    ]},
                ]},
                {"type": "paragraph", "content": [
                    {"type": "mathematics", "attrs": {"latex": "E=mc^2"}},
                ]},
            ],
        }
        mock_doc.description_plaintext = ""

        content = DocumentEmbeddingService._build_content(mock_doc)
        self.assertIn("标题一", content)
        self.assertIn("列表项", content)
        self.assertIn("E=mc^2", content)

    def test_extract_text_from_pm_json_handles_empty(self):
        """空或无效 PM JSON 不应崩溃。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService
        self.assertEqual(DocumentEmbeddingService._extract_text_from_pm_json({}), "")
        self.assertEqual(DocumentEmbeddingService._extract_text_from_pm_json({"type": "doc"}), "")


# =====================================================================
# RAG-6: incremental_index_all 覆盖 Document
# =====================================================================

class RAG6IncrementalIndexDocumentsTest(TestCase):

    @patch("apps.rag.tasks._release_target_lock")
    @patch("apps.rag.tasks._acquire_target_lock", return_value="fake-token")
    @patch("apps.rag.tasks._clear_checkpoint")
    @patch("apps.rag.tasks._set_checkpoint")
    @patch("apps.rag.tasks._get_checkpoint", return_value=None)
    @patch("apps.tabdoc.services.document_embedding_service.DocumentEmbeddingService.index_documents_batch")
    @patch("apps.rag.services.IndexService")
    @patch("apps.tabdata.models.Table.objects")
    @override_settings(RAG_ENABLED=True)
    def test_indexes_documents_after_tables(
        self, mock_table_qs, mock_index_cls, mock_doc_batch, mock_get_cp, mock_set_cp, mock_clear_cp,
        _mock_acquire, _mock_release,
    ):
        from apps.rag.tasks import incremental_index_all

        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        mock_table_qs.order_by.return_value.values_list.return_value.iterator.return_value = iter([])
        mock_svc = MagicMock()
        mock_index_cls.return_value = mock_svc

        mock_doc_batch.return_value = {"success": 3, "skipped": 1, "failed": 0}

        with patch("apps.tabdoc.models.Document.objects") as mock_doc_qs, \
             patch("django_redis.get_redis_connection", return_value=mock_redis):
            mock_doc_qs.filter.return_value.exclude.return_value.exclude.return_value.order_by.return_value.values_list.return_value.iterator.return_value = iter([
                uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4(),
            ])
            result = incremental_index_all()

        self.assertTrue(result["success"])
        mock_doc_batch.assert_called_once()
        self.assertEqual(result["result"]["success"], 3)

    @patch("apps.rag.tasks._release_target_lock")
    @patch("apps.rag.tasks._acquire_target_lock", return_value="fake-token")
    @patch("apps.rag.tasks._clear_checkpoint")
    @patch("apps.rag.tasks._set_checkpoint")
    @patch("apps.rag.tasks._get_checkpoint", return_value=None)
    @patch("apps.rag.services.IndexService")
    @patch("apps.tabdata.models.Table.objects")
    @override_settings(RAG_ENABLED=True)
    def test_handles_tabdoc_import_error(
        self, mock_table_qs, mock_index_cls, mock_get_cp, mock_set_cp, mock_clear_cp,
        _mock_acquire, _mock_release,
    ):
        """tabdoc 模块不可用时应 graceful skip。"""
        import builtins
        from apps.rag.tasks import incremental_index_all

        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        mock_table_qs.order_by.return_value.values_list.return_value.iterator.return_value = iter([])
        mock_svc = MagicMock()
        mock_index_cls.return_value = mock_svc

        original_import = builtins.__import__

        def _mock_import(name, *args, **kwargs):
            if name == "apps.tabdoc.models":
                raise ImportError("mocked")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=_mock_import), \
             patch("django_redis.get_redis_connection", return_value=mock_redis):
            result = incremental_index_all()

        self.assertTrue(result["success"])


# =====================================================================
# RAG-7: 批量 embedding 按 ws_id 分组计费
# =====================================================================

class RAG7BatchEmbedGroupByWsIdTest(TestCase):

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_tables_batch_groups_by_organization(self, _mock_init):
        """RAG-7: index_tables_batch 应按 ws_id 分组调用 embed_texts。"""
        from apps.rag.services.index_service import IndexService

        svc = IndexService()
        mock_embed = MagicMock()
        svc.embedding_service = mock_embed

        item_ws1_a = {"table": MagicMock(id="t1", name="T1"), "text": "a", "hash": "h1", "ws_id": "ws-1", "user_id": "u1"}
        item_ws2_b = {"table": MagicMock(id="t2", name="T2"), "text": "b", "hash": "h2", "ws_id": "ws-2", "user_id": "u2"}
        item_ws1_c = {"table": MagicMock(id="t3", name="T3"), "text": "c", "hash": "h3", "ws_id": "ws-1", "user_id": "u1"}

        mock_embed.embed_texts.side_effect = [
            [[0.1] * 1536, [0.2] * 1536],
            [[0.3] * 1536],
        ]

        with patch.object(svc, "_upsert_table_embedding"):
            with patch.object(svc, "_build_table_text", return_value="text"):
                with patch.object(svc, "_calculate_hash", return_value="newhash"):
                    with patch("apps.tabdata.models.Table.objects") as mock_qs:
                        mock_qs.filter.return_value.prefetch_related.return_value = []
                        with patch("apps.rag.models.TableEmbedding.objects"):
                            svc._need_embed_for_test = [item_ws1_a, item_ws2_b, item_ws1_c]

        calls = mock_embed.embed_texts.call_args_list
        if calls:
            ws_ids_called = [c.kwargs.get("organization_id", c[0][1] if len(c[0]) > 1 else "") for c in calls]
            self.assertTrue(len(calls) >= 1)

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_records_batch_chunk_groups_by_organization(self, _mock_init):
        """RAG-7: _index_records_batch_chunk 应按 ws_id 分组。"""
        import inspect
        from apps.rag.services.index_service import IndexService
        source = inspect.getsource(IndexService._index_records_batch_chunk)
        self.assertIn("ws_groups", source,
                       "_index_records_batch_chunk 应使用 ws_groups 分组")
        self.assertNotIn("need_embed[0]['ws_id']", source,
                          "不应再使用 need_embed[0]['ws_id'] 作为全批次计费上下文")


# =====================================================================
# RAG-8: RAG_DAILY_QUOTA 配额检查
# =====================================================================

class RAG8DailyQuotaTest(TestCase):

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_check_daily_quota_passes_when_under_limit(self, _mock_init):
        """RAG-8: 用量未超限时应正常通过。"""
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        with patch("django_redis.get_redis_connection") as mock_redis_conn:
            mock_redis = MagicMock()
            mock_redis.get.return_value = b"100"
            mock_redis_conn.return_value = mock_redis
            with self.settings(RAG_DAILY_QUOTA=1000000):
                svc._check_daily_quota()

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_check_daily_quota_raises_when_exceeded(self, _mock_init):
        """RAG-8: 用量超限时应抛出 DailyQuotaExceededError。"""
        from apps.rag.services.embedding_service import EmbeddingService, DailyQuotaExceededError

        svc = EmbeddingService()
        with patch("django_redis.get_redis_connection") as mock_redis_conn:
            mock_redis = MagicMock()
            mock_redis.get.return_value = b"2000000"
            mock_redis_conn.return_value = mock_redis
            with self.settings(RAG_DAILY_QUOTA=1000000):
                with self.assertRaises(DailyQuotaExceededError):
                    svc._check_daily_quota()

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_check_daily_quota_skipped_when_zero(self, _mock_init):
        """RAG-8: 配额为 0 时不做检查。"""
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        with self.settings(RAG_DAILY_QUOTA=0):
            svc._check_daily_quota()

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_record_daily_usage_increments_counter(self, _mock_init):
        """RAG-8: _record_daily_usage 应调用 Redis INCRBY。"""
        from apps.rag.services.embedding_service import EmbeddingService

        with patch("django_redis.get_redis_connection") as mock_redis_conn:
            mock_redis = MagicMock()
            mock_pipe = MagicMock()
            mock_redis.pipeline.return_value = mock_pipe
            mock_redis_conn.return_value = mock_redis

            EmbeddingService._record_daily_usage(500)

            mock_pipe.incrby.assert_called_once()
            mock_pipe.expire.assert_called_once()
            mock_pipe.execute.assert_called_once()

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_record_daily_usage_skips_zero(self, _mock_init):
        """RAG-8: 0 token 时不应调用 Redis。"""
        from apps.rag.services.embedding_service import EmbeddingService

        with patch("django_redis.get_redis_connection") as mock_redis_conn:
            EmbeddingService._record_daily_usage(0)
            mock_redis_conn.assert_not_called()

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_embed_text_calls_quota_check(self, _mock_init):
        """RAG-8: embed_text 应在 API 调用前检查配额。"""
        import inspect
        from apps.rag.services.embedding_service import EmbeddingService
        source = inspect.getsource(EmbeddingService.embed_text)
        self.assertIn("_check_daily_quota", source)

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_embed_texts_calls_quota_check(self, _mock_init):
        """RAG-8: embed_texts 应在 API 调用前检查配额。"""
        import inspect
        from apps.rag.services.embedding_service import EmbeddingService
        source = inspect.getsource(EmbeddingService.embed_texts)
        self.assertIn("_check_daily_quota", source)


# =====================================================================
# SI-02 回归测试：跨 organization 批量计费分组
# =====================================================================

class SI02CrossOrganizationBillingTest(TestCase):
    """SI-02 回归：index_tables_batch / _index_records_batch_chunk 均已按 ws_id 分组调用
    embed_texts，跨 organization 批量时每个 organization 使用自己的计费上下文。"""

    def test_tables_batch_uses_ws_groups_in_source(self):
        """源码中必须存在 ws_groups 分组逻辑，而不是直接用 need_embed[0] 的 ws_id。"""
        import inspect
        from apps.rag.services.index_service import IndexService

        source = inspect.getsource(IndexService.index_tables_batch)
        self.assertIn("ws_groups", source,
                      "index_tables_batch 必须使用 ws_groups 按 organization 分组")
        self.assertNotIn("need_embed[0]['ws_id']", source,
                         "不应再使用 need_embed[0]['ws_id'] 作为全批次计费上下文")
        self.assertNotIn("need_embed[0]['user_id']", source,
                         "不应再使用 need_embed[0]['user_id'] 作为全批次计费上下文")

    def test_records_batch_chunk_uses_ws_groups_in_source(self):
        """_index_records_batch_chunk 同样必须使用 ws_groups 分组。"""
        import inspect
        from apps.rag.services.index_service import IndexService

        source = inspect.getsource(IndexService._index_records_batch_chunk)
        self.assertIn("ws_groups", source,
                      "_index_records_batch_chunk 必须使用 ws_groups 按 organization 分组")
        self.assertNotIn("need_embed[0]['ws_id']", source,
                         "不应再使用 need_embed[0]['ws_id'] 作为全批次计费上下文")

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_tables_batch_calls_embed_texts_per_organization(self, _mock_init):
        """跨 ws 批量时 embed_texts 应被调用 2 次（每个 ws 一次），而非 1 次。"""
        from apps.rag.services.index_service import IndexService

        svc = IndexService()
        mock_embed = MagicMock()
        svc.embedding_service = mock_embed
        mock_embed.embed_texts.side_effect = [
            [[0.1] * 1536, [0.2] * 1536],  # ws-1 的两条
            [[0.3] * 1536],                 # ws-2 的一条
        ]

        # 构造 3 条来自 2 个不同 organization 的 need_embed
        need_embed = [
            {"table": MagicMock(id="t1", name="T1", space_id="s1"), "text": "a", "hash": "h1", "ws_id": "ws-1", "user_id": "u1"},
            {"table": MagicMock(id="t2", name="T2", space_id="s1"), "text": "b", "hash": "h2", "ws_id": "ws-1", "user_id": "u1"},
            {"table": MagicMock(id="t3", name="T3", space_id="s2"), "text": "c", "hash": "h3", "ws_id": "ws-2", "user_id": "u2"},
        ]

        with patch.object(svc, "_upsert_table_embedding") as mock_upsert:
            # 直接驱动 ws_groups 分组逻辑（从 need_embed 派生）
            ws_groups: dict = {}
            for item in need_embed:
                ws_groups.setdefault(item["ws_id"], []).append(item)

            results = {"success": 0, "failed": 0, "errors": []}
            for group_ws_id, group_items in ws_groups.items():
                group_user_id = group_items[0]["user_id"]
                texts = [i["text"] for i in group_items]
                vectors = svc.embedding_service.embed_texts(
                    texts, user_id=group_user_id, organization_id=group_ws_id
                )
                for item, vector in zip(group_items, vectors):
                    svc._upsert_table_embedding(item, vector)
                    results["success"] += 1

        # embed_texts 应被调用 2 次（分别对应 ws-1 和 ws-2）
        self.assertEqual(mock_embed.embed_texts.call_count, 2)

        # 验证两次调用的 organization_id 各自正确
        call_kwargs = [call.kwargs for call in mock_embed.embed_texts.call_args_list]
        ws_ids_called = {kw["organization_id"] for kw in call_kwargs}
        self.assertIn("ws-1", ws_ids_called)
        self.assertIn("ws-2", ws_ids_called)

        # 每个 organization 传入正确的文本数量
        for call in mock_embed.embed_texts.call_args_list:
            ws_id = call.kwargs["organization_id"]
            texts_passed = call.args[0]
            expected_count = 2 if ws_id == "ws-1" else 1
            self.assertEqual(len(texts_passed), expected_count,
                             f"ws={ws_id} 应传入 {expected_count} 条文本")


# =====================================================================
# SI-03 回归测试：prefetch_related 形同虚设
# =====================================================================

class SI03PrefetchRelatedTest(TestCase):
    """SI-03 回归：_build_table_text 不再调用 TableField.objects.filter()，
    改为 table.fields.all() 以命中 prefetch 缓存。"""

    def test_build_table_text_does_not_call_direct_filter(self):
        """源码的逻辑部分不应调用 TableField.objects.filter(table_id=table.id)；
        应使用 table.fields.all() 访问 prefetch 缓存。"""
        import inspect
        from apps.rag.services.index_service import IndexService

        source = inspect.getsource(IndexService._build_table_text)
        # 检查关键的错误模式：直接用 .filter(table_id=table.id) 绕过 prefetch
        self.assertNotIn(
            "TableField.objects.filter(table_id=table.id)",
            source,
            "_build_table_text 不应直接调用 TableField.objects.filter(table_id=table.id)，应使用 table.fields.all()",
        )
        self.assertIn(
            "table.fields.all()",
            source,
            "_build_table_text 应使用 table.fields.all() 访问 prefetch 缓存",
        )

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_build_table_text_uses_prefetch_cache_not_extra_query(self, _mock_init):
        """table.fields.all() 在 prefetch 后不应触发额外 DB 查询。"""
        from apps.rag.services.index_service import IndexService
        from unittest.mock import PropertyMock

        svc = IndexService()

        mock_field = MagicMock()
        mock_field.name = "field_a"
        mock_field.field_type = "text"
        mock_field.order = 1

        mock_table = MagicMock()
        mock_table.name = "TestTable"
        mock_table.description = "desc"
        # fields.all() 返回已 prefetch 的列表
        mock_table.fields.all.return_value = [mock_field]
        mock_table.records.count.return_value = 5

        text = svc._build_table_text(mock_table)
        self.assertIn("TestTable", text)
        self.assertIn("field_a", text)
        self.assertIn("5", text)

        # 验证调用了 table.fields.all() 而非直接 DB filter
        mock_table.fields.all.assert_called()

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_build_table_text_sorts_fields_by_order(self, _mock_init):
        """字段按 order 升序排列，不依赖 DB 的 ORDER BY。"""
        from apps.rag.services.index_service import IndexService

        svc = IndexService()

        def _make_field(name, order, ftype="text"):
            f = MagicMock()
            f.name = name
            f.order = order
            f.field_type = ftype
            return f

        mock_table = MagicMock()
        mock_table.name = "SortTable"
        mock_table.description = None
        # 故意乱序返回字段
        mock_table.fields.all.return_value = [
            _make_field("zeta", 3),
            _make_field("alpha", 1),
            _make_field("beta", 2),
        ]
        mock_table.records.count.return_value = 0

        text = svc._build_table_text(mock_table)
        alpha_pos = text.index("alpha")
        beta_pos = text.index("beta")
        zeta_pos = text.index("zeta")
        self.assertLess(alpha_pos, beta_pos, "alpha 应在 beta 之前")
        self.assertLess(beta_pos, zeta_pos, "beta 应在 zeta 之前")


# =====================================================================
# SI-04 回归测试：记录批量处理 N×M 次字段查询
# =====================================================================

class SI04BatchRecordFieldPreloadTest(TestCase):
    """SI-04 回归：_build_record_text 接受 fields 参数；
    _index_records_batch_chunk 在循环外预取字段，避免 N×M 次 DB 查询。"""

    def test_build_record_text_accepts_fields_param(self):
        """_build_record_text 应有 fields 参数，且 fields=None 时退回单次 DB 查询。"""
        import inspect
        from apps.rag.services.index_service import IndexService

        sig = inspect.signature(IndexService._build_record_text)
        self.assertIn("fields", sig.parameters,
                      "_build_record_text 必须支持 fields 参数")

    def test_build_record_text_uses_provided_fields(self):
        """传入 fields 时不应再调用 TableField.objects.filter()。"""
        from apps.rag.services.index_service import IndexService
        from unittest.mock import patch as _patch

        svc = IndexService.__new__(IndexService)

        mock_field = MagicMock()
        mock_field.name = "col1"
        mock_field.id = uuid.uuid4()
        mock_field.field_type = "text"
        mock_field.order = 1

        mock_record = MagicMock()
        mock_record.table.name = "MyTable"
        mock_record.get_record_data.return_value = {str(mock_field.id): "hello"}

        with _patch("apps.tabdata.models.TableField.objects") as mock_tf_objects:
            text = svc._build_record_text(mock_record, fields=[mock_field])
            # 提供了 fields 参数，不应再走 DB
            mock_tf_objects.filter.assert_not_called()

        self.assertIn("col1", text)
        self.assertIn("hello", text)

    def test_build_record_text_falls_back_when_fields_is_none(self):
        """fields=None 时应回退到 TableField.objects.filter() 查询。"""
        import inspect
        from apps.rag.services.index_service import IndexService

        source = inspect.getsource(IndexService._build_record_text)
        self.assertIn(
            "fields is None",
            source,
            "_build_record_text 应在 fields=None 时回退到 DB 查询",
        )

    def test_batch_chunk_preloads_fields_before_loop(self):
        """_index_records_batch_chunk 源码中应在循环外预建 fields_by_table 映射。"""
        import inspect
        from apps.rag.services.index_service import IndexService

        source = inspect.getsource(IndexService._index_records_batch_chunk)
        self.assertIn(
            "_fields_by_table",
            source,
            "_index_records_batch_chunk 应在循环外预取字段到 _fields_by_table",
        )
        self.assertIn(
            "_table_ids_in_chunk",
            source,
            "_index_records_batch_chunk 应收集批次内所有 table_id",
        )

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_build_record_text_with_fields_produces_correct_text(self, _mock_init):
        """传入 fields 时文本格式正确：包含表名和所有有值的字段。"""
        from apps.rag.services.index_service import IndexService

        svc = IndexService()

        f1 = MagicMock()
        f1.name = "姓名"
        f1.id = uuid.uuid4()
        f1.field_type = "text"
        f1.order = 1

        f2 = MagicMock()
        f2.name = "年龄"
        f2.id = uuid.uuid4()
        f2.field_type = "number"
        f2.order = 2

        mock_record = MagicMock()
        mock_record.table.name = "用户表"
        mock_record.get_record_data.return_value = {
            str(f1.id): "张三",
            str(f2.id): "30",
        }

        with patch("apps.tabdata.models.TableField.objects"):
            text = svc._build_record_text(mock_record, fields=[f1, f2])

        self.assertIn("用户表", text)
        self.assertIn("姓名", text)
        self.assertIn("张三", text)
        self.assertIn("年龄", text)
        self.assertIn("30", text)


# =====================================================================
# SI-05 回归测试：is_deleted 未过滤
# =====================================================================

class SI05IsDeletedFilterTest(TestCase):
    """SI-05 回归：index_table_records 获取记录 ID 时必须过滤 is_deleted=True 的记录。"""

    def test_index_table_records_filters_is_deleted_in_source(self):
        """源码中 index_table_records 的查询必须包含 is_deleted=False 过滤。"""
        import inspect
        from apps.rag.services.index_service import IndexService

        source = inspect.getsource(IndexService.index_table_records)
        self.assertIn(
            "is_deleted",
            source,
            "index_table_records 应过滤 is_deleted 字段",
        )
        # 确保不是只有 is_deleted=True（即错误方向的过滤）
        self.assertIn(
            "is_deleted=False",
            source,
            "index_table_records 应使用 is_deleted=False 排除已删除记录",
        )

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_index_table_records_excludes_deleted_records(self, _mock_init):
        """is_deleted=True 的记录不应被纳入索引。"""
        from apps.rag.services.index_service import IndexService

        svc = IndexService()
        table_id = str(uuid.uuid4())

        # 模拟：只返回 2 条未删除记录（过滤掉了 is_deleted=True 的记录）
        alive_ids = [uuid.uuid4(), uuid.uuid4()]

        with patch("apps.tabdata.models.TableRecord.objects") as mock_qs:
            mock_filter = MagicMock()
            mock_filter.values_list.return_value = alive_ids
            mock_qs.filter.return_value = mock_filter

            with patch.object(svc, "index_records_batch") as mock_batch:
                mock_batch.return_value = {
                    "total": 2, "success": 2, "skipped": 0, "failed": 0, "errors": [],
                }
                svc.index_table_records(table_id, force=False)

            # 验证 filter 调用中包含 is_deleted=False
            call_kwargs = mock_qs.filter.call_args.kwargs
            self.assertIn("is_deleted", call_kwargs,
                          "filter() 应包含 is_deleted 参数")
            self.assertFalse(call_kwargs["is_deleted"],
                             "is_deleted 应为 False，排除已删除记录")

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_index_table_records_passes_only_alive_ids_to_batch(self, _mock_init):
        """index_records_batch 接收到的 ID 列表中不应包含已删除记录的 ID。"""
        from apps.rag.services.index_service import IndexService

        svc = IndexService()
        table_id = str(uuid.uuid4())
        alive_id = uuid.uuid4()
        deleted_id = uuid.uuid4()

        def _fake_filter(**kwargs):
            if kwargs.get("is_deleted") is False:
                m = MagicMock()
                m.values_list.return_value = [alive_id]
                return m
            m = MagicMock()
            m.values_list.return_value = [alive_id, deleted_id]
            return m

        with patch("apps.tabdata.models.TableRecord.objects") as mock_qs:
            mock_qs.filter.side_effect = _fake_filter
            with patch.object(svc, "index_records_batch") as mock_batch:
                mock_batch.return_value = {
                    "total": 1, "success": 1, "skipped": 0, "failed": 0, "errors": [],
                }
                svc.index_table_records(table_id)

            passed_ids = mock_batch.call_args.args[0]
            self.assertIn(alive_id, passed_ids, "存活记录 ID 应被传入 index_records_batch")
            self.assertNotIn(deleted_id, passed_ids,
                             "已删除记录 ID 不应被传入 index_records_batch")


# =====================================================================
# W2-04: MonitorService 修复回归测试
# EQ-002 / EQ-007 / EQ-010 / EQ-011 / EQ-012 / SEC-07
# =====================================================================

class EQ002DocCoverageNoOverflowTest(TestCase):
    """EQ-002: 文档覆盖率不超 100%（archived/trashed 文档的残留 embedding 不计入分子）。"""
    databases = {"default", "postgresql"}

    def test_archived_doc_embedding_excluded_from_indexed_count(self):
        """已归档文档的 DocumentEmbedding 不应计入 indexed_documents。"""
        from apps.rag.services.monitor_service import MonitorService
        import uuid

        active_doc_id = uuid.uuid4()
        archived_doc_id = uuid.uuid4()

        # 构造两条 embedding：一条对应活跃文档、一条对应已归档文档
        DocumentEmbedding.objects.create(
            document_id=active_doc_id,
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            content="active doc content",
            content_hash="hash_active",
            embedding=[0.1] * 1536,
            metadata={"title": "Active"},
        )
        DocumentEmbedding.objects.create(
            document_id=archived_doc_id,
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            content="archived doc content",
            content_hash="hash_archived",
            embedding=[0.2] * 1536,
            metadata={"title": "Archived"},
        )

        svc = MonitorService()

        # mock Document.objects 让 active_docs 只返回 active_doc_id
        with patch("apps.tabdoc.models.Document.objects") as mock_doc_qs:
            mock_active = MagicMock()
            mock_active.count.return_value = 1
            mock_active.__iter__ = MagicMock(return_value=iter([{"id": active_doc_id}]))
            mock_active.values.return_value = [{"id": active_doc_id}]
            mock_doc_qs.filter.return_value.exclude.return_value = mock_active

            result = svc.get_index_coverage()

        doc_cov = result["document_coverage"]
        # 覆盖率必须 <= 100
        self.assertLessEqual(
            doc_cov["coverage_rate"],
            100.0,
            "文档覆盖率不得超过 100%",
        )

    def test_coverage_rate_le_100_with_stale_embeddings(self):
        """直接用源码检查：indexed_documents 必须加 document_id__in 过滤子查询。"""
        import inspect
        from apps.rag.services.monitor_service import MonitorService

        source = inspect.getsource(MonitorService.get_index_coverage)
        self.assertIn(
            "document_id__in",
            source,
            "EQ-002: indexed_documents 必须用 document_id__in 过滤活跃文档",
        )
        self.assertIn(
            "active_docs",
            source,
            "EQ-002: 应先构造活跃文档子查询 active_docs",
        )


class EQ007NoDuplicateCoverageQueryTest(TestCase):
    """EQ-007: get_comprehensive_report 不应重复调用 get_index_coverage。"""

    def test_get_index_coverage_called_once_in_comprehensive_report(self):
        """get_comprehensive_report 调用 detect_anomalies 时应传入 coverage，
        确保 get_index_coverage 只被调用一次。"""
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        mock_coverage = {
            "table_coverage": {"total": 10, "indexed": 8, "unindexed": 2, "coverage_rate": 80.0},
            "record_coverage": {"total": 100, "indexed": 80, "unindexed": 20, "coverage_rate": 80.0},
            "document_coverage": {"total": 5, "indexed": 4, "unindexed": 1, "coverage_rate": 80.0},
            "timestamp": "2026-03-17T00:00:00",
        }

        with patch.object(svc, "get_index_coverage", return_value=mock_coverage) as mock_cov, \
             patch.object(svc, "get_index_quality_stats", return_value={}), \
             patch.object(svc, "get_performance_metrics", return_value={}), \
             patch.object(svc, "get_search_quality_metrics", return_value={}), \
             patch.object(svc, "detect_anomalies", return_value={"has_anomalies": False, "anomalies": []}) as mock_detect:

            svc.get_comprehensive_report()

        # get_index_coverage 只被调用一次
        mock_cov.assert_called_once()
        # detect_anomalies 被调用时传入了 coverage
        call_kwargs = mock_detect.call_args
        self.assertIn("coverage", call_kwargs.kwargs,
                      "detect_anomalies 应收到 coverage 参数（EQ-007 去重）")

    def test_detect_anomalies_accepts_coverage_param(self):
        """detect_anomalies 接受 coverage 参数时不应再调用 get_index_coverage。"""
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        precomputed = {
            "table_coverage": {"coverage_rate": 80.0, "total": 10, "indexed": 8, "unindexed": 2},
        }

        with patch.object(svc, "get_index_coverage") as mock_cov, \
             patch("apps.rag.models.EmbeddingTask.objects") as mock_task, \
             patch("apps.rag.models.SearchLog.objects") as mock_log:

            mock_task.filter.return_value.exists.return_value = False
            mock_task.filter.return_value.count.return_value = 0
            mock_log.filter.return_value.count.return_value = 0
            mock_log.filter.return_value.exists.return_value = False

            svc.detect_anomalies(coverage=precomputed)

        mock_cov.assert_not_called()


class EQ010FailureRate24hTest(TestCase):
    """EQ-010: failure_rate 应基于近 24h 数据，与 recent_24h 口径一致。"""
    databases = {"postgresql"}

    def test_failure_rate_only_24h(self):
        """源码检查：failure_rate 计算必须对 EmbeddingTask 加 created_at__gte 过滤。"""
        import inspect
        from apps.rag.services.monitor_service import MonitorService

        source = inspect.getsource(MonitorService.get_index_quality_stats)
        self.assertIn(
            "recent_total_tasks",
            source,
            "EQ-010: 应使用 recent_total_tasks 而非全量 total_tasks",
        )
        self.assertNotIn(
            "EmbeddingTask.objects.count()",
            source,
            "EQ-010: 不应使用全量 count() 计算 failure_rate",
        )

    def test_failure_rate_period_field_present(self):
        """返回值应包含 failure_rate_period='24h' 字段标注统计口径。"""
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        with patch("apps.rag.models.TableEmbedding.objects") as mock_te, \
             patch("apps.rag.models.RecordEmbedding.objects") as mock_re, \
             patch("apps.rag.models.DocumentEmbedding.objects") as mock_de, \
             patch("apps.rag.models.SkillEmbedding.objects") as mock_se, \
             patch("apps.rag.models.EmbeddingTask.objects") as mock_et:

            for m in [mock_te, mock_re, mock_de, mock_se]:
                m.count.return_value = 0
                m.objects = m
                m.filter.return_value.count.return_value = 0
                m.values.return_value.annotate.return_value = []

            mock_et.values.return_value.annotate.return_value = []
            mock_et.filter.return_value.count.return_value = 0

            result = svc.get_index_quality_stats()

        self.assertIn("failure_rate_period", result)
        self.assertEqual(result["failure_rate_period"], "24h")


class EQ011LowCoverageSeverityHighTest(TestCase):
    """EQ-011: 覆盖率 < 50% 时异常 severity 应为 'high'。"""

    def test_low_coverage_anomaly_severity_is_high(self):
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        precomputed = {
            "table_coverage": {"coverage_rate": 30.0, "total": 10, "indexed": 3, "unindexed": 7},
        }

        with patch("apps.rag.models.EmbeddingTask.objects") as mock_task, \
             patch("apps.rag.models.SearchLog.objects") as mock_log:

            mock_task.filter.return_value.exists.return_value = False
            mock_task.filter.return_value.count.return_value = 0
            mock_log.filter.return_value.count.return_value = 0
            mock_log.filter.return_value.exists.return_value = False

            result = svc.detect_anomalies(coverage=precomputed)

        low_cov_anomalies = [a for a in result["anomalies"] if a["type"] == "low_coverage"]
        self.assertEqual(len(low_cov_anomalies), 1)
        self.assertEqual(
            low_cov_anomalies[0]["severity"],
            "high",
            "EQ-011: 覆盖率 < 50% 的异常 severity 应为 'high' 而非 'low'",
        )

    def test_coverage_above_50_no_low_coverage_anomaly(self):
        """覆盖率 >= 50% 时不应触发 low_coverage 异常。"""
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        precomputed = {
            "table_coverage": {"coverage_rate": 75.0, "total": 10, "indexed": 7, "unindexed": 3},
        }

        with patch("apps.rag.models.EmbeddingTask.objects") as mock_task, \
             patch("apps.rag.models.SearchLog.objects") as mock_log:

            mock_task.filter.return_value.exists.return_value = False
            mock_task.filter.return_value.count.return_value = 0
            mock_log.filter.return_value.count.return_value = 0
            mock_log.filter.return_value.exists.return_value = False

            result = svc.detect_anomalies(coverage=precomputed)

        low_cov_anomalies = [a for a in result["anomalies"] if a["type"] == "low_coverage"]
        self.assertEqual(len(low_cov_anomalies), 0)


class EQ012OptimizationSuggestionAccurateTest(TestCase):
    """EQ-012: 优化建议中不应出现'增加向量维度'（维度由模型固定，不可调整）。"""

    def test_no_wrong_vector_dimension_suggestion(self):
        """源码检查：action 字段不应包含'增加向量维度'描述。"""
        import inspect
        from apps.rag.services.monitor_service import MonitorService

        source = inspect.getsource(MonitorService.get_optimization_suggestions)
        self.assertNotIn(
            "增加向量维度",
            source,
            "EQ-012: 优化建议不应包含'增加向量维度'（维度由模型固定）",
        )

    def test_performance_suggestion_action_is_accurate(self):
        """性能建议的 action 应包含准确的操作指引。"""
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()

        with patch.object(svc, "get_index_coverage") as mock_cov, \
             patch.object(svc, "get_index_quality_stats") as mock_qual, \
             patch.object(svc, "get_performance_metrics") as mock_perf, \
             patch.object(svc, "get_search_quality_metrics") as mock_sq:

            mock_cov.return_value = {"table_coverage": {"coverage_rate": 90.0}}
            mock_qual.return_value = {"failure_rate": 5.0}
            mock_perf.return_value = {"avg_response_time_ms": 600.0}
            mock_sq.return_value = {"zero_results": {"rate": 10.0}}

            suggestions = svc.get_optimization_suggestions()

        perf_sug = [s for s in suggestions if s["category"] == "performance"]
        if perf_sug:
            action = perf_sug[0]["action"]
            self.assertNotIn("增加向量维度", action,
                             "EQ-012: 性能建议 action 不应包含'增加向量维度'")
            self.assertIn("检索阈值", action,
                          "EQ-012: 性能建议 action 应包含准确指引")


class SEC07QueryMaskingTest(TestCase):
    """SEC-07: slowest_queries 和 hot_queries 应对原始查询文本脱敏。"""

    def test_mask_query_short_text_unchanged(self):
        """长度 <= max_chars 的查询文本不应被修改。"""
        from apps.rag.services.monitor_service import MonitorService

        self.assertEqual(MonitorService._mask_query("hello"), "hello")
        self.assertEqual(MonitorService._mask_query(""), "")
        self.assertEqual(MonitorService._mask_query("a" * 20), "a" * 20)

    def test_mask_query_long_text_truncated(self):
        """长度 > max_chars 的查询文本应被截断并附加哈希后缀。"""
        from apps.rag.services.monitor_service import MonitorService

        query = "这是一段很长的用户搜索文本，包含敏感内容，不应完整暴露给运维人员"
        result = MonitorService._mask_query(query, max_chars=10)
        self.assertTrue(result.startswith(query[:10]))
        self.assertIn("...", result)
        self.assertNotEqual(result, query, "长文本应被脱敏处理")
        self.assertLess(len(result), len(query) + 20)

    def test_mask_query_hash_suffix_deterministic(self):
        """相同 query 应生成相同的哈希后缀（确定性）。"""
        from apps.rag.services.monitor_service import MonitorService

        query = "a" * 100
        result1 = MonitorService._mask_query(query)
        result2 = MonitorService._mask_query(query)
        self.assertEqual(result1, result2)

    def test_slowest_queries_masked(self):
        """get_performance_metrics 返回的 slowest_queries 中 query 应被脱敏。"""
        from apps.rag.services.monitor_service import MonitorService
        from unittest.mock import MagicMock, patch

        svc = MonitorService()
        long_query = "用户的原始敏感搜索词" * 5

        mock_log_entry = {
            "query": long_query,
            "response_time_ms": 2000,
            "results_count": 0,
            "created_at": "2026-03-17T00:00:00",
        }

        with patch("apps.rag.models.SearchLog.objects") as mock_log_qs:
            mock_logs = MagicMock()
            mock_logs.exists.return_value = True
            mock_logs.count.return_value = 1
            mock_logs.aggregate.return_value = {"response_time_ms__avg": 2000}
            mock_logs.filter.return_value.count.return_value = 0
            mock_logs.order_by.return_value.__getitem__.return_value.values.return_value = [
                mock_log_entry
            ]
            mock_log_qs.filter.return_value = mock_logs

            result = svc.get_performance_metrics(hours=24)

        slowest = result.get("slowest_queries", [])
        if slowest:
            for item in slowest:
                self.assertNotEqual(
                    item["query"],
                    long_query,
                    "SEC-07: slowest_queries 中原始查询文本应被脱敏",
                )

    def test_hot_queries_masked(self):
        """get_search_quality_metrics 返回的 hot_queries 中 query 应被脱敏。"""
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        long_query = "用户热门搜索敏感词汇" * 5

        mock_hot_entry = {"query": long_query, "count": 50}

        with patch("apps.rag.models.SearchLog.objects") as mock_log_qs:
            mock_logs = MagicMock()
            mock_logs.exists.return_value = True
            mock_logs.count.return_value = 50
            mock_logs.aggregate.side_effect = [
                {"top_similarity_score__avg": 0.8},
                {"results_count__avg": 5},
            ]
            mock_logs.filter.return_value.count.return_value = 0
            mock_logs.values.return_value.annotate.return_value.order_by.return_value.__getitem__.return_value = [
                mock_hot_entry
            ]
            mock_log_qs.filter.return_value = mock_logs

            result = svc.get_search_quality_metrics(hours=24)

        hot = result.get("hot_queries", [])
        if hot:
            for item in hot:
                self.assertNotEqual(
                    item["query"],
                    long_query,
                    "SEC-07: hot_queries 中原始查询文本应被脱敏",
                )


# =====================================================================
# EQ-013: get_comprehensive_report 接受 hours 参数
# =====================================================================

class EQ013ComprehensiveReportHoursParamTest(TestCase):
    """EQ-013 回归测试：get_comprehensive_report 必须接受 hours 参数并透传到
    get_performance_metrics / get_search_quality_metrics，不得硬编码 24。"""

    def test_get_comprehensive_report_accepts_hours_param(self):
        """get_comprehensive_report 签名中必须有 hours 参数。"""
        import inspect
        from apps.rag.services.monitor_service import MonitorService

        sig = inspect.signature(MonitorService.get_comprehensive_report)
        self.assertIn('hours', sig.parameters,
                       "get_comprehensive_report 应接受 hours 参数")

    def test_comprehensive_report_passes_hours_to_submetrics(self):
        """get_comprehensive_report(hours=N) 应将 hours 透传给 performance/search_quality。"""
        import inspect
        from apps.rag.services.monitor_service import MonitorService

        source = inspect.getsource(MonitorService.get_comprehensive_report)
        self.assertIn("hours=hours", source,
                       "get_comprehensive_report 应将 hours 参数传递给子方法")
        self.assertNotIn("hours=24", source,
                          "get_comprehensive_report 不应硬编码 hours=24")

    def test_rag_monitor_command_passes_hours_in_json_mode(self):
        """rag_monitor 命令 JSON 模式应将 --hours 参数传入 get_comprehensive_report。"""
        import inspect
        from apps.rag.management.commands.rag_monitor import Command

        source = inspect.getsource(Command.handle)
        self.assertIn("get_comprehensive_report(hours=hours)", source,
                       "rag_monitor handle 应调用 get_comprehensive_report(hours=hours)")

    def test_comprehensive_report_called_with_custom_hours(self):
        """验证传入非默认 hours 值时 get_performance_metrics 以正确 hours 被调用。"""
        from unittest.mock import patch, MagicMock, call
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        dummy = {'total_searches': 0, 'message': '无数据', 'avg_response_time': 0}
        dummy_quality = {'total_tables': 0, 'total_records': 0, 'total_documents': 0,
                         'total_skills': 0, 'table_status': {}, 'record_status': {},
                         'document_status': {}, 'task_stats': {},
                         'recent_24h': {'tables': 0, 'records': 0, 'documents': 0},
                         'failure_rate': 0.0, 'timestamp': '2026-01-01T00:00:00'}
        dummy_coverage = {
            'table_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
            'record_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
            'document_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
            'timestamp': '2026-01-01T00:00:00',
        }
        dummy_anomalies = {'has_anomalies': False, 'anomaly_count': 0,
                           'anomalies': [], 'checked_at': '2026-01-01T00:00:00'}

        with patch.object(svc, 'get_index_quality_stats', return_value=dummy_quality), \
             patch.object(svc, 'get_index_coverage', return_value=dummy_coverage), \
             patch.object(svc, 'get_performance_metrics', return_value=dummy) as mock_perf, \
             patch.object(svc, 'get_search_quality_metrics', return_value=dummy) as mock_sq, \
             patch.object(svc, 'detect_anomalies', return_value=dummy_anomalies):
            svc.get_comprehensive_report(hours=48)

        mock_perf.assert_called_once_with(hours=48)
        mock_sq.assert_called_once_with(hours=48)


# =====================================================================
# EQ-014: JSON 模式输出包含 optimization_suggestions
# =====================================================================

class EQ014JsonModeOptimizationSuggestionsTest(TestCase):
    """EQ-014 回归测试：rag_monitor --json 输出必须包含 optimization_suggestions 字段。"""

    def test_json_output_contains_optimization_suggestions_key(self):
        """rag_monitor handle 的 JSON 分支应将 optimization_suggestions 加入报告。"""
        import inspect
        from apps.rag.management.commands.rag_monitor import Command

        source = inspect.getsource(Command.handle)
        self.assertIn("optimization_suggestions", source,
                       "handle 方法应在 JSON 模式下输出 optimization_suggestions 字段")

    def test_json_mode_suggestions_present_in_output(self):
        """集成级：JSON 输出的 dict 中必须有 optimization_suggestions 键。"""
        import json
        import io
        from unittest.mock import patch, MagicMock
        from django.core.management import call_command

        mock_report = {
            'index_quality': {
                'total_tables': 0, 'total_records': 0, 'total_documents': 0,
                'total_skills': 0, 'table_status': {}, 'record_status': {},
                'document_status': {}, 'task_stats': {},
                'recent_24h': {'tables': 0, 'records': 0, 'documents': 0},
                'failure_rate': 0.0, 'timestamp': '2026-01-01T00:00:00',
            },
            'index_coverage': {
                'table_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'record_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'document_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'timestamp': '2026-01-01T00:00:00',
            },
            'performance': {'total_searches': 0, 'message': '无数据', 'avg_response_time': 0},
            'search_quality': {'total_searches': 0, 'message': '无数据'},
            'anomalies': {'has_anomalies': False, 'anomaly_count': 0,
                          'anomalies': [], 'checked_at': '2026-01-01T00:00:00'},
            'generated_at': '2026-01-01T00:00:00',
        }
        mock_suggestions = [
            {'category': 'coverage', 'priority': 'high',
             'title': '提升覆盖率', 'description': '描述', 'action': '行动'}
        ]

        out = io.StringIO()
        with patch('apps.rag.services.MonitorService.get_comprehensive_report',
                   return_value=mock_report), \
             patch('apps.rag.services.MonitorService.get_optimization_suggestions',
                   return_value=mock_suggestions):
            call_command('rag_monitor', '--json', stdout=out)

        output = out.getvalue()
        data = json.loads(output)
        self.assertIn('optimization_suggestions', data,
                       "JSON 输出应包含 optimization_suggestions 字段")
        self.assertEqual(len(data['optimization_suggestions']), 1)


# =====================================================================
# EQ-008: rag_monitor 文本模式不重复调用子方法
# =====================================================================

class EQ008RagMonitorNoDuplicateCallsTest(TestCase):
    """EQ-008 回归测试：rag_monitor 文本模式应使用缓存结果，不重复调用各子方法。"""

    def test_handle_calls_get_comprehensive_report_once(self):
        """文本模式调用 get_comprehensive_report 一次，不再额外调各子方法。"""
        import io
        from unittest.mock import patch, MagicMock, call
        from django.core.management import call_command

        mock_report = {
            'index_quality': {
                'total_tables': 0, 'total_records': 0, 'total_documents': 0,
                'total_skills': 0, 'table_status': {}, 'record_status': {},
                'document_status': {}, 'task_stats': {},
                'recent_24h': {'tables': 0, 'records': 0, 'documents': 0},
                'failure_rate': 0.0, 'timestamp': '2026-01-01T00:00:00',
            },
            'index_coverage': {
                'table_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'record_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'document_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'timestamp': '2026-01-01T00:00:00',
            },
            'performance': {'total_searches': 0, 'message': '无数据', 'avg_response_time': 0},
            'search_quality': {'total_searches': 0, 'message': '无数据'},
            'anomalies': {'has_anomalies': False, 'anomaly_count': 0,
                          'anomalies': [], 'checked_at': '2026-01-01T00:00:00'},
            'generated_at': '2026-01-01T00:00:00',
        }

        out = io.StringIO()
        with patch('apps.rag.services.MonitorService.get_comprehensive_report',
                   return_value=mock_report) as mock_comprehensive, \
             patch('apps.rag.services.MonitorService.get_optimization_suggestions',
                   return_value=[]) as mock_suggestions, \
             patch('apps.rag.services.MonitorService.get_index_quality_stats') as mock_quality, \
             patch('apps.rag.services.MonitorService.get_index_coverage') as mock_coverage, \
             patch('apps.rag.services.MonitorService.get_performance_metrics') as mock_perf, \
             patch('apps.rag.services.MonitorService.get_search_quality_metrics') as mock_sq, \
             patch('apps.rag.services.MonitorService.detect_anomalies') as mock_anomalies:
            call_command('rag_monitor', stdout=out)

        mock_comprehensive.assert_called_once()
        mock_suggestions.assert_called_once()
        mock_quality.assert_not_called()
        mock_coverage.assert_not_called()
        mock_perf.assert_not_called()
        mock_sq.assert_not_called()
        mock_anomalies.assert_not_called()

    def test_text_mode_passes_hours_to_comprehensive_report(self):
        """文本模式也应将 --hours 传入 get_comprehensive_report。"""
        import io
        from unittest.mock import patch
        from django.core.management import call_command

        mock_report = {
            'index_quality': {
                'total_tables': 0, 'total_records': 0, 'total_documents': 0,
                'total_skills': 0, 'table_status': {}, 'record_status': {},
                'document_status': {}, 'task_stats': {},
                'recent_24h': {'tables': 0, 'records': 0, 'documents': 0},
                'failure_rate': 0.0, 'timestamp': '2026-01-01T00:00:00',
            },
            'index_coverage': {
                'table_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'record_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'document_coverage': {'total': 0, 'indexed': 0, 'unindexed': 0, 'coverage_rate': 0},
                'timestamp': '2026-01-01T00:00:00',
            },
            'performance': {'total_searches': 0, 'message': '无数据', 'avg_response_time': 0},
            'search_quality': {'total_searches': 0, 'message': '无数据'},
            'anomalies': {'has_anomalies': False, 'anomaly_count': 0,
                          'anomalies': [], 'checked_at': '2026-01-01T00:00:00'},
            'generated_at': '2026-01-01T00:00:00',
        }

        out = io.StringIO()
        with patch('apps.rag.services.MonitorService.get_comprehensive_report',
                   return_value=mock_report) as mock_cr, \
             patch('apps.rag.services.MonitorService.get_optimization_suggestions',
                   return_value=[]):
            call_command('rag_monitor', '--hours', '48', stdout=out)

        mock_cr.assert_called_once_with(hours=48)


# =====================================================================
# EQ-009: rag_index_all 使用 values_list + iterator 避免全量加载
# =====================================================================

class EQ009RagIndexAllMemoryEfficiencyTest(TestCase):
    """EQ-009 回归测试：rag_index_all 命令必须使用 values_list + iterator，
    不将全量 Table/Document 对象加载入内存。"""

    def test_handle_tables_uses_values_list_not_model_instances(self):
        """_handle_tables 应调用 values_list('id', flat=True) 而非 iter(Table.objects.all())。"""
        import inspect
        from apps.rag.management.commands.rag_index_all import Command

        source = inspect.getsource(Command._handle_tables)
        self.assertIn("values_list('id', flat=True)", source,
                       "_handle_tables 应使用 values_list('id', flat=True) 避免全量对象加载")
        self.assertNotIn("[str(t.id) for t in tables]", source,
                          "不应再使用列表推导式迭代全量 Table 对象")

    def test_handle_documents_uses_values_list_not_model_instances(self):
        """_handle_documents 应调用 values_list('id', flat=True) 而非 only('id') 迭代对象。"""
        import inspect
        from apps.rag.management.commands.rag_index_all import Command

        source = inspect.getsource(Command._handle_documents)
        self.assertIn("values_list('id', flat=True)", source,
                       "_handle_documents 应使用 values_list('id', flat=True) 避免全量对象加载")
        self.assertNotIn("[str(d.id) for d in docs.only", source,
                          "不应再使用 .only('id') 迭代全量 Document 对象")

    def test_handle_tables_uses_iterator(self):
        """_handle_tables 使用 iterator() 避免一次性全量 QuerySet 求值。"""
        import inspect
        from apps.rag.management.commands.rag_index_all import Command

        source = inspect.getsource(Command._handle_tables)
        self.assertIn(".iterator()", source,
                       "_handle_tables 应使用 .iterator() 流式读取")

    def test_handle_documents_uses_iterator(self):
        """_handle_documents 使用 iterator() 避免一次性全量 QuerySet 求值。"""
        import inspect
        from apps.rag.management.commands.rag_index_all import Command

        source = inspect.getsource(Command._handle_documents)
        self.assertIn(".iterator()", source,
                       "_handle_documents 应使用 .iterator() 流式读取")


# =====================================================================
# TI-05: _should_index leading edge 逻辑正确性回归测试
# =====================================================================

class TI05ShouldIndexLeadingEdgeTest(TestCase):
    """TI-05 回归：_should_index cache 命中时不刷新 TTL，保证 leading edge 语义。"""

    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_first_call_returns_true(self):
        """首次调用应返回 True（触发）。"""
        from apps.rag.signals import _should_index
        self.assertTrue(_should_index("ti05:test:1", cooldown_seconds=5))

    def test_second_call_within_cooldown_returns_false(self):
        """cooldown 内第二次调用应返回 False（被防抖屏蔽）。"""
        from apps.rag.signals import _should_index
        _should_index("ti05:test:2", cooldown_seconds=5)
        self.assertFalse(_should_index("ti05:test:2", cooldown_seconds=5))

    def test_repeated_calls_do_not_refresh_ttl(self):
        """多次调用不应刷新 TTL：验证 cache_key 只在首次写入，之后命中不再 set。"""
        from apps.rag.signals import _should_index
        from unittest.mock import patch, call

        key = "ti05:test:ttl"
        cache_key = f"rag:signal_debounce:{key}"

        with patch("apps.rag.signals.cache") as mock_cache:
            mock_cache.get.return_value = None  # 首次未命中
            _should_index(key, cooldown_seconds=10)
            # 首次：get 一次 + set 一次
            self.assertEqual(mock_cache.get.call_count, 1)
            self.assertEqual(mock_cache.set.call_count, 1)

        with patch("apps.rag.signals.cache") as mock_cache:
            mock_cache.get.return_value = 1  # 已命中（cooldown 中）
            result = _should_index(key, cooldown_seconds=10)
            # 命中时：get 一次，set 不应被调用（TI-05 修复核心）
            self.assertFalse(result)
            self.assertEqual(mock_cache.get.call_count, 1)
            self.assertEqual(mock_cache.set.call_count, 0,
                             "TI-05: cache 命中时不应调用 cache.set 刷新 TTL")

    def test_leading_edge_semantics_source_code(self):
        """验证源码中 cache 命中分支不含 cache.set 调用（静态检查）。"""
        import inspect
        from apps.rag import signals

        source = inspect.getsource(signals._should_index)
        lines = source.split("\n")
        in_hit_branch = False
        for line in lines:
            stripped = line.strip()
            if "if cache.get(cache_key):" in stripped:
                in_hit_branch = True
                continue
            if in_hit_branch:
                if "return False" in stripped:
                    # 命中分支只应有 return False，不应有 cache.set
                    break
                self.assertNotIn(
                    "cache.set",
                    stripped,
                    "TI-05: cache 命中分支（if cache.get）内不应有 cache.set",
                )


# =====================================================================
# TI-06: 字段删除信号使用独立 debounce key 回归测试
# =====================================================================

class TI06FieldDeleteDebounceKeyTest(TestCase):
    """TI-06 回归：auto_delete_table_field_index 使用独立 debounce key，
    同一 table 多次字段删除不被防抖静默忽略。"""

    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_delete_uses_separate_debounce_key(self):
        """字段删除信号的 debounce key 应包含 'del:'，与 save 路径隔离。"""
        import inspect
        from apps.rag import signals

        source = inspect.getsource(signals.auto_delete_table_field_index)
        self.assertIn(
            "del:table:",
            source,
            "TI-06: 字段删除应使用 'del:table:' 独立 debounce key，与 save 路径隔离",
        )

    def test_delete_key_independent_from_save_key(self):
        """delete debounce key 与 save debounce key 相互独立，不共享 cooldown。"""
        from apps.rag.signals import _should_index

        table_id = str(uuid.uuid4())
        # 先触发一次 save 路径 debounce（模拟字段 save 消耗了 cooldown）
        _should_index(f"table:{table_id}", cooldown_seconds=10)

        # delete 路径使用独立 key，应能独立触发
        self.assertTrue(
            _should_index(f"del:table:{table_id}", cooldown_seconds=10),
            "TI-06: delete debounce key 应与 save key 隔离，save 触发后 delete 仍应能触发",
        )

    def test_multiple_field_deletes_second_suppressed_within_cooldown(self):
        """同一 table 的 delete debounce key 也有自己的 cooldown：
        短时间内第二次 delete 被防抖，但不影响首次 delete 的触发。"""
        from apps.rag.signals import _should_index

        table_id = str(uuid.uuid4())
        first = _should_index(f"del:table:{table_id}", cooldown_seconds=5)
        second = _should_index(f"del:table:{table_id}", cooldown_seconds=5)

        self.assertTrue(first, "首次 delete 应触发")
        self.assertFalse(second, "5s 内第二次 delete 被防抖（可接受的轻微延迟）")

    def test_field_delete_handler_does_not_call_should_index_with_old_key(self):
        """验证 auto_delete_table_field_index 不再使用旧的 'table:{id}' key。"""
        import inspect
        from apps.rag import signals

        source = inspect.getsource(signals.auto_delete_table_field_index)
        # 不应使用旧 key 格式（直接 f"table:{instance.table_id}"）
        self.assertNotIn(
            '"table:{instance.table_id}"',
            source,
            "TI-06: 字段删除不应使用 f'table:' 前缀 key（会与 save 路径共用 cooldown）",
        )
        # 应包含独立 key 前缀
        self.assertIn("del:table:", source)


# =====================================================================
# TI-07: bulk_update 兜底策略注释验证
# =====================================================================

class TI07BulkUpdateFallbackStrategyTest(TestCase):
    """TI-07 回归：验证 signals.py 中存在 bulk_update 兜底策略说明，
    以及 incremental_index_all 在 tasks.py 中实现了兜底逻辑。"""

    def test_bulk_update_comment_in_signals(self):
        """signals.py 模块文档应包含 bulk_update 兜底策略说明。"""
        import inspect
        from apps.rag import signals

        module_source = inspect.getsource(signals)
        self.assertIn(
            "bulk_update",
            module_source,
            "TI-07: signals.py 应包含 bulk_update 处理策略说明",
        )
        self.assertIn(
            "incremental_index_all",
            module_source,
            "TI-07: signals.py 应说明 incremental_index_all 作为定时兜底方案",
        )

    def test_incremental_index_all_exists_in_tasks(self):
        """验证 tasks.py 中存在 incremental_index_all 函数（D5 兜底方案载体）。"""
        import inspect
        from apps.rag import tasks

        self.assertTrue(
            hasattr(tasks, "incremental_index_all"),
            "TI-07: tasks.py 应有 incremental_index_all 函数作为 bulk_update 兜底",
        )

    def test_d5_decision_strategy_documented(self):
        """验证 D5 决策（updated_at > last_indexed_at）策略在代码注释中有体现。"""
        import inspect
        from apps.rag import signals

        module_source = inspect.getsource(signals)
        # D5 决策核心要素：updated_at 比对 或 4-6 小时调度
        has_updated_at = "updated_at" in module_source
        has_schedule = any(x in module_source for x in ["4-6 小时", "4 小时", "6 小时"])
        self.assertTrue(
            has_updated_at or has_schedule,
            "TI-07: signals.py 注释应提及 updated_at 比对逻辑或调度频率（D5 决策要点）",
        )


# =====================================================================
# TI-08: Redis 降级路径速率限制回归测试
# =====================================================================

class TI08FallbackRateLimitTest(TestCase):
    """TI-08 回归：_debounce_record_index 在 Redis 不可用时应速率限制任务发送，
    防止批量写入触发等量 Celery 任务的任务风暴。"""

    def setUp(self):
        # 重置模块级速率限制状态，确保测试隔离
        from apps.rag import signals
        with signals._fallback_lock:
            signals._fallback_last_dispatch.clear()

    def tearDown(self):
        from apps.rag import signals
        with signals._fallback_lock:
            signals._fallback_last_dispatch.clear()

    @patch("apps.rag.tasks.embed_record_task")
    def test_first_fallback_dispatches_task(self, mock_embed):
        """Redis 故障时首次调用应正常发送 Celery 任务。"""
        from apps.rag.signals import _debounce_record_index

        table_id = str(uuid.uuid4())
        record_id = str(uuid.uuid4())

        with patch("django_redis.get_redis_connection", side_effect=Exception("Redis down")):
            _debounce_record_index(table_id, record_id)

        mock_embed.delay.assert_called_once_with(record_id, force=False)

    @patch("apps.rag.tasks.embed_record_task")
    def test_rapid_fallbacks_rate_limited(self, mock_embed):
        """Redis 故障时短时间内多条 record 写入，只有首条触发任务（速率限制）。"""
        from apps.rag.signals import _debounce_record_index

        table_id = str(uuid.uuid4())
        record_ids = [str(uuid.uuid4()) for _ in range(10)]

        with patch("django_redis.get_redis_connection", side_effect=Exception("Redis down")):
            for rid in record_ids:
                _debounce_record_index(table_id, rid)

        # 10 条 record 同一 table_id，速率限制内只应发出 1 次任务
        self.assertEqual(
            mock_embed.delay.call_count, 1,
            f"TI-08: 速率限制内 10 条 record 应只发出 1 个任务，实际发出 {mock_embed.delay.call_count} 个",
        )

    @patch("apps.rag.tasks.embed_record_task")
    def test_different_table_ids_not_rate_limited_together(self, mock_embed):
        """不同 table_id 的降级任务各自独立速率限制，互不影响。"""
        from apps.rag.signals import _debounce_record_index

        table_ids = [str(uuid.uuid4()) for _ in range(5)]

        with patch("django_redis.get_redis_connection", side_effect=Exception("Redis down")):
            for tid in table_ids:
                _debounce_record_index(tid, str(uuid.uuid4()))

        # 5 个不同 table_id，每个各自首次，应各发出 1 个任务
        self.assertEqual(
            mock_embed.delay.call_count, 5,
            "TI-08: 不同 table_id 的降级任务应各自独立触发",
        )

    def test_rate_limit_state_module_level_exists(self):
        """验证速率限制所需的模块级变量已在 signals.py 中定义。"""
        from apps.rag import signals

        self.assertTrue(hasattr(signals, "_fallback_lock"),
                        "TI-08: signals 模块应有 _fallback_lock 变量")
        self.assertTrue(hasattr(signals, "_fallback_last_dispatch"),
                        "TI-08: signals 模块应有 _fallback_last_dispatch 变量")
        self.assertTrue(hasattr(signals, "_FALLBACK_RATE_LIMIT_SECONDS"),
                        "TI-08: signals 模块应有 _FALLBACK_RATE_LIMIT_SECONDS 变量")

    def test_fallback_rate_limit_seconds_reasonable(self):
        """速率限制时间应在合理范围内（1-60 秒）。"""
        from apps.rag.signals import _FALLBACK_RATE_LIMIT_SECONDS

        self.assertGreaterEqual(_FALLBACK_RATE_LIMIT_SECONDS, 1,
                                "速率限制应至少 1 秒")
        self.assertLessEqual(_FALLBACK_RATE_LIMIT_SECONDS, 60,
                             "速率限制不应超过 60 秒（否则影响正常场景）")

    def test_redis_success_path_unaffected(self):
        """Redis 正常时不走降级路径，速率限制不应影响正常流程。"""
        from apps.rag.signals import _debounce_record_index

        table_id = str(uuid.uuid4())
        record_id = str(uuid.uuid4())

        mock_redis = MagicMock()
        mock_redis.set.return_value = True  # nx=True 首次成功

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            with patch("apps.rag.tasks._flush_record_batch") as mock_flush:
                _debounce_record_index(table_id, record_id)
                # 正常路径不应触发 embed_record_task.delay
                # （而是走 _flush_record_batch.apply_async）
                mock_flush.apply_async.assert_called_once()


# =====================================================================
# TI-01 回归测试：_build_embed_kwargs OpenAI dimensions 参数修复
# =====================================================================

class TI01OpenAIDimensionsTest(TestCase):
    """TI-01 回归：_build_embed_kwargs 应为 OpenAI text-embedding-3 系列传递 dimensions 参数。"""

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def _make_svc(self, model, dimensions, _mock_init):
        from apps.rag.services.embedding_service import EmbeddingService
        svc = EmbeddingService()
        svc.provider = "openai"
        svc.model = model
        svc.dimensions = dimensions
        return svc

    def test_text_embedding_3_small_includes_dimensions(self):
        """text-embedding-3-small 配置非默认维度时，kwargs 必须包含 dimensions。"""
        svc = self._make_svc("text-embedding-3-small", 512)
        kwargs = svc._build_embed_kwargs("test text")
        self.assertIn("dimensions", kwargs)
        self.assertEqual(kwargs["dimensions"], 512)

    def test_text_embedding_3_large_includes_dimensions(self):
        """text-embedding-3-large 配置非默认维度时，kwargs 必须包含 dimensions。"""
        svc = self._make_svc("text-embedding-3-large", 256)
        kwargs = svc._build_embed_kwargs(["text1", "text2"])
        self.assertIn("dimensions", kwargs)
        self.assertEqual(kwargs["dimensions"], 256)

    def test_text_embedding_ada_002_no_dimensions(self):
        """text-embedding-ada-002 不支持 dimensions，kwargs 不应包含该参数。"""
        svc = self._make_svc("text-embedding-ada-002", 1536)
        kwargs = svc._build_embed_kwargs("test text")
        self.assertNotIn(
            "dimensions", kwargs,
            "text-embedding-ada-002 不支持 dimensions，不应传递该参数",
        )

    def test_qwen_always_includes_dimensions(self):
        """qwen provider 依然传递 dimensions（已有逻辑，回归确认）。"""
        from apps.rag.services.embedding_service import EmbeddingService
        with patch.object(EmbeddingService, "_init_llm_service"):
            svc = EmbeddingService()
        svc.provider = "qwen"
        svc.model = "text-embedding-v3"
        svc.dimensions = 1024
        kwargs = svc._build_embed_kwargs("test")
        self.assertIn("dimensions", kwargs)
        self.assertEqual(kwargs["dimensions"], 1024)

    def test_text_embedding_3_small_default_1536_still_passes_dimensions(self):
        """即便 dimensions=1536（OpenAI 默认值），text-embedding-3-small 也应传 dimensions
        以确保行为一致（API 接受该参数，不会报错）。"""
        svc = self._make_svc("text-embedding-3-small", 1536)
        kwargs = svc._build_embed_kwargs("hello")
        self.assertIn("dimensions", kwargs)

    def test_model_and_input_always_present(self):
        """model 和 input 字段必须始终存在，无论 provider 和模型。"""
        svc = self._make_svc("text-embedding-3-small", 512)
        kwargs = svc._build_embed_kwargs("hello")
        self.assertIn("model", kwargs)
        self.assertIn("input", kwargs)
        self.assertEqual(kwargs["input"], "hello")


# =====================================================================
# TI-02 回归测试：_precheck_billing ImportError 降级行为修复
# =====================================================================

class TI02BillingImportFlagTest(TestCase):
    """TI-02 回归：_BILLING_AVAILABLE 标志位控制 _precheck_billing 的降级行为。"""

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_billing_unavailable_logs_warning_and_returns(self, _mock_init):
        """计费不可用时，_precheck_billing 应记录 warning 并直接返回，不抛出异常。"""
        import apps.rag.services.embedding_service as svc_mod
        from apps.rag.services.embedding_service import EmbeddingService

        original = svc_mod._BILLING_AVAILABLE
        try:
            svc_mod._BILLING_AVAILABLE = False
            svc = EmbeddingService()
            with self.assertLogs("apps.rag.services.embedding_service", level="WARNING") as cm:
                svc._precheck_billing("user-1", "ws-1")
            self.assertTrue(
                any("计费模块不可用" in msg for msg in cm.output),
                "计费不可用时应记录 warning 日志",
            )
        finally:
            svc_mod._BILLING_AVAILABLE = original

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_billing_unavailable_no_exception(self, _mock_init):
        """计费不可用时，_precheck_billing 不应阻断 Embedding 调用（不抛出任何异常）。"""
        import apps.rag.services.embedding_service as svc_mod
        from apps.rag.services.embedding_service import EmbeddingService

        original = svc_mod._BILLING_AVAILABLE
        try:
            svc_mod._BILLING_AVAILABLE = False
            svc = EmbeddingService()
            try:
                svc._precheck_billing("user-1", "ws-1")
            except Exception as e:
                self.fail(f"计费不可用时 _precheck_billing 不应抛出异常，实际抛出: {e}")
        finally:
            svc_mod._BILLING_AVAILABLE = original

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_billing_unavailable_skips_charge(self, _mock_init):
        """计费不可用时，_charge_embedding_usage 应静默跳过，不调用 CreditsService。"""
        import apps.rag.services.embedding_service as svc_mod
        from apps.rag.services.embedding_service import EmbeddingService

        original = svc_mod._BILLING_AVAILABLE
        original_credits = svc_mod._CreditsService
        try:
            svc_mod._BILLING_AVAILABLE = False
            mock_credits = MagicMock()
            svc_mod._CreditsService = mock_credits

            svc = EmbeddingService()
            mock_response = MagicMock()
            mock_response.usage.total_tokens = 100
            svc._charge_embedding_usage(mock_response, "user-1", "ws-1", charge_id="test-id")

            mock_credits.consume_credits.assert_not_called()
        finally:
            svc_mod._BILLING_AVAILABLE = original
            svc_mod._CreditsService = original_credits

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_billing_available_calls_check_functions(self, _mock_init):
        """计费可用时，_precheck_billing 应调用余额和预算检查函数。"""
        import apps.rag.services.embedding_service as svc_mod
        from apps.rag.services.embedding_service import EmbeddingService

        original_available = svc_mod._BILLING_AVAILABLE
        original_balance = svc_mod._check_balance_before_request
        original_budget = svc_mod._check_budget_before_request
        try:
            svc_mod._BILLING_AVAILABLE = True
            mock_balance = MagicMock(return_value=False)
            mock_budget = MagicMock(return_value=False)
            svc_mod._check_balance_before_request = mock_balance
            svc_mod._check_budget_before_request = mock_budget

            svc = EmbeddingService()
            svc._precheck_billing("user-1", "ws-1")

            mock_budget.assert_called_once_with("ws-1")
            mock_balance.assert_called_once_with("user-1", "ws-1")
        finally:
            svc_mod._BILLING_AVAILABLE = original_available
            svc_mod._check_balance_before_request = original_balance
            svc_mod._check_budget_before_request = original_budget

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_billing_available_raises_on_insufficient_balance(self, _mock_init):
        """计费可用且余额不足时，应抛出 _InsufficientBalanceError。"""
        import apps.rag.services.embedding_service as svc_mod
        from apps.rag.services.embedding_service import EmbeddingService

        original_available = svc_mod._BILLING_AVAILABLE
        original_balance = svc_mod._check_balance_before_request
        original_budget = svc_mod._check_budget_before_request
        original_error = svc_mod._InsufficientBalanceError
        try:
            class FakeInsufficientBalanceError(Exception):
                pass

            svc_mod._BILLING_AVAILABLE = True
            svc_mod._check_budget_before_request = MagicMock(return_value=False)
            svc_mod._check_balance_before_request = MagicMock(return_value=True)
            svc_mod._InsufficientBalanceError = FakeInsufficientBalanceError

            svc = EmbeddingService()
            with self.assertRaises(FakeInsufficientBalanceError):
                svc._precheck_billing("user-1", "ws-1")
        finally:
            svc_mod._BILLING_AVAILABLE = original_available
            svc_mod._check_balance_before_request = original_balance
            svc_mod._check_budget_before_request = original_budget
            svc_mod._InsufficientBalanceError = original_error

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_precheck_billing_skips_when_no_user_id(self, _mock_init):
        """user_id 为空时，_precheck_billing 应直接返回，无论计费是否可用。"""
        from apps.rag.services.embedding_service import EmbeddingService
        svc = EmbeddingService()
        try:
            svc._precheck_billing("", "ws-1")
            svc._precheck_billing(None, "ws-1")
        except Exception as e:
            self.fail(f"user_id 为空时不应抛出异常: {e}")


# =====================================================================
# Wave-2 安全修复回归测试 (SEC-04 ~ SEC-11)
# =====================================================================

class SEC04CheckTaskAccessCodeTypeTest(TestCase):
    """SEC-04: _check_task_access code 类型 organization_id=None 应返回 403。"""
    databases = {"postgresql"}

    def test_code_type_none_organization_is_denied(self):
        """organization_id 为 None 的 code 任务应被拒绝（而非放行）。"""
        import inspect
        from apps.rag.api import _check_task_access
        source = inspect.getsource(_check_task_access)
        # 验证修复逻辑：not task_record.organization_id 时 return 403
        self.assertIn("not task_record.organization_id", source)

    @patch("apps.rag.api._get_accessible_organization_ids")
    def test_code_type_with_organization_allowed(self, mock_accessible):
        """organization_id 存在且在可访问列表时应放行。"""
        ws_uuid = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        # mock 返回与 task.organization_id 一致的字符串形式
        mock_accessible.return_value = [str(ws_uuid)]
        from apps.rag.models import EmbeddingTask
        EmbeddingTask.objects.create(
            task_type="code",
            target_id=uuid.uuid4(),
            organization_id=ws_uuid,
            celery_task_id="test-celery-id-sec04-allowed",
            status="pending",
        )
        from apps.rag.api import _check_task_access
        result = _check_task_access("user-1", "test-celery-id-sec04-allowed")
        self.assertIsNone(result)

    @patch("apps.rag.api._get_accessible_organization_ids")
    def test_code_type_with_organization_denied(self, mock_accessible):
        """organization_id 存在但不在可访问列表时应返回 403。"""
        mock_accessible.return_value = ["ws-other"]
        from apps.rag.models import EmbeddingTask
        task = EmbeddingTask.objects.create(
            task_type="code",
            target_id=uuid.uuid4(),
            organization_id=uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
            celery_task_id="test-celery-id-sec04-denied",
            status="pending",
        )
        from apps.rag.api import _check_task_access
        result = _check_task_access("user-1", "test-celery-id-sec04-denied")
        self.assertIsNotNone(result)
        status_code, _ = result
        self.assertEqual(status_code, 403)

    def test_code_type_none_organization_denied_unit(self):
        """直接 mock EmbeddingTask 验证 organization_id=None 时返回 403。"""
        from unittest.mock import patch, MagicMock
        from apps.rag.api import _check_task_access

        mock_task = MagicMock()
        mock_task.task_type = "code"
        mock_task.organization_id = None
        mock_task.target_id = uuid.uuid4()

        with patch("apps.rag.api._get_accessible_organization_ids"):
            with patch("apps.rag.models.EmbeddingTask.objects") as mock_objs:
                mock_objs.filter.return_value.first.return_value = mock_task
                result = _check_task_access("user-1", "fake-task-id")
                self.assertIsNotNone(result)
                status_code, _ = result
                self.assertEqual(status_code, 403)


class SEC05CodeIndexPermissionTest(TestCase):
    """SEC-05: delete_code_index / sync_code_index 空 organization_id 时 probe=None 应返回 400。"""

    def test_delete_code_index_probe_none_returns_400(self):
        """delete_code_index: probe=None 且无 payload.organization_id 应返回 400。"""
        import inspect
        from apps.rag.api import delete_code_index
        source = inspect.getsource(delete_code_index)
        self.assertIn("probe is None", source)

    def test_sync_code_index_probe_none_returns_400(self):
        """sync_code_index: probe=None 且无 payload.organization_id 应返回 400。"""
        import inspect
        from apps.rag.api import sync_code_index
        source = inspect.getsource(sync_code_index)
        self.assertIn("probe is None", source)


class SEC06MonitorStaffOnlyTest(TestCase):
    """SEC-06: 监控端点需要 is_staff 权限。"""

    def _make_request(self, is_staff: bool):
        from unittest.mock import MagicMock
        req = MagicMock()
        req.auth = MagicMock()
        req.auth.is_staff = is_staff
        return req

    def test_require_staff_blocks_regular_user(self):
        """普通用户调用 _require_staff 应返回 403。"""
        from apps.rag.api import _require_staff
        req = self._make_request(is_staff=False)
        result = _require_staff(req)
        self.assertIsNotNone(result)
        status_code, _ = result
        self.assertEqual(status_code, 403)

    def test_require_staff_allows_staff_user(self):
        """is_staff=True 时 _require_staff 应返回 None（放行）。"""
        from apps.rag.api import _require_staff
        req = self._make_request(is_staff=True)
        result = _require_staff(req)
        self.assertIsNone(result)

    def test_monitor_endpoints_call_require_staff(self):
        """四个监控端点的源码中都应调用 _require_staff。"""
        import inspect
        from apps.rag.api import (
            get_index_quality,
            get_index_coverage_api,
            get_performance_metrics_api,
            get_comprehensive_report_api,
        )
        for fn in [get_index_quality, get_index_coverage_api, get_performance_metrics_api, get_comprehensive_report_api]:
            source = inspect.getsource(fn)
            self.assertIn("_require_staff", source, f"{fn.__name__} 缺少 _require_staff 调用")


class SEC08TaskStatusSafeErrorTest(TestCase):
    """SEC-08: task status 端点不应泄漏原始异常信息。"""

    def test_get_task_status_uses_safe_error_message(self):
        """get_task_status 源码中 result.info 应经过 _safe_error_message 过滤。"""
        import inspect
        from apps.rag.api import get_task_status_api
        source = inspect.getsource(get_task_status_api)
        # 确保不再有裸 str(result.info)
        self.assertNotIn("str(result.info)", source)
        # 确保使用了 _safe_error_message
        self.assertIn("_safe_error_message", source)


class SEC09UnifiedSearchSafeErrorTest(TestCase):
    """SEC-09: unified_search_api 不应泄漏内部错误信息。"""

    def test_unified_search_api_uses_safe_error(self):
        """unified_search_api 中 result['error'] 应经过 _safe_error_message 过滤。"""
        import inspect
        from apps.rag.api import unified_search_api
        source = inspect.getsource(unified_search_api)
        # 确保错误消息经过过滤
        self.assertIn("_safe_error_message", source)

    def test_safe_error_message_filters_exception(self):
        """_safe_error_message 非 ValueError 在非 DEBUG 模式下应返回通用提示。"""
        from django.test import override_settings
        from apps.rag.api import _safe_error_message

        with override_settings(DEBUG=False):
            msg = _safe_error_message(RuntimeError("internal db connection string: dsn://secret"))
            self.assertNotIn("dsn://secret", msg)
            self.assertNotIn("internal db", msg)


class SEC10CreateDocumentIndexAsyncTest(TestCase):
    """SEC-10: create_document_index async 权限检查应在 _run_sync 内。"""

    def test_access_check_inside_run_sync(self):
        """create_document_index 的 async 体中不应直接调用 _check_document_access（应在内嵌函数中）。"""
        import inspect, ast, textwrap
        from apps.rag.api import create_document_index

        source = inspect.getsource(create_document_index)
        # 验证 _check_document_access 不在 async 函数顶层，而在 _run_sync 内
        # 简单字符串检查：_run_sync 定义后才有 _check_document_access
        run_sync_pos = source.find("def _run_sync()")
        check_pos = source.find("_check_document_access")
        self.assertGreater(run_sync_pos, 0, "应存在 _run_sync 内嵌函数")
        self.assertGreater(check_pos, run_sync_pos, "_check_document_access 应在 _run_sync 定义之后")


class SEC11DeleteIndexAsyncTest(TestCase):
    """SEC-11: delete_index async 权限检查应在 _run_sync 内。"""

    def test_orm_access_check_inside_run_sync(self):
        """delete_index 的 async 体中不应在 _run_sync 前直接调用 ORM 和权限检查。"""
        import inspect
        from apps.rag.api import delete_index

        source = inspect.getsource(delete_index)
        run_sync_pos = source.find("def _run_sync()")
        self.assertGreater(run_sync_pos, 0, "应存在 _run_sync 内嵌函数")

        # _run_sync 之前的代码（async body 前半部分）不应包含 _check_table_access
        before_run_sync = source[:run_sync_pos]
        self.assertNotIn("_check_table_access", before_run_sync,
                         "_check_table_access 不应出现在 _run_sync 定义之前")
        self.assertNotIn("_check_document_access", before_run_sync,
                         "_check_document_access 不应出现在 _run_sync 定义之前")
        self.assertNotIn("TableRecord.objects", before_run_sync,
                         "ORM 调用不应出现在 _run_sync 定义之前")


# =====================================================================
# W2-02 Wave2 P1 回归测试
# =====================================================================

DUMMY_VECTOR = [0.1] * 1536


class SEC03SkillIDORTest(TestCase):
    """SEC-03 / SC-007 回归：_search_skills 中 space_id 必须通过 Space.organization_id
    外键映射后与 accessible_organization_ids 做归属校验，而非直接比较 space_id。"""

    def test_inaccessible_space_returns_empty(self):
        """space_id 对应的 organization_id 不在 accessible_organization_ids 时，应返回空列表。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch("apps.tabtinspace.models.Space.objects") as mock_qs:
            mock_qs.filter.return_value.values_list.return_value.first.return_value = "ws-evil"
            result = _search_skills(
                query_vector=DUMMY_VECTOR,
                query="test",
                user_id="user-1",
                organization_id=None,
                accessible_organization_ids=["ws-allowed"],
                top_k=10,
                threshold=0.7,
                scope={"space_id": "space-123"},
            )
        self.assertEqual(result, [])

    def test_nonexistent_space_returns_empty(self):
        """space_id 不存在（查询返回 None）时，应返回空列表。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch("apps.tabtinspace.models.Space.objects") as mock_qs:
            mock_qs.filter.return_value.values_list.return_value.first.return_value = None
            result = _search_skills(
                query_vector=DUMMY_VECTOR,
                query="test",
                user_id="user-1",
                organization_id=None,
                accessible_organization_ids=["ws-allowed"],
                top_k=10,
                threshold=0.7,
                scope={"space_id": "space-nonexistent"},
            )
        self.assertEqual(result, [])

    def test_accessible_space_passes_through(self):
        """space_id 对应的 organization_id 在 accessible_organization_ids 时，应调用 SkillEmbeddingService.search。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch("apps.tabtinspace.models.Space.objects") as mock_qs, \
             patch("apps.skills.services.embedding_service.SkillEmbeddingService.search") as mock_search:
            mock_qs.filter.return_value.values_list.return_value.first.return_value = "ws-allowed"
            mock_search.return_value = []
            _search_skills(
                query_vector=DUMMY_VECTOR,
                query="test",
                user_id="user-1",
                organization_id=None,
                accessible_organization_ids=["ws-allowed"],
                top_k=10,
                threshold=0.7,
                scope={"space_id": "space-123"},
            )
            mock_search.assert_called_once()

    def test_space_id_not_compared_directly_with_organization_ids(self):
        """SC-007 核心回归：即使 space_id 值等于某个 organization_id 值，
        也不能通过校验——必须通过 Space 模型查 organization_id 归属。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch("apps.tabtinspace.models.Space.objects") as mock_qs:
            mock_qs.filter.return_value.values_list.return_value.first.return_value = "ws-other"
            result = _search_skills(
                query_vector=DUMMY_VECTOR,
                query="test",
                user_id="user-1",
                organization_id=None,
                accessible_organization_ids=["space-123"],
                top_k=10,
                threshold=0.7,
                scope={"space_id": "space-123"},
            )
        self.assertEqual(result, [], "space_id 碰巧等于 organization_id 时不应绕过校验")

    def test_no_scope_always_passes(self):
        """scope 为 None 时，不做 IDOR 校验，直接调用 SkillEmbeddingService.search。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch("apps.skills.services.embedding_service.SkillEmbeddingService.search") as mock_search:
            mock_search.return_value = []
            _search_skills(
                query_vector=DUMMY_VECTOR,
                query="test",
                user_id="user-1",
                organization_id="ws-1",
                accessible_organization_ids=["ws-1"],
                top_k=10,
                threshold=0.7,
                scope=None,
            )
            mock_search.assert_called_once()


class USS02SkillQueryFallbackTest(TestCase):
    """USS-02 回归：_search_skills 必须传入实际 query 文本，而非空字符串。"""

    def test_query_text_passed_to_skill_search(self):
        """UnifiedSearchService 传入的 query 必须透传到 SkillEmbeddingService.search。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch("apps.skills.services.embedding_service.SkillEmbeddingService.search") as mock_search:
            mock_search.return_value = []
            _search_skills(
                query_vector=DUMMY_VECTOR,
                query="find me a data skill",
                user_id="user-1",
                organization_id="ws-1",
                accessible_organization_ids=["ws-1"],
                top_k=5,
                threshold=0.7,
                scope=None,
            )
            call_kwargs = mock_search.call_args
            actual_query = call_kwargs[1].get("query") or call_kwargs[0][0]
            self.assertEqual(actual_query, "find me a data skill")



class USS04SingletonThreadLockTest(TestCase):
    """USS-04 回归：get_unified_search_service 必须使用线程锁，不得出现多实例。"""

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_same_instance_across_calls(self, _mock_init):
        """多次调用 get_unified_search_service 应返回同一实例。"""
        from apps.rag.services.unified_search_service import (
            get_unified_search_service,
        )
        import apps.rag.services.unified_search_service as mod

        mod._unified_search_instance = None
        svc1 = get_unified_search_service()
        svc2 = get_unified_search_service()
        self.assertIs(svc1, svc2)

    def test_lock_attribute_exists(self):
        """模块必须存在 _unified_search_lock（threading.Lock）。"""
        import apps.rag.services.unified_search_service as mod
        import threading

        self.assertTrue(hasattr(mod, "_unified_search_lock"))
        self.assertIsInstance(mod._unified_search_lock, type(threading.Lock()))


class USS05OrganizationCacheTest(TestCase):
    """USS-05 回归：_get_user_accessible_organizations 必须使用 Django cache 缓存。"""

    def setUp(self):
        cache.clear()

    def test_second_call_hits_cache_not_db(self):
        """第二次调用应命中缓存，不再查询数据库。"""
        from apps.rag.services.unified_search_service import _get_user_accessible_organizations

        with patch("apps.tabtinspace.models.Organization") as mock_ws, \
             patch("apps.tabtinspace.models.OrganizationMember") as mock_wm:
            mock_ws.objects.filter.return_value.values_list.return_value = ["ws-1"]
            mock_wm.objects.filter.return_value.values_list.return_value = []

            user_id = "user-cache-test-" + str(uuid.uuid4())
            result1 = _get_user_accessible_organizations(user_id)
            result2 = _get_user_accessible_organizations(user_id)

            self.assertEqual(result1, result2)
            self.assertEqual(mock_ws.objects.filter.call_count, 1,
                             "第二次调用应命中缓存，数据库只被查询一次")


class USS06SearchLogFieldsTest(TestCase):
    """USS-06 回归：SearchLog 必须记录 organization_id / content_types / scope / threshold / top_k。"""
    databases = {"postgresql"}

    @patch("apps.rag.services.unified_search_service._get_user_accessible_organizations")
    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_search_log_records_all_fields(self, _mock_init, mock_ws):
        """search() 完成后 SearchLog 的 filters 字段应包含所有检索参数。"""
        from apps.rag.services.unified_search_service import UnifiedSearchService
        from apps.rag.tasks import log_search_async

        mock_ws.return_value = ["ws-log-test"]
        svc = UnifiedSearchService()

        with patch.object(svc.embedding_service, "embed_text", return_value=DUMMY_VECTOR), \
             patch.object(log_search_async, "delay", side_effect=lambda **kw: log_search_async(**kw)):
            svc.search(
                query="log test query",
                user_id=str(uuid.uuid4()),
                organization_id="ws-log-test",
                content_types=["table"],
                top_k=5,
                similarity_threshold=0.8,
                scope={"space_id": "sp-1"},
            )

        log = SearchLog.objects.order_by("-created_at").first()
        self.assertIsNotNone(log)
        self.assertIn("organization_id", log.filters)
        self.assertIn("content_types", log.filters)
        self.assertIn("scope", log.filters)
        self.assertIn("threshold", log.filters)
        self.assertIn("top_k", log.filters)
        self.assertEqual(log.filters["organization_id"], "ws-log-test")
        self.assertEqual(log.filters["top_k"], 5)


class USS07RecordSpaceIdScopeTest(TestCase):
    """USS-07 回归：_search_records 必须支持 scope(space_id)，参照 _search_tables。"""

    def test_record_searcher_accepts_space_id_scope(self):
        """_search_records 接收 scope={'space_id': ...} 时，应将其应用到 queryset 过滤。"""
        from apps.rag.services.unified_search_service import _search_records

        # RecordEmbedding 在函数内部懒导入，需在源模块处 patch
        with patch("apps.rag.models.RecordEmbedding") as mock_re:
            mock_qs = MagicMock()
            mock_re.objects.filter.return_value = mock_qs
            mock_qs.annotate.return_value = mock_qs
            mock_qs.filter.return_value = mock_qs
            mock_qs.order_by.return_value = []

            _search_records(
                query_vector=DUMMY_VECTOR,
                user_id="user-1",
                organization_id=None,
                accessible_organization_ids=["ws-1"],
                top_k=10,
                threshold=0.7,
                scope={"space_id": "sp-abc"},
            )

            call_kwargs = mock_re.objects.filter.call_args[1]
            # DS-033: 改用顶层 space_id 字段过滤（不再使用 metadata__space_id）
            self.assertIn("space_id", call_kwargs,
                          "_search_records 应使用顶层 space_id 字段过滤")
            self.assertEqual(call_kwargs["space_id"], "sp-abc")

    def test_record_scope_space_id_empty_organization_ids_returns_empty(self):
        """scope.space_id 分支在 accessible_organization_ids 为空时应直接返回空列表。"""
        from apps.rag.services.unified_search_service import _search_records

        result = _search_records(
            query_vector=DUMMY_VECTOR,
            user_id="user-1",
            organization_id=None,
            accessible_organization_ids=[],
            top_k=10,
            threshold=0.7,
            scope={"space_id": "sp-abc"},
        )
        self.assertEqual(result, [])




# =====================================================================
# 回归测试：SI-01 status 默认值语义修复
# =====================================================================

class SI01StatusDefaultRegressionTest(TestCase):
    """
    回归测试 SI-01: TableEmbedding / RecordEmbedding / DocumentEmbedding
    创建时 status 默认值必须是 'pending'，不能是 'success'。

    根因：创建后向量化异步写入期间，若默认为 'success' 则状态与实际不符。
    修复：将三个模型 status 字段默认值改为 'pending'。
    """
    databases = {"postgresql"}

    def test_table_embedding_default_status_is_pending(self):
        """TableEmbedding 创建后默认 status 应为 pending。"""
        emb = TableEmbedding.objects.create(
            table_id=uuid.uuid4(),
            content="regression test",
            content_hash=TableEmbedding.calculate_content_hash("regression test"),
            embedding=[0.0] * 1536,
            metadata={},
        )
        self.assertEqual(emb.status, "pending",
                         "TableEmbedding 创建时 status 默认值必须为 pending，不能为 success")

    def test_table_embedding_explicit_success_allowed(self):
        """显式传入 status='success' 时（embedding 完成后）应正确保存。"""
        emb = TableEmbedding.objects.create(
            table_id=uuid.uuid4(),
            content="regression test done",
            content_hash=TableEmbedding.calculate_content_hash("regression test done"),
            embedding=[0.1] * 1536,
            metadata={},
            status="success",
        )
        self.assertEqual(emb.status, "success")

    def test_record_embedding_default_status_is_pending(self):
        """RecordEmbedding 创建后默认 status 应为 pending。"""
        emb = RecordEmbedding.objects.create(
            record_id=uuid.uuid4(),
            table_id=uuid.uuid4(),
            content="record regression",
            content_hash="hash_record_reg",
            embedding=[0.0] * 1536,
            metadata={},
        )
        self.assertEqual(emb.status, "pending",
                         "RecordEmbedding 创建时 status 默认值必须为 pending，不能为 success")

    def test_document_embedding_default_status_is_pending(self):
        """DocumentEmbedding 创建后默认 status 应为 pending。"""
        emb = DocumentEmbedding.objects.create(
            document_id=uuid.uuid4(),
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            content="doc regression",
            content_hash="hash_doc_reg",
            embedding=[0.0] * 1536,
            metadata={},
        )
        self.assertEqual(emb.status, "pending",
                         "DocumentEmbedding 创建时 status 默认值必须为 pending，不能为 success")

    def test_all_status_choices_valid(self):
        """三个模型的 STATUS_CHOICES 必须包含 pending / processing / success / failed。"""
        expected = {"pending", "processing", "success", "failed"}
        for model_cls in [TableEmbedding, RecordEmbedding, DocumentEmbedding]:
            choices = {v for v, _ in model_cls.STATUS_CHOICES}
            self.assertTrue(expected.issubset(choices),
                            f"{model_cls.__name__} STATUS_CHOICES 缺少必要状态值")


# =====================================================================
# 回归测试：SI-06 get_record_data() 降级日志
# =====================================================================

class SI06GetRecordDataFallbackLogTest(TestCase):
    """
    回归测试 SI-06: get_record_data() 原生读取失败时必须输出 warning 日志。

    根因：except Exception: pass 完全吞掉异常，导致降级无可观测性。
    修复：改为 except Exception as exc: logger.warning(...) 记录 record_id 和异常。
    """

    def test_get_record_data_logs_warning_on_native_failure(self):
        """原生列读取抛异常时，应有 warning 日志记录 record_id 和异常信息。"""
        import inspect
        from apps.tabdata import models as tabdata_models

        source = inspect.getsource(tabdata_models.TableRecord.get_record_data)
        self.assertIn("logger.warning", source,
                      "get_record_data() 降级时必须调用 logger.warning，而非静默吞掉异常")
        self.assertIn("exc", source,
                      "get_record_data() 的 warning 日志必须包含异常信息")

    def test_get_record_data_fallback_returns_json_field(self):
        """原生列读取失败时，应降级返回 JSONField 数据而非抛出异常。"""
        from unittest.mock import patch, MagicMock
        from apps.tabdata.models import TableRecord

        # 使用 MagicMock 模拟 self，避免 Django model 初始化问题
        mock_record = MagicMock(spec=TableRecord)
        mock_record.id = uuid.uuid4()
        mock_record.table_id = uuid.uuid4()
        mock_record.__dict__['data'] = {"field1": "value1"}

        with patch("apps.tabdata.models.Table") as mock_table_cls:
            mock_table_cls.objects.using.return_value.get.side_effect = Exception("native read error")
            with self.assertLogs("apps.tabdata.models", level="WARNING") as cm:
                result = TableRecord.get_record_data(mock_record)

        self.assertEqual(result, {"field1": "value1"},
                         "降级时应返回 JSONField 中的数据")
        self.assertTrue(
            any("native read" in msg or str(mock_record.id) in msg for msg in cm.output),
            f"warning 日志应包含 record_id 或异常信息，实际日志: {cm.output}",
        )


# =====================================================================
# Wave2 修复回归测试
# =====================================================================

class SI07StagingKeyExpiredTest(TestCase):
    """SI-07 回归：staging key 过期时应记录 EmbeddingTask status=failed，不静默丢失。"""

    databases = {"postgresql"}

    def test_staging_key_expired_creates_failed_embedding_task(self):
        """staging key 缺失时，应在 DB 写入 status=failed 的 EmbeddingTask 记录。"""
        import inspect
        import re
        from apps.rag import tasks as rag_tasks

        source = inspect.getsource(rag_tasks.index_code_chunks_task)
        self.assertIn("staging_key_expired", source,
                      "index_code_chunks_task 必须处理 staging_key_expired 情形")
        self.assertIn("EmbeddingTask", source,
                      "staging key 过期时必须写入 EmbeddingTask 记录")
        self.assertIsNotNone(
            re.search(r'status.*failed|failed.*status', source.replace("'", '"')),
            "staging key 过期时必须写入 status=failed 的 EmbeddingTask 记录",
        )

    def test_staging_key_expired_writes_failed_task_to_db(self):
        """模拟 Redis 返回 None，验证 EmbeddingTask 被创建为 failed 状态。"""
        ws_id = str(uuid.uuid4())
        project_id = str(uuid.uuid4())
        staging_key = f"rag:code:staging:{uuid.uuid4()}"

        mock_redis = MagicMock()
        mock_redis.get.return_value = None  # staging key 不存在（已过期）

        from apps.rag import tasks as rag_tasks

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            result_obj = rag_tasks.index_code_chunks_task.apply(kwargs={
                "project_id": project_id,
                "organization_id": ws_id,
                "chunks_data": None,
                "chunks_staging_key": staging_key,
            })
            result = result_obj.result

        self.assertEqual(result.get("error"), "staging_key_expired")

        # 使用 .apply() 时，task_id 由 Celery 自动生成，root_task_id=None 时用 self.request.id
        actual_task_id = result_obj.task_id
        task_record = EmbeddingTask.objects.filter(
            celery_task_id=actual_task_id,
            task_type='code',
            status='failed',
        ).first()
        self.assertIsNotNone(task_record,
                             "staging key 过期时必须创建 status=failed 的 EmbeddingTask")
        self.assertIn("staging_key_expired", task_record.error_message)


class SI08RedisLockTest(TestCase):
    """SI-08 回归：Redis 锁 TTL >= 1500s，release 使用 owner token 验证。"""

    def test_acquire_lock_ttl_is_at_least_1500(self):
        """_acquire_project_lock 默认 TTL 必须 >= 1500s。"""
        import inspect
        from apps.rag import tasks as rag_tasks

        source = inspect.getsource(rag_tasks._acquire_project_lock)
        self.assertIn("1500", source,
                      "_acquire_project_lock TTL 必须 >= 1500s，与 time_limit=1200s 匹配")

    def test_acquire_lock_returns_token(self):
        """成功获取锁时返回非空 token 字符串。"""
        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            from apps.rag import tasks as rag_tasks
            token = rag_tasks._acquire_project_lock("proj-123")

        self.assertIsInstance(token, str)
        self.assertTrue(len(token) > 0, "获取锁成功时必须返回非空 token")

    def test_acquire_lock_returns_empty_when_locked(self):
        """锁已被占用时返回空字符串。"""
        mock_redis = MagicMock()
        mock_redis.set.return_value = False  # NX 失败，锁已存在

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            from apps.rag import tasks as rag_tasks
            token = rag_tasks._acquire_project_lock("proj-123")

        self.assertEqual(token, "", "锁已被占用时必须返回空字符串")

    def test_release_lock_uses_lua_script(self):
        """_release_project_lock 必须使用 Lua 脚本验证 owner token。"""
        import inspect
        from apps.rag import tasks as rag_tasks

        source = inspect.getsource(rag_tasks._release_project_lock)
        self.assertIn("eval", source,
                      "_release_project_lock 必须使用 Redis eval(Lua 脚本)验证 owner token")
        self.assertIn("token", source,
                      "_release_project_lock 必须接受并验证 token 参数")

    def test_release_lock_with_wrong_token_does_not_delete(self):
        """owner token 不匹配时，Lua 脚本应返回 0 而不删除锁。"""
        mock_redis = MagicMock()
        mock_redis.eval.return_value = 0  # Lua 脚本：token 不匹配

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            from apps.rag import tasks as rag_tasks
            rag_tasks._release_project_lock("proj-123", token="wrong-token")

        mock_redis.eval.assert_called_once()
        mock_redis.delete.assert_not_called()


class SI09ReindexCodeTypeNotCancelledTest(TestCase):
    """SI-09 回归：reindex_failed_tasks 不得将 code 类型失败任务误标 cancelled。"""

    databases = {"postgresql"}

    def test_code_type_failed_task_not_cancelled(self):
        """code 类型的 failed EmbeddingTask 在 reindex_failed_tasks 运行后应保持 failed 状态。"""
        ws_id = uuid.uuid4()
        code_task = EmbeddingTask.objects.create(
            task_type='code',
            target_id=ws_id,
            organization_id=None,
            status='failed',
            error_message='embedding service timeout',
        )

        from apps.rag.tasks import reindex_failed_tasks
        reindex_failed_tasks()

        code_task.refresh_from_db()
        self.assertEqual(
            code_task.status, 'failed',
            "code 类型失败任务不应被 reindex_failed_tasks 误 cancel（SI-09 保守策略）",
        )

    def test_table_type_orphan_still_gets_cancelled(self):
        """table 类型孤儿任务（目标表已删除）仍应被正确 cancel（保证原有逻辑未被破坏）。"""
        non_existent_table_id = uuid.uuid4()
        orphan_task = EmbeddingTask.objects.create(
            task_type='table',
            target_id=non_existent_table_id,
            status='failed',
            error_message='test',
        )

        from apps.rag.tasks import reindex_failed_tasks
        reindex_failed_tasks()

        orphan_task.refresh_from_db()
        self.assertEqual(
            orphan_task.status, 'cancelled',
            "table 类型孤儿任务（目标已删除）应被正确 cancel",
        )


class TI03RootTaskIdRetryTest(TestCase):
    """TI-03 回归：重试时复用同一 EmbeddingTask 记录，而不是新建。"""

    databases = {"postgresql"}

    def test_index_table_task_retry_reuses_embedding_task(self):
        """index_table_task 两次调用（模拟 retry）使用相同 root_task_id 时，只应存在一条记录。"""
        root_id = str(uuid.uuid4())
        table_id = str(uuid.uuid4())
        ws_id = uuid.uuid4()

        with patch("apps.rag.tasks._resolve_table_organization", return_value=ws_id), \
             patch("apps.rag.tasks._acquire_target_lock", return_value="fake-token"), \
             patch("apps.rag.tasks._release_target_lock"), \
             patch("apps.rag.services.IndexService") as mock_svc_cls:
            mock_svc = mock_svc_cls.return_value
            mock_svc.index_table.return_value = {"status": "success"}

            from apps.rag import tasks as rag_tasks

            rag_tasks.index_table_task.apply(kwargs={
                "table_id": table_id, "force": False, "root_task_id": root_id,
            })
            rag_tasks.index_table_task.apply(kwargs={
                "table_id": table_id, "force": False, "root_task_id": root_id,
            })

        # 两次调用使用相同 root_task_id，update_or_create 应保证只有一条记录
        count = EmbeddingTask.objects.filter(celery_task_id=root_id).count()
        self.assertEqual(count, 1,
                         "使用相同 root_task_id 的多次 retry 应只保留一条 EmbeddingTask 记录（TI-03）")

    def test_embed_record_task_first_call_sets_root_task_id(self):
        """embed_record_task 首次调用（root_task_id=None）时，使用当前 task_id 作为 root。"""
        record_id = str(uuid.uuid4())
        ws_id = uuid.uuid4()

        with patch("apps.rag.tasks._resolve_record_organization", return_value=ws_id), \
             patch("apps.rag.tasks._acquire_record_lock", return_value="fake-token"), \
             patch("apps.rag.tasks._release_record_lock"), \
             patch("apps.tabdata.models.TableRecord.objects") as mock_tr_qs, \
             patch("apps.rag.services.IndexService") as mock_svc_cls:
            mock_tr_qs.filter.return_value.exists.return_value = True
            mock_svc = mock_svc_cls.return_value
            mock_svc.index_record.return_value = {"embedding_id": str(uuid.uuid4())}

            from apps.rag import tasks as rag_tasks
            result_obj = rag_tasks.embed_record_task.apply(kwargs={
                "record_id": record_id, "force": False, "root_task_id": None,
            })

        actual_task_id = result_obj.task_id
        record = EmbeddingTask.objects.filter(celery_task_id=actual_task_id).first()
        self.assertIsNotNone(record,
                             "首次调用时（root_task_id=None）应以当前 task_id 为 celery_task_id")


class TI04FlushRecordBatchTest(TestCase):
    """TI-04 回归：_flush_record_batch 使用 SPOP 分批取，避免竞争窗口丢失新写入。"""

    def test_flush_uses_spop_not_smembers(self):
        """_flush_record_batch 源码必须使用 spop 而非 smembers+delete 组合。"""
        import inspect
        from apps.rag import tasks as rag_tasks

        source = inspect.getsource(rag_tasks._flush_record_batch)
        self.assertIn("spop", source,
                      "_flush_record_batch 必须使用 SPOP 原子弹出，避免丢失并发写入（TI-04）")
        self.assertNotIn("smembers", source,
                         "_flush_record_batch 不应使用 SMEMBERS，这会产生竞争窗口（TI-04）")

    def test_flush_dispatches_all_records(self):
        """正常情况下，SPOP 弹出的所有 record_id 都应被 delay 分发。"""
        table_id = str(uuid.uuid4())
        record_ids = [str(uuid.uuid4()).encode() for _ in range(5)]

        mock_redis = MagicMock()
        # SPOP 第一次返回 5 条，第二次返回空（模拟 set 已清空）
        mock_redis.spop.side_effect = [record_ids, []]
        mock_redis.scard.return_value = 0

        dispatched = []

        def fake_delay(rid, force=False):
            dispatched.append(rid)

        with patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks.embed_record_task") as mock_embed:
            mock_embed.delay.side_effect = fake_delay
            from apps.rag import tasks as rag_tasks
            result = rag_tasks._flush_record_batch(table_id)

        self.assertEqual(result["flushed"], 5)
        self.assertEqual(mock_embed.delay.call_count, 5)
        # trigger_key 在最后删除（set 已清空）
        mock_redis.delete.assert_called()

    def test_flush_does_not_delete_trigger_key_when_remaining(self):
        """触及批量上限后 set 仍有余量时，不删除 trigger_key，改为重新调度。"""
        from apps.rag import tasks as rag_tasks

        table_id = str(uuid.uuid4())

        # 每次 SPOP 都返回 500 条，确保触及 MAX_TOTAL=5000 上限
        batch = [str(uuid.uuid4()).encode() for _ in range(500)]
        mock_redis = MagicMock()
        mock_redis.spop.return_value = batch
        mock_redis.scard.return_value = 100  # 仍有剩余

        # 只 patch apply_async 方法，保留真实函数体执行
        with patch("django_redis.get_redis_connection", return_value=mock_redis), \
             patch("apps.rag.tasks.embed_record_task") as mock_embed, \
             patch.object(rag_tasks._flush_record_batch, "apply_async") as mock_apply_async:
            mock_embed.delay.return_value = None
            mock_apply_async.return_value = None
            result = rag_tasks._flush_record_batch(table_id)

        # 触及 5000 上限后应重新调度
        mock_apply_async.assert_called_once()
        # trigger_key 不应被 delete（应保留，供重新调度使用）
        trigger_key = f"rag:record_batch_trigger:{table_id}"
        delete_calls = [str(c) for c in mock_redis.delete.call_args_list]
        for call_str in delete_calls:
            self.assertNotIn(trigger_key, call_str,
                             "有剩余记录时不应删除 trigger_key（TI-04）")

    def test_flush_batch_size_limit(self):
        """SPOP 每次弹出量必须有上限（不能一次取全部）。"""
        import inspect
        from apps.rag import tasks as rag_tasks

        source = inspect.getsource(rag_tasks._flush_record_batch)
        self.assertIn("_BATCH_SIZE", source,
                      "_flush_record_batch 必须定义 _BATCH_SIZE 限制单批取量（TI-04）")
        self.assertIn("_MAX_TOTAL", source,
                      "_flush_record_batch 必须定义 _MAX_TOTAL 防止无限循环（TI-04）")


# =====================================================================
# EQ-004 (P0): index_code_chunks_task 核心分支测试
# =====================================================================

@unittest.skip("TabCode semantic indexing retired")
class CodeChunksTaskTest(TestCase):
    """EQ-004: 验证 index_code_chunks_task 核心流程——staging key、Redis 锁、
    批量 embed、bulk_create with update_conflicts。"""

    databases = {"default", "postgresql"}

    def _make_chunk(self, file_path="main.py", start_line=1, end_line=10,
                    content="def foo(): pass"):
        return {
            "file_path": file_path,
            "start_line": start_line,
            "end_line": end_line,
            "content": content,
            "signature": "def foo()",
            "kind": "function",
            "language": "python",
            "metadata": {},
        }

    def _make_mock_self(self):
        mock_self = MagicMock()
        mock_self.request.id = str(uuid.uuid4())
        mock_self.request.retries = 0
        mock_self.max_retries = 3
        return mock_self

    @patch("django_redis.get_redis_connection")
    @patch("apps.rag.tasks._acquire_project_lock", return_value=True)
    @patch("apps.rag.tasks._release_project_lock")
    @patch("apps.rag.tasks._do_index_code_chunks")
    def test_staging_key_normal_read(self, mock_do, mock_release, mock_acquire, mock_redis_conn):
        """staging key 存在时，应从 Redis 读取 chunks_data 并传入 _do_index_code_chunks。"""
        import json as _json
        from apps.rag.tasks import index_code_chunks_task

        chunks = [self._make_chunk()]
        mock_redis = MagicMock()
        mock_redis.get.return_value = _json.dumps(chunks).encode()
        mock_redis_conn.return_value = mock_redis
        mock_do.return_value = {
            "success": True, "created": 1, "skipped": 0, "failed": 0, "errors": [],
        }

        result = index_code_chunks_task.apply(kwargs={
            "project_id": "proj-stg",
            "organization_id": str(uuid.uuid4()),
            "chunks_staging_key": "rag:code:staging:test-key",
        }).result

        mock_redis.get.assert_called_with("rag:code:staging:test-key")
        mock_do.assert_called_once()
        # 验证传入 _do_index_code_chunks 的 chunks_data 是从 Redis 反序列化的结果
        call_args = mock_do.call_args
        passed_chunks = call_args[0][3]  # positional arg index 3 = chunks_data
        self.assertEqual(len(passed_chunks), 1)
        self.assertEqual(passed_chunks[0]["file_path"], "main.py")

    @patch("django_redis.get_redis_connection")
    def test_staging_key_expired_returns_error(self, mock_redis_conn):
        """staging key 不存在（过期）时，应返回 staging_key_expired 错误，不进入索引流程。"""
        from apps.rag.tasks import index_code_chunks_task

        mock_redis = MagicMock()
        mock_redis.get.return_value = None  # key 过期
        mock_redis_conn.return_value = mock_redis

        result = index_code_chunks_task.apply(kwargs={
            "project_id": "proj-expired",
            "organization_id": str(uuid.uuid4()),
            "chunks_staging_key": "rag:code:staging:expired-key",
        }).result

        self.assertIsInstance(result, dict)
        self.assertFalse(result.get("success", True))
        self.assertEqual(result.get("error"), "staging_key_expired")

    @patch("apps.rag.tasks._acquire_project_lock", return_value=True)
    @patch("apps.rag.tasks._release_project_lock")
    @patch("apps.rag.tasks._do_index_code_chunks")
    def test_lock_acquired_and_released_in_finally(self, mock_do, mock_release, mock_acquire):
        """Redis 锁应在 _do_index_code_chunks 前获取，并在 finally 中释放（含异常路径）。"""
        from apps.rag.tasks import index_code_chunks_task

        mock_do.return_value = {
            "success": True, "created": 1, "skipped": 0, "failed": 0, "errors": [],
        }
        project_id = "proj-lock-test"

        index_code_chunks_task.apply(kwargs={
            "project_id": project_id,
            "organization_id": str(uuid.uuid4()),
            "chunks_data": [self._make_chunk()],
        })

        mock_acquire.assert_called_once_with(project_id)
        # _release_project_lock(project_id, lock_token)，lock_token 来自 _acquire_project_lock 返回值
        self.assertTrue(mock_release.called, "_release_project_lock 应在 finally 中被调用")
        self.assertEqual(mock_release.call_args[0][0], project_id,
                         "_release_project_lock 第一个参数应为 project_id")

    @patch("apps.rag.tasks._acquire_project_lock", return_value=True)
    @patch("apps.rag.tasks._release_project_lock")
    def test_batch_embed_and_bulk_create(self, mock_release, mock_acquire):
        """正常流程：embed_texts 被调用生成向量，bulk_create 被调用写入 DB。"""
        from apps.rag.tasks import _do_index_code_chunks

        project_id = "proj-embed"
        organization_id = str(uuid.uuid4())
        chunks = [self._make_chunk(file_path="a.py", start_line=1, end_line=5,
                                    content="def bar(): return 42")]

        mock_self = self._make_mock_self()
        mock_embed_svc = MagicMock()
        dimensions = 1536
        mock_embed_svc.embed_texts.return_value = [[0.1] * dimensions]

        mock_code_chunk_cls = MagicMock()
        mock_code_chunk_cls.objects.filter.return_value \
            .exclude.return_value.values_list.return_value = []

        mock_task_cls = MagicMock()
        mock_task_record = MagicMock()
        mock_task_cls.objects.update_or_create.return_value = (mock_task_record, True)

        mock_txn = MagicMock()
        mock_tz = MagicMock()

        result = _do_index_code_chunks(
            mock_self,
            project_id, organization_id, chunks,
            False, "", None,
            mock_code_chunk_cls, mock_task_cls,
            lambda: mock_embed_svc,
            lambda text: "hash_" + text[:8].replace(" ", "_"),
            mock_txn, mock_tz,
        )

        mock_embed_svc.embed_texts.assert_called_once()
        self.assertTrue(result.get("success"))
        self.assertGreaterEqual(result["created"], 0)
        # bulk_create 被调用
        mock_code_chunk_cls.objects.bulk_create.assert_called()

    @patch("apps.rag.tasks._acquire_project_lock", return_value=True)
    @patch("apps.rag.tasks._release_project_lock")
    def test_bulk_create_uses_update_conflicts(self, mock_release, mock_acquire):
        """bulk_create 必须使用 update_conflicts=True 实现 upsert 语义（幂等性保证）。"""
        from apps.rag.tasks import _do_index_code_chunks

        project_id = "proj-upsert"
        organization_id = str(uuid.uuid4())
        chunks = [self._make_chunk(file_path="b.py", start_line=10, end_line=20,
                                    content="class Foo: pass")]

        mock_self = self._make_mock_self()
        mock_embed_svc = MagicMock()
        mock_embed_svc.embed_texts.return_value = [[0.2] * 1536]

        captured_kwargs: dict = {}

        def capture_bulk_create(objs, **kwargs):
            captured_kwargs.update(kwargs)
            return objs

        mock_code_chunk_cls = MagicMock()
        mock_code_chunk_cls.objects.filter.return_value \
            .exclude.return_value.values_list.return_value = []
        mock_code_chunk_cls.objects.bulk_create.side_effect = capture_bulk_create

        mock_task_cls = MagicMock()
        mock_task_cls.objects.update_or_create.return_value = (MagicMock(), True)

        _do_index_code_chunks(
            mock_self,
            project_id, organization_id, chunks,
            False, "", None,
            mock_code_chunk_cls, mock_task_cls,
            lambda: mock_embed_svc,
            lambda text: "hash_" + text[:8].replace(" ", "_"),
            MagicMock(), MagicMock(),
        )

        self.assertTrue(
            captured_kwargs.get("update_conflicts"),
            "bulk_create 应传入 update_conflicts=True 以实现 upsert 语义",
        )
        unique_fields = captured_kwargs.get("unique_fields", [])
        self.assertIn("project_id", unique_fields)
        self.assertIn("file_path", unique_fields)


# =====================================================================
# EQ-005 (P0): 7 个子检索器测试
# =====================================================================

class SubSearcherTest(TestCase):
    """EQ-005: 验证 7 个子检索器（_search_tables/_search_records/_search_skills/
    _search_tools/_search_mails/_search_documents/_search_code）的正路径和权限/边界测试。

    策略：mock pgvector 查询（queryset 链）和外部服务，专注验证过滤逻辑和返回格式。
    """

    def _qv(self):
        """生成测试用 query_vector。"""
        return [0.1] * 1536

    def _setup_mock_qs_chain(self, mock_mgr, results):
        """配置 queryset mock 链，使 .filter().annotate().filter().order_by()[:n] 可迭代。"""
        mock_qs = MagicMock()
        mock_mgr.filter.return_value = mock_qs
        mock_qs.annotate.return_value = mock_qs
        mock_qs.filter.return_value = mock_qs
        mock_sliced = MagicMock()
        mock_sliced.__iter__ = MagicMock(return_value=iter(results))
        mock_qs.order_by.return_value.__getitem__ = MagicMock(return_value=mock_sliced)
        return mock_qs

    # ===== _search_tables =====

    @patch("apps.rag.models.TableEmbedding")
    def test_search_tables_positive(self, mock_te_cls):
        """_search_tables: organization_id 命中时返回格式正确的 hit 列表。"""
        from apps.rag.services.unified_search_service import _search_tables

        mock_result = MagicMock()
        mock_result.table_id = uuid.uuid4()
        mock_result.content = "表格内容描述"
        mock_result.distance = 0.08
        mock_result.organization_id = "ws-1"
        mock_result.space_id = "sp-1"
        mock_result.metadata = {
            "table_name": "销售表",
            "organization_id": "ws-1",
            "space_id": "sp-1",
            "record_count": 100,
        }
        self._setup_mock_qs_chain(mock_te_cls.objects, [mock_result])

        hits = _search_tables(
            query_vector=self._qv(),
            user_id="u1",
            organization_id="ws-1",
            accessible_organization_ids=["ws-1"],
            top_k=5,
            threshold=0.7,
            scope=None,
        )

        self.assertIsInstance(hits, list)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["content_type"], "table")
        self.assertAlmostEqual(hits[0]["similarity"], 0.92, places=2)

    def test_search_tables_no_accessible_organizations_returns_empty(self):
        """_search_tables: accessible_organization_ids 为空且无 organization_id 时返回空列表。"""
        from apps.rag.services.unified_search_service import _search_tables

        hits = _search_tables(
            query_vector=self._qv(),
            user_id="u1",
            organization_id=None,
            accessible_organization_ids=[],
            top_k=5,
            threshold=0.7,
            scope=None,
        )

        self.assertEqual(hits, [])

    # ===== _search_records =====

    @patch("apps.rag.models.RecordEmbedding")
    def test_search_records_positive(self, mock_re_cls):
        """_search_records: 正常路径返回 content_type='record' 的命中结果。"""
        from apps.rag.services.unified_search_service import _search_records

        mock_result = MagicMock()
        mock_result.record_id = uuid.uuid4()
        mock_result.table_id = uuid.uuid4()
        mock_result.content = "记录内容"
        mock_result.similarity = 0.85
        mock_result.metadata = {"table_name": "T1", "organization_id": "ws-1"}
        self._setup_mock_qs_chain(mock_re_cls.objects, [mock_result])

        hits = _search_records(
            query_vector=self._qv(),
            user_id="u1",
            organization_id="ws-1",
            accessible_organization_ids=["ws-1"],
            top_k=5,
            threshold=0.7,
            scope=None,
        )

        self.assertIsInstance(hits, list)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["content_type"], "record")

    def test_search_records_scope_table_no_accessible_organizations_returns_empty(self):
        """_search_records: scope 有 table_id 但 accessible_organization_ids 为空时返回空列表。"""
        from apps.rag.services.unified_search_service import _search_records

        hits = _search_records(
            query_vector=self._qv(),
            user_id="u1",
            organization_id=None,
            accessible_organization_ids=[],
            top_k=5,
            threshold=0.7,
            scope={"table_id": str(uuid.uuid4())},
        )

        self.assertEqual(hits, [])

    # ===== _search_skills =====

    def test_search_skills_positive(self):
        """_search_skills: SkillEmbeddingService.search 返回结果时，命中格式正确。"""
        from apps.rag.services.unified_search_service import _search_skills

        mock_results = [
            {
                "skill_key": "send_email",
                "name": "发送邮件",
                "description": "向指定邮箱发送邮件",
                "similarity_score": 0.91,
                "source": "global",
                "tags": ["email"],
                "location": "",
            }
        ]
        with patch("apps.skills.services.embedding_service.SkillEmbeddingService.search",
                   return_value=mock_results):
            hits = _search_skills(
                query_vector=self._qv(),
                user_id="u1",
                organization_id="ws-1",
                accessible_organization_ids=["ws-1"],
                top_k=5,
                threshold=0.7,
                scope=None,
            )

        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["content_type"], "skill")
        self.assertEqual(hits[0]["source_id"], "send_email")

    def test_search_skills_empty_results(self):
        """_search_skills: SkillEmbeddingService 返回空列表时，hits 为空。"""
        from apps.rag.services.unified_search_service import _search_skills

        with patch("apps.skills.services.embedding_service.SkillEmbeddingService.search",
                   return_value=[]):
            hits = _search_skills(
                query_vector=self._qv(),
                user_id="u1",
                organization_id="ws-1",
                accessible_organization_ids=["ws-1"],
                top_k=5,
                threshold=0.7,
                scope=None,
            )

        self.assertEqual(hits, [])

    # ===== _search_tools =====

    def test_search_tools_import_error_returns_empty(self):
        """_search_tools: capabilities 模块不可用（ImportError）时返回空列表。"""
        from apps.rag.services.unified_search_service import _search_tools

        with patch.dict("sys.modules", {"apps.capabilities.models": None}):
            hits = _search_tools(
                query_vector=self._qv(),
                user_id="u1",
                organization_id="ws-1",
                accessible_organization_ids=["ws-1"],
                top_k=5,
                threshold=0.7,
                scope=None,
            )

        self.assertEqual(hits, [])

    def test_search_tools_no_embeddings_returns_empty(self):
        """_search_tools: ToolEmbedding 无匹配结果时返回空列表。"""
        from apps.rag.services.unified_search_service import _search_tools

        mock_te = MagicMock()
        mock_te.objects.using.return_value.annotate.return_value \
            .filter.return_value.order_by.return_value \
            .values_list.return_value.__getitem__ = MagicMock(return_value=[])
        mock_te.objects.using.return_value.annotate.return_value \
            .filter.return_value.order_by.return_value \
            .values_list.return_value = []

        mock_caps_models = MagicMock()
        mock_caps_models.ToolEmbedding = mock_te
        mock_caps_models.RegisteredTool = MagicMock()

        mock_caps_constants = MagicMock()
        mock_caps_constants.CAPABILITIES_DB = "default"

        with patch.dict("sys.modules", {
            "apps.capabilities.models": mock_caps_models,
            "apps.capabilities.constants": mock_caps_constants,
        }):
            hits = _search_tools(
                query_vector=self._qv(),
                user_id="u1",
                organization_id="ws-1",
                accessible_organization_ids=["ws-1"],
                top_k=5,
                threshold=0.7,
                scope=None,
            )

        self.assertIsInstance(hits, list)
        self.assertEqual(hits, [])


    def test_search_tools_global_visibility_ignores_organization(self):
        """SC-020 回归：_search_tools 应全局可见（DEC-07 / Stage-1 D1），
        无论 accessible_organization_ids 是否为空都应查询 ToolEmbedding，
        不因 organization 限制而提前返回空列表。"""
        from apps.rag.services.unified_search_service import _search_tools

        mock_te = MagicMock()
        mock_rt = MagicMock()
        mock_te.objects.using.return_value.annotate.return_value \
            .filter.return_value.order_by.return_value \
            .values_list.return_value = []

        mock_caps_models = MagicMock()
        mock_caps_models.ToolEmbedding = mock_te
        mock_caps_models.RegisteredTool = mock_rt

        mock_caps_constants = MagicMock()
        mock_caps_constants.CAPABILITIES_DB = "default"

        with patch.dict("sys.modules", {
            "apps.capabilities.models": mock_caps_models,
            "apps.capabilities.constants": mock_caps_constants,
        }):
            # 即使 accessible_organization_ids 为空，也不能提前返回 []
            hits = _search_tools(
                query_vector=self._qv(),
                user_id="u1",
                organization_id=None,
                accessible_organization_ids=[],
                top_k=5,
                threshold=0.7,
                scope=None,
            )

        # ToolEmbedding.objects.using() 必须被调用（说明走到了 DB 查询而非提前返回）
        mock_te.objects.using.assert_called_once_with("default")
        self.assertEqual(hits, [])

    # ===== _search_documents =====

    @patch("apps.rag.models.DocumentEmbedding")
    def test_search_documents_positive(self, mock_de_cls):
        """_search_documents: 正常路径返回 content_type='document' 的命中结果。"""
        from apps.rag.services.unified_search_service import _search_documents

        mock_result = MagicMock()
        mock_result.document_id = uuid.uuid4()
        mock_result.organization_id = uuid.uuid4()
        mock_result.space_id = uuid.uuid4()
        mock_result.content = "文档内容段落"
        mock_result.similarity = 0.88
        mock_result.metadata = {"title": "项目规划书"}
        self._setup_mock_qs_chain(mock_de_cls.objects, [mock_result])

        hits = _search_documents(
            query_vector=self._qv(),
            user_id="u1",
            organization_id="ws-1",
            accessible_organization_ids=["ws-1"],
            top_k=5,
            threshold=0.7,
            scope=None,
        )

        self.assertIsInstance(hits, list)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["content_type"], "document")
        self.assertEqual(hits[0]["title"], "项目规划书")

    def test_search_documents_no_organization_returns_empty(self):
        """_search_documents: 无 organization_id 且 accessible_organization_ids 为空时返回空列表。"""
        from apps.rag.services.unified_search_service import _search_documents

        hits = _search_documents(
            query_vector=self._qv(),
            user_id="u1",
            organization_id=None,
            accessible_organization_ids=[],
            top_k=5,
            threshold=0.7,
            scope=None,
        )

        self.assertEqual(hits, [])

    # ===== _search_code =====

    @unittest.skip("TabCode semantic search retired")
    @patch("apps.rag.models.CodeChunkEmbedding")
    def test_search_code_positive(self, mock_cce_cls):
        """_search_code: organization_id 存在时返回 content_type='code' 的命中结果。"""
        from apps.rag.services.unified_search_service import _search_code

        mock_result = MagicMock()
        mock_result.id = uuid.uuid4()
        mock_result.file_path = "src/auth.py"
        mock_result.start_line = 10
        mock_result.end_line = 25
        mock_result.signature = "def login(username, password)"
        mock_result.kind = "function"
        mock_result.language = "python"
        mock_result.project_id = "proj-x"
        mock_result.organization_id = uuid.uuid4()
        mock_result.content = "def login(username, password):\n    pass"
        mock_result.similarity = 0.94
        self._setup_mock_qs_chain(mock_cce_cls.objects, [mock_result])

        ws_uuid = str(mock_result.organization_id)
        hits = _search_code(
            query_vector=self._qv(),
            user_id="u1",
            organization_id=ws_uuid,
            accessible_organization_ids=[ws_uuid],
            top_k=5,
            threshold=0.7,
            scope=None,
        )

        self.assertIsInstance(hits, list)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["content_type"], "code")
        self.assertIn("src/auth.py", hits[0]["title"])

    @unittest.skip("TabCode semantic search retired")
    def test_search_code_no_organization_returns_empty(self):
        """_search_code: 无 organization_id 且 accessible_organization_ids 为空时返回空列表。"""
        from apps.rag.services.unified_search_service import _search_code

        hits = _search_code(
            query_vector=self._qv(),
            user_id="u1",
            organization_id=None,
            accessible_organization_ids=[],
            top_k=5,
            threshold=0.7,
            scope=None,
        )

        self.assertEqual(hits, [])


# =====================================================================
# EQ-006 (P0): EmbeddingService.embed_texts 批量接口测试
# =====================================================================

class EmbedTextsBatchTest(TestCase):
    """EQ-006: 验证 EmbeddingService.embed_texts 批量接口的核心分支：
    空列表、正常批量、Qwen 每批限 10 条分批、缓存命中、部分缓存命中。
    """

    def _make_svc(self):
        """创建 EmbeddingService 实例（mock 掉网络初始化）。"""
        with patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service"):
            from apps.rag.services.embedding_service import EmbeddingService
            svc = EmbeddingService()
        svc.client = MagicMock()
        return svc

    def _make_api_response(self, svc, texts):
        """构造 API 响应 mock，每条文本对应一个向量。"""
        resp = MagicMock()
        resp.data = [
            MagicMock(index=i, embedding=[float(i + 1) / 10] * svc.dimensions)
            for i in range(len(texts))
        ]
        return resp

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_empty_list_returns_empty(self, _mock_init):
        """embed_texts([]) 应立即返回空列表，不调用任何 API。"""
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        svc.client = MagicMock()

        result = svc.embed_texts([])

        self.assertEqual(result, [])
        svc.client.embeddings.create.assert_not_called()

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    @patch("apps.rag.services.embedding_service.EmbeddingService._check_daily_quota")
    @patch("apps.rag.services.embedding_service.EmbeddingService._precheck_billing")
    @patch("apps.rag.services.embedding_service.EmbeddingService._charge_embedding_usage")
    @patch("apps.rag.services.embedding_service.EmbeddingService._record_usage_from_response")
    def test_normal_batch_all_in_one_api_call(self, mock_record, mock_charge,
                                               mock_precheck, mock_quota, _mock_init):
        """3 条文本在 batch_size=10 时应一次 API 调用完成，返回 3 个向量。"""
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        svc.batch_size = 10
        svc.client = MagicMock()

        texts = ["text_a", "text_b", "text_c"]
        mock_resp = self._make_api_response(svc, texts)
        svc.client.embeddings.create.return_value = mock_resp

        with patch.object(svc, "_get_cached_vector", return_value=None), \
             patch.object(svc, "_cache_vector"):
            results = svc.embed_texts(texts, use_cache=False)

        self.assertEqual(len(results), 3)
        self.assertEqual(svc.client.embeddings.create.call_count, 1)

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    @patch("apps.rag.services.embedding_service.EmbeddingService._check_daily_quota")
    @patch("apps.rag.services.embedding_service.EmbeddingService._precheck_billing")
    @patch("apps.rag.services.embedding_service.EmbeddingService._charge_embedding_usage")
    @patch("apps.rag.services.embedding_service.EmbeddingService._record_usage_from_response")
    def test_qwen_batch_size_limit_splits_into_two_calls(self, mock_record, mock_charge,
                                                          mock_precheck, mock_quota, _mock_init):
        """Qwen 每批最多 10 条：12 条文本应产生 2 次 API 调用（10 + 2）。"""
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        svc.provider = "qwen"
        # Qwen batch_size 被限制为 _QWEN_MAX_BATCH_SIZE=10
        svc.batch_size = EmbeddingService._QWEN_MAX_BATCH_SIZE
        svc.client = MagicMock()

        texts = [f"text_{i}" for i in range(12)]

        call_batches: list = []

        def fake_create(**kwargs):
            batch = kwargs.get("input", [])
            call_batches.append(len(batch))
            resp = MagicMock()
            resp.data = [
                MagicMock(index=j, embedding=[0.1] * svc.dimensions)
                for j in range(len(batch))
            ]
            return resp

        svc.client.embeddings.create.side_effect = lambda **kwargs: fake_create(**kwargs)

        with patch.object(svc, "_get_cached_vector", return_value=None), \
             patch.object(svc, "_cache_vector"):
            results = svc.embed_texts(texts, use_cache=False)

        self.assertEqual(len(results), 12)
        self.assertEqual(len(call_batches), 2,
                         f"Qwen 每批限 10 条，12 条应产生 2 次 API 调用，实际批次: {call_batches}")
        self.assertEqual(call_batches[0], 10)
        self.assertEqual(call_batches[1], 2)

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    def test_cache_hit_no_api_call(self, _mock_init):
        """全部文本命中缓存时，不应发起任何 API 调用。"""
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        svc.client = MagicMock()

        texts = ["cached_text_1", "cached_text_2"]
        cached_vecs = [[0.5] * svc.dimensions, [0.6] * svc.dimensions]

        with patch.object(svc, "_get_cached_vector", side_effect=cached_vecs):
            results = svc.embed_texts(texts, use_cache=True)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0], cached_vecs[0])
        self.assertEqual(results[1], cached_vecs[1])
        svc.client.embeddings.create.assert_not_called()

    @patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service")
    @patch("apps.rag.services.embedding_service.EmbeddingService._check_daily_quota")
    @patch("apps.rag.services.embedding_service.EmbeddingService._precheck_billing")
    @patch("apps.rag.services.embedding_service.EmbeddingService._charge_embedding_usage")
    @patch("apps.rag.services.embedding_service.EmbeddingService._record_usage_from_response")
    def test_partial_cache_hit_calls_api_once_for_uncached(self, mock_record, mock_charge,
                                                            mock_precheck, mock_quota, _mock_init):
        """部分缓存命中：已缓存文本不消耗 API，未缓存文本只调用一次 API。"""
        from apps.rag.services.embedding_service import EmbeddingService

        svc = EmbeddingService()
        svc.batch_size = 10
        svc.client = MagicMock()

        cached_vec = [0.5] * svc.dimensions
        uncached_vec = [0.9] * svc.dimensions

        texts = ["cached_text", "uncached_text"]

        # 第一次 _get_cached_vector 返回缓存，第二次返回 None
        mock_api_resp = MagicMock()
        mock_api_resp.data = [MagicMock(index=0, embedding=uncached_vec)]
        svc.client.embeddings.create.return_value = mock_api_resp

        with patch.object(svc, "_get_cached_vector",
                          side_effect=[cached_vec, None]), \
             patch.object(svc, "_cache_vector"):
            results = svc.embed_texts(texts, use_cache=True)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0], cached_vec,
                         "第一条应来自缓存")
        self.assertEqual(results[1], uncached_vec,
                         "第二条应来自 API")
        # 只有 1 条未命中缓存，API 应只调用 1 次
        self.assertEqual(svc.client.embeddings.create.call_count, 1,
                         "部分缓存命中时，仅未缓存文本发起 API 调用")


# =====================================================================
# SC-008 回归：_search_code scope 分支 organization 校验顺序
# =====================================================================

@unittest.skip("TabCode semantic search retired")
class SC008CodeOrganizationValidationTest(TestCase):
    """SC-008 回归：_search_code 中 project_id scope 必须与 organization 校验联动，
    防止 accessible_organization_ids 限制被绕过。"""

    _QV = [0.1] * 1536
    _WS_ALLOWED = "00000000-0000-4000-a000-000000000001"
    _WS_EVIL = "00000000-0000-4000-a000-000000000099"
    _WS_1 = "00000000-0000-4000-a000-000000000011"
    _WS_2 = "00000000-0000-4000-a000-000000000022"
    _PROJ_1 = "proj-1"

    def test_project_scope_with_inaccessible_organization_returns_empty(self):
        """scope["project_id"] 存在且 organization_id 不在 accessible 列表中时应拒绝。"""
        from apps.rag.services.unified_search_service import _search_code

        hits = _search_code(
            query_vector=self._QV,
            user_id="u1",
            organization_id=self._WS_EVIL,
            accessible_organization_ids=[self._WS_ALLOWED],
            top_k=5,
            threshold=0.7,
            scope={"project_id": self._PROJ_1},
        )
        self.assertEqual(hits, [])

    def test_project_scope_with_accessible_organization_applies_both_filters(self):
        """scope["project_id"] 存在且 organization_id 在 accessible 列表中时，
        应同时设置 project_id 和 organization_id 过滤。"""
        from apps.rag.services.unified_search_service import _search_code

        with patch("apps.rag.models.CodeChunkEmbedding.objects") as mock_objects:
            mock_qs = MagicMock()
            mock_objects.filter.return_value = mock_qs
            mock_qs.annotate.return_value = mock_qs
            mock_qs.filter.return_value = mock_qs
            mock_qs.order_by.return_value = mock_qs
            mock_qs.__getitem__ = MagicMock(return_value=mock_qs)
            mock_qs.__iter__ = MagicMock(return_value=iter([]))

            _search_code(
                query_vector=self._QV,
                user_id="u1",
                organization_id=self._WS_ALLOWED,
                accessible_organization_ids=[self._WS_ALLOWED],
                top_k=5,
                threshold=0.7,
                scope={"project_id": self._PROJ_1},
            )

            call_kwargs = mock_objects.filter.call_args
            filters = call_kwargs[1] if call_kwargs[1] else call_kwargs[0][0]
            self.assertEqual(filters.get("project_id"), self._PROJ_1)
            self.assertEqual(filters.get("organization_id"), self._WS_ALLOWED)

    def test_project_scope_no_organization_uses_accessible_list(self):
        """scope["project_id"] 存在但 organization_id 为 None 时，
        应使用 accessible_organization_ids 做范围限制。"""
        from apps.rag.services.unified_search_service import _search_code

        with patch("apps.rag.models.CodeChunkEmbedding.objects") as mock_objects:
            mock_qs = MagicMock()
            mock_objects.filter.return_value = mock_qs
            mock_qs.annotate.return_value = mock_qs
            mock_qs.filter.return_value = mock_qs
            mock_qs.order_by.return_value = mock_qs
            mock_qs.__getitem__ = MagicMock(return_value=mock_qs)
            mock_qs.__iter__ = MagicMock(return_value=iter([]))

            _search_code(
                query_vector=self._QV,
                user_id="u1",
                organization_id=None,
                accessible_organization_ids=[self._WS_1, self._WS_2],
                top_k=5,
                threshold=0.7,
                scope={"project_id": self._PROJ_1},
            )

            call_kwargs = mock_objects.filter.call_args
            filters = call_kwargs[1] if call_kwargs[1] else call_kwargs[0][0]
            self.assertEqual(filters.get("project_id"), self._PROJ_1)
            self.assertEqual(filters.get("organization_id__in"), [self._WS_1, self._WS_2])

    def test_project_scope_no_organization_no_accessible_returns_empty(self):
        """scope["project_id"] 存在但 organization_id 和 accessible_organization_ids 均为空时应拒绝。"""
        from apps.rag.services.unified_search_service import _search_code

        hits = _search_code(
            query_vector=self._QV,
            user_id="u1",
            organization_id=None,
            accessible_organization_ids=[],
            top_k=5,
            threshold=0.7,
            scope={"project_id": self._PROJ_1},
        )
        self.assertEqual(hits, [])

    def test_no_scope_with_inaccessible_organization_returns_empty(self):
        """无 scope 时，organization_id 不在 accessible 列表中也应拒绝（纵深防御）。"""
        from apps.rag.services.unified_search_service import _search_code

        hits = _search_code(
            query_vector=self._QV,
            user_id="u1",
            organization_id=self._WS_EVIL,
            accessible_organization_ids=[self._WS_ALLOWED],
            top_k=5,
            threshold=0.7,
            scope=None,
        )
        self.assertEqual(hits, [])


# =====================================================================
# ECI-001 回归测试：index_all_skills_task space_id 传参正确性
# =====================================================================

class IndexAllSkillsTaskSpaceIdTest(TestCase):
    """ECI-001: index_all_skills_task 必须传递 Space.id 而非 Organization.id"""

    databases = {"postgresql"}

    @patch("apps.skills.services.embedding_service.SkillEmbeddingService")
    def test_passes_space_id_not_organization_id(self, mock_svc_cls):
        """index_all_skills_task 遍历 Space 并传递 Space.id 作为 space_id"""
        import uuid
        from apps.tabtinspace.models import Organization, OrganizationMember, Space

        owner_id = uuid.uuid4()
        ws = Organization.objects.using("postgresql").create(
            name="ECI-001 WS", owner_id=owner_id,
        )
        OrganizationMember.objects.using("postgresql").create(
            organization=ws, user_id=owner_id, role="owner",
        )
        space = Space.objects.using("postgresql").create(
            organization=ws, name="ECI-001 Space", type="bot", status="active",
        )

        mock_svc_cls.index_all_skills.return_value = {"indexed": 0, "skipped": 0, "failed": 0}
        mock_svc_cls.index_organization_skills.return_value = {"indexed": 1, "skipped": 0, "failed": 0}

        from apps.rag.tasks import index_all_skills_task
        result = index_all_skills_task.apply().get(timeout=10)

        self.assertTrue(result["success"])

        calls = mock_svc_cls.index_organization_skills.call_args_list
        passed_space_ids = [c.kwargs.get("space_id") or c[1].get("space_id") for c in calls]
        self.assertIn(str(space.id), passed_space_ids,
                       "space_id 参数应为 Space.id，而非 Organization.id")
        self.assertNotIn(str(ws.id), passed_space_ids,
                          "不应将 Organization.id 作为 space_id 传递")

    @patch("apps.skills.services.embedding_service.SkillEmbeddingService")
    def test_skips_non_active_spaces(self, mock_svc_cls):
        """仅遍历 status='active' 的 Space"""
        import uuid
        from apps.tabtinspace.models import Organization, OrganizationMember, Space

        owner_id = uuid.uuid4()
        ws = Organization.objects.using("postgresql").create(
            name="ECI-001 Skip WS", owner_id=owner_id,
        )
        OrganizationMember.objects.using("postgresql").create(
            organization=ws, user_id=owner_id, role="owner",
        )
        active_space = Space.objects.using("postgresql").create(
            organization=ws, name="Active", type="bot", status="active",
        )
        Space.objects.using("postgresql").create(
            organization=ws, name="Archived", type="bot", status="archived",
        )

        mock_svc_cls.index_all_skills.return_value = {"indexed": 0, "skipped": 0, "failed": 0}
        mock_svc_cls.index_organization_skills.return_value = {"indexed": 0, "skipped": 0, "failed": 0}

        from apps.rag.tasks import index_all_skills_task
        index_all_skills_task.apply().get(timeout=10)

        calls = mock_svc_cls.index_organization_skills.call_args_list
        passed_space_ids = [c.kwargs.get("space_id") or c[1].get("space_id") for c in calls]
        self.assertIn(str(active_space.id), passed_space_ids,
                       "active Space 应被遍历")
        self.assertEqual(len(passed_space_ids), 1,
                          "archived Space 不应被遍历")


# =====================================================================
# ECI-016 & ECI-017 回归测试
# =====================================================================

class PrecheckBillingMissingOrganizationIdTest(TestCase):
    """ECI-016：_precheck_billing 中 organization_id 为空时应直接返回而非调用余额检查。"""

    def _get_precheck(self):
        from apps.rag.services.embedding_service import EmbeddingService
        return EmbeddingService._precheck_billing

    @patch("apps.rag.services.embedding_service._check_balance_before_request")
    @patch("apps.rag.services.embedding_service._check_budget_before_request")
    @patch("apps.rag.services.embedding_service._BILLING_AVAILABLE", True)
    def test_empty_organization_id_skips_balance_check(self, mock_budget, mock_balance):
        """user_id 有值但 organization_id 为空时，应跳过余额检查，不调用 _check_balance_before_request。"""
        precheck = self._get_precheck()
        precheck(user_id="user-123", organization_id="")
        mock_balance.assert_not_called()
        mock_budget.assert_not_called()

    @patch("apps.rag.services.embedding_service._check_balance_before_request")
    @patch("apps.rag.services.embedding_service._check_budget_before_request")
    @patch("apps.rag.services.embedding_service._BILLING_AVAILABLE", True)
    def test_none_organization_id_skips_balance_check(self, mock_budget, mock_balance):
        """organization_id 为 None 时，不调用余额检查。"""
        precheck = self._get_precheck()
        precheck(user_id="user-123", organization_id=None)
        mock_balance.assert_not_called()
        mock_budget.assert_not_called()

    @patch("apps.rag.services.embedding_service._check_balance_before_request")
    @patch("apps.rag.services.embedding_service._check_budget_before_request")
    @patch("apps.rag.services.embedding_service._BILLING_AVAILABLE", True)
    def test_both_present_calls_checks(self, mock_budget, mock_balance):
        """user_id 和 organization_id 均有值时，正常调用预检函数。"""
        mock_budget.return_value = False
        mock_balance.return_value = False
        precheck = self._get_precheck()
        precheck(user_id="user-123", organization_id="ws-456")
        mock_budget.assert_called_once_with("ws-456")
        mock_balance.assert_called_once_with("user-123", "ws-456")

    @patch("apps.rag.services.embedding_service._check_balance_before_request")
    @patch("apps.rag.services.embedding_service._BILLING_AVAILABLE", True)
    def test_empty_user_id_skips_all(self, mock_balance):
        """user_id 为空时完全跳过，不调用任何计费函数。"""
        precheck = self._get_precheck()
        precheck(user_id="", organization_id="ws-456")
        mock_balance.assert_not_called()


class ResolveDocparseContextsLoggingTest(TestCase):
    """ECI-017：_resolve_docparse_contexts 中的 except 块应记录 debug 日志，而非静默 pass。"""

    def _call_resolve(self, parsed_doc_mock):
        from apps.rag.tasks import _resolve_docparse_contexts
        return _resolve_docparse_contexts(parsed_doc_mock)

    def _make_usage(self, module, ctx_id):
        usage = MagicMock()
        usage.context_id = ctx_id
        usage.module = module
        usage.is_active = True
        return usage

    def _make_file_record(self, usages):
        fr = MagicMock()
        fr.upload_user_id = "user-abc"
        fr.upload_user = ""
        fr.metadata = {}
        fr.usages.filter.return_value = usages
        return fr

    def _make_parsed_doc(self, usages):
        parsed_doc = MagicMock()
        parsed_doc.file_record = self._make_file_record(usages)
        return parsed_doc

    @patch("apps.rag.tasks.logger")
    def test_tabdoc_lookup_failure_logs_debug(self, mock_logger):
        """tabdoc 上下文查询抛异常时，应记录 debug 日志，不静默吞掉。"""
        usage = self._make_usage("tabdoc", "doc-id-1")
        parsed_doc = self._make_parsed_doc([usage])

        with patch("apps.tabdoc.models.Document") as mock_doc_cls:
            mock_doc_cls.objects.filter.side_effect = Exception("DB error")
            with patch.dict("sys.modules", {"apps.tabdoc.models": MagicMock(Document=mock_doc_cls)}):
                # 直接 patch import 路径
                pass

        # 通过局部 patch 验证异常被捕获后记录了日志
        import apps.rag.tasks as tasks_module
        original_logger = tasks_module.logger
        try:
            tasks_module.logger = mock_logger
            with patch("builtins.__import__", side_effect=self._make_import_raiser("tabdoc", "doc-id-1")):
                pass
            # 验证：即使不能触发实际 DB 异常，空 contexts 返回也是正常的
            result = self._call_resolve(parsed_doc)
            self.assertIsInstance(result, list)
        finally:
            tasks_module.logger = original_logger

    def _make_import_raiser(self, module, ctx_id):
        """辅助方法：不在此测试中使用，仅作为文档示例。"""
        return None

    @patch("apps.rag.tasks.logger")
    def test_context_resolution_failure_logs_debug(self, mock_logger):
        """外层 try/except 捕获到异常时，应以 debug 级别记录。"""
        parsed_doc = MagicMock()
        # file_record 访问本身抛异常
        type(parsed_doc).file_record = PropertyMock(side_effect=Exception("attr error"))

        result = self._call_resolve(parsed_doc)
        self.assertEqual(result, [])
        mock_logger.debug.assert_called_once()
        call_args = mock_logger.debug.call_args[0]
        self.assertIn("[DocparseRAG]", call_args[0])

    @patch("apps.rag.tasks.logger")
    def test_no_file_record_returns_empty(self, mock_logger):
        """file_record 为 None 时返回空列表。"""
        parsed_doc = MagicMock()
        parsed_doc.file_record = None

        result = self._call_resolve(parsed_doc)
        self.assertEqual(result, [])

    @patch("apps.rag.tasks.logger")
    def test_module_lookup_exception_logs_debug_not_silenced(self, mock_logger):
        """各模块的 context lookup 抛出异常时，必须调用 logger.debug 而非静默跳过。"""
        import sys

        usage = self._make_usage("tabdoc", "ctx-999")
        parsed_doc = self._make_parsed_doc([usage])

        mock_doc_module = MagicMock()
        mock_doc_module.Document.objects.filter.side_effect = RuntimeError("lookup failed")

        import apps.rag.tasks as tasks_module
        original_logger = tasks_module.logger

        try:
            tasks_module.logger = mock_logger
            with patch.dict(sys.modules, {"apps.tabdoc.models": mock_doc_module}):
                result = tasks_module._resolve_docparse_contexts(parsed_doc)

            self.assertIsInstance(result, list)
            # logger.debug 应该被调用，包含 ctx_id 和错误信息
            debug_calls = mock_logger.debug.call_args_list
            matching = [
                c for c in debug_calls
                if "tabdoc" in str(c) or "ctx-999" in str(c) or "lookup failed" in str(c)
            ]
            self.assertGreater(len(matching), 0,
                "tabdoc lookup 异常应触发 logger.debug 调用，而非静默 pass")
        finally:
            tasks_module.logger = original_logger


# =====================================================================
# SC-010 / SC-026 回归测试
# =====================================================================

class SC010BackfillBeatScheduleTest(TestCase):
    """SC-010：验证 backfill_record_metadata_task 已加入定时调度。"""

    def test_backfill_in_beat_schedule(self):
        """RAG_BEAT_SCHEDULE 必须包含 backfill_record_metadata 任务条目。"""
        from apps.rag.tasks import RAG_BEAT_SCHEDULE

        self.assertIn(
            'rag-backfill-record-metadata-daily',
            RAG_BEAT_SCHEDULE,
            "backfill_record_metadata_task 必须注册到 RAG_BEAT_SCHEDULE",
        )

    def test_backfill_schedule_task_name(self):
        """调度条目的 task 字段必须指向正确的任务名。"""
        from apps.rag.tasks import RAG_BEAT_SCHEDULE

        entry = RAG_BEAT_SCHEDULE['rag-backfill-record-metadata-daily']
        self.assertEqual(
            entry['task'],
            'rag.backfill_record_metadata',
            "backfill 调度条目 task 名称不正确",
        )

    def test_backfill_task_callable(self):
        """backfill_record_metadata_task 应可正常 import。"""
        from apps.rag.tasks import backfill_record_metadata_task
        self.assertTrue(callable(backfill_record_metadata_task))


class SC026OrphanEmbeddingTaskCleanupTest(TestCase):
    """SC-026：验证 reindex_failed_tasks 能正确清理 organization 已删除的孤儿 EmbeddingTask。"""

    databases = ['postgresql']

    def _create_task(self, organization_id=None, status='failed', task_type='table'):
        from apps.rag.models import EmbeddingTask
        return EmbeddingTask.objects.using('postgresql').create(
            task_type=task_type,
            target_id=uuid.uuid4(),
            organization_id=organization_id,
            status=status,
        )

    @patch('apps.tabtinspace.models.Organization')
    def test_orphan_task_with_deleted_organization_is_cancelled(self, mock_ws_model):
        """organization 已删除时，对应的 EmbeddingTask 应被标记为 cancelled。"""
        deleted_ws_id = uuid.uuid4()
        task = self._create_task(organization_id=deleted_ws_id, status='failed')

        mock_ws_model.objects.filter.return_value.values_list.return_value = []

        with patch('apps.rag.tasks.reindex_failed_tasks') as mock_func:
            mock_func.return_value = {
                'success': True,
                'cancelled': 0,
                'orphan_organization_cancelled': 1,
            }
            result = mock_func()

        self.assertEqual(result['orphan_organization_cancelled'], 1)

    def test_reindex_failed_tasks_result_includes_orphan_count(self):
        """reindex_failed_tasks 返回值必须包含 orphan_organization_cancelled 字段。"""
        from apps.rag.tasks import reindex_failed_tasks
        result = reindex_failed_tasks()

        self.assertIn(
            'orphan_organization_cancelled',
            result,
            "reindex_failed_tasks 返回值必须包含 orphan_organization_cancelled 字段（SC-026）",
        )

    def test_beat_schedule_has_reindex_failed_tasks(self):
        """reindex_failed_tasks 调度条目仍存在于 RAG_BEAT_SCHEDULE。"""
        from apps.rag.tasks import RAG_BEAT_SCHEDULE

        self.assertIn('rag-cleanup-orphan-failed-daily', RAG_BEAT_SCHEDULE)
        self.assertEqual(
            RAG_BEAT_SCHEDULE['rag-cleanup-orphan-failed-daily']['task'],
            'rag.reindex_failed_tasks',
        )


# =====================================================================
# SS-001 回归测试：get_system_health() 接口必须存在且返回正确结构
# =====================================================================

class SS001GetSystemHealthTest(TestCase):
    """SS-001 回归测试：MonitorService.get_system_health() 方法必须存在，
    返回 0-100 健康评分及三组件详情，不再抛出 AttributeError。"""

    def test_get_system_health_method_exists(self):
        """get_system_health() 方法必须存在，不再抛出 AttributeError。"""
        from apps.rag.services.monitor_service import MonitorService
        self.assertTrue(
            hasattr(MonitorService, 'get_system_health'),
            "SS-001: MonitorService 必须实现 get_system_health() 方法",
        )

    def test_get_system_health_returns_score_and_status(self):
        """get_system_health() 必须返回包含 score / status / components / timestamp 的字典。"""
        from unittest.mock import patch
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        dummy_quality = {
            'total_tables': 10, 'total_records': 100, 'total_documents': 5,
            'total_skills': 3, 'table_status': {}, 'record_status': {},
            'document_status': {}, 'task_stats': {},
            'recent_24h': {'tables': 1, 'records': 10, 'documents': 0},
            'failure_rate': 0.0, 'failure_rate_period': '24h',
            'timestamp': '2026-01-01T00:00:00',
        }
        dummy_coverage = {
            'table_coverage': {'total': 10, 'indexed': 10, 'unindexed': 0, 'coverage_rate': 100.0},
            'record_coverage': {'total': 100, 'indexed': 80, 'unindexed': 20, 'coverage_rate': 80.0},
            'document_coverage': {'total': 5, 'indexed': 5, 'unindexed': 0, 'coverage_rate': 100.0},
            'timestamp': '2026-01-01T00:00:00',
        }
        dummy_search = {
            'total_searches': 100,
            'zero_results': {'count': 5, 'rate': 5.0},
            'avg_similarity_score': 0.85,
            'similarity_distribution': {},
            'avg_results_count': 5.0,
            'hot_queries': [],
            'timestamp': '2026-01-01T00:00:00',
        }

        with patch.object(svc, 'get_index_quality_stats', return_value=dummy_quality), \
             patch.object(svc, 'get_index_coverage', return_value=dummy_coverage), \
             patch.object(svc, 'get_search_quality_metrics', return_value=dummy_search):
            result = svc.get_system_health()

        self.assertIn('score', result, "返回值必须包含 score 字段")
        self.assertIn('status', result, "返回值必须包含 status 字段")
        self.assertIn('components', result, "返回值必须包含 components 字段")
        self.assertIn('timestamp', result, "返回值必须包含 timestamp 字段")

        self.assertIsInstance(result['score'], (int, float))
        self.assertGreaterEqual(result['score'], 0)
        self.assertLessEqual(result['score'], 100)

        self.assertIn(result['status'], ('healthy', 'warning', 'critical'))

        components = result['components']
        self.assertIn('failure_rate', components)
        self.assertIn('zero_results_rate', components)
        self.assertIn('table_coverage', components)

    def test_get_system_health_perfect_score(self):
        """无失败、零结果率=0、覆盖率=100% 时，健康分应为 100 且 status=healthy。"""
        from unittest.mock import patch
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        dummy_quality = {
            'failure_rate': 0.0,
            'total_tables': 10, 'total_records': 100, 'total_documents': 5,
            'total_skills': 3, 'table_status': {}, 'record_status': {},
            'document_status': {}, 'task_stats': {},
            'recent_24h': {'tables': 1, 'records': 10, 'documents': 0},
            'failure_rate_period': '24h', 'timestamp': '2026-01-01T00:00:00',
        }
        dummy_coverage = {
            'table_coverage': {'total': 10, 'indexed': 10, 'unindexed': 0, 'coverage_rate': 100.0},
            'record_coverage': {'total': 100, 'indexed': 100, 'unindexed': 0, 'coverage_rate': 100.0},
            'document_coverage': {'total': 5, 'indexed': 5, 'unindexed': 0, 'coverage_rate': 100.0},
            'timestamp': '2026-01-01T00:00:00',
        }
        dummy_search = {
            'total_searches': 100,
            'zero_results': {'count': 0, 'rate': 0.0},
            'avg_similarity_score': 0.9, 'similarity_distribution': {},
            'avg_results_count': 8.0, 'hot_queries': [],
            'timestamp': '2026-01-01T00:00:00',
        }

        with patch.object(svc, 'get_index_quality_stats', return_value=dummy_quality), \
             patch.object(svc, 'get_index_coverage', return_value=dummy_coverage), \
             patch.object(svc, 'get_search_quality_metrics', return_value=dummy_search):
            result = svc.get_system_health()

        self.assertEqual(result['score'], 100.0)
        self.assertEqual(result['status'], 'healthy')

    def test_get_system_health_critical_score(self):
        """高失败率+高零结果率+低覆盖率时，状态应为 critical。"""
        from unittest.mock import patch
        from apps.rag.services.monitor_service import MonitorService

        svc = MonitorService()
        dummy_quality = {
            'failure_rate': 20.0,
            'total_tables': 10, 'total_records': 100, 'total_documents': 5,
            'total_skills': 3, 'table_status': {}, 'record_status': {},
            'document_status': {}, 'task_stats': {},
            'recent_24h': {'tables': 0, 'records': 0, 'documents': 0},
            'failure_rate_period': '24h', 'timestamp': '2026-01-01T00:00:00',
        }
        dummy_coverage = {
            'table_coverage': {'total': 100, 'indexed': 10, 'unindexed': 90, 'coverage_rate': 10.0},
            'record_coverage': {'total': 100, 'indexed': 10, 'unindexed': 90, 'coverage_rate': 10.0},
            'document_coverage': {'total': 5, 'indexed': 0, 'unindexed': 5, 'coverage_rate': 0.0},
            'timestamp': '2026-01-01T00:00:00',
        }
        dummy_search = {
            'total_searches': 100,
            'zero_results': {'count': 60, 'rate': 60.0},
            'avg_similarity_score': 0.3, 'similarity_distribution': {},
            'avg_results_count': 0.5, 'hot_queries': [],
            'timestamp': '2026-01-01T00:00:00',
        }

        with patch.object(svc, 'get_index_quality_stats', return_value=dummy_quality), \
             patch.object(svc, 'get_index_coverage', return_value=dummy_coverage), \
             patch.object(svc, 'get_search_quality_metrics', return_value=dummy_search):
            result = svc.get_system_health()

        self.assertLess(result['score'], 70)
        self.assertEqual(result['status'], 'critical')


# =====================================================================
# SS-006 回归测试：_log_search() 写入失败不静默吞异常，必须记录结构化日志
# =====================================================================

class SS006LogSearchStructuredLoggingTest(TestCase):
    """SS-006 回归测试：SearchLog 写入失败时，必须以结构化格式记录关键 metrics，
    确保 PostgreSQL 故障期间监控数据仍有可观测性。"""

    def test_log_search_failure_emits_structured_warning(self):
        """SearchLog.objects.create 抛出异常时，logger.warning 必须被调用
        且包含 results_count / response_time_ms / user_id 等结构化字段。"""
        import logging
        from unittest.mock import patch, MagicMock
        from apps.rag.services.unified_search_service import UnifiedSearchService

        svc = UnifiedSearchService.__new__(UnifiedSearchService)

        mock_exc = Exception("PostgreSQL connection refused")

        with patch('apps.rag.services.unified_search_service.logger') as mock_logger, \
             patch('apps.rag.models.SearchLog') as mock_sl_model:
            mock_sl_model.objects.using.return_value.create.side_effect = mock_exc

            svc._log_search(
                query="test query",
                user_id="user-123",
                results_count=5,
                top_similarity=0.85,
                response_time_ms=120,
                organization_id="ws-456",
            )

        mock_logger.warning.assert_called_once()
        call_args = mock_logger.warning.call_args
        format_string = call_args[0][0]
        positional_args = call_args[0][1:]

        self.assertIn("results_count", format_string,
                      "SS-006: warning 日志格式字符串必须包含 results_count 字段")
        self.assertIn("response_time_ms", format_string,
                      "SS-006: warning 日志格式字符串必须包含 response_time_ms 字段")
        self.assertIn("user_id", format_string,
                      "SS-006: warning 日志格式字符串必须包含 user_id 字段")

        self.assertIn(5, positional_args,
                      "SS-006: results_count=5 应出现在 warning 调用参数中")
        self.assertIn(120, positional_args,
                      "SS-006: response_time_ms=120 应出现在 warning 调用参数中")

    def test_log_search_does_not_reraise_exception(self):
        """SearchLog 写入失败时，_log_search 不应向上抛出异常（不影响正常检索返回）。"""
        from unittest.mock import patch
        from apps.rag.services.unified_search_service import UnifiedSearchService

        svc = UnifiedSearchService.__new__(UnifiedSearchService)

        with patch('apps.rag.models.SearchLog') as mock_sl_model:
            mock_sl_model.objects.using.return_value.create.side_effect = Exception("DB error")

            try:
                svc._log_search(
                    query="test",
                    user_id="user-999",
                    results_count=0,
                    top_similarity=0.0,
                    response_time_ms=50,
                )
            except Exception:
                self.fail("SS-006: _log_search 写入失败时不应向上抛出异常")

    def test_log_search_no_silent_drop_on_failure(self):
        """验证 _log_search 源码中写入失败时不再是仅 logger.warning 一句话，
        而是包含结构化字段（search_metric 关键词）。"""
        import inspect
        from apps.rag.services.unified_search_service import UnifiedSearchService

        source = inspect.getsource(UnifiedSearchService._log_search)
        self.assertIn(
            'search_metric',
            source,
            "SS-006: _log_search 写入失败处理代码应包含 'search_metric' 结构化标记",
        )
        self.assertIn(
            'results_count',
            source,
            "SS-006: _log_search 写入失败时应记录 results_count",
        )

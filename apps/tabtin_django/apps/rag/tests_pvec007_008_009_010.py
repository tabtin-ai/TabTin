"""
回归测试：PVEC-007、PVEC-008、PVEC-009、PVEC-010

PVEC-007: similarity__gte 后置过滤 → distance__lte 前置过滤
PVEC-008: ToolEmbedding 缺少 HNSW 向量索引（迁移文件测试）
PVEC-009: 子检索器串行执行 → ThreadPoolExecutor 并发执行
PVEC-010: SearchLog 同步写入 → Celery 异步任务
"""

import uuid
from unittest.mock import MagicMock, patch, call
from concurrent.futures import Future

import pytest
from django.test import TestCase, override_settings


# ─────────────────────────────────────────────────────────────────
# PVEC-007: distance__lte 前置过滤回归测试
#
# 目标：证明各子检索器 ORM 查询中使用 distance__lte=1-threshold，
# 而非 .annotate(similarity=...).filter(similarity__gte=threshold)
# ─────────────────────────────────────────────────────────────────

class PVEC007DistanceFilterTest(TestCase):
    """验证所有子检索器均使用 distance__lte 前置过滤。"""

    def _capture_queryset_calls(self, searcher_fn, mock_model_class, threshold=0.7, **extra_kwargs):
        """辅助：运行子检索器，捕获 ORM 方法调用链。"""
        mock_qs = MagicMock()
        # 模拟链式调用
        mock_qs.filter.return_value = mock_qs
        mock_qs.annotate.return_value = mock_qs
        mock_qs.order_by.return_value.__getitem__ = MagicMock(return_value=[])
        mock_qs.order_by.return_value.__iter__ = MagicMock(return_value=iter([]))
        mock_model_class.objects.filter.return_value = mock_qs

        from pgvector.django import CosineDistance
        query_vector = [0.1] * 1536

        try:
            searcher_fn(
                query_vector=query_vector,
                query="test",
                user_id=str(uuid.uuid4()),
                organization_id=str(uuid.uuid4()),
                accessible_organization_ids=[str(uuid.uuid4())],
                top_k=10,
                threshold=threshold,
                scope=None,
                **extra_kwargs,
            )
        except Exception:
            pass  # 只关心 ORM 调用，不关心结果

        return mock_qs

    def test_search_documents_uses_distance_lte(self):
        """_search_documents 应使用 distance__lte 而非 similarity__gte。"""
        from apps.rag.services.unified_search_service import _search_documents

        threshold = 0.7
        with patch("apps.rag.services.unified_search_service.DocumentEmbedding") as MockModel, \
             patch("apps.rag.services.unified_search_service._hnsw_iterative_scan") as mock_scan:
            mock_scan.return_value.__enter__ = MagicMock(return_value=None)
            mock_scan.return_value.__exit__ = MagicMock(return_value=False)

            mock_qs = MagicMock()
            mock_qs.filter.return_value = mock_qs
            mock_qs.annotate.return_value = mock_qs
            mock_qs.order_by.return_value.__getitem__ = MagicMock(return_value=[])
            mock_qs.order_by.return_value.__iter__ = MagicMock(return_value=iter([]))
            MockModel.objects.filter.return_value = mock_qs

            _search_documents(
                query_vector=[0.1] * 1536,
                query="test",
                user_id=str(uuid.uuid4()),
                organization_id=str(uuid.uuid4()),
                accessible_organization_ids=[str(uuid.uuid4())],
                top_k=10,
                threshold=threshold,
                scope=None,
            )

            # 断言：没有任何 filter 调用使用了 similarity__gte
            for call_args in mock_qs.filter.call_args_list:
                kwargs = call_args[1] if call_args[1] else {}
                args = call_args[0] if call_args[0] else ()
                self.assertNotIn("similarity__gte", kwargs,
                    "发现已废弃的 similarity__gte 过滤！应改为 distance__lte")

            # 断言：filter 调用中存在 distance__lte=1-threshold
            all_filter_kwargs = [
                call_args[1]
                for call_args in mock_qs.filter.call_args_list
                if call_args[1]
            ]
            has_distance_filter = any(
                abs(kwargs.get("distance__lte", -1) - (1 - threshold)) < 1e-9
                for kwargs in all_filter_kwargs
            )
            self.assertTrue(has_distance_filter,
                f"未找到 distance__lte={1-threshold} 过滤，PVEC-007 可能未修复")

    @pytest.mark.skip(reason="TabCode semantic search retired")
    def test_search_code_uses_distance_lte(self):
        """_search_code 应使用 distance__lte 而非 similarity__gte。"""
        from apps.rag.services.unified_search_service import _search_code

        threshold = 0.75

        with patch("apps.rag.services.unified_search_service.CodeChunkEmbedding") as MockModel, \
             patch("apps.rag.services.unified_search_service._hnsw_iterative_scan") as mock_scan:
            mock_scan.return_value.__enter__ = MagicMock(return_value=None)
            mock_scan.return_value.__exit__ = MagicMock(return_value=False)

            mock_qs = MagicMock()
            mock_qs.filter.return_value = mock_qs
            mock_qs.annotate.return_value = mock_qs
            mock_qs.order_by.return_value.__getitem__ = MagicMock(return_value=[])
            mock_qs.order_by.return_value.__iter__ = MagicMock(return_value=iter([]))
            MockModel.objects.filter.return_value = mock_qs

            _search_code(
                query_vector=[0.1] * 1536,
                query="test",
                user_id=str(uuid.uuid4()),
                organization_id=None,
                accessible_organization_ids=[str(uuid.uuid4())],
                top_k=5,
                threshold=threshold,
                scope=None,
            )

            # 断言：无 similarity__gte
            for call_args in mock_qs.filter.call_args_list:
                kwargs = call_args[1] if call_args[1] else {}
                self.assertNotIn("similarity__gte", kwargs,
                    "_search_code 仍在使用 similarity__gte 后置过滤")

            # 断言：有 distance__lte
            all_filter_kwargs = [
                call_args[1]
                for call_args in mock_qs.filter.call_args_list
                if call_args[1]
            ]
            has_distance_filter = any(
                abs(kwargs.get("distance__lte", -1) - (1 - threshold)) < 1e-9
                for kwargs in all_filter_kwargs
            )
            self.assertTrue(has_distance_filter,
                f"_search_code 未找到 distance__lte={1-threshold} 过滤")


# ─────────────────────────────────────────────────────────────────
# PVEC-008: ToolEmbedding HNSW 迁移文件测试
# ─────────────────────────────────────────────────────────────────

class PVEC008ToolEmbeddingHNSWMigrationTest(TestCase):
    """验证 capabilities/migrations/0002_add_hnsw_index.py 存在且格式正确。"""

    def test_migration_file_exists(self):
        """0002_add_hnsw_index 迁移文件必须存在。"""
        import importlib
        try:
            module = importlib.import_module(
                "apps.capabilities.migrations.0002_add_hnsw_index"
            )
            self.assertTrue(hasattr(module, "Migration"),
                "0002_add_hnsw_index 中缺少 Migration 类")
        except ImportError as e:
            self.fail(f"无法导入 0002_add_hnsw_index 迁移文件: {e}")

    def test_migration_is_non_atomic(self):
        """HNSW 迁移必须设置 atomic=False 以允许 CREATE INDEX CONCURRENTLY。"""
        import importlib
        module = importlib.import_module(
            "apps.capabilities.migrations.0002_add_hnsw_index"
        )
        self.assertFalse(module.Migration.atomic,
            "HNSW 迁移必须设置 atomic=False，才能使用 CREATE INDEX CONCURRENTLY")

    def test_migration_depends_on_initial(self):
        """0002 必须依赖 0001_initial。"""
        import importlib
        module = importlib.import_module(
            "apps.capabilities.migrations.0002_add_hnsw_index"
        )
        deps = module.Migration.dependencies
        self.assertIn(("capabilities", "0001_initial"), deps,
            "0002 迁移缺少对 0001_initial 的依赖声明")

    def test_migration_sql_contains_hnsw(self):
        """迁移 SQL 必须包含 HNSW 关键词和 vector_cosine_ops。"""
        import importlib
        from django.db.migrations.operations import RunSQL

        module = importlib.import_module(
            "apps.capabilities.migrations.0002_add_hnsw_index"
        )
        ops = module.Migration.operations
        run_sql_ops = [op for op in ops if isinstance(op, RunSQL)]
        self.assertTrue(run_sql_ops, "0002 迁移中未找到 RunSQL 操作")

        combined_sql = " ".join(
            op.sql if isinstance(op.sql, str) else op.sql[0]
            for op in run_sql_ops
        ).upper()

        self.assertIn("HNSW", combined_sql, "迁移 SQL 未包含 HNSW 关键词")
        self.assertIn("VECTOR_COSINE_OPS", combined_sql, "迁移 SQL 未指定 vector_cosine_ops")
        self.assertIn("CONCURRENTLY", combined_sql, "迁移 SQL 未使用 CONCURRENTLY（会锁表）")


# ─────────────────────────────────────────────────────────────────
# PVEC-009: 并发子检索器测试
# ─────────────────────────────────────────────────────────────────

class PVEC009ConcurrentSearchersTest(TestCase):
    """验证 UnifiedSearchService.search() 使用 ThreadPoolExecutor 并发执行子检索器。"""

    @override_settings(RAG_ENABLED=True, RAG_SEARCH_MAX_WORKERS=8)
    def test_search_uses_thread_pool_executor(self):
        """search() 应通过 ThreadPoolExecutor 而非串行 for 循环执行子检索器。"""
        from apps.rag.services.unified_search_service import (
            UnifiedSearchService, _SEARCHER_REGISTRY
        )
        from concurrent.futures import ThreadPoolExecutor

        execution_order = []

        def make_fake_searcher(name):
            def searcher(**kwargs):
                execution_order.append(name)
                return []
            return searcher

        fake_registry = {
            "type_a": make_fake_searcher("type_a"),
            "type_b": make_fake_searcher("type_b"),
            "type_c": make_fake_searcher("type_c"),
        }

        with patch("apps.rag.services.unified_search_service._SEARCHER_REGISTRY", fake_registry), \
             patch("apps.rag.services.unified_search_service._get_user_accessible_organizations",
                   return_value=[str(uuid.uuid4())]), \
             patch.object(UnifiedSearchService, "__init__", return_value=None):

            svc = UnifiedSearchService.__new__(UnifiedSearchService)
            svc.embedding_service = MagicMock()
            svc.embedding_service.embed_text.return_value = [0.1] * 1536
            svc.default_top_k = 10
            svc.default_threshold = 0.7

            # 拦截 ThreadPoolExecutor 验证被使用
            original_executor = __import__("concurrent.futures", fromlist=["ThreadPoolExecutor"]).ThreadPoolExecutor
            executor_used = []

            class TrackingExecutor:
                def __init__(self, *args, **kwargs):
                    executor_used.append(True)
                    self._inner = original_executor(*args, **kwargs)

                def __enter__(self):
                    return self._inner.__enter__()

                def __exit__(self, *args):
                    return self._inner.__exit__(*args)

                def submit(self, *args, **kwargs):
                    return self._inner.submit(*args, **kwargs)

            with patch("apps.rag.services.unified_search_service.ThreadPoolExecutor", TrackingExecutor), \
                 patch("apps.rag.services.unified_search_service.UnifiedSearchService._log_search"), \
                 patch("apps.rag.tasks.log_search_async") as mock_log_task:
                mock_log_task.delay = MagicMock()

                with patch("apps.rag.services.unified_search_service.log_search_async") as mock_async_log:
                    mock_async_log.delay = MagicMock()
                    result = svc.search(
                        query="test query",
                        user_id=str(uuid.uuid4()),
                        organization_id=str(uuid.uuid4()),
                        content_types=["type_a", "type_b", "type_c"],
                    )

            # 验证 ThreadPoolExecutor 被调用
            self.assertTrue(executor_used, "ThreadPoolExecutor 未被使用，子检索器可能仍是串行执行")

    def test_searcher_failures_dont_crash_search(self):
        """并发模式下，单个子检索器失败不应导致整体 search 抛出异常。"""
        from apps.rag.services.unified_search_service import UnifiedSearchService

        def failing_searcher(**kwargs):
            raise RuntimeError("模拟子检索器崩溃")

        def ok_searcher(**kwargs):
            return [{"content_type": "ok", "source_id": "1", "title": "",
                     "content": "", "similarity": 0.9, "metadata": {}}]

        fake_registry = {
            "failing": failing_searcher,
            "ok": ok_searcher,
        }

        with patch("apps.rag.services.unified_search_service._SEARCHER_REGISTRY", fake_registry), \
             patch("apps.rag.services.unified_search_service._get_user_accessible_organizations",
                   return_value=[str(uuid.uuid4())]), \
             patch.object(UnifiedSearchService, "__init__", return_value=None):

            svc = UnifiedSearchService.__new__(UnifiedSearchService)
            svc.embedding_service = MagicMock()
            svc.embedding_service.embed_text.return_value = [0.1] * 1536
            svc.default_top_k = 10
            svc.default_threshold = 0.7

            with patch("apps.rag.services.unified_search_service.log_search_async") as mock_async_log:
                mock_async_log.delay = MagicMock()
                result = svc.search(
                    query="test",
                    user_id=str(uuid.uuid4()),
                    content_types=["failing", "ok"],
                )

            # 不崩溃，且能返回正常子检索器的结果
            self.assertIn("hits", result)
            self.assertEqual(result["total"], 1)


# ─────────────────────────────────────────────────────────────────
# PVEC-010: SearchLog 异步写入回归测试
# ─────────────────────────────────────────────────────────────────

class PVEC010AsyncSearchLogTest(TestCase):
    """验证 search() 使用 log_search_async.delay() 而非同步写入 SearchLog。"""

    @override_settings(RAG_ENABLED=True)
    def test_search_calls_log_search_async_delay(self):
        """search() 应调用 log_search_async.delay()，而非直接 SearchLog.objects.create()。"""
        from apps.rag.services.unified_search_service import UnifiedSearchService

        fake_registry = {
            "table": lambda **kwargs: [],
        }

        with patch("apps.rag.services.unified_search_service._SEARCHER_REGISTRY", fake_registry), \
             patch("apps.rag.services.unified_search_service._get_user_accessible_organizations",
                   return_value=[str(uuid.uuid4())]), \
             patch.object(UnifiedSearchService, "__init__", return_value=None):

            svc = UnifiedSearchService.__new__(UnifiedSearchService)
            svc.embedding_service = MagicMock()
            svc.embedding_service.embed_text.return_value = [0.1] * 1536
            svc.default_top_k = 10
            svc.default_threshold = 0.7

            with patch("apps.rag.services.unified_search_service.log_search_async") as mock_task:
                mock_task.delay = MagicMock()

                svc.search(
                    query="hello",
                    user_id=str(uuid.uuid4()),
                    content_types=["table"],
                )

                # 断言：log_search_async.delay 被调用过一次
                mock_task.delay.assert_called_once()
                call_kwargs = mock_task.delay.call_args[1]
                self.assertEqual(call_kwargs["query"], "hello")
                self.assertIn("user_id", call_kwargs)
                self.assertIn("results_count", call_kwargs)
                self.assertIn("response_time_ms", call_kwargs)

    def test_log_search_async_task_exists_in_tasks_module(self):
        """tasks.py 中必须存在 log_search_async 任务。"""
        try:
            from apps.rag.tasks import log_search_async
            self.assertTrue(callable(log_search_async),
                "log_search_async 不是可调用对象")
        except ImportError as e:
            self.fail(f"无法从 apps.rag.tasks 导入 log_search_async: {e}")

    def test_log_search_async_task_handles_db_failure(self):
        """log_search_async 在 DB 写入失败时应记录日志而不抛出异常。"""
        from apps.rag.tasks import log_search_async

        with patch("apps.rag.tasks.SearchLog") as MockSearchLog:
            MockSearchLog.objects.create.side_effect = Exception("DB连接失败")
            # 不应抛出异常
            try:
                log_search_async(
                    query="test",
                    user_id=str(uuid.uuid4()),
                    results_count=0,
                    top_similarity=0.0,
                    response_time_ms=100,
                )
            except Exception as e:
                self.fail(f"log_search_async 在 DB 故障时抛出了异常: {e}")

    @override_settings(RAG_ENABLED=True)
    def test_search_does_not_call_searchlog_create_directly(self):
        """search() 不应直接调用 SearchLog.objects.create()（必须经过异步任务）。"""
        from apps.rag.services.unified_search_service import UnifiedSearchService
        from apps.rag.models import SearchLog

        fake_registry = {
            "table": lambda **kwargs: [],
        }

        with patch("apps.rag.services.unified_search_service._SEARCHER_REGISTRY", fake_registry), \
             patch("apps.rag.services.unified_search_service._get_user_accessible_organizations",
                   return_value=[str(uuid.uuid4())]), \
             patch.object(UnifiedSearchService, "__init__", return_value=None), \
             patch("apps.rag.services.unified_search_service.log_search_async") as mock_task, \
             patch.object(SearchLog.objects, "create") as mock_create:

            mock_task.delay = MagicMock()
            svc = UnifiedSearchService.__new__(UnifiedSearchService)
            svc.embedding_service = MagicMock()
            svc.embedding_service.embed_text.return_value = [0.1] * 1536
            svc.default_top_k = 10
            svc.default_threshold = 0.7

            svc.search(
                query="test",
                user_id=str(uuid.uuid4()),
                content_types=["table"],
            )

            # SearchLog.objects.create 不应被 search() 直接调用
            mock_create.assert_not_called()

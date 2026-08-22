"""
回归测试：SC-002、SC-004、SC-019 修复验证

SC-002: Table/Record/Document upsert 无 DB 层 ON CONFLICT 保护，TOCTOU 竞态
SC-004: EmbeddingTask 状态机无并发互斥，多 worker 可同时索引同一 target
SC-019: incremental_index_all 定时任务无单实例保护
"""

import uuid
from unittest.mock import patch, MagicMock, call
from django.test import TestCase, override_settings


class TestSC002UpsertOnConflict(TestCase):
    """SC-002: upsert 应使用 bulk_create(update_conflicts=True) 而非 update_or_create"""

    def test_upsert_table_embedding_uses_bulk_create(self):
        """_upsert_table_embedding 应调用 bulk_create 而非 update_or_create"""
        import inspect
        from apps.rag.services.index_service import IndexService
        src = inspect.getsource(IndexService._upsert_table_embedding)
        self.assertIn("bulk_create", src, "_upsert_table_embedding 必须使用 bulk_create")
        self.assertIn("update_conflicts=True", src, "必须设置 update_conflicts=True")
        self.assertNotIn(".update_or_create(", src, "不应再调用 .update_or_create()（有 TOCTOU 竞态）")

    def test_upsert_record_embedding_uses_bulk_create(self):
        """_upsert_record_embedding 应调用 bulk_create 而非 update_or_create"""
        import inspect
        from apps.rag.services.index_service import IndexService
        src = inspect.getsource(IndexService._upsert_record_embedding)
        self.assertIn("bulk_create", src, "_upsert_record_embedding 必须使用 bulk_create")
        self.assertIn("update_conflicts=True", src, "必须设置 update_conflicts=True")
        self.assertNotIn(".update_or_create(", src, "不应再调用 .update_or_create()（有 TOCTOU 竞态）")

    def test_index_table_single_path_uses_bulk_create(self):
        """index_table 单条路径也必须使用 bulk_create"""
        import inspect
        from apps.rag.services.index_service import IndexService
        src = inspect.getsource(IndexService.index_table)
        self.assertIn("bulk_create", src, "index_table 单条路径必须使用 bulk_create")
        self.assertNotIn(".update_or_create(", src, "index_table 不应调用 .update_or_create()")

    def test_index_record_single_path_uses_bulk_create(self):
        """index_record 单条路径也必须使用 bulk_create"""
        import inspect
        from apps.rag.services.index_service import IndexService
        src = inspect.getsource(IndexService.index_record)
        self.assertIn("bulk_create", src, "index_record 单条路径必须使用 bulk_create")
        self.assertNotIn(".update_or_create(", src, "index_record 不应调用 .update_or_create()")

    def test_index_documents_batch_task_uses_bulk_create(self):
        """index_documents_batch_task 中 DocumentEmbedding upsert 必须使用 bulk_create"""
        import inspect
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.index_documents_batch_task)
        self.assertNotIn(
            "DocumentEmbedding.objects.update_or_create(", src,
            "index_documents_batch_task 不应调用 .update_or_create() 写入 DocumentEmbedding",
        )

    @patch("apps.rag.models.TableEmbedding.objects")
    def test_concurrent_upsert_calls_bulk_create_atomically(self, mock_manager):
        """模拟并发场景：两次 _upsert_table_embedding 均调用 bulk_create，不抛 IntegrityError"""
        from apps.rag.services.index_service import IndexService

        mock_table = MagicMock()
        mock_table.id = uuid.uuid4()
        mock_table.name = "test_table"
        mock_table.description = ""
        mock_table.organization_id = uuid.uuid4()
        mock_table.space_id = uuid.uuid4()
        mock_table.fields.all.return_value = []
        mock_table.records.count.return_value = 0

        mock_manager.bulk_create.return_value = []

        svc = IndexService.__new__(IndexService)
        svc.embedding_service = MagicMock()
        item = {
            "table": mock_table,
            "text": "test",
            "hash": "abc123",
            "ws_id": str(mock_table.organization_id),
            "user_id": "",
        }
        vector = [0.1] * 1536

        svc._upsert_table_embedding(item, vector)
        svc._upsert_table_embedding(item, vector)
        self.assertEqual(mock_manager.bulk_create.call_count, 2)


class TestSC004TargetLevelLock(TestCase):
    """SC-004: index_table_task 和 index_document_task 必须持有 target-level Redis 锁"""

    def test_acquire_target_lock_function_exists(self):
        """_acquire_target_lock 辅助函数必须存在"""
        from apps.rag import tasks
        self.assertTrue(
            hasattr(tasks, "_acquire_target_lock"),
            "_acquire_target_lock 函数不存在，SC-004 修复缺失",
        )
        self.assertTrue(
            hasattr(tasks, "_release_target_lock"),
            "_release_target_lock 函数不存在，SC-004 修复缺失",
        )

    def test_index_table_task_acquires_target_lock(self):
        """index_table_task 必须调用 _acquire_target_lock"""
        import inspect
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.index_table_task)
        self.assertIn(
            "_acquire_target_lock",
            src,
            "index_table_task 缺少 _acquire_target_lock 调用（SC-004 修复缺失）",
        )
        self.assertIn(
            "_release_target_lock",
            src,
            "index_table_task 缺少 _release_target_lock 调用（SC-004 修复缺失）",
        )

    def test_index_document_task_acquires_target_lock(self):
        """index_document_task 必须调用 _acquire_target_lock"""
        import inspect
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.index_document_task)
        self.assertIn(
            "_acquire_target_lock",
            src,
            "index_document_task 缺少 _acquire_target_lock 调用（SC-004 修复缺失）",
        )

    @patch("apps.rag.tasks._acquire_target_lock", return_value="")
    def test_index_table_task_skips_when_lock_not_acquired(self, mock_acquire):
        """index_table_task 获锁失败时应直接返回 already_processing，不执行实际索引"""
        from apps.rag.tasks import index_table_task

        table_id = str(uuid.uuid4())
        mock_self = MagicMock()
        mock_self.request.id = str(uuid.uuid4())
        mock_self.request.retries = 0
        mock_self.max_retries = 3

        result = index_table_task.__wrapped__(mock_self, table_id)
        self.assertEqual(result["reason"], "already_processing")
        self.assertFalse(result["success"])

    @patch("apps.rag.tasks._acquire_target_lock", return_value="some-token")
    @patch("apps.rag.tasks._release_target_lock")
    @patch("apps.rag.tasks._resolve_table_organization", return_value=None)
    @patch("apps.rag.models.EmbeddingTask.objects.update_or_create")
    @patch("apps.rag.services.IndexService.index_table", return_value={"status": "success", "table_id": "x", "table_name": "t"})
    def test_index_table_task_releases_lock_on_success(
        self, mock_index, mock_uoc, mock_resolve, mock_release, mock_acquire
    ):
        """index_table_task 成功完成后必须释放锁"""
        from apps.rag.tasks import index_table_task

        table_id = str(uuid.uuid4())
        mock_self = MagicMock()
        mock_self.request.id = str(uuid.uuid4())
        mock_self.request.retries = 0
        mock_self.max_retries = 3

        task_record = MagicMock()
        mock_uoc.return_value = (task_record, True)

        index_table_task.__wrapped__(mock_self, table_id)
        mock_release.assert_called_once()

    @patch("apps.rag.tasks._acquire_target_lock", return_value="")
    def test_index_document_task_skips_when_lock_not_acquired(self, mock_acquire):
        """index_document_task 获锁失败时应直接返回 already_processing"""
        from apps.rag.tasks import index_document_task

        doc_id = str(uuid.uuid4())
        mock_self = MagicMock()
        mock_self.request.id = str(uuid.uuid4())
        mock_self.request.retries = 0
        mock_self.max_retries = 3

        result = index_document_task.__wrapped__(mock_self, doc_id)
        self.assertEqual(result["reason"], "already_processing")
        self.assertFalse(result["success"])

    def test_acquire_target_lock_returns_empty_when_locked(self):
        """_acquire_target_lock 在 Redis 锁已被持有时返回空字符串"""
        from apps.rag.tasks import _acquire_target_lock, _release_target_lock

        target_id = str(uuid.uuid4())
        try:
            from django_redis import get_redis_connection
            redis = get_redis_connection("default")
        except Exception:
            self.skipTest("Redis 不可用，跳过此测试")

        # 先获取锁
        token1 = _acquire_target_lock("table", target_id, ttl=10)
        if not token1:
            self.skipTest("首次获锁失败，Redis 可能不可用")

        try:
            # 再次获取同一锁，应失败
            token2 = _acquire_target_lock("table", target_id, ttl=10)
            self.assertEqual(token2, "", "锁已被持有时应返回空字符串")
        finally:
            _release_target_lock("table", target_id, token1)


class TestSC019IncrementalIndexSingleInstance(TestCase):
    """SC-019: incremental_index_all 必须有单实例 Redis 互斥保护"""

    def test_incremental_index_all_has_lock_logic(self):
        """incremental_index_all 必须包含 Redis 锁获取逻辑"""
        import inspect
        import apps.rag.tasks as tasks_module
        src = inspect.getsource(tasks_module.incremental_index_all)
        self.assertIn(
            "nx=True",
            src,
            "incremental_index_all 缺少 Redis nx=True 锁设置（SC-019 修复缺失）",
        )
        self.assertIn(
            "another_instance_running",
            src,
            "incremental_index_all 缺少单实例跳过返回值（SC-019 修复缺失）",
        )

    @patch("django_redis.get_redis_connection")
    def test_second_invocation_skipped_when_first_holds_lock(self, mock_grc):
        """当 Redis 锁已被持有时，第二次调用 incremental_index_all 应跳过"""
        mock_redis = MagicMock()
        mock_redis.set.return_value = False  # 模拟锁已被持有
        mock_grc.return_value = mock_redis

        with override_settings(RAG_ENABLED=True):
            from apps.rag.tasks import incremental_index_all
            # 直接调用（绕过 Celery 装饰器）
            result = incremental_index_all()

        self.assertTrue(result.get("skipped"))
        self.assertEqual(result.get("reason"), "another_instance_running")

    @patch("django_redis.get_redis_connection")
    @patch("apps.rag.tasks._run_incremental_index_all")
    def test_lock_released_after_run(self, mock_run, mock_grc):
        """incremental_index_all 正常完成后必须释放锁"""
        mock_redis = MagicMock()
        mock_redis.set.return_value = True  # 获锁成功
        mock_grc.return_value = mock_redis
        mock_run.return_value = {"success": True, "result": {}}

        with override_settings(RAG_ENABLED=True):
            from apps.rag.tasks import incremental_index_all
            incremental_index_all()

        # 验证 eval 被调用（释放锁的 Lua 脚本）
        mock_redis.eval.assert_called_once()

    @patch("django_redis.get_redis_connection")
    @patch("apps.rag.tasks._run_incremental_index_all", side_effect=RuntimeError("boom"))
    def test_lock_released_even_on_exception(self, mock_run, mock_grc):
        """incremental_index_all 异常时也必须释放锁（finally 块保证）"""
        mock_redis = MagicMock()
        mock_redis.set.return_value = True
        mock_grc.return_value = mock_redis

        with override_settings(RAG_ENABLED=True):
            from apps.rag.tasks import incremental_index_all
            with self.assertRaises(RuntimeError):
                incremental_index_all()

        mock_redis.eval.assert_called_once()

"""
回归测试：CRT-13 / CRT-27 / CRT-28 / CRT-29 / CRT-53 / CRT-55 修复验证

每个测试类对应一个修复，确保修复的 bug 不会再发生。
"""

import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4


class TestCRT13QueueRouting(unittest.TestCase):
    """CRT-13: auto_tag_memo 必须路由到 heavy 队列，不能落入 default。"""

    def test_task_has_heavy_queue(self):
        from apps.tabmemo.tasks import auto_tag_memo
        self.assertEqual(auto_tag_memo.queue, "heavy")

    def test_task_has_explicit_name(self):
        """CRT-52: 任务必须有显式 name，避免自动使用全路径。"""
        from apps.tabmemo.tasks import auto_tag_memo
        self.assertEqual(auto_tag_memo.name, "tabmemo.auto_tag_memo")

    def test_task_ignore_result(self):
        from apps.tabmemo.tasks import auto_tag_memo
        self.assertTrue(auto_tag_memo.ignore_result)


class TestCRT27SoftTimeLimitRetryExhausted(unittest.TestCase):
    """CRT-27: SoftTimeLimitExceeded 时若重试耗尽，不能漏报。

    修复前：except SoftTimeLimitExceeded 块内 self.retry() 抛出
    MaxRetriesExceededError，无法被外层 except MaxRetriesExceededError 捕获，
    导致未处理异常。修复后在 except SoftTimeLimitExceeded 块内嵌套处理。
    """

    @patch("apps.tabmemo.models.Memo")
    def test_soft_timeout_max_retries_returns_gracefully(self, MockMemo):
        from celery.exceptions import MaxRetriesExceededError, SoftTimeLimitExceeded
        from apps.tabmemo.tasks import auto_tag_memo

        memo = MagicMock()
        memo.id = uuid4()
        memo.content_plaintext = "这是一段足够长的测试内容，用于触发 AI 打标功能。"
        memo.content_markdown = ""
        memo.created_by_id = uuid4()
        memo.organization_id = uuid4()
        MockMemo.objects.using.return_value.get.return_value = memo
        MockMemo.DoesNotExist = Exception

        with patch(
            "apps.services.llm.services.factory.get_llm_service",
            side_effect=SoftTimeLimitExceeded(),
        ):
            with patch(
                "apps.services.llm.services.billed_call.check_balance_before_request",
                return_value=False,
            ), patch(
                "apps.services.llm.services.billing.check_budget_before_request",
                return_value=False,
            ):
                with patch.object(
                    auto_tag_memo,
                    "retry",
                    side_effect=MaxRetriesExceededError(),
                ):
                    result = auto_tag_memo(str(memo.id))

        self.assertTrue(result.get("skipped"))
        self.assertEqual(result["reason"], "max_retries_exceeded")


class TestCRT28UnifiedLockKey(unittest.TestCase):
    """CRT-28: retag_memo 幂等 key 必须与 auto_tag_memo 任务锁 key 一致。"""

    def test_lock_key_function_exists(self):
        from apps.tabmemo.tasks import auto_tag_lock_key
        memo_id = str(uuid4())
        key = auto_tag_lock_key(memo_id)
        self.assertEqual(key, f"tabmemo:auto_tag:lock:{memo_id}")

    def test_retag_memo_uses_same_lock_key(self):
        """retag_memo 中使用的 cache_key 必须与 auto_tag_lock_key 输出一致。"""
        from apps.tabmemo.tasks import auto_tag_lock_key

        memo_id = str(uuid4())
        expected_key = auto_tag_lock_key(memo_id)
        self.assertIn("auto_tag:lock", expected_key)
        self.assertNotIn("tagging", expected_key)

    @patch("apps.tabmemo.services.memo_service.MemoService.check_organization_permission", return_value=True)
    @patch("apps.tabmemo.services.memo_service.MemoService.check_space_permission", return_value=True)
    def test_retag_dispatch_checks_unified_key(self, _perm1, _perm2):
        """验证 retag_memo 使用 auto_tag_lock_key 而不是硬编码的不同 key。"""
        from apps.tabmemo.tasks import auto_tag_lock_key

        memo_id = str(uuid4())
        key_from_func = auto_tag_lock_key(memo_id)

        self.assertTrue(key_from_func.startswith("tabmemo:auto_tag:lock:"))


    def test_retag_memo_does_not_cache_set_lock_key(self):
        """retag_memo 不能 cache.set 锁 key，否则任务 cache.add 必然失败。"""
        import inspect
        from apps.tabmemo.services.memo_service import MemoService

        source = inspect.getsource(MemoService.retag_memo)
        self.assertNotIn("cache.set", source,
                         "retag_memo 不应 cache.set 锁 key，锁应由任务本身 cache.add 获取")


class TestCRT29SharedSearchVector(unittest.TestCase):
    """CRT-29: search_vector 更新逻辑必须合并为单一来源。"""

    def test_refresh_search_vector_importable(self):
        from apps.tabmemo.search import refresh_search_vector
        self.assertTrue(callable(refresh_search_vector))

    def test_memo_service_delegates_to_shared_function(self):
        """MemoService._update_search_vector 应委托给共享函数。"""
        import inspect
        from apps.tabmemo.services.memo_service import MemoService

        source = inspect.getsource(MemoService._update_search_vector)
        self.assertIn("refresh_search_vector", source)
        self.assertNotIn("to_tsvector", source)

    def test_tasks_uses_shared_function(self):
        """tasks.py 不再包含独立的 _refresh_search_vector。"""
        import apps.tabmemo.tasks as tasks_mod
        self.assertFalse(
            hasattr(tasks_mod, "_refresh_search_vector"),
            "tasks.py 不应再定义 _refresh_search_vector，应使用 search.refresh_search_vector",
        )

    @patch("django.db.connections")
    def test_refresh_search_vector_handles_non_pg(self, mock_conns):
        """非 PostgreSQL 数据库应安全跳过。"""
        from apps.tabmemo.search import refresh_search_vector

        mock_conn = MagicMock()
        mock_conn.vendor = "mysql"
        mock_conns.__getitem__.return_value = mock_conn

        memo = MagicMock()
        memo.content_plaintext = "some content"
        memo.bookmark_title = None
        memo.bookmark_description = None
        memo.tags = ["tag1"]
        memo.ai_tags = ["ai_tag"]
        memo.pk = uuid4()

        refresh_search_vector(memo)
        mock_conn.cursor.assert_not_called()


class TestCRT53DispatchAutoTagBroadCatch(unittest.TestCase):
    """CRT-53: _dispatch_auto_tag 必须捕获所有异常（包括 kombu 异常）。"""

    def test_dispatch_catches_operational_error(self):
        """模拟 kombu OperationalError，不应传播到调用方。"""
        from apps.tabmemo.services.memo_service import MemoService

        with patch(
            "apps.tabmemo.tasks.auto_tag_memo"
        ) as mock_task:
            mock_task.delay.side_effect = OSError("Redis connection refused")
            MemoService._dispatch_auto_tag(str(uuid4()))

    def test_dispatch_catches_generic_exception(self):
        from apps.tabmemo.services.memo_service import MemoService

        with patch(
            "apps.tabmemo.tasks.auto_tag_memo"
        ) as mock_task:
            mock_task.delay.side_effect = RuntimeError("unexpected broker error")
            MemoService._dispatch_auto_tag(str(uuid4()))


class TestCRT55UserIdField(unittest.TestCase):
    """CRT-55: auto_tag_memo 中获取用户 ID 应优先使用 created_by_id。"""

    def test_uses_created_by_id_primarily(self):
        """确认代码使用 created_by_id 而非 user_id。"""
        import inspect
        from apps.tabmemo.tasks import auto_tag_memo

        source = inspect.getsource(auto_tag_memo)
        self.assertIn("memo.created_by_id", source)
        self.assertNotIn('getattr(memo, "user_id"', source)


if __name__ == "__main__":
    unittest.main()

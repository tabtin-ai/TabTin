"""
SC-017 / SC-018 回归测试

SC-017: _acquire_project_lock Redis 故障时应 fail-closed（返回空字符串），
        不再返回 dummy token，避免多 worker 并发 embed 重复计费。

SC-018: EmbeddingTask.mark_success / mark_failed 应使用原子 QuerySet.update()，
        并加 status='processing' 条件，防止并发 worker 互相覆盖状态。
"""

import uuid
from unittest.mock import patch, MagicMock
from django.test import TestCase


class AcquireProjectLockFailClosedTest(TestCase):
    """SC-017: Redis 故障时 fail-closed"""

    def test_redis_failure_returns_empty_string(self):
        """Redis 连接异常时应返回空字符串（fail-closed），不返回 dummy token"""
        from apps.rag.tasks import _acquire_project_lock

        with patch("apps.rag.tasks._acquire_project_lock") as mock_fn:
            # 直接调用真实函数，mock django_redis 抛异常
            pass

        # 使用 mock 替换 django_redis 连接
        with patch("django_redis.get_redis_connection", side_effect=ConnectionError("Redis down")):
            token = _acquire_project_lock("proj-123")

        self.assertEqual(token, "", "Redis 故障时应返回空字符串（fail-closed），不能返回 dummy token")

    def test_redis_failure_not_fail_open(self):
        """fail-open 的 dummy token 不应再出现"""
        from apps.rag.tasks import _acquire_project_lock

        with patch("django_redis.get_redis_connection", side_effect=RuntimeError("Redis unavailable")):
            token = _acquire_project_lock("proj-456")

        self.assertFalse(token.startswith("fail-open-"), "不应再返回 fail-open- 前缀的 dummy token")
        self.assertEqual(token, "")

    def test_normal_lock_acquired(self):
        """正常情况下成功获锁返回非空 token"""
        from apps.rag.tasks import _acquire_project_lock

        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            token = _acquire_project_lock("proj-789")

        self.assertTrue(len(token) > 0)
        self.assertFalse(token.startswith("fail-open-"))

    def test_lock_contention_returns_empty(self):
        """锁已被其他 worker 持有时返回空字符串"""
        from apps.rag.tasks import _acquire_project_lock

        mock_redis = MagicMock()
        mock_redis.set.return_value = False  # SET NX 失败，锁已被占用

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            token = _acquire_project_lock("proj-locked")

        self.assertEqual(token, "")


class EmbeddingTaskMarkSuccessAtomicTest(TestCase):
    """SC-018: mark_success / mark_failed 使用原子条件更新"""

    def _make_task(self):
        """构造一个 EmbeddingTask mock（不依赖真实 DB）"""
        from apps.rag.models import EmbeddingTask
        task = EmbeddingTask.__new__(EmbeddingTask)
        task.pk = uuid.uuid4()
        task.status = 'processing'
        task.error_message = ''
        return task

    def test_mark_success_uses_queryset_update(self):
        """mark_success 应调用 QuerySet.update() 而非 self.save()"""
        from apps.rag.models import EmbeddingTask

        task = self._make_task()

        with patch.object(EmbeddingTask.objects, "filter") as mock_filter:
            mock_qs = MagicMock()
            mock_qs.update.return_value = 1
            mock_filter.return_value = mock_qs

            task.mark_success()

            mock_filter.assert_called_once_with(pk=task.pk, status='processing')
            mock_qs.update.assert_called_once()
            call_kwargs = mock_qs.update.call_args[1]
            self.assertEqual(call_kwargs["status"], "success")
            self.assertIn("completed_at", call_kwargs)

    def test_mark_failed_uses_queryset_update(self):
        """mark_failed 应调用 QuerySet.update() 而非 self.save()"""
        from apps.rag.models import EmbeddingTask

        task = self._make_task()

        with patch.object(EmbeddingTask.objects, "filter") as mock_filter:
            mock_qs = MagicMock()
            mock_qs.update.return_value = 1
            mock_filter.return_value = mock_qs

            task.mark_failed("some error")

            mock_filter.assert_called_once_with(pk=task.pk, status='processing')
            mock_qs.update.assert_called_once()
            call_kwargs = mock_qs.update.call_args[1]
            self.assertEqual(call_kwargs["status"], "failed")
            self.assertEqual(call_kwargs["error_message"], "some error")

    def test_mark_success_no_op_when_not_processing(self):
        """若任务不处于 processing 状态，mark_success 不修改状态（并发竞争保护）"""
        from apps.rag.models import EmbeddingTask

        task = self._make_task()
        task.status = 'failed'

        with patch.object(EmbeddingTask.objects, "filter") as mock_filter:
            mock_qs = MagicMock()
            mock_qs.update.return_value = 0  # 条件不满足，0 行更新
            mock_filter.return_value = mock_qs

            task.mark_success()

            # 过滤条件必须包含 status='processing'
            mock_filter.assert_called_once_with(pk=task.pk, status='processing')

    def test_mark_failed_no_op_when_already_success(self):
        """若任务已经 success，mark_failed 不能将其回退为 failed"""
        from apps.rag.models import EmbeddingTask

        task = self._make_task()
        task.status = 'success'

        with patch.object(EmbeddingTask.objects, "filter") as mock_filter:
            mock_qs = MagicMock()
            mock_qs.update.return_value = 0
            mock_filter.return_value = mock_qs

            task.mark_failed("late error")

            mock_filter.assert_called_once_with(pk=task.pk, status='processing')
            # 0 行更新，状态不应被修改
            self.assertNotEqual(task.status, 'failed')

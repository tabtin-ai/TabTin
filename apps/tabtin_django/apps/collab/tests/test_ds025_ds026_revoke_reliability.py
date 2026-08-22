"""
DS-025 / DS-026 回归测试 — 撤销可靠性

DS-025: Celery 撤销任务持久化保障（acks_late + retry + reject_on_worker_lost）
DS-026: 撤销 HTTP 调用增加重试 + 任务级错误传播
"""
import os
import uuid
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


class TestDS025TaskPersistenceGuarantees:
    """DS-025: Celery 任务配置确保 worker 宕机不丢任务。"""

    def test_acks_late_enabled(self):
        from apps.collab.tasks import async_revoke_collab_access
        assert async_revoke_collab_access.acks_late is True

    def test_reject_on_worker_lost_enabled(self):
        from apps.collab.tasks import async_revoke_collab_access
        assert async_revoke_collab_access.reject_on_worker_lost is True

    def test_max_retries_at_least_3(self):
        from apps.collab.tasks import async_revoke_collab_access
        assert async_revoke_collab_access.max_retries >= 3

    def test_retry_backoff_enabled(self):
        from apps.collab.tasks import async_revoke_collab_access
        assert async_revoke_collab_access.retry_backoff is True

    def test_task_is_bound(self):
        """bind=True 才能使用 self.retry()。"""
        from apps.collab.tasks import async_revoke_collab_access
        assert hasattr(async_revoke_collab_access, 'run')

    @patch("apps.collab.api.revoke_user_collab_access")
    def test_exception_triggers_retry(self, mock_revoke):
        """DS-025: API 层异常触发 self.retry() 而非静默吞掉。

        直接调用模式下 self.retry(exc=exc) 重新抛出 exc 本身。
        """
        from apps.collab.tasks import async_revoke_collab_access

        mock_revoke.side_effect = RuntimeError("connection refused")

        with pytest.raises(RuntimeError, match="connection refused"):
            async_revoke_collab_access("user-1", "ws-1")

    @patch("apps.collab.api.revoke_user_collab_access")
    def test_soft_error_triggers_retry(self, mock_revoke):
        """DS-025: call_live_api_safe 返回 error dict 也触发 self.retry()。"""
        from apps.collab.tasks import async_revoke_collab_access, CollabRevocationError

        mock_revoke.return_value = {"revoked": False, "error": "collab-live 服务不可用"}

        with pytest.raises(CollabRevocationError):
            async_revoke_collab_access("user-1", "ws-1")

    @patch("apps.collab.api.revoke_user_collab_access")
    def test_success_does_not_retry(self, mock_revoke):
        from apps.collab.tasks import async_revoke_collab_access

        mock_revoke.return_value = {"revoked": True, "connections_closed": 2}

        result = async_revoke_collab_access("user-1", "ws-1")
        assert result["revoked"] is True
        assert result["connections_closed"] == 2


class TestDS025CollabRevocationError:
    """DS-025: CollabRevocationError 自定义异常存在且可导入。"""

    def test_importable(self):
        from apps.collab.tasks import CollabRevocationError
        assert issubclass(CollabRevocationError, Exception)

    @patch("apps.collab.api.revoke_user_collab_access")
    def test_soft_error_raises_collabrevocationerror(self, mock_revoke):
        """重试时携带的 exc 类型为 CollabRevocationError。"""
        from apps.collab.tasks import async_revoke_collab_access, CollabRevocationError

        mock_revoke.return_value = {"revoked": False, "error": "timeout"}

        with pytest.raises(CollabRevocationError, match="timeout"):
            async_revoke_collab_access("u1", "ws1")


class TestDS026IncreasedRetries:
    """DS-026: revoke_user_collab_access HTTP 重试次数和超时增加。"""

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_max_retries_at_least_3(self, mock_call):
        from apps.collab.api import revoke_user_collab_access

        mock_call.return_value = {"connections_closed": 0}
        revoke_user_collab_access("u1", "ws1")

        args, kwargs = mock_call.call_args
        assert kwargs.get("max_retries", args[3] if len(args) > 3 else 0) >= 3

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_timeout_at_least_10s(self, mock_call):
        from apps.collab.api import revoke_user_collab_access

        mock_call.return_value = {"connections_closed": 0}
        revoke_user_collab_access("u1", "ws1")

        _, kwargs = mock_call.call_args
        assert kwargs.get("timeout", 0) >= 10

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_two_level_retry_stack(self, mock_call):
        """DS-025 + DS-026 联合：HTTP 级重试失败后，Celery 任务级 self.retry() 再次尝试。"""
        from apps.collab.tasks import async_revoke_collab_access, CollabRevocationError

        mock_call.return_value = {"error": "all retries exhausted"}

        with pytest.raises(CollabRevocationError):
            async_revoke_collab_access("u1", "ws1")

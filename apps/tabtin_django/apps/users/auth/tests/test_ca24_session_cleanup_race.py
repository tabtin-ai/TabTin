"""
CA-24 回归测试：_cleanup_old_sessions 竞态 → select_for_update 行级锁

修复内容：_cleanup_old_sessions 改为使用 select_for_update() 获取行级锁，
然后用 values_list 获取 ID 列表再批量 update。
"""

from contextlib import nullcontext
from datetime import timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

from django.db import transaction
from django.test import TestCase
from django.utils import timezone

from apps.users.auth.models import User, UserSession
from apps.users.auth.session_manager import MAX_ACTIVE_SESSIONS, SessionManager


def _create_session_directly(user, raw_key, **overrides):
    """直接创建 UserSession 行，绕过 create_session 的清理逻辑"""
    hashed_key = SessionManager.hash_session_key(raw_key)
    defaults = dict(
        user=user,
        session_key=hashed_key,
        session_type="web",
        ip_address="127.0.0.1",
        user_agent="test-agent",
        device_info={},
        expires_at=timezone.now() + timedelta(hours=24),
        is_active=True,
    )
    defaults.update(overrides)
    return UserSession.objects.create(**defaults)


class TestActiveSessionLimitConfiguration(unittest.TestCase):
    """创建和轮换会话时都必须为新会话预留第 10 个名额。"""

    def setUp(self):
        self.user = SimpleNamespace(id="user-1", username="test-user")
        self.request = SimpleNamespace(
            META={
                "HTTP_USER_AGENT": "test-agent",
                "HTTP_X_CLIENT_TYPE": "electron",
                "REMOTE_ADDR": "127.0.0.1",
            }
        )

    def test_create_session_keeps_nine_existing_sessions(self):
        with (
            patch(
                "apps.users.auth.session_manager.transaction.atomic",
                return_value=nullcontext(),
            ),
            patch("apps.users.auth.session_manager.UserSession") as session_model,
            patch.object(SessionManager, "_cleanup_old_sessions") as cleanup,
        ):
            session_model.objects.create.return_value = SimpleNamespace(id="session-10")

            SessionManager.create_session(self.user, self.request)

        cleanup.assert_called_once_with(
            self.user,
            keep_recent=MAX_ACTIVE_SESSIONS - 1,
        )

    def test_rotate_session_keeps_nine_existing_sessions(self):
        with (
            patch(
                "apps.users.auth.session_manager.transaction.atomic",
                return_value=nullcontext(),
            ),
            patch("apps.users.auth.session_manager.UserSession") as session_model,
            patch.object(SessionManager, "_cleanup_old_sessions") as cleanup,
        ):
            session_model.objects.create.return_value = SimpleNamespace(id="session-10")

            SessionManager.rotate_session("old-session", self.user, self.request)

        cleanup.assert_called_once_with(
            self.user,
            keep_recent=MAX_ACTIVE_SESSIONS - 1,
        )


class TestCA24SelectForUpdateCalled(unittest.TestCase):
    """CA-24: 验证 select_for_update 被调用（纯 mock，无需数据库）"""

    @patch('apps.users.auth.session_manager.UserSession')
    def test_select_for_update_in_cleanup_chain(self, mock_user_session):
        """_cleanup_old_sessions 应调用 select_for_update"""
        mock_user = MagicMock()
        mock_user.username = 'test'
        mock_user.id = 'user-1'

        # 构造链式调用：select_for_update().filter().order_by().values_list()
        mock_order_by = MagicMock()
        mock_order_by.values_list.return_value = ['id1', 'id2', 'id3', 'id4', 'id5']
        mock_filter = MagicMock()
        mock_filter.order_by.return_value = mock_order_by
        mock_select_for_update = MagicMock()
        mock_select_for_update.filter.return_value = mock_filter
        mock_user_session.objects.select_for_update.return_value = mock_select_for_update

        mock_user_session.objects.filter.return_value.update.return_value = 2

        SessionManager._cleanup_old_sessions(mock_user, keep_recent=3)

        mock_user_session.objects.select_for_update.assert_called_once()
        mock_select_for_update.filter.assert_called_once_with(user=mock_user, is_active=True)
        mock_filter.order_by.assert_called_once_with('-created_at')
        mock_user_session.objects.filter.return_value.update.assert_called_once_with(is_active=False)


class TestCA24SessionsBeyondKeepRecentCleaned(TestCase):
    """CA-24: 超过 keep_recent 的会话被正确清理"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="ca24_clean@test.com", password="TestPass123!"
        )

    def test_old_sessions_beyond_keep_recent_are_deactivated(self):
        """超过 keep_recent 的旧会话应被标记为 is_active=False"""
        # 创建 5 个活跃会话
        sessions = []
        for i in range(5):
            s = _create_session_directly(
                self.user,
                raw_key=f"ca24_clean_key_{i}",
            )
            sessions.append(s)

        with transaction.atomic():
            SessionManager._cleanup_old_sessions(self.user, keep_recent=3)

        # 按 created_at 降序，保留前 3 个，清理后 2 个
        active_count = UserSession.objects.filter(user=self.user, is_active=True).count()
        self.assertEqual(active_count, 3, "应保留最近 3 个会话")

        inactive_ids = list(
            UserSession.objects.filter(user=self.user, is_active=False).values_list('id', flat=True)
        )
        self.assertEqual(len(inactive_ids), 2, "应清理 2 个旧会话")


class TestCA24SessionsWithinKeepRecentNotCleaned(TestCase):
    """CA-24: 在 keep_recent 以内的会话不被清理"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="ca24_keep@test.com", password="TestPass123!"
        )

    def test_sessions_within_keep_recent_remain_active(self):
        """在 keep_recent 以内的会话应保持活跃"""
        # 创建 2 个活跃会话，keep_recent=3
        for i in range(2):
            _create_session_directly(self.user, raw_key=f"ca24_keep_key_{i}")

        with transaction.atomic():
            SessionManager._cleanup_old_sessions(self.user, keep_recent=3)

        active_count = UserSession.objects.filter(user=self.user, is_active=True).count()
        self.assertEqual(active_count, 2, "2 个会话均在 keep_recent 内，应全部保留")

    def test_exactly_keep_recent_sessions_remain_active(self):
        """恰好 keep_recent 个会话时，全部保留"""
        for i in range(3):
            _create_session_directly(self.user, raw_key=f"ca24_exact_key_{i}")

        with transaction.atomic():
            SessionManager._cleanup_old_sessions(self.user, keep_recent=3)

        active_count = UserSession.objects.filter(user=self.user, is_active=True).count()
        self.assertEqual(active_count, 3, "恰好 3 个会话应全部保留")


class TestActiveSessionLimit(TestCase):
    """新登录完成后，同一账号最多保留 10 个活跃会话。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="session_limit@test.com", password="TestPass123!"
        )
        self.request = SimpleNamespace(
            META={
                "HTTP_USER_AGENT": "test-agent",
                "HTTP_X_CLIENT_TYPE": "electron",
                "REMOTE_ADDR": "127.0.0.1",
            }
        )

    def _create_active_sessions(self, count):
        created_at = timezone.now() - timedelta(days=1)
        sessions = []
        for index in range(count):
            session = _create_session_directly(
                self.user,
                raw_key=f"session_limit_key_{index}",
            )
            UserSession.objects.filter(pk=session.pk).update(
                created_at=created_at + timedelta(minutes=index)
            )
            sessions.append(session)
        return sessions

    def test_tenth_login_keeps_all_ten_sessions_active(self):
        self._create_active_sessions(MAX_ACTIVE_SESSIONS - 1)

        new_session = SessionManager.create_session(self.user, self.request)

        active_sessions = UserSession.objects.filter(user=self.user, is_active=True)
        self.assertEqual(active_sessions.count(), MAX_ACTIVE_SESSIONS)
        self.assertTrue(active_sessions.filter(pk=new_session.pk).exists())

    def test_eleventh_login_deactivates_oldest_session(self):
        existing_sessions = self._create_active_sessions(MAX_ACTIVE_SESSIONS)

        new_session = SessionManager.create_session(self.user, self.request)

        active_sessions = UserSession.objects.filter(user=self.user, is_active=True)
        self.assertEqual(active_sessions.count(), MAX_ACTIVE_SESSIONS)
        self.assertTrue(active_sessions.filter(pk=new_session.pk).exists())
        existing_sessions[0].refresh_from_db()
        self.assertFalse(existing_sessions[0].is_active)

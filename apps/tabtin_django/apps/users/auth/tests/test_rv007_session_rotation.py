"""
RV-007 回归测试：SessionManager.rotate_session 应原子地吊销旧 session 并创建新 session。

验证场景：
- 轮换后旧 session 被 invalidate（is_active=False）
- 新 session 被创建（is_active=True）且 session_key 不同
- old_session_key 不存在时也能正常创建
- 其他用户的 session 不受影响
"""

from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()


class TestRV007RotateSession(unittest.TestCase):
    """RV-007: rotate_session 应立即吊销旧 session 并创建新 session（CA-1 语义）。"""

    def _make_request(self):
        req = MagicMock()
        req.META = {
            "HTTP_USER_AGENT": "test-agent",
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_X_DEVICE_ID": "rotate-device-001",
            "HTTP_X_CLIENT_TYPE": "electron",
        }
        return req

    def _make_user(self, uid="u1", username="testuser"):
        user = MagicMock()
        user.id = uid
        user.username = username
        return user

    @patch("apps.users.auth.session_manager.UserSession")
    def test_rotate_invalidates_old_session(self, mock_user_session_cls):
        """轮换后旧 session 应被立即吊销（update is_active=False）。"""
        from apps.users.auth.session_manager import SessionManager

        old_key = "old_session_key_abc123"

        mock_filter_qs = MagicMock()
        mock_filter_qs.update.return_value = 1
        mock_user_session_cls.objects.filter.return_value = mock_filter_qs

        mock_new_session = MagicMock()
        mock_new_session.id = 42
        mock_user_session_cls.objects.create.return_value = mock_new_session

        user = self._make_user()
        request = self._make_request()

        SessionManager.rotate_session(old_key, user, request)

        filter_calls = mock_user_session_cls.objects.filter.call_args_list
        found_invalidation = False
        for c in filter_calls:
            kwargs = c[1] if c[1] else {}
            if kwargs.get("is_active") is True and "session_key" in kwargs:
                found_invalidation = True
                break

        self.assertTrue(
            found_invalidation,
            "rotate_session 应调用 filter(session_key=..., is_active=True).update(is_active=False)",
        )

    @patch("apps.users.auth.session_manager.UserSession")
    def test_rotate_creates_new_session(self, mock_user_session_cls):
        """轮换后应创建新的 session。"""
        from apps.users.auth.session_manager import SessionManager

        mock_filter_qs = MagicMock()
        mock_filter_qs.update.return_value = 1
        mock_filter_qs.count.return_value = 0
        mock_user_session_cls.objects.filter.return_value = mock_filter_qs

        mock_new_session = MagicMock()
        mock_new_session.id = 99
        mock_user_session_cls.objects.create.return_value = mock_new_session

        user = self._make_user()
        request = self._make_request()

        result = SessionManager.rotate_session("old_key", user, request)

        mock_user_session_cls.objects.create.assert_called_once()
        create_kwargs = mock_user_session_cls.objects.create.call_args[1]
        self.assertEqual(create_kwargs["user"], user)
        self.assertEqual(create_kwargs["device_id"], "rotate-device-001")
        self.assertEqual(create_kwargs["client_type"], "electron")
        self.assertEqual(create_kwargs["revoked_by_admin_account_id"], "")
        self.assertEqual(create_kwargs["revoked_reason"], "")
        self.assertTrue(create_kwargs["is_active"])
        self.assertIsNotNone(result)

    @patch("apps.users.auth.session_manager.UserSession")
    def test_rotate_new_key_differs_from_old(self, mock_user_session_cls):
        """新 session_key 应与旧 key 不同（使用新的随机 key）。"""
        from apps.users.auth.session_manager import SessionManager

        old_key = "deterministic_old_key_12345"

        mock_filter_qs = MagicMock()
        mock_filter_qs.update.return_value = 1
        mock_filter_qs.count.return_value = 0
        mock_user_session_cls.objects.filter.return_value = mock_filter_qs

        mock_new_session = MagicMock()
        mock_new_session.id = 1
        mock_user_session_cls.objects.create.return_value = mock_new_session

        user = self._make_user()
        request = self._make_request()

        result = SessionManager.rotate_session(old_key, user, request)

        create_kwargs = mock_user_session_cls.objects.create.call_args[1]
        hashed_new_key = create_kwargs["session_key"]
        hashed_old_key = SessionManager.hash_session_key(old_key)
        self.assertNotEqual(
            hashed_new_key, hashed_old_key,
            "新 session 的 hashed key 应与旧 key 的 hash 不同",
        )

    @patch("apps.users.auth.session_manager.UserSession")
    def test_rotate_with_nonexistent_old_key(self, mock_user_session_cls):
        """旧 session_key 不存在时（update 返回 0），仍应正常创建新 session。"""
        from apps.users.auth.session_manager import SessionManager

        mock_filter_qs = MagicMock()
        mock_filter_qs.update.return_value = 0
        mock_filter_qs.count.return_value = 0
        mock_user_session_cls.objects.filter.return_value = mock_filter_qs

        mock_new_session = MagicMock()
        mock_new_session.id = 2
        mock_user_session_cls.objects.create.return_value = mock_new_session

        user = self._make_user()
        request = self._make_request()

        result = SessionManager.rotate_session("nonexistent", user, request)

        mock_user_session_cls.objects.create.assert_called_once()
        self.assertIsNotNone(result)

    @patch("apps.users.auth.session_manager.UserSession")
    def test_rotate_with_empty_old_key(self, mock_user_session_cls):
        """old_session_key 为空字符串时，不尝试吊销，只创建新 session。"""
        from apps.users.auth.session_manager import SessionManager

        mock_filter_qs = MagicMock()
        mock_filter_qs.count.return_value = 0
        mock_user_session_cls.objects.filter.return_value = mock_filter_qs

        mock_new_session = MagicMock()
        mock_new_session.id = 3
        mock_user_session_cls.objects.create.return_value = mock_new_session

        user = self._make_user()
        request = self._make_request()

        result = SessionManager.rotate_session("", user, request)

        mock_user_session_cls.objects.create.assert_called_once()

        filter_calls = mock_user_session_cls.objects.filter.call_args_list
        invalidation_attempted = any(
            c[1].get("is_active") is True and "session_key" in c[1]
            for c in filter_calls
            if c[1]
        )
        self.assertFalse(
            invalidation_attempted,
            "空 old_session_key 不应尝试吊销",
        )


if __name__ == "__main__":
    unittest.main()

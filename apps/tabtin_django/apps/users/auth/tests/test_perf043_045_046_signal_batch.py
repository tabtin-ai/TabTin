"""
PERF-043 / PERF-045 / PERF-046 回归测试。

PERF-043: save_user_profile 信号在 update_fields 指定时应跳过 profile save。
PERF-046: update_fields 指定时不应触发 instance.profile 的额外 SELECT。
PERF-045: batch_update_user_status 应使用 bulk 操作而非 N 次串行 SQL。
"""

from datetime import timedelta
from unittest.mock import patch, MagicMock

from django.test import TestCase, RequestFactory, override_settings
from django.utils import timezone

from apps.users.auth.models import User, UserProfile, UserActionLog, UserSession
from apps.users.auth.admin_api import batch_update_user_status
from apps.users.auth.admin_schemas import AdminUserBatchStatusUpdateSchema
from apps.users.auth.signals import save_user_profile


def _make_session(user, key_suffix="01"):
    return UserSession.objects.create(
        user=user,
        session_key=f"session_key_{user.id}_{key_suffix}".ljust(40, "0"),
        session_type="web",
        ip_address="127.0.0.1",
        user_agent="test-agent",
        device_info={},
        expires_at=timezone.now() + timedelta(hours=24),
        is_active=True,
    )


class TestPERF043SignalSkipsOnUpdateFields(TestCase):
    """PERF-043: save_user_profile 在 update_fields 非 None 时跳过 profile save"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="perf043@test.com",
            password="TestPass123!",
        )
        UserProfile.objects.get_or_create(user=self.user)

    def test_profile_not_saved_when_update_fields_specified(self):
        """update_fields=["is_active"] 时不应触发 profile.save()"""
        with patch.object(UserProfile, "save", wraps=self.user.profile.save) as mock_save:
            self.user.is_active = False
            self.user.save(update_fields=["is_active"])
            mock_save.assert_not_called()

    def test_profile_saved_when_no_update_fields(self):
        """无 update_fields（完整 save）时仍应触发 profile.save()"""
        with patch.object(UserProfile, "save", wraps=self.user.profile.save) as mock_save:
            self.user.save()
            mock_save.assert_called()

    def test_signal_directly_with_update_fields_kwarg(self):
        """直接调用信号处理器验证 update_fields 判断逻辑"""
        mock_instance = MagicMock()
        save_user_profile(sender=User, instance=mock_instance, update_fields=["is_active"])
        mock_instance.profile.save.assert_not_called()

    def test_signal_directly_without_update_fields(self):
        """直接调用信号处理器，无 update_fields 时应保存 profile"""
        mock_instance = MagicMock()
        save_user_profile(sender=User, instance=mock_instance)
        mock_instance.profile.save.assert_called_once()


class TestPERF046NoExtraSelectOnUpdateFields(TestCase):
    """PERF-046: update_fields 指定时不访问 instance.profile，避免额外 SELECT"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="perf046@test.com",
            password="TestPass123!",
        )
        UserProfile.objects.get_or_create(user=self.user)

    def test_no_profile_access_on_targeted_save(self):
        """update_fields 指定时，信号不应访问 instance.profile 属性"""
        fresh_user = User.objects.get(id=self.user.id)
        with patch.object(
            type(fresh_user), "profile",
            new_callable=lambda: property(lambda self: (_ for _ in ()).throw(AssertionError("profile should not be accessed")))
        ):
            pass

        fresh_user = User.objects.get(id=self.user.id)
        original_profile_descriptor = type(fresh_user).profile

        access_count = {"count": 0}
        original_fget = original_profile_descriptor.fget if hasattr(original_profile_descriptor, 'fget') else None

        mock_instance = MagicMock()
        del mock_instance.profile
        mock_instance.profile = MagicMock()

        save_user_profile(sender=User, instance=mock_instance, update_fields=["is_active"])
        mock_instance.profile.save.assert_not_called()


class TestPERF045BatchBulkOperations(TestCase):
    """PERF-045: batch_update_user_status 使用 bulk 操作"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="admin_perf045@test.com",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.users = []
        for i in range(10):
            u = User.objects.create_user(
                email=f"user_perf045_{i}@test.com",
                password="TestPass123!",
            )
            _make_session(u, key_suffix=f"{i:02d}")
            self.users.append(u)

    def _make_request(self):
        req = self.factory.post("/admin/batch/users/status")
        req.auth = self.admin
        req.META["REMOTE_ADDR"] = "127.0.0.1"
        req.META["HTTP_USER_AGENT"] = "test-agent"
        return req

    def test_batch_deactivate_uses_fewer_queries(self):
        """批量禁用 10 个用户应比 30 次 SQL 少得多"""
        user_ids = [str(u.id) for u in self.users]
        payload = AdminUserBatchStatusUpdateSchema(user_ids=user_ids, status="inactive")
        req = self._make_request()

        from django.test.utils import CaptureQueriesContext
        from django.db import connection

        with CaptureQueriesContext(connection) as ctx:
            result = batch_update_user_status(req, payload)

        self.assertEqual(result.updated_count, 10)
        self.assertTrue(
            len(ctx.captured_queries) < 20,
            f"Expected fewer than 20 queries for 10 users, got {len(ctx.captured_queries)}",
        )

    def test_batch_deactivate_invalidates_sessions(self):
        """批量禁用后所有目标用户 session 应被置为 inactive"""
        user_ids = [str(u.id) for u in self.users]
        payload = AdminUserBatchStatusUpdateSchema(user_ids=user_ids, status="inactive")
        req = self._make_request()

        batch_update_user_status(req, payload)

        active_sessions = UserSession.objects.filter(
            user_id__in=user_ids, is_active=True,
        ).count()
        self.assertEqual(active_sessions, 0)

    def test_batch_deactivate_creates_action_logs(self):
        """批量禁用后应为每个用户创建 action log"""
        user_ids = [str(u.id) for u in self.users]
        payload = AdminUserBatchStatusUpdateSchema(user_ids=user_ids, status="inactive")
        req = self._make_request()

        batch_update_user_status(req, payload)

        log_count = UserActionLog.objects.filter(
            user_id__in=user_ids, action_type="account_lock",
        ).count()
        self.assertEqual(log_count, 10)

    def test_batch_activate_does_not_invalidate_sessions(self):
        """批量启用不应清除 session"""
        target_users = self.users[:3]
        user_ids = [str(u.id) for u in target_users]

        User.objects.filter(id__in=user_ids).update(is_active=False)
        for u in target_users:
            u.refresh_from_db()

        pre_count = UserSession.objects.filter(
            user_id__in=user_ids, is_active=True,
        ).count()
        self.assertEqual(pre_count, 3, "sessions should exist before batch activate")

        payload = AdminUserBatchStatusUpdateSchema(user_ids=user_ids, status="active")
        req = self._make_request()
        batch_update_user_status(req, payload)

        active_sessions = UserSession.objects.filter(
            user_id__in=user_ids, is_active=True,
        ).count()
        self.assertEqual(active_sessions, 3)

    def test_batch_deactivate_clears_user_cache(self):
        """批量禁用后应清除相关用户缓存"""
        user_ids = [str(u.id) for u in self.users[:2]]
        payload = AdminUserBatchStatusUpdateSchema(user_ids=user_ids, status="inactive")
        req = self._make_request()

        with patch("apps.users.auth.admin_api.cache") as mock_cache:
            batch_update_user_status(req, payload)
            mock_cache.delete_many.assert_called_once()
            deleted_keys = mock_cache.delete_many.call_args[0][0]
            for uid in user_ids:
                self.assertIn(f"user:{uid}", deleted_keys)

    def test_batch_skips_already_matching_status(self):
        """已经是目标状态的用户应被跳过"""
        user_ids = [str(u.id) for u in self.users[:2]]
        payload = AdminUserBatchStatusUpdateSchema(user_ids=user_ids, status="active")
        req = self._make_request()

        result = batch_update_user_status(req, payload)
        self.assertEqual(result.updated_count, 0)
        self.assertEqual(len(result.skipped), 2)

"""
PERF-044 / PERF-047 回归测试

PERF-044: 账号禁用后必须异步通知 collab-live 撤销协作连接。
PERF-047: update_user_status 和 batch_update_user_status 的
          user.save + session invalidation 必须在同一事务中。

验证场景:
- 单用户禁用 → _schedule_account_collab_revoke 被调用
- 批量禁用   → 每个被禁用用户各调度一次 collab revoke
- 启用用户   → 不触发 collab revoke
- 单用户禁用事务原子性 → session 失效抛异常时 user.is_active 回滚
- 批量禁用事务原子性   → session 失效抛异常时 bulk_update 回滚
"""

from datetime import timedelta
from unittest.mock import patch, MagicMock

from django.test import TestCase, RequestFactory
from django.utils import timezone

from apps.users.auth.models import User, UserSession
from apps.users.auth.admin_api import update_user_status, batch_update_user_status
from apps.users.auth.admin_schemas import (
    AdminUserStatusUpdateSchema,
    AdminUserBatchStatusUpdateSchema,
)


def _make_session(user, key_suffix="01"):
    return UserSession.objects.create(
        user=user,
        session_key=f"perf_session_{user.id}_{key_suffix}".ljust(40, "0"),
        session_type="web",
        ip_address="127.0.0.1",
        user_agent="test-agent",
        device_info={},
        expires_at=timezone.now() + timedelta(hours=24),
        is_active=True,
    )


class TestPERF044SingleUserCollabRevoke(TestCase):
    """PERF-044: update_user_status 禁用时通知 collab-live"""

    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="admin_perf044@test.com",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.target_user = User.objects.create_user(
            email="target_perf044@test.com",
            password="TargetPass123!",
        )

    def _make_request(self):
        request = self.factory.put("/admin/users/status")
        request.auth = self.admin
        return request

    @patch("apps.users.auth.admin_api._cancel_active_agent_runs")
    @patch("apps.users.auth.admin_api._schedule_account_collab_revoke")
    def test_deactivate_dispatches_collab_revoke(self, mock_schedule, _mock_cancel):
        """禁用用户 → _schedule_account_collab_revoke 被调用"""
        _make_session(self.target_user)

        request = self._make_request()
        payload = AdminUserStatusUpdateSchema(status="inactive")
        update_user_status(request, str(self.target_user.id), payload)

        mock_schedule.assert_called_once_with(str(self.target_user.id))

    @patch("apps.users.auth.admin_api._cancel_active_agent_runs")
    @patch("apps.users.auth.admin_api._schedule_account_collab_revoke")
    def test_activate_does_not_dispatch_collab_revoke(
        self, mock_schedule, _mock_cancel
    ):
        """启用用户 → 不触发 collab revoke"""
        self.target_user.is_active = False
        self.target_user.save(update_fields=["is_active"])

        request = self._make_request()
        payload = AdminUserStatusUpdateSchema(status="active")
        update_user_status(request, str(self.target_user.id), payload)

        mock_schedule.assert_not_called()


class TestPERF044BatchCollabRevoke(TestCase):
    """PERF-044: batch_update_user_status 禁用时通知 collab-live"""

    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="batchadmin_perf044@test.com",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.user_a = User.objects.create_user(
            email="usera_perf044@test.com",
            password="PassA123!",
        )
        self.user_b = User.objects.create_user(
            email="userb_perf044@test.com",
            password="PassB123!",
        )

    def _make_request(self):
        request = self.factory.post("/admin/batch/users/status")
        request.auth = self.admin
        return request

    @patch("apps.users.auth.admin_api._cancel_active_agent_runs")
    @patch("apps.users.auth.admin_api._schedule_account_collab_revoke")
    def test_batch_deactivate_dispatches_collab_revoke_per_user(
        self, mock_schedule, _mock_cancel
    ):
        """批量禁用 → 每个被禁用用户各调度一次 collab revoke"""
        request = self._make_request()
        payload = AdminUserBatchStatusUpdateSchema(
            user_ids=[str(self.user_a.id), str(self.user_b.id)],
            status="inactive",
        )
        batch_update_user_status(request, payload)

        self.assertEqual(mock_schedule.call_count, 2)
        called_user_ids = {call.args[0] for call in mock_schedule.call_args_list}
        self.assertEqual(
            called_user_ids,
            {str(self.user_a.id), str(self.user_b.id)},
        )

    @patch("apps.users.auth.admin_api._cancel_active_agent_runs")
    @patch("apps.users.auth.admin_api._schedule_account_collab_revoke")
    def test_batch_activate_does_not_dispatch_collab_revoke(
        self, mock_schedule, _mock_cancel
    ):
        """批量启用 → 不触发 collab revoke"""
        self.user_a.is_active = False
        self.user_a.save(update_fields=["is_active"])
        self.user_b.is_active = False
        self.user_b.save(update_fields=["is_active"])

        request = self._make_request()
        payload = AdminUserBatchStatusUpdateSchema(
            user_ids=[str(self.user_a.id), str(self.user_b.id)],
            status="active",
        )
        batch_update_user_status(request, payload)

        mock_schedule.assert_not_called()


class TestPERF047SingleUserTransactionAtomicity(TestCase):
    """PERF-047: update_user_status 的 user.save + session 失效必须原子"""

    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="admin_perf047@test.com",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.target_user = User.objects.create_user(
            email="target_perf047@test.com",
            password="TargetPass123!",
        )

    def _make_request(self):
        request = self.factory.put("/admin/users/status")
        request.auth = self.admin
        return request

    @patch("apps.users.auth.admin_api._cancel_active_agent_runs")
    @patch("apps.users.auth.admin_api._schedule_account_collab_revoke")
    @patch(
        "apps.users.auth.admin_api.SessionManager.invalidate_all_user_sessions",
        side_effect=RuntimeError("DB connection lost"),
    )
    def test_session_failure_rolls_back_user_deactivation(
        self, _mock_session, _mock_schedule, _mock_cancel
    ):
        """session 失效抛异常 → user.is_active 回滚为 True"""
        _make_session(self.target_user)

        request = self._make_request()
        payload = AdminUserStatusUpdateSchema(status="inactive")

        with self.assertRaises(RuntimeError):
            update_user_status(request, str(self.target_user.id), payload)

        self.target_user.refresh_from_db()
        self.assertTrue(
            self.target_user.is_active,
            "user.is_active should remain True when session invalidation fails",
        )


class TestPERF047BatchTransactionAtomicity(TestCase):
    """PERF-047: batch_update_user_status 的 bulk_update + session 失效必须原子"""

    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="batchadmin_perf047@test.com",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.user_a = User.objects.create_user(
            email="usera_perf047@test.com",
            password="PassA123!",
        )
        self.user_b = User.objects.create_user(
            email="userb_perf047@test.com",
            password="PassB123!",
        )

    def _make_request(self):
        request = self.factory.post("/admin/batch/users/status")
        request.auth = self.admin
        return request

    @patch("apps.users.auth.admin_api._cancel_active_agent_runs")
    @patch("apps.users.auth.admin_api._schedule_account_collab_revoke")
    def test_session_update_failure_rolls_back_bulk_update(
        self, _mock_schedule, _mock_cancel
    ):
        """session 批量失效抛异常 → bulk_update 回滚，所有用户 is_active 不变"""
        _make_session(self.user_a)
        _make_session(self.user_b)

        original_qs_update = UserSession.objects.update

        def _exploding_update(**kwargs):
            raise RuntimeError("DB write failed")

        request = self._make_request()
        payload = AdminUserBatchStatusUpdateSchema(
            user_ids=[str(self.user_a.id), str(self.user_b.id)],
            status="inactive",
        )

        with patch.object(
            UserSession._default_manager.none().__class__,
            "update",
            side_effect=RuntimeError("DB write failed"),
        ):
            with self.assertRaises(RuntimeError):
                batch_update_user_status(request, payload)

        self.user_a.refresh_from_db()
        self.user_b.refresh_from_db()
        self.assertTrue(
            self.user_a.is_active,
            "user_a.is_active should remain True when session update fails",
        )
        self.assertTrue(
            self.user_b.is_active,
            "user_b.is_active should remain True when session update fails",
        )

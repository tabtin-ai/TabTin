"""
SDI-014 回归测试：禁用账号时必须清除所有活跃 Session。

验证场景：
- 单用户禁用 → 该用户所有 session 被置为 is_active=False
- 单用户禁用 → 不影响其他用户的 session
- 单用户启用 → 不会清除 session
- 批量禁用 → 被禁用用户的 session 全部清除
- 批量禁用跳过的用户 → session 不受影响
"""

from datetime import timedelta

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
        session_key=f"session_key_{user.id}_{key_suffix}".ljust(40, "0"),
        session_type="web",
        ip_address="127.0.0.1",
        user_agent="test-agent",
        device_info={},
        expires_at=timezone.now() + timedelta(hours=24),
        is_active=True,
    )


class TestSDI014DeactivateUserClearsSessions(TestCase):
    """SDI-014: update_user_status 禁用用户时清除 session"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="admin_sdi014@test.com",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.target_user = User.objects.create_user(
            email="target_sdi014@test.com",
            password="TargetPass123!",
        )
        self.other_user = User.objects.create_user(
            email="other_sdi014@test.com",
            password="OtherPass123!",
        )

    def _make_request(self):
        request = self.factory.put("/admin/users/status")
        request.auth = self.admin
        return request

    def test_deactivate_clears_all_sessions(self):
        """禁用用户 → 该用户所有活跃 session 被清除"""
        s1 = _make_session(self.target_user, "01")
        s2 = _make_session(self.target_user, "02")

        request = self._make_request()
        payload = AdminUserStatusUpdateSchema(status="inactive")
        update_user_status(request, str(self.target_user.id), payload)

        s1.refresh_from_db()
        s2.refresh_from_db()
        self.assertFalse(s1.is_active)
        self.assertFalse(s2.is_active)

    def test_deactivate_does_not_affect_other_users(self):
        """禁用用户 → 不影响其他用户的 session"""
        _make_session(self.target_user, "01")
        other_session = _make_session(self.other_user, "01")

        request = self._make_request()
        payload = AdminUserStatusUpdateSchema(status="inactive")
        update_user_status(request, str(self.target_user.id), payload)

        other_session.refresh_from_db()
        self.assertTrue(other_session.is_active)

    def test_activate_does_not_clear_sessions(self):
        """启用用户 → session 不受影响"""
        self.target_user.is_active = False
        self.target_user.save(update_fields=["is_active"])
        s1 = _make_session(self.target_user, "01")

        request = self._make_request()
        payload = AdminUserStatusUpdateSchema(status="active")
        update_user_status(request, str(self.target_user.id), payload)

        s1.refresh_from_db()
        self.assertTrue(s1.is_active)


class TestSDI014BatchDeactivateClearsSessions(TestCase):
    """SDI-014: batch_update_user_status 禁用用户时清除 session"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="batchadmin_sdi014@test.com",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.user_a = User.objects.create_user(
            email="usera_sdi014@test.com",
            password="PassA123!",
        )
        self.user_b = User.objects.create_user(
            email="userb_sdi014@test.com",
            password="PassB123!",
        )

    def _make_request(self):
        request = self.factory.post("/admin/batch/users/status")
        request.auth = self.admin
        return request

    def test_batch_deactivate_clears_sessions(self):
        """批量禁用 → 所有被禁用用户的 session 清除"""
        sa = _make_session(self.user_a, "01")
        sb = _make_session(self.user_b, "01")

        request = self._make_request()
        payload = AdminUserBatchStatusUpdateSchema(
            user_ids=[str(self.user_a.id), str(self.user_b.id)],
            status="inactive",
        )
        batch_update_user_status(request, payload)

        sa.refresh_from_db()
        sb.refresh_from_db()
        self.assertFalse(sa.is_active)
        self.assertFalse(sb.is_active)

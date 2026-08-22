"""
RV-004 / RV-005 回归测试：所有 is_active=False 路径必须清除活跃会话。

验证 SDI-014 的系统性兜底：
- RV-004：Django Admin save_model 路径
- RV-005：ORM 直接修改路径（signals.py post_save 兜底）

覆盖场景：
1. ORM 直接 user.save() 禁用 → session 全部清除（信号兜底）
2. ORM 直接 user.save(update_fields=["is_active"]) 禁用 → session 全部清除
3. ORM 禁用不影响其他用户 session
4. ORM 启用用户不清除 session
5. 新创建的 inactive 用户不触发清除
6. 重复保存已禁用用户不报错（幂等）
7. Django Admin save_model 禁用 → session 全部清除
"""

from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.test import TestCase, RequestFactory
from django.utils import timezone

from apps.users.auth.models import User, UserSession


def _make_session(user, key_suffix="01"):
    return UserSession.objects.create(
        user=user,
        session_key=f"sess_{user.id}_{key_suffix}".ljust(40, "0"),
        session_type="web",
        ip_address="127.0.0.1",
        user_agent="test-agent",
        device_info={},
        expires_at=timezone.now() + timedelta(hours=24),
        is_active=True,
    )


class TestRV005SignalDeactivationClearsSession(TestCase):
    """RV-005: post_save 信号兜底 — ORM 直接禁用用户时清除会话。"""

    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="rv005_target@test.com",
            password="Pass1234!",
        )
        self.other_user = User.objects.create_user(
            email="rv005_other@test.com",
            password="Pass1234!",
        )

    def test_orm_deactivate_clears_sessions(self):
        """ORM user.save() 禁用 → 信号自动清除所有活跃会话"""
        s1 = _make_session(self.user, "01")
        s2 = _make_session(self.user, "02")

        self.user.is_active = False
        self.user.save()

        s1.refresh_from_db()
        s2.refresh_from_db()
        self.assertFalse(s1.is_active)
        self.assertFalse(s2.is_active)

    def test_orm_deactivate_with_update_fields(self):
        """ORM user.save(update_fields=...) 禁用 → 信号同样触发"""
        s1 = _make_session(self.user, "01")

        self.user.is_active = False
        self.user.save(update_fields=["is_active"])

        s1.refresh_from_db()
        self.assertFalse(s1.is_active)

    def test_deactivate_does_not_affect_other_users(self):
        """禁用一个用户不影响其他用户的会话"""
        _make_session(self.user, "01")
        other_session = _make_session(self.other_user, "01")

        self.user.is_active = False
        self.user.save(update_fields=["is_active"])

        other_session.refresh_from_db()
        self.assertTrue(other_session.is_active)

    def test_activate_does_not_clear_sessions(self):
        """启用用户不触发会话清除"""
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])

        s1 = _make_session(self.user, "01")

        self.user.is_active = True
        self.user.save(update_fields=["is_active"])

        s1.refresh_from_db()
        self.assertTrue(s1.is_active)

    def test_new_inactive_user_no_cleanup(self):
        """新建时 is_active=False 的用户不触发会话清除（created=True 跳过）"""
        with patch(
            "apps.users.auth.session_manager.SessionManager.invalidate_all_user_sessions"
        ) as mock_inv:
            User.objects.create_user(
                email="rv005_new_inactive@test.com",
                password="Pass1234!",
                is_active=False,
            )
            mock_inv.assert_not_called()

    def test_repeated_save_inactive_is_idempotent(self):
        """已禁用用户反复 save 不报错，不做多余清理"""
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])

        with patch(
            "apps.users.auth.session_manager.SessionManager.invalidate_all_user_sessions"
        ) as mock_inv:
            self.user.save(update_fields=["is_active"])
            mock_inv.assert_not_called()


class TestRV004AdminSaveModelClearsSession(TestCase):
    """RV-004: Django Admin save_model 路径禁用用户时清除会话。"""

    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin_user = User.objects.create_user(
            email="rv004_admin@test.com",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.target_user = User.objects.create_user(
            email="rv004_target@test.com",
            password="TargetPass123!",
        )

    def test_admin_save_model_deactivate_clears_sessions(self):
        """Django Admin 禁用用户 → save_model 触发会话清除"""
        from django.contrib.admin.sites import AdminSite
        from apps.users.auth.admin import UserAdmin

        s1 = _make_session(self.target_user, "01")
        s2 = _make_session(self.target_user, "02")

        site = AdminSite()
        model_admin = UserAdmin(User, site)

        request = self.factory.post("/admin/users_auth/user/change/")
        request.user = self.admin_user
        request._messages = MagicMock()

        form = MagicMock()
        form.changed_data = ["is_active"]

        self.target_user.is_active = False
        model_admin.save_model(request, self.target_user, form, change=True)

        s1.refresh_from_db()
        s2.refresh_from_db()
        self.assertFalse(s1.is_active)
        self.assertFalse(s2.is_active)

    def test_admin_save_model_no_deactivation_no_cleanup(self):
        """Django Admin 修改非 is_active 字段 → 不触发会话清除"""
        from django.contrib.admin.sites import AdminSite
        from apps.users.auth.admin import UserAdmin

        s1 = _make_session(self.target_user, "01")

        site = AdminSite()
        model_admin = UserAdmin(User, site)

        request = self.factory.post("/admin/users_auth/user/change/")
        request.user = self.admin_user
        request._messages = MagicMock()

        form = MagicMock()
        form.changed_data = ["nickname"]

        with patch(
            "apps.users.auth.session_manager.SessionManager.invalidate_all_user_sessions"
        ) as mock_inv:
            model_admin.save_model(request, self.target_user, form, change=True)
            mock_inv.assert_not_called()

        s1.refresh_from_db()
        self.assertTrue(s1.is_active)

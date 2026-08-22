from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import RequestFactory, TestCase

from apps.users.auth.admin_api import (
    _resolve_admin_permissions,
    _sync_admin_account_roles,
    update_admin_account,
)
from apps.users.auth.admin_schemas import AdminAccountUpdateRequestSchema
from apps.users.auth.models import AdminAccount, AdminAccountRole, AdminRole, User
from apps.users.auth.permissions import (
    JWTAuth,
    StaffAuth,
    SuperuserAuth,
    user_has_admin_staff_access,
    user_has_admin_superuser_access,
)


class SuperAdminLegacyFlagsTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.super_role, _ = AdminRole.objects.get_or_create(
            code="super_admin",
            defaults={
                "name": "Super Admin",
                "description": "all permissions",
                "is_system": True,
                "is_active": True,
            },
        )
        self.support_role, _ = AdminRole.objects.get_or_create(
            code="support_agent",
            defaults={
                "name": "Support Agent",
                "description": "support",
                "is_system": True,
                "is_active": True,
            },
        )

    def _create_admin_account(self, user: User) -> AdminAccount:
        return AdminAccount.objects.create(
            user=user,
            display_name=user.get_display_name(),
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=user,
        )

    def test_assign_super_admin_sets_user_legacy_flags(self):
        user = User.objects.create_user(
            username="legacy_super_assign",
            email="legacy-super-assign@test.com",
            password="test-pass-123",
            is_staff=False,
            is_superuser=False,
        )
        account = self._create_admin_account(user)

        _sync_admin_account_roles(
            account,
            ["super_admin"],
            actor_account=None,
            reason="test assign super_admin",
        )

        user.refresh_from_db()
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)

        result = _resolve_admin_permissions(user)
        self.assertEqual(result["permissions"], ["*"])
        self.assertTrue(result["is_superuser"])
        self.assertEqual(result["role"], "super_admin")

    def test_demote_super_admin_clears_is_superuser_keeps_staff(self):
        # 保留另一个超管，避免触发「最后一个 Super Admin」保护
        keeper = User.objects.create_superuser(
            username="legacy_super_keeper",
            email="legacy-super-keeper@test.com",
            password="test-pass-123",
        )
        keeper_account = self._create_admin_account(keeper)
        AdminAccountRole.objects.create(admin_account=keeper_account, role=self.super_role)

        user = User.objects.create_user(
            username="legacy_super_demote",
            email="legacy-super-demote@test.com",
            password="test-pass-123",
            is_staff=True,
            is_superuser=True,
        )
        account = self._create_admin_account(user)
        AdminAccountRole.objects.create(admin_account=account, role=self.super_role)

        _sync_admin_account_roles(
            account,
            ["support_agent"],
            actor_account=None,
            reason="test demote",
        )

        user.refresh_from_db()
        self.assertTrue(user.is_staff)
        self.assertFalse(user.is_superuser)

        result = _resolve_admin_permissions(user)
        self.assertFalse(result["is_superuser"])
        self.assertNotEqual(result["permissions"], ["*"])

    def test_rbac_super_admin_without_user_flag_still_projects_wildcard(self):
        """历史脏数据：角色已是 super_admin，但 User 标记未写。"""
        user = User.objects.create_user(
            username="legacy_super_stale",
            email="legacy-super-stale@test.com",
            password="test-pass-123",
            is_staff=False,
            is_superuser=False,
        )
        account = self._create_admin_account(user)
        AdminAccountRole.objects.create(admin_account=account, role=self.super_role)

        result = _resolve_admin_permissions(user)
        self.assertEqual(result["permissions"], ["*"])
        self.assertTrue(result["is_superuser"])

    def test_disable_admin_account_via_api_clears_legacy_flags(self):
        keeper = User.objects.create_superuser(
            username="legacy_super_disable_keeper",
            email="legacy-super-disable-keeper@test.com",
            password="test-pass-123",
        )
        keeper_account = self._create_admin_account(keeper)
        AdminAccountRole.objects.create(admin_account=keeper_account, role=self.super_role)

        user = User.objects.create_user(
            username="legacy_super_disable",
            email="legacy-super-disable@test.com",
            password="test-pass-123",
            is_staff=True,
            is_superuser=True,
        )
        account = self._create_admin_account(user)
        AdminAccountRole.objects.create(admin_account=account, role=self.super_role)

        request = RequestFactory().put(f"/auth/admin/admin-accounts/{account.id}")
        request.auth = keeper
        request.admin_account = keeper_account
        update_admin_account(
            request,
            str(account.id),
            AdminAccountUpdateRequestSchema(
                status=AdminAccount.STATUS_DISABLED,
                admin_login_enabled=False,
                reason="disable via api",
            ),
        )

        user.refresh_from_db()
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)

    def test_staff_and_superuser_auth_accept_rbac_without_user_flags(self):
        user = User.objects.create_user(
            username="legacy_auth_stale",
            email="legacy-auth-stale@test.com",
            password="test-pass-123",
            is_staff=False,
            is_superuser=False,
        )
        account = self._create_admin_account(user)
        AdminAccountRole.objects.create(admin_account=account, role=self.super_role)

        self.assertTrue(user_has_admin_staff_access(user))
        self.assertTrue(user_has_admin_superuser_access(user))

        plain = User.objects.create_user(
            username="legacy_auth_plain",
            email="legacy-auth-plain@test.com",
            password="test-pass-123",
            is_staff=False,
            is_superuser=False,
        )
        self.assertFalse(user_has_admin_staff_access(plain))
        self.assertFalse(user_has_admin_superuser_access(plain))

        request = RequestFactory().get("/auth/admin/probe")
        with patch.object(JWTAuth, "authenticate", return_value=user):
            self.assertEqual(SuperuserAuth().authenticate(request, "tok"), user)
            self.assertEqual(StaffAuth().authenticate(request, "tok"), user)

    def test_sync_admin_legacy_user_flags_command_backfills(self):
        user = User.objects.create_user(
            username="legacy_super_cmd",
            email="legacy-super-cmd@test.com",
            password="test-pass-123",
            is_staff=False,
            is_superuser=False,
        )
        account = self._create_admin_account(user)
        AdminAccountRole.objects.create(admin_account=account, role=self.super_role)

        output = StringIO()
        call_command("sync_admin_legacy_user_flags", stdout=output)
        user.refresh_from_db()
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)
        self.assertIn('"changed": 1', output.getvalue())

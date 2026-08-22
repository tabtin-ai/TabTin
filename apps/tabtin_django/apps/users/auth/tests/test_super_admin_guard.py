from django.test import RequestFactory, TestCase
from ninja.errors import HttpError

from apps.users.auth.models import (
    AdminAccount,
    AdminAccountRole,
    AdminPermission,
    AdminRole,
    User,
)
from apps.users.auth.permissions import AdminPermissionAuth
from apps.users.auth.services.admin_guard import (
    LAST_SUPER_ADMIN_CANNOT_BE_DISABLED,
    LAST_SUPER_ADMIN_ROLE_CANNOT_BE_REMOVED,
    ensure_active_super_admin_not_lost,
)
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token


class SuperAdminGuardTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.super_role, _ = AdminRole.objects.get_or_create(
            code="super_admin",
            defaults={
                "name": "Super Admin",
                "description": "all permissions",
                "is_system": True,
                "is_active": True,
            },
        )

    def _create_active_super_admin_account(self, username: str) -> AdminAccount:
        user = User.objects.create_user(
            username=username,
            email=f"{username}@test.com",
            password="test-pass-123",
            is_staff=True,
            is_active=True,
        )
        account = AdminAccount.objects.create(
            user=user,
            display_name=username,
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=user,
        )
        AdminAccountRole.objects.create(
            admin_account=account,
            role=self.super_role,
            reason="test-setup",
        )
        return account

    def test_cannot_disable_last_active_super_admin(self):
        account = self._create_active_super_admin_account("guard_last_disable")

        with self.assertRaises(HttpError) as cm:
            ensure_active_super_admin_not_lost(
                account,
                next_status=AdminAccount.STATUS_DISABLED,
            )

        self.assertEqual(cm.exception.status_code, 409)
        self.assertEqual(cm.exception.message["code"], LAST_SUPER_ADMIN_CANNOT_BE_DISABLED)

    def test_cannot_turn_off_login_for_last_active_super_admin(self):
        account = self._create_active_super_admin_account("guard_last_login")

        with self.assertRaises(HttpError) as cm:
            ensure_active_super_admin_not_lost(
                account,
                next_admin_login_enabled=False,
            )

        self.assertEqual(cm.exception.status_code, 409)
        self.assertEqual(cm.exception.message["code"], LAST_SUPER_ADMIN_CANNOT_BE_DISABLED)

    def test_cannot_remove_last_super_admin_role(self):
        account = self._create_active_super_admin_account("guard_last_role")

        with self.assertRaises(HttpError) as cm:
            ensure_active_super_admin_not_lost(
                account,
                next_role_codes=[],
            )

        self.assertEqual(cm.exception.status_code, 409)
        self.assertEqual(cm.exception.message["code"], LAST_SUPER_ADMIN_ROLE_CANNOT_BE_REMOVED)

    def test_can_disable_one_super_admin_when_another_active_super_admin_exists(self):
        first = self._create_active_super_admin_account("guard_first")
        self._create_active_super_admin_account("guard_second")

        # Should not raise: another active super admin still exists.
        ensure_active_super_admin_not_lost(
            first,
            next_status=AdminAccount.STATUS_DISABLED,
        )

    def test_admin_permission_auth_requires_active_admin_account(self):
        user = User.objects.create_user(
            username="auth_guard_user",
            email="auth_guard_user@test.com",
            password="test-pass-123",
            is_staff=True,
            is_active=True,
        )
        session = SessionManager.create_session(
            user=user,
            request=self.factory.get("/"),
            session_type="web",
            expire_hours=24,
        )
        token = generate_jwt_token(user, session_key=session.session_key)

        auth = AdminPermissionAuth("credit_ledger:view")
        request = self.factory.get("/api/services/billing/admin/billing/organizations/ws/credit-ledger")

        with self.assertRaises(HttpError) as cm_no_account:
            auth.authenticate(request, token)
        self.assertEqual(cm_no_account.exception.status_code, 403)
        self.assertEqual(cm_no_account.exception.message["code"], "ADMIN_ACCOUNT_REQUIRED")

        account = AdminAccount.objects.create(
            user=user,
            display_name="auth guard",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=user,
        )

        with self.assertRaises(HttpError) as cm_no_permission:
            auth.authenticate(request, token)
        self.assertEqual(cm_no_permission.exception.status_code, 403)
        self.assertEqual(cm_no_permission.exception.message["code"], "ADMIN_PERMISSION_DENIED")

        permission, _ = AdminPermission.objects.get_or_create(
            code="credit_ledger:view",
            defaults={"name": "查看点券流水", "category": "credit", "risk_level": "medium"},
        )
        role, _ = AdminRole.objects.get_or_create(
            code="support_agent",
            defaults={"name": "Support Agent", "description": "support", "is_system": True, "is_active": True},
        )
        role.permissions.add(permission)
        AdminAccountRole.objects.get_or_create(
            admin_account=account,
            role=role,
            defaults={"reason": "test-bind"},
        )

        authed_user = auth.authenticate(request, token)
        self.assertEqual(str(authed_user.id), str(user.id))

        account.status = AdminAccount.STATUS_DISABLED
        account.save(update_fields=["status", "updated_at"])
        with self.assertRaises(HttpError) as cm_disabled:
            auth.authenticate(request, token)
        self.assertEqual(cm_disabled.exception.status_code, 403)
        self.assertEqual(cm_disabled.exception.message["code"], "ADMIN_ACCOUNT_REQUIRED")

        account.status = AdminAccount.STATUS_ACTIVE
        account.admin_login_enabled = False
        account.save(update_fields=["status", "admin_login_enabled", "updated_at"])
        with self.assertRaises(HttpError) as cm_login_disabled:
            auth.authenticate(request, token)
        self.assertEqual(cm_login_disabled.exception.status_code, 403)
        self.assertEqual(cm_login_disabled.exception.message["code"], "ADMIN_ACCOUNT_REQUIRED")

import json
from io import StringIO

from django.core.management import call_command
from django.test import TestCase

from apps.users.auth.models import AdminAccount, AdminAccountRole, AdminRole, User


class BootstrapAdminAccountsTests(TestCase):
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

    def _run_bootstrap(self):
        output = StringIO()
        call_command("bootstrap_admin_accounts", stdout=output)
        return json.loads(output.getvalue().strip() or "{}")

    def test_bootstrap_admin_accounts_is_idempotent(self):
        User.objects.create_superuser(
            username="bootstrap_super",
            email="bootstrap_super@test.com",
            password="test-pass-123",
        )
        User.objects.create_user(
            username="bootstrap_staff",
            email="bootstrap_staff@test.com",
            password="test-pass-123",
            is_staff=True,
        )

        first = self._run_bootstrap()
        second = self._run_bootstrap()

        self.assertEqual(first["created_admin_accounts"], 2)
        self.assertEqual(first["created_role_bindings"], 2)
        self.assertEqual(second["created_admin_accounts"], 0)
        self.assertEqual(second["created_role_bindings"], 0)
        self.assertEqual(second["missing_roles"], [])

    def test_bootstrap_superuser_gets_super_admin_role(self):
        user = User.objects.create_superuser(
            username="bootstrap_super_only",
            email="bootstrap_super_only@test.com",
            password="test-pass-123",
        )

        self._run_bootstrap()

        account = AdminAccount.objects.get(user=user)
        self.assertEqual(account.status, AdminAccount.STATUS_ACTIVE)
        self.assertTrue(account.admin_login_enabled)
        self.assertTrue(
            AdminAccountRole.objects.filter(
                admin_account=account,
                role__code="super_admin",
            ).exists()
        )

    def test_bootstrap_staff_gets_support_or_operator_role(self):
        user = User.objects.create_user(
            username="bootstrap_staff_only",
            email="bootstrap_staff_only@test.com",
            password="test-pass-123",
            is_staff=True,
        )

        self._run_bootstrap()

        account = AdminAccount.objects.get(user=user)
        role_codes = set(
            AdminAccountRole.objects.filter(admin_account=account).values_list("role__code", flat=True)
        )
        self.assertTrue({"support_agent", "operator"} & role_codes)

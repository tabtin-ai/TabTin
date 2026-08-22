import importlib

from django.apps import apps as django_apps
from django.test import TestCase
from ninja.errors import HttpError

from apps.users.auth.admin_api import _resolve_admin_permissions
from apps.users.auth.models import (
    AdminAccount,
    AdminAccountRole,
    AdminPermission,
    AdminRole,
    AdminRolePermission,
    User,
)


class AdminRbacPermissionTests(TestCase):
    databases = {"default"}

    @staticmethod
    def _create_admin_account(user: User) -> AdminAccount:
        return AdminAccount.objects.create(
            user=user,
            display_name=user.get_display_name(),
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=user,
        )

    def test_superuser_gets_wildcard_permissions(self):
        admin = User.objects.create_superuser(
            username="rbac_super_admin",
            email="rbac-super-admin@test.com",
            password="test-pass-123",
        )
        self._create_admin_account(admin)

        result = _resolve_admin_permissions(admin)

        self.assertEqual(result["role"], "super_admin")
        self.assertEqual(result["roles"], ["super_admin"])
        self.assertEqual(result["permissions"], ["*"])
        self.assertEqual(result["assigned_permissions"], ["*"])
        self.assertTrue(result["is_superuser"])

    def test_staff_without_admin_account_is_rejected(self):
        user = User.objects.create_user(
            username="rbac_support",
            email="rbac-support@test.com",
            password="test-pass-123",
            is_staff=True,
        )
        with self.assertRaises(HttpError) as exc:
            _resolve_admin_permissions(user)
        self.assertEqual(exc.exception.status_code, 403)
        self.assertEqual(exc.exception.message["code"], "ADMIN_ACCOUNT_REQUIRED")

    def test_staff_uses_admin_account_role_permissions(self):
        user = User.objects.create_user(
            username="rbac_billing",
            email="rbac-billing@test.com",
            password="test-pass-123",
            is_staff=True,
        )
        safe_permission, _ = AdminPermission.objects.get_or_create(
            code="organization:list",
            defaults={"name": "团队列表", "category": "organization", "risk_level": "low"},
        )
        guarded_permission, _ = AdminPermission.objects.get_or_create(
            code="wallet:list",
            defaults={"name": "钱包列表", "category": "wallet", "risk_level": "medium"},
        )
        role, _ = AdminRole.objects.get_or_create(
            code="billing_admin",
            defaults={"name": "Billing Admin", "is_system": True, "is_active": True},
        )
        role.role_permissions.exclude(permission__in=[safe_permission, guarded_permission]).delete()
        AdminRolePermission.objects.get_or_create(role=role, permission=safe_permission)
        AdminRolePermission.objects.get_or_create(role=role, permission=guarded_permission)
        admin_account = self._create_admin_account(user)
        AdminAccountRole.objects.get_or_create(admin_account=admin_account, role=role)

        result = _resolve_admin_permissions(user)

        self.assertEqual(result["role"], "billing_admin")
        self.assertEqual(result["roles"], ["billing_admin"])
        self.assertEqual(result["permissions"], ["organization:list", "wallet:list"])
        self.assertEqual(result["assigned_permissions"], ["organization:list", "wallet:list"])
        self.assertFalse(result["is_superuser"])

    def test_inactive_role_permissions_are_filtered(self):
        user = User.objects.create_user(
            username="rbac_inactive_role",
            email="rbac-inactive-role@test.com",
            password="test-pass-123",
            is_staff=True,
        )
        admin_account = self._create_admin_account(user)
        permission, _ = AdminPermission.objects.get_or_create(
            code="organization:list",
            defaults={"name": "团队列表", "category": "organization", "risk_level": "low"},
        )
        role, _ = AdminRole.objects.get_or_create(
            code="inactive_role",
            defaults={"name": "Inactive Role", "is_system": False, "is_active": False},
        )
        role.is_active = False
        role.save(update_fields=["is_active"])
        role.role_permissions.exclude(permission=permission).delete()
        AdminRolePermission.objects.get_or_create(role=role, permission=permission)
        AdminAccountRole.objects.get_or_create(admin_account=admin_account, role=role)

        result = _resolve_admin_permissions(user)

        self.assertEqual(result["role"], "")
        self.assertEqual(result["roles"], [])
        self.assertEqual(result["permissions"], [])
        self.assertEqual(result["assigned_permissions"], [])

    def test_migration_renames_workteam_permissions_and_rebinds_roles(self):
        role = AdminRole.objects.create(
            code="migration_case_role",
            name="Migration Case Role",
            is_system=False,
            is_active=True,
        )
        workteam_permission = AdminPermission.objects.create(
            code="workteam:list",
            name="团队列表",
            category="workteam",
            risk_level="low",
            is_active=True,
        )
        cleanup_permission = AdminPermission.objects.create(
            code="workteam_cleanup:retry",
            name="重试 Workteam 清理任务",
            category="risk_ops",
            risk_level="high",
            is_active=True,
        )
        organization_permission, _ = AdminPermission.objects.get_or_create(
            code="organization:list",
            defaults={
                "name": "组织列表",
                "category": "organization",
                "risk_level": "low",
                "is_active": True,
            },
        )
        AdminRolePermission.objects.create(role=role, permission=workteam_permission)
        AdminRolePermission.objects.create(role=role, permission=cleanup_permission)

        migration_module = importlib.import_module(
            "apps.users.auth.migrations.0026_migrate_admin_rbac_workteam_permission_codes"
        )
        migration_module.forwards(django_apps, None)

        self.assertFalse(AdminPermission.objects.filter(code="workteam:list").exists())
        self.assertFalse(AdminPermission.objects.filter(code="workteam_cleanup:retry").exists())
        self.assertTrue(AdminPermission.objects.filter(code="organization:list").exists())
        self.assertTrue(AdminPermission.objects.filter(code="organization_cleanup:retry").exists())

        role.refresh_from_db()
        role_permission_codes = sorted(role.permissions.values_list("code", flat=True))
        self.assertEqual(role_permission_codes, ["organization:list", "organization_cleanup:retry"])

        organization_permission.refresh_from_db()
        self.assertEqual(organization_permission.category, "organization")

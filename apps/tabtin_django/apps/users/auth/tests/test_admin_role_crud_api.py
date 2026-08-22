from django.test import RequestFactory, TestCase
from ninja.errors import HttpError

from apps.users.auth.admin_api import (
    create_admin_role,
    delete_admin_role,
    update_admin_role,
    update_admin_role_permissions,
)
from apps.users.auth.admin_schemas import (
    AdminRoleCreateRequestSchema,
    AdminRolePermissionsUpdateSchema,
    AdminRoleUpdateRequestSchema,
    AdminSensitiveActionRequestSchema,
)
from apps.users.auth.models import (
    AdminAccount,
    AdminAccountRole,
    AdminPermission,
    AdminRole,
    User,
)


class AdminRoleCrudApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.operator = User.objects.create_user(
            username="rbac_role_operator",
            email="rbac-role-operator@test.com",
            password="test-pass-123",
            is_staff=True,
            is_active=True,
        )
        self.operator_account = AdminAccount.objects.create(
            user=self.operator,
            display_name="RBAC Operator",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=self.operator,
        )
        self.permission_user_list, _ = AdminPermission.objects.get_or_create(
            code="user:list",
            defaults={"name": "用户列表", "category": "user", "risk_level": "low"},
        )
        self.permission_organization_list, _ = AdminPermission.objects.get_or_create(
            code="organization:list",
            defaults={"name": "团队列表", "category": "organization", "risk_level": "low"},
        )

    def _request(self):
        request = self.factory.post("/auth/admin/roles")
        request.auth = self.operator
        request.admin_account = self.operator_account
        return request

    def test_create_update_delete_custom_role(self):
        request = self._request()
        created = create_admin_role(
            request,
            AdminRoleCreateRequestSchema(
                code="ops_manager",
                name="运营经理",
                description="自定义角色",
                permission_codes=["user:list"],
                reason="创建角色",
                ticket_id="T-001",
            ),
        )
        self.assertEqual(created.code, "ops_manager")
        self.assertFalse(created.is_system)
        self.assertEqual(created.permission_codes, ["user:list"])

        updated = update_admin_role(
            request,
            created.id,
            AdminRoleUpdateRequestSchema(
                name="运营经理(更新)",
                description="更新后的说明",
                is_active=True,
                reason="更新角色",
                ticket_id="T-002",
            ),
        )
        self.assertEqual(updated.name, "运营经理(更新)")
        self.assertEqual(updated.description, "更新后的说明")

        updated_permissions = update_admin_role_permissions(
            request,
            created.id,
            AdminRolePermissionsUpdateSchema(
                permission_codes=["user:list", "organization:list"],
                reason="调整权限",
                ticket_id="T-003",
            ),
        )
        self.assertEqual(updated_permissions.permission_codes, ["user:list", "organization:list"])

        delete_result = delete_admin_role(
            request,
            created.id,
            AdminSensitiveActionRequestSchema(reason="删除角色", ticket_id="T-004"),
        )
        self.assertTrue(delete_result["success"])
        self.assertFalse(AdminRole.objects.filter(id=created.id).exists())

    def test_system_role_is_readonly(self):
        request = self._request()
        system_role = AdminRole.objects.create(
            code="system_locked_role",
            name="系统角色",
            is_system=True,
            is_active=True,
        )
        system_role.permissions.add(self.permission_user_list)

        with self.assertRaises(HttpError) as update_exc:
            update_admin_role(
                request,
                str(system_role.id),
                AdminRoleUpdateRequestSchema(
                    name="系统角色变更",
                    reason="不应允许",
                    ticket_id="T-005",
                ),
            )
        self.assertEqual(update_exc.exception.status_code, 409)

        with self.assertRaises(HttpError) as permission_exc:
            update_admin_role_permissions(
                request,
                str(system_role.id),
                AdminRolePermissionsUpdateSchema(
                    permission_codes=["organization:list"],
                    reason="不应允许",
                    ticket_id="T-006",
                ),
            )
        self.assertEqual(permission_exc.exception.status_code, 409)

    def test_delete_role_rejects_assigned_admin_accounts(self):
        request = self._request()
        role = AdminRole.objects.create(
            code="custom_assigned_role",
            name="已分配角色",
            is_system=False,
            is_active=True,
        )
        account_user = User.objects.create_user(
            username="rbac_assigned_user",
            email="rbac-assigned-user@test.com",
            password="test-pass-123",
            is_staff=True,
            is_active=True,
        )
        assigned_account = AdminAccount.objects.create(
            user=account_user,
            display_name="Assigned Account",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=self.operator,
        )
        AdminAccountRole.objects.create(
            admin_account=assigned_account,
            role=role,
            reason="test-bind",
        )

        with self.assertRaises(HttpError) as delete_exc:
            delete_admin_role(
                request,
                str(role.id),
                AdminSensitiveActionRequestSchema(reason="删除角色", ticket_id="T-007"),
            )
        self.assertEqual(delete_exc.exception.status_code, 409)

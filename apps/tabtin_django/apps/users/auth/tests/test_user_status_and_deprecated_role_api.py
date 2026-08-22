from datetime import timedelta
from unittest.mock import patch

from django.test import RequestFactory, TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.users.auth.admin_api import (
    batch_update_user_role,
    batch_update_user_status,
    update_user_role,
    update_user_status,
)
from apps.users.auth.admin_schemas import (
    AdminUserBatchRoleUpdateSchema,
    AdminUserBatchStatusUpdateSchema,
    AdminUserRoleUpdateSchema,
    AdminUserStatusUpdateSchema,
)
from apps.users.auth.models import (
    AdminAccount,
    AdminAccountRole,
    AdminPermission,
    AdminRole,
    AdminSensitiveActionLog,
    User,
    UserSession,
)
from apps.users.auth.permissions import AdminPermissionAuth, SuperuserAuth
from apps.users.auth.utils import generate_jwt_token


class UserStatusAndDeprecatedRoleApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.super_admin = User.objects.create_user(
            username="stage3_super",
            email="stage3_super@test.com",
            password="SuperPass123!",
            is_staff=True,
            is_superuser=True,
            is_active=True,
        )
        self.staff_user = User.objects.create_user(
            username="stage3_staff",
            email="stage3_staff@test.com",
            password="StaffPass123!",
            is_staff=True,
            is_superuser=False,
            is_active=True,
        )
        self.target_user = User.objects.create_user(
            username="stage3_target",
            email="stage3_target@test.com",
            password="TargetPass123!",
            is_active=True,
        )
        self.target_user_2 = User.objects.create_user(
            username="stage3_target_2",
            email="stage3_target_2@test.com",
            password="TargetPass123!",
            is_active=True,
        )
        self.super_admin_account = AdminAccount.objects.create(
            user=self.super_admin,
            display_name="stage3 super",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=self.super_admin,
        )
        self.staff_admin_account = AdminAccount.objects.create(
            user=self.staff_user,
            display_name="stage3 staff",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=self.super_admin,
        )

    def _make_request(self, actor: User, path: str):
        request = self.factory.put(path)
        request.auth = actor
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "stage3-test-agent"
        if str(actor.id) == str(self.super_admin.id):
            request.admin_account = self.super_admin_account
        elif str(actor.id) == str(self.staff_user.id):
            request.admin_account = self.staff_admin_account
        return request

    def _build_token(self, user: User) -> str:
        session = UserSession.objects.create(
            user=user,
            session_key=f"stage3_{user.username}".ljust(64, "0"),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="stage3-test-agent",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        return generate_jwt_token(user, session_key=session.session_key)

    def test_user_status_update_requires_reason(self):
        payload = AdminUserStatusUpdateSchema(status="inactive", reason="   ", ticket_id="")
        request = self._make_request(
            self.super_admin,
            f"/api/auth/admin/users/{self.target_user.id}/status",
        )

        with self.assertRaises(HttpError) as cm:
            update_user_status(request, str(self.target_user.id), payload)

        self.assertEqual(cm.exception.status_code, 400)

    def test_user_status_update_requires_permission(self):
        token = self._build_token(self.staff_user)
        auth = AdminPermissionAuth("user:update_status")
        request = self.factory.put("/api/auth/admin/users/test/status")

        with self.assertRaises(HttpError) as cm_no_permission:
            auth.authenticate(request, token)
        self.assertEqual(cm_no_permission.exception.status_code, 403)
        self.assertEqual(cm_no_permission.exception.message["code"], "ADMIN_PERMISSION_DENIED")

        permission, _ = AdminPermission.objects.get_or_create(
            code="user:update_status",
            defaults={"name": "更新客户状态", "category": "user", "risk_level": "high"},
        )
        role, _ = AdminRole.objects.get_or_create(
            code="support_agent",
            defaults={
                "name": "Support Agent",
                "description": "support",
                "is_system": True,
                "is_active": True,
            },
        )
        role.permissions.add(permission)
        AdminAccountRole.objects.get_or_create(
            admin_account=self.staff_admin_account,
            role=role,
            defaults={"reason": "test-bind"},
        )

        authed_user = auth.authenticate(request, token)
        self.assertEqual(str(authed_user.id), str(self.staff_user.id))

    def test_user_status_update_writes_sensitive_audit(self):
        payload = AdminUserStatusUpdateSchema(
            status="inactive",
            reason="客户风控触发，先停用排查",
            ticket_id="TICKET-STATUS-001",
        )
        request = self._make_request(
            self.super_admin,
            f"/api/auth/admin/users/{self.target_user.id}/status",
        )

        with patch("apps.users.auth.admin_api.SessionManager.invalidate_all_user_sessions"), patch(
            "apps.users.auth.admin_api._schedule_account_collab_revoke"
        ), patch("apps.users.auth.admin_api._cancel_active_agent_runs"), patch(
            "apps.tabchat.centrifugo_proxy.disconnect_centrifugo_user"
        ), patch(
            "apps.services.tools.invalidate_user_cache"
        ):
            update_user_status(request, str(self.target_user.id), payload)

        audit = AdminSensitiveActionLog.objects.filter(action="customer_user.update_status").latest(
            "created_at"
        )
        self.assertEqual(str(audit.actor_user_id), str(self.super_admin.id))
        self.assertEqual(str(audit.actor_admin_account_id), str(self.super_admin_account.id))
        self.assertEqual(audit.permission_code, "user:update_status")
        self.assertEqual(audit.target_type, "user")
        self.assertEqual(audit.target_id, str(self.target_user.id))
        self.assertEqual(audit.reason, "客户风控触发，先停用排查")
        self.assertEqual(audit.ticket_id, "TICKET-STATUS-001")
        self.assertEqual(audit.before_json.get("status"), "active")
        self.assertEqual(audit.after_json.get("status"), "inactive")
        self.assertEqual(audit.ip, "127.0.0.1")
        self.assertEqual(audit.user_agent, "stage3-test-agent")

    def test_batch_user_status_update_requires_reason(self):
        payload = AdminUserBatchStatusUpdateSchema(
            user_ids=[str(self.target_user.id)],
            status="inactive",
            reason="   ",
            ticket_id="",
        )
        request = self._make_request(self.super_admin, "/api/auth/admin/batch/users/status")

        with self.assertRaises(HttpError) as cm:
            batch_update_user_status(request, payload)

        self.assertEqual(cm.exception.status_code, 400)

    def test_deprecated_user_role_update_requires_super_admin(self):
        token = self._build_token(self.staff_user)
        auth = SuperuserAuth()
        request = self.factory.put(f"/api/auth/admin/users/{self.target_user.id}/role")

        with self.assertRaises(HttpError) as cm:
            auth.authenticate(request, token)

        self.assertEqual(cm.exception.status_code, 403)

    def test_deprecated_user_role_update_writes_sensitive_audit(self):
        payload = AdminUserRoleUpdateSchema(
            role="operator",
            reason="迁移到后台账号治理，旧接口仅兼容使用",
            ticket_id="TICKET-ROLE-001",
        )
        request = self._make_request(
            self.super_admin,
            f"/api/auth/admin/users/{self.target_user.id}/role",
        )

        response = update_user_role(request, str(self.target_user.id), payload)
        self.target_user.refresh_from_db()
        audit = AdminSensitiveActionLog.objects.filter(action="deprecated_user_role_update").latest(
            "created_at"
        )

        self.assertTrue(response.success)
        self.assertIn("Deprecated: use AdminAccount role assignment APIs instead.", response.message)
        self.assertTrue(self.target_user.is_staff)
        self.assertFalse(self.target_user.is_superuser)
        self.assertEqual(str(audit.actor_user_id), str(self.super_admin.id))
        self.assertEqual(str(audit.actor_admin_account_id), str(self.super_admin_account.id))
        self.assertEqual(audit.target_id, str(self.target_user.id))
        self.assertEqual(audit.reason, "迁移到后台账号治理，旧接口仅兼容使用")
        self.assertEqual(audit.ticket_id, "TICKET-ROLE-001")
        self.assertEqual(audit.before_json.get("role"), "user")
        self.assertEqual(audit.after_json.get("role"), "operator")

    def test_deprecated_batch_user_role_update_requires_super_admin(self):
        token = self._build_token(self.staff_user)
        auth = SuperuserAuth()
        request = self.factory.post("/api/auth/admin/batch/users/role")

        with self.assertRaises(HttpError) as cm:
            auth.authenticate(request, token)

        self.assertEqual(cm.exception.status_code, 403)

    def test_deprecated_batch_user_role_update_requires_reason(self):
        request = self._make_request(self.super_admin, "/api/auth/admin/batch/users/role")
        payload = AdminUserBatchRoleUpdateSchema(
            user_ids=[str(self.target_user.id), str(self.target_user_2.id)],
            role="operator",
            reason="   ",
            ticket_id="",
        )

        with self.assertRaises(HttpError) as cm:
            batch_update_user_role(request, payload)

        self.assertEqual(cm.exception.status_code, 400)

    def test_deprecated_batch_user_role_update_writes_sensitive_audit(self):
        request = self._make_request(self.super_admin, "/api/auth/admin/batch/users/role")
        payload = AdminUserBatchRoleUpdateSchema(
            user_ids=[str(self.target_user.id), str(self.target_user_2.id)],
            role="operator",
            reason="迁移到后台账号角色分配批量接口",
            ticket_id="TICKET-BATCH-ROLE-001",
        )

        response = batch_update_user_role(request, payload)
        self.target_user.refresh_from_db()
        self.target_user_2.refresh_from_db()
        audit = AdminSensitiveActionLog.objects.filter(
            action="deprecated_batch_user_role_update"
        ).latest("created_at")

        self.assertTrue(response.success)
        self.assertIn("Deprecated: use AdminAccount role assignment APIs instead.", response.message)
        self.assertTrue(self.target_user.is_staff)
        self.assertTrue(self.target_user_2.is_staff)
        self.assertEqual(str(audit.actor_user_id), str(self.super_admin.id))
        self.assertEqual(str(audit.actor_admin_account_id), str(self.super_admin_account.id))
        self.assertEqual(audit.target_type, "batch_user_role")
        self.assertEqual(audit.reason, "迁移到后台账号角色分配批量接口")
        self.assertEqual(audit.ticket_id, "TICKET-BATCH-ROLE-001")
        self.assertEqual(audit.permission_code, "admin_account:assign_role")
        self.assertEqual(audit.before_json.get("affected_count"), 2)
        self.assertEqual(audit.before_json.get("total_user_count"), 2)
        self.assertEqual(audit.after_json.get("new_role"), "operator")
        self.assertEqual(audit.after_json.get("affected_count"), 2)
        self.assertTrue(len(audit.before_json.get("user_ids_preview", [])) <= 50)

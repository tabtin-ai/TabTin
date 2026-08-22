import os
from datetime import timedelta
from unittest.mock import patch

from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone
from ninja.errors import HttpError

from apps.users.auth.admin_api import cleanup_dirty_user_by_phone
from apps.users.auth.admin_schemas import AdminDirtyUserCleanupByPhoneRequestSchema
from apps.users.auth.models import User, UserSession


class DirtyUserCleanupByPhoneApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="dirty-cleanup-admin@test.com",
            phone="15921194231",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )
        self.target = User.objects.create_user(
            phone="15921194230",
            username="user_4230",
            nickname="user_4230",
            password="TargetPass123!",
        )

    def _request(self):
        request = self.factory.post("/admin/dev/users/cleanup-by-phone")
        request.auth = self.admin
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "test-agent"
        return request

    @override_settings(DEBUG=False)
    def test_requires_debug_or_explicit_enable_flag(self):
        payload = AdminDirtyUserCleanupByPhoneRequestSchema(phone="15921194230")

        with patch.dict(os.environ, {"TABTIN_ENV": "", "TABTIN_ENABLE_DEV_USER_CLEANUP_API": ""}, clear=False):
            with self.assertRaises(HttpError) as ctx:
                cleanup_dirty_user_by_phone(self._request(), payload)

        self.assertEqual(ctx.exception.status_code, 403)

    @override_settings(DEBUG=False)
    def test_ack_test_env_allows_cleanup_without_explicit_enable_flag(self):
        payload = AdminDirtyUserCleanupByPhoneRequestSchema(phone="15921194230")

        with patch.dict(os.environ, {"TABTIN_ENV": "ack-test"}, clear=False), patch(
            "apps.users.auth.admin_api._cleanup_search_traces_for_user",
            return_value="dry-run",
        ):
            response = cleanup_dirty_user_by_phone(self._request(), payload)

        self.assertTrue(response.success)
        self.assertTrue(response.dry_run)

    @override_settings(DEBUG=True)
    def test_dry_run_returns_counts_without_deleting_user(self):
        payload = AdminDirtyUserCleanupByPhoneRequestSchema(phone="15921194230")

        with patch("apps.users.auth.admin_api._cleanup_search_traces_for_user", return_value="dry-run"):
            response = cleanup_dirty_user_by_phone(self._request(), payload)

        self.assertTrue(response.success)
        self.assertTrue(response.dry_run)
        self.assertEqual(response.user_id, str(self.target.id))
        self.assertEqual(response.counts_before["users_auth_user"], 1)
        self.assertTrue(User.objects.filter(id=self.target.id).exists())

    @override_settings(DEBUG=True)
    def test_real_cleanup_requires_exact_confirmation(self):
        payload = AdminDirtyUserCleanupByPhoneRequestSchema(
            phone="15921194230",
            dry_run=False,
            confirm_phone="15921194230",
            confirmation="WRONG",
        )

        with patch("apps.users.auth.admin_api._cleanup_search_traces_for_user", return_value="dry-run"):
            with self.assertRaises(HttpError) as ctx:
                cleanup_dirty_user_by_phone(self._request(), payload)

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertTrue(User.objects.filter(id=self.target.id).exists())

    @override_settings(DEBUG=True)
    def test_real_cleanup_runs_organization_cleanup_then_deletes_user(self):
        payload = AdminDirtyUserCleanupByPhoneRequestSchema(
            phone="15921194230",
            dry_run=False,
            confirm_phone="15921194230",
            confirmation="DELETE_DIRTY_USER_DATA",
        )

        with patch("apps.users.auth.admin_api._cleanup_search_traces_for_user", return_value="cleaned") as search, \
             patch(
                 "apps.tabtinspace.services.organization_service.OrganizationService.cleanup_user_postgresql_data",
                 return_value={"owned_organizations": 0, "memberships": 0},
             ) as pg_cleanup:
            response = cleanup_dirty_user_by_phone(self._request(), payload)

        self.assertTrue(response.success)
        self.assertFalse(response.dry_run)
        self.assertEqual(response.counts_after["users_auth_user"], 0)
        self.assertFalse(User.objects.filter(id=self.target.id).exists())
        self.assertGreaterEqual(pg_cleanup.call_count, 1)
        search.assert_any_call(str(self.target.id), dry_run=True)
        search.assert_any_call(str(self.target.id), dry_run=False)

    @override_settings(DEBUG=True)
    def test_real_cleanup_current_admin_keeps_admin_account(self):
        session = UserSession.objects.create(
            user=self.admin,
            session_key="admin_cleanup_self_session".ljust(64, "0"),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="test-agent",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        payload = AdminDirtyUserCleanupByPhoneRequestSchema(
            phone="15921194231",
            dry_run=False,
            confirm_phone="15921194231",
            confirmation="DELETE_DIRTY_USER_DATA",
        )

        with patch("apps.users.auth.admin_api._cleanup_search_traces_for_user", return_value="cleaned") as search, \
             patch(
                 "apps.tabtinspace.services.organization_service.OrganizationService.cleanup_user_postgresql_data",
                 return_value={"owned_organizations": 1, "memberships": 1},
             ) as pg_cleanup:
            response = cleanup_dirty_user_by_phone(self._request(), payload)

        self.assertTrue(response.success)
        self.assertFalse(response.dry_run)
        self.assertEqual(response.message, "客户端业务数据清理完成")
        self.assertTrue(User.objects.filter(id=self.admin.id).exists())
        self.assertTrue(UserSession.objects.filter(id=session.id, is_active=True).exists())
        self.assertEqual(response.delete_result["deleted_count"], 0)
        self.assertTrue(response.delete_result["skipped_user_delete"])
        self.assertGreaterEqual(pg_cleanup.call_count, 1)
        search.assert_any_call(str(self.admin.id), dry_run=True)
        search.assert_any_call(str(self.admin.id), dry_run=False)

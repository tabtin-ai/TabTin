"""#7318：TabData 组织列表与详情 ACL 对齐（ 云盘默认私有残留缺口）。

列表只能返回当前用户按资源 ACL 可读的表；详情对同组织无权限返回 403，
跨组织 / 不存在仍为 404，避免假「表格不存在」与资源枚举。
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import Client, TestCase
from django.utils import timezone

from apps.tabdata.models import Table, TablePermission
from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token
from apps.users.membership.models import MembershipTier

User = get_user_model()

_SESSION_COUNTER = 0


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "#7318 ACL 测试",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


def _auth_header(user) -> dict:
    """构造带有效 UserSession 的 JWT（JWTAuth 强制 sid 绑定）。"""
    global _SESSION_COUNTER
    _SESSION_COUNTER += 1
    raw_key = f"i7318_session_{_SESSION_COUNTER:040d}"
    UserSession.objects.get_or_create(
        session_key=SessionManager.hash_session_key(raw_key),
        defaults={
            "user": user,
            "session_type": "web",
            "ip_address": "127.0.0.1",
            "user_agent": "i7318-test",
            "expires_at": timezone.now() + timedelta(hours=2),
        },
    )
    token = generate_jwt_token(
        user, expire_hours=1, token_type="access", session_key=raw_key,
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


def _response_data(payload: dict):
    """兼容标准 envelope：优先取 data，否则退回顶层。"""
    inner = payload.get("data")
    if isinstance(inner, dict) and ("tables" in inner or "id" in inner or "total" in inner):
        return inner
    return payload


class Issue7318TableAclTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        _ensure_free_tier()
        self.client = Client()

        self.owner = User.objects.create_user(
            username="i7318-owner",
            email="i7318-owner@example.com",
            password="x",
        )
        self.editor = User.objects.create_user(
            username="i7318-editor",
            email="i7318-editor@example.com",
            password="x",
        )
        self.org_admin = User.objects.create_user(
            username="i7318-admin",
            email="i7318-admin@example.com",
            password="x",
        )
        self.outsider = User.objects.create_user(
            username="i7318-outsider",
            email="i7318-outsider@example.com",
            password="x",
        )

        self.organization = Organization.objects.create(
            name="I7318 Org",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.editor,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.org_admin,
            role="admin",
        )

        self.private_table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="未命名表格2",
        )
        self.shared_table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="未命名表格1",
        )
        TablePermission.objects.create(
            table=self.shared_table,
            subject_type="user",
            subject_id=str(self.editor.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        self.own_table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.editor,
            name="未命名表格11",
        )
        self.inactive_shared = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="失活授权表",
        )
        TablePermission.objects.create(
            table=self.inactive_shared,
            subject_type="user",
            subject_id=str(self.editor.id),
            permission="viewer",
            is_active=False,
            granted_by=str(self.owner.id),
        )

        self.other_org = Organization.objects.create(
            name="I7318 Other Org",
            owner_id=self.outsider.id,
            is_default=False,
        )
        self.other_org_table = Table.objects.create(
            organization_id=self.other_org.id,
            space_id=None,
            owner=self.outsider,
            name="跨组织私有表",
        )

    def _list_tables(self, user, *, page: int | None = None, page_size: int | None = None):
        params = {}
        if page is not None:
            params["page"] = page
        if page_size is not None:
            params["page_size"] = page_size
        response = self.client.get(
            f"/api/tabdata/organizations/{self.organization.id}/tables",
            params,
            **_auth_header(user),
        )
        return response

    def test_org_editor_list_excludes_unshared_private_tables(self):
        """组织 editor 列表不得出现他人未授权私有表。"""
        response = self._list_tables(self.editor)
        self.assertEqual(response.status_code, 200, response.content)
        body = _response_data(response.json())
        names = {t["name"] for t in body["tables"]}
        ids = {t["id"] for t in body["tables"]}

        self.assertIn(str(self.shared_table.id), ids)
        self.assertIn(str(self.own_table.id), ids)
        self.assertNotIn(str(self.private_table.id), ids)
        self.assertNotIn(str(self.inactive_shared.id), ids)
        self.assertNotIn("未命名表格2", names)
        self.assertNotIn("失活授权表", names)
        self.assertEqual(body["total"], len(body["tables"]))

    def test_org_admin_list_also_excludes_unshared_private_tables(self):
        """组织 admin 也不回退内容权限。"""
        response = self._list_tables(self.org_admin)
        self.assertEqual(response.status_code, 200, response.content)
        body = _response_data(response.json())
        ids = {t["id"] for t in body["tables"]}
        self.assertNotIn(str(self.private_table.id), ids)
        self.assertEqual(body["total"], 0)

    def test_owner_list_sees_own_tables(self):
        response = self._list_tables(self.owner)
        self.assertEqual(response.status_code, 200, response.content)
        body = _response_data(response.json())
        ids = {t["id"] for t in body["tables"]}
        self.assertIn(str(self.private_table.id), ids)
        self.assertIn(str(self.shared_table.id), ids)
        self.assertIn(str(self.inactive_shared.id), ids)
        self.assertNotIn(str(self.own_table.id), ids)

    def test_list_pagination_total_matches_filtered_set(self):
        response = self._list_tables(self.editor, page=1, page_size=1)
        self.assertEqual(response.status_code, 200, response.content)
        body = _response_data(response.json())
        self.assertEqual(body["total"], 2)
        self.assertEqual(len(body["tables"]), 1)
        self.assertEqual(body["page"], 1)
        self.assertEqual(body["page_size"], 1)

    def test_list_current_user_role_has_no_org_fallback(self):
        """列表 current_user_role 不得虚高为组织 editor。"""
        response = self._list_tables(self.editor)
        self.assertEqual(response.status_code, 200, response.content)
        body = _response_data(response.json())
        by_id = {t["id"]: t for t in body["tables"]}

        self.assertEqual(by_id[str(self.shared_table.id)]["current_user_role"], "editor")
        self.assertEqual(by_id[str(self.own_table.id)]["current_user_role"], "owner")

    def test_service_list_tables_matches_http_filter(self):
        """OpenAPI / Space 列表共用 TableService.list_tables，服务层即已过滤。"""
        qs = TableService(user=self.editor).list_tables(
            organization_id=self.organization.id,
        )
        ids = {str(tid) for tid in qs.values_list("id", flat=True)}
        self.assertEqual(ids, {str(self.shared_table.id), str(self.own_table.id)})

    def test_get_table_forbidden_same_org_returns_403(self):
        response = self.client.get(
            f"/api/tabdata/tables/{self.private_table.id}",
            **_auth_header(self.editor),
        )
        self.assertEqual(response.status_code, 403, response.content)
        payload = response.json()
        self.assertFalse(payload.get("success", True))
        self.assertEqual(payload.get("code"), "PERMISSION_DENIED")

    def test_get_table_shared_returns_200(self):
        response = self.client.get(
            f"/api/tabdata/tables/{self.shared_table.id}",
            **_auth_header(self.editor),
        )
        self.assertEqual(response.status_code, 200, response.content)
        body = _response_data(response.json())
        self.assertEqual(body["id"], str(self.shared_table.id))
        self.assertEqual(body.get("current_user_role"), "editor")

    def test_get_table_missing_returns_404(self):
        response = self.client.get(
            f"/api/tabdata/tables/{uuid.uuid4()}",
            **_auth_header(self.editor),
        )
        self.assertEqual(response.status_code, 404, response.content)
        payload = response.json()
        self.assertEqual(payload.get("code"), "TABLE_NOT_FOUND")

    def test_get_table_cross_org_returns_404_not_403(self):
        """跨组织探测不得泄露资源存在性。"""
        response = self.client.get(
            f"/api/tabdata/tables/{self.other_org_table.id}",
            **_auth_header(self.editor),
        )
        self.assertEqual(response.status_code, 404, response.content)
        payload = response.json()
        self.assertEqual(payload.get("code"), "TABLE_NOT_FOUND")

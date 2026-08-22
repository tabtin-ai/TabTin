"""Admin 组织详情 · Space / 资源回收站代操作 API。"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.http import JsonResponse
from django.test import RequestFactory, SimpleTestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.tabtinspace.admin_api import (
    AdminSensitiveReasonRequest,
    admin_empty_organization_resource_trash,
    admin_list_trashed_spaces,
    admin_permanent_delete_trashed_space,
    admin_restore_trashed_space,
)
from apps.tabtinspace.services.base import ServiceError


class AdminTrashSpacesApiTests(SimpleTestCase):
    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.organization_id = uuid4()
        self.space_id = uuid4()
        self.auth = SimpleNamespace(id=uuid4(), is_staff=True, is_superuser=True)

    def _get(self, path: str, params: dict | None = None):
        request = self.rf.get(path, data=params or {})
        request.auth = self.auth
        return request

    def _mutate(self, method: str, path: str):
        request = getattr(self.rf, method.lower())(path)
        request.auth = self.auth
        return request

    @patch("apps.tabtinspace.admin_api.Organization.objects")
    @patch("apps.tabtinspace.admin_api.Project.objects")
    def test_list_trashed_spaces_requires_organization_id(self, _project_objects, _org_objects):
        request = self._get("/api/auth/admin/trash/spaces")
        with self.assertRaises(HttpError) as ctx:
            admin_list_trashed_spaces(request)
        self.assertEqual(ctx.exception.status_code, 400)

    @patch("apps.tabtinspace.admin_api.Organization.objects")
    @patch("apps.tabtinspace.admin_api.Project.objects")
    def test_list_trashed_spaces_ok(self, project_objects, org_objects):
        org_objects.filter.return_value.first.return_value = SimpleNamespace(id=self.organization_id)
        trashed_at = timezone.now()
        space = SimpleNamespace(
            id=self.space_id,
            name="Trashed Space",
            avatar="",
            description="",
            status="trashed",
            trashed_at=trashed_at,
            trashed_by=None,
            previous_status="active",
            created_at=trashed_at,
        )
        qs = project_objects.filter.return_value.only.return_value.order_by.return_value
        qs.count.return_value = 1
        qs.__getitem__ = lambda _self, _key: [space]

        request = self._get(
            "/api/auth/admin/trash/spaces",
            {"organization_id": str(self.organization_id)},
        )
        resp = admin_list_trashed_spaces(request)
        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["total"], 1)
        self.assertEqual(resp["data"]["items"][0]["id"], str(self.space_id))
        self.assertEqual(resp["data"]["items"][0]["type"], "team_space")

    @patch("apps.tabtinspace.admin_api._record_admin_action")
    @patch("apps.tabtinspace.admin_api.record_admin_sensitive_action")
    @patch("apps.tabtinspace.services.space_service.SpaceService.admin_restore_space_from_trash")
    @patch("apps.tabtinspace.admin_api.Project.objects")
    def test_restore_trashed_space_ok(
        self,
        project_objects,
        restore_mock,
        _sensitive,
        _action,
    ):
        project_objects.filter.return_value.first.return_value = SimpleNamespace(
            id=self.space_id,
            name="Trashed Space",
            organization_id=self.organization_id,
            trashed_at=timezone.now(),
            previous_status="active",
        )
        restore_mock.return_value = True
        request = self._mutate("post", f"/api/auth/admin/trash/spaces/{self.space_id}/restore")
        resp = admin_restore_trashed_space(
            request,
            self.space_id,
            AdminSensitiveReasonRequest(reason="ops restore", ticket_id="T-1"),
        )
        self.assertTrue(resp["success"])
        restore_mock.assert_called_once()

    @patch("apps.tabtinspace.admin_api._record_admin_action")
    @patch("apps.tabtinspace.admin_api.record_admin_sensitive_action")
    @patch("apps.tabtinspace.services.space_service.SpaceService.purge_trashed_spaces")
    @patch("apps.tabtinspace.services.space_service.SpaceService")
    @patch("apps.tabtinspace.admin_api.Project.objects")
    def test_permanent_delete_trashed_space_blocks_binding(
        self,
        project_objects,
        space_service_cls,
        purge_mock,
        _sensitive,
        _action,
    ):
        project_objects.filter.return_value.first.return_value = SimpleNamespace(
            id=self.space_id,
            name="Bound Space",
            organization_id=self.organization_id,
            trashed_at=timezone.now(),
        )
        space_service_cls.return_value._assert_not_execution_binding_target.side_effect = ServiceError(
            "EXECUTION_BINDING",
            "Space is execution binding target",
            400,
        )
        request = self._mutate("delete", f"/api/auth/admin/trash/spaces/{self.space_id}")
        resp = admin_permanent_delete_trashed_space(
            request,
            self.space_id,
            AdminSensitiveReasonRequest(reason="ops delete", ticket_id=""),
        )
        purge_mock.assert_not_called()
        self.assertIsInstance(resp, JsonResponse)
        self.assertEqual(resp.status_code, 400)
        body = json.loads(resp.content)
        self.assertEqual(body.get("code"), "EXECUTION_BINDING")

    @patch("apps.tabtinspace.admin_api._record_admin_action")
    @patch("apps.tabtinspace.admin_api.record_admin_sensitive_action")
    @patch("apps.tabtinspace.services.trash_cleaner.TrashCleaner.permanent_delete_trashed_items")
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    @patch("apps.tabtinspace.admin_api.Organization.objects")
    def test_empty_organization_resource_trash_ok(
        self,
        org_objects,
        context_item_objects,
        delete_mock,
        _sensitive,
        _action,
    ):
        org_objects.filter.return_value.first.return_value = SimpleNamespace(id=self.organization_id)
        qs = context_item_objects.filter.return_value
        qs.count.side_effect = [3, 0]
        request = self._mutate(
            "post",
            f"/api/auth/admin/trash/organizations/{self.organization_id}/empty",
        )
        resp = admin_empty_organization_resource_trash(
            request,
            self.organization_id,
            AdminSensitiveReasonRequest(reason="empty trash", ticket_id="T-2"),
        )
        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["deleted_count"], 3)
        self.assertIn("清空", resp["message"])
        delete_mock.assert_called_once()

"""Admin 资源 trash：cloud_file / tabfolder 不可假删；tabfiles/file 可 trash→restore。"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.http import JsonResponse
from django.test import RequestFactory, SimpleTestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.tabtinspace.admin_api import (
    AdminSensitiveReasonRequest,
    _ADMIN_NON_DELETABLE_ITEM_TYPES,
    _ADMIN_RESOURCE_TYPE_ALIASES,
    admin_list_organization_resources,
    admin_restore_trashed_resource,
    admin_trash_active_resource,
)


def _as_payload(resp):
    if isinstance(resp, JsonResponse):
        return json.loads(resp.content)
    return resp


class AdminNonDeletableFileTypePolicyTests(SimpleTestCase):
    def test_aliases_exclude_cloud_file_and_tabfolder(self):
        self.assertEqual(_ADMIN_RESOURCE_TYPE_ALIASES["tabfiles"], ("tabfiles", "file"))
        self.assertNotIn("cloud_file", _ADMIN_RESOURCE_TYPE_ALIASES["tabfiles"])
        self.assertNotIn("tabfolder", _ADMIN_RESOURCE_TYPE_ALIASES["tabfiles"])
        self.assertEqual(_ADMIN_NON_DELETABLE_ITEM_TYPES, frozenset({"cloud_file", "tabfolder"}))


class AdminTrashUnsupportedFileTypesTests(SimpleTestCase):
    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.auth = SimpleNamespace(id=uuid4(), is_staff=True, is_superuser=True)
        self.ci_id = uuid4()

    def _active_ci(self, item_type: str):
        now = timezone.now()
        workspace_id = uuid4()
        return SimpleNamespace(
            id=self.ci_id,
            title=f"x-{item_type}",
            item_type=item_type,
            resource_id=str(uuid4()),
            # ：ContextItem 挂 workspace/project，无 space FK
            workspace_id=workspace_id,
            project_id=None,
            workspace=SimpleNamespace(organization_id=uuid4(), name="ws"),
            project=None,
            status="active",
            trashed_at=None,
            trashed_by=None,
            previous_status="",
            is_archived=False,
            created_at=now,
            updated_at=now,
            metadata={},
            save=MagicMock(),
            refresh_from_db=MagicMock(),
        )

    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    def test_trash_cloud_file_returns_unsupported(self, context_objects):
        ci = self._active_ci("cloud_file")
        context_objects.select_related.return_value.filter.return_value.exclude.return_value.first.return_value = ci
        request = self.rf.post(f"/api/auth/admin/resources/{self.ci_id}/trash")
        request.auth = self.auth
        resp = _as_payload(
            admin_trash_active_resource(
                request,
                self.ci_id,
                AdminSensitiveReasonRequest(reason="should fail", ticket_id="T-1"),
            )
        )
        self.assertFalse(resp["success"])
        self.assertEqual(resp["code"], "NOT_FOUND")

    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    def test_trash_tabfolder_returns_unsupported(self, context_objects):
        ci = self._active_ci("tabfolder")
        context_objects.select_related.return_value.filter.return_value.exclude.return_value.first.return_value = ci
        request = self.rf.post(f"/api/auth/admin/resources/{self.ci_id}/trash")
        request.auth = self.auth
        resp = _as_payload(
            admin_trash_active_resource(
                request,
                self.ci_id,
                AdminSensitiveReasonRequest(reason="should fail", ticket_id="T-1"),
            )
        )
        self.assertFalse(resp["success"])
        self.assertEqual(resp["code"], "NOT_FOUND")

    @patch("apps.tabtinspace.admin_api._record_admin_action")
    @patch("apps.tabtinspace.admin_api.record_admin_sensitive_action")
    @patch("apps.tabtinspace.services.space_service.SpaceService")
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    def test_trash_tabfiles_rejects_silent_noop(
        self,
        context_objects,
        space_service_cls,
        _sensitive,
        _action,
    ):
        """_trash_child_resource 若未真正写入 trashed_at，不得返回成功。"""
        ci = self._active_ci("tabfiles")
        context_objects.select_related.return_value.filter.return_value.exclude.return_value.first.return_value = ci
        space_service_cls.return_value._trash_child_resource.return_value = None
        # refresh 后仍未进站
        def _refresh():
            ci.trashed_at = None

        ci.refresh_from_db.side_effect = _refresh

        request = self.rf.post(f"/api/auth/admin/resources/{self.ci_id}/trash")
        request.auth = self.auth
        with self.assertRaises(HttpError) as ctx:
            admin_trash_active_resource(
                request,
                self.ci_id,
                AdminSensitiveReasonRequest(reason="noop trash", ticket_id="T-2"),
            )
        self.assertEqual(ctx.exception.status_code, 400)
        _sensitive.assert_not_called()

    @patch("apps.tabtinspace.admin_api._record_admin_action")
    @patch("apps.tabtinspace.admin_api.record_admin_sensitive_action")
    @patch("apps.tabtinspace.services.space_service.SpaceService")
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    def test_trash_then_restore_tabfiles_ok(
        self,
        context_objects,
        space_service_cls,
        _sensitive,
        _action,
    ):
        now = timezone.now()
        ci = self._active_ci("tabfiles")

        def trash_side_effect(_ci, *_args):
            ci.trashed_at = now
            ci.status = "trashed"

        def restore_side_effect(_ci):
            ci.trashed_at = None
            ci.status = "active"

        space_service_cls.return_value._trash_child_resource.side_effect = trash_side_effect
        space_service_cls.return_value._restore_child_resource.side_effect = restore_side_effect
        context_objects.select_related.return_value.filter.return_value.exclude.return_value.first.return_value = ci
        context_objects.select_related.return_value.filter.return_value.first.return_value = ci

        request = self.rf.post(f"/api/auth/admin/resources/{self.ci_id}/trash")
        request.auth = self.auth
        trash_resp = admin_trash_active_resource(
            request,
            self.ci_id,
            AdminSensitiveReasonRequest(reason="trash file", ticket_id="T-3"),
        )
        self.assertTrue(trash_resp["success"])
        self.assertIsNotNone(ci.trashed_at)

        request = self.rf.post(f"/api/auth/admin/trash/resources/{self.ci_id}/restore")
        request.auth = self.auth
        restore_resp = admin_restore_trashed_resource(
            request,
            self.ci_id,
            AdminSensitiveReasonRequest(reason="restore file", ticket_id="T-3"),
        )
        self.assertTrue(restore_resp["success"])
        self.assertIsNone(ci.trashed_at)


class AdminListExcludesNonDeletableTypesTests(SimpleTestCase):
    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.auth = SimpleNamespace(id=uuid4(), is_staff=True, is_superuser=True)
        self.organization_id = uuid4()

    @patch("apps.tabtinspace.admin_api._build_owner_name_map", return_value={})
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    @patch("apps.tabtinspace.admin_api.Organization.objects")
    def test_list_excludes_cloud_file_and_tabfolder(
        self,
        org_objects,
        context_objects,
        _name_map,
    ):
        org_objects.filter.return_value.first.return_value = SimpleNamespace(id=self.organization_id)

        # 捕获 exclude 调用链中是否带上了非可删类型
        filter_qs = MagicMock()
        exclude1 = MagicMock()
        exclude2 = MagicMock()
        exclude3 = MagicMock()
        context_objects.filter.return_value = filter_qs
        filter_qs.exclude.return_value = exclude1
        exclude1.exclude.return_value = exclude2
        exclude2.exclude.return_value = exclude3

        # 后续链式调用尽量不炸
        facet = exclude3.filter.return_value
        facet.exclude.return_value.values.return_value.annotate.return_value.order_by.return_value = []
        facet.values.return_value.annotate.return_value.order_by.return_value = []
        facet.count.return_value = 0
        facet.order_by.return_value.__getitem__ = lambda *_: []
        facet.select_related.return_value.order_by.return_value = facet.order_by.return_value

        request = self.rf.get(f"/api/auth/admin/organizations/{self.organization_id}/resources")
        request.auth = self.auth
        admin_list_organization_resources(request, organization_id=self.organization_id)

        excluded_sets = []
        for call in (filter_qs.exclude.call_args_list + exclude1.exclude.call_args_list + exclude2.exclude.call_args_list):
            kwargs = call.kwargs if call.kwargs else {}
            if "item_type__in" in kwargs:
                excluded_sets.append(set(kwargs["item_type__in"]))
            elif call.args:
                # Q objects etc. ignore
                pass
        # Magics may pass as positional via .exclude(item_type__in=...)
        for mock_obj in (filter_qs, exclude1, exclude2):
            for call in mock_obj.exclude.call_args_list:
                if call.kwargs.get("item_type__in") is not None:
                    excluded_sets.append(set(call.kwargs["item_type__in"]))

        self.assertTrue(
            any(_ADMIN_NON_DELETABLE_ITEM_TYPES <= s for s in excluded_sets),
            f"expected non-deletable types excluded, got {excluded_sets}",
        )

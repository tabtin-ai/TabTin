"""Workspace 回收站永久删除契约。"""
from __future__ import annotations

import json
from datetime import timedelta
from unittest.mock import patch

from django.http import JsonResponse
from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone

from apps.tabtinspace.models import OrganizationMember, Project
from apps.tabtinspace.routers.project import (
    list_trashed_projects,
    permanent_delete_project_from_trash,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class SpaceTrashPermanentDeleteTests(TestCase):
    """#6342：Project 回收站永久删除契约（路由已迁 /context/projects/*）。"""

    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.owner = create_test_user(prefix="trash_perm_owner")
        self.viewer = create_test_user(prefix="trash_perm_viewer")
        self.organization = create_test_organization(owner=self.owner, prefix="trash_perm")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.viewer,
            role="viewer",
        )
        self.trashed_project = Project.objects.create(
            organization=self.organization,
            name="Trashed Project",
            status=Project.Status.TRASHED,
            is_archived=True,
            trashed_at=timezone.now(),
            previous_status="active",
        )

    def _call_permanent(self, user, project_id=None):
        pid = project_id or self.trashed_project.id
        request = self.rf.delete(f"/api/context/projects/{pid}/permanent-from-trash")
        request.auth = user
        return permanent_delete_project_from_trash(request, pid)

    def test_owner_can_permanent_delete_trashed_space(self) -> None:
        with patch.object(SpaceService, "purge_trashed_spaces", return_value=1) as purge:
            with patch(
                "apps.tabtinspace.services.audit_service.AuditService.log",
            ):
                resp = self._call_permanent(self.owner)

        self.assertIsInstance(resp, dict)
        self.assertTrue(resp.get("success"))
        purge.assert_called_once()
        self.assertEqual(list(purge.call_args[0][0]), [self.trashed_project.id])

    def test_viewer_cannot_permanent_delete(self) -> None:
        resp = self._call_permanent(self.viewer)
        if isinstance(resp, JsonResponse):
            self.assertEqual(resp.status_code, 403)
            body = json.loads(resp.content.decode())
            self.assertFalse(body.get("success", True))
        elif isinstance(resp, tuple):
            self.assertEqual(resp[0], 403)
        else:
            self.assertFalse(resp.get("success", True))

        self.assertTrue(
            Project.objects.filter(
                id=self.trashed_project.id, trashed_at__isnull=False,
            ).exists()
        )

    def test_active_space_returns_not_in_trash(self) -> None:
        active = Project.objects.create(
            organization=self.organization,
            name="Still Active",
            status=Project.Status.ACTIVE,
        )
        service = SpaceService(user=self.owner)
        with self.assertRaises(ServiceError) as ctx:
            service.permanent_delete_space_from_trash(active.id)
        self.assertEqual(ctx.exception.code, "SPACE_NOT_IN_TRASH")
        self.assertEqual(ctx.exception.status, 400)

    def test_purge_removes_space_from_trashed_list(self) -> None:
        deleted = SpaceService.purge_trashed_spaces([self.trashed_project.id])
        self.assertEqual(deleted, 1)
        self.assertFalse(Project.objects.filter(id=self.trashed_project.id).exists())

        request = self.rf.get(
            f"/api/context/organizations/{self.organization.id}/trashed-projects"
        )
        request.auth = self.owner
        data = list_trashed_projects(request, self.organization.id)["data"]
        ids = {item["id"] for item in data["items"]}
        self.assertNotIn(str(self.trashed_project.id), ids)

    def test_purge_skips_non_trashed_ids(self) -> None:
        active = Project.objects.create(
            organization=self.organization,
            name="Active Skip",
            status=Project.Status.ACTIVE,
        )
        deleted = SpaceService.purge_trashed_spaces([active.id])
        self.assertEqual(deleted, 0)
        self.assertTrue(Project.objects.filter(id=active.id).exists())

    def test_expired_space_is_purged_by_helper(self) -> None:
        self.trashed_project.trashed_at = timezone.now() - timedelta(days=31)
        self.trashed_project.save(update_fields=["trashed_at"])
        deleted = SpaceService.purge_trashed_spaces([self.trashed_project.id])
        self.assertEqual(deleted, 1)
        self.assertFalse(Project.objects.filter(id=self.trashed_project.id).exists())

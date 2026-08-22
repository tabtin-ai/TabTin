"""Project release feature flag guards."""
from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

from django.test import TransactionTestCase, override_settings

from apps.tabtinspace.models import Project, ProjectMembership, Space
from apps.tabtinspace.routers.project import (
    ProjectCreateWithWorkspaceIn,
    create_project_with_workspace,
    list_projects,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.tests.fixtures import (
    cleanup_test_organization,
    create_test_organization_with_agent,
)


def _request(user, *, get: dict[str, str] | None = None):
    return SimpleNamespace(
        auth=user,
        method="GET",
        META={"REMOTE_ADDR": "127.0.0.1", "HTTP_USER_AGENT": "test"},
        GET=get or {},
    )


class ProjectFeatureFlagTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.ctx = create_test_organization_with_agent(prefix="projectflag")
        self.user = self.ctx["user"]
        self.organization = self.ctx["organization"]

    def tearDown(self):
        cleanup_test_organization(self.organization, delete_user=True)

    def _make_project_room(self) -> Project:
        """#3266 终态：Project 是真表，成员挂 ProjectMembership。"""
        room = Project.objects.create(
            organization=self.organization,
            name="Hidden Project",
            status="active",
        )
        ProjectMembership.objects.create(
            project=room,
            user=self.user,
            role="owner",
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )
        return room

    def test_team_space_list_is_empty_after_project_retire(self):
        """#3266 终态：Space(type=team_space) 已随 0105 物理消解；即使 flag 开启也无历史行。"""
        self._make_project_room()

        spaces, total = SpaceService(user=self.user).list_spaces(
            organization_id=self.organization.id,
            space_type=Space.SpaceType.TEAM_SPACE,
        )

        self.assertEqual(spaces, [])
        self.assertEqual(total, 0)

    def test_team_space_create_is_rejected_after_project_migration(self):
        """#3266 终态：``create_space(TEAM_SPACE)`` 已停产，团队协作走 ProjectService。"""
        service = SpaceService(user=self.user)

        with self.assertRaises(ServiceError) as ctx:
            service.create_space(
                organization_id=self.organization.id,
                name="Hidden Project",
                space_type=Space.SpaceType.TEAM_SPACE,
            )

        self.assertEqual(ctx.exception.code, "TEAM_SPACE_RETIRED")
        self.assertEqual(ctx.exception.status, 410)

    @override_settings(TABTIN_ENABLE_PROJECTS=False)
    def test_project_list_route_returns_empty_when_feature_disabled(self):
        self._make_project_room()

        response = list_projects(
            _request(self.user, get={"organization_id": str(self.organization.id)}),
        )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"], {"projects": [], "total": 0})

    @override_settings(TABTIN_ENABLE_PROJECTS=False)
    def test_project_create_route_returns_feature_disabled(self):
        response = create_project_with_workspace(
            _request(self.user),
            ProjectCreateWithWorkspaceIn(
                organization_id=self.organization.id,
                name="Hidden Project",
                device_id=uuid4(),
                working_dir="/tmp/hidden-project",
            ),
        )

        self.assertEqual(response.status_code, 403)
        body = json.loads(response.content.decode("utf-8"))
        self.assertEqual(body["code"], "FEATURE_DISABLED")

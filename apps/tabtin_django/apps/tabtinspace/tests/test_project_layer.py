"""Project 读取层（团队协作真表 ``Project``）+ 执行解析行为测试。

#3266 终态（principle/workspace-project.md）：Project 已从 ``Space(type=team_space)``
壳独立成真表；本层以 Project 产品语言读写协作房间，成员用 :class:`ProjectMembership`
挂载，执行仍落到成员各自的 :class:`Workspace`。
"""
from __future__ import annotations

from django.test import TransactionTestCase

from apps.tabtinspace.models import (
    Device,
    Project,
    ProjectMembership,
    ProjectMemberWorkspace,
    SpaceMembership,
    Workspace,
)
from apps.tabtinspace.services.project_execution import (
    resolve_project_execution_workspace,
)
from apps.tabtinspace.services.project_service import ProjectService
from apps.tabtinspace.schemas.membership import SpaceMembershipOut
from apps.tabtinspace.tests.fixtures import (
    TABTINSPACE_DB_ALIAS,
    cleanup_test_organization,
    create_test_organization_with_agent,
)


class ProjectLayerTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.ctx = create_test_organization_with_agent(prefix="projlayer")
        self.user = self.ctx["user"]
        self.organization = self.ctx["organization"]
        self.agent = self.ctx["agent"]
        # Space(type=workspace)，其 agent 归属 user —— 成员的个人执行现场。
        self.workspace = self.ctx["space"]
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name='Project layer device',
            device_type='electron',
            role='control',
            fingerprint=f'project-layer-{self.user.id}',
        )
        self.execution_workspace = Workspace.objects.create(
            organization=self.organization,
            created_by=self.user,
            device=self.device,
            name='Project layer workspace',
            working_dir=f'/tmp/project-layer-{self.user.id}',
            normalized_working_dir=f'/tmp/project-layer-{self.user.id}',
        )

    def tearDown(self):
        cleanup_test_organization(self.organization, delete_user=True)

    def _make_project_room(self, name: str = "Collab Room") -> Project:
        """协作房间 = :class:`Project` + owner :class:`ProjectMembership`。

        Agent 参与仍复用 :class:`SpaceMembership`（终态 Project 主 Agent 落在 Task 与
        primary agent 语义上，成员 Agent 关系历史上挂在 SpaceMembership 未收编——
        本测试保留写法验证读侧兼容 id-reuse 契约）。
        """
        room = Project.objects.create(
            organization=self.organization,
            name=name,
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

    def test_list_projects_returns_project_rooms(self):
        room = self._make_project_room()
        service = ProjectService(user=self.user)

        projects, total = service.list_projects(organization_id=self.organization.id)
        self.assertEqual(total, 1)
        self.assertEqual([p.id for p in projects], [room.id])
        self.assertEqual(service.member_count(room), 1)

    def test_get_project_returns_accessible_room(self):
        room = self._make_project_room()
        service = ProjectService(user=self.user)

        got = service.get_project(room.id)
        self.assertIsNotNone(got)
        self.assertEqual(got.id, room.id)

    def test_get_project_ignores_workspace_space(self):
        """个人 Workspace 不是 Project，get_project 不返回。"""
        service = ProjectService(user=self.user)
        self.assertIsNone(service.get_project(self.workspace.id))

    def test_resolve_member_workspace_requires_project_companion(self):
        room = self._make_project_room()
        self.assertIsNone(resolve_project_execution_workspace(project=room, user=self.user))

        ProjectMemberWorkspace.objects.create(
            project=room,
            user=self.user,
            workspace=self.execution_workspace,
        )
        resolved = resolve_project_execution_workspace(project=room, user=self.user)
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.id, self.execution_workspace.id)

    def test_resolve_member_workspace_none_without_link(self):
        room = self._make_project_room()
        resolved = resolve_project_execution_workspace(project=room, user=self.user)
        self.assertIsNone(resolved)

    def test_formal_agent_membership_exposes_role_and_responsibility(self):
        """Agent 参与保留 SpaceMembership 承接（id-reuse：workspace_id == project.id
        映射由服务层处理）；本用例只覆盖字段序列化契约。"""
        room = self._make_project_room()
        companion = Workspace.objects.create(
            organization=self.organization,
            created_by=self.user,
            device=self.device,
            name='Agent companion',
            working_dir=f'/tmp/agent-companion-{self.user.id}',
            normalized_working_dir=f'/tmp/agent-companion-{self.user.id}',
        )
        membership = SpaceMembership.objects.using(TABTINSPACE_DB_ALIAS).create(
            workspace_id=companion.id,
            agent_id=self.agent.id,
            role="editor",
            is_active=True,
            role_label="Quality Lead",
            responsibility="Own release evidence and risk review",
            persona_override="Be strict",
        )

        payload = SpaceMembershipOut.from_orm(membership).dict()

        self.assertEqual(payload["role_label"], "Quality Lead")
        self.assertEqual(payload["responsibility"], "Own release evidence and risk review")
        self.assertEqual(payload["persona_override"], "Be strict")

    def test_project_primary_agent_setter_is_compat_noop(self):
        """#3266 终态：primary Agent 概念被 Task-level selected_agent 取代；
        set_primary_agent 保留为兼容点，返回 None 且不改数据（本用例只锁契约）。"""
        room = self._make_project_room()
        SpaceMembership.objects.using(TABTINSPACE_DB_ALIAS).create(
            workspace_id=self.execution_workspace.id,
            agent_id=self.agent.id,
            role="editor",
            is_active=True,
        )
        service = ProjectService(user=self.user)

        self.assertIsNone(service.set_primary_agent(project_id=room.id, agent_id=self.agent.id))

    def test_mobile_project_payload_does_not_fallback_to_unlinked_space(self):
        room = self._make_project_room()
        service = ProjectService(user=self.user)

        self.assertIsNone(service.serialize_my_workspace(project=room, user=self.user))

        ProjectMemberWorkspace.objects.create(
            project=room,
            user=self.user,
            workspace=self.execution_workspace,
        )
        payload = service.serialize_my_workspace(project=room, user=self.user)

        self.assertIsNotNone(payload)
        self.assertEqual(payload["id"], str(self.execution_workspace.id))
        # ：用户资产改绑后仍有 project_id，但 is_companion 看供给来源
        self.assertEqual(payload["provisioning_source"], Workspace.ProvisioningSource.USER)
        self.assertFalse(payload["is_companion"])

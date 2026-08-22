"""伴生 Workspace 供给（Phase 1）：``ensure_project_workspace`` + 执行解析边界。

Project 下每个成员恰好一个私有 Workspace，关系由 ``ProjectMemberWorkspace``
显式记录；执行解析不能静默借用同组织的普通 Workspace。
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.tabchat.models import Conversation
from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    ProjectMemberWorkspace,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.project_execution import (
    ensure_project_workspace,
    resolve_project_execution_workspace,
)
from apps.tabtinspace.services.project_service import ProjectService
from apps.tabtinspace.services.workspace_service import (
    serialize_workspace,
    serialize_workspaces,
)

User = get_user_model()


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class ProjectWorkspaceProvisioningTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        user_manager = User.objects.db_manager("default")
        self.owner = user_manager.create_user(
            username="proj_owner", email="proj-owner@test.com", password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Provisioning Team", owner_id=self.owner.id, is_default=False,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role="owner")
        self.device = Device.objects.create(
            organization=self.organization, user=self.owner, name="Owner Mac",
            device_type="electron", role="control", fingerprint="prov-owner-fp",
        )
        self.project = Project.objects.create(
            organization=self.organization, name="Launch Project",
        )
        ProjectMembership.objects.create(
            project=self.project,
            user_id=self.owner.id,
            role="owner",
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )

    def test_ensure_creates_companion_workspace_linked_to_project(self):
        workspace = ensure_project_workspace(
            project=self.project,
            user=self.owner,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )

        self.assertEqual(workspace.created_by_id, self.owner.id)
        self.assertEqual(workspace.name, f'{self.project.name} 项目的默认 Workspace')
        self.assertTrue(
            ProjectMemberWorkspace.objects.filter(
                project=self.project,
                user=self.owner,
                workspace=workspace,
            ).exists()
        )

    def test_ensure_is_idempotent_per_project_and_user(self):
        first = ensure_project_workspace(
            project=self.project, user=self.owner, device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )
        second = ensure_project_workspace(
            project=self.project, user=self.owner, device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(
            ProjectMemberWorkspace.objects.filter(project=self.project, user=self.owner).count(),
            1,
        )

    def test_ensure_returns_existing_linked_workspace_without_renaming(self):
        """已挂 PMW 的现场直接复用；展示名由调用方治理，ensure 不再改名。"""
        legacy_name = f'{self.project.name} 的伴生 Workspace'
        working_dir = '/Users/me/TabTin/team/launch-project'
        legacy = self._create_owned_workspace(legacy_name, working_dir)
        ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.owner,
            workspace=legacy,
        )

        workspace = ensure_project_workspace(
            project=self.project,
            user=self.owner,
            device_id=self.device.id,
            working_dir=working_dir,
        )

        self.assertEqual(workspace.id, legacy.id)
        workspace.refresh_from_db()
        self.assertEqual(workspace.name, legacy_name)

    def _create_owned_workspace(
        self,
        name: str,
        working_dir: str,
        *,
        device: Device | None = None,
    ) -> Workspace:
        return Workspace.objects.create(
            organization=self.organization,
            created_by=self.owner,
            device=device or self.device,
            name=name,
            working_dir=working_dir,
            normalized_working_dir=working_dir,
        )

    def test_resolve_uses_companion_workspace_not_generic_workspace(self):
        # 普通 Workspace（不属于任何 Project）不能成为 Project 执行现场。
        self._create_owned_workspace("Generic Workspace", "/Users/me/generic")

        companion = ensure_project_workspace(
            project=self.project, user=self.owner, device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )

        resolved = resolve_project_execution_workspace(project=self.project, user=self.owner)
        self.assertEqual(resolved.id, companion.id)

    def test_resolve_uses_explicit_link_instead_of_device_heuristic(self):
        online_device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Online Mac",
            device_type="electron",
            role="control",
            fingerprint="prov-online-fp",
            status="online",
        )
        self._create_owned_workspace(
            "Newer Offline Companion",
            "/Users/me/offline-companion",
        )
        online = self._create_owned_workspace(
            "Older Online Companion",
            "/Users/me/online-companion",
            device=online_device,
        )
        ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.owner,
            workspace=online,
        )

        resolved = resolve_project_execution_workspace(project=self.project, user=self.owner)

        self.assertEqual(resolved.id, online.id)

    def test_resolve_returns_none_when_no_companion_provisioned(self):
        self._create_owned_workspace("Ordinary Workspace", "/Users/me/ordinary")

        resolved = resolve_project_execution_workspace(project=self.project, user=self.owner)
        self.assertIsNone(resolved)

    def test_ensure_rejects_device_not_owned_by_user(self):
        outsider = User.objects.db_manager("default").create_user(
            username="outsider", email="outsider@test.com", password="testpass123",
        )

        # ensure_project_workspace 要求 device 属于当前 user；组织成员校验在调用方。
        with self.assertRaises(ValueError):
            ensure_project_workspace(
                project=self.project, user=outsider, device_id=self.device.id,
                working_dir="/Users/me/outsider",
            )

    def test_ensure_my_workspace_for_active_member(self):
        # owner 在 setUp 已有 owner membership（生效成员）。
        result = ProjectService(user=self.owner).ensure_my_workspace(
            project_id=self.project.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )
        workspace = Workspace.objects.get(id=result["id"])
        self.assertTrue(ProjectMemberWorkspace.objects.filter(
            project=self.project,
            user=self.owner,
            workspace=workspace,
        ).exists())
        self.assertEqual(result["project_id"], str(self.project.id))
        self.assertEqual(result["control_device_id"], str(self.device.id))
        self.assertIsNone(result["execution_agent_id"])

    def test_create_project_with_my_workspace_creates_project_and_workspace(self):
        project, workspace_payload = ProjectService(user=self.owner).create_project_with_my_workspace(
            organization_id=self.organization.id,
            name="New Launch",
            description="Ship it",
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/new-launch",
            working_dir_type="mixed",
        )

        self.assertIsInstance(project, Project)
        self.assertEqual(project.name, "New Launch")
        self.assertTrue(
            ProjectMembership.objects.filter(
                project=project, user_id=self.owner.id, role="owner", is_active=True,
            ).exists()
        )
        workspace = Workspace.objects.get(id=workspace_payload["id"])
        self.assertTrue(ProjectMemberWorkspace.objects.filter(
            project=project,
            user=self.owner,
            workspace=workspace,
        ).exists())
        self.assertEqual(workspace.working_dir, "/Users/me/TabTin/team/new-launch")
        self.assertEqual(workspace_payload["organization_id"], str(self.organization.id))
        self.assertEqual(workspace_payload["project_id"], str(project.id))
        self.assertEqual(workspace_payload["type"], "workspace")
        self.assertEqual(workspace_payload["control_device_id"], str(self.device.id))
        self.assertIsNone(workspace_payload["execution_agent_id"])
        self.assertFalse(Conversation.objects.filter(space_id=project.id).exists())

    def test_ensure_my_workspace_rejects_non_member(self):
        outsider = User.objects.db_manager("default").create_user(
            username="ensure_outsider", email="ensure_outsider@test.com", password="testpass123",
        )
        with self.assertRaises(ServiceError) as ctx:
            ProjectService(user=outsider).ensure_my_workspace(
                project_id=self.project.id,
                device_id=self.device.id,
                working_dir="/Users/outsider/x",
            )
        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")

    def test_router_serializes_my_workspace_for_current_user(self):
        workspace = ensure_project_workspace(
            project=self.project, user=self.owner, device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )

        service = ProjectService(user=self.owner)
        payload = service.serialize_my_workspace(project=self.project, user=self.owner)

        self.assertIsNotNone(payload)
        self.assertEqual(payload["id"], str(workspace.id))
        self.assertEqual(payload["working_dir"], workspace.working_dir)
        self.assertEqual(payload["project_id"], str(self.project.id))
        self.assertEqual(payload["control_device_id"], str(self.device.id))
        self.assertIsNone(payload["execution_agent_id"])
        self.assertTrue(payload["is_companion"])

    def test_serialize_workspace_marks_companion_with_project_id(self):
        personal = self._create_owned_workspace("Personal Workspace", "/Users/me/personal")
        companion = ensure_project_workspace(
            project=self.project, user=self.owner, device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )

        personal_payload = serialize_workspace(personal)
        companion_payload = serialize_workspace(companion)
        self.assertIsNone(personal_payload["project_id"])
        self.assertEqual(personal_payload["provisioning_source"], Workspace.ProvisioningSource.USER)
        self.assertFalse(personal_payload["is_companion"])
        self.assertEqual(companion_payload["project_id"], str(self.project.id))
        self.assertEqual(
            companion_payload["provisioning_source"],
            Workspace.ProvisioningSource.SYSTEM_PROJECT,
        )
        self.assertTrue(companion_payload["is_companion"])

        batch = {
            item["id"]: item
            for item in serialize_workspaces([personal, companion])
        }
        self.assertIsNone(batch[str(personal.id)]["project_id"])
        self.assertEqual(batch[str(companion.id)]["project_id"], str(self.project.id))
        self.assertTrue(batch[str(companion.id)]["is_companion"])

    def test_ensure_marks_new_workspace_as_system_project_source(self):
        workspace = ensure_project_workspace(
            project=self.project,
            user=self.owner,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )
        workspace.refresh_from_db()
        self.assertEqual(
            workspace.provisioning_source,
            Workspace.ProvisioningSource.SYSTEM_PROJECT,
        )
        self.assertTrue(workspace.is_system_provisioned)

    def test_rebinding_user_workspace_keeps_visible_provisioning_source(self):
        """#6846：用户主动 Workspace 挂到 Project 后仍 is_companion=false。"""
        personal = self._create_owned_workspace("Personal Workspace", "/Users/me/personal")
        self.assertEqual(personal.provisioning_source, Workspace.ProvisioningSource.USER)

        ProjectMemberWorkspace.objects.create(
            project=self.project,
            user=self.owner,
            workspace=personal,
        )
        personal.refresh_from_db()
        self.assertEqual(personal.provisioning_source, Workspace.ProvisioningSource.USER)

        payload = serialize_workspace(personal)
        self.assertEqual(payload["project_id"], str(self.project.id))
        self.assertEqual(payload["provisioning_source"], Workspace.ProvisioningSource.USER)
        self.assertFalse(payload["is_companion"])

    def test_ensure_reuses_existing_user_workspace_without_rewriting_source(self):
        existing = self._create_owned_workspace(
            "Already Mine",
            "/Users/me/TabTin/team/launch-project",
        )
        self.assertEqual(existing.provisioning_source, Workspace.ProvisioningSource.USER)

        workspace = ensure_project_workspace(
            project=self.project,
            user=self.owner,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )
        self.assertEqual(workspace.id, existing.id)
        workspace.refresh_from_db()
        self.assertEqual(workspace.provisioning_source, Workspace.ProvisioningSource.USER)
        self.assertFalse(serialize_workspace(workspace)["is_companion"])

    def test_ensure_does_not_reuse_previous_users_workspace_on_same_device(self):
        """设备切换账号后，Project 伴生现场也必须按当前用户隔离。"""
        working_dir = "/Users/me/TabTin/team/shared-project"
        previous_workspace = self._create_owned_workspace(
            "Previous User Workspace",
            working_dir,
        )
        next_user = User.objects.db_manager("default").create_user(
            username="proj_next_user",
            email="proj-next-user@test.com",
            password="testpass123",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=next_user,
            role="editor",
        )
        ProjectMembership.objects.create(
            project=self.project,
            user_id=next_user.id,
            role="member",
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )
        self.device.user = next_user
        self.device.save(update_fields=["user", "updated_at"])

        workspace = ensure_project_workspace(
            project=self.project,
            user=next_user,
            device_id=self.device.id,
            working_dir=working_dir,
        )

        self.assertNotEqual(workspace.id, previous_workspace.id)
        self.assertEqual(workspace.organization_id, self.organization.id)
        self.assertEqual(workspace.created_by_id, next_user.id)

    def test_workspace_inventory_includes_project_workspace(self):
        personal = self._create_owned_workspace("Personal Workspace", "/Users/me/personal")
        companion = ensure_project_workspace(
            project=self.project, user=self.owner, device_id=self.device.id,
            working_dir="/Users/me/TabTin/team/launch-project",
        )

        space_ids = set(Workspace.objects.filter(
            organization=self.organization,
            created_by=self.owner,
        ).values_list('id', flat=True))

        self.assertIn(personal.id, space_ids)
        self.assertIn(companion.id, space_ids)

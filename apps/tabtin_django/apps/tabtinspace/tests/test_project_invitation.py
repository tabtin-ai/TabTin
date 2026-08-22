"""Project 级邀请-接受（Phase 2）：pending 成员 + Electron 接受即供给伴生 Workspace。

覆盖：owner 邀请建 pending 成员、非 Organization 成员拒绝、接受激活并供给伴生 Workspace、
拒绝删 pending、pending 成员不计入生效成员、重复邀请幂等。

#3266 终态：Project 是独立真表，成员挂 :class:`ProjectMembership`；伴生 Workspace
是 :class:`Workspace` 真表行，不再是 Space(type=workspace) 壳。
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.project_invitation_service import ProjectInvitationService
from apps.tabtinspace.services.project_service import ProjectService

User = get_user_model()


def _make_user(username: str):
    u = User.objects.db_manager("default").create_user(
        username=username, email=f"{username}@test.com", password="testpass123",
    )
    User.objects.db_manager("postgresql").create_user(
        id=u.id, username=username, email=f"{username}@test.com", password="testpass123",
    )
    return u


class ProjectInvitationTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user("proj_inv_owner")
        self.member = _make_user("proj_inv_member")
        self.outsider = _make_user("proj_inv_outsider")

        self.organization = Organization.objects.create(
            name="Invitation Team", owner_id=self.owner.id, is_default=False,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role="owner")
        # member 是 Organization 成员（Project 邀请前置），outsider 不是。
        OrganizationMember.objects.create(organization=self.organization, user=self.member, role="editor")

        self.project = Project.objects.create(
            organization=self.organization, name="Launch Project",
        )
        ProjectMembership.objects.create(
            project=self.project, user=self.owner, role="owner", is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )
        self.member_device = Device.objects.create(
            organization=self.organization, user=self.member, name="Member Mac",
            device_type="electron", role="control", fingerprint="member-mac-fp",
        )

    def test_owner_invite_creates_pending_membership(self):
        service = ProjectInvitationService(user=self.owner)
        membership = service.invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id), role="editor",
        )
        self.assertEqual(membership.status, ProjectMembership.Status.PENDING)
        self.assertFalse(membership.is_active)
        self.assertEqual(str(membership.invited_by), str(self.owner.id))

    def test_pending_member_not_counted_as_active(self):
        ProjectInvitationService(user=self.owner).invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id),
        )
        # member_count 只算生效成员（owner），pending 不计入。
        self.assertEqual(ProjectService(user=self.owner).member_count(self.project), 1)

    def test_invite_rejects_non_organization_member(self):
        service = ProjectInvitationService(user=self.owner)
        with self.assertRaises(ServiceError) as ctx:
            service.invite_member(
                project_id=self.project.id, target_user_id=str(self.outsider.id),
            )
        self.assertEqual(ctx.exception.code, "ORGANIZATION_MEMBER_REQUIRED")

    def test_non_owner_cannot_invite(self):
        service = ProjectInvitationService(user=self.member)
        with self.assertRaises(ServiceError):
            service.invite_member(
                project_id=self.project.id, target_user_id=str(self.member.id),
            )

    def test_accept_activates_and_provisions_companion_workspace(self):
        ProjectInvitationService(user=self.owner).invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id), role="editor",
        )

        result = ProjectInvitationService(user=self.member).accept(
            project_id=self.project.id,
            device_id=self.member_device.id,
            working_dir="/Users/member/TabTin/team/launch-project",
        )

        membership = ProjectMembership.objects.get(
            project=self.project, user_id=self.member.id,
        )
        self.assertEqual(membership.status, ProjectMembership.Status.ACTIVE)
        self.assertTrue(membership.is_active)

        workspace = Workspace.objects.get(id=result["workspace"]["id"])
        self.assertEqual(workspace.created_by_id, self.member.id)
        self.assertEqual(
            ProjectService(user=self.member).resolve_member_workspace(
                project=self.project, user=self.member,
            ).id,
            workspace.id,
        )

    def test_accept_requires_device_and_working_dir(self):
        ProjectInvitationService(user=self.owner).invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id),
        )
        with self.assertRaises(ServiceError) as ctx:
            ProjectInvitationService(user=self.member).accept(
                project_id=self.project.id, device_id=self.member_device.id, working_dir="  ",
            )
        self.assertEqual(ctx.exception.code, "WORKING_DIR_REQUIRED")

    def test_accept_without_invitation_fails(self):
        with self.assertRaises(ServiceError) as ctx:
            ProjectInvitationService(user=self.member).accept(
                project_id=self.project.id,
                device_id=self.member_device.id,
                working_dir="/Users/member/x",
            )
        self.assertEqual(ctx.exception.code, "INVITATION_NOT_FOUND")

    def test_reject_removes_pending(self):
        ProjectInvitationService(user=self.owner).invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id),
        )
        ProjectInvitationService(user=self.member).reject(project_id=self.project.id)
        self.assertFalse(
            ProjectMembership.objects.filter(project=self.project, user_id=self.member.id).exists()
        )

    def test_invite_is_idempotent_when_repeated(self):
        service = ProjectInvitationService(user=self.owner)
        first = service.invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id), role="editor",
        )
        second = service.invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id), role="viewer",
        )
        self.assertEqual(first.id, second.id)
        self.assertEqual(second.role, "viewer")
        self.assertEqual(
            ProjectMembership.objects.filter(project=self.project, user_id=self.member.id).count(), 1,
        )

    def test_invite_existing_active_member_conflicts(self):
        service = ProjectInvitationService(user=self.owner)
        service.invite_member(project_id=self.project.id, target_user_id=str(self.member.id))
        ProjectInvitationService(user=self.member).accept(
            project_id=self.project.id, device_id=self.member_device.id,
            working_dir="/Users/member/x",
        )
        with self.assertRaises(ServiceError) as ctx:
            service.invite_member(project_id=self.project.id, target_user_id=str(self.member.id))
        self.assertEqual(ctx.exception.code, "ALREADY_MEMBER")

    def test_list_my_pending_invitations(self):
        ProjectInvitationService(user=self.owner).invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id), role="editor",
        )
        rows = ProjectInvitationService(user=self.member).list_my_pending_invitations()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["project"].id, self.project.id)
        self.assertEqual(rows[0]["membership"].role, "editor")

    def test_list_project_pending_invitations_for_owner(self):
        ProjectInvitationService(user=self.owner).invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id), role="editor",
        )
        rows = ProjectInvitationService(user=self.owner).list_project_pending_invitations(
            project_id=self.project.id,
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["user_id"], str(self.member.id))
        self.assertEqual(rows[0]["role"], "editor")

    def test_outsider_cannot_list_project_pending_invitations(self):
        ProjectInvitationService(user=self.owner).invite_member(
            project_id=self.project.id, target_user_id=str(self.member.id),
        )
        with self.assertRaises(ServiceError) as ctx:
            ProjectInvitationService(user=self.outsider).list_project_pending_invitations(
                project_id=self.project.id,
            )
        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")

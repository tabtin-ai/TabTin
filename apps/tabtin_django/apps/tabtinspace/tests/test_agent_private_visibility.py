"""Agent 私有可见性回归测试。

产品口径：所有 Agent 都是用户私有资源。Organization 成员关系不能让成员默认
枚举、读取、更新或在侧栏看到其他用户的 bot Agent。
"""

from django.test import TestCase

from apps.tabtinspace.models import Agent, Device, Space, SpaceMembership, Workspace, OrganizationMember, ProjectMembership
from apps.tabtinspace.services.access_service import SpaceAccessService
from apps.tabtinspace.services.agent_service import AgentService
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.tests.fixtures import (
    create_test_user,
    create_test_organization,
)


class AgentPrivateVisibilityTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="agentprivate-owner")
        self.member = create_test_user(prefix="agentprivate-member")
        self.organization = create_test_organization(
            owner=self.owner,
            prefix="agentprivate",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )

        self.owner_service = AgentService(user=self.owner)
        self.owner_device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint="agentprivate-owner-device",
        )
        self.member_device = Device.objects.create(
            organization=self.organization,
            user=self.member,
            name="Member Mac",
            device_type="electron",
            role="control",
            fingerprint="agentprivate-member-device",
        )
        self.owner_agent, self.owner_space, _warning = self.owner_service.create_agent_workspace(
            organization_id=self.organization.id,
            name="Owner Private Bot",
            device_fingerprint=self.owner_device.fingerprint,
            working_dir="/Users/owner/TabTin/owner-private",
            working_dir_type="mixed",
        )
        self.member_agent, _member_space, _warning = AgentService(user=self.member).create_agent_workspace(
            organization_id=self.organization.id,
            name="Member Private Bot",
            device_fingerprint=self.member_device.fingerprint,
            working_dir="/Users/member/TabTin/member-private",
            working_dir_type="mixed",
        )

        # 模拟历史数据：团队成员曾被写进他人的 private workspace。
        SpaceMembership.objects.get_or_create(
            workspace=self.owner_space,
            user=self.member,
            defaults={"role": "viewer", "is_active": True},
        )

    def test_organization_agent_list_only_returns_current_users_agents(self) -> None:
        owner_ids = set(
            SpaceAccessService(user=self.owner)
            .list_organization_agents(self.organization.id)
            .values_list("id", flat=True)
        )
        member_ids = set(
            SpaceAccessService(user=self.member)
            .list_organization_agents(self.organization.id)
            .values_list("id", flat=True)
        )

        self.assertIn(self.owner_agent.id, owner_ids)
        self.assertNotIn(self.owner_agent.id, member_ids)

    def test_combined_creation_provisions_independent_workspace(self) -> None:
        workspace = Workspace.objects.get(id=self.owner_space.id)
        self.assertEqual(workspace.created_by_id, self.owner.id)
        self.assertEqual(workspace.device_id, self.owner_device.id)
        self.assertEqual(workspace.working_dir, "/Users/owner/TabTin/owner-private")

    def test_agent_detail_and_update_require_agent_owner(self) -> None:
        member_service = AgentService(user=self.member)

        self.assertIsNone(member_service.get_agent(self.owner_agent.id))
        with self.assertRaises(ServiceError) as cm:
            member_service.update_agent(
                agent_id=self.owner_agent.id,
                name="Member Should Not Rename",
            )
        self.assertEqual(cm.exception.code, "PERMISSION_DENIED")

    def test_legacy_bot_space_membership_does_not_make_agent_visible(self) -> None:
        spaces, total = SpaceService(user=self.member).list_spaces(
            organization_id=self.organization.id,
            is_archived=False,
        )

        visible_space_ids = {space.id for space in spaces}
        self.assertEqual(total, 1)
        self.assertIn(self.member_agent.spaces.get().id, visible_space_ids)
        self.assertNotIn(self.owner_space.id, visible_space_ids)

    def test_space_list_defaults_to_workspace_spaces_only(self) -> None:
        legacy_space = Space.objects.create(
            organization=self.organization,
            name="Legacy Team Space",
            type="team",
            status="active",
        )
        ProjectMembership.objects.create(
            project=legacy_space,
            user=self.member,
            role="viewer",
            is_active=True,
        )

        spaces, total = SpaceService(user=self.member).list_spaces(
            organization_id=self.organization.id,
            is_archived=False,
        )

        self.assertEqual(total, 1)
        self.assertEqual([space.id for space in spaces], [self.member_agent.spaces.get().id])

    def test_space_share_and_delegation_service_methods_are_retired(self) -> None:
        service = SpaceAccessService(user=self.owner)

        self.assertFalse(hasattr(service, "create_space_share"))
        self.assertFalse(hasattr(service, "create_delegation"))
        self.assertFalse(hasattr(service, "list_space_shares"))
        self.assertFalse(hasattr(service, "list_delegations"))

    def test_private_agent_space_cannot_add_team_membership(self) -> None:
        service = SpaceAccessService(user=self.owner)

        with self.assertRaises(ServiceError) as cm:
            service.add_space_membership(
                space_id=self.owner_space.id,
                user_id=str(self.member.id),
                role="viewer",
            )
        self.assertEqual(cm.exception.code, "AGENT_PRIVATE_NOT_SHAREABLE")

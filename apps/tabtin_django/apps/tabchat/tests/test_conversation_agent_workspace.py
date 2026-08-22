"""ConversationAgentWorkspace 绑定服务测试。"""

from __future__ import annotations

from django.test import TestCase
from django.utils import timezone

from apps.tabchat.models import ConversationAgentWorkspace, ConversationMember
from apps.tabchat.services.conversation_agent_workspace_service import (
    WORKSPACE_UNTRUSTED_REASON,
    ConversationAgentWorkspaceService,
)
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabtinspace.models import (
    Agent,
    Device,
    Organization,
    OrganizationMember,
    Project,
    SpaceMembership,
    Workspace,
)
from apps.tabtinspace.tests.fixtures import create_test_user


def _make_workspace(organization, user, name="Home", fingerprint=None, **overrides):
    device = Device.objects.create(
        organization=organization,
        user=user,
        name=f"{name} Device",
        device_type="electron",
        role="control",
        fingerprint=fingerprint or f"caw-{organization.id}-{user.id}-{name}",
        status="online",
    )
    workspace = Workspace.objects.create(
        organization=organization,
        device=device,
        created_by=user,
        name=name,
        working_dir=f"/tmp/{device.fingerprint}",
        normalized_working_dir=f"/tmp/{device.fingerprint}",
        kind=Workspace.Kind.HOME,
        trust_status=Workspace.TrustStatus.TRUSTED,
        trust_source=Workspace.TrustSource.USER_CONFIRMED,
        trusted_at=timezone.now(),
        provisioning_source=Workspace.ProvisioningSource.USER,
        **overrides,
    )
    SpaceMembership.objects.create(
        workspace=workspace,
        user=user,
        role="owner",
        is_active=True,
        status=SpaceMembership.Status.ACTIVE,
    )
    return workspace


class ConversationAgentWorkspaceServiceTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="caw-owner")
        self.other = create_test_user(prefix="caw-other")
        self.organization = Organization.objects.create(name="CAW Org", owner=self.owner)
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.other,
            role="admin",
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="主人助手",
            type="bot",
        )
        self.workspace = _make_workspace(self.organization, self.owner, name="Owner Home")
        self.other_workspace = _make_workspace(self.organization, self.other, name="Other Home")
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.owner.id),
            name="普通群",
            member_ids=[str(self.other.id)],
        )

    def test_owner_can_bind_owned_workspace(self):
        binding = ConversationAgentWorkspaceService.bind_agent(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
            str(self.workspace.id),
        )
        self.assertEqual(binding["agent_id"], str(self.agent.id))
        self.assertEqual(binding["workspace_id"], str(self.workspace.id))
        self.assertTrue(
            ConversationMember.objects.filter(
                conversation=self.conv,
                agent_id=str(self.agent.id),
            ).exists()
        )

    def test_non_owner_cannot_bind_other_agent(self):
        with self.assertRaises(PermissionError):
            ConversationAgentWorkspaceService.bind_agent(
                str(self.conv.id),
                str(self.other.id),
                str(self.agent.id),
                str(self.workspace.id),
            )

    def test_regular_member_can_bind_own_agent(self):
        member_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.other,
            name="成员助手",
            type="bot",
        )
        binding = ConversationAgentWorkspaceService.bind_agent(
            str(self.conv.id),
            str(self.other.id),
            str(member_agent.id),
            str(self.other_workspace.id),
        )
        self.assertEqual(binding["agent_id"], str(member_agent.id))
        self.assertEqual(binding["workspace_id"], str(self.other_workspace.id))
        self.assertTrue(
            ConversationMember.objects.filter(
                conversation=self.conv,
                agent_id=str(member_agent.id),
            ).exists()
        )

    def test_cannot_bind_others_workspace(self):
        with self.assertRaises(ValueError):
            ConversationAgentWorkspaceService.bind_agent(
                str(self.conv.id),
                str(self.owner.id),
                str(self.agent.id),
                str(self.other_workspace.id),
            )

    def test_project_group_rejected(self):
        project = Project.objects.create(
            organization=self.organization,
            name="发布项目",
            status=Project.Status.ACTIVE,
            visibility="private",
        )
        self.conv.space_id = project.id
        self.conv.save(update_fields=["space_id"])
        with self.assertRaises(ValueError):
            ConversationAgentWorkspaceService.bind_agent(
                str(self.conv.id),
                str(self.owner.id),
                str(self.agent.id),
                str(self.workspace.id),
            )

    def test_untrusted_workspace_rejected(self):
        self.workspace.trust_status = Workspace.TrustStatus.UNTRUSTED
        self.workspace.save(update_fields=["trust_status", "updated_at"])
        with self.assertRaises(ValueError) as ctx:
            ConversationAgentWorkspaceService.bind_agent(
                str(self.conv.id),
                str(self.owner.id),
                str(self.agent.id),
                str(self.workspace.id),
            )
        self.assertEqual(str(ctx.exception), WORKSPACE_UNTRUSTED_REASON)

    def test_owner_can_bind_workspace_on_others_device(self):
        device = self.workspace.device
        device.user = self.other
        device.save(update_fields=["user"])
        binding = ConversationAgentWorkspaceService.bind_agent(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
            str(self.workspace.id),
        )
        self.assertEqual(binding["workspace_id"], str(self.workspace.id))
        self.assertTrue(binding["is_executable"])

    def test_owner_can_rebind_and_list(self):
        ConversationAgentWorkspaceService.bind_agent(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
            str(self.workspace.id),
        )
        extra = _make_workspace(
            self.organization,
            self.owner,
            name="Second Home",
            fingerprint=f"caw-second-{self.owner.id}",
        )
        updated = ConversationAgentWorkspaceService.update_binding(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
            str(extra.id),
        )
        self.assertEqual(updated["workspace_id"], str(extra.id))
        items = ConversationAgentWorkspaceService.list_bindings(
            str(self.conv.id),
            str(self.owner.id),
        )
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["workspace_name"], "Second Home")
        self.assertTrue(items[0]["can_rebind"])
        self.assertTrue(items[0]["is_executable"])

    def test_untrusted_binding_lists_as_not_executable(self):
        ConversationAgentWorkspaceService.bind_agent(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
            str(self.workspace.id),
        )
        self.workspace.trust_status = Workspace.TrustStatus.UNTRUSTED
        self.workspace.save(update_fields=["trust_status", "updated_at"])
        items = ConversationAgentWorkspaceService.list_bindings(
            str(self.conv.id),
            str(self.owner.id),
        )
        self.assertEqual(len(items), 1)
        self.assertFalse(items[0]["is_executable"])
        self.assertTrue(items[0]["can_rebind"])

    def test_unbind_removes_member_and_binding(self):
        ConversationAgentWorkspaceService.bind_agent(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
            str(self.workspace.id),
        )
        removed = ConversationAgentWorkspaceService.unbind_agent(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
        )
        self.assertTrue(removed)
        self.assertFalse(
            ConversationMember.objects.filter(
                conversation=self.conv,
                agent_id=str(self.agent.id),
            ).exists()
        )
        self.assertFalse(
            ConversationAgentWorkspace.objects.filter(
                conversation=self.conv,
                agent_id=str(self.agent.id),
            ).exists()
        )

    def test_conversation_detail_includes_agent_owner_fields(self):
        ConversationService.add_agents(
            str(self.conv.id),
            str(self.owner.id),
            [str(self.agent.id)],
        )
        detail = ConversationService.get_conversation_detail(
            str(self.conv.id),
            str(self.owner.id),
        )
        agent_members = [row for row in detail["members"] if row["member_type"] == "agent"]
        self.assertEqual(len(agent_members), 1)
        self.assertEqual(agent_members[0]["agent_id"], str(self.agent.id))
        self.assertEqual(agent_members[0]["owner_user_id"], str(self.owner.id))
        self.assertEqual(
            agent_members[0]["owner_display_name"],
            self.owner.nickname or self.owner.username,
        )
        self.assertFalse(agent_members[0]["is_execution_online"])

    def test_conversation_detail_marks_bound_workspace_execution_online(self):
        ConversationAgentWorkspaceService.bind_agent(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
            str(self.workspace.id),
        )
        detail = ConversationService.get_conversation_detail(
            str(self.conv.id),
            str(self.owner.id),
        )
        agent_members = [row for row in detail["members"] if row["member_type"] == "agent"]
        self.assertTrue(agent_members[0]["is_execution_online"])

    def test_conversation_detail_marks_foreign_device_execution_offline(self):
        ConversationAgentWorkspaceService.bind_agent(
            str(self.conv.id),
            str(self.owner.id),
            str(self.agent.id),
            str(self.workspace.id),
        )
        device = self.workspace.device
        device.user = self.other
        device.save(update_fields=["user"])
        detail = ConversationService.get_conversation_detail(
            str(self.conv.id),
            str(self.owner.id),
        )
        agent_members = [row for row in detail["members"] if row["member_type"] == "agent"]
        self.assertFalse(agent_members[0]["is_execution_online"])

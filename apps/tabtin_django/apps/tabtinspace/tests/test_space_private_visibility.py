"""个人 Workspace 默认私有与共享可见性测试。

#3266：Space 表已 DROP；共享语义 = 是否存在非 owner 的 active SpaceMembership。
夹具走 create_test_personal_workspace；不再读写 Space.visibility。
"""

from django.test import TestCase

from apps.tabtinspace.models import (
    Agent,
    Device,
    OrganizationMember,
    SpaceMembership,
)
from apps.tabtinspace.services.access_service import SpaceAccessService
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.membership_utils import ensure_user_membership
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.services.space_visibility import (
    SpaceVisibility,
    _shared_workspace_ids,
)
from apps.tabtinspace.tests.fixtures import (
    create_test_user,
    create_test_organization,
    create_test_personal_workspace,
    create_test_bot_space,
)


class SpacePrivateVisibilityTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="spacevis-owner")
        self.member = create_test_user(prefix="spacevis-member")
        self.organization = create_test_organization(owner=self.owner, prefix="spacevis")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )

        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint="spacevis-owner-device",
        )

        created = create_test_personal_workspace(
            organization=self.organization,
            owner=self.owner,
            device=self.device,
            name="Private Workspace",
            working_dir="/Users/owner/TabTin/private-space",
            working_dir_type="mixed",
        )
        self.private_space = created["space"]
        self.assertIsNotNone(self.private_space)
        # 默认无私有外成员 → 视为 private
        self.assertNotIn(self.private_space.id, _shared_workspace_ids([self.private_space.id]))

    def test_new_space_defaults_to_private(self) -> None:
        self.assertNotIn(self.private_space.id, _shared_workspace_ids([self.private_space.id]))
        self.assertEqual(SpaceVisibility.PRIVATE, "private")

    def test_private_space_hidden_from_non_owner_in_list_and_search(self) -> None:
        service = SpaceService(user=self.member)
        spaces, total = service.list_spaces(organization_id=self.organization.id, is_archived=False)
        visible_ids = {space.id for space in spaces}
        self.assertNotIn(self.private_space.id, visible_ids)
        self.assertEqual(total, len(spaces))

        searched, search_total = service.search_spaces(
            organization_id=self.organization.id,
            keyword="Private",
        )
        self.assertEqual(search_total, 0)
        self.assertEqual(searched, [])

    def test_private_space_not_accessible_with_stale_viewer_membership(self) -> None:
        # 失效 membership：is_active=False，不构成共享
        SpaceMembership.objects.create(
            workspace_id=self.private_space.id,
            user=self.member,
            role="viewer",
            is_active=False,
        )
        space = SpaceService(user=self.member).get_space(self.private_space.id)
        self.assertIsNone(space)

    def test_owner_still_sees_private_space(self) -> None:
        spaces, total = SpaceService(user=self.owner).list_spaces(
            organization_id=self.organization.id,
            is_archived=False,
        )
        self.assertEqual(total, 1)
        self.assertEqual(spaces[0].id, self.private_space.id)

    def test_sharing_space_exposes_it_to_authorized_member(self) -> None:
        SpaceMembership.objects.create(
            workspace_id=self.private_space.id,
            user=self.member,
            role="editor",
            is_active=True,
        )
        self.assertIn(self.private_space.id, _shared_workspace_ids([self.private_space.id]))

        spaces, total = SpaceService(user=self.member).list_spaces(
            organization_id=self.organization.id,
            is_archived=False,
        )
        self.assertEqual(total, 1)
        self.assertEqual(spaces[0].id, self.private_space.id)
        self.assertIsNotNone(SpaceService(user=self.member).get_space(self.private_space.id))

    def test_organization_owner_cannot_bypass_private_space_visibility(self) -> None:
        member_device = Device.objects.create(
            organization=self.organization,
            user=self.member,
            name="Member Mac",
            device_type="electron",
            role="control",
            fingerprint="spacevis-member-device",
        )
        member_space = create_test_personal_workspace(
            organization=self.organization,
            owner=self.member,
            device=member_device,
            name="Member Private",
            working_dir="/Users/member/TabTin/member-only",
            working_dir_type="mixed",
        )["space"]
        self.assertIsNotNone(member_space)

        spaces, total = SpaceService(user=self.owner).list_spaces(
            organization_id=self.organization.id,
            is_archived=False,
        )
        visible_ids = {space.id for space in spaces}
        self.assertNotIn(member_space.id, visible_ids)
        self.assertIsNone(SpaceService(user=self.owner).get_space(member_space.id))

    def test_bot_agent_space_still_not_shareable(self) -> None:
        bot_agent = Agent.objects.create(
            organization=self.organization,
            name="Bot",
            type="bot",
            owner_user_id=self.owner.id,
            is_active=True,
        )
        bot_space = create_test_bot_space(
            organization=self.organization,
            agent=bot_agent,
            name="Bot Space",
            device=self.device,
            working_dir="/Users/owner/TabTin/bot-space",
            created_by_id=self.owner.id,
        )
        ensure_user_membership(bot_space, self.owner.id, "owner")

        with self.assertRaises(ServiceError) as cm:
            SpaceAccessService(user=self.owner).add_space_membership(
                space_id=bot_space.id,
                user_id=str(self.member.id),
                role="viewer",
            )
        self.assertEqual(cm.exception.code, "AGENT_PRIVATE_NOT_SHAREABLE")

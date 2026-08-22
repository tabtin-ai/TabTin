"""Team Space invite-only visibility tests ."""

import importlib
from types import SimpleNamespace

from django.apps import apps as django_apps
from django.db import connections
from django.test import TestCase, override_settings

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.notification.models import Notification
from apps.tabtinspace.models import Agent, ContextItem, Device, Space, SpaceMembership, OrganizationMember, ProjectMembership
from apps.tabtinspace.services.access_service import SpaceAccessService
from apps.tabtinspace.services.accessible_space_resolver import AccessibleSpaceResolver
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.context_item_service import ContextItemService
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.services.space_visibility import SpaceVisibility, user_can_access_space
from apps.tabtinspace.tests.fixtures import create_test_user, create_test_organization


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class TeamSpaceVisibilityTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="teamspace-owner")
        self.invited = create_test_user(prefix="teamspace-invited")
        self.removed = create_test_user(prefix="teamspace-removed")
        self.non_member = create_test_user(prefix="teamspace-nonmember")
        self.organization = create_test_organization(owner=self.owner, prefix="teamspace")
        for user in (self.invited, self.removed):
            OrganizationMember.objects.create(
                organization=self.organization,
                user=user,
                role="editor",
            )

        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint=f"teamspace-owner-device-{self.owner.id}",
        )
        self.execution_space = SpaceService(user=self.owner).create_space(
            organization_id=self.organization.id,
            name="Owner Workspace",
            device_id=self.device.id,
            working_dir="/Users/owner/TabTin/team-space-owner-workspace",
            working_dir_type="mixed",
        )
        self.assertIsNotNone(self.execution_space)

        self.team_space = SpaceService(user=self.owner).create_space(
            organization_id=self.organization.id,
            name="Team Room",
            space_type=Space.SpaceType.TEAM_SPACE,
            execution_space_id=self.execution_space.id,
        )
        self.assertIsNotNone(self.team_space)
        ContextItem.objects.create(
            project=self.team_space,
            item_type="external_link",
            title="Shared Team Asset",
            resource_id="",
            created_by=self.owner,
        )

    def _visible_team_space_ids(self, user):
        spaces, total = SpaceService(user=user).list_spaces(
            organization_id=self.organization.id,
            space_type=Space.SpaceType.TEAM_SPACE,
            is_archived=False,
        )
        return {space.id for space in spaces}, total

    def _asset_total(self, user) -> int:
        _items, total = ContextItemService(user=user).list_items(
            space_id=self.team_space.id,
            is_archived=False,
        )
        return total

    def _organization_asset_total(self, user) -> int:
        _items, total = ContextItemService(user=user).list_items(
            space_id=self.team_space.id,
            is_archived=False,
            scope="organization",
        )
        return total

    def _run_owner_only_migration(self) -> None:
        migration = importlib.import_module(
            "apps.tabtinspace.migrations.0079_owner_only_team_space_visibility"
        )
        schema_editor = SimpleNamespace(
            connection=connections[postgres_app_db_alias()],
        )
        migration.reset_team_spaces_to_owner_only(django_apps, schema_editor)

    def test_team_space_defaults_to_owner_only(self) -> None:
        self.team_space.refresh_from_db()
        self.assertEqual(self.team_space.visibility, SpaceVisibility.PRIVATE)
        self.assertEqual(
            ProjectMembership.objects.filter(
                project=self.team_space,
                is_active=True,
            ).count(),
            1,
        )
        self.assertTrue(
            ProjectMembership.objects.filter(
                project=self.team_space,
                user=self.owner,
                role="owner",
                is_active=True,
            ).exists()
        )

        visible_ids, total = self._visible_team_space_ids(self.invited)
        self.assertEqual(total, 0)
        self.assertNotIn(self.team_space.id, visible_ids)
        self.assertIsNone(SpaceService(user=self.invited).get_space(self.team_space.id))
        self.assertEqual(self._asset_total(self.invited), 0)
        self.assertEqual(self._organization_asset_total(self.invited), 0)
        self.assertNotIn(
            self.team_space.id,
            AccessibleSpaceResolver(self.invited.id, self.organization.id).resolve(),
        )

    def test_owner_can_add_organization_member_and_member_gains_access(self) -> None:
        service = SpaceAccessService(user=self.owner)

        with self.captureOnCommitCallbacks(execute=True):
            membership = service.add_space_membership(
                space_id=self.team_space.id,
                user_id=str(self.invited.id),
                role="editor",
            )

        self.assertEqual(membership.user_id, str(self.invited.id))
        self.assertTrue(membership.is_active)
        self.team_space.refresh_from_db()
        self.assertEqual(self.team_space.visibility, SpaceVisibility.SHARED)

        visible_ids, total = self._visible_team_space_ids(self.invited)
        self.assertEqual(total, 1)
        self.assertIn(self.team_space.id, visible_ids)
        self.assertIsNotNone(SpaceService(user=self.invited).get_space(self.team_space.id))
        self.assertEqual(self._asset_total(self.invited), 1)
        self.assertEqual(self._organization_asset_total(self.invited), 1)
        self.assertIn(
            self.team_space.id,
            AccessibleSpaceResolver(self.invited.id, self.organization.id).resolve(),
        )

        notification = Notification.objects.filter(
            user_id=str(self.invited.id),
            type="team_space.member_added",
            space_id=str(self.team_space.id),
        ).first()
        self.assertIsNotNone(notification)
        self.assertEqual(notification.metadata["action"], "member_added")

    def test_project_member_removal_is_deferred_and_access_remains(self) -> None:
        service = SpaceAccessService(user=self.owner)
        membership = service.add_space_membership(
            space_id=self.team_space.id,
            user_id=str(self.removed.id),
            role="editor",
        )
        self.assertEqual(self._asset_total(self.removed), 1)

        with self.assertRaises(ServiceError) as context:
            service.remove_space_membership(self.team_space.id, membership.id)
        self.assertEqual(context.exception.code, "PROJECT_MEMBERSHIP_REMOVAL_DEFERRED")
        membership.refresh_from_db()

        self.assertTrue(membership.is_active)
        visible_ids, total = self._visible_team_space_ids(self.removed)
        self.assertEqual(total, 1)
        self.assertIn(self.team_space.id, visible_ids)
        self.assertIsNotNone(SpaceService(user=self.removed).get_space(self.team_space.id))
        self.assertEqual(self._asset_total(self.removed), 1)
        self.assertEqual(self._organization_asset_total(self.removed), 1)
        self.assertIn(
            self.team_space.id,
            AccessibleSpaceResolver(self.removed.id, self.organization.id).resolve(),
        )

    def test_non_organization_member_cannot_access_team_space(self) -> None:
        non_member_ids, non_member_total = self._visible_team_space_ids(self.non_member)
        self.assertEqual(non_member_total, 0)
        self.assertNotIn(self.team_space.id, non_member_ids)
        self.assertIsNone(SpaceService(user=self.non_member).get_space(self.team_space.id))
        self.assertEqual(self._asset_total(self.non_member), 0)

    def test_removed_organization_member_loses_room_and_asset_access(self) -> None:
        SpaceAccessService(user=self.owner).add_space_membership(
            space_id=self.team_space.id,
            user_id=str(self.removed.id),
            role="editor",
        )
        self.assertEqual(self._asset_total(self.removed), 1)

        OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.removed,
        ).delete()

        visible_ids, total = self._visible_team_space_ids(self.removed)
        self.assertEqual(total, 0)
        self.assertNotIn(self.team_space.id, visible_ids)
        self.assertIsNone(SpaceService(user=self.removed).get_space(self.team_space.id))
        self.assertEqual(self._asset_total(self.removed), 0)
        self.assertEqual(self._organization_asset_total(self.removed), 0)
        self.assertNotIn(
            self.team_space.id,
            AccessibleSpaceResolver(self.removed.id, self.organization.id).resolve(),
        )

    def test_organization_membership_alone_never_grants_team_space_access(self) -> None:
        viewer = create_test_user(prefix="teamspace-viewer")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=viewer,
            role="viewer",
        )

        self.assertFalse(user_can_access_space(viewer, self.team_space, "viewer"))
        self.assertFalse(user_can_access_space(viewer, self.team_space, "editor"))

        SpaceAccessService(user=self.owner).add_space_membership(
            space_id=self.team_space.id,
            user_id=str(viewer.id),
            role="viewer",
        )

        self.assertTrue(user_can_access_space(viewer, self.team_space, "viewer"))
        self.assertFalse(user_can_access_space(viewer, self.team_space, "editor"))

    def test_agent_membership_does_not_grant_its_owner_user_access(self) -> None:
        # /#6342：Project 成员仅 ProjectMembership(user)，不再支持
        # SpaceMembership(agent=) 挂在团队宿主上；Agent 身份不能借此获得 Project 访问。
        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.invited,
            name="Invited Agent",
            type="bot",
            is_active=True,
        )
        self.assertFalse(
            ProjectMembership.objects.filter(
                project=self.team_space,
                user=self.invited,
                is_active=True,
            ).exists()
        )
        # 个人 Workspace 上的 Agent 成员关系也不应抬升 Project 可见性
        SpaceMembership.objects.create(
            workspace=self.execution_space,
            agent=agent,
            role="editor",
            is_active=True,
        )

        visible_ids, total = self._visible_team_space_ids(self.invited)
        self.assertEqual(total, 0)
        self.assertNotIn(self.team_space.id, visible_ids)
        self.assertFalse(user_can_access_space(self.invited, self.team_space, "viewer"))
        self.assertNotIn(
            self.team_space.id,
            AccessibleSpaceResolver(self.invited.id, self.organization.id).resolve(),
        )

    def test_only_team_space_owner_can_manage_team_space_members(self) -> None:
        viewer_membership = SpaceAccessService(user=self.owner).add_space_membership(
            space_id=self.team_space.id,
            user_id=str(self.invited.id),
            role="viewer",
        )

        with self.assertRaises(ServiceError) as add_ctx:
            SpaceAccessService(user=self.invited).add_space_membership(
                space_id=self.team_space.id,
                user_id=str(self.non_member.id),
                role="viewer",
            )
        self.assertEqual(add_ctx.exception.code, "PERMISSION_DENIED")

        with self.assertRaises(ServiceError) as remove_ctx:
            SpaceAccessService(user=self.invited).remove_space_membership(
                space_id=self.team_space.id,
                membership_id=viewer_membership.id,
            )
        self.assertEqual(remove_ctx.exception.code, "PERMISSION_DENIED")

    def test_owner_only_migration_deactivates_non_owner_without_deleting_content(self) -> None:
        legacy_space = Space.objects.create(
            organization=self.organization,
            name="Legacy Shared Room",
            status="active",
            type=Space.SpaceType.TEAM_SPACE,
            execution_space=self.execution_space,
            visibility=SpaceVisibility.SHARED,
        )
        owner_membership = ProjectMembership.objects.create(
            project=legacy_space,
            user=self.owner,
            role="owner",
            is_active=True,
        )
        invited_membership = ProjectMembership.objects.create(
            project=legacy_space,
            user=self.invited,
            role="viewer",
            is_active=True,
        )
        historical_item = ContextItem.objects.create(
            project=legacy_space,
            item_type="external_link",
            title="Historical Asset",
            resource_id="",
            created_by=self.invited,
        )

        self._run_owner_only_migration()

        legacy_space.refresh_from_db()
        owner_membership.refresh_from_db()
        invited_membership.refresh_from_db()
        self.assertEqual(legacy_space.visibility, SpaceVisibility.PRIVATE)
        self.assertTrue(owner_membership.is_active)
        self.assertFalse(invited_membership.is_active)
        self.assertTrue(ContextItem.objects.filter(id=historical_item.id).exists())

    def test_owner_only_migration_repairs_stale_owner_membership(self) -> None:
        stale_owner = create_test_user(prefix="teamspace-stale-owner")
        self.assertFalse(
            OrganizationMember.objects.filter(
                organization=self.organization,
                user=stale_owner,
            ).exists()
        )
        legacy_space = Space.objects.create(
            organization=self.organization,
            name="Legacy Stale Owner Room",
            status="active",
            type=Space.SpaceType.TEAM_SPACE,
            execution_space=self.execution_space,
            visibility=SpaceVisibility.SHARED,
        )
        stale_membership = ProjectMembership.objects.create(
            project=legacy_space,
            user=stale_owner,
            role="owner",
            is_active=True,
        )
        invited_membership = ProjectMembership.objects.create(
            project=legacy_space,
            user=self.invited,
            role="editor",
            is_active=True,
        )
        historical_item = ContextItem.objects.create(
            project=legacy_space,
            item_type="external_link",
            title="Stale Owner Asset",
            resource_id="",
            created_by=self.invited,
        )

        self._run_owner_only_migration()

        legacy_space.refresh_from_db()
        stale_membership.refresh_from_db()
        invited_membership.refresh_from_db()
        self.assertEqual(legacy_space.visibility, SpaceVisibility.PRIVATE)
        self.assertFalse(stale_membership.is_active)
        self.assertFalse(invited_membership.is_active)
        self.assertTrue(
            ProjectMembership.objects.filter(
                project=legacy_space,
                user=self.owner,
                role="owner",
                is_active=True,
            ).exists()
        )
        self.assertEqual(
            ProjectMembership.objects.filter(
                project=legacy_space,
                is_active=True,
            ).count(),
            1,
        )
        self.assertTrue(ContextItem.objects.filter(id=historical_item.id).exists())

    def test_owner_only_migration_reactivates_current_owner_membership(self) -> None:
        legacy_space = Space.objects.create(
            organization=self.organization,
            name="Legacy Inactive Owner Room",
            status="active",
            type=Space.SpaceType.TEAM_SPACE,
            execution_space=self.execution_space,
            visibility=SpaceVisibility.SHARED,
        )
        owner_membership = ProjectMembership.objects.create(
            project=legacy_space,
            user=self.owner,
            role="viewer",
            is_active=False,
        )
        invited_membership = ProjectMembership.objects.create(
            project=legacy_space,
            user=self.invited,
            role="editor",
            is_active=True,
        )

        self._run_owner_only_migration()

        legacy_space.refresh_from_db()
        owner_membership.refresh_from_db()
        invited_membership.refresh_from_db()
        self.assertEqual(legacy_space.visibility, SpaceVisibility.PRIVATE)
        self.assertEqual(owner_membership.role, "owner")
        self.assertTrue(owner_membership.is_active)
        self.assertFalse(invited_membership.is_active)

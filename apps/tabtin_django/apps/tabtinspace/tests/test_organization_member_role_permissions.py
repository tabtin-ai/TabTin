from unittest.mock import patch

from django.test import TestCase

from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.users.auth.models import User


class OrganizationMemberRolePermissionTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = User.objects.create_user(username="member_role_owner")
        self.admin = User.objects.create_user(username="member_role_admin")
        self.editor = User.objects.create_user(username="member_role_editor")
        self.viewer = User.objects.create_user(username="member_role_viewer")
        self.peer_admin = User.objects.create_user(username="member_role_peer_admin")
        self.organization = Organization.objects.create(
            name="Member Role Permission Org",
            owner=self.owner,
            type=Organization.OrganizationType.TEAM,
        )
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user=self.owner,
            defaults={"role": "owner"},
        )
        for user, role in (
            (self.admin, "admin"),
            (self.editor, "editor"),
            (self.viewer, "viewer"),
            (self.peer_admin, "admin"),
        ):
            OrganizationMember.objects.create(
                organization=self.organization,
                user=user,
                role=role,
            )

    def test_admin_can_update_lower_role(self):
        OrganizationService(user=self.admin).update_member_role(
            self.organization.id,
            str(self.viewer.id),
            "editor",
        )

        membership = OrganizationMember.objects.get(
            organization=self.organization,
            user=self.viewer,
        )
        self.assertEqual(membership.role, "editor")

    @patch.object(OrganizationService, "_sync_collab_revoke")
    @patch.object(OrganizationService, "_sync_im_dm_revoke")
    def test_admin_can_remove_lower_role(self, _mock_im_revoke, _mock_collab_revoke):
        OrganizationService(user=self.admin).remove_member(
            self.organization.id,
            str(self.editor.id),
        )

        self.assertFalse(OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.editor,
        ).exists())

    def test_admin_cannot_manage_peer_admin(self):
        with self.assertRaises(ServiceError) as raised:
            OrganizationService(user=self.admin).update_member_role(
                self.organization.id,
                str(self.peer_admin.id),
                "editor",
            )

        self.assertEqual(raised.exception.code, "PERMISSION_DENIED")

    def test_member_cannot_manage_self(self):
        with self.assertRaises(ServiceError) as raised:
            OrganizationService(user=self.admin).remove_member(
                self.organization.id,
                str(self.admin.id),
            )

        self.assertEqual(raised.exception.code, "PERMISSION_DENIED")

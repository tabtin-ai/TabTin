from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.tabtinspace.models import (
    Organization,
    OrganizationMember,
    OrganizationMemberIdentitySnapshot,
)
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabtinspace.signals import create_default_organization


class OrganizationMemberIdentitySnapshotTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=get_user_model())

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=get_user_model())
        super().tearDownClass()

    def setUp(self):
        self.factory = RequestFactory()
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            email="identity-snapshot-owner@example.com",
            password="test-password",
            nickname="Owner",
        )
        self.member = user_model.objects.create_user(
            email="identity-snapshot-member@example.com",
            password="test-password",
            nickname="离开时姓名",
        )
        self.organization = Organization.objects.create(
            name="Identity Snapshot Team",
            owner=self.owner,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )

    @patch.object(OrganizationService, "_sync_collab_revoke")
    @patch.object(OrganizationService, "_sync_im_dm_revoke")
    def test_remove_member_preserves_departure_name_without_keeping_membership(
        self,
        _mock_im_revoke,
        _mock_collab_revoke,
    ):
        OrganizationService(user=self.owner).remove_member(
            organization_id=self.organization.id,
            user_id=str(self.member.id),
        )

        self.assertFalse(
            OrganizationMember.objects.filter(
                organization=self.organization,
                user=self.member,
            ).exists()
        )
        snapshot = OrganizationMemberIdentitySnapshot.objects.get(
            organization=self.organization,
            user_id=self.member.id,
        )
        self.assertEqual(snapshot.display_name, "离开时姓名")

        self.member.nickname = "离开后改名"
        self.member.save(update_fields=["nickname"])
        snapshot.refresh_from_db()
        self.assertEqual(snapshot.display_name, "离开时姓名")

    @patch.object(OrganizationService, "_sync_collab_revoke")
    @patch.object(OrganizationService, "_sync_im_dm_revoke")
    def test_snapshot_api_returns_departed_identity_without_restoring_member(
        self,
        _mock_im_revoke,
        _mock_collab_revoke,
    ):
        from apps.tabtinspace.routers.membership import list_member_identity_snapshots

        OrganizationService(user=self.owner).remove_member(
            organization_id=self.organization.id,
            user_id=str(self.member.id),
        )
        request = self.factory.get(
            f"/api/context/organizations/{self.organization.id}/members/identity-snapshots"
        )
        request.auth = self.owner

        response = list_member_identity_snapshots(request, self.organization.id)

        self.assertTrue(response["success"])
        self.assertEqual(
            response["data"]["identities"],
            [
                {
                    "user_id": str(self.member.id),
                    "display_name": "离开时姓名",
                    "left_at": OrganizationMemberIdentitySnapshot.objects.get(
                        organization=self.organization,
                        user_id=self.member.id,
                    ).left_at.isoformat(),
                }
            ],
        )
        self.assertFalse(
            OrganizationMember.objects.filter(
                organization=self.organization,
                user=self.member,
            ).exists()
        )

    @patch.object(OrganizationService, "_sync_im_dm_revoke")
    def test_member_leaving_voluntarily_preserves_departure_name(self, _mock_im_revoke):
        OrganizationService(user=self.member).leave_organization(self.organization.id)

        snapshot = OrganizationMemberIdentitySnapshot.objects.get(
            organization=self.organization,
            user_id=self.member.id,
        )
        self.assertEqual(snapshot.display_name, "离开时姓名")
        self.assertFalse(
            OrganizationMember.objects.filter(
                organization=self.organization,
                user=self.member,
            ).exists()
        )

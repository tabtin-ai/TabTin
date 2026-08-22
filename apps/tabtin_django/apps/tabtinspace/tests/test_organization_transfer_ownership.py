from uuid import uuid4
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabtinspace.signals import create_default_organization


class OrganizationTransferOwnershipTests(TestCase):
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
        self.owner = self._create_user("owner")
        self.member = self._create_user("member")
        self.outsider = self._create_user("outsider")
        self.organization = Organization.objects.create(
            name="Transfer Team",
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

    @staticmethod
    def _create_user(name: str):
        return get_user_model().objects.create_user(
            phone=f"+86138{uuid4().int % 100000000:08d}",
            password="test-password",
            nickname=name,
        )

    def test_owner_can_transfer_to_an_existing_member(self):
        OrganizationService(user=self.owner).transfer_ownership(
            self.organization.id,
            str(self.member.id),
        )

        self.organization.refresh_from_db()
        owner_membership = OrganizationMember.objects.get(
            organization=self.organization,
            user=self.owner,
        )
        new_owner_membership = OrganizationMember.objects.get(
            organization=self.organization,
            user=self.member,
        )

        self.assertEqual(str(self.organization.owner_id), str(self.member.id))
        self.assertEqual(owner_membership.role, "editor")
        self.assertEqual(new_owner_membership.role, "owner")

    def test_transfer_rejects_a_user_who_is_not_an_organization_member(self):
        with self.assertRaises(ServiceError) as raised:
            OrganizationService(user=self.owner).transfer_ownership(
                self.organization.id,
                str(self.outsider.id),
            )

        self.assertEqual(raised.exception.code, "MEMBER_NOT_FOUND")

    @patch(
        "apps.platform_config.services.PlatformRuntimeConfigService.get_max_organizations_per_user",
        return_value=1,
    )
    def test_transfer_rejects_member_who_already_reached_owned_organization_limit(
        self,
        _mock_limit,
    ):
        Organization.objects.create(
            name="Member Owned Team",
            owner=self.member,
            type="team",
        )

        with self.assertRaises(ServiceError) as raised:
            OrganizationService(user=self.owner).transfer_ownership(
                self.organization.id,
                str(self.member.id),
            )

        self.assertEqual(raised.exception.code, "ORGANIZATION_LIMIT_EXCEEDED")
        self.organization.refresh_from_db()
        owner_membership = OrganizationMember.objects.get(
            organization=self.organization,
            user=self.owner,
        )
        target_membership = OrganizationMember.objects.get(
            organization=self.organization,
            user=self.member,
        )
        self.assertEqual(str(self.organization.owner_id), str(self.owner.id))
        self.assertEqual(owner_membership.role, "owner")
        self.assertEqual(target_membership.role, "editor")

    def test_staff_transfer_bypasses_owner_identity_check(self):
        """后台代操作：操作者不必是当前 Owner。"""
        OrganizationService(user=self.outsider).transfer_ownership(
            self.organization.id,
            str(self.member.id),
            as_staff=True,
        )

        self.organization.refresh_from_db()
        self.assertEqual(str(self.organization.owner_id), str(self.member.id))

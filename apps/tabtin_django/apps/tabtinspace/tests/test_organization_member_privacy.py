from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.services.common.utils import mask_phone_number
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.routers.membership import list_organization_members
from apps.tabtinspace.signals import create_default_organization


class OrganizationMemberPrivacyTests(TestCase):
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
        self.owner = self._create_user("owner", "+8613800000001")
        self.editor = self._create_user("editor", "+8613800000002")
        self.organization = Organization.objects.create(
            name="Privacy Team",
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
            user=self.editor,
            role="editor",
        )
        self.factory = RequestFactory()

    @staticmethod
    def _create_user(name: str, phone: str):
        return get_user_model().objects.create_user(
            phone=phone,
            password="test-password",
            nickname=name,
        )

    def _list_as(self, user, *, search: str = "") -> dict:
        request = self.factory.get(
            f"/api/context/organizations/{self.organization.id}/members",
            {"search": search} if search else None,
        )
        request.auth = user
        return list_organization_members(
            request,
            self.organization.id,
            search=search,
        )

    def test_editor_only_receives_full_phone_for_self(self):
        response = self._list_as(self.editor)
        members_by_user_id = {
            item["user_id"]: item
            for item in response["data"]["members"]
        }

        self.assertEqual(
            members_by_user_id[str(self.editor.id)]["user"]["phone"],
            self.editor.phone,
        )
        self.assertEqual(
            members_by_user_id[str(self.owner.id)]["user"]["phone"],
            mask_phone_number(self.owner.phone),
        )

    def test_owner_can_receive_member_phone_for_member_management(self):
        response = self._list_as(self.owner)
        members_by_user_id = {
            item["user_id"]: item
            for item in response["data"]["members"]
        }

        self.assertEqual(
            members_by_user_id[str(self.editor.id)]["user"]["phone"],
            self.editor.phone,
        )

    def test_editor_cannot_discover_member_by_private_phone_search(self):
        response = self._list_as(self.editor, search=self.owner.phone)

        self.assertEqual(response["data"]["total"], 0)

    def test_owner_can_search_members_by_phone(self):
        response = self._list_as(self.owner, search=self.editor.phone)

        self.assertEqual(response["data"]["total"], 1)
        self.assertEqual(
            response["data"]["members"][0]["user_id"],
            str(self.editor.id),
        )

"""AdminDash 组织资料 Tab：status 序列化 / 代转让 Owner / 更新需 reason。"""

import json
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase

from apps.tabtinspace.admin_api import (
    AdminOrganizationTransferOwnershipRequest,
    AdminOrganizationUpdateRequest,
    _serialize_organization_item,
    admin_transfer_organization_ownership,
    admin_update_organization,
)
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.signals import create_default_organization


class AdminOrganizationGeneralTests(TestCase):
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
        self.staff = self._create_user("staff", is_superuser=True, is_staff=True)
        self.owner = self._create_user("owner")
        self.member = self._create_user("member")
        self.organization = Organization.objects.create(
            name="General Team",
            owner=self.owner,
            type="team",
            status=Organization.Status.ACTIVE,
            settings={"allow_member_yolo": False, "keep_me": True},
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
    def _create_user(name: str, *, is_superuser=False, is_staff=False):
        return get_user_model().objects.create_user(
            phone=f"+86138{uuid4().int % 100000000:08d}",
            password="test-password",
            nickname=name,
            is_superuser=is_superuser,
            is_staff=is_staff,
        )

    def _auth_request(self, method="POST", path="/"):
        request = getattr(self.factory, method.lower())(path)
        request.auth = self.staff
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "test-agent"
        return request

    def test_serialize_includes_lifecycle_status(self):
        payload = _serialize_organization_item(
            self.organization,
            owner_name_map={str(self.owner.id): "owner"},
            active_space_count_map={},
            active_table_count_map={},
        )
        self.assertEqual(payload["status"], Organization.Status.ACTIVE)
        self.assertEqual(payload["type"], "team")

    def test_update_requires_reason(self):
        response = admin_update_organization(
            self._auth_request(),
            self.organization.id,
            AdminOrganizationUpdateRequest(name="Renamed", reason=""),
        )
        self.assertIsInstance(response, JsonResponse)
        self.assertEqual(response.status_code, 400)
        body = json.loads(response.content)
        self.assertIn("原因", body.get("message", ""))

    def test_update_merges_settings_and_records_reason(self):
        response = admin_update_organization(
            self._auth_request(),
            self.organization.id,
            AdminOrganizationUpdateRequest(
                name="Renamed Org",
                settings={"allow_member_yolo": True},
                reason="客户要求开放宽松审批",
                ticket_id="T-5702",
            ),
        )
        self.assertEqual(response["success"], True)
        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, "Renamed Org")
        self.assertTrue(self.organization.settings.get("allow_member_yolo"))
        self.assertTrue(self.organization.settings.get("keep_me"))
        self.assertEqual(response["data"]["status"], Organization.Status.ACTIVE)

    def test_staff_can_transfer_ownership(self):
        response = admin_transfer_organization_ownership(
            self._auth_request(),
            self.organization.id,
            AdminOrganizationTransferOwnershipRequest(
                new_owner_user_id=str(self.member.id),
                reason="Owner 离职代转让",
                ticket_id="T-5702-transfer",
            ),
        )
        self.assertEqual(response["success"], True)
        self.organization.refresh_from_db()
        self.assertEqual(str(self.organization.owner_id), str(self.member.id))
        self.assertEqual(response["data"]["owner_id"], str(self.member.id))
        old_role = OrganizationMember.objects.get(
            organization=self.organization, user=self.owner
        ).role
        new_role = OrganizationMember.objects.get(
            organization=self.organization, user=self.member
        ).role
        self.assertEqual(old_role, "editor")
        self.assertEqual(new_role, "owner")

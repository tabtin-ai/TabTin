"""组织 settings.logo_url：owner 可写，非 owner 拒绝；整包替换时保留其他键。"""

from uuid import uuid4
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabtinspace.signals import create_default_organization


class OrganizationLogoSettingsTests(TestCase):
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
        self.editor = self._create_user("editor")
        self.admin = self._create_user("admin")
        self.organization = Organization.objects.create(
            name="Logo Team",
            owner=self.owner,
            type="team",
            settings={"allow_member_yolo": False, "keep_me": True},
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
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.admin,
            role="admin",
        )

    @staticmethod
    def _create_user(name: str):
        return get_user_model().objects.create_user(
            phone=f"+86138{uuid4().int % 100000000:08d}",
            password="test-password",
            nickname=name,
        )

    @patch.object(
        OrganizationService,
        "_normalize_public_logo_settings",
        side_effect=lambda settings: settings,
    )
    def test_owner_can_set_logo_url_and_preserve_other_settings(self, _normalize):
        logo = "https://cdn.example.com/org-logos/demo.png"
        OrganizationService(user=self.owner).update_organization(
            self.organization.id,
            settings={
                **self.organization.settings,
                "logo_url": logo,
            },
        )

        self.organization.refresh_from_db()
        self.assertEqual(self.organization.settings.get("logo_url"), logo)
        self.assertFalse(self.organization.settings.get("allow_member_yolo"))
        self.assertTrue(self.organization.settings.get("keep_me"))

    def test_editor_cannot_update_logo_settings(self):
        with self.assertRaises(ServiceError) as raised:
            OrganizationService(user=self.editor).update_organization(
                self.organization.id,
                settings={
                    **self.organization.settings,
                    "logo_url": "https://cdn.example.com/blocked.png",
                },
            )

        self.assertEqual(raised.exception.code, "PERMISSION_DENIED")
        self.organization.refresh_from_db()
        self.assertNotIn("logo_url", self.organization.settings or {})

    def test_admin_cannot_update_logo_settings_under_owner_only_model(self):
        """两级模型：存量 admin 也不具备组织设置写权限。"""
        with self.assertRaises(ServiceError) as raised:
            OrganizationService(user=self.admin).update_organization(
                self.organization.id,
                settings={
                    **self.organization.settings,
                    "logo_url": "https://cdn.example.com/blocked-admin.png",
                },
            )

        self.assertEqual(raised.exception.code, "PERMISSION_DENIED")

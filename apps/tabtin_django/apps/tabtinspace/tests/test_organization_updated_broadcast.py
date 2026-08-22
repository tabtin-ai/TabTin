"""：组织资料更新后 fan-out ``organization.updated`` WS 事件。"""

from __future__ import annotations

from uuid import uuid4
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabtinspace.signals import create_default_organization


class OrganizationUpdatedBroadcastTests(TestCase):
    databases = {"default", "postgresql"}

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
        self.organization = Organization.objects.create(
            name="Broadcast Team",
            description="before",
            icon="📁",
            owner=self.owner,
            type="team",
            settings={"allow_member_yolo": False},
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

    @staticmethod
    def _create_user(name: str):
        return get_user_model().objects.create_user(
            phone=f"+86138{uuid4().int % 100000000:08d}",
            password="test-password",
            nickname=name,
        )

    @patch("apps.services.common.ws.bus.publish_to_user")
    @patch.object(
        OrganizationService,
        "_normalize_public_logo_settings",
        side_effect=lambda settings: settings,
    )
    def test_update_organization_fan_outs_organization_updated(
        self,
        _normalize,
        mock_publish,
    ):
        mock_publish.return_value = True

        with self.captureOnCommitCallbacks(execute=True, using=postgres_app_db_alias()):
            OrganizationService(user=self.owner).update_organization(
                self.organization.id,
                name="Broadcast Team Renamed",
                description="after",
                icon="🏢",
                settings={"allow_member_yolo": True},
            )

        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, "Broadcast Team Renamed")
        self.assertEqual(mock_publish.call_count, 2)

        pushed_user_ids = sorted(call.args[0] for call in mock_publish.call_args_list)
        self.assertEqual(pushed_user_ids, sorted([str(self.owner.id), str(self.editor.id)]))

        envelope = mock_publish.call_args_list[0].args[1]
        self.assertEqual(envelope["type"], "organization.updated")
        self.assertEqual(envelope["payload"]["organization_id"], str(self.organization.id))
        self.assertEqual(envelope["payload"]["name"], "Broadcast Team Renamed")
        self.assertEqual(envelope["payload"]["description"], "after")
        self.assertEqual(envelope["payload"]["icon"], "🏢")
        self.assertEqual(
            envelope["payload"]["settings"],
            {"allow_member_yolo": True},
        )
        self.assertTrue(envelope["payload"]["updated_at"])

    @patch("apps.services.common.ws.bus.publish_to_user")
    def test_update_organization_without_changes_skips_broadcast(self, mock_publish):
        OrganizationService(user=self.owner).update_organization(self.organization.id)
        mock_publish.assert_not_called()

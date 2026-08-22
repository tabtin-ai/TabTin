"""Workspace.approval_memo 真实 PostgreSQL 服务回归。"""

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Device, Organization, OrganizationMember, Workspace
from apps.tabtinspace.services.approval_memo_service import ApprovalMemoService
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.signals import create_default_organization


User = get_user_model()


class ApprovalMemoServiceTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        suffix = uuid4().hex[:8]
        self.owner = User.objects.create_user(
            username=f"memo-owner-{suffix}",
            email=f"memo-owner-{suffix}@tabtin.test",
        )
        self.other = User.objects.create_user(
            username=f"memo-other-{suffix}",
            email=f"memo-other-{suffix}@tabtin.test",
        )
        self.organization = Organization.objects.create(
            name=f"Memo {suffix}",
            owner=self.owner,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Memo Device",
            device_type="electron",
            role="control",
            fingerprint=f"memo-{suffix}",
            status="online",
        )
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            created_by=self.owner,
            name="Memo Workspace",
            working_dir="/Users/memo/project",
            normalized_working_dir="/Users/memo/project",
        )

    def test_owner_can_read_write_delete_and_revoke(self):
        service = ApprovalMemoService(user=self.owner)

        empty = service.get_memo(self.workspace.id)
        self.assertEqual(empty.entries, {})
        self.assertEqual(empty.generation, 0)

        written = service.upsert_entry(
            self.workspace.id,
            "shell::run::*",
            "allow",
            "owner approved",
            last_seen_generation=0,
        )
        self.assertEqual(written.generation, 1)
        self.assertEqual(written.entries["shell::run::*"]["decision"], "allow")

        deleted = service.delete_entry(
            self.workspace.id,
            "shell::run::*",
            last_seen_generation=1,
        )
        self.assertEqual(deleted.entries, {})
        self.assertEqual(deleted.generation, 2)

        revoked = service.revoke_all(self.workspace.id)
        self.assertEqual(revoked.entries, {})
        self.assertEqual(revoked.generation, 3)

    def test_generation_conflict_is_rejected(self):
        service = ApprovalMemoService(user=self.owner)
        service.upsert_entry(
            self.workspace.id,
            "shell::run::*",
            "allow",
            "",
            last_seen_generation=0,
        )

        with self.assertRaises(ServiceError) as raised:
            service.upsert_entry(
                self.workspace.id,
                "file::write::*",
                "allow",
                "",
                last_seen_generation=0,
            )

        self.assertEqual(raised.exception.code, "GENERATION_CONFLICT")
        self.assertEqual(raised.exception.status, 409)

    def test_non_owner_cannot_read_or_write(self):
        service = ApprovalMemoService(user=self.other)

        for operation in (
            lambda: service.get_memo(self.workspace.id),
            lambda: service.upsert_entry(
                self.workspace.id,
                "shell::run::*",
                "allow",
                "",
                last_seen_generation=0,
            ),
            lambda: service.revoke_all(self.workspace.id),
        ):
            with self.assertRaises(ServiceError) as raised:
                operation()
            self.assertEqual(raised.exception.code, "PERMISSION_DENIED")
            self.assertEqual(raised.exception.status, 403)

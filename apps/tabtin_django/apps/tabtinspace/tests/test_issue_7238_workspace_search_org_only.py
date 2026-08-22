"""#7238：Workspace 搜索应召回同组织可见的 org-only 云文件。"""
from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.services.oss.models import FileRecord
from apps.tabtinspace.models import (
    ContextItem,
    Device,
    FilePermission,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)
from apps.tabtinspace.schemas.context_item import OrganizationSearchItemOut
from apps.tabtinspace.services.context_item_service import ContextItemService
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class Issue7238WorkspaceSearchOrgOnlyTests(TestCase):
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
            username=f"i7238-owner-{suffix}",
            email=f"i7238-owner-{suffix}@example.com",
            password="x",
        )
        self.member = User.objects.create_user(
            username=f"i7238-member-{suffix}",
            email=f"i7238-member-{suffix}@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name=f"I7238 Org {suffix}",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name=f"i7238-device-{suffix}",
            device_type="electron",
            role="control",
            fingerprint=f"i7238-{suffix}",
            status="online",
        )
        working_dir = f"/tmp/i7238-{suffix}"
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            created_by=self.owner,
            name=f"I7238 Workspace {suffix}",
            working_dir=working_dir,
            normalized_working_dir=working_dir,
        )
        SpaceMembership.objects.create(
            workspace=self.workspace,
            user=self.owner,
            role="owner",
            is_active=True,
        )
        SpaceMembership.objects.create(
            workspace=self.workspace,
            user=self.member,
            role="editor",
            is_active=True,
        )

        self.file_record = FileRecord.objects.create(
            file_name="mx-sc-042-report.pdf",
            file_key=f"test/7238/{self.owner.id}/mx-sc-042-report.pdf",
            file_path=f"test/7238/{self.owner.id}/mx-sc-042-report.pdf",
            file_size=42,
            file_type="document",
            mime_type="application/pdf",
            file_extension="pdf",
            file_hash="a" * 32,
            bucket_name="test",
            upload_user=str(self.owner.id),
            organization_id=str(self.organization.id),
            status="completed",
        )
        self.org_only_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabfiles",
            title="mx-sc-042-report.pdf",
            preview="document · 42B",
            status="active",
            resource_id=str(self.file_record.id),
            created_by=self.owner,
            updated_by=self.owner,
        )
        self.assertIsNone(self.org_only_item.space_id)

    def test_workspace_search_finds_own_org_only_file(self):
        service = ContextItemService(user=self.owner)
        items, total = service.search_items(
            space_id=self.workspace.id,
            query="mx-sc-042",
        )
        self.assertEqual(total, 1)
        self.assertEqual(items[0].id, self.org_only_item.id)
        self.assertIsNone(items[0].space_id)
        self.assertEqual(items[0].organization_id, self.organization.id)

    def test_workspace_search_hides_unshared_org_only_from_other_member(self):
        """#6863 口径：组织成员看不到他人未分享的私有云文件。"""
        service = ContextItemService(user=self.member)
        items, total = service.search_items(
            space_id=self.workspace.id,
            query="mx-sc-042",
        )
        self.assertEqual(total, 0)
        self.assertEqual(items, [])

    def test_workspace_search_finds_shared_org_only_file(self):
        FilePermission.objects.create(
            file_record_id=self.file_record.id,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        service = ContextItemService(user=self.member)
        items, total = service.search_items(
            space_id=self.workspace.id,
            query="mx-sc-042",
        )
        self.assertEqual(total, 1)
        self.assertEqual(items[0].id, self.org_only_item.id)

    def test_organization_search_serializes_null_space_id(self):
        service = ContextItemService(user=self.owner)
        items, total = service.organization_search(
            organization_id=self.organization.id,
            query="mx-sc-042",
        )
        self.assertEqual(total, 1)
        item = items[0]
        out = OrganizationSearchItemOut(
            id=item.id,
            item_type=item.item_type,
            title=item.title or "",
            preview=(item.preview[:200] if item.preview else ""),
            resource_id=item.resource_id,
            space_id=item.workspace_id or item.project_id,
            space_name="",
            organization_id=item.organization_id,
            metadata=item.metadata,
            is_archived=item.is_archived,
            updated_at=item.updated_at,
            created_at=item.created_at,
            rank=0,
        )
        self.assertIsNone(out.space_id)
        self.assertEqual(out.organization_id, self.organization.id)
        payload = out.dict()
        self.assertIsNone(payload["space_id"])
        self.assertEqual(str(payload["organization_id"]), str(self.organization.id))

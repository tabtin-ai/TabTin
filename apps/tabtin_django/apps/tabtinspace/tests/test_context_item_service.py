from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.tabslide.models import SlideProject
from apps.tabtinspace.models import (
    ContextItem,
    Device,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)
from apps.tabtinspace.services.context_item_service import ContextItemService

User = get_user_model()


class ContextItemServiceOrphanCleanupTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        suffix = uuid4().hex[:8]
        self.user = User.objects.db_manager("default").create_user(
            username=f"ci_orphan_{suffix}",
            email=f"ci-orphan-{suffix}@test.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Context Item Test Org",
            owner_id=self.user.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name=f"ci-orphan-device-{suffix}",
            device_type="electron",
            role="control",
            fingerprint=f"ci-orphan-{suffix}",
            status="online",
        )
        wd = f"/tmp/ci-orphan-{suffix}"
        self.space = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            created_by=self.user,
            name="Context Item Test Workspace",
            working_dir=wd,
            normalized_working_dir=wd,
        )
        SpaceMembership.objects.get_or_create(
            workspace=self.space,
            user=self.user,
            defaults={"role": "owner", "is_active": True},
        )

        self.valid_project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="demo-valid",
            preset="ppt",
            page_count=3,
            status="active",
        )
        self.valid_item = ContextItem.objects.create(
            workspace=self.space,
            item_type="tabslide",
            title="demo-valid",
            status="active",
            resource_id=str(self.valid_project.id),
            is_archived=False,
            created_by=self.user,
            updated_by=self.user,
        )
        self.orphan_item = ContextItem.objects.create(
            workspace=self.space,
            item_type="tabslide",
            title="demo-orphan",
            status="active",
            resource_id=str(uuid4()),
            is_archived=False,
            created_by=self.user,
            updated_by=self.user,
        )
        self.service = ContextItemService(user=self.user)

    def test_list_items_archives_and_excludes_orphan_tabslide_items(self):
        items, total = self.service.list_items(
            space_id=self.space.id,
            is_archived=False,
        )

        self.assertEqual(total, 1)
        self.assertEqual([item.id for item in items], [self.valid_item.id])

        self.orphan_item.refresh_from_db()
        self.assertTrue(self.orphan_item.is_archived)

    def test_organization_search_archives_and_excludes_orphan_tabslide_items(self):
        items, total = self.service.organization_search(
            organization_id=self.organization.id,
            query="demo",
        )

        self.assertEqual(total, 1)
        self.assertEqual([item.id for item in items], [self.valid_item.id])

        self.orphan_item.refresh_from_db()
        self.assertTrue(self.orphan_item.is_archived)

    def test_search_items_archives_and_excludes_orphan_tabslide_items(self):
        items, total = self.service.search_items(
            space_id=self.space.id,
            query="demo",
        )

        self.assertEqual(total, 1)
        self.assertEqual([item.id for item in items], [self.valid_item.id])

        self.orphan_item.refresh_from_db()
        self.assertTrue(self.orphan_item.is_archived)

    def test_get_item_returns_none_and_archives_orphan_tabslide_item(self):
        item = self.service.get_item(self.orphan_item.id)

        self.assertIsNone(item)

        self.orphan_item.refresh_from_db()
        self.assertTrue(self.orphan_item.is_archived)

    def test_list_items_archives_context_item_when_source_already_trashed(self):
        """#7546：源行仍在但已 trashed 时，读路径应归档幽灵 ContextItem。"""
        trashed_project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="demo-trashed-source",
            preset="ppt",
            page_count=1,
            status="trashed",
            trashed_at=timezone.now(),
        )
        ghost_item = ContextItem.objects.create(
            workspace=self.space,
            item_type="tabslide",
            title="demo-trashed-source",
            status="active",
            resource_id=str(trashed_project.id),
            is_archived=False,
            created_by=self.user,
            updated_by=self.user,
        )

        items, total = self.service.list_items(
            space_id=self.space.id,
            is_archived=False,
        )

        self.assertEqual(total, 1)
        self.assertEqual([item.id for item in items], [self.valid_item.id])

        ghost_item.refresh_from_db()
        self.assertTrue(ghost_item.is_archived)

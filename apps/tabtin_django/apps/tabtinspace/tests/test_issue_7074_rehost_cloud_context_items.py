"""#7074：legacy workspace/project 云资产宿主收敛到 organization。"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabdata.models import Table
from apps.tabdoc.models import Document
from apps.tabtinspace.models import (
    ContextItem,
    Organization,
    OrganizationMember,
    SpaceMembership,
)
from apps.tabtinspace.services.cloud_org_host_rehost import rehost_legacy_cloud_context_items
from apps.tabtinspace.services.context_item_service import ContextItemService
from apps.tabtinspace.signals import create_default_organization
from apps.tabtinspace.tests.fixtures import create_test_agent, create_test_bot_space

User = get_user_model()


class Issue7074RehostCloudContextItemsTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.owner = User.objects.create_user(
            username="i7074-owner",
            email="i7074-owner@example.com",
            password="x",
        )
        self.member = User.objects.create_user(
            username="i7074-member",
            email="i7074-member@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="I7074 Org",
            owner_id=self.owner.id,
            is_default=False,
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
        self.agent = create_test_agent(
            organization=self.organization,
            prefix="i7074",
            owner_user=self.owner,
        )
        self.workspace = create_test_bot_space(
            organization=self.organization,
            agent=self.agent,
            name="I7074 Workspace",
            prefix="i7074",
            created_by_id=self.owner.id,
        )
        SpaceMembership.objects.get_or_create(
            workspace=self.workspace,
            user=self.owner,
            defaults={"role": "owner", "is_active": True, "permissions": {}},
        )

    def _create_legacy_doc_item(self, title: str = "Legacy Doc") -> tuple[Document, ContextItem]:
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.workspace.id,
            owner_id=self.owner.id,
            created_by=self.owner,
            updated_by=self.owner,
            title=title,
            description_markdown=title,
            description_plaintext=title,
        )
        item = ContextItem.objects.create(
            workspace=self.workspace,
            item_type="tabdoc",
            title=title,
            resource_id=str(doc.id),
            created_by=self.owner,
            updated_by=self.owner,
        )
        return doc, item

    def _create_legacy_table_item(self, title: str = "Legacy Table") -> tuple[Table, ContextItem]:
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.workspace.id,
            owner_id=self.owner.id,
            name=title,
        )
        item = ContextItem.objects.create(
            workspace=self.workspace,
            item_type="tabdata",
            title=title,
            resource_id=str(table.id),
            created_by=self.owner,
            updated_by=self.owner,
        )
        return table, item

    def test_rehost_moves_workspace_host_to_organization(self):
        _doc, item = self._create_legacy_doc_item()
        self.assertIsNone(item.organization_id)
        self.assertEqual(item.workspace_id, self.workspace.id)

        stats = rehost_legacy_cloud_context_items(
            organization_id=self.organization.id,
            dry_run=False,
        )
        self.assertEqual(stats.rehosted, 1)

        item.refresh_from_db()
        self.assertEqual(str(item.organization_id), str(self.organization.id))
        self.assertIsNone(item.workspace_id)
        self.assertIsNone(item.project_id)

    def test_owner_sees_rehosted_item_in_organization_list(self):
        self._create_legacy_doc_item("Visible After Rehost")
        self._create_legacy_table_item("Table After Rehost")

        before = ContextItemService(user=self.owner).list_items_for_organization(
            self.organization.id,
        )
        self.assertEqual(before[1], 0)

        rehost_legacy_cloud_context_items(
            organization_id=self.organization.id,
            dry_run=False,
        )

        items, total = ContextItemService(user=self.owner).list_items_for_organization(
            self.organization.id,
        )
        self.assertEqual(total, 2)
        self.assertEqual({i.item_type for i in items}, {"tabdoc", "tabdata"})

        member_items, member_total = ContextItemService(
            user=self.member
        ).list_items_for_organization(self.organization.id)
        self.assertEqual(member_total, 0)
        self.assertEqual(member_items, [])

    def test_dry_run_does_not_write(self):
        _doc, item = self._create_legacy_doc_item()
        stats = rehost_legacy_cloud_context_items(
            organization_id=self.organization.id,
            dry_run=True,
        )
        self.assertEqual(stats.rehosted, 1)
        item.refresh_from_db()
        self.assertIsNone(item.organization_id)
        self.assertEqual(item.workspace_id, self.workspace.id)

    def test_dedupe_deletes_legacy_when_org_row_exists(self):
        doc, legacy = self._create_legacy_doc_item("Dup Doc")
        org_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title="Dup Doc Org",
            resource_id=str(doc.id),
            created_by=self.owner,
            updated_by=self.owner,
        )

        stats = rehost_legacy_cloud_context_items(
            organization_id=self.organization.id,
            dry_run=False,
        )
        self.assertEqual(stats.deduped_deleted, 1)
        self.assertFalse(ContextItem.objects.filter(id=legacy.id).exists())
        self.assertTrue(ContextItem.objects.filter(id=org_item.id).exists())

    def test_fills_created_by_from_document_owner(self):
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.workspace.id,
            owner_id=self.owner.id,
            created_by=self.owner,
            updated_by=self.owner,
            title="No CI Owner",
            description_markdown="x",
            description_plaintext="x",
        )
        item = ContextItem.objects.create(
            workspace=self.workspace,
            item_type="tabdoc",
            title="No CI Owner",
            resource_id=str(doc.id),
            created_by=None,
            updated_by=None,
        )

        stats = rehost_legacy_cloud_context_items(
            organization_id=self.organization.id,
            dry_run=False,
        )
        self.assertEqual(stats.rehosted, 1)
        self.assertEqual(stats.created_by_filled, 1)
        item.refresh_from_db()
        self.assertEqual(str(item.created_by_id), str(self.owner.id))
        self.assertEqual(str(item.organization_id), str(self.organization.id))

    def test_rehost_tabfiles_and_audit_when_still_no_owner(self):
        from apps.services.oss.models import FileRecord
        from uuid import uuid4

        file_id = uuid4()
        FileRecord.objects.create(
            id=file_id,
            file_name="orphan.pdf",
            file_key=f"test/7074/{file_id}/orphan.pdf",
            file_path=f"test/7074/{file_id}/orphan.pdf",
            file_size=1,
            file_type="document",
            mime_type="application/pdf",
            file_extension="pdf",
            file_hash="a" * 32,
            bucket_name="test",
            upload_user="",
            organization_id=str(self.organization.id),
            status="completed",
        )
        item = ContextItem.objects.create(
            workspace=self.workspace,
            item_type="tabfiles",
            title="orphan.pdf",
            resource_id=str(file_id),
            created_by=None,
            updated_by=None,
        )

        stats = rehost_legacy_cloud_context_items(
            organization_id=self.organization.id,
            dry_run=False,
        )
        self.assertEqual(stats.rehosted, 1)
        item.refresh_from_db()
        self.assertEqual(str(item.organization_id), str(self.organization.id))
        self.assertIsNone(item.created_by_id)
        reasons = {row["reason"] for row in stats.audit_rows}
        self.assertIn("rehosted_but_still_no_owner", reasons)

    def test_fills_created_by_for_already_org_hosted_table(self):
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            name="Org Table Missing CI Owner",
        )
        item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdata",
            title=table.name,
            resource_id=str(table.id),
            created_by=None,
            updated_by=None,
        )

        stats = rehost_legacy_cloud_context_items(
            organization_id=self.organization.id,
            dry_run=False,
        )
        self.assertEqual(stats.rehosted, 0)
        self.assertEqual(stats.created_by_filled, 1)
        item.refresh_from_db()
        self.assertEqual(str(item.created_by_id), str(self.owner.id))

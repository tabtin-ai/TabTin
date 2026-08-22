"""#7140：backfill_cloud_collection_org_host_7140 —— Collection 树宿主收敛回填。"""
from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabdoc.models import Document
from apps.tabtinspace.models import (
    Collection,
    ContextItem,
    Device,
    Organization,
    OrganizationMember,
    Workspace,
)
from apps.tabtinspace.services.cloud_collection_org_rehost import (
    rehost_cloud_collections_to_organization,
)
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class BackfillCloudCollectionOrgHost7140Tests(TestCase):
    databases = {'default', 'postgresql'}

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
            username='i7140-rehost-owner',
            email='i7140-rehost-owner@test.com',
            password='x',
        )
        self.organization = Organization.objects.create(
            name='I7140 Rehost Org',
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role='owner',
        )
        suffix = uuid4().hex[:8]
        device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name=f'i7140-rehost-device-{suffix}',
            device_type='electron',
            role='control',
            fingerprint=f'i7140-rehost-{suffix}',
            status='online',
        )
        wd = f'/tmp/i7140-rehost-{suffix}'
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.owner,
            name=f'I7140 Rehost WS {suffix}',
            working_dir=wd,
            normalized_working_dir=wd,
        )

    def _make_doc_item(self, *, collection: Collection, title: str) -> ContextItem:
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
        return ContextItem.objects.create(
            workspace=self.workspace,
            collection=collection,
            item_type='tabdoc',
            title=title,
            resource_id=str(doc.id),
            created_by=self.owner,
            updated_by=self.owner,
        )

    def test_rehost_moves_referenced_collection_and_item_to_organization(self):
        folder = Collection.objects.create(
            workspace=self.workspace, parent=None, name='Docs Folder',
        )
        item = self._make_doc_item(collection=folder, title='Referenced Doc')

        stats = rehost_cloud_collections_to_organization(
            organization_id=self.organization.id, dry_run=False,
        )

        self.assertEqual(stats.rehosted, 1)
        self.assertEqual(stats.items_rehosted, 1)
        folder.refresh_from_db()
        item.refresh_from_db()
        self.assertEqual(folder.organization_id, self.organization.id)
        self.assertIsNone(folder.workspace_id)
        self.assertEqual(item.organization_id, self.organization.id)
        self.assertIsNone(item.workspace_id)
        self.assertEqual(item.collection_id, folder.id)

    def test_rehost_moves_ancestor_chain_together(self):
        root = Collection.objects.create(
            workspace=self.workspace, parent=None, name='Root',
        )
        child = Collection.objects.create(
            workspace=self.workspace, parent=root, name='Child',
        )
        leaf = Collection.objects.create(
            workspace=self.workspace, parent=child, name='Leaf',
        )
        self._make_doc_item(collection=leaf, title='Deep Doc')

        stats = rehost_cloud_collections_to_organization(
            organization_id=self.organization.id, dry_run=False,
        )

        self.assertEqual(stats.rehosted, 1)
        for coll in (root, child, leaf):
            coll.refresh_from_db()
            self.assertEqual(coll.organization_id, self.organization.id)
            self.assertIsNone(coll.workspace_id)
        self.assertEqual(child.parent_id, root.id)
        self.assertEqual(leaf.parent_id, child.id)

    def test_rehost_skips_chain_with_system_key_ancestor(self):
        system_root = Collection.objects.create(
            workspace=self.workspace, parent=None, name='System Root',
            system_key='default',
        )
        child = Collection.objects.create(
            workspace=self.workspace, parent=system_root, name='Under System',
        )
        self._make_doc_item(collection=child, title='Doc Under System')

        stats = rehost_cloud_collections_to_organization(
            organization_id=self.organization.id, dry_run=False,
        )

        self.assertEqual(stats.rehosted, 0)
        system_root.refresh_from_db()
        child.refresh_from_db()
        self.assertIsNone(system_root.organization_id)
        self.assertIsNone(child.organization_id)
        self.assertEqual(system_root.workspace_id, self.workspace.id)

    def test_rehost_renames_root_on_name_conflict(self):
        Collection.objects.create(
            organization=self.organization, parent=None, name='Docs Folder',
        )
        folder = Collection.objects.create(
            workspace=self.workspace, parent=None, name='Docs Folder',
        )
        self._make_doc_item(collection=folder, title='Conflicting Doc')

        stats = rehost_cloud_collections_to_organization(
            organization_id=self.organization.id, dry_run=False,
        )

        self.assertEqual(stats.rehosted, 1)
        self.assertEqual(stats.renamed, 1)
        folder.refresh_from_db()
        self.assertEqual(folder.name, 'Docs Folder (migrated)')
        self.assertEqual(
            Collection.objects.filter(
                organization=self.organization, name='Docs Folder',
            ).count(),
            1,
        )

    def test_dry_run_does_not_write(self):
        folder = Collection.objects.create(
            workspace=self.workspace, parent=None, name='Dry Run Folder',
        )
        item = self._make_doc_item(collection=folder, title='Dry Run Doc')

        stats = rehost_cloud_collections_to_organization(
            organization_id=self.organization.id, dry_run=True,
        )

        self.assertEqual(stats.rehosted, 1)
        self.assertEqual(stats.items_rehosted, 1)
        folder.refresh_from_db()
        item.refresh_from_db()
        self.assertIsNone(folder.organization_id)
        self.assertEqual(folder.workspace_id, self.workspace.id)
        self.assertIsNone(item.organization_id)
        self.assertEqual(item.workspace_id, self.workspace.id)

    def test_organization_id_filter_skips_other_organizations(self):
        other_owner = User.objects.create_user(
            username='i7140-rehost-other-owner',
            email='i7140-rehost-other-owner@test.com',
            password='x',
        )
        other_organization = Organization.objects.create(
            name='I7140 Rehost Other Org',
            owner_id=other_owner.id,
            is_default=False,
        )
        folder = Collection.objects.create(
            workspace=self.workspace, parent=None, name='Untouched Folder',
        )
        self._make_doc_item(collection=folder, title='Untouched Doc')

        stats = rehost_cloud_collections_to_organization(
            organization_id=other_organization.id, dry_run=False,
        )

        self.assertEqual(stats.rehosted, 0)
        folder.refresh_from_db()
        self.assertIsNone(folder.organization_id)
        self.assertEqual(folder.workspace_id, self.workspace.id)

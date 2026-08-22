"""#7160：ContextItem.parent 校验 / 移动 / 回收站上提 / Collection 迁移。"""
from __future__ import annotations

from uuid import uuid4

from django.test import TestCase
from django.utils import timezone

from apps.tabdoc.models import Document
from apps.tabtinspace.models import Collection, ContextItem, Device, SpaceMembership, Workspace
from apps.tabtinspace.services.context_item_parent import (
    ContextItemParentError,
    assign_parent,
    promote_children_on_trash,
    sanitize_parent_on_restore,
    validate_parent_for_item,
)
from apps.tabtinspace.services.migrate_collections_to_context_parent import (
    MIGRATED_FROM_KEY,
    migrate_collections_to_context_parent,
)
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


class ContextItemParentTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.user = create_test_user(prefix="ctx_parent")
        self.organization = create_test_organization(owner=self.user, prefix="ctx_parent")
        suffix = uuid4().hex[:8]
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name=f"ctx-parent-device-{suffix}",
            device_type="electron",
            role="control",
            fingerprint=f"ctx-parent-{suffix}",
            status="online",
        )
        working_dir = f"/tmp/ctx-parent-{suffix}"
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            created_by=self.user,
            name="Ctx Parent Workspace",
            working_dir=working_dir,
            normalized_working_dir=working_dir,
        )
        SpaceMembership.objects.get_or_create(
            workspace=self.workspace,
            user=self.user,
            defaults={"role": "owner", "is_active": True},
        )

    def _doc_item(self, title: str, *, parent: ContextItem | None = None) -> ContextItem:
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.user.id,
            title=title,
            description_markdown=title,
            description_plaintext=title,
        )
        return ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title=title,
            resource_id=str(doc.id),
            parent=parent,
            is_archived=False,
            created_by=self.user,
            updated_by=self.user,
        )

    def test_validate_rejects_trashed_parent(self):
        parent = self._doc_item("Parent")
        parent.status = "trashed"
        parent.trashed_at = timezone.now()
        parent.save(update_fields=["status", "trashed_at"])
        child = self._doc_item("Child")
        with self.assertRaises(ContextItemParentError):
            validate_parent_for_item(item=child, parent=parent)

    def test_validate_rejects_cycle(self):
        a = self._doc_item("A")
        b = self._doc_item("B", parent=a)
        c = self._doc_item("C", parent=b)
        with self.assertRaises(ContextItemParentError):
            assign_parent(a, c.id)

    def test_validate_rejects_cross_host(self):
        other_org = create_test_organization(owner=self.user, prefix="ctx_parent_other")
        foreign = ContextItem.objects.create(
            organization_id=other_org.id,
            item_type="tabdoc",
            title="Foreign",
            resource_id=str(uuid4()),
            is_archived=False,
        )
        child = self._doc_item("Child")
        with self.assertRaises(ContextItemParentError):
            validate_parent_for_item(item=child, parent=foreign)

    def test_assign_parent_and_move_to_root(self):
        parent = self._doc_item("Parent")
        child = self._doc_item("Child")
        assign_parent(child, parent.id)
        child.refresh_from_db()
        self.assertEqual(child.parent_id, parent.id)
        assign_parent(child, None)
        child.refresh_from_db()
        self.assertIsNone(child.parent_id)

    def test_parent_and_collection_id_are_independent(self):
        """#7214：云盘 collection_id 与云文档 parent_id 平行共存，互不清空。"""
        folder = Collection.objects.create(
            organization=self.organization,
            name="Drive Folder",
            order=0,
            created_by=self.user,
        )
        parent = self._doc_item("Parent Doc")
        child = self._doc_item("Child Doc")
        child.collection_id = folder.id
        child.save(update_fields=["collection_id"])

        assign_parent(child, parent.id)
        child.refresh_from_db()
        self.assertEqual(child.parent_id, parent.id)
        self.assertEqual(child.collection_id, folder.id)

        child.collection_id = None
        child.save(update_fields=["collection_id"])
        child.refresh_from_db()
        self.assertEqual(child.parent_id, parent.id)
        self.assertIsNone(child.collection_id)

    def test_promote_children_on_trash(self):
        root = self._doc_item("Root")
        mid = self._doc_item("Mid", parent=root)
        leaf = self._doc_item("Leaf", parent=mid)
        promoted = promote_children_on_trash(mid)
        self.assertEqual(promoted, 1)
        leaf.refresh_from_db()
        self.assertEqual(leaf.parent_id, root.id)

    def test_resource_bridge_trash_promotes_children(self):
        root = self._doc_item("Root")
        mid = self._doc_item("Mid", parent=root)
        leaf = self._doc_item("Leaf", parent=mid)
        mid_doc = Document.objects.get(id=mid.resource_id)
        ResourceBridge._trash_context_item(mid_doc, user=self.user)
        leaf.refresh_from_db()
        mid.refresh_from_db()
        self.assertEqual(leaf.parent_id, root.id)
        self.assertEqual(mid.status, "trashed")

    def test_sanitize_parent_on_restore_when_parent_trashed(self):
        parent = self._doc_item("Parent")
        child = self._doc_item("Child", parent=parent)
        parent.status = "trashed"
        parent.trashed_at = timezone.now()
        parent.save(update_fields=["status", "trashed_at"])
        changed = sanitize_parent_on_restore(child)
        self.assertTrue(changed)
        child.refresh_from_db()
        self.assertIsNone(child.parent_id)


class MigrateCollectionsToContextParentTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.user = create_test_user(prefix="coll_mig")
        self.organization = create_test_organization(owner=self.user, prefix="coll_mig")
        self.folder = Collection.objects.create(
            organization=self.organization,
            name="Folder A",
            icon="📁",
            order=0,
            created_by=self.user,
        )
        self.child_folder = Collection.objects.create(
            organization=self.organization,
            name="Folder B",
            icon="📁",
            parent=self.folder,
            order=0,
            created_by=self.user,
        )
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.user.id,
            title="Doc In Folder",
        )
        self.doc_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title="Doc In Folder",
            resource_id=str(doc.id),
            collection_id=self.folder.id,
            is_archived=False,
        )

    def test_dry_run_does_not_write(self):
        stats = migrate_collections_to_context_parent(
            organization_id=self.organization.id,
            dry_run=True,
        )
        self.assertGreaterEqual(stats.scanned_collections, 2)
        self.assertEqual(
            ContextItem.objects.filter(
                metadata__contains={MIGRATED_FROM_KEY: str(self.folder.id)},
            ).count(),
            0,
        )
        self.doc_item.refresh_from_db()
        self.assertIsNone(self.doc_item.parent_id)

    def test_migrate_relinks_and_is_idempotent(self):
        stats1 = migrate_collections_to_context_parent(
            organization_id=self.organization.id,
            dry_run=False,
        )
        self.assertEqual(stats1.created_docs, 2)
        self.doc_item.refresh_from_db()
        self.assertIsNotNone(self.doc_item.parent_id)
        placeholder = ContextItem.objects.get(
            metadata__contains={MIGRATED_FROM_KEY: str(self.folder.id)},
        )
        self.assertEqual(self.doc_item.parent_id, placeholder.id)

        child_placeholder = ContextItem.objects.get(
            metadata__contains={MIGRATED_FROM_KEY: str(self.child_folder.id)},
        )
        self.assertEqual(child_placeholder.parent_id, placeholder.id)

        # ：两套平行位置——迁移写 parent_id，保留 Collection 行与原 collection_id
        self.assertTrue(Collection.objects.filter(id=self.folder.id).exists())
        self.assertTrue(Collection.objects.filter(id=self.child_folder.id).exists())
        self.assertEqual(self.doc_item.collection_id, self.folder.id)

        stats2 = migrate_collections_to_context_parent(
            organization_id=self.organization.id,
            dry_run=False,
        )
        self.assertEqual(stats2.created_docs, 0)
        self.assertEqual(stats2.reused_docs, 2)

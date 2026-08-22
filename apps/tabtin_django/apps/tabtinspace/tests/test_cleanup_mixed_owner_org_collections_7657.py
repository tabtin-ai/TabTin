"""#7657：无主 / 跨创建者嵌套文件夹清理——资源保留、上提、幂等、门禁。"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabtinspace.models import (
    Collection,
    ContextItem,
    Organization,
    OrganizationMember,
)
from apps.tabtinspace.services.collection_mixed_owner_cleanup import (
    assert_no_null_owner_org_collections,
    cleanup_mixed_owner_org_collections,
    cleanup_null_owner_org_collections,
    cleanup_org_collection_privacy_7657,
)

User = get_user_model()


class CleanupMixedOwnerOrgCollectionsTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = User.objects.db_manager("default").create_user(
            username="i7657-clean-owner",
            email="i7657-clean-owner@test.com",
            password="x",
        )
        self.member = User.objects.db_manager("default").create_user(
            username="i7657-clean-member",
            email="i7657-clean-member@test.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="I7657 Cleanup Org",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.member, role="editor",
        )

    def test_dry_run_does_not_mutate(self):
        parent = Collection.objects.create(
            organization=self.organization,
            name="Owner Root",
            created_by=self.owner,
        )
        child = Collection.objects.create(
            organization=self.organization,
            parent=parent,
            name="Member Child",
            created_by=self.member,
        )
        item = ContextItem.objects.create(
            organization=self.organization,
            collection=child,
            item_type="tabfiles",
            title="Keep Me",
            status="active",
            resource_id="keep-1",
            created_by=self.member,
        )

        stats = cleanup_mixed_owner_org_collections(dry_run=True)
        self.assertEqual(stats.topmost_roots, 1)
        self.assertEqual(stats.folders_deleted, 1)
        self.assertEqual(stats.items_detached, 1)
        self.assertTrue(Collection.objects.filter(id=child.id).exists())
        item.refresh_from_db()
        self.assertEqual(item.collection_id, child.id)

    def test_cleanup_detaches_resources_and_deletes_mixed_subtree(self):
        parent = Collection.objects.create(
            organization=self.organization,
            name="Owner Root",
            created_by=self.owner,
        )
        child = Collection.objects.create(
            organization=self.organization,
            parent=parent,
            name="Member Child",
            created_by=self.member,
        )
        grandchild = Collection.objects.create(
            organization=self.organization,
            parent=child,
            name="Nested",
            created_by=self.member,
        )
        item = ContextItem.objects.create(
            organization=self.organization,
            collection=grandchild,
            item_type="tabfiles",
            title="Keep Me",
            status="active",
            resource_id="keep-2",
            created_by=self.member,
        )
        orphan = ContextItem.objects.create(
            organization=self.organization,
            collection=child,
            item_type="tabfiles",
            title="Orphan",
            status="active",
            resource_id="orphan-1",
            created_by=None,
        )

        stats = cleanup_mixed_owner_org_collections(dry_run=False)
        self.assertEqual(stats.topmost_roots, 1)
        self.assertEqual(stats.folders_deleted, 2)
        self.assertEqual(stats.items_detached, 1)
        self.assertEqual(stats.orphan_items_detached, 1)

        self.assertTrue(Collection.objects.filter(id=parent.id).exists())
        self.assertFalse(Collection.objects.filter(id=child.id).exists())
        self.assertFalse(Collection.objects.filter(id=grandchild.id).exists())

        item.refresh_from_db()
        orphan.refresh_from_db()
        self.assertIsNone(item.collection_id)
        self.assertIsNone(orphan.collection_id)
        self.assertEqual(item.created_by_id, self.member.id)

    def test_cleanup_is_idempotent(self):
        parent = Collection.objects.create(
            organization=self.organization,
            name="Owner Root",
            created_by=self.owner,
        )
        Collection.objects.create(
            organization=self.organization,
            parent=parent,
            name="Member Child",
            created_by=self.member,
        )

        first = cleanup_mixed_owner_org_collections(dry_run=False)
        second = cleanup_mixed_owner_org_collections(dry_run=False)
        self.assertEqual(first.topmost_roots, 1)
        self.assertEqual(second.topmost_roots, 0)
        self.assertEqual(second.folders_deleted, 0)

    def test_same_owner_nesting_untouched(self):
        parent = Collection.objects.create(
            organization=self.organization,
            name="Owner Root",
            created_by=self.owner,
        )
        child = Collection.objects.create(
            organization=self.organization,
            parent=parent,
            name="Owner Child",
            created_by=self.owner,
        )
        stats = cleanup_mixed_owner_org_collections(dry_run=False)
        self.assertEqual(stats.topmost_roots, 0)
        self.assertTrue(Collection.objects.filter(id=child.id).exists())


class CleanupNullOwnerOrgCollectionsTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = User.objects.db_manager("default").create_user(
            username="i7657-null-owner",
            email="i7657-null-owner@test.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="I7657 Null Owner Org",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role="owner",
        )

    def test_null_owner_root_detaches_items_and_deletes_folder(self):
        orphan_root = Collection.objects.create(
            organization=self.organization,
            name="Orphan Root",
            created_by=None,
        )
        item = ContextItem.objects.create(
            organization=self.organization,
            collection=orphan_root,
            item_type="tabfiles",
            title="Recover Me",
            status="active",
            resource_id="null-root-item",
            created_by=self.owner,
        )

        stats = cleanup_null_owner_org_collections(dry_run=False)
        self.assertEqual(stats.null_owner_scanned, 1)
        self.assertEqual(stats.null_owner_folders_deleted, 1)
        self.assertEqual(stats.items_detached, 1)
        self.assertFalse(Collection.objects.filter(id=orphan_root.id).exists())
        item.refresh_from_db()
        self.assertIsNone(item.collection_id)
        self.assertEqual(assert_no_null_owner_org_collections(), 0)

    def test_null_owner_child_under_owned_parent(self):
        parent = Collection.objects.create(
            organization=self.organization,
            name="Owned Root",
            created_by=self.owner,
        )
        null_child = Collection.objects.create(
            organization=self.organization,
            parent=parent,
            name="Null Child",
            created_by=None,
        )
        item = ContextItem.objects.create(
            organization=self.organization,
            collection=null_child,
            item_type="tabfiles",
            title="In Null Child",
            status="active",
            resource_id="null-child-item",
            created_by=self.owner,
        )

        stats = cleanup_null_owner_org_collections(dry_run=False)
        self.assertEqual(stats.null_owner_folders_deleted, 1)
        self.assertTrue(Collection.objects.filter(id=parent.id).exists())
        self.assertFalse(Collection.objects.filter(id=null_child.id).exists())
        item.refresh_from_db()
        self.assertIsNone(item.collection_id)

    def test_owned_child_under_null_parent_is_reparented(self):
        null_root = Collection.objects.create(
            organization=self.organization,
            name="Null Root",
            created_by=None,
        )
        owned_child = Collection.objects.create(
            organization=self.organization,
            parent=null_root,
            name="Owned Child",
            created_by=self.owner,
        )
        # 根上已有同名夹，上提时应自动改名
        Collection.objects.create(
            organization=self.organization,
            name="Owned Child",
            created_by=self.owner,
        )

        stats = cleanup_null_owner_org_collections(dry_run=False)
        self.assertEqual(stats.owned_reparented, 1)
        self.assertFalse(Collection.objects.filter(id=null_root.id).exists())
        owned_child.refresh_from_db()
        self.assertIsNone(owned_child.parent_id)
        self.assertEqual(owned_child.name, "Owned Child (2)")
        self.assertEqual(assert_no_null_owner_org_collections(), 0)

    def test_reparent_truncates_255_char_name_for_two_digit_suffix(self):
        """原名满 255 且 `` (2)``..`` (9)`` 已被占时，`` (10)`` 不得溢出 varchar(255)。"""
        max_len = Collection._meta.get_field("name").max_length
        long_name = "A" * max_len
        null_root = Collection.objects.create(
            organization=self.organization,
            name="Null Root Long",
            created_by=None,
        )
        owned_child = Collection.objects.create(
            organization=self.organization,
            parent=null_root,
            name=long_name,
            created_by=self.owner,
        )
        # 根上占满原名 + 单位数后缀（截断后仍合法），迫使走到 `` (10)``
        Collection.objects.create(
            organization=self.organization,
            name=long_name,
            created_by=self.owner,
        )
        for n in range(2, 10):
            tag = f" ({n})"
            Collection.objects.create(
                organization=self.organization,
                name=f"{long_name[: max_len - len(tag)]}{tag}",
                created_by=self.owner,
            )

        stats = cleanup_null_owner_org_collections(dry_run=False)
        self.assertEqual(stats.owned_reparented, 1)
        self.assertFalse(Collection.objects.filter(id=null_root.id).exists())
        owned_child.refresh_from_db()
        self.assertIsNone(owned_child.parent_id)
        expected = f"{long_name[: max_len - len(' (10)')]} (10)"
        self.assertEqual(owned_child.name, expected)
        self.assertEqual(len(owned_child.name), max_len)
        self.assertEqual(assert_no_null_owner_org_collections(), 0)

    def test_null_parent_and_null_child_both_deleted(self):
        null_root = Collection.objects.create(
            organization=self.organization,
            name="Null Root",
            created_by=None,
        )
        null_child = Collection.objects.create(
            organization=self.organization,
            parent=null_root,
            name="Null Child",
            created_by=None,
        )
        stats = cleanup_null_owner_org_collections(dry_run=False)
        self.assertEqual(stats.null_owner_folders_deleted, 2)
        self.assertFalse(Collection.objects.filter(id__in=[null_root.id, null_child.id]).exists())

    def test_privacy_gate_is_idempotent_and_clears_null_owners(self):
        Collection.objects.create(
            organization=self.organization,
            name="Null Root",
            created_by=None,
        )
        parent = Collection.objects.create(
            organization=self.organization,
            name="Owned",
            created_by=self.owner,
        )
        Collection.objects.create(
            organization=self.organization,
            parent=parent,
            name="Member Nested",
            created_by=User.objects.db_manager("default").create_user(
                username="i7657-null-member",
                email="i7657-null-member@test.com",
                password="x",
            ),
        )

        first = cleanup_org_collection_privacy_7657(dry_run=False)
        self.assertGreaterEqual(first.null_owner_folders_deleted, 1)
        self.assertEqual(assert_no_null_owner_org_collections(), 0)

        second = cleanup_org_collection_privacy_7657(dry_run=False)
        self.assertEqual(second.null_owner_scanned, 0)
        self.assertEqual(second.topmost_roots, 0)
        self.assertEqual(second.folders_deleted, 0)

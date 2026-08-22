"""#7140：Collection Organization 归属 —— 三态约束、org CRUD、跨 org 拒绝、同名 409。"""
from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase

from apps.tabtinspace.models import (
    Collection,
    ContextItem,
    Device,
    Organization,
    OrganizationMember,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.collection_service import CollectionService

User = get_user_model()


class CollectionOrganizationHostConstraintTests(TestCase):
    """DB 层三态互斥约束（migrations 0126/0127）。"""

    databases = {'default', 'postgresql'}

    def setUp(self):
        self.owner = User.objects.db_manager('default').create_user(
            username='i7140-constraint-owner',
            email='i7140-constraint-owner@test.com',
            password='x',
        )
        self.organization = Organization.objects.create(
            name='I7140 Constraint Org',
            owner_id=self.owner.id,
            is_default=False,
        )

    def _make_workspace(self) -> Workspace:
        suffix = uuid4().hex[:8]
        device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name=f'i7140-device-{suffix}',
            device_type='electron',
            role='control',
            fingerprint=f'i7140-{suffix}',
            status='online',
        )
        wd = f'/tmp/i7140-{suffix}'
        return Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.owner,
            name=f'I7140 WS {suffix}',
            working_dir=wd,
            normalized_working_dir=wd,
        )

    def test_organization_only_collection_is_valid(self):
        coll = Collection.objects.create(
            organization=self.organization,
            parent=None,
            name='Org Root',
        )
        self.assertIsNone(coll.workspace_id)
        self.assertIsNone(coll.project_id)
        self.assertEqual(coll.organization_id, self.organization.id)
        self.assertIsNone(coll.space_id)

    def test_workspace_and_organization_both_set_violates_exclusivity(self):
        workspace = self._make_workspace()
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Collection.objects.create(
                    workspace=workspace,
                    organization=self.organization,
                    parent=None,
                    name='Both Hosts',
                )

    def test_no_host_at_all_violates_exclusivity(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Collection.objects.create(
                    parent=None,
                    name='No Host',
                )

    def test_organization_root_name_unique_constraint(self):
        """#7657：同创建者下根名唯一；不同创建者允许同名。"""
        Collection.objects.create(
            organization=self.organization,
            parent=None,
            name='Dup Root',
            created_by=self.owner,
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Collection.objects.create(
                    organization=self.organization,
                    parent=None,
                    name='Dup Root',
                    created_by=self.owner,
                )
        other = User.objects.db_manager('default').create_user(
            username='i7140-constraint-other',
            email='i7140-constraint-other@test.com',
            password='x',
        )
        # 不同创建者可同名
        Collection.objects.create(
            organization=self.organization,
            parent=None,
            name='Dup Root',
            created_by=other,
        )


class CollectionOrganizationHostServiceTests(TestCase):
    """CollectionService 组织级路径：CRUD / 跨 org 拒绝 / 同名 409。"""

    databases = {'default', 'postgresql'}

    def setUp(self):
        self.owner = User.objects.db_manager('default').create_user(
            username='i7140-owner',
            email='i7140-owner@test.com',
            password='x',
        )
        self.organization = Organization.objects.create(
            name='I7140 Org',
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role='owner',
        )

        self.other_owner = User.objects.db_manager('default').create_user(
            username='i7140-other-owner',
            email='i7140-other-owner@test.com',
            password='x',
        )
        self.other_organization = Organization.objects.create(
            name='I7140 Other Org',
            owner_id=self.other_owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.other_organization,
            user=self.other_owner,
            role='owner',
        )

        self.service = CollectionService(user=self.owner)

    # ── create ──

    def test_create_collection_for_organization(self):
        coll = self.service.create_collection_for_organization(
            self.organization.id, name='Root Folder',
        )
        self.assertIsNotNone(coll)
        self.assertEqual(coll.organization_id, self.organization.id)
        self.assertIsNone(coll.workspace_id)
        self.assertIsNone(coll.project_id)

    def test_create_collection_for_organization_rejects_non_member(self):
        outsider = User.objects.db_manager('default').create_user(
            username='i7140-outsider',
            email='i7140-outsider@test.com',
            password='x',
        )
        coll = CollectionService(user=outsider).create_collection_for_organization(
            self.organization.id, name='Should Not Create',
        )
        self.assertIsNone(coll)
        self.assertFalse(Collection.objects.filter(name='Should Not Create').exists())

    def test_create_collection_for_organization_duplicate_name_conflict(self):
        self.service.create_collection_for_organization(self.organization.id, name='Docs')
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_collection_for_organization(self.organization.id, name='Docs')
        self.assertEqual(ctx.exception.code, 'DUPLICATE_NAME')
        self.assertEqual(ctx.exception.status, 409)

    def test_create_collection_for_organization_nested_duplicate_name_conflict(self):
        parent = self.service.create_collection_for_organization(
            self.organization.id, name='Parent',
        )
        self.service.create_collection_for_organization(
            self.organization.id, name='Child', parent_id=parent.id,
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_collection_for_organization(
                self.organization.id, name='Child', parent_id=parent.id,
            )
        self.assertEqual(ctx.exception.code, 'DUPLICATE_NAME')

    def test_create_collection_for_organization_rejects_parent_from_other_org(self):
        foreign_parent = CollectionService(user=self.other_owner).create_collection_for_organization(
            self.other_organization.id, name='Foreign Parent',
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_collection_for_organization(
                self.organization.id, name='Child', parent_id=foreign_parent.id,
            )
        self.assertEqual(ctx.exception.code, 'PARENT_NOT_FOUND')

    def test_create_collection_for_organization_max_depth_exceeded(self):
        parent_id = None
        for depth in range(Collection.MAX_NESTING_DEPTH):
            coll = self.service.create_collection_for_organization(
                self.organization.id, name=f'Depth {depth}', parent_id=parent_id,
            )
            parent_id = coll.id
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_collection_for_organization(
                self.organization.id, name='Too Deep', parent_id=parent_id,
            )
        self.assertEqual(ctx.exception.code, 'MAX_DEPTH_EXCEEDED')

    # ── list ──

    def test_list_collections_for_organization_returns_tree_with_org_fields(self):
        root = self.service.create_collection_for_organization(
            self.organization.id, name='Root',
        )
        self.service.create_collection_for_organization(
            self.organization.id, name='Child', parent_id=root.id,
        )

        tree = self.service.list_collections_for_organization(self.organization.id)

        self.assertEqual(len(tree), 1)
        root_node = tree[0]
        self.assertEqual(root_node['organization_id'], self.organization.id)
        self.assertIsNone(root_node['space_id'])
        self.assertEqual(len(root_node['children']), 1)
        self.assertEqual(root_node['children'][0]['organization_id'], self.organization.id)

    def test_create_then_list_organization_collections_is_same_bucket(self):
        """回归：POST 写入 org-only，GET 必须立刻列出同一桶，不能只读 workspace 夹。"""
        created = self.service.create_collection_for_organization(
            self.organization.id, name='Drive Folder',
        )
        self.assertIsNotNone(created)
        self.assertEqual(created.organization_id, self.organization.id)
        self.assertIsNone(created.workspace_id)
        self.assertIsNone(created.project_id)

        tree = self.service.list_collections_for_organization(self.organization.id)
        self.assertEqual(len(tree), 1)
        self.assertEqual(str(tree[0]['id']), str(created.id))
        self.assertEqual(tree[0]['name'], 'Drive Folder')
        self.assertEqual(tree[0]['organization_id'], self.organization.id)
        self.assertIsNone(tree[0]['space_id'])

    def test_list_organization_collections_excludes_workspace_host_folders(self):
        """云盘 org 列表不得混入 Workspace/Project Collection（与知识树解耦）。"""
        from apps.tabtinspace.models import Device, Workspace

        suffix = uuid4().hex[:8]
        device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name=f'i7140-list-device-{suffix}',
            device_type='electron',
            role='control',
            fingerprint=f'i7140-list-{suffix}',
            status='online',
        )
        wd = f'/tmp/i7140-list-{suffix}'
        workspace = Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.owner,
            name=f'I7140 List WS {suffix}',
            working_dir=wd,
            normalized_working_dir=wd,
        )
        Collection.objects.create(
            workspace=workspace,
            name='Workspace Only Folder',
            icon='📁',
            order=0,
            created_by=self.owner,
        )
        org_root = self.service.create_collection_for_organization(
            self.organization.id, name='Org Only Folder',
        )

        tree = self.service.list_collections_for_organization(self.organization.id)
        names = {node['name'] for node in tree}
        self.assertEqual(names, {'Org Only Folder'})
        self.assertEqual(str(tree[0]['id']), str(org_root.id))

    def test_list_collections_for_organization_rejects_non_member(self):
        self.service.create_collection_for_organization(self.organization.id, name='Root')
        outsider = User.objects.db_manager('default').create_user(
            username='i7140-list-outsider',
            email='i7140-list-outsider@test.com',
            password='x',
        )
        tree = CollectionService(user=outsider).list_collections_for_organization(
            self.organization.id,
        )
        self.assertEqual(tree, [])

    # ── update / delete ──

    def test_update_collection_for_organization_host_uses_organization_permission(self):
        coll = self.service.create_collection_for_organization(self.organization.id, name='Before')
        updated = self.service.update_collection(coll.id, name='After')
        self.assertIsNotNone(updated)
        self.assertEqual(updated.name, 'After')

    def test_update_collection_for_organization_host_rejects_non_member(self):
        coll = self.service.create_collection_for_organization(self.organization.id, name='Before')
        outsider = User.objects.db_manager('default').create_user(
            username='i7140-update-outsider',
            email='i7140-update-outsider@test.com',
            password='x',
        )
        updated = CollectionService(user=outsider).update_collection(coll.id, name='Hacked')
        self.assertIsNone(updated)
        coll.refresh_from_db()
        self.assertEqual(coll.name, 'Before')

    def test_delete_collection_for_organization_host(self):
        coll = self.service.create_collection_for_organization(self.organization.id, name='To Delete')
        deleted = self.service.delete_collection(coll.id)
        self.assertTrue(deleted)
        self.assertFalse(Collection.objects.filter(id=coll.id).exists())

    # ── reorder ──

    def test_reorder_collections_for_organization(self):
        first = self.service.create_collection_for_organization(self.organization.id, name='A')
        second = self.service.create_collection_for_organization(self.organization.id, name='B')

        ok = self.service.reorder_collections_for_organization(
            self.organization.id, [second.id, first.id],
        )
        self.assertTrue(ok)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(second.order, 0)
        self.assertEqual(first.order, 1)

    def test_reorder_collections_for_organization_rejects_non_member(self):
        outsider = User.objects.db_manager('default').create_user(
            username='i7140-reorder-outsider',
            email='i7140-reorder-outsider@test.com',
            password='x',
        )
        ok = CollectionService(user=outsider).reorder_collections_for_organization(
            self.organization.id, [],
        )
        self.assertFalse(ok)

    # ── move-items ──

    def test_move_items_for_organization_accepts_org_only_cloud_item(self):
        target_folder = self.service.create_collection_for_organization(
            self.organization.id, name='Target',
        )
        item = ContextItem.objects.create(
            organization=self.organization,
            collection=None,
            item_type='tabfiles',
            title='Org File',
            status='active',
            resource_id='org-file-1',
            created_by=self.owner,
        )

        updated = self.service.move_items_for_organization(
            self.organization.id, [item.id], target_folder.id,
        )
        self.assertEqual(updated, 1)
        item.refresh_from_db()
        self.assertEqual(item.collection_id, target_folder.id)

        updated_out = self.service.move_items_for_organization(
            self.organization.id, [item.id], None,
        )
        self.assertEqual(updated_out, 1)
        item.refresh_from_db()
        self.assertIsNone(item.collection_id)

    def test_move_items_for_organization_rejects_target_collection_from_other_org(self):
        foreign_folder = CollectionService(user=self.other_owner).create_collection_for_organization(
            self.other_organization.id, name='Foreign Target',
        )
        item = ContextItem.objects.create(
            organization=self.organization,
            collection=None,
            item_type='tabfiles',
            title='Org File',
            status='active',
            resource_id='org-file-2',
            created_by=self.owner,
        )

        with self.assertRaises(ServiceError) as ctx:
            self.service.move_items_for_organization(
                self.organization.id, [item.id], foreign_folder.id,
            )
        self.assertEqual(ctx.exception.code, 'COLLECTION_NOT_FOUND')
        item.refresh_from_db()
        self.assertIsNone(item.collection_id)

    def test_move_items_for_organization_rejects_item_from_other_org(self):
        target_folder = self.service.create_collection_for_organization(
            self.organization.id, name='Target 2',
        )
        foreign_item = ContextItem.objects.create(
            organization=self.other_organization,
            collection=None,
            item_type='tabfiles',
            title='Foreign File',
            status='active',
            resource_id='foreign-file-1',
            created_by=self.other_owner,
        )

        with self.assertRaises(ServiceError) as ctx:
            self.service.move_items_for_organization(
                self.organization.id, [foreign_item.id], target_folder.id,
            )
        self.assertEqual(ctx.exception.code, 'MOVE_DENIED')
        foreign_item.refresh_from_db()
        self.assertIsNone(foreign_item.collection_id)

    def test_move_items_for_organization_rejects_non_member(self):
        target_folder = self.service.create_collection_for_organization(
            self.organization.id, name='Target 3',
        )
        outsider = User.objects.db_manager('default').create_user(
            username='i7140-move-outsider',
            email='i7140-move-outsider@test.com',
            password='x',
        )
        with self.assertRaises(ServiceError) as ctx:
            CollectionService(user=outsider).move_items_for_organization(
                self.organization.id, [uuid4()], target_folder.id,
            )
        self.assertEqual(ctx.exception.code, 'PERMISSION_DENIED')

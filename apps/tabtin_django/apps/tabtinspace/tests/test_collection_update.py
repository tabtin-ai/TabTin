from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from apps.tabtinspace.models import (
    Collection,
    ContextItem,
    Device,
    SpaceMembership,
    Organization,
    OrganizationMember,
    Workspace,
)
from apps.tabtinspace.routers.collection import create_collection_for_organization
from apps.tabtinspace.routers.collection import delete_collection as route_delete_collection
from apps.tabtinspace.routers.collection import reorder_collections as route_reorder_collections
from apps.tabtinspace.routers.collection import update_collection
from apps.tabtinspace.schemas.collection import CollectionCreate, CollectionReorder, CollectionUpdate
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.collection_service import CollectionService
from apps.tabtinspace.services.context_item_service import ContextItemService


User = get_user_model()


class CollectionCreateOrganizationWsTests(SimpleTestCase):
    """#7606 / ：Organization Collection 创建成功后必须推送 collection_created。

    扇出目标由 ``_push_collection_ws`` 收口为创建者 user topic（不再写 org topic）。
    """

    def test_create_organization_collection_publishes_collection_created(self):
        organization_id = uuid4()
        coll = SimpleNamespace(id=uuid4(), name='CLI Folder')
        request = SimpleNamespace(auth=object())

        with (
            patch('apps.tabtinspace.routers.collection.CollectionService') as service_cls,
            patch('apps.tabtinspace.routers.collection._push_collection_ws') as push_ws,
            patch('apps.tabtinspace.schemas.collection.CollectionOut') as out_cls,
        ):
            service = service_cls.return_value
            service.create_collection_for_organization.return_value = coll
            out_cls.from_orm.return_value.dict.return_value = {
                'id': str(coll.id),
                'name': coll.name,
            }

            status, _payload = create_collection_for_organization(
                request,
                organization_id,
                CollectionCreate(name='CLI Folder'),
            )

        self.assertEqual(status, 201)
        push_ws.assert_called_once_with(
            None,
            'collection_created',
            coll,
            organization_id=str(organization_id),
        )


class CollectionUpdateRouterTests(SimpleTestCase):
    def test_explicit_null_parent_id_is_forwarded_to_service(self):
        collection_id = uuid4()
        request = SimpleNamespace(auth=object())

        with patch('apps.tabtinspace.routers.collection.CollectionService') as service_cls:
            service = service_cls.return_value
            service.update_collection.return_value = None

            update_collection(request, collection_id, CollectionUpdate(parent_id=None))

        service.update_collection.assert_called_once()
        _, kwargs = service.update_collection.call_args
        self.assertIsNone(kwargs['parent_id'])

    def test_omitted_parent_id_keeps_existing_parent_in_service(self):
        collection_id = uuid4()
        request = SimpleNamespace(auth=object())

        with patch('apps.tabtinspace.routers.collection.CollectionService') as service_cls:
            service = service_cls.return_value
            service.update_collection.return_value = None

            update_collection(request, collection_id, CollectionUpdate(name='Renamed'))

        service.update_collection.assert_called_once()
        _, kwargs = service.update_collection.call_args
        self.assertIs(kwargs['parent_id'], ...)

    def test_is_pinned_is_forwarded_to_service(self):
        collection_id = uuid4()
        request = SimpleNamespace(auth=object())

        with patch('apps.tabtinspace.routers.collection.CollectionService') as service_cls:
            service = service_cls.return_value
            service.update_collection.return_value = None

            update_collection(request, collection_id, CollectionUpdate(is_pinned=True))

        service.update_collection.assert_called_once()
        _, kwargs = service.update_collection.call_args
        self.assertTrue(kwargs['is_pinned'])


class CollectionReorderRouterTests(SimpleTestCase):
    def test_reorder_forwards_parent_id_to_service(self):
        space_id = uuid4()
        parent_id = uuid4()
        collection_ids = [uuid4(), uuid4()]
        request = SimpleNamespace(auth=object())

        with patch('apps.tabtinspace.routers.collection.CollectionService') as service_cls:
            service = service_cls.return_value
            service.reorder_collections.return_value = True

            route_reorder_collections(
                request,
                space_id,
                CollectionReorder(collection_ids=collection_ids, parent_id=parent_id),
            )

        service.reorder_collections.assert_called_once_with(space_id, collection_ids, parent_id)

    def test_reorder_without_parent_id_defaults_to_root_scope(self):
        space_id = uuid4()
        collection_ids = [uuid4()]
        request = SimpleNamespace(auth=object())

        with patch('apps.tabtinspace.routers.collection.CollectionService') as service_cls:
            service = service_cls.return_value
            service.reorder_collections.return_value = True

            route_reorder_collections(
                request,
                space_id,
                CollectionReorder(collection_ids=collection_ids),
            )

        service.reorder_collections.assert_called_once_with(space_id, collection_ids, None)


class CollectionUpdateServiceTests(TestCase):
    databases = {'default', 'postgresql'}

    def _make_workspace(self, *, name: str, organization=None, created_by=None) -> Workspace:
        org = organization or self.organization
        owner = created_by or self.user
        suffix = uuid4().hex[:8]
        device = Device.objects.create(
            organization=org,
            user=owner,
            name=f'collection-update-device-{suffix}',
            device_type='electron',
            role='control',
            fingerprint=f'collection-update-{suffix}',
            status='online',
        )
        wd = f'/tmp/collection-update-{suffix}'
        space = Workspace.objects.create(
            organization=org,
            device=device,
            created_by=owner,
            name=name,
            working_dir=wd,
            normalized_working_dir=wd,
        )
        SpaceMembership.objects.get_or_create(
            workspace=space,
            user=owner,
            defaults={'role': 'owner', 'is_active': True},
        )
        return space

    def setUp(self):
        self.user = User.objects.db_manager('default').create_user(
            username='collection_update_owner',
            email='collection-update-owner@test.com',
            password='testpass123',
        )
        self.organization = Organization.objects.create(
            name='Collection Update Team',
            owner_id=self.user.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role='owner',
        )
        self.space = self._make_workspace(name='Collection Update Space')
        self.service = CollectionService(user=self.user)

    def test_move_collection_to_root_keeps_name_uniqueness(self):
        existing_root = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Design',
            icon='folder',
        )
        parent = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Archive',
            icon='folder',
        )
        child_same_name = Collection.objects.create(
            workspace=self.space,
            parent=parent,
            name=existing_root.name,
            icon='folder',
        )

        with self.assertRaises(ServiceError) as ctx:
            self.service.update_collection(child_same_name.id, parent_id=None)

        self.assertEqual(ctx.exception.code, 'DUPLICATE_NAME')
        child_same_name.refresh_from_db()
        self.assertEqual(child_same_name.parent_id, parent.id)

    def test_move_collection_to_root_accepts_explicit_none(self):
        parent = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Parent',
            icon='folder',
        )
        child = Collection.objects.create(
            workspace=self.space,
            parent=parent,
            name='Child',
            icon='folder',
        )

        updated = self.service.update_collection(child.id, parent_id=None)

        self.assertIsNotNone(updated)
        child.refresh_from_db()
        self.assertIsNone(child.parent_id)

    def test_pin_collection_sets_pinned_at_and_list_order(self):
        """#7573：文件夹置顶写 pinned_at，同级列表置顶优先。"""
        Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Normal',
            icon='folder',
            order=0,
        )
        pinned = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Pinned',
            icon='folder',
            order=1,
        )

        updated = self.service.update_collection(pinned.id, is_pinned=True)

        self.assertIsNotNone(updated)
        pinned.refresh_from_db()
        self.assertTrue(pinned.is_pinned)
        self.assertIsNotNone(pinned.pinned_at)

        tree = self.service.list_collections(self.space.id)
        self.assertEqual([node['name'] for node in tree], ['Pinned', 'Normal'])
        self.assertTrue(tree[0]['is_pinned'])
        self.assertFalse(tree[1]['is_pinned'])

        unpinned = self.service.update_collection(pinned.id, is_pinned=False)
        self.assertIsNotNone(unpinned)
        pinned.refresh_from_db()
        self.assertFalse(pinned.is_pinned)
        self.assertIsNone(pinned.pinned_at)

    def test_move_items_accepts_items_from_same_organization_space(self):
        other_space = self._make_workspace(name='Collection Update Other Space')
        target_folder = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Target Folder',
            icon='folder',
        )
        # 非云资产类型走 Space editor 分支，验证同组织跨 Space 宿主可移动。
        item = ContextItem.objects.create(
            workspace=other_space,
            collection=None,
            item_type='design',
            title='Cross Space Design',
            status='active',
            resource_id=str(uuid4()),
            created_by=self.user,
        )

        updated = self.service.move_items(self.space.id, [item.id], target_folder.id)

        self.assertEqual(updated, 1)
        item.refresh_from_db()
        self.assertEqual(item.collection_id, target_folder.id)

    def test_move_items_rejects_items_from_other_organization(self):
        other_user = User.objects.db_manager('default').create_user(
            username='collection_update_other_owner',
            email='collection-update-other-owner@test.com',
            password='testpass123',
        )
        other_organization = Organization.objects.create(
            name='Collection Update Other Team',
            owner_id=other_user.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=other_organization,
            user=other_user,
            role='owner',
        )
        other_space = self._make_workspace(
            name='Collection Update Foreign Space',
            organization=other_organization,
            created_by=other_user,
        )
        target_folder = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Target Folder',
            icon='folder',
        )
        item = ContextItem.objects.create(
            workspace=other_space,
            collection=None,
            item_type='tabdoc',
            title='Foreign Team Doc',
            status='active',
            resource_id='foreign-team-doc',
        )

        with self.assertRaises(ServiceError) as ctx:
            self.service.move_items(self.space.id, [item.id], target_folder.id)

        self.assertEqual(ctx.exception.code, 'MOVE_DENIED')
        item.refresh_from_db()
        self.assertIsNone(item.collection_id)

    def test_move_items_accepts_org_only_context_items(self):
        """#6603 / ：云盘 TabFiles 等 org-only 资源应可移入锚点 Space 文件夹。"""
        target_folder = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Org Files Folder',
            icon='folder',
        )
        item = ContextItem.objects.create(
            organization=self.organization,
            collection=None,
            item_type='tabfiles',
            title='Org Only File',
            status='active',
            resource_id=str(uuid4()),
            created_by=self.user,
        )

        updated = self.service.move_items(self.space.id, [item.id], target_folder.id)

        self.assertEqual(updated, 1)
        item.refresh_from_db()
        self.assertEqual(item.collection_id, target_folder.id)

        updated_out = self.service.move_items(self.space.id, [item.id], None)
        self.assertEqual(updated_out, 1)
        item.refresh_from_db()
        self.assertIsNone(item.collection_id)

    def test_move_items_requires_editor_on_source_space(self):
        limited_user = User.objects.db_manager('default').create_user(
            username='collection_update_limited_user',
            email='collection-update-limited@test.com',
            password='testpass123',
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=limited_user,
            role='editor',
        )
        source_space = self._make_workspace(name='Collection Update Source Space')
        SpaceMembership.objects.create(
            workspace=self.space,
            user=limited_user,
            role='editor',
            is_active=True,
        )
        SpaceMembership.objects.create(
            workspace=source_space,
            user=limited_user,
            role='viewer',
            is_active=True,
        )
        target_folder = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Target Folder',
            icon='folder',
        )
        # 非云资产：源 Space 仅 viewer 时不得移动（走 Space editor 分支）。
        item = ContextItem.objects.create(
            workspace=source_space,
            collection=None,
            item_type='design',
            title='Viewer Source Design',
            status='active',
            resource_id=str(uuid4()),
            created_by=limited_user,
        )

        with self.assertRaises(ServiceError) as ctx:
            CollectionService(user=limited_user).move_items(
                self.space.id,
                [item.id],
                target_folder.id,
            )

        self.assertEqual(ctx.exception.code, 'MOVE_DENIED')
        item.refresh_from_db()
        self.assertIsNone(item.collection_id)

    def test_delete_collection_moves_nested_items_to_trash(self):
        parent = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Parent',
            icon='folder',
        )
        child = Collection.objects.create(
            workspace=self.space,
            parent=parent,
            name='Child',
            icon='folder',
        )
        parent_item = ContextItem.objects.create(
            workspace=self.space,
            collection=parent,
            item_type='tabdoc',
            title='Parent Doc',
            status='active',
            resource_id='missing-parent-resource',
        )
        child_item = ContextItem.objects.create(
            workspace=self.space,
            collection=child,
            item_type='tabdoc',
            title='Child Doc',
            status='draft',
            resource_id='missing-child-resource',
        )
        root_item = ContextItem.objects.create(
            workspace=self.space,
            collection=None,
            item_type='tabdoc',
            title='Root Doc',
            status='active',
            resource_id='missing-root-resource',
        )

        deleted = self.service.delete_collection(parent.id)

        self.assertTrue(deleted)
        self.assertFalse(Collection.objects.filter(id__in=[parent.id, child.id]).exists())

        parent_item.refresh_from_db()
        child_item.refresh_from_db()
        root_item.refresh_from_db()

        self.assertIsNotNone(parent_item.trashed_at)
        self.assertEqual(str(parent_item.trashed_by), str(self.user.id))
        self.assertEqual(parent_item.previous_status, 'active')
        self.assertEqual(parent_item.status, 'trashed')
        self.assertTrue(parent_item.is_archived)
        self.assertIsNone(parent_item.collection_id)

        self.assertIsNotNone(child_item.trashed_at)
        self.assertEqual(child_item.previous_status, 'draft')
        self.assertEqual(child_item.status, 'trashed')
        self.assertTrue(child_item.is_archived)
        self.assertIsNone(child_item.collection_id)

        self.assertIsNone(root_item.trashed_at)
        self.assertEqual(root_item.status, 'active')

    def test_list_items_excludes_trashed_items_even_if_archive_flag_is_stale(self):
        trashed = ContextItem.objects.create(
            workspace=self.space,
            collection=None,
            item_type='tabdoc',
            title='Trashed Doc',
            status='trashed',
            is_archived=False,
            trashed_at=timezone.now(),
            resource_id='',
        )
        active = ContextItem.objects.create(
            workspace=self.space,
            collection=None,
            item_type='tabdoc',
            title='Active Doc',
            status='active',
            is_archived=False,
            resource_id='',
        )

        items, total = ContextItemService(user=self.user).list_items(
            self.space.id,
            is_archived=False,
        )

        self.assertEqual(total, 1)
        self.assertEqual([item.id for item in items], [active.id])
        self.assertNotIn(trashed.id, [item.id for item in items])

    def test_delete_collection_ws_payload_includes_descendant_collection_ids(self):
        parent = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Parent for WS',
            icon='folder',
        )
        child = Collection.objects.create(
            workspace=self.space,
            parent=parent,
            name='Child for WS',
            icon='folder',
        )
        request = SimpleNamespace(auth=self.user)

        with (
            patch('apps.tabtinspace.routers.collection.CollectionService.delete_collection', return_value=True),
            patch('apps.tabtinspace.routers.collection._push_collection_ws') as push_ws,
        ):
            route_delete_collection(request, parent.id)

        push_ws.assert_called_once()
        args, kwargs = push_ws.call_args
        self.assertEqual(args[1], 'collection_deleted')
        extra = kwargs['extra']
        self.assertEqual(extra['collection_id'], str(parent.id))
        self.assertCountEqual(extra['collection_ids'], [str(parent.id), str(child.id)])

    def test_reorder_nested_collections_updates_order_within_parent(self):
        parent = Collection.objects.create(
            workspace=self.space,
            parent=None,
            name='Parent Folder',
            icon='folder',
            order=0,
        )
        child_a = Collection.objects.create(
            workspace=self.space,
            parent=parent,
            name='Child A',
            icon='folder',
            order=0,
        )
        child_b = Collection.objects.create(
            workspace=self.space,
            parent=parent,
            name='Child B',
            icon='folder',
            order=1,
        )

        ok = self.service.reorder_collections(
            self.space.id,
            [child_b.id, child_a.id],
            parent.id,
        )

        self.assertTrue(ok)
        child_a.refresh_from_db()
        child_b.refresh_from_db()
        self.assertEqual(child_b.order, 0)
        self.assertEqual(child_a.order, 1)

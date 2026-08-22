"""#7657：Organization 云盘文件夹默认仅创建者可见/可操作。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import SimpleTestCase, TestCase

from apps.services.oss.models import FileRecord
from apps.tabtinspace.models import (
    Collection,
    ContextItem,
    Organization,
    OrganizationMember,
)
from apps.tabtinspace.routers.collection import create_collection_for_organization
from apps.tabtinspace.schemas.collection import CollectionCreate
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.collection_service import CollectionService
from apps.tabtinspace.services.tabfiles_service import TabFilesService

User = get_user_model()


class Issue7657CollectionPrivateAclTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = User.objects.db_manager("default").create_user(
            username="i7657-owner",
            email="i7657-owner@test.com",
            password="x",
        )
        self.member = User.objects.db_manager("default").create_user(
            username="i7657-member",
            email="i7657-member@test.com",
            password="x",
        )
        self.org_admin = User.objects.db_manager("default").create_user(
            username="i7657-admin",
            email="i7657-admin@test.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="I7657 Org",
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
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.org_admin,
            role="admin",
        )
        self.owner_svc = CollectionService(user=self.owner)
        self.member_svc = CollectionService(user=self.member)
        self.admin_svc = CollectionService(user=self.org_admin)

    def _make_file_record(self, user) -> FileRecord:
        file_id = uuid4()
        return FileRecord.objects.create(
            id=file_id,
            file_name=f"{file_id}.pdf",
            file_key=f"test/7657/{file_id}/file.pdf",
            file_path=f"test/7657/{file_id}/file.pdf",
            file_size=1,
            file_type="document",
            mime_type="application/pdf",
            file_extension="pdf",
            file_hash="b" * 32,
            bucket_name="test",
            upload_user=str(user.id),
            organization_id=str(self.organization.id),
            status="completed",
        )

    def test_member_and_admin_cannot_list_owner_folders(self):
        root = self.owner_svc.create_collection_for_organization(
            self.organization.id, name="Owner Root",
        )
        self.owner_svc.create_collection_for_organization(
            self.organization.id, name="Owner Child", parent_id=root.id,
        )

        owner_tree = self.owner_svc.list_collections_for_organization(self.organization.id)
        self.assertEqual(len(owner_tree), 1)
        self.assertEqual(owner_tree[0]["name"], "Owner Root")
        self.assertEqual(len(owner_tree[0]["children"]), 1)

        self.assertEqual(
            self.member_svc.list_collections_for_organization(self.organization.id),
            [],
        )
        self.assertEqual(
            self.admin_svc.list_collections_for_organization(self.organization.id),
            [],
        )

    def test_member_cannot_update_or_delete_owner_folder(self):
        coll = self.owner_svc.create_collection_for_organization(
            self.organization.id, name="Before",
        )

        updated = self.member_svc.update_collection(coll.id, name="Hacked")
        self.assertIsNone(updated)
        coll.refresh_from_db()
        self.assertEqual(coll.name, "Before")

        deleted = self.member_svc.delete_collection(coll.id)
        self.assertFalse(deleted)
        self.assertTrue(Collection.objects.filter(id=coll.id).exists())

    def test_member_cannot_reorder_owner_folders(self):
        first = self.owner_svc.create_collection_for_organization(
            self.organization.id, name="A",
        )
        second = self.owner_svc.create_collection_for_organization(
            self.organization.id, name="B",
        )
        ok = self.member_svc.reorder_collections_for_organization(
            self.organization.id, [second.id, first.id],
        )
        self.assertFalse(ok)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertLess(first.order, second.order)

    def test_member_cannot_move_or_upload_into_owner_folder(self):
        target = self.owner_svc.create_collection_for_organization(
            self.organization.id, name="Owner Target",
        )
        item = ContextItem.objects.create(
            organization=self.organization,
            collection=None,
            item_type="tabfiles",
            title="Member File",
            status="active",
            resource_id="member-file-1",
            created_by=self.member,
        )

        with self.assertRaises(ServiceError) as move_ctx:
            self.member_svc.move_items_for_organization(
                self.organization.id, [item.id], target.id,
            )
        self.assertEqual(move_ctx.exception.code, "COLLECTION_NOT_FOUND")
        item.refresh_from_db()
        self.assertIsNone(item.collection_id)

        file_record = self._make_file_record(self.member)
        with self.assertRaises(ServiceError) as upload_ctx:
            TabFilesService(user=self.member).upload_to_organization(
                organization_id=self.organization.id,
                file_record_id=file_record.id,
                collection_id=target.id,
            )
        self.assertEqual(upload_ctx.exception.code, "COLLECTION_NOT_FOUND")

    def test_create_rejects_parent_owned_by_other_member(self):
        parent = self.owner_svc.create_collection_for_organization(
            self.organization.id, name="Owner Parent",
        )
        with self.assertRaises(ServiceError) as ctx:
            self.member_svc.create_collection_for_organization(
                self.organization.id, name="Intruder Child", parent_id=parent.id,
            )
        self.assertEqual(ctx.exception.code, "PARENT_NOT_FOUND")

    def test_different_users_can_create_same_root_name(self):
        owner_folder = self.owner_svc.create_collection_for_organization(
            self.organization.id, name="Docs",
        )
        member_folder = self.member_svc.create_collection_for_organization(
            self.organization.id, name="Docs",
        )
        self.assertIsNotNone(owner_folder)
        self.assertIsNotNone(member_folder)
        self.assertNotEqual(owner_folder.id, member_folder.id)

        owner_tree = self.owner_svc.list_collections_for_organization(self.organization.id)
        member_tree = self.member_svc.list_collections_for_organization(self.organization.id)
        self.assertEqual([n["id"] for n in owner_tree], [owner_folder.id])
        self.assertEqual([n["id"] for n in member_tree], [member_folder.id])

    def test_same_user_root_name_still_unique(self):
        self.owner_svc.create_collection_for_organization(self.organization.id, name="Dup")
        with self.assertRaises(ServiceError) as ctx:
            self.owner_svc.create_collection_for_organization(
                self.organization.id, name="Dup",
            )
        self.assertEqual(ctx.exception.code, "DUPLICATE_NAME")

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Collection.objects.create(
                    organization=self.organization,
                    parent=None,
                    name="Dup",
                    created_by=self.owner,
                )


class Issue7657CollectionWsFanoutTests(SimpleTestCase):
    """org-only Collection 事件只投递创建者 user topic，不写 organization topic。"""

    def test_create_organization_collection_publishes_to_creator_user_topic(self):
        organization_id = uuid4()
        creator_id = uuid4()
        coll = SimpleNamespace(
            id=uuid4(),
            name="Private Folder",
            created_by_id=creator_id,
        )
        request = SimpleNamespace(auth=SimpleNamespace(id=creator_id))

        with (
            patch("apps.tabtinspace.routers.collection.CollectionService") as service_cls,
            patch("apps.tabtinspace.routers.collection._push_collection_ws") as push_ws,
            patch("apps.tabtinspace.schemas.collection.CollectionOut") as out_cls,
        ):
            service_cls.return_value.create_collection_for_organization.return_value = coll
            out_cls.from_orm.return_value.dict.return_value = {
                "id": str(coll.id),
                "name": coll.name,
            }

            status, _payload = create_collection_for_organization(
                request,
                organization_id,
                CollectionCreate(name="Private Folder"),
            )

        self.assertEqual(status, 201)
        push_ws.assert_called_once()
        args, kwargs = push_ws.call_args
        self.assertEqual(args[0], None)
        self.assertEqual(args[1], "collection_created")
        self.assertEqual(args[2], coll)
        self.assertEqual(kwargs.get("organization_id"), str(organization_id))

    def test_push_collection_ws_org_only_uses_user_topic(self):
        from apps.tabtinspace.routers.shared import _push_collection_ws

        organization_id = str(uuid4())
        creator_id = str(uuid4())
        coll = SimpleNamespace(
            id=uuid4(),
            name="Secret",
            created_by_id=creator_id,
        )

        with (
            patch(
                "apps.tabtinspace.services.context_sync_publisher._intersect_org_members",
                side_effect=lambda ids, _org: {str(uid) for uid in ids if uid},
            ),
            patch(
                "apps.tabtinspace.services.context_sync_publisher._schedule_publish"
            ) as schedule,
            patch(
                "apps.services.common.ws.bus.publish_ws_event"
            ) as publish_ws,
        ):
            _push_collection_ws(
                None,
                "collection_created",
                coll,
                organization_id=organization_id,
            )

        publish_ws.assert_not_called()
        schedule.assert_called_once()
        envelope, recipients = schedule.call_args.args
        self.assertEqual(envelope["type"], "collection_created")
        self.assertEqual(envelope["organization_id"], organization_id)
        self.assertEqual(envelope["collection_name"], "Secret")
        self.assertEqual(list(recipients), [creator_id])

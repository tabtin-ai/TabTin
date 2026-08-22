"""云盘统一 shared-feed：游标分页、无跨组织、双文件 ID、消除 N+1。"""
from __future__ import annotations

import json
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from django.http import JsonResponse
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.services.oss.models import FileRecord
from apps.tabdata.models import Table, TablePermission
from apps.tabdata.services.share_service import list_tables_shared_with_me
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services.share_service import list_documents_shared_with_me
from apps.tabtinspace.models import (
    Collection,
    ContextItem,
    FilePermission,
    OrganizationMember,
    SharedResourcePlacement,
)
from apps.tabtinspace.routers.context_item import list_cloud_drive_shared_feed
from apps.tabtinspace.services.collection_service import CollectionService
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.tabfiles_share_service import list_files_shared_with_me
from apps.tabtinspace.services.shared_resource_placement_service import SharedResourcePlacementService
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


def _body(resp):
    if isinstance(resp, JsonResponse):
        return json.loads(resp.content)
    return resp


class CloudDriveSharedFeedTests(TestCase):
    databases = {"default"}

    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.owner = create_test_user(prefix="csf_owner")
        self.member = create_test_user(prefix="csf_member")
        self.outsider = create_test_user(prefix="csf_out")
        self.organization = create_test_organization(owner=self.owner, prefix="csf")
        self.other_org = create_test_organization(owner=self.owner, prefix="csf_other")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.other_org,
            user=self.member,
            role="editor",
        )

        now = timezone.now()
        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            title="Shared Doc",
            description_markdown="d",
            description_plaintext="d",
        )
        self.doc_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title=self.doc.title,
            resource_id=str(self.doc.id),
            created_by=self.owner,
        )
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            name="Shared Table",
        )
        self.table_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdata",
            title=self.table.name,
            resource_id=str(self.table.id),
            created_by=self.owner,
        )
        TablePermission.objects.create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
        )

        self.file_record_id = uuid4()
        FileRecord.objects.create(
            id=self.file_record_id,
            file_name="shared.pdf",
            file_key=f"test/csf/{self.file_record_id}/shared.pdf",
            file_path=f"test/csf/{self.file_record_id}/shared.pdf",
            file_size=10,
            file_type="document",
            mime_type="application/pdf",
            file_extension="pdf",
            file_hash="a" * 32,
            bucket_name="test",
            upload_user=str(self.owner.id),
            organization_id=str(self.organization.id),
            status="completed",
        )
        self.file_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabfiles",
            title="shared.pdf",
            resource_id=str(self.file_record_id),
            created_by=self.owner,
            metadata={"mime_type": "application/pdf", "file_name": "shared.pdf"},
        )
        # auto_now 字段需 queryset.update 才能钉住排序时间
        ContextItem.objects.filter(id=self.doc_item.id).update(
            updated_at=now - timedelta(minutes=3),
        )
        ContextItem.objects.filter(id=self.table_item.id).update(
            updated_at=now - timedelta(minutes=2),
        )
        ContextItem.objects.filter(id=self.file_item.id).update(
            updated_at=now - timedelta(minutes=1),
        )
        self.doc_item.refresh_from_db()
        self.table_item.refresh_from_db()
        self.file_item.refresh_from_db()
        FilePermission.objects.create(
            file_record_id=self.file_record_id,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        # 另一组织同名分享，不得串入本组织 feed
        other_doc = Document.objects.create(
            organization_id=self.other_org.id,
            space_id=None,
            owner_id=self.owner.id,
            title="Other Org Doc",
            description_markdown="x",
            description_plaintext="x",
        )
        ContextItem.objects.create(
            organization_id=self.other_org.id,
            item_type="tabdoc",
            title=other_doc.title,
            resource_id=str(other_doc.id),
            created_by=self.owner,
        )
        DocumentPermission.objects.create(
            document=other_doc,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

    def _feed(self, user, organization_id=None, **query):
        org_id = organization_id or self.organization.id
        request = self.rf.get(
            f"/api/context/organizations/{org_id}/cloud-drive/shared-feed",
            data=query,
        )
        request.auth = user
        return _body(list_cloud_drive_shared_feed(request, org_id))

    def test_unified_feed_includes_three_types_with_shared_by(self) -> None:
        data = self._feed(self.member, item_types="tabdoc,tabdata,tabfiles", limit=30)["data"]
        items = data["items"]
        self.assertEqual(len(items), 3)
        by_type = {i["item_type"]: i for i in items}
        self.assertIn("tabdoc", by_type)
        self.assertIn("tabdata", by_type)
        self.assertIn("tabfiles", by_type)
        self.assertEqual(by_type["tabfiles"]["file_record_id"], str(self.file_record_id))
        self.assertEqual(by_type["tabfiles"]["context_item_id"], str(self.file_item.id))
        self.assertEqual(by_type["tabdoc"]["permission"], "editor")
        self.assertIsNotNone(by_type["tabdoc"]["shared_by"])
        self.assertEqual(by_type["tabdoc"]["shared_by"]["id"], str(self.owner.id))
        self.assertEqual(by_type["tabdoc"]["location"], {"kind": "root"})
        self.assertEqual(by_type["tabdata"]["location"], {"kind": "root"})
        self.assertEqual(by_type["tabfiles"]["location"], {"kind": "root"})

        # capability 与 list/search 同口径（复用 enrich_item_capabilities）
        doc_row = by_type["tabdoc"]
        self.assertTrue(doc_row.get("can_view"))
        self.assertTrue(doc_row.get("can_edit"))  # shared editor
        self.assertFalse(doc_row.get("can_move"))  # move = owner-only
        self.assertFalse(doc_row.get("can_share"))
        self.assertFalse(doc_row.get("can_trash"))
        self.assertFalse(doc_row.get("can_delete"))

        table_row = by_type["tabdata"]
        self.assertTrue(table_row.get("can_view"))
        self.assertFalse(table_row.get("can_edit"))  # shared viewer
        self.assertFalse(table_row.get("can_move"))

        file_row = by_type["tabfiles"]
        self.assertTrue(file_row.get("can_view"))
        self.assertFalse(file_row.get("can_edit"))  # shared viewer
        self.assertFalse(file_row.get("can_move"))
        self.assertFalse(file_row.get("can_share"))
        self.assertFalse(file_row.get("can_trash"))
        self.assertFalse(file_row.get("can_delete"))

    def test_no_cross_organization_leak(self) -> None:
        data = self._feed(self.member, item_types="tabdoc,tabdata,tabfiles")["data"]
        titles = {i["title"] for i in data["items"]}
        self.assertNotIn("Other Org Doc", titles)
        for item in data["items"]:
            self.assertEqual(item["organization_id"], str(self.organization.id))

    def test_cursor_pagination(self) -> None:
        page1 = self._feed(
            self.member,
            item_types="tabdoc,tabdata,tabfiles",
            limit=2,
        )["data"]
        self.assertEqual(len(page1["items"]), 2)
        self.assertIsNotNone(page1["next_cursor"])

        page2 = self._feed(
            self.member,
            item_types="tabdoc,tabdata,tabfiles",
            limit=2,
            cursor=page1["next_cursor"],
        )["data"]
        self.assertEqual(len(page2["items"]), 1)
        ids1 = {i["context_item_id"] for i in page1["items"]}
        ids2 = {i["context_item_id"] for i in page2["items"]}
        self.assertFalse(ids1 & ids2)

    def test_outsider_empty(self) -> None:
        data = self._feed(self.outsider)["data"]
        self.assertEqual(data["items"], [])

    def test_list_files_shared_with_me_batches_context_items(self) -> None:
        with patch(
            "apps.tabtinspace.services.tabfiles_share_service.ContextItem.objects.filter",
            wraps=ContextItem.objects.filter,
        ) as mocked_filter:
            rows = list_files_shared_with_me(
                self.member,
                organization_id=str(self.organization.id),
            )
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["location"], {"kind": "root"})
            # 批量一次 filter，不再 per-perm 查 ContextItem
            self.assertEqual(mocked_filter.call_count, 1)

    def test_legacy_doc_and_table_feeds_include_additive_location(self) -> None:
        docs = list_documents_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )
        tables = list_tables_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )

        self.assertEqual(docs[0]["location"], {"kind": "root"})
        self.assertEqual(tables[0]["location"], {"kind": "root"})

    def test_shared_file_location_does_not_leak_owner_private_folder(self) -> None:
        private_folder = Collection.objects.create(
            organization=self.organization,
            name="Owner Secret Folder",
            created_by=self.owner,
        )
        self.file_item.collection = private_folder
        self.file_item.save(update_fields=["collection"])

        rows = list_files_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )

        self.assertEqual(rows[0]["location"], {"kind": "restricted"})
        self.assertNotIn("Owner Secret Folder", str(rows[0]))

    def test_shared_file_location_returns_visible_nested_path(self) -> None:
        parent = Collection.objects.create(
            organization=self.organization,
            name="项目资料",
            created_by=self.member,
        )
        child = Collection.objects.create(
            organization=self.organization,
            parent=parent,
            name="交付件",
            created_by=self.member,
        )
        self.file_item.collection = child
        self.file_item.save(update_fields=["collection"])

        rows = list_files_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )

        self.assertEqual(
            rows[0]["location"],
            {
                "kind": "folder",
                "path": [
                    {"id": str(parent.id), "name": "项目资料"},
                    {"id": str(child.id), "name": "交付件"},
                ],
            },
        )

    def test_shared_file_location_hides_path_when_any_ancestor_is_restricted(self) -> None:
        private_parent = Collection.objects.create(
            organization=self.organization,
            name="Private Parent",
            created_by=self.owner,
        )
        visible_leaf = Collection.objects.create(
            organization=self.organization,
            parent=private_parent,
            name="Visible Leaf",
            created_by=self.member,
        )
        self.file_item.collection = visible_leaf
        self.file_item.save(update_fields=["collection"])

        rows = list_files_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )

        self.assertEqual(rows[0]["location"], {"kind": "restricted"})
        self.assertNotIn("Private Parent", str(rows[0]))
        self.assertNotIn("Visible Leaf", str(rows[0]))

    def test_shared_file_location_follows_folder_move(self) -> None:
        first = Collection.objects.create(
            organization=self.organization,
            name="第一目录",
            created_by=self.member,
        )
        second = Collection.objects.create(
            organization=self.organization,
            name="第二目录",
            created_by=self.member,
        )
        self.file_item.collection = first
        self.file_item.save(update_fields=["collection"])

        self.file_item.collection = second
        self.file_item.save(update_fields=["collection"])
        moved = list_files_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )
        self.assertEqual(moved[0]["location"]["path"][-1]["name"], "第二目录")

    def test_deleted_folder_removes_shared_resource_from_feed(self) -> None:
        owner_folder = Collection.objects.create(
            organization=self.organization,
            name="待删除目录",
            created_by=self.owner,
        )
        self.file_item.collection = owner_folder
        self.file_item.save(update_fields=["collection"])

        deleted = CollectionService(user=self.owner).delete_collection(owner_folder.id)

        self.assertTrue(deleted)
        self.file_item.refresh_from_db()
        self.assertEqual(self.file_item.status, "trashed")
        self.assertIsNotNone(self.file_item.trashed_at)
        rows = list_files_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )
        self.assertFalse(any(
            row["file_record_id"] == str(self.file_record_id)
            for row in rows
        ))

    def test_shared_file_location_rejects_cross_organization_folder_corruption(self) -> None:
        foreign_folder = Collection.objects.create(
            organization=self.other_org,
            name="Foreign Secret Folder",
            created_by=self.member,
        )
        self.file_item.collection = foreign_folder
        self.file_item.save(update_fields=["collection"])

        rows = list_files_shared_with_me(
            self.member,
            organization_id=str(self.organization.id),
        )

        self.assertEqual(rows[0]["location"], {"kind": "unavailable"})
        self.assertNotIn("Foreign Secret Folder", str(rows[0]))

    def test_shared_editor_cannot_move_owner_item_into_own_folder(self) -> None:
        member_svc = CollectionService(user=self.member)
        member_folder = member_svc.create_collection_for_organization(
            self.organization.id, name="Member Folder",
        )
        with self.assertRaises(ServiceError) as ctx:
            member_svc.move_items_for_organization(
                self.organization.id,
                [self.doc_item.id],
                member_folder.id,
            )
        self.assertEqual(ctx.exception.code, "MOVE_DENIED")
        self.doc_item.refresh_from_db()
        self.assertIsNone(self.doc_item.collection_id)

    def test_shared_editor_can_place_resource_in_own_folder_without_moving_owner_item(self) -> None:
        member_folder = CollectionService(user=self.member).create_collection_for_organization(
            self.organization.id,
            name="Member Folder",
        )

        placement = SharedResourcePlacementService(user=self.member).move(
            self.organization.id,
            'doc',
            self.doc.id,
            member_folder.id,
        )

        self.assertEqual(placement.collection_id, member_folder.id)
        self.doc_item.refresh_from_db()
        self.assertIsNone(self.doc_item.collection_id)
        self.assertEqual(
            SharedResourcePlacement.objects.get(user=self.member).resource_id,
            str(self.doc.id),
        )

from __future__ import annotations

from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.tabdata.models import Table
from apps.tabdoc.models import Document
from apps.tabtinspace.models import ContextItem, OrganizationMember
from apps.tabtinspace.routers.context_item import list_organization_context_items, list_organization_trashed_items
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


class OrganizationContextItemsRouteTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.owner = create_test_user(prefix="ctx_route_owner")
        self.viewer = create_test_user(prefix="ctx_route_viewer")
        self.outsider = create_test_user(prefix="ctx_route_outsider")
        self.organization = create_test_organization(owner=self.owner, prefix="ctx_route")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.viewer,
            role="viewer",
        )

    def _call(self, user, **query):
        request = self.rf.get(
            f"/api/context/organizations/{self.organization.id}/context-items",
            data=query,
        )
        request.auth = user
        return list_organization_context_items(request, self.organization.id)["data"]

    def _call_trash(self, user, **query):
        request = self.rf.get(
            f"/api/context/organizations/{self.organization.id}/trash",
            data=query,
        )
        request.auth = user
        return list_organization_trashed_items(request, self.organization.id)["data"]

    def _create_table_item(self, title: str) -> ContextItem:
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.viewer.id,
            name=title,
        )
        # ：组织云资产独占 organization 宿主，不可同时挂 workspace/project
        return ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdata",
            title=title,
            resource_id=str(table.id),
            is_archived=False,
            created_by=self.viewer,
            updated_by=self.viewer,
        )

    def _create_doc_item(self, title: str) -> ContextItem:
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.viewer.id,
            title=title,
            description_markdown=title,
            description_plaintext=title,
        )
        return ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title=title,
            resource_id=str(doc.id),
            is_archived=False,
            created_by=self.viewer,
            updated_by=self.viewer,
        )

    def test_viewer_can_list_organization_items_without_space_anchor(self) -> None:
        table_item = self._create_table_item("Team Table")

        data = self._call(self.viewer, item_type="tabdata")

        self.assertEqual(data["total"], 1)
        self.assertEqual(str(data["items"][0]["id"]), str(table_item.id))
        self.assertNotIn("space_name", data["items"][0])

    def test_non_organization_member_gets_empty_result(self) -> None:
        self._create_table_item("Hidden Table")

        data = self._call(self.outsider, item_type="tabdata")

        self.assertEqual(data["items"], [])
        self.assertEqual(data["total"], 0)

    def test_paginates_organization_items(self) -> None:
        for idx in range(3):
            self._create_table_item(f"Paged Table {idx}")

        data = self._call(self.viewer, item_type="tabdata", page=2, page_size=1)

        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["total"], 3)
        self.assertEqual(data["page"], 2)
        self.assertEqual(data["page_size"], 1)

    def test_supports_tabdata_and_tabdoc_item_types(self) -> None:
        table_item = self._create_table_item("Supported Table")
        doc_item = self._create_doc_item("Supported Doc")

        table_data = self._call(self.viewer, item_type="tabdata")
        doc_data = self._call(self.viewer, item_type="tabdoc")

        self.assertEqual([str(item["id"]) for item in table_data["items"]], [str(table_item.id)])
        self.assertEqual([str(item["id"]) for item in doc_data["items"]], [str(doc_item.id)])

    def test_organization_items_include_runtime_resource_ids_for_im_cards(self) -> None:
        table_item = self._create_table_item("Shareable Table")
        doc_item = self._create_doc_item("Shareable Doc")

        table_data = self._call(self.viewer, item_type="tabdata")
        doc_data = self._call(self.viewer, item_type="tabdoc")

        table_metadata = table_data["items"][0]["metadata"]
        doc_metadata = doc_data["items"][0]["metadata"]
        self.assertEqual(table_metadata["current_table_id"], table_item.resource_id)
        self.assertEqual(table_metadata["table_id"], table_item.resource_id)
        self.assertEqual(doc_metadata["current_doc_id"], doc_item.resource_id)
        self.assertEqual(doc_metadata["document_id"], doc_item.resource_id)
        self.assertEqual(doc_metadata["doc_id"], doc_item.resource_id)

    def test_illegal_item_type_returns_empty_result_missing_returns_accessible(self) -> None:
        table_item = self._create_table_item("Safe Table")

        illegal_data = self._call(self.viewer, item_type="tabslide")
        missing_data = self._call(self.viewer)

        self.assertEqual(illegal_data["items"], [])
        self.assertEqual(illegal_data["total"], 0)
        # ：未传 item_type 时返回组织内全部可访问云资产
        self.assertEqual(missing_data["total"], 1)
        self.assertEqual(str(missing_data["items"][0]["id"]), str(table_item.id))

    def test_filters_by_collection_id_and_root(self) -> None:
        """#7235：organization context-items 支持按云盘文件夹 / 未入夹过滤。"""
        from apps.tabtinspace.models import Collection

        folder = Collection.objects.create(
            organization=self.organization,
            parent=None,
            name="Folder A",
        )
        in_folder = self._create_table_item("In Folder")
        in_folder.collection_id = folder.id
        in_folder.save(update_fields=["collection_id"])
        unfiled = self._create_table_item("Unfiled")

        folder_data = self._call(
            self.viewer,
            item_type="tabdata",
            collection_id=str(folder.id),
        )
        root_data = self._call(self.viewer, item_type="tabdata", collection_id="root")

        self.assertEqual([str(item["id"]) for item in folder_data["items"]], [str(in_folder.id)])
        self.assertEqual([str(item["id"]) for item in root_data["items"]], [str(unfiled.id)])

    def _trash_item(self, item: ContextItem, by_user) -> ContextItem:
        item.status = "trashed"
        item.trashed_at = timezone.now()
        item.trashed_by = by_user.id
        item.previous_status = "active"
        item.save(update_fields=["status", "trashed_at", "trashed_by", "previous_status"])
        return item

    def test_viewer_can_list_organization_trashed_items(self) -> None:
        table_item = self._trash_item(self._create_table_item("Trashed Team Table"), self.viewer)

        data = self._call_trash(self.viewer, item_type="tabdata")

        self.assertEqual(data["total"], 1)
        self.assertEqual(str(data["items"][0]["id"]), str(table_item.id))
        self.assertNotIn("space_name", data["items"][0])

    def test_only_deleter_sees_trashed_cloud_items(self) -> None:
        """个人回收站：删除者可见；组织 owner / 其他成员均不可见。"""
        table_item = self._trash_item(self._create_table_item("Member Private Table"), self.viewer)
        doc_item = self._trash_item(self._create_doc_item("Member Private Doc"), self.viewer)

        viewer_data = self._call_trash(self.viewer)
        owner_data = self._call_trash(self.owner)

        self.assertEqual(viewer_data["total"], 2)
        self.assertEqual(
            {str(i["id"]) for i in viewer_data["items"]},
            {str(table_item.id), str(doc_item.id)},
        )
        self.assertEqual(owner_data["total"], 0)
        self.assertEqual(owner_data["items"], [])

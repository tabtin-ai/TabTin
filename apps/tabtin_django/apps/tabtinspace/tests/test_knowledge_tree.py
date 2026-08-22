from __future__ import annotations

from uuid import uuid4

from django.test import RequestFactory, TestCase

from apps.tabdata.models import Table
from apps.tabdoc.models import Document
from apps.tabtinspace.models import Collection, ContextItem, Device, SpaceMembership, Workspace
from apps.tabtinspace.routers.context_item import get_organization_knowledge_tree
from apps.tabtinspace.services.knowledge_tree_service import KnowledgeTreeService
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


class KnowledgeTreeServiceTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.user = create_test_user(prefix="knowledge_tree")
        self.organization = create_test_organization(owner=self.user, prefix="knowledge_tree")
        suffix = uuid4().hex[:8]
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name=f"knowledge-tree-device-{suffix}",
            device_type="electron",
            role="control",
            fingerprint=f"knowledge-tree-{suffix}",
            status="online",
        )
        working_dir = f"/tmp/knowledge-tree-{suffix}"
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            created_by=self.user,
            name="Knowledge Tree Workspace",
            working_dir=working_dir,
            normalized_working_dir=working_dir,
        )
        SpaceMembership.objects.get_or_create(
            workspace=self.workspace,
            user=self.user,
            defaults={"role": "owner", "is_active": True},
        )
        self.service = KnowledgeTreeService(user=self.user)

    def _create_doc_item(
        self,
        title: str,
        *,
        collection_id=None,
        parent_item: ContextItem | None = None,
    ) -> tuple[Document, ContextItem]:
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.user.id,
            title=title,
            description_markdown=title,
            description_plaintext=title,
        )
        item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title=title,
            resource_id=str(doc.id),
            collection_id=collection_id,
            parent=parent_item,
            is_archived=False,
            created_by=self.user,
            updated_by=self.user,
        )
        return doc, item

    def _create_table_item(
        self,
        title: str,
        *,
        collection_id=None,
        parent_item: ContextItem | None = None,
    ) -> ContextItem:
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.user.id,
            name=title,
        )
        return ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdata",
            title=title,
            resource_id=str(table.id),
            collection_id=collection_id,
            parent=parent_item,
            is_archived=False,
            created_by=self.user,
            updated_by=self.user,
        )

    def test_build_tree_mounts_child_via_context_item_parent(self) -> None:
        _, parent_item = self._create_doc_item("Parent Doc")
        self._create_doc_item("Child Doc", parent_item=parent_item)

        data = self.service.build_tree(
            organization_id=self.organization.id,
            depth=3,
        )

        root_docs = [node for node in data["roots"] if node["node_type"] == "tabdoc"]
        self.assertEqual(len(root_docs), 1)
        self.assertEqual(root_docs[0]["title"], "Parent Doc")
        self.assertEqual(len(root_docs[0]["children"]), 1)
        self.assertEqual(root_docs[0]["children"][0]["title"], "Child Doc")
        self.assertEqual(data["stats"]["doc_count"], 2)
        self.assertEqual(data["folder_scope"], "none")
        self.assertEqual(data["stats"]["folder_count"], 0)

    def test_collection_folders_do_not_appear_in_knowledge_tree(self) -> None:
        """云盘 Collection 与云文档树平行：夹不得成为知识树节点。"""
        folder = Collection.objects.create(
            organization=self.organization,
            name="Docs",
            icon="📁",
            order=0,
            created_by=self.user,
        )
        self._create_doc_item("In Folder", collection_id=folder.id)
        self._create_table_item("Table In Folder", collection_id=folder.id)

        data = self.service.build_tree(
            organization_id=self.organization.id,
            depth=2,
        )

        folder_nodes = [node for node in data["roots"] if node["node_type"] == "folder"]
        self.assertEqual(folder_nodes, [])
        # collection_id 有值但 parent 为空 → 仍在云文档根
        titles = {node["title"] for node in data["roots"]}
        self.assertEqual(titles, {"In Folder", "Table In Folder"})
        self.assertEqual(data["stats"]["folder_count"], 0)

    def test_list_node_children_for_item_parent(self) -> None:
        _, parent_item = self._create_doc_item("Parent")
        self._create_doc_item("Child", parent_item=parent_item)

        children = self.service.list_node_children(
            organization_id=self.organization.id,
            node_id=parent_item.id,
            node_type="tabdoc",
        )
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]["node_type"], "tabdoc")
        self.assertEqual(children[0]["title"], "Child")

    def test_list_node_children_rejects_folder_type(self) -> None:
        folder = Collection.objects.create(
            organization=self.organization,
            name="Ignored",
            icon="📁",
            order=0,
            created_by=self.user,
        )
        children = self.service.list_node_children(
            organization_id=self.organization.id,
            node_id=folder.id,
            node_type="folder",
        )
        self.assertEqual(children, [])

    def test_list_node_children_for_tabdata_parent(self) -> None:
        parent_item = self._create_table_item("Parent Table")
        self._create_doc_item("Child Under Table", parent_item=parent_item)
        children = self.service.list_node_children(
            organization_id=self.organization.id,
            node_id=parent_item.id,
            node_type="tabdata",
        )
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]["title"], "Child Under Table")

    def test_reorder_siblings_ignores_collection_id(self) -> None:
        """同级重排只认 parent_id；带 collection_id 的资源仍可排序。"""
        folder = Collection.objects.create(
            organization=self.organization,
            name="Drive",
            order=0,
            created_by=self.user,
        )
        _, a = self._create_doc_item("A", collection_id=folder.id)
        _, b = self._create_doc_item("B", collection_id=folder.id)
        a.order = 0
        b.order = 1
        a.save(update_fields=["order"])
        b.save(update_fields=["order"])

        updated = self.service.reorder_siblings(
            organization_id=self.organization.id,
            parent_id=None,
            item_ids=[b.id, a.id],
        )
        self.assertEqual(updated, 2)
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertEqual(b.order, 0)
        self.assertEqual(a.order, 1)
        self.assertEqual(a.collection_id, folder.id)
        self.assertEqual(b.collection_id, folder.id)


class KnowledgeTreeRouteTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.user = create_test_user(prefix="knowledge_tree_route")
        self.organization = create_test_organization(owner=self.user, prefix="knowledge_tree_route")

    def _call(self, user, **query):
        request = self.rf.get(
            f"/api/context/organizations/{self.organization.id}/knowledge-tree",
            data=query,
        )
        request.auth = user
        return get_organization_knowledge_tree(request, self.organization.id)

    def test_returns_tree_payload(self) -> None:
        response = self._call(self.user)
        self.assertIn("data", response)
        data = response["data"]
        self.assertEqual(data["organization_id"], str(self.organization.id))
        self.assertEqual(data["folder_scope"], "none")
        self.assertIn("roots", data)

    def test_children_route_rejects_folder_node_type(self) -> None:
        from apps.tabtinspace.routers.context_item import get_knowledge_tree_node_children

        request = self.rf.get(
            f"/api/context/organizations/{self.organization.id}/knowledge-tree/nodes/x/children",
            data={"node_type": "folder"},
        )
        request.auth = self.user
        response = get_knowledge_tree_node_children(
            request,
            self.organization.id,
            self.organization.id,
        )
        self.assertEqual(response.status_code, 400)

"""真实资源 owner 批量解析：与 ContextItem.created_by 分离。"""

from __future__ import annotations

from django.test import TestCase

from apps.tabdata.models import Table
from apps.tabdoc.models import Document
from apps.tabtinspace.models import ContextItem, OrganizationMember
from apps.tabtinspace.routers.context_item import list_organization_context_items
from apps.tabtinspace.services.resource_owner_resolver import (
    batch_resolve_resource_owner_ids,
    enrich_context_item_owners,
)
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user
from django.test import RequestFactory


class ResourceOwnerResolverTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.owner = create_test_user(prefix="res_owner")
        self.creator = create_test_user(prefix="res_creator")
        self.organization = create_test_organization(owner=self.owner, prefix="res_owner_org")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.creator,
            role="editor",
        )

    def test_batch_resolve_tabdoc_owner_differs_from_created_by(self) -> None:
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            title="Owned Doc",
            description_markdown="x",
            description_plaintext="x",
            created_by=self.creator,
        )
        result = batch_resolve_resource_owner_ids([("tabdoc", str(doc.id))])
        self.assertEqual(result[f"tabdoc:{doc.id}"], str(self.owner.id))

    def test_batch_resolve_tabdata_owner(self) -> None:
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            name="Owned Table",
        )
        result = batch_resolve_resource_owner_ids([("tabdata", str(table.id))])
        self.assertEqual(result[f"tabdata:{table.id}"], str(self.owner.id))

    def test_missing_owner_returns_null_without_creator_fallback(self) -> None:
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=None,
            title="Orphan Doc",
            description_markdown="x",
            description_plaintext="x",
            created_by=self.creator,
        )
        result = batch_resolve_resource_owner_ids([("tabdoc", str(doc.id))])
        self.assertIsNone(result[f"tabdoc:{doc.id}"])

    def test_enrich_keeps_created_by_separate_from_owner(self) -> None:
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            title="Split Semantics",
            description_markdown="x",
            description_plaintext="x",
            created_by=self.creator,
        )
        item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title="Split Semantics",
            resource_id=str(doc.id),
            is_archived=False,
            created_by=self.creator,
            updated_by=self.creator,
        )
        item_data = [{
            "item_type": "tabdoc",
            "resource_id": str(doc.id),
            "created_by_id": str(self.creator.id),
        }]
        enrich_context_item_owners([item], item_data)
        self.assertEqual(item_data[0]["owner_id"], str(self.owner.id))
        self.assertEqual(item_data[0]["owner"]["id"], str(self.owner.id))
        self.assertEqual(item_data[0]["created_by"]["id"], str(self.creator.id))

    def test_organization_route_returns_resource_owner(self) -> None:
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            title="Route Owner",
            description_markdown="x",
            description_plaintext="x",
            created_by=self.creator,
        )
        ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title="Route Owner",
            resource_id=str(doc.id),
            is_archived=False,
            created_by=self.creator,
            updated_by=self.creator,
        )
        request = self.rf.get(
            f"/api/context/organizations/{self.organization.id}/context-items",
            data={"item_type": "tabdoc"},
        )
        # 以资源 owner 身份拉取，避免 ACL 把无 DocumentPermission 的创建者过滤掉
        request.auth = self.owner
        data = list_organization_context_items(request, self.organization.id)["data"]
        self.assertEqual(data["total"], 1)
        row = data["items"][0]
        self.assertEqual(row["owner_id"], str(self.owner.id))
        self.assertEqual(row["owner"]["id"], str(self.owner.id))
        self.assertEqual(row["created_by_id"], str(self.creator.id))
        self.assertEqual(row["created_by"]["id"], str(self.creator.id))

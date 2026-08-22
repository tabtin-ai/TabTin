"""云盘搜索契约：types 白名单、权限与列表一致、回填位置/owner/capability。"""
from __future__ import annotations

import json

from django.http import JsonResponse
from django.test import RequestFactory, TestCase

from apps.tabdata.models import Table
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabtinspace.models import Collection, ContextItem, OrganizationMember
from apps.tabtinspace.routers.context_item import organization_search
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


def _body(resp):
    if isinstance(resp, JsonResponse):
        return json.loads(resp.content)
    return resp


class CloudDriveSearchContractTests(TestCase):
    databases = {"default"}

    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.owner = create_test_user(prefix="cds_owner")
        self.collaborator = create_test_user(prefix="cds_collab")
        self.outsider = create_test_user(prefix="cds_out")
        self.organization = create_test_organization(owner=self.owner, prefix="cds")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.collaborator,
            role="editor",
        )
        self.folder = Collection.objects.create(
            organization=self.organization,
            parent=None,
            name="Search Folder",
            created_by=self.owner,
        )

        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            title="Alpha Shared Doc",
            description_markdown="alpha",
            description_plaintext="alpha",
        )
        self.doc_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdoc",
            title=self.doc.title,
            resource_id=str(self.doc.id),
            collection=self.folder,
            created_by=self.owner,
        )
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.collaborator.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        self.private_table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=self.owner.id,
            name="Alpha Private Table",
        )
        self.private_table_item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdata",
            title=self.private_table.name,
            resource_id=str(self.private_table.id),
            created_by=self.owner,
        )

    def _search(self, user, **query):
        request = self.rf.get(
            f"/api/context/organizations/{self.organization.id}/search",
            data=query,
        )
        request.auth = user
        return _body(organization_search(request, self.organization.id))

    def test_type_and_types_mutual_exclusion(self) -> None:
        resp = self._search(
            self.owner,
            q="Alpha",
            type="tabdoc",
            types="tabdoc,tabdata",
        )
        self.assertEqual(resp["code"], "VALIDATION_ERROR")

    def test_types_whitelist_and_enrichment(self) -> None:
        data = self._search(
            self.owner,
            q="Alpha",
            types="tabdoc,tabdata,tabfiles",
            page_size=30,
        )["data"]
        ids = {str(i["id"]) for i in data["items"]}
        self.assertIn(str(self.doc_item.id), ids)
        self.assertIn(str(self.private_table_item.id), ids)

        doc_row = next(i for i in data["items"] if str(i["id"]) == str(self.doc_item.id))
        self.assertEqual(str(doc_row.get("collection_id")), str(self.folder.id))
        self.assertTrue(doc_row.get("can_view"))
        self.assertTrue(doc_row.get("can_move"))  # owner
        self.assertIsNotNone(doc_row.get("owner") or doc_row.get("owner_id") or doc_row.get("created_by"))

    def test_search_respects_acl_like_list(self) -> None:
        collab_data = self._search(
            self.collaborator,
            q="Alpha",
            types="tabdoc,tabdata,tabfiles",
        )["data"]
        collab_ids = {str(i["id"]) for i in collab_data["items"]}
        self.assertIn(str(self.doc_item.id), collab_ids)
        self.assertNotIn(str(self.private_table_item.id), collab_ids)

        collab_row = next(
            i for i in collab_data["items"] if str(i["id"]) == str(self.doc_item.id)
        )
        self.assertTrue(collab_row.get("can_view"))
        self.assertFalse(collab_row.get("can_move"))  # shared viewer，非 owner

        outsider_data = self._search(
            self.outsider,
            q="Alpha",
            types="tabdoc,tabdata,tabfiles",
        )["data"]
        self.assertEqual(outsider_data["items"], [])

    def test_legacy_type_param_still_works(self) -> None:
        data = self._search(self.owner, q="Alpha", type="tabdoc")["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(str(data["items"][0]["id"]), str(self.doc_item.id))

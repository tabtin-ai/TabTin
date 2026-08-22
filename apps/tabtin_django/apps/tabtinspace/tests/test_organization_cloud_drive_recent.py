"""云盘最近访问：item_types 白名单 + visited_only 按用户 ResourceAccess 排序分页。"""
from __future__ import annotations

import json
from datetime import timedelta

from django.http import JsonResponse
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.tabdata.models import Table
from apps.tabdoc.models import Document
from apps.tabtinspace.models import ContextItem, OrganizationMember, ResourceAccess
from apps.tabtinspace.routers.context_item import list_organization_context_items
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


def _body(resp):
    if isinstance(resp, JsonResponse):
        return json.loads(resp.content)
    return resp


class OrganizationCloudDriveRecentTests(TestCase):
    databases = {"default"}

    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.owner = create_test_user(prefix="cdr_owner")
        self.viewer = create_test_user(prefix="cdr_viewer")
        self.outsider = create_test_user(prefix="cdr_outsider")
        self.organization = create_test_organization(owner=self.owner, prefix="cdr")
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
        return _body(list_organization_context_items(request, self.organization.id))

    def _create_doc(self, title: str, *, owner=None) -> ContextItem:
        owner = owner or self.owner
        doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=owner.id,
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
            created_by=owner,
            updated_by=owner,
        )

    def _create_table(self, title: str, *, owner=None) -> ContextItem:
        owner = owner or self.owner
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=owner.id,
            name=title,
        )
        return ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabdata",
            title=title,
            resource_id=str(table.id),
            is_archived=False,
            created_by=owner,
            updated_by=owner,
        )

    def test_item_types_and_item_type_mutual_exclusion(self) -> None:
        resp = self._call(
            self.owner,
            item_type="tabdoc",
            item_types="tabdoc,tabdata",
        )
        self.assertEqual(resp["code"], "VALIDATION_ERROR")

    def test_item_types_filters_before_pagination(self) -> None:
        docs = [self._create_doc(f"Doc {i}") for i in range(3)]
        tables = [self._create_table(f"Table {i}") for i in range(3)]
        # 非云盘类型不应混入云盘白名单页
        ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabslide",
            title="Slide",
            resource_id="slide-1",
            created_by=self.owner,
        )

        data = self._call(
            self.owner,
            item_types="tabdoc,tabdata,tabfiles",
            page=1,
            page_size=4,
        )["data"]
        self.assertEqual(data["total"], 6)
        self.assertEqual(len(data["items"]), 4)
        returned_types = {item["item_type"] for item in data["items"]}
        self.assertTrue(returned_types <= {"tabdoc", "tabdata", "tabfiles"})
        self.assertNotIn("tabslide", returned_types)

        only_docs = self._call(
            self.owner,
            item_types="tabdoc",
            page_size=50,
        )["data"]
        self.assertEqual(only_docs["total"], 3)
        self.assertEqual(
            {str(i["id"]) for i in only_docs["items"]},
            {str(d.id) for d in docs},
        )
        self.assertTrue(all(i["item_type"] == "tabdoc" for i in only_docs["items"]))
        _ = tables  # 表格被类型过滤排除

    def test_visited_only_sorts_by_current_user_access(self) -> None:
        older = self._create_doc("Older Visit")
        newer = self._create_doc("Newer Visit")
        never = self._create_doc("Never Visited")
        now = timezone.now()
        ResourceAccess.objects.create(
            user=self.owner,
            context_item=older,
            last_visited_at=now - timedelta(hours=2),
        )
        ResourceAccess.objects.create(
            user=self.owner,
            context_item=newer,
            last_visited_at=now - timedelta(minutes=5),
        )
        # 另一用户访问 never，不应影响 owner 的最近
        ResourceAccess.objects.create(
            user=self.viewer,
            context_item=never,
            last_visited_at=now,
        )

        data = self._call(
            self.owner,
            item_types="tabdoc,tabdata,tabfiles",
            visited_only="true",
            sort="-last_visited_at",
            page_size=50,
        )["data"]
        ids = [str(i["id"]) for i in data["items"]]
        self.assertEqual(ids, [str(newer.id), str(older.id)])
        self.assertNotIn(str(never.id), ids)

        viewer_data = self._call(
            self.viewer,
            item_types="tabdoc,tabdata,tabfiles",
            visited_only="true",
            sort="-last_visited_at",
        )["data"]
        # viewer 不是资源 owner，可见性为空（未分享）
        self.assertEqual(viewer_data["total"], 0)

    def test_visited_only_pagination_is_stable(self) -> None:
        items = [self._create_doc(f"V{i}") for i in range(5)]
        base = timezone.now()
        for idx, item in enumerate(items):
            ResourceAccess.objects.create(
                user=self.owner,
                context_item=item,
                last_visited_at=base - timedelta(minutes=idx),
            )

        page1 = self._call(
            self.owner,
            item_types="tabdoc",
            visited_only="true",
            sort="-last_visited_at",
            page=1,
            page_size=2,
        )["data"]
        page2 = self._call(
            self.owner,
            item_types="tabdoc",
            visited_only="true",
            sort="-last_visited_at",
            page=2,
            page_size=2,
        )["data"]
        self.assertEqual(page1["total"], 5)
        self.assertEqual(
            [str(i["id"]) for i in page1["items"]],
            [str(items[0].id), str(items[1].id)],
        )
        self.assertEqual(
            [str(i["id"]) for i in page2["items"]],
            [str(items[2].id), str(items[3].id)],
        )

    def test_outsider_sees_empty(self) -> None:
        self._create_doc("Hidden")
        data = self._call(
            self.outsider,
            item_types="tabdoc,tabdata,tabfiles",
        )["data"]
        self.assertEqual(data["total"], 0)
        self.assertEqual(data["items"], [])

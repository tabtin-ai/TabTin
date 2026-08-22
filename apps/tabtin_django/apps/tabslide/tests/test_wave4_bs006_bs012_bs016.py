"""
Wave 4 回归测试：BS-006 / BS-012 / BS-016

BS-006: admin_api.py ORM 查询补全 .using("postgresql")
BS-012: V2 sort order 改用 bulk_update（性能回归）
BS-016: diff 链回溯深度限制（MAX_DIFF_CHAIN_DEPTH）
"""

from __future__ import annotations

import json
import uuid
import zlib
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabslide import admin_api
from apps.tabslide.models import (
    SlideChange,
    SlideHistory,
    SlidePage,
    SlideProject,
)
from apps.tabslide.services.slide_service import MAX_DIFF_CHAIN_DEPTH, SlideService
from apps.tabtinspace.models import Space, Organization

User = get_user_model()


class BS006AdminApiPostgresqlRoutingTests(TestCase):
    """BS-006: admin_api.py detail 端点的 4 处查询必须走 postgresql。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.staff = User.objects.create_user(
            username="bs006_staff", email="bs006_staff@test.com",
            password="pass123", is_staff=True,
        )
        self.organization = Organization.objects.create(name="ws-bs006", owner=self.staff)
        self.space = Space.objects.create(organization=self.organization, name="sp-bs006")
        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="BS006 演示",
            preset="ppt",
            page_count=2,
            latest_version=3,
            status="active",
        )
        SlidePage.objects.using("postgresql").create(
            project=self.project, page_id="p1",
            elements_data=[], order=0, version=3,
        )
        SlidePage.objects.using("postgresql").create(
            project=self.project, page_id="p2",
            elements_data=[], order=1, version=3,
        )
        blob = zlib.compress(json.dumps([]).encode())
        SlideHistory.objects.using("postgresql").create(
            project=self.project, organization_id=self.organization.id,
            version=1, blob=blob, page_count=2,
        )
        SlideChange.objects.using("postgresql").create(
            project=self.project,
            version=2, change_type="save_pages", summary="test change",
        )

    def test_admin_detail_returns_pages_and_histories_from_postgresql(self):
        """修复前这 4 处查询走 default(MySQL)，结果全为空。"""
        request = SimpleNamespace(auth=self.staff)
        result = admin_api.admin_get_slide_detail(request, str(self.project.id))

        self.assertEqual(len(result["pages"]), 2)
        self.assertGreaterEqual(len(result["recent_histories"]), 1)
        self.assertGreaterEqual(len(result["recent_changes"]), 1)
        self.assertGreaterEqual(result["stats"]["named_history_count"], 0)


class BS012BulkUpdateSortOrderTests(TestCase):
    """BS-012: V2 save_pages_incremental 排序应使用 bulk_update。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="bs012_user", email="bs012_user@test.com", password="pass123",
        )
        self.organization = Organization.objects.create(name="ws-bs012", owner=self.user)
        self.space = Space.objects.create(organization=self.organization, name="sp-bs012")
        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="BS012 排序测试",
            preset="ppt",
            page_count=5,
            latest_version=1,
            status="active",
        )
        self.page_ids = [f"page-{i}" for i in range(5)]
        for i, pid in enumerate(self.page_ids):
            SlidePage.objects.using("postgresql").create(
                project=self.project, page_id=pid,
                elements_data=[], order=float(i), version=1,
            )

    @patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc")
    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_reorder_pages_applies_correct_order_via_bulk_update(self, mock_hooks, mock_ydoc):
        """验证 bulk_update 后每页 order 正确（原来用 N 次独立 UPDATE）。"""
        from apps.tabtinspace.models import Agent, SpaceMembership
        agent, _ = Agent.objects.get_or_create(
            organization=self.organization, user=self.user,
            defaults={"name": "bs012", "type": "human", "is_active": True},
        )
        SpaceMembership.objects.get_or_create(
            workspace=self.space, agent=agent,
            defaults={"role": "editor"},
        )

        reversed_order = list(reversed(self.page_ids))
        svc = SlideService(user=self.user)
        svc.save_pages_incremental(
            slide_project_id=str(self.project.id),
            base_version=1,
            changed_pages={},
            deleted_page_ids=[],
            page_order=reversed_order,
        )

        pages = list(
            SlidePage.objects.using("postgresql")
            .filter(project=self.project)
            .order_by("order")
        )
        actual_order = [p.page_id for p in pages]
        self.assertEqual(actual_order, reversed_order)

    @patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc")
    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_reorder_reduces_query_count(self, mock_hooks, mock_ydoc):
        """验证 bulk_update 方式的查询数远少于 N 条独立 UPDATE。"""
        from apps.tabtinspace.models import Agent, SpaceMembership
        agent, _ = Agent.objects.get_or_create(
            organization=self.organization, user=self.user,
            defaults={"name": "bs012q", "type": "human", "is_active": True},
        )
        SpaceMembership.objects.get_or_create(
            workspace=self.space, agent=agent,
            defaults={"role": "editor"},
        )

        reversed_order = list(reversed(self.page_ids))
        svc = SlideService(user=self.user)

        from django.test.utils import CaptureQueriesContext
        from django.db import connections
        conn = connections["postgresql"]

        with CaptureQueriesContext(conn) as ctx:
            svc.save_pages_incremental(
                slide_project_id=str(self.project.id),
                base_version=1,
                changed_pages={},
                deleted_page_ids=[],
                page_order=reversed_order,
            )

        update_queries = [q for q in ctx.captured_queries if "UPDATE" in q["sql"].upper() and "tabslide_page" in q["sql"]]
        self.assertLessEqual(len(update_queries), 2,
            f"排序 5 页应产生 ≤2 条 UPDATE（bulk），实际 {len(update_queries)} 条")


class BS016DiffChainDepthLimitTests(TestCase):
    """BS-016: diff 链回溯超过 MAX_DIFF_CHAIN_DEPTH 时应中断。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="bs016_user", email="bs016_user@test.com", password="pass123",
        )
        self.organization = Organization.objects.create(name="ws-bs016", owner=self.user)
        self.space = Space.objects.create(organization=self.organization, name="sp-bs016")
        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="BS016 深度测试",
            preset="ppt",
            page_count=1,
            latest_version=1,
            status="active",
        )

    def test_restore_raises_on_chain_exceeding_max_depth(self):
        """构造超过 MAX_DIFF_CHAIN_DEPTH 的 diff 链，验证抛出 ValueError。"""
        depth = MAX_DIFF_CHAIN_DEPTH + 5
        diff_blob = zlib.compress(json.dumps({"added": {}, "removed": [], "modified": {}}).encode())

        histories = []
        for i in range(depth + 1):
            h = SlideHistory.objects.using("postgresql").create(
                project=self.project,
                organization_id=self.organization.id,
                version=i + 1,
                blob=diff_blob,
                page_count=1,
                is_snapshot=False,
                base_history=histories[-1] if histories else None,
            )
            histories.append(h)

        tail = histories[-1]
        with self.assertRaises(ValueError) as ctx:
            SlideService.restore_history_data(tail)
        self.assertIn("chain_too_deep", str(ctx.exception))

    def test_restore_succeeds_within_max_depth(self):
        """构造恰好 MAX_DIFF_CHAIN_DEPTH 以内的 diff 链（含锚点），验证正常恢复。"""
        base_pages = [{"id": "p1", "elements": [{"type": "text", "content": "base"}]}]
        anchor_blob = zlib.compress(json.dumps(base_pages).encode())
        anchor = SlideHistory.objects.using("postgresql").create(
            project=self.project,
            organization_id=self.organization.id,
            version=1,
            blob=anchor_blob,
            page_count=1,
            is_snapshot=True,
        )

        diff_data = {"added": {}, "removed": [], "modified": {}}
        diff_blob = zlib.compress(json.dumps(diff_data).encode())

        prev = anchor
        tail = None
        chain_len = 5
        for i in range(chain_len):
            h = SlideHistory.objects.using("postgresql").create(
                project=self.project,
                organization_id=self.organization.id,
                version=i + 2,
                blob=diff_blob,
                page_count=1,
                is_snapshot=False,
                base_history=prev,
            )
            prev = h
            tail = h

        pages, meta = SlideService.restore_history_data(tail)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["id"], "p1")

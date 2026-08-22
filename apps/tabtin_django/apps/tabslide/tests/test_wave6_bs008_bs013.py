"""
Wave 6 回归测试：BS-008 / BS-013

BS-008: list_projects 分页（limit/offset）
BS-013: V2 save_pages_incremental 批量 upsert（替代逐条 update_or_create）
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import connections
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from apps.tabslide import api as slide_api
from apps.tabslide.models import SlidePage, SlideProject
from apps.tabslide.services.slide_service import SlideService
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization

User = get_user_model()


def _setup_membership(organization, space, user):
    agent, _ = Agent.objects.get_or_create(
        organization=organization, user=user,
        defaults={"name": "test-agent", "type": "human", "is_active": True},
    )
    SpaceMembership.objects.get_or_create(
        workspace=space, agent=agent,
        defaults={"role": "editor"},
    )


# ============================================================================
# BS-008: list_projects 分页
# ============================================================================


class BS008ListProjectsPaginationTests(TestCase):
    """BS-008: list_projects 应支持 limit/offset 分页并返回 total。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="bs008_user", email="bs008@test.com", password="pass123",
        )
        self.organization = Organization.objects.create(name="ws-bs008", owner=self.user)
        self.space = Space.objects.create(organization=self.organization, name="sp-bs008")
        _setup_membership(self.organization, self.space, self.user)

        self.projects = []
        for i in range(8):
            p = SlideProject.objects.create(
                organization_id=self.organization.id,
                space_id=self.space.id,
                name=f"BS008 项目 {i}",
                preset="ppt",
                page_count=1,
                latest_version=1,
                status="active",
            )
            self.projects.append(p)

    def test_default_limit_returns_all_when_under_50(self):
        """项目总数 < 默认 limit=50 时应全部返回。"""
        svc = SlideService(user=self.user)
        projects, total = svc.list_projects(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
        )
        self.assertEqual(total, 8)
        self.assertEqual(len(projects), 8)

    def test_limit_caps_result_count(self):
        """limit=3 应只返回 3 条，但 total 仍为 8。"""
        svc = SlideService(user=self.user)
        projects, total = svc.list_projects(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            limit=3,
        )
        self.assertEqual(total, 8)
        self.assertEqual(len(projects), 3)

    def test_offset_skips_projects(self):
        """offset=5 应跳过前 5 条，返回后 3 条。"""
        svc = SlideService(user=self.user)
        projects, total = svc.list_projects(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            offset=5,
        )
        self.assertEqual(total, 8)
        self.assertEqual(len(projects), 3)

    def test_limit_clamped_to_100(self):
        """limit 超过 100 应被截断到 100。"""
        svc = SlideService(user=self.user)
        projects, total = svc.list_projects(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            limit=999,
        )
        self.assertEqual(total, 8)
        self.assertEqual(len(projects), 8)

    def test_negative_offset_clamped_to_zero(self):
        """负数 offset 应被截断到 0。"""
        svc = SlideService(user=self.user)
        projects, total = svc.list_projects(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            offset=-5,
        )
        self.assertEqual(total, 8)
        self.assertEqual(len(projects), 8)

    def test_api_layer_returns_pagination_fields(self):
        """API 层响应应包含 total / limit / offset 字段。"""
        request = SimpleNamespace(auth=self.user)

        @patch("apps.tabslide.api.ensure_space_in_organization")
        def _call(mock_ensure):
            return slide_api.list_projects(
                request,
                organization_id=str(self.organization.id),
                space_id=str(self.space.id),
                limit=3,
                offset=2,
            )

        resp = _call()
        data = resp["data"]
        self.assertEqual(data["total"], 8)
        self.assertEqual(data["limit"], 3)
        self.assertEqual(data["offset"], 2)
        self.assertEqual(len(data["projects"]), 3)


# ============================================================================
# BS-013: V2 save 批量 upsert
# ============================================================================


class BS013BulkUpsertChangedPagesTests(TestCase):
    """BS-013: V2 save_pages_incremental 应批量 upsert，不逐条 update_or_create。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="bs013_user", email="bs013@test.com", password="pass123",
        )
        self.organization = Organization.objects.create(name="ws-bs013", owner=self.user)
        self.space = Space.objects.create(organization=self.organization, name="sp-bs013")
        _setup_membership(self.organization, self.space, self.user)

        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="BS013 批量 upsert 测试",
            preset="ppt",
            page_count=3,
            latest_version=1,
            status="active",
        )
        for i in range(3):
            SlidePage.objects.using("postgresql").create(
                project=self.project, page_id=f"pg-{i}",
                elements_data=[{"type": "text", "content": f"original-{i}"}],
                order=float(i), version=1,
            )

    @patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc")
    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_update_existing_pages_preserves_data(self, mock_hooks, mock_ydoc):
        """更新已有页面后 elements_data 应正确持久化。"""
        svc = SlideService(user=self.user)
        svc.save_pages_incremental(
            slide_project_id=str(self.project.id),
            base_version=1,
            changed_pages={
                "pg-0": {"elements": [{"type": "text", "content": "updated-0"}]},
                "pg-2": {"elements": [{"type": "image", "src": "https://example.com/img.png"}]},
            },
        )

        pg0 = SlidePage.objects.using("postgresql").get(project=self.project, page_id="pg-0")
        pg1 = SlidePage.objects.using("postgresql").get(project=self.project, page_id="pg-1")
        pg2 = SlidePage.objects.using("postgresql").get(project=self.project, page_id="pg-2")

        self.assertEqual(pg0.elements_data[0]["content"], "updated-0")
        self.assertEqual(pg1.elements_data[0]["content"], "original-1")
        self.assertEqual(pg2.elements_data[0]["type"], "image")
        self.assertEqual(pg0.version, 2)
        self.assertEqual(pg1.version, 1)

    @patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc")
    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_create_new_pages_via_upsert(self, mock_hooks, mock_ydoc):
        """changed_pages 含不存在的 page_id 时应自动创建。"""
        svc = SlideService(user=self.user)
        svc.save_pages_incremental(
            slide_project_id=str(self.project.id),
            base_version=1,
            changed_pages={
                "new-page-1": {"elements": [{"type": "text", "content": "brand new"}]},
            },
        )

        new_page = SlidePage.objects.using("postgresql").get(
            project=self.project, page_id="new-page-1",
        )
        self.assertEqual(new_page.elements_data[0]["content"], "brand new")
        self.assertEqual(new_page.version, 2)

    @patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc")
    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_mixed_create_and_update(self, mock_hooks, mock_ydoc):
        """同时更新已有页面和新建页面应全部成功。"""
        svc = SlideService(user=self.user)
        svc.save_pages_incremental(
            slide_project_id=str(self.project.id),
            base_version=1,
            changed_pages={
                "pg-1": {"elements": [{"type": "text", "content": "mixed-update"}]},
                "brand-new": {"elements": [{"type": "shape", "shape": "rect"}]},
            },
        )

        total = SlidePage.objects.using("postgresql").filter(project=self.project).count()
        self.assertEqual(total, 4)

        updated = SlidePage.objects.using("postgresql").get(project=self.project, page_id="pg-1")
        self.assertEqual(updated.elements_data[0]["content"], "mixed-update")

        created = SlidePage.objects.using("postgresql").get(project=self.project, page_id="brand-new")
        self.assertEqual(created.elements_data[0]["shape"], "rect")

    @patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc")
    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_bulk_upsert_query_count(self, mock_hooks, mock_ydoc):
        """10 个变更页应产生远少于 10 条 INSERT/UPDATE（批量）。"""
        for i in range(3, 10):
            SlidePage.objects.using("postgresql").create(
                project=self.project, page_id=f"pg-{i}",
                elements_data=[], order=float(i), version=1,
            )
        self.project.page_count = 10
        self.project.save(update_fields=["page_count"])

        svc = SlideService(user=self.user)
        changed = {
            f"pg-{i}": {"elements": [{"type": "text", "content": f"bulk-{i}"}]}
            for i in range(10)
        }

        conn = connections["postgresql"]
        with CaptureQueriesContext(conn) as ctx:
            svc.save_pages_incremental(
                slide_project_id=str(self.project.id),
                base_version=1,
                changed_pages=changed,
            )

        write_queries = [
            q for q in ctx.captured_queries
            if ("INSERT" in q["sql"].upper() or "UPDATE" in q["sql"].upper())
            and "tabslide_page" in q["sql"].lower()
        ]
        self.assertLessEqual(
            len(write_queries), 3,
            f"10 页批量 upsert 应 ≤3 条写操作（SELECT existing + bulk_create），实际 {len(write_queries)} 条"
        )

    @patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc")
    @patch("apps.tabslide.post_save.run_post_save_hooks")
    def test_partial_update_preserves_unspecified_fields(self, mock_hooks, mock_ydoc):
        """只更新 background 时 elements_data 不应被清空。"""
        svc = SlideService(user=self.user)
        svc.save_pages_incremental(
            slide_project_id=str(self.project.id),
            base_version=1,
            changed_pages={
                "pg-0": {"background": {"type": "solid", "color": "#ff0000"}},
            },
        )

        pg0 = SlidePage.objects.using("postgresql").get(project=self.project, page_id="pg-0")
        self.assertEqual(pg0.background["color"], "#ff0000")
        self.assertEqual(pg0.elements_data[0]["content"], "original-0",
                         "部分更新不应覆盖未传入的 elements_data")

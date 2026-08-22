from __future__ import annotations

import uuid
from types import SimpleNamespace

from django.test import TestCase

from apps.tabslide.models import SlideProject
from apps.tabtinspace import content_admin_api


class ContentAdminOverviewApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.organization_id = uuid.uuid4()
        self.space_id = uuid.uuid4()
        self.request = SimpleNamespace(
            auth=SimpleNamespace(is_staff=True, is_superuser=False),
        )

        SlideProject.objects.create(
            organization_id=self.organization_id,
            space_id=self.space_id,
            name="季度汇报",
            preset="ppt",
            page_count=8,
            latest_version=3,
            status="active",
            pptx_dirty=True,
        )

    def test_admin_content_overview_returns_aggregated_module_summary(self):
        response = content_admin_api.admin_content_overview(self.request)

        self.assertEqual(response["slides"]["dirty_projects"], 1)
        self.assertNotIn("designs", response)
        self.assertNotIn("mail", response)
        self.assertEqual(response["totals"]["managed_resources"], 1)
        self.assertEqual(response["totals"]["pending_attention"], 1)

    def test_admin_content_overview_organization_section_contract(self):
        """锁定团队/Space 区块的字段契约。

        AdminDash 前端（apps/admindash/src/content-ops/）按 organizations /
        total_organizations / total_spaces / trashed_spaces 读字段。如果后端
        改名（之前曾错叫 workspaces / total_workspaces），整个 /content
        页会在 useMemo 里因 undefined 访问崩溃。这条断言把契约钉死。
        """
        response = content_admin_api.admin_content_overview(self.request)

        self.assertIn("organizations", response)
        organizations = response["organizations"]
        self.assertIn("total_organizations", organizations)
        self.assertIn("total_spaces", organizations)
        self.assertIn("trashed_spaces", organizations)
        self.assertGreaterEqual(organizations["total_organizations"], 0)
        self.assertGreaterEqual(organizations["total_spaces"], 0)

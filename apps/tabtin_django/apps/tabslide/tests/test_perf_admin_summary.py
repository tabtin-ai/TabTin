"""
PERF-007 回归测试：admin_list_slides summary 使用单次 aggregate 而非多次独立 COUNT
"""
from __future__ import annotations

from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.tabslide import admin_api
from apps.tabslide.models import SlideProject
from apps.tabtinspace.models import Space, Organization


class SlideAdminSummaryAggregateTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        User = get_user_model()
        self.staff_user = User.objects.create_user(
            username="perf007_staff",
            email="perf007_staff@test.com",
            password="pass123",
            is_staff=True,
        )
        self.superuser = User.objects.create_superuser(
            username="perf007_super",
            email="perf007_super@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(name="幻灯片性能测试", owner=self.superuser)
        self.space = Space.objects.create(organization=self.organization, name="性能空间")
        ws_id, sp_id = self.organization.id, self.space.id

        self.active_clean = SlideProject.objects.create(
            organization_id=ws_id, space_id=sp_id, name="活跃干净",
            preset="ppt", page_count=5, latest_version=1, status="active", pptx_dirty=False,
        )
        self.active_dirty = SlideProject.objects.create(
            organization_id=ws_id, space_id=sp_id, name="活跃脏",
            preset="ppt", page_count=3, latest_version=2, status="active", pptx_dirty=True,
        )
        self.archived_project = SlideProject.objects.create(
            organization_id=ws_id, space_id=sp_id, name="归档",
            preset="ppt", page_count=2, latest_version=4, status="archived", pptx_dirty=False,
        )
        self.trashed_project = SlideProject.objects.create(
            organization_id=ws_id, space_id=sp_id, name="回收站",
            preset="ppt", page_count=1, latest_version=1, status="active",
            pptx_dirty=False, trashed_at=timezone.now(),
        )

    def test_summary_all_fields_correct(self):
        """验证单次 aggregate 产出的所有 summary 字段值正确"""
        request = SimpleNamespace(auth=self.staff_user)

        response = admin_api.admin_list_slides(request, page=1, page_size=50)

        s = response["summary"]
        self.assertEqual(s["total_projects"], 4)
        self.assertEqual(s["active_projects"], 2)
        self.assertEqual(s["archived_projects"], 1)
        self.assertEqual(s["trashed_projects"], 1)
        self.assertEqual(s["dirty_projects"], 1)
        self.assertEqual(s["total_pages"], 5 + 3 + 2 + 1)

    def test_summary_dirty_count_updates_on_change(self):
        """验证修改 pptx_dirty 后 summary 反映变化"""
        self.active_clean.pptx_dirty = True
        self.active_clean.save(update_fields=["pptx_dirty"])

        request = SimpleNamespace(auth=self.staff_user)
        response = admin_api.admin_list_slides(request, page=1, page_size=50)

        self.assertEqual(response["summary"]["dirty_projects"], 2)

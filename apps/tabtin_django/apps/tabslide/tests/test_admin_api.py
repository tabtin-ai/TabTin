from __future__ import annotations

import uuid
from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.test import TestCase
from ninja.errors import HttpError

from apps.tabslide import admin_api
from apps.tabslide.models import SlideAdminActionLog, SlideProject
from apps.tabtinspace.models import Space, Organization


class SlideAdminApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        user_model = get_user_model()
        self.staff_user = user_model.objects.create_user(
            username="slide_staff",
            email="slide_staff@test.com",
            password="pass123",
            is_staff=True,
        )
        self.superuser = user_model.objects.create_superuser(
            username="slide_superuser",
            email="slide_superuser@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="运营组织",
            owner=self.superuser,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="内容运营空间",
        )
        self.organization_id = self.organization.id
        self.space_id = self.space.id

        self.project = SlideProject.objects.create(
            organization_id=self.organization_id,
            space_id=self.space_id,
            name="运营演示",
            preset="ppt",
            page_count=6,
            latest_version=12,
            status="active",
            pptx_dirty=False,
        )
        self.dirty_project = SlideProject.objects.create(
            organization_id=self.organization_id,
            space_id=self.space_id,
            name="待导出演示",
            preset="ppt",
            page_count=4,
            latest_version=3,
            status="active",
            pptx_dirty=True,
        )

    def test_admin_list_slides_returns_summary_and_items(self):
        request = SimpleNamespace(auth=self.staff_user)

        response = admin_api.admin_list_slides(request, keyword="运营", page=1, page_size=10)

        self.assertEqual(response["summary"]["total_projects"], 1)
        self.assertEqual(len(response["items"]), 1)
        self.assertEqual(response["items"][0]["id"], str(self.project.id))

    def test_admin_archive_slide_requires_superuser(self):
        request = SimpleNamespace(auth=self.staff_user)

        with self.assertRaises(HttpError):
            admin_api.admin_archive_slide(request, str(self.project.id))

    def test_admin_list_slides_can_filter_dirty_attention(self):
        request = SimpleNamespace(auth=self.staff_user)

        response = admin_api.admin_list_slides(request, attention="dirty", page=1, page_size=10)

        self.assertEqual(response["summary"]["total_projects"], 1)
        self.assertEqual(response["items"][0]["id"], str(self.dirty_project.id))

    def test_admin_batch_archive_slides_updates_and_skips(self):
        self.dirty_project.status = "archived"
        self.dirty_project.save(update_fields=["status", "updated_at"])
        request = SimpleNamespace(auth=self.superuser)
        body = admin_api.AdminSlideBatchActionSchema(
            slide_ids=[str(self.project.id), str(self.dirty_project.id)]
        )

        response = admin_api.admin_batch_archive_slides(request, body)
        self.project.refresh_from_db()
        self.dirty_project.refresh_from_db()

        self.assertEqual(response["updated_count"], 1)
        self.assertEqual(response["skipped_count"], 1)
        self.assertEqual(self.project.status, "archived")
        self.assertEqual(self.dirty_project.status, "archived")
        self.assertTrue(response["operation_id"])
        self.assertTrue(
            SlideAdminActionLog.objects.filter(id=response["operation_id"], action_type="batch_archive").exists()
        )

        operations = admin_api.admin_list_slide_operations(
            SimpleNamespace(auth=self.staff_user),
            action_type="batch_archive",
            operation_id=response["operation_id"],
            page=1,
            page_size=10,
        )
        self.assertEqual(operations["summary"]["total_operations"], 1)
        self.assertEqual(operations["items"][0]["id"], response["operation_id"])
        self.assertEqual(operations["items"][0]["updated_count"], 1)
        self.assertEqual(operations["items"][0]["skipped_count"], 1)

        operation_detail = admin_api.admin_get_slide_operation_detail(
            SimpleNamespace(auth=self.staff_user),
            response["operation_id"],
        )
        self.assertEqual(operation_detail["operation"]["request_payload"]["slide_ids"][0], str(self.project.id))
        self.assertEqual(operation_detail["operation"]["result_payload"]["updated_count"], 1)
        self.assertEqual(operation_detail["operation"]["result_payload"]["skipped_count"], 1)

    def test_admin_restore_slide_can_unarchive_project(self):
        self.project.status = "archived"
        self.project.save(update_fields=["status", "updated_at"])
        request = SimpleNamespace(auth=self.superuser)

        response = admin_api.admin_restore_slide(request, str(self.project.id))
        self.project.refresh_from_db()

        self.assertEqual(self.project.status, "active")
        self.assertIn("恢复", response["message"])

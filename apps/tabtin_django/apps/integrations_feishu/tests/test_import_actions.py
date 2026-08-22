"""飞书导入单表取消 / 跳过。"""

from __future__ import annotations

import uuid

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.integrations_feishu.import_actions import request_cancel_table, request_skip_table
from apps.integrations_feishu.models import FeishuImportJob

User = get_user_model()


class FeishuImportActionsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email=f"feishu_act_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        self.job = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            tables=[
                {"app_token": "app1", "table_id": "tbl1", "name": "A"},
                {"app_token": "app1", "table_id": "tbl2", "name": "B"},
            ],
            status=FeishuImportJob.Status.RUNNING,
            result={"created_tables": [], "progress": {"done": 0, "total": 2}},
        )

    def test_cancel_pending_table(self):
        ok, msg = request_cancel_table(self.job, "app1", "tbl2")
        self.assertTrue(ok, msg)
        self.job.refresh_from_db()
        self.assertIn("app1:tbl2", self.job.result.get("cancelled_keys") or [])

    def test_skip_running_table(self):
        ok, msg = request_skip_table(self.job, "app1", "tbl1")
        self.assertTrue(ok, msg)
        self.job.refresh_from_db()
        self.assertIn("app1:tbl1", self.job.result.get("skipped_keys") or [])

    def test_cannot_cancel_already_created(self):
        self.job.result = {
            "created_tables": [
                {"app_token": "app1", "table_id": "tbl1", "tabdata_table_id": str(uuid.uuid4())},
            ],
        }
        self.job.save(update_fields=["result"])
        ok, msg = request_cancel_table(self.job, "app1", "tbl1")
        self.assertFalse(ok)
        self.assertIn("已处理", msg)

    def test_cannot_cancel_started_table(self):
        self.job.result = {
            "created_tables": [],
            "started_keys": ["app1:tbl1"],
            "progress": {"done": 0, "total": 2},
        }
        self.job.save(update_fields=["result"])
        ok, msg = request_cancel_table(self.job, "app1", "tbl1")
        self.assertFalse(ok)
        self.assertIn("已开始", msg)

    def test_cannot_skip_already_failed_table(self):
        self.job.result = {
            "failed_tables": [
                {"app_token": "app1", "table_id": "tbl1", "error": "导入失败"},
            ],
            "progress": {"done": 1, "total": 2},
        }
        self.job.save(update_fields=["result"])

        ok, msg = request_skip_table(self.job, "app1", "tbl1")

        self.assertFalse(ok)
        self.assertIn("已处理", msg)

    def test_cannot_act_on_finished_job(self):
        self.job.status = FeishuImportJob.Status.SUCCESS
        self.job.save(update_fields=["status"])
        ok, _ = request_skip_table(self.job, "app1", "tbl1")
        self.assertFalse(ok)

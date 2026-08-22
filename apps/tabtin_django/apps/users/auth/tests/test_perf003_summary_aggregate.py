"""PERF-003 回归测试：_build_summary 使用单次 aggregate 而非 6 次独立 COUNT"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test import TestCase  # noqa: E402
from django.test.utils import CaptureQueriesContext  # noqa: E402

from apps.users.auth.admin_api import _build_summary  # noqa: E402

User = get_user_model()


class BuildSummaryAggregateTest(TestCase):
    """验证 _build_summary 查询次数 ≤ 1 且返回值正确。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        User.objects.all().delete()
        # bulk_create 不触发 post_save signal，避免自动创建 Organization 引起 UNIQUE 冲突
        User.objects.bulk_create([
            User(username="active_admin", email="admin@test.com",
                 is_active=True, is_staff=True, is_superuser=True),
            User(username="active_operator", email="op@test.com",
                 is_active=True, is_staff=True, is_superuser=False),
            User(username="active_normal", email="normal@test.com",
                 is_active=True, is_staff=False, is_superuser=False),
            User(username="inactive_normal", email="inactive@test.com",
                 is_active=False, is_staff=False, is_superuser=False),
        ])

    def test_summary_values_correct(self):
        result = _build_summary(filtered_total=2)
        self.assertEqual(result.total_users, 4)
        self.assertEqual(result.filtered_users, 2)
        self.assertEqual(result.active_users, 3)
        self.assertEqual(result.inactive_users, 1)
        self.assertEqual(result.admin_users, 1)
        self.assertEqual(result.operator_users, 1)
        self.assertEqual(result.normal_users, 2)

    def test_summary_uses_single_query(self):
        with CaptureQueriesContext(connection) as ctx:
            _build_summary(filtered_total=0)

        self.assertLessEqual(
            len(ctx.captured_queries),
            1,
            f"_build_summary 应使用 ≤1 次 SQL 查询，实际执行了 {len(ctx.captured_queries)} 次",
        )

    def test_filtered_total_passthrough(self):
        """filtered_total 参数直接传递，不依赖数据库。"""
        result = _build_summary(filtered_total=999)
        self.assertEqual(result.filtered_users, 999)

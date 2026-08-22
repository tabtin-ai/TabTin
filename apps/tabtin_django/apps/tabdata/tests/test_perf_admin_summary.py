"""
PERF-004 回归测试：list_admin_tables summary 使用单次 aggregate 而非多次独立 COUNT
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata import admin_api
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table


class AdminTableSummaryAggregateTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        User = get_user_model()
        self.staff_user = User.objects.create_user(
            username="perf004_staff",
            email="perf004_staff@test.com",
            password="pass123",
            is_staff=True,
        )
        ws_id = uuid.uuid4()
        sp_id = uuid.uuid4()

        self.active_normal = Table.objects.using(TABDATA_DB_ALIAS).create(
            name="活跃普通表",
            organization_id=ws_id,
            space_id=sp_id,
            owner=self.staff_user,
            is_archived=False,
            visibility="normal",
        )
        self.archived_table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name="归档表",
            organization_id=ws_id,
            space_id=sp_id,
            owner=self.staff_user,
            is_archived=True,
            visibility="normal",
        )
        self.trashed_table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name="回收站表",
            organization_id=ws_id,
            space_id=sp_id,
            owner=self.staff_user,
            is_archived=False,
            visibility="normal",
        )
        self.trashed_table.trash(user_id=self.staff_user.id)
        self.system_table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name="系统表",
            organization_id=ws_id,
            space_id=sp_id,
            owner=self.staff_user,
            is_archived=False,
            visibility="system",
        )
        self.hidden_table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name="隐藏表",
            organization_id=ws_id,
            space_id=sp_id,
            owner=self.staff_user,
            is_archived=False,
            visibility="hidden",
        )

    def test_summary_counts_match_expected_values(self):
        """验证单次 aggregate 产出的 summary 值与实际数据一致"""
        request = SimpleNamespace(auth=self.staff_user)

        response = admin_api.list_admin_tables(request, page=1, page_size=50)

        summary = response.summary
        self.assertEqual(summary.total_tables, 5)
        self.assertEqual(summary.active_tables, 3)
        self.assertEqual(summary.archived_tables, 1)
        self.assertEqual(summary.trashed_tables, 1)
        self.assertEqual(summary.system_tables, 2)

    def test_summary_filtered_tables_reflects_trashed_filter(self):
        """验证回收站筛选只返回逻辑删除表格"""
        request = SimpleNamespace(auth=self.staff_user)

        response = admin_api.list_admin_tables(request, archived="trashed", page=1, page_size=50)

        self.assertEqual(response.summary.filtered_tables, 1)
        self.assertEqual(response.items[0].id, str(self.trashed_table.id))
        self.assertTrue(response.items[0].is_trashed)

    def test_summary_uses_single_aggregate_query(self):
        """验证 summary 通过 aggregate 一次完成，而非 5 次独立 COUNT"""
        request = SimpleNamespace(auth=self.staff_user)

        with self.assertNumQueries(
            6,
            using=TABDATA_DB_ALIAS,
        ):
            admin_api.list_admin_tables(request, page=1, page_size=50)

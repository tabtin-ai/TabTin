"""
RecordService 搜索路径测试

覆盖大字段场景下的搜索行为，避免回退到 data::text ILIKE。
"""

from __future__ import annotations

from unittest.mock import patch
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.record_service import RecordService
from apps.tabtinspace.models import Space, Organization

User = get_user_model()


class RecordServiceSearchTestCase(TestCase):
    """RecordService 搜索优化测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        self.user = User.objects.db_manager('default').create_user(
            username='record_search_owner',
            email='record_search_owner@example.com',
            password='testpass123',
        )

        self.organization = Organization.objects.create(
            name='Record Search Organization',
            owner_id=str(self.user.id),
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name='Record Search Space',
        )
        self.table = Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='Record Search Table',
            owner_id=str(self.user.id),
        )

        self.primary_field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0,
        )

        self.extra_fields = []
        for index in range(1, 35):
            self.extra_fields.append(
                TableField.objects.create(
                    table=self.table,
                    name=f'字段{index}',
                    field_type='text',
                    order=index,
                )
            )

        TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            data={
                str(self.primary_field.id): 'alpha-target',
                str(self.extra_fields[-1].id): 'long-tail-value',
            },
            order=1,
        )
        TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            data={
                str(self.primary_field.id): 'beta-target',
            },
            order=2,
        )

        self.service = RecordService(user=self.user)

    def test_large_field_search_uses_json_key_path(self):
        """
        字段数超过阈值时，搜索仍走 JSON key 路径，不回退 data::text ILIKE。
        """
        with patch(
            'django.db.models.query.QuerySet.extra',
            side_effect=AssertionError('不应调用 QuerySet.extra(data::text ILIKE)'),
        ):
            result = self.service.list_records(
                table_id=self.table.id,
                page=1,
                page_size=20,
                search='alpha-target',
            )

        self.assertEqual(result['total'], 1)
        self.assertEqual(result['matched_total'], 1)

    def test_sort_by_field_triggers_sort_index_for_large_table(self):
        """
        大表按字段排序时，应触发排序索引准备逻辑。
        """
        with patch('apps.tabdata.services.record_service.SORT_INDEX_ROW_THRESHOLD', 1):
            with patch.object(RecordService, '_ensure_data_sort_index') as mocked_prepare:
                result = self.service.list_records(
                    table_id=self.table.id,
                    page=1,
                    page_size=20,
                    sort_by='标题',
                    sort_order='asc',
                )

        mocked_prepare.assert_called_once()
        _, kwargs = mocked_prepare.call_args
        self.assertEqual(kwargs['table_id'], self.table.id)
        self.assertEqual(kwargs['sort_key'], str(self.primary_field.id))
        self.assertGreaterEqual(kwargs['row_count'], 2)
        self.assertEqual(result['total'], 2)

    def test_list_records_latest_version_uses_monotonic_token(self):
        """latest_version 应返回 base + max(version) 的单调 token。"""
        result = self.service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
        )
        self.assertGreater(result['latest_version'], 4_000_000_000_000)

    def test_list_records_delta_filters_by_monotonic_version(self):
        """only_delta 在新 token 语义下按 version 过滤。"""
        initial = self.service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
        )
        since_version = initial['latest_version']
        self.assertGreater(since_version, 0)

        target = TableRecord.objects.filter(table=self.table).order_by('order').first()
        self.assertIsNotNone(target)
        updated_data = dict(target.data or {})
        updated_data[str(self.primary_field.id)] = 'alpha-target-updated'
        TableRecord.objects.filter(id=target.id).update(
            data=updated_data,
            version=(target.version or 0) + 1,
            updated_at=timezone.now() + timedelta(seconds=5),
        )

        delta = self.service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
            since_version=since_version,
            only_delta=True,
        )
        self.assertTrue(delta['has_changes'])
        self.assertGreaterEqual(delta['matched_total'], 1)

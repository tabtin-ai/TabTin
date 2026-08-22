"""
版本同步 token 语义测试

覆盖：
1. 单调 version token（base + version）
2. 旧 updated_at 毫秒时间戳兼容
3. only_delta 过滤分支（version/updated_at 双通道）
"""

from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.tabdata.models import Table, TableField, TableRecord, TableView
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.view_data_service import ViewDataService
from apps.tabtinspace.models import Project, Organization

User = get_user_model()


class VersionSyncTokenTestCase(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        self.user = User.objects.db_manager('default').create_user(
            username='version_token_owner',
            email='version_token_owner@example.com',
            password='testpass123',
        )

        self.organization = Organization.objects.create(
            name='Version Token Organization',
            owner_id=str(self.user.id),
        )
        self.space = Project.objects.create(
            organization=self.organization,
            name='Version Token Space',
        )
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='Version Token Table',
            owner_id=str(self.user.id),
        )

        self.primary_field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0,
        )

        self.record_a = TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            updated_by_id=str(self.user.id),
            data={str(self.primary_field.id): 'A'},
            order=1,
        )
        self.record_b = TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            updated_by_id=str(self.user.id),
            data={str(self.primary_field.id): 'B'},
            order=2,
        )

        self.record_service = RecordService(user=self.user)
        self.view_data_service = ViewDataService(user=self.user)

    def test_view_data_service_monotonic_token_and_delta_filter(self):
        queryset = TableRecord.objects.filter(table=self.table, is_deleted=False)
        state_before = self.view_data_service._get_latest_version_state(queryset)
        token_before = state_before['latest_version']

        self.assertGreater(token_before, self.view_data_service.VERSION_TOKEN_BASE_DEFAULT)
        self.assertGreaterEqual(state_before['latest_record_version'], 1)

        updated_data = dict(self.record_a.data or {})
        updated_data[str(self.primary_field.id)] = 'A-updated'
        TableRecord.objects.filter(id=self.record_a.id).update(
            data=updated_data,
            version=(self.record_a.version or 0) + 1,
            updated_at=timezone.now() + timedelta(seconds=5),
        )

        queryset_after = TableRecord.objects.filter(table=self.table, is_deleted=False)
        state_after = self.view_data_service._get_latest_version_state(queryset_after)
        self.assertGreater(state_after['latest_version'], token_before)
        self.assertTrue(
            self.view_data_service._has_changes_since_version(
                since_version=token_before,
                version_state=state_after,
            )
        )

        delta_qs = self.view_data_service._filter_queryset_since_version(queryset_after, token_before)
        delta_ids = set(delta_qs.values_list('id', flat=True))
        self.assertIn(self.record_a.id, delta_ids)

    def test_view_data_service_legacy_timestamp_compatibility(self):
        queryset = TableRecord.objects.filter(table=self.table, is_deleted=False)
        state_before = self.view_data_service._get_latest_version_state(queryset)
        legacy_since = state_before['latest_updated_ms']

        self.assertFalse(
            self.view_data_service._has_changes_since_version(
                since_version=legacy_since,
                version_state=state_before,
            )
        )

        TableRecord.objects.filter(id=self.record_b.id).update(
            updated_at=timezone.now() + timedelta(seconds=10),
        )
        queryset_after = TableRecord.objects.filter(table=self.table, is_deleted=False)
        state_after = self.view_data_service._get_latest_version_state(queryset_after)

        self.assertTrue(
            self.view_data_service._has_changes_since_version(
                since_version=legacy_since,
                version_state=state_after,
            )
        )
        legacy_delta_qs = self.view_data_service._filter_queryset_since_version(queryset_after, legacy_since)
        delta_ids = set(legacy_delta_qs.values_list('id', flat=True))
        self.assertIn(self.record_b.id, delta_ids)

    def test_record_service_delta_supports_monotonic_and_legacy_tokens(self):
        initial = self.record_service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
        )
        monotonic_since = initial['latest_version']
        self.assertGreater(monotonic_since, 0)

        updated_data = dict(self.record_a.data or {})
        updated_data[str(self.primary_field.id)] = 'A-v2'
        TableRecord.objects.filter(id=self.record_a.id).update(
            data=updated_data,
            version=(self.record_a.version or 0) + 1,
            updated_at=timezone.now() + timedelta(seconds=3),
        )

        delta_monotonic = self.record_service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
            since_version=monotonic_since,
            only_delta=True,
        )
        self.assertTrue(delta_monotonic['has_changes'])
        self.assertGreaterEqual(delta_monotonic['matched_total'], 1)

        # 旧客户端时间戳语义
        legacy_since = self.record_service._get_latest_version_state(
            TableRecord.objects.filter(table=self.table, is_deleted=False)
        )['latest_updated_ms']
        no_change_legacy = self.record_service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
            since_version=legacy_since,
            only_delta=True,
        )
        self.assertFalse(no_change_legacy['has_changes'])

        TableRecord.objects.filter(id=self.record_b.id).update(
            updated_at=timezone.now() + timedelta(seconds=8),
        )
        changed_legacy = self.record_service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
            since_version=legacy_since,
            only_delta=True,
        )
        self.assertTrue(changed_legacy['has_changes'])

    def test_physical_delete_requires_full_reload_for_stale_incremental_client(self):
        queryset = TableRecord.objects.filter(table=self.table, is_deleted=False)
        state_before = self.record_service._get_latest_version_state(queryset)
        token_before = state_before['latest_version']
        next_version = state_before['latest_record_version'] + 1
        Table.objects.filter(id=self.table.id).update(
            record_version_seq=next_version,
            record_delete_version=next_version,
        )
        TableRecord.objects.filter(id=self.record_b.id).delete()

        delta = self.record_service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
            since_version=token_before,
            only_delta=True,
        )
        view_state = self.view_data_service._get_latest_version_state(
            TableRecord.objects.filter(table=self.table, is_deleted=False),
            table_id=self.table.id,
        )

        self.assertTrue(delta['has_changes'])
        self.assertTrue(delta['requires_full_reload'])
        self.assertEqual(delta['records'], [])
        self.assertEqual(delta['matched_total'], 0)
        self.assertGreater(delta['latest_version'], token_before)
        self.assertGreater(view_state['latest_version'], token_before)
        self.assertEqual(view_state['latest_record_version'], next_version)
        self.assertEqual(view_state['latest_delete_version'], next_version)

        view = TableView.objects.create(
            table=self.table,
            name='删除恢复视图',
            view_type='grid',
            created_by=self.user,
            config={},
        )
        view_delta = self.view_data_service.get_view_records(
            view.id,
            page=1,
            page_size=20,
            since_version=token_before,
            only_delta=True,
        )
        self.assertTrue(view_delta['requires_full_reload'])
        self.assertEqual(view_delta['records'], [])

        current = self.record_service.list_records(
            table_id=self.table.id,
            page=1,
            page_size=20,
            since_version=delta['latest_version'],
            only_delta=True,
        )
        self.assertFalse(current['requires_full_reload'])

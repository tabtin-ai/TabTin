"""#8151: CSV import auto-create 后 default view 的 column_meta 须含新字段。

visible_fields=[] 仍表示「显示全部」；但 column_meta 必须补齐，且应发布
schema/view 事件，避免协作端长期停留在旧快照。
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableView
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.pg_type_map import is_system_field
from apps.tabdata.request_context import clear_request_context, set_current_window_id
from apps.tabdata.services import ImportService
from apps.tabtinspace.models import Device, Organization, SpaceMembership, Workspace
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'import view sync 8151',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        },
    )


def _ensure_native_table(space_id, table_id, fields=None):
    ddl = DDLManager(db_alias='default')
    ddl.ensure_schema(space_id)
    ddl.create_native_table(space_id, table_id)
    for field in fields or []:
        if not is_system_field(field.field_type):
            ddl.add_column(space_id, table_id, field.id, field.field_type, field.config)


class ImportAutoFieldsViewSync8151Tests(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        _ensure_free_tier()
        self.user = User.objects.create_user(
            username='u8151', email='u8151@example.com', password='pw123456',
        )
        self.organization = Organization.objects.create(name='WT8151', owner=self.user)
        self.organization.members.create(user=self.user, role='owner')
        device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name='8151-设备',
            device_type='electron',
            role='control',
            fingerprint=f'import-8151-{uuid.uuid4().hex}',
        )
        working_dir = f'/tmp/import-8151-{uuid.uuid4().hex}'
        self.space = Workspace.objects.create(
            organization=self.organization,
            device=device,
            name='SP8151',
            working_dir=working_dir,
            normalized_working_dir=working_dir,
            created_by=self.user,
        )
        SpaceMembership.objects.update_or_create(
            workspace=self.space,
            user=self.user,
            defaults={'role': 'owner', 'is_active': True},
        )
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='T8151',
            owner=self.user,
        )
        self.field_title = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0,
        )
        self.view = TableView.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            description='',
            filters=[],
            sorts=[],
            visible_fields=[],
            field_order=[],
            column_meta={},
            created_by=self.user,
            order=0,
        )
        self.table.default_view = self.view
        self.table.save(update_fields=['default_view'])
        _ensure_native_table(self.space.id, self.table.id, [self.field_title])
        self.window_id = 'win-import-8151'
        set_current_window_id(self.window_id)

    def tearDown(self):
        clear_request_context()
        super().tearDown()

    def test_auto_create_updates_default_view_column_meta(self):
        csv_content = '标题,状态,轮次\nA,进行中,种子\nB,已完成,天使\n'

        service = ImportService(user=self.user)
        created, updated, errors = service.import_from_csv(
            table_id=self.table.id,
            file_content=csv_content,
            skip_errors=False,
            auto_create_missing_fields=True,
        )

        self.assertEqual(errors, [], msg=f'import errors={errors}')
        self.assertEqual(created, 2)
        self.assertEqual(updated, 0)

        auto_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=self.table.id,
                is_deleted=False,
            ).exclude(id=self.field_title.id)
        )
        self.assertGreaterEqual(len(auto_fields), 1, '应至少自动创建一列')

        self.view.refresh_from_db()
        # 空表默认 VF=[] 保持「显示全部」语义，不必写成白名单
        self.assertEqual(self.view.visible_fields or [], [])
        column_meta = self.view.column_meta or {}
        for field in auto_fields:
            fid = str(field.id)
            self.assertIn(fid, column_meta, msg=f'column_meta 缺少新字段 {field.name}')
            meta = column_meta[fid]
            self.assertIsInstance(meta, dict)
            self.assertFalse(meta.get('hidden', False))

    @patch('apps.tabdata.services.import_service.ImportService._publish_schema_refresh_after_import')
    def test_auto_create_triggers_schema_refresh_publish(self, mock_publish):
        csv_content = '标题,标签\nA,热门\n'

        service = ImportService(user=self.user)
        created, _updated, errors = service.import_from_csv(
            table_id=self.table.id,
            file_content=csv_content,
            skip_errors=False,
            auto_create_missing_fields=True,
        )

        self.assertEqual(errors, [])
        self.assertEqual(created, 1)
        mock_publish.assert_called_once_with(self.table.id)

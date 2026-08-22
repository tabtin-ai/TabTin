"""#8047: 导入自动建列不得写入窗级 undo 栈。

连续撤销若命中 createFields，会软删导入字段，表现为「导入数据被撤没」（行还在、格子空）。
"""
from __future__ import annotations

import uuid

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.pg_type_map import is_system_field
from apps.tabdata.request_context import clear_request_context, set_current_window_id
from apps.tabdata.services import ImportService
from apps.tabdata.services.undo_redo_service import UndoRedoService
from apps.tabtinspace.models import Device, Organization, SpaceMembership, Workspace
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'import undo 8047',
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


class ImportAutoFieldsSkipUndoTests(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        _ensure_free_tier()
        self.user = User.objects.create_user(
            username='u8047', email='u8047@example.com', password='pw123456',
        )
        self.organization = Organization.objects.create(name='WT8047', owner=self.user)
        self.organization.members.create(user=self.user, role='owner')
        # ：Space 表已 DROP，改用 Workspace + 直挂 user 的 SpaceMembership
        device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name='8047-设备',
            device_type='electron',
            role='control',
            fingerprint=f'import-8047-{uuid.uuid4().hex}',
        )
        working_dir = f'/tmp/import-8047-{uuid.uuid4().hex}'
        self.space = Workspace.objects.create(
            organization=self.organization,
            device=device,
            name='SP8047',
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
            name='T8047',
            owner=self.user,
        )
        self.field_title = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0,
        )
        _ensure_native_table(self.space.id, self.table.id, [self.field_title])
        self.window_id = 'win-import-8047'
        set_current_window_id(self.window_id)

    def tearDown(self):
        clear_request_context()
        super().tearDown()

    def test_auto_create_missing_fields_not_on_undo_stack(self):
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

        undo_stack = UndoRedoService(
            user=self.user, window_id=self.window_id,
        ).get_undo_stack(table_id=self.table.id, limit=20)
        create_field_ops = [
            op for op in undo_stack if op.get('name') == 'createFields'
        ]
        self.assertEqual(
            create_field_ops,
            [],
            msg=f'导入自动建列不应入 undo 栈，实际={undo_stack}',
        )

        for field in auto_fields:
            field.refresh_from_db()
            self.assertFalse(field.is_deleted)

"""#5923: CSV/Excel 导入推断为 select 时，把列唯一值写入字段 options.choices。"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.pg_type_map import is_system_field
from apps.tabdata.services import ImportService
from apps.tabdata.utils.choice_utils import extract_choice_values
from apps.tabdata.utils.record_data_access import read_data
from apps.tabtinspace.models import Organization, OrganizationMember, Space

User = get_user_model()


def _ensure_native_table(space_id, table_id, fields=None):
    ddl = DDLManager(db_alias='default')
    ddl.ensure_schema(space_id)
    ddl.create_native_table(space_id, table_id)
    for field in fields or []:
        if not is_system_field(field.field_type):
            ddl.add_column(space_id, table_id, field.id, field.field_type, field.config)


class OptionsForInferredSelectFieldTests(SimpleTestCase):
    def test_builds_choices_in_first_seen_order(self):
        options = ImportService._options_for_inferred_select_field(
            'select',
            ['进行中', '已完成', '进行中', '', None, '已完成'],
        )
        self.assertIsNotNone(options)
        self.assertEqual(
            [c['value'] for c in options['choices']],
            ['进行中', '已完成'],
        )

    def test_non_select_returns_none(self):
        self.assertIsNone(
            ImportService._options_for_inferred_select_field('text', ['a', 'b']),
        )

    def test_empty_column_returns_none(self):
        self.assertIsNone(
            ImportService._options_for_inferred_select_field('select', ['', None]),
        )


class ImportSelectChoicesTests(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        self.user = User.objects.create_user(
            username='u5923', email='u5923@example.com', password='pw123456',
        )
        self.organization = Organization.objects.create(name='WT5923', owner=self.user)
        OrganizationMember.objects.create(
            organization=self.organization, user=self.user, role='owner',
        )
        self.space = Space.objects.create(
            organization=self.organization, name='SP5923', description='',
        )
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='T5923',
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

    def test_auto_created_select_field_gets_choices_from_column_values(self):
        # unique<=10 且非空行 > unique*3 → infer_field_type 返回 select
        status_values = ['进行中', '已完成'] * 4  # 8 行，2 个唯一值
        lines = ['标题,状态']
        for idx, status in enumerate(status_values, start=1):
            lines.append(f'任务{idx},{status}')
        csv_content = '\n'.join(lines)

        service = ImportService(user=self.user)
        created, updated, errors = service.import_from_csv(
            table_id=self.table.id,
            file_content=csv_content,
            skip_errors=False,
            auto_create_missing_fields=True,
        )

        self.assertEqual(errors, [], msg=f'import errors={errors}')
        self.assertEqual(created, 8)
        self.assertEqual(updated, 0)

        status_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
            table=self.table, name='状态', is_deleted=False,
        )
        self.assertEqual(status_field.field_type, 'select')
        choices = (status_field.config or {}).get('choices') or []
        self.assertEqual(extract_choice_values(choices), {'进行中', '已完成'})
        # 首次出现顺序：进行中 → 已完成
        self.assertEqual([c['value'] for c in choices], ['进行中', '已完成'])

        stored = {
            read_data(r).get(str(status_field.id))
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table=self.table, is_deleted=False,
            )
        }
        self.assertEqual(stored, {'进行中', '已完成'})

    def test_existing_empty_select_field_gains_choices_after_import(self):
        status_field = TableField.objects.create(
            table=self.table,
            name='状态',
            field_type='select',
            config={},
            order=1,
        )
        _ensure_native_table(self.space.id, self.table.id, [self.field_title, status_field])

        csv_content = '标题,状态\nA,待办\nB,完成\nC,待办'

        service = ImportService(user=self.user)
        created, updated, errors = service.import_from_csv(
            table_id=self.table.id,
            file_content=csv_content,
            skip_errors=False,
            auto_create_missing_fields=False,
        )

        self.assertEqual(errors, [], msg=f'import errors={errors}')
        self.assertEqual(created, 3)

        status_field.refresh_from_db()
        choices = (status_field.config or {}).get('choices') or []
        self.assertEqual(extract_choice_values(choices), {'待办', '完成'})

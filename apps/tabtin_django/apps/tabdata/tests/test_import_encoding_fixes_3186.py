"""多维表 CSV/XLSX 导入四个缺陷的回归测试（GitHub ）。

覆盖：
- Bug4：Excel(openpyxl) 读出的 int/float/datetime 单元格能落进 text 字段（不再整列被拒）。
- Bug3：导入新建记录走 upsert_record（带 order 建行），协作层能长出新行。
- Bug2：导入字段匹配与预览 smart_field_mapping 同口径（大小写/空格不敏感），
        不再把能匹配上的表头当成缺失字段平白建新列。
- deserialize_import_value 的标量转字符串纯函数行为。
"""
import io
from datetime import date, datetime
from unittest.mock import patch

from django.test import TestCase, SimpleTestCase
from django.contrib.auth import get_user_model

from apps.tabtinspace.models import Organization, OrganizationMember, Project
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services import ImportService
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.utils.field_types import deserialize_import_value
from apps.tabdata.services.import_type_inference import normalize_field_name
from apps.tabdata.utils.record_data_access import read_data

User = get_user_model()


class DeserializeImportValueTextCoercionTests(SimpleTestCase):
    """Bug4 纯函数：文本类字段的非字符串标量转换。"""

    def test_int_coerced_without_decimal(self):
        self.assertEqual(deserialize_import_value('text', 12), '12')

    def test_float_integer_value_drops_decimal(self):
        self.assertEqual(deserialize_import_value('text', 12.0), '12')

    def test_float_fraction_preserved(self):
        self.assertEqual(deserialize_import_value('text', 1.5), '1.5')

    def test_bool_lowercased(self):
        self.assertEqual(deserialize_import_value('text', True), 'true')
        self.assertEqual(deserialize_import_value('text', False), 'false')

    def test_datetime_isoformat(self):
        self.assertEqual(
            deserialize_import_value('text', datetime(2026, 7, 6, 10, 30)),
            '2026-07-06T10:30:00',
        )

    def test_date_isoformat(self):
        self.assertEqual(
            deserialize_import_value('text', date(2026, 7, 6)),
            '2026-07-06',
        )

    def test_select_int_coerced(self):
        self.assertEqual(deserialize_import_value('select', 3), '3')

    def test_existing_string_untouched(self):
        self.assertEqual(deserialize_import_value('text', '标题'), '标题')

    def test_empty_and_none_untouched(self):
        self.assertIsNone(deserialize_import_value('text', None))
        self.assertEqual(deserialize_import_value('text', ''), '')


class NormalizeFieldNameTests(SimpleTestCase):
    """Bug2 纯函数：字段名归一化口径。"""

    def test_case_insensitive(self):
        self.assertEqual(normalize_field_name('Title'), normalize_field_name('title'))

    def test_strip_separators_and_spaces(self):
        self.assertEqual(normalize_field_name(' First Name '), 'firstname')
        self.assertEqual(normalize_field_name('first_name'), 'firstname')
        self.assertEqual(normalize_field_name('first-name'), 'firstname')


class _ImportTestBase(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        self.user = User.objects.create_user(
            username='u3186', email='u3186@example.com', password='pw123456',
        )
        self.organization = Organization.objects.create(name='WT3186', owner=self.user)
        OrganizationMember.objects.create(organization=self.organization, user=self.user, role='owner')
        # ：Space 表已 DROP；Table.space_id 挂 Project.id
        self.space = Project.objects.create(
            name='SP3186',
            organization=self.organization,
        )
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.organization.id,
            name='T3186',
            owner=self.user,
        )


class ExcelIntColumnImportTests(_ImportTestBase):
    """Bug4 端到端：xlsx 中数字列导入 text 字段不再被整列跳过。"""

    def setUp(self):
        super().setUp()
        self.field_title = TableField.objects.create(
            table=self.table, name='标题', field_type='text',
            is_primary=True, order=0,
        )

    @staticmethod
    def _xlsx_bytes(headers, rows):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.append(headers)
        for r in rows:
            ws.append(r)
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    def test_int_title_column_lands_as_string(self):
        file_bytes = self._xlsx_bytes(['标题'], [[1], [2], [12]])

        service = ImportService(user=self.user)
        created, updated, errors = service.import_from_excel(
            table_id=self.table.id, file_bytes=file_bytes, skip_errors=False,
        )

        self.assertEqual(created, 3, msg=f"errors={errors}")
        self.assertEqual(errors, [])

        stored = sorted(
            read_data(r).get(str(self.field_title.id))
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table=self.table, is_deleted=False,
            )
        )
        self.assertEqual(stored, ['1', '12', '2'])


class FieldMatchingConsistencyTests(_ImportTestBase):
    """Bug2 端到端：大小写/空格不同的表头匹配已有字段，不建新列。"""

    def setUp(self):
        super().setUp()
        self.field_title = TableField.objects.create(
            table=self.table, name='Title', field_type='text',
            is_primary=True, order=0,
        )

    def test_case_and_space_variant_header_matches_existing_field(self):
        # 表头 " title " 与已有字段 "Title" 仅大小写/空格不同
        csv_content = " title \nhello\nworld"

        service = ImportService(user=self.user)
        created, updated, errors = service.import_from_csv(
            table_id=self.table.id, file_content=csv_content, skip_errors=False,
            auto_create_missing_fields=True,
        )

        self.assertEqual(created, 2, msg=f"errors={errors}")
        # 不应新建任何字段
        field_names = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table=self.table, is_deleted=False,
            ).values_list('name', flat=True)
        )
        self.assertEqual(field_names, ['Title'])

        # 值应落进已有字段
        stored = sorted(
            read_data(r).get(str(self.field_title.id))
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table=self.table, is_deleted=False,
            )
        )
        self.assertEqual(stored, ['hello', 'world'])


class ImportYdocUpsertTests(_ImportTestBase):
    """Bug3：导入新建记录时 sync_records_to_ydoc 收到 upsert_record_ids。"""

    def setUp(self):
        super().setUp()
        self.field_name = TableField.objects.create(
            table=self.table, name='name', field_type='text',
            is_primary=True, order=0,
        )

    def test_sync_called_with_upsert_record_ids(self):
        csv_content = "name\nalice\nbob"

        service = ImportService(user=self.user)
        with patch('apps.tabdata.utils.ydoc_sync.sync_records_to_ydoc') as mock_sync:
            created, updated, errors = service.import_from_csv(
                table_id=self.table.id, file_content=csv_content, skip_errors=False,
            )

        self.assertEqual(created, 2, msg=f"errors={errors}")
        self.assertTrue(mock_sync.called)
        _, kwargs = mock_sync.call_args
        upsert_ids = kwargs.get('upsert_record_ids')
        self.assertIsNotNone(upsert_ids)

        created_ids = {
            str(r.id)
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table=self.table, is_deleted=False,
            )
        }
        self.assertEqual(set(upsert_ids), created_ids)


class SyncRecordsUpsertChangeTests(_ImportTestBase):
    """Bug3 底层：sync_records_to_ydoc 对 upsert id 生成 upsert_record 变更（带 order）。"""

    def setUp(self):
        super().setUp()
        self.field_name = TableField.objects.create(
            table=self.table, name='name', field_type='text',
            is_primary=True, order=0,
        )

    def test_upsert_record_change_shape(self):
        from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc

        record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field_name.id): 'zoe'},
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            version=0,
            order=5,
        )

        captured = {}

        def _capture(**kwargs):
            captured['changes'] = kwargs.get('changes')

        with patch(
            'apps.tabdata.services.collab_service.CollabService.push_cells',
            side_effect=_capture,
        ):
            with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=True):
                sync_records_to_ydoc(
                    self.table.id, [record], None,
                    upsert_record_ids=[str(record.id)],
                    source='test',
                )

        changes = captured.get('changes')
        self.assertIsNotNone(changes)
        upserts = [c for c in changes if c.get('type') == 'upsert_record']
        self.assertEqual(len(upserts), 1)
        self.assertEqual(upserts[0]['record_id'], str(record.id))
        self.assertEqual(upserts[0]['order'], 5.0)
        # ：upsert 附带 after_record_id（空表时为 None），供 order.after 使用
        self.assertIn('after_record_id', upserts[0])
        self.assertIsNone(upserts[0]['after_record_id'])
        self.assertIn('fields', upserts[0])

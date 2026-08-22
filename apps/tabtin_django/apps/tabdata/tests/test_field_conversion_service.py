"""
字段类型转换服务测试
"""
from django.test import TestCase
from django.contrib.auth import get_user_model
from unittest.mock import patch

from apps.tabtinspace.models import Organization, Space
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.table_service import TableService


class TableServiceFieldConversionTest(TestCase):
    """验证 TableService.convert_field_type 的记录转换能力"""

    databases = ["default", "postgresql"]

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username='conversion-user',
            email='conversion@example.com',
            password='testpass123'
        )
        self.organization = Organization.objects.create(
            name='字段转换工作区',
            owner=self.user
        )
        self.space = Space.objects.create(
            name='字段转换项目',
            organization=self.organization
        )
        self.table = Table.objects.create(
            name='字段转换表格',
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            owner=self.user
        )
        self.field = TableField.objects.create(
            table=self.table,
            name='得分',
            field_type='text'
        )
        # 创建两条记录：一条可转换数字，一条非法值
        TableRecord.objects.create(
            table=self.table,
            data={'得分': '100'}
        )
        TableRecord.objects.create(
            table=self.table,
            data={'得分': '无效数据'}
        )
        self.service = TableService(user=self.user)

    def _preload_target_field_values(self, records, values):
        values_by_id = {record.id: value for record, value in zip(records, values)}

        def preload(record_batch, _table, _fields):
            for record in record_batch:
                object.__setattr__(record, '_rda_cached_data', {
                    self.field.id.hex: values_by_id[record.id],
                })

        return preload

    def test_convert_field_type_clears_invalid_values(self):
        """字段转换会保留可转换值，并清空无法转换的值。"""
        result = self.service.convert_field_type(self.field.id, 'number', force=False)

        self.assertTrue(result['success'])
        self.assertEqual(result['converted_count'], 1)
        self.assertEqual(result['cleared_count'], 1)
        self.field.refresh_from_db()
        self.assertEqual(self.field.field_type, 'number')

    def test_convert_field_type_force_mode(self):
        """开启 force 时应对失败值置空并完成类型迁移"""
        result = self.service.convert_field_type(self.field.id, 'number', force=True)

        self.assertTrue(result['success'])
        self.assertEqual(result['converted_count'], 1)
        self.assertEqual(result['cleared_count'], 1)

        self.field.refresh_from_db()
        self.assertEqual(self.field.field_type, 'number')

        records = list(TableRecord.objects.filter(table=self.table).order_by('created_at'))
        self.assertEqual(records[0].data['得分'], 100)
        self.assertIsNone(records[1].data['得分'])

    def test_convert_field_type_uses_native_hex_key_values(self):
        """执行转换必须识别 native 读取得到的 field.id.hex key。"""
        records = list(TableRecord.objects.filter(table=self.table).order_by('created_at'))

        with patch.object(
            self.service,
            '_preload_record_data_for_fields',
            side_effect=self._preload_target_field_values(records, ['42', '不是数字']),
        ):
            result = self.service.convert_field_type(self.field.id, 'number', force=False)

        self.assertTrue(result['success'])
        self.assertEqual(result['converted_count'], 1)
        self.assertEqual(result['cleared_count'], 1)

        updated = list(TableRecord.objects.filter(table=self.table).order_by('created_at'))
        self.assertEqual(updated[0].data[self.field.id.hex], 42)
        self.assertIsNone(updated[1].data[self.field.id.hex])

    def test_convert_field_type_preserves_unrelated_json_fields_after_native_preload(self):
        """native 预读只含目标字段时，写回 JSONField 不应丢失同一行其它字段。"""
        extra_field = TableField.objects.create(
            table=self.table,
            name='备注',
            field_type='text'
        )
        records = list(TableRecord.objects.filter(table=self.table).order_by('created_at'))
        records[0].__dict__['data'] = {
            '得分': '100',
            str(extra_field.id): 'keep-me',
        }
        records[0].save(update_fields=['data'])

        with patch.object(
            self.service,
            '_preload_record_data_for_fields',
            side_effect=self._preload_target_field_values(records, ['42', '不是数字']),
        ):
            result = self.service.convert_field_type(self.field.id, 'number', force=False)

        self.assertTrue(result['success'])
        updated = TableRecord.objects.get(id=records[0].id)
        self.assertEqual(updated.data[self.field.id.hex], 42)
        self.assertEqual(updated.data[str(extra_field.id)], 'keep-me')
        self.assertNotIn('得分', updated.data)

    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_convert_field_type_syncs_cleared_value_to_ydoc_after_native_preload(self, mock_push_cells):
        """转换写入后必须失效 native 预读缓存，避免 YDoc 被旧值回灌。"""
        records = list(TableRecord.objects.filter(table=self.table).order_by('created_at'))

        with patch.object(
            self.service,
            '_preload_record_data_for_fields',
            side_effect=self._preload_target_field_values(records, ['42', '不是数字']),
        ), \
             patch("apps.tabdata.utils.ydoc_sync.run_after_commit", side_effect=lambda callback: callback()):
            result = self.service.convert_field_type(self.field.id, 'number', force=False)

        self.assertTrue(result['success'])
        pushed_changes = [
            change
            for call in mock_push_cells.call_args_list
            for change in call.kwargs.get('changes', [])
        ]
        self.assertIn(
            {
                'record_id': str(records[1].id),
                'field_id_hex': self.field.id.hex,
                'value': None,
            },
            pushed_changes,
        )

    def test_can_convert_field_rejects_structural_types(self):
        """关联字段不应走通用类型转换链路"""
        for target_type in ('link',):
            result = self.service.can_convert_field(self.field.id, target_type)
            self.assertFalse(result['can_convert'])
            self.assertIn('不支持通过类型转换直接修改', result['error'])

    def test_preview_uses_native_record_values_for_success_rate(self):
        """预览成功率必须基于原生列当前值，避免 JSONField 旧数据误报 100%。"""
        records = list(TableRecord.objects.filter(table=self.table).order_by('created_at'))

        with patch.object(
            self.service,
            '_preload_record_data_for_fields',
            side_effect=self._preload_target_field_values(records, ['威威威威', '2026/07/07']),
        ):
            result = self.service.preview_field_conversion(self.field.id, 'date', sample_size=10)

        self.assertTrue(result['can_convert'])
        self.assertEqual(result['success_rate'], 0.5)
        self.assertEqual(len(result['preview']), 2)
        self.assertTrue(any(not item['success'] for item in result['preview']))

"""#6330: 单选选项重命名后，已用记录的单元格 value 同步迁移。"""
from __future__ import annotations

from django.test import TestCase

from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent


class SelectChoiceRenameMigrateTest(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        fixture = create_test_organization_with_agent(
            prefix='select_rename',
            organization_name='选项重命名工作区',
            space_name='选项重命名项目',
        )
        self.user = fixture['user']
        self.organization = fixture['organization']
        self.space = fixture['space']
        self.table = Table.objects.create(
            name='选项重命名表格',
            space_id=self.space.id,
            organization_id=self.organization.id,
            owner=self.user,
        )
        self.name_field = TableField.objects.create(
            table=self.table,
            name='客户名称',
            field_type='text',
            is_primary=True,
            order=0,
        )
        self.status_field = TableField.objects.create(
            table=self.table,
            name='状态',
            field_type='select',
            order=1,
            config={
                'choices': [
                    {'value': '待处理', 'label': '待处理', 'color': '#3B82F6'},
                    {'value': '进行中', 'label': '进行中', 'color': '#22C55E'},
                    {'value': '已完成', 'label': '已完成', 'color': '#F97316'},
                ]
            },
        )
        self.used_record = TableRecord.objects.create(
            table=self.table,
            data={
                self.name_field.name: '客户 A',
                self.status_field.name: '进行中',
            },
        )
        self.used_record_2 = TableRecord.objects.create(
            table=self.table,
            data={
                self.name_field.name: '客户 A-2',
                self.status_field.name: '进行中',
            },
        )
        self.control_record = TableRecord.objects.create(
            table=self.table,
            data={
                self.name_field.name: '客户 B',
                self.status_field.name: '待处理',
            },
        )
        self.service = TableService(user=self.user)

    def test_update_field_renames_used_select_values(self):
        updated = self.service.update_field(
            self.status_field.id,
            options={'choices': ['待处理', '处理中', '已完成']},
        )
        self.assertIsNotNone(updated)
        self.status_field.refresh_from_db()
        choice_values = [item['value'] for item in self.status_field.config['choices']]
        self.assertEqual(choice_values, ['待处理', '处理中', '已完成'])

        self.used_record.refresh_from_db()
        self.used_record_2.refresh_from_db()
        self.control_record.refresh_from_db()
        self.assertEqual(self.used_record.data[self.status_field.name], '处理中')
        self.assertEqual(self.used_record_2.data[self.status_field.name], '处理中')
        self.assertEqual(self.control_record.data[self.status_field.name], '待处理')

    def test_update_field_renames_multi_select_list_values(self):
        tags_field = TableField.objects.create(
            table=self.table,
            name='标签',
            field_type='multi_select',
            order=2,
            config={
                'choices': [
                    {'value': '紧急', 'label': '紧急', 'color': '#EF4444'},
                    {'value': '跟进中', 'label': '跟进中', 'color': '#8B5CF6'},
                ]
            },
        )
        record = TableRecord.objects.create(
            table=self.table,
            data={
                self.name_field.name: '客户 C',
                tags_field.name: ['紧急', '跟进中'],
            },
        )

        updated = self.service.update_field(
            tags_field.id,
            options={'choices': ['紧急', '处理中']},
        )
        self.assertIsNotNone(updated)
        record.refresh_from_db()
        self.assertEqual(record.data[tags_field.name], ['紧急', '处理中'])

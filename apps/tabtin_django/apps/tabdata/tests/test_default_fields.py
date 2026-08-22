"""
测试默认字段功能

通过 TableService 直接测试，绕过 API 认证层。
"""
from unittest.mock import patch, MagicMock

from django.test import TestCase
from django.contrib.auth import get_user_model

from apps.tabtinspace.models import Organization, Space
from apps.tabdata.models import Table, TableField
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.services.table_service import TableService

User = get_user_model()

_QUOTA_PATCH = patch(
    "apps.tabdata.services.table_service.QuotaService",
    MagicMock(return_value=MagicMock(check_quota=MagicMock())),
)
_NATIVE_ENSURE_TABLE_PATCH = patch(
    "apps.tabdata.services.table_service.TableService._native_ensure_table",
    return_value=None,
)
class DefaultFieldsTest(TestCase):
    """测试默认字段功能"""

    databases = ['default', 'postgresql']

    def setUp(self):
        for p in [_QUOTA_PATCH, _NATIVE_ENSURE_TABLE_PATCH]:
            p.start()
            self.addCleanup(p.stop)

        self.user = User.objects.create_user(
            username='testuser',
            email='test@example.com',
            password='testpass123',
        )
        self.organization = Organization.objects.create(
            name='测试组织',
            owner=self.user,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name='测试项目',
        )
        self.table_svc = TableService(user=self.user)

    def test_create_table_with_default_fields(self):
        """测试创建表格时使用默认字段模板（仅「标题」主字段）"""
        table = self.table_svc.create_table(
            space_id=self.space.id,
            name='默认字段测试表格',
            description='测试默认字段功能',
            use_default_fields=True,
        )
        self.assertIsNotNone(table)

        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id, is_deleted=False,
            ).order_by('order')
        )

        self.assertEqual(len(fields), 1, '默认模板仅下发「标题」一个字段')

        title_field = fields[0]
        self.assertEqual(title_field.name, '标题')
        self.assertEqual(title_field.field_type, 'text')
        self.assertTrue(title_field.is_primary)
        self.assertEqual(title_field.order, 0)

        # 状态 / 创建时间不再随默认模板下发
        field_names = {f.name for f in fields}
        self.assertNotIn('状态', field_names)
        self.assertNotIn('创建时间', field_names)

    def test_create_table_without_default_fields(self):
        """测试创建表格时不使用默认字段模板（空表创建）"""
        table = self.table_svc.create_table(
            space_id=self.space.id,
            name='空表测试表格',
            description='测试空表创建功能',
            use_default_fields=False,
        )
        self.assertIsNotNone(table)

        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id, is_deleted=False,
            ).order_by('order')
        )
        self.assertEqual(len(fields), 0, '空表应无字段')

    def test_create_table_default_parameter(self):
        """测试创建表格时 use_default_fields 默认为 True"""
        table = self.table_svc.create_table(
            space_id=self.space.id,
            name='默认参数测试表格',
            description='测试默认参数',
        )
        self.assertIsNotNone(table)

        count = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table.id, is_deleted=False,
        ).count()
        self.assertEqual(count, 1, 'use_default_fields 默认 True，应仅有「标题」一个字段')

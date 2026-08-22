"""
TabData 跨数据库测试
测试 TabData 模块的跨数据库功能
"""

from django.test import TestCase, override_settings
from django.contrib.auth import get_user_model
from django.db import connections
from django.core.management import call_command

from apps.tabtinspace.models import Organization, OrganizationMember, Space
from apps.tabdata.models import Table, TableRecord

User = get_user_model()


class CrossDatabaseTest(TestCase):
    """跨数据库测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.user = User.objects.create_user(
            username='testuser',
            email='test@example.com',
            password='testpass123'
        )

    def test_tabdata_models_use_correct_database(self):
        """测试 TabData 模型使用正确的数据库"""
        # 创建组织（应该使用 postgresql）
        organization = Organization.objects.create(
            name='跨数据库测试组织',
            owner=self.user
        )

        # 验证组织在正确的数据库中
        self.assertTrue(
            Organization.objects.using('postgresql').filter(id=organization.id).exists()
        )

        # 验证组织不在默认数据库中
        self.assertFalse(
            Organization.objects.using('default').filter(id=organization.id).exists()
        )

    def test_user_model_in_default_database(self):
        """测试用户模型在默认数据库中"""
        # 验证用户在默认数据库中
        self.assertTrue(
            User.objects.using('default').filter(id=self.user.id).exists()
        )

        # 验证用户不在 postgresql 中
        self.assertFalse(
            User.objects.using('postgresql').filter(id=self.user.id).exists()
        )

    def test_organization_member_cross_database_relationship(self):
        """测试组织成员的跨数据库关系"""
        # 创建组织
        organization = Organization.objects.create(
            name='成员关系测试',
            owner=self.user
        )

        # 创建另一个用户
        member_user = User.objects.create_user(
            username='member',
            email='member@example.com',
            password='testpass123'
        )

        # 添加成员
        organization_member = OrganizationMember.objects.create(
            organization=organization,
            user=member_user,
            role='editor',
            invited_by=self.user
        )

        # 验证关系
        self.assertEqual(organization_member.organization, organization)
        self.assertEqual(organization_member.user, member_user)
        self.assertEqual(organization_member.invited_by, self.user)

    def test_project_and_table_relationships(self):
        """测试项目和表格的关系"""
        # 创建组织
        organization = Organization.objects.create(
            name='项目表格测试',
            owner=self.user
        )

        # 创建项目
        space = Space.objects.create(
            name='测试项目',
            organization=organization,
            created_by=self.user
        )

        # 创建表格
        table = Table.objects.create(
            name='测试表格',
            project=space,
            created_by=self.user
        )

        # 验证关系
        self.assertEqual(space.organization, organization)
        self.assertEqual(table.project, space)

        # 验证都在 postgresql 中
        self.assertTrue(
            Space.objects.using('postgresql').filter(id=space.id).exists()
        )
        self.assertTrue(
            Table.objects.using('postgresql').filter(id=table.id).exists()
        )

    def test_database_routing(self):
        """测试数据库路由"""
        # 测试 TabData 模型的数据库路由
        organization = Organization.objects.create(
            name='路由测试',
            owner=self.user
        )

        # 使用 _state.db 检查模型实例使用的数据库
        self.assertEqual(organization._state.db, 'postgresql')

        # 测试用户模型的数据库路由
        self.assertEqual(self.user._state.db, 'default')

    def test_cross_database_queries(self):
        """测试跨数据库查询"""
        # 创建测试数据
        organization = Organization.objects.create(
            name='查询测试',
            owner=self.user
        )

        space = Space.objects.create(
            name='查询项目',
            organization=organization,
            created_by=self.user
        )

        # 测试通过外键查询
        spaces = Space.objects.filter(organization=organization)
        self.assertEqual(spaces.count(), 1)
        self.assertEqual(spaces.first().name, '查询项目')

        # 测试反向查询
        organization_projects = organization.projects.all()
        self.assertEqual(organization_spaces.count(), 1)
        self.assertEqual(organization_spaces.first().name, '查询项目')

    def test_transaction_handling(self):
        """测试事务处理"""
        from django.db import transaction

        # 测试在 postgresql 中的事务
        try:
            with transaction.atomic(using='postgresql'):
                organization = Organization.objects.create(
                    name='事务测试',
                    owner=self.user
                )

                # 模拟错误
                raise Exception("测试回滚")
        except Exception:
            pass

        # 验证事务回滚
        self.assertFalse(
            Organization.objects.filter(name='事务测试').exists()
        )

    def test_bulk_operations(self):
        """测试批量操作"""
        organization = Organization.objects.create(
            name='批量操作测试',
            owner=self.user
        )

        space = Space.objects.create(
            name='批量项目',
            organization=organization,
            created_by=self.user
        )

        table = Table.objects.create(
            name='批量表格',
            project=space,
            created_by=self.user
        )

        # 批量创建记录
        records_data = [
            TableRecord(
                table=table,
                data={'name': f'记录{i}', 'value': i},
                created_by=self.user
            )
            for i in range(10)
        ]

        TableRecord.objects.bulk_create(records_data)

        # 验证批量创建
        self.assertEqual(
            TableRecord.objects.filter(table=table).count(),
            10
        )

    def test_database_connections(self):
        """测试数据库连接"""
        # 获取数据库连接
        default_conn = connections['default']
        tabdata_conn = connections['postgresql']

        # 验证连接配置
        self.assertIsNotNone(default_conn)
        self.assertIsNotNone(tabdata_conn)

        # 验证不同的数据库
        self.assertNotEqual(
            default_conn.settings_dict['NAME'],
            tabdata_conn.settings_dict['NAME']
        )


class DatabaseMigrationTest(TestCase):
    """数据库迁移测试"""

    databases = ['default', 'postgresql']

    def test_tabdata_migrations(self):
        """测试 TabData 迁移"""
        # 这里可以测试迁移相关的功能
        # 由于测试环境的限制，这里只做基本验证

        # 验证表是否存在
        from django.db import connection

        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name LIKE 'tabdata_%'
            """)
            tables = cursor.fetchall()

        table_names = [table[0] for table in tables]
        expected_tables = [
            'tabdata_table',
            'tabdata_field',
            'tabdata_record',
            'tabdata_view',
        ]

        for expected_table in expected_tables:
            self.assertIn(expected_table, table_names)


if __name__ == '__main__':
    import unittest
    unittest.main()

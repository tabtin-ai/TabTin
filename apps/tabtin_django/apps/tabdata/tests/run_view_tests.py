#!/usr/bin/env python3
"""
视图功能测试运行器

独立测试脚本，不依赖Django test数据库
"""
import os
import sys
import django

# 设置Django环境
sys.path.insert(0, '/www/wwwroot/tabtin')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
django.setup()

from datetime import date, timedelta
from django.contrib.auth import get_user_model
from apps.tabtinspace.models import Organization, Space
from apps.tabdata.models import Table, TableField, TableRecord, TableView
from apps.tabdata.utils.view_validators import ViewConfigValidator
from apps.tabdata.services.view_data_service import ViewDataService

User = get_user_model()


class TestRunner:
    """测试运行器"""

    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []
        self.user = None
        self.organization = None
        self.space = None
        self.table = None

    def setup(self):
        """设置测试环境"""
        print("=" * 70)
        print("设置测试环境...")

        # 查找或创建测试用户
        try:
            self.user = User.objects.get(phone='13900000001')
            print(f"✓ 使用已有用户: {self.user.nickname}")
        except User.DoesNotExist:
            self.user = User.objects.create_user(
                phone='13900000001',
                nickname='视图测试用户'
            )
            print(f"✓ 创建测试用户: {self.user.nickname}")

        # 创建组织
        self.organization, created = Organization.objects.get_or_create(
            owner=self.user,
            name='视图测试组织',
            defaults={'description': '用于测试多视图功能'}
        )
        print(f"✓ 组织: {self.organization.name}")

        # 创建项目
        self.space, created = Space.objects.get_or_create(
            organization=self.organization,
            name='视图测试项目',
            defaults={'description': '用于测试'}
        )
        print(f"✓ 项目: {self.space.name}")

        # 创建表格
        self.table, created = Table.objects.get_or_create(
            project_id=self.space.id,
            name='视图测试表格',
            defaults={'owner': self.user, 'organization_id': self.space.organization_id}
        )
        if created:
            # 创建字段
            self.title_field = TableField.objects.create(
                table=self.table,
                name='标题',
                field_type='text',
                is_primary=True,
                order=0
            )

            self.status_field = TableField.objects.create(
                table=self.table,
                name='状态',
                field_type='select',
                config={
                    'options': [
                        {'value': '待办', 'label': '待办'},
                        {'value': '进行中', 'label': '进行中'},
                        {'value': '已完成', 'label': '已完成'}
                    ]
                },
                order=1
            )

            self.date_field = TableField.objects.create(
                table=self.table,
                name='截止日期',
                field_type='date',
                order=2
            )

            self.attachment_field = TableField.objects.create(
                table=self.table,
                name='附件',
                field_type='attachment',
                order=3
            )

            # 创建测试记录
            today = date.today()
            for i in range(10):
                status = ['待办', '进行中', '已完成'][i % 3]
                TableRecord.objects.create(
                    table=self.table,
                    created_by=self.user,
                    data={
                        str(self.title_field.id): f'测试任务{i+1}',
                        str(self.status_field.id): status,
                        str(self.date_field.id): (today + timedelta(days=i)).isoformat()
                    },
                    order=i
                )
            print(f"✓ 创建表格和测试数据")
        else:
            # 获取现有字段
            self.title_field = TableField.objects.get(table=self.table, name='标题')
            self.status_field = TableField.objects.get(table=self.table, name='状态')
            self.date_field = TableField.objects.get(table=self.table, name='截止日期')
            self.attachment_field = TableField.objects.get(table=self.table, name='附件')
            print(f"✓ 使用已有表格")

        print("=" * 70)

    def test(self, name, func):
        """运行单个测试"""
        try:
            func()
            print(f"✓ {name}")
            self.passed += 1
        except AssertionError as e:
            print(f"✗ {name}")
            print(f"  断言失败: {e}")
            self.failed += 1
            self.errors.append((name, str(e)))
        except Exception as e:
            print(f"✗ {name}")
            print(f"  异常: {e}")
            self.failed += 1
            self.errors.append((name, str(e)))

    def assert_true(self, condition, message=""):
        """断言为真"""
        if not condition:
            raise AssertionError(message or "断言失败: 条件不为真")

    def assert_false(self, condition, message=""):
        """断言为假"""
        if condition:
            raise AssertionError(message or "断言失败: 条件不为假")

    def assert_equal(self, a, b, message=""):
        """断言相等"""
        if a != b:
            raise AssertionError(message or f"断言失败: {a} != {b}")

    def assert_in(self, item, container, message=""):
        """断言包含"""
        if item not in container:
            raise AssertionError(message or f"断言失败: {item} 不在 {container} 中")

    def assert_greater(self, a, b, message=""):
        """断言大于"""
        if not (a > b):
            raise AssertionError(message or f"断言失败: {a} <= {b}")

    # ==================== 配置验证器测试 ====================

    def test_kanban_valid_config(self):
        """测试看板视图：合法配置"""
        config = {
            'group_by_field': str(self.status_field.id),
            'card_title_field': str(self.title_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assert_true(is_valid)
        self.assert_equal(len(errors), 0)

    def test_kanban_missing_group_field(self):
        """测试看板视图：缺少分组字段"""
        config = {'card_title_field': str(self.title_field.id)}

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assert_false(is_valid)
        self.assert_greater(len(errors), 0)

    def test_calendar_valid_config(self):
        """测试日历视图：合法配置"""
        config = {
            'date_field': str(self.date_field.id),
            'title_field': str(self.title_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config
        )

        self.assert_true(is_valid)
        self.assert_equal(len(errors), 0)

    def test_gallery_valid_config(self):
        """测试画廊视图：合法配置"""
        config = {'title_field': str(self.title_field.id)}

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config
        )

        self.assert_true(is_valid)
        self.assert_equal(len(errors), 0)

    def test_get_kanban_suggestions(self):
        """测试获取看板视图配置建议"""
        suggestions = ViewConfigValidator.get_config_suggestions(
            self.table, 'kanban'
        )

        self.assert_in('group_by_field', suggestions)
        self.assert_in('card_title_field', suggestions)

    # ==================== 视图数据服务测试 ====================

    def test_create_and_get_grid_view(self):
        """测试创建并获取表格视图数据"""
        # 创建视图
        view, created = TableView.objects.get_or_create(
            table=self.table,
            name='测试表格视图',
            defaults={
                'view_type': 'grid',
                'created_by': self.user,
                'config': {}
            }
        )

        # 获取数据
        service = ViewDataService(user=self.user)
        data = service.get_view_records(view.id, page=1, page_size=10)

        self.assert_in('view', data)
        self.assert_in('records', data)
        self.assert_equal(data['view']['view_type'], 'grid')
        self.assert_greater(data['total'], 0)

    def test_create_and_get_kanban_view(self):
        """测试创建并获取看板视图数据"""
        # 创建视图
        view, created = TableView.objects.get_or_create(
            table=self.table,
            name='测试看板视图',
            defaults={
                'view_type': 'kanban',
                'created_by': self.user,
                'config': {
                    'group_by_field': str(self.status_field.id),
                    'card_title_field': str(self.title_field.id)
                }
            }
        )

        # 获取数据
        service = ViewDataService(user=self.user)
        data = service.get_view_records(view.id)

        self.assert_equal(data['metadata']['view_type'], 'kanban')
        self.assert_in('groups', data['metadata'])
        groups = data['metadata']['groups']
        self.assert_greater(len(groups), 0)

    def test_create_and_get_calendar_view(self):
        """测试创建并获取日历视图数据"""
        # 创建视图
        view, created = TableView.objects.get_or_create(
            table=self.table,
            name='测试日历视图',
            defaults={
                'view_type': 'calendar',
                'created_by': self.user,
                'config': {
                    'date_field': str(self.date_field.id),
                    'title_field': str(self.title_field.id)
                }
            }
        )

        # 获取数据
        today = date.today()
        end_date = today + timedelta(days=30)
        date_range = f"{today.isoformat()},{end_date.isoformat()}"

        service = ViewDataService(user=self.user)
        data = service.get_view_records(view.id, date_range=date_range)

        self.assert_equal(data['metadata']['view_type'], 'calendar')
        self.assert_in('date_range', data['metadata'])

    def test_create_and_get_gallery_view(self):
        """测试创建并获取画廊视图数据"""
        # 创建视图
        view, created = TableView.objects.get_or_create(
            table=self.table,
            name='测试画廊视图',
            defaults={
                'view_type': 'gallery',
                'created_by': self.user,
                'config': {
                    'title_field': str(self.title_field.id),
                    'card_size': 'medium',
                    'cards_per_row': 4
                }
            }
        )

        # 获取数据
        service = ViewDataService(user=self.user)
        data = service.get_view_records(view.id)

        self.assert_equal(data['metadata']['view_type'], 'gallery')
        self.assert_in('grid_layout', data['metadata'])
        self.assert_equal(data['metadata']['grid_layout']['columns'], 4)

    def run_all_tests(self):
        """运行所有测试"""
        print("\n视图功能测试开始...")
        print("=" * 70)

        # 配置验证器测试
        print("\n[1] 配置验证器测试")
        print("-" * 70)
        self.test("看板视图合法配置", self.test_kanban_valid_config)
        self.test("看板视图缺少分组字段", self.test_kanban_missing_group_field)
        self.test("日历视图合法配置", self.test_calendar_valid_config)
        self.test("画廊视图合法配置", self.test_gallery_valid_config)
        self.test("获取看板配置建议", self.test_get_kanban_suggestions)

        # 视图数据服务测试
        print("\n[2] 视图数据服务测试")
        print("-" * 70)
        self.test("创建并获取表格视图", self.test_create_and_get_grid_view)
        self.test("创建并获取看板视图", self.test_create_and_get_kanban_view)
        self.test("创建并获取日历视图", self.test_create_and_get_calendar_view)
        self.test("创建并获取画廊视图", self.test_create_and_get_gallery_view)

        # 打印结果
        print("\n" + "=" * 70)
        print("测试完成!")
        print("=" * 70)
        print(f"通过: {self.passed} 个")
        print(f"失败: {self.failed} 个")
        print(f"总计: {self.passed + self.failed} 个")

        if self.failed > 0:
            print("\n失败的测试:")
            for name, error in self.errors:
                print(f"  - {name}: {error}")

        print("=" * 70)

        return self.failed == 0


if __name__ == '__main__':
    runner = TestRunner()
    runner.setup()
    success = runner.run_all_tests()
    sys.exit(0 if success else 1)

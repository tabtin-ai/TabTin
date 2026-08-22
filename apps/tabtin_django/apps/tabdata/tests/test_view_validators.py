"""
视图配置验证器测试

测试 ViewConfigValidator 的各种验证场景
"""
from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
from apps.tabdata.models import Table, TableField
from apps.tabdata.utils.view_validators import ViewConfigValidator

User = get_user_model()


class ViewValidatorTestCase(TestCase):
    """视图配置验证器测试用例"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        # 创建用户
        self.user = User.objects.create_user(
            phone='13800000001',
            nickname='测试用户'
        )

        # ：Space 表已 DROP，改用官方 fixture（返回的 space 实为 Workspace）
        ctx = create_test_organization_with_agent(
            owner=self.user,
            organization_name='测试组织',
            space_name='测试项目',
            prefix='view_validator',
        )
        self.organization = ctx['organization']
        self.space = ctx['space']

        # 创建表格
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='测试表格',
            owner=self.user
        )

        # 创建字段
        self.text_field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0
        )

        self.select_field = TableField.objects.create(
            table=self.table,
            name='状态',
            field_type='select',
            config={
                'options': [
                    {'value': '待办', 'label': '待办', 'color': '#gray'},
                    {'value': '进行中', 'label': '进行中', 'color': '#blue'},
                    {'value': '已完成', 'label': '已完成', 'color': '#green'}
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

    # ==================== 看板视图测试 ====================

    def test_kanban_valid_config(self):
        """测试看板视图：合法配置"""
        config = {
            'group_by_field': str(self.select_field.id),
            'card_title_field': str(self.text_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertEqual(len(errors), 0)

    def test_kanban_missing_group_by_field(self):
        """测试看板视图：缺少分组字段"""
        config = {
            'card_title_field': str(self.text_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('group_by_field', errors[0])

    def test_kanban_missing_title_field(self):
        """测试看板视图：缺少标题字段"""
        config = {
            'group_by_field': str(self.select_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('card_title_field', errors[0])

    def test_kanban_missing_title_field_allowed_in_lenient_mode(self):
        """创建阶段允许标题暂缺，并返回警告而不是抛出 KeyError。"""
        config = {
            'group_by_field': str(self.select_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config, strict=False
        )

        self.assertTrue(is_valid)
        self.assertEqual(errors, [])
        self.assertTrue(any('card_title_field' in warning for warning in warnings))

    def test_kanban_text_group_field_allowed(self):
        """测试看板视图：text 可作为分组字段（denylist，非 select 白名单）"""
        config = {
            'group_by_field': str(self.text_field.id),
            'card_title_field': str(self.text_field.id),
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertEqual(len(errors), 0)

    def test_kanban_attachment_group_field_rejected(self):
        """测试看板视图：attachment 不可作为分组字段"""
        config = {
            'group_by_field': str(self.attachment_field.id),
            'card_title_field': str(self.text_field.id),
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertTrue(any('attachment' in err for err in errors))

    def test_kanban_with_cover_field(self):
        """测试看板视图：带封面字段"""
        config = {
            'group_by_field': str(self.select_field.id),
            'card_title_field': str(self.text_field.id),
            'card_cover_field': str(self.attachment_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertEqual(len(errors), 0)

    def test_kanban_without_cover_field_warning(self):
        """测试看板视图：未配置封面字段应有警告"""
        config = {
            'group_by_field': str(self.select_field.id),
            'card_title_field': str(self.text_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_kanban_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertGreater(len(warnings), 0)
        self.assertIn('card_cover_field', warnings[0])

    # ==================== 日历视图测试 ====================

    def test_calendar_valid_config(self):
        """测试日历视图：合法配置"""
        config = {
            'date_field': str(self.date_field.id),
            'title_field': str(self.text_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertEqual(len(errors), 0)

    def test_calendar_missing_date_field(self):
        """测试日历视图：缺少日期字段"""
        config = {
            'title_field': str(self.text_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('date_field', errors[0])

    def test_calendar_missing_title_field(self):
        """测试日历视图：标题字段可选"""
        config = {
            'date_field': str(self.date_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertEqual(errors, [])

    def test_calendar_missing_title_field_lenient(self):
        """测试日历视图：创建宽松模式下缺少标题字段不抛错"""
        config = {
            'date_field': str(self.date_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config, strict=False
        )

        self.assertTrue(is_valid)
        self.assertEqual(errors, [])

    def test_calendar_invalid_title_field(self):
        """测试日历视图：显式配置无效标题字段应返回校验错误"""
        config = {
            'date_field': str(self.date_field.id),
            'title_field': 'not-a-uuid',
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('标题字段ID', errors[0])

    def test_calendar_cross_table_title_field(self):
        """测试日历视图：标题字段不能来自其他表"""
        other_table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='其他表格',
            owner=self.user
        )
        other_field = TableField.objects.create(
            table=other_table,
            name='其他标题',
            field_type='text',
            order=0
        )
        config = {
            'date_field': str(self.date_field.id),
            'title_field': str(other_field.id),
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('标题字段ID', errors[0])

    def test_calendar_wrong_date_field_type(self):
        """测试日历视图：日期字段类型错误"""
        config = {
            'date_field': str(self.text_field.id),  # 应该是date类型
            'title_field': str(self.text_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('日期', errors[0])

    def test_calendar_invalid_view_mode(self):
        """测试日历视图：无效的视图模式"""
        config = {
            'date_field': str(self.date_field.id),
            'title_field': str(self.text_field.id),
            'default_view_mode': 'invalid_mode'
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('default_view_mode', errors[0])

    def test_calendar_valid_view_modes(self):
        """测试日历视图：有效的视图模式"""
        valid_modes = ['month', 'week', 'day', 'agenda']

        for mode in valid_modes:
            config = {
                'date_field': str(self.date_field.id),
                'title_field': str(self.text_field.id),
                'default_view_mode': mode
            }

            is_valid, errors, warnings = ViewConfigValidator.validate_calendar_config(
                self.table, config
            )

            self.assertTrue(is_valid, f"模式 {mode} 应该是合法的")

    # ==================== 画廊视图测试 ====================

    def test_gallery_valid_config(self):
        """测试画廊视图：合法配置"""
        config = {
            'title_field': str(self.text_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertEqual(len(errors), 0)

    def test_gallery_missing_title_field(self):
        """测试画廊视图：标题字段可选"""
        config = {}

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertEqual(errors, [])

    def test_gallery_missing_title_field_lenient(self):
        """测试画廊视图：创建宽松模式下缺少标题字段不抛错"""
        config = {}

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config, strict=False
        )

        self.assertTrue(is_valid)
        self.assertEqual(errors, [])

    def test_gallery_invalid_title_field(self):
        """测试画廊视图：显式配置无效标题字段应返回校验错误"""
        config = {
            'title_field': 'not-a-uuid'
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('标题字段ID', errors[0])

    def test_gallery_deleted_title_field(self):
        """测试画廊视图：标题字段已删除应返回校验错误"""
        deleted_field = TableField.objects.create(
            table=self.table,
            name='已删除标题',
            field_type='text',
            is_deleted=True,
            order=10
        )
        config = {
            'title_field': str(deleted_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('标题字段ID', errors[0])

    def test_gallery_with_cover_field(self):
        """测试画廊视图：带封面字段"""
        config = {
            'title_field': str(self.text_field.id),
            'cover_field': str(self.attachment_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertEqual(len(errors), 0)

    def test_gallery_without_cover_field_warning(self):
        """测试画廊视图：未配置封面字段应有警告"""
        config = {
            'title_field': str(self.text_field.id)
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config
        )

        self.assertTrue(is_valid)
        self.assertGreater(len(warnings), 0)
        self.assertIn('cover_field', warnings[0])

    def test_gallery_invalid_card_size(self):
        """测试画廊视图：无效的卡片大小"""
        config = {
            'title_field': str(self.text_field.id),
            'card_size': 'invalid_size'
        }

        is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
            self.table, config
        )

        self.assertFalse(is_valid)
        self.assertIn('card_size', errors[0])

    def test_gallery_valid_card_sizes(self):
        """测试画廊视图：有效的卡片大小"""
        valid_sizes = ['small', 'medium', 'large']

        for size in valid_sizes:
            config = {
                'title_field': str(self.text_field.id),
                'card_size': size
            }

            is_valid, errors, warnings = ViewConfigValidator.validate_gallery_config(
                self.table, config
            )

            self.assertTrue(is_valid, f"大小 {size} 应该是合法的")

    # ==================== 配置建议测试 ====================

    def test_get_kanban_suggestions(self):
        """测试获取看板视图配置建议"""
        suggestions = ViewConfigValidator.get_config_suggestions(
            self.table, 'kanban'
        )

        self.assertIsNotNone(suggestions)
        self.assertIn('group_by_field', suggestions)
        self.assertIn('card_title_field', suggestions)
        self.assertEqual(suggestions['group_by_field'], str(self.select_field.id))
        self.assertEqual(suggestions['card_title_field'], str(self.text_field.id))

    def test_get_calendar_suggestions(self):
        """测试获取日历视图配置建议"""
        suggestions = ViewConfigValidator.get_config_suggestions(
            self.table, 'calendar'
        )

        self.assertIsNotNone(suggestions)
        self.assertIn('date_field', suggestions)
        self.assertIn('title_field', suggestions)
        self.assertEqual(suggestions['date_field'], str(self.date_field.id))

    def test_get_gallery_suggestions(self):
        """测试获取画廊视图配置建议"""
        suggestions = ViewConfigValidator.get_config_suggestions(
            self.table, 'gallery'
        )

        self.assertIsNotNone(suggestions)
        self.assertIn('title_field', suggestions)
        self.assertIn('cover_field', suggestions)
        self.assertEqual(suggestions['cover_field'], str(self.attachment_field.id))

    def test_get_calendar_suggestions_fallback_to_text_without_primary(self):
        """测试日历视图配置建议：无主字段时回退到文本字段作为标题建议"""
        self.text_field.is_primary = False
        self.text_field.save(update_fields=['is_primary'])

        suggestions = ViewConfigValidator.get_config_suggestions(
            self.table, 'calendar'
        )

        self.assertEqual(suggestions['title_field'], str(self.text_field.id))

    def test_get_gallery_suggestions_fallback_to_first_field_without_text(self):
        """测试画廊视图配置建议：无主字段和文本字段时回退到第一个普通字段"""
        self.text_field.is_primary = False
        self.text_field.field_type = 'number'
        self.text_field.save(update_fields=['is_primary', 'field_type'])

        suggestions = ViewConfigValidator.get_config_suggestions(
            self.table, 'gallery'
        )

        self.assertEqual(suggestions['title_field'], str(self.text_field.id))

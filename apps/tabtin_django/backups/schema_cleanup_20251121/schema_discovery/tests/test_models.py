"""
Schema Template Model Tests

测试 SchemaTemplate 模型的基本功能
"""

from django.test import TestCase, TransactionTestCase
from apps.schema_discovery.models import SchemaTemplate
import uuid


class SchemaTemplateModelTest(TransactionTestCase):
    """SchemaTemplate 模型测试"""

    databases = ['postgresql']  # 指定使用 PostgreSQL 数据库

    def _fixture_teardown(self):
        """在每个测试后清理数据"""
        SchemaTemplate.objects.all().delete()
        super()._fixture_teardown()

    def setUp(self):
        """测试前准备"""
        self.template_data = {
            "module_name": "test_schema",
            "description": "测试模板",
            "version": "1.0.0",
            "template_json": {
                "fields_to_fill": {
                    "field1": {
                        "required": True,
                        "type": "css_selector",
                        "description": "测试字段"
                    }
                }
            },
            "is_active": True
        }

    def test_create_template(self):
        """测试创建模板"""
        template = SchemaTemplate.objects.create(**self.template_data)

        self.assertIsNotNone(template.id)
        self.assertIsInstance(template.id, uuid.UUID)
        self.assertEqual(template.module_name, "test_schema")
        self.assertEqual(template.version, "1.0.0")
        self.assertTrue(template.is_active)

    def test_template_unique_module_name(self):
        """测试模块名唯一性约束"""
        from django.db import IntegrityError

        SchemaTemplate.objects.create(**self.template_data)

        # 尝试创建相同 module_name 的模板
        with self.assertRaises(IntegrityError):
            SchemaTemplate.objects.create(**self.template_data)

    def test_template_json_field(self):
        """测试 JSONB 字段存储和读取"""
        template = SchemaTemplate.objects.create(**self.template_data)

        # 重新从数据库读取
        saved_template = SchemaTemplate.objects.get(pk=template.id)

        self.assertEqual(
            saved_template.template_json,
            self.template_data["template_json"]
        )
        self.assertIn("fields_to_fill", saved_template.template_json)

    def test_template_default_values(self):
        """测试默认值"""
        template = SchemaTemplate.objects.create(
            module_name="test_default",
            template_json={"test": "data"}
        )

        self.assertEqual(template.version, "1.0.0")
        self.assertTrue(template.is_active)
        self.assertEqual(template.description, "")

    def test_template_update(self):
        """测试模板更新"""
        template = SchemaTemplate.objects.create(**self.template_data)

        template.version = "2.0.0"
        template.is_active = False
        template.save()

        updated_template = SchemaTemplate.objects.get(pk=template.id)
        self.assertEqual(updated_template.version, "2.0.0")
        self.assertFalse(updated_template.is_active)

    def test_template_ordering(self):
        """测试模板排序"""
        SchemaTemplate.objects.create(
            module_name="z_template",
            template_json={"test": "data"}
        )
        SchemaTemplate.objects.create(
            module_name="a_template",
            template_json={"test": "data"}
        )

        templates = list(SchemaTemplate.objects.all())
        self.assertEqual(templates[0].module_name, "a_template")
        self.assertEqual(templates[1].module_name, "z_template")

    def test_template_str_representation(self):
        """测试字符串表示"""
        template = SchemaTemplate.objects.create(**self.template_data)
        # 模型应该有合理的字符串表示
        str_repr = str(template)
        self.assertIsInstance(str_repr, str)

    def tearDown(self):
        """测试后清理"""
        SchemaTemplate.objects.all().delete()


class SchemaTemplateQueryTest(TransactionTestCase):
    """SchemaTemplate 查询测试"""

    databases = ['postgresql']

    def _fixture_teardown(self):
        """在每个测试后清理数据"""
        SchemaTemplate.objects.all().delete()
        super()._fixture_teardown()

    def setUp(self):
        """创建测试数据"""
        # 清理现有数据
        SchemaTemplate.objects.all().delete()

        SchemaTemplate.objects.create(
            module_name="active_template",
            template_json={"test": "data"},
            is_active=True
        )
        SchemaTemplate.objects.create(
            module_name="inactive_template",
            template_json={"test": "data"},
            is_active=False
        )

    def test_filter_active_templates(self):
        """测试查询活跃模板"""
        active_templates = SchemaTemplate.objects.filter(is_active=True)
        self.assertEqual(active_templates.count(), 1)
        self.assertEqual(active_templates.first().module_name, "active_template")

    def test_get_by_module_name(self):
        """测试根据模块名查询"""
        template = SchemaTemplate.objects.get(module_name="active_template")
        self.assertIsNotNone(template)
        self.assertTrue(template.is_active)

    def tearDown(self):
        """测试后清理"""
        SchemaTemplate.objects.all().delete()

"""
Template Manager Service Tests

测试 TemplateManager 服务
"""

from django.test import TestCase, TransactionTestCase
from apps.schema_discovery.models import SchemaTemplate
from apps.schema_discovery.services import TemplateManager


class TemplateManagerTest(TransactionTestCase):
    """TemplateManager 服务测试"""

    databases = ['postgresql']

    def _fixture_teardown(self):
        """在每个测试后清理数据"""
        SchemaTemplate.objects.all().delete()
        super()._fixture_teardown()

    def setUp(self):
        """创建测试模板"""
        # 清理现有数据
        SchemaTemplate.objects.all().delete()

        SchemaTemplate.objects.create(
            module_name="test_module1",
            template_json={
                "fields_to_fill": {
                    "field1": {
                        "required": True,
                        "type": "css_selector",
                        "description": "测试字段1"
                    }
                }
            },
            is_active=True
        )
        SchemaTemplate.objects.create(
            module_name="test_module2",
            template_json={
                "fields_to_fill": {
                    "field2": {
                        "required": False,
                        "type": "array",
                        "description": "测试字段2"
                    }
                }
            },
            is_active=True
        )

    def test_load_template(self):
        """测试加载单个模板"""
        template_json = TemplateManager.load_template("test_module1")

        self.assertIsNotNone(template_json)
        self.assertIn("fields_to_fill", template_json)
        self.assertIn("field1", template_json["fields_to_fill"])

    def test_load_nonexistent_template(self):
        """测试加载不存在的模板"""
        template_json = TemplateManager.load_template("nonexistent")
        self.assertIsNone(template_json)

    def test_load_templates(self):
        """测试批量加载模板"""
        templates = TemplateManager.load_templates(["test_module1", "test_module2"])

        self.assertEqual(len(templates), 2)
        self.assertIn("test_module1", templates)
        self.assertIn("test_module2", templates)

    def test_build_blank_schema(self):
        """测试组装空白模板表"""
        blank_schema = TemplateManager.build_blank_schema(["test_module1", "test_module2"])

        self.assertIn("modules", blank_schema)
        self.assertIn("fields_to_fill", blank_schema)
        self.assertIn("completion_status", blank_schema)

        self.assertEqual(blank_schema["modules"], ["test_module1", "test_module2"])
        self.assertIn("field1", blank_schema["fields_to_fill"])
        self.assertIn("field2", blank_schema["fields_to_fill"])

        # 检查 completion_status 初始化
        self.assertFalse(blank_schema["completion_status"]["field1"]["filled"])
        self.assertIsNone(blank_schema["completion_status"]["field1"]["value"])
        self.assertTrue(blank_schema["completion_status"]["field1"]["required"])

    def test_update_completion_status(self):
        """测试更新字段填写状态"""
        blank_schema = TemplateManager.build_blank_schema(["test_module1"])

        # 更新字段
        updated_schema = TemplateManager.update_completion_status(
            blank_schema,
            "field1",
            "ul.products > li"
        )

        self.assertTrue(updated_schema["completion_status"]["field1"]["filled"])
        self.assertEqual(updated_schema["completion_status"]["field1"]["value"], "ul.products > li")

    def test_validate_filled_schema(self):
        """测试验证填写完整性"""
        blank_schema = TemplateManager.build_blank_schema(["test_module1"])

        # 未填写时
        result = TemplateManager.validate_filled_schema(blank_schema)
        self.assertFalse(result["is_complete"])
        self.assertIn("field1", result["missing_fields"])
        self.assertEqual(result["filled_count"], 0)
        self.assertEqual(result["total_count"], 1)

        # 填写后
        TemplateManager.update_completion_status(blank_schema, "field1", "test")
        result = TemplateManager.validate_filled_schema(blank_schema)
        self.assertTrue(result["is_complete"])
        self.assertEqual(len(result["missing_fields"]), 0)
        self.assertEqual(result["filled_count"], 1)

    def test_get_all_templates(self):
        """测试获取所有活跃模板"""
        templates = TemplateManager.get_all_templates()

        self.assertEqual(len(templates), 2)
        self.assertTrue(all(t.is_active for t in templates))

    def test_get_template(self):
        """测试获取指定模板"""
        template = TemplateManager.get_template("test_module1")

        self.assertIsNotNone(template)
        self.assertEqual(template.module_name, "test_module1")

    def test_generate_from_template(self):
        """测试根据模板生成 Schema"""
        schema = TemplateManager.generate_from_template(
            "test_module1",
            {"custom_field": "custom_value"}
        )

        self.assertIn("fields_to_fill", schema)
        self.assertEqual(schema["custom_field"], "custom_value")

    def test_generate_from_nonexistent_template(self):
        """测试从不存在的模板生成 Schema"""
        with self.assertRaises(ValueError):
            TemplateManager.generate_from_template("nonexistent")

    def tearDown(self):
        """测试后清理"""
        SchemaTemplate.objects.all().delete()

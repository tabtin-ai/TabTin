"""
Schema Discovery API Tests

测试 Schema Discovery API 端点
"""

from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient
from apps.schema_discovery.models import SchemaTemplate, GeneratedSchema, SchemaUsageLog
import uuid
import json


class SchemaTemplateAPITest(TestCase):
    """Schema 模板 API 测试"""

    databases = ['postgresql']

    def setUp(self):
        """测试前准备"""
        self.client = APIClient()

        # 创建测试模板
        SchemaTemplate.objects.create(
            module_name="test_basic",
            template_json={
                "fields_to_fill": {
                    "field1": {
                        "required": True,
                        "type": "css_selector"
                    }
                }
            },
            description="测试基础模板",
            is_active=True
        )

    def test_list_templates(self):
        """测试获取模板列表"""
        response = self.client.get('/api/schema-discovery/templates')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIsInstance(data, list)
        self.assertGreater(len(data), 0)
        self.assertIn("module_name", data[0])
        self.assertIn("template_json", data[0])

    def test_get_template(self):
        """测试获取单个模板"""
        response = self.client.get('/api/schema-discovery/templates/test_basic')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["module_name"], "test_basic")
        self.assertIn("fields_to_fill", data["template_json"])

    def test_get_nonexistent_template(self):
        """测试获取不存在的模板"""
        response = self.client.get('/api/schema-discovery/templates/nonexistent')

        self.assertEqual(response.status_code, 404)

    def test_generate_from_template(self):
        """测试根据模板生成 Schema"""
        response = self.client.post(
            '/api/schema-discovery/templates/test_basic/generate',
            data=json.dumps({"custom_field": "custom_value"}),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("fields_to_fill", data)
        self.assertEqual(data["custom_field"], "custom_value")

    def tearDown(self):
        """测试后清理"""
        SchemaTemplate.objects.all().delete()


class SchemaCacheAPITest(TestCase):
    """Schema 缓存 API 测试"""

    databases = ['postgresql']

    def setUp(self):
        """测试前准备"""
        self.client = APIClient()
        self.user_id = uuid.uuid4()

        # 创建测试 Schema
        self.schema = GeneratedSchema.objects.create(
            thread_id="test-thread-001",
            user_id=self.user_id,
            url="https://example.com/products",
            domain="example.com",
            schema_json={"list_selector": "ul.products > li"},
            modules_used=["basic_schema"],
            confidence=0.9
        )

    def test_query_cached_schema(self):
        """测试查询缓存的 Schema"""
        response = self.client.post(
            '/api/schema-discovery/schemas/query',
            data=json.dumps({
                "url": "https://example.com/products",
                "min_confidence": 0.8
            }),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIsNotNone(data)
        self.assertEqual(data["domain"], "example.com")

    def test_query_cached_schema_not_found(self):
        """测试查询缓存但未找到"""
        response = self.client.post(
            '/api/schema-discovery/schemas/query',
            data=json.dumps({
                "url": "https://notfound.com/products",
                "min_confidence": 0.8
            }),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        # 未找到时返回 null
        self.assertIsNone(response.json())

    def test_save_schema(self):
        """测试保存 Schema"""
        response = self.client.post(
            '/api/schema-discovery/schemas',
            data=json.dumps({
                "thread_id": "test-thread-002",
                "user_id": str(uuid.uuid4()),
                "url": "https://test.com/items",
                "schema_json": {"list_selector": "ul.items"},
                "modules_used": ["basic_schema"],
                "confidence": 0.85
            }),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("id", data)
        self.assertEqual(data["domain"], "test.com")

    def test_get_schema(self):
        """测试获取指定 Schema"""
        response = self.client.get(f'/api/schema-discovery/schemas/{self.schema.id}')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["id"], str(self.schema.id))
        self.assertEqual(data["domain"], "example.com")

    def test_list_schemas_by_domain(self):
        """测试根据域名查询 Schema"""
        response = self.client.get(
            '/api/schema-discovery/schemas',
            {'domain': 'example.com', 'min_confidence': 0.0}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIsInstance(data, list)
        self.assertGreater(len(data), 0)

    def test_log_schema_usage(self):
        """测试记录使用日志"""
        response = self.client.post(
            f'/api/schema-discovery/schemas/{self.schema.id}/usage',
            data=json.dumps({
                "schema_id": str(self.schema.id),
                "user_id": str(self.user_id),
                "url": "https://example.com/products",
                "instruction": "提取产品",
                "success": True,
                "extracted_count": 10
            }),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("id", data)
        self.assertTrue(data["success"])

    def test_get_schema_usage_logs(self):
        """测试获取使用日志"""
        # 先创建日志
        SchemaUsageLog.objects.create(
            schema=self.schema,
            user_id=self.user_id,
            url="https://example.com/products",
            success=True
        )

        response = self.client.get(f'/api/schema-discovery/schemas/{self.schema.id}/usage')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIsInstance(data, list)
        self.assertGreater(len(data), 0)

    def test_cleanup_low_quality_schemas(self):
        """测试清理低质量 Schema"""
        # 创建低质量 Schema
        GeneratedSchema.objects.create(
            thread_id="test-thread-low",
            user_id=self.user_id,
            url="https://example.com/low",
            domain="example.com",
            schema_json={"test": "data"},
            modules_used=["basic_schema"],
            confidence=0.3,
            usage_count=10,
            success_rate=0.1
        )

        response = self.client.delete(
            '/api/schema-discovery/schemas/cleanup',
            {'min_confidence': 0.5, 'min_success_rate': 0.3, 'min_usage_count': 5}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("deleted_count", data)
        self.assertGreater(data["deleted_count"], 0)

    def tearDown(self):
        """测试后清理"""
        SchemaUsageLog.objects.all().delete()
        GeneratedSchema.objects.all().delete()

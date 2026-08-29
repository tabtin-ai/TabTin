"""
Generated Schema and Usage Log Model Tests

测试 GeneratedSchema 和 SchemaUsageLog 模型
"""

from django.test import TestCase, TransactionTestCase
from apps.schema_discovery.models import GeneratedSchema, SchemaUsageLog
import uuid
from django.utils import timezone


class GeneratedSchemaModelTest(TransactionTestCase):
    """GeneratedSchema 模型测试"""

    databases = ['postgresql']

    def _fixture_teardown(self):
        """在每个测试后清理数据"""
        GeneratedSchema.objects.all().delete()
        super()._fixture_teardown()

    def setUp(self):
        """测试前准备"""
        self.user_id = uuid.uuid4()
        self.schema_data = {
            "thread_id": "test-thread-001",
            "user_id": self.user_id,
            "url": "https://example.com/products",
            "domain": "example.com",
            "url_pattern": "/products",
            "schema_json": {
                "list_selector": "ul.products > li",
                "fields": [
                    {"name": "title", "selector": "h2", "type": "text"}
                ]
            },
            "modules_used": ["basic_schema"],
            "confidence": 0.9,
            "sample_data": [{"title": "Test Product"}],
            "validation_stats": {"success_rate": 0.95}
        }

    def test_create_schema(self):
        """测试创建 Schema"""
        schema = GeneratedSchema.objects.create(**self.schema_data)

        self.assertIsNotNone(schema.id)
        self.assertIsInstance(schema.id, uuid.UUID)
        self.assertEqual(schema.domain, "example.com")
        self.assertEqual(schema.confidence, 0.9)
        self.assertEqual(schema.usage_count, 0)
        self.assertIsNone(schema.success_rate)

    def test_schema_json_field(self):
        """测试 JSONB 字段"""
        schema = GeneratedSchema.objects.create(**self.schema_data)

        saved_schema = GeneratedSchema.objects.get(pk=schema.id)
        self.assertEqual(
            saved_schema.schema_json["list_selector"],
            "ul.products > li"
        )
        self.assertIsInstance(saved_schema.modules_used, list)

    def test_schema_default_values(self):
        """测试默认值"""
        schema = GeneratedSchema.objects.create(**self.schema_data)

        self.assertEqual(schema.usage_count, 0)
        self.assertIsNone(schema.success_rate)
        self.assertIsNone(schema.last_used_at)
        self.assertEqual(schema.url_pattern, "/products")

    def test_schema_update_stats(self):
        """测试更新统计信息"""
        schema = GeneratedSchema.objects.create(**self.schema_data)

        schema.usage_count = 5
        schema.success_rate = 0.8
        schema.last_used_at = timezone.now()
        schema.save()

        updated_schema = GeneratedSchema.objects.get(pk=schema.id)
        self.assertEqual(updated_schema.usage_count, 5)
        self.assertEqual(updated_schema.success_rate, 0.8)
        self.assertIsNotNone(updated_schema.last_used_at)

    def test_query_by_domain(self):
        """测试根据域名查询"""
        GeneratedSchema.objects.create(**self.schema_data)

        schemas = GeneratedSchema.objects.filter(domain="example.com")
        self.assertEqual(schemas.count(), 1)

    def test_query_by_confidence(self):
        """测试根据置信度查询"""
        GeneratedSchema.objects.create(**self.schema_data)

        high_confidence = GeneratedSchema.objects.filter(confidence__gte=0.8)
        self.assertEqual(high_confidence.count(), 1)

        low_confidence = GeneratedSchema.objects.filter(confidence__lt=0.5)
        self.assertEqual(low_confidence.count(), 0)

    def tearDown(self):
        """测试后清理"""
        GeneratedSchema.objects.all().delete()


class SchemaUsageLogModelTest(TransactionTestCase):
    """SchemaUsageLog 模型测试"""

    databases = ['postgresql']

    def _fixture_teardown(self):
        """在每个测试后清理数据"""
        SchemaUsageLog.objects.all().delete()
        GeneratedSchema.objects.all().delete()
        super()._fixture_teardown()

    def setUp(self):
        """测试前准备"""
        self.user_id = uuid.uuid4()
        self.schema = GeneratedSchema.objects.create(
            thread_id="test-thread-001",
            user_id=self.user_id,
            url="https://example.com/products",
            domain="example.com",
            schema_json={"test": "data"},
            modules_used=["basic_schema"],
            confidence=0.9
        )

    def test_create_usage_log(self):
        """测试创建使用日志"""
        log = SchemaUsageLog.objects.create(
            schema=self.schema,
            user_id=self.user_id,
            url="https://example.com/products",
            instruction="提取所有产品",
            success=True,
            extracted_count=10,
            execution_time_ms=1200
        )

        self.assertIsNotNone(log.id)
        self.assertEqual(log.schema.id, self.schema.id)
        self.assertTrue(log.success)
        self.assertEqual(log.extracted_count, 10)

    def test_usage_log_foreign_key(self):
        """测试外键关联"""
        log = SchemaUsageLog.objects.create(
            schema=self.schema,
            user_id=self.user_id,
            url="https://example.com/products",
            success=True
        )

        # 测试反向查询
        logs = self.schema.usage_logs.all()
        self.assertEqual(logs.count(), 1)
        self.assertEqual(logs.first().id, log.id)

    def test_usage_log_ordering(self):
        """测试日志排序"""
        SchemaUsageLog.objects.create(
            schema=self.schema,
            user_id=self.user_id,
            url="https://example.com/products",
            success=True
        )
        # 稍后创建第二条日志
        import time
        time.sleep(0.01)
        SchemaUsageLog.objects.create(
            schema=self.schema,
            user_id=self.user_id,
            url="https://example.com/products",
            success=False
        )

        logs = list(SchemaUsageLog.objects.all())
        # 默认按 created_at 降序排序
        self.assertFalse(logs[0].success)  # 最新的在前
        self.assertTrue(logs[1].success)   # 旧的在后

    def test_cascade_delete(self):
        """测试级联删除"""
        SchemaUsageLog.objects.create(
            schema=self.schema,
            user_id=self.user_id,
            url="https://example.com/products",
            success=True
        )

        schema_id = self.schema.id
        self.schema.delete()

        # Schema 删除后，关联的日志也应该被删除
        logs = SchemaUsageLog.objects.filter(schema_id=schema_id)
        self.assertEqual(logs.count(), 0)

    def tearDown(self):
        """测试后清理"""
        SchemaUsageLog.objects.all().delete()
        GeneratedSchema.objects.all().delete()

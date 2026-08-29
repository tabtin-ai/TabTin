"""
Schema Cache Service Tests

测试 SchemaCache 服务
"""

from django.test import TestCase, TransactionTestCase
from apps.schema_discovery.models import GeneratedSchema, SchemaUsageLog
from apps.schema_discovery.services import SchemaCache
import uuid


class SchemaCacheTest(TransactionTestCase):
    """SchemaCache 服务测试"""

    databases = ['postgresql']

    def _fixture_teardown(self):
        """在每个测试后清理数据"""
        SchemaUsageLog.objects.all().delete()
        GeneratedSchema.objects.all().delete()
        super()._fixture_teardown()

    def setUp(self):
        """创建测试数据"""
        # 清理现有数据
        SchemaUsageLog.objects.all().delete()
        GeneratedSchema.objects.all().delete()

        self.user_id = uuid.uuid4()
        self.schema = GeneratedSchema.objects.create(
            thread_id="test-thread-001",
            user_id=self.user_id,
            url="https://example.com/products",
            domain="example.com",
            schema_json={"list_selector": "ul.products > li"},
            modules_used=["basic_schema"],
            confidence=0.9
        )

    def test_extract_domain(self):
        """测试提取域名"""
        domain = SchemaCache.extract_domain("https://example.com/products?id=123")
        self.assertEqual(domain, "example.com")

        domain = SchemaCache.extract_domain("http://sub.example.com/path")
        self.assertEqual(domain, "sub.example.com")

    def test_query_cached_schema(self):
        """测试查询缓存的 Schema"""
        schema = SchemaCache.query_cached_schema(
            url="https://example.com/products",
            min_confidence=0.8
        )

        self.assertIsNotNone(schema)
        self.assertEqual(schema.domain, "example.com")

    def test_query_cached_schema_low_confidence(self):
        """测试查询缓存但置信度不足"""
        schema = SchemaCache.query_cached_schema(
            url="https://example.com/products",
            min_confidence=0.95  # 高于现有 Schema 的置信度
        )

        self.assertIsNone(schema)

    def test_query_cached_schema_with_user_priority(self):
        """测试查询缓存时用户优先"""
        other_user_id = uuid.uuid4()

        # 创建另一个用户的 Schema（置信度更高）
        GeneratedSchema.objects.create(
            thread_id="test-thread-002",
            user_id=other_user_id,
            url="https://example.com/products",
            domain="example.com",
            schema_json={"list_selector": "div.products"},
            modules_used=["basic_schema"],
            confidence=0.95,
            success_rate=0.99
        )

        # 查询时指定当前用户 ID
        schema = SchemaCache.query_cached_schema(
            url="https://example.com/products",
            min_confidence=0.8,
            user_id=str(self.user_id)
        )

        # 应该优先返回当前用户的 Schema
        self.assertEqual(schema.user_id, self.user_id)

    def test_save_schema(self):
        """测试保存 Schema"""
        new_schema = SchemaCache.save_schema(
            thread_id="test-thread-002",
            user_id=str(self.user_id),
            url="https://test.com/items",
            schema_json={"list_selector": "ul.items > li"},
            modules_used=["basic_schema", "pagination_schema"],
            confidence=0.85,
            sample_data=[{"title": "Item 1"}],
            validation_stats={"success_rate": 0.9}
        )

        self.assertIsNotNone(new_schema.id)
        self.assertEqual(new_schema.domain, "test.com")
        self.assertEqual(new_schema.confidence, 0.85)
        self.assertEqual(len(new_schema.modules_used), 2)

    def test_log_usage(self):
        """测试记录使用日志"""
        log = SchemaCache.log_usage(
            schema_id=str(self.schema.id),
            user_id=str(self.user_id),
            url="https://example.com/products",
            instruction="提取所有产品",
            success=True,
            extracted_count=10,
            execution_time_ms=1200
        )

        self.assertIsNotNone(log.id)
        self.assertTrue(log.success)
        self.assertEqual(log.extracted_count, 10)

    def test_update_schema_stats(self):
        """测试更新 Schema 统计"""
        # 记录多次使用
        SchemaCache.log_usage(
            schema_id=str(self.schema.id),
            user_id=str(self.user_id),
            url="https://example.com/products",
            instruction="测试1",
            success=True
        )
        SchemaCache.log_usage(
            schema_id=str(self.schema.id),
            user_id=str(self.user_id),
            url="https://example.com/products",
            instruction="测试2",
            success=True
        )
        SchemaCache.log_usage(
            schema_id=str(self.schema.id),
            user_id=str(self.user_id),
            url="https://example.com/products",
            instruction="测试3",
            success=False
        )

        # 重新加载 Schema
        updated_schema = GeneratedSchema.objects.get(pk=self.schema.id)

        self.assertEqual(updated_schema.usage_count, 3)
        self.assertAlmostEqual(updated_schema.success_rate, 2/3, places=2)
        self.assertIsNotNone(updated_schema.last_used_at)

    def test_get_schemas_by_domain(self):
        """测试根据域名获取 Schema"""
        # 创建同域名的多个 Schema
        GeneratedSchema.objects.create(
            thread_id="test-thread-002",
            user_id=self.user_id,
            url="https://example.com/other",
            domain="example.com",
            schema_json={"test": "data"},
            modules_used=["basic_schema"],
            confidence=0.7
        )

        schemas = SchemaCache.get_schemas_by_domain("example.com", min_confidence=0.6)

        self.assertEqual(len(schemas), 2)
        # 应该按成功率、置信度排序
        self.assertGreaterEqual(schemas[0].confidence, schemas[1].confidence)

    def test_delete_low_quality_schemas(self):
        """测试删除低质量 Schema"""
        # 创建一个低质量的 Schema
        low_quality = GeneratedSchema.objects.create(
            thread_id="test-thread-low",
            user_id=self.user_id,
            url="https://example.com/low",
            domain="example.com",
            schema_json={"test": "data"},
            modules_used=["basic_schema"],
            confidence=0.4,
            usage_count=10,
            success_rate=0.2
        )

        deleted_count = SchemaCache.delete_low_quality_schemas(
            min_confidence=0.5,
            min_success_rate=0.3,
            min_usage_count=5
        )

        self.assertEqual(deleted_count, 1)

        # 验证低质量 Schema 已删除
        with self.assertRaises(GeneratedSchema.DoesNotExist):
            GeneratedSchema.objects.get(pk=low_quality.id)

        # 验证高质量 Schema 仍存在
        self.assertIsNotNone(GeneratedSchema.objects.get(pk=self.schema.id))

    def tearDown(self):
        """测试后清理"""
        SchemaUsageLog.objects.all().delete()
        GeneratedSchema.objects.all().delete()

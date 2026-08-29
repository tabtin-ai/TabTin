"""Schema Cache Service

Schema 缓存服务：负责Schema的查询、保存和使用统计
"""

from typing import Optional, List, Dict
from urllib.parse import urlparse
from django.utils import timezone
from django.db.models import Q, F
from apps.schema_discovery.models import GeneratedSchema, SchemaUsageLog
import logging
import uuid

logger = logging.getLogger(__name__)


class SchemaCache:
    """Schema 缓存服务

    职责：
    - 查询缓存的 Schema
    - 保存新生成的 Schema
    - 更新使用统计
    - 记录使用日志
    """

    @staticmethod
    def extract_domain(url: str) -> str:
        """从 URL 中提取域名

        Args:
            url: 完整 URL

        Returns:
            域名（如 example.com）
        """
        parsed = urlparse(url)
        return parsed.netloc

    @staticmethod
    def query_cached_schema(
        url: str,
        min_confidence: float = 0.8,
        user_id: Optional[str] = None
    ) -> Optional[GeneratedSchema]:
        """查询缓存的 Schema

        Args:
            url: 目标 URL
            min_confidence: 最小置信度阈值
            user_id: 用户 ID（可选，用于优先返回用户自己的 Schema）

        Returns:
            GeneratedSchema 对象或 None
        """
        domain = SchemaCache.extract_domain(url)

        # 查询条件
        query = Q(domain=domain, confidence__gte=min_confidence)

        # 如果提供了 user_id，优先返回该用户的 Schema
        if user_id:
            # 先查用户自己的
            user_schema = GeneratedSchema.objects.filter(
                query & Q(user_id=user_id)
            ).order_by('-success_rate', '-confidence', '-created_at').first()

            if user_schema:
                logger.info(f"✅ 找到用户自己的缓存 Schema: {domain} (confidence: {user_schema.confidence:.2f})")
                return user_schema

        # 查询所有匹配的 Schema
        schema = GeneratedSchema.objects.filter(query).order_by(
            '-success_rate',  # 优先使用成功率高的
            '-confidence',     # 其次是置信度高的
            '-usage_count',    # 再次是使用次数多的
            '-created_at'      # 最后是最新的
        ).first()

        if schema:
            logger.info(f"✅ 找到缓存 Schema: {domain} (confidence: {schema.confidence:.2f}, usage: {schema.usage_count})")
        else:
            logger.info(f"❌ 未找到缓存 Schema: {domain}")

        return schema

    @staticmethod
    def save_schema(
        thread_id: str,
        user_id: str,
        url: str,
        schema_json: Dict,
        modules_used: List[str],
        confidence: float,
        sample_data: Optional[List[Dict]] = None,
        validation_stats: Optional[Dict] = None
    ) -> GeneratedSchema:
        """保存生成的 Schema

        Args:
            thread_id: Thread ID
            user_id: 用户 ID
            url: 原始 URL
            schema_json: 完整的 Schema JSON
            modules_used: 使用的模块列表
            confidence: 置信度
            sample_data: 采样数据
            validation_stats: 验证统计

        Returns:
            保存的 GeneratedSchema 对象
        """
        domain = SchemaCache.extract_domain(url)

        # 创建 Schema
        schema = GeneratedSchema.objects.create(
            thread_id=thread_id,
            user_id=uuid.UUID(user_id) if isinstance(user_id, str) else user_id,
            url=url,
            domain=domain,
            schema_json=schema_json,
            modules_used=modules_used,
            confidence=confidence,
            sample_data=sample_data,
            validation_stats=validation_stats,
            usage_count=0,
            success_rate=None  # 初始没有成功率
        )

        logger.info(f"💾 保存 Schema 成功: {domain} (ID: {schema.id}, confidence: {confidence:.2f})")
        return schema

    @staticmethod
    def log_usage(
        schema_id: str,
        user_id: str,
        url: str,
        instruction: str,
        success: bool,
        extracted_count: Optional[int] = None,
        error_message: str = "",
        execution_time_ms: Optional[int] = None
    ) -> SchemaUsageLog:
        """记录 Schema 使用日志

        Args:
            schema_id: Schema ID
            user_id: 用户 ID
            url: 使用的 URL
            instruction: 用户指令
            success: 是否成功
            extracted_count: 提取的数据条数
            error_message: 错误信息
            execution_time_ms: 执行时间（毫秒）

        Returns:
            SchemaUsageLog 对象
        """
        try:
            schema = GeneratedSchema.objects.get(pk=schema_id)
        except GeneratedSchema.DoesNotExist:
            logger.error(f"❌ Schema 不存在: {schema_id}")
            raise

        # 创建使用日志
        log = SchemaUsageLog.objects.create(
            schema=schema,
            user_id=uuid.UUID(user_id) if isinstance(user_id, str) else user_id,
            url=url,
            instruction=instruction,
            success=success,
            extracted_count=extracted_count,
            error_message=error_message,
            execution_time_ms=execution_time_ms
        )

        # 更新 Schema 统计
        SchemaCache.update_schema_stats(schema_id)

        status = "✅" if success else "❌"
        logger.info(f"{status} 记录使用日志: Schema {schema_id}, success={success}, count={extracted_count}")

        return log

    @staticmethod
    def update_schema_stats(schema_id: str):
        """更新 Schema 的统计信息

        Args:
            schema_id: Schema ID
        """
        try:
            schema = GeneratedSchema.objects.get(pk=schema_id)
        except GeneratedSchema.DoesNotExist:
            logger.error(f"❌ Schema 不存在: {schema_id}")
            return

        # 计算成功率
        logs = SchemaUsageLog.objects.filter(schema=schema)
        total_count = logs.count()

        if total_count > 0:
            success_count = logs.filter(success=True).count()
            success_rate = success_count / total_count

            # 更新字段
            schema.usage_count = total_count
            schema.success_rate = success_rate
            schema.last_used_at = timezone.now()
            schema.save(update_fields=['usage_count', 'success_rate', 'last_used_at'])

            logger.info(f"📊 更新 Schema 统计: {schema_id}, usage={total_count}, success_rate={success_rate:.2%}")

    @staticmethod
    def get_schemas_by_domain(
        domain: str,
        min_confidence: float = 0.0,
        limit: int = 10
    ) -> List[GeneratedSchema]:
        """根据域名获取所有 Schema

        Args:
            domain: 域名
            min_confidence: 最小置信度
            limit: 返回数量限制

        Returns:
            GeneratedSchema 列表
        """
        schemas = GeneratedSchema.objects.filter(
            domain=domain,
            confidence__gte=min_confidence
        ).order_by('-success_rate', '-confidence', '-created_at')[:limit]

        logger.info(f"📋 查询到 {schemas.count()} 个 Schema for {domain}")
        return list(schemas)

    @staticmethod
    def delete_low_quality_schemas(
        min_confidence: float = 0.5,
        min_success_rate: float = 0.3,
        min_usage_count: int = 5
    ) -> int:
        """删除低质量的 Schema

        Args:
            min_confidence: 最小置信度阈值
            min_success_rate: 最小成功率阈值
            min_usage_count: 最小使用次数（只删除使用过的）

        Returns:
            删除的数量
        """
        # 只删除使用次数足够多但质量低的 Schema
        deleted_count, _ = GeneratedSchema.objects.filter(
            usage_count__gte=min_usage_count,
            success_rate__lt=min_success_rate
        ).filter(
            Q(confidence__lt=min_confidence) | Q(success_rate__lt=min_success_rate)
        ).delete()

        if deleted_count > 0:
            logger.warning(f"🗑️  删除了 {deleted_count} 个低质量 Schema")

        return deleted_count

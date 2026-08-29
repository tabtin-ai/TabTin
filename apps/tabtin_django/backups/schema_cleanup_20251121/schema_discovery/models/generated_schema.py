"""Generated Schema Model

Schema 缓存：存储生成的 Schema，支持复用
"""

from django.db import models
import uuid


class GeneratedSchema(models.Model):
    """生成的 Schema（可复用）

    用途：
    - Schema 缓存：同域名的 Schema 可复用
    - 使用统计：追踪哪些 Schema 最有效
    - 质量评估：confidence、success_rate 用于排序
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
        help_text="Schema ID"
    )

    thread_id = models.CharField(
        max_length=100,
        db_index=True,
        help_text="Thread ID（探索会话 ID）"
    )

    user_id = models.UUIDField(
        db_index=True,
        help_text="用户 ID"
    )

    # URL 信息
    url = models.CharField(
        max_length=500,
        help_text="原始 URL"
    )

    domain = models.CharField(
        max_length=200,
        db_index=True,
        help_text="域名（用于缓存）"
    )

    url_pattern = models.CharField(
        max_length=500,
        blank=True,
        help_text="URL 模式（用于匹配复用，如 /product/{id}）"
    )

    # Schema 内容
    schema_json = models.JSONField(
        help_text="完整的 Schema（PostgreSQL JSONB）"
    )

    modules_used = models.JSONField(
        help_text="使用的模块列表（PostgreSQL JSONB）"
    )

    # 质量指标
    confidence = models.FloatField(
        help_text="置信度（0-1）"
    )

    sample_data = models.JSONField(
        null=True,
        blank=True,
        help_text="采样数据"
    )

    validation_stats = models.JSONField(
        null=True,
        blank=True,
        help_text="验证统计"
    )

    # 使用统计
    usage_count = models.IntegerField(
        default=0,
        help_text="被复用次数"
    )

    success_rate = models.FloatField(
        null=True,
        blank=True,
        help_text="成功率（0-1）"
    )

    # 时间戳
    created_at = models.DateTimeField(
        auto_now_add=True,
        db_index=True,
        help_text="创建时间"
    )

    last_used_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="最后使用时间"
    )

    class Meta:
        db_table = 'generated_schemas'
        verbose_name = 'Generated Schema'
        verbose_name_plural = 'Generated Schemas'
        indexes = [
            models.Index(fields=['domain'], name='idx_schema_domain'),
            models.Index(fields=['url_pattern'], name='idx_schema_url_pattern'),
            models.Index(fields=['-created_at'], name='idx_schema_created'),
            models.Index(fields=['user_id'], name='idx_schema_user'),
            models.Index(fields=['thread_id'], name='idx_schema_thread'),
        ]
        ordering = ['-created_at']

    def __str__(self):
        return f"Schema for {self.domain} (confidence: {self.confidence:.2f})"

    def increment_usage(self):
        """增加使用计数"""
        from django.utils import timezone
        self.usage_count += 1
        self.last_used_at = timezone.now()
        self.save(update_fields=['usage_count', 'last_used_at'])

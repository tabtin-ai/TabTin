"""Schema Usage Log Model

使用日志：追踪 Schema 使用效果
"""

from django.db import models


class SchemaUsageLog(models.Model):
    """Schema 使用日志（分析成功率）

    用途：
    - 记录每次 Schema 使用情况
    - 计算 Schema 的 success_rate
    - 用于 Schema 质量评估和优化
    """

    id = models.BigAutoField(
        primary_key=True,
        help_text="日志 ID"
    )

    schema = models.ForeignKey(
        'GeneratedSchema',
        on_delete=models.CASCADE,
        related_name='usage_logs',
        help_text="关联的 Schema"
    )

    user_id = models.UUIDField(
        db_index=True,
        help_text="用户 ID"
    )

    # 使用场景
    url = models.CharField(
        max_length=500,
        help_text="使用的 URL"
    )

    instruction = models.TextField(
        blank=True,
        help_text="用户指令"
    )

    # 结果
    success = models.BooleanField(
        help_text="是否成功"
    )

    extracted_count = models.IntegerField(
        null=True,
        blank=True,
        help_text="提取了多少条数据"
    )

    error_message = models.TextField(
        blank=True,
        help_text="错误信息（失败时）"
    )

    # 性能
    execution_time_ms = models.IntegerField(
        null=True,
        blank=True,
        help_text="执行时间（毫秒）"
    )

    # 时间戳
    created_at = models.DateTimeField(
        auto_now_add=True,
        db_index=True,
        help_text="创建时间"
    )

    class Meta:
        db_table = 'schema_usage_logs'
        verbose_name = 'Schema Usage Log'
        verbose_name_plural = 'Schema Usage Logs'
        indexes = [
            models.Index(fields=['schema_id'], name='idx_log_schema'),
            models.Index(fields=['user_id'], name='idx_log_user'),
            models.Index(fields=['-created_at'], name='idx_log_created'),
            models.Index(fields=['success'], name='idx_log_success'),
        ]
        ordering = ['-created_at']

    def __str__(self):
        status = "✓" if self.success else "✗"
        return f"{status} {self.schema} - {self.created_at.strftime('%Y-%m-%d %H:%M')}"

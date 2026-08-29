import uuid

from django.conf import settings
from django.db import models

from apps.schema_discovery.models import GeneratedSchema


class TemplateUsage(models.Model):
    """
    模板使用记录

    记录用户应用模板时填入的变量、渲染结果以及生成的 Schema ID。
    """

    STATUS_CHOICES = [
        ('pending', '处理中'),
        ('success', '成功'),
        ('failed', '失败'),
    ]

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
        help_text='使用记录 ID'
    )
    template = models.ForeignKey(
        'schema_market.MarketTemplate',
        on_delete=models.CASCADE,
        related_name='usages'
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='schema_market_usages',
        db_constraint=False,
    )
    workspace_id = models.UUIDField(
        null=True,
        blank=True,
        help_text='关联的 workspace ID（可选）'
    )
    project_id = models.UUIDField(
        null=True,
        blank=True,
        help_text='关联的 project ID（可选）'
    )
    rendered_url = models.CharField(
        max_length=500,
        help_text='渲染后的 URL'
    )
    variables_filled = models.JSONField(
        default=dict,
        help_text='用户填写的变量值'
    )
    rendered_schema = models.JSONField(
        help_text='渲染后的 Schema JSON'
    )
    generated_schema = models.ForeignKey(
        GeneratedSchema,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='template_usages',
        help_text='保存到 Schema Discovery 的 Schema（如有）'
    )
    status = models.CharField(
        max_length=16,
        choices=STATUS_CHOICES,
        default='pending',
        help_text='状态'
    )
    message = models.TextField(
        blank=True,
        help_text='附加信息或错误描述'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'schema_market_template_usage'
        verbose_name = 'Schema 模板使用记录'
        verbose_name_plural = 'Schema 模板使用记录'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', 'created_at'], name='idx_schema_usage_user_created'),
            models.Index(fields=['status'], name='idx_schema_usage_status'),
        ]

    def __str__(self) -> str:
        return f'{self.template.slug} by {self.user_id} ({self.status})'

"""Schema Template Model

模板库：存储各类 Schema 模块的模板定义
"""

from django.db import models
import uuid


class SchemaTemplate(models.Model):
    """Schema 模板定义

    用途：
    - 存储各类 Schema 模块的模板定义（basic_schema, pagination_schema, detail_page_schema）
    - Coordinator 根据 required_modules 加载对应模板
    - 支持模板版本管理和更新
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
        help_text="模板 ID"
    )

    module_name = models.CharField(
        max_length=50,
        db_index=True,
        unique=True,
        help_text="模块名称（如 basic_schema, pagination_schema）"
    )

    template_json = models.JSONField(
        help_text="模板定义（PostgreSQL JSONB）"
    )

    description = models.TextField(
        blank=True,
        help_text="模板描述"
    )

    version = models.CharField(
        max_length=20,
        default="1.0.0",
        help_text="模板版本"
    )

    is_active = models.BooleanField(
        default=True,
        help_text="是否激活"
    )

    created_at = models.DateTimeField(
        auto_now_add=True,
        help_text="创建时间"
    )

    updated_at = models.DateTimeField(
        auto_now=True,
        help_text="更新时间"
    )

    class Meta:
        db_table = 'schema_templates'
        verbose_name = 'Schema Template'
        verbose_name_plural = 'Schema Templates'
        indexes = [
            models.Index(fields=['module_name'], name='idx_template_module'),
            models.Index(fields=['is_active'], name='idx_template_active'),
        ]
        ordering = ['module_name']

    def __str__(self):
        return f"{self.module_name} (v{self.version})"

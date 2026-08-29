import uuid
from typing import List

from django.db import models

from apps.schema_discovery.models import GeneratedSchema


class MarketTemplate(models.Model):
    """
    Schema 模板市场条目

    用于存储官方/运营同学在后台配置的高质量 Schema，
    支持变量化配置、快速渲染和复用。
    """

    CATEGORY_CHOICES = [
        ('product_manager', '产品经理'),
        ('operations', '运营'),
        ('developer', '开发者'),
        ('investor', '投资人'),
        ('creator', '内容创作者'),
        ('ecommerce', '电商'),
        ('researcher', '研究'),
        ('general', '通用'),
    ]

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
        help_text='模板 ID'
    )
    name = models.CharField(
        max_length=100,
        help_text='模板名称（展示给用户）'
    )
    slug = models.SlugField(
        unique=True,
        help_text='模板唯一标识，作为 API 访问路径'
    )
    icon = models.CharField(
        max_length=16,
        default='📄',
        help_text='Emoji 或 Icon 名称'
    )
    summary = models.CharField(
        max_length=200,
        help_text='一句话描述'
    )
    description = models.TextField(
        blank=True,
        help_text='详细描述'
    )
    category = models.CharField(
        max_length=32,
        choices=CATEGORY_CHOICES,
        default='general',
        help_text='模板主要面向的用户角色'
    )
    tags = models.JSONField(default=list, blank=True, help_text='标签列表，便于筛选')
    schema_source = models.ForeignKey(
        GeneratedSchema,
        on_delete=models.SET_NULL,
        related_name='market_templates',
        null=True,
        blank=True,
        help_text='可选：关联已有的 GeneratedSchema，作为 Schema 数据源'
    )
    schema_json = models.JSONField(
        help_text='默认 Schema JSON（遵循 Schema Discovery 规范）'
    )
    variables_schema = models.JSONField(
        default=dict,
        help_text='变量定义，描述可配置字段及校验规则'
    )
    url_template = models.CharField(
        max_length=500,
        help_text='基础 URL 模板，可包含 {variable} 占位符'
    )
    preview_schema = models.JSONField(
        default=dict,
        blank=True,
        help_text='Schema 预览（用于前端展示）'
    )
    preview_data = models.JSONField(
        default=dict,
        blank=True,
        help_text='样例数据（用于前端展示）'
    )
    refresh_config = models.JSONField(
        default=dict,
        blank=True,
        help_text='可选：推荐的刷新配置（Cron、策略等）'
    )
    documentation_url = models.URLField(
        blank=True,
        help_text='外部文档链接（如 PRD、使用指南）'
    )
    is_official = models.BooleanField(
        default=True,
        help_text='是否为官方模板'
    )
    is_active = models.BooleanField(
        default=True,
        help_text='是否对外可见'
    )
    display_order = models.IntegerField(
        default=0,
        help_text='展示排序，越大越靠前'
    )
    usage_count = models.IntegerField(
        default=0,
        help_text='使用次数'
    )
    last_used_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text='最后一次被使用的时间'
    )
    extra_metadata = models.JSONField(
        default=dict,
        blank=True,
        help_text='扩展信息（如数据源、采集说明）'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'schema_market_templates'
        verbose_name = 'Schema 市场模板'
        verbose_name_plural = 'Schema 市场模板'
        ordering = ['-is_official', '-display_order', 'name']
        indexes = [
            models.Index(fields=['category'], name='idx_schema_market_category'),
            models.Index(fields=['is_active'], name='idx_schema_market_active'),
        ]

    def __str__(self) -> str:
        return f'{self.name} ({self.slug})'

    @property
    def categories(self) -> List[str]:
        """兼容旧接口，返回 tags + category。"""
        return [self.category, *self.tags]

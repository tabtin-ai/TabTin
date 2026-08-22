import uuid

from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from .constants import (
    DEFAULT_SEARCH_COUNT,
    DEFAULT_SEARCH_FRESHNESS,
    DEFAULT_SEARCH_PROVIDER_KEY,
    DEFAULT_SEARCH_TIMEOUT_SEC,
    QIANFAN_API_KEY_ENV_NAME,
    QIANFAN_SEARCH_BASE_URL,
)


class SearchProvider(models.Model):
    PROVIDER_TYPE_CHOICES = [
        ("qianfan", "千帆百度搜索"),
        ("bocha", "博查搜索"),
        ("doubao", "豆包搜索"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider_type = models.CharField(
        max_length=50,
        choices=PROVIDER_TYPE_CHOICES,
        default="qianfan",
        db_index=True,
        verbose_name="提供商类型",
    )
    provider_key = models.CharField(max_length=100, unique=True, db_index=True, verbose_name="提供商标识")
    display_name = models.CharField(max_length=100, verbose_name="显示名称")
    base_url = models.URLField(default=QIANFAN_SEARCH_BASE_URL, verbose_name="搜索接口地址")
    api_key = models.CharField(max_length=500, blank=True, default="", verbose_name="API Key 覆盖值")
    api_key_env_name = models.CharField(
        max_length=100,
        blank=True,
        default=QIANFAN_API_KEY_ENV_NAME,
        verbose_name="API Key 环境变量名",
    )
    request_timeout_sec = models.PositiveIntegerField(
        default=DEFAULT_SEARCH_TIMEOUT_SEC,
        validators=[MinValueValidator(1), MaxValueValidator(120)],
        verbose_name="请求超时(秒)",
    )
    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")
    priority = models.IntegerField(default=100, verbose_name="优先级")
    capabilities_config = models.JSONField(default=dict, blank=True, verbose_name="能力配置")
    extra_config = models.JSONField(default=dict, blank=True, verbose_name="扩展配置")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_search_provider"
        verbose_name = "搜索提供商"
        verbose_name_plural = "搜索提供商"
        ordering = ["-priority", "-created_at"]
        indexes = [
            models.Index(fields=["provider_type", "is_active"], name="srch_type_active_idx"),
            models.Index(fields=["provider_key", "is_active"], name="srch_key_active_idx"),
        ]

    def save(self, *args, **kwargs):
        if not self.provider_key:
            self.provider_key = self.provider_type
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.display_name} ({self.provider_key})"


class SearchGlobalConfig(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    default_provider_key = models.CharField(
        max_length=100,
        default=DEFAULT_SEARCH_PROVIDER_KEY,
        verbose_name="默认搜索提供商",
    )
    default_count = models.PositiveSmallIntegerField(
        default=DEFAULT_SEARCH_COUNT,
        validators=[MinValueValidator(1), MaxValueValidator(50)],
        verbose_name="默认返回条数",
    )
    default_summary_enabled = models.BooleanField(default=True, verbose_name="默认开启摘要")
    default_freshness = models.CharField(
        max_length=64,
        default=DEFAULT_SEARCH_FRESHNESS,
        verbose_name="默认时间范围",
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_search_global_config"
        verbose_name = "搜索全局配置"
        verbose_name_plural = "搜索全局配置"
        ordering = ["-updated_at", "-created_at"]

    def __str__(self):
        return f"default={self.default_provider_key}, count={self.default_count}"

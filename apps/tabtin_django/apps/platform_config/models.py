from __future__ import annotations

from django.conf import settings
from django.db import models


class PlatformRuntimeConfigItem(models.Model):
    class ValueType(models.TextChoices):
        STRING = "string", "字符串"
        INTEGER = "integer", "整数"
        DECIMAL = "decimal", "小数"
        BOOLEAN = "boolean", "布尔"
        JSON = "json", "JSON"

    key = models.CharField(
        max_length=120,
        unique=True,
        verbose_name="配置键",
        help_text="建议使用命名空间格式，例如 product_limits.max_organizations_per_user",
    )
    name = models.CharField(max_length=120, verbose_name="配置名称")
    description = models.TextField(blank=True, verbose_name="配置说明")
    category = models.CharField(max_length=64, db_index=True, verbose_name="配置分类")
    value_type = models.CharField(
        max_length=20,
        choices=ValueType.choices,
        default=ValueType.STRING,
        verbose_name="值类型",
    )
    value = models.JSONField(default=dict, verbose_name="配置值")
    default_value = models.JSONField(default=dict, verbose_name="默认值")
    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")
    is_system = models.BooleanField(default=False, verbose_name="系统内置")
    sort_order = models.IntegerField(default=0, verbose_name="排序")
    extra_schema = models.JSONField(
        default=dict,
        blank=True,
        verbose_name="前端表单元数据",
        help_text="用于描述 min/max/options/group 等 UI 元数据，不参与运行时判断。",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="updated_platform_runtime_configs",
        verbose_name="最后修改人",
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "platform_runtime_config_item"
        verbose_name = "平台运行时配置"
        verbose_name_plural = "平台运行时配置"
        ordering = ["category", "sort_order", "key"]
        indexes = [
            models.Index(fields=["category", "is_active"], name="plat_cfg_cat_active_idx"),
            models.Index(fields=["updated_at"], name="plat_cfg_updated_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                name="plat_cfg_key_not_blank",
                check=~models.Q(key=""),
            ),
            models.CheckConstraint(
                name="plat_cfg_category_not_blank",
                check=~models.Q(category=""),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.key}={self.value}"

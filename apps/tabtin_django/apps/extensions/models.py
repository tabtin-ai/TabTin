"""Extension 数据模型

ExtensionConnection：Space 级别的 Extension 连接配置。
ExtensionEventLog：Extension 产生的事件日志。
ExtensionWebhookSubscription：事件 → 外部 webhook 的订阅。
"""

from __future__ import annotations

import uuid
from typing import Any

from django.db import models

from apps.extensions.constants import AuthType, ConnectionStatus, EventLogStatus, NotificationPriority
from apps.extensions.fields import EncryptedCharField, EncryptedJSONField


class ExtensionConnection(models.Model):
    """Space 与 Extension 的连接配置。

    每个 Space 可以独立连接到一个 Extension 实例，
    存储认证凭证和运行时状态。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    extension_id = models.CharField(
        max_length=64,
        verbose_name="Extension 标识",
        help_text="对应 BaseExtension.id，如 tabmail / telegram / 等",
    )
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    space_id = models.CharField(
        max_length=100,
        null=True,
        blank=True,
        verbose_name="Agent 空间ID",
        help_text="null 表示 organization 级连接",
    )
    name = models.CharField(
        max_length=200, null=True, blank=True, verbose_name="连接名称"
    )
    enabled = models.BooleanField(default=True, verbose_name="是否启用")

    auth_type = models.CharField(
        max_length=32,
        default=AuthType.NONE,
        choices=AuthType.choices,
        verbose_name="认证方式",
    )
    config = EncryptedJSONField(
        default=dict,
        verbose_name="连接配置",
        help_text="存储 API Key、OAuth token 等凭证和配置项（加密存储）",
    )
    status = models.CharField(
        max_length=32,
        default=ConnectionStatus.DISCONNECTED,
        choices=ConnectionStatus.choices,
        verbose_name="连接状态",
    )
    last_error = models.TextField(null=True, blank=True, verbose_name="最后错误")
    last_probe_at = models.DateTimeField(null=True, blank=True, verbose_name="上次探测时间")

    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "ext_connection"
        verbose_name = "Extension 连接"
        verbose_name_plural = "Extension 连接"
        indexes = [
            models.Index(
                fields=["organization_id", "extension_id"],
                name="ext_conn_ws_ext_idx",
            ),
            models.Index(
                fields=["space_id"],
                name="ext_conn_as_idx",
            ),
            models.Index(
                fields=["status"],
                name="ext_conn_status_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["extension_id", "organization_id", "space_id"],
                name="ext_conn_unique_with_as",
                condition=models.Q(space_id__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["extension_id", "organization_id"],
                name="ext_conn_unique_ws_level",
                condition=models.Q(space_id__isnull=True),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.extension_id}:{self.organization_id}:{self.space_id or 'ws'}"

    def get_config_value(self, key: str, default: Any = None) -> Any:
        """安全地读取 config 中的某个字段。"""
        return (self.config or {}).get(key, default)


class ExtensionEventLog(models.Model):
    """Extension 产生的事件日志。

    用于审计、调试和事件重放。
    """

    STATUS_CHOICES = EventLogStatus.choices

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    extension_id = models.CharField(max_length=64, verbose_name="Extension 标识")
    connection_id = models.UUIDField(
        null=True, blank=True, verbose_name="连接ID"
    )
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    space_id = models.CharField(
        max_length=100, null=True, blank=True, verbose_name="Agent 空间ID",
    )

    event_type = models.CharField(
        max_length=128,
        verbose_name="事件类型",
        help_text="如 email.received, telegram.message_received",
    )
    event_data = models.JSONField(default=dict, verbose_name="事件数据")
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default="pending"
    )

    consumer_results = models.JSONField(
        default=dict,
        verbose_name="消费结果",
        help_text="各消费者的处理结果",
    )
    error_message = models.TextField(null=True, blank=True, verbose_name="错误信息")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    processed_at = models.DateTimeField(null=True, blank=True, verbose_name="处理时间")

    class Meta:
        db_table = "ext_event_log"
        verbose_name = "Extension 事件日志"
        verbose_name_plural = "Extension 事件日志"
        indexes = [
            models.Index(
                fields=["organization_id", "extension_id"],
                name="ext_evt_ws_ext_idx",
            ),
            models.Index(
                fields=["event_type", "status"],
                name="ext_evt_type_status_idx",
            ),
            models.Index(
                fields=["created_at"],
                name="ext_evt_created_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.extension_id}:{self.event_type}:{self.status}"


class NotificationRule(models.Model):
    """通知规则：定义哪些事件类型产生通知、投递渠道和优先级。

    支持 Organization 全局规则和 Space 级覆盖。
    event_pattern 使用 fnmatch 通配符语法，如 "email.*"、"*.failed"。
    """

    PRIORITY_CHOICES = NotificationPriority.choices

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.CharField(max_length=100, db_index=True, verbose_name="组织ID")
    space_id = models.CharField(
        max_length=100, null=True, blank=True, verbose_name="Agent 空间ID",
        help_text="null 表示 organization 级规则",
    )

    event_pattern = models.CharField(
        max_length=200, verbose_name="事件匹配模式",
        help_text='fnmatch 语法，如 "email.*"、"*.failed"',
    )
    source_extension_id = models.CharField(
        max_length=64, blank=True, default="", verbose_name="来源 Extension",
        help_text="空=匹配所有来源",
    )

    channels = models.JSONField(
        default=list, verbose_name="投递渠道",
        help_text='如 ["in_app", "desktop"]',
    )
    priority = models.CharField(
        max_length=16, default="normal", choices=PRIORITY_CHOICES, verbose_name="优先级",
    )
    category = models.CharField(max_length=64, default="general", verbose_name="分类标签")

    title_template = models.CharField(
        max_length=500, blank=True, default="", verbose_name="标题模板",
        help_text="支持 {event_type}, {source} 等变量",
    )
    body_template = models.TextField(blank=True, default="", verbose_name="正文模板")

    enabled = models.BooleanField(default=True, verbose_name="是否启用")
    is_system = models.BooleanField(
        default=False, verbose_name="系统内置",
        help_text="系统内置规则不可删除",
    )
    sort_order = models.IntegerField(default=0, verbose_name="排序权重")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "ext_notification_rule"
        verbose_name = "通知规则"
        verbose_name_plural = "通知规则"
        ordering = ["sort_order", "-created_at"]
        indexes = [
            models.Index(
                fields=["organization_id", "enabled"],
                name="ext_nrule_ws_enabled_idx",
            ),
            models.Index(
                fields=["organization_id", "space_id"],
                name="ext_nrule_ws_as_idx",
            ),
        ]

    def __str__(self) -> str:
        scope = self.space_id or "ws"
        return f"rule:{self.event_pattern}@{scope}"


class ExtensionWebhookSubscription(models.Model):
    """Extension 事件的 Webhook 出站订阅。

    用户可订阅特定事件类型，当事件发生时通过 HTTP POST 推送到指定 URL。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    space_id = models.CharField(
        max_length=100, null=True, blank=True, verbose_name="Agent 空间ID",
    )

    url = models.URLField(max_length=2048, verbose_name="Webhook URL")
    secret = EncryptedCharField(
        max_length=128, verbose_name="签名密钥"
    )
    event_types = models.JSONField(
        default=list,
        verbose_name="订阅事件列表",
        help_text='如 ["email.received", "telegram.message_received"]',
    )
    is_active = models.BooleanField(default=True, verbose_name="是否启用")

    max_retries = models.PositiveSmallIntegerField(default=3, verbose_name="最大重试次数")
    total_deliveries = models.PositiveIntegerField(default=0, verbose_name="总投递次数")
    failed_deliveries = models.PositiveIntegerField(default=0, verbose_name="失败次数")
    consecutive_failures = models.PositiveIntegerField(
        default=0, verbose_name="连续失败次数"
    )
    last_triggered_at = models.DateTimeField(
        null=True, blank=True, verbose_name="上次触发时间"
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "ext_webhook_subscription"
        verbose_name = "Extension Webhook 订阅"
        verbose_name_plural = "Extension Webhook 订阅"
        indexes = [
            models.Index(
                fields=["organization_id", "is_active"],
                name="ext_wh_ws_active_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"webhook:{self.url}:{self.is_active}"

    def matches_event(self, event_type: str) -> bool:
        """判断此订阅是否匹配给定的事件类型。"""
        if not self.event_types:
            return True  # 空列表 = 订阅所有事件
        return event_type in self.event_types

"""
Webhook 订阅模型

支持 Organization 级和表级数据变更事件订阅。
外部系统通过 Open API 注册 webhook URL，
当匹配的事件发生时异步投递 HTTP POST 通知。
"""
import secrets
import uuid

from django.conf import settings
from django.db import models


class TableWebhook(models.Model):
    """数据变更 Webhook 订阅"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # 云端资源归属：Webhook 属于 Organization；space_id 仅保留为入口上下文/兼容字段。
    organization_id = models.UUIDField(null=True, blank=True, db_index=True, help_text='归属 Organization ID')

    # 兼容旧 Space 开发者入口。新语义下 Space 是本地执行上下文，不拥有 Webhook。
    space_id = models.UUIDField(null=True, blank=True, db_index=True, help_text='Space 上下文 ID（兼容字段）')

    # 关联的表格（可选，null 表示订阅 Organization 内所有表格）
    table_id = models.UUIDField(null=True, blank=True, db_index=True, help_text='关联的表格 ID（null=全 Organization）')

    # 投递目标
    url = models.URLField(max_length=2048, help_text='Webhook 投递地址（HTTPS）')

    # HMAC 签名密钥
    secret = models.CharField(
        max_length=128,
        default='',
        blank=True,
        help_text='HMAC-SHA256 签名密钥，用于验证请求来源',
    )

    # 订阅的事件列表
    events = models.JSONField(
        default=list,
        help_text='订阅的事件类型列表，如 ["record.created", "record.updated", "record.deleted", "field.changed"]',
    )

    # 状态
    is_active = models.BooleanField(default=True, help_text='是否启用')

    # 重试配置
    max_retries = models.PositiveSmallIntegerField(default=3, help_text='最大重试次数')

    # 创建者（跨库引用，禁用 DB 层 FK 约束）
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='tabdata_webhooks',
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    last_triggered_at = models.DateTimeField(null=True, blank=True, help_text='上次触发时间')

    # 投递统计
    total_deliveries = models.PositiveIntegerField(default=0)
    failed_deliveries = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = 'tabdata_webhook'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['organization_id', 'is_active']),
            models.Index(fields=['space_id', 'is_active']),
            models.Index(fields=['table_id', 'is_active']),
        ]

    def __str__(self):
        scope = f'table:{self.table_id}' if self.table_id else f'organization:{self.organization_id}'
        return f'Webhook({scope} → {self.url})'

    @staticmethod
    def generate_secret() -> str:
        """生成随机签名密钥"""
        return secrets.token_hex(32)

    def matches_event(self, event_type: str, table_id: str = None) -> bool:
        """判断此 webhook 是否匹配指定事件"""
        if not self.is_active:
            return False

        # 事件类型匹配
        if self.events and event_type not in self.events:
            return False

        # 表级 webhook 只匹配指定表
        if self.table_id and table_id and str(self.table_id) != str(table_id):
            return False

        return True


class WebhookDeliveryFailure(models.Model):
    """Webhook 投递死信日志（DATA-13）

    当 deliver_single_webhook 耗尽所有重试后，将失败事件写入此表，
    供运维排查和手动重发。
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    webhook_id = models.CharField(max_length=64, db_index=True)
    space_id = models.CharField(max_length=64, default='', blank=True, db_index=True)
    event_type = models.CharField(max_length=128, default='', blank=True)
    payload = models.JSONField(default=dict)
    error = models.TextField(default='', blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'tabdata_webhook_delivery_failure'
        ordering = ['-created_at']


# 支持的事件类型
WEBHOOK_EVENT_TYPES = [
    'record.created',
    'record.updated',
    'record.deleted',
    'record.batch_created',
    'record.batch_updated',
    'record.batch_deleted',
    'field.created',
    'field.updated',
    'field.deleted',
]

"""Channel Gateway 数据模型"""

from __future__ import annotations

import uuid
from django.db import models
from apps.extensions.fields import EncryptedJSONField


class ChannelBinding(models.Model):
    """外部渠道会话与内部会话的绑定"""

    STATUS_CHOICES = [
        ("active", "启用"),
        ("paused", "暂停"),
        ("blocked", "禁用"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.CharField(max_length=50, verbose_name="渠道")
    account_id = models.CharField(max_length=100, verbose_name="账号ID", default="default")
    peer_kind = models.CharField(max_length=20, verbose_name="会话类型")
    peer_id = models.CharField(max_length=255, verbose_name="会话ID")
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    identity_user_id = models.CharField(max_length=100, null=True, blank=True, verbose_name="Identity 用户ID")
    execution_agent_id = models.CharField(max_length=100, null=True, blank=True, verbose_name="执行 Agent ID")
    execution_workspace_id = models.CharField(max_length=100, null=True, blank=True, verbose_name="执行 Workspace ID")
    handling_space_id = models.CharField(max_length=100, null=True, blank=True, verbose_name="处理 Space ID")
    space_id = models.CharField(max_length=100, null=True, blank=True, verbose_name="Agent 空间ID")
    session_id = models.UUIDField(null=True, blank=True, verbose_name="ChatSession ID")
    thread_id = models.CharField(max_length=255, null=True, blank=True, verbose_name="Thread ID")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="active", verbose_name="状态")
    last_message_id = models.CharField(max_length=255, null=True, blank=True, verbose_name="最后消息ID")
    metadata = models.JSONField(default=dict, verbose_name="扩展信息")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "channel_gateway_binding"
        verbose_name = "渠道绑定"
        verbose_name_plural = "渠道绑定"
        unique_together = [["channel", "account_id", "peer_id", "organization_id"]]
        indexes = [
            models.Index(fields=["channel", "account_id", "peer_id"], name="cg_bind_channel_peer_idx"),
            models.Index(fields=["organization_id"], name="cg_bind_organization_idx"),
            models.Index(fields=["identity_user_id"], name="cg_bind_identity_user_idx"),
            models.Index(fields=["execution_agent_id"], name="cg_bind_execution_agent_idx"),
            models.Index(fields=["execution_workspace_id"], name="cg_bind_execution_ws_idx"),
            models.Index(fields=["handling_space_id"], name="cg_bind_handling_space_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.channel}:{self.account_id}:{self.peer_kind}:{self.peer_id}"

    @property
    def effective_handling_space_id(self) -> str | None:
        return self.handling_space_id or self.space_id or None

    @property
    def effective_execution_agent_id(self) -> str | None:
        return self.execution_agent_id or None


class ChannelAccount(models.Model):
    """渠道账号配置"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.CharField(max_length=50, verbose_name="渠道")
    account_id = models.CharField(max_length=100, verbose_name="账号ID", default="default")
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    name = models.CharField(max_length=100, null=True, blank=True, verbose_name="账号名称")
    enabled = models.BooleanField(default=True, verbose_name="是否启用")
    config = EncryptedJSONField(default=dict, verbose_name="账号配置")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "channel_gateway_account"
        verbose_name = "渠道账号"
        verbose_name_plural = "渠道账号"
        unique_together = [["channel", "account_id", "organization_id"]]
        indexes = [
            models.Index(fields=["organization_id"], name="cg_account_organization_idx"),
            models.Index(fields=["channel", "account_id"], name="cg_account_channel_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.channel}:{self.account_id}"


class ChannelRuntimeStatus(models.Model):
    """渠道运行状态缓存（包含 QR 等）"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.CharField(max_length=50, verbose_name="渠道")
    account_id = models.CharField(max_length=100, verbose_name="账号ID", default="default")
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    status = models.CharField(max_length=32, verbose_name="运行状态")
    last_error = models.TextField(null=True, blank=True, verbose_name="最后错误")
    qr = models.TextField(null=True, blank=True, verbose_name="登录二维码")
    details = models.JSONField(default=dict, verbose_name="状态详情")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "channel_gateway_runtime_status"
        verbose_name = "渠道运行状态"
        verbose_name_plural = "渠道运行状态"
        unique_together = [["channel", "account_id", "organization_id"]]
        indexes = [
            models.Index(fields=["organization_id"], name="cg_runtime_organization_idx"),
            models.Index(fields=["channel", "account_id"], name="cg_runtime_channel_idx"),
            models.Index(fields=["status"], name="cg_runtime_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.channel}:{self.account_id}:{self.status}"


class ChannelInboundMessageLog(models.Model):
    """入站消息去重记录"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.CharField(max_length=50, verbose_name="渠道")
    account_id = models.CharField(max_length=100, verbose_name="账号ID", default="default")
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    peer_id = models.CharField(max_length=255, verbose_name="会话ID")
    message_id = models.CharField(max_length=255, verbose_name="消息ID")
    received_at = models.DateTimeField(auto_now_add=True, verbose_name="接收时间")

    class Meta:
        db_table = "channel_gateway_inbound_log"
        verbose_name = "渠道入站消息记录"
        verbose_name_plural = "渠道入站消息记录"
        unique_together = [["channel", "account_id", "organization_id", "peer_id", "message_id"]]
        indexes = [
            models.Index(fields=["organization_id"], name="cg_inbound_organization_idx"),
            models.Index(fields=["channel", "account_id"], name="cg_inbound_channel_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.channel}:{self.account_id}:{self.peer_id}:{self.message_id}"


class ChannelOutboundMessageRecord(models.Model):
    """出站消息 Outbox"""

    STATUS_CHOICES = [
        ("pending", "待发送"),
        ("dispatched", "已分发待确认"),
        ("sent", "已发送"),
        ("failed", "失败"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.CharField(max_length=50, verbose_name="渠道")
    account_id = models.CharField(max_length=100, verbose_name="账号ID", default="default")
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    peer_id = models.CharField(max_length=255, verbose_name="会话ID")
    payload = models.JSONField(default=dict, verbose_name="消息内容")
    idempotency_key = models.CharField(max_length=255, null=True, blank=True, verbose_name="幂等Key")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="pending", verbose_name="状态")
    attempts = models.PositiveIntegerField(default=0, verbose_name="尝试次数")
    next_retry_at = models.DateTimeField(null=True, blank=True, verbose_name="下次重试时间")
    last_error = models.TextField(null=True, blank=True, verbose_name="最后错误")
    sent_at = models.DateTimeField(null=True, blank=True, verbose_name="发送时间")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "channel_gateway_outbox"
        verbose_name = "渠道出站消息"
        verbose_name_plural = "渠道出站消息"
        indexes = [
            models.Index(fields=["organization_id"], name="cg_outbox_organization_idx"),
            models.Index(fields=["status", "next_retry_at"], name="cg_outbox_status_retry_idx"),
            models.Index(fields=["channel", "account_id"], name="cg_outbox_channel_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.channel}:{self.account_id}:{self.peer_id}:{self.status}"


class ChannelAllowlistEntry(models.Model):
    """渠道 allowlist 配置"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.CharField(max_length=50, verbose_name="渠道")
    account_id = models.CharField(max_length=100, verbose_name="账号ID", default="default")
    peer_kind = models.CharField(max_length=20, verbose_name="会话类型")
    peer_id = models.CharField(max_length=255, verbose_name="会话ID")
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    allow = models.BooleanField(default=True, verbose_name="是否允许")
    note = models.CharField(max_length=255, null=True, blank=True, verbose_name="备注")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "channel_gateway_allowlist"
        verbose_name = "渠道 Allowlist"
        verbose_name_plural = "渠道 Allowlist"
        indexes = [
            models.Index(fields=["organization_id"], name="cg_allow_organization_idx"),
            models.Index(fields=["channel", "account_id", "peer_kind"], name="cg_allow_channel_kind_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.channel}:{self.account_id}:{self.peer_kind}:{self.peer_id}"


class ChannelPairingRequest(models.Model):
    """渠道配对请求"""

    STATUS_CHOICES = [
        ("pending", "待处理"),
        ("approved", "已通过"),
        ("rejected", "已拒绝"),
        ("expired", "已过期"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.CharField(max_length=50, verbose_name="渠道")
    account_id = models.CharField(max_length=100, verbose_name="账号ID", default="default")
    peer_kind = models.CharField(max_length=20, verbose_name="会话类型")
    peer_id = models.CharField(max_length=255, verbose_name="会话ID")
    organization_id = models.CharField(max_length=100, verbose_name="组织ID")
    code = models.CharField(max_length=20, verbose_name="配对码")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="pending", verbose_name="状态")
    expires_at = models.DateTimeField(verbose_name="过期时间")
    resolved_at = models.DateTimeField(null=True, blank=True, verbose_name="处理时间")
    resolved_by = models.CharField(max_length=100, null=True, blank=True, verbose_name="处理人")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "channel_gateway_pairing"
        verbose_name = "渠道配对请求"
        verbose_name_plural = "渠道配对请求"
        indexes = [
            models.Index(fields=["organization_id", "status"], name="cg_pair_organization_st_idx"),
            models.Index(fields=["channel", "account_id", "peer_id"], name="cg_pair_channel_peer_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.channel}:{self.account_id}:{self.peer_kind}:{self.peer_id}:{self.status}"

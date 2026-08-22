"""IM 上下文交接包数据模型（Phase 0 定稿，后续阶段只加不改）。

四张表：
- HandoffPackage：交接包本体（四区块 + 范围 + 状态 + 版本）
- HandoffRecipient：包 × 接收者，逐人状态机
- HandoffReference：受控材料引用（快照摘要 + 回源读取 + 查看时鉴权）
- HandoffEvent：审计流水（append-only）

设计约束（对齐 tabchat 既有模式）：
- app_label 均为 "tabchat"，migration 走 tabchat 链（子域不单独立 app）
- 跨域引用（user/agent）存 CharField 软引用 + XOR CHECK（同 ConversationMember）
- 会话内引用（Conversation/Message）用真实 FK
"""

from __future__ import annotations

import uuid

from django.db import models


class HandoffPackage(models.Model):
    """上下文交接包本体。

    发起人 user/agent 二选一（Agent 是一等发起方，卡片显著标注来源身份）。
    状态机：draft → sent → (superseded / revoked)。
    """

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        SENT = "sent", "已发送"
        SUPERSEDED = "superseded", "已被新版本取代"
        REVOKED = "revoked", "已撤销"

    class Scope(models.TextChoices):
        VIEW_ONLY = "view_only", "仅查看"
        CONTINUABLE = "continuable", "可继续"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        "tabchat.Conversation",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="handoff_packages",
    )
    conversation_ref = models.CharField(max_length=100, blank=True, db_index=True)
    organization_id = models.CharField(max_length=100, db_index=True)
    initiator_user_id = models.CharField(max_length=100, null=True, blank=True)
    initiator_agent_id = models.CharField(
        max_length=100, null=True, blank=True,
        help_text="Agent 发起的交接包（与 initiator_user_id 互斥，二选一）",
    )
    goal = models.CharField(max_length=500, help_text="工作目标（必填，短文本）")
    progress_json = models.JSONField(
        default=list,
        help_text="当前进展要点数组：[{text}]",
    )
    next_steps_json = models.JSONField(
        default=list,
        help_text="下一步 checklist 数组：[{text, checked}]",
    )
    risks_json = models.JSONField(
        default=list, blank=True,
        help_text="待确认/风险数组：[{text, high_risk}]",
    )
    scope = models.CharField(
        max_length=20, choices=Scope.choices, default=Scope.CONTINUABLE,
    )
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.DRAFT,
    )
    version = models.PositiveIntegerField(default=1, help_text="补充版本号，Phase 3 起使用")
    card_message = models.ForeignKey(
        "tabchat.Message",
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text="发送后承载卡片的 IM 消息",
    )
    card_message_ref = models.UUIDField(null=True, blank=True)
    card_message_sequence = models.BigIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_handoff_package"
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(initiator_user_id__isnull=False, initiator_agent_id__isnull=True)
                    | models.Q(initiator_user_id__isnull=True, initiator_agent_id__isnull=False)
                ),
                name="tabchat_handoff_initiator_xor",
            ),
            models.CheckConstraint(
                check=models.Q(version__gte=1),
                name="tabchat_handoff_version_positive",
            ),
        ]
        indexes = [
            models.Index(
                fields=["conversation", "-created_at"],
                name="tabchat_handoff_conv_idx",
            ),
            models.Index(
                fields=["initiator_user_id", "-created_at"],
                name="tabchat_handoff_init_user_idx",
            ),
            models.Index(
                fields=["initiator_agent_id", "-created_at"],
                name="tabchat_handoff_init_agent_idx",
            ),
        ]

    @property
    def initiator_type(self) -> str:
        return "agent" if self.initiator_agent_id else "user"

    def __str__(self) -> str:
        who = self.initiator_user_id or f"agent:{self.initiator_agent_id}"
        return f"Handoff {self.id} [{self.status}] by {who}"


class HandoffRecipient(models.Model):
    """包 × 接收者，逐人状态机。

    v1 接收者为会话内 user；agent 字段预留（复用 XOR 约束模式）。
    状态机：sent → viewed → acknowledged / taking_over / delegated_to_agent / rejected。
    """

    class State(models.TextChoices):
        SENT = "sent", "已发送"
        VIEWED = "viewed", "已查看"
        ACKNOWLEDGED = "acknowledged", "已了解"
        TAKING_OVER = "taking_over", "由我继续"
        DELEGATED_TO_AGENT = "delegated_to_agent", "已交给 Agent"
        REJECTED = "rejected", "已拒绝"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    package = models.ForeignKey(
        HandoffPackage,
        on_delete=models.CASCADE,
        related_name="recipients",
    )
    user_id = models.CharField(max_length=100, null=True, blank=True)
    agent_id = models.CharField(
        max_length=100, null=True, blank=True,
        help_text="Agent 接收者（Phase 2 起；与 user_id 互斥）",
    )
    state = models.CharField(
        max_length=32, choices=State.choices, default=State.SENT,
    )
    note = models.CharField(
        max_length=500, blank=True, default="",
        help_text="接手备注 / 拒绝原因",
    )
    linked_session_id = models.CharField(
        max_length=100, blank=True, default="",
        help_text="Phase 2：接手后创建的 Agent 任务会话",
    )
    linked_tracker_ref = models.CharField(
        max_length=200, blank=True, default="",
        help_text="Phase 3：关联的 Tracker 任务引用",
    )
    state_changed_at = models.DateTimeField(auto_now_add=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_handoff_recipient"
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(user_id__isnull=False, agent_id__isnull=True)
                    | models.Q(user_id__isnull=True, agent_id__isnull=False)
                ),
                name="tabchat_handoff_rcpt_xor",
            ),
            models.UniqueConstraint(
                fields=["package", "user_id"],
                condition=models.Q(user_id__isnull=False),
                name="tabchat_handoff_rcpt_user_uniq",
            ),
            models.UniqueConstraint(
                fields=["package", "agent_id"],
                condition=models.Q(agent_id__isnull=False),
                name="tabchat_handoff_rcpt_agent_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user_id", "-created_at"],
                name="tabchat_handoff_rcpt_user_idx",
            ),
        ]

    def __str__(self) -> str:
        ident = self.user_id or f"agent:{self.agent_id}"
        return f"Recipient {ident} [{self.state}] of {self.package_id}"


class HandoffReference(models.Model):
    """受控材料引用：快照摘要 + 回源读取 + 查看时鉴权。

    两种材料形态：
    - 回源型（im_message / document / table）：只存快照摘要，正文查看时回源读取
      并按查看者权限实时校验，无权返回结构化 access_denied（不静默消失）。
    - 快照型（chat_session）：源是发起人个人资产（Agent 会话），接收人无法回源
      读取。创建时以发起人权限读取并冻结成清洗版快照存进 ``frozen_snapshot_json``，
      查看时直接读快照、不回源、不逐条鉴权（权限边界由所属交接包成员资格保证）。
    """

    class RefType(models.TextChoices):
        IM_MESSAGE = "im_message", "IM 消息"
        DOCUMENT = "document", "文档"
        TABLE = "table", "表格"
        ATTACHMENT = "attachment", "附件"
        CHAT_SESSION = "chat_session", "Agent 会话"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    package = models.ForeignKey(
        HandoffPackage,
        on_delete=models.CASCADE,
        related_name="references",
    )
    version = models.PositiveIntegerField(default=1, help_text="归属的包版本")
    ref_type = models.CharField(max_length=20, choices=RefType.choices)
    resource_id = models.CharField(
        max_length=100,
        help_text="目标资源 id（软引用，跨 App；im_message 为 Message.id）",
    )
    title_snapshot = models.CharField(max_length=300, blank=True, default="")
    summary_snapshot = models.CharField(max_length=500, blank=True, default="")
    source_link = models.JSONField(
        default=dict, blank=True,
        help_text="回链信息：im_message 存 {conversation_id, message_id, seq}；doc/table 存 {space_id, organization_id}；chat_session 存 {session_id}",
    )
    frozen_snapshot_json = models.JSONField(
        default=dict, blank=True,
        help_text="仅快照型材料（chat_session）使用：冻结的清洗版会话历史 "
                  "{title, message_count, turns:[...]}；回源型材料此字段为空 {}",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_handoff_reference"
        indexes = [
            models.Index(
                fields=["package", "version"],
                name="tabchat_handoff_ref_pkg_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"Ref {self.ref_type}:{self.resource_id} of {self.package_id}"


class HandoffEvent(models.Model):
    """审计流水（append-only）。

    每包能回答「谁何时发起、谁看过、谁接手、后来补充了什么」。
    """

    class EventType(models.TextChoices):
        CREATED = "created", "创建"
        SENT = "sent", "发送"
        VIEWED = "viewed", "查看"
        ACKNOWLEDGED = "acknowledged", "已了解"
        TAKEN_OVER = "taken_over", "由我继续"
        DELEGATED = "delegated", "交给 Agent"
        SUPPLEMENTED = "supplemented", "补充"
        REVOKED = "revoked", "撤销"
        REJECTED = "rejected", "拒绝"

    id = models.BigAutoField(primary_key=True)
    package = models.ForeignKey(
        HandoffPackage,
        on_delete=models.CASCADE,
        related_name="events",
    )
    actor_user_id = models.CharField(max_length=100, null=True, blank=True)
    actor_agent_id = models.CharField(max_length=100, null=True, blank=True)
    event_type = models.CharField(max_length=20, choices=EventType.choices)
    payload_json = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_handoff_event"
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(actor_user_id__isnull=False, actor_agent_id__isnull=True)
                    | models.Q(actor_user_id__isnull=True, actor_agent_id__isnull=False)
                ),
                name="tabchat_handoff_evt_actor_xor",
            ),
        ]
        indexes = [
            models.Index(
                fields=["package", "-created_at"],
                name="tabchat_handoff_evt_pkg_idx",
            ),
        ]

    def __str__(self) -> str:
        who = self.actor_user_id or f"agent:{self.actor_agent_id}"
        return f"Event {self.event_type} by {who} on {self.package_id}"

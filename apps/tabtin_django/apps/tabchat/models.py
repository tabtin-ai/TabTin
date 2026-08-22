"""TabChat 数据模型

Conversation：会话（统一承载 DM 和群聊）。
ConversationMember：显式会话成员。
ConversationUserState：用户在会话中的私有状态与已读水位。
Message：聊天消息（BigAutoField 主键 + 会话内 seq）。
MessageMention / MessageUserState：稀疏的消息级用户状态。
IMEventOutbox：Centrifugo 可靠投递队列。
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import timedelta

from django.conf import settings
from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models
from django.utils import timezone

from apps.tabchat.constants import ConversationType, MemberRole, MessageType


def external_contact_invitation_expiry():
    return timezone.now() + timedelta(days=7)


class Conversation(models.Model):
    """会话（统一承载 DM 和群聊）。

    DM 通过 dm_hash 保证同一对用户只能创建一个会话。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.CharField(max_length=100, db_index=True)
    space_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="历史 shadow Space 软引用（deprecated）。新建 DM/GROUP 会话不再写入。",
    )
    type = models.PositiveSmallIntegerField(
        choices=[(t.value, t.name) for t in ConversationType],
        default=ConversationType.GROUP,
    )
    dm_hash = models.CharField(
        max_length=64,
        null=True,
        blank=True,
        db_index=True,
        help_text="DM 成员哈希 sha256(sorted user_ids)，保证去重",
    )
    name = models.CharField(max_length=200, blank=True, default="")
    avatar_url = models.URLField(blank=True, default="")
    created_by = models.CharField(max_length=100)
    latest_message_seq = models.BigIntegerField(default=0)
    latest_message = models.ForeignKey(
        "Message",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    last_message_at = models.DateTimeField(null=True, blank=True)
    last_message_preview = models.CharField(max_length=200, blank=True, default="")
    member_count = models.PositiveIntegerField(default=0)
    creation_request_id = models.CharField(max_length=100, blank=True, default="")
    is_external = models.BooleanField(
        default=False,
        db_index=True,
        help_text="一旦外部联系人加入即永久为 true",
    )
    is_archived = models.BooleanField(default=False, db_index=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    archived_by = models.CharField(max_length=100, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_conversation"
        indexes = [
            models.Index(
                fields=["organization_id", "-last_message_at"],
                name="tabchat_conv_ws_last_msg_idx",
            ),
            models.Index(
                fields=["organization_id", "space_id", "is_archived", "name"],
                name="tabchat_conv_space_channel_idx",
            ),
        ]
        constraints = [
            models.CheckConstraint(
                check=models.Q(latest_message_seq__gte=0),
                name="tabchat_conv_latest_seq_nonneg",
            ),
            models.UniqueConstraint(
                fields=["organization_id", "dm_hash"],
                name="tabchat_conv_ws_dmhash_uniq",
                condition=models.Q(dm_hash__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["dm_hash"],
                name="tabchat_external_dmhash_uniq",
                condition=models.Q(is_external=True, dm_hash__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["space_id", "name"],
                name="tabchat_conv_space_active_name_uniq",
                condition=models.Q(space_id__isnull=False, is_archived=False),
            ),
            models.UniqueConstraint(
                fields=["organization_id", "created_by", "creation_request_id"],
                condition=~models.Q(creation_request_id=""),
                name="tabchat_group_creation_request_uniq",
            ),
        ]

    def __str__(self) -> str:
        return f"{'DM' if self.type == ConversationType.DM else 'Group'}: {self.name or self.id}"

    @staticmethod
    def compute_dm_hash(user_id_a: str, user_id_b: str) -> str:
        sorted_ids = ",".join(sorted([user_id_a, user_id_b]))
        return hashlib.sha256(sorted_ids.encode()).hexdigest()


class ConversationMember(models.Model):
    """会话成员。

    TC-8：成员可以是人（user_id）或 AI Agent（agent_id），二选一。
    人类成员沿用 user_id；AI 成员用 agent_id，不再为其伪造 User。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        LEFT = "left", "Left"
        REMOVED = "removed", "Removed"

    conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="members",
    )
    user_id = models.CharField(max_length=100, null=True, blank=True)
    agent_id = models.CharField(
        max_length=100, null=True, blank=True,
        help_text="AI Agent 成员（与 user_id 互斥，二选一）",
    )
    role = models.PositiveSmallIntegerField(
        choices=[(r.value, r.name) for r in MemberRole],
        default=MemberRole.MEMBER,
    )
    # TC-37：per-user 会话 label（M2M 到 ConversationLabel）。
    # 表达「项目 / 客户 / 待跟进 / 有 Agent 任务」等工作状态。
    labels = models.ManyToManyField(
        "ConversationLabel",
        related_name="conversation_members",
        blank=True,
    )
    joined_at = models.DateTimeField(auto_now_add=True)
    participant_organization_id = models.CharField(
        max_length=100,
        blank=True,
        default="",
        db_index=True,
        help_text="成员加入会话时的组织展示上下文；不作为联系人关系主键",
    )
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.ACTIVE,
    )
    left_at = models.DateTimeField(null=True, blank=True)
    removed_by = models.CharField(max_length=100, blank=True, default="")

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_conversation_member"
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "user_id"],
                name="tabchat_member_conv_user_uniq",
                condition=models.Q(user_id__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["conversation", "agent_id"],
                name="tabchat_member_conv_agent_uniq",
                condition=models.Q(agent_id__isnull=False),
            ),
            models.CheckConstraint(
                check=(
                    models.Q(user_id__isnull=False, agent_id__isnull=True)
                    | models.Q(user_id__isnull=True, agent_id__isnull=False)
                ),
                name="tabchat_member_user_xor_agent",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user_id", "conversation"],
                name="tabchat_member_user_conv_idx",
            ),
            models.Index(
                fields=["agent_id", "conversation"],
                name="tabchat_member_agent_conv_idx",
            ),
            models.Index(
                fields=["conversation", "status"],
                name="tabchat_member_conv_status_idx",
            ),
        ]

    def __str__(self) -> str:
        ident = self.user_id or f"agent:{self.agent_id}"
        return f"Member {ident} in {self.conversation_id}"


class ConversationMembershipWindow(models.Model):
    """成员在会话中的消息可见区间。

    每次加入建立一条区间，退出或被移除时关闭区间。使用消息 seq 而非时间，
    避免同一时刻的消息与成员变更产生边界歧义，也支持退出后再次加入。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation_member = models.ForeignKey(
        ConversationMember,
        on_delete=models.CASCADE,
        related_name="visibility_windows",
    )
    visible_from_seq = models.PositiveBigIntegerField(default=1)
    visible_until_seq = models.PositiveBigIntegerField(null=True, blank=True)
    joined_at = models.DateTimeField(auto_now_add=True)
    left_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_conversation_membership_window"
        indexes = [
            models.Index(
                fields=["conversation_member", "visible_from_seq", "visible_until_seq"],
                name="tabchat_member_window_seq_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["conversation_member"],
                condition=models.Q(visible_until_seq__isnull=True),
                name="tabchat_member_one_open_window",
            ),
            models.CheckConstraint(
                check=(
                    models.Q(visible_until_seq__isnull=True)
                    | models.Q(visible_until_seq__gte=models.F("visible_from_seq"))
                ),
                name="tabchat_member_window_order",
            ),
        ]


class ExternalContact(models.Model):
    """用户级外部联系人关系；会话只读取确认后的双向投影。"""

    class Relationship(models.TextChoices):
        FRIEND = "friend", "Friend"
        BLOCKED = "blocked", "Blocked"
        SUSPENDED = "suspended", "Suspended"
        REMOVED = "removed", "Removed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="owned_external_contacts",
    )
    peer_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="external_contact_peers",
    )
    peer_organization = models.ForeignKey(
        "tabtinspace.Organization",
        on_delete=models.PROTECT,
        related_name="external_contact_profiles",
    )
    relationship = models.CharField(
        max_length=20,
        choices=Relationship.choices,
        default=Relationship.FRIEND,
    )
    suspended_reason = models.CharField(max_length=100, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_external_contact"
        constraints = [
            models.UniqueConstraint(
                fields=["owner_user", "peer_user"],
                name="tabchat_external_contact_owner_peer_uniq",
            ),
            models.CheckConstraint(
                check=~models.Q(owner_user=models.F("peer_user")),
                name="tabchat_external_contact_not_self",
            ),
        ]
        indexes = [
            models.Index(
                fields=["owner_user", "relationship", "updated_at"],
                name="tabchat_external_owner_rel_idx",
            ),
        ]


class ExternalContactInvitation(models.Model):
    """用户间外部联系人申请；接受时才确定接收方使用的 Organization。"""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REJECTED = "rejected", "Rejected"
        CANCELLED = "cancelled", "Cancelled"
        EXPIRED = "expired", "Expired"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sender_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sent_external_contact_invitations",
    )
    sender_organization = models.ForeignKey(
        "tabtinspace.Organization",
        on_delete=models.PROTECT,
        related_name="sent_external_contact_invitations",
    )
    recipient_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="received_external_contact_invitations",
    )
    recipient_organization = models.ForeignKey(
        "tabtinspace.Organization",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="received_external_contact_invitations",
    )
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    note = models.CharField(max_length=500, blank=True, default="")
    expires_at = models.DateTimeField(default=external_contact_invitation_expiry)
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_external_contact_invitation"
        constraints = [
            models.UniqueConstraint(
                fields=["sender_user", "recipient_user"],
                condition=models.Q(status="pending"),
                name="tabchat_external_invite_pending_uniq",
            ),
            models.CheckConstraint(
                check=~models.Q(sender_user=models.F("recipient_user")),
                name="tabchat_external_invite_not_self",
            ),
        ]
        indexes = [
            models.Index(
                fields=["recipient_user", "status", "-created_at"],
                name="tabchat_ext_invite_in_idx",
            ),
            models.Index(
                fields=["sender_user", "status", "-created_at"],
                name="tabchat_ext_invite_out_idx",
            ),
        ]


class ConversationAgentWorkspace(models.Model):
    """普通群聊中 Agent 的执行现场绑定。

    成员关系仍由 ConversationMember 持有；本表只回答
    「这个群 × 这个 Agent 用哪个 Workspace」。不做历史回填。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.CharField(max_length=100, db_index=True)
    conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="agent_workspaces",
    )
    agent_id = models.CharField(max_length=100, db_index=True)
    workspace = models.ForeignKey(
        "tabtinspace.Workspace",
        on_delete=models.CASCADE,
        related_name="conversation_agent_bindings",
    )
    bound_by_user_id = models.CharField(max_length=100)
    bound_at = models.DateTimeField(default=timezone.now)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_conversation_agent_workspace"
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "agent_id"],
                name="tabchat_caw_conv_agent_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["organization_id", "agent_id"],
                name="idx_tabchat_caw_org_agent",
            ),
        ]

    def __str__(self) -> str:
        return f"Agent {self.agent_id} @ {self.conversation_id} → {self.workspace_id}"


class ConversationLabel(models.Model):
    """TC-37：会话 label 库（per-user, per-organization）。

    每个用户在每个 organization 下有独立的一套 label 库，给会话打标表达工作状态
    （项目 / 客户 / 待跟进 / 有 Agent 任务等）。label 是 per-user 的，
    其他成员看不到我的 label。系统 label（如 @me）不入库，序列化时动态注入。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.CharField(max_length=100, db_index=True)
    organization_id = models.CharField(max_length=100, db_index=True)
    name = models.CharField(max_length=32)
    color = models.CharField(
        max_length=7,
        default="#6b7280",
        help_text="hex 颜色字符串如 #FF5733，用户自由选色",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_conversation_label"
        constraints = [
            models.UniqueConstraint(
                fields=["user_id", "organization_id", "name"],
                name="tabchat_label_user_wt_name_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user_id", "organization_id"],
                name="tabchat_label_user_wt_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"Label {self.name} (user={self.user_id} wt={self.organization_id})"


class Message(models.Model):
    """聊天消息。

    使用 BigAutoField 主键，天然有序，适合 cursor 分页。
    """

    id = models.BigAutoField(primary_key=True)
    conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    sender_id = models.CharField(max_length=100)
    sender_type = models.CharField(
        max_length=10,
        default="user",
        help_text="发送者身份类型：user（人）/ agent（AI）。TC-8",
    )
    seq = models.BigIntegerField()
    client_request_id = models.CharField(max_length=100, null=True, blank=True)
    counts_as_unread = models.BooleanField(default=True)
    mention_all = models.BooleanField(default=False)
    content = models.TextField()
    message_type = models.PositiveSmallIntegerField(
        choices=[(t.value, t.name) for t in MessageType],
        default=MessageType.TEXT,
    )
    reply_to = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="replies",
    )
    has_attachment = models.BooleanField(default=False)
    metadata = models.JSONField(default=dict, blank=True)
    # TC-36：搜索聚合文本 = content + file_name + card title/description。
    # 写入时计算，search_tsvector 基于此字段生成，让文件名/资源卡标题可被搜索。
    search_text = models.TextField(blank=True, default="")
    search_tsvector = SearchVectorField(null=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    # 置顶消息（会话级、全员共享；会话私有置顶存于 ConversationUserState）。
    is_pinned = models.BooleanField(default=False)
    pinned_at = models.DateTimeField(null=True, blank=True)
    pinned_by = models.CharField(max_length=100, blank=True, default="")
    # 消息编辑：最后一次编辑时间。非空即表示「已编辑」（不保留编辑历史）。
    edited_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_message"
        indexes = [
            models.Index(
                fields=["conversation", "-created_at"],
                name="tabchat_msg_conv_created_idx",
            ),
            GinIndex(
                fields=["search_tsvector"],
                name="tabchat_msg_search_gin_idx",
            ),
            # 置顶消息查询：每会话置顶数通常很少，用分区索引只覆盖 is_pinned 行。
            models.Index(
                fields=["conversation", "-pinned_at"],
                name="tabchat_msg_pinned_idx",
                condition=models.Q(is_pinned=True),
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "seq"],
                name="tabchat_msg_conv_seq_uniq",
            ),
            models.UniqueConstraint(
                fields=[
                    "conversation",
                    "sender_type",
                    "sender_id",
                    "client_request_id",
                ],
                condition=models.Q(client_request_id__isnull=False),
                name="tabchat_msg_sender_request_uniq",
            ),
            models.CheckConstraint(
                check=models.Q(seq__gt=0),
                name="tabchat_msg_seq_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"Msg#{self.id} seq={self.seq} by {self.sender_id}"


class ConversationUserState(models.Model):
    """用户在会话中的私有状态；适用于显式成员和 Team Space 继承成员。"""

    id = models.BigAutoField(primary_key=True)
    conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="user_states",
    )
    user_id = models.CharField(max_length=100)
    last_read_seq = models.BigIntegerField(default=0)
    history_cleared_seq = models.BigIntegerField(default=0)
    muted = models.BooleanField(default=False)
    pinned = models.BooleanField(default=False)
    notification_level = models.CharField(max_length=20, default="all")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_conversation_user_state"
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "user_id"],
                name="tabchat_conv_state_user_uniq",
            ),
            models.CheckConstraint(
                check=models.Q(last_read_seq__gte=0),
                name="tabchat_conv_state_read_nonneg",
            ),
            models.CheckConstraint(
                check=models.Q(history_cleared_seq__gte=0),
                name="tabchat_conv_state_clear_nonneg",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user_id", "conversation"],
                name="tabchat_state_user_conv_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"State user={self.user_id} conv={self.conversation_id}"


class MessageMention(models.Model):
    """稀疏提及事实；一行只指向一个 User 或 Agent。"""

    class MentionType(models.TextChoices):
        USER = "user", "User"
        AGENT = "agent", "Agent"

    id = models.BigAutoField(primary_key=True)
    message = models.ForeignKey(
        Message,
        on_delete=models.CASCADE,
        related_name="mentions",
    )
    conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="message_mentions",
    )
    user_id = models.CharField(max_length=100, null=True, blank=True)
    agent_id = models.CharField(max_length=100, null=True, blank=True)
    mention_type = models.CharField(max_length=10, choices=MentionType.choices)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_message_mention"
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(user_id__isnull=False, agent_id__isnull=True)
                    | models.Q(user_id__isnull=True, agent_id__isnull=False)
                ),
                name="tabchat_mention_user_xor_agent",
            ),
            models.CheckConstraint(
                check=(
                    models.Q(
                        user_id__isnull=False,
                        agent_id__isnull=True,
                        mention_type="user",
                    )
                    | models.Q(
                        user_id__isnull=True,
                        agent_id__isnull=False,
                        mention_type="agent",
                    )
                ),
                name="tabchat_mention_subject_type_match",
            ),
            models.UniqueConstraint(
                fields=["message", "user_id"],
                condition=models.Q(user_id__isnull=False),
                name="tabchat_mention_msg_user_uniq",
            ),
            models.UniqueConstraint(
                fields=["message", "agent_id"],
                condition=models.Q(agent_id__isnull=False),
                name="tabchat_mention_msg_agent_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user_id", "conversation", "message"],
                name="tabchat_mention_user_conv_idx",
            ),
            models.Index(
                fields=["agent_id", "message"],
                name="tabchat_mention_agent_msg_idx",
            ),
        ]


class MessageUserState(models.Model):
    """仅在用户收藏或隐藏消息时创建。"""

    id = models.BigAutoField(primary_key=True)
    message = models.ForeignKey(
        Message,
        on_delete=models.CASCADE,
        related_name="user_states",
    )
    user_id = models.CharField(max_length=100)
    starred = models.BooleanField(default=False)
    hidden = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_message_user_state"
        constraints = [
            models.UniqueConstraint(
                fields=["message", "user_id"],
                name="tabchat_msg_state_user_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user_id", "starred", "message"],
                name="tabchat_msg_state_star_idx",
            ),
            models.Index(
                fields=["user_id", "hidden", "message"],
                name="tabchat_msg_state_hide_idx",
            ),
        ]


class MessageReaction(models.Model):
    """消息表情反应。

    同一用户对同一消息只能使用同一个 emoji 一次。
    """

    id = models.BigAutoField(primary_key=True)
    message = models.ForeignKey(
        Message,
        on_delete=models.CASCADE,
        related_name="reactions",
    )
    user_id = models.CharField(max_length=100)
    emoji = models.CharField(max_length=10)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_message_reaction"
        constraints = [
            models.UniqueConstraint(
                fields=["message", "user_id", "emoji"],
                name="tabchat_reaction_msg_user_emoji_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["message"],
                name="tabchat_reaction_msg_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"Reaction {self.emoji} by {self.user_id} on Msg#{self.message_id}"


class IMEventOutbox(models.Model):
    """持久化 Centrifugo 业务事件；HTTP 发布发生在数据库事务之外。"""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PUBLISHING = "publishing", "Publishing"
        RETRY = "retry", "Retry"
        DELIVERED = "delivered", "Delivered"
        DEAD = "dead", "Dead"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    domain_event_id = models.UUIDField()
    event_id = models.UUIDField(unique=True)
    event_type = models.CharField(max_length=100)
    organization_id = models.CharField(max_length=100, db_index=True)
    conversation = models.ForeignKey(
        Conversation,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="outbox_events",
    )
    message = models.ForeignKey(
        Message,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="outbox_events",
    )
    target_channels = models.JSONField(default=list)
    payload = models.JSONField(default=dict)
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    attempts = models.PositiveIntegerField(default=0)
    next_retry_at = models.DateTimeField(null=True, blank=True)
    claim_token = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_im_event_outbox"
        indexes = [
            models.Index(
                fields=["status", "next_retry_at", "created_at"],
                name="tabchat_outbox_ready_idx",
            ),
            models.Index(
                fields=["status", "lease_expires_at"],
                name="tabchat_outbox_lease_idx",
            ),
        ]


class AgentMentionJob(models.Model):
    """一次 TabChat @Agent 执行；唯一约束阻止重复执行、回复和计费。"""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        RUNNING = "running", "Running"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_message = models.ForeignKey(
        Message,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="agent_mention_jobs",
    )
    source_message_ref = models.CharField(max_length=100, null=True, blank=True)
    source_message_seq = models.PositiveBigIntegerField(null=True, blank=True)
    source_sender_id = models.CharField(max_length=100, blank=True, default="")
    source_content = models.TextField(blank=True, default="")
    context_messages = models.JSONField(default=list, blank=True)
    agent_id = models.CharField(max_length=100)
    organization_id = models.CharField(max_length=100, db_index=True)
    conversation = models.ForeignKey(
        Conversation,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="agent_mention_jobs",
    )
    conversation_ref = models.CharField(max_length=100, blank=True, default="")
    conversation_name = models.CharField(max_length=200, blank=True, default="")
    project_ref = models.CharField(max_length=100, blank=True, default="")
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    attempts = models.PositiveIntegerField(default=0)
    claim_token = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    session_id = models.UUIDField(null=True, blank=True)
    final_message = models.ForeignKey(
        Message,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    final_content = models.TextField(blank=True, default="")
    final_message_type = models.PositiveSmallIntegerField(default=1)
    final_metadata = models.JSONField(default=dict, blank=True)
    billing_idempotency_key = models.CharField(max_length=200, unique=True)
    last_error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_agent_mention_job"
        constraints = [
            models.UniqueConstraint(
                fields=["source_message", "agent_id"],
                name="tabchat_agent_job_msg_agent_uniq",
            ),
            models.UniqueConstraint(
                fields=["source_message_ref", "agent_id"],
                name="tabchat_agent_job_ref_agent_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["status", "lease_expires_at", "created_at"],
                name="tabchat_agent_job_ready_idx",
            ),
            models.Index(
                fields=["session_id"],
                name="tabchat_agent_job_session_idx",
            ),
        ]


class ResourceAccessRequest(models.Model):
    """资源访问申请：向资源 owner 申请 viewer / editor。

    领域归属：资源 ACL 工作流（不属于 Django IM 消息主链路）。领域服务与正典 API
    在 ``apps.services.common.resource_access`` / ``/api/resource-access-requests``；
    本模型因  建表仍落在 tabchat app，``/api/im/...`` 仅为兼容别名。

    产品口径：
    - IM 资源卡：无权成员带会话/消息来源申请 viewer（默认）；
    - 工具栏（viewer→editor）：已有查看权限时可无会话来源申请 editor；
    - pending 时 (resource_type, resource_id, requester) 条件唯一；
    - 批准复用 TabData/TabDoc ``invite_collaborators(..., req.role)``，以本表行为权威；
    - 本轮不做拒绝 / 过期 / 撤回（取消确认 ≠ 拒绝）。
    """

    class ResourceType(models.TextChoices):
        TABLE = "table", "表格"
        DOCUMENT = "document", "文档"

    class Status(models.TextChoices):
        PENDING = "pending", "待处理"
        APPROVED = "approved", "已批准"
        SUPERSEDED = "superseded", "已失效"

    class Role(models.TextChoices):
        VIEWER = "viewer", "查看者"
        EDITOR = "editor", "编辑者"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    resource_type = models.CharField(max_length=20, choices=ResourceType.choices)
    resource_id = models.UUIDField(db_index=True)
    requester_id = models.CharField(max_length=100)
    owner_id = models.CharField(max_length=100, db_index=True)
    source_conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="resource_access_requests",
        null=True,
        blank=True,
    )
    source_message = models.BigIntegerField(
        null=True,
        blank=True,
        db_column="source_message_id",
        db_index=True,
        help_text="消息数据面的来源 ID；不与 Django Message 表建立外键关系。",
    )
    source_message_ref = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        help_text="消息数据面的稳定 message_ref；本地 Message 不存在时作为来源锚点。",
    )
    role = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.VIEWER,
    )
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    resolved_by = models.CharField(max_length=100, blank=True, default="")
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "tabchat"
        db_table = "tabchat_resource_access_request"
        constraints = [
            models.UniqueConstraint(
                fields=["resource_type", "resource_id", "requester_id"],
                condition=models.Q(status="pending"),
                # Django 索引/约束名 ≤30 字符（E034）
                name="tabchat_rar_pend_res_req_uq",
            ),
            models.CheckConstraint(
                check=models.Q(role__in=["viewer", "editor"]),
                name="tabchat_rar_role_viewer_editor",
            ),
        ]
        indexes = [
            models.Index(
                fields=["owner_id", "status", "-created_at"],
                name="tabchat_rar_owner_st_idx",
            ),
            models.Index(
                fields=["requester_id", "status", "-created_at"],
                name="tabchat_rar_req_st_idx",
            ),
        ]

    def __str__(self) -> str:
        return (
            f"ResourceAccessRequest({self.resource_type}:{self.resource_id} "
            f"by {self.requester_id} -> {self.status})"
        )


# ── IM 上下文交接（handoff 子域）──
# 交接包是独立领域对象，模型定义在 handoff/models.py；此处 re-export 保证
# Django app registry 在加载 tabchat.models 时即注册这些模型。
from apps.tabchat.handoff.models import (  # noqa: E402,F401
    HandoffEvent,
    HandoffPackage,
    HandoffRecipient,
    HandoffReference,
)

"""TabChat API Schemas。"""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from ninja import Field, Schema


# ── Request Schemas ──


class BatchUsersRequest(Schema):
    organization_id: str
    user_ids: list[str]


class CreateDMRequest(Schema):
    organization_id: str
    other_user_id: str = ""
    external_contact_id: str = ""


class CreateGroupRequest(Schema):
    organization_id: str
    name: str
    member_ids: list[str]
    avatar_url: str = ""
    space_id: str | None = None
    external_contact_ids: list[str] = Field(default_factory=list, max_length=50)
    client_request_id: str = Field(default="", max_length=100)


class CreateSpaceChannelRequest(Schema):
    organization_id: str
    name: str = Field(..., max_length=64)


class UpdateConversationRequest(Schema):
    name: str | None = None
    avatar_url: str | None = None


class ConversationPinRequest(Schema):
    pinned: bool


class ConversationMuteRequest(Schema):
    muted: bool


class AddMembersRequest(Schema):
    member_ids: list[str] = Field(default_factory=list)
    external_contact_ids: list[str] = Field(default_factory=list, max_length=50)


class DiscoverExternalContactRequest(Schema):
    organization_id: str
    phone: str = Field(..., min_length=3, max_length=32)


class CreateExternalContactInvitationRequest(Schema):
    organization_id: str
    target_user_id: str
    note: str | None = Field(None, max_length=500)


class AcceptExternalContactRequest(Schema):
    organization_id: str
    invite_code: str


class UpdateExternalContactInvitationRequest(Schema):
    organization_id: str
    action: Literal["reject", "cancel"]


class UpdateExternalContactRequest(Schema):
    organization_id: str
    action: Literal["block", "unblock", "remove"]


class AddAgentsRequest(Schema):
    """TC-8：把 AI Agent 加入群聊。"""

    agent_ids: list[str]


class BindConversationAgentWorkspaceRequest(Schema):
    """普通群聊：加入 Agent 并绑定执行现场。"""

    agent_id: str
    workspace_id: str


class UpdateConversationAgentWorkspaceRequest(Schema):
    """更换已入群 Agent 的执行现场。"""

    workspace_id: str


class SendMessageRequest(Schema):
    content: str = Field(..., max_length=10000)
    message_type: int = 1
    reply_to_id: int | None = None
    metadata: dict | None = None
    client_request_id: str | None = Field(None, max_length=100)


class AgentMentionContextMessage(Schema):
    sender_name: str = Field(..., max_length=200)
    content: str = Field(..., max_length=10000)


class CreateAgentMentionRequest(Schema):
    organization_id: str = Field(..., max_length=100)
    conversation_ref: str = Field(..., max_length=100)
    message_ref: str = Field(..., max_length=100)
    source_message_seq: int | None = Field(None, ge=1)
    content: str = Field(..., max_length=10000)
    mentioned_agent_ids: list[str] = Field(..., max_length=20)
    context_messages: list[AgentMentionContextMessage] = Field(default_factory=list, max_length=20)
    referenced_message: AgentMentionContextMessage | None = None


class ResolveMessageReferencesRequest(Schema):
    message_ids: list[str] = Field(..., max_length=50)


class CreateAgentTaskFromMessageRequest(Schema):
    additional_context: str = Field("", max_length=4000)
    # 旧 Electron 先得到业务 400，而不是创建一个无法执行的空 Agent 会话。
    agent_id: str | None = None


class EditMessageRequest(Schema):
    content: str = Field(..., max_length=10000)
    metadata: dict | None = None


class MarkReadRequest(Schema):
    last_message_id: int | None = None


class ReactionRequest(Schema):
    emoji: str = Field(..., min_length=1, max_length=10)


class MessageUserStateRequest(Schema):
    enabled: bool


# ── TC-37：会话 label Schemas ──


class CreateLabelRequest(Schema):
    organization_id: str
    name: str = Field(..., max_length=32)
    color: str = Field("#6b7280", max_length=7)


class UpdateLabelRequest(Schema):
    name: str | None = Field(None, max_length=32)
    color: str | None = Field(None, max_length=7)


class AddLabelsRequest(Schema):
    """给会话追加 label。"""
    label_ids: list[str]


# ── Response Schemas ──


class ConversationOut(Schema):
    id: str
    organization_id: str
    # organization_id 是托管组织；下面两个字段描述当前用户看到该会话的目录上下文。
    # 旧客户端可忽略新增字段，内部会话两者均等于 organization_id。
    participant_organization_id: str = ""
    directory_scope_id: str = ""
    space_id: str | None = None
    space_name: str = ""
    is_team_space_channel: bool = False
    is_external: bool = False
    type: int
    name: str
    avatar_url: str
    member_count: int
    is_archived: bool = False
    last_message_at: str | None
    last_message_preview: str
    last_message_id: str | None = None
    unread_count: int = 0
    # 统计 unread_count 时会话已见的最高消息 seq 水位（移动端加载在途 baseline/delta 合并用）。
    last_message_seq: int = 0
    created_at: str
    dm_peer_user_id: str | None = None
    # 外部 DM 中对端所属组织。用于客户端精确匹配跨组织联系人关系；
    # 普通 DM 同样返回会话组织，旧客户端可安全忽略。
    dm_peer_organization_id: str | None = None
    pinned: bool = False
    is_muted: bool = False
    can_send: bool = True
    labels: list[dict] = Field(default_factory=list)  # TC-37


class UserProfileOut(Schema):
    id: str
    nickname: str
    username: str
    avatar: str
    avatar_version: str = ""
    revision: int = 0


class MemberOut(Schema):
    member_type: str = "user"  # TC-8: user | agent
    user_id: str | None = None
    agent_id: str | None = None
    nickname: str = ""
    username: str = ""
    avatar: str = ""
    role: int
    is_muted: bool
    pinned: bool
    joined_at: str | None
    # 可加性：仅 Agent 成员有主人；旧客户端忽略。
    owner_user_id: str | None = None
    owner_display_name: str = ""
    # 可加性：执行设备对主人是否可派发；缺省/旧端忽略。
    is_execution_online: bool | None = None
    participant_organization_id: str = ""
    is_external: bool = False
    organization_name: str = ""


class ConversationDetailOut(Schema):
    id: str
    organization_id: str
    participant_organization_id: str = ""
    directory_scope_id: str = ""
    space_id: str | None = None
    space_name: str = ""
    is_team_space_channel: bool = False
    is_external: bool = False
    type: int
    name: str
    avatar_url: str
    dm_hash: str | None
    dm_peer_user_id: str | None = None
    dm_peer_organization_id: str | None = None
    member_count: int
    is_archived: bool = False
    last_message_at: str | None
    last_message_preview: str
    created_by: str
    created_at: str
    members: list[MemberOut]
    labels: list[dict] = Field(default_factory=list)  # TC-37
    has_unread_mention: bool = False  # TC-37
    can_send: bool = True


class ReplyToPreview(Schema):
    content: str
    sender_id: str
    # 引用源已经撤回/不可访问时，内容会被清空；显式标志让客户端不要把空串误判为附件。
    is_unavailable: bool = False
    message_type: int = 1
    has_attachment: bool = False
    file_name: str = ""


class MessageOut(Schema):
    id: int
    seq: int
    conversation_id: str
    sender_id: str
    content: str
    message_type: int
    reply_to_id: int | None
    reply_to_preview: ReplyToPreview | None = None
    has_attachment: bool
    metadata: dict
    created_at: str | None
    is_deleted: bool = False
    sender_name: str = ""
    reactions: dict = Field(default_factory=dict)


class SearchMessageOut(Schema):
    id: int
    conversation_id: str
    conversation_name: str
    sender_id: str
    content: str
    message_type: int
    created_at: str | None
    highlight: str = ""
    sender_type: str = "user"  # TC-36
    match_types: list[str] = []  # TC-36: content/file_name/card_title/card_description


class UnreadCountOut(Schema):
    conversation_id: str
    count: int


class ApiResponse(Schema):
    success: bool = True
    message: str = "ok"
    data: Any = None
    code: int = 200

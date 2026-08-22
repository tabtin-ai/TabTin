"""TabChat 常量定义"""

from __future__ import annotations

from enum import IntEnum


class ConversationType(IntEnum):
    DM = 1
    GROUP = 2


class MessageType(IntEnum):
    TEXT = 1
    SYSTEM = 2
    FILE = 3
    IMAGE = 4


class MemberRole(IntEnum):
    OWNER = 3
    ADMIN = 2
    MEMBER = 1


class SenderType:
    """消息发送者 / 会话成员身份类型。

    TC-8：私信引入 AI Agent 作为一等参与者。人类成员 sender_type=user
    （沿用 user_id），AI 成员 sender_type=agent（sender_id 即 agent_id）。
    """

    USER = "user"
    AGENT = "agent"

    ALL = (USER, AGENT)


class IMEventType:
    MESSAGE = "im.message"
    MESSAGE_DELETED = "im.message.deleted"
    MEMBER_JOINED = "im.member.joined"
    MEMBER_LEFT = "im.member.left"
    CONVERSATION_UPDATED = "im.conversation.updated"
    CONVERSATION_PREVIEW_UPDATED = "im.conversation.preview.updated"
    TYPING = "im.typing"
    UNREAD_UPDATE = "im.unread.update"
    CONVERSATION_NEW = "im.conversation.new"
    USER_PROFILE_UPDATED = "im.user.profile.updated"
    MENTION = "im.mention"
    READ_RECEIPT = "im.read.receipt"
    REACTION_ADDED = "im.reaction.added"
    REACTION_REMOVED = "im.reaction.removed"
    MESSAGE_PINNED = "im.message.pinned"
    MESSAGE_UNPINNED = "im.message.unpinned"
    MESSAGE_EDITED = "im.message.edited"
    HANDOFF_UPDATE = "im.handoff.update"
    SESSION_SHARE_UPDATE = "im.session_share.update"


GROUP_MEMBER_LIMIT = 50

# 群聊 @Agent 等待期 ack：挂在被 @ 的原消息上，不是一条新气泡。
AGENT_MENTION_ACK_EMOJI = "👀"

# ChatContext / RemoteAgent app_context 共用：标记「TabChat @Agent 内部执行会话」。
# 任务侧栏排除与 activity 推送只认这个取值，禁止用标题 ``[私信@…]`` 判断。
TABCHAT_MENTION_INVOKED_FROM = "tabchat_mention"

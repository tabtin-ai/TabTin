"""IM 与平台通知中心（铃铛）的边界。

产品口径（桌面侧栏「消息」为未读入口）：
- IM 未读只走侧栏「消息」角标（``ConversationUserState`` / ``im.unread.update``）；
- **不再**把私信 / @我桥接进铃铛通知中心，避免与「消息」重复、角标被聊天刷爆。

历史 ``im.message`` 行仍可能留在库里；``mark_im_conversation_read`` 继续在读会话时
清理这些遗留卡。``NotificationService`` 的 list / unread-count 也会排除 ``im.*``。
"""
import logging

from apps.tabchat.constants import ConversationType

logger = logging.getLogger(__name__)

# Notification.type：历史 IM 铃铛卡（新消息不再写入）。
IM_MESSAGE_NOTIFICATION_TYPE = "im.message"


def im_conversation_dedup_key(conversation_id: str) -> str:
    """同会话合并用的去重 key（写入 Notification.source_event_id）。

    通知本身按 user_id 隔离，故 key 只需带 conversation_id 即可。
    """
    return f"im.conv:{conversation_id}"


def compute_bell_recipients(
    *,
    conversation_type: int,
    other_ids: list[str],
    mentioned_recipients: list[str],
) -> list[dict]:
    """历史噪音口径（DM 全量 / 群聊仅 @）。桥接已停用，保留供单测与回滚参考。"""
    mentioned = set(mentioned_recipients)
    if conversation_type == ConversationType.DM:
        return [
            {"user_id": uid, "mention": uid in mentioned}
            for uid in other_ids
        ]
    return [{"user_id": uid, "mention": True} for uid in mentioned]


def bridge_message_notifications(payload: dict) -> None:
    """IM → 铃铛桥接已停用：消息未读只挂「消息」入口。

    ``send_message`` 的 on_commit 仍调用本函数，保持调用点稳定；此处直接返回。
    """
    del payload  # 明确忽略，避免未使用参数告警
    return


def mark_im_conversation_read(user_id: str, conversation_id: str) -> None:
    """读会话时把铃铛里该会话的 IM 通知标已读（读态单向联动）。异常吞掉。"""
    try:
        from apps.services.notification.services.notification_service import (
            NotificationService,
        )

        NotificationService.mark_conversation_read(
            user_id=user_id,
            dedup_key=im_conversation_dedup_key(conversation_id),
            type=IM_MESSAGE_NOTIFICATION_TYPE,
        )
    except Exception:
        logger.exception(
            "[tabchat] mark IM conversation notification read failed: conv=%s user=%s",
            conversation_id,
            user_id,
        )

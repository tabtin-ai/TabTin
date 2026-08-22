"""通知类 Celery 任务（远程推送分发，）。

推送是尽力而为通道：不重试超过 1 次、不 ignore 主链路——事件源只负责
把任务丢进队列，队列/worker 故障时推送静默丢失（WS + 打开 App 拉最新兜底）。
"""

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(
    name="notification.push_agent_done",
    ignore_result=True,
    time_limit=30,
    soft_time_limit=25,
    autoretry_for=(Exception,),
    max_retries=1,
    default_retry_delay=5,
)
def push_agent_done(session_id: str, done_payload: dict | None = None):
    from apps.services.notification.push.service import notify_agent_done
    notify_agent_done(session_id, done_payload)


@shared_task(
    name="notification.push_interaction_requested",
    ignore_result=True,
    time_limit=30,
    soft_time_limit=25,
    autoretry_for=(Exception,),
    max_retries=1,
    default_retry_delay=5,
)
def push_interaction_requested(interaction_id: str):
    from apps.services.notification.push.service import notify_interaction_requested
    notify_interaction_requested(interaction_id)


@shared_task(
    name="notification.push_im_message_recipient",
    ignore_result=True,
    time_limit=30,
    soft_time_limit=25,
    autoretry_for=(Exception,),
    max_retries=1,
    default_retry_delay=5,
)
def push_im_message_recipient(payload: dict):
    """投递一个接收人的 IM 推送，隔离群聊扇出的执行时限与重试。"""
    from apps.services.notification.push.service import notify_im_message

    user_id = str(payload.get("user_id") or "")
    if not user_id:
        return
    notify_im_message(
        user_id=user_id,
        organization_id=str(payload.get("organization_id") or ""),
        conversation_id=str(payload.get("conversation_id") or ""),
        message_id=str(payload.get("message_id") or ""),
        sender_id=str(payload.get("sender_id") or ""),
        sender_name=str(payload.get("sender_name") or ""),
        preview=str(payload.get("preview") or ""),
        mention=bool(payload.get("mention", False)),
    )


@shared_task(
    name="notification.push_im_message",
    ignore_result=True,
    time_limit=30,
    soft_time_limit=25,
    autoretry_for=(Exception,),
    max_retries=1,
    default_retry_delay=5,
)
def push_im_message(payload: dict):
    """按 Django IM 解析出的接收人列表拆分独立投递任务。"""

    recipients = payload.get("recipients")
    if not isinstance(recipients, list):
        return
    sender_id = str(payload.get("sender_id") or "")
    sender_name = str(payload.get("sender_name") or "").strip()
    if not sender_name and sender_id:
        sender_name = _resolve_sender_name(sender_id)
    common = {
        "organization_id": str(payload.get("organization_id") or ""),
        "conversation_id": str(payload.get("conversation_id") or ""),
        "message_id": str(payload.get("message_id") or ""),
        "sender_id": sender_id,
        "sender_name": sender_name,
        "preview": str(payload.get("preview") or ""),
    }
    for recipient in recipients[:500]:
        if not isinstance(recipient, dict):
            continue
        user_id = str(recipient.get("user_id") or "")
        if not user_id:
            continue
        push_im_message_recipient.delay({
            **common,
            "user_id": user_id,
            "organization_id": str(
                recipient.get("organization_id")
                or common["organization_id"]
            ),
            "mention": bool(recipient.get("mention", False)),
        })


def _resolve_sender_name(sender_id: str) -> str:
    """消息任务未携带展示名时，按可信 user_id 补通知标题。"""
    try:
        from apps.users.auth.models import User

        user = User.objects.filter(id=sender_id).only(
            "nickname",
            "username",
            "email",
            "phone",
        ).first()
        return user.get_display_name() if user is not None else ""
    except Exception:
        return ""

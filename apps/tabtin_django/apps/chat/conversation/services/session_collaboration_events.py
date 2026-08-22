from asgiref.sync import async_to_sync
from django.core.cache import cache
from channels.layers import get_channel_layer

from apps.services.common.ws.bus import publish_ws_event, publish_ws_event_reliable
from apps.services.common.ws.protocol import CHANNEL_SAFE_PATTERN


def _cache_key(thread_id: str) -> str:
    return f"session-collaboration-topics:{thread_id}"


def invalidate_runtime_topics(thread_id: str) -> None:
    cache.delete(_cache_key(thread_id))


def publish_runtime_event(thread_id: str, envelope: dict, *, reliable: bool) -> None:
    """把运行事件投影到带 access_epoch 的 v2 专用主题。"""
    key = _cache_key(thread_id)
    relations = cache.get(key)
    if relations is None:
        from apps.chat.conversation.api._common import resolve_session_id_for_thread
        from apps.chat.conversation.models import SessionShare

        session_id = resolve_session_id_for_thread(thread_id)
        relations = (
            list(
                SessionShare.objects.filter(
                    session_id=session_id,
                    card_contract="session_share_v2",
                    status="active",
                    eligibility_status="eligible",
                ).values("id", "version", "access_epoch")
            )
            if session_id
            else []
        )
        cache.set(key, relations, timeout=5)

    publish = publish_ws_event_reliable if reliable else publish_ws_event
    for relation in relations:
        topic = f"session.collaboration.{relation['id']}.{relation['access_epoch']}"
        projected = {
            **envelope,
            "payload": {
                **(envelope.get("payload") or {}),
                "collaboration_id": str(relation["id"]),
                "collaboration_version": int(relation["version"]),
                "access_epoch": int(relation["access_epoch"]),
            },
        }
        publish(topic, projected)


def send_collaboration_state_changed(share, *, revoked: bool) -> None:
    """通知双方重拉权威状态，并同步接收方访问边界。"""
    layer = get_channel_layer()
    invalidate_runtime_topics(
        str(share.session.thread_id or f"chat-session-{share.session_id}"),
    )
    if layer is None:
        return
    group = CHANNEL_SAFE_PATTERN.sub(".", f"user.{share.grantee_user_id}")
    thread_id = str(share.session.thread_id or f"chat-session-{share.session_id}")
    async_to_sync(layer.group_send)(
        group,
        {
            "type": "session_collaboration_access_control",
            "share_id": str(share.id),
            "session_id": str(share.session_id),
            "thread_id": thread_id,
            "version": int(share.version),
            "access_epoch": int(share.access_epoch),
            "revoked": revoked,
        },
    )
    for user_id in (share.owner_user_id, share.grantee_user_id):
        user_group = CHANNEL_SAFE_PATTERN.sub(".", f"user.{user_id}")
        async_to_sync(layer.group_send)(
            user_group,
            {
                "type": "relay_message",
                "message": {
                    "type": "session.collaboration.changed",
                    "payload": {
                        "object_id": str(share.id),
                        "session_id": str(share.session_id),
                        "version": int(share.version),
                    },
                },
            },
        )

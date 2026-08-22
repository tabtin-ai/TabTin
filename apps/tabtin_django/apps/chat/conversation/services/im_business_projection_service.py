"""Django IM 持久业务投影：私聊 + Centrifugo。"""

from __future__ import annotations

import uuid


class IMBusinessProjectionError(RuntimeError):
    pass


class TransientIMBusinessProjectionError(IMBusinessProjectionError):
    pass


class PermanentIMBusinessProjectionError(IMBusinessProjectionError):
    pass


def _resolve_django_direct_conversation(
    *,
    organization_id: str,
    actor_user_id: str,
    other_user_id: str,
    conversation_id_hint: str | None = None,
) -> str:
    from apps.tabchat.services.conversation_service import ConversationService

    hint = str(conversation_id_hint or "").strip()
    if hint:
        try:
            hint = str(uuid.UUID(hint))
        except (ValueError, TypeError, AttributeError):
            hint = ""
    try:
        conversation = ConversationService.resolve_or_create_dm(
            organization_id=str(organization_id),
            requester_id=str(actor_user_id),
            other_user_id=str(other_user_id),
            conversation_id_hint=hint or None,
        )
    except ValueError as exc:
        raise PermanentIMBusinessProjectionError(str(exc)) from exc
    return str(conversation.id)


def _send_django_user_business_projection(
    *,
    conversation_id: str,
    user_id: str,
    message_ref: str,
    client_request_id: str,
    content: str,
    message_type: int,
    metadata: dict,
) -> dict:
    from apps.tabchat.constants import MessageType
    from apps.tabchat.services.message_service import MessageService

    if int(message_type) != int(MessageType.TEXT):
        raise PermanentIMBusinessProjectionError("Django IM 业务投影仅支持文本卡片")
    expected_card = metadata.get("card") if isinstance(metadata, dict) else None
    identity_field = next(
        (
            field
            for field in ("object_id", "share_id", "handoff_id")
            if isinstance(expected_card, dict) and expected_card.get(field)
        ),
        None,
    )
    if (
        not isinstance(expected_card, dict)
        or not expected_card.get("type")
        or not identity_field
    ):
        raise PermanentIMBusinessProjectionError("Django IM card identity is required")
    try:
        message = MessageService.send_message(
            conversation_id=str(conversation_id),
            sender_id=str(user_id),
            content=content,
            message_type=MessageType.TEXT,
            metadata={**metadata, "message_ref": message_ref},
            client_request_id=str(client_request_id or message_ref),
        )
    except (PermissionError, ValueError) as exc:
        raise PermanentIMBusinessProjectionError(str(exc)) from exc
    persisted_metadata = message.metadata or {}
    persisted_card = persisted_metadata.get("card")
    if (
        not isinstance(persisted_card, dict)
        or persisted_card.get("type") != expected_card["type"]
        or str(persisted_card.get(identity_field) or "")
        != str(expected_card[identity_field])
        or str(persisted_metadata.get("message_ref") or "") != str(message_ref)
    ):
        raise PermanentIMBusinessProjectionError(
            "client_request_id 已用于其他 Django IM 消息",
        )
    return {
        "id": message.id,
        "seq": message.seq,
        "conversation_id": str(message.conversation_id),
    }


def _refresh_django_user_business_projection(
    *,
    organization_id: str,
    message_ref: str,
    content: str,
    metadata: dict,
) -> dict:
    from django.db import transaction

    from apps.services.common.db_router import postgres_app_db_alias
    from apps.tabchat.constants import IMEventType
    from apps.tabchat.models import Message
    from apps.tabchat.services.im_outbox_service import IMOutboxService
    from apps.tabchat.services.message_service import MessageService, _serialize_message

    raw_ref = str(message_ref or "").strip()
    if not raw_ref:
        raise PermanentIMBusinessProjectionError("message_ref is required")
    card = metadata.get("card") if isinstance(metadata, dict) else None
    if not isinstance(card, dict):
        raise PermanentIMBusinessProjectionError("Django IM card metadata is required")
    card_type = str(card.get("type") or "").strip()
    identity_field = next(
        (field for field in ("object_id", "share_id", "handoff_id") if card.get(field)),
        None,
    )
    if not card_type or identity_field is None:
        raise PermanentIMBusinessProjectionError("Django IM card identity is required")
    with transaction.atomic(using=postgres_app_db_alias()):
        message = (
            Message.objects.select_for_update()
            .select_related("conversation")
            .filter(
                conversation__organization_id=str(organization_id),
                client_request_id=raw_ref,
                metadata__card__type=card_type,
                **{f"metadata__card__{identity_field}": str(card[identity_field])},
            )
            .first()
        )
        if message is None:
            raise PermanentIMBusinessProjectionError("Django IM card message not found")
        message.metadata = {
            **(message.metadata or {}),
            **metadata,
            "message_ref": raw_ref,
        }
        message.content = content
        message.save(update_fields=["content", "metadata"])
        IMOutboxService.enqueue(
            organization_id=str(message.conversation.organization_id),
            event_type=IMEventType.MESSAGE_EDITED,
            target_channels=[f"chat:{message.conversation_id}"],
            data=_serialize_message(
                message,
                sender_name=MessageService._resolve_user_sender_name(message.sender_id),
            ),
            conversation=message.conversation,
            message=message,
        )
    return {
        "id": message.id,
        "seq": message.seq,
        "conversation_id": str(message.conversation_id),
    }


def resolve_direct_conversation(
    *,
    organization_id: str,
    other_user_id: str,
    authorization_header: str = "",
    conversation_id_hint: str | None = None,
    actor_user_id: str | None = None,
) -> str:
    del authorization_header
    actor_id = str(actor_user_id or "").strip()
    if not actor_id:
        raise PermanentIMBusinessProjectionError(
            "Django IM 需要 actor_user_id 才能创建或访问私聊",
        )
    return _resolve_django_direct_conversation(
        organization_id=str(organization_id),
        actor_user_id=actor_id,
        other_user_id=str(other_user_id),
        conversation_id_hint=conversation_id_hint,
    )


def send_user_business_projection(
    *,
    organization_id: str,
    conversation_id: str,
    message_ref: str,
    client_request_id: str,
    user_id: str,
    content: str,
    message_type: int,
    metadata: dict,
) -> dict:
    del organization_id
    return _send_django_user_business_projection(
        conversation_id=conversation_id,
        user_id=user_id,
        message_ref=message_ref,
        client_request_id=client_request_id,
        content=content,
        message_type=message_type,
        metadata=metadata,
    )


def refresh_user_business_projection(
    *,
    organization_id: str,
    message_ref: str,
    business_projection_revision: str,
    content: str,
    message_type: int,
    metadata: dict,
) -> dict:
    del business_projection_revision, message_type
    return _refresh_django_user_business_projection(
        organization_id=organization_id,
        message_ref=message_ref,
        content=content,
        metadata=metadata,
    )

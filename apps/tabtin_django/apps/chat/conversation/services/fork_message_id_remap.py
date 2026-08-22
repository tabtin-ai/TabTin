"""Stable message-id remapping shared by cloud and local session forks."""

from __future__ import annotations

import copy
import uuid
from typing import Any, Mapping


def forked_message_id(
    target_session_id: uuid.UUID | str,
    source_message_id: uuid.UUID | str,
) -> uuid.UUID:
    """Derive the copied message UUID from the target session and source UUID."""
    target_id = uuid.UUID(str(target_session_id))
    source_id = uuid.UUID(str(source_message_id))
    return uuid.uuid5(target_id, f"{target_id}:{source_id}")


def remap_message_ids_in_value(
    value: Any,
    message_id_remap: Mapping[str, str] | None,
) -> Any:
    """Copy JSON-compatible data and rewrite explicit message-id references."""
    return _remap_message_ids_in_value(value, message_id_remap, field_name=None)


def _remap_message_ids_in_value(
    value: Any,
    message_id_remap: Mapping[str, str] | None,
    *,
    field_name: str | None,
) -> Any:
    if not message_id_remap:
        return copy.deepcopy(value)
    if isinstance(value, str):
        is_message_id_field = (
            field_name in {"message_id", "messageId", "message_ids", "messageIds"}
            or bool(field_name and field_name.endswith("_message_id"))
            or bool(field_name and field_name.endswith("MessageId"))
        )
        return message_id_remap.get(value, value) if is_message_id_field else value
    if isinstance(value, list):
        return [
            _remap_message_ids_in_value(
                item,
                message_id_remap,
                field_name=field_name,
            )
            for item in value
        ]
    if isinstance(value, dict):
        return {
            key: _remap_message_ids_in_value(
                child,
                message_id_remap,
                field_name=key,
            )
            for key, child in value.items()
        }
    return copy.deepcopy(value)

import json
import os
from uuid import UUID

from apps.chat.conversation.models import ChatMessage, ChatSession


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def extract_text_from_blocks(blocks) -> str:
    texts: list[str] = []
    for block in blocks or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text") or ""
            if text:
                texts.append(text)
    return "\n".join(texts)


def main() -> None:
    marker = require_env("TABTIN_E2E_MARKER")
    space_id = UUID(require_env("TABTIN_E2E_SPACE_ID"))
    session_id_raw = os.environ.get("TABTIN_E2E_SESSION_ID", "").strip()
    session_id = UUID(session_id_raw) if session_id_raw else None
    message_id_raw = os.environ.get("TABTIN_E2E_MESSAGE_ID", "").strip()
    message_id = UUID(message_id_raw) if message_id_raw else None

    session_ids: list[UUID]
    if session_id:
        session_ids = [session_id]
    else:
        session_ids = list(
            ChatSession.objects.filter(space_id=space_id).values_list("id", flat=True),
        )
        if not session_ids:
            raise RuntimeError(f"No chat sessions found for space {space_id}")

    messages = ChatMessage.objects.filter(session_id__in=session_ids, role="user")
    if message_id:
        messages = messages.filter(id=message_id)
    else:
        messages = messages.order_by("-created_at")[:100]

    found = None
    for message in messages:
        combined = "\n".join(
            part for part in [message.text_summary or "", extract_text_from_blocks(message.content_blocks_json)] if part
        )
        if marker in combined:
            found = message
            break

    if not found:
        raise RuntimeError(
            f"No persisted user message containing marker {marker!r} in space {space_id}",
        )

    summary = {
        "messageId": str(found.id),
        "sessionId": str(found.session_id),
        "role": found.role,
        "textSummary": found.text_summary,
        "marker": marker,
        "spaceId": str(space_id),
        "metadataSource": (found.metadata or {}).get("source"),
        "persistedVia": (found.metadata or {}).get("_persisted_via"),
        "clientEventId": str(found.client_event_id) if found.client_event_id else None,
        "queriedSessionId": str(session_id) if session_id else None,
        "queriedMessageId": str(message_id) if message_id else None,
    }
    print("@@E2E@@" + json.dumps(summary, ensure_ascii=False))


main()

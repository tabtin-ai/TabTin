import json
import os
from datetime import timedelta
from uuid import uuid4

from django.db import transaction
from django.utils import timezone

from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.tabtinspace.models import Organization, OrganizationMember, Space, SpaceMembership
from tests.electron.fixtures.e2e_auth_common import (
    DEFAULT_E2E_PASSWORD,
    build_electron_auth_payload,
    ensure_e2e_invite_redemption,
    ensure_e2e_user,
)


MIN_HISTORY_MESSAGES = 20
LONG_USER_CHARS = 2000


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def ensure_user(run_id: str):
    suffix = run_id[-12:].replace("-", "").replace("_", "").lower()
    return ensure_e2e_user(
        email=f"chat-viewport-anchor-{suffix}@example.com",
        username=f"chat_viewport_anchor_{suffix}",
        nickname="对话视口锚点验收用户",
        password=DEFAULT_E2E_PASSWORD,
    )


def build_long_user_text(marker: str) -> str:
    """Build a collapsible user message (>= 2000 chars) with a stable marker."""
    header = f"{marker}\nchat.viewport-anchor-preservation long user message\n"
    body_line = "阅读锚点稳定性验收正文行 — keep reading position stable while expanding.\n"
    chunks = [header]
    while sum(len(part) for part in chunks) < LONG_USER_CHARS:
        chunks.append(body_line)
    text = "".join(chunks)
    if len(text) < LONG_USER_CHARS:
        text += "x" * (LONG_USER_CHARS - len(text))
    return text


def ensure_context(run_id: str) -> dict:
    marker = f"tabtin-{run_id}-viewport-anchor"
    user, user_created = ensure_user(run_id)
    invite_redeemed = ensure_e2e_invite_redemption(user)

    organization, organization_created = Organization.objects.get_or_create(
        name=f"[{run_id}] Chat Viewport Anchor Organization",
        defaults={
            "owner": user,
            "description": "Run-scoped Organization for chat viewport anchor E2E.",
            "icon": "📌",
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e": True, "scenario": "chat.viewport-anchor-preservation"},
        },
    )
    if organization.owner_id != user.id:
        organization.owner = user
        organization.save(update_fields=["owner", "updated_at"])
    OrganizationMember.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"role": "owner"},
    )

    space, space_created = Space.objects.get_or_create(
        organization=organization,
        name=f"[{run_id}] Chat Viewport Anchor Space",
        defaults={
            "type": Space.SpaceType.WORKSPACE,
            "description": "Run-scoped personal Space for chat viewport anchor E2E.",
            "status": "active",
            "is_default": False,
            "visibility": "private",
        },
    )
    if space.type != Space.SpaceType.WORKSPACE:
        space.type = Space.SpaceType.WORKSPACE
        space.save(update_fields=["type", "updated_at"])
    SpaceMembership.objects.get_or_create(
        space=space,
        user=user,
        defaults={"role": "owner", "is_active": True},
    )

    session, session_created = ChatSession.objects.get_or_create(
        user=user,
        organization_id=str(organization.id),
        space=space,
        title=f"[{run_id}] viewport anchor session",
        defaults={
            "title_generation_status": "done",
            "status": "active",
        },
    )
    if session.status != "active":
        session.status = "active"
        session.title_generation_status = "done"
        session.save(update_fields=["status", "title_generation_status", "updated_at"])

    return {
        "runId": run_id,
        "marker": marker,
        "user": user,
        "userCreated": user_created,
        "inviteRedeemed": invite_redeemed,
        "organization": organization,
        "organizationCreated": organization_created,
        "space": space,
        "spaceCreated": space_created,
        "session": session,
        "sessionCreated": session_created,
    }


@transaction.atomic
def seed_history_messages(context: dict) -> dict:
    """Seed >=20 messages; second-to-last is long user; last is finalized assistant.

    Fixture only prepares the world — it does not expand UI or write scroll state.
    """
    session = context["session"]
    user = context["user"]
    marker = context["marker"]

    existing = list(ChatMessage.objects.filter(session=session).order_by("created_at", "id"))
    long_candidate = existing[-2] if len(existing) >= MIN_HISTORY_MESSAGES else None
    final_candidate = existing[-1] if len(existing) >= MIN_HISTORY_MESSAGES else None
    can_reuse = bool(
        long_candidate
        and long_candidate.id
        and long_candidate.role == "user"
        and long_candidate.sender_user_id == str(user.id)
        and marker in (long_candidate.text_summary or "")
        and len(long_candidate.text_summary or "") >= LONG_USER_CHARS
        and final_candidate
        and final_candidate.role == "assistant"
        and final_candidate.stop_reason == "end_turn"
    )
    if can_reuse:
        return {
            "longMessageId": str(long_candidate.id),
            "messageCount": len(existing),
            "lastMessageId": str(final_candidate.id),
            "lastRole": final_candidate.role,
            "longMessageChars": len(long_candidate.text_summary or ""),
            "reused": True,
        }

    # This session is named with run_id and is therefore run-scoped. Restrict
    # cleanup to this exact session so data belonging to other E2E runs remains
    # untouched.
    ChatMessage.objects.filter(session=session).delete()

    base_time = timezone.now() - timedelta(minutes=40)
    # 18 short turns + long user + finalized assistant = 20 messages.
    pair_count = (MIN_HISTORY_MESSAGES - 2) // 2
    for index in range(pair_count):
        user_text = f"{marker} history-user-{index + 1}"
        assistant_text = f"{marker} history-assistant-{index + 1}"
        user_msg = ChatMessage.objects.create(
            session=session,
            role="user",
            sender_user_id=str(user.id),
            message_kind="llm",
            text_summary=user_text,
            content_blocks_json=[{"type": "text", "text": user_text}],
            metadata={"e2e": True, "scenario": "chat.viewport-anchor-preservation", "index": index},
        )
        assistant_msg = ChatMessage.objects.create(
            session=session,
            role="assistant",
            message_kind="llm",
            text_summary=assistant_text,
            content_blocks_json=[{"type": "text", "text": assistant_text}],
            stop_reason="end_turn",
            metadata={"e2e": True, "scenario": "chat.viewport-anchor-preservation", "index": index},
        )
        ChatMessage.objects.filter(id=user_msg.id).update(
            created_at=base_time + timedelta(seconds=index * 2),
            updated_at=base_time + timedelta(seconds=index * 2),
        )
        ChatMessage.objects.filter(id=assistant_msg.id).update(
            created_at=base_time + timedelta(seconds=index * 2 + 1),
            updated_at=base_time + timedelta(seconds=index * 2 + 1),
        )

    long_text = build_long_user_text(marker)
    if len(long_text) < LONG_USER_CHARS:
        raise RuntimeError(f"Long user message too short: {len(long_text)}")

    long_msg = ChatMessage.objects.create(
        id=uuid4(),
        session=session,
        role="user",
        sender_user_id=str(user.id),
        message_kind="llm",
        # Full text in text_summary so Electron content (mapped from text_summary) exceeds
        # CollapsibleMessage threshold without relying on truncated API summaries.
        text_summary=long_text,
        content_blocks_json=[{"type": "text", "text": long_text}],
        metadata={"e2e": True, "scenario": "chat.viewport-anchor-preservation", "long": True},
    )
    final_assistant_text = f"{marker} finalized assistant reply after long user message."
    final_assistant = ChatMessage.objects.create(
        session=session,
        role="assistant",
        message_kind="llm",
        text_summary=final_assistant_text,
        content_blocks_json=[{"type": "text", "text": final_assistant_text}],
        stop_reason="end_turn",
        metadata={"e2e": True, "scenario": "chat.viewport-anchor-preservation", "final": True},
    )

    long_ts = base_time + timedelta(seconds=pair_count * 2 + 10)
    final_ts = long_ts + timedelta(seconds=1)
    ChatMessage.objects.filter(id=long_msg.id).update(created_at=long_ts, updated_at=long_ts)
    ChatMessage.objects.filter(id=final_assistant.id).update(created_at=final_ts, updated_at=final_ts)

    session.last_message_at = final_ts
    session.save(update_fields=["last_message_at", "updated_at"])

    message_count = ChatMessage.objects.filter(session=session).count()
    if message_count < MIN_HISTORY_MESSAGES:
        raise RuntimeError(f"Expected >= {MIN_HISTORY_MESSAGES} messages, got {message_count}")

    return {
        "longMessageId": str(long_msg.id),
        "messageCount": message_count,
        "lastMessageId": str(final_assistant.id),
        "lastRole": final_assistant.role,
        "longMessageChars": len(long_text),
        "reused": False,
    }


def prepare_case() -> None:
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    seeded = seed_history_messages(context)
    emit(
        {
            "runId": context["runId"],
            "marker": context["marker"],
            "organizationId": str(context["organization"].id),
            "userId": str(context["user"].id),
            "spaceId": str(context["space"].id),
            "sessionId": str(context["session"].id),
            "longMessageId": seeded["longMessageId"],
            "messageCount": seeded["messageCount"],
            "lastMessageId": seeded["lastMessageId"],
            "lastRole": seeded["lastRole"],
            "longMessageChars": seeded.get("longMessageChars"),
            "organizationCreated": context["organizationCreated"],
            "spaceCreated": context["spaceCreated"],
            "sessionCreated": context["sessionCreated"],
            "userCreated": context["userCreated"],
            "inviteRedeemed": context["inviteRedeemed"],
            "seedReused": seeded["reused"],
            "source": "electron-e2e-chat-viewport-anchor",
        }
    )


def auth_case() -> None:
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    emit(
        build_electron_auth_payload(
            user=context["user"],
            organization=context["organization"],
            space=context["space"],
            created_user=False,
            space_created=False,
            invite_redeemed=ensure_e2e_invite_redemption(context["user"]),
        )
    )


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    if mode == "prepare":
        prepare_case()
        return
    if mode == "auth":
        auth_case()
        return
    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()

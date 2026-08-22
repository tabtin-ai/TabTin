import uuid
from unittest.mock import patch

import pytest

from apps.chat.conversation.services.message_role_policy import (
    is_system_authored_message,
    llm_role_for_persisted_message,
    persisted_role_for_user_event,
)
from apps.services.common.ws.handlers.relay_message_writer import (
    SyncWriteResult,
    _write_chat_messages,
    _write_persist_messages,
)


def test_real_user_event_remains_user():
    assert persisted_role_for_user_event({"message_kind": "llm"}) == "user"
    assert persisted_role_for_user_event({
        "message_kind": "llm",
        "triggered_by": "user",
    }) == "user"


def test_context_skill_and_push_events_persist_as_system():
    assert persisted_role_for_user_event({
        "message_kind": "environment_context",
    }) == "system"
    assert persisted_role_for_user_event({
        "message_kind": "llm",
        "source": "skill_invoke",
    }) == "system"
    assert persisted_role_for_user_event({
        "message_kind": "llm",
        "source": "tool_injected",
    }) == "system"
    assert persisted_role_for_user_event({
        "message_kind": "llm",
        "triggered_by": "push-notification",
    }) == "system"
    assert persisted_role_for_user_event({
        "message_kind": "external_archive_context",
    }) == "system"
    assert persisted_role_for_user_event({
        "message_kind": "llm",
        "triggered_by": "parent_midflight",
    }) == "system"


def test_unknown_trigger_does_not_silently_become_system_authored():
    assert persisted_role_for_user_event({
        "message_kind": "llm",
        "triggered_by": "future-human-trigger",
    }) == "user"


def test_metadata_is_supported_for_cold_history_classification():
    assert is_system_authored_message(
        message_kind="llm",
        metadata={"source": "skill_invoke"},
    ) is True


def test_persisted_system_context_projects_to_llm_user():
    assert llm_role_for_persisted_message(
        role="system",
        message_kind="environment_context",
    ) == "user"
    assert llm_role_for_persisted_message(
        role="assistant",
        message_kind="llm",
    ) == "assistant"


@pytest.mark.parametrize("payload", [
    {"message_kind": "environment_context"},
    {"message_kind": "external_archive_context"},
    {"source": "skill_invoke"},
    {"source": "tool_injected"},
    {"triggered_by": "push-notification"},
    {"triggered_by": "parent_midflight"},
])
def test_relay_user_event_writes_system_role(payload):
    event_payload = {
        "client_event_id": str(uuid.uuid4()),
        "content": "system generated",
        **payload,
    }
    result = SyncWriteResult()

    with patch(
        "apps.services.common.ws.handlers.relay_message_writer._upsert_chat_message",
        return_value=uuid.uuid4(),
    ) as upsert:
        _write_chat_messages(
            "session-1",
            "user-1",
            [{"type": "agent.stream.user", "payload": event_payload}],
            result,
        )

    assert result.success is True
    assert upsert.call_args.kwargs["role"] == "system"


@pytest.mark.parametrize("message_kind", ["compaction_summary", "hitl_interaction"])
def test_persist_message_path_writes_internal_user_payload_as_system(message_kind):
    from apps.chat.conversation.models import ChatMessage, ChatSession

    message_id = uuid.uuid4()
    persisted = type("PersistedMessage", (), {
        "id": message_id,
        "text_summary": "summary",
    })()
    result = SyncWriteResult()
    event = {
        "type": "agent.stream.persist_message",
        "payload": {
            "message_id": str(message_id),
            "role": "user",
            "message_kind": message_kind,
            "blocks_json": [{"type": "text", "text": "system generated"}],
        },
    }

    with (
        patch.object(ChatSession.objects, "filter") as session_filter,
        patch.object(
            ChatMessage.objects,
            "update_or_create",
            return_value=(persisted, True),
        ) as update_or_create,
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
        ),
        patch(
            "apps.chat.conversation.services.workspace_file.index_message_workspace_file_refs",
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_message_committed",
        ),
    ):
        session_filter.return_value.values_list.return_value.first.return_value = None
        _write_persist_messages("session-1", "user-1", [event], result)

    assert result.success is True
    defaults = update_or_create.call_args.kwargs["defaults"]
    assert defaults["role"] == "system"
    assert defaults["message_kind"] == message_kind

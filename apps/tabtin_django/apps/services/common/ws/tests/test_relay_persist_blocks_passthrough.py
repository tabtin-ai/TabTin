"""relay 落库：blocks 只认 runtime 下发，服务端不合成、不盖章。"""
from __future__ import annotations

import uuid
from contextlib import nullcontext
from unittest.mock import MagicMock, patch

import pytest
from django.db import IntegrityError

from apps.services.common.ws.handlers.relay_message_writer import (
    SyncWriteResult,
    _update_or_create_fork_aware_message,
    _write_persist_messages,
)
from apps.services.common.ws.handlers import relay_message_writer as writer


def _run_upsert(*, content: str, payload: dict) -> dict:
    create_kwargs_holder: dict = {}

    class _CM:
        objects = MagicMock()

    def create(**kwargs):
        create_kwargs_holder.update(kwargs)
        row = MagicMock()
        row.id = kwargs.get("id") or uuid.UUID("11111111-1111-4111-8111-111111111111")
        return row

    _CM.objects.create.side_effect = create
    _CM.objects.filter.return_value.exists.return_value = False

    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=100,
        ),
        patch(
            "apps.services.common.ws.handlers.content_block_reassembler.derive_text_summary",
            return_value="summary",
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_team_space_assets_for_message",
        ),
    ):
        writer._upsert_chat_message(
            session_id="22222222-2222-4222-8222-222222222222",
            client_event_uuid=uuid.UUID("33333333-3333-4333-8333-333333333333"),
            role="user",
            content=content,
            payload=payload,
            user_id=None,
            client_event_id_str="33333333-3333-4333-8333-333333333333",
        )
    return create_kwargs_holder


def test_upsert_user_without_blocks_json_does_not_synthesize():
    """缺 blocks_json 时不得用 content 合成 text block（契约改由 runtime 带齐）。"""
    kwargs = _run_upsert(
        content="<task-notification>" + ("x" * 300) + "</task-notification>",
        payload={"arrival_seq": 100},
    )
    assert "content_blocks_json" not in kwargs


def test_upsert_user_passthrough_runtime_blocks():
    blocks = [
        {"type": "text", "text": "请总结"},
        {"type": "file", "file_id": "f1"},
    ]
    kwargs = _run_upsert(
        content="请总结",
        payload={"blocks_json": blocks, "arrival_seq": 100},
    )
    assert kwargs["content_blocks_json"] is blocks


def test_upsert_user_passthrough_compaction_summary_kind():
    """#7339：user 路径必须透传 compaction_summary，避免落成默认 llm 用户气泡。"""
    blocks = [{"type": "text", "text": "[对话摘要]\n\nx\n\n[摘要结束]\n\n[最近对话如下]"}]
    kwargs = _run_upsert(
        content=blocks[0]["text"],
        payload={
            "blocks_json": blocks,
            "arrival_seq": 100,
            "message_kind": "compaction_summary",
        },
    )
    assert kwargs["message_kind"] == "compaction_summary"


def test_upsert_user_preserves_agent_profile_context_kind():
    kwargs = _run_upsert(
        content='<context type="agent-profile">\n你是小 Tin。\n</context>',
        payload={
            "message_kind": "agent_profile_context",
            "blocks_json": [{
                "type": "text",
                "text": '<context type="agent-profile">\n你是小 Tin。\n</context>',
            }],
            "arrival_seq": 100,
        },
    )
    assert kwargs["message_kind"] == "agent_profile_context"


def test_upsert_legacy_user_replay_reuses_the_fork_copy():
    source_id = uuid.UUID("11111111-1111-4111-8111-111111111111")
    target_id = uuid.UUID("22222222-2222-4222-8222-222222222222")

    class _CM:
        objects = MagicMock()

    _CM.objects.create.side_effect = IntegrityError("duplicate primary key")
    _CM.objects.filter.return_value.values_list.return_value.first.return_value = None

    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=100,
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._resolve_fork_replay_target",
            return_value=(target_id, False),
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_team_space_assets_for_message",
        ) as publish_assets,
    ):
        resolved = writer._upsert_chat_message(
            session_id="33333333-3333-4333-8333-333333333333",
            client_event_uuid=uuid.UUID("44444444-4444-4444-8444-444444444444"),
            role="user",
            content="before fork",
            payload={"message_id": str(source_id), "arrival_seq": 100},
            user_id=None,
            client_event_id_str="44444444-4444-4444-8444-444444444444",
        )

    assert resolved == target_id
    publish_assets.assert_called_once_with(target_id)


def test_upsert_legacy_user_replay_after_fork_boundary_is_stale():
    source_id = uuid.UUID("11111111-1111-4111-8111-111111111111")

    class _CM:
        objects = MagicMock()

    _CM.objects.create.side_effect = IntegrityError("duplicate primary key")
    _CM.objects.filter.return_value.values_list.return_value.first.return_value = None

    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=200,
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._resolve_fork_replay_target",
            return_value=(None, True),
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
        pytest.raises(writer._StaleForkReplay),
    ):
        writer._upsert_chat_message(
            session_id="33333333-3333-4333-8333-333333333333",
            client_event_uuid=uuid.UUID("44444444-4444-4444-8444-444444444444"),
            role="user",
            content="after fork",
            payload={"message_id": str(source_id), "arrival_seq": 200},
            user_id=None,
            client_event_id_str="44444444-4444-4444-8444-444444444444",
        )


def test_write_persist_messages_passthrough_blocks_identity():
    result = SyncWriteResult(success=True)
    blocks = [
        {"type": "tool_use", "id": "t1", "arrival_seq": 200},
        {"type": "text", "text": "done", "arrival_seq": 300},
    ]
    events = [{
        "payload": {
            "message_id": "11111111-1111-4111-8111-111111111111",
            "role": "assistant",
            "blocks_json": blocks,
            "arrival_seq": 9999,
            "message_kind": "llm",
        },
    }]

    stored: dict = {}
    mock_msg = MagicMock()
    mock_msg.id = events[0]["payload"]["message_id"]
    mock_msg.text_summary = "done"

    class _CM:
        objects = MagicMock()

    class _CS:
        objects = MagicMock()

    _CS.objects.filter.return_value.values_list.return_value.first.return_value = None

    def update_or_create(**kwargs):
        stored.update(kwargs)
        return mock_msg, True

    _CM.objects.update_or_create.side_effect = update_or_create

    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch("apps.chat.conversation.models.ChatSession", _CS),
        patch(
            "apps.services.common.ws.handlers.content_block_reassembler.derive_text_summary",
            return_value="done",
        ),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=9999,
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_message_committed",
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
    ):
        _write_persist_messages(
            "22222222-2222-4222-8222-222222222222",
            None,
            events,
            result,
        )

    assert result.success is True
    assert stored["defaults"]["content_blocks_json"] is blocks


def test_fork_replay_collision_updates_the_copied_target_message():
    source_id = uuid.UUID("11111111-1111-4111-8111-111111111111")
    target_id = uuid.UUID("22222222-2222-4222-8222-222222222222")
    target_message = MagicMock(id=target_id)

    class _CM:
        objects = MagicMock()

    _CM.objects.update_or_create.side_effect = [
        IntegrityError("duplicate primary key"),
        (target_message, False),
    ]

    with (
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._resolve_fork_replay_target",
            return_value=(target_id, False),
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
    ):
        message, server_id = _update_or_create_fork_aware_message(
            chat_message_model=_CM,
            session_id="33333333-3333-4333-8333-333333333333",
            message_id=source_id,
            defaults={"role": "assistant"},
        )

    assert message is target_message
    assert server_id == target_id
    assert [call.kwargs["id"] for call in _CM.objects.update_or_create.call_args_list] == [
        source_id,
        target_id,
    ]


def test_fork_replay_after_boundary_is_acked_without_writing():
    source_id = uuid.UUID("11111111-1111-4111-8111-111111111111")

    class _CM:
        objects = MagicMock()

    _CM.objects.update_or_create.side_effect = IntegrityError("duplicate primary key")

    with (
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._resolve_fork_replay_target",
            return_value=(None, True),
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
    ):
        message, server_id = _update_or_create_fork_aware_message(
            chat_message_model=_CM,
            session_id="33333333-3333-4333-8333-333333333333",
            message_id=source_id,
            defaults={"role": "assistant"},
        )

    assert message is None
    assert server_id is None
    assert _CM.objects.update_or_create.call_count == 1


def test_non_fork_primary_key_collision_still_fails_loudly():
    source_id = uuid.UUID("11111111-1111-4111-8111-111111111111")

    class _CM:
        objects = MagicMock()

    _CM.objects.update_or_create.side_effect = IntegrityError("duplicate primary key")

    with (
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._resolve_fork_replay_target",
            return_value=(None, False),
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
        pytest.raises(IntegrityError),
    ):
        _update_or_create_fork_aware_message(
            chat_message_model=_CM,
            session_id="33333333-3333-4333-8333-333333333333",
            message_id=source_id,
            defaults={"role": "assistant"},
        )


def test_write_persist_messages_acks_stale_fork_replay_without_publish():
    result = SyncWriteResult(success=True)
    events = [{
        "payload": {
            "message_id": "11111111-1111-4111-8111-111111111111",
            "role": "assistant",
            "blocks_json": [{"type": "text", "text": "after fork"}],
            "arrival_seq": 200,
        },
    }]

    class _CM:
        objects = MagicMock()

    class _CS:
        objects = MagicMock()

    _CS.objects.filter.return_value.values_list.return_value.first.return_value = None

    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch("apps.chat.conversation.models.ChatSession", _CS),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._update_or_create_fork_aware_message",
            return_value=(None, None),
        ),
        patch(
            "apps.services.common.ws.handlers.content_block_reassembler.derive_text_summary",
            return_value="after fork",
        ),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=200,
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_message_committed",
        ) as publish_committed,
    ):
        _write_persist_messages(
            "33333333-3333-4333-8333-333333333333",
            None,
            events,
            result,
        )

    assert result.success is True
    assert result.error_details == []
    assert result.events_written == 0
    publish_committed.assert_not_called()


def test_write_persist_messages_reports_remapped_fork_target_id():
    result = SyncWriteResult(success=True)
    source_id = "11111111-1111-4111-8111-111111111111"
    target_id = uuid.UUID("22222222-2222-4222-8222-222222222222")
    events = [{
        "payload": {
            "message_id": source_id,
            "role": "assistant",
            "blocks_json": [{"type": "text", "text": "before fork"}],
            "arrival_seq": 100,
        },
    }]
    target_message = MagicMock(id=target_id, text_summary="before fork")

    class _CM:
        objects = MagicMock()

    class _CS:
        objects = MagicMock()

    _CS.objects.filter.return_value.values_list.return_value.first.return_value = None

    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch("apps.chat.conversation.models.ChatSession", _CS),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._update_or_create_fork_aware_message",
            return_value=(target_message, target_id),
        ),
        patch(
            "apps.services.common.ws.handlers.content_block_reassembler.derive_text_summary",
            return_value="before fork",
        ),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=100,
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_message_committed",
        ) as publish_committed,
    ):
        _write_persist_messages(
            "33333333-3333-4333-8333-333333333333",
            None,
            events,
            result,
        )

    assert result.success is True
    assert result.message_ids == [{
        "client_event_id": source_id,
        "server_id": str(target_id),
    }]
    assert publish_committed.call_args.kwargs["message_id"] == str(target_id)


def test_write_persist_messages_preserves_empty_billing_error():
    """空正文错误也要把结构化错误落库，供刷新后渲染统一提示卡。"""
    result = SyncWriteResult(success=True)
    error_info = {
        "error_class": "LLM_BILLING_ERROR",
        "category": "organization_insufficient_credits",
        "suggested_action": "check_billing",
    }
    events = [{
        "payload": {
            "message_id": "11111111-1111-4111-8111-111111111111",
            "role": "assistant",
            "blocks_json": [],
            "stop_reason": "error",
            "partial": True,
            "error_info_json": error_info,
        },
    }]
    stored: dict = {}
    mock_msg = MagicMock(id=events[0]["payload"]["message_id"], text_summary="")

    class _CM:
        objects = MagicMock()

    class _CS:
        objects = MagicMock()

    _CS.objects.filter.return_value.values_list.return_value.first.return_value = None

    def update_or_create(**kwargs):
        stored.update(kwargs)
        return mock_msg, True

    _CM.objects.update_or_create.side_effect = update_or_create
    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch("apps.chat.conversation.models.ChatSession", _CS),
        patch(
            "apps.services.common.ws.handlers.content_block_reassembler.derive_text_summary",
            return_value="",
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_message_committed",
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
    ):
        _write_persist_messages(
            "22222222-2222-4222-8222-222222222222",
            None,
            events,
            result,
        )

    assert stored["defaults"]["content_blocks_json"] == []
    assert stored["defaults"]["text_summary"] == ""
    assert stored["defaults"]["error_info_json"] is error_info


def test_write_persist_messages_skips_empty_assistant_without_error_info():
    """无正文且无结构化错误的 assistant 不是可渲染消息，不应落库。"""
    result = SyncWriteResult(success=True)
    events = [{
        "payload": {
            "message_id": "11111111-1111-4111-8111-111111111111",
            "role": "assistant",
            "blocks_json": [],
            "message_kind": "llm",
        },
    }]

    class _CM:
        objects = MagicMock()

    class _CS:
        objects = MagicMock()

    _CS.objects.filter.return_value.values_list.return_value.first.return_value = None
    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch("apps.chat.conversation.models.ChatSession", _CS),
        patch(
            "apps.services.common.ws.handlers.content_block_reassembler.derive_text_summary",
            return_value="",
        ),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=None,
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_message_committed",
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
    ):
        _write_persist_messages(
            "22222222-2222-4222-8222-222222222222",
            None,
            events,
            result,
        )

    _CM.objects.update_or_create.assert_not_called()


def test_write_persist_messages_passthrough_agent_run_id():
    """#7480：persist_message 主路径必须把 payload.agent_run_id 写入 ChatMessage。"""
    result = SyncWriteResult(success=True)
    run_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    events = [{
        "payload": {
            "message_id": "11111111-1111-4111-8111-111111111111",
            "role": "assistant",
            "blocks_json": [{"type": "text", "text": "ok"}],
            "arrival_seq": 1,
            "message_kind": "llm",
            "agent_run_id": run_id,
        },
    }]

    stored: dict = {}
    mock_msg = MagicMock()
    mock_msg.id = events[0]["payload"]["message_id"]
    mock_msg.text_summary = "ok"

    class _CM:
        objects = MagicMock()

    class _CS:
        objects = MagicMock()

    _CS.objects.filter.return_value.values_list.return_value.first.return_value = None

    def update_or_create(**kwargs):
        stored.update(kwargs)
        return mock_msg, True

    _CM.objects.update_or_create.side_effect = update_or_create

    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch("apps.chat.conversation.models.ChatSession", _CS),
        patch(
            "apps.services.common.ws.handlers.content_block_reassembler.derive_text_summary",
            return_value="ok",
        ),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=1,
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_message_committed",
        ) as publish_committed,
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
    ):
        _write_persist_messages(
            "22222222-2222-4222-8222-222222222222",
            None,
            events,
            result,
        )

    assert result.success is True
    assert stored["defaults"]["agent_run_id"] == run_id
    assert publish_committed.call_args.kwargs["state_dict"]["run_id"] == run_id


def test_write_persist_messages_ignores_empty_agent_run_id():
    """空 agent_run_id 不写入 defaults（避免用空串覆盖已有值）。"""
    result = SyncWriteResult(success=True)
    events = [{
        "payload": {
            "message_id": "11111111-1111-4111-8111-111111111111",
            "role": "assistant",
            "blocks_json": [{"type": "text", "text": "ok"}],
            "arrival_seq": 1,
            "message_kind": "llm",
            "agent_run_id": "   ",
        },
    }]

    stored: dict = {}
    mock_msg = MagicMock()
    mock_msg.id = events[0]["payload"]["message_id"]
    mock_msg.text_summary = "ok"

    class _CM:
        objects = MagicMock()

    class _CS:
        objects = MagicMock()

    _CS.objects.filter.return_value.values_list.return_value.first.return_value = None

    def update_or_create(**kwargs):
        stored.update(kwargs)
        return mock_msg, True

    _CM.objects.update_or_create.side_effect = update_or_create

    with (
        patch("apps.chat.conversation.models.ChatMessage", _CM),
        patch("apps.chat.conversation.models.ChatSession", _CS),
        patch(
            "apps.services.common.ws.handlers.content_block_reassembler.derive_text_summary",
            return_value="ok",
        ),
        patch(
            "apps.chat.conversation.services.conversation_time.resolve_message_arrival_seq",
            return_value=1,
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer._publish_message_committed",
        ),
        patch(
            "apps.services.common.ws.handlers.relay_message_writer.transaction.atomic",
            return_value=nullcontext(),
        ),
    ):
        _write_persist_messages(
            "22222222-2222-4222-8222-222222222222",
            None,
            events,
            result,
        )

    assert result.success is True
    assert "agent_run_id" not in stored["defaults"]

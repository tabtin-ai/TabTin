"""WS Event Buffer 字节边界与恢复正确性测试。"""

from __future__ import annotations

import json
import os
import sys
import time
from unittest.mock import MagicMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from redis.cluster import key_slot  # noqa: E402

from apps.services.common.ws.event_buffer import (  # noqa: E402
    _APPEND_BOUNDED_EVENT_LUA,
    BUFFER_DELTA_MAX_CHARS,
    BUFFER_EVENT_MAX_BYTES,
    BufferRetentionClass,
    EventBufferService,
    ReplayGapError,
    _prepare_buffer_event,
)


def _service(client: MagicMock) -> EventBufferService:
    service = EventBufferService()
    service._redis = client
    service._last_health_check = time.time()
    return service


def test_full_llm_request_is_local_only() -> None:
    plan = _prepare_buffer_event({
        "type": "agent.stream.llm_request",
        "payload": {"messages": [{"role": "user", "content": "x" * 1_000_000}]},
    })

    assert plan is None


def test_nested_child_llm_request_is_local_only() -> None:
    plan = _prepare_buffer_event({
        "type": "agent.stream.subagent_stream_event",
        "payload": {
            "subagent_run_id": "child-1",
            "child_event": {
                "type": "agent.stream.llm_request",
                "payload": {"messages": [{"content": "x" * 500_000}]},
            },
        },
    })

    assert plan is None


@pytest.mark.parametrize(
    "event_type",
    [
        "agent.stream.message_start",
        "agent.stream.message_delta",
        "agent.stream.message_stop",
        "agent.stream.content_block_start",
        "agent.stream.content_block_delta",
        "agent.stream.content_block_stop",
    ],
)
def test_six_piece_events_are_indexed_by_message(event_type: str) -> None:
    plan = _prepare_buffer_event({
        "type": event_type,
        "payload": {"message_id": "message-1", "index": 0},
    })

    assert plan is not None
    assert plan.retention is BufferRetentionClass.MESSAGE_RECONSTRUCTABLE
    assert plan.message_id == "message-1"


def test_child_six_piece_with_subagent_run_id_is_reconstructable() -> None:
    plan = _prepare_buffer_event({
        "type": "agent.stream.content_block_delta",
        "payload": {
            "message_id": "child-message-1",
            "index": 0,
            "subagent_run_id": "child-1",
            "delta": {"type": "text_delta", "text": "token"},
        },
    })

    assert plan is not None
    assert plan.retention is BufferRetentionClass.MESSAGE_RECONSTRUCTABLE
    assert plan.message_id == "child-message-1"


def test_unknown_event_defaults_to_critical() -> None:
    plan = _prepare_buffer_event({
        "type": "agent.stream.future_business_event",
        "payload": {"value": 1},
    })

    assert plan is not None
    assert plan.retention is BufferRetentionClass.CRITICAL_REPLAY


def test_oversize_event_records_gap_without_xadd() -> None:
    client = MagicMock()
    service = _service(client)
    envelope = {
        "type": "agent.stream.future_business_event",
        "payload": {"message_id": "message-1", "value": "x" * BUFFER_EVENT_MAX_BYTES},
    }

    assert service.append_event("agent.stream.thread-1", envelope) is None

    client.xadd.assert_not_called()
    client.eval.assert_not_called()
    client.hset.assert_called_once()
    gap_detail = json.loads(client.hset.call_args.kwargs["value"])
    assert gap_detail["reason"] == "event_too_large"
    assert gap_detail["message_id"] == "message-1"


def test_oversize_delta_is_not_split_with_reused_sequence() -> None:
    client = MagicMock()
    service = _service(client)

    assert service.append_event("agent.stream.thread-1", {
        "type": "agent.stream.content_block_delta",
        "payload": {
            "message_id": "message-1",
            "index": 0,
            "_seq": 7,
            "delta": {"type": "text_delta", "text": "x" * (BUFFER_DELTA_MAX_CHARS + 1)},
        },
    }) is None

    client.eval.assert_not_called()
    detail = json.loads(client.hset.call_args.kwargs["value"])
    assert detail["reason"] == "delta_body_too_large"


def test_unresolved_gap_fails_replay_closed() -> None:
    client = MagicMock()
    client.hlen.return_value = 1
    service = _service(client)

    with pytest.raises(ReplayGapError, match="agent.stream.thread-1"):
        service.read_after("agent.stream.thread-1", "0-0")

    client.xrange.assert_not_called()


def test_budget_rejection_records_gap() -> None:
    client = MagicMock()
    client.eval.return_value = [b"gap", b"200-0"]
    service = _service(client)

    result = service.append_event(
        "agent.stream.thread-1",
        {
            "type": "agent.stream.content_block_delta",
            "payload": {
                "message_id": "message-1",
                "index": 0,
                "delta": {"type": "text_delta", "text": "hello"},
            },
        },
    )

    assert result is None
    # budget gap 在 Lua 内与拒写同一原子操作完成，不能留出 resume 竞态窗口。
    client.hset.assert_not_called()
    args = client.eval.call_args.args
    argv_start = 2 + args[1]
    serialized = args[argv_start]
    assert args[-3:] == (
        "message-1",
        "agent.stream.content_block_delta",
        len(serialized.encode("utf-8")),
    )


def test_message_commit_uses_atomic_checkpoint_mode() -> None:
    client = MagicMock()
    client.eval.return_value = [b"ok", b"300-0"]
    service = _service(client)

    result = service.append_event(
        "agent.stream.thread-1",
        {
            "type": "agent.stream.message_committed",
            "payload": {"message_id": "message-1", "server_id": "server-1"},
        },
    )

    assert result == "300-0"
    args = client.eval.call_args.args
    assert args[-6:-3] == ("message_commit", "message-1", "")


def test_atomic_append_keys_share_one_redis_cluster_slot() -> None:
    client = MagicMock()
    client.eval.return_value = [b"ok", b"300-0"]
    service = _service(client)

    service.append_event(
        "agent.stream.thread-1",
        {
            "type": "agent.stream.content_block_delta",
            "payload": {
                "message_id": "message-1",
                "index": 0,
                "delta": {"type": "text_delta", "text": "hello"},
            },
        },
    )

    eval_keys = client.eval.call_args.args[2:7]
    assert len({key_slot(key.encode("utf-8")) for key in eval_keys}) == 1


def test_successful_append_does_not_extend_unresolved_topic_gap() -> None:
    success_suffix = _APPEND_BOUNDED_EVENT_LUA.split("redis.call('SET', ledger_key, tostring(projected), 'EX', ttl)")[-1]

    assert "redis.call('EXPIRE', gap_key, ttl)" not in success_suffix


def test_message_commit_does_not_extend_unresolved_sibling_gap() -> None:
    commit_block = _APPEND_BOUNDED_EVENT_LUA.split("if mode == 'message_commit' and message_id ~= '' then", 1)[1]
    commit_block = commit_block.split("local projected =", 1)[0]

    assert "clear_message_gaps()" in commit_block
    assert "redis.call('EXPIRE', gap_key, ttl)" not in commit_block


def test_commit_and_latest_snapshot_clear_resolved_gap_identity() -> None:
    assert "redis.call('HDEL', gap_key, message_id)" in _APPEND_BOUNDED_EVENT_LUA
    assert "redis.call('HDEL', gap_key, latest_key)" in _APPEND_BOUNDED_EVENT_LUA

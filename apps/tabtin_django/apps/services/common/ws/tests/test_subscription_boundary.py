import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from apps.services.common.ws.handlers.subscription import create_subscribe_handler


def _envelope(*topics: str) -> dict:
    return {
        "request_id": "req-subscribe-boundary",
        "payload": {"topics": list(topics)},
    }


def _consumer(capability: str) -> SimpleNamespace:
    return SimpleNamespace(
        subscriptions=set(),
        subscription_boundaries={},
        role="electron",
        capabilities={capability},
        user_id="user-boundary",
        _pending_open_table_ctx=None,
        _pending_topic_contexts=None,
        _join_group=AsyncMock(),
        _send_error=AsyncMock(),
        _send_envelope=AsyncMock(),
        _refresh_runtime_snapshot=AsyncMock(),
    )


def test_subscribe_captures_boundary_before_join_and_returns_it():
    order: list[str] = []
    event_buffer = MagicMock()
    event_buffer.capture_subscription_boundaries.side_effect = lambda topics: (
        order.append("capture") or {topics[0]: "100-0"}
    )
    consumer = _consumer("agent.stream")
    consumer._join_group.side_effect = lambda _group: order.append("join")

    with (
        patch(
            "apps.services.common.ws.handlers.subscription.resolve_required_capability",
            return_value="agent.stream",
        ),
        patch("apps.services.common.ws.handlers.subscription.resolve_validator", return_value=None),
        patch(
            "apps.services.common.ws.handlers.subscription.get_event_buffer",
            return_value=event_buffer,
            create=True,
        ),
    ):
        asyncio.run(create_subscribe_handler(consumer)(_envelope("agent.stream.session-a")))

    assert order == ["capture", "join"]
    response = consumer._send_envelope.await_args.args[0]
    assert response["type"] == "subscribe.ok"
    assert response["payload"] == {
        "topics": ["agent.stream.session-a"],
        "boundary_cursors": {"agent.stream.session-a": "100-0"},
    }


def test_duplicate_subscribe_reuses_original_boundary():
    event_buffer = MagicMock()
    event_buffer.capture_subscription_boundaries.return_value = {
        "agent.stream.session-a": "100-0",
    }
    consumer = _consumer("agent.stream")

    with (
        patch(
            "apps.services.common.ws.handlers.subscription.resolve_required_capability",
            return_value="agent.stream",
        ),
        patch("apps.services.common.ws.handlers.subscription.resolve_validator", return_value=None),
        patch(
            "apps.services.common.ws.handlers.subscription.get_event_buffer",
            return_value=event_buffer,
            create=True,
        ),
    ):
        handler = create_subscribe_handler(consumer)
        asyncio.run(handler(_envelope("agent.stream.session-a")))
        asyncio.run(handler(_envelope("agent.stream.session-a")))

    event_buffer.capture_subscription_boundaries.assert_called_once_with(
        ["agent.stream.session-a"]
    )
    assert consumer._join_group.await_count == 1
    responses = [call.args[0] for call in consumer._send_envelope.await_args_list]
    assert [response["payload"]["boundary_cursors"] for response in responses] == [
        {"agent.stream.session-a": "100-0"},
        {"agent.stream.session-a": "100-0"},
    ]


def test_boundary_capture_failure_does_not_join_or_ack_subscription():
    event_buffer = MagicMock()
    event_buffer.capture_subscription_boundaries.return_value = {}
    consumer = _consumer("agent.stream")

    with (
        patch(
            "apps.services.common.ws.handlers.subscription.resolve_required_capability",
            return_value="agent.stream",
        ),
        patch("apps.services.common.ws.handlers.subscription.resolve_validator", return_value=None),
        patch(
            "apps.services.common.ws.handlers.subscription.get_event_buffer",
            return_value=event_buffer,
            create=True,
        ),
    ):
        asyncio.run(create_subscribe_handler(consumer)(_envelope("agent.stream.session-a")))

    consumer._join_group.assert_not_awaited()
    consumer._send_envelope.assert_not_awaited()
    consumer._send_error.assert_awaited_once()

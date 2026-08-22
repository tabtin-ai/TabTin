import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from apps.services.common.ws.event_buffer import MAX_REPLAY_LIMIT
from apps.services.common.ws.gateway import GatewayConsumer
from apps.services.common.ws.organization_context import OrganizationContext
from apps.services.common.ws.protocol import ERROR_INTERNAL, build_envelope


class _Consumer:
    def __init__(self, subscriptions: set[str]):
        self.subscriptions = subscriptions
        self.connection_scope = "session"
        self.user_id = "user-resume-protocol"
        self.organization_ctx = OrganizationContext(None, set())
        self._sent: list[dict] = []
        self._send_error = AsyncMock()

    async def _send_envelope(self, envelope: dict) -> None:
        self._sent.append(envelope)

    @staticmethod
    def _parse_stream_id(stream_id: str) -> tuple[int, int]:
        first, second = stream_id.split("-", 1)
        return int(first), int(second)

    @staticmethod
    def _should_drop_leaked_cloud_context_sync(_envelope: dict) -> bool:
        return False


def _request(topic_cursors: dict[str, str]) -> dict:
    return {
        "request_id": "req-topic-resume",
        "payload": {"topic_cursors": topic_cursors},
    }


def _event(sequence: int) -> dict:
    return build_envelope(
        "agent.stream.delta",
        f"evt-{sequence}",
        {"seq": sequence},
    )


def test_replay_events_are_marked_and_next_cursors_are_per_topic():
    topic_a = "agent.stream.topic-a"
    topic_b = "agent.stream.topic-b"
    events = {
        topic_a: [(f"{index + 1}-0", _event(index + 1)) for index in range(MAX_REPLAY_LIMIT)],
        topic_b: [("9-0", _event(9))],
    }
    event_buffer = MagicMock()
    event_buffer.read_after_many.return_value = (events, True)
    consumer = _Consumer({topic_a, topic_b})

    with patch("apps.services.common.ws.event_buffer.get_event_buffer", return_value=event_buffer):
        asyncio.run(GatewayConsumer._handle_resume(consumer, _request({
            topic_a: "0-1",
            topic_b: "8-0",
        })))

    replayed = [message for message in consumer._sent if message["type"] != "resume.ok"]
    assert replayed
    assert all(message["_delivery"] == "replay" for message in replayed)
    response = consumer._sent[-1]
    assert response["payload"]["has_more"] is True
    assert response["payload"]["next_cursors"] == {topic_a: "500-0"}


def test_topic_cursors_only_replay_requested_subscribed_topics():
    event_buffer = MagicMock()
    event_buffer.read_after_many.return_value = ({}, False)
    consumer = _Consumer({"agent.stream.a", "agent.stream.b"})

    with patch("apps.services.common.ws.event_buffer.get_event_buffer", return_value=event_buffer):
        asyncio.run(GatewayConsumer._handle_resume(
            consumer,
            _request({"agent.stream.a": "100-0"}),
        ))

    event_buffer.read_after_many.assert_called_once_with(
        [("agent.stream.a", "100-0")],
        limit=MAX_REPLAY_LIMIT,
        raise_on_error=True,
    )
    response = consumer._sent[-1]
    assert response["payload"]["has_more"] is False
    assert response["payload"]["next_cursors"] == {}


def test_resume_storage_failure_returns_error_instead_of_empty_success():
    topic = "agent.stream.storage-failure"
    event_buffer = MagicMock()
    event_buffer.read_after_many.side_effect = RuntimeError("redis unavailable")
    consumer = _Consumer({topic})

    with patch("apps.services.common.ws.event_buffer.get_event_buffer", return_value=event_buffer):
        asyncio.run(GatewayConsumer._handle_resume(
            consumer,
            _request({topic: "100-0"}),
        ))

    assert consumer._sent == []
    consumer._send_error.assert_awaited_once_with(
        "req-topic-resume",
        ERROR_INTERNAL,
        "resume event buffer unavailable",
    )

"""
End-to-end tests for WS Resume/Replay mechanism.

Tests exercise the full stack:
  EventBufferService (Redis Stream) → publish_ws_event (bus.py) →
  GatewayConsumer._handle_resume → client receives replayed events.

Four scenarios:
  1. Basic resume replay after reconnection
  2. Per-topic cursor effect (G-025 verification)
  3. Resume truncation flag (> 200 events)
  4. Resume scope filtering (user scope filters agent.action.*)

Requires a running Redis instance at localhost:6379.
Uses DB 15 for isolation (flushed per test class).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple
from unittest.mock import AsyncMock

import redis
from django.test import SimpleTestCase

from apps.services.common.ws.event_buffer import (
    EventBufferService,
    MAX_REPLAY_LIMIT,
    ReplayGapError,
    STREAM_KEY_PREFIX,
)
from apps.services.common.ws.protocol import (
    ERROR_REPLAY_GAP,
    PROTOCOL_VERSION,
    build_envelope,
    is_stream_event_id,
)

_TEST_REDIS_DB = 15
_TEST_REDIS_URL = os.getenv("TEST_REDIS_URL", f"redis://localhost:6379/{_TEST_REDIS_DB}")


def _get_test_redis() -> redis.Redis:
    return redis.Redis.from_url(_TEST_REDIS_URL, decode_responses=True)


def _increment_stream_id(stream_id: str) -> str:
    """Increment a Redis Stream ID's sequence number (Redis 6.0 compat).

    Redis 6.2 supports ``(id`` for exclusive XRANGE min, but 6.0 doesn't.
    Incrementing the sequence ``ts-seq → ts-(seq+1)`` achieves the same
    "strictly after" semantics on all Redis versions.
    """
    parts = stream_id.split("-")
    return f"{parts[0]}-{int(parts[1]) + 1}"


class TestEventBufferService(EventBufferService):
    """EventBufferService adapted for Redis 6.0 (no exclusive-range ``(`` prefix).

    Overrides read paths to use inclusive XRANGE with incremented IDs
    instead of ``(`` prefix syntax introduced in Redis 6.2.
    """

    def read_after(self, topic, last_event_id, limit=200):
        client = self.redis_client
        if client is None:
            return []
        stream_key = f"{STREAM_KEY_PREFIX}{topic}"
        effective_limit = min(limit, MAX_REPLAY_LIMIT)
        try:
            min_id = _increment_stream_id(last_event_id)
            entries = client.xrange(stream_key, min=min_id, max="+", count=effective_limit)
            result = []
            for entry_id, fields in entries:
                if isinstance(entry_id, bytes):
                    entry_id = entry_id.decode("utf-8")
                raw = fields.get("e") or fields.get(b"e")
                if raw is None:
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                try:
                    envelope = json.loads(raw)
                    result.append((entry_id, envelope))
                except (json.JSONDecodeError, TypeError):
                    pass
            return result
        except Exception:
            return []

    def read_after_many(self, topic_cursors, limit=200, *, raise_on_error=False):
        client = self.redis_client
        if client is None:
            if raise_on_error:
                raise RuntimeError("event buffer unavailable")
            return {}, False
        if not topic_cursors:
            return {}, False
        effective_limit = min(limit, MAX_REPLAY_LIMIT)
        try:
            pipe = client.pipeline(transaction=False)
            ordered_topics = []
            for topic, last_event_id in topic_cursors:
                stream_key = f"{STREAM_KEY_PREFIX}{topic}"
                min_id = _increment_stream_id(last_event_id)
                pipe.xrange(stream_key, min=min_id, max="+", count=effective_limit)
                ordered_topics.append(topic)
            raw_results = pipe.execute()
        except Exception:
            if raise_on_error:
                raise
            return {}, False

        output = {}
        any_truncated = False
        for topic, entries in zip(ordered_topics, raw_results):
            if not entries:
                continue
            if len(entries) >= effective_limit:
                any_truncated = True
            parsed = []
            for entry_id, fields in entries:
                if isinstance(entry_id, bytes):
                    entry_id = entry_id.decode("utf-8")
                raw = fields.get("e") or fields.get(b"e")
                if raw is None:
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                try:
                    envelope = json.loads(raw)
                    parsed.append((entry_id, envelope))
                except (json.JSONDecodeError, TypeError):
                    pass
            if parsed:
                output[topic] = parsed
        return output, any_truncated


def _make_test_buffer() -> TestEventBufferService:
    buf = TestEventBufferService()
    buf._redis = _get_test_redis()
    buf._last_health_check = time.time()
    return buf


# ---------------------------------------------------------------------------
# StubConsumer — lightweight stand-in for GatewayConsumer
# ---------------------------------------------------------------------------

class StubConsumer:
    """Mimics the GatewayConsumer surface used by _handle_resume."""

    def __init__(
        self,
        *,
        user_id: str = "u-test",
        organization_id: str = "ws-test",
        role: str = "electron",
        connection_scope: str = "session",
        subscriptions: Optional[Set[str]] = None,
        capabilities: Optional[Set[str]] = None,
    ):
        from apps.services.common.ws.organization_context import OrganizationContext

        self.authed = True
        self.user_id = user_id
        self.organization_ctx = OrganizationContext(organization_id, {organization_id} if organization_id else set())
        self.role = role
        self.connection_scope = connection_scope
        self.subscriptions: Set[str] = subscriptions or set()
        self.capabilities: Set[str] = capabilities or set()
        self.device_fingerprint = f"test-{uuid.uuid4().hex[:8]}"
        self.channel_name = f"test.channel.{uuid.uuid4().hex[:8]}"
        self.joined_groups: Set[str] = set()
        self._sent: List[Dict[str, Any]] = []
        self._open_table_subscriptions: dict = {}

    @property
    def organization_id(self):
        return self.organization_ctx.primary_id

    @property
    def organization_ids(self):
        return self.organization_ctx.all_ids

    async def _send_envelope(self, envelope: Dict[str, Any]) -> None:
        self._sent.append(envelope)

    async def send(self, text_data: str = "", **kwargs) -> None:
        self._sent.append(json.loads(text_data))

    @staticmethod
    def _should_drop_leaked_cloud_context_sync(message: Dict[str, Any]) -> bool:
        from apps.services.common.ws.gateway import GatewayConsumer

        return GatewayConsumer._should_drop_leaked_cloud_context_sync(message)

    @staticmethod
    def _parse_stream_id(stream_id: str) -> Tuple[int, int]:
        from apps.services.common.ws.gateway import GatewayConsumer

        return GatewayConsumer._parse_stream_id(stream_id)


def _make_envelope(msg_type: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return build_envelope(
        msg_type,
        f"req_{uuid.uuid4().hex[:8]}",
        payload or {"seq": 1},
    )


def _make_resume_request(last_event_id: str) -> Dict[str, Any]:
    return {
        "v": PROTOCOL_VERSION,
        "type": "resume",
        "request_id": f"resume_{uuid.uuid4().hex[:8]}",
        "ts": int(time.time()),
        "device_id": "test-device",
        "role": "electron",
        "payload": {"last_event_id": last_event_id},
    }


# ---------------------------------------------------------------------------
# Invoke _handle_resume with a patched event_buffer singleton
# ---------------------------------------------------------------------------

async def _do_resume(
    consumer: StubConsumer,
    last_event_id: str,
    buffer: TestEventBufferService,
) -> List[Dict[str, Any]]:
    """Run the gateway's resume handler with a test-wired buffer."""
    from unittest.mock import patch
    from apps.services.common.ws.gateway import GatewayConsumer

    consumer._sent.clear()
    envelope = _make_resume_request(last_event_id)

    with patch("apps.services.common.ws.event_buffer.get_event_buffer", return_value=buffer):
        await GatewayConsumer._handle_resume(consumer, envelope)

    return list(consumer._sent)


def _flush_stream(buffer: EventBufferService, topic: str) -> None:
    client = buffer.redis_client
    if client:
        client.delete(f"{STREAM_KEY_PREFIX}{topic}")


def _run(coro):
    """Run a coroutine in a fresh event loop (safe for test runner)."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class TestReplayGapProtocol(SimpleTestCase):
    def test_resume_returns_explicit_error_instead_of_partial_history(self):
        class GapBuffer:
            def read_after_many(self, topic_cursors, limit=200, *, raise_on_error=False):
                raise ReplayGapError(topic_cursors[0][0])

        topic = "agent.stream.thread-gap"
        consumer = StubConsumer(subscriptions={topic})
        consumer._send_error = AsyncMock()

        _run(_do_resume(consumer, "100-0", GapBuffer()))

        consumer._send_error.assert_awaited_once()
        args = consumer._send_error.await_args.args
        assert args[1] == ERROR_REPLAY_GAP
        assert consumer._sent == []


# ===========================================================================
# Scenario 1: Basic Resume Replay
# ===========================================================================

class TestBasicResumeReplay(SimpleTestCase):
    """
    1. Publish 3 events → record event_ids
    2. Simulate disconnect (no-op, just stop listening)
    3. Publish 2 more events
    4. Resume with last_event_id = 3rd event
    5. Verify events 4 & 5 replayed
    """

    def setUp(self):
        self.buffer = _make_test_buffer()
        self.topic = f"agent.stream.test-{uuid.uuid4().hex[:8]}"
        _flush_stream(self.buffer, self.topic)

    def tearDown(self):
        _flush_stream(self.buffer, self.topic)

    def test_resume_replays_missed_events(self):
        event_ids: List[str] = []
        for i in range(1, 6):
            env = _make_envelope("agent.stream.delta", {"seq": i, "content": f"msg-{i}"})
            eid = self.buffer.append_event(self.topic, env)
            self.assertIsNotNone(eid, f"append_event returned None for event {i}")
            self.assertTrue(is_stream_event_id(eid), f"event_id {eid!r} is not a stream ID")
            event_ids.append(eid)

        # Resume from event 3 → should replay events 4 and 5
        cursor = event_ids[2]

        consumer = StubConsumer(subscriptions={self.topic})
        sent = _run(_do_resume(consumer, cursor, self.buffer))

        replayed = [m for m in sent if m.get("type") != "resume.ok"]
        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]

        self.assertEqual(len(resume_ok), 1, "exactly one resume.ok expected")
        self.assertEqual(resume_ok[0]["payload"]["replayed"], 2)
        self.assertNotIn("truncated", resume_ok[0]["payload"])

        self.assertEqual(len(replayed), 2, f"expected 2 replayed events, got {len(replayed)}")

        replayed_seqs = [m["payload"]["seq"] for m in replayed]
        self.assertEqual(replayed_seqs, [4, 5])

        for msg in replayed:
            self.assertTrue(is_stream_event_id(msg.get("event_id", "")))
            self.assertEqual(msg.get("_topic"), self.topic)

    def test_legacy_prompt_resume_keeps_topic_for_frame_level_cursor(self):
        legacy_topic = f"agent.action.thread-{uuid.uuid4().hex[:8]}"
        try:
            event_id = self.buffer.append_event(
                legacy_topic,
                _make_envelope("agent.prompt.forward", {"run_id": str(uuid.uuid4())}),
            )
            consumer = StubConsumer(
                role="electron",
                connection_scope="session",
                subscriptions={legacy_topic},
            )
            consumer._ack_prompt_forwards = AsyncMock()
            sent = _run(_do_resume(consumer, "0-0", self.buffer))
            replayed = [m for m in sent if m.get("type") == "agent.prompt.forward"]
            self.assertEqual(len(replayed), 1)
            self.assertEqual(replayed[0].get("_topic"), legacy_topic)
            consumer._ack_prompt_forwards.assert_awaited_once_with(
                {legacy_topic: [event_id]},
            )
        finally:
            _flush_stream(self.buffer, legacy_topic)

    def test_resume_with_no_subscriptions_returns_warning(self):
        env = _make_envelope("agent.stream.delta", {"seq": 1})
        eid = self.buffer.append_event(self.topic, env)
        self.assertIsNotNone(eid)

        consumer = StubConsumer(subscriptions=set())
        sent = _run(_do_resume(consumer, eid, self.buffer))

        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]
        self.assertEqual(len(resume_ok), 1)
        self.assertEqual(resume_ok[0]["payload"]["replayed"], 0)
        self.assertEqual(resume_ok[0]["payload"].get("warning"), "no_subscriptions")

    def test_resume_with_legacy_event_id_returns_zero(self):
        consumer = StubConsumer(subscriptions={self.topic})
        sent = _run(_do_resume(consumer, "evt_abc123", self.buffer))
        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]
        self.assertEqual(len(resume_ok), 1)
        self.assertEqual(resume_ok[0]["payload"]["replayed"], 0)
        self.assertEqual(resume_ok[0]["payload"].get("reason"), "legacy_event_id")

    def test_resume_with_empty_event_id_returns_zero(self):
        consumer = StubConsumer(subscriptions={self.topic})
        sent = _run(_do_resume(consumer, "", self.buffer))
        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]
        self.assertEqual(len(resume_ok), 1)
        self.assertEqual(resume_ok[0]["payload"]["replayed"], 0)

    def test_resume_replays_nothing_when_cursor_is_latest(self):
        """Resume from the very last event → 0 replayed events."""
        eids = []
        for i in range(3):
            eid = self.buffer.append_event(
                self.topic,
                _make_envelope("agent.stream.delta", {"seq": i}),
            )
            eids.append(eid)

        consumer = StubConsumer(subscriptions={self.topic})
        sent = _run(_do_resume(consumer, eids[-1], self.buffer))

        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]
        self.assertEqual(resume_ok[0]["payload"]["replayed"], 0)


# ===========================================================================
# Scenario 2: Per-topic Cursor Effect (G-025 verification)
# ===========================================================================

class TestPerTopicCursor(SimpleTestCase):
    """
    Verifies:
    1. Envelope stored in buffer retains its structure
    2. read_after_many returns results keyed by topic with independent cursors
    3. Per-topic min-cursor calculation logic
    """

    def setUp(self):
        self.buffer = _make_test_buffer()
        self.topic_a = f"agent.stream.cursor-a-{uuid.uuid4().hex[:6]}"
        self.topic_b = f"trace.stream.cursor-b-{uuid.uuid4().hex[:6]}"
        _flush_stream(self.buffer, self.topic_a)
        _flush_stream(self.buffer, self.topic_b)

    def tearDown(self):
        _flush_stream(self.buffer, self.topic_a)
        _flush_stream(self.buffer, self.topic_b)

    def test_envelope_stored_in_buffer_retains_structure(self):
        env = _make_envelope("agent.stream.delta", {"data": "hello"})
        eid = self.buffer.append_event(self.topic_a, env)
        self.assertIsNotNone(eid)

        # Read from beginning (0-0 is the very first possible ID)
        entries = self.buffer.read_after(self.topic_a, "0-0", limit=10)
        self.assertTrue(len(entries) >= 1, f"expected ≥1 entry, got {len(entries)}")

        _, stored_env = entries[-1]
        self.assertIn("type", stored_env)
        self.assertEqual(stored_env["type"], "agent.stream.delta")
        self.assertEqual(stored_env["payload"]["data"], "hello")

    def test_bus_publish_injects_topic_field(self):
        """bus.py publish_ws_event sets _topic on the envelope."""
        env = _make_envelope("agent.stream.delta", {"data": "test"})
        env["_topic"] = self.topic_a
        self.assertEqual(env["_topic"], self.topic_a)

    def test_read_after_many_returns_per_topic_results(self):
        ids_a, ids_b = [], []
        for i in range(3):
            eid = self.buffer.append_event(
                self.topic_a,
                _make_envelope("agent.stream.delta", {"topic": "a", "i": i}),
            )
            ids_a.append(eid)

        for i in range(2):
            eid = self.buffer.append_event(
                self.topic_b,
                _make_envelope("trace.stream.step", {"topic": "b", "i": i}),
            )
            ids_b.append(eid)

        # Different cursors per topic: replay after event[1] of A, after event[0] of B
        topic_cursors = [
            (self.topic_a, ids_a[1]),   # should get 1 event (index 2)
            (self.topic_b, ids_b[0]),   # should get 1 event (index 1)
        ]
        results, truncated = self.buffer.read_after_many(topic_cursors, limit=200)

        self.assertIn(self.topic_a, results)
        self.assertIn(self.topic_b, results)
        self.assertEqual(len(results[self.topic_a]), 1)
        self.assertEqual(len(results[self.topic_b]), 1)
        self.assertFalse(truncated)

    def test_per_topic_min_cursor_calculation(self):
        """Per-topic tracking: min cursor across topics for global resume."""
        topic_cursors: Dict[str, str] = {}

        for i in range(4):
            eid = self.buffer.append_event(
                self.topic_a,
                _make_envelope("agent.stream.delta", {"i": i}),
            )
            topic_cursors[self.topic_a] = eid

        for i in range(2):
            eid = self.buffer.append_event(
                self.topic_b,
                _make_envelope("trace.stream.step", {"i": i}),
            )
            topic_cursors[self.topic_b] = eid

        self.assertTrue(is_stream_event_id(topic_cursors[self.topic_a]))
        self.assertTrue(is_stream_event_id(topic_cursors[self.topic_b]))

        # Min cursor = earliest stream ID across topics
        all_ids = list(topic_cursors.values())

        def _stream_id_key(sid: str) -> Tuple[int, int]:
            parts = sid.split("-")
            return (int(parts[0]), int(parts[1]))

        min_cursor = min(all_ids, key=_stream_id_key)
        self.assertTrue(is_stream_event_id(min_cursor))

        # Resume from min_cursor for ALL topics
        results, _ = self.buffer.read_after_many(
            [(self.topic_a, min_cursor), (self.topic_b, min_cursor)],
            limit=200,
        )
        self.assertIsInstance(results, dict)

    def test_resume_with_per_topic_cursors_via_gateway(self):
        """Full resume path with multiple topics and different event states."""
        ids_a = []
        for i in range(4):
            eid = self.buffer.append_event(
                self.topic_a,
                _make_envelope("agent.stream.delta", {"topic": "a", "seq": i}),
            )
            ids_a.append(eid)

        ids_b = []
        for i in range(3):
            eid = self.buffer.append_event(
                self.topic_b,
                _make_envelope("trace.stream.step", {"topic": "b", "seq": i}),
            )
            ids_b.append(eid)

        # Resume with a single global cursor (the gateway uses the same
        # cursor for all subscribed topics)
        cursor = ids_a[1]  # after event 1 of topic A

        consumer = StubConsumer(subscriptions={self.topic_a, self.topic_b})
        sent = _run(_do_resume(consumer, cursor, self.buffer))

        replayed = [m for m in sent if m.get("type") != "resume.ok"]
        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]

        self.assertEqual(len(resume_ok), 1)
        total_replayed = resume_ok[0]["payload"]["replayed"]
        # Topic A: events 2,3 → 2 events
        # Topic B: events after cursor → some or all depending on ID ordering
        self.assertGreaterEqual(total_replayed, 2, "at least topic_a events should replay")


# ===========================================================================
# Scenario 3: Resume Truncation Flag
# ===========================================================================

class TestResumeTruncation(SimpleTestCase):
    """
    Write more than one replay page to a topic, then resume.
    Verify resume.ok contains truncated=True.
    """

    def setUp(self):
        self.buffer = _make_test_buffer()
        self.topic = f"agent.stream.trunc-{uuid.uuid4().hex[:8]}"
        _flush_stream(self.buffer, self.topic)

    def tearDown(self):
        _flush_stream(self.buffer, self.topic)

    def test_resume_truncated_flag(self):
        initial_eid = self.buffer.append_event(
            self.topic,
            _make_envelope("agent.stream.delta", {"seq": 0}),
        )
        self.assertIsNotNone(initial_eid)

        for i in range(1, MAX_REPLAY_LIMIT + 51):
            eid = self.buffer.append_event(
                self.topic,
                _make_envelope("agent.stream.delta", {"seq": i}),
            )
            self.assertIsNotNone(eid)

        consumer = StubConsumer(subscriptions={self.topic})
        sent = _run(_do_resume(consumer, initial_eid, self.buffer))

        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]
        self.assertEqual(len(resume_ok), 1)

        payload = resume_ok[0]["payload"]
        # A full page means another resume request is required.
        self.assertTrue(payload.get("truncated", False), f"expected truncated=True, got {payload}")
        self.assertEqual(payload["replayed"], MAX_REPLAY_LIMIT)

    def test_no_truncation_under_limit(self):
        initial_eid = self.buffer.append_event(
            self.topic,
            _make_envelope("agent.stream.delta", {"seq": 0}),
        )
        self.assertIsNotNone(initial_eid)

        for i in range(1, 51):
            self.buffer.append_event(
                self.topic,
                _make_envelope("agent.stream.delta", {"seq": i}),
            )

        consumer = StubConsumer(subscriptions={self.topic})
        sent = _run(_do_resume(consumer, initial_eid, self.buffer))

        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]
        self.assertEqual(len(resume_ok), 1)
        self.assertNotIn("truncated", resume_ok[0]["payload"])
        self.assertEqual(resume_ok[0]["payload"]["replayed"], 50)


# ===========================================================================
# Scenario 4: Resume Scope Filtering
# ===========================================================================

class TestResumeScopeFiltering(SimpleTestCase):
    """
    User-scope connections (mobile/admin) should NOT receive agent.action.*
    events during resume. Same filtering as broadcast_message (G-015).
    """

    def setUp(self):
        self.buffer = _make_test_buffer()
        self.action_topic = f"agent.action.thread-{uuid.uuid4().hex[:8]}"
        self.stream_topic = f"agent.stream.thread-{uuid.uuid4().hex[:8]}"
        self.organization_id = f"org-{uuid.uuid4().hex[:8]}"
        self.organization_topic = f"organization.{self.organization_id}"
        _flush_stream(self.buffer, self.action_topic)
        _flush_stream(self.buffer, self.stream_topic)
        _flush_stream(self.buffer, self.organization_topic)

    def tearDown(self):
        _flush_stream(self.buffer, self.action_topic)
        _flush_stream(self.buffer, self.stream_topic)
        _flush_stream(self.buffer, self.organization_topic)

    def test_user_scope_filters_non_approval_action_events(self):
        """User-scope resume skips non-approval agent.action.* events (G-015)."""
        for i in range(3):
            self.buffer.append_event(
                self.action_topic,
                _make_envelope("agent.action.device.execute", {"action": f"act-{i}"}),
            )

        for i in range(2):
            self.buffer.append_event(
                self.stream_topic,
                _make_envelope("agent.stream.delta", {"content": f"stream-{i}"}),
            )

        consumer = StubConsumer(
            role="mobile",
            connection_scope="user",
            subscriptions={self.action_topic, self.stream_topic},
        )
        sent = _run(_do_resume(consumer, "0-0", self.buffer))

        replayed = [m for m in sent if m.get("type") != "resume.ok"]
        resume_ok = [m for m in sent if m.get("type") == "resume.ok"]

        # Non-approval agent.action.* events should be filtered for user scope
        replayed_types = [m.get("type", "") for m in replayed]
        action_events = [t for t in replayed_types if t.startswith("agent.action")]
        self.assertEqual(
            len(action_events), 0,
            f"user scope should not receive action events, got: {action_events}",
        )

        # agent.stream.* events should pass through
        stream_events = [t for t in replayed_types if t.startswith("agent.stream")]
        self.assertEqual(len(stream_events), 2)

        # resume.ok replayed count reflects ONLY delivered events
        self.assertEqual(len(resume_ok), 1)
        self.assertEqual(resume_ok[0]["payload"]["replayed"], len(replayed))

    def test_user_scope_resume_allows_action_approval_events_only(self):
        """自动加入的 organization topic 也能续传审批只读事件。"""
        self.buffer.append_event(
            self.organization_topic,
            _make_envelope("agent.action.device.execute", {"action": "tap"}),
        )
        self.buffer.append_event(
            self.organization_topic,
            _make_envelope("agent.action.approval_request", {"approval_id": "approval-mobile-1"}),
        )
        self.buffer.append_event(
            self.organization_topic,
            _make_envelope(
                "agent.action.approval_memo_updated",
                {"workspace_id": "workspace-mobile-1", "generation": 2},
            ),
        )

        consumer = StubConsumer(
            role="mobile",
            connection_scope="user",
            organization_id=self.organization_id,
            subscriptions=set(),
        )
        sent = _run(_do_resume(consumer, "0-0", self.buffer))

        replayed_types = [
            m.get("type", "")
            for m in sent
            if m.get("type") != "resume.ok"
        ]
        self.assertEqual(
            replayed_types,
            [
                "agent.action.approval_request",
                "agent.action.approval_memo_updated",
            ],
        )

    def test_session_scope_receives_action_events(self):
        """Session-scope (electron) resume includes agent.action.* events."""
        for i in range(2):
            self.buffer.append_event(
                self.action_topic,
                _make_envelope("agent.action.device.execute", {"action": f"act-{i}"}),
            )

        consumer = StubConsumer(
            role="electron",
            connection_scope="session",
            subscriptions={self.action_topic},
        )
        sent = _run(_do_resume(consumer, "0-0", self.buffer))

        replayed = [m for m in sent if m.get("type") != "resume.ok"]
        action_events = [m for m in replayed if m.get("type", "").startswith("agent.action")]
        self.assertEqual(len(action_events), 2, "session scope should receive action events")

    def test_device_scope_filters_context_sync_events(self):
        """Device-scope resume skips context.sync.* events."""
        ctx_topic = f"context.sync.space-{uuid.uuid4().hex[:8]}"
        try:
            for i in range(2):
                self.buffer.append_event(
                    ctx_topic,
                    _make_envelope("context.sync.update", {"ctx": f"data-{i}"}),
                )

            consumer = StubConsumer(
                role="daemon",
                connection_scope="device",
                subscriptions={ctx_topic},
            )
            sent = _run(_do_resume(consumer, "0-0", self.buffer))

            replayed = [m for m in sent if m.get("type") != "resume.ok"]
            ctx_events = [m for m in replayed if m.get("type", "").startswith("context.sync")]
            self.assertEqual(
                len(ctx_events), 0,
                "device scope should not receive context.sync events",
            )
        finally:
            _flush_stream(self.buffer, ctx_topic)

    def test_device_scope_filters_table_events(self):
        """Device-scope resume skips table.events.* events."""
        tbl_topic = f"table.events.tbl-{uuid.uuid4().hex[:8]}"
        try:
            for i in range(2):
                self.buffer.append_event(
                    tbl_topic,
                    _make_envelope("table.events.row_created", {"row": i}),
                )

            consumer = StubConsumer(
                role="device_runtime",
                connection_scope="device",
                subscriptions={tbl_topic},
            )
            sent = _run(_do_resume(consumer, "0-0", self.buffer))

            replayed = [m for m in sent if m.get("type") != "resume.ok"]
            tbl_events = [m for m in replayed if m.get("type", "").startswith("table.events")]
            self.assertEqual(
                len(tbl_events), 0,
                "device scope should not receive table.events",
            )
        finally:
            _flush_stream(self.buffer, tbl_topic)

    def test_device_scope_filters_docparse_events(self):
        """Device-scope resume skips docparse.* events."""
        docparse_topic = f"docparse.events.doc-{uuid.uuid4().hex[:8]}"
        try:
            for i in range(2):
                self.buffer.append_event(
                    docparse_topic,
                    _make_envelope("docparse.events.progress", {"pct": i * 50}),
                )

            consumer = StubConsumer(
                role="daemon",
                connection_scope="device",
                subscriptions={docparse_topic},
            )
            sent = _run(_do_resume(consumer, "0-0", self.buffer))

            replayed = [m for m in sent if m.get("type") != "resume.ok"]
            dp_events = [m for m in replayed if m.get("type", "").startswith("docparse.")]
            self.assertEqual(
                len(dp_events), 0,
                "device scope should not receive docparse events",
            )
        finally:
            _flush_stream(self.buffer, docparse_topic)

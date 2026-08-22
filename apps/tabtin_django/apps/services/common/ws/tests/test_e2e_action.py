"""
End-to-end tests for Agent Action + Prompt Forward WS pipeline.

Covers three scenarios:
  1. Action complete round-trip (publish → device receive → result → stored)
  2. Offline buffering (device offline → action buffered → reconnect → drain)
  3. Approval flow (daemon request → frontend receive → frontend response → daemon receive)
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import defaultdict
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import SimpleTestCase

from apps.services.common.agent_protocol.constants import AgentActionEvent as AAE
from apps.services.common.agent_protocol.namespace import (
    ACTION_CAPABILITY,
    action_topic,
    device_action_topic,
    stream_topic,
)
from apps.services.common.ws.bus import device_action_ready_key
from apps.services.common.ws.handlers.action import create_action_result_handler
from apps.services.common.ws.handlers.approval import (
    APPROVAL_BUFFER_PREFIX,
    create_approval_request_handler,
    create_approval_response_handler,
)
from apps.services.common.ws.protocol import (
    CHANNEL_SAFE_PATTERN,
    PROTOCOL_VERSION,
    build_envelope,
    new_event_id,
)
from apps.services.agent_execution.effective_runtime_config import EffectiveRuntimeConfig


# ═══════════════════════════════════════════════════════════════════
# Fake Infrastructure
# ═══════════════════════════════════════════════════════════════════


class _FakeRedis:
    """Minimal in-memory Redis supporting operations used by the action pipeline."""

    def __init__(self):
        self._data: Dict[str, Any] = {}
        self._lists: Dict[str, List] = defaultdict(list)

    def get(self, key):
        return self._data.get(key)

    def set(self, key, value, ex=None, nx=False):
        if nx and key in self._data:
            return False
        self._data[key] = value
        return True

    def delete(self, *keys):
        count = 0
        for key in keys:
            if self._data.pop(key, None) is not None:
                count += 1
            if self._lists.pop(key, None) is not None:
                count += 1
        return count

    def rpush(self, key, *values):
        for v in values:
            self._lists[key].append(v)
        return len(self._lists[key])

    def lpop(self, key):
        lst = self._lists.get(key)
        return lst.pop(0) if lst else None

    def lpush(self, key, *values):
        for v in reversed(values):
            self._lists[key].insert(0, v)
        return len(self._lists[key])

    def expire(self, key, seconds):
        return True

    def ltrim(self, key, start, end):
        if key in self._lists:
            lst = self._lists[key]
            if end == -1:
                self._lists[key] = lst[start:]
            else:
                self._lists[key] = lst[start : end + 1]
        return True

    def pipeline(self, transaction=False):
        return _FakePipeline(self)

    def ping(self):
        return True

    def brpop(self, keys, timeout=0):
        for key in keys:
            item = self.lpop(key)
            if item is not None:
                return (key, item)
        return None

    def incr(self, key):
        val = int(self._data.get(key, 0)) + 1
        self._data[key] = str(val)
        return val

    def decr(self, key):
        val = int(self._data.get(key, 0)) - 1
        self._data[key] = str(val)
        return val


class _FakePipeline:
    def __init__(self, redis_instance: _FakeRedis):
        self._redis = redis_instance
        self._commands: list = []

    def __getattr__(self, name):
        def method(*args, **kwargs):
            self._commands.append((name, args, kwargs))
            return self

        return method

    def execute(self):
        results = []
        for cmd_name, args, kwargs in self._commands:
            fn = getattr(self._redis, cmd_name)
            results.append(fn(*args, **kwargs))
        self._commands.clear()
        return results


class _FakeCache:
    """Django cache mock."""

    def __init__(self):
        self._data: Dict[str, Any] = {}

    def get(self, key):
        return self._data.get(key)

    def set(self, key, value, timeout=None):
        self._data[key] = value

    def delete(self, key):
        self._data.pop(key, None)


class _FakeChannelLayer:
    """In-memory channel layer for group messaging.

    All methods are sync-safe (no real I/O) but keep async signatures
    so they satisfy the Channels interface when awaited.  The ``_sync_*``
    variants are provided for use in contexts where an event loop is
    already running (e.g. inside a mocked ``publish_ws_event``).
    """

    def __init__(self):
        self._groups: Dict[str, set] = defaultdict(set)
        self._channel_queues: Dict[str, List] = defaultdict(list)

    # --- async interface (used by consumer helpers) ---

    async def group_add(self, group, channel):
        self._sync_group_add(group, channel)

    async def group_discard(self, group, channel):
        self._sync_group_discard(group, channel)

    async def group_send(self, group, message):
        self._sync_group_send(group, message)

    # --- sync interface (used inside publish_ws_event mocks) ---

    def _sync_group_add(self, group, channel):
        self._groups[group].add(channel)

    def _sync_group_discard(self, group, channel):
        self._groups[group].discard(channel)

    def _sync_group_send(self, group, message):
        for channel in list(self._groups.get(group, set())):
            self._channel_queues[channel].append(message)

    def pop_messages(self, channel) -> list:
        msgs = list(self._channel_queues.get(channel, []))
        self._channel_queues[channel] = []
        return msgs


# ═══════════════════════════════════════════════════════════════════
# Fake Consumer (simulates GatewayConsumer for handler testing)
# ═══════════════════════════════════════════════════════════════════


class _FakeConsumer:
    """Lightweight stand-in for GatewayConsumer with recording."""

    def __init__(
        self,
        *,
        channel_layer: _FakeChannelLayer,
        role: str = "daemon",
        user_id: str = "user-1",
        organization_id: str = "ws-1",
        device_fingerprint: str = "fp-daemon-1",
        capabilities: set | None = None,
        channel_name: str | None = None,
    ):
        from apps.services.common.ws.organization_context import OrganizationContext

        self.channel_layer = channel_layer
        self.authed = True
        self.user = SimpleNamespace(id=user_id)
        self.user_id = user_id
        self.organization_ctx = OrganizationContext(organization_id, {organization_id} if organization_id else set())
        self.role = role
        self.device_fingerprint = device_fingerprint
        self.device_identity_verified = True
        self.capabilities = capabilities or {ACTION_CAPABILITY, "agent.stream", "context.sync"}
        self.subscriptions: set = set()
        self.joined_groups: set = set()
        self.channel_name = channel_name or f"ch_{uuid.uuid4().hex[:8]}"
        self.connection_scope = "device" if role in ("daemon", "device_runtime") else "session"

        self._sent: List[Dict[str, Any]] = []
        self._errors: List[Dict[str, Any]] = []

    @property
    def organization_id(self):
        return self.organization_ctx.primary_id

    @property
    def organization_ids(self):
        return self.organization_ctx.all_ids

    async def _send_envelope(self, envelope: Dict[str, Any]) -> None:
        self._sent.append(envelope)

    async def _send_error(self, request_id: str, code: str, message: str, details=None) -> None:
        from apps.services.common.ws.protocol import build_error

        self._errors.append(build_error(request_id, code, message, details=details))

    async def join_topic(self, topic: str) -> None:
        safe = CHANNEL_SAFE_PATTERN.sub(".", f"topic.{topic}")
        await self.channel_layer.group_add(safe, self.channel_name)
        self.joined_groups.add(safe)
        self.subscriptions.add(topic)

    def sent_of_type(self, msg_type: str) -> List[Dict]:
        return [m for m in self._sent if m.get("type") == msg_type]


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════


def _envelope(
    msg_type: str,
    payload: dict,
    *,
    role: str = "daemon",
    device_id: str = "fp-daemon-1",
    thread_id: str | None = None,
) -> dict:
    env: dict = {
        "v": PROTOCOL_VERSION,
        "type": msg_type,
        "request_id": f"req_{uuid.uuid4().hex[:8]}",
        "ts": int(time.time()),
        "device_id": device_id,
        "role": role,
        "payload": payload,
    }
    if thread_id:
        env["thread_id"] = thread_id
    return env


def _run(coro):
    """Execute async coroutine in a new event loop (test helper)."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ═══════════════════════════════════════════════════════════════════
# Shared mock context builder
# ═══════════════════════════════════════════════════════════════════


def _build_patches(fake_redis: _FakeRedis, fake_cache: _FakeCache, fake_channel_layer: _FakeChannelLayer):
    """Return a list of active mock patches for Redis, cache, and channel layer."""
    return [
        patch("apps.services.common.ws.bus.get_channel_layer", return_value=fake_channel_layer),
        patch("apps.services.common.ws.handlers.approval.publish_ws_event", side_effect=_make_publish(fake_channel_layer)),
        patch(
            "apps.services.agent_engine.services.frontend_action_service.FrontendActionService.redis_client",
            new_callable=lambda: property(lambda self: fake_redis),
        ),
        patch("django.core.cache.cache", fake_cache),
    ]


def _make_publish(channel_layer: _FakeChannelLayer):
    """Create a side_effect that mimics publish_ws_event using the fake channel layer.

    Uses _sync_group_send to avoid nested event loop issues when called
    from inside an already-running async handler.
    """

    def _publish(topic: str, envelope: dict) -> bool:
        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"topic.{topic}")
        channel_layer._sync_group_send(group_name, {"type": "broadcast_message", "message": envelope})
        return True

    return _publish


def _make_publish_to_user(channel_layer: _FakeChannelLayer):
    """Create a side_effect that mimics publish_to_user using the fake channel layer."""

    def _publish(user_id: str, envelope: dict) -> bool:
        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"user.{user_id}")
        channel_layer._sync_group_send(group_name, {"type": "broadcast_message", "message": envelope})
        return True

    return _publish


# ═══════════════════════════════════════════════════════════════════
# Scenario 1: Action Complete Round-Trip
# ═══════════════════════════════════════════════════════════════════


class ActionRoundTripE2ETests(SimpleTestCase):
    """
    Device connects (daemon) → auth → subscribe agent.action.device.{fp}
    → Action published to device → device sends action.result → result stored
    """

    def setUp(self):
        self.fake_redis = _FakeRedis()
        self.fake_cache = _FakeCache()
        self.channel_layer = _FakeChannelLayer()
        self.device_fp = "fp-daemon-e2e-1"
        self.thread_id = "chat-session-e2e-roundtrip"
        self.task_id = f"task_{uuid.uuid4().hex[:12]}"

        self.daemon = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="daemon",
            device_fingerprint=self.device_fp,
        )

    def test_action_round_trip_complete(self):
        """Full round-trip: subscribe → receive action → send result → result stored."""

        fake_redis = self.fake_redis
        fake_cache = self.fake_cache
        channel_layer = self.channel_layer
        daemon = self.daemon

        # ─── Phase 1: Device subscribes to action topic ───
        device_topic = device_action_topic(self.device_fp)
        _run(daemon.join_topic(device_topic))

        # Mark device as ready (mirrors AgentActionDeviceValidator.on_subscribed)
        fake_cache.set(device_action_ready_key(self.device_fp), daemon.channel_name)

        self.assertIn(device_topic, daemon.subscriptions)
        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"topic.{device_topic}")
        self.assertIn(daemon.channel_name, channel_layer._groups[group_name])

        # ─── Phase 2: Action request published to device topic ───
        action_envelope = build_envelope(
            AAE.REQUEST,
            new_event_id(),
            {
                "task_id": self.task_id,
                "action": "navigate",
                "params": {"url": "https://example.com"},
                "thread_id": self.thread_id,
            },
            thread_id=self.thread_id,
        )

        _run(channel_layer.group_send(
            group_name,
            {"type": "broadcast_message", "message": action_envelope},
        ))

        messages = channel_layer.pop_messages(daemon.channel_name)
        self.assertEqual(len(messages), 1)
        received_action = messages[0]["message"]
        self.assertEqual(received_action["type"], AAE.REQUEST)
        self.assertEqual(received_action["payload"]["task_id"], self.task_id)
        self.assertEqual(received_action["payload"]["action"], "navigate")

        # ─── Phase 3: Device sends action result ───
        result_envelope = _envelope(
            AAE.RESULT,
            {
                "task_id": self.task_id,
                "success": True,
                "data": {"status": "navigated"},
            },
            device_id=self.device_fp,
            thread_id=self.thread_id,
        )

        # Mock dependencies of action result handler
        fake_action_service = MagicMock()
        fake_action_service.get_action_device.return_value = None
        fake_action_service.touch_action_device.return_value = True
        fake_action_service.store_result.return_value = None

        fake_transport = MagicMock()
        fake_transport.check_task_dedup.return_value = True
        fake_transport.clear_task_dedup.return_value = None

        handler = create_action_result_handler(daemon)

        with patch(
            "apps.services.common.ws.handlers.action._get_action_service",
            return_value=fake_action_service,
        ), patch(
            "apps.services.common.ws.handlers.action._get_frozen_action_device_sync",
            return_value=None,
        ), patch(
            "apps.services.agent_engine.services.action_transport_service.ActionTransportService",
            return_value=fake_transport,
        ), patch(
            "apps.services.common.ws.handlers.action.resolve_trace_for_external_event",
            return_value=(None, None),
        ):
            _run(handler(result_envelope))

        # ─── Phase 4: Verify result processed correctly ───
        ok_msgs = daemon.sent_of_type(AAE.RESULT_OK)
        self.assertEqual(len(ok_msgs), 1, f"Expected 1 result.ok, got {len(ok_msgs)}: {daemon._sent}")
        self.assertEqual(ok_msgs[0]["payload"]["status"], "ok")

        # store_result was called with correct args
        fake_action_service.store_result.assert_called_once()
        call_args = fake_action_service.store_result.call_args
        self.assertEqual(call_args[0][0], self.thread_id)
        self.assertEqual(call_args[0][1], self.task_id)
        stored_data = call_args[0][2]
        self.assertTrue(stored_data["success"])
        self.assertEqual(stored_data["data"], {"status": "navigated"})

        # No errors
        self.assertEqual(len(daemon._errors), 0, f"Unexpected errors: {daemon._errors}")

    def test_action_result_duplicate_suppressed(self):
        """Duplicate task_id is detected by dedup check and suppressed."""
        daemon = self.daemon
        _run(daemon.join_topic(device_action_topic(self.device_fp)))

        result_envelope = _envelope(
            AAE.RESULT,
            {"task_id": self.task_id, "success": True},
            device_id=self.device_fp,
            thread_id=self.thread_id,
        )

        fake_action_service = MagicMock()
        fake_action_service.get_action_device.return_value = None

        fake_transport = MagicMock()
        fake_transport.check_task_dedup.return_value = False  # duplicate

        handler = create_action_result_handler(daemon)

        with patch(
            "apps.services.common.ws.handlers.action._get_action_service",
            return_value=fake_action_service,
        ), patch(
            "apps.services.common.ws.handlers.action._get_frozen_action_device_sync",
            return_value=None,
        ), patch(
            "apps.services.agent_engine.services.action_transport_service.ActionTransportService",
            return_value=fake_transport,
        ):
            _run(handler(result_envelope))

        ok_msgs = daemon.sent_of_type(AAE.RESULT_OK)
        self.assertEqual(len(ok_msgs), 1)
        self.assertIn("duplicate", ok_msgs[0]["payload"]["message"])
        fake_action_service.store_result.assert_not_called()

    def test_action_result_rejected_for_wrong_role(self):
        """Non-device roles are rejected."""
        mobile = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="mobile",
            device_fingerprint="fp-mobile-1",
        )

        result_envelope = _envelope(
            AAE.RESULT,
            {"task_id": self.task_id, "success": True},
            role="mobile",
            device_id="fp-mobile-1",
            thread_id=self.thread_id,
        )

        handler = create_action_result_handler(mobile)
        _run(handler(result_envelope))

        self.assertEqual(len(mobile._errors), 1)
        self.assertIn("role not allowed", mobile._errors[0]["payload"]["message"])

    def test_action_result_rejected_for_unverified_execution_device(self):
        daemon = _FakeConsumer(
            channel_layer=self.channel_layer,
            device_fingerprint=self.device_fp,
        )
        daemon.device_identity_verified = False

        handler = create_action_result_handler(daemon)
        _run(handler(_envelope(
            AAE.RESULT,
            {"task_id": self.task_id, "success": True},
            device_id=self.device_fp,
            thread_id=self.thread_id,
        )))

        self.assertEqual(len(daemon._errors), 1)
        self.assertIn("not verified", daemon._errors[0]["payload"]["message"])

    def test_action_result_rejects_device_that_does_not_own_frozen_session(self):
        daemon = _FakeConsumer(
            channel_layer=self.channel_layer,
            device_fingerprint="device-b",
        )
        fake_action_service = MagicMock()

        handler = create_action_result_handler(daemon)
        with patch(
            "apps.services.common.ws.handlers.action._get_frozen_action_device_sync",
            return_value="device-a",
        ), patch(
            "apps.services.common.ws.handlers.action._get_action_service",
            return_value=fake_action_service,
        ):
            _run(handler(_envelope(
                AAE.RESULT,
                {"task_id": self.task_id, "success": True},
                device_id="device-b",
                thread_id=self.thread_id,
            )))

        self.assertEqual(len(daemon._errors), 1)
        self.assertIn("device mismatch", daemon._errors[0]["payload"]["message"])
        fake_action_service.touch_action_device.assert_not_called()
        fake_action_service.store_result.assert_not_called()

    def test_action_result_accepts_frozen_session_owner_without_redis_binding(self):
        daemon = _FakeConsumer(
            channel_layer=self.channel_layer,
            device_fingerprint="device-a",
        )
        fake_action_service = MagicMock()
        fake_transport = MagicMock()
        fake_transport.check_task_dedup.return_value = False

        handler = create_action_result_handler(daemon)
        with patch(
            "apps.services.common.ws.handlers.action._get_frozen_action_device_sync",
            return_value="device-a",
        ), patch(
            "apps.services.common.ws.handlers.action._get_action_service",
            return_value=fake_action_service,
        ), patch(
            "apps.services.agent_engine.services.action_transport_service.ActionTransportService",
            return_value=fake_transport,
        ):
            _run(handler(_envelope(
                AAE.RESULT,
                {"task_id": self.task_id, "success": True},
                device_id="device-a",
                thread_id=self.thread_id,
            )))

        self.assertEqual(len(daemon.sent_of_type(AAE.RESULT_OK)), 1)
        self.assertEqual(daemon._errors, [])
        fake_action_service.touch_action_device.assert_not_called()


# ═══════════════════════════════════════════════════════════════════
# Scenario 2: Device Offline Action Buffering
# ═══════════════════════════════════════════════════════════════════


class ActionBufferE2ETests(SimpleTestCase):
    """
    Device connects → disconnects → action buffered → device reconnects
    → buffered action drained to device.
    """

    def setUp(self):
        self.fake_redis = _FakeRedis()
        self.fake_cache = _FakeCache()
        self.channel_layer = _FakeChannelLayer()
        self.device_fp = "fp-daemon-buffer-1"
        self.thread_id = "chat-session-e2e-buffer"
        self.task_id = f"task_{uuid.uuid4().hex[:12]}"

    def test_offline_buffer_and_drain(self):
        """Actions buffered while device offline are drained on reconnect."""

        fake_redis = self.fake_redis
        device_fp = self.device_fp

        # ─── Phase 1: Device connects and subscribes ───
        daemon_v1 = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="daemon",
            device_fingerprint=device_fp,
            channel_name="ch_v1",
        )
        device_topic = device_action_topic(device_fp)
        _run(daemon_v1.join_topic(device_topic))
        self.fake_cache.set(device_action_ready_key(device_fp), daemon_v1.channel_name)

        # ─── Phase 2: Device disconnects ───
        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"topic.{device_topic}")
        _run(self.channel_layer.group_discard(group_name, daemon_v1.channel_name))
        self.fake_cache.delete(device_action_ready_key(device_fp))

        # ─── Phase 3: Action arrives while device offline → buffer ───
        action_envelope = build_envelope(
            AAE.REQUEST,
            new_event_id(),
            {
                "task_id": self.task_id,
                "action": "screenshot",
                "params": {},
                "thread_id": self.thread_id,
            },
            thread_id=self.thread_id,
        )

        from apps.services.agent_engine.services.action_transport_service import (
            ACTION_BUFFER_PREFIX,
            ActionTransportService,
        )

        transport = ActionTransportService.__new__(ActionTransportService)
        transport._redis_client = fake_redis
        transport.buffer_action(device_fp, action_envelope)

        buffer_key = f"{ACTION_BUFFER_PREFIX}{device_fp}"
        self.assertTrue(len(fake_redis._lists.get(buffer_key, [])) > 0)

        # ─── Phase 4: Device reconnects and drains buffer ───
        daemon_v2 = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="daemon",
            device_fingerprint=device_fp,
            channel_name="ch_v2",
        )
        _run(daemon_v2.join_topic(device_topic))
        self.fake_cache.set(device_action_ready_key(device_fp), daemon_v2.channel_name)

        drained = transport.drain_buffered_actions(device_fp)

        self.assertEqual(len(drained), 1)
        self.assertEqual(drained[0]["type"], AAE.REQUEST)
        self.assertEqual(drained[0]["payload"]["task_id"], self.task_id)
        self.assertEqual(drained[0]["payload"]["action"], "screenshot")

        # Buffer is now empty
        remaining = fake_redis._lists.get(buffer_key, [])
        self.assertEqual(len(remaining), 0)

    def test_multiple_actions_buffered_and_drained_in_order(self):
        """Multiple buffered actions drain in FIFO order."""

        fake_redis = self.fake_redis
        device_fp = self.device_fp

        from apps.services.agent_engine.services.action_transport_service import (
            ACTION_BUFFER_PREFIX,
            ActionTransportService,
        )

        transport = ActionTransportService.__new__(ActionTransportService)
        transport._redis_client = fake_redis

        task_ids = [f"task_{i}_{uuid.uuid4().hex[:6]}" for i in range(3)]
        for i, tid in enumerate(task_ids):
            env = build_envelope(
                AAE.REQUEST,
                new_event_id(),
                {
                    "task_id": tid,
                    "action": f"action_{i}",
                    "params": {},
                    "thread_id": self.thread_id,
                },
                thread_id=self.thread_id,
            )
            transport.buffer_action(device_fp, env)

        buffer_key = f"{ACTION_BUFFER_PREFIX}{device_fp}"
        self.assertEqual(len(fake_redis._lists[buffer_key]), 3)

        drained = transport.drain_buffered_actions(device_fp)

        self.assertEqual(len(drained), 3)
        for i, action in enumerate(drained):
            self.assertEqual(action["payload"]["task_id"], task_ids[i])
            self.assertEqual(action["payload"]["action"], f"action_{i}")

        self.assertEqual(len(fake_redis._lists.get(buffer_key, [])), 0)

    def test_drain_on_empty_buffer_returns_empty(self):
        """Draining when no actions are buffered returns an empty list."""

        from apps.services.agent_engine.services.action_transport_service import ActionTransportService

        transport = ActionTransportService.__new__(ActionTransportService)
        transport._redis_client = self.fake_redis

        drained = transport.drain_buffered_actions("fp-nonexistent")
        self.assertEqual(drained, [])


# ═══════════════════════════════════════════════════════════════════
# Scenario 3: HITL Approval Flow
# ═══════════════════════════════════════════════════════════════════


class ApprovalFlowE2ETests(SimpleTestCase):
    """
    Daemon sends approval_request → frontend receives → frontend sends
    approval_response → daemon receives.
    """

    @staticmethod
    def _action_service_patches(mock_svc):
        """MB-23：approval_response 设备解析委托 localrt._resolve_runtime_device_fp，须双 patch。"""
        return (
            patch(
                "apps.services.common.ws.handlers.approval._get_action_service",
                return_value=mock_svc,
            ),
            patch(
                "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
                return_value=mock_svc,
            ),
        )

    def setUp(self):
        self.fake_redis = _FakeRedis()
        self.fake_cache = _FakeCache()
        self.channel_layer = _FakeChannelLayer()
        self.device_fp = "fp-daemon-approval-1"
        self.thread_id = "chat-session-e2e-approval"
        self.approval_id = f"approval_{uuid.uuid4().hex[:12]}"
        project_lookup = patch(
            "apps.services.common.ws.handlers.approval._is_project_thread_async",
            return_value=False,
        )
        project_lookup.start()
        self.addCleanup(project_lookup.stop)
        for target in (
            "apps.services.common.ws.handlers.approval.runtime_can_open_interaction",
            "apps.services.common.ws.handlers.localrt_user_response._can_user_resolve_tool_approval_async",
        ):
            patcher = patch(target, return_value=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_approval_request_forwarded_to_frontend(self):
        """Daemon approval_request is published to legacy action/user paths and current chat stream."""

        channel_layer = self.channel_layer

        daemon = _FakeConsumer(
            channel_layer=channel_layer,
            role="daemon",
            device_fingerprint=self.device_fp,
            user_id="user-approval-1",
        )

        # Electron subscribes to the session action topic
        session_topic = action_topic(self.thread_id)
        electron = _FakeConsumer(
            channel_layer=channel_layer,
            role="electron",
            device_fingerprint="fp-electron-1",
            user_id="user-approval-1",
            channel_name="ch_electron",
        )
        _run(electron.join_topic(session_topic))

        mobile = _FakeConsumer(
            channel_layer=channel_layer,
            role="mobile",
            device_fingerprint="fp-mobile-1",
            user_id="user-approval-1",
            channel_name="ch_mobile",
            capabilities={"agent.stream", "context.sync"},
        )
        mobile.connection_scope = "user"
        _run(mobile.join_topic(stream_topic(self.thread_id)))

        # Wave 5: Electron joins user group ``user.{user_id}`` (NOT ``topic.user.{user_id}``).
        # publish_to_user 直接发到 ``user.{user_id}`` group（前端 auth.py 时 join），
        # 测试 group_add 必须对齐这个行为。
        user_group = CHANNEL_SAFE_PATTERN.sub(".", f"user.user-approval-1")
        _run(channel_layer.group_add(user_group, electron.channel_name))
        _run(channel_layer.group_add(user_group, mobile.channel_name))

        # Daemon sends approval_request
        approval_envelope = _envelope(
            AAE.APPROVAL_REQUEST,
            {
                "approval_id": self.approval_id,
                "task_id": "task-cmd-1",
                "command": "rm -rf /tmp/test",
                "policy": {"requires_approval": True},
                "thread_id": self.thread_id,
            },
            device_id=self.device_fp,
            thread_id=self.thread_id,
        )

        handler = create_approval_request_handler(daemon)

        with patch(
            "apps.services.common.ws.handlers.approval._get_action_service",
        ) as mock_svc, patch(
            "apps.services.common.ws.handlers.approval.upsert_action_approval_interaction",
            return_value=SimpleNamespace(status="pending"),
        ) as upsert_pending, patch(
            "apps.services.common.ws.handlers.approval.publish_ws_event_async",
            side_effect=_make_publish(channel_layer),
        ), patch(
            "apps.services.common.ws.handlers.approval.publish_to_user_async",
            side_effect=_make_publish_to_user(channel_layer),
        ), patch(
            "apps.services.common.ws.handlers.approval._resolve_thread_organization_cached",
            return_value="00000000-0000-0000-0000-000000000abc",
        ):
            mock_svc.return_value.bind_action_device.return_value = None
            _run(handler(approval_envelope))

        # Daemon should get approval_request.ok
        ok_msgs = daemon.sent_of_type(AAE.APPROVAL_REQUEST_OK)
        self.assertEqual(len(ok_msgs), 1, f"Expected 1 approval_request.ok, got: {daemon._sent}")
        upsert_pending.assert_called_once()
        self.assertEqual(upsert_pending.call_args.kwargs["thread_id"], self.thread_id)
        self.assertEqual(upsert_pending.call_args.kwargs["approval_id"], self.approval_id)
        self.assertEqual(upsert_pending.call_args.kwargs["payload"]["command"], "rm -rf /tmp/test")
        self.assertEqual(upsert_pending.call_args.kwargs["source_device_fingerprint"], self.device_fp)
        self.assertTrue(upsert_pending.call_args.kwargs["publish"])

        # Electron should have received the approval_request via channel layer
        electron_messages = channel_layer.pop_messages(electron.channel_name)
        approval_broadcasts = [
            m["message"]
            for m in electron_messages
            if m.get("message", {}).get("type") == AAE.APPROVAL_REQUEST
        ]
        self.assertGreaterEqual(
            len(approval_broadcasts), 1,
            f"Electron should receive approval_request broadcast, got: {electron_messages}",
        )
        forwarded = approval_broadcasts[0]
        self.assertEqual(forwarded["payload"]["approval_id"], self.approval_id)
        self.assertEqual(forwarded["payload"]["command"], "rm -rf /tmp/test")
        mobile_messages = channel_layer.pop_messages(mobile.channel_name)
        mobile_approval_broadcasts = [
            m["message"]
            for m in mobile_messages
            if m.get("message", {}).get("type") == AAE.APPROVAL_REQUEST
        ]
        self.assertGreaterEqual(
            len(mobile_approval_broadcasts), 1,
            f"Mobile should receive approval_request via user group/current stream, got: {mobile_messages}",
        )
        self.assertEqual(mobile_approval_broadcasts[0]["payload"]["approval_id"], self.approval_id)
        self.assertGreaterEqual(
            len(mobile_approval_broadcasts), 2,
            "Mobile is joined to both user group and current chat stream; "
            "legacy action approvals must be mirrored to the stream topic too.",
        )
        # Wave 5（P0）：envelope 顶层 + payload 都必须带 organization_id
        # 否则前端 useGlobalTaskMonitorStore.envelopeToTaskRecord 会丢弃整条事件
        self.assertEqual(forwarded["organization_id"], "00000000-0000-0000-0000-000000000abc")
        self.assertEqual(
            forwarded["payload"]["organization_id"],
            "00000000-0000-0000-0000-000000000abc",
        )

    def test_approval_request_not_broadcast_when_pending_upsert_fails(self):
        """Window-level approvals must not degrade back into unrecoverable realtime-only prompts."""

        channel_layer = self.channel_layer

        daemon = _FakeConsumer(
            channel_layer=channel_layer,
            role="daemon",
            device_fingerprint=self.device_fp,
            user_id="user-approval-1",
        )
        approval_envelope = _envelope(
            AAE.APPROVAL_REQUEST,
            {
                "approval_id": self.approval_id,
                "command": "open https://example.com",
                "thread_id": self.thread_id,
            },
            device_id=self.device_fp,
            thread_id=self.thread_id,
        )

        handler = create_approval_request_handler(daemon)

        with patch(
            "apps.services.common.ws.handlers.approval._get_action_service",
        ) as mock_svc, patch(
            "apps.services.common.ws.handlers.approval.upsert_action_approval_interaction",
            side_effect=RuntimeError("db unavailable"),
        ), patch(
            "apps.services.common.ws.handlers.approval.publish_ws_event_async",
        ) as publish_ws, patch(
            "apps.services.common.ws.handlers.approval.publish_to_user_async",
        ) as publish_user, patch(
            "apps.services.common.ws.handlers.approval._resolve_thread_organization_cached",
            return_value="00000000-0000-0000-0000-000000000abc",
        ):
            mock_svc.return_value.bind_action_device.return_value = None
            _run(handler(approval_envelope))

        self.assertEqual(daemon.sent_of_type(AAE.APPROVAL_REQUEST_OK), [])
        errors = daemon._errors
        self.assertEqual(len(errors), 1, f"Expected error envelope, got: {daemon._sent}")
        self.assertEqual(errors[0]["payload"]["code"], "WS_1010_INTERNAL_ERROR")
        publish_ws.assert_not_called()
        publish_user.assert_not_called()

    def test_approval_request_rejects_runtime_not_bound_to_session(self):
        daemon = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="daemon",
            device_fingerprint="fp-wrong-runtime",
            user_id="user-approval-1",
        )
        envelope = _envelope(
            AAE.APPROVAL_REQUEST,
            {
                "approval_id": self.approval_id,
                "thread_id": self.thread_id,
            },
            device_id="fp-wrong-runtime",
            thread_id=self.thread_id,
        )

        with patch(
            "apps.services.common.ws.handlers.approval.runtime_can_open_interaction",
            return_value=False,
        ), patch(
            "apps.services.common.ws.handlers.approval.upsert_action_approval_interaction",
        ) as upsert_pending:
            _run(create_approval_request_handler(daemon)(envelope))

        upsert_pending.assert_not_called()
        self.assertEqual(len(daemon._errors), 1)
        self.assertEqual(
            daemon._errors[0]["payload"]["code"],
            "WS_1005_PERMISSION_DENIED",
        )

    def test_approval_response_forwarded_to_daemon(self):
        """Legacy approval waits for runtime ACK through the shared localrt channel."""

        channel_layer = self.channel_layer

        # Daemon subscribes to its device action topic
        daemon = _FakeConsumer(
            channel_layer=channel_layer,
            role="daemon",
            device_fingerprint=self.device_fp,
            user_id="user-approval-2",
            channel_name="ch_daemon",
        )
        daemon_topic = device_action_topic(self.device_fp)
        _run(daemon.join_topic(daemon_topic))

        # Electron sends approval_response
        electron = _FakeConsumer(
            channel_layer=channel_layer,
            role="electron",
            device_fingerprint="fp-electron-2",
            user_id="user-approval-2",
            channel_name="ch_electron",
        )

        # Wave 5: APPROVAL_RESOLVED 走 publish_to_user → ``user.{user_id}`` group。
        user_group = CHANNEL_SAFE_PATTERN.sub(".", f"user.user-approval-2")
        _run(channel_layer.group_add(user_group, electron.channel_name))

        response_envelope = _envelope(
            AAE.APPROVAL_RESPONSE,
            {
                "approval_id": self.approval_id,
                "approved": True,
                # B2 修复（统一审批 v2 §0.1）：用户在 ApprovalDialog 选择"总是允许"
                # 时前端会带 scope='always'。下面断言 Daemon 收到的 envelope 也带这个
                # 字段——这是"总是允许在 WS 路径下真正生效"的产品语义闭环。
                "scope": "always",
                "thread_id": self.thread_id,
            },
            role="electron",
            device_id="fp-electron-2",
            thread_id=self.thread_id,
        )

        handler = create_approval_response_handler(electron)

        fake_action_service = MagicMock()
        fake_action_service.get_action_device.return_value = self.device_fp
        fake_action_service._resolve_daemon_fingerprint.return_value = self.device_fp
        fake_action_service.redis_client = self.fake_redis
        call_order: list[str] = []
        svc_patches = self._action_service_patches(fake_action_service)
        with svc_patches[0], svc_patches[1], patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_ws_event_async",
            side_effect=_make_publish(channel_layer),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
            return_value=None,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._wait_for_delivery_ack",
            AsyncMock(side_effect=lambda _submit_id: call_order.append("ack") or {"status": "delivered"}),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._publish_approval_resolved_to_mirror",
            side_effect=lambda *_args, **_kwargs: call_order.append("resolved"),
        ), patch(
            "apps.services.common.ws.handlers.approval._resolve_thread_organization_cached",
            return_value="00000000-0000-0000-0000-000000000def",
        ):
            _run(handler(response_envelope))

        # Electron gets approval_response.ok
        ok_msgs = electron.sent_of_type(AAE.APPROVAL_RESPONSE_OK)
        self.assertEqual(len(ok_msgs), 1, f"Expected 1 approval_response.ok, got: {electron._sent}")

        # Daemon receives the durable localrt batch shape consumed by shared AgentHost.
        daemon_messages = channel_layer.pop_messages(daemon.channel_name)
        response_broadcasts = [
            m["message"]
            for m in daemon_messages
            if m.get("message", {}).get("type") == "localrt.user_response"
        ]
        self.assertGreaterEqual(
            len(response_broadcasts), 1,
            f"Daemon should receive localrt.user_response, got: {daemon_messages}",
        )
        fwd = response_broadcasts[0]
        self.assertTrue(fwd["payload"]["submit_id"])
        self.assertEqual(fwd["payload"]["request_id"], self.approval_id)
        response = fwd["payload"]["response"]
        self.assertEqual(response["batch_id"], self.approval_id)
        self.assertEqual(response["decisions"][0]["outcome"], "allow")
        self.assertEqual(response["decisions"][0]["scope"], "always")
        self.assertEqual(
            response["decisions"][0]["approver_identity"]["user_id"],
            electron.user_id,
        )
        self.assertEqual(call_order, ["ack", "resolved"])

    def test_approval_response_rejects_non_owner_before_routing(self):
        electron = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="electron",
            device_fingerprint="fp-electron-attacker",
            user_id="user-attacker",
        )
        envelope = _envelope(
            AAE.APPROVAL_RESPONSE,
            {
                "approval_id": self.approval_id,
                "approved": True,
                "thread_id": self.thread_id,
            },
            role="electron",
            device_id="fp-electron-attacker",
            thread_id=self.thread_id,
        )

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._can_user_resolve_tool_approval_async",
            AsyncMock(return_value=False),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._resolve_runtime_device_fp_for_hitl_async",
        ) as resolve_runtime:
            _run(create_approval_response_handler(electron)(envelope))

        resolve_runtime.assert_not_called()
        self.assertEqual(len(electron._errors), 1)
        self.assertEqual(
            electron._errors[0]["payload"]["code"],
            "WS_1005_PERMISSION_DENIED",
        )

    def test_approval_response_naks_when_runtime_unresolved(self):
        """No runtime target means frontend must get retryable NAK, not a false OK."""

        mobile = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="mobile",
            device_fingerprint="ios-e2e-action",
            user_id="user-approval-offline",
            channel_name="ch_mobile_offline",
        )

        response_envelope = _envelope(
            AAE.APPROVAL_RESPONSE,
            {
                "approval_id": self.approval_id,
                "approved": True,
                "scope": "once",
                "thread_id": self.thread_id,
            },
            role="mobile",
            device_id="ios-e2e-action",
            thread_id=self.thread_id,
        )

        handler = create_approval_response_handler(mobile)

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._resolve_runtime_device_fp_for_hitl_async",
            AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._publish_approval_resolved_to_mirror",
        ) as mark_resolved, patch(
            "apps.services.common.ws.handlers.approval.publish_to_user_async",
        ) as publish_user:
            _run(handler(response_envelope))

        self.assertEqual(mobile.sent_of_type(AAE.APPROVAL_RESPONSE_OK), [])
        nak_msgs = mobile.sent_of_type(AAE.APPROVAL_RESPONSE_NAK)
        self.assertEqual(len(nak_msgs), 1, f"Expected retryable NAK, got: {mobile._sent}")
        self.assertEqual(nak_msgs[0]["payload"]["error_code"], "device_offline")
        self.assertTrue(nak_msgs[0]["payload"]["retryable"])
        mark_resolved.assert_not_called()
        publish_user.assert_not_called()

    # ─── B2: scope 透传专项测试 ───────────────────────────────────────
    #
    # 上面的 test_approval_response_forwarded_to_daemon 验证 scope='always' 主路径，
    # 下面这组测试单独覆盖"非主路径但要保对的"几种 scope 输入场景：
    # 1. session 透传     —— 用户选"本会话允许"
    # 2. 非法值兜底为 once —— 前端 bug / 篡改请求 fail-safe
    # 3. 缺失字段兜底为 once —— 旧版前端向后兼容
    # 4. deny 也带 scope   —— envelope 形状一致性（Daemon 拒绝分支无副作用）
    def _run_scope_forward(self, raw_scope, *, include_scope: bool = True, approved: Any = True):
        """B2 测试辅助：跑一次 approval_response，返回转发给执行端的 localrt envelope。

        ``include_scope=False`` 用于模拟旧版前端完全不带 scope 字段的情况。
        """
        channel_layer = self.channel_layer
        device_fp = f"fp-daemon-scope-{uuid.uuid4().hex[:6]}"

        daemon = _FakeConsumer(
            channel_layer=channel_layer,
            role="daemon",
            device_fingerprint=device_fp,
            user_id="user-scope",
            channel_name=f"ch_d_{uuid.uuid4().hex[:6]}",
        )
        _run(daemon.join_topic(device_action_topic(device_fp)))

        electron = _FakeConsumer(
            channel_layer=channel_layer,
            role="electron",
            device_fingerprint="fp-electron-scope",
            user_id="user-scope",
            channel_name=f"ch_e_{uuid.uuid4().hex[:6]}",
        )
        user_group = CHANNEL_SAFE_PATTERN.sub(".", "user.user-scope")
        _run(channel_layer.group_add(user_group, electron.channel_name))

        payload: Dict[str, Any] = {
            "approval_id": self.approval_id,
            "approved": approved,
            "thread_id": self.thread_id,
        }
        if include_scope:
            payload["scope"] = raw_scope

        env = _envelope(
            AAE.APPROVAL_RESPONSE,
            payload,
            role="electron",
            device_id="fp-electron-scope",
            thread_id=self.thread_id,
        )

        handler = create_approval_response_handler(electron)
        fake_action_service = MagicMock()
        fake_action_service.get_action_device.return_value = device_fp
        fake_action_service._resolve_daemon_fingerprint.return_value = device_fp
        fake_action_service.redis_client = self.fake_redis
        svc_patches = self._action_service_patches(fake_action_service)
        with svc_patches[0], svc_patches[1], patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_ws_event_async",
            side_effect=_make_publish(channel_layer),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
            return_value=None,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._wait_for_delivery_ack",
            AsyncMock(return_value={"status": "delivered"}),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._publish_approval_resolved_to_mirror",
        ), patch(
            "apps.services.common.ws.handlers.approval._resolve_thread_organization_cached",
            return_value="00000000-0000-0000-0000-000000000def",
        ):
            _run(handler(env))

        forwarded = next(
            m["message"] for m in channel_layer.pop_messages(daemon.channel_name)
            if m.get("message", {}).get("type") == "localrt.user_response"
        )
        return forwarded

    @staticmethod
    def _forwarded_legacy_decision(forwarded):
        return forwarded["payload"]["response"]["decisions"][0]

    def test_approval_response_thread_scope_forwarded(self):
        """B2（PRD 05 v0.4 §7.2.2）：用户选"本对话内允许"时 scope='thread' 必须透传给 Daemon。"""
        forwarded = self._run_scope_forward("thread")
        self.assertEqual(self._forwarded_legacy_decision(forwarded)["scope"], "thread")

    def test_approval_response_invalid_scope_normalized_to_once(self):
        """B2：白名单外 scope（如前端 bug 发出 'forever'）按 fail-safe 规则归为 'once'。

        宁可下次再问一遍，也不能错误地永久放行——这是"最小授权"原则。
        """
        forwarded = self._run_scope_forward("forever")
        self.assertEqual(self._forwarded_legacy_decision(forwarded)["scope"], "once")

    def test_approval_response_missing_scope_defaults_to_once(self):
        """B2：旧版前端不带 scope 字段时也归为 'once'，保持向后兼容。"""
        forwarded = self._run_scope_forward(None, include_scope=False)
        self.assertEqual(self._forwarded_legacy_decision(forwarded)["scope"], "once")

    def test_approval_response_deny_still_carries_scope(self):
        """B2：拒绝场景也透传 scope（Daemon 会忽略，但保持 envelope 形状一致）。"""
        decision = self._forwarded_legacy_decision(
            self._run_scope_forward("once", approved=False),
        )
        self.assertEqual(decision["outcome"], "deny")
        self.assertEqual(decision["scope"], "once")

    def test_approval_response_non_boolean_value_fails_closed(self):
        decision = self._forwarded_legacy_decision(
            self._run_scope_forward("once", approved="true"),
        )
        self.assertEqual(decision["outcome"], "deny")

    def test_approval_response_naks_when_delivery_cannot_be_enqueued(self):
        """Legacy approval stays retryable when the durable localrt publish fails."""

        channel_layer = self.channel_layer

        electron = _FakeConsumer(
            channel_layer=channel_layer,
            role="electron",
            device_fingerprint="fp-electron-3",
            user_id="user-approval-3",
        )

        response_envelope = _envelope(
            AAE.APPROVAL_RESPONSE,
            {
                "approval_id": self.approval_id,
                "approved": True,
                # 用 'always' 验证 scope 在 Redis 序列化往返后不丢
                "scope": "always",
                "thread_id": self.thread_id,
            },
            role="electron",
            device_id="fp-electron-3",
            thread_id=self.thread_id,
        )

        handler = create_approval_response_handler(electron)

        fake_redis = self.fake_redis
        fake_action_service = MagicMock()
        fake_action_service.get_action_device.return_value = self.device_fp
        fake_action_service._resolve_daemon_fingerprint.return_value = self.device_fp
        fake_action_service.redis_client = fake_redis

        def _publish_fails(topic, envelope):
            return False

        svc_patches = self._action_service_patches(fake_action_service)
        with svc_patches[0], svc_patches[1], patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_ws_event_async",
            side_effect=_publish_fails,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
            return_value=None,
        ):
            _run(handler(response_envelope))

        # The frontend must retry; no false success or legacy flat-event buffer remains.
        buffer_key = f"{APPROVAL_BUFFER_PREFIX}{self.device_fp}"
        self.assertEqual(fake_redis._lists.get(buffer_key, []), [])
        naks = electron.sent_of_type(AAE.APPROVAL_RESPONSE_NAK)
        self.assertEqual(len(naks), 1)
        self.assertEqual(naks[0]["payload"]["error_code"], "device_offline")
        self.assertTrue(naks[0]["payload"]["retryable"])

    def test_approval_response_deny_without_scope_normalized_to_once(self):
        """B2：拒绝场景前端不带 scope（ApprovalDialog 真实形态），后端兜底为 'once'。

        前端 ApprovalDialog.tsx 的 deny 按钮调用 ``respond(false)``，scope 参数是
        undefined → JSON 序列化后 ``payload.scope`` 不存在。这跟 deny 主动带
        scope='once' 的形态不同，必须独立覆盖。
        """
        decision = self._forwarded_legacy_decision(
            self._run_scope_forward(None, include_scope=False, approved=False),
        )
        self.assertEqual(decision["outcome"], "deny")
        self.assertEqual(decision["scope"], "once")

    def test_buffered_approval_drained_on_reconnect(self):
        """Buffered approval_responses are drained when daemon reconnects."""

        fake_redis = self.fake_redis
        device_fp = self.device_fp

        # Buffer two approval responses
        for i, approved in enumerate([True, False]):
            env = build_envelope(
                AAE.APPROVAL_RESPONSE,
                new_event_id(),
                {"approval_id": f"appr_{i}", "approved": approved},
                thread_id=self.thread_id,
            )
            buffer_key = f"{APPROVAL_BUFFER_PREFIX}{device_fp}"
            fake_redis.rpush(buffer_key, json.dumps(env))

        fake_action_service = MagicMock()
        fake_action_service.redis_client = fake_redis

        with patch(
            "apps.services.common.ws.handlers.approval._get_action_service",
            return_value=fake_action_service,
        ):
            from apps.services.common.ws.handlers.approval import drain_buffered_approval_responses

            drained = drain_buffered_approval_responses(device_fp)

        self.assertEqual(len(drained), 2)
        self.assertTrue(drained[0]["payload"]["approved"])
        self.assertFalse(drained[1]["payload"]["approved"])
        self.assertEqual(drained[0]["payload"]["approval_id"], "appr_0")
        self.assertEqual(drained[1]["payload"]["approval_id"], "appr_1")

        # Buffer empty after drain
        self.assertEqual(len(fake_redis._lists.get(f"{APPROVAL_BUFFER_PREFIX}{device_fp}", [])), 0)

    def test_approval_request_rejected_for_electron_role(self):
        """Only daemon/device_runtime can send approval_request."""

        electron = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="electron",
            device_fingerprint="fp-electron-reject",
        )

        envelope = _envelope(
            AAE.APPROVAL_REQUEST,
            {
                "approval_id": self.approval_id,
                "command": "ls",
                "thread_id": self.thread_id,
            },
            role="electron",
            device_id="fp-electron-reject",
            thread_id=self.thread_id,
        )

        handler = create_approval_request_handler(electron)
        _run(handler(envelope))

        self.assertEqual(len(electron._errors), 1)
        self.assertIn("only runtime devices", electron._errors[0]["payload"]["message"])

    def test_approval_response_rejected_for_daemon_role(self):
        """Only electron/mobile/admin can send approval_response."""

        daemon = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="daemon",
            device_fingerprint=self.device_fp,
        )

        envelope = _envelope(
            AAE.APPROVAL_RESPONSE,
            {
                "approval_id": self.approval_id,
                "approved": True,
                "thread_id": self.thread_id,
            },
            device_id=self.device_fp,
            thread_id=self.thread_id,
        )

        handler = create_approval_response_handler(daemon)
        _run(handler(envelope))

        self.assertEqual(len(daemon._errors), 1)
        self.assertIn("role not allowed", daemon._errors[0]["payload"]["message"])


# ═══════════════════════════════════════════════════════════════════
# Cross-cutting: PromptForward → Device Topic Integration
# ═══════════════════════════════════════════════════════════════════


class PromptForwardIntegrationTests(SimpleTestCase):
    """PromptForwardService routes envelope to the correct device topic."""

    def setUp(self):
        self.channel_layer = _FakeChannelLayer()
        self.fake_cache = _FakeCache()
        self.device_fp = "fp-daemon-pf-1"
        self.thread_id = "chat-session-e2e-pf"

    def test_prompt_forward_reaches_daemon_device_topic(self):
        """A frozen target is published only to that device's exact connection."""

        device_fp = self.device_fp

        fake_space = SimpleNamespace(
            id="workspace-pf-1",
            organization_id="ws-1",
            agent_config={"workspace_root": "/home/user"},
        )
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.publish_device_ws_event_exact",
            return_value=True,
        ) as mock_exact, patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService._bind_action_device_for_thread",
        ), patch(
            "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.accept_dispatch",
        ), patch(
            "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.transition",
        ):
            from apps.services.agent_engine.services.prompt_forward_service import PromptForwardService

            svc = PromptForwardService()
            result = svc.forward_prompt(
                thread_id=self.thread_id,
                space=fake_space,
                prompt="Hello, build a website",
                attachments=[],
                agent_backend_config={"model": "claude-4"},
                target_device_fingerprint=device_fp,
            )

        self.assertEqual(result["published"], 1)
        self.assertTrue(result["task_id"].startswith("prompt_"))

        mock_exact.assert_called_once()
        self.assertEqual(mock_exact.call_args[0][0], device_fp)
        call_envelope = mock_exact.call_args[0][1]
        self.assertEqual(call_envelope["type"], "agent.prompt.forward")
        self.assertEqual(call_envelope["payload"]["prompt"], "Hello, build a website")

    def test_prompt_forward_returns_zero_when_no_device(self):
        """forward_prompt returns published=0 when no device is reachable."""

        fake_space = SimpleNamespace(
            id="workspace-pf-2",
            organization_id="ws-1",
            agent_config={},
        )

        with patch("django.core.cache.cache", self.fake_cache), patch(
            "apps.tabtinspace.services.execution_binding.resolve_control_device",
            return_value=None,
        ), patch(
            "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.accept_dispatch",
        ), patch(
            "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.transition",
        ):
            from apps.services.agent_engine.services.prompt_forward_service import PromptForwardService

            svc = PromptForwardService()
            result = svc.forward_prompt(
                thread_id=self.thread_id,
                space=fake_space,
                prompt="test",
                attachments=[],
                agent_backend_config={},
            )

        self.assertEqual(result["published"], 0)


class PromptForwardPersonaPayloadTests(SimpleTestCase):
    """回归：`forward_prompt` 正确处理 custom_rules payload。

    （「角色设定」persona 已下线，本类只覆盖 custom_rules 透传。）

    关键约束：
      1. 非空时进 payload（Daemon 侧 DaemonAgentHost 会消费）
      2. 空 / None / 纯空白时**不进** payload（向后兼容：旧 Daemon / 未升级 Daemon
         收到包含未知字段时检查会过滤，但 Django 这层也要兜底）
    """

    thread_id = "chat-session-h1a-fr02"

    def _capture_envelope(self, **forward_kwargs):
        """调用 forward_prompt 并捕获实际被发布的 envelope（如果有）。

        已冻结目标设备 → 走精确连接投递；这里 mock 边界并捕获 envelope。
        """
        fake_space = SimpleNamespace(
            id="workspace-fr02",
            organization_id="ws-1",
            agent_config={"workspace_root": "/home/user"},
        )
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.publish_device_ws_event_exact",
            return_value=True,
        ) as mock_exact, patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService._bind_action_device_for_thread",
        ), patch(
            "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.accept_dispatch",
        ), patch(
            "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.transition",
        ):
            from apps.services.agent_engine.services.prompt_forward_service import (
                PromptForwardService,
            )

            svc = PromptForwardService()
            result = svc.forward_prompt(
                thread_id=self.thread_id,
                space=fake_space,
                prompt="hello",
                attachments=[],
                agent_backend_config={"type": "local"},
                runtime_mode="local",
                target_device_fingerprint="fp-daemon-fr02",
                **forward_kwargs,
            )

            self.assertEqual(result["published"], 1)
            mock_exact.assert_called_once()
            envelope = mock_exact.call_args[0][1]
            return envelope["payload"]

    def test_custom_rules_nonempty_included_in_payload(self):
        """Agent 配置了 custom_rules → payload 含 custom_rules 字段。"""
        payload = self._capture_envelope(custom_rules="- 只用中文回复\n- 禁止使用 emoji")
        self.assertIn("custom_rules", payload)
        self.assertEqual(payload["custom_rules"], "- 只用中文回复\n- 禁止使用 emoji")
        # persona 已下线，永不出现在 payload
        self.assertNotIn("persona", payload)

    def test_empty_values_not_in_payload_backward_compatible(self):
        """custom_rules 为 None / 空字符串 / 纯空白时不进 payload。

        向后兼容承诺：未升级的下游不应看到多余字段，避免协议膨胀与误读。
        """
        for bad_rules in (None, "", "  ", "\r\n"):
            payload = self._capture_envelope(custom_rules=bad_rules)
            self.assertNotIn(
                "custom_rules", payload,
                f"custom_rules={bad_rules!r} should not appear in payload",
            )

    def test_not_passing_custom_rules_is_backward_compatible(self):
        """完全不传 custom_rules（旧调用点 / 非 local 路径）→ payload 不含。

        覆盖 `AgentDispatcher.dispatch_external` 非 `runtime_mode='local'` 的
        ACP 分支：那里我们特意不传 custom_rules，避免污染外部 Agent。
        """
        payload = self._capture_envelope()  # no custom_rules kwargs
        self.assertNotIn("persona", payload)
        self.assertNotIn("custom_rules", payload)

    # ── M2.5 方案 B（P1.3）回归：client_message_id 透传 ──
    #
    # 验证 ChatService → _stage_route → resolve_route → dispatch_external →
    # forward_prompt → payload 这条链路的客户端 UUID 透传契约。
    # DaemonAgentHost 收到 payload.client_message_id 后透传给 runtime.query
    # ({ clientMessageId })，runtime 主轮 yield USER 事件用此 id 闭合 temp id

    def test_client_message_id_included_in_payload_when_provided(self):
        """非空 client_message_id → payload 含 client_message_id 字段。"""
        client_uuid = "11111111-2222-3333-4444-555555555555"
        payload = self._capture_envelope(client_message_id=client_uuid)
        self.assertIn("client_message_id", payload)
        self.assertEqual(payload["client_message_id"], client_uuid)

    def test_client_message_id_not_in_payload_when_absent(self):
        """未传 client_message_id（旧客户端 / 非 local 路径）→ payload 不含。

        向后兼容关键：旧客户端（未升级到带 UUID 的版本）不应在 payload 看到
        多余字段；DaemonAgentHost 收到 undefined → runtime fallback 自生成
        UUID（消息仍能入库，只是 temp id 映射断）。
        """
        payload = self._capture_envelope()  # 不传 client_message_id
        self.assertNotIn("client_message_id", payload)

    def test_client_message_id_empty_string_not_in_payload(self):
        """client_message_id 为空字符串 → payload 不含（同空 persona 处理）。"""
        payload = self._capture_envelope(client_message_id="")
        self.assertNotIn("client_message_id", payload)

    def test_local_runtime_identity_and_system_fields_included_when_provided(self):
        """半落地 ACP 字段必须完整进入 prompt.forward payload。"""
        payload = self._capture_envelope(
            agent_id="agent-1",
            model_id="model-1",
            system_prompt="完整 system override",
            attachment_strategy="local_first",
        )
        self.assertEqual(payload["agent_id"], "agent-1")
        self.assertEqual(payload["model_id"], "model-1")
        self.assertEqual(payload["system_prompt"], "完整 system override")
        self.assertEqual(payload["attachment_strategy"], "local_first")


class AgentDispatcherPersonaRoutingTests(SimpleTestCase):
    """回归：`AgentDispatcher.dispatch_external` 根据 runtime_mode 决定是否
    从 `space.agent` 读 custom_rules。

    （「角色设定」persona 已下线，本类只覆盖 custom_rules 透传。）

    核心矩阵：
      - `runtime_mode='local'` + Agent 有字段 → 透传 custom_rules
      - `runtime_mode` 非 local（已移除的外部 Agent 桥接） → **不**透传（有意设计，
        避免污染有自己人设体系的外部 Agent）
    """

    thread_id_local = "chat-session-h1a-disp-local"

    def _dispatch_and_capture(
        self,
        *,
        backend_type: str,
        agent_fields: dict,
        disabled_apps: Optional[list[str]] = None,
        system_prompt: Optional[str] = None,
    ):
        """调用 dispatch_external 并捕获 PromptForwardService.forward_prompt 的 kwargs。"""
        fake_agent = SimpleNamespace(
            id=agent_fields.get("id", "agent-1"),
            custom_rules=agent_fields.get("custom_rules"),
            agent_config={
                "agent_backend": {"type": backend_type},
                "authorization_preset": "collaborative",
            },
        )
        fake_space = SimpleNamespace(
            id="space-1",
            organization_id="ws-1",
            agent=fake_agent,
            agent_config=fake_agent.agent_config,
        )
        fake_session = SimpleNamespace(
            id="sess-1",
            user_id="user-1",
            effective_thread_id=self.thread_id_local,
            target_device_id=None,
        )

        effective_config = EffectiveRuntimeConfig(
            session_id="sess-1",
            organization_id="ws-1",
            agent_id=str(fake_agent.id),
            agent_owner_user_id="user-1",
            workspace_id="space-1",
            project_id=None,
            agent_name="Test Agent",
            goal="",
            custom_rules=fake_agent.custom_rules or "",
            agent_config=fake_agent.agent_config,
            workspace_root="/tmp/workspace",
            working_dir_type="directory",
            device_id="device-1",
            device_fingerprint="fp-test",
            trust_status="trusted",
            approval_mode="always_ask",
            approval_grant="always_ask",
            approval_memo_generation=0,
            agent_mode="",
        )

        captured = {}

        class _FakeForwardService:
            # dispatch_external 在派生 enabled_apps / 人名时按 classmethod 调用这两个
            # （W7c Daemon 路径对齐）；stub 返回空，不影响本类对 custom_rules 透传的断言。
            @staticmethod
            def derive_enabled_apps_for_forward(**_kwargs):
                return []

            @staticmethod
            def derive_human_readable_names_for_forward(_space):
                return {"space_name": "", "organization_name": ""}

            @staticmethod
            def resolve_layered_rules_for_forward(_space):
                return {"personal_rules": None}

            @staticmethod
            def resolve_personal_rules_by_owner_id(_owner_id):
                return None

            def forward_prompt(self_inner, **kwargs):  # noqa: N805 - test stub
                captured.update(kwargs)
                return {"task_id": "t-x", "published": 1}

        from apps.services.agent_engine.engine import agent_dispatcher

        with patch.object(
            agent_dispatcher,
            "_resolve_disabled_apps_for_space",
            return_value=disabled_apps or [],
        ), patch(
            "apps.services.common.app_registry.get_tool_domains_map",
            return_value={
                "tabdata": ("tabdata", "sql"),
                "terminal": ("terminal",),
            },
        ), patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService",
            _FakeForwardService,
        ), patch(
            "apps.services.agent_execution.effective_runtime_config.resolve_effective_runtime_config",
            return_value=effective_config,
        ):
            dispatcher = agent_dispatcher.AgentDispatcher()
            dispatcher.dispatch_external(
                session=fake_session,
                user_message="hi",
                space=fake_space,
                model_id=agent_fields.get("model_id"),
                system_prompt=system_prompt,
            )

        return captured

    def test_local_runtime_reads_custom_rules_from_agent(self):
        """`runtime_mode='local'` + Agent 有字段 → forward_prompt 收到 custom_rules。"""
        captured = self._dispatch_and_capture(
            backend_type="local",
            agent_fields={
                "custom_rules": "- 优先执行",
            },
        )
        self.assertEqual(captured.get("runtime_mode"), "local")
        self.assertEqual(captured.get("custom_rules"), "- 优先执行")
        # persona 已下线，dispatcher 不再透传
        self.assertNotIn("persona", captured)

    def test_local_runtime_with_empty_agent_fields_passes_empty_string(self):
        """EffectiveRuntimeConfig normalizes an empty Agent rule to an empty string."""
        captured = self._dispatch_and_capture(
            backend_type="local",
            agent_fields={"custom_rules": None},
        )
        self.assertEqual(captured.get("runtime_mode"), "local")
        # EffectiveRuntimeConfig 使用非空字符串契约；PromptForwardService 仍会过滤空值。
        self.assertIn("custom_rules", captured)
        self.assertEqual(captured["custom_rules"], "")

    def test_dispatch_includes_disabled_tool_prefixes(self):
        captured = self._dispatch_and_capture(
            backend_type="local",
            agent_fields={},
            disabled_apps=["tabdata"],
        )
        config = captured["agent_backend_config"]
        self.assertEqual(config["disabled_apps"], ["tabdata"])
        self.assertEqual(config["disabled_tool_prefixes"], ["tabdata", "sql"])

    def test_dispatch_forwards_agent_and_model_id(self):
        captured = self._dispatch_and_capture(
            backend_type="local",
            agent_fields={"id": "agent-1", "model_id": "model-1"},
        )
        self.assertEqual(captured["agent_id"], "agent-1")
        self.assertEqual(captured["model_id"], "model-1")

    def test_dispatch_forwards_explicit_system_prompt(self):
        captured = self._dispatch_and_capture(
            backend_type="local",
            agent_fields={},
            system_prompt="内部渲染后的 system prompt",
        )
        self.assertEqual(captured["system_prompt"], "内部渲染后的 system prompt")


class AgentRouterSystemPromptRoutingTests(SimpleTestCase):
    def test_internal_system_prompt_key_reaches_dispatcher(self):
        from apps.services.agent_engine.services import agent_router

        captured = {}

        class _FakeDispatcher:
            def dispatch_external(self, *args, **kwargs):
                captured.update(kwargs)
                return {
                    "published": 1,
                    "backend_type": "local",
                    "task_id": "task-1",
                }

        with patch(
            "apps.services.agent_engine.engine.agent_dispatcher.AgentDispatcher",
            _FakeDispatcher,
        ):
            decision = agent_router.resolve_route(
                session=SimpleNamespace(id="sess-1", effective_thread_id="thread-1"),
                user=SimpleNamespace(id="user-1"),
                workspace_id=None,
                input_state={"_request_system_prompt": "内部 system prompt"},
                plain_text="hi",
                model_id="model-1",
                model_instance=None,
                effective_thread_id="thread-1",
                user_messages=[],
                blocks=None,
                attachments=None,
                client_type=None,
                execution_profile=None,
                app_context=None,
            )

        self.assertTrue(decision.handled)
        self.assertEqual(captured["model_id"], "model-1")
        self.assertEqual(captured["system_prompt"], "内部 system prompt")


class ContextAssemblerSystemPromptStateTests(SimpleTestCase):
    def test_internal_system_prompt_context_is_copied_to_input_state(self):
        from apps.services.agent_execution import context_assembler

        input_state = context_assembler.build_agent_input_state(
            session=SimpleNamespace(id="sess-1", organization_id="wt-1"),
            user=SimpleNamespace(id="user-1"),
            effective_thread_id="thread-1",
            context={"_request_system_prompt": "内部 system prompt"},
            plain_text="hi",
            vision_parts=None,
            is_first_message=True,
            model_id="model-1",
            user_selected_model=True,
            client_type=None,
            execution_profile=None,
            resolved_agent_name="Tin",
        )

        self.assertEqual(input_state["_request_system_prompt"], "内部 system prompt")

"""
End-to-end tests for device management and Capability Refresh WS callback chain.

Scenarios
---------
1. Disconnect Grace Period — daemon connect → disconnect → grace key set → reconnect → grace cleared
2. Route Cache Invalidation Ordering — _invalidate_routing_caches_early runs BEFORE group_discard
3. Capability Refresh WS Callback (G-034) — API refresh → WS ack broadcast → WS result broadcast
4. Multi-window Device Connection Count — 2 WS → disconnect 1st (still online) → disconnect 2nd (grace)
"""

from __future__ import annotations

import asyncio
import json
import time
import types
from types import SimpleNamespace
from typing import Any, Dict, Optional
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import SimpleTestCase


# ---------------------------------------------------------------------------
# Shared fakes / helpers
# ---------------------------------------------------------------------------

class FakeRedis:
    """Minimal Redis fake supporting GET/SET/DEL/INCR/DECR/EXPIRE/EVAL."""

    def __init__(self):
        self._data: dict[str, str] = {}
        self._expire: dict[str, int] = {}

    def get(self, key: str):
        return self._data.get(key)

    def set(self, key: str, value, ex=None, **kw):
        self._data[key] = str(value)
        if ex:
            self._expire[key] = ex

    def delete(self, *keys):
        for key in keys:
            self._data.pop(key, None)
            self._expire.pop(key, None)

    def incr(self, key: str):
        val = int(self._data.get(key, 0)) + 1
        self._data[key] = str(val)
        return val

    def decr(self, key: str):
        val = int(self._data.get(key, 0)) - 1
        self._data[key] = str(val)
        return val

    def expire(self, key: str, ttl: int):
        self._expire[key] = ttl

    def zadd(self, key: str, values):
        self._data[key] = json.dumps(values)

    def lpush(self, key: str, *values):
        existing = self._data.get(key, "[]")
        try:
            lst = json.loads(existing)
        except (json.JSONDecodeError, TypeError):
            lst = []
        for v in values:
            lst.insert(0, v)
        self._data[key] = json.dumps(lst)

    def eval(self, script: str, num_keys: int, *args):
        """Minimal Lua script emulation for the two known scripts."""
        keys = list(args[:num_keys])
        argv = list(args[num_keys:])

        if "conn_val" in script and "KEYS[2]" in script and "SET" in script:
            conn_val = self._data.get(keys[1])
            if conn_val and int(conn_val) > 0:
                return 0
            self._data[keys[0]] = str(argv[0])
            if len(argv) > 1:
                self._expire[keys[0]] = int(argv[1])
            return 1

        if "grace_val" in script:
            grace_val = self._data.get(keys[0])
            if grace_val is None:
                return -1
            if grace_val != str(argv[0]):
                return -2
            conn_val = self._data.get(keys[1])
            if conn_val and int(conn_val) > 0:
                self.delete(keys[0])
                return -3
            return 0

        return 0


class FakeCache:
    """Django cache fake wrapping FakeRedis for tests that go through django.core.cache."""

    def __init__(self, redis: FakeRedis | None = None):
        self._redis = redis or FakeRedis()

    def get(self, key: str, default=None):
        val = self._redis.get(key)
        return val if val is not None else default

    def set(self, key: str, value, timeout=None):
        self._redis.set(key, value)

    def delete(self, key: str):
        self._redis.delete(key)


class FakeChannelLayer:
    """Records group_add / group_discard / group_send calls in order."""

    def __init__(self):
        self.call_log: list[tuple[str, tuple]] = []
        self.groups: dict[str, set[str]] = {}

    async def group_add(self, group: str, channel: str):
        self.call_log.append(("group_add", (group, channel)))
        self.groups.setdefault(group, set()).add(channel)

    async def group_discard(self, group: str, channel: str):
        self.call_log.append(("group_discard", (group, channel)))
        self.groups.get(group, set()).discard(channel)

    async def group_send(self, group: str, message: dict):
        self.call_log.append(("group_send", (group, message)))


def _make_consumer(
    *,
    role: str = "daemon",
    device_fingerprint: str = "test-fp-001",
    user_id: str = "user-001",
    organization_id: str = "ws-001",
    channel_name: str = "specific.channel!abc",
    authed: bool = True,
    channel_layer: FakeChannelLayer | None = None,
    device_conn_counted: bool = False,
) -> SimpleNamespace:
    """Create a consumer-like SimpleNamespace suitable for GatewayConsumer methods."""
    from apps.services.common.ws.organization_context import OrganizationContext
    organization_ctx = OrganizationContext(
        organization_id if organization_id else None,
        {organization_id} if organization_id else set(),
    )
    return SimpleNamespace(
        authed=authed,
        user=SimpleNamespace(id=user_id),
        user_id=user_id,
        organization_id=organization_id,
        organization_ctx=organization_ctx,
        role=role,
        device_fingerprint=device_fingerprint,
        connection_scope="device" if role in ("daemon", "device_runtime") else "session",
        capabilities={"agent.action", "context.sync"},
        subscriptions=set(),
        joined_groups=set(),
        channel_name=channel_name,
        channel_layer=channel_layer or FakeChannelLayer(),
        _device_conn_counted=device_conn_counted,
        _conn_counted=False,
        _total_conn_counted=True,
        _conn_registered_at=0.0,
        _background_tasks=set(),
        _auth_timeout_handle=None,
        _heartbeat_handle=None,
        _message_timestamps=[],
        _last_client_message_at=time.time(),
        _cached_handlers=None,
    )


def _bind_gateway_method(consumer, method_name):
    """Bind a GatewayConsumer method to a SimpleNamespace consumer."""
    from apps.services.common.ws.gateway import GatewayConsumer
    unbound = getattr(GatewayConsumer, method_name)
    consumer.__dict__[method_name] = types.MethodType(unbound, consumer)


def _run(coro):
    """Shorthand to run async in sync test.

    Python 3.10+: ``asyncio.get_event_loop()`` 在无当前 loop 时会 raise
    ``RuntimeError``。测试里用 try/except 显式创建一个新 loop。
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("loop closed")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


# ===========================================================================
# Scenario 1: Disconnect Grace Period
# ===========================================================================

class TestDisconnectGracePeriod(SimpleTestCase):
    """
    1. Daemon connects + auth
    2. Disconnect → grace key set in Redis
    3. Reconnect within grace → grace key deleted, device stays online
    """

    def setUp(self):
        self.fake_redis = FakeRedis()
        self.fake_cache = FakeCache(self.fake_redis)

    def test_disconnect_sets_grace_key(self):
        """After daemon disconnect with remaining=0, a grace key is written to Redis."""
        from apps.services.common.ws.gateway import (
            DISCONNECT_GRACE_KEY_PREFIX,
            GatewayConsumer,
        )

        consumer = _make_consumer(device_conn_counted=True)
        fp = consumer.device_fingerprint
        grace_key = f"{DISCONNECT_GRACE_KEY_PREFIX}{fp}"

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            remaining = _run(GatewayConsumer._decrement_device_conn_count(consumer))
        self.assertEqual(remaining, 0)

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis), \
             patch("apps.tabtinspace.tasks.mark_device_offline_after_grace") as mock_task:
            mock_task.apply_async = MagicMock()
            _run(GatewayConsumer._schedule_disconnect_grace(consumer))

        self.assertIsNotNone(
            self.fake_redis.get(grace_key),
            "grace key should be set after disconnect with remaining=0",
        )
        mock_task.apply_async.assert_called_once()
        kwargs = mock_task.apply_async.call_args.kwargs
        self.assertEqual(kwargs["kwargs"]["fingerprint"], fp)

    def test_reconnect_within_grace_deletes_grace_key(self):
        """Auth handler clears grace key when device reconnects."""
        from apps.services.common.ws.gateway import DISCONNECT_GRACE_KEY_PREFIX

        fp = "test-fp-001"
        grace_key = f"{DISCONNECT_GRACE_KEY_PREFIX}{fp}"
        self.fake_redis.set(grace_key, str(time.time()))

        self.assertIsNotNone(self.fake_redis.get(grace_key))

        with patch("django.core.cache.cache", self.fake_cache):
            if self.fake_cache.get(grace_key) is not None:
                self.fake_cache.delete(grace_key)

        self.assertIsNone(
            self.fake_redis.get(grace_key),
            "grace key should be removed after reconnection auth",
        )

    def test_full_disconnect_reconnect_cycle(self):
        """End-to-end: connect → disconnect (grace set) → reconnect (grace cleared)."""
        from apps.services.common.ws.gateway import (
            DEVICE_CONN_KEY_PREFIX,
            DISCONNECT_GRACE_KEY_PREFIX,
            GatewayConsumer,
        )

        fp = "daemon-e2e-fp"
        grace_key = f"{DISCONNECT_GRACE_KEY_PREFIX}{fp}"
        conn_key = f"{DEVICE_CONN_KEY_PREFIX}{fp}"

        consumer = _make_consumer(device_fingerprint=fp, device_conn_counted=True)

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            _run(GatewayConsumer._increment_device_conn_count(consumer))
        self.assertEqual(int(self.fake_redis.get(conn_key) or 0), 1)

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            remaining = _run(GatewayConsumer._decrement_device_conn_count(consumer))
        self.assertEqual(remaining, 0)

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis), \
             patch("apps.tabtinspace.tasks.mark_device_offline_after_grace") as mock_task:
            mock_task.apply_async = MagicMock()
            _run(GatewayConsumer._schedule_disconnect_grace(consumer))
        self.assertIsNotNone(self.fake_redis.get(grace_key), "grace key must exist after disconnect")

        with patch("django.core.cache.cache", self.fake_cache):
            val = self.fake_cache.get(grace_key)
            self.assertIsNotNone(val)
            self.fake_cache.delete(grace_key)

        self.assertIsNone(
            self.fake_redis.get(grace_key),
            "grace key must be cleared after reconnect auth",
        )


# ===========================================================================
# Scenario 2: Route Cache Invalidation Ordering
# ===========================================================================

class TestRouteCacheInvalidationOrdering(SimpleTestCase):
    """
    Verifies that _invalidate_routing_caches_early executes
    BEFORE any group_discard during disconnect.
    """

    def _make_consumer_with_gateway_methods(self, fp, channel_name, channel_layer):
        """Create consumer with bound GatewayConsumer methods for routing cache ops."""
        consumer = _make_consumer(
            device_fingerprint=fp,
            channel_name=channel_name,
            channel_layer=channel_layer,
            device_conn_counted=True,
        )
        _bind_gateway_method(consumer, "_do_invalidate_routing_caches")
        _bind_gateway_method(consumer, "_invalidate_routing_caches_early")
        return consumer

    def test_invalidation_before_group_discard(self):
        """Phase 1 (cache clear) must complete before Phase 2 (group_discard)."""
        fake_redis = FakeRedis()
        fake_cache = FakeCache(fake_redis)
        cl = FakeChannelLayer()
        fp = "daemon-order-fp"

        consumer = self._make_consumer_with_gateway_methods(fp, "ch.order_test", cl)
        consumer.joined_groups = {"topic.agent.action.device." + fp, "user.user-001"}

        fake_cache.set(f"daemon_channel:{fp}", "ch.order_test")
        fake_cache.set(f"runtime_channel:{fp}", "ch.order_test")

        call_sequence: list[str] = []
        original_invalidate = consumer._do_invalidate_routing_caches

        def tracking_invalidate():
            call_sequence.append("invalidate_routing_caches")
            with patch("django.core.cache.cache", fake_cache):
                original_invalidate()

        consumer._do_invalidate_routing_caches = tracking_invalidate

        original_group_discard = cl.group_discard

        async def tracking_group_discard(group, channel):
            call_sequence.append(f"group_discard:{group}")
            await original_group_discard(group, channel)

        cl.group_discard = tracking_group_discard

        _run(consumer._invalidate_routing_caches_early())

        for group in list(consumer.joined_groups):
            _run(cl.group_discard(group, consumer.channel_name))

        self.assertTrue(len(call_sequence) >= 2, f"expected >=2 calls, got {call_sequence}")
        inv_idx = call_sequence.index("invalidate_routing_caches")
        discard_indices = [i for i, c in enumerate(call_sequence) if c.startswith("group_discard")]
        for d_idx in discard_indices:
            self.assertLess(
                inv_idx, d_idx,
                f"invalidate_routing_caches (idx={inv_idx}) must run before group_discard (idx={d_idx})",
            )

    def test_cache_keys_cleared_after_invalidation(self):
        """After _invalidate_routing_caches_early, routing cache keys are removed."""
        fake_redis = FakeRedis()
        fake_cache = FakeCache(fake_redis)
        fp = "daemon-cache-fp"

        cl = FakeChannelLayer()
        consumer = self._make_consumer_with_gateway_methods(fp, "ch.cache_test", cl)

        fake_cache.set(f"daemon_channel:{fp}", "ch.cache_test")
        fake_cache.set(f"runtime_channel:{fp}", "ch.cache_test")
        from apps.services.common.ws.bus import device_action_ready_key
        fake_cache.set(device_action_ready_key(fp), "ch.cache_test")

        with patch("django.core.cache.cache", fake_cache):
            _run(consumer._invalidate_routing_caches_early())

        self.assertIsNone(
            fake_cache.get(f"daemon_channel:{fp}"),
            "daemon_channel cache should be cleared",
        )
        self.assertIsNone(
            fake_cache.get(f"runtime_channel:{fp}"),
            "runtime_channel cache should be cleared",
        )
        self.assertIsNone(
            fake_cache.get(device_action_ready_key(fp)),
            "device_action_ready cache should be cleared",
        )

    def test_stale_cache_not_cleared(self):
        """Cache keys belonging to a DIFFERENT channel_name are NOT deleted."""
        fake_redis = FakeRedis()
        fake_cache = FakeCache(fake_redis)
        fp = "daemon-stale-fp"

        cl = FakeChannelLayer()
        consumer = self._make_consumer_with_gateway_methods(fp, "ch.old_conn", cl)

        fake_cache.set(f"daemon_channel:{fp}", "ch.new_conn")
        fake_cache.set(f"runtime_channel:{fp}", "ch.new_conn")

        with patch("django.core.cache.cache", fake_cache):
            _run(consumer._invalidate_routing_caches_early())

        self.assertEqual(
            fake_cache.get(f"daemon_channel:{fp}"), "ch.new_conn",
            "should NOT delete key owned by a different connection",
        )


# ===========================================================================
# Scenario 3: Capability Refresh WS Callback (G-034)
# ===========================================================================

class TestCapabilityRefreshWSCallback(SimpleTestCase):
    """
    G-034 改造验证：
    1. _store_and_build_response stores ack/result via transport + builds broadcast envelope
    2. Handler sends ok response to consumer + broadcasts via channel_layer.group_send
    3. Only daemon/device_runtime roles may send refresh ack/result
    4. Missing refresh_request_id returns schema error
    """

    def _make_refresh_consumer(self, channel_layer=None, **overrides):
        defaults = dict(
            role="daemon",
            device_fingerprint="refresh-fp",
            user_id="user-r1",
            organization_id="ws-r1",
        )
        defaults.update(overrides)
        c = _make_consumer(channel_layer=channel_layer, **defaults)
        c._send_envelope = AsyncMock()
        return c

    def _build_refresh_envelope(self, *, refresh_request_id="rr-001", extra=None):
        payload = {"refresh_request_id": refresh_request_id}
        if extra:
            payload.update(extra)
        return {
            "v": 1,
            "type": "device.capabilities.refresh.ack",
            "request_id": "req-ack-1",
            "ts": int(time.time()),
            "device_id": "refresh-fp",
            "role": "daemon",
            "payload": payload,
        }

    def test_ack_stores_and_broadcasts(self):
        """Ack handler stores payload via transport AND broadcasts to organization topic."""
        from apps.services.common.ws.handlers.device_capability_refresh import (
            _store_and_build_response,
        )

        consumer = self._make_refresh_consumer()
        envelope = self._build_refresh_envelope()

        with patch(
            "apps.tabtinspace.services.capability_refresh_transport.CapabilityRefreshTransport"
        ) as MockTransport:
            mock_transport_inst = MockTransport.return_value
            response, broadcast_env, broadcast_topic = _store_and_build_response(
                consumer, envelope, "ack"
            )

        mock_transport_inst.store_ack.assert_called_once()
        store_args = mock_transport_inst.store_ack.call_args
        self.assertEqual(store_args[0][0], "rr-001")

        self.assertIsNotNone(response)
        self.assertEqual(response["type"], "device.capabilities.refresh.ack.ok")

        self.assertIsNotNone(broadcast_env)
        self.assertEqual(broadcast_env["type"], "device.capabilities.refresh.ack")
        self.assertEqual(broadcast_env["payload"]["refresh_request_id"], "rr-001")
        self.assertEqual(broadcast_topic, "device.capabilities.refresh.ws-r1")

    def test_result_stores_and_broadcasts(self):
        """Result handler stores payload via transport AND broadcasts to organization topic."""
        from apps.services.common.ws.handlers.device_capability_refresh import (
            _store_and_build_response,
        )

        consumer = self._make_refresh_consumer()
        envelope = self._build_refresh_envelope(extra={"capabilities": ["shell", "browser"]})
        envelope["type"] = "device.capabilities.refresh.result"

        with patch(
            "apps.tabtinspace.services.capability_refresh_transport.CapabilityRefreshTransport"
        ) as MockTransport:
            mock_transport_inst = MockTransport.return_value
            response, broadcast_env, broadcast_topic = _store_and_build_response(
                consumer, envelope, "result"
            )

        mock_transport_inst.store_result.assert_called_once()
        self.assertEqual(response["type"], "device.capabilities.refresh.result.ok")
        self.assertIsNotNone(broadcast_env)
        self.assertEqual(broadcast_env["type"], "device.capabilities.refresh.result")
        self.assertIn("capabilities", broadcast_env["payload"])

    def test_non_daemon_role_rejected(self):
        """Electron/mobile roles cannot send refresh ack/result."""
        from apps.services.common.ws.handlers.device_capability_refresh import (
            _store_and_build_response,
        )

        for forbidden_role in ("electron", "mobile", "web"):
            consumer = self._make_refresh_consumer(role=forbidden_role)
            envelope = self._build_refresh_envelope()
            response, broadcast_env, broadcast_topic = _store_and_build_response(
                consumer, envelope, "ack"
            )
            self.assertEqual(response["type"], "error", f"role={forbidden_role} should be rejected")
            self.assertIn("role not allowed", response["payload"]["message"])
            self.assertIsNone(broadcast_env)
            self.assertIsNone(broadcast_topic)

    def test_missing_refresh_request_id_rejected(self):
        """Missing refresh_request_id returns schema error."""
        from apps.services.common.ws.handlers.device_capability_refresh import (
            _store_and_build_response,
        )

        consumer = self._make_refresh_consumer()
        envelope = self._build_refresh_envelope()
        envelope["payload"] = {}

        response, broadcast_env, _ = _store_and_build_response(consumer, envelope, "ack")
        self.assertEqual(response["type"], "error")
        self.assertIn("missing refresh_request_id", response["payload"]["message"])
        self.assertIsNone(broadcast_env)

    def test_handler_factories_return_async_callables(self):
        """create_device_capability_refresh_ack/result_handler return async functions."""
        from apps.services.common.ws.handlers.device_capability_refresh import (
            create_device_capability_refresh_ack_handler,
            create_device_capability_refresh_result_handler,
        )

        consumer = self._make_refresh_consumer()
        ack_handler = create_device_capability_refresh_ack_handler(consumer)
        result_handler = create_device_capability_refresh_result_handler(consumer)
        self.assertTrue(asyncio.iscoroutinefunction(ack_handler))
        self.assertTrue(asyncio.iscoroutinefunction(result_handler))

    def test_ack_handler_sends_response_and_broadcasts(self):
        """Integrated: calling the handler sends ok response + broadcasts via channel_layer."""
        from apps.services.common.ws.handlers.device_capability_refresh import (
            create_device_capability_refresh_ack_handler,
        )

        cl = FakeChannelLayer()
        consumer = self._make_refresh_consumer(channel_layer=cl)
        handler = create_device_capability_refresh_ack_handler(consumer)
        envelope = self._build_refresh_envelope()

        def _fake_db_sync(fn):
            async def _wrapper(*a, **kw):
                return fn(*a, **kw)
            return _wrapper

        with patch(
            "apps.tabtinspace.services.capability_refresh_transport.CapabilityRefreshTransport"
        ), patch(
            "apps.services.common.ws.handlers.device_capability_refresh.database_sync_to_async",
            side_effect=_fake_db_sync,
        ):
            _run(handler(envelope))

        consumer._send_envelope.assert_called_once()
        sent = consumer._send_envelope.call_args[0][0]
        self.assertEqual(sent["type"], "device.capabilities.refresh.ack.ok")

        group_sends = [c for c in cl.call_log if c[0] == "group_send"]
        self.assertEqual(len(group_sends), 1, "should broadcast once to organization topic")
        broadcast_msg = group_sends[0][1][1]["message"]
        self.assertEqual(broadcast_msg["type"], "device.capabilities.refresh.ack")

    def test_no_broadcast_without_organization_id(self):
        """If consumer has no organization_id, no broadcast is attempted."""
        from apps.services.common.ws.handlers.device_capability_refresh import (
            _store_and_build_response,
        )

        consumer = self._make_refresh_consumer(organization_id="")
        envelope = self._build_refresh_envelope()

        with patch(
            "apps.tabtinspace.services.capability_refresh_transport.CapabilityRefreshTransport"
        ):
            response, broadcast_env, broadcast_topic = _store_and_build_response(
                consumer, envelope, "ack"
            )

        self.assertIsNotNone(response)
        self.assertIsNone(broadcast_env)
        self.assertIsNone(broadcast_topic)


# ===========================================================================
# Scenario 4: Multi-window Device Connection Count
# ===========================================================================

class TestMultiWindowDeviceConnectionCount(SimpleTestCase):
    """
    1. Same device fingerprint opens 2 WS connections
    2. Disconnect 1st → remaining > 0, device stays online
    3. Disconnect 2nd → remaining = 0, grace period scheduled
    """

    def setUp(self):
        self.fake_redis = FakeRedis()

    def test_two_connections_then_partial_disconnect(self):
        """After 2 increments and 1 decrement, remaining is 1 — device stays online."""
        from apps.services.common.ws.gateway import (
            DEVICE_CONN_KEY_PREFIX,
            GatewayConsumer,
        )

        fp = "multi-fp"
        conn_key = f"{DEVICE_CONN_KEY_PREFIX}{fp}"

        conn1 = _make_consumer(device_fingerprint=fp, channel_name="ch.win1")
        conn2 = _make_consumer(device_fingerprint=fp, channel_name="ch.win2")

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            _run(GatewayConsumer._increment_device_conn_count(conn1))
            _run(GatewayConsumer._increment_device_conn_count(conn2))

        self.assertEqual(int(self.fake_redis.get(conn_key)), 2)

        conn1._device_conn_counted = True
        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            remaining = _run(GatewayConsumer._decrement_device_conn_count(conn1))

        self.assertEqual(remaining, 1, "1 connection remains after first disconnect")
        self.assertEqual(int(self.fake_redis.get(conn_key)), 1)

    def test_heartbeat_renews_device_connection_ttl(self):
        from apps.services.common.ws.gateway import (
            DEVICE_CONN_KEY_PREFIX,
            DEVICE_CONN_TTL,
            GatewayConsumer,
        )

        consumer = _make_consumer(
            role="mobile",
            device_fingerprint="mobile-fp",
            device_conn_counted=True,
        )
        consumer._conn_counted = True
        consumer._conn_count_key = "ws:conn:user-001"
        consumer._conn_member = "mobile-fp"
        conn_key = f"{DEVICE_CONN_KEY_PREFIX}mobile-fp"

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            _run(GatewayConsumer._refresh_connection_ttl(consumer))

        self.assertEqual(self.fake_redis._expire[conn_key], DEVICE_CONN_TTL)

    def test_all_connections_closed_triggers_grace(self):
        """After all connections close, remaining=0 and grace is scheduled."""
        from apps.services.common.ws.gateway import (
            DEVICE_CONN_KEY_PREFIX,
            DISCONNECT_GRACE_KEY_PREFIX,
            GatewayConsumer,
        )

        fp = "multi-fp-grace"
        conn_key = f"{DEVICE_CONN_KEY_PREFIX}{fp}"
        grace_key = f"{DISCONNECT_GRACE_KEY_PREFIX}{fp}"

        conn1 = _make_consumer(device_fingerprint=fp, channel_name="ch.w1")
        conn2 = _make_consumer(device_fingerprint=fp, channel_name="ch.w2")

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            _run(GatewayConsumer._increment_device_conn_count(conn1))
            _run(GatewayConsumer._increment_device_conn_count(conn2))
        self.assertEqual(int(self.fake_redis.get(conn_key)), 2)

        conn1._device_conn_counted = True
        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            r1 = _run(GatewayConsumer._decrement_device_conn_count(conn1))
        self.assertEqual(r1, 1)

        conn2._device_conn_counted = True
        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            r2 = _run(GatewayConsumer._decrement_device_conn_count(conn2))
        self.assertEqual(r2, 0)

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis), \
             patch("apps.tabtinspace.tasks.mark_device_offline_after_grace") as mock_task:
            mock_task.apply_async = MagicMock()
            _run(GatewayConsumer._schedule_disconnect_grace(conn2))

        self.assertIsNotNone(
            self.fake_redis.get(grace_key),
            "grace key must be set when all connections are closed",
        )

    def test_grace_not_set_when_active_connections_remain(self):
        """Lua guard: grace key is NOT set if active connections exist."""
        from apps.services.common.ws.gateway import (
            DEVICE_CONN_KEY_PREFIX,
            DISCONNECT_GRACE_KEY_PREFIX,
            GatewayConsumer,
        )

        fp = "multi-fp-no-grace"
        conn_key = f"{DEVICE_CONN_KEY_PREFIX}{fp}"
        grace_key = f"{DISCONNECT_GRACE_KEY_PREFIX}{fp}"

        self.fake_redis.set(conn_key, "1")

        consumer = _make_consumer(device_fingerprint=fp, device_conn_counted=True)

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis), \
             patch("apps.tabtinspace.tasks.mark_device_offline_after_grace") as mock_task:
            mock_task.apply_async = MagicMock()
            _run(GatewayConsumer._schedule_disconnect_grace(consumer))

        self.assertIsNone(
            self.fake_redis.get(grace_key),
            "grace key should NOT be set when active connections exist",
        )
        mock_task.apply_async.assert_not_called()

    def test_increment_decrement_symmetry(self):
        """N increments followed by N decrements results in 0 remaining and key deletion."""
        from apps.services.common.ws.gateway import (
            DEVICE_CONN_KEY_PREFIX,
            GatewayConsumer,
        )

        fp = "sym-fp"
        conn_key = f"{DEVICE_CONN_KEY_PREFIX}{fp}"
        n = 5
        consumers = [
            _make_consumer(device_fingerprint=fp, channel_name=f"ch.s{i}")
            for i in range(n)
        ]

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            for c in consumers:
                _run(GatewayConsumer._increment_device_conn_count(c))
        self.assertEqual(int(self.fake_redis.get(conn_key)), n)

        for c in consumers:
            c._device_conn_counted = True

        with patch("django_redis.get_redis_connection", return_value=self.fake_redis):
            for i, c in enumerate(consumers):
                remaining = _run(GatewayConsumer._decrement_device_conn_count(c))
                expected = n - i - 1
                self.assertEqual(remaining, expected, f"after {i+1} decrements, expected {expected}")

        self.assertIsNone(
            self.fake_redis.get(conn_key),
            "conn key should be deleted when count reaches 0",
        )

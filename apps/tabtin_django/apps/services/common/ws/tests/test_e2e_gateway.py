"""
WS Gateway 端到端集成测试。

使用 channels.testing.WebsocketCommunicator 对 GatewayConsumer 进行全生命周期、
认证失败/超时、速率限制、RLS 过滤四大场景的端到端验证。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from collections import deque
from contextlib import ExitStack
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

django.setup()

import pytest
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator

from apps.services.common.ws.gateway import GatewayConsumer
from apps.services.common.ws.protocol import (
    CHANNEL_SAFE_PATTERN,
    ERROR_AUTH_INVALID,
    ERROR_AUTH_REQUIRED,
    ERROR_RATE_LIMITED,
    ERROR_SCHEMA_INVALID,
    ERROR_TYPE_UNKNOWN,
    PROTOCOL_VERSION,
    build_envelope,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TEST_USER_ID = str(uuid.uuid4())
_TEST_WORKSPACE_ID = str(uuid.uuid4())
_DEVICE_FP = f"test-device-{uuid.uuid4().hex[:8]}"


def _ts() -> int:
    return int(time.time())


def _make_envelope(
    msg_type: str,
    payload: Dict[str, Any] | None = None,
    *,
    request_id: str | None = None,
    role: str = "electron",
    device_id: str = _DEVICE_FP,
) -> str:
    return json.dumps({
        "v": PROTOCOL_VERSION,
        "type": msg_type,
        "request_id": request_id or f"req_{uuid.uuid4().hex[:8]}",
        "ts": _ts(),
        "device_id": device_id,
        "role": role,
        "payload": payload or {},
    })


def _make_auth_envelope(
    token: str = "mock-jwt-token",
    organization_id: str = _TEST_WORKSPACE_ID,
    role: str = "electron",
    capabilities: list[str] | None = None,
) -> str:
    return _make_envelope(
        "auth",
        {
            "access_token": token,
            "organization_id": organization_id,
            "capabilities": capabilities or [
                "context.sync", "agent.stream", "agent.action",
                "table.events", "table.open", "notifications",
            ],
        },
        role=role,
        request_id="auth_req_1",
    )


class _FakeUser:
    """Minimal user stub satisfying auth handler lookups."""

    def __init__(self, user_id: str = _TEST_USER_ID):
        self.id = user_id
        self.pk = user_id
        self.is_superuser = False
        self.is_active = True
        self.is_staff = False

    class DoesNotExist(Exception):
        pass


def _jwt_payload(user_id: str = _TEST_USER_ID) -> dict:
    return {
        "user_id": user_id,
        "token_type": "access",
        "exp": int(time.time()) + 3600,
        "iat": int(time.time()),
    }


def _passthrough_db_sync(fn):
    """If fn is already a coroutine function, return as-is; else wrap."""
    if asyncio.iscoroutinefunction(fn):
        return fn

    async def _wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    return _wrapper


def _patch_auth(*, invalid_jwt: bool = False) -> ExitStack:
    """Return a contextmanager stack that mocks JWT + DB lookups in the auth handler.

    Args:
        invalid_jwt: If True, JWT verification returns "invalid" error.
    """
    stack = ExitStack()

    if invalid_jwt:
        stack.enter_context(patch(
            "apps.services.common.ws.handlers.auth._verify_jwt_for_ws",
            side_effect=lambda token: (None, "invalid"),
        ))
    else:
        stack.enter_context(patch(
            "apps.services.common.ws.handlers.auth._verify_jwt_for_ws",
            side_effect=lambda token: (_jwt_payload(), None),
        ))

    fake_user = _FakeUser()

    async def _async_get_user(**kwargs):
        return fake_user

    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth.User",
        MagicMock(
            objects=MagicMock(get=_async_get_user),
            DoesNotExist=Exception,
        ),
    ))

    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth.OrganizationService",
        lambda user: MagicMock(check_organization_permission=MagicMock(return_value=True)),
    ))

    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth.database_sync_to_async",
        side_effect=_passthrough_db_sync,
    ))

    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth._update_device_status",
        new_callable=AsyncMock,
    ))

    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth._invalidate_daemon_fp_cache_for_device",
        MagicMock(),
    ))

    stack.enter_context(patch.object(
        GatewayConsumer, "_increment_connection_count",
        new_callable=AsyncMock, return_value=True,
    ))
    stack.enter_context(patch.object(
        GatewayConsumer, "_increment_device_conn_count",
        new_callable=AsyncMock,
    ))

    stack.enter_context(patch.object(
        GatewayConsumer, "_start_heartbeat",
        new_callable=AsyncMock,
    ))

    stack.enter_context(patch.object(
        GatewayConsumer, "_extend_auth_handler",
        MagicMock(),
    ))
    stack.enter_context(patch.object(
        GatewayConsumer, "_auto_join_update_group",
        new_callable=AsyncMock,
    ))

    return stack


# ---- Instance capture for accessing consumer internals in tests ----

_captured_consumers: dict[int, GatewayConsumer] = {}
_original_gw_init = GatewayConsumer.__init__


def _capturing_init(self, *args, **kwargs):
    _original_gw_init(self, *args, **kwargs)
    _captured_consumers[id(self)] = self


async def _create_authed_communicator() -> tuple[WebsocketCommunicator, GatewayConsumer]:
    """Create a communicator, connect, authenticate, and return (communicator, consumer_instance)."""
    _captured_consumers.clear()
    with patch.object(GatewayConsumer, "__init__", _capturing_init):
        communicator = WebsocketCommunicator(GatewayConsumer.as_asgi(), "/ws/v1/gateway")
        connected, _ = await communicator.connect()
        assert connected, "WS connection failed"

    consumer_instance = list(_captured_consumers.values())[-1]

    await communicator.send_to(text_data=_make_auth_envelope())
    resp = await communicator.receive_from(timeout=5)
    data = json.loads(resp)
    assert data["type"] == "auth.ok", f"Expected auth.ok, got {data}"
    return communicator, consumer_instance


def _fill_rate_limit_window(consumer: GatewayConsumer, count: int = 100) -> None:
    """Fill the consumer's rate limit deque to simulate having sent *count* messages."""
    now = time.monotonic()
    consumer._message_timestamps = deque([now] * count)


# ===========================================================================
# 场景 1: Gateway 连接全生命周期
# ===========================================================================

@pytest.mark.asyncio
async def test_full_lifecycle():
    """场景 1: connect → auth → subscribe → bus publish → ping/pong → disconnect."""
    with _patch_auth():
        communicator = WebsocketCommunicator(GatewayConsumer.as_asgi(), "/ws/v1/gateway")

        # 1) 建立连接
        connected, _ = await communicator.connect()
        assert connected

        # 2) 发送 auth → 收到 auth.ok
        await communicator.send_to(text_data=_make_auth_envelope())
        resp = await communicator.receive_from(timeout=5)
        auth_resp = json.loads(resp)
        assert auth_resp["type"] == "auth.ok"
        assert auth_resp["payload"]["user_id"] == _TEST_USER_ID
        assert auth_resp["payload"]["organization_id"] == _TEST_WORKSPACE_ID
        assert auth_resp["payload"]["transport_capabilities"] == ["frame_fragment.v1.c2s"]

        # 3) subscribe → subscribe.ok
        topic = f"notifications.{_TEST_USER_ID}"
        sub_env = _make_envelope("subscribe", {
            "topics": [topic],
        })
        await communicator.send_to(text_data=sub_env)
        resp = await communicator.receive_from(timeout=5)
        sub_resp = json.loads(resp)
        assert sub_resp["type"] == "subscribe.ok"
        assert topic in sub_resp["payload"]["topics"]

        # 4) 通过 bus publish 一条消息 → WS 收到
        test_event = build_envelope(
            "notifications.new",
            f"evt_{uuid.uuid4().hex[:8]}",
            {"title": "Hello from bus"},
        )
        channel_layer = get_channel_layer()
        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"topic.{topic}")
        await channel_layer.group_send(group_name, {
            "type": "broadcast_message",
            "message": test_event,
        })
        resp = await communicator.receive_from(timeout=5)
        bus_msg = json.loads(resp)
        assert bus_msg["type"] == "notifications.new"
        assert bus_msg["payload"]["title"] == "Hello from bus"

        # 5) ping → pong
        ping_env = _make_envelope("ping", {}, request_id="ping_1")
        await communicator.send_to(text_data=ping_env)
        resp = await communicator.receive_from(timeout=5)
        pong_resp = json.loads(resp)
        assert pong_resp["type"] == "pong"
        assert pong_resp["request_id"] == "ping_1"

        # 6) 断开连接 → 验证 cleanup
        initial_total = GatewayConsumer._total_connections
        await communicator.disconnect()
        assert GatewayConsumer._total_connections <= initial_total


# ===========================================================================
# 场景 2: 认证失败与超时
# ===========================================================================

@pytest.mark.asyncio
async def test_unauthenticated_message_gets_auth_required():
    """场景 2.1: 未认证时发送非 auth 消息 → auth_required 错误。"""
    with _patch_auth():
        communicator = WebsocketCommunicator(GatewayConsumer.as_asgi(), "/ws/v1/gateway")
        connected, _ = await communicator.connect()
        assert connected

        msg = _make_envelope("subscribe", {"topics": ["notifications.abc"]})
        await communicator.send_to(text_data=msg)
        resp = await communicator.receive_from(timeout=5)
        data = json.loads(resp)
        assert data["type"] == "error"
        assert data["payload"]["code"] == ERROR_AUTH_REQUIRED

        await communicator.disconnect()


@pytest.mark.asyncio
async def test_invalid_jwt_gets_auth_invalid():
    """场景 2.2: 发送无效 JWT → auth_invalid 错误。"""
    with _patch_auth(invalid_jwt=True):
        communicator = WebsocketCommunicator(GatewayConsumer.as_asgi(), "/ws/v1/gateway")
        connected, _ = await communicator.connect()
        assert connected

        await communicator.send_to(text_data=_make_auth_envelope(token="bad-token"))
        resp = await communicator.receive_from(timeout=5)
        data = json.loads(resp)
        assert data["type"] == "error"
        assert data["payload"]["code"] == ERROR_AUTH_INVALID

        await communicator.disconnect()


@pytest.mark.asyncio
async def test_auth_timeout_disconnects():
    """场景 2.3: 连接后不发 auth → 超时后被断开 (code=4001)。"""
    from apps.services.common.ws import gateway as gw_mod

    original_timeout = gw_mod.AUTH_TIMEOUT_SECONDS
    gw_mod.AUTH_TIMEOUT_SECONDS = 0.3

    try:
        communicator = WebsocketCommunicator(GatewayConsumer.as_asgi(), "/ws/v1/gateway")
        connected, _ = await communicator.connect()
        assert connected

        await asyncio.sleep(0.8)

        # 超时后应收到 auth_required 错误
        resp = await communicator.receive_from(timeout=2)
        data = json.loads(resp)
        assert data["type"] == "error"
        assert data["payload"]["code"] == ERROR_AUTH_REQUIRED

        # 验证连接已关闭 (code=4001)
        output = await communicator.receive_output(timeout=2)
        assert output["type"] == "websocket.close"
        assert output.get("code") == 4001

    finally:
        gw_mod.AUTH_TIMEOUT_SECONDS = original_timeout


# ===========================================================================
# 场景 2 补充: Envelope 校验
# ===========================================================================

@pytest.mark.asyncio
async def test_invalid_json_gets_schema_invalid():
    """发送非 JSON 文本 → schema_invalid 错误。"""
    with _patch_auth():
        communicator = WebsocketCommunicator(GatewayConsumer.as_asgi(), "/ws/v1/gateway")
        connected, _ = await communicator.connect()
        assert connected

        await communicator.send_to(text_data="not valid json {{{{")
        resp = await communicator.receive_from(timeout=5)
        data = json.loads(resp)
        assert data["type"] == "error"
        assert data["payload"]["code"] == ERROR_SCHEMA_INVALID

        await communicator.disconnect()


@pytest.mark.asyncio
async def test_unknown_type_gets_type_unknown():
    """认证后发送未知消息类型 → type_unknown 错误。"""
    with _patch_auth():
        communicator, _ = await _create_authed_communicator()

        msg = _make_envelope("totally.unknown.type", {}, request_id="unk_1")
        await communicator.send_to(text_data=msg)
        resp = await communicator.receive_from(timeout=5)
        data = json.loads(resp)
        assert data["type"] == "error"
        assert data["payload"]["code"] == ERROR_TYPE_UNKNOWN

        await communicator.disconnect()


# ===========================================================================
# 场景 3: 速率限制
# ===========================================================================

@pytest.mark.asyncio
async def test_rate_limit_triggers():
    """场景 3.1: 认证后速率窗口已满 → 非豁免消息被限流。"""
    with _patch_auth():
        communicator, consumer = await _create_authed_communicator()

        _fill_rate_limit_window(consumer)

        msg = _make_envelope("subscribe", {"topics": [f"notifications.{_TEST_USER_ID}"]}, request_id="rl_test")
        await communicator.send_to(text_data=msg)
        resp = await communicator.receive_from(timeout=5)
        data = json.loads(resp)
        assert data["type"] == "error"
        assert data["payload"]["code"] == ERROR_RATE_LIMITED

        await communicator.disconnect()


@pytest.mark.asyncio
async def test_ping_exempt_from_rate_limit():
    """场景 3.2: ping 不受速率限制影响。"""
    with _patch_auth():
        communicator, consumer = await _create_authed_communicator()

        _fill_rate_limit_window(consumer)

        # 非豁免消息被限流（验证限流生效）
        msg = _make_envelope("subscribe", {"topics": [f"notifications.{_TEST_USER_ID}"]}, request_id="should_limit")
        await communicator.send_to(text_data=msg)
        resp = await communicator.receive_from(timeout=5)
        data = json.loads(resp)
        assert data["type"] == "error"
        assert data["payload"]["code"] == ERROR_RATE_LIMITED

        # ping 应该不受限制
        ping_env = _make_envelope("ping", {}, request_id="ping_after_limit")
        await communicator.send_to(text_data=ping_env)
        resp = await communicator.receive_from(timeout=5)
        data = json.loads(resp)
        assert data["type"] == "pong", f"Expected pong, got {data['type']}"
        assert data["request_id"] == "ping_after_limit"

        await communicator.disconnect()


# ===========================================================================
# 场景 4: RLS 过滤端到端
# ===========================================================================

@pytest.mark.asyncio
async def test_rls_filter_e2e():
    """场景 4: subscribe table.open → set RLS → publish records → only authorized pass."""
    table_id = str(uuid.uuid4())
    topic = f"table.open.{table_id}"

    with _patch_auth() as stack:
        stack.enter_context(patch.object(
            GatewayConsumer, "_check_table_organization",
            new_callable=AsyncMock, return_value=True,
        ))

        communicator, consumer = await _create_authed_communicator()

        rls_policies = [{
            "id": "policy-1",
            "condition": {
                "conjunction": "and",
                "filterSet": [
                    {"field": "owner", "operator": "equals", "value": _TEST_USER_ID}
                ],
            },
            "_resolved_condition": {
                "conjunction": "and",
                "filterSet": [
                    {"field": "owner", "operator": "equals", "value": _TEST_USER_ID}
                ],
            },
        }]

        sub_env = _make_envelope("subscribe", {
            "topics": [topic],
            "rls": True,
        })
        await communicator.send_to(text_data=sub_env)
        resp = await communicator.receive_from(timeout=5)
        sub_resp = json.loads(resp)
        assert sub_resp["type"] == "subscribe.ok"

        # Inject RLS policies (normally set by on_subscribed via DB — bypassed in test)
        if not hasattr(consumer, '_open_table_subscriptions'):
            consumer._open_table_subscriptions = {}
        consumer._open_table_subscriptions[topic] = {
            'table_id': table_id,
            'rls_policies': rls_policies,
        }

        authorized_record = {
            "id": "rec-1",
            "fields": {"owner": _TEST_USER_ID, "name": "Authorized"},
        }
        unauthorized_record = {
            "id": "rec-2",
            "fields": {"owner": "other-user-id", "name": "Unauthorized"},
        }

        event = build_envelope(
            "table.open.record_change",
            f"evt_{uuid.uuid4().hex[:8]}",
            {
                "table_id": table_id,
                "event": "UPDATE",
                "records": [authorized_record, unauthorized_record],
            },
            table_id=table_id,
        )

        channel_layer = get_channel_layer()
        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"topic.{topic}")
        await channel_layer.group_send(group_name, {
            "type": "broadcast_message",
            "message": event,
        })

        resp = await communicator.receive_from(timeout=5)
        data = json.loads(resp)

        assert data["type"] == "table.open.record_change"
        records = data["payload"]["records"]
        assert len(records) == 1, f"Expected 1 record after RLS filter, got {len(records)}"
        assert records[0]["id"] == "rec-1"
        assert records[0]["fields"]["name"] == "Authorized"

        await communicator.disconnect()


@pytest.mark.asyncio
async def test_rls_filter_all_blocked_suppresses_event():
    """场景 4 补充: 所有记录都被 RLS 过滤时，事件被完全抑制。"""
    table_id = str(uuid.uuid4())
    topic = f"table.open.{table_id}"

    with _patch_auth() as stack:
        stack.enter_context(patch.object(
            GatewayConsumer, "_check_table_organization",
            new_callable=AsyncMock, return_value=True,
        ))

        communicator, consumer = await _create_authed_communicator()

        rls_policies = [{
            "id": "policy-strict",
            "condition": {
                "conjunction": "and",
                "filterSet": [
                    {"field": "owner", "operator": "equals", "value": "nobody-matches"}
                ],
            },
            "_resolved_condition": {
                "conjunction": "and",
                "filterSet": [
                    {"field": "owner", "operator": "equals", "value": "nobody-matches"}
                ],
            },
        }]

        sub_env = _make_envelope("subscribe", {"topics": [topic], "rls": True})
        await communicator.send_to(text_data=sub_env)
        resp = await communicator.receive_from(timeout=5)
        assert json.loads(resp)["type"] == "subscribe.ok"

        if not hasattr(consumer, '_open_table_subscriptions'):
            consumer._open_table_subscriptions = {}
        consumer._open_table_subscriptions[topic] = {
            'table_id': table_id,
            'rls_policies': rls_policies,
        }

        event = build_envelope(
            "table.open.record_change",
            f"evt_{uuid.uuid4().hex[:8]}",
            {
                "table_id": table_id,
                "event": "UPDATE",
                "records": [{"id": "rec-1", "fields": {"owner": "user-A"}}],
            },
            table_id=table_id,
        )

        channel_layer = get_channel_layer()
        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"topic.{topic}")
        await channel_layer.group_send(group_name, {
            "type": "broadcast_message",
            "message": event,
        })

        # Event should be suppressed — nothing to receive
        with pytest.raises(asyncio.TimeoutError):
            await communicator.receive_from(timeout=1)

        # receive_from timeout may cancel the internal ASGI application future
        try:
            await communicator.disconnect()
        except asyncio.CancelledError:
            pass

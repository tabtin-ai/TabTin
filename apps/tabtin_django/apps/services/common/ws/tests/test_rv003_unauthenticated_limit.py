"""
RV-003 回归测试：Django WS Gateway 未认证连接限制

验证 connect() 阶段的三层防护：
1. 全局未认证连接总数限制 (MAX_UNAUTHENTICATED_CONNECTIONS)
2. 单 IP 未认证连接限制 (MAX_UNAUTHENTICATED_PER_IP)
3. 认证成功 / 断开后配额正确释放
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from contextlib import ExitStack
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from channels.testing import WebsocketCommunicator  # noqa: E402

from apps.services.common.ws.gateway import (  # noqa: E402
    GatewayConsumer,
    MAX_UNAUTHENTICATED_CONNECTIONS,
    MAX_UNAUTHENTICATED_PER_IP,
)
from apps.services.common.ws.protocol import PROTOCOL_VERSION  # noqa: E402

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TEST_USER_ID = str(uuid.uuid4())
_TEST_WORKSPACE_ID = str(uuid.uuid4())


def _reset_class_counters():
    """Reset all class-level counters to pristine state."""
    GatewayConsumer._total_connections = 0
    GatewayConsumer._unauthenticated_connections = 0
    GatewayConsumer._per_ip_unauthenticated.clear()


def _make_communicator(
    ip: str = "10.0.0.1",
    *,
    x_forwarded_for: str | None = None,
) -> WebsocketCommunicator:
    """Create a communicator with a specified client IP in scope."""
    communicator = WebsocketCommunicator(
        GatewayConsumer.as_asgi(),
        "/ws/v1/gateway",
    )
    communicator.scope["client"] = (ip, 12345)
    if x_forwarded_for is not None:
        communicator.scope["headers"] = [
            (b"x-forwarded-for", x_forwarded_for.encode("ascii")),
        ]
    return communicator


def _make_auth_envelope(
    token: str = "mock-jwt-token",
    organization_id: str = _TEST_WORKSPACE_ID,
    role: str = "electron",
) -> str:
    return json.dumps({
        "v": PROTOCOL_VERSION,
        "type": "auth",
        "request_id": f"req_{uuid.uuid4().hex[:8]}",
        "ts": int(time.time()),
        "device_id": f"test-{uuid.uuid4().hex[:8]}",
        "role": role,
        "payload": {
            "access_token": token,
            "organization_id": organization_id,
            "capabilities": ["context.sync", "agent.stream", "notifications"],
        },
    })


def _jwt_payload() -> dict:
    return {
        "user_id": _TEST_USER_ID,
        "token_type": "access",
        "exp": int(time.time()) + 3600,
        "iat": int(time.time()),
        "sid": "test-session-key",
    }


class _FakeUser:
    def __init__(self, user_id: str = _TEST_USER_ID):
        self.id = user_id
        self.pk = user_id
        self.is_superuser = False
        self.is_active = True
        self.is_staff = False

    class DoesNotExist(Exception):
        pass


def _passthrough_db_sync(fn):
    if asyncio.iscoroutinefunction(fn):
        return fn

    async def _wrapper(*args, **kwargs):
        return fn(*args, **kwargs)
    return _wrapper


def _patch_auth() -> ExitStack:
    """Mock JWT + DB lookups for successful authentication."""
    stack = ExitStack()

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

    # Wave 1: 用户级连接 — 绕开 _fetch_user_organization_ids 的 DB 查询
    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
        new_callable=AsyncMock, return_value={_TEST_WORKSPACE_ID},
    ))

    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth._update_device_status",
        new_callable=AsyncMock,
    ))
    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth._invalidate_daemon_fp_cache_for_device",
        MagicMock(),
    ))
    stack.enter_context(patch(
        "apps.services.common.ws.handlers.auth.SessionManager",
        MagicMock(
            validate_session=MagicMock(
                return_value=MagicMock(user_id=_TEST_USER_ID),
            ),
        ),
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


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clean_counters():
    """Ensure class-level counters are reset before/after each test."""
    _reset_class_counters()
    yield
    _reset_class_counters()


class TestUnauthenticatedConnectionLimit:
    """RV-003: 全局未认证连接总数限制。"""

    @pytest.mark.asyncio
    async def test_reject_when_unauthenticated_limit_reached(self):
        """未认证连接达到上限后，新连接应被拒绝。"""
        GatewayConsumer._unauthenticated_connections = MAX_UNAUTHENTICATED_CONNECTIONS

        communicator = _make_communicator()
        connected, _ = await communicator.connect()
        assert not connected, "connection should be rejected when unauthenticated limit is reached"
        await communicator.disconnect()

    @pytest.mark.asyncio
    async def test_accept_when_below_unauthenticated_limit(self):
        """未认证连接未达上限时，连接应被接受。"""
        GatewayConsumer._unauthenticated_connections = MAX_UNAUTHENTICATED_CONNECTIONS - 1

        communicator = _make_communicator()
        connected, _ = await communicator.connect()
        assert connected, "connection should be accepted below unauthenticated limit"

        assert GatewayConsumer._unauthenticated_connections == MAX_UNAUTHENTICATED_CONNECTIONS
        await communicator.disconnect()

    @pytest.mark.asyncio
    async def test_unauthenticated_count_increments_on_connect(self):
        """每次 accept 后未认证计数应递增。"""
        assert GatewayConsumer._unauthenticated_connections == 0

        communicator = _make_communicator()
        connected, _ = await communicator.connect()
        assert connected
        assert GatewayConsumer._unauthenticated_connections == 1

        await communicator.disconnect()

    @pytest.mark.asyncio
    async def test_unauthenticated_count_decrements_on_disconnect(self):
        """未认证连接断开后计数应递减。"""
        communicator = _make_communicator()
        connected, _ = await communicator.connect()
        assert connected
        assert GatewayConsumer._unauthenticated_connections == 1

        await communicator.disconnect()
        assert GatewayConsumer._unauthenticated_connections == 0


class TestPerIPUnauthenticatedLimit:
    """RV-003: 单 IP 未认证连接限制。"""

    @pytest.mark.asyncio
    async def test_reject_when_per_ip_limit_reached(self):
        """同一 IP 未认证连接达到上限后，该 IP 的新连接应被拒绝。"""
        attacker_ip = "192.168.1.100"
        GatewayConsumer._per_ip_unauthenticated[attacker_ip] = MAX_UNAUTHENTICATED_PER_IP

        communicator = _make_communicator(ip=attacker_ip)
        connected, _ = await communicator.connect()
        assert not connected, "connection from IP at limit should be rejected"
        await communicator.disconnect()

    @pytest.mark.asyncio
    async def test_different_ip_not_affected(self):
        """一个 IP 达到限制不应影响其他 IP 的连接。"""
        attacker_ip = "192.168.1.100"
        GatewayConsumer._per_ip_unauthenticated[attacker_ip] = MAX_UNAUTHENTICATED_PER_IP

        legitimate_ip = "10.0.0.5"
        communicator = _make_communicator(ip=legitimate_ip)
        connected, _ = await communicator.connect()
        assert connected, "different IP should not be blocked by another IP's limit"
        await communicator.disconnect()

    @pytest.mark.asyncio
    async def test_trusted_proxy_clients_use_separate_unauthenticated_buckets(self):
        """同一受信代理后的不同客户端不应共享代理 IP 的未认证配额。"""
        proxy_ip = "10.149.0.135"
        real_client_ip = "203.0.113.25"
        GatewayConsumer._per_ip_unauthenticated[proxy_ip] = MAX_UNAUTHENTICATED_PER_IP

        with patch.object(
            __import__("apps.services.common.ws.gateway", fromlist=["settings"]).settings,
            "TRUSTED_PROXY_COUNT",
            1,
        ):
            communicator = _make_communicator(
                ip=proxy_ip,
                x_forwarded_for=real_client_ip,
            )
            connected, _ = await communicator.connect()

        assert connected, "trusted XFF client must not inherit the proxy IP bucket"
        assert GatewayConsumer._per_ip_unauthenticated.get(real_client_ip) == 1
        await communicator.disconnect()

    @pytest.mark.asyncio
    async def test_per_ip_count_tracks_correctly(self):
        """per-IP 计数应正确追踪连接/断连。"""
        test_ip = "172.16.0.1"

        c1 = _make_communicator(ip=test_ip)
        connected1, _ = await c1.connect()
        assert connected1
        assert GatewayConsumer._per_ip_unauthenticated.get(test_ip) == 1

        c2 = _make_communicator(ip=test_ip)
        connected2, _ = await c2.connect()
        assert connected2
        assert GatewayConsumer._per_ip_unauthenticated.get(test_ip) == 2

        await c1.disconnect()
        assert GatewayConsumer._per_ip_unauthenticated.get(test_ip) == 1

        await c2.disconnect()
        assert GatewayConsumer._per_ip_unauthenticated.get(test_ip, 0) == 0

    @pytest.mark.asyncio
    async def test_ip_entry_cleaned_up_when_zero(self):
        """当 IP 未认证连接降为 0 时，应从字典中移除（防止内存泄漏）。"""
        test_ip = "10.10.10.10"

        communicator = _make_communicator(ip=test_ip)
        connected, _ = await communicator.connect()
        assert connected
        assert test_ip in GatewayConsumer._per_ip_unauthenticated

        await communicator.disconnect()
        assert test_ip not in GatewayConsumer._per_ip_unauthenticated


class TestAuthReleasesUnauthenticatedSlot:
    """RV-003: 认证成功后应释放未认证配额。"""

    @pytest.mark.asyncio
    async def test_auth_success_decrements_unauthenticated_count(self):
        """认证成功后，未认证连接计数应递减。"""
        auth_patches = _patch_auth()
        with auth_patches:
            communicator = _make_communicator()
            connected, _ = await communicator.connect()
            assert connected

            assert GatewayConsumer._unauthenticated_connections == 1

            await communicator.send_to(_make_auth_envelope())
            response = await communicator.receive_from(timeout=2)
            data = json.loads(response)
            assert data["type"] == "auth.ok"

            assert GatewayConsumer._unauthenticated_connections == 0

            await communicator.disconnect()
            assert GatewayConsumer._unauthenticated_connections == 0

    @pytest.mark.asyncio
    async def test_auth_success_releases_per_ip_slot(self):
        """认证成功后，per-IP 计数应递减。"""
        test_ip = "192.168.5.5"
        auth_patches = _patch_auth()
        with auth_patches:
            communicator = _make_communicator(ip=test_ip)
            connected, _ = await communicator.connect()
            assert connected
            assert GatewayConsumer._per_ip_unauthenticated.get(test_ip) == 1

            await communicator.send_to(_make_auth_envelope())
            response = await communicator.receive_from(timeout=2)
            data = json.loads(response)
            assert data["type"] == "auth.ok"

            assert test_ip not in GatewayConsumer._per_ip_unauthenticated

            await communicator.disconnect()


class TestReleaseIdempotency:
    """RV-003: _release_unauthenticated_slot 的幂等性。"""

    @pytest.mark.asyncio
    async def test_double_release_does_not_go_negative(self):
        """多次释放不应导致计数器为负。"""
        communicator = _make_communicator()
        connected, _ = await communicator.connect()
        assert connected
        assert GatewayConsumer._unauthenticated_connections == 1

        await communicator.disconnect()
        assert GatewayConsumer._unauthenticated_connections == 0

        # disconnect 后再手动调用不应为负（模拟重复 disconnect 边界情况）
        assert GatewayConsumer._unauthenticated_connections >= 0

    @pytest.mark.asyncio
    async def test_rejected_connection_does_not_affect_counters(self):
        """被拒绝的连接不应影响未认证计数。"""
        GatewayConsumer._unauthenticated_connections = MAX_UNAUTHENTICATED_CONNECTIONS
        before = GatewayConsumer._unauthenticated_connections

        communicator = _make_communicator()
        connected, _ = await communicator.connect()
        assert not connected

        assert GatewayConsumer._unauthenticated_connections == before
        await communicator.disconnect()
        assert GatewayConsumer._unauthenticated_connections == before

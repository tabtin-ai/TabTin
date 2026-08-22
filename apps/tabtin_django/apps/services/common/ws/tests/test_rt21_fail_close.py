"""
RT-21 回归测试：Redis 故障时 Fail-Close + 进程级兜底

验证 _increment_connection_count / _decrement_connection_count：
1. Redis 正常时使用 Redis Lua 脚本
2. Redis 异常时使用进程级计数器
3. 进程级计数器达到上限时拒绝连接
4. disconnect 时进程级计数器递减
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

from apps.services.common.ws.gateway import GatewayConsumer  # noqa: E402
from apps.services.common.ws.protocol import MAX_CONNECTIONS_PER_USER  # noqa: E402

_TEST_USER_ID = str(uuid.uuid4())
_PROCESS_LEVEL_MAX = MAX_CONNECTIONS_PER_USER * 2


def _make_consumer(
    user_id: str = _TEST_USER_ID,
    organization_id: str | None = None,
    role: str = "electron",
    device_fingerprint: str = "fp-test",
) -> MagicMock:
    """构造用于连接计数的 consumer 实例（含必要属性以调用真实方法）。"""
    consumer = MagicMock()
    consumer.user_id = user_id
    consumer.organization_id = organization_id
    consumer.role = role
    consumer.device_fingerprint = device_fingerprint
    consumer.channel_name = f"test-{uuid.uuid4()}"
    consumer._conn_counted = False
    consumer._conn_registered_at = 0.0
    # 真实 GatewayConsumer 的 property 逻辑
    consumer._conn_count_key = f"ws:conn:{user_id}"
    consumer._conn_member = device_fingerprint
    return consumer


def _reset_per_user_connections():
    """清空进程级计数器。"""
    GatewayConsumer._per_user_connections.clear()


class TestRT21FailClose(unittest.TestCase):
    """RT-21: Redis 故障时 Fail-Close 回归测试。"""

    def setUp(self):
        _reset_per_user_connections()

    def tearDown(self):
        _reset_per_user_connections()

    @patch("django_redis.get_redis_connection")
    def test_redis_ok_uses_lua_script(self, mock_get_redis):
        """Redis 正常时使用 Redis Lua 脚本。"""
        mock_conn = MagicMock()
        mock_conn.eval.return_value = 1
        mock_get_redis.return_value = mock_conn

        consumer = _make_consumer()

        async def run():
            return await GatewayConsumer._increment_connection_count(consumer)

        result = asyncio.run(run())

        self.assertTrue(result)
        mock_conn.eval.assert_called_once()

    @patch("django_redis.get_redis_connection")
    def test_redis_failure_uses_process_level_counter(self, mock_get_redis):
        """Redis 异常时使用进程级计数器。"""
        mock_get_redis.side_effect = ConnectionError("Redis down")

        consumer = _make_consumer()

        async def run():
            return await GatewayConsumer._increment_connection_count(consumer)

        result = asyncio.run(run())

        self.assertTrue(result)
        self.assertEqual(GatewayConsumer._per_user_connections.get(consumer.user_id), 1)

    @patch("django_redis.get_redis_connection")
    def test_process_level_limit_rejects_connection(self, mock_get_redis):
        """进程级计数器达到上限时拒绝连接。"""
        mock_get_redis.side_effect = ConnectionError("Redis down")

        GatewayConsumer._per_user_connections[_TEST_USER_ID] = _PROCESS_LEVEL_MAX

        consumer = _make_consumer()

        async def run():
            return await GatewayConsumer._increment_connection_count(consumer)

        result = asyncio.run(run())

        self.assertFalse(result)

    @patch("django_redis.get_redis_connection")
    def test_disconnect_decrements_process_level_counter(self, mock_get_redis):
        """disconnect 时进程级计数器递减。"""
        mock_get_redis.side_effect = ConnectionError("Redis down")

        consumer = _make_consumer()

        async def run_increment():
            return await GatewayConsumer._increment_connection_count(consumer)

        asyncio.run(run_increment())
        self.assertEqual(GatewayConsumer._per_user_connections.get(consumer.user_id), 1)

        async def run_decrement():
            await GatewayConsumer._decrement_connection_count(consumer)

        asyncio.run(run_decrement())
        self.assertNotIn(consumer.user_id, GatewayConsumer._per_user_connections)

"""
SDI-018 回归测试：WS 连接建立时必须验证 Session 有效性。

验证场景：
- JWT 有效 + session 有效 → 认证通过
- JWT 有效 + session 已撤销 → 认证拒绝
- JWT 有效 + 无 sid → 认证拒绝
- JWT 有效 + sid 属于其他用户 → 认证拒绝
"""

import os
import sys
import time
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.services.common.ws.handlers.auth import create_auth_handler  # noqa: E402


def _build_consumer():
    """构造模拟 consumer 对象"""
    consumer = MagicMock()
    consumer.authed = False
    consumer._send_error = AsyncMock()
    consumer._send_envelope = AsyncMock()
    consumer._cancel_auth_timeout = MagicMock()
    consumer._increment_connection_count = AsyncMock(return_value=True)
    consumer._increment_device_conn_count = AsyncMock()
    consumer._join_group = AsyncMock()
    consumer._start_heartbeat = AsyncMock()
    consumer._extend_auth_handler = MagicMock()
    consumer._auto_join_update_group = AsyncMock()
    consumer._track_task = MagicMock()
    consumer.scope = {"client": ("127.0.0.1", 12345)}
    consumer.device_fingerprint = None
    consumer.capabilities = set()
    consumer.channel_name = "test_channel"
    return consumer


def _build_envelope(token, organization_id="ws-001", role="electron", device_id=None):
    return {
        "payload": {
            "access_token": token,
            "organization_id": organization_id,
            "capabilities": ["context.sync"],
        },
        "request_id": "req-001",
        "role": role,
        "device_id": device_id,
    }


class TestSDI018WsSessionValidation:
    """SDI-018: WS JWT 认证路径必须验证 session 绑定"""

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    @patch("apps.services.common.ws.handlers.auth._fetch_user_organization_ids")
    @patch("apps.services.common.ws.handlers.auth.database_sync_to_async")
    async def test_valid_session_allows_connection(
        self, mock_db_async, mock_fetch_ws, mock_verify_jwt,
    ):
        """JWT + 有效 session → 认证通过"""
        mock_verify_jwt.return_value = (
            {"user_id": "u1", "token_type": "access", "sid": "valid_session_key"},
            None,
        )

        mock_user = MagicMock()
        mock_user.id = "u1"
        mock_user.is_active = True

        session_mock = MagicMock()
        session_mock.user_id = "u1"

        call_count = [0]
        def db_async_side_effect(fn):
            call_count[0] += 1
            idx = call_count[0]
            if idx == 1:
                return AsyncMock(return_value=mock_user)
            elif idx == 2:
                return AsyncMock(return_value=True)
            elif idx == 3:
                return AsyncMock(return_value=True)
            return AsyncMock(return_value=None)

        mock_db_async.side_effect = db_async_side_effect
        # Wave 1: user organization membership 查询预定
        mock_fetch_ws.return_value = {"ws-001"}

        consumer = _build_consumer()
        handler = create_auth_handler(consumer)
        envelope = _build_envelope("valid.jwt.token")
        await handler(envelope)

        consumer._send_error.assert_not_called()
        assert consumer.authed is True

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    @patch("apps.services.common.ws.handlers.auth.database_sync_to_async")
    async def test_revoked_session_rejects_connection(self, mock_db_async, mock_verify_jwt):
        """JWT 有效 + session 已撤销 → 认证拒绝"""
        mock_verify_jwt.return_value = (
            {"user_id": "u1", "token_type": "access", "sid": "revoked_session_key"},
            None,
        )

        mock_user = MagicMock()
        mock_user.id = "u1"
        mock_user.is_active = True

        call_count = [0]
        def db_async_side_effect(fn):
            call_count[0] += 1
            idx = call_count[0]
            if idx == 1:
                return AsyncMock(return_value=mock_user)
            elif idx == 2:
                return AsyncMock(return_value=True)
            elif idx == 3:
                return AsyncMock(return_value=False)
            return AsyncMock(return_value=None)

        mock_db_async.side_effect = db_async_side_effect

        consumer = _build_consumer()
        handler = create_auth_handler(consumer)
        envelope = _build_envelope("valid.jwt.token")
        await handler(envelope)

        consumer._send_error.assert_called_once()
        args = consumer._send_error.call_args[0]
        assert "session revoked" in args[2]
        assert consumer.authed is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    @patch("apps.services.common.ws.handlers.auth.database_sync_to_async")
    async def test_missing_sid_rejects_connection(self, mock_db_async, mock_verify_jwt):
        """JWT 有效但无 sid → 认证拒绝"""
        mock_verify_jwt.return_value = (
            {"user_id": "u1", "token_type": "access"},
            None,
        )

        mock_user = MagicMock()
        mock_user.id = "u1"
        mock_user.is_active = True

        call_count = [0]
        def db_async_side_effect(fn):
            call_count[0] += 1
            idx = call_count[0]
            if idx == 1:
                return AsyncMock(return_value=mock_user)
            elif idx == 2:
                return AsyncMock(return_value=True)
            return AsyncMock(return_value=None)

        mock_db_async.side_effect = db_async_side_effect

        consumer = _build_consumer()
        handler = create_auth_handler(consumer)
        envelope = _build_envelope("valid.jwt.token")
        await handler(envelope)

        consumer._send_error.assert_called_once()
        args = consumer._send_error.call_args[0]
        assert "missing session binding" in args[2]
        assert consumer.authed is False

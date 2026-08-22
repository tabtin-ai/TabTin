"""
RB-001 / RB-002 / RB-012 回归测试

RB-001: handle_auth JWT 路径必须检查 session 绑定（与 HTTP 层 JWTAuth 对齐）
RB-002: recheck_jwt_validity 心跳重验必须检查 session 活跃性
RB-012: handle_auth 和 recheck 必须检查 daemon token jti 吊销
"""
import os
import sys
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.services.common.ws.handlers.auth import (
    recheck_jwt_validity,
    create_auth_handler,
)


def _make_consumer(**overrides):
    """构造最小化的 mock consumer 用于测试。"""
    from apps.services.common.ws.organization_context import OrganizationContext

    consumer = MagicMock()
    consumer.authed = False
    consumer.user = None
    consumer.user_id = overrides.get("user_id")
    consumer.organization_ctx = OrganizationContext(None, set())
    consumer.role = None
    consumer.device_fingerprint = None
    consumer.connection_scope = None
    consumer.capabilities = set()
    consumer._ws_auth_token = overrides.get("token")
    consumer._last_jwt_recheck_at = time.time()
    consumer._send_error = AsyncMock()
    consumer._send_envelope = AsyncMock()
    consumer._cancel_auth_timeout = MagicMock()
    consumer._increment_connection_count = AsyncMock(return_value=True)
    consumer._increment_device_conn_count = AsyncMock()
    consumer._start_heartbeat = AsyncMock()
    consumer._join_group = AsyncMock()
    consumer._track_task = MagicMock()
    consumer._extend_auth_handler = MagicMock()
    consumer._auto_join_update_group = AsyncMock()
    consumer.scope = {"client": ("127.0.0.1", 12345)}
    consumer.channel_name = "test-channel"
    return consumer


# ══════════════════════════════════════════════════════════
# RB-002: recheck_jwt_validity — session 活跃性重验
# ══════════════════════════════════════════════════════════

class TestRecheckSessionValidity:
    """RB-002: 心跳重验必须检查 session 是否仍然活跃。"""

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_revoked_session_returns_false(self, mock_verify):
        """登出后 session 被失活，重验应返回 False 断开连接。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "access", "sid": "session-key-abc"},
            None,
        )
        consumer = _make_consumer(token="valid.jwt.token", user_id="u1")

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user, patch(
            "apps.services.common.ws.handlers.auth.SessionManager"
        ) as mock_sm:
            mock_user.objects.filter.return_value.exists.return_value = True
            mock_sm.validate_session.return_value = None  # session 已失活
            result = await recheck_jwt_validity(consumer)

        assert result is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_active_session_returns_true(self, mock_verify):
        """session 仍然活跃时，重验应返回 True。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "access", "sid": "session-key-abc"},
            None,
        )
        consumer = _make_consumer(token="valid.jwt.token", user_id="u1")

        mock_session = SimpleNamespace(user_id="u1")

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user, patch(
            "apps.services.common.ws.handlers.auth.SessionManager"
        ) as mock_sm:
            mock_user.objects.filter.return_value.exists.return_value = True
            mock_sm.validate_session.return_value = mock_session
            result = await recheck_jwt_validity(consumer)

        assert result is True

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_session_user_mismatch_returns_false(self, mock_verify):
        """session 的 user_id 与当前连接不匹配时，应返回 False。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "access", "sid": "session-key-abc"},
            None,
        )
        consumer = _make_consumer(token="valid.jwt.token", user_id="u1")

        mock_session = SimpleNamespace(user_id="u-other")

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user, patch(
            "apps.services.common.ws.handlers.auth.SessionManager"
        ) as mock_sm:
            mock_user.objects.filter.return_value.exists.return_value = True
            mock_sm.validate_session.return_value = mock_session
            result = await recheck_jwt_validity(consumer)

        assert result is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_no_sid_in_token_skips_session_check(self, mock_verify):
        """token 中没有 sid 字段时（如 daemon token），跳过 session 检查。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "daemon", "jti": "jti-123"},
            None,
        )
        consumer = _make_consumer(token="daemon.jwt.token", user_id="u1")

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(side_effect=fn),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user, patch(
            "apps.services.common.ws.handlers.auth.is_daemon_token_revoked",
            return_value=False,
        ):
            mock_user.objects.filter.return_value.exists.return_value = True
            result = await recheck_jwt_validity(consumer)

        assert result is True


# ══════════════════════════════════════════════════════════
# RB-012: recheck_jwt_validity — daemon token jti 吊销
# ══════════════════════════════════════════════════════════

class TestRecheckDaemonTokenRevocation:
    """RB-012: 心跳重验必须检查 daemon token 是否已被吊销。"""

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_revoked_daemon_token_returns_false(self, mock_verify):
        """daemon token 被吊销后，重验应返回 False。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "daemon", "jti": "revoked-jti"},
            None,
        )
        consumer = _make_consumer(token="daemon.jwt.token", user_id="u1")

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(side_effect=fn),
        ), patch(
            "apps.services.common.ws.handlers.auth.is_daemon_token_revoked",
            return_value=True,
        ):
            result = await recheck_jwt_validity(consumer)

        assert result is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_valid_daemon_token_returns_true(self, mock_verify):
        """daemon token 未被吊销，用户活跃时，重验应返回 True。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "daemon", "jti": "valid-jti"},
            None,
        )
        consumer = _make_consumer(token="daemon.jwt.token", user_id="u1")

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(side_effect=fn),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user, patch(
            "apps.services.common.ws.handlers.auth.is_daemon_token_revoked",
            return_value=False,
        ):
            mock_user.objects.filter.return_value.exists.return_value = True
            result = await recheck_jwt_validity(consumer)

        assert result is True


# ══════════════════════════════════════════════════════════
# RB-001: handle_auth — session 绑定校验
# ══════════════════════════════════════════════════════════

class TestHandleAuthSessionBinding:
    """RB-001: handle_auth JWT 路径必须验证 session 绑定。"""

    def _make_auth_envelope(self, token="jwt-token", organization_id="ws-1",
                            role="electron", capabilities=None):
        return {
            "payload": {
                "access_token": token,
                "organization_id": organization_id,
                "capabilities": capabilities or ["context.sync"],
            },
            "request_id": "req-1",
            "role": role,
            "device_id": None,
        }

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_missing_sid_rejected(self, mock_verify):
        """JWT 中缺少 sid 字段时，应拒绝认证。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "access"},
            None,
        )
        consumer = _make_consumer()
        handler = create_auth_handler(consumer)

        mock_user = MagicMock()
        mock_user.id = "u1"
        mock_user.is_active = True

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user_model:
            mock_user_model.objects.get.return_value = mock_user
            mock_user_model.DoesNotExist = Exception

            with patch(
                "apps.services.common.ws.handlers.auth.OrganizationService"
            ) as mock_ws:
                mock_ws.return_value.check_organization_permission.return_value = True

                await handler(self._make_auth_envelope())

        consumer._send_error.assert_called()
        call_args = consumer._send_error.call_args
        assert "session" in call_args[0][2].lower() or "session" in str(call_args).lower()
        assert consumer.authed is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_revoked_session_rejected(self, mock_verify):
        """session 已被吊销时，应拒绝认证。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "access", "sid": "revoked-session"},
            None,
        )
        consumer = _make_consumer()
        handler = create_auth_handler(consumer)

        mock_user = MagicMock()
        mock_user.id = "u1"
        mock_user.is_active = True

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user_model, patch(
            "apps.services.common.ws.handlers.auth.SessionManager"
        ) as mock_sm:
            mock_user_model.objects.get.return_value = mock_user
            mock_user_model.DoesNotExist = Exception

            with patch(
                "apps.services.common.ws.handlers.auth.OrganizationService"
            ) as mock_ws:
                mock_ws.return_value.check_organization_permission.return_value = True
                mock_sm.validate_session.return_value = None  # session 已吊销

                await handler(self._make_auth_envelope())

        consumer._send_error.assert_called()
        assert consumer.authed is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_valid_session_accepted(self, mock_verify):
        """session 有效时，认证应成功。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "access", "sid": "valid-session"},
            None,
        )
        consumer = _make_consumer()
        handler = create_auth_handler(consumer)

        mock_user = MagicMock()
        mock_user.id = "u1"
        mock_user.is_active = True

        mock_session = SimpleNamespace(user_id="u1")

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user_model, patch(
            "apps.services.common.ws.handlers.auth.SessionManager"
        ) as mock_sm, patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value={"ws-1"},
        ):
            mock_user_model.objects.get.return_value = mock_user
            mock_user_model.DoesNotExist = Exception
            mock_sm.validate_session.return_value = mock_session

            with patch(
                "apps.services.common.ws.handlers.auth.OrganizationService"
            ) as mock_ws:
                mock_ws.return_value.check_organization_permission.return_value = True
                await handler(self._make_auth_envelope())

        assert consumer.authed is True
        assert consumer.user_id == "u1"


# ══════════════════════════════════════════════════════════
# RB-012: handle_auth — daemon token jti 吊销检查
# ══════════════════════════════════════════════════════════

class TestHandleAuthDaemonTokenRevocation:
    """RB-012: handle_auth 必须检查 daemon token jti 是否已被吊销。"""

    def _make_daemon_envelope(self, token="daemon-token"):
        return {
            "payload": {
                "access_token": token,
                "organization_id": "ws-1",
                "capabilities": ["context.sync"],
            },
            "request_id": "req-1",
            "role": "daemon",
            "device_id": "daemon-fp-123",
        }

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_revoked_daemon_jti_rejected(self, mock_verify):
        """daemon token 已被吊销（jti 在黑名单中），应拒绝认证。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "daemon", "jti": "revoked-jti",
             "device_id": "daemon-fp-123"},
            None,
        )
        consumer = _make_consumer()
        handler = create_auth_handler(consumer)

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.is_daemon_token_revoked",
            return_value=True,
        ):
            await handler(self._make_daemon_envelope())

        consumer._send_error.assert_called()
        call_args = consumer._send_error.call_args
        assert "revoked" in call_args[0][2].lower()
        assert consumer.authed is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_valid_daemon_jti_proceeds(self, mock_verify):
        """daemon token 未被吊销，应继续后续验证流程。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "daemon", "jti": "valid-jti",
             "device_id": "daemon-fp-123", "sid": "daemon-session"},
            None,
        )
        consumer = _make_consumer()
        handler = create_auth_handler(consumer)

        mock_user = MagicMock()
        mock_user.id = "u1"
        mock_user.is_active = True
        mock_session = SimpleNamespace(user_id="u1")

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.is_daemon_token_revoked",
            return_value=False,
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user_model, patch(
            "apps.services.common.ws.handlers.auth.SessionManager"
        ) as mock_sm, patch(
            "apps.services.common.ws.handlers.auth.OrganizationService"
        ) as mock_ws, patch(
            "apps.services.common.ws.handlers.auth._fetch_device_organization_id",
            new_callable=AsyncMock, return_value="ws-1",
        ):
            mock_user_model.objects.get.return_value = mock_user
            mock_user_model.DoesNotExist = Exception
            mock_sm.validate_session.return_value = mock_session
            mock_ws.return_value.check_organization_permission.return_value = True

            await handler(self._make_daemon_envelope())

        assert consumer.authed is True

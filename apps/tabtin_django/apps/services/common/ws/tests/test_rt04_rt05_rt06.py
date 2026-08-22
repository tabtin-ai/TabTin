"""
RT-04 / RT-05 / RT-06 回归测试

RT-04: JWT 过期后 WS 心跳重验 — 过期/用户禁用时断开连接
RT-05: Channel Legacy Token 默认拒绝
RT-06: WS_ALLOWED_ORIGINS 配置后，缺少 Origin 头的请求也被拒绝
"""
import os
import sys
import hmac
import hashlib
import time
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.services.common.ws.handlers.auth import (
    _verify_channel_token,
    _verify_jwt_for_ws,
    recheck_jwt_validity,
)


# ══════════════════════════════════════════════════════════
# RT-05: _verify_channel_token — Legacy Token 拒绝
# ══════════════════════════════════════════════════════════

class TestChannelTokenLegacyReject:
    """RT-05: Legacy tokens (no timestamp) must be rejected by default."""

    def test_timestamped_token_valid(self):
        """带时间戳的 HMAC token 在有效期内应该通过。"""
        secret = "test-secret-key"
        ts = str(int(time.time()))
        sig = hmac.new(
            secret.encode("utf-8"),
            ts.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        token = f"{ts}:{sig}"
        ok, err = _verify_channel_token(token, secret)
        assert ok is True
        assert err == ""

    def test_timestamped_token_expired(self):
        """时间戳超过 5 分钟窗口的 HMAC token 应该被拒绝。"""
        secret = "test-secret-key"
        ts = str(int(time.time()) - 600)  # 10 min ago
        sig = hmac.new(
            secret.encode("utf-8"),
            ts.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        token = f"{ts}:{sig}"
        ok, err = _verify_channel_token(token, secret)
        assert ok is False
        assert "expired" in err

    def test_timestamped_token_bad_sig(self):
        """签名错误的 HMAC token 应该被拒绝。"""
        secret = "test-secret-key"
        ts = str(int(time.time()))
        token = f"{ts}:deadbeef"
        ok, err = _verify_channel_token(token, secret)
        assert ok is False
        assert "invalid" in err

    def test_legacy_token_rejected_by_default(self):
        """RT-05: Legacy token 默认被拒绝（CHANNEL_LEGACY_TOKEN_ENABLED 未配置或为 False）。"""
        secret = "plain-secret"
        ok, err = _verify_channel_token(secret, secret)
        assert ok is False
        assert "legacy" in err.lower()

    @patch("apps.services.common.ws.handlers.auth.settings")
    def test_legacy_token_rejected_when_disabled(self, mock_settings):
        """CHANNEL_LEGACY_TOKEN_ENABLED=False 时拒绝 legacy token。"""
        mock_settings.CHANNEL_LEGACY_TOKEN_ENABLED = False
        secret = "plain-secret"
        ok, err = _verify_channel_token(secret, secret)
        assert ok is False
        assert "legacy" in err.lower()

    @patch("apps.services.common.ws.handlers.auth.settings")
    def test_legacy_token_allowed_when_enabled(self, mock_settings):
        """CHANNEL_LEGACY_TOKEN_ENABLED=True 时允许 legacy token（向后兼容）。"""
        mock_settings.CHANNEL_LEGACY_TOKEN_ENABLED = True
        secret = "plain-secret"
        ok, err = _verify_channel_token(secret, secret)
        assert ok is True
        assert err == ""

    @patch("apps.services.common.ws.handlers.auth.settings")
    def test_legacy_token_wrong_secret_still_rejected(self, mock_settings):
        """即使启用 legacy，密钥不匹配也应拒绝。"""
        mock_settings.CHANNEL_LEGACY_TOKEN_ENABLED = True
        ok, err = _verify_channel_token("wrong-secret", "correct-secret")
        assert ok is False
        assert "invalid" in err


# ══════════════════════════════════════════════════════════
# RT-04: recheck_jwt_validity — JWT 心跳重验
# ══════════════════════════════════════════════════════════

class TestRecheckJwtValidity:
    """RT-04: Heartbeat JWT re-verification."""

    @pytest.mark.asyncio
    async def test_no_token_returns_true(self):
        """非 JWT 认证（channel / open_api）不做重验，返回 True。"""
        consumer = MagicMock()
        consumer._ws_auth_token = None
        result = await recheck_jwt_validity(consumer)
        assert result is True

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_valid_token_returns_true(self, mock_verify):
        """JWT 仍有效时返回 True。"""
        mock_verify.return_value = (
            {"user_id": "u1", "exp": time.time() + 3600,
             "token_type": "access", "sid": "session-key"},
            None,
        )
        consumer = MagicMock()
        consumer._ws_auth_token = "valid.jwt.token"
        consumer.user_id = "u1"

        from types import SimpleNamespace
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
    async def test_expired_token_returns_false(self, mock_verify):
        """JWT 过期时返回 False，调用者应断开连接。"""
        mock_verify.return_value = (None, "expired")
        consumer = MagicMock()
        consumer._ws_auth_token = "expired.jwt.token"
        consumer.user_id = "u1"
        result = await recheck_jwt_validity(consumer)
        assert result is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_invalid_token_returns_false(self, mock_verify):
        """JWT 被篡改时返回 False。"""
        mock_verify.return_value = (None, "invalid")
        consumer = MagicMock()
        consumer._ws_auth_token = "tampered.jwt.token"
        consumer.user_id = "u1"
        result = await recheck_jwt_validity(consumer)
        assert result is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_deactivated_user_returns_false(self, mock_verify):
        """RT-04: 用户被禁用时返回 False。"""
        mock_verify.return_value = (
            {"user_id": "u1", "exp": time.time() + 3600,
             "token_type": "access", "sid": "session-key"},
            None,
        )
        consumer = MagicMock()
        consumer._ws_auth_token = "valid.jwt.token"
        consumer.user_id = "u1"

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ), patch(
            "apps.services.common.ws.handlers.auth.User"
        ) as mock_user:
            mock_user.objects.filter.return_value.exists.return_value = False
            result = await recheck_jwt_validity(consumer)
        assert result is False


# ══════════════════════════════════════════════════════════
# RT-06: Origin 检查 — 缺少 Origin 时拒绝
# ══════════════════════════════════════════════════════════

class TestOriginCheckMissingReject:
    """RT-06: When WS_ALLOWED_ORIGINS is set, missing Origin must be rejected."""

    def _make_scope(self, origin=None):
        """构造 ASGI scope with optional Origin header."""
        headers = []
        if origin is not None:
            headers.append((b"origin", origin.encode("utf-8")))
        return {"type": "websocket", "headers": headers, "client": ("127.0.0.1", 12345)}

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.gateway.WS_ALLOWED_ORIGINS", ["https://app.example.com"])
    async def test_missing_origin_rejected(self):
        """配置了白名单但请求无 Origin 头时应拒绝连接。"""
        from apps.services.common.ws.gateway import GatewayConsumer

        consumer = GatewayConsumer()
        consumer.scope = self._make_scope(origin=None)
        consumer.close = AsyncMock()
        consumer.accept = AsyncMock()

        # Bypass total connections check
        with patch.object(type(consumer), '_total_connections', new_callable=lambda: property(lambda self: 0)):
            GatewayConsumer._total_connections = 0
            await consumer.connect()

        consumer.close.assert_called_once()
        consumer.accept.assert_not_called()

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.gateway.WS_ALLOWED_ORIGINS", ["https://app.example.com"])
    async def test_wrong_origin_rejected(self):
        """Origin 不在白名单中时应拒绝连接。"""
        from apps.services.common.ws.gateway import GatewayConsumer

        consumer = GatewayConsumer()
        consumer.scope = self._make_scope(origin="https://evil.com")
        consumer.close = AsyncMock()
        consumer.accept = AsyncMock()

        GatewayConsumer._total_connections = 0
        await consumer.connect()

        consumer.close.assert_called_once()
        consumer.accept.assert_not_called()

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.gateway.WS_ALLOWED_ORIGINS", ["https://app.example.com"])
    async def test_valid_origin_accepted(self):
        """Origin 在白名单中时应允许连接。"""
        from apps.services.common.ws.gateway import GatewayConsumer

        consumer = GatewayConsumer()
        consumer.scope = self._make_scope(origin="https://app.example.com")
        consumer.close = AsyncMock()
        consumer.accept = AsyncMock()

        GatewayConsumer._total_connections = 0
        await consumer.connect()

        consumer.accept.assert_called_once()

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.gateway.WS_ALLOWED_ORIGINS", None)
    async def test_no_whitelist_allows_all(self):
        """未配置白名单时不检查 Origin。"""
        from apps.services.common.ws.gateway import GatewayConsumer

        consumer = GatewayConsumer()
        consumer.scope = self._make_scope(origin=None)
        consumer.close = AsyncMock()
        consumer.accept = AsyncMock()

        GatewayConsumer._total_connections = 0
        await consumer.connect()

        consumer.accept.assert_called_once()

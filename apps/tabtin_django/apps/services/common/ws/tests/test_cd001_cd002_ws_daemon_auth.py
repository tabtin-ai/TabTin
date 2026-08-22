"""
CD-001 / CD-002 回归测试（WS 层）

CD-001: WS 初始认证 — daemon 角色接受 daemon token，非 daemon 角色拒绝 daemon token
CD-002: WS 重验 — recheck_jwt_validity 验证 token_type，daemon 已吊销时断开
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

from apps.services.common.ws.handlers.auth import (
    _verify_jwt_for_ws,
    recheck_jwt_validity,
)


# ══════════════════════════════════════════════════════════
# CD-002: recheck_jwt_validity — token_type 检查
# ══════════════════════════════════════════════════════════

class TestRecheckTokenTypeValidation:
    """CD-002: recheck_jwt_validity 必须验证 token_type 字段。"""

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_access_token_passes_recheck(self, mock_verify):
        """token_type='access' 的合法 token 通过重验。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "access", "exp": time.time() + 3600},
            None,
        )
        consumer = MagicMock()
        consumer._ws_auth_token = "valid.access.token"
        consumer.user_id = "u1"

        def _mock_sync_to_async(fn):
            async def wrapper(*args, **kwargs):
                return fn(*args, **kwargs)
            return wrapper

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=_mock_sync_to_async,
        ), patch("apps.services.common.ws.handlers.auth.User") as mock_user:
            mock_user.objects.filter.return_value.exists.return_value = True
            result = await recheck_jwt_validity(consumer)
        assert result is True

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_daemon_token_passes_recheck(self, mock_verify):
        """token_type='daemon' 的合法 token 通过重验（JTI 未吊销）。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "daemon", "jti": "jti-ok", "exp": time.time() + 3600},
            None,
        )
        consumer = MagicMock()
        consumer._ws_auth_token = "valid.daemon.token"
        consumer.user_id = "u1"

        def _mock_sync_to_async(fn):
            async def wrapper(*args, **kwargs):
                return fn(*args, **kwargs)
            return wrapper

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=_mock_sync_to_async,
        ), patch("apps.services.common.ws.handlers.auth.User") as mock_user, \
             patch(
            "apps.services.common.ws.handlers.auth.is_daemon_token_revoked",
            return_value=False,
        ):
            mock_user.objects.filter.return_value.exists.return_value = True
            result = await recheck_jwt_validity(consumer)
        assert result is True

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_refresh_token_rejected_on_recheck(self, mock_verify):
        """CD-002 核心：token_type='refresh' 在重验时被拒绝。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "refresh", "exp": time.time() + 3600},
            None,
        )
        consumer = MagicMock()
        consumer._ws_auth_token = "smuggled.refresh.token"
        consumer.user_id = "u1"
        result = await recheck_jwt_validity(consumer)
        assert result is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_unknown_token_type_rejected_on_recheck(self, mock_verify):
        """CD-002 核心：未知 token_type 在重验时被拒绝。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "magic_link", "exp": time.time() + 3600},
            None,
        )
        consumer = MagicMock()
        consumer._ws_auth_token = "smuggled.magic.token"
        consumer.user_id = "u1"
        result = await recheck_jwt_validity(consumer)
        assert result is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_missing_token_type_rejected_on_recheck(self, mock_verify):
        """CD-002：payload 中缺少 token_type 字段时被拒绝。"""
        mock_verify.return_value = (
            {"user_id": "u1", "exp": time.time() + 3600},
            None,
        )
        consumer = MagicMock()
        consumer._ws_auth_token = "no.type.token"
        consumer.user_id = "u1"
        result = await recheck_jwt_validity(consumer)
        assert result is False

    @pytest.mark.asyncio
    @patch("apps.services.common.ws.handlers.auth._verify_jwt_for_ws")
    async def test_revoked_daemon_disconnected_on_recheck(self, mock_verify):
        """CD-002：daemon token 的 JTI 被吊销时，重验应返回 False。"""
        mock_verify.return_value = (
            {"user_id": "u1", "token_type": "daemon", "jti": "revoked-jti", "exp": time.time() + 3600},
            None,
        )
        consumer = MagicMock()
        consumer._ws_auth_token = "daemon.with.revoked.jti"
        consumer.user_id = "u1"

        def _mock_sync_to_async(fn):
            async def wrapper(*args, **kwargs):
                return fn(*args, **kwargs)
            return wrapper

        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=_mock_sync_to_async,
        ), patch(
            "apps.services.common.ws.handlers.auth.is_daemon_token_revoked",
            return_value=True,
        ):
            result = await recheck_jwt_validity(consumer)
        assert result is False

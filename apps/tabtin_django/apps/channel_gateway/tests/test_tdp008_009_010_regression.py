"""TDP-008/009/010 回归测试：依赖缺失日志级别 + JWKS/Certs 降级缓存。

TDP-008: ImportError 日志从 WARNING 升级为 ERROR
TDP-009: MSTeams JWKS 获取失败 → ERROR 告警 + stale 缓存降级
TDP-010: GoogleChat certs 获取失败 → ERROR 告警 + stale 缓存降级
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

from django.http import HttpRequest
from django.test import SimpleTestCase, override_settings


# ---------------------------------------------------------------------------
# TDP-008: ImportError 日志级别
# ---------------------------------------------------------------------------

class TestTDP008_MSTeams_ImportError_LogLevel(SimpleTestCase):
    """PyJWT 缺失时应记录 ERROR 而非 WARNING。"""

    def _make_request_with_auth(self, token: str = "fake.jwt.token") -> HttpRequest:
        req = HttpRequest()
        req._body = b"{}"
        req.method = "POST"
        req.META["HTTP_AUTHORIZATION"] = f"Bearer {token}"
        return req

    @patch.dict("sys.modules", {"jwt": None})
    def test_pyjwt_missing_logs_error(self):
        import importlib
        from apps.channel_gateway.adapters import msteams
        importlib.reload(msteams)

        with self.assertLogs("apps.channel_gateway.adapters.msteams", level="ERROR") as cm:
            result = msteams._verify_jwt(self._make_request_with_auth(), "app_test")

        self.assertFalse(result)
        self.assertTrue(
            any("PyJWT not installed" in msg for msg in cm.output),
            f"Expected ERROR log about PyJWT not installed, got: {cm.output}",
        )

        importlib.reload(msteams)


class TestTDP008_GoogleChat_ImportError_LogLevel(SimpleTestCase):
    """PyJWT 缺失时 _verify_bearer_token 应记录 ERROR。"""

    def _make_request_with_auth(self) -> HttpRequest:
        req = HttpRequest()
        req._body = b"{}"
        req.method = "POST"
        req.META["HTTP_AUTHORIZATION"] = "Bearer fake.jwt.token"
        return req

    @patch(
        "apps.channel_gateway.adapters.googlechat.cache",
    )
    def test_pyjwt_missing_logs_error(self, mock_cache):
        mock_cache.get.return_value = {"kid1": "cert-pem"}

        real_import = __builtins__.__import__ if hasattr(__builtins__, '__import__') else __import__

        def _mock_import(name, *args, **kwargs):
            if name == "jwt":
                raise ImportError("No module named 'jwt'")
            return real_import(name, *args, **kwargs)

        from apps.channel_gateway.adapters import googlechat

        with (
            patch("builtins.__import__", side_effect=_mock_import),
            self.assertLogs("apps.channel_gateway.adapters.googlechat", level="ERROR") as cm,
        ):
            result = googlechat._verify_bearer_token(
                self._make_request_with_auth(),
                "test-audience",
            )

        self.assertFalse(result)
        self.assertTrue(
            any("PyJWT not installed" in msg for msg in cm.output),
            f"Expected ERROR log about PyJWT not installed, got: {cm.output}",
        )


# ---------------------------------------------------------------------------
# TDP-009: MSTeams JWKS 降级缓存
# ---------------------------------------------------------------------------

class TestTDP009_MSTeams_JWKS_StaleFallback(SimpleTestCase):
    """JWKS 网络获取失败时应降级到 stale 缓存，并记录 ERROR。"""

    @patch("apps.channel_gateway.adapters.msteams.httpx.get")
    @patch("apps.channel_gateway.adapters.msteams.cache")
    def test_fetch_failure_with_stale_cache_returns_stale(self, mock_cache, mock_get):
        from apps.channel_gateway.adapters.msteams import _get_jwks, JWKS_STALE_CACHE_KEY

        stale_jwks = {"keys": [{"kid": "old-kid", "kty": "RSA"}]}
        mock_cache.get.side_effect = lambda key: {
            "msteams:jwks": None,
            JWKS_STALE_CACHE_KEY: stale_jwks,
        }.get(key)
        mock_get.side_effect = ConnectionError("network down")

        with self.assertLogs("apps.channel_gateway.adapters.msteams", level="ERROR") as cm:
            result = _get_jwks()

        self.assertEqual(result, stale_jwks)
        self.assertTrue(
            any("stale cached keys" in msg for msg in cm.output),
            f"Expected ERROR log about stale cache fallback, got: {cm.output}",
        )

    @patch("apps.channel_gateway.adapters.msteams.httpx.get")
    @patch("apps.channel_gateway.adapters.msteams.cache")
    def test_fetch_failure_without_stale_cache_returns_none(self, mock_cache, mock_get):
        from apps.channel_gateway.adapters.msteams import _get_jwks

        mock_cache.get.return_value = None
        mock_get.side_effect = ConnectionError("network down")

        with self.assertLogs("apps.channel_gateway.adapters.msteams", level="ERROR") as cm:
            result = _get_jwks()

        self.assertIsNone(result)
        self.assertTrue(
            any("no stale cache available" in msg for msg in cm.output),
            f"Expected ERROR log about no stale cache, got: {cm.output}",
        )

    @patch("apps.channel_gateway.adapters.msteams.httpx.get")
    @patch("apps.channel_gateway.adapters.msteams.cache")
    def test_successful_fetch_populates_stale_cache(self, mock_cache, mock_get):
        from apps.channel_gateway.adapters.msteams import (
            _get_jwks,
            JWKS_CACHE_KEY,
            JWKS_STALE_CACHE_KEY,
            JWKS_STALE_CACHE_TTL,
        )

        mock_cache.get.return_value = None
        jwks_data = {"keys": [{"kid": "new-kid", "kty": "RSA"}]}

        openid_response = MagicMock()
        openid_response.json.return_value = {"jwks_uri": "https://example.com/jwks"}
        openid_response.raise_for_status = MagicMock()

        jwks_response = MagicMock()
        jwks_response.json.return_value = jwks_data
        jwks_response.raise_for_status = MagicMock()

        mock_get.side_effect = [openid_response, jwks_response]

        result = _get_jwks()

        self.assertEqual(result, jwks_data)
        stale_calls = [
            c for c in mock_cache.set.call_args_list
            if c[0][0] == JWKS_STALE_CACHE_KEY
        ]
        self.assertEqual(len(stale_calls), 1)
        self.assertEqual(stale_calls[0][0][1], jwks_data)
        self.assertEqual(stale_calls[0][0][2], JWKS_STALE_CACHE_TTL)

    @patch("apps.channel_gateway.adapters.msteams._get_jwks", return_value=None)
    def test_verify_jwt_logs_error_when_jwks_unavailable(self, _mock_jwks):
        """_verify_jwt 在 JWKS 不可用时应记录 ERROR。"""
        from apps.channel_gateway.adapters.msteams import _verify_jwt
        import base64, json

        header = base64.urlsafe_b64encode(
            json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
        ).decode().rstrip("=")
        payload = base64.urlsafe_b64encode(
            json.dumps({"aud": "app_test"}).encode()
        ).decode().rstrip("=")
        sig = base64.urlsafe_b64encode(b"fake").decode().rstrip("=")
        fake_jwt = f"{header}.{payload}.{sig}"

        req = HttpRequest()
        req._body = b"{}"
        req.method = "POST"
        req.META["HTTP_AUTHORIZATION"] = f"Bearer {fake_jwt}"

        with self.assertLogs("apps.channel_gateway.adapters.msteams", level="ERROR") as cm:
            result = _verify_jwt(req, "app_test")

        self.assertFalse(result)
        self.assertTrue(
            any("JWKS unavailable" in msg for msg in cm.output),
            f"Expected ERROR log about JWKS unavailable, got: {cm.output}",
        )


# ---------------------------------------------------------------------------
# TDP-010: GoogleChat certs 降级缓存
# ---------------------------------------------------------------------------

class TestTDP010_GoogleChat_Certs_StaleFallback(SimpleTestCase):
    """Google certs 网络获取失败时应降级到 stale 缓存，并记录 ERROR。"""

    @patch("apps.channel_gateway.adapters.googlechat.httpx.get")
    @patch("apps.channel_gateway.adapters.googlechat.cache")
    def test_fetch_failure_with_stale_cache_returns_stale(self, mock_cache, mock_get):
        from apps.channel_gateway.adapters.googlechat import (
            _fetch_google_certs_sync,
            GOOGLE_CERTS_STALE_CACHE_KEY,
        )

        stale_certs = {"kid1": "-----BEGIN CERTIFICATE-----\nold\n-----END CERTIFICATE-----\n"}
        mock_cache.get.side_effect = lambda key: {
            GOOGLE_CERTS_STALE_CACHE_KEY: stale_certs,
        }.get(key)
        mock_get.side_effect = ConnectionError("network down")

        with self.assertLogs("apps.channel_gateway.adapters.googlechat", level="ERROR") as cm:
            result = _fetch_google_certs_sync()

        self.assertEqual(result, stale_certs)
        self.assertTrue(
            any("stale cached certs" in msg for msg in cm.output),
            f"Expected ERROR log about stale cache fallback, got: {cm.output}",
        )

    @patch("apps.channel_gateway.adapters.googlechat.httpx.get")
    @patch("apps.channel_gateway.adapters.googlechat.cache")
    def test_fetch_failure_without_stale_cache_returns_none(self, mock_cache, mock_get):
        from apps.channel_gateway.adapters.googlechat import _fetch_google_certs_sync

        mock_cache.get.return_value = None
        mock_get.side_effect = ConnectionError("network down")

        with self.assertLogs("apps.channel_gateway.adapters.googlechat", level="ERROR") as cm:
            result = _fetch_google_certs_sync()

        self.assertIsNone(result)
        self.assertTrue(
            any("no stale cache available" in msg for msg in cm.output),
            f"Expected ERROR log about no stale cache, got: {cm.output}",
        )

    @patch("apps.channel_gateway.adapters.googlechat.httpx.get")
    @patch("apps.channel_gateway.adapters.googlechat.cache")
    def test_successful_fetch_populates_stale_cache(self, mock_cache, mock_get):
        from apps.channel_gateway.adapters.googlechat import (
            _fetch_google_certs_sync,
            GOOGLE_CERTS_STALE_CACHE_KEY,
            GOOGLE_CERTS_STALE_CACHE_TTL,
        )

        mock_cache.get.return_value = None
        certs_data = {"kid1": "-----BEGIN CERTIFICATE-----\nnew\n-----END CERTIFICATE-----\n"}

        resp_mock = MagicMock()
        resp_mock.json.return_value = certs_data
        resp_mock.raise_for_status = MagicMock()
        mock_get.return_value = resp_mock

        result = _fetch_google_certs_sync()

        self.assertEqual(result, certs_data)
        stale_calls = [
            c for c in mock_cache.set.call_args_list
            if c[0][0] == GOOGLE_CERTS_STALE_CACHE_KEY
        ]
        self.assertEqual(len(stale_calls), 1)
        self.assertEqual(stale_calls[0][0][1], certs_data)
        self.assertEqual(stale_calls[0][0][2], GOOGLE_CERTS_STALE_CACHE_TTL)

    @patch("apps.channel_gateway.adapters.googlechat._fetch_google_certs_sync", return_value=None)
    @patch("apps.channel_gateway.adapters.googlechat.cache")
    def test_verify_bearer_logs_error_when_certs_unavailable(self, mock_cache, _mock_fetch):
        """_verify_bearer_token 在 certs 不可用时应记录 ERROR。"""
        from apps.channel_gateway.adapters.googlechat import _verify_bearer_token

        mock_cache.get.return_value = None

        req = HttpRequest()
        req._body = b"{}"
        req.method = "POST"
        req.META["HTTP_AUTHORIZATION"] = "Bearer fake.jwt.token"

        with self.assertLogs("apps.channel_gateway.adapters.googlechat", level="ERROR") as cm:
            result = _verify_bearer_token(req, "test-audience")

        self.assertFalse(result)
        self.assertTrue(
            any("public keys unavailable" in msg for msg in cm.output),
            f"Expected ERROR log about certs unavailable, got: {cm.output}",
        )

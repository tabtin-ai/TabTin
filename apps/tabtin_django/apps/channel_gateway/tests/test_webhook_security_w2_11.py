"""Regression tests for Wave 2 webhook security fixes (W2-11).

Covers: DE-09, DE-10, DE-11, DE-15, DE-16.
"""

from __future__ import annotations

import json
import time
from unittest.mock import MagicMock, patch

from django.test import RequestFactory, SimpleTestCase, override_settings

from apps.channel_gateway.adapters.base import WebhookChallengeResponse
from apps.channel_gateway.views.webhook import (
    _is_rate_limited,
    channel_webhook,
)


class DE09FeishuChallengeAuthTest(SimpleTestCase):
    """DE-09: Feishu POST challenge must NOT be answered before auth."""

    def _post(self, body_dict: dict, token: str = "a" * 32):
        factory = RequestFactory()
        return factory.post(
            f"/channel-gateway/webhook/feishu/{token}/",
            data=json.dumps(body_dict),
            content_type="application/json",
        )

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token", return_value=None)
    def test_feishu_challenge_rejected_without_valid_token(self, _mock_resolve):
        """url_verification with invalid webhook_token should return 403, not the challenge."""
        body = {"type": "url_verification", "challenge": "secret_challenge", "token": "t"}
        resp = channel_webhook(self._post(body), "feishu", "a" * 32)
        self.assertEqual(resp.status_code, 403)
        data = json.loads(resp.content)
        self.assertNotIn("challenge", data)

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token", return_value=None)
    def test_direct_challenge_rejected_without_valid_token(self, _mock_resolve):
        """Direct challenge field with invalid token should return 403."""
        body = {"challenge": "probe_test"}
        resp = channel_webhook(self._post(body), "feishu", "a" * 32)
        self.assertEqual(resp.status_code, 403)
        data = json.loads(resp.content)
        self.assertNotIn("challenge", data)


class DE10SlackChallengeAfterSigTest(SimpleTestCase):
    """DE-10: Slack url_verification must only respond after signature verification."""

    def test_url_verification_without_signature_rejected(self):
        """url_verification request without signing headers should be rejected."""
        from apps.channel_gateway.adapters.slack import SlackAdapter

        factory = RequestFactory()
        body = {"type": "url_verification", "challenge": "slack_challenge_val"}
        req = factory.post("/", data=json.dumps(body), content_type="application/json")

        account = MagicMock()
        account.config = {"signing_secret": "test_secret"}

        adapter = SlackAdapter()
        result = adapter.parse_webhook(req, account)
        self.assertIsNone(result)

    def test_url_verification_with_bad_signature_rejected(self):
        """url_verification with wrong signature should be rejected."""
        from apps.channel_gateway.adapters.slack import SlackAdapter

        factory = RequestFactory()
        body = {"type": "url_verification", "challenge": "c"}
        req = factory.post(
            "/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_SLACK_REQUEST_TIMESTAMP=str(int(time.time())),
            HTTP_X_SLACK_SIGNATURE="v0=bad_signature",
        )

        account = MagicMock()
        account.config = {"signing_secret": "real_secret"}

        adapter = SlackAdapter()
        result = adapter.parse_webhook(req, account)
        self.assertIsNone(result)


class DE11NonceDeduplicationTest(SimpleTestCase):
    """DE-11: Nonce deduplication prevents replay within timestamp tolerance window."""

    @override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
    @patch("apps.channel_gateway.adapters.feishu._verify_signature", return_value=True)
    @patch("apps.channel_gateway.adapters.feishu._check_timestamp_freshness", return_value=True)
    def test_feishu_duplicate_nonce_rejected(self, _mock_ts, _mock_sig):
        from django.core.cache import cache
        from apps.channel_gateway.adapters.feishu import FeishuAdapter

        cache.clear()
        factory = RequestFactory()
        body = {"schema": "2.0", "header": {"event_type": "im.message.receive_v1"}, "event": {}}
        body_json = json.dumps(body)

        nonce_val = "unique_nonce_12345"
        req1 = factory.post(
            "/",
            data=body_json,
            content_type="application/json",
            HTTP_X_LARK_SIGNATURE="abc",
            HTTP_X_LARK_REQUEST_TIMESTAMP=str(int(time.time())),
            HTTP_X_LARK_REQUEST_NONCE=nonce_val,
        )
        req2 = factory.post(
            "/",
            data=body_json,
            content_type="application/json",
            HTTP_X_LARK_SIGNATURE="abc",
            HTTP_X_LARK_REQUEST_TIMESTAMP=str(int(time.time())),
            HTTP_X_LARK_REQUEST_NONCE=nonce_val,
        )

        account = MagicMock()
        account.config = {"verification_token": "vt", "encrypt_key": ""}

        adapter = FeishuAdapter()
        adapter.parse_webhook(req1, account)
        result2 = adapter.parse_webhook(req2, account)
        self.assertIsNone(result2)

    @override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
    def test_slack_duplicate_signature_rejected(self):
        from django.core.cache import cache
        from apps.channel_gateway.adapters.slack import (
            SlackAdapter,
            _verify_slack_signature,
        )

        cache.clear()
        factory = RequestFactory()
        body = {"type": "event_callback", "event": {"type": "message"}}
        body_bytes = json.dumps(body).encode()
        ts = str(int(time.time()))
        signing_secret = "test_signing_secret"

        import hashlib
        import hmac as hmac_mod
        sig_base = f"v0:{ts}:{body_bytes.decode()}"
        sig = "v0=" + hmac_mod.new(
            signing_secret.encode(), sig_base.encode(), hashlib.sha256
        ).hexdigest()

        def make_req():
            return factory.post(
                "/",
                data=body_bytes,
                content_type="application/json",
                HTTP_X_SLACK_REQUEST_TIMESTAMP=ts,
                HTTP_X_SLACK_SIGNATURE=sig,
            )

        account = MagicMock()
        account.config = {"signing_secret": signing_secret, "bot_token": "xoxb-test"}

        adapter = SlackAdapter()
        adapter.parse_webhook(make_req(), account)
        result2 = adapter.parse_webhook(make_req(), account)
        self.assertIsNone(result2)


class DE15DiscordInteractionTokenTest(SimpleTestCase):
    """DE-15: interaction_token must NOT appear in persisted metadata."""

    @patch("apps.channel_gateway.adapters.discord._verify_ed25519", return_value=True)
    def test_interaction_token_stripped_from_metadata(self, _mock_verify):
        from apps.channel_gateway.adapters.discord import DiscordAdapter

        factory = RequestFactory()
        body = {
            "type": 2,
            "id": "inter_123",
            "token": "SENSITIVE_INTERACTION_TOKEN_VALUE",
            "data": {"name": "hello", "options": []},
            "member": {"user": {"id": "user_1", "username": "tester"}},
            "channel_id": "ch_1",
            "guild_id": "guild_1",
        }
        req = factory.post(
            "/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_SIGNATURE_ED25519="aabbcc",
            HTTP_X_SIGNATURE_TIMESTAMP="12345",
        )

        account = MagicMock()
        account.config = {"public_key": "deadbeef" * 8}
        account.account_id = "acc_1"
        account.organization_id = "ws_1"

        adapter = DiscordAdapter()
        result = adapter.parse_webhook(req, account)
        self.assertIsNotNone(result)
        self.assertNotIn("interaction_token", result.metadata)
        self.assertNotIn("SENSITIVE_INTERACTION_TOKEN_VALUE", json.dumps(result.metadata))


class DE16WebhookRateLimitTest(SimpleTestCase):
    """DE-16: IP-based rate limiting on webhook endpoints."""

    @override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
    def test_rate_limit_triggers_after_threshold(self):
        from django.core.cache import cache

        cache.clear()
        factory = RequestFactory()

        for i in range(61):
            req = factory.post(
                "/channel-gateway/webhook/feishu/tok/",
                data="{}",
                content_type="application/json",
                REMOTE_ADDR="10.0.0.99",
            )
            result = _is_rate_limited(req)
            if i < 60:
                self.assertFalse(result, f"Request {i+1} should not be rate limited")
            else:
                self.assertTrue(result, "Request 61 should be rate limited")

    @override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token", return_value=None)
    def test_rate_limited_returns_429(self, _mock_resolve):
        from django.core.cache import cache

        cache.clear()
        factory = RequestFactory()

        for _ in range(60):
            req = factory.post("/", data="{}", content_type="application/json", REMOTE_ADDR="10.0.0.88")
            channel_webhook(req, "feishu", "a" * 32)

        req = factory.post("/", data="{}", content_type="application/json", REMOTE_ADDR="10.0.0.88")
        resp = channel_webhook(req, "feishu", "a" * 32)
        self.assertEqual(resp.status_code, 429)

    @override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
    def test_different_ips_not_affected(self):
        from django.core.cache import cache

        cache.clear()
        factory = RequestFactory()

        for _ in range(60):
            req = factory.post("/", data="{}", content_type="application/json", REMOTE_ADDR="10.0.0.1")
            _is_rate_limited(req)

        req2 = factory.post("/", data="{}", content_type="application/json", REMOTE_ADDR="10.0.0.2")
        self.assertFalse(_is_rate_limited(req2))

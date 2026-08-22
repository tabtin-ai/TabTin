"""Webhook view 测试 — 使用 Django RequestFactory。"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from django.http import HttpRequest, JsonResponse
from django.test import RequestFactory, SimpleTestCase

from apps.channel_gateway.adapters.base import WebhookChallengeResponse, WebhookRejectError
from apps.channel_gateway.views.webhook import (
    _handle_get_challenge,
    _handle_post_challenge,
    channel_webhook,
)


class HandleGetChallengeTest(SimpleTestCase):
    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_returns_challenge(self, mock_resolve):
        mock_resolve.return_value = MagicMock()
        factory = RequestFactory()
        req = factory.get("/webhook/feishu/tok/?challenge=abc")
        resp = _handle_get_challenge(req, "feishu", "tok")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content), {"challenge": "abc"})

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_challenge_invalid_token_returns_403(self, mock_resolve):
        mock_resolve.return_value = None
        factory = RequestFactory()
        req = factory.get("/webhook/feishu/tok/?challenge=abc")
        resp = _handle_get_challenge(req, "feishu", "tok")
        self.assertEqual(resp.status_code, 403)

    def test_no_challenge_returns_ok(self):
        factory = RequestFactory()
        req = factory.get("/webhook/feishu/tok/")
        resp = _handle_get_challenge(req, "feishu", "tok")
        self.assertEqual(json.loads(resp.content), {"ok": True})

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_whatsapp_hub_challenge(self, mock_resolve):
        """WhatsApp GET challenge: hub.mode=subscribe, hub.verify_token, hub.challenge"""
        mock_account = MagicMock()
        mock_account.config = {"verify_token": "my_secret"}
        mock_resolve.return_value = mock_account

        factory = RequestFactory()
        req = factory.get(
            "/webhook/whatsapp/tok/"
            "?hub.mode=subscribe&hub.verify_token=my_secret&hub.challenge=challenge_string"
        )
        resp = _handle_get_challenge(req, "whatsapp", "tok")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.content.decode(), "challenge_string")
        self.assertEqual(resp["Content-Type"], "text/plain")

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_whatsapp_hub_challenge_bad_verify_token(self, mock_resolve):
        """WhatsApp GET challenge with wrong verify_token returns 403."""
        mock_account = MagicMock()
        mock_account.config = {"verify_token": "correct_token"}
        mock_resolve.return_value = mock_account

        factory = RequestFactory()
        req = factory.get(
            "/webhook/whatsapp/tok/"
            "?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=c"
        )
        resp = _handle_get_challenge(req, "whatsapp", "tok")
        self.assertEqual(resp.status_code, 403)

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_whatsapp_hub_challenge_invalid_token_returns_403(self, mock_resolve):
        """WhatsApp GET subscribe with invalid webhook_token returns 403."""
        mock_resolve.return_value = None
        factory = RequestFactory()
        req = factory.get(
            "/webhook/whatsapp/tok/"
            "?hub.mode=subscribe&hub.verify_token=whatever&hub.challenge=c"
        )
        resp = _handle_get_challenge(req, "whatsapp", "tok")
        self.assertEqual(resp.status_code, 403)


class HandlePostChallengeTest(SimpleTestCase):
    def test_url_verification(self):
        factory = RequestFactory()
        body = {"type": "url_verification", "challenge": "test_challenge", "token": "t"}
        req = factory.post("/", data=json.dumps(body), content_type="application/json")
        resp = _handle_post_challenge(req)
        self.assertIsNotNone(resp)
        self.assertEqual(json.loads(resp.content)["challenge"], "test_challenge")

    def test_encrypted_payload_returns_none(self):
        factory = RequestFactory()
        body = {"encrypt": "base64data"}
        req = factory.post("/", data=json.dumps(body), content_type="application/json")
        self.assertIsNone(_handle_post_challenge(req))

    def test_invalid_json_returns_none(self):
        factory = RequestFactory()
        req = factory.post("/", data="not json", content_type="text/plain")
        self.assertIsNone(_handle_post_challenge(req))


class ChannelWebhookViewTest(SimpleTestCase):
    def _post(self, body_dict: dict, channel_id="feishu", token="a" * 32):
        factory = RequestFactory()
        return factory.post(
            f"/channel-gateway/webhook/{channel_id}/{token}/",
            data=json.dumps(body_dict),
            content_type="application/json",
        )

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_get_returns_challenge(self, mock_resolve):
        mock_resolve.return_value = MagicMock()
        factory = RequestFactory()
        req = factory.get("/channel-gateway/webhook/feishu/tok/?challenge=c")
        resp = channel_webhook(req, "feishu", "tok")
        self.assertEqual(json.loads(resp.content)["challenge"], "c")

    def test_method_not_allowed(self):
        factory = RequestFactory()
        req = factory.put("/", data="{}", content_type="application/json")
        resp = channel_webhook(req, "feishu", "tok")
        self.assertEqual(resp.status_code, 405)

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token", return_value=None)
    def test_invalid_token_returns_403(self, _):
        body = {"schema": "2.0", "header": {}, "event": {}}
        resp = channel_webhook(self._post(body), "feishu", "a" * 32)
        self.assertEqual(resp.status_code, 403)

    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    @patch("apps.channel_gateway.views.webhook.ChannelAdapterRegistry")
    def test_unknown_channel_returns_404(self, mock_registry, mock_resolve):
        mock_resolve.return_value = MagicMock()
        mock_registry.get.return_value = None
        body = {"schema": "2.0", "header": {}, "event": {}}
        resp = channel_webhook(self._post(body), "unknown", "a" * 32)
        self.assertEqual(resp.status_code, 404)

    @patch("apps.channel_gateway.views.webhook.ChannelInboundService")
    @patch("apps.channel_gateway.views.webhook.ChannelAdapterRegistry")
    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_adapter_challenge_exception_returns_challenge(self, mock_resolve, mock_registry, _svc):
        mock_resolve.return_value = MagicMock()
        adapter = MagicMock()
        adapter.parse_webhook.side_effect = WebhookChallengeResponse("my_challenge")
        mock_registry.get.return_value = adapter
        body = {"encrypt": "data"}
        resp = channel_webhook(self._post(body), "feishu", "a" * 32)
        self.assertEqual(json.loads(resp.content)["challenge"], "my_challenge")

    @patch("apps.channel_gateway.views.webhook.ChannelInboundService")
    @patch("apps.channel_gateway.views.webhook.ChannelAdapterRegistry")
    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_raw_json_challenge_returns_raw_body(self, mock_resolve, mock_registry, _svc):
        """Discord PING/PONG: raw_json=True should return raw JSON body, not wrapped."""
        mock_resolve.return_value = MagicMock()
        adapter = MagicMock()
        adapter.parse_webhook.side_effect = WebhookChallengeResponse(
            '{"type": 1}', raw_json=True,
        )
        mock_registry.get.return_value = adapter
        body = {"type": 1}
        resp = channel_webhook(self._post(body, channel_id="discord"), "discord", "a" * 32)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content), {"type": 1})
        self.assertIn("application/json", resp["Content-Type"])

    @patch("apps.channel_gateway.tasks.process_inbound_message.delay")
    @patch("apps.channel_gateway.views.webhook.ChannelAdapterRegistry")
    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_successful_inbound_returns_ok(self, mock_resolve, mock_registry, mock_delay):
        mock_resolve.return_value = MagicMock()
        adapter = MagicMock()
        adapter.parse_webhook.return_value = MagicMock()
        mock_registry.get.return_value = adapter
        body = {"schema": "2.0", "header": {}, "event": {}}
        resp = channel_webhook(self._post(body), "feishu", "a" * 32)
        self.assertEqual(resp.status_code, 200)
        mock_delay.assert_called_once()

    @patch("apps.channel_gateway.views.webhook.ChannelAdapterRegistry")
    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_adapter_parse_exception_returns_ok(self, mock_resolve, mock_registry):
        mock_resolve.return_value = MagicMock()
        adapter = MagicMock()
        adapter.parse_webhook.side_effect = RuntimeError("boom")
        mock_registry.get.return_value = adapter
        body = {"data": "x"}
        resp = channel_webhook(self._post(body), "feishu", "a" * 32)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content), {"ok": True})

    @patch("apps.channel_gateway.views.webhook.ChannelAdapterRegistry")
    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_webhook_reject_error_returns_400(self, mock_resolve, mock_registry):
        """WebhookRejectError should return 400, not 200."""
        mock_resolve.return_value = MagicMock()
        adapter = MagicMock()
        adapter.parse_webhook.side_effect = WebhookRejectError("bad signature")
        mock_registry.get.return_value = adapter
        body = {"data": "x"}
        resp = channel_webhook(self._post(body), "feishu", "a" * 32)
        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.content)
        self.assertFalse(data["ok"])
        self.assertIn("bad signature", data["error"])

    @patch("apps.channel_gateway.views.webhook.ChannelAdapterRegistry")
    @patch("apps.channel_gateway.views.webhook._resolve_account_by_webhook_token")
    def test_value_error_returns_400(self, mock_resolve, mock_registry):
        """ValueError from parse_webhook should return 400."""
        mock_resolve.return_value = MagicMock()
        adapter = MagicMock()
        adapter.parse_webhook.side_effect = ValueError("invalid payload")
        mock_registry.get.return_value = adapter
        body = {"data": "x"}
        resp = channel_webhook(self._post(body), "feishu", "a" * 32)
        self.assertEqual(resp.status_code, 400)

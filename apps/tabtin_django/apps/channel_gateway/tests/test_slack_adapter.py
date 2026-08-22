"""SlackAdapter 纯单元测试（不依赖数据库和网络）。"""

from __future__ import annotations

import hmac
import hashlib
import json
import time
from unittest.mock import MagicMock

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.base import WebhookChallengeResponse
from apps.channel_gateway.adapters.slack import (
    SlackAdapter,
    _check_timestamp_freshness,
    _verify_slack_signature,
    _extract_media_from_files,
    TIMESTAMP_TOLERANCE_SECONDS,
)

_DEFAULT_SIGNING_SECRET = "test_signing_secret"


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "bot_token": "xoxb-test-token",
        "signing_secret": _DEFAULT_SIGNING_SECRET,
    })
    for k, v in overrides.items():
        setattr(acct, k, v)
    return acct


def _make_request(body_dict: dict, headers: dict | None = None) -> HttpRequest:
    raw = json.dumps(body_dict).encode()
    req = HttpRequest()
    req._body = raw
    req.method = "POST"
    req.content_type = "application/json"
    if headers:
        for k, v in headers.items():
            req.META[f"HTTP_{k.upper().replace('-', '_')}"] = v
    return req


def _compute_slack_signature(signing_secret: str, timestamp: str, body_str: str) -> str:
    sig_basestring = f"v0:{timestamp}:{body_str}"
    computed = "v0=" + hmac.new(
        signing_secret.encode("utf-8"),
        sig_basestring.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return computed


def _signed_request(
    body_dict: dict,
    signing_secret: str = _DEFAULT_SIGNING_SECRET,
) -> HttpRequest:
    raw = json.dumps(body_dict).encode()
    body_str = raw.decode("utf-8")
    ts = str(int(time.time()))
    sig = _compute_slack_signature(signing_secret, ts, body_str)
    return _make_request(body_dict, {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
    })


# ---------------------------------------------------------------------------
# 1. Identity / Capabilities
# ---------------------------------------------------------------------------


class TestSlackAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "slack")
        self.assertEqual(self.adapter.name, "Slack")

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.threads)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)
        self.assertIn("channel", caps.chat_types)


# ---------------------------------------------------------------------------
# 2. Config validation
# ---------------------------------------------------------------------------


class TestSlackAdapterConfigValidation(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_missing_bot_token_returns_error(self):
        errors = self.adapter.validate_config({"signing_secret": "s"})
        self.assertTrue(any("bot_token" in e.lower() for e in errors))

    def test_empty_bot_token_returns_error(self):
        errors = self.adapter.validate_config({"bot_token": "", "signing_secret": "s"})
        self.assertGreater(len(errors), 0)

    def test_bot_token_not_xoxb_prefix_returns_error(self):
        errors = self.adapter.validate_config({
            "bot_token": "xoxp-xxx",
            "signing_secret": "s",
        })
        self.assertEqual(len(errors), 1)
        self.assertTrue(any("xoxb-" in e.lower() for e in errors))

    def test_missing_signing_secret_returns_error(self):
        errors = self.adapter.validate_config({"bot_token": "xoxb-123"})
        self.assertTrue(any("signing_secret" in e.lower() for e in errors))

    def test_missing_all(self):
        errors = self.adapter.validate_config({})
        self.assertEqual(len(errors), 2)

    def test_valid_config_passes(self):
        errors = self.adapter.validate_config({
            "bot_token": "invalid-slack-bot-token",
            "signing_secret": "my_secret",
        })
        self.assertEqual(errors, [])


# ---------------------------------------------------------------------------
# 3. URL verification challenge
# ---------------------------------------------------------------------------


class TestSlackUrlVerificationChallenge(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_url_verification_raises_challenge(self):
        body = {"type": "url_verification", "challenge": "challenge_token_abc123"}
        req = _make_request(body)
        acct = _make_account()

        with self.assertRaises(WebhookChallengeResponse) as ctx:
            self.adapter.parse_webhook(req, acct)
        self.assertEqual(ctx.exception.challenge, "challenge_token_abc123")


# ---------------------------------------------------------------------------
# 4. Webhook parsing (event_callback + message)
# ---------------------------------------------------------------------------


def _make_message_event(
    text: str = "hello",
    channel: str = "C123456",
    user: str = "U123456",
    channel_type: str = "channel",
    ts: str | None = None,
    thread_ts: str | None = None,
    files: list | None = None,
    **event_overrides,
) -> dict:
    ts = ts or str(time.time())
    event = {
        "type": "message",
        "text": text,
        "channel": channel,
        "user": user,
        "channel_type": channel_type,
        "ts": ts,
        **event_overrides,
    }
    if thread_ts:
        event["thread_ts"] = thread_ts
    if files:
        event["files"] = files
    return {
        "type": "event_callback",
        "team_id": "T123",
        "event_id": "Ev123",
        "event": event,
    }


class TestSlackWebhookParsing(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_event_callback_message_parsed_to_channel_inbound_message(self):
        body = _make_message_event("hello world", channel_type="im")
        req = _signed_request(body)
        acct = _make_account()

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.channel, "slack")
        self.assertEqual(msg.text, "hello world")
        self.assertEqual(msg.peer_kind, "dm")
        self.assertEqual(msg.peer_id, "C123456")
        self.assertEqual(msg.sender_id, "U123456")

    def test_channel_type_im_maps_to_dm(self):
        body = _make_message_event("dm msg", channel_type="im")
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertEqual(msg.peer_kind, "dm")

    def test_channel_type_channel_maps_to_group(self):
        body = _make_message_event("channel msg", channel_type="channel")
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertEqual(msg.peer_kind, "group")

    def test_non_event_callback_returns_none(self):
        body = {"type": "app_mention", "event": {}}
        req = _signed_request(body)
        self.assertIsNone(self.adapter.parse_webhook(req, _make_account()))

    def test_invalid_json_returns_none(self):
        req = HttpRequest()
        req._body = b"not json"
        req.method = "POST"
        self.assertIsNone(self.adapter.parse_webhook(req, _make_account()))


# ---------------------------------------------------------------------------
# 5. Bot message filtering
# ---------------------------------------------------------------------------


class TestSlackBotMessageFiltering(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_message_with_bot_id_ignored(self):
        body = _make_message_event("bot said this", bot_id="B123")
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertIsNone(msg)


# ---------------------------------------------------------------------------
# 6. Subtype filtering
# ---------------------------------------------------------------------------


class TestSlackSubtypeFiltering(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_message_with_subtype_ignored(self):
        body = _make_message_event("changed", subtype="message_changed")
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertIsNone(msg)

    def test_bot_message_subtype_ignored(self):
        body = _make_message_event("bot msg", subtype="bot_message")
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertIsNone(msg)


# ---------------------------------------------------------------------------
# 7. Signature verification
# ---------------------------------------------------------------------------


class TestSlackSignatureVerification(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_valid_signature_passes(self):
        signing_secret = "my_signing_secret"
        timestamp = str(int(time.time()))
        body_dict = _make_message_event("signed message")
        body_str = json.dumps(body_dict)
        signature = _compute_slack_signature(signing_secret, timestamp, body_str)

        req = _make_request(body_dict, {
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": signature,
        })
        acct = _make_account(config={
            "bot_token": "xoxb-test",
            "signing_secret": signing_secret,
        })
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "signed message")

    def test_invalid_signature_returns_none(self):
        timestamp = str(int(time.time()))
        body_dict = _make_message_event("test")
        req = _make_request(body_dict, {
            "X-Slack-Request-Timestamp": timestamp,
            "X-Slack-Signature": "v0=bad_signature",
        })
        acct = _make_account(config={
            "bot_token": "xoxb-test",
            "signing_secret": "secret",
        })
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_missing_signature_header_with_signing_secret_returns_none(self):
        body_dict = _make_message_event("no sig")
        req = _make_request(body_dict)
        acct = _make_account(config={
            "bot_token": "xoxb-test",
            "signing_secret": "my_secret",
        })
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_missing_signing_secret_returns_none(self):
        body_dict = _make_message_event("no secret")
        req = _signed_request(body_dict)
        acct = _make_account(config={"bot_token": "xoxb-test"})
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


class TestVerifySlackSignature(SimpleTestCase):
    def test_correct_signature(self):
        secret = "my_secret"
        ts = "1234567890"
        body = b'{"type":"event_callback","event":{"type":"message"}}'
        body_str = body.decode()
        sig = _compute_slack_signature(secret, ts, body_str)
        self.assertTrue(_verify_slack_signature(secret, ts, body, sig))

    def test_wrong_signature(self):
        self.assertFalse(_verify_slack_signature(
            "secret", "123", b'{"a":1}', "v0=wrong"
        ))


# ---------------------------------------------------------------------------
# 8. Timestamp freshness
# ---------------------------------------------------------------------------


class TestSlackTimestampFreshness(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_stale_timestamp_rejected(self):
        signing_secret = "secret"
        stale_ts = str(int(time.time()) - TIMESTAMP_TOLERANCE_SECONDS - 60)
        body_dict = _make_message_event("old message")
        body_str = json.dumps(body_dict)
        signature = _compute_slack_signature(signing_secret, stale_ts, body_str)

        req = _make_request(body_dict, {
            "X-Slack-Request-Timestamp": stale_ts,
            "X-Slack-Signature": signature,
        })
        acct = _make_account(config={
            "bot_token": "xoxb-test",
            "signing_secret": signing_secret,
        })
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


class TestCheckTimestampFreshness(SimpleTestCase):
    def test_fresh_timestamp(self):
        self.assertTrue(_check_timestamp_freshness(str(int(time.time()))))

    def test_stale_timestamp(self):
        self.assertFalse(_check_timestamp_freshness(
            str(int(time.time()) - TIMESTAMP_TOLERANCE_SECONDS - 100)
        ))

    def test_empty_timestamp(self):
        self.assertFalse(_check_timestamp_freshness(""))

    def test_non_numeric_timestamp(self):
        self.assertFalse(_check_timestamp_freshness("abc"))


# ---------------------------------------------------------------------------
# 9. Media extraction
# ---------------------------------------------------------------------------


class TestSlackMediaExtraction(SimpleTestCase):
    def setUp(self):
        self.adapter = SlackAdapter()

    def test_extract_image_from_files(self):
        files = [
            {
                "id": "F001",
                "name": "photo.png",
                "mimetype": "image/png",
                "url_private": "https://files.slack.com/private/photo.png",
                "size": 1024,
            },
        ]
        result = _extract_media_from_files(files)
        self.assertIsNotNone(result)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].kind, "image")
        self.assertEqual(result[0].url, "https://files.slack.com/private/photo.png")
        self.assertEqual(result[0].file_id, "F001")
        self.assertEqual(result[0].filename, "photo.png")
        self.assertEqual(result[0].mime_type, "image/png")
        self.assertEqual(result[0].size, 1024)

    def test_extract_video_and_audio(self):
        files = [
            {"id": "V1", "mimetype": "video/mp4", "url_private_download": "https://v.mp4"},
            {"id": "A1", "mimetype": "audio/mpeg", "permalink": "https://a.mp3"},
        ]
        result = _extract_media_from_files(files)
        self.assertIsNotNone(result)
        self.assertEqual(result[0].kind, "video")
        self.assertEqual(result[1].kind, "audio")

    def test_extract_generic_file(self):
        files = [{"id": "F1", "mimetype": "application/pdf", "name": "doc.pdf"}]
        result = _extract_media_from_files(files)
        self.assertIsNotNone(result)
        self.assertEqual(result[0].kind, "file")

    def test_empty_files_returns_none(self):
        self.assertIsNone(_extract_media_from_files([]))
        self.assertIsNone(_extract_media_from_files(None))

    def test_message_with_files_parsed_with_media(self):
        files = [
            {
                "id": "F001",
                "name": "img.png",
                "mimetype": "image/png",
                "url_private": "https://example.com/img.png",
            },
        ]
        body = _make_message_event("see attachment", files=files)
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertIsNotNone(msg.media)
        self.assertEqual(len(msg.media), 1)
        self.assertEqual(msg.media[0].kind, "image")


# ---------------------------------------------------------------------------
# 10. Config schema
# ---------------------------------------------------------------------------


class TestSlackConfigSchema(SimpleTestCase):
    def test_schema_has_required_fields(self):
        schema = SlackAdapter().get_config_schema()
        self.assertIn("bot_token", schema["properties"])
        self.assertIn("bot_token", schema["required"])
        self.assertIn("signing_secret", schema["properties"])
        self.assertIn("signing_secret", schema["required"])
        self.assertEqual(schema["type"], "object")

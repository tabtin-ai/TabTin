"""MattermostAdapter 纯单元测试（不依赖数据库和网络）。"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.mattermost import MattermostAdapter

_DEFAULT_WEBHOOK_SECRET = "webhook_secret_token"


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "server_url": "https://mattermost.example.com",
        "bot_token": "token_test",
        "webhook_secret": _DEFAULT_WEBHOOK_SECRET,
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


def _outgoing_webhook_body(**overrides) -> dict:
    body = {
        "token": _DEFAULT_WEBHOOK_SECRET,
        "team_id": "team-001",
        "team_domain": "myteam",
        "channel_id": "channel-001",
        "channel_name": "town-square",
        "timestamp": 1700000000,
        "user_id": "user-001",
        "user_name": "alice",
        "post_id": "post-001",
        "text": "Hello Mattermost Bot",
    }
    body.update(overrides)
    return body


class TestMattermostAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = MattermostAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "mattermost")
        self.assertIn("Mattermost", self.adapter.name)

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.threads)
        self.assertTrue(caps.reactions)
        self.assertTrue(caps.supports_webhook)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)


class TestMattermostAdapterValidateConfig(SimpleTestCase):
    def setUp(self):
        self.adapter = MattermostAdapter()

    def test_valid_config(self):
        errors = self.adapter.validate_config({
            "server_url": "https://mattermost.example.com",
            "bot_token": "abcdefghij1234567890",
            "webhook_secret": "ws_123",
        })
        self.assertEqual(errors, [])

    def test_missing_required_field(self):
        errors = self.adapter.validate_config({})
        self.assertTrue(len(errors) >= 3)
        joined = " ".join(errors).lower()
        self.assertIn("server_url", joined)
        self.assertIn("bot_token", joined)
        self.assertIn("webhook_secret", joined)

    def test_missing_server_url(self):
        errors = self.adapter.validate_config({
            "bot_token": "tok",
            "webhook_secret": "ws",
        })
        self.assertTrue(any("server_url" in e.lower() for e in errors))

    def test_missing_bot_token(self):
        errors = self.adapter.validate_config({
            "server_url": "https://mm.example.com",
            "webhook_secret": "ws",
        })
        self.assertTrue(any("bot_token" in e.lower() for e in errors))

    def test_missing_webhook_secret(self):
        errors = self.adapter.validate_config({
            "server_url": "https://mm.example.com",
            "bot_token": "tok",
        })
        self.assertTrue(any("webhook_secret" in e.lower() for e in errors))

    def test_server_url_must_be_http(self):
        errors = self.adapter.validate_config({
            "server_url": "ftp://mm.example.com",
            "bot_token": "tok",
            "webhook_secret": "ws",
        })
        self.assertTrue(any("http" in e.lower() for e in errors))


class TestMattermostAdapterConfigSchema(SimpleTestCase):
    def setUp(self):
        self.adapter = MattermostAdapter()

    def test_schema_has_required_fields(self):
        schema = self.adapter.get_config_schema()
        self.assertIn("server_url", schema["properties"])
        self.assertIn("bot_token", schema["properties"])
        self.assertIn("webhook_secret", schema["properties"])
        self.assertIn("server_url", schema["required"])
        self.assertIn("bot_token", schema["required"])
        self.assertIn("webhook_secret", schema["required"])

    def test_schema_bot_token_is_sensitive(self):
        schema = self.adapter.get_config_schema()
        self.assertTrue(schema["properties"]["bot_token"].get("sensitive"))

    def test_schema_webhook_secret_is_sensitive(self):
        schema = self.adapter.get_config_schema()
        self.assertTrue(schema["properties"]["webhook_secret"].get("sensitive"))


class TestMattermostAdapterParseWebhook(SimpleTestCase):
    def setUp(self):
        self.adapter = MattermostAdapter()

    def test_parse_text_message(self):
        body = _outgoing_webhook_body()
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "Hello Mattermost Bot")
        self.assertEqual(result.peer_id, "channel-001")
        self.assertEqual(result.sender_id, "user-001")
        self.assertEqual(result.channel, "mattermost")
        self.assertEqual(result.peer_kind, "group")
        self.assertEqual(result.message_id, "post-001")

    def test_parse_dm_channel(self):
        body = _outgoing_webhook_body(channel_name="__user1__user2")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.peer_kind, "dm")

    def test_trigger_word_stripped(self):
        body = _outgoing_webhook_body(
            text="!bot Hello world",
            trigger_word="!bot",
        )
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "Hello world")
        self.assertEqual(result.metadata["trigger_word"], "!bot")

    def test_parse_returns_none_for_empty_text(self):
        body = _outgoing_webhook_body(text="")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_parse_returns_none_for_non_message(self):
        body = _outgoing_webhook_body(text="   ")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_missing_channel_id_returns_none(self):
        body = _outgoing_webhook_body()
        body.pop("channel_id")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_missing_user_id_returns_none(self):
        body = _outgoing_webhook_body()
        body.pop("user_id")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_invalid_body_returns_none(self):
        req = HttpRequest()
        req._body = b"not json at all"
        req.method = "POST"
        account = _make_account()
        result = self.adapter.parse_webhook(req, account)
        self.assertIsNone(result)

    def test_metadata_fields(self):
        body = _outgoing_webhook_body()
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.metadata["team_id"], "team-001")
        self.assertEqual(result.metadata["team_domain"], "myteam")
        self.assertEqual(result.metadata["channel_name"], "town-square")
        self.assertEqual(result.metadata["user_name"], "alice")

    def test_file_ids_resolved(self):
        body = _outgoing_webhook_body(file_ids=["file-001", "file-002"])
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(len(result.media), 2)
        self.assertIn("file-001", result.media[0].url)
        self.assertEqual(result.media[0].file_id, "file-001")


class TestMattermostTokenVerification(SimpleTestCase):
    def setUp(self):
        self.adapter = MattermostAdapter()
        self.body = _outgoing_webhook_body(token="correct_secret")

    def test_signature_verification_pass(self):
        account = _make_account(config={
            "server_url": "https://mm.example.com",
            "bot_token": "tok",
            "webhook_secret": "correct_secret",
        })
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "Hello Mattermost Bot")

    def test_signature_verification_fail(self):
        account = _make_account(config={
            "server_url": "https://mm.example.com",
            "bot_token": "tok",
            "webhook_secret": "wrong_secret",
        })
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)

    def test_missing_webhook_secret_config_rejects(self):
        account = _make_account(config={
            "server_url": "https://mm.example.com",
            "bot_token": "tok",
        })
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)

    def test_missing_token_in_body_returns_none(self):
        body = _outgoing_webhook_body()
        body.pop("token", None)
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)


class TestMattermostAdapterChunkText(SimpleTestCase):
    def setUp(self):
        self.adapter = MattermostAdapter()

    def test_short_text_not_chunked(self):
        chunks = self.adapter.chunk_text("hello", 100)
        self.assertEqual(len(chunks), 1)

    def test_long_text_chunked(self):
        text = "a" * 200
        chunks = self.adapter.chunk_text(text, 100)
        self.assertTrue(len(chunks) >= 2)
        self.assertEqual("".join(chunks), text)

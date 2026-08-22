"""TelegramAdapter 纯单元测试（不依赖数据库和网络）。"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.telegram import TelegramAdapter

_DEFAULT_SECRET = "test_secret_token"


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "bot_token": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        "secret_token": _DEFAULT_SECRET,
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


def _authed_request(body_dict: dict, secret: str = _DEFAULT_SECRET) -> HttpRequest:
    """Create a request with the correct secret_token header."""
    return _make_request(body_dict, {"X-Telegram-Bot-Api-Secret-Token": secret})


class TestTelegramAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = TelegramAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "telegram")
        self.assertIn("Telegram", self.adapter.name)

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.supports_polling)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)


class TestTelegramAdapterValidateConfig(SimpleTestCase):
    def setUp(self):
        self.adapter = TelegramAdapter()

    def test_valid_config(self):
        errors = self.adapter.validate_config({
            "bot_token": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
            "secret_token": "my_secret",
        })
        self.assertEqual(errors, [])

    def test_missing_bot_token(self):
        errors = self.adapter.validate_config({"secret_token": "s"})
        self.assertTrue(len(errors) > 0)
        self.assertIn("bot_token", errors[0].lower())

    def test_invalid_token_format(self):
        errors = self.adapter.validate_config({"bot_token": "not-a-valid-token", "secret_token": "s"})
        self.assertTrue(len(errors) > 0)

    def test_missing_secret_token(self):
        errors = self.adapter.validate_config({"bot_token": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"})
        self.assertTrue(any("secret_token" in e.lower() for e in errors))

    def test_missing_all(self):
        errors = self.adapter.validate_config({})
        self.assertTrue(len(errors) >= 2)


class TestTelegramAdapterConfigSchema(SimpleTestCase):
    def setUp(self):
        self.adapter = TelegramAdapter()

    def test_schema_has_bot_token(self):
        schema = self.adapter.get_config_schema()
        self.assertIn("bot_token", schema["properties"])

    def test_schema_has_secret_token(self):
        schema = self.adapter.get_config_schema()
        self.assertIn("secret_token", schema["properties"])
        self.assertTrue(schema["properties"]["secret_token"].get("sensitive"))
        self.assertIn("secret_token", schema["required"])


class TestTelegramAdapterParseWebhook(SimpleTestCase):
    def setUp(self):
        self.adapter = TelegramAdapter()

    def test_parse_text_message(self):
        body = {
            "update_id": 1,
            "message": {
                "message_id": 42,
                "from": {"id": 100, "first_name": "Alice", "username": "alice"},
                "chat": {"id": 200, "type": "private"},
                "date": 1700000000,
                "text": "Hello bot",
            }
        }
        account = _make_account()
        result = self.adapter.parse_webhook(_authed_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "Hello bot")
        self.assertEqual(result.peer_id, "200")
        self.assertEqual(result.sender_id, "100")
        self.assertEqual(result.channel, "telegram")

    def test_parse_group_message_with_mention(self):
        body = {
            "update_id": 2,
            "message": {
                "message_id": 43,
                "from": {"id": 100, "first_name": "Alice"},
                "chat": {"id": -300, "type": "group"},
                "date": 1700000001,
                "text": "@bot hello",
                "entities": [{"type": "mention", "offset": 0, "length": 4}],
            }
        }
        account = _make_account()
        result = self.adapter.parse_webhook(_authed_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.peer_kind, "group")
        self.assertTrue(result.metadata.get("mentioned"))

    def test_parse_photo_message(self):
        body = {
            "update_id": 3,
            "message": {
                "message_id": 44,
                "from": {"id": 100, "first_name": "Alice"},
                "chat": {"id": 200, "type": "private"},
                "date": 1700000002,
                "photo": [
                    {"file_id": "small", "file_size": 100},
                    {"file_id": "large", "file_size": 5000},
                ],
                "caption": "my pic",
            }
        }
        account = _make_account()
        result = self.adapter.parse_webhook(_authed_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "my pic")
        self.assertEqual(len(result.media), 1)
        self.assertEqual(result.media[0].file_id, "large")

    def test_parse_empty_update_returns_none(self):
        body = {"update_id": 4}
        account = _make_account()
        result = self.adapter.parse_webhook(_authed_request(body), account)
        self.assertIsNone(result)

    def test_invalid_json_returns_none(self):
        req = HttpRequest()
        req._body = b"not json"
        req.method = "POST"
        account = _make_account()
        result = self.adapter.parse_webhook(req, account)
        self.assertIsNone(result)


class TestTelegramSecretTokenVerification(SimpleTestCase):
    """secret_token 校验逻辑测试。"""

    def setUp(self):
        self.adapter = TelegramAdapter()
        self.body = {
            "update_id": 10,
            "message": {
                "message_id": 50,
                "from": {"id": 100, "first_name": "Alice"},
                "chat": {"id": 200, "type": "private"},
                "date": 1700000000,
                "text": "hello",
            }
        }

    def test_missing_secret_token_config_rejects(self):
        account = _make_account(config={"bot_token": "123:ABC"})
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)

    def test_valid_secret_token_passes(self):
        account = _make_account(config={"bot_token": "123:ABC", "secret_token": "my_secret"})
        headers = {"X-Telegram-Bot-Api-Secret-Token": "my_secret"}
        result = self.adapter.parse_webhook(_make_request(self.body, headers), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "hello")

    def test_wrong_secret_token_returns_none(self):
        account = _make_account(config={"bot_token": "123:ABC", "secret_token": "my_secret"})
        headers = {"X-Telegram-Bot-Api-Secret-Token": "wrong_secret"}
        result = self.adapter.parse_webhook(_make_request(self.body, headers), account)
        self.assertIsNone(result)

    def test_missing_secret_token_header_returns_none(self):
        account = _make_account(config={"bot_token": "123:ABC", "secret_token": "my_secret"})
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)

    def test_empty_secret_token_config_rejects(self):
        account = _make_account(config={"bot_token": "123:ABC", "secret_token": ""})
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)


class TestTelegramAdapterChunkText(SimpleTestCase):
    def setUp(self):
        self.adapter = TelegramAdapter()

    def test_short_text_not_chunked(self):
        chunks = self.adapter.chunk_text("hello", 100)
        self.assertEqual(len(chunks), 1)

    def test_long_text_chunked(self):
        text = "a" * 200
        chunks = self.adapter.chunk_text(text, 100)
        self.assertTrue(len(chunks) >= 2)
        self.assertEqual("".join(chunks), text)

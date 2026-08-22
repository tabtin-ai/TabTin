"""GoogleChatAdapter 纯单元测试（不依赖数据库和网络）。"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.googlechat import GoogleChatAdapter


_SA_JSON = json.dumps({
    "type": "service_account",
    "client_email": "bot@project.iam.gserviceaccount.com",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    "token_uri": "https://oauth2.googleapis.com/token",
})


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "service_account_json": _SA_JSON,
        "audience": "https://example.com/webhook",
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


def _message_event_body(**overrides) -> dict:
    body = {
        "type": "MESSAGE",
        "eventTime": "2024-01-15T10:30:00Z",
        "space": {
            "name": "spaces/AAAA",
            "type": "DM",
            "displayName": "Test Space",
        },
        "message": {
            "name": "spaces/AAAA/messages/BBBB",
            "text": "Hello bot",
            "argumentText": "Hello bot",
            "sender": {
                "name": "users/12345",
                "displayName": "Alice",
                "type": "HUMAN",
                "email": "alice@example.com",
            },
            "thread": {
                "name": "spaces/AAAA/threads/CCCC",
            },
        },
        "user": {
            "name": "users/12345",
            "displayName": "Alice",
        },
    }
    body.update(overrides)
    return body


class TestGoogleChatAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = GoogleChatAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "googlechat")
        self.assertIn("Google Chat", self.adapter.name)

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.threads)
        self.assertTrue(caps.supports_webhook)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)
        self.assertIn("thread", caps.chat_types)


class TestGoogleChatAdapterValidateConfig(SimpleTestCase):
    def setUp(self):
        self.adapter = GoogleChatAdapter()

    def test_valid_config(self):
        errors = self.adapter.validate_config({
            "service_account_json": _SA_JSON,
            "audience": "https://example.com/webhook",
        })
        jwt_errors = [e for e in errors if "PyJWT" not in e]
        self.assertEqual(jwt_errors, [])

    def test_valid_config_as_dict(self):
        sa_dict = json.loads(_SA_JSON)
        errors = self.adapter.validate_config({
            "service_account_json": sa_dict,
            "audience": "https://example.com/webhook",
        })
        jwt_errors = [e for e in errors if "PyJWT" not in e]
        self.assertEqual(jwt_errors, [])

    def test_missing_audience(self):
        errors = self.adapter.validate_config({"service_account_json": _SA_JSON})
        self.assertTrue(any("audience" in e.lower() for e in errors))

    def test_missing_required_field(self):
        errors = self.adapter.validate_config({})
        self.assertTrue(len(errors) > 0)
        self.assertTrue(any("service_account_json" in e.lower() for e in errors))

    def test_invalid_json_format(self):
        errors = self.adapter.validate_config({
            "service_account_json": "not-json",
            "audience": "https://example.com",
        })
        self.assertTrue(len(errors) > 0)
        self.assertTrue(any("json" in e.lower() for e in errors))

    def test_missing_client_email(self):
        sa = json.dumps({"private_key": "key"})
        errors = self.adapter.validate_config({
            "service_account_json": sa,
            "audience": "https://example.com",
        })
        self.assertTrue(any("client_email" in e.lower() for e in errors))

    def test_missing_private_key(self):
        sa = json.dumps({"client_email": "a@b.com"})
        errors = self.adapter.validate_config({
            "service_account_json": sa,
            "audience": "https://example.com",
        })
        self.assertTrue(any("private_key" in e.lower() for e in errors))


class TestGoogleChatAdapterConfigSchema(SimpleTestCase):
    def setUp(self):
        self.adapter = GoogleChatAdapter()

    def test_schema_has_required_fields(self):
        schema = self.adapter.get_config_schema()
        self.assertIn("service_account_json", schema["properties"])
        self.assertIn("service_account_json", schema["required"])
        self.assertIn("audience", schema["properties"])
        self.assertIn("audience", schema["required"])

    def test_schema_service_account_json_is_sensitive(self):
        schema = self.adapter.get_config_schema()
        self.assertTrue(
            schema["properties"]["service_account_json"].get("sensitive")
        )


@patch(
    "apps.channel_gateway.adapters.googlechat._verify_bearer_token",
    return_value=True,
)
class TestGoogleChatAdapterParseWebhook(SimpleTestCase):
    def setUp(self):
        self.adapter = GoogleChatAdapter()

    def test_parse_text_message(self, _mock_verify):
        body = _message_event_body()
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "Hello bot")
        self.assertEqual(result.peer_id, "spaces/AAAA")
        self.assertEqual(result.sender_id, "users/12345")
        self.assertEqual(result.channel, "googlechat")
        self.assertEqual(result.peer_kind, "dm")
        self.assertEqual(result.message_id, "spaces/AAAA/messages/BBBB")
        self.assertEqual(result.thread_id, "spaces/AAAA/threads/CCCC")

    def test_parse_group_message(self, _mock_verify):
        body = _message_event_body()
        body["space"]["type"] = "ROOM"
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.peer_kind, "group")

    def test_parse_returns_none_for_added_to_space(self, _mock_verify):
        body = {"type": "ADDED_TO_SPACE", "space": {"name": "spaces/AAAA"}}
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_parse_returns_none_for_removed_from_space(self, _mock_verify):
        body = {"type": "REMOVED_FROM_SPACE", "space": {"name": "spaces/AAAA"}}
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_parse_returns_none_for_non_message(self, _mock_verify):
        body = {"type": "CARD_CLICKED", "space": {"name": "spaces/AAAA"}}
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_parse_ignores_bot_sender(self, _mock_verify):
        body = _message_event_body()
        body["message"]["sender"]["type"] = "BOT"
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_invalid_json_returns_none(self, _mock_verify):
        req = HttpRequest()
        req._body = b"not json"
        req.method = "POST"
        account = _make_account()
        result = self.adapter.parse_webhook(req, account)
        self.assertIsNone(result)

    def test_parse_sender_metadata(self, _mock_verify):
        body = _message_event_body()
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.metadata["sender_display_name"], "Alice")
        self.assertEqual(result.metadata["sender_email"], "alice@example.com")
        self.assertEqual(result.metadata["space_display_name"], "Test Space")


class TestGoogleChatBearerTokenVerification(SimpleTestCase):
    def setUp(self):
        self.adapter = GoogleChatAdapter()
        self.body = _message_event_body()

    def test_missing_audience_returns_none(self):
        account = _make_account(config={"service_account_json": _SA_JSON})
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)

    def test_missing_bearer_token_returns_none(self):
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)

    def test_invalid_bearer_token_returns_none(self):
        account = _make_account()
        headers = {"Authorization": "Bearer invalid.token.here"}
        result = self.adapter.parse_webhook(
            _make_request(self.body, headers), account,
        )
        self.assertIsNone(result)


class TestGoogleChatAdapterChunkText(SimpleTestCase):
    def setUp(self):
        self.adapter = GoogleChatAdapter()

    def test_short_text_not_chunked(self):
        chunks = self.adapter.chunk_text("hello", 100)
        self.assertEqual(len(chunks), 1)

    def test_long_text_chunked(self):
        text = "a" * 200
        chunks = self.adapter.chunk_text(text, 100)
        self.assertTrue(len(chunks) >= 2)
        self.assertEqual("".join(chunks), text)

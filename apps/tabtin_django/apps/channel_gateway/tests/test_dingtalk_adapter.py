"""DingTalkAdapter 纯单元测试（不依赖数据库和网络）。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from unittest.mock import MagicMock

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.dingtalk import DingTalkAdapter

_DEFAULT_SIGN_TOKEN = "test_sign_token"


def _compute_sign(timestamp_ms: str, sign_token: str) -> str:
    string_to_sign = f"{timestamp_ms}\n{sign_token}"
    hmac_code = hmac.new(
        sign_token.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).digest()
    return base64.b64encode(hmac_code).decode("utf-8")


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "app_key": "ak_test",
        "app_secret": "as_test",
        "sign_token": _DEFAULT_SIGN_TOKEN,
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


def _signed_request(
    body_dict: dict,
    sign_token: str = _DEFAULT_SIGN_TOKEN,
) -> HttpRequest:
    ts_ms = str(int(time.time() * 1000))
    sign = _compute_sign(ts_ms, sign_token)
    return _make_request(body_dict, {"timestamp": ts_ms, "sign": sign})


def _dingtalk_text_body(**overrides) -> dict:
    body = {
        "msgtype": "text",
        "text": {"content": "你好机器人"},
        "conversationId": "cid_abc",
        "conversationType": "1",
        "senderId": "user_001",
        "senderStaffId": "staff_001",
        "msgId": "msg_001",
        "createAt": str(int(time.time() * 1000)),
        "senderNick": "Alice",
    }
    body.update(overrides)
    return body


class TestDingTalkAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = DingTalkAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "dingtalk")
        self.assertIn("钉钉", self.adapter.name)

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.supports_webhook)
        self.assertFalse(caps.threads)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)


class TestDingTalkAdapterValidateConfig(SimpleTestCase):
    def setUp(self):
        self.adapter = DingTalkAdapter()

    def test_valid_config(self):
        errors = self.adapter.validate_config({
            "app_key": "ak123",
            "app_secret": "as456",
            "sign_token": "st789",
        })
        self.assertEqual(errors, [])

    def test_missing_sign_token_returns_error(self):
        errors = self.adapter.validate_config({
            "app_key": "ak123",
            "app_secret": "as456",
        })
        self.assertTrue(any("sign_token" in e.lower() for e in errors))

    def test_missing_app_key(self):
        errors = self.adapter.validate_config({
            "app_secret": "as456",
            "sign_token": "st",
        })
        self.assertTrue(any("app_key" in e.lower() for e in errors))

    def test_missing_app_secret(self):
        errors = self.adapter.validate_config({
            "app_key": "ak123",
            "sign_token": "st",
        })
        self.assertTrue(any("app_secret" in e.lower() for e in errors))

    def test_missing_all(self):
        errors = self.adapter.validate_config({})
        self.assertEqual(len(errors), 3)


class TestDingTalkAdapterConfigSchema(SimpleTestCase):
    def setUp(self):
        self.adapter = DingTalkAdapter()

    def test_schema_has_required_fields(self):
        schema = self.adapter.get_config_schema()
        self.assertIn("app_key", schema["properties"])
        self.assertIn("app_secret", schema["properties"])
        self.assertIn("sign_token", schema["properties"])
        self.assertIn("app_key", schema["required"])
        self.assertIn("app_secret", schema["required"])
        self.assertIn("sign_token", schema["required"])

    def test_schema_app_secret_is_sensitive(self):
        schema = self.adapter.get_config_schema()
        self.assertTrue(schema["properties"]["app_secret"].get("sensitive"))

    def test_schema_sign_token_is_sensitive(self):
        schema = self.adapter.get_config_schema()
        self.assertTrue(schema["properties"]["sign_token"].get("sensitive"))


class TestDingTalkAdapterParseWebhook(SimpleTestCase):
    def setUp(self):
        self.adapter = DingTalkAdapter()

    def test_parse_text_message(self):
        body = _dingtalk_text_body()
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "你好机器人")
        self.assertEqual(result.peer_id, "cid_abc")
        self.assertEqual(result.sender_id, "staff_001")
        self.assertEqual(result.channel, "dingtalk")
        self.assertEqual(result.peer_kind, "dm")
        self.assertEqual(result.message_id, "msg_001")

    def test_parse_group_message(self):
        body = _dingtalk_text_body(conversationType="2")
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.peer_kind, "group")

    def test_parse_returns_none_for_non_message(self):
        body = {
            "conversationId": "cid_abc",
            "conversationType": "1",
            "senderId": "user_001",
            "msgId": "msg_001",
            "createAt": str(int(time.time() * 1000)),
        }
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_request(body), account)
        self.assertIsNone(result)

    def test_missing_conversation_id_returns_none(self):
        body = {
            "msgtype": "text",
            "text": {"content": "hello"},
            "senderId": "user_001",
        }
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_request(body), account)
        self.assertIsNone(result)

    def test_invalid_json_returns_none(self):
        req = HttpRequest()
        req._body = b"not json"
        req.method = "POST"
        account = _make_account()
        result = self.adapter.parse_webhook(req, account)
        self.assertIsNone(result)

    def test_session_webhook_in_metadata(self):
        body = _dingtalk_text_body(
            sessionWebhook="https://oapi.dingtalk.com/robot/sendBySession",
        )
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(
            result.metadata["session_webhook"],
            "https://oapi.dingtalk.com/robot/sendBySession",
        )


class TestDingTalkSignatureVerification(SimpleTestCase):
    def setUp(self):
        self.adapter = DingTalkAdapter()
        self.body = _dingtalk_text_body()

    def test_signature_verification_pass(self):
        sign_token = "my_secret_token"
        ts_ms = str(int(time.time() * 1000))
        sign = _compute_sign(ts_ms, sign_token)

        account = _make_account(config={
            "app_key": "ak", "app_secret": "as", "sign_token": sign_token,
        })
        headers = {"timestamp": ts_ms, "sign": sign}
        result = self.adapter.parse_webhook(_make_request(self.body, headers), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "你好机器人")

    def test_signature_verification_fail(self):
        sign_token = "my_secret_token"
        ts_ms = str(int(time.time() * 1000))

        account = _make_account(config={
            "app_key": "ak", "app_secret": "as", "sign_token": sign_token,
        })
        headers = {"timestamp": ts_ms, "sign": "wrong_sign_value"}
        result = self.adapter.parse_webhook(_make_request(self.body, headers), account)
        self.assertIsNone(result)

    def test_missing_sign_token_config_rejects(self):
        account = _make_account(config={"app_key": "ak", "app_secret": "as"})
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)

    def test_empty_sign_token_config_rejects(self):
        account = _make_account(config={
            "app_key": "ak", "app_secret": "as", "sign_token": "",
        })
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)

    def test_missing_sign_header_fails(self):
        sign_token = "my_secret_token"
        account = _make_account(config={
            "app_key": "ak", "app_secret": "as", "sign_token": sign_token,
        })
        result = self.adapter.parse_webhook(_make_request(self.body), account)
        self.assertIsNone(result)


class TestDingTalkAdapterChunkText(SimpleTestCase):
    def setUp(self):
        self.adapter = DingTalkAdapter()

    def test_short_text_not_chunked(self):
        chunks = self.adapter.chunk_text("hello", 100)
        self.assertEqual(len(chunks), 1)

    def test_long_text_chunked(self):
        text = "a" * 200
        chunks = self.adapter.chunk_text(text, 100)
        self.assertTrue(len(chunks) >= 2)
        self.assertEqual("".join(chunks), text)

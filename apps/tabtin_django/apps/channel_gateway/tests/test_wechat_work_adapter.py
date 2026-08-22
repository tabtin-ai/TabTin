"""WeChatWorkAdapter 纯单元测试（不依赖数据库和网络）。"""

from __future__ import annotations

import hashlib
import hmac
from unittest.mock import MagicMock

from django.http import HttpRequest, QueryDict
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.wechat_work import (
    WeChatWorkAdapter,
    _verify_signature,
)

_DEFAULT_CB_TOKEN = "test_callback_token"
_DEFAULT_ENCODING_AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"


def _compute_msg_signature(token: str, timestamp: str, nonce: str, data: str) -> str:
    items = sorted([token, timestamp, nonce, data])
    return hashlib.sha1("".join(items).encode("utf-8")).hexdigest()


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "corp_id": "corp_test",
        "agent_id": 1,
        "secret": "secret_test",
        "token": _DEFAULT_CB_TOKEN,
        "encoding_aes_key": _DEFAULT_ENCODING_AES_KEY,
    })
    for k, v in overrides.items():
        setattr(acct, k, v)
    return acct


def _make_xml_request(
    xml_str: str,
    query_params: dict | None = None,
) -> HttpRequest:
    req = HttpRequest()
    req._body = xml_str.encode("utf-8")
    req.method = "POST"
    req.content_type = "text/xml"
    if query_params:
        q = QueryDict(mutable=True)
        for k, v in query_params.items():
            q[k] = v
        req.GET = q
    return req


def _signed_xml_request(
    xml_str: str,
    cb_token: str = _DEFAULT_CB_TOKEN,
    timestamp: str = "1700000000",
    nonce: str = "test_nonce",
) -> HttpRequest:
    sig = _compute_msg_signature(cb_token, timestamp, nonce, xml_str)
    return _make_xml_request(xml_str, query_params={
        "msg_signature": sig,
        "timestamp": timestamp,
        "nonce": nonce,
    })


def _text_xml(
    content: str = "你好",
    from_user: str = "user_001",
    to_user: str = "corp_test",
    msg_id: str = "1234567890",
    agent_id: str = "1",
    create_time: str = "1700000000",
) -> str:
    return (
        "<xml>"
        f"<ToUserName><![CDATA[{to_user}]]></ToUserName>"
        f"<FromUserName><![CDATA[{from_user}]]></FromUserName>"
        f"<CreateTime>{create_time}</CreateTime>"
        "<MsgType><![CDATA[text]]></MsgType>"
        f"<Content><![CDATA[{content}]]></Content>"
        f"<MsgId>{msg_id}</MsgId>"
        f"<AgentID>{agent_id}</AgentID>"
        "</xml>"
    )


class TestWeChatWorkAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = WeChatWorkAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "wechat_work")
        self.assertIn("企业微信", self.adapter.name)

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.supports_webhook)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)


class TestWeChatWorkAdapterValidateConfig(SimpleTestCase):
    def setUp(self):
        self.adapter = WeChatWorkAdapter()

    def test_valid_config(self):
        errors = self.adapter.validate_config({
            "corp_id": "ww1234567890",
            "agent_id": 1000001,
            "secret": "some_secret_here",
            "token": "cb_token",
            "encoding_aes_key": _DEFAULT_ENCODING_AES_KEY,
        })
        crypto_errors = [e for e in errors if "cryptography" not in e.lower()]
        self.assertEqual(crypto_errors, [])

    def test_missing_required_field(self):
        errors = self.adapter.validate_config({})
        self.assertTrue(len(errors) >= 5)
        joined = " ".join(errors).lower()
        self.assertIn("corp_id", joined)
        self.assertIn("agent_id", joined)
        self.assertIn("secret", joined)
        self.assertIn("token", joined)
        self.assertIn("encoding_aes_key", joined)

    def test_missing_corp_id(self):
        errors = self.adapter.validate_config({
            "agent_id": 1,
            "secret": "s",
            "token": "t",
            "encoding_aes_key": _DEFAULT_ENCODING_AES_KEY,
        })
        self.assertTrue(any("corp_id" in e.lower() for e in errors))

    def test_missing_agent_id(self):
        errors = self.adapter.validate_config({
            "corp_id": "c",
            "secret": "s",
            "token": "t",
            "encoding_aes_key": _DEFAULT_ENCODING_AES_KEY,
        })
        self.assertTrue(any("agent_id" in e.lower() for e in errors))

    def test_missing_token(self):
        errors = self.adapter.validate_config({
            "corp_id": "c",
            "agent_id": 1,
            "secret": "s",
            "encoding_aes_key": _DEFAULT_ENCODING_AES_KEY,
        })
        self.assertTrue(any("token" in e.lower() for e in errors))

    def test_missing_encoding_aes_key(self):
        errors = self.adapter.validate_config({
            "corp_id": "c",
            "agent_id": 1,
            "secret": "s",
            "token": "t",
        })
        self.assertTrue(any("encoding_aes_key" in e.lower() for e in errors))


class TestWeChatWorkAdapterConfigSchema(SimpleTestCase):
    def setUp(self):
        self.adapter = WeChatWorkAdapter()

    def test_schema_has_required_fields(self):
        schema = self.adapter.get_config_schema()
        self.assertIn("corp_id", schema["properties"])
        self.assertIn("agent_id", schema["properties"])
        self.assertIn("secret", schema["properties"])
        self.assertIn("token", schema["properties"])
        self.assertIn("encoding_aes_key", schema["properties"])
        self.assertIn("corp_id", schema["required"])
        self.assertIn("agent_id", schema["required"])
        self.assertIn("secret", schema["required"])
        self.assertIn("token", schema["required"])
        self.assertIn("encoding_aes_key", schema["required"])

    def test_schema_secret_is_sensitive(self):
        schema = self.adapter.get_config_schema()
        self.assertTrue(schema["properties"]["secret"].get("sensitive"))

    def test_schema_encoding_aes_key_is_sensitive(self):
        schema = self.adapter.get_config_schema()
        self.assertTrue(schema["properties"]["encoding_aes_key"].get("sensitive"))


class TestWeChatWorkAdapterParseWebhook(SimpleTestCase):
    def setUp(self):
        self.adapter = WeChatWorkAdapter()

    def test_parse_text_message(self):
        xml = _text_xml(content="Hello World")
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_xml_request(xml), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "Hello World")
        self.assertEqual(result.sender_id, "user_001")
        self.assertEqual(result.channel, "wechat_work")
        self.assertEqual(result.peer_kind, "dm")
        self.assertEqual(result.message_id, "1234567890")
        self.assertEqual(result.metadata["msg_type"], "text")

    def test_parse_image_message(self):
        xml = (
            "<xml>"
            "<ToUserName><![CDATA[corp_test]]></ToUserName>"
            "<FromUserName><![CDATA[user_001]]></FromUserName>"
            "<CreateTime>1700000000</CreateTime>"
            "<MsgType><![CDATA[image]]></MsgType>"
            "<PicUrl><![CDATA[https://example.com/pic.jpg]]></PicUrl>"
            "<MediaId><![CDATA[media_id_123]]></MediaId>"
            "<MsgId>111</MsgId>"
            "<AgentID>1</AgentID>"
            "</xml>"
        )
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_xml_request(xml), account)
        self.assertIsNotNone(result)
        self.assertEqual(len(result.media), 1)
        self.assertEqual(result.media[0].kind, "image")
        self.assertEqual(result.media[0].file_id, "media_id_123")

    def test_parse_returns_none_for_event(self):
        xml = (
            "<xml>"
            "<ToUserName><![CDATA[corp_test]]></ToUserName>"
            "<FromUserName><![CDATA[sys]]></FromUserName>"
            "<CreateTime>1700000000</CreateTime>"
            "<MsgType><![CDATA[event]]></MsgType>"
            "<Event><![CDATA[subscribe]]></Event>"
            "<AgentID>1</AgentID>"
            "</xml>"
        )
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_xml_request(xml), account)
        self.assertIsNone(result)

    def test_parse_returns_none_for_non_message(self):
        xml = (
            "<xml>"
            "<ToUserName><![CDATA[corp_test]]></ToUserName>"
            "<CreateTime>1700000000</CreateTime>"
            "<MsgType><![CDATA[text]]></MsgType>"
            "<Content><![CDATA[hello]]></Content>"
            "<AgentID>1</AgentID>"
            "</xml>"
        )
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_xml_request(xml), account)
        self.assertIsNone(result)

    def test_invalid_xml_returns_none(self):
        req = HttpRequest()
        req._body = b"not xml <><><"
        req.method = "POST"
        req.content_type = "text/xml"
        account = _make_account()
        result = self.adapter.parse_webhook(req, account)
        self.assertIsNone(result)

    def test_invalid_encoding_returns_none(self):
        req = HttpRequest()
        req._body = b"\xff\xfe"
        req.method = "POST"
        req.content_type = "text/xml"
        account = _make_account()
        result = self.adapter.parse_webhook(req, account)
        self.assertIsNone(result)

    def test_location_message(self):
        xml = (
            "<xml>"
            "<ToUserName><![CDATA[corp_test]]></ToUserName>"
            "<FromUserName><![CDATA[user_001]]></FromUserName>"
            "<CreateTime>1700000000</CreateTime>"
            "<MsgType><![CDATA[location]]></MsgType>"
            "<Location_X>23.134</Location_X>"
            "<Location_Y>113.258</Location_Y>"
            "<Label><![CDATA[广州市]]></Label>"
            "<MsgId>222</MsgId>"
            "<AgentID>1</AgentID>"
            "</xml>"
        )
        account = _make_account()
        result = self.adapter.parse_webhook(_signed_xml_request(xml), account)
        self.assertIsNotNone(result)
        self.assertIn("广州市", result.text)
        self.assertIn("23.134", result.text)

    def test_missing_token_config_returns_none(self):
        xml = _text_xml(content="hello")
        account = _make_account(config={
            "corp_id": "corp_test",
            "agent_id": 1,
            "secret": "secret_test",
        })
        result = self.adapter.parse_webhook(
            _make_xml_request(xml), account,
        )
        self.assertIsNone(result)


class TestWeChatWorkSignatureVerification(SimpleTestCase):

    def test_signature_verification_pass(self):
        token = "test_callback_token"
        timestamp = "1348831860"
        nonce = "test_nonce"
        encrypt = "encrypted_data_here"
        items = sorted([token, timestamp, nonce, encrypt])
        expected = hashlib.sha1("".join(items).encode("utf-8")).hexdigest()
        self.assertTrue(_verify_signature(token, timestamp, nonce, encrypt, expected))

    def test_signature_verification_fail(self):
        self.assertFalse(
            _verify_signature("token", "ts", "nonce", "enc", "wrong_signature")
        )

    def test_plaintext_wrong_signature_returns_none(self):
        adapter = WeChatWorkAdapter()
        xml = _text_xml(content="plaintext msg")
        account = _make_account()
        req = _make_xml_request(xml, query_params={
            "msg_signature": "wrong_sig",
            "timestamp": "1700000000",
            "nonce": "test_nonce",
        })
        result = adapter.parse_webhook(req, account)
        self.assertIsNone(result)

    def test_encrypted_mode_wrong_signature_returns_none(self):
        adapter = WeChatWorkAdapter()
        xml = "<xml><Encrypt><![CDATA[some_encrypted_data]]></Encrypt></xml>"
        account = _make_account()
        req = _make_xml_request(xml, query_params={
            "msg_signature": "wrong_sig",
            "timestamp": "1234567890",
            "nonce": "test_nonce",
        })
        result = adapter.parse_webhook(req, account)
        self.assertIsNone(result)


class TestWeChatWorkAdapterChunkText(SimpleTestCase):
    def setUp(self):
        self.adapter = WeChatWorkAdapter()

    def test_short_text_not_chunked(self):
        chunks = self.adapter.chunk_text("hello", 100)
        self.assertEqual(len(chunks), 1)

    def test_long_text_chunked(self):
        text = "a" * 200
        chunks = self.adapter.chunk_text(text, 100)
        self.assertTrue(len(chunks) >= 2)
        self.assertEqual("".join(chunks), text)

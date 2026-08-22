"""DE-01 / DE-02 / DE-03 / DE-12 安全修复回归测试。

验证：
- DE-01: Discord PyNaCl 缺失时拒绝 webhook
- DE-02: 各 adapter 签名字段为 required
- DE-03: 企业微信非加密模式签名校验
- DE-12: MSTeams skip_jwt_verification 已移除
"""

from __future__ import annotations

import hashlib
import json
from unittest.mock import MagicMock, patch

from django.test import RequestFactory

from django.http import HttpRequest
from django.test import SimpleTestCase


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {})
    for k, v in overrides.items():
        setattr(acct, k, v)
    return acct


def _make_request(
    body: bytes | dict,
    method: str = "POST",
    headers: dict | None = None,
    query_params: dict | None = None,
) -> HttpRequest:
    if isinstance(body, dict):
        body = json.dumps(body).encode()
    req = HttpRequest()
    req._body = body
    req.method = method
    req.content_type = "application/json"
    if headers:
        for k, v in headers.items():
            req.META[f"HTTP_{k.upper().replace('-', '_')}"] = v
    if query_params:
        req.GET = query_params
    return req


# =========================================================================
# DE-01: Discord PyNaCl 缺失时拒绝请求
# =========================================================================


class TestDE01_DiscordPyNaClMissing(SimpleTestCase):
    """DE-01: _verify_ed25519 在 PyNaCl 未安装时必须抛出 RuntimeError。"""

    def test_verify_ed25519_raises_when_nacl_unavailable(self):
        from apps.channel_gateway.adapters.discord import _verify_ed25519

        with patch("apps.channel_gateway.adapters.discord._nacl_available", False):
            with self.assertRaises(RuntimeError):
                _verify_ed25519("deadbeef", "sig", "1234", b"body")

    def test_parse_webhook_rejects_when_nacl_unavailable(self):
        from apps.channel_gateway.adapters.discord import DiscordAdapter

        adapter = DiscordAdapter()
        body = {
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg_1",
                "channel_id": "ch_1",
                "content": "hello",
                "author": {"id": "u1", "username": "alice"},
                "timestamp": "2024-01-01T00:00:00.000Z",
            },
        }
        req = _make_request(
            body,
            headers={
                "X-Signature-Ed25519": "a" * 128,
                "X-Signature-Timestamp": "1234",
            },
        )
        acct = _make_account(config={"bot_token": "t", "public_key": "a" * 64})

        with patch("apps.channel_gateway.adapters.discord._nacl_available", False):
            result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)

    def test_public_key_required_in_validate_config(self):
        from apps.channel_gateway.adapters.discord import DiscordAdapter

        adapter = DiscordAdapter()
        errors = adapter.validate_config({"bot_token": "tok123"})
        self.assertTrue(
            any("public_key" in e for e in errors),
            f"Expected 'public_key' required error, got: {errors}",
        )

    def test_public_key_in_schema_required(self):
        from apps.channel_gateway.adapters.discord import DiscordAdapter

        adapter = DiscordAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("public_key", schema.get("required", []))

    def test_parse_webhook_rejects_missing_public_key(self):
        from apps.channel_gateway.adapters.discord import DiscordAdapter

        adapter = DiscordAdapter()
        body = {
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg_1",
                "channel_id": "ch_1",
                "content": "hello",
                "author": {"id": "u1", "username": "alice"},
                "timestamp": "2024-01-01T00:00:00.000Z",
            },
        }
        req = _make_request(body)
        acct = _make_account(config={"bot_token": "t"})
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


# =========================================================================
# DE-02: 各 adapter 签名字段为 required
# =========================================================================


class TestDE02_TelegramSecretTokenRequired(SimpleTestCase):
    def test_secret_token_in_required(self):
        from apps.channel_gateway.adapters.telegram import TelegramAdapter

        adapter = TelegramAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("secret_token", schema.get("required", []))

    def test_validate_config_requires_secret_token(self):
        from apps.channel_gateway.adapters.telegram import TelegramAdapter

        adapter = TelegramAdapter()
        errors = adapter.validate_config({"bot_token": "123456:ABCDEF"})
        self.assertTrue(any("secret_token" in e for e in errors))

    def test_parse_webhook_rejects_without_secret_token(self):
        from apps.channel_gateway.adapters.telegram import TelegramAdapter

        adapter = TelegramAdapter()
        body = {"message": {"chat": {"id": 1}, "text": "hi", "from": {"id": 2}}}
        req = _make_request(body)
        acct = _make_account(config={"bot_token": "123456:ABCDEF"})
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


class TestDE02_WhatsAppAppSecretRequired(SimpleTestCase):
    def test_app_secret_in_required(self):
        from apps.channel_gateway.adapters.whatsapp import WhatsAppAdapter

        adapter = WhatsAppAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("app_secret", schema.get("required", []))

    def test_validate_config_requires_app_secret(self):
        from apps.channel_gateway.adapters.whatsapp import WhatsAppAdapter

        adapter = WhatsAppAdapter()
        errors = adapter.validate_config({
            "access_token": "tok",
            "phone_number_id": "123",
        })
        self.assertTrue(any("app_secret" in e for e in errors))

    def test_parse_webhook_rejects_without_app_secret(self):
        from apps.channel_gateway.adapters.whatsapp import WhatsAppAdapter

        adapter = WhatsAppAdapter()
        body = {"object": "whatsapp_business_account", "entry": []}
        req = _make_request(body)
        acct = _make_account(config={
            "access_token": "tok",
            "phone_number_id": "123",
        })
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


class TestDE02_DingTalkSignTokenRequired(SimpleTestCase):
    def test_sign_token_in_required(self):
        from apps.channel_gateway.adapters.dingtalk import DingTalkAdapter

        adapter = DingTalkAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("sign_token", schema.get("required", []))

    def test_validate_config_requires_sign_token(self):
        from apps.channel_gateway.adapters.dingtalk import DingTalkAdapter

        adapter = DingTalkAdapter()
        errors = adapter.validate_config({
            "app_key": "key",
            "app_secret": "secret",
        })
        self.assertTrue(any("sign_token" in e for e in errors))

    def test_parse_webhook_rejects_without_sign_token(self):
        from apps.channel_gateway.adapters.dingtalk import DingTalkAdapter

        adapter = DingTalkAdapter()
        body = {"msgtype": "text", "text": {"content": "hi"}, "conversationId": "c1"}
        req = _make_request(body)
        acct = _make_account(config={"app_key": "k", "app_secret": "s"})
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


class TestDE02_SlackSigningSecretRequired(SimpleTestCase):
    def test_signing_secret_in_required(self):
        from apps.channel_gateway.adapters.slack import SlackAdapter

        adapter = SlackAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("signing_secret", schema.get("required", []))

    def test_validate_config_requires_signing_secret(self):
        from apps.channel_gateway.adapters.slack import SlackAdapter

        adapter = SlackAdapter()
        errors = adapter.validate_config({"bot_token": "xoxb-123"})
        self.assertTrue(any("signing_secret" in e for e in errors))

    def test_parse_webhook_rejects_without_signing_secret(self):
        from apps.channel_gateway.adapters.slack import SlackAdapter

        adapter = SlackAdapter()
        body = {"type": "event_callback", "event": {"type": "message"}}
        req = _make_request(body)
        acct = _make_account(config={"bot_token": "xoxb-123"})
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


class TestDE02_LineChannelSecretRequired(SimpleTestCase):
    def test_channel_secret_in_required(self):
        from apps.channel_gateway.adapters.line import LineAdapter

        adapter = LineAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("channel_secret", schema.get("required", []))

    def test_validate_config_requires_channel_secret(self):
        from apps.channel_gateway.adapters.line import LineAdapter

        adapter = LineAdapter()
        errors = adapter.validate_config({"channel_access_token": "tok"})
        self.assertTrue(any("channel_secret" in e for e in errors))

    def test_parse_webhook_rejects_without_channel_secret(self):
        from apps.channel_gateway.adapters.line import LineAdapter

        adapter = LineAdapter()
        body = {"events": [{"type": "message", "source": {"userId": "u1"}}]}
        req = _make_request(body)
        acct = _make_account(config={"channel_access_token": "tok"})
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


class TestDE02_GoogleChatAudienceRequired(SimpleTestCase):
    def test_audience_in_required(self):
        from apps.channel_gateway.adapters.googlechat import GoogleChatAdapter

        adapter = GoogleChatAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("audience", schema.get("required", []))

    def test_validate_config_requires_audience(self):
        from apps.channel_gateway.adapters.googlechat import GoogleChatAdapter

        adapter = GoogleChatAdapter()
        errors = adapter.validate_config({
            "service_account_json": '{"client_email":"a@b.c","private_key":"pk"}',
        })
        self.assertTrue(any("audience" in e for e in errors))

    def test_parse_webhook_rejects_without_audience(self):
        from apps.channel_gateway.adapters.googlechat import GoogleChatAdapter

        adapter = GoogleChatAdapter()
        body = {"type": "MESSAGE", "message": {"text": "hi"}, "space": {"name": "s/1"}}
        req = _make_request(body)
        acct = _make_account(config={"service_account_json": "{}"})
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


class TestDE02_MattermostWebhookSecretRequired(SimpleTestCase):
    def test_webhook_secret_in_required(self):
        from apps.channel_gateway.adapters.mattermost import MattermostAdapter

        adapter = MattermostAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("webhook_secret", schema.get("required", []))

    def test_validate_config_requires_webhook_secret(self):
        from apps.channel_gateway.adapters.mattermost import MattermostAdapter

        adapter = MattermostAdapter()
        errors = adapter.validate_config({
            "server_url": "https://mm.example.com",
            "bot_token": "tok",
        })
        self.assertTrue(any("webhook_secret" in e for e in errors))

    def test_parse_webhook_rejects_without_webhook_secret(self):
        from apps.channel_gateway.adapters.mattermost import MattermostAdapter

        adapter = MattermostAdapter()
        body = {"channel_id": "c1", "user_id": "u1", "text": "hi"}
        req = _make_request(body)
        acct = _make_account(config={
            "server_url": "https://mm.example.com",
            "bot_token": "tok",
        })
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


class TestDE02_FeishuVerificationTokenRequired(SimpleTestCase):
    def test_verification_token_in_required(self):
        from apps.channel_gateway.adapters.feishu import FeishuAdapter

        adapter = FeishuAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("verification_token", schema.get("required", []))

    def test_validate_config_requires_verification_token(self):
        from apps.channel_gateway.adapters.feishu import FeishuAdapter

        adapter = FeishuAdapter()
        errors = adapter.validate_config({
            "app_id": "aid",
            "app_secret": "asec",
        })
        self.assertTrue(any("verification_token" in e for e in errors))

    def test_parse_webhook_rejects_without_signing_config(self):
        """飞书 parse_webhook 在 verification_token 和 encrypt_key 均未配置时拒绝请求"""
        from apps.channel_gateway.adapters.feishu import FeishuAdapter
        import json

        adapter = FeishuAdapter()
        account = type("A", (), {
            "config": {"app_id": "aid", "app_secret": "asec"},
            "id": "test",
        })()
        factory = RequestFactory()
        body = json.dumps({"header": {"event_type": "im.message.receive_v1"}})
        req = factory.post("/wh", data=body, content_type="application/json")
        result = adapter.parse_webhook(req, account)
        self.assertIsNone(result)


class TestDE02_WeChatWorkTokenAndAesKeyRequired(SimpleTestCase):
    def test_token_in_required(self):
        from apps.channel_gateway.adapters.wechat_work import WeChatWorkAdapter

        adapter = WeChatWorkAdapter()
        schema = adapter.get_config_schema()
        self.assertIn("token", schema.get("required", []))
        self.assertIn("encoding_aes_key", schema.get("required", []))

    def test_validate_config_requires_token_and_aes_key(self):
        from apps.channel_gateway.adapters.wechat_work import WeChatWorkAdapter

        adapter = WeChatWorkAdapter()
        errors = adapter.validate_config({
            "corp_id": "corp",
            "agent_id": 1,
            "secret": "sec",
        })
        self.assertTrue(any("token" in e for e in errors))
        self.assertTrue(any("encoding_aes_key" in e for e in errors))


# =========================================================================
# DE-03: 企业微信非加密模式签名校验
# =========================================================================


class TestDE03_WeChatWorkPlaintextSignatureVerification(SimpleTestCase):
    def test_rejects_when_token_missing(self):
        from apps.channel_gateway.adapters.wechat_work import WeChatWorkAdapter

        adapter = WeChatWorkAdapter()
        xml_body = (
            "<xml>"
            "<ToUserName>corp</ToUserName>"
            "<FromUserName>user1</FromUserName>"
            "<MsgType>text</MsgType>"
            "<Content>hello</Content>"
            "<MsgId>123</MsgId>"
            "<CreateTime>1700000000</CreateTime>"
            "</xml>"
        )
        req = _make_request(
            xml_body.encode("utf-8"),
            query_params={"msg_signature": "sig", "timestamp": "1234", "nonce": "nonce"},
        )
        req.content_type = "text/xml"
        acct = _make_account(config={
            "corp_id": "corp",
            "agent_id": 1,
            "secret": "sec",
        })
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)

    def test_rejects_plaintext_with_bad_signature(self):
        from apps.channel_gateway.adapters.wechat_work import WeChatWorkAdapter

        adapter = WeChatWorkAdapter()
        xml_body = (
            "<xml>"
            "<ToUserName>corp</ToUserName>"
            "<FromUserName>user1</FromUserName>"
            "<MsgType>text</MsgType>"
            "<Content>hello</Content>"
            "<MsgId>123</MsgId>"
            "<CreateTime>1700000000</CreateTime>"
            "</xml>"
        )
        req = _make_request(
            xml_body.encode("utf-8"),
            query_params={
                "msg_signature": "bad_signature",
                "timestamp": "1234",
                "nonce": "nonce",
            },
        )
        req.content_type = "text/xml"
        acct = _make_account(config={
            "corp_id": "corp",
            "agent_id": 1,
            "secret": "sec",
            "token": "my_token",
            "encoding_aes_key": "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
        })
        result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)

    def test_accepts_plaintext_with_correct_signature(self):
        from apps.channel_gateway.adapters.wechat_work import WeChatWorkAdapter

        adapter = WeChatWorkAdapter()
        token = "my_token"
        ts = "1700000000"
        nonce = "testnonce"
        xml_body = (
            "<xml>"
            "<ToUserName>corp</ToUserName>"
            "<FromUserName>user1</FromUserName>"
            "<MsgType>text</MsgType>"
            "<Content>hello</Content>"
            "<MsgId>123</MsgId>"
            "<AgentID>1</AgentID>"
            "<CreateTime>1700000000</CreateTime>"
            "</xml>"
        )
        items = sorted([token, ts, nonce, xml_body])
        computed_sig = hashlib.sha1("".join(items).encode("utf-8")).hexdigest()

        req = _make_request(
            xml_body.encode("utf-8"),
            query_params={
                "msg_signature": computed_sig,
                "timestamp": ts,
                "nonce": nonce,
            },
        )
        req.content_type = "text/xml"
        acct = _make_account(config={
            "corp_id": "corp",
            "agent_id": 1,
            "secret": "sec",
            "token": token,
            "encoding_aes_key": "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
        })
        result = adapter.parse_webhook(req, acct)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "hello")


# =========================================================================
# DE-12: MSTeams skip_jwt_verification 已移除
# =========================================================================


class TestDE12_MSTeamsNoSkipJwtVerification(SimpleTestCase):
    def test_skip_jwt_verification_not_in_schema(self):
        from apps.channel_gateway.adapters.msteams import MSTeamsAdapter

        adapter = MSTeamsAdapter()
        schema = adapter.get_config_schema()
        self.assertNotIn("skip_jwt_verification", schema.get("properties", {}))

    def test_skip_jwt_verification_not_honored_in_parse_webhook(self):
        """Even if config has skip_jwt_verification=True, JWT must be verified."""
        from apps.channel_gateway.adapters.msteams import MSTeamsAdapter

        adapter = MSTeamsAdapter()
        body = {
            "type": "message",
            "text": "hello",
            "from": {"id": "u1"},
            "conversation": {"id": "c1"},
            "id": "m1",
        }
        req = _make_request(body)
        acct = _make_account(config={
            "app_id": "app123",
            "app_password": "pass",
            "skip_jwt_verification": True,
        })
        with patch(
            "apps.channel_gateway.adapters.msteams._verify_jwt",
            return_value=False,
        ):
            result = adapter.parse_webhook(req, acct)
        self.assertIsNone(result)


# =========================================================================
# DE-02: BindingService.validate_account_signing_config
# =========================================================================


class TestDE02_BindingServiceValidation(SimpleTestCase):
    def test_validate_returns_errors_for_missing_signing_fields(self):
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
        from apps.channel_gateway.adapters.telegram import TelegramAdapter
        from apps.channel_gateway.services.binding_service import ChannelBindingService

        ChannelAdapterRegistry._reset()
        ChannelAdapterRegistry.register(TelegramAdapter())
        try:
            errors = ChannelBindingService.validate_account_signing_config(
                "telegram", {"bot_token": "123456:ABCDEF"},
            )
            self.assertTrue(any("secret_token" in e for e in errors))
        finally:
            ChannelAdapterRegistry._reset()

    def test_validate_returns_empty_for_complete_config(self):
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
        from apps.channel_gateway.adapters.telegram import TelegramAdapter
        from apps.channel_gateway.services.binding_service import ChannelBindingService

        ChannelAdapterRegistry._reset()
        ChannelAdapterRegistry.register(TelegramAdapter())
        try:
            errors = ChannelBindingService.validate_account_signing_config(
                "telegram",
                {"bot_token": "123456:ABCDEFghijklmn_opqrstuvwxyz01234", "secret_token": "mysecret"},
            )
            self.assertEqual(errors, [])
        finally:
            ChannelAdapterRegistry._reset()

"""MSTeamsAdapter 纯单元测试（不依赖数据库和网络）。"""

from __future__ import annotations

import base64
import json
import unittest.mock
from unittest.mock import MagicMock

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.msteams import (
    MSTeamsAdapter,
    _validate_issuer,
    _verify_jwt,
    _get_jwks,
)


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "app_id": "app_test",
        "app_password": "pwd_test",
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


def _build_fake_jwt(payload: dict) -> str:
    """构造一个结构正确但未真实签名的 JWT（用于 _verify_jwt_basic 测试）。"""
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    payload_b64 = base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).decode().rstrip("=")
    signature = base64.urlsafe_b64encode(b"fakesignature").decode().rstrip("=")
    return f"{header}.{payload_b64}.{signature}"


def _activity_body(**overrides) -> dict:
    body = {
        "type": "message",
        "id": "msg-001",
        "timestamp": "2024-01-15T10:30:00Z",
        "serviceUrl": "https://smba.trafficmanager.net/teams/",
        "channelId": "msteams",
        "from": {
            "id": "user-001",
            "name": "Alice",
            "aadObjectId": "aad-001",
        },
        "conversation": {
            "id": "conv-001",
            "conversationType": "personal",
            "tenantId": "tenant-001",
        },
        "recipient": {
            "id": "bot-001",
            "name": "TabTin Bot",
        },
        "text": "Hello Teams Bot",
        "channelData": {},
    }
    body.update(overrides)
    return body


class TestMSTeamsAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = MSTeamsAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "msteams")
        self.assertIn("Microsoft Teams", self.adapter.name)

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.threads)
        self.assertTrue(caps.supports_webhook)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)
        self.assertIn("thread", caps.chat_types)


class TestMSTeamsAdapterValidateConfig(SimpleTestCase):
    def setUp(self):
        self.adapter = MSTeamsAdapter()

    def test_valid_config(self):
        errors = self.adapter.validate_config({
            "app_id": "12345678-abcd-efgh-ijkl-000000000000",
            "app_password": "my_secret_password",
        })
        self.assertEqual(errors, [])

    def test_missing_required_field(self):
        errors = self.adapter.validate_config({})
        self.assertEqual(len(errors), 2)
        joined = " ".join(errors).lower()
        self.assertIn("app_id", joined)
        self.assertIn("app_password", joined)

    def test_missing_app_id(self):
        errors = self.adapter.validate_config({"app_password": "pwd"})
        self.assertTrue(any("app_id" in e.lower() for e in errors))

    def test_missing_app_password(self):
        errors = self.adapter.validate_config({"app_id": "id"})
        self.assertTrue(any("app_password" in e.lower() for e in errors))


class TestMSTeamsAdapterConfigSchema(SimpleTestCase):
    def setUp(self):
        self.adapter = MSTeamsAdapter()

    def test_schema_has_required_fields(self):
        schema = self.adapter.get_config_schema()
        self.assertIn("app_id", schema["properties"])
        self.assertIn("app_password", schema["properties"])
        self.assertIn("app_id", schema["required"])
        self.assertIn("app_password", schema["required"])

    def test_schema_app_password_is_sensitive(self):
        schema = self.adapter.get_config_schema()
        self.assertTrue(schema["properties"]["app_password"].get("sensitive"))


@unittest.mock.patch(
    "apps.channel_gateway.adapters.msteams._verify_jwt", return_value=True,
)
class TestMSTeamsAdapterParseWebhook(SimpleTestCase):
    def setUp(self):
        self.adapter = MSTeamsAdapter()

    def test_parse_text_message(self, _mock_jwt):
        body = _activity_body()
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "Hello Teams Bot")
        self.assertEqual(result.peer_id, "conv-001")
        self.assertEqual(result.sender_id, "user-001")
        self.assertEqual(result.channel, "msteams")
        self.assertEqual(result.peer_kind, "dm")
        self.assertEqual(result.message_id, "msg-001")

    def test_parse_group_message(self, _mock_jwt):
        body = _activity_body()
        body["conversation"]["conversationType"] = "groupChat"
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.peer_kind, "group")

    def test_mention_tags_cleaned(self, _mock_jwt):
        body = _activity_body(text="<at>TabTin Bot</at> Hello there")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.text, "Hello there")

    def test_parse_returns_none_for_conversation_update(self, _mock_jwt):
        body = _activity_body(type="conversationUpdate")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_parse_returns_none_for_typing(self, _mock_jwt):
        body = _activity_body(type="typing")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_parse_returns_none_for_non_message(self, _mock_jwt):
        body = _activity_body(type="installationUpdate")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_parse_returns_none_for_empty_text(self, _mock_jwt):
        body = _activity_body(text="")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNone(result)

    def test_invalid_json_returns_none(self, _mock_jwt):
        req = HttpRequest()
        req._body = b"not json"
        req.method = "POST"
        account = _make_account()
        result = self.adapter.parse_webhook(req, account)
        self.assertIsNone(result)

    def test_metadata_has_service_url(self, _mock_jwt):
        body = _activity_body()
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(
            result.metadata["service_url"],
            "https://smba.trafficmanager.net/teams/",
        )

    def test_reply_to_id(self, _mock_jwt):
        body = _activity_body(replyToId="parent-msg-001")
        account = _make_account()
        result = self.adapter.parse_webhook(_make_request(body), account)
        self.assertIsNotNone(result)
        self.assertEqual(result.reply_to, "parent-msg-001")


class TestMSTeamsJWTVerification(SimpleTestCase):
    """Bot Framework JWT JWKS verification tests."""

    def _make_request_with_auth(self, token: str) -> HttpRequest:
        req = HttpRequest()
        req._body = b"{}"
        req.method = "POST"
        req.META["HTTP_AUTHORIZATION"] = f"Bearer {token}"
        return req

    def test_no_bearer_header_returns_false(self):
        req = HttpRequest()
        req._body = b"{}"
        req.method = "POST"
        self.assertFalse(_verify_jwt(req, "app_test"))

    def test_malformed_token_returns_false(self):
        req = self._make_request_with_auth("not-a-jwt")
        self.assertFalse(_verify_jwt(req, "app_test"))

    @unittest.mock.patch(
        "apps.channel_gateway.adapters.msteams._get_jwks",
        return_value=None,
    )
    def test_no_jwks_returns_false(self, _mock_jwks):
        jwt_token = _build_fake_jwt({"aud": "app_test"})
        req = self._make_request_with_auth(jwt_token)
        self.assertFalse(_verify_jwt(req, "app_test"))

    @unittest.mock.patch(
        "apps.channel_gateway.adapters.msteams._get_jwks",
        return_value={"keys": []},
    )
    def test_kid_not_found_returns_false(self, _mock_jwks):
        jwt_token = _build_fake_jwt({"aud": "app_test"})
        req = self._make_request_with_auth(jwt_token)
        self.assertFalse(_verify_jwt(req, "app_test"))


class TestMSTeamsAdapterChunkText(SimpleTestCase):
    def setUp(self):
        self.adapter = MSTeamsAdapter()

    def test_short_text_not_chunked(self):
        chunks = self.adapter.chunk_text("hello", 100)
        self.assertEqual(len(chunks), 1)

    def test_long_text_chunked(self):
        text = "a" * 200
        chunks = self.adapter.chunk_text(text, 100)
        self.assertTrue(len(chunks) >= 2)
        self.assertEqual("".join(chunks), text)


class TestDE13_IssuerValidation(SimpleTestCase):
    """DE-13: JWT issuer validation must be strict — no broad prefix matching."""

    # -- Bot Framework issuer (always trusted) --
    def test_botframework_issuer_accepted(self):
        self.assertTrue(_validate_issuer("https://api.botframework.com"))

    # -- Single-tenant: exact match --
    def test_single_tenant_sts_exact_match(self):
        tid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        self.assertTrue(_validate_issuer(
            f"https://sts.windows.net/{tid}/", tenant_id=tid,
        ))

    def test_single_tenant_login_exact_match(self):
        tid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        self.assertTrue(_validate_issuer(
            f"https://login.microsoftonline.com/{tid}/v2.0", tenant_id=tid,
        ))

    def test_single_tenant_rejects_wrong_tenant(self):
        configured = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        other = "99999999-9999-9999-9999-999999999999"
        self.assertFalse(_validate_issuer(
            f"https://sts.windows.net/{other}/", tenant_id=configured,
        ))
        self.assertFalse(_validate_issuer(
            f"https://login.microsoftonline.com/{other}/v2.0", tenant_id=configured,
        ))

    # -- Multi-tenant: UUID pattern validation --
    def test_multitenant_sts_valid_uuid_accepted(self):
        tid = "d6d49420-f39b-4df7-a1dc-d59a935871db"
        self.assertTrue(_validate_issuer(f"https://sts.windows.net/{tid}/"))

    def test_multitenant_login_valid_uuid_accepted(self):
        tid = "d6d49420-f39b-4df7-a1dc-d59a935871db"
        self.assertTrue(_validate_issuer(
            f"https://login.microsoftonline.com/{tid}/v2.0",
        ))

    def test_multitenant_rejects_non_uuid_tenant(self):
        self.assertFalse(_validate_issuer(
            "https://sts.windows.net/not-a-uuid/",
        ))
        self.assertFalse(_validate_issuer(
            "https://login.microsoftonline.com/../../etc/v2.0",
        ))

    def test_multitenant_rejects_bare_prefix(self):
        self.assertFalse(_validate_issuer("https://sts.windows.net/"))
        self.assertFalse(_validate_issuer("https://login.microsoftonline.com/"))

    def test_rejects_totally_unknown_issuer(self):
        self.assertFalse(_validate_issuer("https://evil.example.com/"))

    def test_rejects_sts_without_trailing_slash(self):
        tid = "d6d49420-f39b-4df7-a1dc-d59a935871db"
        self.assertFalse(_validate_issuer(f"https://sts.windows.net/{tid}"))

    def test_botframework_com_tenant_treated_as_multitenant(self):
        tid = "d6d49420-f39b-4df7-a1dc-d59a935871db"
        self.assertTrue(_validate_issuer(
            f"https://sts.windows.net/{tid}/",
            tenant_id="botframework.com",
        ))

"""FeishuAdapter 纯单元测试（不依赖网络和数据库）。"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from unittest.mock import MagicMock, patch

from asgiref.sync import async_to_sync
from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.base import WebhookChallengeResponse
from apps.channel_gateway.adapters.feishu import (
    TIMESTAMP_TOLERANCE_SECONDS,
    FeishuAdapter,
    _build_post_message,
    _check_timestamp_freshness,
    _extract_post_text,
    _parse_text_content,
    _verify_signature,
    is_feishu_custom_bot_webhook_url,
)


_DEFAULT_VERIFICATION_TOKEN = "test_vt_token"


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    config = overrides.pop("config", {})
    if "verification_token" not in config and "encrypt_key" not in config:
        config.setdefault("verification_token", _DEFAULT_VERIFICATION_TOKEN)
    acct.config = config
    for k, v in overrides.items():
        setattr(acct, k, v)
    return acct


def _compute_signature(ts: str, nonce: str, key: str, body_bytes: bytes) -> str:
    content = ts + nonce + key + body_bytes.decode()
    return hashlib.sha256(content.encode()).hexdigest()


def _make_request(body_dict: dict, headers: dict | None = None, *, sign_key: str | None = _DEFAULT_VERIFICATION_TOKEN) -> HttpRequest:
    raw = json.dumps(body_dict).encode()
    req = HttpRequest()
    req._body = raw
    req.method = "POST"
    req.content_type = "application/json"
    extra_headers = dict(headers or {})
    if sign_key and "X-Lark-Signature" not in extra_headers:
        ts = str(int(time.time()))
        nonce = f"test_nonce_{uuid.uuid4().hex[:8]}"
        sig = _compute_signature(ts, nonce, sign_key, raw)
        extra_headers.setdefault("X-Lark-Request-Timestamp", ts)
        extra_headers.setdefault("X-Lark-Request-Nonce", nonce)
        extra_headers["X-Lark-Signature"] = sig
    for k, v in extra_headers.items():
        req.META[f"HTTP_{k.upper().replace('-', '_')}"] = v
    return req


class TestFeishuAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = FeishuAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "feishu")
        self.assertIn("飞书", self.adapter.name)

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.threads)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)

    def test_validate_config_missing_fields(self):
        errors = self.adapter.validate_config({})
        self.assertEqual(len(errors), 3)
        self.assertTrue(any("app_id" in e for e in errors))
        self.assertTrue(any("app_secret" in e for e in errors))
        self.assertTrue(any("verification_token" in e for e in errors))

    def test_validate_config_ok(self):
        errors = self.adapter.validate_config({"app_id": "cli_x", "app_secret": "s", "verification_token": "vt"})
        self.assertEqual(errors, [])

    def test_validate_custom_bot_webhook_config(self):
        webhook_url = (
            "https://open.feishu.cn/open-apis/bot/v2/hook/"
            "00000000-0000-0000-0000-000000000000"
        )
        self.assertTrue(is_feishu_custom_bot_webhook_url(webhook_url))
        self.assertEqual(self.adapter.validate_config({"webhook_url": webhook_url}), [])

    def test_rejects_non_feishu_custom_bot_webhook(self):
        self.assertFalse(is_feishu_custom_bot_webhook_url("https://example.com/hook/secret"))
        errors = self.adapter.validate_config({"webhook_url": "https://example.com/hook/secret"})
        self.assertEqual(len(errors), 1)

    @patch("apps.services.common.url_security.ssrf_safe_request_async")
    def test_send_text_through_custom_bot_webhook(self, mocked_request):
        response = MagicMock(status_code=200)
        response.json.return_value = {"code": 0, "msg": "success"}
        mocked_request.return_value = response
        account = _make_account(
            config={
                "webhook_url": (
                    "https://open.feishu.cn/open-apis/bot/v2/hook/"
                    "00000000-0000-0000-0000-000000000000"
                )
            }
        )

        result = async_to_sync(self.adapter.send_text)(account, "ignored", "测试消息")

        self.assertTrue(result.ok)
        self.assertEqual(
            mocked_request.call_args.kwargs["json"],
            {"msg_type": "text", "content": {"text": "测试消息"}},
        )
        self.assertEqual(
            mocked_request.call_args.kwargs["trusted_hosts"],
            frozenset({"open.feishu.cn", "open.larksuite.com"}),
        )


class TestParseWebhookChallenge(SimpleTestCase):
    def setUp(self):
        self.adapter = FeishuAdapter()

    def test_url_verification_raises_challenge(self):
        body = {"type": "url_verification", "challenge": "abc123", "token": "t"}
        acct = _make_account()
        req = _make_request(body)

        with self.assertRaises(WebhookChallengeResponse) as ctx:
            self.adapter.parse_webhook(req, acct)
        self.assertEqual(ctx.exception.challenge, "abc123")

    def test_invalid_json_returns_none(self):
        req = HttpRequest()
        req._body = b"not json"
        req.method = "POST"
        acct = _make_account()
        self.assertIsNone(self.adapter.parse_webhook(req, acct))


class TestParseWebhookV2(SimpleTestCase):
    def setUp(self):
        self.adapter = FeishuAdapter()

    def _v2_body(self, text="hello", chat_type="p2p", msg_type="text"):
        return {
            "schema": "2.0",
            "header": {"event_type": "im.message.receive_v1"},
            "event": {
                "sender": {
                    "sender_id": {"open_id": "ou_abc", "user_id": "uid"},
                    "sender_type": "user",
                    "tenant_key": "tk",
                },
                "message": {
                    "message_id": "msg_001",
                    "chat_id": "oc_chat1",
                    "chat_type": chat_type,
                    "message_type": msg_type,
                    "content": json.dumps({"text": text}),
                    "create_time": str(int(time.time() * 1000)),
                },
            },
        }

    def test_parse_v2_text_dm(self):
        req = _make_request(self._v2_body("hi"))
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.channel, "feishu")
        self.assertEqual(msg.text, "hi")
        self.assertEqual(msg.peer_kind, "dm")
        self.assertEqual(msg.peer_id, "oc_chat1")
        self.assertEqual(msg.sender_id, "ou_abc")

    def test_parse_v2_group(self):
        req = _make_request(self._v2_body("grp", chat_type="group"))
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertEqual(msg.peer_kind, "group")

    def test_parse_v2_ignores_non_message_event(self):
        body = {
            "schema": "2.0",
            "header": {"event_type": "im.chat.member.bot.added_v1"},
            "event": {},
        }
        req = _make_request(body)
        self.assertIsNone(self.adapter.parse_webhook(req, _make_account()))


class TestParseWebhookV1(SimpleTestCase):
    def setUp(self):
        self.adapter = FeishuAdapter()

    def test_parse_v1_text(self):
        body = {
            "type": "event_callback",
            "token": _DEFAULT_VERIFICATION_TOKEN,
            "event": {
                "msg_type": "text",
                "text": "v1 msg",
                "open_chat_id": "oc_v1",
                "open_id": "ou_sender",
                "chat_type": "private",
                "create_time": str(int(time.time())),
            },
        }
        acct = _make_account()
        req = _make_request(body)
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "v1 msg")
        self.assertEqual(msg.peer_kind, "dm")


class TestParseWebhookSignature(SimpleTestCase):
    def setUp(self):
        self.adapter = FeishuAdapter()

    def test_valid_signature_passes(self):
        ts = str(int(time.time()))
        nonce = f"sig_valid_{uuid.uuid4().hex[:8]}"
        token = "my_encrypt_key"
        body_dict = self._v2_body("signed msg")
        body_bytes = json.dumps(body_dict).encode()
        content = ts + nonce + token + body_bytes.decode()
        sig = hashlib.sha256(content.encode()).hexdigest()

        req = _make_request(body_dict, {
            "X-Lark-Signature": sig,
            "X-Lark-Request-Timestamp": ts,
            "X-Lark-Request-Nonce": nonce,
        })
        acct = _make_account(config={"encrypt_key": token})
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "signed msg")

    def test_bad_signature_returns_none(self):
        ts = str(int(time.time()))
        body_dict = self._v2_body("test")
        req = _make_request(body_dict, {
            "X-Lark-Signature": "bad_sig",
            "X-Lark-Request-Timestamp": ts,
            "X-Lark-Request-Nonce": "n",
        })
        acct = _make_account(config={"encrypt_key": "key"})
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_missing_signature_with_key_returns_none(self):
        """When encrypt_key is configured but no X-Lark-Signature header, reject."""
        body_dict = self._v2_body("no sig")
        req = _make_request(body_dict, sign_key=None)
        acct = _make_account(config={"encrypt_key": "my_key"})
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_stale_timestamp_returns_none(self):
        stale_ts = str(int(time.time()) - TIMESTAMP_TOLERANCE_SECONDS - 60)
        nonce = "n"
        token = "key"
        body_dict = self._v2_body("old")
        body_bytes = json.dumps(body_dict).encode()
        content = stale_ts + nonce + token + body_bytes.decode()
        sig = hashlib.sha256(content.encode()).hexdigest()

        req = _make_request(body_dict, {
            "X-Lark-Signature": sig,
            "X-Lark-Request-Timestamp": stale_ts,
            "X-Lark-Request-Nonce": nonce,
        })
        acct = _make_account(config={"encrypt_key": token})
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def _v2_body(self, text="hello"):
        return {
            "schema": "2.0",
            "header": {"event_type": "im.message.receive_v1"},
            "event": {
                "sender": {
                    "sender_id": {"open_id": "ou_x"},
                    "sender_type": "user",
                },
                "message": {
                    "message_id": "msg_sig",
                    "chat_id": "oc_sig",
                    "chat_type": "p2p",
                    "message_type": "text",
                    "content": json.dumps({"text": text}),
                    "create_time": str(int(time.time() * 1000)),
                },
            },
        }


class TestTimestampFreshness(SimpleTestCase):
    def test_fresh_timestamp(self):
        self.assertTrue(_check_timestamp_freshness(str(int(time.time()))))

    def test_stale_timestamp(self):
        self.assertFalse(_check_timestamp_freshness(str(int(time.time()) - 600)))

    def test_empty_timestamp(self):
        self.assertFalse(_check_timestamp_freshness(""))

    def test_non_numeric_timestamp(self):
        self.assertFalse(_check_timestamp_freshness("abc"))


class TestSignatureVerification(SimpleTestCase):
    def test_correct_signature(self):
        ts = "1234567890"
        nonce = "nonce"
        key = "secret"
        body = b'{"test": true}'
        content = ts + nonce + key + body.decode()
        sig = hashlib.sha256(content.encode()).hexdigest()
        self.assertTrue(_verify_signature(ts, nonce, key, body, sig))

    def test_wrong_signature(self):
        self.assertFalse(_verify_signature("ts", "n", "k", b"body", "bad"))


class TestTextParsing(SimpleTestCase):
    def test_text_message(self):
        self.assertEqual(_parse_text_content('{"text": "hi"}', "text"), "hi")

    def test_post_message(self):
        post = {"zh_cn": {"title": "T", "content": [[{"tag": "text", "text": "body"}]]}}
        self.assertEqual(_parse_text_content(json.dumps(post), "post"), "T\nbody")

    def test_post_with_img_and_media(self):
        post = {"zh_cn": {"content": [
            [{"tag": "img"}, {"tag": "media"}, {"tag": "text", "text": "end"}],
        ]}}
        result = _extract_post_text(post)
        self.assertIn("[图片]", result)
        self.assertIn("[媒体]", result)
        self.assertIn("end", result)

    def test_build_post_message(self):
        result = json.loads(_build_post_message("hello"))
        self.assertIn("zh_cn", result)
        self.assertEqual(result["zh_cn"]["content"][0][0]["text"], "hello")


class TestTDP021SignatureKeyFallback(SimpleTestCase):
    """TDP-021 回归：签名密钥不应回退到 verification_token。"""

    def setUp(self):
        self.adapter = FeishuAdapter()

    def _v2_body(self, text="hello"):
        return {
            "schema": "2.0",
            "header": {"event_type": "im.message.receive_v1"},
            "event": {
                "sender": {
                    "sender_id": {"open_id": "ou_x"},
                    "sender_type": "user",
                },
                "message": {
                    "message_id": "msg_tdp",
                    "chat_id": "oc_tdp",
                    "chat_type": "p2p",
                    "message_type": "text",
                    "content": json.dumps({"text": text}),
                    "create_time": str(int(time.time() * 1000)),
                },
            },
        }

    def test_signature_with_vt_as_key_rejected_when_encrypt_key_absent(self):
        """只配 verification_token 时，用它计算的签名不应通过 HMAC 校验路径。"""
        vt = "my_verification_token"
        body_dict = self._v2_body("attack")
        body_bytes = json.dumps(body_dict).encode()
        ts = str(int(time.time()))
        nonce = f"tdp021_n1_{uuid.uuid4().hex[:8]}"
        sig = _compute_signature(ts, nonce, vt, body_bytes)

        req = _make_request(body_dict, {
            "X-Lark-Signature": sig,
            "X-Lark-Request-Timestamp": ts,
            "X-Lark-Request-Nonce": nonce,
        })
        acct = _make_account(config={"verification_token": vt})

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg, "仅有 vt 时应走 token 比对路径，不拒绝合法请求")

    def test_encrypt_key_used_for_signature(self):
        """配置了 encrypt_key 时，签名必须用 encrypt_key 计算。"""
        ek = "my_encrypt_key"
        vt = "my_vt"
        body_dict = self._v2_body("legit")
        body_bytes = json.dumps(body_dict).encode()
        ts = str(int(time.time()))
        nonce = f"tdp021_n2_{uuid.uuid4().hex[:8]}"
        sig_with_ek = _compute_signature(ts, nonce, ek, body_bytes)

        req = _make_request(body_dict, {
            "X-Lark-Signature": sig_with_ek,
            "X-Lark-Request-Timestamp": ts,
            "X-Lark-Request-Nonce": nonce,
        })
        acct = _make_account(config={"encrypt_key": ek, "verification_token": vt})
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)

    def test_signature_with_vt_fails_when_encrypt_key_present(self):
        """配置了 encrypt_key 时，用 vt 计算的签名应被拒绝。"""
        ek = "my_encrypt_key"
        vt = "my_vt"
        body_dict = self._v2_body("forge")
        body_bytes = json.dumps(body_dict).encode()
        ts = str(int(time.time()))
        nonce = f"tdp021_n3_{uuid.uuid4().hex[:8]}"
        sig_with_vt = _compute_signature(ts, nonce, vt, body_bytes)

        req = _make_request(body_dict, {
            "X-Lark-Signature": sig_with_vt,
            "X-Lark-Request-Timestamp": ts,
            "X-Lark-Request-Nonce": nonce,
        })
        acct = _make_account(config={"encrypt_key": ek, "verification_token": vt})
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


class TestConfigSchema(SimpleTestCase):
    def test_schema_has_required_fields(self):
        schema = FeishuAdapter().get_config_schema()
        self.assertIn("app_id", schema["properties"])
        self.assertIn("app_secret", schema["properties"])
        self.assertIn("verification_token", schema["properties"])
        self.assertIn("app_id", schema["required"])
        self.assertIn("verification_token", schema["required"])

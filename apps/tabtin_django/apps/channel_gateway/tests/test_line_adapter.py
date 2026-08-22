"""LineAdapter 纯单元测试（不依赖网络和数据库）。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from unittest.mock import MagicMock

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.line import (
    LineAdapter,
    _determine_peer,
    _parse_media_from_event,
    _verify_signature,
)

_DEFAULT_CHANNEL_SECRET = "test_channel_secret"


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "channel_access_token": "t",
        "channel_secret": _DEFAULT_CHANNEL_SECRET,
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


def _line_sign(channel_secret: str, body_bytes: bytes) -> str:
    mac = hmac.new(
        channel_secret.encode("utf-8"),
        body_bytes,
        hashlib.sha256,
    )
    return base64.b64encode(mac.digest()).decode("utf-8")


def _signed_request(
    body_dict: dict,
    channel_secret: str = _DEFAULT_CHANNEL_SECRET,
) -> HttpRequest:
    raw = json.dumps(body_dict).encode()
    sig = _line_sign(channel_secret, raw)
    return _make_request(body_dict, {"X-Line-Signature": sig})


# ---------------------------------------------------------------------------
# 1. Identity
# ---------------------------------------------------------------------------


class TestLineAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_id_and_name(self):
        self.assertEqual(self.adapter.id, "line")
        self.assertEqual(self.adapter.name, "LINE")

    def test_capabilities_threads_false(self):
        caps = self.adapter.capabilities
        self.assertFalse(caps.threads)
        self.assertTrue(caps.media)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)


# ---------------------------------------------------------------------------
# 2. Config validation
# ---------------------------------------------------------------------------


class TestLineAdapterConfigValidation(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_missing_channel_access_token_raises_error(self):
        errors = self.adapter.validate_config({"channel_secret": "s"})
        self.assertTrue(any("channel_access_token" in e for e in errors))

    def test_missing_channel_secret_raises_error(self):
        errors = self.adapter.validate_config({"channel_access_token": "t"})
        self.assertTrue(any("channel_secret" in e for e in errors))

    def test_missing_both(self):
        errors = self.adapter.validate_config({})
        self.assertEqual(len(errors), 2)

    def test_empty_channel_access_token_raises_error(self):
        errors = self.adapter.validate_config({
            "channel_access_token": "   ",
            "channel_secret": "s",
        })
        self.assertEqual(len(errors), 1)

    def test_valid_config(self):
        errors = self.adapter.validate_config({
            "channel_access_token": "token123",
            "channel_secret": "secret456",
        })
        self.assertEqual(errors, [])


# ---------------------------------------------------------------------------
# 3. 签名验证
# ---------------------------------------------------------------------------


class TestLineSignatureVerification(SimpleTestCase):
    def test_correct_hmac_sha256_base64_signature_passes(self):
        secret = "my_channel_secret"
        body = b'{"events":[{"type":"message"}]}'
        sig = _line_sign(secret, body)
        self.assertTrue(_verify_signature(secret, body, sig))

    def test_wrong_signature_rejected(self):
        secret = "my_channel_secret"
        body = b'{"events":[]}'
        self.assertFalse(_verify_signature(secret, body, "bad_signature"))

    def test_empty_signature_rejected(self):
        secret = "my_channel_secret"
        body = b'{"events":[]}'
        self.assertFalse(_verify_signature(secret, body, ""))


# ---------------------------------------------------------------------------
# 4. 签名缺失
# ---------------------------------------------------------------------------


class TestLineSignatureMissing(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def _text_event(self, text="hello"):
        return {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt123",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {"type": "text", "id": "m1", "text": text},
                    "timestamp": 1234567890000,
                }
            ]
        }

    def test_channel_secret_configured_but_no_x_line_signature_returns_none(self):
        body = self._text_event("no sig header")
        req = _make_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_missing_channel_secret_returns_none(self):
        body = self._text_event("no secret")
        req = _make_request(body)
        acct = _make_account(config={"channel_access_token": "t"})
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


# ---------------------------------------------------------------------------
# 5. Text 消息解析
# ---------------------------------------------------------------------------


class TestLineTextMessageParsing(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def _text_event(self, text="hello", reply_token="rt1"):
        return {
            "events": [
                {
                    "type": "message",
                    "replyToken": reply_token,
                    "source": {"type": "user", "userId": "user_abc"},
                    "message": {"type": "text", "id": "msg_001", "text": text},
                    "timestamp": 1234567890000,
                }
            ]
        }

    def test_text_message_parsed_correctly(self):
        body = self._text_event("你好世界")
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.channel, "line")
        self.assertEqual(msg.text, "你好世界")
        self.assertEqual(msg.peer_kind, "dm")
        self.assertEqual(msg.peer_id, "user_abc")
        self.assertEqual(msg.sender_id, "user_abc")


# ---------------------------------------------------------------------------
# 6. Group 消息
# ---------------------------------------------------------------------------


class TestLineGroupMessage(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_source_type_group_peer_kind_group_peer_id_group_id(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "group", "userId": "u1", "groupId": "g_123"},
                    "message": {"type": "text", "id": "m1", "text": "group msg"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.peer_kind, "group")
        self.assertEqual(msg.peer_id, "g_123")
        self.assertEqual(msg.sender_id, "u1")


# ---------------------------------------------------------------------------
# 7. Room 消息
# ---------------------------------------------------------------------------


class TestLineRoomMessage(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_source_type_room_peer_kind_group(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "room", "userId": "u1", "roomId": "r_456"},
                    "message": {"type": "text", "id": "m1", "text": "room msg"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.peer_kind, "group")
        self.assertEqual(msg.peer_id, "r_456")


# ---------------------------------------------------------------------------
# 8. Sticker 消息
# ---------------------------------------------------------------------------


class TestLineStickerMessage(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_sticker_parsed_as_package_id_sticker_id(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {
                        "type": "sticker",
                        "id": "sticker_001",
                        "packageId": "pkg_1",
                        "stickerId": "stk_2",
                    },
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertIn("packageId=pkg_1", msg.text)
        self.assertIn("stickerId=stk_2", msg.text)
        self.assertIn("[贴图]", msg.text)
        self.assertIsNotNone(msg.media)
        self.assertEqual(len(msg.media), 1)
        self.assertEqual(msg.media[0].kind, "sticker")


# ---------------------------------------------------------------------------
# 9. 媒体消息 (image/video/audio/file)
# ---------------------------------------------------------------------------


class TestLineMediaMessages(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_image_message_extracts_channel_media(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {"type": "image", "id": "img_001"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "[image]")
        self.assertEqual(len(msg.media), 1)
        self.assertEqual(msg.media[0].kind, "image")
        self.assertEqual(msg.media[0].file_id, "img_001")

    def test_video_message_extracts_channel_media(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {"type": "video", "id": "vid_001"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "[video]")
        self.assertEqual(msg.media[0].kind, "video")
        self.assertEqual(msg.media[0].file_id, "vid_001")

    def test_audio_message_extracts_channel_media(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {"type": "audio", "id": "aud_001"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "[audio]")
        self.assertEqual(msg.media[0].kind, "audio")

    def test_file_message_extracts_channel_media_with_filename(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {
                        "type": "file",
                        "id": "file_001",
                        "fileName": "doc.pdf",
                    },
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "[file]")
        self.assertEqual(msg.media[0].kind, "file")
        self.assertEqual(msg.media[0].file_id, "file_001")
        self.assertEqual(msg.media[0].filename, "doc.pdf")


# ---------------------------------------------------------------------------
# 10. 非 message 事件被忽略
# ---------------------------------------------------------------------------


class TestLineNonMessageEventsIgnored(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_follow_event_ignored(self):
        body = {
            "events": [
                {
                    "type": "follow",
                    "replyToken": "rt1",
                    "source": {"type": "user", "userId": "u1"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_unfollow_event_ignored(self):
        body = {
            "events": [
                {
                    "type": "unfollow",
                    "source": {"type": "user", "userId": "u1"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


# ---------------------------------------------------------------------------
# 11. replyToken 在 metadata 中
# ---------------------------------------------------------------------------


class TestLineReplyTokenInMetadata(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_reply_token_in_metadata(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "reply_token_xyz",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {"type": "text", "id": "m1", "text": "hi"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertIn("reply_token", msg.metadata)
        self.assertEqual(msg.metadata["reply_token"], "reply_token_xyz")


# ---------------------------------------------------------------------------
# 12. 空 events 返回 None
# ---------------------------------------------------------------------------


class TestLineEmptyEvents(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_empty_events_returns_none(self):
        body = {"events": []}
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_no_events_key_returns_none(self):
        body = {}
        req = _signed_request(body)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


# ---------------------------------------------------------------------------
# 辅助函数单元测试
# ---------------------------------------------------------------------------


class TestDeterminePeer(SimpleTestCase):
    def test_user_source_returns_dm(self):
        kind, peer_id, sender_id = _determine_peer({"type": "user", "userId": "u1"})
        self.assertEqual(kind, "dm")
        self.assertEqual(peer_id, "u1")
        self.assertEqual(sender_id, "u1")

    def test_group_source_returns_group_and_group_id(self):
        kind, peer_id, sender_id = _determine_peer({
            "type": "group",
            "userId": "u1",
            "groupId": "g_abc",
        })
        self.assertEqual(kind, "group")
        self.assertEqual(peer_id, "g_abc")
        self.assertEqual(sender_id, "u1")

    def test_room_source_returns_group_and_room_id(self):
        kind, peer_id, sender_id = _determine_peer({
            "type": "room",
            "userId": "u2",
            "roomId": "r_xyz",
        })
        self.assertEqual(kind, "group")
        self.assertEqual(peer_id, "r_xyz")
        self.assertEqual(sender_id, "u2")


class TestParseMediaFromEvent(SimpleTestCase):
    def test_image_returns_channel_media(self):
        media = _parse_media_from_event({"type": "image", "id": "img_1"})
        self.assertIsNotNone(media)
        self.assertEqual(len(media), 1)
        self.assertEqual(media[0].kind, "image")
        self.assertEqual(media[0].file_id, "img_1")

    def test_sticker_returns_channel_media(self):
        media = _parse_media_from_event({
            "type": "sticker",
            "id": "stk_1",
            "packageId": "p",
            "stickerId": "s",
        })
        self.assertIsNotNone(media)
        self.assertEqual(media[0].kind, "sticker")

    def test_unknown_type_returns_none(self):
        media = _parse_media_from_event({"type": "location", "id": "loc_1"})
        self.assertIsNone(media)

    def test_missing_id_returns_none(self):
        media = _parse_media_from_event({"type": "image"})
        self.assertIsNone(media)


# ---------------------------------------------------------------------------
# 签名验证 + 解析集成测试
# ---------------------------------------------------------------------------


class TestLineParseWebhookWithSignature(SimpleTestCase):
    def setUp(self):
        self.adapter = LineAdapter()

    def test_valid_signature_parse_succeeds(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {"type": "text", "id": "m1", "text": "signed msg"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        body_bytes = json.dumps(body).encode()
        sig = _line_sign("my_secret", body_bytes)
        req = _make_request(body, {"X-Line-Signature": sig})
        acct = _make_account(config={
            "channel_secret": "my_secret",
            "channel_access_token": "t",
        })
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "signed msg")

    def test_invalid_signature_returns_none(self):
        body = {
            "events": [
                {
                    "type": "message",
                    "replyToken": "rt1",
                    "source": {"type": "user", "userId": "u1"},
                    "message": {"type": "text", "id": "m1", "text": "tampered"},
                    "timestamp": 1234567890000,
                }
            ]
        }
        req = _make_request(body, {"X-Line-Signature": "wrong_sig"})
        acct = _make_account(config={
            "channel_secret": "my_secret",
            "channel_access_token": "t",
        })
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

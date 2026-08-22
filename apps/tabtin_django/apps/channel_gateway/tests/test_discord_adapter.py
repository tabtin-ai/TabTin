"""DiscordAdapter 纯单元测试（不依赖网络和数据库）。"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.base import WebhookChallengeResponse
from apps.channel_gateway.adapters.discord import (
    DiscordAdapter,
    _parse_attachments,
)

_SIG_HEADERS = {
    "X-Signature-Ed25519": "a" * 128,
    "X-Signature-Timestamp": "12345",
}


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "bot_token": "test_token",
        "public_key": "a" * 64,
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


def _signed_request(body_dict: dict, extra_headers: dict | None = None) -> HttpRequest:
    headers = dict(_SIG_HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    return _make_request(body_dict, headers)


def _message_create_payload(
    content: str = "hello",
    channel_id: str = "ch_123",
    channel_type: int = 0,
    author_bot: bool = False,
    attachments: list | None = None,
) -> dict:
    """构建 MESSAGE_CREATE 或直接消息对象的 payload。"""
    payload = {
        "id": "msg_001",
        "channel_id": channel_id,
        "channel_type": channel_type,
        "content": content,
        "author": {
            "id": "user_abc",
            "username": "alice",
            "bot": author_bot,
        },
        "timestamp": "2024-01-15T10:00:00.000Z",
    }
    if attachments:
        payload["attachments"] = attachments
    return payload


class TestDiscordAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_id(self):
        self.assertEqual(self.adapter.id, "discord")

    def test_name(self):
        self.assertEqual(self.adapter.name, "Discord")

    def test_capabilities(self):
        caps = self.adapter.capabilities
        self.assertTrue(caps.media)
        self.assertTrue(caps.threads)
        self.assertIn("direct", caps.chat_types)
        self.assertIn("group", caps.chat_types)
        self.assertIn("thread", caps.chat_types)


class TestDiscordConfigValidation(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_missing_bot_token_returns_error(self):
        errors = self.adapter.validate_config({})
        self.assertTrue(any("bot_token" in e for e in errors))

    def test_empty_bot_token_returns_error(self):
        errors = self.adapter.validate_config({"bot_token": "   ", "public_key": "a" * 64})
        self.assertTrue(any("bot_token" in e for e in errors))

    def test_missing_public_key_returns_error(self):
        errors = self.adapter.validate_config({"bot_token": "my_token_xyz"})
        self.assertTrue(any("public_key" in e for e in errors))

    def test_with_bot_token_and_public_key_passes(self):
        errors = self.adapter.validate_config({"bot_token": "my_token_xyz", "public_key": "a" * 64})
        nacl_errors = [e for e in errors if "PyNaCl" not in e]
        self.assertEqual(nacl_errors, [])


@patch("apps.channel_gateway.adapters.discord._verify_ed25519", return_value=True)
class TestPingInteraction(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_ping_type_1_raises_challenge_raw_json(self, _mock_verify):
        """PING interaction (type=1) 应抛出 WebhookChallengeResponse(raw_json=True)。"""
        body = {"type": 1}
        req = _signed_request(body)
        acct = _make_account()

        with self.assertRaises(WebhookChallengeResponse) as ctx:
            self.adapter.parse_webhook(req, acct)

        self.assertEqual(ctx.exception.challenge, '{"type": 1}')
        self.assertTrue(ctx.exception.raw_json)


@patch("apps.channel_gateway.adapters.discord._verify_ed25519", return_value=True)
class TestMessageCreateParsing(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_message_create_with_t_field(self, _mock_verify):
        """包含 t='MESSAGE_CREATE' 的事件正确解析。"""
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(content="hi from gateway"),
        }
        req = _signed_request(body)
        acct = _make_account()

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.channel, "discord")
        self.assertEqual(msg.text, "hi from gateway")
        self.assertEqual(msg.peer_kind, "group")
        self.assertEqual(msg.peer_id, "ch_123")
        self.assertEqual(msg.sender_id, "user_abc")


@patch("apps.channel_gateway.adapters.discord._verify_ed25519", return_value=True)
class TestDirectMessageObjectParsing(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_direct_message_object_without_t_field(self, _mock_verify):
        """没有 t 字段但有 content + author 的消息正确解析。"""
        body = _message_create_payload(content="direct msg")
        req = _signed_request(body)
        acct = _make_account()

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "direct msg")
        self.assertEqual(msg.sender_id, "user_abc")


@patch("apps.channel_gateway.adapters.discord._verify_ed25519", return_value=True)
class TestBotMessageFiltering(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_bot_message_ignored(self, _mock_verify):
        """author.bot=True 时被忽略。"""
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(content="bot says hi", author_bot=True),
        }
        req = _signed_request(body)
        acct = _make_account()

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


@patch("apps.channel_gateway.adapters.discord._verify_ed25519", return_value=True)
class TestApplicationCommandParsing(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_slash_command_type_2_parsed(self, _mock_verify):
        """APPLICATION_COMMAND (type=2) Slash command 正确解析。"""
        body = {
            "type": 2,
            "id": "inter_123",
            "token": "tok_xyz",
            "channel_id": "ch_cmd",
            "guild_id": "guild_1",
            "member": {
                "user": {"id": "user_slash", "username": "bob"},
            },
            "data": {
                "name": "greet",
                "options": [
                    {"name": "name", "value": "world"},
                ],
            },
        }
        req = _signed_request(body)
        acct = _make_account()

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.channel, "discord")
        self.assertEqual(msg.text, "/greet world")
        self.assertEqual(msg.peer_kind, "group")
        self.assertEqual(msg.peer_id, "ch_cmd")
        self.assertEqual(msg.sender_id, "user_slash")
        self.assertEqual(msg.metadata.get("command_name"), "greet")


class TestEd25519SignatureRejection(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_public_key_without_signature_header_rejected(self):
        """有 public_key 但缺少签名 header 时被拒绝。"""
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(content="signed msg"),
        }
        req = _make_request(body)
        acct = _make_account(config={"bot_token": "t", "public_key": "a" * 64})

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_missing_public_key_rejected(self):
        """缺少 public_key 配置时被拒绝。"""
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(content="no key"),
        }
        req = _signed_request(body)
        acct = _make_account(config={"bot_token": "t"})

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


class TestParseAttachments(SimpleTestCase):
    def test_empty_attachments_returns_none(self):
        self.assertIsNone(_parse_attachments([]))

    def test_attachment_without_url_skipped(self):
        result = _parse_attachments([{"id": "att_1", "filename": "x.txt"}])
        self.assertIsNone(result)

    def test_image_attachment_parsed(self):
        attachments = [
            {
                "id": "att_img",
                "url": "https://cdn.discord.com/attachments/x.png",
                "content_type": "image/png",
                "filename": "pic.png",
                "size": 1024,
            },
        ]
        result = _parse_attachments(attachments)
        self.assertIsNotNone(result)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].kind, "image")
        self.assertEqual(result[0].url, "https://cdn.discord.com/attachments/x.png")
        self.assertEqual(result[0].file_id, "att_img")
        self.assertEqual(result[0].filename, "pic.png")
        self.assertEqual(result[0].mime_type, "image/png")
        self.assertEqual(result[0].size, 1024)

    def test_video_attachment_parsed(self):
        attachments = [
            {"id": "v1", "url": "https://x.com/v.mp4", "content_type": "video/mp4"},
        ]
        result = _parse_attachments(attachments)
        self.assertIsNotNone(result)
        self.assertEqual(result[0].kind, "video")

    def test_audio_attachment_parsed(self):
        attachments = [
            {"id": "a1", "url": "https://x.com/a.mp3", "content_type": "audio/mpeg"},
        ]
        result = _parse_attachments(attachments)
        self.assertIsNotNone(result)
        self.assertEqual(result[0].kind, "audio")

    def test_unknown_content_type_defaults_to_file(self):
        attachments = [
            {"id": "f1", "url": "https://x.com/f.bin", "content_type": "application/octet-stream"},
        ]
        result = _parse_attachments(attachments)
        self.assertIsNotNone(result)
        self.assertEqual(result[0].kind, "file")


@patch("apps.channel_gateway.adapters.discord._verify_ed25519", return_value=True)
class TestMediaAttachmentInMessage(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_message_with_attachments_extracts_media(self, _mock_verify):
        """attachments 数组正确提取到 media。"""
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(
                content="check this",
                attachments=[
                    {
                        "id": "att_1",
                        "url": "https://cdn.discord.com/img.png",
                        "content_type": "image/png",
                        "filename": "img.png",
                    },
                ],
            ),
        }
        req = _signed_request(body)
        acct = _make_account()

        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertIsNotNone(msg.media)
        self.assertEqual(len(msg.media), 1)
        self.assertEqual(msg.media[0].kind, "image")
        self.assertEqual(msg.media[0].url, "https://cdn.discord.com/img.png")


@patch("apps.channel_gateway.adapters.discord._verify_ed25519", return_value=True)
class TestPeerKindMapping(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_channel_type_1_is_dm(self, _mock_verify):
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(content="dm", channel_type=1),
        }
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertIsNotNone(msg)
        self.assertEqual(msg.peer_kind, "dm")

    def test_channel_type_11_is_thread(self, _mock_verify):
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(
                content="thread msg",
                channel_id="thread_123",
                channel_type=11,
            ),
        }
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertIsNotNone(msg)
        self.assertEqual(msg.peer_kind, "thread")
        self.assertEqual(msg.thread_id, "thread_123")

    def test_channel_type_12_is_thread(self, _mock_verify):
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(
                content="thread msg",
                channel_id="thread_456",
                channel_type=12,
            ),
        }
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertIsNotNone(msg)
        self.assertEqual(msg.peer_kind, "thread")

    def test_channel_type_0_is_group(self, _mock_verify):
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(content="guild", channel_type=0),
        }
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertIsNotNone(msg)
        self.assertEqual(msg.peer_kind, "group")

    def test_channel_type_other_is_group(self, _mock_verify):
        body = {
            "t": "MESSAGE_CREATE",
            "d": _message_create_payload(content="other", channel_type=5),
        }
        req = _signed_request(body)
        msg = self.adapter.parse_webhook(req, _make_account())
        self.assertIsNotNone(msg)
        self.assertEqual(msg.peer_kind, "group")


class TestInvalidJson(SimpleTestCase):
    def setUp(self):
        self.adapter = DiscordAdapter()

    def test_invalid_json_returns_none(self):
        req = HttpRequest()
        req._body = b"not json"
        req.method = "POST"
        acct = _make_account()
        self.assertIsNone(self.adapter.parse_webhook(req, acct))

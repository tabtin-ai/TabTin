"""WhatsAppAdapter 纯单元测试（不依赖数据库和网络）。"""

from __future__ import annotations

import hmac
import hashlib
import json
import time
from unittest.mock import MagicMock

from django.http import HttpRequest
from django.test import SimpleTestCase

from apps.channel_gateway.adapters.whatsapp import (
    WhatsAppAdapter,
    _verify_webhook_signature,
    _parse_media_from_message,
    _extract_text,
)

_DEFAULT_APP_SECRET = "test_app_secret"


def _make_account(**overrides):
    acct = MagicMock()
    acct.account_id = overrides.pop("account_id", "default")
    acct.organization_id = overrides.pop("organization_id", "ws_1")
    acct.config = overrides.pop("config", {
        "access_token": "t",
        "phone_number_id": "pn",
        "app_secret": _DEFAULT_APP_SECRET,
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


def _compute_whatsapp_signature(app_secret: str, body: bytes) -> str:
    digest = hmac.new(
        app_secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()
    return f"sha256={digest}"


def _signed_request(body_dict: dict, app_secret: str = _DEFAULT_APP_SECRET) -> HttpRequest:
    raw = json.dumps(body_dict).encode()
    sig = _compute_whatsapp_signature(app_secret, raw)
    return _make_request(body_dict, {"X-Hub-Signature-256": sig})


def _wa_message_body(
    text: str | None = "hello",
    msg_type: str = "text",
    msg_id: str = "wamid.001",
    from_phone: str = "15551234567",
    contacts: list | None = None,
    metadata: dict | None = None,
    statuses: list | None = None,
    messages: list | None = None,
) -> dict:
    if messages is None:
        msg = {
            "id": msg_id,
            "from": from_phone,
            "timestamp": str(int(time.time())),
            "type": msg_type,
        }
        if msg_type == "text" and text:
            msg["text"] = {"body": text}
        elif msg_type == "reaction":
            msg["reaction"] = {"emoji": text or "👍"}
        elif msg_type in ("image", "video", "audio", "document"):
            media = {"id": "media_123"}
            if text:
                media["caption"] = text
            msg[msg_type] = media
        messages = [msg]

    entry = {
        "id": "entry_1",
        "changes": [
            {
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": metadata or {"phone_number_id": "pn_123"},
                    "contacts": contacts or [],
                    "messages": messages,
                    "statuses": statuses or [],
                }
            }
        ],
    }

    return {
        "object": "whatsapp_business_account",
        "entry": [entry],
    }


class TestWhatsAppAdapterIdentity(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_id(self):
        self.assertEqual(self.adapter.id, "whatsapp")

    def test_name(self):
        self.assertEqual(self.adapter.name, "WhatsApp")

    def test_capabilities_threads_false(self):
        caps = self.adapter.capabilities
        self.assertFalse(caps.threads)
        self.assertTrue(caps.media)
        self.assertIn("direct", caps.chat_types)


class TestWhatsAppConfigValidation(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_missing_access_token(self):
        errors = self.adapter.validate_config({
            "phone_number_id": "pn_123",
            "app_secret": "s",
        })
        self.assertIn("access_token is required", errors)

    def test_missing_phone_number_id(self):
        errors = self.adapter.validate_config({
            "access_token": "token",
            "app_secret": "s",
        })
        self.assertIn("phone_number_id is required", errors)

    def test_missing_app_secret(self):
        errors = self.adapter.validate_config({
            "access_token": "token",
            "phone_number_id": "pn_123",
        })
        self.assertIn("app_secret is required", errors)

    def test_all_missing(self):
        errors = self.adapter.validate_config({})
        self.assertEqual(len(errors), 3)
        self.assertIn("access_token is required", errors)
        self.assertIn("phone_number_id is required", errors)
        self.assertIn("app_secret is required", errors)

    def test_empty_strings_rejected(self):
        errors = self.adapter.validate_config({
            "access_token": "  ",
            "phone_number_id": "",
            "app_secret": "",
        })
        self.assertEqual(len(errors), 3)

    def test_valid_config(self):
        errors = self.adapter.validate_config({
            "access_token": "token",
            "phone_number_id": "pn_123",
            "app_secret": "my_secret",
        })
        self.assertEqual(errors, [])


class TestWebhookSignatureVerification(SimpleTestCase):
    def test_valid_signature_passes(self):
        body = b'{"object":"whatsapp_business_account","entry":[]}'
        app_secret = "my_app_secret"
        sig = _compute_whatsapp_signature(app_secret, body)
        self.assertTrue(_verify_webhook_signature(app_secret, body, sig))

    def test_wrong_signature_rejected(self):
        body = b'{"object":"whatsapp_business_account"}'
        app_secret = "secret"
        wrong_sig = "sha256=" + "0" * 64
        self.assertFalse(_verify_webhook_signature(app_secret, body, wrong_sig))

    def test_tampered_body_rejected(self):
        body = b'{"object":"whatsapp_business_account"}'
        app_secret = "secret"
        sig = _compute_whatsapp_signature(app_secret, body)
        tampered = b'{"object":"whatsapp_business_account","tampered":true}'
        self.assertFalse(_verify_webhook_signature(app_secret, tampered, sig))

    def test_missing_sha256_prefix_returns_false(self):
        self.assertFalse(_verify_webhook_signature("s", b"body", "abc123"))

    def test_empty_signature_returns_false(self):
        self.assertFalse(_verify_webhook_signature("s", b"body", ""))


class TestWebhookSignatureHeaderMissing(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_missing_signature_header_returns_none(self):
        body_dict = _wa_message_body("hello")
        req = _make_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_missing_app_secret_returns_none(self):
        body_dict = _wa_message_body("hello")
        req = _signed_request(body_dict)
        acct = _make_account(config={
            "access_token": "t",
            "phone_number_id": "pn",
        })
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


class TestWebhookMessageParsing(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_text_message_parsed(self):
        body_dict = _wa_message_body("hello world")
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "hello world")
        self.assertEqual(msg.channel, "whatsapp")
        self.assertEqual(msg.peer_id, "15551234567")
        self.assertEqual(msg.sender_id, "15551234567")
        self.assertEqual(msg.message_id, "wamid.001")
        self.assertEqual(msg.peer_kind, "dm")

    def test_text_message_with_explicit_signature(self):
        body_dict = _wa_message_body("signed msg")
        raw = json.dumps(body_dict).encode()
        sig = _compute_whatsapp_signature("app_secret", raw)
        req = _make_request(body_dict, {"X-Hub-Signature-256": sig})
        acct = _make_account(config={
            "access_token": "t",
            "phone_number_id": "pn",
            "app_secret": "app_secret",
        })
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "signed msg")


class TestNonWhatsAppBusinessAccountIgnored(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_page_object_ignored(self):
        body_dict = {"object": "page", "entry": []}
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

    def test_instagram_object_ignored(self):
        body_dict = {"object": "instagram", "entry": []}
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


class TestStatusUpdatesIgnored(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_statuses_ignored(self):
        body_dict = {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": "e1",
                    "changes": [
                        {
                            "value": {
                                "statuses": [
                                    {"id": "s1", "status": "delivered", "recipient_id": "1555"}
                                ],
                                "metadata": {"phone_number_id": "pn"},
                                "contacts": [],
                                "messages": [],
                            }
                        }
                    ],
                }
            ],
        }
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


class TestMediaMessageParsing(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_image_message(self):
        messages = [{
            "id": "img_1",
            "from": "15551234567",
            "timestamp": str(int(time.time())),
            "type": "image",
            "image": {"id": "img_id_123", "mime_type": "image/jpeg"},
        }]
        body_dict = _wa_message_body(messages=messages)
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertIsNotNone(msg.media)
        self.assertEqual(len(msg.media), 1)
        self.assertEqual(msg.media[0].kind, "image")
        self.assertEqual(msg.media[0].file_id, "img_id_123")
        self.assertEqual(msg.media[0].mime_type, "image/jpeg")

    def test_video_message(self):
        messages = [{
            "id": "vid_1",
            "from": "15551234567",
            "timestamp": str(int(time.time())),
            "type": "video",
            "video": {"id": "vid_id", "mime_type": "video/mp4"},
        }]
        body_dict = _wa_message_body(messages=messages)
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.media[0].kind, "video")
        self.assertEqual(msg.media[0].file_id, "vid_id")

    def test_audio_message(self):
        messages = [{
            "id": "aud_1",
            "from": "15551234567",
            "timestamp": str(int(time.time())),
            "type": "audio",
            "audio": {"id": "aud_id", "mime_type": "audio/ogg"},
        }]
        body_dict = _wa_message_body(messages=messages)
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.media[0].kind, "audio")
        self.assertEqual(msg.media[0].file_id, "aud_id")

    def test_document_message(self):
        messages = [{
            "id": "doc_1",
            "from": "15551234567",
            "timestamp": str(int(time.time())),
            "type": "document",
            "document": {
                "id": "doc_id",
                "mime_type": "application/pdf",
                "filename": "report.pdf",
            },
        }]
        body_dict = _wa_message_body(messages=messages)
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.media[0].kind, "file")
        self.assertEqual(msg.media[0].file_id, "doc_id")
        self.assertEqual(msg.media[0].filename, "report.pdf")


class TestReactionMessageParsing(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_reaction_parsed(self):
        messages = [{
            "id": "react_1",
            "from": "15551234567",
            "timestamp": str(int(time.time())),
            "type": "reaction",
            "reaction": {"emoji": "👍"},
        }]
        body_dict = _wa_message_body(messages=messages)
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "[reaction: 👍]")

    def test_extract_text_reaction(self):
        msg = {"type": "reaction", "reaction": {"emoji": "❤️"}}
        self.assertEqual(_extract_text(msg), "[reaction: ❤️]")


class TestCaptionExtraction(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_image_with_caption(self):
        messages = [{
            "id": "img_cap",
            "from": "15551234567",
            "timestamp": str(int(time.time())),
            "type": "image",
            "image": {
                "id": "img_1",
                "caption": "Check this out!",
            },
        }]
        body_dict = _wa_message_body(messages=messages)
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertEqual(msg.text, "Check this out!")
        self.assertIsNotNone(msg.media)

    def test_extract_text_caption(self):
        msg = {
            "type": "image",
            "image": {"id": "i1", "caption": "My caption"},
        }
        self.assertEqual(_extract_text(msg), "My caption")


class TestContactNameExtraction(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_sender_name_in_metadata(self):
        contacts = [
            {"wa_id": "15551234567", "profile": {"name": "Alice"}},
        ]
        body_dict = _wa_message_body(
            "hi",
            contacts=contacts,
            metadata={"phone_number_id": "pn_123"},
        )
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertIsNotNone(msg.metadata)
        self.assertEqual(msg.metadata.get("sender_name"), "Alice")

    def test_contact_mismatch_no_name(self):
        contacts = [{"wa_id": "9999999999", "profile": {"name": "Other"}}]
        body_dict = _wa_message_body("hi", from_phone="15551234567", contacts=contacts)
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNotNone(msg)
        self.assertNotIn("sender_name", msg.metadata or {})


class TestParseMediaFromMessage(SimpleTestCase):
    def test_image_extraction(self):
        msg = {"image": {"id": "img_1", "mime_type": "image/png"}}
        media = _parse_media_from_message(msg)
        self.assertIsNotNone(media)
        self.assertEqual(len(media), 1)
        self.assertEqual(media[0].kind, "image")
        self.assertEqual(media[0].file_id, "img_1")

    def test_multiple_media_not_supported(self):
        msg = {"image": {"id": "img_1"}}
        media = _parse_media_from_message(msg)
        self.assertEqual(len(media), 1)

    def test_no_media_returns_none(self):
        msg = {"type": "text", "text": {"body": "hi"}}
        self.assertIsNone(_parse_media_from_message(msg))

    def test_empty_id_skipped(self):
        msg = {"image": {"id": ""}}
        self.assertIsNone(_parse_media_from_message(msg))


class TestExtractText(SimpleTestCase):
    def test_text_type(self):
        msg = {"type": "text", "text": {"body": "hello"}}
        self.assertEqual(_extract_text(msg), "hello")

    def test_text_missing_body(self):
        msg = {"type": "text", "text": {}}
        self.assertEqual(_extract_text(msg), "")

    def test_reaction_type(self):
        msg = {"type": "reaction", "reaction": {"emoji": "😀"}}
        self.assertEqual(_extract_text(msg), "[reaction: 😀]")

    def test_reaction_empty_emoji(self):
        msg = {"type": "reaction", "reaction": {"emoji": ""}}
        self.assertIsNone(_extract_text(msg))

    def test_unknown_type(self):
        msg = {"type": "unknown"}
        self.assertIsNone(_extract_text(msg))


class TestInvalidJson(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_invalid_json_returns_none(self):
        raw = b"not valid json"
        sig = _compute_whatsapp_signature(_DEFAULT_APP_SECRET, raw)
        req = HttpRequest()
        req._body = raw
        req.method = "POST"
        req.META["HTTP_X_HUB_SIGNATURE_256"] = sig
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)


class TestEmptyEntry(SimpleTestCase):
    def setUp(self):
        self.adapter = WhatsAppAdapter()

    def test_empty_entry_returns_none(self):
        body_dict = {"object": "whatsapp_business_account", "entry": []}
        req = _signed_request(body_dict)
        acct = _make_account()
        msg = self.adapter.parse_webhook(req, acct)
        self.assertIsNone(msg)

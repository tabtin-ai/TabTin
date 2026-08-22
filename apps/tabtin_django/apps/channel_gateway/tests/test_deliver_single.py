"""deliver_outbox 的 _deliver_single 纯单元测试。"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from django.test import SimpleTestCase

from apps.channel_gateway.adapters.base import SendResult
from apps.channel_gateway.tasks import _deliver_single


class DeliverSingleTextOnlyTest(SimpleTestCase):
    def test_text_only(self):
        adapter = MagicMock()
        adapter.send_text = AsyncMock(return_value=SendResult(ok=True, provider_message_id="m1"))
        account = MagicMock()
        result = _deliver_single(adapter, account, "peer1", "hello", [])
        self.assertTrue(result.ok)
        adapter.send_text.assert_called_once()

    def test_empty_payload(self):
        adapter = MagicMock()
        account = MagicMock()
        result = _deliver_single(adapter, account, "peer1", "", [])
        self.assertFalse(result.ok)
        self.assertIn("empty", result.error)

    def test_whitespace_only_text(self):
        adapter = MagicMock()
        account = MagicMock()
        result = _deliver_single(adapter, account, "peer1", "   ", [])
        self.assertFalse(result.ok)


class DeliverSingleMediaOnlyTest(SimpleTestCase):
    def test_single_media_no_text(self):
        adapter = MagicMock()
        adapter.send_media = AsyncMock(return_value=SendResult(ok=True, provider_message_id="m2"))
        account = MagicMock()
        media = [{"url": "https://example.com/img.jpg", "mime_type": "image/jpeg"}]
        result = _deliver_single(adapter, account, "peer1", "", media)
        self.assertTrue(result.ok)
        adapter.send_media.assert_called_once()

    def test_media_without_url_or_file_id_returns_error(self):
        adapter = MagicMock()
        adapter.send_media = AsyncMock(return_value=SendResult(ok=True))
        account = MagicMock()
        media = [{"mime_type": "image/jpeg"}]
        result = _deliver_single(adapter, account, "peer1", "", media)
        self.assertFalse(result.ok)
        self.assertIn("no valid media", result.error)
        adapter.send_media.assert_not_called()


class DeliverSingleMixedTest(SimpleTestCase):
    def test_single_media_with_text_uses_caption(self):
        adapter = MagicMock()
        adapter.send_media = AsyncMock(return_value=SendResult(ok=True, provider_message_id="m3"))
        account = MagicMock()
        media = [{"url": "https://example.com/img.jpg"}]
        result = _deliver_single(adapter, account, "peer1", "my caption", media)
        self.assertTrue(result.ok)
        adapter.send_media.assert_called_once()
        call_kwargs = adapter.send_media.call_args
        self.assertEqual(call_kwargs.kwargs.get("caption"), "my caption")
        adapter.send_text.assert_not_called()

    def test_multiple_media_with_text_sends_text_separately(self):
        adapter = MagicMock()
        adapter.send_media = AsyncMock(return_value=SendResult(ok=True))
        adapter.send_text = AsyncMock(return_value=SendResult(ok=True, provider_message_id="m4"))
        account = MagicMock()
        media = [
            {"url": "https://example.com/img1.jpg"},
            {"url": "https://example.com/img2.jpg"},
        ]
        result = _deliver_single(adapter, account, "peer1", "description", media)
        self.assertTrue(result.ok)
        self.assertEqual(adapter.send_media.call_count, 2)
        adapter.send_text.assert_called_once()

    def test_media_send_failure_stops_early(self):
        adapter = MagicMock()
        adapter.send_media = AsyncMock(return_value=SendResult(ok=False, error="network error"))
        account = MagicMock()
        media = [
            {"url": "https://example.com/img1.jpg"},
            {"url": "https://example.com/img2.jpg"},
        ]
        result = _deliver_single(adapter, account, "peer1", "text", media)
        self.assertFalse(result.ok)
        self.assertEqual(adapter.send_media.call_count, 1)

    def test_text_send_failure_after_media_returns_error(self):
        adapter = MagicMock()
        adapter.send_media = AsyncMock(return_value=SendResult(ok=True))
        adapter.send_text = AsyncMock(return_value=SendResult(ok=False, error="text failed"))
        account = MagicMock()
        media = [
            {"url": "https://example.com/img1.jpg"},
            {"url": "https://example.com/img2.jpg"},
        ]
        result = _deliver_single(adapter, account, "peer1", "desc", media)
        self.assertFalse(result.ok)
        self.assertIn("text failed", result.error)


class DeliverSingleTypeDefenseTest(SimpleTestCase):
    def test_non_list_media_treated_as_empty(self):
        adapter = MagicMock()
        adapter.send_text = AsyncMock(return_value=SendResult(ok=True))
        account = MagicMock()
        result = _deliver_single(adapter, account, "peer1", "text", "not-a-list")
        self.assertTrue(result.ok)
        adapter.send_text.assert_called_once()

    def test_non_dict_media_item_skipped(self):
        adapter = MagicMock()
        adapter.send_media = AsyncMock(return_value=SendResult(ok=True))
        account = MagicMock()
        media = [{"url": "https://example.com/img.jpg"}, "bad_item", 42]
        result = _deliver_single(adapter, account, "peer1", "", media)
        self.assertTrue(result.ok)
        self.assertEqual(adapter.send_media.call_count, 1)

    def test_invalid_media_with_text_still_sends_text(self):
        """When all media items are invalid but text exists, text should still be sent."""
        adapter = MagicMock()
        adapter.send_text = AsyncMock(return_value=SendResult(ok=True))
        account = MagicMock()
        media = [{"mime_type": "image/jpeg"}]
        result = _deliver_single(adapter, account, "peer1", "fallback text", media)
        self.assertTrue(result.ok)
        adapter.send_text.assert_called_once()


class DeliverSingleMediaFileIdTest(SimpleTestCase):
    def test_media_with_file_id_instead_of_url(self):
        adapter = MagicMock()
        adapter.send_media = AsyncMock(return_value=SendResult(ok=True))
        account = MagicMock()
        media = [{"file_id": "AgACAgIAAxk", "mime_type": "image/jpeg"}]
        result = _deliver_single(adapter, account, "peer1", "", media)
        self.assertTrue(result.ok)
        call_args = adapter.send_media.call_args[0]
        self.assertEqual(call_args[2], "AgACAgIAAxk")

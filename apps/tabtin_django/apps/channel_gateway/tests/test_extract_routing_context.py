"""Tests for adapter extract_routing_context implementations."""

from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase

from apps.channel_gateway.adapters.dingtalk import DingTalkAdapter
from apps.channel_gateway.adapters.wechat_work import WeChatWorkAdapter
from apps.channel_gateway.adapters.msteams import MSTeamsAdapter
from apps.channel_gateway.adapters.googlechat import GoogleChatAdapter


def _inbound(channel="dingtalk", sender_id="u1", peer_kind="dm", metadata=None):
    return SimpleNamespace(
        channel=channel,
        sender_id=sender_id,
        peer_kind=peer_kind,
        metadata=metadata,
    )


class DingTalkExtractRoutingTests(TestCase):
    def setUp(self):
        self.adapter = DingTalkAdapter()

    def test_returns_conversation_type_and_sender(self):
        data = _inbound(metadata={"conversation_type": "2"})
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"conversation_type": "2", "sender_staff_id": "u1"})

    def test_no_conversation_type_still_returns_sender(self):
        data = _inbound(metadata={})
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"sender_staff_id": "u1"})

    def test_none_metadata(self):
        data = _inbound(metadata=None)
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"sender_staff_id": "u1"})


class WeChatWorkExtractRoutingTests(TestCase):
    def setUp(self):
        self.adapter = WeChatWorkAdapter()

    def test_returns_peer_kind_dm(self):
        data = _inbound(channel="wechat_work", peer_kind="dm")
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"peer_kind": "dm"})

    def test_returns_peer_kind_group(self):
        data = _inbound(channel="wechat_work", peer_kind="group")
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"peer_kind": "group"})

    def test_empty_peer_kind_returns_none(self):
        data = _inbound(channel="wechat_work", peer_kind="")
        ctx = self.adapter.extract_routing_context(data)
        self.assertIsNone(ctx)


class MSTeamsExtractRoutingTests(TestCase):
    def setUp(self):
        self.adapter = MSTeamsAdapter()

    def test_returns_service_url_when_trusted(self):
        data = _inbound(
            channel="msteams",
            metadata={"service_url": "https://smba.trafficmanager.net/amer"},
        )
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"service_url": "https://smba.trafficmanager.net/amer"})

    def test_returns_none_when_untrusted_url(self):
        data = _inbound(
            channel="msteams",
            metadata={"service_url": "https://evil.example.com/hack"},
        )
        ctx = self.adapter.extract_routing_context(data)
        self.assertIsNone(ctx)

    def test_returns_none_when_no_service_url(self):
        data = _inbound(channel="msteams", metadata={})
        ctx = self.adapter.extract_routing_context(data)
        self.assertIsNone(ctx)


class GoogleChatExtractRoutingTests(TestCase):
    def test_returns_none_by_default(self):
        adapter = GoogleChatAdapter()
        data = _inbound(channel="googlechat")
        ctx = adapter.extract_routing_context(data)
        self.assertIsNone(ctx)

"""Tests for adapter.extract_routing_context implementations."""

from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase

from apps.channel_gateway.adapters.dingtalk import DingTalkAdapter
from apps.channel_gateway.adapters.wechat_work import WeChatWorkAdapter
from apps.channel_gateway.adapters.msteams import MSTeamsAdapter
from apps.channel_gateway.adapters.googlechat import GoogleChatAdapter


def _msg(**overrides) -> SimpleNamespace:
    defaults = dict(
        channel="test",
        sender_id="sender_1",
        peer_id="peer_1",
        peer_kind="dm",
        metadata=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class DingTalkExtractRoutingTests(TestCase):
    def setUp(self):
        self.adapter = DingTalkAdapter()

    def test_extracts_conversation_type_and_sender(self):
        data = _msg(
            channel="dingtalk",
            sender_id="staff_1",
            metadata={"conversation_type": "2"},
        )
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"conversation_type": "2", "sender_staff_id": "staff_1"})

    def test_extracts_sender_without_conversation_type(self):
        data = _msg(channel="dingtalk", sender_id="staff_2", metadata={})
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"sender_staff_id": "staff_2"})


class WeChatWorkExtractRoutingTests(TestCase):
    def setUp(self):
        self.adapter = WeChatWorkAdapter()

    def test_extracts_peer_kind(self):
        data = _msg(channel="wechat_work", peer_kind="group")
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"peer_kind": "group"})

    def test_returns_none_when_peer_kind_empty(self):
        data = _msg(channel="wechat_work", peer_kind="")
        ctx = self.adapter.extract_routing_context(data)
        self.assertIsNone(ctx)


class MSTeamsExtractRoutingTests(TestCase):
    def setUp(self):
        self.adapter = MSTeamsAdapter()

    def test_extracts_service_url(self):
        data = _msg(
            channel="msteams",
            metadata={"service_url": "https://smba.trafficmanager.net/amer"},
        )
        ctx = self.adapter.extract_routing_context(data)
        self.assertEqual(ctx, {"service_url": "https://smba.trafficmanager.net/amer"})

    def test_rejects_invalid_service_url(self):
        data = _msg(
            channel="msteams",
            metadata={"service_url": "https://evil.example.com/callback"},
        )
        ctx = self.adapter.extract_routing_context(data)
        self.assertIsNone(ctx)

    def test_returns_none_without_service_url(self):
        data = _msg(channel="msteams", metadata={})
        ctx = self.adapter.extract_routing_context(data)
        self.assertIsNone(ctx)


class GoogleChatExtractRoutingTests(TestCase):
    def setUp(self):
        self.adapter = GoogleChatAdapter()

    def test_returns_none_by_default(self):
        data = _msg(channel="googlechat")
        ctx = self.adapter.extract_routing_context(data)
        self.assertIsNone(ctx)

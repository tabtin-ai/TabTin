"""channel_poll 任务测试 — 验证动态发现和分发逻辑。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.channel_gateway.adapters.base import ChannelCapabilities
from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry


class ChannelPollDiscoveryTest(SimpleTestCase):
    """验证 channel_poll 只轮询 supports_polling=True 的 adapter。"""

    def setUp(self):
        ChannelAdapterRegistry._reset()

    def tearDown(self):
        ChannelAdapterRegistry._reset()

    def _make_adapter(self, channel_id: str, supports_polling: bool):
        adapter = MagicMock()
        adapter.id = channel_id
        adapter.name = channel_id.capitalize()
        adapter.capabilities = ChannelCapabilities(supports_polling=supports_polling)
        return adapter

    def test_registry_lists_all(self):
        a1 = self._make_adapter("telegram", True)
        a2 = self._make_adapter("feishu", False)
        ChannelAdapterRegistry.register(a1)
        ChannelAdapterRegistry.register(a2)

        all_adapters = ChannelAdapterRegistry.list_all()
        self.assertEqual(len(all_adapters), 2)

    def test_polling_filter(self):
        a1 = self._make_adapter("telegram", True)
        a2 = self._make_adapter("feishu", False)
        ChannelAdapterRegistry.register(a1)
        ChannelAdapterRegistry.register(a2)

        polling = [a for a in ChannelAdapterRegistry.list_all() if a.capabilities.supports_polling]
        self.assertEqual(len(polling), 1)
        self.assertEqual(polling[0].id, "telegram")

    def test_feishu_adapter_not_polling(self):
        from apps.channel_gateway.adapters.feishu import FeishuAdapter

        adapter = FeishuAdapter()
        self.assertFalse(adapter.capabilities.supports_polling)

    def test_channel_poll_skips_non_polling(self):
        """Integration-style test: channel_poll only calls _poll_channel for polling adapters."""
        polling_adapter = self._make_adapter("telegram", True)
        webhook_adapter = self._make_adapter("feishu", False)

        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        with (
            patch("apps.channel_gateway.tasks._poll_channel", return_value=0) as mock_poll,
            patch(
                "apps.channel_gateway.adapters.registry.ChannelAdapterRegistry.list_all",
                return_value=[polling_adapter, webhook_adapter],
            ),
            patch("django_redis.get_redis_connection", return_value=mock_redis),
        ):
            from apps.channel_gateway.tasks import channel_poll
            channel_poll()

        mock_poll.assert_called_once()
        self.assertEqual(mock_poll.call_args[0][0].id, "telegram")

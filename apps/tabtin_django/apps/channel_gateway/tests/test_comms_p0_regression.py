"""COM-1 / COM-2 / COM-3 / COM-4 P0 回归测试。

确保前一轮修复的通信层 P0 问题不会回退。
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.test import TestCase, SimpleTestCase
from django.utils import timezone

from apps.channel_gateway.models import ChannelOutboundMessageRecord
from apps.channel_gateway.services.outbound_service import ChannelOutboundService


class COM1RetryPendingOnlyResetsDispatchedTest(TestCase):
    """COM-1: retry_pending 仅重置超时的 dispatched 记录，不做 WS 送达。"""

    def _create_record(self, status="pending", attempts=0, next_retry_at=None):
        return ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_test",
            peer_id="peer_1",
            payload={"text": "hi"},
            status=status,
            attempts=attempts,
            next_retry_at=next_retry_at,
        )

    def test_retry_pending_ignores_pending_records(self):
        """retry_pending 不应处理 pending 记录（仅处理 dispatched）。"""
        past = timezone.now() - timedelta(minutes=5)
        record = self._create_record(status="pending", next_retry_at=past)

        svc = ChannelOutboundService()
        retried = svc.retry_pending(limit=50)

        record.refresh_from_db()
        self.assertEqual(retried, 0)
        self.assertEqual(record.status, "pending")

    def test_retry_pending_resets_timed_out_dispatched(self):
        """dispatched 且超时的记录应被重置为 pending。"""
        past = timezone.now() - timedelta(minutes=5)
        record = self._create_record(status="dispatched", attempts=1, next_retry_at=past)

        svc = ChannelOutboundService()
        retried = svc.retry_pending(limit=50)

        record.refresh_from_db()
        self.assertEqual(retried, 1)
        self.assertEqual(record.status, "pending")

    def test_retry_pending_marks_max_attempts_as_failed(self):
        """dispatched 且已达 max_attempts 的记录应标记为 failed。"""
        past = timezone.now() - timedelta(minutes=5)
        svc = ChannelOutboundService()
        record = self._create_record(
            status="dispatched",
            attempts=svc.max_attempts,
            next_retry_at=past,
        )

        svc.retry_pending(limit=50)

        record.refresh_from_db()
        self.assertEqual(record.status, "failed")
        self.assertIsNone(record.next_retry_at)

    def test_retry_pending_does_not_call_ws_publish(self):
        """确认 retry_pending 不调用 publish_ws_event（WS 仅做通知）。"""
        past = timezone.now() - timedelta(minutes=5)
        self._create_record(status="dispatched", attempts=1, next_retry_at=past)

        with patch(
            "apps.channel_gateway.services.outbound_service.publish_ws_event"
        ) as mock_ws:
            ChannelOutboundService().retry_pending(limit=50)
            mock_ws.assert_not_called()


class COM2DeliverOutboxNoAdapterTest(TestCase):
    """COM-2: deliver_outbox 找不到适配器时应 mark_failed。"""

    @patch("apps.channel_gateway.adapters.registry.ChannelAdapterRegistry.get", return_value=None)
    def test_no_adapter_marks_failed(self, _get):
        record = ChannelOutboundMessageRecord.objects.create(
            channel="nonexistent_channel",
            account_id="default",
            organization_id="ws_test",
            peer_id="peer_1",
            payload={"text": "hi"},
            status="pending",
            attempts=0,
        )

        from apps.channel_gateway.tasks import deliver_outbox
        deliver_outbox(limit=10)

        record.refresh_from_db()
        self.assertEqual(record.status, "failed")
        self.assertIn("no adapter", record.last_error)


class COM3DispatchAgentReplyTaskExistsTest(SimpleTestCase):
    """COM-3: dispatch_agent_reply 任务应存在且配置正确。"""

    def test_task_registered(self):
        from apps.channel_gateway.tasks import dispatch_agent_reply

        self.assertEqual(dispatch_agent_reply.name, "channel_gateway.dispatch_agent_reply")

    def test_task_has_adequate_time_limit(self):
        from apps.channel_gateway.tasks import dispatch_agent_reply

        time_limit = dispatch_agent_reply.time_limit
        self.assertIsNotNone(time_limit)
        self.assertGreaterEqual(time_limit, 300)

    def test_process_inbound_has_short_time_limit(self):
        """process_inbound_message 的 time_limit 应较短（快速入站处理）。"""
        from apps.channel_gateway.tasks import process_inbound_message

        time_limit = process_inbound_message.time_limit
        self.assertIsNotNone(time_limit)
        self.assertLessEqual(time_limit, 60)

    def test_inbound_service_dispatches_async(self):
        """handle_inbound 应异步分派 LLM 调用，而非同步。"""
        import inspect
        from apps.channel_gateway.services.inbound_service import ChannelInboundService

        source = inspect.getsource(ChannelInboundService.handle_inbound)
        self.assertIn("dispatch_agent_reply", source)
        self.assertNotIn("send_message_sync", source)


class COM4ChannelPollLockTTLTest(SimpleTestCase):
    """COM-4: channel_poll Redis 锁 TTL 应 >= time_limit。"""

    def test_lock_ttl_gte_time_limit(self):
        """锁 TTL 必须 >= task time_limit，防止并发轮询。"""
        import inspect
        from apps.channel_gateway.tasks import channel_poll

        source = inspect.getsource(channel_poll)
        self.assertIn("ex=65", source)

        time_limit = channel_poll.time_limit
        self.assertIsNotNone(time_limit)
        self.assertGreaterEqual(65, time_limit)

"""P0 回归测试 — COM-1/COM-2/COM-3/COM-4 修复验证。"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, PropertyMock

from django.test import TestCase, SimpleTestCase
from django.utils import timezone

from apps.channel_gateway.models import ChannelOutboundMessageRecord
from apps.channel_gateway.services.outbound_service import ChannelOutboundService


# =====================================================================
# COM-1: retry_pending 不再走 WS 发送，仅重置 dispatched → pending
# =====================================================================

class COM1RetryPendingNoWSSendTest(TestCase):
    """COM-1 回归：retry_pending 只做状态重置，不调用 _attempt_send（WS 路径）。"""

    def test_dispatched_record_reset_to_pending(self):
        """超时的 dispatched 记录应被重置为 pending，而非通过 WS 重发。"""
        record = ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_1",
            peer_id="peer_1",
            payload={"text": "hello"},
            status="dispatched",
            attempts=1,
            next_retry_at=timezone.now() - timedelta(seconds=10),
        )

        svc = ChannelOutboundService()
        retried = svc.retry_pending()

        record.refresh_from_db()
        self.assertEqual(record.status, "pending")
        self.assertEqual(retried, 1)

    def test_dispatched_max_attempts_marked_failed(self):
        """已达最大重试次数的 dispatched 记录应直接标记 failed。"""
        svc = ChannelOutboundService()
        record = ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_1",
            peer_id="peer_1",
            payload={"text": "hello"},
            status="dispatched",
            attempts=svc.max_attempts,
            next_retry_at=timezone.now() - timedelta(seconds=10),
        )

        retried = svc.retry_pending()

        record.refresh_from_db()
        self.assertEqual(record.status, "failed")
        self.assertEqual(retried, 0)

    def test_retry_pending_does_not_touch_pending_records(self):
        """retry_pending 现在只处理 dispatched 状态，不再处理 pending。"""
        record = ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_1",
            peer_id="peer_1",
            payload={"text": "hello"},
            status="pending",
            attempts=0,
            next_retry_at=None,
        )

        svc = ChannelOutboundService()
        retried = svc.retry_pending()

        record.refresh_from_db()
        self.assertEqual(record.status, "pending")
        self.assertEqual(retried, 0)

    @patch("apps.channel_gateway.services.outbound_service.publish_ws_event")
    def test_retry_pending_never_calls_ws_publish(self, mock_ws):
        """retry_pending 不应调用 WS publish（COM-1 核心约束）。"""
        ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_1",
            peer_id="peer_1",
            payload={"text": "hello"},
            status="dispatched",
            attempts=1,
            next_retry_at=timezone.now() - timedelta(seconds=10),
        )

        svc = ChannelOutboundService()
        svc.retry_pending()

        mock_ws.assert_not_called()


# =====================================================================
# COM-2: deliver_outbox 无适配器时标记 failed
# =====================================================================

class COM2NoAdapterMarkFailedTest(TestCase):
    """COM-2 回归：deliver_outbox 找不到适配器时 mark_failed 而非 continue。"""

    def test_no_adapter_marks_record_failed(self):
        record = ChannelOutboundMessageRecord.objects.create(
            channel="nonexistent_channel",
            account_id="default",
            organization_id="ws_1",
            peer_id="peer_1",
            payload={"text": "hello"},
            status="pending",
            attempts=0,
        )

        with patch(
            "apps.channel_gateway.adapters.registry.ChannelAdapterRegistry.get",
            return_value=None,
        ):
            from apps.channel_gateway.tasks import deliver_outbox
            deliver_outbox(limit=10)

        record.refresh_from_db()
        self.assertEqual(record.status, "failed")
        self.assertIn("no adapter", record.last_error)


# =====================================================================
# COM-3: handle_inbound 不再同步调 LLM，而是 dispatch 异步任务
# =====================================================================

class COM3InboundDispatchesAsyncLLMTest(SimpleTestCase):
    """COM-3 回归：handle_inbound 派发 dispatch_agent_reply 异步任务而非同步调 LLM。"""

    def test_handle_inbound_dispatches_async_task(self):
        from apps.channel_gateway.services.inbound_service import ChannelInboundService

        svc = ChannelInboundService()

        data = SimpleNamespace(
            organization_id="ws_1",
            message_id="msg_1",
            text="hello",
            channel="telegram",
            account_id="default",
            peer_id="peer_1",
            peer_kind="dm",
            schema_version=1,
            sender_id="user_1",
            space_id=None,
            metadata={},
            media=None,
            model_dump=lambda: {
                "schema_version": 1,
                "type": "channel.inbound",
                "channel": "telegram",
                "account_id": "default",
                "organization_id": "ws_1",
                "peer_kind": "dm",
                "peer_id": "peer_1",
                "sender_id": "user_1",
                "message_id": "msg_1",
                "text": "hello",
                "timestamp": 0,
            },
        )

        binding = SimpleNamespace(
            id="binding_1",
            status="active",
            space_id=None,
            execution_agent_id=None,
            session_id="sess_1",
            thread_id="thread_1",
        )
        allowed = SimpleNamespace(allowed=True, pairing_required=False, reason=None)

        with (
            patch.object(svc, "_register_inbound", return_value=True),
            patch.object(svc, "_handle_bot_command", return_value=False),
            patch.object(svc, "_get_account", return_value=None),
            patch.object(svc, "_get_binding", return_value=binding),
            patch.object(svc, "_resolve_binding", return_value=binding),
            patch.object(svc, "_sync_routing_context"),
            patch.object(svc, "_send_typing_indicator"),
            patch.object(svc, "_emit_extension_event"),
            patch(
                "apps.channel_gateway.services.inbound_service.ChannelPolicyService.evaluate",
                return_value=allowed,
            ),
            patch(
                "apps.channel_gateway.tasks.dispatch_agent_reply.delay"
            ) as mock_delay,
        ):
            svc.handle_inbound(data)

        mock_delay.assert_called_once()
        call_kwargs = mock_delay.call_args
        self.assertEqual(call_kwargs.kwargs["binding_id"], "binding_1")
        self.assertEqual(call_kwargs.kwargs["message_text"], "hello")

    def test_dead_code_dispatch_message_removed(self):
        """_dispatch_message / _publish_outbound 死代码已移除 (CD-021)。"""
        from apps.channel_gateway.services.inbound_service import ChannelInboundService

        svc = ChannelInboundService()
        self.assertFalse(hasattr(svc, "_dispatch_message"))
        self.assertFalse(hasattr(svc, "_publish_outbound"))


class COM3DispatchAgentReplyTaskTest(SimpleTestCase):
    """COM-3 回归：dispatch_agent_reply 任务配置验证。"""

    def test_task_time_limit_is_300(self):
        from apps.channel_gateway.tasks import dispatch_agent_reply
        self.assertEqual(dispatch_agent_reply.time_limit, 300)

    def test_task_soft_time_limit_is_280(self):
        from apps.channel_gateway.tasks import dispatch_agent_reply
        self.assertEqual(dispatch_agent_reply.soft_time_limit, 280)

    def test_task_routes_to_heavy_queue(self):
        from apps.channel_gateway.tasks import dispatch_agent_reply
        self.assertEqual(dispatch_agent_reply.queue, "heavy")

    def test_process_inbound_time_limit_reduced(self):
        from apps.channel_gateway.tasks import process_inbound_message
        self.assertEqual(process_inbound_message.time_limit, 30)


# =====================================================================
# COM-4: channel_poll Redis 锁 TTL ≥ time_limit
# =====================================================================

class COM4PollLockTTLTest(SimpleTestCase):
    """COM-4 回归：channel_poll Redis 锁 TTL 应 ≥ time_limit（60s）。"""

    def test_poll_lock_ttl_at_least_60s(self):
        mock_redis = MagicMock()
        mock_redis.set.return_value = True

        adapter = MagicMock()
        adapter.id = "telegram"
        adapter.capabilities.supports_polling = True

        with (
            patch(
                "apps.channel_gateway.adapters.registry.ChannelAdapterRegistry.list_all",
                return_value=[adapter],
            ),
            patch("django_redis.get_redis_connection", return_value=mock_redis),
            patch("apps.channel_gateway.tasks._poll_channel", return_value=0),
        ):
            from apps.channel_gateway.tasks import channel_poll
            channel_poll()

        set_call = mock_redis.set.call_args
        self.assertGreaterEqual(set_call.kwargs.get("ex", 0), 60)

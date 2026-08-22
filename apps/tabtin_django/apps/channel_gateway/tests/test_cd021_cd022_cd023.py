"""CD-021 / CD-022 / CD-023 回归测试。"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


# =====================================================================
# CD-021: _dispatch_message / _publish_outbound 死代码已删除
# =====================================================================

class CD021DeadCodeRemovedTest(SimpleTestCase):
    """CD-021: 确认 ChannelInboundService 不再包含已废弃的同步调度方法。"""

    def test_dispatch_message_not_present(self):
        from apps.channel_gateway.services.inbound_service import ChannelInboundService
        svc = ChannelInboundService()
        self.assertFalse(
            hasattr(svc, "_dispatch_message"),
            "_dispatch_message should have been removed as dead code",
        )

    def test_publish_outbound_not_present(self):
        from apps.channel_gateway.services.inbound_service import ChannelInboundService
        svc = ChannelInboundService()
        self.assertFalse(
            hasattr(svc, "_publish_outbound"),
            "_publish_outbound should have been removed as dead code",
        )

    def test_handle_inbound_delegates_to_celery_task(self):
        """handle_inbound 通过 dispatch_agent_reply.delay 异步调度而非同步方法。"""
        from apps.channel_gateway.services.inbound_service import ChannelInboundService

        svc = ChannelInboundService()
        data_dict = {
            "schema_version": 1, "type": "channel.inbound",
            "channel": "telegram", "account_id": "default",
            "organization_id": "ws_1", "peer_kind": "dm",
            "peer_id": "peer_1", "sender_id": "user_1",
            "message_id": "msg_cd021", "text": "test", "timestamp": 0,
        }
        data = SimpleNamespace(
            organization_id="ws_1", message_id="msg_cd021", text="test",
            channel="telegram", account_id="default", peer_id="peer_1",
            peer_kind="dm", schema_version=1, sender_id="user_1",
            space_id=None, metadata={}, media=None,
            model_dump=lambda: data_dict,
        )
        binding = SimpleNamespace(
            id="b_cd021", status="active", space_id=None,
            execution_agent_id=None, session_id="s1", thread_id="t1",
        )
        allowed = SimpleNamespace(allowed=True, pairing_required=False, reason=None)

        with (
            patch.object(svc, "_register_inbound", return_value=True),
            patch.object(svc, "_handle_bot_command", return_value=False),
            patch.object(svc, "_get_binding", return_value=binding),
            patch.object(svc, "_get_account", return_value=None),
            patch.object(svc, "_resolve_binding", return_value=binding),
            patch.object(svc, "_sync_routing_context"),
            patch.object(svc, "_send_typing_indicator"),
            patch.object(svc, "_emit_extension_event"),
            patch(
                "apps.channel_gateway.services.inbound_service.ChannelPolicyService.evaluate",
                return_value=allowed,
            ),
            patch("apps.channel_gateway.tasks.dispatch_agent_reply.delay") as mock_delay,
        ):
            svc.handle_inbound(data)

        mock_delay.assert_called_once()
        self.assertEqual(mock_delay.call_args.kwargs["binding_id"], "b_cd021")


# =====================================================================
# CD-022: handle_inbound 缺少 organization_id 时记录诊断日志
# =====================================================================

class CD022OrganizationIdValidationTest(SimpleTestCase):
    """CD-022: organization_id 为空时应记录 error 日志并抛出 ValueError。"""

    def test_missing_organization_id_raises_with_log(self):
        from apps.channel_gateway.services.inbound_service import ChannelInboundService

        svc = ChannelInboundService()
        data = SimpleNamespace(
            organization_id=None,
            channel="telegram",
            peer_id="peer_x",
            sender_id="sender_x",
            message_id="msg_x",
            account_id="acct_x",
        )

        with patch("apps.channel_gateway.services.inbound_service.logger") as mock_logger:
            with self.assertRaises(ValueError):
                svc.handle_inbound(data)

            mock_logger.error.assert_called_once()
            log_msg = mock_logger.error.call_args[0][0]
            self.assertIn("missing organization_id", log_msg)

    def test_missing_organization_id_log_contains_diagnostic_fields(self):
        from apps.channel_gateway.services.inbound_service import ChannelInboundService

        svc = ChannelInboundService()
        data = SimpleNamespace(
            organization_id="",
            channel="slack",
            peer_id="peer_diag",
            sender_id="sender_diag",
            message_id="msg_diag",
            account_id="acct_diag",
        )

        with patch("apps.channel_gateway.services.inbound_service.logger") as mock_logger:
            with self.assertRaises(ValueError):
                svc.handle_inbound(data)

            call_args = mock_logger.error.call_args[0]
            formatted = call_args[0] % call_args[1:]
            self.assertIn("slack", formatted)
            self.assertIn("peer_diag", formatted)
            self.assertIn("sender_diag", formatted)
            self.assertIn("msg_diag", formatted)


# =====================================================================
# CD-023: debounce 合并消息保留 sender_id 上下文
# =====================================================================

class CD023DebounceSenderPreservationTest(SimpleTestCase):
    """CD-023: _flush_debounce_buffer 合并时保留各消息的 sender_id。"""

    def _make_data(self, *, peer_kind="group", sender_id="user_A"):
        return SimpleNamespace(
            organization_id="ws_1",
            message_id="msg_base",
            text="first message",
            channel="telegram",
            account_id="default",
            peer_id="group_1",
            peer_kind=peer_kind,
            schema_version=1,
            sender_id=sender_id,
            space_id=None,
            metadata={"sender_username": "Alice"},
            media=None,
            model_copy=lambda update: SimpleNamespace(**{
                "organization_id": "ws_1",
                "message_id": update.get("message_id", "msg_base"),
                "text": update.get("text", "first message"),
                "channel": "telegram",
                "account_id": "default",
                "peer_id": "group_1",
                "peer_kind": peer_kind,
                "schema_version": 1,
                "sender_id": sender_id,
                "space_id": None,
                "metadata": {"sender_username": "Alice"},
                "media": update.get("media"),
            }),
        )

    def test_group_chat_preserves_sender_in_merged_text(self):
        """群聊中来自不同用户的缓冲消息应保留各自 sender 前缀。"""
        from apps.channel_gateway.tasks import _flush_debounce_buffer

        buf_entries = [
            json.dumps({"text": "hello from Bob", "sender_id": "user_B", "sender_name": "Bob"}).encode(),
            json.dumps({"text": "hello from Carol", "sender_id": "user_C", "sender_name": "Carol"}).encode(),
        ]

        redis_mock = MagicMock()
        redis_mock.lpop = MagicMock(side_effect=buf_entries + [None])

        data = self._make_data(peer_kind="group", sender_id="user_A")
        captured = {}

        with patch("apps.channel_gateway.services.inbound_service.ChannelInboundService.handle_inbound") as mock_hi:
            def capture(combined):
                captured["text"] = combined.text
                captured["message_id"] = combined.message_id
            mock_hi.side_effect = capture
            _flush_debounce_buffer(redis_mock, "test:buf", data)

        self.assertIn("[Bob]: hello from Bob", captured["text"])
        self.assertIn("[Carol]: hello from Carol", captured["text"])
        self.assertIn("_merged", captured["message_id"])

    def test_dm_does_not_add_sender_prefix(self):
        """DM 场景不应添加 sender 前缀（只有一个发送者）。"""
        from apps.channel_gateway.tasks import _flush_debounce_buffer

        buf_entries = [
            json.dumps({"text": "follow up", "sender_id": "user_A", "sender_name": "Alice"}).encode(),
        ]

        redis_mock = MagicMock()
        redis_mock.lpop = MagicMock(side_effect=buf_entries + [None])

        data = self._make_data(peer_kind="dm", sender_id="user_A")
        captured = {}

        with patch("apps.channel_gateway.services.inbound_service.ChannelInboundService.handle_inbound") as mock_hi:
            def capture(combined):
                captured["text"] = combined.text
            mock_hi.side_effect = capture
            _flush_debounce_buffer(redis_mock, "test:buf", data)

        self.assertEqual(captured["text"], "follow up")
        self.assertNotIn("[Alice]", captured["text"])

    def test_legacy_plain_text_buffer_fallback(self):
        """向后兼容：非 JSON 格式的旧缓冲条目也能正常处理。"""
        from apps.channel_gateway.tasks import _flush_debounce_buffer

        buf_entries = [b"plain text message"]

        redis_mock = MagicMock()
        redis_mock.lpop = MagicMock(side_effect=buf_entries + [None])

        data = self._make_data(peer_kind="dm")
        captured = {}

        with patch("apps.channel_gateway.services.inbound_service.ChannelInboundService.handle_inbound") as mock_hi:
            def capture(combined):
                captured["text"] = combined.text
            mock_hi.side_effect = capture
            _flush_debounce_buffer(redis_mock, "test:buf", data)

        self.assertEqual(captured["text"], "plain text message")

    def test_empty_buffer_no_dispatch(self):
        """空缓冲不触发 handle_inbound。"""
        from apps.channel_gateway.tasks import _flush_debounce_buffer

        redis_mock = MagicMock()
        redis_mock.lpop = MagicMock(return_value=None)

        data = self._make_data()

        with patch("apps.channel_gateway.services.inbound_service.ChannelInboundService.handle_inbound") as mock_hi:
            _flush_debounce_buffer(redis_mock, "test:buf", data)

        mock_hi.assert_not_called()

    def test_process_inbound_stores_sender_info_in_buffer(self):
        """process_inbound_message 将 sender 信息存入 Redis buffer。"""
        from apps.channel_gateway.tasks import process_inbound_message

        data_dict = {
            "schema_version": 1, "type": "channel.inbound",
            "channel": "telegram", "account_id": "default",
            "organization_id": "ws_1", "peer_kind": "group",
            "peer_id": "group_1", "sender_id": "user_B",
            "message_id": "msg_2", "text": "second msg", "timestamp": 100,
            "metadata": {"sender_username": "Bob"},
        }

        redis_mock = MagicMock()
        redis_mock.set = MagicMock(return_value=False)

        with (
            patch("django_redis.get_redis_connection", return_value=redis_mock),
        ):
            process_inbound_message(data_dict)

        redis_mock.rpush.assert_called_once()
        pushed_val = redis_mock.rpush.call_args[0][1]
        parsed = json.loads(pushed_val)
        self.assertEqual(parsed["sender_id"], "user_B")
        self.assertEqual(parsed["sender_name"], "Bob")
        self.assertEqual(parsed["text"], "second msg")

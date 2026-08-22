"""CD-008 / CD-009 回归测试 — Channel 发送者身份传递与权限隔离。

CD-008: dispatch_agent_reply 通过 app_context 传递 channel_sender_id，
        Agent 可以感知外部消息的真实发送者。
CD-009: Channel 路径使用 client_type="channel"，ChatService 注入
        cautious 授权预设，防止外部用户间接触发写操作。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _make_session_mock(session_id="sess-1"):
    session = MagicMock()
    session.id = session_id
    session.user = MagicMock()
    session.user.id = "user_1"
    session.user_id = "user_1"
    return session


def _make_binding(session_id="sess-1", execution_agent_id=None, identity_user_id="user_1"):
    return SimpleNamespace(
        session_id=session_id,
        execution_agent_id=execution_agent_id,
        identity_user_id=identity_user_id,
        handling_space_id="space_1",
        organization_id="ws_1",
    )


def _make_data(sender_id="ext_user", channel="telegram", peer_kind="dm", metadata=None):
    return SimpleNamespace(
        sender_id=sender_id,
        channel=channel,
        peer_kind=peer_kind,
        metadata=metadata if metadata is not None else {},
    )


class CD008SenderIdPassthroughTest(SimpleTestCase):
    """CD-008: _call_llm 必须将 sender_id 通过 app_context 传递给 ChatService。"""

    @patch("apps.services.agent_engine.api.chat_service.ChatService.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_passes_sender_id_in_app_context(self, mock_qs, mock_send):
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session_mock()
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_send.return_value = {"reply": "ok"}

        _call_llm(
            _make_binding(),
            _make_data(sender_id="ext_user_42", metadata={"sender_username": "alice"}),
            "hello",
        )

        mock_send.assert_called_once()
        kw = mock_send.call_args.kwargs
        app_context = kw["app_context"]
        self.assertEqual(app_context["channel_sender_id"], "ext_user_42")
        self.assertEqual(app_context["channel_sender_name"], "alice")
        self.assertEqual(app_context["channel_name"], "telegram")
        self.assertEqual(app_context["channel_peer_kind"], "dm")

    @patch("apps.services.agent_engine.api.chat_service.ChatService.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_passes_explicit_execution_agent_id(self, mock_qs, mock_send):
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session_mock("sess-agent")
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_send.return_value = {"reply": "ok"}

        _call_llm(
            _make_binding(session_id="sess-agent", execution_agent_id="agent-77"),
            _make_data(sender_id="ext_user_77"),
            "hello",
        )

        app_context = mock_send.call_args.kwargs["app_context"]
        self.assertEqual(app_context["_execution_agent_id"], "agent-77")

    @patch("apps.services.agent_engine.api.chat_service.ChatService.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_falls_back_to_sender_id_when_no_username(self, mock_qs, mock_send):
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session_mock("sess-2")
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_send.return_value = {"reply": "ok"}

        _call_llm(
            _make_binding("sess-2"),
            _make_data(sender_id="raw_id_99", channel="slack", peer_kind="group", metadata={}),
            "hey",
        )

        kw = mock_send.call_args.kwargs
        self.assertEqual(kw["app_context"]["channel_sender_name"], "raw_id_99")

    @patch("apps.services.agent_engine.api.chat_service.ChatService.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_handles_none_metadata(self, mock_qs, mock_send):
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session_mock("sess-3")
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_send.return_value = {"reply": "ok"}

        _call_llm(
            _make_binding("sess-3"),
            _make_data(sender_id="user_x", channel="discord", metadata=None),
            "test",
        )

        kw = mock_send.call_args.kwargs
        self.assertEqual(kw["app_context"]["channel_sender_name"], "user_x")

    @patch("apps.services.agent_engine.api.chat_service.ChatService.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_sender_name_prefers_username_over_name(self, mock_qs, mock_send):
        """sender_username 优先于 sender_name。"""
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session_mock()
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_send.return_value = {"reply": "ok"}

        _call_llm(
            _make_binding(),
            _make_data(metadata={"sender_username": "alice", "sender_name": "Alice W."}),
            "hi",
        )

        kw = mock_send.call_args.kwargs
        self.assertEqual(kw["app_context"]["channel_sender_name"], "alice")


class CD009ChannelClientTypeTest(SimpleTestCase):
    """CD-009: Channel 路径使用 client_type='channel' 而非 'web'。"""

    @patch("apps.services.agent_engine.api.chat_service.ChatService.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_uses_channel_client_type(self, mock_qs, mock_send):
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session_mock()
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_send.return_value = {"reply": "ok"}

        _call_llm(_make_binding(), _make_data(), "hello")

        kw = mock_send.call_args.kwargs
        self.assertEqual(kw["client_type"], "channel",
                         "Channel traffic must use client_type='channel', not 'web'")

    @patch("apps.services.agent_engine.api.chat_service.ChatService.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_never_uses_web_client_type(self, mock_qs, mock_send):
        """确保 _call_llm 不再使用 client_type='web'。"""
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session_mock()
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_send.return_value = {"reply": "ok"}

        _call_llm(
            _make_binding(),
            _make_data(channel="wechat_work"),
            "msg",
        )

        kw = mock_send.call_args.kwargs
        self.assertNotEqual(kw["client_type"], "web")


class CD009ChannelClientTypeUsesYoloTest(SimpleTestCase):
    """CD-009: Hilt 重写后 channel 路径走 yolo_mode / judge v3，旧 PRESET_RULES 已删除。

    验证 authorization_policy 不再导出 PRESET_RULES（Hilt 清零）。
    """

    def test_preset_rules_no_longer_exported(self):
        """PRESET_RULES 已在 Hilt W4 删除，import 应失败。"""
        import apps.services.common.authorization_policy as mod
        self.assertFalse(
            hasattr(mod, 'PRESET_RULES'),
            "PRESET_RULES should have been removed in Hilt W4",
        )



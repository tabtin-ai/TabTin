"""W13 修复（L1+L2）：``_call_llm`` 必须把 dispatcher 的 error_category 转成
对外用户友好话术，绝不能把 "当前设备 X 不在线，请打开客户端后重试" 等
内部运维语暴露给飞书/微信外部用户。

历史 bug 详
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _make_session(session_id="sess-1"):
    s = MagicMock()
    s.id = session_id
    s.user = MagicMock()
    s.user.id = "user-1"
    s.user_id = "user-1"
    return s


def _make_binding(session_id="sess-1"):
    return SimpleNamespace(
        session_id=session_id,
        execution_agent_id=None,
        identity_user_id="user-1",
        handling_space_id="space-1",
        organization_id="wt-1",
    )


def _make_data(channel="feishu", peer_kind="dm"):
    return SimpleNamespace(
        sender_id="ext_user_1",
        channel=channel,
        peer_kind=peer_kind,
        peer_id="peer-1",
        organization_id="wt-1",
        metadata={"sender_username": "外部用户"},
    )


class CallLLMUserFriendlyErrorTests(SimpleTestCase):
    """对外用户友好话术回归。"""

    @patch("apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_returns_friendly_text_on_device_offline(
        self, mock_qs, mock_dispatch,
    ):
        """device_offline 时必须返回不带技术词汇的友好话术。"""
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session()
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_dispatch.return_value = {
            "reply": "当前设备 \"prod-daemon\" 不在线，请打开客户端后重试。",
            "content": "",
            "error_category": "device_offline",
            "error_message": "control_device prod-daemon status=offline",
        }

        reply = _call_llm(_make_binding(), _make_data(), "你好")

        # 不能把内部运维话术暴露给外部用户
        self.assertNotIn("设备", reply)
        self.assertNotIn("客户端", reply)
        self.assertNotIn("daemon", reply.lower())
        # 必须给一个明确的"暂时不可用"信号
        self.assertIn("暂时", reply)

    @patch("apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_returns_friendly_text_on_timeout(
        self, mock_qs, mock_dispatch,
    ):
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session()
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_dispatch.return_value = {
            "reply": "本地 Agent Runtime 在 600s 内未返回结果，请稍后重试。",
            "error_category": "remote_agent_timeout",
            "error_message": "timed out after 600s",
        }

        reply = _call_llm(_make_binding(), _make_data(), "hi")

        self.assertNotIn("Runtime", reply)
        self.assertNotIn("重试", reply)
        # 用户能感知"耗时太久了"即可
        self.assertIn("超时", reply)

    @patch("apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync")
    @patch("apps.chat.conversation.models.ChatSession.objects")
    def test_call_llm_passes_through_normal_reply(
        self, mock_qs, mock_dispatch,
    ):
        """成功路径不变——保留原 reply 透传给外部渠道。"""
        from apps.channel_gateway.tasks import _call_llm

        session = _make_session()
        mock_qs.select_related.return_value.filter.return_value.first.return_value = session
        mock_dispatch.return_value = {
            "reply": "你好，我已为你查询到周报草稿。",
            "error_category": None,
        }

        reply = _call_llm(_make_binding(), _make_data(), "请生成周报")

        self.assertEqual(reply, "你好，我已为你查询到周报草稿。")

    def test_friendly_reply_helper_covers_all_error_categories(self):
        """_user_friendly_dispatcher_error_reply：所有已知 error_category 必须被映射。"""
        from apps.channel_gateway.tasks import _user_friendly_dispatcher_error_reply

        for category in (
            "device_offline",
            "device_unreachable",
            "device_dropped",
            "remote_agent_timeout",
            "runtime_failed",
            "unknown_category_for_future_proof",
        ):
            reply = _user_friendly_dispatcher_error_reply(error_category=category)
            self.assertTrue(reply, f"category={category} 必须返回非空话术")
            # 杜绝技术黑话
            for forbidden in ("客户端", "daemon", "device", "Daemon", "Runtime"):
                self.assertNotIn(
                    forbidden, reply,
                    f"category={category} 的话术不该出现技术词 {forbidden!r}",
                )

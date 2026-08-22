"""#5483：relay DONE → Agent 任务铃铛通知的 error_class 过滤。

撞单次运行用量上限（credits / token 墙，runtime 统一
``error_class=MAX_CREDITS_EXCEEDED``）属受控优雅终止——聊天内已有
「已达运行上限，已中止」卡片 + 引导，铃铛不应再落「Agent 任务出错」。
其余 DONE（正常完成 / 真错误 / ABORT）落通知行为保持不变。
"""

from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.common.ws.handlers.relay_handler import (
    _notify_agent_task_from_done,
)

SESSION_ID = "6f6c1c9e-6f83-4b5b-9a3e-1d2c3b4a5f60"

_NOTIFY_PATH = (
    "apps.services.notification.services.agent_task_notification."
    "notify_agent_task_terminal"
)


class RelayAgentTaskNotifyErrorClassFilterTests(SimpleTestCase):
    def _run(self, done_payload: dict) -> "patch":
        with patch(_NOTIFY_PATH) as mock_notify:
            _notify_agent_task_from_done(
                session_id=SESSION_ID,
                done_payloads=[done_payload],
                message_ids=[],
                fallback_user_id="user-1",
            )
        return mock_notify

    def test_budget_wall_done_skips_bell_notification(self):
        mock_notify = self._run({
            "error": True,
            "error_class": "MAX_CREDITS_EXCEEDED",
            "error_message": "Terminated by budget guard: credits_projected",
            "trace_id": "trace-1",
        })
        mock_notify.assert_not_called()

    def test_real_error_done_still_notifies(self):
        mock_notify = self._run({
            "error": True,
            "error_class": "LLM_ERROR",
            "error_message": "upstream 502",
            "trace_id": "trace-2",
        })
        mock_notify.assert_called_once()
        kwargs = mock_notify.call_args.kwargs
        self.assertEqual(kwargs["phase"], "error")
        # ：title 用错误摘要，不再写与 typeLabel 重复的「Agent 任务出错」
        self.assertEqual(kwargs["title"], "upstream 502")
        self.assertEqual(kwargs["body"], "")

    def test_success_done_still_notifies_completed(self):
        mock_notify = self._run({
            "error": False,
            "content": "任务完成",
            "trace_id": "trace-3",
        })
        mock_notify.assert_called_once()
        kwargs = mock_notify.call_args.kwargs
        self.assertEqual(kwargs["phase"], "end")
        # ：title 用一句话摘要，body 留空给会话标题回退
        self.assertEqual(kwargs["title"], "任务完成")
        self.assertEqual(kwargs["body"], "")

    def test_success_done_compacts_long_content_to_first_sentence(self):
        mock_notify = self._run({
            "error": False,
            "content": (
                "我可以帮你从网上下载视频。不过需要你先提供一下："
                "**视频的网页地址 (URL)** 以及保存位置。"
            ),
            "trace_id": "trace-5",
        })
        mock_notify.assert_called_once()
        kwargs = mock_notify.call_args.kwargs
        self.assertEqual(kwargs["title"], "我可以帮你从网上下载视频。")
        self.assertEqual(kwargs["body"], "")
        self.assertNotIn("不过需要你先提供", kwargs["title"])

    def test_abort_done_notifies_as_interrupted(self):
        mock_notify = self._run({
            "error": True,
            "error_class": "ABORT",
            "error_message": "Run aborted by user.",
            "trace_id": "trace-4",
        })
        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.kwargs["phase"], "interrupted")

    def test_user_cancelled_done_skips_bell_notification(self):
        for stop_reason in (
            "cancelled",
            "canceled",
            "user_cancelled",
            "user_canceled",
        ):
            with self.subTest(stop_reason=stop_reason):
                mock_notify = self._run({
                    "error": False,
                    "stop_reason": stop_reason,
                    "content": "已取消",
                    "trace_id": f"trace-{stop_reason}",
                })
                mock_notify.assert_not_called()

    def test_mixed_payloads_only_budget_wall_filtered(self):
        with patch(_NOTIFY_PATH) as mock_notify:
            _notify_agent_task_from_done(
                session_id=SESSION_ID,
                done_payloads=[
                    {
                        "error": True,
                        "error_class": "MAX_CREDITS_EXCEEDED",
                        "error_message": "Terminated by budget guard: credits",
                    },
                    {"error": False, "content": "ok"},
                ],
                message_ids=[],
                fallback_user_id="user-1",
            )
        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.kwargs["phase"], "end")

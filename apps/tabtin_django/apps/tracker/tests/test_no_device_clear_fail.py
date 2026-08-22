"""TS-18（v1 决策 C）回归测试：执行 Agent 未绑可用设备时，无人值守任务当场清晰失败。

问题背景：
- Tracker 自动触发时，若执行 Agent 未绑定可用设备，``RemoteAgentDispatcher``
  会走 lightweight 分支 → ``dispatch_external`` fire-and-forget，恒返回空 ``reply``
  → run 静默失败、错误文案含糊（「Agent 未返回有效结果」），用户不知道根因是
  "没绑设备"。绑了设备的路径已由  修好。
- v1 决策 = C：在 dispatch **之前**判断有无可用设备，没有就直接把 run 标 failed、
  说人话引导去绑设备，**不再进 lightweight fire-and-forget**。

本文件分两层钉死：
1. ``NoDeviceGateTest``：无设备 → 标 failed + 不调 ``send_message_sync``；
   有设备 → 正常调 ``send_message_sync``、不被误拦。
   「有无设备」用 dispatcher 同款 ``resolve_dispatch_target`` 判，保证不分叉。
2. ``NoDeviceHumanizeTest``：失败文案经 ``humanize_failure_message`` 翻译后，
   说人话且可操作（引导去 Agent 设置绑定设备）。

全部用 mock 隔离 DB，属自包含单测（不连 live stack / dev DB）。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _make_tracker_run(*, agent_id, agent_name="调研 Agent"):
    """构造最小可驱动 ``_run_skill_agent`` 的 fake TrackerRun（DB 写入全 patch）。"""
    tracker = MagicMock(name="tracker")
    tracker.id = uuid.uuid4()
    tracker.name = "每日调研"
    tracker.description = "调研竞品架构"
    tracker.organization_id = uuid.uuid4()
    tracker.space_id = uuid.uuid4()
    tracker.skill_key = "research_skill"
    tracker.skill_params = None
    tracker.created_by = MagicMock(name="creator")  # truthy 否则提前 fail
    tracker.agent_id = agent_id
    tracker.agent.name = agent_name
    tracker.agent.preferred_model_id = uuid.uuid4()

    run = MagicMock(name="tracker_run")
    run.id = uuid.uuid4()
    run.tracker = tracker
    run.context = {}
    run.started_at = None
    return run, tracker


class NoDeviceGateTest(SimpleTestCase):
    """dispatch 前的「无设备闸门」：无设备拦下、有设备放行。"""

    def _drive(self, *, control_device, ws_connected: bool = True):
        """驱动 ``_run_skill_agent``，注入指定的 resolve_dispatch_target 结果。

        离线韧性 M1 后设备闸门前置到 ChatSession 创建之前，且新增「DB 在线 +
        WS 可达」判定：control_device 非 None 时按 ``status``/``fingerprint``
        字段 + ``is_device_ws_connected``（此处 patch 为 ``ws_connected``）分流。

        返回 (dispatcher, fail_run_mock, suspend_mock)。
        """
        from apps.tracker.services import tracker_executor  # noqa: F401 预热循环 import
        from apps.tracker.services import skill_executor

        run, tracker = _make_tracker_run(agent_id=uuid.uuid4())
        # M1 闸门读 tracker.workspace.device（不再经 resolve_dispatch_target）。
        workspace = MagicMock(name="workspace")
        workspace.device = control_device
        workspace.organization_id = tracker.organization_id
        tracker.workspace = workspace
        tracker.workspace_id = uuid.uuid4()
        skill_data = {"name": "research_skill", "doc_content": "方法论正文"}
        notifier = MagicMock(name="notifier")

        fake_session = MagicMock(name="chat_session")
        fake_session.id = uuid.uuid4()
        chat_session_cls = MagicMock(name="ChatSession")
        chat_session_cls.objects.create.return_value = fake_session

        dispatcher = MagicMock(name="RemoteAgentDispatcher")
        dispatcher.send_message_sync.return_value = {"reply": "已完成调研并产出结论。" * 3}

        target = MagicMock(name="dispatch_target")
        target.control_device = control_device

        with patch("apps.services.remote_agent.RemoteAgentDispatcher", dispatcher), \
             patch(
                 "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
                 return_value=target,
             ), \
             patch(
                 "apps.services.common.ws.bus.is_device_ws_connected",
                 return_value=ws_connected,
             ), \
             patch.object(skill_executor, "_is_device_dispatchable",
                          side_effect=lambda d: bool(d) and getattr(d, "status", None) == "online" and ws_connected), \
             patch("apps.chat.conversation.models.ChatSession", chat_session_cls), \
             patch("apps.chat.conversation.models.ChatContext", MagicMock()), \
             patch.object(skill_executor, "_fail_tracker_run") as fail_run, \
             patch.object(skill_executor, "suspend_tracker_run_waiting_device") as suspend_run, \
             patch.object(skill_executor, "TrackerRun") as tracker_run_cls, \
             patch.object(skill_executor, "_update_tracker_stats"), \
             patch.object(skill_executor, "_release_tracker_run_runtime_claim"), \
             patch(
                 "apps.services.agent_execution.model_resolver.resolve_execution_model_id",
                 return_value=str(uuid.uuid4()),
             ), \
             patch("django.db.transaction.atomic") as atomic, \
             patch("apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed"):
            atomic.return_value.__enter__ = MagicMock(return_value=None)
            atomic.return_value.__exit__ = MagicMock(return_value=False)
            filter_qs = MagicMock(name="run_filter_qs")
            filter_qs.count.return_value = 1
            filter_qs.update.return_value = None
            filter_qs.filter.return_value = filter_qs
            filter_qs.first.return_value = fake_session
            tracker_run_cls.objects.filter.return_value = filter_qs
            skill_executor._run_skill_agent(run, skill_data, notifier)

        return dispatcher, fail_run, suspend_run

    @staticmethod
    def _online_device():
        device = MagicMock(name="online_device")
        device.status = "online"
        device.fingerprint = "fp-test-online"
        return device

    def test_no_device_fails_run_and_skips_dispatch(self):
        """无可用设备（control_device=None）→ 标 failed + 绝不进 dispatch。"""
        dispatcher, fail_run, suspend_run = self._drive(control_device=None)

        dispatcher.send_message_sync.assert_not_called()
        suspend_run.assert_not_called()
        fail_run.assert_called_once()

        raw_error = fail_run.call_args.args[1]
        self.assertIn(
            "未绑定可用设备", raw_error,
            "失败文案须含 humanize needle『未绑定可用设备』，否则翻译不到说人话文案",
        )
        self.assertIn(
            "调研 Agent", raw_error,
            "失败原始文案应带执行 Agent 名，便于定位是哪个 Agent 没绑设备",
        )

    def test_with_device_dispatches_normally(self):
        """有在线可达设备 → 走原 send_message_sync 路径，不被误拦、不标 failed。"""
        dispatcher, fail_run, suspend_run = self._drive(
            control_device=self._online_device(),
        )

        dispatcher.send_message_sync.assert_called_once()
        fail_run.assert_not_called()
        suspend_run.assert_not_called()

    def test_offline_device_suspends_waiting_device(self):
        """有绑定但 DB 离线 → 挂起 waiting_device，不 dispatch、不标 failed。"""
        device = MagicMock(name="offline_device")
        device.status = "offline"
        device.fingerprint = "fp-test-offline"
        dispatcher, fail_run, suspend_run = self._drive(control_device=device)

        dispatcher.send_message_sync.assert_not_called()
        fail_run.assert_not_called()
        suspend_run.assert_called_once()

    def test_ws_unreachable_device_suspends_waiting_device(self):
        """DB 在线但 WS 不可达（假在线）→ 同样挂起 waiting_device。"""
        dispatcher, fail_run, suspend_run = self._drive(
            control_device=self._online_device(), ws_connected=False,
        )

        dispatcher.send_message_sync.assert_not_called()
        fail_run.assert_not_called()
        suspend_run.assert_called_once()


class NoDeviceHumanizeTest(SimpleTestCase):
    """无设备失败文案经 humanize 后说人话 + 可操作。"""

    def test_no_device_raw_error_is_humanized_and_actionable(self):
        from apps.tracker.utils import (
            humanize_failure_message,
            translate_skill_error,
            assert_failure_message_is_human_readable,
        )

        raw = "执行 Agent『调研 Agent』未绑定可用设备，无法运行无人值守任务"
        msg = humanize_failure_message(raw, skill_key="research_skill")

        self.assertTrue(assert_failure_message_is_human_readable(msg))
        self.assertIn("绑定", msg)
        self.assertIn("设备", msg)
        # 命中专属 needle，而非通用 fallback。
        self.assertNotIn("具体原因暂时还没看清楚", msg)

        payload = translate_skill_error(raw, skill_key="research_skill")
        kinds = {a["kind"] for a in payload["recovery_action_items"]}
        self.assertIn(
            "switch_agent", kinds,
            "应提供『换一个已绑定设备的 Agent』等可操作恢复动作",
        )

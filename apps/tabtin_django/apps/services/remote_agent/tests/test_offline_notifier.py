"""离线桌面通知（W13 D3）单元测试。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.remote_agent.offline_notifier import notify_owner_device_offline


def _make_agent(*, user_id="user-1", name="Tin", organization_id="wt-1", agent_id="agent-1"):
    agent = MagicMock()
    agent.id = agent_id
    agent.user_id = user_id
    agent.name = name
    agent.organization_id = organization_id
    return agent


def _make_device(*, device_id="dev-1"):
    device = MagicMock()
    device.id = device_id
    return device


class NotifyOwnerDeviceOfflineTests(SimpleTestCase):
    @patch("apps.services.notification.services.notification_service.NotificationService")
    def test_notifies_owner_with_correct_payload(self, mock_ns):
        agent = _make_agent(user_id="u-42", organization_id="wt-9", name="Builder Tin")
        device = _make_device(device_id="d-77")

        notify_owner_device_offline(
            agent=agent,
            device=device,
            device_name="Mac mini 工作机",
            context_label="后端定时任务",
        )

        mock_ns.notify.assert_called_once()
        kwargs = mock_ns.notify.call_args.kwargs
        self.assertEqual(kwargs["user_id"], "u-42")
        self.assertEqual(kwargs["organization_id"], "wt-9")
        self.assertEqual(kwargs["type"], "device_offline")
        self.assertIn("Mac mini 工作机", kwargs["title"])
        self.assertIn("Builder Tin", kwargs["body"])
        self.assertIn("后端定时任务", kwargs["body"])
        self.assertEqual(kwargs["metadata"]["category"], "device_offline")
        self.assertEqual(kwargs["metadata"]["priority"], "high")
        self.assertEqual(kwargs["metadata"]["agent_id"], "agent-1")
        self.assertEqual(kwargs["metadata"]["device_id"], "d-77")

    @patch("apps.services.notification.services.notification_service.NotificationService")
    def test_includes_tracker_name_when_app_context_provided(self, mock_ns):
        """W13 D3 决策：通知文案应包含 Tracker 名以便 owner 立刻定位失败任务。

        波次 4 Stage 2.4 一刀切：app_context 字段从 ``goal_*`` 改名为 ``tracker_*``，
        metadata 输出字段同步改名。
        """
        notify_owner_device_offline(
            agent=_make_agent(),
            device=_make_device(),
            device_name="生产 daemon",
            context_label="后端定时任务",
            app_context={
                "tracker_name": "周报汇总",
                "tracker_id": "t-1",
                "tracker_run_id": "tr-1",
            },
        )

        kwargs = mock_ns.notify.call_args.kwargs
        self.assertIn("周报汇总", kwargs["title"])
        self.assertIn("生产 daemon", kwargs["title"])
        self.assertIn("周报汇总", kwargs["body"])
        self.assertEqual(kwargs["metadata"]["tracker_label"], "Tracker \"周报汇总\"")
        self.assertEqual(kwargs["metadata"]["tracker_id"], "t-1")
        self.assertEqual(kwargs["metadata"]["tracker_run_id"], "tr-1")
        # 单 Skill 执行模型下：以下字段不再存在于通知 metadata 中。
        self.assertNotIn("step_run_id", kwargs["metadata"])

    @patch("apps.services.notification.services.notification_service.NotificationService")
    def test_skips_when_agent_has_no_owner(self, mock_ns):
        agent = _make_agent()
        agent.user_id = ""

        notify_owner_device_offline(
            agent=agent,
            device=_make_device(),
            device_name="X",
            context_label="后端定时任务",
        )

        mock_ns.notify.assert_not_called()

    @patch("apps.services.notification.services.notification_service.NotificationService")
    def test_skips_silently_when_agent_is_none(self, mock_ns):
        notify_owner_device_offline(
            agent=None,
            device=_make_device(),
            device_name="X",
            context_label="后端定时任务",
        )

        mock_ns.notify.assert_not_called()

    @patch("apps.services.notification.services.notification_service.NotificationService")
    def test_swallows_notification_service_exceptions(self, mock_ns):
        mock_ns.notify.side_effect = RuntimeError("boom")

        # Must NOT raise — 通知失败绝不影响主流程
        notify_owner_device_offline(
            agent=_make_agent(),
            device=_make_device(),
            device_name="X",
            context_label="后端定时任务",
        )

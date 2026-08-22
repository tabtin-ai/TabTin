"""Agent 任务通知落库 helper 测试。"""

from __future__ import annotations

import builtins
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase

from apps.services.notification.models import Notification
from apps.services.notification.services.agent_task_notification import (
    build_chat_session_navigate_to,
    compact_agent_notification_summary,
    notify_agent_hitl_waiting,
    notify_agent_task_terminal,
    notify_tracker_run_terminal,
)

SESSION_ID = str(uuid.uuid4())
MESSAGE_ID = str(uuid.uuid4())
HITL_SESSION_ID = str(uuid.uuid4())
HITL_MESSAGE_ID = str(uuid.uuid4())
TRACKER_ID = str(uuid.uuid4())
RUN_ID = str(uuid.uuid4())
TRACKER_SESSION_ID = str(uuid.uuid4())
INTERACTION_ID = str(uuid.uuid4())


class AgentTaskNotificationUnitTests(SimpleTestCase):
    def test_build_chat_session_navigate_to_includes_message_id(self):
        target = build_chat_session_navigate_to(
            session_id=SESSION_ID,
            workspace_id="workspace-1",
            project_id="project-1",
            organization_id="org-1",
            message_id=MESSAGE_ID,
        )
        self.assertEqual(
            target,
            {
                "type": "chat-session",
                "id": SESSION_ID,
                "workspaceId": "workspace-1",
                "projectId": "project-1",
                "organizationId": "org-1",
                "messageId": MESSAGE_ID,
            },
        )

    def test_compact_agent_notification_summary_takes_first_sentence(self):
        text = (
            "我可以帮你从网上下载视频。不过需要你先提供一下："
            "**视频的网页地址 (URL)** 以及保存位置。"
        )
        self.assertEqual(
            compact_agent_notification_summary(text),
            "我可以帮你从网上下载视频。",
        )

    def test_compact_agent_notification_summary_truncates_long_line(self):
        text = "a" * 120
        out = compact_agent_notification_summary(text, max_len=80)
        self.assertEqual(len(out), 80)
        self.assertTrue(out.endswith("…"))


class AgentTaskNotificationPersistTests(TestCase):
    databases = {"default", "postgresql"}

    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={"session_id": SESSION_ID, "user_id": "user-1"},
    )
    def test_user_cancelled_agent_task_does_not_persist_notification(self, mock_ctx):
        for phase in ("cancelled", "canceled", "user_cancelled", "user_canceled"):
            with self.subTest(phase=phase):
                notify_agent_task_terminal(
                    session_id=SESSION_ID,
                    phase=phase,
                    title="Agent 已取消",
                    source_event_id=f"agent.task:{SESSION_ID}:{phase}",
                )

        self.assertFalse(Notification.objects.filter(user_id="user-1").exists())
        self.assertEqual(mock_ctx.call_count, 4)

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=False,
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-1",
            "title": "对话标题",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_agent_task_terminal_persists_navigate_to(
        self, _mock_push, _mock_ctx, mock_viewing
    ):
        notify_agent_task_terminal(
            session_id=SESSION_ID,
            phase="end",
            title="Agent 任务完成",
            body="对话已完成处理",
            message_id=MESSAGE_ID,
            source_event_id=f"agent.task:{SESSION_ID}:done:end",
        )

        notif = Notification.objects.get(user_id="user-1", type="agent.task.completed")
        self.assertEqual(notif.space_id, "workspace-1")
        self.assertEqual(notif.metadata["navigate_to"]["workspaceId"], "workspace-1")
        self.assertEqual(notif.metadata["navigate_to"]["projectId"], "project-1")
        self.assertEqual(notif.organization_id, "org-1")
        self.assertEqual(notif.metadata["navigate_to"]["type"], "chat-session")
        self.assertEqual(notif.metadata["navigate_to"]["id"], SESSION_ID)
        self.assertEqual(notif.metadata["navigate_to"]["messageId"], MESSAGE_ID)
        self.assertEqual(notif.metadata["session_id"], SESSION_ID)
        mock_viewing.assert_called_once_with("user-1", SESSION_ID)

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=False,
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-1",
            "title": "下载视频助手",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_agent_task_terminal_empty_body_falls_back_to_session_title(
        self, _mock_push, _mock_ctx, _mock_viewing
    ):
        """#6309：title=摘要、body 空 → 次要行回退会话标题。"""
        notify_agent_task_terminal(
            session_id=SESSION_ID,
            phase="end",
            title="我可以帮你从网上下载视频。",
            body="",
            message_id=MESSAGE_ID,
            source_event_id=f"agent.task:{SESSION_ID}:done:summary",
        )

        notif = Notification.objects.get(user_id="user-1", type="agent.task.completed")
        self.assertEqual(notif.title, "我可以帮你从网上下载视频。")
        self.assertEqual(notif.body, "下载视频助手")

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=False,
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-1",
            "title": "[Tracker] 日报",
            "tracker_id": TRACKER_ID,
            "tracker_run_id": RUN_ID,
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_tracker_origin_agent_terminal_uses_tracker_target(
        self, _mock_push, _mock_ctx, _mock_viewing
    ):
        notify_agent_task_terminal(
            session_id=SESSION_ID,
            phase="end",
            title="任务已完成",
            source_event_id=f"agent.task:{SESSION_ID}:tracker:end",
        )

        notif = Notification.objects.get(user_id="user-1", type="agent.task.completed")
        self.assertEqual(notif.metadata["navigate_to"]["type"], "tracker")
        self.assertEqual(notif.metadata["navigate_to"]["id"], TRACKER_ID)
        self.assertEqual(notif.metadata["navigate_to"]["runId"], RUN_ID)
        self.assertEqual(notif.metadata["notification_target"], "tracker")

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=True,
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-1",
            "title": "对话标题",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_task_terminal_suppresses_when_recipient_is_viewing_session(
        self, _mock_push, _mock_ctx, mock_viewing
    ):
        notify_agent_task_terminal(
            session_id=SESSION_ID,
            phase="end",
            title="Agent 任务完成",
            body="对话已完成处理",
            message_id=MESSAGE_ID,
            source_event_id=f"agent.task:{SESSION_ID}:done:end",
        )

        self.assertFalse(
            Notification.objects.filter(
                user_id="user-1",
                type="agent.task.completed",
            ).exists()
        )
        mock_viewing.assert_called_once_with("user-1", SESSION_ID)

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=False,
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-1",
            "title": "对话标题",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_agent_task_terminal_dedupes_by_source_event_id(
        self, _mock_push, _mock_ctx, _mock_viewing
    ):
        kwargs = dict(
            session_id=SESSION_ID,
            phase="error",
            title="Agent 任务出错",
            body="boom",
            source_event_id=f"agent.task:{SESSION_ID}:done:error",
        )
        notify_agent_task_terminal(**kwargs)
        notify_agent_task_terminal(**kwargs)
        self.assertEqual(
            Notification.objects.filter(user_id="user-1", type="agent.task.error").count(),
            1,
        )

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=False,
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": str(uuid.uuid4()),
            "title": "对话标题",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_agent_task_terminal_compacts_long_source_event_id(
        self, _mock_push, mock_ctx, _mock_viewing
    ):
        trace_id = str(uuid.uuid4())

        notify_agent_task_terminal(
            session_id=SESSION_ID,
            phase="end",
            title="Agent 任务完成",
            trace_id=trace_id,
        )
        notify_agent_task_terminal(
            session_id=SESSION_ID,
            phase="end",
            title="Agent 任务完成",
            trace_id=trace_id,
        )

        user_id = mock_ctx.return_value["user_id"]
        notif = Notification.objects.get(user_id=user_id, type="agent.task.completed")
        self.assertLessEqual(len(notif.source_event_id), 100)
        self.assertIn(":sha256:", notif.source_event_id)
        self.assertEqual(notif.metadata["source_event_id"], notif.source_event_id)
        self.assertTrue(notif.metadata["original_source_event_id"].endswith(f":{user_id}"))
        self.assertEqual(
            Notification.objects.filter(user_id=user_id, type="agent.task.completed").count(),
            1,
        )

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=False,
    )
    @patch(
        "apps.services.agent_engine.services.pending_interaction_service.interaction_notify_user_ids",
        return_value=["user-owner", "user-exec"],
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": HITL_SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-owner",
            "title": "HITL",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_agent_hitl_waiting_fans_out(
        self, _mock_push, _mock_ctx, _mock_recipients, mock_viewing
    ):
        interaction = SimpleNamespace(
            id=INTERACTION_ID,
            session_id=HITL_SESSION_ID,
            organization_id="org-1",
            user_id="user-owner",
            request_key="batch-1",
            kind="tool_approval",
            payload={"message_id": HITL_MESSAGE_ID},
        )
        notify_agent_hitl_waiting(
            interaction=interaction,
            title="Agent 等待确认",
            body="需要审核",
        )
        items = list(Notification.objects.filter(type="agent.hitl.waiting").order_by("user_id"))
        self.assertEqual(len(items), 2)
        self.assertEqual({i.user_id for i in items}, {"user-owner", "user-exec"})
        self.assertEqual(items[0].metadata["navigate_to"]["messageId"], HITL_MESSAGE_ID)
        self.assertEqual(mock_viewing.call_count, 2)

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=True,
    )
    @patch(
        "apps.services.agent_engine.services.pending_interaction_service.interaction_notify_user_ids",
        return_value=["user-1"],
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": HITL_SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-1",
            "title": "HITL",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_hitl_waiting_suppresses_when_recipient_viewing(
        self, _mock_push, _mock_ctx, _mock_recipients, mock_viewing
    ):
        """个人 Space：收件人在场看该会话 → 不写收件箱通知。"""
        interaction = SimpleNamespace(
            id=str(uuid.uuid4()),
            session_id=HITL_SESSION_ID,
            organization_id="org-1",
            user_id="user-1",
            request_key="viewing-suppress",
            kind="tool_approval",
            payload={"message_id": HITL_MESSAGE_ID},
        )
        notify_agent_hitl_waiting(
            interaction=interaction,
            title="Agent 等待确认",
            body="需要审核",
        )
        self.assertEqual(
            Notification.objects.filter(type="agent.hitl.waiting", user_id="user-1").count(),
            0,
        )
        mock_viewing.assert_called_once_with("user-1", HITL_SESSION_ID)

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        return_value=False,
    )
    @patch(
        "apps.services.agent_engine.services.pending_interaction_service.interaction_notify_user_ids",
        return_value=["user-1"],
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": HITL_SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-1",
            "title": "HITL",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_hitl_waiting_notifies_when_no_presence(
        self, _mock_push, _mock_ctx, _mock_recipients, mock_viewing
    ):
        """无 presence → 照常写通知。"""
        interaction = SimpleNamespace(
            id=str(uuid.uuid4()),
            session_id=HITL_SESSION_ID,
            organization_id="org-1",
            user_id="user-1",
            request_key="no-presence",
            kind="ask_user",
            payload={"message_id": HITL_MESSAGE_ID},
        )
        notify_agent_hitl_waiting(
            interaction=interaction,
            title="Agent 等待确认",
            body="需要回答",
        )
        self.assertEqual(
            Notification.objects.filter(type="agent.hitl.waiting", user_id="user-1").count(),
            1,
        )
        mock_viewing.assert_called_once_with("user-1", HITL_SESSION_ID)

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
    )
    @patch(
        "apps.services.agent_engine.services.pending_interaction_service.interaction_notify_user_ids",
        return_value=["user-1"],
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_hitl_waiting_notifies_when_session_id_empty(
        self, _mock_push, _mock_recipients, mock_viewing
    ):
        """session_id 为空不可抑制 → 照常写通知，且不查 presence。"""
        mock_viewing.return_value = True
        interaction = SimpleNamespace(
            id=str(uuid.uuid4()),
            session_id="",
            organization_id="org-1",
            user_id="user-1",
            request_key="empty-session",
            kind="tool_approval",
            payload={},
        )
        notify_agent_hitl_waiting(
            interaction=interaction,
            title="Agent 等待确认",
            body="需要审核",
        )
        self.assertEqual(
            Notification.objects.filter(type="agent.hitl.waiting", user_id="user-1").count(),
            1,
        )
        mock_viewing.assert_not_called()

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
    )
    @patch(
        "apps.services.agent_engine.services.pending_interaction_service.interaction_notify_user_ids",
        return_value=["user-owner", "user-exec"],
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": HITL_SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-owner",
            "title": "HITL",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_hitl_waiting_team_space_suppresses_per_recipient(
        self, _mock_push, _mock_ctx, _mock_recipients, mock_viewing
    ):
        """Team Space：属主在场只抑制属主；execution owner 不在场仍收到。"""

        def _viewing(uid, sid):
            return uid == "user-owner"

        mock_viewing.side_effect = _viewing
        interaction = SimpleNamespace(
            id=str(uuid.uuid4()),
            session_id=HITL_SESSION_ID,
            organization_id="org-1",
            user_id="user-owner",
            request_key="team-per-recipient",
            kind="tool_approval",
            payload={"message_id": HITL_MESSAGE_ID},
        )
        notify_agent_hitl_waiting(
            interaction=interaction,
            title="Agent 等待确认",
            body="需要审核",
        )
        items = list(Notification.objects.filter(type="agent.hitl.waiting"))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].user_id, "user-exec")
        self.assertEqual(mock_viewing.call_count, 2)

    @patch(
        "apps.services.common.ws.session_viewing.is_user_viewing_session",
        side_effect=RuntimeError("redis down"),
    )
    @patch(
        "apps.services.agent_engine.services.pending_interaction_service.interaction_notify_user_ids",
        return_value=["user-a", "user-b"],
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": HITL_SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-a",
            "title": "HITL",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    @patch("apps.services.notification.services.agent_task_notification.logger")
    def test_hitl_waiting_presence_error_fail_open(
        self, mock_logger, _mock_push, _mock_ctx, _mock_recipients, mock_viewing
    ):
        """presence helper 抛错后只告警一次，并向全部收件人 fail-open。"""
        interaction = SimpleNamespace(
            id=str(uuid.uuid4()),
            session_id=HITL_SESSION_ID,
            organization_id="org-1",
            user_id="user-a",
            request_key="presence-error",
            kind="review",
            payload={"message_id": HITL_MESSAGE_ID},
        )
        notify_agent_hitl_waiting(
            interaction=interaction,
            title="Agent 等待确认",
            body="需要审核",
        )
        items = list(Notification.objects.filter(type="agent.hitl.waiting"))
        self.assertEqual({i.user_id for i in items}, {"user-a", "user-b"})
        mock_viewing.assert_called_once_with("user-a", HITL_SESSION_ID)
        mock_logger.warning.assert_called_once_with(
            "[AgentTaskNotify] hitl presence unavailable kind=%s session=%s reason=%s",
            "review",
            HITL_SESSION_ID[:8],
            "RuntimeError",
        )

    @patch(
        "apps.services.agent_engine.services.pending_interaction_service.interaction_notify_user_ids",
        return_value=["user-a", "user-b"],
    )
    @patch(
        "apps.services.notification.services.agent_task_notification.resolve_chat_session_context",
        return_value={
            "session_id": HITL_SESSION_ID,
            "organization_id": "org-1",
            "workspace_id": "workspace-1",
            "project_id": "project-1",
            "user_id": "user-a",
            "title": "HITL",
        },
    )
    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    @patch("apps.services.notification.services.agent_task_notification.logger")
    @patch("builtins.__import__", wraps=builtins.__import__)
    def test_hitl_waiting_presence_import_error_fails_open_once(
        self, mock_import, mock_logger, _mock_push, _mock_ctx, _mock_recipients
    ):
        """presence import 失败只告警一次，且不会中断 HITL fan-out。"""
        real_import = mock_import._mock_wraps

        def fail_presence_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name == "apps.services.common.ws.session_viewing":
                raise ImportError("presence unavailable")
            return real_import(name, globals, locals, fromlist, level)

        mock_import.side_effect = fail_presence_import
        interaction = SimpleNamespace(
            id=str(uuid.uuid4()),
            session_id=HITL_SESSION_ID,
            organization_id="org-1",
            user_id="user-a",
            request_key="presence-import-error",
            kind="review",
            payload={"message_id": HITL_MESSAGE_ID},
        )
        notify_agent_hitl_waiting(
            interaction=interaction,
            title="Agent 等待确认",
            body="需要审核",
        )
        items = list(Notification.objects.filter(type="agent.hitl.waiting"))
        self.assertEqual({i.user_id for i in items}, {"user-a", "user-b"})
        presence_imports = [
            call
            for call in mock_import.call_args_list
            if call.args[0] == "apps.services.common.ws.session_viewing"
        ]
        self.assertEqual(len(presence_imports), 1)
        mock_logger.warning.assert_called_once_with(
            "[AgentTaskNotify] hitl presence unavailable kind=%s session=%s reason=%s",
            "review",
            HITL_SESSION_ID[:8],
            "ImportError",
        )

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_tracker_run_terminal_persists_tracker_target(self, _mock_push):
        tracker = SimpleNamespace(
            id=TRACKER_ID,
            name="日报",
            created_by_id="user-1",
            space_id="space-1",
            organization_id="org-1",
            skill_key="daily-report",
        )
        tracker_run = SimpleNamespace(
            id=RUN_ID,
            tracker=tracker,
            chat_session_id=TRACKER_SESSION_ID,
            progress_message="完成",
            error_summary="",
        )
        notify_tracker_run_terminal(
            tracker_run=tracker_run,
            success=True,
            title="自动化任务「日报」已完成",
            body="完成",
        )
        notif = Notification.objects.get(user_id="user-1", type="tracker.run.completed")
        self.assertEqual(notif.metadata["navigate_to"]["type"], "tracker")
        self.assertEqual(notif.metadata["navigate_to"]["id"], TRACKER_ID)
        self.assertEqual(notif.metadata["navigate_to"]["runId"], RUN_ID)
        self.assertEqual(notif.metadata["session_id"], TRACKER_SESSION_ID)
        self.assertEqual(notif.metadata["tracker_name"], "日报")

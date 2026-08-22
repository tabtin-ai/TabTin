"""Tracker 取消应同步停止设备端 Agent 执行。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase


class TrackerCancelPropagationTests(SimpleTestCase):
    def test_request_run_cancellation_forwards_prompt_cancel(self):
        from apps.tracker.services.tracker_service import TrackerService

        session_id = uuid4()
        latest_run_id = uuid4()
        tracker_run = SimpleNamespace(
            id=uuid4(),
            chat_session_id=session_id,
            status="cancelled",
            context={"_runtime_task_id": "prompt_tracker_1"},
            tracker=SimpleNamespace(agent_id=uuid4()),
        )
        workspace = MagicMock(name="workspace")
        session = SimpleNamespace(
            id=session_id,
            workspace_id=uuid4(),
            workspace=workspace,
            effective_thread_id="thread-tracker-1",
        )
        latest_run = SimpleNamespace(run_id=latest_run_id, status="running")

        with patch(
            "apps.tracker.services.tracker_executor._tracker_run_task_id",
            return_value="celery-task-1",
        ), patch("celery.current_app") as celery_app, patch(
            "apps.chat.conversation.models.ChatSession.objects.filter",
        ) as session_filter, patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService",
        ) as pfs_cls, patch(
            "apps.services.agent_engine.services.run_service.RunService.get_latest_run",
            return_value=latest_run,
        ) as get_latest_run, patch(
            "apps.services.agent_engine.services.run_service.RunService.request_cancel",
        ) as request_cancel, patch(
            "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.transition",
        ) as transition:
            transition.return_value = None
            session_filter.return_value.select_related.return_value.first.return_value = session
            pfs_cls.return_value.forward_cancel.return_value = 1

            TrackerService._request_run_cancellation(tracker_run)

        celery_app.control.revoke.assert_called_once_with("celery-task-1", terminate=True)
        pfs_cls.return_value.forward_cancel.assert_called_once_with(
            thread_id="thread-tracker-1",
            task_id="prompt_tracker_1",
            space=session.workspace,
            agent_id=str(tracker_run.tracker.agent_id),
        )
        get_latest_run.assert_called_once_with("thread-tracker-1")
        request_cancel.assert_called_once_with(
            str(latest_run_id),
            reason="tracker_run_cancelled",
        )
        transition.assert_called_once_with(
            run_id=str(latest_run_id),
            status="cancelling",
            stop_reason="tracker_run_cancelled",
        )

    def test_request_run_cancellation_terminals_when_no_runtime_receiver(self):
        from apps.tracker.services.tracker_service import TrackerService

        session_id = uuid4()
        latest_run_id = uuid4()
        tracker_run = SimpleNamespace(
            id=uuid4(),
            chat_session_id=session_id,
            status="cancelled",
            context={"_runtime_task_id": "prompt_tracker_1"},
            tracker=SimpleNamespace(agent_id=uuid4()),
        )
        session = SimpleNamespace(
            id=session_id,
            workspace_id=uuid4(),
            workspace=MagicMock(name="workspace"),
            effective_thread_id="thread-tracker-1",
        )
        latest_run = SimpleNamespace(run_id=latest_run_id, status="running")

        with patch(
            "apps.tracker.services.tracker_executor._tracker_run_task_id",
            return_value=None,
        ), patch(
            "apps.chat.conversation.models.ChatSession.objects.filter",
        ) as session_filter, patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService",
        ) as pfs_cls, patch(
            "apps.services.agent_engine.services.run_service.RunService.get_latest_run",
            return_value=latest_run,
        ), patch(
            "apps.services.agent_engine.services.run_service.RunService.request_cancel",
        ) as request_cancel, patch(
            "apps.services.agent_engine.services.run_service.RunService.clear_cancelled",
        ) as clear_cancelled, patch(
            "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService.transition",
            side_effect=[None, SimpleNamespace(status="interrupted")],
        ) as transition:
            session_filter.return_value.select_related.return_value.first.return_value = session
            pfs_cls.return_value.forward_cancel.return_value = 0

            TrackerService._request_run_cancellation(tracker_run)

        request_cancel.assert_called_once_with(
            str(latest_run_id),
            reason="tracker_run_cancelled",
        )
        assert transition.call_count == 2
        transition.assert_any_call(
            run_id=str(latest_run_id),
            status="cancelling",
            stop_reason="tracker_run_cancelled",
        )
        transition.assert_any_call(
            run_id=str(latest_run_id),
            status="interrupted",
            stop_reason="aborted",
            error_class="ABORT",
            allowed_from={"queued", "running", "waiting_user", "paused", "cancelling"},
        )
        clear_cancelled.assert_called_once_with(str(latest_run_id))

    def test_skill_agent_skips_dispatch_when_run_already_cancelled(self):
        from apps.tracker.services import skill_executor

        run = MagicMock(name="tracker_run")
        run.id = uuid4()
        run.status = "cancelled"
        run.tracker = MagicMock(name="tracker")
        run.tracker.created_by = MagicMock()
        run.tracker.organization_id = uuid4()
        run.tracker.space_id = uuid4()
        run.tracker.name = "Daily Report"
        run.tracker.skill_key = ""
        run.tracker.skill_params = {}
        run.tracker.agent_id = uuid4()
        run.tracker.agent = MagicMock(preferred_model_id=None)
        notifier = MagicMock(name="notifier")

        with patch("apps.chat.conversation.models.ChatSession") as session_cls, patch(
            "apps.chat.conversation.models.ChatContext",
        ), patch(
            "apps.tracker.models.TrackerRun.objects.filter",
        ) as run_filter, patch(
            "apps.services.agent_execution.model_resolver.resolve_model",
        ), patch(
            "apps.services.remote_agent.device_resolver.resolve_dispatch_target",
            return_value=SimpleNamespace(control_device=MagicMock()),
        ), patch(
            "apps.services.remote_agent.RemoteAgentDispatcher.send_message_sync",
        ) as dispatch_mock:
            session_cls.objects.create.return_value = MagicMock(id=uuid4())
            run_filter.return_value.update.return_value = 1
            skill_executor._run_skill_agent(run, None, notifier)

        dispatch_mock.assert_not_called()
        notifier.notify_progress.assert_called()

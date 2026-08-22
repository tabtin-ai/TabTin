"""Tracker TrackerRun 恢复链路回归测试。

覆盖本轮修复的两个契约：
- 超过 cutoff 的 Celery PENDING 不能被当作仍活跃，否则 abandoned run 会永久阻塞 Tracker。
- 回收终态时要释放 per-run ChatSession 的 runtime action 设备绑定。
"""

from __future__ import annotations

from contextlib import nullcontext
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase
from django.utils import timezone


class _StuckRunQuerySet:
    def __init__(self, runs):
        self._runs = runs

    def select_related(self, *args, **kwargs):
        return self

    def __getitem__(self, item):
        return self._runs[item]


class _UpdateQuerySet:
    def __init__(self, updates, updated: int = 1):
        self._updates = updates
        self._updated = updated

    def update(self, **fields):
        self._updates.append(fields)
        return self._updated


class _RuntimeDoneRunQuerySet:
    def __init__(self, run):
        self._run = run

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def first(self):
        return self._run


def _make_run(
    *,
    status: str = "running",
    context: dict | None = None,
    trigger_context: dict | None = None,
    started_delta: timedelta = timedelta(hours=2),
    chat_session_id=None,
):
    run = SimpleNamespace(
        id=uuid4(),
        tracker_id=uuid4(),
        tracker=SimpleNamespace(organization_id=uuid4()),
        status=status,
        context=context or {},
        started_at=timezone.now() - started_delta,
        chat_session_id=chat_session_id,
        trigger_context=trigger_context or {},
    )
    run.refresh_from_db = MagicMock()
    return run


class TrackerExecutorRecoveryTests(SimpleTestCase):
    def test_release_tracker_run_runtime_claim_uses_chat_session_thread(self):
        from apps.tracker.services import tracker_executor

        session_id = uuid4()
        run = SimpleNamespace(id=uuid4(), chat_session_id=session_id)
        fake_session = SimpleNamespace(thread_id="chat-session-runtime-1")

        with patch(
            "apps.chat.conversation.models.ChatSession.objects.filter",
        ) as filter_mock, patch(
            "apps.services.agent_engine.services.action_transport_service.ActionTransportService",
        ) as transport_cls:
            filter_mock.return_value.only.return_value.first.return_value = fake_session
            transport_cls.return_value.force_release_action_device.return_value = True

            released = tracker_executor._release_tracker_run_runtime_claim(
                run,
                reason="unit_test",
            )

        self.assertTrue(released)
        filter_mock.assert_called_once_with(id=session_id)
        transport_cls.return_value.force_release_action_device.assert_called_once_with(
            "chat-session-runtime-1",
        )

    def test_completed_transcript_recovery_marks_running_run_completed(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="running",
            context={"_celery_task_id": "stale-started-task"},
            started_delta=timedelta(minutes=5),
            chat_session_id=uuid4(),
        )
        message = SimpleNamespace(
            text_summary="摘要",
            content_blocks_json=[
                {"type": "text", "text": "Agent 已经完成任务。"},
            ],
            updated_at=timezone.now() - timedelta(minutes=1),
        )
        message_queryset = MagicMock()
        message_queryset.order_by.return_value.first.return_value = message
        updates: list[dict] = []

        with patch(
            "apps.chat.conversation.models.ChatMessage.objects.filter",
            return_value=message_queryset,
        ), patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            return_value=_UpdateQuerySet(updates),
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ) as release_mock, patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ) as stats_mock, patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ) as notifier_cls, patch(
            "apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed",
        ) as cascade_mock:
            recovered = tracker_executor._complete_tracker_run_from_transcript(run)

        self.assertTrue(recovered)
        completed_update = next(fields for fields in updates if fields.get("status") == "completed")
        self.assertEqual(completed_update["progress_pct"], 100)
        self.assertEqual(completed_update["progress_message"], "Agent 已经完成任务。")
        self.assertEqual(
            completed_update["context"]["agent_result"]["response"],
            "Agent 已经完成任务。",
        )
        self.assertEqual(
            completed_update["context"]["recovery_source"],
            "completed_chat_transcript",
        )
        release_mock.assert_called_once_with(
            run,
            reason="completed_transcript_recovery",
        )
        stats_mock.assert_called_once_with(run.tracker_id, success=True)
        notifier_cls.return_value.notify_run_completed.assert_called_once_with(run)
        cascade_mock.assert_called_once_with(
            str(run.tracker_id),
            str(run.id),
            trigger_context=run.trigger_context,
        )

    def test_completed_trace_recovery_marks_running_run_completed_when_message_missing(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="running",
            context={"_celery_task_id": "stale-started-task"},
            started_delta=timedelta(minutes=5),
            chat_session_id=uuid4(),
        )
        message_queryset = MagicMock()
        message_queryset.order_by.return_value.first.return_value = None
        trace = SimpleNamespace(
            ended_at=timezone.now() - timedelta(minutes=2),
        )
        trace_queryset = MagicMock()
        trace_queryset.order_by.return_value.first.return_value = trace
        done_queryset = MagicMock()
        done_queryset.order_by.return_value.first.return_value = None
        updates: list[dict] = []

        with patch(
            "apps.chat.conversation.models.ChatMessage.objects.filter",
            return_value=message_queryset,
        ), patch(
            "apps.services.agent_engine.models.ExecutionTrace.objects.filter",
            return_value=trace_queryset,
        ), patch(
            "apps.services.agent_engine.models.TraceEvent.objects.filter",
            return_value=done_queryset,
        ), patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            return_value=_UpdateQuerySet(updates),
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ), patch(
            "apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed",
        ):
            recovered = tracker_executor._complete_tracker_run_from_transcript(run)

        self.assertTrue(recovered)
        completed_update = next(fields for fields in updates if fields.get("status") == "completed")
        self.assertEqual(completed_update["progress_pct"], 100)
        self.assertEqual(
            completed_update["context"]["recovery_source"],
            "completed_runtime_trace",
        )
        self.assertIn(
            "最终汇报消息未成功持久化",
            completed_update["context"]["agent_result"]["response"],
        )

    def test_runtime_done_event_marks_running_run_completed_immediately(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="running",
            context={"_runtime_task_id": "prompt-done"},
            started_delta=timedelta(minutes=5),
            chat_session_id=uuid4(),
        )
        updates: list[dict] = []

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "select_related",
            return_value=_RuntimeDoneRunQuerySet(run),
        ), patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            return_value=_UpdateQuerySet(updates),
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ) as release_mock, patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ) as stats_mock, patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ) as notifier_cls, patch(
            "apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed",
        ) as cascade_mock:
            recovered = tracker_executor.complete_tracker_run_from_runtime_done(
                "prompt-done",
                {
                    "content": "Agent 已经完成任务。",
                    "error": False,
                    "error_message": "",
                },
            )

        self.assertTrue(recovered)
        completed_update = next(fields for fields in updates if fields.get("status") == "completed")
        self.assertEqual(
            completed_update["context"]["agent_result"]["response"],
            "Agent 已经完成任务。",
        )
        self.assertEqual(
            completed_update["context"]["recovery_source"],
            "runtime_done_event",
        )
        release_mock.assert_called_once_with(run, reason="runtime_done_event")
        stats_mock.assert_called_once_with(run.tracker_id, success=True)
        notifier_cls.return_value.notify_run_completed.assert_called_once_with(run)
        cascade_mock.assert_called_once_with(
            str(run.tracker_id),
            str(run.id),
            trigger_context=run.trigger_context,
        )

    def test_runtime_done_event_update_race_does_not_double_count(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="running",
            context={"_runtime_task_id": "prompt-race"},
            started_delta=timedelta(minutes=5),
            chat_session_id=uuid4(),
        )
        updates: list[dict] = []

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "select_related",
            return_value=_RuntimeDoneRunQuerySet(run),
        ), patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            return_value=_UpdateQuerySet(updates, updated=0),
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ) as release_mock, patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ) as stats_mock, patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ) as notifier_cls, patch(
            "apps.tracker.services.tracker_trigger_service.trigger_by_tracker_completed",
        ) as cascade_mock:
            recovered = tracker_executor.complete_tracker_run_from_runtime_done(
                "prompt-race",
                {
                    "content": "Agent 已经完成任务。",
                    "error": False,
                    "error_message": "",
                },
            )

        self.assertFalse(recovered)
        self.assertTrue(any(fields.get("status") == "completed" for fields in updates))
        release_mock.assert_not_called()
        stats_mock.assert_not_called()
        notifier_cls.assert_not_called()
        cascade_mock.assert_not_called()

    def test_runtime_done_error_without_message_writes_specific_failure(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="running",
            context={"_runtime_task_id": "prompt-error-empty"},
            started_delta=timedelta(minutes=5),
            chat_session_id=uuid4(),
        )
        updates: list[dict] = []

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "select_related",
            return_value=_RuntimeDoneRunQuerySet(run),
        ), patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            return_value=_UpdateQuerySet(updates),
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ):
            recovered = tracker_executor.complete_tracker_run_from_runtime_done(
                "prompt-error-empty",
                {
                    "content": "",
                    "error": True,
                    "error_message": "",
                },
            )

        self.assertTrue(recovered)
        failed_update = next(fields for fields in updates if fields.get("status") == "failed")
        self.assertIn("返回了失败状态", failed_update["error_summary"])
        self.assertIn("没有带回更具体的错误详情", failed_update["error_summary"])
        self.assertNotIn("具体原因暂时还没看清楚", failed_update["error_summary"])

    def test_recover_stuck_runs_reclaims_old_celery_pending(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(context={"_celery_task_id": "lost-task-id"})
        updates: list[dict] = []
        fake_semaphore = MagicMock()

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch.object(
            tracker_executor.transaction,
            "atomic",
            return_value=nullcontext(),
        ), patch(
            "celery.result.AsyncResult",
            return_value=SimpleNamespace(state="PENDING"),
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "_get_organization_semaphore",
            return_value=fake_semaphore,
        ), patch(
            "apps.tracker.services.tracker_service.TrackerService._request_run_cancellation",
        ) as cancel_mock, patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ) as release_mock, patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ):
            recovered = tracker_executor.recover_stuck_runs(timeout_seconds=3600)

        self.assertEqual(recovered, 1)
        self.assertTrue(
            any(fields.get("status") == "failed" for fields in updates),
            f"expected failed update, got {updates!r}",
        )
        fake_semaphore.release_simple.assert_called_once()
        cancel_mock.assert_called_once_with(run)
        release_mock.assert_called_once_with(run, reason="recover_stuck_runs")

    def test_recover_stuck_runs_reclaims_timed_out_running_even_if_celery_started(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(context={"_celery_task_id": "started-task-id"})
        updates: list[dict] = []
        fake_semaphore = MagicMock()

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch(
            "celery.result.AsyncResult",
            return_value=SimpleNamespace(state="STARTED"),
        ), patch.object(
            tracker_executor.transaction,
            "atomic",
            return_value=nullcontext(),
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "_get_organization_semaphore",
            return_value=fake_semaphore,
        ), patch(
            "apps.tracker.services.tracker_service.TrackerService._request_run_cancellation",
        ) as cancel_mock, patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ) as release_mock:
            recovered = tracker_executor.recover_stuck_runs(timeout_seconds=3600)

        self.assertEqual(recovered, 1)
        self.assertTrue(
            any(fields.get("status") == "failed" for fields in updates),
            f"expected failed update, got {updates!r}",
        )
        fake_semaphore.release_simple.assert_called_once()
        cancel_mock.assert_called_once_with(run)
        release_mock.assert_called_once_with(run, reason="recover_stuck_runs")

    def test_recover_stuck_runs_reclaims_recent_pending_without_task_id(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="pending",
            context={},
            started_delta=timedelta(minutes=3),
        )
        updates: list[dict] = []

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch.object(
            tracker_executor.transaction,
            "atomic",
            return_value=nullcontext(),
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "_get_organization_semaphore",
            return_value=MagicMock(),
        ), patch(
            "apps.tracker.services.tracker_service.TrackerService._request_run_cancellation",
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ), patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ):
            recovered = tracker_executor.recover_stuck_runs(
                timeout_seconds=3600,
                pending_orphan_timeout_seconds=120,
            )

        self.assertEqual(recovered, 1)
        failed_update = next(fields for fields in updates if fields.get("status") == "failed")
        self.assertIn("后台执行队列没有及时接手", failed_update["error_summary"])

    def test_recover_stuck_runs_keeps_late_catchup_while_dispatch_is_queued(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="pending",
            context={"dispatch_task_id": "late-catchup-task-id"},
            trigger_context={"late_by_seconds": 1201},
            started_delta=timedelta(minutes=3),
        )
        updates: list[dict] = []

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch.object(
            tracker_executor.transaction,
            "atomic",
            return_value=nullcontext(),
        ), patch(
            "celery.result.AsyncResult",
            return_value=SimpleNamespace(state="PENDING"),
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "_get_organization_semaphore",
            return_value=MagicMock(),
        ), patch(
            "apps.tracker.services.tracker_service.TrackerService._request_run_cancellation",
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ), patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ):
            recovered = tracker_executor.recover_stuck_runs(
                timeout_seconds=3600,
                pending_orphan_timeout_seconds=120,
            )

        self.assertEqual(recovered, 0)
        self.assertEqual(updates, [])

    def test_recover_stuck_runs_keeps_queued_pending_with_dispatch_task_id(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="pending",
            context={"dispatch_task_id": "queued-task-id"},
            started_delta=timedelta(minutes=3),
        )
        updates: list[dict] = []

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch.object(
            tracker_executor.transaction,
            "atomic",
            return_value=nullcontext(),
        ), patch(
            "celery.result.AsyncResult",
            return_value=SimpleNamespace(state="PENDING"),
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "_get_organization_semaphore",
            return_value=MagicMock(),
        ), patch(
            "apps.tracker.services.tracker_service.TrackerService._request_run_cancellation",
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ), patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ):
            recovered = tracker_executor.recover_stuck_runs(
                timeout_seconds=3600,
                pending_orphan_timeout_seconds=120,
            )

        self.assertEqual(recovered, 0)
        self.assertEqual(updates, [])

    def test_recover_stuck_runs_keeps_retry_during_dispatch_grace_without_task_id(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="pending",
            context={
                tracker_executor.TRANSIENT_RETRY_GRACE_UNTIL_CONTEXT_KEY: int(
                    (timezone.now() + timedelta(minutes=2)).timestamp()
                ),
            },
            started_delta=timedelta(minutes=3),
        )
        updates: list[dict] = []

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch.object(
            tracker_executor,
            "_complete_tracker_run_from_transcript",
            return_value=False,
        ):
            recovered = tracker_executor.recover_stuck_runs(
                timeout_seconds=3600,
                pending_orphan_timeout_seconds=120,
            )

        self.assertEqual(recovered, 0)
        self.assertEqual(updates, [])

    def test_recover_stuck_runs_reclaims_full_timeout_pending_with_dispatch_task_id(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="pending",
            context={"dispatch_task_id": "lost-task-id"},
            started_delta=timedelta(hours=2),
        )
        updates: list[dict] = []

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch.object(
            tracker_executor.transaction,
            "atomic",
            return_value=nullcontext(),
        ), patch(
            "celery.result.AsyncResult",
            return_value=SimpleNamespace(state="PENDING"),
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "_get_organization_semaphore",
            return_value=MagicMock(),
        ), patch(
            "apps.tracker.services.tracker_service.TrackerService._request_run_cancellation",
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ), patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ):
            recovered = tracker_executor.recover_stuck_runs(
                timeout_seconds=3600,
                pending_orphan_timeout_seconds=120,
            )

        self.assertEqual(recovered, 1)
        failed_update = next(fields for fields in updates if fields.get("status") == "failed")
        self.assertIn("后台执行队列没有及时接手", failed_update["error_summary"])

    def test_recover_stuck_runs_keeps_pending_when_celery_started(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="pending",
            context={"dispatch_task_id": "started-task-id"},
            started_delta=timedelta(minutes=3),
        )
        updates: list[dict] = []

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch(
            "celery.result.AsyncResult",
            return_value=SimpleNamespace(state="STARTED"),
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ) as release_mock:
            recovered = tracker_executor.recover_stuck_runs(
                timeout_seconds=3600,
                pending_orphan_timeout_seconds=120,
            )

        self.assertEqual(recovered, 0)
        self.assertEqual(updates, [])
        release_mock.assert_not_called()

    def test_recover_stuck_runs_keeps_pending_under_orphan_threshold(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            status="pending",
            context={"dispatch_task_id": "queued-task-id"},
            started_delta=timedelta(seconds=30),
        )
        updates: list[dict] = []

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ) as release_mock:
            recovered = tracker_executor.recover_stuck_runs(
                timeout_seconds=3600,
                pending_orphan_timeout_seconds=120,
            )

        self.assertEqual(recovered, 0)
        self.assertEqual(updates, [])
        release_mock.assert_not_called()

    def test_recover_stuck_runs_reclaims_legacy_waiting_checkpoint(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(status="waiting_checkpoint")
        updates: list[dict] = []

        def fake_filter(*args, **kwargs):
            if args or "started_at__lt" in kwargs:
                return _StuckRunQuerySet([run])
            return _UpdateQuerySet(updates)

        with patch.object(
            tracker_executor.TrackerRun.objects,
            "filter",
            side_effect=fake_filter,
        ), patch.object(
            tracker_executor.transaction,
            "atomic",
            return_value=nullcontext(),
        ), patch.object(
            tracker_executor,
            "_update_tracker_stats",
        ), patch.object(
            tracker_executor,
            "_get_organization_semaphore",
            return_value=MagicMock(),
        ), patch(
            "apps.tracker.services.tracker_service.TrackerService._request_run_cancellation",
        ), patch.object(
            tracker_executor,
            "_release_tracker_run_runtime_claim",
        ), patch.object(
            tracker_executor,
            "TrackerNotificationService",
        ):
            recovered = tracker_executor.recover_stuck_runs(timeout_seconds=3600)

        self.assertEqual(recovered, 1)
        failed_update = next(fields for fields in updates if fields.get("status") == "failed")
        self.assertIn("旧版检查点", failed_update["error_summary"])

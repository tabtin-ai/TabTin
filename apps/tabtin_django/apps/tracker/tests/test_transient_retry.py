"""Tracker 瞬态失败自动重试。

覆盖：
- rate_limit / 429 文案 → 调度延迟重试
- 次数耗尽 → 落 failed 且文案注明已重试 N 次
- 非瞬态（permission denied）→ 不重试
"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase
from django.utils import timezone


def _make_run(*, status="running", context=None, chat_session_id=None):
    now = timezone.now()
    tracker = SimpleNamespace(id=uuid4(), skill_key="demo_skill")
    return SimpleNamespace(
        id=uuid4(),
        tracker=tracker,
        tracker_id=tracker.id,
        status=status,
        context=dict(context or {}),
        trigger_context={},
        started_at=now - timedelta(minutes=1),
        finished_at=None,
        chat_session_id=chat_session_id,
        error_summary="",
        progress_message="",
        progress_pct=0,
        refresh_from_db=MagicMock(),
    )


class TransientRetryTests(SimpleTestCase):
    def test_rate_limit_schedules_retry(self):
        from apps.tracker.constants import (
            TRANSIENT_RETRY_CONTEXT_KEY,
        )
        from apps.tracker.services import tracker_executor

        existing_session_id = uuid4()
        run = _make_run(chat_session_id=existing_session_id)
        updates: list[dict] = []

        class _QS:
            def update(self, **kwargs):
                updates.append(kwargs)
                return 1

        with patch.object(
            tracker_executor.TrackerRun.objects, "filter", return_value=_QS()
        ), patch.object(
            tracker_executor, "_release_tracker_run_runtime_claim"
        ), patch.object(
            tracker_executor, "TrackerNotificationService"
        ) as notifier_cls:
            scheduled = tracker_executor.maybe_schedule_transient_retry(
                run,
                error="rate limited by upstream",
                error_category="rate_limit",
                notifier=notifier_cls.return_value,
            )

        self.assertTrue(scheduled)
        self.assertEqual(updates[0]["status"], "pending")
        self.assertEqual(updates[0]["context"][TRANSIENT_RETRY_CONTEXT_KEY], 1)
        # ：瞬态重试不得清空 chat_session_id，否则旧对话成为孤儿漏进主列表。
        self.assertNotIn("chat_session_id", updates[0])
        self.assertEqual(run.chat_session_id, existing_session_id)
        self.assertGreater(
            updates[0]["context"][tracker_executor.TRANSIENT_RETRY_GRACE_UNTIL_CONTEXT_KEY],
            timezone.now().timestamp(),
        )

    def test_runtime_failed_429_message_is_transient(self):
        from apps.tracker.services import tracker_executor

        self.assertTrue(
            tracker_executor._is_transient_failure(
                "runtime_failed",
                "模型上游返回错误（429）……建议换一个模型重试",
            )
        )

    def test_dispatch_context_failure_does_not_negate_successful_retry_enqueue(self):
        from apps.tracker.services import tracker_executor

        run = _make_run(
            context={
                "dispatch_task_id": "old-task-id",
                "_celery_task_id": "old-task-id",
                "task_id": "old-task-id",
            }
        )
        updates: list[dict] = []

        class _QS:
            def update(self, **kwargs):
                updates.append(kwargs)
                return 1

        with patch.object(
            tracker_executor.TrackerRun.objects, "filter", return_value=_QS()
        ), patch.object(
            tracker_executor, "_release_tracker_run_runtime_claim"
        ), patch.object(
            tracker_executor, "TrackerNotificationService"
        ) as notifier_cls:
            scheduled = tracker_executor.maybe_schedule_transient_retry(
                run,
                error="rate limited by upstream",
                error_category="rate_limit",
                notifier=notifier_cls.return_value,
            )

        self.assertTrue(scheduled)
        pending_context = updates[0]["context"]
        self.assertNotIn("dispatch_task_id", pending_context)
        self.assertNotIn("_celery_task_id", pending_context)
        self.assertNotIn("task_id", pending_context)
        self.assertGreater(
            pending_context[tracker_executor.TRANSIENT_RETRY_GRACE_UNTIL_CONTEXT_KEY],
            timezone.now().timestamp(),
        )

    def test_non_transient_does_not_retry(self):
        from apps.tracker.services import tracker_executor

        run = _make_run()
        with patch(
            "apps.tracker.tasks.execute_tracker"
        ) as mock_task:
            scheduled = tracker_executor.maybe_schedule_transient_retry(
                run,
                error="permission denied on resource",
                error_category="permission_denied",
            )
        self.assertFalse(scheduled)
        mock_task.apply_async.assert_not_called()

    def test_retry_exhausted_falls_through_to_fail(self):
        from apps.tracker.constants import (
            TRANSIENT_RETRY_CONTEXT_KEY,
            TRANSIENT_RETRY_MAX_ATTEMPTS,
        )
        from apps.tracker.services import tracker_executor

        run = _make_run(
            context={TRANSIENT_RETRY_CONTEXT_KEY: TRANSIENT_RETRY_MAX_ATTEMPTS}
        )
        updates: list[dict] = []

        class _QS:
            def update(self, **kwargs):
                updates.append(kwargs)
                return 1

        with patch.object(
            tracker_executor.TrackerRun.objects, "filter", return_value=_QS()
        ), patch.object(
            tracker_executor, "_release_tracker_run_runtime_claim"
        ), patch.object(
            tracker_executor, "_update_tracker_stats"
        ), patch.object(
            tracker_executor, "TrackerNotificationService"
        ) as notifier_cls, patch(
            "apps.tracker.tasks.execute_tracker"
        ) as mock_task:
            tracker_executor._fail_tracker_run(
                run,
                "模型上游返回错误（429）",
                notifier_cls.return_value,
                error_category="runtime_failed",
            )

        mock_task.apply_async.assert_not_called()
        failed = next(u for u in updates if u.get("status") == "failed")
        self.assertIn("已自动重试", failed["error_summary"])
        self.assertIn(str(TRANSIENT_RETRY_MAX_ATTEMPTS), failed["error_summary"])

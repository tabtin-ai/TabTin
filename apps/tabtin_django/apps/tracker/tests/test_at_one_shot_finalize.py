"""#5296：一次性 at 任务不得在触发/终态后被续命重跑。"""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase
from django.utils import timezone


class ValidateActivationScheduleTests(SimpleTestCase):
    def test_rejects_past_at_trigger(self):
        from apps.tracker.services.tracker_service import _validate_activation_schedule

        past = timezone.now() - timedelta(hours=1)
        tracker = SimpleNamespace(
            trigger_type="at",
            trigger_config={"at": past.isoformat()},
        )
        with self.assertRaises(ValidationError) as ctx:
            _validate_activation_schedule(tracker)
        self.assertIn("执行时间已过", str(ctx.exception))

    def test_allows_future_at_trigger(self):
        from apps.tracker.services.tracker_service import _validate_activation_schedule

        future = timezone.now() + timedelta(hours=2)
        tracker = SimpleNamespace(
            trigger_type="at",
            trigger_config={"at": future.isoformat()},
        )
        _validate_activation_schedule(tracker)

    def test_manual_is_a_noop(self):
        from apps.tracker.services.tracker_service import _validate_activation_schedule

        tracker = SimpleNamespace(trigger_type="manual", trigger_config={})
        _validate_activation_schedule(tracker)


class FinalizeOneShotTrackerTests(SimpleTestCase):
    @patch("apps.tracker.services.tracker_service.transaction.atomic")
    @patch("apps.tracker.services.tracker_service.Tracker.objects")
    def test_disables_and_clears_next_run(self, objects_mock, _atomic):
        from apps.tracker.services.tracker_service import finalize_one_shot_tracker

        tracker = MagicMock()
        tracker.trigger_type = "at"
        tracker.status = "active"
        tracker.next_run_at = timezone.now() + timedelta(minutes=1)
        objects_mock.select_for_update.return_value.get.return_value = tracker

        changed = finalize_one_shot_tracker(uuid4())

        self.assertTrue(changed)
        tracker.transition_status.assert_called_once_with("disabled")
        self.assertIsNone(tracker.next_run_at)
        tracker.save.assert_called_once()
        self.assertIn("status", tracker.save.call_args.kwargs["update_fields"])
        self.assertIn("next_run_at", tracker.save.call_args.kwargs["update_fields"])

    @patch("apps.tracker.services.tracker_service.transaction.atomic")
    @patch("apps.tracker.services.tracker_service.Tracker.objects")
    def test_idempotent_when_already_finalized(self, objects_mock, _atomic):
        from apps.tracker.services.tracker_service import finalize_one_shot_tracker

        tracker = MagicMock()
        tracker.trigger_type = "at"
        tracker.status = "disabled"
        tracker.next_run_at = None
        objects_mock.select_for_update.return_value.get.return_value = tracker

        changed = finalize_one_shot_tracker(uuid4())

        self.assertFalse(changed)
        tracker.transition_status.assert_not_called()
        tracker.save.assert_not_called()

    @patch("apps.tracker.services.tracker_service.transaction.atomic")
    @patch("apps.tracker.services.tracker_service.Tracker.objects")
    def test_ignores_non_at_trigger(self, objects_mock, _atomic):
        from apps.tracker.services.tracker_service import finalize_one_shot_tracker

        tracker = MagicMock()
        tracker.trigger_type = "cron"
        tracker.status = "active"
        tracker.next_run_at = timezone.now()
        objects_mock.select_for_update.return_value.get.return_value = tracker

        changed = finalize_one_shot_tracker(uuid4())

        self.assertFalse(changed)
        tracker.transition_status.assert_not_called()
        tracker.save.assert_not_called()


class UpdateTrackerStatsAtTests(SimpleTestCase):
    @patch("apps.tracker.services.tracker_executor.transaction.atomic")
    @patch("apps.tracker.services.tracker_executor.Tracker.objects")
    def test_completion_finalizes_at_tracker(self, objects_mock, _atomic):
        from apps.tracker.services.tracker_executor import _update_tracker_stats

        tracker = MagicMock()
        tracker.trigger_type = "at"
        tracker.status = "active"
        tracker.next_run_at = timezone.now() + timedelta(minutes=1)
        tracker.total_runs = 0
        tracker.success_runs = 0
        tracker.fail_runs = 0
        objects_mock.select_for_update.return_value.get.return_value = tracker

        _update_tracker_stats(uuid4(), success=True)

        tracker.transition_status.assert_called_once_with("disabled")
        self.assertIsNone(tracker.next_run_at)
        self.assertEqual(tracker.total_runs, 1)
        self.assertEqual(tracker.success_runs, 1)
        saved_fields = tracker.save.call_args.kwargs["update_fields"]
        self.assertIn("status", saved_fields)
        self.assertIn("next_run_at", saved_fields)


class ScanDueTrackersRetiredTests(SimpleTestCase):
    def test_scan_due_trackers_task_is_gone(self):
        from apps.tracker import tasks as tracker_tasks

        self.assertFalse(hasattr(tracker_tasks, "scan_due_trackers"))
        self.assertNotIn("scan-due-trackers", tracker_tasks.TRACKER_BEAT_SCHEDULE)

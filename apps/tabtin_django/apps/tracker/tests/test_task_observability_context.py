from types import SimpleNamespace
from unittest.mock import patch

from django.conf import settings
from django.test import SimpleTestCase, override_settings


class TrackerTaskObservabilityContextTests(SimpleTestCase):
    def test_context_uses_task_id_as_trace_and_records_queue(self):
        from apps.tracker.tasks import _tracker_run_observability_context

        task = SimpleNamespace(
            request=SimpleNamespace(
                id="celery-task-1",
                delivery_info={"routing_key": "tracker_agent"},
            )
        )

        context = _tracker_run_observability_context(task)

        self.assertEqual(context["_celery_task_id"], "celery-task-1")
        self.assertEqual(context["task_id"], "celery-task-1")
        self.assertEqual(context["trace_id"], "celery-task-1")
        self.assertEqual(context["queue_name"], "tracker_agent")
        self.assertEqual(context["consumer_queue_name"], "tracker_agent")
        self.assertEqual(context["configured_queue_name"], settings.TRACKER_AGENT_QUEUE)

    def test_context_falls_back_to_tracker_queue_and_records_error_code(self):
        from apps.tracker.tasks import _tracker_run_observability_context

        task = SimpleNamespace(request=SimpleNamespace(id="celery-task-2", delivery_info={}))

        context = _tracker_run_observability_context(task, error_code="RuntimeError")

        self.assertEqual(context["queue_name"], settings.TRACKER_AGENT_QUEUE)
        self.assertEqual(context["consumer_queue_name"], settings.TRACKER_AGENT_QUEUE)
        self.assertEqual(context["configured_queue_name"], settings.TRACKER_AGENT_QUEUE)
        self.assertEqual(context["error_code"], "RuntimeError")

    @override_settings(TRACKER_AGENT_QUEUE="tracker_agent_local")
    def test_context_falls_back_to_configured_tracker_queue(self):
        from apps.tracker.tasks import _tracker_run_observability_context

        task = SimpleNamespace(request=SimpleNamespace(id="celery-task-3", delivery_info={}))

        context = _tracker_run_observability_context(task)

        self.assertEqual(context["queue_name"], "tracker_agent_local")
        self.assertEqual(context["consumer_queue_name"], "tracker_agent_local")
        self.assertEqual(context["configured_queue_name"], "tracker_agent_local")

    @override_settings(TRACKER_AGENT_QUEUE="tracker_agent_desktop_test")
    def test_local_isolated_queue_mismatch_is_detected(self):
        from apps.tracker.tasks import (
            _tracker_queue_mismatch,
            _tracker_run_observability_context,
        )

        task = SimpleNamespace(
            request=SimpleNamespace(
                id="celery-task-4",
                delivery_info={"routing_key": "tracker_agent"},
            )
        )

        context = _tracker_run_observability_context(task)

        self.assertEqual(context["queue_name"], "tracker_agent")
        self.assertEqual(context["configured_queue_name"], "tracker_agent_desktop_test")
        self.assertTrue(_tracker_queue_mismatch(context))

    @override_settings(TRACKER_AGENT_QUEUE="tracker_agent_desktop_test")
    def test_local_isolated_queue_match_is_allowed(self):
        from apps.tracker.tasks import (
            _tracker_queue_mismatch,
            _tracker_run_observability_context,
        )

        task = SimpleNamespace(
            request=SimpleNamespace(
                id="celery-task-5",
                delivery_info={"routing_key": "tracker_agent_desktop_test"},
            )
        )

        context = _tracker_run_observability_context(task)

        self.assertFalse(_tracker_queue_mismatch(context))

    def test_scan_due_trackers_is_removed_from_beat(self):
        from apps.tracker import tasks as tracker_tasks
        from tabtin.celery import _RETIRED_PERIODIC_TASK_NAMES

        self.assertFalse(hasattr(tracker_tasks, "scan_due_trackers"))
        self.assertNotIn("scan-due-trackers", tracker_tasks.TRACKER_BEAT_SCHEDULE)
        self.assertIn(
            "apps.tracker.tasks.scan_due_trackers",
            _RETIRED_PERIODIC_TASK_NAMES,
        )

    def test_recover_stuck_tracker_runs_is_removed_from_beat(self):
        from apps.tracker import tasks as tracker_tasks
        from tabtin.celery import _RETIRED_PERIODIC_TASK_NAMES

        self.assertFalse(hasattr(tracker_tasks, "recover_stuck_tracker_runs"))
        self.assertNotIn("recover-stuck-tracker-runs", tracker_tasks.TRACKER_BEAT_SCHEDULE)
        self.assertIn(
            "apps.tracker.tasks.recover_stuck_tracker_runs",
            _RETIRED_PERIODIC_TASK_NAMES,
        )
        self.assertFalse(hasattr(tracker_tasks, "redispatch_waiting_tracker_runs"))
        self.assertFalse(hasattr(tracker_tasks, "schedule_waiting_runs_redispatch"))
        self.assertIn(
            "apps.tracker.tasks.redispatch_waiting_tracker_runs",
            _RETIRED_PERIODIC_TASK_NAMES,
        )

    def test_tracker_health_check_is_removed_from_beat(self):
        from apps.tracker import tasks as tracker_tasks
        from tabtin.celery import _RETIRED_PERIODIC_TASK_NAMES

        self.assertNotIn("tracker-health-check", tracker_tasks.TRACKER_BEAT_SCHEDULE)
        self.assertIn(
            "apps.tracker.tasks.tracker_health_check",
            _RETIRED_PERIODIC_TASK_NAMES,
        )

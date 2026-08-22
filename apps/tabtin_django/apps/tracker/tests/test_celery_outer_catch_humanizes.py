"""execute_tracker 已退役：残留 Celery 消息不再在云上开跑。"""

from unittest.mock import patch

from django.test import SimpleTestCase


class ExecuteTrackerRetiredTests(SimpleTestCase):
    def test_execute_tracker_defers_to_host_without_running(self):
        from apps.tracker import tasks

        with patch(
            "apps.tracker.services.tracker_executor.run_tracker_run"
        ) as run_mock:
            result = tasks.execute_tracker.run("00000000-0000-0000-0000-000000000000")

        run_mock.assert_not_called()
        self.assertEqual(result["status"], "deferred_to_host")
        self.assertEqual(result["tracker_run_id"], "00000000-0000-0000-0000-000000000000")

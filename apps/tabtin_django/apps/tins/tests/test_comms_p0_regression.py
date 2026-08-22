"""COM-11 / COM-32 P0 回归测试。

确保 tins Beat Schedule 已注册到 celery.py 且 cleanup_run_logs 有 time_limit。
"""

from __future__ import annotations

from django.test import SimpleTestCase


class COM11TinsBeatScheduleRegisteredTest(SimpleTestCase):
    """COM-11: TINS_BEAT_SCHEDULE 应注册到 celery.py _SCHEDULE_EXPORTS。"""

    def test_schedule_in_celery_exports(self):
        from tabtin.celery import _SCHEDULE_EXPORTS

        modules = [spec["module"] for spec in _SCHEDULE_EXPORTS]
        self.assertIn("apps.tins.tasks", modules)

    def test_schedule_attr_name(self):
        from tabtin.celery import _SCHEDULE_EXPORTS

        tins_spec = next(
            s for s in _SCHEDULE_EXPORTS if s["module"] == "apps.tins.tasks"
        )
        self.assertEqual(tins_spec["attr"], "TINS_BEAT_SCHEDULE")

    def test_beat_schedule_has_cleanup_entry(self):
        from apps.tins.tasks import TINS_BEAT_SCHEDULE

        self.assertIn("tins-cleanup-run-logs", TINS_BEAT_SCHEDULE)
        entry = TINS_BEAT_SCHEDULE["tins-cleanup-run-logs"]
        self.assertEqual(entry["task"], "tins.cleanup_run_logs")


class COM32CleanupRunLogsTimeLimitTest(SimpleTestCase):
    """COM-32: cleanup_run_logs 必须同时设置 time_limit 和 soft_time_limit。"""

    def test_has_time_limit(self):
        from apps.tins.tasks import cleanup_run_logs

        self.assertIsNotNone(cleanup_run_logs.time_limit)

    def test_time_limit_exceeds_soft_time_limit(self):
        from apps.tins.tasks import cleanup_run_logs

        self.assertGreater(cleanup_run_logs.time_limit, cleanup_run_logs.soft_time_limit)

    def test_time_limit_value(self):
        from apps.tins.tasks import cleanup_run_logs

        self.assertEqual(cleanup_run_logs.time_limit, 660)
        self.assertEqual(cleanup_run_logs.soft_time_limit, 600)

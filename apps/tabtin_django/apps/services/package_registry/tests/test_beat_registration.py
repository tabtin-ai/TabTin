"""CLEANUP_BEAT_SCHEDULE 自动注册测试。

验证 tasks.py 中的 CLEANUP_BEAT_SCHEDULE 能被 celery.py 的
_discover_beat_schedules_auto() 自动发现。

运行方式：
    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test apps.services.package_registry.tests.test_beat_registration \
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""

from __future__ import annotations

from django.test import TestCase


class BeatScheduleRegistrationTest(TestCase):

    def test_cleanup_beat_schedule_exists(self):
        from apps.services.package_registry.tasks import CLEANUP_BEAT_SCHEDULE

        self.assertIn("package_registry.cleanup_stale_uploads", CLEANUP_BEAT_SCHEDULE)

    def test_cleanup_beat_schedule_task_name_matches(self):
        from apps.services.package_registry.tasks import CLEANUP_BEAT_SCHEDULE

        entry = CLEANUP_BEAT_SCHEDULE["package_registry.cleanup_stale_uploads"]
        self.assertEqual(entry["task"], "package_registry.cleanup_stale_uploads")

    def test_cleanup_beat_schedule_has_schedule(self):
        from apps.services.package_registry.tasks import CLEANUP_BEAT_SCHEDULE

        entry = CLEANUP_BEAT_SCHEDULE["package_registry.cleanup_stale_uploads"]
        self.assertIn("schedule", entry)
        sched = entry["schedule"]
        self.assertEqual(sched.run_every.total_seconds(), 3600)

    def test_auto_discovery_finds_schedule(self):
        """模拟 celery.py 的自动发现逻辑，验证能找到 CLEANUP_BEAT_SCHEDULE。"""
        import importlib

        module = importlib.import_module("apps.services.package_registry.tasks")
        found = {}
        for attr_name in dir(module):
            if attr_name.endswith("_BEAT_SCHEDULE"):
                val = getattr(module, attr_name, None)
                if isinstance(val, dict):
                    found.update(val)

        self.assertIn("package_registry.cleanup_stale_uploads", found)

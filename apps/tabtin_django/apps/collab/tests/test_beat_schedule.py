"""COM-10 回归测试：collab Beat Schedule 注册验证。"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


class TestCOM10CollabBeatSchedule:
    """COM-10: collab 任务应注册在 Beat Schedule 中。"""

    def test_collab_beat_schedule_defined(self):
        from apps.collab.tasks import COLLAB_BEAT_SCHEDULE
        assert "collab-cleanup-expired-versions" in COLLAB_BEAT_SCHEDULE
        assert "collab-downsample-versions" in COLLAB_BEAT_SCHEDULE

    def test_collab_schedule_task_names(self):
        from apps.collab.tasks import COLLAB_BEAT_SCHEDULE
        assert COLLAB_BEAT_SCHEDULE["collab-cleanup-expired-versions"]["task"] == "collab.cleanup_expired_versions"
        assert COLLAB_BEAT_SCHEDULE["collab-downsample-versions"]["task"] == "collab.downsample_versions"

    def test_collab_registered_in_schedule_exports(self):
        from tabtin.celery import _SCHEDULE_EXPORTS
        modules = [spec["module"] for spec in _SCHEDULE_EXPORTS]
        assert "apps.collab.tasks" in modules

        collab_spec = next(s for s in _SCHEDULE_EXPORTS if s["module"] == "apps.collab.tasks")
        assert collab_spec["attr"] == "COLLAB_BEAT_SCHEDULE"

    def test_schedule_has_reasonable_intervals(self):
        from apps.collab.tasks import COLLAB_BEAT_SCHEDULE
        for key, entry in COLLAB_BEAT_SCHEDULE.items():
            assert entry["schedule"] >= 60, f"{key} schedule too frequent"
            assert "options" in entry
            assert "expires" in entry["options"]

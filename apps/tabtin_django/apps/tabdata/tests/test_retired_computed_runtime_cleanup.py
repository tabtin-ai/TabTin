"""退役计算字段运行时残留的回归保护。"""

from django.test import SimpleTestCase

from apps.tabdata.api_open_space import _computed_cascade_gone_response
from tabtin.celery import _RETIRED_PERIODIC_TASK_NAMES


class TestRetiredComputedRuntimeCleanup(SimpleTestCase):
    def test_outbox_tasks_are_soft_disabled_for_database_scheduler(self):
        self.assertTrue({
            "tabdata.outbox_worker_run_sweep",
            "tabdata.outbox_recover_stale_leases",
        }.issubset(_RETIRED_PERIODIC_TASK_NAMES))

    def test_trigger_cascade_compatibility_route_returns_gone(self):
        status, payload = _computed_cascade_gone_response()

        self.assertEqual(status, 410)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], "TABDATA_COMPUTED_FIELDS_RETIRED")

from __future__ import annotations

from django.test import SimpleTestCase

from tabtin.runtime.validators import validate_runtime_manifest
from tabtin.runtime.registry import WORKER_REGISTRY


class RuntimeManifestValidationTests(SimpleTestCase):
    def test_validate_runtime_manifest_pass(self):
        result = validate_runtime_manifest()
        self.assertEqual(result.status, "PASS", result.failures)

    def test_realtime_and_data_ai_queues_have_expected_consumers(self):
        self.assertIn("realtime_delivery", WORKER_REGISTRY["worker-realtime"]["queues"])
        self.assertIn("rag_indexing", WORKER_REGISTRY["worker-data-ai"]["queues"])
        self.assertIn("tabdata_compute", WORKER_REGISTRY["worker-data-ai"]["queues"])
        self.assertIn("doc_merge", WORKER_REGISTRY["worker-data-ai"]["queues"])

    def test_heavy_worker_does_not_default_to_task_per_child(self):
        heavy = WORKER_REGISTRY["worker-heavy"]

        self.assertNotIn("--max-tasks-per-child", heavy["command"])
        self.assertNotIn("max-tasks-per-child=1", heavy["notes"])

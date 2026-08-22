from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import expectedFailure
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.common.observability import celery_worker_metrics as metrics


class _FakeMetric:
    def __init__(self):
        self.calls: list[tuple[str, dict, float]] = []

    def labels(self, **labels):
        self._labels = labels
        return self

    def inc(self, value: float = 1):
        self.calls.append(("inc", self._labels, value))

    def observe(self, value: float):
        self.calls.append(("observe", self._labels, value))


class _FailingMetric:
    def labels(self, **labels):
        raise RuntimeError("metrics backend unavailable")


class CeleryWorkerMetricsTests(SimpleTestCase):
    def setUp(self):
        metrics._TASK_STARTS.clear()
        metrics._SERVER_STARTED = False

    def test_disabled_mode_does_not_record_metrics(self):
        success = _FakeMetric()
        task = SimpleNamespace(name="billing.collect", queue="critical")

        with patch.dict(metrics.os.environ, {"CELERY_WORKER_METRICS_ENABLED": "0"}, clear=False), \
             patch.object(metrics, "task_success_total", success):
            metrics._on_task_postrun(sender=task, task_id="task-1", state="SUCCESS")

        self.assertEqual(success.calls, [])

    def test_success_and_duration_are_recorded_from_prerun_postrun(self):
        success = _FakeMetric()
        duration = _FakeMetric()
        task = SimpleNamespace(name="billing.collect", queue="critical")

        with patch.dict(
            metrics.os.environ,
            {
                "CELERY_WORKER_METRICS_ENABLED": "1",
                "CELERY_QUEUES": "critical",
                "HOSTNAME": "pod-1",
            },
            clear=False,
        ), \
             patch.object(metrics, "task_success_total", success), \
             patch.object(metrics, "task_duration_seconds", duration), \
             patch.object(metrics.time, "monotonic", side_effect=[10.0, 12.5]):
            metrics._on_task_prerun(sender=task, task_id="task-1")
            metrics._on_task_postrun(sender=task, task_id="task-1", state="SUCCESS")

        self.assertEqual(
            success.calls,
            [("inc", {"worker": "critical", "queue": "critical", "task_name": "billing.collect"}, 1)],
        )
        self.assertEqual(
            duration.calls,
            [
                (
                    "observe",
                    {
                        "worker": "critical",
                        "queue": "critical",
                        "task_name": "billing.collect",
                        "state": "success",
                    },
                    2.5,
                )
            ],
        )

    def test_failure_is_recorded_only_by_failure_signal(self):
        failed = _FakeMetric()
        success = _FakeMetric()
        duration = _FakeMetric()
        task = SimpleNamespace(name="billing.collect", queue="critical")

        with patch.dict(metrics.os.environ, {"CELERY_WORKER_METRICS_ENABLED": "1", "CELERY_QUEUES": "critical"}, clear=False), \
             patch.object(metrics, "task_failed_total", failed), \
             patch.object(metrics, "task_success_total", success), \
             patch.object(metrics, "task_duration_seconds", duration), \
             patch.object(metrics.time, "monotonic", side_effect=[1.0, 1.4]):
            metrics._on_task_prerun(sender=task, task_id="task-2")
            metrics._on_task_postrun(sender=task, task_id="task-2", state="FAILURE")
            metrics._on_task_failure(sender=task, task_id="task-2", exception=ValueError("private detail"))

        self.assertEqual(success.calls, [])
        self.assertEqual(
            failed.calls,
            [
                (
                    "inc",
                    {
                        "worker": "critical",
                        "queue": "critical",
                        "task_name": "billing.collect",
                        "exception_type": "ValueError",
                    },
                    1,
                )
            ],
        )
        self.assertEqual(duration.calls[0][0], "observe")
        self.assertEqual(duration.calls[0][1]["state"], "failure")

    def test_retry_uses_request_delivery_info(self):
        retry = _FakeMetric()
        task = SimpleNamespace(name="channel_gateway.process_inbound")
        request = SimpleNamespace(
            id="task-3",
            name="channel_gateway.process_inbound",
            delivery_info={"routing_key": "realtime_delivery"},
        )

        with patch.dict(metrics.os.environ, {"CELERY_WORKER_METRICS_ENABLED": "1", "CELERY_QUEUES": "realtime_delivery"}, clear=False), \
             patch.object(metrics, "task_retry_total", retry):
            metrics._on_task_retry(sender=task, request=request, reason=RuntimeError("private detail"))

        self.assertEqual(
            retry.calls,
            [
                (
                    "inc",
                    {
                        "worker": "realtime_delivery",
                        "queue": "realtime_delivery",
                        "task_name": "channel_gateway.process_inbound",
                        "exception_type": "RuntimeError",
                    },
                    1,
                )
            ],
        )

    def test_worker_up_metric_is_not_defined(self):
        self.assertFalse(hasattr(metrics, "worker_up"))

    def test_metrics_server_is_guarded_by_enabled_flag(self):
        with patch.dict(metrics.os.environ, {"CELERY_WORKER_METRICS_ENABLED": "0"}, clear=False), \
             patch.object(metrics, "start_http_server") as start_server:
            self.assertFalse(metrics._start_metrics_server_once())

        start_server.assert_not_called()

    def test_metrics_multiprocess_cleanup(self):
        with TemporaryDirectory() as tmpdir:
            multiproc_dir = Path(tmpdir) / "prometheus_multiproc"
            multiproc_dir.mkdir()
            stale_db = multiproc_dir / "old_counter.db"
            stale_db.write_text("old", encoding="utf-8")
            keep_file = multiproc_dir / "README.txt"
            keep_file.write_text("keep", encoding="utf-8")

            with patch.dict(
                metrics.os.environ,
                {
                    "CELERY_WORKER_METRICS_ENABLED": "true",
                    "PROMETHEUS_MULTIPROC_DIR": str(multiproc_dir),
                },
                clear=False,
            ):
                prepared = metrics.prepare_multiprocess_dir()

            self.assertEqual(prepared, multiproc_dir)
            self.assertTrue(multiproc_dir.is_dir())
            self.assertFalse(stale_db.exists())
            self.assertTrue(keep_file.exists())

    def test_metrics_disabled_no_directory(self):
        with TemporaryDirectory() as tmpdir:
            multiproc_dir = Path(tmpdir) / "prometheus_multiproc"

            with patch.dict(
                metrics.os.environ,
                {
                    "CELERY_WORKER_METRICS_ENABLED": "false",
                    "PROMETHEUS_MULTIPROC_DIR": str(multiproc_dir),
                },
                clear=False,
            ):
                prepared = metrics.prepare_multiprocess_dir()

            self.assertIsNone(prepared)
            self.assertFalse(multiproc_dir.exists())

    @expectedFailure
    def test_short_lived_children_do_not_create_multiprocess_db_files(self):
        """Child churn must not turn Prometheus storage into PID history."""
        with TemporaryDirectory() as tmpdir:
            multiproc_dir = Path(tmpdir) / "prometheus_multiproc"
            multiproc_dir.mkdir()
            env = {
                **os.environ,
                "CELERY_WORKER_METRICS_ENABLED": "1",
                "CELERY_QUEUES": "default",
                "PROMETHEUS_MULTIPROC_DIR": str(multiproc_dir),
            }
            script = """
from types import SimpleNamespace
from apps.services.common.observability import celery_worker_metrics as metrics

task = SimpleNamespace(name="tests.pid_churn", queue="default")
metrics._on_task_postrun(sender=task, task_id="task", state="SUCCESS")
"""

            # Two distinct child PIDs are sufficient to prove PID-keyed storage growth.
            for _ in range(2):
                subprocess.run(
                    [sys.executable, "-c", script],
                    cwd=Path(__file__).resolve().parents[4],
                    env=env,
                    check=True,
                    capture_output=True,
                    text=True,
                )

            self.assertEqual(list(multiproc_dir.glob("*.db")), [])

    def test_metrics_server_prepares_multiprocess_dir_before_listening(self):
        order = []

        def prepare():
            order.append("prepare")
            return Path("/tmp/prometheus_multiproc")

        def start_server(*args, **kwargs):
            order.append("start")

        with patch.dict(metrics.os.environ, {"CELERY_WORKER_METRICS_ENABLED": "true"}, clear=False), \
             patch.object(metrics, "prepare_multiprocess_dir", side_effect=prepare), \
             patch.object(metrics, "_metrics_registry", return_value=object()), \
             patch.object(metrics, "start_http_server", side_effect=start_server):
            self.assertTrue(metrics._start_metrics_server_once())

        self.assertEqual(order, ["prepare", "start"])

    def test_metric_write_errors_do_not_escape_signal_handler(self):
        task = SimpleNamespace(name="billing.collect", queue="critical")

        with patch.dict(metrics.os.environ, {"CELERY_WORKER_METRICS_ENABLED": "1", "CELERY_QUEUES": "critical"}, clear=False), \
             patch.object(metrics, "task_success_total", _FailingMetric()), \
             patch.object(metrics.logger, "debug") as debug_log:
            metrics._on_task_postrun(sender=task, task_id="task-4", state="SUCCESS")

        debug_log.assert_called_once()

import json
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.common.observability import realtime_celery_lifecycle as obs


class RealtimeCeleryLifecycleTests(SimpleTestCase):
    def setUp(self):
        obs._TASK_STARTS.clear()
        obs._REALTIME_WORKER_CACHE = None

    def _logged_payload(self, mock_info):
        raw = mock_info.call_args.args[1]
        return json.loads(raw)

    def test_parse_proc_status_rss_success(self):
        text = "Name:\tcelery\nVmSize:\t123 kB\nVmRSS:\t530552 kB\n"

        self.assertEqual(obs._parse_status_rss_kib(text), 530552)

    def test_proc_status_read_failure_returns_none(self):
        with patch("pathlib.Path.read_text", side_effect=PermissionError):
            self.assertIsNone(obs._read_rss_kib("/proc/missing/status"))

    def test_cgroup_read_failure_returns_none(self):
        with patch("pathlib.Path.read_text", side_effect=PermissionError):
            self.assertIsNone(obs._read_cgroup_memory_bytes())

    def test_task_args_are_not_logged(self):
        task = SimpleNamespace(name="channel_gateway.deliver_one_outbox", queue="realtime_delivery")

        with patch.object(obs, "_read_rss_kib", return_value=100), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=200), \
             patch.object(obs.logger, "info") as info:
            obs._on_task_prerun(
                sender=task,
                task_id="task-1",
                args=("outbox-1", "secret-message-body"),
                kwargs={"recipient_ids": ["user-1"], "token": "secret-token"},
            )

        payload_json = info.call_args.args[1]
        self.assertIn('"channel_outbound_id":"outbox-1"', payload_json)
        self.assertNotIn("secret-message-body", payload_json)
        self.assertNotIn("secret-token", payload_json)
        self.assertNotIn("recipient_ids", payload_json)

    def test_task_received_extracts_only_whitelisted_id(self):
        request = SimpleNamespace(
            id="task-received-1",
            name="channel_gateway.deliver_one_outbox",
            delivery_info={"routing_key": "realtime_delivery"},
            args=("outbox-received-1", "private-body"),
            kwargs={"token": "secret-token"},
        )

        with patch.object(obs, "_read_rss_kib", return_value=100), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=200), \
             patch.object(obs.logger, "info") as info:
            obs._on_task_received(request=request)

        payload_json = info.call_args.args[1]
        payload = json.loads(payload_json)
        self.assertEqual(payload["event"], "task_received")
        self.assertEqual(payload["channel_outbound_id"], "outbox-received-1")
        self.assertNotIn("private-body", payload_json)
        self.assertNotIn("secret-token", payload_json)

    def test_prerun_and_postrun_compute_duration_and_rss_delta(self):
        task = SimpleNamespace(name="channel_gateway.deliver_one_outbox", queue="realtime_delivery")

        with patch.object(obs, "_read_rss_kib", side_effect=[1000, 1000, 1250, 1250]), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=123456), \
             patch.object(obs.time, "monotonic", side_effect=[10.0, 10.25]), \
             patch.object(obs.logger, "info") as info:
            obs._on_task_prerun(
                sender=task,
                task_id="task-2",
                args=("outbox-2",),
                kwargs={},
            )
            obs._on_task_postrun(
                sender=task,
                task_id="task-2",
                args=("outbox-2",),
                kwargs={},
                state="SUCCESS",
            )

        postrun_payload = json.loads(info.call_args_list[-1].args[1])
        self.assertEqual(postrun_payload["event"], "task_postrun")
        self.assertEqual(postrun_payload["duration_ms"], 250)
        self.assertEqual(postrun_payload["rss_kib"], 1250)
        self.assertEqual(postrun_payload["rss_delta_kib"], 250)
        self.assertEqual(postrun_payload["cgroup_memory_bytes"], 123456)

    def test_task_revoked_logs_terminated_and_signum(self):
        task = SimpleNamespace(name="channel_gateway.deliver_one_outbox", queue="realtime_delivery")
        request = SimpleNamespace(id="task-3", name="channel_gateway.deliver_one_outbox", delivery_info={"routing_key": "realtime_delivery"})

        with patch.object(obs, "_read_rss_kib", return_value=100), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=200), \
             patch.object(obs.logger, "info") as info:
            obs._on_task_revoked(sender=task, request=request, terminated=True, signum=9)

        payload = self._logged_payload(info)
        self.assertEqual(payload["event"], "task_revoked")
        self.assertTrue(payload["terminated"])
        self.assertEqual(payload["signum"], 9)

    def test_task_failure_logs_exception_type_not_message(self):
        task = SimpleNamespace(name="channel_gateway.deliver_one_outbox", queue="realtime_delivery")

        with patch.object(obs, "_read_rss_kib", return_value=100), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=200), \
             patch.object(obs.logger, "info") as info:
            obs._on_task_failure(
                sender=task,
                task_id="task-fail-1",
                exception=ValueError("private message body and token"),
                args=("outbox-fail-1",),
                kwargs={},
            )

        payload_json = info.call_args.args[1]
        payload = json.loads(payload_json)
        self.assertEqual(payload["exception_type"], "ValueError")
        self.assertNotIn("private message body", payload_json)
        self.assertNotIn("token", payload_json)

    def test_task_retry_logs_exception_type_and_whitelisted_id(self):
        task = SimpleNamespace(name="channel_gateway.deliver_one_outbox", queue="realtime_delivery")
        request = SimpleNamespace(
            id="task-retry-1",
            name="channel_gateway.deliver_one_outbox",
            delivery_info={"routing_key": "realtime_delivery"},
            args=("channel-outbound-1", "private-body"),
            kwargs={},
        )

        with patch.object(obs, "_read_rss_kib", return_value=100), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=200), \
             patch.object(obs.logger, "info") as info:
            obs._on_task_retry(sender=task, request=request, reason=RuntimeError("secret-token"))

        payload_json = info.call_args.args[1]
        payload = json.loads(payload_json)
        self.assertEqual(payload["exception_type"], "RuntimeError")
        self.assertEqual(payload["channel_outbound_id"], "channel-outbound-1")
        self.assertNotIn("private-body", payload_json)
        self.assertNotIn("secret-token", payload_json)

    def test_worker_process_shutdown_logs_exitcode(self):
        with patch.object(obs, "_is_realtime_worker_process", return_value=True), \
             patch.object(obs, "_read_rss_kib", return_value=100), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=200), \
             patch.object(obs.logger, "info") as info:
            obs._on_worker_process_shutdown(pid=1234, exitcode=155)

        payload = self._logged_payload(info)
        self.assertEqual(payload["event"], "worker_process_shutdown")
        self.assertEqual(payload["pid"], 1234)
        self.assertEqual(payload["exitcode"], 155)
        self.assertEqual(payload["exit_reason"], "recycle")

    def test_worker_process_init_logs_started_metric(self):
        with patch.object(obs, "_is_realtime_worker_process", return_value=True), \
             patch.object(obs, "_read_rss_kib", return_value=100), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=200), \
             patch.object(obs.logger, "info") as info:
            obs._on_worker_process_init()

        payload = self._logged_payload(info)
        self.assertEqual(payload["event"], "worker_process_init")
        self.assertEqual(payload["worker"], "realtime")
        self.assertEqual(payload["metric"], "celery_worker_child_started_total")

    def test_non_realtime_task_does_not_emit_detailed_log(self):
        task = SimpleNamespace(name="billing.settle", queue="default")

        with patch.object(obs.logger, "info") as info:
            obs._on_task_prerun(
                sender=task,
                task_id="task-4",
                args=("arg-secret",),
                kwargs={"outbox_id": "should-not-log"},
            )

        info.assert_not_called()

    def test_channel_outbound_id_extraction_is_whitelisted(self):
        ids = obs._extract_correlation_ids(
            "channel_gateway.deliver_one_outbox",
            args=("outbox-5", "body", {"token": "secret"}),
            kwargs={"recipient_ids": ["u1"], "message": "secret"},
        )

        self.assertEqual(ids, {"outbox_id": None, "channel_outbound_id": "outbox-5"})

    def test_channel_gateway_inbound_dict_arg_is_not_logged_as_id(self):
        task = SimpleNamespace(name="channel_gateway.process_inbound", queue="default")
        inbound_payload = {"text": "private body", "token": "secret-token"}

        with patch.object(obs, "_read_rss_kib", return_value=100), \
             patch.object(obs, "_read_cgroup_memory_bytes", return_value=200), \
             patch.object(obs.logger, "info") as info:
            obs._on_task_prerun(
                sender=task,
                task_id="task-5",
                args=(inbound_payload,),
                kwargs={},
            )

        payload_json = info.call_args.args[1]
        payload = json.loads(payload_json)
        self.assertIsNone(payload["channel_outbound_id"])
        self.assertNotIn("private body", payload_json)
        self.assertNotIn("secret-token", payload_json)

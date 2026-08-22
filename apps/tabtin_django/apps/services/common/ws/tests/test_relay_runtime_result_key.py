import json
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.common.ws.handlers.relay_handler import (
    _write_runtime_result_from_relay_done,
)


class RelayRuntimeResultKeyTests(SimpleTestCase):
    def test_relay_done_writes_forward_runner_result_key(self):
        with patch("django.core.cache.cache.set") as mock_set, patch(
            "apps.tracker.services.tracker_executor.complete_tracker_run_from_runtime_done",
        ) as complete_mock:
            _write_runtime_result_from_relay_done({
                "task_id": "prompt_abc",
                "content": "done",
                "error": False,
                "error_message": "",
                "agent_type": "local-runtime",
            })

        mock_set.assert_called_once()
        key, raw_payload = mock_set.call_args.args[:2]
        self.assertEqual(key, "runtime:result:prompt_abc")
        payload = json.loads(raw_payload)
        self.assertEqual(payload["content"], "done")
        self.assertFalse(payload["error"])
        self.assertEqual(payload["agent_type"], "local-runtime")
        complete_mock.assert_called_once_with("prompt_abc", payload)

    def test_relay_done_without_task_id_is_ignored(self):
        with patch("django.core.cache.cache.set") as mock_set:
            _write_runtime_result_from_relay_done({"content": "done"})

        mock_set.assert_not_called()

    def test_relay_done_preserves_abort_as_a_cancelled_result(self):
        with patch("django.core.cache.cache.set") as mock_set, patch(
            "apps.tracker.services.tracker_executor.complete_tracker_run_from_runtime_done",
        ):
            _write_runtime_result_from_relay_done({
                "task_id": "prompt_aborted",
                "content": "",
                "error": True,
                "error_class": "ABORT",
                "stop_reason": "aborted",
                "error_message": "Run aborted by user.",
            })

        payload = json.loads(mock_set.call_args.args[1])
        self.assertEqual(payload["error_category"], "cancelled")

    def test_relay_done_reconciles_tracker_even_when_result_cache_write_fails(self):
        with patch(
            "django.core.cache.cache.set",
            side_effect=RuntimeError("redis unavailable"),
        ), patch(
            "apps.tracker.services.tracker_executor.complete_tracker_run_from_runtime_done",
        ) as complete_mock:
            _write_runtime_result_from_relay_done({
                "task_id": "prompt_cache_down",
                "content": "done despite redis",
                "error": False,
                "error_message": "",
            })

        complete_mock.assert_called_once()
        task_id, payload = complete_mock.call_args.args
        self.assertEqual(task_id, "prompt_cache_down")
        self.assertEqual(payload["content"], "done despite redis")

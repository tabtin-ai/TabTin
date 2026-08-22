from unittest.mock import patch

from django.test import SimpleTestCase


class AsyncLLMCallbackNoReplayTests(SimpleTestCase):
    @patch("apps.services.llm.tasks.llm_tasks._send_callback", side_effect=Exception("callback down"))
    @patch("apps.services.llm.tasks.llm_tasks._process_single_llm_request")
    def test_callback_failure_after_provider_result_does_not_replay_task(
        self,
        mock_process,
        mock_send_callback,
    ):
        from apps.services.llm.tasks.llm_tasks import process_llm_request_async

        mock_process.return_value = {
            "success": True,
            "request_id": "request-1",
            "content": "provider result",
        }

        result = process_llm_request_async.run(
            {"request_id": "request-1"},
            callback_url="https://callback.example.com/hook",
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["content"], "provider result")
        self.assertEqual(result["callback_status"], "failed")
        mock_process.assert_called_once()
        mock_send_callback.assert_called_once()

    @patch("apps.services.llm.tasks.llm_tasks._send_callback", return_value=False)
    @patch("apps.services.llm.tasks.llm_tasks._process_single_llm_request")
    def test_callback_final_failure_marks_result_without_replay(
        self,
        mock_process,
        mock_send_callback,
    ):
        from apps.services.llm.tasks.llm_tasks import process_llm_request_async

        mock_process.return_value = {
            "success": True,
            "request_id": "request-2",
            "content": "provider result",
        }

        result = process_llm_request_async.run(
            {"request_id": "request-2"},
            callback_url="https://callback.example.com/hook",
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["callback_status"], "failed")
        mock_process.assert_called_once()
        mock_send_callback.assert_called_once()

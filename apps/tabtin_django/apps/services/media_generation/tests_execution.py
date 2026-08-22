"""
#5364：媒体生成提交异步化 —— HTTP 立刻返回 task_id，Provider 调用在 Celery。
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, TestCase

from apps.services.media_generation.models import MediaTask
from apps.services.media_generation.services.base import SubmitResult
from apps.services.media_generation.tasks.execution import (
    _build_media_request,
    execute_media_generation,
)


class BuildMediaRequestTest(SimpleTestCase):
    def test_builds_request_from_task_parameters(self):
        task = SimpleNamespace(
            task_type="text2image",
            prompt="a cat",
            negative_prompt="",
            parameters={
                "size": "1024*1024",
                "n": 1,
                "seed": 42,
                "prompt_extend": True,
                "_llm_model_name": "doubao-seedream-5-0-pro-260628",
                "_llm_provider_name": "volcengine",
                "custom_flag": True,
            },
            input_resources={},
        )

        req = _build_media_request(task)

        self.assertEqual(req.model_name, "doubao-seedream-5-0-pro-260628")
        self.assertEqual(req.size, "1024*1024")
        self.assertEqual(req.seed, 42)
        self.assertEqual(req.extra_params.get("custom_flag"), True)
        self.assertNotIn("_llm_model_name", req.extra_params)

    @patch("apps.services.media_generation.billing.settle_image_task")
    @patch("apps.users.wallet.services.CreditsService.consume_credits")
    def test_image_callback_uses_unified_scene_settlement(
        self,
        legacy_consume,
        settle_image,
    ):
        from apps.services.media_generation.tasks.polling import _charge_media_task

        task = SimpleNamespace(
            task_type="text2image",
            user_id="user-1",
        )
        result = SimpleNamespace(status="succeeded", result_urls=[])

        _charge_media_task(task, result)

        settle_image.assert_called_once_with(task, result)
        legacy_consume.assert_not_called()


class ExecuteMediaGenerationTest(TestCase):
    def _create_task(self, **overrides):
        params = {
            "size": "1024*1024",
            "n": 1,
            "prompt_extend": True,
            "_llm_provider_name": "volcengine",
            "_llm_model_name": "doubao-seedream-4-0-250828",
        }
        params.update(overrides.pop("parameters", {}))
        return MediaTask.objects.create(
            task_type="text2image",
            user_id="user-5364",
            organization_id="org-5364",
            prompt="futuristic workspace",
            parameters=params,
            **overrides,
        )

    @patch("apps.services.media_generation.tasks.execution.complete_synchronous_media_task")
    @patch("apps.services.media_generation.services.get_media_service")
    def test_sync_provider_completes_without_blocking_caller_contract(
        self,
        mock_get_service,
        mock_complete,
    ):
        task = self._create_task()
        service = MagicMock()
        service.model_obj = SimpleNamespace(model_name="doubao-seedream-4-0-250828")
        service.submit_task_with_protection.return_value = SubmitResult(
            provider_task_id="ark-1",
            status="succeeded",
            metadata={"result_urls": ["https://ark.example.test/a.png"]},
        )
        mock_get_service.return_value = service

        execute_media_generation.run(str(task.id))

        mock_complete.assert_called_once()
        service.submit_task_with_protection.assert_called_once()

    @patch("apps.services.media_generation.tasks.polling.poll_media_task.apply_async")
    @patch("apps.services.media_generation.services.get_media_service")
    def test_async_provider_schedules_poll(self, mock_get_service, mock_poll):
        task = self._create_task()
        service = MagicMock()
        service.model_obj = SimpleNamespace(model_name="fal-ai/flux/dev")
        service.submit_task_with_protection.return_value = SubmitResult(
            provider_task_id="req-async-1",
            status="pending",
        )
        mock_get_service.return_value = service

        execute_media_generation.run(str(task.id))

        task.refresh_from_db()
        self.assertEqual(task.status, "running")
        self.assertEqual(task.provider_task_id, "req-async-1")
        mock_poll.assert_called_once()
        self.assertEqual(mock_poll.call_args.kwargs.get("countdown"), 10)

    @patch("apps.services.media_generation.services.get_media_service")
    def test_provider_error_marks_failed(self, mock_get_service):
        from apps.services.media_generation.errors import MediaErrorCode, MediaServiceError

        task = self._create_task()
        service = MagicMock()
        service.model_obj = SimpleNamespace(model_name="doubao-seedream-4-0-250828")
        service.submit_task_with_protection.side_effect = MediaServiceError(
            code=MediaErrorCode.API_ERROR,
            message="provider down",
            retryable=False,
        )
        mock_get_service.return_value = service

        execute_media_generation.run(str(task.id))

        task.refresh_from_db()
        self.assertEqual(task.status, "failed")
        self.assertEqual(task.error_code, MediaErrorCode.API_ERROR)


class GenerateImageEnqueueTest(TestCase):
    """API 必须在 Provider 返回前就把 task_id 交出去。"""

    @patch("apps.services.media_generation.api.execute_media_generation.delay")
    @patch("apps.services.media_generation.api.get_media_service")
    def test_generate_image_enqueues_without_calling_provider(self, mock_get_service, mock_delay):
        from apps.services.media_generation.api import generate_image
        from apps.services.media_generation.schemas import GenerateImageRequest

        service = MagicMock()
        service.provider_name = "volcengine"
        service.model_obj = SimpleNamespace(model_name="doubao-seedream-4-5-251128")
        service.submit_task_with_protection = MagicMock(
            side_effect=AssertionError("API 路径不应同步调用 Provider"),
        )
        mock_get_service.return_value = service

        request = SimpleNamespace(
            auth=SimpleNamespace(id="user-5364"),
            _billing_organization_id="org-5364",
            headers={
                "X-Tabtin-Session-Id": "session-5364",
                "X-Tabtin-Tool-Use-Id": "tool-use-5364",
                "X-Tabtin-Agent-Run-Id": "run-5364",
            },
        )
        payload = GenerateImageRequest(
            prompt="a futuristic dashboard",
            organization_id="org-5364",
            size="1024*1024",
        )

        # 绕过 billing_required，只验提交契约
        response = generate_image.__wrapped__(request, payload)

        self.assertTrue(response.success)
        self.assertTrue(response.task_id)
        self.assertEqual(response.status, "pending")
        mock_delay.assert_called_once_with(response.task_id)
        mock_get_service.assert_called_once_with(
            model_id=None,
            model_name=None,
            task_type="text2image",
            scene_key="media_image_generate",
        )
        service.submit_task_with_protection.assert_not_called()

        task = MediaTask.objects.get(id=response.task_id)
        self.assertEqual(task.status, "pending")
        self.assertEqual(task.parameters.get("_llm_model_name"), "doubao-seedream-4-5-251128")
        self.assertEqual(task.source_session_id, "session-5364")
        self.assertEqual(task.source_tool_use_id, "tool-use-5364")
        self.assertEqual(task.source_agent_run_id, "run-5364")
        self.assertEqual(task.artifact_delivery_status, "pending")


class MediaModelCatalogTest(SimpleTestCase):
    @patch("apps.services.media_generation.api.get_available_models", return_value=[])
    def test_image_catalog_is_scoped_to_admin_scene_binding(self, mock_get_models):
        from apps.services.media_generation.api import model_catalog

        response = model_catalog(
            SimpleNamespace(auth=SimpleNamespace(id="user-catalog")),
            task_type="text2image",
        )

        self.assertTrue(response.success)
        mock_get_models.assert_called_once_with(
            task_type="text2image",
            user_id="user-catalog",
            scene_key="media_image_generate",
        )

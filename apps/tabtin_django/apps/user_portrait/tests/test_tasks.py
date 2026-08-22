from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from celery.exceptions import MaxRetriesExceededError, Retry
from django.test import SimpleTestCase

from apps.user_portrait.error_codes import ErrorCode, ServiceError
from apps.user_portrait.tasks import distill_portrait_task
from apps.user_portrait.user_messages import DistillFailureKind


class _ExistingAgentQuery:
    @staticmethod
    def exists() -> bool:
        return True


class _AgentManager:
    @staticmethod
    def filter(**_kwargs):
        return _ExistingAgentQuery()


class _AgentModel:
    objects = _AgentManager()


class _UserManager:
    user = SimpleNamespace(id="user-1")

    @classmethod
    def get(cls, **_kwargs):
        return cls.user


class _UserModel:
    class DoesNotExist(Exception):
        pass

    objects = _UserManager()


class DistillPortraitTaskRetryTests(SimpleTestCase):
    def _run_task(self, *, service, retries: int, retry_side_effect):
        distill_portrait_task.push_request(id="task-1", retries=retries)
        try:
            with (
                patch(
                    "django.contrib.auth.get_user_model",
                    return_value=_UserModel,
                ),
                patch(
                    "django.apps.apps.get_model",
                    return_value=_AgentModel,
                ),
                patch(
                    "apps.tabmemo.services.record_style_service.resolve_record_preference",
                    return_value=(True, None),
                ),
                patch(
                    "apps.agent_memory.workspace_memory_execution."
                    "resolve_workspace_memory_worker",
                    return_value=SimpleNamespace(
                        enabled=True,
                        selected_model_id="00000000-0000-4000-8000-000000000501",
                    ),
                ),
                patch(
                    "apps.user_portrait.services.distill_service.PortraitDistillService",
                    return_value=service,
                ),
                patch.object(
                    distill_portrait_task,
                    "retry",
                    side_effect=retry_side_effect,
                ),
            ):
                result = distill_portrait_task.run(
                    user_id="user-1",
                    organization_id="organization-1",
                    agent_id="agent-1",
                    reason="manual",
                    selected_model_id="00000000-0000-4000-8000-000000000501",
                )
        finally:
            distill_portrait_task.pop_request()
        return result

    def test_first_attempt_keeps_pending_before_retry(self):
        service = MagicMock()
        service.run.side_effect = ServiceError(
            ErrorCode.DISTILL_FAILED,
            "模型上游暂时不可用",
            500,
            data={"background_retryable": True},
        )
        with self.assertRaises(Retry):
            self._run_task(
                service=service,
                retries=0,
                retry_side_effect=Retry(),
            )

        service.run.assert_called_once()
        kwargs = service.run.call_args.kwargs
        self.assertEqual(kwargs["trigger_reason"], "manual")
        self.assertFalse(kwargs["resume_pending"])
        self.assertFalse(kwargs["mark_failed_on_error"])
        self.assertTrue(kwargs["invocation_context"].stable_invocation)
        self.assertEqual(kwargs["invocation_context"].task_id, "task-1")
        self.assertEqual(
            kwargs["selected_model_id"],
            "00000000-0000-4000-8000-000000000501",
        )

    def test_final_attempt_resumes_pending_and_allows_terminal_failure(self):
        service = MagicMock()
        service.run.side_effect = ServiceError(
            ErrorCode.DISTILL_FAILED,
            "模型上游暂时不可用",
            500,
            data={"background_retryable": True},
        )
        result = self._run_task(
            service=service,
            retries=1,
            retry_side_effect=MaxRetriesExceededError(),
        )

        service.run.assert_called_once()
        kwargs = service.run.call_args.kwargs
        self.assertEqual(kwargs["trigger_reason"], "manual")
        self.assertTrue(kwargs["resume_pending"])
        self.assertTrue(kwargs["mark_failed_on_error"])
        self.assertEqual(
            kwargs["invocation_context"].invocation_id,
            "user_portrait_distill:user-1:organization-1:agent-1:revision-2:v1",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "max_retries_exceeded")

    def test_invalid_provider_result_is_not_retried(self):
        service = MagicMock()
        service.run.side_effect = ServiceError(
            ErrorCode.DISTILL_FAILED,
            "模型返回内容不完整",
            500,
            data={"kind": DistillFailureKind.INCOMPLETE_OUTPUT},
        )

        result = self._run_task(
            service=service,
            retries=0,
            retry_side_effect=AssertionError("permanent validation error retried"),
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "non_retryable_service_error")

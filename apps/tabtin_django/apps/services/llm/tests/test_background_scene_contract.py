from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase


class BackgroundSceneInvocationContractTests(SimpleTestCase):
    def test_selected_model_is_bound_to_stable_business_invocation(self):
        from apps.services.llm.services._runtime.background_invocation import (
            build_background_scene_invocation,
        )

        invocation = build_background_scene_invocation(
            scene_key="memory_capture",
            business_identity="thread-1:10:20:agent-1",
            organization_id="org-1",
            user_id="user-1",
            selected_model_id="model-byok",
            business_object_type="memory_capture_window",
            business_object_id="thread-1:10:20:agent-1",
            task_id="celery-1",
            retry_source="celery",
        )

        self.assertEqual(
            invocation.invocation_id,
            "memory_capture:thread-1:10:20:agent-1:v1",
        )
        self.assertEqual(invocation.selected_model_id, "model-byok")
        self.assertTrue(invocation.stable_invocation)

    def test_same_invocation_cannot_execute_with_a_different_model(self):
        from apps.services.llm.services._runtime.background_invocation import (
            build_background_scene_invocation,
        )
        from apps.services.llm.services._runtime.invocation import (
            prepare_scene_invocation,
        )

        invocation = build_background_scene_invocation(
            scene_key="task_summary",
            business_identity="thread-1",
            organization_id="org-1",
            user_id="user-1",
            selected_model_id="model-A",
        )

        with self.assertRaisesRegex(ValueError, "selected_model_id"):
            prepare_scene_invocation(
                scene_key="task_summary",
                organization_id="org-1",
                user_id="user-1",
                selected_model_id="model-B",
                invocation_context=invocation,
            )


class BackgroundRetryClassificationTests(SimpleTestCase):
    def test_only_transient_provider_failures_are_retryable(self):
        from apps.services.llm.scenes.exceptions import (
            BYOKCapabilityMismatch,
            BYOKCredentialMissing,
            BYOKProviderRateLimited,
            BYOKProviderUnavailable,
        )
        from apps.services.llm.services._runtime.background_invocation import (
            is_retryable_background_error,
        )

        self.assertTrue(is_retryable_background_error(BYOKProviderRateLimited()))
        self.assertTrue(is_retryable_background_error(BYOKProviderUnavailable()))
        self.assertTrue(is_retryable_background_error(TimeoutError()))
        self.assertFalse(is_retryable_background_error(BYOKCredentialMissing()))
        self.assertFalse(is_retryable_background_error(BYOKCapabilityMismatch()))


class MemoryCaptureIdentityTests(SimpleTestCase):
    def test_distinct_capture_windows_get_distinct_invocations(self):
        from apps.services.agent_engine.tasks.memory.capture import (
            build_memory_capture_event_id,
        )

        first = build_memory_capture_event_id(
            thread_id="thread-1",
            start_index=0,
            end_index=10,
            agent_id="agent-1",
        )
        retry = build_memory_capture_event_id(
            thread_id="thread-1",
            start_index=0,
            end_index=10,
            agent_id="agent-1",
        )
        next_window = build_memory_capture_event_id(
            thread_id="thread-1",
            start_index=10,
            end_index=20,
            agent_id="agent-1",
        )

        self.assertEqual(first, retry)
        self.assertNotEqual(first, next_window)


class BackgroundResultValidatorTests(SimpleTestCase):
    def test_diary_business_parser_runs_before_settlement(self):
        from apps.services.agent_engine.tasks.memory.daily_diary import (
            validate_diary_result,
        )

        with self.assertRaises(ValueError):
            validate_diary_result('{"diary":"too short"}')
        validate_diary_result(
            '{"diary":"今天完成了一个足够完整的工作总结，并记录了关键决策和后续行动。"}'
        )

    def test_compaction_business_parser_runs_before_settlement(self):
        from apps.services.agent_engine.tasks.memory.compaction import (
            validate_memory_compaction_result,
        )

        with self.assertRaises(ValueError):
            validate_memory_compaction_result("{}")
        validate_memory_compaction_result('{"content":"merged memory"}')

    def test_portrait_five_section_validator_is_given_to_scene_runtime(self):
        from apps.services.llm.services._runtime.background_invocation import (
            build_background_scene_invocation,
        )
        from apps.user_portrait.services.distill_service import (
            DistillInput,
            PortraitDistillService,
        )
        from apps.user_portrait.error_codes import ServiceError

        service = PortraitDistillService.__new__(PortraitDistillService)
        service.user = SimpleNamespace(id="user-1")
        service.organization_id = "org-1"
        distill_input = DistillInput(
            user_display_name="User",
            organization_name="Org",
            previous_portrait_md="",
            memos_for_prompt=[],
            hints=[],
            memo_count=0,
            truncated_memos=0,
        )
        invocation = build_background_scene_invocation(
            scene_key="user_portrait_distill",
            business_identity="user-1:org-1:agent-1:revision-2",
            organization_id="org-1",
            user_id="user-1",
        )

        def provider_boundary(**kwargs):
            kwargs["result_validator"]("incomplete portrait")

        with patch(
            "apps.services.llm.services.chat.unified_llm_call",
            side_effect=provider_boundary,
        ):
            with self.assertRaises(ServiceError):
                service.call_llm(
                    distill_input,
                    invocation_context=invocation,
                )

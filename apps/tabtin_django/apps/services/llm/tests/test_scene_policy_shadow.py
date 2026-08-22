import builtins
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings


class ScenePolicyShadowComparatorTests(SimpleTestCase):
    def test_title_runtime_matches_platform_policy(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            ScenePayer,
            ScenePolicyResolver,
        )
        from apps.services.llm.scenes.shadow import (
            RuntimeScenePolicySnapshot,
            ScenePolicyShadowComparator,
            ShadowStatus,
        )

        comparison = ScenePolicyShadowComparator.compare(
            ScenePolicyResolver.resolve("title_generation"),
            RuntimeScenePolicySnapshot(
                payer=ScenePayer.PLATFORM,
                provider_scope="global",
                resolved_model="kimi-k2.6",
                billing_required=False,
                fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                execution_key="title_generation",
            ),
        )

        self.assertEqual(comparison.status, ShadowStatus.MATCH)
        self.assertEqual(comparison.drift_codes, ())

    def test_platform_scenes_match_policy_after_runtime_payer_cutover(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            ScenePayer,
            ScenePolicyResolver,
        )
        from apps.services.llm.scenes.shadow import (
            DriftCode,
            RuntimeScenePolicySnapshot,
            ScenePolicyShadowComparator,
        )

        for scene_key in (
            "checkpoint_intent_summary",
            "checkpoint_decision_summary",
            "tool_risk_classify",
        ):
            with self.subTest(scene_key=scene_key):
                comparison = ScenePolicyShadowComparator.compare(
                    ScenePolicyResolver.resolve(scene_key),
                    RuntimeScenePolicySnapshot(
                        payer=ScenePayer.PLATFORM,
                        provider_scope="global",
                        resolved_model="current-official-model",
                        billing_required=False,
                        fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                        execution_key=(
                            "checkpoint_summary"
                            if scene_key.startswith("checkpoint_")
                            else scene_key
                        ),
                    ),
                )

                self.assertNotIn(DriftCode.PAYER_DRIFT, comparison.drift_codes)
                self.assertEqual(comparison.drift_codes, ())

    def test_checkpoint_comparator_detects_legacy_execution_key_drift(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            ScenePayer,
            ScenePolicyResolver,
        )
        from apps.services.llm.scenes.shadow import (
            DriftCode,
            RuntimeScenePolicySnapshot,
            ScenePolicyShadowComparator,
        )

        comparison = ScenePolicyShadowComparator.compare(
            ScenePolicyResolver.resolve("checkpoint_intent_summary"),
            RuntimeScenePolicySnapshot(
                payer=ScenePayer.PLATFORM,
                provider_scope="global",
                resolved_model="current-official-model",
                billing_required=False,
                fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                execution_key="checkpoint_intent_summary",
            ),
        )

        self.assertIn(DriftCode.EXECUTION_DRIFT, comparison.drift_codes)

    def test_byok_selected_against_official_runtime_is_source_drift(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            ModelSource,
            ScenePayer,
            ScenePolicyResolver,
        )
        from apps.services.llm.scenes.shadow import (
            DriftCode,
            RuntimeScenePolicySnapshot,
            ScenePolicyShadowComparator,
        )

        comparison = ScenePolicyShadowComparator.compare(
            ScenePolicyResolver.resolve("summarization"),
            RuntimeScenePolicySnapshot(
                payer=ScenePayer.USER,
                provider_scope="global",
                resolved_model="current-official-model",
                billing_required=True,
                fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                execution_key="summarization",
                selected_model_source=ModelSource.BYOK,
            ),
        )

        self.assertIn(DriftCode.SOURCE_DRIFT, comparison.drift_codes)

    def test_selectable_scene_without_selected_source_reports_unknown(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            ScenePayer,
            ScenePolicyResolver,
        )
        from apps.services.llm.scenes.shadow import (
            DriftCode,
            RuntimeScenePolicySnapshot,
            ScenePolicyShadowComparator,
        )

        comparison = ScenePolicyShadowComparator.compare(
            ScenePolicyResolver.resolve("memory_capture"),
            RuntimeScenePolicySnapshot(
                payer=ScenePayer.USER,
                provider_scope="global",
                resolved_model="current-official-model",
                billing_required=True,
                fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                execution_key="memory_capture",
            ),
        )

        self.assertIn(DriftCode.UNKNOWN_RUNTIME_SOURCE, comparison.drift_codes)

    def test_enabled_image_runtime_has_no_policy_drift(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            ScenePayer,
            ScenePolicyResolver,
        )
        from apps.services.llm.scenes.shadow import (
            DriftCode,
            RuntimeScenePolicySnapshot,
            ScenePolicyShadowComparator,
        )

        comparison = ScenePolicyShadowComparator.compare(
            ScenePolicyResolver.resolve("media_image_generate"),
            RuntimeScenePolicySnapshot(
                payer=ScenePayer.USER,
                provider_scope="global",
                resolved_model="current-official-model",
                billing_required=True,
                fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                execution_key="media_image_generate",
            ),
        )

        self.assertNotIn(DriftCode.ENABLED_DRIFT, comparison.drift_codes)


class ScenePolicyShadowRecorderTests(SimpleTestCase):
    @override_settings(AI_SCENE_POLICY_SHADOW_ENABLED=False)
    def test_feature_flag_off_does_not_resolve_log_or_emit_metric(self):
        from apps.services.llm.scenes.policy import FallbackPolicy, ScenePayer
        from apps.services.llm.scenes.shadow import (
            RuntimeScenePolicySnapshot,
            resolve_and_record_scene_policy_shadow,
        )

        runtime = RuntimeScenePolicySnapshot(
            payer=ScenePayer.USER,
            provider_scope="global",
            resolved_model="current-official-model",
            billing_required=True,
            fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
            execution_key="summarization",
        )

        with (
            patch("apps.services.llm.scenes.shadow.ScenePolicyResolver.resolve") as resolver,
            patch("apps.services.llm.scenes.shadow.logger") as logger,
            patch("apps.services.llm.scenes.shadow._get_shadow_metric") as metric_factory,
        ):
            result = resolve_and_record_scene_policy_shadow(
                scene_key="summarization",
                runtime=runtime,
                request_id="request-1",
                organization_id="organization-1",
            )

        self.assertIsNone(result)
        resolver.assert_not_called()
        logger.info.assert_not_called()
        logger.warning.assert_not_called()
        metric_factory.assert_not_called()

    @override_settings(AI_SCENE_POLICY_SHADOW_ENABLED=True)
    def test_policy_resolution_failure_is_observed_without_escaping(self):
        from apps.services.llm.scenes.policy import FallbackPolicy, ScenePayer
        from apps.services.llm.scenes.shadow import (
            RuntimeScenePolicySnapshot,
            resolve_and_record_scene_policy_shadow,
        )

        runtime = RuntimeScenePolicySnapshot(
            payer=ScenePayer.USER,
            provider_scope="global",
            resolved_model="current-official-model",
            billing_required=True,
            fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
            execution_key="summarization",
        )

        with (
            patch(
                "apps.services.llm.scenes.shadow.ScenePolicyResolver.resolve",
                side_effect=RuntimeError("shadow-only failure"),
            ),
            patch("apps.services.llm.scenes.shadow.logger") as logger,
            patch("apps.services.llm.scenes.shadow._get_shadow_metric") as metric_factory,
        ):
            metric = metric_factory.return_value
            result = resolve_and_record_scene_policy_shadow(
                scene_key="summarization",
                runtime=runtime,
                request_id="request-1",
                organization_id="organization-1",
            )

        self.assertIsNone(result)
        logger.warning.assert_called_once()
        metric.labels.assert_called_once_with(
            scene="summarization",
            drift_type="POLICY_RESOLUTION_ERROR",
        )

    @override_settings(AI_SCENE_POLICY_SHADOW_ENABLED=True)
    def test_shadow_does_not_import_provider_billing_wallet_or_credentials(self):
        from apps.services.llm.scenes.policy import FallbackPolicy, ScenePayer
        from apps.services.llm.scenes.shadow import (
            RuntimeScenePolicySnapshot,
            resolve_and_record_scene_policy_shadow,
        )

        forbidden_prefixes = (
            "apps.services.billing",
            "apps.users.wallet",
            "apps.services.llm.services.factory",
            "apps.services.llm.models",
        )
        forbidden_imports: list[str] = []
        original_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name.startswith(forbidden_prefixes):
                forbidden_imports.append(name)
            return original_import(name, *args, **kwargs)

        with (
            patch("builtins.__import__", side_effect=guarded_import),
            patch("apps.services.llm.scenes.shadow._get_shadow_metric"),
            patch("apps.services.llm.scenes.shadow.logger"),
        ):
            resolve_and_record_scene_policy_shadow(
                scene_key="title_generation",
                runtime=RuntimeScenePolicySnapshot(
                    payer=ScenePayer.PLATFORM,
                    provider_scope="global",
                    resolved_model="current-official-model",
                    billing_required=False,
                    fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                    execution_key="title_generation",
                ),
                request_id="request-1",
                organization_id="organization-1",
            )

        self.assertEqual(forbidden_imports, [])

    @override_settings(AI_SCENE_POLICY_SHADOW_ENABLED=True)
    def test_structured_log_contains_only_sanitized_runtime_metadata(self):
        from apps.services.llm.scenes.policy import FallbackPolicy, ScenePayer
        from apps.services.llm.scenes.shadow import (
            RuntimeScenePolicySnapshot,
            resolve_and_record_scene_policy_shadow,
        )

        with (
            patch("apps.services.llm.scenes.shadow._get_shadow_metric"),
            patch("apps.services.llm.scenes.shadow.logger") as logger,
        ):
            resolve_and_record_scene_policy_shadow(
                scene_key="title_generation",
                runtime=RuntimeScenePolicySnapshot(
                    payer=ScenePayer.PLATFORM,
                    provider_scope="global",
                    resolved_model="current-official-model",
                    billing_required=False,
                    fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                    execution_key="title_generation",
                ),
                request_id="request-1",
                organization_id="organization-1",
                run_id="run-1",
                task_id="task-1",
            )

        extra = logger.info.call_args.kwargs["extra"]
        self.assertTrue({"scene_key", "policy_payer", "runtime_source", "drift_codes"} <= extra.keys())
        self.assertTrue(
            {
                "credential",
                "credential_secret",
                "api_key",
                "prompt",
                "content",
                "user_text",
                "file_body",
                "tool_arguments",
            }.isdisjoint(extra)
        )

    @override_settings(AI_SCENE_POLICY_SHADOW_ENABLED=True)
    def test_observability_failure_does_not_escape_shadow(self):
        from apps.services.llm.scenes.policy import FallbackPolicy, ScenePayer
        from apps.services.llm.scenes.shadow import (
            RuntimeScenePolicySnapshot,
            resolve_and_record_scene_policy_shadow,
        )

        with (
            patch(
                "apps.services.llm.scenes.shadow._get_shadow_metric",
                side_effect=RuntimeError("metric unavailable"),
            ),
            patch(
                "apps.services.llm.scenes.shadow.logger.warning",
                side_effect=RuntimeError("logger unavailable"),
            ),
        ):
            result = resolve_and_record_scene_policy_shadow(
                scene_key="title_generation",
                runtime=RuntimeScenePolicySnapshot(
                    payer=ScenePayer.PLATFORM,
                    provider_scope="global",
                    resolved_model="current-official-model",
                    billing_required=False,
                    fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                    execution_key="title_generation",
                ),
                request_id="request-1",
                organization_id="organization-1",
            )

        self.assertIsNone(result)


class ScenePolicyShadowHookTests(SimpleTestCase):
    @override_settings(AI_SCENE_POLICY_SHADOW_ENABLED=True)
    def test_chat_legacy_result_continues_when_shadow_resolution_fails(self):
        from apps.services.llm.scenes.policy import ScenePolicyResolver
        from apps.services.llm.services.chat import unified_llm_call

        runtime_policy = ScenePolicyResolver.resolve("summarization")
        model = SimpleNamespace(
            id="model-1",
            model_name="current-official-model",
            provider_id="provider-1",
            provider=SimpleNamespace(name="official-provider", scope="global"),
        )
        service = SimpleNamespace(
            chat=lambda **kwargs: {
                "success": True,
                "content": "legacy-result",
                "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
                "cost": {"input": "0.01", "output": "0.01", "total": "0.02"},
                "finish_reason": "stop",
            }
        )

        with (
            patch(
                "apps.services.llm.services._runtime.scene_call_context.build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(model, "global"),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.iter_ready_fallback_models",
                return_value=[],
            ),
            patch(
                "apps.services.llm.prompts.registry.PromptRegistry.render",
                return_value=SimpleNamespace(
                    system="system",
                    user="user",
                    default_params={"max_tokens": 20, "temperature": 0.1},
                    bundle=SimpleNamespace(version_hash="bundle-v1"),
                ),
            ),
            patch("apps.services.llm.services._runtime.billing_precheck.check_billing"),
            patch(
                "apps.services.llm.services.factory.get_llm_service",
                return_value=service,
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=SimpleNamespace(id="fact-1"),
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.mark_usage_result",
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact",
            ),
            patch("apps.services.llm.services._runtime.result_validator.validate_chat_result"),
            patch(
                "apps.services.llm.scenes.shadow.ScenePolicyResolver.resolve",
                side_effect=[
                    runtime_policy,
                    runtime_policy,
                    RuntimeError("shadow-only failure"),
                ],
            ) as resolver,
            patch("apps.services.llm.scenes.shadow.logger"),
        ):
            result = unified_llm_call(
                scene_key="summarization",
                variables={"messages": []},
                user_id="user-1",
                organization_id="organization-1",
                request_id="request-1",
            )

        self.assertEqual(result.content, "legacy-result")
        self.assertEqual(resolver.call_count, 3)
        resolver.assert_any_call("summarization")

    def test_chat_shadow_runs_before_existing_user_billing_block(self):
        from apps.services.llm.scenes.exceptions import BudgetExceeded
        from apps.services.llm.services.chat import unified_llm_call

        model = SimpleNamespace(
            id="model-1",
            model_name="current-official-model",
            provider_id="provider-1",
            provider=SimpleNamespace(name="official-provider", scope="global"),
        )

        with (
            patch(
                "apps.services.llm.services._runtime.scene_call_context.build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(model, "global"),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.iter_ready_fallback_models",
                return_value=[],
            ),
            patch(
                "apps.services.llm.prompts.registry.PromptRegistry.render",
                return_value=SimpleNamespace(
                    system="system",
                    user="user",
                    default_params={"max_tokens": 20, "temperature": 0.1},
                    bundle=SimpleNamespace(version_hash="bundle-v1"),
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.billing_precheck.check_billing",
                side_effect=BudgetExceeded("blocked"),
            ),
            patch(
                "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow"
            ) as shadow,
        ):
            with self.assertRaises(BudgetExceeded):
                unified_llm_call(
                    scene_key="summarization",
                    variables={},
                    user_id="user-1",
                    organization_id="organization-1",
                    request_id="request-1",
                )

        shadow.assert_called_once()

    def test_vision_entry_records_shadow_without_changing_result(self):
        from apps.services.llm.services.vision import parse

        model = SimpleNamespace(
            id="vision-model-1",
            model_name="vision-model",
            provider=SimpleNamespace(id="provider-1", provider_key="official", scope="global"),
        )
        service = SimpleNamespace(
            chat=lambda **kwargs: {
                "choices": [{"message": {"content": "parsed-result"}}],
                "usage": {},
                "cost": {},
            }
        )

        with (
            patch(
                "apps.services.llm.services._runtime.scene_call_context.build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(model, "global"),
            ),
            patch("apps.services.llm.services._runtime.billing_precheck.check_billing"),
            patch(
                "apps.services.llm.services.factory.get_llm_service",
                return_value=service,
            ),
            patch(
                "apps.services.llm.prompts.registry.PromptRegistry.render",
                return_value=SimpleNamespace(
                    user="parse this",
                    bundle=SimpleNamespace(version_hash="bundle-v1"),
                ),
            ),
            patch("apps.services.llm.services._runtime.result_validator.validate_vision_result"),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=SimpleNamespace(id="fact-1"),
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.mark_usage_result",
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact",
            ),
            patch(
                "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow"
            ) as shadow,
        ):
            result = parse(
                scene_key="vision_parse_document",
                image="https://example.test/image.png",
                variables={},
                user_id="user-1",
                organization_id="organization-1",
                request_id="request-1",
            )

        self.assertEqual(result.content, "parsed-result")
        shadow.assert_called_once()

    def test_speech_entry_records_shadow_without_changing_result(self):
        from apps.services.llm.services.speech import transcribe

        model = SimpleNamespace(
            id="asr-model-1",
            model_name="asr-model",
            provider=SimpleNamespace(id="provider-1", provider_key="official", scope="global"),
        )
        asr_service = SimpleNamespace(
            recognize=lambda **kwargs: SimpleNamespace(
                text="transcribed-result",
                duration_sec=1.5,
                language="zh",
            )
        )

        with (
            patch(
                "apps.services.llm.services._runtime.scene_call_context.build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(model, "global"),
            ),
            patch("apps.services.llm.services._runtime.billing_precheck.check_billing"),
            patch(
                "apps.services.speech.asr.factory.get_asr_service",
                return_value=asr_service,
            ),
            patch("apps.services.llm.services._runtime.result_validator.validate_transcribe_result"),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=SimpleNamespace(id="fact-1"),
            ),
            patch(
                "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow"
            ) as shadow,
        ):
            result = transcribe(
                scene_key="asr_recognize_flash",
                audio=b"audio",
                user_id="user-1",
                organization_id="organization-1",
                request_id="request-1",
            )

        self.assertEqual(result.text, "transcribed-result")
        shadow.assert_called_once()

    def test_media_stub_records_disabled_shadow_before_existing_failure(self):
        from apps.services.llm.scenes.exceptions import FeatureNotImplemented
        from apps.services.llm.services.media import image_service

        model = SimpleNamespace(
            id="image-model-1",
            model_name="image-model",
            provider=SimpleNamespace(id="provider-1", provider_key="official", scope="global"),
        )

        with (
            patch(
                "apps.services.llm.services._runtime.scene_call_context.build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(model, "global"),
            ),
            patch("apps.services.llm.services._runtime.billing_precheck.check_billing"),
            patch("apps.services.llm.services._runtime.usage_recorder.record_usage_fact"),
            patch(
                "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow"
            ) as shadow,
        ):
            with self.assertRaises(FeatureNotImplemented):
                image_service.generate(
                    scene_key="media_image_generate",
                    prompt="image prompt",
                    user_id="user-1",
                    organization_id="organization-1",
                    request_id="request-1",
                )

        shadow.assert_called_once()

    def test_media_shadow_runs_before_existing_billing_block(self):
        from apps.services.llm.scenes.exceptions import BudgetExceeded
        from apps.services.llm.services.media import image_service

        model = SimpleNamespace(
            id="image-model-1",
            model_name="image-model",
            provider=SimpleNamespace(id="provider-1", provider_key="official", scope="global"),
        )

        with (
            patch(
                "apps.services.llm.services._runtime.scene_call_context.build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(model, "global"),
            ),
            patch(
                "apps.services.llm.services._runtime.billing_precheck.check_billing",
                side_effect=BudgetExceeded("blocked"),
            ),
            patch(
                "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow"
            ) as shadow,
        ):
            with self.assertRaises(BudgetExceeded):
                image_service.generate(
                    scene_key="media_image_generate",
                    prompt="image prompt",
                    user_id="user-1",
                    organization_id="organization-1",
                    request_id="request-1",
                )

        shadow.assert_called_once()

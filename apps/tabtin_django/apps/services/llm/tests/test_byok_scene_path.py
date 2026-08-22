import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _model(*, scope: str, owner_id: str = "", domain: str = "chat"):
    provider = SimpleNamespace(
        id=f"provider-{scope}",
        name="openai",
        provider_key="openai",
        scope=scope,
        user_id=owner_id if scope == "user" else None,
        organization_id=owner_id if scope == "organization" else None,
        routing_enabled=True,
        runtime_status="healthy",
        capability_domains=[domain],
        encrypted_api_key="gAAAAencrypted",
        api_key="byok-secret",
    )
    return SimpleNamespace(
        id=f"model-{scope}",
        model_name="same-name-model",
        provider_id=provider.id,
        provider=provider,
        base_url="https://byok.example.test/v1",
        capability_domain=domain,
        capabilities_config={
            "supports_json_mode": True,
            "supports_vision": domain == "vision",
        },
        wave_status="ready",
        context_window_tokens=64_000,
        max_input_tokens_resolved=64_000,
        max_output_tokens_resolved=8_192,
        input_price_per_1k=0.1,
        output_price_per_1k=0.2,
        custom_billing_config={},
    )


def _success(content="BYOK result"):
    return {
        "success": True,
        "content": content,
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 3,
            "total_tokens": 13,
        },
        "cost": {"input": "0.01", "output": "0.02", "total": "0.03"},
        "finish_reason": "stop",
    }


def _call_exact_byok_scene(*, scene_key: str, scope: str):
    from apps.services.llm.services.chat import unified_llm_call

    user_id = "user-1"
    organization_id = "organization-1"
    owner_id = user_id if scope == "user" else organization_id
    model = _model(scope=scope, owner_id=owner_id)
    model.id = uuid.uuid4()
    model.pk = model.id
    provider_call = MagicMock(return_value=_success('{"content":"valid"}'))
    usage_fact = SimpleNamespace(id="fact-byok", save=MagicMock())
    model_manager = MagicMock()
    model_manager.select_related.return_value.get.return_value = model

    with (
        patch("apps.services.llm.models.LLMModel.objects", model_manager),
        patch(
            "apps.services.llm.services._runtime.scene_call_context."
            "build_scene_call_context",
            return_value=SimpleNamespace(
                scene_spec=SimpleNamespace(
                    capability_requirements={"min_context_tokens": 16_000}
                )
            ),
        ),
        patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model"
        ) as official_resolver,
        patch(
            "apps.services.llm.services._runtime.model_resolver."
            "iter_ready_fallback_models"
        ) as official_fallbacks,
        patch(
            "apps.services.llm.prompts.registry.PromptRegistry.render",
            return_value=SimpleNamespace(
                system="system",
                user="prompt",
                default_params={"max_tokens": 100},
                bundle=SimpleNamespace(version_hash="bundle-v1"),
            ),
        ),
        patch(
            "apps.services.llm.services._runtime.billing_precheck.check_billing"
        ) as billing_precheck,
        patch(
            "apps.services.llm.services.key_manager.select_provider_key",
            return_value=None,
        ),
        patch(
            "apps.services.llm.services.factory.LLMServiceFactory.create_service",
            return_value=SimpleNamespace(chat=provider_call),
        ),
        patch(
            "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
            return_value=usage_fact,
        ) as usage_recorder,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact"
        ) as settlement,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.mark_usage_result"
        ),
        patch(
            "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow"
        ),
    ):
        unified_llm_call(
            scene_key=scene_key,
            variables={},
            user_id=user_id,
            organization_id=organization_id,
            selected_model_id=str(model.id),
            result_validator=lambda _content: None,
        )

    return SimpleNamespace(
        model=model,
        provider_call=provider_call,
        official_resolver=official_resolver,
        official_fallbacks=official_fallbacks,
        billing_precheck=billing_precheck,
        usage_recorder=usage_recorder,
        settlement=settlement,
    )


class ExactByokChatPathTests(SimpleTestCase):
    def test_workspace_memory_user_byok_never_uses_billing_or_fallback(self):
        for scene_key in (
            "memory_capture",
            "task_summary",
            "diary_distill",
            "user_portrait_distill",
            "memory_compaction",
        ):
            with self.subTest(scene=scene_key):
                runtime = _call_exact_byok_scene(
                    scene_key=scene_key,
                    scope="user",
                )
                runtime.provider_call.assert_called_once()
                runtime.official_resolver.assert_not_called()
                runtime.official_fallbacks.assert_not_called()
                runtime.billing_precheck.assert_not_called()
                runtime.settlement.assert_not_called()
                usage = runtime.usage_recorder.call_args.kwargs
                self.assertEqual(usage["model_source"], "byok")
                self.assertEqual(usage["cost_status"], "byok_self_paid")

    def test_workspace_memory_organization_byok_is_exact_and_self_paid(self):
        for scene_key in (
            "memory_capture",
            "task_summary",
            "diary_distill",
            "user_portrait_distill",
            "memory_compaction",
        ):
            with self.subTest(scene=scene_key):
                runtime = _call_exact_byok_scene(
                    scene_key=scene_key,
                    scope="organization",
                )
                runtime.provider_call.assert_called_once()
                runtime.official_resolver.assert_not_called()
                runtime.billing_precheck.assert_not_called()
                runtime.settlement.assert_not_called()
                self.assertEqual(
                    runtime.usage_recorder.call_args.kwargs["model_id"],
                    str(runtime.model.id),
                )

    def test_user_byok_selected_uses_exact_model_without_official_or_funding(self):
        from apps.services.llm.services.chat import unified_llm_call

        model = _model(scope="user", owner_id="user-1")
        provider_call = MagicMock(return_value=_success())
        usage_fact = SimpleNamespace(id="fact-byok", save=MagicMock())
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.return_value = model

        with (
            patch("apps.services.llm.models.LLMModel.objects", model_manager),
            patch(
                "apps.services.llm.services._runtime.scene_call_context."
                "build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(
                        capability_requirements={
                            "min_context_tokens": 32_000,
                        }
                    )
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model"
            ) as official_resolver,
            patch(
                "apps.services.llm.services._runtime.model_resolver."
                "iter_ready_fallback_models"
            ) as official_fallbacks,
            patch(
                "apps.services.llm.prompts.registry.PromptRegistry.render",
                return_value=SimpleNamespace(
                    system="system",
                    user="prompt",
                    default_params={"max_tokens": 100},
                    bundle=SimpleNamespace(version_hash="bundle-v1"),
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.billing_precheck.check_billing"
            ) as billing_precheck,
            patch(
                "apps.services.llm.services.key_manager.select_provider_key",
                return_value=None,
            ),
            patch(
                "apps.services.llm.services.factory.LLMServiceFactory.create_service",
                return_value=SimpleNamespace(chat=provider_call),
            ) as service_factory,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=usage_fact,
            ) as usage_recorder,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.mark_usage_result"
            ) as result_marker,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact"
            ) as settlement,
            patch(
                "apps.services.llm.scenes.shadow."
                "resolve_and_record_scene_policy_shadow"
            ),
        ):
            result = unified_llm_call(
                scene_key="summarization",
                variables={"messages": []},
                user_id="user-1",
                organization_id="organization-1",
                selected_model_id=str(model.id),
            )

        self.assertEqual(result.content, "BYOK result")
        official_resolver.assert_not_called()
        official_fallbacks.assert_not_called()
        billing_precheck.assert_not_called()
        settlement.assert_not_called()
        provider_call.assert_called_once()
        service_factory.assert_called_once()
        usage = usage_recorder.call_args.kwargs
        self.assertEqual(usage["payer"], "user")
        self.assertEqual(usage["model_source"], "byok")
        self.assertEqual(usage["cost_status"], "byok_self_paid")
        self.assertEqual(usage["settlement_status"], "not_required")
        self.assertFalse(usage["settle"])
        result_marker.assert_called_once_with(usage_fact, result_status="valid")


class ExactByokResolverGuardTests(SimpleTestCase):
    def _resolve(self, model, *, user_id="user-1", organization_id="org-1", domain="chat"):
        from apps.services.llm.scenes.types import ScenePayer
        from apps.services.llm.services._runtime.byok_resolver import resolve_scene_execution

        manager = MagicMock()
        manager.select_related.return_value.get.return_value = model
        with patch("apps.services.llm.models.LLMModel.objects", manager):
            return resolve_scene_execution(
                scene_key="vision_parse_document" if domain == "vision" else "summarization",
                payer=ScenePayer.USER,
                selected_model_id=str(model.id),
                organization_id=organization_id,
                user_id=user_id,
                capability_domain=domain,
                capability_requirements={"requires_vision": domain == "vision"},
            )

    def test_user_and_organization_ownership_are_exact(self):
        user_execution = self._resolve(_model(scope="user", owner_id="user-1"))
        org_execution = self._resolve(
            _model(scope="organization", owner_id="org-1")
        )
        self.assertEqual(user_execution.provider_scope, "user")
        self.assertEqual(org_execution.provider_scope, "organization")
        self.assertTrue(user_execution.source_locked)
        self.assertTrue(org_execution.source_locked)

    def test_cross_user_and_cross_organization_are_denied(self):
        from apps.services.llm.scenes.exceptions import BYOKProviderScopeMismatch

        with self.assertRaises(BYOKProviderScopeMismatch):
            self._resolve(_model(scope="user", owner_id="user-B"))
        with self.assertRaises(BYOKProviderScopeMismatch):
            self._resolve(_model(scope="organization", owner_id="org-B"))

    def test_capability_mismatch_blocks_before_provider(self):
        from apps.services.llm.scenes.exceptions import BYOKCapabilityMismatch

        with self.assertRaises(BYOKCapabilityMismatch):
            self._resolve(_model(scope="user", owner_id="user-1"), domain="vision")

    def test_platform_scene_ignores_selected_byok_model(self):
        from apps.services.llm.scenes.types import ModelSource, ScenePayer
        from apps.services.llm.services._runtime.byok_resolver import resolve_scene_execution

        with patch("apps.services.llm.models.LLMModel.objects") as models:
            execution = resolve_scene_execution(
                scene_key="checkpoint_decision_summary",
                payer=ScenePayer.PLATFORM,
                selected_model_id="model-user",
                organization_id="org-1",
                user_id="user-1",
                capability_domain="chat",
                capability_requirements={},
            )
        self.assertEqual(execution.model_source, ModelSource.OFFICIAL)
        models.assert_not_called()

    def test_plaintext_and_decrypt_failure_are_distinct_fail_closed_errors(self):
        from apps.services.llm.models import LLMCredentialDecryptionError
        from apps.services.llm.scenes.exceptions import (
            BYOKCredentialDecryptFailed,
            BYOKCredentialInvalid,
        )
        from apps.services.llm.services._runtime.byok_resolver import (
            create_exact_byok_runtime,
        )

        execution = self._resolve(_model(scope="user", owner_id="user-1"))
        execution.model.provider.encrypted_api_key = "historical-plaintext"
        with patch("apps.services.llm.services.key_manager.select_provider_key", return_value=None):
            with self.assertRaises(BYOKCredentialInvalid):
                create_exact_byok_runtime(execution, invocation_id="inv-1", scene_key="summarization")

        class BrokenCredential:
            id = "key-1"
            provider_id = execution.model.provider.id
            encrypted_api_key = "gAAAAinvalid"

            @property
            def api_key(self):
                raise LLMCredentialDecryptionError("bad")

        with patch(
            "apps.services.llm.services.key_manager.select_provider_key",
            return_value=BrokenCredential(),
        ):
            with self.assertRaises(BYOKCredentialDecryptFailed):
                create_exact_byok_runtime(
                    execution, invocation_id="inv-1", scene_key="summarization"
                )

    def test_missing_credential_blocks_before_provider_creation(self):
        from apps.services.llm.scenes.exceptions import BYOKCredentialMissing
        from apps.services.llm.services._runtime.byok_resolver import create_exact_byok_runtime

        execution = self._resolve(_model(scope="user", owner_id="user-1"))
        execution.model.provider.encrypted_api_key = ""
        with (
            patch("apps.services.llm.services.key_manager.select_provider_key", return_value=None),
            patch("apps.services.llm.services.factory.LLMServiceFactory.create_service") as factory,
        ):
            with self.assertRaises(BYOKCredentialMissing):
                create_exact_byok_runtime(
                    execution, invocation_id="inv-1", scene_key="summarization"
                )
        factory.assert_not_called()

    def test_official_only_policy_denies_selected_byok(self):
        from apps.services.llm.scenes.exceptions import BYOKPolicyBlocked
        from apps.services.llm.scenes.types import (
            FallbackPolicy,
            ModelSource,
            ScenePayer,
        )
        from apps.services.llm.services._runtime.byok_resolver import resolve_scene_execution

        model = _model(scope="user", owner_id="user-1")
        manager = MagicMock()
        manager.select_related.return_value.get.return_value = model
        policy = SimpleNamespace(
            allowed_model_sources=(ModelSource.OFFICIAL,),
            fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
        )
        with (
            patch("apps.services.llm.scenes.policy.ScenePolicyResolver.resolve", return_value=policy),
            patch("apps.services.llm.models.LLMModel.objects", manager),
        ):
            with self.assertRaises(BYOKPolicyBlocked):
                resolve_scene_execution(
                    scene_key="official_only",
                    payer=ScenePayer.USER,
                    selected_model_id=str(model.id),
                    organization_id="org-1",
                    user_id="user-1",
                    capability_domain="chat",
                    capability_requirements={},
                )

    def test_provider_failures_have_structured_byok_taxonomy(self):
        from apps.services.llm.scenes.exceptions import (
            BYOKProviderAuthFailed,
            BYOKProviderRateLimited,
            BYOKProviderUnavailable,
        )
        from apps.services.llm.services._runtime.byok_resolver import map_byok_provider_error

        cases = (
            ({"status_code": 401}, BYOKProviderAuthFailed),
            ({"status_code": 429}, BYOKProviderRateLimited),
            ({"status_code": 500}, BYOKProviderUnavailable),
            (TimeoutError("timeout"), BYOKProviderUnavailable),
        )
        for error, expected in cases:
            with self.subTest(error=error):
                self.assertIsInstance(
                    map_byok_provider_error(error, scene_key="summarization"),
                    expected,
                )


class CredentialEncryptionSafetyTests(SimpleTestCase):
    def test_provider_and_key_never_fall_back_to_plaintext(self):
        from apps.services.llm.models import (
            LLMCredentialEncryptionError,
            LLMProvider,
            LLMProviderKey,
        )

        provider = LLMProvider(
            name="openai",
            provider_key="byok",
            display_name="BYOK",
            capability_domains=["chat"],
        )
        provider.encrypted_api_key = "gAAAAold"
        with patch.object(LLMProvider, "_get_fernet", side_effect=RuntimeError("no key")):
            with self.assertRaises(LLMCredentialEncryptionError):
                provider.api_key = "must-not-be-stored"
        self.assertEqual(provider.encrypted_api_key, "gAAAAold")

        key = LLMProviderKey(provider=provider, label="primary")
        key.encrypted_api_key = "gAAAAold-key"
        with patch.object(LLMProviderKey, "_get_fernet", side_effect=RuntimeError("no key")):
            with self.assertRaises(LLMCredentialEncryptionError):
                key.api_key = "must-not-be-stored"
        self.assertEqual(key.encrypted_api_key, "gAAAAold-key")


class SelectedModelPropagationTests(SimpleTestCase):
    def test_summarization_preserves_selected_model_and_validator(self):
        from apps.services.llm.services.summarization import SummarizationService

        with patch(
            "apps.services.llm.services.chat.unified_llm_call",
            return_value=SimpleNamespace(content="summary"),
        ) as call:
            result = SummarizationService(
                summary_model_id="model-byok",
                user_id="user-1",
                organization_id="org-1",
            ).summarize_messages([{"role": "user", "content": "hello"}])
        self.assertEqual(result, "summary")
        self.assertEqual(call.call_args.kwargs["selected_model_id"], "model-byok")
        with self.assertRaises(ValueError):
            call.call_args.kwargs["result_validator"]("")

    def test_task_summary_stable_invocation_keeps_model_reference(self):
        from apps.services.agent_engine.tasks.memory.task_summary import _generate_with_llm

        payload = '{"title":"done","outcome":"success"}'
        selected_model_id = "00000000-0000-4000-8000-000000000501"
        with (
            patch(
                "apps.agent_memory.workspace_memory_execution."
                "resolve_workspace_memory_worker",
                return_value=SimpleNamespace(
                    enabled=True,
                    selected_model_id=selected_model_id,
                ),
            ),
            patch(
                "apps.services.agent_engine.tasks.memory.task_summary._resolve_organization",
                return_value="org-1",
            ),
            patch(
                "apps.tabmemo.services.record_style_service.resolve_record_preference",
                return_value=(True, ""),
            ),
            patch(
                "apps.services.llm.services.chat.unified_llm_call",
                return_value=SimpleNamespace(content=payload),
            ) as call,
        ):
            result = _generate_with_llm(
                [{"role": "user", "content": "work"}],
                user_id="user-1",
                space_id="space-1",
                thread_id="thread-1",
                selected_model_id=selected_model_id,
            )
        self.assertEqual(result["title"], "done")
        kwargs = call.call_args.kwargs
        self.assertEqual(kwargs["selected_model_id"], selected_model_id)
        self.assertTrue(kwargs["invocation_context"].stable_invocation)

    def test_memory_capture_preserves_model_and_pre_settlement_validator(self):
        from apps.services.agent_engine.tasks.memory.capture import _extract_with_llm

        payload = '[{"content":"remember this","importance":5}]'
        with (
            patch(
                "apps.services.agent_engine.tasks.memory.capture.resolve_organization_id_from_space",
                return_value="org-1",
            ),
            patch(
                "apps.tabmemo.services.record_style_service.resolve_record_preference",
                return_value=(True, ""),
            ),
            patch(
                "apps.services.llm.services.chat.unified_llm_call",
                return_value=SimpleNamespace(content=payload),
            ) as call,
        ):
            result = _extract_with_llm(
                [{"role": "user", "content": "remember"}],
                user_id="user-1",
                space_id="space-1",
                selected_model_id="model-byok",
                thread_id="thread-1",
                capture_event_id="thread-1:0:1:agent-1",
            )
        self.assertEqual(result[0]["content"], "remember this")
        kwargs = call.call_args.kwargs
        self.assertEqual(kwargs["selected_model_id"], "model-byok")
        self.assertTrue(kwargs["invocation_context"].stable_invocation)
        with self.assertRaises(ValueError):
            kwargs["result_validator"]("{}")


class ExactByokVisionPathTests(SimpleTestCase):
    def test_vision_byok_uses_exact_capability_and_validator_without_billing(self):
        from apps.services.llm.services.vision import parse

        model = _model(scope="organization", owner_id="org-1", domain="vision")
        manager = MagicMock()
        manager.select_related.return_value.get.return_value = model
        fact = SimpleNamespace(id="vision-fact", save=MagicMock())
        response = {
            "content": {"blocks": [{"type": "paragraph", "content": "ok"}]},
            "usage": {"prompt_tokens": 20, "completion_tokens": 4},
            "cost": {"total": "0.04"},
        }

        with (
            patch("apps.services.llm.models.LLMModel.objects", manager),
            patch(
                "apps.services.llm.services._runtime.scene_call_context.build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(
                        capability_requirements={"requires_vision": True}
                    )
                ),
            ),
            patch("apps.services.llm.services._runtime.model_resolver.resolve_model") as official,
            patch(
                "apps.services.llm.prompts.registry.PromptRegistry.render",
                return_value=SimpleNamespace(
                    user="parse",
                    bundle=SimpleNamespace(version_hash="vision-v1"),
                ),
            ),
            patch("apps.services.llm.services.key_manager.select_provider_key", return_value=None),
            patch(
                "apps.services.llm.services.factory.LLMServiceFactory.create_service",
                return_value=SimpleNamespace(chat=MagicMock(return_value=response)),
            ),
            patch("apps.services.llm.services._runtime.billing_precheck.check_billing") as billing,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=fact,
            ) as usage,
            patch("apps.services.llm.services._runtime.usage_recorder.mark_usage_result") as mark,
            patch("apps.services.llm.services._runtime.usage_recorder.settle_usage_fact") as settle,
            patch("apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow"),
        ):
            result = parse(
                scene_key="vision_parse_document",
                image="data:image/png;base64,eA==",
                user_id="user-1",
                organization_id="org-1",
                response_format="json_object",
                selected_model_id=str(model.id),
            )

        self.assertEqual(result.content["blocks"][0]["content"], "ok")
        official.assert_not_called()
        billing.assert_not_called()
        settle.assert_not_called()
        self.assertEqual(usage.call_args.kwargs["model_source"], "byok")
        self.assertEqual(usage.call_args.kwargs["cost_status"], "byok_self_paid")
        self.assertEqual(usage.call_args.kwargs["settlement_status"], "not_required")
        mark.assert_called_once_with(fact, result_status="valid")

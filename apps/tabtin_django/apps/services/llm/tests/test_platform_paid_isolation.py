from decimal import Decimal
from contextlib import contextmanager
import json
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _model():
    return SimpleNamespace(
        id="model-official",
        model_name="official-model",
        provider_id="provider-official",
        provider=SimpleNamespace(name="official-provider", scope="global"),
    )


def _rendered_prompt():
    return SimpleNamespace(
        system="system instructions",
        user="summarize checkpoint",
        default_params={"max_tokens": 60, "temperature": 0.1},
        bundle=SimpleNamespace(version_hash="bundle-v1"),
    )


def _provider_success(content: str = "valid result") -> dict:
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


@contextmanager
def _chat_runtime(*, provider_result=None, provider_error=None, validation_error=None):
    model = _model()
    provider_call = MagicMock(
        return_value=provider_result or _provider_success(),
        side_effect=provider_error,
    )
    provider = SimpleNamespace(chat=provider_call)
    fact = SimpleNamespace(id="fact-platform")

    with (
        patch(
            "apps.services.llm.services._runtime.scene_call_context."
            "build_scene_call_context",
            return_value=SimpleNamespace(
                scene_spec=SimpleNamespace(capability_requirements={})
            ),
        ),
        patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
            return_value=(model, "global"),
        ) as model_resolver,
        patch(
            "apps.services.llm.services._runtime.model_resolver."
            "iter_ready_fallback_models",
            return_value=[],
        ) as fallback_models,
        patch(
            "apps.services.llm.prompts.registry.PromptRegistry.render",
            return_value=_rendered_prompt(),
        ),
        patch(
            "apps.services.llm.services._runtime.billing_precheck.check_billing",
        ) as billing_precheck,
        patch(
            "apps.services.llm.services.factory.get_llm_service",
            return_value=provider,
        ) as provider_factory,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
            return_value=fact,
        ) as usage_recorder,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.mark_usage_result",
        ) as result_marker,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact",
        ) as user_settlement,
        patch(
            "apps.services.llm.services._runtime.result_validator."
            "validate_chat_result",
            side_effect=validation_error,
        ) as generic_validator,
        patch(
            "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow",
        ) as policy_shadow,
    ):
        yield SimpleNamespace(
            fact=fact,
            model_resolver=model_resolver,
            fallback_models=fallback_models,
            billing_precheck=billing_precheck,
            provider_factory=provider_factory,
            provider_call=provider_call,
            usage_recorder=usage_recorder,
            result_marker=result_marker,
            user_settlement=user_settlement,
            generic_validator=generic_validator,
            policy_shadow=policy_shadow,
        )


class PlatformPaidIsolationTests(SimpleTestCase):
    def test_checkpoint_composite_records_one_stable_platform_cost_fact(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            CheckpointSummaryClaim,
            execute_checkpoint_summary,
        )
        from apps.services.llm.services.chat import unified_llm_call

        payload = {
            "intent_summary": "完成发布方案并核对风险",
            "decision_summary": {
                "outcome": "形成可执行的发布方案",
                "key_decisions": ["发布前必须完成风险检查"],
            },
            "unresolved_items": ["确认最终发布时间"],
        }
        claim = CheckpointSummaryClaim(
            status="claimed",
            checkpoint_id="checkpoint-1",
            invocation_id="checkpoint:checkpoint-1:summary:v1",
            organization_id="organization-1",
            user_id="user-1",
            checkpoint_context={
                "user_prompt": "完成发布方案",
                "impact": {"files": [], "resources": []},
                "decision_summary": {"outcome": "基础结果"},
            },
            agent_run_id="run-1",
        )
        store = SimpleNamespace(
            claim=MagicMock(return_value=claim),
            complete=MagicMock(
                return_value=SimpleNamespace(status="completed")
            ),
            fail=MagicMock(),
        )

        with _chat_runtime(
            provider_result=_provider_success(json.dumps(payload, ensure_ascii=False))
        ) as runtime:
            result = execute_checkpoint_summary(
                "checkpoint-1",
                store=store,
                llm_call=unified_llm_call,
            )

        self.assertEqual(result.status, "completed")
        runtime.provider_call.assert_called_once()
        runtime.usage_recorder.assert_called_once()
        usage = runtime.usage_recorder.call_args.kwargs
        self.assertEqual(usage["scene_key"], "checkpoint_decision_summary")
        self.assertEqual(usage["execution_key"], "checkpoint_summary")
        self.assertEqual(
            usage["invocation_id"],
            "checkpoint:checkpoint-1:summary:v1",
        )
        self.assertTrue(usage["stable_invocation"])
        self.assertEqual(usage["payer"], "platform")
        self.assertEqual(usage["model_source"], "official")
        self.assertEqual(usage["settlement_status"], "not_required")
        runtime.user_settlement.assert_not_called()
        runtime.policy_shadow.assert_called_once()
        shadow_runtime = runtime.policy_shadow.call_args.kwargs["runtime"]
        self.assertEqual(shadow_runtime.execution_key, "checkpoint_summary")
        self.assertEqual(shadow_runtime.payer.value, "platform")

    def test_all_four_platform_scenes_share_the_policy_driven_isolation_path(self):
        from apps.services.llm.services.chat import unified_llm_call

        for scene_key in (
            "title_generation",
            "checkpoint_intent_summary",
            "checkpoint_decision_summary",
            "tool_risk_classify",
        ):
            with self.subTest(scene_key=scene_key), _chat_runtime() as runtime:
                result = unified_llm_call(
                    scene_key=scene_key,
                    variables={},
                    user_id="user-with-no-entitlement",
                    organization_id="organization-with-zero-funding",
                )

            self.assertEqual(result.telemetry.effective_provider_scope, "global")
            self.assertEqual(result.telemetry.settlement_status, "not_required")
            runtime.billing_precheck.assert_not_called()
            runtime.fallback_models.assert_not_called()
            runtime.provider_call.assert_called_once()
            runtime.user_settlement.assert_not_called()
            usage = runtime.usage_recorder.call_args.kwargs
            self.assertEqual(usage["payer"], "platform")
            self.assertEqual(usage["model_source"], "official")
            self.assertEqual(usage["settlement_status"], "not_required")
            self.assertEqual(usage["cost_status"], "n_a")
            self.assertEqual(usage["total_cost"], Decimal("0.03"))
            self.assertFalse(usage["stable_invocation"])
            shadow_runtime = runtime.policy_shadow.call_args.kwargs["runtime"]
            self.assertEqual(shadow_runtime.payer.value, "platform")
            self.assertFalse(shadow_runtime.billing_required)

    def test_platform_provider_failure_records_attempt_without_user_settlement(self):
        from apps.services.llm.services.chat import unified_llm_call

        with _chat_runtime(provider_error=TimeoutError("provider timeout")) as runtime:
            with self.assertRaisesRegex(TimeoutError, "provider timeout"):
                unified_llm_call(
                    scene_key="tool_risk_classify",
                    variables={},
                    user_id="user-1",
                    organization_id="organization-1",
                )

        runtime.billing_precheck.assert_not_called()
        runtime.user_settlement.assert_not_called()
        usage = runtime.usage_recorder.call_args.kwargs
        self.assertEqual(usage["status"], "failed")
        self.assertEqual(usage["payer"], "platform")
        self.assertEqual(usage["settlement_status"], "not_required")

    def test_platform_provider_failure_result_records_attempt_without_user_settlement(self):
        from apps.services.llm.scenes.exceptions import SceneCallError
        from apps.services.llm.services.chat import unified_llm_call

        with _chat_runtime(
            provider_result={"success": False, "error": "upstream 503"}
        ) as runtime:
            with self.assertRaises(SceneCallError):
                unified_llm_call(
                    scene_key="checkpoint_intent_summary",
                    variables={},
                    user_id="user-1",
                    organization_id="organization-1",
                )

        runtime.user_settlement.assert_not_called()
        usage = runtime.usage_recorder.call_args.kwargs
        self.assertEqual(usage["status"], "failed")
        self.assertEqual(usage["settlement_status"], "not_required")

    def test_platform_invalid_result_stays_not_required_and_never_settles_user(self):
        from apps.services.llm.services.chat import unified_llm_call

        with _chat_runtime(validation_error=ValueError("invalid result")) as runtime:
            with self.assertRaisesRegex(ValueError, "invalid result"):
                unified_llm_call(
                    scene_key="checkpoint_decision_summary",
                    variables={},
                    user_id="user-1",
                    organization_id="organization-1",
                )

        runtime.billing_precheck.assert_not_called()
        runtime.user_settlement.assert_not_called()
        runtime.result_marker.assert_called_once_with(
            runtime.fact,
            result_status="invalid",
        )

    def test_blocked_user_billing_state_cannot_block_any_platform_scene(self):
        from apps.services.llm.scenes.exceptions import BudgetExceeded
        from apps.services.llm.services.chat import unified_llm_call

        for scene_key in (
            "title_generation",
            "checkpoint_intent_summary",
            "checkpoint_decision_summary",
            "tool_risk_classify",
        ):
            with self.subTest(scene_key=scene_key), _chat_runtime() as runtime:
                runtime.billing_precheck.side_effect = BudgetExceeded(
                    "wallet=0 budget=0 provider_credit=0 entitlement=none",
                    scene_key=scene_key,
                )
                result = unified_llm_call(
                    scene_key=scene_key,
                    variables={},
                    user_id="user-without-entitlement",
                    organization_id="organization-without-funding",
                )

            self.assertEqual(result.content, "valid result")
            runtime.billing_precheck.assert_not_called()
            runtime.provider_call.assert_called_once()

    def test_user_paid_chat_scenes_keep_precheck_and_settlement(self):
        from apps.services.llm.services.chat import unified_llm_call

        for scene_key in ("summarization", "memory_capture", "task_summary"):
            with self.subTest(scene_key=scene_key), _chat_runtime() as runtime:
                result = unified_llm_call(
                    scene_key=scene_key,
                    variables={},
                    user_id="user-1",
                    organization_id="organization-1",
                    request_id=f"request-{scene_key}",
                )

            self.assertEqual(result.telemetry.cost_status, "platform_paid")
            runtime.billing_precheck.assert_called_once()
            runtime.fallback_models.assert_called_once()
            runtime.user_settlement.assert_called_once()
            usage = runtime.usage_recorder.call_args.kwargs
            self.assertEqual(usage["payer"], "user")
            self.assertEqual(usage["settlement_status"], "pending")

    def test_managed_scene_missing_policy_fails_before_provider_or_billing(self):
        from apps.services.llm.scenes.policy import ScenePolicyMissingError
        from apps.services.llm.services.chat import unified_llm_call

        with (
            _chat_runtime() as runtime,
            patch(
                "apps.services.llm.scenes.policy.ScenePolicyResolver.resolve",
                side_effect=ScenePolicyMissingError("missing title policy"),
            ),
        ):
            with self.assertRaisesRegex(ScenePolicyMissingError, "missing title policy"):
                unified_llm_call(
                    scene_key="title_generation",
                    variables={},
                    user_id="user-1",
                    organization_id="organization-1",
                )

        runtime.billing_precheck.assert_not_called()
        runtime.provider_call.assert_not_called()

    def test_unmanaged_legacy_scene_remains_user_paid_when_policy_is_missing(self):
        from apps.services.llm.services.chat import unified_llm_call

        with _chat_runtime() as runtime:
            unified_llm_call(
                scene_key="memo_generation",
                variables={},
                user_id="user-1",
                organization_id="organization-1",
            )

        runtime.billing_precheck.assert_called_once()
        runtime.user_settlement.assert_called_once()
        self.assertEqual(runtime.usage_recorder.call_args.kwargs["payer"], "user")

    def test_invalid_runtime_payer_fails_before_provider_or_billing(self):
        from apps.services.llm.scenes.policy import ScenePolicyError
        from apps.services.llm.services.chat import unified_llm_call

        with (
            _chat_runtime() as runtime,
            patch(
                "apps.services.llm.scenes.policy.ScenePolicyResolver.resolve",
                return_value=SimpleNamespace(payer="platform"),
            ),
        ):
            with self.assertRaises(ScenePolicyError):
                unified_llm_call(
                    scene_key="title_generation",
                    variables={},
                    user_id="user-1",
                    organization_id="organization-1",
                )

        runtime.billing_precheck.assert_not_called()
        runtime.provider_call.assert_not_called()

    def test_platform_scenes_reject_byok_binding_before_credential_read(self):
        from apps.services.llm.scenes.exceptions import (
            SceneBindingViolatesByokBoundary,
        )
        from apps.services.llm.services._runtime.model_resolver import resolve_model

        class ByokProvider:
            scope = "organization"

            @property
            def api_key(self):
                raise AssertionError("BYOK credential must not be read")

        binding = SimpleNamespace(
            primary_model=SimpleNamespace(provider=ByokProvider()),
        )
        manager = MagicMock()
        manager.select_related.return_value.get.return_value = binding

        fake_binding_model = SimpleNamespace(
            objects=manager,
            DoesNotExist=type("DoesNotExist", (Exception,), {}),
        )
        fake_models = SimpleNamespace(LLMSceneBinding=fake_binding_model)

        with patch.dict(sys.modules, {"apps.services.llm.models": fake_models}):
            for scene_key in (
                "title_generation",
                "checkpoint_intent_summary",
                "checkpoint_decision_summary",
                "tool_risk_classify",
            ):
                with self.subTest(scene_key=scene_key):
                    with self.assertRaises(SceneBindingViolatesByokBoundary):
                        resolve_model(
                            scene_key=scene_key,
                            capability_domain="chat",
                            capability_requirements={},
                        )

from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import sys
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


class SettlementIdentityContractTests(SimpleTestCase):
    def test_stable_settlement_key_is_deterministic(self):
        from apps.services.llm.services._runtime.invocation import (
            SettlementIdempotencyKeyBuilder,
        )

        first = SettlementIdempotencyKeyBuilder.build(
            organization_id="org-1",
            execution_key="task_summary",
            invocation_id="task_summary:thread-1:v1",
        )
        second = SettlementIdempotencyKeyBuilder.build(
            organization_id="org-1",
            execution_key="task_summary",
            invocation_id="task_summary:thread-1:v1",
        )

        self.assertEqual(first, second)
        self.assertEqual(
            first,
            "ai-scene-settlement:v1:org-1:task_summary:task_summary:thread-1:v1",
        )

    def test_settlement_key_changes_with_invocation_or_organization(self):
        from apps.services.llm.services._runtime.invocation import (
            SettlementIdempotencyKeyBuilder,
        )

        baseline = SettlementIdempotencyKeyBuilder.build(
            organization_id="org-1",
            execution_key="task_summary",
            invocation_id="task_summary:thread-1:v1",
        )

        self.assertNotEqual(
            baseline,
            SettlementIdempotencyKeyBuilder.build(
                organization_id="org-1",
                execution_key="task_summary",
                invocation_id="task_summary:thread-2:v1",
            ),
        )
        self.assertNotEqual(
            baseline,
            SettlementIdempotencyKeyBuilder.build(
                organization_id="org-2",
                execution_key="task_summary",
                invocation_id="task_summary:thread-1:v1",
            ),
        )

    def test_settlement_key_rejects_values_that_exceed_billing_column(self):
        from apps.services.llm.services._runtime.invocation import (
            SettlementIdempotencyKeyBuilder,
        )

        with self.assertRaisesMessage(ValueError, "255"):
            SettlementIdempotencyKeyBuilder.build(
                organization_id="org-1",
                execution_key="task_summary",
                invocation_id="x" * 255,
            )

    def test_attempts_are_distinct_but_share_one_stable_settlement_identity(self):
        from apps.services.llm.services._runtime.invocation import (
            SceneInvocationContext,
        )

        invocation = SceneInvocationContext.stable(
            invocation_id="task_summary:thread-1:v1",
            scene_key="task_summary",
            execution_key="task_summary",
            organization_id="org-1",
            user_id="user-1",
            business_object_type="thread",
            business_object_id="thread-1",
        )

        first_attempt = invocation.start_attempt()
        second_attempt = invocation.start_attempt()

        self.assertNotEqual(first_attempt.attempt_id, second_attempt.attempt_id)
        self.assertEqual(
            first_attempt.settlement_identity,
            second_attempt.settlement_identity,
        )
        self.assertTrue(invocation.stable_invocation)

    def test_legacy_context_is_explicitly_unstable_and_uses_legacy_key(self):
        from apps.services.llm.services._runtime.invocation import (
            SceneInvocationContext,
        )

        invocation = SceneInvocationContext.legacy(
            scene_key="summarization",
            execution_key="summarization",
            organization_id="org-1",
            user_id="user-1",
        )
        attempt = invocation.start_attempt(request_id="request-legacy")

        self.assertFalse(invocation.stable_invocation)
        self.assertEqual(
            attempt.settlement_identity.idempotency_key,
            "llm_usage:request-legacy",
        )
        self.assertEqual(attempt.settlement_identity.version, "legacy_request_id")

    def test_blank_legacy_request_id_falls_back_to_attempt_identity(self):
        from apps.services.llm.services._runtime.invocation import SceneInvocationContext

        attempt = SceneInvocationContext.legacy(
            scene_key="summarization",
            execution_key="summarization",
            organization_id="org-1",
            user_id="user-1",
        ).start_attempt(request_id="   ")

        self.assertTrue(attempt.request_id)
        self.assertEqual(attempt.request_id, attempt.attempt_id)

    def test_legacy_preparation_emits_low_cardinality_metric(self):
        from apps.services.llm.services._runtime.invocation import prepare_scene_invocation

        invocation_metric = MagicMock()
        invocation_metric.labels.return_value = MagicMock()
        legacy_metric = MagicMock()
        legacy_metric.labels.return_value = MagicMock()
        fake_metrics = SimpleNamespace(
            ai_scene_invocation_total=invocation_metric,
            ai_scene_legacy_identity_total=legacy_metric,
        )

        with patch.dict(
            sys.modules,
            {"apps.services.llm.services.llm_metrics": fake_metrics},
        ):
            invocation = prepare_scene_invocation(
                scene_key="summarization",
                organization_id="org-1",
                user_id="user-1",
            )

        self.assertFalse(invocation.stable_invocation)
        invocation_metric.labels.assert_called_once_with(
            scene="summarization",
            stable="false",
        )
        legacy_metric.labels.assert_called_once_with(scene="summarization")


class UsageAttemptSettlementContractTests(SimpleTestCase):
    def _fact(self, attempt_id="attempt-1"):
        return SimpleNamespace(
            id="fact-1",
            request_id="request-attempt-1",
            invocation_id="task_summary:thread-1:v1",
            attempt_id=attempt_id,
            scene_key="task_summary",
            capability_domain="chat",
            cost_status="platform_paid",
            status="completed",
            organization_id="org-1",
            user_id="user-1",
            provider_id="provider-1",
            provider_key="openai",
            model_id="model-1",
            model_name="gpt-test",
            input_tokens=100,
            output_tokens=20,
            total_tokens=120,
            input_cost=Decimal("0.01"),
            output_cost=Decimal("0.02"),
            total_cost=Decimal("0.03"),
            duration_sec=0,
            asset_count=0,
            settlement_status="pending",
            settlement_key_version="v1",
            save=lambda **kwargs: None,
        )

    def _idempotent_gateway_module(self):
        state = SimpleNamespace(keys=set(), event_count=0, funding_consumption_count=0)
        lock = threading.Lock()

        def settle_llm_usage(**kwargs):
            with lock:
                key = kwargs["idempotency_key"]
                if key in state.keys:
                    return {"reason": "already_settled", "charge_mode": "idempotent"}
                state.keys.add(key)
                state.event_count += 1
                state.funding_consumption_count += 1
                return {"charge_mode": "wallet_charge"}

        gateway_module = SimpleNamespace(
            BillingGateway=SimpleNamespace(settle_llm_usage=settle_llm_usage),
        )
        return gateway_module, state

    def test_attempt_fact_can_be_recorded_without_settlement(self):
        from apps.services.llm.services._runtime.usage_recorder import record_usage_fact

        manager = SimpleNamespace(create=lambda **kwargs: SimpleNamespace(**kwargs, id="fact-1"))
        fake_models = SimpleNamespace(
            LLMUsageFact=SimpleNamespace(objects=manager),
        )
        with (
            patch.dict(sys.modules, {"apps.services.llm.models": fake_models}),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact"
            ) as mock_settle,
        ):
            fact = record_usage_fact(
                request_id="request-attempt-1",
                invocation_id="task_summary:thread-1:v1",
                attempt_id="attempt-1",
                stable_invocation=True,
                scene_key="task_summary",
                execution_key="task_summary",
                capability_domain="chat",
                effective_provider_scope="global",
                cost_status="platform_paid",
                status="completed",
                organization_id="org-1",
                user_id="user-1",
                settle=False,
            )

        self.assertEqual(fact.attempt_id, "attempt-1")
        self.assertEqual(fact.invocation_id, "task_summary:thread-1:v1")
        mock_settle.assert_not_called()

    def test_final_settlement_uses_stable_identity_instead_of_request_id(self):
        from apps.services.llm.services._runtime.invocation import SettlementIdentity
        from apps.services.llm.services._runtime.usage_recorder import settle_usage_fact

        fact = self._fact()
        identity = SettlementIdentity(
            idempotency_key=(
                "ai-scene-settlement:v1:org-1:task_summary:"
                "task_summary:thread-1:v1"
            ),
            version="v1",
            stable=True,
        )

        mock_settle = MagicMock(return_value={"charge_mode": "wallet_charge"})
        fake_gateway_module = SimpleNamespace(
            BillingGateway=SimpleNamespace(settle_llm_usage=mock_settle),
        )
        with patch.dict(
            sys.modules,
            {"apps.services.billing.services.gateway": fake_gateway_module},
        ):
            settle_usage_fact(fact=fact, settlement_identity=identity)

        self.assertEqual(
            mock_settle.call_args.kwargs["idempotency_key"],
            identity.idempotency_key,
        )
        self.assertNotEqual(
            mock_settle.call_args.kwargs["idempotency_key"],
            f"llm_usage:{fact.request_id}",
        )

    def test_persistence_retry_records_two_attempts_but_consumes_funding_once(self):
        from apps.services.llm.services._runtime.invocation import SettlementIdentity
        from apps.services.llm.services._runtime.usage_recorder import settle_usage_fact

        identity = SettlementIdentity(
            idempotency_key=(
                "ai-scene-settlement:v1:org-1:task_summary:"
                "task_summary:thread-1:v1"
            ),
            version="v1",
            stable=True,
        )
        first_attempt = self._fact("attempt-1")
        second_attempt = self._fact("attempt-2")
        gateway_module, state = self._idempotent_gateway_module()

        with patch.dict(
            sys.modules,
            {"apps.services.billing.services.gateway": gateway_module},
        ):
            settle_usage_fact(fact=first_attempt, settlement_identity=identity)
            try:
                raise RuntimeError("business persistence failed")
            except RuntimeError:
                pass
            settle_usage_fact(fact=second_attempt, settlement_identity=identity)

        self.assertNotEqual(first_attempt.attempt_id, second_attempt.attempt_id)
        self.assertEqual(state.event_count, 1)
        self.assertEqual(state.funding_consumption_count, 1)

    def test_concurrent_same_invocation_consumes_funding_once(self):
        from apps.services.llm.services._runtime.invocation import SettlementIdentity
        from apps.services.llm.services._runtime.usage_recorder import settle_usage_fact

        identity = SettlementIdentity(
            idempotency_key=(
                "ai-scene-settlement:v1:org-1:task_summary:"
                "task_summary:thread-1:v1"
            ),
            version="v1",
            stable=True,
        )
        facts = [self._fact("attempt-a"), self._fact("attempt-b")]
        gateway_module, state = self._idempotent_gateway_module()

        with patch.dict(
            sys.modules,
            {"apps.services.billing.services.gateway": gateway_module},
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                list(
                    executor.map(
                        lambda fact: settle_usage_fact(
                            fact=fact,
                            settlement_identity=identity,
                        ),
                        facts,
                    )
                )

        self.assertEqual(state.event_count, 1)
        self.assertEqual(state.funding_consumption_count, 1)


class UnifiedInvocationSettlementTests(SimpleTestCase):
    def _model(self):
        return SimpleNamespace(
            id="model-1",
            model_name="gpt-test",
            provider_id="provider-1",
            provider=SimpleNamespace(name="OpenAI"),
        )

    def _rendered(self):
        return SimpleNamespace(
            system="Summarize",
            user="conversation",
            default_params={"max_tokens": 100, "temperature": 0.1},
            bundle=SimpleNamespace(version_hash="bundle-v1"),
        )

    def _success_response(self):
        return {
            "success": True,
            "content": '{"title":"Done"}',
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "cost": {"input": "0.01", "output": "0.02", "total": "0.03"},
            "finish_reason": "stop",
        }

    def _stable_invocation(self):
        from apps.services.llm.services._runtime.invocation import SceneInvocationContext

        return SceneInvocationContext.stable(
            invocation_id="task_summary:thread-1:v1",
            scene_key="task_summary",
            execution_key="task_summary",
            organization_id="org-1",
            user_id="user-1",
            business_object_type="thread",
            business_object_id="thread-1",
            retry_source="celery",
        )

    def _runtime_patches(self, *, response, fact, validator=None):
        def provider_call(**kwargs):
            if isinstance(response, BaseException):
                raise response
            return response

        return (
            patch(
                "apps.services.llm.services._runtime.scene_call_context."
                "build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(self._model(), "global"),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver."
                "iter_ready_fallback_models",
                return_value=[],
            ),
            patch(
                "apps.services.llm.prompts.registry.PromptRegistry.render",
                return_value=self._rendered(),
            ),
            patch(
                "apps.services.llm.services._runtime.billing_precheck.check_billing"
            ),
            patch(
                "apps.services.llm.services.factory.get_llm_service",
                return_value=SimpleNamespace(chat=provider_call),
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=fact,
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.mark_usage_result"
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact"
            ),
            patch(
                "apps.services.llm.services._runtime.result_validator."
                "validate_chat_result",
                side_effect=validator,
            ),
        )

    def test_invalid_result_records_attempt_but_skips_final_settlement(self):
        from apps.services.llm.services.chat import unified_llm_call

        fact = SimpleNamespace(id="fact-1")
        patches = self._runtime_patches(
            response=self._success_response(),
            fact=fact,
            validator=ValueError("invalid task summary"),
        )

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], (
            patches[6]
        ) as mock_record, patches[7] as mock_mark, patches[8] as mock_settle, patches[9]:
            with self.assertRaisesMessage(ValueError, "invalid task summary"):
                unified_llm_call(
                    scene_key="task_summary",
                    variables={"conversation_text": "conversation"},
                    user_id="user-1",
                    organization_id="org-1",
                    invocation_context=self._stable_invocation(),
                )

        self.assertFalse(mock_record.call_args.kwargs["settle"])
        self.assertEqual(
            mock_record.call_args.kwargs["invocation_id"],
            "task_summary:thread-1:v1",
        )
        self.assertTrue(mock_record.call_args.kwargs["attempt_id"])
        mock_mark.assert_called_once_with(
            fact,
            result_status="invalid",
            settlement_status="skipped",
        )
        mock_settle.assert_not_called()

    def test_valid_result_settles_with_stable_identity_after_validation(self):
        from apps.services.llm.services.chat import unified_llm_call

        fact = SimpleNamespace(id="fact-1")
        events: list[str] = []
        patches = self._runtime_patches(response=self._success_response(), fact=fact)

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], (
            patches[6]
        ) as mock_record, patch(
            "apps.services.llm.services._runtime.usage_recorder.mark_usage_result",
            side_effect=lambda *args, **kwargs: events.append("result_valid"),
        ), patch(
            "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact",
            side_effect=lambda *args, **kwargs: events.append("settled"),
        ) as mock_settle, patch(
            "apps.services.llm.services._runtime.result_validator.validate_chat_result",
            side_effect=lambda **kwargs: events.append("validated"),
        ):
            mock_record.side_effect = lambda **kwargs: (events.append("attempt_recorded") or fact)
            result = unified_llm_call(
                scene_key="task_summary",
                variables={"conversation_text": "conversation"},
                user_id="user-1",
                organization_id="org-1",
                invocation_context=self._stable_invocation(),
            )

        self.assertEqual(result.content, '{"title":"Done"}')
        self.assertEqual(
            events,
            ["attempt_recorded", "validated", "result_valid", "settled"],
        )
        identity = mock_settle.call_args.kwargs["settlement_identity"]
        self.assertTrue(identity.stable)
        self.assertEqual(
            identity.idempotency_key,
            "ai-scene-settlement:v1:org-1:task_summary:task_summary:thread-1:v1",
        )

    def test_provider_failure_never_runs_final_settlement(self):
        from apps.services.llm.scenes.exceptions import SceneCallError
        from apps.services.llm.services.chat import unified_llm_call

        fact = SimpleNamespace(id="fact-failed")
        patches = self._runtime_patches(
            response={"success": False, "error": "timeout", "error_code": "TIMEOUT"},
            fact=fact,
        )

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], (
            patches[6]
        ) as mock_record, patches[7], patches[8] as mock_settle, patches[9]:
            with self.assertRaises(SceneCallError):
                unified_llm_call(
                    scene_key="task_summary",
                    variables={"conversation_text": "conversation"},
                    user_id="user-1",
                    organization_id="org-1",
                    invocation_context=self._stable_invocation(),
                )

        self.assertEqual(mock_record.call_args.kwargs["status"], "failed")
        mock_settle.assert_not_called()

    def test_provider_exception_records_failed_attempt_and_preserves_exception(self):
        from apps.services.llm.services.chat import unified_llm_call

        fact = SimpleNamespace(id="fact-failed")
        patches = self._runtime_patches(
            response=TimeoutError("provider timeout"),
            fact=fact,
        )

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], (
            patches[6]
        ) as mock_record, patches[7], patches[8] as mock_settle, patches[9]:
            with self.assertRaisesMessage(TimeoutError, "provider timeout"):
                unified_llm_call(
                    scene_key="task_summary",
                    variables={"conversation_text": "conversation"},
                    user_id="user-1",
                    organization_id="org-1",
                    invocation_context=self._stable_invocation(),
                )

        self.assertEqual(mock_record.call_args.kwargs["status"], "failed")
        self.assertEqual(mock_record.call_args.kwargs["error_code"], "TimeoutError")
        mock_settle.assert_not_called()

    def test_provider_retry_keeps_invocation_and_creates_new_attempt(self):
        from apps.services.llm.scenes.exceptions import SceneCallError
        from apps.services.llm.services.chat import unified_llm_call

        invocation = self._stable_invocation()
        failed_fact = SimpleNamespace(id="fact-failed")
        failed_patches = self._runtime_patches(
            response={"success": False, "error": "timeout", "error_code": "TIMEOUT"},
            fact=failed_fact,
        )
        with failed_patches[0], failed_patches[1], failed_patches[2], failed_patches[3], (
            failed_patches[4]
        ), failed_patches[5], failed_patches[6] as failed_record, failed_patches[7], (
            failed_patches[8]
        ) as failed_settle, failed_patches[9]:
            with self.assertRaises(SceneCallError):
                unified_llm_call(
                    scene_key="task_summary",
                    variables={"conversation_text": "conversation"},
                    user_id="user-1",
                    organization_id="org-1",
                    invocation_context=invocation,
                )

        success_fact = SimpleNamespace(id="fact-success")
        success_patches = self._runtime_patches(
            response=self._success_response(),
            fact=success_fact,
        )
        with success_patches[0], success_patches[1], success_patches[2], success_patches[3], (
            success_patches[4]
        ), success_patches[5], success_patches[6] as success_record, success_patches[7], (
            success_patches[8]
        ) as success_settle, success_patches[9]:
            unified_llm_call(
                scene_key="task_summary",
                variables={"conversation_text": "conversation"},
                user_id="user-1",
                organization_id="org-1",
                invocation_context=invocation,
            )

        self.assertEqual(
            failed_record.call_args.kwargs["invocation_id"],
            success_record.call_args.kwargs["invocation_id"],
        )
        self.assertNotEqual(
            failed_record.call_args.kwargs["attempt_id"],
            success_record.call_args.kwargs["attempt_id"],
        )
        failed_settle.assert_not_called()
        success_settle.assert_called_once()

    def test_legacy_caller_remains_operational_and_uses_legacy_identity(self):
        from apps.services.llm.services.chat import unified_llm_call

        fact = SimpleNamespace(id="fact-legacy")
        patches = self._runtime_patches(response=self._success_response(), fact=fact)

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], (
            patches[6]
        ), patches[7], patches[8] as mock_settle, patches[9]:
            result = unified_llm_call(
                scene_key="task_summary",
                variables={"conversation_text": "conversation"},
                user_id="user-1",
                organization_id="org-1",
                request_id="legacy-request-1",
            )

        self.assertEqual(result.content, '{"title":"Done"}')
        identity = mock_settle.call_args.kwargs["settlement_identity"]
        self.assertFalse(identity.stable)
        self.assertEqual(identity.idempotency_key, "llm_usage:legacy-request-1")

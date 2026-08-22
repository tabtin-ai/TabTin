import json
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase, override_settings


def _official_model(*, capability_domain="chat"):
    return SimpleNamespace(
        id=f"{capability_domain}-model-1",
        model_name=f"official-{capability_domain}-model",
        provider_id=f"{capability_domain}-provider-1",
        provider=SimpleNamespace(
            id=f"{capability_domain}-provider-1",
            name=f"official-{capability_domain}-provider",
            provider_key="official",
            scope="global",
        ),
    )


def _provider_success(content):
    return {
        "success": True,
        "content": content,
        "choices": [{"message": {"content": content}}],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 3,
            "total_tokens": 13,
        },
        "cost": {"input": "0.01", "output": "0.02", "total": "0.03"},
        "finish_reason": "stop",
    }


@contextmanager
def _chat_runtime(*, content="有效摘要", billing_error=None):
    model = _official_model()
    provider_call = MagicMock(return_value=_provider_success(content))
    fact = SimpleNamespace(
        id="fact-user-official",
        save=MagicMock(),
    )
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
        ) as resolve_model,
        patch(
            "apps.services.llm.services._runtime.model_resolver."
            "iter_ready_fallback_models",
            return_value=[],
        ),
        patch(
            "apps.services.llm.prompts.registry.PromptRegistry.render",
            return_value=SimpleNamespace(
                system="system",
                user="summarize",
                default_params={"max_tokens": 100, "temperature": 0.1},
                bundle=SimpleNamespace(version_hash="bundle-v1"),
            ),
        ),
        patch(
            "apps.services.llm.services._runtime.billing_precheck.check_billing",
            side_effect=billing_error,
        ) as billing_precheck,
        patch(
            "apps.services.llm.services.factory.get_llm_service",
            return_value=SimpleNamespace(chat=provider_call),
        ),
        patch(
            "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
            return_value=fact,
        ) as usage_recorder,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.mark_usage_result",
        ) as result_marker,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact",
        ) as settlement,
        patch(
            "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow",
        ) as shadow,
    ):
        yield SimpleNamespace(
            model=model,
            resolve_model=resolve_model,
            provider_call=provider_call,
            billing_precheck=billing_precheck,
            usage_recorder=usage_recorder,
            result_marker=result_marker,
            settlement=settlement,
            shadow=shadow,
        )


@contextmanager
def _vision_runtime(*, content, billing_error=None, model_error=None):
    model = _official_model(capability_domain="vision")
    provider_call = MagicMock(return_value=_provider_success(content))
    fact = SimpleNamespace(
        id="fact-vision-official",
        save=MagicMock(),
    )
    resolve_model = MagicMock(
        return_value=(model, "global"),
        side_effect=model_error,
    )
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
            resolve_model,
        ),
        patch(
            "apps.services.llm.prompts.registry.PromptRegistry.render",
            return_value=SimpleNamespace(
                user="parse this document",
                bundle=SimpleNamespace(version_hash="bundle-v1"),
            ),
        ),
        patch(
            "apps.services.llm.services._runtime.billing_precheck.check_billing",
            side_effect=billing_error,
        ) as billing_precheck,
        patch(
            "apps.services.llm.services.factory.get_llm_service",
            return_value=SimpleNamespace(chat=provider_call),
        ),
        patch(
            "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
            return_value=fact,
        ) as usage_recorder,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.mark_usage_result",
        ) as result_marker,
        patch(
            "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact",
        ) as settlement,
        patch(
            "apps.services.llm.scenes.shadow.resolve_and_record_scene_policy_shadow",
        ) as shadow,
    ):
        yield SimpleNamespace(
            model=model,
            resolve_model=resolve_model,
            provider_call=provider_call,
            billing_precheck=billing_precheck,
            usage_recorder=usage_recorder,
            result_marker=result_marker,
            settlement=settlement,
            shadow=shadow,
        )


class SummarizationUserOfficialPathTests(SimpleTestCase):
    def test_valid_summary_uses_one_official_precheck_and_settles_after_validation(self):
        from apps.services.llm.services.summarization import SummarizationService

        with _chat_runtime(content="有效摘要") as runtime:
            result = SummarizationService(
                user_id="user-1",
                organization_id="organization-1",
            ).summarize_messages(
                [{"role": "user", "content": "需要压缩的消息"}],
            )

        self.assertEqual(result, "有效摘要")
        runtime.billing_precheck.assert_called_once()
        runtime.provider_call.assert_called_once()
        runtime.settlement.assert_called_once()
        usage = runtime.usage_recorder.call_args.kwargs
        self.assertEqual(usage["payer"], "user")
        self.assertEqual(usage["model_source"], "official")
        self.assertEqual(usage["result_status"], "unknown")
        self.assertEqual(usage["settlement_status"], "pending")
        runtime.result_marker.assert_called_once_with(
            runtime.usage_recorder.return_value,
            result_status="valid",
        )
        runtime.shadow.assert_called_once()

    def test_empty_business_summary_falls_back_without_settlement(self):
        from apps.services.llm.services.summarization import SummarizationService

        with _chat_runtime(content="   ") as runtime:
            result = SummarizationService(
                user_id="user-1",
                organization_id="organization-1",
            ).summarize_messages(
                [{"role": "user", "content": "需要压缩的消息"}],
                existing_summary="旧摘要",
            )

        self.assertEqual(result, "旧摘要")
        runtime.provider_call.assert_called_once()
        runtime.result_marker.assert_called_once_with(
            runtime.usage_recorder.return_value,
            result_status="invalid",
            settlement_status="skipped",
        )
        runtime.settlement.assert_not_called()


    def test_billing_block_stops_provider_and_settlement(self):
        from apps.services.llm.scenes.exceptions import BudgetExceeded
        from apps.services.llm.services.summarization import SummarizationService

        with _chat_runtime(
            billing_error=BudgetExceeded("blocked", scene_key="summarization")
        ) as runtime:
            result = SummarizationService(
                user_id="user-1",
                organization_id="organization-1",
            ).summarize_messages(
                [{"role": "user", "content": "需要压缩的消息"}],
                existing_summary="旧摘要",
            )

        self.assertEqual(result, "旧摘要")
        runtime.provider_call.assert_not_called()
        runtime.usage_recorder.assert_not_called()
        runtime.settlement.assert_not_called()


class ExactOfficialSnapshotTests(SimpleTestCase):
    def test_selected_global_uuid_bypasses_changed_scene_binding(self):
        from apps.services.llm.services.chat import unified_llm_call

        selected_model_id = str(uuid4())
        with _chat_runtime(content='{"title":"done"}') as runtime:
            runtime.model.id = selected_model_id
            runtime.model.pk = selected_model_id
            runtime.model.base_url = "https://official.example.com/v1"
            runtime.model.capability_domain = "chat"
            runtime.model.context_window_tokens = 64_000
            runtime.model.capabilities_config = {"supports_json_mode": True}
            runtime.model.wave_status = "ready"
            runtime.model.provider.routing_enabled = True
            runtime.model.provider.runtime_status = "healthy"
            runtime.model.provider.capability_domains = ["chat"]
            model_manager = MagicMock()
            model_manager.select_related.return_value.get.return_value = runtime.model

            with patch(
                "apps.services.llm.models.LLMModel.objects",
                model_manager,
            ):
                unified_llm_call(
                    scene_key="diary_distill",
                    variables={
                        "date": "2026-08-12",
                        "summaries_text": "summary",
                        "record_preference": "",
                    },
                    user_id="user-1",
                    organization_id="organization-1",
                    selected_model_id=selected_model_id,
                    result_validator=lambda _content: None,
                )

        runtime.resolve_model.assert_not_called()
        runtime.provider_call.assert_called_once()
        runtime.billing_precheck.assert_called_once()
        runtime.settlement.assert_called_once()


class VisionUserOfficialPathTests(SimpleTestCase):
    VALID_DOCUMENT = json.dumps(
        {
            "blocks": [
                {
                    "type": "paragraph",
                    "content": "文档正文",
                    "bbox": [0, 0, 1000, 1000],
                }
            ]
        },
        ensure_ascii=False,
    )

    def test_valid_vision_uses_one_model_precheck_then_settles(self):
        from apps.services.llm.services.vision import parse

        with _vision_runtime(content=self.VALID_DOCUMENT) as runtime:
            result = parse(
                scene_key="vision_parse_document",
                image="https://example.test/document.png",
                user_id="user-1",
                organization_id="organization-1",
                response_format="json_object",
                request_id="vision-request-1",
            )

        self.assertIsInstance(result.content, dict)
        runtime.billing_precheck.assert_called_once()
        runtime.provider_call.assert_called_once()
        runtime.usage_recorder.assert_called_once()
        usage = runtime.usage_recorder.call_args.kwargs
        self.assertEqual(usage["payer"], "user")
        self.assertEqual(usage["model_source"], "official")
        self.assertEqual(usage["result_status"], "unknown")
        self.assertEqual(usage["settlement_status"], "pending")
        self.assertFalse(usage["settle"])
        runtime.result_marker.assert_called_once_with(
            runtime.usage_recorder.return_value,
            result_status="valid",
        )
        runtime.settlement.assert_called_once()
        runtime.shadow.assert_called_once()

    def test_invalid_vision_result_records_attempt_but_skips_settlement(self):
        from apps.services.llm.services.vision import parse

        with _vision_runtime(content="not-json") as runtime:
            with self.assertRaises(ValueError):
                parse(
                    scene_key="vision_parse_document",
                    image="https://example.test/document.png",
                    user_id="user-1",
                    organization_id="organization-1",
                    response_format="json_object",
                    request_id="vision-request-invalid",
                )

        runtime.provider_call.assert_called_once()
        runtime.usage_recorder.assert_called_once()
        runtime.result_marker.assert_called_once_with(
            runtime.usage_recorder.return_value,
            result_status="invalid",
            settlement_status="skipped",
        )
        runtime.settlement.assert_not_called()

    def test_empty_vision_blocks_skip_settlement_before_caller_retry(self):
        from apps.services.llm.services.vision import parse

        with _vision_runtime(content='{"blocks": []}') as runtime:
            with self.assertRaises(ValueError):
                parse(
                    scene_key="vision_parse_document",
                    image="https://example.test/document.png",
                    user_id="user-1",
                    organization_id="organization-1",
                    response_format="json_object",
                    request_id="vision-request-empty-blocks",
                )

        runtime.provider_call.assert_called_once()
        runtime.result_marker.assert_called_once_with(
            runtime.usage_recorder.return_value,
            result_status="invalid",
            settlement_status="skipped",
        )
        runtime.settlement.assert_not_called()

    def test_vision_billing_block_stops_provider_and_usage(self):
        from apps.services.llm.scenes.exceptions import BudgetExceeded
        from apps.services.llm.services.vision import parse

        with _vision_runtime(
            content=self.VALID_DOCUMENT,
            billing_error=BudgetExceeded(
                "blocked",
                scene_key="vision_parse_document",
            ),
        ) as runtime:
            with self.assertRaises(BudgetExceeded):
                parse(
                    scene_key="vision_parse_document",
                    image="https://example.test/document.png",
                    user_id="user-1",
                    organization_id="organization-1",
                    response_format="json_object",
                )

        runtime.provider_call.assert_not_called()
        runtime.usage_recorder.assert_not_called()
        runtime.settlement.assert_not_called()

    def test_capability_mismatch_stops_billing_provider_and_settlement(self):
        from apps.services.llm.scenes.exceptions import CapabilityMismatch
        from apps.services.llm.services.vision import parse

        with _vision_runtime(
            content=self.VALID_DOCUMENT,
            model_error=CapabilityMismatch(
                "vision unsupported",
                scene_key="vision_parse_document",
            ),
        ) as runtime:
            with self.assertRaises(CapabilityMismatch):
                parse(
                    scene_key="vision_parse_document",
                    image="https://example.test/document.png",
                    user_id="user-1",
                    organization_id="organization-1",
                    response_format="json_object",
                )

        runtime.billing_precheck.assert_not_called()
        runtime.provider_call.assert_not_called()
        runtime.settlement.assert_not_called()

    def test_stable_vision_context_is_preserved_in_attempt_usage(self):
        from apps.services.llm.services._runtime.invocation import (
            SceneInvocationContext,
        )
        from apps.services.llm.services.vision import parse

        invocation = SceneInvocationContext.stable(
            invocation_id="vision:document-page-1:v1",
            scene_key="vision_parse_document",
            execution_key="vision_parse_document",
            organization_id="organization-1",
            user_id="user-1",
            business_object_type="document_page",
            business_object_id="document-page-1",
        )
        with _vision_runtime(content=self.VALID_DOCUMENT) as runtime:
            result = parse(
                scene_key="vision_parse_document",
                image="https://example.test/document.png",
                user_id="user-1",
                organization_id="organization-1",
                response_format="json_object",
                invocation_context=invocation,
            )

        usage = runtime.usage_recorder.call_args.kwargs
        self.assertEqual(usage["invocation_id"], "vision:document-page-1:v1")
        self.assertTrue(usage["stable_invocation"])
        self.assertEqual(usage["business_object_type"], "document_page")
        self.assertEqual(result.telemetry.invocation_id, usage["invocation_id"])


class UserOfficialPrecheckObservabilityTests(SimpleTestCase):
    def _assert_funding_mode(self, *, enabled, expected_mode):
        from apps.services.llm.services._runtime.billing_precheck import (
            check_billing,
        )

        with (
            override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=enabled),
            patch(
                "apps.services.billing.services.billing_precheck.billing_precheck",
                return_value=SimpleNamespace(blocked=False),
            ),
            patch(
                "apps.services.billing.services.gateway."
                "BillingGateway.precheck_llm_usage",
                return_value={"allowed": True},
            ),
            patch(
                "apps.services.llm.services._runtime.billing_precheck.logger.info"
            ) as log_info,
        ):
            check_billing(
                organization_id="organization-1",
                user_id="user-1",
                scene_key="summarization",
                capability_domain="chat",
                estimated_tokens=100,
                model_id="model-1",
                context={
                    "request_id": "request-1",
                    "stable_invocation": True,
                },
            )

        event = log_info.call_args.kwargs["extra"]
        self.assertEqual(event["billing_precheck_status"], "allowed")
        self.assertEqual(event["funding_mode"], expected_mode)
        self.assertTrue(event["stable_invocation"])
        self.assertEqual(event["payer"], "user")
        self.assertEqual(event["model_source"], "official")

    def test_provider_credit_mode_is_explicit(self):
        self._assert_funding_mode(
            enabled=True,
            expected_mode="provider_credit_v1",
        )

    def test_legacy_budget_wallet_mode_is_explicit(self):
        self._assert_funding_mode(
            enabled=False,
            expected_mode="legacy_budget_wallet",
        )


@override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True)
class ExistingFundingOrderTests(SimpleTestCase):
    def _preview(self, *, grants, monthly_credits):
        from apps.services.billing.services.funding_allocator import (
            FundingAllocator,
        )

        grant_manager = MagicMock()
        ordered_grants = MagicMock()
        ordered_grants.__iter__.return_value = iter(grants)
        grant_manager.select_related.return_value.filter.return_value.filter.return_value.order_by.return_value = (
            ordered_grants
        )
        wallet_manager = MagicMock()
        wallet_manager.filter.return_value.values_list.return_value.first.return_value = (
            "wallet-1"
        )

        with (
            patch(
                "apps.services.billing.services.funding_allocator."
                "ProviderCreditGrant.objects",
                grant_manager,
            ),
            patch(
                "apps.services.billing.services.funding_allocator."
                "matches_provider_credit",
                return_value=True,
            ),
            patch(
                "apps.services.billing.services.funding_allocator."
                "OrganizationLlmBudgetService.get_remaining_quota_credits",
                return_value=monthly_credits,
            ) as monthly_budget,
            patch(
                "apps.services.billing.services.funding_allocator."
                "OrganizationLlmBudgetService.cycle_month",
                return_value=date(2026, 8, 1),
            ),
            patch(
                "apps.users.wallet.models.OrganizationWallet.objects",
                wallet_manager,
            ),
        ):
            allocations = FundingAllocator.preview_funding(
                organization="organization-1",
                provider_key="official-provider",
                model_id=str(uuid4()),
                required_credits=Decimal("100"),
                billing_context={"llm_billing_mode": "quota_then_paygo"},
            )

        return allocations, monthly_budget, wallet_manager

    def test_provider_credit_full_avoids_monthly_budget_and_wallet(self):
        grant = SimpleNamespace(
            id="grant-1",
            campaign_id="campaign-1",
            remaining_credits=Decimal("100"),
        )

        allocations, monthly_budget, wallet_manager = self._preview(
            grants=[grant],
            monthly_credits=Decimal("30"),
        )

        self.assertEqual(
            [allocation.source_type for allocation in allocations],
            ["provider_credit"],
        )
        monthly_budget.assert_not_called()
        wallet_manager.filter.assert_not_called()

    def test_partial_provider_credit_flows_to_monthly_then_wallet(self):
        grant = SimpleNamespace(
            id="grant-1",
            campaign_id="campaign-1",
            remaining_credits=Decimal("50"),
        )

        allocations, monthly_budget, wallet_manager = self._preview(
            grants=[grant],
            monthly_credits=Decimal("30"),
        )

        self.assertEqual(
            [allocation.source_type for allocation in allocations],
            ["provider_credit", "monthly_budget", "organization_wallet"],
        )
        self.assertEqual(
            [allocation.credits for allocation in allocations],
            [Decimal("50.0000"), Decimal("30.0000"), Decimal("20.0000")],
        )
        monthly_budget.assert_called_once()
        wallet_manager.filter.assert_called_once()

    def test_no_provider_credit_uses_monthly_then_wallet(self):
        allocations, monthly_budget, wallet_manager = self._preview(
            grants=[],
            monthly_credits=Decimal("30"),
        )

        self.assertEqual(
            [allocation.source_type for allocation in allocations],
            ["monthly_budget", "organization_wallet"],
        )
        self.assertEqual(
            [allocation.credits for allocation in allocations],
            [Decimal("30.0000"), Decimal("70.0000")],
        )
        monthly_budget.assert_called_once()
        wallet_manager.filter.assert_called_once()

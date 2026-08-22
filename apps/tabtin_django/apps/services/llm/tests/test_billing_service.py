from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase, TestCase, override_settings
from decimal import Decimal

from apps.services.billing.models import BillingUsageEvent
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.services.llm.services.billing import (
    charge_llm_usage,
    check_budget_before_request,
    check_budget_policy,
)
from apps.services.llm.services.proxy_service import ProxyContext, settle_and_charge
from apps.users.wallet.models import OrganizationWallet


class TestChargeLlmUsageService(SimpleTestCase):
    def test_charge_llm_usage_uses_default_biz_and_idempotency_key(self):
        user = SimpleNamespace(id="user_001")
        provider = SimpleNamespace(provider_key="openai", name="OpenAI", organization_id="ws_provider_001")
        model = SimpleNamespace(
            provider=provider,
            model_name="gpt-4o-mini",
            input_price_per_1k="0.0015",
            output_price_per_1k="0.0060",
        )

        with patch("apps.users.auth.models.User.objects.filter") as mock_filter, patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm"
        ) as mock_consume:
            mock_filter.return_value.first.return_value = user
            mock_consume.return_value = {"credits_consumed_precise": Decimal("0.0005")}

            ok = charge_llm_usage(
                user_id="user_001",
                organization_id="ws_001",
                model_instance=model,
                usage={"input_tokens": 120, "output_tokens": 45},
                request_id="req_001",
                source="llm_api",
            )

        self.assertTrue(ok)
        self.assertTrue(mock_consume.called)
        kwargs = mock_consume.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], "ws_001")
        self.assertEqual(kwargs["biz_id"], "llm_api:req_001")
        self.assertEqual(kwargs["idempotency_key"], "llm_api:req_001")

    def test_charge_llm_usage_supports_custom_biz_and_idempotency_key(self):
        user = SimpleNamespace(id="user_002")
        provider = SimpleNamespace(provider_key="openai", name="OpenAI", organization_id="ws_provider_002")
        model = SimpleNamespace(
            provider=provider,
            model_name="gpt-4o-mini",
            input_price_per_1k="0.0015",
            output_price_per_1k="0.0060",
        )

        with patch("apps.users.auth.models.User.objects.filter") as mock_filter, patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm"
        ) as mock_consume:
            mock_filter.return_value.first.return_value = user
            mock_consume.return_value = {"credits_consumed_precise": Decimal("0.0002")}

            ok = charge_llm_usage(
                user_id="user_002",
                organization_id="ws_002",
                model_instance=model,
                usage={"input_tokens": 80, "output_tokens": 20},
                request_id="req_002",
                source="orchestration_chat",
                biz_id="chat_session:sess_002",
                idempotency_key="sess_002:step_1",
            )

        self.assertTrue(ok)
        self.assertTrue(mock_consume.called)
        kwargs = mock_consume.call_args.kwargs
        self.assertEqual(kwargs["biz_id"], "chat_session:sess_002")
        self.assertEqual(kwargs["idempotency_key"], "sess_002:step_1")

    def test_charge_llm_usage_allows_missing_model_instance(self):
        user = SimpleNamespace(id="user_003")

        with patch("apps.users.auth.models.User.objects.filter") as mock_filter, patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm"
        ) as mock_consume:
            mock_filter.return_value.first.return_value = user
            mock_consume.return_value = {"credits_consumed_precise": Decimal("0.0000")}

            ok = charge_llm_usage(
                user_id="user_003",
                organization_id="ws_003",
                model_instance=None,
                usage={"input_tokens": 10, "output_tokens": 5},
                request_id="req_003",
                source="llm_api",
            )

        self.assertTrue(ok)
        kwargs = mock_consume.call_args.kwargs
        self.assertEqual(kwargs["model_config"]["organization_id"], "ws_003")
        self.assertEqual(kwargs["model_config"]["model_name"], "")

    @patch("apps.services.llm.services.billing.check_budget_policy", return_value=None)
    @patch("apps.services.billing.services.usage_service.BillingUsageService.record_event")
    @patch("apps.services.billing.ws_events.publish_billing_event")
    @patch("apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm")
    def test_charge_llm_usage_publishes_blocked_event_on_insufficient_organization_wallet(
        self,
        mock_consume,
        mock_publish,
        mock_record_event,
        _mock_budget_policy,
    ):
        from apps.users.wallet.exceptions import InsufficientCreditsError

        provider = SimpleNamespace(
            provider_key="openai",
            name="OpenAI",
            scope="global",
            organization_id="ws_provider_004",
        )
        model = SimpleNamespace(
            provider=provider,
            model_name="gpt-4o-mini",
            input_price_per_1k="1.0",
            output_price_per_1k="1.0",
            custom_billing_config={},
        )
        mock_consume.side_effect = InsufficientCreditsError(
            required=Decimal("3.0000"),
            current=Decimal("0.0000"),
        )

        result = charge_llm_usage(
            user_id="user_004",
            organization_id="ws_004",
            model_instance=model,
            usage={"input_tokens": 1000, "output_tokens": 200},
            request_id="req_004",
            source="llm_api",
        )

        self.assertIsNone(result)
        billing_blocked_calls = [
            call for call in mock_publish.call_args_list
            if len(call.args) >= 2 and call.args[1] == "billing_blocked"
        ]
        self.assertEqual(len(billing_blocked_calls), 1)
        self.assertEqual(billing_blocked_calls[0].args[0], "ws_004")
        self.assertEqual(
            billing_blocked_calls[0].args[2]["reason"],
            "organization_insufficient_credits",
        )

    def test_charge_llm_usage_does_not_double_count_cached_tokens_when_input_includes_cache(self):
        user = SimpleNamespace(id="user_004")
        provider = SimpleNamespace(provider_key="openai", name="OpenAI", organization_id="ws_provider_004")
        model = SimpleNamespace(
            provider=provider,
            model_name="gpt-4o",
            input_price_per_1k="1.0",
            output_price_per_1k="2.0",
            custom_billing_config={
                "cache_read_input_price_per_1k": "0.2",
                "cache_write_input_price_per_1k": "1.5",
            },
        )

        with patch("apps.users.auth.models.User.objects.filter") as mock_filter, patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm"
        ) as mock_consume:
            mock_filter.return_value.first.return_value = user
            mock_consume.return_value = {"credits_consumed_precise": Decimal("1.1000")}

            ok = charge_llm_usage(
                user_id="user_004",
                organization_id="ws_004",
                model_instance=model,
                usage={
                    "input_tokens": 1000,
                    "output_tokens": 100,
                    "cache_read_input_tokens": 800,
                    "cache_creation_input_tokens": 100,
                    "input_tokens_include_cache": True,
                },
                request_id="req_004",
                source="llm_api",
            )

        self.assertTrue(ok)
        kwargs = mock_consume.call_args.kwargs
        self.assertEqual(kwargs["input_tokens"], 1000)
        self.assertEqual(kwargs["output_tokens"], 100)
        self.assertEqual(kwargs["model_config"]["cache_read_input_tokens"], 800)
        self.assertEqual(kwargs["model_config"]["cache_write_input_tokens"], 100)
        self.assertEqual(
            Decimal(kwargs["model_config"]["input_price_per_1k"]).quantize(Decimal("0.0001")),
            Decimal("0.4100"),
        )


class TestChargeLlmUsageAttemptMetadata(TestCase):
    databases = {"default"}

    def setUp(self):
        self.organization_id = org_id_for("llm_billing_attempt_metadata")
        OrganizationWallet.objects.update_or_create(
            organization_id=self.organization_id,
            defaults={
                "credits": 100,
                "credits_precise": Decimal("100.0000"),
            },
        )
        self.model = self._make_model()

    @staticmethod
    def _make_model():
        provider = SimpleNamespace(
            id="provider-attempt",
            provider_key="openai",
            name="OpenAI",
            scope="global",
        )
        return SimpleNamespace(
            id="model-attempt",
            provider=provider,
            provider_id="provider-attempt",
            model_name="gpt-4o-mini",
            input_price_per_1k="0.01",
            output_price_per_1k="0",
            custom_billing_config={},
        )

    def _charge(self, *, attempt_key: str, logical_key: str = "", attempt_index=None):
        return charge_llm_usage(
            user_id="user-attempt",
            organization_id=self.organization_id,
            model_instance=self.model,
            usage={"input_tokens": 1000, "output_tokens": 0},
            request_id=f"req-{attempt_key}",
            source="_main_chat",
            biz_id=attempt_key,
            idempotency_key=attempt_key,
            logical_billing_key=logical_key,
            attempt_index=attempt_index,
            usage_source="provider_final",
        )

    def test_same_logical_key_different_attempt_keys_create_two_events(self):
        logical_key = "agent-turn:scope:_main_chat:0"

        self._charge(
            attempt_key=f"{logical_key}:attempt:0",
            logical_key=logical_key,
            attempt_index=0,
        )
        self._charge(
            attempt_key=f"{logical_key}:attempt:1",
            logical_key=logical_key,
            attempt_index=1,
        )

        events = BillingUsageEvent.objects.filter(
            logical_billing_key=logical_key,
        ).order_by("attempt_index")
        self.assertEqual(events.count(), 2)
        self.assertEqual(events[0].idempotency_key, f"{logical_key}:attempt:0")
        self.assertEqual(events[0].attempt_index, 0)
        self.assertEqual(events[1].idempotency_key, f"{logical_key}:attempt:1")
        self.assertEqual(events[1].attempt_index, 1)
        self.assertEqual({event.usage_source for event in events}, {"provider_final"})

    def test_provider_final_usage_charges_positive_amount(self):
        final_key = "agent-turn:scope:_main_chat:final:attempt:0"

        result = self._charge(attempt_key=final_key)

        event = BillingUsageEvent.objects.get(idempotency_key=final_key)
        self.assertTrue(result)
        self.assertGreater(event.amount, Decimal("0"))
        self.assertEqual(event.usage_source, "provider_final")

    def test_provider_partial_usage_records_partial_source(self):
        partial_key = "agent-turn:scope:_main_chat:partial:attempt:0"

        result = charge_llm_usage(
            user_id="user-attempt",
            organization_id=self.organization_id,
            model_instance=self.model,
            usage={"input_tokens": 1000, "output_tokens": 0},
            request_id="req-provider-partial",
            source="_main_chat",
            biz_id=partial_key,
            idempotency_key=partial_key,
            usage_source="provider_partial",
        )

        event = BillingUsageEvent.objects.get(idempotency_key=partial_key)
        self.assertTrue(result)
        self.assertGreater(event.amount, Decimal("0"))
        self.assertEqual(event.usage_source, "provider_partial")

    def test_estimated_interrupted_usage_does_not_consume_credits(self):
        estimated_key = "agent-turn:scope:_main_chat:estimated:attempt:0"

        with patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm",
        ) as mock_consume:
            result = charge_llm_usage(
                user_id="user-attempt",
                organization_id=self.organization_id,
                model_instance=self.model,
                usage={
                    "input_tokens": 1000,
                    "output_tokens": 50,
                    "total_tokens": 1050,
                    "estimated": True,
                },
                request_id="req-estimated",
                source="_main_chat",
                biz_id=estimated_key,
                idempotency_key=estimated_key,
                usage_source="provider_final",
            )

        event = BillingUsageEvent.objects.get(idempotency_key=estimated_key)
        mock_consume.assert_not_called()
        self.assertEqual(result["reason"], "estimated_usage_not_charged")
        self.assertEqual(event.amount, Decimal("0"))
        self.assertEqual(event.charge_status, "pending")
        self.assertEqual(event.usage_source, "estimated_interrupted")
        self.assertTrue(event.metadata["estimated"])

    def test_proxy_estimated_cancel_usage_does_not_consume_credits(self):
        estimated_key = "agent-turn:scope:_main_chat:cancel:attempt:0"
        ctx = ProxyContext(
            request_id="req-cancel-estimated",
            user_id="user-attempt",
            organization_id=self.organization_id,
            source="_main_chat",
            scene_key="_main_chat",
            billing_idempotency_key=estimated_key,
            model_instance=self.model,
        )

        with patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm",
        ) as mock_consume, patch(
            "apps.services.llm.services.billed_call._record_usage_fact_for_billed_call",
        ), patch(
            "apps.services.llm.services.billed_call._settle_freeze_safely",
        ):
            credits_charged, charge_ok, _error_category = settle_and_charge(
                ctx,
                {
                    "input_tokens": 1000,
                    "output_tokens": 50,
                    "total_tokens": 1050,
                    "estimated": True,
                },
                usage_source="estimated_interrupted",
            )

        event = BillingUsageEvent.objects.get(idempotency_key=estimated_key)
        mock_consume.assert_not_called()
        self.assertTrue(charge_ok)
        self.assertEqual(credits_charged, 0.0)
        self.assertEqual(event.amount, Decimal("0"))
        self.assertEqual(event.usage_source, "estimated_interrupted")

    def test_estimated_replay_does_not_overwrite_charged_event_source(self):
        replay_key = "agent-turn:scope:_main_chat:replay:attempt:0"
        self._charge(attempt_key=replay_key)
        charged_event = BillingUsageEvent.objects.get(idempotency_key=replay_key)
        self.assertEqual(charged_event.charge_status, "charged")
        self.assertEqual(charged_event.usage_source, "provider_final")

        ctx = ProxyContext(
            request_id="req-replay-estimated",
            user_id="user-attempt",
            organization_id=self.organization_id,
            source="_main_chat",
            scene_key="_main_chat",
            billing_idempotency_key=replay_key,
            model_instance=self.model,
        )
        with patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm",
        ) as mock_consume, patch(
            "apps.services.llm.services.billed_call._record_usage_fact_for_billed_call",
        ), patch(
            "apps.services.llm.services.billed_call._settle_freeze_safely",
        ):
            settle_and_charge(
                ctx,
                {
                    "input_tokens": 1000,
                    "output_tokens": 50,
                    "total_tokens": 1050,
                    "estimated": True,
                },
                usage_source="estimated_interrupted",
            )

        event = BillingUsageEvent.objects.get(idempotency_key=replay_key)
        mock_consume.assert_not_called()
        self.assertEqual(event.charge_status, "charged")
        self.assertEqual(event.usage_source, "provider_final")

    def test_same_attempt_key_replay_creates_one_event_and_charges_once(self):
        logical_key = "agent-turn:scope:_main_chat:1"
        attempt_key = f"{logical_key}:attempt:0"
        wallet = OrganizationWallet.objects.get(organization_id=self.organization_id)
        starting_balance = wallet.credits_precise

        first = self._charge(
            attempt_key=attempt_key,
            logical_key=logical_key,
            attempt_index=0,
        )
        after_first = OrganizationWallet.objects.get(
            organization_id=self.organization_id,
        ).credits_precise
        second = self._charge(
            attempt_key=attempt_key,
            logical_key=logical_key,
            attempt_index=0,
        )
        after_second = OrganizationWallet.objects.get(
            organization_id=self.organization_id,
        ).credits_precise

        self.assertEqual(
            BillingUsageEvent.objects.filter(idempotency_key=attempt_key).count(),
            1,
        )
        self.assertLess(after_first, starting_balance)
        self.assertEqual(after_second, after_first)
        self.assertEqual(second.get("reason"), "already_settled")
        self.assertTrue(first)

    def test_legacy_idempotency_key_without_attempt_metadata_still_charges(self):
        legacy_key = "legacy-runtime-key"

        result = self._charge(attempt_key=legacy_key)

        event = BillingUsageEvent.objects.get(idempotency_key=legacy_key)
        self.assertTrue(result)
        self.assertEqual(event.logical_billing_key, "")
        self.assertIsNone(event.attempt_index)
        self.assertEqual(event.usage_source, "provider_final")


@override_settings(BILLING_BUDGET_ALERTS_ENABLED=True)
class TestCheckBudgetPolicyUnitMatch(SimpleTestCase):
    """BIL-1 回归测试：check_budget_policy 必须用点券/点券比较，不能用元/点券。"""

    def _make_policy(self, *, warning=80, critical=95, block=False):
        return SimpleNamespace(
            warning_threshold_percent=Decimal(str(warning)),
            critical_threshold_percent=Decimal(str(critical)),
            block_on_critical=block,
        )

    def _make_budget(self, *, included, consumed, overflow=Decimal("0")):
        return SimpleNamespace(
            included_credits=Decimal(str(included)),
            consumed_credits=Decimal(str(consumed)),
            overflow_credits=Decimal(str(overflow)),
        )

    @override_settings(BILLING_BUDGET_ALERTS_ENABLED=False)
    @patch("apps.services.llm.services.billing._notify_budget_alert")
    @patch("apps.services.billing.models.BillingBudgetPolicy.objects")
    @patch("apps.services.billing.models.OrganizationLlmMonthlyBudget.objects")
    @patch("django.core.cache.cache")
    def test_budget_alerts_disabled_short_circuits_without_notify(
        self, mock_cache, mock_budget_qs, mock_policy_qs, mock_notify
    ):
        mock_cache.get.return_value = None
        mock_policy_qs.filter.return_value.first.return_value = self._make_policy(
            warning=80, critical=95,
        )
        mock_budget_qs.filter.return_value.first.return_value = self._make_budget(
            included=Decimal("1000"), consumed=Decimal("960"),
        )

        result = check_budget_policy("ws_alerts_disabled")

        self.assertIsNone(result)
        mock_notify.assert_not_called()
        mock_policy_qs.filter.assert_not_called()
        mock_budget_qs.filter.assert_not_called()

    @patch("apps.services.llm.services.billing._can_continue_with_paygo_wallet", return_value=True)
    @patch("apps.services.llm.services.billing._get_block_on_critical_cached", return_value=True)
    @patch("apps.services.llm.services.billing.check_budget_policy", return_value="critical")
    def test_critical_budget_allows_when_paygo_wallet_can_cover_freeze(
        self,
        mock_check_budget_policy,
        mock_block_on_critical,
        mock_can_paygo,
    ):
        model = SimpleNamespace(model_name="gpt-4o-mini")

        result = check_budget_before_request(
            "ws_paygo_001",
            skip_guard=True,
            model_instance=model,
        )

        self.assertIsNone(result)
        mock_can_paygo.assert_called_once_with("ws_paygo_001", model_instance=model)

    @patch("apps.services.llm.services.billing._can_continue_with_paygo_wallet", return_value=False)
    @patch("apps.services.llm.services.billing._get_block_on_critical_cached", return_value=True)
    @patch("apps.services.llm.services.billing.check_budget_policy", return_value="critical")
    def test_critical_budget_blocks_when_paygo_wallet_cannot_cover_freeze(
        self,
        mock_check_budget_policy,
        mock_block_on_critical,
        mock_can_paygo,
    ):
        result = check_budget_before_request("ws_paygo_002", skip_guard=True)

        self.assertIsNotNone(result)
        self.assertTrue(result["blocked"])
        self.assertEqual(result["reason"], "budget_critical")

    @patch("apps.services.llm.services.billing._notify_budget_alert")
    @patch("apps.services.billing.models.BillingBudgetPolicy.objects")
    @patch("apps.services.billing.models.OrganizationLlmMonthlyBudget.objects")
    @patch("django.core.cache.cache")
    def test_returns_critical_when_consumed_exceeds_critical_threshold(
        self, mock_cache, mock_budget_qs, mock_policy_qs, mock_notify
    ):
        mock_cache.get.return_value = None
        mock_policy_qs.filter.return_value.first.return_value = self._make_policy(
            warning=80, critical=95,
        )
        mock_budget_qs.filter.return_value.first.return_value = self._make_budget(
            included=Decimal("1000"), consumed=Decimal("960"),
        )

        result = check_budget_policy("ws_test_001")

        self.assertEqual(result, "critical")
        mock_notify.assert_called_once()

    @patch("apps.services.llm.services.billing._get_llm_billing_mode", return_value="quota_then_paygo")
    @patch("apps.services.billing.services.guard_service.BillingGuardService._wallet_has_positive_balance", return_value=True)
    @patch("apps.services.llm.services.billing._notify_budget_alert")
    @patch("apps.services.billing.models.BillingBudgetPolicy.objects")
    @patch("apps.services.billing.models.OrganizationLlmMonthlyBudget.objects")
    @patch("django.core.cache.cache")
    def test_critical_budget_event_marks_paygo_wallet_available(
        self,
        mock_cache,
        mock_budget_qs,
        mock_policy_qs,
        mock_notify,
        mock_wallet_positive,
        mock_billing_mode,
    ):
        mock_cache.get.return_value = None
        mock_policy_qs.filter.return_value.first.return_value = self._make_policy(
            warning=80, critical=95, block=True,
        )
        mock_budget_qs.filter.return_value.first.return_value = self._make_budget(
            included=Decimal("100"), consumed=Decimal("100"),
        )

        result = check_budget_policy("ws_paygo_alert")

        self.assertEqual(result, "critical")
        mock_wallet_positive.assert_called_once_with("ws_paygo_alert")
        mock_billing_mode.assert_called_once_with("ws_paygo_alert")
        mock_notify.assert_called_once()
        self.assertFalse(mock_notify.call_args.kwargs["blocking"])
        self.assertTrue(mock_notify.call_args.kwargs["wallet_paygo_available"])

    @patch("apps.services.llm.services.billing._notify_budget_alert")
    @patch("apps.services.billing.models.BillingBudgetPolicy.objects")
    @patch("apps.services.billing.models.OrganizationLlmMonthlyBudget.objects")
    @patch("django.core.cache.cache")
    def test_returns_warning_when_consumed_between_warning_and_critical(
        self, mock_cache, mock_budget_qs, mock_policy_qs, mock_notify
    ):
        mock_cache.get.return_value = None
        mock_policy_qs.filter.return_value.first.return_value = self._make_policy(
            warning=80, critical=95,
        )
        mock_budget_qs.filter.return_value.first.return_value = self._make_budget(
            included=Decimal("1000"), consumed=Decimal("850"),
        )

        result = check_budget_policy("ws_test_002")

        self.assertEqual(result, "warning")

    @patch("apps.services.billing.models.BillingBudgetPolicy.objects")
    @patch("apps.services.billing.models.OrganizationLlmMonthlyBudget.objects")
    @patch("django.core.cache.cache")
    def test_returns_none_when_consumed_below_warning(
        self, mock_cache, mock_budget_qs, mock_policy_qs
    ):
        mock_cache.get.return_value = None
        mock_policy_qs.filter.return_value.first.return_value = self._make_policy(
            warning=80, critical=95,
        )
        mock_budget_qs.filter.return_value.first.return_value = self._make_budget(
            included=Decimal("1000"), consumed=Decimal("500"),
        )

        result = check_budget_policy("ws_test_003")

        self.assertIsNone(result)

    @patch("apps.services.billing.models.BillingBudgetPolicy.objects")
    @patch("apps.services.billing.models.OrganizationLlmMonthlyBudget.objects")
    @patch("django.core.cache.cache")
    def test_returns_none_when_no_budget_record(
        self, mock_cache, mock_budget_qs, mock_policy_qs
    ):
        mock_cache.get.return_value = None
        mock_policy_qs.filter.return_value.first.return_value = self._make_policy()
        mock_budget_qs.filter.return_value.first.return_value = None

        result = check_budget_policy("ws_test_004")

        self.assertIsNone(result)

    @patch("apps.services.billing.models.BillingBudgetPolicy.objects")
    @patch("apps.services.billing.models.OrganizationLlmMonthlyBudget.objects")
    @patch("django.core.cache.cache")
    def test_returns_none_when_included_credits_is_zero(
        self, mock_cache, mock_budget_qs, mock_policy_qs
    ):
        mock_cache.get.return_value = None
        mock_policy_qs.filter.return_value.first.return_value = self._make_policy()
        mock_budget_qs.filter.return_value.first.return_value = self._make_budget(
            included=Decimal("0"), consumed=Decimal("0"),
        )

        result = check_budget_policy("ws_test_005")

        self.assertIsNone(result)

    @patch("apps.services.llm.services.billing._notify_budget_alert")
    @patch("apps.services.billing.models.BillingBudgetPolicy.objects")
    @patch("apps.services.billing.models.OrganizationLlmMonthlyBudget.objects")
    @patch("django.core.cache.cache")
    def test_unit_mismatch_regression_high_cost_low_credits_must_trigger(
        self, mock_cache, mock_budget_qs, mock_policy_qs, mock_notify
    ):
        """BIL-1 核心回归：旧实现用元(total_cost=9.6)除以点券(1000)得 0.96%，永远不告警。
        修复后用点券(consumed_credits=960)除以点券(included_credits=1000)得 96%，正确触发 critical。"""
        mock_cache.get.return_value = None
        mock_policy_qs.filter.return_value.first.return_value = self._make_policy(
            warning=80, critical=95,
        )
        mock_budget_qs.filter.return_value.first.return_value = self._make_budget(
            included=Decimal("1000"), consumed=Decimal("960"),
        )

        result = check_budget_policy("ws_regression_bil1")

        self.assertEqual(result, "critical")
        mock_notify.assert_called_once()
        call_args = mock_notify.call_args
        usage_pct = call_args[0][2]
        self.assertGreaterEqual(usage_pct, Decimal("95"))

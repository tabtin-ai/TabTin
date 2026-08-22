from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from threading import Barrier
from unittest.mock import Mock, patch

import requests
from django.contrib.auth import get_user_model
from django.db import close_old_connections
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from apps.services.billing.models import (
    BillingReservation,
    BillingReservationAllocation,
    BillingUsageEvent,
    MeterPricing,
    OrganizationBillingEntitlement,
    OrganizationBillingPolicy,
    OrganizationLlmMonthlyBudget,
)
from apps.services.billing.services.funding_allocator import (
    FUNDING_PURPOSE_LLM,
    FundingAllocator,
    MONTHLY_BUDGET,
    ORGANIZATION_WALLET,
    PROVIDER_CREDIT,
)
from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService
from apps.services.billing.services.pricing_service import MeterPricingService
from apps.services.billing.services.provider_credit_service import ProviderCreditService
from apps.services.billing.services.search_reservation_service import (
    SearchBillingReservationService,
    SearchReservationInsufficientFunds,
)
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.services.agent_engine.models import ExecutionRun
from apps.services.search.api import WebSearchRequest, web_search
from apps.services.search.constants import SEARCH_BILLING_METER_KEY
from apps.services.search.models import SearchGlobalConfig, SearchProvider
from apps.services.search.services.base import SearchProviderError
from apps.services.search.services.invocation_identity import (
    VerifiedSearchInvocationIdentity,
    _VERIFIED_INVOCATION_TOKEN,
    build_search_request_fingerprint,
)
from apps.services.search.services.search_service import SearchService
from apps.services.search.services.types import (
    SearchRequest,
    SearchResponse,
    SearchWebPageResult,
)
from apps.users.wallet.models import OrganizationWallet, WalletTransaction
from apps.users.wallet.tasks import reclaim_stale_frozen_credits
from apps.tabtinspace.models import Organization, OrganizationMember


@override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True)
class SearchBillingReservationTests(TestCase):
    databases = {"default"}

    def setUp(self):
        MeterPricingService.invalidate_cache()
        self.organization_id = org_id_for("search_reservation_original_402")
        OrganizationLlmBudgetService._invalidate_quota_remaining_cache(
            self.organization_id,
            OrganizationLlmBudgetService.cycle_month(),
        )
        self.user_id = "search-reservation-user"
        OrganizationBillingPolicy.objects.create(
            organization_id=self.organization_id,
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        SearchProvider.objects.update_or_create(
            provider_key="bocha",
            defaults={
                "provider_type": "bocha",
                "display_name": "博查搜索",
                "base_url": "https://api.bocha.cn/v1/web-search",
                "api_key": "sk-test",
                "is_active": True,
            },
        )
        SearchProvider.objects.update_or_create(
            provider_key="qianfan",
            defaults={
                "provider_type": "qianfan",
                "display_name": "千帆搜索",
                "base_url": "https://qianfan.example/v2/ai_search/web_search",
                "api_key": "sk-test-qianfan",
                "is_active": True,
                "priority": 90,
            },
        )
        SearchGlobalConfig.objects.all().delete()
        SearchGlobalConfig.objects.create(
            default_provider_key="bocha",
            default_count=8,
            default_summary_enabled=True,
            default_freshness="noLimit",
        )
        self._price("bocha", Decimal("1"))
        self._price("qianfan", Decimal("1"))

    def _price(self, provider_key: str, amount: Decimal):
        pricing, _ = MeterPricing.objects.update_or_create(
            meter_key=SEARCH_BILLING_METER_KEY,
            scope="global",
            provider_key=provider_key,
            model_name="",
            organization=None,
            defaults={
                "unit": "request",
                "unit_price": amount,
                "currency": "CREDITS",
                "precision": 4,
                "is_active": True,
                "priority": 100,
            },
        )
        return pricing

    def _grant(self, amount: Decimal, code: str = "SEARCH_SPONSORED"):
        campaign = ProviderCreditService.create_campaign(
            code=code,
            name=code,
            provider_key="volcengine",
            eligible_model_ids=[str(uuid.uuid4())],
            credits_amount=amount,
            total_budget_credits=amount,
        )
        return ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

    @staticmethod
    def _verified(component: str) -> VerifiedSearchInvocationIdentity:
        return VerifiedSearchInvocationIdentity(
            logical_search_invocation_id=str(uuid.uuid5(uuid.NAMESPACE_URL, component)),
            agent_run_id=str(uuid.uuid4()),
            _verification_token=_VERIFIED_INVOCATION_TOKEN,
        )

    @staticmethod
    def _response(provider_key: str, request_id: str = "provider-request"):
        return SearchResponse(
            provider_key=provider_key,
            provider_type=provider_key,
            provider_display_name=provider_key,
            request_id=request_id,
            query="上海天气",
            count=8,
            summary_enabled=True,
            freshness="noLimit",
            web_pages=[
                SearchWebPageResult(
                    name="上海天气",
                    url="https://weather.example/shanghai",
                    snippet="晴",
                )
            ],
            provider_log_id=f"{request_id}-log",
        )

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_doubao_sponsored_pays_bocha_with_zero_monthly_and_wallet_over_http(
        self,
        create_client,
    ):
        grant = self._grant(Decimal("899"))
        client = Mock()
        client.search.return_value = self._response("bocha")
        create_client.return_value = client
        organization = Organization.objects.get(pk=self.organization_id)
        user = get_user_model().objects.get(pk=organization.owner_id)
        OrganizationMember.objects.get_or_create(
            organization=organization,
            user=user,
            defaults={"role": "owner"},
        )
        execution_run = ExecutionRun.objects.create(
            thread_id="search-original-402",
            graph_type="chat",
            organization_id=self.organization_id,
            user_id=str(user.id),
        )
        request = RequestFactory().post(
            "/api/search/web",
            HTTP_X_TABTIN_ORGANIZATION_ID=self.organization_id,
        )
        request.auth = user

        result = web_search(
            request,
            WebSearchRequest(
                query="上海天气",
                agent_run_id=str(execution_run.run_id),
                client_tool_invocation_component="bocha-original-402",
            ),
        )

        grant.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("898"))
        self.assertEqual(grant.active_reserved_credits, Decimal("0"))
        client.search.assert_called_once()
        event = BillingUsageEvent.objects.get(
            organization_id=self.organization_id,
            meter_key=SEARCH_BILLING_METER_KEY,
        )
        self.assertEqual(event.amount, Decimal("0"))
        self.assertEqual(event.metadata["raw_credits_cost"], "1.0000")
        self.assertIsInstance(result, dict)
        self.assertTrue(result["success"])

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_doubao_sponsored_also_pays_qianfan(self, create_client):
        grant = self._grant(Decimal("2"), code="SEARCH_SPONSORED_QIANFAN")
        client = Mock()
        client.search.return_value = self._response("qianfan", "qianfan-request")
        create_client.return_value = client

        SearchService.search(
            "上海天气",
            provider_key="qianfan",
            organization_id=self.organization_id,
            user_id=self.user_id,
            verified_invocation=self._verified("qianfan-sponsored"),
        )

        grant.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("1"))

    def test_llm_provider_model_restriction_is_unchanged(self):
        self._grant(Decimal("10"), code="SEARCH_LLM_RESTRICTION")
        allocations = FundingAllocator.preview_funding(
            organization=self.organization_id,
            provider_key="moonshot",
            model_id=str(uuid.uuid4()),
            required_credits=Decimal("1"),
            billing_context={"llm_billing_mode": "paygo_only"},
            funding_purpose=FUNDING_PURPOSE_LLM,
        )
        self.assertEqual(
            FundingAllocator.credits_for(allocations, PROVIDER_CREDIT),
            Decimal("0.0000"),
        )

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_split_funding_freezes_and_settles_50_30_20(self, create_client):
        grant = self._grant(Decimal("50"), code="SEARCH_SPLIT")
        OrganizationBillingPolicy.objects.filter(
            organization_id=self.organization_id,
        ).update(llm_billing_mode="quota_then_paygo")
        OrganizationBillingEntitlement.objects.create(
            organization_id=self.organization_id,
            included_llm_credits_monthly=Decimal("30"),
        )
        wallet, _ = OrganizationWallet.objects.get_or_create(
            organization_id=self.organization_id,
            defaults={"credits_precise": Decimal("100")},
        )
        wallet.credits_precise = Decimal("100")
        wallet.save(update_fields=["credits_precise", "credits", "updated_at"])
        MeterPricing.objects.filter(
            meter_key=SEARCH_BILLING_METER_KEY,
            provider_key="bocha",
        ).update(unit_price=Decimal("100"))
        MeterPricingService.invalidate_cache()
        self.assertEqual(
            OrganizationLlmBudgetService.get_remaining_quota_credits(
                self.organization_id,
            ),
            Decimal("30.0000"),
        )
        client = Mock()
        client.search.return_value = self._response("bocha", "split-request")
        create_client.return_value = client

        SearchService.search(
            "上海天气",
            organization_id=self.organization_id,
            user_id=self.user_id,
            verified_invocation=self._verified("split-50-30-20"),
        )

        reservation = BillingReservation.objects.get(
            organization_id=self.organization_id,
            status=BillingReservation.Status.COMMITTED,
        )
        allocations = {
            item.source_type: item.credits
            for item in BillingReservationAllocation.objects.filter(
                reservation=reservation,
            )
        }
        self.assertEqual(
            allocations,
            {
                PROVIDER_CREDIT: Decimal("50"),
                MONTHLY_BUDGET: Decimal("30"),
                ORGANIZATION_WALLET: Decimal("20"),
            },
        )
        grant.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("0"))
        budget = OrganizationLlmMonthlyBudget.objects.get(
            organization_id=self.organization_id,
            cycle_month=OrganizationLlmBudgetService.cycle_month(),
        )
        self.assertEqual(budget.consumed_credits, Decimal("30"))
        self.assertEqual(budget.active_reserved_credits, Decimal("0"))
        self.assertEqual(
            OrganizationLlmBudgetService.get_remaining_quota_credits(
                self.organization_id,
            ),
            Decimal("0.0000"),
        )
        wallet.refresh_from_db()
        self.assertEqual(wallet.credits_precise, Decimal("80"))
        self.assertEqual(wallet.credits_frozen_precise, Decimal("0"))
        event = BillingUsageEvent.objects.get(
            organization_id=self.organization_id,
            meter_key=SEARCH_BILLING_METER_KEY,
        )
        self.assertEqual(event.amount, Decimal("20"))
        self.assertEqual(event.metadata["raw_credits_cost"], "100.0000")

    def test_active_search_wallet_freeze_is_excluded_from_stale_cleanup(self):
        wallet, _ = OrganizationWallet.objects.get_or_create(
            organization_id=self.organization_id,
            defaults={"credits_precise": Decimal("2")},
        )
        wallet.credits_precise = Decimal("2")
        wallet.save(update_fields=["credits_precise", "credits", "updated_at"])
        identity = self._verified("wallet-cleanup-exclusion")

        reservation = SearchBillingReservationService.reserve(
            organization_id=self.organization_id,
            user_id=self.user_id,
            logical_search_invocation_id=identity.logical_search_invocation_id,
            request_fingerprint="a" * 64,
            fingerprint_version="search-request-v1",
            meter_key=SEARCH_BILLING_METER_KEY,
            provider_key="bocha",
            quantity=Decimal("1"),
            biz_type="search.web",
            thread_id="",
        )
        freeze_reference = SearchBillingReservationService.wallet_freeze_reference(
            reservation.id
        )
        WalletTransaction.objects.filter(
            transaction_type="freeze",
            reference_key=freeze_reference,
        ).update(created_at=timezone.now() - timedelta(hours=3))

        summary = reclaim_stale_frozen_credits(
            stale_threshold_minutes=60,
            batch_limit=10,
        )

        wallet.refresh_from_db()
        self.assertEqual(summary["released"], 0)
        self.assertEqual(wallet.credits_frozen_precise, Decimal("1"))
        self.assertFalse(
            WalletTransaction.objects.filter(
                transaction_type="unfreeze",
                reference_key=freeze_reference,
            ).exists()
        )

    def test_reserved_sponsored_allocation_commits_after_grant_expiry(self):
        grant = self._grant(Decimal("1"), code="SEARCH_EXPIRES_AFTER_RESERVE")
        identity = self._verified("grant-expiry-after-reserve")
        reservation = SearchBillingReservationService.reserve(
            organization_id=self.organization_id,
            user_id=self.user_id,
            logical_search_invocation_id=identity.logical_search_invocation_id,
            request_fingerprint="b" * 64,
            fingerprint_version="search-request-v1",
            meter_key=SEARCH_BILLING_METER_KEY,
            provider_key="bocha",
            quantity=Decimal("1"),
            biz_type="search.web",
            thread_id="",
        )
        now = timezone.now()
        type(grant).objects.filter(pk=grant.pk).update(
            effective_at=now - timedelta(days=2),
            expire_at=now - timedelta(seconds=1),
            status=grant.Status.EXPIRED,
        )

        _reservation, _attempt, acquired = (
            SearchBillingReservationService.acquire_execution(reservation.id)
        )
        self.assertTrue(acquired)
        SearchBillingReservationService.record_provider_success(
            reservation.id,
            provider_request_id="provider-after-expiry",
            result_reference="result-after-expiry",
            result_metadata={"response_snapshot": {}},
        )
        SearchBillingReservationService.settle(reservation.id)

        grant.refresh_from_db()
        reservation.refresh_from_db()
        self.assertEqual(reservation.status, BillingReservation.Status.COMMITTED)
        self.assertEqual(grant.remaining_credits, Decimal("0"))
        self.assertEqual(grant.active_reserved_credits, Decimal("0"))
        self.assertEqual(grant.consumed_credits, Decimal("1"))

    def test_unknown_is_not_auto_released_and_requires_operator_resolution(self):
        grant = self._grant(Decimal("1"), code="SEARCH_UNKNOWN_NO_COST")
        identity = self._verified("unknown-no-auto-release")
        reservation = SearchBillingReservationService.reserve(
            organization_id=self.organization_id,
            user_id=self.user_id,
            logical_search_invocation_id=identity.logical_search_invocation_id,
            request_fingerprint="c" * 64,
            fingerprint_version="search-request-v1",
            meter_key=SEARCH_BILLING_METER_KEY,
            provider_key="bocha",
            quantity=Decimal("1"),
            biz_type="search.web",
            thread_id="",
        )
        SearchBillingReservationService.acquire_execution(reservation.id)
        SearchBillingReservationService.mark_unknown(
            reservation.id,
            reason="transport_outcome_unknown",
        )
        BillingReservation.objects.filter(pk=reservation.id).update(
            next_recovery_at=timezone.now() - timedelta(seconds=1),
        )

        summary = SearchBillingReservationService.sweep(limit=10)

        reservation.refresh_from_db()
        grant.refresh_from_db()
        self.assertEqual(summary["checked"], 1)
        self.assertEqual(reservation.status, BillingReservation.Status.UNKNOWN)
        self.assertEqual(grant.active_reserved_credits, Decimal("1"))
        SearchBillingReservationService.resolve_unknown_as_no_cost(
            reservation.id,
            resolved_by="billing-operator",
            resolution_reason="provider_confirmed_no_cost",
        )
        reservation.refresh_from_db()
        grant.refresh_from_db()
        self.assertEqual(reservation.status, BillingReservation.Status.RELEASED)
        self.assertEqual(reservation.resolved_by, "billing-operator")
        self.assertEqual(grant.active_reserved_credits, Decimal("0"))
        self.assertEqual(grant.remaining_credits, Decimal("1"))

    def test_operator_can_settle_unknown_after_provider_confirms_success(self):
        grant = self._grant(Decimal("1"), code="SEARCH_UNKNOWN_SUCCESS")
        identity = self._verified("unknown-confirmed-success")
        reservation = SearchBillingReservationService.reserve(
            organization_id=self.organization_id,
            user_id=self.user_id,
            logical_search_invocation_id=identity.logical_search_invocation_id,
            request_fingerprint="d" * 64,
            fingerprint_version="search-request-v1",
            meter_key=SEARCH_BILLING_METER_KEY,
            provider_key="bocha",
            quantity=Decimal("1"),
            biz_type="search.web",
            thread_id="",
        )
        SearchBillingReservationService.acquire_execution(reservation.id)
        SearchBillingReservationService.mark_unknown(
            reservation.id,
            reason="transport_outcome_unknown",
        )

        SearchBillingReservationService.resolve_unknown_as_success(
            reservation.id,
            resolved_by="billing-operator",
            resolution_reason="provider_confirmed_success",
            provider_request_id="provider-confirmed-request",
            result_reference="provider-confirmed-result",
        )
        SearchBillingReservationService.settle(reservation.id)

        reservation.refresh_from_db()
        grant.refresh_from_db()
        self.assertEqual(reservation.status, BillingReservation.Status.COMMITTED)
        self.assertEqual(reservation.resolved_by, "billing-operator")
        self.assertEqual(grant.remaining_credits, Decimal("0"))
        self.assertEqual(grant.active_reserved_credits, Decimal("0"))
        self.assertEqual(
            BillingUsageEvent.objects.filter(
                idempotency_key=f"search-reservation:{reservation.id}",
            ).count(),
            1,
        )

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_insufficient_funding_blocks_before_provider(self, create_client):
        client = Mock()
        create_client.return_value = client
        with self.assertRaises(SearchProviderError) as raised:
            SearchService.search(
                "上海天气",
                organization_id=self.organization_id,
                user_id=self.user_id,
                verified_invocation=self._verified("insufficient"),
            )
        self.assertEqual(raised.exception.code, "search_billing_insufficient_balance")
        client.search.assert_not_called()

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_provider_failure_releases_reservation_without_usage(self, create_client):
        grant = self._grant(Decimal("1"), code="SEARCH_PROVIDER_FAILURE")
        client = Mock()
        client.search.side_effect = SearchProviderError(
            "provider failed",
            code="bocha_http_error",
        )
        create_client.return_value = client
        identity = self._verified("provider-failure")

        with self.assertRaises(SearchProviderError):
            SearchService.search(
                "上海天气",
                organization_id=self.organization_id,
                user_id=self.user_id,
                verified_invocation=identity,
            )

        grant.refresh_from_db()
        reservation = BillingReservation.objects.get(
            logical_search_invocation_id=identity.logical_search_invocation_id
        )
        self.assertEqual(reservation.status, BillingReservation.Status.RELEASED)
        self.assertEqual(grant.active_reserved_credits, Decimal("0"))
        self.assertEqual(grant.remaining_credits, Decimal("1"))
        self.assertFalse(BillingUsageEvent.objects.filter(organization_id=self.organization_id).exists())

    @patch("apps.services.search.services.providers.bocha.requests.post")
    def test_bocha_read_timeout_marks_unknown_and_retains_all_funding(
        self,
        post,
    ):
        grant = self._grant(Decimal("50"), code="SEARCH_TRANSPORT_UNKNOWN")
        OrganizationBillingPolicy.objects.filter(
            organization_id=self.organization_id,
        ).update(llm_billing_mode="quota_then_paygo")
        OrganizationBillingEntitlement.objects.create(
            organization_id=self.organization_id,
            included_llm_credits_monthly=Decimal("30"),
        )
        wallet, _ = OrganizationWallet.objects.get_or_create(
            organization_id=self.organization_id,
            defaults={"credits_precise": Decimal("100")},
        )
        wallet.credits_precise = Decimal("100")
        wallet.save(update_fields=["credits_precise", "credits", "updated_at"])
        MeterPricing.objects.filter(
            meter_key=SEARCH_BILLING_METER_KEY,
            provider_key="bocha",
        ).update(unit_price=Decimal("100"))
        MeterPricingService.invalidate_cache()
        post.side_effect = requests.ReadTimeout("provider outcome unknown")
        identity = self._verified("bocha-read-timeout")
        search_kwargs = {
            "organization_id": self.organization_id,
            "user_id": self.user_id,
            "verified_invocation": identity,
        }

        with self.assertRaises(SearchProviderError):
            SearchService.search("上海天气", **search_kwargs)

        reservation = BillingReservation.objects.get(
            logical_search_invocation_id=identity.logical_search_invocation_id,
        )
        grant.refresh_from_db()
        budget = OrganizationLlmMonthlyBudget.objects.get(
            organization_id=self.organization_id,
            cycle_month=OrganizationLlmBudgetService.cycle_month(),
        )
        wallet.refresh_from_db()
        self.assertEqual(reservation.status, BillingReservation.Status.UNKNOWN)
        self.assertEqual(grant.remaining_credits, Decimal("50"))
        self.assertEqual(grant.active_reserved_credits, Decimal("50"))
        self.assertEqual(budget.consumed_credits, Decimal("0"))
        self.assertEqual(budget.active_reserved_credits, Decimal("30"))
        self.assertEqual(wallet.credits_precise, Decimal("100"))
        self.assertEqual(wallet.credits_frozen_precise, Decimal("20"))
        self.assertFalse(
            BillingUsageEvent.objects.filter(
                organization_id=self.organization_id,
            ).exists()
        )
        post.assert_called_once()

        with self.assertRaises(SearchProviderError):
            SearchService.search("上海天气", **search_kwargs)

        reservation.refresh_from_db()
        self.assertEqual(reservation.status, BillingReservation.Status.UNKNOWN)
        post.assert_called_once()

    @patch("apps.services.search.services.providers.qianfan.requests.post")
    def test_qianfan_connection_error_marks_unknown_and_retains_funding(
        self,
        post,
    ):
        grant = self._grant(Decimal("1"), code="SEARCH_QIANFAN_UNKNOWN")
        post.side_effect = requests.ConnectionError("connection reset")
        identity = self._verified("qianfan-connection-error")

        with self.assertRaises(SearchProviderError):
            SearchService.search(
                "上海天气",
                provider_key="qianfan",
                organization_id=self.organization_id,
                user_id=self.user_id,
                verified_invocation=identity,
            )

        reservation = BillingReservation.objects.get(
            logical_search_invocation_id=identity.logical_search_invocation_id,
        )
        grant.refresh_from_db()
        self.assertEqual(reservation.status, BillingReservation.Status.UNKNOWN)
        self.assertEqual(grant.remaining_credits, Decimal("1"))
        self.assertEqual(grant.active_reserved_credits, Decimal("1"))
        self.assertFalse(
            BillingUsageEvent.objects.filter(
                organization_id=self.organization_id,
            ).exists()
        )
        post.assert_called_once()

    @override_settings(DOUBAO_SEARCH_API_KEY="test-doubao-key")
    @patch("apps.services.search.services.providers.doubao.requests.post")
    def test_doubao_reservation_timeout_is_unknown_with_one_http_attempt(
        self,
        post,
    ):
        SearchProvider.objects.update_or_create(
            provider_key="doubao",
            defaults={
                "provider_type": "doubao",
                "display_name": "豆包搜索",
                "base_url": "https://open.feedcoopapi.com/search_api/web_search",
                "is_active": True,
                "extra_config": {"max_retries": 3, "retry_backoff_ms": 0},
            },
        )
        self._price("doubao", Decimal("1"))
        grant = self._grant(Decimal("1"), code="SEARCH_DOUBAO_UNKNOWN")
        post.side_effect = requests.ReadTimeout("provider outcome unknown")
        identity = self._verified("doubao-timeout-single-attempt")

        with self.assertRaises(SearchProviderError):
            SearchService.search(
                "上海天气",
                provider_key="doubao",
                organization_id=self.organization_id,
                user_id=self.user_id,
                verified_invocation=identity,
            )

        reservation = BillingReservation.objects.get(
            logical_search_invocation_id=identity.logical_search_invocation_id,
        )
        grant.refresh_from_db()
        self.assertEqual(reservation.status, BillingReservation.Status.UNKNOWN)
        self.assertEqual(grant.remaining_credits, Decimal("1"))
        self.assertEqual(grant.active_reserved_credits, Decimal("1"))
        post.assert_called_once()

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_same_logical_retry_replays_without_second_provider_call(self, create_client):
        self._grant(Decimal("2"), code="SEARCH_REPLAY")
        client = Mock()
        client.search.return_value = self._response("bocha", "replay-request")
        create_client.return_value = client
        identity = self._verified("same-retry")
        kwargs = {
            "organization_id": self.organization_id,
            "user_id": self.user_id,
            "verified_invocation": identity,
        }

        first = SearchService.search("上海天气", **kwargs)
        second = SearchService.search("上海天气", **kwargs)

        self.assertEqual(first.request_id, second.request_id)
        client.search.assert_called_once()
        self.assertEqual(
            BillingUsageEvent.objects.filter(organization_id=self.organization_id).count(),
            1,
        )

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_reserved_retry_keeps_frozen_provider_when_current_default_changes(
        self,
        create_client,
    ):
        self._grant(Decimal("2"), code="SEARCH_PROVIDER_SNAPSHOT")
        identity = self._verified("provider-snapshot")
        fingerprint = build_search_request_fingerprint(
            SearchRequest(
                query="上海天气",
                count=8,
                summary=True,
                freshness="noLimit",
                include="",
                exclude="",
            )
        )
        SearchBillingReservationService.reserve(
            organization_id=self.organization_id,
            user_id=self.user_id,
            logical_search_invocation_id=identity.logical_search_invocation_id,
            request_fingerprint=fingerprint.request_fingerprint,
            fingerprint_version=fingerprint.fingerprint_version,
            meter_key=SEARCH_BILLING_METER_KEY,
            provider_key="bocha",
            quantity=Decimal("1"),
            biz_type="search.web",
            thread_id="",
        )
        client = Mock()
        client.search.return_value = self._response("bocha", "provider-snapshot-result")
        create_client.return_value = client

        SearchService.search(
            "上海天气",
            provider_key="qianfan",
            organization_id=self.organization_id,
            user_id=self.user_id,
            verified_invocation=identity,
        )

        resolved_runtime = create_client.call_args.args[0]
        self.assertEqual(resolved_runtime.provider_key, "bocha")
        reservation = BillingReservation.objects.get(
            logical_search_invocation_id=identity.logical_search_invocation_id,
        )
        self.assertEqual(reservation.provider_key, "bocha")
        self.assertEqual(reservation.unit_price, Decimal("1"))

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_same_logical_id_with_different_request_is_conflict(self, create_client):
        self._grant(Decimal("2"), code="SEARCH_FINGERPRINT_CONFLICT")
        client = Mock()
        client.search.return_value = self._response("bocha", "conflict-request")
        create_client.return_value = client
        identity = self._verified("fingerprint-conflict")

        SearchService.search(
            "OpenAI",
            organization_id=self.organization_id,
            user_id=self.user_id,
            verified_invocation=identity,
        )
        with self.assertRaises(SearchProviderError) as raised:
            SearchService.search(
                "Apple",
                organization_id=self.organization_id,
                user_id=self.user_id,
                verified_invocation=identity,
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.code, "idempotency_key_conflict")
        client.search.assert_called_once()

    @patch("apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client")
    def test_settlement_failure_retries_settlement_only(self, create_client):
        self._grant(Decimal("2"), code="SEARCH_SETTLEMENT_RETRY")
        client = Mock()
        client.search.return_value = self._response("bocha", "settlement-request")
        create_client.return_value = client
        identity = self._verified("settlement-retry")
        real_settle = SearchBillingReservationService.settle
        calls = {"count": 0}

        def flaky_settle(reservation_id):
            calls["count"] += 1
            if calls["count"] == 1:
                raise RuntimeError("transient db error")
            return real_settle(reservation_id)

        with patch.object(
            SearchBillingReservationService,
            "settle",
            side_effect=flaky_settle,
        ):
            with self.assertRaises(SearchProviderError) as first_error:
                SearchService.search(
                    "上海天气",
                    organization_id=self.organization_id,
                    user_id=self.user_id,
                    verified_invocation=identity,
                )
            self.assertEqual(
                first_error.exception.code,
                "search_billing_settlement_pending",
            )
            reservation = BillingReservation.objects.get(
                logical_search_invocation_id=identity.logical_search_invocation_id
            )
            self.assertEqual(
                reservation.status,
                BillingReservation.Status.SETTLEMENT_PENDING,
            )
            replay = SearchService.search(
                "上海天气",
                organization_id=self.organization_id,
                user_id=self.user_id,
                verified_invocation=identity,
            )

        self.assertEqual(replay.request_id, "settlement-request")
        client.search.assert_called_once()
        reservation.refresh_from_db()
        self.assertEqual(reservation.status, BillingReservation.Status.COMMITTED)


@override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True)
class SearchBillingReservationConcurrencyTests(TransactionTestCase):
    databases = {"default"}

    def setUp(self):
        MeterPricingService.invalidate_cache()
        self.organization_id = org_id_for("search_reservation_concurrency")
        OrganizationBillingPolicy.objects.create(
            organization_id=self.organization_id,
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        MeterPricing.objects.create(
            meter_key=SEARCH_BILLING_METER_KEY,
            scope="global",
            provider_key="bocha",
            unit="request",
            unit_price=Decimal("1"),
            currency="CREDITS",
            is_active=True,
            priority=100,
        )
        campaign = ProviderCreditService.create_campaign(
            code="SEARCH_CONCURRENT_ONE",
            name="SEARCH_CONCURRENT_ONE",
            provider_key="volcengine",
            eligible_model_ids=[],
            credits_amount=Decimal("1"),
            total_budget_credits=Decimal("1"),
        )
        self.grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

    def test_one_sponsored_credit_cannot_be_reserved_twice(self):
        barrier = Barrier(2)

        def reserve(index: int):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    reservation = SearchBillingReservationService.reserve(
                        organization_id=self.organization_id,
                        user_id=f"user-{index}",
                        logical_search_invocation_id=str(uuid.uuid4()),
                        request_fingerprint=f"{index:064x}",
                        fingerprint_version="search-request-v1",
                        meter_key=SEARCH_BILLING_METER_KEY,
                        provider_key="bocha",
                        quantity=Decimal("1"),
                        biz_type="search.web",
                        thread_id="",
                    )
                    return str(reservation.id)
                except SearchReservationInsufficientFunds:
                    return "insufficient"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(reserve, [1, 2]))

        self.assertEqual(results.count("insufficient"), 1)
        self.grant.refresh_from_db()
        self.assertEqual(self.grant.active_reserved_credits, Decimal("1"))
        self.assertEqual(
            BillingReservation.objects.filter(status=BillingReservation.Status.RESERVED).count(),
            1,
        )

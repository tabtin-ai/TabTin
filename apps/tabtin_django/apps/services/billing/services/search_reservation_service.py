"""Web Search 的持久资金 Reservation 状态机。"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.services.billing.models import (
    BillingReservation,
    BillingReservationAllocation,
    BillingUsageEvent,
    OrganizationLlmMonthlyBudget,
    ProviderAttempt,
    ProviderCreditGrant,
    ProviderCreditTransaction,
)
from apps.services.billing.services.funding_allocator import (
    FUNDING_MODE_LEGACY_BUDGET_WALLET,
    FUNDING_MODE_PROVIDER_CREDIT_V1,
    FUNDING_PURPOSE_SEARCH_WEB,
    MONTHLY_BUDGET,
    ORGANIZATION_WALLET,
    PROVIDER_CREDIT,
    FundingAllocator,
)
from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService
from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
from apps.services.billing.services.pricing_service import MeterPricingService
from apps.users.wallet.models import OrganizationWallet, WalletTransaction
from apps.users.wallet.services.credits_service import CreditsService

logger = logging.getLogger(__name__)


class SearchReservationError(Exception):
    code = "search_reservation_error"


class SearchReservationConflict(SearchReservationError):
    code = "search_idempotency_key_conflict"


class SearchReservationInsufficientFunds(SearchReservationError):
    code = "search_billing_insufficient_balance"


class SearchReservationInProgress(SearchReservationError):
    code = "search_invocation_in_progress"


@dataclass(frozen=True, slots=True)
class SearchPricingSnapshot:
    pricing_rule_id: str | None
    unit_price: Decimal
    quantity: Decimal
    total_credits: Decimal


class SearchBillingReservationService:
    RESERVATION_LEASE = timedelta(minutes=2)
    EXECUTION_LEASE = timedelta(minutes=5)
    RECOVERY_DELAY = timedelta(minutes=2)
    CREDITS_QUANT = Decimal("0.0001")

    @classmethod
    def _quantize(cls, value: Any) -> Decimal:
        return Decimal(str(value or 0)).quantize(cls.CREDITS_QUANT)

    @classmethod
    def resolve_pricing(
        cls,
        *,
        organization_id: str,
        provider_key: str,
        meter_key: str,
        quantity: Decimal,
    ) -> SearchPricingSnapshot:
        rule = MeterPricingService.get_pricing_rule(
            meter_key,
            organization_id=organization_id,
            provider_key=provider_key,
        )
        unit_price = cls._quantize(rule.unit_price if rule is not None else 0)
        normalized_quantity = Decimal(str(quantity or 0))
        return SearchPricingSnapshot(
            pricing_rule_id=str(rule.id) if rule is not None else None,
            unit_price=unit_price,
            quantity=normalized_quantity,
            total_credits=cls._quantize(unit_price * normalized_quantity),
        )

    @classmethod
    def current_funding_mode(cls) -> str:
        return (
            FUNDING_MODE_PROVIDER_CREDIT_V1
            if FundingAllocator.is_enabled()
            else FUNDING_MODE_LEGACY_BUDGET_WALLET
        )

    @classmethod
    @transaction.atomic
    def reserve(
        cls,
        *,
        organization_id: str,
        user_id: str,
        logical_search_invocation_id: str,
        request_fingerprint: str,
        fingerprint_version: str,
        meter_key: str,
        provider_key: str,
        quantity: Decimal,
        biz_type: str,
        thread_id: str,
    ) -> BillingReservation:
        pricing = cls.resolve_pricing(
            organization_id=organization_id,
            provider_key=provider_key,
            meter_key=meter_key,
            quantity=quantity,
        )
        existing = (
            BillingReservation.objects.select_for_update()
            .filter(
                organization_id=organization_id,
                logical_search_invocation_id=logical_search_invocation_id,
            )
            .first()
        )
        if existing is not None:
            cls._validate_replay(existing, request_fingerprint)
            return existing

        now = timezone.now()
        funding_mode = cls.current_funding_mode()
        try:
            with transaction.atomic():
                reservation = BillingReservation.objects.create(
                    organization_id=organization_id,
                    user_id=user_id,
                    logical_search_invocation_id=logical_search_invocation_id,
                    request_fingerprint=request_fingerprint,
                    fingerprint_version=fingerprint_version,
                    meter_key=meter_key,
                    quantity=pricing.quantity,
                    unit="request",
                    pricing_rule_id=pricing.pricing_rule_id,
                    unit_price=pricing.unit_price,
                    total_credits=pricing.total_credits,
                    funding_mode=funding_mode,
                    provider_key=provider_key,
                    biz_type=biz_type,
                    thread_id=thread_id,
                    status=BillingReservation.Status.RESERVED,
                    reserved_at=now,
                    lease_expires_at=now + cls.RESERVATION_LEASE,
                    next_recovery_at=now + cls.RESERVATION_LEASE,
                )
        except IntegrityError:
            existing = BillingReservation.objects.select_for_update().get(
                organization_id=organization_id,
                logical_search_invocation_id=logical_search_invocation_id,
            )
            cls._validate_replay(existing, request_fingerprint)
            return existing

        policy = OrganizationBillingPolicyService.get_effective_policy(organization_id)
        try:
            allocations = FundingAllocator.reserve_funding(
                organization=organization_id,
                provider_key=provider_key,
                model_id="",
                required_credits=pricing.total_credits,
                billing_context={
                    "llm_billing_mode": (
                        policy.get("llm_billing_mode")
                        or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
                    ),
                    "wallet_freeze_reference": cls.wallet_freeze_reference(reservation.id),
                    "idempotency_key": f"search-reservation:{reservation.id}",
                },
                funding_mode=funding_mode,
                funding_purpose=FUNDING_PURPOSE_SEARCH_WEB,
            )
        except Exception as exc:
            from apps.users.wallet.exceptions import InsufficientCreditsError

            if isinstance(exc, InsufficientCreditsError):
                raise SearchReservationInsufficientFunds(str(exc)) from exc
            raise

        for allocation in allocations:
            metadata = dict(allocation.metadata or {})
            source_reference = (
                metadata.get("freeze_reference")
                if allocation.source_type == ORGANIZATION_WALLET
                else allocation.source_id
            )
            BillingReservationAllocation.objects.create(
                reservation=reservation,
                source_type=allocation.source_type,
                source_reference=str(source_reference),
                provider_credit_grant_id=(
                    allocation.source_id
                    if allocation.source_type == PROVIDER_CREDIT
                    else None
                ),
                monthly_budget_id=(
                    allocation.source_id
                    if allocation.source_type == MONTHLY_BUDGET
                    else None
                ),
                organization_wallet_id=(
                    allocation.source_id
                    if allocation.source_type == ORGANIZATION_WALLET
                    else None
                ),
                credits=allocation.credits,
                metadata=metadata,
            )
        return reservation

    @staticmethod
    def _validate_replay(
        reservation: BillingReservation,
        request_fingerprint: str,
    ) -> None:
        if reservation.request_fingerprint != request_fingerprint:
            raise SearchReservationConflict(
                "同一搜索调用标识对应了不同请求"
            )

    @staticmethod
    def wallet_freeze_reference(reservation_id) -> str:
        return f"search-reservation:{reservation_id}"

    @classmethod
    @transaction.atomic
    def acquire_execution(
        cls,
        reservation_id,
    ) -> tuple[BillingReservation, ProviderAttempt | None, bool]:
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.status != BillingReservation.Status.RESERVED:
            return reservation, None, False
        now = timezone.now()
        reservation.status = BillingReservation.Status.EXECUTING
        reservation.execution_started_at = now
        reservation.lease_expires_at = now + cls.EXECUTION_LEASE
        reservation.next_recovery_at = reservation.lease_expires_at
        reservation.save(
            update_fields=[
                "status",
                "execution_started_at",
                "lease_expires_at",
                "next_recovery_at",
                "updated_at",
            ]
        )
        attempt = ProviderAttempt.objects.create(
            reservation=reservation,
            provider_key=reservation.provider_key,
            attempt_number=1,
            generation=reservation.generation,
        )
        return reservation, attempt, True

    @classmethod
    @transaction.atomic
    def record_provider_success(
        cls,
        reservation_id,
        *,
        provider_request_id: str,
        result_reference: str,
        result_metadata: dict[str, Any],
    ) -> BillingReservation:
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.status == BillingReservation.Status.COMMITTED:
            return reservation
        if reservation.status != BillingReservation.Status.EXECUTING:
            raise SearchReservationInProgress(
                f"Reservation 状态不允许记录 Provider 成功: {reservation.status}"
            )
        now = timezone.now()
        ProviderAttempt.objects.filter(
            reservation=reservation,
            generation=reservation.generation,
            outcome=ProviderAttempt.Outcome.STARTED,
        ).update(
            outcome=ProviderAttempt.Outcome.SUCCEEDED,
            provider_request_id=str(provider_request_id or "")[:255],
            finished_at=now,
        )
        reservation.status = BillingReservation.Status.SETTLEMENT_PENDING
        reservation.provider_finished_at = now
        reservation.result_reference = str(result_reference or "")[:255]
        reservation.result_metadata = dict(result_metadata or {})
        reservation.lease_expires_at = now + cls.RECOVERY_DELAY
        reservation.next_recovery_at = now
        reservation.save(
            update_fields=[
                "status",
                "provider_finished_at",
                "result_reference",
                "result_metadata",
                "lease_expires_at",
                "next_recovery_at",
                "updated_at",
            ]
        )
        return reservation

    @classmethod
    @transaction.atomic
    def record_provider_failure(
        cls,
        reservation_id,
        *,
        error_code: str,
    ) -> BillingReservation:
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.status in {
            BillingReservation.Status.RELEASED,
            BillingReservation.Status.EXPIRED,
        }:
            return reservation
        if reservation.status != BillingReservation.Status.EXECUTING:
            raise SearchReservationInProgress(
                f"Reservation 状态不允许记录 Provider 失败: {reservation.status}"
            )
        now = timezone.now()
        ProviderAttempt.objects.filter(
            reservation=reservation,
            generation=reservation.generation,
            outcome=ProviderAttempt.Outcome.STARTED,
        ).update(
            outcome=ProviderAttempt.Outcome.FAILED,
            error_code=str(error_code or "search_provider_error")[:100],
            finished_at=now,
        )
        cls._release_locked(
            reservation,
            final_status=BillingReservation.Status.RELEASED,
            reason=str(error_code or "provider_failure")[:255],
        )
        return reservation

    @classmethod
    @transaction.atomic
    def resolve_unknown_as_success(
        cls,
        reservation_id,
        *,
        resolved_by: str,
        resolution_reason: str,
        provider_request_id: str = "",
        result_reference: str = "",
        result_metadata: dict[str, Any] | None = None,
    ) -> BillingReservation:
        """运营确认 Provider 已成功；只开放结算，不重新执行 Provider。"""
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.status == BillingReservation.Status.SETTLEMENT_PENDING:
            return reservation
        if reservation.status != BillingReservation.Status.UNKNOWN:
            raise SearchReservationInProgress(
                f"只有 UNKNOWN Reservation 可人工确认成功: {reservation.status}"
            )
        now = timezone.now()
        ProviderAttempt.objects.filter(
            reservation=reservation,
            generation=reservation.generation,
            outcome=ProviderAttempt.Outcome.UNKNOWN,
        ).update(
            outcome=ProviderAttempt.Outcome.SUCCEEDED,
            provider_request_id=str(provider_request_id or "")[:255],
            finished_at=now,
        )
        reservation.status = BillingReservation.Status.SETTLEMENT_PENDING
        reservation.provider_finished_at = now
        reservation.result_reference = str(result_reference or "")[:255]
        reservation.result_metadata = dict(result_metadata or {})
        reservation.last_checked_at = now
        reservation.next_recovery_at = now
        reservation.resolution_reason = str(resolution_reason or "provider_success_confirmed")[:255]
        reservation.resolved_by = str(resolved_by or "")[:100]
        reservation.save(
            update_fields=[
                "status",
                "provider_finished_at",
                "result_reference",
                "result_metadata",
                "last_checked_at",
                "next_recovery_at",
                "resolution_reason",
                "resolved_by",
                "updated_at",
            ]
        )
        return reservation

    @classmethod
    @transaction.atomic
    def resolve_unknown_as_no_cost(
        cls,
        reservation_id,
        *,
        resolved_by: str,
        resolution_reason: str,
    ) -> BillingReservation:
        """运营确认 Provider 未产生成本后释放冻结资金。"""
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.status == BillingReservation.Status.RELEASED:
            return reservation
        if reservation.status != BillingReservation.Status.UNKNOWN:
            raise SearchReservationInProgress(
                f"只有 UNKNOWN Reservation 可人工确认无成本: {reservation.status}"
            )
        reservation.resolved_by = str(resolved_by or "")[:100]
        cls._release_locked(
            reservation,
            final_status=BillingReservation.Status.RELEASED,
            reason=str(resolution_reason or "provider_no_cost_confirmed")[:255],
        )
        reservation.save(update_fields=["resolved_by", "updated_at"])
        return reservation

    @classmethod
    @transaction.atomic
    def mark_unknown(cls, reservation_id, *, reason: str) -> BillingReservation:
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.status != BillingReservation.Status.EXECUTING:
            return reservation
        now = timezone.now()
        ProviderAttempt.objects.filter(
            reservation=reservation,
            generation=reservation.generation,
            outcome=ProviderAttempt.Outcome.STARTED,
        ).update(
            outcome=ProviderAttempt.Outcome.UNKNOWN,
            error_code=str(reason or "provider_result_unknown")[:100],
            finished_at=now,
        )
        reservation.status = BillingReservation.Status.UNKNOWN
        reservation.first_seen_at = reservation.first_seen_at or now
        reservation.last_checked_at = now
        reservation.next_recovery_at = now + cls.RECOVERY_DELAY
        reservation.resolution_reason = str(reason or "provider_result_unknown")[:255]
        reservation.save(
            update_fields=[
                "status",
                "first_seen_at",
                "last_checked_at",
                "next_recovery_at",
                "resolution_reason",
                "updated_at",
            ]
        )
        logger.error(
            "[SearchReservation] provider outcome unknown: reservation=%s provider=%s",
            reservation.id,
            reservation.provider_key,
        )
        return reservation

    @classmethod
    @transaction.atomic
    def settle(cls, reservation_id) -> dict[str, Any]:
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.status == BillingReservation.Status.COMMITTED:
            event = BillingUsageEvent.objects.filter(
                idempotency_key=cls.usage_event_idempotency_key(reservation.id)
            ).first()
            return {"committed": True, "already_committed": True, "event": event}
        if reservation.status != BillingReservation.Status.SETTLEMENT_PENDING:
            raise SearchReservationInProgress(
                f"Reservation 尚不可结算: {reservation.status}"
            )

        now = timezone.now()
        allocations = list(
            BillingReservationAllocation.objects.select_for_update()
            .filter(reservation=reservation)
            .order_by("created_at", "id")
        )
        wallet_debit = Decimal("0")
        serialized_allocations: list[dict[str, Any]] = []
        wallet_transaction_id = ""
        for allocation in allocations:
            amount = cls._quantize(allocation.credits)
            if allocation.status == BillingReservationAllocation.Status.COMMITTED:
                serialized_allocations.append(cls._serialize_allocation(allocation))
                if allocation.source_type == ORGANIZATION_WALLET:
                    wallet_debit += amount
                continue
            if allocation.source_type == PROVIDER_CREDIT:
                cls._commit_provider_credit(allocation, reservation, now)
            elif allocation.source_type == MONTHLY_BUDGET:
                cls._commit_monthly_budget(allocation, now)
            elif allocation.source_type == ORGANIZATION_WALLET:
                wallet_result = CreditsService.settle_frozen_credits_with_debit(
                    str(reservation.organization_id),
                    allocation.source_reference,
                    amount,
                    operator_user_id=reservation.user_id,
                    description=f"联网搜索 {reservation.id} 消耗 {amount} 点券",
                    billing_metadata={"reservation_id": str(reservation.id)},
                )
                if not wallet_result.get("settled"):
                    raise RuntimeError(
                        f"Wallet freeze settlement failed: {wallet_result.get('reason')}"
                    )
                wallet_debit += amount
                wallet_transaction_id = str(
                    wallet_result.get("wallet_transaction_id") or ""
                )
            allocation.status = BillingReservationAllocation.Status.COMMITTED
            allocation.committed_at = now
            allocation.save(update_fields=["status", "committed_at"])
            serialized_allocations.append(cls._serialize_allocation(allocation))

        event, _ = BillingUsageEvent.objects.get_or_create(
            idempotency_key=cls.usage_event_idempotency_key(reservation.id),
            defaults={
                "organization_id": reservation.organization_id,
                "user_id": reservation.user_id,
                "meter_key": reservation.meter_key,
                "quantity": reservation.quantity,
                "unit": reservation.unit,
                "unit_price": reservation.unit_price,
                "amount": cls._quantize(wallet_debit),
                "currency": "CREDITS",
                "provider_key": reservation.provider_key,
                "biz_type": reservation.biz_type,
                "biz_id": reservation.result_reference,
                "charge_status": "charged",
                "charged_at": now,
                "metadata": {
                    "status": "charged",
                    "reservation_id": str(reservation.id),
                    "logical_search_invocation_id": str(
                        reservation.logical_search_invocation_id
                    ),
                    "request_fingerprint": reservation.request_fingerprint,
                    "funding_mode": reservation.funding_mode,
                    "raw_credits_cost": str(cls._quantize(reservation.total_credits)),
                    "funding_allocations": {
                        "total_credits": str(cls._quantize(reservation.total_credits)),
                        "allocations": serialized_allocations,
                    },
                    "thread_id": reservation.thread_id,
                },
            },
        )
        if wallet_transaction_id:
            WalletTransaction.objects.filter(id=wallet_transaction_id).update(
                related_order_id=str(event.id),
                usage_event_id=str(event.id),
            )
        reservation.status = BillingReservation.Status.COMMITTED
        reservation.settled_at = now
        reservation.next_recovery_at = None
        reservation.save(
            update_fields=["status", "settled_at", "next_recovery_at", "updated_at"]
        )
        return {"committed": True, "already_committed": False, "event": event}

    @classmethod
    def _commit_provider_credit(
        cls,
        allocation: BillingReservationAllocation,
        reservation: BillingReservation,
        now,
    ) -> None:
        grant = ProviderCreditGrant.objects.select_for_update().get(
            pk=allocation.provider_credit_grant_id
        )
        amount = cls._quantize(allocation.credits)
        if cls._quantize(grant.active_reserved_credits) < amount:
            raise RuntimeError("Sponsored active_reserved_credits 不足")
        if cls._quantize(grant.remaining_credits) < amount:
            raise RuntimeError("Sponsored remaining_credits 不足")
        grant.active_reserved_credits = cls._quantize(
            grant.active_reserved_credits - amount
        )
        grant.remaining_credits = cls._quantize(grant.remaining_credits - amount)
        grant.consumed_credits = cls._quantize(grant.consumed_credits + amount)
        if grant.remaining_credits == 0:
            grant.status = ProviderCreditGrant.Status.EXHAUSTED
        grant.save(
            update_fields=[
                "active_reserved_credits",
                "remaining_credits",
                "consumed_credits",
                "status",
                "updated_at",
            ]
        )
        ProviderCreditTransaction.objects.get_or_create(
            idempotency_key=f"search-reservation-consume:{reservation.id}:{grant.id}",
            defaults={
                "grant": grant,
                "organization_id": grant.organization_id,
                "transaction_type": ProviderCreditTransaction.TransactionType.CONSUME,
                "amount": -amount,
                "balance_after": grant.remaining_credits,
                "reference_type": "billing_reservation",
                "reference_id": str(reservation.id),
                "metadata": {
                    "funding_purpose": FUNDING_PURPOSE_SEARCH_WEB,
                    "reserved_before_expiry": True,
                },
            },
        )

    @classmethod
    def _commit_monthly_budget(
        cls,
        allocation: BillingReservationAllocation,
        now,
    ) -> None:
        budget = OrganizationLlmMonthlyBudget.objects.select_for_update().get(
            pk=allocation.monthly_budget_id
        )
        amount = cls._quantize(allocation.credits)
        if cls._quantize(budget.active_reserved_credits) < amount:
            raise RuntimeError("Monthly active_reserved_credits 不足")
        budget.active_reserved_credits = cls._quantize(
            budget.active_reserved_credits - amount
        )
        budget.consumed_credits = cls._quantize(
            budget.consumed_credits + amount
        )
        budget.save(
            update_fields=["active_reserved_credits", "consumed_credits", "updated_at"]
        )
        OrganizationLlmBudgetService._invalidate_quota_remaining_cache(
            str(budget.organization_id),
            budget.cycle_month,
        )

    @staticmethod
    def _serialize_allocation(
        allocation: BillingReservationAllocation,
    ) -> dict[str, Any]:
        return {
            "source_type": allocation.source_type,
            "source_id": allocation.source_reference,
            "credits": str(allocation.credits),
            **({"metadata": allocation.metadata} if allocation.metadata else {}),
        }

    @classmethod
    @transaction.atomic
    def release(
        cls,
        reservation_id,
        *,
        expired: bool = False,
        reason: str = "",
    ) -> BillingReservation:
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        cls._release_locked(
            reservation,
            final_status=(
                BillingReservation.Status.EXPIRED
                if expired
                else BillingReservation.Status.RELEASED
            ),
            reason=reason,
        )
        return reservation

    @classmethod
    def _release_locked(
        cls,
        reservation: BillingReservation,
        *,
        final_status: str,
        reason: str,
    ) -> None:
        if reservation.status in {
            BillingReservation.Status.COMMITTED,
            BillingReservation.Status.RELEASED,
            BillingReservation.Status.EXPIRED,
        }:
            return
        now = timezone.now()
        allocations = list(
            BillingReservationAllocation.objects.select_for_update()
            .filter(
                reservation=reservation,
                status=BillingReservationAllocation.Status.RESERVED,
            )
            .order_by("created_at", "id")
        )
        for allocation in allocations:
            amount = cls._quantize(allocation.credits)
            if allocation.source_type == PROVIDER_CREDIT:
                grant = ProviderCreditGrant.objects.select_for_update().get(
                    pk=allocation.provider_credit_grant_id
                )
                grant.active_reserved_credits = max(
                    cls._quantize(0),
                    cls._quantize(grant.active_reserved_credits) - amount,
                )
                grant.save(update_fields=["active_reserved_credits", "updated_at"])
            elif allocation.source_type == MONTHLY_BUDGET:
                budget = OrganizationLlmMonthlyBudget.objects.select_for_update().get(
                    pk=allocation.monthly_budget_id
                )
                budget.active_reserved_credits = max(
                    cls._quantize(0),
                    cls._quantize(budget.active_reserved_credits) - amount,
                )
                budget.save(update_fields=["active_reserved_credits", "updated_at"])
                OrganizationLlmBudgetService._invalidate_quota_remaining_cache(
                    str(budget.organization_id),
                    budget.cycle_month,
                )
            elif allocation.source_type == ORGANIZATION_WALLET:
                CreditsService.release_frozen_credits(
                    str(reservation.organization_id),
                    allocation.source_reference,
                )
            allocation.status = BillingReservationAllocation.Status.RELEASED
            allocation.released_at = now
            allocation.save(update_fields=["status", "released_at"])
        reservation.status = final_status
        reservation.released_at = now
        reservation.next_recovery_at = None
        reservation.resolution_reason = str(reason or "")[:255]
        reservation.save(
            update_fields=[
                "status",
                "released_at",
                "next_recovery_at",
                "resolution_reason",
                "updated_at",
            ]
        )

    @staticmethod
    def usage_event_idempotency_key(reservation_id) -> str:
        return f"search-reservation:{reservation_id}"

    @classmethod
    def sweep(cls, *, limit: int = 100) -> dict[str, int]:
        """有界恢复：只自动释放未执行项，执行结果未知时绝不退款或重发。"""
        now = timezone.now()
        with transaction.atomic():
            candidate_ids = list(
                BillingReservation.objects.select_for_update(skip_locked=True)
                .filter(
                    Q(
                        status__in=[
                            BillingReservation.Status.RESERVED,
                            BillingReservation.Status.EXECUTING,
                        ],
                        lease_expires_at__lte=now,
                    )
                    | Q(
                        status__in=[
                            BillingReservation.Status.SETTLEMENT_PENDING,
                            BillingReservation.Status.UNKNOWN,
                        ],
                        next_recovery_at__lte=now,
                    )
                )
                .order_by("next_recovery_at", "lease_expires_at", "created_at")
                .values_list("id", flat=True)[: max(1, min(int(limit), 500))]
            )

        stats = {"expired": 0, "unknown": 0, "settled": 0, "checked": 0, "errors": 0}
        for reservation_id in candidate_ids:
            try:
                reservation = BillingReservation.objects.get(pk=reservation_id)
                if reservation.status == BillingReservation.Status.RESERVED:
                    cls.release(
                        reservation_id,
                        expired=True,
                        reason="reservation_lease_expired",
                    )
                    stats["expired"] += 1
                elif reservation.status == BillingReservation.Status.EXECUTING:
                    cls.mark_unknown(
                        reservation_id,
                        reason="execution_lease_expired",
                    )
                    stats["unknown"] += 1
                elif reservation.status == BillingReservation.Status.SETTLEMENT_PENDING:
                    cls.settle(reservation_id)
                    stats["settled"] += 1
                elif reservation.status == BillingReservation.Status.UNKNOWN:
                    cls._touch_unknown(reservation_id)
                    stats["checked"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception(
                    "[SearchReservation] recovery failed: reservation=%s",
                    reservation_id,
                )
        return stats

    @classmethod
    @transaction.atomic
    def _touch_unknown(cls, reservation_id) -> None:
        reservation = BillingReservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.status != BillingReservation.Status.UNKNOWN:
            return
        now = timezone.now()
        reservation.last_checked_at = now
        reservation.next_recovery_at = now + cls.RECOVERY_DELAY
        reservation.recovery_attempt_count += 1
        reservation.save(
            update_fields=[
                "last_checked_at",
                "next_recovery_at",
                "recovery_attempt_count",
                "updated_at",
            ]
        )
        logger.error(
            "[SearchReservation] UNKNOWN requires operator reconciliation: reservation=%s attempts=%s",
            reservation.id,
            reservation.recovery_attempt_count,
        )


__all__ = [
    "SearchBillingReservationService",
    "SearchPricingSnapshot",
    "SearchReservationConflict",
    "SearchReservationError",
    "SearchReservationInProgress",
    "SearchReservationInsufficientFunds",
]

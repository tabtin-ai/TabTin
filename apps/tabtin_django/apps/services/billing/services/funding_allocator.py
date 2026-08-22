"""Provider Credit → Monthly Budget → OrganizationWallet 资金分配器。

Provider Credit 与 Monthly Budget 的变更在调用方的结算事务中完成；Wallet 仅在
此处形成计划，继续由 CreditsService 使用既有 Wallet 写入实现执行。任一后续步骤
失败时，外层 transaction.atomic() 会同时释放 Provider/Monthly 的事务内预占。
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.services.billing.models import ProviderCreditGrant
from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService
from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
from apps.services.billing.services.provider_credit_service import (
    ProviderCreditService,
    matches_provider_credit,
)


PROVIDER_CREDIT = "provider_credit"
MONTHLY_BUDGET = "monthly_budget"
ORGANIZATION_WALLET = "organization_wallet"
FUNDING_MODE_PROVIDER_CREDIT_V1 = "provider_credit_v1"
FUNDING_MODE_LEGACY_BUDGET_WALLET = "legacy_budget_wallet"
FUNDING_PURPOSE_LLM = "llm"
FUNDING_PURPOSE_SEARCH_WEB = "search.web.request"


@dataclass(frozen=True)
class FundingAllocation:
    """一段实际或计划使用的资金来源。"""

    source_type: str
    source_id: str
    credits: Decimal
    metadata: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_type": self.source_type,
            "source_id": self.source_id,
            "credits": str(self.credits),
            **({"metadata": self.metadata} if self.metadata else {}),
        }


class FundingAllocator:
    """按 Sponsored → Monthly → Wallet 顺序分配 credits。"""

    CREDITS_QUANT = Decimal("0.0001")

    @classmethod
    def is_enabled(cls, funding_mode: str | None = None) -> bool:
        """解析当前或 invocation 已冻结的资金模式。"""
        normalized = str(funding_mode or "").strip()
        if not normalized:
            return bool(
                getattr(settings, "PROVIDER_CREDIT_FUNDING_ENABLED", False)
            )
        if normalized == FUNDING_MODE_PROVIDER_CREDIT_V1:
            return True
        if normalized == FUNDING_MODE_LEGACY_BUDGET_WALLET:
            return False
        raise ValidationError({"funding_mode": f"未知 funding_mode: {normalized}"})

    @classmethod
    def _quantize(cls, value: Any) -> Decimal:
        try:
            amount = Decimal(str(value or 0))
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise ValidationError({"required_credits": "required_credits 必须是合法 Decimal"}) from exc
        if not amount.is_finite():
            raise ValidationError({"required_credits": "required_credits 必须是有限 Decimal"})
        return amount.quantize(cls.CREDITS_QUANT)

    @staticmethod
    def _canonical_model_id(model_id: Any) -> str:
        try:
            return str(uuid.UUID(str(model_id)))
        except (AttributeError, TypeError, ValueError):
            return ""

    @staticmethod
    def _stable_reference(billing_context: dict[str, Any]) -> str:
        raw = str(
            billing_context.get("idempotency_key")
            or billing_context.get("billing_key")
            or billing_context.get("request_id")
            or billing_context.get("biz_id")
            or uuid.uuid4()
        ).strip()
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @classmethod
    def _eligible_provider_grants(
        cls,
        *,
        organization_id: str,
        provider_key: str,
        model_id: str,
        current_time,
        funding_purpose: str,
        for_update: bool,
    ):
        """返回同一套 Sponsored 候选；preview/reserve/即时结算共同复用。"""
        filters = {
            "organization_id": organization_id,
            "status": ProviderCreditGrant.Status.ACTIVE,
            "effective_at__lte": current_time,
            "remaining_credits__gt": 0,
        }
        if funding_purpose != FUNDING_PURPOSE_SEARCH_WEB:
            if not provider_key or not model_id:
                return []
            filters["provider_key"] = provider_key

        queryset = (
            ProviderCreditGrant.objects.filter(**filters)
            .filter(Q(expire_at__isnull=True) | Q(expire_at__gt=current_time))
            .order_by(F("expire_at").asc(nulls_last=True), "created_at", "id")
        )
        if for_update:
            queryset = queryset.select_for_update()
        else:
            queryset = queryset.select_related("campaign")

        if funding_purpose == FUNDING_PURPOSE_SEARCH_WEB:
            return queryset
        return [
            grant
            for grant in queryset
            if matches_provider_credit(grant, provider_key, model_id)
        ]

    @classmethod
    def preview_funding(
        cls,
        organization,
        provider_key,
        model_id,
        required_credits,
        billing_context,
        funding_mode: str | None = None,
        funding_purpose: str = FUNDING_PURPOSE_LLM,
    ) -> list[FundingAllocation]:
        """只读计算资金顺序，不创建流水、消费预算或失效缓存。"""
        required = cls._quantize(required_credits)
        if required <= 0 or not cls.is_enabled(funding_mode):
            return []

        organization_id = str(getattr(organization, "pk", organization) or "").strip()
        if not organization_id:
            raise ValidationError({"organization": "organization 不能为空"})

        context = dict(billing_context or {})
        current_time = context.get("at") or timezone.now()
        canonical_model_id = cls._canonical_model_id(model_id)
        canonical_provider_key = str(provider_key or "").strip().lower()
        allocations: list[FundingAllocation] = []
        remaining = required

        grants = cls._eligible_provider_grants(
            organization_id=organization_id,
            provider_key=canonical_provider_key,
            model_id=canonical_model_id,
            current_time=current_time,
            funding_purpose=funding_purpose,
            for_update=False,
        )
        for grant in grants:
            if remaining <= 0:
                break
            available = max(
                cls._quantize(0),
                cls._quantize(grant.remaining_credits)
                - cls._quantize(grant.active_reserved_credits),
            )
            reserved = min(remaining, available)
            if reserved <= 0:
                continue
            allocations.append(
                FundingAllocation(
                    source_type=PROVIDER_CREDIT,
                    source_id=str(grant.id),
                    credits=reserved,
                    metadata={"campaign_id": str(grant.campaign_id)},
                )
            )
            remaining = cls._quantize(remaining - reserved)

        llm_billing_mode = str(
            context.get("llm_billing_mode")
            or OrganizationBillingPolicyService.get_effective_policy(
                organization_id
            ).get("llm_billing_mode")
            or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
        )
        quota_available = cls._quantize(0)
        if llm_billing_mode != "paygo_only" and remaining > 0:
            quota_available = cls._quantize(
                OrganizationLlmBudgetService.get_remaining_quota_credits(
                    organization_id,
                    at_time=current_time,
                    sync_entitlement=False,
                )
            )
        monthly_credits = min(remaining, quota_available)
        if monthly_credits > 0:
            cycle_month = OrganizationLlmBudgetService.cycle_month(current_time)
            allocations.append(
                FundingAllocation(
                    source_type=MONTHLY_BUDGET,
                    source_id=f"{organization_id}:{cycle_month.isoformat()}",
                    credits=monthly_credits,
                    metadata={"cycle_month": cycle_month.isoformat()},
                )
            )
            remaining = cls._quantize(remaining - monthly_credits)

        if remaining > 0:
            from apps.users.wallet.models import OrganizationWallet

            wallet_id = (
                OrganizationWallet.objects.filter(
                    organization_id=organization_id
                )
                .values_list("id", flat=True)
                .first()
            )
            allocations.append(
                FundingAllocation(
                    source_type=ORGANIZATION_WALLET,
                    source_id=str(wallet_id or organization_id),
                    credits=remaining,
                )
            )

        return allocations

    @classmethod
    @transaction.atomic
    def allocate_funding(
        cls,
        organization,
        provider_key,
        model_id,
        required_credits,
        billing_context,
        funding_mode: str | None = None,
        funding_purpose: str = FUNDING_PURPOSE_LLM,
    ) -> list[FundingAllocation]:
        """预占 Provider/Monthly，并返回包含 Wallet 计划的完整资金分配。

        调用方必须在同一外层事务中完成 Wallet 扣减和 BillingUsageEvent 更新。
        这样 settle 是事务提交，release 是任一步失败后的事务回滚，不存在
        Provider 已扣但 Wallet/事实记录失败的半笔账。
        """
        required = cls._quantize(required_credits)
        if required <= 0:
            return []
        if not cls.is_enabled(funding_mode):
            return []

        organization_id = str(getattr(organization, "pk", organization) or "").strip()
        if not organization_id:
            raise ValidationError({"organization": "organization 不能为空"})

        context = dict(billing_context or {})
        allocations: list[FundingAllocation] = []
        remaining = required
        stable_reference = cls._stable_reference(context)
        current_time = context.get("at") or timezone.now()
        canonical_model_id = cls._canonical_model_id(model_id)
        canonical_provider_key = str(provider_key or "").strip().lower()

        grants = cls._eligible_provider_grants(
            organization_id=organization_id,
            provider_key=canonical_provider_key,
            model_id=canonical_model_id,
            current_time=current_time,
            funding_purpose=funding_purpose,
            for_update=True,
        )
        for grant in grants:
            if remaining <= 0:
                break
            available = max(
                cls._quantize(0),
                cls._quantize(grant.remaining_credits)
                - cls._quantize(grant.active_reserved_credits),
            )
            reserved = min(remaining, available)
            if reserved <= 0:
                continue
            credit_transaction = ProviderCreditService.record_transaction(
                grant=grant,
                transaction_type="consume",
                amount=-reserved,
                idempotency_key=(
                    f"provider-credit-funding:{stable_reference}:{grant.id}"
                ),
                reference_type="billing_usage_event",
                reference_id=str(
                    context.get("idempotency_key")
                    or context.get("billing_key")
                    or context.get("request_id")
                    or ""
                )[:128],
                metadata={
                    "funding_phase": "reserved",
                    "funding_purpose": funding_purpose,
                    "provider_key": canonical_provider_key,
                    "model_id": canonical_model_id,
                },
            )
            allocations.append(
                FundingAllocation(
                    source_type=PROVIDER_CREDIT,
                    source_id=str(grant.id),
                    credits=reserved,
                    metadata={
                        "campaign_id": str(grant.campaign_id),
                        "transaction_id": str(credit_transaction.id),
                    },
                )
            )
            remaining = cls._quantize(remaining - reserved)

        llm_billing_mode = str(
            context.get("llm_billing_mode")
            or OrganizationBillingPolicyService.get_effective_policy(
                organization_id
            ).get("llm_billing_mode")
            or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
        )
        budget_result = OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=organization_id,
            requested_credits=remaining,
            llm_billing_mode=llm_billing_mode,
            at_time=current_time,
        )
        monthly_credits = cls._quantize(
            budget_result.get("quota_covered_credits", 0)
        )
        if monthly_credits > 0:
            allocations.append(
                FundingAllocation(
                    source_type=MONTHLY_BUDGET,
                    source_id=(
                        f"{organization_id}:{budget_result.get('cycle_month', '')}"
                    ),
                    credits=monthly_credits,
                    metadata={
                        "cycle_month": budget_result.get("cycle_month", ""),
                    },
                )
            )

        wallet_credits = cls._quantize(budget_result.get("paygo_credits", 0))
        if wallet_credits > 0:
            from apps.users.wallet.models import OrganizationWallet

            wallet_id = (
                OrganizationWallet.objects.filter(
                    organization_id=organization_id
                )
                .values_list("id", flat=True)
                .first()
            )
            allocations.append(
                FundingAllocation(
                    source_type=ORGANIZATION_WALLET,
                    source_id=str(wallet_id or organization_id),
                    credits=wallet_credits,
                )
            )

        allocated = sum((item.credits for item in allocations), Decimal("0"))
        if cls._quantize(allocated) != required:
            raise ValidationError(
                {
                    "required_credits": (
                        "FundingAllocator 分配结果与 required_credits 不一致"
                    )
                }
            )
        return allocations

    @classmethod
    @transaction.atomic
    def reserve_funding(
        cls,
        *,
        organization,
        provider_key,
        model_id,
        required_credits,
        billing_context,
        funding_mode: str,
        funding_purpose: str,
    ) -> list[FundingAllocation]:
        """原子冻结资金，不消费余额；用于 Provider 调用前的 Reservation。"""
        from apps.users.wallet.exceptions import InsufficientCreditsError
        from apps.users.wallet.models import OrganizationWallet
        from apps.users.wallet.services.credits_service import CreditsService

        required = cls._quantize(required_credits)
        if required < 0:
            raise ValidationError({"required_credits": "required_credits 不能为负数"})
        if required == 0:
            return []

        organization_id = str(getattr(organization, "pk", organization) or "").strip()
        if not organization_id:
            raise ValidationError({"organization": "organization 不能为空"})
        context = dict(billing_context or {})
        current_time = context.get("at") or timezone.now()
        canonical_provider_key = str(provider_key or "").strip().lower()
        canonical_model_id = cls._canonical_model_id(model_id)
        remaining = required
        allocations: list[FundingAllocation] = []

        if cls.is_enabled(funding_mode):
            grants = cls._eligible_provider_grants(
                organization_id=organization_id,
                provider_key=canonical_provider_key,
                model_id=canonical_model_id,
                current_time=current_time,
                funding_purpose=funding_purpose,
                for_update=True,
            )
            for grant in grants:
                if remaining <= 0:
                    break
                available = max(
                    cls._quantize(0),
                    cls._quantize(grant.remaining_credits)
                    - cls._quantize(grant.active_reserved_credits),
                )
                amount = min(remaining, available)
                if amount <= 0:
                    continue
                grant.active_reserved_credits = cls._quantize(
                    grant.active_reserved_credits + amount
                )
                grant.save(update_fields=["active_reserved_credits", "updated_at"])
                allocations.append(
                    FundingAllocation(
                        source_type=PROVIDER_CREDIT,
                        source_id=str(grant.id),
                        credits=amount,
                        metadata={
                            "campaign_id": str(grant.campaign_id),
                            "funding_purpose": funding_purpose,
                        },
                    )
                )
                remaining = cls._quantize(remaining - amount)

        llm_billing_mode = str(
            context.get("llm_billing_mode")
            or OrganizationBillingPolicyService.get_effective_policy(
                organization_id
            ).get("llm_billing_mode")
            or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
        )
        if llm_billing_mode != "paygo_only" and remaining > 0:
            budget = OrganizationLlmBudgetService.get_or_create_monthly_budget_locked(
                organization_id,
                at_time=current_time,
            )
            available = max(
                cls._quantize(0),
                cls._quantize(budget.included_credits)
                + cls._quantize(budget.topup_credits)
                - cls._quantize(budget.consumed_credits)
                - cls._quantize(budget.active_reserved_credits),
            )
            amount = min(remaining, available)
            if amount > 0:
                budget.active_reserved_credits = cls._quantize(
                    budget.active_reserved_credits + amount
                )
                budget.save(update_fields=["active_reserved_credits", "updated_at"])
                OrganizationLlmBudgetService._invalidate_quota_remaining_cache(
                    organization_id,
                    budget.cycle_month,
                )
                allocations.append(
                    FundingAllocation(
                        source_type=MONTHLY_BUDGET,
                        source_id=str(budget.id),
                        credits=amount,
                        metadata={"cycle_month": budget.cycle_month.isoformat()},
                    )
                )
                remaining = cls._quantize(remaining - amount)

        if remaining > 0:
            freeze_reference = str(
                context.get("wallet_freeze_reference") or ""
            ).strip()
            if not freeze_reference:
                raise ValidationError(
                    {"wallet_freeze_reference": "Wallet 预留必须提供稳定引用"}
                )
            frozen = CreditsService.freeze_credits_for_llm(
                organization_id,
                remaining,
                freeze_reference,
            )
            if not frozen:
                wallet = OrganizationWallet.objects.filter(
                    organization_id=organization_id
                ).first()
                available = (
                    wallet.get_available_credits_precise()
                    if wallet is not None
                    else Decimal("0")
                )
                raise InsufficientCreditsError(
                    message="组织点券余额不足",
                    required=remaining,
                    current=available,
                )
            wallet = OrganizationWallet.objects.get(organization_id=organization_id)
            allocations.append(
                FundingAllocation(
                    source_type=ORGANIZATION_WALLET,
                    source_id=str(wallet.id),
                    credits=remaining,
                    metadata={"freeze_reference": freeze_reference},
                )
            )
            remaining = cls._quantize(0)

        allocated = sum((item.credits for item in allocations), Decimal("0"))
        if cls._quantize(allocated) != required:
            raise ValidationError(
                {"required_credits": "FundingAllocator 预留结果与 required_credits 不一致"}
            )
        return allocations

    @classmethod
    def serialize(cls, allocations: list[FundingAllocation]) -> list[dict[str, Any]]:
        return [allocation.as_dict() for allocation in allocations]

    @classmethod
    def credits_for(
        cls,
        allocations: list[FundingAllocation],
        source_type: str,
    ) -> Decimal:
        return cls._quantize(
            sum(
                (
                    allocation.credits
                    for allocation in allocations
                    if allocation.source_type == source_type
                ),
                Decimal("0"),
            )
        )


def allocate_funding(
    organization,
    provider_key,
    model_id,
    required_credits,
    billing_context,
    funding_mode: str | None = None,
) -> list[FundingAllocation]:
    """函数式兼容入口。"""
    return FundingAllocator.allocate_funding(
        organization,
        provider_key,
        model_id,
        required_credits,
        billing_context,
        funding_mode,
    )


__all__ = [
    "FundingAllocation",
    "FundingAllocator",
    "FUNDING_MODE_LEGACY_BUDGET_WALLET",
    "FUNDING_MODE_PROVIDER_CREDIT_V1",
    "FUNDING_PURPOSE_LLM",
    "FUNDING_PURPOSE_SEARCH_WEB",
    "MONTHLY_BUDGET",
    "ORGANIZATION_WALLET",
    "PROVIDER_CREDIT",
    "allocate_funding",
]

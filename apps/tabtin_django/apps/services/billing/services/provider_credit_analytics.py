"""Provider Credit 运营统计。

统计只读取 Provider Credit 自有 Grant/Transaction，不读取或改写 Wallet、
PaymentOrder、Monthly Budget。
"""

from __future__ import annotations

from decimal import Decimal

from django.db.models import QuerySet

from apps.services.billing.models import (
    ProviderCreditCampaign,
    ProviderCreditGrant,
    ProviderCreditTransaction,
)


_ZERO = Decimal("0")


def _sum_amount(transactions, *, positive: bool | None = None) -> Decimal:
    total = _ZERO
    for raw_amount in transactions.values_list("amount", flat=True).iterator():
        amount = Decimal(str(raw_amount))
        if positive is True and amount <= _ZERO:
            continue
        if positive is False and amount >= _ZERO:
            continue
        total += amount
    return total


class ProviderCreditAnalyticsService:
    """按 Campaign 或 Provider 聚合独立赠送额度账本。"""

    @classmethod
    def campaign_report(
        cls,
        campaign: ProviderCreditCampaign | str,
    ) -> dict:
        campaign_obj = (
            campaign
            if isinstance(campaign, ProviderCreditCampaign)
            else ProviderCreditCampaign.objects.get(code=str(campaign).strip())
        )
        grants = ProviderCreditGrant.objects.filter(campaign=campaign_obj)
        return cls._build_report(
            grants=grants,
            campaign=campaign_obj.code,
            provider=campaign_obj.provider_key,
        )

    @classmethod
    def provider_report(cls, provider_key: str) -> dict:
        normalized_provider = str(provider_key or "").strip().lower()
        grants = ProviderCreditGrant.objects.filter(provider_key=normalized_provider)
        return cls._build_report(
            grants=grants,
            campaign=None,
            provider=normalized_provider,
        )

    @classmethod
    def provider_reports(cls) -> list[dict]:
        provider_keys = (
            ProviderCreditGrant.objects.order_by()
            .values_list("provider_key", flat=True)
            .distinct()
        )
        return [cls.provider_report(provider_key) for provider_key in provider_keys]

    @staticmethod
    def _build_report(
        *,
        grants: QuerySet[ProviderCreditGrant],
        campaign: str | None,
        provider: str,
    ) -> dict:
        transactions = ProviderCreditTransaction.objects.filter(grant__in=grants)
        grant_transactions = transactions.filter(
            transaction_type=ProviderCreditTransaction.TransactionType.GRANT
        )
        adjustments = transactions.filter(
            transaction_type=ProviderCreditTransaction.TransactionType.ADJUST
        )
        consumes = transactions.filter(
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME
        )
        expires = transactions.filter(
            transaction_type=ProviderCreditTransaction.TransactionType.EXPIRE
        )

        initial_granted = _sum_amount(grant_transactions, positive=True)
        positive_adjustments = _sum_amount(adjustments, positive=True)
        negative_adjustments = -_sum_amount(adjustments, positive=False)
        consumed = -_sum_amount(consumes, positive=False)
        expired = -_sum_amount(expires, positive=False)
        remaining = sum(
            (Decimal(str(value)) for value in grants.values_list("remaining_credits", flat=True)),
            _ZERO,
        )

        consuming_organizations = (
            consumes.order_by()
            .values_list("organization_id", flat=True)
            .distinct()
            .count()
        )
        total_granted = initial_granted + positive_adjustments
        return {
            "campaign": campaign,
            "provider": provider,
            "granted": total_granted,
            "total_granted": total_granted,
            "initial_granted": initial_granted,
            "positive_adjustments": positive_adjustments,
            "negative_adjustments": negative_adjustments,
            "consumed": consumed,
            "total_consumed": consumed,
            "remaining": remaining,
            "expired": expired,
            "organizations": grants.order_by()
            .values_list("organization_id", flat=True)
            .distinct()
            .count(),
            # 当前账本没有 user_id，V1 以发生过消费的组织数作为可审计代理口径。
            "active_users": consuming_organizations,
            "usage_count": consumes.count(),
        }

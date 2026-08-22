"""Provider Credit 自动发放编排。

本模块只把生命周期事实映射到 Campaign；余额写入仍统一由
ProviderCreditService.grant_credit() 完成。
"""

from __future__ import annotations

import logging
from typing import Any

from django.core.exceptions import ValidationError
from django.db.models import F, Q
from django.utils import timezone

from apps.services.billing.models import (
    ProviderCreditCampaign,
    ProviderCreditGrant,
)
from apps.services.billing.services.provider_credit_service import ProviderCreditService
from apps.tabtinspace.models import Organization, OrganizationProviderCreditClaim


logger = logging.getLogger(__name__)


def _active_campaigns(*, trigger_type: str, at=None):
    current_time = at or timezone.now()
    return (
        ProviderCreditCampaign.objects.filter(
            enabled=True,
            status=ProviderCreditCampaign.Status.ACTIVE,
            trigger_type=trigger_type,
            start_at__lte=current_time,
        )
        .filter(Q(end_at__isnull=True) | Q(end_at__gt=current_time))
        .order_by("created_at", "id")
    )


def _membership_plan_code(membership_plan: Any) -> str:
    if isinstance(membership_plan, str):
        code = membership_plan
    else:
        code = getattr(membership_plan, "tier_type", None)
    normalized = str(code or "").strip().lower()
    if not normalized:
        raise ValidationError(
            {"membership_plan": "无法从 membership_plan 获取稳定套餐编码"}
        )
    return normalized


def grant_new_organization_provider_credits(
    organization: Organization | str,
    *,
    at=None,
    metadata: dict | None = None,
) -> list[ProviderCreditGrant]:
    """为用户前四个自有组织发放创建事务已快照的 new_org Campaign。"""
    organization_id = getattr(organization, "pk", organization)
    organization_obj = Organization.objects.get(pk=organization_id)
    provider_credit_claim = OrganizationProviderCreditClaim.objects.filter(
        organization_id=organization_obj.pk
    ).first()
    is_claimed_owned_organization = provider_credit_claim is not None
    is_supported_organization = bool(
        provider_credit_claim
        and provider_credit_claim.matches_organization_kind(organization_obj)
    )
    if (
        not is_supported_organization
        or organization_obj.status != Organization.Status.ACTIVE
        or not is_claimed_owned_organization
    ):
        logger.info(
            "跳过不符合条件的 Organization new_org Provider Credit: "
            "organization=%s type=%s is_default=%s status=%s has_claim=%s",
            organization_obj.pk,
            organization_obj.type,
            organization_obj.is_default,
            organization_obj.status,
            is_claimed_owned_organization,
        )
        return []

    grants: list[ProviderCreditGrant] = []
    campaign_ids = list(provider_credit_claim.eligible_campaign_ids or [])
    for campaign in ProviderCreditCampaign.objects.filter(
        id__in=campaign_ids
    ).order_by("created_at", "id"):
        grant_metadata = dict(metadata or {})
        grant_metadata.update(
            {
                "source": "new_org",
                "trigger_type": ProviderCreditCampaign.TriggerType.NEW_ORG,
                "eligibility_captured_at": organization_obj.created_at.isoformat(),
            }
        )
        try:
            grant = ProviderCreditService.grant_credit_from_campaign(
                organization=organization_obj,
                campaign_code=campaign.code,
                source="new_org",
                eligibility_at=organization_obj.created_at,
                metadata=grant_metadata,
            )
        except ValidationError as exc:
            logger.warning(
                "跳过当前不可发放的 new_org Provider Credit Campaign: "
                "organization=%s campaign=%s error=%s",
                getattr(organization, "pk", organization),
                campaign.code,
                exc,
            )
            continue
        grants.append(grant)
    return grants


def reconcile_new_organization_provider_credits(
    *,
    limit: int = 500,
    at=None,
) -> dict:
    """补偿已快照但尚未发放的前四个自有组织 Campaign。"""
    batch_limit = max(1, min(int(limit or 500), 5000))
    processed = 0
    granted = 0
    skipped = 0
    claims = OrganizationProviderCreditClaim.objects.exclude(
        eligible_campaign_ids=[]
    ).order_by(
        F("last_reconciled_at").asc(nulls_first=True),
        "created_at",
    )[:batch_limit]
    for claim in claims.iterator(chunk_size=100):
        if processed >= batch_limit:
            break
        claim.last_reconciled_at = timezone.now()
        claim.save(update_fields=["last_reconciled_at"])
        organization = Organization.objects.filter(
            id=claim.organization_id,
            status=Organization.Status.ACTIVE,
        ).filter(
            Q(
                type=Organization.OrganizationType.PERSONAL,
                is_default=True,
            )
            | Q(
                type=Organization.OrganizationType.TEAM,
                is_default=False,
            )
        ).first()
        if organization is None:
            continue
        campaign_ids = list(claim.eligible_campaign_ids or [])
        campaigns = {
            str(campaign.id): campaign
            for campaign in ProviderCreditCampaign.objects.filter(
                id__in=campaign_ids
            )
        }
        granted_campaign_ids = set(
            ProviderCreditGrant.objects.filter(
                organization=organization,
                campaign_id__in=campaign_ids,
            ).values_list("campaign_id", flat=True)
        )
        for campaign_id in campaign_ids:
            if processed >= batch_limit:
                break
            campaign = campaigns.get(str(campaign_id))
            if campaign is None or campaign.id in granted_campaign_ids:
                continue
            if (
                campaign.granted_credits + campaign.credits_amount
                > campaign.total_budget_credits
            ):
                continue
            processed += 1
            try:
                ProviderCreditService.grant_credit_from_campaign(
                    organization=organization,
                    campaign_code=campaign.code,
                    source="new_org",
                    eligibility_at=organization.created_at,
                    metadata={
                        "source": "new_org",
                        "trigger_type": ProviderCreditCampaign.TriggerType.NEW_ORG,
                        "reconciled": True,
                    },
                )
            except ValidationError as exc:
                skipped += 1
                logger.warning(
                    "补偿 new_org Provider Credit 跳过: "
                    "organization=%s campaign=%s error=%s",
                    organization.id,
                    campaign.code,
                    exc,
                )
                continue
            granted += 1

    return {
        "processed": processed,
        "granted": granted,
        "skipped": skipped,
    }


def grant_membership_provider_credits(
    organization: Organization | str,
    membership_plan: Any,
    subscription_id: str,
) -> list[ProviderCreditGrant]:
    """按 MembershipTier.tier_type 匹配并发放会员 Campaign。"""
    plan_code = _membership_plan_code(membership_plan)
    normalized_subscription_id = str(subscription_id or "").strip()
    if not normalized_subscription_id:
        raise ValidationError({"subscription_id": "subscription_id 不能为空"})

    grants: list[ProviderCreditGrant] = []
    for campaign in _active_campaigns(
        trigger_type=ProviderCreditCampaign.TriggerType.MEMBERSHIP
    ):
        configured_codes = {
            str(code or "").strip().lower()
            for code in (campaign.membership_plan_codes or [])
            if str(code or "").strip()
        }
        if plan_code not in configured_codes:
            continue
        try:
            grant = ProviderCreditService.grant_credit_from_campaign(
                organization=organization,
                campaign_code=campaign.code,
                source="membership",
                metadata={
                    "source": "membership",
                    "membership_plan_code": plan_code,
                    "subscription_id": normalized_subscription_id,
                    "trigger_type": ProviderCreditCampaign.TriggerType.MEMBERSHIP,
                },
            )
        except ValidationError as exc:
            logger.warning(
                "跳过当前不可发放的 membership Provider Credit Campaign: "
                "organization=%s campaign=%s plan=%s error=%s",
                getattr(organization, "pk", organization),
                campaign.code,
                plan_code,
                exc,
            )
            continue
        grants.append(grant)
    return grants


__all__ = [
    "grant_membership_provider_credits",
    "grant_new_organization_provider_credits",
    "reconcile_new_organization_provider_credits",
]

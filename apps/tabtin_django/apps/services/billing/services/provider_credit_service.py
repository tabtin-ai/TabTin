"""Provider Sponsored Credit 领域服务。

PR1 只维护独立的活动、组织发放批次与流水，不接入 LLM 结算、月度预算或 Wallet。
"""

from __future__ import annotations

import logging
import uuid
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.services.billing.models import (
    ProviderCreditCampaign,
    ProviderCreditGrant,
    ProviderCreditTransaction,
    normalize_provider_credit_membership_plan_codes,
    normalize_provider_credit_model_ids,
    normalize_provider_credit_provider_key,
)
from apps.tabtinspace.models import Organization, OrganizationProviderCreditClaim


logger = logging.getLogger(__name__)

_ZERO = Decimal("0")


def _credit_decimal(value: Any, *, field_name: str = "amount") -> Decimal:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValidationError({field_name: "额度必须是合法 Decimal"}) from exc
    if not amount.is_finite():
        raise ValidationError({field_name: "额度必须是有限 Decimal"})
    return amount


def _canonical_model_id(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        return str(uuid.UUID(str(value)))
    except (AttributeError, TypeError, ValueError):
        return ""


def matches_provider_credit(
    grant: ProviderCreditGrant,
    provider_key: str,
    model_id: Any,
) -> bool:
    """按稳定 provider_key 与模型 UUID 判断一笔 Grant 是否匹配。

    provider scope 的可见性与调用权限不属于 Provider Credit，必须由未来调用方
    在进入本方法前完成。
    """
    try:
        normalized_provider_key = normalize_provider_credit_provider_key(provider_key)
    except ValidationError:
        return False
    if grant.provider_key != normalized_provider_key:
        return False

    eligible_model_ids = grant.eligible_model_ids or []
    if not eligible_model_ids:
        return True

    normalized_model_id = _canonical_model_id(model_id)
    return bool(normalized_model_id and normalized_model_id in eligible_model_ids)


class ProviderCreditService:
    """Provider Credit 的单一写入与查询边界。"""

    @classmethod
    def create_campaign(
        cls,
        *,
        code: str,
        name: str,
        provider_key: str,
        eligible_model_ids: list[str] | tuple[str, ...] | None = None,
        credits_amount: Decimal,
        total_budget_credits: Decimal,
        enabled: bool = True,
        trigger_type: str = ProviderCreditCampaign.TriggerType.MANUAL,
        membership_plan_codes: list[str] | tuple[str, ...] | None = None,
        status: str = ProviderCreditCampaign.Status.ACTIVE,
        start_at=None,
        end_at=None,
        expire_days: int = 30,
        metadata: dict | None = None,
    ) -> ProviderCreditCampaign:
        campaign = ProviderCreditCampaign(
            code=str(code or "").strip(),
            name=str(name or "").strip(),
            provider_key=normalize_provider_credit_provider_key(provider_key),
            eligible_model_ids=normalize_provider_credit_model_ids(eligible_model_ids),
            credits_amount=_credit_decimal(credits_amount, field_name="credits_amount"),
            total_budget_credits=_credit_decimal(
                total_budget_credits,
                field_name="total_budget_credits",
            ),
            enabled=enabled,
            trigger_type=trigger_type,
            membership_plan_codes=normalize_provider_credit_membership_plan_codes(
                membership_plan_codes
            ),
            status=status,
            start_at=start_at or timezone.now(),
            end_at=end_at,
            expire_days=expire_days,
            metadata=metadata or {},
        )
        campaign.full_clean()
        campaign.save()
        return campaign

    @classmethod
    def grant_credit_from_campaign(
        cls,
        *,
        organization: Organization | str | uuid.UUID,
        campaign_code: str,
        source: str,
        eligibility_at=None,
        metadata: dict | None = None,
    ) -> ProviderCreditGrant:
        """按活动编码发放，并统一归一化发放来源与有效期。

        `source="new_org"` 是自动活动触发语义，在 Grant 快照中归为 campaign；
        原始触发来源始终写入 metadata，便于运营审计。
        """
        normalized_code = str(campaign_code or "").strip()
        if not normalized_code:
            raise ValidationError({"campaign_code": "活动编码不能为空"})

        normalized_source = str(source or "").strip().lower()
        grant_source_map = {
            "campaign": ProviderCreditGrant.GrantSource.CAMPAIGN,
            "new_org": ProviderCreditGrant.GrantSource.CAMPAIGN,
            "membership": ProviderCreditGrant.GrantSource.MEMBERSHIP,
            "admin": ProviderCreditGrant.GrantSource.ADMIN,
        }
        grant_source = grant_source_map.get(normalized_source)
        if grant_source is None:
            raise ValidationError({"source": "不支持的 Provider Credit 发放来源"})
        trigger_type = {
            "new_org": ProviderCreditCampaign.TriggerType.NEW_ORG,
            "membership": ProviderCreditCampaign.TriggerType.MEMBERSHIP,
        }.get(normalized_source)

        campaign = ProviderCreditCampaign.objects.get(code=normalized_code)
        effective_at = timezone.now()
        grant_metadata = dict(metadata or {})
        grant_metadata.setdefault("source", normalized_source)

        return cls.grant_credit(
            organization=organization,
            campaign=campaign,
            grant_source=grant_source,
            trigger_type=trigger_type,
            validation_at=eligibility_at,
            effective_at=effective_at,
            metadata=grant_metadata,
        )

    @classmethod
    def grant_credit(
        cls,
        *,
        organization: Organization | str | uuid.UUID,
        campaign: ProviderCreditCampaign | str | uuid.UUID,
        grant_source: str = ProviderCreditGrant.GrantSource.CAMPAIGN,
        trigger_type: str | None = None,
        validation_at=None,
        effective_at=None,
        expire_at=None,
        metadata: dict | None = None,
    ) -> ProviderCreditGrant:
        """按 organization + campaign 幂等发放一次活动额度。"""
        organization_id = getattr(organization, "pk", organization)
        campaign_id = getattr(campaign, "pk", campaign)
        now = timezone.now()

        with transaction.atomic():
            locked_campaign = ProviderCreditCampaign.objects.select_for_update().get(
                pk=campaign_id
            )
            organization_obj = Organization.objects.get(pk=organization_id)
            new_org_claim = None
            is_snapshotted_new_org = False
            if trigger_type == ProviderCreditCampaign.TriggerType.NEW_ORG:
                new_org_claim = OrganizationProviderCreditClaim.objects.filter(
                    organization_id=organization_obj.pk
                ).first()
                is_snapshotted_new_org = (
                    new_org_claim is not None
                    and str(locked_campaign.id)
                    in {
                        str(campaign_id)
                        for campaign_id in (
                            new_org_claim.eligible_campaign_ids or []
                        )
                    }
                )
            if (
                trigger_type
                and locked_campaign.trigger_type != trigger_type
                and not is_snapshotted_new_org
            ):
                raise ValidationError(
                    {
                        "source": (
                            f"发放来源 {trigger_type} 与 Campaign 触发类型 "
                            f"{locked_campaign.trigger_type} 不一致"
                        )
                    }
                )
            if (
                trigger_type == ProviderCreditCampaign.TriggerType.NEW_ORG
                and (
                    new_org_claim is None
                    or not new_org_claim.matches_organization_kind(
                        organization_obj
                    )
                    or organization_obj.status != Organization.Status.ACTIVE
                    or not is_snapshotted_new_org
                )
            ):
                raise ValidationError(
                    {
                        "organization": (
                            "new_org Provider Credit 仅允许发放给用户前四个"
                            "已快照的活跃自有组织"
                        )
                    }
                )
            existing = ProviderCreditGrant.objects.filter(
                organization_id=organization_id,
                campaign=locked_campaign,
            ).first()
            if existing is not None:
                if trigger_type and existing.trigger_type != trigger_type:
                    raise ValidationError(
                        {
                            "source": (
                                "该组织已通过其他来源获得同一 Campaign，"
                                "不能视为本次自动发放"
                            )
                        }
                    )
                return existing

            if not is_snapshotted_new_org:
                cls._validate_campaign_for_grant(
                    locked_campaign,
                    now=validation_at or now,
                )
            amount = _credit_decimal(
                locked_campaign.credits_amount,
                field_name="credits_amount",
            )
            if amount <= _ZERO:
                raise ValidationError({"credits_amount": "发放额度必须大于 0"})
            if locked_campaign.granted_credits + amount > locked_campaign.total_budget_credits:
                raise ValidationError({"total_budget_credits": "活动剩余预算不足"})

            grant_effective_at = effective_at or now
            grant_expire_at = expire_at or (
                grant_effective_at + timedelta(days=locked_campaign.expire_days)
            )
            grant = ProviderCreditGrant(
                organization=organization_obj,
                campaign=locked_campaign,
                provider_key=locked_campaign.provider_key,
                eligible_model_ids=list(locked_campaign.eligible_model_ids or []),
                total_credits=amount,
                consumed_credits=_ZERO,
                remaining_credits=amount,
                status=ProviderCreditGrant.Status.ACTIVE,
                grant_source=grant_source,
                trigger_type=trigger_type,
                effective_at=grant_effective_at,
                expire_at=grant_expire_at,
                metadata=metadata or {},
            )
            grant.full_clean()
            grant.save()

            locked_campaign.granted_credits += amount
            locked_campaign.save(update_fields=["granted_credits", "updated_at"])
            ProviderCreditTransaction.objects.create(
                grant=grant,
                organization=organization_obj,
                transaction_type=ProviderCreditTransaction.TransactionType.GRANT,
                amount=amount,
                balance_after=amount,
                reference_type="provider_credit_campaign",
                reference_id=str(locked_campaign.id),
                idempotency_key=f"provider-credit-grant:{grant.id}",
                metadata={
                    "grant_source": grant_source,
                    "source": (metadata or {}).get("source", grant_source),
                },
            )
            return grant

    @classmethod
    def expire_grant(
        cls,
        *,
        grant: ProviderCreditGrant | str | uuid.UUID,
        at=None,
    ) -> ProviderCreditTransaction | None:
        """把到期 Grant 的剩余余额核销为 expire 流水；不负责调度扫描。"""
        grant_id = getattr(grant, "pk", grant)
        current_time = at or timezone.now()
        idempotency_key = f"provider-credit-expire:{grant_id}"

        with transaction.atomic():
            locked_grant = ProviderCreditGrant.objects.select_for_update().get(pk=grant_id)
            existing = ProviderCreditTransaction.objects.filter(
                idempotency_key=idempotency_key
            ).first()
            if existing is not None:
                return existing
            if locked_grant.status == ProviderCreditGrant.Status.EXPIRED:
                return None
            if locked_grant.status != ProviderCreditGrant.Status.ACTIVE:
                raise ValidationError({"status": "只有 active Grant 可以执行过期"})
            if locked_grant.expire_at is None:
                raise ValidationError({"expire_at": "Grant 未设置过期时间"})
            if locked_grant.expire_at > current_time:
                raise ValidationError({"expire_at": "Grant 尚未到期"})

            # 活跃 Reservation 已在到期前完成资格校验。到期任务不能核销其
            # frozen allocation；等待 Reservation commit/release 后再执行过期。
            if Decimal(str(locked_grant.active_reserved_credits or 0)) > _ZERO:
                logger.info(
                    "[ProviderCredit] defer expiry for active reservation: grant=%s reserved=%s",
                    locked_grant.id,
                    locked_grant.active_reserved_credits,
                )
                return None

            remaining = Decimal(str(locked_grant.remaining_credits))
            if remaining <= _ZERO:
                raise ValidationError({"remaining_credits": "Grant 没有可过期余额"})
            return cls.record_transaction(
                grant=locked_grant,
                transaction_type=ProviderCreditTransaction.TransactionType.EXPIRE,
                amount=-remaining,
                idempotency_key=idempotency_key,
                reference_type="provider_credit_grant",
                reference_id=str(locked_grant.id),
                metadata={"expired_at": current_time.isoformat()},
            )

    @classmethod
    def get_available_credit(
        cls,
        *,
        organization: Organization | str | uuid.UUID,
        provider_key: str,
        model_id: Any,
        at=None,
    ) -> Decimal:
        """汇总当前有效且匹配 provider/model 的独立供应商额度。"""
        organization_id = getattr(organization, "pk", organization)
        normalized_provider_key = normalize_provider_credit_provider_key(provider_key)
        current_time = at or timezone.now()

        grants = ProviderCreditGrant.objects.filter(
            organization_id=organization_id,
            provider_key=normalized_provider_key,
            status=ProviderCreditGrant.Status.ACTIVE,
            effective_at__lte=current_time,
            remaining_credits__gt=0,
        ).filter(Q(expire_at__isnull=True) | Q(expire_at__gt=current_time))

        available = _ZERO
        for grant in grants.iterator():
            if matches_provider_credit(grant, normalized_provider_key, model_id):
                available += max(
                    _ZERO,
                    Decimal(str(grant.remaining_credits))
                    - Decimal(str(grant.active_reserved_credits or 0)),
                )
        return available

    @classmethod
    def record_transaction(
        cls,
        *,
        grant: ProviderCreditGrant | str | uuid.UUID,
        transaction_type: str,
        amount: Decimal,
        idempotency_key: str,
        reference_type: str = "",
        reference_id: str = "",
        metadata: dict | None = None,
    ) -> ProviderCreditTransaction:
        """原子地变更 Grant 余额并记录幂等流水。

        amount 使用余额增减符号：grant/refund 为正，consume/expire 为负，
        adjust 可正可负。
        """
        grant_id = getattr(grant, "pk", grant)
        normalized_idempotency_key = str(idempotency_key or "").strip()
        if not normalized_idempotency_key:
            raise ValidationError({"idempotency_key": "幂等键不能为空"})
        delta = _credit_decimal(amount)

        with transaction.atomic():
            existing = ProviderCreditTransaction.objects.filter(
                idempotency_key=normalized_idempotency_key
            ).first()
            if existing is not None:
                cls._validate_idempotent_replay(
                    existing,
                    grant_id=grant_id,
                    transaction_type=transaction_type,
                    amount=delta,
                    reference_type=reference_type,
                    reference_id=reference_id,
                )
                return existing

            locked_grant = ProviderCreditGrant.objects.select_for_update().get(pk=grant_id)
            existing = ProviderCreditTransaction.objects.filter(
                idempotency_key=normalized_idempotency_key
            ).first()
            if existing is not None:
                cls._validate_idempotent_replay(
                    existing,
                    grant_id=grant_id,
                    transaction_type=transaction_type,
                    amount=delta,
                    reference_type=reference_type,
                    reference_id=reference_id,
                )
                return existing

            cls._apply_transaction_delta(
                locked_grant,
                transaction_type=transaction_type,
                delta=delta,
            )
            try:
                with transaction.atomic():
                    created = ProviderCreditTransaction.objects.create(
                        grant=locked_grant,
                        organization_id=locked_grant.organization_id,
                        transaction_type=transaction_type,
                        amount=delta,
                        balance_after=locked_grant.remaining_credits,
                        reference_type=str(reference_type or "").strip(),
                        reference_id=str(reference_id or "").strip(),
                        idempotency_key=normalized_idempotency_key,
                        metadata=metadata or {},
                    )
            except IntegrityError:
                existing = ProviderCreditTransaction.objects.get(
                    idempotency_key=normalized_idempotency_key
                )
                cls._validate_idempotent_replay(
                    existing,
                    grant_id=grant_id,
                    transaction_type=transaction_type,
                    amount=delta,
                    reference_type=reference_type,
                    reference_id=reference_id,
                )
                return existing

            locked_grant.save(
                update_fields=[
                    "total_credits",
                    "consumed_credits",
                    "remaining_credits",
                    "status",
                    "updated_at",
                ]
            )
            return created

    @classmethod
    def adjust_grant(
        cls,
        *,
        grant: ProviderCreditGrant | str | uuid.UUID,
        amount: Decimal,
        reason: str,
        operator_id: str,
        idempotency_key: str,
    ) -> ProviderCreditTransaction:
        """通过 adjust 流水原子调整 Grant，禁止余额字段的旁路写入。"""
        grant_id = getattr(grant, "pk", grant)
        normalized_reason = str(reason or "").strip()
        if not normalized_reason:
            raise ValidationError({"reason": "调整额度必须填写原因"})
        delta = _credit_decimal(amount)
        if delta == _ZERO:
            raise ValidationError({"amount": "调整额度不能为 0"})

        with transaction.atomic():
            locked_grant = ProviderCreditGrant.objects.select_for_update().get(pk=grant_id)
            if locked_grant.status in {
                ProviderCreditGrant.Status.EXPIRED,
                ProviderCreditGrant.Status.REVOKED,
            }:
                raise ValidationError({"status": "已过期或已撤销 Grant 不能调整"})
            return cls.record_transaction(
                grant=locked_grant,
                transaction_type=ProviderCreditTransaction.TransactionType.ADJUST,
                amount=delta,
                idempotency_key=idempotency_key,
                reference_type="provider_credit_admin_adjustment",
                reference_id=str(grant_id),
                metadata={
                    "reason": normalized_reason,
                    "operator_id": str(operator_id or ""),
                },
            )

    @classmethod
    def revoke_grant(
        cls,
        *,
        grant: ProviderCreditGrant | str | uuid.UUID,
        reason: str,
        operator_id: str,
        idempotency_key: str,
    ) -> ProviderCreditTransaction | None:
        """撤销 Grant，并以负 adjust 流水核销尚未消费的余额。"""
        grant_id = getattr(grant, "pk", grant)
        normalized_reason = str(reason or "").strip()
        if not normalized_reason:
            raise ValidationError({"reason": "撤销额度必须填写原因"})

        with transaction.atomic():
            locked_grant = ProviderCreditGrant.objects.select_for_update().get(pk=grant_id)
            if locked_grant.status == ProviderCreditGrant.Status.REVOKED:
                return ProviderCreditTransaction.objects.filter(
                    idempotency_key=idempotency_key
                ).first()
            if locked_grant.status == ProviderCreditGrant.Status.EXPIRED:
                raise ValidationError({"status": "已过期 Grant 不能撤销"})

            adjustment = None
            remaining = Decimal(str(locked_grant.remaining_credits))
            if remaining > _ZERO:
                adjustment = cls.record_transaction(
                    grant=locked_grant,
                    transaction_type=ProviderCreditTransaction.TransactionType.ADJUST,
                    amount=-remaining,
                    idempotency_key=idempotency_key,
                    reference_type="provider_credit_admin_revoke",
                    reference_id=str(grant_id),
                    metadata={
                        "reason": normalized_reason,
                        "operator_id": str(operator_id or ""),
                        "revoke": True,
                    },
                )

            ProviderCreditGrant.objects.filter(pk=grant_id).update(
                status=ProviderCreditGrant.Status.REVOKED,
                updated_at=timezone.now(),
            )
            return adjustment

    @staticmethod
    def matches_provider_credit(
        grant: ProviderCreditGrant,
        provider_key: str,
        model_id: Any,
    ) -> bool:
        return matches_provider_credit(grant, provider_key, model_id)

    @staticmethod
    def _validate_campaign_for_grant(
        campaign: ProviderCreditCampaign,
        *,
        now,
    ) -> None:
        if not campaign.enabled:
            raise ValidationError({"enabled": "活动当前未启用"})
        if campaign.status != ProviderCreditCampaign.Status.ACTIVE:
            raise ValidationError({"status": "活动当前不可发放"})
        if campaign.start_at > now:
            raise ValidationError({"start_at": "活动尚未开始"})
        if campaign.end_at and campaign.end_at <= now:
            raise ValidationError({"end_at": "活动已结束"})

    @staticmethod
    def _apply_transaction_delta(
        grant: ProviderCreditGrant,
        *,
        transaction_type: str,
        delta: Decimal,
    ) -> None:
        valid_types = set(ProviderCreditTransaction.TransactionType.values)
        if transaction_type not in valid_types:
            raise ValidationError({"transaction_type": "不支持的流水类型"})
        if transaction_type == ProviderCreditTransaction.TransactionType.GRANT:
            raise ValidationError({"transaction_type": "grant 流水只能由 grant_credit() 创建"})
        if delta == _ZERO:
            raise ValidationError({"amount": "流水金额不能为 0"})
        if transaction_type in {
            ProviderCreditTransaction.TransactionType.GRANT,
            ProviderCreditTransaction.TransactionType.REFUND,
        } and delta < _ZERO:
            raise ValidationError({"amount": "grant/refund 流水金额必须为正"})
        if transaction_type in {
            ProviderCreditTransaction.TransactionType.CONSUME,
            ProviderCreditTransaction.TransactionType.EXPIRE,
        } and delta > _ZERO:
            raise ValidationError({"amount": "consume/expire 流水金额必须为负"})
        if transaction_type == ProviderCreditTransaction.TransactionType.CONSUME:
            now = timezone.now()
            if grant.status != ProviderCreditGrant.Status.ACTIVE:
                raise ValidationError({"status": "只有 active Grant 可以消费"})
            if grant.effective_at > now:
                raise ValidationError({"effective_at": "Grant 尚未生效"})
            if grant.expire_at and grant.expire_at <= now:
                raise ValidationError({"expire_at": "Grant 已过期"})

        remaining_after = Decimal(str(grant.remaining_credits)) + delta
        if remaining_after < _ZERO:
            raise ValidationError({"amount": "供应商额度余额不足"})

        consumed = Decimal(str(grant.consumed_credits))
        total = Decimal(str(grant.total_credits))
        if transaction_type == ProviderCreditTransaction.TransactionType.CONSUME:
            consumed -= delta
        elif transaction_type == ProviderCreditTransaction.TransactionType.REFUND:
            consumed -= delta
            if consumed < _ZERO:
                raise ValidationError({"amount": "退款额度不能超过已消费额度"})
        elif transaction_type in {
            ProviderCreditTransaction.TransactionType.GRANT,
            ProviderCreditTransaction.TransactionType.ADJUST,
        }:
            total += delta
            if total < _ZERO:
                raise ValidationError({"amount": "调整后发放总额不能小于 0"})

        grant.total_credits = total
        grant.consumed_credits = consumed
        grant.remaining_credits = remaining_after
        if remaining_after == _ZERO:
            grant.status = (
                ProviderCreditGrant.Status.EXPIRED
                if transaction_type == ProviderCreditTransaction.TransactionType.EXPIRE
                else ProviderCreditGrant.Status.EXHAUSTED
            )
        elif transaction_type in {
            ProviderCreditTransaction.TransactionType.GRANT,
            ProviderCreditTransaction.TransactionType.REFUND,
        } or (
            transaction_type == ProviderCreditTransaction.TransactionType.ADJUST
            and delta > _ZERO
        ):
            grant.status = ProviderCreditGrant.Status.ACTIVE

    @staticmethod
    def _validate_idempotent_replay(
        existing: ProviderCreditTransaction,
        *,
        grant_id,
        transaction_type: str,
        amount: Decimal,
        reference_type: str,
        reference_id: str,
    ) -> None:
        expected = (
            str(grant_id),
            transaction_type,
            amount,
            str(reference_type or "").strip(),
            str(reference_id or "").strip(),
        )
        actual = (
            str(existing.grant_id),
            existing.transaction_type,
            Decimal(str(existing.amount)),
            existing.reference_type,
            existing.reference_id,
        )
        if actual != expected:
            raise ValidationError(
                {"idempotency_key": "幂等键已被不同的 Provider Credit 流水占用"}
            )


def resolve_model_provider_credits(organization_id: str, model_instance: Any) -> Decimal:
    """取「组织在当前模型上」可用的定向点券，按 canonical provider_key + LLMModel UUID 定位。

    预检冻结估算与低余额预警共用同一口径：定向点券按模型隔离，不能把其他模型的
    额度混入判定。资金池未开启 / 缺组织或模型 / 查询失败时按 0 计入（best-effort，
    宁可少算导致多提醒，也不能因赠送额度查询失败而漏拦真实的余额不足）。
    """
    if not provider_credit_funding_enabled() or model_instance is None:
        return _ZERO
    if not (organization_id or "").strip():
        return _ZERO

    provider = getattr(model_instance, "provider", None)
    provider_key = str(getattr(provider, "provider_key", "") or "").strip()
    model_id = str(getattr(model_instance, "id", "") or "").strip()
    if not provider_key or not model_id:
        return _ZERO

    try:
        return Decimal(
            str(
                ProviderCreditService.get_available_credit(
                    organization=organization_id,
                    provider_key=provider_key,
                    model_id=model_id,
                )
                or 0
            )
        )
    except Exception as exc:
        logger.warning(
            "[ProviderCredit] 定向点券查询失败，按 0 计入: "
            "organization=%s provider=%s model_id=%s err=%s",
            organization_id,
            provider_key,
            model_id,
            exc,
        )
        return _ZERO


def provider_credit_funding_enabled() -> bool:
    """定向点券是否参与资金池（关闭时一律按 0 计入）。"""
    try:
        from django.conf import settings

        return bool(getattr(settings, "PROVIDER_CREDIT_FUNDING_ENABLED", False))
    except Exception:
        return False


__all__ = [
    "ProviderCreditService",
    "matches_provider_credit",
    "provider_credit_funding_enabled",
    "resolve_model_provider_credits",
]

"""订阅中心只读聚合服务。

PR3.1 只负责 Electron 订阅中心的数据收口：
- overview 聚合当前订阅、钱包、AI 月额度和权益；
- plans 返回套餐目录及服务端判定的 action。

这里不创建订单、不执行升级/降级/续费，也不修改会员状态。
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, Optional

from django.conf import settings
from datetime import date

from django.utils import timezone

from apps.services.billing.models import OrganizationLlmMonthlyBudget
from apps.users.wallet.models import OrganizationWallet

from ..models import MembershipTier
from .membership_change_classifier import MembershipChangeAction
from .membership_purchase_guard import classify_organization_membership_change
from .organization_membership_service import OrganizationMembershipService


def _decimal_str(value: Any) -> str:
    return str(Decimal(str(value or 0)))


def _serialize_wallet(organization_id: str) -> Dict[str, Any]:
    wallet = OrganizationWallet.objects.filter(organization_id=organization_id).first()
    if wallet is None:
        return {
            "organization_id": organization_id,
            "credits": 0,
            "credits_precise": "0.0000",
            "credits_frozen": 0,
            "credits_frozen_precise": "0.0000",
            "available_credits": 0,
            "available_credits_precise": "0.0000",
        }
    return {
        "organization_id": organization_id,
        "credits": wallet.credits,
        "credits_precise": _decimal_str(wallet.credits_precise),
        "credits_frozen": wallet.credits_frozen,
        "credits_frozen_precise": _decimal_str(wallet.credits_frozen_precise),
        "available_credits": wallet.get_available_credits(),
        "available_credits_precise": _decimal_str(wallet.get_available_credits_precise()),
    }


def _serialize_tier_entitlements(tier: MembershipTier) -> Dict[str, Any]:
    return {
        "included_credits": _decimal_str(tier.included_llm_credits_monthly),
        "max_members": tier.max_members,
        "storage_bytes": tier.included_storage_bytes,
        "max_documents": tier.max_documents,
        "max_tables": tier.max_tables,
        "max_groups": tier.max_groups,
        "max_records_per_table": tier.max_records_per_table,
        "trash_retention_days": tier.trash_retention_days,
    }


def _action_button(action: str, current: bool) -> Dict[str, Any]:
    labels = {
        MembershipChangeAction.NEW.value: "立即订阅",
        MembershipChangeAction.UPGRADE.value: "升级套餐",
        MembershipChangeAction.RENEW.value: "续费",
        MembershipChangeAction.DOWNGRADE.value: "下周期降级",
        MembershipChangeAction.SWITCH.value: "下周期切换",
    }
    return {
        "label": "当前套餐" if current else labels.get(action, "查看套餐"),
        "disabled": current,
    }


class SubscriptionCatalogService:
    """订阅中心只读聚合。"""

    def __init__(self) -> None:
        self.membership_service = OrganizationMembershipService()

    def get_overview(self, organization_id: str) -> Dict[str, Any]:
        status = self.membership_service.check_membership_status(organization_id)
        now = timezone.now()
        cycle_month = date(now.year, now.month, 1)
        budget = OrganizationLlmMonthlyBudget.objects.filter(
            organization_id=organization_id,
            cycle_month=cycle_month,
        ).first()
        if budget is None:
            included = Decimal(str((status.get("quotas") or {}).get("included_llm_credits_monthly", 0) or 0))
            consumed = Decimal("0")
        else:
            included = Decimal(str(getattr(budget, "included_credits", 0) or 0))
            consumed = Decimal(str(getattr(budget, "consumed_credits", 0) or 0))
        remaining = max(Decimal("0"), included - consumed)

        wallet = _serialize_wallet(organization_id)
        tier = status.get("tier") or {}

        subscription_display = {
            "title": tier.get("name") or "免费版",
            "subtitle": "当前未订阅付费套餐" if status.get("lifecycle_state") == "free" else "",
            "status_label": status.get("lifecycle_state") or "unknown",
            "billing_cycle_label": status.get("billing_cycle") or "monthly",
            "valid_until": status.get("end_date"),
            "remaining_days": status.get("days_until_expiry"),
            "auto_renew_label": "已开启" if status.get("auto_renew") else "未开启",
        }

        return {
            "membership": status,
            "subscription_display": subscription_display,
            "wallet": wallet,
            "included_credits": _decimal_str(included),
            "consumed_credits": _decimal_str(consumed),
            "remaining_credits": _decimal_str(remaining),
            "entitlements": {
                **(status.get("quotas") or {}),
                "quota_usage": status.get("quota_usage") or {},
            },
            "allowed_actions": status.get("allowed_actions") or [],
            "capabilities": {
                "upgrade_quote_enabled": bool(
                    getattr(settings, "MEMBERSHIP_UPGRADE_QUOTE_ENABLED", False)
                ),
                "can_upgrade": bool(status.get("can_upgrade")),
                "can_renew": bool(status.get("can_renew")),
                "can_manage": bool(status.get("can_manage")),
            },
        }

    def get_plans(self, organization_id: str) -> Dict[str, Any]:
        status = self.membership_service.check_membership_status(organization_id)
        current_tier_id: Optional[str] = ((status.get("tier") or {}).get("id"))

        plans = []
        for tier in MembershipTier.objects.filter(is_active=True).order_by("sort_order", "-created_at"):
            action, _state = classify_organization_membership_change(
                organization_id=organization_id,
                target_tier=tier,
                target_billing_cycle=status.get("billing_cycle") or "monthly",
            )
            current = str(tier.id) == str(current_tier_id)
            plans.append({
                "id": str(tier.id),
                "name": tier.name,
                "tier_type": tier.tier_type,
                "tier_level": tier.tier_level,
                "display_order": tier.sort_order,
                "monthly_price": _decimal_str(tier.price),
                "yearly_price": None,
                "entitlements": _serialize_tier_entitlements(tier),
                "action": action,
                "button": _action_button(action, current),
                "recommended": tier.tier_type in {"pro", "professional"},
                "current": current,
            })

        return {
            "current_plan": status.get("tier"),
            "plans": plans,
        }

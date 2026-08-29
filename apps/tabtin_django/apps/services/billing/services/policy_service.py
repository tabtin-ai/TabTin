"""
组织计费策略与权益服务
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, Optional

from apps.services.billing.models import OrganizationBillingEntitlement, OrganizationBillingPolicy


class OrganizationBillingPolicyService:
    """读取并计算 organization 级计费策略/权益"""

    DEFAULT_STORAGE_BILLING_MODE = "package_plus_paygo"
    # LLM 只扣点券（月度配额 + 自动补充），用尽即停；钱包不再在结算路径被动扣款。
    DEFAULT_LLM_BILLING_MODE = "quota_only"
    DEFAULT_CURRENCY = "CREDITS"

    # 自动补充默认值（与 OrganizationBillingPolicy 字段默认保持一致）
    # 月上限 0 = 不限额（前端展示「不限额」）；用户填写正数后按该额度限制。
    DEFAULT_AUTO_TOPUP_ENABLED = True
    DEFAULT_AUTO_TOPUP_SPEND_YUAN = Decimal("1")
    DEFAULT_AUTO_TOPUP_THRESHOLD_CREDITS = Decimal("0")
    DEFAULT_AUTO_TOPUP_MONTHLY_CAP_YUAN = Decimal("0")

    @classmethod
    def default_policy_create_kwargs(cls) -> Dict[str, Any]:
        return {
            "storage_billing_mode": cls.DEFAULT_STORAGE_BILLING_MODE,
            "llm_billing_mode": cls.DEFAULT_LLM_BILLING_MODE,
            "is_active": True,
            "auto_topup_enabled": cls.DEFAULT_AUTO_TOPUP_ENABLED,
            "auto_topup_spend_yuan": cls.DEFAULT_AUTO_TOPUP_SPEND_YUAN,
            "auto_topup_threshold_credits": cls.DEFAULT_AUTO_TOPUP_THRESHOLD_CREDITS,
            "auto_topup_monthly_cap_yuan": cls.DEFAULT_AUTO_TOPUP_MONTHLY_CAP_YUAN,
        }

    @staticmethod
    def _to_decimal(value) -> Decimal:
        return Decimal(str(value or 0))

    @classmethod
    def get_active_policy(cls, organization_id: str) -> Optional[OrganizationBillingPolicy]:
        if not organization_id:
            return None
        return OrganizationBillingPolicy.objects.filter(
            organization_id=organization_id,
            is_active=True,
        ).first()

    @classmethod
    def get_effective_policy(cls, organization_id: str) -> Dict[str, Any]:
        policy = cls.get_active_policy(organization_id)
        if not policy:
            return {
                "organization_id": organization_id,
                "storage_billing_mode": cls.DEFAULT_STORAGE_BILLING_MODE,
                "llm_billing_mode": cls.DEFAULT_LLM_BILLING_MODE,
                "currency": cls.DEFAULT_CURRENCY,
                "auto_topup_enabled": cls.DEFAULT_AUTO_TOPUP_ENABLED,
                "auto_topup_spend_yuan": cls.DEFAULT_AUTO_TOPUP_SPEND_YUAN,
                "auto_topup_threshold_credits": cls.DEFAULT_AUTO_TOPUP_THRESHOLD_CREDITS,
                "auto_topup_monthly_cap_yuan": cls.DEFAULT_AUTO_TOPUP_MONTHLY_CAP_YUAN,
                "is_default": True,
                "metadata": {},
            }
        return {
            "organization_id": organization_id,
            "storage_billing_mode": policy.storage_billing_mode,
            "llm_billing_mode": policy.llm_billing_mode,
            "currency": policy.currency or cls.DEFAULT_CURRENCY,
            "auto_topup_enabled": bool(policy.auto_topup_enabled),
            "auto_topup_spend_yuan": cls._to_decimal(policy.auto_topup_spend_yuan),
            "auto_topup_threshold_credits": cls._to_decimal(policy.auto_topup_threshold_credits),
            "auto_topup_monthly_cap_yuan": cls._to_decimal(policy.auto_topup_monthly_cap_yuan),
            "is_default": False,
            "metadata": policy.metadata or {},
        }

    @classmethod
    def get_active_entitlement(
        cls,
        organization_id: str,
        *,
        at_time=None,
    ) -> Optional[OrganizationBillingEntitlement]:
        if not organization_id:
            return None
        return (
            OrganizationBillingEntitlement.objects.filter(
                organization_id=organization_id,
                is_active=True,
            )
            .order_by("-updated_at", "-effective_from")
            .first()
        )

    @classmethod
    def get_entitlement_snapshot(
        cls,
        organization_id: str,
        *,
        at_time=None,
    ) -> Dict[str, Any]:
        if not organization_id:
            return {
                "organization_id": organization_id,
                "included_storage_bytes": 0,
                "purchased_storage_bytes": 0,
                "storage_package_bytes": 0,
                "included_llm_credits_monthly": Decimal("0"),
                "is_default": True,
                "metadata": {},
            }

        from apps.services.billing.services.entitlement_service import OrganizationEntitlementSyncService

        snapshot = OrganizationEntitlementSyncService.build_organization_entitlement_snapshot(
            organization_id,
            at_time=at_time,
        )
        return {
            "organization_id": organization_id,
            "included_storage_bytes": int(snapshot["included_storage_bytes"]),
            "purchased_storage_bytes": int(snapshot["purchased_storage_bytes"]),
            "storage_package_bytes": int(snapshot["storage_package_bytes"]),
            "included_llm_credits_monthly": cls._to_decimal(snapshot["included_llm_credits_monthly"]),
            "is_default": False,
            "metadata": snapshot.get("metadata") or {},
        }

    @classmethod
    def resolve_storage_billable_bytes(
        cls,
        organization_id: str,
        active_storage_bytes: int,
        *,
        at_time=None,
    ) -> Dict[str, Any]:
        policy = cls.get_effective_policy(organization_id)
        entitlement = cls.get_entitlement_snapshot(organization_id, at_time=at_time)
        mode = policy["storage_billing_mode"]
        package_bytes = int(entitlement["storage_package_bytes"] or 0)
        active_bytes = max(0, int(active_storage_bytes or 0))
        remaining_package_bytes = max(0, package_bytes - active_bytes)

        if mode == "paygo_only":
            billable_bytes = active_bytes
            exceeded_bytes = 0
        elif mode == "package_only":
            billable_bytes = 0
            exceeded_bytes = max(0, active_bytes - package_bytes)
        else:
            billable_bytes = max(0, active_bytes - package_bytes)
            exceeded_bytes = max(0, active_bytes - package_bytes)

        return {
            "organization_id": organization_id,
            "storage_billing_mode": mode,
            "active_storage_bytes": active_bytes,
            "storage_package_bytes": package_bytes,
            "remaining_package_bytes": int(remaining_package_bytes),
            "available_bytes": int(remaining_package_bytes),
            "billable_bytes": int(billable_bytes),
            "exceeded_bytes": int(exceeded_bytes),
            "allowed": not (mode == "package_only" and exceeded_bytes > 0),
        }

    @classmethod
    def evaluate_storage_allocation(
        cls,
        organization_id: str,
        *,
        current_storage_bytes: int,
        incoming_delta_bytes: int,
        at_time=None,
    ) -> Dict[str, Any]:
        current_bytes = max(0, int(current_storage_bytes or 0))
        projected_bytes = max(0, current_bytes + int(incoming_delta_bytes or 0))

        current_decision = cls.resolve_storage_billable_bytes(
            organization_id,
            current_bytes,
            at_time=at_time,
        )
        projected_decision = cls.resolve_storage_billable_bytes(
            organization_id,
            projected_bytes,
            at_time=at_time,
        )

        return {
            "organization_id": organization_id,
            "current_storage_bytes": current_bytes,
            "projected_storage_bytes": projected_bytes,
            "incoming_delta_bytes": int(incoming_delta_bytes or 0),
            "storage_billing_mode": projected_decision["storage_billing_mode"],
            "storage_package_bytes": projected_decision["storage_package_bytes"],
            "available_bytes": int(current_decision["available_bytes"]),
            "remaining_package_bytes": int(current_decision["remaining_package_bytes"]),
            "projected_remaining_package_bytes": int(projected_decision["remaining_package_bytes"]),
            "current_billable_bytes": int(current_decision["billable_bytes"]),
            "projected_billable_bytes": int(projected_decision["billable_bytes"]),
            "billable_delta_bytes": int(projected_decision["billable_bytes"]) - int(current_decision["billable_bytes"]),
            "projected_exceeded_bytes": int(projected_decision["exceeded_bytes"]),
            "allowed": bool(projected_decision["allowed"]),
        }

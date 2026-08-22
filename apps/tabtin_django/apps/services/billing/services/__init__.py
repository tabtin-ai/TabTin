"""
Billing services 懒加载导出。

避免在 Django app registry 尚未 ready 时，通过 package import 过早触发模型导入。
"""

from __future__ import annotations

from importlib import import_module

_EXPORTS = {
    "MeterPricingService": (".pricing_service", "MeterPricingService"),
    "OrganizationBillingPolicyService": (".policy_service", "OrganizationBillingPolicyService"),
    "OrganizationLlmBudgetService": (".llm_budget_service", "OrganizationLlmBudgetService"),
    "BillingSettlementService": (".settlement_service", "BillingSettlementService"),
    "OrganizationStorageBillingService": (".storage_service", "OrganizationStorageBillingService"),
    "OrganizationEntitlementSyncService": (".entitlement_service", "OrganizationEntitlementSyncService"),
    "EntitlementLimitsService": (".entitlement_limits_service", "EntitlementLimitsService"),
    "EntitlementLimitExceeded": (".entitlement_limits_service", "EntitlementLimitExceeded"),
    "OrganizationStoragePackageService": (".storage_package_service", "OrganizationStoragePackageService"),
    "AddonEntitlementService": (".addon_entitlement_service", "AddonEntitlementService"),
    "BillingUsageService": (".usage_service", "BillingUsageService"),
    "BillingGateway": (".gateway", "BillingGateway"),
    "BillingGuardService": (".guard_service", "BillingGuardService"),
    "BillingBlockedError": (".guard_service", "BillingBlockedError"),
    "BillingRefundService": (".refund_service", "BillingRefundService"),
    "StatementService": (".statement_service", "StatementService"),
    "ServiceGuardService": (".service_guard", "ServiceGuardService"),
    "ServiceDisabledError": (".service_guard", "ServiceDisabledError"),
    "OrganizationLifecycleCleanupService": (".organization_lifecycle_cleanup_service", "OrganizationLifecycleCleanupService"),
    "aggregate_member_usage": (".member_usage_service", "aggregate_member_usage"),
    "build_member_list": (".member_usage_service", "build_member_list"),
    "build_user_info_map": (".member_usage_service", "build_user_info_map"),
    "LowBalanceAlertService": (".low_balance_alert_service", "LowBalanceAlertService"),
    "BillingExportService": (".export_service", "BillingExportService"),
    "ProviderCreditService": (".provider_credit_service", "ProviderCreditService"),
    "matches_provider_credit": (".provider_credit_service", "matches_provider_credit"),
    "FundingAllocation": (".funding_allocator", "FundingAllocation"),
    "FundingAllocator": (".funding_allocator", "FundingAllocator"),
    "allocate_funding": (".funding_allocator", "allocate_funding"),
    "ProviderCreditCapabilityService": (
        ".provider_credit_capability",
        "ProviderCreditCapabilityService",
    ),
    "ProviderCreditAnalyticsService": (
        ".provider_credit_analytics",
        "ProviderCreditAnalyticsService",
    ),
    "SearchBillingReservationService": (
        ".search_reservation_service",
        "SearchBillingReservationService",
    ),
    "grant_new_organization_provider_credits": (
        ".provider_credit_provision",
        "grant_new_organization_provider_credits",
    ),
    "grant_membership_provider_credits": (
        ".provider_credit_provision",
        "grant_membership_provider_credits",
    ),
}

__all__ = list(_EXPORTS.keys())


def __getattr__(name: str):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module_path, attr_name = _EXPORTS[name]
    module = import_module(module_path, __name__)
    value = getattr(module, attr_name)
    globals()[name] = value
    return value

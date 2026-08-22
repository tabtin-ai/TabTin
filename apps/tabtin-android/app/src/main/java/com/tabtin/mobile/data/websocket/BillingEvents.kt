package com.tabtin.mobile.data.websocket

/**
 * Billing WebSocket 事件类型常量。
 *
 * 与 TypeScript `@tabtin/ws-gateway-client` 的 BillingEvents 对齐，
 * 以及后端 `ws_events.py` 中 VALID_EVENT_TYPES 保持一致。
 */
public object BillingEvents {
    public const val BUDGET_WARNING: String = "billing.budget_warning"
    public const val BUDGET_CRITICAL: String = "billing.budget_critical"
    public const val BILLING_BLOCKED: String = "billing.billing_blocked"
    public const val BILLING_UNBLOCKED: String = "billing.billing_unblocked"
    public const val DEGRADATION_ALERT: String = "billing.degradation_alert"
    public const val INVOICE_REFUNDED: String = "billing.invoice_refunded"
    public const val CREDITS_RECHARGED: String = "billing.credits_recharged"
    public const val MEMBERSHIP_ACTIVATED: String = "billing.membership_activated"
    public const val BALANCE_LOW: String = "billing.balance_low"
    public const val MEMBERSHIP_EXPIRING: String = "billing.membership_expiring"
    public const val MEMBERSHIP_EXPIRED: String = "billing.membership_expired"
    public const val AUTO_RENEW_FAILED: String = "billing.auto_renew_failed"
    public const val MEMBERSHIP_DOWNGRADED_OVERLIMIT: String = "billing.membership_downgraded_overlimit"
    public const val QUOTA_EXHAUSTED: String = "billing.quota_exhausted"
    public const val MEMBERSHIP_RENEWAL_CANCELLED: String = "billing.membership_renewal_cancelled"
    public const val BUDGET_RESOLVED: String = "billing.budget_resolved"
    public const val USAGE_AGGREGATED: String = "billing.usage_aggregated"

    public const val INVOICE_COLLECTION_SUCCEEDED: String = "billing.invoice_collection_succeeded"
    public const val INVOICE_COLLECTION_FAILED: String = "billing.invoice_collection_failed"
    public const val PLATFORM_REFUND_FAILED: String = "billing.platform_refund_failed"
    public const val PLATFORM_REFUND_COMPLETED: String = "billing.platform_refund_completed"
    public const val REFUND_PARTIAL_FAILURE: String = "billing.refund_partial_failure"
    public const val STORAGE_WARNING: String = "billing.storage_warning"
    public const val STORAGE_CRITICAL: String = "billing.storage_critical"
    public const val STORAGE_RESOLVED: String = "billing.storage_resolved"
    public const val STORAGE_PACKAGE_EXPIRING: String = "billing.storage_package_expiring"
    public const val STORAGE_AUTO_RENEW_FAILED: String = "billing.storage_auto_renew_failed"

    public const val MEMBER_BUDGET_WARNING: String = "billing.member_budget_warning"
    public const val MEMBER_BUDGET_EXHAUSTED: String = "billing.member_budget_exhausted"
    public const val MEMBER_BUDGET_RESOLVED: String = "billing.member_budget_resolved"
    public const val MEMBER_BUDGET_POLICY_CHANGED: String = "billing.member_budget_policy_changed"

    public const val TOPIC_PREFIX: String = "billing.events"

    public fun topicForOrganization(organizationId: String): String = "$TOPIC_PREFIX.$organizationId"

    /**
     * 收到这些事件后需要触发钱包/用量数据刷新。
     * 与 Electron useBillingEventStream.ts 的 DATA_REFRESH_EVENTS 对齐。
     */
    public val DATA_REFRESH_EVENTS: Set<String> = setOf(
        CREDITS_RECHARGED,
        BALANCE_LOW,
        MEMBERSHIP_ACTIVATED,
        BILLING_UNBLOCKED,
        BILLING_BLOCKED,
        INVOICE_REFUNDED,
        AUTO_RENEW_FAILED,
        MEMBERSHIP_EXPIRING,
        MEMBERSHIP_EXPIRED,
        BUDGET_WARNING,
        BUDGET_CRITICAL,
        DEGRADATION_ALERT,
        MEMBERSHIP_DOWNGRADED_OVERLIMIT,
        QUOTA_EXHAUSTED,
        MEMBERSHIP_RENEWAL_CANCELLED,
        BUDGET_RESOLVED,
        USAGE_AGGREGATED,
        INVOICE_COLLECTION_SUCCEEDED,
        INVOICE_COLLECTION_FAILED,
        PLATFORM_REFUND_COMPLETED,
        PLATFORM_REFUND_FAILED,
        REFUND_PARTIAL_FAILURE,
        STORAGE_WARNING,
        STORAGE_CRITICAL,
        STORAGE_RESOLVED,
        STORAGE_PACKAGE_EXPIRING,
        STORAGE_AUTO_RENEW_FAILED,
        MEMBER_BUDGET_WARNING,
        MEMBER_BUDGET_EXHAUSTED,
        MEMBER_BUDGET_RESOLVED,
        MEMBER_BUDGET_POLICY_CHANGED,
    )
}

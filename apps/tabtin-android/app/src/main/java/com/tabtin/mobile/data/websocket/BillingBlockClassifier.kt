package com.tabtin.mobile.data.websocket

import com.tabtin.mobile.data.model.WSEnvelope

/** 将 `billing.billing_blocked` 分成会话内不足与持续的组织计费保护。 */
public object BillingBlockClassifier {
    public fun isOrganizationGuard(envelope: WSEnvelope): Boolean = isOrganizationGuard(
        blockType = envelope.payloadString("block_type"),
        reason = envelope.payloadString("reason"),
        code = envelope.payloadString("code"),
        errorCode = envelope.payloadString("error_code"),
    )

    public fun isOrganizationGuard(
        blockType: String?, reason: String?, code: String?, errorCode: String?,
    ): Boolean = when (blockType?.trim()?.lowercase()) {
        "request_insufficient_credits" -> false
        "organization_billing_guard" -> true
        else -> (errorCode ?: code ?: reason)?.trim()?.uppercase() !in REQUEST_INSUFFICIENT_CODES
    }

    private val REQUEST_INSUFFICIENT_CODES: Set<String> = setOf(
        "ORGANIZATION_INSUFFICIENT_CREDITS", "BILLING_WALLET_INSUFFICIENT", "INSUFFICIENT_CREDITS",
    )
}

package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.math.RoundingMode

@Serializable
public data class WalletInfo(
    @SerialName("organization_id") val organizationId: String,
    val credits: Int = 0,
    @SerialName("credits_precise") val creditsPrecise: String? = null,
    @SerialName("credits_frozen") val creditsFrozen: Int = 0,
    @SerialName("credits_frozen_precise") val creditsFrozenPrecise: String? = null,
    @SerialName("available_credits") val availableCredits: Int = 0,
    @SerialName("available_credits_precise") val availableCreditsPrecise: String? = null,
)

@Serializable
public data class WalletTransaction(
    val id: String,
    @SerialName("transaction_type") val transactionType: String,
    val amount: Int = 0,
    @SerialName("amount_precise") val amountPrecise: String? = null,
    @SerialName("balance_before") val balanceBefore: Int? = null,
    @SerialName("balance_after") val balanceAfter: Int? = null,
    val description: String = "",
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

/**
 * 格式化点券数值：最多 4 位小数，去尾零，整数不显示小数点。
 * 例：`"12.5678"` → `"12.5678"`，`"100.1000"` → `"100.1"`，`"100.0000"` → `"100"`
 */
public fun formatCreditsAuto(precise: String?, fallbackInt: Int? = null): String {
    val raw = precise ?: return fallbackInt?.toString() ?: "0"
    val bd = raw.toBigDecimalOrNull() ?: return fallbackInt?.toString() ?: "0"
    val stripped = bd.setScale(4, RoundingMode.HALF_UP).stripTrailingZeros()
    return stripped.toPlainString()
}

@Serializable
public data class TransactionsResponse(
    val total: Int = 0,
    val transactions: List<WalletTransaction> = emptyList(),
)

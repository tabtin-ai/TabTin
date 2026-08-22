package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.math.BigDecimal

@Serializable
public data class UsageMeterItem(
    @SerialName("meter_key") val meterKey: String,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("total_credits") val totalCreditsRaw: String? = null,
    val percentage: Double? = null,
) {
    val totalCredits: BigDecimal
        get() = totalCreditsRaw?.toBigDecimalOrNull() ?: BigDecimal.ZERO
}

@Serializable
public data class UsageModelItem(
    @SerialName("model_name") val modelName: String,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("total_credits") val totalCreditsRaw: String? = null,
    val percentage: Double? = null,
) {
    val totalCredits: BigDecimal
        get() = totalCreditsRaw?.toBigDecimalOrNull() ?: BigDecimal.ZERO

    val title: String
        get() = displayName?.takeIf { it.isNotBlank() } ?: modelName
}

@Serializable
public data class UsageDailyTrendItem(
    val date: String,
    @SerialName("total_credits") val totalCreditsRaw: String? = null,
    @SerialName("is_realtime") val isRealtime: Boolean? = null,
)

@Serializable
public data class MemberUsageResponse(
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("user_id") val userId: String? = null,
    @SerialName("monthly_used") val monthlyUsed: String? = null,
    @SerialName("monthly_limit") val monthlyLimit: String? = null,
    @SerialName("daily_used") val dailyUsed: String? = null,
    @SerialName("daily_limit") val dailyLimit: String? = null,
    @SerialName("policy_source") val policySource: String? = null,
    @SerialName("max_model_tier") val maxModelTier: String? = null,
)

@Serializable
public data class UsageDashboardResponse(
    @SerialName("current_month_total_credits") val currentMonthTotalCreditsRaw: String? = null,
    @SerialName("last_month_total_credits") val lastMonthTotalCreditsRaw: String? = null,
    @SerialName("month_over_month_pct") val monthOverMonthPct: Double? = null,
    @SerialName("today_total_credits") val todayTotalCreditsRaw: String? = null,
    @SerialName("today_aggregated_amount") val todayAggregatedAmountRaw: String? = null,
    @SerialName("by_meter") val byMeter: List<UsageMeterItem> = emptyList(),
    @SerialName("by_model") val byModel: List<UsageModelItem> = emptyList(),
    @SerialName("daily_trend") val dailyTrend: List<UsageDailyTrendItem> = emptyList(),
) {
    val currentMonthTotal: BigDecimal
        get() = currentMonthTotalCreditsRaw?.toBigDecimalOrNull() ?: BigDecimal.ZERO

    val lastMonthTotal: BigDecimal
        get() = lastMonthTotalCreditsRaw?.toBigDecimalOrNull() ?: BigDecimal.ZERO

    val todayTotal: BigDecimal
        get() = todayTotalCreditsRaw?.toBigDecimalOrNull() ?: BigDecimal.ZERO

    val todayAggregated: BigDecimal
        get() = todayAggregatedAmountRaw?.toBigDecimalOrNull() ?: BigDecimal.ZERO
}

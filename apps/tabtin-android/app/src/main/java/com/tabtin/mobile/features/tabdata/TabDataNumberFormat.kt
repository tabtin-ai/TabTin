package com.tabtin.mobile.features.tabdata

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.util.Locale

/**
 * 多维表数值类字段的卡片显示格式。与 iOS `NativeTabDataNumberFormatPolicy` 逐字节对齐。
 *
 * percent 正典是 Web `formatPercentCellValue`（table-ui cellValueUtils.ts:65）以及
 * `formatMobileCardValue`（mobileTablePrimitives.ts:127）：后端存小数比值
 *（`0.85` = 85%），显示时 `* 100`、最多两位小数、去掉尾随零、加 `%`。
 * 不认字段 `precision`，也没有千分位。
 */
public object TabDataNumberFormat {
    private val TRAILING_ZEROS = Regex("\\.?0+$")

    /**
     * @return 格式化后的百分比；空值或非有限数字返回 `null`，由调用方回落到原文。
     */
    public fun formatPercent(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val ratio = trimmed.toDoubleOrNull() ?: return null
        if (!ratio.isFinite()) return null
        return formatPercentRatio(ratio)
    }

    public fun formatPercentRatio(ratio: Double): String {
        val fixed = String.format(Locale.US, "%.2f", ratio * 100.0)
        return fixed.replace(TRAILING_ZEROS, "") + "%"
    }

    /** 详情编辑框里的百分点数，与 [formatPercent] 同一套取整，但不带 `%`。 */
    public fun formatPercentEditorPoints(raw: String?): String? =
        formatPercent(raw)?.trimEnd('%')

    /**
     * 与 Web `parsePercentPointsToRatio` 对齐：用户输入百分点数，本地 `/100` 得到比值。
     * 空输入是清空，不是 0。
     */
    public fun parsePercentPointsToRatio(text: String?): Double? {
        val cleaned = text.orEmpty().replace(Regex("""\s*%\s*$"""), "").trim()
        if (cleaned.isEmpty()) return null
        val number = cleaned.toDoubleOrNull() ?: return null
        if (!number.isFinite()) return null
        return number / 100.0
    }

    public fun isPercentEditorIntermediate(text: String): Boolean {
        val cleaned = text.replace(Regex("""\s*%\s*$"""), "").trim()
        if (cleaned.isEmpty()) return false
        if (cleaned == "-" || cleaned == "+" || cleaned == "." || cleaned == "-." || cleaned == "+.") {
            return true
        }
        if (cleaned.endsWith(".") && cleaned.dropLast(1).toDoubleOrNull() != null) {
            return true
        }
        return cleaned.toDoubleOrNull() == null
    }

    /**
     * 把编辑框文本提交成线上比值串。
     * 显示点与原比值格式化结果相同则原样保留，避免 `85/100` 浮点漂移。
     */
    public fun commitPercentEditor(typed: String, storedRatioRaw: String): PercentEditorCommit {
        val cleaned = typed.replace(Regex("""\s*%\s*$"""), "").trim()
        if (cleaned.isEmpty()) return PercentEditorCommit.Empty
        if (isPercentEditorIntermediate(typed)) return PercentEditorCommit.Intermediate
        val storedPoints = formatPercentEditorPoints(storedRatioRaw)
        if (storedPoints != null && storedPoints == cleaned) {
            return PercentEditorCommit.Ratio(storedRatioRaw.trim())
        }
        return try {
            val ratio = java.math.BigDecimal(cleaned).divide(java.math.BigDecimal(100))
            PercentEditorCommit.Ratio(ratio.stripTrailingZeros().toPlainString())
        } catch (_: NumberFormatException) {
            PercentEditorCommit.Intermediate
        }
    }

    public sealed class PercentEditorCommit {
        public data object Empty : PercentEditorCommit()
        public data class Ratio(val raw: String) : PercentEditorCommit()
        public data object Intermediate : PercentEditorCommit()
    }

    /**
     * 与 Web grid `symbol + number.toFixed(precision)` 对齐。没有千分位。
     * 空值或非有限数字返回 `null`，由调用方回落到原文。
     */
    public fun formatCurrency(raw: String?, symbol: String = "¥", precision: Int = 2): String? {
        val number = raw?.trim()?.toDoubleOrNull() ?: return null
        if (!number.isFinite()) return null
        return symbol + String.format(Locale.US, "%.${precision.coerceAtLeast(0)}f", number)
    }

    public fun currencySymbol(options: Map<String, *>?): String {
        val text = scalarText(options?.get("symbol"))?.takeIf { it.isNotEmpty() }
        return text ?: "¥"
    }

    public fun currencyPrecision(options: Map<String, *>?): Int {
        return (scalarInt(options?.get("precision")) ?: 2).coerceIn(0, 10)
    }

    public fun clampRating(raw: String?, max: Int = 5): Int? {
        val number = raw?.trim()?.toDoubleOrNull() ?: return null
        if (!number.isFinite() || number != kotlin.math.floor(number)) return null
        return number.toInt().coerceIn(0, max.coerceAtLeast(0))
    }

    public fun ratingMax(options: Map<String, *>?): Int {
        return (scalarInt(options?.get("max")) ?: 5).coerceIn(1, 10)
    }

    public fun formatRatingStars(raw: String?, max: Int = 5): String? {
        val value = clampRating(raw, max) ?: return null
        return buildString {
            repeat(value) { append('★') }
            repeat((max - value).coerceAtLeast(0)) { append('☆') }
        }
    }

    private fun scalarText(raw: Any?): String? = when (raw) {
        is String -> raw
        is JsonPrimitive -> raw.contentOrNull
        else -> null
    }

    private fun scalarInt(raw: Any?): Int? = when (raw) {
        is Number -> raw.toInt()
        is String -> raw.toIntOrNull()
        is JsonPrimitive -> raw.intOrNull ?: raw.doubleOrNull?.toInt() ?: raw.contentOrNull?.toIntOrNull()
        else -> null
    }
}

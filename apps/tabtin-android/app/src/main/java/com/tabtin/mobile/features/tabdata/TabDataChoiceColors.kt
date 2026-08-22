package com.tabtin.mobile.features.tabdata

import androidx.compose.ui.graphics.Color
import kotlin.math.abs

/**
 * 多维表单选 / 多选胶囊色。必须与 Web `resolveSelectChipColors` 使用同一套
 * 选项语义色、预设色板、djb2 变体 hash 和亮度阈值。
 *
 * 同一条记录会在 Electron、iOS、Android 上同时打开。如果 hash 或映射不一致，
 * 没有保存颜色的历史选项会在各端落到不同预设色，用户会以为数据变了。
 */
public object TabDataChoiceColors {
    /** 与 Web `CHOICE_COLOR_HEX_MAP` 逐条对齐。 */
    public val choiceColorHexMap: Map<String, String> = mapOf(
        "blueLight2" to "#CCE5FF",
        "blueLight1" to "#99CCFF",
        "blueBright" to "#007BFF",
        "blue" to "#0066CC",
        "blueDark1" to "#003F87",
        "cyanLight2" to "#CCF4F8",
        "cyanLight1" to "#99E4EC",
        "cyanBright" to "#00BCD4",
        "cyan" to "#0097A7",
        "cyanDark1" to "#006064",
        "grayLight2" to "#F5F5F5",
        "grayLight1" to "#DCDCDC",
        "grayBright" to "#A0A0A0",
        "gray" to "#808080",
        "grayDark1" to "#505050",
        "greenLight2" to "#CCFFCC",
        "greenLight1" to "#90EE90",
        "greenBright" to "#28A745",
        "green" to "#1E824C",
        "greenDark1" to "#145323",
        "orangeLight2" to "#FFE5CC",
        "orangeLight1" to "#FFCC99",
        "orangeBright" to "#FF9F00",
        "orange" to "#FA8000",
        "orangeDark1" to "#CC5500",
        "pinkLight2" to "#FFE0E6",
        "pinkLight1" to "#FFB6C1",
        "pinkBright" to "#FF407B",
        "pink" to "#FF1493",
        "pinkDark1" to "#C2185B",
        "purpleLight2" to "#E5CCFF",
        "purpleLight1" to "#CC99FF",
        "purpleBright" to "#9B59B6",
        "purple" to "#800080",
        "purpleDark1" to "#663399",
        "redLight2" to "#FFD6D6",
        "redLight1" to "#FFA3A3",
        "redBright" to "#F15646",
        "red" to "#D90A19",
        "redDark1" to "#A30A0A",
        "tealLight2" to "#B2EBF2",
        "tealLight1" to "#80CBC4",
        "tealBright" to "#009688",
        "teal" to "#00796B",
        "tealDark1" to "#004B44",
        "yellowLight2" to "#FFF3BF",
        "yellowLight1" to "#FFEC99",
        "yellowBright" to "#FFD43B",
        "yellow" to "#FCC419",
        "yellowDark1" to "#FAB005",
    )

    /** 与 Web `SELECT_CHOICE_PRESET_COLORS` 逐条对齐。 */
    public val presetColors: List<String> = listOf(
        "#0066CC", "#007BFF", "#99CCFF",
        "#0097A7", "#00BCD4", "#99E4EC",
        "#1E824C", "#28A745", "#90EE90",
        "#FA8000", "#FF9F00", "#FFCC99",
        "#FF1493", "#FF407B", "#FFB6C1",
        "#800080", "#9B59B6", "#CC99FF",
        "#D90A19", "#F15646", "#FFA3A3",
        "#00796B", "#009688", "#80CBC4",
        "#FCC419", "#FFD43B", "#FFEC99",
        "#808080", "#A0A0A0", "#DCDCDC",
    )

    /** 与 Web `resolveSelectChipColors` 逐条对齐。返回 (背景, 前景)。 */
    public fun resolve(color: String?, value: String): Pair<Color, Color> {
        val (background, foreground) = resolveHex(color, value)
        return colorFromHex(background) to colorFromHex(foreground)
    }

    /** 测试与跨端对照用的 HEX 口径。 */
    public fun resolveHex(color: String?, value: String): Pair<String, String> {
        val rawColor = color?.trim().orEmpty()
        choiceColorHexMap[rawColor]?.let { mapped ->
            return mapped to foregroundHex(mapped)
        }
        normalizeHexColor(rawColor)?.let { hex ->
            return hex to foregroundHex(hex)
        }
        val background = presetColors[presetIndex(value)]
        return background to foregroundHex(background)
    }

    /** 与 Web `normalizeHexColor` 对齐：3 位简写展开，输出大写 `#RRGGBB`。 */
    public fun normalizeHexColor(value: String): String? {
        val trimmed = value.trim()
        val shortHex = Regex("^#([0-9a-fA-F]{3})$").find(trimmed)
        if (shortHex != null) {
            val rgb = shortHex.groupValues[1]
            return "#${rgb[0]}${rgb[0]}${rgb[1]}${rgb[1]}${rgb[2]}${rgb[2]}".uppercase()
        }
        val fullHex = Regex("^#([0-9a-fA-F]{6})$").find(trimmed)
        if (fullHex != null) {
            return "#${fullHex.groupValues[1].uppercase()}"
        }
        return null
    }

    /**
     * 与 Web `stableHash` 对齐：UTF-16 code unit + 32 位 djb2 变体，再 `Math.abs`。
     * JS 对 `Int.MIN_VALUE` 的 `Math.abs` 会得到 `2147483648`，不能走 Kotlin 的 32 位溢出。
     */
    public fun stableHash(value: String): Long {
        var hash = 0
        for (unit in value) {
            hash = (hash shl 5) - hash + unit.code
        }
        return if (hash == Int.MIN_VALUE) 2_147_483_648L else abs(hash.toLong())
    }

    public fun isLightHexColor(hex: String): Boolean {
        val normalized = normalizeHexColor(hex) ?: return false
        val red = normalized.substring(1, 3).toInt(16)
        val green = normalized.substring(3, 5).toInt(16)
        val blue = normalized.substring(5, 7).toInt(16)
        val brightness = (red * 299 + green * 587 + blue * 114) / 1000
        return brightness >= 155
    }

    private fun presetIndex(value: String): Int =
        (stableHash(value) % presetColors.size).toInt()

    private fun foregroundHex(background: String): String =
        if (isLightHexColor(background)) "#000000" else "#FFFFFF"

    private fun colorFromHex(hex: String): Color {
        val red = hex.substring(1, 3).toInt(16)
        val green = hex.substring(3, 5).toInt(16)
        val blue = hex.substring(5, 7).toInt(16)
        return Color(red, green, blue)
    }
}

/**
 * 折叠行按可用宽度决定露出几个 chip，放不下的收成 `+N`。
 * 不硬编码「最多 3 个」——N 由宽度自然决定。
 */
public object TabDataChoiceOverflow {
    public fun visibleCount(
        chipWidths: List<Int>,
        overflowWidth: Int,
        spacing: Int,
        availableWidth: Int,
    ): Int {
        if (chipWidths.isEmpty()) return 0
        if (availableWidth <= 0) return chipWidths.size
        var all = 0
        chipWidths.forEachIndexed { index, width ->
            if (index > 0) all += spacing
            all += width
        }
        if (all <= availableWidth) return chipWidths.size
        var used = 0
        var count = 0
        for (width in chipWidths) {
            val gap = if (count > 0) spacing else 0
            if (used + gap + width + spacing + overflowWidth > availableWidth) break
            used += gap + width
            count += 1
        }
        return count
    }
}

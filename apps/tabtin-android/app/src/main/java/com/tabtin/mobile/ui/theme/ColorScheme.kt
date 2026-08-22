package com.tabtin.mobile.ui.theme

import androidx.annotation.StringRes
import androidx.compose.ui.graphics.Color
import com.tabtin.mobile.R

/** 与 iOS / Electron 的 `ColorSchemeId` 值域对齐。 */
public enum class TTColorSchemeId(
    public val rawValue: String,
    @StringRes public val labelRes: Int,
) {
    BLUE("blue", R.string.settings_color_scheme_blue),
    TEAL("teal", R.string.settings_color_scheme_teal),
    ORANGE("orange", R.string.settings_color_scheme_orange),
    ROSE("rose", R.string.settings_color_scheme_rose),
    SLATE("slate", R.string.settings_color_scheme_slate),
    VIOLET("violet", R.string.settings_color_scheme_violet),
    SKY("sky", R.string.settings_color_scheme_sky);

    public companion object {
        public val DEFAULT: TTColorSchemeId = ORANGE

        public fun resolve(raw: String?): TTColorSchemeId =
            entries.firstOrNull { it.rawValue == raw || it.name == raw } ?: DEFAULT
    }
}

public data class TTColorPair(
    val light: Int,
    val dark: Int,
)

public data class TTColorSchemeTokens(
    val bgCanvasDefault: TTColorPair,
    val bgSubtle: TTColorPair,
    val bgSubtleSecondary: TTColorPair,
    val bgAccent: TTColorPair,
    val bgAccentPressed: TTColorPair,
    val bgAccentDisabled: TTColorPair,
    val bgBubbleOutgoing: TTColorPair,
    val bgReasoning: TTColorPair,
    val textPrimary: TTColorPair,
    val textSecondary: TTColorPair,
    val textTertiary: TTColorPair,
    val textAccent: TTColorPair,
    val textDisabled: TTColorPair,
    val iconAccent: TTColorPair,
    val borderLight: TTColorPair,
    val borderInteractive: TTColorPair,
    val borderFocused: TTColorPair,
)

public object TTColorSchemePalette {
    public fun tokens(forId: TTColorSchemeId): TTColorSchemeTokens = when (forId) {
        TTColorSchemeId.BLUE -> blue
        TTColorSchemeId.TEAL -> teal
        TTColorSchemeId.ORANGE -> orange
        TTColorSchemeId.ROSE -> rose
        TTColorSchemeId.SLATE -> slate
        TTColorSchemeId.VIOLET -> violet
        TTColorSchemeId.SKY -> sky
    }

    public fun accentColor(forId: TTColorSchemeId, dark: Boolean = false): Color {
        val pair = tokens(forId).bgAccent
        return colorFromRgb(if (dark) pair.dark else pair.light)
    }

    private val blue = TTColorSchemeTokens(
        bgCanvasDefault = pair(0xF6F7F8, 0x131416),
        bgSubtle = pair(0xEEEFF2, 0x26282B),
        bgSubtleSecondary = pair(0xF1F2F4, 0x222427),
        bgAccent = pair(0x3577D4, 0x5F94DD),
        bgAccentPressed = pair(0x2969C2, 0x4683D8),
        bgAccentDisabled = pair(0xE8EEF7, 0x202C3C),
        bgBubbleOutgoing = pair(0xE2EAF6, 0x24303C),
        bgReasoning = pair(0xE8EEF7, 0x202C3C),
        textPrimary = pair(0x22262A, 0xE3E5E8),
        textSecondary = pair(0x6B6F76, 0x94989E),
        textTertiary = pair(0x9A9EA6, 0x5C6066),
        textAccent = pair(0x3577D4, 0x5F94DD),
        textDisabled = pair(0xB0B6C0, 0x6A7280),
        iconAccent = pair(0x3577D4, 0x5F94DD),
        borderLight = pair(0xE1E3E5, 0x303236),
        borderInteractive = pair(0xC5D0E0, 0x3A4A5E),
        borderFocused = pair(0x3577D4, 0x5F94DD),
    )

    private val teal = TTColorSchemeTokens(
        bgCanvasDefault = pair(0xF6F8F8, 0x131615),
        bgSubtle = pair(0xEEF1F1, 0x272B2B),
        bgSubtleSecondary = pair(0xF1F4F4, 0x222626),
        bgAccent = pair(0x30A6A2, 0x4DCBC7),
        bgAccentPressed = pair(0x2A928F, 0x38C2BD),
        bgAccentDisabled = pair(0xE9F7F6, 0x1F3332),
        bgBubbleOutgoing = pair(0xE0F2F1, 0x243835),
        bgReasoning = pair(0xE9F7F6, 0x1F3332),
        textPrimary = pair(0x232929, 0xE3E8E7),
        textSecondary = pair(0x6B7675, 0x959D9C),
        textTertiary = pair(0x9AA6A5, 0x5A6463),
        textAccent = pair(0x30A6A2, 0x4DCBC7),
        textDisabled = pair(0xA8C0BE, 0x6A8280),
        iconAccent = pair(0x30A6A2, 0x4DCBC7),
        borderLight = pair(0xE1E5E4, 0x303635),
        borderInteractive = pair(0xBFD4D3, 0x3A5554),
        borderFocused = pair(0x30A6A2, 0x4DCBC7),
    )

    private val orange = TTColorSchemeTokens(
        bgCanvasDefault = pair(0xFDFDFC, 0x201F1D),
        bgSubtle = pair(0xF2F0EE, 0x322F2B),
        bgSubtleSecondary = pair(0xF4F3F1, 0x2B2926),
        bgAccent = pair(0xE07E29, 0xE6944C),
        bgAccentPressed = pair(0xCD6F1D, 0xE28432),
        bgAccentDisabled = pair(0xF7E4D4, 0x4A3A2E),
        bgBubbleOutgoing = pair(0xF4DFCC, 0x3C3128),
        bgReasoning = pair(0xFAEFE6, 0x33251C),
        textPrimary = pair(0x2A2622, 0xE9E6E2),
        textSecondary = pair(0x878078, 0x938C85),
        textTertiary = pair(0xB7AEA6, 0x5F5750),
        textAccent = pair(0xE07E29, 0xE6944C),
        textDisabled = pair(0xC6B2A0, 0x8E7B6C),
        iconAccent = pair(0xE07E29, 0xE6944C),
        borderLight = pair(0xE6E3E0, 0x363330),
        borderInteractive = pair(0xD8C8BB, 0x5B4A3C),
        borderFocused = pair(0xE07E29, 0xE6944C),
    )

    private val rose = TTColorSchemeTokens(
        bgCanvasDefault = pair(0xF8F6F7, 0x161314),
        bgSubtle = pair(0xF1EEEF, 0x2B2727),
        bgSubtleSecondary = pair(0xF4F1F2, 0x262323),
        bgAccent = pair(0xC84158, 0xD3697B),
        bgAccentPressed = pair(0xB6354A, 0xCD5166),
        bgAccentDisabled = pair(0xF7E9EB, 0x331F22),
        bgBubbleOutgoing = pair(0xF2DFE3, 0x332225),
        bgReasoning = pair(0xF7E9EB, 0x331F22),
        textPrimary = pair(0x292425, 0xE8E3E4),
        textSecondary = pair(0x756C6D, 0x9D9596),
        textTertiary = pair(0xA69A9C, 0x635A5C),
        textAccent = pair(0xC84158, 0xD3697B),
        textDisabled = pair(0xC4A8AE, 0x8A6A70),
        iconAccent = pair(0xC84158, 0xD3697B),
        borderLight = pair(0xE5E1E2, 0x363031),
        borderInteractive = pair(0xE0C5CB, 0x5A3A40),
        borderFocused = pair(0xC84158, 0xD3697B),
    )

    private val slate = TTColorSchemeTokens(
        bgCanvasDefault = pair(0xF7F7F8, 0x131415),
        bgSubtle = pair(0xEFEFF1, 0x27282A),
        bgSubtleSecondary = pair(0xF2F2F4, 0x222325),
        bgAccent = pair(0x606876, 0x8F96A3),
        bgAccentPressed = pair(0x555B68, 0x7E8695),
        bgAccentDisabled = pair(0xEEEFF1, 0x26282C),
        bgBubbleOutgoing = pair(0xE6E7EA, 0x2A2C31),
        bgReasoning = pair(0xEEEFF1, 0x26282C),
        textPrimary = pair(0x242529, 0xE4E5E7),
        textSecondary = pair(0x6C6F75, 0x95989D),
        textTertiary = pair(0x9A9DA3, 0x5C5F65),
        textAccent = pair(0x606876, 0x8F96A3),
        textDisabled = pair(0xB0B4BA, 0x6A6E74),
        iconAccent = pair(0x606876, 0x8F96A3),
        borderLight = pair(0xE2E3E4, 0x313235),
        borderInteractive = pair(0xC8CCD2, 0x454A52),
        borderFocused = pair(0x606876, 0x8F96A3),
    )

    private val violet = TTColorSchemeTokens(
        bgCanvasDefault = pair(0xF7F7F8, 0x141316),
        bgSubtle = pair(0xF0EEF1, 0x29272B),
        bgSubtleSecondary = pair(0xF3F1F4, 0x242227),
        bgAccent = pair(0x615170, 0x8C7A9F),
        bgAccentPressed = pair(0x544762, 0x7D6991),
        bgAccentDisabled = pair(0xF0EEF2, 0x29242E),
        bgBubbleOutgoing = pair(0xE8E4ED, 0x2C2631),
        bgReasoning = pair(0xF0EEF2, 0x29242E),
        textPrimary = pair(0x262429, 0xE6E3E8),
        textSecondary = pair(0x706C75, 0x99959D),
        textTertiary = pair(0xA09AA6, 0x605A66),
        textAccent = pair(0x615170, 0x8C7A9F),
        textDisabled = pair(0xB4A8C0, 0x6E6478),
        iconAccent = pair(0x615170, 0x8C7A9F),
        borderLight = pair(0xE3E2E4, 0x333036),
        borderInteractive = pair(0xCDC5D4, 0x4A4056),
        borderFocused = pair(0x615170, 0x8C7A9F),
    )

    private val sky = TTColorSchemeTokens(
        bgCanvasDefault = pair(0xFAFAFA, 0x111213),
        bgSubtle = pair(0xF1F3F3, 0x242628),
        bgSubtleSecondary = pair(0xF5F6F6, 0x1F2123),
        bgAccent = pair(0x1FB3E0, 0x49BCDF),
        bgAccentPressed = pair(0x1B9EC5, 0x2FB2DA),
        bgAccentDisabled = pair(0xE7F4F8, 0x1D2F35),
        bgBubbleOutgoing = pair(0xDFF0F5, 0x24343A),
        bgReasoning = pair(0xE7F4F8, 0x1D2F35),
        textPrimary = pair(0x1C1F21, 0xE9EBEC),
        textSecondary = pair(0x676B6F, 0x95999D),
        textTertiary = pair(0x969A9E, 0x5A5E62),
        textAccent = pair(0x1FB3E0, 0x49BCDF),
        textDisabled = pair(0xA0C0CC, 0x5A7880),
        iconAccent = pair(0x1FB3E0, 0x49BCDF),
        borderLight = pair(0xE4E6E7, 0x2E3033),
        borderInteractive = pair(0xB8D4DE, 0x3A5560),
        borderFocused = pair(0x1FB3E0, 0x49BCDF),
    )
}

internal object TTColorSchemeCurrent {
    var id: TTColorSchemeId = TTColorSchemeId.DEFAULT
}

internal fun colorFromRgb(rgb: Int): Color = Color(0xFF000000.toInt() or rgb)

private fun pair(light: Int, dark: Int): TTColorPair = TTColorPair(light = light, dark = dark)

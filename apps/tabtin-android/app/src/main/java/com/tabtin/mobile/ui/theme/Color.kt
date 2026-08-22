package com.tabtin.mobile.ui.theme

import androidx.compose.ui.graphics.Color

public object TTColors {
    internal val currentTokens: TTColorSchemeTokens
        get() = TTColorSchemePalette.tokens(TTColorSchemeCurrent.id)

    private fun light(pair: TTColorPair): Color = colorFromRgb(pair.light)
    private fun dark(pair: TTColorPair): Color = colorFromRgb(pair.dark)

    // region Background (暖中性色底)

    public val Background: Color get() = light(currentTokens.bgCanvasDefault)
    public val Surface: Color get() = light(currentTokens.bgCanvasDefault)
    public val SurfaceVariant: Color get() = light(currentTokens.bgSubtleSecondary)
    public val Card: Color get() = light(currentTokens.bgCanvasDefault)
    /** 任务首页顶栏 / 功能卡片区背景，对齐 iOS `bgSidebar`。 */
    public val BgSidebar: Color = Color(0xFFF9F9F9)
    /** 运行中状态色（跨 scheme 稳定蓝）。勿用作功能入口装饰色。 */
    public val BgRunning: Color = Color(0xFF3577F0)

    // endregion

    // region Brand (TabTin Orange · HSL 28 — 与 iOS/Electron 对齐)

    public val Primary: Color get() = light(currentTokens.bgAccent)
    public val PrimaryVariant: Color get() = light(currentTokens.bgAccentPressed)
    public val PrimaryDisabled: Color get() = light(currentTokens.bgAccentDisabled)
    public val Secondary: Color get() = light(currentTokens.bgAccent)
    public val Accent: Color get() = light(currentTokens.bgAccentPressed)

    // endregion

    // region Resource type

    /** 云文档 / 多维表列表的类型底座，字形本身仍保留品牌渐变。 */
    public val CloudDocIconBackground: Color = Color(0xFFE3F2FD)
    public val CloudTableIconBackground: Color = Color(0xFFE8F5E9)

    // endregion

    // region Status

    public val BgCritical: Color = Color(0xFFC93B3B)
    public val BgSuccess: Color = Color(0xFF2F9461)
    public val BgWarning: Color = Color(0xFFD4870A)

    // endregion

    // region Bubble / Reasoning

    public val BgBubbleOutgoing: Color get() = light(currentTokens.bgBubbleOutgoing)
    public val BgBubbleIncoming: Color get() = light(currentTokens.bgSubtleSecondary)
    public val BgReasoning: Color get() = light(currentTokens.bgReasoning)
    public val BgSubtle: Color get() = light(currentTokens.bgSubtle)
    public val BorderLight: Color get() = light(currentTokens.borderLight)

    // endregion

    // region Overlay

    public val OverlayBackground: Color = Color(0x66000000)
    public val OverlayBackgroundLight: Color = Color(0x26000000)
    public val TextOnOverlay: Color = Color.White

    // endregion

    // region Text (暖中性)

    public val TextPrimary: Color get() = light(currentTokens.textPrimary)
    public val TextSecondary: Color get() = light(currentTokens.textSecondary)
    public val TextTertiary: Color get() = light(currentTokens.textTertiary)
    public val TextOnPrimary: Color = Color(0xFFFFFFFF)
    public val TextAccent: Color get() = light(currentTokens.textAccent)
    public val TextCritical: Color = Color(0xFFC93B3B)
    public val TextDisabled: Color get() = light(currentTokens.textDisabled)
    public val TextSuccess: Color = Color(0xFF2F9461)
    /** 警告文案色；与 iOS `textWarning` / Electron `text-warning` 对齐（同 BgWarning）。 */
    public val TextWarning: Color = Color(0xFFD4870A)

    // endregion

    // region Icon

    public val IconPrimary: Color get() = light(currentTokens.textPrimary)
    public val IconSecondary: Color get() = light(currentTokens.textSecondary)
    public val IconAccent: Color get() = light(currentTokens.iconAccent)

    // endregion

    // region Border (暖中性)

    public val Border: Color get() = light(currentTokens.borderLight)
    public val Divider: Color get() = light(currentTokens.borderLight)
    public val BorderInteractive: Color get() = light(currentTokens.borderInteractive)
    public val BorderFocused: Color get() = light(currentTokens.borderFocused)

    // endregion

    // region Fullscreen (固定色，不随主题切换)

    public val FullscreenBackground: Color = Color.Black
    public val FullscreenForeground: Color = Color.White

    // endregion

    // region Decorative (头像/用户名颜色)

    public val DecorativeBackgrounds: List<Color> = listOf(
        Color(0xFFE8F5E9), Color(0xFFE3F2FD), Color(0xFFFFF3E0),
        Color(0xFFF3E5F5), Color(0xFFFCE4EC), Color(0xFFE0F7FA),
    )
    public val DecorativeTexts: List<Color> = listOf(
        Color(0xFF2E7D32), Color(0xFF1565C0), Color(0xFFE65100),
        Color(0xFF7B1FA2), Color(0xFFC62828), Color(0xFF00838F),
    )

    // endregion

    public object Dark {

        // region Background (暖中性色底)

        public val Background: Color get() = dark(TTColors.currentTokens.bgCanvasDefault)
        public val Surface: Color get() = dark(TTColors.currentTokens.bgCanvasDefault)
        public val SurfaceVariant: Color get() = dark(TTColors.currentTokens.bgSubtleSecondary)
        public val Card: Color get() = dark(TTColors.currentTokens.bgCanvasDefault)
        public val BgSidebar: Color = Color(0xFF141414)
        public val BgRunning: Color = Color(0xFF6098F5)

        // endregion

        // region Brand (TabTin Orange · HSL 28 — 与 iOS/Electron 对齐)

        public val Primary: Color get() = dark(TTColors.currentTokens.bgAccent)
        public val PrimaryVariant: Color get() = dark(TTColors.currentTokens.bgAccentPressed)
        public val PrimaryDisabled: Color get() = dark(TTColors.currentTokens.bgAccentDisabled)
        public val Secondary: Color get() = dark(TTColors.currentTokens.bgAccent)
        public val Accent: Color get() = dark(TTColors.currentTokens.bgAccentPressed)

        // endregion

        // region Resource type

        public val CloudDocIconBackground: Color = Color(0xFF0D2744)
        public val CloudTableIconBackground: Color = Color(0xFF1B3A1E)

        // endregion

        // region Status

        public val BgCritical: Color = Color(0xFFD95555)
        public val BgSuccess: Color = Color(0xFF45AD78)
        public val BgWarning: Color = Color(0xFFD4A030)

        // endregion

        // region Bubble / Reasoning

        public val BgBubbleOutgoing: Color get() = dark(TTColors.currentTokens.bgBubbleOutgoing)
        public val BgBubbleIncoming: Color get() = dark(TTColors.currentTokens.bgSubtleSecondary)
        public val BgReasoning: Color get() = dark(TTColors.currentTokens.bgReasoning)
        public val BgSubtle: Color get() = dark(TTColors.currentTokens.bgSubtle)
        public val BorderLight: Color get() = dark(TTColors.currentTokens.borderLight)

        // endregion

        // region Overlay

        public val OverlayBackground: Color = Color(0x99000000)
        public val OverlayBackgroundLight: Color = Color(0x4D000000)
        public val TextOnOverlay: Color = Color.White

        // endregion

        // region Text (暖中性)

        public val TextPrimary: Color get() = dark(TTColors.currentTokens.textPrimary)
        public val TextSecondary: Color get() = dark(TTColors.currentTokens.textSecondary)
        public val TextTertiary: Color get() = dark(TTColors.currentTokens.textTertiary)
        public val TextOnPrimary: Color = Color(0xFFFFFFFF)
        public val TextAccent: Color get() = dark(TTColors.currentTokens.textAccent)
        public val TextCritical: Color = Color(0xFFD95555)
        public val TextDisabled: Color get() = dark(TTColors.currentTokens.textDisabled)
        public val TextSuccess: Color = Color(0xFF45AD78)
        /** 警告文案色；与 iOS `textWarning` / Electron `text-warning` 对齐（同 BgWarning）。 */
        public val TextWarning: Color = Color(0xFFD4A030)

        // endregion

        // region Icon

        public val IconPrimary: Color get() = dark(TTColors.currentTokens.textPrimary)
        public val IconSecondary: Color get() = dark(TTColors.currentTokens.textSecondary)
        public val IconAccent: Color get() = dark(TTColors.currentTokens.iconAccent)

        // endregion

        // region Border (暖中性)

        public val Border: Color get() = dark(TTColors.currentTokens.borderLight)
        public val Divider: Color get() = dark(TTColors.currentTokens.borderLight)
        public val BorderInteractive: Color get() = dark(TTColors.currentTokens.borderInteractive)
        public val BorderFocused: Color get() = dark(TTColors.currentTokens.borderFocused)

        // endregion

        // region Decorative

        public val DecorativeBackgrounds: List<Color> = listOf(
            Color(0xFF1B3A1E), Color(0xFF0D2744), Color(0xFF3E2700),
            Color(0xFF2A1230), Color(0xFF3E1018), Color(0xFF003038),
        )
        public val DecorativeTexts: List<Color> = listOf(
            Color(0xFF81C784), Color(0xFF64B5F6), Color(0xFFFFB74D),
            Color(0xFFCE93D8), Color(0xFFEF9A9A), Color(0xFF4DD0E1),
        )

        // endregion
    }
}

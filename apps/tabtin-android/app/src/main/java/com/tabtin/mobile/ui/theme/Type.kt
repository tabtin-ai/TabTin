package com.tabtin.mobile.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * TabTin 排版系统 —— **视觉语义对齐 Electron** `design-system.md` §2。
 *
 * 正典文档：`apps/tabtin-android/docs/design-system.md`
 * 对话阅读层（15sp / 1.7）见 [ConversationTypography]。
 *
 * 只用 `caption` / `meta` / `body` / `subtitle` / `title` / `heading` / `display`
 * 及其 Medium / Semibold 变体，以及 `icon*` / `code*` / `iconFeature` 等装饰档。
 */
public object TTFonts {

    // region Roles（与 Electron text-* 一一对应）

    public enum class Role(public val size: Float, public val lineHeight: Float) {
        CAPTION(12f, 18f),
        META(13f, 18f),
        BODY(14f, 22f),
        SUBTITLE(16f, 24f),
        TITLE(20f, 28f),
        HEADING(24f, 32f),
        DISPLAY(32f, 40f),
    }

    /** 空态 / 装饰大图标档（不算正文字号；消除 20–64sp 散点）。 */
    public enum class DecorativeIcon(public val size: Float) {
        FEATURE(22f),
        EMPTY(28f),
        EMPTY_MD(34f),
        EMPTY_LG(40f),
        HERO(48f),
        SPLASH(64f),
    }

    // endregion

    // region Canonical styles（Electron §2）

    public val caption: TextStyle = style(Role.CAPTION)
    public val captionMedium: TextStyle = style(Role.CAPTION, FontWeight.Medium)
    public val captionSemibold: TextStyle = style(Role.CAPTION, FontWeight.SemiBold)

    public val meta: TextStyle = style(Role.META)
    public val metaMedium: TextStyle = style(Role.META, FontWeight.Medium)
    public val metaSemibold: TextStyle = style(Role.META, FontWeight.SemiBold)

    public val body: TextStyle = style(Role.BODY)
    public val bodyMedium: TextStyle = style(Role.BODY, FontWeight.Medium)
    public val bodySemibold: TextStyle = style(Role.BODY, FontWeight.SemiBold)

    public val subtitle: TextStyle = style(Role.SUBTITLE)
    public val subtitleMedium: TextStyle = style(Role.SUBTITLE, FontWeight.Medium)
    public val subtitleSemibold: TextStyle = style(Role.SUBTITLE, FontWeight.SemiBold)

    public val title: TextStyle = style(Role.TITLE)
    public val titleMedium: TextStyle = style(Role.TITLE, FontWeight.Medium)
    public val titleSemibold: TextStyle = style(Role.TITLE, FontWeight.SemiBold)

    public val heading: TextStyle = style(Role.HEADING)
    public val headingMedium: TextStyle = style(Role.HEADING, FontWeight.Medium)
    public val headingSemibold: TextStyle = style(Role.HEADING, FontWeight.SemiBold)

    public val display: TextStyle = style(Role.DISPLAY)
    public val displayMedium: TextStyle = style(Role.DISPLAY, FontWeight.Medium)
    public val displaySemibold: TextStyle = style(Role.DISPLAY, FontWeight.SemiBold)

    // endregion

    // region Code

    public val codeXS: TextStyle = monospace(10f, FontWeight.Normal)
    public val codeXSSemibold: TextStyle = monospace(10f, FontWeight.SemiBold)
    public val codeSM: TextStyle = monospace(12f, FontWeight.Normal)
    public val codeSMSemibold: TextStyle = monospace(12f, FontWeight.SemiBold)
    public val codeBody: TextStyle = monospace(Role.BODY.size, FontWeight.Normal)

    // endregion

    // region UI icons（= 同角色文字点数）

    public val iconCaption: TextStyle = style(Role.CAPTION, FontWeight.SemiBold)
    public val iconCaptionMedium: TextStyle = style(Role.CAPTION, FontWeight.Medium)
    public val iconBody: TextStyle = style(Role.BODY, FontWeight.SemiBold)
    public val iconBodyMedium: TextStyle = style(Role.BODY, FontWeight.Medium)
    public val iconSubtitle: TextStyle = style(Role.SUBTITLE, FontWeight.SemiBold)
    public val iconSubtitleMedium: TextStyle = style(Role.SUBTITLE, FontWeight.Medium)

    // endregion

    // region Decorative / empty-state icons

    public val iconFeature: TextStyle = decorative(DecorativeIcon.FEATURE)
    public val iconFeatureMedium: TextStyle = decorative(DecorativeIcon.FEATURE, FontWeight.Medium)
    public val iconFeatureSemibold: TextStyle = decorative(DecorativeIcon.FEATURE, FontWeight.SemiBold)

    public val iconEmpty: TextStyle = decorative(DecorativeIcon.EMPTY)
    public val iconEmptyMedium: TextStyle = decorative(DecorativeIcon.EMPTY, FontWeight.Medium)
    public val iconEmptySemibold: TextStyle = decorative(DecorativeIcon.EMPTY, FontWeight.SemiBold)

    public val iconEmptyMD: TextStyle = decorative(DecorativeIcon.EMPTY_MD)
    public val iconEmptyMDMedium: TextStyle = decorative(DecorativeIcon.EMPTY_MD, FontWeight.Medium)
    public val iconEmptyMDSemibold: TextStyle = decorative(DecorativeIcon.EMPTY_MD, FontWeight.SemiBold)

    public val iconEmptyLG: TextStyle = decorative(DecorativeIcon.EMPTY_LG)

    public val iconEmptyHero: TextStyle = decorative(DecorativeIcon.HERO)
    public val iconEmptyHeroLight: TextStyle = decorative(DecorativeIcon.HERO, FontWeight.Light)

    public val iconEmptySplash: TextStyle = decorative(DecorativeIcon.SPLASH)

    // endregion

    // region Helpers

    public fun lineHeight(role: Role): androidx.compose.ui.unit.TextUnit = role.lineHeight.sp

    private fun style(role: Role, weight: FontWeight = FontWeight.Normal): TextStyle =
        TextStyle(
            fontSize = role.size.sp,
            lineHeight = role.lineHeight.sp,
            fontWeight = weight,
        )

    private fun decorative(icon: DecorativeIcon, weight: FontWeight = FontWeight.Normal): TextStyle =
        TextStyle(fontSize = icon.size.sp, fontWeight = weight)

    private fun monospace(size: Float, weight: FontWeight): TextStyle =
        TextStyle(
            fontSize = size.sp,
            fontWeight = weight,
            fontFamily = FontFamily.Monospace,
        )

    // endregion
}

public val TabTinTypography: Typography = Typography(
    displayLarge = TTFonts.display,
    headlineLarge = TTFonts.heading,
    headlineMedium = TTFonts.title,
    headlineSmall = TTFonts.subtitleSemibold,
    titleLarge = TTFonts.subtitleSemibold,
    titleMedium = TTFonts.body,
    titleSmall = TTFonts.body,
    bodyLarge = TTFonts.body,
    bodyMedium = TTFonts.body,
    bodySmall = TTFonts.caption,
    labelLarge = TTFonts.meta,
    labelMedium = TTFonts.caption,
    labelSmall = TTFonts.caption,
)

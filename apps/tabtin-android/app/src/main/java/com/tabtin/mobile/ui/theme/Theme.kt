package com.tabtin.mobile.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * 当前是否处于暗色主题。
 * 由 [TabTinTheme] 根据用户选择的 ThemeMode 设置，
 * 子树中的组件可以用它来选择 TTColors / TTColors.Dark。
 */
public val LocalTTDarkTheme: androidx.compose.runtime.ProvidableCompositionLocal<Boolean> = compositionLocalOf { false }
public val LocalTTColorSchemeId: androidx.compose.runtime.ProvidableCompositionLocal<TTColorSchemeId> =
    compositionLocalOf { TTColorSchemeId.DEFAULT }

/**
 * 在 @Composable 中根据当前主题返回正确的 TTColors 色值。
 * 适用于 Warning/Success 等不在 MaterialTheme.colorScheme 中的语义色。
 */
@Composable
public fun ttColor(light: Color, dark: Color): Color =
    if (LocalTTDarkTheme.current) dark else light

private fun lightColorsFor(colorSchemeId: TTColorSchemeId) = lightColorScheme(
    primary = TTColors.Primary,
    onPrimary = TTColors.TextOnPrimary,
    primaryContainer = TTColors.PrimaryDisabled,
    onPrimaryContainer = TTColors.TextPrimary,
    inversePrimary = TTColors.Dark.Primary,
    secondary = TTColors.Secondary,
    onSecondary = TTColors.TextOnPrimary,
    secondaryContainer = TTColors.PrimaryDisabled,
    onSecondaryContainer = TTColors.TextPrimary,
    tertiary = TTColors.Accent,
    onTertiary = TTColors.TextOnPrimary,
    tertiaryContainer = TTColors.PrimaryDisabled,
    onTertiaryContainer = TTColors.TextPrimary,
    background = TTColors.Background,
    onBackground = TTColors.TextPrimary,
    surface = TTColors.Surface,
    onSurface = TTColors.TextPrimary,
    surfaceVariant = TTColors.SurfaceVariant,
    onSurfaceVariant = TTColors.TextSecondary,
    surfaceTint = TTColors.Primary,
    inverseSurface = TTColors.Dark.Surface,
    inverseOnSurface = TTColors.Dark.TextPrimary,
    outline = TTColors.Border,
    outlineVariant = TTColors.Divider,
    error = TTColors.BgCritical,
    onError = TTColors.TextOnPrimary,
    errorContainer = TTColors.BgCritical.copy(alpha = 0.12f),
    onErrorContainer = TTColors.TextCritical,
    scrim = Color.Black,
    surfaceBright = TTColors.Surface,
    surfaceDim = TTColors.BgSubtle,
    surfaceContainerLowest = TTColors.Surface,
    surfaceContainerLow = TTColors.Surface,
    surfaceContainer = TTColors.SurfaceVariant,
    // PullToRefresh 等 Material 组件默认使用此层；设为品牌浅黄，避免回退淡紫色。
    surfaceContainerHigh = TTColors.PrimaryDisabled,
    surfaceContainerHighest = TTColors.SurfaceVariant,
)

private fun darkColorsFor(colorSchemeId: TTColorSchemeId) = darkColorScheme(
    primary = TTColors.Dark.Primary,
    onPrimary = TTColors.Dark.TextOnPrimary,
    primaryContainer = TTColors.Dark.PrimaryDisabled,
    onPrimaryContainer = TTColors.Dark.TextPrimary,
    inversePrimary = TTColors.Primary,
    secondary = TTColors.Dark.Secondary,
    onSecondary = TTColors.Dark.TextOnPrimary,
    secondaryContainer = TTColors.Dark.PrimaryDisabled,
    onSecondaryContainer = TTColors.Dark.TextPrimary,
    tertiary = TTColors.Dark.Accent,
    onTertiary = TTColors.Dark.TextOnPrimary,
    tertiaryContainer = TTColors.Dark.PrimaryDisabled,
    onTertiaryContainer = TTColors.Dark.TextPrimary,
    background = TTColors.Dark.Background,
    onBackground = TTColors.Dark.TextPrimary,
    surface = TTColors.Dark.Surface,
    onSurface = TTColors.Dark.TextPrimary,
    surfaceVariant = TTColors.Dark.SurfaceVariant,
    onSurfaceVariant = TTColors.Dark.TextSecondary,
    surfaceTint = TTColors.Dark.Primary,
    inverseSurface = TTColors.Surface,
    inverseOnSurface = TTColors.TextPrimary,
    outline = TTColors.Dark.Border,
    outlineVariant = TTColors.Dark.Divider,
    error = TTColors.Dark.BgCritical,
    onError = TTColors.Dark.TextOnPrimary,
    errorContainer = TTColors.Dark.BgCritical.copy(alpha = 0.18f),
    onErrorContainer = TTColors.Dark.TextCritical,
    scrim = Color.Black,
    surfaceBright = TTColors.Dark.Surface,
    surfaceDim = TTColors.Dark.BgSubtle,
    surfaceContainerLowest = TTColors.Dark.Surface,
    surfaceContainerLow = TTColors.Dark.Surface,
    surfaceContainer = TTColors.Dark.SurfaceVariant,
    // 与浅色模式一致，避免 Material 默认紫色 surface 泄漏到刷新/选中态。
    surfaceContainerHigh = TTColors.Dark.PrimaryDisabled,
    surfaceContainerHighest = TTColors.Dark.SurfaceVariant,
)

@Composable
public fun TabTinTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    colorSchemeId: TTColorSchemeId = TTColorSchemeId.DEFAULT,
    content: @Composable () -> Unit
) {
    val darkTheme = when (themeMode) {
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
    }
    TTColorSchemeCurrent.id = colorSchemeId
    val colorScheme = if (darkTheme) darkColorsFor(colorSchemeId) else lightColorsFor(colorSchemeId)

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    CompositionLocalProvider(
        LocalTTDarkTheme provides darkTheme,
        LocalTTColorSchemeId provides colorSchemeId,
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = TabTinTypography,
            content = content
        )
    }
}

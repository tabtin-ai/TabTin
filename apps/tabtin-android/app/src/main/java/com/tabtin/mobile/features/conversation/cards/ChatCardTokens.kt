package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

public object ChatCardTokens {
    public val cardPaddingH: Dp = TTSpacing.md
    public val cardPaddingV: Dp = TTSpacing.sm
    public val headerPaddingV: Dp = 6.dp
    public val cardGap: Dp = 6.dp
    public val cardRadius: RoundedCornerShape = TTRadius.Shapes.sm
    public val iconSize: Dp = 14.dp
    public val iconSizeLg: Dp = 16.dp

    public val maxHeightSm: Dp = 150.dp
    public val maxHeightMd: Dp = 250.dp
    public val maxHeightLg: Dp = 400.dp

    @Composable public fun borderDefault(): Color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    @Composable public fun borderError(): Color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.3f)
    @Composable public fun borderSuccess(): Color = ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess).copy(alpha = 0.3f)
    @Composable public fun borderWarning(): Color = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning).copy(alpha = 0.3f)

    @Composable public fun bgCard(): Color = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    @Composable public fun bgHeader(): Color = ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant)
    @Composable public fun bgError(): Color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.08f)
    @Composable public fun bgCode(): Color = ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant)
    @Composable public fun bgTerminal(): Color = ttColor(Color(0xFF1E1E1E), Color(0xFF0D0D0D))

    @Composable public fun textPrimary(): Color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    @Composable public fun textSecondary(): Color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    @Composable public fun textMuted(): Color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    @Composable public fun textSuccess(): Color = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
    @Composable public fun textError(): Color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
    @Composable public fun textAccent(): Color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)

    @Composable public fun diffAddText(): Color = ttColor(Color(0xFF16A34A), Color(0xFF4EC374))
    @Composable public fun diffAddBg(): Color = ttColor(Color(0x1A22C55E), Color(0x2622C55E))
    @Composable public fun diffRemoveText(): Color = ttColor(Color(0xFFDC2626), Color(0xFFF87171))
    @Composable public fun diffRemoveBg(): Color = ttColor(Color(0x1AEF4444), Color(0x26EF4444))

    @Composable public fun riskLow(): Color = ttColor(Color(0xFF2F9461), Color(0xFF4EC374))
    @Composable public fun riskMedium(): Color = ttColor(Color(0xFFD4870A), Color(0xFFF5A623))
    @Composable public fun riskHigh(): Color = ttColor(Color(0xFFC93B3B), Color(0xFFF87171))
    @Composable public fun riskCritical(): Color = ttColor(Color(0xFF9B1D1D), Color(0xFFEF4444))

    @Composable public fun textSshHost(): Color = ttColor(Color(0xFF3B82F6), Color(0xFF60A5FA))
}

package com.tabtin.mobile.features.main

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/** 主 Tab 次级动作项：Lucide 描边 icon + 文案。 */
internal data class PrimaryTabSecondaryBarItem(
    val id: String,
    @StringRes val titleRes: Int,
    @DrawableRes val iconRes: Int,
    val enabled: Boolean = true,
    val onClick: () -> Unit,
)

/**
 * 主 Tab 顶栏下侧钉钉式次级动作条：左起横排 icon + 文字，不足整行不均分，条底 1px 分隔。
 * 视觉对齐 iOS [PrimaryTabSecondaryBar]。
 */
@Composable
internal fun PrimaryTabSecondaryBar(
    items: List<PrimaryTabSecondaryBarItem>,
    modifier: Modifier = Modifier,
    background: Color = ttColor(TTColors.Background, TTColors.Dark.Background),
) {
    if (items.isEmpty()) return

    val iconTint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)
    val textColor = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val borderColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(background),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(
                    start = TTSpacing.sm,
                    end = TTSpacing.sm,
                    top = TTSpacing.xs,
                    bottom = TTSpacing.sm + TTSpacing.xxs,
                ),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items.forEach { item ->
                val title = stringResource(item.titleRes)
                Row(
                    modifier = Modifier
                        .heightIn(min = 44.dp)
                        .clickable(
                            enabled = item.enabled,
                            role = Role.Button,
                            onClick = item.onClick,
                        )
                        .padding(
                            start = TTSpacing.sm + TTSpacing.xxs,
                            end = TTSpacing.md,
                        ),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm - TTSpacing.xxs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        painter = painterResource(item.iconRes),
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                        tint = if (item.enabled) iconTint else iconTint.copy(alpha = 0.4f),
                    )
                    Text(
                        text = title,
                        style = TTFonts.bodySemibold,
                        color = if (item.enabled) textColor else textColor.copy(alpha = 0.4f),
                        maxLines = 1,
                    )
                }
            }
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(borderColor),
        )
    }
}

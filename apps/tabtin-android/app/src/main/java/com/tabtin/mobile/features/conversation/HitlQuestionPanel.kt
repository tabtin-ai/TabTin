package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 反问面板统一外壳：标题和操作区固定，中间内容在可用视口内独立滚动。
 *
 * 面板挂在 Composer 的悬浮层而不是消息列表中，因此不能依赖对话列表承接长内容滚动。
 */
@Composable
internal fun HitlQuestionPanel(
    title: String,
    modifier: Modifier = Modifier,
    contentSpacing: Dp = TTSpacing.md,
    content: @Composable ColumnScope.() -> Unit,
    actions: @Composable RowScope.() -> Unit,
) {
    BoxWithConstraints(modifier = modifier.fillMaxWidth()) {
        val shape = TTRadius.Shapes.md
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = maxHeight)
                .clip(shape)
                .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                .border(
                    1.dp,
                    ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.3f),
                    shape,
                )
                .padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(contentSpacing),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.AutoMirrored.Filled.HelpOutline,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                )
                Spacer(Modifier.width(TTSpacing.sm))
                Text(
                    title,
                    style = TTFonts.captionSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                )
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(contentSpacing),
                content = content,
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm, Alignment.End),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                actions()
            }
        }
    }
}

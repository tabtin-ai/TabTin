package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 对齐 Electron SystemMessageRenderer compaction pill：
 * History 14px + caption；进行中用 ConversationStepShinyText。
 */
@Composable
internal fun CompactionStatusPill(
    inProgress: Boolean,
    modifier: Modifier = Modifier,
) {
    val label = if (inProgress) {
        stringResource(R.string.chat_compaction_in_progress)
    } else {
        stringResource(R.string.chat_compaction_checkpoint)
    }
    val shape = RoundedCornerShape(999.dp)
    val bg = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle).copy(alpha = 0.55f)
    val border = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight).copy(alpha = 0.7f)
    val iconTint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.xxl, vertical = TTSpacing.xs)
            .semantics { contentDescription = label },
        horizontalArrangement = Arrangement.Center,
    ) {
        Row(
            modifier = Modifier
                .clip(shape)
                .background(bg)
                .border(0.5.dp, border, shape)
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Icon(
                imageVector = Icons.Default.History,
                contentDescription = null,
                tint = iconTint,
                modifier = Modifier.size(14.dp),
            )
            if (inProgress) {
                ConversationStepShinyText(
                    text = label,
                    style = ConversationTypography.meta,
                )
            } else {
                Text(
                    text = label,
                    style = ConversationTypography.meta,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.9f),
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

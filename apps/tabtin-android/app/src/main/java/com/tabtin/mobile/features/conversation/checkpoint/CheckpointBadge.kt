package com.tabtin.mobile.features.conversation.checkpoint

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.tabtin.mobile.data.model.CheckpointRecord
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
public fun CheckpointBadge(
    record: CheckpointRecord,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val feedback = remember(record) { buildCheckpointSemanticFeedback(record, context) }
    var showTooltip by remember { mutableStateOf(false) }

    val dotColor = when (feedback.status) {
        "ready" -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
        "degraded" -> ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
        else -> ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    }

    Box(modifier = modifier) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(dotColor)
                .clickable { showTooltip = !showTooltip },
        )

        if (showTooltip) {
            Popup(
                alignment = Alignment.TopStart,
                onDismissRequest = { showTooltip = false },
                properties = PopupProperties(focusable = true),
            ) {
                Box(
                    modifier = Modifier
                        .padding(top = TTSpacing.sm)
                        .clip(TTRadius.Shapes.sm)
                        .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
                        .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
                ) {
                    Text(
                        text = feedback.badgeLabel,
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    )
                }
            }
        }
    }
}

package com.tabtin.mobile.features.conversation.checkpoint

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.CheckpointRecord
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
public fun CapabilityMatrix(
    record: CheckpointRecord,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val feedback = remember(record) { buildCheckpointSemanticFeedback(record, context) }

    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = feedback.title,
            style = TTFonts.captionSemibold,
            color = when (feedback.tone) {
                CheckpointFeedbackTone.SUCCESS ->
                    ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
                CheckpointFeedbackTone.WARNING ->
                    ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
                CheckpointFeedbackTone.DESTRUCTIVE ->
                    ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
                else ->
                    ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
            },
        )

        Spacer(Modifier.height(TTSpacing.xs))

        Text(
            text = feedback.summary,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )

        Spacer(Modifier.height(TTSpacing.md))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(TTRadius.Shapes.sm)
                .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                .padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Text(
                text = stringResource(R.string.checkpoint_capabilities_title),
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )

            feedback.capabilities.forEach { cap ->
                CapabilityRow(cap)
            }
        }

        if (feedback.reasons.isNotEmpty()) {
            Spacer(Modifier.height(TTSpacing.md))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(TTRadius.Shapes.sm)
                    .background(
                        ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning).copy(alpha = 0.1f),
                    )
                    .padding(TTSpacing.md),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                feedback.reasons.forEach { reason ->
                    Text(
                        text = "\u2022 ${reason.text}",
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                    )
                }
            }
        }
    }
}

@Composable
private fun CapabilityRow(cap: CapabilityFeedback) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = if (cap.available) "\u2713" else "\u2717",
            style = TTFonts.caption,
            color = if (cap.available)
                ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
            else
                ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            modifier = Modifier.width(16.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = cap.label,
                style = TTFonts.captionSemibold,
                color = if (cap.available)
                    ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
                else
                    ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
            Text(
                text = cap.detail,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

package com.tabtin.mobile.features.conversation.checkpoint

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.CheckpointImpactFileSummary
import com.tabtin.mobile.data.model.DiffFileSummaryItem
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CheckpointDiffSheet(
    fileSummary: CheckpointImpactFileSummary?,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ttColor(TTColors.Background, TTColors.Dark.Background),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.checkpoint_diff_title),
                    style = TTFonts.subtitleSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDismiss) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = stringResource(R.string.common_close),
                        tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
                    )
                }
            }

            Spacer(Modifier.height(TTSpacing.md))

            if (fileSummary == null || (fileSummary.changed == 0 && fileSummary.files.isNullOrEmpty())) {
                Text(
                    stringResource(R.string.checkpoint_diff_no_data),
                    style = TTFonts.body,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    modifier = Modifier.padding(vertical = TTSpacing.lg),
                )
            } else {
                DiffStatsRow(fileSummary)

                val files = fileSummary.files
                if (!files.isNullOrEmpty()) {
                    Spacer(Modifier.height(TTSpacing.lg))
                    HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
                    Spacer(Modifier.height(TTSpacing.lg))
                    FileList(files)
                }

                Spacer(Modifier.height(TTSpacing.lg))
                Text(
                    stringResource(R.string.checkpoint_diff_desktop_hint),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }

            Spacer(Modifier.height(TTSpacing.xxl))
        }
    }
}

@Composable
private fun DiffStatsRow(summary: CheckpointImpactFileSummary) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            stringResource(R.string.checkpoint_diff_stats_files, summary.changed),
            style = TTFonts.bodySemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
            if (summary.insertions > 0) {
                Text(
                    "+${summary.insertions}",
                    style = TTFonts.bodySemibold,
                    color = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
                )
            }
            if (summary.deletions > 0) {
                Text(
                    "-${summary.deletions}",
                    style = TTFonts.bodySemibold,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }
        }
    }
}

@Composable
private fun FileList(files: List<DiffFileSummaryItem>) {
    Text(
        stringResource(R.string.checkpoint_diff_changed_files),
        style = TTFonts.captionSemibold,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
    )
    Spacer(Modifier.height(TTSpacing.sm))
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .padding(vertical = TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        files.forEach { item ->
            FileRow(item)
        }
    }
}

@Composable
private fun FileRow(item: DiffFileSummaryItem) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = fileStatusLabel(item),
            style = TTFonts.captionSemibold.copy(fontFamily = FontFamily.Monospace),
            color = fileStatusColor(item),
            modifier = Modifier.width(24.dp),
        )
        Text(
            text = item.file,
            style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
            if (item.insertions > 0) {
                Text(
                    "+${item.insertions}",
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
                )
            }
            if (item.deletions > 0) {
                Text(
                    "-${item.deletions}",
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }
        }
    }
}

private fun fileStatusLabel(item: DiffFileSummaryItem): String {
    return when {
        item.deletions > 0 && item.insertions == 0 -> "D"
        item.insertions > 0 && item.deletions == 0 && item.changes == item.insertions -> "A"
        else -> "M"
    }
}

@Composable
private fun fileStatusColor(item: DiffFileSummaryItem) = when (fileStatusLabel(item)) {
    "A" -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
    "D" -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
    else -> ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
}

package com.tabtin.mobile.features.conversation.checkpoint

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.RevertHistoryEntry
import com.tabtin.mobile.data.model.SessionRollbackState
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun RevertHistorySheet(
    history: List<RevertHistoryEntry>,
    isLoading: Boolean,
    loadFailed: Boolean,
    rollbackState: SessionRollbackState?,
    onRetry: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ttColor(TTColors.Background, TTColors.Dark.Background),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.checkpoint_history_title),
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

        HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))

        when {
            isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(200.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(32.dp),
                        strokeWidth = 3.dp,
                        color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    )
                }
            }

            loadFailed -> {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xxl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        stringResource(R.string.checkpoint_history_load_failed),
                        style = TTFonts.body,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                    Spacer(Modifier.height(TTSpacing.md))
                    TextButton(onClick = onRetry) {
                        Text(
                            stringResource(R.string.common_retry),
                            style = TTFonts.bodySemibold,
                            color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                        )
                    }
                }
            }

            history.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xxl),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        stringResource(R.string.checkpoint_history_empty),
                        style = TTFonts.body,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
            }

            else -> {
                LazyColumn(
                    modifier = Modifier.padding(horizontal = TTSpacing.lg),
                ) {
                    if (rollbackState != null) {
                        item {
                            CurrentStateCard(rollbackState)
                            Spacer(Modifier.height(TTSpacing.md))
                        }
                    }

                    val reversed = history.reversed()
                    itemsIndexed(reversed, key = { idx, e -> "${e.createdAt}-${e.type}-$idx" }) { _, entry ->
                        HistoryEntryRow(entry)
                        Spacer(Modifier.height(TTSpacing.sm))
                    }

                    item { Spacer(Modifier.height(TTSpacing.xxl)) }
                }
            }
        }
    }
}

@Composable
private fun CurrentStateCard(rollbackState: SessionRollbackState) {
    val hasFileFailure = rollbackState.partialSuccessDetails?.workspaceFiles?.let { !it.success } ?: false
    val retryableCount = rollbackState.partialSuccessDetails?.resources?.retryable?.size ?: 0
    val isPartial = rollbackState.lastApplyResult == "partial_success"
        || hasFileFailure
        || retryableCount > 0
        || (rollbackState.partialSuccessDetails?.resources?.failedCount ?: 0) > 0
        || rollbackState.cleanupStatus == "pending_retry"

    val statusText = when {
        rollbackState.lastApplyResult == "failed" -> stringResource(R.string.checkpoint_history_status_failed)
        isPartial -> stringResource(R.string.checkpoint_history_status_partial)
        else -> stringResource(R.string.checkpoint_history_status_success)
    }

    val statusColor = when {
        rollbackState.lastApplyResult == "failed" -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
        isPartial -> ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
        else -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(TTRadius.md))
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .padding(TTSpacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.checkpoint_history_current_state),
                style = TTFonts.bodySemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
            Spacer(Modifier.width(TTSpacing.sm))
            Text(
                statusText,
                style = TTFonts.captionSemibold,
                color = statusColor,
                modifier = Modifier
                    .clip(RoundedCornerShape(TTRadius.sm))
                    .background(statusColor.copy(alpha = 0.1f))
                    .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xxs),
            )
        }

        Spacer(Modifier.height(TTSpacing.xs))

        val description = when {
            rollbackState.revertActive && rollbackState.canUnrevert ->
                stringResource(R.string.checkpoint_history_can_unrevert)
            rollbackState.revertActive ->
                stringResource(R.string.checkpoint_history_reverted_locked)
            isPartial ->
                stringResource(R.string.checkpoint_history_resolved_issues)
            else ->
                stringResource(R.string.checkpoint_history_not_reverted)
        }
        Text(
            description,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )

        if (hasFileFailure) {
            Spacer(Modifier.height(TTSpacing.xxs))
            Text(
                stringResource(R.string.checkpoint_history_file_failure),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
        if (retryableCount > 0) {
            Spacer(Modifier.height(TTSpacing.xxs))
            Text(
                stringResource(R.string.checkpoint_history_retryable_count, retryableCount),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
        if (rollbackState.cleanupStatus == "pending_retry") {
            Spacer(Modifier.height(TTSpacing.xxs))
            Text(
                stringResource(R.string.checkpoint_history_cleanup_pending_retry),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
        if (rollbackState.cleanupStatus == "pending") {
            Spacer(Modifier.height(TTSpacing.xxs))
            Text(
                stringResource(R.string.checkpoint_history_cleanup_pending),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
    }
}

@Composable
private fun HistoryEntryRow(entry: RevertHistoryEntry) {
    val typeLabel = when (entry.type) {
        "rollback" -> stringResource(R.string.checkpoint_history_type_rollback)
        "resource_rollback" -> stringResource(R.string.checkpoint_history_type_resource_rollback)
        "unrevert" -> stringResource(R.string.checkpoint_history_type_unrevert)
        else -> entry.type
    }

    val iconColor = when (entry.type) {
        "rollback" -> ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
        "resource_rollback" -> ttColor(TTColors.Primary, TTColors.Dark.Primary)
        "unrevert" -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
        else -> ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    }

    val hasFileFailure = entry.partialSuccessDetails?.workspaceFiles?.let { !it.success } ?: false
    val resourceDetails = entry.partialSuccessDetails?.resources
    val inferredStatus = entry.applyResult
        ?: if (hasFileFailure || (resourceDetails?.failedCount ?: 0) > 0 || (resourceDetails?.retryable?.size ?: 0) > 0) "partial_success" else "success"

    Row(modifier = Modifier.fillMaxWidth()) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(CircleShape)
                    .background(iconColor.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Refresh,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = iconColor,
                )
            }
        }

        Spacer(Modifier.width(TTSpacing.sm))

        Column(modifier = Modifier.weight(1f)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        typeLabel,
                        style = TTFonts.bodySemibold,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    )
                    Spacer(Modifier.width(TTSpacing.xs))
                    StatusBadge(inferredStatus)
                }
                Text(
                    formatTime(entry.createdAt),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }

            Spacer(Modifier.height(TTSpacing.xxs))

            when (entry.type) {
                "rollback" -> RollbackDetails(entry, hasFileFailure, resourceDetails)
                "resource_rollback" -> ResourceRollbackDetails(entry)
                "unrevert" -> UnrevertDetails(entry, hasFileFailure)
            }

            val retryableCount = resourceDetails?.retryable?.size ?: 0
            if (retryableCount > 0) {
                Text(
                    stringResource(R.string.checkpoint_history_retryable_hint, retryableCount),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                )
            }
        }
    }
}

@Composable
private fun RollbackDetails(
    entry: RevertHistoryEntry,
    hasFileFailure: Boolean,
    resourceDetails: com.tabtin.mobile.data.model.CheckpointResourcesPartialDetail?,
) {
    if (entry.messagesRemoved != null && entry.messagesRemoved > 0) {
        Text(
            stringResource(R.string.checkpoint_history_msgs_removed, entry.messagesRemoved),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
    if (entry.snapshotHash != null) {
        Text(
            if (hasFileFailure) stringResource(R.string.checkpoint_history_files_failed)
            else stringResource(R.string.checkpoint_history_files_restored),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
    val restoredCount = resourceDetails?.restoredCount ?: 0
    val failedCount = resourceDetails?.failedCount ?: 0
    if (restoredCount > 0 || failedCount > 0) {
        Text(
            if (failedCount > 0)
                stringResource(R.string.checkpoint_history_resources_partial, restoredCount, failedCount)
            else
                stringResource(R.string.checkpoint_history_resources_success, restoredCount),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

@Composable
private fun ResourceRollbackDetails(entry: RevertHistoryEntry) {
    if (entry.restoredCount != null && entry.restoredCount > 0) {
        Text(
            stringResource(R.string.checkpoint_history_resource_restored, entry.restoredCount),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
    if (entry.failedCount != null && entry.failedCount > 0) {
        Text(
            stringResource(R.string.checkpoint_history_resource_failed, entry.failedCount),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
        )
    }
}

@Composable
private fun UnrevertDetails(entry: RevertHistoryEntry, hasFileFailure: Boolean) {
    Text(
        stringResource(R.string.checkpoint_history_unreverted),
        style = TTFonts.caption,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
    )
    if (entry.resourceCount != null && entry.resourceCount > 0) {
        Text(
            stringResource(R.string.checkpoint_history_unrevert_resources, entry.resourceCount),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
    if (entry.snapshotHash != null) {
        Text(
            if (hasFileFailure) stringResource(R.string.checkpoint_history_unrevert_files_failed)
            else stringResource(R.string.checkpoint_history_unrevert_files_restored),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

@Composable
private fun StatusBadge(status: String) {
    val (text, color) = when (status) {
        "success" -> stringResource(R.string.checkpoint_history_status_success) to
            ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
        "partial_success" -> stringResource(R.string.checkpoint_history_status_partial) to
            ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
        "failed" -> stringResource(R.string.checkpoint_history_status_failed) to
            ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
        else -> return
    }

    Text(
        text,
        style = TTFonts.captionSemibold,
        color = color,
        modifier = Modifier
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(color.copy(alpha = 0.1f))
            .padding(horizontal = TTSpacing.sm, vertical = 1.dp),
    )
}

private fun formatTime(iso: String): String {
    if (iso.isBlank()) return ""
    return try {
        val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val date = parser.parse(iso.take(19)) ?: return iso
        val formatter = SimpleDateFormat("MM/dd HH:mm", Locale.getDefault())
        formatter.format(date)
    } catch (_: Exception) {
        iso
    }
}

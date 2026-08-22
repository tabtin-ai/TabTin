package com.tabtin.mobile.features.conversation.checkpoint

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SessionRollbackState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

private enum class LayerStatus { SUCCESS, PARTIAL_SUCCESS, FAILED, PENDING }

private data class LayerChip(
    val label: String,
    val detail: String,
    val status: LayerStatus,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
public fun RevertBanner(
    rollbackState: SessionRollbackState,
    isExecuting: Boolean,
    onUnrevert: () -> Unit,
    onRetryResources: (() -> Unit)? = null,
    onViewHistory: (() -> Unit)? = null,
    onDismiss: (() -> Unit)? = null,
    fileRestoreStatus: String? = null,
    fileRestoreReason: String? = null,
    failedFiles: List<String> = emptyList(),
    isRetrying: Boolean = false,
    modifier: Modifier = Modifier,
) {
    if (!rollbackState.revertActive) return

    val partialDetails = rollbackState.partialSuccessDetails
    val persistedFileDetail = partialDetails?.workspaceFiles
    val normalizedFileStatus = fileRestoreStatus?.lowercase()
        ?: persistedFileDetail?.status?.lowercase()
    val effectiveFileReason = fileRestoreReason ?: persistedFileDetail?.reason
    val hasFileFailure = when (normalizedFileStatus) {
        "unavailable", "partial", "partial_success", "failed" -> true
        "success", "not_applicable", "skipped" -> false
        else -> persistedFileDetail?.let { !it.success } ?: false
    }
    val resourceInfo = partialDetails?.resources
    val retryable = resourceInfo?.retryable ?: emptyList()
    val hasRetryableRestores = retryable.isNotEmpty()

    val resultStatus = rollbackState.lastApplyResult ?: "success"
    val currentStatus = when {
        resultStatus == "failed" -> "failed"
        resultStatus == "partial_success"
            || hasFileFailure
            || hasRetryableRestores
            || (resourceInfo?.failedCount ?: 0) > 0
            || rollbackState.cleanupStatus == "pending_retry" -> "partial_success"
        else -> "success"
    }

    val bgColor = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)

    val headline = when (currentStatus) {
        "failed" -> stringResource(R.string.checkpoint_reverted_failed_title)
        "partial_success" -> stringResource(R.string.checkpoint_reverted_partial_title)
        else -> stringResource(R.string.checkpoint_reverted_success_title)
    }

    val guidance = when {
        hasRetryableRestores -> stringResource(R.string.checkpoint_reverted_retry_hint, retryable.size)
        hasFileFailure -> fileRestoreFailureMessage(effectiveFileReason)
        normalizedFileStatus == "not_applicable" ->
            stringResource(R.string.checkpoint_files_not_applicable)
        rollbackState.canUnrevert -> stringResource(R.string.checkpoint_reverted_can_unrevert)
        else -> null
    }

    val layerChips = buildLayerChips(
        rollbackState,
        hasFileFailure,
        normalizedFileStatus,
        resourceInfo,
        retryable,
    )

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(bgColor)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    headline,
                    style = TTFonts.bodySemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                )
                if (guidance != null) {
                    Spacer(Modifier.height(TTSpacing.xxs))
                    Text(
                        guidance,
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                if (rollbackState.canUnrevert) {
                    TextButton(
                        onClick = onUnrevert,
                        enabled = !isExecuting,
                    ) {
                        if (isExecuting) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(14.dp),
                                strokeWidth = 2.dp,
                                color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                            )
                            Spacer(Modifier.width(TTSpacing.xs))
                        }
                        Text(
                            stringResource(R.string.checkpoint_unrevert),
                            style = TTFonts.captionSemibold,
                            color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                        )
                    }
                }
                if (onDismiss != null) {
                    IconButton(onClick = onDismiss) {
                        Icon(
                            Icons.Default.Close,
                            contentDescription = stringResource(R.string.common_close),
                            tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
                        )
                    }
                }
            }
        }

        if (layerChips.isNotEmpty()) {
            Spacer(Modifier.height(TTSpacing.sm))
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                layerChips.forEach { chip ->
                    StatusChip(
                        label = chip.label,
                        detail = chip.detail,
                        status = chip.status,
                    )
                }
            }
        }

        if (failedFiles.isNotEmpty()) {
            Spacer(Modifier.height(TTSpacing.sm))
            Text(
                stringResource(
                    R.string.checkpoint_failed_files,
                    failedFiles.take(3).joinToString(", "),
                ),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                maxLines = 2,
            )
        }

        if (onViewHistory != null) {
            Spacer(Modifier.height(TTSpacing.sm))
            TextButton(onClick = onViewHistory) {
                Icon(
                    Icons.Default.Refresh,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
                Spacer(Modifier.width(TTSpacing.xxs))
                Text(
                    stringResource(R.string.checkpoint_view_history),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
        }

        if (hasRetryableRestores && onRetryResources != null) {
            Spacer(Modifier.height(TTSpacing.sm))
            OutlinedButton(
                onClick = onRetryResources,
                enabled = !isRetrying && !isExecuting,
            ) {
                if (isRetrying) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                    )
                } else {
                    Icon(
                        Icons.Default.Refresh,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                    )
                }
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    stringResource(R.string.checkpoint_retry_restore),
                    style = TTFonts.captionSemibold,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }
        }
    }
}

@Composable
private fun fileRestoreFailureMessage(reason: String?): String = when (reason) {
    "device_offline", "control_device_offline", "preview_not_delivered", "preview_timeout" ->
        stringResource(R.string.checkpoint_files_restore_device_offline)
    "execution_context_missing", "no_control_device", "device_fingerprint_missing" ->
        stringResource(R.string.checkpoint_files_restore_no_device)
    "no_file_anchor", "no_file_changes" ->
        stringResource(R.string.checkpoint_files_not_applicable)
    "no_file_history" -> stringResource(R.string.checkpoint_files_restore_no_history)
    "file_snapshot_missing" -> stringResource(R.string.checkpoint_files_restore_snapshot_missing)
    "path_guard_denied" -> stringResource(R.string.checkpoint_files_restore_protected_path)
    "unrestorable_files" -> stringResource(R.string.checkpoint_files_restore_unrestorable)
    "preview_stale", "file_preview_stale" ->
        stringResource(R.string.checkpoint_files_restore_preview_stale)
    "file_restore_result_unknown", "file_restore_finalize_failed", "file_restore_finalize_expired" ->
        stringResource(R.string.checkpoint_files_restore_result_unknown)
    else -> stringResource(R.string.checkpoint_rollback_file_restore_failed)
}

@Composable
private fun StatusChip(
    label: String,
    detail: String,
    status: LayerStatus,
) {
    val style = chipStyle(status)

    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(style.bgColor)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            style.icon,
            contentDescription = null,
            modifier = Modifier.size(12.dp),
            tint = style.contentColor,
        )
        Spacer(Modifier.width(TTSpacing.xxs))
        Text(
            label,
            style = TTFonts.captionSemibold,
            color = style.contentColor,
        )
        Spacer(Modifier.width(TTSpacing.xxs))
        Text(
            detail,
            style = TTFonts.caption,
            color = style.contentColor.copy(alpha = 0.8f),
        )
    }
}

private data class ChipStyleResult(
    val bgColor: Color,
    val borderColor: Color,
    val contentColor: Color,
    val icon: ImageVector,
)

@Composable
private fun chipStyle(status: LayerStatus): ChipStyleResult = when (status) {
    LayerStatus.SUCCESS -> ChipStyleResult(
        bgColor = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess).copy(alpha = 0.1f),
        borderColor = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess).copy(alpha = 0.2f),
        contentColor = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
        icon = Icons.Default.CheckCircle,
    )
    LayerStatus.PARTIAL_SUCCESS -> ChipStyleResult(
        bgColor = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent).copy(alpha = 0.1f),
        borderColor = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent).copy(alpha = 0.2f),
        contentColor = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
        icon = Icons.Default.Warning,
    )
    LayerStatus.FAILED -> ChipStyleResult(
        bgColor = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.1f),
        borderColor = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.2f),
        contentColor = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
        icon = Icons.Default.Warning,
    )
    LayerStatus.PENDING -> ChipStyleResult(
        bgColor = ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.1f),
        borderColor = ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.2f),
        contentColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
        icon = Icons.Default.Refresh,
    )
}

@Composable
private fun buildLayerChips(
    rollbackState: SessionRollbackState,
    hasFileFailure: Boolean,
    fileRestoreStatus: String?,
    resourceInfo: com.tabtin.mobile.data.model.CheckpointResourcesPartialDetail?,
    retryable: List<com.tabtin.mobile.data.model.CheckpointRetryableResource>,
): List<LayerChip> {
    val chips = mutableListOf<LayerChip>()

    chips.add(LayerChip(
        label = stringResource(R.string.checkpoint_layer_conversation),
        detail = stringResource(R.string.checkpoint_layer_conversation_rolled_back),
        status = LayerStatus.SUCCESS,
    ))

    val (fileDetail, fileChipStatus) = when (fileRestoreStatus) {
        "not_applicable", "skipped" ->
            stringResource(R.string.checkpoint_layer_files_not_applicable) to LayerStatus.SUCCESS
        "unavailable" ->
            stringResource(R.string.checkpoint_layer_files_unavailable) to LayerStatus.FAILED
        "partial", "partial_success" ->
            stringResource(R.string.checkpoint_layer_files_partial) to LayerStatus.PARTIAL_SUCCESS
        "failed" ->
            stringResource(R.string.checkpoint_layer_files_failed) to LayerStatus.FAILED
        else -> if (hasFileFailure) {
            stringResource(R.string.checkpoint_layer_files_failed) to LayerStatus.FAILED
        } else {
            stringResource(R.string.checkpoint_layer_files_rolled_back) to LayerStatus.SUCCESS
        }
    }
    chips.add(
        LayerChip(
            label = stringResource(R.string.checkpoint_layer_files),
            detail = fileDetail,
            status = fileChipStatus,
        ),
    )

    val restoredCount = resourceInfo?.restoredCount ?: 0
    val failedCount = resourceInfo?.failedCount ?: 0
    val resourceApplicable = restoredCount > 0 || failedCount > 0 || retryable.isNotEmpty()

    if (resourceApplicable) {
        val (detail, status) = when {
            failedCount > 0 && restoredCount > 0 ->
                stringResource(R.string.checkpoint_layer_resources_partial, restoredCount, failedCount) to LayerStatus.PARTIAL_SUCCESS
            failedCount > 0 ->
                stringResource(R.string.checkpoint_layer_resources_failed, failedCount) to LayerStatus.FAILED
            retryable.isNotEmpty() ->
                stringResource(R.string.checkpoint_layer_resources_retryable, retryable.size) to LayerStatus.PARTIAL_SUCCESS
            else ->
                stringResource(R.string.checkpoint_layer_resources_restored, restoredCount) to LayerStatus.SUCCESS
        }
        chips.add(LayerChip(
            label = stringResource(R.string.checkpoint_layer_resources),
            detail = detail,
            status = status,
        ))
    }

    val cleanupStatus = rollbackState.cleanupStatus
    val cleanupChip = when (cleanupStatus) {
        "pending" -> LayerChip(
            label = stringResource(R.string.checkpoint_layer_cleanup),
            detail = stringResource(R.string.checkpoint_layer_cleanup_pending),
            status = LayerStatus.PENDING,
        )
        "pending_retry" -> LayerChip(
            label = stringResource(R.string.checkpoint_layer_cleanup),
            detail = stringResource(R.string.checkpoint_layer_cleanup_retry),
            status = LayerStatus.PARTIAL_SUCCESS,
        )
        "failed" -> LayerChip(
            label = stringResource(R.string.checkpoint_layer_cleanup),
            detail = stringResource(R.string.checkpoint_layer_cleanup_failed),
            status = LayerStatus.FAILED,
        )
        "abandoned" -> LayerChip(
            label = stringResource(R.string.checkpoint_layer_cleanup),
            detail = stringResource(R.string.checkpoint_layer_cleanup_abandoned),
            status = LayerStatus.FAILED,
        )
        else -> null
    }
    if (cleanupChip != null) chips.add(cleanupChip)

    return chips
}

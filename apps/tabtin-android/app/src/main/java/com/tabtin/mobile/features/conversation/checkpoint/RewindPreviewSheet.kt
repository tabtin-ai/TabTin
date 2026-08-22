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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.CheckpointImpactFileSummary
import com.tabtin.mobile.data.model.ResourceRestorePlanItem
import com.tabtin.mobile.data.model.RollbackPreviewResponse
import com.tabtin.mobile.features.conversation.EditResendPreviewDisposition
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.features.conversation.ConversationTypography
import com.tabtin.mobile.features.conversation.editResendPreviewDecision
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun RewindPreviewSheet(
    preview: RollbackPreviewResponse?,
    isLoading: Boolean,
    isExecuting: Boolean,
    errorMessage: String?,
    onConfirm: (
        excludedResources: Set<String>,
        rollbackReason: String,
        allowConversationOnly: Boolean,
    ) -> Unit,
    onDismiss: () -> Unit,
    onRetry: (() -> Unit)? = null,
    onViewHistory: (() -> Unit)? = null,
    isEditResend: Boolean = false,
    confirmEnabled: Boolean = true,
) {
    val sheetState = rememberTTSheetState()

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ttColor(TTColors.Background, TTColors.Dark.Background),
    ) {
        TTSheetColumn(
            modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(
                        if (isEditResend) R.string.chat_message_edit_preview_title
                        else R.string.checkpoint_rewind_title,
                    ),
                    style = TTFonts.subtitleSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    modifier = Modifier.weight(1f),
                )
                if (onViewHistory != null) {
                    TextButton(onClick = onViewHistory) {
                        Text(
                            stringResource(R.string.checkpoint_revert_history),
                            style = TTFonts.caption,
                            color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                        )
                    }
                }
                IconButton(onClick = onDismiss) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = stringResource(R.string.common_close),
                        tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
                    )
                }
            }

            Spacer(Modifier.height(TTSpacing.md))

            when {
                isLoading -> {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(120.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(32.dp),
                            strokeWidth = 3.dp,
                            color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                        )
                    }
                }

                errorMessage != null -> {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = TTSpacing.lg),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            errorMessage,
                            style = TTFonts.body,
                            color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                        )
                        if (onRetry != null) {
                            Spacer(Modifier.height(TTSpacing.md))
                            OutlinedButton(onClick = onRetry) {
                                Text(
                                    stringResource(R.string.common_retry),
                                    style = TTFonts.bodySemibold,
                                )
                            }
                        }
                    }
                }

                preview != null -> {
                    PreviewContent(
                        preview = preview,
                        isExecuting = isExecuting,
                        onConfirm = onConfirm,
                        onRetry = onRetry,
                        isEditResend = isEditResend,
                        confirmEnabled = confirmEnabled,
                    )
                }
            }

            Spacer(Modifier.height(TTSpacing.xxl))
        }
    }
}

@Composable
private fun PreviewContent(
    preview: RollbackPreviewResponse,
    isExecuting: Boolean,
    onConfirm: (excludedResources: Set<String>, rollbackReason: String, allowConversationOnly: Boolean) -> Unit,
    onRetry: (() -> Unit)?,
    isEditResend: Boolean,
    confirmEnabled: Boolean,
) {
    val context = LocalContext.current
    var excludedResources by remember { mutableStateOf<Set<String>>(emptySet()) }
    var rollbackReason by remember { mutableStateOf("") }
    var showDiffSheet by remember { mutableStateOf(false) }
    var allowConversationOnly by remember(preview.targetMessageId) { mutableStateOf(false) }
    val editResendDecision = preview.editResendPreviewDecision()
    val fileSummary: CheckpointImpactFileSummary? =
        preview.effectiveCheckpoint?.impactSummary?.fileSummary

    preview.effectiveCheckpoint?.let { checkpoint ->
        CapabilityMatrix(record = checkpoint)
        Spacer(Modifier.height(TTSpacing.lg))
        HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
        Spacer(Modifier.height(TTSpacing.lg))
    }

    if (preview.noImpact) {
        Text(
            stringResource(R.string.checkpoint_no_impact),
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            modifier = Modifier.padding(vertical = TTSpacing.lg),
        )
        return
    }

    if (isEditResend) {
        SectionHeader(stringResource(R.string.chat_message_edit_restore_point_section))
        Spacer(Modifier.height(TTSpacing.sm))
        InfoRow(
            label = stringResource(R.string.chat_message_edit_restore_point_label),
            value = preview.targetTimestamp?.takeIf { it.isNotBlank() }?.let { timestamp ->
                formatCheckpointVersionTime(context, timestamp)
            }
                ?: stringResource(R.string.chat_message_edit_restore_point_before_message),
        )
        Spacer(Modifier.height(TTSpacing.lg))
    }

    if (preview.messagesToRemove > 0) {
        SectionHeader(stringResource(R.string.checkpoint_messages_section))
        Spacer(Modifier.height(TTSpacing.sm))
        InfoRow(
            label = stringResource(R.string.checkpoint_messages_to_remove),
            value = preview.messagesToRemove.toString(),
        )
        Spacer(Modifier.height(TTSpacing.sm))

        if (preview.messagesPreview.isNotEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(TTRadius.Shapes.sm)
                    .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                    .padding(TTSpacing.md),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                preview.messagesPreview.take(5).forEach { msg ->
                    Row(verticalAlignment = Alignment.Top) {
                        Text(
                            text = if (msg.role == "user") stringResource(R.string.checkpoint_role_you)
                            else stringResource(R.string.checkpoint_role_ai),
                            style = TTFonts.captionSemibold,
                            color = if (msg.role == "user")
                                ttColor(TTColors.Primary, TTColors.Dark.Primary)
                            else
                                ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                        )
                        Spacer(Modifier.width(TTSpacing.xs))
                        Text(
                            text = msg.contentPreview,
                            style = TTFonts.caption,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (preview.messagesPreview.size > 5) {
                    Text(
                        stringResource(R.string.checkpoint_more_messages, preview.messagesPreview.size - 5),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
            }
        }
    }

    if (isEditResend || preview.impact?.files?.available == true || preview.affectedPaths.isNotEmpty()) {
        Spacer(Modifier.height(TTSpacing.lg))
        HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
        Spacer(Modifier.height(TTSpacing.lg))

        SectionHeader(stringResource(R.string.checkpoint_files_section))
        Spacer(Modifier.height(TTSpacing.sm))
        when (preview.effectiveFilePreviewStatus) {
            "available" -> {
                Text(
                    if (preview.affectedPaths.isEmpty()) {
                        stringResource(R.string.checkpoint_files_will_restore)
                    } else {
                        stringResource(R.string.checkpoint_files_restore_count, preview.affectedPaths.size)
                    },
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
                if (preview.affectedPaths.isNotEmpty()) {
                    Spacer(Modifier.height(TTSpacing.sm))
                    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs)) {
                        preview.affectedPaths.take(5).forEach { path ->
                            Text(
                                text = path,
                                style = TTFonts.caption,
                                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (preview.affectedPaths.size > 5) {
                            Text(
                                stringResource(
                                    R.string.checkpoint_files_more,
                                    preview.affectedPaths.size - 5,
                                ),
                                style = TTFonts.caption,
                                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            )
                        }
                    }
                }
            }
            "not_applicable" -> Text(
                stringResource(R.string.checkpoint_files_not_applicable),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
            "unavailable" -> Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                Text(
                    filePreviewUnavailableMessage(preview.filePreviewReason),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
                preview.unrestorableFiles.take(5).forEach { issue ->
                    Text(
                        text = "${issue.path} · ${filePreviewIssueMessage(issue.reason)}",
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            else -> Text(
                stringResource(R.string.checkpoint_files_preview_unknown),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
            )
        }

        if (fileSummary != null && fileSummary.changed > 0) {
            Spacer(Modifier.height(TTSpacing.sm))
            OutlinedButton(onClick = { showDiffSheet = true }) {
                Text(
                    stringResource(R.string.checkpoint_view_file_changes),
                    style = TTFonts.captionSemibold,
                )
            }
        }
    }

    if (showDiffSheet) {
        CheckpointDiffSheet(
            fileSummary = fileSummary,
            onDismiss = { showDiffSheet = false },
        )
    }

    if (preview.resourceRestorePlan.isNotEmpty() || isEditResend) {
        Spacer(Modifier.height(TTSpacing.lg))
        HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
        Spacer(Modifier.height(TTSpacing.lg))

        SectionHeader(stringResource(R.string.checkpoint_resources_section))
        Spacer(Modifier.height(TTSpacing.sm))

        val resourcePreviewStatus = preview.resourcePreviewStatus?.lowercase()
        val hasResourceEvidence = preview.resourceChanges.isNotEmpty() ||
            preview.resourceRestorePlan.isNotEmpty() ||
            (preview.impact?.resources?.changeCount ?: 0) > 0
        val resourcePreviewUnavailable = resourcePreviewStatus == null ||
            resourcePreviewStatus == "unavailable" ||
            (resourcePreviewStatus == "not_applicable" && hasResourceEvidence) ||
            (resourcePreviewStatus == "available" && !hasResourceEvidence)
        if (resourcePreviewUnavailable) {
            Text(
                stringResource(R.string.checkpoint_resources_preview_unavailable),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
            )
        } else if (resourcePreviewStatus == "not_applicable") {
            Text(
                stringResource(R.string.checkpoint_resources_not_applicable),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        } else Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            preview.resourceRestorePlan.forEach { item ->
                val key = "${item.resourceType}:${item.resourceId}"
                val isExcluded = excludedResources.contains(key)
                ResourcePlanRow(
                    item = item,
                    isExcluded = isExcluded,
                    onToggle = if (item.canRestore) {
                        {
                            excludedResources = if (isExcluded) {
                                excludedResources - key
                            } else {
                                excludedResources + key
                            }
                        }
                    } else null,
                )
            }
        }
    }

    if (preview.unrestorableItems.isNotEmpty()) {
        Spacer(Modifier.height(TTSpacing.lg))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(TTRadius.Shapes.sm)
                .background(ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.12f))
                .padding(TTSpacing.md),
        ) {
            Text(
                stringResource(R.string.checkpoint_unrestorable_title),
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
            )
            Spacer(Modifier.height(TTSpacing.xs))
            preview.unrestorableItems.forEach { item ->
                Text(
                    "\u2022 $item",
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }
        }
    }

    if (preview.degradedReasons.isNotEmpty()) {
        Spacer(Modifier.height(TTSpacing.lg))
        Text(
            stringResource(R.string.checkpoint_degraded_warning),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
        )
    }

    Spacer(Modifier.height(TTSpacing.xl))

    if (!isEditResend) OutlinedTextField(
        value = rollbackReason,
        onValueChange = { if (it.length <= 500) rollbackReason = it },
        label = { Text(stringResource(R.string.checkpoint_rollback_reason_label)) },
        placeholder = { Text(stringResource(R.string.checkpoint_rollback_reason_placeholder)) },
        modifier = Modifier
            .fillMaxWidth()
            .height(100.dp),
        textStyle = TTFonts.caption,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            unfocusedBorderColor = ttColor(TTColors.Divider, TTColors.Dark.Divider),
            focusedLabelColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            unfocusedLabelColor = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            cursorColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
        ),
        maxLines = 4,
    )

    Spacer(Modifier.height(TTSpacing.md))

    Text(
        stringResource(
            if (isEditResend) R.string.chat_message_edit_preview_hint
            else R.string.checkpoint_reversible_hint,
        ),
        style = TTFonts.caption,
        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = TTSpacing.sm),
    )

    if (
        isEditResend &&
        editResendDecision.disposition == EditResendPreviewDisposition.ACKNOWLEDGEMENT_REQUIRED
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(TTRadius.Shapes.sm)
                .background(ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.1f))
                .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(
                checked = allowConversationOnly,
                onCheckedChange = { allowConversationOnly = it },
                colors = CheckboxDefaults.colors(
                    checkedColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    uncheckedColor = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                ),
            )
            Text(
                stringResource(R.string.chat_message_edit_conversation_only_ack),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(TTSpacing.sm))
    }

    val previewBlocked = isEditResend &&
        editResendDecision.disposition == EditResendPreviewDisposition.BLOCKED
    if (previewBlocked && onRetry != null) {
        OutlinedButton(
            onClick = onRetry,
            enabled = !isExecuting,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.checkpoint_recheck_impact), style = TTFonts.bodySemibold)
        }
        Spacer(Modifier.height(TTSpacing.sm))
    }

    val acknowledgementSatisfied = editResendDecision.disposition !=
        EditResendPreviewDisposition.ACKNOWLEDGEMENT_REQUIRED || allowConversationOnly
    val effectiveConfirmEnabled = confirmEnabled && !previewBlocked && acknowledgementSatisfied

    Button(
        onClick = { onConfirm(excludedResources, rollbackReason.trim(), allowConversationOnly) },
        enabled = !isExecuting && effectiveConfirmEnabled,
        modifier = Modifier.fillMaxWidth(),
        colors = ButtonDefaults.buttonColors(
            containerColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
            contentColor = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
        ),
    ) {
        if (isExecuting) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
            )
            Spacer(Modifier.width(TTSpacing.sm))
        }
        Text(
            stringResource(
                if (
                    isEditResend &&
                    editResendDecision.disposition == EditResendPreviewDisposition.ACKNOWLEDGEMENT_REQUIRED
                ) R.string.chat_message_edit_confirm_partial_resend
                else if (isEditResend) R.string.chat_message_edit_confirm_resend
                else R.string.checkpoint_confirm_rewind,
            ),
            style = ConversationTypography.bodySemibold,
        )
    }
}

@Composable
private fun filePreviewUnavailableMessage(reason: String?): String = when (reason) {
    "device_offline", "preview_not_delivered", "preview_timeout" ->
        stringResource(R.string.checkpoint_files_preview_device_offline)
    "execution_context_missing", "no_control_device", "device_fingerprint_missing" ->
        stringResource(R.string.checkpoint_files_preview_no_device)
    "not_electron_host" ->
        stringResource(R.string.checkpoint_files_preview_other_host)
    "file_snapshot_missing" ->
        stringResource(R.string.checkpoint_files_preview_snapshot_missing)
    "no_file_history" ->
        stringResource(R.string.checkpoint_files_preview_no_history)
    "path_guard_denied" ->
        stringResource(R.string.checkpoint_files_preview_path_blocked)
    else -> stringResource(R.string.checkpoint_files_preview_unavailable)
}

@Composable
private fun filePreviewIssueMessage(reason: String?): String = when (reason) {
    "backup_missing" -> stringResource(R.string.checkpoint_file_issue_backup_missing)
    "backup_failed" -> stringResource(R.string.checkpoint_file_issue_backup_failed)
    "unsupported" -> stringResource(R.string.checkpoint_file_issue_unsupported)
    else -> stringResource(R.string.checkpoint_file_issue_unrestorable)
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        title,
        style = TTFonts.captionSemibold,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
    )
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            label,
            style = TTFonts.body,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        Text(
            value,
            style = TTFonts.bodySemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
    }
}

@Composable
private fun ResourcePlanRow(
    item: ResourceRestorePlanItem,
    isExcluded: Boolean,
    onToggle: (() -> Unit)?,
) {
    val context = LocalContext.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .padding(
                start = if (onToggle != null) TTSpacing.xs else TTSpacing.md,
                end = TTSpacing.md,
                top = TTSpacing.md,
                bottom = TTSpacing.md,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onToggle != null) {
            Checkbox(
                checked = !isExcluded,
                onCheckedChange = { onToggle() },
                colors = CheckboxDefaults.colors(
                    checkedColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    uncheckedColor = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                ),
                modifier = Modifier.size(36.dp),
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                item.resourceName.ifEmpty { item.resourceId },
                style = TTFonts.body,
                color = if (isExcluded)
                    ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                else
                    ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(TTSpacing.xxs))
            Text(
                item.actionLabel.ifEmpty { item.action },
                style = TTFonts.caption,
                color = when {
                    isExcluded -> ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                    item.canRestore -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
                    else -> ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                },
            )
            item.restoreToVersionTime?.takeIf { it.isNotBlank() }?.let { versionTime ->
                Spacer(Modifier.height(TTSpacing.xxs))
                Text(
                    stringResource(
                        R.string.checkpoint_resource_restore_version,
                        formatCheckpointVersionTime(context, versionTime),
                    ),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
        }
        if (item.changeCount > 0) {
            Text(
                stringResource(R.string.checkpoint_change_count, item.changeCount),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

private fun formatCheckpointVersionTime(context: android.content.Context, raw: String): String {
    val instant = runCatching { java.time.OffsetDateTime.parse(raw).toInstant() }
        .recoverCatching { java.time.Instant.parse(raw) }
        .getOrNull()
        ?: return raw
    val locale = java.util.Locale.getDefault()
    val pattern = android.text.format.DateFormat.getBestDateTimePattern(locale, "MMMdHm")
    return java.text.SimpleDateFormat(pattern, locale).format(java.util.Date.from(instant))
}

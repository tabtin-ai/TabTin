package com.tabtin.mobile.features.conversation.checkpoint

import android.content.Context
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.CheckpointCapabilityScope
import com.tabtin.mobile.data.model.CheckpointRecord

internal enum class CheckpointFeedbackTone { SUCCESS, WARNING, DESTRUCTIVE, MUTED }

public data class CapabilityFeedback(
    val key: String,
    val label: String,
    val available: Boolean,
    val detail: String,
)

public data class DegradedReasonFeedback(
    val id: String,
    val text: String,
)

internal data class CheckpointSemanticFeedback(
    val status: String,
    val tone: CheckpointFeedbackTone,
    val badgeLabel: String,
    val title: String,
    val summary: String,
    val capabilities: List<CapabilityFeedback>,
    val reasons: List<DegradedReasonFeedback>,
)

private val VALID_REASONS = setOf(
    "missing_file_snapshot",
    "missing_resource_snapshot",
    "missing_effective_checkpoint",
)

private fun dedupeReasons(record: CheckpointRecord): List<String> {
    val seen = mutableSetOf<String>()
    return record.degradedReasons.filter { it in VALID_REASONS && seen.add(it) }
}

private fun resolveStatus(record: CheckpointRecord, reasons: List<String>): String {
    record.status.takeIf { it.isNotEmpty() }?.let { return it }
    return if (reasons.isNotEmpty()) "unavailable" else "ready"
}

private fun resolveScope(record: CheckpointRecord): CheckpointCapabilityScope {
    return record.capabilityScope ?: CheckpointCapabilityScope(messagePreview = true)
}

private fun getTone(status: String): CheckpointFeedbackTone = when (status) {
    "ready" -> CheckpointFeedbackTone.SUCCESS
    "degraded" -> CheckpointFeedbackTone.WARNING
    "unavailable" -> CheckpointFeedbackTone.DESTRUCTIVE
    else -> CheckpointFeedbackTone.MUTED
}

private fun getReasonText(
    reason: String,
    scope: CheckpointCapabilityScope,
    ctx: Context,
): String = when (reason) {
    "missing_file_snapshot" ->
        ctx.getString(R.string.checkpoint_reason_missing_file_snapshot)
    "missing_resource_snapshot" ->
        ctx.getString(R.string.checkpoint_reason_missing_resource_snapshot)
    "missing_effective_checkpoint" ->
        if (scope.resourceRestore)
            ctx.getString(R.string.checkpoint_reason_missing_effective_with_resource)
        else
            ctx.getString(R.string.checkpoint_reason_missing_effective)
    else -> reason
}

private fun buildCapabilities(
    scope: CheckpointCapabilityScope,
    ctx: Context,
): List<CapabilityFeedback> = listOf(
    CapabilityFeedback(
        key = "message_preview",
        label = ctx.getString(R.string.checkpoint_cap_message_preview),
        available = scope.messagePreview,
        detail = ctx.getString(
            if (scope.messagePreview) R.string.checkpoint_cap_message_preview_on
            else R.string.checkpoint_cap_message_preview_off,
        ),
    ),
    CapabilityFeedback(
        key = "file_diff",
        label = ctx.getString(R.string.checkpoint_cap_file_diff),
        available = scope.fileDiff,
        detail = ctx.getString(
            if (scope.fileDiff) R.string.checkpoint_cap_file_diff_on
            else R.string.checkpoint_cap_file_diff_off,
        ),
    ),
    CapabilityFeedback(
        key = "file_restore",
        label = ctx.getString(R.string.checkpoint_cap_file_restore),
        available = scope.fileRestore,
        detail = ctx.getString(
            if (scope.fileRestore) R.string.checkpoint_cap_file_restore_on
            else R.string.checkpoint_cap_file_restore_off,
        ),
    ),
    CapabilityFeedback(
        key = "resource_restore",
        label = ctx.getString(R.string.checkpoint_cap_resource_restore),
        available = scope.resourceRestore,
        detail = ctx.getString(
            if (scope.resourceRestore) R.string.checkpoint_cap_resource_restore_on
            else R.string.checkpoint_cap_resource_restore_off,
        ),
    ),
    CapabilityFeedback(
        key = "unrevert",
        label = ctx.getString(R.string.checkpoint_cap_unrevert),
        available = scope.unrevert,
        detail = ctx.getString(
            if (scope.unrevert) R.string.checkpoint_cap_unrevert_on
            else R.string.checkpoint_cap_unrevert_off,
        ),
    ),
)

private data class StatusCopy(val badge: String, val title: String, val summary: String)

private fun buildStatusCopy(
    status: String,
    scope: CheckpointCapabilityScope,
    reasons: List<String>,
    ctx: Context,
): StatusCopy = when {
    status == "ready" -> StatusCopy(
        badge = ctx.getString(R.string.checkpoint_badge_ready),
        title = ctx.getString(R.string.checkpoint_title_ready),
        summary = ctx.getString(R.string.checkpoint_summary_ready),
    )
    status == "degraded" && reasons.contains("missing_resource_snapshot") -> StatusCopy(
        badge = ctx.getString(R.string.checkpoint_badge_degraded),
        title = ctx.getString(R.string.checkpoint_title_degraded),
        summary = ctx.getString(R.string.checkpoint_summary_degraded_no_resource),
    )
    status == "degraded" && !scope.fileRestore && scope.resourceRestore -> StatusCopy(
        badge = ctx.getString(R.string.checkpoint_badge_degraded),
        title = ctx.getString(R.string.checkpoint_title_degraded),
        summary = ctx.getString(R.string.checkpoint_summary_degraded_no_file),
    )
    status == "degraded" -> StatusCopy(
        badge = ctx.getString(R.string.checkpoint_badge_degraded),
        title = ctx.getString(R.string.checkpoint_title_degraded),
        summary = ctx.getString(R.string.checkpoint_summary_degraded_generic),
    )
    scope.resourceRestore -> StatusCopy(
        badge = ctx.getString(R.string.checkpoint_badge_unavailable_with_resource),
        title = ctx.getString(R.string.checkpoint_title_unavailable_with_resource),
        summary = ctx.getString(R.string.checkpoint_summary_unavailable_with_resource),
    )
    else -> StatusCopy(
        badge = ctx.getString(R.string.checkpoint_badge_unavailable),
        title = ctx.getString(R.string.checkpoint_title_unavailable),
        summary = ctx.getString(R.string.checkpoint_summary_unavailable),
    )
}

internal fun buildCheckpointSemanticFeedback(
    record: CheckpointRecord,
    context: Context,
): CheckpointSemanticFeedback {
    val reasons = dedupeReasons(record)
    val status = resolveStatus(record, reasons)
    val scope = resolveScope(record)
    val copy = buildStatusCopy(status, scope, reasons, context)

    return CheckpointSemanticFeedback(
        status = status,
        tone = getTone(status),
        badgeLabel = copy.badge,
        title = copy.title,
        summary = copy.summary,
        capabilities = buildCapabilities(scope, context),
        reasons = reasons.map {
            DegradedReasonFeedback(id = it, text = getReasonText(it, scope, context))
        },
    )
}

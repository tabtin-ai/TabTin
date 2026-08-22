package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ResourceRestoreResponse
import com.tabtin.mobile.data.model.RollbackPreviewResponse
import com.tabtin.mobile.data.model.RollbackResponse
import com.tabtin.mobile.data.model.SessionRollbackState
import kotlinx.coroutines.CancellationException

internal enum class EditResendPreviewDisposition {
    READY,
    ACKNOWLEDGEMENT_REQUIRED,
    BLOCKED,
}

internal data class EditResendPreviewDecision(
    val disposition: EditResendPreviewDisposition,
    val approvedUnavailableFileReason: String? = null,
    val approvedUnrestorableFilePaths: Set<String> = emptySet(),
    val hasFileRisk: Boolean = false,
    val hasResourceRisk: Boolean = false,
)

private val conversationOnlyFileReasons = setOf(
    "no_file_history",
    "file_snapshot_missing",
    "path_guard_denied",
    "unrestorable_files",
)

private enum class ResourcePreviewDisposition { READY, ACKNOWLEDGEMENT_REQUIRED, BLOCKED }

private fun RollbackPreviewResponse.resourcePreviewDisposition(): ResourcePreviewDisposition {
    val status = resourcePreviewStatus?.lowercase() ?: return ResourcePreviewDisposition.BLOCKED
    val changedKeys = resourceChanges
        .mapTo(mutableSetOf()) { "${it.resourceType}:${it.resourceId}" }
    val plannedKeys = resourceRestorePlan
        .mapTo(mutableSetOf()) { "${it.resourceType}:${it.resourceId}" }
    val hasAffectedEvidence = changedKeys.isNotEmpty() || resourceRestorePlan.isNotEmpty() ||
        (impact?.resources?.changeCount ?: 0) > 0
    val hasOpaqueAffectedResources = changedKeys.isEmpty() && plannedKeys.isEmpty() &&
        (impact?.resources?.changeCount ?: 0) > 0

    if (status == "unavailable") return ResourcePreviewDisposition.BLOCKED
    if (status == "not_applicable") {
        return if (hasAffectedEvidence) ResourcePreviewDisposition.BLOCKED else ResourcePreviewDisposition.READY
    }
    if (status != "available" || !hasAffectedEvidence || hasOpaqueAffectedResources) {
        return ResourcePreviewDisposition.BLOCKED
    }

    // status=available 只表示服务端声称预览完成；客户端仍要验证每个受影响
    // 资源都有计划项，避免部分 plan 被误当作“已知不可恢复”。
    if (!plannedKeys.containsAll(changedKeys)) return ResourcePreviewDisposition.BLOCKED
    return if (resourceRestorePlan.any { !it.canRestore }) {
        ResourcePreviewDisposition.ACKNOWLEDGEMENT_REQUIRED
    } else {
        ResourcePreviewDisposition.READY
    }
}

internal fun RollbackPreviewResponse.editResendPreviewDecision(): EditResendPreviewDecision {
    if (noImpact) return EditResendPreviewDecision(EditResendPreviewDisposition.BLOCKED)
    if (
        rollbackContractVersion >= 2 &&
        (previewRevision.isNullOrBlank() || filePreviewRevision.isNullOrBlank())
    ) {
        return EditResendPreviewDecision(EditResendPreviewDisposition.BLOCKED)
    }

    // v2 使用严格的文件预览语义：available 必须有具体路径，not_applicable
    // 必须是空路径。协议自相矛盾时要求重新预览，不能替服务端猜测含义。
    if (
        rollbackContractVersion >= 2 &&
        (
            (effectiveFilePreviewStatus == "available" && affectedPaths.isEmpty()) ||
                (effectiveFilePreviewStatus == "not_applicable" && affectedPaths.isNotEmpty())
        )
    ) {
        return EditResendPreviewDecision(EditResendPreviewDisposition.BLOCKED)
    }

    val normalizedFileReason = filePreviewReason?.lowercase()
    val approvedFileReason = normalizedFileReason
        ?.takeIf {
            effectiveFilePreviewStatus == "unavailable" &&
                it in conversationOnlyFileReasons &&
                (it != "unrestorable_files" || unrestorableFiles.isNotEmpty())
        }
    val fileDisposition = when (effectiveFilePreviewStatus) {
        "available", "not_applicable" -> EditResendPreviewDisposition.READY
        "unavailable" -> if (approvedFileReason != null) {
            EditResendPreviewDisposition.ACKNOWLEDGEMENT_REQUIRED
        } else {
            EditResendPreviewDisposition.BLOCKED
        }
        else -> EditResendPreviewDisposition.BLOCKED
    }
    val resourceDisposition = resourcePreviewDisposition()
    val overall = when {
        fileDisposition == EditResendPreviewDisposition.BLOCKED ||
            resourceDisposition == ResourcePreviewDisposition.BLOCKED -> EditResendPreviewDisposition.BLOCKED
        fileDisposition == EditResendPreviewDisposition.ACKNOWLEDGEMENT_REQUIRED ||
            resourceDisposition == ResourcePreviewDisposition.ACKNOWLEDGEMENT_REQUIRED ->
            EditResendPreviewDisposition.ACKNOWLEDGEMENT_REQUIRED
        else -> EditResendPreviewDisposition.READY
    }
    return EditResendPreviewDecision(
        disposition = overall,
        approvedUnavailableFileReason = approvedFileReason,
        approvedUnrestorableFilePaths = if (approvedFileReason != null) {
            unrestorableFiles.mapNotNullTo(mutableSetOf()) { issue ->
                issue.path.trim().takeIf(String::isNotEmpty)
            }
        } else {
            emptySet()
        },
        hasFileRisk = fileDisposition == EditResendPreviewDisposition.ACKNOWLEDGEMENT_REQUIRED,
        hasResourceRisk = resourceDisposition == ResourcePreviewDisposition.ACKNOWLEDGEMENT_REQUIRED,
    )
}

internal fun RollbackPreviewResponse.canExecuteEditResend(
    allowConversationOnly: Boolean = false,
): Boolean = when (editResendPreviewDecision().disposition) {
    EditResendPreviewDisposition.READY -> true
    EditResendPreviewDisposition.ACKNOWLEDGEMENT_REQUIRED -> allowConversationOnly
    EditResendPreviewDisposition.BLOCKED -> false
}

/**
 * 编辑重发的事务边界：只有回退、资源恢复和权威时间线替换全部成功后，才允许发送。
 *
 * UI 的“预览确认”发生在调用本函数之前；这里集中执行确认后的不可交换步骤，避免任一
 * 调用点把刷新或发送提前，重新制造“旧消息仍在、编辑内容被追加”的分叉。
 */
internal sealed interface EditResendTimelineRewriteOutcome {
    data class Success(val rollbackState: SessionRollbackState?) : EditResendTimelineRewriteOutcome

    data class Failure(
        val error: Throwable,
        val stage: FailureStage,
        /** 对话层已经被服务端改写时为 true，调用方不能把它当作一次无副作用重试。 */
        val rollbackApplied: Boolean,
        val rollbackState: SessionRollbackState? = null,
        val failedFiles: List<String> = emptyList(),
        val fileRestoreReason: String? = null,
        val resourceErrors: List<String> = emptyList(),
    ) : EditResendTimelineRewriteOutcome

    enum class FailureStage { ROLLBACK, FILES, RESOURCES, REFRESH, SEND }
}

internal suspend fun executeEditResendTimelineRewrite(
    rollback: suspend () -> RollbackResponse,
    restoreResources: suspend () -> ResourceRestoreResponse,
    refreshAuthoritativeHistory: suspend () -> Boolean,
    sendEditedMessage: suspend () -> Boolean,
    approvedUnavailableFileReason: String? = null,
    approvedUnrestorableFilePaths: Set<String> = emptySet(),
): EditResendTimelineRewriteOutcome {
    var rollbackApplied = false
    var rollbackState: SessionRollbackState? = null
    var failedFiles: List<String> = emptyList()
    var fileRestoreReason: String? = null
    var resourceErrors: List<String> = emptyList()
    var failureStage = EditResendTimelineRewriteOutcome.FailureStage.ROLLBACK

    return try {
        val rollbackResponse = rollback()
        rollbackState = rollbackResponse.rollbackState
        failedFiles = rollbackResponse.failedFiles
        fileRestoreReason = rollbackResponse.fileRestoreReason
        if (!rollbackResponse.success) {
            error(rollbackResponse.message?.takeIf { it.isNotBlank() } ?: "Conversation rollback failed")
        }
        rollbackApplied = true
        failureStage = EditResendTimelineRewriteOutcome.FailureStage.FILES
        if (rollbackResponse.hasFileRestoreFailure) {
            val executionReason = rollbackResponse.fileRestoreReason?.lowercase()
            val normalizedApprovedPaths = approvedUnrestorableFilePaths
                .mapTo(mutableSetOf()) { it.trim() }
                .filterTo(mutableSetOf()) { it.isNotEmpty() }
            val normalizedFailedPaths = rollbackResponse.failedFiles
                .mapTo(mutableSetOf()) { it.trim() }
                .filterTo(mutableSetOf()) { it.isNotEmpty() }
            val approvedPathEvidenceMatches = when {
                executionReason == "unrestorable_files" ->
                    normalizedApprovedPaths.isNotEmpty() &&
                        normalizedFailedPaths.isNotEmpty() &&
                        normalizedApprovedPaths.containsAll(normalizedFailedPaths)
                normalizedApprovedPaths.isNotEmpty() ->
                    normalizedFailedPaths.isNotEmpty() &&
                        normalizedApprovedPaths.containsAll(normalizedFailedPaths)
                else -> normalizedFailedPaths.isEmpty()
            }
            val acceptedConversationOnly = executionReason != null &&
                executionReason == approvedUnavailableFileReason?.lowercase() &&
                executionReason in conversationOnlyFileReasons &&
                approvedPathEvidenceMatches
            if (!acceptedConversationOnly) {
                error(
                    rollbackResponse.fileRestoreReason?.takeIf { it.isNotBlank() }
                        ?: "Workspace file restore did not complete",
                )
            }
        }

        failureStage = EditResendTimelineRewriteOutcome.FailureStage.RESOURCES
        val resourceResponse = restoreResources()
        resourceErrors = resourceResponse.results
            .filterNot { it.success }
            .mapNotNull { result -> result.error.takeIf { it.isNotBlank() } }
        if (!resourceResponse.success || resourceResponse.failedCount > 0) {
            error("Resource restore did not complete")
        }

        failureStage = EditResendTimelineRewriteOutcome.FailureStage.REFRESH
        if (!refreshAuthoritativeHistory()) {
            error("Authoritative conversation refresh failed")
        }

        failureStage = EditResendTimelineRewriteOutcome.FailureStage.SEND
        if (!sendEditedMessage()) error("Edited message was not persisted")
        EditResendTimelineRewriteOutcome.Success(
            rollbackState = resourceResponse.rollbackState ?: rollbackState,
        )
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        EditResendTimelineRewriteOutcome.Failure(
            error = error,
            stage = failureStage,
            rollbackApplied = rollbackApplied,
            rollbackState = rollbackState,
            failedFiles = failedFiles,
            fileRestoreReason = fileRestoreReason,
            resourceErrors = resourceErrors,
        )
    }
}

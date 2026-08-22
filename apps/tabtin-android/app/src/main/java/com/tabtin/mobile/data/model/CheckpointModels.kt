package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public data class CheckpointCapabilityScope(
    @SerialName("message_preview") val messagePreview: Boolean = false,
    @SerialName("file_diff") val fileDiff: Boolean = false,
    @SerialName("file_restore") val fileRestore: Boolean = false,
    @SerialName("resource_restore") val resourceRestore: Boolean = false,
    @SerialName("unrevert") val unrevert: Boolean = false,
)

@Serializable
public data class DiffFileSummaryItem(
    val file: String = "",
    val changes: Int = 0,
    val insertions: Int = 0,
    val deletions: Int = 0,
)

@Serializable
public data class CheckpointImpactFileSummary(
    val changed: Int = 0,
    val insertions: Int = 0,
    val deletions: Int = 0,
    val files: List<DiffFileSummaryItem>? = null,
)

@Serializable
public data class CheckpointImpactSummary(
    @SerialName("file_summary") val fileSummary: CheckpointImpactFileSummary? = null,
)

@Serializable
public data class CheckpointContextSummary(
    @SerialName("intent_summary") val intentSummary: String? = null,
    @SerialName("user_prompt") val userPrompt: String? = null,
)

@Serializable
public data class CheckpointRecord(
    @SerialName("checkpoint_id") val checkpointId: String = "",
    @SerialName("session_id") val sessionId: String = "",
    @SerialName("anchor_type") val anchorType: String = "assistant_turn",
    @SerialName("anchor_message_id") val anchorMessageId: String? = null,
    val status: String = "ready",
    @SerialName("capability_scope") val capabilityScope: CheckpointCapabilityScope? = null,
    @SerialName("degraded_reasons") val degradedReasons: List<String> = emptyList(),
    @SerialName("impact_summary") val impactSummary: CheckpointImpactSummary? = null,
    @SerialName("context_summary") val contextSummary: CheckpointContextSummary? = null,
) {
    val isRevertable: Boolean
        get() = status == "ready" || status == "degraded"
}

@Serializable
public data class CheckpointWorkspaceFilesPartialDetail(
    val success: Boolean = false,
    /** 新服务端区分部分恢复与完全失败；旧记录缺失时继续回退 success。 */
    val status: String? = null,
    val reason: String? = null,
)

@Serializable
public data class CheckpointRetryableResource(
    @SerialName("resource_type") val resourceType: String = "",
    @SerialName("resource_id") val resourceId: String = "",
    val action: String? = null,
    @SerialName("restore_to_version_id") val restoreToVersionId: String? = null,
)

@Serializable
public data class CheckpointResourcesPartialDetail(
    @SerialName("restored_count") val restoredCount: Int = 0,
    @SerialName("failed_count") val failedCount: Int = 0,
    val retryable: List<CheckpointRetryableResource> = emptyList(),
)

@Serializable
public data class CheckpointPartialSuccessDetails(
    @SerialName("workspace_files") val workspaceFiles: CheckpointWorkspaceFilesPartialDetail? = null,
    val resources: CheckpointResourcesPartialDetail? = null,
)

@Serializable
public data class SessionRollbackState(
    @SerialName("session_id") val sessionId: String = "",
    @SerialName("revert_active") val revertActive: Boolean = false,
    @SerialName("target_message_id") val targetMessageId: String? = null,
    @SerialName("cleanup_status") val cleanupStatus: String = "not_started",
    @SerialName("can_unrevert") val canUnrevert: Boolean = false,
    @SerialName("last_apply_result") val lastApplyResult: String? = null,
    @SerialName("partial_success_details") val partialSuccessDetails: CheckpointPartialSuccessDetails? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("last_rollback_reason") val lastRollbackReason: String? = null,
    @SerialName("last_operation_mode") val lastOperationMode: String = "rollback",
)

@Serializable
public data class RollbackMessagePreview(
    val id: String = "",
    val role: String = "",
    @SerialName("content_preview") val contentPreview: String = "",
    @SerialName("agent_run_id") val agentRunId: String = "",
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
public data class ResourceChangeInfo(
    @SerialName("resource_type") val resourceType: String = "",
    @SerialName("resource_id") val resourceId: String = "",
    @SerialName("resource_name") val resourceName: String = "",
    @SerialName("change_type") val changeType: String = "",
    val summary: String = "",
    @SerialName("agent_run_id") val agentRunId: String = "",
)

@Serializable
public data class ResourceRestorePlanItem(
    @SerialName("resource_type") val resourceType: String = "",
    @SerialName("resource_id") val resourceId: String = "",
    @SerialName("resource_name") val resourceName: String = "",
    val action: String = "skip",
    @SerialName("action_label") val actionLabel: String = "",
    @SerialName("can_restore") val canRestore: Boolean = false,
    @SerialName("restore_to_version_id") val restoreToVersionId: String? = null,
    @SerialName("restore_to_version_time") val restoreToVersionTime: String? = null,
    @SerialName("change_count") val changeCount: Int = 0,
)

@Serializable
public data class RollbackImpactFiles(
    val available: Boolean = false,
    @SerialName("diff_available") val diffAvailable: Boolean = false,
)

@Serializable
public data class RollbackImpactResources(
    val available: Boolean = false,
    @SerialName("change_count") val changeCount: Int = 0,
    @SerialName("restore_count") val restoreCount: Int = 0,
)

@Serializable
public data class RollbackImpactMessages(
    @SerialName("to_remove") val toRemove: Int = 0,
)

@Serializable
public data class RollbackImpact(
    val files: RollbackImpactFiles? = null,
    val resources: RollbackImpactResources? = null,
    val messages: RollbackImpactMessages? = null,
)

@Serializable
public data class FilePreviewIssue(
    val path: String = "",
    val reason: String = "unrestorable",
)

@Serializable
public data class RollbackPreviewResponse(
    @SerialName("target_message_id") val targetMessageId: String = "",
    @SerialName("preview_revision") val previewRevision: String? = null,
    @SerialName("rollback_contract_version") val rollbackContractVersion: Int = 1,
    @SerialName("messages_to_remove") val messagesToRemove: Int = 0,
    @SerialName("messages_preview") val messagesPreview: List<RollbackMessagePreview> = emptyList(),
    @SerialName("target_timestamp") val targetTimestamp: String? = null,
    @SerialName("checkpoint_hash") val checkpointHash: String? = null,
    @SerialName("resource_changes") val resourceChanges: List<ResourceChangeInfo> = emptyList(),
    @SerialName("unrestorable_items") val unrestorableItems: List<String> = emptyList(),
    @SerialName("resource_restore_plan") val resourceRestorePlan: List<ResourceRestorePlanItem> = emptyList(),
    @SerialName("resource_preview_status") val resourcePreviewStatus: String? = null,
    @SerialName("resource_preview_reason") val resourcePreviewReason: String? = null,
    @SerialName("effective_checkpoint") val effectiveCheckpoint: CheckpointRecord? = null,
    @SerialName("degraded_reasons") val degradedReasons: List<String> = emptyList(),
    @SerialName("no_impact") val noImpact: Boolean = false,
    val impact: RollbackImpact? = null,
    /** Electron 控制设备返回的本地文件影响；旧后端缺失时保持为空。 */
    @SerialName("affected_paths") val affectedPaths: List<String> = emptyList(),
    @SerialName("rewind_anchor_id") val rewindAnchorId: String? = null,
    @SerialName("file_restore_host") val fileRestoreHost: String? = null,
    @SerialName("file_preview_success") val filePreviewSuccess: Boolean? = null,
    @SerialName("file_preview_status") val filePreviewStatus: String? = null,
    @SerialName("file_preview_reason") val filePreviewReason: String? = null,
    @SerialName("unrestorable_files") val unrestorableFiles: List<FilePreviewIssue> = emptyList(),
    @SerialName("file_preview_revision") val filePreviewRevision: String? = null,
) {
    /** 新状态优先；兼容旧服务端已有的 success / impact 字段。 */
    val effectiveFilePreviewStatus: String
        get() = filePreviewStatus?.lowercase() ?: when {
            filePreviewSuccess == false -> "unavailable"
            affectedPaths.isNotEmpty() || impact?.files?.available == true -> "available"
            else -> "unknown"
        }
}

@Serializable
public data class RollbackPreviewRequest(
    @SerialName("target_message_id") val targetMessageId: String,
)

@Serializable
public data class RollbackApplyResult(
    @SerialName("messages_truncated") val messagesTruncated: Int = 0,
    @SerialName("files_restored") val filesRestored: Int = 0,
    @SerialName("resources_restored") val resourcesRestored: Int = 0,
)

@Serializable
public data class RollbackRequest(
    @SerialName("target_message_id") val targetMessageId: String,
    @SerialName("safety_snapshot_hash") val safetySnapshotHash: String? = null,
    @SerialName("rollback_reason") val rollbackReason: String = "",
    /** 可选新增字段；旧服务端会忽略，普通独立回退不发送。 */
    val mode: String? = null,
    @SerialName("preview_revision") val previewRevision: String? = null,
    @SerialName("file_preview_revision") val filePreviewRevision: String? = null,
    @SerialName("acknowledged_file_preview_reason")
    val acknowledgedFilePreviewReason: String? = null,
    @SerialName("rollback_contract_version") val rollbackContractVersion: Int? = null,
)

@Serializable
public data class RollbackResponse(
    val success: Boolean = false,
    @SerialName("checkpoint_hash") val checkpointHash: String? = null,
    @SerialName("truncated_message_count") val truncatedMessageCount: Int = 0,
    // 旧服务端可能不返回此字段。缺失不能被客户端误判为“文件恢复失败”。
    @SerialName("file_restore_success") val fileRestoreSuccess: Boolean = true,
    @SerialName("file_restore_status") val fileRestoreStatus: String? = null,
    @SerialName("file_restore_reason") val fileRestoreReason: String? = null,
    @SerialName("failed_files") val failedFiles: List<String> = emptyList(),
    val mode: String = "rollback",
    @SerialName("overall_status") val overallStatus: String = "success",
    @SerialName("rollback_state") val rollbackState: SessionRollbackState? = null,
    @SerialName("apply_result") val applyResult: RollbackApplyResult? = null,
    val message: String? = null,
) {
    /** 新状态优先；旧响应才回退到 legacy bool。 */
    val hasFileRestoreFailure: Boolean
        get() = when (fileRestoreStatus?.lowercase()) {
            "success", "not_applicable", "skipped" -> false
            "unavailable", "partial", "failed" -> true
            else -> !fileRestoreSuccess
        }
}

@Serializable
public data class UnrevertResponse(
    val success: Boolean = false,
    @SerialName("snapshot_hash") val snapshotHash: String? = null,
    @SerialName("file_restore_success") val fileRestoreSuccess: Boolean = true,
    @SerialName("overall_status") val overallStatus: String = "success",
    @SerialName("rollback_state") val rollbackState: SessionRollbackState? = null,
    val message: String? = null,
)

@Serializable
public data class ResourceRestoreItem(
    @SerialName("resource_type") val resourceType: String,
    @SerialName("resource_id") val resourceId: String,
    val action: String,
    @SerialName("restore_to_version_id") val restoreToVersionId: String? = null,
)

@Serializable
public data class ResourceRestoreRequest(
    val items: List<ResourceRestoreItem>,
    @SerialName("preview_revision") val previewRevision: String? = null,
    @SerialName("rollback_contract_version") val rollbackContractVersion: Int = 1,
)

@Serializable
public data class ResourceRestoreResult(
    @SerialName("resource_type") val resourceType: String = "",
    @SerialName("resource_id") val resourceId: String = "",
    val success: Boolean = false,
    val error: String = "",
)

@Serializable
public data class ResourceRestoreResponse(
    val success: Boolean = false,
    val results: List<ResourceRestoreResult> = emptyList(),
    @SerialName("restored_count") val restoredCount: Int = 0,
    @SerialName("failed_count") val failedCount: Int = 0,
    @SerialName("overall_status") val overallStatus: String = "success",
    @SerialName("rollback_state") val rollbackState: SessionRollbackState? = null,
    @SerialName("apply_result") val applyResult: RollbackApplyResult? = null,
)

@Serializable
public data class AgentRunRollbackResultItem(
    @SerialName("resource_type") val resourceType: String = "",
    @SerialName("resource_id") val resourceId: String = "",
    @SerialName("resource_name") val resourceName: String = "",
    val status: String = "skipped",
    val reason: String? = null,
    val detail: String? = null,
    @SerialName("restored_to") val restoredTo: String? = null,
    @SerialName("new_version") val newVersion: String? = null,
)

@Serializable
public data class AgentRunRollbackResponse(
    @SerialName("agent_run_id") val agentRunId: String = "",
    @SerialName("rollback_results") val rollbackResults: List<AgentRunRollbackResultItem> = emptyList(),
    @SerialName("all_skipped") val allSkipped: Boolean = false,
    @SerialName("collab_sync_warnings") val collabSyncWarnings: List<CollabSyncWarning> = emptyList(),
    @SerialName("cascaded_run_count") val cascadedRunCount: Int = 0,
)

@Serializable
public data class CollabSyncWarning(
    val resource: String = "",
    val warning: String = "",
)

@Serializable
public data class RevertHistoryResourceResult(
    @SerialName("resource_type") val resourceType: String = "",
    @SerialName("resource_id") val resourceId: String = "",
    val success: Boolean = false,
)

@Serializable
public data class RevertHistoryEntry(
    val type: String = "rollback",
    @SerialName("apply_id") val applyId: String? = null,
    @SerialName("target_message_id") val targetMessageId: String? = null,
    @SerialName("snapshot_hash") val snapshotHash: String? = null,
    @SerialName("messages_removed") val messagesRemoved: Int? = null,
    @SerialName("restored_count") val restoredCount: Int? = null,
    @SerialName("failed_count") val failedCount: Int? = null,
    @SerialName("resource_count") val resourceCount: Int? = null,
    val resources: List<RevertHistoryResourceResult> = emptyList(),
    @SerialName("apply_result") val applyResult: String? = null,
    @SerialName("partial_success_details") val partialSuccessDetails: CheckpointPartialSuccessDetails? = null,
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
public data class RevertHistoryResponse(
    val history: List<RevertHistoryEntry> = emptyList(),
)

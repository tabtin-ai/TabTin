package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ChatCheckpointApi
import com.tabtin.mobile.data.model.ActionLabel
import com.tabtin.mobile.data.model.AgentRunRollbackResponse
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.ResourceRestoreItem
import com.tabtin.mobile.data.model.ResourceRestoreRequest
import com.tabtin.mobile.data.model.ResourceRestoreResponse
import com.tabtin.mobile.data.model.RevertHistoryEntry
import com.tabtin.mobile.data.model.RollbackPreviewRequest
import com.tabtin.mobile.data.model.RollbackPreviewResponse
import com.tabtin.mobile.data.model.RollbackRequest
import com.tabtin.mobile.data.model.RollbackResponse
import com.tabtin.mobile.data.model.SessionRollbackState
import com.tabtin.mobile.data.model.UnrevertResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class ChatCheckpointRepository @Inject constructor(
    private val chatCheckpointApi: ChatCheckpointApi,
) {
    public suspend fun getSessionRollbackState(sessionId: String): SessionRollbackState? {
        return try {
            chatCheckpointApi.getSessionDetail(sessionId).unwrap().rollbackState
        } catch (_: Exception) {
            null
        }
    }

    public suspend fun rollbackPreview(sessionId: String, targetMessageId: String): RollbackPreviewResponse {
        return try {
            chatCheckpointApi.rollbackPreview(
                sessionId,
                RollbackPreviewRequest(targetMessageId),
            ).unwrap()
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.ROLLBACK_PREVIEW, e.serverMessage)
        }
    }

    public suspend fun rollback(
        sessionId: String,
        targetMessageId: String,
        safetySnapshotHash: String? = null,
        rollbackReason: String = "",
        mode: String? = null,
        previewRevision: String? = null,
        filePreviewRevision: String? = null,
        acknowledgedFilePreviewReason: String? = null,
        rollbackContractVersion: Int? = null,
    ): RollbackResponse {
        return try {
            chatCheckpointApi.rollback(
                sessionId,
                RollbackRequest(
                    targetMessageId = targetMessageId,
                    safetySnapshotHash = safetySnapshotHash,
                    rollbackReason = rollbackReason,
                    mode = mode,
                    previewRevision = previewRevision,
                    filePreviewRevision = filePreviewRevision,
                    acknowledgedFilePreviewReason = acknowledgedFilePreviewReason,
                    rollbackContractVersion = rollbackContractVersion,
                ),
            ).unwrap()
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.ROLLBACK, e.serverMessage)
        }
    }

    public suspend fun unrevert(sessionId: String): UnrevertResponse {
        return try {
            chatCheckpointApi.unrevert(sessionId).unwrap()
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.UNREVERT, e.serverMessage)
        }
    }

    public suspend fun restoreResources(
        sessionId: String,
        items: List<ResourceRestoreItem>,
        previewRevision: String? = null,
        rollbackContractVersion: Int = 1,
    ): ResourceRestoreResponse {
        return try {
            chatCheckpointApi.restoreResources(
                sessionId,
                ResourceRestoreRequest(
                    items = items,
                    previewRevision = previewRevision,
                    rollbackContractVersion = rollbackContractVersion,
                ),
            ).unwrap()
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.RESTORE_RESOURCES, e.serverMessage)
        }
    }

    public suspend fun getRevertHistory(sessionId: String): List<RevertHistoryEntry> {
        return try {
            chatCheckpointApi.getRevertHistory(sessionId).unwrap().history
        } catch (_: Exception) {
            emptyList()
        }
    }

    public suspend fun rollbackAgentRun(agentRunId: String): AgentRunRollbackResponse {
        return chatCheckpointApi.rollbackAgentRun(agentRunId).unwrap()
    }
}

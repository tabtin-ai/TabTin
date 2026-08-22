package com.tabtin.mobile.features.conversation.checkpoint

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.ResourceRestoreItem
import com.tabtin.mobile.data.model.RevertHistoryEntry
import com.tabtin.mobile.data.model.RollbackPreviewResponse
import android.util.Log
import com.tabtin.mobile.data.model.SessionRollbackState
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.repository.ChatCheckpointRepository
import com.tabtin.mobile.data.websocket.WebSocketService
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import javax.inject.Inject

internal sealed interface ChatCheckpointEvent {
    public data class RollbackSuccess(val truncatedCount: Int) : ChatCheckpointEvent
    public data class RollbackPartialSuccess(val truncatedCount: Int, val warningMessage: String) : ChatCheckpointEvent
    public data object UnrevertSuccess : ChatCheckpointEvent
    public data class UnrevertPartialSuccess(val warningMessage: String) : ChatCheckpointEvent
    public data class AgentRunRollbackSuccess(val cascadedRunCount: Int) : ChatCheckpointEvent
    public data class AgentRunRollbackNoChanges(val message: String) : ChatCheckpointEvent
    public data class Error(val message: String) : ChatCheckpointEvent
}

internal enum class CheckpointHealth { HEALTHY, WARNING, ERROR }

public data class ChatCheckpointUiState(
    val isLoadingPreview: Boolean = false,
    val isExecuting: Boolean = false,
    val isRetrying: Boolean = false,
    val isLoadingHistory: Boolean = false,
    val isRollingBackAgentRun: Boolean = false,
    val restoringPhase: String? = null,
    val preview: RollbackPreviewResponse? = null,
    val rollbackState: SessionRollbackState? = null,
    val targetMessageId: String? = null,
    val errorMessage: String? = null,
    val revertHistory: List<RevertHistoryEntry> = emptyList(),
    val historyLoadFailed: Boolean = false,
    val lastFileRestoreStatus: String? = null,
    val lastFileRestoreReason: String? = null,
    val lastFailedFiles: List<String> = emptyList(),
)

@HiltViewModel
public class ChatCheckpointViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val repository: ChatCheckpointRepository,
    private val webSocketService: WebSocketService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ChatCheckpointUiState())
    public val uiState: StateFlow<ChatCheckpointUiState> = _uiState.asStateFlow()

    private val _events = MutableSharedFlow<ChatCheckpointEvent>(extraBufferCapacity = 1)
    internal val events: SharedFlow<ChatCheckpointEvent> = _events.asSharedFlow()

    private var previewJob: Job? = null

    private val _checkpointFailCountBySessionId = mutableMapOf<String, Int>()
    private val _checkpointHealthBySessionId = MutableStateFlow<Map<String, CheckpointHealth>>(emptyMap())
    internal val checkpointHealthBySessionId: StateFlow<Map<String, CheckpointHealth>> = _checkpointHealthBySessionId.asStateFlow()

    /** 与 iOS [ChatCheckpointService] 对齐：`agent.session.{sessionId}` 上 decision_summary_* 仅日志。 */
    private var boundSessionIdForWs: String? = null

    public fun updateRollbackState(state: SessionRollbackState?) {
        _uiState.value = _uiState.value.copy(rollbackState = state)
    }

    public fun loadSessionRollbackState(sessionId: String) {
        bindSessionDecisionSummaryStream(sessionId)
        _uiState.value = _uiState.value.copy(
            lastFileRestoreStatus = null,
            lastFileRestoreReason = null,
            lastFailedFiles = emptyList(),
        )
        viewModelScope.launch {
            val state = repository.getSessionRollbackState(sessionId)
            _uiState.value = _uiState.value.copy(rollbackState = state)
        }
    }

    private fun bindSessionDecisionSummaryStream(sessionId: String) {
        if (sessionId.isBlank()) return
        if (boundSessionIdForWs == sessionId) return
        unbindSessionDecisionSummaryStream()
        boundSessionIdForWs = sessionId
        val topic = "${SESSION_TOPIC_PREFIX}$sessionId"
        webSocketService.subscribe(listOf(topic))
        webSocketService.onEnvelope(SESSION_HANDLER_KEY, ::handleSessionEnvelope)
        Log.i(TAG, "已订阅 session topic: ${sessionId.take(8)}…")
    }

    private fun unbindSessionDecisionSummaryStream() {
        boundSessionIdForWs?.let { sid ->
            webSocketService.unsubscribe(listOf("${SESSION_TOPIC_PREFIX}$sid"))
        }
        boundSessionIdForWs = null
        webSocketService.removeHandler(SESSION_HANDLER_KEY)
    }

    private fun handleSessionEnvelope(envelope: WSEnvelope) {
        val type = envelope.type
        if (!type.startsWith(SESSION_TOPIC_PREFIX)) return
        val short = type.removePrefix(SESSION_TOPIC_PREFIX)
        if (!short.startsWith(DECISION_SUMMARY_PREFIX)) return
        val checkpointId = envelope.payloadString("checkpoint_id") ?: ""
        val sessionId = envelope.payloadString("session_id") ?: ""
        val status = short.removePrefix(DECISION_SUMMARY_PREFIX)
        Log.i(
            TAG,
            "decision_summary 事件: status=$status checkpoint=${checkpointId.take(8)}… session=${sessionId.take(8)}…",
        )
    }

    public fun loadPreview(sessionId: String, messageId: String) {
        previewJob?.cancel()
        _uiState.value = _uiState.value.copy(
            isLoadingPreview = true,
            preview = null,
            targetMessageId = messageId,
            errorMessage = null,
        )
        previewJob = viewModelScope.launch {
            try {
                val preview = withTimeout(PREVIEW_TIMEOUT_MS) {
                    repository.rollbackPreview(sessionId, messageId)
                }
                _uiState.value = _uiState.value.copy(
                    isLoadingPreview = false,
                    preview = preview,
                )
            } catch (e: TimeoutCancellationException) {
                val msg = context.getString(R.string.checkpoint_preview_timeout)
                _uiState.value = _uiState.value.copy(
                    isLoadingPreview = false,
                    errorMessage = msg,
                )
            } catch (e: Exception) {
                val msg = errorMessage(e)
                _uiState.value = _uiState.value.copy(
                    isLoadingPreview = false,
                    errorMessage = msg,
                )
                _events.tryEmit(ChatCheckpointEvent.Error(msg))
            }
        }
    }

    public fun executeRollback(
        sessionId: String,
        targetMessageId: String,
        excludedResources: Set<String> = emptySet(),
        rollbackReason: String = "",
    ) {
        if (_uiState.value.isExecuting) return
        _uiState.value = _uiState.value.copy(
            isExecuting = true,
            restoringPhase = "preparing",
            errorMessage = null,
        )
        viewModelScope.launch {
            try {
                _uiState.value = _uiState.value.copy(restoringPhase = "files")
                // Android 无本地 Shadow Git，无法创建安全快照；传 null 由后端 Daemon 管理
                val response = repository.rollback(
                    sessionId,
                    targetMessageId,
                    safetySnapshotHash = null,
                    rollbackReason = rollbackReason,
                )

                val plan = _uiState.value.preview?.resourceRestorePlan ?: emptyList()
                val itemsToRestore = plan
                    .filter { it.canRestore && !excludedResources.contains("${it.resourceType}:${it.resourceId}") }
                    .map { ResourceRestoreItem(it.resourceType, it.resourceId, it.action, it.restoreToVersionId) }

                if (itemsToRestore.isNotEmpty()) {
                    _uiState.value = _uiState.value.copy(restoringPhase = "resources")
                    val restoreResponse = repository.restoreResources(sessionId, itemsToRestore)
                    _uiState.value = _uiState.value.copy(
                        restoringPhase = "finalizing",
                        rollbackState = restoreResponse.rollbackState ?: response.rollbackState,
                    )
                } else {
                    _uiState.value = _uiState.value.copy(
                        restoringPhase = "finalizing",
                        rollbackState = response.rollbackState,
                    )
                }

                _uiState.value = _uiState.value.copy(
                    isExecuting = false,
                    restoringPhase = null,
                    preview = null,
                    targetMessageId = null,
                    lastFileRestoreStatus = response.fileRestoreStatus,
                    lastFileRestoreReason = response.fileRestoreReason,
                    lastFailedFiles = response.failedFiles,
                )
                if (response.hasFileRestoreFailure) {
                    _events.tryEmit(
                        ChatCheckpointEvent.RollbackPartialSuccess(
                            truncatedCount = response.truncatedMessageCount,
                            warningMessage = context.getString(R.string.checkpoint_rollback_file_restore_failed),
                        ),
                    )
                } else {
                    _events.tryEmit(ChatCheckpointEvent.RollbackSuccess(response.truncatedMessageCount))
                }
            } catch (e: Exception) {
                val msg = errorMessage(e)
                _uiState.value = _uiState.value.copy(
                    isExecuting = false,
                    restoringPhase = null,
                    errorMessage = msg,
                )
                _events.tryEmit(ChatCheckpointEvent.Error(msg))
            }
        }
    }

    public fun executeUnrevert(sessionId: String) {
        if (_uiState.value.isExecuting) return
        _uiState.value = _uiState.value.copy(isExecuting = true, errorMessage = null)
        viewModelScope.launch {
            try {
                val response = repository.unrevert(sessionId)
                _uiState.value = _uiState.value.copy(
                    isExecuting = false,
                    rollbackState = response.rollbackState,
                )
                if (response.fileRestoreSuccess == false) {
                    _events.tryEmit(
                        ChatCheckpointEvent.UnrevertPartialSuccess(
                            warningMessage = context.getString(R.string.checkpoint_unrevert_file_restore_failed),
                        ),
                    )
                } else {
                    _events.tryEmit(ChatCheckpointEvent.UnrevertSuccess)
                }
            } catch (e: Exception) {
                val msg = errorMessage(e)
                _uiState.value = _uiState.value.copy(isExecuting = false, errorMessage = msg)
                _events.tryEmit(ChatCheckpointEvent.Error(msg))
            }
        }
    }

    public fun restoreResources(sessionId: String, items: List<ResourceRestoreItem>) {
        if (_uiState.value.isExecuting) return
        _uiState.value = _uiState.value.copy(isExecuting = true, errorMessage = null)
        viewModelScope.launch {
            try {
                val response = repository.restoreResources(sessionId, items)
                _uiState.value = _uiState.value.copy(
                    isExecuting = false,
                    rollbackState = response.rollbackState,
                )
            } catch (e: Exception) {
                val msg = errorMessage(e)
                _uiState.value = _uiState.value.copy(isExecuting = false, errorMessage = msg)
                _events.tryEmit(ChatCheckpointEvent.Error(msg))
            }
        }
    }

    public fun retryFailedResources(sessionId: String) {
        val retryable = _uiState.value.rollbackState?.partialSuccessDetails?.resources?.retryable
        if (retryable.isNullOrEmpty() || _uiState.value.isRetrying) return
        _uiState.value = _uiState.value.copy(isRetrying = true, errorMessage = null)
        viewModelScope.launch {
            try {
                val items = retryable.map {
                    ResourceRestoreItem(it.resourceType, it.resourceId, it.action ?: "restore_version", it.restoreToVersionId)
                }
                val response = repository.restoreResources(sessionId, items)
                _uiState.value = _uiState.value.copy(
                    isRetrying = false,
                    rollbackState = response.rollbackState ?: _uiState.value.rollbackState,
                )
            } catch (e: Exception) {
                val msg = errorMessage(e)
                _uiState.value = _uiState.value.copy(isRetrying = false, errorMessage = msg)
                _events.tryEmit(ChatCheckpointEvent.Error(msg))
            }
        }
    }

    public fun dismissPreview() {
        previewJob?.cancel()
        previewJob = null
        _uiState.value = _uiState.value.copy(
            isLoadingPreview = false,
            preview = null,
            targetMessageId = null,
            errorMessage = null,
        )
    }

    public fun dismissError() {
        _uiState.value = _uiState.value.copy(errorMessage = null)
    }

    public fun loadRevertHistory(sessionId: String) {
        _uiState.value = _uiState.value.copy(isLoadingHistory = true, historyLoadFailed = false)
        viewModelScope.launch {
            try {
                val history = repository.getRevertHistory(sessionId)
                _uiState.value = _uiState.value.copy(
                    isLoadingHistory = false,
                    revertHistory = history,
                )
            } catch (_: Exception) {
                _uiState.value = _uiState.value.copy(
                    isLoadingHistory = false,
                    historyLoadFailed = true,
                )
            }
        }
    }

    public fun rollbackAgentRun(agentRunId: String) {
        if (_uiState.value.isRollingBackAgentRun) return
        _uiState.value = _uiState.value.copy(isRollingBackAgentRun = true, errorMessage = null)
        viewModelScope.launch {
            try {
                val result = repository.rollbackAgentRun(agentRunId)

                if (result.allSkipped) {
                    _uiState.value = _uiState.value.copy(isRollingBackAgentRun = false)
                    _events.tryEmit(
                        ChatCheckpointEvent.AgentRunRollbackNoChanges(
                            context.getString(R.string.checkpoint_agent_run_no_changes),
                        ),
                    )
                    return@launch
                }

                _uiState.value = _uiState.value.copy(isRollingBackAgentRun = false)
                _events.tryEmit(
                    ChatCheckpointEvent.AgentRunRollbackSuccess(result.cascadedRunCount),
                )
            } catch (e: Exception) {
                val msg = errorMessage(e)
                _uiState.value = _uiState.value.copy(isRollingBackAgentRun = false, errorMessage = msg)
                _events.tryEmit(ChatCheckpointEvent.Error(msg))
            }
        }
    }

    public fun reportCheckpointFailure(sessionId: String) {
        val failCount = (_checkpointFailCountBySessionId[sessionId] ?: 0) + 1
        _checkpointFailCountBySessionId[sessionId] = failCount
        val health = when {
            failCount >= CHECKPOINT_ERROR_THRESHOLD -> CheckpointHealth.ERROR
            failCount >= CHECKPOINT_WARNING_THRESHOLD -> CheckpointHealth.WARNING
            else -> CheckpointHealth.HEALTHY
        }
        _checkpointHealthBySessionId.value = _checkpointHealthBySessionId.value + (sessionId to health)
    }

    public fun reportCheckpointSuccess(sessionId: String) {
        val prev = _checkpointFailCountBySessionId[sessionId] ?: 0
        if (prev == 0) return
        _checkpointFailCountBySessionId.remove(sessionId)
        _checkpointHealthBySessionId.value = _checkpointHealthBySessionId.value - sessionId
    }

    internal fun getCheckpointHealth(sessionId: String): CheckpointHealth {
        return _checkpointHealthBySessionId.value[sessionId] ?: CheckpointHealth.HEALTHY
    }

    private fun errorMessage(e: Throwable): String =
        if (e is AppError) e.toUserMessage(context) else (e.localizedMessage ?: e.message ?: "")

    override fun onCleared() {
        unbindSessionDecisionSummaryStream()
        super.onCleared()
    }

    public companion object {
        private const val TAG = "ChatCheckpointVM"
        private const val SESSION_HANDLER_KEY = "checkpoint-session-events"
        private const val SESSION_TOPIC_PREFIX = "agent.session."
        private const val DECISION_SUMMARY_PREFIX = "decision_summary_"
        private const val PREVIEW_TIMEOUT_MS = 15_000L
        private const val CHECKPOINT_WARNING_THRESHOLD = 2
        private const val CHECKPOINT_ERROR_THRESHOLD = 3
    }
}

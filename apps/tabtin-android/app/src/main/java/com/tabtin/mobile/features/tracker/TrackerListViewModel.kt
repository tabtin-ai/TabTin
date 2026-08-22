package com.tabtin.mobile.features.tracker

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.model.tracker.AttentionReason
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerAttentionItem
import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerRunStatus
import com.tabtin.mobile.data.model.tracker.TrackerStatus
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.TrackerRepository
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject

public data class TrackerListUiState(
    val trackers: List<Tracker> = emptyList(),
    val attentionItems: List<TrackerAttentionItem> = emptyList(),
    val runningTrackers: List<Pair<Tracker, TrackerRun>> = emptyList(),
    val latestRuns: Map<String, TrackerRun> = emptyMap(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    @StringRes val errorRes: Int? = null,
    val actionInProgress: String? = null,
    @StringRes val toastRes: Int? = null,
    val showCreateDialog: Boolean = false,
    val createName: String = "",
    val createDescription: String = "",
    val isCreating: Boolean = false,
    @StringRes val createErrorRes: Int? = null,
)

internal data class TrackerExecutionScope(
    val hostSpaceId: String,
    val workspaceId: String,
    val agentId: String?,
)

internal fun resolveTrackerExecutionScope(
    session: ChatSession?,
    fallbackSpaceId: String,
): TrackerExecutionScope {
    val projectId = session?.projectId?.takeIf { it.isNotBlank() }
    val sessionSpaceId = session?.spaceId?.takeIf { it.isNotBlank() }
    val hostSpaceId = projectId ?: sessionSpaceId ?: fallbackSpaceId
    val workspaceId = session?.workspaceId?.takeIf { it.isNotBlank() }
        ?: if (projectId == null) sessionSpaceId ?: fallbackSpaceId else ""
    return TrackerExecutionScope(
        hostSpaceId = hostSpaceId,
        workspaceId = workspaceId,
        agentId = session?.agentId?.takeIf { it.isNotBlank() },
    )
}

@HiltViewModel
public class TrackerListViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repository: TrackerRepository,
    private val chatRepository: ChatRepository,
    private val webSocketService: WebSocketService,
) : ViewModel() {

    private val fallbackSpaceId: String = savedStateHandle["spaceId"] ?: ""
    private val sessionId: String = savedStateHandle["sessionId"] ?: ""
    private var executionScope: TrackerExecutionScope? = null

    private val _uiState = MutableStateFlow(TrackerListUiState())
    public val uiState: StateFlow<TrackerListUiState> = _uiState.asStateFlow()

    private val wsHandlerKey = "tracker-list-${sessionId.ifBlank { fallbackSpaceId }}-${hashCode()}"
    private var trackerTopic: String? = null
    private var hasScreenResumed = false

    init {
        webSocketService.onEnvelope(wsHandlerKey) { env -> handleEnvelope(env) }
        loadTrackers(isInitial = true)
    }

    private suspend fun requireExecutionScope(): TrackerExecutionScope {
        executionScope?.let { return it }
        val session = sessionId.takeIf { it.isNotBlank() }?.let { chatRepository.getSession(it) }
        val resolved = resolveTrackerExecutionScope(session, fallbackSpaceId)
        check(resolved.hostSpaceId.isNotBlank()) { "Tracker host Space is missing" }
        check(resolved.workspaceId.isNotBlank()) { "Tracker execution Workspace is missing" }
        executionScope = resolved
        subscribeToWorkspace(resolved.workspaceId)
        return resolved
    }

    /** Tracker 生命周期 topic 使用执行 Workspace，而不是 Project 宿主。 */
    private fun subscribeToWorkspace(workspaceId: String) {
        val topic = "tracker.events.$workspaceId"
        if (trackerTopic == topic) return
        trackerTopic?.let { webSocketService.unsubscribeAfterDelay(listOf(it)) }
        trackerTopic = topic
        webSocketService.subscribe(listOf(topic))
    }

    private fun handleEnvelope(env: WSEnvelope) {
        val type = env.type
        if (!type.startsWith("tracker.")) return
        val sid = env.payloadString("space_id")
        val workspaceId = executionScope?.workspaceId ?: return
        if (sid != null && sid != workspaceId) return
        when {
            // 运行终态 + 生命周期：刷新列表（状态徽标 / 统计 / 需关注项）。progress/started 也走刷新，
            // 后端 notify_progress 为按 cycle 触发（非按 token），频率可接受。
            type.startsWith("tracker.event.") ||
                type == "tracker.run.started" ||
                type == "tracker.progress" ||
                type == "tracker.run.completed" ||
                type == "tracker.run.failed" ||
                type == "tracker.run.cancelled" ->
                loadTrackers(isInitial = false)
        }
    }

    override fun onCleared() {
        super.onCleared()
        webSocketService.removeHandler(wsHandlerKey)
        trackerTopic?.let { webSocketService.unsubscribeAfterDelay(listOf(it)) }
    }

    public fun loadTrackers(isInitial: Boolean = false) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        errorRes = ErrorClassifier.classify(e),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    isLoading = isInitial && it.trackers.isEmpty(),
                    isRefreshing = !isInitial || it.trackers.isNotEmpty(),
                    errorRes = null,
                )
            }

            val scope = requireExecutionScope()
            val trackers = repository.getEvents(scope.workspaceId).sortedByDescending { it.updatedAt }
            val latestRuns = mutableMapOf<String, TrackerRun>()

            trackers.filter { it.status == TrackerStatus.ACTIVE }.map { tracker ->
                async {
                    runCatching { repository.getRuns(tracker.id) }
                        .getOrNull()
                        ?.firstOrNull()
                        ?.let { run -> tracker.id to run }
                }
            }.awaitAll().filterNotNull().forEach { (trackerId, run) ->
                latestRuns[trackerId] = run
            }

            val attentionItems = buildAttentionItems(trackers, latestRuns)
            val runningTrackers = trackers.mapNotNull { tracker ->
                latestRuns[tracker.id]
                    ?.takeIf { it.status == TrackerRunStatus.RUNNING }
                    ?.let { tracker to it }
            }

            _uiState.update {
                it.copy(
                    trackers = trackers,
                    attentionItems = attentionItems,
                    runningTrackers = runningTrackers,
                    latestRuns = latestRuns,
                    isLoading = false,
                    isRefreshing = false,
                    errorRes = null,
                )
            }
        }
    }

    public fun refresh(): Unit = loadTrackers(isInitial = false)

    /** 返回列表或应用重新回到前台时，以 REST 校准详情页可能产生的状态变化。 */
    public fun onScreenResumed() {
        if (hasScreenResumed) {
            refresh()
        } else {
            hasScreenResumed = true
        }
    }

    public fun triggerTracker(trackerId: String): Unit = trackerAction(trackerId) {
        val run = repository.triggerEvent(trackerId)
        _uiState.update { it.copy(latestRuns = it.latestRuns + (trackerId to run)) }
    }

    public fun pauseTracker(trackerId: String): Unit = trackerAction(trackerId) {
        repository.pauseEvent(trackerId)
        updateTrackerStatus(trackerId, TrackerStatus.PAUSED)
    }

    public fun resumeTracker(trackerId: String): Unit = trackerAction(trackerId) {
        repository.resumeEvent(trackerId)
        updateTrackerStatus(trackerId, TrackerStatus.ACTIVE)
    }

    public fun activateTracker(trackerId: String): Unit = trackerAction(trackerId) {
        repository.activateEvent(trackerId)
        updateTrackerStatus(trackerId, TrackerStatus.ACTIVE)
    }

    public fun deleteTracker(trackerId: String): Unit = trackerAction(trackerId) {
        repository.deleteEvent(trackerId)
        _uiState.update { state ->
            val newTrackers = state.trackers.filter { it.id != trackerId }
            val newRuns = state.latestRuns - trackerId
            state.copy(
                trackers = newTrackers,
                latestRuns = newRuns,
                attentionItems = buildAttentionItems(newTrackers, newRuns),
                runningTrackers = newTrackers.mapNotNull { g ->
                    newRuns[g.id]?.takeIf { it.status == TrackerRunStatus.RUNNING }?.let { g to it }
                },
            )
        }
    }

    public fun consumeToast() {
        _uiState.update { it.copy(toastRes = null) }
    }

    public fun showCreateDialog() {
        _uiState.update {
            it.copy(
                showCreateDialog = true,
                createName = "",
                createDescription = "",
                createErrorRes = null,
            )
        }
    }

    public fun dismissCreateDialog() {
        if (_uiState.value.isCreating) return
        _uiState.update { it.copy(showCreateDialog = false, createErrorRes = null) }
    }

    public fun setCreateName(v: String) {
        _uiState.update { it.copy(createName = v, createErrorRes = null) }
    }

    public fun setCreateDescription(v: String) {
        _uiState.update { it.copy(createDescription = v, createErrorRes = null) }
    }

    public fun createTracker() {
        val name = _uiState.value.createName.trim()
        if (name.isEmpty()) return
        val desc = _uiState.value.createDescription.trim()

        viewModelScope.safeLaunch(
            onError = { e ->
                val errorRes = ErrorClassifier.classify(e).let { classified ->
                    if (classified == R.string.error_unknown) R.string.tracker_create_failed else classified
                }
                _uiState.update {
                    it.copy(isCreating = false, createErrorRes = errorRes)
                }
            },
        ) {
            _uiState.update { it.copy(isCreating = true, createErrorRes = null) }
            val scope = requireExecutionScope()
            val agentId = scope.agentId
            if (agentId == null) {
                _uiState.update {
                    it.copy(
                        isCreating = false,
                        createErrorRes = R.string.tracker_create_missing_agent,
                    )
                }
                return@safeLaunch
            }
            repository.createEvent(
                name = name,
                description = desc,
                hostSpaceId = scope.hostSpaceId,
                workspaceId = scope.workspaceId,
                agentId = agentId,
            )
            _uiState.update {
                it.copy(
                    isCreating = false,
                    showCreateDialog = false,
                    createErrorRes = null,
                    toastRes = R.string.tracker_create_success,
                )
            }
            loadTrackers(isInitial = false)
        }
    }

    private fun trackerAction(trackerId: String, action: suspend () -> Unit) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(
                        actionInProgress = null,
                        toastRes = ErrorClassifier.classify(e),
                    )
                }
            },
        ) {
            _uiState.update { it.copy(actionInProgress = trackerId) }
            action()
            _uiState.update { it.copy(actionInProgress = null) }
        }
    }

    private fun updateTrackerStatus(trackerId: String, status: TrackerStatus) {
        _uiState.update { state ->
            val newTrackers = state.trackers.map { if (it.id == trackerId) it.copy(status = status) else it }
            state.copy(
                trackers = newTrackers,
                attentionItems = buildAttentionItems(newTrackers, state.latestRuns),
                runningTrackers = newTrackers.mapNotNull { g ->
                    state.latestRuns[g.id]?.takeIf { it.status == TrackerRunStatus.RUNNING }?.let { g to it }
                },
            )
        }
    }

    private fun buildAttentionItems(trackers: List<Tracker>, runs: Map<String, TrackerRun>): List<TrackerAttentionItem> =
        trackers.mapNotNull { tracker ->
            runs[tracker.id]?.let { run ->
                when (run.status) {
                    TrackerRunStatus.WAITING_CHECKPOINT ->
                        TrackerAttentionItem(tracker, run, AttentionReason.CHECKPOINT)
                    TrackerRunStatus.FAILED, TrackerRunStatus.PARTIAL_FAILED ->
                        TrackerAttentionItem(tracker, run, AttentionReason.FAILED)
                    else -> null
                }
            }
        }.sortedByDescending { it.run.createdAt }
}

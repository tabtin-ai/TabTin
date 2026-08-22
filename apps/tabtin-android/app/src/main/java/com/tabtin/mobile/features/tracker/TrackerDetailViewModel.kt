package com.tabtin.mobile.features.tracker

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerRunExecutionPolicy
import com.tabtin.mobile.data.model.tracker.TrackerRunStatus
import com.tabtin.mobile.data.model.tracker.TrackerStatus
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.repository.TrackerRepository
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import retrofit2.HttpException
import javax.inject.Inject

internal data class TrackerDetailUiState(
    val tracker: Tracker? = null,
    val runs: List<TrackerRun> = emptyList(),
    val latestRun: TrackerRun? = null,
    val isLoadingRuns: Boolean = false,
    val actionInProgress: String? = null,
    @StringRes val toastRes: Int? = null,
    val isDeleted: Boolean = false,
)

@HiltViewModel
public class TrackerDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repository: TrackerRepository,
    private val webSocketService: WebSocketService,
) : ViewModel() {

    public val trackerId: String = checkNotNull(savedStateHandle["trackerId"])

    private val _uiState = MutableStateFlow(TrackerDetailUiState())
    internal val uiState: StateFlow<TrackerDetailUiState> = _uiState.asStateFlow()

    private val wsHandlerKey = "tracker-detail-$trackerId-${hashCode()}"
    private var subscribedTopic: String? = null

    init {
        webSocketService.onEnvelope(wsHandlerKey) { env -> handleEnvelope(env) }
        loadAll()
    }

    public fun loadAll() {
        viewModelScope.safeLaunch(
            onError = { e -> _uiState.update { it.copy(toastRes = ErrorClassifier.classify(e)) } },
        ) {
            val tracker = repository.getEvent(trackerId)
            _uiState.update { it.copy(tracker = tracker) }
            // tracker 解析出 spaceId 后订阅其 tracker.events topic（实时刷新运行进度 / 终态）。
            tracker.spaceId?.let { sid ->
                val topic = "tracker.events.$sid"
                if (subscribedTopic != topic) {
                    subscribedTopic = topic
                    webSocketService.subscribe(listOf(topic))
                }
            }
            loadRuns()
        }
    }

    private fun handleEnvelope(env: WSEnvelope) {
        val type = env.type
        if (!type.startsWith("tracker.")) return
        // 只认本 tracker 的事件。
        if (env.payloadString("tracker_id") != trackerId) return
        when {
            type == "tracker.progress" ||
                type == "tracker.run.started" ||
                type == "tracker.run.completed" ||
                type == "tracker.run.failed" ||
                type == "tracker.run.cancelled" ->
                loadRuns()
            type.startsWith("tracker.event.") ->
                loadAll()
        }
    }

    override fun onCleared() {
        super.onCleared()
        webSocketService.removeHandler(wsHandlerKey)
        subscribedTopic?.let { webSocketService.unsubscribeAfterDelay(listOf(it)) }
    }

    public fun loadRuns() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(isLoadingRuns = false, toastRes = ErrorClassifier.classify(e)) }
            },
        ) {
            _uiState.update { it.copy(isLoadingRuns = true) }
            val runs = repository.getRuns(trackerId)
            _uiState.update {
                it.copy(
                    runs = runs,
                    latestRun = runs.firstOrNull(),
                    isLoadingRuns = false,
                )
            }
        }
    }

    public fun triggerTracker(): Unit = trackerAction(onError = ::triggerErrorResource) {
        if (!TrackerRunExecutionPolicy.canTrigger(_uiState.value.latestRun)) {
            _uiState.update { it.copy(toastRes = R.string.tracker_trigger_blocked_active_run) }
            return@trackerAction
        }
        val run = try {
            repository.triggerEvent(trackerId)
        } catch (error: Exception) {
            if (isActiveRunConflict(error)) loadRuns()
            throw error
        }
        _uiState.update { it.copy(latestRun = run) }
        loadRuns()
    }

    public fun pauseTracker(): Unit = trackerAction {
        repository.pauseEvent(trackerId)
        updateTrackerStatus(TrackerStatus.PAUSED)
    }

    public fun resumeTracker(): Unit = trackerAction {
        repository.resumeEvent(trackerId)
        updateTrackerStatus(TrackerStatus.ACTIVE)
    }

    public fun activateTracker(): Unit = trackerAction {
        repository.activateEvent(trackerId)
        updateTrackerStatus(TrackerStatus.ACTIVE)
    }

    public fun cancelRun(runId: String): Unit = trackerAction {
        repository.cancelRun(trackerId, runId)
        loadRuns()
    }

    public fun deleteTracker(): Unit = trackerAction {
        repository.deleteEvent(trackerId)
        _uiState.update { it.copy(isDeleted = true) }
    }

    public fun consumeToast() {
        _uiState.update { it.copy(toastRes = null) }
    }

    private fun trackerAction(
        onError: (Exception) -> Int = { ErrorClassifier.classify(it) },
        action: suspend () -> Unit,
    ) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(actionInProgress = null, toastRes = onError(e)) }
            },
        ) {
            _uiState.update { it.copy(actionInProgress = trackerId) }
            action()
            _uiState.update { it.copy(actionInProgress = null) }
        }
    }

    private fun triggerErrorResource(error: Exception): Int =
        if (isActiveRunConflict(error)) R.string.tracker_trigger_blocked_active_run else ErrorClassifier.classify(error)

    private fun isActiveRunConflict(error: Exception): Boolean = when (error) {
        is AppError.RequestFailed -> error.serverMessage?.contains("最大并发运行数") == true
        is HttpException -> error.code() == 400 || error.code() == 409
        else -> false
    }

    private fun updateTrackerStatus(status: TrackerStatus) {
        _uiState.update { state ->
            state.copy(tracker = state.tracker?.copy(status = status))
        }
    }
}

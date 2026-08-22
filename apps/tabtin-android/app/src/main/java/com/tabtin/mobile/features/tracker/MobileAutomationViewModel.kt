package com.tabtin.mobile.features.tracker

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.repository.TrackerRepository
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject

internal data class MobileAutomationUiState(
    val trackers: List<Tracker> = emptyList(),
    val agents: List<Agent> = emptyList(),
    val workspaces: List<Space> = emptyList(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val isCreating: Boolean = false,
    val errorMessage: String? = null,
    val createdTrackerId: String? = null,
)

internal data class MobileAutomationCreateInput(
    val name: String,
    val instructions: String,
    val triggerType: String,
    val triggerConfig: JsonObject,
    val agentId: String,
    val workspaceId: String,
)

/**
 * 自动化首页的移动投影：用时间列表呈现 Tracker。
 *
 * 执行 Agent 与 Workspace 始终在创建前显式确认，避免模板暗中绑定一个用户看不到的桌面现场。
 */
@HiltViewModel
public class MobileAutomationViewModel @Inject constructor(
    private val trackerRepository: TrackerRepository,
    private val spaceRepository: SpaceRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(MobileAutomationUiState())
    internal val uiState: StateFlow<MobileAutomationUiState> = _uiState.asStateFlow()
    private var loadSequence = 0

    init {
        load()
    }

    public fun load(isRefresh: Boolean = false) {
        val sequence = ++loadSequence
        viewModelScope.safeLaunch(
            onError = { error ->
                if (sequence != loadSequence) return@safeLaunch
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        errorMessage = error.message ?: "自动化任务加载失败",
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    isLoading = !isRefresh && it.trackers.isEmpty(),
                    isRefreshing = isRefresh,
                    errorMessage = null,
                )
            }
            val trackers = trackerRepository.getEvents()
            val agents = spaceRepository.getAgents().filter { it.isActive }
            val workspaces = spaceRepository.getSpaces().filter { it.isExecutionSpace }
            if (sequence != loadSequence) return@safeLaunch
            _uiState.update {
                it.copy(
                    trackers = trackers,
                    agents = agents,
                    workspaces = workspaces,
                    isLoading = false,
                    isRefreshing = false,
                )
            }
        }
    }

    public fun refresh() {
        load(isRefresh = true)
    }

    internal fun create(input: MobileAutomationCreateInput) {
        val trimmedName = input.name.trim()
        val trimmedInstructions = input.instructions.trim()
        if (
            trimmedName.isEmpty() ||
            trimmedInstructions.isEmpty() ||
            input.agentId.isBlank() ||
            input.workspaceId.isBlank()
        ) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        isCreating = false,
                        errorMessage = error.message ?: "创建自动化任务失败，请稍后重试",
                    )
                }
            },
        ) {
            _uiState.update { it.copy(isCreating = true, errorMessage = null, createdTrackerId = null) }
            val finalValues = linkedMapOf(
                "name" to JsonPrimitive(trimmedName),
                "instructions" to JsonPrimitive(trimmedInstructions),
                "agent_id" to JsonPrimitive(input.agentId),
                "workspace_id" to JsonPrimitive(input.workspaceId),
                "trigger_type" to JsonPrimitive(input.triggerType),
                "activate_on_create" to JsonPrimitive(true),
            )
            val intentSnapshot = JsonObject(
                mapOf(
                    "created_via" to JsonPrimitive("ui"),
                    "final_values" to JsonObject(finalValues),
                ),
            )
            val created = trackerRepository.createMobileAutomation(
                name = trimmedName,
                instructions = trimmedInstructions,
                triggerType = input.triggerType,
                triggerConfig = input.triggerConfig,
                agentId = input.agentId,
                workspaceId = input.workspaceId,
                intentSnapshot = intentSnapshot,
            )
            val activated = trackerRepository.activateEvent(created.id)
            _uiState.update { state ->
                val nextTrackers = (state.trackers.filterNot { it.id == activated.id } + activated)
                state.copy(
                    trackers = nextTrackers,
                    isCreating = false,
                    createdTrackerId = activated.id,
                )
            }
        }
    }

    public fun consumeCreatedTrackerId() {
        _uiState.update { it.copy(createdTrackerId = null) }
    }
}

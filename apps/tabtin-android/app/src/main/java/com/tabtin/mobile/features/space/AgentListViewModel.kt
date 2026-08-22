package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.RuntimeDevice
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.UpdateWorkspaceRequest
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.data.websocket.WSConnectionState
import com.tabtin.mobile.features.conversation.DeviceStatusEventPolicy
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.TokenManager
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import javax.inject.Inject

internal sealed interface AgentToast {
    @get:StringRes public val messageRes: Int

    public data object Updated : AgentToast { override val messageRes: Int = R.string.agent_updated }
    public data object Deleted : AgentToast { override val messageRes: Int = R.string.agent_deleted }
    public data class Error(@StringRes override val messageRes: Int) : AgentToast
}

public data class AgentListUiState(
    val spaces: List<Space> = emptyList(),
    /** Space、Agent、Device 是三个独立对象；卡片按 ID 组合展示。 */
    val agentsById: Map<String, Agent> = emptyMap(),
    val devicesById: Map<String, RuntimeDevice> = emptyMap(),
    val isLoadingMetadata: Boolean = false,
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    @StringRes val errorRes: Int? = null,
    val isMutatingAgent: Boolean = false,
)

@HiltViewModel
public class AgentListViewModel @Inject constructor(
    private val tokenManager: TokenManager,
    private val ossUploadService: OSSUploadService,
    private val spaceRepository: SpaceRepository,
    private val organizationRepository: OrganizationRepository,
    private val webSocketService: WebSocketService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AgentListUiState())
    public val uiState: StateFlow<AgentListUiState> = _uiState.asStateFlow()

    private val _toastEvent = MutableSharedFlow<AgentToast>(extraBufferCapacity = 1)
    internal val toastEvent: SharedFlow<AgentToast> = _toastEvent.asSharedFlow()

    public val organizationId: String? get() = tokenManager.organizationId
    public val selectedOrganization: StateFlow<Organization?> = organizationRepository.selectedOrganization

    /** 请求序号：快速切组织时用来丢弃迟到的旧 org 请求，避免旧数据写进新 org。 */
    private var loadSeq = 0

    private companion object {
        const val DEVICE_STATUS_LISTENER_KEY = "agent.list.device.status"
    }

    init {
        loadAgents()
        viewModelScope.launch { ossUploadService.fetchUploadConfigIfNeeded() }
        observeOrganizationChanges()
        observeDeviceStatus()
    }

    /**
     * 订阅 `device.status`：设备上下线由服务端主动推，不靠端上轮询。
     * 事件走 `/ws/v1/gateway` 的 `user.{user_id}` 组，与 Electron 同一条通道。
     *
     * 同时观察连接状态——断线期间的事件是**丢掉的**，不补一次拉取，在线态会长期
     * 停在断线前那一刻（比没有指示器更骗人）。
     */
    private fun observeDeviceStatus() {
        webSocketService.onEnvelope(DEVICE_STATUS_LISTENER_KEY) { envelope ->
            val update = DeviceStatusEventPolicy.update(envelope) ?: return@onEnvelope
            _uiState.update { state ->
                DeviceStatusEventPolicy.apply(update, state.devicesById)
                    ?.let { state.copy(devicesById = it) }
                    ?: state
            }
        }
        viewModelScope.launch {
            var wasConnected = false
            webSocketService.connectionState.collect { connectionState ->
                val connected = connectionState == WSConnectionState.Connected
                if (connected && !wasConnected) refreshDevicesAfterReconnect()
                wasConnected = connected
            }
        }
    }

    /** 重连后补齐断线期间错过的状态变化。只重拉设备，不动 Space 列表。 */
    private fun refreshDevicesAfterReconnect() {
        val seq = loadSeq
        viewModelScope.launch {
            val devices = runCatching { spaceRepository.getDevices() }.getOrNull() ?: return@launch
            if (seq != loadSeq) return@launch
            _uiState.update { it.copy(devicesById = devices.associateBy { device -> device.id }) }
        }
    }

    override fun onCleared() {
        webSocketService.removeHandler(DEVICE_STATUS_LISTENER_KEY)
        super.onCleared()
    }

    private fun emitError(e: Exception) {
        _toastEvent.tryEmit(AgentToast.Error(ErrorClassifier.classify(e)))
    }

    private fun observeOrganizationChanges() {
        viewModelScope.launch {
            organizationRepository.selectedOrganization
                .filterNotNull()
                .map { it.id }
                .distinctUntilChanged()
                .collect {
                    loadSeq += 1
                    _uiState.value = AgentListUiState()
                    loadAgents()
                }
        }
    }

    public fun loadAgents() {
        val seq = ++loadSeq
        viewModelScope.safeLaunch(
            onError = { e ->
                if (seq != loadSeq) return@safeLaunch
                _uiState.update { it.copy(errorRes = ErrorClassifier.classify(e), isLoading = false, isRefreshing = false) }
            }
        ) {
            _uiState.update { it.copy(isLoading = it.spaces.isEmpty(), errorRes = null) }
            val spaces = spaceRepository.getSpaces().filter { it.isExecutionSpace }
            if (seq != loadSeq) return@safeLaunch
            _uiState.update {
                it.copy(
                    spaces = spaces,
                    isLoading = false,
                    isRefreshing = false,
                    isLoadingMetadata = true,
                )
            }
            loadSpaceMetadata(spaces, seq)
        }
    }

    private suspend fun loadSpaceMetadata(spaces: List<Space>, seq: Int) = coroutineScope {
        val agentIds = spaces.mapNotNull { it.primaryAgentId }.distinct()
        val agentsDeferred = async {
            agentIds.map { agentId ->
                async { runCatching { spaceRepository.getAgent(agentId) }.getOrNull() }
            }.awaitAll().filterNotNull().associateBy { it.id }
        }
        val devicesDeferred = async {
            runCatching { spaceRepository.getDevices() }
                .getOrDefault(emptyList())
                .associateBy { it.id }
        }
        val agents = agentsDeferred.await()
        val devices = devicesDeferred.await()
        if (seq != loadSeq) return@coroutineScope
        _uiState.update {
            it.copy(
                agentsById = agents,
                devicesById = devices,
                isLoadingMetadata = false,
            )
        }
    }

    public fun refresh() {
        _uiState.update { it.copy(isRefreshing = true) }
        loadAgents()
    }

    public fun updateAgent(spaceId: String, name: String?) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutatingAgent = true) }
            try {
                val space = _uiState.value.spaces.find { it.id == spaceId }
                if (space?.isWorkspaceRecord == true) {
                    spaceRepository.updateWorkspace(
                        spaceId,
                        UpdateWorkspaceRequest(name = name),
                    )
                } else {
                    spaceRepository.updateSpace(spaceId, name)
                }
                _toastEvent.tryEmit(AgentToast.Updated)
                loadAgents()
            } finally {
                _uiState.update { it.copy(isMutatingAgent = false) }
            }
        }
    }

    public fun deleteSpace(spaceId: String) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            val space = _uiState.value.spaces.find { it.id == spaceId }
            val agentId = space?.agentId
            if (space?.isWorkspaceRecord == true) {
                spaceRepository.deleteWorkspace(spaceId, space.controlDeviceId)
            } else if (agentId != null) {
                spaceRepository.deleteAgent(agentId)
            } else {
                spaceRepository.deleteSpace(spaceId)
            }
            _toastEvent.tryEmit(AgentToast.Deleted)
            loadAgents()
        }
    }

}

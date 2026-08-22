package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ConversationExecutionScope
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.DeviceRuntimeRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject

public data class ChatSessionUiState(
    val sessionTitle: String = "",
    val spaceName: String = "",
    val messageCount: Int = 0,
    /** 会话菜单的信息/归档动作只消费这份服务端权威快照。 */
    val session: ChatSession? = null,
    val isSavingTitle: Boolean = false,
    val isArchiving: Boolean = false,
    val sessionActionMessage: String? = null,
    /** “新建任务”复用当前会话实际的 Workspace / Agent，不从入口默认值猜测。 */
    val newTaskSpace: Space? = null,
    val newTaskAgent: Agent? = null,
    /** 既有会话从服务端读取的冻结执行范围。 */
    val executionScope: ConversationExecutionScope? = null,
    /** 历史会话的 Agent 是消息执行事实，不跟入口默认 Agent 漂移。 */
    val frozenAgentId: String? = null,
    val runtimeStatusReady: Boolean = false,
    /** 远程执行环境态；非 [RemoteExecutionState.READY] 时 Composer 硬门闩禁发。 */
    val remoteExecutionState: RemoteExecutionState = RemoteExecutionState.READY,
    @StringRes val errorRes: Int? = null,
)

/**
 * drawer-first 重构后的聊天页 ViewModel（取代原 AgentDetailViewModel 的单 session
 * 部分）。每实例锁定单个 (sessionId, spaceId)。
 *
 * 删除原 AgentDetailViewModel 的：sessions list / currentIndex / showHistory /
 * swipeLeft/Right/select/selectById/toggleHistory state——drawer 模式下 session
 * 切换由 drawer UI 处理，不在聊天页内部多 session 切换。
 *
 * 保留：syncOrganizationRuntime / forkSession（emit 新 sessionId 给 UI 触发 push） /
 * updateSessionInList（接 stream 的 onSessionUpdated 回调更新 title/count）。
 */
@HiltViewModel
public class ChatSessionViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val chatRepository: ChatRepository,
    private val tokenManager: TokenManager,
    private val deviceRuntimeRepository: DeviceRuntimeRepository,
    private val spaceRepository: SpaceRepository,
    private val webSocketService: WebSocketService,
) : ViewModel() {

    public val sessionId: String = savedStateHandle["sessionId"] ?: ""
    public val spaceId: String = savedStateHandle["spaceId"] ?: ""
    public val organizationId: String = savedStateHandle["organizationId"] ?: ""
    private val routeProjectId: String = savedStateHandle["projectId"] ?: ""
    /** 对齐 iOS ConversationTarget.startsNewSession；供草稿 UI 区分「强制新建」。 */
    public val startsNewSession: Boolean =
        savedStateHandle.get<Boolean>("startsNewSession") ?: false
    private val initialSpaceName: String = savedStateHandle["spaceName"] ?: ""
    /** 路由预选分身；草稿入口用，正式会话以服务端 session.agentId 为准。 */
    private val routeAgentId: String = savedStateHandle["agentId"] ?: ""
    private var executionScope = chatSessionEntryExecutionScope(
        organizationId = organizationId,
        workspaceId = spaceId,
        projectId = routeProjectId,
    )

    private val _uiState = MutableStateFlow(
        ChatSessionUiState(
            spaceName = initialSpaceName,
            executionScope = executionScope,
        ),
    )
    public val uiState: StateFlow<ChatSessionUiState> = _uiState.asStateFlow()

    private val _forkedSession = MutableSharedFlow<ChatSession>(extraBufferCapacity = 1)
    /** fork 成功后 emit 新 session 给 UI 触发 navigate(ChatSessionRoute(...)) */
    public val forkedSession: SharedFlow<ChatSession> = _forkedSession.asSharedFlow()
    private val _sessionArchived = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    /** 成功归档后由页面返回任务列表，避免继续停留在已归档会话。 */
    public val sessionArchived: SharedFlow<Unit> = _sessionArchived.asSharedFlow()
    private var runtimeStatusJob: Job? = null

    /**
     * 草稿入口：sessionId 为空，或 startsNewSession=true 且无 sessionId。
     * （二者在路由约定下等价于空 sessionId。）
     */
    private val isDraftSession: Boolean
        get() = sessionId.isBlank()

    init {
        syncOrganizationRuntime()
        if (isDraftSession) {
            resolveDraftSessionScope()
        } else {
            resolveFrozenSessionScope()
        }
        startSpaceRuntimeStatusMonitor()
        // 接 stream 的 title_updated 推送（草稿尚无 sessionId，不会误匹配）
        viewModelScope.safeLaunch {
            chatRepository.remoteSessionTitleUpdates.collect { (sid, title) ->
                if (sid == sessionId && sessionId.isNotBlank()) {
                    _uiState.value = _uiState.value.copy(sessionTitle = title)
                }
            }
        }
    }

    override fun onCleared() {
        runtimeStatusJob?.cancel()
        super.onCleared()
    }

    private fun syncOrganizationRuntime(targetOrganizationId: String = organizationId) {
        if (targetOrganizationId.isBlank() || targetOrganizationId == tokenManager.organizationId) return
        tokenManager.organizationId = targetOrganizationId
        viewModelScope.safeLaunch {
            webSocketService.fullDisconnect()
            val registered = deviceRuntimeRepository.ensureSelectedOrganizationDeviceRegistered(targetOrganizationId)
            if (registered) {
                webSocketService.ensureDeviceRuntimeReady()
            }
        }
    }

    /**
     * 草稿入口：不调 getSession。先用路由字段给出可用 scope / newTask*，
     * 再异步拉 Space/Agent 详情；失败时保留路由 stub，不阻断 Composer。
     */
    private fun resolveDraftSessionScope() {
        val presetAgentId = routeAgentId.takeIf { it.isNotBlank() }
        val stubSpace = spaceId.takeIf { it.isNotBlank() }?.let { id ->
            Space(id = id, organizationId = organizationId, name = initialSpaceName)
        }
        val stubAgent = presetAgentId?.let { id ->
            Agent(id = id, organizationId = organizationId, name = "")
        }
        executionScope = chatSessionEntryExecutionScope(
            organizationId = organizationId,
            workspaceId = spaceId,
            projectId = routeProjectId,
        )
        _uiState.value = _uiState.value.copy(
            spaceName = initialSpaceName,
            newTaskSpace = stubSpace,
            newTaskAgent = stubAgent,
            executionScope = executionScope,
            frozenAgentId = presetAgentId,
        )
        viewModelScope.safeLaunch {
            val space = spaceId.takeIf { it.isNotBlank() }?.let { id ->
                runCatching { spaceRepository.getSpace(id) }.getOrNull()
            }
            val workspaceId = when {
                space == null -> spaceId.takeIf { it.isNotBlank() }
                space.isExecutionSpace -> space.id
                else -> space.executionSpaceId?.takeIf { it.isNotBlank() } ?: space.id
            }
            val orgId = space?.organizationId?.takeIf { it.isNotBlank() } ?: organizationId
            val projectId = space?.takeIf { it.isProject }?.id
                ?: routeProjectId.takeIf { it.isNotBlank() }
            val scope = ConversationExecutionScope(
                organizationId = orgId,
                workspaceId = workspaceId,
                projectId = projectId,
            )
            executionScope = scope
            syncOrganizationRuntime(orgId)

            val agentIdToLoad = presetAgentId ?: space?.primaryAgentId
            val agent = agentIdToLoad?.let { id ->
                runCatching { spaceRepository.getAgent(id) }.getOrNull()
            }
            // 详情失败时继续用路由 stub，保证 newTask* / scope 仍可用。
            _uiState.value = _uiState.value.copy(
                spaceName = space?.name?.takeIf { it.isNotBlank() } ?: initialSpaceName,
                newTaskSpace = space ?: stubSpace,
                newTaskAgent = agent ?: stubAgent,
                executionScope = scope,
                frozenAgentId = agentIdToLoad ?: presetAgentId,
            )
            refreshSpaceRuntimeStatus()
        }
    }

    private fun resolveFrozenSessionScope() {
        if (sessionId.isBlank()) return
        viewModelScope.safeLaunch {
            val session = chatRepository.getSession(sessionId)
            val fallbackWorkspaceId = resolveEntryWorkspaceId()
            val scope = ConversationExecutionScope.resolvingFrozenSession(
                session = session,
                fallbackOrganizationId = organizationId,
                fallbackWorkspaceId = fallbackWorkspaceId,
            )
            executionScope = scope
            syncOrganizationRuntime(scope.organizationId)
            val newTaskSpace = scope.workspaceId?.let { workspaceId ->
                runCatching { spaceRepository.getSpace(workspaceId) }.getOrNull()
            }
            val newTaskAgent = session.agentId?.let { agentId ->
                runCatching { spaceRepository.getAgent(agentId) }.getOrNull()
            }
            _uiState.value = _uiState.value.copy(
                sessionTitle = session.displayTitle,
                messageCount = session.messageCount ?: _uiState.value.messageCount,
                session = session,
                newTaskSpace = newTaskSpace,
                newTaskAgent = newTaskAgent,
                executionScope = scope,
                frozenAgentId = session.agentId,
            )
            refreshSpaceRuntimeStatus()
        }
    }

    /** 仅为旧服务端快照缺 workspace_id 时兜底；Project 路由必须转换为其执行 Workspace。 */
    private suspend fun resolveEntryWorkspaceId(): String? {
        if (spaceId.isBlank()) return null
        return runCatching { spaceRepository.getSpace(spaceId) }
            .getOrNull()
            ?.let { space ->
                if (space.isExecutionSpace) space.id else space.executionSpaceId?.takeIf { it.isNotBlank() }
            }
            ?: spaceId
    }

    private fun startSpaceRuntimeStatusMonitor() {
        runtimeStatusJob?.cancel()
        runtimeStatusJob = viewModelScope.safeLaunch {
            while (true) {
                refreshSpaceRuntimeStatus()
                // 有软提示时收紧轮询，让 notice 尽快随设备恢复消失。
                val delayMs = if (_uiState.value.remoteExecutionState == RemoteExecutionState.READY) {
                    30_000L
                } else {
                    10_000L
                }
                delay(delayMs)
            }
        }
    }

    private suspend fun refreshSpaceRuntimeStatus() {
        val scope = executionScope
        val workspaceId = scope.workspaceId
        if (workspaceId.isNullOrBlank() || scope.organizationId.isBlank()) {
            _uiState.value = _uiState.value.copy(runtimeStatusReady = true, remoteExecutionState = RemoteExecutionState.READY)
            return
        }
        try {
            val space = spaceRepository.getSpace(workspaceId)
            val deviceId = space.controlDeviceId ?: space.boundDeviceId
            if (deviceId.isNullOrBlank()) {
                _uiState.value = _uiState.value.copy(
                    runtimeStatusReady = true,
                    remoteExecutionState = RemoteExecutionState.WORKSPACE_NEEDS_DEVICE,
                )
                return
            }
            val device = spaceRepository.getDevices(scope.organizationId).firstOrNull { it.id == deviceId }
            _uiState.value = _uiState.value.copy(
                runtimeStatusReady = true,
                remoteExecutionState = if (device?.isAvailableForExecution == true) {
                    RemoteExecutionState.READY
                } else {
                    RemoteExecutionState.DEVICE_UNAVAILABLE
                },
            )
        } catch (_: Exception) {
            // 探测失败不误报离线；真正发送仍由后端执行路由裁决。
            _uiState.value = _uiState.value.copy(
                runtimeStatusReady = true,
                remoteExecutionState = RemoteExecutionState.READY,
            )
        }
    }

    /** ConversationView 的 onSessionUpdated 回调入口：流结束 / title 更新时刷新 toolbar 显示。 */
    public fun updateSessionMeta(newTitle: String? = null, newMessageCount: Int? = null) {
        if (newTitle == null && newMessageCount == null) return
        _uiState.value = _uiState.value.copy(
            sessionTitle = newTitle ?: _uiState.value.sessionTitle,
            messageCount = newMessageCount ?: _uiState.value.messageCount,
            session = _uiState.value.session?.copy(
                title = newTitle ?: _uiState.value.session?.title,
                messageCount = newMessageCount ?: _uiState.value.session?.messageCount,
            ),
        )
    }

    public fun renameSession(title: String) {
        val normalized = title.trim()
        if (normalized.isEmpty() || sessionId.isBlank() || _uiState.value.isSavingTitle) return
        _uiState.value = _uiState.value.copy(isSavingTitle = true, sessionActionMessage = null)
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.value = _uiState.value.copy(
                    isSavingTitle = false,
                    sessionActionMessage = error.message ?: "保存会话标题失败，请稍后重试。",
                )
            },
        ) {
            val updated = chatRepository.renameSession(sessionId, normalized)
            _uiState.value = _uiState.value.copy(
                sessionTitle = updated.displayTitle,
                session = updated,
                isSavingTitle = false,
                sessionActionMessage = "会话标题已保存。",
            )
        }
    }

    /** 归档不会取消正在执行的任务；运行中必须先等任务结束。 */
    public fun archiveSession(isStreaming: Boolean) {
        if (sessionId.isBlank() || _uiState.value.isArchiving) return
        if (isStreaming) {
            _uiState.value = _uiState.value.copy(
                sessionActionMessage = "当前任务仍在运行，暂时不能归档。请等待任务结束后重试。",
            )
            return
        }
        _uiState.value = _uiState.value.copy(isArchiving = true, sessionActionMessage = null)
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.value = _uiState.value.copy(
                    isArchiving = false,
                    sessionActionMessage = error.message ?: "归档会话失败，请稍后重试。",
                )
            },
        ) {
            chatRepository.archiveSession(sessionId)
            _uiState.value = _uiState.value.copy(isArchiving = false)
            _sessionArchived.tryEmit(Unit)
        }
    }

    public fun dismissSessionActionMessage() {
        _uiState.value = _uiState.value.copy(sessionActionMessage = null)
    }

    public fun forkSession(messageId: String? = null) {
        viewModelScope.safeLaunch(
            onError = {
                _uiState.value = _uiState.value.copy(errorRes = R.string.chat_message_fork_failed)
            },
        ) {
            val newSession = chatRepository.forkSession(sessionId, messageId)
            _forkedSession.tryEmit(newSession)
        }
    }

    public fun dismissError() {
        _uiState.value = _uiState.value.copy(errorRes = null)
    }
}

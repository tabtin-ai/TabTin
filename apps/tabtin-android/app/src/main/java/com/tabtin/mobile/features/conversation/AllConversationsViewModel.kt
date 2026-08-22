package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.data.repository.AllSessionsRepository
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.PendingInteractionRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SessionListActivityStore
import com.tabtin.mobile.data.repository.SessionReadStateStore
import com.tabtin.mobile.data.repository.SessionRunStateStore
import com.tabtin.mobile.data.websocket.WSConnectionState
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

public data class AllConversationsUiState(
    val sessions: List<AllChatSession> = emptyList(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val isLoadingMore: Boolean = false,
    @StringRes val errorRes: Int? = null,
    @StringRes val actionErrorRes: Int? = null,
    val archivingIds: Set<String> = emptySet(),
    val restoringIds: Set<String> = emptySet(),
    val deletingIds: Set<String> = emptySet(),
    val hasMore: Boolean = false,
)

internal data class TaskHomeListQuery(
    val scope: TaskHomeScope = TaskHomeScope.ALL,
    val workspaceId: String? = null,
    val keyword: String? = null,
)

@HiltViewModel
public class AllConversationsViewModel @Inject constructor(
    private val repo: AllSessionsRepository,
    private val chatRepository: ChatRepository,
    private val organizationRepository: OrganizationRepository,
    pendingInteractionRepository: PendingInteractionRepository,
    private val sessionRunStateStore: SessionRunStateStore,
    private val sessionReadStateStore: SessionReadStateStore,
    private val sessionListActivityStore: SessionListActivityStore,
    private val webSocketService: WebSocketService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AllConversationsUiState())
    public val uiState: StateFlow<AllConversationsUiState> = _uiState.asStateFlow()
    public val organizationId: String? get() = repo.currentOrganizationId

    /** 存在待处理事项（审批 / 提问 / 表单等）的 sessionId 集合，驱动列表行 pill */
    public val pendingSessionIds: StateFlow<Set<String>> =
        pendingInteractionRepository.pendingSessionIds
    private var requestSeq: Int = 0
    /** 服务端 offset 以已取回行数推进，不能用去重后的可见条数推断。 */
    private var nextOffset: Int = 0
    private var listQuery: TaskHomeListQuery = TaskHomeListQuery()

    init {
        viewModelScope.safeLaunch {
            chatRepository.archivedSessionIds.collect { sessionId ->
                repo.removeCachedRecentSession(sessionId)
                _uiState.update { state ->
                    state.copy(
                        sessions = state.sessions.filterNot { it.id == sessionId },
                        archivingIds = state.archivingIds - sessionId,
                    )
                }
            }
        }
        viewModelScope.launch {
            sessionRunStateStore.updates.collect { update ->
                _uiState.update { state ->
                    state.copy(
                        sessions = state.sessions.map { session ->
                            if (session.id != update.sessionId) session else session.copy(
                                runState = update.runState,
                                hasActiveTask = update.runState.isActive,
                                lastRunFailed = update.runState.status == SessionRunStatus.FAILED,
                            )
                        },
                    )
                }
            }
        }
        viewModelScope.launch {
            sessionReadStateStore.updates.collect { update ->
                _uiState.update { state ->
                    state.copy(
                        sessions = state.sessions.map { session ->
                            if (session.id != update.sessionId) session else session.copy(
                                readState = update.readState,
                                hasUnreadReply = update.readState.hasUnreadReply,
                            )
                        },
                    )
                }
            }
        }
        viewModelScope.launch {
            sessionListActivityStore.updates.collect { activity ->
                _uiState.update { state ->
                    state.copy(
                        sessions = AllConversationsActivityPolicy.upsertAndReorder(
                            existing = state.sessions,
                            activity = activity,
                        ),
                    )
                }
            }
        }
        // WS 重连后 REST reconcile（对齐 iOS RecentSessionsStore reconnect）。
        // 与 UserEventHandler 的 pendingInteraction refresh 独立；此处只重拉会话目录。
        viewModelScope.launch {
            var wasConnected =
                webSocketService.connectionState.value == WSConnectionState.Connected
            webSocketService.connectionState.collect { state ->
                val isConnected = state == WSConnectionState.Connected
                if (isConnected && !wasConnected) {
                    load()
                }
                wasConnected = isConnected
            }
        }
        // 组织切换时只清状态；列表重拉由 TaskHomeScreen.setListQuery 统一触发一次。
        //
        // 「首次拿到组织事实」不是切换：此时首屏请求往往正在途中，把它当切换处理会
        // 递增 requestSeq 作废在途请求，而那些请求恢复后仍会把 isLoading 置回 true
        // 且再没人清——列表就永远停在转圈上（无任何报错，safeLaunch 静默吞掉）。
        viewModelScope.safeLaunch {
            var previousOrganizationId: String? = null
            organizationRepository.selectedOrganization
                .filterNotNull()
                .map { it.id }
                .distinctUntilChanged()
                .collect { organizationId ->
                    val shouldReset = shouldResetForOrganizationChange(
                        previous = previousOrganizationId,
                        next = organizationId,
                    )
                    previousOrganizationId = organizationId
                    if (shouldReset) resetForOrganizationSwitch()
                }
        }
    }

    private fun resetForOrganizationSwitch() {
        requestSeq += 1
        _uiState.value = AllConversationsUiState()
        nextOffset = 0
        listQuery = TaskHomeListQuery()
    }

    internal fun setListQuery(scope: TaskHomeScope, workspaceId: String?, keyword: String? = null) {
        val sanitized = workspaceId?.takeIf { it.isNotBlank() }
        val sanitizedKeyword = keyword?.trim()?.takeIf { it.isNotEmpty() }
        val nextQuery = TaskHomeListQuery(
            scope = scope,
            workspaceId = sanitized,
            keyword = sanitizedKeyword,
        )
        val state = _uiState.value
        if (nextQuery == listQuery && (state.sessions.isNotEmpty() || state.isLoading)) return
        listQuery = nextQuery
        nextOffset = 0
        load()
    }

    public fun load() {
        val seq = ++requestSeq
        nextOffset = 0
        viewModelScope.safeLaunch(
            onError = { e ->
                if (seq != requestSeq) return@safeLaunch
                _uiState.value = _uiState.value.copy(
                    errorRes = ErrorClassifier.classify(e),
                    isLoading = false,
                    isRefreshing = false,
                )
            },
        ) {
            val organizationId = repo.currentOrganizationId
            val canUseRecentCache = listQuery == TaskHomeListQuery()
            if (canUseRecentCache && _uiState.value.sessions.isEmpty() && !organizationId.isNullOrBlank()) {
                val cached = repo.getCachedRecent(organizationId)
                if (cached.isNotEmpty() && seq == requestSeq) {
                    _uiState.value = _uiState.value.copy(sessions = cached)
                }
            }
            // 读缓存是挂起点：期间可能已被作废。失效的请求绝不能再把 isLoading 置回
            // true——它的响应稍后会被丢弃，没人来清这个标志。
            if (seq != requestSeq) return@safeLaunch
            _uiState.value = _uiState.value.copy(
                isLoading = _uiState.value.sessions.isEmpty(),
                errorRes = null,
            )
            val resp = repo.listAll(
                status = listQuery.scope.wireStatus,
                runStatus = listQuery.scope.wireRunStatus,
                workspaceId = listQuery.workspaceId,
                keyword = listQuery.keyword,
                offset = 0,
            )
            if (seq != requestSeq) return@safeLaunch
            _uiState.value = _uiState.value.copy(
                sessions = resp.sessions,
                hasMore = resp.hasMore,
                isLoading = false,
                isRefreshing = false,
            )
            nextOffset = resp.sessions.size
        }
    }

    public fun loadMore() {
        val state = _uiState.value
        if (!state.hasMore || state.isLoadingMore || state.isLoading) return
        val seq = requestSeq
        val offset = nextOffset
        _uiState.update { it.copy(isLoadingMore = true) }
        viewModelScope.safeLaunch(
            onError = { e ->
                if (seq != requestSeq) return@safeLaunch
                _uiState.update { it.copy(isLoadingMore = false, actionErrorRes = ErrorClassifier.classify(e)) }
            },
        ) {
            val response = repo.listAll(
                status = listQuery.scope.wireStatus,
                runStatus = listQuery.scope.wireRunStatus,
                workspaceId = listQuery.workspaceId,
                keyword = listQuery.keyword,
                offset = offset,
            )
            if (seq != requestSeq) return@safeLaunch
            nextOffset += response.sessions.size
            _uiState.update { current ->
                current.copy(
                    sessions = mergeSessionPage(current.sessions, response.sessions),
                    hasMore = response.hasMore,
                    isLoadingMore = false,
                )
            }
        }
    }

    public fun refresh() {
        _uiState.value = _uiState.value.copy(isRefreshing = true)
        load()
    }

    public fun dismissError() {
        _uiState.value = _uiState.value.copy(errorRes = null)
    }

    /** 归档成功后立即从当前「最近」列表及其离线快照移除。 */
    public fun archiveSession(sessionId: String) {
        if (sessionId in _uiState.value.archivingIds) return
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.value = _uiState.value.let {
                    it.copy(
                        archivingIds = it.archivingIds - sessionId,
                        actionErrorRes = ErrorClassifier.classify(e),
                    )
                }
            },
        ) {
            _uiState.value = _uiState.value.let {
                it.copy(archivingIds = it.archivingIds + sessionId, actionErrorRes = null)
            }
            chatRepository.archiveSession(sessionId)
            repo.removeCachedRecentSession(sessionId)
            _uiState.value = _uiState.value.let {
                it.copy(
                    sessions = it.sessions.filterNot { session -> session.id == sessionId },
                    archivingIds = it.archivingIds - sessionId,
                )
            }
        }
    }

    public fun restoreSession(sessionId: String) {
        if (sessionId in _uiState.value.restoringIds) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        restoringIds = it.restoringIds - sessionId,
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(restoringIds = it.restoringIds + sessionId, actionErrorRes = null)
            }
            chatRepository.restoreSession(sessionId)
            _uiState.update {
                it.copy(
                    sessions = it.sessions.filterNot { session -> session.id == sessionId },
                    restoringIds = it.restoringIds - sessionId,
                )
            }
        }
    }

    public fun deleteSessionPermanently(sessionId: String) {
        if (sessionId in _uiState.value.deletingIds) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        deletingIds = it.deletingIds - sessionId,
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(deletingIds = it.deletingIds + sessionId, actionErrorRes = null)
            }
            chatRepository.deleteSession(sessionId)
            _uiState.update {
                it.copy(
                    sessions = it.sessions.filterNot { session -> session.id == sessionId },
                    deletingIds = it.deletingIds - sessionId,
                )
            }
        }
    }

    public fun setSessionPinned(sessionId: String, isPinned: Boolean) {
        val previous = _uiState.value.sessions.firstOrNull { it.id == sessionId } ?: return
        _uiState.update { state ->
            state.copy(
                sessions = state.sessions.map { if (it.id == sessionId) it.copy(isPinned = isPinned) else it },
                actionErrorRes = null,
            )
        }
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update { state ->
                    state.copy(
                        sessions = state.sessions.map { if (it.id == sessionId) previous else it },
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            chatRepository.setSessionPinned(sessionId, isPinned)
        }
    }

    public fun consumeActionError() {
        _uiState.value = _uiState.value.copy(actionErrorRes = null)
    }
}

/**
 * 只有「从一个组织换到另一个组织」才需要清空列表状态。
 *
 * 首次拿到组织事实不是切换——那一刻首屏请求往往正在途中，按切换处理会作废它，
 * 而在途请求恢复后仍会把 isLoading 置回 true 且再没人清，列表永远停在转圈上。
 */
internal fun shouldResetForOrganizationChange(previous: String?, next: String): Boolean =
    previous != null && previous != next

/** 同一 session 在跨页期间更新时，保留列表位置并以较新的服务端投影覆盖字段。 */
internal fun mergeSessionPage(
    existing: List<AllChatSession>,
    incoming: List<AllChatSession>,
): List<AllChatSession> {
    val merged = existing.toMutableList()
    val indexes = existing.mapIndexed { index, session -> session.id to index }.toMap().toMutableMap()
    for (session in incoming) {
        val index = indexes[session.id]
        if (index == null) {
            indexes[session.id] = merged.size
            merged += session
        } else {
            merged[index] = session
        }
    }
    return merged
}

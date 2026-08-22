package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ProjectParticipant
import com.tabtin.mobile.data.model.ProjectParticipantKind
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.PendingInteractionRepository
import com.tabtin.mobile.data.repository.SessionListActivityStore
import com.tabtin.mobile.data.repository.SessionReadStateStore
import com.tabtin.mobile.data.repository.SessionRunStateStore
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import javax.inject.Inject

public data class AgentSessionsUiState(
    val space: Space? = null,
    val sessions: List<ChatSession> = emptyList(),
    val agents: List<ProjectParticipant> = emptyList(),
    val isLoading: Boolean = true,
    val archivingIds: Set<String> = emptySet(),
    @StringRes val errorRes: Int? = null,
    @StringRes val actionErrorRes: Int? = null,
)

/**
 * 该 agent 下的 session 列表 + "新建对话"动作。
 *
 * spaceId 由 [AgentSessionsScreen] 首帧经 [start] 显式注入（Screen 用
 * `hiltViewModel(key = "agent-sessions-$spaceId")` 按 agent 隔离实例）。
 * SavedStateHandle 只作 nav-args 兜底——本 Screen 当前不在路由参数里，拿不到值。
 */
@HiltViewModel
public class AgentSessionsViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val chatRepository: ChatRepository,
    private val spaceRepository: SpaceRepository,
    private val tokenManager: TokenManager,
    pendingInteractionRepository: PendingInteractionRepository,
    private val sessionRunStateStore: SessionRunStateStore,
    private val sessionReadStateStore: SessionReadStateStore,
    private val sessionListActivityStore: SessionListActivityStore,
) : ViewModel() {

    public var spaceId: String = savedStateHandle["spaceId"] ?: ""
        private set

    private val _uiState = MutableStateFlow(AgentSessionsUiState())
    public val uiState: StateFlow<AgentSessionsUiState> = _uiState.asStateFlow()

    /** 存在待处理事项（审批 / 提问 / 表单等）的 sessionId 集合，驱动列表行 pill */
    public val pendingSessionIds: StateFlow<Set<String>> =
        pendingInteractionRepository.pendingSessionIds

    private var started = false

    init {
        viewModelScope.safeLaunch {
            chatRepository.archivedSessionIds.collect { sessionId ->
                _uiState.update { state ->
                    state.copy(
                        sessions = state.sessions.filterNot { it.id == sessionId },
                        archivingIds = state.archivingIds - sessionId,
                    )
                }
            }
        }
        viewModelScope.safeLaunch {
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
        viewModelScope.safeLaunch {
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
                        sessions = AgentSessionsActivityPolicy.upsertAndReorder(
                            existing = state.sessions,
                            activity = activity,
                            spaceId = spaceId,
                        ),
                    )
                }
            }
        }
    }

    /**
     * MainScreen 通过 Compose 参数传 spaceId，本 Screen 不在 nav back stack 的路由参数里，
     * SavedStateHandle["spaceId"] 永远拿不到（历史 bug：恒为空串 →
     * `GET /chat/sessions?space_id=` 400「智能体空间不存在」，列表/新建全挂）。
     * 由 Screen 首帧调用本方法注入真实 spaceId 并触发首轮加载；VM 按
     * `key = "agent-sessions-$spaceId"` 隔离实例，至多 start 一次。
     */
    public fun start(spaceId: String) {
        if (started) return
        started = true
        if (spaceId.isNotBlank()) this.spaceId = spaceId
        loadSpace()
        loadAgentRoster()
        loadSessions()
    }

    private fun loadAgentRoster() {
        viewModelScope.safeLaunch(onError = { /* Agent 花名册失败不阻塞会话 */ }) {
            val memberships = spaceRepository.getSpaceMemberships(spaceId)
                .filter { it.agentId != null }
            val agentsById = coroutineScope {
                memberships.mapNotNull { it.agentId }.distinct().map { agentId ->
                    async { runCatching { spaceRepository.getAgent(agentId) }.getOrNull() }
                }.awaitAll().filterNotNull().associateBy { it.id }
            }
            val currentUserId = tokenManager.userId
            val agents = memberships.mapNotNull { membership ->
                val agentId = membership.agentId ?: return@mapNotNull null
                val agent = agentsById[agentId] ?: return@mapNotNull null
                ProjectParticipant(
                    id = membership.id,
                    name = agent.name.ifBlank { "Agent" },
                    kind = ProjectParticipantKind.AGENT,
                    role = membership.role,
                    roleLabel = membership.roleLabel,
                    responsibility = membership.responsibility,
                    agentId = agentId,
                    ownedByCurrentUser = currentUserId != null &&
                        (agent.userId == currentUserId || agent.ownerUserId == currentUserId),
                    isPrimary = membership.isPrimary,
                )
            }.sortedWith(
                compareByDescending<ProjectParticipant> { it.isPrimary }
                    .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name },
            )
            _uiState.value = _uiState.value.copy(agents = agents)
        }
    }

    private fun loadSpace() {
        viewModelScope.safeLaunch(onError = { /* space 加载失败不阻塞 sessions */ }) {
            val space = spaceRepository.getSpace(spaceId)
            _uiState.value = _uiState.value.copy(space = space)
        }
    }

    public fun loadSessions() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.value = _uiState.value.copy(
                    errorRes = ErrorClassifier.classify(e),
                    isLoading = false,
                )
            },
        ) {
            _uiState.value = _uiState.value.copy(
                isLoading = _uiState.value.sessions.isEmpty(),
                errorRes = null,
            )
            val space = _uiState.value.space ?: spaceRepository.getSpace(spaceId)
            val sessions = chatRepository.getSessions(space)
            _uiState.value = _uiState.value.copy(
                sessions = sessions,
                isLoading = false,
            )
        }
    }

    /** 归档成功后立即从该 Workspace 的活跃会话列表移除。 */
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
            _uiState.value = _uiState.value.let {
                it.copy(
                    sessions = it.sessions.filterNot { session -> session.id == sessionId },
                    archivingIds = it.archivingIds - sessionId,
                )
            }
        }
    }

    public fun dismissError() {
        _uiState.value = _uiState.value.copy(errorRes = null)
    }

    public fun consumeActionError() {
        _uiState.value = _uiState.value.copy(actionErrorRes = null)
    }
}

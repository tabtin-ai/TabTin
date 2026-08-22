package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.im.ImConversationService
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.im.resolveDirectMessageConversationId
import com.tabtin.mobile.data.model.PendingProjectInvitation
import com.tabtin.mobile.data.model.Project
import com.tabtin.mobile.data.model.ProjectDetailData
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.ProjectRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.TokenManager
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

public data class ProjectUiState(
    val projects: List<Project> = emptyList(),
    val pendingInvitations: List<PendingProjectInvitation> = emptyList(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    @StringRes val errorRes: Int? = null,
    val invitationLoadFailed: Boolean = false,
    val selectedProject: Project? = null,
    val detail: ProjectDetailData? = null,
    val isLoadingDetail: Boolean = false,
    val isUpdatingPrimaryAgent: Boolean = false,
    @StringRes val detailErrorRes: Int? = null,
)

public data class ProjectDirectMessageTarget(
    val conversationId: String,
    val title: String,
)

@HiltViewModel
public class ProjectViewModel @Inject constructor(
    private val repository: ProjectRepository,
    private val organizationRepository: OrganizationRepository,
    private val conversationService: ImConversationService,
    private val conversationStore: ImConversationStore,
    private val tokenManager: TokenManager,
) : ViewModel() {
    private val _uiState = MutableStateFlow(ProjectUiState())
    public val uiState: StateFlow<ProjectUiState> = _uiState.asStateFlow()
    private var listRequestSeq = 0
    private var detailRequestSeq = 0

    public val currentUserId: String?
        get() = tokenManager.userId?.takeIf { it.isNotBlank() }

    init {
        load()
        viewModelScope.safeLaunch {
            organizationRepository.selectedOrganization
                .filterNotNull()
                .map { it.id }
                .distinctUntilChanged()
                .collect {
                    listRequestSeq += 1
                    detailRequestSeq += 1
                    _uiState.value = ProjectUiState()
                    load()
                }
        }
    }

    public fun load() {
        val organizationId = repository.currentOrganizationId ?: return
        val seq = ++listRequestSeq
        viewModelScope.safeLaunch(
            onError = { error ->
                if (seq != listRequestSeq) return@safeLaunch
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        errorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    isLoading = it.projects.isEmpty(),
                    errorRes = null,
                    invitationLoadFailed = false,
                )
            }
            val (projectsResult, invitationsResult) = coroutineScope {
                val projects = async { runCatching { repository.getProjects(organizationId) } }
                val invitations = async { runCatching { repository.getPendingInvitations(organizationId) } }
                projects.await() to invitations.await()
            }
            if (seq != listRequestSeq) return@safeLaunch
            if (projectsResult.isFailure) throw projectsResult.exceptionOrNull()!!
            _uiState.update {
                it.copy(
                    projects = projectsResult.getOrDefault(emptyList())
                        .sortedByDescending { project -> project.lastActivityAt ?: project.updatedAt ?: "" },
                    pendingInvitations = invitationsResult.getOrDefault(emptyList()),
                    invitationLoadFailed = invitationsResult.isFailure,
                    isLoading = false,
                    isRefreshing = false,
                )
            }
        }
    }

    public fun refresh() {
        _uiState.update { it.copy(isRefreshing = true) }
        load()
    }

    public fun openProject(project: Project) {
        _uiState.update { it.copy(selectedProject = project, detail = null, detailErrorRes = null) }
        loadDetail(project)
    }

    public fun closeProject() {
        detailRequestSeq += 1
        _uiState.update {
            it.copy(selectedProject = null, detail = null, isLoadingDetail = false, detailErrorRes = null)
        }
    }

    public fun reloadSelectedProject() {
        val project = _uiState.value.selectedProject ?: return
        loadDetail(project)
    }

    public fun loadDetail(project: Project) {
        val seq = ++detailRequestSeq
        viewModelScope.safeLaunch(
            onError = { error ->
                if (seq != detailRequestSeq) return@safeLaunch
                _uiState.update {
                    it.copy(
                        isLoadingDetail = false,
                        detailErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update { it.copy(isLoadingDetail = true, detailErrorRes = null) }
            val detail = repository.getDetail(project)
            if (seq != detailRequestSeq) return@safeLaunch
            _uiState.update {
                it.copy(
                    selectedProject = detail.project,
                    detail = detail,
                    isLoadingDetail = false,
                )
            }
        }
    }

    /** 点人类成员 → 幂等创建/复用私信；导航由调用方负责。 */
    public suspend fun createDirectMessage(
        userId: String,
        displayName: String,
    ): Result<ProjectDirectMessageTarget> {
        if (userId.isBlank()) {
            return Result.failure(IllegalArgumentException("缺少目标用户"))
        }
        if (userId == currentUserId) {
            return Result.failure(IllegalArgumentException("不能给自己发私信"))
        }
        val organizationId = repository.currentOrganizationId?.takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("组织信息尚未就绪"))
        return runCatching {
            val conversationId = resolveDirectMessageConversationId(
                conversations = conversationStore.conversations.value,
                organizationId = organizationId,
                otherUserId = userId,
            ) {
                conversationService.createOrGetDM(organizationId, userId)
            }
            check(conversationId.isNotBlank()) { "私信会话创建失败" }
            conversationStore.rememberDirectMessage(
                conversationId = conversationId,
                organizationId = organizationId,
                otherUserId = userId,
                displayName = displayName,
            )
            ProjectDirectMessageTarget(
                conversationId = conversationId,
                title = displayName.ifBlank { "私信" },
            )
        }
    }

    public fun setPrimaryAgent(agentId: String) {
        val project = _uiState.value.selectedProject ?: return
        if (!project.canManage || _uiState.value.isUpdatingPrimaryAgent) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        isUpdatingPrimaryAgent = false,
                        detailErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update { it.copy(isUpdatingPrimaryAgent = true) }
            repository.setPrimaryAgent(project.id, agentId)
            val updated = project.copy(primaryAgentId = agentId)
            _uiState.update { current ->
                current.copy(
                    selectedProject = updated,
                    detail = current.detail?.copy(
                        project = updated,
                        participants = current.detail.participants.map { participant ->
                            participant.copy(isPrimary = participant.agentId == agentId)
                        },
                    ),
                    isUpdatingPrimaryAgent = false,
                )
            }
        }
    }
}

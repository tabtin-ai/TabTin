package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentTemplate
import com.tabtin.mobile.data.model.CreateAgentRequest
import com.tabtin.mobile.data.model.DeactivatedAgent
import com.tabtin.mobile.data.model.UpdateAgentRequest
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.TokenManager
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
import java.time.Instant
import javax.inject.Inject

public data class MyAgentsUiState(
    val agents: List<Agent> = emptyList(),
    val deactivatedAgents: List<DeactivatedAgent> = emptyList(),
    val templates: List<AgentTemplate> = emptyList(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val isLoadingTemplates: Boolean = false,
    val isMutating: Boolean = false,
    @StringRes val errorRes: Int? = null,
    @StringRes val actionErrorRes: Int? = null,
)

/** 工作 Tab「AI分身」：对齐 Electron MyAgentsPanel 的组织 Agent 列表。 */
@HiltViewModel
public class MyAgentsViewModel @Inject constructor(
    private val tokenManager: TokenManager,
    private val spaceRepository: SpaceRepository,
    private val organizationRepository: OrganizationRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(MyAgentsUiState())
    public val uiState: StateFlow<MyAgentsUiState> = _uiState.asStateFlow()

    private var loadSeq = 0

    public val ownerName: String
        get() = tokenManager.userNickname?.trim().takeUnless { it.isNullOrEmpty() }
            ?: tokenManager.userUsername?.trim().takeUnless { it.isNullOrEmpty() }
            ?: "我"

    init {
        load()
        observeOrganizationChanges()
    }

    public fun refresh() {
        load(isRefresh = true)
    }

    public fun clearActionError() {
        _uiState.update { it.copy(actionErrorRes = null) }
    }

    public fun loadTemplates() {
        if (_uiState.value.isLoadingTemplates) return
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(
                        isLoadingTemplates = false,
                        actionErrorRes = ErrorClassifier.classify(e),
                    )
                }
            },
        ) {
            _uiState.update { it.copy(isLoadingTemplates = true, actionErrorRes = null) }
            val templates = spaceRepository.getAgentTemplates()
            _uiState.update { it.copy(templates = templates, isLoadingTemplates = false) }
        }
    }

    public fun createAgent(
        name: String,
        templateId: String?,
        avatarKey: String,
        onSuccess: (Agent) -> Unit = {},
    ) {
        val organizationId = tokenManager.organizationId ?: return
        val trimmedName = name.trim()
        if (trimmedName.isEmpty()) return
        mutate(onSuccess) {
            spaceRepository.createAgent(
                CreateAgentRequest(
                    organizationId = organizationId,
                    name = trimmedName,
                    templateId = templateId,
                    avatarKey = avatarKey,
                ),
            )
        }
    }

    public fun updateAgent(
        agentId: String,
        name: String,
        customRules: String,
        avatarKey: String,
        onSuccess: (Agent) -> Unit = {},
    ) {
        val trimmedName = name.trim()
        if (trimmedName.isEmpty()) return
        mutate(onSuccess) {
            spaceRepository.updateAgent(
                agentId,
                UpdateAgentRequest(
                    name = trimmedName,
                    customRules = customRules.trim(),
                    avatarKey = avatarKey,
                ),
            )
        }
    }

    public fun deactivateAgent(agentId: String, onSuccess: () -> Unit = {}) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(isMutating = false, actionErrorRes = ErrorClassifier.classify(e))
                }
            },
        ) {
            _uiState.update { it.copy(isMutating = true, actionErrorRes = null) }
            spaceRepository.deleteAgent(agentId)
            _uiState.update { state ->
                val deactivated = state.agents.firstOrNull { it.id == agentId }?.let { agent ->
                    DeactivatedAgent(
                        id = agent.id,
                        name = agent.displayName?.takeIf { it.isNotBlank() } ?: agent.name,
                        type = agent.type,
                        createdAt = agent.createdAt,
                        // DELETE 会在服务端刷新 updated_at，但响应不回传 Agent；本地先用
                        // 当前时间，避免把停用前的旧更新时间误展示成“停用于”。
                        deactivatedAt = Instant.now().toString(),
                    )
                }
                state.copy(
                    agents = state.agents.filterNot { agent -> agent.id == agentId },
                    deactivatedAgents = listOfNotNull(deactivated) + state.deactivatedAgents
                        .filterNot { it.id == agentId },
                    isMutating = false,
                )
            }
            onSuccess()
        }
    }

    public fun reactivateAgent(agentId: String) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(isMutating = false, actionErrorRes = ErrorClassifier.classify(e))
                }
            },
        ) {
            _uiState.update { it.copy(isMutating = true, actionErrorRes = null) }
            val reactivated = spaceRepository.reactivateAgent(agentId)
            _uiState.update { state ->
                state.copy(
                    agents = (state.agents.filterNot { it.id == reactivated.id } + reactivated)
                        .sortedByDescending { it.updatedAt.ifBlank { it.createdAt } },
                    deactivatedAgents = state.deactivatedAgents.filterNot { it.id == reactivated.id },
                    isMutating = false,
                )
            }
        }
    }

    public fun permanentlyDeleteAgent(agentId: String, onSuccess: () -> Unit = {}) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(isMutating = false, actionErrorRes = ErrorClassifier.classify(e))
                }
            },
        ) {
            _uiState.update { it.copy(isMutating = true, actionErrorRes = null) }
            spaceRepository.permanentlyDeleteAgent(agentId)
            _uiState.update { state ->
                state.copy(
                    deactivatedAgents = state.deactivatedAgents.filterNot { it.id == agentId },
                    isMutating = false,
                )
            }
            onSuccess()
        }
    }

    public fun load(isRefresh: Boolean = false) {
        val seq = ++loadSeq
        viewModelScope.safeLaunch(
            onError = { e ->
                if (seq != loadSeq) return@safeLaunch
                _uiState.update {
                    it.copy(
                        errorRes = ErrorClassifier.classify(e),
                        isLoading = false,
                        isRefreshing = false,
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    isLoading = !isRefresh && it.agents.isEmpty() && it.deactivatedAgents.isEmpty(),
                    isRefreshing = isRefresh,
                    errorRes = null,
                )
            }
            if (tokenManager.organizationId.isNullOrBlank()) {
                if (seq != loadSeq) return@safeLaunch
                _uiState.update {
                    it.copy(
                        agents = emptyList(),
                        deactivatedAgents = emptyList(),
                        isLoading = false,
                        isRefreshing = false,
                        errorRes = R.string.my_agents_load_failed,
                    )
                }
                return@safeLaunch
            }
            val agents = spaceRepository.getAgents()
                .filter { it.isActive }
                .sortedByDescending { it.updatedAt.ifBlank { it.createdAt } }
            // 已停用列表属于辅助信息：老服务端不支持时不能阻断活跃分身的主列表。
            val deactivatedAgents = runCatching { spaceRepository.getDeactivatedAgents() }
                .getOrDefault(emptyList())
                .sortedByDescending { it.deactivatedAt ?: it.createdAt.orEmpty() }
            if (seq != loadSeq) return@safeLaunch
            _uiState.update {
                it.copy(
                    agents = agents,
                    deactivatedAgents = deactivatedAgents,
                    isLoading = false,
                    isRefreshing = false,
                    errorRes = null,
                )
            }
        }
    }

    private fun observeOrganizationChanges() {
        viewModelScope.launch {
            organizationRepository.selectedOrganization
                .map { it?.id }
                .filterNotNull()
                .distinctUntilChanged()
                .collect { load() }
        }
    }

    private fun mutate(onSuccess: (Agent) -> Unit, block: suspend () -> Agent) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(isMutating = false, actionErrorRes = ErrorClassifier.classify(e))
                }
            },
        ) {
            _uiState.update { it.copy(isMutating = true, actionErrorRes = null) }
            val updated = block()
            _uiState.update { state ->
                val exists = state.agents.any { it.id == updated.id }
                val next = if (exists) {
                    state.agents.map { if (it.id == updated.id) updated else it }
                } else {
                    listOf(updated) + state.agents
                }
                state.copy(
                    agents = next.sortedByDescending { it.updatedAt.ifBlank { it.createdAt } },
                    isMutating = false,
                )
            }
            onSuccess(updated)
        }
    }
}

package com.tabtin.mobile.features.space

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentConfig
import com.tabtin.mobile.data.model.AgentSecurityConfig
import com.tabtin.mobile.data.model.ApprovalMemoEntry
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.allowYoloMode
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.util.AppLifecycleManager
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

public data class SpaceSecurityUiState(
    val space: Space? = null,
    val agent: Agent? = null,
    val allowYoloMode: Boolean = false,
    /** 组织准入天花板：false 时 YOLO 开关置灰、强制关闭、不下发。 */
    val orgAllowsYolo: Boolean = false,
    val memoEntries: List<Pair<String, ApprovalMemoEntry>> = emptyList(),
    val approvalMemoGeneration: Int = 0,
    val isLoading: Boolean = true,
    val isSaving: Boolean = false,
    val saveSuccess: Boolean = false,
    val errorRes: Int? = null,
) {
    val isDirty: Boolean
        get() {
            if (agent == null || !orgAllowsYolo) return false
            return allowYoloMode != (agent.agentConfig?.allowYoloMode ?: false)
        }
}

@HiltViewModel
public class SpaceSecurityViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val spaceRepository: SpaceRepository,
    private val organizationRepository: OrganizationRepository,
) : ViewModel() {

    public val spaceId: String = savedStateHandle["spaceId"] ?: ""

    private val _uiState = MutableStateFlow(SpaceSecurityUiState())
    public val uiState: StateFlow<SpaceSecurityUiState> = _uiState.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            AppLifecycleManager.memoUpdatedFlow.collect { updatedWorkspaceId ->
                if (spaceId == updatedWorkspaceId) {
                    load()
                }
            }
        }
    }

    private fun load() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    errorRes = ErrorClassifier.classify(e),
                )
            }
        ) {
            val space = spaceRepository.getSpace(spaceId)
            val agentId = space.executionAgentId ?: space.agentId
            val agent = agentId?.let { spaceRepository.getAgent(it) }
                ?: spaceRepository.getAgents().firstOrNull()
            val cfg = agent?.agentConfig

            val memo = spaceRepository.getApprovalMemo(spaceId)
            val entries = memo.entries?.toList()
                ?.sortedBy { it.first }
                ?: emptyList()

            val orgAllowsYolo = organizationRepository.allowMemberYolo
            _uiState.value = _uiState.value.copy(
                space = space,
                agent = agent,
                orgAllowsYolo = orgAllowsYolo,
                // 组织未开放时强制关闭展示，避免误导用户仍处于 YOLO。
                allowYoloMode = orgAllowsYolo && (cfg?.allowYoloMode ?: false),
                memoEntries = entries,
                approvalMemoGeneration = memo.generation ?: 0,
                isLoading = false,
            )
        }
    }

    public fun setAllowYoloMode(enabled: Boolean) {
        // 组织未开放天花板时忽略开启操作。
        if (enabled && !_uiState.value.orgAllowsYolo) return
        _uiState.value = _uiState.value.copy(allowYoloMode = enabled)
    }

    public fun save() {
        val s = _uiState.value
        val agent = s.agent ?: return
        val agentId = agent.id
        // 组织未开放天花板时不下发（后端也会夹回，客户端先兜一层）。
        if (!s.orgAllowsYolo) return

        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.value = _uiState.value.copy(
                    isSaving = false,
                    errorRes = ErrorClassifier.classify(e),
                )
            }
        ) {
            _uiState.value = s.copy(isSaving = true, errorRes = null)

            // 只发 security 子树（后端 deep_merge 合并进现有 config），不再 copy 整包
            // existingConfig，避免把退役死数据（capabilities.overrides 七分组 / preset）
            // 回写触发 bleed-back（Hilt W4 收尾 · 阶段2 源头收口）。kotlinx encodeDefaults
            // 默认 false → 其余 null 字段不会序列化，不会误抹后端已有子树。
            val updatedConfig = AgentConfig(
                security = AgentSecurityConfig(allowYoloMode = s.allowYoloMode),
            )

            val updatedAgent = spaceRepository.updateAgent(
                agentId,
                com.tabtin.mobile.data.model.UpdateAgentRequest(agentConfig = updatedConfig),
            )
            _uiState.value = _uiState.value.copy(
                agent = updatedAgent,
                isSaving = false,
                saveSuccess = true,
            )
        }
    }

    public fun revokeMemo(key: String) {
        val current = _uiState.value
        viewModelScope.safeLaunch(onError = { error ->
            _uiState.value = _uiState.value.copy(errorRes = ErrorClassifier.classify(error))
        }) {
            val memo = spaceRepository.revokeApprovalMemo(
                spaceId,
                key,
                current.approvalMemoGeneration,
            )
            _uiState.value = _uiState.value.copy(
                memoEntries = memo.entries?.toList()?.sortedBy { it.first } ?: emptyList(),
                approvalMemoGeneration = memo.generation ?: current.approvalMemoGeneration,
            )
        }
    }

    public fun revokeAllMemos() {
        viewModelScope.safeLaunch(onError = { error ->
            _uiState.value = _uiState.value.copy(errorRes = ErrorClassifier.classify(error))
        }) {
            val memo = spaceRepository.revokeAllApprovalMemos(spaceId)
            _uiState.value = _uiState.value.copy(
                memoEntries = memo.entries?.toList()?.sortedBy { it.first } ?: emptyList(),
                approvalMemoGeneration = memo.generation ?: _uiState.value.approvalMemoGeneration,
            )
        }
    }

    public fun clearSaveSuccess() {
        _uiState.value = _uiState.value.copy(saveSuccess = false)
    }

    public fun clearError() {
        _uiState.value = _uiState.value.copy(errorRes = null)
    }
}

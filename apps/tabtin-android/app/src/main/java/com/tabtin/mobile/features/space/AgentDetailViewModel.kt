package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentLocalMcpAttachment
import com.tabtin.mobile.data.model.AgentMemoryRecord
import com.tabtin.mobile.data.model.AgentProjectTask
import com.tabtin.mobile.data.model.AgentSkillLink
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.VisibleSkillEntry
import com.tabtin.mobile.R
import com.tabtin.mobile.data.repository.AgentDetailRepository
import com.tabtin.mobile.data.repository.AgentLocalMcpDeviceOfflineException
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject

public data class AgentDetailUiState(
    val agent: Agent? = null,
    val skills: List<AgentSkillLink> = emptyList(),
    /** Electron 本机已挂载且启用的 MCP（不是组织全量列表）。 */
    val mcpConnections: List<AgentLocalMcpAttachment> = emptyList(),
    /** 电脑离线 / 无可用 Electron / 查询超时。 */
    val mcpDeviceOffline: Boolean = false,
    @StringRes val mcpLoadErrorRes: Int? = null,
    val memories: List<AgentMemoryRecord> = emptyList(),
    val sessions: List<AllChatSession> = emptyList(),
    val projectTasks: List<AgentProjectTask> = emptyList(),
    val isLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val isPartialData: Boolean = false,
    val mutatingSkillKeys: Set<String> = emptySet(),
    val forgettingMemoryIds: Set<String> = emptySet(),
    val correctingMemoryIds: Set<String> = emptySet(),
    val skillPickerCandidates: List<VisibleSkillEntry> = emptyList(),
    val isSkillPickerLoading: Boolean = false,
    @StringRes val loadErrorRes: Int? = null,
    @StringRes val actionErrorRes: Int? = null,
)

/** AI分身移动工作台的详情状态；身份编辑仍经 MyAgentsViewModel，保证列表和详情同步。 */
@HiltViewModel
public class AgentDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repository: AgentDetailRepository,
) : ViewModel() {

    public val agentId: String = savedStateHandle["agentId"] ?: ""

    private val _uiState = MutableStateFlow(AgentDetailUiState())
    public val uiState: StateFlow<AgentDetailUiState> = _uiState.asStateFlow()

    init { load() }

    public fun refresh() { load(isRefresh = true) }

    public fun applyAgent(agent: Agent) {
        _uiState.update { it.copy(agent = agent) }
    }

    public fun clearActionError() {
        _uiState.update { it.copy(actionErrorRes = null) }
    }

    public fun toggleSkill(skill: AgentSkillLink, enabled: Boolean) {
        if (skill.locked || _uiState.value.mutatingSkillKeys.contains(skill.skillCanonicalKey)) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        mutatingSkillKeys = it.mutatingSkillKeys - skill.skillCanonicalKey,
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    mutatingSkillKeys = it.mutatingSkillKeys + skill.skillCanonicalKey,
                    actionErrorRes = null,
                )
            }
            val updated = repository.updateSkill(agentId, skill.skillCanonicalKey, enabled)
            _uiState.update { state ->
                state.copy(
                    skills = state.skills.map {
                        if (it.skillCanonicalKey == updated.skillCanonicalKey) updated else it
                    },
                    mutatingSkillKeys = state.mutatingSkillKeys - skill.skillCanonicalKey,
                )
            }
        }
    }

    public fun loadSkillPicker() {
        val organizationId = _uiState.value.agent?.organizationId.orEmpty()
        if (organizationId.isBlank()) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        isSkillPickerLoading = false,
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update { it.copy(isSkillPickerLoading = true, actionErrorRes = null) }
            val catalog = repository.getVisibleSkills(organizationId)
            _uiState.update {
                it.copy(
                    skillPickerCandidates = catalog,
                    isSkillPickerLoading = false,
                )
            }
        }
    }

    public fun attachSkill(skillKey: String, onAttached: ((AgentSkillLink) -> Unit)? = null) {
        attachSkills(listOf(skillKey)) { attached ->
            attached.firstOrNull()?.let { onAttached?.invoke(it) }
        }
    }

    /** 串行挂载多个技能；部分失败时仍回传已成功项，并在有失败时弹出 actionError。 */
    public fun attachSkills(
        skillKeys: List<String>,
        onAttached: ((List<AgentSkillLink>) -> Unit)? = null,
    ) {
        val keys = skillKeys.map { it.trim() }.filter { it.isNotBlank() }.distinct()
        if (keys.isEmpty()) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        mutatingSkillKeys = it.mutatingSkillKeys - keys.toSet(),
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
                // 外层异常也要回调，避免 Sheet 提交态卡住。
                onAttached?.invoke(emptyList())
            },
        ) {
            _uiState.update {
                it.copy(mutatingSkillKeys = it.mutatingSkillKeys + keys, actionErrorRes = null)
            }
            val attached = mutableListOf<AgentSkillLink>()
            var lastError: Throwable? = null
            for (key in keys) {
                try {
                    val link = repository.attachSkill(agentId, key)
                    attached += link
                    _uiState.update { state ->
                        val withoutDup = state.skills.filterNot {
                            it.skillCanonicalKey == link.skillCanonicalKey
                        }
                        state.copy(
                            skills = withoutDup + link,
                            mutatingSkillKeys = state.mutatingSkillKeys - key,
                        )
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    lastError = error
                    _uiState.update { state ->
                        state.copy(mutatingSkillKeys = state.mutatingSkillKeys - key)
                    }
                }
            }
            onAttached?.invoke(attached.toList())
            if (lastError != null) {
                val classified = (lastError as? Exception)?.let(ErrorClassifier::classify)
                    ?: R.string.error_unknown
                _uiState.update { it.copy(actionErrorRes = classified) }
            }
        }
    }

    public fun removeSkill(skill: AgentSkillLink) {
        if (skill.locked || _uiState.value.mutatingSkillKeys.contains(skill.skillCanonicalKey)) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        mutatingSkillKeys = it.mutatingSkillKeys - skill.skillCanonicalKey,
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    mutatingSkillKeys = it.mutatingSkillKeys + skill.skillCanonicalKey,
                    actionErrorRes = null,
                )
            }
            repository.removeSkill(agentId, skill.skillCanonicalKey)
            _uiState.update { state ->
                state.copy(
                    skills = state.skills.filterNot { it.skillCanonicalKey == skill.skillCanonicalKey },
                    mutatingSkillKeys = state.mutatingSkillKeys - skill.skillCanonicalKey,
                )
            }
        }
    }

    public fun forgetMemory(memory: AgentMemoryRecord) {
        val organizationId = _uiState.value.agent?.organizationId.orEmpty()
        if (organizationId.isBlank() || _uiState.value.forgettingMemoryIds.contains(memory.id)) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        forgettingMemoryIds = it.forgettingMemoryIds - memory.id,
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(forgettingMemoryIds = it.forgettingMemoryIds + memory.id, actionErrorRes = null)
            }
            repository.forgetMemory(organizationId, agentId, memory.id)
            _uiState.update { state ->
                state.copy(
                    memories = state.memories.filterNot { it.id == memory.id },
                    forgettingMemoryIds = state.forgettingMemoryIds - memory.id,
                )
            }
        }
    }

    public fun correctMemory(memory: AgentMemoryRecord, content: String, onCorrected: (() -> Unit)? = null) {
        val organizationId = _uiState.value.agent?.organizationId.orEmpty()
        val trimmed = content.trim()
        if (
            organizationId.isBlank() ||
            trimmed.isBlank() ||
            trimmed == memory.content ||
            _uiState.value.correctingMemoryIds.contains(memory.id)
        ) return
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        correctingMemoryIds = it.correctingMemoryIds - memory.id,
                        actionErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(correctingMemoryIds = it.correctingMemoryIds + memory.id, actionErrorRes = null)
            }
            val replacement = repository.correctMemory(organizationId, agentId, memory, trimmed)
            _uiState.update { state ->
                state.copy(
                    memories = state.memories.map { if (it.id == memory.id) replacement else it },
                    correctingMemoryIds = state.correctingMemoryIds - memory.id,
                )
            }
            onCorrected?.invoke()
        }
    }

    private fun load(isRefresh: Boolean = false) {
        if (agentId.isBlank()) {
            _uiState.update { it.copy(isLoading = false) }
            return
        }
        viewModelScope.safeLaunch(
            onError = { error ->
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        loadErrorRes = ErrorClassifier.classify(error),
                    )
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    isLoading = !isRefresh && it.agent == null,
                    isRefreshing = isRefresh,
                    loadErrorRes = null,
                    mcpDeviceOffline = false,
                    mcpLoadErrorRes = null,
                )
            }
            val agent = repository.getAgent(agentId)
            val auxiliary = coroutineScope {
                val skills = async { partial { repository.getSkills(agentId) } }
                val mcp = async { loadMcpAttachments() }
                val memories = async { partial { repository.getMemories(agent.organizationId, agentId) } }
                val sessions = async { partial { repository.getSessions(agent.organizationId, agentId) } }
                val tasks = async { partial { repository.getProjectTasks(agent.organizationId, agentId) } }
                AgentDetailAuxiliary(
                    skills = skills.await(),
                    mcp = mcp.await(),
                    memories = memories.await(),
                    sessions = sessions.await(),
                    tasks = tasks.await(),
                )
            }
            _uiState.update {
                it.copy(
                    agent = agent,
                    skills = auxiliary.skills ?: emptyList(),
                    mcpConnections = auxiliary.mcp.connections,
                    mcpDeviceOffline = auxiliary.mcp.deviceOffline,
                    mcpLoadErrorRes = auxiliary.mcp.errorRes,
                    memories = auxiliary.memories ?: emptyList(),
                    sessions = auxiliary.sessions ?: emptyList(),
                    projectTasks = auxiliary.tasks ?: emptyList(),
                    isPartialData = auxiliary.hasFailure,
                    isLoading = false,
                    isRefreshing = false,
                )
            }
        }
    }

    private suspend fun loadMcpAttachments(): McpAttachmentsLoad =
        try {
            McpAttachmentsLoad(connections = repository.getAgentLocalMcpAttachments(agentId))
        } catch (error: CancellationException) {
            throw error
        } catch (error: AgentLocalMcpDeviceOfflineException) {
            McpAttachmentsLoad(deviceOffline = true)
        } catch (_: Exception) {
            McpAttachmentsLoad(errorRes = R.string.error_unknown)
        }

    private suspend fun <T> partial(block: suspend () -> T): T? = try {
        block()
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        null
    }
}

private data class McpAttachmentsLoad(
    val connections: List<AgentLocalMcpAttachment> = emptyList(),
    val deviceOffline: Boolean = false,
    @StringRes val errorRes: Int? = null,
) {
    val failed: Boolean
        get() = deviceOffline || errorRes != null
}

private data class AgentDetailAuxiliary(
    val skills: List<AgentSkillLink>?,
    val mcp: McpAttachmentsLoad,
    val memories: List<AgentMemoryRecord>?,
    val sessions: List<AllChatSession>?,
    val tasks: List<AgentProjectTask>?,
) {
    val hasFailure: Boolean
        get() = skills == null || mcp.failed || memories == null ||
            sessions == null || tasks == null
}

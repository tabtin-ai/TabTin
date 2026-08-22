package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.UpdateWorkspaceRequest
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject

internal enum class EditField { BASIC_INFO, RULES, WORK_TYPE }

internal data class SpaceSettingsUiState(
    val space: Space? = null,
    val agent: Agent? = null,
    /** 组织准入天花板：组织未开放时安全摘要不显示 YOLO。 */
    val orgAllowsYolo: Boolean = false,
    val isLoading: Boolean = true,
    val isSaving: Boolean = false,
    val isDeleting: Boolean = false,
    val deleteInputValue: String = "",
    val showDeleteConfirm: Boolean = false,
    val editingField: EditField? = null,
    val editName: String = "",
    val editText: String = "",
    /** 当前编辑中的 work_type 选择值（code/doc/mixed/""）。 */
    val editWorkType: String = "",
    val actionDone: Boolean = false,
    @StringRes val errorRes: Int? = null,
    @StringRes val toastRes: Int? = null,
) {
    val rulesPreview: String
        get() {
            val text = space?.customRules ?: return ""
            val first = text.lines().firstOrNull()?.trim() ?: return ""
            return if (first.length > 15) first.take(15) + "…" else first
        }

    val securityLabel: String
        get() = if (orgAllowsYolo && agent?.agentConfig?.security?.allowYoloMode == true) "YOLO" else ""

    val executionLimitsSummary: String
        get() {
            val limits = space?.executionLimits ?: return ""
            val parts = mutableListOf<String>()
            limits.maxIterationsPerRun?.let { parts.add("$it") }
            limits.maxCreditsPerRun?.let { parts.add(it) }
            return parts.joinToString(" / ")
        }

    /** 设置页右侧摘要用的 work_type 标签资源；未设置返回 null（不显示）。 */
    @get:StringRes
    val workTypeLabelRes: Int?
        get() = when (space?.workingDirType) {
            "code" -> R.string.work_type_code
            "doc" -> R.string.work_type_doc
            "mixed" -> R.string.work_type_mixed
            else -> null
        }

    /** 门控：working_dir 非空才允许编辑 work_type。 */
    val hasWorkingDir: Boolean get() = !space?.workingDir.isNullOrEmpty()

    val canDelete: Boolean get() = space?.isDefault != true
}

@HiltViewModel
public class SpaceSettingsViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val spaceRepository: SpaceRepository,
    private val organizationRepository: OrganizationRepository,
) : ViewModel() {

    public val spaceId: String = savedStateHandle["spaceId"] ?: ""

    private val _uiState = MutableStateFlow(SpaceSettingsUiState())
    internal val uiState: StateFlow<SpaceSettingsUiState> = _uiState.asStateFlow()

    init { load() }

    public fun load() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(isLoading = false, errorRes = ErrorClassifier.classify(e)) }
            }
        ) {
            _uiState.update { it.copy(isLoading = true, errorRes = null) }
            val space = spaceRepository.getWorkspace(spaceId)
            val agentId = space.executionAgentId ?: space.agentId
            val agent = agentId?.let { spaceRepository.getAgent(it) }
                ?: spaceRepository.getAgents().firstOrNull()
            _uiState.update {
                it.copy(
                    space = space,
                    agent = agent,
                    orgAllowsYolo = organizationRepository.allowMemberYolo,
                    isLoading = false,
                )
            }
        }
    }

    public fun refreshAgent() {
        viewModelScope.safeLaunch {
            val state = _uiState.value
            val agentId = state.agent?.id
                ?: state.space?.executionAgentId
                ?: state.space?.agentId
            val agent = agentId?.let { spaceRepository.getAgent(it) }
                ?: spaceRepository.getAgents().firstOrNull()
            _uiState.update { it.copy(agent = agent) }
        }
    }

    public fun clearError() { _uiState.update { it.copy(errorRes = null) } }

    public fun startEditBasicInfo() {
        _uiState.update {
            it.copy(
                editingField = EditField.BASIC_INFO,
                editName = it.space?.name ?: "",
            )
        }
    }

    public fun startEditRules() {
        _uiState.update {
            it.copy(editingField = EditField.RULES, editText = it.space?.customRules ?: "")
        }
    }

    public fun startEditWorkType() {
        _uiState.update {
            it.copy(
                editingField = EditField.WORK_TYPE,
                editWorkType = it.space?.workingDirType.orEmpty(),
            )
        }
    }

    public fun setEditName(v: String) { _uiState.update { it.copy(editName = v) } }
    public fun setEditText(v: String) { _uiState.update { it.copy(editText = v) } }
    public fun setEditWorkType(v: String) { _uiState.update { it.copy(editWorkType = v) } }
    public fun dismissEdit() { _uiState.update { it.copy(editingField = null) } }
    public fun consumeToast() { _uiState.update { it.copy(toastRes = null) } }

    public fun saveEdit() {
        val field = _uiState.value.editingField ?: return
        viewModelScope.safeLaunch(
            onError = {
                _uiState.update { it.copy(isSaving = false, toastRes = R.string.space_settings_save_failed) }
            }
        ) {
            _uiState.update { it.copy(isSaving = true) }
            when (field) {
                EditField.BASIC_INFO -> {
                    val name = _uiState.value.editName.trim()
                    if (name.isNotEmpty()) {
                        val currentSpace = _uiState.value.space
                        val updated = if (currentSpace?.isWorkspaceRecord == true) {
                            spaceRepository.updateWorkspace(
                                spaceId,
                                UpdateWorkspaceRequest(name = name),
                            )
                        } else {
                            spaceRepository.updateSpace(spaceId, name = name)
                        }
                        _uiState.update { it.copy(space = updated) }
                    }
                }
                EditField.RULES -> {
                    val text = _uiState.value.editText.trim()
                    val updated = spaceRepository.updateWorkspace(
                        spaceId,
                        UpdateWorkspaceRequest(customRules = text),
                    )
                    _uiState.update { it.copy(space = updated) }
                }
                EditField.WORK_TYPE -> {
                    val type = _uiState.value.editWorkType
                    val space = _uiState.value.space
                    if (
                        space == null
                        || space.type != "workspace"
                        || space.workingDir.isEmpty()
                        || type.isEmpty()
                    ) {
                        _uiState.update { it.copy(isSaving = false, editingField = null) }
                        return@safeLaunch
                    }
                    val updated = spaceRepository.updateWorkspace(
                        spaceId,
                        UpdateWorkspaceRequest(workingDirType = type),
                    )
                    _uiState.update { it.copy(space = updated) }
                }
            }
            _uiState.update {
                it.copy(isSaving = false, editingField = null, toastRes = R.string.space_settings_save_success)
            }
        }
    }

    public fun showDeleteConfirm() { _uiState.update { it.copy(showDeleteConfirm = true, deleteInputValue = "") } }
    public fun dismissDeleteConfirm() { _uiState.update { it.copy(showDeleteConfirm = false, deleteInputValue = "") } }
    public fun setDeleteInput(value: String) { _uiState.update { it.copy(deleteInputValue = value) } }

    public fun deleteSpace() {
        val space = _uiState.value.space ?: return
        if (_uiState.value.deleteInputValue.trim() != space.name) return
        viewModelScope.safeLaunch(
            onError = { e -> _uiState.update { it.copy(isDeleting = false, errorRes = ErrorClassifier.classify(e)) } }
        ) {
            _uiState.update { it.copy(isDeleting = true) }
            spaceRepository.deleteSpace(spaceId)
            _uiState.update { it.copy(isDeleting = false, showDeleteConfirm = false, actionDone = true) }
        }
    }
}

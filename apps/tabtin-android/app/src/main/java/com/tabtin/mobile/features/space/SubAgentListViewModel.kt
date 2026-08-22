package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.SubAgentTemplate
import com.tabtin.mobile.data.model.SubAgentTemplateCreate
import com.tabtin.mobile.data.model.SubAgentTemplateUpdate
import com.tabtin.mobile.data.repository.SubAgentRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject

public data class SubAgentListUiState(
    val templates: List<SubAgentTemplate> = emptyList(),
    val isLoading: Boolean = true,
    val showCreateSheet: Boolean = false,
    val editingTemplate: SubAgentTemplate? = null,
    val deleteTarget: SubAgentTemplate? = null,
    @StringRes val loadErrorRes: Int? = null,
    @StringRes val actionErrorRes: Int? = null,
)

public data class SubAgentEditState(
    val name: String = "",
    val description: String = "",
    val icon: String = "🤖",
    val systemPrompt: String = "",
    val subagentType: String = "execute",
    val defaultMode: String = "wait",
    val thinkingLevel: String = "",
    val isEnabled: Boolean = true,
    val isSaving: Boolean = false,
    @StringRes val errorRes: Int? = null,
) {
    val canSave: Boolean get() = name.trim().isNotBlank() && !isSaving
}

@HiltViewModel
public class SubAgentListViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val subAgentRepository: SubAgentRepository,
) : ViewModel() {

    public val spaceId: String = savedStateHandle["spaceId"] ?: ""

    private val _uiState = MutableStateFlow(SubAgentListUiState())
    public val uiState: StateFlow<SubAgentListUiState> = _uiState.asStateFlow()

    private val _editState = MutableStateFlow(SubAgentEditState())
    public val editState: StateFlow<SubAgentEditState> = _editState.asStateFlow()

    init { loadTemplates() }

    public fun loadTemplates() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(isLoading = false, loadErrorRes = ErrorClassifier.classify(e)) }
            }
        ) {
            _uiState.update { it.copy(isLoading = it.templates.isEmpty(), loadErrorRes = null) }
            val templates = subAgentRepository.getTemplates(spaceId)
            _uiState.update { it.copy(templates = templates, isLoading = false) }
        }
    }

    public fun showCreate() {
        _editState.value = SubAgentEditState()
        _uiState.update { it.copy(showCreateSheet = true, editingTemplate = null) }
    }

    public fun showEdit(template: SubAgentTemplate) {
        _editState.value = SubAgentEditState(
            name = template.name,
            description = template.description,
            icon = template.icon.ifEmpty { "🤖" },
            systemPrompt = template.systemPrompt,
            subagentType = template.subagentType,
            defaultMode = template.defaultMode,
            thinkingLevel = template.thinkingLevel ?: "",
            isEnabled = template.isEnabled,
        )
        _uiState.update { it.copy(editingTemplate = template, showCreateSheet = false) }
    }

    public fun dismissEdit() {
        _uiState.update { it.copy(showCreateSheet = false, editingTemplate = null) }
        _editState.value = SubAgentEditState()
    }

    public fun showDeleteConfirm(template: SubAgentTemplate) {
        _uiState.update { it.copy(deleteTarget = template) }
    }

    public fun dismissDeleteConfirm() {
        _uiState.update { it.copy(deleteTarget = null) }
    }

    public fun setName(v: String) { _editState.update { it.copy(name = v) } }
    public fun setDescription(v: String) { _editState.update { it.copy(description = v) } }
    public fun setIcon(v: String) { _editState.update { it.copy(icon = v) } }
    public fun setSystemPrompt(v: String) { _editState.update { it.copy(systemPrompt = v) } }
    public fun setSubagentType(v: String) { _editState.update { it.copy(subagentType = v) } }
    public fun setDefaultMode(v: String) { _editState.update { it.copy(defaultMode = v) } }
    public fun setThinkingLevel(v: String) { _editState.update { it.copy(thinkingLevel = v) } }
    public fun setIsEnabled(v: Boolean) { _editState.update { it.copy(isEnabled = v) } }

    public fun toggleTemplate(template: SubAgentTemplate, enabled: Boolean) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(actionErrorRes = ErrorClassifier.classify(e)) }
                loadTemplates()
            }
        ) {
            val updated = subAgentRepository.toggleTemplate(spaceId, template.id, enabled)
            _uiState.update { state ->
                state.copy(
                    templates = state.templates.map { if (it.id == template.id) updated else it },
                )
            }
        }
    }

    public fun deleteTemplate() {
        val target = _uiState.value.deleteTarget ?: return
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(deleteTarget = null, actionErrorRes = ErrorClassifier.classify(e)) }
            }
        ) {
            subAgentRepository.deleteTemplate(spaceId, target.id)
            _uiState.update { state ->
                state.copy(
                    templates = state.templates.filter { it.id != target.id },
                    deleteTarget = null,
                )
            }
        }
    }

    public fun saveTemplate() {
        val es = _editState.value
        val editing = _uiState.value.editingTemplate

        viewModelScope.safeLaunch(
            onError = { e ->
                _editState.update { it.copy(isSaving = false, errorRes = ErrorClassifier.classify(e)) }
            }
        ) {
            _editState.update { it.copy(isSaving = true, errorRes = null) }

            if (editing == null) {
                subAgentRepository.createTemplate(
                    spaceId,
                    SubAgentTemplateCreate(
                        name = es.name.trim(),
                        description = es.description.trim(),
                        icon = es.icon,
                        systemPrompt = es.systemPrompt.trim(),
                        subagentType = es.subagentType,
                        defaultMode = es.defaultMode,
                        thinkingLevel = es.thinkingLevel,
                        isEnabled = es.isEnabled,
                    ),
                )
            } else {
                subAgentRepository.updateTemplate(
                    spaceId,
                    editing.id,
                    SubAgentTemplateUpdate(
                        name = es.name.trim(),
                        description = es.description.trim(),
                        icon = es.icon,
                        systemPrompt = es.systemPrompt.trim(),
                        subagentType = es.subagentType,
                        defaultMode = es.defaultMode,
                        thinkingLevel = es.thinkingLevel,
                        isEnabled = es.isEnabled,
                        modelId = editing.modelId,
                        appId = editing.appId,
                        allowedTools = editing.allowedTools,
                        deniedTools = editing.deniedTools,
                        order = editing.order,
                    ),
                )
            }

            _editState.value = SubAgentEditState()
            _uiState.update { it.copy(showCreateSheet = false, editingTemplate = null) }
            loadTemplates()
        }
    }

    public fun clearActionError() {
        _uiState.update { it.copy(actionErrorRes = null) }
    }
}

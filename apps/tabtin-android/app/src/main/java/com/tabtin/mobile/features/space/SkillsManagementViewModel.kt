package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.SkillConfig
import com.tabtin.mobile.data.model.SkillReadiness
import com.tabtin.mobile.data.model.SpaceSkill
import com.tabtin.mobile.data.repository.SkillsRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject

public data class SkillsManagementUiState(
    val skills: List<SpaceSkill> = emptyList(),
    val configs: Map<String, SkillConfig> = emptyMap(),
    val isLoading: Boolean = true,
    val togglingIds: Set<String> = emptySet(),
    val selectedSkill: SpaceSkill? = null,
    val configApiKey: String = "",
    @StringRes val loadErrorRes: Int? = null,
    @StringRes val actionErrorRes: Int? = null,
) {
    val sortedSkills: List<SpaceSkill>
        get() = skills.sortedBy { it.computeReadiness(configs[it.skillKey ?: ""]).sortOrder }

    public fun readinessCounts(): Map<SkillReadiness, Int> =
        SkillReadiness.entries.associateWith { readiness ->
            skills.count { it.computeReadiness(configs[it.skillKey ?: ""]) == readiness }
        }
}

@HiltViewModel
public class SkillsManagementViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val skillsRepository: SkillsRepository,
) : ViewModel() {

    public val spaceId: String = savedStateHandle["spaceId"] ?: ""

    private val _uiState = MutableStateFlow(SkillsManagementUiState())
    public val uiState: StateFlow<SkillsManagementUiState> = _uiState.asStateFlow()

    init { loadSkills() }

    public fun loadSkills(forceRefresh: Boolean = false) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(
                    isLoading = false,
                    loadErrorRes = ErrorClassifier.classify(e),
                ) }
            }
        ) {
            _uiState.update { it.copy(isLoading = it.skills.isEmpty(), loadErrorRes = null) }
            val (skills, configs) = skillsRepository.getSkills(spaceId, forceRefresh)
            _uiState.update { it.copy(skills = skills, configs = configs, isLoading = false) }
        }
    }

    public fun toggleSkill(skill: SpaceSkill, enabled: Boolean) {
        val id = skill.resolvedId
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(
                    togglingIds = it.togglingIds - id,
                    actionErrorRes = ErrorClassifier.classify(e),
                ) }
            }
        ) {
            _uiState.update { it.copy(togglingIds = it.togglingIds + id, actionErrorRes = null) }
            val updatedConfigs = skillsRepository.toggleSkill(spaceId, skill, enabled, _uiState.value.configs)
            _uiState.update { it.copy(
                configs = updatedConfigs,
                togglingIds = it.togglingIds - id,
            ) }
        }
    }

    public fun selectSkill(skill: SpaceSkill) {
        _uiState.update { it.copy(
            selectedSkill = skill,
            configApiKey = it.configs[skill.skillKey ?: ""]?.apiKey ?: "",
        ) }
    }

    public fun dismissSkillConfig() {
        _uiState.update { it.copy(selectedSkill = null, configApiKey = "") }
    }

    public fun setConfigApiKey(value: String) {
        _uiState.update { it.copy(configApiKey = value) }
    }

    public fun saveConfig() {
        val skill = _uiState.value.selectedSkill ?: return
        val skillKey = skill.skillKey ?: return
        val apiKey = _uiState.value.configApiKey

        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(actionErrorRes = ErrorClassifier.classify(e)) }
            }
        ) {
            skillsRepository.saveApiKey(spaceId, skillKey, apiKey)
            val configs = _uiState.value.configs.toMutableMap()
            val existing = configs[skillKey] ?: SkillConfig()
            configs[skillKey] = existing.copy(apiKey = apiKey)
            _uiState.update { it.copy(
                configs = configs,
                selectedSkill = null,
                configApiKey = "",
            ) }
        }
    }

    public fun clearActionError() {
        _uiState.update { it.copy(actionErrorRes = null) }
    }
}

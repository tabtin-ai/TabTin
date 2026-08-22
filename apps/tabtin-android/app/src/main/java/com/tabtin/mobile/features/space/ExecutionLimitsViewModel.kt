package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ExecutionLimits
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.UpdateWorkspaceRequest
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject

public data class ExecutionLimitsUiState(
    val space: Space? = null,
    val maxIterationsText: String = "",
    val maxCreditsText: String = "",
    val isLoading: Boolean = true,
    val isSaving: Boolean = false,
    val saveSuccess: Boolean = false,
    @StringRes val errorRes: Int? = null,
) {
    val isDirty: Boolean
        get() {
            if (space == null) return false
            val limits = space.executionLimits
            val savedIter = limits?.maxIterationsPerRun
            val savedCred = limits?.maxCreditsPerRun

            val currentIter = maxIterationsText.trim().let {
                if (it.isEmpty()) null else it.toIntOrNull()
            }
            val currentCred = maxCreditsText.trim().let {
                if (it.isEmpty()) null else it
            }

            return savedIter != currentIter || savedCred != currentCred
        }
}

@HiltViewModel
public class ExecutionLimitsViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val spaceRepository: SpaceRepository,
) : ViewModel() {

    public val spaceId: String = savedStateHandle["spaceId"] ?: ""

    private val _uiState = MutableStateFlow(ExecutionLimitsUiState())
    public val uiState: StateFlow<ExecutionLimitsUiState> = _uiState.asStateFlow()

    init { load() }

    private fun load() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    errorRes = ErrorClassifier.classify(e),
                )
            }
        ) {
            _uiState.value = _uiState.value.copy(isLoading = true, errorRes = null)
            val space = spaceRepository.getWorkspace(spaceId)
            val limits = space.executionLimits
            _uiState.value = _uiState.value.copy(
                space = space,
                maxIterationsText = limits?.maxIterationsPerRun?.toString() ?: "",
                maxCreditsText = limits?.maxCreditsPerRun ?: "",
                isLoading = false,
            )
        }
    }

    public fun setMaxIterations(value: String) {
        _uiState.value = _uiState.value.copy(maxIterationsText = value, saveSuccess = false)
    }

    public fun setMaxCredits(value: String) {
        _uiState.value = _uiState.value.copy(maxCreditsText = value, saveSuccess = false)
    }

    public fun clearError() {
        _uiState.value = _uiState.value.copy(errorRes = null)
    }

    public fun clearSaveSuccess() {
        _uiState.value = _uiState.value.copy(saveSuccess = false)
    }

    public fun save() {
        val s = _uiState.value
        if (s.space == null) return

        val iterText = s.maxIterationsText.trim()
        val credText = s.maxCreditsText.trim()

        val iterValue = if (iterText.isEmpty()) null else iterText.toIntOrNull()
        val credValue = if (credText.isEmpty()) null else credText

        if (iterText.isNotEmpty() && (iterValue == null || iterValue < 1)) {
            _uiState.value = s.copy(errorRes = R.string.space_settings_save_failed)
            return
        }
        if (credValue != null) {
            val credNum = credValue.toDoubleOrNull()
            if (credNum == null || credNum <= 0) {
                _uiState.value = s.copy(errorRes = R.string.space_settings_save_failed)
                return
            }
        }

        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.value = _uiState.value.copy(
                    isSaving = false,
                    errorRes = ErrorClassifier.classify(e),
                )
            }
        ) {
            _uiState.value = s.copy(isSaving = true, errorRes = null)

            val updatedSpace = spaceRepository.updateWorkspace(
                spaceId,
                UpdateWorkspaceRequest(
                    executionLimits = ExecutionLimits(
                        maxIterationsPerRun = iterValue,
                        maxCreditsPerRun = credValue,
                    ),
                ),
            )
            _uiState.value = _uiState.value.copy(
                space = updatedSpace,
                isSaving = false,
                saveSuccess = true,
            )
        }
    }
}

package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.api.TabMemoApi
import com.tabtin.mobile.data.model.memo.RecordStyleUpdateRequest
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

/**
 * Memory Settings UiState —— 记忆记录偏好按 (user, organization) 生效。
 *
 * ``enabled`` 的服务端权威是 TabMemo ``MemoRecordStyle.enabled``。它决定当前
 * Organization 在所有设备上是否可以沉淀、召回记忆与生成用户画像；不能再从已
 * 退役的 ``agent_config.memory.enabled`` 推导或回写。
 */
public data class MemorySettingsUiState(
    val organizationId: String = "",
    /**
     * 当前 Organization 显示名 —— 由 OrganizationRepository.organizations 缓存查到 (按 organizationId)。
     * UserPortraitPanel 状态栏在画像 markdown 上方显示 "上次蒸馏 X 天前 · Organization <name>"。
     * 缓存里找不到（首次启动 / 列表未加载）时为 null，UserPortraitPanel 走 noName 兜底。
     */
    val organizationName: String? = null,
    val enabled: Boolean = true,
    /** 上次从服务端成功读取/保存的值；null 表示尚不能保存。 */
    val savedEnabled: Boolean? = null,
    val isLoading: Boolean = true,
    val isSaving: Boolean = false,
    val saveSuccess: Boolean = false,
    @StringRes val errorRes: Int? = null,
) {
    public val isDirty: Boolean
        get() = !isLoading && savedEnabled?.let { enabled != it } == true
}

@HiltViewModel
public class MemorySettingsViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val spaceRepository: SpaceRepository,
    private val organizationRepository: OrganizationRepository,
    private val tabMemoApi: TabMemoApi,
) : ViewModel() {

    public val spaceId: String = savedStateHandle["spaceId"] ?: ""

    private val _uiState = MutableStateFlow(MemorySettingsUiState())
    public val uiState: StateFlow<MemorySettingsUiState> = _uiState.asStateFlow()

    init { load() }

    private fun load() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(isLoading = false, errorRes = ErrorClassifier.classify(e)) }
            },
        ) {
            val space = spaceRepository.getSpace(spaceId)
            val recordStyle = tabMemoApi.getRecordStyle(space.organizationId).unwrap()
            // OrganizationRepository.organizations 是 App 启动时已 loadOrganizations() 的缓存 StateFlow,
            // 当前内存有列表就用；缓存里查不到（首次启动竞态）就 null,
            // UserPortraitPanel 状态栏走 noName 兜底（spec §6.2 / 6.3 描述的"组织 X"占位）。
            val organizationName = organizationRepository.organizations.value
                .firstOrNull { it.id == space.organizationId }?.name
            _uiState.update {
                it.copy(
                    organizationId = space.organizationId,
                    organizationName = organizationName,
                    enabled = recordStyle.enabled,
                    savedEnabled = recordStyle.enabled,
                    isLoading = false,
                )
            }
        }
    }

    public fun setEnabled(v: Boolean) { _uiState.update { it.copy(enabled = v) } }

    public fun save() {
        val s = _uiState.value
        if (s.organizationId.isBlank() || !s.isDirty) return

        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(isSaving = false, errorRes = ErrorClassifier.classify(e)) }
            },
        ) {
            _uiState.update { it.copy(isSaving = true, errorRes = null) }

            val updated = tabMemoApi.updateRecordStyle(
                s.organizationId,
                RecordStyleUpdateRequest(enabled = s.enabled),
            ).unwrap()
            _uiState.update {
                it.copy(
                    enabled = updated.enabled,
                    savedEnabled = updated.enabled,
                    isSaving = false,
                    saveSuccess = true,
                )
            }
        }
    }

    public fun clearSaveSuccess() {
        _uiState.update { it.copy(saveSuccess = false) }
    }

    public fun clearError() {
        _uiState.update { it.copy(errorRes = null) }
    }
}

package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.repository.SpaceResourceRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

internal enum class SpaceContentTab(@StringRes public val labelRes: Int) {
    DOCUMENTS(R.string.space_tab_documents),
    TABLES(R.string.space_tab_tables),
    SLIDES(R.string.space_tab_slides),
    SITES(R.string.space_tab_sites),
    ;

    public val resourceType: String
        get() = when (this) {
            DOCUMENTS -> "tabdoc"
            TABLES -> "tabdata"
            SLIDES -> "tabslide"
            SITES -> "tabsite"
        }
}

internal data class SpaceTabUiState(
    val spaces: List<Space> = emptyList(),
    val selectedSpaceId: String? = null,
    val selectedTab: SpaceContentTab = SpaceContentTab.DOCUMENTS,
    val resources: List<SpaceResource> = emptyList(),
    val isLoadingSpaces: Boolean = false,
    val isLoadingResources: Boolean = false,
    val isRefreshing: Boolean = false,
    val isCreatingDoc: Boolean = false,
    val createDocumentQuotaExceeded: AppError.DocumentQuotaExceeded? = null,
    val hasOrganization: Boolean = true,
    @StringRes val errorRes: Int? = null,
) {
    val selectedSpace: Space?
        get() = spaces.firstOrNull { it.id == selectedSpaceId }

    val filteredResources: List<SpaceResource>
        get() = resources.filter { it.normalizedType == selectedTab.resourceType }
}

@HiltViewModel
public class SpaceTabViewModel @Inject constructor(
    private val spaceRepository: SpaceRepository,
    private val spaceResourceRepository: SpaceResourceRepository,
    private val docRepository: DocRepository,
    private val organizationRepository: OrganizationRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(SpaceTabUiState())
    internal val uiState: StateFlow<SpaceTabUiState> = _uiState.asStateFlow()

    private val _navigateToDoc = MutableSharedFlow<String>(extraBufferCapacity = 1)
    public val navigateToDoc: SharedFlow<String> = _navigateToDoc.asSharedFlow()

    private val _toastRes = MutableSharedFlow<Int>(extraBufferCapacity = 1)
    public val toastRes: SharedFlow<Int> = _toastRes.asSharedFlow()

    init {
        loadInitial()
        observeOrganizationChanges()
    }

    private fun observeOrganizationChanges() {
        viewModelScope.launch {
            organizationRepository.selectedOrganization
                .filterNotNull()
                .map { it.id }
                .distinctUntilChanged()
                .collect {
                    _uiState.update { it.copy(hasOrganization = true) }
                    loadInitial()
                }
        }
    }

    private fun loadInitial() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(
                        errorRes = ErrorClassifier.classify(e),
                        isLoadingSpaces = false,
                        isLoadingResources = false,
                        isRefreshing = false,
                    )
                }
            }
        ) {
            _uiState.update { it.copy(isLoadingSpaces = it.spaces.isEmpty(), errorRes = null) }

            val spaces = spaceRepository.getSpaces()
            val currentSelected = _uiState.value.selectedSpaceId
            val newSelectedId = when {
                spaces.isEmpty() -> null
                currentSelected != null && spaces.any { it.id == currentSelected } -> currentSelected
                else -> spaces.first().id
            }

            _uiState.update {
                it.copy(
                    spaces = spaces,
                    selectedSpaceId = newSelectedId,
                    isLoadingSpaces = false,
                    isRefreshing = false,
                )
            }

            if (newSelectedId != null) {
                loadResources(newSelectedId)
            }
        }
    }

    public fun selectSpace(spaceId: String) {
        if (spaceId == _uiState.value.selectedSpaceId) return
        _uiState.update { it.copy(selectedSpaceId = spaceId, resources = emptyList()) }
        loadResources(spaceId)
    }

    internal fun selectTab(tab: SpaceContentTab) {
        _uiState.update { it.copy(selectedTab = tab) }
    }

    public fun refresh() {
        _uiState.update { it.copy(isRefreshing = true) }
        loadInitial()
    }

    public fun createDocument() {
        val spaceId = _uiState.value.selectedSpaceId ?: return
        viewModelScope.safeLaunch(
            onError = { error ->
                val quotaExceeded = error as? AppError.DocumentQuotaExceeded
                _uiState.update {
                    it.copy(
                        isCreatingDoc = false,
                        createDocumentQuotaExceeded = quotaExceeded,
                    )
                }
                if (quotaExceeded == null) {
                    _toastRes.tryEmit(R.string.space_tab_create_doc_failed)
                }
            }
        ) {
            _uiState.update { it.copy(isCreatingDoc = true, createDocumentQuotaExceeded = null) }
            try {
                val detail = docRepository.createDocument(title = "")
                _navigateToDoc.tryEmit(detail.document.id)
                loadResources(spaceId)
            } finally {
                _uiState.update { it.copy(isCreatingDoc = false) }
            }
        }
    }

    public fun dismissCreateDocumentQuotaExceeded() {
        _uiState.update { it.copy(createDocumentQuotaExceeded = null) }
    }

    private fun loadResources(spaceId: String) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update {
                    it.copy(
                        errorRes = ErrorClassifier.classify(e),
                        isLoadingResources = false,
                    )
                }
            }
        ) {
            _uiState.update { it.copy(isLoadingResources = true, errorRes = null) }
            val items = spaceResourceRepository.getResources(spaceId)
            if (_uiState.value.selectedSpaceId == spaceId) {
                _uiState.update { it.copy(resources = items, isLoadingResources = false) }
            }
        }
    }
}

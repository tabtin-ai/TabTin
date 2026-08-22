package com.tabtin.mobile.features.workspace

import android.content.ContentResolver
import android.net.Uri
import android.util.Log
import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.UploadScope
import com.tabtin.mobile.data.api.resolveEffectiveWebBaseUrl
import com.tabtin.mobile.data.model.PendingInvitation
import com.tabtin.mobile.data.model.SearchUserItem
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.ModelsResponse
import com.tabtin.mobile.data.model.LlmProvider
import com.tabtin.mobile.data.model.OrganizationInvitation
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import com.tabtin.mobile.data.model.OrganizationSettings
import com.tabtin.mobile.data.repository.LlmRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.TokenManager
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import javax.inject.Inject

internal fun invitationLink(webBaseUrl: String, token: String): String {
    val base = webBaseUrl.trim().trimEnd('/')
    val encodedToken = URLEncoder.encode(token.trim(), StandardCharsets.UTF_8)
        .replace("+", "%20")
    return "$base/invite/$encodedToken"
}

internal sealed interface WsToast {
    @get:StringRes public val messageRes: Int

    public data object Updated : WsToast { override val messageRes: Int = R.string.ws_updated }
    public data object InviteSent : WsToast { override val messageRes: Int = R.string.ws_invite_sent }
    public data object Deleted : WsToast { override val messageRes: Int = R.string.ws_deleted }
    public data object Left : WsToast { override val messageRes: Int = R.string.ws_left }
    public data object Transferred : WsToast { override val messageRes: Int = R.string.ws_transferred }
    public data class Error(@StringRes override val messageRes: Int) : WsToast
}

public data class WsSettingsUiState(
    val organization: Organization? = null,
    val currentUserRole: OrganizationRole? = null,
    val isLoading: Boolean = false,
    val isMutating: Boolean = false,
    val members: List<OrganizationMember> = emptyList(),
    val invitations: List<OrganizationInvitation> = emptyList(),
    val generatedLink: String? = null,
    val searchResults: List<SearchUserItem> = emptyList(),
    val isSearching: Boolean = false,
    val pendingInvitations: List<PendingInvitation> = emptyList(),
    val respondingInvitationId: String? = null,
    val error: String? = null,
    val llmCatalogLoading: Boolean = false,
    val llmCatalogError: String? = null,
    val llmProviders: List<LlmProvider> = emptyList(),
    val llmModelsResponse: ModelsResponse? = null,
    val isSettingDefaultModel: Boolean = false,
    val isUploadingLogo: Boolean = false,
) {
    val canManage: Boolean get() = currentUserRole?.canManage == true
    val canEdit: Boolean get() = currentUserRole?.canEdit == true
    val isOwner: Boolean get() = currentUserRole?.isOwner == true
}

@HiltViewModel
public class OrganizationSettingsViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val organizationRepository: OrganizationRepository,
    private val tokenManager: TokenManager,
    private val llmRepository: LlmRepository,
    private val ossUploadService: OSSUploadService,
) : ViewModel() {

    public val currentUserId: String? get() = tokenManager.userId

    public companion object {
        private const val TAG = "WsSettingsVM"
        private const val ORGANIZATION_LOGO_MAX_BYTES = 5L * 1024 * 1024
        private val ORGANIZATION_LOGO_CONTENT_TYPES = setOf(
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
        )
    }

    public val organizationId: String = savedStateHandle["organizationId"] ?: ""

    private val _uiState = MutableStateFlow(WsSettingsUiState())
    public val uiState: StateFlow<WsSettingsUiState> = _uiState.asStateFlow()

    private val _toastEvent = MutableSharedFlow<WsToast>(extraBufferCapacity = 1)
    internal val toastEvent: SharedFlow<WsToast> = _toastEvent.asSharedFlow()

    init {
        loadData()
    }

    /** Re-fetch workspace when the initial load failed or organization is still null. */
    public fun retryLoadOrganization() {
        loadData()
    }

    private fun emitError(e: Exception) {
        _toastEvent.tryEmit(WsToast.Error(ErrorClassifier.classify(e)))
    }

    public fun clearGeneratedLink() {
        _uiState.update { it.copy(generatedLink = null) }
    }

    private fun loadData() {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isLoading = true) }
            try {
                var ws = organizationRepository.organizations.value
                    .firstOrNull { it.id == organizationId }

                if (ws == null) {
                    try {
                        ws = organizationRepository.getOrganizationDetail(organizationId)
                    } catch (_: CancellationException) {
                        throw CancellationException()
                    } catch (e: Exception) {
                        Log.w(TAG, "Fallback getOrganization failed: ${e.message}")
                    }
                }

                _uiState.update { it.copy(organization = ws) }
                refreshMembers()
                refreshInvitations()
            } finally {
                _uiState.update { it.copy(isLoading = false) }
            }
        }
    }

    private suspend fun refreshMembers() {
        try {
            val list = organizationRepository.loadMembers(organizationId)
            val role = list.firstOrNull { it.userId == tokenManager.userId }?.role
            _uiState.update { it.copy(members = list, currentUserRole = role) }
        } catch (_: CancellationException) {
            throw CancellationException()
        } catch (e: Exception) {
            Log.w(TAG, "loadMembers failed: ${e.message}")
        }
    }

    private suspend fun refreshInvitations() {
        try {
            val list = organizationRepository.loadInvitations(organizationId)
            _uiState.update { it.copy(invitations = list) }
        } catch (_: CancellationException) {
            throw CancellationException()
        } catch (e: Exception) {
            Log.w(TAG, "loadInvitations failed: ${e.message}")
        }
    }

    public fun updateOrganization(name: String?, description: String?, icon: String?) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                val ws = organizationRepository.updateOrganization(organizationId, name, description, icon)
                _uiState.update { it.copy(organization = ws) }
                _toastEvent.tryEmit(WsToast.Updated)
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun uploadOrganizationLogo(
        uri: Uri,
        resolver: ContentResolver,
        onComplete: (Boolean, String?) -> Unit,
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(isUploadingLogo = true) }
            try {
                val fileSize = resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
                require(fileSize in 1..ORGANIZATION_LOGO_MAX_BYTES) {
                    "请选择不超过 5MB 的图片"
                }
                val contentType = resolver.getType(uri).orEmpty()
                require(contentType in ORGANIZATION_LOGO_CONTENT_TYPES) {
                    "请选择 JPG、PNG、GIF 或 WebP 图片"
                }
                val extension = when (contentType) {
                    "image/png" -> "png"
                    "image/gif" -> "gif"
                    "image/webp" -> "webp"
                    else -> "jpg"
                }
                val uploaded = ossUploadService.directUploadFromUri(
                    uri = uri,
                    fileSize = fileSize,
                    fileName = "org-$organizationId-${System.currentTimeMillis()}.$extension",
                    contentType = contentType,
                    folder = "org-logos",
                    scope = UploadScope(
                        module = "tabtinspace",
                        contextType = "organization",
                        contextId = organizationId,
                        organizationId = organizationId,
                        isPublic = true,
                    ),
                )
                require(uploaded.accessUrl.isNotBlank()) { "头像上传结果缺少访问地址" }
                val current = _uiState.value.organization
                    ?: organizationRepository.getOrganizationDetail(organizationId)
                val settings = (current.settings ?: OrganizationSettings()).copy(
                    logoUrl = uploaded.accessUrl,
                )
                val updated = organizationRepository.updateOrganization(
                    id = organizationId,
                    settings = settings,
                )
                _uiState.update { it.copy(organization = updated) }
                onComplete(true, null)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.e(TAG, "upload organization logo failed", error)
                onComplete(false, error.message)
            } finally {
                _uiState.update { it.copy(isUploadingLogo = false) }
            }
        }
    }

    public fun updateCapabilities(enableTools: Boolean) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                val fresh = organizationRepository.getOrganizationDetail(organizationId)
                val prevSettings = fresh.settings
                val settings = OrganizationSettings(
                    defaultModel = prevSettings?.defaultModel,
                    enableTools = enableTools,
                    allowMemberYolo = prevSettings?.allowMemberYolo,
                    logoUrl = prevSettings?.logoUrl,
                )
                val ws = organizationRepository.updateOrganization(organizationId, settings = settings)
                _uiState.update { it.copy(organization = ws) }
                _toastEvent.tryEmit(WsToast.Updated)
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun loadLlmCatalog() {
        val id = organizationId.takeUnless { it.isBlank() } ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(llmCatalogLoading = true, llmCatalogError = null) }
            try {
                val providers = llmRepository.getProviders(id)
                val models = llmRepository.getModels(id)
                _uiState.update {
                    it.copy(
                        llmProviders = providers,
                        llmModelsResponse = models,
                        llmCatalogLoading = false,
                        llmCatalogError = null,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "loadLlmCatalog failed: ${e.message}")
                _uiState.update {
                    it.copy(llmCatalogLoading = false, llmCatalogError = e.message ?: "")
                }
            }
        }
    }

    public fun setOrganizationDefaultModel(modelId: String) {
        if (!_uiState.value.canManage || organizationId.isBlank()) return
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isSettingDefaultModel = true) }
            try {
                llmRepository.setDefaultModel(organizationId, modelId)
                val models = llmRepository.getModels(organizationId)
                val ws = organizationRepository.getOrganizationDetail(organizationId)
                _uiState.update { it.copy(llmModelsResponse = models, organization = ws) }
                _toastEvent.tryEmit(WsToast.Updated)
            } finally {
                _uiState.update { it.copy(isSettingDefaultModel = false) }
            }
        }
    }

    private var searchJob: Job? = null

    public fun searchUsers(query: String) {
        searchJob?.cancel()
        searchJob = null
        if (query.length < 2) {
            _uiState.update { it.copy(searchResults = emptyList(), isSearching = false) }
            return
        }
        searchJob = viewModelScope.launch {
            delay(300)
            _uiState.update { it.copy(isSearching = true) }
            try {
                val results = organizationRepository.searchUsers(organizationId, query)
                _uiState.update { it.copy(searchResults = results, isSearching = false) }
            } catch (_: CancellationException) {
                throw CancellationException()
            } catch (_: Exception) {
                _uiState.update { it.copy(searchResults = emptyList(), isSearching = false) }
            }
        }
    }

    public fun clearSearchResults() {
        searchJob?.cancel()
        searchJob = null
        _uiState.update { it.copy(searchResults = emptyList(), isSearching = false) }
    }

    public fun addMember(userId: String, role: OrganizationRole) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                organizationRepository.addMember(organizationId, userId, role)
                refreshMembers()
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun updateMemberRole(userId: String, role: OrganizationRole) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                organizationRepository.updateMemberRole(organizationId, userId, role)
                refreshMembers()
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun removeMember(userId: String) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                organizationRepository.removeMember(organizationId, userId)
                refreshMembers()
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun createEmailInvitation(email: String, role: String) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                organizationRepository.createEmailInvitation(organizationId, email, role)
                refreshInvitations()
                _toastEvent.tryEmit(WsToast.InviteSent)
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun createPhoneInvitation(phone: String) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                organizationRepository.createPhoneInvitation(organizationId, phone)
                refreshInvitations()
                _toastEvent.tryEmit(WsToast.InviteSent)
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun createLinkInvitation(role: String) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                val inv = organizationRepository.createLinkInvitation(organizationId, role)
                val token = inv.token?.takeIf { it.isNotBlank() }
                    ?: error("Invitation response is missing token")
                _uiState.update {
                    it.copy(
                        generatedLink = invitationLink(
                            resolveEffectiveWebBaseUrl(tokenManager),
                            token,
                        ),
                    )
                }
                refreshInvitations()
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun cancelInvitation(invitationId: String) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            organizationRepository.cancelInvitation(organizationId, invitationId)
            _uiState.update { it.copy(invitations = it.invitations.filter { inv -> inv.id != invitationId }) }
        }
    }

    public fun transferOwnership(newOwnerUserId: String) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                organizationRepository.transferOwnership(organizationId, newOwnerUserId)
                refreshMembers()
                _toastEvent.tryEmit(WsToast.Transferred)
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun deleteOrganization(onDeleted: () -> Unit) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                organizationRepository.deleteOrganization(organizationId)
                _toastEvent.tryEmit(WsToast.Deleted)
                onDeleted()
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun leaveOrganization(onLeft: () -> Unit) {
        viewModelScope.safeLaunch(onError = ::emitError) {
            _uiState.update { it.copy(isMutating = true) }
            try {
                organizationRepository.leaveOrganization(organizationId)
                _toastEvent.tryEmit(WsToast.Left)
                onLeft()
            } finally {
                _uiState.update { it.copy(isMutating = false) }
            }
        }
    }

    public fun loadMyPendingInvitations() {
        viewModelScope.launch {
            organizationRepository.getMyPendingInvitations()
                .onSuccess { list ->
                    _uiState.update { it.copy(pendingInvitations = list) }
                }
        }
    }

    public fun createDirectInvitation(userId: String, role: String) {
        val wsId = _uiState.value.organization?.id ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isMutating = true) }
            organizationRepository.createDirectInvitation(wsId, userId, role)
                .onSuccess {
                    refreshInvitations()
                    _uiState.update { it.copy(isMutating = false) }
                    _toastEvent.tryEmit(WsToast.InviteSent)
                }
                .onFailure { e ->
                    _uiState.update { it.copy(error = e.message, isMutating = false) }
                }
        }
    }

    public fun respondToInvitation(invitationId: String, accept: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(respondingInvitationId = invitationId) }
            organizationRepository.respondToInvitation(invitationId, accept)
                .onSuccess {
                    _uiState.update { state ->
                        state.copy(
                            pendingInvitations = state.pendingInvitations.filter { it.id != invitationId },
                            respondingInvitationId = null,
                        )
                    }
                    if (accept) {
                        loadData()
                    }
                }
                .onFailure { e ->
                    _uiState.update { it.copy(error = e.message, respondingInvitationId = null) }
                }
        }
    }
}

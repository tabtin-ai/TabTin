package com.tabtin.mobile.features.clouddocs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.CloudDocShare
import com.tabtin.mobile.data.model.CloudDocsCollaborator
import com.tabtin.mobile.data.model.CloudDocsShareError
import com.tabtin.mobile.data.model.CloudSharePermission
import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.data.model.CloudShareScope
import com.tabtin.mobile.data.repository.CloudDocsShareService
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

internal enum class CloudDocsShareLoadPhase {
    LOADING,
    READY,
    FORBIDDEN,
    FAILED,
}

/** 变更失败时的文案种类；UI 再映射到 strings.xml。 */
internal enum class CloudDocsShareMutationError {
    FORBIDDEN,
    UPDATE_FAILED,
}

internal data class CloudDocsShareSheetUiState(
    val loadPhase: CloudDocsShareLoadPhase = CloudDocsShareLoadPhase.LOADING,
    val resourceTitle: String = "",
    val resourceType: CloudShareResourceType = CloudShareResourceType.DOCUMENT,
    val share: CloudDocShare? = null,
    val isBusy: Boolean = false,
    val updateError: CloudDocsShareMutationError? = null,
    val passwordDraft: String = "",
    val showAnyoneConfirm: Boolean = false,
    val showRefreshConfirm: Boolean = false,
    val didCopyLink: Boolean = false,
    val publicUrl: String? = null,
    val collaborators: List<CloudDocsCollaborator> = emptyList(),
    val memberCandidates: List<Pair<String, String>> = emptyList(),
    val collaboratorQuery: String = "",
    val collaboratorPermission: String = "editor",
) {
    val isLinkEnabled: Boolean get() = share != null

    val currentScope: CloudShareScope
        get() = CloudDocsShareSheetLogic.scopeFromShare(share, resourceType)

    val currentPermission: CloudSharePermission
        get() = CloudDocsShareSheetLogic.permissionFromShare(share, resourceType)

    val canInteract: Boolean
        get() = loadPhase == CloudDocsShareLoadPhase.READY && !isBusy
}

/** 可单测的纯逻辑（与 iOS CloudDocsShareSheet helpers 对齐）。 */
internal object CloudDocsShareSheetLogic {
    fun scopeFromShare(share: CloudDocShare?, type: CloudShareResourceType): CloudShareScope {
        val wire = share?.shareType ?: return CloudShareScope.ORGANIZATION
        return CloudShareScope.fromWireValue(wire, type)
    }

    fun permissionFromShare(
        share: CloudDocShare?,
        type: CloudShareResourceType,
    ): CloudSharePermission {
        val parsed = share?.permission?.let(CloudSharePermission::fromWireValue)
        if (parsed != null && parsed in type.availablePermissions) return parsed
        return type.availablePermissions.firstOrNull() ?: CloudSharePermission.VIEW
    }

    /** 401 / Other → failed；403 → forbidden。 */
    fun loadPhaseForError(error: Throwable): CloudDocsShareLoadPhase =
        when (error) {
            is CloudDocsShareError.Forbidden -> CloudDocsShareLoadPhase.FORBIDDEN
            else -> CloudDocsShareLoadPhase.FAILED
        }
}

@HiltViewModel
internal class CloudDocsShareSheetViewModel @Inject constructor(
    private val shareService: CloudDocsShareService,
    private val organizationRepository: OrganizationRepository,
    private val tokenManager: TokenManager,
) : ViewModel() {
    private val _uiState = MutableStateFlow(CloudDocsShareSheetUiState())
    val uiState: StateFlow<CloudDocsShareSheetUiState> = _uiState.asStateFlow()

    private var boundType: CloudShareResourceType = CloudShareResourceType.DOCUMENT
    private var boundResourceId: String = ""
    private var copyFeedbackJob: Job? = null

    fun load(target: CloudDocsShareTarget) {
        boundType = target.type
        boundResourceId = target.resourceId
        _uiState.value = CloudDocsShareSheetUiState(
            loadPhase = CloudDocsShareLoadPhase.LOADING,
            resourceTitle = target.title,
            resourceType = target.type,
        )
        viewModelScope.launch { loadShare() }
        viewModelScope.launch { loadCollaborators() }
    }

    fun retryLoad() {
        viewModelScope.launch { loadShare() }
    }

    fun setPasswordDraft(value: String) {
        _uiState.update { it.copy(passwordDraft = value) }
    }

    fun setCollaboratorQuery(value: String) { _uiState.update { it.copy(collaboratorQuery = value) } }
    fun invite(userId: String, permission: String) = viewModelScope.launch { mutate { shareService.inviteCollaborators(boundType, boundResourceId, listOf(userId), permission); loadCollaborators() } }
    fun updateCollaborator(userId: String, permission: String) = viewModelScope.launch { mutate { shareService.updateCollaborator(boundType, boundResourceId, userId, permission); loadCollaborators() } }
    fun removeCollaborator(userId: String) = viewModelScope.launch { mutate { shareService.removeCollaborator(boundType, boundResourceId, userId); loadCollaborators() } }

    fun dismissAnyoneConfirm() {
        _uiState.update { it.copy(showAnyoneConfirm = false) }
    }

    fun dismissRefreshConfirm() {
        _uiState.update { it.copy(showRefreshConfirm = false) }
    }

    fun requestRefreshConfirm() {
        if (!_uiState.value.canInteract) return
        _uiState.update { it.copy(showRefreshConfirm = true) }
    }

    fun setLinkEnabled(enabled: Boolean) {
        val state = _uiState.value
        if (!state.canInteract) return
        if (enabled == state.isLinkEnabled) return

        viewModelScope.launch {
            mutate {
                if (enabled) {
                    val created = shareService.upsert(
                        type = boundType,
                        resourceId = boundResourceId,
                        scope = CloudShareScope.ORGANIZATION,
                        permission = CloudSharePermission.VIEW,
                        password = null,
                        acknowledgePublicExposure = false,
                    )
                    applyShare(created, clearPasswordDraft = true)
                } else {
                    shareService.disable(
                        type = boundType,
                        resourceId = boundResourceId,
                        scope = state.currentScope,
                    )
                    applyShare(null, clearPasswordDraft = true)
                }
            }
        }
    }

    /**
     * 切到「任何人」时**不**改 share；取消确认后 UI get 仍返回组织内。
     */
    fun selectScope(next: CloudShareScope) {
        val state = _uiState.value
        if (!state.canInteract) return
        if (next == state.currentScope) return

        if (next == CloudShareScope.ANYONE) {
            _uiState.update { it.copy(showAnyoneConfirm = true) }
            return
        }

        viewModelScope.launch {
            changeScope(CloudShareScope.ORGANIZATION, acknowledgePublicExposure = false)
        }
    }

    fun confirmAnyoneScope() {
        _uiState.update { it.copy(showAnyoneConfirm = false) }
        viewModelScope.launch {
            changeScope(CloudShareScope.ANYONE, acknowledgePublicExposure = true)
        }
    }

    fun changePermission(permission: CloudSharePermission) {
        val state = _uiState.value
        if (!state.canInteract) return
        if (permission == state.currentPermission) return
        if (permission !in boundType.availablePermissions) return

        viewModelScope.launch {
            mutate {
                val updated = shareService.upsert(
                    type = boundType,
                    resourceId = boundResourceId,
                    scope = state.currentScope,
                    permission = permission,
                    password = null,
                    acknowledgePublicExposure = state.currentScope == CloudShareScope.ANYONE,
                )
                applyShare(updated)
            }
        }
    }

    fun applyPassword() {
        val state = _uiState.value
        if (!state.canInteract) return
        val password = state.passwordDraft
        if (password.isEmpty()) return

        viewModelScope.launch {
            mutate {
                val updated = shareService.upsert(
                    type = boundType,
                    resourceId = boundResourceId,
                    scope = state.currentScope,
                    permission = state.currentPermission,
                    password = password,
                    acknowledgePublicExposure = state.currentScope == CloudShareScope.ANYONE,
                )
                applyShare(updated, clearPasswordDraft = true)
            }
        }
    }

    fun clearPassword() {
        val state = _uiState.value
        if (!state.canInteract) return
        if (state.share?.hasPassword != true) return

        viewModelScope.launch {
            mutate {
                val updated = shareService.upsert(
                    type = boundType,
                    resourceId = boundResourceId,
                    scope = state.currentScope,
                    permission = state.currentPermission,
                    password = "",
                    acknowledgePublicExposure = state.currentScope == CloudShareScope.ANYONE,
                )
                applyShare(updated, clearPasswordDraft = true)
            }
        }
    }

    fun confirmRefreshLink() {
        _uiState.update { it.copy(showRefreshConfirm = false) }
        val state = _uiState.value
        if (!state.canInteract) return

        viewModelScope.launch {
            // 表格轮换是 disable + upsert；失败须 reconcile fetch。
            mutate(reconcileOnFailure = true) {
                val updated = shareService.refresh(
                    type = boundType,
                    resourceId = boundResourceId,
                    scope = state.currentScope,
                    permission = state.currentPermission,
                )
                applyShare(updated)
            }
        }
    }

    fun markLinkCopied() {
        copyFeedbackJob?.cancel()
        _uiState.update { it.copy(didCopyLink = true) }
        copyFeedbackJob = viewModelScope.launch {
            delay(COPIED_FEEDBACK_MS)
            _uiState.update { it.copy(didCopyLink = false) }
        }
    }

    private suspend fun loadShare() {
        _uiState.update {
            it.copy(loadPhase = CloudDocsShareLoadPhase.LOADING, updateError = null)
        }
        try {
            val share = shareService.fetch(boundType, boundResourceId)
            applyShare(share)
            _uiState.update { it.copy(loadPhase = CloudDocsShareLoadPhase.READY) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _uiState.update {
                it.copy(
                    share = null,
                    publicUrl = null,
                    loadPhase = CloudDocsShareSheetLogic.loadPhaseForError(e),
                )
            }
        }
    }

    private suspend fun loadCollaborators() {
        try {
            val response = shareService.collaborators(boundType, boundResourceId)
            // 邀请候选只来自当前 Organization，后端仍是权限最终裁决。
            val members = tokenManager.organizationId?.let { organizationRepository.loadMembers(it) }.orEmpty()
            _uiState.update { state ->
                state.copy(
                    collaborators = response.collaborators,
                    memberCandidates = members
                        .filter { it.userId != tokenManager.userId }
                        .map { it.userId to it.displayName },
                )
            }
        } catch (_: Throwable) {
            // 不遮蔽原有链接分享；协作者区可在下次操作后重试。
        }
    }

    private suspend fun changeScope(
        scope: CloudShareScope,
        acknowledgePublicExposure: Boolean,
    ) {
        val state = _uiState.value
        // 确认弹窗 dismiss 后触发；此时只需保证仍在 ready 且链接已开。
        if (state.loadPhase != CloudDocsShareLoadPhase.READY || !state.isLinkEnabled || state.isBusy) {
            return
        }

        mutate {
            val updated = shareService.upsert(
                type = boundType,
                resourceId = boundResourceId,
                scope = scope,
                permission = state.currentPermission,
                password = null,
                acknowledgePublicExposure = acknowledgePublicExposure,
            )
            applyShare(updated)
        }
    }

    /**
     * @param reconcileOnFailure 失败后静默重新拉服务端状态（表格轮换中间态）。
     */
    private suspend fun mutate(
        reconcileOnFailure: Boolean = false,
        work: suspend () -> Unit,
    ) {
        if (_uiState.value.isBusy) return
        _uiState.update { it.copy(isBusy = true, updateError = null) }
        try {
            work()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            handleMutationError(e)
            if (reconcileOnFailure) reconcile()
        } finally {
            _uiState.update { it.copy(isBusy = false) }
        }
    }

    private suspend fun reconcile() {
        val latest = try {
            shareService.fetch(boundType, boundResourceId)
        } catch (_: Throwable) {
            // 连状态都拉不回来：清掉手里这份，避免继续展示可能已失效的链接。
            applyShare(null)
            return
        }
        applyShare(latest)
    }

    private fun handleMutationError(error: Throwable) {
        when (error) {
            is CloudDocsShareError.Forbidden ->
                _uiState.update { it.copy(updateError = CloudDocsShareMutationError.FORBIDDEN) }
            is CloudDocsShareError.PublicExposureNotAcknowledged ->
                // 确认流程漏带 ack：再弹同一确认窗；UI 范围仍停留在组织内（share 未改）
                _uiState.update { it.copy(showAnyoneConfirm = true) }
            else ->
                _uiState.update { it.copy(updateError = CloudDocsShareMutationError.UPDATE_FAILED) }
        }
    }

    private fun applyShare(share: CloudDocShare?, clearPasswordDraft: Boolean = false) {
        val url = share?.shareId?.let { shareService.publicUrl(it, boundType) }
        _uiState.update {
            it.copy(
                share = share,
                publicUrl = url,
                passwordDraft = if (clearPasswordDraft) "" else it.passwordDraft,
            )
        }
    }

    companion object {
        private const val COPIED_FEEDBACK_MS = 1_800L
    }
}

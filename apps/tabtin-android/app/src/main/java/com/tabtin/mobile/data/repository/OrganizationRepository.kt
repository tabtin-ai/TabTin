package com.tabtin.mobile.data.repository

import android.util.Log
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.apiErrorCode
import com.tabtin.mobile.data.api.apiErrorMessage
import com.tabtin.mobile.data.model.AddMemberRequest
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.CreateEmailInvitationRequest
import com.tabtin.mobile.data.model.CreateLinkInvitationRequest
import com.tabtin.mobile.data.model.CreateOrganizationRequest
import com.tabtin.mobile.data.model.TransferOwnershipRequest
import com.tabtin.mobile.data.model.UpdateMemberRoleRequest
import com.tabtin.mobile.data.model.UpdateOrganizationRequest
import com.tabtin.mobile.data.model.OrganizationSettings
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.OrganizationInvitation
import com.tabtin.mobile.data.model.CreatePhoneInvitationRequest
import com.tabtin.mobile.data.model.AcceptInvitationResponse
import com.tabtin.mobile.data.model.CreateDirectInvitationRequest
import com.tabtin.mobile.data.model.InvitationInfo
import com.tabtin.mobile.data.model.InvitationRespondResponse
import com.tabtin.mobile.data.model.PendingInvitation
import com.tabtin.mobile.data.model.RespondToInvitationRequest
import com.tabtin.mobile.data.model.SearchUserItem
import com.tabtin.mobile.data.model.MemberIdentitySnapshotListResponse
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationMemberSearchResponse
import com.tabtin.mobile.data.model.OrganizationMemberProfile
import com.tabtin.mobile.data.model.OrganizationMemberProfilesRequest
import com.tabtin.mobile.data.model.OrganizationRole
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.features.main.ChatDrawerController
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicInteger
import javax.inject.Inject
import javax.inject.Singleton
import retrofit2.HttpException

public data class OrganizationAccessRevokedNotice(
    val organizationId: String,
    val organizationName: String?,
    val fallbackOrganization: Organization?,
)

@Singleton
public class OrganizationRepository @Inject constructor(
    private val contextApi: ContextApi,
    private val tokenManager: TokenManager,
    private val deviceRuntimeRepository: DeviceRuntimeRepository,
    private val chatRepository: ChatRepository,
    private val sessionRunStateStore: SessionRunStateStore,
    private val sessionReadStateStore: SessionReadStateStore,
    private val sessionReadAckStore: SessionReadAckStore,
    private val webSocketService: WebSocketService,
    private val chatDrawerController: ChatDrawerController,
) {
    public companion object {
        private const val TAG = "OrganizationRepository"
        private const val BATCH_PROFILE_LIMIT = 200
    }

    private val _invitationUpdates = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    public val invitationUpdates: SharedFlow<Unit> = _invitationUpdates.asSharedFlow()

    /** 由 [com.tabtin.mobile.data.websocket.UserEventHandler] 在收到 `agent.user.notification.new` 且 type 为 organization.invitation* 时调用。 */
    public fun notifyInvitationInboxMayHaveChanged() {
        Log.i(TAG, "邀请相关通知，刷新待处理邀请列表")
        _invitationUpdates.tryEmit(Unit)
    }

    private val _organizations = MutableStateFlow<List<Organization>>(emptyList())
    public val organizations: StateFlow<List<Organization>> = _organizations.asStateFlow()

    private val _selectedOrganization = MutableStateFlow<Organization?>(null)
    public val selectedOrganization: StateFlow<Organization?> = _selectedOrganization.asStateFlow()

    private val _organizationAccessRevokedNotice = MutableStateFlow<OrganizationAccessRevokedNotice?>(null)
    public val organizationAccessRevokedNotice: StateFlow<OrganizationAccessRevokedNotice?> =
        _organizationAccessRevokedNotice.asStateFlow()

    /** 组织准入天花板：当前选中组织是否允许成员使用 YOLO / 宽松审批档（非响应式即时读）。 */
    public val allowMemberYolo: Boolean
        get() = _selectedOrganization.value?.settings?.allowMemberYolo == true

    private val _isLoading = MutableStateFlow(false)
    public val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    public val error: StateFlow<String?> = _error.asStateFlow()

    private val selectSeq = AtomicInteger(0)

    // ── Organization List / Select ──────────────────────────

    public suspend fun loadOrganizations() {
        _isLoading.value = true
        _error.value = null
        try {
            val resp = contextApi.getOrganizations()
            val list = resp.data?.organizations ?: emptyList()
            val previous = _selectedOrganization.value
            val persistedId = tokenManager.organizationId
            _organizations.value = list

            if (previous != null && list.none { it.id == previous.id }) {
                markOrganizationAccessRevoked(
                    organizationId = previous.id,
                    organizationName = previous.name,
                    availableOrganizations = list,
                )
                return
            }
            if (previous == null && persistedId != null && list.none { it.id == persistedId }) {
                markOrganizationAccessRevoked(
                    organizationId = persistedId,
                    availableOrganizations = list,
                )
                return
            }

            if (_selectedOrganization.value == null) {
                val match = persistedId?.let { id -> list.firstOrNull { it.id == id } }
                when {
                    match != null -> _selectedOrganization.value = match
                    list.size == 1 -> selectOrganizationInternal(list.first())
                    list.size > 1 -> {
                        val defaultWs = list.firstOrNull { it.isDefault == true }
                        selectOrganizationInternal(defaultWs ?: list.first())
                    }
                }
            }
        } catch (e: Exception) {
            _error.value = e.message
        } finally {
            _isLoading.value = false
        }
    }

    public suspend fun selectOrganization(organization: Organization) {
        // 组织列表可能来自旧缓存。切换前重新取一次权威成员范围，避免把已经被移出的组织
        // 写入当前上下文后触发 IM/设备接口 401，最终被误判为登录失效。
        val latestOrganizations = try {
            contextApi.getOrganizations().data?.organizations ?: emptyList()
        } catch (e: Exception) {
            Log.w(TAG, "refresh organizations before selection failed: ${e.message}")
            _error.value = e.message
            return
        }
        _organizations.value = latestOrganizations
        val target = latestOrganizations.firstOrNull { it.id == organization.id }
        if (target == null) {
            markOrganizationAccessRevoked(
                organizationId = organization.id,
                organizationName = organization.name,
                availableOrganizations = latestOrganizations,
            )
            return
        }
        selectOrganizationInternal(target)
    }

    private suspend fun selectOrganizationInternal(organization: Organization) {
        val seq = selectSeq.incrementAndGet()
        val previousId = _selectedOrganization.value?.id

        try {
            chatRepository.clearCache()
            chatDrawerController.resetForOrganizationSwitch()
            sessionRunStateStore.clear()
            sessionReadStateStore.clear()

            if (selectSeq.get() != seq) return

            tokenManager.organizationId = organization.id
            sessionReadAckStore.resetInMemoryScope()
            _selectedOrganization.value = organization

            val registered = deviceRuntimeRepository.ensureSelectedOrganizationDeviceRegistered(organization.id)

            if (selectSeq.get() != seq) return

            if (previousId != null && previousId != organization.id) {
                webSocketService.fullDisconnect()
                if (registered) {
                    webSocketService.ensureDeviceRuntimeReady()
                }
            } else if (registered) {
                webSocketService.ensureDeviceRuntimeReady()
            }
        } catch (e: Exception) {
            Log.w(TAG, "selectOrganization failed: ${e.message}")
            _error.value = e.message
        }
    }

    private fun defaultOrganization(organizations: List<Organization>): Organization? =
        organizations.firstOrNull { it.isDefault == true } ?: organizations.firstOrNull()

    private suspend fun markOrganizationAccessRevoked(
        organizationId: String,
        organizationName: String? = null,
        availableOrganizations: List<Organization>,
    ) {
        val wasSelected = _selectedOrganization.value?.id == organizationId || tokenManager.organizationId == organizationId
        if (wasSelected) {
            deviceRuntimeRepository.stopHeartbeatForOrganizationAccessRevoked()
            chatRepository.clearCache()
            chatDrawerController.resetForOrganizationSwitch()
            sessionRunStateStore.clear()
            sessionReadStateStore.clear()
            sessionReadAckStore.resetInMemoryScope()
            webSocketService.fullDisconnect()
            _selectedOrganization.value = null
            tokenManager.organizationId = null
        }
        _organizations.value = availableOrganizations
        _organizationAccessRevokedNotice.value = OrganizationAccessRevokedNotice(
            organizationId = organizationId,
            organizationName = organizationName?.takeIf { it.isNotBlank() },
            fallbackOrganization = defaultOrganization(availableOrganizations),
        )
    }

    /** 深链目标不在权威组织列表时调用，保持登录态并交给根导航展示移出提示。 */
    public suspend fun notifyOrganizationAccessRevoked(organizationId: String, organizationName: String? = null) {
        if (organizationId.isBlank()) return
        markOrganizationAccessRevoked(
            organizationId = organizationId,
            organizationName = organizationName ?: _organizations.value.firstOrNull { it.id == organizationId }?.name,
            availableOrganizations = _organizations.value,
        )
    }

    public suspend fun selectDefaultOrganization(): Boolean {
        val fallback = defaultOrganization(_organizations.value) ?: return false
        selectOrganization(fallback)
        return _selectedOrganization.value?.id == fallback.id
    }

    public fun clearOrganizationAccessRevokedNotice() {
        _organizationAccessRevokedNotice.value = null
    }

    // ── Organization CRUD ───────────────────────────────────

    public suspend fun getOrganizationDetail(id: String): Organization {
        return contextApi.getOrganization(id).unwrap()
    }

    public suspend fun createOrganization(name: String, description: String? = null, icon: String? = null): Organization {
        return try {
            val resp = contextApi.createOrganization(CreateOrganizationRequest(name, description, icon))
            val ws = resp.unwrap()
            loadOrganizations()
            ws
        } catch (error: HttpException) {
            throw organizationMutationError(error)
        }
    }

    public suspend fun updateOrganization(
        id: String,
        name: String? = null,
        description: String? = null,
        icon: String? = null,
        settings: OrganizationSettings? = null,
    ): Organization {
        val resp = contextApi.updateOrganization(id, UpdateOrganizationRequest(name, description, icon, settings))
        val ws = resp.unwrap()
        _organizations.value = _organizations.value.map { if (it.id == id) ws else it }
        if (_selectedOrganization.value?.id == id) {
            _selectedOrganization.value = ws
        }
        return ws
    }

    public suspend fun deleteOrganization(id: String) {
        contextApi.deleteOrganization(id).unwrap()
        removeOrganizationLocally(id)
    }

    public suspend fun leaveOrganization(id: String) {
        contextApi.leaveOrganization(id).unwrap()
        removeOrganizationLocally(id)
    }

    private suspend fun removeOrganizationLocally(id: String) {
        _organizations.value = _organizations.value.filter { it.id != id }
        if (_selectedOrganization.value?.id == id) {
            _selectedOrganization.value = null
            tokenManager.organizationId = null
            val remaining = _organizations.value
            if (remaining.isNotEmpty()) {
                selectOrganizationInternal(remaining.firstOrNull { it.isDefault == true } ?: remaining.first())
            }
        }
    }

    public suspend fun transferOwnership(organizationId: String, newOwnerUserId: String) {
        contextApi.transferOwnership(organizationId, TransferOwnershipRequest(newOwnerUserId)).unwrap()
        loadMembers(organizationId)
    }

    // ── Members ──────────────────────────────────────────

    public suspend fun loadMembers(
        organizationId: String,
        search: String? = null,
        searchMode: String? = null,
    ): List<OrganizationMember> {
        val resp = contextApi.getMembers(organizationId, search, searchMode)
        return resp.unwrap().members
    }

    public suspend fun searchMembers(
        organizationId: String,
        search: String? = null,
        searchMode: String? = null,
        role: String? = null,
        offset: Int = 0,
        limit: Int = 0,
    ): OrganizationMemberSearchResponse {
        return contextApi.searchOrganizationMembers(
            organizationId,
            search = search,
            searchMode = searchMode,
            role = role,
            offset = offset,
            limit = limit,
        ).unwrap()
    }

    public suspend fun loadMemberIdentitySnapshots(
        organizationId: String,
    ): MemberIdentitySnapshotListResponse {
        return contextApi.getMemberIdentitySnapshots(organizationId).unwrap()
    }

    public suspend fun batchMemberProfiles(
        organizationId: String,
        userIds: Collection<String>,
    ): List<OrganizationMemberProfile> {
        val normalized = userIds.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (normalized.isEmpty()) return emptyList()
        return normalized.chunked(BATCH_PROFILE_LIMIT).flatMap { chunk ->
            contextApi.batchMemberProfiles(
                organizationId,
                OrganizationMemberProfilesRequest(chunk),
            ).unwrap()
        }
    }

    public suspend fun searchUsers(organizationId: String, query: String): List<SearchUserItem> =
        contextApi.searchUsersForOrganization(organizationId, query).unwrap().users

    public suspend fun addMember(organizationId: String, userId: String, role: OrganizationRole) {
        contextApi.addMember(organizationId, AddMemberRequest(userId, role.displayKey)).unwrap()
    }

    public suspend fun updateMemberRole(organizationId: String, userId: String, role: OrganizationRole) {
        contextApi.updateMemberRole(organizationId, userId, UpdateMemberRoleRequest(role.displayKey)).unwrap()
    }

    public suspend fun removeMember(organizationId: String, userId: String) {
        contextApi.removeMember(organizationId, userId).unwrap()
    }

    // ── Invitations ──────────────────────────────────────

    public suspend fun loadInvitations(organizationId: String): List<OrganizationInvitation> {
        val resp = contextApi.getInvitations(organizationId)
        return resp.unwrap().invitations
    }

    public suspend fun createEmailInvitation(organizationId: String, email: String, role: String = "editor"): OrganizationInvitation {
        val resp = contextApi.createEmailInvitation(organizationId, CreateEmailInvitationRequest(email, role))
        return resp.unwrap()
    }

    public suspend fun createPhoneInvitation(organizationId: String, phone: String): OrganizationInvitation {
        val resp = contextApi.createPhoneInvitation(organizationId, CreatePhoneInvitationRequest(phone.trim()))
        return resp.unwrap()
    }

    public suspend fun createLinkInvitation(organizationId: String, role: String = "editor"): OrganizationInvitation {
        val resp = contextApi.createLinkInvitation(organizationId, CreateLinkInvitationRequest(role))
        return resp.unwrap()
    }

    public suspend fun cancelInvitation(organizationId: String, invitationId: String) {
        contextApi.cancelInvitation(organizationId, invitationId).unwrap()
    }

    public suspend fun getInvitationInfo(token: String): InvitationInfo {
        return contextApi.getInvitationInfo(token).unwrap()
    }

    public suspend fun acceptInvitation(token: String): AcceptInvitationResponse {
        val resp = contextApi.acceptInvitation(token).unwrap()
        loadOrganizations()
        return resp
    }

    public suspend fun createDirectInvitation(organizationId: String, userId: String, role: String): Result<OrganizationInvitation> = runCatching {
        contextApi.createDirectInvitation(organizationId, CreateDirectInvitationRequest(userId, role)).unwrap()
    }

    public suspend fun getMyPendingInvitations(): Result<List<PendingInvitation>> = runCatching {
        contextApi.getMyPendingInvitations().unwrap().invitations
    }

    public suspend fun respondToInvitation(invitationId: String, accept: Boolean): Result<InvitationRespondResponse> = runCatching {
        contextApi.respondToInvitation(invitationId, RespondToInvitationRequest(accept)).unwrap()
    }

    public fun clearError() {
        _error.value = null
    }

    public fun clearOnLogout() {
        _organizations.value = emptyList()
        _selectedOrganization.value = null
        _organizationAccessRevokedNotice.value = null
        _error.value = null
    }
}

/**
 * Retrofit drops the standard API error envelope behind [HttpException]. Preserve the
 * server's actionable organization-policy message instead of exposing only `HTTP 400`.
 */
internal fun organizationMutationError(error: HttpException): AppError.RequestFailed {
    val rawBody = runCatching { error.response()?.errorBody()?.string() }.getOrNull()
    return AppError.RequestFailed(
        serverMessage = apiErrorMessage(rawBody),
        errorCode = apiErrorCode(rawBody),
    )
}

package com.tabtin.mobile.features.tabchat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.im.ContactInvitation
import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.data.im.ExternalContactCandidate
import com.tabtin.mobile.data.im.ExternalContactRepository
import com.tabtin.mobile.data.im.ImConversationService
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.im.resolveDirectMessageConversationId
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.TokenManager
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.UUID

public enum class ContactsDirectoryTab {
    INTERNAL,
    EXTERNAL,
    INCOMING,
    OUTGOING,
    BLOCKED,
}

internal data class ExternalContactGroups(
    val friends: List<ExternalContact>,
    val blocked: List<ExternalContact>,
)

internal fun groupExternalContacts(contacts: List<ExternalContact>): ExternalContactGroups =
    ExternalContactGroups(
        friends = contacts.filter { it.relationship == "friend" },
        blocked = contacts.filter { it.relationship == "blocked" },
    )

internal fun canInviteOrganizationMembers(
    members: List<OrganizationMember>,
    currentUserId: String?,
    isPersonalOrganization: Boolean,
): Boolean =
    !isPersonalOrganization &&
        currentUserId != null &&
        members.firstOrNull { it.userId == currentUserId }?.role?.isOwner == true

private data class ContactsReloadResults(
    val members: Result<List<OrganizationMember>>,
    val externalContacts: Result<List<ExternalContact>>,
    val incomingInvitations: Result<List<ContactInvitation>>,
    val outgoingInvitations: Result<List<ContactInvitation>>,
)

public data class ContactsUiState(
    val members: List<OrganizationMember> = emptyList(),
    val externalContacts: List<ExternalContact> = emptyList(),
    val blockedExternalContacts: List<ExternalContact> = emptyList(),
    val incomingInvitations: List<ContactInvitation> = emptyList(),
    val outgoingInvitations: List<ContactInvitation> = emptyList(),
    val organizations: List<Organization> = emptyList(),
    val canAddOrganizationMember: Boolean = false,
    val selectedTab: ContactsDirectoryTab = ContactsDirectoryTab.INTERNAL,
    val query: String = "",
    val externalContactPhone: String = "",
    val externalContactCandidate: ExternalContactCandidate? = null,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val isOpeningDm: Boolean = false,
    val isCreatingGroup: Boolean = false,
    val isMutatingExternalContact: Boolean = false,
    val externalContactsErrorMessage: String? = null,
    val externalContactsLoadErrorMessage: String? = null,
    val incomingInvitationsErrorMessage: String? = null,
    val outgoingInvitationsErrorMessage: String? = null,
)

internal fun ContactsUiState.selectedDirectoryError(): String? = when (selectedTab) {
    ContactsDirectoryTab.INTERNAL -> errorMessage
    ContactsDirectoryTab.EXTERNAL,
    ContactsDirectoryTab.BLOCKED,
    -> externalContactsLoadErrorMessage ?: externalContactsErrorMessage
    ContactsDirectoryTab.INCOMING -> incomingInvitationsErrorMessage ?: externalContactsErrorMessage
    ContactsDirectoryTab.OUTGOING -> outgoingInvitationsErrorMessage ?: externalContactsErrorMessage
}

public data class ContactDirectMessageTarget(
    val conversationId: String,
    val title: String,
)

@HiltViewModel
public class ContactsViewModel @Inject constructor(
    private val organizationRepository: OrganizationRepository,
    private val conversationService: ImConversationService,
    private val conversationStore: ImConversationStore,
    private val externalContactRepository: ExternalContactRepository,
    private val tokenManager: TokenManager,
) : ViewModel() {
    private val _uiState = MutableStateFlow(ContactsUiState())
    public val uiState: StateFlow<ContactsUiState> = _uiState.asStateFlow()

    public val currentUserId: String?
        get() = tokenManager.userId?.takeIf { it.isNotBlank() }

    private var activeOrganizationId: String = ""
    private var pendingGroupAttempt: ImGroupCreationAttempt? = null

    public fun activate(organizationId: String) {
        if (organizationId.isBlank()) {
            activeOrganizationId = ""
            pendingGroupAttempt = null
            _uiState.value = ContactsUiState()
            return
        }
        if (organizationId != activeOrganizationId) {
            pendingGroupAttempt = null
            _uiState.value = ContactsUiState()
        }
        if (organizationId == activeOrganizationId && _uiState.value.members.isNotEmpty()) return
        activeOrganizationId = organizationId
        reload()
    }

    public fun setQuery(query: String) {
        _uiState.update { it.copy(query = query) }
    }

    public fun selectTab(tab: ContactsDirectoryTab) {
        _uiState.update { it.copy(selectedTab = tab) }
    }

    public fun setExternalContactPhone(phone: String) {
        _uiState.update {
            it.copy(
                externalContactPhone = phone,
                externalContactCandidate = null,
                externalContactsErrorMessage = null,
            )
        }
    }

    public fun reload() {
        val organizationId = activeOrganizationId
        if (organizationId.isBlank()) return
        viewModelScope.safeLaunch(
            onError = { error ->
                if (activeOrganizationId == organizationId) {
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            errorMessage = error.message ?: "加载通讯录失败",
                        )
                    }
                }
            },
        ) {
            _uiState.update {
                it.copy(
                    isLoading = true,
                    errorMessage = null,
                    externalContactsLoadErrorMessage = null,
                    incomingInvitationsErrorMessage = null,
                    outgoingInvitationsErrorMessage = null,
                )
            }
            val results = coroutineScope {
                val members = async {
                    resultOfSuspend {
                        organizationRepository.loadMembers(organizationId)
                            .sortedWith(
                                compareBy(String.CASE_INSENSITIVE_ORDER) { it.displayName },
                            )
                    }
                }
                val externalContacts = async {
                    resultOfSuspend {
                        externalContactRepository.list(organizationId).sortedWith(
                            compareBy(String.CASE_INSENSITIVE_ORDER) { it.displayName },
                        )
                    }
                }
                val incomingInvitations = async {
                    resultOfSuspend {
                        externalContactRepository.listInvitations(organizationId, direction = "incoming")
                    }
                }
                val outgoingInvitations = async {
                    resultOfSuspend {
                        externalContactRepository.listInvitations(organizationId, direction = "outgoing")
                    }
                }
                ContactsReloadResults(
                    members = members.await(),
                    externalContacts = externalContacts.await(),
                    incomingInvitations = incomingInvitations.await(),
                    outgoingInvitations = outgoingInvitations.await(),
                )
            }
            if (activeOrganizationId == organizationId) {
                _uiState.update { state ->
                    val loadedMembers = results.members.getOrNull()
                    val organizations = organizationRepository.organizations.value
                    val organization = organizations.firstOrNull { it.id == organizationId }
                    val contactGroups = results.externalContacts.getOrNull()?.let(::groupExternalContacts)
                    state.copy(
                        members = loadedMembers ?: state.members,
                        externalContacts = contactGroups?.friends
                            ?: state.externalContacts,
                        blockedExternalContacts = contactGroups?.blocked
                            ?: state.blockedExternalContacts,
                        incomingInvitations = results.incomingInvitations.getOrElse { state.incomingInvitations },
                        outgoingInvitations = results.outgoingInvitations.getOrElse { state.outgoingInvitations },
                        organizations = organizations,
                        canAddOrganizationMember = loadedMembers != null &&
                            organization != null &&
                            canInviteOrganizationMembers(
                                members = loadedMembers,
                                currentUserId = currentUserId,
                                isPersonalOrganization = organization.isPersonal,
                            ),
                        isLoading = false,
                        errorMessage = results.members.exceptionOrNull()?.message,
                        externalContactsLoadErrorMessage = results.externalContacts.exceptionOrNull()?.message,
                        incomingInvitationsErrorMessage = results.incomingInvitations.exceptionOrNull()?.message,
                        outgoingInvitationsErrorMessage = results.outgoingInvitations.exceptionOrNull()?.message,
                    )
                }
            }
        }
    }

    public fun filteredMembers(): List<OrganizationMember> {
        val state = _uiState.value
        val q = state.query.trim().lowercase()
        if (q.isEmpty()) return state.members
        return state.members.filter { member ->
            val user = member.user
            listOfNotNull(
                member.displayName,
                user?.nickname,
                user?.username,
                user?.email,
            ).any { it.lowercase().contains(q) }
        }
    }

    public fun filteredExternalContacts(): List<ExternalContact> {
        return filterExternalContacts(_uiState.value.externalContacts)
    }

    public fun filteredBlockedContacts(): List<ExternalContact> = filterExternalContacts(_uiState.value.blockedExternalContacts)

    public fun filteredIncomingInvitations(): List<ContactInvitation> = filterInvitations(_uiState.value.incomingInvitations)

    public fun filteredOutgoingInvitations(): List<ContactInvitation> = filterInvitations(_uiState.value.outgoingInvitations)

    private fun filterExternalContacts(contacts: List<ExternalContact>): List<ExternalContact> {
        val q = _uiState.value.query.trim().lowercase()
        if (q.isEmpty()) return contacts
        return contacts.filter { contact ->
            listOf(contact.displayName, contact.peerUserId, contact.peerOrganizationName)
                .any { it.lowercase().contains(q) }
        }
    }

    private fun filterInvitations(invitations: List<ContactInvitation>): List<ContactInvitation> {
        val q = _uiState.value.query.trim().lowercase()
        if (q.isEmpty()) return invitations
        return invitations.filter { invitation ->
            listOfNotNull(
                invitation.displayName,
                invitation.peerUserId,
                invitation.peerOrganizationName,
                invitation.note,
            ).any { it.lowercase().contains(q) }
        }
    }

    public fun eligibleOrganizations(invitation: ContactInvitation): List<Organization> =
        _uiState.value.organizations.filter { it.id != invitation.peerOrganizationId }

    public fun defaultAcceptOrganizationId(invitation: ContactInvitation): String? {
        val eligible = eligibleOrganizations(invitation)
        return eligible.firstOrNull { it.id == activeOrganizationId }?.id ?: eligible.firstOrNull()?.id
    }

    public fun discoverExternalContact() {
        val organizationId = activeOrganizationId
        val phone = _uiState.value.externalContactPhone.trim()
        if (organizationId.isBlank() || phone.isBlank() || _uiState.value.isMutatingExternalContact) return
        viewModelScope.safeLaunch(
            onError = { error ->
                if (activeOrganizationId == organizationId) {
                    _uiState.update {
                        it.copy(
                            isMutatingExternalContact = false,
                            externalContactCandidate = null,
                            externalContactsErrorMessage = error.message ?: "未找到对应账号",
                        )
                    }
                }
            },
        ) {
            _uiState.update {
                it.copy(isMutatingExternalContact = true, externalContactsErrorMessage = null)
            }
            val candidate = externalContactRepository.discover(organizationId, phone)
            if (activeOrganizationId == organizationId) {
                _uiState.update {
                    it.copy(isMutatingExternalContact = false, externalContactCandidate = candidate)
                }
            }
        }
    }

    public fun inviteExternalContact(note: String?) {
        val organizationId = activeOrganizationId
        val candidate = _uiState.value.externalContactCandidate ?: return
        if (organizationId.isBlank() || _uiState.value.isMutatingExternalContact) return
        viewModelScope.safeLaunch(
            onError = { error ->
                if (activeOrganizationId == organizationId) {
                    _uiState.update {
                        it.copy(
                            isMutatingExternalContact = false,
                            externalContactsErrorMessage = error.message ?: "发送申请失败",
                        )
                    }
                }
            },
        ) {
            _uiState.update {
                it.copy(isMutatingExternalContact = true, externalContactsErrorMessage = null)
            }
            externalContactRepository.invite(
                organizationId = organizationId,
                targetUserId = candidate.userId,
                note = note?.trim()?.takeIf { it.isNotEmpty() },
            )
            if (activeOrganizationId == organizationId) {
                _uiState.update {
                    it.copy(
                        selectedTab = ContactsDirectoryTab.OUTGOING,
                        externalContactPhone = "",
                        externalContactCandidate = null,
                        isMutatingExternalContact = false,
                    )
                }
                reload()
            }
        }
    }

    public fun updateExternalContact(contact: ExternalContact, action: String) {
        val organizationId = activeOrganizationId
        if (organizationId.isBlank() || _uiState.value.isMutatingExternalContact) return
        mutateExternalDirectory("更新联系人失败") {
            externalContactRepository.updateContact(organizationId, contact.contactId, action)
        }
    }

    public fun resolveInvitation(
        invitation: ContactInvitation,
        action: String,
        acceptAsOrganizationId: String? = null,
    ) {
        val organizationId = activeOrganizationId
        if (organizationId.isBlank() || _uiState.value.isMutatingExternalContact) return
        mutateExternalDirectory("处理联系人申请失败") {
            if (action == "accept") {
                val destinationId = acceptAsOrganizationId
                    ?: throw IllegalStateException("请选择一个不同于申请方的组织身份后再同意")
                externalContactRepository.accept(destinationId, invitation.invitationId)
            } else {
                externalContactRepository.resolveInvitation(
                    organizationId,
                    invitation.invitationId,
                    action,
                )
            }
        }
    }

    private fun mutateExternalDirectory(
        fallbackError: String,
        mutation: suspend () -> Unit,
    ) {
        val organizationId = activeOrganizationId
        viewModelScope.safeLaunch(
            onError = { error ->
                if (activeOrganizationId == organizationId) {
                    _uiState.update {
                        it.copy(
                            isMutatingExternalContact = false,
                            externalContactsErrorMessage = error.message ?: fallbackError,
                        )
                    }
                }
            },
        ) {
            _uiState.update {
                it.copy(isMutatingExternalContact = true, externalContactsErrorMessage = null)
            }
            mutation()
            if (activeOrganizationId == organizationId) {
                _uiState.update { it.copy(isMutatingExternalContact = false) }
                reload()
            }
        }
    }

    public suspend fun openDirectMessage(
        userId: String,
        displayName: String,
    ): Result<ContactDirectMessageTarget> {
        if (userId.isBlank()) {
            return Result.failure(IllegalArgumentException("缺少目标用户"))
        }
        if (userId == currentUserId) {
            return Result.failure(IllegalArgumentException("不能给自己发私信"))
        }
        val organizationId = activeOrganizationId.takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("组织信息尚未就绪"))
        _uiState.update { it.copy(isOpeningDm = true) }
        return try {
            runCatching {
                val conversationId = resolveDirectMessageConversationId(
                    conversations = conversationStore.conversations.value,
                    organizationId = organizationId,
                    otherUserId = userId,
                ) {
                    conversationService.createOrGetDM(organizationId, userId)
                }
                check(conversationId.isNotBlank()) { "私信会话创建失败" }
                conversationStore.rememberDirectMessage(
                    conversationId = conversationId,
                    organizationId = organizationId,
                    otherUserId = userId,
                    displayName = displayName,
                )
                ContactDirectMessageTarget(
                    conversationId = conversationId,
                    title = displayName.ifBlank { "私信" },
                )
            }
        } finally {
            _uiState.update { it.copy(isOpeningDm = false) }
        }
    }

    public suspend fun openExternalDirectMessage(
        contact: ExternalContact,
    ): Result<ContactDirectMessageTarget> {
        if (contact.contactId.isBlank()) {
            return Result.failure(IllegalArgumentException("缺少外部联系人"))
        }
        val organizationId = activeOrganizationId.takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("组织信息尚未就绪"))
        _uiState.update { it.copy(isOpeningDm = true) }
        return try {
            runCatching {
                val conversationId = conversationService.createOrGetExternalDM(
                    organizationId = organizationId,
                    externalContactId = contact.contactId,
                )
                check(conversationId.isNotBlank()) { "外部私信会话创建失败" }
                conversationStore.rememberExternalDirectMessage(
                    conversationId = conversationId,
                    organizationId = organizationId,
                    peerUserId = contact.peerUserId,
                    displayName = contact.displayName,
                )
                ContactDirectMessageTarget(
                    conversationId = conversationId,
                    title = contact.displayName.ifBlank { contact.peerOrganizationName.ifBlank { "外部联系人" } },
                )
            }
        } finally {
            _uiState.update { it.copy(isOpeningDm = false) }
        }
    }

    /** 创建群聊，成功后由调用方切入新会话。 */
    public suspend fun createGroup(
        name: String,
        memberIds: Set<String>,
        externalContactIds: Set<String> = emptySet(),
    ): Result<ContactDirectMessageTarget> {
        val organizationId = activeOrganizationId.takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("组织信息尚未就绪"))
        val normalizedName = name.trim()
        if (normalizedName.isEmpty()) return Result.failure(IllegalArgumentException("请输入群聊名称"))
        val recipients = memberIds
            .filter { it.isNotBlank() && it != currentUserId }
            .distinct()
            .sorted()
        val externalRecipients = externalContactIds.filter { it.isNotBlank() }.distinct().sorted()
        if (recipients.isEmpty() && externalRecipients.isEmpty()) {
            return Result.failure(IllegalArgumentException("请至少选择一位成员"))
        }
        val attempt = resolveImGroupCreationAttempt(
            previous = pendingGroupAttempt,
            organizationId = organizationId,
            name = normalizedName,
            memberIds = recipients,
            externalContactIds = externalRecipients,
        )
        pendingGroupAttempt = attempt
        _uiState.update { it.copy(isCreatingGroup = true) }
        return try {
            runCatching {
                val target = completeImGroupCreation(
                    attempt = attempt,
                    createConversation = {
                        if (it.externalContactIds.isEmpty()) {
                            conversationService.createGroup(
                                organizationId = it.organizationId,
                                name = it.name,
                                memberIds = it.memberIds,
                                clientRequestId = it.clientRequestId,
                            )
                        } else {
                            conversationService.createExternalGroup(
                                organizationId = it.organizationId,
                                name = it.name,
                                memberIds = it.memberIds,
                                externalContactIds = it.externalContactIds,
                                clientRequestId = it.clientRequestId,
                            )
                        }
                    },
                    refreshCatalog = conversationStore::reload,
                    isOrganizationActive = { activeOrganizationId == organizationId },
                )
                if (pendingGroupAttempt == attempt) pendingGroupAttempt = null
                target
            }
        } finally {
            _uiState.update { it.copy(isCreatingGroup = false) }
        }
    }
}

private suspend fun <T> resultOfSuspend(block: suspend () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        Result.failure(error)
    }

internal data class ImGroupCreationAttempt(
    val organizationId: String,
    val name: String,
    val memberIds: List<String>,
    val clientRequestId: String,
    val externalContactIds: List<String> = emptyList(),
)

internal fun resolveImGroupCreationAttempt(
    previous: ImGroupCreationAttempt?,
    organizationId: String,
    name: String,
    memberIds: List<String>,
    externalContactIds: List<String> = emptyList(),
    requestIdFactory: () -> String = { UUID.randomUUID().toString() },
): ImGroupCreationAttempt {
    val normalizedMembers = memberIds.distinct().sorted()
    val normalizedExternalContacts = externalContactIds.distinct().sorted()
    if (
        previous?.organizationId == organizationId &&
        previous.name == name &&
        previous.memberIds == normalizedMembers &&
        previous.externalContactIds == normalizedExternalContacts
    ) {
        return previous
    }
    return ImGroupCreationAttempt(
        organizationId = organizationId,
        name = name,
        memberIds = normalizedMembers,
        clientRequestId = requestIdFactory(),
        externalContactIds = normalizedExternalContacts,
    )
}

internal suspend fun completeImGroupCreation(
    attempt: ImGroupCreationAttempt,
    createConversation: suspend (ImGroupCreationAttempt) -> String,
    refreshCatalog: suspend (organizationId: String) -> Boolean,
    isOrganizationActive: () -> Boolean = { true },
): ContactDirectMessageTarget {
    val conversationId = createConversation(attempt)
    check(conversationId.isNotBlank()) { "群聊创建失败" }
    check(isOrganizationActive()) { "组织已切换" }
    // `reload()` 会先刷新会话目录。只有它完成后才把 target
    // 返回给 UI，避免刚建群便导航时 binding 尚未可用。
    check(refreshCatalog(attempt.organizationId)) { "会话目录刷新失败" }
    check(isOrganizationActive()) { "组织已切换" }
    return ContactDirectMessageTarget(conversationId = conversationId, title = attempt.name)
}

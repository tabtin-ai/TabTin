package com.tabtin.mobile.features.workspace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.im.ContactInvitation
import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.data.im.ExternalContactCandidate
import com.tabtin.mobile.data.im.ExternalContactRepository
import com.tabtin.mobile.data.im.ImConversationService
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.repository.OrganizationRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

public data class ExternalContactsUiState(
    val contacts: List<ExternalContact> = emptyList(),
    val invitations: List<ContactInvitation> = emptyList(),
    val phone: String = "",
    val candidate: ExternalContactCandidate? = null,
    val isLoading: Boolean = false,
    val isBusy: Boolean = false,
    val errorMessage: String? = null,
)

public data class ExternalContactConversationTarget(
    val conversationId: String,
    val title: String,
)

@HiltViewModel
public class ExternalContactsViewModel @Inject constructor(
    private val repository: ExternalContactRepository,
    private val organizationRepository: OrganizationRepository,
    private val conversationService: ImConversationService,
    private val conversationStore: ImConversationStore,
) : ViewModel() {
    private val _uiState = MutableStateFlow(ExternalContactsUiState())
    public val uiState: StateFlow<ExternalContactsUiState> = _uiState.asStateFlow()

    private var activeOrganizationId: String = ""

    public fun activate(organizationId: String) {
        if (organizationId == activeOrganizationId && _uiState.value.contacts.isNotEmpty()) return
        activeOrganizationId = organizationId
        _uiState.value = ExternalContactsUiState()
        reload()
    }

    public fun setPhone(phone: String) {
        _uiState.update { it.copy(phone = phone, candidate = null, errorMessage = null) }
    }

    public fun reload() {
        val organizationId = activeOrganizationId
        if (organizationId.isBlank()) return
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, errorMessage = null) }
            runCatching {
                val contacts = repository.list(organizationId).filter { it.relationship == "friend" }
                val invitations = repository.pendingInvitations(organizationId)
                contacts to invitations
            }.onSuccess { (contacts, invitations) ->
                if (activeOrganizationId == organizationId) {
                    _uiState.update {
                        it.copy(contacts = contacts, invitations = invitations, isLoading = false)
                    }
                }
            }.onFailure { error ->
                if (activeOrganizationId == organizationId) {
                    _uiState.update {
                        it.copy(isLoading = false, errorMessage = error.message ?: "加载外部联系人失败")
                    }
                }
            }
        }
    }

    public fun discoverAndInvite() {
        val organizationId = activeOrganizationId
        val phone = _uiState.value.phone.trim()
        if (organizationId.isBlank() || phone.isBlank() || _uiState.value.isBusy) return
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, errorMessage = null) }
            runCatching {
                val candidate = repository.discover(organizationId, phone)
                if (candidate.relationship == "none" || candidate.relationship == "removed") {
                    repository.invite(organizationId, candidate.userId)
                    candidate.copy(relationship = "pending")
                } else {
                    candidate
                }
            }.onSuccess { candidate ->
                _uiState.update { it.copy(candidate = candidate, isBusy = false) }
                reload()
            }.onFailure { error ->
                _uiState.update {
                    it.copy(isBusy = false, candidate = null, errorMessage = error.message ?: "查找联系人失败")
                }
            }
        }
    }

    public fun acceptInvitation(invitation: ContactInvitation) {
        resolveInvitation(invitation, "accept")
    }

    public fun rejectInvitation(invitation: ContactInvitation) {
        resolveInvitation(invitation, "reject")
    }

    private fun resolveInvitation(invitation: ContactInvitation, action: String) {
        val organizationId = activeOrganizationId
        if (organizationId.isBlank() || _uiState.value.isBusy) return
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, errorMessage = null) }
            runCatching {
                if (action == "accept") {
                    val eligibleOrganizationId = organizationId
                        .takeIf { it != invitation.peerOrganizationId }
                        ?: organizationRepository.organizations.value.firstOrNull {
                            it.id != invitation.peerOrganizationId
                        }?.id
                        ?: throw IllegalStateException("没有可用于建立联系的组织")
                    repository.accept(eligibleOrganizationId, invitation.invitationId)
                } else {
                    repository.resolveInvitation(organizationId, invitation.invitationId, action)
                }
            }.onSuccess {
                _uiState.update { it.copy(isBusy = false) }
                reload()
            }.onFailure { error ->
                _uiState.update {
                    it.copy(isBusy = false, errorMessage = error.message ?: "处理联系人邀请失败")
                }
            }
        }
    }

    public fun removeContact(contact: ExternalContact) {
        val organizationId = activeOrganizationId
        if (organizationId.isBlank() || _uiState.value.isBusy) return
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, errorMessage = null) }
            runCatching { repository.updateContact(organizationId, contact.contactId, "remove") }
                .onSuccess {
                    _uiState.update { state ->
                        state.copy(isBusy = false, contacts = state.contacts.filter { it.contactId != contact.contactId })
                    }
                }
                .onFailure { error ->
                    _uiState.update { it.copy(isBusy = false, errorMessage = error.message ?: "移除联系人失败") }
                }
        }
    }

    public suspend fun openConversation(contact: ExternalContact): Result<ExternalContactConversationTarget> {
        if (_uiState.value.isBusy) {
            return Result.failure(IllegalStateException("正在处理其他联系人操作"))
        }
        _uiState.update { it.copy(isBusy = true, errorMessage = null) }
        return try {
            runCatching {
                val organizationId = activeOrganizationId
                check(organizationId.isNotBlank()) { "组织信息尚未就绪" }
                val conversationId = conversationService.createOrGetExternalDM(organizationId, contact.contactId)
                check(conversationId.isNotBlank()) { "外部会话创建失败" }
                conversationStore.rememberExternalDirectMessage(
                    conversationId = conversationId,
                    organizationId = organizationId,
                    peerUserId = contact.peerUserId,
                    displayName = contact.displayName,
                )
                ExternalContactConversationTarget(
                    conversationId = conversationId,
                    title = contact.displayName.ifBlank { contact.peerOrganizationName.ifBlank { "外部联系人" } },
                )
            }.onFailure { error ->
                _uiState.update { it.copy(errorMessage = error.message ?: "打开外部会话失败") }
            }
        } finally {
            _uiState.update { it.copy(isBusy = false) }
        }
    }
}

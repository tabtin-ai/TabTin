package com.tabtin.mobile.features.tabchat

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImConversationService
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.im.ImMessageStore
import com.tabtin.mobile.data.im.ImMessageTransport
import com.tabtin.mobile.data.im.ImOutgoingCard
import com.tabtin.mobile.data.im.ImResourceCardType
import com.tabtin.mobile.data.im.ImSendOutcome
import com.tabtin.mobile.data.im.resolveDirectMessageConversationId
import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.repository.CloudDocsShareService
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class ResourceDirectMessageResource(
    val resourceType: String,
    val resourceId: String,
    val name: String,
    val organizationId: String,
    val spaceId: String?,
    val currentUserRole: String? = null,
) {
    init {
        require(resourceType == ImResourceCardType.DOCUMENT || resourceType == ImResourceCardType.TABLE)
        require(resourceId.isNotBlank())
        require(organizationId.isNotBlank())
    }

    fun toOutgoingCard(): ImOutgoingCard = ImOutgoingCard.resource(
        type = resourceType,
        resourceId = resourceId,
        name = name,
        spaceId = spaceId,
        organizationId = organizationId,
    )

    val requiresViewerInvite: Boolean
        get() = currentUserRole?.trim()?.lowercase() in setOf("owner", "admin")

    val cloudShareType: CloudShareResourceType
        get() = when (resourceType) {
            ImResourceCardType.DOCUMENT -> CloudShareResourceType.DOCUMENT
            else -> CloudShareResourceType.TABLE
        }
}

internal enum class ResourceDirectMessageSharePhase {
    IDLE,
    SENDING,
    FAILED,
    SENT,
}

internal data class ResourceDirectMessageShareUiState(
    val resourceName: String = "",
    val members: List<OrganizationMember> = emptyList(),
    val query: String = "",
    val selectedUserId: String? = null,
    val isLoading: Boolean = true,
    val hasLoadedRecipients: Boolean = false,
    val phase: ResourceDirectMessageSharePhase = ResourceDirectMessageSharePhase.IDLE,
    @StringRes val errorRes: Int? = null,
    val sentRecipientName: String = "",
) {
    val isSending: Boolean get() = phase == ResourceDirectMessageSharePhase.SENDING

    val visibleMembers: List<OrganizationMember>
        get() {
            val normalized = query.trim().lowercase()
            if (normalized.isEmpty()) return members
            return members.filter { member ->
                listOfNotNull(
                    member.displayName,
                    member.user?.username,
                    member.user?.email,
                ).any { it.lowercase().contains(normalized) }
            }
        }
}

@HiltViewModel
internal class ResourceDirectMessageShareViewModel @Inject constructor(
    private val organizationRepository: OrganizationRepository,
    private val cloudDocsShareService: CloudDocsShareService,
    private val conversationService: ImConversationService,
    private val conversationStore: ImConversationStore,
    private val messageTransport: ImMessageTransport,
    private val tokenManager: TokenManager,
) : ViewModel() {
    private val _uiState = MutableStateFlow(ResourceDirectMessageShareUiState())
    val uiState: StateFlow<ResourceDirectMessageShareUiState> = _uiState.asStateFlow()

    private var activeResource: ResourceDirectMessageResource? = null
    private var activeAttempt: SendAttempt? = null
    private var loadJob: Job? = null
    private var sendJob: Job? = null

    fun activate(resource: ResourceDirectMessageResource) {
        if (activeResource == resource && _uiState.value.hasLoadedRecipients) return
        loadJob?.cancel()
        sendJob?.cancel()
        activeResource = resource
        activeAttempt = null
        _uiState.value = ResourceDirectMessageShareUiState(resourceName = resource.name)
        loadJob = viewModelScope.launch { loadMembers(resource) }
    }

    fun setQuery(query: String) {
        if (_uiState.value.isSending) return
        _uiState.update {
            it.copy(
                query = query,
                selectedUserId = null,
                phase = ResourceDirectMessageSharePhase.IDLE,
                errorRes = null,
            )
        }
        activeAttempt = null
    }

    fun selectRecipient(userId: String) {
        val state = _uiState.value
        if (state.isSending || state.members.none { it.userId == userId }) return
        if (state.phase == ResourceDirectMessageSharePhase.FAILED && state.selectedUserId == userId) return
        if (state.selectedUserId != userId) activeAttempt = null
        _uiState.update {
            it.copy(
                selectedUserId = userId,
                phase = ResourceDirectMessageSharePhase.IDLE,
                errorRes = null,
            )
        }
    }

    fun reloadMembers() {
        val resource = activeResource ?: return
        if (_uiState.value.isSending) return
        loadJob?.cancel()
        _uiState.update {
            it.copy(
                isLoading = true,
                hasLoadedRecipients = false,
                errorRes = null,
            )
        }
        loadJob = viewModelScope.launch { loadMembers(resource) }
    }

    fun submit() {
        val resource = activeResource ?: return
        val state = _uiState.value
        val userId = state.selectedUserId ?: return
        val member = state.members.firstOrNull { it.userId == userId } ?: return
        if (state.isSending) return

        val attempt = SendAttempt(
            resource = resource,
            recipientUserId = userId,
            recipientName = member.displayName,
            card = resource.toOutgoingCard(),
            clientRequestId = UUID.randomUUID().toString(),
        )
        activeAttempt = attempt
        launchAttempt(attempt)
    }

    fun retrySend() {
        val attempt = activeAttempt ?: return
        if (_uiState.value.isSending) return
        launchAttempt(attempt)
    }

    fun reset() {
        loadJob?.cancel()
        sendJob?.cancel()
        loadJob = null
        sendJob = null
        activeResource = null
        activeAttempt = null
        _uiState.value = ResourceDirectMessageShareUiState()
    }

    private suspend fun loadMembers(resource: ResourceDirectMessageResource) {
        val currentUserId = tokenManager.userId?.takeIf(String::isNotBlank)
        if (currentUserId == null) {
            if (activeResource == resource) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        errorRes = R.string.resource_dm_share_identity_unavailable,
                    )
                }
            }
            return
        }
        try {
            val members = organizationRepository.loadMembers(resource.organizationId)
                .filter { it.userId.isNotBlank() && it.userId != currentUserId }
                .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.displayName })
            if (activeResource != resource) return
            _uiState.update {
                it.copy(
                    members = members,
                    selectedUserId = it.selectedUserId?.takeIf { selected ->
                        members.any { member -> member.userId == selected }
                    },
                    isLoading = false,
                    hasLoadedRecipients = true,
                    errorRes = null,
                )
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            if (activeResource != resource) return
            _uiState.update {
                it.copy(
                    isLoading = false,
                    hasLoadedRecipients = false,
                    errorRes = R.string.resource_dm_share_members_load_failed,
                )
            }
        }
    }

    private fun launchAttempt(attempt: SendAttempt) {
        sendJob?.cancel()
        _uiState.update {
            it.copy(
                phase = ResourceDirectMessageSharePhase.SENDING,
                errorRes = null,
            )
        }
        sendJob = viewModelScope.launch { performAttempt(attempt) }
    }

    private suspend fun performAttempt(attempt: SendAttempt) {
        try {
            if (attempt.resource.requiresViewerInvite && !attempt.accessCheckCompleted) {
                val access = cloudDocsShareService.collaborators(
                    type = attempt.resource.cloudShareType,
                    resourceId = attempt.resource.resourceId,
                )
                val alreadyHasAccess = access.owner.userId == attempt.recipientUserId ||
                    access.collaborators.any { it.userId == attempt.recipientUserId }
                if (!alreadyHasAccess) {
                    cloudDocsShareService.inviteCollaborators(
                        type = attempt.resource.cloudShareType,
                        resourceId = attempt.resource.resourceId,
                        userIds = listOf(attempt.recipientUserId),
                        permission = "viewer",
                    )
                }
                attempt.accessCheckCompleted = true
            }
            if (!isActive(attempt)) return

            val conversationId = attempt.conversationId ?: resolveDirectMessageConversationId(
                conversations = conversationStore.conversations.value,
                organizationId = attempt.resource.organizationId,
                otherUserId = attempt.recipientUserId,
            ) {
                conversationService.createOrGetDM(
                    attempt.resource.organizationId,
                    attempt.recipientUserId,
                )
            }.also { resolved ->
                check(resolved.isNotBlank()) { "empty direct-message conversation id" }
                attempt.conversationId = resolved
                conversationStore.rememberDirectMessage(
                    conversationId = resolved,
                    organizationId = attempt.resource.organizationId,
                    otherUserId = attempt.recipientUserId,
                    displayName = attempt.recipientName,
                )
            }
            if (!isActive(attempt)) return

            // 资源页可能从未打开过消息入口；发送前激活数据面并刷新 catalog，确保新建 DM 可寻址。
            messageTransport.activate(attempt.resource.organizationId)
            if (!isActive(attempt)) return

            val store = attempt.store ?: ImMessageStore(
                conversationId = conversationId,
                transport = messageTransport,
                scope = viewModelScope,
            ).also {
                it.currentUserId = tokenManager.userId
                attempt.store = it
            }
            val outcome = store.performSend(
                content = attempt.card.fallbackContent,
                card = attempt.card,
                clientRequestId = attempt.clientRequestId,
                isRetry = attempt.hasPendingMessage,
            )
            if (!isActive(attempt)) return
            when (outcome) {
                ImSendOutcome.ENQUEUED,
                ImSendOutcome.CONFIRMED,
                -> {
                    _uiState.update {
                        it.copy(
                            phase = ResourceDirectMessageSharePhase.SENT,
                            errorRes = null,
                            sentRecipientName = attempt.recipientName,
                        )
                    }
                }
                ImSendOutcome.FAILED_PENDING -> {
                    attempt.hasPendingMessage = true
                    showSendFailure(R.string.resource_dm_share_send_failed)
                }
                ImSendOutcome.REJECTED_TOO_LONG ->
                    showSendFailure(R.string.resource_dm_share_name_too_long)
                ImSendOutcome.REJECTED_READ_ONLY ->
                    showSendFailure(R.string.resource_dm_share_recipient_unavailable)
                ImSendOutcome.REJECTED_IN_FLIGHT,
                ImSendOutcome.DISCARDED_AFTER_CLEAR,
                -> showSendFailure(R.string.resource_dm_share_send_failed)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            if (isActive(attempt)) showSendFailure(R.string.resource_dm_share_send_failed)
        }
    }

    private fun showSendFailure(@StringRes errorRes: Int) {
        _uiState.update {
            it.copy(
                phase = ResourceDirectMessageSharePhase.FAILED,
                errorRes = errorRes,
            )
        }
    }

    private fun isActive(attempt: SendAttempt): Boolean =
        activeAttempt === attempt && activeResource == attempt.resource

    private data class SendAttempt(
        val resource: ResourceDirectMessageResource,
        val recipientUserId: String,
        val recipientName: String,
        val card: ImOutgoingCard,
        val clientRequestId: String,
        var conversationId: String? = null,
        var store: ImMessageStore? = null,
        var hasPendingMessage: Boolean = false,
        var accessCheckCompleted: Boolean = false,
    )
}

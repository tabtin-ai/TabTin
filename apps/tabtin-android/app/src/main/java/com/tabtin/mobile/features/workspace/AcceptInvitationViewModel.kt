package com.tabtin.mobile.features.workspace

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.InvitationInfo
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import retrofit2.HttpException
import javax.inject.Inject

internal sealed interface InviteError {
    @get:StringRes public val messageRes: Int

    public data object Invalid : InviteError { override val messageRes: Int = R.string.ws_invite_invalid }
    public data object Network : InviteError { override val messageRes: Int = R.string.error_network }
    public data object Generic : InviteError { override val messageRes: Int = R.string.ws_invite_error_generic }
}

internal data class AcceptInvitationUiState(
    val invitationInfo: InvitationInfo? = null,
    val isLoading: Boolean = true,
    val isAccepting: Boolean = false,
    val inviteError: InviteError? = null,
    val accepted: Boolean = false,
    val acceptedOrganizationName: String? = null,
) {
    val canRetry: Boolean get() = inviteError != null && inviteError !is InviteError.Invalid
}

@HiltViewModel
public class AcceptInvitationViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val organizationRepository: OrganizationRepository,
) : ViewModel() {

    public val token: String = savedStateHandle["token"] ?: ""

    private val _uiState = MutableStateFlow(AcceptInvitationUiState())
    internal val uiState: StateFlow<AcceptInvitationUiState> = _uiState.asStateFlow()

    private var lastFailedAction: FailedAction? = null

    private enum class FailedAction { LOAD, ACCEPT }

    init {
        if (token.isNotBlank()) {
            loadInvitationInfo()
        } else {
            _uiState.update { it.copy(isLoading = false, inviteError = InviteError.Invalid) }
        }
    }

    private fun loadInvitationInfo() {
        viewModelScope.safeLaunch(onError = { e ->
            lastFailedAction = FailedAction.LOAD
            _uiState.update { it.copy(inviteError = classifyError(e), isLoading = false) }
        }) {
            _uiState.update { it.copy(isLoading = true, inviteError = null) }
            val info = organizationRepository.getInvitationInfo(token)
            _uiState.update {
                it.copy(
                    invitationInfo = info,
                    inviteError = if (!info.valid) InviteError.Invalid else null,
                    isLoading = false,
                )
            }
        }
    }

    public fun acceptInvitation() {
        viewModelScope.safeLaunch(onError = { e ->
            lastFailedAction = FailedAction.ACCEPT
            _uiState.update { it.copy(inviteError = classifyError(e), isAccepting = false) }
        }) {
            _uiState.update { it.copy(isAccepting = true, inviteError = null) }
            val resp = organizationRepository.acceptInvitation(token)
            _uiState.update { it.copy(accepted = true, acceptedOrganizationName = resp.workspaceName, isAccepting = false) }
        }
    }

    public fun retry() {
        when (lastFailedAction) {
            FailedAction.LOAD -> loadInvitationInfo()
            FailedAction.ACCEPT -> acceptInvitation()
            null -> loadInvitationInfo()
        }
    }

    private fun classifyError(e: Exception): InviteError = when {
        e is HttpException && e.code() in listOf(404, 410, 403) -> InviteError.Invalid
        else -> ErrorClassifier.classifyAs(e, InviteError.Network, InviteError.Generic, InviteError.Generic)
    }
}

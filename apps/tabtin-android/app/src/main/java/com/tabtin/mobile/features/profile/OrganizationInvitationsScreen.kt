package com.tabtin.mobile.features.profile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Email
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.PendingInvitation
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.features.workspace.InvitationResponseSheet
import com.tabtin.mobile.features.workspace.localizedRoleName
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import javax.inject.Inject

public data class OrganizationInvitationsUiState(
    val invitations: List<PendingInvitation> = emptyList(),
    val isLoading: Boolean = true,
    val loadFailed: Boolean = false,
    val actionFailed: Boolean = false,
    val respondingInvitationId: String? = null,
)

@HiltViewModel
public class OrganizationInvitationsViewModel @Inject constructor(
    private val repository: OrganizationRepository,
) : ViewModel() {
    public var uiState: OrganizationInvitationsUiState by mutableStateOf(OrganizationInvitationsUiState())
        private set

    private var loadSequence: Int = 0

    init {
        refresh()
        viewModelScope.launch {
            repository.invitationUpdates.collectLatest { refresh() }
        }
    }

    public fun refresh() {
        val sequence = ++loadSequence
        viewModelScope.launch {
            uiState = uiState.copy(isLoading = true, loadFailed = false, actionFailed = false)
            repository.getMyPendingInvitations()
                .onSuccess { invitations ->
                    if (sequence == loadSequence) {
                        uiState = uiState.copy(
                            invitations = invitations,
                            isLoading = false,
                            loadFailed = false,
                        )
                    }
                }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    if (sequence == loadSequence) {
                        uiState = uiState.copy(
                            isLoading = false,
                            loadFailed = true,
                        )
                    }
                }
        }
    }

    public fun respondToInvitation(invitationId: String, accept: Boolean) {
        if (uiState.respondingInvitationId != null) return
        uiState = uiState.copy(respondingInvitationId = invitationId, actionFailed = false)
        viewModelScope.launch {
            repository.respondToInvitation(invitationId, accept)
                .onSuccess {
                    ++loadSequence
                    uiState = uiState.copy(
                        invitations = uiState.invitations.filterNot { it.id == invitationId },
                        isLoading = false,
                        loadFailed = false,
                        actionFailed = false,
                        respondingInvitationId = null,
                    )
                    if (accept) repository.loadOrganizations()
                }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    uiState = uiState.copy(
                        respondingInvitationId = null,
                        actionFailed = true,
                    )
                }
        }
    }

    public fun consumeError() {
        uiState = uiState.copy(actionFailed = false)
    }
}

/** 账号级组织邀请收件箱；通知中心点击和后续账号入口共用同一处理层。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun OrganizationInvitationsScreen(
    onBack: () -> Unit,
    viewModel: OrganizationInvitationsViewModel = hiltViewModel(),
) {
    val state = viewModel.uiState
    var selectedInvitationId by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedInvitation = state.invitations.firstOrNull { it.id == selectedInvitationId }
    val snackbarHostState = remember { SnackbarHostState() }
    val loadFailure = stringResource(R.string.organization_invitations_load_failed)
    val actionFailure = stringResource(R.string.organization_invitations_action_failed)

    LaunchedEffect(selectedInvitationId, selectedInvitation) {
        if (selectedInvitationId != null && selectedInvitation == null) {
            selectedInvitationId = null
        }
    }
    LaunchedEffect(state.actionFailed) {
        if (!state.actionFailed) return@LaunchedEffect
        snackbarHostState.showSnackbar(actionFailure)
        viewModel.consumeError()
    }
    LaunchedEffect(state.loadFailed) {
        if (state.loadFailed && state.invitations.isNotEmpty()) {
            snackbarHostState.showSnackbar(loadFailure)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.organization_invitations_title),
                        style = TTFonts.subtitleSemibold,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { innerPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.invitations.isNotEmpty(),
            onRefresh = viewModel::refresh,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            when {
                state.isLoading && state.invitations.isEmpty() -> InvitationInboxLoading()
                state.loadFailed && state.invitations.isEmpty() -> InvitationInboxUnavailable(
                    onRetry = viewModel::refresh,
                )
                state.invitations.isEmpty() -> InvitationInboxEmpty()
                else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(state.invitations, key = PendingInvitation::id) { invitation ->
                        InvitationInboxRow(
                            invitation = invitation,
                            onClick = { selectedInvitationId = invitation.id },
                        )
                        HorizontalDivider(
                            color = ttColor(TTColors.Divider, TTColors.Dark.Divider),
                        )
                    }
                }
            }
        }
    }

    selectedInvitation?.let { invitation ->
        InvitationResponseSheet(
            invitation = invitation,
            isResponding = state.respondingInvitationId == invitation.id,
            onAccept = { viewModel.respondToInvitation(invitation.id, accept = true) },
            onReject = { viewModel.respondToInvitation(invitation.id, accept = false) },
            onDismiss = { selectedInvitationId = null },
        )
    }
}

@Composable
private fun InvitationInboxLoading() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
private fun InvitationInboxUnavailable(onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Default.Email,
            contentDescription = null,
            tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(TTSpacing.md))
        Text(
            text = stringResource(R.string.organization_invitations_load_failed),
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(TTSpacing.sm))
        TextButton(onClick = onRetry) {
            Text(
                text = stringResource(R.string.common_retry),
                style = TTFonts.bodyMedium,
            )
        }
    }
}

@Composable
private fun InvitationInboxEmpty() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Default.Email,
            contentDescription = null,
            tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(TTSpacing.md))
        Text(
            text = stringResource(R.string.organization_invitations_empty),
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun InvitationInboxRow(invitation: PendingInvitation, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.xl, vertical = TTSpacing.lg),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (invitation.workspaceIcon.isNotBlank()) {
            Text(text = invitation.workspaceIcon, style = TTFonts.iconEmpty)
        } else {
            TTAvatar(
                name = invitation.workspaceName,
                imageUrl = null,
                size = 32.dp,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = invitation.workspaceName,
                style = TTFonts.subtitle,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val role = localizedRoleName(invitation.role)
            val subtitle = if (invitation.invitedByName.isBlank()) {
                role
            } else {
                "${invitation.invitedByName} · $role"
            }
            Text(
                text = subtitle,
                style = TTFonts.meta,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
        )
    }
}

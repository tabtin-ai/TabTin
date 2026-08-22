package com.tabtin.mobile.features.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun AcceptInvitationScreen(
    viewModel: AcceptInvitationViewModel,
    onBack: () -> Unit,
    onAccepted: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.ws_invite_accept_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(TTSpacing.xl),
            contentAlignment = Alignment.Center,
        ) {
            when {
                state.isLoading -> LoadingContent()

                state.accepted -> AcceptedContent(
                    organizationName = state.acceptedOrganizationName,
                    onDone = onAccepted,
                )

                state.inviteError != null -> ErrorContent(
                    error = state.inviteError!!,
                    canRetry = state.canRetry,
                    onRetry = viewModel::retry,
                    onBack = onBack,
                )

                state.invitationInfo != null -> InvitationContent(
                    info = state.invitationInfo!!,
                    isAccepting = state.isAccepting,
                    onAccept = viewModel::acceptInvitation,
                    onDecline = onBack,
                )

                else -> ErrorContent(
                    error = InviteError.Invalid,
                    canRetry = false,
                    onRetry = {},
                    onBack = onBack,
                )
            }
        }
    }
}

@Composable
private fun LoadingContent() {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        CircularProgressIndicator()
        Text(
            stringResource(R.string.ws_invite_loading),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun AcceptedContent(organizationName: String?, onDone: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        Icon(
            Icons.Default.CheckCircle,
            contentDescription = stringResource(R.string.ws_invite_accepted),
            modifier = Modifier.size(64.dp),
            tint = MaterialTheme.colorScheme.primary,
        )
        Text(
            stringResource(R.string.ws_invite_accepted),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
        )
        organizationName?.let { name ->
            Text(
                name,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(TTSpacing.lg))
        Button(
            onClick = onDone,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.common_done))
        }
    }
}

@Composable
private fun ErrorContent(
    error: InviteError,
    canRetry: Boolean,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        Icon(
            Icons.Default.ErrorOutline,
            contentDescription = stringResource(error.messageRes),
            modifier = Modifier.size(64.dp),
            tint = MaterialTheme.colorScheme.error,
        )
        Text(
            stringResource(error.messageRes),
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(TTSpacing.md))
        if (canRetry) {
            Button(
                onClick = onRetry,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.common_retry))
            }
        }
        OutlinedButton(
            onClick = onBack,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.common_back))
        }
    }
}

@Composable
private fun InvitationContent(
    info: com.tabtin.mobile.data.model.InvitationInfo,
    isAccepting: Boolean,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            stringResource(R.string.ws_invite_accept_desc),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(TTSpacing.md))

        Text(
            info.workspaceName ?: "",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
        )

        info.role?.let { role ->
            Text(
                stringResource(R.string.ws_invite_accept_role, localizedRoleName(role)),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(TTSpacing.xxl))

        Button(
            onClick = onAccept,
            enabled = !isAccepting,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (isAccepting) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
                Spacer(Modifier.size(TTSpacing.sm))
            }
            Text(stringResource(R.string.ws_invite_accept))
        }

        OutlinedButton(
            onClick = onDecline,
            enabled = !isAccepting,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.ws_invite_decline))
        }
    }
}

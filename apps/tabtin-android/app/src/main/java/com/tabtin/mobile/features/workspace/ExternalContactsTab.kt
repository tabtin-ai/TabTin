package com.tabtin.mobile.features.workspace

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ContactInvitation
import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.launch

@Composable
public fun ExternalContactsTab(
    organizationId: String,
    onOpenConversation: (conversationId: String, title: String) -> Unit,
    viewModel: ExternalContactsViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    LaunchedEffect(organizationId) { viewModel.activate(organizationId) }

    Column(
        modifier = Modifier.fillMaxSize().padding(TTSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Text(
            stringResource(R.string.external_contacts_description),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = state.phone,
                onValueChange = viewModel::setPhone,
                modifier = Modifier.weight(1f),
                singleLine = true,
                label = { Text(stringResource(R.string.external_contacts_phone)) },
            )
            Button(onClick = viewModel::discoverAndInvite, enabled = state.phone.isNotBlank() && !state.isBusy) {
                if (state.isBusy) CircularProgressIndicator(strokeWidth = 2.dp)
                else Text(stringResource(R.string.external_contacts_add))
            }
        }
        state.errorMessage?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        state.candidate?.let { candidate ->
            Row(modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.xs), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.PersonAdd, contentDescription = null)
                Column(modifier = Modifier.weight(1f).padding(start = TTSpacing.sm)) {
                    Text(candidate.displayName.ifBlank { candidate.userId })
                    Text(candidate.relationship, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (state.isLoading && state.contacts.isEmpty() && state.invitations.isEmpty()) {
            CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs), modifier = Modifier.fillMaxSize()) {
            if (state.invitations.isNotEmpty()) {
                item { Text(stringResource(R.string.external_contacts_pending), style = MaterialTheme.typography.titleSmall) }
                items(state.invitations, key = { it.invitationId }) { invitation ->
                    InvitationRow(
                        invitation = invitation,
                        enabled = !state.isBusy,
                        onAccept = { viewModel.acceptInvitation(invitation) },
                        onReject = { viewModel.rejectInvitation(invitation) },
                    )
                }
                item { HorizontalDivider(modifier = Modifier.padding(vertical = TTSpacing.sm)) }
            }
            item { Text(stringResource(R.string.external_contacts_title), style = MaterialTheme.typography.titleSmall) }
            if (state.contacts.isEmpty() && !state.isLoading) {
                item { Text(stringResource(R.string.external_contacts_empty), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            items(state.contacts, key = { it.contactId }) { contact ->
                ContactRow(
                    contact = contact,
                    enabled = !state.isBusy,
                    onOpen = {
                        scope.launch {
                            viewModel.openConversation(contact).onSuccess { target ->
                                onOpenConversation(target.conversationId, target.title)
                            }.onFailure { error ->
                                Toast.makeText(
                                    context,
                                    error.message ?: "打开外部会话失败",
                                    Toast.LENGTH_LONG,
                                ).show()
                            }
                        }
                    },
                    onRemove = { viewModel.removeContact(contact) },
                )
            }
        }
    }
}

@Composable
private fun ContactRow(
    contact: ExternalContact,
    enabled: Boolean,
    onOpen: () -> Unit,
    onRemove: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onOpen).padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Person, contentDescription = null)
        Column(modifier = Modifier.weight(1f).padding(start = TTSpacing.sm)) {
            Text(contact.displayName.ifBlank { contact.peerUserId })
            Text(contact.peerOrganizationName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton(onClick = onRemove, enabled = enabled) { Text(stringResource(R.string.external_contacts_remove)) }
    }
}

@Composable
private fun InvitationRow(
    invitation: ContactInvitation,
    enabled: Boolean,
    onAccept: () -> Unit,
    onReject: () -> Unit,
) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Default.PersonAdd, contentDescription = null)
        Column(modifier = Modifier.weight(1f).padding(start = TTSpacing.sm)) {
            Text(invitation.displayName.ifBlank { invitation.peerUserId })
            Text(invitation.peerOrganizationName.orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton(onClick = onAccept, enabled = enabled) { Text(stringResource(R.string.external_contacts_accept)) }
        TextButton(onClick = onReject, enabled = enabled) { Text(stringResource(R.string.external_contacts_reject)) }
    }
}

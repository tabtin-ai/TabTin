package com.tabtin.mobile.features.tabchat

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ContactInvitation
import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.launch

/** 消息 → 通讯录：对齐桌面端的组织成员、外部联系人、申请与黑名单分组。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ContactsSection(
    organizationId: String,
    onOpenConversation: (conversationId: String, title: String) -> Unit,
    onAddOrganizationMember: () -> Unit,
    viewModel: ContactsViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val members = viewModel.filteredMembers()
    val externalContacts = viewModel.filteredExternalContacts()
    val blockedContacts = viewModel.filteredBlockedContacts()
    val incomingInvitations = viewModel.filteredIncomingInvitations()
    val outgoingInvitations = viewModel.filteredOutgoingInvitations()
    var showAddDialog by rememberSaveable { mutableStateOf(false) }
    var contactPendingRemoval by remember { mutableStateOf<ExternalContact?>(null) }

    LaunchedEffect(organizationId) { viewModel.activate(organizationId) }
    LaunchedEffect(
        state.selectedTab,
        state.externalContactCandidate,
        state.externalContactPhone,
    ) {
        if (
            showAddDialog &&
            state.selectedTab == ContactsDirectoryTab.OUTGOING &&
            state.externalContactCandidate == null &&
            state.externalContactPhone.isBlank()
        ) {
            showAddDialog = false
        }
    }

    val selectedItemsEmpty = when (state.selectedTab) {
        ContactsDirectoryTab.INTERNAL -> members.isEmpty()
        ContactsDirectoryTab.EXTERNAL -> externalContacts.isEmpty()
        ContactsDirectoryTab.INCOMING -> incomingInvitations.isEmpty()
        ContactsDirectoryTab.OUTGOING -> outgoingInvitations.isEmpty()
        ContactsDirectoryTab.BLOCKED -> blockedContacts.isEmpty()
    }
    val selectedError = state.selectedDirectoryError()

    Column(modifier = Modifier.fillMaxSize()) {
        TabSearchField(
            query = state.query,
            onQueryChange = viewModel::setQuery,
            placeholder = stringResource(R.string.im_contacts_filter),
            modifier = Modifier
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
        )

        ContactsDirectoryTabBar(
            selectedTab = state.selectedTab,
            onSelect = viewModel::selectTab,
        )

        DirectoryTabActions(
            tab = state.selectedTab,
            canAddOrganizationMember = state.canAddOrganizationMember,
            isBusy = state.isMutatingExternalContact,
            onAddOrganizationMember = onAddOrganizationMember,
            onAddExternalContact = { showAddDialog = true },
        )

        if (selectedError != null && !selectedItemsEmpty) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = selectedError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                TextButton(onClick = viewModel::reload) {
                    Text(stringResource(R.string.common_retry))
                }
            }
        }

        PullToRefreshBox(
            isRefreshing = state.isLoading && !selectedItemsEmpty,
            onRefresh = viewModel::reload,
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                state.isLoading && selectedItemsEmpty -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                selectedError != null && selectedItemsEmpty -> {
                    DirectoryError(message = selectedError, onRetry = viewModel::reload)
                }
                selectedItemsEmpty -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            text = stringResource(R.string.external_contacts_empty_generic),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                else -> {
                    LazyColumn(
                        contentPadding = PaddingValues(vertical = TTSpacing.xs),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        when (state.selectedTab) {
                            ContactsDirectoryTab.INTERNAL -> items(members, key = { it.userId }) { member ->
                                val isSelf = member.userId == viewModel.currentUserId
                                ContactRow(
                                    member = member,
                                    isSelf = isSelf,
                                    enabled = !isSelf && !state.isOpeningDm,
                                    onClick = {
                                        if (isSelf) return@ContactRow
                                        scope.launch {
                                            viewModel.openDirectMessage(member.userId, member.displayName)
                                                .onSuccess { target ->
                                                    onOpenConversation(target.conversationId, target.title)
                                                }
                                                .onFailure {
                                                    Toast.makeText(
                                                        context,
                                                        it.message ?: context.getString(R.string.im_dm_open_failed),
                                                        Toast.LENGTH_LONG,
                                                    ).show()
                                                }
                                        }
                                    },
                                )
                            }
                            ContactsDirectoryTab.EXTERNAL -> items(
                                externalContacts,
                                key = { "external:${it.contactId}" },
                            ) { contact ->
                                ExternalContactDirectoryRow(
                                    contact = contact,
                                    enabled = !state.isOpeningDm && !state.isMutatingExternalContact,
                                    onOpen = {
                                        scope.launch {
                                            viewModel.openExternalDirectMessage(contact)
                                                .onSuccess { target ->
                                                    onOpenConversation(target.conversationId, target.title)
                                                }
                                                .onFailure {
                                                    Toast.makeText(
                                                        context,
                                                        it.message ?: context.getString(R.string.im_dm_open_failed),
                                                        Toast.LENGTH_LONG,
                                                    ).show()
                                                }
                                        }
                                    },
                                    onBlock = { viewModel.updateExternalContact(contact, "block") },
                                    onRemove = { contactPendingRemoval = contact },
                                )
                            }
                            ContactsDirectoryTab.BLOCKED -> items(
                                blockedContacts,
                                key = { "blocked:${it.contactId}" },
                            ) { contact ->
                                BlockedContactRow(
                                    contact = contact,
                                    enabled = !state.isMutatingExternalContact,
                                    onBlockedContactClick = {
                                        Toast.makeText(
                                            context,
                                            context.getString(R.string.external_contacts_blocked_message_hint),
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                    },
                                    onUnblock = { viewModel.updateExternalContact(contact, "unblock") },
                                )
                            }
                            ContactsDirectoryTab.INCOMING -> items(
                                incomingInvitations,
                                key = { "incoming:${it.invitationId}" },
                            ) { invitation ->
                                IncomingInvitationRow(
                                    invitation = invitation,
                                    organizations = viewModel.eligibleOrganizations(invitation),
                                    defaultOrganizationId = viewModel.defaultAcceptOrganizationId(invitation),
                                    enabled = !state.isMutatingExternalContact,
                                    onAccept = { destinationId ->
                                        viewModel.resolveInvitation(invitation, "accept", destinationId)
                                    },
                                    onReject = { viewModel.resolveInvitation(invitation, "reject") },
                                )
                            }
                            ContactsDirectoryTab.OUTGOING -> items(
                                outgoingInvitations,
                                key = { "outgoing:${it.invitationId}" },
                            ) { invitation ->
                                OutgoingInvitationRow(
                                    invitation = invitation,
                                    enabled = !state.isMutatingExternalContact,
                                    onCancel = { viewModel.resolveInvitation(invitation, "cancel") },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAddDialog) {
        AddExternalContactDialog(
            state = state,
            onPhoneChange = viewModel::setExternalContactPhone,
            onDiscover = viewModel::discoverExternalContact,
            onInvite = viewModel::inviteExternalContact,
            onDismiss = { showAddDialog = false },
        )
    }

    contactPendingRemoval?.let { contact ->
        AlertDialog(
            onDismissRequest = { contactPendingRemoval = null },
            title = { Text(stringResource(R.string.external_contacts_remove_confirm_title)) },
            text = { Text(stringResource(R.string.external_contacts_remove_confirm_description)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.updateExternalContact(contact, "remove")
                        contactPendingRemoval = null
                    },
                ) { Text(stringResource(R.string.external_contacts_remove_relationship)) }
            },
            dismissButton = {
                TextButton(onClick = { contactPendingRemoval = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContactsDirectoryTabBar(
    selectedTab: ContactsDirectoryTab,
    onSelect: (ContactsDirectoryTab) -> Unit,
) {
    PrimaryScrollableTabRow(
        selectedTabIndex = selectedTab.ordinal,
        edgePadding = 0.dp,
        modifier = Modifier.fillMaxWidth(),
    ) {
        ContactsDirectoryTab.entries.forEach { tab ->
            val title = stringResource(tab.titleResource())
            Tab(
                selected = selectedTab == tab,
                onClick = { onSelect(tab) },
                text = {
                    Text(
                        text = title,
                        maxLines = 1,
                    )
                },
            )
        }
    }
}

@Composable
private fun DirectoryTabActions(
    tab: ContactsDirectoryTab,
    canAddOrganizationMember: Boolean,
    isBusy: Boolean,
    onAddOrganizationMember: () -> Unit,
    onAddExternalContact: () -> Unit,
) {
    val action = when (tab) {
        ContactsDirectoryTab.INTERNAL -> {
            if (!canAddOrganizationMember) return
            onAddOrganizationMember
        }
        ContactsDirectoryTab.EXTERNAL -> onAddExternalContact
        else -> return
    }
    val label = when (tab) {
        ContactsDirectoryTab.INTERNAL -> stringResource(R.string.ws_add_member)
        ContactsDirectoryTab.EXTERNAL -> stringResource(R.string.external_contacts_add_contact)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Button(onClick = action, enabled = !isBusy) {
            Icon(
                imageVector = Icons.Default.PersonAdd,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Spacer(modifier = Modifier.size(TTSpacing.xs))
            Text(label)
        }
    }
}

@Composable
private fun DirectoryError(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(TTSpacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
    }
}

@Composable
private fun ContactRow(
    member: OrganizationMember,
    isSelf: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val name = member.displayName
    val subtitle = member.user?.username?.takeIf { it.isNotBlank() }?.let { "@$it" }
        ?: member.user?.email?.takeIf { it.isNotBlank() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IdentityColorAvatar(
            name = name,
            seed = member.userId,
            imageUrl = member.user?.avatar,
            size = 40.dp,
        )
        Spacer(modifier = Modifier.size(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = if (isSelf) stringResource(R.string.im_contacts_you_name, name) else name,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!subtitle.isNullOrBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ExternalContactDirectoryRow(
    contact: ExternalContact,
    enabled: Boolean,
    onOpen: () -> Unit,
    onBlock: () -> Unit,
    onRemove: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.weight(1f).clickable(enabled = enabled, onClick = onOpen),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ExternalContactIdentity(contact)
        }
        TextButton(onClick = onOpen, enabled = enabled) {
            Text(stringResource(R.string.external_contacts_message))
        }
        Box {
            IconButton(onClick = { menuExpanded = true }, enabled = enabled) {
                Icon(
                    Icons.Default.MoreVert,
                    contentDescription = stringResource(R.string.external_contacts_more_actions),
                )
            }
            DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.external_contacts_block)) },
                    onClick = { menuExpanded = false; onBlock() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.external_contacts_remove_relationship)) },
                    onClick = { menuExpanded = false; onRemove() },
                )
            }
        }
    }
}

@Composable
private fun BlockedContactRow(
    contact: ExternalContact,
    enabled: Boolean,
    onBlockedContactClick: () -> Unit,
    onUnblock: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.weight(1f).clickable(onClick = onBlockedContactClick),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ExternalContactIdentity(contact)
        }
        TextButton(onClick = onUnblock, enabled = enabled) {
            Text(stringResource(R.string.external_contacts_unblock))
        }
    }
}

@Composable
private fun ExternalContactIdentity(contact: ExternalContact) {
    IdentityColorAvatar(
        name = contact.displayName,
        seed = contact.peerUserId,
        imageUrl = contact.avatarUrl,
        size = 40.dp,
    )
    Spacer(modifier = Modifier.size(TTSpacing.md))
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = contact.displayName.ifBlank { contact.peerUserId },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(modifier = Modifier.size(TTSpacing.xs))
            Text(
                text = stringResource(R.string.external_contacts_badge),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        if (contact.peerOrganizationName.isNotBlank()) {
            Text(
                text = contact.peerOrganizationName,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun IncomingInvitationRow(
    invitation: ContactInvitation,
    organizations: List<Organization>,
    defaultOrganizationId: String?,
    enabled: Boolean,
    onAccept: (String) -> Unit,
    onReject: () -> Unit,
) {
    var selectedOrganizationId by remember(invitation.invitationId, defaultOrganizationId) {
        mutableStateOf(defaultOrganizationId)
    }
    var menuExpanded by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        InvitationIdentity(invitation)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                TextButton(
                    onClick = { menuExpanded = true },
                    enabled = enabled && organizations.isNotEmpty(),
                    modifier = Modifier.widthIn(max = 132.dp),
                ) {
                    Text(
                        organizations.firstOrNull { it.id == selectedOrganizationId }?.name
                            ?: stringResource(R.string.external_contacts_choose_identity),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                    organizations.forEach { organization ->
                        DropdownMenuItem(
                            text = { Text(organization.name) },
                            onClick = {
                                selectedOrganizationId = organization.id
                                menuExpanded = false
                            },
                        )
                    }
                }
            }
            TextButton(onClick = onReject, enabled = enabled) {
                Text(stringResource(R.string.external_contacts_reject))
            }
            Button(
                onClick = { selectedOrganizationId?.let(onAccept) },
                enabled = enabled && selectedOrganizationId != null,
            ) { Text(stringResource(R.string.external_contacts_accept)) }
        }
    }
}

@Composable
private fun OutgoingInvitationRow(
    invitation: ContactInvitation,
    enabled: Boolean,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        InvitationIdentity(invitation)
        TextButton(onClick = onCancel, enabled = enabled, modifier = Modifier.align(Alignment.End)) {
            Text(stringResource(R.string.external_contacts_cancel_request))
        }
    }
}

@Composable
private fun InvitationIdentity(invitation: ContactInvitation) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IdentityColorAvatar(
            name = invitation.displayName,
            seed = invitation.peerUserId,
            imageUrl = invitation.avatarUrl,
            size = 40.dp,
        )
        Spacer(modifier = Modifier.size(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                invitation.displayName.ifBlank { invitation.peerUserId },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                invitation.note ?: invitation.peerOrganizationName.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun AddExternalContactDialog(
    state: ContactsUiState,
    onPhoneChange: (String) -> Unit,
    onDiscover: () -> Unit,
    onInvite: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var note by rememberSaveable { mutableStateOf("") }
    val candidate = state.externalContactCandidate
    val canInvite = candidate?.relationship == "none" || candidate?.relationship == "removed"
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.external_contacts_add)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                Text(
                    stringResource(R.string.external_contacts_search_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = state.externalContactPhone,
                    onValueChange = onPhoneChange,
                    label = { Text(stringResource(R.string.external_contacts_phone)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                candidate?.let {
                    Text(
                        text = it.displayName.ifBlank { it.userId },
                        style = MaterialTheme.typography.titleSmall,
                    )
                    if (canInvite) {
                        OutlinedTextField(
                            value = note,
                            onValueChange = { note = it },
                            label = { Text(stringResource(R.string.external_contacts_note)) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Text(
                            stringResource(
                                if (it.relationship == "pending") {
                                    R.string.external_contacts_request_sent
                                } else {
                                    R.string.external_contacts_already_friend
                                },
                            ),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                state.externalContactsErrorMessage?.let {
                    Text(it, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            when {
                candidate == null -> Button(
                    onClick = onDiscover,
                    enabled = state.externalContactPhone.isNotBlank() && !state.isMutatingExternalContact,
                ) { Text(stringResource(R.string.external_contacts_search)) }
                canInvite -> Button(
                    onClick = { onInvite(note) },
                    enabled = !state.isMutatingExternalContact,
                ) { Text(stringResource(R.string.external_contacts_send_request)) }
                else -> TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
        },
    )
}

private fun ContactsDirectoryTab.titleResource(): Int = when (this) {
    ContactsDirectoryTab.INTERNAL -> R.string.external_contacts_tab_members
    ContactsDirectoryTab.EXTERNAL -> R.string.external_contacts_title
    ContactsDirectoryTab.INCOMING -> R.string.external_contacts_tab_incoming
    ContactsDirectoryTab.OUTGOING -> R.string.external_contacts_tab_outgoing
    ContactsDirectoryTab.BLOCKED -> R.string.external_contacts_tab_blocked
}

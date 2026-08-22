package com.tabtin.mobile.features.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.PendingInvitation
import com.tabtin.mobile.features.notification.NotificationCenterViewModel
import com.tabtin.mobile.features.profile.ProfileViewModel
import com.tabtin.mobile.features.workspace.InvitationResponseSheet
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TTFormSheet
import com.tabtin.mobile.ui.theme.IdentityAvatar
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/** 账户抽屉的内容面板。数据复用资料页的 [ProfileViewModel]，避免账户信息分叉。 */
@Composable
public fun AccountDrawerPanel(
    onDismiss: () -> Unit,
    onNavigateToMe: () -> Unit,
    onNavigateToSettings: () -> Unit,
    onNavigateToNotifications: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: ProfileViewModel = hiltViewModel(),
    notificationViewModel: NotificationCenterViewModel = hiltViewModel(),
) {
    val profile = viewModel.profileState
    val organizations by viewModel.organizations.collectAsState()
    val selectedOrganization by viewModel.selectedOrganization.collectAsState()
    val notificationState by notificationViewModel.state.collectAsState()
    var organizationPickerVisible by remember { mutableStateOf(false) }
    var respondingInvitation by remember { mutableStateOf<PendingInvitation?>(null) }
    var showCreateOrganization by remember { mutableStateOf(false) }
    val displayName = profile.nickname?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.profile_default_name)

    Column(
        modifier = modifier
            .background(ttColor(TTColors.BgSidebar, TTColors.Dark.BgSidebar))
            .fillMaxHeight(),
    ) {
        DrawerHeader(onDismiss = onDismiss)

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            DrawerCard(
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    onDismiss()
                    onNavigateToMe()
                },
            ) {
                IdentityColorAvatar(
                    name = displayName,
                    seed = IdentityAvatar.colorSeed(profile.userId, displayName),
                    imageUrl = profile.avatar,
                    size = 52.dp,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = displayName,
                        style = TTFonts.subtitleSemibold,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    profile.username?.takeIf { it.isNotBlank() }?.let { username ->
                        Text(
                            text = "@$username",
                            style = TTFonts.meta,
                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                DrawerChevron()
            }

            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                Text(
                    text = stringResource(R.string.profile_workspace),
                    style = TTFonts.captionSemibold,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    modifier = Modifier.padding(horizontal = TTSpacing.xs),
                )
                selectedOrganization?.let { organization ->
                    OrganizationCurrentRow(
                        organization = organization,
                        expanded = organizationPickerVisible,
                        onClick = { organizationPickerVisible = !organizationPickerVisible },
                    )
                }
                if (organizationPickerVisible) {
                    OrganizationPicker(
                        organizations = organizations,
                        selectedOrganizationId = selectedOrganization?.id,
                        switchingOrganizationId = viewModel.isSwitchingOrganization,
                        onSelect = { organization ->
                            organizationPickerVisible = false
                            viewModel.switchOrganization(organization)
                        },
                        onCreate = { showCreateOrganization = true },
                    )
                }
            }

            if (viewModel.pendingInvitations.isNotEmpty()) {
                PendingInvitationsSection(
                    invitations = viewModel.pendingInvitations,
                    onOpenInvitation = { respondingInvitation = it },
                )
            }

            DrawerCard(
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    onDismiss()
                    onNavigateToNotifications()
                },
            ) {
                Icon(
                    imageVector = Icons.Default.Notifications,
                    contentDescription = null,
                    tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                    modifier = Modifier.size(28.dp),
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.notification_title),
                        style = TTFonts.subtitle,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    )
                    Text(
                        text = if (notificationState.unreadCount > 0) {
                            stringResource(R.string.notification_unread_count, notificationState.unreadCount)
                        } else {
                            stringResource(R.string.notification_no_unread)
                        },
                        style = TTFonts.meta,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
                if (notificationState.unreadCount > 0) {
                    DrawerUnreadBadge(unreadCount = notificationState.unreadCount)
                }
                DrawerChevron()
            }
        }

        HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
        DrawerFooter(
            onClick = {
                onDismiss()
                onNavigateToSettings()
            },
        )
    }

    respondingInvitation?.let { invitation ->
        val stillPending = viewModel.pendingInvitations.any { it.id == invitation.id }
        LaunchedEffect(stillPending) {
            if (!stillPending) respondingInvitation = null
        }

        InvitationResponseSheet(
            invitation = invitation,
            isResponding = viewModel.respondingInvitationId == invitation.id,
            onAccept = { viewModel.respondToInvitation(invitation.id, true) },
            onReject = { viewModel.respondToInvitation(invitation.id, false) },
            onDismiss = { respondingInvitation = null },
        )
    }

    if (showCreateOrganization) {
        CreateOrganizationSheet(
            isCreating = viewModel.isCreatingOrganization,
            errorMessage = viewModel.error,
            onDismiss = {
                viewModel.clearError()
                showCreateOrganization = false
            },
            onCreate = { name, description ->
                viewModel.createOrganization(name, description) {
                    showCreateOrganization = false
                    organizationPickerVisible = false
                }
            },
        )
    }
}

@Composable
private fun DrawerHeader(onDismiss: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = TTSpacing.lg, top = TTSpacing.sm, end = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.account_drawer_title),
            style = TTFonts.titleSemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onDismiss) {
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = stringResource(R.string.common_close),
                tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
            )
        }
    }
}

@Composable
private fun DrawerCard(
    modifier: Modifier,
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(TTRadius.md))
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .clickable(onClick = onClick)
            .padding(TTSpacing.lg),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun OrganizationCurrentRow(
    organization: Organization,
    expanded: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(TTRadius.md))
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrganizationAvatar(organization = organization, size = 32.dp)
        Text(
            text = organization.name,
            style = TTFonts.subtitle,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Icon(
            imageVector = if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
            contentDescription = stringResource(R.string.workspace_switch_organization),
            tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
        )
    }
}

@Composable
private fun OrganizationPicker(
    organizations: List<Organization>,
    selectedOrganizationId: String?,
    switchingOrganizationId: String?,
    onSelect: (Organization) -> Unit,
    onCreate: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(TTRadius.md))
            .background(ttColor(TTColors.Surface, TTColors.Dark.Surface)),
    ) {
        organizations.forEach { organization ->
            val isSelected = organization.id == selectedOrganizationId
            val isSwitching = organization.id == switchingOrganizationId
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = switchingOrganizationId == null) { onSelect(organization) }
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OrganizationAvatar(organization = organization, size = 28.dp)
                Text(
                    text = organization.name,
                    style = TTFonts.subtitle,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                when {
                    isSwitching -> CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    isSelected -> Icon(
                        imageVector = Icons.Default.Check,
                        contentDescription = null,
                        tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                    )
                }
            }
        }
        HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = switchingOrganizationId == null, onClick = onCreate)
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.AddCircle,
                contentDescription = null,
                tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
            )
            Text(
                text = stringResource(R.string.ws_create),
                style = TTFonts.subtitle,
                color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
            )
        }
    }
}

@Composable
private fun CreateOrganizationSheet(
    isCreating: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onCreate: (String, String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }

    TTFormSheet(
        onDismissRequest = onDismiss,
        dismissEnabled = !isCreating,
        title = { Text(stringResource(R.string.ws_create), style = TTFonts.subtitleSemibold) },
        content = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.ws_create_name_hint)) },
                singleLine = true,
                enabled = !isCreating,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text(stringResource(R.string.ws_create_desc_hint)) },
                minLines = 2,
                maxLines = 5,
                enabled = !isCreating,
                modifier = Modifier.fillMaxWidth(),
            )
            errorMessage?.takeIf { it.isNotBlank() }?.let {
                Text(
                    text = it,
                    style = TTFonts.meta,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }
        },
        actions = {
            TextButton(onClick = onDismiss, enabled = !isCreating) {
                Text(stringResource(R.string.common_cancel))
            }
            TextButton(
                onClick = { onCreate(name, description) },
                enabled = name.isNotBlank() && !isCreating,
            ) {
                if (isCreating) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text(stringResource(R.string.ws_create))
                }
            }
        },
    )
}

@Composable
private fun PendingInvitationsSection(
    invitations: List<PendingInvitation>,
    onOpenInvitation: (PendingInvitation) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        Text(
            text = stringResource(R.string.pending_invitations_label),
            style = TTFonts.captionSemibold,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            modifier = Modifier.padding(horizontal = TTSpacing.xs),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(TTRadius.md))
                .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)),
        ) {
            invitations.forEach { invitation ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenInvitation(invitation) }
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Default.Email,
                        contentDescription = null,
                        tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                        modifier = Modifier.size(28.dp),
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = invitation.workspaceName,
                            style = TTFonts.subtitle,
                            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val subtitle = if (invitation.invitedByName.isNotBlank()) {
                            "${invitation.invitedByName} · ${invitation.role}"
                        } else {
                            invitation.role
                        }
                        Text(
                            text = subtitle,
                            style = TTFonts.meta,
                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(
                        text = stringResource(R.string.pending_invitations_label),
                        style = TTFonts.captionSemibold,
                        color = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning),
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun DrawerUnreadBadge(unreadCount: Int) {
    Text(
        text = if (unreadCount > 99) "99+" else unreadCount.toString(),
        style = TTFonts.captionSemibold,
        color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
        maxLines = 1,
        modifier = Modifier
            .background(
                color = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                shape = RoundedCornerShape(999.dp),
            )
            .padding(horizontal = TTSpacing.sm, vertical = 3.dp),
    )
}

@Composable
private fun OrganizationAvatar(organization: Organization, size: androidx.compose.ui.unit.Dp) {
    TTAvatar(
        name = organization.name,
        imageUrl = organization.logoUrl,
        size = size,
        shape = RoundedCornerShape(size * 0.25f),
        fallbackText = organization.avatarFallbackText,
    )
}

@Composable
private fun DrawerFooter(onClick: () -> Unit) {
    Column(modifier = Modifier.padding(bottom = TTSpacing.lg)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.lg),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.Settings,
                contentDescription = null,
                tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                modifier = Modifier.size(28.dp),
            )
            Text(
                text = stringResource(R.string.account_drawer_settings),
                style = TTFonts.subtitle,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                modifier = Modifier.weight(1f),
            )
            DrawerChevron()
        }
        Text(
            text = stringResource(R.string.profile_version, BuildConfig.VERSION_NAME),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            modifier = Modifier.padding(horizontal = TTSpacing.lg),
        )
    }
}

@Composable
private fun DrawerChevron() {
    Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
    )
}

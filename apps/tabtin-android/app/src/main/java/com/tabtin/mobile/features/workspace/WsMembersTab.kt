package com.tabtin.mobile.features.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

internal fun ownerFirst(members: List<OrganizationMember>): List<OrganizationMember> =
    members.sortedByDescending { it.role.isOwner }

internal fun canManageOrganizationMember(
    operatorRole: OrganizationRole?,
    targetRole: OrganizationRole,
    isCurrentUser: Boolean,
    isPersonal: Boolean,
): Boolean =
    !isPersonal &&
        !isCurrentUser &&
        operatorRole != null &&
        operatorRole >= OrganizationRole.ADMIN &&
        operatorRole > targetRole

@Composable
internal fun MembersTab(
    members: List<OrganizationMember>,
    operatorRole: OrganizationRole?,
    isPersonal: Boolean,
    isMutating: Boolean,
    onUpdateRole: (String, OrganizationRole) -> Unit,
    onRemoveMember: (String) -> Unit,
    currentUserId: String? = null,
) {
    val displayedMembers = remember(members) { ownerFirst(members) }
    var removingMember by remember { mutableStateOf<OrganizationMember?>(null) }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.xl, vertical = TTSpacing.md),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.ws_member_count_title, members.size),
                style = TTFonts.bodySemibold,
            )
        }

        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(displayedMembers, key = { it.id }) { member ->
                val isCurrentUser = currentUserId != null && member.userId == currentUserId
                MemberRow(
                    member = member,
                    canManage = canManageOrganizationMember(
                        operatorRole = operatorRole,
                        targetRole = member.role,
                        isCurrentUser = isCurrentUser,
                        isPersonal = isPersonal,
                    ),
                    operatorRole = operatorRole,
                    isCurrentUser = isCurrentUser,
                    onUpdateRole = { role -> onUpdateRole(member.userId, role) },
                    onRemove = { removingMember = member },
                )
                HorizontalDivider(
                    modifier = Modifier.padding(horizontal = TTSpacing.xl),
                    color = ttColor(TTColors.Divider, TTColors.Dark.Divider).copy(alpha = 0.3f),
                )
            }
        }
    }

    removingMember?.let { member ->
        AlertDialog(
            onDismissRequest = { removingMember = null },
            title = { Text(stringResource(R.string.ws_remove_member)) },
            text = { Text(stringResource(R.string.ws_remove_member_confirm, member.displayName)) },
            confirmButton = {
                Button(
                    onClick = { onRemoveMember(member.userId); removingMember = null },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                    ),
                ) { Text(stringResource(R.string.common_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { removingMember = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@Composable
private fun MemberRow(
    member: OrganizationMember,
    canManage: Boolean,
    operatorRole: OrganizationRole?,
    isCurrentUser: Boolean = false,
    onUpdateRole: (OrganizationRole) -> Unit,
    onRemove: () -> Unit,
) {
    var showRoleMenu by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.xl, vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TTAvatar(
            name = member.displayName,
            imageUrl = member.user?.avatar,
            size = 36.dp,
        )

        Spacer(Modifier.width(TTSpacing.md))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = if (isCurrentUser) "${member.displayName} ${stringResource(R.string.ws_member_me)}" else member.displayName,
                style = TTFonts.body,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = roleDisplayString(member.role),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }

        if (canManage) {
            Box {
                IconButton(onClick = { showRoleMenu = true }) {
                    Icon(
                        Icons.Default.MoreVert,
                        contentDescription = stringResource(R.string.ws_member_actions),
                        modifier = Modifier.size(20.dp),
                    )
                }
                DropdownMenu(expanded = showRoleMenu, onDismissRequest = { showRoleMenu = false }) {
                    listOf(OrganizationRole.VIEWER, OrganizationRole.EDITOR, OrganizationRole.ADMIN)
                        .filter { operatorRole != null && operatorRole > it }
                        .forEach { r ->
                        DropdownMenuItem(
                            text = { Text(roleDisplayString(r)) },
                            onClick = { onUpdateRole(r); showRoleMenu = false },
                        )
                    }
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = {
                            Text(
                                stringResource(R.string.ws_remove_member),
                                color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                            )
                        },
                        onClick = { onRemove(); showRoleMenu = false },
                    )
                }
            }
        }
    }
}

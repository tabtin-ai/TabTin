package com.tabtin.mobile.features.workspace

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.OrganizationRole

@Composable
public fun roleDisplayString(role: OrganizationRole): String = when (role) {
    OrganizationRole.OWNER -> stringResource(R.string.ws_role_owner)
    OrganizationRole.ADMIN -> stringResource(R.string.ws_role_admin)
    OrganizationRole.EDITOR -> stringResource(R.string.ws_role_editor)
    OrganizationRole.VIEWER -> stringResource(R.string.ws_role_viewer)
}

@Composable
public fun localizedRoleName(roleKey: String): String {
    val role = OrganizationRole.entries.firstOrNull { it.displayKey == roleKey }
    return role?.let { roleDisplayString(it) } ?: roleKey.replaceFirstChar { it.uppercase() }
}

@Composable
public fun localizedInviteStatus(status: String?): String = when (status) {
    "pending" -> stringResource(R.string.ws_invite_status_pending)
    "accepted" -> stringResource(R.string.ws_invite_status_accepted)
    "expired" -> stringResource(R.string.ws_invite_status_expired)
    "cancelled" -> stringResource(R.string.ws_invite_status_cancelled)
    null -> stringResource(R.string.ws_invite_status_pending)
    else -> status.replaceFirstChar { it.uppercase() }
}

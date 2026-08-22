package com.tabtin.mobile.features.workspace

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun BasicInfoTab(
    ws: Organization,
    canEdit: Boolean,
    isOwner: Boolean,
    isMutating: Boolean,
    isUploadingLogo: Boolean,
    members: List<OrganizationMember>,
    onSave: (String?, String?, String?) -> Unit,
    onSelectLogo: (android.net.Uri) -> Unit,
    onDelete: () -> Unit,
    onLeave: () -> Unit,
    onTransfer: (String) -> Unit,
) {
    var editName by remember(ws) { mutableStateOf(ws.name) }
    var editDesc by remember(ws) { mutableStateOf(ws.description ?: "") }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var showLeaveConfirm by remember { mutableStateOf(false) }
    var showTransferDialog by remember { mutableStateOf(false) }

    val criticalColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
    val logoPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia(),
    ) { uri -> uri?.let(onSelectLogo) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(TTSpacing.xl),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        Text(
            text = stringResource(R.string.ws_edit_info),
            style = TTFonts.bodySemibold,
        )

        OutlinedTextField(
            value = editName,
            onValueChange = { editName = it },
            label = { Text(stringResource(R.string.ws_edit_name)) },
            modifier = Modifier.fillMaxWidth(),
            enabled = canEdit,
            singleLine = true,
        )

        OutlinedTextField(
            value = editDesc,
            onValueChange = { editDesc = it },
            label = { Text(stringResource(R.string.ws_edit_desc)) },
            modifier = Modifier.fillMaxWidth(),
            enabled = canEdit,
            minLines = 2,
            maxLines = 4,
        )

        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Box(
                modifier = Modifier
                    .size(80.dp)
                    .clickable(enabled = isOwner && !isUploadingLogo) {
                        logoPicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                TTAvatar(
                    name = ws.name,
                    imageUrl = ws.logoUrl,
                    size = 80.dp,
                    shape = TTRadius.Shapes.lg,
                    fallbackText = ws.avatarFallbackText,
                )
                if (isUploadingLogo) {
                    CircularProgressIndicator(modifier = Modifier.size(32.dp), strokeWidth = 3.dp)
                } else if (isOwner) {
                    Icon(
                        imageVector = Icons.Default.PhotoCamera,
                        contentDescription = stringResource(R.string.ws_change_avatar),
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(26.dp),
                    )
                }
            }
            Text(
                text = if (isOwner) {
                    stringResource(R.string.ws_avatar_hint)
                } else {
                    stringResource(R.string.ws_avatar_owner_only)
                },
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }

        if (canEdit) {
            Button(
                onClick = {
                    onSave(
                        editName.takeIf { it != ws.name },
                        editDesc.takeIf { it != (ws.description ?: "") },
                        null,
                    )
                },
                enabled = !isMutating && editName.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (isMutating) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(TTSpacing.sm))
                }
                Text(stringResource(R.string.common_save))
            }
        }

        Spacer(Modifier.height(TTSpacing.xxxl))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            InfoChip(label = stringResource(R.string.ws_member_count, ws.memberCount ?: 0))
            InfoChip(label = stringResource(R.string.ws_workspace_count, ws.spaceCount ?: 0))
            if (ws.isDefault == true) {
                InfoChip(label = stringResource(R.string.ws_default_tag))
            }
        }

        Spacer(Modifier.height(TTSpacing.xl))

        Text(
            text = stringResource(R.string.ws_danger_zone),
            style = TTFonts.bodySemibold,
            color = criticalColor,
        )

        if (isOwner) {
            DangerButton(
                text = stringResource(R.string.ws_transfer),
                onClick = { showTransferDialog = true },
            )
        }

        if (isOwner) {
            DangerButton(
                text = stringResource(R.string.ws_delete),
                onClick = { showDeleteConfirm = true },
                enabled = ws.isDefault != true,
            )
        } else {
            DangerButton(
                text = stringResource(R.string.ws_leave),
                onClick = { showLeaveConfirm = true },
            )
        }

        Spacer(Modifier.height(TTSpacing.huge))
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text(stringResource(R.string.ws_delete)) },
            text = { Text(stringResource(R.string.ws_delete_confirm, ws.name)) },
            confirmButton = {
                Button(
                    onClick = { showDeleteConfirm = false; onDelete() },
                    colors = ButtonDefaults.buttonColors(containerColor = criticalColor),
                ) { Text(stringResource(R.string.common_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    if (showLeaveConfirm) {
        AlertDialog(
            onDismissRequest = { showLeaveConfirm = false },
            title = { Text(stringResource(R.string.ws_leave)) },
            text = { Text(stringResource(R.string.ws_leave_confirm, ws.name)) },
            confirmButton = {
                Button(
                    onClick = { showLeaveConfirm = false; onLeave() },
                    colors = ButtonDefaults.buttonColors(containerColor = criticalColor),
                ) { Text(stringResource(R.string.common_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showLeaveConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    if (showTransferDialog) {
        TransferOwnershipDialog(
            organizationName = ws.name,
            members = members.filter { !it.role.isOwner },
            onDismiss = { showTransferDialog = false },
            onConfirm = { userId ->
                showTransferDialog = false
                onTransfer(userId)
            },
        )
    }
}

@Composable
internal fun InfoChip(label: String) {
    Box(
        modifier = Modifier
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant), TTRadius.Shapes.sm)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
    ) {
        Text(
            text = label,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

@Composable
internal fun DangerButton(text: String, onClick: () -> Unit, enabled: Boolean = true) {
    val criticalColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (enabled) criticalColor.copy(alpha = 0.06f) else ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant),
                TTRadius.Shapes.md,
            )
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = TTSpacing.lg),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = TTFonts.bodySemibold,
            color = if (enabled) criticalColor else ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

@Composable
internal fun TransferOwnershipDialog(
    organizationName: String,
    members: List<OrganizationMember>,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var selectedUserId by remember { mutableStateOf<String?>(null) }
    val criticalColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.ws_transfer)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                Text(stringResource(R.string.ws_transfer_confirm, organizationName))
                Spacer(Modifier.height(TTSpacing.sm))
                if (members.isEmpty()) {
                    Text(
                        text = stringResource(R.string.ws_add_member),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                } else {
                    members.forEach { member ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selectedUserId = member.userId }
                                .padding(vertical = TTSpacing.xs),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = selectedUserId == member.userId,
                                onClick = { selectedUserId = member.userId },
                            )
                            Spacer(Modifier.width(TTSpacing.sm))
                            Column {
                                Text(member.displayName, style = TTFonts.body)
                                Text(
                                    roleDisplayString(member.role),
                                    style = TTFonts.caption,
                                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { selectedUserId?.let(onConfirm) },
                enabled = selectedUserId != null,
                colors = ButtonDefaults.buttonColors(containerColor = criticalColor),
            ) { Text(stringResource(R.string.common_confirm)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
        },
    )
}

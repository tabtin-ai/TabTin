package com.tabtin.mobile.features.files

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.TTFormDialog
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTSpacing

/** 资源长按操作：移动 / 回收站 / 协作者 / 发送到对话。不做批量。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CloudDriveResourceActionSheet(
    row: CloudDriveResourceRow,
    canSendToConversation: Boolean,
    isWriting: Boolean,
    onMove: () -> Unit,
    onTrash: () -> Unit,
    onManageCollaborators: () -> Unit,
    onSendToConversation: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
                .padding(bottom = TTSpacing.xxl)
                .semantics { contentDescription = "cloud_drive_resource_actions" },
        ) {
            Text(
                text = row.displayTitle,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = TTSpacing.md),
            )
            if (row.canMove == true) {
                ActionRow(
                    label = stringResource(R.string.cloud_drive_move),
                    enabled = !isWriting,
                    onClick = {
                        onDismiss()
                        onMove()
                    },
                )
            }
            if (row.normalizedType == "tabfiles" && row.canTrash != false) {
                ActionRow(
                    label = stringResource(R.string.cloud_drive_trash),
                    enabled = !isWriting,
                    onClick = {
                        onDismiss()
                        onTrash()
                    },
                )
            }
            if (row.normalizedType == "tabfiles" && row.canShare != false) {
                ActionRow(
                    label = stringResource(R.string.cloud_drive_manage_collaborators),
                    enabled = !isWriting,
                    onClick = {
                        onDismiss()
                        onManageCollaborators()
                    },
                )
            }
            if (canSendToConversation) {
                HorizontalDivider(modifier = Modifier.padding(vertical = TTSpacing.sm))
                ActionRow(
                    label = stringResource(R.string.cloud_drive_send_to_conversation),
                    enabled = !isWriting,
                    onClick = {
                        onDismiss()
                        onSendToConversation()
                    },
                )
            }
            TextButton(
                onClick = onDismiss,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = TTSpacing.md),
            ) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    }
}

/** 文件夹长按：重命名 / 移动 / 删除（强确认）。永远不出现发送到对话。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CloudDriveFolderActionSheet(
    folder: CloudDriveCollection,
    isWriting: Boolean,
    onRename: () -> Unit,
    onMove: () -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
                .padding(bottom = TTSpacing.xxl)
                .semantics { contentDescription = "cloud_drive_folder_actions" },
        ) {
            Text(
                text = folder.name,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = TTSpacing.md),
            )
            ActionRow(
                label = stringResource(R.string.cloud_drive_rename_folder),
                enabled = !isWriting,
                onClick = {
                    onDismiss()
                    onRename()
                },
            )
            ActionRow(
                label = stringResource(R.string.cloud_drive_move_folder),
                enabled = !isWriting,
                onClick = {
                    onDismiss()
                    onMove()
                },
            )
            ActionRow(
                label = stringResource(R.string.cloud_drive_delete_folder),
                enabled = !isWriting,
                onClick = {
                    onDismiss()
                    onDelete()
                },
            )
            Text(
                text = stringResource(R.string.cloud_drive_folder_actions_footer),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = TTSpacing.sm),
            )
            TextButton(
                onClick = onDismiss,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = TTSpacing.md),
            ) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CloudDriveMoveTargetSheet(
    title: String,
    targets: List<CloudDriveCollection>,
    isWriting: Boolean,
    onSelect: (CloudDriveCollection) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
                .padding(bottom = TTSpacing.xxl)
                .semantics { contentDescription = "cloud_drive_move_targets" },
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = TTSpacing.md),
            )
            LazyColumn {
                items(targets, key = { it.id }) { folder ->
                    Text(
                        text = folder.name,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (isWriting) {
                            MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = !isWriting) {
                                onDismiss()
                                onSelect(folder)
                            }
                            .padding(vertical = TTSpacing.md),
                    )
                }
            }
            TextButton(
                onClick = onDismiss,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = TTSpacing.md),
            ) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    }
}

@Composable
public fun CloudDriveRenameFolderDialog(
    initialName: String,
    isSubmitting: Boolean,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember(initialName) { mutableStateOf(initialName) }
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    val trimmed = name.trim()
    TTFormDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = { Text(stringResource(R.string.cloud_drive_rename_folder)) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                singleLine = true,
                enabled = !isSubmitting,
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(trimmed) },
                enabled = trimmed.isNotEmpty() && !isSubmitting,
            ) {
                Text(stringResource(R.string.common_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSubmitting) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}

@Composable
public fun CloudDriveDeleteFolderConfirmDialog(
    folderName: String,
    isSubmitting: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = { Text(stringResource(R.string.cloud_drive_delete_folder_confirm_title)) },
        text = {
            Text(
                stringResource(R.string.cloud_drive_delete_folder_confirm_body, folderName),
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !isSubmitting) {
                Text(stringResource(R.string.cloud_drive_delete_folder))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSubmitting) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}

@Composable
public fun CloudDriveTrashFileConfirmDialog(
    fileName: String,
    isSubmitting: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = { Text(stringResource(R.string.cloud_drive_trash_confirm_title)) },
        text = {
            Text(stringResource(R.string.cloud_drive_trash_confirm_body, fileName))
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !isSubmitting) {
                Text(stringResource(R.string.cloud_drive_trash))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSubmitting) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}

@Composable
private fun ActionRow(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Text(
        text = label,
        style = MaterialTheme.typography.bodyLarge,
        color = if (enabled) {
            MaterialTheme.colorScheme.onSurface
        } else {
            MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
        },
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = TTSpacing.md),
    )
}

package com.tabtin.mobile.features.files

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

/** 云盘写入操作面板：上传 / 新建文件夹 / 文档 / 多维表。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CloudDriveActionSheet(
    canWrite: Boolean,
    isWriting: Boolean,
    pendingMountCount: Int,
    onUpload: () -> Unit,
    onNewFolder: () -> Unit,
    onNewDoc: () -> Unit,
    onNewTable: () -> Unit,
    onRetryPendingMount: () -> Unit,
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
                .semantics { contentDescription = "cloud_drive_action_sheet" },
        ) {
            Text(
                text = stringResource(R.string.cloud_drive_actions_title),
                style = TTFonts.subtitleSemibold,
                modifier = Modifier
                    .padding(bottom = TTSpacing.md)
                    .semantics { heading() },
            )
            if (canWrite) {
                ActionRow(
                    label = stringResource(R.string.cloud_drive_upload_file),
                    enabled = !isWriting,
                    onClick = {
                        onDismiss()
                        onUpload()
                    },
                )
                ActionRow(
                    label = stringResource(R.string.cloud_drive_new_folder),
                    enabled = !isWriting,
                    onClick = {
                        onDismiss()
                        onNewFolder()
                    },
                )
                ActionRow(
                    label = stringResource(R.string.cloud_drive_new_doc),
                    enabled = !isWriting,
                    onClick = {
                        onDismiss()
                        onNewDoc()
                    },
                )
                ActionRow(
                    label = stringResource(R.string.cloud_drive_new_table),
                    enabled = !isWriting,
                    onClick = {
                        onDismiss()
                        onNewTable()
                    },
                )
                if (pendingMountCount > 0) {
                    HorizontalDivider()
                    ActionRow(
                        label = stringResource(
                            R.string.cloud_drive_retry_pending_mount,
                            pendingMountCount,
                        ),
                        enabled = !isWriting,
                        onClick = {
                            onDismiss()
                            onRetryPendingMount()
                        },
                    )
                    Text(
                        text = stringResource(R.string.cloud_drive_mount_pending_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Text(
                    text = stringResource(R.string.cloud_drive_write_unavailable),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = stringResource(R.string.cloud_drive_write_unavailable_footer),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = TTSpacing.sm),
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

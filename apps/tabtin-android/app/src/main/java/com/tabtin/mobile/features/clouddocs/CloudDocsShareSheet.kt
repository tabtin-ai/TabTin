package com.tabtin.mobile.features.clouddocs

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.CloudSharePermission
import com.tabtin.mobile.data.model.CloudShareScope
import com.tabtin.mobile.data.model.CloudDocsCollaborator
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * 云文档 / 表格公开链接设置面板。
 *
 * 对齐 iOS CloudDocsShareSheet：开关、可见范围、权限、密码、复制 / 系统分享 / 轮换、访问次数。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CloudDocsShareSheet(
    target: CloudDocsShareTarget,
    onDismiss: () -> Unit,
    viewModel: CloudDocsShareSheetViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val sheetState = rememberTTSheetState(confirmValueChange = { !uiState.isBusy })

    LaunchedEffect(target.resourceId, target.type) {
        viewModel.load(target)
    }

    if (uiState.showAnyoneConfirm) {
        AlertDialog(
            onDismissRequest = viewModel::dismissAnyoneConfirm,
            title = { Text(stringResource(R.string.cloud_docs_share_anyone_confirm_title)) },
            text = { Text(stringResource(R.string.cloud_docs_share_anyone_confirm_message)) },
            confirmButton = {
                TextButton(onClick = viewModel::confirmAnyoneScope) {
                    Text(stringResource(R.string.cloud_docs_share_anyone_confirm_action))
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissAnyoneConfirm) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    if (uiState.showRefreshConfirm) {
        AlertDialog(
            onDismissRequest = viewModel::dismissRefreshConfirm,
            title = { Text(stringResource(R.string.cloud_docs_share_refresh_confirm_title)) },
            text = { Text(stringResource(R.string.cloud_docs_share_refresh_confirm_message)) },
            confirmButton = {
                TextButton(onClick = viewModel::confirmRefreshLink) {
                    Text(stringResource(R.string.cloud_docs_share_refresh_link))
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissRefreshConfirm) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    TTBottomSheet(
        onDismissRequest = {
            if (!uiState.isBusy) onDismiss()
        },
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 280.dp, max = 640.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Text(
                text = stringResource(R.string.cloud_docs_share_title),
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
            )
            if (uiState.resourceTitle.isNotBlank()) {
                Text(
                    text = uiState.resourceTitle,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            when (uiState.loadPhase) {
                CloudDocsShareLoadPhase.LOADING -> {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(160.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(28.dp))
                    }
                }
                CloudDocsShareLoadPhase.FORBIDDEN -> {
                    StatusBlock(
                        message = stringResource(R.string.cloud_docs_share_forbidden),
                        showsRetry = false,
                        onRetry = {},
                    )
                }
                CloudDocsShareLoadPhase.FAILED -> {
                    StatusBlock(
                        message = stringResource(R.string.cloud_docs_share_load_failed),
                        showsRetry = true,
                        onRetry = viewModel::retryLoad,
                    )
                }
                CloudDocsShareLoadPhase.READY -> {
                    ReadyContent(
                        uiState = uiState,
                        onToggleLink = viewModel::setLinkEnabled,
                        onSelectScope = viewModel::selectScope,
                        onSelectPermission = viewModel::changePermission,
                        onPasswordDraftChange = viewModel::setPasswordDraft,
                        onApplyPassword = viewModel::applyPassword,
                        onClearPassword = viewModel::clearPassword,
                        onCopyLink = { url ->
                            copyText(context, uiState.resourceTitle, url)
                            viewModel.markLinkCopied()
                        },
                        onSystemShare = { url ->
                            shareText(context, uiState.resourceTitle, url)
                        },
                        onRequestRefresh = viewModel::requestRefreshConfirm,
                        onCollaboratorQueryChange = viewModel::setCollaboratorQuery,
                        onInvite = viewModel::invite,
                        onUpdateCollaborator = viewModel::updateCollaborator,
                        onRemoveCollaborator = viewModel::removeCollaborator,
                    )
                }
            }
        }
    }
}

@Composable
private fun ReadyContent(
    uiState: CloudDocsShareSheetUiState,
    onToggleLink: (Boolean) -> Unit,
    onSelectScope: (CloudShareScope) -> Unit,
    onSelectPermission: (CloudSharePermission) -> Unit,
    onPasswordDraftChange: (String) -> Unit,
    onApplyPassword: () -> Unit,
    onClearPassword: () -> Unit,
    onCopyLink: (String) -> Unit,
    onSystemShare: (String) -> Unit,
    onRequestRefresh: () -> Unit,
    onCollaboratorQueryChange: (String) -> Unit,
    onInvite: (String, String) -> Unit,
    onUpdateCollaborator: (String, String) -> Unit,
    onRemoveCollaborator: (String) -> Unit,
) {
    val canInteract = uiState.canInteract

    uiState.updateError?.let { error ->
        Text(
            text = stringResource(
                when (error) {
                    CloudDocsShareMutationError.FORBIDDEN -> R.string.cloud_docs_share_forbidden
                    CloudDocsShareMutationError.UPDATE_FAILED -> R.string.cloud_docs_share_update_failed
                },
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.cloud_docs_share_link_toggle),
                style = MaterialTheme.typography.bodyMedium,
            )
            if (!uiState.isLinkEnabled) {
                Text(
                    text = stringResource(R.string.cloud_docs_share_link_off_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Switch(
            checked = uiState.isLinkEnabled,
            enabled = canInteract,
            onCheckedChange = onToggleLink,
        )
    }

    var roleMenuMemberId by remember { mutableStateOf<String?>(null) }
    var collaboratorPendingRemoval by remember { mutableStateOf<CloudDocsCollaborator?>(null) }
    val collaboratorIds = uiState.collaborators.map { it.userId }.toSet()

    Text(text = stringResource(R.string.cloud_docs_share_collaborators), style = MaterialTheme.typography.labelMedium)
    TabSearchField(
        query = uiState.collaboratorQuery,
        onQueryChange = onCollaboratorQueryChange,
        placeholder = stringResource(R.string.cloud_docs_share_member_search),
        modifier = Modifier.fillMaxWidth(),
        showCancelOnFocus = false,
    )
    uiState.memberCandidates.filter { member ->
        member.second.contains(uiState.collaboratorQuery, true) && member.first !in collaboratorIds
    }.take(20).forEach { member ->
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(member.second, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Box {
                TextButton(onClick = { roleMenuMemberId = member.first }, enabled = canInteract) {
                    Text(stringResource(R.string.cloud_docs_share_invite))
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
                DropdownMenu(expanded = roleMenuMemberId == member.first, onDismissRequest = { roleMenuMemberId = null }) {
                    listOf("viewer", "editor").forEach { permission ->
                        DropdownMenuItem(
                            text = { Text(stringResource(if (permission == "viewer") R.string.cloud_docs_share_collaborator_viewer else R.string.cloud_docs_share_collaborator_editor)) },
                            onClick = { roleMenuMemberId = null; onInvite(member.first, permission) },
                        )
                    }
                }
            }
        }
    }
    uiState.collaborators.forEach { collaborator ->
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(collaborator.nickname.ifBlank { collaborator.email }, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Box {
                TextButton(onClick = { roleMenuMemberId = collaborator.userId }, enabled = canInteract) {
                    Text(stringResource(if (collaborator.permission == "viewer") R.string.cloud_docs_share_collaborator_viewer else R.string.cloud_docs_share_collaborator_editor))
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
                DropdownMenu(expanded = roleMenuMemberId == collaborator.userId, onDismissRequest = { roleMenuMemberId = null }) {
                    listOf("viewer", "editor").forEach { permission ->
                        DropdownMenuItem(
                            text = { Text(stringResource(if (permission == "viewer") R.string.cloud_docs_share_collaborator_viewer else R.string.cloud_docs_share_collaborator_editor)) },
                            onClick = { roleMenuMemberId = null; onUpdateCollaborator(collaborator.userId, permission) },
                        )
                    }
                }
            }
            IconButton(onClick = { collaboratorPendingRemoval = collaborator }, enabled = canInteract) {
                Icon(
                    Icons.Default.RemoveCircle,
                    contentDescription = stringResource(R.string.cloud_docs_share_remove),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }

    collaboratorPendingRemoval?.let { collaborator ->
        AlertDialog(
            onDismissRequest = { collaboratorPendingRemoval = null },
            title = { Text(stringResource(R.string.cloud_docs_share_remove)) },
            text = { Text(collaborator.nickname.ifBlank { collaborator.email }) },
            confirmButton = {
                TextButton(onClick = { collaboratorPendingRemoval = null; onRemoveCollaborator(collaborator.userId) }) {
                    Text(stringResource(R.string.cloud_docs_share_remove))
                }
            },
            dismissButton = {
                TextButton(onClick = { collaboratorPendingRemoval = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    if (!uiState.isLinkEnabled) return

    Text(
        text = stringResource(R.string.cloud_docs_share_scope_section),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    val scopes = listOf(CloudShareScope.ORGANIZATION, CloudShareScope.ANYONE)
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        scopes.forEachIndexed { index, scope ->
            SegmentedButton(
                selected = uiState.currentScope == scope,
                onClick = { onSelectScope(scope) },
                enabled = canInteract,
                shape = SegmentedButtonDefaults.itemShape(index, scopes.size),
            ) {
                Text(
                    text = stringResource(
                        when (scope) {
                            CloudShareScope.ORGANIZATION -> R.string.cloud_docs_share_scope_organization
                            CloudShareScope.ANYONE -> R.string.cloud_docs_share_scope_anyone
                        },
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
    Text(
        text = stringResource(
            when (uiState.currentScope) {
                CloudShareScope.ORGANIZATION -> R.string.cloud_docs_share_scope_organization_hint
                CloudShareScope.ANYONE -> R.string.cloud_docs_share_scope_anyone_hint
            },
        ),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Text(
        text = stringResource(R.string.cloud_docs_share_permission_section),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        uiState.resourceType.availablePermissions.forEach { permission ->
            FilterChip(
                selected = uiState.currentPermission == permission,
                onClick = { onSelectPermission(permission) },
                enabled = canInteract,
                label = {
                    Text(
                        text = stringResource(
                            when (permission) {
                                CloudSharePermission.VIEW -> R.string.cloud_docs_share_permission_view
                                CloudSharePermission.COMMENT -> R.string.cloud_docs_share_permission_comment
                                CloudSharePermission.EDIT -> R.string.cloud_docs_share_permission_edit
                            },
                        ),
                    )
                },
            )
        }
    }

    Text(
        text = stringResource(R.string.cloud_docs_share_password_section),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (uiState.share?.hasPassword == true) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Icon(
                imageVector = Icons.Filled.Lock,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = stringResource(R.string.cloud_docs_share_password_set),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = onClearPassword,
                enabled = canInteract,
            ) {
                Text(stringResource(R.string.cloud_docs_share_password_clear))
            }
        }
    }
    OutlinedTextField(
        value = uiState.passwordDraft,
        onValueChange = onPasswordDraftChange,
        modifier = Modifier.fillMaxWidth(),
        enabled = canInteract,
        singleLine = true,
        placeholder = { Text(stringResource(R.string.cloud_docs_share_password_placeholder)) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
    )
    TextButton(
        onClick = onApplyPassword,
        enabled = canInteract && uiState.passwordDraft.isNotEmpty(),
    ) {
        Text(stringResource(R.string.cloud_docs_share_password_apply))
    }

    Text(
        text = stringResource(R.string.cloud_docs_share_link_section),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    val url = uiState.publicUrl
    if (!url.isNullOrBlank()) {
        Text(
            text = url,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        TextButton(
            onClick = { onCopyLink(url) },
            enabled = canInteract,
        ) {
            Text(
                text = stringResource(
                    if (uiState.didCopyLink) {
                        R.string.cloud_docs_share_link_copied
                    } else {
                        R.string.cloud_docs_share_copy_link
                    },
                ),
            )
        }
        TextButton(
            onClick = { onSystemShare(url) },
            enabled = canInteract,
        ) {
            Text(stringResource(R.string.cloud_docs_share_action))
        }
        TextButton(
            onClick = onRequestRefresh,
            enabled = canInteract,
        ) {
            Text(stringResource(R.string.cloud_docs_share_refresh_link))
        }
    }

    uiState.share?.visitCount?.let { count ->
        Text(
            text = stringResource(R.string.cloud_docs_share_visit_count, count),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    Spacer(modifier = Modifier.height(TTSpacing.sm))
}

@Composable
private fun StatusBlock(
    message: String,
    showsRetry: Boolean,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (showsRetry) {
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.common_retry))
            }
        }
    }
}

private fun copyText(context: Context, label: String, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
}

private fun shareText(context: Context, title: String, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, title)
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(intent, null))
}

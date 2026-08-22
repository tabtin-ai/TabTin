package com.tabtin.mobile.features.files

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SearchUserItem
import com.tabtin.mobile.data.model.files.TabFilesCollaborator
import com.tabtin.mobile.data.model.files.TabFilesUserBrief
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * TabFiles 协作者管理（FileRecordID 边界）。
 * 能力：列出 owner / 协作者、按组织成员搜索邀请、撤销。
 * 不做公开链接（那是 CloudDocs 路径）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TabFilesCollaboratorsSheet(
    organizationId: String,
    fileRecordId: String,
    fileTitle: String,
    viewModel: CloudDriveAppHomeViewModel,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var owner by remember { mutableStateOf<TabFilesUserBrief?>(null) }
    var collaborators by remember { mutableStateOf<List<TabFilesCollaborator>>(emptyList()) }
    var query by remember { mutableStateOf("") }
    var searchHits by remember { mutableStateOf<List<SearchUserItem>>(emptyList()) }
    var searchJob by remember { mutableStateOf<Job?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun reload() {
        scope.launch {
            loading = true
            error = null
            try {
                val result = viewModel.loadTabFileCollaborators(fileRecordId)
                owner = result.owner
                collaborators = result.collaborators
            } catch (e: Exception) {
                error = e.message
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(fileRecordId) { reload() }

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
                .padding(bottom = TTSpacing.xxl)
                .semantics { contentDescription = "tabfiles_collaborators_sheet" },
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Text(
                text = stringResource(R.string.cloud_drive_manage_collaborators),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = fileTitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
            } else {
                owner?.let {
                    Text(
                        text = stringResource(
                            R.string.cloud_drive_collaborator_owner,
                            it.nickname.ifBlank { it.userId.take(8) },
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (collaborators.isEmpty()) {
                    Text(
                        text = stringResource(R.string.cloud_drive_collaborators_empty),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    LazyColumn(modifier = Modifier.fillMaxWidth()) {
                        items(collaborators, key = { it.userId }) { collab ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = TTSpacing.sm),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = collab.nickname.ifBlank { collab.userId.take(8) },
                                        style = MaterialTheme.typography.bodyLarge,
                                    )
                                    Text(
                                        text = collab.permission,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                TextButton(
                                    enabled = !busy,
                                    onClick = {
                                        scope.launch {
                                            busy = true
                                            try {
                                                viewModel.revokeTabFileCollaborator(
                                                    fileRecordId,
                                                    collab.userId,
                                                )
                                                reload()
                                            } catch (e: Exception) {
                                                error = e.message
                                            } finally {
                                                busy = false
                                            }
                                        }
                                    },
                                ) {
                                    Text(stringResource(R.string.cloud_drive_revoke_collaborator))
                                }
                            }
                        }
                    }
                }
                TabSearchField(
                    query = query,
                    onQueryChange = { value ->
                        query = value
                        searchJob?.cancel()
                        searchJob = scope.launch {
                            delay(280)
                            try {
                                searchHits = viewModel.searchOrgUsers(organizationId, value)
                            } catch (_: Exception) {
                                searchHits = emptyList()
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = stringResource(R.string.cloud_drive_invite_user_hint),
                    showCancelOnFocus = false,
                )
                searchHits.take(8).forEach { user ->
                    TextButton(
                        enabled = !busy,
                        onClick = {
                            scope.launch {
                                busy = true
                                try {
                                    viewModel.inviteTabFileCollaborators(
                                        fileRecordId = fileRecordId,
                                        userIds = listOf(user.id),
                                        permission = "viewer",
                                    )
                                    query = ""
                                    searchHits = emptyList()
                                    reload()
                                } catch (e: Exception) {
                                    error = e.message
                                } finally {
                                    busy = false
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            user.nickname.ifBlank { user.id.take(8) } +
                                stringResource(R.string.cloud_drive_invite_as_viewer_suffix),
                        )
                    }
                }
            }
            error?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    }
}

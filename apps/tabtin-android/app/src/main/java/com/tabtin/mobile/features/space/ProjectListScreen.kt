package com.tabtin.mobile.features.space

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.FolderShared
import androidx.compose.material.icons.filled.Mail
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.PendingProjectInvitation
import com.tabtin.mobile.data.model.Project
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter
import kotlinx.coroutines.flow.filter

/** Space 页 Project 分段：云端协作只读入口，不在手机上供给执行环境。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ProjectListScreen(
    state: ProjectUiState,
    searchQuery: String,
    onDismissSearch: () -> Unit,
    onRefresh: () -> Unit,
    onRetry: () -> Unit,
    onOpenProject: (Project) -> Unit,
) {
    var desktopInvitation by remember { mutableStateOf<PendingProjectInvitation?>(null) }
    var isPullRefreshing by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }
            .filter { it }
            .collect { onDismissSearch() }
    }
    LaunchedEffect(state.isRefreshing) {
        if (!state.isRefreshing) isPullRefreshing = false
    }
    val filteredProjects = remember(state.projects, searchQuery) {
        val query = searchQuery.trim()
        state.projects.filter { project ->
            query.isEmpty() || listOf(project.name, project.description.orEmpty())
                .any { it.contains(query, ignoreCase = true) }
        }
    }

    Column(Modifier.fillMaxSize()) {
        PullToRefreshBox(
            isRefreshing = isPullRefreshing && state.isRefreshing,
            onRefresh = {
                isPullRefreshing = true
                onRefresh()
            },
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTapGestures(onTap = { onDismissSearch() })
                },
        ) {
            when {
            state.isLoading && state.projects.isEmpty() && state.pendingInvitations.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            state.errorRes != null && state.projects.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            stringResource(state.errorRes),
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(TTSpacing.lg))
                        Button(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
                    }
                }
            }
            else -> {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = TTSpacing.md,
                        end = TTSpacing.md,
                        top = TTSpacing.sm,
                        bottom = TTSpacing.xl,
                    ),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    if (state.invitationLoadFailed && state.pendingInvitations.isEmpty()) {
                        item(key = "invitation_error") {
                            InvitationLoadErrorCard(onRetry = onRetry)
                        }
                    }

                    if (state.pendingInvitations.isNotEmpty()) {
                        item(key = "invitation_header") {
                            Text(
                                stringResource(R.string.project_invitations),
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = TTSpacing.sm),
                            )
                        }
                        items(state.pendingInvitations, key = { "invite:${it.projectId}" }) { invitation ->
                            ProjectInvitationCard(invitation) { desktopInvitation = invitation }
                        }
                    }

                    if (state.projects.isEmpty()) {
                        item(key = "empty") {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 96.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Icon(
                                    Icons.Default.FolderShared,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(42.dp),
                                )
                                Spacer(Modifier.height(TTSpacing.md))
                                Text(
                                    stringResource(R.string.project_empty_title),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Spacer(Modifier.height(TTSpacing.xs))
                                Text(
                                    stringResource(R.string.project_empty_description),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    } else if (filteredProjects.isEmpty()) {
                        item(key = "search_empty") {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 80.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    stringResource(R.string.project_search_empty),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    } else {
                        items(filteredProjects, key = { it.id }) { project ->
                            ProjectCard(project = project, onClick = { onOpenProject(project) })
                        }
                    }
                }
            }
        }
    }
    }

    desktopInvitation?.let {
        AlertDialog(
            onDismissRequest = { desktopInvitation = null },
            title = { Text(stringResource(R.string.project_invitation_desktop_title)) },
            text = { Text(stringResource(R.string.project_invitation_desktop_body)) },
            confirmButton = {
                TextButton(onClick = { desktopInvitation = null }) {
                    Text(stringResource(R.string.common_confirm))
                }
            },
        )
    }
}

@Composable
private fun InvitationLoadErrorCard(onRetry: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.5f),
    ) {
        Row(
            modifier = Modifier.padding(TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Icon(
                Icons.Default.WarningAmber,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(20.dp),
            )
            Text(
                stringResource(R.string.project_invitation_load_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.common_retry))
            }
        }
    }
}

@Composable
private fun ProjectInvitationCard(
    invitation: PendingProjectInvitation,
    onDesktopAccept: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.07f),
        border = BorderStroke(
            0.5.dp,
            ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.18f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Row(verticalAlignment = Alignment.Top) {
                Icon(
                    Icons.Default.Mail,
                    contentDescription = null,
                    tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    modifier = Modifier.size(24.dp),
                )
                Spacer(Modifier.width(TTSpacing.sm))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        invitation.projectName,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        stringResource(
                            R.string.project_invited_by,
                            invitation.inviterName,
                            invitation.role,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // TODO: 后端将“加入 Project”与“供给本地执行 Space”解耦后，
            // 手机端在这里直接接受成员关系；当前必须保持邀请 pending，不能伪造设备/目录。
            TextButton(onClick = onDesktopAccept) {
                Text(stringResource(R.string.project_invitation_desktop_accept))
            }
        }
    }
}

@Composable
private fun ProjectCard(project: Project, onClick: () -> Unit) {
    val context = LocalContext.current
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.36f),
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            modifier = Modifier.padding(TTSpacing.md),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.11f),
            ) {
                Icon(
                    Icons.Default.FolderShared,
                    contentDescription = null,
                    tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    modifier = Modifier.padding(TTSpacing.sm).size(25.dp),
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                Text(
                    project.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    project.displayDescription ?: stringResource(R.string.project_fallback_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    Icon(Icons.Default.People, contentDescription = null, modifier = Modifier.size(14.dp))
                    Text(
                        stringResource(R.string.project_member_count, project.memberCount ?: 1),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    val timestamp = project.lastActivityAt ?: project.updatedAt ?: project.createdAt
                    timestamp?.let { RelativeTimeFormatter.format(context, it) }?.let { time ->
                        Text("·", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            time,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

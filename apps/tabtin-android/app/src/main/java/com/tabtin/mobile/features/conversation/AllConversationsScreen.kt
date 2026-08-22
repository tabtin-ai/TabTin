package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.features.space.MyAgentsViewModel
import com.tabtin.mobile.ui.components.PendingInteractionPill
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter
import kotlinx.coroutines.delay

/**
 * 「最近」tab 主屏：跨 agent 的近期对话聚合列表，
 * 每条带 agent 徽标。数据源为 [AllSessionsRepository]（cross-space query）。
 *
 * 与 [AgentSessionsScreen] 的差异：
 * - 无"新建对话"顶行——新建对话必须绑定到具体 agent。
 * - 行渲染带 agent avatar + space 名称；session 模型用 [AllChatSession]。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun AllConversationsScreen(
    onSessionClick: (sessionId: String, spaceId: String, spaceName: String, organizationId: String) -> Unit,
    viewModel: AllConversationsViewModel = hiltViewModel(),
    myAgentsViewModel: MyAgentsViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val pendingSessionIds by viewModel.pendingSessionIds.collectAsState()
    val myAgentsState by myAgentsViewModel.uiState.collectAsState()
    val agentsById = remember(myAgentsState.agents) { myAgentsState.agents.associateBy { it.id } }
    val context = LocalContext.current
    val snackbarHostState = remember { androidx.compose.material3.SnackbarHostState() }
    var archiveTarget by remember { mutableStateOf<AllChatSession?>(null) }

    LaunchedEffect(Unit) {
        viewModel.setListQuery(TaskHomeScope.ALL, null)
    }

    LaunchedEffect(state.actionErrorRes) {
        val errorRes = state.actionErrorRes ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(context.getString(errorRes))
        viewModel.consumeActionError()
    }

    Box(modifier = Modifier.fillMaxSize()) {
        PullToRefreshBox(
            isRefreshing = state.isRefreshing,
            onRefresh = viewModel::refresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
            state.isLoading && state.sessions.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }

            state.errorRes != null && state.sessions.isEmpty() -> {
                val errorRes = state.errorRes!!
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = stringResource(errorRes),
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(TTSpacing.lg))
                        Button(onClick = viewModel::load) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
            }

            state.sessions.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            stringResource(R.string.recent_empty_title),
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(TTSpacing.sm))
                        Text(
                            stringResource(R.string.recent_empty_description),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(vertical = TTSpacing.sm),
                ) {
                    items(state.sessions, key = { it.id }) { session ->
                        AllConversationRow(
                            session = session,
                            agentsById = agentsById,
                            isProjectSource = session.projectId != null,
                            hasPendingInteraction = session.id in pendingSessionIds,
                            isArchiving = session.id in state.archivingIds,
                            onClick = {
                                val spaceId = session.spaceId
                                    ?: session.workspaceId
                                    ?: return@AllConversationRow
                                onSessionClick(session.id, spaceId, session.spaceName ?: "", session.organizationId ?: "")
                            },
                            onArchive = { archiveTarget = session },
                        )
                        HorizontalDivider(
                            modifier = Modifier.padding(start = 64.dp),
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
                        )
                    }
                    if (state.hasMore) item(key = "load_more") {
                        TextButton(
                            onClick = viewModel::loadMore,
                            enabled = !state.isLoadingMore,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            if (state.isLoadingMore) {
                                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                            } else {
                                Text(stringResource(R.string.common_load_more))
                            }
                        }
                    }
                }
            }
        }
        }

        androidx.compose.material3.SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    archiveTarget?.let { session ->
        AlertDialog(
            onDismissRequest = { archiveTarget = null },
            title = { Text(stringResource(R.string.session_archive)) },
            text = {
                Text(
                    stringResource(
                        R.string.session_archive_confirm,
                        session.displayTitle.ifEmpty { context.getString(R.string.agent_unnamed_session) },
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        archiveTarget = null
                        viewModel.archiveSession(session.id)
                    },
                    enabled = session.id !in state.archivingIds,
                ) { Text(stringResource(R.string.session_archive)) }
            },
            dismissButton = {
                TextButton(onClick = { archiveTarget = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

/** 任务域的组织级归档列表；查看不会改变归档状态。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ArchivedConversationsScreen(
    onBack: () -> Unit,
    workspaces: List<Space>,
    onSessionClick: (
        sessionId: String,
        workspaceId: String,
        workspaceName: String,
        organizationId: String,
    ) -> Unit,
    viewModel: AllConversationsViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val snackbarHostState = remember { androidx.compose.material3.SnackbarHostState() }
    var restoreTarget by remember { mutableStateOf<AllChatSession?>(null) }
    var deleteTarget by remember { mutableStateOf<AllChatSession?>(null) }
    var searchQuery by remember { mutableStateOf("") }
    var selectedWorkspaceId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(searchQuery, selectedWorkspaceId) {
        if (searchQuery.isNotEmpty()) delay(250)
        viewModel.setListQuery(TaskHomeScope.ARCHIVED, selectedWorkspaceId, searchQuery)
    }
    LaunchedEffect(state.actionErrorRes) {
        val errorRes = state.actionErrorRes ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(context.getString(errorRes))
        viewModel.consumeActionError()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
                title = { Text(stringResource(R.string.task_home_archived)) },
            )
        },
        snackbarHost = { androidx.compose.material3.SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text(stringResource(R.string.archived_conversations_search)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.lg),
            )
            LazyRow(
                contentPadding = PaddingValues(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                item {
                    FilterChip(
                        selected = selectedWorkspaceId == null,
                        onClick = { selectedWorkspaceId = null },
                        label = { Text(stringResource(R.string.task_home_all_workspaces)) },
                    )
                }
                items(workspaces, key = { it.id }) { workspace ->
                    FilterChip(
                        selected = selectedWorkspaceId == workspace.id,
                        onClick = { selectedWorkspaceId = workspace.id },
                        label = { Text(workspace.name, maxLines = 1) },
                    )
                }
            }
            PullToRefreshBox(
                isRefreshing = state.isRefreshing,
                onRefresh = viewModel::refresh,
                modifier = Modifier.fillMaxSize(),
            ) {
            when {
                state.isLoading && state.sessions.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                state.errorRes != null && state.sessions.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Button(onClick = viewModel::load) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
                state.sessions.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(
                                Icons.Default.Archive,
                                contentDescription = null,
                                modifier = Modifier.size(32.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(TTSpacing.md))
                            Text(
                                stringResource(R.string.archived_conversations_empty),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                else -> {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(vertical = TTSpacing.sm),
                    ) {
                        items(state.sessions, key = { it.id }) { session ->
                            ArchivedConversationRow(
                                session = session,
                                busy = session.id in state.restoringIds || session.id in state.deletingIds,
                                onClick = {
                                    val workspaceId = session.workspaceId ?: session.spaceId
                                        ?: return@ArchivedConversationRow
                                    onSessionClick(
                                        session.id,
                                        workspaceId,
                                        session.spaceName.orEmpty(),
                                        session.organizationId ?: viewModel.organizationId.orEmpty(),
                                    )
                                },
                                onRestore = { restoreTarget = session },
                                onDelete = { deleteTarget = session },
                            )
                        }
                        if (state.hasMore) item(key = "load_more") {
                            TextButton(
                                onClick = viewModel::loadMore,
                                enabled = !state.isLoadingMore,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                if (state.isLoadingMore) {
                                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                } else {
                                    Text(stringResource(R.string.common_load_more))
                                }
                            }
                        }
                    }
                }
            }
            }
        }
    }

    restoreTarget?.let { session ->
        AlertDialog(
            onDismissRequest = { restoreTarget = null },
            title = { Text(stringResource(R.string.archived_conversation_restore_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    restoreTarget = null
                    viewModel.restoreSession(session.id)
                }) { Text(stringResource(R.string.archived_session_restore)) }
            },
            dismissButton = {
                TextButton(onClick = { restoreTarget = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    deleteTarget?.let { session ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text(stringResource(R.string.archived_conversation_delete_confirm)) },
            text = { Text(stringResource(R.string.trash_permanent_delete_warning)) },
            confirmButton = {
                TextButton(onClick = {
                    deleteTarget = null
                    viewModel.deleteSessionPermanently(session.id)
                }) {
                    Text(
                        stringResource(R.string.trash_permanent_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@Composable
private fun ArchivedConversationRow(
    session: AllChatSession,
    busy: Boolean,
    onClick: () -> Unit,
    onRestore: () -> Unit,
    onDelete: () -> Unit,
) {
    val context = LocalContext.current
    var showMenu by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !busy, onClick = onClick)
            .padding(start = TTSpacing.lg, end = TTSpacing.xs, top = TTSpacing.sm, bottom = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Default.Archive,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                session.displayTitle.ifEmpty { stringResource(R.string.agent_unnamed_session) },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                session.spaceName?.takeIf { it.isNotBlank() }?.let { workspaceName ->
                    Text(
                        workspaceName,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                val timestamp = session.lastMessageAt ?: session.updatedAt ?: session.createdAt
                timestamp?.let { raw ->
                    RelativeTimeFormatter.format(context, raw)?.let { time ->
                        Text(
                            time,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
        Box {
            IconButton(onClick = { showMenu = true }, enabled = !busy) {
                Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.common_more))
            }
            DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.archived_session_restore)) },
                    leadingIcon = { Icon(Icons.Default.Restore, contentDescription = null) },
                    onClick = {
                        showMenu = false
                        onRestore()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.trash_permanent_delete)) },
                    leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null) },
                    onClick = {
                        showMenu = false
                        onDelete()
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AllConversationRow(
    session: AllChatSession,
    agentsById: Map<String, Agent>,
    isProjectSource: Boolean,
    hasPendingInteraction: Boolean,
    isArchiving: Boolean,
    onClick: () -> Unit,
    onArchive: () -> Unit,
) {
    val context = LocalContext.current
    var showMenu by remember { mutableStateOf(false) }
    Box {
        Surface(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    enabled = !isArchiving,
                    onClick = onClick,
                    onLongClick = { showMenu = true },
                )
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SessionAgentAvatarImage(
                session = session,
                agentsById = agentsById,
                size = 40.dp,
            )
            Spacer(Modifier.size(TTSpacing.md))

            Column(modifier = Modifier.fillMaxWidth().padding(end = TTSpacing.md).run { this }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = session.displayTitle.ifEmpty {
                            stringResource(R.string.agent_unnamed_session)
                        },
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (session.hasActiveTask) {
                        Spacer(Modifier.size(TTSpacing.xs))
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary),
                        )
                    } else if (session.hasUnreadReply) {
                        // 未读回复指示：Agent 回完但用户还没看（与 iOS RecentTabRoot 同口径）
                        Spacer(Modifier.size(TTSpacing.xs))
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)),
                        )
                    }
                    if (hasPendingInteraction) {
                        Spacer(Modifier.size(TTSpacing.sm))
                        PendingInteractionPill()
                    }
                    val timestamp = session.lastMessageAt ?: session.updatedAt ?: session.createdAt
                    timestamp?.let { ts ->
                        RelativeTimeFormatter.format(context, ts)?.let { time ->
                            Spacer(Modifier.size(TTSpacing.sm))
                            Text(
                                text = time,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                val sourceName = if (isProjectSource) {
                    session.projectName ?: session.spaceName
                } else {
                    session.spaceName
                }
                sourceName?.takeIf { it.isNotBlank() }?.let {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "[${stringResource(if (isProjectSource) R.string.project_source_project else R.string.project_source_space)}]",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isProjectSource) {
                                ttColor(TTColors.Primary, TTColors.Dark.Primary)
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                            fontWeight = FontWeight.SemiBold,
                        )
                        Spacer(Modifier.width(TTSpacing.xs))
                        Text(
                            text = it,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                session.lastMessagePreview?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        }
        DropdownMenu(
            expanded = showMenu,
            onDismissRequest = { showMenu = false },
        ) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.session_archive)) },
                onClick = {
                    showMenu = false
                    onArchive()
                },
            )
        }
    }
}

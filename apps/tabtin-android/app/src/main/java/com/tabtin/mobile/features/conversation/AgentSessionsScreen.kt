package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddComment
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
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
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ProjectParticipant
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.ui.components.PendingInteractionPill
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * Space 详情页（与 iOS SpaceSessionsView 对齐）：只展示该 Space 的 Agent 会话列表，
 * 第一行固定「新建对话」，下拉刷新只刷新会话。
 *
 * 「新建对话」直进草稿会话页（空 sessionId + startsNewSession）；用户真正发送时
 * 才会建会话，因而仅浏览或误点不会在服务端留下空 Session。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun AgentSessionsScreen(
    space: Space,
    showBack: Boolean,
    onBack: () -> Unit,
    onNavigateToSettings: (spaceId: String) -> Unit,
    onSessionClick: (sessionId: String, spaceId: String, spaceName: String, organizationId: String) -> Unit,
    onNewSessionDraft: (agentId: String?) -> Unit,
    viewModel: AgentSessionsViewModel = hiltViewModel(key = "agent-sessions-${space.id}"),
) {
    val state by viewModel.uiState.collectAsState()
    val pendingSessionIds by viewModel.pendingSessionIds.collectAsState()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }
    var showAgentPicker by remember { mutableStateOf(false) }
    var archiveTarget by remember { mutableStateOf<ChatSession?>(null) }
    val controllableAgents = state.agents.filter { it.ownedByCurrentUser && it.agentId != null }

    LaunchedEffect(viewModel) {
        viewModel.start(space.id)
    }

    LaunchedEffect(state.errorRes) {
        val errorRes = state.errorRes ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(
            message = context.getString(errorRes),
            duration = SnackbarDuration.Short,
        )
        viewModel.dismissError()
    }

    LaunchedEffect(state.actionErrorRes) {
        val errorRes = state.actionErrorRes ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(
            message = context.getString(errorRes),
            duration = SnackbarDuration.Short,
        )
        viewModel.consumeActionError()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    if (showBack) {
                        IconButton(onClick = onBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(R.string.common_back),
                            )
                        }
                    }
                },
                title = { Text(space.name) },
                actions = {
                    IconButton(onClick = { onNavigateToSettings(space.id) }) {
                        Icon(
                            Icons.Default.Settings,
                            contentDescription = stringResource(R.string.space_settings_title),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            PullToRefreshBox(
                isRefreshing = false,
                onRefresh = {
                    viewModel.loadSessions()
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = TTSpacing.lg),
                ) {
                    if (state.agents.isNotEmpty()) {
                        item(key = "agents_label") {
                            Text(
                                text = stringResource(R.string.space_formal_agents),
                                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(
                                    start = TTSpacing.lg,
                                    end = TTSpacing.lg,
                                    top = TTSpacing.md,
                                    bottom = TTSpacing.xs,
                                ),
                            )
                        }
                        items(state.agents, key = { "agent:${it.id}" }) { agent ->
                            AgentRosterRow(agent)
                        }
                        item(key = "agents_divider") { HorizontalDivider() }
                    }

                    item(key = "conversations_label") {
                        Text(
                            text = stringResource(R.string.agent_conversations_section),
                            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(
                                start = TTSpacing.lg,
                                end = TTSpacing.lg,
                                top = TTSpacing.md,
                                bottom = TTSpacing.xs,
                            ),
                        )
                    }

                    item(key = "new") {
                        NewConversationRow(
                            onClick = {
                                if (controllableAgents.size > 1) {
                                    showAgentPicker = true
                                } else {
                                    onNewSessionDraft(controllableAgents.firstOrNull()?.agentId)
                                }
                            },
                        )
                        HorizontalDivider(
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
                        )
                    }

                    when {
                        state.isLoading && state.sessions.isEmpty() -> {
                            item(key = "loading") {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = TTSpacing.xxl),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    CircularProgressIndicator()
                                }
                            }
                        }
                        state.errorRes != null && state.sessions.isEmpty() -> {
                            item(key = "error") {
                                val errRes = state.errorRes!!
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = TTSpacing.xxl),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    Text(
                                        stringResource(errRes),
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                    Spacer(Modifier.height(TTSpacing.md))
                                    Button(onClick = viewModel::loadSessions) {
                                        Text(stringResource(R.string.common_retry))
                                    }
                                }
                            }
                        }
                        else -> {
                            items(state.sessions, key = { it.id }) { session ->
                                SessionRow(
                                    session = session,
                                    hasPendingInteraction = session.id in pendingSessionIds,
                                    isArchiving = session.id in state.archivingIds,
                                    onClick = {
                                        onSessionClick(session.id, space.id, space.name, space.organizationId)
                                    },
                                    onArchive = { archiveTarget = session },
                                )
                                HorizontalDivider(
                                    modifier = Modifier.padding(start = TTSpacing.xl),
                                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
                                )
                            }
                        }
                    }
                }
            }

            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }

    if (showAgentPicker) {
        AlertDialog(
            onDismissRequest = { showAgentPicker = false },
            title = { Text(stringResource(R.string.project_task_choose_agent)) },
            text = {
                Column {
                    controllableAgents.forEach { agent ->
                        TextButton(
                            onClick = {
                                showAgentPicker = false
                                onNewSessionDraft(agent.agentId)
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text(agent.name, fontWeight = FontWeight.SemiBold)
                                agent.responsibility?.takeIf { it.isNotBlank() }?.let {
                                    Text(
                                        it,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {},
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

@Composable
private fun AgentRosterRow(agent: ProjectParticipant) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Icon(
            Icons.Default.SmartToy,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(22.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                Text(agent.name, fontWeight = FontWeight.SemiBold)
                if (agent.isPrimary) {
                    Text(
                        stringResource(R.string.project_primary_agent_badge),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            agent.roleLabel?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            agent.responsibility?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// ── 会话行 ───────────────────────────────────────────────

@Composable
private fun NewConversationRow(
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        onClick = onClick,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.AddComment,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(18.dp),
                )
            }
            Spacer(Modifier.size(TTSpacing.md))
            Text(
                text = stringResource(R.string.agent_new_conversation),
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    session: ChatSession,
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
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.outlineVariant),
            )
            Spacer(Modifier.size(TTSpacing.md))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = session.displayTitle.ifEmpty {
                        stringResource(R.string.agent_unnamed_session)
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                    val count = session.messageCount ?: 0
                    if (count > 0) {
                        Text(
                            text = stringResource(R.string.agent_message_count, count),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    session.updatedAt?.let { ts ->
                        com.tabtin.mobile.util.RelativeTimeFormatter.format(context, ts)?.let { t ->
                            Text(
                                text = t,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
            if (hasPendingInteraction) {
                Spacer(Modifier.size(TTSpacing.sm))
                PendingInteractionPill()
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

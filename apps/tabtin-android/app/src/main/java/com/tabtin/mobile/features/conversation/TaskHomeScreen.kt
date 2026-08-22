package com.tabtin.mobile.features.conversation

import android.content.Context
import androidx.annotation.StringRes
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.RuntimeDevice
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.ui.components.BrandedPullToRefreshBox
import com.tabtin.mobile.ui.components.PendingInteractionPill
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.unit.Dp

/**
 * 任务首页，对齐 iOS 的 TaskHomeRoot：
 *
 * - 自动化入口在 MainScreen 顶栏下侧次级动作条；此处为范围行 + 扁平任务列表
 * - 置顶 / 需要你 / 其余会话分段展示，不再按 Workspace 切段
 * - 「新任务」经 [onNewTaskClick] / [onNewTaskInWorkspace] 由父级直进草稿会话，不弹 Compose Sheet
 * - 设备状态条只读，不筛选会话；离线说明由会话内 Composer 承担，列表页不重复播报
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TaskHomeScreen(
    onSessionClick: (sessionId: String, workspaceId: String, spaceName: String, organizationId: String) -> Unit,
    spaces: List<Space>,
    executionWorkspaces: List<Space>,
    devicesById: Map<String, RuntimeDevice>,
    onRefreshSpaces: () -> Unit,
    onNewTaskClick: () -> Unit,
    onNewTaskInWorkspace: (Space) -> Unit,
    agents: List<Agent> = emptyList(),
    viewModel: AllConversationsViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val agentsById = remember(agents) { agents.associateBy { it.id } }
    val state by viewModel.uiState.collectAsState()
    val pendingSessionIds by viewModel.pendingSessionIds.collectAsState()
    var archiveTarget by remember { mutableStateOf<AllChatSession?>(null) }
    var isPullRefreshing by remember { mutableStateOf(false) }
    val organizationKey = remember(executionWorkspaces) { executionWorkspaces.firstOrNull()?.organizationId }
    // 状态筛选入口已下线；列表固定看活跃任务，只按 Workspace 过滤。
    val scope = TaskHomeScope.ALL
    var selectedWorkspaceId by remember(organizationKey) { mutableStateOf<String?>(null) }
    val unnamedDevice = stringResource(R.string.task_home_device_unnamed)
    val deviceItems = remember(executionWorkspaces, devicesById, unnamedDevice) {
        TaskHomeDevicePolicy.items(
            workspaceDeviceIds = executionWorkspaces.map { it.executionDeviceId },
            devices = devicesById.values.map {
                TaskHomeDevicePolicy.DeviceInput(
                    id = it.id,
                    name = it.name,
                    isOffline = !it.isAvailableForExecution,
                )
            },
            fallbackName = unnamedDevice,
        )
    }
    val listState = rememberLazyListState()
    val executionWorkspaceIds = remember(executionWorkspaces) { executionWorkspaces.map { it.id }.toSet() }

    // 换组织后旧 workspaceId 仍在，留着会把列表按一个当前组织不存在的 Workspace 过滤成空。
    LaunchedEffect(organizationKey, scope, selectedWorkspaceId, executionWorkspaceIds) {
        val sanitized = TaskHomeListPolicy.sanitizedWorkspaceId(selectedWorkspaceId, executionWorkspaceIds)
        if (sanitized != selectedWorkspaceId) selectedWorkspaceId = sanitized
        viewModel.setListQuery(scope, sanitized)
    }

    androidx.lifecycle.compose.LifecycleResumeEffect(Unit) {
        viewModel.refresh()
        onRefreshSpaces()
        onPauseOrDispose { }
    }

    // 前台恢复也会静默同步任务；只有用户主动下拉才显示刷新指示器。
    LaunchedEffect(state.isRefreshing) {
        if (!state.isRefreshing) isPullRefreshing = false
    }

    val orderedSessions = remember(state.sessions) {
        state.sessions
            .asSequence()
            .sortedWith(
                compareByDescending<AllChatSession> { it.lastMessageAt ?: it.updatedAt ?: it.createdAt ?: "" }
                    .thenBy { it.id },
            )
            .toList()
    }
    // 只按 Workspace 过滤；运行范围固定为活跃任务。
    val visibleSessions = remember(orderedSessions, scope, selectedWorkspaceId) {
        orderedSessions.filter { session ->
            if (!scope.matches(session)) return@filter false
            selectedWorkspaceId?.let { workspaceId ->
                session.taskExecutionWorkspaceId == workspaceId
            } ?: true
        }
    }
    val pinnedSessions = remember(visibleSessions) {
        visibleSessions.filter { it.isPinned }
    }
    val pinnedIds = remember(pinnedSessions) { pinnedSessions.map { it.id }.toSet() }
    val needsYouSessions = remember(visibleSessions, pinnedIds) {
        visibleSessions.filter { session ->
            session.id !in pinnedIds &&
                session.runState?.status == SessionRunStatus.WAITING_USER
        }
    }
    val needsYouIds = remember(needsYouSessions) { needsYouSessions.map { it.id }.toSet() }
    val restSessions = remember(visibleSessions, pinnedIds, needsYouIds) {
        visibleSessions.filter { it.id !in pinnedIds && it.id !in needsYouIds }
    }
    val sessionGroups = remember(pinnedSessions, needsYouSessions, restSessions) {
        TaskHomeSessionGrouping.groups(pinnedSessions, needsYouSessions, restSessions)
    }

    BrandedPullToRefreshBox(
        isRefreshing = isPullRefreshing && state.isRefreshing,
        onRefresh = {
            isPullRefreshing = true
            viewModel.refresh()
            onRefreshSpaces()
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        when {
            state.errorRes != null && orderedSessions.isEmpty() -> TaskSessionError(
                message = stringResource(state.errorRes!!),
                onRetry = viewModel::load,
            )
            state.isLoading && orderedSessions.isEmpty() -> {
                LazyColumn(state = listState) {
                    item(key = "scroll_header") {
                        TaskHomeScrollHeader(
                            deviceItems = deviceItems,
                            executionWorkspaces = executionWorkspaces,
                            selectedWorkspaceId = selectedWorkspaceId,
                            onWorkspaceChange = { selectedWorkspaceId = it },
                            onNewTaskClick = onNewTaskClick,
                            onNewTaskInWorkspace = onNewTaskInWorkspace,
                        )
                    }
                    item(key = "loading") {
                        Box(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 80.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator()
                        }
                    }
                }
            }
            orderedSessions.isEmpty() -> {
                LazyColumn(state = listState) {
                    item(key = "scroll_header") {
                        TaskHomeScrollHeader(
                            deviceItems = deviceItems,
                            executionWorkspaces = executionWorkspaces,
                            selectedWorkspaceId = selectedWorkspaceId,
                            onWorkspaceChange = { selectedWorkspaceId = it },
                            onNewTaskClick = onNewTaskClick,
                            onNewTaskInWorkspace = onNewTaskInWorkspace,
                        )
                    }
                    item(key = "empty") {
                        EmptyTaskSessions(
                            onNewTaskClick = {
                                val prefs = context.getSharedPreferences(
                                    COMPOSE_PREFS_NAME,
                                    Context.MODE_PRIVATE,
                                )
                                val resolved = NewTaskWorkspacePolicy.resolve(
                                    workspaces = executionWorkspaces,
                                    selectedWorkspaceId = selectedWorkspaceId,
                                    recentWorkspaceId = prefs.getString(COMPOSE_LAST_WORKSPACE_KEY, null),
                                )
                                if (resolved != null) onNewTaskInWorkspace(resolved) else onNewTaskClick()
                            },
                            modifier = Modifier.fillMaxWidth().padding(top = 72.dp),
                        )
                    }
                }
            }
            else -> LazyColumn(
                state = listState,
                // 顶部不要 contentPadding：否则会露出 Scaffold 默认白底，在顶栏与灰区卡片之间形成白线。
                contentPadding = PaddingValues(bottom = TTSpacing.xs),
            ) {
                item(key = "scroll_header") {
                    TaskHomeScrollHeader(
                        deviceItems = deviceItems,
                        executionWorkspaces = executionWorkspaces,
                        selectedWorkspaceId = selectedWorkspaceId,
                        onWorkspaceChange = { selectedWorkspaceId = it },
                        onNewTaskClick = onNewTaskClick,
                        onNewTaskInWorkspace = onNewTaskInWorkspace,
                    )
                }
                sessionGroups.forEach { group ->
                    item(key = "band_${group.band.name}") {
                        TaskHomeBandHeader(band = group.band)
                    }
                    items(group.sessions, key = { "${group.band.name}-${it.id}" }) { session ->
                        TaskSessionListItem(
                            session = session,
                            isPinned = group.band == TaskHomeSessionGrouping.Band.PINNED ||
                                session.isPinned,
                            hasPendingInteraction = session.id in pendingSessionIds,
                            isArchiving = session.id in state.archivingIds,
                            agentsById = agentsById,
                            onSessionClick = onSessionClick,
                            onTogglePin = { viewModel.setSessionPinned(session.id, !session.isPinned) },
                            onArchive = { archiveTarget = session },
                        )
                    }
                }
                if (state.hasMore) {
                    item(key = "load_more") {
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

    archiveTarget?.let { session ->
        AlertDialog(
            onDismissRequest = { archiveTarget = null },
            title = { Text(stringResource(R.string.session_archive)) },
            text = {
                Text(
                    stringResource(
                        R.string.session_archive_confirm,
                        session.displayTitle.ifEmpty { stringResource(R.string.agent_unnamed_session) },
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
                TextButton(onClick = { archiveTarget = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }
}

@Composable
private fun TaskHomeBandHeader(band: TaskHomeSessionGrouping.Band) {
    // 分段标题只是坐标，不是内容：弱色、无底、无计数徽章，让列表本身说话。
    val tint = if (band == TaskHomeSessionGrouping.Band.NEEDS_YOU) {
        ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(
                start = TTSpacing.lg,
                end = TTSpacing.lg,
                top = TTSpacing.md,
                bottom = TTSpacing.xs,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        if (band.showsPinGlyph) {
            Icon(
                imageVector = Icons.Default.PushPin,
                contentDescription = null,
                modifier = Modifier.size(13.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text = stringResource(bandTitleRes(band)),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = tint,
        )
    }
}

@StringRes
private fun bandTitleRes(band: TaskHomeSessionGrouping.Band): Int = when (band) {
    TaskHomeSessionGrouping.Band.PINNED -> R.string.task_home_segment_pinned
    TaskHomeSessionGrouping.Band.NEEDS_YOU -> R.string.task_home_band_needs_you
    TaskHomeSessionGrouping.Band.TODAY -> R.string.common_today
    TaskHomeSessionGrouping.Band.YESTERDAY -> R.string.common_yesterday
    TaskHomeSessionGrouping.Band.LAST_7_DAYS -> R.string.task_home_group_last_7_days
    TaskHomeSessionGrouping.Band.LAST_30_DAYS -> R.string.task_home_group_last_30_days
    TaskHomeSessionGrouping.Band.EARLIER -> R.string.task_home_group_earlier
}

@Composable
private fun TaskSessionListItem(
    session: AllChatSession,
    isPinned: Boolean,
    hasPendingInteraction: Boolean,
    isArchiving: Boolean,
    agentsById: Map<String, Agent>,
    onSessionClick: (sessionId: String, workspaceId: String, spaceName: String, organizationId: String) -> Unit,
    onTogglePin: () -> Unit,
    onArchive: () -> Unit,
) {
    TaskSessionRow(
        session = session,
        isPinned = isPinned,
        hasPendingInteraction = hasPendingInteraction,
        isArchiving = isArchiving,
        agentsById = agentsById,
        onClick = {
            val workspaceId = session.taskExecutionWorkspaceId ?: return@TaskSessionRow
            onSessionClick(
                session.id,
                workspaceId,
                session.spaceName.orEmpty(),
                session.organizationId.orEmpty(),
            )
        },
        onTogglePin = onTogglePin,
        onArchive = onArchive,
    )
    // 不画分隔线：44dp 头像本身就是每行的左边界，再加横线只会把列表切碎。
}

@Composable
private fun TaskHomeScrollHeader(
    deviceItems: List<TaskHomeDevicePolicy.DeviceItem>,
    executionWorkspaces: List<Space>,
    selectedWorkspaceId: String?,
    onWorkspaceChange: (String?) -> Unit,
    onNewTaskClick: () -> Unit,
    onNewTaskInWorkspace: (Space) -> Unit,
) {
    val accentColor = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val sidebarColor = ttColor(TTColors.BgSidebar, TTColors.Dark.BgSidebar)
    val context = LocalContext.current
    var workspaceMenuExpanded by remember { mutableStateOf(false) }

    val scopeTitle = selectedWorkspaceId?.let { workspaceId ->
        executionWorkspaces.firstOrNull { it.id == workspaceId }?.name
    } ?: stringResource(R.string.task_home_all_workspaces)

    Column(modifier = Modifier.fillMaxWidth()) {
        if (TaskHomeDevicePolicy.shouldShowRail(deviceItems)) {
            TaskHomeDeviceRail(
                items = deviceItems,
                modifier = Modifier
                    .background(sidebarColor)
                    .padding(top = TTSpacing.sm, bottom = TTSpacing.xs),
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(ttColor(TTColors.Surface, TTColors.Dark.Surface))
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                Row(
                    modifier = Modifier.clickable { workspaceMenuExpanded = true },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = scopeTitle,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Icon(
                        imageVector = Icons.Default.KeyboardArrowDown,
                        contentDescription = stringResource(R.string.task_home_workspace_filter),
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                DropdownMenu(
                    expanded = workspaceMenuExpanded,
                    onDismissRequest = { workspaceMenuExpanded = false },
                ) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.task_home_all_workspaces)) },
                        onClick = {
                            workspaceMenuExpanded = false
                            onWorkspaceChange(null)
                        },
                    )
                    executionWorkspaces.forEach { workspace ->
                        DropdownMenuItem(
                            text = { Text(workspace.name) },
                            onClick = {
                                workspaceMenuExpanded = false
                                onWorkspaceChange(workspace.id)
                            },
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            // 直接进草稿：新任务页可切换 Workspace，入口不再弹选择器。
            Row(
                modifier = Modifier
                    .clickable {
                        val prefs = context.getSharedPreferences(
                            COMPOSE_PREFS_NAME,
                            Context.MODE_PRIVATE,
                        )
                        val resolved = NewTaskWorkspacePolicy.resolve(
                            workspaces = executionWorkspaces,
                            selectedWorkspaceId = selectedWorkspaceId,
                            recentWorkspaceId = prefs.getString(COMPOSE_LAST_WORKSPACE_KEY, null),
                        )
                        if (resolved != null) {
                            onNewTaskInWorkspace(resolved)
                        } else {
                            onNewTaskClick()
                        }
                    }
                    .height(44.dp)
                    .padding(horizontal = TTSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    painter = painterResource(R.drawable.lucide_square_pen),
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = accentColor,
                )
                Spacer(Modifier.width(TTSpacing.xxs))
                Text(
                    text = stringResource(R.string.task_home_new_task),
                    style = MaterialTheme.typography.bodyMedium,
                    color = accentColor,
                )
            }
        }
    }
}

private const val COMPOSE_PREFS_NAME = "tabtin_compose"
private const val COMPOSE_LAST_WORKSPACE_KEY = "last_workspace_id"

internal const val UNKNOWN_TASK_WORKSPACE_SECTION_ID = "unknown-workspace"

/** 任务会话只以执行 Workspace 为锚；Project 的 `spaceId` 不能参与执行路由。 */
internal val AllChatSession.taskExecutionWorkspaceId: String?
    get() = workspaceId?.takeIf { it.isNotBlank() }

internal fun taskWorkspaceSectionId(session: AllChatSession): String =
    session.taskExecutionWorkspaceId ?: UNKNOWN_TASK_WORKSPACE_SECTION_ID

internal fun AllChatSession.matchesTaskSearch(query: String): Boolean {
    val normalizedQuery = query.trim()
    return normalizedQuery.isEmpty() || listOfNotNull(
        title,
        agentName,
        spaceName,
        lastMessagePreview,
    ).any { it.contains(normalizedQuery, ignoreCase = true) }
}


@Composable
private fun TaskSessionError(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, color = MaterialTheme.colorScheme.error)
        Spacer(Modifier.height(TTSpacing.lg))
        Button(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
    }
}

@Composable
private fun EmptyTaskSessions(
    onNewTaskClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(horizontal = TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = stringResource(R.string.task_home_empty_title),
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = stringResource(R.string.task_home_empty_description),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = onNewTaskClick) {
            Text(stringResource(R.string.task_home_new_task))
        }
    }
}

/**
 * 任务行第二行：归属名常驻，状态文案只在非静默态出现（完成 / 静默由锚点表达）。
 * 全是弱文本，靠 `·` 串起来——不用灰底 chip，色块在列表里太吵。
 */
@Composable
private fun TaskSessionSecondLine(line: TaskRowContentPolicy.SecondLine) {
    if (!line.isOccupied) return
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // 状态用语义色喊人；预览和归属是背景信息，一律弱色，别跟状态抢注意力。
    val textColor = when (line.kind) {
        TaskRowContentPolicy.Kind.STATUS -> when {
            line.status.isAttention -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
            line.status == TaskRowStatus.FAILED ->
                ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
            line.status == TaskRowStatus.RUNNING ->
                ttColor(TTColors.BgRunning, TTColors.Dark.BgRunning)
            else -> muted
        }
        else -> muted
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        if (line.isArchived) {
            Text(
                text = stringResource(R.string.task_home_scope_archived),
                style = MaterialTheme.typography.labelMedium,
                color = muted,
                maxLines = 1,
            )
            if (line.text != null || line.statusTextRes != null) TaskSessionMetaSeparator(muted)
        }
        val body = line.text ?: line.statusTextRes?.let { stringResource(it) }
        if (body != null) {
            Text(
                text = body,
                style = MaterialTheme.typography.labelMedium,
                color = textColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun TaskSessionMetaSeparator(muted: Color) {
    Text(
        text = "·",
        style = MaterialTheme.typography.labelSmall,
        color = muted.copy(alpha = 0.6f),
    )
}

/**
 * 任务行左侧状态槽：只在「需要你知道」时才亮起来。
 *
 * 刻意不做圆底徽章——填充色块是 CRM 表格的语言，一屏十条就是十个色块。这里只留
 * 一个细小的信号，静默完成态干脆什么都不画：完成是列表常态，给常态配图标只会把
 * 真正要紧的那两条淹掉。槽位宽高固定，标题始终对齐。
 *
 * 语义与 iOS `TaskHomeSessionAnchor`、Electron 侧栏 `SessionStatusIcon` 同源
 * （含 idle 已读不渲染）。
 */
@Composable
private fun TaskHomeSessionAnchor(
    status: TaskRowStatus,
    width: Dp = 18.dp,
    // 槽高对齐标题首行，信号与标题视觉居中，不被第二行拉偏。
    height: Dp = 22.dp,
) {
    val warning = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
    val accent = ttColor(TTColors.BgRunning, TTColors.Dark.BgRunning)
    val label = stringResource(TaskRowStatusPresentation.accessibilityTextRes(status))

    Box(modifier = Modifier.size(width, height), contentAlignment = Alignment.Center) {
        when (status) {
            // 在跑就该动——静态图标没法把「此刻正在推进」和「停在那儿」区分开。
            TaskRowStatus.RUNNING -> CircularProgressIndicator(
                modifier = Modifier.size(13.dp).semantics { contentDescription = label },
                strokeWidth = 1.5.dp,
                color = accent,
            )
            TaskRowStatus.WAITING_USER -> Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(warning.copy(alpha = 0.8f))
                    .semantics { contentDescription = label },
            )
            // 暂停是 Agent 自己停下，不是在等你：空心点，比实心弱一档。
            TaskRowStatus.PAUSED -> Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .border(1.5.dp, warning.copy(alpha = 0.7f), CircleShape)
                    .semantics { contentDescription = label },
            )
            TaskRowStatus.FAILED -> Icon(
                imageVector = Icons.Outlined.ErrorOutline,
                contentDescription = label,
                modifier = Modifier.size(15.dp),
                tint = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
                    .copy(alpha = 0.8f),
            )
            TaskRowStatus.DONE_UNREAD -> Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(accent.copy(alpha = 0.85f))
                    .semantics { contentDescription = label },
            )
            // 已读完成 / 静默（含 cancelled、interrupted）：不画。留白本身就是「不用管」。
            TaskRowStatus.DONE -> Unit
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TaskSessionRow(
    session: AllChatSession,
    isPinned: Boolean,
    hasPendingInteraction: Boolean,
    isArchiving: Boolean,
    agentsById: Map<String, Agent>,
    onClick: () -> Unit,
    onTogglePin: () -> Unit,
    onArchive: () -> Unit,
) {
    val context = LocalContext.current
    var showMenu by remember { mutableStateOf(false) }
    val status = remember(session, hasPendingInteraction) {
        TaskRowStatusPresentation.resolve(session, hasPendingInteraction)
    }
    val secondLine = remember(session, status) {
        TaskRowContentPolicy.secondLine(session, status)
    }
    Box {
        Surface(modifier = Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface) {
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
                TaskHomeSessionAvatar(session = session, status = status, agentsById = agentsById)
                Spacer(Modifier.size(TTSpacing.md))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = session.displayTitle.ifEmpty { stringResource(R.string.agent_unnamed_session) },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        // 服务端还没生成标题时给的是占位文案，不是用户写的内容——弱化它。
                        color = if (session.displayTitle.isEmpty()) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                        maxLines = TaskRowContentPolicy.titleMaxLines(secondLine),
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.size(TTSpacing.xs))
                    TaskSessionSecondLine(secondLine)
                }
                // 时间与图钉右对齐成一列：扫列表时目光只在一条竖线上走，不被标题长短带偏。
                Spacer(Modifier.size(TTSpacing.sm))
                Column(horizontalAlignment = Alignment.End) {
                    (session.lastMessageAt ?: session.updatedAt ?: session.createdAt)?.let { raw ->
                        RelativeTimeFormatter.format(context, raw)?.let { time ->
                            Text(
                                time,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                    if (isPinned) {
                        Spacer(Modifier.size(TTSpacing.xs))
                        Icon(
                            imageVector = Icons.Default.PushPin,
                            contentDescription = stringResource(R.string.task_home_unpin),
                            modifier = Modifier.size(13.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
        DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(if (isPinned) R.string.task_home_unpin else R.string.task_home_pin)) },
                leadingIcon = {
                    Icon(
                        imageVector = Icons.Default.PushPin,
                        contentDescription = null,
                    )
                },
                onClick = {
                    showMenu = false
                    onTogglePin()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.session_archive)) },
                leadingIcon = { Icon(Icons.Default.Archive, contentDescription = null) },
                onClick = {
                    showMenu = false
                    onArchive()
                },
            )
        }
    }
}

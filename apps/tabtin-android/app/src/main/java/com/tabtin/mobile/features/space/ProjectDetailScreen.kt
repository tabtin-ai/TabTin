package com.tabtin.mobile.features.space

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Numbers
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Project
import com.tabtin.mobile.data.model.ProjectActivityEvent
import com.tabtin.mobile.data.model.ProjectDiscussion
import com.tabtin.mobile.data.model.ProjectParticipant
import com.tabtin.mobile.data.model.ProjectParticipantKind
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter

private enum class ProjectDetailSection { DISCUSSION, ASSETS, ACTIVITY, MEMBERS }

/** Project 移动协作页。讨论、资产、动态保持只读；任务遥控和主要 Agent 设置按权限开放。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ProjectDetailScreen(
    state: ProjectUiState,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onStartTask: (Project) -> Unit,
    onSetPrimaryAgent: (String) -> Unit,
    onOpenMemberDirectMessage: (userId: String, displayName: String) -> Unit = { _, _ -> },
    onAgentMemberTap: () -> Unit = {},
    currentUserId: String? = null,
) {
    val project = state.selectedProject ?: return
    var selectedTab by remember(project.id) { mutableIntStateOf(0) }
    val sections = ProjectDetailSection.entries

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(project.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            val detailFailed = state.detail?.detailFailed == true
            ProjectHeader(project)
            ProjectExecutionNotice(project, detailFailed = detailFailed)
            ProjectTaskLauncher(project = project, detailFailed = detailFailed, onStartTask = onStartTask)

            PrimaryScrollableTabRow(
                selectedTabIndex = selectedTab,
                edgePadding = 0.dp,
                divider = {},
            ) {
                sections.forEachIndexed { index, section ->
                    Tab(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        text = { Text(sectionTitle(section)) },
                    )
                }
            }

            when {
                state.isLoadingDetail -> {
                    Box(
                        modifier = Modifier.fillMaxWidth().height(220.dp),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator() }
                }
                state.detailErrorRes != null && state.detail == null -> {
                    Column(
                        modifier = Modifier.fillMaxWidth().height(220.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text(stringResource(state.detailErrorRes), color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = onRetry) {
                            Icon(Icons.Default.Refresh, contentDescription = null)
                            Spacer(Modifier.width(TTSpacing.xs))
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
                else -> {
                    if (state.detail?.hasPartialFailure == true) {
                        ProjectPartialError(onRetry)
                    }
                    val detail = state.detail
                    when (sections[selectedTab]) {
                        ProjectDetailSection.DISCUSSION -> ProjectDiscussionSection(detail?.discussions.orEmpty())
                        ProjectDetailSection.ASSETS -> ProjectAssetSection(detail?.assets.orEmpty())
                        ProjectDetailSection.ACTIVITY -> ProjectActivitySection(detail?.activities.orEmpty())
                        ProjectDetailSection.MEMBERS -> ProjectMemberSection(
                            items = detail?.participants.orEmpty(),
                            canManage = project.canManage,
                            isUpdating = state.isUpdatingPrimaryAgent,
                            currentUserId = currentUserId,
                            onSetPrimaryAgent = onSetPrimaryAgent,
                            onOpenMemberDirectMessage = onOpenMemberDirectMessage,
                            onAgentMemberTap = onAgentMemberTap,
                        )
                    }
                }
            }
            Spacer(Modifier.height(TTSpacing.xl))
        }
    }
}

@Composable
private fun sectionTitle(section: ProjectDetailSection): String = when (section) {
    ProjectDetailSection.DISCUSSION -> stringResource(R.string.project_tab_discussion)
    ProjectDetailSection.ASSETS -> stringResource(R.string.project_tab_assets)
    ProjectDetailSection.ACTIVITY -> stringResource(R.string.project_tab_activity)
    ProjectDetailSection.MEMBERS -> stringResource(R.string.project_tab_members)
}

@Composable
private fun ProjectHeader(project: Project) {
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        Text(
            stringResource(R.string.project_header_label),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            project.displayDescription ?: stringResource(R.string.project_fallback_description),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
            Text(
                stringResource(R.string.project_member_count, project.memberCount ?: 1),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val timestamp = project.lastActivityAt ?: project.updatedAt ?: project.createdAt
            timestamp?.let { RelativeTimeFormatter.format(context, it) }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ProjectExecutionNotice(project: Project, detailFailed: Boolean) {
    // 用 BgSubtle + 细边，避免 Primary 半透明叠在暖底上发脏。
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
        border = BorderStroke(
            0.5.dp,
            ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight),
        ),
    ) {
        Row(
            modifier = Modifier.padding(TTSpacing.md),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Icon(
                Icons.Default.Info,
                contentDescription = null,
                tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
                modifier = Modifier.size(19.dp),
            )
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                Text(
                    stringResource(R.string.project_execution_title),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    if (project.myWorkspace == null) {
                        if (detailFailed) {
                            stringResource(R.string.project_task_load_failed)
                        } else {
                            stringResource(R.string.project_execution_unavailable)
                        }
                    } else {
                        stringResource(
                            R.string.project_execution_ready,
                            project.myWorkspace.name?.takeIf { it.isNotBlank() }
                                ?: stringResource(R.string.common_tab_space),
                        )
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ProjectTaskLauncher(project: Project, detailFailed: Boolean, onStartTask: (Project) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        Button(
            onClick = { onStartTask(project) },
            enabled = project.myWorkspace != null,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.common_send))
            Spacer(Modifier.width(TTSpacing.sm))
            Text(stringResource(R.string.project_start_task))
        }
        // detailFailed 时执行说明框已展示失败文案，这里不再重复；仅在真无 workspace 时提示。
        if (project.myWorkspace == null && !detailFailed) {
            Text(
                stringResource(R.string.project_task_no_workspace),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ProjectPartialError(onRetry: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(10.dp),
        color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.45f),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.project_partial_load_error),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
        }
    }
}

@Composable
private fun ProjectSectionIntro(text: String, showsReadOnlyHint: Boolean = true) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (showsReadOnlyHint) {
            Text(
                stringResource(R.string.project_read_only_hint),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
            )
        }
    }
}

@Composable
private fun ProjectDiscussionSection(items: List<ProjectDiscussion>) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
        ProjectSectionIntro(stringResource(R.string.project_discussion_intro))
        if (items.isEmpty()) {
            ProjectEmptyCard(Icons.Default.ChatBubbleOutline, stringResource(R.string.project_discussion_empty))
        } else {
            ProjectListCard {
                items.forEachIndexed { index, item ->
                    ProjectDetailRow(
                        icon = { Icon(Icons.Default.Numbers, contentDescription = null) },
                        title = item.name,
                        subtitle = item.lastMessagePreview?.takeIf { it.isNotBlank() }
                            ?: when (item.name) {
                                "#general" -> stringResource(R.string.project_discussion_general)
                                "#agent-updates" -> stringResource(R.string.project_discussion_agent_updates)
                                else -> stringResource(R.string.project_discussion_intro)
                            },
                        meta = item.memberCount?.let { stringResource(R.string.project_discussion_member_count, it) },
                    )
                    if (index != items.lastIndex) HorizontalDivider(modifier = Modifier.padding(start = 54.dp))
                }
            }
        }
    }
}

@Composable
private fun ProjectAssetSection(items: List<SpaceResource>) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
        ProjectSectionIntro(stringResource(R.string.project_assets_intro))
        if (items.isEmpty()) {
            ProjectEmptyCard(Icons.AutoMirrored.Filled.Article, stringResource(R.string.project_assets_empty))
        } else {
            ProjectListCard {
                items.forEachIndexed { index, item ->
                    ProjectDetailRow(
                        icon = { Text(item.emoji) },
                        title = item.title.ifBlank { stringResource(R.string.project_unnamed_asset) },
                        subtitle = item.typeLabel,
                    )
                    if (index != items.lastIndex) HorizontalDivider(modifier = Modifier.padding(start = 54.dp))
                }
            }
        }
    }
}

@Composable
private fun ProjectActivitySection(items: List<ProjectActivityEvent>) {
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
        ProjectSectionIntro(stringResource(R.string.project_activity_intro))
        if (items.isEmpty()) {
            ProjectEmptyCard(Icons.Default.History, stringResource(R.string.project_activity_empty))
        } else {
            ProjectListCard {
                items.forEachIndexed { index, item ->
                    val actor = item.actorName?.takeIf { it.isNotBlank() }
                        ?: stringResource(R.string.project_unknown_actor)
                    val target = item.targetName?.takeIf { it.isNotBlank() }
                        ?: stringResource(R.string.project_unknown_target)
                    ProjectDetailRow(
                        icon = { Icon(Icons.Default.History, contentDescription = null) },
                        title = stringResource(R.string.project_activity_generic, actor, target),
                        subtitle = RelativeTimeFormatter.format(context, item.createdAt),
                    )
                    if (index != items.lastIndex) HorizontalDivider(modifier = Modifier.padding(start = 54.dp))
                }
            }
        }
    }
}

@Composable
private fun ProjectMemberSection(
    items: List<ProjectParticipant>,
    canManage: Boolean,
    isUpdating: Boolean,
    currentUserId: String?,
    onSetPrimaryAgent: (String) -> Unit,
    onOpenMemberDirectMessage: (userId: String, displayName: String) -> Unit,
    onAgentMemberTap: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
        ProjectSectionIntro(
            text = stringResource(R.string.project_members_intro),
            showsReadOnlyHint = false,
        )
        if (items.isEmpty()) {
            ProjectEmptyCard(Icons.Default.People, stringResource(R.string.project_members_empty))
        } else {
            ProjectListCard {
                items.forEachIndexed { index, item ->
                    val kind = if (item.kind == ProjectParticipantKind.AGENT) {
                        stringResource(R.string.project_agent_kind)
                    } else {
                        stringResource(R.string.project_member_kind)
                    }
                    val role = item.roleLabel?.takeIf { it.isNotBlank() } ?: item.role
                    val isSelf = item.kind == ProjectParticipantKind.MEMBER &&
                        !item.userId.isNullOrBlank() &&
                        item.userId == currentUserId
                    val onRowClick: (() -> Unit)? = when {
                        item.kind == ProjectParticipantKind.AGENT -> onAgentMemberTap
                        !item.userId.isNullOrBlank() && !isSelf -> {
                            { onOpenMemberDirectMessage(item.userId, item.name) }
                        }
                        else -> null
                    }
                    ProjectDetailRow(
                        icon = {
                            Icon(
                                if (item.kind == ProjectParticipantKind.AGENT) Icons.Default.SmartToy else Icons.Default.Person,
                                contentDescription = null,
                            )
                        },
                        title = item.name,
                        subtitle = "$kind · $role",
                        meta = item.responsibility?.takeIf { it.isNotBlank() },
                        onClick = onRowClick,
                        action = if (item.kind == ProjectParticipantKind.AGENT && item.agentId != null) {
                            {
                                if (item.isPrimary) {
                                    Text(
                                        stringResource(R.string.project_primary_agent_badge),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                } else if (canManage) {
                                    TextButton(
                                        onClick = { onSetPrimaryAgent(item.agentId) },
                                        enabled = !isUpdating,
                                    ) {
                                        Text(stringResource(R.string.project_set_primary_agent))
                                    }
                                }
                            }
                        } else null,
                    )
                    if (index != items.lastIndex) HorizontalDivider(modifier = Modifier.padding(start = 54.dp))
                }
            }
        }
    }
}

@Composable
private fun ProjectListCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.32f),
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(content = content)
    }
}

@Composable
private fun ProjectDetailRow(
    icon: @Composable () -> Unit,
    title: String,
    subtitle: String? = null,
    meta: String? = null,
    onClick: (() -> Unit)? = null,
    action: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (onClick != null) {
                    Modifier.clickable(
                        role = Role.Button,
                        onClick = onClick,
                    )
                } else {
                    Modifier
                },
            )
            .padding(TTSpacing.md),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.10f),
        ) {
            Box(modifier = Modifier.size(34.dp), contentAlignment = Alignment.Center) { icon() }
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            subtitle?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            meta?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        action?.invoke()
    }
}

@Composable
private fun ProjectEmptyCard(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    text: String,
) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.32f),
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(TTSpacing.lg),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

package com.tabtin.mobile.features.notification

import android.graphics.Paint
import android.graphics.Typeface
import androidx.annotation.StringRes
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Mail
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImApi
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.MobileNotificationTarget
import com.tabtin.mobile.data.model.MobileNotificationChatSessionTargetResolver
import com.tabtin.mobile.data.model.MobileNotificationOpenScopePolicy
import com.tabtin.mobile.data.model.MobileNotificationTargetResolver
import com.tabtin.mobile.data.model.NotificationItem
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.NotificationRepository
import com.tabtin.mobile.data.repository.NotificationState
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.PendingInteractionRepository
import com.tabtin.mobile.data.repository.ProjectRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.repository.TrackerRepository
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

public data class NotificationOpenRequest(
    val notification: NotificationItem,
    val target: MobileNotificationTarget,
)

@HiltViewModel
public class NotificationCenterViewModel @Inject constructor(
    private val repository: NotificationRepository,
    private val organizationRepository: OrganizationRepository,
    private val chatRepository: ChatRepository,
    private val trackerRepository: TrackerRepository,
    private val pendingInteractionRepository: PendingInteractionRepository,
    private val projectRepository: ProjectRepository,
    private val spaceRepository: SpaceRepository,
    private val imApi: ImApi,
) : ViewModel() {
    public val state: StateFlow<NotificationState> = repository.state
    private val _projectNamesById = MutableStateFlow<Map<String, String>>(emptyMap())
    public val projectNamesById: StateFlow<Map<String, String>> = _projectNamesById.asStateFlow()
    private val _workspaceNamesById = MutableStateFlow<Map<String, String>>(emptyMap())
    public val workspaceNamesById: StateFlow<Map<String, String>> = _workspaceNamesById.asStateFlow()
    private var contextOrganizationId: String? = null

    init {
        viewModelScope.launch {
            organizationRepository.selectedOrganization.collectLatest { organization ->
                if (contextOrganizationId != organization?.id) {
                    contextOrganizationId = organization?.id
                    _projectNamesById.value = emptyMap()
                    _workspaceNamesById.value = emptyMap()
                }
                repository.activate(organization?.id)
                organization?.id?.let { reloadContextNames(it) }
            }
        }
    }

    public fun refresh() {
        viewModelScope.launch {
            repository.reload()
            repository.reloadUnreadCount()
            organizationRepository.selectedOrganization.value?.id?.let { reloadContextNames(it) }
        }
    }

    /** 名称只增强通知展示；任一目录加载失败都不影响通知列表和点击。 */
    private suspend fun reloadContextNames(organizationId: String): Unit = coroutineScope {
        val projects = async {
            try {
                projectRepository.getProjects(organizationId)
                    .mapNotNull { project -> project.name.normalized()?.let { project.id to it } }
                    .toMap()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
        }
        val workspaces = async {
            try {
                spaceRepository.getSpaces()
                    .mapNotNull { workspace -> workspace.name.normalized()?.let { workspace.id to it } }
                    .toMap()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
        }
        val projectNames = projects.await()
        val workspaceNames = workspaces.await()
        if (contextOrganizationId != organizationId) return@coroutineScope
        projectNames?.let { _projectNamesById.value = it }
        workspaceNames?.let { _workspaceNamesById.value = it }
    }

    public fun markAllRead() {
        viewModelScope.launch { repository.markAllRead() }
    }

    public fun consumeMarkAllReadFailure() {
        repository.consumeMarkAllReadFailure()
    }

    public fun open(item: NotificationItem, onReady: (NotificationOpenRequest) -> Unit, onUnsupported: () -> Unit) {
        repository.markRead(item)
        viewModelScope.launch { repository.persistRead(item) }
        viewModelScope.launch {
            var target = MobileNotificationTargetResolver.resolve(item) ?: return@launch
            if (target == MobileNotificationTarget.Unsupported) {
                onUnsupported()
                return@launch
            }
            var knownChatSession: ChatSession? = null
            if (target is MobileNotificationTarget.ChatSession &&
                MobileNotificationChatSessionTargetResolver.requiresSessionScope(target)
            ) {
                val session = try {
                    chatRepository.getSession(target.id)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    onUnsupported()
                    return@launch
                }
                target = MobileNotificationChatSessionTargetResolver.resolve(target, session)
                    ?: run {
                        onUnsupported()
                        return@launch
                    }
                knownChatSession = session
            }
            if (!MobileNotificationOpenScopePolicy.hasRequiredScope(target)) {
                onUnsupported()
                return@launch
            }
            val organizationId = target.organizationId
            if (!organizationId.isNullOrBlank() && organizationId != organizationRepository.selectedOrganization.value?.id) {
                organizationRepository.loadOrganizations()
                if (runCatching { organizationRepository.error.value }.getOrNull() != null) {
                    onUnsupported()
                    return@launch
                }
                val organization = organizationRepository.organizations.value.firstOrNull { it.id == organizationId }
                if (organization == null) {
                    runCatching { organizationRepository.notifyOrganizationAccessRevoked(organizationId) }
                    return@launch
                }
                organizationRepository.selectOrganization(organization)
                if (organizationRepository.selectedOrganization.value?.id != organizationId) {
                    onUnsupported()
                    return@launch
                }
            }
            if (!targetIsAccessible(item, target, knownChatSession)) {
                onUnsupported()
                return@launch
            }
            onReady(NotificationOpenRequest(item, target))
        }
    }

    public suspend fun approveResourceAccessRequest(requestId: String): Result<Unit> = runCatching {
        imApi.approveResourceAccessRequest(requestId).requireSuccess()
        repository.reload()
        repository.reloadUnreadCount()
    }

    /** 通知是历史记录；目标删除、失权或审批已经处理时不能假装跳转成功。 */
    private suspend fun targetIsAccessible(
        item: NotificationItem,
        target: MobileNotificationTarget,
        knownChatSession: ChatSession? = null,
    ): Boolean {
        return try {
            when (target) {
                is MobileNotificationTarget.ChatSession -> {
                    if (knownChatSession == null) chatRepository.getSession(target.id)
                    if (item.type != "agent.hitl.waiting") {
                        true
                    } else {
                        val interactionId = item.metadata.string("interaction_id", "interactionId")
                        val requestKey = item.metadata.string("request_key", "requestKey")
                        // 老通知没有 interaction 标识时，保留原会话跳转能力；新通知必须
                        // 仍能在事实源中找到对应待办，才能把用户带去操作。
                        if (interactionId == null && requestKey == null) {
                            true
                        } else {
                            pendingInteractionRepository.refreshSession(target.id).any { interaction ->
                                interaction.id == interactionId || interaction.requestKey == requestKey
                            }
                        }
                    }
                }
                is MobileNotificationTarget.Tracker -> {
                    trackerRepository.getEvent(target.id)
                    true
                }
                else -> true
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            false
        }
    }
}

private fun kotlinx.serialization.json.JsonObject.string(vararg keys: String): String? {
    for (key in keys) {
        val value = this[key]?.jsonPrimitive?.contentOrNull?.trim()
        if (!value.isNullOrEmpty()) return value
    }
    return null
}

private fun String?.normalized(): String? = this?.trim()?.takeIf(String::isNotEmpty)

@StringRes
internal fun notificationBellStateDescriptionResource(unreadCount: Int): Int =
    if (unreadCount > 0) R.string.notification_unread_count else R.string.notification_no_unread

@Composable
public fun NotificationBellAction(
    unreadCount: Int,
    onClick: () -> Unit,
) {
    val accessibilityLabel = stringResource(R.string.notification_title)
    val accessibilityStateResource = notificationBellStateDescriptionResource(unreadCount)
    val accessibilityState = if (unreadCount > 0) {
        stringResource(accessibilityStateResource, unreadCount)
    } else {
        stringResource(accessibilityStateResource)
    }
    Box(
        modifier = Modifier.size(48.dp),
        contentAlignment = Alignment.Center,
    ) {
        IconButton(
            onClick = onClick,
            modifier = Modifier
                .fillMaxSize()
                .semantics {
                    contentDescription = accessibilityLabel
                    stateDescription = accessibilityState
                },
        ) {
            // 与 iOS 复用 Electron ActivityRail 信封形状；tint 走主题 accent，不烘焙固定橙。
            Icon(
                painter = painterResource(R.drawable.rail_notification_selected),
                contentDescription = null,
                modifier = Modifier.size(21.dp),
                tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
            )
        }
        if (unreadCount > 0) {
            NotificationUnreadBadge(
                unreadCount = unreadCount,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 2.dp, end = 2.dp),
            )
        }
    }
}

@Composable
private fun NotificationUnreadBadge(
    unreadCount: Int,
    modifier: Modifier = Modifier,
) {
    val label = if (unreadCount > 99) "99+" else unreadCount.toString()
    val badgeWidth = when {
        unreadCount > 99 -> 32.dp
        unreadCount > 9 -> 26.dp
        else -> 20.dp
    }
    val backgroundColor = MaterialTheme.colorScheme.error
    val contentColor = MaterialTheme.colorScheme.onError
    val textPaint = remember(contentColor) {
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = contentColor.toArgb()
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
    }

    Canvas(modifier = modifier.size(width = badgeWidth, height = 20.dp)) {
        drawRoundRect(
            color = backgroundColor,
            cornerRadius = CornerRadius(size.height / 2f, size.height / 2f),
        )
        textPaint.textSize = 10.dp.toPx()
        val baseline = size.height / 2f - (textPaint.ascent() + textPaint.descent()) / 2f
        drawContext.canvas.nativeCanvas.drawText(label, size.width / 2f, baseline, textPaint)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun NotificationCenterScreen(
    viewModel: NotificationCenterViewModel = hiltViewModel(),
    onBack: () -> Unit,
    onNavigate: (NotificationOpenRequest) -> Unit,
) {
    val state by viewModel.state.collectAsState()
    val projectNamesById by viewModel.projectNamesById.collectAsState()
    val workspaceNamesById by viewModel.workspaceNamesById.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val coroutineScope = rememberCoroutineScope()
    val unavailableMessage = stringResource(R.string.notification_open_unavailable)
    val markAllReadFailedMessage = stringResource(R.string.notification_mark_all_read_failed)
    var selectedFilter by rememberSaveable { mutableStateOf(NotificationFilter.ALL) }
    val visibleNotifications = remember(state.notifications, selectedFilter) {
        NotificationPresentationPolicy.filter(state.notifications, selectedFilter)
    }
    var accessRequestTarget by remember { mutableStateOf<MobileNotificationTarget.ResourceAccessRequest?>(null) }
    var isApprovingAccess by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.notification_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
                actions = {
                    if (state.hasUnreadNotifications) {
                        TextButton(
                            onClick = viewModel::markAllRead,
                            enabled = !state.isMarkingAllRead,
                        ) {
                            if (state.isMarkingAllRead) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(TTSpacing.lg),
                                    strokeWidth = 2.dp,
                                )
                            } else {
                                Text(stringResource(R.string.notification_mark_all_read))
                            }
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.notifications.isNotEmpty(),
            onRefresh = viewModel::refresh,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.notifications.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                state.errorMessage != null && state.notifications.isEmpty() -> NotificationErrorState(
                    message = state.errorMessage.orEmpty(),
                    onRetry = viewModel::refresh,
                )
                state.notifications.isEmpty() -> NotificationEmptyState()
                else -> Column(modifier = Modifier.fillMaxSize()) {
                    NotificationFilterBar(
                        notifications = state.notifications,
                        selectedFilter = selectedFilter,
                        onSelect = { selectedFilter = it },
                    )
                    if (visibleNotifications.isEmpty()) {
                        NotificationFilteredEmptyState(modifier = Modifier.weight(1f))
                    } else {
                        LazyColumn(modifier = Modifier.weight(1f)) {
                            items(visibleNotifications, key = NotificationItem::id) { item ->
                                NotificationRow(
                                    item = item,
                                    projectNamesById = projectNamesById,
                                    workspaceNamesById = workspaceNamesById,
                                    onClick = {
                                        viewModel.open(
                                            item = item,
                                            onReady = { request ->
                                                val target = request.target
                                                if (target is MobileNotificationTarget.ResourceAccessRequest) {
                                                    accessRequestTarget = target
                                                } else {
                                                    onNavigate(request)
                                                }
                                            },
                                            onUnsupported = {
                                                coroutineScope.launch {
                                                    snackbarHostState.showSnackbar(
                                                        message = unavailableMessage,
                                                    )
                                                }
                                            },
                                        )
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    LaunchedEffect(state.markAllReadFailed) {
        if (state.markAllReadFailed) {
            snackbarHostState.showSnackbar(markAllReadFailedMessage)
            viewModel.consumeMarkAllReadFailure()
        }
    }

    LaunchedEffect(state.notifications, accessRequestTarget?.requestId) {
        val requestId = accessRequestTarget?.requestId ?: return@LaunchedEffect
        if (!NotificationPresentationPolicy.hasPendingResourceAccessRequest(
                state.notifications,
                requestId,
            )
        ) {
            accessRequestTarget = null
            isApprovingAccess = false
        }
    }

    accessRequestTarget?.let { target ->
        ResourceAccessRequestDialog(
            target = target,
            isApproving = isApprovingAccess,
            onDismiss = {
                if (!isApprovingAccess) accessRequestTarget = null
            },
            onApprove = {
                if (isApprovingAccess) return@ResourceAccessRequestDialog
                coroutineScope.launch {
                    isApprovingAccess = true
                    viewModel.approveResourceAccessRequest(target.requestId)
                        .onSuccess {
                            accessRequestTarget = null
                            snackbarHostState.showSnackbar("已授予查看权限")
                        }
                        .onFailure {
                            snackbarHostState.showSnackbar(it.message ?: "批准失败，请稍后重试")
                        }
                    isApprovingAccess = false
                }
            },
        )
    }
}

@Composable
private fun ResourceAccessRequestDialog(
    target: MobileNotificationTarget.ResourceAccessRequest,
    isApproving: Boolean,
    onDismiss: () -> Unit,
    onApprove: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(target.title.ifBlank { "确认授予查看权限？" })
        },
        text = {
            Text(
                target.body.ifBlank {
                    "确认后对方将获得该资源的查看（viewer）权限。取消仅关闭弹窗，申请仍保持待处理。"
                },
            )
        },
        confirmButton = {
            TextButton(onClick = onApprove, enabled = !isApproving) {
                Text(if (isApproving) "授权中…" else "确认授权")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isApproving) {
                Text("取消")
            }
        },
    )
}

@Composable
private fun NotificationFilterBar(
    notifications: List<NotificationItem>,
    selectedFilter: NotificationFilter,
    onSelect: (NotificationFilter) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        LazyRow(
            modifier = Modifier.selectableGroup(),
            contentPadding = PaddingValues(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            items(NotificationFilter.entries, key = NotificationFilter::name) { filter ->
                val selected = filter == selectedFilter
                val background = if (selected) {
                    ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
                } else {
                    ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
                }
                val foreground = if (selected) {
                    ttColor(TTColors.Background, TTColors.Dark.Background)
                } else {
                    ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
                }
                val border = if (selected) {
                    Color.Transparent
                } else {
                    ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
                }
                Row(
                    modifier = Modifier
                        .heightIn(min = 44.dp)
                        .clip(TTRadius.Shapes.sm)
                        .background(background)
                        .border(0.5.dp, border, TTRadius.Shapes.sm)
                        .selectable(
                            selected = selected,
                            onClick = { onSelect(filter) },
                            role = Role.Tab,
                        )
                        .padding(horizontal = TTSpacing.md),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = notificationFilterLabel(filter),
                        style = TTFonts.bodyMedium,
                        color = foreground,
                    )
                    Text(
                        text = NotificationPresentationPolicy.filter(notifications, filter).size.toString(),
                        style = TTFonts.captionMedium,
                        color = foreground.copy(alpha = 0.8f),
                    )
                }
            }
        }
        HorizontalDivider(
            thickness = 0.5.dp,
            color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight),
        )
    }
}

@Composable
private fun NotificationRow(
    item: NotificationItem,
    projectNamesById: Map<String, String>,
    workspaceNamesById: Map<String, String>,
    onClick: () -> Unit,
) {
    val source = NotificationPresentationPolicy.source(item)
    val contextName = NotificationPresentationPolicy.context(
        item = item,
        projectNamesById = projectNamesById,
        workspaceNamesById = workspaceNamesById,
    )?.name
    val displayTitle = NotificationPresentationPolicy.displayTitle(item)
    val displayBody = NotificationPresentationPolicy.displayBody(item)
    val readStateDescription = stringResource(
        if (item.isRead) R.string.notification_state_read else R.string.notification_state_unread,
    )
    val androidContext = LocalContext.current
    val relativeTime = RelativeTimeFormatter.format(androidContext, item.createdAt)
        ?: item.createdAt.take(16).replace('T', ' ')
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) { stateDescription = readStateDescription }
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.Top,
    ) {
        val iconColor = notificationColor(item.priority)
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(iconColor.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = notificationIcon(source),
                contentDescription = null,
                tint = iconColor,
                modifier = Modifier.size(TTFonts.iconSubtitle.fontSize.value.dp),
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = notificationSourceLabel(source),
                    style = TTFonts.captionMedium,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    modifier = Modifier
                        .clip(TTRadius.Shapes.xs)
                        .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                        .padding(horizontal = TTSpacing.xs, vertical = TTSpacing.xxs),
                )
                if (contextName != null) {
                    Text(
                        text = "·",
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                    Text(
                        text = contextName,
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else {
                    Spacer(Modifier.weight(1f))
                }
                Text(
                    text = relativeTime,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
            Spacer(Modifier.height(TTSpacing.xs))
            Text(
                text = displayTitle.ifBlank { stringResource(R.string.notification_unknown) },
                style = if (item.isRead) TTFonts.body else TTFonts.bodySemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (displayBody.isNotBlank()) {
                Text(
                    text = displayBody,
                    style = TTFonts.meta,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (!item.isRead) {
            Box(
                modifier = Modifier
                    .padding(top = 5.dp)
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary),
            )
        }
    }
}

@Composable
private fun NotificationEmptyState(
    modifier: Modifier = Modifier,
    titleRes: Int = R.string.notification_empty,
    descriptionRes: Int = R.string.notification_empty_description,
) {
    Column(
        modifier = modifier.fillMaxSize().padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Default.NotificationsNone,
            contentDescription = null,
            modifier = Modifier.size(TTFonts.iconEmptyLG.fontSize.value.dp),
        )
        Spacer(Modifier.height(TTSpacing.md))
        Text(stringResource(titleRes), style = TTFonts.subtitleSemibold)
        Text(
            stringResource(descriptionRes),
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun NotificationFilteredEmptyState(modifier: Modifier = Modifier) {
    NotificationEmptyState(
        modifier = modifier,
        titleRes = R.string.notification_filtered_empty,
        descriptionRes = R.string.notification_filtered_empty_description,
    )
}

@Composable
private fun NotificationErrorState(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Default.Error,
            contentDescription = null,
            modifier = Modifier.size(TTFonts.iconEmptyLG.fontSize.value.dp),
        )
        Spacer(Modifier.height(TTSpacing.md))
        Text(
            message,
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            textAlign = TextAlign.Center,
        )
        TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
    }
}

private fun notificationIcon(source: NotificationSource): ImageVector = when (source) {
    NotificationSource.AGENT -> Icons.Default.AutoAwesome
    NotificationSource.TRACKER -> Icons.Default.Schedule
    NotificationSource.CHAT -> Icons.Default.Forum
    NotificationSource.DOC -> Icons.Default.Description
    NotificationSource.DATA -> Icons.Default.TableChart
    NotificationSource.MAIL -> Icons.Default.Mail
    NotificationSource.INBOX -> Icons.Default.Inbox
    NotificationSource.SHARED_RESOURCE -> Icons.Default.Share
    NotificationSource.ORGANIZATION -> Icons.Default.Group
    NotificationSource.EXTENSION -> Icons.Default.Extension
    NotificationSource.SYSTEM -> Icons.Default.Notifications
}

@Composable
private fun notificationColor(priority: String?): Color = when (priority) {
    "urgent" -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
    "high" -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
    else -> ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)
}

@Composable
private fun notificationFilterLabel(filter: NotificationFilter): String = stringResource(when (filter) {
    NotificationFilter.ALL -> R.string.notification_filter_all
    NotificationFilter.PENDING -> R.string.notification_filter_pending
    NotificationFilter.AGENT -> R.string.notification_filter_task
    NotificationFilter.COLLABORATION -> R.string.notification_filter_collaboration
    NotificationFilter.ORGANIZATION -> R.string.notification_filter_organization
    NotificationFilter.SYSTEM -> R.string.notification_filter_system
})

@Composable
private fun notificationSourceLabel(source: NotificationSource): String = stringResource(when (source) {
    NotificationSource.AGENT -> R.string.notification_source_tab_agent
    NotificationSource.TRACKER -> R.string.notification_source_tab_tracker
    NotificationSource.CHAT -> R.string.notification_source_tab_chat
    NotificationSource.DOC -> R.string.notification_source_tab_doc
    NotificationSource.DATA -> R.string.notification_source_tab_data
    NotificationSource.MAIL -> R.string.notification_source_tab_mail
    NotificationSource.INBOX -> R.string.notification_source_tab_inbox
    NotificationSource.SHARED_RESOURCE -> R.string.notification_source_shared_resource
    NotificationSource.ORGANIZATION -> R.string.notification_source_organization
    NotificationSource.EXTENSION -> R.string.notification_source_extension
    NotificationSource.SYSTEM -> R.string.notification_source_system
})

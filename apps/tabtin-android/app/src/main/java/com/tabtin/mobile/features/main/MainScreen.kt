package com.tabtin.mobile.features.main

import androidx.activity.compose.BackHandler
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Project
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.clouddocs.CloudDocsPendingOpen
import com.tabtin.mobile.features.clouddocs.CloudDocsCreateTopBarAction
import com.tabtin.mobile.features.clouddocs.CloudDocsTabScreen
import com.tabtin.mobile.features.clouddocs.CloudDocsViewModel
import com.tabtin.mobile.features.conversation.NewTaskWorkspacePolicy
import com.tabtin.mobile.features.conversation.TaskHomeScreen
import com.tabtin.mobile.features.notification.NotificationBellAction
import com.tabtin.mobile.features.notification.NotificationCenterViewModel
import com.tabtin.mobile.features.skills.MobileSkillMarketTab
import com.tabtin.mobile.features.space.AgentListViewModel
import com.tabtin.mobile.features.space.MyAgentsScreen
import com.tabtin.mobile.features.space.MyAgentsViewModel
import com.tabtin.mobile.features.space.ProjectDetailScreen
import com.tabtin.mobile.features.space.ProjectListScreen
import com.tabtin.mobile.features.space.ProjectViewModel
import com.tabtin.mobile.features.tabchat.ContactsViewModel
import com.tabtin.mobile.features.tabchat.CreateGroupDialog
import com.tabtin.mobile.features.tabchat.RecentMessagesSection
import com.tabtin.mobile.features.tabchat.ImInboxViewModel
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.launch

private data class MainTabItem(
    @StringRes val titleRes: Int,
    @DrawableRes val normalIconRes: Int,
    @DrawableRes val selectedIconRes: Int,
)

private val mainTabs = listOf(
    MainTabItem(R.string.common_tab_task, R.drawable.rail_home_normal, R.drawable.rail_home_selected),
    MainTabItem(R.string.common_tab_cloud_docs, R.drawable.rail_cloud_docs_normal, R.drawable.rail_cloud_docs_selected),
    MainTabItem(R.string.common_tab_agents, R.drawable.rail_agent_normal, R.drawable.rail_agent_selected),
    MainTabItem(R.string.common_tab_messages, R.drawable.rail_chat_normal, R.drawable.rail_chat_selected),
)

private const val TAB_TASK = 0
private const val TAB_APPS = 1
private const val TAB_AGENTS = 2
private const val TAB_MESSAGES = 3
private const val TAB_PROJECTS = 4

public enum class MainTabDestination { TASK, MESSAGES, AGENTS, CLOUD, PROJECTS, SETTINGS, RECENT, AGENT }

/**
 * 与 iOS 一致的四个一级工作域：任务 / 云文档 / AI分身 / 消息。
 *
 * 项目功能暂时保留实现但不进入底部主导航；旧入口或程序化请求 projects 时降级到消息，
 * 避免用户冷启或通知跳转落到一个已下线的一级 Tab。
 * 次级动作（自动化 / 技能·连接器 / 通讯录·建群）放在顶栏下侧条；一级顶栏右统一保留通知。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MainScreen(
    onLogout: () -> Unit,
    onOpenAccountDrawer: () -> Unit,
    onNavigateToCapabilities: () -> Unit,
    onNavigateToAbout: () -> Unit,
    onNavigateToSettings: () -> Unit,
    onNavigateToNotifications: () -> Unit,
    onNavigateToOrganizationSettings: (String) -> Unit,
    onNavigateToSpaceSettings: (String) -> Unit,
    onNavigateToAgentDetail: (String) -> Unit,
    requestedTab: MainTabDestination? = null,
    onRequestedTabConsumed: () -> Unit = {},
    onNavigateToCloudResource: (String, SpaceResource, String?) -> Unit,
    onNavigateToCloudResourceFromEvent: (String, SpaceResource, String?) -> Unit =
        onNavigateToCloudResource,
    onNavigateToChatSession: (
        sessionId: String,
        spaceId: String,
        spaceName: String,
        organizationId: String,
    ) -> Unit,
    /** 任务首页「新任务」直进草稿会话（空 sessionId + startsNewSession）。 */
    onNavigateToDraftSession: (space: Space, agentId: String?) -> Unit,
    onNavigateToImConversation: (conversationId: String, title: String) -> Unit,
    onNavigateToContacts: (organizationId: String) -> Unit,
    onNavigateToMobileSkills: (MobileSkillMarketTab) -> Unit,
    onNavigateToMobileAutomation: () -> Unit,
    onNavigateToArchivedConversations: () -> Unit,
    onNavigateToTracker: (trackerId: String) -> Unit,
    requestedRecentSection: Int? = null,
    onRequestedRecentSectionConsumed: () -> Unit = {},
    pendingCloudDocsOpen: CloudDocsPendingOpen? = null,
    onPendingCloudDocsOpenConsumed: () -> Unit = {},
) {
    var selectedTab by rememberSaveable { mutableIntStateOf(TAB_TASK) }
    var messageSearchQuery by rememberSaveable { mutableStateOf("") }
    var projectSearchQuery by rememberSaveable { mutableStateOf("") }
    // Tab 内容会被 Compose 保留；用激活编号表达「用户又点了一次消息」，触发权威 IM reload。
    var messagesTabActivationId by rememberSaveable { mutableIntStateOf(0) }
    var showCreateGroup by rememberSaveable { mutableStateOf(false) }
    var showCreateAgent by rememberSaveable { mutableStateOf(false) }
    val contactsVm: ContactsViewModel = hiltViewModel()
    var projectTaskToCompose by remember { mutableStateOf<Project?>(null) }
    val mainScope = rememberCoroutineScope()

    val agentVm: AgentListViewModel = hiltViewModel()
    val myAgentsVm: MyAgentsViewModel = hiltViewModel()
    val projectVm: ProjectViewModel = hiltViewModel()
    val notificationVm: NotificationCenterViewModel = hiltViewModel()
    val imInboxVm: ImInboxViewModel = hiltViewModel()
    val cloudDocsVm: CloudDocsViewModel = hiltViewModel()
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val notificationState by notificationVm.state.collectAsState()
    val messagesUnreadCount by imInboxVm.aggregateUnreadCount.collectAsState()
    val imConversations by imInboxVm.conversations.collectAsState()
    val imPersonalNotice by imInboxVm.personalNotice.collectAsState()
    val myAgentsState by myAgentsVm.uiState.collectAsState()
    val agentState by agentVm.uiState.collectAsState()
    val selectedOrganization by agentVm.selectedOrganization.collectAsState()
    val projectState by projectVm.uiState.collectAsState()
    val brandColor = MaterialTheme.colorScheme.primary
    val unselectedColor = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val taskToolbarColor = ttColor(TTColors.BgSidebar, TTColors.Dark.BgSidebar)
    val taskSnackbarHostState = remember { SnackbarHostState() }
    val noExecutionWorkspaceMessage = stringResource(R.string.task_home_no_execution_workspace)
    val imNoticeAgentName = imPersonalNotice?.agentName?.takeIf { it.isNotBlank() } ?: "AI"
    val imPersonalNoticeMessage = when (imPersonalNotice?.kind) {
        ImConversationStore.PersonalNoticeKind.AI_ERROR -> {
            val reason = imPersonalNotice?.reason.orEmpty()
            if (reason.isBlank()) {
                stringResource(R.string.im_ai_reply_failed, imNoticeAgentName)
            } else {
                stringResource(R.string.im_ai_reply_failed_with_reason, imNoticeAgentName, reason)
            }
        }
        ImConversationStore.PersonalNoticeKind.AI_SUGGEST_TASK ->
            stringResource(R.string.im_ai_suggest_task, imNoticeAgentName)
        null -> null
    }
    val composeWorkspaces = remember(agentState.spaces) {
        agentState.spaces.filter { it.isExecutionSpace }
    }
    val dismissTabSearchFocus: () -> Unit = {
        focusManager.clearFocus()
        keyboardController?.hide()
    }

    fun openNewTaskDraft(workspace: Space? = null) {
        NewTaskWorkspacePolicy.dispatchLaunch(
            requestedWorkspace = workspace,
            workspaces = composeWorkspaces,
            onResolved = { onNavigateToDraftSession(it, null) },
            onUnavailable = {
                mainScope.launch {
                    taskSnackbarHostState.currentSnackbarData?.dismiss()
                    taskSnackbarHostState.showSnackbar(noExecutionWorkspaceMessage)
                }
            },
        )
    }

    val activeTab = selectedTab.takeIf { it in mainTabs.indices } ?: TAB_MESSAGES
    val isProjectDetailLevel = activeTab == TAB_PROJECTS && projectState.selectedProject != null
    val hasOrganization = !agentVm.organizationId.isNullOrBlank()

    // Project 从主五栏 push 进入，系统返回先收起子页面。
    BackHandler(enabled = isProjectDetailLevel) {
        projectVm.closeProject()
    }

    androidx.compose.runtime.LaunchedEffect(selectedTab) {
        if (selectedTab !in mainTabs.indices) {
            selectedTab = TAB_MESSAGES
            projectVm.closeProject()
        }
    }

    androidx.compose.runtime.LaunchedEffect(requestedTab) {
        when (requestedTab) {
            MainTabDestination.TASK, MainTabDestination.RECENT -> selectedTab = TAB_TASK
            MainTabDestination.MESSAGES -> {
                selectedTab = TAB_MESSAGES
                messagesTabActivationId += 1
            }
            MainTabDestination.AGENTS, MainTabDestination.AGENT -> selectedTab = TAB_AGENTS
            MainTabDestination.CLOUD -> selectedTab = TAB_APPS
            MainTabDestination.PROJECTS -> {
                selectedTab = TAB_MESSAGES
                messagesTabActivationId += 1
            }
            MainTabDestination.SETTINGS -> {
                onNavigateToSettings()
                onRequestedTabConsumed()
                return@LaunchedEffect
            }
            null -> return@LaunchedEffect
        }
        projectVm.closeProject()
        onRequestedTabConsumed()
    }

    // 通知中心点开 IM 会话前，先切到「消息」Tab（对齐 iOS）。
    androidx.compose.runtime.LaunchedEffect(requestedRecentSection) {
        val section = requestedRecentSection ?: return@LaunchedEffect
        selectedTab = if (section == 1) TAB_MESSAGES else TAB_TASK
        if (section == 1) messagesTabActivationId += 1
        onRequestedRecentSectionConsumed()
    }

    // 「消息」入口角标必须在用户尚未切到消息段时也可见，因此主页面随 organization 激活 IM 列表。
    androidx.compose.runtime.LaunchedEffect(agentVm.organizationId) {
        imInboxVm.activate(agentVm.organizationId ?: "")
        contactsVm.activate(agentVm.organizationId ?: "")
    }

    androidx.compose.runtime.LaunchedEffect(imPersonalNotice?.id) {
        val notice = imPersonalNotice ?: return@LaunchedEffect
        val message = imPersonalNoticeMessage ?: return@LaunchedEffect
        taskSnackbarHostState.currentSnackbarData?.dismiss()
        val canOpenConversation = notice.kind == ImConversationStore.PersonalNoticeKind.AI_SUGGEST_TASK &&
            !notice.conversationId.isNullOrBlank()
        val result = taskSnackbarHostState.showSnackbar(
            message = message,
            actionLabel = if (canOpenConversation) "查看" else null,
        )
        if (canOpenConversation && result == SnackbarResult.ActionPerformed) {
            val conversationId = requireNotNull(notice.conversationId)
            val title = imConversations.firstOrNull { it.id == conversationId }
                ?.name
                ?.takeIf { it.isNotBlank() }
                ?: "消息"
            onNavigateToImConversation(conversationId, title)
        }
        imInboxVm.dismissPersonalNotice()
    }

    val secondaryBarItems = when (activeTab) {
        TAB_TASK -> listOf(
            PrimaryTabSecondaryBarItem(
                id = "automation",
                titleRes = R.string.task_home_section_automation,
                iconRes = R.drawable.lucide_activity,
                onClick = onNavigateToMobileAutomation,
            ),
            PrimaryTabSecondaryBarItem(
                id = "archived",
                titleRes = R.string.task_home_archived,
                iconRes = R.drawable.lucide_archive,
                onClick = onNavigateToArchivedConversations,
            ),
        )
        TAB_AGENTS -> listOf(
            PrimaryTabSecondaryBarItem(
                id = "skills",
                titleRes = R.string.mobile_skill_library_tab_skills,
                iconRes = R.drawable.lucide_blocks,
                onClick = { onNavigateToMobileSkills(MobileSkillMarketTab.SKILLS) },
            ),
            PrimaryTabSecondaryBarItem(
                id = "connectors",
                titleRes = R.string.mobile_skill_library_tab_connectors,
                iconRes = R.drawable.lucide_plug,
                onClick = { onNavigateToMobileSkills(MobileSkillMarketTab.CONNECTORS) },
            ),
        )
        TAB_MESSAGES -> listOf(
            PrimaryTabSecondaryBarItem(
                id = "contacts",
                titleRes = R.string.im_contacts,
                iconRes = R.drawable.lucide_contact,
                onClick = { onNavigateToContacts(agentVm.organizationId.orEmpty()) },
            ),
            PrimaryTabSecondaryBarItem(
                id = "createGroup",
                titleRes = R.string.im_messages_new_group,
                iconRes = R.drawable.lucide_users_round,
                enabled = hasOrganization,
                onClick = { showCreateGroup = true },
            ),
        )
        else -> emptyList()
    }

    Scaffold(
        containerColor = if (activeTab == TAB_TASK) {
            taskToolbarColor
        } else {
            ttColor(TTColors.Background, TTColors.Dark.Background)
        },
        snackbarHost = { SnackbarHost(taskSnackbarHostState) },
        topBar = {
            // Project 二级页面自带顶栏，这里不再叠一层。
            if (!isProjectDetailLevel) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    TopAppBar(
                        title = {
                            if (activeTab == TAB_TASK) {
                                Column {
                                    Text(stringResource(mainTabs[activeTab].titleRes))
                                    selectedOrganization?.name
                                        ?.trim()
                                        ?.takeIf { it.isNotEmpty() }
                                        ?.let { organizationName ->
                                            Text(
                                                text = organizationName,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = unselectedColor,
                                                maxLines = 1,
                                            )
                                        }
                                }
                            } else {
                                Text(stringResource(mainTabs[activeTab].titleRes))
                            }
                        },
                        navigationIcon = {
                            AccountDrawerToolbarItem(onClick = onOpenAccountDrawer)
                        },
                        actions = {
                            if (activeTab == TAB_AGENTS) {
                                IconButton(onClick = { showCreateAgent = true }) {
                                    Icon(
                                        imageVector = Icons.Default.Add,
                                        contentDescription = stringResource(R.string.my_agents_create),
                                        tint = brandColor,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            }
                            if (activeTab == TAB_APPS) {
                                CloudDocsCreateTopBarAction(
                                    organizationId = agentVm.organizationId.orEmpty(),
                                    viewModel = cloudDocsVm,
                                    tint = brandColor,
                                )
                            }
                            NotificationBellAction(
                                unreadCount = notificationState.unreadCount,
                                onClick = onNavigateToNotifications,
                            )
                        },
                        colors = if (activeTab == TAB_TASK) {
                            androidx.compose.material3.TopAppBarDefaults.topAppBarColors(
                                containerColor = taskToolbarColor,
                                scrolledContainerColor = taskToolbarColor,
                            )
                        } else {
                            androidx.compose.material3.TopAppBarDefaults.topAppBarColors()
                        },
                    )
                    PrimaryTabSecondaryBar(
                        items = secondaryBarItems,
                        background = if (activeTab == TAB_TASK) {
                            taskToolbarColor
                        } else {
                            ttColor(TTColors.Background, TTColors.Dark.Background)
                        },
                    )
                }
            }
        },
        bottomBar = {
            // 对齐 iOS push：Project 二级页面进入后，主导航自然隐藏。
            if (!isProjectDetailLevel) NavigationBar(
                containerColor = ttColor(TTColors.Surface, TTColors.Dark.Surface),
            ) {
                mainTabs.forEachIndexed { index, tab ->
                    val title = stringResource(tab.titleRes)
                    val isSelected = activeTab == index
                    val iconRes = if (isSelected) tab.selectedIconRes else tab.normalIconRes
                    NavigationBarItem(
                        icon = {
                            // 角标指向哪个 Tab，点进去就该看到对应的事：
                            // 未读只算消息，待处理邀请只算项目，不再混成一个总数。
                            val badgeCount = when (index) {
                                TAB_MESSAGES -> messagesUnreadCount
                                TAB_PROJECTS -> projectState.pendingInvitations.size
                                else -> 0
                            }
                            if (badgeCount > 0) {
                                BadgedBox(
                                    badge = {
                                        Badge {
                                            Text(if (badgeCount > 99) "99+" else badgeCount.toString())
                                        }
                                    },
                                ) {
                                    ActivityRailTabIcon(
                                        iconRes = iconRes,
                                        contentDescription = title,
                                        tint = if (isSelected) brandColor else unselectedColor,
                                    )
                                }
                            } else {
                                ActivityRailTabIcon(
                                    iconRes = iconRes,
                                    contentDescription = title,
                                    tint = if (isSelected) brandColor else unselectedColor,
                                )
                            }
                        },
                        label = { Text(title) },
                        selected = isSelected,
                        onClick = {
                            selectedTab = index
                            // 再点一次消息也算重新进入，列表与未读随之刷新。
                            if (index == TAB_MESSAGES) messagesTabActivationId += 1
                            projectVm.closeProject()
                        },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = brandColor,
                            selectedTextColor = brandColor,
                            indicatorColor = Color.Transparent,
                            unselectedIconColor = unselectedColor,
                            unselectedTextColor = unselectedColor,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding),
        ) {
            when (activeTab) {
                TAB_TASK -> TaskHomeScreen(
                    onSessionClick = { sid, spId, spName, wsId ->
                        onNavigateToChatSession(sid, spId, spName, wsId)
                    },
                    spaces = agentState.spaces,
                    executionWorkspaces = composeWorkspaces,
                    devicesById = agentState.devicesById,
                    onRefreshSpaces = agentVm::refresh,
                    onNewTaskClick = { openNewTaskDraft() },
                    onNewTaskInWorkspace = { openNewTaskDraft(it) },
                    agents = myAgentsState.agents,
                )
                TAB_APPS -> CloudDocsTabScreen(
                    organizationId = agentVm.organizationId ?: "",
                    pendingOpen = pendingCloudDocsOpen,
                    onPendingOpenConsumed = onPendingCloudDocsOpenConsumed,
                    onNavigateToResource = { resource, spaceName ->
                        onNavigateToCloudResource(
                            resource.organizationId?.takeIf { it.isNotBlank() }
                                ?: agentVm.organizationId.orEmpty(),
                            resource,
                            spaceName,
                        )
                    },
                    onNavigateFromEvent = { resource, spaceName ->
                        onNavigateToCloudResourceFromEvent(
                            resource.organizationId?.takeIf { it.isNotBlank() }
                                ?: agentVm.organizationId.orEmpty(),
                            resource,
                            spaceName,
                        )
                    },
                    viewModel = cloudDocsVm,
                )
                TAB_AGENTS -> MyAgentsScreen(
                    viewModel = myAgentsVm,
                    showCreate = showCreateAgent,
                    onCreateRequested = { showCreateAgent = true },
                    onDismissCreate = { showCreateAgent = false },
                    onOpenDetail = onNavigateToAgentDetail,
                )
                TAB_MESSAGES -> Column(modifier = Modifier.fillMaxSize()) {
                    TabSearchField(
                        query = messageSearchQuery,
                        placeholder = stringResource(R.string.im_messages_search),
                        onQueryChange = { messageSearchQuery = it },
                        modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
                    )
                    RecentMessagesSection(
                        organizationId = agentVm.organizationId ?: "",
                        activationId = messagesTabActivationId,
                        searchQuery = messageSearchQuery,
                        onDismissSearch = dismissTabSearchFocus,
                        onOpenConversation = { conversationId, title ->
                            dismissTabSearchFocus()
                            onNavigateToImConversation(conversationId, title)
                        },
                        viewModel = imInboxVm,
                        contactsViewModel = contactsVm,
                    )
                }
                TAB_PROJECTS -> {
                    val project = projectState.selectedProject
                    if (project != null) {
                        ProjectDetailScreen(
                            state = projectState,
                            onBack = projectVm::closeProject,
                            onRetry = { projectVm.loadDetail(project) },
                            onStartTask = {
                                myAgentsVm.load()
                                projectTaskToCompose = it
                            },
                            onSetPrimaryAgent = projectVm::setPrimaryAgent,
                            currentUserId = projectVm.currentUserId,
                            onOpenMemberDirectMessage = { userId, displayName ->
                                mainScope.launch {
                                    projectVm.createDirectMessage(userId, displayName)
                                        .onSuccess { target ->
                                            onNavigateToImConversation(target.conversationId, target.title)
                                        }
                                }
                            },
                            onAgentMemberTap = { },
                        )
                    } else {
                        Column(modifier = Modifier.fillMaxSize()) {
                            TabSearchField(
                                query = projectSearchQuery,
                                placeholder = stringResource(R.string.project_search),
                                onQueryChange = { projectSearchQuery = it },
                                modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
                            )
                            ProjectListScreen(
                                state = projectState,
                                searchQuery = projectSearchQuery,
                                onDismissSearch = dismissTabSearchFocus,
                                onRefresh = projectVm::refresh,
                                onRetry = projectVm::load,
                                onOpenProject = { project ->
                                    dismissTabSearchFocus()
                                    projectVm.openProject(project)
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    if (showCreateGroup) {
        CreateGroupDialog(
            viewModel = contactsVm,
            onDismiss = { showCreateGroup = false },
            onCreated = { target ->
                showCreateGroup = false
                onNavigateToImConversation(target.conversationId, target.title)
            },
        )
    }

    projectTaskToCompose?.let { project ->
        val agentOptions = myAgentsState.agents.map {
                ProjectTaskAgentOption(
                    id = it.id,
                    name = it.name,
                    responsibility = it.goal,
                )
            }
        val defaultAgentId = sequenceOf(
            project.primaryAgentId,
            project.myWorkspace?.executionAgentId,
            project.myWorkspace?.agentId,
        ).firstOrNull { candidateId -> agentOptions.any { it.id == candidateId } }
        ProjectTaskComposerSheet(
            project = project,
            agentOptions = agentOptions,
            defaultAgentId = defaultAgentId,
            isLoadingAgents = myAgentsState.isLoading,
            onDismiss = { projectTaskToCompose = null },
            onChatPrepared = { session, space ->
                projectTaskToCompose = null
                onNavigateToChatSession(
                    session.id,
                    space.id,
                    space.name,
                    space.organizationId,
                )
            },
        )
    }
}

/** Electron / iOS 共用的 ActivityRail 图标；资源按亮暗主题自动切换。 */
@Composable
private fun ActivityRailTabIcon(
    @DrawableRes iconRes: Int,
    contentDescription: String,
    tint: Color,
) {
    Icon(
        painter = painterResource(iconRes),
        contentDescription = contentDescription,
        modifier = Modifier.size(22.dp),
        tint = tint,
    )
}

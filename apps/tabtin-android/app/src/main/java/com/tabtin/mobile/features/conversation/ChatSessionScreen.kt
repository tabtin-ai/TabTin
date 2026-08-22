package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.AddComment
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.outlined.SpaceDashboard
import androidx.compose.material.icons.outlined.VerticalSplit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.websocket.WSConnectionState
import com.tabtin.mobile.features.profile.AIDataSharingConsentDialog
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.features.workbench.TaskWorkbenchApp
import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchNavigationPane
import com.tabtin.mobile.features.workbench.WorkbenchPresentation
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import com.tabtin.mobile.features.workbench.WorkbenchSurface
import com.tabtin.mobile.features.workbench.WorkbenchUiState
import com.tabtin.mobile.features.space.MyAgentsViewModel
import com.tabtin.mobile.features.workbench.WorkbenchViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

/** 顶部「对话」的真实 compact intent：退出 overlay，切到无 layer chrome 的完整对话面。 */
internal fun selectCompactConversationSurface(
    currentPresentation: CompactConversationPresentation,
    layerState: ConversationLayerState,
    layerScope: CoroutineScope,
    onPresentationChanged: (CompactConversationPresentation) -> Unit,
    onTaskSurfaceModeChanged: (TaskSurfaceMode) -> Unit,
) {
    val target = TaskSurfaceCoordinator.conversationPickerTargetCompact(currentPresentation)
        ?: return
    onPresentationChanged(target)
    layerScope.launch { layerState.animateTo(ConversationLayerDetent.COLLAPSED) }
    onTaskSurfaceModeChanged(TaskSurfaceMode.CHAT_FOCUS)
}

/** 胶囊 / 抓手只改变工作台 overlay；即使扩展到最高档也保持工作台 presentation。 */
internal fun showCompactConversationOverlay(
    target: ConversationLayerDetent,
    layerState: ConversationLayerState,
    layerScope: CoroutineScope,
    onPresentationChanged: (CompactConversationPresentation) -> Unit,
    onTaskSurfaceModeChanged: (TaskSurfaceMode) -> Unit,
) {
    onPresentationChanged(CompactConversationPresentation.WORKBENCH_OVERLAY)
    layerScope.launch { layerState.animateTo(target) }
    onTaskSurfaceModeChanged(TaskSurfaceMode.APP_FOCUS)
}

/**
 * 任务工作面宿主：持有 viewMode、voice request、current Focus 与统一 Snackbar。
 * 不使用会关闭工作台的 activeConversationSink。
 *
 * drawer-first 模式下 session 切换走 sidebar；顶栏独立提供新对话，More 菜单提供会话信息 / 共享 / 归档。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ChatSessionScreen(
    messageId: String = "",
    initialMessage: String = "",
    onBack: () -> Unit,
    onNavigateToWallet: (() -> Unit)?,
    onNavigateToTabSite: (siteId: String, siteName: String, siteUrl: String, siteStatus: String) -> Unit,
    onNavigateToMemo: (memoId: String) -> Unit,
    onForkPush: (sessionId: String, spaceId: String, spaceName: String, organizationId: String) -> Unit,
    /** 顶栏「新对话」：push 空 sessionId + startsNewSession 的草稿 route。 */
    onNewDraftSession: (
        spaceId: String,
        spaceName: String,
        organizationId: String,
        agentId: String?,
    ) -> Unit,
    onRelogin: (() -> Unit)?,
    myAgentsViewModel: MyAgentsViewModel,
    viewModel: ChatSessionViewModel = hiltViewModel(),
    workbenchViewModel: WorkbenchViewModel = hiltViewModel(),
    conversationViewModel: ConversationViewModel = hiltViewModel(),
    taskVoiceViewModel: TaskVoiceViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val wbState by workbenchViewModel.uiState.collectAsState()
    val conversationState by conversationViewModel.uiState.collectAsState()
    val myAgentsState by myAgentsViewModel.uiState.collectAsState()
    val wsState by conversationViewModel.connectionState.collectAsState()
    val wsConnected = wsState is WSConnectionState.Connected
    val voiceState by taskVoiceViewModel.uiState.collectAsState()

    var showWorkbench by remember { mutableStateOf(false) }
    var preferAppFocus by remember { mutableStateOf(false) }
    /** 窄屏 TASK_PANE：曾打开过则 keep-alive，对齐 iOS hasPresentedWorkbench */
    var compactWorkbenchEverOpened by remember { mutableStateOf(false) }
    /** 任务 pane 进入资源/App 详情时隐藏「对话 | 工作台」切换 */
    var hideCompactSurfaceSwitcher by remember { mutableStateOf(false) }
    var pendingWorkbenchOpenRequest by remember { mutableStateOf<WorkbenchResourceOpenRequest?>(null) }
    var pendingDelegations by remember { mutableStateOf<List<ResourceReference>>(emptyList()) }
    var currentFocus by remember {
        mutableStateOf(WorkbenchFocusTarget.fromPane(WorkbenchNavigationPane.Overview))
    }
    val layerState = rememberConversationLayerState()
    val layerScope = rememberCoroutineScope()
    var compactConversationPresentation by remember {
        mutableStateOf(CompactConversationPresentation.WORKBENCH_OVERLAY)
    }
    var showSessionInfo by remember { mutableStateOf(false) }
    var showSessionShare by remember { mutableStateOf(false) }
    var showArchiveConfirmation by remember { mutableStateOf(false) }
    var showCapsuleTextComposer by remember { mutableStateOf(false) }
    /** 工作台「交给 Agent」→ 对齐 iOS：预填 composer 提示语。 */
    var pendingComposerPrefill by remember { mutableStateOf<String?>(null) }
    var didSendInitialMessage by rememberSaveable(viewModel.sessionId, initialMessage) {
        mutableStateOf(false)
    }

    val spaceId = state.executionScope?.workspaceId ?: viewModel.spaceId
    val activeOrganizationId = state.executionScope?.organizationId
        ?.takeIf { it.isNotBlank() }
        ?: viewModel.organizationId
    val sessionId = viewModel.sessionId
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val isRegularWidth = configuration.screenWidthDp >= TaskSurfaceCoordinator.REGULAR_WIDTH_DP
    val composerDisabledReason = RemoteExecutionPresentation
        .composerDisabledReasonRes(state.remoteExecutionState)
        ?.let { stringResource(it) }
    val agentOptions = remember(
        myAgentsState.agents,
        myAgentsState.deactivatedAgents,
        activeOrganizationId,
    ) {
        if (activeOrganizationId.isBlank()) {
            emptyList()
        } else {
            buildComposerTaskAgentOptions(
                agents = myAgentsState.agents,
                deactivatedAgents = myAgentsState.deactivatedAgents,
            )
        }
    }
    val sessionAgentId = conversationState.executionAgentId
        ?: state.frozenAgentId
        ?: state.newTaskAgent?.id
    val selectedAgentId = ConversationDraftAgentSelectionPolicy.resolve(
        selectedAgentId = sessionAgentId,
        startsNewSession = viewModel.startsNewSession,
        options = agentOptions,
    )
    val currentAgentName = agentOptions.firstOrNull { it.id == selectedAgentId }?.name
        ?: state.newTaskAgent?.name
    val isTeamExecutionSpace = state.newTaskSpace?.isProject == true
    val isFirstSendInFlight = conversationState.isSending &&
        conversationState.messages.none { it.isUser }

    LaunchedEffect(
        initialMessage,
        state.session?.id,
        conversationState.currentModel?.id,
        conversationState.isLoading,
    ) {
        val firstMessage = initialMessage.trim()
        if (!didSendInitialMessage &&
            firstMessage.isNotEmpty() &&
            state.session != null &&
            conversationState.currentModel != null &&
            !conversationState.isLoading
        ) {
            didSendInitialMessage = true
            conversationViewModel.sendMessage(
                content = firstMessage,
                onFailed = {
                    didSendInitialMessage = false
                    pendingComposerPrefill = firstMessage
                },
            )
        }
    }
    val agentIsMutable = ConversationAgentSelectionPolicy.canChange(
        isTeamSpace = isTeamExecutionSpace,
        isFirstSendInFlight = isFirstSendInFlight,
        isUpdating = conversationState.isSwitchingAgent,
    )

    val capsuleInput = remember(conversationState) {
        TaskCapsuleModel.adapt(
            TaskCapsuleAdapterInput(
                runState = conversationState.runState,
                currentPhase = conversationState.currentPhase,
                isStreaming = conversationState.isStreaming,
                isSending = conversationState.isSending,
                messages = conversationState.messages,
                queuedCount = conversationState.queuedOutgoingMessages.count { it.isAutoDrainable },
                pendingApproval = conversationState.pendingRequestApproval != null ||
                    conversationState.pendingApproval != null ||
                    conversationState.pendingReview != null ||
                    conversationState.pendingPlanApproval != null,
                pendingAnswer = conversationState.pendingAskUser != null ||
                    conversationState.pendingAskForm != null,
                paused = conversationState.isPaused,
                suspended = conversationState.connectionInterrupted,
                hasUnreadReply = conversationState.readState?.hasUnreadReply == true,
                seenUntilTs = TaskCapsuleModel.parseSeenUntilTs(conversationState.readState?.readAt),
            ),
        )
    }
    val capsuleStatus = TaskCapsuleModel.resolveStatus(capsuleInput)
    val capsuleVisual = TaskCapsuleModel.resolveVisual(capsuleStatus)
    val capsuleInteractionBubble = remember(conversationState) {
        CapsuleInteractionBubblePolicy.project(conversationState)
    }
    val capsuleCopyContext = remember(conversationState, capsuleStatus) {
        AgentStatusCapsuleContext(
            currentAction = conversationState.currentToolName,
            pendingHitlCount = listOfNotNull(
                conversationState.pendingRequestApproval,
                conversationState.pendingApproval,
                conversationState.pendingReview,
                conversationState.pendingPlanApproval,
                conversationState.pendingAskUser,
                conversationState.pendingAskForm,
            ).size,
        )
    }
    val surfaceMode = TaskSurfaceCoordinator.resolveMode(
        TaskSurfaceLayout(
            widthDp = configuration.screenWidthDp,
            workbenchOpen = showWorkbench,
            preferAppFocus = preferAppFocus,
        ),
    )
    // 工作台打开过后才启用 compact 双 presentation；新会话仍是原本的 direct 对话面。
    val compactPresentationAvailable =
        configuration.screenWidthDp < TaskSurfaceCoordinator.REGULAR_WIDTH_DP &&
        ConversationWorkbenchUIPolicy.showsSurfaceSwitcher &&
        spaceId.isNotEmpty() &&
        (compactWorkbenchEverOpened || showWorkbench)
    val compactRenderPlan = if (compactPresentationAvailable) {
        TaskSurfaceCoordinator.compactConversationRenderPlan(
            presentation = compactConversationPresentation,
            overlayDetent = layerState.detent,
        )
    } else {
        null
    }
    val compactLayerActive = compactRenderPlan?.composeOverlayHost == true
    val conversationVisible = compactRenderPlan?.conversationContentVisible ?: run {
        TaskSurfaceCoordinator.conversationContentVisible(
            mode = surfaceMode,
            widthDp = configuration.screenWidthDp,
            workbenchOpen = showWorkbench,
        )
    }
    val capsuleLayoutAllows = compactRenderPlan?.capsuleVisible ?: run {
        TaskSurfaceCoordinator.capsuleLayoutAllows(
            mode = surfaceMode,
            widthDp = configuration.screenWidthDp,
            workbenchOpen = showWorkbench,
        )
    }
    LaunchedEffect(conversationVisible) {
        conversationViewModel.setConversationContentVisible(conversationVisible)
    }

    fun applyTaskSurfaceMode(mode: TaskSurfaceMode) {
        val next = TaskSurfaceStateReducer.apply(
            state = TaskSurfaceStateSnapshot(
                workbenchOpen = showWorkbench,
                preferAppFocus = preferAppFocus,
                everOpened = compactWorkbenchEverOpened,
                pendingOpenRequest = pendingWorkbenchOpenRequest,
                focus = currentFocus,
            ),
            mode = mode,
        )
        showWorkbench = next.workbenchOpen
        preferAppFocus = next.preferAppFocus
        compactWorkbenchEverOpened = next.everOpened
        pendingWorkbenchOpenRequest = next.pendingOpenRequest
        currentFocus = next.focus
    }

    fun openResourceInWorkbench(request: WorkbenchResourceOpenRequest) {
        compactConversationPresentation = CompactConversationPresentation.WORKBENCH_OVERLAY
        if (!isRegularWidth) {
            layerScope.launch { layerState.animateTo(ConversationLayerDetent.COLLAPSED) }
        }
        val next = TaskSurfaceStateReducer.openResource(
            state = TaskSurfaceStateSnapshot(
                workbenchOpen = showWorkbench,
                preferAppFocus = preferAppFocus,
                everOpened = compactWorkbenchEverOpened,
                pendingOpenRequest = pendingWorkbenchOpenRequest,
                focus = currentFocus,
            ),
            request = request,
        )
        showWorkbench = next.workbenchOpen
        preferAppFocus = next.preferAppFocus
        compactWorkbenchEverOpened = next.everOpened
        pendingWorkbenchOpenRequest = next.pendingOpenRequest
        currentFocus = next.focus
    }

    LaunchedEffect(spaceId) {
        if (spaceId.isNotEmpty()) workbenchViewModel.loadResources(spaceId)
    }

    // Composer 入队冻结与胶囊共用同一 Focus 源。
    LaunchedEffect(spaceId, currentFocus) {
        conversationViewModel.updateWorkbenchFocus(spaceId, currentFocus)
    }

    val snackbarHostState = remember { SnackbarHostState() }

    fun moveLayerTo(target: ConversationLayerDetent) {
        showCompactConversationOverlay(
            target = target,
            layerState = layerState,
            layerScope = layerScope,
            onPresentationChanged = { compactConversationPresentation = it },
            onTaskSurfaceModeChanged = ::applyTaskSurfaceMode,
        )
    }

    /**
     * 「去对话」的唯一入口。层态下这意味着把层升到半屏，而不是把工作台整个换掉——
     * 语义差异收在这里，调用方不必各自判断层态（漏一个就会变成「预填了消息但用户看不见对话」）。
     */
    fun clearWorkbenchFocusToConversation() {
        if (compactLayerActive) {
            TaskSurfaceCoordinator.capsuleTapTargetCompact(layerState.detent)?.let(::moveLayerTo)
        } else {
            applyTaskSurfaceMode(TaskSurfaceMode.CHAT_FOCUS)
        }
    }

    fun handleCapsuleInteraction(intent: CapsuleInteractionIntent) {
        if (
            conversationState.hitlSubmitting ||
            !CapsuleInteractionBubblePolicy.matchesCurrent(intent, conversationState)
        ) {
            return
        }
        when (intent) {
            is CapsuleInteractionIntent.ApproveRequest -> {
                conversationViewModel.submitRequestApproval(
                    approved = true,
                    expectedStableId = intent.expectedStableId,
                )
            }
            is CapsuleInteractionIntent.RejectRequest -> {
                conversationViewModel.submitRequestApproval(
                    approved = false,
                    expectedStableId = intent.expectedStableId,
                )
            }
            is CapsuleInteractionIntent.SubmitToolApproval -> {
                conversationViewModel.submitApproval(
                    outcome = intent.outcome,
                    scope = intent.scope,
                    expectedStableId = intent.expectedStableId,
                )
            }
            is CapsuleInteractionIntent.SubmitAskUserOption -> {
                conversationViewModel.submitAskUser(
                    listOf(
                        AskUserAnswerSelection(
                            questionId = intent.questionId,
                            selectedOptions = listOf(intent.optionId),
                            freeText = null,
                        ),
                    ),
                    expectedStableId = intent.expectedStableId,
                )
            }
            is CapsuleInteractionIntent.OpenConversation -> clearWorkbenchFocusToConversation()
        }
    }

    /** 顶部分段器进入独立完整对话面；胶囊短按仍只操作工作台上的 overlay。 */
    fun selectConversationSurface() {
        if (compactPresentationAvailable) {
            selectCompactConversationSurface(
                currentPresentation = compactConversationPresentation,
                layerState = layerState,
                layerScope = layerScope,
                onPresentationChanged = { compactConversationPresentation = it },
                onTaskSurfaceModeChanged = ::applyTaskSurfaceMode,
            )
        } else {
            clearWorkbenchFocusToConversation()
        }
    }

    fun requestWorkbenchApp(app: TaskWorkbenchApp) {
        pendingComposerPrefill = app.agentRequestPrompt
        clearWorkbenchFocusToConversation()
    }

    // overlay 的所有档位都属于工作台 presentation；拖拽改档不能切走工作台。
    LaunchedEffect(compactLayerActive, layerState.detent) {
        if (compactLayerActive) applyTaskSurfaceMode(TaskSurfaceMode.APP_FOCUS)
    }

    LaunchedEffect(Unit) {
        if (!ConversationWorkbenchUIPolicy.showsSurfaceSwitcher) {
            clearWorkbenchFocusToConversation()
        }
    }

    LaunchedEffect(state.errorRes) {
        val errorRes = state.errorRes ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(
            message = context.getString(errorRes),
            duration = SnackbarDuration.Short,
        )
        viewModel.dismissError()
    }

    LaunchedEffect(voiceState.phase, voiceState.lastGate) {
        when (voiceState.phase) {
            TaskVoiceSessionPhase.READY_TO_SEND -> {
                val submission = taskVoiceViewModel.consumeReadySubmission() ?: return@LaunchedEffect
                conversationViewModel.sendCapsuleVoice(submission) { receipt ->
                    when (receipt) {
                        is QueuedSendReceipt.Blocked -> {
                            taskVoiceViewModel.markBlocked(receipt.gate, submission.transcript)
                        }
                        is QueuedSendReceipt.Persisted,
                        is QueuedSendReceipt.Queued,
                        is QueuedSendReceipt.Accepted,
                        is QueuedSendReceipt.Failed,
                        -> Unit
                    }
                }
            }
            TaskVoiceSessionPhase.BLOCKED -> {
                val msg = when (voiceState.lastGate) {
                    CapsuleVoiceGate.BLOCK_HITL -> context.getString(R.string.agent_capsule_blocked_hitl)
                    CapsuleVoiceGate.BLOCK_PAUSED -> context.getString(R.string.agent_capsule_blocked_paused)
                    CapsuleVoiceGate.BLOCK_BILLING -> context.getString(R.string.chat_billing_blocked_hint)
                    else -> voiceState.errorMessage
                }
                if (!msg.isNullOrBlank()) {
                    snackbarHostState.showSnackbar(msg, duration = SnackbarDuration.Short)
                }
            }
            else -> Unit
        }
    }

    // 诚实回执：入队已保存 / busy 排队 / ACK 已送达
    LaunchedEffect(conversationViewModel) {
        conversationViewModel.voiceSendReceipts.collect { receipt ->
            val msg = when (receipt) {
                is QueuedSendReceipt.Persisted ->
                    context.getString(R.string.agent_capsule_persisted)
                is QueuedSendReceipt.Queued ->
                    context.getString(R.string.agent_capsule_queued_busy)
                is QueuedSendReceipt.Accepted ->
                    context.getString(R.string.agent_capsule_delivered)
                is QueuedSendReceipt.Failed -> receipt.reason
                is QueuedSendReceipt.Blocked -> when (receipt.gate) {
                    CapsuleVoiceGate.BLOCK_HITL ->
                        context.getString(R.string.agent_capsule_blocked_hitl)
                    CapsuleVoiceGate.BLOCK_PAUSED ->
                        context.getString(R.string.agent_capsule_blocked_paused)
                    CapsuleVoiceGate.BLOCK_BILLING ->
                        context.getString(R.string.chat_billing_blocked_hint)
                    else -> null
                }
            }
            if (!msg.isNullOrBlank()) {
                snackbarHostState.showSnackbar(msg, duration = SnackbarDuration.Short)
            }
        }
    }

    LaunchedEffect(Unit) {
        viewModel.forkedSession.collect { newSession ->
            onForkPush(newSession.id, spaceId, state.spaceName, activeOrganizationId)
        }
    }

    if (voiceState.phase == TaskVoiceSessionPhase.AWAITING_CONSENT) {
        AIDataSharingConsentDialog(
            onAgree = {
                taskVoiceViewModel.grantAiConsent()
            },
            onDisagree = { taskVoiceViewModel.declineAiConsent() },
        )
    }

    // 同意结束 → IDLE：提示重新按住（不自动开录）
    var prevVoicePhase by remember { mutableStateOf(voiceState.phase) }
    LaunchedEffect(voiceState.phase) {
        if (prevVoicePhase == TaskVoiceSessionPhase.AWAITING_CONSENT &&
            voiceState.phase == TaskVoiceSessionPhase.IDLE &&
            taskVoiceViewModel.hasAiConsent()
        ) {
            snackbarHostState.showSnackbar(
                message = context.getString(R.string.agent_capsule_consent_hold_again),
                duration = SnackbarDuration.Short,
            )
        }
        prevVoicePhase = voiceState.phase
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
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
                title = {
                    Column {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            SessionReadyIndicatorDot(
                                wsConnected = wsConnected,
                                remoteExecutionState = state.remoteExecutionState,
                            )
                            Text(
                                text = state.sessionTitle.ifEmpty {
                                    stringResource(R.string.agent_unnamed_session)
                                },
                                style = MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                actions = {
                    // ≥760dp：标题栏显式三态（对齐 iOS TaskViewModeSwitch），可稳定进 APP_FOCUS
                    if (ConversationWorkbenchUIPolicy.showsSurfaceSwitcher && isRegularWidth) {
                        TaskViewModeSwitch(
                            current = surfaceMode,
                            onSelect = { applyTaskSurfaceMode(it) },
                        )
                    }
                    IconButton(
                        onClick = {
                            val taskSpace = state.newTaskSpace ?: return@IconButton
                            val taskAgent = state.newTaskAgent ?: return@IconButton
                            onNewDraftSession(
                                taskSpace.id,
                                taskSpace.name,
                                taskSpace.organizationId,
                                taskAgent.id,
                            )
                        },
                        enabled = state.newTaskSpace != null && state.newTaskAgent != null,
                    ) {
                        Icon(
                            Icons.Default.AddComment,
                            contentDescription = stringResource(R.string.agent_new_conversation),
                        )
                    }
                    var showMenu by remember { mutableStateOf(false) }
                    IconButton(onClick = { showMenu = true }) {
                        Icon(
                            Icons.Default.MoreHoriz,
                            contentDescription = stringResource(R.string.common_more),
                        )
                    }
                    DropdownMenu(
                        expanded = showMenu,
                        onDismissRequest = { showMenu = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text("会话信息") },
                            onClick = {
                                showMenu = false
                                showSessionInfo = true
                            },
                            enabled = state.session != null,
                        )
                        DropdownMenuItem(
                            text = { Text("共享") },
                            onClick = {
                                showMenu = false
                                showSessionShare = true
                            },
                            enabled = sessionId.isNotBlank() && activeOrganizationId.isNotBlank(),
                        )
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text(if (state.isArchiving) "正在归档…" else "归档") },
                            onClick = {
                                showMenu = false
                                if (conversationState.isStreaming) {
                                    viewModel.archiveSession(isStreaming = true)
                                } else {
                                    showArchiveConfirmation = true
                                }
                            },
                            enabled = !state.isArchiving && sessionId.isNotBlank(),
                        )
                    }
                },
            )
        },
    ) { padding ->
        val onDelegate: (SpaceResource) -> Unit = { resource ->
            val ref = ResourceReference.from(resource)
            if (ref.canSendToConversation &&
                pendingDelegations.none { it.id == ref.id } &&
                pendingDelegations.size < WorkbenchUiState.MAX_DELEGATION_REFERENCES
            ) {
                pendingDelegations = pendingDelegations + ref
            }
        }
        val onResourceOpen: (SpaceResource) -> Unit = { resource ->
            when (resource.normalizedType) {
                "tabsite" -> {
                    val meta = resource.metadata
                    val publishedUrl = (meta?.get("published_url") as? JsonPrimitive)?.content ?: ""
                    val siteStatus = (meta?.get("status") as? JsonPrimitive)?.content ?: "draft"
                    onNavigateToTabSite(
                        resource.resourceId,
                        resource.displayTitle,
                        publishedUrl,
                        siteStatus,
                    )
                }
                "tabmemo" -> onNavigateToMemo(resource.resourceId)
                else -> onDelegate(resource)
            }
        }
        val onSendReference: (ResourceReference) -> Unit = { ref ->
            if (ref.canSendToConversation &&
                pendingDelegations.none { it.id == ref.id } &&
                pendingDelegations.size < WorkbenchUiState.MAX_DELEGATION_REFERENCES
            ) {
                pendingDelegations = pendingDelegations + ref
            }
        }

        @Composable
        fun ConversationPane() {
            ConversationView(
                sessionId = sessionId,
                spaceId = spaceId,
                organizationId = activeOrganizationId,
                focusMessageId = messageId,
                composerRuntimeStatusReady = state.runtimeStatusReady,
                composerDisabledReason = composerDisabledReason,
                workspaceName = state.spaceName,
                currentAgentName = currentAgentName,
                agentOptions = agentOptions,
                selectedAgentId = selectedAgentId,
                agentIsMutable = agentIsMutable,
                onAgentChange = { option ->
                    conversationViewModel.switchSessionAgent(option.id)
                },
                onSessionUpdated = { title, count ->
                    viewModel.updateSessionMeta(newTitle = title, newMessageCount = count)
                },
                resourceReferences = pendingDelegations,
                onResourceReferencesConsumed = { pendingDelegations = emptyList() },
                onRemoveResourceReference = { refId ->
                    pendingDelegations = pendingDelegations.filter { it.id != refId }
                },
                canOpenResourceReference = { ref -> ref.normalizedType == "tabmemo" },
                onOpenResourceReference = { ref -> onNavigateToMemo(ref.resourceId) },
                onOpenInWorkbench = if (
                    ConversationWorkbenchUIPolicy.showsSurfaceSwitcher &&
                    spaceId.isNotBlank() &&
                    activeOrganizationId.isNotBlank()
                ) {
                    ::openResourceInWorkbench
                } else {
                    null
                },
                onNavigateToWallet = onNavigateToWallet,
                onStartNewSession = null,
                onRelogin = onRelogin,
                onForkFromMessage = { mid -> viewModel.forkSession(mid) },
                mentionableResources = wbState.resources,
                mentionableResourcesLoading = wbState.isLoading,
                composerPrefillText = pendingComposerPrefill,
                onComposerPrefillConsumed = { pendingComposerPrefill = null },
                startsNewSession = viewModel.startsNewSession,
                draftProjectId = state.executionScope?.projectId,
                draftExecutionSpace = state.newTaskSpace,
                draftAgentId = selectedAgentId,
                viewModel = conversationViewModel,
            )
        }

        // 窄屏第一次打开工作台会让 compactLayerActive 翻转，对话从「独占那一屏」搬进对话层。
        // 直接在两个分支各写一次调用，Compose 会按位置判定成两棵不同的子树：旧的整棵 dispose，
        // 输入框草稿和消息列表滚动位置一起没。movableContent 让同一棵子树整体搬家。
        // rememberUpdatedState 兜住闭包：movableContent 只 remember 一次，
        // 直接捕获 ConversationPane 会把首帧那份捕获永久钉死。
        val conversationPaneRef = rememberUpdatedState<@Composable () -> Unit> { ConversationPane() }
        val movableConversationPane = remember {
            movableContentOf { conversationPaneRef.value.invoke() }
        }

        var voiceFromMenuTick by remember { mutableIntStateOf(0) }
        var voiceFromMenuConsumedTick by remember { mutableIntStateOf(0) }
        val voiceControlSessionActive = voiceState.phase == TaskVoiceSessionPhase.RECORDING ||
            voiceState.phase == TaskVoiceSessionPhase.TRANSCRIBING ||
            voiceState.phase == TaskVoiceSessionPhase.PROCESSING
        val showsVoiceHud = voiceControlSessionActive

        // 窄屏胶囊随工作台卸载；离开切面时收口会话，避免带着 RECORDING/PROCESSING 再回来。
        LaunchedEffect(capsuleLayoutAllows) {
            if (!capsuleLayoutAllows) {
                taskVoiceViewModel.cancelHold()
            }
        }

        fun openCapsuleTextComposer() {
            showCapsuleTextComposer = true
        }

        fun sendCapsuleText(text: String) {
            val trimmed = text.trim()
            if (trimmed.isEmpty()) return
            val hardGate = composerDisabledReason
                ?: conversationViewModel.enqueueBlockReason()
            if (hardGate != null) {
                // 门闩已在输入条展示；发送瞬间再拦一次。
                return
            }
            conversationViewModel.sendMessage(
                ConversationSendRequest(
                    content = trimmed,
                    attachmentPolicy = AttachmentPolicy.NONE,
                    focus = TaskFocusSnapshot.from(spaceId = spaceId, target = currentFocus),
                ),
            )
            showCapsuleTextComposer = false
        }

        @Composable
        fun CapsuleChrome(
            side: CapsuleDockSide,
            onDockSide: (CapsuleDockSide) -> Unit,
            onChromePositioned: ((LayoutCoordinates) -> Unit)? = null,
        ) {
            val voiceActive = voiceControlSessionActive
            Column(
                horizontalAlignment = if (side == CapsuleDockSide.LEFT) {
                    Alignment.Start
                } else {
                    Alignment.End
                },
            ) {
                if (showsVoiceHud) {
                    CapsuleVoiceListeningHud(
                        phase = voiceState.phase,
                        transcript = voiceState.transcript,
                        onCancel = { taskVoiceViewModel.cancelHold() },
                        onSend = { taskVoiceViewModel.completeHold() },
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                AgentStatusCapsule(
                    status = capsuleStatus,
                    visual = capsuleVisual,
                    agentName = currentAgentName ?: "Agent",
                    avatarKey = state.newTaskAgent?.settings?.avatarKey
                        ?: state.newTaskAgent?.icon,
                    avatarUrl = state.newTaskAgent?.settings?.avatarUrl,
                    queuedCount = capsuleInput.queuedCount,
                    unreadCount = capsuleInput.unreadCount,
                    copyContext = capsuleCopyContext,
                    privacyGranted = taskVoiceViewModel.hasAiConsent(),
                    voiceActive = voiceActive,
                    voiceCancelArmed = false,
                    onHoldStart = {
                        val focus = TaskFocusSnapshot.from(spaceId = spaceId, target = currentFocus)
                        taskVoiceViewModel.beginHold(focus)
                    },
                    onHoldCancel = { taskVoiceViewModel.cancelHold() },
                    onHoldComplete = { taskVoiceViewModel.completeHold() },
                    onNeedsPrivacyConsent = {
                        val focus = TaskFocusSnapshot.from(spaceId = spaceId, target = currentFocus)
                        taskVoiceViewModel.requestConsent(focus)
                    },
                    onTap = {
                        clearWorkbenchFocusToConversation()
                    },
                    onDockLeft = { onDockSide(CapsuleDockSide.LEFT) },
                    onDockRight = { onDockSide(CapsuleDockSide.RIGHT) },
                    voiceFromMenuTick = voiceFromMenuTick,
                    voiceFromMenuConsumedTick = voiceFromMenuConsumedTick,
                    onVoiceFromMenuConsumed = { voiceFromMenuConsumedTick = voiceFromMenuTick },
                    onChromePositioned = onChromePositioned,
                )
            }
        }

        @Composable
        fun CapsuleOverlay(onChromePositioned: ((LayoutCoordinates) -> Unit)? = null) {
            CapsulePositionedHost(
                onTap = { clearWorkbenchFocusToConversation() },
                onTextRequested = { openCapsuleTextComposer() },
                onVoiceRequested = { voiceFromMenuTick += 1 },
                onboardingReplySuggested = capsuleStatus == TaskCapsuleStatus.COMPLETE,
                onboardingSuppressed = capsuleInteractionBubble != null,
                voiceControlSessionActive = voiceControlSessionActive,
                interactionBubble = { side, aboveCapsule ->
                    capsuleInteractionBubble
                        ?.takeUnless { voiceControlSessionActive }
                        ?.let { model ->
                            CapsuleInteractionBubble(
                                model = model,
                                dockSide = side,
                                aboveCapsule = aboveCapsule,
                                onIntent = ::handleCapsuleInteraction,
                            )
                        }
                },
            ) { side, onDockSide ->
                CapsuleChrome(
                    side = side,
                    onDockSide = onDockSide,
                    onChromePositioned = onChromePositioned,
                )
            }
        }

        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding),
        ) {
            val regularWidth = maxWidth.value >= TaskSurfaceCoordinator.REGULAR_WIDTH_DP
            val showsWorkbenchChrome = ConversationWorkbenchUIPolicy.showsSurfaceSwitcher &&
                spaceId.isNotEmpty()
            Column(modifier = Modifier.fillMaxSize()) {
                // 双 presentation 启用后，详情页也必须保留进入 direct 对话的唯一入口。
                val showCompactPicker = TaskSurfaceCoordinator.compactSurfaceSwitcherVisible(
                    regularWidth = regularWidth,
                    showsWorkbenchChrome = showsWorkbenchChrome,
                    compactPresentationAvailable = compactPresentationAvailable,
                    showWorkbench = showWorkbench,
                    detailRequestsSwitcherHidden = hideCompactSurfaceSwitcher,
                )
                if (showCompactPicker) {
                    CompactTaskSurfacePicker(
                        workbenchSelected = if (compactPresentationAvailable) {
                            compactRenderPlan?.pickerWorkbenchSelected == true
                        } else {
                            showWorkbench
                        },
                        onSelectConversation = { selectConversationSurface() },
                        onSelectWorkbench = {
                            if (compactPresentationAvailable) {
                                moveLayerTo(ConversationLayerDetent.COLLAPSED)
                            } else {
                                compactConversationPresentation =
                                    CompactConversationPresentation.WORKBENCH_OVERLAY
                                applyTaskSurfaceMode(TaskSurfaceMode.APP_FOCUS)
                            }
                        },
                    )
                }
                Box(modifier = Modifier.weight(1f)) {
                    val useSplitHost = showsWorkbenchChrome && regularWidth
                    if (useSplitHost) {
                        TaskSurfaceHost(
                            organizationId = activeOrganizationId,
                            spaceId = spaceId,
                            workbenchOpen = showWorkbench,
                            preferAppFocus = preferAppFocus,
                            initialOpenRequest = pendingWorkbenchOpenRequest,
                            onInitialOpenRequestConsumed = { consumed ->
                                if (pendingWorkbenchOpenRequest == consumed) {
                                    pendingWorkbenchOpenRequest = null
                                }
                            },
                            onFocusChanged = { currentFocus = it },
                            onDismissWorkbench = {
                                clearWorkbenchFocusToConversation()
                            },
                            onDelegateToAgent = onDelegate,
                            onResourceOpen = onResourceOpen,
                            onSendReference = onSendReference,
                            onRequestApp = ::requestWorkbenchApp,
                            conversationMessages = conversationState.messages +
                                conversationState.subagentTranscriptMessages,
                            workbenchViewModel = workbenchViewModel,
                            conversationContent = { ConversationPane() },
                            capsuleOverlay = { onChromePositioned -> CapsuleOverlay(onChromePositioned) },
                            onModeChanged = { mode ->
                                preferAppFocus = mode == TaskSurfaceMode.APP_FOCUS
                                if (mode == TaskSurfaceMode.CHAT_FOCUS) {
                                    showWorkbench = false
                                }
                            },
                        )
                    } else {
                        // 窄屏：工作台常驻底层，对话是盖在上面的可拖层（收起时只剩胶囊）
                        if (showWorkbench) compactWorkbenchEverOpened = true
                        val mountWorkbench = showsWorkbenchChrome &&
                            TaskSurfaceCoordinator.shouldComposeWorkbenchCompact(
                                everOpened = compactWorkbenchEverOpened,
                                workbenchOpen = showWorkbench,
                            )
                        Box(modifier = Modifier.fillMaxSize()) {
                            if (
                                compactRenderPlan == null ||
                                compactRenderPlan.composeDirectConversation
                            ) {
                                // 纯对话与顶部「对话」都走 direct surface，不组合 layer chrome。
                                Box(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .zIndex(if (conversationVisible) 1f else 0f)
                                        .alpha(if (conversationVisible) 1f else 0f),
                                ) {
                                    movableConversationPane()
                                }
                            }
                            if (mountWorkbench) {
                                // overlay 下工作台始终可见；direct 下只 keep-alive，不参与绘制。
                                Box(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .zIndex(
                                            if (!compactLayerActive && showWorkbench) 1f else 0f,
                                        )
                                        .alpha(
                                            if (compactLayerActive || showWorkbench) 1f else 0f,
                                        ),
                                ) {
                                    WorkbenchSurface(
                                        organizationId = activeOrganizationId,
                                        spaceId = spaceId,
                                        backHandlingEnabled =
                                            TaskSurfaceCoordinator.compactWorkbenchBackHandlingEnabled(
                                                workbenchOpen = showWorkbench,
                                                presentation = compactConversationPresentation,
                                                detent = layerState.detent,
                                            ),
                                        initialOpenRequest = pendingWorkbenchOpenRequest,
                                        onInitialOpenRequestConsumed = { consumed ->
                                            if (pendingWorkbenchOpenRequest == consumed) {
                                                pendingWorkbenchOpenRequest = null
                                            }
                                        },
                                        onFocusChanged = { currentFocus = it },
                                        onDismiss = {
                                            clearWorkbenchFocusToConversation()
                                        },
                                        onDelegateToAgent = onDelegate,
                                        onResourceOpen = onResourceOpen,
                                        onSendReference = onSendReference,
                                        onRequestApp = ::requestWorkbenchApp,
                                        conversationMessages = conversationState.messages +
                                            conversationState.subagentTranscriptMessages,
                                        presentation = WorkbenchPresentation.TASK_PANE,
                                        onTaskPaneDetailVisibilityChanged = {
                                            hideCompactSurfaceSwitcher = it
                                        },
                                        viewModel = workbenchViewModel,
                                    )
                                }
                            }
                            if (compactRenderPlan?.composeOverlayHost == true) {
                                ConversationLayerHost(
                                    state = layerState,
                                    // 形参保留（Task 9 契约）；surface mode 由 detent 的 LaunchedEffect 跟随。
                                    onDetentSettled = { },
                                    modifier = Modifier.zIndex(1f),
                                ) {
                                    movableConversationPane()
                                }
                            }
                            if (capsuleLayoutAllows) {
                                Box(modifier = Modifier.zIndex(2f).fillMaxSize()) {
                                    CapsuleOverlay()
                                }
                            }
                        }
                    }
                }
            }
        }

        if (showCapsuleTextComposer) {
            val enqueueBlock = conversationViewModel.enqueueBlockReason()
            CapsuleTextComposerOverlay(
                disabledReason = composerDisabledReason ?: enqueueBlock,
                onSend = { sendCapsuleText(it) },
                onDismiss = { showCapsuleTextComposer = false },
            )
        }
    }

    state.session?.takeIf { showSessionInfo }?.let { session ->
        ConversationSessionInfoSheet(
            session = session,
            isSavingTitle = state.isSavingTitle,
            isRunning = conversationState.isStreaming,
            onDismiss = { showSessionInfo = false },
            onSaveTitle = viewModel::renameSession,
        )
    }
    if (showSessionShare) {
        ConversationSessionShareSheet(
            sessionId = sessionId,
            organizationId = activeOrganizationId,
            onDismiss = { showSessionShare = false },
        )
    }
    if (showArchiveConfirmation) {
        AlertDialog(
            onDismissRequest = { showArchiveConfirmation = false },
            title = { Text("归档这个会话？") },
            text = { Text("归档后会话仍保留在任务列表中，并标记为“已归档”。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showArchiveConfirmation = false
                        viewModel.archiveSession(isStreaming = conversationState.isStreaming)
                    },
                    enabled = !state.isArchiving,
                ) { Text("归档") }
            },
            dismissButton = {
                TextButton(onClick = { showArchiveConfirmation = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun CompactTaskSurfacePicker(
    workbenchSelected: Boolean,
    onSelectConversation: () -> Unit,
    onSelectWorkbench: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val options = listOf(
        false to R.string.common_tab_chat,
        true to R.string.chat_workbench,
    )
    SingleChoiceSegmentedButtonRow(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
        options.forEachIndexed { index, (isWorkbench, labelRes) ->
            SegmentedButton(
                selected = workbenchSelected == isWorkbench,
                onClick = {
                    if (isWorkbench) onSelectWorkbench() else onSelectConversation()
                },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
            ) {
                Text(stringResource(labelRes))
            }
        }
    }
}

/**
 * 宽屏标题栏三态切换：对话聚焦 / 分屏 / 应用聚焦。
 * 绑定 [preferAppFocus]+[workbenchOpen]（经 [applyTaskSurfaceMode]）；
 * 图标分段 + 无障碍文案，避免纯文字在 TopAppBar 里难发现。
 */
@Composable
private fun TaskViewModeSwitch(
    current: TaskSurfaceMode,
    onSelect: (TaskSurfaceMode) -> Unit,
) {
    val modes = listOf(
        Triple(
            TaskSurfaceMode.CHAT_FOCUS,
            Icons.AutoMirrored.Outlined.Chat,
            R.string.agent_capsule_mode_chat_focus,
        ),
        Triple(
            TaskSurfaceMode.SPLIT,
            Icons.Outlined.VerticalSplit,
            R.string.agent_capsule_mode_split,
        ),
        Triple(
            TaskSurfaceMode.APP_FOCUS,
            Icons.Outlined.SpaceDashboard,
            R.string.agent_capsule_mode_app_focus,
        ),
    )
    val groupLabel = buildString {
        append(stringResource(R.string.agent_capsule_mode_chat_focus))
        append(" / ")
        append(stringResource(R.string.agent_capsule_mode_split))
        append(" / ")
        append(stringResource(R.string.agent_capsule_mode_app_focus))
    }
    Row(
        modifier = Modifier
            .padding(end = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
            .padding(2.dp)
            .selectableGroup()
            .semantics { contentDescription = groupLabel },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        modes.forEach { (mode, icon, labelRes) ->
            val selected = current == mode
            val label = stringResource(labelRes)
            Box(
                modifier = Modifier
                    .size(width = 36.dp, height = 32.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(
                        if (selected) {
                            MaterialTheme.colorScheme.surface
                        } else {
                            MaterialTheme.colorScheme.surface.copy(alpha = 0f)
                        },
                    )
                    .selectable(
                        selected = selected,
                        onClick = { onSelect(mode) },
                        role = Role.RadioButton,
                    )
                    .semantics { contentDescription = label },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = if (selected) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}

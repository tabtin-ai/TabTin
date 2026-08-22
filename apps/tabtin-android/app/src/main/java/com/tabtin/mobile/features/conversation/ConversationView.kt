package com.tabtin.mobile.features.conversation

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.MediaStore
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.ConversationDraftScope
import com.tabtin.mobile.data.model.MessageBlock
import com.tabtin.mobile.data.model.SessionRunState
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.data.model.SessionRollbackState
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.oss.UploadConfig
import com.tabtin.mobile.data.repository.OutgoingQueuePolicy
import com.tabtin.mobile.data.repository.QueuedOutgoingMessage
import com.tabtin.mobile.data.repository.QueuedOutgoingMessageAction
import com.tabtin.mobile.data.repository.QueuedOutgoingMessageStatus
import com.tabtin.mobile.features.conversation.checkpoint.ChatCheckpointEvent
import com.tabtin.mobile.features.conversation.checkpoint.ChatCheckpointViewModel
import com.tabtin.mobile.features.conversation.checkpoint.RestoreOverlay
import com.tabtin.mobile.features.conversation.checkpoint.RevertBanner
import com.tabtin.mobile.features.conversation.checkpoint.RevertHistorySheet
import com.tabtin.mobile.features.conversation.checkpoint.RewindPreviewSheet
import com.tabtin.mobile.features.space.AgentAvatarPreset
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import com.tabtin.mobile.features.workbench.WorkbenchUiState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBarsPadding

@Composable
public fun ConversationView(
    sessionId: String,
    spaceId: String? = null,
    organizationId: String? = null,
    focusMessageId: String = "",
    composerRuntimeStatusReady: Boolean = true,
    /** Composer 硬门闩：远程执行设备离线/未绑定时禁发（对齐 iOS composerDisabledReason）。 */
    composerDisabledReason: String? = null,
    workspaceName: String? = null,
    currentAgentName: String? = null,
    agentOptions: List<ComposerTaskAgentOption> = emptyList(),
    selectedAgentId: String? = null,
    agentIsMutable: Boolean = false,
    onAgentChange: (ComposerTaskAgentOption) -> Unit = {},
    onSessionUpdated: (title: String?, messageCount: Int) -> Unit,
    resourceReferences: List<ResourceReference> = emptyList(),
    onResourceReferencesConsumed: () -> Unit = {},
    onRemoveResourceReference: (String) -> Unit = {},
    canOpenResourceReference: (ResourceReference) -> Boolean = { false },
    onOpenResourceReference: ((ResourceReference) -> Unit)? = null,
    /** 对话富内容卡片在当前任务工作台内打开；无任务宿主时卡片自行回退外部深链。 */
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)? = null,
    onNavigateToWallet: (() -> Unit)? = null,
    // Wave 5 S4: shorten_context 错误卡动作按钮（对齐 Electron MessageBubble ErrorClassCard
    // 的 shorten_context → useChatStore.createSession）。通常由 AgentDetailScreen 绑到
    // AgentDetailViewModel.createNewSession。null 时按钮不渲染。
    onStartNewSession: (() -> Unit)? = null,
    // Wave 5 用户视角 Review: relogin 错误卡动作按钮（对齐 Electron ConfirmDialog → logout
    // 与 iOS AuthService.shared.logout）。handler 本身应同时完成 session 清理 + 跳转登录页。
    // null 时按钮不渲染。通常由 AppNavigation 绑定 { authVm.logout(); navigate(LoginRoute) }。
    onRelogin: (() -> Unit)? = null,
    // Wave 6 A3：从指定消息 Fork 出新会话。对齐 iOS `ConversationScreen.onSessionForked`
    // → `AgentDetailScreen.switchTo(newSessionId)` 的协调职责。
    // ConversationView 只负责触发（从长按菜单）；实际调用 `ChatRepository.forkSession` + 切 session
    // 由宿主 AgentDetailScreen 做。null 时菜单里不显示 Fork 项。
    onForkFromMessage: ((messageId: String) -> Unit)? = null,
    // Wave 6 A6：当前 Space 可 @ 提及的资源列表。
    //   - 由 AgentDetailScreen 从 WorkbenchViewModel 透传（它已经加载了当前 Space 的 tabdata/
    //     tabdoc/tabslide/tabsite/tabtracker 等资源）；
    //   - 空列表 → Composer 仍可输入 @，但 MentionPopover 会显示"当前 Space 暂无可引用的资源"；
    //   - 与 Electron `MentionPopover` API 搜索路径差别：移动端不独立搜远端，只做本地过滤。
    mentionableResources: List<SpaceResource> = emptyList(),
    // Wave 6 产品/用户 Review P0-1：区分"资源加载中"与"真的没资源"。WorkbenchVM.loadResources
    // 是异步的——用户在加载完成前按 @ 时 popover 应展示"加载中…"而不是"暂无可引用"。
    mentionableResourcesLoading: Boolean = false,
    /**
     * 工作台「交给 Agent」对齐 iOS：宿主把提示语塞进这里，本 Composable 合并进输入框后回调消费。
     * 空串 / null 表示无待插入内容。
     */
    composerPrefillText: String? = null,
    onComposerPrefillConsumed: () -> Unit = {},
    /**
     * 对齐 iOS ConversationTarget.startsNewSession：与空 sessionId 一起判定草稿入口。
     * 草稿不 loadSession，首发才 prepareSession。
     */
    startsNewSession: Boolean = false,
    /** 草稿 scope 的 Project 归属（团队 Space）；个人 Workspace 为 null。 */
    draftProjectId: String? = null,
    /** 首发 prepareSession 所需的执行 Space（通常来自 ChatSessionViewModel.newTaskSpace）。 */
    draftExecutionSpace: Space? = null,
    /** 草稿预选 / 当前 AI 分身；enableDraftMode 写入 ViewModel。 */
    draftAgentId: String? = null,
    viewModel: ConversationViewModel = hiltViewModel(),
    checkpointViewModel: ChatCheckpointViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val wsState by viewModel.connectionState.collectAsState()
    val resumeResult by viewModel.webSocketService.lastResumeResult.collectAsState()
    val attachmentList by viewModel.attachmentManager.attachments.collectAsState()
    var isManualReconnecting by remember { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()
    val checkpointState by checkpointViewModel.uiState.collectAsState()
    val checkpointHealthMap by checkpointViewModel.checkpointHealthBySessionId.collectAsState()
    var inputText by rememberSaveable { mutableStateOf("") }
    var restoredComposerBlocks by remember(sessionId) { mutableStateOf<List<MessageBlock>>(emptyList()) }
    val composerPrefill = composerPrefillText?.trim().orEmpty()
    LaunchedEffect(composerPrefill) {
        if (composerPrefill.isEmpty()) return@LaunchedEffect
        val current = inputText.trim()
        inputText = if (current.isEmpty()) composerPrefill else "$inputText\n$composerPrefill"
        onComposerPrefillConsumed()
    }
    // ：撤回未答轮次后把原文交还输入框（对齐 iOS cancel restoredText）。
    val composerRestore = state.pendingComposerRestoreText?.trim().orEmpty()
    val composerRestoreBlocks = state.pendingComposerRestoreBlocks.orEmpty()
    LaunchedEffect(composerRestore, composerRestoreBlocks) {
        if (composerRestore.isEmpty() && composerRestoreBlocks.isEmpty()) return@LaunchedEffect
        if (composerRestore.isNotEmpty()) inputText = composerRestore
        restoredComposerBlocks = composerRestoreBlocks
        viewModel.consumeComposerRestoreText()
    }
    var showRewindSheet by remember { mutableStateOf(false) }
    var showHistorySheet by remember { mutableStateOf(false) }
    var dismissedRollbackBannerKey by remember(sessionId) { mutableStateOf<String?>(null) }
    /** 用户在翻消息（滚动中 / 停在历史里）→ Composer 收成阅读态胶囊，把高度让给阅读。 */
    var composerCollapsedForReading by remember { mutableStateOf(false) }
    // 悬浮输入区的实测高度：回填成列表底部 contentPadding，使内容能滚过它下方、贴底时
    // 又不被它压住。收敛 / 展开、HITL 面板进出都会改这个值，列表随之调整。
    var composerFooterHeightPx by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val composerFooterHeight = with(density) { composerFooterHeightPx.toDp() }
    // 渐隐带与悬浮输入区共用这一个底色，两段才接得上（见 ComposerTopScrimStops）。
    val composerSurfaceColor = ttColor(TTColors.Background, TTColors.Dark.Background)
    val readingBottomSlackPx = with(density) { ComposerReadingBottomSlack.roundToPx() }
    val listState = rememberLazyListState()
    val context = LocalContext.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val latestState by rememberUpdatedState(state)
    val activity = remember(context) { context.findActivity() }

    DisposableEffect(activity) {
        val window = activity?.window
        val originalSoftInputMode = window?.attributes?.softInputMode
        if (window != null && originalSoftInputMode != null) {
            val adjustNothingMode =
                (originalSoftInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_STATE) or
                    WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
            window.setSoftInputMode(adjustNothingMode)
        }
        onDispose {
            if (window != null && originalSoftInputMode != null) {
                window.setSoftInputMode(originalSoftInputMode)
            }
        }
    }

    val imagePickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(maxItems = UploadConfig.MAX_ATTACHMENTS)
    ) { uris ->
        val remaining = UploadConfig.MAX_ATTACHMENTS - viewModel.attachmentManager.attachments.value.size
        uris.take(remaining.coerceAtLeast(0)).forEach { viewModel.addAttachment(it) }
    }

    val documentPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        val remaining = UploadConfig.MAX_ATTACHMENTS - viewModel.attachmentManager.attachments.value.size
        uris.take(remaining.coerceAtLeast(0)).forEach { viewModel.addAttachment(it) }
    }

    var cameraPhotoUri by rememberSaveable(
        stateSaver = Saver(
            save = { it?.toString() },
            restore = { it.let { s -> Uri.parse(s) } }
        )
    ) { mutableStateOf<Uri?>(null) }
    var cameraAccessIssue by remember { mutableStateOf<CameraAccessIssue?>(null) }
    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        val photoUri = cameraPhotoUri
        cameraPhotoUri = null
        if (success) photoUri?.let { viewModel.addAttachment(it) }
    }

    val onPickImages = {
        imagePickerLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }
    val onPickFiles = {
        documentPickerLauncher.launch((UploadConfig.ACCEPTED_FILE_TYPES + UploadConfig.ACCEPTED_MEDIA_TYPES).toTypedArray())
    }
    val launchCamera = {
        try {
            val cacheDir = File(context.cacheDir, "camera").apply { mkdirs() }
            val file = File(cacheDir, "photo_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            cameraPhotoUri = uri
            cameraLauncher.launch(uri)
        } catch (_: Exception) {
            cameraPhotoUri = null
            cameraAccessIssue = CameraAccessIssue.LAUNCH_FAILED
        }
    }
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            launchCamera()
        } else {
            cameraAccessIssue = CameraAccessIssue.PERMISSION_DENIED
        }
    }
    val onCamera = {
        val cameraAvailable = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .resolveActivity(context.packageManager) != null
        val permissionGranted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED

        when (cameraAccessAction(cameraAvailable, permissionGranted)) {
            CameraAccessAction.OPEN_CAMERA -> launchCamera()
            CameraAccessAction.REQUEST_PERMISSION -> {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
            CameraAccessAction.SHOW_UNAVAILABLE -> {
                cameraAccessIssue = CameraAccessIssue.UNAVAILABLE
            }
        }
    }

    var showVoiceInput by remember { mutableStateOf(false) }
    var showContextPicker by remember { mutableStateOf(false) }

    var activeResourceRefs by remember { mutableStateOf<List<ResourceReference>>(emptyList()) }

    val currentOnSessionUpdated by rememberUpdatedState(onSessionUpdated)
    val isDraftEntry = ConversationDraftFirstSendPolicy.isDraftEntry(sessionId, startsNewSession)

    LaunchedEffect(
        sessionId,
        startsNewSession,
        organizationId,
        spaceId,
        draftProjectId,
        draftExecutionSpace,
        draftAgentId,
    ) {
        if (isDraftEntry) {
            // 首发成功后 ViewModel 已有 session：路由 sessionId 仍可能为空，勿再清附件/重绑草稿。
            if (viewModel.hasActiveSession()) return@LaunchedEffect
            val org = organizationId?.takeIf { it.isNotBlank() }
            val workspace = spaceId?.takeIf { it.isNotBlank() }
            ConversationAttachmentScopePolicy.resolve(
                sessionId = sessionId,
                startsNewSession = true,
                organizationId = org,
                workspaceId = workspace,
                projectId = draftProjectId,
            )?.let { uploadScope ->
                viewModel.attachmentManager.bindSession(uploadScope.contextId, uploadScope)
            }
            if (org != null && workspace != null) {
                viewModel.bindDraftPersistenceScope(
                    ConversationDraftScope(
                        organizationId = org,
                        workspaceId = workspace,
                        projectId = draftProjectId,
                    ),
                )
            }
            val space = draftExecutionSpace
            if (space != null) {
                viewModel.enableDraftMode(
                    executionSpace = space,
                    agentId = draftAgentId.orEmpty(),
                )
            }
            checkpointViewModel.dismissPreview()
            return@LaunchedEffect
        }
        inputText = ""
        activeResourceRefs = emptyList()
        checkpointViewModel.dismissPreview()
        viewModel.loadSession(sessionId, spaceId = spaceId, organizationId = organizationId)
        organizationId
            ?.takeIf { it.isNotBlank() }
            ?.let { viewModel.attachmentManager.bindSession(sessionId, it) }
        checkpointViewModel.loadSessionRollbackState(sessionId)
    }

    LaunchedEffect(sessionId, startsNewSession, composerRuntimeStatusReady) {
        // 草稿首发由 sendMessage → enqueuePendingDraftIfPresent 完成；此处只服务正式会话恢复。
        if (isDraftEntry) return@LaunchedEffect
        // 设备离线不再拦截；只等首次探测完成。首发写入本地 durable queue。
        if (!composerRuntimeStatusReady) return@LaunchedEffect
        viewModel.enqueuePendingDraftIfPresent(sessionId)
    }

    // Wave 6 A3：订阅 ViewModel 的 forkRequests（ChatBubble 菜单触发后会 emit），
    // 向上传给 AgentDetailScreen 真正做 `POST /chat/sessions/{id}/fork` + 切 session。
    val currentOnForkFromMessage by rememberUpdatedState(onForkFromMessage)
    LaunchedEffect(Unit) {
        viewModel.forkRequests.collect { event ->
            currentOnForkFromMessage?.invoke(event.messageId)
        }
    }

    LaunchedEffect(viewModel, sessionId) {
        viewModel.editResendEvents.collect {
            checkpointViewModel.updateRollbackState(null)
            android.widget.Toast.makeText(
                context,
                context.getString(R.string.chat_message_edit_completed),
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    LaunchedEffect(checkpointViewModel, sessionId) {
        checkpointViewModel.events.collect { event ->
            when (event) {
                is ChatCheckpointEvent.RollbackSuccess -> {
                    dismissedRollbackBannerKey = null
                    showRewindSheet = false
                    viewModel.insertLocalSystemMessage(
                        context.getString(
                            R.string.checkpoint_rollback_summary,
                            event.truncatedCount,
                        ),
                    )
                    viewModel.loadSession(sessionId, forceRefresh = true)
                }
                is ChatCheckpointEvent.RollbackPartialSuccess -> {
                    dismissedRollbackBannerKey = null
                    showRewindSheet = false
                    viewModel.insertLocalSystemMessage(
                        context.getString(
                            R.string.checkpoint_rollback_summary,
                            event.truncatedCount,
                        ),
                    )
                    android.widget.Toast.makeText(
                        context,
                        event.warningMessage,
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                    viewModel.loadSession(sessionId, forceRefresh = true)
                }
                is ChatCheckpointEvent.UnrevertSuccess -> {
                    viewModel.loadSession(sessionId, forceRefresh = true)
                }
                is ChatCheckpointEvent.UnrevertPartialSuccess -> {
                    android.widget.Toast.makeText(
                        context,
                        event.warningMessage,
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                    viewModel.loadSession(sessionId, forceRefresh = true)
                }
                is ChatCheckpointEvent.AgentRunRollbackSuccess -> {
                    android.widget.Toast.makeText(
                        context,
                        if (event.cascadedRunCount > 0)
                            context.getString(R.string.checkpoint_agent_run_rollback_success) + " — " +
                            context.getString(R.string.checkpoint_agent_run_rollback_cascade_hint, event.cascadedRunCount)
                        else
                            context.getString(R.string.checkpoint_agent_run_rollback_success),
                        android.widget.Toast.LENGTH_SHORT,
                    ).show()
                }
                is ChatCheckpointEvent.AgentRunRollbackNoChanges -> {
                    android.widget.Toast.makeText(context, event.message, android.widget.Toast.LENGTH_SHORT).show()
                }
                is ChatCheckpointEvent.Error -> { }
            }
        }
    }

    LaunchedEffect(Unit) {
        viewModel.checkpointStreamEvents.collect { event ->
            when (event) {
                is ConversationViewModel.CheckpointStreamEvent.Failed -> {
                    checkpointViewModel.reportCheckpointFailure(event.sessionId)
                    val health = checkpointViewModel.getCheckpointHealth(event.sessionId)
                    if (health == com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth.WARNING) {
                        android.widget.Toast.makeText(
                            context,
                            context.getString(R.string.checkpoint_create_failed_hint),
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                    } else if (health == com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth.ERROR) {
                        android.widget.Toast.makeText(
                            context,
                            context.getString(R.string.checkpoint_create_fail_warning),
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
                is ConversationViewModel.CheckpointStreamEvent.Success -> {
                    checkpointViewModel.reportCheckpointSuccess(event.sessionId)
                }
            }
        }
    }

    LaunchedEffect(resourceReferences) {
        if (resourceReferences.isNotEmpty()) {
            val maxRefs = WorkbenchUiState.MAX_DELEGATION_REFERENCES
            val newRefs = resourceReferences.filter { ref -> activeResourceRefs.none { it.id == ref.id } }
            if (newRefs.isNotEmpty() && activeResourceRefs.size + newRefs.size <= maxRefs) {
                activeResourceRefs = activeResourceRefs + newRefs
            }
            onResourceReferencesConsumed()
        }
    }

    val wasSending = remember { mutableStateOf(false) }
    LaunchedEffect(state.isSending) {
        if (wasSending.value && !state.isSending) {
            currentOnSessionUpdated(null, state.messages.size)
        }
        wasSending.value = state.isSending
    }

    // isNearBottom: only auto-scroll when user is near the bottom of the list
    val isNearBottom = remember(sessionId, focusMessageId) { mutableStateOf(focusMessageId.isBlank()) }
    val isPinnedToBottom = remember(sessionId, focusMessageId) { mutableStateOf(focusMessageId.isBlank()) }
    // 「用户手指是否真的在拖列表」。不能用 isScrollInProgress 代替：流式贴底、发消息后
    // 跳转、回到底部按钮都会把它置真。userOwnsScroll 覆盖拖动手势后的惯性，用来在
    // 手指离开后提交一次 pin，避免甩到底却仍被当成未贴底。
    var isUserDraggingList by remember(sessionId) { mutableStateOf(false) }
    var userOwnsScroll by remember(sessionId) { mutableStateOf(false) }
    val pendingScroll = remember(sessionId) { mutableStateOf(false) }
    val pendingLoadMoreAnchor = remember(sessionId) { mutableStateOf<Pair<String, Int>?>(null) }
    val isLoadingMoreRef = remember(sessionId) { mutableStateOf(false) }
    val prevMessageCount = remember(sessionId) { mutableStateOf(state.messages.size) }
    var hasSettledInitialPosition by remember(sessionId, focusMessageId) { mutableStateOf(false) }
    // 缓存历史和服务端权威历史会在首屏连续抵达。两者交接完成前，不能把消息数变化
    // 当成「新消息」来平滑滚动，否则用户会先看到一段从顶部追到底部的动画。
    var hasSettledInitialHistory by remember(sessionId, focusMessageId) { mutableStateOf(false) }
    var highlightedMessageId by remember(sessionId, focusMessageId) { mutableStateOf<String?>(null) }
    var focusResolved by remember(sessionId, focusMessageId) { mutableStateOf(focusMessageId.isBlank()) }

    LaunchedEffect(sessionId, focusMessageId) {
        if (focusMessageId.isBlank()) return@LaunchedEffect
        isNearBottom.value = false
        isPinnedToBottom.value = false
        pendingScroll.value = false
        val rowId = viewModel.focusMessage(sessionId, focusMessageId)
        if (rowId != null) {
            highlightedMessageId = rowId
            val focusedState = viewModel.uiState.first { ui -> ui.messages.any { it.id == rowId } }
            val index = focusedState.messages.indexOfFirst { it.id == rowId }
            if (index >= 0) {
                delay(50)
                listState.scrollToItem(index)
            }
            focusResolved = true
            delay(1_800)
            if (highlightedMessageId == rowId) highlightedMessageId = null
        } else {
            isNearBottom.value = true
            isPinnedToBottom.value = true
            val latest = viewModel.uiState.value.messages
            if (latest.isNotEmpty()) listState.scrollToConversationEnd(settleLayout = true)
            focusResolved = true
            android.widget.Toast.makeText(
                context,
                context.getString(R.string.notification_message_unavailable_fallback),
                android.widget.Toast.LENGTH_LONG,
            ).show()
        }
    }

    LaunchedEffect(state.messages.size) {
        val countIncreased = state.messages.size > prevMessageCount.value
        if (
            countIncreased &&
            state.messages.isNotEmpty() &&
            focusMessageId.isBlank() &&
            !state.isLoading &&
            hasSettledInitialPosition &&
            hasSettledInitialHistory &&
            !isLoadingMoreRef.value &&
            (isPinnedToBottom.value || state.messages.lastOrNull()?.isUser == true)
        ) {
            pendingScroll.value = true
        }
        prevMessageCount.value = state.messages.size
    }

    // 会话首屏：缓存与权威历史可能 size 相同但 id 不同——用 id 序列而非整表 messages。
    // 流式正文变长时禁止本路 settle；贴底只走末条尾边微调。
    val messageIdentityKey = remember(state.messages) {
        ConversationStreamScrollPolicy.messageIdentityKey(state.messages.map { it.id })
    }
    LaunchedEffect(sessionId, focusMessageId, state.isLoading, messageIdentityKey) {
        if (
            !ConversationStreamScrollPolicy.shouldRunInitialSettle(
                focusMessageIdBlank = focusMessageId.isBlank(),
                hasMessages = state.messages.isNotEmpty(),
                isLoadingMore = isLoadingMoreRef.value,
                isStreaming = state.isStreaming,
                hasSettledInitialPosition = hasSettledInitialPosition,
                hasSettledInitialHistory = hasSettledInitialHistory,
            )
        ) {
            return@LaunchedEffect
        }
        if ((!hasSettledInitialPosition || isPinnedToBottom.value) && !listState.isScrollInProgress) {
            listState.scrollToConversationEnd(settleLayout = true)
            val isAtEnd = listState.isNearConversationEnd(readingBottomSlackPx)
            isNearBottom.value = isAtEnd
            isPinnedToBottom.value = isAtEnd
            hasSettledInitialPosition = true
            if (!state.isLoading) hasSettledInitialHistory = true
        }
    }
    // 已 pin 则每帧把末条尾边拉进视口，对齐 iOS contentSize→setOffsetToBottom。
    // 不订阅 layoutInfo：scrollBy 会改 offset，snapshotFlow 会打断自己。
    LaunchedEffect(listState, state.isStreaming) {
        while (true) {
            withFrameNanos { }
            val streaming = latestState.isStreaming || latestState.messages.any { it.isStreaming }
            if (!streaming) return@LaunchedEffect
            if (
                !ConversationStreamScrollPolicy.shouldFollowStreamingTail(
                    pinned = isPinnedToBottom.value,
                    isLoadingMore = isLoadingMoreRef.value,
                    isUserDragging = isUserDraggingList,
                    isStreaming = true,
                )
            ) {
                continue
            }
            listState.scrollConversationTrailingEdgeIntoView()
        }
    }
    // 流式收束后高度可能因 Streaming→终态 Markdown 切换变化一次，pin 时补一次微调。
    var wasStreaming by remember(sessionId) { mutableStateOf(false) }
    LaunchedEffect(state.isStreaming) {
        val ended = wasStreaming && !state.isStreaming
        wasStreaming = state.isStreaming
        if (
            ended &&
            isPinnedToBottom.value &&
            !isLoadingMoreRef.value &&
            state.messages.isNotEmpty()
        ) {
            listState.scrollToConversationEnd(trailingOnly = true)
        }
    }
    LaunchedEffect(state.isLoadingMore) {
        val wasLoading = isLoadingMoreRef.value
        isLoadingMoreRef.value = state.isLoadingMore
        if (wasLoading && !state.isLoadingMore && state.messages.isNotEmpty()) {
            val anchor = pendingLoadMoreAnchor.value
            pendingLoadMoreAnchor.value = null
            if (anchor != null) {
                val (anchorKey, anchorOffset) = anchor
                val anchorIndex = state.messages.indexOfFirst { it.id == anchorKey }
                if (anchorIndex >= 0) {
                    listState.scrollToItem(anchorIndex, anchorOffset)
                    prevMessageCount.value = state.messages.size
                    return@LaunchedEffect
                }
            }
            val prepended = state.messages.size - prevMessageCount.value
            if (prepended > 0) {
                val loadingOffset = if (state.hasMore) 1 else 0
                listState.scrollToItem(prepended + loadingOffset)
            }
        }
    }
    LaunchedEffect(pendingScroll.value) {
        if (pendingScroll.value) {
            delay(200)
            try {
                listState.scrollToConversationEnd(animated = true, settleLayout = true)
            } finally {
                pendingScroll.value = false
            }
        }
    }

    // Track isNearBottom + dismiss keyboard + load more via stable snapshotFlow
    LaunchedEffect(listState) {
        snapshotFlow {
            !listState.canScrollForward
        }.collect { nearBottom ->
            isNearBottom.value = nearBottom
            val streaming = latestState.isStreaming || latestState.messages.any { it.isStreaming }
            if (!ConversationStreamScrollPolicy.shouldUpdatePinFromStrictEnd(streaming)) {
                return@collect
            }
            isPinnedToBottom.value = ConversationStreamScrollPolicy.nextPinnedToBottom(
                currentlyPinned = isPinnedToBottom.value,
                nearBottom = nearBottom,
                isStreaming = false,
                isUserDragging = isUserDraggingList,
                userScrollSettled = false,
            )
        }
    }

    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }
            .collect { if (it) keyboardController?.hide() }
    }

    // 键盘弹起会把可视区压矮，而 LazyColumn 是顶部锚定的：原本贴底的话，最新消息会被
    // 推出视野——用户点开输入框正是要回复它。原本停在底部就跟着贴回底部（对齐 iOS 的
    // 「inset 变化后维持贴底」）。停在历史里读的人不动，不抢他的位置。
    @OptIn(ExperimentalLayoutApi::class)
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(imeVisible) {
        if (imeVisible && hasSettledInitialPosition && isPinnedToBottom.value) {
            // 等键盘弹出动画把视口压到位再贴底。settleLayout 每次只等一帧，而键盘动画有
            // 两百多毫秒——中途定位会按还在变的视口算，尾部照样被压住一截。
            delay(ImeSettleDelayMillis)
            listState.scrollToConversationEnd(settleLayout = true)
        }
    }

    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> {
                    isUserDraggingList = true
                    userOwnsScroll = true
                }
                is DragInteraction.Stop, is DragInteraction.Cancel -> isUserDraggingList = false
            }
        }
    }

    // 翻消息即收敛、回到最新即展开；具体收不收还要过 Composer 里的内容层判据。
    //
    // 只在两个**边沿**上决策，不订阅贴底状态本身——那是抖动的根：Android 的输入区是
    // 列表下方的一行（不是悬浮层），收敛让它变矮 → 列表视口变高 → 内容装得下了 →
    // 判成贴底 → 展开 → 视口又变矮 → 判成没贴底 → 再收敛，静止时也能自己转起来。
    //   · 手指开始拖 → 收敛（此后收敛引起的布局变化不再回头改状态）
    //   · 手离开且惯性 / 程序滚动都停了 → 取一次贴底快照，决定展开还是继续收着
    // 中间的「非用户滚动进行中」一律不动状态。
    //
    // 首屏定位完成前不参与：此时列表还停在顶部，照实读会让输入区在进入会话那一帧先收后展。
    LaunchedEffect(listState, readingBottomSlackPx) {
        snapshotFlow {
            isUserDraggingList to (isUserDraggingList || listState.isScrollInProgress)
        }.collect { (dragging, scrollActive) ->
            if (!hasSettledInitialPosition) return@collect
            if (dragging) {
                val atEnd = listState.isNearConversationEnd(readingBottomSlackPx)
                isNearBottom.value = atEnd
                isPinnedToBottom.value = ConversationStreamScrollPolicy.nextPinnedToBottom(
                    currentlyPinned = isPinnedToBottom.value,
                    nearBottom = atEnd,
                    isStreaming = latestState.isStreaming || latestState.messages.any { it.isStreaming },
                    isUserDragging = true,
                    userScrollSettled = false,
                )
                composerCollapsedForReading = ComposerReadingCollapsePolicy.scrollWantsCollapse(
                    MessageListScrollState(isUserScrolling = true, isAtBottom = false),
                )
            } else if (!scrollActive) {
                val atEnd = listState.isNearConversationEnd(readingBottomSlackPx)
                if (userOwnsScroll) {
                    isNearBottom.value = atEnd
                    isPinnedToBottom.value = ConversationStreamScrollPolicy.nextPinnedToBottom(
                        currentlyPinned = isPinnedToBottom.value,
                        nearBottom = atEnd,
                        isStreaming = latestState.isStreaming || latestState.messages.any { it.isStreaming },
                        isUserDragging = false,
                        userScrollSettled = true,
                    )
                    userOwnsScroll = false
                }
                composerCollapsedForReading = ComposerReadingCollapsePolicy.scrollWantsCollapse(
                    MessageListScrollState(
                        isUserScrolling = false,
                        isAtBottom = atEnd,
                    ),
                )
            }
        }
    }

    // 展开 = 判定用户已经滑回最新，此时补一次贴底：一来展开会把视口重新压矮、末条消息
    // 会被输入区盖住一截，二来 96dp 容差本就允许「差一点点」也算到底，不补的话用户还得
    // 再拨一下。顺手把 pinned 置真，让随后的流式继续跟着贴底（与「回到底部」按钮同口径）。
    // 这次程序滚动不会反过来触发收敛——收敛只认用户拖动。
    //
    // 等一两帧让 footer 实测高度 / contentPadding 落定；若已经不能再往前滚，就别再贴底——
    // 否则 scrollToItem(末条) 会先把末条甩到视口顶再 scrollBy 拉回，贴底瞬间看起来像弹一下。
    LaunchedEffect(composerCollapsedForReading) {
        if (!composerCollapsedForReading && hasSettledInitialPosition) {
            isNearBottom.value = true
            isPinnedToBottom.value = true
            withFrameNanos { }
            withFrameNanos { }
            if (listState.canScrollForward) {
                listState.scrollToConversationEnd(settleLayout = true)
            }
        }
    }

    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex }
            .collect { firstVisible ->
                val current = latestState
                if (
                    current.hasMore &&
                    !current.isLoadingMore &&
                    !current.isLoading &&
                    !current.isStreaming &&
                    current.messages.none { it.isStreaming } &&
                    focusResolved &&
                    pendingLoadMoreAnchor.value == null &&
                    firstVisible <= 1
                ) {
                    val anchorInfo = listState.layoutInfo.visibleItemsInfo
                        .firstOrNull { it.key != "__loading_more__" }
                    val anchorKey = anchorInfo?.key as? String
                    if (anchorKey != null) {
                        pendingLoadMoreAnchor.value = anchorKey to (anchorInfo.offset)
                    }
                    viewModel.loadMore()
                }
            }
    }

    LaunchedEffect(wsState) {
        if (wsState is com.tabtin.mobile.data.websocket.WSConnectionState.Connected ||
            wsState is com.tabtin.mobile.data.websocket.WSConnectionState.Disconnected) {
            isManualReconnecting = false
        }
    }

    androidx.compose.runtime.CompositionLocalProvider(
        LocalSubagentCancelHandler provides { runId -> viewModel.cancelSubagent(runId) },
    ) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .navigationBarsPadding()
            .imePadding(),
    ) {
        ConnectionStatusBar(
            state = wsState,
            resumeResult = resumeResult,
            isManualReconnecting = isManualReconnecting,
            onReconnect = {
                if (!isManualReconnecting) {
                    isManualReconnecting = true
                    viewModel.webSocketService.reconnectIfNeeded()
                }
            },
            onRelogin = {
                com.tabtin.mobile.data.api.AuthEventBus.emitLogoutRequired()
            },
        )

        if (state.connectionInterrupted) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning))
                    .padding(vertical = TTSpacing.xs, horizontal = TTSpacing.md),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                )
                Text(
                    text = "连接中断，正在恢复本轮消息",
                    color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(start = TTSpacing.xs),
                )
            }
        }

        checkpointState.rollbackState
            ?.takeUnless {
                it.lastOperationMode == "editAndResend" ||
                    rollbackBannerKey(it) == dismissedRollbackBannerKey
            }
            ?.let { rollbackState ->
            RevertBanner(
                rollbackState = rollbackState,
                isExecuting = checkpointState.isExecuting,
                onUnrevert = { checkpointViewModel.executeUnrevert(sessionId) },
                onRetryResources = {
                    checkpointViewModel.retryFailedResources(sessionId)
                },
                onViewHistory = {
                    checkpointViewModel.loadRevertHistory(sessionId)
                    showHistorySheet = true
                },
                isRetrying = checkpointState.isRetrying,
                onDismiss = { dismissedRollbackBannerKey = rollbackBannerKey(rollbackState) },
                fileRestoreStatus = checkpointState.lastFileRestoreStatus,
                fileRestoreReason = checkpointState.lastFileRestoreReason,
                failedFiles = checkpointState.lastFailedFiles,
            )
        }

        if (state.agentTodos.isNotEmpty()) {
            TodoPanelView(
                todos = state.agentTodos,
                paused = !state.isStreaming,
                awaitingSubagents = TodoStripPresentation.awaitingSubagents(state.messages),
            )
        }

        // 输入区（含 HITL 面板 / 队列条 / 横幅）作为**悬浮层**压在消息列表之上，列表保持
        // 全高：内容能滚到输入区下方经过，贴底时最后一条又停在输入区上方——这是「浮起来
        // 的一层」与「列表下面的一行」的分水岭，也是收敛胶囊悬浮感的来源。对齐 iOS：那边
        // 由 MessageListView 的 bottom overlay + contentInset 实现，这里用 Box overlay +
        // contentPadding，实测 footer 高度是两端共用的同一个量。
        //
        // 顺带解掉一个耦合：收敛/展开不再改变列表视口高度，只改 contentPadding，收敛引起
        // 的布局变化更难反噬贴底判据。
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
        if (state.isLoading && state.messages.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else if (state.messages.isEmpty() && !state.compactionInProgress) {
            EmptyConversation(modifier = Modifier.fillMaxSize())
        } else {
            val showScrollToBottom = remember { derivedStateOf { listState.canScrollForward } }
            val formalMediaArtifactToolUseIds = remember(state.messages) {
                state.messages
                    .asSequence()
                    .flatMap { it.richContentBlocks.asSequence() }
                    .filter { it.kind == "image" && !it.fileId.isNullOrBlank() }
                    .mapNotNull { it.sourceToolUseId?.takeIf(String::isNotBlank) }
                    .toSet()
            }
            val conversationRenderUnits = remember(state.messages) {
                groupConversationRenderUnits(state.messages)
            }
            Box(modifier = Modifier.fillMaxSize()) {
                val concealUntilInitialPositioned =
                    focusMessageId.isBlank() && !hasSettledInitialPosition
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .alpha(if (concealUntilInitialPositioned) 0f else 1f),
                    state = listState,
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
                    contentPadding = PaddingValues(
                        start = TTSpacing.lg,
                        end = TTSpacing.lg,
                        top = TTSpacing.md,
                        // 贴底时最后一条消息要停在悬浮输入区上方；再加羽化可读重叠
                        // （ComposerTopScrimReadableOverlap），对齐 iOS bottomContentInset。
                        bottom = TTSpacing.md + composerFooterHeight + ComposerTopScrimReadableOverlap,
                    ),
                    userScrollEnabled = true,
                ) {
                    if (state.isLoadingMore) {
                        item(key = "__loading_more__", contentType = "loading") {
                            Box(Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                            }
                        }
                    }
                    items(
                        items = conversationRenderUnits,
                        key = { it.key },
                        contentType = { unit ->
                            when (unit) {
                                is ConversationRenderUnit.StepGroup -> "step_group"
                                is ConversationRenderUnit.Single -> when {
                                    unit.message.isSystem -> "system"
                                    unit.message.isUser -> "user"
                                    else -> "assistant"
                                }
                            }
                        },
                    ) { unit ->
                        if (unit is ConversationRenderUnit.StepGroup) {
                            val groupItems = unit.messages.flatMap { message ->
                                assistantTimelineItems(message, message.displayContent)
                                    .filter(ExecutionStepPresentation::isExecutionStep)
                            }
                            ExecutionGroupRow(
                                items = groupItems,
                                isStreaming = unit.messages.any { it.isStreaming },
                                isLastGroupInTimeline = unit.key == conversationRenderUnits.lastOrNull()?.key,
                            )
                            return@items
                        }
                        val message = (unit as ConversationRenderUnit.Single).message
                        val index = unit.index
                        // 对齐 Electron SystemMessageRenderer：压缩检查点 History pill，禁止摘要正文。
                        if (message.isCompactionSummary) {
                            CompactionStatusPill(inProgress = false)
                            return@items
                        }
                        // 后台任务完成通知：伪用户消息 → 系统通知卡，不裸显 XML。
                        if (message.isPushNotification) {
                            PushNotificationBubble(message = message)
                            return@items
                        }
                        // 系统消息走独立的居中胶囊样式（对齐 iOS / Electron），
                        // 不进入 ChatBubble 的 user / assistant 分支。
                        if (message.isSystem) {
                            SystemMessageBubble(message = message)
                            return@items
                        }

                        // Wave 4 S2/A2：用户消息处于编辑状态时，整个 bubble 替换为 textarea +
                        // Cancel/Send 按钮，不再走 ChatBubble。其他消息照常走 wrapper + ChatBubble。
                        if (message.isUser && state.editingMessage?.messageId == message.id) {
                            UserMessageEditMode(
                                initialContent = state.editingMessage?.originalContent.orEmpty(),
                                keptBlocks = state.editingMessage?.originalBlocks.orEmpty(),
                                isSubmitting = state.isSending || state.isStreaming || state.editResend != null,
                                onCancel = { viewModel.cancelEditMessage() },
                                onSubmit = { newContent ->
                                    viewModel.submitEditMessage(newContent)
                                    isNearBottom.value = true
                                    isPinnedToBottom.value = true
                                },
                            )
                            return@items
                        }

                        // 与 Electron 一致：历史 assistant 消息可先进入回退预览，
                        // 实际能恢复的文件/资源范围由 preview API 的权威结果决定。
                        // checkpoint_record 是可选的展示元数据，不能因为历史同步没有
                        // 携带它而把回退入口隐藏掉。
                        val canRewind = message.isAssistant &&
                            !message.isStreaming &&
                            !state.isStreaming
                        val sessionHealth = checkpointHealthMap[sessionId]
                            ?: com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth.HEALTHY
                        val assistantFace = if (
                            MessageListSameTurnPolicy.shouldHideAgentIdentity(state.messages, index)
                        ) {
                            null
                        } else {
                            message.agentId?.let { agentId ->
                                state.messageAgentFacesById[agentId]
                                    ?: AgentFace(
                                        name = "Agent",
                                        avatarKey = AgentAvatarPreset.GENERAL_ASSISTANT.key,
                                    )
                            }
                        }

                        // Wave 4 A1/A2：用户消息仍由外层 wrapper 提供「编辑 + 复制」；
                        // 助手消息的「复制」已合并进 ChatBubble 自身的 rewind 菜单，避免
                        // 外层 combinedClickable 与内层 rewind combinedClickable 抢长按手势。
                        // Wave 6 A3：仅对已持久化、非流式消息允许 fork（fork API 需要后端
                        // 能定位到消息）。null handler → ChatBubble / MessageContextMenuHost
                        // 菜单里不会出现 Fork 项，避免死按钮（Wave 3 反思教训）。
                        val canForkMessage = onForkFromMessage != null &&
                            message.createdAt != null &&
                            !message.isStreaming
                        val forkHandler: (() -> Unit)? = if (canForkMessage) {
                            { viewModel.requestForkFromMessage(message.effectiveId) }
                        } else null

                        if (message.isUser) {
                            MessageContextMenuHost(
                                message = message,
                                canEditMessage = !message.isCompactionSummary &&
                                    !message.isPushNotification &&
                                    message.createdAt != null &&
                                    !state.isSending &&
                                    !state.isStreaming,
                                onEdit = { messageId -> viewModel.beginEditMessage(messageId) },
                                onForkFromMessage = forkHandler,
                                onQuoteMessage = {
                                    MessageQuote.replacingComposerQuote(inputText, message)?.let { inputText = it }
                                },
                            ) {
                                ChatBubble(
                                    message = message,
                                    assistantFace = assistantFace,
                                    isHighlighted = highlightedMessageId == message.id,
                                    currentSpaceId = spaceId,
                                    currentOrganizationId = organizationId,
                                    onOpenInWorkbench = onOpenInWorkbench,
                                    formalMediaArtifactToolUseIds = formalMediaArtifactToolUseIds,
                                    currentPhase = if (message.isStreaming) state.currentPhase else AgentPhase.IDLE,
                                    currentToolName = if (message.isStreaming) state.currentToolName else null,
                                    canRewind = canRewind,
                                    onRewindToHere = if (canRewind) {
                                        {
                                            checkpointViewModel.loadPreview(sessionId, message.effectiveId)
                                            showRewindSheet = true
                                        }
                                    } else null,
                                    onRollbackAgentRun = if (!message.agentRunId.isNullOrEmpty()) {
                                        { agentRunId -> checkpointViewModel.rollbackAgentRun(agentRunId) }
                                    } else null,
                                    checkpointHealth = sessionHealth,
                                    onNavigateToWallet = onNavigateToWallet,
                                    onNoticeAction = { noticeType ->
                                        val prompt = when (noticeType) {
                                            "approval_expired" -> context.getString(R.string.chat_notice_approval_expired_retry)
                                            else -> context.getString(R.string.chat_notice_max_iterations_continue)
                                        }
                                        viewModel.sendMessage(prompt)
                                    },
                                    onStartNewSession = onStartNewSession,
                                    onRelogin = onRelogin,
                                    // user 消息的 Fork 入口在 MessageContextMenuHost，这里传 null
                                    // 避免 ChatBubble 重复渲染（ChatBubble 对 user 分支本就不渲染菜单，
                                    // 但显式传 null 表明意图）。
                                    onForkFromMessage = null,
                                    onExecutePlan = viewModel::executePlanProposal,
                                    onApproveModeSwitch = viewModel::approveModeSwitch,
                                    onIgnoreProposal = viewModel::ignoreProposal,
                                )
                            }
                        } else {
                            ChatBubble(
                                message = message,
                                assistantFace = assistantFace,
                                isHighlighted = highlightedMessageId == message.id,
                                currentSpaceId = spaceId,
                                currentOrganizationId = organizationId,
                                onOpenInWorkbench = onOpenInWorkbench,
                                formalMediaArtifactToolUseIds = formalMediaArtifactToolUseIds,
                                currentPhase = if (message.isStreaming) state.currentPhase else AgentPhase.IDLE,
                                currentToolName = if (message.isStreaming) state.currentToolName else null,
                                canRewind = canRewind,
                                onRewindToHere = if (canRewind) {
                                    {
                                        checkpointViewModel.loadPreview(sessionId, message.effectiveId)
                                        showRewindSheet = true
                                    }
                                } else null,
                                onRollbackAgentRun = if (!message.agentRunId.isNullOrEmpty()) {
                                    { agentRunId -> checkpointViewModel.rollbackAgentRun(agentRunId) }
                                } else null,
                                checkpointHealth = sessionHealth,
                                onNavigateToWallet = onNavigateToWallet,
                                onNoticeAction = { noticeType ->
                                    val prompt = when (noticeType) {
                                        "approval_expired" -> context.getString(R.string.chat_notice_approval_expired_retry)
                                        else -> context.getString(R.string.chat_notice_max_iterations_continue)
                                    }
                                    viewModel.sendMessage(prompt)
                                },
                                onStartNewSession = onStartNewSession,
                                onRelogin = onRelogin,
                                onForkFromMessage = forkHandler,
                                onQuoteMessage = {
                                    MessageQuote.replacingComposerQuote(inputText, message)?.let { inputText = it }
                                },
                                onExecutePlan = viewModel::executePlanProposal,
                                onApproveModeSwitch = viewModel::approveModeSwitch,
                                onIgnoreProposal = viewModel::ignoreProposal,
                            )
                        }
                    }
                    if (state.compactionInProgress) {
                        item(key = "__compaction_in_progress__", contentType = "compaction") {
                            CompactionStatusPill(inProgress = true)
                        }
                    }
                }
                if (concealUntilInitialPositioned) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                // 列表下沿的渐隐带：消息滚到输入区附近时淡进底色，而不是被硬边切断——
                // 让输入区读起来是「浮在内容之上」的一层。与 iOS ttComposerTopScrim 对齐。
                // 渐隐带贴在悬浮输入区的上沿：内容滚近时淡进底色，而不是被硬边切断。
                // 停靠点与末档不透明度见 ComposerTopScrimStops——末档必须与 footer 底色
                // 同值，否则交界处会切出一条亮边。
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .padding(bottom = composerFooterHeight)
                        .height(ComposerTopScrimHeight)
                        .background(
                            Brush.verticalGradient(
                                colorStops = ComposerTopScrimStops
                                    .map { (stop, alpha) -> stop to composerSurfaceColor.copy(alpha = alpha) }
                                    .toTypedArray(),
                            ),
                        ),
                )
                if (hasSettledInitialPosition && showScrollToBottom.value) {
                    val scrollScope = rememberCoroutineScope()
                    IconButton(
                        onClick = {
                            isNearBottom.value = true
                            isPinnedToBottom.value = true
                            scrollScope.launch {
                                listState.scrollToConversationEnd(animated = true, settleLayout = true)
                            }
                        },
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(
                                end = TTSpacing.md,
                                bottom = TTSpacing.md + composerFooterHeight,
                            )
                            .size(36.dp)
                            .shadow(4.dp, CircleShape)
                            .clip(CircleShape)
                            .background(ttColor(TTColors.Background, TTColors.Dark.Background)),
                    ) {
                        Icon(
                            Icons.Default.KeyboardArrowDown,
                            contentDescription = stringResource(R.string.common_scroll_to_bottom),
                            modifier = Modifier.size(20.dp),
                            tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                    }
                }
            }
        }

        // ——— 悬浮输入区：贴底对齐，实测高度回填给列表 contentPadding ———
        // 铺满底色（不是透明）：卡片两侧与下方那圈空隙若透出滚动内容，输入区就不再是
        // 「一层」，而是几块碎片；上沿的渐隐带正是渐变到这个底色，两者必须同色。
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(composerSurfaceColor.copy(alpha = ComposerSurfaceAlpha))
                .onSizeChanged { composerFooterHeightPx = it.height },
        ) {
        state.errorMessage?.let { error ->
            Snackbar(
                modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
                action = {
                    TextButton(onClick = { viewModel.dismissError() }) {
                        Text(stringResource(R.string.common_close), color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary))
                    }
                },
                containerColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                contentColor = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
            ) {
                Text(error)
            }
        }

        state.pendingReview?.let { review ->
            ReviewPanelView(
                request = review,
                isSubmitting = state.hitlSubmitting,
                onApprove = { viewModel.submitReview("approve") },
                onReject = { viewModel.submitReview("reject") },
                modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
            )
        }

        // Wave 4 I8 legacy：plan_approval_required 事件触发（plan-approval 整套已下线，
        // runtime 不再发该事件，但保留 UI 入口让历史 trace replay / 旧设备发的事件仍能渲染）。
        // 出站走 localrt.plan_approval_response，outcome ∈ {approved/rejected/cancelled}。
        // v0.4 W1.5-轮 4 起，approval_requested 仅承载 tool_permission（plan_exit 已删）。
        state.pendingPlanApproval?.let { pending ->
            PlanApprovalPanelView(
                pending = pending,
                isSubmitting = state.hitlSubmitting,
                onApprove = { viewModel.submitPlanApproval("approved") },
                onReject = { viewModel.submitPlanApproval("rejected") },
                onCancel = { viewModel.dismissPlanApproval() },
                onOpenPlan = { planDocId ->
                    openPlanDocument(
                        context = context,
                        planDocumentId = planDocId,
                        organizationId = organizationId,
                        spaceId = spaceId,
                    )
                },
                modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
            )
        }

        // v0.4 W1.5-轮 4：批量审批面板（仅 tool_permission；plan_exit 已删除）。
        // 接收 approval_requested batch 事件，渲染 N 条 actionRequest，整批同 outcome 提交。
        // 老 plan_approval_required 事件仍走上面的 PlanApprovalPanelView（legacy 路径）。
        state.pendingApproval?.let { approval ->
            if (approval.resolutionAccess.canResolve) {
                ApprovalPanelView(
                    pending = approval,
                    isSubmitting = state.hitlSubmitting,
                    onSubmit = { outcome, scope -> viewModel.submitApproval(outcome, scope) },
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
            } else {
                HitlReadonlyPanel(
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
            }
        }

        // W4 (2026-05-11): ask 三件套合一为单 ask_user。
        // 删除 AskUserFieldsPanelView / AskUserFieldsFallbackPanelView，只剩 questions[] 单形态。
        state.pendingAskUser?.let { askUser ->
            if (askUser.resolutionAccess.canResolve) {
                AskUserPanelView(
                    title = askUser.title,
                    questions = askUser.questions,
                    isSubmitting = state.hitlSubmitting,
                    onSubmit = { answers -> viewModel.submitAskUser(answers) },
                    onSkip = { viewModel.skipAskUser() },
                    modifier = Modifier.weight(1f, fill = false),
                )
            } else {
                HitlReadonlyPanel(
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
            }
        }

        state.pendingAskForm?.let { askForm ->
            if (askForm.resolutionAccess.canResolve) {
                AskFormPanelView(
                    request = askForm.request,
                    isSubmitting = state.hitlSubmitting,
                    onSubmit = { values -> viewModel.submitAskForm(values) },
                    onSkip = { viewModel.skipAskForm() },
                    modifier = Modifier
                        .weight(1f, fill = false)
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
            } else {
                HitlReadonlyPanel(
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
            }
        }

        state.pendingRequestApproval?.let { approval ->
            if (approval.resolutionAccess.canResolve) {
                RequestApprovalPanelView(
                    request = approval.request,
                    isSubmitting = state.hitlSubmitting,
                    onSubmit = { approved -> viewModel.submitRequestApproval(approved) },
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
            } else {
                HitlReadonlyPanel(
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
            }
        }

        // Wave 6 A6：@提及候选弹窗。贴在 Composer 上方，输入 `@` 后触发；
        // 命中资源插入 activeResourceRefs（与 WorkbenchSheet 注入同口径）。
        // 触发判定基于 inputText 末尾（单行 Composer，游标≈末端），参考 iOS 做的最简化版。
        val mentionTrigger = remember(inputText) { detectMentionTrigger(inputText) }
        if (mentionTrigger != null) {
            val limitReachedTemplate = stringResource(
                R.string.chat_mention_limit_reached,
                WorkbenchUiState.MAX_DELEGATION_REFERENCES,
            )
            val alreadyAddedMsg = stringResource(R.string.chat_mention_already_added)
            MentionPopover(
                open = true,
                query = mentionTrigger.query,
                resources = mentionableResources,
                isLoading = mentionableResourcesLoading,
                onSelect = { resource ->
                    // Wave 6 产品/用户 Review P0-2：把"添加 ref"和"清理 @ 片段"解耦。
                    // 之前无论是否成功加入都删 @ 文本——上限已满或重复点同资源时会出现
                    // "chip 没变、@ 字被吞"的诡异现象。现在：仅成功才清文本；失败给 Toast。
                    val ref = ResourceReference.from(resource)
                    val maxRefs = WorkbenchUiState.MAX_DELEGATION_REFERENCES
                    val duplicated = activeResourceRefs.any { it.id == ref.id }
                    val overLimit = activeResourceRefs.size >= maxRefs

                    val failureMessage: String? = when {
                        duplicated -> alreadyAddedMsg
                        overLimit -> limitReachedTemplate
                        else -> null
                    }

                    if (failureMessage != null) {
                        android.widget.Toast.makeText(
                            context,
                            failureMessage,
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                        return@MentionPopover
                    }

                    activeResourceRefs = activeResourceRefs + ref
                    // 成功加入才清理 text 里的 @query 片段。
                    val before = inputText.substring(0, mentionTrigger.atIndex)
                    val afterStart = (mentionTrigger.atIndex + 1 + mentionTrigger.query.length)
                        .coerceAtMost(inputText.length)
                    val after = inputText.substring(afterStart)
                    inputText = (before + after).trimEnd()
                },
                onDismiss = { /* 交给 detectMentionTrigger 下一次重算自动隐藏 */ },
            )
        }

        if (state.billingBlocked) {
            BillingBlockedBanner(
                onNavigateToWallet = onNavigateToWallet,
                modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
            )
        }

        if (state.memberLimitBlocked && !state.billingBlocked) {
            MemberLimitBanner(
                reason = state.memberLimitReason,
                modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
            )
        }

        // 对话面不再挂 AgentRunDock：运行态已在气泡时间轴呈现，停止走 Composer 主按钮
        //（对齐 Electron / iOS，避免底栏状态条与气泡/停止双重冗余）。

        OutgoingQueueStrip(
            messages = state.queuedOutgoingMessages,
            // 与 iOS 对齐：仅 Agent 忙（活跃 run / 流式 / 取消中）才展示 waiting 条带；
            // 不含 isSending，避免本机 drain happy-path 误闪「排队中」。
            agentBusy = state.runState?.isActive == true ||
                state.isStreaming ||
                state.isCancelControlPending ||
                state.messages.any { it.isStreaming },
            onRetry = viewModel::retryQueuedMessage,
            onRemove = viewModel::removeQueuedMessage,
        )

        // 对齐 iOS：有待处理的 HITL 面板（审批/提问/评审）时 Composer 阻断输入
        val hitlBlocked = state.pendingReview != null ||
            state.pendingPlanApproval != null ||
            state.pendingApproval != null ||
            state.pendingAskUser != null ||
            state.pendingAskForm != null ||
            state.pendingRequestApproval != null

        if (restoredComposerBlocks.isNotEmpty()) {
            RestoredComposerBlocksNotice(
                count = restoredComposerBlocks.size,
                onRemove = { restoredComposerBlocks = emptyList() },
            )
        }

        ComposerView(
            text = inputText,
            onTextChange = { inputText = it },
            isSending = state.isSending,
            isStreaming = state.isStreaming,
            isPaused = state.isPaused,
            isPauseControlPending = state.isPauseControlPending,
            isCancelControlPending = state.isCancelControlPending,
            billingBlocked = state.billingBlocked || state.memberLimitBlocked,
            hitlBlocked = hitlBlocked,
            disabledReason = composerDisabledReason,
            workspaceName = workspaceName,
            attachments = attachmentList,
            contextRefs = activeResourceRefs,
            isUploading = attachmentList.any {
                it.status == AttachmentStatus.UPLOADING || it.status == AttachmentStatus.PENDING
            },
            onPickImages = onPickImages,
            onPickFiles = onPickFiles,
            onCamera = onCamera,
            onSend = {
                val text = inputText
                val refs = activeResourceRefs
                val restoredBlocks = restoredComposerBlocks
                val clearPersistedDraft = {
                    if (inputText == text) inputText = ""
                    if (activeResourceRefs == refs) activeResourceRefs = emptyList()
                    if (restoredComposerBlocks == restoredBlocks) restoredComposerBlocks = emptyList()
                    isNearBottom.value = true
                    isPinnedToBottom.value = true
                }
                val blocks = restoredBlocks + refs.mapNotNull { it.toMessageBlock() }
                viewModel.sendMessage(
                    text.trim(),
                    blocks = blocks.takeIf { it.isNotEmpty() },
                    onPersisted = clearPersistedDraft,
                )
            },
            onCancel = { viewModel.cancelStream() },
            onPause = { viewModel.pauseStream() },
            onResume = { viewModel.resumeStream() },
            onVoiceInput = { showVoiceInput = true },
            onRemoveAttachment = { viewModel.removeAttachment(it) },
            onRetryAttachment = { id -> viewModel.retrySingleAttachment(id) },
            onRemoveContextRef = { refId ->
                activeResourceRefs = activeResourceRefs.filter { it.id != refId }
                onRemoveResourceReference(refId)
            },
            currentModel = state.currentModel,
            availableModels = state.availableModels,
            isLoadingModels = state.isLoadingModels,
            isSwitchingModel = state.isSwitchingModel,
            modelSwitchErrorMessage = state.modelSwitchErrorMessage,
            modelLoadFailed = state.modelLoadFailed,
            contextTierId = state.contextTierId,
            thinkingMode = state.thinkingMode,
            currentMode = state.runtimeConfiguration.agentMode.wireValue,
            currentApprovalMode = state.runtimeConfiguration.approvalMode.wireValue,
            permitsRelaxedApproval = state.permitsRelaxedApproval,
            currentAgentName = currentAgentName,
            agentOptions = agentOptions,
            selectedAgentId = selectedAgentId,
            agentIsMutable = agentIsMutable,
            onAgentChange = onAgentChange,
            onModelChange = viewModel::selectChatModel,
            onDismissModelSwitchError = viewModel::dismissModelSwitchError,
            onContextTierChange = viewModel::selectContextTier,
            onThinkingModeChange = viewModel::selectThinkingMode,
            onModeChange = viewModel::selectAgentMode,
            onApprovalModeChange = viewModel::selectApprovalMode,
            onRetryLoadModels = { viewModel.loadChatModels(forceRefresh = true) },
            onAddContext = { showContextPicker = true },
            collapsedForReading = composerCollapsedForReading,
        )
        }
    }
    }
    }

    if (showContextPicker) {
        val limitReachedTemplate = stringResource(
            R.string.chat_mention_limit_reached,
            WorkbenchUiState.MAX_DELEGATION_REFERENCES,
        )
        val alreadyAddedMsg = stringResource(R.string.chat_mention_already_added)
        ContextRefPickerSheet(
            resources = mentionableResources,
            isLoading = mentionableResourcesLoading,
            onSelect = { resource ->
                val ref = ResourceReference.from(resource)
                val failureMessage = when {
                    activeResourceRefs.any { it.id == ref.id } -> alreadyAddedMsg
                    activeResourceRefs.size >= WorkbenchUiState.MAX_DELEGATION_REFERENCES -> limitReachedTemplate
                    else -> null
                }
                if (failureMessage != null) {
                    android.widget.Toast.makeText(context, failureMessage, android.widget.Toast.LENGTH_SHORT).show()
                } else {
                    activeResourceRefs = activeResourceRefs + ref
                    showContextPicker = false
                }
            },
            onDismiss = { showContextPicker = false },
        )
    }

    if (showVoiceInput) {
        ChatVoiceInputOverlay(
            webSocketService = viewModel.webSocketService,
            tokenManager = viewModel.tokenManager,
            onResult = { result ->
                showVoiceInput = false
                when (result) {
                    is ChatVoiceResult.FillDraft -> {
                        inputText = result.text
                    }
                    is ChatVoiceResult.SendDirectly -> {
                        isNearBottom.value = true
                        isPinnedToBottom.value = true
                        viewModel.sendMessage(result.text)
                    }
                    is ChatVoiceResult.Cancelled -> { }
                }
            },
        )
    }

    cameraAccessIssue?.let { issue ->
        val isPermissionDenied = issue == CameraAccessIssue.PERMISSION_DENIED
        val title = when (issue) {
            CameraAccessIssue.PERMISSION_DENIED -> stringResource(R.string.chat_camera_permission_title)
            CameraAccessIssue.UNAVAILABLE,
            CameraAccessIssue.LAUNCH_FAILED,
            -> stringResource(R.string.chat_camera_unavailable_title)
        }
        val message = when (issue) {
            CameraAccessIssue.PERMISSION_DENIED -> stringResource(R.string.chat_camera_permission_message)
            CameraAccessIssue.UNAVAILABLE -> stringResource(R.string.chat_camera_unavailable_message)
            CameraAccessIssue.LAUNCH_FAILED -> stringResource(R.string.chat_camera_launch_failed_message)
        }

        AlertDialog(
            onDismissRequest = { cameraAccessIssue = null },
            title = { Text(title) },
            text = { Text(message) },
            confirmButton = {
                TextButton(
                    onClick = {
                        cameraAccessIssue = null
                        if (isPermissionDenied) {
                            context.startActivity(
                                Intent(
                                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.fromParts("package", context.packageName, null),
                                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    },
                ) {
                    Text(
                        stringResource(
                            if (isPermissionDenied) {
                                R.string.chat_camera_open_settings
                            } else {
                                R.string.common_confirm
                            },
                        ),
                    )
                }
            },
            dismissButton = if (isPermissionDenied) {
                {
                    TextButton(onClick = { cameraAccessIssue = null }) {
                        Text(stringResource(R.string.common_cancel))
                    }
                }
            } else {
                null
            },
        )
    }

    if (showRewindSheet) {
        RewindPreviewSheet(
            preview = checkpointState.preview,
            isLoading = checkpointState.isLoadingPreview,
            isExecuting = checkpointState.isExecuting,
            errorMessage = checkpointState.errorMessage,
            onConfirm = { excludedResources, rollbackReason, _ ->
                checkpointState.targetMessageId?.let { msgId ->
                    checkpointViewModel.executeRollback(
                        sessionId,
                        msgId,
                        excludedResources = excludedResources,
                        rollbackReason = rollbackReason,
                    )
                }
            },
            onDismiss = {
                showRewindSheet = false
                checkpointViewModel.dismissPreview()
            },
            onRetry = checkpointState.targetMessageId?.let { msgId ->
                { checkpointViewModel.loadPreview(sessionId, msgId) }
            },
            onViewHistory = {
                showRewindSheet = false
                checkpointViewModel.loadRevertHistory(sessionId)
                showHistorySheet = true
            },
        )
    }


    state.editResend?.let { editResend ->
        RewindPreviewSheet(
            preview = editResend.preview,
            isLoading = editResend.isLoadingPreview,
            isExecuting = editResend.isExecuting,
            errorMessage = editResend.errorMessage,
            onConfirm = { excludedResources, _, allowConversationOnly ->
                viewModel.confirmEditResend(excludedResources, allowConversationOnly)
            },
            onDismiss = viewModel::dismissEditResendPreview,
            onRetry = if (!editResend.rollbackApplied && !editResend.isExecuting) {
                viewModel::retryEditResendPreview
            } else {
                null
            },
            isEditResend = true,
            confirmEnabled = !editResend.rollbackApplied && editResend.preview?.noImpact == false,
        )
    }

    if (showHistorySheet) {
        RevertHistorySheet(
            history = checkpointState.revertHistory,
            isLoading = checkpointState.isLoadingHistory,
            loadFailed = checkpointState.historyLoadFailed,
            rollbackState = checkpointState.rollbackState,
            onRetry = { checkpointViewModel.loadRevertHistory(sessionId) },
            onDismiss = { showHistorySheet = false },
        )
    }

    checkpointState.restoringPhase?.let { phase ->
        RestoreOverlay(phase = phase)
    }
}

/**
 * 将会话精确定位到内容尾部。
 *
 * [LazyListState.animateScrollToItem] / [LazyListState.scrollToItem] 只保证目标 item 出现在
 * viewport 中；最后一条很高时，它会停在 item 顶部，尾部仍在输入区之后。这里在定位最后 item
 * 后，按照最后 item 的真实尾边与内容 viewport 尾边的差值再补一次滚动。尾部 padding 也纳入
 * 计算，因此 [LazyListState.canScrollForward] 才会在真正到底后变为 false。
 *
 * 末条**已经在视野里**时绝不能再走 scrollToItem：它会先把末条对齐到视口顶，再靠
 * [scrollConversationTrailingEdgeIntoView] 拉回——用户刚滑到底时就会看到一次明显弹动。
 * 这种「已贴底 / 刚回到底部」是主路径，只做尾边微调。
 */
private suspend fun LazyListState.scrollToConversationEnd(
    animated: Boolean = false,
    settleLayout: Boolean = false,
    trailingOnly: Boolean = false,
) {
    // 首帧中消息、Composer 和 LazyColumn 的 item 数可能连续变化。每次校正都重取末尾 index，
    // 避免缓存历史与服务端权威历史交替时，按已过期的末尾 item 定位。
    val attempts = if (settleLayout) 3 else 1
    repeat(attempts) { attempt ->
        // 流式尾边跟随时布局已经是当前帧，再等一帧会把顶锚跳动多晾一拍。
        if (!trailingOnly) {
            withFrameNanos { }
        }
        val targetIndex = layoutInfo.totalItemsCount - 1
        if (targetIndex < 0) return

        val lastAlreadyVisible = layoutInfo.visibleItemsInfo.any { it.index == targetIndex }
        if (
            ConversationStreamScrollPolicy.shouldJumpToLastItem(
                lastAlreadyVisible = lastAlreadyVisible,
                trailingOnly = trailingOnly,
            )
        ) {
            if (animated && attempt == 0) {
                animateScrollToItem(targetIndex)
            } else {
                scrollToItem(targetIndex)
            }
            withFrameNanos { }
        }
        scrollConversationTrailingEdgeIntoView()

        // 已真正贴底就收工，避免 settle 多轮空跑把惯性/overscroll 又搅起来。
        if (!canScrollForward) return
    }
}

/**
 * 「已经算回到最新」的容差。
 *
 * 必须大于 Composer 展开态与收敛态的高度差（约 56dp）：判定发生在滚动刚停、输入区还
 * 收着的时刻，若按零容差读，滑到底也会因为「展开后会把视口撑矮、内容就又装不下了」
 * 而判成没到底，输入区从此再不展开。
 */
private val ComposerReadingBottomSlack = 96.dp

/** 键盘弹出动画的落定时间：略大于系统 IME 动画时长，贴底定位等它稳住再算。 */
private const val ImeSettleDelayMillis = 280L

/** 末条消息的尾边是否已经进入（或接近）视口尾部。[slackPx] 见 [ComposerReadingBottomSlack]。 */
private fun LazyListState.isNearConversationEnd(slackPx: Int): Boolean {
    return ConversationStreamScrollPolicy.isAtBottomForPin(
        canScrollForward = canScrollForward,
        trailingOverflowPx = trailingOverflowPx(),
        slackPx = slackPx,
    )
}

/** 末条尾边超出内容视口的像素；末条还不在视野里时视为很大，避免误 pin。 */
private fun LazyListState.trailingOverflowPx(): Int {
    val info = layoutInfo
    val lastIndex = info.totalItemsCount - 1
    if (lastIndex < 0) return 0
    val lastItem = info.visibleItemsInfo.lastOrNull { it.index == lastIndex }
        ?: return Int.MAX_VALUE / 4
    val contentViewportEnd = info.viewportEndOffset - info.afterContentPadding
    return lastItem.offset + lastItem.size - contentViewportEnd
}

private suspend fun LazyListState.scrollConversationTrailingEdgeIntoView() {
    val info = layoutInfo
    val lastIndex = info.totalItemsCount - 1
    if (lastIndex < 0) return

    val lastItem = info.visibleItemsInfo.lastOrNull { it.index == lastIndex } ?: return
    val contentViewportEnd = info.viewportEndOffset - info.afterContentPadding
    val trailingOverflow = lastItem.offset + lastItem.size - contentViewportEnd
    if (trailingOverflow <= 0) return

    // 大段富内容若做动画补偿，默认动画时长会随距离增长，按钮看起来会在半途停很久。
    // 先让主列表平滑靠近最后 item，再立即对齐它的真实尾边。
    scrollBy(trailingOverflow.toFloat())
}

internal enum class CameraAccessAction {
    OPEN_CAMERA,
    REQUEST_PERMISSION,
    SHOW_UNAVAILABLE,
}

internal enum class CameraAccessIssue {
    PERMISSION_DENIED,
    UNAVAILABLE,
    LAUNCH_FAILED,
}

internal fun cameraAccessAction(
    cameraAvailable: Boolean,
    permissionGranted: Boolean,
): CameraAccessAction = when {
    !cameraAvailable -> CameraAccessAction.SHOW_UNAVAILABLE
    permissionGranted -> CameraAccessAction.OPEN_CAMERA
    else -> CameraAccessAction.REQUEST_PERMISSION
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun OutgoingQueueStrip(
    messages: List<QueuedOutgoingMessage>,
    agentBusy: Boolean,
    onRetry: (String) -> Unit,
    onRemove: (String) -> Unit,
) {
    val visibleMessages = OutgoingQueuePolicy.stripMessages(messages, agentBusy)
    val first = visibleMessages.firstOrNull()
        ?: return
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs)
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant)),
    ) {
        Text(
            text = outgoingQueueTitle(first, visibleMessages.size),
            style = TTFonts.captionSemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            maxLines = 1,
            modifier = Modifier.padding(
                start = TTSpacing.md,
                end = TTSpacing.md,
                top = TTSpacing.sm,
                bottom = TTSpacing.xs,
            ),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 160.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            visibleMessages.forEachIndexed { index, message ->
                OutgoingQueueRow(
                    index = index + 1,
                    message = message,
                    context = context,
                    showDivider = index < visibleMessages.lastIndex,
                    onRetry = onRetry,
                    onRemove = onRemove,
                )
            }
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun OutgoingQueueRow(
    index: Int,
    message: QueuedOutgoingMessage,
    context: android.content.Context,
    showDivider: Boolean,
    onRetry: (String) -> Unit,
    onRemove: (String) -> Unit,
) {
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = index.toString(),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                modifier = Modifier.width(16.dp),
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(start = TTSpacing.xs),
            ) {
                Text(
                    text = message.previewText,
                    style = TTFonts.body,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    maxLines = 1,
                )
                message.lastError?.takeIf { it.isNotBlank() }?.let { error ->
                    Text(
                        text = ErrorContentLocalizer.localize(error, context),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        maxLines = 2,
                    )
                }
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs, alignment = Alignment.End),
            ) {
                val retryLabel = when {
                    QueuedOutgoingMessageAction.RETRY_PERSISTED_EXECUTION in message.allowedLocalActions ->
                        stringResource(R.string.chat_outgoing_retry_execution)
                    QueuedOutgoingMessageAction.RETRY in message.allowedLocalActions ->
                        stringResource(R.string.chat_outgoing_retry)
                    else -> null
                }
                if (retryLabel != null) {
                    TextButton(onClick = { onRetry(message.id) }) {
                        Text(
                            text = retryLabel,
                            style = TTFonts.captionSemibold,
                            color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                        )
                    }
                }
                val removeLabel = when {
                    QueuedOutgoingMessageAction.REMOVE_UNSENT in message.allowedLocalActions ->
                        stringResource(R.string.chat_outgoing_remove_unsent)
                    QueuedOutgoingMessageAction.HIDE_ACCEPTED_TRACKING in message.allowedLocalActions ->
                        stringResource(R.string.chat_outgoing_hide_tracking)
                    else -> null
                }
                if (removeLabel != null) {
                    TextButton(onClick = { onRemove(message.id) }) {
                        Text(
                            text = removeLabel,
                            style = TTFonts.captionSemibold,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                    }
                }
            }
        }
        if (showDivider) {
            HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
        }
    }
}

@Composable
private fun outgoingQueueTitle(message: QueuedOutgoingMessage, count: Int): String =
    when (message.status) {
        QueuedOutgoingMessageStatus.WAITING ->
            if (count > 1) "$count 条消息排队中，当前回复结束后发送" else "消息已排队，当前回复结束后发送"
        QueuedOutgoingMessageStatus.OFFLINE ->
            if (count > 1) "$count 条消息等待连接恢复" else "消息等待连接恢复"
        QueuedOutgoingMessageStatus.SENDING -> "正在发送排队消息"
        QueuedOutgoingMessageStatus.ACCEPTED -> "消息已送达，正在确认"
        QueuedOutgoingMessageStatus.AWAITING_DEVICE -> stringResource(R.string.chat_outgoing_awaiting_device)
        QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED -> "消息已保存，但执行未启动"
        QueuedOutgoingMessageStatus.FAILED -> "排队消息发送失败"
    }

@Composable
private fun RestoredComposerBlocksNotice(
    count: Int,
    onRemove: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs)
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
            .padding(start = TTSpacing.md, end = TTSpacing.xs, top = TTSpacing.xs, bottom = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning),
        )
        Text(
            text = stringResource(R.string.chat_message_edit_restored_blocks_notice, count),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = TTSpacing.sm),
        )
        TextButton(onClick = onRemove) {
            Text(
                text = stringResource(R.string.common_remove),
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
            )
        }
    }
}

@Composable
private fun BillingBlockedBanner(
    onNavigateToWallet: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning),
        )
        Text(
            text = stringResource(R.string.chat_billing_blocked_hint),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            modifier = Modifier.weight(1f).padding(horizontal = TTSpacing.sm),
        )
        if (onNavigateToWallet != null) {
            TextButton(onClick = onNavigateToWallet) {
                Text(
                    text = stringResource(R.string.chat_billing_go_recharge),
                    style = TTFonts.captionSemibold,
                    color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                )
            }
        }
    }
}

@Composable
private fun MemberLimitBanner(
    reason: String?,
    modifier: Modifier = Modifier,
) {
    val msgRes = if (reason == "member_daily_limit")
        R.string.chat_billing_member_daily_limit
    else
        R.string.chat_billing_member_monthly_limit
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning),
        )
        Text(
            text = stringResource(msgRes),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            modifier = Modifier.weight(1f).padding(horizontal = TTSpacing.sm),
        )
    }
}

private tailrec fun Context.findActivity(): Activity? {
    return when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.findActivity()
        else -> null
    }
}

private fun rollbackBannerKey(state: SessionRollbackState): String =
    listOf(
        state.targetMessageId.orEmpty(),
        state.updatedAt.orEmpty(),
        state.lastApplyResult.orEmpty(),
        state.lastOperationMode,
    ).joinToString("|")

/**
 * Wave 4 I8：通过 tabtin:// scheme + ACTION_VIEW 派发到 Plan 文档（tabdoc 资源）。
 * 与 RichContentSection.navigateToResource 同语义，集中在 conversation 模块复用。
 *
 * 失败时给出"无法打开"Toast，不崩溃——manifest 注册被禁 / 系统找不到 handler 都走这里。
 */
private fun openPlanDocument(
    context: android.content.Context,
    planDocumentId: String,
    organizationId: String?,
    spaceId: String?,
) {
    if (planDocumentId.isBlank()) return
    val encoded = Uri.encode(planDocumentId)
    val uri = Uri.parse("tabtin://resource/tabdoc/$encoded").buildUpon().apply {
        organizationId?.takeIf { it.isNotBlank() }
            ?.let { appendQueryParameter("organization_id", it) }
        spaceId?.takeIf { it.isNotBlank() }
            ?.let { appendQueryParameter("space_id", it) }
    }.build()
    try {
        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, uri).apply {
            setPackage(context.packageName)
        }
        context.startActivity(intent)
    } catch (e: android.content.ActivityNotFoundException) {
        android.util.Log.w("ConversationView", "openPlanDocument ActivityNotFound: $uri", e)
        android.widget.Toast.makeText(
            context,
            context.getString(R.string.chat_plan_approval_open_failed),
            android.widget.Toast.LENGTH_LONG,
        ).show()
    }
}

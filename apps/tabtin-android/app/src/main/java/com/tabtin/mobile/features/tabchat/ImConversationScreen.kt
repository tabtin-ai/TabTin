package com.tabtin.mobile.features.tabchat

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.IM_REACTION_KIND_LIMIT
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.data.im.canAddImReaction
import com.tabtin.mobile.data.im.ImConversationDetail
import com.tabtin.mobile.data.im.ImConversation
import com.tabtin.mobile.data.im.ImConversationTitlePolicy
import com.tabtin.mobile.data.im.ImConversationType
import com.tabtin.mobile.data.im.ImAgentSummary
import com.tabtin.mobile.data.im.ImAgentTaskThreadResult
import com.tabtin.mobile.data.im.ImCardStatusMemoryCache
import com.tabtin.mobile.data.im.ImMember
import com.tabtin.mobile.data.im.ImMemberDisplayPolicy
import com.tabtin.mobile.data.im.ImHumanReadReceiptPolicy
import com.tabtin.mobile.data.im.ImHandoffCard
import com.tabtin.mobile.data.im.ImHandoffFrozenAttachment
import com.tabtin.mobile.data.im.ImHandoffFrozenTranscript
import com.tabtin.mobile.data.im.ImHandoffPackage
import com.tabtin.mobile.data.im.ImHandoffReference
import com.tabtin.mobile.data.im.ImMessage
import com.tabtin.mobile.data.im.ImForwardedFrom
import com.tabtin.mobile.data.im.ImPendingMessage
import com.tabtin.mobile.data.im.ImOutgoingCard
import com.tabtin.mobile.data.im.ImPromptCard
import com.tabtin.mobile.data.im.ImReadReceipt
import com.tabtin.mobile.data.im.ImReadReceiptMember
import com.tabtin.mobile.data.im.ImMessageReadReceipts
import com.tabtin.mobile.data.im.ImResourceCard
import com.tabtin.mobile.data.im.ImResourceCardPreview
import com.tabtin.mobile.data.im.ImResourceCardPreviewResult
import com.tabtin.mobile.data.im.ImResourceCardType
import com.tabtin.mobile.data.im.ImSendOutcome
import com.tabtin.mobile.data.im.imForwardTargets
import com.tabtin.mobile.data.im.isImConversationReadOnly
import com.tabtin.mobile.data.im.ImSessionShareCard
import com.tabtin.mobile.data.im.ImSessionShareV2Card
import com.tabtin.mobile.data.im.ImSessionShareV2Detail
import com.tabtin.mobile.data.im.ImSessionContinuationCard
import com.tabtin.mobile.data.im.ImSessionContinuationDetail
import com.tabtin.mobile.data.im.ImTaskShareMode
import com.tabtin.mobile.data.im.IM_MESSAGE_CONTENT_MAX_LENGTH
import com.tabtin.mobile.data.im.getImMessageContentLength
import com.tabtin.mobile.data.im.isImMessageContentWithinLimit
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.ChatAttachment
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.clouddocs.CloudDocsAppIcon
import com.tabtin.mobile.features.conversation.ChatAttachmentManager
import com.tabtin.mobile.features.conversation.ChatFilePreviewDialog
import com.tabtin.mobile.features.conversation.ConversationTypography
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import coil.compose.SubcomposeAsyncImage
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import java.util.UUID

/** TabChat 会话详情导航路由（与 Agent 的 `ChatSessionRoute` 分属两套系统，不复用）。 */
@Serializable
public data class ImConversationRoute(
    val conversationId: String,
    val title: String,
)

/** 会话更多页：独立路由，保证从会话页以 push 形式进入。 */
@Serializable
public data class ImConversationSettingsRoute(
    val conversationId: String,
    val title: String,
)

/**
 * TabChat 单会话详情屏（Phase B~E），对齐 iOS `IMConversationScreen.swift`：
 * 消息气泡列表 + 输入框，进入即订阅 `chat:{conv}`，退出退订。支持文本/附件/资源卡渲染、
 * 表情回应、撤回/编辑、typing、DM 已读、@Agent。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ImConversationScreen(
    onBack: () -> Unit,
    onOpenConversation: (conversationId: String, title: String) -> Unit = { _, _ -> },
    onOpenSettings: () -> Unit = {},
    onOpenCloudResource: (
        organizationId: String,
        spaceId: String?,
        resourceType: String,
        resourceId: String,
        title: String,
    ) -> Unit = { _, _, _, _, _ -> },
    onOpenChatSession: (
        sessionId: String,
        workspaceId: String?,
        spaceName: String,
        organizationId: String,
        projectId: String,
        initialMessage: String,
    ) -> Unit = { _, _, _, _, _, _ -> },
    onOpenSharedSession: (
        shareId: String,
        sessionId: String,
        title: String,
        organizationId: String,
    ) -> Unit = { _, _, _, _ -> },
    onOpenSpace: (spaceId: String, agentId: String?) -> Unit = { _, _ -> },
    /** 指令卡只预填到既有「新任务」composer，不会自动创建或发送任务。 */
    onUsePrompt: (String) -> Unit = {},
    viewModel: ImConversationViewModel = hiltViewModel(),
) {
    val storeMessages by viewModel.store.messages.collectAsState()
    val messages = remember(storeMessages) { uniqueImConversationMessages(storeMessages) }
    val pinnedMessages by viewModel.store.pinnedMessages.collectAsState()
    val pending by viewModel.store.pending.collectAsState()
    val timelineRows = remember(messages, pending) { imConversationTimelineRows(messages, pending) }
    val typingUserIds by viewModel.store.typingUserIds.collectAsState()
    val sessionShareVersions by viewModel.store.sessionShareVersions.collectAsState()
    val handoffVersions by viewModel.store.handoffVersions.collectAsState()
    val isLoadingHistory by viewModel.store.isLoadingHistory.collectAsState()
    val hasMoreHistory by viewModel.store.hasMoreHistory.collectAsState()
    val historyError by viewModel.store.historyError.collectAsState()
    val detail by viewModel.detail.collectAsState()
    val externalDirectMessageSendAccess by viewModel.externalDirectMessageSendAccess.collectAsState()
    val conversations by viewModel.conversations.collectAsState()
    val organizationMembers by viewModel.organizationMembers.collectAsState()
    val draftAttachments by viewModel.attachmentManager.attachments.collectAsState()
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val isForeground = lifecycleState.isAtLeast(Lifecycle.State.RESUMED)

    var draft by remember { mutableStateOf("") }
    var editingMessage by remember { mutableStateOf<ImMessage?>(null) }
    var replyMessage by remember { mutableStateOf<ImMessage?>(null) }
    var replyThreadMessage by remember { mutableStateOf<ImMessage?>(null) }
    var reactionMessage by remember { mutableStateOf<ImMessage?>(null) }
    var readReceiptMessage by remember { mutableStateOf<ImMessage?>(null) }
    val readReceiptDetails = remember(viewModel.conversationId) {
        mutableStateMapOf<Int, ImMessageReadReceipts>()
    }
    var forwardMessages by remember { mutableStateOf<List<ImMessage>?>(null) }
    var forwardOutcome by remember { mutableStateOf<ImConversationViewModel.ForwardOutcome?>(null) }
    var pinnedBannerExpanded by rememberSaveable(viewModel.conversationId) { mutableStateOf(false) }
    var pendingMentions by remember { mutableStateOf<List<ImDraftMention>>(emptyList()) }
    var showGroupMentionPicker by remember { mutableStateOf(false) }
    var showAgentMentionPicker by remember { mutableStateOf(false) }
    var showAgentMembershipPicker by remember { mutableStateOf(false) }
    var agentTaskMessage by remember { mutableStateOf<ImMessage?>(null) }
    var showMembersSheet by remember { mutableStateOf(false) }
    // 「+」内的结构化内容入口。云文件先进入待发送态，可补一段说明；名片和指令直接发送。
    var showResourcePicker by remember { mutableStateOf(false) }
    var showContactCardPicker by remember { mutableStateOf(false) }
    var showPromptComposer by remember { mutableStateOf(false) }
    var showSessionSharePicker by remember { mutableStateOf(false) }
    var handoffSourceMessage by remember { mutableStateOf<ImMessage?>(null) }
    var pendingCard by remember { mutableStateOf<ImOutgoingCard?>(null) }
    LaunchedEffect(pinnedMessages.size) {
        if (pinnedMessages.size <= 1) pinnedBannerExpanded = false
    }
    val context = LocalContext.current
    val attachmentAddFailedMessage = stringResource(R.string.im_attachment_add_failed)
    val directMessageFailedMessage = stringResource(R.string.im_dm_open_failed)
    val actionFailedMessage = stringResource(R.string.im_action_failed)
    val directMessageFallbackTitle = stringResource(R.string.im_kind_dm)
    val conversationFallbackTitle = stringResource(R.string.im_conversation_default_title)
    val conversationSnapshot = conversations.firstOrNull { it.id == viewModel.conversationId }
    val canAddAgent = detail?.let { conversationDetail ->
        ImGroupAgentMembershipPolicy.canAddAgent(
            detail = conversationDetail,
            currentUserId = viewModel.currentUserId,
            catalogIsExternal = conversationSnapshot?.isExternal,
        )
    } ?: false
    val isDirectMessage = detail?.isDm == true || conversationSnapshot?.type == ImConversationType.DM
    val isExternalConversation = detail?.isExternal == true || conversationSnapshot?.isExternal == true
    val isExternalDirectMessage = isExternalConversation && isDirectMessage
    val externalConversationMessage = "外部会话仅支持发送文字消息"
    val isReadOnlyConversation = isImConversationReadOnly(conversationSnapshot, detail) ||
        (isExternalDirectMessage && externalDirectMessageSendAccess != ExternalDirectMessageSendAccess.ALLOWED)
    val readOnlyMessage = when {
        isExternalDirectMessage && externalDirectMessageSendAccess == ExternalDirectMessageSendAccess.CHECKING ->
            "正在确认外部联系人状态"
        isExternalDirectMessage && externalDirectMessageSendAccess == ExternalDirectMessageSendAccess.UNAVAILABLE ->
            "暂时无法确认外部联系人状态，不能发送消息"
        isExternalDirectMessage && externalDirectMessageSendAccess == ExternalDirectMessageSendAccess.DENIED ->
            "你们已不是外部联系人，当前会话只读"
        detail?.canSend == false || conversationSnapshot?.canSend == false ->
            "你已不在当前会话，历史仍可查看，但不能发送消息"
        else -> "对方已不在组织，当前会话只读"
    }
    val normalizedCurrentUserId = viewModel.currentUserId?.trim()?.takeIf { it.isNotEmpty() }
    val peerUserId = conversationSnapshot?.dmPeerUserId
        ?: normalizedCurrentUserId?.let { currentUserId ->
            detail?.members
                ?.firstOrNull { !it.isAgent && it.userId != currentUserId }
                ?.userId
        }
    val detailPeerName = detail?.let {
        ImMemberDisplayPolicy.directMessagePeerDisplayName(
            detail = it,
            currentUserId = viewModel.currentUserId,
            preferredPeerUserId = peerUserId,
        )
    }
    val peerDisplayName = detailPeerName?.takeIf { it.isNotBlank() }
        ?: peerUserId?.let { id -> organizationMembers.firstOrNull { it.userId == id }?.displayName }
    val latestConversationName = detail?.name?.takeIf { it.isNotBlank() }
        ?: conversationSnapshot?.name?.takeIf { it.isNotBlank() }
        ?: viewModel.title
    val resolvedConversationTitle = ImConversationTitlePolicy.resolve(
        conversationName = latestConversationName,
        isDirectMessage = isDirectMessage,
        peerDisplayName = peerDisplayName,
        directMessageFallback = directMessageFallbackTitle,
        conversationFallback = conversationFallbackTitle,
    )
    val readReceiptPrefetchMessages = remember(messages, isDirectMessage, viewModel.currentUserId) {
        if (isDirectMessage) emptyList() else messages.asReversed()
            .asSequence()
            .filter { message ->
                message.senderId == viewModel.currentUserId &&
                    (message.readReceipt?.recipientCount ?: 0) > 0
            }
            .take(12)
            .toList()
    }
    LaunchedEffect(readReceiptPrefetchMessages.map(ImMessage::id)) {
        readReceiptPrefetchMessages.forEach { message ->
            if (readReceiptDetails.containsKey(message.id)) return@forEach
            runCatching { viewModel.store.fetchReadReceipts(message) }
                .onSuccess { readReceiptDetails[message.id] = it }
        }
        val retainedIds = messages.asReversed().take(64).mapTo(mutableSetOf(), ImMessage::id)
        readReceiptDetails.keys.toList().filterNot(retainedIds::contains).forEach(readReceiptDetails::remove)
    }
    val groupCreatedNotice = remember(
        detail?.createdAt,
        conversationSnapshot?.createdAt,
        detail?.isGroup,
        conversationSnapshot?.isGroup,
        hasMoreHistory,
        isLoadingHistory,
    ) {
        val createdAt = detail?.createdAt?.takeIf { it.isNotBlank() }
            ?: conversationSnapshot?.createdAt?.takeIf { it.isNotBlank() }
        if ((detail?.isGroup == true || conversationSnapshot?.isGroup == true) &&
            !hasMoreHistory && !isLoadingHistory && createdAt != null
        ) {
            formatGroupCreatedNotice(createdAt)
        } else {
            null
        }
    }
    val forwardFeedbackMessage = forwardOutcome?.let { outcome ->
        if (outcome.failed == 0) {
            stringResource(R.string.im_action_forwarded_count, outcome.sent)
        } else {
            stringResource(R.string.im_action_forward_partial, outcome.sent, outcome.failed)
        }
    }
    val actionScope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val composerFocusRequester = remember { FocusRequester() }
    fun focusComposerNextFrame() {
        actionScope.launch {
            withFrameNanos { }
            composerFocusRequester.requestFocus()
            keyboardController?.show()
        }
    }
    val dismissKeyboard: () -> Unit = {
        focusManager.clearFocus()
        keyboardController?.hide()
    }
    val showComposerHint: (String) -> Unit = { message ->
        android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_SHORT).show()
    }

    val addPickedAttachment: (android.net.Uri?) -> Unit = { uri ->
        if (uri != null) {
            if (isExternalConversation) {
                showComposerHint(externalConversationMessage)
            } else if (isReadOnlyConversation) {
                showComposerHint(readOnlyMessage)
            } else if (pendingCard != null) {
                showComposerHint("请先发送或移除当前资源卡")
            } else {
                when (val result = viewModel.addAttachment(uri)) {
                    is ChatAttachmentManager.AddResult.Success -> Unit
                    is ChatAttachmentManager.AddResult.Error -> android.widget.Toast.makeText(
                        context,
                        result.error.message ?: attachmentAddFailedMessage,
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                }
            }

        }
    }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) {
        addPickedAttachment(it)
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {
        addPickedAttachment(it)
    }
    val beginResourcePicker: () -> Unit = {
        when {
            isExternalConversation -> showComposerHint(externalConversationMessage)
            isReadOnlyConversation -> showComposerHint(readOnlyMessage)
            pendingCard != null -> showComposerHint("请先发送或移除当前资源卡")
            draftAttachments.isNotEmpty() -> showComposerHint("请先移除当前附件，再发送资源卡")
            viewModel.conversationOrganizationId == null -> showComposerHint("会话信息尚未就绪，请稍后重试")
            else -> showResourcePicker = true
        }
    }
    val beginContactPicker: () -> Unit = {
        if (isExternalConversation) {
            showComposerHint(externalConversationMessage)
        } else if (isReadOnlyConversation) {
            showComposerHint(readOnlyMessage)
        } else if (viewModel.conversationOrganizationId == null) {
            showComposerHint("会话信息尚未就绪，请稍后重试")
        } else {
            showContactCardPicker = true
        }
    }
    val beginSessionSharePicker: () -> Unit = {
        when {
            isExternalConversation -> showComposerHint(externalConversationMessage)
            isReadOnlyConversation -> showComposerHint(readOnlyMessage)
            !isDirectMessage || peerUserId.isNullOrBlank() -> showComposerHint("共享任务只能发送给单个联系人")
            viewModel.conversationOrganizationId == null -> showComposerHint("会话信息尚未就绪，请稍后重试")
            else -> showSessionSharePicker = true
        }
    }
    val sendCardImmediately: (ImOutgoingCard) -> Unit = sendCard@{ card ->
        if (isExternalConversation) {
            showComposerHint(externalConversationMessage)
            return@sendCard
        }
        if (isReadOnlyConversation) {
            showComposerHint(readOnlyMessage)
            return@sendCard
        }
        actionScope.launch {
            val outcome = viewModel.sendCardImmediately(card)
            if (outcome.didEnqueue) {
                replyMessage = null
                dismissKeyboard()
            } else if (outcome == ImSendOutcome.REJECTED_READ_ONLY) {
                showComposerHint(readOnlyMessage)
            } else {
                showComposerHint("消息无法发送")
            }
        }
    }

    // 首次拉取的历史不应以平滑滚动形式展示：页面先在后台定位到最新消息，再显示列表。
    // 以会话 ID 作为 key，push 进入另一段私信时不会复用上一段会话的首屏状态。
    var hasSettledInitialPosition by rememberSaveable(viewModel.conversationId) { mutableStateOf(false) }
    var loadMoreRequested by remember(viewModel.conversationId) { mutableStateOf(false) }
    val hadCachedRowsOnEntry = remember(viewModel.conversationId) { messages.isNotEmpty() }
    val hasConversationRows = messages.isNotEmpty() || pending.isNotEmpty() || typingUserIds.isNotEmpty()
    val latestMessageId = messages.lastOrNull()?.id
    val initialListIndex = remember(viewModel.conversationId) {
        initialImConversationTailIndex(
            messageCount = messages.size,
            pendingCount = pending.size,
            typingActive = typingUserIds.isNotEmpty(),
            hasLoadMoreRow = hasMoreHistory && messages.isNotEmpty() && !isLoadingHistory,
        )
    }
    val listState = rememberSaveable(viewModel.conversationId, saver = LazyListState.Saver) {
        LazyListState(firstVisibleItemIndex = initialListIndex)
    }
    var previouslyObservedTailMessageId by remember(viewModel.conversationId) { mutableStateOf(latestMessageId) }
    var previouslyObservedPendingCount by remember(viewModel.conversationId) { mutableStateOf(pending.size) }
    var isUserDraggingHistory by remember(viewModel.conversationId) { mutableStateOf(false) }

    // 对齐 Agent 会话：滚动列表时收起键盘；点消息区空白/气泡见下方 dismissKeyboard。
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }
            .collect { if (it) dismissKeyboard() }
    }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> isUserDraggingHistory = true
                is DragInteraction.Stop, is DragInteraction.Cancel -> isUserDraggingHistory = false
            }
        }
    }

    // 初次历史加载完成后直接落在末尾；此后新增消息 / 乐观发送仍保留平滑反馈。
    androidx.compose.runtime.LaunchedEffect(isForeground) {
        if (isForeground) viewModel.onForeground() else viewModel.onBackground()
    }
    androidx.compose.runtime.LaunchedEffect(listState, viewModel.conversationId) {
        snapshotFlow {
            earlierHistoryLoadAction(
                firstVisibleItemIndex = listState.firstVisibleItemIndex,
                canScrollForward = listState.canScrollForward,
                isUserDragging = isUserDraggingHistory,
                hasSettledInitialPosition = hasSettledInitialPosition,
                hasMessages = messages.isNotEmpty(),
                hasMoreHistory = hasMoreHistory,
                isLoadingHistory = isLoadingHistory,
                loadMoreRequested = loadMoreRequested,
            )
        }
            .distinctUntilChanged()
            .collect { action ->
                when (action) {
                    EarlierHistoryLoadAction.REARM -> loadMoreRequested = false
                    EarlierHistoryLoadAction.REQUEST -> {
                        loadMoreRequested = true
                        viewModel.store.loadMore()
                    }
                    EarlierHistoryLoadAction.NONE -> Unit
                }
            }
    }

    androidx.compose.runtime.LaunchedEffect(
        messages.size,
        latestMessageId,
        pending.size,
        typingUserIds,
        isForeground,
        isLoadingHistory,
    ) {
        if (!isForeground) return@LaunchedEffect
        if (!hasConversationRows) return@LaunchedEffect

        if (!hasSettledInitialPosition) {
            // `loadInitial` 会在一批完整历史合并后才置 false；等它结束可避免先对局部
            // 列表定位、随后又平滑追到底部。首屏必须无动画。
            // 但若进入时已有本地快照，缓存本身就是可展示的首屏；不能因为后台刷新还在飞
            // 就把整条列表 alpha=0 藏起来，让用户看到“又在 loading”。
            if (isLoadingHistory && messages.isEmpty() && pending.isEmpty() && !hadCachedRowsOnEntry) {
                return@LaunchedEffect
            }
            listState.scrollToImConversationEnd(settleLayout = true)
            hasSettledInitialPosition = true
        } else if (
            shouldFollowImConversationTail(
                previousTailMessageId = previouslyObservedTailMessageId,
                currentTailMessageId = latestMessageId,
                previousPendingCount = previouslyObservedPendingCount,
                currentPendingCount = pending.size,
            )
        ) {
            listState.scrollToImConversationEnd(animated = true)
        }
        previouslyObservedTailMessageId = latestMessageId
        previouslyObservedPendingCount = pending.size
        viewModel.store.markReadUpToLatest()
    }

    androidx.compose.runtime.LaunchedEffect(forwardFeedbackMessage) {
        forwardFeedbackMessage?.let { message ->
            android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_LONG).show()
            forwardOutcome = null
        }
    }

    val currentUserId = viewModel.currentUserId
    val replyCounts = remember(messages) { messages.groupingBy { it.replyToId }.eachCount() }
    val scrollToMessage: (ImMessage) -> Unit = { target ->
        actionScope.launch {
            while (
                viewModel.store.messages.value.none { it.id == target.id && !it.isDeleted } &&
                viewModel.store.hasMoreHistory.value
            ) {
                val previousCount = viewModel.store.messages.value.size
                viewModel.store.loadHistory(reset = false)
                if (viewModel.store.messages.value.size == previousCount) break
            }
            val loadedMessages = uniqueImConversationMessages(viewModel.store.messages.value)
            val loadedRows = imConversationTimelineRows(loadedMessages, viewModel.store.pending.value)
            val hasLoadMoreRow = viewModel.store.hasMoreHistory.value && loadedMessages.isNotEmpty()
            val hasGroupCreatedNotice =
                (detail?.isGroup == true || conversationSnapshot?.isGroup == true) &&
                    !viewModel.store.hasMoreHistory.value &&
                    (detail?.createdAt?.isNotBlank() == true || conversationSnapshot?.createdAt?.isNotBlank() == true)
            val listIndex = imConversationMessageListIndex(
                targetMessageId = target.id,
                timelineRows = loadedRows,
                hasGroupCreatedNotice = hasGroupCreatedNotice,
                hasLoadMoreRow = hasLoadMoreRow,
            )
            if (listIndex >= 0) {
                listState.animateScrollToItem(listIndex)
            } else {
                android.widget.Toast.makeText(context, "置顶消息已不可用", android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }

    val openDirectMessage: (String, String) -> Unit = { userId, displayName ->
        actionScope.launch {
            viewModel.createDirectMessage(userId, displayName)
                .onSuccess { onOpenConversation(it.conversationId, it.title) }
                .onFailure {
                    android.widget.Toast.makeText(
                        context,
                        it.message ?: directMessageFailedMessage,
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                }
        }
    }

    val openResourceCard: (ImResourceCard, String, ImResourceCardPreview?) -> Unit = { card, displayName, preview ->
        when (card.type) {
            ImResourceCardType.CONTACT -> {
                val userId = card.userId
                if (userId.isNullOrBlank()) {
                    android.widget.Toast.makeText(context, R.string.im_contact_missing_user, android.widget.Toast.LENGTH_SHORT).show()
                } else {
                    openDirectMessage(userId, displayName)
                }
            }
            ImResourceCardType.DOCUMENT, ImResourceCardType.TABLE -> {
                // 详情首屏尚未返回时仍可从会话列表快照取得组织，和资源 picker 使用同一回退，
                // 避免刚进入会话就点卡片被误判为缺少打开上下文。
                val target = card.resolveOpenTarget(
                    conversationOrganizationId = viewModel.conversationOrganizationId.orEmpty(),
                    preview = preview,
                )
                if (target == null) {
                    android.widget.Toast.makeText(context, R.string.im_resource_unavailable, android.widget.Toast.LENGTH_LONG).show()
                } else {
                    onOpenCloudResource(
                        target.organizationId,
                        target.spaceId,
                        target.resourceType,
                        target.resourceId,
                        displayName,
                    )
                }
            }
            ImResourceCardType.SPACE, ImResourceCardType.AGENT_SPACE -> {
                val spaceId = card.spaceCard?.spaceId
                if (spaceId == null) {
                    android.widget.Toast.makeText(context, R.string.im_resource_unavailable, android.widget.Toast.LENGTH_LONG).show()
                } else {
                    actionScope.launch {
                        viewModel.resolveSpaceCardOpenTarget(spaceId)
                            .onSuccess { target -> onOpenSpace(target.spaceId, target.agentId) }
                            .onFailure {
                                android.widget.Toast.makeText(
                                    context,
                                    R.string.im_workspace_unavailable,
                                    android.widget.Toast.LENGTH_LONG,
                                ).show()
                            }
                    }
                }
            }
            else -> android.widget.Toast.makeText(
                context,
                R.string.im_resource_unavailable,
                android.widget.Toast.LENGTH_LONG,
            ).show()
        }
    }
    val openHandoffReference: (ImHandoffReference) -> Unit = { reference ->
        when (reference.refType) {
            "im_message" -> {
                val source = reference.sourceLink.messageId?.let { messageId ->
                    messages.firstOrNull { it.id == messageId }
                }
                if (source == null) {
                    showComposerHint(context.getString(R.string.im_handoff_message_not_loaded))
                } else {
                    replyThreadMessage = source
                }
            }
            "document", "table" -> {
                val organizationId = reference.sourceLink.organizationId
                    ?.takeIf { it.isNotBlank() }
                    ?: viewModel.conversationOrganizationId.orEmpty().takeIf { it.isNotBlank() }
                if (organizationId == null || reference.resourceId.isBlank()) {
                    showComposerHint(context.getString(R.string.im_handoff_reference_missing_context))
                } else {
                    onOpenCloudResource(
                        organizationId,
                        reference.sourceLink.spaceId,
                        if (reference.refType == "table") "tabdata" else "tabdoc",
                        reference.resourceId,
                        reference.title.ifBlank { reference.summary },
                    )
                }
            }
            else -> showComposerHint(context.getString(R.string.im_handoff_reference_unsupported))
        }
    }
    val requestResourceAccess: suspend (ImMessage, ImResourceCard) -> Boolean = { message, card ->
        viewModel.requestResourceAccess(message, card)
            .fold(
                onSuccess = {
                    showComposerHint("已提交访问申请，等待确认")
                    true
                },
                onFailure = {
                    showComposerHint(it.message ?: "申请访问失败")
                    false
                },
            )
    }
    val openSessionShare: (ImSessionShareCard) -> Unit = { card ->
        val sessionId = card.sessionId?.takeIf { it.isNotBlank() }
        if (sessionId == null || card.normalizedStatus == "revoked") {
            showComposerHint(if (card.normalizedStatus == "revoked") "共享已停止" else "任务信息不完整")
        } else if (isSessionShareOwner(viewModel.currentUserId, card.ownerUserId, false)) {
            onOpenChatSession(
                sessionId,
                null,
                "",
                viewModel.conversationOrganizationId.orEmpty(),
                "",
                "",
            )
        } else {
            onOpenSharedSession(
                card.shareId,
                sessionId,
                card.displayTitle,
                viewModel.conversationOrganizationId.orEmpty(),
            )
        }
    }
    val revokeSessionShare: suspend (ImSessionShareCard) -> Result<ImSessionShareCard> =
        viewModel::revokeSessionShare
    val resumeSessionShare: suspend (ImSessionShareCard) -> Result<ImSessionShareCard> =
        viewModel::resumeSessionShare
    val loadSessionShareV2: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail> =
        viewModel::loadSessionShareV2Detail
    val acceptSessionShareV2: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail> =
        viewModel::acceptSessionShareV2
    val retrySessionShareV2Delivery: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail> =
        viewModel::retrySessionShareV2Delivery
    val loadSessionContinuation: suspend (ImSessionContinuationCard) -> Result<ImSessionContinuationDetail> =
        viewModel::loadSessionContinuation
    val loadContinuationExecutionTargets:
        suspend (String) -> Result<ImConversationViewModel.ContinuationExecutionTargets> =
        viewModel::loadContinuationExecutionTargets
    val createTaskFromSessionContinuation:
        suspend (ImSessionContinuationCard, String, String, String) -> Result<ImSessionContinuationDetail> =
        viewModel::createTaskFromSessionContinuation
    val openSessionContinuation: (ImSessionContinuationDetail) -> Unit = { continuation ->
        val sessionId = continuation.linkedSessionId?.trim()?.takeIf { it.isNotEmpty() }
        val workspaceId = continuation.targetWorkspaceId?.trim()?.takeIf { it.isNotEmpty() }
        if (sessionId == null || workspaceId == null) {
            showComposerHint("续接任务信息不完整")
        } else {
            onOpenChatSession(
                sessionId,
                workspaceId,
                "",
                continuation.organizationId,
                "",
                "",
            )
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = resolvedConversationTitle,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (isExternalDirectMessage) {
                            Spacer(modifier = Modifier.width(TTSpacing.xs))
                            Text(
                                text = stringResource(R.string.external_contacts_badge),
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onPrimaryContainer,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(MaterialTheme.colorScheme.primaryContainer)
                                    .padding(horizontal = TTSpacing.xs, vertical = 2.dp),
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.MoreVert, contentDescription = "会话设置")
                    }
                },
            )
        },
    ) { padding ->
        // 对齐 Agent `ChatSessionScreen` + `ConversationView`：Scaffold padding 只落外层 Box，
        // 内层 Column 自行消费 nav/IME inset，避免键盘弹出时 Scaffold 底 padding 夹在 composer 与键盘之间。
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .navigationBarsPadding()
                    .imePadding(),
            ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .pointerInput(Unit) {
                        detectTapGestures(onTap = { dismissKeyboard() })
                    },
            ) {
                val showsPinnedBanner = pinnedMessages.isNotEmpty()
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(
                            top = if (showsPinnedBanner) ImPinnedMessageHeaderHeight else 0.dp,
                        ),
                ) {
                    if (messages.isEmpty() && pending.isEmpty() && !isLoadingHistory && groupCreatedNotice == null) {
                        ImConversationEmptyOrError(
                            error = historyError,
                            onRetry = { viewModel.store.loadInitial() },
                            modifier = Modifier
                                .fillMaxSize()
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    onClick = dismissKeyboard,
                                ),
                        )
                    }
                    LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .fillMaxSize()
                            .alpha(
                                if (shouldHideInitialImRows(
                                        hasConversationRows = hasConversationRows,
                                        hasSettledInitialPosition = hasSettledInitialPosition,
                                        hadCachedRowsOnEntry = hadCachedRowsOnEntry,
                                    )
                                ) 0f else 1f,
                            ),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(
                            horizontal = TTSpacing.md,
                            vertical = TTSpacing.sm,
                        ),
                        // 组内紧凑、组首额外顶距由 ImMessageCell 控制（对齐 Electron mt-0.5 / mt-1.5）
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        groupCreatedNotice?.let { notice ->
                            item(key = "conversation-created") {
                                Text(
                                    text = notice,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = TTSpacing.sm),
                                )
                            }
                        }
                        if (hasMoreHistory && messages.isNotEmpty() && (!isLoadingHistory || loadMoreRequested)) {
                            item(key = "load-more") {
                                LoadMoreRow(isLoading = isLoadingHistory && loadMoreRequested) {
                                    loadMoreRequested = true
                                    viewModel.store.loadMore()
                                }
                            }
                        }
                        items(timelineRows, key = { it.stableKey }) { row ->
                            when (row) {
                                is ImConversationTimelineRow.Message -> ImMessageCell(
                                    message = row.message,
                                    handoffRefreshVersion = row.message.handoffCard?.handoffId
                                        ?.let { handoffVersions[it] }
                                        ?: 0,
                                    sessionShareRefreshVersion = row.message.sessionShareCard?.shareId
                                        ?.let { sessionShareVersions[it] }
                                        ?: row.message.sessionShareV2Card?.objectId
                                            ?.let { sessionShareVersions[it] }
                                        ?: 0,
                                    previousMessage = row.previousMessage,
                                    isMine = row.message.senderId == currentUserId,
                                    currentUserId = currentUserId,
                                    organizationMembers = organizationMembers,
                                    conversationMembers = detail?.members.orEmpty(),
                                    isDm = viewModel.isDm,
                                    onOpenSenderDirectMessage = openDirectMessage,
                                    isReadByPeer = viewModel.store.isReadByPeer(row.message),
                                    readProgress = ImHumanReadReceiptPolicy.project(
                                        progress = viewModel.store.readProgress(row.message),
                                        detail = readReceiptDetails[row.message.id],
                                        members = detail?.members.orEmpty(),
                                        currentUserId = currentUserId,
                                        senderId = row.message.senderId,
                                    ).progress,
                                    onOpenReadReceipts = { readReceiptMessage = row.message },
                                    replyCount = replyCounts[row.message.id] ?: 0,
                                    onToggleReaction = { emoji -> viewModel.store.toggleReaction(row.message.id, emoji) },
                                    onAddReaction = { reactionMessage = row.message },
                                    onReply = {
                                        replyMessage = row.message
                                        editingMessage = null
                                        focusComposerNextFrame()
                                    },
                                    onOpenReplyThread = { replyThreadMessage = row.message },
                                    onForward = { forwardMessages = listOf(row.message) },
                                    onTogglePin = {
                                        actionScope.launch {
                                            viewModel.toggleMessagePin(row.message).onFailure {
                                                android.widget.Toast.makeText(
                                                    context,
                                                    it.message ?: actionFailedMessage,
                                                    android.widget.Toast.LENGTH_LONG,
                                                ).show()
                                            }
                                        }
                                    },
                                    canCreateAgentTask = detail?.isTeamSpaceChannel == true &&
                                        !isExternalConversation,
                                    onCreateAgentTask = { agentTaskMessage = row.message },
                                    canCreateHandoff = !isExternalConversation &&
                                        !isReadOnlyConversation &&
                                        !row.message.isForwardRestrictedCard &&
                                        detail?.members.orEmpty().any { member ->
                                            !member.isAgent && member.userId != currentUserId
                                        },
                                    onCreateHandoff = { handoffSourceMessage = row.message },
                                    onCopy = { /* 复制在菜单内处理 */ },
                                    onBeginEdit = {
                                        editingMessage = row.message
                                        pendingMentions = emptyList()
                                        draft = row.message.content
                                        focusComposerNextFrame()
                                    },
                                    onRecall = {
                                        actionScope.launch {
                                            val success = viewModel.recallMessage(row.message.id)
                                            imRecallFeedbackMessage(success)?.let(showComposerHint)
                                        }
                                    },
                                    loadAttachment = { viewModel.loadAttachment(it) },
                                    onOpenCard = openResourceCard,
                                    loadResourcePreview = { viewModel.loadResourceCardPreview(it) },
                                    onRequestResourceAccess = requestResourceAccess,
                                    onOpenSessionShare = openSessionShare,
                                    loadSessionShare = { viewModel.loadSessionShareDetail(it) },
                                    onRevokeSessionShare = revokeSessionShare,
                                    onResumeSessionShare = resumeSessionShare,
                                    loadSessionShareV2 = loadSessionShareV2,
                                    onAcceptSessionShareV2 = acceptSessionShareV2,
                                    onRetrySessionShareV2Delivery = retrySessionShareV2Delivery,
                                    onOpenSessionShareV2 = { detail -> openSessionShare(detail.toCardSnapshot()) },
                                    onSessionShareV2ActionError = showComposerHint,
                                    loadSessionContinuation = loadSessionContinuation,
                                    loadContinuationExecutionTargets = loadContinuationExecutionTargets,
                                    createTaskFromSessionContinuation = createTaskFromSessionContinuation,
                                    onOpenSessionContinuation = openSessionContinuation,
                                    onSessionContinuationActionError = showComposerHint,
                                    loadHandoff = viewModel::loadHandoff,
                                    markHandoffTakingOver = viewModel::markHandoffTakingOver,
                                    revokeHandoff = viewModel::revokeHandoff,
                                    takeOverHandoff = viewModel::takeOverHandoff,
                                    loadHandoffAttachment = viewModel::loadHandoffAttachment,
                                    onOpenHandoffReference = openHandoffReference,
                                    onOpenHandoffSession = { session ->
                                        onOpenChatSession(
                                            session.id,
                                            session.workspaceId,
                                            "",
                                            session.organizationId.orEmpty(),
                                            session.projectId.orEmpty(),
                                            "",
                                        )
                                    },
                                    onHandoffActionError = showComposerHint,
                                    onUsePrompt = { prompt -> onUsePrompt(prompt.promptText) },
                                    onDismissKeyboard = dismissKeyboard,
                                )
                                is ImConversationTimelineRow.Pending -> ImPendingBubble(
                                    pendingMessage = row.pending,
                                    onRetry = {
                                        actionScope.launch {
                                            if (viewModel.retryPending(row.pending) == ImSendOutcome.REJECTED_READ_ONLY) {
                                                showComposerHint(
                                                    if (isExternalDirectMessage) {
                                                        "外部联系人状态已变更，当前会话只读"
                                                    } else {
                                                        readOnlyMessage
                                                    },
                                                )
                                            }
                                        }
                                    },
                                )
                            }
                        }
                        if (typingUserIds.isNotEmpty()) {
                            item(key = "typing") { ImTypingIndicator() }
                        }
                    }
                    if (shouldHideInitialImRows(
                            hasConversationRows = hasConversationRows,
                            hasSettledInitialPosition = hasSettledInitialPosition,
                            hadCachedRowsOnEntry = hadCachedRowsOnEntry,
                        )
                    ) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    }
                }

                if (showsPinnedBanner) {
                    if (pinnedBannerExpanded) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .pointerInput(Unit) {
                                    detectTapGestures {
                                        pinnedBannerExpanded = false
                                        dismissKeyboard()
                                    }
                                }
                                .zIndex(0.5f),
                        )
                    }
                    ImPinnedMessageBanner(
                        messages = pinnedMessages,
                        expanded = pinnedBannerExpanded,
                        onExpandedChange = { pinnedBannerExpanded = it },
                        onClick = scrollToMessage,
                        onUnpin = { message ->
                            actionScope.launch {
                                viewModel.toggleMessagePin(message).onFailure {
                                    android.widget.Toast.makeText(
                                        context,
                                        it.message ?: actionFailedMessage,
                                        android.widget.Toast.LENGTH_LONG,
                                    ).show()
                                }
                            }
                        },
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .fillMaxWidth()
                            .zIndex(1f),
                    )
                }
            }

            HorizontalDivider(color = imBorderLight())

            val draftTextLength = getImMessageContentLength(draft.trim())
            val draftTextTooLong = draft.trim().isNotEmpty() && !isImMessageContentWithinLimit(draft.trim())
            Box(modifier = Modifier.fillMaxWidth()) {
            ImComposer(
                draft = draft,
                messageTooLong = draftTextTooLong,
                messageLength = draftTextLength,
                editing = editingMessage != null,
                replyMessage = replyMessage,
                readOnlyMessage = readOnlyMessage.takeIf { isReadOnlyConversation },
                attachment = draftAttachments.firstOrNull(),
                pendingCard = pendingCard,
                focusRequester = composerFocusRequester,
                onDraftChange = {
                    val previousDraft = draft
                    draft = it
                    pendingMentions = pendingMentions.filter { mention ->
                        textHasMemberMention(it, mention.displayName)
                    }
                    if (
                        editingMessage == null &&
                        detail?.isGroup == true &&
                        !showGroupMentionPicker &&
                        !showAgentMentionPicker &&
                        it.length > previousDraft.length &&
                        isGroupMentionTrigger(it)
                    ) {
                        showGroupMentionPicker = true
                    }
                    if (editingMessage == null) viewModel.onDraftChanged(it)
                },
                onPickImage = {
                    if (isExternalConversation) showComposerHint(externalConversationMessage)
                    else if (isReadOnlyConversation) showComposerHint(readOnlyMessage)
                    else if (pendingCard != null) showComposerHint("请先发送或移除当前资源卡")
                    else imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                onPickFile = {
                    if (isExternalConversation) showComposerHint(externalConversationMessage)
                    else if (isReadOnlyConversation) showComposerHint(readOnlyMessage)
                    else if (pendingCard != null) showComposerHint("请先发送或移除当前资源卡")
                    else filePicker.launch(arrayOf("*/*"))
                },
                onPickCloudFile = beginResourcePicker,
                onPickContact = beginContactPicker,
                onPickPrompt = {
                    if (isExternalConversation) showComposerHint(externalConversationMessage)
                    else if (isReadOnlyConversation) showComposerHint(readOnlyMessage)
                    else showPromptComposer = true
                },
                onPickSessionShare = beginSessionSharePicker,
                canPickSessionShare = isDirectMessage && !peerUserId.isNullOrBlank() && !isExternalConversation,
                contentMenuEnabled = !isExternalConversation,
                onRetryAttachment = viewModel::retryAttachment,
                onRemoveAttachment = viewModel::removeAttachment,
                onRemovePendingCard = { pendingCard = null },
                onCancelEdit = {
                    editingMessage = null
                    draft = ""
                },
                onCancelReply = { replyMessage = null },
                onSend = {
                    if (isReadOnlyConversation) {
                        showComposerHint(readOnlyMessage)
                        return@ImComposer
                    }
                    if (isExternalConversation && (draftAttachments.isNotEmpty() || pendingCard != null)) {
                        showComposerHint(externalConversationMessage)
                        return@ImComposer
                    }
                    if (draftTextTooLong) {
                        showComposerHint(
                            context.getString(
                                R.string.im_composer_message_too_long,
                                draftTextLength,
                                IM_MESSAGE_CONTENT_MAX_LENGTH,
                            ),
                        )
                        return@ImComposer
                    }
                    val editing = editingMessage
                    if (editing != null) {
                        val newText = draft.trim()
                        if (newText.isNotEmpty()) viewModel.editMessage(editing.id, newText)
                        editingMessage = null
                        draft = ""
                    } else {
                        val attachmentStatus = draftAttachments.firstOrNull()?.status
                        val draftAtSend = draft
                        val mentionsAtSend = pendingMentions
                        val replyAtSend = replyMessage
                        val cardAtSend = pendingCard
                        // 关系复核通过后创建独立 pending；确认/失败仍在后台按消息分别收敛。
                        actionScope.launch {
                            val outcome = viewModel.sendDraft(
                                rawText = draftAtSend,
                                mentions = mentionsAtSend,
                                replyToId = replyAtSend?.id,
                                card = cardAtSend,
                            )
                            if (outcome.didEnqueue) {
                                if (draft == draftAtSend) draft = ""
                                if (pendingMentions == mentionsAtSend) pendingMentions = emptyList()
                                if (replyMessage == replyAtSend) replyMessage = null
                                if (pendingCard == cardAtSend) pendingCard = null
                            } else if (attachmentStatus == AttachmentStatus.UPLOADING ||
                                attachmentStatus == AttachmentStatus.PENDING
                            ) {
                                android.widget.Toast.makeText(
                                    context,
                                    R.string.im_attachment_uploading_wait,
                                    android.widget.Toast.LENGTH_SHORT,
                                ).show()
                            } else if (attachmentStatus == AttachmentStatus.ERROR) {
                                android.widget.Toast.makeText(
                                    context,
                                    R.string.im_attachment_fix_before_send,
                                    android.widget.Toast.LENGTH_LONG,
                                ).show()
                            } else if (outcome == ImSendOutcome.REJECTED_TOO_LONG) {
                                android.widget.Toast.makeText(
                                    context,
                                    context.getString(
                                        R.string.im_composer_message_too_long,
                                        getImMessageContentLength(draftAtSend.trim()),
                                        IM_MESSAGE_CONTENT_MAX_LENGTH,
                                    ),
                                    android.widget.Toast.LENGTH_LONG,
                                ).show()
                            } else if (outcome == ImSendOutcome.REJECTED_READ_ONLY) {
                                showComposerHint(
                                    if (isExternalDirectMessage) {
                                        "外部联系人状态已变更，当前会话只读"
                                    } else {
                                        readOnlyMessage
                                    },
                                )
                            }
                        }
                    }
                },
            )
                if (pinnedBannerExpanded) {
                    Box(
                        modifier = Modifier
                            .matchParentSize()
                            .pointerInput(Unit) {
                                detectTapGestures {
                                    pinnedBannerExpanded = false
                                    dismissKeyboard()
                                }
                            },
                    )
                }
            }
            }
        }
    }

    if (showResourcePicker) {
        val organizationId = viewModel.conversationOrganizationId
        if (organizationId != null) {
            ImResourceCardPickerSheet(
                organizationId = organizationId,
                loadResources = { viewModel.loadCardResources() },
                onPick = { card ->
                    showResourcePicker = false
                    pendingCard = card
                    focusComposerNextFrame()
                },
                onDismiss = { showResourcePicker = false },
            )
        }
    }

    if (showContactCardPicker) {
        ImContactCardPickerSheet(
            initialMembers = organizationMembers,
            currentUserId = currentUserId,
            loadMembers = viewModel::loadContactCardMembers,
            onPick = { card ->
                showContactCardPicker = false
                sendCardImmediately(card)
            },
            onDismiss = { showContactCardPicker = false },
        )
    }

    if (showPromptComposer) {
        ImPromptComposeSheet(
            onSend = { promptText, title ->
                showPromptComposer = false
                sendCardImmediately(ImOutgoingCard.prompt(promptText = promptText, title = title))
            },
            onDismiss = { showPromptComposer = false },
        )
    }

    if (showSessionSharePicker && !peerUserId.isNullOrBlank()) {
        ImSessionSharePickerSheet(
            peerName = peerDisplayName ?: "对方",
            peerUserId = peerUserId,
            loadSessions = viewModel::loadShareableSessions,
            onShare = { session, mode, clientRequestId ->
                viewModel.shareSessionToPeer(session, peerUserId, mode, clientRequestId)
            },
            onDismiss = { showSessionSharePicker = false },
        )
    }

    handoffSourceMessage?.let { sourceMessage ->
        ImHandoffComposerSheet(
            sourceMessage = sourceMessage,
            members = detail?.members.orEmpty(),
            currentUserId = currentUserId,
            onSend = { goal, recipientIds ->
                viewModel.createHandoffFromMessage(sourceMessage, goal, recipientIds)
            },
            onDismiss = { handoffSourceMessage = null },
        )
    }

    if (showGroupMentionPicker) {
        GroupMemberMentionSheet(
            members = detail?.members.orEmpty(),
            currentUserId = currentUserId,
            onPickAll = {
                if (draft.lastOrNull() == '@') {
                    draft = draft.dropLast(1) + "@所有人 "
                }
                showGroupMentionPicker = false
            },
            onPick = { member ->
                val mention = ImDraftMention.from(member)
                if (mention != null && draft.lastOrNull() == '@') {
                    if (pendingMentions.none { it.id == mention.id }) {
                        pendingMentions = pendingMentions + mention
                    }
                    draft = draft.dropLast(1) + "@${mention.displayName} "
                }
                showGroupMentionPicker = false
            },
            onAddAgent = if (canAddAgent) {
                {
                    showGroupMentionPicker = false
                    showAgentMentionPicker = true
                }
            } else null,
            onDismiss = { showGroupMentionPicker = false },
        )
    }

    if (showAgentMentionPicker && canAddAgent) {
        AgentMentionPickerSheet(
            isMember = viewModel::canMentionAgentDirectly,
            onSearch = viewModel::searchAgents,
            onLoadWorkspaces = viewModel::loadAgentWorkspaces,
            onPick = viewModel::addAgentToConversation,
            onPicked = { agent ->
                val mention = ImDraftMention.from(agent)
                if (draft.lastOrNull() == '@') {
                    if (pendingMentions.none { it.id == mention.id }) {
                        pendingMentions = pendingMentions + mention
                    }
                    draft = draft.dropLast(1) + "@${mention.displayName} "
                }
            },
            onDismiss = { showAgentMentionPicker = false },
        )
    }

    detail?.let { conversationDetail ->
        if (showMembersSheet) {
            ImConversationMembersSheet(
                detail = conversationDetail,
                currentUserId = currentUserId,
                onHumanClick = { userId, displayName ->
                    showMembersSheet = false
                    openDirectMessage(userId, displayName)
                },
                onAgentClick = {
                    android.widget.Toast.makeText(
                        context,
                        R.string.im_agent_dm_unsupported,
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                },
                onAddAgent = if (canAddAgent) {
                    {
                        showMembersSheet = false
                        showAgentMembershipPicker = true
                    }
                } else null,
                onDismiss = { showMembersSheet = false },
            )
        }
    }

    if (showAgentMembershipPicker && canAddAgent) {
        AgentMembershipPickerSheet(
            existingAgentIds = viewModel.existingAgentIds(),
            onSearch = viewModel::searchAgents,
            onLoadWorkspaces = viewModel::loadAgentWorkspaces,
            onPick = viewModel::addAgentToConversation,
            onPicked = {
                android.widget.Toast.makeText(
                    context,
                    R.string.im_settings_agent_joined,
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            },
            onDismiss = { showAgentMembershipPicker = false },
        )
    }

    agentTaskMessage?.let { sourceMessage ->
        ImAgentTaskComposerSheet(
            onSearchAgents = viewModel::searchAgents,
            onCreate = { agentId, additionalContext ->
                viewModel.createAgentTaskFromMessage(sourceMessage, agentId, additionalContext)
            },
            onCreated = { result ->
                agentTaskMessage = null
                onOpenChatSession(
                    result.sessionId,
                    result.workspaceId,
                    result.title,
                    result.organizationId,
                    result.projectId,
                    result.defaultPrompt,
                )
            },
            onDismiss = { agentTaskMessage = null },
        )
    }

    reactionMessage?.let { message ->
        ImReactionPickerDialog(
            reactions = message.reactions,
            onDismiss = { reactionMessage = null },
            onPick = { emoji ->
                viewModel.store.toggleReaction(message.id, emoji)
                reactionMessage = null
            },
        )
    }

    readReceiptMessage?.let { message ->
        ImReadReceiptDetailSheet(
            message = message,
            progress = viewModel.store.readProgress(message),
            conversationMembers = detail?.members.orEmpty(),
            currentUserId = currentUserId,
            organizationMembers = organizationMembers,
            load = { viewModel.store.fetchReadReceipts(message) },
            onLoaded = { readReceiptDetails[message.id] = it },
            onDismiss = { readReceiptMessage = null },
        )
    }

    replyThreadMessage?.let { selected ->
        val root = selected.replyToId?.let { replyToId ->
            messages.firstOrNull { it.id == replyToId } ?: selected.replyToPreview?.let { preview ->
                // 原消息不在当前分页时，服务端预览仍可提供安全的只读上下文。
                ImMessage(
                    id = replyToId,
                    conversationId = selected.conversationId,
                    senderId = preview.senderId,
                    content = preview.displayText(),
                    messageType = com.tabtin.mobile.data.im.ImMessageType.TEXT,
                    isDeleted = preview.isUnavailable,
                )
            }
        } ?: selected
        ImReplyThreadSheet(
            root = root,
            replies = messages.filter { it.replyToId == root.id },
            onDismiss = { replyThreadMessage = null },
        )
    }

    forwardMessages?.let { selected ->
        ImForwardDialog(
            conversations = imForwardTargets(
                conversations = conversations,
                sourceConversationId = viewModel.conversationId,
                allowExternal = selected.all(ImMessage::isPlainText),
            ),
            organizationMembers = organizationMembers,
            onDismiss = { forwardMessages = null },
            onSelect = { target ->
                actionScope.launch {
                    val result = viewModel.forwardMessages(
                        messages = selected,
                        target = target,
                        sourceConversationName = resolvedConversationTitle,
                    )
                    forwardMessages = null
                    forwardOutcome = result
                }
            },
        )
    }
}

internal fun formatGroupCreatedNotice(raw: String): String? = runCatching {
    val instant = runCatching { Instant.parse(raw) }
        .getOrElse { java.time.OffsetDateTime.parse(raw).toInstant() }
    val formatter = DateTimeFormatter
        .ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
        .withLocale(Locale.getDefault())
        .withZone(ZoneId.systemDefault())
    "群组创建于 ${formatter.format(instant)}"
}.getOrNull()

internal enum class EarlierHistoryLoadAction { NONE, REARM, REQUEST }

internal fun earlierHistoryLoadAction(
    firstVisibleItemIndex: Int,
    canScrollForward: Boolean,
    isUserDragging: Boolean,
    hasSettledInitialPosition: Boolean,
    hasMessages: Boolean,
    hasMoreHistory: Boolean,
    isLoadingHistory: Boolean,
    loadMoreRequested: Boolean,
): EarlierHistoryLoadAction = when {
    firstVisibleItemIndex != 0 -> EarlierHistoryLoadAction.REARM
    isUserDragging &&
        canScrollForward &&
        hasSettledInitialPosition &&
        hasMessages &&
        hasMoreHistory &&
        !isLoadingHistory &&
        !loadMoreRequested -> EarlierHistoryLoadAction.REQUEST
    else -> EarlierHistoryLoadAction.NONE
}

@Composable
private fun LoadMoreRow(isLoading: Boolean, onClick: () -> Unit) {
    Box(modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.xs), contentAlignment = Alignment.Center) {
        if (isLoading) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        } else {
            TextButton(onClick = onClick) {
                Text(stringResource(R.string.im_load_earlier), style = MaterialTheme.typography.labelMedium)
            }
        }
    }

}

@Composable
private fun ImConversationEmptyOrError(
    error: String?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize().padding(TTSpacing.xl), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (error != null) {
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.size(TTSpacing.md))
                TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
            } else {
                Text(
                    text = stringResource(R.string.im_no_messages),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** 单条已确认消息：撤回态占位；否则气泡 + 表情条 + 页脚，长按气泡弹菜单。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ImMessageCell(
    message: ImMessage,
    handoffRefreshVersion: Int,
    sessionShareRefreshVersion: Int,
    previousMessage: ImMessage?,
    isMine: Boolean,
    currentUserId: String?,
    organizationMembers: List<OrganizationMember>,
    conversationMembers: List<ImMember>,
    isDm: Boolean,
    onOpenSenderDirectMessage: (String, String) -> Unit,
    isReadByPeer: Boolean,
    readProgress: ImReadReceipt?,
    onOpenReadReceipts: () -> Unit,
    replyCount: Int,
    onToggleReaction: (String) -> Unit,
    onAddReaction: () -> Unit,
    onReply: () -> Unit,
    onOpenReplyThread: () -> Unit,
    onForward: () -> Unit,
    onTogglePin: () -> Unit,
    canCreateAgentTask: Boolean,
    onCreateAgentTask: () -> Unit,
    canCreateHandoff: Boolean,
    onCreateHandoff: () -> Unit,
    onCopy: () -> Unit,
    onBeginEdit: () -> Unit,
    onRecall: () -> Unit,
    loadAttachment: suspend (ImMessage) -> com.tabtin.mobile.data.im.ImAttachmentUrl?,
    onOpenCard: (ImResourceCard, String, ImResourceCardPreview?) -> Unit,
    loadResourcePreview: suspend (ImResourceCard) -> ImResourceCardPreviewResult,
    onRequestResourceAccess: suspend (ImMessage, ImResourceCard) -> Boolean,
    onOpenSessionShare: (ImSessionShareCard) -> Unit,
    loadSessionShare: suspend (ImSessionShareCard) -> ImSessionShareCard,
    onRevokeSessionShare: suspend (ImSessionShareCard) -> Result<ImSessionShareCard>,
    onResumeSessionShare: suspend (ImSessionShareCard) -> Result<ImSessionShareCard>,
    loadSessionShareV2: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onAcceptSessionShareV2: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onRetrySessionShareV2Delivery: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onOpenSessionShareV2: (ImSessionShareV2Detail) -> Unit,
    onSessionShareV2ActionError: (String) -> Unit,
    loadSessionContinuation: suspend (ImSessionContinuationCard) -> Result<ImSessionContinuationDetail>,
    loadContinuationExecutionTargets:
        suspend (String) -> Result<ImConversationViewModel.ContinuationExecutionTargets>,
    createTaskFromSessionContinuation:
        suspend (ImSessionContinuationCard, String, String, String) -> Result<ImSessionContinuationDetail>,
    onOpenSessionContinuation: (ImSessionContinuationDetail) -> Unit,
    onSessionContinuationActionError: (String) -> Unit,
    loadHandoff: suspend (String) -> Result<ImHandoffPackage>,
    markHandoffTakingOver: suspend (String) -> Result<ImHandoffPackage>,
    revokeHandoff: suspend (String) -> Result<ImHandoffPackage>,
    takeOverHandoff: suspend (String, String, String) -> Result<ChatSession>,
    loadHandoffAttachment: suspend (String) -> com.tabtin.mobile.data.im.ImAttachmentUrl?,
    onOpenHandoffReference: (ImHandoffReference) -> Unit,
    onOpenHandoffSession: (ChatSession) -> Unit,
    onHandoffActionError: (String) -> Unit,
    onUsePrompt: (ImPromptCard) -> Unit,
    onDismissKeyboard: () -> Unit,
) {
    val showDateDivider = ImMessageTimeline.shouldShowDateDivider(message, previousMessage)
    val isGroupStart = ImMessageTimeline.isGroupStart(message, previousMessage)
    val senderMember = conversationMembers.firstOrNull { member ->
        if (message.isFromAgent) {
            member.isAgent && member.agentId == message.senderId
        } else {
            !member.isAgent && member.userId == message.senderId
        }
    }
    val senderDisplayName = if (message.isFromAgent) {
        senderMember?.displayName?.takeIf { it.isNotBlank() }
            ?: message.senderName.takeIf { it.isNotBlank() }
            ?: "Agent"
    } else {
        ImMemberDisplayPolicy.resolvedDisplayName(
            userId = message.senderId,
            snapshotName = senderMember?.displayName?.takeIf { it.isNotBlank() } ?: message.senderName,
            organizationMembers = organizationMembers,
        ).ifBlank { message.senderId }
    }
    val senderAvatarUrl = if (message.isFromAgent) {
        senderMember?.avatar?.takeIf { it.isNotBlank() }
    } else {
        ImMemberDisplayPolicy.resolvedAvatar(
            userId = message.senderId,
            snapshotAvatar = senderMember?.avatar,
            organizationMembers = organizationMembers,
        ).takeIf { it.isNotBlank() }
    }
    val showsSenderName = ImMessageTimeline.showsIncomingSenderName(
        message = message,
        previous = previousMessage,
        isDm = isDm,
        currentUserId = currentUserId,
    ) && senderDisplayName.isNotEmpty()
    val canOpenSenderDirectMessage = ImMessageTimeline.canOpenSenderDirectMessage(
        message = message,
        isDm = isDm,
        currentUserId = currentUserId,
    ) && senderMember?.isAgent != true
    val clock = if (isGroupStart) ImMessageTimeline.formatMessageClock(message.createdAt) else null
    val todayLabel = stringResource(R.string.common_today)
    val yesterdayLabel = stringResource(R.string.common_yesterday)
    val isSystem = message.messageType == com.tabtin.mobile.data.im.ImMessageType.SYSTEM ||
        message.senderId == "system"
    var menuOpen by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val copyMessage: () -> Unit = {
        clipboard.setText(AnnotatedString(message.content))
        onCopy()
    }
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val sideReadProgress = when {
        !isMine -> null
        isDm && shouldShowDmReadIndicator(isMine, isReadByPeer) ->
            ImReadProgressUi(readCount = if (isReadByPeer) 1 else 0, recipientCount = 1)
        !isDm && readProgress != null && readProgress.recipientCount > 0 -> ImReadProgressUi(
            readCount = readProgress.readCount.coerceIn(0, readProgress.recipientCount),
            recipientCount = readProgress.recipientCount,
        )
        else -> null
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = if (isGroupStart && !showDateDivider) 6.dp else 0.dp),
    ) {
        if (showDateDivider) {
            ImMessageDateDivider(
                label = ImMessageTimeline.formatDateDivider(
                    raw = message.createdAt,
                    todayLabel = todayLabel,
                    yesterdayLabel = yesterdayLabel,
                ),
            )
        }

        // 系统消息可能来自新数据的 `message_type=SYSTEM`，也可能是旧数据仅保留 `sender_id=system`。
        // 两者都不能按普通成员消息渲染或暴露长按操作。
        if (isSystem) {
            ImSystemMessageBubble(content = message.content)
            return@Column
        }
        if (message.isDeleted) {
            ImRecalledBubble(isMine = isMine)
            return@Column
        }

        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = if (isMine) Alignment.End else Alignment.Start,
        ) {
            if (replyCount > 0) {
                Row(
                    modifier = Modifier
                        .clip(CircleShape)
                        .clickable(onClick = onOpenReplyThread)
                        .padding(horizontal = TTSpacing.xs, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        imageVector = Icons.Default.ChatBubbleOutline,
                        contentDescription = null,
                        tint = accent,
                        modifier = Modifier.size(14.dp),
                    )
                    Text("$replyCount 条回复", style = MaterialTheme.typography.labelSmall, color = accent)
                }
            }

            // 私信 / 自己发的消息没有发送者名，组首时分单独一行常显（桌面靠 hover）。
            if (!clock.isNullOrEmpty() && !showsSenderName) {
                ImMessageClockLabel(clock = clock, isMine = isMine)
            }

            Box {
                ImBubbleRow(
                    isMine = isMine,
                    modifier = Modifier.fillMaxWidth(),
                    showIncomingAvatar = ImMessageTimeline.showsIncomingAvatar(
                        message = message,
                        previous = previousMessage,
                        currentUserId = currentUserId,
                    ),
                    incomingAvatar = if (isMine) null else {
                        {
                            IdentityColorAvatar(
                                name = senderDisplayName,
                                seed = message.senderId,
                                imageUrl = senderAvatarUrl,
                                size = 36.dp,
                                modifier = Modifier.then(
                                    if (canOpenSenderDirectMessage) {
                                        Modifier.clickable {
                                            onOpenSenderDirectMessage(message.senderId, senderDisplayName)
                                        }
                                    } else {
                                        Modifier
                                    },
                                ),
                            )
                        }
                    },
                ) {
                    if (isMine && sideReadProgress != null) {
                        ImReadProgressIndicator(
                            readCount = sideReadProgress.readCount,
                            recipientCount = sideReadProgress.recipientCount,
                            onClick = if (isDm) null else onOpenReadReceipts,
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                    }
                    Column(
                        horizontalAlignment = if (isMine) Alignment.End else Alignment.Start,
                        modifier = Modifier.combinedClickable(
                            onClick = onDismissKeyboard,
                            onLongClick = { menuOpen = true },
                        ),
                    ) {
                        if (showsSenderName) {
                            ImMessageSenderLabel(
                                senderName = senderDisplayName,
                                isAgent = message.isFromAgent,
                                clock = clock,
                            )
                            Spacer(modifier = Modifier.size(2.dp))
                        }
                        ImBubbleBody(
                            message = message,
                            handoffRefreshVersion = handoffRefreshVersion,
                            sessionShareRefreshVersion = sessionShareRefreshVersion,
                            isMine = isMine,
                            currentUserId = currentUserId,
                            organizationMembers = organizationMembers,
                            loadAttachment = loadAttachment,
                            onOpenCard = onOpenCard,
                            loadResourcePreview = loadResourcePreview,
                            onRequestResourceAccess = { card -> onRequestResourceAccess(message, card) },
                            onOpenSessionShare = onOpenSessionShare,
                            loadSessionShare = loadSessionShare,
                            onRevokeSessionShare = onRevokeSessionShare,
                            onResumeSessionShare = onResumeSessionShare,
                            loadSessionShareV2 = loadSessionShareV2,
                            onAcceptSessionShareV2 = onAcceptSessionShareV2,
                            onRetrySessionShareV2Delivery = onRetrySessionShareV2Delivery,
                            onOpenSessionShareV2 = onOpenSessionShareV2,
                            onSessionShareV2ActionError = onSessionShareV2ActionError,
                            loadSessionContinuation = loadSessionContinuation,
                            loadContinuationExecutionTargets = loadContinuationExecutionTargets,
                            createTaskFromSessionContinuation = createTaskFromSessionContinuation,
                            onOpenSessionContinuation = onOpenSessionContinuation,
                            onSessionContinuationActionError = onSessionContinuationActionError,
                            loadHandoff = loadHandoff,
                            markHandoffTakingOver = markHandoffTakingOver,
                            revokeHandoff = revokeHandoff,
                            takeOverHandoff = takeOverHandoff,
                            loadHandoffAttachment = loadHandoffAttachment,
                            onOpenHandoffReference = onOpenHandoffReference,
                            onOpenHandoffSession = onOpenHandoffSession,
                            onHandoffActionError = onHandoffActionError,
                            onUsePrompt = onUsePrompt,
                            onOpenReplyThread = onOpenReplyThread,
                            onLongClick = { menuOpen = true },
                        )
                    }
                    if (!isMine && sideReadProgress != null) {
                        Spacer(modifier = Modifier.width(6.dp))
                        ImReadProgressIndicator(
                            readCount = sideReadProgress.readCount,
                            recipientCount = sideReadProgress.recipientCount,
                            onClick = if (isDm) null else onOpenReadReceipts,
                        )
                    }
                }
                ImMessageActionSheet(
                    message = message,
                    isMine = isMine,
                    expanded = menuOpen,
                    onExpandedChange = { menuOpen = it },
                    onAddReaction = onAddReaction,
                    onReply = onReply,
                    onForward = onForward,
                    onTogglePin = onTogglePin,
                    canCreateAgentTask = canCreateAgentTask,
                    onCreateAgentTask = onCreateAgentTask,
                    canCreateHandoff = canCreateHandoff,
                    onCreateHandoff = onCreateHandoff,
                    onCopyMessage = copyMessage,
                    onBeginEdit = onBeginEdit,
                    onRecall = onRecall,
                )
            }

            ImReactionBar(
                reactions = message.reactions,
                reactionOrder = message.reactionOrder,
                currentUserId = currentUserId,
                isMine = isMine,
                onToggle = onToggleReaction,
            )

            ImMessageFooter(
                showEdited = message.isEdited,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImMessageActionSheet(
    message: ImMessage,
    isMine: Boolean,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onAddReaction: () -> Unit,
    onReply: () -> Unit,
    onForward: () -> Unit,
    onTogglePin: () -> Unit,
    canCreateAgentTask: Boolean,
    onCreateAgentTask: () -> Unit,
    canCreateHandoff: Boolean,
    onCreateHandoff: () -> Unit,
    onCopyMessage: () -> Unit,
    onBeginEdit: () -> Unit,
    onRecall: () -> Unit,
) {
    if (expanded) {
        TTBottomSheet(onDismissRequest = { onExpandedChange(false) }) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 12.dp),
            ) {
                Text(
                    text = stringResource(R.string.im_action_sheet_title),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                )
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 420.dp),
                ) {
                    item {
                        ImMessageActionSheetItem(
                            label = stringResource(R.string.im_action_add_reaction),
                            onClick = { onAddReaction(); onExpandedChange(false) },
                        )
                    }
                    item {
                        ImMessageActionSheetItem(
                            label = stringResource(R.string.im_action_reply),
                            onClick = { onReply(); onExpandedChange(false) },
                        )
                    }
                    // 授权卡和无法安全重建的未知卡都不提供转发，避免只发出降级文本。
                    if (message.canForward) {
                        item {
                            ImMessageActionSheetItem(
                                label = stringResource(R.string.im_action_forward),
                                onClick = { onForward(); onExpandedChange(false) },
                            )
                        }
                    }
                    if (canCreateAgentTask) {
                        item {
                            ImMessageActionSheetItem(
                                label = stringResource(R.string.im_action_ask_agent),
                                onClick = { onCreateAgentTask(); onExpandedChange(false) },
                            )
                        }
                    }
                    if (canCreateHandoff) {
                        item {
                            ImMessageActionSheetItem(
                                label = stringResource(R.string.im_action_create_handoff),
                                onClick = { onCreateHandoff(); onExpandedChange(false) },
                            )
                        }
                    }
                    item {
                        ImMessageActionSheetItem(
                            label = stringResource(if (message.isPinned) R.string.im_action_unpin_message else R.string.im_action_pin_message),
                            onClick = { onTogglePin(); onExpandedChange(false) },
                        )
                    }
                    if (message.isPlainText && message.content.isNotEmpty()) {
                        item {
                            ImMessageActionSheetItem(
                                label = stringResource(R.string.im_action_copy),
                                onClick = { onCopyMessage(); onExpandedChange(false) },
                            )
                        }
                    }
                    if (isMine && imWithinRecallWindow(message)) {
                        item {
                            ImMessageActionSheetItem(
                                label = stringResource(R.string.im_action_recall),
                                onClick = { onRecall(); onExpandedChange(false) },
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                    if (isMine && message.isPlainText) {
                        item {
                            ImMessageActionSheetItem(
                                label = stringResource(R.string.im_action_edit),
                                onClick = { onBeginEdit(); onExpandedChange(false) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ImMessageActionSheetItem(
    label: String,
    onClick: () -> Unit,
    color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurface,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = color,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImAgentTaskComposerSheet(
    onSearchAgents: suspend (String) -> Result<List<ImAgentSummary>>,
    onCreate: suspend (String, String) -> Result<ImAgentTaskThreadResult>,
    onCreated: (ImAgentTaskThreadResult) -> Unit,
    onDismiss: () -> Unit,
) {
    var agents by remember { mutableStateOf<List<ImAgentSummary>>(emptyList()) }
    var selectedAgentId by remember { mutableStateOf<String?>(null) }
    var additionalContext by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(true) }
    var isCreating by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        onSearchAgents("")
            .onSuccess { loaded ->
                agents = loaded
                selectedAgentId = loaded.firstOrNull()?.id
            }
            .onFailure { errorMessage = it.message }
        isLoading = false
    }

    TTBottomSheet(onDismissRequest = { if (!isCreating) onDismiss() }) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Text("询问 Agent", style = MaterialTheme.typography.titleLarge)
            Text(
                "所选消息及其回复会作为上下文，并在你的执行 Workspace 中创建一次 Agent 问询。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            when {
                isLoading -> Box(
                    modifier = Modifier.fillMaxWidth().padding(TTSpacing.lg),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }

                agents.isEmpty() -> Text(
                    errorMessage ?: "没有可用的 Agent",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                else -> LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp)) {
                    items(agents, key = { it.id }) { agent ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = !isCreating) { selectedAgentId = agent.id }
                                .padding(vertical = TTSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                        ) {
                            Icon(Icons.Default.SmartToy, contentDescription = null)
                            Text(agent.displayName, modifier = Modifier.weight(1f))
                            if (selectedAgentId == agent.id) {
                                Icon(Icons.Default.Check, contentDescription = "已选择")
                            }
                        }
                    }
                }
            }
            TextField(
                value = additionalContext,
                onValueChange = { additionalContext = it },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isCreating,
                label = { Text("补充要求（可选）") },
                minLines = 2,
                maxLines = 5,
            )
            errorMessage?.takeIf { agents.isNotEmpty() }?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss, enabled = !isCreating) { Text("取消") }
                Button(
                    onClick = {
                        val agentId = selectedAgentId ?: return@Button
                        isCreating = true
                        errorMessage = null
                        scope.launch {
                            onCreate(agentId, additionalContext)
                                .onSuccess(onCreated)
                                .onFailure { errorMessage = it.message ?: "询问 Agent 失败" }
                            isCreating = false
                        }
                    },
                    enabled = selectedAgentId != null && !isCreating,
                ) {
                    if (isCreating) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Text("发送")
                    }
                }
            }
        }
    }
}

/** 群消息阅读成员明细，与 Electron 一样分开展示已读和未读成员。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImReadReceiptDetailSheet(
    message: ImMessage,
    progress: ImReadReceipt?,
    conversationMembers: List<ImMember>,
    currentUserId: String?,
    organizationMembers: List<OrganizationMember>,
    load: suspend () -> ImMessageReadReceipts,
    onLoaded: (ImMessageReadReceipts) -> Unit,
    onDismiss: () -> Unit,
) {
    var receipts by remember(message.id) { mutableStateOf<ImMessageReadReceipts?>(null) }
    var errorMessage by remember(message.id) { mutableStateOf<String?>(null) }
    var reloadToken by remember(message.id) { mutableStateOf(0) }

    LaunchedEffect(message.id, reloadToken) {
        receipts = null
        errorMessage = null
        runCatching { load() }
            .onSuccess {
                onLoaded(it)
                val enriched = ImMemberDisplayPolicy.enrichedReadReceipts(it, organizationMembers)
                receipts = ImHumanReadReceiptPolicy.project(
                    progress = progress,
                    detail = enriched,
                    members = conversationMembers,
                    currentUserId = currentUserId,
                    senderId = message.senderId,
                ).detail
            }
            .onFailure { errorMessage = it.message ?: "阅读状态加载失败" }
    }

    TTBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.lg),
        ) {
            Text(
                text = "阅读状态",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.size(TTSpacing.md))
            when {
                receipts != null -> {
                    val value = requireNotNull(receipts)
                    if (value.readers.isEmpty() && value.unreaders.isEmpty()) {
                        Text(
                            text = "暂无阅读明细",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = TTSpacing.xl),
                        )
                    } else {
                        LazyColumn(modifier = Modifier.heightIn(max = 520.dp)) {
                            item { ImReadReceiptSectionHeader("已读", value.readers.size) }
                            items(value.readers, key = { "read-${it.userId}" }) { member ->
                                ImReadReceiptMemberRow(member)
                            }
                            item { ImReadReceiptSectionHeader("未读", value.unreaders.size) }
                            items(value.unreaders, key = { "unread-${it.userId}" }) { member ->
                                ImReadReceiptMemberRow(member)
                            }
                        }
                    }
                }
                errorMessage != null -> {
                    Text(
                        text = errorMessage.orEmpty(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.size(TTSpacing.sm))
                    TextButton(onClick = { reloadToken += 1 }) { Text("重试") }
                }
                else -> Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.xl),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
        }
    }
}

@Composable
private fun ImReadReceiptSectionHeader(title: String, count: Int) {
    Text(
        text = "$title（$count）",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(top = TTSpacing.md, bottom = TTSpacing.xs),
    )
}

@Composable
private fun ImReadReceiptMemberRow(member: ImReadReceiptMember) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        TTAvatar(
            name = member.displayName,
            imageUrl = member.avatar,
            size = 36.dp,
            shape = CircleShape,
        )
        Text(
            text = member.displayName,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 气泡主体：图片/文件走附件，资源卡走卡片，其余走文本。 */
@Composable
private fun ImBubbleBody(
    message: ImMessage,
    handoffRefreshVersion: Int,
    sessionShareRefreshVersion: Int,
    isMine: Boolean,
    currentUserId: String?,
    organizationMembers: List<OrganizationMember>,
    loadAttachment: suspend (ImMessage) -> com.tabtin.mobile.data.im.ImAttachmentUrl?,
    onOpenCard: (ImResourceCard, String, ImResourceCardPreview?) -> Unit,
    loadResourcePreview: suspend (ImResourceCard) -> ImResourceCardPreviewResult,
    onRequestResourceAccess: suspend (ImResourceCard) -> Boolean,
    onOpenSessionShare: (ImSessionShareCard) -> Unit,
    loadSessionShare: suspend (ImSessionShareCard) -> ImSessionShareCard,
    onRevokeSessionShare: suspend (ImSessionShareCard) -> Result<ImSessionShareCard>,
    onResumeSessionShare: suspend (ImSessionShareCard) -> Result<ImSessionShareCard>,
    loadSessionShareV2: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onAcceptSessionShareV2: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onRetrySessionShareV2Delivery: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onOpenSessionShareV2: (ImSessionShareV2Detail) -> Unit,
    onSessionShareV2ActionError: (String) -> Unit,
    loadSessionContinuation: suspend (ImSessionContinuationCard) -> Result<ImSessionContinuationDetail>,
    loadContinuationExecutionTargets:
        suspend (String) -> Result<ImConversationViewModel.ContinuationExecutionTargets>,
    createTaskFromSessionContinuation:
        suspend (ImSessionContinuationCard, String, String, String) -> Result<ImSessionContinuationDetail>,
    onOpenSessionContinuation: (ImSessionContinuationDetail) -> Unit,
    onSessionContinuationActionError: (String) -> Unit,
    loadHandoff: suspend (String) -> Result<ImHandoffPackage>,
    markHandoffTakingOver: suspend (String) -> Result<ImHandoffPackage>,
    revokeHandoff: suspend (String) -> Result<ImHandoffPackage>,
    takeOverHandoff: suspend (String, String, String) -> Result<ChatSession>,
    loadHandoffAttachment: suspend (String) -> com.tabtin.mobile.data.im.ImAttachmentUrl?,
    onOpenHandoffReference: (ImHandoffReference) -> Unit,
    onOpenHandoffSession: (ChatSession) -> Unit,
    onHandoffActionError: (String) -> Unit,
    onUsePrompt: (ImPromptCard) -> Unit,
    onOpenReplyThread: () -> Unit,
    onLongClick: () -> Unit,
) {
    val resourceCard = message.resourceCard
    val sessionShareCard = message.sessionShareCard
    val sessionShareV2Card = message.sessionShareV2Card
    val sessionContinuationCard = message.sessionContinuationCard
    val handoffCard = message.handoffCard
    val parsedCard = message.metadata?.card
    val inlineReplyPreview = message.replyToPreview
    val usesInlineReplyPreview = inlineReplyPreview != null &&
        !message.isImageAttachment &&
        !message.isFileAttachment &&
        resourceCard == null &&
        sessionShareCard == null &&
        sessionShareV2Card == null &&
        sessionContinuationCard == null &&
        handoffCard == null &&
        parsedCard == null &&
        !message.hasStructuredCard
    Column(horizontalAlignment = if (isMine) Alignment.End else Alignment.Start) {
        imForwardSourceText(message.metadata?.forwardedFrom, currentUserId)?.let { sourceText ->
            Row(
                modifier = Modifier
                    .padding(horizontal = TTSpacing.xs)
                    .padding(bottom = TTSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Reply,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = sourceText,
                    style = TTFonts.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        message.replyToPreview?.let { preview ->
            if (!usesInlineReplyPreview) {
                ImReplyPreview(preview = preview, onClick = onOpenReplyThread)
                Spacer(Modifier.size(4.dp))
            }
        }
        when {
        message.isImageAttachment || message.isFileAttachment -> {
            Column(horizontalAlignment = if (isMine) Alignment.End else Alignment.Start) {
                ImAttachmentContent(message = message, isMine = isMine, loadAttachment = loadAttachment)
                if (message.content.isNotEmpty() && message.codexSessionCard == null) {
                    Spacer(Modifier.size(TTSpacing.xs))
                    ImTextBubble(content = message.content, isMine = isMine, isAgent = message.isFromAgent)
                }
            }
        }
        handoffCard != null -> {
            ImHandoffCardContent(
                snapshot = handoffCard,
                refreshVersion = handoffRefreshVersion,
                currentUserId = currentUserId,
                conversationMembers = organizationMembers,
                loadDetail = loadHandoff,
                loadExecutionTargets = loadContinuationExecutionTargets,
                markTakingOver = markHandoffTakingOver,
                revoke = revokeHandoff,
                takeOver = takeOverHandoff,
                loadAttachment = loadHandoffAttachment,
                onOpenReference = onOpenHandoffReference,
                onOpenSession = onOpenHandoffSession,
                onActionError = onHandoffActionError,
                onLongClick = onLongClick,
            )
        }
        resourceCard != null -> {
            val snapshotDisplayName = resourceCard.displayName(message.content)
            val displayName = if (resourceCard.type == ImResourceCardType.CONTACT) {
                ImMemberDisplayPolicy.resolvedDisplayName(
                    userId = resourceCard.userId,
                    snapshotName = snapshotDisplayName,
                    organizationMembers = organizationMembers,
                ).ifBlank { snapshotDisplayName }
            } else {
                snapshotDisplayName
            }
            val contactAvatarUrl = ImMemberDisplayPolicy.resolvedAvatar(
                userId = resourceCard.userId,
                snapshotAvatar = resourceCard.avatar,
                organizationMembers = organizationMembers,
            )
            Column(horizontalAlignment = if (isMine) Alignment.End else Alignment.Start) {
                ImResourceCardContent(
                    card = resourceCard,
                    displayName = displayName,
                    contactAvatarUrl = contactAvatarUrl,
                    currentUserId = currentUserId,
                    onClick = { preview -> onOpenCard(resourceCard, displayName, preview) },
                    onLongClick = onLongClick,
                    loadPreview = loadResourcePreview,
                    onRequestAccess = { onRequestResourceAccess(resourceCard) },
                )
            }
        }
        sessionShareCard != null -> {
            ImSessionShareCardContent(
                snapshot = sessionShareCard,
                refreshVersion = sessionShareRefreshVersion,
                isMine = isMine,
                currentUserId = currentUserId,
                loadDetail = loadSessionShare,
                onOpen = onOpenSessionShare,
                onRevoke = onRevokeSessionShare,
                onResume = onResumeSessionShare,
                onLongClick = onLongClick,
            )
        }
        sessionShareV2Card != null -> {
                ImSessionShareV2CardContent(
                    snapshot = sessionShareV2Card,
                    refreshVersion = sessionShareRefreshVersion,
                    messageSenderName = message.senderName,
                    currentUserId = currentUserId,
                    organizationMembers = organizationMembers,
                    loadDetail = loadSessionShareV2,
                    onAccept = onAcceptSessionShareV2,
                    onRetryDelivery = onRetrySessionShareV2Delivery,
                    onOpen = onOpenSessionShareV2,
                    onActionError = onSessionShareV2ActionError,
                    onLongClick = onLongClick,
                )
        }
        sessionContinuationCard != null -> {
            ImSessionContinuationCardContent(
                snapshot = sessionContinuationCard,
                messageSenderName = message.senderName,
                currentUserId = currentUserId,
                organizationMembers = organizationMembers,
                loadDetail = loadSessionContinuation,
                loadExecutionTargets = loadContinuationExecutionTargets,
                createTask = createTaskFromSessionContinuation,
                onOpen = onOpenSessionContinuation,
                onActionError = onSessionContinuationActionError,
                onLongClick = onLongClick,
            )
        }
        parsedCard?.promptCard != null -> {
            Column(horizontalAlignment = if (isMine) Alignment.End else Alignment.Start) {
                ImResourceCardContent(card = parsedCard, onUsePrompt = onUsePrompt, onLongClick = onLongClick)
            }
        }
        message.hasStructuredCard -> ImUnsupportedCardBubble(message = message)
            message.metadata?.kind == "tabtin_ref" && message.content.isEmpty() -> {
                ImTextBubble(
                    content = "消息内容暂不可用",
                    isMine = isMine,
                    isAgent = message.isFromAgent,
                    replyPreview = inlineReplyPreview,
                    onOpenReplyPreview = onOpenReplyThread,
                )
            }
            else -> ImTextBubble(
                content = message.content,
                isMine = isMine,
                isAgent = message.isFromAgent,
                replyPreview = inlineReplyPreview,
                onOpenReplyPreview = onOpenReplyThread,
            )
        }
    }
}

internal fun imForwardSourceText(source: ImForwardedFrom?, currentUserId: String?): String? {
    val senderId = source?.originalSenderId?.trim().orEmpty()
    val currentId = currentUserId?.trim().orEmpty()
    if (senderId.isNotEmpty() && senderId == currentId) return null

    val senderName = source?.originalSenderName?.trim().orEmpty()
    if (senderId.isEmpty() && senderName.isEmpty()) return null
    return "转发自 ${senderName.ifEmpty { "未知成员" }}"
}

@Composable
private fun ImReplyPreview(
    preview: com.tabtin.mobile.data.im.ImReplyPreview,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .widthIn(max = 260.dp)
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Box(
            modifier = Modifier
                .size(width = 2.dp, height = 34.dp)
                .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)),
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = "回复",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
                maxLines = 1,
            )
            Text(
                text = preview.displayText(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ImSessionShareV2CardContent(
    snapshot: ImSessionShareV2Card,
    refreshVersion: Int,
    messageSenderName: String,
    currentUserId: String?,
    organizationMembers: List<OrganizationMember>,
    loadDetail: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onAccept: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onRetryDelivery: suspend (ImSessionShareV2Card) -> Result<ImSessionShareV2Detail>,
    onOpen: (ImSessionShareV2Detail) -> Unit,
    onActionError: (String) -> Unit,
    onLongClick: () -> Unit,
) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val cachedDetail = remember(snapshot.objectId, snapshot.version, refreshVersion) {
        ImCardStatusMemoryCache.cachedSessionShareV2Detail(snapshot.objectId, snapshot.version)
    }
    var detail by remember(snapshot.objectId, snapshot.version, refreshVersion) { mutableStateOf(cachedDetail) }
    var loading by remember(snapshot.objectId, snapshot.version, refreshVersion) { mutableStateOf(cachedDetail == null) }
    var joining by remember(snapshot.objectId) { mutableStateOf(false) }
    var loadFailed by remember(snapshot.objectId) { mutableStateOf(false) }
    LaunchedEffect(snapshot.objectId, snapshot.version, refreshVersion) {
        ImCardStatusMemoryCache.cachedSessionShareV2Detail(snapshot.objectId, snapshot.version)?.let {
            detail = it
            loading = false
            loadFailed = false
            return@LaunchedEffect
        }
        loading = true
        loadFailed = false
        loadDetail(snapshot)
            .onSuccess {
                detail = it
                ImCardStatusMemoryCache.putSessionShareV2Detail(it)
            }
            .onFailure { loadFailed = true }
        loading = false
    }
    val relation = sessionShareV2Relation(
        snapshot = snapshot,
        messageSenderName = messageSenderName,
        currentUserId = currentUserId,
        organizationMembers = organizationMembers,
    )
    val relationText = when (relation.kind) {
        ImSessionShareV2RelationKind.SENT -> relation.displayName?.let {
            stringResource(R.string.im_session_share_v2_relation_sent_named, it)
        } ?: stringResource(R.string.im_session_share_v2_relation_sent)
        ImSessionShareV2RelationKind.RECEIVED -> relation.displayName?.let {
            stringResource(R.string.im_session_share_v2_relation_received_named, it)
        } ?: stringResource(R.string.im_session_share_v2_relation_received)
        ImSessionShareV2RelationKind.OTHER -> stringResource(R.string.im_session_share_v2_relation_other)
    }
    val cardLabel = stringResource(R.string.im_session_share_v2_label)
    val phase = detail?.phase
    val actionText = when {
        joining -> stringResource(R.string.im_session_share_v2_joining)
        loadFailed -> stringResource(R.string.common_reload)
        detail?.role == "owner" && phase == "deliveryUnconfirmed" -> "重新发送"
        detail?.role == "owner" -> if (detail?.actions?.canOpen == true) "打开任务" else "等待对方加入"
        detail?.actions?.canJoin == true -> stringResource(R.string.im_session_share_v2_join)
        detail?.actions?.canOpen == true -> stringResource(R.string.im_session_share_v2_open)
        loading -> stringResource(R.string.common_loading)
        phase == "stopped" || detail?.status == "revoked" -> stringResource(R.string.im_session_share_v2_stopped)
        phase == "ineligible" -> stringResource(R.string.im_session_share_v2_ineligible)
        else -> stringResource(R.string.im_session_share_v2_status_unavailable)
    }
    val actionEnabled = !joining && (
        loadFailed ||
            (detail?.role == "owner" && phase == "deliveryUnconfirmed") ||
            (detail?.role == "owner" && detail?.actions?.canOpen == true) ||
            detail?.actions?.canJoin == true ||
            (detail?.actions?.canOpen == true && !detail?.sessionId.isNullOrBlank())
        )
    val permissionText = when (detail?.accessMode) {
        "collaborate" -> stringResource(R.string.im_session_share_v2_permission_collaborate)
        "fork" -> stringResource(R.string.im_session_share_v2_permission_fork)
        "view" -> stringResource(R.string.im_session_share_v2_permission_view)
        else -> stringResource(R.string.im_session_share_v2_category)
    }
    val handleAction = {
        when {
            loadFailed -> {
                scope.launch {
                    loading = true
                    loadFailed = false
                    loadDetail(snapshot)
                        .onSuccess {
                            detail = it
                            ImCardStatusMemoryCache.putSessionShareV2Detail(it)
                        }
                        .onFailure {
                            loadFailed = true
                            onActionError(it.message ?: "共享任务详情不可用")
                        }
                    loading = false
                }
            }
            detail?.actions?.canJoin == true -> {
                scope.launch {
                    joining = true
                    onAccept(snapshot)
                        .onSuccess {
                            detail = it
                            ImCardStatusMemoryCache.putSessionShareV2Detail(it)
                        }
                        .onFailure { onActionError(it.message ?: "确认加入任务失败") }
                    joining = false
                }
            }
            detail?.role == "owner" && phase == "deliveryUnconfirmed" -> {
                scope.launch {
                    loading = true
                    onRetryDelivery(snapshot)
                        .onSuccess {
                            detail = it
                            ImCardStatusMemoryCache.putSessionShareV2Detail(it)
                        }
                        .onFailure { onActionError(it.message ?: "重新发送共享任务失败") }
                    loading = false
                }
            }
            detail?.actions?.canOpen == true -> detail?.let(onOpen)
        }
    }
    val shape = RoundedCornerShape(ImStructuredCardLayout.cornerRadius)

    Column(
        modifier = Modifier
            .width(ImStructuredCardLayout.width)
            .height(ImStructuredCardLayout.height)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f))
            .border(1.dp, accent.copy(alpha = 0.38f), shape)
            .combinedClickable(
                onClick = { if (actionEnabled) handleAction() },
                onLongClick = onLongClick,
            )
            .semantics {
                contentDescription = "$cardLabel，${snapshot.title}，$relationText"
            },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImStructuredCardLayout.bodyHeight)
                .padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    Icon(Icons.Default.Group, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
                    Text(
                        text = cardLabel,
                        style = MaterialTheme.typography.labelLarge,
                        color = accent,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Text(
                    text = stringResource(R.string.im_session_share_v2_version, snapshot.version),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = snapshot.title,
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = relationText,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(TTRadius.interactive))
                    .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.62f))
                    .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                Icon(
                    Icons.Default.Group,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = permissionText,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        HorizontalDivider(color = imBorderLight())
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImStructuredCardLayout.footerHeight)
                .padding(horizontal = TTSpacing.sm),
            contentAlignment = Alignment.Center,
        ) {
            if (joining || loading) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                TextButton(enabled = actionEnabled, onClick = handleAction) {
                    Text(text = actionText, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImHandoffComposerSheet(
    sourceMessage: ImMessage,
    members: List<ImMember>,
    currentUserId: String?,
    onSend: suspend (String, List<String>) -> Result<ImHandoffPackage>,
    onDismiss: () -> Unit,
) {
    val recipients = remember(members, currentUserId) {
        members.filter { !it.isAgent && !it.userId.isNullOrBlank() && it.userId != currentUserId }
            .sortedBy { it.displayName.lowercase(Locale.getDefault()) }
    }
    var selectedRecipientIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var goal by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val sourceSummary = remember(sourceMessage) {
        sourceMessage.resourceCardDisplayName
            ?: sourceMessage.content.trim().takeIf { it.isNotEmpty() }
            ?: sourceMessage.attachmentFileName.takeIf { it.isNotEmpty() }
            ?: "会话消息"
    }

    LaunchedEffect(recipients) {
        if (recipients.size == 1) recipients.first().userId?.let { selectedRecipientIds = setOf(it) }
    }

    TTBottomSheet(
        onDismissRequest = { if (!submitting) onDismiss() },
        sheetState = rememberTTSheetState(confirmValueChange = { !submitting }),
    ) {
        TTSheetColumn(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(R.string.im_handoff_compose_title),
                    style = TTFonts.subtitleSemibold,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismiss, enabled = !submitting) { Text(stringResource(R.string.common_cancel)) }
            }
            Text(
                text = stringResource(R.string.im_handoff_source),
                style = TTFonts.captionMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = sourceSummary,
                style = TTFonts.body,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = TTSpacing.sm),
            )
            Text(
                text = stringResource(R.string.im_handoff_recipients),
                style = TTFonts.captionMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (recipients.isEmpty()) {
                Text(
                    text = stringResource(R.string.im_handoff_no_recipient),
                    style = TTFonts.body,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = TTSpacing.md),
                )
            } else {
                recipients.forEach { member ->
                    val userId = member.userId ?: return@forEach
                    ImContinuationTargetRow(
                        title = member.displayName.ifBlank { member.username.ifBlank { "成员" } },
                        selected = selectedRecipientIds.contains(userId),
                        onClick = {
                            if (!submitting) {
                                selectedRecipientIds = if (selectedRecipientIds.contains(userId)) {
                                    selectedRecipientIds - userId
                                } else {
                                    selectedRecipientIds + userId
                                }
                            }
                        },
                    )
                }
            }
            Spacer(Modifier.size(TTSpacing.sm))
            TextField(
                value = goal,
                onValueChange = { goal = it.take(500) },
                label = { Text(stringResource(R.string.im_handoff_goal_hint)) },
                minLines = 2,
                maxLines = 4,
                enabled = !submitting,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                text = "${goal.length}/500",
                style = TTFonts.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth(),
                textAlign = androidx.compose.ui.text.style.TextAlign.End,
            )
            errorMessage?.let {
                Text(it, style = TTFonts.body, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.size(TTSpacing.md))
            Button(
                onClick = {
                    submitting = true
                    errorMessage = null
                    scope.launch {
                        onSend(goal, selectedRecipientIds.toList())
                            .onSuccess { onDismiss() }
                            .onFailure { errorMessage = it.message ?: "发送交接失败" }
                        submitting = false
                    }
                },
                enabled = selectedRecipientIds.isNotEmpty() && !submitting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (submitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.width(TTSpacing.xs))
                }
                Text(stringResource(if (submitting) R.string.im_handoff_sending else R.string.im_handoff_send))
            }
        }
    }
}

/** 对话接力卡：消息只携带定位快照，状态与接手动作始终读取独立 handoff 领域对象。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ImHandoffCardContent(
    snapshot: ImHandoffCard,
    refreshVersion: Int,
    currentUserId: String?,
    conversationMembers: List<OrganizationMember>,
    loadDetail: suspend (String) -> Result<ImHandoffPackage>,
    loadExecutionTargets:
        suspend (String) -> Result<ImConversationViewModel.ContinuationExecutionTargets>,
    markTakingOver: suspend (String) -> Result<ImHandoffPackage>,
    revoke: suspend (String) -> Result<ImHandoffPackage>,
    takeOver: suspend (String, String, String) -> Result<ChatSession>,
    loadAttachment: suspend (String) -> com.tabtin.mobile.data.im.ImAttachmentUrl?,
    onOpenReference: (ImHandoffReference) -> Unit,
    onOpenSession: (ChatSession) -> Unit,
    onActionError: (String) -> Unit,
    onLongClick: () -> Unit,
) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var detail by remember(snapshot.handoffId) { mutableStateOf<ImHandoffPackage?>(null) }
    var loading by remember(snapshot.handoffId) { mutableStateOf(true) }
    var loadFailed by remember(snapshot.handoffId) { mutableStateOf(false) }
    var acting by remember(snapshot.handoffId) { mutableStateOf(false) }
    var expanded by remember(snapshot.handoffId) { mutableStateOf(false) }
    var showTargetPicker by remember(snapshot.handoffId) { mutableStateOf(false) }
    var transcript by remember(snapshot.handoffId) { mutableStateOf<ImHandoffFrozenTranscript?>(null) }

    suspend fun refresh() {
        loading = true
        loadFailed = false
        loadDetail(snapshot.handoffId)
            .onSuccess { detail = it }
            .onFailure { loadFailed = true }
        loading = false
    }

    LaunchedEffect(snapshot.handoffId, refreshVersion) { refresh() }

    val authoritative = detail
    val revoked = authoritative?.status == "revoked"
    val isInitiator = authoritative?.initiatorUserId == currentUserId
    val recipient = authoritative?.recipients?.firstOrNull { it.userId == currentUserId }
    val canTakeOver = authoritative != null &&
        !revoked &&
        !isInitiator &&
        authoritative.scope != "view_only" &&
        (recipient == null || recipient.state in setOf("sent", "viewed", "acknowledged", "taking_over"))
    val summary = authoritative?.let {
        stringResource(
            R.string.im_handoff_summary,
            it.progress.size,
            it.nextSteps.size,
            it.risks.size,
            it.references.size,
        )
    }
    val shape = RoundedCornerShape(ImStructuredCardLayout.cornerRadius)

    Column(
        modifier = Modifier
            .width(ImStructuredCardLayout.width)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f))
            .border(1.dp, accent.copy(alpha = 0.38f), shape)
            .combinedClickable(onClick = { expanded = !expanded }, onLongClick = onLongClick)
            .semantics { contentDescription = authoritative?.goal ?: snapshot.goal },
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Share, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    text = stringResource(R.string.im_handoff_label),
                    style = TTFonts.captionMedium,
                    color = accent,
                    modifier = Modifier.weight(1f),
                )
                when {
                    revoked -> Text(stringResource(R.string.im_handoff_revoked), style = TTFonts.caption)
                    authoritative?.scope == "view_only" -> Text(stringResource(R.string.im_handoff_view_only), style = TTFonts.caption)
                    authoritative?.initiatorType == "agent" || snapshot.initiatorType == "agent" ->
                        Text(stringResource(R.string.im_handoff_agent_started), style = TTFonts.caption)
                }
            }
            Text(
                text = authoritative?.goal?.takeIf { it.isNotBlank() }
                    ?: snapshot.goal.ifBlank { stringResource(R.string.im_handoff_label) },
                style = TTFonts.subtitleSemibold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = if (expanded) 6 else 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.alpha(if (revoked) 0.55f else 1f),
            )
            when {
                loading -> Text(stringResource(R.string.im_handoff_loading), style = TTFonts.caption)
                loadFailed -> TextButton(onClick = { scope.launch { refresh() } }) {
                    Text(stringResource(R.string.im_handoff_load_failed))
                }
                summary != null -> Text(
                    text = summary,
                    style = TTFonts.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (expanded && authoritative != null && !revoked) {
                ImHandoffChecklist(stringResource(R.string.im_handoff_progress), authoritative.progress)
                ImHandoffChecklist(stringResource(R.string.im_handoff_next_steps), authoritative.nextSteps)
                ImHandoffChecklist(stringResource(R.string.im_handoff_risks), authoritative.risks)
                if (authoritative.references.isNotEmpty()) {
                    Text(stringResource(R.string.im_handoff_references), style = TTFonts.captionMedium)
                    authoritative.references.take(4).forEach { reference ->
                        val title = reference.title.ifBlank {
                            reference.summary.ifBlank { stringResource(R.string.im_handoff_reference_fallback) }
                        }
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(TTRadius.sm))
                                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.55f))
                                .clickable(enabled = reference.accessible) {
                                    reference.frozenSnapshot?.let { transcript = it }
                                        ?: onOpenReference(reference)
                                }
                                .padding(TTSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        ) {
                            Icon(
                                imageVector = if (reference.accessible) Icons.Default.Description else Icons.Default.Visibility,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                text = if (reference.accessible) title else stringResource(
                                    R.string.im_handoff_reference_unavailable,
                                    title,
                                ),
                                style = TTFonts.meta,
                                color = if (reference.accessible) MaterialTheme.colorScheme.onSurface
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
                if (authoritative.recipients.isNotEmpty()) {
                    Text(stringResource(R.string.im_handoff_recipients), style = TTFonts.captionMedium)
                    authoritative.recipients.take(4).forEach { item ->
                        val name = conversationMembers.firstOrNull { it.userId == item.userId }?.displayName
                            ?.takeIf { it.isNotBlank() } ?: stringResource(R.string.im_handoff_member_fallback)
                        Text("$name · ${imHandoffRecipientStateLabel(item.state)}", style = TTFonts.meta)
                    }
                }
            }
        }
        if (authoritative != null && !revoked && (canTakeOver || isInitiator)) {
            HorizontalDivider(color = imBorderLight())
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (canTakeOver) {
                    TextButton(
                        enabled = !acting,
                        onClick = {
                            if (recipient?.state == "taking_over") {
                                showTargetPicker = true
                            } else {
                                acting = true
                                scope.launch {
                                    markTakingOver(snapshot.handoffId)
                                        .onSuccess {
                                            detail = it
                                            showTargetPicker = true
                                        }
                                        .onFailure {
                                            onActionError(
                                                it.message ?: context.getString(R.string.im_handoff_take_over_failed),
                                            )
                                        }
                                    acting = false
                                }
                            }
                        },
                    ) { Text(stringResource(R.string.im_handoff_take_over)) }
                }
                Spacer(Modifier.weight(1f))
                if (isInitiator && authoritative.status == "sent") {
                    TextButton(
                        enabled = !acting,
                        onClick = {
                            acting = true
                            scope.launch {
                                revoke(snapshot.handoffId)
                                    .onSuccess { detail = it }
                                    .onFailure {
                                        onActionError(
                                            it.message ?: context.getString(R.string.im_handoff_revoke_failed),
                                        )
                                    }
                                acting = false
                            }
                        },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    ) { Text(stringResource(R.string.im_handoff_revoke)) }
                }
            }
        }
    }

    if (showTargetPicker && authoritative != null) {
        ImExecutionTargetSheet(
            organizationId = authoritative.organizationId,
            title = stringResource(R.string.im_handoff_take_over_title),
            description = stringResource(R.string.im_handoff_take_over_description),
            actionLabel = stringResource(R.string.im_handoff_enter_task),
            actionErrorFallback = stringResource(R.string.im_handoff_take_over_failed),
            loadExecutionTargets = loadExecutionTargets,
            execute = { agentId, workspaceId -> takeOver(snapshot.handoffId, agentId, workspaceId) },
            onCompleted = {
                showTargetPicker = false
                onOpenSession(it)
            },
            onActionError = onActionError,
            onDismiss = { showTargetPicker = false },
        )
    }

    transcript?.let { frozen ->
        ImHandoffTranscriptSheet(
            transcript = frozen,
            loadAttachment = loadAttachment,
            onActionError = onActionError,
            onDismiss = { transcript = null },
        )
    }
}

@Composable
private fun ImHandoffChecklist(title: String, items: List<com.tabtin.mobile.data.im.ImHandoffChecklistItem>) {
    if (items.isEmpty()) return
    Text(title, style = TTFonts.captionMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    items.take(4).forEach { item ->
        Text(
            text = "• ${item.text}",
            style = TTFonts.meta,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun imHandoffRecipientStateLabel(state: String): String = stringResource(when (state) {
    "viewed" -> R.string.im_handoff_recipient_viewed
    "acknowledged" -> R.string.im_handoff_recipient_acknowledged
    "taking_over" -> R.string.im_handoff_recipient_taking_over
    "delegated_to_agent" -> R.string.im_handoff_recipient_delegated
    "rejected" -> R.string.im_handoff_recipient_rejected
    else -> R.string.im_handoff_recipient_sent
})

private data class ImHandoffAttachmentPreview(
    val attachment: ImHandoffFrozenAttachment,
    val url: String,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImHandoffTranscriptSheet(
    transcript: ImHandoffFrozenTranscript,
    loadAttachment: suspend (String) -> com.tabtin.mobile.data.im.ImAttachmentUrl?,
    onActionError: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var loadingFileId by remember(transcript.title) { mutableStateOf<String?>(null) }
    var preview by remember(transcript.title) { mutableStateOf<ImHandoffAttachmentPreview?>(null) }

    TTBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Text(transcript.title, style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.im_handoff_transcript_notice),
                style = TTFonts.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            LazyColumn(
                modifier = Modifier.fillMaxWidth().heightIn(max = 560.dp),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                items(transcript.turns) { turn ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(TTRadius.md))
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f))
                            .padding(TTSpacing.md),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                    ) {
                        Text(
                            stringResource(
                                if (turn.role == "user") R.string.im_handoff_transcript_user
                                else R.string.im_handoff_transcript_ai,
                            ),
                            style = TTFonts.captionMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (turn.text.isNotBlank()) {
                            SelectionContainer { Text(turn.text, style = TTFonts.body) }
                        }
                        turn.attachments.forEach { attachment ->
                            TextButton(
                                enabled = attachment.fileId.isNotBlank() && loadingFileId == null,
                                onClick = {
                                    loadingFileId = attachment.fileId
                                    scope.launch {
                                        val resolved = loadAttachment(attachment.fileId)
                                        loadingFileId = null
                                        val url = resolved?.displayUrls?.firstOrNull()
                                        if (url == null) {
                                            onActionError(
                                                context.getString(R.string.im_handoff_attachment_open_failed),
                                            )
                                        } else {
                                            preview = ImHandoffAttachmentPreview(attachment, url)
                                        }
                                    }
                                },
                            ) {
                                if (loadingFileId == attachment.fileId) {
                                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                                    Spacer(Modifier.width(TTSpacing.xs))
                                }
                                Icon(Icons.Default.AttachFile, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(TTSpacing.xs))
                                Text(attachment.filename, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
                if (transcript.truncated) {
                    item {
                        Text(
                            stringResource(R.string.im_handoff_transcript_truncated),
                            style = TTFonts.caption,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    preview?.let { selected ->
        ChatFilePreviewDialog(
            fileUrl = selected.url,
            filename = selected.attachment.filename,
            mimeType = selected.attachment.mimeType,
            onDismiss = { preview = null },
        )
    }
}

/** 冻结任务上下文的续接卡：消息只携带定位快照，所有状态与动作都以详情接口为准。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ImSessionContinuationCardContent(
    snapshot: ImSessionContinuationCard,
    messageSenderName: String,
    currentUserId: String?,
    organizationMembers: List<OrganizationMember>,
    loadDetail: suspend (ImSessionContinuationCard) -> Result<ImSessionContinuationDetail>,
    loadExecutionTargets:
        suspend (String) -> Result<ImConversationViewModel.ContinuationExecutionTargets>,
    createTask:
        suspend (ImSessionContinuationCard, String, String, String) -> Result<ImSessionContinuationDetail>,
    onOpen: (ImSessionContinuationDetail) -> Unit,
    onActionError: (String) -> Unit,
    onLongClick: () -> Unit,
) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val scope = rememberCoroutineScope()
    val cachedDetail = remember(snapshot.objectId, snapshot.version) {
        ImCardStatusMemoryCache.cachedSessionContinuationDetail(snapshot.objectId, snapshot.version)
    }
    var detail by remember(snapshot.objectId, snapshot.version) { mutableStateOf(cachedDetail) }
    var loading by remember(snapshot.objectId, snapshot.version) { mutableStateOf(cachedDetail == null) }
    var loadFailed by remember(snapshot.objectId) { mutableStateOf(false) }
    var showTargetPicker by remember(snapshot.objectId) { mutableStateOf(false) }
    val materializeRequestId = remember(snapshot.objectId) { UUID.randomUUID().toString() }

    suspend fun refresh() {
        ImCardStatusMemoryCache.cachedSessionContinuationDetail(snapshot.objectId, snapshot.version)?.let {
            detail = it
            loading = false
            loadFailed = false
            return
        }
        loading = true
        loadFailed = false
        loadDetail(snapshot)
            .onSuccess {
                detail = it
                ImCardStatusMemoryCache.putSessionContinuationDetail(it)
            }
            .onFailure {
                loadFailed = true
                onActionError(it.message ?: "任务续接详情不可用")
            }
        loading = false
    }

    LaunchedEffect(snapshot.objectId, snapshot.version) { refresh() }

    val senderName = ImMemberDisplayPolicy.resolvedDisplayName(
        userId = snapshot.senderId,
        snapshotName = messageSenderName,
        organizationMembers = organizationMembers,
    )
    val recipientName = ImMemberDisplayPolicy.resolvedDisplayName(
        userId = snapshot.recipientId,
        snapshotName = null,
        organizationMembers = organizationMembers,
    )
    val relationText = when (currentUserId) {
        snapshot.senderId -> recipientName.takeIf { it.isNotEmpty() }
            ?.let { "你把任务交给 $it 续接" }
            ?: "你发送的冻结任务上下文"
        snapshot.recipientId -> senderName.takeIf { it.isNotEmpty() }
            ?.let { "$it 交给你继续的任务" }
            ?: "对方交给你继续的任务"
        else -> "任务续接"
    }
    val authoritative = detail
    val statusText = when {
        loadFailed -> "详情不可用"
        authoritative == null -> "加载中…"
        authoritative.role == "recipient" && !authoritative.eligibility.canCreate -> "资格已失效"
        authoritative.creationStatus == "created" -> "已创建"
        authoritative.creationStatus == "failed" -> "创建失败"
        authoritative.deliveryStatus != "confirmed" -> "发送中"
        authoritative.contextStatus == "empty" -> "没有可续接内容"
        authoritative.contextStatus == "truncated" -> "上下文已截断"
        authoritative.resourceStatus == "partial" || authoritative.resourceStatus == "unavailable" ->
            "部分资源不可用"
        else -> "可续接"
    }
    val actionText = when {
        loading -> "加载中…"
        loadFailed -> "重新加载"
        authoritative == null -> "详情暂不可用"
        authoritative.role != "recipient" ->
            if (authoritative.creationStatus == "created") "对方已创建新任务" else "等待对方创建"
        !authoritative.eligibility.canCreate -> "资格已失效"
        authoritative.creationStatus == "created" -> "打开新任务"
        authoritative.creationStatus == "failed" -> "重试创建"
        authoritative.deliveryStatus != "confirmed" -> "等待送达"
        authoritative.contextStatus == "empty" -> "没有可续接内容"
        else -> "创建我的任务"
    }
    val actionEnabled = when {
        loadFailed -> true
        loading || authoritative?.role != "recipient" || authoritative.eligibility.canCreate.not() -> false
        authoritative.creationStatus == "created" ->
            !authoritative.linkedSessionId.isNullOrBlank() && !authoritative.targetWorkspaceId.isNullOrBlank()
        else -> authoritative.deliveryStatus == "confirmed" && authoritative.contextStatus != "empty"
    }
    val handleAction = {
        when {
            loadFailed -> scope.launch { refresh() }
            authoritative?.creationStatus == "created" -> authoritative.let(onOpen)
            actionEnabled -> showTargetPicker = true
        }
    }
    val shape = RoundedCornerShape(ImStructuredCardLayout.cornerRadius)

    Column(
        modifier = Modifier
            .width(ImStructuredCardLayout.width)
            .height(ImStructuredCardLayout.height)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f))
            .border(1.dp, accent.copy(alpha = 0.38f), shape)
            .combinedClickable(onClick = { if (actionEnabled) handleAction() }, onLongClick = onLongClick)
            .semantics {
                contentDescription = "任务续接，${snapshot.title}，$relationText，$statusText"
            },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImStructuredCardLayout.bodyHeight)
                .padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    Icon(Icons.Default.Share, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
                    Text(
                        text = "任务续接",
                        style = MaterialTheme.typography.labelLarge,
                        color = accent,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Text(
                    text = statusText,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
            Text(
                text = authoritative?.titleSnapshot?.takeIf { it.isNotBlank() } ?: snapshot.title,
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = relationText,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            authoritative?.let {
                Text(
                    text = if (it.resources.any { resource -> resource.unavailable }) {
                        "冻结 ${it.snapshotTurnCount} 轮上下文 · 部分资源需重新授权"
                    } else {
                        "冻结 ${it.snapshotTurnCount} 轮上下文，不跟随原任务变化"
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        HorizontalDivider(color = imBorderLight())
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImStructuredCardLayout.footerHeight)
                .padding(horizontal = TTSpacing.sm),
            contentAlignment = Alignment.Center,
        ) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                TextButton(enabled = actionEnabled, onClick = handleAction) {
                    Text(text = actionText, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }

    if (showTargetPicker && authoritative != null) {
        ImExecutionTargetSheet(
            organizationId = authoritative.organizationId,
            title = "创建续接任务",
            description = "选择执行任务的 AI 分身与 Workspace。新任务会复制当前冻结上下文，之后独立推进。",
            actionLabel = "创建并打开",
            actionErrorFallback = "创建续接任务失败",
            loadExecutionTargets = loadExecutionTargets,
            execute = { agentId, workspaceId ->
                createTask(snapshot, agentId, workspaceId, materializeRequestId)
            },
            onCompleted = { created ->
                detail = created
                showTargetPicker = false
                onOpen(created)
            },
            onActionError = onActionError,
            onDismiss = { showTargetPicker = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> ImExecutionTargetSheet(
    organizationId: String,
    title: String,
    description: String,
    actionLabel: String,
    actionErrorFallback: String,
    loadExecutionTargets:
        suspend (String) -> Result<ImConversationViewModel.ContinuationExecutionTargets>,
    execute: suspend (String, String) -> Result<T>,
    onCompleted: (T) -> Unit,
    onActionError: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var targets by remember(organizationId) {
        mutableStateOf<ImConversationViewModel.ContinuationExecutionTargets?>(null)
    }
    var selectedAgentId by remember(organizationId) { mutableStateOf<String?>(null) }
    var selectedWorkspaceId by remember(organizationId) { mutableStateOf<String?>(null) }
    var loading by remember(organizationId) { mutableStateOf(true) }
    var submitting by remember(organizationId) { mutableStateOf(false) }
    var errorMessage by remember(organizationId) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun reload() {
        loading = true
        errorMessage = null
        loadExecutionTargets(organizationId)
            .onSuccess { loaded ->
                targets = loaded
                selectedAgentId = SharedSessionExecutionTargetPolicy.defaultAgent(loaded.agents)?.id
                selectedWorkspaceId = SharedSessionExecutionTargetPolicy.defaultWorkspace(loaded.workspaces)?.id
            }
            .onFailure {
                errorMessage = it.message ?: "加载执行目标失败"
                onActionError(errorMessage.orEmpty())
            }
        loading = false
    }

    LaunchedEffect(organizationId) { reload() }
    TTBottomSheet(
        onDismissRequest = { if (!submitting) onDismiss() },
        sheetState = rememberTTSheetState(confirmValueChange = { !submitting }),
    ) {
        TTSheetColumn(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismiss, enabled = !submitting) { Text("取消") }
            }
            Text(
                text = description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.size(TTSpacing.md))
            when {
                loading -> Box(
                    modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }
                errorMessage != null && targets == null -> Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(errorMessage.orEmpty(), color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { scope.launch { reload() } }) { Text("重试") }
                }
                else -> {
                    Text("AI 分身", style = MaterialTheme.typography.labelLarge)
                    targets?.agents.orEmpty().forEach { agent ->
                        val displayName = agent.displayName?.trim()?.takeIf { it.isNotEmpty() } ?: agent.name
                        ImContinuationTargetRow(
                            title = displayName,
                            selected = selectedAgentId == agent.id,
                            onClick = { if (!submitting) selectedAgentId = agent.id },
                        )
                    }
                    if (targets?.agents.isNullOrEmpty()) {
                        Text("当前组织没有可用的 AI 分身", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.size(TTSpacing.md))
                    Text("Workspace", style = MaterialTheme.typography.labelLarge)
                    targets?.workspaces.orEmpty().forEach { workspace ->
                        ImContinuationTargetRow(
                            title = workspace.name,
                            selected = selectedWorkspaceId == workspace.id,
                            onClick = { if (!submitting) selectedWorkspaceId = workspace.id },
                        )
                    }
                    if (targets?.workspaces.isNullOrEmpty()) {
                        Text("当前组织没有可用的执行 Workspace", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            errorMessage?.takeIf { targets != null }?.let {
                Spacer(Modifier.size(TTSpacing.sm))
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.size(TTSpacing.lg))
            Button(
                onClick = {
                    val agentId = selectedAgentId ?: return@Button
                    val workspaceId = selectedWorkspaceId ?: return@Button
                    submitting = true
                    errorMessage = null
                    scope.launch {
                        execute(agentId, workspaceId)
                            .onSuccess(onCompleted)
                            .onFailure {
                                errorMessage = it.message ?: actionErrorFallback
                                onActionError(errorMessage.orEmpty())
                            }
                        submitting = false
                    }
                },
                enabled = selectedAgentId != null && selectedWorkspaceId != null && !loading && !submitting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (submitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.width(TTSpacing.xs))
                }
                Text(if (submitting) "创建中…" else actionLabel)
            }
        }
    }
}

@Composable
private fun ImContinuationTargetRow(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(TTRadius.interactive))
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Icon(
            imageVector = if (selected) Icons.Default.Check else Icons.Default.SmartToy,
            contentDescription = if (selected) "已选择" else null,
            tint = if (selected) ttColor(TTColors.Primary, TTColors.Dark.Primary)
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = title,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

internal enum class ImSessionShareV2RelationKind { SENT, RECEIVED, OTHER }

internal data class ImSessionShareV2Relation(
    val kind: ImSessionShareV2RelationKind,
    val displayName: String? = null,
)

internal fun sessionShareV2Relation(
    snapshot: ImSessionShareV2Card,
    messageSenderName: String,
    currentUserId: String?,
    organizationMembers: List<OrganizationMember>,
): ImSessionShareV2Relation {
    val senderName = ImMemberDisplayPolicy.resolvedDisplayName(
        userId = snapshot.senderId,
        snapshotName = messageSenderName,
        organizationMembers = organizationMembers,
    )
    val recipientName = ImMemberDisplayPolicy.resolvedDisplayName(
        userId = snapshot.recipientId,
        snapshotName = null,
        organizationMembers = organizationMembers,
    )
    return when (currentUserId) {
        snapshot.senderId -> ImSessionShareV2Relation(
            kind = ImSessionShareV2RelationKind.SENT,
            displayName = recipientName.takeIf { it.isNotEmpty() },
        )
        snapshot.recipientId -> ImSessionShareV2Relation(
            kind = ImSessionShareV2RelationKind.RECEIVED,
            displayName = senderName.takeIf { it.isNotEmpty() },
        )
        else -> ImSessionShareV2Relation(kind = ImSessionShareV2RelationKind.OTHER)
    }
}

private fun com.tabtin.mobile.data.im.ImReplyPreview.displayText(): String = when {
    isUnavailable -> "消息内容不可用"
    content.isNotBlank() -> content
    messageType == com.tabtin.mobile.data.im.ImMessageType.IMAGE -> "图片"
    messageType == com.tabtin.mobile.data.im.ImMessageType.FILE || hasAttachment -> {
        if (fileName.isBlank()) "文件" else "文件：$fileName"
    }
    else -> "消息内容不可用"
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ImSessionShareCardContent(
    snapshot: ImSessionShareCard,
    refreshVersion: Int,
    isMine: Boolean,
    currentUserId: String?,
    loadDetail: suspend (ImSessionShareCard) -> ImSessionShareCard,
    onOpen: (ImSessionShareCard) -> Unit,
    onRevoke: suspend (ImSessionShareCard) -> Result<ImSessionShareCard>,
    onResume: suspend (ImSessionShareCard) -> Result<ImSessionShareCard>,
    onLongClick: () -> Unit,
) {
    val context = LocalContext.current
    val actionScope = rememberCoroutineScope()
    val sessionShareCache by ImCardStatusMemoryCache.sessionShares.collectAsState()
    val cachedShare = sessionShareCache[snapshot.shareId]
    var detail by remember(snapshot.shareId, refreshVersion) {
        mutableStateOf(cachedShare ?: ImCardStatusMemoryCache.cachedSessionShare(snapshot.shareId) ?: snapshot)
    }
    LaunchedEffect(cachedShare) {
        if (cachedShare != null && cachedShare != detail) detail = cachedShare
    }
    LaunchedEffect(snapshot.shareId, snapshot.status, refreshVersion) {
        val loaded = loadDetail(snapshot)
        ImCardStatusMemoryCache.putSessionShare(loaded)
        if (loaded != detail) detail = loaded
    }
    val accent = androidx.compose.ui.graphics.Color(0xFFF2994A)
    val active = detail.normalizedStatus == "active"
    val isOwner = isSessionShareOwner(
        currentUserId = currentUserId,
        ownerUserId = detail.ownerUserId,
        isMine = isMine,
    )
    val isGrantee = currentUserId != null && detail.granteeUserId == currentUserId
    var pendingAction by remember(snapshot.shareId) { mutableStateOf<String?>(null) }
    val relation = when {
        isOwner && !detail.granteeDisplayName.isNullOrBlank() -> "你共享给 ${detail.granteeDisplayName}"
        isGrantee && !detail.ownerDisplayName.isNullOrBlank() -> "${detail.ownerDisplayName} 共享给你"
        else -> "任务共享"
    }

    Column(
        modifier = Modifier
            .width(ImStructuredCardLayout.width)
            .height(ImStructuredCardLayout.height)
            .clip(RoundedCornerShape(ImStructuredCardLayout.cornerRadius))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f))
            .border(
                1.dp,
                accent.copy(alpha = 0.38f),
                RoundedCornerShape(ImStructuredCardLayout.cornerRadius),
            )
            .combinedClickable(onClick = {}, onLongClick = onLongClick),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImStructuredCardLayout.bodyHeight)
                .padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    Icon(Icons.Default.Share, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
                    Text(
                        text = "任务共享",
                        style = MaterialTheme.typography.labelLarge,
                        color = accent,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Text(
                    text = if (active) "共享中" else "已停止",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.64f))
                        .padding(horizontal = TTSpacing.sm, vertical = 4.dp),
                )
            }
            Text(
                text = detail.displayTitle,
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = relation,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.62f))
                    .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                Icon(Icons.Default.Visibility, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                Text(
                    text = detail.permissionLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        HorizontalDivider(color = imBorderLight())
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImStructuredCardLayout.footerHeight)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            if (isOwner && !active) {
                Button(
                    onClick = {
                        if (pendingAction != null) return@Button
                        pendingAction = "resume"
                        actionScope.launch {
                            onResume(detail)
                                .onSuccess {
                                    ImCardStatusMemoryCache.putSessionShare(it)
                                    detail = it
                                }
                                .onFailure {
                                    android.widget.Toast.makeText(
                                        context,
                                        it.message ?: "恢复共享失败",
                                        android.widget.Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            pendingAction = null
                        }
                    },
                    enabled = pendingAction == null,
                    shape = RoundedCornerShape(ImStructuredCardLayout.actionCornerRadius),
                    colors = ButtonDefaults.buttonColors(containerColor = accent),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(ImStructuredCardLayout.actionHeight),
                ) {
                    if (pendingAction == "resume") {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(TTSpacing.xs))
                    }
                    Text("恢复共享", fontWeight = FontWeight.SemiBold)
                }
            } else if (active) {
                Button(
                    onClick = { onOpen(detail) },
                    enabled = pendingAction == null && (isOwner || isGrantee || detail.sessionId?.isNotBlank() == true),
                    shape = RoundedCornerShape(ImStructuredCardLayout.actionCornerRadius),
                    colors = ButtonDefaults.buttonColors(containerColor = accent),
                    modifier = Modifier
                        .weight(1f)
                        .height(ImStructuredCardLayout.actionHeight),
                ) {
                    Text("打开任务", fontWeight = FontWeight.SemiBold)
                }
                if (isOwner) {
                    TextButton(
                        onClick = {
                            if (pendingAction != null) return@TextButton
                            pendingAction = "revoke"
                            actionScope.launch {
                                onRevoke(detail)
                                    .onSuccess {
                                        ImCardStatusMemoryCache.putSessionShare(it)
                                        detail = it
                                    }
                                    .onFailure {
                                        android.widget.Toast.makeText(
                                            context,
                                            it.message ?: "停止共享失败",
                                            android.widget.Toast.LENGTH_SHORT,
                                        ).show()
                                    }
                                pendingAction = null
                            }
                        },
                        enabled = pendingAction == null,
                    ) {
                        if (pendingAction == "revoke") {
                            CircularProgressIndicator(
                                modifier = Modifier.size(15.dp),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                strokeWidth = 2.dp,
                            )
                            Spacer(Modifier.width(TTSpacing.xs))
                        }
                        Text("停止共享", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            } else {
                Text(
                    text = "共享已停止",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
    }
}

internal fun isSessionShareOwner(
    currentUserId: String?,
    ownerUserId: String?,
    isMine: Boolean,
): Boolean {
    val normalizedOwnerId = ownerUserId?.trim()?.takeIf { it.isNotEmpty() }
    return if (normalizedOwnerId != null) currentUserId == normalizedOwnerId else isMine
}

/** 手机上的回复详情以 present 形式展示：原消息在前，随后是当前已加载的直接回复。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImReplyThreadSheet(
    root: ImMessage,
    replies: List<ImMessage>,
    onDismiss: () -> Unit,
) {
    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.lg),
        ) {
            Text("回复详情", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.size(TTSpacing.md))
            Text("原消息", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            ImReplyThreadMessage(message = root)
            HorizontalDivider()
            Spacer(Modifier.size(TTSpacing.sm))
            Text("回复（${replies.size}）", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (replies.isEmpty()) {
                Text(
                    text = "暂无已加载的回复",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = TTSpacing.md),
                )
            } else {
                LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                    items(replies, key = { it.id }) { reply -> ImReplyThreadMessage(message = reply) }
                }
            }
        }
    }
}

@Composable
private fun ImReplyThreadMessage(message: ImMessage) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm)) {
        Text(
            text = message.senderName.ifBlank { message.senderId },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.size(2.dp))
        Text(
            text = message.threadDisplayText(),
            style = MaterialTheme.typography.bodyMedium,
            color = if (message.isDeleted) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        )
    }
}

private fun ImMessage.threadDisplayText(): String = when {
    isDeleted -> "消息内容不可用"
    sessionContinuationCard != null -> "任务续接"
    sessionShareV2Card != null -> "协作邀请"
    content.isNotBlank() -> content
    messageType == com.tabtin.mobile.data.im.ImMessageType.IMAGE -> "图片"
    messageType == com.tabtin.mobile.data.im.ImMessageType.FILE || hasAttachment -> {
        if (attachmentFileName.isBlank()) "文件" else "文件：$attachmentFileName"
    }
    resourceCard != null -> "资源消息"
    else -> "消息内容不可用"
}

@Composable
private fun ImTextBubble(
    content: String,
    isMine: Boolean,
    isAgent: Boolean,
    replyPreview: com.tabtin.mobile.data.im.ImReplyPreview? = null,
    onOpenReplyPreview: (() -> Unit)? = null,
) {
    val textColor = imBubbleTextColor(isMine)
    val annotatedContent = remember(content, textColor) {
        val linkStyle = TextLinkStyles(
            style = SpanStyle(
                color = textColor,
                textDecoration = TextDecoration.Underline,
            ),
        )
        buildAnnotatedString {
            append(content)
            findImTextLinks(content).forEach { link ->
                addLink(
                    url = LinkAnnotation.Url(url = link.url, styles = linkStyle),
                    start = link.start,
                    end = link.endExclusive,
                )
            }
        }
    }

    Column(modifier = Modifier.imBubbleBackground(isMine = isMine, isAgent = isAgent)) {
        replyPreview?.let { preview ->
            ImInlineReplyPreview(preview = preview, isMine = isMine, onClick = onOpenReplyPreview)
            Spacer(Modifier.size(TTSpacing.xs))
        }
        SelectionContainer {
            Text(
                text = annotatedContent,
                style = ConversationTypography.body,
                color = textColor,
            )
        }
    }
}

@Composable
private fun ImInlineReplyPreview(
    preview: com.tabtin.mobile.data.im.ImReplyPreview,
    isMine: Boolean,
    onClick: (() -> Unit)?,
) {
    // 轻底色气泡上引用预览统一用次级文本色（不再假设己方白字）。
    val lineColor = MaterialTheme.colorScheme.onSurfaceVariant
    val labelColor = lineColor.copy(alpha = 0.72f)
    val textColor = lineColor.copy(alpha = if (isMine) 0.82f else 0.92f)
    Row(
        modifier = Modifier
            .widthIn(max = 260.dp)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Box(
            modifier = Modifier
                .size(width = 2.dp, height = 34.dp)
                .background(lineColor.copy(alpha = 0.45f)),
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = "回复",
                style = MaterialTheme.typography.labelSmall,
                color = labelColor,
                maxLines = 1,
            )
            Text(
                text = preview.displayText(),
                style = MaterialTheme.typography.labelSmall,
                color = textColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

private data class ImReadProgressUi(
    val readCount: Int,
    val recipientCount: Int,
)

@Composable
private fun ImMessageFooter(showEdited: Boolean) {
    if (!showEdited) return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Text(
            text = stringResource(R.string.im_edited),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
        )
    }
}

@Composable
private fun ImReadProgressIndicator(
    readCount: Int,
    recipientCount: Int,
    onClick: (() -> Unit)? = null,
) {
    val safeRecipientCount = recipientCount.coerceAtLeast(1)
    val clampedReadCount = readCount.coerceIn(0, safeRecipientCount)
    val ratio = clampedReadCount.toFloat() / safeRecipientCount.toFloat()
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.72f)
    val outline = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.36f)
    val success = ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)
    Box(
        modifier = Modifier
            .size(if (onClick == null) 12.dp else 28.dp)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .semantics {
                contentDescription = "已读 $clampedReadCount/$safeRecipientCount"
            },
        contentAlignment = Alignment.Center,
    ) {
        if (ratio >= 0.999f) {
            Canvas(modifier = Modifier.size(12.dp)) {
                val strokeWidth = 1.25.dp.toPx()
                val radius = (size.minDimension - strokeWidth) / 2f
                drawCircle(
                    color = success,
                    radius = radius,
                    style = Stroke(width = strokeWidth),
                )
                val check = Path().apply {
                    moveTo(size.width * 0.29f, size.height * 0.52f)
                    lineTo(size.width * 0.45f, size.height * 0.67f)
                    lineTo(size.width * 0.72f, size.height * 0.38f)
                }
                drawPath(
                    path = check,
                    color = success,
                    style = Stroke(
                        width = 1.25.dp.toPx(),
                        cap = StrokeCap.Round,
                        join = StrokeJoin.Round,
                    ),
                )
            }
        } else {
            Canvas(modifier = Modifier.size(12.dp)) {
                if (ratio > 0f) {
                    drawArc(
                        color = accent,
                        startAngle = -90f,
                        sweepAngle = ratio * 360f,
                        useCenter = true,
                    )
                }
                val strokeWidth = 1.dp.toPx()
                drawCircle(
                    color = outline,
                    radius = (size.minDimension - strokeWidth) / 2f,
                    style = Stroke(width = strokeWidth),
                )
            }
        }
    }
}

@Composable
private fun ImPinnedMessageBanner(
    messages: List<ImMessage>,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onClick: (ImMessage) -> Unit,
    onUnpin: (ImMessage) -> Unit,
    modifier: Modifier = Modifier,
) {
    val latest = messages.first()

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImPinnedMessageHeaderHeight)
                .background(ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.08f)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .clickable {
                        if (messages.size > 1) onExpandedChange(!expanded) else onClick(latest)
                    }
                    .padding(start = TTSpacing.md, end = TTSpacing.sm, top = TTSpacing.sm, bottom = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                Icon(
                    imageVector = Icons.Default.PushPin,
                    contentDescription = null,
                    tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = "置顶",
                    style = MaterialTheme.typography.labelMedium,
                    color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = latest.senderName.ifBlank { latest.senderId.take(8) } + "：",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                )
                Text(
                    text = latest.threadDisplayText(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (messages.size > 1) {
                    Text(
                        text = messages.size.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                    )
                    Icon(
                        imageVector = Icons.Default.KeyboardArrowDown,
                        contentDescription = if (expanded) "收起置顶消息" else "展开置顶消息",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .size(18.dp)
                            .graphicsLayer(rotationZ = if (expanded) 180f else 0f),
                    )
                }
            }
            if (messages.size == 1) {
                ImPinnedMessageUnpinButton(message = latest, onUnpin = onUnpin)
            }
        }

        if (expanded && messages.size > 1) {
            HorizontalDivider(color = ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.12f))
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 192.dp)
                    .verticalScroll(rememberScrollState())
                    .background(ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.08f)),
            ) {
                messages.forEach { message ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Row(
                            modifier = Modifier
                                .weight(1f)
                                .clickable {
                                    onExpandedChange(false)
                                    onClick(message)
                                }
                                .padding(start = TTSpacing.md, end = TTSpacing.sm, top = TTSpacing.sm, bottom = TTSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        ) {
                            Icon(
                                imageVector = Icons.Default.PushPin,
                                contentDescription = null,
                                tint = ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.7f),
                                modifier = Modifier.size(14.dp),
                            )
                            Text(
                                text = message.senderName.ifBlank { message.senderId.take(8) },
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurface,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                            )
                            Text(
                                text = message.threadDisplayText(),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        ImPinnedMessageUnpinButton(message = message, onUnpin = onUnpin)
                    }
                }
            }
        }
    }
}

private val ImPinnedMessageHeaderHeight = 48.dp

@Composable
private fun ImPinnedMessageUnpinButton(
    message: ImMessage,
    onUnpin: (ImMessage) -> Unit,
) {
    IconButton(
        onClick = { onUnpin(message) },
        modifier = Modifier.minimumInteractiveComponentSize().size(40.dp),
    ) {
        Icon(
            imageVector = Icons.Default.Close,
            contentDescription = "取消置顶",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

/** 乐观发送气泡：发送中/失败（失败可点重试）。 */
@Composable
private fun ImPendingBubble(pendingMessage: ImPendingMessage, onRetry: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        ImBubbleRow(isMine = true, modifier = Modifier.fillMaxWidth()) {
            when (pendingMessage.status) {
                ImPendingMessage.Status.SENDING -> CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                ImPendingMessage.Status.FAILED -> TextButton(
                    onClick = onRetry,
                ) {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(TTSpacing.xs))
                    Text(
                        text = stringResource(R.string.im_send_failed_retry),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            Spacer(Modifier.width(6.dp))
            Column(horizontalAlignment = Alignment.End) {
                pendingMessage.attachment?.let { attachment ->
                    Row(
                        modifier = Modifier
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .padding(TTSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        Icon(
                            if (pendingMessage.messageType == com.tabtin.mobile.data.im.ImMessageType.IMAGE) {
                                Icons.Default.Photo
                            } else {
                                Icons.Default.AttachFile
                            },
                            contentDescription = null,
                        )
                        Text(attachment.fileName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                pendingMessage.card?.let { card ->
                    ImResourceCardContent(card = card.toLocalCard())
                }
                if (pendingMessage.card == null && pendingMessage.content.isNotEmpty()) {
                    Spacer(Modifier.size(TTSpacing.xs))
                    ImTextBubble(content = pendingMessage.content, isMine = true, isAgent = false)
                }
            }
        }
    }
}

/** 对齐 Electron“云文件”：聚合组织内云文档与多维表格，选择后进入待发送态。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImResourceCardPickerSheet(
    organizationId: String,
    loadResources: suspend () -> Result<List<SpaceResource>>,
    onPick: (ImOutgoingCard) -> Unit,
    onDismiss: () -> Unit,
) {
    var resources by remember(organizationId) { mutableStateOf<List<SpaceResource>>(emptyList()) }
    var isLoading by remember(organizationId) { mutableStateOf(false) }
    var errorMessage by remember(organizationId) { mutableStateOf<String?>(null) }
    var query by remember(organizationId) { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    suspend fun reload() {
        if (isLoading) return
        isLoading = true
        errorMessage = null
        loadResources()
            .onSuccess { resources = it }
            .onFailure { errorMessage = it.message ?: "加载资源失败" }
        isLoading = false
    }

    val keyword = query.trim().lowercase()
    val visibleResources = remember(resources, keyword) {
        resources.filter { resource ->
            resource.resourceId.isNotBlank() && (
                keyword.isEmpty() ||
                    resource.displayTitle.lowercase().contains(keyword) ||
                    resource.typeLabel.lowercase().contains(keyword) ||
                    resource.preview?.lowercase()?.contains(keyword) == true
                )
        }
    }

    androidx.compose.runtime.LaunchedEffect(organizationId) { reload() }

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
    ) {
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "选择云文件",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismiss) { Text("关闭") }
            }
            TabSearchField(
                query = query,
                onQueryChange = { query = it },
                placeholder = "搜索资源",
                modifier = Modifier.fillMaxWidth(),
                showCancelOnFocus = false,
            )
            Spacer(Modifier.size(TTSpacing.sm))
            when {
                isLoading && resources.isEmpty() -> Box(
                    modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }
                errorMessage != null && resources.isEmpty() -> Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    Text(errorMessage.orEmpty(), color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { scope.launch { reload() } }) { Text(stringResource(R.string.common_retry)) }
                }
                visibleResources.isEmpty() -> Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(Icons.Default.Folder, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.size(TTSpacing.sm))
                    Text("暂无可发送的云文件", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> LazyColumn(modifier = Modifier.heightIn(max = 440.dp)) {
                    items(visibleResources, key = { it.id }) { resource ->
                        val isTable = resource.normalizedType == "tabdata"
                        val cardType = if (isTable) ImResourceCardType.TABLE else ImResourceCardType.DOCUMENT
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    onPick(
                                        ImOutgoingCard.resource(
                                            type = cardType,
                                            resourceId = resource.resourceId,
                                            name = resource.displayTitle,
                                            spaceId = resource.spaceId,
                                            organizationId = resource.organizationId ?: organizationId,
                                        ),
                                    )
                                }
                                .padding(vertical = TTSpacing.md),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                        ) {
                            CloudDocsAppIcon(itemType = resource.normalizedType)
                            Column(modifier = Modifier.weight(1f)) {
                                Text(resource.displayTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    resource.spaceName?.takeIf { it.isNotBlank() } ?: resource.typeLabel,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 名片 picker 直接刷新会话组织成员，不能读取全局当前组织。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImContactCardPickerSheet(
    initialMembers: List<OrganizationMember>,
    currentUserId: String?,
    loadMembers: suspend () -> Result<List<OrganizationMember>>,
    onPick: (ImOutgoingCard) -> Unit,
    onDismiss: () -> Unit,
) {
    var members by remember { mutableStateOf(initialMembers) }
    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    suspend fun reload() {
        if (isLoading) return
        isLoading = true
        errorMessage = null
        loadMembers()
            .onSuccess { members = it }
            .onFailure { errorMessage = it.message ?: "加载成员失败" }
        isLoading = false
    }

    val keyword = query.trim().lowercase()
    val visibleMembers = remember(members, currentUserId, keyword) {
        members
            .filter { it.userId != currentUserId }
            .filter { member ->
                keyword.isEmpty() || listOfNotNull(
                    member.displayName,
                    member.user?.username,
                    member.user?.email,
                ).any { it.lowercase().contains(keyword) }
            }
            .sortedBy { it.displayName.lowercase() }
    }

    androidx.compose.runtime.LaunchedEffect(Unit) { reload() }

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
    ) {
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "选择名片",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismiss) { Text("关闭") }
            }
            TabSearchField(
                query = query,
                onQueryChange = { query = it },
                placeholder = "搜索成员",
                modifier = Modifier.fillMaxWidth(),
                showCancelOnFocus = false,
            )
            Spacer(Modifier.size(TTSpacing.sm))
            when {
                isLoading && members.isEmpty() -> Box(
                    modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }
                errorMessage != null && members.isEmpty() -> Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    Text(errorMessage.orEmpty(), color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { scope.launch { reload() } }) { Text(stringResource(R.string.common_retry)) }
                }
                visibleMembers.isEmpty() -> Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(Icons.Default.Person, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.size(TTSpacing.sm))
                    Text("暂无可发送的成员", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> LazyColumn(modifier = Modifier.heightIn(max = 440.dp)) {
                    items(visibleMembers, key = { it.id }) { member ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    onPick(
                                        ImOutgoingCard.contact(
                                            userId = member.userId,
                                            name = member.displayName,
                                            username = member.user?.username,
                                            avatar = member.user?.avatar,
                                        ),
                                    )
                                }
                                .padding(vertical = TTSpacing.md),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                        ) {
                            TTAvatar(
                                name = member.displayName,
                                imageUrl = member.user?.avatar,
                                size = 40.dp,
                                shape = CircleShape,
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(member.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                member.user?.email?.takeIf { it.isNotBlank() }?.let { email ->
                                    Text(
                                        email,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImSessionSharePickerSheet(
    peerName: String,
    peerUserId: String,
    loadSessions: suspend () -> Result<List<AllChatSession>>,
    onShare: suspend (AllChatSession, ImTaskShareMode, String) -> Result<Unit>,
    onDismiss: () -> Unit,
) {
    var sessions by remember { mutableStateOf<List<AllChatSession>>(emptyList()) }
    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var selectedSession by remember { mutableStateOf<AllChatSession?>(null) }
    var selectedMode by remember { mutableStateOf(ImTaskShareMode.VIEW) }
    val submission = remember { ImSessionShareSubmissionController() }
    val scope = rememberCoroutineScope()

    suspend fun reload() {
        if (isLoading) return
        isLoading = true
        errorMessage = null
        loadSessions()
            .onSuccess { sessions = it }
            .onFailure { errorMessage = it.message ?: "加载任务失败" }
        isLoading = false
    }

    LaunchedEffect(Unit) { reload() }
    val keyword = query.trim().lowercase()
    val visible = remember(sessions, keyword) {
        sessions.filter { session ->
            keyword.isEmpty() ||
                session.displayTitle.lowercase().contains(keyword) ||
                session.agentName.orEmpty().lowercase().contains(keyword) ||
                session.spaceName.orEmpty().lowercase().contains(keyword)
        }
    }

    TTBottomSheet(
        onDismissRequest = { if (!submission.isSubmitting) onDismiss() },
        sheetState = rememberTTSheetState(
            confirmValueChange = { canChangeSessionShareSheetState(submission.isSubmitting) },
        ),
    ) {
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "共享任务",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismiss, enabled = !submission.isSubmitting) { Text("关闭") }
            }
            Text(
                text = "选择一个任务共享给 $peerName，对方会在这段私信里收到任务共享卡。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.size(TTSpacing.sm))
            TabSearchField(
                query = query,
                onQueryChange = { query = it },
                placeholder = "搜索任务",
                modifier = Modifier.fillMaxWidth(),
                showCancelOnFocus = false,
                enabled = !submission.isSubmitting,
            )
            Spacer(Modifier.size(TTSpacing.sm))
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm), verticalAlignment = Alignment.CenterVertically) {
                listOf(
                    ImTaskShareMode.VIEW to "实时查看",
                    ImTaskShareMode.COLLABORATE to "实时协作",
                    ImTaskShareMode.CONTINUE to "任务续接",
                ).forEach { (mode, title) ->
                    ShareModeChip(
                        selected = selectedMode == mode,
                        title = title,
                        enabled = !submission.isSubmitting,
                        onClick = {
                            if (selectedMode != mode) {
                                selectedMode = mode
                                submission.invalidateIntent()
                            }
                        },
                    )
                }
            }
            Spacer(Modifier.size(TTSpacing.sm))
            when {
                isLoading && sessions.isEmpty() -> Box(
                    modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }
                errorMessage != null && sessions.isEmpty() -> Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    Text(errorMessage.orEmpty(), color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { scope.launch { reload() } }) { Text(stringResource(R.string.common_retry)) }
                }
                visible.isEmpty() -> Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(Icons.Default.SmartToy, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.size(TTSpacing.sm))
                    Text("暂无可共享的任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> LazyColumn(modifier = Modifier.heightIn(max = 380.dp)) {
                    items(visible, key = { it.id }) { session ->
                        val selected = selectedSession?.id == session.id
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(
                                    if (selected) ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.10f)
                                    else androidx.compose.ui.graphics.Color.Transparent,
                                )
                                .clickable(enabled = !submission.isSubmitting) {
                                    if (selectedSession?.id != session.id) {
                                        selectedSession = session
                                        submission.invalidateIntent()
                                    }
                                }
                                .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.md),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                        ) {
                            Icon(
                                Icons.Default.SmartToy,
                                contentDescription = null,
                                tint = if (selected) ttColor(TTColors.Primary, TTColors.Dark.Primary)
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    session.displayTitle.ifBlank { "未命名任务" },
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                Text(
                                    listOfNotNull(session.agentName, session.spaceName)
                                        .filter { it.isNotBlank() }
                                        .joinToString(" · ")
                                        .ifBlank { "任务" },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
            submission.errorMessage?.let { error ->
                Text(
                    text = error,
                    style = TTFonts.caption,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.size(TTSpacing.sm))
            }
            Spacer(Modifier.size(TTSpacing.sm))
            Button(
                onClick = {
                    val session = selectedSession ?: return@Button
                    val clientRequestId = submission.start(
                        ImSessionShareSubmissionController.Intent(
                            sessionId = session.id,
                            peerUserId = peerUserId,
                            mode = selectedMode,
                        ),
                    ) ?: return@Button
                    scope.launch {
                        onShare(session, selectedMode, clientRequestId)
                            .onSuccess {
                                submission.succeed()
                                onDismiss()
                            }
                            .onFailure { submission.fail(it.message ?: "共享任务失败") }
                    }
                },
                enabled = selectedSession != null && !submission.isSubmitting,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp),
            ) {
                if (submission.isSubmitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.size(TTSpacing.sm))
                    Text("发送中…")
                } else {
                    Text(if (selectedMode.isContinuation) "发送任务续接" else "发送共享任务")
                }
            }
        }
    }
}

@Composable
private fun ShareModeChip(selected: Boolean, title: String, enabled: Boolean, onClick: () -> Unit) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    Text(
        text = title,
        style = MaterialTheme.typography.labelMedium,
        color = if (selected) accent else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .clip(CircleShape)
            .background(if (selected) accent.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceVariant)
            .border(1.dp, if (selected) accent.copy(alpha = 0.42f) else imBorderLight(), CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .alpha(if (enabled) 1f else 0.55f)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
    )
}

internal class ImSessionShareSubmissionController(
    private val requestIdFactory: () -> String = { UUID.randomUUID().toString() },
) {
    data class Intent(
        val sessionId: String,
        val peerUserId: String,
        val mode: ImTaskShareMode,
    )

    private var intent: Intent? = null
    var isSubmitting by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set
    var clientRequestId by mutableStateOf<String?>(null)
        private set

    fun start(intent: Intent): String? {
        if (isSubmitting) return null
        if (this.intent != intent || clientRequestId == null) {
            this.intent = intent
            clientRequestId = requestIdFactory()
        }
        isSubmitting = true
        errorMessage = null
        return clientRequestId
    }

    fun succeed() {
        reset()
    }

    fun fail(message: String) {
        isSubmitting = false
        errorMessage = message
    }

    fun invalidateIntent() {
        if (isSubmitting) return
        intent = null
        clientRequestId = null
        errorMessage = null
    }

    fun reset() {
        isSubmitting = false
        intent = null
        clientRequestId = null
        errorMessage = null
    }
}

internal fun canChangeSessionShareSheetState(isSubmitting: Boolean): Boolean = !isSubmitting

/** 指令卡正文由后端最终校验 1…8000 字符；本地同步限制以保证发送前反馈清晰。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImPromptComposeSheet(
    onSend: (promptText: String, title: String) -> Unit,
    onDismiss: () -> Unit,
) {
    var promptText by remember { mutableStateOf("") }
    val trimmedText = promptText.trim()
    val title = trimmedText.lineSequence()
        .map { it.trim() }
        .firstOrNull { it.isNotEmpty() }
        .orEmpty()
        .take(200)
    val canSend = trimmedText.isNotEmpty() && trimmedText.length <= 8_000

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
    ) {
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "发送指令",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
                TextButton(onClick = { onSend(trimmedText, title) }, enabled = canSend) { Text(stringResource(R.string.im_send)) }
            }
            Text(
                text = "写下希望对方 AI 分身执行的步骤与要求。第一行会作为标题；对方使用时仍需确认 AI 分身和 Workspace。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.size(TTSpacing.sm))
            TextField(
                value = promptText,
                onValueChange = { promptText = it.take(8_000) },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 180.dp, max = 400.dp),
                placeholder = { Text("输入指令内容") },
                maxLines = 12,
                colors = TextFieldDefaults.colors(
                    focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                ),
            )
            Text(
                text = "对方可一键预填到新任务 · ${promptText.length} / 8000",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(top = TTSpacing.xs),
            )
        }
    }
}

/** 输入框上方的待发送资源卡。选择资源不立即发出，用户仍可以补充说明。 */
@Composable
private fun ImDraftCardRow(card: ImOutgoingCard, onRemove: () -> Unit) {
    val (icon, kind) = when (card.type) {
        ImResourceCardType.DOCUMENT -> Icons.Default.Description to "云文档"
        ImResourceCardType.TABLE -> Icons.Default.TableChart to "多维表格"
        ImResourceCardType.CONTACT -> Icons.Default.Person to "名片"
        else -> Icons.Default.Terminal to "指令"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Icon(icon, contentDescription = null, tint = ttColor(TTColors.Primary, TTColors.Dark.Primary))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = card.name.ifBlank { card.title.orEmpty().ifBlank { "未命名资源" } },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "待发送 · $kind",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onRemove, modifier = Modifier.minimumInteractiveComponentSize().size(32.dp)) {
            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_cancel))
        }
    }
}

/** 未知、未支持或结构错误的 card 仍按结构化消息保守展示，不能退化为可编辑文本气泡。 */
@Composable
private fun ImUnsupportedCardBubble(message: ImMessage) {
    val description = message.content.trim().ifBlank { "未提供消息描述" }
    Column(
        modifier = Modifier
            .width(ImStructuredCardLayout.width)
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .imCardBorder(imBorderLight())
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Text(
            text = "不支持的消息类型",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = description,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 输入 @ 后的群成员选择页：只列出当前会话成员，关闭时保留原输入内容。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GroupMemberMentionSheet(
    members: List<ImMember>,
    currentUserId: String?,
    onPickAll: () -> Unit,
    onPick: (ImMember) -> Unit,
    onAddAgent: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    val mentionableMembers = remember(members, currentUserId) {
        members.filter { it.userId != currentUserId && ImDraftMention.from(it) != null }
    }
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
    ) {
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "选择成员",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onPickAll)
                    .padding(vertical = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                Icon(
                    imageVector = Icons.Default.Group,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text("@所有人", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        text = "通知群内所有成员",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (onAddAgent != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(onClick = onAddAgent)
                        .padding(vertical = TTSpacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    Icon(
                        imageVector = Icons.Default.SmartToy,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text("添加 Agent", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            text = "从组织中选择并加入群聊",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (mentionableMembers.isNotEmpty()) {
                LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                    items(
                        mentionableMembers,
                        key = { it.agentId ?: it.userId ?: "${it.memberType}:${it.username}" },
                    ) { member ->
                        val name = member.displayName.ifBlank { if (member.isAgent) "Agent" else "成员" }
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onPick(member) }
                                .padding(vertical = TTSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        ) {
                            Icon(
                                imageVector = if (member.isAgent) Icons.Default.SmartToy else Icons.Default.Person,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    text = if (member.isAgent) "Agent" else "成员",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun isGroupMentionTrigger(text: String): Boolean =
    text.lastOrNull() == '@' && (text.length == 1 || text[text.lastIndex - 1].isWhitespace())

private fun textHasMemberMention(text: String, displayName: String): Boolean =
    Regex("@${Regex.escape(displayName)}(?=[\\s,;.!?，。！？、；：]|$)").containsMatchIn(text)

/** 输入框：编辑/回复横幅、附件入口、文本域与发送键。@ 成员由输入触发选择，不保留显式按钮。 */
@Composable
private fun ImComposer(
    draft: String,
    messageTooLong: Boolean,
    messageLength: Int,
    editing: Boolean,
    replyMessage: ImMessage?,
    readOnlyMessage: String?,
    attachment: ChatAttachment?,
    pendingCard: ImOutgoingCard?,
    focusRequester: FocusRequester,
    onDraftChange: (String) -> Unit,
    onPickImage: () -> Unit,
    onPickFile: () -> Unit,
    onPickCloudFile: () -> Unit,
    onPickContact: () -> Unit,
    onPickPrompt: () -> Unit,
    onPickSessionShare: () -> Unit,
    canPickSessionShare: Boolean,
    contentMenuEnabled: Boolean,
    onRetryAttachment: (String) -> Unit,
    onRemoveAttachment: (String) -> Unit,
    onRemovePendingCard: () -> Unit,
    onCancelEdit: () -> Unit,
    onCancelReply: () -> Unit,
    onSend: () -> Unit,
) {
    var addMenuOpen by remember { mutableStateOf(false) }
    val view = LocalView.current
    val hasSendablePayload = draft.trim().isNotEmpty() ||
        attachment?.status == AttachmentStatus.READY || pendingCard != null
    val canSend = hasSendablePayload && !messageTooLong

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
                if (readOnlyMessage != null) {
                    Text(
                        text = readOnlyMessage,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (editing) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Default.Edit,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(modifier = Modifier.width(TTSpacing.xs))
                        Text(
                            text = stringResource(R.string.im_editing_banner),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = onCancelEdit) { Text(stringResource(R.string.common_cancel)) }
                    }
                } else if (replyMessage != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(modifier = Modifier.width(TTSpacing.xs))
                        Text(
                            text = replyMessage.content.ifEmpty { "附件消息" },
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = onCancelReply, modifier = Modifier.minimumInteractiveComponentSize().size(32.dp)) {
                            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_cancel))
                        }
                    }
                }

                if (!editing && attachment != null) {
                    ImDraftAttachmentRow(
                        attachment = attachment,
                        onRetry = { onRetryAttachment(attachment.id) },
                        onRemove = { onRemoveAttachment(attachment.id) },
                    )
                }

                if (!editing && pendingCard != null) {
                    ImDraftCardRow(card = pendingCard, onRemove = onRemovePendingCard)
                }

                if (messageTooLong) {
                    Text(
                        text = stringResource(
                            R.string.im_composer_message_too_long,
                            messageLength,
                            IM_MESSAGE_CONTENT_MAX_LENGTH,
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    if (shouldShowImComposerAddButton(editing, contentMenuEnabled)) {
                        Box {
                            IconButton(
                                onClick = { addMenuOpen = true },
                                enabled = contentMenuEnabled,
                            ) {
                                Icon(
                                    Icons.Default.Add,
                                    contentDescription = stringResource(R.string.im_attachment_add),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            DropdownMenu(expanded = addMenuOpen, onDismissRequest = { addMenuOpen = false }) {
                                ImAddContentMenuItem(Icons.Default.Photo, stringResource(R.string.im_attachment_choose_image)) {
                                    addMenuOpen = false; onPickImage()
                                }
                                ImAddContentMenuItem(Icons.Default.AttachFile, stringResource(R.string.im_attachment_choose_file)) {
                                    addMenuOpen = false; onPickFile()
                                }
                                HorizontalDivider()
                                ImAddContentMenuItem(Icons.Default.Folder, "云文件") { addMenuOpen = false; onPickCloudFile() }
                                ImAddContentMenuItem(Icons.Default.Person, "名片") { addMenuOpen = false; onPickContact() }
                                HorizontalDivider()
                                if (canPickSessionShare) {
                                    ImAddContentMenuItem(Icons.Default.Share, "共享任务") {
                                        addMenuOpen = false; onPickSessionShare()
                                    }
                                }
                                ImAddContentMenuItem(Icons.Default.Terminal, "发送指令") { addMenuOpen = false; onPickPrompt() }
                            }
                        }
                    }
                    TextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        modifier = Modifier
                            .weight(1f)
                            .focusRequester(focusRequester),
                        placeholder = {
                            Text(
                                stringResource(
                                    if (editing) R.string.im_composer_edit_hint else R.string.im_composer_hint,
                                ),
                            )
                        },
                        maxLines = 5,
                        colors = TextFieldDefaults.colors(
                            focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                            unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        ),
                    )
                    IconButton(
                        onClick = {
                            val haptic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                                HapticFeedbackConstants.CONFIRM
                            } else {
                                HapticFeedbackConstants.LONG_PRESS
                            }
                            view.performHapticFeedback(haptic)
                            onSend()
                        },
                        enabled = canSend && readOnlyMessage == null,
                    ) {
                        Icon(
                            if (editing) Icons.Default.Check else Icons.AutoMirrored.Filled.Send,
                            contentDescription = stringResource(R.string.im_send),
                            tint = if (canSend && readOnlyMessage == null) {
                                ttColor(TTColors.Primary, TTColors.Dark.Primary)
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                }
    }
}

@Composable
private fun ImAddContentMenuItem(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    onClick: () -> Unit,
) {
    DropdownMenuItem(
        text = { Text(title) },
        leadingIcon = { Icon(icon, contentDescription = null) },
        onClick = onClick,
    )
}

/** 只在用户选择「添加表情」后展示常用全集，长按菜单保持可扫读。 */
@Composable
private fun ImReactionPickerDialog(
    reactions: Map<String, List<String>>,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    val activeReactionKindCount = reactions.count { it.value.isNotEmpty() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.im_action_add_reaction)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                Text(
                    text = if (activeReactionKindCount >= IM_REACTION_KIND_LIMIT) {
                        "已达到上限。取消一个已有表情后可继续添加"
                    } else {
                        "每条消息最多添加 $IM_REACTION_KIND_LIMIT 种表情"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (activeReactionKindCount >= IM_REACTION_KIND_LIMIT) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
                for (row in imReactionPickerEmojis.chunked(6)) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                        for (emoji in row) {
                            TextButton(
                                onClick = { onPick(emoji) },
                                enabled = canAddImReaction(emoji, reactions),
                            ) {
                                Text(emoji, style = MaterialTheme.typography.titleLarge)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/** 转发目标沿用已加载的当前组织会话列表，不让消息跨组织流转。 */
@Composable
private fun ImForwardDialog(
    conversations: List<ImConversation>,
    organizationMembers: List<OrganizationMember>,
    onDismiss: () -> Unit,
    onSelect: (ImConversation) -> Unit,
) {
    val directMessageFallbackTitle = stringResource(R.string.im_kind_dm)
    val conversationFallbackTitle = stringResource(R.string.im_conversation_default_title)
    val resolvedTitles = remember(
        conversations,
        organizationMembers,
        directMessageFallbackTitle,
        conversationFallbackTitle,
    ) {
        conversations.associate { conversation ->
            val peerName = conversation.dmPeerUserId?.let { peerId ->
                organizationMembers.firstOrNull { it.userId == peerId }?.displayName
            }
            conversation.id to ImConversationTitlePolicy.resolve(
                conversationName = conversation.name,
                isDirectMessage = conversation.type == ImConversationType.DM,
                peerDisplayName = peerName,
                directMessageFallback = directMessageFallbackTitle,
                conversationFallback = conversationFallbackTitle,
            )
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.im_action_forward)) },
        text = {
            if (conversations.isEmpty()) {
                Text(stringResource(R.string.im_action_no_forward_target))
            } else {
                LazyColumn(modifier = Modifier.heightIn(max = 360.dp)) {
                    items(conversations, key = { it.id }) { conversation ->
                        TextButton(
                            onClick = { onSelect(conversation) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text(
                                    resolvedTitles[conversation.id] ?: conversationFallbackTitle,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                if (conversation.lastMessagePreview.isNotEmpty()) {
                                    Text(
                                        conversation.lastMessagePreview,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

@Composable
private fun ImDraftAttachmentRow(
    attachment: ChatAttachment,
    onRetry: () -> Unit,
    onRemove: () -> Unit,
) {
    val statusDescription = when (attachment.status) {
        AttachmentStatus.PENDING, AttachmentStatus.UPLOADING -> stringResource(R.string.im_attachment_uploading_a11y)
        AttachmentStatus.READY -> stringResource(R.string.im_attachment_ready)
        AttachmentStatus.ERROR -> stringResource(R.string.im_attachment_upload_failed)
    }
    val attachmentDescription = stringResource(
        R.string.im_attachment_pending_a11y,
        attachment.filename,
        statusDescription,
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs)
            .semantics {
                contentDescription = attachmentDescription
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Icon(
            if (attachment.type == com.tabtin.mobile.data.model.AttachmentType.IMAGE) Icons.Default.Photo
            else Icons.Default.AttachFile,
            contentDescription = null,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(attachment.filename, maxLines = 1, overflow = TextOverflow.Ellipsis)
            when (attachment.status) {
                AttachmentStatus.PENDING, AttachmentStatus.UPLOADING -> {
                    androidx.compose.material3.LinearProgressIndicator(
                        progress = { attachment.progress.coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                AttachmentStatus.ERROR -> Text(
                    attachment.error ?: stringResource(R.string.im_attachment_upload_failed),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 2,
                )
                AttachmentStatus.READY -> Text(
                    stringResource(R.string.im_attachment_ready),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
        if (attachment.status == AttachmentStatus.ERROR) {
            IconButton(onClick = onRetry) {
                Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.common_retry))
            }
        }
        IconButton(onClick = onRemove) {
            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.im_attachment_remove))
        }
    }
}

/**
 * 定位到 IM 会话的真实尾部。
 *
 * 私信列表顶部可能有“加载更多”行，最后一条也可能比可视区域高；因此不能用消息数推导
 * index，也不能只滚到最后 item 的顶部。首屏使用直接定位，后续自动滚动才使用动画。
 */
private suspend fun LazyListState.scrollToImConversationEnd(
    animated: Boolean = false,
    settleLayout: Boolean = false,
) {
    val attempts = if (settleLayout) 3 else 1
    repeat(attempts) { attempt ->
        withFrameNanos { }
        val lastIndex = layoutInfo.totalItemsCount - 1
        if (lastIndex < 0) return

        if (animated && attempt == 0) {
            animateScrollToItem(lastIndex)
        } else {
            scrollToItem(lastIndex)
        }

        withFrameNanos { }
        val info = layoutInfo
        val lastItem = info.visibleItemsInfo.lastOrNull { it.index == lastIndex } ?: return@repeat
        val contentViewportEnd = info.viewportEndOffset - info.afterContentPadding
        val trailingOverflow = lastItem.offset + lastItem.size - contentViewportEnd
        if (trailingOverflow > 0) scrollBy(trailingOverflow.toFloat())
    }
}

internal fun shouldHideInitialImRows(
    hasConversationRows: Boolean,
    hasSettledInitialPosition: Boolean,
    hadCachedRowsOnEntry: Boolean,
): Boolean =
    hasConversationRows && !hasSettledInitialPosition && !hadCachedRowsOnEntry

/** 保留首次出现的位置并采用最新内容，确保 Compose row key 始终唯一。 */
internal fun uniqueImConversationMessages(messages: List<ImMessage>): List<ImMessage> {
    val latestById = linkedMapOf<Int, ImMessage>()
    messages.forEach { latestById[it.id] = it }
    return latestById.values.toList()
}

internal sealed interface ImConversationTimelineRow {
    val stableKey: String

    data class Message(
        val message: ImMessage,
        val previousMessage: ImMessage?,
    ) : ImConversationTimelineRow {
        override val stableKey: String = "m-${message.id}"
    }

    data class Pending(val pending: ImPendingMessage) : ImConversationTimelineRow {
        override val stableKey: String = "p-${pending.clientRequestId}"
    }
}

/** 将确认态与本地发送历史按首次提交时间合并，避免“第一条失败、第二条成功”后视觉倒序。 */
internal fun imConversationTimelineRows(
    messages: List<ImMessage>,
    pending: List<ImPendingMessage>,
): List<ImConversationTimelineRow> {
    val orderedPending = pending.sortedBy { it.createdAtEpochMs }
    var pendingIndex = 0
    return buildList(messages.size + pending.size) {
        messages.forEachIndexed { index, message ->
            ImMessageTimeline.parseTimestampMs(message.createdAt)?.let { messageTime ->
                while (
                    pendingIndex < orderedPending.size &&
                    orderedPending[pendingIndex].createdAtEpochMs <= messageTime
                ) {
                    add(ImConversationTimelineRow.Pending(orderedPending[pendingIndex]))
                    pendingIndex++
                }
            }
            add(ImConversationTimelineRow.Message(message, messages.getOrNull(index - 1)))
        }
        while (pendingIndex < orderedPending.size) {
            add(ImConversationTimelineRow.Pending(orderedPending[pendingIndex]))
            pendingIndex++
        }
    }
}

/** LazyColumn 头部行与混排时间线共用同一个索引空间，供置顶/引用跳转使用。 */
internal fun imConversationMessageListIndex(
    targetMessageId: Int,
    timelineRows: List<ImConversationTimelineRow>,
    hasGroupCreatedNotice: Boolean,
    hasLoadMoreRow: Boolean,
): Int {
    val timelineIndex = timelineRows.indexOfFirst { row ->
        row is ImConversationTimelineRow.Message && !row.message.isDeleted && row.message.id == targetMessageId
    }
    if (timelineIndex < 0) return -1
    return timelineIndex +
        (if (hasGroupCreatedNotice) 1 else 0) +
        (if (hasLoadMoreRow) 1 else 0)
}

internal fun initialImConversationTailIndex(
    messageCount: Int,
    pendingCount: Int,
    typingActive: Boolean,
    hasLoadMoreRow: Boolean,
): Int {
    val rowCount = messageCount.coerceAtLeast(0) +
        pendingCount.coerceAtLeast(0) +
        (if (typingActive) 1 else 0) +
        (if (hasLoadMoreRow) 1 else 0)
    return (rowCount - 1).coerceAtLeast(0)
}

internal fun shouldShowDmReadIndicator(
    isMine: Boolean,
    isReadByPeer: Boolean,
): Boolean = isMine

/** 外部私聊只支持纯文本，不能展示一个点开后无效的内容入口。 */
internal fun shouldShowImComposerAddButton(
    editing: Boolean,
    contentMenuEnabled: Boolean,
): Boolean = !editing && contentMenuEnabled

internal fun shouldFollowImConversationTail(
    previousTailMessageId: Int?,
    currentTailMessageId: Int?,
    previousPendingCount: Int,
    currentPendingCount: Int,
): Boolean =
    previousTailMessageId != currentTailMessageId || currentPendingCount > previousPendingCount

package com.tabtin.mobile.features.tabchat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.UploadScope
import com.tabtin.mobile.data.im.CentrifugoClient
import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.data.im.ExternalContactRepository
import com.tabtin.mobile.data.im.canSendExternalDirectMessage
import com.tabtin.mobile.data.im.ImAgentSummary
import com.tabtin.mobile.data.im.ImAgentTaskThreadResult
import com.tabtin.mobile.data.im.ImApi
import com.tabtin.mobile.data.im.ImAttachmentUrl
import com.tabtin.mobile.data.im.ImConversationDetail
import com.tabtin.mobile.data.im.ImConversationAgentBinding
import com.tabtin.mobile.data.im.ImConversationLabel
import com.tabtin.mobile.data.im.ImConversationLabelRepository
import com.tabtin.mobile.data.im.ImConversationDataPlane
import com.tabtin.mobile.data.im.ImConversation
import com.tabtin.mobile.data.im.ImConversationType
import com.tabtin.mobile.data.im.ImConversationService
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.im.ImMemberDisplayPolicy
import com.tabtin.mobile.data.im.ImMessageCompositeCache
import com.tabtin.mobile.data.im.ImMessageStore
import com.tabtin.mobile.data.im.ImMessage
import com.tabtin.mobile.data.im.ImMessageMemoryCache
import com.tabtin.mobile.data.im.ImMessagePreferencesCache
import com.tabtin.mobile.data.im.ImPendingMessagePreferencesCache
import com.tabtin.mobile.data.im.ImMessageRoomCache
import com.tabtin.mobile.data.im.ImMessageTransport
import com.tabtin.mobile.data.im.ImMessageType
import com.tabtin.mobile.data.im.parseImMessageInstant
import com.tabtin.mobile.data.im.ImPinnedMessageCompositeCache
import com.tabtin.mobile.data.im.ImPinnedMessageMemoryCache
import com.tabtin.mobile.data.im.ImMember
import com.tabtin.mobile.data.im.ImMemberType
import com.tabtin.mobile.data.im.ImHandoffPackage
import com.tabtin.mobile.data.im.ImHandoffReferenceRequest
import com.tabtin.mobile.data.im.ImHandoffRepository
import com.tabtin.mobile.data.im.ImCardStatusMemoryCache
import com.tabtin.mobile.data.im.ImCardDetailRequestCoalescer
import com.tabtin.mobile.data.im.ImOutgoingAttachment
import com.tabtin.mobile.data.im.ImOutgoingCard
import com.tabtin.mobile.data.im.ImResourceAccessRequestBody
import com.tabtin.mobile.data.im.ImResourceCard
import com.tabtin.mobile.data.im.ImResourceCardPreviewResult
import com.tabtin.mobile.data.im.ImResourceCardPreviewStatus
import com.tabtin.mobile.data.im.ImResourceCardType
import com.tabtin.mobile.data.im.ImSendOutcome
import com.tabtin.mobile.data.im.isImConversationReadOnly
import com.tabtin.mobile.data.im.ImSessionShareCard
import com.tabtin.mobile.data.im.ImSessionShareRequest
import com.tabtin.mobile.data.im.ImSessionShareV2BatchRequest
import com.tabtin.mobile.data.im.ImSessionShareV2Card
import com.tabtin.mobile.data.im.ImSessionShareV2Detail
import com.tabtin.mobile.data.im.ImSessionContinuationBatchRequest
import com.tabtin.mobile.data.im.ImSessionContinuationCard
import com.tabtin.mobile.data.im.ImSessionContinuationCreateRequest
import com.tabtin.mobile.data.im.ImSessionContinuationCreateTaskRequest
import com.tabtin.mobile.data.im.ImSessionContinuationDetail
import com.tabtin.mobile.data.im.ImTaskShareMode
import com.tabtin.mobile.ui.components.identityAvatarImageRequest
import com.tabtin.mobile.data.im.isImMessageContentWithinLimit
import com.tabtin.mobile.data.im.resolveDirectMessageConversationId
import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.AttachmentType
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.repository.AllSessionsRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SpaceResourceRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.features.conversation.ChatAttachmentManager
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.qualifiers.ApplicationContext
import coil.imageLoader
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.UUID
import javax.inject.Inject
import kotlin.math.roundToInt

private val mentionAllPattern = Regex("@所有人(?=[\\s,;.!?，。！？、；：]|$)")

/** 外部私聊在发送前重新确认联系人关系，未知或查询失败时保守地不放行发送。 */
internal enum class ExternalDirectMessageSendAccess {
    CHECKING,
    ALLOWED,
    DENIED,
    UNAVAILABLE,
}

internal fun canMentionAgentDirectly(
    agentId: String,
    memberAgentIds: Set<String>,
    bindings: List<ImConversationAgentBinding>,
): Boolean = agentId in memberAgentIds &&
    bindings.firstOrNull { it.agentId == agentId }?.isExecutable == true

private suspend fun <T> runSuspendCatching(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (cancellation: CancellationException) {
    throw cancellation
} catch (error: Throwable) {
    Result.failure(error)
}

/**
 * 会话被任务等子页面覆盖时，实时事件可能漏达仍保留的旧 ViewModel。
 * 每次恢复前台都静默合并权威最新页，不清空时间线，也不展示 loading。
 */
internal class ImConversationForegroundCatchUp(
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val reconcileLatest: suspend () -> Unit,
) {
    fun onForeground() {
        scope.launch { reconcileLatest() }
    }
}

/** 输入态 mention：可读正文保留 @名称，发送时以 id 写入 user / Agent metadata。 */
public data class ImDraftMention(
    val id: String,
    val displayName: String,
    val userId: String? = null,
    val agentId: String? = null,
) {
    public companion object {
        public fun from(member: ImMember): ImDraftMention? {
            val name = member.displayName.ifBlank { if (member.isAgent) "Agent" else "成员" }
            return when (member.memberType) {
                ImMemberType.USER -> member.userId?.takeIf { it.isNotBlank() }?.let {
                    ImDraftMention(id = "user:$it", displayName = name, userId = it)
                }
                ImMemberType.AGENT -> member.agentId?.takeIf { it.isNotBlank() }?.let {
                    ImDraftMention(id = "agent:$it", displayName = name, agentId = it)
                }
                else -> null
            }
        }

        public fun from(agent: ImAgentSummary): ImDraftMention = ImDraftMention(
            id = "agent:${agent.id}",
            displayName = agent.displayName,
            agentId = agent.id,
        )
    }
}

/**
 * TabChat 单会话详情 ViewModel（Phase B~E），对齐 iOS `IMConversationScreen` 的行为编排。
 *
 * 职责：桥接 [ImMessageStore]（历史/发送/编辑/撤回/表情/已读）与 [CentrifugoClient]（`chat:{conv}`
 * 实时通道），并提供 @Agent 搜索/加入、附件 URL、typing 节流等会话级动作。进入即订阅、
 * 退出（onCleared）即退订，避免旧会话消息串进新会话。
 */
@HiltViewModel
public class ImConversationViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val imApi: ImApi,
    private val messageTransport: ImMessageTransport,
    private val conversationService: ImConversationService,
    private val conversationDataPlane: ImConversationDataPlane,
    private val centrifugoClient: CentrifugoClient,
    private val conversationStore: ImConversationStore,
    private val conversationLabelRepository: ImConversationLabelRepository,
    private val externalContactRepository: ExternalContactRepository,
    private val allSessionsRepository: AllSessionsRepository,
    private val organizationRepository: OrganizationRepository,
    private val spaceResourceRepository: SpaceResourceRepository,
    private val spaceRepository: SpaceRepository,
    private val tokenManager: TokenManager,
    private val webSocketService: WebSocketService,
    private val imMessageRoomCache: ImMessageRoomCache,
    @ApplicationContext private val context: Context,
    private val ossUploadService: OSSUploadService,
) : ViewModel() {

    public data class ForwardOutcome(val sent: Int, val failed: Int)

    public data class ContinuationExecutionTargets(
        val agents: List<Agent>,
        val workspaces: List<Space>,
    )

    public data class SpaceCardOpenTarget(
        val spaceId: String,
        val agentId: String?,
    )

    public val conversationId: String = savedStateHandle["conversationId"] ?: ""
    public val title: String = savedStateHandle["title"] ?: ""
    public val currentUserId: String? = tokenManager.userId?.takeIf { it.isNotBlank() }
    private val imCacheScopeId: String = currentUserId ?: "anonymous"
    private val legacySnapshotCache = ImMessagePreferencesCache(context)
    private val handoffRepository = ImHandoffRepository(imApi)
    private val _detail = MutableStateFlow<ImConversationDetail?>(null)
    public val detail: StateFlow<ImConversationDetail?> = _detail.asStateFlow()
    private val _externalDirectMessageSendAccess =
        MutableStateFlow(ExternalDirectMessageSendAccess.CHECKING)
    internal val externalDirectMessageSendAccess: StateFlow<ExternalDirectMessageSendAccess> =
        _externalDirectMessageSendAccess.asStateFlow()
    private val _agentBindings = MutableStateFlow<List<ImConversationAgentBinding>>(emptyList())
    public val agentBindings: StateFlow<List<ImConversationAgentBinding>> = _agentBindings.asStateFlow()
    private val _conversationLabelLibrary = MutableStateFlow<List<ImConversationLabel>>(emptyList())
    public val conversationLabelLibrary: StateFlow<List<ImConversationLabel>> =
        _conversationLabelLibrary.asStateFlow()

    /** 单会话消息流 store：以本 VM 的 scope 串行状态变更。 */
    public val store: ImMessageStore = ImMessageStore(
        conversationId = conversationId,
        transport = messageTransport,
        scope = viewModelScope,
        snapshotCache = ImMessageCompositeCache(
            ImMessageMemoryCache,
            imMessageRoomCache.snapshotCache(imCacheScopeId),
        ),
        pinnedSnapshotCache = ImPinnedMessageCompositeCache(
            ImPinnedMessageMemoryCache,
            imMessageRoomCache.pinnedSnapshotCache(imCacheScopeId),
        ),
        readStateCache = imMessageRoomCache,
        pendingCache = ImPendingMessagePreferencesCache(context),
        cacheScopeId = imCacheScopeId,
        // markRead 落账后同步会话列表角标清零（覆盖 enterConversation 后的 reload 竞态）。
        onMarkReadConfirmed = { conversationStore.clearUnread(it) },
        onMessageEnqueued = { preview ->
            val listedSeq = conversationStore.conversations.value
                .firstOrNull { it.id == conversationId }
                ?.lastMessageSeq ?: 0
            conversationStore.applyLatestPreviewUpdate(
                conversationId = conversationId,
                messageSeq = listedSeq,
                preview = preview,
            )
        },
        onMessageConfirmed = { message ->
            conversationStore.applyLatestPreviewUpdate(
                conversationId = message.conversationId,
                messageSeq = message.seq,
                preview = message.threadDisplayTextForPreview(),
            )
        },
        // Store 在每个发送 request 的终态（成功、实时确认、清空、离开）释放附件 usage。
        // 侧写走 Service 自有 scope，因 onCleared 时 viewModelScope 已取消。
        onReleaseAbandonedAttachment = { attachment ->
            ossUploadService.deactivateUsageDetached(
                fileId = attachment.fileId,
                module = "tabchat",
                contextType = "im_message",
                contextId = conversationId,
            )
        },
        canSend = {
            !isImConversationReadOnly(
                snapshot = conversationStore.conversations.value.firstOrNull { it.id == conversationId },
                detail = _detail.value,
            ) && (!isExternalDirectMessage() ||
                _externalDirectMessageSendAccess.value == ExternalDirectMessageSendAccess.ALLOWED)
        },
    )

    /** 转发目标复用全局会话清单；列表已按当前组织加载。 */
    public val conversations: StateFlow<List<ImConversation>> = conversationStore.conversations
    private val _organizationMembers = MutableStateFlow<List<com.tabtin.mobile.data.model.OrganizationMember>>(emptyList())
    public val organizationMembers: StateFlow<List<com.tabtin.mobile.data.model.OrganizationMember>> = _organizationMembers.asStateFlow()
    private val directMessageOpenMutex = Mutex()
    private val externalDirectMessageAccessMutex = Mutex()
    private val legacySessionShareRequests =
        ImCardDetailRequestCoalescer<ImSessionShareCard>(viewModelScope)
    private val sessionShareV2Requests =
        ImCardDetailRequestCoalescer<ImSessionShareV2Detail>(viewModelScope)
    private val sessionContinuationRequests =
        ImCardDetailRequestCoalescer<ImSessionContinuationDetail>(viewModelScope)

    /**
     * 会话所属组织是资源卡/名片的授权边界。详情尚未回到时回退已加载的会话列表快照，
     * 绝不使用全局当前组织，避免用户切组织后把错误资源发进当前会话。
     */
    public val conversationOrganizationId: String?
        get() = _detail.value?.organizationId?.takeIf { it.isNotBlank() }
            ?: conversationStore.conversations.value
                .firstOrNull { it.id == conversationId }
                ?.organizationId
                ?.takeIf { it.isNotBlank() }

    /** 外部会话按参与者目录刷新列表；内部会话与托管组织相同。 */
    public val conversationDirectoryOrganizationId: String?
        get() = _detail.value?.directoryOrganizationId?.takeIf { it.isNotBlank() }
            ?: conversationStore.conversations.value
                .firstOrNull { it.id == conversationId }
                ?.directoryOrganizationId
                ?.takeIf { it.isNotBlank() }

    /** IM 独享实例，复用成熟 OSS/重试/取消实现，但不与 Agent 会话的单例草稿互相污染。 */
    public val attachmentManager: ChatAttachmentManager =
        ChatAttachmentManager(context, ossUploadService)

    /** 仅群聊可 @ 当前成员；详情未拉到前保守关闭入口。 */
    public val canMentionMembers: Boolean get() = _detail.value?.isGroup == true
    public val isDm: Boolean get() = _detail.value?.isDm == true

    /** typing 节流：上次发出 typing 的时间戳（毫秒）。 */
    private var lastTypingSentMs = 0L
    private var activeStateReconcileJob: Job? = null
    private var listedPreviewReconcileJob: Job? = null
    private val foregroundCatchUp = ImConversationForegroundCatchUp(
        scope = viewModelScope,
        reconcileLatest = store::reconcileLatestState,
    )
    /** 首屏历史已发起后，才用入口 lastMessage 触发静默补拉，对齐 iOS hasLoadedInitial。 */
    private var hasLoadedInitialHistory = false
    /** 同一入口水位只静默补拉一次，避免会话列表反复 reload 时打爆历史查询。 */
    private var reconciledListedPreviewKey: Pair<Int, String>? = null

    init {
        store.currentUserId = currentUserId
        ensureResourceStatusRealtime()
        viewModelScope.launch {
            initializeImRealtimeAfterHistoryVisibility(
                initializeHistoryVisibility = store::initializeHistoryVisibility,
                subscribe = { onSubscriptionAvailable ->
                    centrifugoClient.setChatPublicationListener(conversationId, store::applyRealtime)
                    centrifugoClient.setChatConnectionAvailableListener(conversationId) {
                        onSubscriptionAvailable()
                    }
                    centrifugoClient.subscribeChat(conversationId)
                    centrifugoClient.connect()
                },
                reconcileLatest = {
                    viewModelScope.launch { store.reconcileLatestState() }
                },
            )
        }
        viewModelScope.launch {
            var cachedMessages = imMessageRoomCache.messagesAsync(imCacheScopeId, conversationId)
            if (cachedMessages.isEmpty()) {
                // 一次性兼容旧 SharedPreferences 快照；后续写入只走 Room。
                cachedMessages = legacySnapshotCache.messages(conversationId)
                if (cachedMessages.isNotEmpty()) {
                    imMessageRoomCache.store(imCacheScopeId, conversationId, cachedMessages)
                }
            }
            store.hydrateSnapshotIfNeeded(cachedMessages)
            store.hydratePinnedSnapshotIfNeeded(
                imMessageRoomCache.pinnedMessagesAsync(imCacheScopeId, conversationId),
            )
            store.hydrateReadState(imMessageRoomCache.readWaterlines(imCacheScopeId, conversationId))
            loadDetailContext()
            conversationDirectoryOrganizationId?.let { messageTransport.activate(it) }
            messageTransport.setRealtimeListener(conversationId) { message ->
                store.ingestRealtimeMessage(message)
                if (message.isDeleted) {
                    conversationStore.applyLatestPreviewUpdate(
                        conversationId = conversationId,
                        messageSeq = message.seq,
                        preview = "消息已撤回",
                    )
                }
            }
            store.loadInitial()
            hasLoadedInitialHistory = true
            maybeRefreshLatestFromListedPreview()
        }
        viewModelScope.launch {
            store.conversationRevision.drop(1).collect {
                loadDetailContext()
                conversationDirectoryOrganizationId?.let { conversationStore.reload(it) }
            }
        }
        viewModelScope.launch {
            conversationStore.profileRevision.drop(1).collect {
                loadDetailContext()
            }
        }
        startListedPreviewReconcile()
    }

    /** 当前 destination 恢复前台：才把该会话视为正在阅读，避免父会话被子私信覆盖时误清未读。 */
    public fun onForeground() {
        ensureResourceStatusRealtime()
        conversationStore.enterConversation(conversationId)
        foregroundCatchUp.onForeground()
        store.markReadUpToLatest()
        startActiveStateReconcile()
        viewModelScope.launch { refreshExternalDirectMessageSendAccess() }
    }

    public fun onBackground() {
        stopActiveStateReconcile()
        conversationStore.leaveConversation(conversationId)
    }

    /**
     * 资源卡权限状态走用户级 context.sync 事件，不属于会话消息通道。
     * 纯 IM 用户可能从未进入 Agent 会话，因此这里必须主动拉起通用 WS；否则卡片只能在
     * 滚动重建时靠 preview HTTP 对账，看起来像“实时事件没生效”。用户 topic 是全局订阅，
     * 离开单个会话时不退订，避免父子会话互相断掉实时状态。
     */
    private fun ensureResourceStatusRealtime() {
        val userId = currentUserId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        webSocketService.subscribe(listOf("context.sync.user.$userId"))
        webSocketService.connect()
        webSocketService.reconnectIfNeeded()
    }

    /**
     * reaction/read/pin 实时事件在真机上偶尔漏一次，但下一次历史
     * 查询能拿到权威状态。仅当前前台会话做静默对账，让跨端 reaction 不必退出重进才出现。
     */
    private fun startActiveStateReconcile() {
        if (activeStateReconcileJob?.isActive == true) return
        activeStateReconcileJob = viewModelScope.launch {
            while (isActive) {
                delay(ACTIVE_STATE_RECONCILE_MS)
                store.reconcileLatestState()
            }
        }
    }

    private fun stopActiveStateReconcile() {
        activeStateReconcileJob?.cancel()
        activeStateReconcileJob = null
    }

    /**
     * 会话列表 lastMessage 常比详情历史更早更新。入口 seq 超前时立刻静默补拉，
     * 不等 5s 轮询；实时层还会把 lastMessage 投进 listener。
     */
    private fun startListedPreviewReconcile() {
        if (listedPreviewReconcileJob?.isActive == true) return
        listedPreviewReconcileJob = viewModelScope.launch {
            conversationStore.conversations.collect {
                maybeRefreshLatestFromListedPreview()
            }
        }
    }

    private fun maybeRefreshLatestFromListedPreview() {
        val listed = conversationStore.conversations.value
            .firstOrNull { it.id == conversationId }
            ?: return
        val listedSeq = listed.lastMessageSeq
        val visibleMessages = store.messages.value
        val visibleSeq = visibleMessages.maxOfOrNull { it.seq } ?: 0
        val visibleLastAt = visibleMessages
            .mapNotNull { parseImMessageInstant(it.createdAt) }
            .maxOrNull()
            ?.toString()
        if (
            !imShouldRefreshLatestFromListedPreview(
                hasLoadedInitial = hasLoadedInitialHistory,
                listedLastMessageSeq = listedSeq,
                visibleLastMessageSeq = visibleSeq,
                listedLastMessageAt = listed.lastMessageAt,
                visibleLastMessageAt = visibleLastAt,
            )
        ) {
            return
        }
        val reconcileKey = listedSeq to (listed.lastMessageAt.orEmpty())
        if (reconcileKey == reconciledListedPreviewKey) return
        reconciledListedPreviewKey = reconcileKey
        viewModelScope.launch { store.reconcileLatestState() }
    }

    /** 拉会话详情：判定群聊（可 @ Agent）与已在会话的 Agent 成员；失败不阻塞收发。 */
    private fun loadDetail() {
        viewModelScope.launch {
            loadDetailContext()
        }
    }

    private suspend fun loadDetailContext() {
        val fetchedDetail = runCatching { conversationService.fetchDetail(conversationId) }.getOrNull()
        _detail.value = fetchedDetail
        _agentBindings.value = if (
            fetchedDetail?.isGroup == true &&
            !fetchedDetail.isExternal &&
            !fetchedDetail.isTeamSpaceChannel
        ) {
            runCatching { conversationService.listAgentBindings(conversationId) }.getOrDefault(emptyList())
        } else {
            emptyList()
        }
        fetchedDetail?.organizationId
            ?.takeIf { it.isNotBlank() }
            ?.let {
                attachmentManager.bindSession(
                    conversationId,
                    UploadScope(
                        module = "tabchat",
                        contextType = "im_message",
                        contextId = conversationId,
                        organizationId = it,
                        isPublic = true,
                    ),
                )
                val members = runCatching { organizationRepository.loadMembers(it) }.getOrDefault(emptyList())
                _organizationMembers.value = members
                _detail.value = _detail.value?.let { detail ->
                    ImMemberDisplayPolicy.enrichedDetail(detail, members)
                }
                prewarmAvatarImages(_detail.value)
                _conversationLabelLibrary.value = runCatching {
                    conversationLabelRepository.list(it)
                }.getOrDefault(_conversationLabelLibrary.value)
            }
        refreshExternalDirectMessageSendAccess()
    }

    private fun isExternalDirectMessage(): Boolean {
        val snapshot = conversationStore.conversations.value.firstOrNull { it.id == conversationId }
        val external = _detail.value?.isExternal == true || snapshot?.isExternal == true
        val directMessage = _detail.value?.isDm == true || snapshot?.type == ImConversationType.DM
        return external && directMessage
    }

    private fun externalDirectMessagePeerUserId(): String? {
        val snapshotPeerUserId = conversationStore.conversations.value
            .firstOrNull { it.id == conversationId }
            ?.dmPeerUserId
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
        if (snapshotPeerUserId != null) return snapshotPeerUserId
        val currentUserId = currentUserId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return _detail.value?.members
            ?.firstOrNull { !it.isAgent && it.userId != currentUserId }
            ?.userId
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
    }

    /**
     * 会话详情里的 can_send 可能还没收到对端解除关系的更新，外部私聊须以联系人目录复核。
     * 无法确认时也不把消息先乐观入队，避免用户看到“已发送”但实际关系已经结束。
     */
    private suspend fun refreshExternalDirectMessageSendAccess(): Boolean =
        externalDirectMessageAccessMutex.withLock {
            if (!isExternalDirectMessage()) {
                _externalDirectMessageSendAccess.value = ExternalDirectMessageSendAccess.ALLOWED
                return@withLock true
            }
            val organizationId = conversationDirectoryOrganizationId
            val peerUserId = externalDirectMessagePeerUserId()
            if (organizationId.isNullOrBlank() || peerUserId.isNullOrBlank()) {
                _externalDirectMessageSendAccess.value = ExternalDirectMessageSendAccess.UNAVAILABLE
                return@withLock false
            }

            _externalDirectMessageSendAccess.value = ExternalDirectMessageSendAccess.CHECKING
            return@withLock runSuspendCatching {
                canSendExternalDirectMessage(
                    contacts = externalContactRepository.list(organizationId),
                    peerUserId = peerUserId,
                )
            }.fold(
                onSuccess = { allowed ->
                    _externalDirectMessageSendAccess.value = if (allowed) {
                        ExternalDirectMessageSendAccess.ALLOWED
                    } else {
                        ExternalDirectMessageSendAccess.DENIED
                    }
                    allowed
                },
                onFailure = {
                    _externalDirectMessageSendAccess.value = ExternalDirectMessageSendAccess.UNAVAILABLE
                    false
                },
            )
        }

    /** 提前以消息列表的 36dp 缓存键解码成员头像，LazyColumn 重新创建 item 时可同步命中。 */
    private fun prewarmAvatarImages(detail: ImConversationDetail?) {
        val sizePx = (36 * context.resources.displayMetrics.density).roundToInt().coerceAtLeast(1)
        val urls = detail?.members.orEmpty()
            .map { it.avatar.trim() }
            .filter { it.isNotEmpty() }
            .toSet()
        val imageLoader = context.imageLoader
        urls.forEach { imageUrl ->
            imageLoader.enqueue(identityAvatarImageRequest(context, imageUrl, sizePx))
        }
    }

    public fun refreshDetail(): Unit = loadDetail()

    public suspend fun renameConversation(name: String): Result<Unit> = runCatching {
        val trimmed = name.trim()
        conversationService.renameConversation(conversationId, trimmed)
        conversationStore.updateConversationName(conversationId, trimmed)
        _detail.value = _detail.value?.copy(name = trimmed)
    }

    /** 群头像使用与 Electron 一致的公开 conversation scope；uri=null 表示移除。 */
    public suspend fun updateGroupAvatar(uri: Uri?): Result<String> = runCatching {
        val current = _detail.value ?: error("会话信息尚未就绪")
        check(current.isGroup) { "仅群聊可修改头像" }
        val avatarUrl = if (uri == null) {
            ""
        } else {
            val data = prepareGroupAvatarJPEG(uri)
            val upload = ossUploadService.directUpload(
                data = data,
                fileName = "group-avatar-$conversationId.jpg",
                contentType = "image/jpeg",
                folder = "im/avatars",
                scope = UploadScope(
                    module = "tabchat",
                    contextType = "conversation",
                    contextId = conversationId,
                    organizationId = current.organizationId,
                    isPublic = true,
                ),
            )
            upload.accessUrl.trim().also { check(it.isNotEmpty()) { "群头像上传未返回可用地址" } }
        }
        conversationService.updateConversationAvatar(conversationId, avatarUrl)
        conversationStore.updateConversationAvatar(conversationId, avatarUrl)
        _detail.value = current.copy(avatarUrl = avatarUrl)
        avatarUrl
    }

    private suspend fun prepareGroupAvatarJPEG(uri: Uri): ByteArray = withContext(Dispatchers.IO) {
        val raw = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: error("无法读取这张图片")
        val source = BitmapFactory.decodeByteArray(raw, 0, raw.size)
            ?: error("无法解析这张图片")
        try {
            val side = minOf(source.width, source.height)
            val left = (source.width - side) / 2
            val top = (source.height - side) / 2
            val cropped = Bitmap.createBitmap(source, left, top, side, side)
            try {
                val outputBitmap = if (side > 512) {
                    Bitmap.createScaledBitmap(cropped, 512, 512, true)
                } else {
                    cropped
                }
                try {
                    ByteArrayOutputStream().use { output ->
                        check(outputBitmap.compress(Bitmap.CompressFormat.JPEG, 80, output)) {
                            "群头像处理失败"
                        }
                        output.toByteArray()
                    }
                } finally {
                    if (outputBitmap !== cropped) outputBitmap.recycle()
                }
            } finally {
                if (cropped !== source) cropped.recycle()
            }
        } finally {
            source.recycle()
        }
    }

    public suspend fun toggleMute(): Result<Boolean> = runCatching {
        // Store 通过数据面写入免打扰目标值，页面只负责乐观反馈与失败提示。
        val currentlyMuted = conversationStore.conversations.value
            .firstOrNull { it.id == conversationId }
            ?.isMuted
            ?: false
        val muted = !currentlyMuted
        conversationStore.setMuted(conversationId, muted)
        muted
    }

    /** 置顶 SSoT = Django 会话置顶契约；返回切换后的 pinned。 */
    public suspend fun togglePin(): Result<Boolean> = runCatching {
        conversationStore.togglePin(conversationId)
        conversationStore.conversations.value
            .firstOrNull { it.id == conversationId }
            ?.pinned
            ?: false
    }

    public suspend fun inviteMembers(memberIds: List<String>): Result<Int> = runCatching {
        val added = conversationService.addMembers(conversationId, memberIds).size
        refreshConversationContext()
        added
    }

    /** 外部群继续邀请已建立关系的联系人；联系人目录与会话成员身份保持分层。 */
    public suspend fun loadExternalContacts(): Result<List<ExternalContact>> = runCatching {
        val detail = _detail.value ?: error("会话信息尚未就绪")
        check(detail.isGroup && detail.isExternal) { "仅外部群可邀请外部联系人" }
        externalContactRepository.list(detail.directoryOrganizationId)
            .filter { it.relationship == "friend" }
    }

    public suspend fun inviteExternalMembers(contactIds: List<String>): Result<Int> = runCatching {
        val detail = _detail.value ?: error("会话信息尚未就绪")
        check(detail.isGroup && detail.isExternal) { "仅外部群可邀请外部联系人" }
        val added = conversationService.addExternalMembers(conversationId, contactIds).size
        refreshConversationContext()
        added
    }

    public suspend fun removeMember(member: ImMember): Result<Unit> = runCatching {
        check(!member.isAgent) { "Agent 成员需通过 Agent 管理入口移除" }
        val userId = member.userId?.takeIf { it.isNotBlank() } ?: error("缺少成员身份")
        conversationService.removeMember(conversationId, userId)
        refreshConversationContext()
    }

    public suspend fun removeAgent(member: ImMember): Result<Unit> = runCatching {
        check(member.isAgent) { "当前成员不是 Agent" }
        val agentId = member.agentId?.takeIf { it.isNotBlank() } ?: error("缺少 Agent 身份")
        val binding = _agentBindings.value.firstOrNull { it.agentId == agentId }
        if (binding?.canRebind == true) {
            conversationService.deleteAgentBinding(conversationId, agentId)
        } else {
            conversationService.removeAgent(conversationId, agentId)
        }
        refreshConversationContext()
    }

    private suspend fun refreshConversationContext() {
        val directoryOrganizationId = conversationDirectoryOrganizationId
        loadDetailContext()
        directoryOrganizationId?.takeIf { it.isNotBlank() }?.let { conversationStore.reload(it) }
    }

    public suspend fun leaveGroup(): Result<Unit> = runCatching {
        val userId = currentUserId ?: throw IllegalStateException("用户身份不可用")
        conversationService.leaveConversation(conversationId, userId)
        conversationStore.removeConversation(conversationId)
    }

    public suspend fun clearHistory(): Result<Unit> = runCatching {
        store.clearHistory()
    }

    public suspend fun createConversationLabel(
        name: String,
        color: String,
    ): Result<ImConversationLabel> = runCatching {
        val organizationId = conversationOrganizationId ?: error("会话组织尚未就绪")
        val created = conversationLabelRepository.create(organizationId, name, color)
        _conversationLabelLibrary.value = (_conversationLabelLibrary.value + created).sortedBy { it.name }
        created
    }

    public suspend fun updateConversationLabel(
        labelId: String,
        name: String,
        color: String,
    ): Result<Unit> = runCatching {
        val updated = conversationLabelRepository.update(labelId, name, color)
        _conversationLabelLibrary.value = _conversationLabelLibrary.value
            .map { if (it.id == labelId) updated.copy(conversationCount = it.conversationCount) else it }
            .sortedBy { it.name }
        _detail.value = _detail.value?.copy(
            labels = _detail.value?.labels.orEmpty().map { if (it.id == labelId) updated else it },
        )
        refreshConversationDirectory()
    }

    public suspend fun deleteConversationLabel(labelId: String): Result<Unit> = runCatching {
        conversationLabelRepository.delete(labelId)
        _conversationLabelLibrary.value = _conversationLabelLibrary.value.filterNot { it.id == labelId }
        _detail.value = _detail.value?.copy(
            labels = _detail.value?.labels.orEmpty().filterNot { it.id == labelId },
        )
        refreshConversationDirectory()
    }

    public suspend fun setConversationLabelAssigned(
        labelId: String,
        assigned: Boolean,
    ): Result<Unit> = runCatching {
        val labels = if (assigned) {
            conversationLabelRepository.addToConversation(conversationId, listOf(labelId))
        } else {
            conversationLabelRepository.removeFromConversation(conversationId, labelId)
        }
        _detail.value = _detail.value?.copy(labels = labels)
        val organizationId = conversationOrganizationId
        if (organizationId != null) {
            _conversationLabelLibrary.value = conversationLabelRepository.list(organizationId)
        }
        refreshConversationDirectory()
    }

    private suspend fun refreshConversationDirectory() {
        conversationDirectoryOrganizationId?.takeIf { it.isNotBlank() }?.let {
            conversationStore.reload(it)
        }
    }

    public suspend fun loadConversationAssets(): List<com.tabtin.mobile.data.im.ImMessage> {
        return messageTransport.fetchMessages(conversationId, before = null, limit = 100)
            .filter {
                it.messageType == ImMessageType.FILE ||
                    it.messageType == ImMessageType.IMAGE ||
                    it.metadata?.cardType in setOf("document", "table")
            }
            .distinctBy { it.id }
            .sortedByDescending { it.id }
    }

    // MARK: - 发送 / 编辑

    /** 发送文本；[mentions] 非空则正文带 @名字（可读）+ metadata.mentioned_agent_ids（触发回复）。 */
    public fun sendText(rawText: String, mentions: List<ImAgentSummary>) {
        viewModelScope.launch {
            if (!refreshExternalDirectMessageSendAccess()) return@launch
            enqueueText(rawText, mentions)
        }
    }

    private fun enqueueText(rawText: String, mentions: List<ImAgentSummary>) {
        val text = rawText.trim()
        val prefix = mentions.joinToString(" ") { "@${it.displayName}" }
        val content = when {
            mentions.isEmpty() -> text
            text.isEmpty() -> prefix
            else -> "$prefix $text"
        }
        if (content.isEmpty()) return
        if (!isImMessageContentWithinLimit(content)) return
        store.send(
            content = content,
            messageType = ImMessageType.TEXT,
            mentionedAgentIds = mentions.map { it.id },
        )
    }

    /** 文本/附言与单个附件作为同一条 IM 消息立即入队，网络确认在 Store 后台顺序执行。 */
    public suspend fun sendDraft(
        rawText: String,
        mentions: List<ImDraftMention>,
        replyToId: Int? = null,
        card: ImOutgoingCard? = null,
    ): ImSendOutcome {
        if (!refreshExternalDirectMessageSendAccess()) return ImSendOutcome.REJECTED_READ_ONLY
        return enqueueDraft(rawText, mentions, replyToId, card)
    }

    private fun enqueueDraft(
        rawText: String,
        mentions: List<ImDraftMention>,
        replyToId: Int? = null,
        card: ImOutgoingCard? = null,
    ): ImSendOutcome {
        val attachment = attachmentManager.attachments.value.firstOrNull()
        if (attachment?.status == AttachmentStatus.UPLOADING || attachment?.status == AttachmentStatus.PENDING) {
            return ImSendOutcome.REJECTED_IN_FLIGHT
        }
        if (attachment?.status == AttachmentStatus.ERROR) return ImSendOutcome.REJECTED_IN_FLIGHT
        // 附件与富卡是两个独立语义载体，当前协议一条消息只允许其一，避免客户端造出
        // 后端无法清晰回显的复合消息。UI 会提前提示，数据层仍保留最后一道边界。
        if (attachment != null && card != null) return ImSendOutcome.REJECTED_IN_FLIGHT

        val text = rawText.trim()
        if (text.isNotEmpty() && !isImMessageContentWithinLimit(text)) {
            return ImSendOutcome.REJECTED_TOO_LONG
        }
        val activeMentions = mentions.filter { mention ->
            Regex("@${Regex.escape(mention.displayName)}(?=[\\s,;.!?，。！？、；：]|$)").containsMatchIn(text)
        }
        if (text.isEmpty() && attachment == null && card == null) return ImSendOutcome.REJECTED_IN_FLIGHT

        val outgoing = attachment?.fileId?.let { fileId ->
            ImOutgoingAttachment(
                fileId = fileId,
                fileName = attachment.filename,
                fileSize = attachment.size,
                fileType = attachment.mimeType,
                remoteUrl = attachment.remoteUrl,
            )
        }
        // 卡片的 content 只供旧端和会话预览降级使用。用户附言若复用这一字段，
        // 卡片渲染会刻意隐藏它，造成“发送后文字消失”。因此卡片和附言拆成两条消息。
        val outcome = store.enqueueSend(
            content = card?.fallbackContent ?: text,
            messageType = if (attachment?.type == AttachmentType.IMAGE) {
                ImMessageType.IMAGE
            } else if (attachment != null) {
                ImMessageType.FILE
            } else {
                ImMessageType.TEXT
            },
            replyToId = replyToId,
            mentionedUserIds = if (card == null) activeMentions.mapNotNull { it.userId } else emptyList(),
            mentionedAgentIds = if (card == null) activeMentions.mapNotNull { it.agentId } else emptyList(),
            mentionAll = card == null && _detail.value?.isGroup == true && mentionAllPattern.containsMatchIn(text),
            attachment = outgoing,
            card = card,
        )
        // 同步入队后 pending 已持有附件快照，composer 可立即移除原附件。
        if (attachment != null && outcome.didEnqueue) {
            // 发送动作已经把附件快照捕获进 pending；从 composer 移除，避免用户再次点发送造新幂等键。
            attachmentManager.removeAttachments(setOf(attachment.id), deactivateUploaded = false)
        }
        if (!outcome.didEnqueue || card == null || text.isEmpty()) return outcome

        // 附言作为普通文本消息，才能在卡片之后被看见；@ 语义也只作用在这条可见文本上。
        // 两次发送各自沿用既有 pending/retry 机制，任一路失败都不会吞掉用户内容。
        return store.enqueueSend(
            content = text,
            messageType = ImMessageType.TEXT,
            mentionedUserIds = activeMentions.mapNotNull { it.userId },
            mentionedAgentIds = activeMentions.mapNotNull { it.agentId },
            mentionAll = _detail.value?.isGroup == true && mentionAllPattern.containsMatchIn(text),
        )
    }

    public suspend fun retryPending(pending: com.tabtin.mobile.data.im.ImPendingMessage): ImSendOutcome {
        if (!refreshExternalDirectMessageSendAccess()) return ImSendOutcome.REJECTED_READ_ONLY
        val outcome = store.enqueueSend(
            content = pending.content,
            messageType = pending.messageType,
            replyToId = pending.replyToId,
            mentionedUserIds = pending.mentionedUserIds,
            mentionedAgentIds = pending.mentionedAgentIds,
            mentionAll = pending.mentionAll,
            attachment = pending.attachment,
            card = pending.card,
            clientRequestId = pending.clientRequestId,
            isRetry = true,
        )
        return outcome
    }

    /** 名片与指令卡选择后直接发送；失败会进入与普通消息相同的可重试 pending 队列。 */
    public suspend fun sendCardImmediately(card: ImOutgoingCard): ImSendOutcome {
        if (!refreshExternalDirectMessageSendAccess()) return ImSendOutcome.REJECTED_READ_ONLY
        return store.enqueueSend(
            content = card.fallbackContent,
            messageType = ImMessageType.TEXT,
            card = card,
        )
    }

    /** 对齐 Electron“云文件”：加载当前会话组织下全部可分享云文档与多维表格。 */
    public suspend fun loadCardResources(): Result<List<SpaceResource>> {
        val organizationId = conversationOrganizationId
            ?: return Result.failure(IllegalStateException("会话组织信息尚未就绪"))
        return runCatching {
            spaceResourceRepository.getOrganizationResources(organizationId)
                .filter {
                    it.normalizedType in setOf("tabdoc", "tabdata") && it.isArchived != true
                }
        }
    }

    /** `space_id` 先解析为 Workspace，再读取绑定 Agent；绝不能把两个身份 ID 混用。 */
    public suspend fun resolveSpaceCardOpenTarget(spaceId: String): Result<SpaceCardOpenTarget> =
        runSuspendCatching {
            val normalizedSpaceId = spaceId.trim().takeIf { it.isNotEmpty() }
                ?: throw IllegalArgumentException("Workspace card is missing space_id")
            val workspace = spaceRepository.getWorkspace(normalizedSpaceId)
            SpaceCardOpenTarget(
                spaceId = workspace.id,
                agentId = workspace.primaryAgentId?.trim()?.takeIf { it.isNotEmpty() },
            )
        }

    /** IM 资源卡最新预览：成功时带 ACL 角色；403/404 转成可渲染状态而非整卡不可用。 */
    public suspend fun loadResourceCardPreview(card: ImResourceCard): ImResourceCardPreviewResult {
        val resourceId = card.resourceId?.takeIf { it.isNotBlank() }
            ?: return ImResourceCardPreviewResult(ImResourceCardPreviewStatus.ERROR)
        if (card.type !in setOf(
                com.tabtin.mobile.data.im.ImResourceCardType.DOCUMENT,
                com.tabtin.mobile.data.im.ImResourceCardType.TABLE,
            )
        ) {
            return ImResourceCardPreviewResult(ImResourceCardPreviewStatus.ERROR)
        }
        return try {
            val envelope = imApi.getResourceCardPreview(card.type, resourceId)
            val result = if (envelope.success && envelope.data != null) {
                ImResourceCardPreviewResult(ImResourceCardPreviewStatus.OK, envelope.data)
            } else {
                when (envelope.code) {
                    "403" -> ImResourceCardPreviewResult(ImResourceCardPreviewStatus.FORBIDDEN)
                    "404" -> ImResourceCardPreviewResult(ImResourceCardPreviewStatus.DELETED)
                    else -> ImResourceCardPreviewResult(ImResourceCardPreviewStatus.ERROR)
                }
            }
            ImCardStatusMemoryCache.putResourcePreview(card, result)
            result
        } catch (_: Exception) {
            ImResourceCardPreviewResult(ImResourceCardPreviewStatus.ERROR)
        }
    }

    public suspend fun requestResourceAccess(message: ImMessage, card: ImResourceCard): Result<Unit> = runCatching {
        val resourceId = card.resourceId?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("资源信息不完整")
        val resourceType = when (card.type) {
            com.tabtin.mobile.data.im.ImResourceCardType.DOCUMENT -> "document"
            com.tabtin.mobile.data.im.ImResourceCardType.TABLE -> "table"
            else -> throw IllegalArgumentException("不支持的资源类型")
        }
        imApi.createResourceAccessRequest(
            ImResourceAccessRequestBody(
                sourceConversationId = conversationId,
                sourceMessageId = message.id.takeIf { it > 0 },
                sourceMessageRef = message.metadata?.messageRef,
                resourceType = resourceType,
                resourceId = resourceId,
            ),
        ).requireSuccess()
        ImCardStatusMemoryCache.markResourceAccessRequested(card)
    }

    public suspend fun loadShareableSessions(): Result<List<AllChatSession>> = runCatching {
        allSessionsRepository.listAll(status = "active", limit = 80).sessions
            .filter { it.id.isNotBlank() }
    }

    public suspend fun shareSessionToPeer(
        session: AllChatSession,
        peerUserId: String,
        mode: ImTaskShareMode,
        clientRequestId: String,
    ): Result<Unit> = runCatching {
        if (mode.isContinuation) {
            imApi.createSessionContinuation(
                ImSessionContinuationCreateRequest(
                    sourceSessionId = session.id,
                    recipientUserId = peerUserId,
                    conversationId = conversationId,
                    clientRequestId = clientRequestId,
                ),
            ).unwrap()
        } else {
            imApi.shareChatSession(
                ImSessionShareRequest(
                    sessionId = session.id,
                    granteeUserId = peerUserId,
                    canFork = mode.canFork,
                    canChat = mode.canChat,
                    conversationId = conversationId,
                    clientRequestId = clientRequestId,
                    accessMode = mode.accessMode,
                ),
            ).unwrap()
        }
    }

    public suspend fun loadSessionShareDetail(card: ImSessionShareCard): ImSessionShareCard {
        val shareId = card.shareId.takeIf { it.isNotBlank() } ?: return card
        ImCardStatusMemoryCache.cachedAuthoritativeSessionShare(shareId)?.let { return it }
        return legacySessionShareRequests.load(shareId) {
            imApi.getSessionShare(shareId).unwrap().toCardSnapshot()
                .also(ImCardStatusMemoryCache::putAuthoritativeSessionShare)
        }.getOrElse { ImCardStatusMemoryCache.cachedSessionShare(shareId) ?: card }
    }

    public suspend fun loadSessionShareV2Detail(card: ImSessionShareV2Card): Result<ImSessionShareV2Detail> {
        val shareId = card.objectId.takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("共享任务信息不完整"))
        ImCardStatusMemoryCache.cachedSessionShareV2Detail(shareId, card.version)?.let {
            return Result.success(it)
        }
        return sessionShareV2Requests.load("$shareId:${card.version}") {
            val item = imApi.batchGetSessionShareV2(ImSessionShareV2BatchRequest(listOf(shareId)))
                .unwrap()
                .items
                .firstOrNull { it.objectId == shareId }
                ?: error("共享任务详情不可用")
            if (!item.ok || item.detail == null) {
                error(item.error ?: "共享任务详情不可用")
            }
            item.detail.also(ImCardStatusMemoryCache::putSessionShareV2Detail)
        }
    }

    public suspend fun acceptSessionShareV2(card: ImSessionShareV2Card): Result<ImSessionShareV2Detail> = runSuspendCatching {
        val shareId = card.objectId.takeIf { it.isNotBlank() }
            ?: error("共享任务信息不完整")
        imApi.acceptSessionShareV2(shareId)
            .unwrap()
            .also(ImCardStatusMemoryCache::putSessionShareV2Detail)
    }

    public suspend fun retrySessionShareV2Delivery(card: ImSessionShareV2Card): Result<ImSessionShareV2Detail> = runSuspendCatching {
        val shareId = card.objectId.takeIf { it.isNotBlank() }
            ?: error("共享任务信息不完整")
        imApi.retrySessionShareV2Delivery(shareId).unwrap()
            .also(ImCardStatusMemoryCache::putSessionShareV2Detail)
    }

    public suspend fun loadSessionContinuation(
        card: ImSessionContinuationCard,
    ): Result<ImSessionContinuationDetail> {
        val objectId = card.objectId.takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("任务续接信息不完整"))
        ImCardStatusMemoryCache.cachedSessionContinuationDetail(objectId, card.version)?.let {
            return Result.success(it)
        }
        return sessionContinuationRequests.load("$objectId:${card.version}") {
            val item = imApi.batchGetSessionContinuations(
                ImSessionContinuationBatchRequest(listOf(objectId)),
            ).unwrap().items.firstOrNull { it.objectId == objectId }
                ?: error("任务续接详情不可用")
            if (!item.ok || item.detail == null) error(item.error ?: "任务续接详情不可用")
            item.detail.also(ImCardStatusMemoryCache::putSessionContinuationDetail)
        }
    }

    public suspend fun loadContinuationExecutionTargets(
        organizationId: String,
    ): Result<ContinuationExecutionTargets> = runCatching {
        val agents = SharedSessionExecutionTargetPolicy.agents(
            agents = spaceRepository.getAgents(),
            organizationId = organizationId,
        )
        val workspaces = SharedSessionExecutionTargetPolicy.workspaces(
            spaces = spaceRepository.getSpaces(),
            organizationId = organizationId,
        )
        ContinuationExecutionTargets(agents = agents, workspaces = workspaces)
    }

    public suspend fun createTaskFromSessionContinuation(
        card: ImSessionContinuationCard,
        agentId: String,
        workspaceId: String,
        clientRequestId: String,
    ): Result<ImSessionContinuationDetail> = runSuspendCatching {
        imApi.createTaskFromSessionContinuation(
            objectId = card.objectId,
            body = ImSessionContinuationCreateTaskRequest(
                agentId = agentId,
                workspaceId = workspaceId,
                clientRequestId = clientRequestId,
            ),
        ).unwrap().also(ImCardStatusMemoryCache::putSessionContinuationDetail)
    }

    public suspend fun createHandoffFromMessage(
        message: ImMessage,
        goal: String,
        recipientIds: List<String>,
    ): Result<ImHandoffPackage> = runSuspendCatching {
        require(message.id > 0) { "原消息尚未发送完成" }
        val references = buildList {
            add(ImHandoffReferenceRequest("im_message", message.id.toString()))
            message.resourceCard?.let { card ->
                val resourceId = card.resourceId?.trim().orEmpty()
                if (resourceId.isNotEmpty() &&
                    (card.type == ImResourceCardType.DOCUMENT || card.type == ImResourceCardType.TABLE)
                ) {
                    add(ImHandoffReferenceRequest(card.type, resourceId))
                }
            }
        }
        handoffRepository.create(
            conversationId = conversationId,
            goal = goal,
            recipientIds = recipientIds,
            references = references,
        )
    }

    public suspend fun loadHandoff(handoffId: String): Result<ImHandoffPackage> =
        runSuspendCatching { handoffRepository.get(handoffId) }

    public suspend fun markHandoffTakingOver(handoffId: String): Result<ImHandoffPackage> =
        runSuspendCatching { handoffRepository.act(handoffId, action = "take_over") }

    public suspend fun revokeHandoff(handoffId: String): Result<ImHandoffPackage> =
        runSuspendCatching { handoffRepository.revoke(handoffId) }

    public suspend fun takeOverHandoff(
        handoffId: String,
        agentId: String,
        workspaceId: String,
    ): Result<ChatSession> = runSuspendCatching {
        handoffRepository.takeOver(handoffId, agentId, workspaceId)
    }

    public suspend fun revokeSessionShare(card: ImSessionShareCard): Result<ImSessionShareCard> = runSuspendCatching {
        imApi.revokeSessionShare(card.shareId).unwrap().toCardSnapshot()
            .also(ImCardStatusMemoryCache::putAuthoritativeSessionShare)
    }

    public suspend fun resumeSessionShare(card: ImSessionShareCard): Result<ImSessionShareCard> = runSuspendCatching {
        val sessionId = requireNotNull(card.sessionId?.trim()?.takeIf { it.isNotEmpty() }) {
            "任务信息不完整"
        }
        val granteeUserId = requireNotNull(card.granteeUserId?.trim()?.takeIf { it.isNotEmpty() }) {
            "接收者信息不完整"
        }
        imApi.shareChatSession(
            ImSessionShareRequest(
                sessionId = sessionId,
                granteeUserId = granteeUserId,
                canFork = card.canFork,
                canChat = card.canChat,
                conversationId = conversationId,
                restoreShareId = card.shareId,
                cardContract = ImResourceCardType.SESSION_SHARE,
                accessMode = if (card.canChat) "collaborate" else if (card.canFork) "fork" else "view",
            ),
        ).unwrap().toCardSnapshot().also(ImCardStatusMemoryCache::putAuthoritativeSessionShare)
    }

    /** 名片候选同样以会话组织为范围；成功后回写会话已有成员快照，供其它入口复用。 */
    public suspend fun loadContactCardMembers(): Result<List<com.tabtin.mobile.data.model.OrganizationMember>> {
        val organizationId = conversationOrganizationId
            ?: return Result.failure(IllegalStateException("会话组织信息尚未就绪"))
        return runCatching { organizationRepository.loadMembers(organizationId) }
            .onSuccess { _organizationMembers.value = it }
    }

    private suspend fun deactivateUploadStageUsage(attachment: ImOutgoingAttachment?) {
        val fileId = attachment?.fileId ?: return
        ossUploadService.deactivateUsage(
            fileId = fileId,
            module = "chat",
            contextType = "message",
            contextId = conversationId,
        )
    }

    public fun addAttachment(uri: Uri): ChatAttachmentManager.AddResult =
        if (attachmentManager.attachments.value.isNotEmpty()) {
            ChatAttachmentManager.AddResult.Error(
                com.tabtin.mobile.data.model.AppError.AttachmentLimit(1),
            )
        } else {
            attachmentManager.addAttachment(uri, viewModelScope)
        }

    public fun retryAttachment(id: String) {
        attachmentManager.retrySingle(id, viewModelScope)
    }

    public fun removeAttachment(id: String) {
        attachmentManager.removeAttachment(id)
    }

    public fun editMessage(messageId: Int, newContent: String) {
        viewModelScope.launch { store.editMessage(messageId, newContent) }
    }

    public suspend fun recallMessage(messageId: Int): Boolean {
        val original = store.messages.value.firstOrNull { it.id == messageId } ?: return false
        val loadedLastSeq = store.messages.value.maxOfOrNull { it.seq } ?: 0
        val listedLastSeq = conversationStore.conversations.value
            .firstOrNull { it.id == conversationId }
            ?.lastMessageSeq
            ?: 0
        val isLatest = imRecallTargetIsLatest(
            targetSeq = original.seq,
            loadedLastSeq = loadedLastSeq,
            listedLastSeq = listedLastSeq,
        )
        if (isLatest) {
            conversationStore.applyLatestPreviewUpdate(
                conversationId = conversationId,
                messageSeq = original.seq,
                preview = "消息已撤回",
            )
        }
        val success = store.recallMessage(messageId)
        if (!success && isLatest) {
            conversationStore.applyLatestPreviewUpdate(
                conversationId = conversationId,
                messageSeq = original.seq,
                preview = original.threadDisplayTextForPreview(),
            )
        }
        return success
    }

    /** 服务端会按群成员角色或 DM 成员身份判断置顶权限。 */
    public suspend fun toggleMessagePin(message: com.tabtin.mobile.data.im.ImMessage): Result<Boolean> = runCatching {
        val pinned = !message.isPinned
        store.pinMessage(message.id, pinned)
        pinned
    }

    /** 转发沿用桌面端 metadata.forwarded_from；逐条发送使单条失败不会吞掉其他已选消息。 */
    public suspend fun forwardMessages(
        messages: List<com.tabtin.mobile.data.im.ImMessage>,
        target: ImConversation,
        sourceConversationName: String = title,
    ): ForwardOutcome {
        var sent = 0
        var failed = 0
        for (message in messages) {
            try {
                messageTransport.forwardMessage(
                    targetConversationId = target.id,
                    message = message,
                    sourceConversationName = sourceConversationName,
                    clientRequestId = UUID.randomUUID().toString(),
                )
                sent += 1
            } catch (_: Exception) {
                failed += 1
            }
        }
        return ForwardOutcome(sent = sent, failed = failed)
    }

    // MARK: - typing

    /** 输入时向 `chat:{conv}` publish typing（3s 节流；空串/未登录不发）。 */
    public fun onDraftChanged(draft: String) {
        val userId = currentUserId ?: return
        if (draft.trim().isEmpty()) return
        val now = System.currentTimeMillis()
        if (now - lastTypingSentMs <= TYPING_THROTTLE_MS) return
        lastTypingSentMs = now
        val payload = "{\"type\":\"im.typing\",\"user_id\":\"$userId\"}"
        centrifugoClient.publishToChat(conversationId, payload)
    }

    // MARK: - @Agent

    /** 已在会话内的 Agent id（picker 据此判断是否需先入群）。 */
    public fun existingAgentIds(): Set<String> = _detail.value?.agentMemberIds ?: emptySet()

    /** 只有仍绑定可执行 Workspace 的 Agent 才能直接进入 mention。 */
    public fun canMentionAgentDirectly(agentId: String): Boolean =
        canMentionAgentDirectly(agentId, existingAgentIds(), _agentBindings.value)

    public suspend fun searchAgents(query: String): Result<List<ImAgentSummary>> {
        val orgId = _detail.value?.organizationId?.takeIf { it.isNotBlank() }
            ?: return Result.success(emptyList())
        return runCatching { conversationService.searchAgents(orgId, query) }
    }

    /** 频道消息问询与普通群 Agent binding 是两条语义：前者创建个人执行会话。 */
    public suspend fun createAgentTaskFromMessage(
        message: ImMessage,
        agentId: String,
        additionalContext: String,
    ): Result<ImAgentTaskThreadResult> = runSuspendCatching {
        val conversation = _detail.value
            ?: throw IllegalStateException("会话信息尚未就绪")
        require(conversation.isTeamSpaceChannel && !conversation.isExternal) {
            "仅项目频道支持询问 Agent"
        }
        require(!message.isDeleted && message.id > 0) { "消息尚未就绪" }
        require(agentId.isNotBlank()) { "请先选择一个 Agent" }
        conversationService.createAgentTaskFromMessage(
            conversationId = conversationId,
            messageId = message.id,
            agentId = agentId,
            additionalContext = additionalContext,
        )
    }

    /** 当前组织下可作为 Agent 执行现场的个人 Workspace。最终合法性仍由 binding API 校验。 */
    public suspend fun loadAgentWorkspaces(): Result<List<Space>> = runSuspendCatching {
        val organizationId = conversationOrganizationId
            ?: throw IllegalStateException("会话组织信息尚未就绪")
        spaceRepository.getSpaces().filter {
            it.organizationId == organizationId &&
                it.isExecutionSpace &&
                it.isArchived != true &&
                it.executionDeviceId != null
        }
    }

    /** 只有 binding 可执行时直接 @；已有成员的缺失/失效 binding 也必须补绑或换绑。 */
    public suspend fun addAgentToConversation(
        agent: ImAgentSummary,
        workspaceId: String?,
    ): Result<Unit> {
        if (canMentionAgentDirectly(agent.id)) return Result.success(Unit)
        val selectedWorkspaceId = workspaceId?.trim().takeIf { !it.isNullOrEmpty() }
            ?: return Result.failure(IllegalArgumentException("请先选择执行现场"))
        return runCatching {
            val existingBinding = _agentBindings.value.firstOrNull { it.agentId == agent.id }
            if (existingBinding != null) {
                check(existingBinding.canRebind) { "你没有权限更换此 Agent 的执行现场" }
                conversationService.updateAgentBinding(conversationId, agent.id, selectedWorkspaceId)
            } else {
                conversationService.bindAgent(conversationId, agent.id, selectedWorkspaceId)
            }
            loadDetailContext()
        }
    }

    public suspend fun updateAgentWorkspace(agentId: String, workspaceId: String): Result<Unit> = runCatching {
        val binding = _agentBindings.value.firstOrNull { it.agentId == agentId }
            ?: throw IllegalStateException("此 Agent 尚未绑定执行现场")
        check(binding.canRebind) { "你没有权限更换此 Agent 的执行现场" }
        conversationService.updateAgentBinding(conversationId, agentId, workspaceId)
        loadDetailContext()
    }

    /**
     * 点击人类成员/名片后幂等创建或复用 DM。只返回导航目标，不改当前会话栈，
     * 由页面把新会话 push 到现有 route 之上，返回即可恢复原群聊/频道现场。
     */
    public suspend fun createDirectMessage(userId: String, displayName: String): Result<DirectMessageTarget> {
        if (userId.isBlank()) return Result.failure(IllegalArgumentException("缺少目标用户"))
        if (userId == currentUserId) return Result.failure(IllegalArgumentException("不能给自己发私信"))
        val organizationId = conversationOrganizationId
            ?: return Result.failure(IllegalStateException("会话组织信息尚未就绪"))
        if (!directMessageOpenMutex.tryLock()) {
            return Result.failure(IllegalStateException("正在打开私信"))
        }
        return try {
            runCatching {
                val conversationId = resolveDirectMessageConversationId(
                    conversations = conversationStore.conversations.value,
                    organizationId = organizationId,
                    otherUserId = userId,
                ) {
                    conversationService.createOrGetDM(organizationId, userId)
                }
                check(conversationId.isNotBlank()) { "私信会话创建失败" }
                check(conversationId != this.conversationId) { "当前已经在这段私信中" }
                conversationStore.rememberDirectMessage(
                    conversationId = conversationId,
                    organizationId = organizationId,
                    otherUserId = userId,
                    displayName = displayName,
                )
                DirectMessageTarget(conversationId, displayName.ifBlank { "私信" })
            }
        } finally {
            directMessageOpenMutex.unlock()
        }
    }

    // MARK: - 附件

    public suspend fun loadAttachment(message: ImMessage): ImAttachmentUrl? {
        val inlineUrls = message.metadata?.inlineAttachmentUrls.orEmpty()
        if (inlineUrls.isNotEmpty()) {
            return ImAttachmentUrl(
                downloadUrl = inlineUrls.first(),
                fileName = message.attachmentFileName,
                candidateUrls = inlineUrls.drop(1),
            )
        }

        val fileId = message.attachmentFileId?.takeIf { it.isNotBlank() } ?: return null
        return runCatching { ossUploadService.resolveFile(fileId) }
            .onFailure {
                android.util.Log.w(
                    "ImConversationVM",
                    "IM attachment fallback failed conversation=$conversationId message=${message.id} " +
                    "file=$fileId error=${it.message}",
                )
            }
            .getOrNull()
            ?.let {
                ImAttachmentUrl(
                    downloadUrl = it.displayUrl,
                    fileName = it.fileName,
                    candidateUrls = it.displayUrls.drop(1),
                )
            }
            ?.takeIf { it.displayUrls.isNotEmpty() }
    }

    /** 交接快照附件不属于某条 IM 消息，只按冻结的 file_id 经统一 OSS 权限接口换链。 */
    public suspend fun loadHandoffAttachment(fileId: String): ImAttachmentUrl? {
        val normalized = fileId.trim().takeIf { it.isNotEmpty() } ?: return null
        return runCatching { ossUploadService.resolveFile(normalized) }
            .onFailure {
                android.util.Log.w(
                    "ImConversationVM",
                    "Handoff attachment resolve failed conversation=$conversationId " +
                        "file=$normalized error=${it.message}",
                )
            }
            .getOrNull()
            ?.let {
                ImAttachmentUrl(
                    downloadUrl = it.displayUrl,
                    fileName = it.fileName,
                    candidateUrls = it.displayUrls.drop(1),
                )
            }
            ?.takeIf { it.displayUrls.isNotEmpty() }
    }

    override fun onCleared() {
        super.onCleared()
        stopActiveStateReconcile()
        listedPreviewReconcileJob?.cancel()
        listedPreviewReconcileJob = null
        messageTransport.setRealtimeListener(conversationId, null)
        centrifugoClient.unsubscribeChat(conversationId)
        centrifugoClient.setChatPublicationListener(conversationId, null)
        centrifugoClient.setChatConnectionAvailableListener(conversationId, null)
        conversationStore.leaveConversation(conversationId)
        // 失败消息属于可恢复的本地历史；离开会话只持久化，不能释放其附件重试所有权。
        attachmentManager.clear()
    }

    private companion object {
        private const val TYPING_THROTTLE_MS = 3_000L
        private const val ACTIVE_STATE_RECONCILE_MS = 5_000L
    }
}

private fun ImMessage.threadDisplayTextForPreview(): String = when {
    isDeleted -> "消息已撤回"
    sessionContinuationCard != null -> "任务续接"
    sessionShareV2Card != null -> "协作邀请"
    content.isNotBlank() -> content
    isImageAttachment -> "图片"
    isFileAttachment -> if (attachmentFileName.isBlank()) "文件" else "文件：$attachmentFileName"
    resourceCard != null -> "资源消息"
    else -> "消息内容不可用"
}

internal fun imRecallTargetIsLatest(
    targetSeq: Int,
    loadedLastSeq: Int,
    listedLastSeq: Int,
): Boolean = targetSeq >= maxOf(loadedLastSeq, listedLastSeq)

/**
 * 会话列表 lastMessage 已超过详情可见水位时，静默补拉最新页。
 * 群聊可直接比 seq；C2C 的 seq 不是时间线顺序，还要用入口时间戳兜底。
 */
internal fun imShouldRefreshLatestFromListedPreview(
    hasLoadedInitial: Boolean,
    listedLastMessageSeq: Int,
    visibleLastMessageSeq: Int,
    listedLastMessageAt: String? = null,
    visibleLastMessageAt: String? = null,
): Boolean {
    if (!hasLoadedInitial) return false
    if (listedLastMessageSeq > visibleLastMessageSeq) return true
    val listedAt = parseImMessageInstant(listedLastMessageAt) ?: return false
    val visibleAt = parseImMessageInstant(visibleLastMessageAt)
    return visibleAt == null || listedAt > visibleAt
}

public data class DirectMessageTarget(
    val conversationId: String,
    val title: String,
)

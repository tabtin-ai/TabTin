package com.tabtin.mobile.data.im

import android.content.Context
import android.util.Log
import com.tabtin.mobile.data.api.json
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.builtins.ListSerializer
import java.util.UUID

public interface ImMessageSnapshotCache {
    public fun messages(conversationId: String): List<ImMessage>
    public fun store(conversationId: String, messages: List<ImMessage>)
    public fun clear(conversationId: String)
}

public interface ImPinnedMessageSnapshotCache {
    public fun pinnedMessages(conversationId: String): List<ImMessage>
    public fun storePinnedMessages(conversationId: String, messages: List<ImMessage>)
}

public class ImPinnedMessageMemoryCache : ImPinnedMessageSnapshotCache {
    private val snapshots: MutableMap<String, List<ImMessage>> = mutableMapOf()

    override fun pinnedMessages(conversationId: String): List<ImMessage> = synchronized(snapshots) {
        snapshots[conversationId].orEmpty()
    }

    override fun storePinnedMessages(conversationId: String, messages: List<ImMessage>) {
        val visible = messages
            .filter { it.conversationId == conversationId && !it.isDeleted }
            .sortedByDescending { it.seq }
        synchronized(snapshots) { snapshots[conversationId] = visible }
    }

    public companion object Shared : ImPinnedMessageSnapshotCache {
        private val sharedCache = ImPinnedMessageMemoryCache()

        override fun pinnedMessages(conversationId: String): List<ImMessage> =
            sharedCache.pinnedMessages(conversationId)

        override fun storePinnedMessages(conversationId: String, messages: List<ImMessage>): Unit =
            sharedCache.storePinnedMessages(conversationId, messages)

        public fun clearAll() {
            synchronized(sharedCache.snapshots) { sharedCache.snapshots.clear() }
        }
    }
}

public class ImPinnedMessageCompositeCache(
    private vararg val caches: ImPinnedMessageSnapshotCache,
) : ImPinnedMessageSnapshotCache {
    override fun pinnedMessages(conversationId: String): List<ImMessage> =
        caches.firstNotNullOfOrNull { cache ->
            cache.pinnedMessages(conversationId).takeIf { it.isNotEmpty() }
        }.orEmpty()

    override fun storePinnedMessages(conversationId: String, messages: List<ImMessage>) {
        caches.forEach { it.storePinnedMessages(conversationId, messages) }
    }
}

public class ImMessageMemoryCache : ImMessageSnapshotCache {
    private val maxMessages: Int = 100
    private val snapshots: MutableMap<String, List<ImMessage>> = mutableMapOf()

    override fun messages(conversationId: String): List<ImMessage> = synchronized(snapshots) {
        snapshots[conversationId].orEmpty()
    }

    override fun store(conversationId: String, messages: List<ImMessage>) {
        val visible = imChronologicallySortedMessages(
            messages.filter { it.conversationId == conversationId },
        ).takeLast(maxMessages)
        synchronized(snapshots) { snapshots[conversationId] = visible }
    }

    override fun clear(conversationId: String) {
        synchronized(snapshots) { snapshots.remove(conversationId) }
    }

    public companion object Shared : ImMessageSnapshotCache {
        private val sharedCache = ImMessageMemoryCache()

        override fun messages(conversationId: String): List<ImMessage> = sharedCache.messages(conversationId)
        override fun store(conversationId: String, messages: List<ImMessage>): Unit =
            sharedCache.store(conversationId, messages)
        override fun clear(conversationId: String): Unit = sharedCache.clear(conversationId)

        public fun clearAll() {
            synchronized(sharedCache.snapshots) { sharedCache.snapshots.clear() }
        }
    }
}

public class ImMessagePreferencesCache(context: Context) : ImMessageSnapshotCache {
    private val maxMessages: Int = 100
    private val prefs = context.applicationContext.getSharedPreferences("tabtin_im_message_cache", Context.MODE_PRIVATE)
    private val listSerializer = ListSerializer(ImMessage.serializer())

    override fun messages(conversationId: String): List<ImMessage> {
        val raw = prefs.getString(key(conversationId), null) ?: return emptyList()
        return runCatching {
            imChronologicallySortedMessages(
                json.decodeFromString(listSerializer, raw)
                    .filter { it.conversationId == conversationId },
            ).takeLast(maxMessages)
        }.getOrDefault(emptyList())
    }

    override fun store(conversationId: String, messages: List<ImMessage>) {
        val visible = imChronologicallySortedMessages(
            messages.filter { it.conversationId == conversationId },
        ).takeLast(maxMessages)
        val encoded = runCatching { json.encodeToString(listSerializer, visible) }.getOrNull() ?: return
        prefs.edit().putString(key(conversationId), encoded).apply()
    }

    override fun clear(conversationId: String) {
        prefs.edit().remove(key(conversationId)).apply()
    }

    private fun key(conversationId: String): String = "messages:$conversationId"
}

public class ImMessageCompositeCache(private vararg val caches: ImMessageSnapshotCache) : ImMessageSnapshotCache {
    override fun messages(conversationId: String): List<ImMessage> =
        caches.firstNotNullOfOrNull { cache -> cache.messages(conversationId).takeIf { it.isNotEmpty() } }.orEmpty()

    override fun store(conversationId: String, messages: List<ImMessage>) {
        caches.forEach { it.store(conversationId, messages) }
    }

    override fun clear(conversationId: String) {
        caches.forEach { it.clear(conversationId) }
    }
}

public object ImMessageNoopCache : ImMessageSnapshotCache, ImPinnedMessageSnapshotCache {
    override fun messages(conversationId: String): List<ImMessage> = emptyList()
    override fun store(conversationId: String, messages: List<ImMessage>): Unit = Unit
    override fun clear(conversationId: String): Unit = Unit
    override fun pinnedMessages(conversationId: String): List<ImMessage> = emptyList()
    override fun storePinnedMessages(conversationId: String, messages: List<ImMessage>): Unit = Unit
}

public interface ImPendingMessageCache {
    public fun pending(cacheScopeId: String, conversationId: String): List<ImPendingMessage>
    public fun storePending(cacheScopeId: String, conversationId: String, pending: List<ImPendingMessage>)
    public fun clearPending(cacheScopeId: String, conversationId: String)
}

/**
 * 失败/未完成发送的本地历史。恢复的 SENDING 会先由 [ImMessageStore] 按 clientRequestId
 * 与服务端历史对账；已确认的直接收敛，其余在本轮对账结束后降为可重试 FAILED。
 */
public class ImPendingMessagePreferencesCache(context: Context) : ImPendingMessageCache {
    private val prefs = context.applicationContext.getSharedPreferences("tabtin_im_pending_cache", Context.MODE_PRIVATE)
    private val serializer = ListSerializer(ImPendingMessage.serializer())

    override fun pending(cacheScopeId: String, conversationId: String): List<ImPendingMessage> {
        val raw = prefs.getString(key(cacheScopeId, conversationId), null) ?: return emptyList()
        return runCatching { json.decodeFromString(serializer, raw) }
            .getOrDefault(emptyList())
            .distinctBy { it.clientRequestId }
            .map { it.copy(errorMessage = null) }
    }

    override fun storePending(cacheScopeId: String, conversationId: String, pending: List<ImPendingMessage>) {
        if (pending.isEmpty()) {
            clearPending(cacheScopeId, conversationId)
            return
        }
        val encoded = runCatching { json.encodeToString(serializer, pending) }.getOrNull() ?: return
        prefs.edit().putString(key(cacheScopeId, conversationId), encoded).commit()
    }

    override fun clearPending(cacheScopeId: String, conversationId: String) {
        prefs.edit().remove(key(cacheScopeId, conversationId)).commit()
    }

    private fun key(cacheScopeId: String, conversationId: String): String =
        "pending:$cacheScopeId:$conversationId"
}

public object ImPendingMessageNoopCache : ImPendingMessageCache {
    override fun pending(cacheScopeId: String, conversationId: String): List<ImPendingMessage> = emptyList()
    override fun storePending(
        cacheScopeId: String,
        conversationId: String,
        pending: List<ImPendingMessage>,
    ): Unit = Unit
    override fun clearPending(cacheScopeId: String, conversationId: String): Unit = Unit
}

/**
 * 一次发送尝试的结果，供 composer 决定是否清理输入 / 收敛附件用量。
 * - [CONFIRMED]：服务端已接受，可清理 composer 并收敛附件 upload-stage 用量。
 * - [FAILED_PENDING]：已乐观入队但网络失败（保留为可重试 pending），可清理 composer，但**不**收敛用量（留给重试）。
 * - [DISCARDED_AFTER_CLEAR]：清空期间完成的旧发送不再显示，由安全重拉收敛服务端可见性。
 * - [ENQUEUED]：已同步创建独立 pending，传输层在后台按提交顺序执行；composer 可立即清理。
 * - [REJECTED_IN_FLIGHT]：同一失败消息已经在重试，什么都没重复入队。
 * - [REJECTED_TOO_LONG]：正文超过服务端消息契约，什么都没入队，保留 composer 让用户删减。
 */
public enum class ImSendOutcome {
    ENQUEUED,
    CONFIRMED,
    FAILED_PENDING,
    DISCARDED_AFTER_CLEAR,
    REJECTED_IN_FLIGHT,
    REJECTED_TOO_LONG,
    REJECTED_READ_ONLY,
    ;

    /** 内容是否已进入发送管线（已排队、成功或已入队为 pending）——据此判断可否清理 composer。 */
    public val didEnqueue: Boolean
        get() = this != REJECTED_IN_FLIGHT && this != REJECTED_TOO_LONG && this != REJECTED_READ_ONLY
}

/**
 * 单会话消息流的 REST 传输面，抽成接口以便 store 单测注入假实现（不打真网络）。
 */
public interface ImMessageTransport {
    /** 系统已明确离线时跳过传输层排队，直接把对应 pending 标成可重试失败。 */
    public val isSendAvailable: Boolean get() = true

    /** 激活会话所属组织的数据面；旧测试 transport 无需实现。 */
    public suspend fun activate(organizationId: String) {}

    /** 当前会话的实时消息；测试 transport 可沿用默认空实现。 */
    public fun setRealtimeListener(conversationId: String, listener: ((ImMessage) -> Unit)?) {}

    /** 当前会话完整置顶消息列表，按 seq 降序；旧测试 transport 可沿用默认未实现。 */
    public suspend fun fetchPinnedMessages(conversationId: String): List<ImMessage> {
        throw UnsupportedOperationException("pinned message list is unavailable")
    }

    /** 订阅共享实时通道前读取当前账号的个人历史清空水位。 */
    public suspend fun fetchHistoryClearedSeq(conversationId: String): Int {
        throw UnsupportedOperationException("history visibility is unavailable")
    }

    public suspend fun pinMessage(conversationId: String, messageId: Int, pinned: Boolean) {
        throw UnsupportedOperationException("message pinning is unavailable")
    }

    public suspend fun clearHistory(conversationId: String) {
        throw UnsupportedOperationException("history clearing is unavailable")
    }

    /** 清空个人历史并返回服务端实际建立的权威水位。 */
    public suspend fun clearHistoryAndFetchWatermark(conversationId: String): Int {
        clearHistory(conversationId)
        return 0
    }

    public suspend fun leaveConversation(conversationId: String) {
        throw UnsupportedOperationException("conversation leave is unavailable")
    }

    public suspend fun forwardMessage(
        targetConversationId: String,
        message: ImMessage,
        sourceConversationName: String,
        clientRequestId: String,
    ): ImSendMessageResult = sendMessage(
        conversationId = targetConversationId,
        content = message.content,
        messageType = message.messageType,
        replyToId = null,
        mentionedUserIds = emptyList(),
        mentionedAgentIds = emptyList(),
        mentionAll = false,
        attachment = message.metadata?.fileId?.let {
            ImOutgoingAttachment(
                fileId = it,
                fileName = message.metadata.fileName.orEmpty(),
                fileSize = message.metadata.fileSize?.toLong() ?: 0,
                fileType = message.metadata.fileType.orEmpty(),
            )
        },
        card = message.forwardableCard,
        clientRequestId = clientRequestId,
    )

    /** 拉历史：[before] 为消息 id 游标（向上翻页），返回按 seq 升序。 */
    public suspend fun fetchMessages(conversationId: String, before: Int?, limit: Int): List<ImMessage>

    /** 发消息：[clientRequestId] 为幂等键；人和 Agent mention 都写入 metadata，后者触发 Agent 回复。 */
    public suspend fun sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: List<String>,
        mentionedAgentIds: List<String>,
        mentionAll: Boolean,
        attachment: ImOutgoingAttachment?,
        clientRequestId: String,
    ): ImSendMessageResult

    /**
     * 富卡仍是 TEXT + metadata.card。保留单独重载，让既有 fake transport 仍只需实现基础发送
     * 方法；生产 transport 覆盖此方法，把 card 写到请求 metadata。
     */
    public suspend fun sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: List<String>,
        mentionedAgentIds: List<String>,
        mentionAll: Boolean,
        attachment: ImOutgoingAttachment?,
        card: ImOutgoingCard?,
        clientRequestId: String,
    ): ImSendMessageResult = sendMessage(
        conversationId = conversationId,
        content = content,
        messageType = messageType,
        replyToId = replyToId,
        mentionedUserIds = mentionedUserIds,
        mentionedAgentIds = mentionedAgentIds,
        mentionAll = mentionAll,
        attachment = attachment,
        clientRequestId = clientRequestId,
    )

    public suspend fun editMessage(conversationId: String, messageId: Int, content: String): ImMessage
    public suspend fun recallMessage(conversationId: String, messageId: Int)
    public suspend fun addReaction(conversationId: String, messageId: Int, emoji: String)
    public suspend fun removeReaction(conversationId: String, messageId: Int, emoji: String)
    public suspend fun markRead(conversationId: String, lastMessageId: Int)

    public suspend fun fetchReadReceipts(
        conversationId: String,
        messageId: Int,
    ): ImMessageReadReceipts = throw UnsupportedOperationException("read receipt details are unavailable")
}

/** 乐观发送中的消息（以 [clientRequestId] 为幂等键，服务端返回 / 实时回声到达后收敛）。 */
@kotlinx.serialization.Serializable
public data class ImPendingMessage(
    val clientRequestId: String,
    val content: String,
    val messageType: Int,
    val replyToId: Int?,
    val mentionedUserIds: List<String>,
    val mentionedAgentIds: List<String>,
    val mentionAll: Boolean,
    val attachment: ImOutgoingAttachment?,
    /** 富卡快照必须和附件一起跟随 pending，失败重试不得退化成普通文本。 */
    val card: ImOutgoingCard?,
    /** 首次提交时间；失败、刷新和重试都保留，用于与已确认消息组成稳定时间线。 */
    val createdAtEpochMs: Long = System.currentTimeMillis(),
    val errorMessage: String?,
    val status: Status,
) {
    public enum class Status { SENDING, FAILED }
}

/**
 * 单会话消息流 store（Phase B~E），对齐 iOS `IMMessageStore.swift`。
 *
 * 职责：历史分页、乐观发送（幂等键去重）、实时消息合并、编辑/撤回/表情/typing/已读。
 * 消息按 `seq` 升序维护；POST 响应与 `chat:{conv}` 实时回声用消息 id 去重、用
 * `client_request_id` 收敛乐观态，故「自己发的消息」两路到达都只留一条。
 *
 * 状态变更均通过 [scope]（会话屏 viewModelScope，Main）串行；纯合并/应用函数
 * ([mergeConfirmed] / [applyReaction] / [applyDeletedLocal] 等) 同步可测。
 */
public class ImMessageStore(
    public val conversationId: String,
    private val transport: ImMessageTransport,
    private val scope: CoroutineScope,
    private val pageSize: Int = 30,
    private val snapshotCache: ImMessageSnapshotCache = ImMessageNoopCache,
    private val pinnedSnapshotCache: ImPinnedMessageSnapshotCache = ImMessageNoopCache,
    private val readStateCache: ImReadStateCache? = null,
    private val pendingCache: ImPendingMessageCache = ImPendingMessageNoopCache,
    private val cacheScopeId: String = "anonymous",
    /** markRead 成功后回调（用于同步会话列表角标清零，解耦对 ImConversationStore 的直接依赖）。 */
    private val onMarkReadConfirmed: ((conversationId: String) -> Unit)? = null,
    /** pending 同步落地后立即推进目录 subtitle，覆盖“发送后马上返回列表”的网络确认空窗。 */
    private val onMessageEnqueued: ((preview: String) -> Unit)? = null,
    /** 服务端确认发送后推进会话目录摘要，不依赖发送者收到 personal 回声。 */
    private val onMessageConfirmed: ((ImMessage) -> Unit)? = null,
    /**
     * 离开会话时释放被放弃的 pending 附件 upload-stage FileUsage（避免 OSS 资源泄漏，）。
     * 由 VM 在构造时注入；实际 deactivate 侧写在 VM 上（走 Service 自有 scope），store 只负责枚举。
     */
    private val onReleaseAbandonedAttachment: ((ImOutgoingAttachment) -> Unit)? = null,
    private val canSend: () -> Boolean = { true },
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
) {
    private val _messages = MutableStateFlow(snapshotCache.messages(conversationId))
    public val messages: StateFlow<List<ImMessage>> = _messages.asStateFlow()

    /** 服务端返回的完整置顶列表，独立于当前已加载的历史页，按 seq 降序。 */
    private val _pinnedMessages = MutableStateFlow(
        pinnedSnapshotCache.pinnedMessages(conversationId).sortedByDescending { it.seq },
    )
    public val pinnedMessages: StateFlow<List<ImMessage>> = _pinnedMessages.asStateFlow()

    private val _pending = MutableStateFlow(pendingCache.pending(cacheScopeId, conversationId))
    public val pending: StateFlow<List<ImPendingMessage>> = _pending.asStateFlow()

    private val _isLoadingHistory = MutableStateFlow(false)
    public val isLoadingHistory: StateFlow<Boolean> = _isLoadingHistory.asStateFlow()

    private val _hasMoreHistory = MutableStateFlow(true)
    public val hasMoreHistory: StateFlow<Boolean> = _hasMoreHistory.asStateFlow()

    private val _historyError = MutableStateFlow<String?>(null)
    public val historyError: StateFlow<String?> = _historyError.asStateFlow()

    private val _typingUserIds = MutableStateFlow<Set<String>>(emptySet())
    public val typingUserIds: StateFlow<Set<String>> = _typingUserIds.asStateFlow()

    private val _handoffVersions = MutableStateFlow<Map<String, Int>>(emptyMap())
    public val handoffVersions: StateFlow<Map<String, Int>> = _handoffVersions.asStateFlow()
    private val _sessionShareVersions = MutableStateFlow<Map<String, Int>>(emptyMap())
    public val sessionShareVersions: StateFlow<Map<String, Int>> = _sessionShareVersions.asStateFlow()
    private val _conversationRevision = MutableStateFlow(0)
    public val conversationRevision: StateFlow<Int> = _conversationRevision.asStateFlow()

    /** 是否存在传输中的消息；仅用于观测，不再阻止用户继续提交下一条。 */
    private val _isSending = MutableStateFlow(false)
    public val isSending: StateFlow<Boolean> = _isSending.asStateFlow()
    private var activeSendAttemptCount = 0

    /** 传输按用户提交顺序串行；pending 本身在等待传输时已经各自可见。 */
    private val sendMutex = Mutex()

    /** 当前登录用户 id：reaction 归属、typing 过滤、DM 已读判定用；由会话屏注入。 */
    public var currentUserId: String? = null

    /** 每个发送请求独立持有 upload-stage 附件，包含从本地失败历史恢复的待重试附件。 */
    private val trackedUploadStageAttachments: MutableMap<String, ImOutgoingAttachment> =
        _pending.value.mapNotNull { message ->
            message.attachment?.let { message.clientRequestId to it }
        }.toMap().toMutableMap()
    /** 上一页面/进程取消时仍在途的请求；先等历史按 request id 对账，再决定是否显示失败。 */
    private val restoredSendingRequestIds: MutableSet<String> = _pending.value
        .filter { it.status == ImPendingMessage.Status.SENDING }
        .mapTo(mutableSetOf()) { it.clientRequestId }

    /**
     * 明确丢弃本地 pending（清空历史）时调用。普通离开会话不能释放，否则恢复后的附件消息
     * 虽仍显示失败态，却已经失去可重试的 upload-stage 所有权。
     */
    public fun releaseAbandonedPendingAttachments() {
        trackedUploadStageAttachments.keys.toList().forEach(::releaseTrackedUploadStageAttachment)
    }

    /** userId → 其已读到的最大 seq（`im.read.receipt` 累积），DM 已读勾用。 */
    private val readSeqByUser: MutableMap<String, Int> = mutableMapOf()
    private val typingExpiry: MutableMap<String, Job> = mutableMapOf()
    private var postSendReceiptReconcileJob: Job? = null
    private var lastMarkedReadId = 0
    /** 每次清空或发起新的历史加载都会推进，过期响应不得再写入会话状态。 */
    private var historyGeneration = 0
    /** 个人历史清空代次：在途发送跨过清空时，POST 回包不得绕过服务端可见性过滤写回本地。 */
    private var historyClearGeneration = 0
    /** 服务端确认的个人历史清空水位；共享实时通道的迟到旧事件不得跨过此栅栏。 */
    private var historyClearedSeq = 0
    /** message_ref → 已应用的最大流式序号；最终消息仍由历史接口持久化。 */
    private val agentStreamSequenceByRef: MutableMap<String, Int> = mutableMapOf()
    /** final/error 后阻止重连窗口中的迟到增量复活临时态。 */
    private val closedAgentMessageRefs: MutableSet<String> = mutableSetOf()
    /** 权威完整置顶列表返回后，迟到的 Room 快照不得再覆盖它。 */
    private var hasCompletedPinnedRefresh = false
    /** 订阅确认落在首屏历史请求中时，待请求收尾后必须再补一次最新页。 */
    private var latestReconcilePending = false
    /** 清空历史或发起更新刷新后，旧置顶请求不得再把清空前快照写回。 */
    private var pinnedRefreshGeneration = 0

    /** 冷启动从 Room 恢复消息快照；权威历史已经落地后不再用旧缓存覆盖。 */
    public fun hydrateSnapshotIfNeeded(cachedMessages: List<ImMessage>) {
        if (cachedMessages.isEmpty() || _messages.value.isNotEmpty() || _isLoadingHistory.value) return
        mergeConfirmed(cachedMessages)
    }

    /** 冷启动恢复完整置顶快照；不依赖最近 100 条普通消息是否包含这些旧置顶。 */
    public fun hydratePinnedSnapshotIfNeeded(cachedMessages: List<ImMessage>) {
        if (cachedMessages.isEmpty() || _pinnedMessages.value.isNotEmpty() || hasCompletedPinnedRefresh) return
        updatePinnedMessages(
            cachedMessages
                .filter { it.conversationId == conversationId && !it.isDeleted }
                .map { it.copy(isPinned = true, pinStateKnown = true) }
                .sortedByDescending { it.seq },
        )
    }

    /** 冷启动恢复已读水位，与当前进程收到的回执取 max。 */
    public fun hydrateReadState(cachedWaterlines: Map<String, Int>) {
        cachedWaterlines.forEach { (readerId, seq) ->
            if (seq > (readSeqByUser[readerId] ?: 0)) readSeqByUser[readerId] = seq
        }
        materializeReadProgress()
    }

    // MARK: - 历史加载

    public fun loadInitial() {
        // 会话已订阅共享 realtime；首屏 REST 快照返回前抵达的新消息必须保留。
        scope.launch { loadHistory(reset = true, preservingCurrentMessages = true, showLoading = true) }
        scope.launch { refreshPinnedMessages() }
    }

    public fun loadMore() {
        scope.launch { loadHistory(reset = false) }
    }

    /** 服务端清空个人历史成功后的本地同步。 */
    public fun clearLocalHistory(clearedThroughSeq: Int) {
        historyGeneration++
        historyClearGeneration++
        pinnedRefreshGeneration++
        historyClearedSeq = maxOf(historyClearedSeq, clearedThroughSeq)
        updateMessages(emptyList())
        hasCompletedPinnedRefresh = true
        updatePinnedMessages(emptyList())
        readSeqByUser.clear()
        readStateCache?.clearReadState(cacheScopeId, conversationId)
        // 只有用户明确清空历史才丢弃失败和在途发送，并收敛附件 usage 所有权。
        releaseAbandonedPendingAttachments()
        _pending.value = emptyList()
        restoredSendingRequestIds.clear()
        pendingCache.clearPending(cacheScopeId, conversationId)
        _isLoadingHistory.value = false
        _hasMoreHistory.value = false
        _historyError.value = null
        latestReconcilePending = false
    }

    /** 清空个人历史后的专用重拉：保留期间抵达的 realtime，再由服务端个人可见性过滤收敛。 */
    public fun reloadHistoryAfterClear() {
        scope.launch { loadHistory(reset = true, preservingCurrentMessages = true, showLoading = true) }
    }

    public suspend fun loadHistory(reset: Boolean) {
        loadHistory(reset, preservingCurrentMessages = false, showLoading = true)
    }

    /**
     * 活跃会话里的 reaction/read/pin 事件偶尔会到下一次历史拉取才稳定可见。
     * 这里做最新页静默对账：不清屏、不打断输入、不显示 loading，只把权威状态合并回来。
     */
    public suspend fun reconcileLatestState() {
        if (_isLoadingHistory.value) {
            latestReconcilePending = true
        } else {
            latestReconcilePending = false
            loadHistory(
                reset = true,
                preservingCurrentMessages = true,
                showLoading = false,
                updatesHistoryAvailability = false,
            )
        }
        refreshPinnedMessages()
    }

    /** 完整置顶列表拉取失败时保留现有快照，避免网络抖动让顶部瞬间消失。 */
    public suspend fun refreshPinnedMessages() {
        val generation = ++pinnedRefreshGeneration
        try {
            val snapshot = transport.fetchPinnedMessages(conversationId)
            if (generation != pinnedRefreshGeneration) return
            hasCompletedPinnedRefresh = true
            applyPinnedSnapshot(snapshot)
        } catch (_: UnsupportedOperationException) {
            // 旧测试 transport 没有完整列表能力时，沿用当前页已知状态。
        } catch (error: Exception) {
            Log.w(TAG, "load pinned messages failed conv=$conversationId: ${error.message}")
        }
    }

    private suspend fun loadHistory(
        reset: Boolean,
        preservingCurrentMessages: Boolean,
        showLoading: Boolean,
        updatesHistoryAvailability: Boolean = true,
    ) {
        if (reset) {
            if (updatesHistoryAvailability) _hasMoreHistory.value = true
        } else if (!_hasMoreHistory.value || _isLoadingHistory.value) {
            return
        }
        val generation = ++historyGeneration
        val before: Int? = if (reset) null else _messages.value.firstOrNull()?.id
        if (showLoading) {
            _isLoadingHistory.value = true
            _historyError.value = null
        }
        try {
            val fetched = withTimeout(HISTORY_LOAD_TIMEOUT_MS) {
                transport.fetchMessages(conversationId, before, pageSize + 1)
            }
            if (generation != historyGeneration) return
            val orderedFetched = imChronologicallySortedMessages(fetched)
            val visiblePage = if (orderedFetched.size > pageSize) orderedFetched.takeLast(pageSize) else orderedFetched
            if (reset && !preservingCurrentMessages) updateMessages(emptyList())
            mergeConfirmed(visiblePage)
            if (reset) resolveRestoredSendingPending()
            if (updatesHistoryAvailability) {
                _hasMoreHistory.value = orderedFetched.size > pageSize
            }
            Log.i(TAG, "loaded ${visiblePage.size} messages conv=$conversationId more=${_hasMoreHistory.value}")
        } catch (e: Exception) {
            // withTimeout 代表本轮对账已经失败；页面/作用域取消则仍可能由下一次进入继续对账。
            if (e is CancellationException && e !is TimeoutCancellationException) throw e
            if (reset && generation == historyGeneration) resolveRestoredSendingPending()
            if (showLoading && generation == historyGeneration) {
                _historyError.value = e.message
                Log.e(TAG, "load history failed", e)
            } else {
                Log.w(TAG, "silent state reconcile failed conv=$conversationId: ${e.message}")
            }
        } finally {
            if (showLoading && generation == historyGeneration) {
                _isLoadingHistory.value = false
                if (latestReconcilePending) {
                    latestReconcilePending = false
                    scope.launch { reconcileLatestState() }
                }
            }
        }
    }

    // MARK: - 发送

    public fun send(
        content: String,
        messageType: Int = ImMessageType.TEXT,
        replyToId: Int? = null,
        mentionedUserIds: List<String> = emptyList(),
        mentionedAgentIds: List<String> = emptyList(),
        mentionAll: Boolean = false,
        attachment: ImOutgoingAttachment? = null,
        card: ImOutgoingCard? = null,
    ) {
        enqueueSend(
            content,
            messageType,
            replyToId,
            mentionedUserIds,
            mentionedAgentIds,
            mentionAll,
            attachment,
            card,
        )
    }

    /**
     * 面向 composer 的立即入队入口：同步校验并创建 pending，随后在 Store scope 中后台发送。
     * 调用方拿到 [ImSendOutcome.ENQUEUED] 即可清空输入，不需要等待网络结果。
     */
    public fun enqueueSend(
        content: String,
        messageType: Int = ImMessageType.TEXT,
        replyToId: Int? = null,
        mentionedUserIds: List<String> = emptyList(),
        mentionedAgentIds: List<String> = emptyList(),
        mentionAll: Boolean = false,
        attachment: ImOutgoingAttachment? = null,
        card: ImOutgoingCard? = null,
        clientRequestId: String = UUID.randomUUID().toString(),
        isRetry: Boolean = false,
    ): ImSendOutcome {
        val prepared = prepareSend(
            content = content,
            messageType = messageType,
            replyToId = replyToId,
            mentionedUserIds = mentionedUserIds,
            mentionedAgentIds = mentionedAgentIds,
            mentionAll = mentionAll,
            attachment = attachment,
            card = card,
            clientRequestId = clientRequestId,
            isRetry = isRetry,
        )
        if (prepared != null) return prepared
        val sendHistoryClearGeneration = historyClearGeneration
        beginSendAttempt()
        scope.launch {
            executePreparedSend(
                content = content,
                messageType = messageType,
                replyToId = replyToId,
                mentionedUserIds = mentionedUserIds,
                mentionedAgentIds = mentionedAgentIds,
                mentionAll = mentionAll,
                attachment = attachment,
                card = card,
                clientRequestId = clientRequestId,
                isRetry = isRetry,
                sendHistoryClearGeneration = sendHistoryClearGeneration,
            )
        }
        return ImSendOutcome.ENQUEUED
    }

    /**
     * 发送核心（可 await，供测试）。[clientRequestId] 为幂等键：首发生成新 UUID；
     * **重试必须复用原键**——否则「首请求已被服务端接受、客户端超时未收到响应」时，换新键重发
     * 会绕过后端幂等重复落一条。
     *
     * 不同首发各自拥有 pending，并按调用顺序进入传输；重试复用原键、原位复位为 sending。
     */
    public suspend fun performSend(
        content: String,
        messageType: Int = ImMessageType.TEXT,
        replyToId: Int? = null,
        mentionedUserIds: List<String> = emptyList(),
        mentionedAgentIds: List<String> = emptyList(),
        mentionAll: Boolean = false,
        attachment: ImOutgoingAttachment? = null,
        card: ImOutgoingCard? = null,
        clientRequestId: String = UUID.randomUUID().toString(),
        isRetry: Boolean = false,
    ): ImSendOutcome {
        val prepared = prepareSend(
            content = content,
            messageType = messageType,
            replyToId = replyToId,
            mentionedUserIds = mentionedUserIds,
            mentionedAgentIds = mentionedAgentIds,
            mentionAll = mentionAll,
            attachment = attachment,
            card = card,
            clientRequestId = clientRequestId,
            isRetry = isRetry,
        )
        if (prepared != null) return prepared
        val sendHistoryClearGeneration = historyClearGeneration
        beginSendAttempt()
        return executePreparedSend(
            content = content,
            messageType = messageType,
            replyToId = replyToId,
            mentionedUserIds = mentionedUserIds,
            mentionedAgentIds = mentionedAgentIds,
            mentionAll = mentionAll,
            attachment = attachment,
            card = card,
            clientRequestId = clientRequestId,
            isRetry = isRetry,
            sendHistoryClearGeneration = sendHistoryClearGeneration,
        )
    }

    private fun prepareSend(
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: List<String>,
        mentionedAgentIds: List<String>,
        mentionAll: Boolean,
        attachment: ImOutgoingAttachment?,
        card: ImOutgoingCard?,
        clientRequestId: String,
        isRetry: Boolean,
    ): ImSendOutcome? {
        if (!canSend()) return ImSendOutcome.REJECTED_READ_ONLY
        if (messageType == ImMessageType.TEXT && !isImMessageContentWithinLimit(content)) {
            return ImSendOutcome.REJECTED_TOO_LONG
        }
        if (isRetry && _pending.value.any {
                it.clientRequestId == clientRequestId && it.status == ImPendingMessage.Status.SENDING
            }
        ) {
            return ImSendOutcome.REJECTED_IN_FLIGHT
        }
        upsertPending(
            clientRequestId,
            content,
            messageType,
            replyToId,
            mentionedUserIds,
            mentionedAgentIds,
            mentionAll,
            attachment,
            card,
        )
        onMessageEnqueued?.invoke(outgoingPreview(content, messageType, attachment))
        if (!transport.isSendAvailable) {
            markPendingFailed(clientRequestId)
            return ImSendOutcome.FAILED_PENDING
        }
        return null
    }

    private fun outgoingPreview(
        content: String,
        messageType: Int,
        attachment: ImOutgoingAttachment?,
    ): String {
        val trimmed = content.trim()
        if (trimmed.isNotEmpty()) return trimmed
        if (messageType == ImMessageType.IMAGE) return "图片"
        if (messageType == ImMessageType.FILE || attachment != null) {
            val fileName = attachment?.fileName?.trim().orEmpty()
            return if (fileName.isEmpty()) "文件" else "文件：$fileName"
        }
        return "消息内容不可用"
    }

    private suspend fun executePreparedSend(
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: List<String>,
        mentionedAgentIds: List<String>,
        mentionAll: Boolean,
        attachment: ImOutgoingAttachment?,
        card: ImOutgoingCard?,
        clientRequestId: String,
        isRetry: Boolean,
        sendHistoryClearGeneration: Int,
    ): ImSendOutcome = try {
        val saved = sendMutex.withLock {
            withTimeout(SEND_TIMEOUT_MS) {
                transport.sendMessage(
                    conversationId,
                    content,
                    messageType,
                    replyToId,
                    mentionedUserIds,
                    mentionedAgentIds,
                    mentionAll,
                    attachment,
                    card,
                    clientRequestId,
                )
            }
        }
        check(saved.id > 0 && saved.seq > 0 && saved.conversationId == conversationId) {
            "IM transport did not return a stable server position"
        }
        val submittedAtEpochMs = _pending.value
            .firstOrNull { it.clientRequestId == clientRequestId }
            ?.createdAtEpochMs
        removePending(clientRequestId)
            if (sendHistoryClearGeneration != historyClearGeneration) {
                // 这条请求可能在清空水位之前已被服务端写入，不能相信本地 POST 回包。
                // 专用重拉按服务端个人可见性过滤，仅保留清空后的消息。
                loadHistory(reset = true, preservingCurrentMessages = true, showLoading = true)
                ImSendOutcome.DISCARDED_AFTER_CLEAR
            } else {
                releaseTrackedUploadStageAttachment(clientRequestId)
                // 传输层只回发送位置时，用本地已知字段补齐完整消息；实时回声随后覆盖。
                val local = ImMessage(
                    id = saved.id,
                    seq = saved.seq,
                    conversationId = conversationId,
                    senderId = currentUserId ?: "",
                    senderType = ImMemberType.USER,
                    content = content,
                    messageType = messageType,
                    replyToId = replyToId,
                    hasAttachment = attachment != null,
                    // 服务端时间精度不足时，本地提交毫秒可稳定区分同秒连续发送。
                    createdAt = submittedAtEpochMs?.let(java.time.Instant::ofEpochMilli)?.toString()
                        ?: saved.createdAt?.takeIf { it.isNotBlank() },
                    metadata = ImMessageMetadata(
                        clientRequestId = clientRequestId,
                        mentionedUserIds = mentionedUserIds.takeIf { it.isNotEmpty() },
                        mentionedAgentIds = mentionedAgentIds.takeIf { it.isNotEmpty() },
                        mentionAll = true.takeIf { mentionAll },
                        fileId = attachment?.fileId,
                        fileName = attachment?.fileName,
                        fileSize = attachment?.fileSize?.coerceAtMost(Int.MAX_VALUE.toLong())?.toInt(),
                        fileType = attachment?.fileType,
                        accessUrl = attachment?.remoteUrl,
                        cardPayload = card?.toMetadataPayload(),
                    ),
                )
                mergeConfirmed(listOf(local))
                onMessageConfirmed?.invoke(local)
                schedulePostSendReceiptReconcile()
                ImSendOutcome.CONFIRMED
            }
    } catch (_: ImConversationReadOnlyException) {
            removePending(clientRequestId)
            if (isRetry) {
                releaseTrackedUploadStageAttachment(clientRequestId)
            } else {
                // 首发被最终门禁拒绝时 composer 仍持有附件；只交还所有权，不撤销其 usage。
                trackedUploadStageAttachments.remove(clientRequestId)
            }
            ImSendOutcome.REJECTED_READ_ONLY
    } catch (error: TimeoutCancellationException) {
            if (sendHistoryClearGeneration != historyClearGeneration) {
                ImSendOutcome.DISCARDED_AFTER_CLEAR
            } else {
                markPendingFailed(clientRequestId)
                Log.e(TAG, "send timed out", error)
                ImSendOutcome.FAILED_PENDING
            }
    } catch (error: CancellationException) {
            throw error
    } catch (e: Exception) {
            if (sendHistoryClearGeneration != historyClearGeneration) {
                // 清空时已释放附件 usage；失败结果不得重新创建可重试 pending。
                ImSendOutcome.DISCARDED_AFTER_CLEAR
            } else {
                markPendingFailed(clientRequestId)
                Log.e(TAG, "send failed", e)
                ImSendOutcome.FAILED_PENDING
            }
    } finally {
        endSendAttempt()
    }

    public fun retry(pendingMessage: ImPendingMessage) {
        enqueueSend(
            content = pendingMessage.content,
            messageType = pendingMessage.messageType,
            replyToId = pendingMessage.replyToId,
            mentionedUserIds = pendingMessage.mentionedUserIds,
            mentionedAgentIds = pendingMessage.mentionedAgentIds,
            mentionAll = pendingMessage.mentionAll,
            attachment = pendingMessage.attachment,
            card = pendingMessage.card,
            clientRequestId = pendingMessage.clientRequestId,
            isRetry = true,
        )
    }

    private fun beginSendAttempt() {
        activeSendAttemptCount++
        _isSending.value = true
    }

    private fun endSendAttempt() {
        activeSendAttemptCount = (activeSendAttemptCount - 1).coerceAtLeast(0)
        _isSending.value = activeSendAttemptCount > 0
    }

    /**
     * read-receipt 实时事件偶尔晚于当前会话 UI，甚至只在下一次历史
     * 对账时才能稳定取到。发送后做一次短延迟 latest merge，让本人消息的已读扇形
     * 不必等用户退出再进会话；连续发送只保留最后一次对账。
     */
    private fun schedulePostSendReceiptReconcile() {
        postSendReceiptReconcileJob?.cancel()
        postSendReceiptReconcileJob = scope.launch {
            delay(1_600)
            reconcileLatestState()
        }
    }

    // MARK: - 编辑 / 撤回 / 表情

    /** 编辑消息（仅本人文本）：先乐观改本地，成功用服务端结果收敛，失败回滚。 */
    public suspend fun editMessage(messageId: Int, newContent: String): Boolean {
        val trimmed = newContent.trim()
        val index = _messages.value.indexOfFirst { it.id == messageId }
        if (trimmed.isEmpty() || index < 0) return false
        if (!isImMessageContentWithinLimit(trimmed)) return false
        val original = _messages.value[index]
        if (trimmed == original.content.trim()) return true
        replaceMessage(index, original.copy(content = trimmed, editedAt = nowIso()))
        return try {
            val updated = transport.editMessage(conversationId, messageId, trimmed)
            mergeConfirmed(listOf(updated))
            true
        } catch (e: Exception) {
            restoreMessage(messageId, original)
            Log.e(TAG, "edit failed", e)
            false
        }
    }

    /** 撤回消息：先乐观置撤回态，失败回滚。 */
    public suspend fun recallMessage(messageId: Int): Boolean {
        val index = _messages.value.indexOfFirst { it.id == messageId }
        if (index < 0) return false
        val original = _messages.value[index]
        val recalled = original.copy(isDeleted = true, content = "")
        replaceMessage(index, recalled)
        syncPinnedMessages(listOf(recalled))
        return try {
            transport.recallMessage(conversationId, messageId)
            true
        } catch (e: Exception) {
            restoreMessage(messageId, original)
            syncPinnedMessages(listOf(original))
            Log.e(TAG, "recall failed", e)
            false
        }
    }

    /** 切换表情回应：乐观增删本地，失败回滚；实时事件到达时幂等收敛。 */
    public fun toggleReaction(messageId: Int, emoji: String) {
        val message = _messages.value.firstOrNull { it.id == messageId }
        if (emoji.isEmpty() || message == null) return
        val userId = currentUserId?.takeIf { it.isNotEmpty() } ?: run {
            Log.e(TAG, "toggleReaction skipped: no currentUserId")
            return
        }
        val hasReacted = reactionUsers(messageId, emoji).contains(userId)
        if (!hasReacted && !canAddImReaction(emoji, message.reactions)) {
            Log.i(TAG, "reaction toggle skipped: reaction kind limit reached")
            return
        }
        applyReaction(messageId, userId, emoji, added = !hasReacted)
        scope.launch {
            try {
                if (hasReacted) {
                    transport.removeReaction(conversationId, messageId, emoji)
                } else {
                    transport.addReaction(conversationId, messageId, emoji)
                }
            } catch (e: Exception) {
                applyReaction(messageId, userId, emoji, added = hasReacted) // 回滚
                Log.e(TAG, "reaction toggle failed", e)
            }
        }
    }

    /** 置顶接口确认后就地更新当前消息流，避免等待下一次历史刷新。 */
    public fun setMessagePinned(messageId: Int, pinned: Boolean) {
        val index = _messages.value.indexOfFirst { it.id == messageId }
        if (index >= 0) {
            val updated = _messages.value[index].copy(isPinned = pinned, pinStateKnown = true)
            replaceMessage(index, updated)
            syncPinnedMessages(listOf(updated))
        } else if (!pinned) {
            updatePinnedMessages(_pinnedMessages.value.filterNot { it.id == messageId })
        }
    }

    /**
     * 置顶变更按幂等语义收敛：另一端已完成同一操作时，重复操作可能按错误返回。
     * 失败后静默拉取权威置顶列表；目标状态已经达成就视为成功，否则保留原错误。
     */
    public suspend fun pinMessage(messageId: Int, pinned: Boolean) {
        try {
            transport.pinMessage(conversationId, messageId, pinned)
            setMessagePinned(messageId, pinned)
        } catch (error: Exception) {
            reconcileLatestState()
            val isPinned = _pinnedMessages.value.any { it.id == messageId }
            if (isPinned == pinned) return
            throw error
        }
    }

    /** 清空水位覆盖普通历史和未加载到历史页的完整置顶快照。 */
    public suspend fun clearHistory() {
        val localClearedThroughSeq = (_messages.value + _pinnedMessages.value).maxOfOrNull { it.seq } ?: 0
        val serverClearedThroughSeq = transport.clearHistoryAndFetchWatermark(conversationId)
        clearLocalHistory(maxOf(localClearedThroughSeq, serverClearedThroughSeq))
    }

    private fun applyPinnedSnapshot(snapshot: List<ImMessage>) {
        val visible = snapshot
            .asSequence()
            .filter {
                it.conversationId == conversationId &&
                    !it.isDeleted &&
                    it.seq > historyClearedSeq
            }
            .map { it.copy(isPinned = true, pinStateKnown = true) }
            .distinctBy { it.id }
            .sortedByDescending { it.seq }
            .toList()
        val pinnedIds = visible.mapTo(mutableSetOf()) { it.id }
        if (_messages.value.isNotEmpty()) {
            updateMessages(
                _messages.value.map {
                    it.copy(isPinned = it.id in pinnedIds, pinStateKnown = true)
                },
            )
        }
        updatePinnedMessages(visible)
    }

    private fun syncPinnedMessages(incoming: List<ImMessage>) {
        val known = incoming.filter { it.pinStateKnown }
        if (known.isEmpty()) return
        val updated = _pinnedMessages.value.toMutableList()
        known.forEach { message ->
            updated.removeAll { messagesShareStableIdentity(it, message) }
            if (message.isPinned && !message.isDeleted) updated += message
        }
        updatePinnedMessages(updated.sortedByDescending { it.seq })
    }

    private fun updatePinnedMessages(messages: List<ImMessage>) {
        _pinnedMessages.value = messages
        pinnedSnapshotCache.storePinnedMessages(conversationId, messages)
    }

    // MARK: - 已读

    /** 标记已读到当前最新消息；对同一水位不重复上报。 */
    public fun markReadUpToLatest() {
        val latest = _messages.value.lastOrNull() ?: return
        if (latest.id <= lastMarkedReadId) return
        val previousMarked = lastMarkedReadId
        val target = latest.id
        lastMarkedReadId = target
        scope.launch {
            try {
                transport.markRead(conversationId, target)
                // 服务端水位已推进：再清一次列表角标，覆盖 enterConversation 后的 reload 竞态。
                onMarkReadConfirmed?.invoke(conversationId)
            } catch (e: Exception) {
                if (lastMarkedReadId == target) lastMarkedReadId = previousMarked // 允许下次重试
                Log.e(TAG, "mark read failed", e)
            }
        }
    }

    /**
     * DM 已读判定：仅本人发出的消息。两路证据取或——① 列表随消息下发的 `read_receipt` 聚合；
     * ② 打开会话后实时 `im.read.receipt` 累积的对端已读 seq。
     */
    public fun isReadByPeer(message: ImMessage): Boolean {
        if (message.senderId != currentUserId) return false
        val receipt = message.readReceipt
        if (receipt != null && receipt.readCount > 0) return true
        return message.seq > 0 && message.seq <= effectivePeerReadWaterline()
    }

    /**
     * 本人消息的已读聚合。历史页带的 readReceipt 与实时 read receipt 取并集，
     * 避免对端刚读完时 UI 要等下一轮历史刷新才显示。
     */
    public fun readProgress(message: ImMessage): ImReadReceipt? {
        if (message.senderId != currentUserId) return null
        val liveReadCount = readSeqByUser
            .filterKeys { it != currentUserId }
            .count { (_, lastReadSeq) -> message.seq > 0 && message.seq <= lastReadSeq }
        val receipt = message.readReceipt
        val readCount = maxOf(receipt?.readCount ?: 0, liveReadCount)
        val recipientCount = maxOf(receipt?.recipientCount ?: 0, readCount)
        if (readCount <= 0 && recipientCount <= 0) return null
        return ImReadReceipt(readCount = readCount, recipientCount = recipientCount)
    }

    public suspend fun fetchReadReceipts(message: ImMessage): ImMessageReadReceipts =
        transport.fetchReadReceipts(conversationId, message.id)

    // MARK: - 实时

    /** 消费 `chat:{conv}` 的原始 publication，分发到对应处理。非本会话/未识别的忽略。 */
    public fun applyRealtime(data: ByteArray) {
        val event = ImEventDecoder.decode(data) ?: return
        when (event) {
            is ImRealtimeEvent.Message -> ingestRealtimeMessage(event.message)
            is ImRealtimeEvent.MessageEdited ->
                if (event.message.conversationId == conversationId) mergeConfirmed(listOf(event.message))
            is ImRealtimeEvent.MessageDeleted -> applyDeletedLocal(event.messageId)
            is ImRealtimeEvent.MessagePinned -> {
                val pinned = event.message.copy(isPinned = true, pinStateKnown = true)
                mergeConfirmed(listOf(pinned))
                syncPinnedMessages(listOf(pinned))
            }
            is ImRealtimeEvent.MessageUnpinned -> {
                val index = _messages.value.indexOfFirst { it.id == event.messageId }
                if (index >= 0) {
                    replaceMessage(index, _messages.value[index].copy(isPinned = false, pinStateKnown = true))
                }
                updatePinnedMessages(_pinnedMessages.value.filterNot { it.id == event.messageId })
            }
            is ImRealtimeEvent.Reaction ->
                applyReaction(event.messageId, event.userId, event.emoji, event.added)
            is ImRealtimeEvent.ReadReceipt -> applyReadReceipt(event.payload)
            is ImRealtimeEvent.Typing -> applyTyping(event.userId)
            is ImRealtimeEvent.HandoffUpdate -> _handoffVersions.value =
                _handoffVersions.value + (event.handoffId to ((_handoffVersions.value[event.handoffId] ?: 0) + 1))
            is ImRealtimeEvent.SessionShareUpdate -> {
                ImCardStatusMemoryCache.invalidateSessionShare(event.shareId)
                _sessionShareVersions.value = _sessionShareVersions.value +
                    (event.shareId to ((_sessionShareVersions.value[event.shareId] ?: 0) + 1))
            }
            is ImRealtimeEvent.AgentMessageStream -> applyAgentMessageStream(event.payload)
            is ImRealtimeEvent.AgentMessageFinal -> applyAgentMessageFinal(event.payload)
            is ImRealtimeEvent.AgentMessageError -> applyAgentMessageError(event.payload)
            ImRealtimeEvent.ConversationChanged -> _conversationRevision.value += 1
            is ImRealtimeEvent.UnreadUpdate,
            is ImRealtimeEvent.ConversationNew,
            is ImRealtimeEvent.ConversationPreviewUpdated,
            is ImRealtimeEvent.ConversationLabelsUpdated,
            is ImRealtimeEvent.UserProfileUpdated,
            is ImRealtimeEvent.AiError,
            is ImRealtimeEvent.AiSuggestTask,
            is ImRealtimeEvent.Unknown,
            -> Unit
        }
    }

    private fun applyAgentMessageStream(payload: ImAgentMessageStreamEvent) {
        if (
            payload.conversationId != conversationId ||
            payload.messageRef.isBlank() ||
            payload.delta.isEmpty() ||
            payload.messageRef in closedAgentMessageRefs ||
            payload.streamSeq <= (agentStreamSequenceByRef[payload.messageRef] ?: 0)
        ) return

        val existing = _messages.value.firstOrNull { it.metadata?.messageRef == payload.messageRef }
        if (existing?.metadata?.kind == "agent_final") return
        agentStreamSequenceByRef[payload.messageRef] = payload.streamSeq
        val metadata = (existing?.metadata ?: ImMessageMetadata()).copy(
            messageRef = payload.messageRef,
            kind = "agent_stream",
            agentSessionRef = payload.agentSessionRef,
        )
        val projected = ImMessage(
            id = existing?.id ?: nextTransientMessageId(),
            seq = existing?.seq ?: 0,
            conversationId = conversationId,
            senderId = payload.senderId,
            senderType = ImMemberType.AGENT,
            senderName = payload.senderName,
            content = existing?.content.orEmpty() + payload.delta,
            messageType = ImMessageType.TEXT,
            metadata = metadata,
            createdAt = existing?.createdAt ?: payload.createdAt,
        )
        val messages = _messages.value.toMutableList()
        val index = messages.indexOfFirst { it.metadata?.messageRef == payload.messageRef }
        if (index >= 0) messages[index] = mergeConfirmedMessage(messages[index], projected) else messages += projected
        updateMessages(imChronologicallySortedMessages(messages))
    }

    private fun applyAgentMessageFinal(payload: ImAgentMessageFinalEvent) {
        if (payload.conversationId != conversationId || payload.messageRef.isBlank()) return
        closedAgentMessageRefs += payload.messageRef
        agentStreamSequenceByRef.remove(payload.messageRef)
        val existing = _messages.value.firstOrNull { it.metadata?.messageRef == payload.messageRef }
        val metadata = (payload.metadata ?: existing?.metadata ?: ImMessageMetadata()).copy(
            messageRef = payload.messageRef,
            kind = "agent_final",
            agentSessionRef = payload.agentSessionRef,
        )
        val projected = ImMessage(
            id = existing?.id ?: nextTransientMessageId(),
            seq = existing?.seq ?: 0,
            conversationId = conversationId,
            senderId = payload.senderId,
            senderType = ImMemberType.AGENT,
            senderName = payload.senderName,
            content = payload.content,
            messageType = payload.messageType,
            metadata = metadata,
            createdAt = payload.createdAt ?: existing?.createdAt,
        )
        val messages = _messages.value.toMutableList()
        val index = messages.indexOfFirst { it.metadata?.messageRef == payload.messageRef }
        if (index >= 0) messages[index] = mergeConfirmedMessage(messages[index], projected) else messages += projected
        updateMessages(imChronologicallySortedMessages(messages))
    }

    private fun applyAgentMessageError(payload: ImAgentMessageErrorEvent) {
        if (payload.conversationId != conversationId || payload.messageRef.isBlank()) return
        closedAgentMessageRefs += payload.messageRef
        agentStreamSequenceByRef.remove(payload.messageRef)
        updateMessages(_messages.value.filterNot {
            it.id <= 0 &&
                it.metadata?.messageRef == payload.messageRef &&
                it.metadata.kind == "agent_stream"
        })
    }

    private fun nextTransientMessageId(): Int {
        val minimum = _messages.value.asSequence().map { it.id }.filter { it < 0 }.minOrNull() ?: 0
        return if (minimum > Int.MIN_VALUE) minimum - 1 else Int.MIN_VALUE
    }

    /** 旧 Provider 兼容入口；自建链路应使用 [applyRealtime] 消费完整事件。 */
    public fun applyAuxiliaryRealtime(data: ByteArray) {
        when (val event = ImEventDecoder.decode(data)) {
            is ImRealtimeEvent.Typing -> applyTyping(event.userId)
            is ImRealtimeEvent.HandoffUpdate -> _handoffVersions.value =
                _handoffVersions.value + (event.handoffId to ((_handoffVersions.value[event.handoffId] ?: 0) + 1))
            else -> Unit
        }
    }

    /** 合并一条实时消息：先用 client_request_id 收敛乐观态，再按 id 去重插入。 */
    public fun ingestRealtimeMessage(msg: ImMessage) {
        if (msg.conversationId != conversationId) return
        if (msg.seq <= historyClearedSeq) {
            Log.d(TAG, "discarded cleared realtime message id=${msg.id}")
            return
        }
        msg.sessionShareCard?.let(ImCardStatusMemoryCache::putSessionShare)
        // `mergeConfirmed()` 先读取 pending 的毫秒级提交时间，再按 request id 收敛展示与附件。
        mergeConfirmed(listOf(resolveRealtimeReplyPreview(msg)))
    }

    /** 共享实时通道只下发安全占位；已在当前消息流里的原消息可安全补回预览。 */
    private fun resolveRealtimeReplyPreview(message: ImMessage): ImMessage {
        val merged = _messages.value.filterNot { it.id == message.id } + message
        return resolveLoadedReplyPreviews(merged).firstOrNull { it.id == message.id } ?: message
    }

    private fun applyDeletedLocal(messageId: Int) {
        val index = _messages.value.indexOfFirst { it.id == messageId }
        if (index < 0) return
        val deleted = _messages.value[index].copy(isDeleted = true, content = "")
        replaceMessage(index, deleted)
        syncPinnedMessages(listOf(deleted))
    }

    /** 表情增删的集合语义（本地乐观 + 实时回声共用；同一 userId 不重复、移除幂等）。 */
    private fun applyReaction(messageId: Int, userId: String, emoji: String, added: Boolean) {
        if (userId.isEmpty() || emoji.isEmpty()) return
        val index = _messages.value.indexOfFirst { it.id == messageId }
        if (index < 0) return
        val message = _messages.value[index]
        val users = (message.reactions[emoji] ?: emptyList()).toMutableList()
        if (added) {
            if (!users.contains(userId)) users.add(userId)
        } else {
            users.remove(userId)
        }
        val newReactions = message.reactions.toMutableMap()
        val reactionOrder = message.reactionOrder.toMutableList()
        if (users.isEmpty()) {
            newReactions.remove(emoji)
            reactionOrder.removeAll { it == emoji }
        } else {
            newReactions[emoji] = users
            if (emoji !in reactionOrder) reactionOrder += emoji
        }
        replaceMessage(index, message.copy(reactions = newReactions, reactionOrder = reactionOrder))
    }

    private fun reactionUsers(messageId: Int, emoji: String): List<String> =
        _messages.value.firstOrNull { it.id == messageId }?.reactions?.get(emoji) ?: emptyList()

    private fun applyReadReceipt(receipt: ImReadReceiptEvent) {
        if (receipt.conversationId != conversationId || receipt.userId.isEmpty()) return
        val previous = readSeqByUser[receipt.userId] ?: 0
        if (receipt.lastReadSeq > previous) {
            readSeqByUser[receipt.userId] = receipt.lastReadSeq
            readStateCache?.advanceReadWaterline(
                cacheScopeId,
                conversationId,
                receipt.userId,
                receipt.lastReadSeq,
            )
            materializeReadProgress()
        }
    }

    private fun effectivePeerReadWaterline(): Int {
        val userId = currentUserId ?: return 0
        val receiptWaterline = _messages.value
            .asSequence()
            .filter { it.senderId == userId && (it.readReceipt?.readCount ?: 0) > 0 }
            .maxOfOrNull { it.seq } ?: 0
        val liveWaterline = readSeqByUser.filterKeys { it != userId }.values.maxOrNull() ?: 0
        return maxOf(receiptWaterline, liveWaterline)
    }

    /**
     * 把实时水位投影回消息快照：既触发 Compose 重绘，也让下次冷启动直接带着最新 readReceipt。
     */
    private fun materializeReadProgress() {
        val userId = currentUserId ?: return
        val updated = _messages.value.map { message ->
            if (message.senderId != userId || message.seq <= 0) return@map message
            val liveReadCount = readSeqByUser
                .filterKeys { it != userId }
                .count { (_, lastReadSeq) -> message.seq <= lastReadSeq }
            val existing = message.readReceipt
            val readCount = maxOf(existing?.readCount ?: 0, liveReadCount)
            val recipientCount = maxOf(existing?.recipientCount ?: 0, readCount)
            if (readCount == (existing?.readCount ?: 0) && recipientCount == (existing?.recipientCount ?: 0)) {
                message
            } else {
                message.copy(readReceipt = ImReadReceipt(readCount, recipientCount))
            }
        }
        if (updated != _messages.value) updateMessages(updated)
    }

    /** typing：插入并 [TYPING_EXPIRE_MS] 后自动清除；排除本人。 */
    private fun applyTyping(userId: String) {
        if (userId.isEmpty() || userId == currentUserId) return
        _typingUserIds.value = _typingUserIds.value + userId
        typingExpiry[userId]?.cancel()
        typingExpiry[userId] = scope.launch {
            delay(TYPING_EXPIRE_MS)
            _typingUserIds.value = _typingUserIds.value - userId
            typingExpiry.remove(userId)
        }
    }

    // MARK: - 合并（稳定消息身份去重、按 seq 升序）

    /**
     * 把一批消息并入已确认列表。
     *
     * 服务端消息主键是确认态的稳定身份；乐观态由 `client_request_id` 与回包收敛。
     */
    private fun mergeConfirmed(incoming: List<ImMessage>) {
        val pendingCreatedAtByRequestId = _pending.value.associate {
            it.clientRequestId to it.createdAtEpochMs
        }
        val visibleIncoming = incoming
            .filter { it.seq > historyClearedSeq }
            .map { message ->
                val withPreciseSubmissionTime = message.metadata?.clientRequestId
                    ?.let(pendingCreatedAtByRequestId::get)
                    ?.let { submittedAt ->
                        message.copy(createdAt = java.time.Instant.ofEpochMilli(submittedAt).toString())
                    }
                    ?: message
                when {
                    withPreciseSubmissionTime.pinStateKnown -> withPreciseSubmissionTime
                    _pinnedMessages.value.any { messagesShareStableIdentity(it, withPreciseSubmissionTime) } ->
                        withPreciseSubmissionTime.copy(isPinned = true, pinStateKnown = true)
                    hasCompletedPinnedRefresh ->
                        withPreciseSubmissionTime.copy(isPinned = false, pinStateKnown = true)
                    else -> withPreciseSubmissionTime
                }
            }
        if (visibleIncoming.isEmpty()) return
        visibleIncoming
            .filter { it.id > 0 && it.isFromAgent && !it.metadata?.messageRef.isNullOrBlank() && !it.metadata.agentSessionRef.isNullOrBlank() }
            .forEach { message ->
                val messageRef = requireNotNull(message.metadata?.messageRef)
                closedAgentMessageRefs += messageRef
                agentStreamSequenceByRef.remove(messageRef)
            }
        visibleIncoming.mapNotNull { it.metadata?.clientRequestId }.distinct().forEach { requestId ->
            removePending(requestId)
            releaseTrackedUploadStageAttachment(requestId)
        }
        val merged = _messages.value.toMutableList()
        for (msg in visibleIncoming) {
            val index = merged.indexOfFirst { existing -> messagesShareStableIdentity(existing, msg) }
            if (index < 0) {
                merged += msg
            } else {
                merged[index] = mergeConfirmedMessage(merged[index], msg)
            }
        }
        updateMessages(resolveLoadedReplyPreviews(imChronologicallySortedMessages(merged)))
        syncPinnedMessages(visibleIncoming)
    }

    private fun messagesShareStableIdentity(left: ImMessage, right: ImMessage): Boolean {
        // Django Message 主键贯穿列表、编辑、撤回和 Compose row key；同一正数 id
        // 必须收敛，否则会把重复 key 送进 LazyColumn。
        if (left.id > 0 && right.id > 0 && left.id == right.id) return true

        // 业务卡状态投影可能生成新的消息行，但 message_ref 仍代表同一用户可见对象。
        val leftRef = left.metadata?.messageRef?.trim()?.takeIf { it.isNotEmpty() }
        val rightRef = right.metadata?.messageRef?.trim()?.takeIf { it.isNotEmpty() }
        if (leftRef != null && rightRef != null) return leftRef == rightRef

        val leftRequestId = left.metadata?.clientRequestId?.trim()?.takeIf { it.isNotEmpty() }
        val rightRequestId = right.metadata?.clientRequestId?.trim()?.takeIf { it.isNotEmpty() }
        if (leftRequestId != null && rightRequestId != null) return leftRequestId == rightRequestId

        return false
    }

    private fun mergeConfirmedMessage(existing: ImMessage, incoming: ImMessage): ImMessage =
        incoming.copy(
            createdAt = preciseLocalCreatedAt(existing, incoming),
            content = if (incoming.isDeleted || existing.isDeleted) "" else incoming.content,
            replyToPreview = incoming.replyToPreview ?: existing.replyToPreview,
            isDeleted = incoming.isDeleted || existing.isDeleted,
            isPinned = if (incoming.pinStateKnown) incoming.isPinned else incoming.isPinned || existing.isPinned,
            reactions = if (incoming.reactionStateKnown || incoming.reactions.isNotEmpty()) incoming.reactions else existing.reactions,
            reactionOrder = if (incoming.reactionStateKnown || incoming.reactions.isNotEmpty()) incoming.reactionOrder else existing.reactionOrder,
            reactionStateKnown = incoming.reactionStateKnown || existing.reactionStateKnown,
            readReceipt = mergeImReadReceipt(existing.readReceipt, incoming.readReceipt),
            pinStateKnown = incoming.pinStateKnown || existing.pinStateKnown,
        )

    private fun preciseLocalCreatedAt(existing: ImMessage, incoming: ImMessage): String? {
        val existingRequestId = existing.metadata?.clientRequestId?.trim()
        val incomingRequestId = incoming.metadata?.clientRequestId?.trim()
        return if (!existingRequestId.isNullOrEmpty() && existingRequestId == incomingRequestId) {
            existing.createdAt ?: incoming.createdAt
        } else {
            incoming.createdAt
        }
    }

    private fun resolveLoadedReplyPreviews(messages: List<ImMessage>): List<ImMessage> {
        val byId = messages.associateBy { it.id }
        return messages.map { message ->
            val replyToId = message.replyToId ?: return@map message
            val source = byId[replyToId] ?: return@map message
            if (source.isDeleted) {
                return@map message.copy(
                    replyToPreview = ImReplyPreview(
                        content = "消息内容不可用",
                        senderId = source.senderId,
                        isUnavailable = true,
                        messageType = source.messageType,
                        hasAttachment = source.hasAttachment,
                        fileName = source.attachmentFileName,
                    ),
                )
            }
            message.copy(
                replyToPreview = ImReplyPreview(
                    content = source.content.take(100),
                    senderId = source.senderId,
                    messageType = source.messageType,
                    hasAttachment = source.hasAttachment,
                    fileName = source.attachmentFileName,
                ),
            )
        }
    }

    /**
     * 订阅共享实时通道前读取个人清空水位。失败时调用方必须保持未订阅；REST 历史
     * 由服务端按用户过滤，仍可独立加载。
     */
    public suspend fun initializeHistoryVisibility(): Boolean {
        return try {
            initializeHistoryVisibility(transport.fetchHistoryClearedSeq(conversationId))
            true
        } catch (_: CancellationException) {
            false
        } catch (error: Exception) {
            _historyError.value = error.message
            Log.e(TAG, "load history visibility failed conv=$conversationId", error)
            false
        }
    }

    /** 写入权威水位，并同步移除水位前已从本地快照恢复的消息。 */
    public fun initializeHistoryVisibility(clearedThroughSeq: Int) {
        historyClearedSeq = maxOf(historyClearedSeq, clearedThroughSeq)
        updateMessages(_messages.value.filter { it.seq > historyClearedSeq })
        updatePinnedMessages(_pinnedMessages.value.filter { it.seq > historyClearedSeq })
    }

    private fun replaceMessage(index: Int, message: ImMessage) {
        val mutable = _messages.value.toMutableList()
        if (index in mutable.indices) {
            mutable[index] = message
            updateMessages(resolveLoadedReplyPreviews(mutable))
        }
    }

    private fun updateMessages(messages: List<ImMessage>) {
        _messages.value = messages
        val persistentMessages = messages.filter { it.id > 0 }
        if (persistentMessages.isEmpty()) {
            snapshotCache.clear(conversationId)
        } else {
            snapshotCache.store(conversationId, persistentMessages)
        }
    }

    private fun restoreMessage(messageId: Int, original: ImMessage) {
        val index = _messages.value.indexOfFirst { it.id == messageId }
        if (index >= 0) replaceMessage(index, original)
    }

    private fun upsertPending(
        clientRequestId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: List<String>,
        mentionedAgentIds: List<String>,
        mentionAll: Boolean,
        attachment: ImOutgoingAttachment?,
        card: ImOutgoingCard?,
    ) {
        restoredSendingRequestIds.remove(clientRequestId)
        if (attachment != null) trackedUploadStageAttachments[clientRequestId] = attachment
        val current = _pending.value
        val index = current.indexOfFirst { it.clientRequestId == clientRequestId }
        if (index >= 0) {
            val mutable = current.toMutableList()
            mutable[index] = mutable[index].copy(
                errorMessage = null,
                status = ImPendingMessage.Status.SENDING,
            )
            updatePending(mutable)
        } else {
            updatePending(current + ImPendingMessage(
                clientRequestId = clientRequestId,
                content = content,
                messageType = messageType,
                replyToId = replyToId,
                mentionedUserIds = mentionedUserIds,
                mentionedAgentIds = mentionedAgentIds,
                mentionAll = mentionAll,
                attachment = attachment,
                card = card,
                createdAtEpochMs = nowEpochMs(),
                errorMessage = null,
                status = ImPendingMessage.Status.SENDING,
            ))
        }
    }

    private fun removePending(clientRequestId: String) {
        restoredSendingRequestIds.remove(clientRequestId)
        updatePending(_pending.value.filterNot { it.clientRequestId == clientRequestId })
    }

    private fun resolveRestoredSendingPending() {
        if (restoredSendingRequestIds.isEmpty()) return
        val unresolved = restoredSendingRequestIds.toSet()
        updatePending(_pending.value.map { item ->
            if (item.clientRequestId in unresolved && item.status == ImPendingMessage.Status.SENDING) {
                item.copy(status = ImPendingMessage.Status.FAILED, errorMessage = null)
            } else {
                item
            }
        })
        restoredSendingRequestIds.clear()
    }

    /** 终态收敛 request-id 的附件 usage；`remove` 令各路径天然幂等。 */
    private fun releaseTrackedUploadStageAttachment(clientRequestId: String) {
        trackedUploadStageAttachments.remove(clientRequestId)?.let { attachment ->
            onReleaseAbandonedAttachment?.invoke(attachment)
        }
    }

    private fun markPendingFailed(clientRequestId: String) {
        val current = _pending.value
        val index = current.indexOfFirst { it.clientRequestId == clientRequestId }
        if (index < 0) return
        val mutable = current.toMutableList()
        mutable[index] = mutable[index].copy(
            errorMessage = null,
            status = ImPendingMessage.Status.FAILED,
        )
        updatePending(mutable)
    }

    private fun updatePending(value: List<ImPendingMessage>) {
        _pending.value = value
        pendingCache.storePending(cacheScopeId, conversationId, value)
    }

    private fun nowIso(): String =
        java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).toString()

    private companion object {
        private const val TAG = "ImMessageStore"
        private const val TYPING_EXPIRE_MS = 3500L
        private const val HISTORY_LOAD_TIMEOUT_MS = 15_000L
        private const val SEND_TIMEOUT_MS = 15_000L
    }
}

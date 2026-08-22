package com.tabtin.mobile.data.im

import android.util.Log
import androidx.annotation.StringRes
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.util.ErrorClassifier
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import javax.inject.Inject
import javax.inject.Singleton

/** 会话目录数据面；Store 只依赖产品语义，不感知具体消息传输实现。 */
public interface ImConversationDataPlane {
    public fun setConversationChangedListener(listener: (() -> Unit)?)
    public suspend fun listConversations(organizationId: String): List<ImConversation>
    public suspend fun searchMessages(organizationId: String, query: String): List<ImMessageSearchResult>
    public suspend fun pinConversation(conversationId: String, pinned: Boolean)
    public suspend fun setConversationMuted(conversationId: String, muted: Boolean)
    public suspend fun leaveConversation(conversationId: String)
    public suspend fun markConversationRemoved(conversationId: String)
    public suspend fun clearSession()
}

/**
 * TabChat IM 会话列表 store（Phase B），对齐 iOS `IMConversationStore.swift`。
 *
 * 只负责会话清单的加载与实时角标更新；单会话消息流在 [ImMessageStore] 承担。
 * 网络走统一 [ImApi]（同套 JWT / 401 刷新 / 信封解包）。作为 `@Singleton` 全局唯一，
 * 登出时由 `AuthRepository.logout()` 调 [clear] 清空。
 */
@Singleton
public class ImConversationStore @Inject constructor(
    private val dataPlane: ImConversationDataPlane,
    private val personalRealtimeSource: ImPersonalRealtimeSource = NoopImPersonalRealtimeSource,
) {
    public enum class PersonalNoticeKind { AI_ERROR, AI_SUGGEST_TASK }

    public data class PersonalNotice(
        val id: Long,
        val kind: PersonalNoticeKind,
        val agentName: String,
        val reason: String = "",
        val conversationId: String? = null,
        val messageId: Int? = null,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _conversations = MutableStateFlow<List<ImConversation>>(emptyList())
    public val conversations: StateFlow<List<ImConversation>> = _conversations.asStateFlow()

    /**
     * 当前 organization 的 IM 未读总数。只从会话列表派生，不维护第二份可漂移状态。
     * 负数按 0 处理；使用 Long 汇总后钳到 Int，避免异常服务端数据造成溢出。
     */
    public val aggregateUnreadCount: StateFlow<Int> = conversations
        .map { items ->
            items.fold(0L) { total, conversation ->
                total + conversation.unreadCount.coerceAtLeast(0).toLong()
            }.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        }
        .stateIn(scope, SharingStarted.Eagerly, 0)

    private val _isLoading = MutableStateFlow(false)
    public val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _loadErrorRes = MutableStateFlow<Int?>(null)
    public val loadErrorRes: StateFlow<Int?> = _loadErrorRes.asStateFlow()

    private val _searchResults = MutableStateFlow<List<ImMessageSearchResult>>(emptyList())
    public val searchResults: StateFlow<List<ImMessageSearchResult>> = _searchResults.asStateFlow()

    private val _isSearching = MutableStateFlow(false)
    public val isSearching: StateFlow<Boolean> = _isSearching.asStateFlow()

    private val _searchErrorRes = MutableStateFlow<Int?>(null)
    public val searchErrorRes: StateFlow<Int?> = _searchErrorRes.asStateFlow()

    private val _personalNotice = MutableStateFlow<PersonalNotice?>(null)
    public val personalNotice: StateFlow<PersonalNotice?> = _personalNotice.asStateFlow()
    private val _profileRevision = MutableStateFlow(0)
    /** 参与者资料变化版本；活动会话观察它重拉成员快照。 */
    public val profileRevision: StateFlow<Int> = _profileRevision.asStateFlow()
    private var personalNoticeSequence: Long = 0

    /** 正在写入置顶偏好的会话，用于禁用重复操作。 */
    private val _pinningConversationIds = MutableStateFlow<Set<String>>(emptySet())
    public val pinningConversationIds: StateFlow<Set<String>> = _pinningConversationIds.asStateFlow()

    /** 置顶写入失败的可展示提示；消费后调用 [dismissPinActionError]。 */
    private val _pinActionError = MutableStateFlow<String?>(null)
    public val pinActionError: StateFlow<String?> = _pinActionError.asStateFlow()

    /** 正在写入免打扰偏好的会话，用于禁用重复操作。 */
    private val _mutingConversationIds = MutableStateFlow<Set<String>>(emptySet())
    public val mutingConversationIds: StateFlow<Set<String>> = _mutingConversationIds.asStateFlow()

    /** 免打扰写入失败的可展示提示；消费后调用 [dismissMuteActionError]。 */
    private val _muteActionError = MutableStateFlow<String?>(null)
    public val muteActionError: StateFlow<String?> = _muteActionError.asStateFlow()

    private var loadJob: Job? = null
    private var loadGeneration: Int = 0
    private var searchGeneration: Int = 0
    private var organizationId: String? = null
    private var isListeningPersonal: Boolean = false

    /** 当前前台打开的会话 id：该会话上的 personal 未读增量应被忽略（详情页已在读）。 */
    private var activeConversationId: String? = null

    /**
     * 列表请求在途时，各会话「窗口内到达的新消息」累积：非 null 表示有 load 在飞、正在收集。
     * 结果落地按 baseline/delta 合并——只有 seq > 快照水位（快照未含）的窗口消息才计净增量，
     * 避免用陈旧本地绝对值覆盖权威快照、也不与快照已含的消息重复计数（见 [commitMerged]）。
     * preview 随最高 seq 保存：realtime 可乱序到达，只有更高 seq 的 preview 才代表更新的摘要。
     */
    private var loadWindow: MutableMap<String, WindowUnreadAccum>? = null

    /**
     * 加载窗口内某会话的未读累积：[seqs] 用于按快照水位算净增量；[preview]/[previewSeq]
     * 只保留窗口内见过的最高 seq 对应预览，避免乱序（先 seq=10 后 seq=9）把摘要退回旧消息。
     */
    private data class WindowUnreadAccum(
        val seqs: MutableSet<Int> = mutableSetOf(),
        val mentionSeqs: MutableSet<Int> = mutableSetOf(),
        var previewSeq: Int = -1,
        var preview: String = "",
        var lastMessageAt: String? = null,
    )

    /** 列表请求在途时经 `im.conversation.new` 新插入的会话 id：结果落地若快照尚未包含则整条保留。 */
    private var loadWindowInserted = mutableSetOf<String>()

    /**
     * 全局有界「近期已计入未读的 message_id」（message_id 为 Message 主键、全局唯一）：
     * Centrifugo 重连/重投同一消息时不再对已知或未知会话重复 +1；[recentAppliedOrder] 记录插入序做环形淘汰。
     */
    private val recentAppliedMessageIds = mutableSetOf<Int>()
    private val recentAppliedOrder = ArrayDeque<Int>()

    /**
     * 未知会话（尚未在列表）的未读缓冲：`im.unread.update` 可能早于 `im.conversation.new` 到达，
     * 先缓存增量，待会话插入时回放。org 切换 / 登出 / 已读回写清空。
     */
    private val bufferedUnread = mutableMapOf<String, BufferedUnread>()

    private data class BufferedUnread(
        // 已缓冲的未读条数（入口已按 message_id 全局去重，这里只需计数）。
        var count: Int = 0,
        // 缓冲的最新预览随最高 seq 保存：乱序到达时不把摘要退回旧消息。
        var previewSeq: Int = -1,
        var preview: String = "",
        var lastMessageAt: String? = null,
        // 缓冲窗口内是否至少有一条消息提到当前用户。
        var hasMention: Boolean = false,
    )

    private data class LatestPreviewOverride(
        val messageSeq: Int,
        val preview: String,
        val lastMessageAt: String? = null,
    )

    /**
     * 会话目录快照在撤回后可能短暂继续返回旧 lastMessage preview。这里仅记住“最后一条 seq
     * 已被撤回”的本地事实，直到更高 seq 的新消息到达，避免外层列表被陈旧快照打回旧文案。
     */
    private val latestPreviewOverrides = mutableMapOf<String, LatestPreviewOverride>()

    /** 拉取指定组织的会话列表（取消上一次未完成的加载）。 */
    public fun loadConversations(organizationId: String) {
        prepareOrganization(organizationId)
        if (organizationId.isBlank()) return
        startListeningPersonalIfNeeded()
        loadJob?.cancel()
        val generation = ++loadGeneration
        loadJob = scope.launch { performLoad(organizationId, generation) }
    }

    /** 供需要等待目录就绪的调用方同步刷新；返回本次权威快照是否成功落地。 */
    public suspend fun reload(organizationId: String): Boolean {
        prepareOrganization(organizationId)
        if (organizationId.isBlank()) return false
        startListeningPersonalIfNeeded()
        loadJob?.cancel()
        val generation = ++loadGeneration
        return performLoad(organizationId, generation)
    }

    private suspend fun performLoad(organizationId: String, generation: Int): Boolean {
        if (organizationId.isBlank() || this.organizationId != organizationId) return false
        _isLoading.value = true
        _loadErrorRes.value = null
        // 开始收集本次请求窗口内到达的 realtime 未读增量 / 新会话，供结果落地做 baseline/delta 合并。
        loadWindow = mutableMapOf()
        loadWindowInserted = mutableSetOf()
        try {
            val result = withTimeout(CONVERSATION_LOAD_TIMEOUT_MS) {
                dataPlane.listConversations(organizationId)
            }
            if (generation != loadGeneration || this.organizationId != organizationId) return false
            val window = loadWindow ?: mutableMapOf()
            val inserted = loadWindowInserted
            loadWindow = null
            loadWindowInserted = mutableSetOf()
            commitMerged(result, window, inserted)
            Log.i(TAG, "loaded ${result.size} IM conversations")
            return true
        } catch (e: TimeoutCancellationException) {
            if (generation == loadGeneration && this.organizationId == organizationId) {
                _loadErrorRes.value = R.string.error_network
            }
            Log.e(TAG, "load IM conversations timed out", e)
            return false
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (generation == loadGeneration && this.organizationId == organizationId) {
                _loadErrorRes.value = userFacingErrorRes(e)
            }
            Log.e(TAG, "load IM conversations failed", e)
            return false
        } finally {
            if (generation == loadGeneration && this.organizationId == organizationId) {
                _isLoading.value = false
                loadWindow = null
                loadWindowInserted = mutableSetOf()
            }
        }
    }

    /**
     * 搜索当前 Organization 的服务端历史正文。每次调用都会作废上一次结果；空白查询只清状态，
     * 不触发远端请求。Store 统一负责短防抖、组织边界和过期响应保护。
     */
    public suspend fun searchMessages(organizationId: String, query: String) {
        prepareOrganization(organizationId)
        val normalizedQuery = query.trim()
        val generation = ++searchGeneration
        _searchResults.value = emptyList()
        _searchErrorRes.value = null
        if (organizationId.isBlank() || normalizedQuery.isEmpty()) {
            _isSearching.value = false
            return
        }
        _isSearching.value = true
        try {
            // 先同步清掉上一条查询，再在 Store 内防抖；这样 UI 不会在防抖窗口展示旧结果或错误空态。
            delay(MESSAGE_SEARCH_DEBOUNCE_MS)
            if (generation != searchGeneration || this.organizationId != organizationId) return
            val results = dataPlane.searchMessages(organizationId, normalizedQuery)
            if (generation != searchGeneration || this.organizationId != organizationId) return
            _searchResults.value = results.filter { result ->
                result.conversation.directoryOrganizationId == organizationId
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (generation == searchGeneration && this.organizationId == organizationId) {
                _searchResults.value = emptyList()
                _searchErrorRes.value = userFacingErrorRes(e)
            }
            Log.e(TAG, "search IM messages failed", e)
        } finally {
            if (generation == searchGeneration && this.organizationId == organizationId) {
                _isSearching.value = false
            }
        }
    }

    @StringRes
    private fun userFacingErrorRes(error: Exception): Int = ErrorClassifier.classify(error)

    /**
     * 落地一次列表加载结果，按 baseline/delta 合并（权威快照 + 仅窗口净增量）：
     * - 快照会话：unread = 快照 unread + 加载窗口内 seq > 快照水位 的新消息数。
     *   只取「快照未含」的窗口消息，既不被陈旧本地绝对值覆盖（修非零陈旧基线），也不与快照
     *   已含的消息重复计数（修 snapshot-includes-publication）。用同一致快照下发的 lastMessageSeq 作水位。
     * - 未被触碰的会话：直接用权威快照值。
     * - 加载期间新插入、快照尚未包含的会话：整条保留，避免刚建的 DM 被覆盖丢失。
     */
    private fun commitMerged(
        result: List<ImConversation>,
        window: Map<String, WindowUnreadAccum>,
        inserted: Set<String>,
    ) {
        val snapshotIds = mutableSetOf<String>()
        val merged = mutableListOf<ImConversation>()
        for (snapshot in result) {
            snapshotIds.add(snapshot.id)
            val acc = window[snapshot.id]
            var conversation = if (acc != null && acc.seqs.isNotEmpty()) {
                val waterline = snapshot.lastMessageSeq
                val newCount = acc.seqs.count { it > waterline }
                snapshot.copy(
                    unreadCount = if (newCount > 0 && snapshot.unreadCount < Int.MAX_VALUE) {
                        if (snapshot.unreadCount > Int.MAX_VALUE - newCount) Int.MAX_VALUE else snapshot.unreadCount + newCount
                    } else {
                        snapshot.unreadCount
                    },
                    lastMessageSeq = maxOf(waterline, acc.seqs.maxOrNull() ?: waterline),
                    // 预览只在窗口内更高 seq（快照未含）时覆盖：既不被乱序旧消息退回，
                    // 也不用快照已含 seq 的窗口预览去覆盖同样权威的快照预览。
                    lastMessagePreview = if (acc.previewSeq > waterline && acc.preview.isNotEmpty()) {
                        acc.preview
                    } else {
                        snapshot.lastMessagePreview
                    },
                    lastMessageAt = if (acc.previewSeq > waterline && !acc.lastMessageAt.isNullOrBlank()) {
                        acc.lastMessageAt
                    } else {
                        snapshot.lastMessageAt
                    },
                    labels = if (acc.mentionSeqs.any { it > waterline }) {
                        listOf(ImConversationLabel.systemMention) +
                            snapshot.labels.filterNot { it.id == ImConversationLabel.systemMention.id }
                    } else {
                        snapshot.labels
                    },
                )
            } else {
                snapshot
            }
            conversation = applyLatestPreviewOverride(conversation)
            merged.add(conversation)
        }
        // 加载期间新插入、快照尚未包含的会话：保留，避免刚建的 DM 被覆盖丢失。
        for (local in _conversations.value) {
            if (inserted.contains(local.id) && !snapshotIds.contains(local.id)) merged.add(local)
        }
        _conversations.value = sortByRecency(merged)
        // 活动会话若在新列表里仍带未读（reload 与 markRead 竞态），保持清零语义。
        activeConversationId?.let { clearUnreadInternal(it) }
        // 已在权威列表中的会话不应再留缓冲（否则后续 conversation.new 不会来、缓冲永不消费）。
        bufferedUnread.keys.filter { snapshotIds.contains(it) }.forEach { bufferedUnread.remove(it) }
    }

    /**
     * 进入会话详情：登记活动会话 + **立刻清本地未读**（对齐 Electron 选中即清角标），
     * 服务端水位由详情页随后的 markRead 推进。
     */
    public fun enterConversation(conversationId: String) {
        activeConversationId = conversationId
        clearUnreadInternal(conversationId)
    }

    /** 退出会话详情：注销活动会话登记（不影响已清零的本地未读）。 */
    public fun leaveConversation(conversationId: String) {
        if (activeConversationId == conversationId) activeConversationId = null
    }

    /** 消费 personal 频道事件：同步未读、新会话、标签与 Agent 个人提示。 */
    public fun applyPersonalEvent(event: ImRealtimeEvent) {
        dispatchPersonalEvent(event)
    }

    private fun dispatchPersonalEvent(event: ImRealtimeEvent) {
        when (event) {
            is ImRealtimeEvent.UnreadUpdate -> applyUnreadUpdate(event.payload)
            is ImRealtimeEvent.ConversationNew -> applyConversationNew(event.conversation)
            is ImRealtimeEvent.ConversationPreviewUpdated -> {
                val update = event.payload
                val directoryOrganizationId = update.directoryScopeId ?: update.organizationId
                if (isEventForCurrentOrganization(directoryOrganizationId)) {
                    applyLatestPreviewUpdate(
                        conversationId = update.conversationId,
                        messageSeq = update.messageSeq,
                        preview = update.preview,
                        lastMessageAt = update.lastMessageAt,
                    )
                }
            }
            is ImRealtimeEvent.ConversationLabelsUpdated -> {
                val update = event.payload
                _conversations.value = _conversations.value.map { conversation ->
                    if (conversation.id == update.conversationId) conversation.copy(labels = update.labels)
                    else conversation
                }
            }
            is ImRealtimeEvent.UserProfileUpdated -> applyUserProfileUpdated(event.profile)
            is ImRealtimeEvent.AiError -> emitPersonalNotice(
                kind = PersonalNoticeKind.AI_ERROR,
                agentName = event.agentName,
                reason = event.reason,
            )
            is ImRealtimeEvent.AiSuggestTask -> emitPersonalNotice(
                kind = PersonalNoticeKind.AI_SUGGEST_TASK,
                agentName = event.agentName,
                conversationId = event.conversationId,
                messageId = event.messageId,
            )
            else -> Unit
        }
    }

    private fun applyUserProfileUpdated(profile: ImUserProfileUpdated) {
        if (profile.userId.isBlank()) return
        _conversations.value = _conversations.value.map { conversation ->
            if (
                conversation.type == ImConversationType.DM &&
                conversation.dmPeerUserId == profile.userId
            ) {
                conversation.copy(
                    name = profile.displayName.ifEmpty { conversation.name },
                    avatarUrl = profile.avatar,
                )
            } else {
                conversation
            }
        }
        _profileRevision.value += 1
    }

    private fun emitPersonalNotice(
        kind: PersonalNoticeKind,
        agentName: String,
        reason: String = "",
        conversationId: String? = null,
        messageId: Int? = null,
    ) {
        personalNoticeSequence += 1
        _personalNotice.value = PersonalNotice(
            id = personalNoticeSequence,
            kind = kind,
            agentName = agentName.trim(),
            reason = reason.trim(),
            conversationId = conversationId?.trim()?.takeIf { it.isNotEmpty() },
            messageId = messageId,
        )
    }

    public fun dismissPersonalNotice() {
        _personalNotice.value = null
    }

    /** 加载在途时登记一条窗口内新消息的 seq + 预览，供结果落地按水位算净增量 / 取最高 seq 预览。 */
    private fun noteWindowDelta(
        conversationId: String,
        seq: Int,
        preview: String,
        lastMessageAt: String?,
        mention: Boolean,
    ) {
        val acc = loadWindow?.getOrPut(conversationId) { WindowUnreadAccum() } ?: return
        acc.seqs.add(seq)
        if (mention) acc.mentionSeqs.add(seq)
        if (seq > acc.previewSeq && preview.isNotEmpty()) {
            acc.previewSeq = seq
            acc.preview = preview
            acc.lastMessageAt = lastMessageAt
        }
    }

    /** 加载在途时登记一条新插入的会话，供结果落地在快照未含时保留。 */
    private fun noteWindowInserted(conversationId: String) {
        if (loadWindow != null) loadWindowInserted.add(conversationId)
    }

    /** 加载在途时清掉某会话已积累的窗口增量（该会话被读 / 前台消费，窗口净增量应归零）。 */
    private fun clearWindowDelta(conversationId: String) {
        loadWindow?.put(conversationId, WindowUnreadAccum())
    }

    /**
     * 全局有界去重：首次见到该 message_id 返回 true 并登记；重投（重连/重发）返回 false。
     * message_id <= 0（理论上不应出现）不参与去重，直接放行避免误合并。
     */
    private fun markMessageAppliedIfNew(messageId: Int): Boolean {
        if (messageId <= 0) return true
        if (!recentAppliedMessageIds.add(messageId)) return false
        recentAppliedOrder.addLast(messageId)
        if (recentAppliedOrder.size > MAX_RECENT_APPLIED_MESSAGE_IDS) {
            val evicted = recentAppliedOrder.removeFirst()
            recentAppliedMessageIds.remove(evicted)
        }
        return true
    }

    /**
     * 新会话（如对端新建 DM）：不在列表则插入并按最近活动排序，令列表与「消息」聚合角标即时出现，
     * 无需等手动刷新。已存在则忽略（幂等；完整字段由下次 reload 校正）。
     */
    public fun applyConversationNew(conversation: ImConversation) {
        if (conversation.id.isEmpty()) return
        // 跨组织隔离：personal:{user} 频道跨组织共用，非当前组织的新会话不得插入当前列表。
        if (!isEventForCurrentOrganization(conversation.directoryOrganizationId)) return
        val current = _conversations.value
        if (current.any { it.id == conversation.id }) return
        // 回放先于本会话到达、被缓存的未读增量：im.unread.update 与 im.conversation.new 是两条
        // 独立 outbox 记录，投递顺序不保证；若未读先到会被缓存，此处补齐避免首条消息漏角标。
        val buffered = bufferedUnread.remove(conversation.id)
        val inserted = if (buffered != null) {
            // 补齐先于本会话到达、被缓存的未读条数：新建 DM 摘要 unread 为 0，直接累加，
            // 避免新 DM 首条消息漏角标。
            val addCount = buffered.count
            val withUnread = if (addCount > 0) {
                conversation.copy(
                    unreadCount = if (conversation.unreadCount > Int.MAX_VALUE - addCount) {
                        Int.MAX_VALUE
                    } else {
                        conversation.unreadCount + addCount
                    },
                )
            } else {
                conversation
            }
            withUnread.copy(
                lastMessagePreview = buffered.preview.ifEmpty { withUnread.lastMessagePreview },
                lastMessageAt = buffered.lastMessageAt?.takeIf { it.isNotBlank() }
                    ?: withUnread.lastMessageAt,
                // 随缓存预览一并推进水位：否则插入后到达的更旧 seq 消息会因 >= 覆盖回旧预览。
                lastMessageSeq = maxOf(withUnread.lastMessageSeq, buffered.previewSeq),
                labels = if (buffered.hasMention) {
                    listOf(ImConversationLabel.systemMention) +
                        withUnread.labels.filterNot { it.id == ImConversationLabel.systemMention.id }
                } else {
                    withUnread.labels
                },
            )
        } else {
            conversation
        }
        _conversations.value = sortByRecency(current + inserted)
        noteWindowInserted(conversation.id)
    }

    /**
     * 本端刚从幂等 DM 接口拿到会话 ID 时，先写一条最小目录快照。
     * personal realtime / 下次 reload 会补齐权威字段；在此之前再次点击同一人也能本地命中。
     */
    public fun rememberDirectMessage(
        conversationId: String,
        organizationId: String,
        otherUserId: String,
        displayName: String,
    ) {
        if (conversationId.isBlank() || organizationId.isBlank() || otherUserId.isBlank()) return
        applyConversationNew(
            ImConversation(
                id = conversationId,
                organizationId = organizationId,
                type = ImConversationType.DM,
                name = displayName,
                memberCount = 2,
                dmPeerUserId = otherUserId,
            ),
        )
    }

    /** 外部联系人私信的本地最小快照；目录刷新后由服务端补齐其余字段。 */
    public fun rememberExternalDirectMessage(
        conversationId: String,
        organizationId: String,
        peerUserId: String,
        displayName: String,
    ) {
        if (conversationId.isBlank() || organizationId.isBlank() || peerUserId.isBlank()) return
        applyConversationNew(
            ImConversation(
                id = conversationId,
                organizationId = organizationId,
                type = ImConversationType.DM,
                name = displayName,
                memberCount = 2,
                dmPeerUserId = peerUserId,
                isExternal = true,
            ),
        )
    }

    /**
     * personal 频道跨组织共用：事件带 `organization_id` 时仅当前组织的事件参与本地状态。
     * 组织未知（尚未加载）或事件未带组织（如 marked_read 已读回写）时放行，避免误伤既有链路。
     */
    private fun isEventForCurrentOrganization(eventOrganizationId: String): Boolean {
        val current = organizationId ?: return true
        if (eventOrganizationId.isEmpty()) return true
        return eventOrganizationId == current
    }

    /**
     * 缓存未知会话的一条新消息未读增量（累加计数、保留最新预览），待 [applyConversationNew] 回放。
     * 入口已做全局 message_id 去重，这里直接累加。
     */
    private fun bufferUnknownUnread(update: ImUnreadUpdate) {
        val entry = bufferedUnread.getOrPut(update.conversationId) { BufferedUnread() }
        entry.count += 1
        entry.hasMention = entry.hasMention || update.mention
        // 预览随最高 seq 保存：乱序缓冲（先 seq=10 后 seq=9）时不把摘要退回旧消息。
        if (update.messageSeq > entry.previewSeq && update.preview.isNotEmpty()) {
            entry.previewSeq = update.messageSeq
            entry.preview = update.preview
            entry.lastMessageAt = update.lastMessageAt
        }
    }

    /**
     * 应用一条未读更新（可同步测试）：已读回写 / 正在看该会话 → 清零；
     * 否则非活动会话未读 +1、预览前移。未在列表中的会话缓存待插入时回放。
     * 不做本地重排——顺序按服务端 `lastMessageAt` 由下次 reload 校正，避免错序。
     *
     * - 未读计数只做「已读回写清零」与「新消息 +1」两种确定增量，不按标量 seq 水位去重
     *   （标量水位无法与不透明 unread_count 对齐，也会丢乱序补发，详见 ）。
     * - 新消息 +1 前经全局有界 message_id 去重：Centrifugo 重连/重投同一消息不重复计数。
     */
    public fun applyUnreadUpdate(update: ImUnreadUpdate) {
        if (update.conversationId.isEmpty()) return
        latestPreviewOverrides[update.conversationId]?.let { override ->
            if (update.messageSeq > override.messageSeq) latestPreviewOverrides.remove(update.conversationId)
        }
        if (update.isMarkedReadEvent) {
            // 已读回写：清列表角标，并清掉该会话尚未插入时缓冲的未读——否则延迟到达的
            // im.conversation.new 会把已读消息回放成未读。窗口内已积累的净增量也清掉。
            bufferedUnread.remove(update.conversationId)
            clearWindowDelta(update.conversationId)
            clearUnreadInternal(update.conversationId)
            return
        }
        if (update.conversationId == activeConversationId) {
            // 前台已消费这条消息：登记 message_id，防离开/切后台后 Centrifugo 重投同一条时冒出伪未读。
            markMessageAppliedIfNew(update.messageId)
            // 正在看详情只代表不增加未读，不能丢掉目录摘要。否则用户返回消息列表时，
            // subtitle 仍停在进入会话前的旧消息。
            applyLatestPreviewUpdate(
                conversationId = update.conversationId,
                messageSeq = update.messageSeq,
                preview = update.preview,
                lastMessageAt = update.lastMessageAt,
            )
            clearWindowDelta(update.conversationId)
            clearUnreadInternal(update.conversationId)
            return
        }
        // 跨组织隔离：非当前组织的新消息未读不得计入当前列表 / 聚合角标。
        val directoryOrganizationId = _conversations.value
            .firstOrNull { it.id == update.conversationId }
            ?.directoryOrganizationId
            ?: update.directoryScopeId
            ?: update.organizationId
        if (!isEventForCurrentOrganization(directoryOrganizationId)) return
        // 全局去重：同一 message_id 的重复投递（重连/重发）不重复 +1。
        if (!markMessageAppliedIfNew(update.messageId)) return
        // 加载在途：登记窗口增量 seq + 预览，结果落地按水位判定净增量并取最高 seq 预览。
        noteWindowDelta(
            update.conversationId,
            update.messageSeq,
            update.preview,
            update.lastMessageAt,
            update.mention,
        )
        val current = _conversations.value
        val index = current.indexOfFirst { it.id == update.conversationId }
        if (index < 0) {
            // 会话尚未在列表：im.conversation.new 可能晚于 im.unread.update 到达（两者是独立
            // outbox 记录、投递顺序不保证）。缓存这条未读，待会话插入时回放，避免首条消息漏角标。
            bufferUnknownUnread(update)
            return
        }
        val existing = current[index]
        val mutable = current.toMutableList()
        // 预览只在不更旧的 seq 时覆盖：realtime 可乱序到达（先 seq=10 后 seq=9），
        // 摘要必须停在最高 seq 的消息，不被迟到的旧消息退回。seq 每条唯一，相等只可能是同一条
        // （已按 message_id 去重），故用 >= 兼容缺省 seq(0) 且不放过真正更旧的消息。同步推进本地水位。
        val takeNewerActivity = update.messageSeq >= existing.lastMessageSeq
        val takeNewerPreview = takeNewerActivity && update.preview.isNotEmpty()
        mutable[index] = existing.copy(
            unreadCount = if (existing.unreadCount == Int.MAX_VALUE) Int.MAX_VALUE else existing.unreadCount + 1,
            lastMessagePreview = if (takeNewerPreview) update.preview else existing.lastMessagePreview,
            lastMessageAt = if (takeNewerActivity && !update.lastMessageAt.isNullOrBlank()) {
                update.lastMessageAt
            } else {
                existing.lastMessageAt
            },
            lastMessageSeq = maxOf(existing.lastMessageSeq, update.messageSeq),
            labels = if (update.mention) {
                listOf(ImConversationLabel.systemMention) +
                    existing.labels.filterNot { it.id == ImConversationLabel.systemMention.id }
            } else {
                existing.labels
            },
        )
        _conversations.value = sortByRecency(mutable)
    }

    /** 把指定会话未读角标清零（本地即时反馈，服务端由 markRead 落账）。 */
    public fun clearUnread(conversationId: String) {
        clearUnreadInternal(conversationId)
    }

    /** 设置页写入免打扰成功后立即更新列表，避免用户看到陈旧的操作文案。 */
    public fun updateMuteState(conversationId: String, muted: Boolean) {
        if (conversationId.isBlank()) return
        _conversations.value = _conversations.value.map { conversation ->
            if (conversation.id == conversationId) conversation.copy(isMuted = muted) else conversation
        }
    }

    /**
     * 免打扰按显式 [muted] 写数据面，避免纯 toggle 竞态，成功后再刷本地列表态。
     * 运行时不再走 Django `POST .../mute`。
     */
    public suspend fun setMuted(conversationId: String, muted: Boolean) {
        if (conversationId.isBlank()) return
        dataPlane.setConversationMuted(conversationId, muted)
        updateMuteState(conversationId, muted)
    }

    /**
     * 从会话列表切换免打扰：乐观更新列表，失败只回滚当前会话，避免覆盖同期消息变化。
     */
    public suspend fun toggleMute(conversationId: String) {
        if (conversationId.isBlank() || conversationId in _mutingConversationIds.value) return
        val target = _conversations.value.firstOrNull { it.id == conversationId } ?: return
        val previousMuted = target.isMuted
        val nextMuted = !previousMuted
        _muteActionError.value = null
        _mutingConversationIds.value = _mutingConversationIds.value + conversationId
        updateMuteState(conversationId, nextMuted)
        try {
            dataPlane.setConversationMuted(conversationId, nextMuted)
            updateMuteState(conversationId, nextMuted)
        } catch (e: CancellationException) {
            updateMuteState(conversationId, previousMuted)
            throw e
        } catch (e: Exception) {
            updateMuteState(conversationId, previousMuted)
            _muteActionError.value = (e as? AppError.RequestFailed)?.serverMessage ?: e.message
            Log.e(TAG, "toggle IM conversation mute failed", e)
        } finally {
            _mutingConversationIds.value = _mutingConversationIds.value - conversationId
        }
    }

    public fun dismissMuteActionError() {
        _muteActionError.value = null
    }

    /** 设置页改名成功后立即更新列表标题，避免返回会话列表仍显示旧群名。 */
    public fun updateConversationName(conversationId: String, name: String) {
        if (conversationId.isBlank()) return
        _conversations.value = _conversations.value.map { conversation ->
            if (conversation.id == conversationId) conversation.copy(name = name) else conversation
        }
    }

    /** 群头像保存成功后立即更新会话列表，避免退出设置页后仍看到旧头像。 */
    public fun updateConversationAvatar(conversationId: String, avatarUrl: String) {
        if (conversationId.isBlank()) return
        _conversations.value = _conversations.value.map { conversation ->
            if (conversation.id == conversationId) conversation.copy(avatarUrl = avatarUrl) else conversation
        }
    }

    /**
     * 同一条最后消息发生状态变化（例如撤回）时，只更新会话摘要，不增加未读。
     * 这类事件不是一条新消息；如果复用 [applyUnreadUpdate]，活动会话会直接 return，
     * 非活动会话又会误 +1，都会让外层消息列表与详情状态短暂不一致。
     */
    public fun applyLatestPreviewUpdate(
        conversationId: String,
        messageSeq: Int,
        preview: String,
        lastMessageAt: String? = null,
    ) {
        if (conversationId.isBlank() || preview.isBlank()) return
        val current = _conversations.value
        val index = current.indexOfFirst { it.id == conversationId }
        if (index < 0) {
            latestPreviewOverrides[conversationId] = LatestPreviewOverride(
                messageSeq = messageSeq,
                preview = preview,
                lastMessageAt = lastMessageAt,
            )
            return
        }
        val existing = current[index]
        if (messageSeq < existing.lastMessageSeq) return
        val mutable = current.toMutableList()
        mutable[index] = existing.copy(
            lastMessagePreview = preview,
            lastMessageAt = lastMessageAt?.takeIf { it.isNotBlank() } ?: existing.lastMessageAt,
            lastMessageSeq = maxOf(existing.lastMessageSeq, messageSeq),
        )
        _conversations.value = sortByRecency(mutable)
        latestPreviewOverrides[conversationId] = LatestPreviewOverride(
            messageSeq = messageSeq,
            preview = preview,
            lastMessageAt = lastMessageAt,
        )
    }

    private fun applyLatestPreviewOverride(conversation: ImConversation): ImConversation {
        val override = latestPreviewOverrides[conversation.id] ?: return conversation
        if (conversation.lastMessageSeq > override.messageSeq) {
            latestPreviewOverrides.remove(conversation.id)
            return conversation
        }
        return conversation.copy(
            lastMessagePreview = override.preview,
            lastMessageAt = override.lastMessageAt?.takeIf { it.isNotBlank() }
                ?: conversation.lastMessageAt,
            lastMessageSeq = maxOf(conversation.lastMessageSeq, override.messageSeq),
        )
    }

    /** 已退出的群聊立即从消息列表移除，并取消其前台阅读状态。 */
    public fun removeConversation(conversationId: String) {
        if (conversationId.isBlank()) return
        leaveConversation(conversationId)
        scope.launch { dataPlane.markConversationRemoved(conversationId) }
        _conversations.value = _conversations.value.filterNot { it.id == conversationId }
    }

    /**
     * 切换会话置顶：先乐观重排，失败则回滚 pinned 字段。
     * 置顶以 Django 会话偏好为 SSoT，数据面接收显式 bool，避免重复点击竞态。
     */
    public suspend fun togglePin(conversationId: String) {
        val target = _conversations.value.firstOrNull { it.id == conversationId } ?: return
        setPinned(conversationId, pinned = !target.pinned)
    }

    /** 会话置顶写入（显式 [pinned]，避免并发 toggle 竞态）。 */
    public suspend fun setPinned(conversationId: String, pinned: Boolean) {
        if (conversationId.isBlank() || conversationId in _pinningConversationIds.value) return
        val before = _conversations.value
        val target = before.firstOrNull { it.id == conversationId } ?: return
        val previousPinned = target.pinned
        if (previousPinned == pinned) return
        _pinActionError.value = null
        _pinningConversationIds.value = _pinningConversationIds.value + conversationId
        _conversations.value = sortByRecency(
            before.map { conversation ->
                if (conversation.id == conversationId) conversation.copy(pinned = pinned) else conversation
            },
        )
        try {
            dataPlane.pinConversation(conversationId, pinned)
            _conversations.value = sortByRecency(
                _conversations.value.map { conversation ->
                    if (conversation.id == conversationId) conversation.copy(pinned = pinned) else conversation
                },
            )
        } catch (e: CancellationException) {
            rollbackPin(conversationId, previousPinned)
            throw e
        } catch (e: Exception) {
            // 请求期间仍可能收到 realtime 未读/预览；只回滚 pinned 字段，不能把整份旧列表盖回去。
            rollbackPin(conversationId, previousPinned)
            _pinActionError.value = (e as? AppError.RequestFailed)?.serverMessage ?: e.message
            Log.e(TAG, "set IM conversation pin failed", e)
        } finally {
            _pinningConversationIds.value = _pinningConversationIds.value - conversationId
        }
    }

    public fun dismissPinActionError() {
        _pinActionError.value = null
    }

    private fun rollbackPin(conversationId: String, pinned: Boolean) {
        _conversations.value = sortByRecency(
            _conversations.value.map { conversation ->
                if (conversation.id == conversationId) conversation.copy(pinned = pinned) else conversation
            },
        )
    }

    private fun clearUnreadInternal(conversationId: String) {
        val current = _conversations.value
        val index = current.indexOfFirst { it.id == conversationId }
        if (index < 0) return
        val hasMention = current[index].labels.any { it.id == ImConversationLabel.systemMention.id }
        if (current[index].unreadCount == 0 && !hasMention) return
        val mutable = current.toMutableList()
        mutable[index] = current[index].copy(
            unreadCount = 0,
            labels = current[index].labels.filterNot { it.id == ImConversationLabel.systemMention.id },
        )
        _conversations.value = mutable
    }

    /** 登出 / 切组织时清空并使在途加载失效。 */
    public fun clear() {
        loadJob?.cancel()
        loadGeneration += 1
        searchGeneration += 1
        organizationId = null
        _conversations.value = emptyList()
        _loadErrorRes.value = null
        _searchResults.value = emptyList()
        _searchErrorRes.value = null
        _isSearching.value = false
        _isLoading.value = false
        activeConversationId = null
        bufferedUnread.clear()
        latestPreviewOverrides.clear()
        loadWindow = null
        loadWindowInserted = mutableSetOf()
        recentAppliedMessageIds.clear()
        recentAppliedOrder.clear()
        _pinningConversationIds.value = emptySet()
        _pinActionError.value = null
        _mutingConversationIds.value = emptySet()
        _muteActionError.value = null
        _personalNotice.value = null
        stopListeningPersonal()
        scope.launch { dataPlane.clearSession() }
    }

    private fun startListeningPersonalIfNeeded() {
        dataPlane.setConversationChangedListener {
            organizationId?.let(::loadConversations)
        }
        if (isListeningPersonal) return
        personalRealtimeSource.setPersonalPublicationListener { data ->
            scope.launch {
                ImEventDecoder.decode(data.toString(Charsets.UTF_8))?.let(::dispatchPersonalEvent)
            }
        }
        personalRealtimeSource.setConnectionAvailableListener {
            organizationId?.let(::loadConversations)
        }
        isListeningPersonal = true
    }

    private fun stopListeningPersonal() {
        isListeningPersonal = false
        personalRealtimeSource.setPersonalPublicationListener(null)
        personalRealtimeSource.setConnectionAvailableListener(null)
        dataPlane.setConversationChangedListener(null)
    }

    /** 切组织时先同步清空旧列表，再开始新请求，避免角标短暂残留。 */
    private fun prepareOrganization(nextOrganizationId: String) {
        val normalized = nextOrganizationId.takeIf { it.isNotBlank() }
        if (organizationId == normalized) return
        loadJob?.cancel()
        loadGeneration += 1
        searchGeneration += 1
        organizationId = normalized
        _conversations.value = emptyList()
        _loadErrorRes.value = null
        _searchResults.value = emptyList()
        _searchErrorRes.value = null
        _isSearching.value = false
        _isLoading.value = false
        activeConversationId = null
        bufferedUnread.clear()
        latestPreviewOverrides.clear()
        loadWindow = null
        loadWindowInserted = mutableSetOf()
        recentAppliedMessageIds.clear()
        recentAppliedOrder.clear()
        _pinningConversationIds.value = emptySet()
        _pinActionError.value = null
        _mutingConversationIds.value = emptySet()
        _muteActionError.value = null
        _personalNotice.value = null
    }

    private fun sortByRecency(list: List<ImConversation>): List<ImConversation> =
        list.sortedWith(
            compareByDescending<ImConversation> { it.pinned }
                .thenByDescending { it.sortValue }
                .thenBy { it.id },
        )

    /** 单测注入会话列表（不打网络）。 */
    @androidx.annotation.VisibleForTesting
    public fun replaceConversationsForTesting(items: List<ImConversation>) {
        _conversations.value = sortByRecency(items)
    }

    /** 单测：模拟 Organization 上下文切换，不触发真网络。 */
    @androidx.annotation.VisibleForTesting
    public fun prepareOrganizationForTesting(organizationId: String) {
        prepareOrganization(organizationId)
    }

    /** 单测：直接走 personal 监听启动路径（等同 [loadConversations] 里的接线）。 */
    @androidx.annotation.VisibleForTesting
    public fun startListeningPersonalForTesting() {
        startListeningPersonalIfNeeded()
    }

    /** 单测：开始一次「加载在途」窗口（等同 [performLoad] 请求发出、结果未回时开始收集窗口增量）。 */
    @androidx.annotation.VisibleForTesting
    public fun beginLoadWindowForTesting() {
        loadWindow = mutableMapOf()
        loadWindowInserted = mutableSetOf()
    }

    /** 单测：落地一次加载结果，走与 [performLoad] 相同的 baseline/delta 合并提交路径。 */
    @androidx.annotation.VisibleForTesting
    public fun commitLoadForTesting(result: List<ImConversation>) {
        val window = loadWindow ?: mutableMapOf()
        val inserted = loadWindowInserted
        loadWindow = null
        loadWindowInserted = mutableSetOf()
        commitMerged(result, window, inserted)
    }

    private companion object {
        private const val TAG = "ImConversationStore"

        /** 全局「近期已计入未读」message_id 环形上限：超过则淘汰最旧。仅用于抵御 realtime 重投去重。 */
        private const val MAX_RECENT_APPLIED_MESSAGE_IDS = 512
        private const val CONVERSATION_LOAD_TIMEOUT_MS = 15_000L
        private const val MESSAGE_SEARCH_DEBOUNCE_MS = 250L
    }
}

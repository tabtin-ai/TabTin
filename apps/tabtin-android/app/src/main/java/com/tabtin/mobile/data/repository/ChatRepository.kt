package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ChatApi
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.OrchestrationApi
import com.tabtin.mobile.data.api.PlanApi
import com.tabtin.mobile.data.local.MessageDao
import com.tabtin.mobile.data.local.MessageEntity
import com.tabtin.mobile.data.model.ActionLabel
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.CreateSessionRequest
import com.tabtin.mobile.data.model.ForkSessionRequest
import com.tabtin.mobile.data.model.MessageListResponse
import com.tabtin.mobile.data.model.PlanExitRequest
import com.tabtin.mobile.data.model.PlanExitResponse
import com.tabtin.mobile.data.model.PendingSessionReadAck
import com.tabtin.mobile.data.model.SessionReadAckRequest
import com.tabtin.mobile.data.model.SessionReadState
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.SwitchContextTierRequest
import com.tabtin.mobile.data.model.SwitchContextTierResponse
import com.tabtin.mobile.data.model.SwitchSessionModelRequest
import com.tabtin.mobile.data.model.SwitchSessionModelResponse
import com.tabtin.mobile.data.model.UpdateModelParamsRequest
import com.tabtin.mobile.data.model.UpdateModelParamsResponse
import com.tabtin.mobile.data.model.modelParamOverridesWriteForThinkingMode
import com.tabtin.mobile.data.model.resolvedAskChoiceFact
import com.tabtin.mobile.data.websocket.AckResult
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

public data class LoadMessagesResult(
    val messages: List<ChatMessage>,
    val hasMore: Boolean,
    /**
     * 同页侧载的子 Agent transcript 消息（`subagent_run_id` 非空）。
     * 主时间线 [messages] 已过滤它们；冷启动 rehydrate 用此恢复详情。
     */
    val subagentTranscriptMessages: List<ChatMessage> = emptyList(),
)

public data class OutgoingAroundReconciliation(
    val matchedUser: ChatMessage,
    val messages: List<ChatMessage>,
    val evidence: OutgoingHistoryEvidence,
)

@Singleton
public class ChatRepository @Inject constructor(
    private val chatApi: ChatApi,
    private val contextApi: ContextApi,
    private val orchestrationApi: OrchestrationApi,
    private val planApi: PlanApi,
    private val tokenManager: TokenManager,
    private val messageDao: MessageDao,
    private val webSocketService: WebSocketService,
    private val sessionRunStateStore: SessionRunStateStore,
    private val sessionReadStateStore: SessionReadStateStore,
) {
    public companion object {
        private const val MAX_CACHED_SESSIONS = 20
        private const val LATEST_PAGE_BEFORE_CURSOR = "00000000-0000-0000-0000-000000000000"
        private val TERMINAL_HITL_NAK_CODES = setOf(
            "pending_not_found",
            "invalid_response",
            "missing_pending_request",
            "request_expired",
            "expired",
            "cancelled",
        )
    }

    private val messageStore = ConcurrentHashMap<String, List<ChatMessage>>()
    private val hasMoreStore = ConcurrentHashMap<String, Boolean>()
    private val syncWatermarkStore = ConcurrentHashMap<String, String>()
    private val accessOrder = java.util.LinkedList<String>()

    /** 后端 `agent.user.title_updated` 推送，供侧边栏等全局刷新（不依赖当前 Stream）。 */
    private val _remoteSessionTitleUpdates =
        MutableSharedFlow<Pair<String, String>>(extraBufferCapacity = 8)
    public val remoteSessionTitleUpdates: SharedFlow<Pair<String, String>> =
        _remoteSessionTitleUpdates.asSharedFlow()

    /** 本地归档完成事件，让仍存活的任务列表立刻移除该会话。 */
    private val _archivedSessionIds = MutableSharedFlow<String>(extraBufferCapacity = 8)
    public val archivedSessionIds: SharedFlow<String> = _archivedSessionIds.asSharedFlow()

    public fun applyRemoteSessionTitle(sessionId: String, title: String) {
        if (sessionId.isBlank() || title.isBlank()) return
        _remoteSessionTitleUpdates.tryEmit(sessionId to title)
    }

    public suspend fun getSessions(space: Space): List<ChatSession> {
        return try {
            chatApi.getSessions(
                workspaceId = space.id.takeIf { space.isExecutionSpace },
                projectId = space.id.takeIf { space.isProject },
            ).unwrap().sessions.map(::mergeAuthoritativeRunState)
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.LOAD_SESSIONS, e.serverMessage)
        }
    }

    /**
     * 新建 Agent 会话。
     *
     * - `agent_id` 必填；优先显式指定，否则 Space.primaryAgentId，再回落组织 Agent 列表。
     * - 可执行 Space（type 为空或 workspace）必须带 `workspace_id = space.id`，
     *   否则建成 observer，发消息时报「未绑定 Workspace，不能执行工具」。
     * - Project 会话同时显式传 `project_id`；它只表达协作场，不能替代
     *   `workspace_id` 的执行现场语义。
     */
    public suspend fun createSession(
        space: Space,
        agentId: String? = null,
        projectId: String? = null,
        sessionId: String? = null,
        modelId: String? = null,
        runtimeConfiguration: ConversationRuntimeConfiguration? = null,
    ): ChatSession {
        val organizationId = tokenManager.organizationId ?: throw AppError.NoOrganization
        val resolvedAgentId = agentId?.takeIf { it.isNotBlank() }
            ?: space.primaryAgentId
            ?: contextApi.getAgents(space.organizationId).unwrap().agents.firstOrNull()?.id
            ?: throw AppError.ActionFailed(
                ActionLabel.CREATE_SESSION,
                "该 Space 暂无可用 Agent，无法新建对话",
            )
        // type 为空时按可执行 Space 兼容（旧响应常不带 type）；勿只用 type=="workspace"。
        val workspaceId = when {
            space.isExecutionSpace -> space.id
            else -> space.executionSpaceId?.takeIf { it.isNotBlank() }
        }
        return try {
            chatApi.createSession(
                CreateSessionRequest(
                    sessionId = sessionId?.trim()?.takeIf { it.isNotEmpty() },
                    agentId = resolvedAgentId,
                    workspaceId = workspaceId,
                    projectId = projectId ?: space.id.takeIf { space.isProject },
                    organizationId = organizationId,
                    modelId = modelId?.trim()?.takeIf { it.isNotEmpty() },
                    agentMode = runtimeConfiguration?.agentMode?.wireValue,
                    approvalMode = runtimeConfiguration?.approvalMode?.wireValue,
                ),
            ).unwrap().let(::mergeAuthoritativeRunState)
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.CREATE_SESSION, e.serverMessage)
        }
    }

    public suspend fun getSession(sessionId: String): ChatSession =
        chatApi.getSession(sessionId).unwrap().let(::mergeAuthoritativeRunState)

    /** 服务端确认后才切换会话的下一轮模型，不能仅改本地 Composer 状态。 */
    public suspend fun switchSessionModel(
        sessionId: String,
        modelId: String,
        contextTierId: String? = null,
    ): SwitchSessionModelResponse = chatApi.switchSessionModel(
        sessionId = sessionId,
        body = SwitchSessionModelRequest(
            modelId = modelId,
            contextTierId = contextTierId?.trim()?.takeIf { it.isNotEmpty() },
        ),
    ).unwrap()

    /** 切换上下文档位（不切换模型）；空档重置为默认。 */
    public suspend fun switchContextTier(
        sessionId: String,
        contextTierId: String?,
    ): SwitchContextTierResponse = chatApi.switchContextTier(
        sessionId = sessionId,
        body = SwitchContextTierRequest(
            contextTierId = contextTierId?.trim()?.takeIf { it.isNotEmpty() },
        ),
    ).unwrap()

    /**
     * 写入会话级思考强度意图（v2 `thinking_mode`；勿混用 SubAgent thinking_level）。
     *
     * 后端整表替换：须传入 [preserving]（当前 session / 本地已知 overrides）以保留
     * `performance_profile` 等非思考键。
     */
    public suspend fun updateModelParams(
        sessionId: String,
        thinkingMode: String,
        preserving: JsonObject? = null,
    ): UpdateModelParamsResponse = chatApi.updateModelParams(
        sessionId = sessionId,
        body = UpdateModelParamsRequest(
            modelParamOverrides = modelParamOverridesWriteForThinkingMode(
                thinkingMode = thinkingMode,
                preserving = preserving,
            ),
        ),
    ).unwrap()

    public suspend fun forkSession(sessionId: String, messageId: String? = null): ChatSession {
        return try {
            chatApi.forkSession(sessionId, ForkSessionRequest(messageId)).unwrap().let(::mergeAuthoritativeRunState)
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.FORK_SESSION, e.serverMessage)
        }
    }

    /**
     * HTTP 快照与用户级运行态增量共用同一单调事实层。旧后端没有 `run_state` 时保留
     * 原有 `has_active_task` 回退；有新事实时不得让较旧 HTTP 响应把终态复活。
     */
    private fun mergeAuthoritativeRunState(session: ChatSession): ChatSession {
        session.runState?.let { sessionRunStateStore.accept(session.id, it) }
        session.readState?.let { sessionReadStateStore.accept(session.id, it) }
        val latestRunState = sessionRunStateStore.latest(session.id)
        val latestReadState = sessionReadStateStore.latest(session.id)
        return session.copy(
            runState = latestRunState ?: session.runState,
            hasActiveTask = latestRunState?.isActive ?: session.hasActiveTask,
            lastRunFailed = latestRunState?.let { it.status == SessionRunStatus.FAILED } ?: session.lastRunFailed,
            readState = latestReadState ?: session.readState,
            hasUnreadReply = latestReadState?.hasUnreadReply ?: session.hasUnreadReply,
        )
    }

    /** 服务端确认已读后把返回快照回灌同一阅读事实层。 */
    public suspend fun acknowledgeSessionRead(ack: PendingSessionReadAck): SessionReadState? {
        val response = chatApi.acknowledgeSessionRead(
            sessionId = ack.sessionId,
            body = SessionReadAckRequest(
                throughRunId = ack.throughRunId,
                throughRevision = ack.throughRevision,
                mutationId = ack.mutationId,
            ),
        ).unwrap()
        response.readState?.let { sessionReadStateStore.accept(ack.sessionId, it) }
        return sessionReadStateStore.latest(ack.sessionId) ?: response.readState
    }

    public suspend fun exitPlan(planDocumentId: String, outcome: String = "approved"): PlanExitResponse {
        return try {
            planApi.exit(PlanExitRequest(planDocumentId = planDocumentId, outcome = outcome)).unwrap()
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.SUBMIT_PERMISSION, e.serverMessage)
        }
    }

    public suspend fun getMessages(
        sessionId: String,
        preferIncremental: Boolean = false,
        preserveCacheOnEmpty: Boolean = false,
        advanceWatermark: Boolean = true,
    ): LoadMessagesResult {
        val cached = messageStore[sessionId].orEmpty()
        val syncWatermark = syncWatermarkStore[sessionId]
        if (preferIncremental && cached.isNotEmpty() && !syncWatermark.isNullOrBlank()) {
            val incremental = tryLoadIncrementalMessages(sessionId, cached, syncWatermark)
            if (incremental != null) return incremental
        }

        val page = loadLatestMainTimelinePage(sessionId)
        if (advanceWatermark) {
            page.response.serverTimestamp?.takeIf { it.isNotBlank() }?.let { syncWatermarkStore[sessionId] = it }
        }
        if (page.messages.isNotEmpty() || page.response.messages.isNotEmpty() || !preserveCacheOnEmpty) {
            messageStore[sessionId] = page.messages
            hasMoreStore[sessionId] = page.response.hasMore
            replaceDbSnapshot(sessionId, page.messages)
        }
        touchAccess(sessionId)
        return LoadMessagesResult(
            messages = page.messages,
            hasMore = page.response.hasMore,
            subagentTranscriptMessages = page.subagentTranscriptMessages,
        )
    }

    private data class MainTimelinePage(
        val response: MessageListResponse,
        val messages: List<ChatMessage>,
        val subagentTranscriptMessages: List<ChatMessage>,
    )

    private suspend fun loadLatestMainTimelinePage(
        sessionId: String,
        limit: Int = 50,
    ): MainTimelinePage {
        var cursor = LATEST_PAGE_BEFORE_CURSOR
        val collectedSubagents = mutableListOf<ChatMessage>()
        while (true) {
            val response = try {
                chatApi.getMessages(
                    sessionId = sessionId,
                    limit = limit,
                    before = cursor,
                    expandArtifacts = true,
                    includeHitlFacts = true,
                ).unwrap()
            } catch (e: AppError.RequestFailed) {
                throw AppError.ActionFailed(ActionLabel.LOAD_MESSAGES, e.serverMessage)
            }
            collectedSubagents += response.messages.subagentTranscriptMessages()
            val messages = response.messages.mainTimelineMessages()
            if (messages.isNotEmpty() || !response.hasMore || response.messages.isEmpty()) {
                return MainTimelinePage(response, messages, collectedSubagents.dedupeById())
            }
            val nextCursor = response.oldestId
                ?.takeIf { it.isNotBlank() && it != cursor }
                ?: return MainTimelinePage(response, messages, collectedSubagents.dedupeById())
            cursor = nextCursor
        }
    }

    public suspend fun loadMoreMessages(sessionId: String, beforeId: String, limit: Int = 30): LoadMessagesResult {
        var cursor = beforeId
        val collectedSubagents = mutableListOf<ChatMessage>()
        while (true) {
            val response = try {
                chatApi.getMessages(
                    sessionId = sessionId,
                    limit = limit,
                    before = cursor,
                    expandArtifacts = true,
                    includeHitlFacts = true,
                ).unwrap()
            } catch (e: AppError.RequestFailed) {
                throw AppError.ActionFailed(ActionLabel.LOAD_MESSAGES, e.serverMessage)
            }
            collectedSubagents += response.messages.subagentTranscriptMessages()
            val messages = response.messages.mainTimelineMessages()
            if (messages.isNotEmpty()) {
                val existingIds = messageStore[sessionId]?.map { it.id }?.toSet() ?: emptySet()
                val deduped = messages.filter { it.id !in existingIds }
                messageStore.compute(sessionId) { _, existing -> deduped + (existing ?: emptyList()) }
                persistToDb(sessionId, deduped)
                hasMoreStore[sessionId] = response.hasMore
                return LoadMessagesResult(
                    messages = messages,
                    hasMore = response.hasMore,
                    subagentTranscriptMessages = collectedSubagents.dedupeById(),
                )
            }
            hasMoreStore[sessionId] = response.hasMore
            if (!response.hasMore || response.messages.isEmpty()) {
                return LoadMessagesResult(
                    messages = emptyList(),
                    hasMore = response.hasMore,
                    subagentTranscriptMessages = collectedSubagents.dedupeById(),
                )
            }
            val nextCursor = response.oldestId
                ?.takeIf { it.isNotBlank() && it != cursor }
                ?: return LoadMessagesResult(
                    messages = emptyList(),
                    hasMore = response.hasMore,
                    subagentTranscriptMessages = collectedSubagents.dedupeById(),
                )
            cursor = nextCursor
        }
    }

    /**
     * 外部消息锚点的有界上下文窗口。它不写 latest-page 内存/Room 缓存，避免一次旧消息
     * 跳转把正常离线首屏永久改成很早的历史页。
     */
    public suspend fun getMessagesAround(
        sessionId: String,
        messageId: String,
        limit: Int = 50,
    ): LoadMessagesResult {
        if (messageId.isBlank()) return LoadMessagesResult(emptyList(), false)
        val response = try {
            chatApi.getMessages(
                sessionId = sessionId,
                limit = limit,
                around = messageId,
                expandArtifacts = true,
                includeHitlFacts = true,
            ).unwrap()
        } catch (e: AppError.RequestFailed) {
            throw AppError.ActionFailed(ActionLabel.LOAD_MESSAGES, e.serverMessage)
        }
        return LoadMessagesResult(
            messages = response.messages.mainTimelineMessages(),
            hasMore = response.hasMore,
            subagentTranscriptMessages = response.messages.subagentTranscriptMessages(),
        )
    }

    private suspend fun tryLoadIncrementalMessages(
        sessionId: String,
        cached: List<ChatMessage>,
        updatedAfter: String,
    ): LoadMessagesResult? {
        val pageSize = 100
        val fresh = mutableListOf<ChatMessage>()
        val freshSubagents = mutableListOf<ChatMessage>()
        var offset = 0
        var syncWatermark: String? = null

        while (true) {
            val response = try {
                chatApi.getMessages(
                    sessionId = sessionId,
                    limit = pageSize,
                    offset = offset.takeIf { it > 0 },
                    updatedAfter = updatedAfter,
                    updatedBefore = syncWatermark,
                    expandArtifacts = true,
                    includeHitlFacts = true,
                ).unwrap()
            } catch (e: AppError.RequestFailed) {
                throw AppError.ActionFailed(ActionLabel.LOAD_MESSAGES, e.serverMessage)
            }

            if (syncWatermark == null) {
                syncWatermark = response.serverTimestamp
                // Old backends do not expose a stable sync watermark. Fall back
                // to the latest-page path so callers still get the legacy
                // reconciliation behavior instead of treating a partial delta
                // as a complete history snapshot.
                if (syncWatermark.isNullOrBlank()) return null
            }

            fresh += response.messages.mainTimelineMessages()
            freshSubagents += response.messages.subagentTranscriptMessages()
            if (!response.hasMore || response.messages.isEmpty()) break
            offset += response.messages.size
        }

        if (syncWatermark.isNotBlank()) syncWatermarkStore[sessionId] = syncWatermark
        val merged = mergeMessagesByIdentity(cached, fresh)
        messageStore[sessionId] = merged
        touchAccess(sessionId)
        if (fresh.isNotEmpty()) replaceDbSnapshot(sessionId, merged)
        return LoadMessagesResult(
            messages = merged,
            hasMore = hasMoreStore[sessionId] ?: true,
            subagentTranscriptMessages = freshSubagents.dedupeById(),
        )
    }

    public fun getCachedMessages(sessionId: String): List<ChatMessage>? = messageStore[sessionId]
    public fun hasMore(sessionId: String): Boolean = hasMoreStore[sessionId] ?: true

    /**
     * Bounded send reconciliation entry point. `around` accepts either the server message id
     * returned by ACK or the stable client_event_id. Unlike full-history replacement this merge
     * is safe while an optimistic assistant bubble is active.
     */
    public suspend fun reconcileMessageAround(
        sessionId: String,
        around: String,
        identities: Set<String>,
    ): OutgoingAroundReconciliation? {
        if (around.isBlank() || identities.isEmpty()) return null
        val response = chatApi.getMessages(
            sessionId = sessionId,
            limit = 20,
            around = around,
            expandArtifacts = true,
            includeHitlFacts = true,
        ).unwrap()
        val messages = response.messages.mainTimelineMessages()
        val matched = messages.firstOrNull { message ->
            message.isUser && message.identityKeys.any { it in identities }
        } ?: return null
        val merged = mergeMessagesByIdentity(messageStore[sessionId].orEmpty(), messages)
        messageStore[sessionId] = merged
        touchAccess(sessionId)
        persistToDb(sessionId, messages)
        return OutgoingAroundReconciliation(
            matchedUser = matched,
            messages = messages,
            evidence = outgoingHistoryEvidence(messages, identities),
        )
    }

    public suspend fun getDbCachedMessages(sessionId: String): List<ChatMessage>? = withContext(Dispatchers.IO) {
        try {
            val entities = messageDao.getMessages(sessionId)
            if (entities.isEmpty()) null else entities.map { it.toChatMessage() }.mainTimelineMessages()
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun persistToDb(sessionId: String, messages: List<ChatMessage>) = withContext(Dispatchers.IO) {
        try {
            val snapshot = messages.filter {
                !it.isStreaming
                    && it.planProposal == null
                    && it.modeSwitchProposal == null
                    && !it.isSubagentTranscript
                    && !it.isInternalContext
                    && !it.isAgentSwitchAudit
                    && !it.shouldHidePushNotification
            }
            if (snapshot.isEmpty()) return@withContext
            val entities = snapshot.map { MessageEntity.from(sessionId, it) }
            messageDao.insertAll(entities)
        } catch (_: Exception) {}
    }

    private suspend fun replaceDbSnapshot(sessionId: String, messages: List<ChatMessage>) = withContext(Dispatchers.IO) {
        try {
            val snapshot = messages.filter {
                !it.isStreaming
                    && it.planProposal == null
                    && it.modeSwitchProposal == null
                    && !it.isSubagentTranscript
                    && !it.isInternalContext
                    && !it.shouldHidePushNotification
            }
            messageDao.deleteBySession(sessionId)
            if (snapshot.isEmpty()) return@withContext
            val entities = snapshot.map { MessageEntity.from(sessionId, it) }
            messageDao.insertAll(entities)
        } catch (_: Exception) {}
    }

    private fun List<ChatMessage>.mainTimelineMessages(): List<ChatMessage> =
        filterNot {
            it.isSubagentTranscript
                || it.isInternalContext
                || it.isAgentSwitchAudit
                || it.shouldHidePushNotification
                || (
                    it.messageKind == "hitl_interaction" &&
                        it.resolvedAskChoiceFact == null
                    )
        }

    private fun List<ChatMessage>.subagentTranscriptMessages(): List<ChatMessage> =
        filter { it.isSubagentTranscript }

    private fun List<ChatMessage>.dedupeById(): List<ChatMessage> {
        if (size <= 1) return this
        val seen = mutableSetOf<String>()
        return filter { seen.add(it.id) }
    }

    private fun mergeMessagesByIdentity(
        existing: List<ChatMessage>,
        fresh: List<ChatMessage>,
    ): List<ChatMessage> = ChatMessageMerge.mergeByIdentity(existing, fresh)

    // Wave 1：HITL（AskUser / Approval）回执通过 WebSocket `localrt.user_response` 上行。
    // 与 Electron `submitApprovalDecisionsForSession` / iOS `UnifiedApprovalPanel.submitDecision`
    // 完全对齐：payload 包含 thread_id + request_id + response 任意 JSON 结构，
    // 由后端 LocalPermissionHandler / AskUser handler 解析。
    //
    // 已知限制（Wave 1 不修，记录处理时机）：
    //   F3 sendAndWaitAck Ok 路径未消费 message_id —— Fork/编辑对账场景才用得上，
    //      待 Wave 4（消息编辑 / Fork 增强）一起接。
    //   F4 StreamManager.globalTimeoutJob 在 ack 之前就启动，120s 预算包含
    //      connect/subscribe/ack 耗时，弱网偏紧 —— Wave 5（错误体验）同步调整。
    //   F5 StreamManager.firstEventJob 死代码（声明但从未赋值），少一层「首事件
    //      未到达」卡死保护 —— 与 F4 一起在 Wave 5 修。
    //   F6 sendAndWaitAck Disconnected 复用 WsTimeout 文案，错误分类不准 ——
    //      Wave 5 错误本地化（对齐 Electron ErrorClassCard）时统一处理。
    //   F7 Review threadId 主取自 envelope payload.thread_id，缺省回退到
    //      activeThreadId；极端情况下若服务端不带 thread_id 且 stream 已切换会
    //      错填 —— Wave 4 HITL 强化时与 hitlRequestId 一起补「来源校验」。

    /**
     * HITL 提交结果。与 iOS [AckResult] 4 case 对齐，但 UI 层只关心三种语义：
     *   - Success：面板关闭
     *   - AlreadyConsumed：面板关闭并提示
     *   - Failed：面板保留，展示错误，可重试
     */
    public sealed class HitlSubmitResult {
        public data object Success : HitlSubmitResult()
        public data class AlreadyConsumed(val message: String?) : HitlSubmitResult()
        public data class Failed(val errorCode: String?, val message: String?) : HitlSubmitResult()
    }

    /**
     * AskUser questions 模式提交单元。
     * 与 iOS [AskUserAnswerInput] 对齐：每个 question 携带 selected_options（选项 id 列表）
     * 与可选 free_text（自由文本回答）。**不要把自由文本塞进 selected_options**——
     * LLM 端 (`ask_question` 工具) 把 selected_options 解释为 option id 列表，
     * 自由文本必须独立字段，否则 LLM 会把自然语言当 id 解析。
     */
    public data class AskUserAnswerInput(
        val questionId: String,
        val selectedOptions: List<String>,
        val freeText: String? = null,
    )

    public suspend fun submitAskUserAnswer(
        sessionId: String,
        hitlRequestId: String,
        answers: List<AskUserAnswerInput>,
    ): HitlSubmitResult {
        // 协议形态（与 iOS ConversationScreen.handleAskUserSubmit 行 790-799 完全对齐）：
        // `{ answers: [{ question_id, selected_options: [...], free_text? }, ...] }`
        // free_text 在为空时不写入字段（LLM 端看 dict.has("free_text") 决定是否消费）。
        val response = buildJsonObject {
            put("answers", buildJsonArray {
                for (ans in answers) {
                    add(buildJsonObject {
                        put("question_id", ans.questionId)
                        put("selected_options", buildJsonArray {
                            ans.selectedOptions.forEach { add(JsonPrimitive(it)) }
                        })
                        ans.freeText?.takeIf { it.isNotEmpty() }?.let { put("free_text", it) }
                    })
                }
            })
        }
        return sendUserResponse(sessionId, hitlRequestId, response)
    }

    // W4 (2026-05-11): submitAskUserTextFallback / submitAskUserFields 已删除——
    // ask_form 形态合并到 questions[] 单形态。

    public suspend fun skipAskUser(sessionId: String, hitlRequestId: String): HitlSubmitResult {
        val response = buildJsonObject { put("skipped", true) }
        return sendUserResponse(sessionId, hitlRequestId, response)
    }

    public suspend fun submitAskFormAnswer(
        sessionId: String,
        hitlRequestId: String,
        fieldValues: JsonObject,
    ): HitlSubmitResult {
        val response = buildJsonObject {
            put("field_values", fieldValues)
        }
        return sendUserResponse(sessionId, hitlRequestId, response)
    }

    public suspend fun skipAskForm(
        sessionId: String,
        hitlRequestId: String,
    ): HitlSubmitResult {
        val response = buildJsonObject { put("skipped", true) }
        return sendUserResponse(sessionId, hitlRequestId, response)
    }

    public suspend fun submitRequestApproval(
        sessionId: String,
        hitlRequestId: String,
        approved: Boolean,
    ): HitlSubmitResult {
        val response = buildJsonObject { put("approved", approved) }
        return sendUserResponse(sessionId, hitlRequestId, response)
    }

    /**
     * v0.4 W1.5-轮 4：提交批量审批决策（PRD 05 §7.4 / §7.10，对齐 Electron
     * `submitApprovalDecisionsForSession`）。
     *
     * 协议（按 D6 一刀切）：
     * - 提交键 = [batchId]（v0.4 Redis SETNX 仲裁键；ask_user 走另一路径）
     * - response payload = 纯 `{ batch_id, decisions: [{tool_call_id, outcome, scope?, request_id?}, ...] }`
     * - **不带** `approved` 兼容字段（删除原 W1.5 上线后期拆除注释，本轮就拆）
     * - decisions 数组按 actionRequests 顺序构造；W1.5-轮 4 mobile 简化范围 ——
     *   "全允/全拒"语义，每条 decision.outcome 同
     *
     * outcome ∈ {'allow', 'deny'}（PRD §7.4 LocalRtUserResponseDecisionSchema）；
     * scope 仅 outcome='allow' 时有意义且 UI 没选时缺省 'once'；
     * "cancelled" 由 UI 本端 dismiss 处理（不上行）。
     */
    public suspend fun submitApprovalDecisionsForSession(
        threadId: String,
        batchId: String,
        decisions: List<ApprovalDecisionInput>,
    ): HitlSubmitResult {
        if (batchId.isBlank()) {
            return HitlSubmitResult.Failed("missing_batch_id", null)
        }
        if (decisions.isEmpty()) {
            return HitlSubmitResult.Failed("empty_decisions", null)
        }
        val decisionsArr = buildJsonArray {
            decisions.forEach { d ->
                add(
                    buildJsonObject {
                        put("tool_call_id", d.toolCallId)
                        put("outcome", d.outcome)
                        d.scope?.takeIf { it.isNotBlank() }?.let { put("scope", it) }
                        d.requestId?.takeIf { it.isNotBlank() }?.let { put("request_id", it) }
                        d.rejectionMessage?.takeIf { it.isNotBlank() }?.let { put("rejection_message", it) }
                        // M4.2 L-W6-30：always-allow 三字段（snake_case 与 wire 协议对齐）。
                        // 仅在 ViewModel 决定写 memo 时构造，平时为 null 不会出现在 JSON。
                        d.patternKey?.takeIf { it.isNotBlank() }?.let { put("pattern_key", it) }
                        d.scopeDescription?.takeIf { it.isNotBlank() }?.let { put("scope_description", it) }
                        d.decisionKind?.takeIf { it.isNotBlank() }?.let { put("decision_kind", it) }
                    }
                )
            }
        }
        val response = buildJsonObject {
            put("batch_id", batchId)
            put("decisions", decisionsArr)
        }
        return sendUserResponseRaw(threadId, batchId, response)
    }

    /**
     * 旧 Daemon action 审批弹窗回执：对应后端 `agent.action.approval_response`。
     * 与新版 `approval_requested` batch 的 localrt.user_response 分流，避免把
     * approval_id 误当 batch_id 发回 runtime。
     */
    public suspend fun submitActionApprovalResponse(
        threadId: String,
        approvalId: String,
        approved: Boolean,
        scope: String? = null,
    ): HitlSubmitResult {
        if (approvalId.isBlank()) {
            return HitlSubmitResult.Failed("missing_approval_id", null)
        }
        if (threadId.isBlank()) {
            return HitlSubmitResult.Failed("missing_thread_id", null)
        }
        val payload = buildJsonObject {
            put("approval_id", approvalId)
            put("approved", approved)
            scope?.takeIf { it.isNotBlank() }?.let { put("scope", it) }
            put("thread_id", threadId)
        }
        val ack = webSocketService.sendAndWaitAck(
            type = "agent.action.approval_response",
            payload = payload,
            okType = "agent.action.approval_response.ok",
            nakType = "agent.action.approval_response.nak",
            threadId = threadId,
            timeoutMs = 15_000L,
        )
        return mapAckToHitlResult(ack)
    }

    /**
     * v0.4 W1.5-轮 4：单条决策输入（mobile UI 内部数据）。
     * 字段与 wire `LocalRtUserResponseDecisionSchema` 对齐。
     *
     * M4.2 L-W6-30 扩展：always-allow 路径附带 `patternKey` / `scopeDescription` /
     * `decisionKind` 三字段，让 Django `approval_memo_service.upsert_entry` 真把人话
     * 标签写进 memo entry。`LocalRtUserResponseDecisionSchema` 的 `.passthrough()` +
     * Python 端 `extra="allow"` 让上行 wire 字段无需 schema 改动即可透传。
     */
    public data class ApprovalDecisionInput(
        val toolCallId: String,
        /** 'allow' | 'deny' */
        val outcome: String,
        val scope: String? = null,
        val requestId: String? = null,
        val rejectionMessage: String? = null,
        /** M4.2：scoped pattern_key，例 `execute_command::npm:workspace-internal` */
        val patternKey: String? = null,
        /** M4.2：人话标签（中文 hardcode），例 "执行 shell 命令 npm" */
        val scopeDescription: String? = null,
        /** M4.2：'pattern' / 'exact'；移动端只支持 scoped → 统一 'pattern' */
        val decisionKind: String? = null,
    )

    /**
     * Wave 4 I8：plan.exit 审批回执。
     *
     * 协议源：packages/agent-wire/src/plan-approval.ts PlanApprovalIpcResponsePayloadSchema。
     * 通道：WS `localrt.plan_approval_response`（不是 localrt.user_response），
     * 与 W7a Daemon `handleSubmitPlanApproval` 入口的 `PlanApprovalIpcResponsePayloadSchema.safeParse`
     * **严格 camelCase**（不接受 snake_case 兼容写法），与 Electron PlanApprovalDialog
     * 提交路径完全等价。
     *
     * thread_id：路由用，按 chat-session-{sessionId} 与 Daemon LocalRT 路由对齐
     * （参考 PlanApprovalDialog.test.tsx ：`expect(options).toMatchObject({ threadId: 'chat-session-...' })`）。
     */
    public suspend fun submitPlanApproval(
        sessionId: String,
        hitlRequestId: String,
        outcome: String,
        editedPlanMarkdown: String? = null,
        allowedPrompts: List<String>? = null,
    ): HitlSubmitResult {
        if (hitlRequestId.isBlank()) {
            return HitlSubmitResult.Failed("missing_request_id", null)
        }
        if (sessionId.isBlank()) {
            // Daemon zod 是 z.string().optional() 不带 min(1)，空串能过 schema 但
            // PlanApprovalCoordinator 找不到 session 实例会拒绝。把校验前移避免发空请求。
            return HitlSubmitResult.Failed("missing_session_id", null)
        }
        val threadId = "chat-session-$sessionId"
        val payload = buildJsonObject {
            put("requestId", hitlRequestId)
            put("sessionId", sessionId)
            put("outcome", outcome)
            editedPlanMarkdown?.let { put("editedPlanMarkdown", it) }
            allowedPrompts?.let {
                put("allowedPrompts", buildJsonArray { it.forEach { p -> add(JsonPrimitive(p)) } })
            }
        }
        val ack = webSocketService.sendAndWaitAck(
            type = "localrt.plan_approval_response",
            payload = payload,
            okType = "localrt.plan_approval_response.ok",
            nakType = "localrt.plan_approval_response.nak",
            threadId = threadId,
            timeoutMs = 15_000L,
        )
        return mapAckToHitlResult(ack)
    }

    /**
     * 把 [AckResult] 4 case 映射到 [HitlSubmitResult] 3 语义。
     * 抽出 helper 防止两条 HITL 提交链路（user_response / plan_approval_response）
     * 错误归一逻辑漂移——技术优雅度 Review 提议的合并点。
     */
    private fun mapAckToHitlResult(ack: AckResult): HitlSubmitResult = when (ack) {
        is AckResult.Ok -> HitlSubmitResult.Success
        is AckResult.Nak -> if (ack.errorCode == "already_consumed" || isTerminalHitlNak(ack)) {
            HitlSubmitResult.AlreadyConsumed(ack.errorMessage.ifEmpty { null })
        } else {
            HitlSubmitResult.Failed(
                ack.errorCode.ifBlank { "unknown_nak" },
                ack.errorMessage.ifEmpty { null },
            )
        }
        AckResult.Timeout -> HitlSubmitResult.Failed("timeout", null)
        AckResult.Disconnected -> HitlSubmitResult.Failed("disconnected", null)
    }

    private fun isTerminalHitlNak(ack: AckResult.Nak): Boolean {
        val code = ack.errorCode.lowercase()
        val message = ack.errorMessage.lowercase()
        if (!ack.retryable) return true
        return code in TERMINAL_HITL_NAK_CODES ||
            "no pending" in message ||
            "pending request not found" in message ||
            "missing pending request" in message
    }

    private suspend fun sendUserResponse(
        sessionId: String,
        hitlRequestId: String,
        response: JsonObject,
    ): HitlSubmitResult {
        val threadId = "chat-session-$sessionId"
        return sendUserResponseRaw(threadId, hitlRequestId, response)
    }

    private suspend fun sendUserResponseRaw(
        threadId: String,
        hitlRequestId: String,
        response: JsonObject,
    ): HitlSubmitResult {
        if (hitlRequestId.isBlank()) {
            return HitlSubmitResult.Failed("missing_request_id", null)
        }
        val payload = buildJsonObject {
            put("thread_id", threadId)
            put("request_id", hitlRequestId)
            put("response", response)
        }
        val ack = webSocketService.sendAndWaitAck(
            type = "localrt.user_response",
            payload = payload,
            okType = "localrt.user_response.ok",
            nakType = "localrt.user_response.nak",
            threadId = threadId,
            timeoutMs = 15_000L,
        )
        return mapAckToHitlResult(ack)
    }

    public suspend fun getArchivedSessions(space: Space): List<ChatSession> =
        chatApi.getSessions(
            workspaceId = space.id.takeIf { space.isExecutionSpace },
            projectId = space.id.takeIf { space.isProject },
            status = "archived",
        ).unwrap().sessions

    public suspend fun archiveSession(sessionId: String): ChatSession {
        val archived = chatApi.updateSession(
            sessionId,
            com.tabtin.mobile.data.api.UpdateSessionRequest(status = "archived"),
        ).unwrap()
        _archivedSessionIds.tryEmit(sessionId)
        return archived
    }

    public suspend fun renameSession(sessionId: String, title: String): ChatSession =
        chatApi.updateSession(sessionId, com.tabtin.mobile.data.api.UpdateSessionRequest(title = title)).unwrap()

    public suspend fun restoreSession(sessionId: String): ChatSession =
        chatApi.updateSession(sessionId, com.tabtin.mobile.data.api.UpdateSessionRequest(status = "active")).unwrap()

    public suspend fun setSessionPinned(sessionId: String, isPinned: Boolean): ChatSession =
        chatApi.updateSession(
            sessionId,
            com.tabtin.mobile.data.api.UpdateSessionRequest(isPinned = isPinned),
        ).unwrap()

    /** 切换会话后续轮次的执行 Agent；正在运行的轮次仍由服务端运行快照保持原 Agent。 */
    public suspend fun switchSessionAgent(sessionId: String, agentId: String): ChatSession =
        chatApi.updateSession(
            sessionId,
            com.tabtin.mobile.data.api.UpdateSessionRequest(agentId = agentId),
        ).unwrap()

    /** ：即时同步 Composer 工作方式到 ChatSession.agent_mode。 */
    public suspend fun updateSessionAgentMode(sessionId: String, agentMode: String): ChatSession =
        chatApi.updateSession(
            sessionId,
            com.tabtin.mobile.data.api.UpdateSessionRequest(agentMode = agentMode),
        ).unwrap()

    public suspend fun deleteSession(sessionId: String) {
        chatApi.deleteSession(sessionId).unwrap()
    }

    public fun cacheAppend(sessionId: String, message: ChatMessage) {
        messageStore.compute(sessionId) { _, existing -> (existing ?: emptyList()) + message }
    }

    public suspend fun cacheMessagesSnapshot(sessionId: String, messages: List<ChatMessage>) {
        val snapshot = messages.filter {
            !it.isStreaming
                && it.planProposal == null
                && it.modeSwitchProposal == null
                && !it.isSubagentTranscript
                && !it.isInternalContext
                && !it.shouldHidePushNotification
        }
        messageStore[sessionId] = snapshot
        replaceDbSnapshot(sessionId, snapshot)
        touchAccess(sessionId)
    }

    public fun clearCache() {
        messageStore.clear()
        hasMoreStore.clear()
        syncWatermarkStore.clear()
        synchronized(accessOrder) { accessOrder.clear() }
    }

    private fun touchAccess(sessionId: String) {
        synchronized(accessOrder) {
            accessOrder.remove(sessionId)
            accessOrder.addLast(sessionId)
            while (accessOrder.size > MAX_CACHED_SESSIONS) {
                val evictId = accessOrder.removeFirst()
                messageStore.remove(evictId)
                hasMoreStore.remove(evictId)
                syncWatermarkStore.remove(evictId)
            }
        }
    }
}

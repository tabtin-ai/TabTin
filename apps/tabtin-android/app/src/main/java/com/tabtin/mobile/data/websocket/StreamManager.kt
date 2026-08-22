package com.tabtin.mobile.data.websocket

import android.content.Context
import android.util.Log
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.AskFormField
import com.tabtin.mobile.data.model.AskFormOption
import com.tabtin.mobile.data.model.AskFormRequest
import com.tabtin.mobile.data.model.ApprovalActionRequest
import com.tabtin.mobile.data.model.ApprovalResolvedDecision
import com.tabtin.mobile.data.model.AskUserOption
import com.tabtin.mobile.data.model.AskUserQuestion
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.formalOssImagePayload
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.MessageIdMapping
import com.tabtin.mobile.data.model.MessageBlock
import com.tabtin.mobile.data.model.PushNotificationVisibility
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.AgentTodoItem
import com.tabtin.mobile.data.model.PlanApprovalSnapshot
import com.tabtin.mobile.data.model.PlanApprovalTodo
import com.tabtin.mobile.data.model.PlanProposal
import com.tabtin.mobile.data.model.PlanProposalTodo
import com.tabtin.mobile.data.model.ReviewActionRequest
import com.tabtin.mobile.data.model.ReviewConfig
import com.tabtin.mobile.data.model.ReviewRequestState
import com.tabtin.mobile.data.model.ModeSwitchProposal
import com.tabtin.mobile.data.model.RequestApprovalRequest
import com.tabtin.mobile.data.model.HitlResolutionAccess
import com.tabtin.mobile.data.model.SubagentFailureType
import com.tabtin.mobile.data.model.SubagentRunStats
import com.tabtin.mobile.data.model.SubagentToolStep
import com.tabtin.mobile.data.model.StreamEvent
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.wire.buildChatCancelPayload
import com.tabtin.mobile.features.conversation.ConversationReconnectPolicy
import com.tabtin.mobile.features.conversation.SubagentStreamRouting
import com.tabtin.mobile.util.TokenManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class StreamManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val webSocketService: WebSocketService,
    private val tokenManager: TokenManager,
) {
    private val _isStreaming = MutableStateFlow(false)
    public val isStreaming: StateFlow<Boolean> = _isStreaming.asStateFlow()

    private val _currentPhase = MutableStateFlow(AgentPhase.IDLE)
    public val currentPhase: StateFlow<AgentPhase> = _currentPhase.asStateFlow()

    private val _currentToolName = MutableStateFlow<String?>(null)
    public val currentToolName: StateFlow<String?> = _currentToolName.asStateFlow()

    private var activeThreadId: String? = null
    private var activeSessionId: String? = null
    private var currentRunId: String? = null
    private val lastToolIdByName = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val subagentAccumulators = java.util.concurrent.ConcurrentHashMap<String, StreamAccumulator>()

    public fun observeSession(sessionId: String, shareId: String? = null): Flow<StreamEvent> = callbackFlow {
        val threadId = "chat-session-$sessionId"
        val topic = "${AgentStreamEvent.PREFIX}$threadId"
        val acc = StreamAccumulator()
        val handlerKey = "$HANDLER_KEY-observe-$sessionId"
        var lastSeq: Int? = null
        var pendingSeqGapReconcile = false
        var acceptLowerSeq = false
        var acceptLowerSeqWindowJob: Job? = null
        activeSessionId = sessionId
        activeThreadId = threadId

        launch {
            webSocketService.connectionState.collect { state ->
                val dropped = state is WSConnectionState.Reconnecting ||
                    state == WSConnectionState.Disconnected
                if (dropped) {
                    lastSeq = null
                    pendingSeqGapReconcile = false
                    acceptLowerSeq = true
                    acceptLowerSeqWindowJob?.cancel()
                    return@collect
                }
                if (
                    state == WSConnectionState.Connected &&
                    ConversationReconnectPolicy.shouldResetSeqCursor(acceptLowerSeq)
                ) {
                    lastSeq = null
                    pendingSeqGapReconcile = false
                    acceptLowerSeq = true
                    acceptLowerSeqWindowJob?.cancel()
                    acceptLowerSeqWindowJob = launch {
                        delay(ConversationReconnectPolicy.ACCEPT_LOWER_SEQ_WINDOW_MS)
                        acceptLowerSeq = false
                    }
                }
            }
        }

        webSocketService.onEnvelope(handlerKey) { envelope ->
            val isStreamEvent = envelope.type.startsWith(AgentStreamEvent.PREFIX)
            val isActionApprovalEvent = envelope.type in ACTION_APPROVAL_EVENTS
            if (!isStreamEvent && !isActionApprovalEvent) return@onEnvelope
            if (!envelopeBelongsToSession(envelope, sessionId, threadId, topic)) return@onEnvelope

            // ：父 topic 上带 subagent_run_id 的 raw 流事件（含 thinking）必须尽早隔离——
            // 在父 `_seq==1` 重置 / 主流 map 之前。绝不能进父气泡或重置父 accumulator。
            if (SubagentStreamRouting.shouldIsolateFromParentTimeline(envelope)) {
                val isolated = mapIsolatedSubagentStream(envelope) ?: return@onEnvelope
                trySend(isolated)
                return@onEnvelope
            }

            val seq = if (isStreamEvent) envelope.seq ?: envelope.payloadInt("_seq") else null
            if (seq != null) {
                when (
                    ConversationReconnectPolicy.decideSeq(
                        previous = lastSeq,
                        incoming = seq,
                        acceptLowerSeq = acceptLowerSeq,
                    )
                ) {
                    ConversationReconnectPolicy.SeqDecision.Drop -> return@onEnvelope
                    ConversationReconnectPolicy.SeqDecision.Reset -> {
                        lastSeq = 1
                        acc.reset()
                        pendingSeqGapReconcile = false
                    }
                    ConversationReconnectPolicy.SeqDecision.Apply -> {
                        val prev = lastSeq
                        if (!acceptLowerSeq && prev != null && seq > prev + 1) {
                            pendingSeqGapReconcile = true
                            Log.w(TAG, "Stream seq gap for $sessionId: last=$prev next=$seq")
                        }
                        lastSeq = maxOf(seq, prev ?: 0)
                    }
                }
            }

            val eventType = normalizeEventType(envelope.type)
            if (eventType != AgentStreamEvent.USER) {
                envelope.payloadString("source_client_event_id")
                    ?.takeIf { it.isNotBlank() }
                    ?.let { trySend(StreamEvent.OutgoingExecutionStarted(it)) }
            }
            val event = mapEnvelopeToEvent(eventType, envelope, acc) ?: return@onEnvelope
            trySend(event)
            if (pendingSeqGapReconcile && event.shouldReconcileAfterSeqGap()) {
                pendingSeqGapReconcile = false
                trySend(StreamEvent.NeedsResync(sessionId))
            }
        }

        launch {
            val connected = webSocketService.connectAndWait()
            if (!connected) {
                trySend(StreamEvent.Error(AppError.WsTimeout))
                return@launch
            }
            val contexts = shareId?.takeIf { it.isNotBlank() }?.let {
                mapOf(topic to kotlinx.serialization.json.buildJsonObject { put("share_id", it) })
            }.orEmpty()
            when (val result = webSocketService.subscribeAndWait(listOf(topic), contexts)) {
                SubscriptionResult.Success -> trySend(StreamEvent.SubscriptionReady)
                is SubscriptionResult.Rejected -> trySend(
                    StreamEvent.Error(AppError.SubscribeRejected(result.errorCode, result.serverMessage)),
                )
                SubscriptionResult.TimedOut -> trySend(StreamEvent.Error(AppError.SubscribeTimedOut))
                SubscriptionResult.Disconnected -> trySend(StreamEvent.Error(AppError.SubscribeDisconnected))
            }
        }

        awaitClose {
            webSocketService.removeHandler(handlerKey)
            if (activeSessionId == sessionId) {
                activeSessionId = null
                currentRunId = null
            }
            if (activeThreadId == threadId) activeThreadId = null
        }
    }.buffer(capacity = 128, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    public fun releaseSession(sessionId: String, keepAlive: Boolean) {
        val topic = "${AgentStreamEvent.PREFIX}chat-session-$sessionId"
        if (keepAlive) {
            webSocketService.unsubscribeAfterDelay(listOf(topic), INACTIVE_STREAM_TOPIC_RETAIN_MS)
        } else {
            webSocketService.unsubscribe(listOf(topic))
        }
    }

    public suspend fun sendMessage(
        sessionId: String,
        message: String,
        blocks: List<MessageBlock>? = null,
        modelId: String,
        runtimeConfiguration: ConversationRuntimeConfiguration,
        clientEventId: String = java.util.UUID.randomUUID().toString(),
        focus: ConversationFocusContext? = null,
    ): AckResult {
        val threadId = "chat-session-$sessionId"
        val topic = "${AgentStreamEvent.PREFIX}$threadId"
        val connected = webSocketService.connectAndWait()
        if (!connected) return AckResult.Disconnected
        when (val result = webSocketService.subscribeAndWait(listOf(topic))) {
            SubscriptionResult.Success -> Unit
            SubscriptionResult.TimedOut -> return subscriptionNak(
                errorCode = "SUBSCRIPTION_TIMEOUT",
                errorMessage = "订阅会话流超时",
                retryable = true,
            )
            SubscriptionResult.Disconnected -> return subscriptionNak(
                errorCode = "SUBSCRIPTION_DISCONNECTED",
                errorMessage = "订阅会话流时连接已中断",
                retryable = true,
            )
            is SubscriptionResult.Rejected -> return subscriptionNak(
                errorCode = result.errorCode,
                errorMessage = result.serverMessage ?: "订阅会话流被拒绝",
                retryable = result.errorCode != "WS_1005_PERMISSION_DENIED",
            )
        }
        return webSocketService.sendAndWaitAck(
            type = "chat.send_message",
            payload = buildChatSendMessagePayload(
                sessionId = sessionId,
                message = message,
                blocks = blocks,
                modelId = modelId,
                runtimeConfiguration = runtimeConfiguration,
                clientEventId = clientEventId,
                focus = focus,
            ),
            okType = "chat.send_message.ok",
            nakType = "chat.send_message.nak",
            threadId = threadId,
            timeoutMs = 30_000L,
        )
    }

    private fun subscriptionNak(
        errorCode: String,
        errorMessage: String,
        retryable: Boolean,
    ): AckResult.Nak = AckResult.Nak(
        errorCode = errorCode,
        errorMessage = errorMessage,
        errorCategory = "subscription",
        retryable = retryable,
    )

    /**
     * Request cancellation and wait for the server acknowledgement.
     *
     * An accepted cancel is not the same as a terminal stream event, so callers
     * keep their local run state until the stream settles. Returning the ACK lets
     * the UI distinguish a rejected / timed-out request from a real stop.
     *
     * Optional withdraw fields are additive (iOS / Electron unanswered-turn
     * withdraw); defaults keep the legacy stop-only payload.
     *
     * ：`chat.cancel.ok` payload 可能带可选 `withdraw_applied`（Boolean），
     * 由调用方从 [AckResult.Ok].payload 解析，门控终态对账豁免。
     */
    public suspend fun cancelMessage(
        sessionId: String,
        taskId: String? = null,
        clientMessageId: String? = null,
        withdrawUnanswered: Boolean = false,
        targetContent: String? = null,
        shouldSend: () -> Boolean = { true },
    ): AckResult? {
        val threadId = "chat-session-$sessionId"
        val connected = webSocketService.connectAndWait()
        if (!connected) return AckResult.Disconnected
        // A caller may have left the session or received a terminal event while
        // reconnecting. Do not turn that stale UI intent into a new wire command.
        if (!shouldSend()) return null
        return webSocketService.sendAndWaitAck(
            type = "chat.cancel",
            payload = buildChatCancelPayload(
                sessionId = sessionId,
                taskId = taskId,
                clientMessageId = clientMessageId,
                withdrawUnanswered = withdrawUnanswered,
                targetContent = targetContent,
            ),
            okType = "chat.cancel.ok",
            nakType = "chat.cancel.nak",
            threadId = threadId,
            timeoutMs = 15_000L,
        )
    }

    public suspend fun pauseSession(
        sessionId: String,
        shouldSend: () -> Boolean = { true },
    ): AckResult? = sendPauseControl(sessionId, paused = true, shouldSend = shouldSend)

    public suspend fun resumeSession(
        sessionId: String,
        shouldSend: () -> Boolean = { true },
    ): AckResult? = sendPauseControl(sessionId, paused = false, shouldSend = shouldSend)

    private suspend fun sendPauseControl(
        sessionId: String,
        paused: Boolean,
        shouldSend: () -> Boolean,
    ): AckResult? {
        val action = if (paused) "pause" else "resume"
        val threadId = "chat-session-$sessionId"
        val connected = webSocketService.connectAndWait()
        if (!connected) return AckResult.Disconnected
        if (!shouldSend()) return null
        return webSocketService.sendAndWaitAck(
            type = "chat.$action",
            payload = buildJsonObject { put("session_id", sessionId) },
            okType = "chat.$action.ok",
            nakType = "chat.$action.nak",
            threadId = threadId,
            timeoutMs = 15_000L,
        )
    }

    /**
     * 取消单个正在执行 / 排队的子 Agent（best-effort，即发即忘，对齐整轮 `chat.cancel`）。
     * 上行 `subagent.cancel { session_id, child_id }`——Django `subagent_cancel` handler
     * 校验会话权限后转发到绑定设备；终态经 `subagent_failed(status=cancelled)` 回流收尾。
     * child_id 即子 Agent 的真实 run id（移动端观察 daemon 托管会话，用 runId 寻址）。
     */
    public fun cancelSubagent(sessionId: String, childId: String) {
        val threadId = "chat-session-$sessionId"
        webSocketService.notify(
            type = "subagent.cancel",
            payload = buildJsonObject {
                put("session_id", sessionId)
                put("child_id", childId)
            },
            threadId = threadId,
        )
    }

    public suspend fun ensureSessionReady(sessionId: String): Boolean {
        val threadId = "chat-session-$sessionId"
        val topic = "${AgentStreamEvent.PREFIX}$threadId"
        val connected = webSocketService.connectAndWait()
        if (!connected) return false
        return webSocketService.subscribeAndWait(listOf(topic)) is SubscriptionResult.Success
    }

    private class StreamAccumulator {
        var content = ""
        var reasoning = ""
        var currentMessageId: String? = null
        /** ：message_delta.delta.stop_reason，供随后的 message_stop 消费。 */
        var stopReason: String? = null
        val blockKinds = mutableMapOf<String, String>()
        val toolInputsByBlock = mutableMapOf<String, String>()
        val toolMetaByBlock = mutableMapOf<String, Pair<String, String>>()
        /** 源 A 乐观子 Agent 派发块：blockKey → toolCallId（block.id）。用于 stop 时反查 check 调用。 */
        val subagentBlocksByKey = mutableMapOf<String, String>()

        fun reset() {
            content = ""
            reasoning = ""
            currentMessageId = null
            stopReason = null
            blockKinds.clear()
            toolInputsByBlock.clear()
            toolMetaByBlock.clear()
            subagentBlocksByKey.clear()
        }
    }

    private fun normalizeEventType(type: String): String =
        if (type.startsWith(AgentStreamEvent.PREFIX)) type.removePrefix(AgentStreamEvent.PREFIX) else type

    private fun envelopeBelongsToSession(
        envelope: WSEnvelope,
        sessionId: String,
        threadId: String,
        topic: String,
    ): Boolean {
        envelope.threadId?.takeIf { it.isNotBlank() }?.let { return it == threadId }
        envelope.payloadString("thread_id")?.takeIf { it.isNotBlank() }?.let {
            return it == threadId || it == sessionId
        }
        envelope.sessionId?.takeIf { it.isNotBlank() }?.let { return it == sessionId }
        envelope.payloadString("session_id")?.takeIf { it.isNotBlank() }?.let { return it == sessionId }
        envelope.topic?.takeIf { it.isNotBlank() }?.let { return it == topic }
        envelope.payloadString("_topic")?.takeIf { it.isNotBlank() }?.let { return it == topic }
        return true
    }

    private fun StreamEvent.shouldReconcileAfterSeqGap(): Boolean =
        this is StreamEvent.Done ||
            this is StreamEvent.Error ||
            this is StreamEvent.MessageStopped ||
            this is StreamEvent.MessagePersisted ||
            this is StreamEvent.MessageCommitted ||
            this is StreamEvent.RunCompletedInBackground

    private fun mapEnvelopeToEvent(eventType: String, envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        // ── W4.5 第三波 C1（2026-05-13）老协议 case 物理删 ──
        // 删除：ASSISTANT / REASONING / TOOL / REVIEW_REQUIRED / CONTENT_RESET / TOOL_HEARTBEAT
        // wire 层 `StreamEvents.*` 同步物理删，daemon 0 emit。
        // - ASSISTANT / "chunk" → 新协议 `content_block_delta(text_delta)` 替代（W6 接 6 件套）
        // - REASONING → `content_block_delta(thinking_delta)` 替代
        // - TOOL → SYSTEM_NOTICE notice_type='tool_*' 替代（已上线）
        // - REVIEW_REQUIRED → APPROVAL_REQUESTED batch 替代
        // - CONTENT_RESET → message_stop(stop_reason='aborted') + 新 message_start 替代
        // - TOOL_HEARTBEAT → SYSTEM_NOTICE notice_type='tool_heartbeat' 通用通道替代
        //
        // **保留 STEP**：daemon `query.ts` 仍 emit thinking 步骤；W6 接 6 件套时再清。

        return when (eventType) {
            AgentStreamEvent.USER -> handleObservedUser(envelope)
            AgentStreamEvent.LIFECYCLE -> handleLifecycle(envelope)
            AgentStreamEvent.STEP -> handleStep(envelope)
            AgentStreamEvent.DONE -> handleDone(envelope, acc)
            AgentStreamEvent.MESSAGE_PERSISTED -> handleMessagePersisted(envelope, acc)
            AgentStreamEvent.MESSAGE_COMMITTED -> handleMessageCommitted(envelope)
            AgentStreamEvent.SUBAGENT_STARTED -> handleSubagentStarted(envelope)
            AgentStreamEvent.SUBAGENT_QUEUED -> handleSubagentQueued(envelope)
            AgentStreamEvent.SUBAGENT_COMPLETED -> handleSubagentCompleted(envelope)
            AgentStreamEvent.SUBAGENT_FAILED -> handleSubagentFailed(envelope)
            AgentStreamEvent.SUBAGENT_PROGRESS -> handleSubagentProgress(envelope)
            AgentStreamEvent.SUBAGENT_STREAM_EVENT -> handleSubagentStreamEvent(envelope)
            // 6 件套基础接入：text/thinking/tool_use/tool_result 先投到现有
            // ChatBubble 的 content/reasoning/AgentStep 模型；完整 BlockTimeline
            // projector 后续会在 ViewModel 层替换这层聚合形态。
            AgentStreamEvent.CONTENT_BLOCK_START -> handleContentBlockStart(envelope, acc)
                ?: handleContentBlockStartForMainTimeline(envelope, acc)
            AgentStreamEvent.CONTENT_BLOCK_DELTA -> handleContentBlockDelta(envelope, acc)
            AgentStreamEvent.CONTENT_BLOCK_STOP -> handleContentBlockStop(envelope, acc)
            AgentStreamEvent.MESSAGE_START -> handleMessageStart(envelope, acc)
            AgentStreamEvent.MESSAGE_DELTA -> handleMessageDelta(envelope, acc)
            AgentStreamEvent.MESSAGE_STOP -> handleMessageStop(envelope, acc)
            // W4（2026-05-11）：原 ask 三件套合并为单 `ask_user_required` 事件。
            // Android 已有完整 ask_user 解析（questions[] + form_mode='fields' 兼容），
            // 由 handleAskUserRequired emit StreamEvent.AskUser 走 ConversationView
            // / AskUserPanelView 完整 UI 渲染。
            AgentStreamEvent.ASK_USER_REQUIRED -> handleAskUserRequired(envelope, acc)
            AgentStreamEvent.SINGLE_HITL_RESOLVED -> decodeSingleHitlResolvedEvent(envelope)
            AgentStreamEvent.SYSTEM_NOTICE -> handleSystemNotice(envelope)
                ?: handleToolLifecycleNotice(envelope)
            AgentStreamEvent.TODO -> handleTodoUpdate(envelope)
            AgentStreamEvent.SSH_OUTPUT -> {
                Log.d(TAG, "SSH output (not displayed on mobile)")
                null
            }
            AgentStreamEvent.COMPACTION -> handleCompaction(envelope)
            AgentStreamEvent.CONTEXT_PRESSURE -> handleContextPressure(envelope)
            AgentStreamEvent.PERSIST_ERROR -> {
                Log.w(TAG, "Persist error: ${envelope.payload}")
                val detail = envelope.payloadString("error")
                StreamEvent.Error(AppError.AgentExecution(detail))
            }
            AgentStreamEvent.CHECKPOINT_FAILED -> {
                val sid = envelope.payloadString("session_id") ?: activeSessionId ?: ""
                StreamEvent.CheckpointFailed(sid)
            }
            AgentStreamEvent.CHECKPOINT_SUCCESS -> {
                val sid = envelope.payloadString("session_id") ?: activeSessionId ?: ""
                StreamEvent.CheckpointSuccess(sid)
            }
            AgentStreamEvent.PLAN_APPROVAL_REQUIRED -> handlePlanApprovalRequired(envelope)
            AgentStreamEvent.PLAN_PROPOSAL -> handlePlanProposal(envelope)
            AgentStreamEvent.MODE_SWITCH_PROPOSAL -> handleModeSwitchProposal(envelope)
            AgentStreamEvent.APPROVAL_REQUESTED -> handleApprovalRequested(envelope)
            AgentStreamEvent.APPROVAL_RESOLVED -> handleApprovalResolved(envelope)
            ACTION_APPROVAL_REQUEST -> handleActionApprovalRequest(envelope)
            ACTION_APPROVAL_RESOLVED -> handleActionApprovalResolved(envelope)
            AgentStreamEvent.ASK_FORM_REQUIRED -> handleAskFormRequired(envelope)
            AgentStreamEvent.REQUEST_APPROVAL_REQUIRED -> handleRequestApprovalRequired(envelope)
            "heartbeat" -> null
            else -> {
                Log.d(TAG, "Unhandled stream event: $eventType")
                null
            }
        }
    }

    private fun handleAskFormRequired(envelope: WSEnvelope): StreamEvent? {
        val requestId = firstNonBlank(
            envelope.payloadString("request_id"),
            envelope.payloadString("interrupt_id"),
            envelope.payloadString("message_id"),
        ) ?: return null
        val rawFields = envelope.payload["fields"] as? JsonArray ?: return null
        val fields = rawFields.mapIndexedNotNull { index, item ->
            val obj = item as? JsonObject ?: return@mapIndexedNotNull null
            val key = firstNonBlank(obj.jsonString("key"), obj.jsonString("name"), obj.jsonString("id"))
                ?: "field-$index"
            val label = firstNonBlank(obj.jsonString("label"), obj.jsonString("title"), obj.jsonString("prompt"))
                ?: key
            val options = (obj["options"] as? JsonArray)
                ?.mapIndexedNotNull { optionIndex, optionItem ->
                    val option = optionItem as? JsonObject ?: return@mapIndexedNotNull null
                    val id = firstNonBlank(option.jsonString("id"), option.jsonString("value"), option.jsonString("key"))
                        ?: "opt-$optionIndex"
                    AskFormOption(
                        id = id,
                        label = firstNonBlank(
                            option.jsonString("label"),
                            option.jsonString("title"),
                            option.jsonString("text"),
                            option.jsonString("name"),
                        ) ?: id,
                        description = firstNonBlank(option.jsonString("description"), option.jsonString("desc")),
                    )
                }
                .orEmpty()
            AskFormField(
                key = key,
                label = label,
                type = obj.jsonString("type") ?: "input",
                description = firstNonBlank(obj.jsonString("description"), obj.jsonString("desc")),
                placeholder = obj.jsonString("placeholder"),
                required = obj.jsonBool("required") ?: false,
                options = options,
            )
        }
        if (fields.isEmpty()) return null
        _currentPhase.value = AgentPhase.DONE
        _currentToolName.value = null
        return StreamEvent.AskFormRequired(
            AskFormRequest(
                requestId = requestId,
                title = envelope.payloadString("title") ?: "请补充信息",
                submitLabel = envelope.payloadString("submit_label"),
                fields = fields,
            ),
            resolutionAccess = hitlResolutionAccess(envelope),
        )
    }

    private fun handleRequestApprovalRequired(envelope: WSEnvelope): StreamEvent? {
        val requestId = firstNonBlank(
            envelope.payloadString("request_id"),
            envelope.payloadString("interrupt_id"),
            envelope.payloadString("message_id"),
        ) ?: return null
        _currentPhase.value = AgentPhase.DONE
        _currentToolName.value = null
        return StreamEvent.RequestApprovalRequired(
            RequestApprovalRequest(
                requestId = requestId,
                title = envelope.payloadString("title") ?: "需要你的批准",
                rationale = envelope.payloadString("rationale")
                    ?: envelope.payloadString("message")
                    ?: "",
                riskLevel = envelope.payloadString("risk_level") ?: "medium",
                submitLabel = envelope.payloadString("submit_label"),
                declineLabel = envelope.payloadString("decline_label"),
            ),
            resolutionAccess = hitlResolutionAccess(envelope),
        )
    }

    private fun showToast(message: String, long: Boolean) {
        toastScope.launch(kotlinx.coroutines.Dispatchers.Main) {
            android.widget.Toast.makeText(
                context,
                message,
                if (long) android.widget.Toast.LENGTH_LONG else android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    private val toastScope: kotlinx.coroutines.CoroutineScope by lazy {
        kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main,
        )
    }

    /**
     * Wave 4 I8：plan.exit 审批请求。
     * 协议字段对照（packages/agent-wire/src/plan-approval.ts）：
     *   request_id : string  必填
     *   session_id : string  推荐
     *   plan_document_id : string  必填
     *   plan_snapshot : { name, overview, todos[id,content,status], description_markdown }  可选
     *   hint_allowed_prompts : string[]  可选
     * request_id 或 plan_document_id 缺失即丢弃（与 Electron planApprovalHandler.ts 对齐）。
     */
    private fun handlePlanApprovalRequired(envelope: WSEnvelope): StreamEvent? {
        val requestId = envelope.payloadString("request_id")?.takeIf { it.isNotBlank() }
        val planDocumentId = envelope.payloadString("plan_document_id")?.takeIf { it.isNotBlank() }
        if (requestId == null || planDocumentId == null) {
            Log.w(TAG, "plan_approval_required missing required fields, dropped (hasRequestId=${requestId != null}, hasPlanDocId=${planDocumentId != null})")
            return null
        }
        val sessionId = envelope.payloadString("session_id")
            ?.takeIf { it.isNotBlank() }
            ?: activeSessionId

        val snapshotObj = envelope.payload["plan_snapshot"] as? JsonObject
        val planSnapshot = snapshotObj?.let { parsePlanSnapshot(it) }

        val hintArr = envelope.payload["hint_allowed_prompts"] as? JsonArray
        val hintAllowedPrompts = hintArr?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?.filter { it.isNotBlank() }
            ?: emptyList()

        return StreamEvent.PlanApprovalRequired(
            requestId = requestId,
            sessionId = sessionId,
            planDocumentId = planDocumentId,
            planSnapshot = planSnapshot,
            hintAllowedPrompts = hintAllowedPrompts,
        )
    }

    private fun parsePlanSnapshot(obj: JsonObject): PlanApprovalSnapshot? {
        val name = obj.jsonString("name") ?: return null
        val overview = obj.jsonString("overview") ?: ""
        val description = obj.jsonString("description_markdown") ?: ""
        val todosArr = obj["todos"] as? JsonArray ?: JsonArray(emptyList())
        val todos = todosArr.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val id = o.jsonString("id") ?: return@mapNotNull null
            val content = o.jsonString("content") ?: ""
            val status = o.jsonString("status") ?: "pending"
            PlanApprovalTodo(id, content, status)
        }
        return PlanApprovalSnapshot(
            name = name,
            overview = overview,
            descriptionMarkdown = description,
            todos = todos,
        )
    }

    private fun handlePlanProposal(envelope: WSEnvelope): StreamEvent? {
        val planDocumentId = envelope.payloadString("plan_document_id")?.takeIf { it.isNotBlank() } ?: run {
            Log.w(TAG, "plan_proposal missing plan_document_id, dropped")
            return null
        }
        val todosArr = envelope.payload["todos"] as? JsonArray ?: JsonArray(emptyList())
        val todos = todosArr.mapIndexedNotNull { index, el ->
            val o = el as? JsonObject ?: return@mapIndexedNotNull null
            PlanProposalTodo(
                id = o.jsonString("id") ?: "todo-$index",
                content = o.jsonString("content") ?: o.jsonString("text") ?: "",
                status = o.jsonString("status") ?: "pending",
            )
        }
        return StreamEvent.PlanProposalReceived(
            PlanProposal(
                planDocumentId = planDocumentId,
                sessionId = envelope.payloadString("session_id") ?: activeSessionId,
                planName = envelope.payloadString("plan_name") ?: envelope.payloadString("name") ?: "",
                overview = envelope.payloadString("overview") ?: "",
                descriptionMarkdown = envelope.payloadString("description_markdown") ?: "",
                todos = todos,
            )
        )
    }

    private fun handleModeSwitchProposal(envelope: WSEnvelope): StreamEvent? {
        val proposalId = envelope.payloadString("proposal_id")
            ?.takeIf { it.isNotBlank() }
            ?: envelope.eventId
            ?: "mode-${System.currentTimeMillis()}"
        return StreamEvent.ModeSwitchProposalReceived(
            ModeSwitchProposal(
                proposalId = proposalId,
                sessionId = envelope.payloadString("session_id") ?: activeSessionId,
                targetModeId = envelope.payloadString("target_mode_id") ?: "agent",
                reason = envelope.payloadString("reason") ?: "",
            )
        )
    }

    /**
     * v0.4 W1.5-轮 4：批量审批请求（仅 tool_permission；plan_exit 已删除）。
     *
     * 协议字段对照（packages/agent-wire/src/approval.ts ApprovalRequestedPayloadSchema）：
     *   batch_id : string                   必填（v0.4 新增）
     *   approval_type : 'tool_permission'   必填（v0.4 唯一值）
     *   action_requests : ActionRequest[]   必填，N >= 1
     *   runtime_mode : 'interactive' | 'solo' | 'scheduled' | 'batch'
     *   expires_at : number                 必填
     *   schema_version : 1
     *
     * 单条 ActionRequest 字段：
     *   request_id / tool_call_id / tool_name / tool_namespace? / tool_input
     *   decision_reason : { type, ... }
     *   ask_hint? : { summary, suggested_scope }
     *   allowed_scopes / allowed_outcomes / risk_level
     *
     * batch_id 缺失即丢弃；action_requests 为空也丢弃。
     */
    private fun handleApprovalRequested(envelope: WSEnvelope): StreamEvent? {
        val batchId = envelope.payloadString("batch_id")?.takeIf { it.isNotBlank() } ?: run {
            Log.w(TAG, "approval_requested missing batch_id, dropped")
            return null
        }
        val approvalType = envelope.payloadString("approval_type")?.takeIf { it in APPROVAL_TYPE_VALUES } ?: run {
            Log.w(TAG, "approval_requested invalid approval_type=${envelope.payloadString("approval_type")}, dropped")
            return null
        }

        // expires_at TS 类型是 z.number()；JsonPrimitive 既可能是 number 也可能是 string
        val expiresAtMs = (envelope.payload["expires_at"] as? JsonPrimitive)?.let { prim ->
            prim.contentOrNull?.toLongOrNull()
        }
        // schema_version=1 协议必填；不强校验防 future-bump 静默失败，但缺失/不等于 1 时 log
        val schemaVersion = (envelope.payload["schema_version"] as? JsonPrimitive)
            ?.contentOrNull?.toIntOrNull()
        if (schemaVersion == null || schemaVersion != 1) {
            Log.w(TAG, "approval_requested schema_version=$schemaVersion (expected 1), proceeding")
        }

        // 解析 action_requests[] 数组（v0.4 batch schema）
        val actionRequestsArr = envelope.payload["action_requests"] as? JsonArray
            ?: run {
                Log.w(TAG, "approval_requested action_requests missing, dropped batch_id=$batchId")
                return null
            }
        val actionRequests: List<ApprovalActionRequest> = actionRequestsArr.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val requestId = obj.jsonString("request_id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val toolCallId = obj.jsonString("tool_call_id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val toolName = obj.jsonString("tool_name") ?: return@mapNotNull null

            val toolInputStr = obj.jsonString("tool_input")
                ?: (obj["tool_input"] as? JsonObject)?.let {
                    Json.encodeToString(JsonObject.serializer(), it)
                }
                ?: (obj["tool_input"] as? JsonArray)?.let {
                    Json.encodeToString(JsonArray.serializer(), it)
                }

            val askHint = obj["ask_hint"] as? JsonObject
            val askHintSummary = askHint?.jsonString("summary")
            val askHintSuggestedScope = askHint?.jsonString("suggested_scope")

            val scopesArr = obj["allowed_scopes"] as? JsonArray
            val allowedScopes = scopesArr?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                ?.filter { it in ALLOWED_SCOPE_VALUES }
                ?: listOf("once")

            val outcomesArr = obj["allowed_outcomes"] as? JsonArray
            val allowedOutcomes = outcomesArr?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                ?.filter { it == "allow" || it == "deny" }
                ?: listOf("allow", "deny")

            val decisionReason = obj["decision_reason"] as? JsonObject
            val decisionReasonType = decisionReason?.jsonString("type")
            // L-W6-16：提取常用 string 字段供 UI strings_chat.xml 插值。
            // 字段 dict 结构取决于 reason.type，见 wire `DecisionReasonSchema`。
            val decisionReasonFields: Map<String, String>? = if (decisionReason != null) {
                val fields = mutableMapOf<String, String>()
                // "kind" 用于 workspace_in / workspace_out 区分 file.path vs shell.cwd；
                // UI 按 kind 选子资源（chat_approval_reason_workspace_out_cwd 等）。
                listOf("pattern", "path", "category", "key", "server", "device_action", "kind").forEach { k ->
                    decisionReason.jsonString(k)?.takeIf { it.isNotEmpty() }?.let { fields[k] = it }
                }
                fields.takeIf { it.isNotEmpty() }
            } else null

            ApprovalActionRequest(
                requestId = requestId,
                toolCallId = toolCallId,
                toolName = toolName,
                toolNamespace = obj.jsonString("tool_namespace"),
                toolInputJson = toolInputStr,
                decisionReasonType = decisionReasonType,
                decisionReasonFields = decisionReasonFields,
                askHintSummary = askHintSummary,
                askHintSuggestedScope = askHintSuggestedScope,
                allowedScopes = allowedScopes,
                allowedOutcomes = allowedOutcomes,
                riskLevel = obj.jsonString("risk_level"),
                workspaceZone = obj.jsonString("workspace_zone"),
            )
        }

        if (actionRequests.isEmpty()) {
            Log.w(TAG, "approval_requested action_requests empty after parsing, dropped batch_id=$batchId")
            return null
        }

        return StreamEvent.ApprovalRequested(
            batchId = batchId,
            approvalType = approvalType,
            actionRequests = actionRequests,
            runtimeMode = envelope.payloadString("runtime_mode"),
            expiresAtMs = expiresAtMs,
            resolutionAccess = hitlResolutionAccess(envelope),
        )
    }

    private fun handleActionApprovalRequest(envelope: WSEnvelope): StreamEvent? {
        val approvalId = envelope.payloadString("approval_id")?.takeIf { it.isNotBlank() } ?: run {
            Log.w(TAG, "agent.action.approval_request missing approval_id, dropped")
            return null
        }
        val threadId = envelope.threadId ?: envelope.payloadString("thread_id") ?: activeThreadId
        val command = envelope.payloadString("command").orEmpty()
        val detail = firstNonBlank(envelope.payloadString("detail"), command)
        val actionName = firstNonBlank(
            envelope.payloadString("action_type"),
            envelope.payloadString("action"),
            extractActionNameFromCommand(command),
            "sensitive_action",
        ) ?: "sensitive_action"
        val policyJson = (envelope.payload["policy"] as? JsonObject)
            ?.let { Json.encodeToString(JsonObject.serializer(), it) }
        val toolInputJson = buildJsonObject {
            detail?.takeIf { it.isNotBlank() }?.let { put("detail", it) }
            command.takeIf { it.isNotBlank() }?.let { put("command", it) }
            policyJson?.takeIf { it.isNotBlank() }?.let { put("policy", it) }
        }.takeIf { it.isNotEmpty() }?.let { Json.encodeToString(JsonObject.serializer(), it) }

        return StreamEvent.ApprovalRequested(
            batchId = actionApprovalBatchId(approvalId),
            approvalType = "tool_permission",
            actionRequests = listOf(
                ApprovalActionRequest(
                    requestId = approvalId,
                    toolCallId = approvalId,
                    toolName = actionName,
                    toolNamespace = null,
                    toolInputJson = toolInputJson,
                    decisionReasonType = "user_interactive",
                    decisionReasonFields = null,
                    askHintSummary = detail,
                    askHintSuggestedScope = "once",
                    allowedScopes = listOf("once"),
                    allowedOutcomes = listOf("allow", "deny"),
                    riskLevel = "write",
                    workspaceZone = null,
                )
            ),
            runtimeMode = null,
            expiresAtMs = null,
            actionApprovalId = approvalId,
            actionThreadId = threadId,
            resolutionAccess = hitlResolutionAccess(envelope),
        )
    }

    private fun handleActionApprovalResolved(envelope: WSEnvelope): StreamEvent? {
        val approvalId = envelope.payloadString("approval_id")?.takeIf { it.isNotBlank() } ?: return null
        val approved = envelope.payloadBool("approved") ?: true
        return StreamEvent.ApprovalResolved(
            batchId = actionApprovalBatchId(approvalId),
            decisions = listOf(
                ApprovalResolvedDecision(
                    requestId = approvalId,
                    toolCallId = approvalId,
                    outcome = if (approved) "allow" else "deny",
                    scope = envelope.payloadString("scope"),
                    rejectionMessage = null,
                    patternKey = null,
                    scopeDescription = null,
                    decisionKind = null,
                )
            ),
            rollbackEventId = null,
        )
    }

    /**
     * v0.4 W1.5-轮 4：批量审批已被解析。
     * 协议字段对照（packages/agent-wire/src/approval.ts ApprovalResolvedPayloadSchema）：
     *   batch_id : string                                            必填（v0.4 新增）
     *   decisions : ApprovalDecision[]                               必填，N >= 1
     *   rollback_event_id?                                           outcome=cancelled_by_rollback 时
     *   schema_version : 1
     *
     * 单条 ApprovalDecision 字段：
     *   request_id / tool_call_id
     *   outcome : 'allow'|'deny'|'cancelled'|'expired'|'cancelled_by_rollback'
     *   scope? / rejection_message? / approver_identity?
     */
    private fun handleApprovalResolved(envelope: WSEnvelope): StreamEvent? {
        val batchId = envelope.payloadString("batch_id")?.takeIf { it.isNotBlank() } ?: run {
            Log.w(TAG, "approval_resolved missing batch_id, dropped")
            return null
        }
        val decisionsArr = envelope.payload["decisions"] as? JsonArray ?: run {
            Log.w(TAG, "approval_resolved decisions missing, dropped batch_id=$batchId")
            return null
        }
        val decisions: List<ApprovalResolvedDecision> = decisionsArr.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val requestId = obj.jsonString("request_id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val toolCallId = obj.jsonString("tool_call_id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val outcome = obj.jsonString("outcome")?.takeIf { it in APPROVAL_OUTCOME_VALUES } ?: return@mapNotNull null
            ApprovalResolvedDecision(
                requestId = requestId,
                toolCallId = toolCallId,
                outcome = outcome,
                scope = obj.jsonString("scope"),
                rejectionMessage = obj.jsonString("rejection_message"),
                patternKey = obj.jsonString("pattern_key"),
                scopeDescription = obj.jsonString("scope_description"),
                decisionKind = obj.jsonString("decision_kind"),
            )
        }
        if (decisions.isEmpty()) {
            Log.w(TAG, "approval_resolved decisions empty after parsing, dropped batch_id=$batchId")
            return null
        }
        return StreamEvent.ApprovalResolved(
            batchId = batchId,
            decisions = decisions,
            rollbackEventId = envelope.payloadString("rollback_event_id"),
        )
    }

    private fun handleLifecycle(envelope: WSEnvelope): StreamEvent? {
        val phase = envelope.payloadString("phase") ?: ""
        val runId = envelope.payloadString("run_id")
        return when (phase) {
            "start" -> {
                currentRunId = runId
                _currentPhase.value = AgentPhase.PLANNING
                StreamEvent.LifecycleChanged(AgentPhase.PLANNING, runId)
            }
            "end" -> {
                _currentPhase.value = AgentPhase.DONE
                StreamEvent.LifecycleChanged(AgentPhase.DONE, runId)
            }
            "error" -> {
                _currentPhase.value = AgentPhase.ERROR
                val errorCategory = envelope.payloadString("error_category")
                val errorCode = envelope.payloadString("error_code") ?: errorCategory ?: ""
                val errorMsg = envelope.payloadString("error") ?: ""
                if (errorCategory != null && errorCategory in AppError.BillingBlocked.CATEGORIES) {
                    StreamEvent.Error(AppError.BillingBlocked(errorCategory, errorCode, errorMsg))
                } else {
                    StreamEvent.Error(
                        AppError.AgentExecution(
                            serverMessage = errorMsg.ifEmpty { null },
                            errorClass = envelope.payloadString("error_class"),
                            suggestedAction = envelope.payloadString("suggested_action"),
                            errorCategory = errorCategory,
                            errorCode = errorCode,
                        ),
                    )
                }
            }
            "terminated", "idle_timeout", "session_interrupted" -> {
                _currentPhase.value = AgentPhase.DONE
                StreamEvent.LifecycleChanged(AgentPhase.DONE, runId)
            }
            "permission_timeout_warning" -> {
                val requestId = envelope.payloadString("request_id") ?: ""
                if (requestId.isNotEmpty()) StreamEvent.PermissionStatusUpdate(requestId, expired = false, paused = false) else null
            }
            "permission_timeout_pause" -> {
                val requestId = envelope.payloadString("request_id") ?: ""
                if (requestId.isNotEmpty()) StreamEvent.PermissionStatusUpdate(requestId, expired = false, paused = true) else null
            }
            "permission_timeout" -> {
                val requestId = envelope.payloadString("request_id") ?: ""
                if (requestId.isNotEmpty()) StreamEvent.PermissionStatusUpdate(requestId, expired = true, paused = false) else null
            }
            else -> null
        }
    }

    private fun handleChunk(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        val content = envelope.payloadString("content") ?: return null
        if (content.isEmpty()) return null
        acc.content += content
        _currentPhase.value = AgentPhase.EXECUTING
        return StreamEvent.ChunkAppended(content, acc.content)
    }

    private fun handleReasoning(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        val content = envelope.payloadString("content") ?: return null
        if (content.isEmpty()) return null
        acc.reasoning += content
        return StreamEvent.Reasoning(content, acc.reasoning)
    }

    private fun handleTool(envelope: WSEnvelope): StreamEvent {
        val toolName = envelope.payloadString("tool_name")
            ?: envelope.payloadString("tool")
            ?: envelope.payloadString("name")
            ?: "unknown"

        val hasOutput = envelope.payloadString("output") != null
            || envelope.payloadDict("output") != null
        val explicitId = envelope.payloadString("tool_call_id")
        val toolId = when {
            explicitId != null -> explicitId
            hasOutput -> lastToolIdByName[toolName] ?: java.util.UUID.randomUUID().toString()
            else -> java.util.UUID.randomUUID().toString()
        }
        lastToolIdByName[toolName] = toolId

        _currentPhase.value = AgentPhase.EXECUTING

        val input = extractPayloadValue(envelope, "input")
        val output = extractPayloadValue(envelope, "output")
        val durationMs = envelope.payloadInt("duration_ms")

        val statusRaw = envelope.payloadString("status")
        val isError = envelope.payloadBool("is_error") == true
            || statusRaw == "error" || statusRaw == "failed"

        val status = when {
            isError -> StepStatus.FAILED
            output != null -> StepStatus.COMPLETED
            else -> StepStatus.RUNNING
        }

        _currentToolName.value = if (status == StepStatus.RUNNING) toolName else null

        return StreamEvent.ToolCall(toolId, toolName, input, output, status, durationMs)
    }

    private fun handleStep(envelope: WSEnvelope): StreamEvent {
        val stepId = envelope.payloadString("step_id")
            ?: java.util.UUID.randomUUID().toString()
        val description = envelope.payloadString("title")
            ?: envelope.payloadString("description")
            ?: envelope.payloadString("content")
            ?: ""
        val statusStr = envelope.payloadString("status") ?: "running"
        val status = StepStatus.fromString(statusStr)
        return StreamEvent.StepUpdate(stepId, description, status)
    }

    private fun handleDone(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent {
        val messageId = envelope.payloadString("message_id")
        val content = envelope.payloadString("content") ?: acc.content
        _currentPhase.value = AgentPhase.DONE
        _currentToolName.value = null
        return StreamEvent.Done(
            messageId = messageId,
            content = content,
            taskId = envelope.payloadString("task_id"),
            sourceClientEventId = envelope.payloadString("source_client_event_id"),
            isError = envelope.payloadBool("error") == true,
            errorClass = envelope.payloadString("error_class"),
            suggestedAction = envelope.payloadString("suggested_action"),
            errorCategory = envelope.payloadString("error_category"),
            errorCode = envelope.payloadString("error_code"),
            errorMessage = envelope.payloadString("error_message"),
            stopReason = envelope.payloadString("stop_reason") ?: acc.stopReason,
            // ：chat.cancel(withdraw) 后服务端可能随 done 下发删除确认。
            withdrawApplied = envelope.payloadBool("withdraw_applied"),
        )
    }

    private fun handleObservedUser(envelope: WSEnvelope): StreamEvent? {
        // 内部 Context（环境快照 / Agent Profile）允许落库供 LLM 重建历史，但不能在直播
        // 期间闪成一条「用户发的」气泡；与历史 / Room 缓存的 ChatMessage.isInternalContext 对齐。
        val content = envelope.payloadString("content") ?: envelope.payloadString("text")
        if (ChatMessage.isInternalContextMessage(envelope.payloadString("message_kind"), content)) return null
        val triggeredBy = envelope.payloadString("triggered_by")?.takeIf { it.isNotBlank() }
        // 纯子代理完成 push：对齐 Electron fold_into_card，主时间线不新增元素。
        if (PushNotificationVisibility.shouldHideFromTimeline(triggeredBy, content)) return null
        val clientEventId = envelope.payloadString("client_event_id")?.takeIf { it.isNotBlank() }
        val serverMessageId = envelope.payloadString("message_id")?.takeIf { it.isNotBlank() }
        val id = clientEventId
            ?: serverMessageId
            ?: envelope.eventId
            ?: return null
        val userContent = content ?: return null
        return if (userContent.isBlank()) null else StreamEvent.ObservedUserMessage(
            id = id,
            content = userContent,
            clientEventId = clientEventId,
            serverMessageId = serverMessageId,
            senderUserId = envelope.payloadString("sender_user_id"),
            senderDisplayName = envelope.payloadString("sender_display_name"),
            triggeredBy = triggeredBy,
        )
    }

    private fun handleMessagePersisted(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent {
        val messageId = envelope.payloadString("message_id") ?: ""
        val content = envelope.payloadString("content") ?: acc.content
        val messageIds = (envelope.payload["message_ids"] as? JsonArray)
            ?.mapNotNull { item ->
                val obj = item as? JsonObject ?: return@mapNotNull null
                val clientEventId = obj.jsonString("client_event_id")?.takeIf { it.isNotBlank() }
                    ?: return@mapNotNull null
                val serverId = obj.jsonString("server_id")?.takeIf { it.isNotBlank() }
                    ?: return@mapNotNull null
                MessageIdMapping(clientEventId = clientEventId, serverId = serverId)
            }
            .orEmpty()
        return StreamEvent.MessagePersisted(messageId, content, messageIds)
    }

    private fun handleMessageCommitted(envelope: WSEnvelope): StreamEvent {
        return StreamEvent.MessageCommitted(
            messageId = envelope.payloadString("message_id") ?: "",
            serverId = envelope.payloadString("server_id"),
            partial = envelope.payloadBool("partial") ?: false,
        )
    }

    /**
     * Wave 6 S7 — subagent_started payload 解析。
     *
     * 协议字段（agent-wire `SubagentStartedEventPayloadSchema`）：
     *   subagent_run_id: string  首选；老服务端用 subagent_id
     *   label: string            展示名
     *   task: string             完整任务描述
     *   started_at: number       Unix 时间戳（秒 or 毫秒）
     *   name: string             向后兼容（旧协议字段，等价 label）
     */
    private fun handleSubagentStarted(envelope: WSEnvelope): StreamEvent {
        val subId = envelope.payloadString("subagent_run_id")
            ?: envelope.payloadString("subagent_id")
            ?: java.util.UUID.randomUUID().toString()
        val label = firstNonBlank(
            envelope.payloadString("label"),
            envelope.payloadString("title"),
            envelope.payloadString("description"),
            envelope.payloadString("name"),
        )
        val task = firstNonBlank(
            envelope.payloadString("task"),
            envelope.payloadString("prompt"),
        )
        val startedAt = envelope.payloadString("started_at")?.toDoubleOrNull()
        // 源 B 顶替锚点：父 LLM tool_use(agent) 块 id（= 源 A content_block_start 的 block.id，
        // 见 agent-tool.ts:818）。缺失（legacy 服务端）时为 null，ViewModel 退回按 runId 建卡。
        val parentToolCallId = envelope.payloadString("parent_tool_call_id")
            ?.takeIf { it.isNotBlank() }
        return StreamEvent.SubagentStarted(subId, label, task, startedAt, parentToolCallId)
    }

    /**
     * subagent_queued payload 解析（agent-wire `SubagentQueuedEventPayloadSchema`）：
     *   subagent_run_id: string  首选；老服务端用 subagent_id
     *   label / task: string     可选展示信息
     * 排队态只在「尚未开跑」时生效，降级防御在 SubagentCardReducer.applyQueued。
     */
    private fun handleSubagentQueued(envelope: WSEnvelope): StreamEvent {
        val subId = envelope.payloadString("subagent_run_id")
            ?: envelope.payloadString("subagent_id")
            ?: java.util.UUID.randomUUID().toString()
        val label = firstNonBlank(
            envelope.payloadString("label"),
            envelope.payloadString("title"),
            envelope.payloadString("description"),
            envelope.payloadString("name"),
        )
        val task = firstNonBlank(
            envelope.payloadString("task"),
            envelope.payloadString("prompt"),
        )
        // 与 subagent_started 同源：agent-tool.ts emit SUBAGENT_QUEUED 时也带 parent_tool_call_id。
        val parentToolCallId = envelope.payloadString("parent_tool_call_id")
            ?.takeIf { it.isNotBlank() }
        return StreamEvent.SubagentQueued(subId, label, task, parentToolCallId)
    }

    /**
     * 源 A 窄接：从 `content_block_start` 里识别子 Agent 派发块做乐观卡。
     *
     * envelope 形态（daemon `envelope-emitter.ts` → Django relay 透传）：
     *   `{ type: 'agent.stream.content_block_start', payload: { index, block_id, block: {...} } }`
     * 只对 `block.type=='tool_use' && block.name∈{agent,task,Task}` 生效，其余块（text /
     * thinking / 普通工具 tool_use / tabtin_rich_content 等）一律忽略——返回 null，不碰主对话。
     *
     * **锚点红线**：用 `block.id`（LLM 原生 toolu_ / call_ 前缀 id），**不是** envelope 的
     * `block_id`（daemon React key）——前者才与 `SUBAGENT_STARTED.parent_tool_call_id` 同值。
     */
    private fun handleContentBlockStart(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        val block = envelope.payloadDict("block") ?: return null
        val blockType = (block["type"] as? JsonPrimitive)?.contentOrNull
        if (blockType != "tool_use") return null
        val name = (block["name"] as? JsonPrimitive)?.contentOrNull
        if (name == null || name !in SUBAGENT_TOOL_NAMES) return null
        val toolCallId = (block["id"] as? JsonPrimitive)?.contentOrNull
            ?.takeIf { it.isNotBlank() }
            ?: return null
        val startInput = block["input"] as? JsonObject
        // check_agent_id 派发排除：`agent(check_agent_id=...)` 只查状态、不派新子 Agent，
        // 不该合成乐观卡（对齐 iOS/Electron `isSubagentDispatchInput`）。start 时 input
        // 已带 check_agent_id 就直接跳过（返回 null → 落主时间线普通工具卡）；流式 input
        // 后到时由 content_block_stop 反查撤卡（见 subagentBlocksByKey / handleContentBlockStop）。
        if (isSubagentCheckInput(startInput)) return null
        // 记 blockKey，供 content_block_stop 用最终累积 input 反查 check 调用。
        val messageId = envelope.payloadString("message_id") ?: acc.currentMessageId
        val index = envelope.payloadInt("index") ?: 0
        val blockKey = blockKey(messageId, index)
        acc.subagentBlocksByKey[blockKey] = toolCallId
        // start 自带 input 时先播种，让 stop 反查即使无 delta 也有据可依。
        if (startInput != null) {
            acc.toolInputsByBlock[blockKey] = jsonElementToString(startInput)
        }
        // 防御性提取任务摘要：Anthropic 流式 tool_use 块 start 时 input 多半为空（靠
        // input_json_delta 累积），但若 start 自带 input 就顺手用；否则留 null 等源 B 的 task。
        val task = extractSubagentTask(startInput)
        return StreamEvent.SubagentOptimisticStarted(toolCallId, task)
    }

    /**
     * 判断子 Agent 派发工具的 input 是否为纯状态查询（`check_agent_id` 非空）。
     * 对齐 iOS `isSubagentDispatchInput` 反义：派发 / 续跑返回 false，纯 check 返回 true。
     */
    private fun isSubagentCheckInput(input: JsonObject?): Boolean {
        val checkId = (input?.get("check_agent_id") as? JsonPrimitive)?.contentOrNull
        return !checkId.isNullOrBlank()
    }

    /** 从累积的 input JSON 字符串里判断是否 check 调用（stop 时反查用）。 */
    private fun isSubagentCheckInputJson(raw: String?): Boolean {
        if (raw.isNullOrBlank()) return false
        val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return false
        return isSubagentCheckInput(obj)
    }

    private fun handleMessageStart(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent {
        val messageId = envelope.payloadString("message_id")
        acc.currentMessageId = messageId
        // 新消息开始时清掉上一轮残留的 stop_reason，避免串到本条。
        acc.stopReason = null
        return StreamEvent.MessageStarted(
            messageId = messageId,
            agentId = envelope.payloadString("agent_id"),
            runId = envelope.payloadString("run_id"),
            modelId = envelope.payloadString("model_id"),
            modelName = envelope.payloadString("model_name"),
            sourceClientEventId = envelope.payloadString("source_client_event_id"),
            // 后台命令终态合成的 mini-message 带 role="user"，投影层据此不建气泡。
            role = envelope.payloadString("role"),
        )
    }

    /**
     * ：Anthropic 协议把 stop_reason 放在 message_delta.delta.stop_reason。
     * 只累积信号，不单独投影 UI 事件；由随后的 message_stop / done 写入消息模型。
     */
    private fun handleMessageDelta(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        val delta = envelope.payloadDict("delta")
        val stopReason = (delta?.get("stop_reason") as? JsonPrimitive)?.contentOrNull
            ?: envelope.payloadString("stop_reason")
        if (!stopReason.isNullOrBlank()) {
            acc.stopReason = stopReason
        }
        return null
    }

    private fun handleMessageStop(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent {
        val messageId = envelope.payloadString("message_id") ?: acc.currentMessageId
        val errorInfo = envelope.payloadDict("error_info")
        val errorClass = (errorInfo?.get("error_class") as? JsonPrimitive)?.contentOrNull
            ?.takeIf { it.isNotBlank() }
        val errorCategory = (errorInfo?.get("category") as? JsonPrimitive)?.contentOrNull
            ?.takeIf { it.isNotBlank() }
        val stopReason = acc.stopReason
            ?: envelope.payloadString("stop_reason")
            ?: when {
                errorClass.equals("ABORT", ignoreCase = true) -> "aborted"
                errorCategory.equals("aborted", ignoreCase = true) -> "aborted"
                else -> null
            }
        return StreamEvent.MessageStopped(
            messageId = messageId,
            persistedId = envelope.payloadString("persisted_id"),
            stopReason = stopReason,
            errorClass = errorClass,
            errorCategory = errorCategory,
        )
    }

    private fun handleContentBlockStartForMainTimeline(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        val block = envelope.payloadDict("block") ?: envelope.payloadDict("content_block") ?: return null
        val messageId = envelope.payloadString("message_id") ?: acc.currentMessageId
        val index = envelope.payloadInt("index") ?: 0
        val blockKey = blockKey(messageId, index)
        return when ((block["type"] as? JsonPrimitive)?.contentOrNull) {
            "text" -> {
                acc.blockKinds[blockKey] = "text"
                val text = (block["text"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                if (text.isBlank()) null else StreamEvent.TextBlockDelta(messageId, index, text)
            }
            "thinking" -> {
                acc.blockKinds[blockKey] = "thinking"
                val thinking = (block["thinking"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                if (thinking.isBlank()) null else StreamEvent.ThinkingBlockDelta(messageId, index, thinking)
            }
            "tool_use" -> {
                val toolCallId = (block["id"] as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() }
                    ?: "tool-$index"
                val name = (block["name"] as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() }
                    ?: toolCallId
                val input = (block["input"] as? JsonObject)?.let { jsonElementToString(it) }
                acc.blockKinds[blockKey] = "tool_use"
                acc.toolMetaByBlock[blockKey] = toolCallId to name
                if (!input.isNullOrBlank()) acc.toolInputsByBlock[blockKey] = input
                StreamEvent.ToolUseBlockStarted(
                    messageId = messageId,
                    index = index,
                    toolCallId = toolCallId,
                    name = name,
                    input = input,
                )
            }
            "server_tool_use" -> {
                // Web Search 的服务端工具调用和普通 tool_use 共用一张紧凑工具卡。
                val toolCallId = (block["id"] as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() } ?: "server-tool-$index"
                val name = (block["name"] as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() } ?: "web_search"
                val input = (block["input"] as? JsonObject)?.let(::jsonElementToString)
                acc.blockKinds[blockKey] = "tool_use"
                acc.toolMetaByBlock[blockKey] = toolCallId to name
                if (!input.isNullOrBlank()) acc.toolInputsByBlock[blockKey] = input
                StreamEvent.ToolUseBlockStarted(messageId, index, toolCallId, name, input)
            }
            "tool_result" -> {
                val toolUseId = (block["tool_use_id"] as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() }
                    ?: return null
                val output = block["content"]?.let { jsonElementToString(it) }
                val isError = (block["is_error"] as? JsonPrimitive)?.booleanOrNull == true
                val (presentationKind, presentationPrompt) = parseToolResultPresentation(block)
                acc.blockKinds[blockKey] = "tool_result"
                StreamEvent.ToolResultBlock(
                    messageId = messageId,
                    index = index,
                    toolUseId = toolUseId,
                    output = output,
                    isError = isError,
                    presentationKind = presentationKind,
                    presentationPrompt = presentationPrompt,
                )
            }
            "web_search_tool_result" -> {
                // 回填对应 server_tool_use；不映射为 RichContentBlock，避免出现独立 artifact。
                val toolUseId = (block["tool_use_id"] as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() } ?: return null
                acc.blockKinds[blockKey] = "tool_result"
                StreamEvent.ToolResultBlock(
                    messageId = messageId,
                    index = index,
                    toolUseId = toolUseId,
                    output = block["content"]?.let(::jsonElementToString),
                    isError = false,
                )
            }
            "tabtin_rich_content", "rich_content" -> {
                acc.blockKinds[blockKey] = "rich_content"
                StreamEvent.RichContentBlockReceived(messageId, index, decodeRichContentBlock(block))
            }
            "tabtin_source_ref" -> {
                acc.blockKinds[blockKey] = "context_ref"
                StreamEvent.ContextRefBlockReceived(messageId, index, contextRefBlockFrom(block))
            }
            "image" -> {
                acc.blockKinds[blockKey] = "attachment"
                StreamEvent.AttachmentBlockReceived(messageId, index, imageBlockFrom(block))
            }
            "document" -> {
                acc.blockKinds[blockKey] = "attachment"
                StreamEvent.AttachmentBlockReceived(messageId, index, documentBlockFrom(block))
            }
            else -> null
        }
    }

    private fun handleContentBlockDelta(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        val delta = envelope.payloadDict("delta") ?: return null
        val messageId = envelope.payloadString("message_id") ?: acc.currentMessageId
        val index = envelope.payloadInt("index") ?: 0
        val blockKey = blockKey(messageId, index)
        return when ((delta["type"] as? JsonPrimitive)?.contentOrNull) {
            "text_delta" -> {
                val text = (delta["text"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                if (text.isEmpty()) null else StreamEvent.TextBlockDelta(messageId, index, text)
            }
            "connector_text_delta" -> {
                val text = (delta["connector_text"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                if (text.isEmpty()) null else StreamEvent.TextBlockDelta(messageId, index, text)
            }
            "thinking_delta" -> {
                val thinking = (delta["thinking"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                if (thinking.isEmpty()) null else StreamEvent.ThinkingBlockDelta(messageId, index, thinking)
            }
            "input_json_delta" -> {
                val partial = (delta["partial_json"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                if (partial.isEmpty()) return null
                val merged = acc.toolInputsByBlock[blockKey].orEmpty() + partial
                acc.toolInputsByBlock[blockKey] = merged
                val (toolCallId, name) = acc.toolMetaByBlock[blockKey] ?: return null
                StreamEvent.ToolUseBlockUpdated(
                    messageId = messageId,
                    index = index,
                    toolCallId = toolCallId,
                    name = name,
                    input = merged,
                )
            }
            "citations_delta" -> {
                val citation = delta["citation"] ?: return null
                StreamEvent.CitationBlockDelta(messageId, index, citation)
            }
            else -> null
        }
    }

    private fun handleContentBlockStop(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        val index = envelope.payloadInt("index") ?: return null
        val messageId = envelope.payloadString("message_id") ?: acc.currentMessageId
        val blockKey = blockKey(messageId, index)
        // 源 A 乐观子 Agent 派发块收尾：若最终累积 input 判定为 check_agent_id 查询，撤掉
        // 仍处于乐观态的卡（真实派发不会命中，等 subagent_started 升级即可）。
        acc.subagentBlocksByKey[blockKey]?.let { toolCallId ->
            acc.subagentBlocksByKey.remove(blockKey)
            if (isSubagentCheckInputJson(acc.toolInputsByBlock[blockKey])) {
                return StreamEvent.SubagentDispatchDismissed(toolCallId)
            }
            return null
        }
        val kind = acc.blockKinds[blockKey]
        return when (kind) {
            "tool_use" -> {
                val (toolCallId, name) = acc.toolMetaByBlock[blockKey] ?: return null
                StreamEvent.ToolUseBlockCompleted(
                    messageId = messageId,
                    index = index,
                    toolCallId = toolCallId,
                    name = name,
                    input = acc.toolInputsByBlock[blockKey],
                )
            }
            "thinking" -> StreamEvent.ThinkingBlockDelta(
                messageId = messageId,
                index = index,
                text = "",
                completed = true,
            )
            else -> null
        }
    }

    private fun blockKey(messageId: String?, index: Int): String = "${messageId.orEmpty()}:$index"

    private fun contextRefBlockFrom(block: JsonObject): BlockItem {
        val snapshot = block["snapshot"] as? JsonObject
        val kind = stringFrom(block, "ref_kind") ?: stringFrom(snapshot, "kind") ?: "web"
        return when (kind) {
            "doc" -> BlockItem(
                type = "doc_selection",
                docId = stringFrom(snapshot, "doc_id"),
                preview = stringFrom(snapshot, "preview"),
                resourceName = stringFrom(snapshot, "title") ?: stringFrom(snapshot, "doc_id"),
            )
            "table" -> BlockItem(
                type = "table_selection",
                tableId = stringFrom(snapshot, "table_id"),
                preview = stringFrom(snapshot, "csv_preview"),
                resourceName = stringFrom(snapshot, "title") ?: stringFrom(snapshot, "table_id"),
            )
            "code" -> BlockItem(
                type = "code_file",
                filename = stringFrom(snapshot, "file_path"),
                preview = stringFrom(snapshot, "code_excerpt"),
                resourceName = stringFrom(snapshot, "file_path"),
            )
            "memo" -> BlockItem(
                type = "memo",
                resourceId = stringFrom(snapshot, "memo_id"),
                preview = stringFrom(snapshot, "preview"),
                resourceName = stringFrom(snapshot, "memo_id"),
            )
            else -> BlockItem(
                type = "web",
                url = stringFrom(snapshot, "url"),
                preview = stringFrom(snapshot, "selected_text") ?: stringFrom(snapshot, "preview"),
                resourceName = stringFrom(snapshot, "title") ?: stringFrom(snapshot, "url"),
            )
        }
    }

    private fun imageBlockFrom(block: JsonObject): BlockItem {
        val source = block["source"] as? JsonObject
        return BlockItem(
            type = "image",
            url = stringFrom(source, "url"),
            fileId = stringFrom(source, "file_id"),
            mimeType = stringFrom(source, "media_type"),
            altText = stringFrom(block, "alt_text"),
        )
    }

    private fun documentBlockFrom(block: JsonObject): BlockItem {
        val source = block["source"] as? JsonObject
        return BlockItem(
            type = "file",
            url = stringFrom(source, "url"),
            fileId = stringFrom(source, "file_id"),
            filename = stringFrom(block, "title"),
            mimeType = stringFrom(source, "media_type"),
        )
    }

    private fun stringFrom(obj: JsonObject?, key: String): String? =
        (obj?.get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun intFrom(obj: JsonObject?, key: String): Int? =
        obj?.get(key).toIntLenient()

    private fun longFrom(obj: JsonObject?, key: String): Long? =
        obj?.get(key).toDoubleLenient()?.toLong()

    private fun jsonArrayFrom(obj: JsonObject?, key: String): List<JsonElement>? =
        (obj?.get(key) as? JsonArray)?.toList()

    private fun extractSubagentTask(input: JsonObject?): String? {
        if (input == null) return null
        return (input["prompt"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: (input["description"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: (input["task"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
    }

    /**
     * Wave 6 S7 — subagent_completed payload 解析。
     *
     * 协议字段（agent-wire `SubagentCompletedEventPayloadSchema`）：
     *   subagent_run_id: string
     *   label, task: string
     *   summary: string          向用户展示的完成摘要
     *   ended_at: number
     *   result: string           旧协议字段，被 summary 取代但保留兼容
     */
    private fun handleSubagentCompleted(envelope: WSEnvelope): StreamEvent {
        val subId = envelope.payloadString("subagent_run_id")
            ?: envelope.payloadString("subagent_id")
            ?: ""
        val label = firstNonBlank(
            envelope.payloadString("label"),
            envelope.payloadString("title"),
            envelope.payloadString("description"),
            envelope.payloadString("name"),
        )
        val task = firstNonBlank(
            envelope.payloadString("task"),
            envelope.payloadString("prompt"),
        )
        val summary = envelope.payloadString("summary") ?: envelope.payloadString("result")
        val endedAt = envelope.payloadString("ended_at")?.toDoubleOrNull()
        val stats = parseSubagentStats(envelope.payload["stats"])
        return StreamEvent.SubagentCompleted(subId, label, task, summary, endedAt, stats)
    }

    private fun handleSubagentFailed(envelope: WSEnvelope): StreamEvent {
        val subId = envelope.payloadString("subagent_run_id")
            ?: envelope.payloadString("subagent_id")
            ?: java.util.UUID.randomUUID().toString()
        val task = firstNonBlank(
            envelope.payloadString("task"),
            envelope.payloadString("prompt"),
        )
        val label = firstNonBlank(
            envelope.payloadString("label"),
            envelope.payloadString("title"),
            envelope.payloadString("description"),
            envelope.payloadString("name"),
            task,
        ).orEmpty()
        val error = envelope.payloadString("error") ?: ""
        val endedAt = envelope.payloadString("ended_at")?.toDoubleOrNull()
        val status = envelope.payloadString("status") ?: "error"
        val failureType = when (status) {
            "cancelled" -> SubagentFailureType.CANCELLED
            "timeout" -> SubagentFailureType.TIMEOUT
            else -> SubagentFailureType.ERROR
        }
        // Wave 6 跨端协议验证：SUBAGENT_FAILED 也带 stats（agent-tool.ts 行 660-669），
        // 与 iOS 的修复同步——即使失败也要保留 token / credits / duration 透明度。
        val stats = parseSubagentStats(envelope.payload["stats"])
        return StreamEvent.SubagentFailed(subId, label, task, error, failureType, endedAt, stats)
    }

    /**
     * 解析 `subagent_completed` / `subagent_failed` 载荷里的 `stats` 子对象。
     * 字段集对齐 `packages/agent-runtime/src/engine/agent-tool.ts SUBAGENT_COMPLETED` /
     * `_FAILED` 与 Electron `SubagentCardData.stats`，所有字段都允许缺失。
     *
     * 鲁棒解析：服务端 stats 可能以 Int / Double / 字符串数字三种 JSON 形态推送，
     * 用 [JsonElement.toIntLenient] / [JsonElement.toDoubleLenient] 兜住，避免
     * `Double(0.0)` / `"123"` 这种来源被误丢。
     *
     * 空 stats 不返回 placeholder，保持 null，让 UI 跳过 stats row（与 iOS isEmpty 同口径）。
     */
    private fun parseSubagentStats(raw: JsonElement?): SubagentRunStats? {
        val obj = raw as? JsonObject ?: return null
        val stats = SubagentRunStats(
            durationMs = obj["duration_ms"].toIntLenient(),
            inputTokens = obj["input_tokens"].toIntLenient(),
            outputTokens = obj["output_tokens"].toIntLenient(),
            totalTokens = obj["total_tokens"].toIntLenient(),
            creditsConsumed = obj["credits_consumed"].toDoubleLenient(),
        )
        return if (stats.isEmpty) null else stats
    }

    /**
     * Wave 6 S7 — subagent_progress payload 解析。
     *
     * 协议字段（agent-wire `SubagentProgressEventPayloadSchema`）：
     *   subagent_run_id: string
     *   latest_tool: string
     *   step_count: int
     *   latest_success: bool
     *   elapsed_ms: int
     *   tool_history: [{tool_name, tool_call_id?, success, elapsed_ms,
     *                   input_summary?, output_summary?, input_detail?, output_detail?, error?}]
     */
    private fun handleSubagentProgress(envelope: WSEnvelope): StreamEvent {
        val subId = envelope.payloadString("subagent_run_id")
            ?: envelope.payloadString("subagent_id")
            ?: java.util.UUID.randomUUID().toString()
        val latestTool = envelope.payloadString("latest_tool")
        val stepCount = envelope.payloadInt("step_count")
            ?: envelope.payloadString("step_count")?.toIntOrNull()
        val latestSuccess = envelope.payloadBool("latest_success")
        val elapsedMs = envelope.payloadInt("elapsed_ms")
            ?: envelope.payloadString("elapsed_ms")?.toIntOrNull()
        val toolHistory = parseSubagentToolHistory(envelope.payload["tool_history"])
        return StreamEvent.SubagentProgress(
            id = subId,
            latestTool = latestTool,
            stepCount = stepCount,
            latestSuccess = latestSuccess,
            elapsedMs = elapsedMs,
            toolHistory = toolHistory,
        )
    }

    /**
     * ：把带 `subagent_run_id` 的 raw `agent.stream.*` 改写为
     * [StreamEvent.SubagentStreamEvent]，使用该 run 独立 accumulator，不碰父 acc。
     */
    private fun mapIsolatedSubagentStream(envelope: WSEnvelope): StreamEvent.SubagentStreamEvent? {
        val runId = SubagentStreamRouting.subagentRunId(envelope) ?: return null
        val acc = subagentAccumulators.getOrPut(runId) { StreamAccumulator() }
        val childSeq = envelope.seq ?: envelope.payloadInt("_seq")
        if (childSeq == 1) {
            acc.reset()
        }
        val childEvent = mapEnvelopeToEvent(normalizeEventType(envelope.type), envelope, acc)
            ?: return null
        val chain = (envelope.payload["subagent_chain"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?.takeIf { it.isNotEmpty() }
            ?: listOf(runId)
        return StreamEvent.SubagentStreamEvent(
            runId = runId,
            parentRunId = envelope.payloadString("parent_run_id"),
            subagentChain = chain,
            childEvent = childEvent,
        )
    }

    private fun handleSubagentStreamEvent(envelope: WSEnvelope): StreamEvent? {
        val runId = envelope.payloadString("subagent_run_id")
            ?: envelope.payloadString("subagent_id")
            ?: return null
        val child = envelope.payloadDict("child_event") ?: return null
        val childType = child.jsonString("type")?.takeIf { it.isNotBlank() } ?: return null
        val childPayload = child["payload"] as? JsonObject ?: JsonObject(emptyMap())
        val childEnvelope = WSEnvelope(
            type = childType,
            requestId = child.jsonString("request_id") ?: envelope.requestId,
            ts = envelope.ts,
            deviceId = envelope.deviceId,
            role = envelope.role,
            payload = childPayload,
            eventId = envelope.eventId,
            topic = envelope.topic,
            replyTo = envelope.replyTo,
            threadId = child.jsonString("thread_id") ?: envelope.threadId,
            traceId = child.jsonString("trace_id") ?: envelope.traceId,
            organizationId = envelope.organizationId,
            sessionId = child.jsonString("session_id") ?: envelope.sessionId,
            tableId = envelope.tableId,
            instanceId = envelope.instanceId,
            seq = child["seq"].toIntLenient() ?: child["_seq"].toIntLenient(),
        )
        val acc = subagentAccumulators.getOrPut(runId) { StreamAccumulator() }
        if (childEnvelope.seq == 1) {
            acc.reset()
        }
        val childEvent = mapEnvelopeToEvent(normalizeEventType(childType), childEnvelope, acc)
            ?: return null
        val chain = (envelope.payload["subagent_chain"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?.takeIf { it.isNotEmpty() }
            ?: listOf(runId)
        return StreamEvent.SubagentStreamEvent(
            runId = runId,
            parentRunId = envelope.payloadString("parent_run_id"),
            subagentChain = chain,
            childEvent = childEvent,
        )
    }

    /**
     * tool_history 解析。非数组 → 返回空 list；ViewModel 层不用空历史覆盖已有。
     * 字段缺失走 safe default（success=true、elapsed_ms=0、其它 null）。
     */
    private fun parseSubagentToolHistory(
        raw: JsonElement?,
    ): List<SubagentToolStep> {
        val arr = raw as? JsonArray ?: return emptyList()
        return arr.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val toolName = (obj["tool_name"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            SubagentToolStep(
                toolName = toolName,
                toolCallId = (obj["tool_call_id"] as? JsonPrimitive)?.contentOrNull,
                success = (obj["success"] as? JsonPrimitive)?.booleanOrNull ?: true,
                // Wave 6 跨端协议验证 polish：JSON 反序列化可能把整数解成 Double / 字符串，
                // 直接 `toIntOrNull(content)` 在 0.0 / "42" 等来源上会变 0/null，
                // 进而显示为 0ms。用 [toIntLenient] 兜住。
                elapsedMs = obj["elapsed_ms"].toIntLenient() ?: 0,
                inputSummary = (obj["input_summary"] as? JsonPrimitive)?.contentOrNull,
                outputSummary = (obj["output_summary"] as? JsonPrimitive)?.contentOrNull,
                inputDetail = (obj["input_detail"] as? JsonPrimitive)?.contentOrNull,
                outputDetail = (obj["output_detail"] as? JsonPrimitive)?.contentOrNull,
                error = (obj["error"] as? JsonPrimitive)?.contentOrNull,
            )
        }
    }

    private fun handleSystemNotice(envelope: WSEnvelope): StreamEvent? {
        val noticeType = envelope.payloadString("notice_type")
        // tool_* lifecycle 由 [handleToolLifecycleNotice] 接管，避免落成 SYSTEM_NOTICE 文本行。
        if (noticeType != null && isToolLifecycleNoticeType(noticeType)) return null
        val content = envelope.payloadString("content")
        if (content.isNullOrBlank()) return null
        val cleaned = content
            .replace(Regex("^>\\s*", RegexOption.MULTILINE), "")
            .replace(Regex("\\n+"), " ")
            .trim()
        return StreamEvent.SystemNotice(
            "system-notice-${System.currentTimeMillis()}",
            cleaned,
            noticeType,
        )
    }

    /**
     * 对齐 Electron `toolLifecycleNotice`：从 system_notice tool_* 早早透传 presentation，
     * 以便文生图在 tool_result 之前就能显示「生成中」。
     */
    private fun handleToolLifecycleNotice(envelope: WSEnvelope): StreamEvent? {
        val noticeType = envelope.payloadString("notice_type") ?: return null
        if (!isToolLifecycleNoticeType(noticeType)) return null

        val toolCallId = envelope.payloadString("tool_call_id")?.takeIf { it.isNotBlank() }
            ?: return null
        val toolName = envelope.payloadString("tool_name")?.takeIf { it.isNotBlank() }
            ?: "unknown"

        val status = when (noticeType) {
            "tool_started", "tool_pre_started_exec_started", "tool_progress" -> StepStatus.RUNNING
            "tool_failed", "tool_pre_started_exec_failed" -> StepStatus.FAILED
            "tool_completed", "tool_pre_started_exec_completed" -> StepStatus.COMPLETED
            else -> StepStatus.RUNNING
        }

        val output = when (noticeType) {
            "tool_progress" -> envelope.payloadString("stdout")
            else -> extractPayloadValue(envelope, "output")
                ?: envelope.payloadString("output_summary")
                ?: envelope.payloadString("error_message")
                ?: envelope.payloadString("error")
        }
        val (presentationKind, presentationPrompt) = parseToolResultPresentation(envelope.payload)
        val input = extractPayloadValue(envelope, "input")

        _currentPhase.value = AgentPhase.EXECUTING
        _currentToolName.value = if (status == StepStatus.RUNNING) toolName else null
        lastToolIdByName[toolName] = toolCallId

        return StreamEvent.ToolCall(
            id = toolCallId,
            name = toolName,
            input = input,
            output = output,
            status = status,
            durationMs = envelope.payloadInt("duration_ms"),
            presentationKind = presentationKind,
            presentationPrompt = presentationPrompt,
        )
    }

    private fun isToolLifecycleNoticeType(noticeType: String): Boolean =
        noticeType == "tool_started" ||
            noticeType == "tool_pre_started_exec_started" ||
            noticeType == "tool_progress" ||
            noticeType == "tool_completed" ||
            noticeType == "tool_pre_started_exec_completed" ||
            noticeType == "tool_failed" ||
            noticeType == "tool_pre_started_exec_failed"

    private fun handleContextPressure(envelope: WSEnvelope): StreamEvent {
        val level = envelope.payloadString("level") ?: "warning"
        Log.w(TAG, "Context pressure: level=$level")
        val content = if (level == "critical") {
            context.getString(R.string.stream_context_pressure_critical)
        } else {
            context.getString(R.string.stream_context_pressure_warning)
        }
        return StreamEvent.SystemNotice(
            "ctx-pressure-${System.currentTimeMillis()}",
            content,
            "context_pressure",
        )
    }

    private fun handleCompaction(envelope: WSEnvelope): StreamEvent? {
        val phase = envelope.payloadString("phase")?.trim().orEmpty()
        if (phase != "start" && phase != "end") {
            Log.d(TAG, "Context compaction ignored phase=$phase")
            return null
        }
        return StreamEvent.Compaction(
            phase = phase,
            mode = envelope.payloadString("mode"),
        )
    }

    // W4.5 第二波 B2 物理删 `handleRichContent(envelope:)`：daemon 0 处真 emit
    // `agent.stream.rich_content` 事件，工具产出（widget / present_to_user /
    // search_results / image / file 等）统一走 ContentBlock `tabtin_rich_content`
    // 块（content_block_start + content_block_stop 配对的 detached mini-message，
    // 由 Django reassembler 落库到 ChatMessage.content_blocks_json）。
    //
    // **Android 当前流式期路径**：StreamManager 未消费 content_block_start/delta/stop
    // 6 件套——`mapEnvelopeToEvent` 中无对应分支，未知 type 落 `else: Log.d` 静默。
    // 用户在 Android 端看到富内容卡片仅来自 `done` 之后的 `message_persisted` 触发
    // 拉持久化 + ConversationViewModel 渲染。
    //
    // **既存技术债（登记 §0.6）**：上述「拉取持久化」路径依赖 BlockItem.isRichContent
    // 判别 `type == "rich_content"`，与 Django 落库 `type == "tabtin_rich_content"`
    // 不对齐——见 `AgentStreamEvent.kt` 中 `RICH_CONTENT` 注释中的 §0.6 跟踪条目。
    // Wave 6 Android 接 6 件套真流式时一并对齐。

    private fun handleTodoUpdate(envelope: WSEnvelope): StreamEvent? {
        return decodeTodoUpdatePayload(envelope.payload)
    }

    @Suppress("UNUSED_PARAMETER")
    /**
     * W4（2026-05-11）：ask_user_required 单形态处理。
     *
     * runtime 端 ask 三件套合并为单 `ask_user` 工具；wire schema strict
     * 拒绝 form_mode/fields/addons。历史 W7 时代的 fields 分支 +
     * parsePresetFields / buildFieldsFallbackDescription 等辅助函数均已删除——
     * LLM 协议层只发 questions[]。
     */
    private fun handleAskUserRequired(envelope: WSEnvelope, acc: StreamAccumulator): StreamEvent? {
        val messageId = envelope.payloadString("message_id")
        val interruptId = envelope.payloadString("interrupt_id")
        val requestId = envelope.payloadString("request_id")
        val hitlRequestId = firstNonBlank(requestId, interruptId, messageId)
        val title = envelope.payloadString("title")

        val questionsArr = envelope.payload["questions"] as? JsonArray
        if (questionsArr == null || questionsArr.isEmpty()) {
            Log.w(TAG, "askUserRequired with empty questions, ignoring")
            return null
        }

        val questions = questionsArr.mapIndexedNotNull { idx, el ->
            val obj = el as? JsonObject ?: return@mapIndexedNotNull null
            val qId = (obj["id"] as? JsonPrimitive)?.contentOrNull ?: "q-$idx"
            val text = (obj["prompt"] as? JsonPrimitive)?.contentOrNull
                ?: (obj["text"] as? JsonPrimitive)?.contentOrNull
                ?: ""
            // W4 (2026-05-11): 可选 header chip
            val header = (obj["header"] as? JsonPrimitive)?.contentOrNull
            val allowMultiple = (obj["allow_multiple"] as? JsonPrimitive)?.booleanOrNull ?: false
            val allowFreeText = (obj["allow_free_text"] as? JsonPrimitive)?.booleanOrNull ?: true
            val optionsArr = obj["options"] as? JsonArray
            val options = optionsArr?.mapIndexedNotNull { i, o ->
                val oObj = o as? JsonObject ?: return@mapIndexedNotNull null
                val oId = (oObj["id"] as? JsonPrimitive)?.contentOrNull ?: "opt-$i"
                val label = (oObj["label"] as? JsonPrimitive)?.contentOrNull ?: ""
            // W4 (2026-05-11): option.description 必填、option.preview 可选
                val description = (oObj["description"] as? JsonPrimitive)?.contentOrNull
                val preview = (oObj["preview"] as? JsonPrimitive)?.contentOrNull
                AskUserOption(oId, label, description, preview)
            } ?: emptyList()

            AskUserQuestion(qId, text, options, allowMultiple, allowFreeText, header)
        }

        _currentPhase.value = AgentPhase.DONE
        _currentToolName.value = null
        return StreamEvent.AskUser(
            messageId = messageId,
            hitlRequestId = hitlRequestId,
            questions = questions,
            title = title,
            resolutionAccess = hitlResolutionAccess(envelope),
        )
    }

    private fun hitlResolutionAccess(envelope: WSEnvelope): HitlResolutionAccess =
        HitlResolutionAccess.resolve(envelope.payload, tokenManager.userId)

    private fun firstNonBlank(vararg values: String?): String? {
        for (v in values) {
            val s = v?.trim().orEmpty()
            if (s.isNotEmpty()) return s
        }
        return null
    }

    @Suppress("UNCHECKED_CAST")
    private fun handleReviewRequired(envelope: WSEnvelope): StreamEvent {
        val threadId = envelope.payloadString("thread_id") ?: activeThreadId ?: ""
        val interruptId = envelope.payloadString("interrupt_id")
        val messageId = envelope.payloadString("message_id")
        val requestId = envelope.payloadString("request_id")
        val hitlRequestId = firstNonBlank(requestId, interruptId, messageId)
        val message = envelope.payloadString("message")

        val actionsArr = (envelope.payload["action_requests"] as? JsonArray) ?: JsonArray(emptyList())
        val actionRequests = actionsArr.mapIndexedNotNull { idx, el ->
            val obj = el as? JsonObject ?: return@mapIndexedNotNull null
            val toolName = obj.jsonString("tool_name") ?: obj.jsonString("name") ?: "unknown"
            val toolCallId = obj.jsonString("tool_call_id")
            // v0.4 W1.5：解析单条 request_id（从 wire ApprovalActionRequest）
            val actionRequestId = obj.jsonString("request_id")
            // tool_input 优先（v0.4 wire），arguments / args 兼容旧前端
            val argsObj = obj["tool_input"] as? JsonObject
                ?: obj["arguments"] as? JsonObject
                ?: obj["args"] as? JsonObject
            val argsStr = argsObj?.let { Json.encodeToString(JsonObject.serializer(), it) }
            val desc = obj.jsonString("description")
                ?: (obj["ask_hint"] as? JsonObject)?.jsonString("summary")
            ReviewActionRequest(
                id = toolCallId ?: actionRequestId ?: "action-$idx",
                toolName = toolName,
                toolCallId = toolCallId,
                arguments = argsStr,
                description = desc,
                requestId = actionRequestId,
            )
        }

        val configsArr = (envelope.payload["review_configs"] as? JsonArray) ?: JsonArray(emptyList())
        val reviewConfigs = configsArr.mapNotNull { el ->
            val obj = el as? JsonObject ?: return@mapNotNull null
            val actionName = obj.jsonString("action_name") ?: ""
            val decisions = (obj["allowed_decisions"] as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                ?: listOf("approve", "reject")
            ReviewConfig(actionName, decisions)
        }

        // v0.4 W1.5：解析 batch_id（PRD §7.4 / §7.10）
        val batchId = envelope.payloadString("batch_id")

        _currentPhase.value = AgentPhase.DONE
        _currentToolName.value = null

        return StreamEvent.ReviewRequired(
            ReviewRequestState(
                threadId = threadId,
                interruptId = interruptId,
                messageId = messageId,
                hitlRequestId = hitlRequestId,
                batchId = batchId,
                actionRequests = actionRequests,
                reviewConfigs = reviewConfigs,
                message = message,
            )
        )
    }

    private fun JsonObject.jsonString(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull

    private fun JsonObject.jsonBool(key: String): Boolean? {
        val prim = this[key] as? JsonPrimitive ?: return null
        prim.booleanOrNull?.let { return it }
        return when (prim.contentOrNull?.trim()?.lowercase()) {
            "true", "1", "yes", "required" -> true
            "false", "0", "no", "optional" -> false
            else -> null
        }
    }

    /**
     * Wave 6 跨端协议验证：把任意 JsonElement 鲁棒地解析成 Int?。
     *
     * 服务端可能用 Int / Double / 字符串数字三种形态推送数值字段——`as? Int` 在
     * `JsonPrimitive(0.0)` 或 `JsonPrimitive("42")` 上会返回 null，导致 stats /
     * tool_history.elapsed_ms 等字段被误解读为 0 或 null。
     *
     * 解析顺序（与 iOS [intFromAny] 等价）：intOrNull → doubleOrNull → toIntOrNull(string)。
     */
    private fun JsonElement?.toIntLenient(): Int? {
        val prim = this as? JsonPrimitive ?: return null
        prim.intOrNull?.let { return it }
        prim.doubleOrNull?.let { return it.toInt() }
        return prim.contentOrNull?.trim()?.toIntOrNull()
            ?: prim.contentOrNull?.trim()?.toDoubleOrNull()?.toInt()
    }

    /**
     * Wave 6 跨端协议验证：把任意 JsonElement 鲁棒地解析成 Double?。
     *
     * 与 [toIntLenient] 同思路：JSON 整数 / 浮点 / 字符串都接受。
     * `credits_consumed` 服务端按 `BudgetTracker.scope.credits` 浮点累加，但旧路径
     * 也可能落整数 0；统一兜住。
     */
    private fun JsonElement?.toDoubleLenient(): Double? {
        val prim = this as? JsonPrimitive ?: return null
        prim.doubleOrNull?.let { return it }
        prim.intOrNull?.let { return it.toDouble() }
        return prim.contentOrNull?.trim()?.toDoubleOrNull()
    }

    private fun jsonElementToString(element: JsonElement): String {
        (element as? JsonPrimitive)?.contentOrNull?.let { return it }
        return Json.encodeToString(JsonElement.serializer(), element)
    }

    /** 解析 `tool_result.presentation.{kind,data.prompt}`；缺省时返回 (null, null)。 */
    private fun parseToolResultPresentation(block: JsonObject): Pair<String?, String?> {
        val presentation = block["presentation"] as? JsonObject ?: return null to null
        val kind = (presentation["kind"] as? JsonPrimitive)?.contentOrNull
        val prompt = (presentation["data"] as? JsonObject)
            ?.get("prompt")
            .let { it as? JsonPrimitive }
            ?.contentOrNull
        return kind to prompt
    }

    public companion object {
        private const val TAG = "StreamManager"
        private const val HANDLER_KEY = "stream"
        private const val INACTIVE_STREAM_TOPIC_RETAIN_MS = 90_000L
        private const val ACTION_APPROVAL_REQUEST = "agent.action.approval_request"
        private const val ACTION_APPROVAL_RESOLVED = "agent.action.approval_resolved"
        private val ACTION_APPROVAL_EVENTS = setOf(
            ACTION_APPROVAL_REQUEST,
            ACTION_APPROVAL_RESOLVED,
        )
        private val ACTION_NAME_PATTERNS = listOf(
            Regex("""^([A-Za-z0-9_.-]+)\s*:"""),
            Regex("""请求\s+([A-Za-z0-9_.-]+)"""),
            Regex("""request\s+([A-Za-z0-9_.-]+)""", RegexOption.IGNORE_CASE),
        )

        /**
         * v0.4 W1.5-轮 4：approval_requested.allowed_scopes 的合法值
         * （与 packages/agent-wire/src/approval.ts ApprovalScopeSchema 对齐）。
         */
        private val ALLOWED_SCOPE_VALUES = setOf("once", "thread", "always")
        /**
         * v0.4 W1.5-轮 4：approval_type 的合法值（仅 tool_permission；plan_exit 已删除）。
         * plan-approval 整套已下线，新 plan 流程走 plan-execute-handler IPC，不走 HITL。
         */
        private val APPROVAL_TYPE_VALUES = setOf("tool_permission")

        /**
         * 子 Agent 派发工具名集合。`agent` 是当前 runtime 主名；`task` / `Task`
         * 为兼容别名。content_block_start 只有命中这几个工具名的 tool_use
         * 块才合成乐观子 Agent 卡。
         */
        private val SUBAGENT_TOOL_NAMES = setOf("agent", "task", "Task")
        private val APPROVAL_OUTCOME_VALUES = setOf(
            "allow",
            "deny",
            "cancelled",
            "expired",
            "cancelled_by_rollback",
        )

        // W4.5 第二波 B2 物理删 `private val RICH_CONTENT_JSON: Json` 私有常量——
        // 它原是 `handleRichContent` 的专属 lenient JSON 解码器，handler 已删。
        // BlockItem 持久化形态（type='rich_content'）的解码仍走 ApiClient 的 json
        // 实例（ignoreUnknownKeys = true / isLenient = true），不依赖本地兜底常量。

        private fun extractPayloadValue(envelope: WSEnvelope, key: String): String? {
            envelope.payloadString(key)?.let { return it }
            envelope.payloadDict(key)?.let { obj ->
                return Json.encodeToString(JsonObject.serializer(), obj)
            }
            (envelope.payload[key] as? JsonArray)?.let { arr ->
                return Json.encodeToString(JsonArray.serializer(), arr)
            }
            return null
        }

        private fun actionApprovalBatchId(approvalId: String): String = "action-$approvalId"

        private fun extractActionNameFromCommand(command: String): String? {
            if (command.isBlank()) return null
            return ACTION_NAME_PATTERNS.firstNotNullOfOrNull { pattern ->
                pattern.find(command)?.groupValues?.getOrNull(1)
            }
        }
    }
}

/** 直播和历史共用同一份正式图片资产映射语义。 */
internal fun decodeRichContentBlock(block: JsonObject): BlockItem {
    val payload = block["payload"] as? JsonObject
    val kind = jsonString(payload, "kind") ?: jsonString(block, "kind")
    val formalImage = formalOssImagePayload(kind, payload)
    return BlockItem(
        type = jsonString(block, "type") ?: "tabtin_rich_content",
        kind = kind,
        summary = jsonString(block, "summary") ?: jsonString(payload, "summary"),
        title = jsonString(payload, "title") ?: jsonString(payload, "name") ?: jsonString(payload, "filename"),
        caption = jsonString(payload, "caption"),
        columns = jsonArray(payload, "columns"),
        rows = jsonArray(payload, "rows"),
        totalRows = jsonInt(payload, "total_rows") ?: jsonInt(payload, "total"),
        resourceType = jsonString(payload, "resource_type"),
        resourceId = jsonString(payload, "resource_id") ?: jsonString(payload, "id"),
        resourceName = jsonString(payload, "resource_name") ?: jsonString(payload, "name"),
        spaceName = jsonString(payload, "space_name"),
        url = if (formalImage != null) {
            formalImage.fallbackUrl
        } else {
            jsonString(payload, "url")
                ?: jsonString(payload, "image_url")
                ?: jsonString(payload, "file_url")
                ?: jsonString(payload, "remote_url")
        },
        fileId = formalImage?.fileId ?: jsonString(payload, "file_id") ?: jsonString(payload, "fileId"),
        filename = jsonString(payload, "filename") ?: jsonString(payload, "file_name"),
        mimeType = jsonString(payload, "mime_type"),
        fileSize = jsonLong(payload, "file_size") ?: jsonLong(payload, "size"),
        widgetId = jsonString(payload, "widget_id") ?: jsonString(payload, "widgetId"),
        code = jsonString(payload, "code"),
        format = jsonString(payload, "format"),
        imageUrl = jsonString(payload, "image_url"),
        sourceCode = jsonString(payload, "source_code") ?: jsonString(payload, "sourceCode"),
        mermaidSource = jsonString(payload, "mermaid_source") ?: jsonString(payload, "mermaidSource"),
        groupId = jsonString(block, "group_id") ?: jsonString(payload, "group_id"),
        groupTitle = jsonString(payload, "group_title"),
    )
}

private fun jsonString(obj: JsonObject?, key: String): String? =
    (obj?.get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

private fun jsonInt(obj: JsonObject?, key: String): Int? =
    (obj?.get(key) as? JsonPrimitive)?.intOrNull

private fun jsonLong(obj: JsonObject?, key: String): Long? =
    (obj?.get(key) as? JsonPrimitive)?.contentOrNull?.toLongOrNull()

private fun jsonArray(obj: JsonObject?, key: String): List<JsonElement>? =
    (obj?.get(key) as? JsonArray)?.toList()

/** Runtime todo events carry the full current snapshot; closed snapshots clear the dock. */
internal fun decodeTodoUpdatePayload(payload: JsonObject): StreamEvent.TodoUpdate? {
    val todosArr = (payload["todos"] as? JsonArray)
        ?: (payload["items"] as? JsonArray)
        ?: return null
    if ((payload["closed"] as? JsonPrimitive)?.booleanOrNull == true) {
        return StreamEvent.TodoUpdate(emptyList())
    }
    val items = todosArr.mapNotNull { element ->
        val item = element as? JsonObject ?: return@mapNotNull null
        val id = (item["id"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
        val content = (item["content"] as? JsonPrimitive)?.contentOrNull ?: ""
        val status = (item["status"] as? JsonPrimitive)?.contentOrNull ?: "pending"
        AgentTodoItem(id, content, com.tabtin.mobile.data.model.TodoStatus.fromString(status))
    }
    return StreamEvent.TodoUpdate(items)
}

internal fun decodeSingleHitlResolvedEvent(envelope: WSEnvelope): StreamEvent.SingleHitlResolved? {
    val requestId = sequenceOf(
        envelope.payloadString("request_id"),
        envelope.payloadString("interrupt_id"),
    ).mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
        .firstOrNull()
        ?: return null
    return StreamEvent.SingleHitlResolved(
        requestId = requestId,
        outcome = envelope.payloadString("outcome")?.trim()?.takeIf(String::isNotEmpty),
    )
}

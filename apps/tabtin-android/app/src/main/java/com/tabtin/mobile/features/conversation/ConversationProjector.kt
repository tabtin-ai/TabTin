package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.MessageBlock
import com.tabtin.mobile.data.model.ModeSwitchProposal
import com.tabtin.mobile.data.model.PlanProposal
import com.tabtin.mobile.data.model.PushNotificationVisibility
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.StreamEvent
import com.tabtin.mobile.data.model.resolvedAskChoiceFact
import java.time.Instant
import kotlin.math.abs
import kotlinx.serialization.json.JsonPrimitive

/**
 * Message-level projection twin of iOS `ConversationProjector`.
 *
 * The ViewModel owns transport and side effects; this class owns the chat message
 * list, stream routing, optimistic bubble claiming, and history reconciliation.
 */
internal fun isEmptySystemNoticeShell(message: ChatMessage): Boolean =
    message.isSystem &&
        !message.isStreaming &&
        message.displayContent.isBlank() &&
        !message.isCompactionSummary &&
        !message.isPushNotification &&
        message.checkpointRecord == null &&
        message.errorMessage.isNullOrBlank() &&
        message.errorCategory.isNullOrBlank()

internal class ConversationProjector {
    private var _messages: MutableList<ChatMessage> = mutableListOf()
    private val bubbleForMessage = mutableMapOf<String, String>()
    private val blockProjector = ConversationBlockProjector()

    /**
     *  评审修复：被 role 守卫跳过认建的合成 mini-message id 集合。
     * 这些 id 永远没有气泡，其 message_stop / persisted / committed / done 收尾事件
     * 必须安静消费——否则 bubbleForMessage miss 让 apply 返回 false，落入 ViewModel
     * legacy 兜底 endStreamingState()：清路由表 + 重置块时间轴，把正在进行的真流式
     * 气泡拆台（下一个 delta 即把 blocksJson 塌缩成只剩该 delta 一条）。
     * 集合只随 [reset] 清空；endStreaming / 历史对账不清——迟到的合成收尾事件
     * 在新一轮流式中到达时仍须安静吞掉。
     */
    private val skippedSyntheticStartIds = mutableSetOf<String>()

    private var activeAssistantId: String? = null
    private var pendingOptimisticId: String? = null

    var phase: AgentPhase? = null
        private set
    var systemNotice: String? = null
        private set

    /**
     * 对外时间线：隐藏空壳中断 assistant（ / Electron emptyInterruptedAssistant）。
     * 内部 [_messages] 仍保留完整列表，供撤回判定等逻辑使用。
     */
    val messages: List<ChatMessage>
        get() = _messages.filterNot {
            isEmptyInterruptedAssistantShell(it) || isEmptySystemNoticeShell(it)
        }
    val isStreamingActive: Boolean get() = _messages.any { it.isStreaming }
    val hasPendingOptimistic: Boolean get() = pendingOptimisticId != null
    val oldestServerId: String?
        get() = _messages.firstOrNull { it.planProposal == null && it.modeSwitchProposal == null }?.effectiveId

    fun reset(clearMessages: Boolean = true) {
        if (clearMessages) _messages = mutableListOf()
        bubbleForMessage.clear()
        skippedSyntheticStartIds.clear()
        blockProjector.reset()
        activeAssistantId = null
        pendingOptimisticId = null
        phase = null
        systemNotice = null
    }

    fun seed(history: List<ChatMessage>) {
        if (_messages.isNotEmpty() || isStreamingActive) return
        _messages = history.mainTimelineMessages().toMutableList()
    }

    fun replaceWithHistory(
        history: List<ChatMessage>,
        allowWhileStreaming: Boolean = false,
    ): Boolean {
        val mainHistory = history.mainTimelineMessages()
        if (isStreamingActive && !allowWhileStreaming) return false
        val localCards = _messages.filter { it.planProposal != null || it.modeSwitchProposal != null }
        val realCount = _messages.size - localCards.size
        val merged = if (mainHistory.isEmpty()) {
            // 权威历史为空时不能保留陈旧的缓存气泡；仅保留本地尚未落库的 proposal 卡。
            localCards
        } else if (realCount > mainHistory.size) {
            upsertByIdentity(mainHistory, _messages)
        } else {
            val usedLocal = mutableSetOf<Int>()
            val reconciledHistory = mainHistory.map { server ->
                val match = findMatchingMessage(server, _messages, usedLocal)
                if (match != null) {
                    usedLocal.add(match.index)
                    // 收尾对账也要保住乐观 user 的更早发送时刻。服务端可能在 AI 流开始后
                    // 才持久化 user；若直接用 server.createdAt 排序，会把用户气泡甩到回复下方。
                    mergeServerMessageIntoLocal(
                        local = match.message,
                        server = server,
                        preserveOptimisticUserCreatedAt = true,
                    )
                } else {
                    server
                }
            }
            (reconciledHistory + localCards.filter { card ->
                reconciledHistory.none { it.sharesIdentityWith(card) || it.id == card.id }
            })
                .sortedWith(::compareTimeline)
        }
        if (merged == _messages) return false
        _messages = merged.toMutableList()
        rebuildBubbleRoutingFromMessages()
        blockProjector.reset()
        activeAssistantId = null
        pendingOptimisticId = null
        return true
    }

    /** 用 around 返回的连续窗口替换当前可见历史，避免拼接相隔很远的两段时间线。 */
    fun replaceWithFocusedHistory(history: List<ChatMessage>): Boolean {
        if (isStreamingActive) return false
        val focused = history.mainTimelineMessages()
        if (focused == _messages) return false
        _messages = focused.toMutableList()
        rebuildBubbleRoutingFromMessages()
        blockProjector.reset()
        activeAssistantId = null
        pendingOptimisticId = null
        return true
    }

    fun mergeCommittedHistory(history: List<ChatMessage>): Boolean {
        val mainHistory = history.mainTimelineMessages()
        if (mainHistory.isEmpty()) return false
        val merged = upsertByIdentity(
            authoritative = mainHistory,
            current = _messages,
            preserveOptimisticUserCreatedAt = true,
        )
        if (merged == _messages) return false
        _messages = merged.toMutableList()
        return true
    }

    fun prependHistory(older: List<ChatMessage>): Int {
        val mainOlder = older.mainTimelineMessages()
        if (mainOlder.isEmpty()) return 0
        val fresh = mainOlder.filter { old -> _messages.none { it.sharesIdentityWith(old) } }
        if (fresh.isEmpty()) return 0
        _messages = (fresh + _messages).sortedWith(::compareTimeline).toMutableList()
        return fresh.size
    }

    /**
     * 历史 rehydrate 写回：按 identity 把 [rehydrated] 上的 agentSteps（含 SUBAGENT 卡）
     * 合并进当前投影。不替换整条消息，避免冲掉流式态字段。
     */
    fun rehydrateSubagentSteps(rehydrated: List<ChatMessage>): Boolean {
        if (rehydrated.isEmpty()) return false
        var changed = false
        for (incoming in rehydrated) {
            val steps = incoming.agentSteps ?: continue
            if (steps.none { it.type == StepType.SUBAGENT }) continue
            val idx = _messages.indexOfFirst { it.sharesIdentityWith(incoming) }
            if (idx < 0) continue
            val current = _messages[idx]
            val mergedSteps = mergeAgentStepsPreservingLiveTranscript(current.agentSteps, steps)
            if (mergedSteps == current.agentSteps) continue
            _messages[idx] = current.copy(agentSteps = mergedSteps)
            changed = true
        }
        return changed
    }

    fun appendUserMessage(
        id: String,
        content: String,
        blocks: List<MessageBlock>?,
    ): ChatMessage {
        val msg = ChatMessage(
            id = id,
            role = "user",
            content = content,
            blocksJson = blocks?.map { it.toBlockItem() },
            clientEventId = id,
            createdAt = Instant.now().toString(),
        )
        val existingIndex = _messages.indexOfFirst { it.sharesIdentityWith(msg) }
        if (existingIndex >= 0) {
            val existing = _messages[existingIndex]
            val merged = existing.copy(
                content = content,
                blocksJson = msg.blocksJson ?: existing.blocksJson,
                clientEventId = existing.clientEventId ?: id,
            )
            _messages[existingIndex] = merged
            return merged
        }
        _messages.add(msg)
        return msg
    }

    fun appendObservedUserMessage(
        id: String,
        content: String,
        senderUserId: String? = null,
        senderDisplayName: String? = null,
        triggeredBy: String? = null,
    ) {
        if (PushNotificationVisibility.shouldHideFromTimeline(triggeredBy, content)) return
        val metadata = triggeredBy
            ?.takeIf { it.isNotBlank() }
            ?.let { mapOf("triggered_by" to JsonPrimitive(it)) }
        val observed = ChatMessage(
            id = id,
            role = "user",
            content = content,
            clientEventId = id,
            senderUserId = senderUserId,
            senderDisplayName = senderDisplayName,
            metadata = metadata,
            createdAt = Instant.now().toString(),
        )
        if (_messages.any { it.sharesIdentityWith(observed) }) return
        _messages.add(
            observed
        )
    }

    fun appendSystemMessage(id: String, content: String) {
        if (_messages.any { it.id == id }) return
        _messages.add(
            ChatMessage(
                id = id,
                role = "system",
                content = content,
                createdAt = Instant.now().toString(),
            )
        )
    }

    fun appendPlanProposal(proposal: PlanProposal) {
        val id = "plan_${proposal.planDocumentId}"
        if (_messages.any { it.id == id }) return
        _messages.add(
            ChatMessage(
                id = id,
                role = "assistant",
                planProposal = proposal,
                createdAt = Instant.now().toString(),
            )
        )
    }

    fun appendModeSwitchProposal(proposal: ModeSwitchProposal) {
        val id = "mode_${proposal.proposalId}"
        if (_messages.any { it.id == id }) return
        _messages.add(
            ChatMessage(
                id = id,
                role = "assistant",
                modeSwitchProposal = proposal,
                createdAt = Instant.now().toString(),
            )
        )
    }

    fun markProposalResolved(id: String) {
        updateById(id) { it.copy(proposalResolved = true) }
    }

    fun beginAssistant(
        id: String = "streaming-${System.currentTimeMillis()}",
        agentId: String? = null,
    ): String {
        pendingOptimisticId = id
        activeAssistantId = id
        phase = null
        val existingIndex = _messages.indexOfFirst { it.id == id }
        if (existingIndex >= 0) {
            val existing = _messages[existingIndex]
            _messages[existingIndex] = existing.copy(
                isStreaming = true,
                agentId = agentId?.takeIf { it.isNotBlank() } ?: existing.agentId,
                errorMessage = null,
                errorCategory = null,
                errorCode = null,
                errorClass = null,
                suggestedAction = null,
            )
            return id
        }
        _messages.add(
            ChatMessage(
                id = id,
                role = "assistant",
                agentId = agentId,
                isStreaming = true,
                createdAt = Instant.now().toString(),
            )
        )
        return id
    }

    fun failPendingOptimistic(message: String) {
        val opt = pendingOptimisticId ?: return
        updateById(opt) {
            it.copy(
                content = it.content.ifBlank { message },
                errorMessage = message,
                isStreaming = false,
            )
        }
        if (activeAssistantId == opt) activeAssistantId = null
        pendingOptimisticId = null
    }

    fun removeLocalTurn(userMessageId: String, assistantMessageId: String?) {
        _messages.removeAll { message ->
            message.id == userMessageId || (assistantMessageId != null && message.id == assistantMessageId)
        }
        if (assistantMessageId != null) {
            if (pendingOptimisticId == assistantMessageId) pendingOptimisticId = null
            if (activeAssistantId == assistantMessageId) activeAssistantId = null
        }
    }

    fun removeAssistantMessage(assistantMessageId: String?) {
        if (assistantMessageId == null) return
        _messages.removeAll { it.id == assistantMessageId }
        if (pendingOptimisticId == assistantMessageId) pendingOptimisticId = null
        if (activeAssistantId == assistantMessageId) activeAssistantId = null
    }

    /**
     *  / iOS `hasSubstantiveAssistantOutput`：thinking 只是内部准备，不算已经开始回复；
     * 一旦出现正文、工具或可见富内容，就只停止而不撤回用户消息。
     *
     * Android 额外认 [ChatMessage.content]（流式 TextBlockDelta 会同步写入）与
     * [ChatMessage.agentSteps] 的 TOOL_CALL，避免 blocksJson 尚未投影时误判可撤回。
     */
    fun hasSubstantiveAssistantOutput(afterUserMessageId: String): Boolean {
        val userIndex = _messages.indexOfLast { message ->
            message.isUser && (
                message.id == afterUserMessageId || afterUserMessageId in message.identityKeys
                )
        }
        if (userIndex < 0) return false
        return _messages.drop(userIndex + 1).any { message ->
            message.isAssistant && message.hasSubstantiveAssistantOutput()
        }
    }

    /**
     * 撤回本轮 user 及其后尚未形成实质回复的半截时间线。
     * 对齐 iOS `withdrawUnansweredTurn` / Electron `truncateFromMessage`；
     * 调用方须先用 [hasSubstantiveAssistantOutput] 判定为 false。
     *
     * 后端侧：与 iOS 同款，本地抽除后由调用方发 `chat.cancel` 并带
     * `withdraw_unanswered=true`（见 Django `chat_cancel` handler），不另造协议。
     */
    fun withdrawUnansweredTurn(userMessageId: String) {
        val userIndex = _messages.indexOfLast { message ->
            message.isUser && (
                message.id == userMessageId || userMessageId in message.identityKeys
                )
        }
        if (userIndex < 0) {
            endStreaming()
            return
        }
        _messages.subList(userIndex, _messages.size).clear()
        bubbleForMessage.clear()
        blockProjector.reset()
        activeAssistantId = null
        pendingOptimisticId = null
        phase = null
        systemNotice = null
    }

    fun endStreaming() {
        _messages = _messages.map { if (it.isStreaming) it.copy(isStreaming = false) else it }.toMutableList()
        bubbleForMessage.clear()
        blockProjector.reset()
        activeAssistantId = null
        pendingOptimisticId = null
        phase = null
    }

    fun assistantIdFor(event: StreamEvent): String? {
        val serverMessageId = event.streamMessageId()
        if (!serverMessageId.isNullOrBlank()) {
            bubbleForMessage[serverMessageId]?.let {
                activeAssistantId = it
                return it
            }
            if (event.shouldCreateAssistantForServerMessageId()) {
                return beginOrClaimBubble(serverMessageId)
            }
            return null
        }
        return activeAssistantId
            ?: pendingOptimisticId?.takeIf(::hasAssistant)
            ?: if (event.shouldCreateAssistantWithoutMessageId()) beginAssistant() else null
    }

    fun apply(event: StreamEvent, errorMessage: ((AppError) -> String)? = null): Boolean {
        return when (event) {
            is StreamEvent.ObservedUserMessage -> {
                appendObservedUserMessage(
                    event.id,
                    event.content,
                    event.senderUserId,
                    event.senderDisplayName,
                    event.triggeredBy,
                )
                true
            }

            is StreamEvent.LifecycleChanged -> {
                phase = event.phase
                true
            }

            is StreamEvent.MessageStarted -> {
                // ：Agent 后台命令（如文生图 CLI）终结时，客户端 relay 合成
                // role="user" 的 wire mini-message（message_start + tool_result 终态块 +
                // message_stop）。终态由 ToolResultBlock 按 toolUseId 回填既有工具卡，
                // 这里若无条件 beginOrClaimBubble 会认建出永远无内容块的幽灵 assistant
                // 气泡。对齐 Electron（仅 role=="assistant" 建气泡）：非 assistant 时，
                // 气泡已存在（重放 / 对账认领过）则照常刷新 streaming 态，否则整个跳过；
                // role 缺省保持现状以兼容未带 role 的旧事件。注意即便跳过也须返回 true
                // 消费事件——返回 false 会落入 ViewModel legacy 兜底路径再次认建气泡。
                val isAssistantStart = event.role == null || event.role == "assistant"
                val bubbleId = event.messageId
                    ?.let { messageId ->
                        if (isAssistantStart) {
                            beginOrClaimBubble(messageId, event.agentId)
                        } else {
                            // 气泡已存在（重放 / 对账认领过）则照常刷新；无泡可认领时
                            // 跳过认建并登记 id——该合成 mini-message 的收尾事件凭登记
                            // 安静消费，见 consumeSkippedSyntheticSettled。
                            bubbleForMessage[messageId].also { routed ->
                                if (routed == null) skippedSyntheticStartIds.add(messageId)
                            }
                        }
                    }
                    ?: activeAssistantId.takeIf { isAssistantStart }
                if (bubbleId != null) {
                    updateById(bubbleId) {
                        it.copy(
                            agentId = event.agentId ?: it.agentId,
                            modelName = event.modelName ?: it.modelName,
                            agentRunId = event.runId ?: it.agentRunId,
                            isStreaming = true,
                        )
                    }
                }
                true
            }

            is StreamEvent.PlanProposalReceived -> {
                appendPlanProposal(event.proposal)
                true
            }

            is StreamEvent.ModeSwitchProposalReceived -> {
                appendModeSwitchProposal(event.proposal)
                true
            }

            is StreamEvent.TextBlockDelta -> {
                updateAssistantFor(event) { assistantId, msg ->
                    val projection = blockProjector.appendText(assistantId, event.messageId, event.index, event.text, msg.blocksJson)
                    msg.copy(content = projection.content, blocksJson = projection.blocksJson, isStreaming = true)
                }
            }

            is StreamEvent.CitationBlockDelta -> {
                updateAssistantFor(event) { assistantId, msg ->
                    msg.copy(
                        blocksJson = blockProjector.appendCitation(
                            assistantId,
                            event.messageId,
                            event.index,
                            event.citation,
                            msg.blocksJson,
                        ),
                        isStreaming = true,
                    )
                }
            }

            is StreamEvent.ThinkingBlockDelta -> {
                updateAssistantFor(event) { assistantId, msg ->
                    val projection = blockProjector.appendThinking(
                        assistantId,
                        event.messageId,
                        event.index,
                        event.text,
                        msg.blocksJson,
                    )
                    msg.copy(reasoning = projection.reasoning, blocksJson = projection.blocksJson, isStreaming = true)
                }
            }

            is StreamEvent.ToolUseBlockStarted -> upsertTool(event, StepStatus.RUNNING, event.input)
            is StreamEvent.ToolUseBlockUpdated -> upsertTool(event, StepStatus.RUNNING, event.input)
            is StreamEvent.ToolUseBlockCompleted -> upsertTool(event, StepStatus.COMPLETED, event.input)

            is StreamEvent.ToolResultBlock -> {
                val target = blockProjector.toolResultTarget(event, _messages) ?: return false
                updateAssistant(target.assistantId) { msg ->
                    val existing = msg.agentSteps.orEmpty().firstOrNull { it.id == event.toolUseId }
                    val step = AgentStep(
                        id = event.toolUseId,
                        type = StepType.TOOL_CALL,
                        name = existing?.name.orEmpty(),
                        status = if (event.isError) StepStatus.FAILED else StepStatus.COMPLETED,
                        input = existing?.input,
                        output = event.output,
                        presentationKind = event.presentationKind ?: existing?.presentationKind,
                        presentationPrompt = event.presentationPrompt ?: existing?.presentationPrompt,
                    )
                    msg.copy(
                        agentSteps = msg.agentSteps.upsert(step),
                        blocksJson = blockProjector.upsertTool(
                            assistantId = target.assistantId,
                            // 回写复用命中块的原 key messageId，不用 event.messageId：
                            // tool_result 信封可能与 tool_use 分属不同消息（W4.5 跨消息
                            // 回灌、 后台命令终态 mini-message 用全新随机 id），
                            // 直接拿信封 id 做 BlockKey 会复制出第二张同 toolUseId 的
                            // 工具块——UI 每张 blocksJson tool_use 块渲染一张卡，用户会
                            // 看到原卡永远转圈 + 多一张终态卡。对齐 iOS 按 toolUseId
                            // 原地回填。index 为 null（agentSteps 兜底）时本参数不参与。
                            messageId = target.blockMessageId,
                            index = target.index,
                            step = step,
                            existing = msg.blocksJson,
                        ),
                    )
                }
            }

            is StreamEvent.RichContentBlockReceived -> upsertProjectedBlock(event, event.block)
            is StreamEvent.ContextRefBlockReceived -> upsertProjectedBlock(event, event.block)
            is StreamEvent.AttachmentBlockReceived -> upsertProjectedBlock(event, event.block)

            is StreamEvent.MessageStopped -> {
                if (consumeSkippedSyntheticSettled(event.messageId)) return true
                updateAssistantFor(event) { _, msg ->
                    val resolvedErrorClass = event.errorClass ?: msg.errorClass
                    val resolvedStopReason = event.stopReason
                        ?: msg.stopReason
                        ?: if (resolvedErrorClass.equals("ABORT", ignoreCase = true) ||
                            event.errorCategory.equals("aborted", ignoreCase = true)
                        ) {
                            "aborted"
                        } else {
                            null
                        }
                    msg.copy(
                        persistedId = event.persistedId ?: msg.persistedId,
                        stopReason = resolvedStopReason,
                        errorClass = resolvedErrorClass,
                        errorCategory = event.errorCategory ?: msg.errorCategory,
                        isStreaming = false,
                    )
                }.also { if (it) activeAssistantId = null }
            }

            is StreamEvent.MessagePersisted -> {
                if (consumeSkippedSyntheticSettled(event.messageId)) return true
                applyMessageIdMappings(event.messageIds)
                updateAssistantFor(event) { _, msg ->
                    msg.copy(persistedId = event.messageId.takeIf { it.isNotBlank() } ?: msg.persistedId, isStreaming = false)
                }.also { if (it) activeAssistantId = null }
            }

            is StreamEvent.MessageCommitted -> {
                if (consumeSkippedSyntheticSettled(event.messageId)) return true
                if (event.messageId.isBlank()) return false
                updateAssistantFor(event) { _, msg ->
                    msg.copy(
                        serverId = event.serverId ?: msg.serverId,
                        persistedId = event.serverId ?: msg.persistedId,
                    )
                }
            }

            is StreamEvent.Done -> {
                // 合成 mini-message 的 done 同样安静消费：updateAssistantFor 本就 miss，
                // 且下方无条件 endStreaming() 会把正在进行的真流式气泡一并关掉。
                if (consumeSkippedSyntheticSettled(event.messageId)) return true
                updateAssistantFor(event) { _, msg ->
                    val resolvedErrorClass = when {
                        event.isError -> event.errorClass ?: msg.errorClass
                        event.errorClass.equals("ABORT", ignoreCase = true) -> event.errorClass
                        else -> msg.errorClass
                    }
                    val isAbort = resolvedErrorClass.equals("ABORT", ignoreCase = true) ||
                        event.stopReason.equals("aborted", ignoreCase = true) ||
                        event.errorCategory.equals("aborted", ignoreCase = true)
                    val resolvedStopReason = event.stopReason
                        ?: msg.stopReason
                        ?: if (isAbort) "aborted" else null
                    val rawContent = event.content.ifEmpty { msg.content }
                    // ：ABORT 不把 runtime 英文兜底诊断写进可见正文。
                    val finalContent = if (isAbort && isRuntimeAbortDiagnostic(rawContent)) {
                        msg.content.takeUnless { isRuntimeAbortDiagnostic(it) }.orEmpty()
                    } else {
                        rawContent
                    }
                    msg.copy(
                        content = finalContent,
                        persistedId = event.messageId ?: msg.persistedId,
                        stopReason = resolvedStopReason,
                        errorCategory = if (event.isError || isAbort) {
                            event.errorCategory ?: msg.errorCategory ?: if (isAbort) "aborted" else null
                        } else {
                            msg.errorCategory
                        },
                        errorCode = if (event.isError) event.errorCode ?: msg.errorCode else msg.errorCode,
                        errorClass = resolvedErrorClass ?: if (isAbort) "ABORT" else msg.errorClass,
                        suggestedAction = if (event.isError && !isAbort) {
                            event.suggestedAction ?: msg.suggestedAction
                        } else {
                            msg.suggestedAction
                        },
                        // ABORT 是中性事件，清空 errorMessage，避免下游当故障展示。
                        errorMessage = when {
                            isAbort -> null
                            event.isError -> event.errorMessage ?: msg.errorMessage
                            else -> msg.errorMessage
                        },
                        isStreaming = false,
                    )
                }
                endStreaming()
                true
            }

            is StreamEvent.Error -> {
                val text = errorMessage?.invoke(event.error) ?: event.error.message.orEmpty()
                updateAssistantFor(event) { _, msg ->
                    when (val err = event.error) {
                        is AppError.AgentExecution -> msg.copy(
                            content = text,
                            errorMessage = text,
                            errorCategory = err.errorCategory ?: msg.errorCategory,
                            errorCode = err.errorCode ?: msg.errorCode,
                            errorClass = err.errorClass ?: msg.errorClass,
                            suggestedAction = err.suggestedAction ?: msg.suggestedAction,
                            isStreaming = false,
                        )
                        is AppError.BillingBlocked -> msg.copy(
                            content = text,
                            errorMessage = text,
                            errorCategory = err.errorCategory,
                            errorCode = err.errorCode,
                            isStreaming = false,
                        )
                        else -> msg.copy(content = text, errorMessage = text, isStreaming = false)
                    }
                }
                endStreaming()
                true
            }

            is StreamEvent.ChunkAppended -> updateAssistantFor(event) { _, msg ->
                msg.copy(content = event.fullContent, isStreaming = true)
            }

            is StreamEvent.Reasoning -> updateAssistantFor(event) { _, msg ->
                msg.copy(reasoning = event.fullContent, isStreaming = true)
            }

            is StreamEvent.ToolCall -> updateAssistantFor(event) { _, msg ->
                val existing = msg.agentSteps.orEmpty().firstOrNull { it.id == event.id }
                val step = AgentStep(
                    id = event.id,
                    type = StepType.TOOL_CALL,
                    name = event.name,
                    status = event.status,
                    input = event.input ?: existing?.input,
                    output = event.output ?: existing?.output,
                    durationMs = event.durationMs ?: existing?.durationMs,
                    presentationKind = event.presentationKind ?: existing?.presentationKind,
                    presentationPrompt = event.presentationPrompt ?: existing?.presentationPrompt,
                )
                msg.copy(agentSteps = msg.agentSteps.upsert(step), isStreaming = event.status == StepStatus.RUNNING || msg.isStreaming)
            }

            is StreamEvent.StepUpdate -> updateAssistantFor(event) { _, msg ->
                val step = AgentStep(event.id, StepType.STEP, event.description, event.status)
                msg.copy(agentSteps = msg.agentSteps.upsert(step))
            }

            is StreamEvent.SystemNotice -> updateAssistantFor(event) { _, msg ->
                systemNotice = event.content
                val step = AgentStep(
                    id = event.id,
                    type = StepType.SYSTEM_NOTICE,
                    name = event.content,
                    status = StepStatus.COMPLETED,
                    noticeType = event.noticeType,
                )
                msg.copy(agentSteps = msg.agentSteps.upsert(step))
            }

            is StreamEvent.ContentReset -> updateAssistantFor(event) { _, msg ->
                msg.copy(content = "", isStreaming = true)
            }

            else -> false
        }
    }

    fun updateAssistant(assistantId: String, update: (ChatMessage) -> ChatMessage): Boolean =
        updateById(assistantId, update)

    private fun updateAssistantFor(
        event: StreamEvent,
        update: (assistantId: String, ChatMessage) -> ChatMessage,
    ): Boolean {
        val assistantId = assistantIdFor(event) ?: return false
        return updateById(assistantId) { update(assistantId, it) }
    }

    /**
     * 合成 mini-message 收尾事件的安静消费：命中登记集合即移除并返回 true，
     * 不做气泡更新，也不让事件以 false 落入 ViewModel legacy 兜底。
     */
    private fun consumeSkippedSyntheticSettled(messageId: String?): Boolean =
        messageId != null && skippedSyntheticStartIds.remove(messageId)

    private fun upsertTool(event: StreamEvent, status: StepStatus, input: String?): Boolean {
        val tool = when (event) {
            is StreamEvent.ToolUseBlockStarted -> Triple(event.toolCallId, event.name, event.index)
            is StreamEvent.ToolUseBlockUpdated -> Triple(event.toolCallId, event.name, event.index)
            is StreamEvent.ToolUseBlockCompleted -> Triple(event.toolCallId, event.name, event.index)
            else -> return false
        }
        val messageId = event.streamMessageId()
        return updateAssistantFor(event) { assistantId, msg ->
            val previous = msg.agentSteps.orEmpty().firstOrNull { it.id == tool.first }
            val step = AgentStep(
                id = tool.first,
                type = StepType.TOOL_CALL,
                name = tool.second,
                status = status,
                input = input ?: previous?.input,
                output = previous?.output,
                durationMs = previous?.durationMs,
                noticeType = previous?.noticeType,
                subagent = previous?.subagent,
                presentationKind = previous?.presentationKind,
                presentationPrompt = previous?.presentationPrompt,
            )
            msg.copy(
                agentSteps = msg.agentSteps.upsert(step),
                blocksJson = blockProjector.upsertTool(assistantId, messageId, tool.third, step, msg.blocksJson),
                isStreaming = status == StepStatus.RUNNING || msg.isStreaming,
            )
        }
    }

    private fun upsertProjectedBlock(event: StreamEvent, block: BlockItem): Boolean {
        val index = when (event) {
            is StreamEvent.RichContentBlockReceived -> event.index
            is StreamEvent.ContextRefBlockReceived -> event.index
            is StreamEvent.AttachmentBlockReceived -> event.index
            else -> return false
        }
        return updateAssistantFor(event) { assistantId, msg ->
            msg.copy(
                blocksJson = blockProjector.upsertContentBlock(assistantId, event.streamMessageId(), index, block, msg.blocksJson),
                isStreaming = true,
            )
        }
    }

    /** 历史对账后重建 messageId → 气泡路由，避免重连重放 message_start 时 map 空而新建双份。 */
    private fun rebuildBubbleRoutingFromMessages() {
        bubbleForMessage.clear()
        for (message in _messages) {
            if (!message.isAssistant) continue
            message.serverId?.trim()?.takeIf { it.isNotEmpty() }?.let { bubbleForMessage[it] = message.id }
            message.persistedId?.trim()?.takeIf { it.isNotEmpty() }?.let { bubbleForMessage[it] = message.id }
        }
    }

    /**
     * message_start：首条认领乐观占位，后续各自新建；重连对账后 map 可能被清掉，
     * 仍须按 identity 认领已有气泡，不能再新建。
     */
    private fun beginOrClaimBubble(messageId: String, agentId: String? = null): String {
        bubbleForMessage[messageId]?.let {
            activeAssistantId = it
            if (agentId != null) updateById(it) { message -> message.copy(agentId = agentId) }
            return it
        }
        val existingIndex = _messages.indexOfFirst { message ->
            message.isAssistant && (
                messageId in message.identityKeys ||
                    message.serverId == messageId ||
                    message.persistedId == messageId ||
                    message.effectiveId == messageId
                )
        }
        if (existingIndex >= 0) {
            val existing = _messages[existingIndex]
            bubbleForMessage[messageId] = existing.id
            _messages[existingIndex] = existing.copy(
                serverId = existing.serverId ?: messageId,
                agentId = agentId ?: existing.agentId,
            )
            activeAssistantId = existing.id
            return existing.id
        }
        pendingOptimisticId?.let { opt ->
            bubbleForMessage[messageId] = opt
            updateById(opt) {
                it.copy(
                    serverId = messageId,
                    agentId = agentId ?: it.agentId,
                    isStreaming = true,
                )
            }
            activeAssistantId = opt
            pendingOptimisticId = null
            return opt
        }
        val localId = "asst_$messageId"
        _messages.add(
            ChatMessage(
                id = localId,
                role = "assistant",
                agentId = agentId,
                serverId = messageId,
                isStreaming = true,
                createdAt = Instant.now().toString(),
            )
        )
        bubbleForMessage[messageId] = localId
        activeAssistantId = localId
        return localId
    }

    private fun updateById(id: String, update: (ChatMessage) -> ChatMessage): Boolean {
        val idx = _messages.indexOfLast { it.id == id }
        if (idx < 0) return false
        _messages[idx] = update(_messages[idx])
        return true
    }

    private fun hasAssistant(id: String): Boolean = _messages.any { it.id == id && it.isAssistant }

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
                || isEmptyInterruptedAssistantShell(it)
        }.distinctBy { it.id }

    private fun MessageBlock.toBlockItem(): BlockItem =
        BlockItem(
            type = type,
            content = content,
            text = if (type == "text") content else null,
            fileId = fileId,
            filename = filename,
            mimeType = mimeType,
            size = size,
            url = url,
            tableId = tableId,
            docId = docId,
            memoId = memoId,
            fieldIds = fieldIds,
            rowIds = rowIds,
            preview = preview,
            title = preview,
            resourceId = tableId ?: docId ?: memoId ?: fileId,
            spaceId = spaceId,
            spaceName = spaceName,
        )

    private fun List<AgentStep>?.upsert(step: AgentStep): List<AgentStep> {
        val next = this.orEmpty().toMutableList()
        val idx = next.indexOfFirst { it.id == step.id }
        if (idx >= 0) next[idx] = step else next.add(step)
        return next
    }

    private fun StreamEvent.streamMessageId(): String? = when (this) {
        is StreamEvent.MessageStarted -> messageId
        is StreamEvent.TextBlockDelta -> messageId
        is StreamEvent.CitationBlockDelta -> messageId
        is StreamEvent.ThinkingBlockDelta -> messageId
        is StreamEvent.ToolUseBlockStarted -> messageId
        is StreamEvent.ToolUseBlockUpdated -> messageId
        is StreamEvent.ToolUseBlockCompleted -> messageId
        is StreamEvent.ToolResultBlock -> messageId
        is StreamEvent.RichContentBlockReceived -> messageId
        is StreamEvent.ContextRefBlockReceived -> messageId
        is StreamEvent.AttachmentBlockReceived -> messageId
        is StreamEvent.MessageStopped -> messageId
        is StreamEvent.Done -> messageId
        is StreamEvent.MessagePersisted -> messageId
        is StreamEvent.MessageCommitted -> messageId
        else -> null
    }

    private fun StreamEvent.shouldCreateAssistantWithoutMessageId(): Boolean = when (this) {
        is StreamEvent.ChunkAppended,
        is StreamEvent.Reasoning,
        is StreamEvent.ToolCall,
        is StreamEvent.StepUpdate,
        is StreamEvent.SystemNotice,
        is StreamEvent.Error,
        is StreamEvent.ContentReset -> true
        else -> false
    }

    private fun StreamEvent.shouldCreateAssistantForServerMessageId(): Boolean = when (this) {
        is StreamEvent.MessageStarted,
        is StreamEvent.TextBlockDelta,
        is StreamEvent.CitationBlockDelta,
        is StreamEvent.ThinkingBlockDelta,
        is StreamEvent.ToolUseBlockStarted,
        is StreamEvent.ToolUseBlockUpdated,
        is StreamEvent.ToolUseBlockCompleted,
        is StreamEvent.ToolResultBlock,
        is StreamEvent.RichContentBlockReceived,
        is StreamEvent.ContextRefBlockReceived,
        is StreamEvent.AttachmentBlockReceived -> true
        is StreamEvent.MessageStopped,
        is StreamEvent.Done,
        is StreamEvent.MessagePersisted,
        is StreamEvent.MessageCommitted -> false
        else -> false
    }

    private fun applyMessageIdMappings(mappings: List<com.tabtin.mobile.data.model.MessageIdMapping>) {
        for (mapping in mappings) {
            val idx = _messages.indexOfFirst { msg ->
                msg.identityKeys.contains(mapping.clientEventId) || msg.id == mapping.clientEventId
            }
            if (idx < 0) continue
            val msg = _messages[idx]
            _messages[idx] = msg.copy(
                serverId = msg.serverId ?: mapping.serverId,
                persistedId = msg.persistedId ?: mapping.serverId,
                clientEventId = msg.clientEventId ?: mapping.clientEventId,
            )
        }
    }

    private fun upsertByIdentity(
        authoritative: List<ChatMessage>,
        current: List<ChatMessage>,
        preserveOptimisticUserCreatedAt: Boolean = false,
    ): List<ChatMessage> {
        val merged = current.toMutableList()
        val usedLocal = mutableSetOf<Int>()
        for (server in authoritative) {
            val match = findMatchingMessage(server, merged, usedLocal)
            if (match != null) {
                usedLocal.add(match.index)
                merged[match.index] = mergeServerMessageIntoLocal(
                    local = match.message,
                    server = server,
                    preserveOptimisticUserCreatedAt = preserveOptimisticUserCreatedAt,
                )
            } else {
                merged.add(server)
            }
        }
        return merged.sortedWith(::compareTimeline)
    }

    private data class IndexedMessage(val index: Int, val message: ChatMessage)

    private fun findMatchingMessage(
        server: ChatMessage,
        candidates: List<ChatMessage>,
        used: Set<Int>,
    ): IndexedMessage? {
        candidates.forEachIndexed { index, candidate ->
            if (index !in used && candidate.sharesIdentityWith(server)) {
                return IndexedMessage(index, candidate)
            }
        }
        candidates.forEachIndexed { index, candidate ->
            if (index !in used && candidate.isLegacyUserDuplicateOf(server)) {
                return IndexedMessage(index, candidate)
            }
        }
        return null
    }

    private fun mergeServerMessageIntoLocal(
        local: ChatMessage,
        server: ChatMessage,
        preserveOptimisticUserCreatedAt: Boolean = false,
    ): ChatMessage {
        val createdAt = if (preserveOptimisticUserCreatedAt && local.isUser && server.isUser) {
            earlierCreatedAt(local.createdAt, server.createdAt)
        } else {
            server.createdAt
        }
        val mergedSteps = mergeAgentStepsPreservingLiveTranscript(local.agentSteps, server.agentSteps)
        if (local.id == server.id) {
            return server.copy(createdAt = createdAt, agentSteps = mergedSteps)
        }
        val localContent = local.displayContent
        val serverContent = server.displayContent
        if (local.isAssistant && server.isAssistant && local.isStreaming) {
            return local.copy(
                serverId = local.serverId ?: server.serverId ?: server.id,
                persistedId = server.persistedId ?: local.persistedId,
                clientEventId = local.clientEventId ?: server.clientEventId,
                agentRunId = local.agentRunId ?: server.agentRunId,
            )
        }
        if (local.isAssistant && server.isAssistant) {
            return server.copy(
                id = local.id,
                serverId = server.serverId ?: server.id,
                persistedId = server.persistedId ?: server.id,
                content = if (localContent.length > serverContent.length) local.content else server.content,
                blocksJson = if (localContent.length > serverContent.length && !local.blocksJson.isNullOrEmpty()) {
                    local.blocksJson
                } else {
                    server.blocksJson
                },
                agentSteps = mergedSteps,
            )
        }
        if (!local.isUser || !server.isUser) {
            return if (mergedSteps === server.agentSteps) server
            else server.copy(agentSteps = mergedSteps)
        }
        return server.copy(
            id = local.id,
            serverId = server.serverId ?: server.id,
            persistedId = server.persistedId ?: server.id,
            clientEventId = server.clientEventId ?: local.canonicalClientEventId,
            createdAt = createdAt,
            content = if (localContent.length > serverContent.length) local.content else server.content,
            blocksJson = if (localContent.length > serverContent.length && !local.blocksJson.isNullOrEmpty()) {
                local.blocksJson
            } else {
                server.blocksJson
            },
            agentSteps = mergedSteps,
        )
    }

    /**
     * server 缺 agentSteps 时保留 local；同 id 的 SUBAGENT 步保留 local 非空 transcript。
     */
    private fun mergeAgentStepsPreservingLiveTranscript(
        local: List<AgentStep>?,
        server: List<AgentStep>?,
    ): List<AgentStep>? {
        if (server.isNullOrEmpty()) return local
        if (local.isNullOrEmpty()) return server
        val localById = local.associateBy { it.id }
        val merged = server.map { step ->
            val prev = localById[step.id] ?: return@map step
            if (step.type != StepType.SUBAGENT && prev.type != StepType.SUBAGENT) return@map step
            val prevSnap = prev.subagent
            val nextSnap = step.subagent
            if (prevSnap == null) return@map step
            if (nextSnap == null) return@map prev
            if (prevSnap.transcript.isNotEmpty() && nextSnap.transcript.isEmpty()) {
                step.copy(subagent = nextSnap.copy(transcript = prevSnap.transcript))
            } else {
                step
            }
        }
        val serverIds = server.map { it.id }.toSet()
        val localOnly = local.filter { it.id !in serverIds }
        return if (localOnly.isEmpty()) merged else merged + localOnly
    }

    private fun ChatMessage.sharesIdentityWith(other: ChatMessage): Boolean =
        identityKeys.intersect(other.identityKeys).isNotEmpty()

    private fun ChatMessage.isLegacyUserDuplicateOf(server: ChatMessage): Boolean {
        if (!isUser || !server.isUser) return false
        if (canonicalClientEventId.isNullOrBlank() && server.canonicalClientEventId.isNullOrBlank()) return false
        val left = displayContent.take(100)
        val right = server.displayContent.take(100)
        if (left.isBlank() || left != right) return false
        val leftAt = createdAt?.toInstantEpochMs() ?: return false
        val rightAt = server.createdAt?.toInstantEpochMs() ?: return false
        return abs(leftAt - rightAt) < DEDUP_WINDOW_MS
    }

    private fun String.toInstantEpochMs(): Long? = try {
        Instant.parse(this).toEpochMilli()
    } catch (_: Exception) {
        null
    }

    private fun earlierCreatedAt(local: String?, server: String?): String? = when {
        local == null -> server
        server == null -> local
        else -> {
            val localEpoch = local.toInstantEpochMs()
            val serverEpoch = server.toInstantEpochMs()
            when {
                localEpoch != null && serverEpoch != null -> if (localEpoch <= serverEpoch) local else server
                else -> minOf(local, server)
            }
        }
    }

    private companion object {
        private const val DEDUP_WINDOW_MS = 5_000L

        /** 时间相同的 user 必须在 assistant 前，避免同秒落库时重新出现视觉倒序。 */
        private fun compareTimeline(left: ChatMessage, right: ChatMessage): Int {
            val byCreatedAt = (left.createdAt ?: "").compareTo(right.createdAt ?: "")
            if (byCreatedAt != 0) return byCreatedAt
            if (left.isUser != right.isUser) return if (left.isUser) -1 else 1
            return left.effectiveId.compareTo(right.effectiveId)
        }

    }
}

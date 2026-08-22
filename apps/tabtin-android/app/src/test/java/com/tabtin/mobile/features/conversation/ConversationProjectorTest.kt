package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StreamEvent
import com.tabtin.mobile.data.repository.OutgoingHistoryEvidence
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationProjectorTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun resolvedAskChoiceFactAppearsOnceWhileOtherHitlFactsStayHidden() {
        val projector = ConversationProjector()
        val resolved = json.decodeFromString<ChatMessage>(
            """
                {
                  "id": "hitl-resolved",
                  "role": "assistant",
                  "message_kind": "hitl_interaction",
                  "metadata": { "hitl": {
                    "kind": "ask_choice",
                    "status": "resolved",
                    "payload": { "questions": [{
                      "id": "q1",
                      "prompt": "选一个",
                      "options": [{ "id": "a", "label": "A" }]
                    }] },
                    "result": { "answers": [{
                      "question_id": "q1",
                      "selected_options": ["a"]
                    }] }
                  } }
                }
            """.trimIndent(),
        )
        val pending = resolved.copy(id = "hitl-pending", metadata = resolved.metadata?.mapValues {
            if (it.key != "hitl") it.value else buildJsonObject {
                put("kind", "ask_choice")
                put("status", "pending")
            }
        })

        assertTrue(projector.replaceWithHistory(listOf(resolved, resolved, pending)))

        assertEquals(listOf("hitl-resolved"), projector.messages.map { it.id })
    }

    @Test
    fun duplicateServerMessageIdsNeverReachUiTimeline() {
        val duplicateId = "9e99f48f-32f4-404c-b559-46f49fbb8c10"
        val projector = ConversationProjector()

        assertTrue(projector.replaceWithHistory(listOf(
            historyMessage(duplicateId, "user", "重复消息", "2026-08-11T12:46:00Z"),
            historyMessage(duplicateId, "user", "重复消息", "2026-08-11T12:46:00Z"),
        )))

        assertEquals(listOf(duplicateId), projector.messages.map { it.id })
    }

    @Test
    fun unclaimedMessageCommittedDoesNotMutateActiveBubble() {
        val projector = ConversationProjector()

        projector.apply(StreamEvent.MessageStarted(messageId = "m2"))
        projector.apply(StreamEvent.TextBlockDelta(messageId = "m2", index = 0, text = "active"))
        projector.apply(StreamEvent.MessageCommitted(messageId = "m1", serverId = "db_m1", partial = false))

        val active = projector.messages.first { it.serverId == "m2" }
        assertEquals("active", active.content)
        assertNull(active.persistedId)
        assertFalse(projector.messages.any { it.persistedId == "db_m1" })
    }

    @Test
    fun mergeCommittedHistoryWorksWhileNextMessageIsStreaming() {
        val projector = ConversationProjector()
        assertTrue(projector.replaceWithHistory(listOf(
            historyMessage("u1", "user", "问一下", "2026-01-01T00:00:00Z"),
            historyMessage("a1", "assistant", "partial", "2026-01-01T00:00:01Z"),
        )))

        projector.apply(StreamEvent.MessageStarted(messageId = "m2"))
        projector.apply(StreamEvent.TextBlockDelta(messageId = "m2", index = 0, text = "下一条"))
        assertTrue(projector.isStreamingActive)

        assertTrue(projector.mergeCommittedHistory(listOf(
            historyMessage("a1", "assistant", "final answer", "2026-01-01T00:00:01Z"),
        )))

        assertEquals("final answer", projector.messages.first { it.effectiveId == "a1" }.content)
        val streaming = projector.messages.first { it.serverId == "m2" }
        assertEquals("下一条", streaming.content)
        assertTrue(streaming.isStreaming)

        projector.apply(StreamEvent.TextBlockDelta(messageId = "m2", index = 0, text = "继续"))
        assertEquals("下一条继续", projector.messages.first { it.serverId == "m2" }.content)
    }

    @Test
    fun reconnectReplaceCanSettleDeadStreamingAssistant() {
        val projector = ConversationProjector()
        projector.beginAssistant("asst-streaming")
        assertTrue(projector.isStreamingActive)
        assertFalse(
            projector.replaceWithHistory(
                listOf(historyMessage("a1", "assistant", "server final", "2026-01-01T00:00:01Z")),
            ),
        )
        assertTrue(
            projector.replaceWithHistory(
                listOf(historyMessage("a1", "assistant", "server final", "2026-01-01T00:00:01Z")),
                allowWhileStreaming = true,
            ),
        )
        assertEquals(1, projector.messages.size)
        assertEquals("server final", projector.messages[0].content)
        assertFalse(projector.isStreamingActive)
    }

    @Test
    fun committedOptimisticUserStaysBeforeStreamingAssistant() {
        val projector = ConversationProjector()
        val clientEventId = "client-current-turn"
        val localUser = projector.appendUserMessage(clientEventId, "刚发出的消息", null)
        projector.beginAssistant("assistant-current-turn")

        val committedUser = ChatMessage(
            id = "server-user-current-turn",
            serverId = "server-user-current-turn",
            persistedId = "server-user-current-turn",
            clientEventId = clientEventId,
            role = "user",
            content = "刚发出的消息",
            createdAt = "2099-01-01T00:00:00Z",
        )
        assertTrue(projector.mergeCommittedHistory(listOf(committedUser)))

        assertEquals(listOf("user", "assistant"), projector.messages.map { it.role })
        assertEquals(localUser.createdAt, projector.messages.first().createdAt)
        assertTrue(projector.messages.last().isStreaming)

        projector.endStreaming()
        assertTrue(projector.replaceWithHistory(listOf(
            committedUser,
            ChatMessage(
                id = "server-assistant-current-turn",
                serverId = "server-assistant-current-turn",
                persistedId = "server-assistant-current-turn",
                role = "assistant",
                content = "完整回复",
                createdAt = "2099-01-01T00:00:01Z",
            ),
        )))
        assertEquals(listOf("user", "assistant"), projector.messages.map { it.role })
        assertEquals(localUser.createdAt, projector.messages.first().createdAt)
    }

    @Test
    fun replaceWithHistoryKeepsUserBeforeAssistantWhenServerTimestampsInvert() {
        val projector = ConversationProjector()
        val clientEventId = "client-666"
        val localUser = projector.appendUserMessage(clientEventId, "666", null)
        projector.beginAssistant("assistant-pending")
        projector.apply(StreamEvent.MessageStarted(messageId = "server-assistant-666"))
        projector.apply(StreamEvent.TextBlockDelta(messageId = "server-assistant-666", index = 0, text = "收到 666"))
        projector.endStreaming()

        val serverUser = ChatMessage(
            id = "server-user-666",
            serverId = "server-user-666",
            persistedId = "server-user-666",
            clientEventId = clientEventId,
            role = "user",
            content = "666",
            // 模拟服务端先开流、再落库 user：user 时间晚于本轮 assistant。
            createdAt = "2099-01-01T00:00:05Z",
        )
        val serverAssistant = ChatMessage(
            id = "server-assistant-666",
            serverId = "server-assistant-666",
            persistedId = "server-assistant-666",
            role = "assistant",
            content = "收到 666",
            createdAt = "2099-01-01T00:00:01Z",
        )

        assertTrue(projector.replaceWithHistory(listOf(serverUser, serverAssistant)))

        assertEquals(listOf("user", "assistant"), projector.messages.map { it.role })
        assertEquals("666", projector.messages.first().content)
        assertEquals(localUser.createdAt, projector.messages.first().createdAt)
    }

    @Test
    fun sameTimestampOrdersUserBeforeAssistantDeterministically() {
        val projector = ConversationProjector()
        val timestamp = "2099-01-01T00:00:00Z"

        assertTrue(projector.replaceWithHistory(listOf(
            historyMessage("assistant", "assistant", "回复", timestamp),
            historyMessage("user", "user", "提问", timestamp),
        )))

        assertEquals(listOf("user", "assistant"), projector.messages.map { it.role })
    }

    @Test
    fun historySubagentTranscriptDoesNotEnterMainTimeline() {
        val projector = ConversationProjector()

        assertTrue(projector.replaceWithHistory(listOf(
            historyMessage("parent", "assistant", "父会话回答", "2026-01-01T00:00:00Z"),
            historyMessage(
                id = "child",
                role = "assistant",
                content = "子 Agent 详情",
                createdAt = "2026-01-01T00:00:01Z",
                subagentRunId = "run-child",
            ),
        )))

        assertEquals(listOf("parent"), projector.messages.map { it.id })
    }

    @Test
    fun agentSwitchAuditDoesNotEnterMainTimeline() {
        val projector = ConversationProjector()

        assertTrue(projector.replaceWithHistory(listOf(
            historyMessage("answer", "assistant", "已切换后的回复", "2026-01-01T00:00:00Z"),
            ChatMessage(
                id = "agent-switch",
                role = "system",
                content = "切换当前 Agent",
                metadata = mapOf("system_fact" to kotlinx.serialization.json.JsonPrimitive("agent_switched")),
            ),
        )))

        assertEquals(listOf("answer"), projector.messages.map { it.id })
    }

    @Test
    fun emptySystemRichArtifactDoesNotEnterVisibleTimeline() {
        val projector = ConversationProjector()
        val emptySystemArtifact = ChatMessage(
            id = "legacy-file-preview",
            role = "system",
            content = "",
            messageKind = "tool_artifact",
            blocksJson = listOf(
                BlockItem(
                    type = "tabtin_rich_content",
                    kind = "file",
                    summary = "photo_1.jpg",
                ),
            ),
        )

        assertTrue(projector.replaceWithHistory(listOf(emptySystemArtifact)))

        assertTrue(
            "空正文 system 富内容不能退化成只有 Info 图标的空提示",
            projector.messages.isEmpty(),
        )
    }

    @Test
    fun emptyAuthoritativeHistoryClearsStaleCachedMessages() {
        val projector = ConversationProjector()

        assertTrue(projector.replaceWithHistory(listOf(
            historyMessage("stale", "assistant", "旧缓存", "2026-01-01T00:00:00Z"),
        )))
        assertTrue(projector.replaceWithHistory(emptyList()))

        assertTrue(projector.messages.isEmpty())
    }

    @Test
    fun focusedHistoryReplacesDistantLatestWindow() {
        val projector = ConversationProjector()
        assertTrue(projector.replaceWithHistory(listOf(
            historyMessage("latest", "assistant", "最新回复", "2026-01-02T00:00:00Z"),
        )))

        assertTrue(projector.replaceWithFocusedHistory(listOf(
            historyMessage("before", "user", "很早的问题", "2026-01-01T00:00:00Z"),
            historyMessage("target", "assistant", "目标回复", "2026-01-01T00:00:01Z"),
            historyMessage("after", "user", "后续追问", "2026-01-01T00:00:02Z"),
        )))

        assertEquals(listOf("before", "target", "after"), projector.messages.map { it.id })
        assertFalse(projector.messages.any { it.id == "latest" })
    }

    @Test
    fun focusedHistoryDropsCachedTailRemovedByRollback() {
        val projector = ConversationProjector()
        assertTrue(projector.replaceWithHistory(listOf(
            historyMessage("u1", "user", "第一问", "2026-01-01T00:00:00Z"),
            historyMessage("a1", "assistant", "第一答", "2026-01-01T00:00:01Z"),
            historyMessage("u2", "user", "已回退的问题", "2026-01-01T00:00:02Z"),
            historyMessage("a2", "assistant", "已回退的回答", "2026-01-01T00:00:03Z"),
        )))

        assertTrue(projector.replaceWithFocusedHistory(listOf(
            historyMessage("u1", "user", "第一问", "2026-01-01T00:00:00Z"),
            historyMessage("a1", "assistant", "第一答", "2026-01-01T00:00:01Z"),
        )))

        assertEquals(listOf("u1", "a1"), projector.messages.map { it.id })
    }

    @Test
    fun retryWithSameClientEventIdDoesNotDuplicateUserBubble() {
        val projector = ConversationProjector()

        projector.appendUserMessage("client-1", "第一次", null)
        projector.appendUserMessage("client-1", "重试", null)

        assertEquals(1, projector.messages.size)
        assertEquals("重试", projector.messages.single().content)
        assertEquals("client-1", projector.messages.single().clientEventId)
    }

    @Test
    fun acknowledgedIdentityFallsBackToStableQueueClientEventId() {
        assertEquals("client-stable", resolveAcknowledgedClientEventId("client-stable", null))
        assertEquals("client-stable", resolveAcknowledgedClientEventId("client-stable", ""))
        assertEquals("client-ack", resolveAcknowledgedClientEventId("client-stable", "client-ack"))
    }

    @Test
    fun userMirrorDoesNotDisarmAssistantWatchdog() {
        assertFalse(
            StreamEvent.ObservedUserMessage(
                id = "server-user",
                content = "hello",
                clientEventId = "client-1",
            ).countsAsAssistantProgressForSendWatchdog()
        )
        assertTrue(
            StreamEvent.MessageStarted(messageId = "assistant-1")
                .countsAsAssistantProgressForSendWatchdog()
        )
    }

    @Test
    fun messageStartedKeepsTheAuthoritativeAgentOnTheAssistantBubble() {
        val projector = ConversationProjector()

        projector.apply(StreamEvent.MessageStarted(messageId = "assistant-1", agentId = "agent-1"))
        projector.apply(StreamEvent.TextBlockDelta(messageId = "assistant-1", index = 0, text = "已完成"))

        val message = projector.messages.single()
        assertEquals("agent-1", message.agentId)
        assertEquals("已完成", message.content)
    }

    /** ：loadSession 清 snapshot 后，仍优先用会话级 executionAgentId。 */
    @Test
    fun optimisticExecutionAgentIdPrefersCacheOverClearedSnapshot() {
        assertEquals(
            "agent-cached",
            resolveOptimisticExecutionAgentId("agent-cached", null),
        )
        assertEquals(
            "agent-snapshot",
            resolveOptimisticExecutionAgentId(null, "agent-snapshot"),
        )
        assertEquals(
            "agent-cached",
            resolveOptimisticExecutionAgentId("agent-cached", "agent-snapshot"),
        )
        assertNull(resolveOptimisticExecutionAgentId("  ", ""))
        assertNull(resolveOptimisticExecutionAgentId(null, null))
    }

    /** ：乐观占位在无 message_start 时也应带上执行 agentId。 */
    @Test
    fun optimisticBeginAssistantWritesAgentIdWithoutMessageStart() {
        val projector = ConversationProjector()

        projector.beginAssistant(id = "asst_pending_evt", agentId = "agent-exec")

        val message = projector.messages.single()
        assertEquals("agent-exec", message.agentId)
        assertTrue(projector.hasPendingOptimistic)
    }

    /** ：replaceWithHistory 后重放同 message_id 的 message_start，不得再新建一条。 */
    @Test
    fun replaceWithHistoryThenSameMessageStartDoesNotDuplicate() {
        val projector = ConversationProjector()
        assertTrue(
            projector.replaceWithHistory(
                listOf(
                    historyMessage("u1", "user", "在吗", "2026-01-01T00:00:00Z"),
                    historyMessage("a1", "assistant", "在的", "2026-01-01T00:00:01Z").copy(
                        agentId = "agent-1",
                    ),
                ),
            ),
        )
        val countBefore = projector.messages.size

        projector.apply(StreamEvent.MessageStarted(messageId = "a1", agentId = "agent-1"))

        assertEquals(countBefore, projector.messages.size)
        assertEquals(1, projector.messages.count { it.isAssistant })
        assertEquals("a1", projector.messages.single { it.isAssistant }.effectiveId)
    }

    @Test
    fun exactExecutionEvidenceStopsRemainingOutgoingReconciliationAttempts() {
        assertTrue(shouldFinishOutgoingReconciliation(OutgoingHistoryEvidence.EXECUTION_STARTED))
        assertFalse(shouldFinishOutgoingReconciliation(OutgoingHistoryEvidence.PERSISTED))
        assertFalse(shouldFinishOutgoingReconciliation(OutgoingHistoryEvidence.ABSENT))
    }

    @Test
    fun observedSharedUserMessagePreservesSenderIdentity() {
        val projector = ConversationProjector()

        projector.apply(
            StreamEvent.ObservedUserMessage(
                id = "shared-user",
                content = "协作者的新消息",
                senderUserId = "user-2",
                senderDisplayName = "小林",
            ),
        )

        val message = projector.messages.single()
        assertEquals("user-2", message.senderUserId)
        assertEquals("小林", message.senderDisplayName)
    }

    @Test
    fun composerStopWithdrawsTurnWhenAssistantOnlyStartedThinking() {
        val projector = ConversationProjector()
        val clientId = "55555555-5555-4555-8555-555555555555"
        projector.appendUserMessage(clientId, "发错了", null)
        projector.beginAssistant("asst_pending_$clientId")
        projector.apply(
            StreamEvent.ThinkingBlockDelta(
                messageId = "asst_pending_$clientId",
                index = 0,
                text = "正在思考",
            ),
        )

        assertFalse(projector.hasSubstantiveAssistantOutput(afterUserMessageId = clientId))
        assertTrue(evaluateCanWithdrawUnansweredTurn(projector.messages, clientId))
        projector.withdrawUnansweredTurn(userMessageId = clientId)

        assertTrue(projector.messages.isEmpty())
        assertFalse(projector.isStreamingActive)
    }

    @Test
    fun composerStopKeepsTurnAfterAssistantHasVisibleOutput() {
        val projector = ConversationProjector()
        val clientId = "66666666-6666-4666-8666-666666666666"
        projector.appendUserMessage(clientId, "继续", null)
        projector.beginAssistant("asst_pending_$clientId")
        projector.apply(
            StreamEvent.TextBlockDelta(
                messageId = "asst_pending_$clientId",
                index = 0,
                text = "已经开始回复",
            ),
        )

        assertTrue(projector.hasSubstantiveAssistantOutput(afterUserMessageId = clientId))
        assertFalse(evaluateCanWithdrawUnansweredTurn(projector.messages, clientId))
        projector.endStreaming()

        assertEquals(2, projector.messages.size)
        assertEquals("已经开始回复", projector.messages.last().content)
        assertFalse(projector.isStreamingActive)
    }

    @Test
    fun abortDoneWritesStopReasonAndErrorClassOnPartialAssistant() {
        val projector = ConversationProjector()
        projector.apply(StreamEvent.MessageStarted(messageId = "m-abort"))
        projector.apply(
            StreamEvent.TextBlockDelta(messageId = "m-abort", index = 0, text = "半截内容"),
        )
        assertTrue(
            projector.apply(
                StreamEvent.MessageStopped(
                    messageId = "m-abort",
                    stopReason = "aborted",
                    errorClass = "ABORT",
                    errorCategory = "aborted",
                ),
            ),
        )
        assertTrue(
            projector.apply(
                StreamEvent.Done(
                    messageId = "m-abort",
                    content = "半截内容",
                    isError = true,
                    errorClass = "ABORT",
                    errorCategory = "aborted",
                    stopReason = "aborted",
                    errorMessage = "Run aborted by user.",
                ),
            ),
        )

        val assistant = projector.messages.single { it.isAssistant }
        assertEquals("aborted", assistant.stopReason)
        assertEquals("ABORT", assistant.errorClass)
        assertEquals("aborted", assistant.errorCategory)
        assertEquals("半截内容", assistant.content)
        assertNull(assistant.errorMessage)
        assertTrue(isNeutralInterruption(assistant))
        assertFalse(isEmptyInterruptedAssistantShell(assistant))
    }

    @Test
    fun abortEmptyShellHiddenFromTimeline() {
        val projector = ConversationProjector()
        projector.apply(StreamEvent.MessageStarted(messageId = "m-empty-abort"))
        assertTrue(
            projector.apply(
                StreamEvent.Done(
                    messageId = "m-empty-abort",
                    content = "Run aborted by user.",
                    isError = true,
                    errorClass = "ABORT",
                    errorCategory = "aborted",
                    stopReason = "aborted",
                    errorMessage = "Run aborted by user.",
                ),
            ),
        )

        assertFalse(projector.messages.any { it.isAssistant })
        assertTrue(
            isEmptyInterruptedAssistantShell(
                ChatMessage(
                    id = "shell",
                    role = "assistant",
                    content = "",
                    errorClass = "ABORT",
                    stopReason = "aborted",
                ),
            ),
        )
    }

    @Test
    fun messageStoppedAbortSignalsPropagateWithoutDone() {
        val projector = ConversationProjector()
        projector.apply(StreamEvent.MessageStarted(messageId = "m-stop"))
        projector.apply(
            StreamEvent.TextBlockDelta(messageId = "m-stop", index = 0, text = "先说一句"),
        )
        assertTrue(
            projector.apply(
                StreamEvent.MessageStopped(
                    messageId = "m-stop",
                    stopReason = "aborted",
                    errorClass = "ABORT",
                    errorCategory = "aborted",
                ),
            ),
        )

        val assistant = projector.messages.single { it.isAssistant }
        assertEquals("aborted", assistant.stopReason)
        assertEquals("ABORT", assistant.errorClass)
        assertTrue(isNeutralInterruption(assistant))
    }

    private fun historyMessage(
        id: String,
        role: String,
        content: String,
        createdAt: String,
        subagentRunId: String? = null,
    ): ChatMessage = ChatMessage(
        id = id,
        serverId = id,
        persistedId = id,
        role = role,
        content = content,
        createdAt = createdAt,
        subagentRunId = subagentRunId,
    )
}

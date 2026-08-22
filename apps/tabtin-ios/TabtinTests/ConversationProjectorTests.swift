import XCTest
@testable import Tabtin

/// ConversationProjector 单测：端到端驱动 envelope → WireDecoder → StreamSession → StreamUpdate
/// → projector，断言投射出的消息列表（正文 delta 合并、思考段、工具调用、流式收尾）。
final class ConversationProjectorTests: XCTestCase {
    private let decoder = WireDecoder()

    private func env(_ short: String, _ payload: [String: Any]) -> WSEnvelope {
        WSEnvelope.build(type: AgentStreamEvent.fullType(short), deviceId: "ios-test", payload: payload)
    }

    /// 起一轮（user + assistant 占位），把 envelopes 折叠成 StreamUpdate 喂进 projector。
    private func project(_ envelopes: [WSEnvelope]) -> ConversationProjector {
        var projector = ConversationProjector()
        projector.appendUserMessage(id: "evt_1", text: "在吗")
        projector.beginAssistant(id: "asst_1")
        var session = StreamSession()
        for e in envelopes {
            for update in session.ingest(decoder.decode(e)) {
                projector.apply(update)
            }
        }
        return projector
    }

    private func assistant(_ p: ConversationProjector) -> ChatMessage? {
        p.messages.first { $0.role == .assistant }
    }

    func testUserAndAssistantSeeded() {
        let p = project([])
        XCTAssertEqual(p.messages.count, 2)
        XCTAssertEqual(p.messages.first?.role, .user)
        XCTAssertEqual(p.messages.first?.text, "在吗")
        XCTAssertEqual(p.messages.last?.role, .assistant)
        XCTAssertTrue(p.messages.last?.isStreaming ?? false)
        XCTAssertTrue(p.isStreamingActive)
    }

    func testSeedFiltersLegacyAgentProfileContextFromLocalCache() {
        var projector = ConversationProjector()
        projector.seed([
            ChatMessage(
                id: "cached-profile",
                role: .user,
                text: "<context type=\"agent-profile\">profile</context>"
            ),
            ChatMessage(id: "real-user", role: .user, text: "继续处理"),
        ])

        XCTAssertEqual(projector.messages.map(\.id), ["real-user"])
    }

    func testRetryWithSameClientEventIdReusesOptimisticTurn() {
        var p = ConversationProjector()
        let clientId = "11111111-1111-4111-8111-111111111111"
        let assistantId = "asst_pending_\(clientId)"

        p.appendUserMessage(id: clientId, text: "请执行")
        p.beginAssistant(id: assistantId)
        p.failPendingOptimistic("连接中断")
        p.appendUserMessage(id: clientId, text: "请执行")
        p.beginAssistant(id: assistantId)

        XCTAssertEqual(p.messages.filter { $0.role == .user }.count, 1)
        XCTAssertEqual(p.messages.filter { $0.role == .assistant }.count, 1)
        XCTAssertNil(p.messages.first { $0.id == assistantId }?.errorMessage)
        XCTAssertTrue(p.messages.first { $0.id == assistantId }?.isStreaming ?? false)
    }

    /// 用户发出后，服务端/缓存同步可能按时间戳重排；本地的「已受理但未执行」错误卡
    /// 不能因此跑到触发它的 user 气泡上方（真机截图回归）。
    func testPendingExecutionErrorStaysImmediatelyAfterItsUserAcrossTimelineResort() {
        var p = ConversationProjector()
        let first = "client-first"
        let second = "client-second"
        let firstUserTime = Date(timeIntervalSince1970: 100)
        let secondUserTime = Date(timeIntervalSince1970: 200)

        p.appendUserMessage(id: first, text: "什么东东", createdAt: firstUserTime)
        p.beginAssistant(
            id: "asst_pending_\(first)",
            sourceClientEventId: first,
            // 模拟缓存/服务端时间漂移：错误卡时间比 user 早。
            createdAt: firstUserTime.addingTimeInterval(-1)
        )
        p.failPendingOptimistic("消息已受理，但暂未收到执行结果")

        p.appendUserMessage(id: second, text: "? bvb", createdAt: secondUserTime)
        p.beginAssistant(
            id: "asst_pending_\(second)",
            sourceClientEventId: second,
            createdAt: secondUserTime.addingTimeInterval(-1)
        )
        p.failPendingOptimistic("消息已受理，但暂未收到执行结果")

        // 一次外部历史合并会走完整时间线排序，覆盖真实的 cache/history 回放路径。
        XCTAssertTrue(p.mergeCommittedHistory([
            ChatMessage(
                id: "later-observed-user",
                role: .user,
                text: "后续消息",
                createdAt: Date(timeIntervalSince1970: 300)
            )
        ]))

        XCTAssertEqual(
            p.messages.map(\.id),
            [
                first,
                "asst_pending_\(first)",
                second,
                "asst_pending_\(second)",
                "later-observed-user",
            ]
        )
    }

    func testCachedPendingExecutionErrorStaysWithPersistedUserAfterSeed() {
        let clientEventId = "client-cached-turn"
        let userTime = Date(timeIntervalSince1970: 100)
        let cachedUser = CachedMessage.from(
            sessionId: "session-1",
            msg: ChatMessage(
                id: clientEventId,
                serverId: "server-user-1",
                persistedId: "server-user-1",
                clientEventId: clientEventId,
                role: .user,
                text: "缓存后的用户消息",
                createdAt: userTime
            )
        ).toChatMessage()
        let cachedError = CachedMessage.from(
            sessionId: "session-1",
            msg: ChatMessage(
                id: "asst_pending_\(clientEventId)",
                sourceClientEventId: clientEventId,
                role: .assistant,
                errorMessage: "消息已受理，但暂未收到执行结果",
                // 模拟旧缓存/服务端时间读回早于 user。
                createdAt: userTime.addingTimeInterval(-1)
            )
        ).toChatMessage()

        var p = ConversationProjector()
        p.seed([cachedError, cachedUser])

        XCTAssertEqual(
            p.messages.map(\.id),
            ["server-user-1", "asst_pending_\(clientEventId)"]
        )
    }

    func testSeedHidesLegacyAgentSwitchSystemNotice() {
        var p = ConversationProjector()
        p.seed([
            ChatMessage(
                id: "switch-notice",
                role: .system,
                text: "Agent 已切换成数据版"
            ),
            ChatMessage(
                id: "other-notice",
                role: .system,
                text: "上下文已压缩到此"
            ),
        ])

        XCTAssertEqual(p.messages.map(\.id), ["other-notice"])
    }

    func testAckBackfillsUserIdentityAndPersistedNakCanRemovePlaceholder() {
        var p = ConversationProjector()
        let clientId = "22222222-2222-4222-8222-222222222222"
        p.appendUserMessage(id: clientId, text: "跨端消息")
        p.beginAssistant(id: "asst_pending_\(clientId)")

        p.confirmUserMessage(clientEventId: clientId, serverMessageId: "server-user-id")
        p.removePendingOptimisticAssistant()

        XCTAssertEqual(p.messages.count, 1)
        XCTAssertEqual(p.messages.first?.serverId, "server-user-id")
        XCTAssertEqual(p.messages.first?.persistedId, "server-user-id")
        XCTAssertEqual(p.messages.first?.clientEventId, clientId)
    }

    func testComposerStopWithdrawsTurnWhenAssistantOnlyStartedThinking() {
        var p = ConversationProjector()
        let clientId = "55555555-5555-4555-8555-555555555555"
        p.appendUserMessage(id: clientId, text: "发错了")
        p.beginAssistant(id: "asst_pending_\(clientId)")
        p.apply(.thinking(messageId: nil, index: 0, text: "正在思考", completed: false))

        XCTAssertFalse(p.hasSubstantiveAssistantOutput(afterUserMessageId: clientId))
        p.withdrawUnansweredTurn(userMessageId: clientId)

        XCTAssertTrue(p.messages.isEmpty)
        XCTAssertFalse(p.isStreamingActive)
    }

    func testComposerStopKeepsTurnAfterAssistantHasVisibleOutput() {
        var p = ConversationProjector()
        let clientId = "66666666-6666-4666-8666-666666666666"
        p.appendUserMessage(id: clientId, text: "继续")
        p.beginAssistant(id: "asst_pending_\(clientId)")
        p.apply(.appendText(messageId: nil, index: 0, text: "已经开始回复"))

        XCTAssertTrue(p.hasSubstantiveAssistantOutput(afterUserMessageId: clientId))
        p.endStreaming()

        XCTAssertEqual(p.messages.count, 2)
        XCTAssertEqual(p.messages.last?.text, "已经开始回复")
        XCTAssertFalse(p.isStreamingActive)
    }

    @MainActor
    func testNakContractPreservesPersistedDeliveryIdentifiers() {
        let envelope = WSEnvelope.build(
            type: "chat.send_message.nak",
            deviceId: "ios-test",
            payload: [
                "error_code": "device_offline",
                "error_message": "执行未启动",
                "error_category": "device_offline",
                "retryable": true,
                "delivery": "persisted",
                "execution_state": "failed_after_persist",
                "message_id": "33333333-3333-4333-8333-333333333333",
                "client_event_id": "44444444-4444-4444-8444-444444444444",
            ],
            requestId: "nak-request"
        )

        let fields = RealtimeGateway.decodeNakFields(envelope)

        XCTAssertEqual(fields.code, "device_offline")
        XCTAssertTrue(fields.retryable)
        XCTAssertEqual(fields.delivery, "persisted")
        XCTAssertEqual(fields.executionState, "failed_after_persist")
        XCTAssertEqual(fields.messageId, "33333333-3333-4333-8333-333333333333")
        XCTAssertEqual(fields.clientEventId, "44444444-4444-4444-8444-444444444444")
    }

    @MainActor
    func testSubscribeErrorCorrelatesByRequestIdImmediately() {
        let envelope = WSEnvelope.build(
            type: "error",
            deviceId: "ios-test",
            payload: ["code": "WS_1005_PERMISSION_DENIED"],
            requestId: "subscribe-request"
        )

        XCTAssertEqual(
            RealtimeGateway.subscriptionKey(
                for: envelope,
                requestKeys: ["subscribe-request": "agent.stream.chat-session-test"]
            ),
            "agent.stream.chat-session-test"
        )
        XCTAssertNil(RealtimeGateway.subscriptionKey(for: envelope, requestKeys: ["other": "topic"]))
    }

    func testOutgoingStatusesOnlyAutoDrainBeforeAcceptance() {
        func message(_ status: QueuedOutgoingMessageStatus) -> QueuedOutgoingMessage {
            QueuedOutgoingMessage(
                id: "queue-id",
                clientEventId: "queue-id",
                sessionId: "session-id",
                text: "hello",
                modelId: "model-id",
                agentMode: "agent",
                blocks: nil,
                createdAt: .now,
                status: status,
                attemptCount: 0,
                lastError: nil,
                serverMessageId: nil,
                taskId: nil
            )
        }

        XCTAssertTrue(message(.waiting).isAutoDrainable)
        XCTAssertTrue(message(.sending).isAutoDrainable)
        XCTAssertTrue(message(.offline).isAutoDrainable)
        XCTAssertFalse(message(.accepted).isAutoDrainable)
        XCTAssertFalse(message(.awaitingDevice).isAutoDrainable)
        XCTAssertFalse(message(.failed).isAutoDrainable)
        XCTAssertTrue(message(.accepted).isAwaitingExecutionConfirmation)
        XCTAssertTrue(message(.awaitingDevice).isAwaitingExecutionConfirmation)
        XCTAssertFalse(message(.failed).isAwaitingExecutionConfirmation)
    }

    func testSessionRecoverySelectsEveryAcceptedOutgoingInFIFOOrder() {
        func message(_ id: String, _ status: QueuedOutgoingMessageStatus, _ offset: TimeInterval) -> QueuedOutgoingMessage {
            QueuedOutgoingMessage(
                id: id,
                clientEventId: "client-\(id)",
                sessionId: "session-id",
                text: "hello",
                modelId: "model-id",
                agentMode: "agent",
                blocks: nil,
                createdAt: Date(timeIntervalSince1970: offset),
                status: status,
                attemptCount: 0,
                lastError: nil,
                serverMessageId: "server-\(id)",
                taskId: nil
            )
        }

        let queue = [
            message("accepted-1", .accepted, 1),
            message("waiting", .waiting, 2),
            message("awaiting-device", .awaitingDevice, 3),
            message("accepted-2", .accepted, 4),
        ]

        XCTAssertEqual(
            QueuedOutgoingMessage.acceptedQueueIdsForReconciliation(in: queue),
            ["accepted-1", "awaiting-device", "accepted-2"]
        )
    }

    func testOutgoingHistoryUserAloneOnlyProvesPersistence() {
        let queued = QueuedOutgoingMessage(
            id: "client-1", clientEventId: "client-1", sessionId: "session-id",
            text: "hello", modelId: nil, agentMode: nil, blocks: nil, createdAt: .now,
            status: .accepted, attemptCount: 0, lastError: nil,
            serverMessageId: "server-user-1", taskId: nil
        )
        let history = [
            ChatMessage(
                id: "server-user-1", persistedId: "server-user-1",
                clientEventId: "client-1", role: .user, text: "hello"
            )
        ]

        XCTAssertEqual(
            QueuedOutgoingMessage.historyEvidence(for: queued, in: history),
            .persisted
        )
    }

    func testOutgoingHistoryAssistantAfterUserStillOnlyProvesPersistence() {
        let queued = QueuedOutgoingMessage(
            id: "client-1", clientEventId: "client-1", sessionId: "session-id",
            text: "hello", modelId: nil, agentMode: nil, blocks: nil, createdAt: .now,
            status: .awaitingDevice, attemptCount: 0, lastError: nil,
            serverMessageId: "server-user-1", taskId: "task-1"
        )
        let history = [
            ChatMessage(id: "server-user-1", clientEventId: "client-1", role: .user, text: "hello"),
            ChatMessage(id: "assistant-1", role: .assistant, text: "reply"),
            ChatMessage(id: "server-user-2", clientEventId: "client-2", role: .user, text: "next"),
        ]

        XCTAssertEqual(
            QueuedOutgoingMessage.historyEvidence(for: queued, in: history),
            .persisted
        )
    }

    func testOutgoingHistoryDoesNotBorrowAssistantFromNextTurn() {
        let queued = QueuedOutgoingMessage(
            id: "client-1", clientEventId: "client-1", sessionId: "session-id",
            text: "hello", modelId: nil, agentMode: nil, blocks: nil, createdAt: .now,
            status: .awaitingDevice, attemptCount: 0, lastError: nil,
            serverMessageId: nil, taskId: nil
        )
        let history = [
            ChatMessage(id: "client-1", clientEventId: "client-1", role: .user, text: "hello"),
            ChatMessage(id: "client-2", clientEventId: "client-2", role: .user, text: "next"),
            ChatMessage(id: "assistant-2", role: .assistant, text: "reply to next"),
        ]

        XCTAssertEqual(
            QueuedOutgoingMessage.historyEvidence(for: queued, in: history),
            .persisted
        )
    }

    func testOutgoingHistorySourceClientEventIdProvesExactExecutionStarted() {
        let queued = QueuedOutgoingMessage(
            id: "client-1", clientEventId: "client-1", sessionId: "session-id",
            text: "hello", modelId: nil, agentMode: nil, blocks: nil, createdAt: .now,
            status: .awaitingDevice, attemptCount: 0, lastError: nil,
            serverMessageId: "server-user-1", taskId: nil
        )
        let history = [
            ChatMessage(id: "server-user-1", clientEventId: "client-1", role: .user, text: "hello"),
            ChatMessage(
                id: "assistant-1", sourceClientEventId: "client-1",
                role: .assistant, text: "reply"
            ),
        ]

        XCTAssertEqual(
            QueuedOutgoingMessage.historyEvidence(for: queued, in: history),
            .executionStarted
        )
    }

    func testTextDeltasMergeIntoSingleBubble() {
        let p = project([
            env(AgentStreamEvent.lifecycle, ["phase": "executing"]),
            env(AgentStreamEvent.messageStart, ["message_id": "m1"]),
            env(AgentStreamEvent.contentBlockStart, ["message_id": "m1", "index": 0, "block": ["type": "text", "text": ""]]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m1", "index": 0, "delta": ["type": "text_delta", "text": "你好"]]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m1", "index": 0, "delta": ["type": "text_delta", "text": "，世界"]]),
            env(AgentStreamEvent.messageStop, ["message_id": "m1", "stop_reason": "end_turn"]),
            env(AgentStreamEvent.done, ["session_id": "s1", "stop_reason": "end_turn"]),
        ])
        XCTAssertEqual(p.messages.count, 2)  // 仍只有一条 assistant 气泡
        let a = assistant(p)
        XCTAssertEqual(a?.text, "你好，世界")
        XCTAssertEqual(a?.serverId, "m1")
        XCTAssertEqual(a?.stopReason, "end_turn")
        XCTAssertFalse(a?.isStreaming ?? true)   // done 后收尾
        XCTAssertFalse(p.isStreamingActive)
        XCTAssertNil(p.phase)                    // 收尾清相位
    }

    func testMidstreamDeltaWithoutMessageStartCreatesAssistantBubble() {
        // 旁观端中途进入会话时，可能已经错过 message_start，但后续 delta 仍带 message_id。
        // 这种情况下应按 message_id 懒建 assistant 气泡继续流式上屏，而不是静默丢掉正文。
        var p = ConversationProjector()
        p.apply(.appendText(messageId: "m_late", index: 1, text: "CLI"))

        XCTAssertEqual(p.messages.count, 1)
        let a = p.messages.first
        XCTAssertEqual(a?.role, .assistant)
        XCTAssertEqual(a?.id, "asst_m_late")
        XCTAssertEqual(a?.serverId, "m_late")
        XCTAssertEqual(a?.text, "CLI")
        XCTAssertTrue(a?.isStreaming ?? false)
        XCTAssertTrue(p.isStreamingActive)
    }

    func testThinkingSegmentTracked() {
        let p = project([
            env(AgentStreamEvent.contentBlockStart, ["index": 0, "block": ["type": "thinking", "thinking": "嗯", "signature": ""]]),
            env(AgentStreamEvent.contentBlockDelta, ["index": 0, "delta": ["type": "thinking_delta", "thinking": "让我想想"]]),
            env(AgentStreamEvent.contentBlockStop, ["index": 0]),
        ])
        let a = assistant(p)
        XCTAssertEqual(a?.thinking.count, 1)
        XCTAssertEqual(a?.thinking.first?.text, "嗯让我想想")
        XCTAssertEqual(a?.thinking.first?.completed, true)
        XCTAssertNotNil(a?.thinking.first?.startedAt)
        XCTAssertNotNil(a?.thinking.first?.stoppedAt)
        if let startedAt = a?.thinking.first?.startedAt,
           let stoppedAt = a?.thinking.first?.stoppedAt {
            XCTAssertGreaterThanOrEqual(stoppedAt, startedAt)
        }
    }

    func testStreamEndFinalizesThinkingWhenBlockStopIsMissing() {
        var p = project([
            env(AgentStreamEvent.contentBlockStart, [
                "index": 0,
                "block": ["type": "thinking", "thinking": "仍在分析", "signature": ""],
            ]),
        ])

        XCTAssertEqual(assistant(p)?.thinking.first?.completed, false)
        p.endStreaming()

        XCTAssertEqual(assistant(p)?.thinking.first?.completed, true)
        XCTAssertNotNil(assistant(p)?.thinking.first?.stoppedAt)
    }

    func testToolCallStartedThenFinalized() {
        let p = project([
            env(AgentStreamEvent.contentBlockStart, ["index": 1, "block": ["type": "tool_use", "id": "tu_1", "name": "shell", "input": [:]]]),
            env(AgentStreamEvent.contentBlockDelta, ["index": 1, "delta": ["type": "input_json_delta", "partial_json": "{\"cmd\":"]]),
            env(AgentStreamEvent.contentBlockDelta, ["index": 1, "delta": ["type": "input_json_delta", "partial_json": "\"ls\"}"]]),
            env(AgentStreamEvent.contentBlockStop, ["index": 1]),
        ])
        let a = assistant(p)
        XCTAssertEqual(a?.toolCalls.count, 1)
        let tool = a?.toolCalls.first
        XCTAssertEqual(tool?.toolCallId, "tu_1")
        XCTAssertEqual(tool?.name, "shell")
        XCTAssertEqual(tool?.inputJson, "{\"cmd\":\"ls\"}")
        XCTAssertEqual(tool?.finalized, true)
    }

    func testBlocksInterleaveInStreamOrder() {
        // 思考A(0) → 正文a(1) → 工具(2) → 思考B(3) → 正文b(4)：blocks 应严格按 index 穿插，
        // 不再「所有思考→所有正文→所有工具」分桶。
        let p = project([
            env(AgentStreamEvent.contentBlockStart, ["index": 0, "block": ["type": "thinking", "thinking": "想A", "signature": ""]]),
            env(AgentStreamEvent.contentBlockStop, ["index": 0]),
            env(AgentStreamEvent.contentBlockStart, ["index": 1, "block": ["type": "text", "text": ""]]),
            env(AgentStreamEvent.contentBlockDelta, ["index": 1, "delta": ["type": "text_delta", "text": "正文a"]]),
            env(AgentStreamEvent.contentBlockStart, ["index": 2, "block": ["type": "tool_use", "id": "tu_x", "name": "shell", "input": [:]]]),
            env(AgentStreamEvent.contentBlockStop, ["index": 2]),
            env(AgentStreamEvent.contentBlockStart, ["index": 3, "block": ["type": "thinking", "thinking": "想B", "signature": ""]]),
            env(AgentStreamEvent.contentBlockStop, ["index": 3]),
            env(AgentStreamEvent.contentBlockStart, ["index": 4, "block": ["type": "text", "text": ""]]),
            env(AgentStreamEvent.contentBlockDelta, ["index": 4, "delta": ["type": "text_delta", "text": "正文b"]]),
            env(AgentStreamEvent.done, ["session_id": "s1"]),
        ])
        let a = assistant(p)
        let kinds = a?.blocks.map { block -> String in
            switch block {
            case .thinking: return "think"
            case .text: return "text"
            case .tool: return "tool"
            case .attachment: return "attachment"
            case .richContent: return "rich"
            case .contextRef: return "context"
            }
        }
        XCTAssertEqual(kinds, ["think", "text", "tool", "think", "text"])
        // 派生视图仍可用（兼容 Canvas / 滚动信号）。
        XCTAssertEqual(a?.text, "正文a正文b")
        XCTAssertEqual(a?.thinking.count, 2)
        XCTAssertEqual(a?.toolCalls.count, 1)
    }

    func testAgenticTurnSplitsIntoMultipleBubbles() {
        // 多气泡：agentic 带 tool 轮里有多个 message_start，每个 message_start 应是一条独立助手气泡
        // （对齐 Electron / 旧 iOS）。首个 message_start 认领发送时建的乐观占位气泡，第二个新建气泡。
        // 同时回归：子轮 content_block index 从 0 重置，复合键 (messageId,index) 保证块 id 全局唯一。
        let p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m1"]),
            env(AgentStreamEvent.contentBlockStart, ["message_id": "m1", "index": 0, "block": ["type": "text", "text": ""]]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m1", "index": 0, "delta": ["type": "text_delta", "text": "查一下"]]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "m1", "index": 0]),
            env(AgentStreamEvent.contentBlockStart, ["message_id": "m1", "index": 1, "block": ["type": "tool_use", "id": "tu_1", "name": "shell", "input": [:]]]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "m1", "index": 1]),
            env(AgentStreamEvent.messageStop, ["message_id": "m1", "stop_reason": "tool_use"]),
            // 第二个子轮：index 重置回 0（这正是旧实现撞号的地方）。
            env(AgentStreamEvent.messageStart, ["message_id": "m2"]),
            env(AgentStreamEvent.contentBlockStart, ["message_id": "m2", "index": 0, "block": ["type": "text", "text": ""]]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m2", "index": 0, "delta": ["type": "text_delta", "text": "结果是这样"]]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "m2", "index": 0]),
            env(AgentStreamEvent.messageStop, ["message_id": "m2", "stop_reason": "end_turn"]),
            env(AgentStreamEvent.done, ["session_id": "s1"]),
        ])
        let bubbles = p.messages.filter { $0.role == .assistant }
        // user + 两条独立助手气泡
        XCTAssertEqual(p.messages.count, 3)
        XCTAssertEqual(bubbles.count, 2)

        // 气泡1（认领 m1）：正文 + 工具
        XCTAssertEqual(bubbles.first?.serverId, "m1")
        XCTAssertEqual(bubbles.first?.text, "查一下")
        XCTAssertEqual(bubbles.first?.toolCalls.count, 1)
        XCTAssertEqual(blockKinds(bubbles.first), ["text", "tool"])

        // 气泡2（新建 m2）：正文
        XCTAssertEqual(bubbles.last?.serverId, "m2")
        XCTAssertEqual(bubbles.last?.text, "结果是这样")
        XCTAssertEqual(blockKinds(bubbles.last), ["text"])

        // 跨气泡 block id 全局唯一（否则 SwiftUI ForEach 会重复渲染/抖动）。
        let allIds = bubbles.flatMap { $0.blocks.map(\.id) }
        XCTAssertEqual(allIds.count, Set(allIds).count, "block id 必须全局唯一")

        // 收尾后两条气泡都不再流式。
        XCTAssertFalse(bubbles.contains { $0.isStreaming })
        XCTAssertFalse(p.isStreamingActive)
    }

    private func blockKinds(_ message: ChatMessage?) -> [String] {
        (message?.blocks ?? []).map { block in
            switch block {
            case .thinking: return "think"
            case .text: return "text"
            case .tool: return "tool"
            case .attachment: return "attachment"
            case .richContent: return "rich"
            case .contextRef: return "context"
            }
        }
    }

    func testErrorMarksAssistantAndStopsStreaming() {
        let p = project([
            env(AgentStreamEvent.contentBlockDelta, ["index": 0, "delta": ["type": "text_delta", "text": "半句"]]),
            env(AgentStreamEvent.persistError, ["error": "device_offline"]),
        ])
        let a = assistant(p)
        XCTAssertEqual(a?.text, "半句")            // 已到的 delta 保留
        XCTAssertEqual(a?.errorMessage, "device_offline")
        XCTAssertFalse(a?.isStreaming ?? true)
        XCTAssertFalse(p.isStreamingActive)
    }

    func testReplaceWithHistoryReconcilesAndPreservesCards() {
        // 本轮收尾后（非流式）出现 seq-gap，用权威历史整体替换。
        var p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m1"]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m1", "index": 0, "delta": ["type": "text_delta", "text": "半"]]),
            env(AgentStreamEvent.done, ["session_id": "s1"]),
        ])
        // 注入一张本地未落库的提案卡（应被保留）。
        let card = ModeSwitchProposal(proposalId: "x", targetModeId: .agent, reason: "切到 Agent")
        p.appendProposalCard(.modeSwitch(card))
        XCTAssertFalse(p.isStreamingActive)

        let base = Date()
        let history = [
            ChatMessage(id: "db_u", serverId: "db_u", persistedId: "db_u", role: .user,
                        text: "在吗", isStreaming: false, createdAt: base),
            ChatMessage(id: "db_a", serverId: "db_a", persistedId: "db_a", role: .assistant,
                        blocks: [.text(TextBlock(messageId: "db_a", index: 0, text: "半句完整"))],
                        isStreaming: false, createdAt: base.addingTimeInterval(1)),
        ]
        p.replaceWithHistory(history)

        // user + assistant（权威历史）+ 保留的提案卡 = 3 条，且无重复 user。
        XCTAssertEqual(p.messages.count, 3)
        XCTAssertEqual(p.messages.filter { $0.role == .user }.count, 1)
        let persisted = p.messages.first { $0.serverId == "db_a" }
        XCTAssertEqual(persisted?.text, "半句完整")            // 缺口被权威历史校正
        XCTAssertTrue(p.messages.contains { $0.modeSwitchProposal != nil })
    }

    func testReplaceWithHistoryNoOpWhileStreaming() {
        // 流进行中拒绝整体替换（避免冲掉进行中气泡）。
        let p = project([
            env(AgentStreamEvent.contentBlockDelta, ["index": 0, "delta": ["type": "text_delta", "text": "进行中"]]),
        ])
        XCTAssertTrue(p.isStreamingActive)
        var q = p
        q.replaceWithHistory([
            ChatMessage(id: "db_a", role: .assistant, text: "其他", isStreaming: false),
        ])
        XCTAssertEqual(assistant(q)?.text, "进行中")  // 未被替换
    }

    func testSubagentTranscriptHistoryIsFilteredFromMainTimeline() {
        var p = ConversationProjector()
        let base = Date()

        XCTAssertTrue(p.replaceWithHistory([
            ChatMessage(id: "parent", role: .assistant, text: "父会话回答", isStreaming: false, createdAt: base),
            ChatMessage(
                id: "child",
                role: .assistant,
                text: "子 Agent 详情",
                isStreaming: false,
                subagentRunId: "run-child",
                createdAt: base.addingTimeInterval(1)
            ),
        ]))

        XCTAssertEqual(p.messages.map(\.id), ["parent"])
    }

    func testEmptyAuthoritativeHistoryClearsStaleCachedMessages() {
        var p = ConversationProjector()
        XCTAssertTrue(p.replaceWithHistory([
            ChatMessage(id: "stale", role: .assistant, text: "旧缓存", isStreaming: false)
        ]))

        XCTAssertTrue(p.replaceWithHistory([]))

        XCTAssertTrue(p.messages.isEmpty)
    }

    func testFocusedHistoryReplacesDistantLatestWindow() {
        var p = ConversationProjector()
        XCTAssertTrue(p.replaceWithHistory([
            ChatMessage(id: "latest", role: .assistant, text: "最新回复", isStreaming: false)
        ]))

        XCTAssertTrue(p.replaceWithFocusedHistory([
            ChatMessage(id: "before", role: .user, text: "很早的问题", isStreaming: false),
            ChatMessage(id: "target", role: .assistant, text: "目标回复", isStreaming: false),
            ChatMessage(id: "after", role: .user, text: "后续追问", isStreaming: false),
        ]))

        XCTAssertEqual(p.messages.map(\.id), ["before", "target", "after"])
        XCTAssertFalse(p.messages.contains { $0.id == "latest" })
    }

    func testFocusedHistoryDropsCachedTailRemovedByRollback() {
        var p = ConversationProjector()
        XCTAssertTrue(p.replaceWithHistory([
            historyMsg("u1", .user, "第一问", 100),
            historyMsg("a1", .assistant, "第一答", 101),
            historyMsg("u2", .user, "已回退的问题", 102),
            historyMsg("a2", .assistant, "已回退的回答", 103),
        ]))

        XCTAssertTrue(p.replaceWithFocusedHistory([
            historyMsg("u1", .user, "第一问", 100),
            historyMsg("a1", .assistant, "第一答", 101),
        ]))

        XCTAssertEqual(p.messages.map(\.id), ["u1", "a1"])
    }

    func testMessagePersistedBackfillsId() {
        let p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m9"]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m9", "index": 0, "delta": ["type": "text_delta", "text": "ok"]]),
            env(AgentStreamEvent.messagePersisted, ["message_id": "m9", "persisted_id": "db_42"]),
            env(AgentStreamEvent.done, ["session_id": "s1"]),
        ])
        let a = assistant(p)
        XCTAssertEqual(a?.persistedId, "db_42")
        XCTAssertEqual(a?.effectiveId, "db_42")
    }

    func testMessageCommittedBackfillsServerId() {
        let p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m10"]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m10", "index": 0, "delta": ["type": "text_delta", "text": "ok"]]),
            env(AgentStreamEvent.messageCommitted, ["message_id": "m10", "server_id": "db_43"]),
        ])
        let a = assistant(p)
        XCTAssertEqual(a?.serverId, "db_43")
        XCTAssertEqual(a?.persistedId, "db_43")
        XCTAssertEqual(a?.effectiveId, "db_43")
    }

    func testMessageStartCarriesAuthoritativeAgentIdentityIntoBubble() {
        let p = project([
            env(AgentStreamEvent.messageStart, [
                "message_id": "m-agent",
                "agent_id": "agent-authoritative",
            ]),
            env(AgentStreamEvent.contentBlockDelta, [
                "message_id": "m-agent",
                "index": 0,
                "delta": ["type": "text_delta", "text": "你好"],
            ]),
        ])

        XCTAssertEqual(assistant(p)?.agentId, "agent-authoritative")
    }

    /// ：乐观占位在无 message_start 时也应带上执行 agentId，头像立刻可画。
    func testOptimisticBeginAssistantWritesAgentIdWithoutMessageStart() {
        var p = ConversationProjector()
        p.beginAssistant(id: "asst_pending_evt", agentId: "agent-exec")
        XCTAssertEqual(p.messages.first { $0.role == .assistant }?.agentId, "agent-exec")
        XCTAssertTrue(p.hasPendingOptimistic)
    }

    /// ：replaceWithHistory 后重放同 message_id 的 message_start，不得再新建一条。
    func testReplaceWithHistoryThenSameMessageStartDoesNotDuplicate() {
        var p = ConversationProjector()
        let history = [
            ChatMessage(
                id: "u1",
                serverId: "u1",
                persistedId: "u1",
                role: .user,
                text: "在吗",
                createdAt: Date(timeIntervalSince1970: 100)
            ),
            ChatMessage(
                id: "a1",
                serverId: "a1",
                persistedId: "a1",
                role: .assistant,
                agentId: "agent-1",
                text: "在的",
                isStreaming: false,
                createdAt: Date(timeIntervalSince1970: 101)
            ),
        ]
        XCTAssertTrue(p.replaceWithHistory(history))
        let countBefore = p.messages.count

        p.apply(.messageStarted(messageId: "a1", agentId: "agent-1"))

        XCTAssertEqual(p.messages.count, countBefore)
        XCTAssertEqual(p.messages.filter { $0.role == .assistant }.count, 1)
        XCTAssertEqual(p.messages.first { $0.role == .assistant }?.effectiveId, "a1")
    }

    func testUnclaimedMessageCommittedDoesNotMutateActiveBubble() {
        var p = ConversationProjector()
        p.apply(.messageStarted(messageId: "m2"))
        p.apply(.appendText(messageId: "m2", index: 0, text: "active"))

        p.apply(.messageCommitted(messageId: "m1", serverId: "db_m1"))

        let active = p.messages.first { $0.serverId == "m2" }
        XCTAssertEqual(active?.text, "active")
        XCTAssertNil(active?.persistedId)
        XCTAssertFalse(p.messages.contains { $0.persistedId == "db_m1" })
    }

    // MARK: - 增量对账（内容全等不动数组）

    private func historyMsg(_ id: String, _ role: ChatRole, _ text: String, _ t: TimeInterval) -> ChatMessage {
        ChatMessage(id: id, serverId: id, persistedId: id, role: role,
                    text: text, isStreaming: false, createdAt: Date(timeIntervalSince1970: t))
    }

    func testReplaceWithHistoryReturnsFalseWhenUnchanged() {
        var p = ConversationProjector()
        let hist = [historyMsg("u1", .user, "在吗", 100), historyMsg("a1", .assistant, "在的", 101)]
        // 初次：空 → seed 仍走 replaceWithHistory？这里直接 replace 一次填充。
        XCTAssertTrue(p.replaceWithHistory(hist))            // 空→有，确实改了
        // 再来一份内容全等的历史 → 不动数组、返回 false（缓存秒显后 HTTP 对账一致＝零重渲染）。
        XCTAssertFalse(p.replaceWithHistory(hist))
        XCTAssertEqual(p.messages.count, 2)
    }

    func testReplaceWithHistoryMergeBranchPreservesEarlierPages() {
        // 用户已上拉加载多页（5 条），权威「最新页」只回 2 条 → 走 upsert 合并，保住更早 3 条。
        var p = ConversationProjector()
        let loaded = (1...5).map { historyMsg("m\($0)", $0 % 2 == 0 ? .assistant : .user, "msg\($0)", Double(100 + $0)) }
        XCTAssertTrue(p.replaceWithHistory(loaded))
        XCTAssertEqual(p.messages.count, 5)

        // 最新页：m4/m5 内容被服务端订正（m5 文本变化）。
        let latestPage = [
            historyMsg("m4", .assistant, "msg4", 104),
            historyMsg("m5", .user, "msg5-fixed", 105),
        ]
        XCTAssertTrue(p.replaceWithHistory(latestPage))
        XCTAssertEqual(p.messages.count, 5)                  // 更早 3 条没被冲掉
        XCTAssertEqual(p.messages.last?.text, "msg5-fixed")  // 最新页订正生效
        XCTAssertEqual(p.messages.map(\.effectiveId), ["m1", "m2", "m3", "m4", "m5"])  // 顺序保持
    }

    func testPrependHistoryDedupsAndOrders() {
        var p = ConversationProjector()
        XCTAssertTrue(p.replaceWithHistory([
            historyMsg("m3", .user, "三", 103),
            historyMsg("m4", .assistant, "四", 104),
        ]))
        XCTAssertEqual(p.oldestServerId, "m3")

        // 前插更早一页（含一条与现有重叠的 m3，应去重）。
        let added = p.prependHistory([
            historyMsg("m1", .user, "一", 101),
            historyMsg("m2", .assistant, "二", 102),
            historyMsg("m3", .user, "三", 103),   // 重复
        ])
        XCTAssertEqual(added, 2)                              // m3 去重，只加 2
        XCTAssertEqual(p.messages.map(\.effectiveId), ["m1", "m2", "m3", "m4"])
        XCTAssertEqual(p.oldestServerId, "m1")
    }

    func testMergeHistoryDeltaUpdatesExistingAssistantWithoutReplacingTimeline() {
        var p = ConversationProjector()
        let base = [
            historyMsg("u1", .user, "问一下", 100),
            historyMsg("a1", .assistant, "partial", 101),
            historyMsg("u2", .user, "后一条", 102),
        ]
        XCTAssertTrue(p.replaceWithHistory(base))

        let delta = [historyMsg("a1", .assistant, "final answer", 101)]
        XCTAssertTrue(p.mergeHistoryDelta(delta))

        XCTAssertEqual(p.messages.count, 3)
        XCTAssertEqual(p.messages.map(\.effectiveId), ["u1", "a1", "u2"])
        XCTAssertEqual(p.messages.first { $0.effectiveId == "a1" }?.text, "final answer")
    }

    func testMergeHistoryDeltaDedupsOptimisticUserByClientEventId() {
        var p = ConversationProjector()
        let clientEventId = "client-u1"
        let createdAt = Date(timeIntervalSince1970: 100)
        p.appendUserMessage(id: clientEventId, text: "mobile prompt", createdAt: createdAt)

        let server = ChatMessage(
            id: "db-u1",
            serverId: "db-u1",
            persistedId: "db-u1",
            clientEventId: clientEventId,
            role: .user,
            text: "mobile prompt",
            isStreaming: false,
            createdAt: createdAt.addingTimeInterval(1)
        )
        XCTAssertTrue(p.mergeHistoryDelta([server]))

        XCTAssertEqual(p.messages.count, 1)
        let merged = p.messages[0]
        XCTAssertEqual(merged.id, clientEventId)
        XCTAssertEqual(merged.serverId, "db-u1")
        XCTAssertEqual(merged.persistedId, "db-u1")
        XCTAssertEqual(merged.clientEventId, clientEventId)
        XCTAssertEqual(merged.text, "mobile prompt")
    }

    func testReconnectReplaceCanSettleDeadStreamingAssistant() {
        var p = ConversationProjector()
        p.beginAssistant(id: "asst-streaming")
        XCTAssertTrue(p.isStreamingActive)

        XCTAssertTrue(p.replaceWithHistory([
            historyMsg("a1", .assistant, "server final", 101),
        ], allowWhileStreaming: true))

        XCTAssertEqual(p.messages.count, 1)
        XCTAssertEqual(p.messages[0].text, "server final")
        XCTAssertFalse(p.isStreamingActive)
    }

    func testMergeHistoryDeltaNoOpWhileStreaming() {
        var p = ConversationProjector()
        p.beginAssistant(id: "asst-streaming")
        XCTAssertTrue(p.isStreamingActive)

        XCTAssertFalse(p.mergeHistoryDelta([
            historyMsg("a1", .assistant, "server final", 101),
        ]))

        XCTAssertEqual(p.messages.count, 1)
        XCTAssertEqual(p.messages[0].id, "asst-streaming")
        XCTAssertTrue(p.messages[0].isStreaming)
    }

    func testMergeCommittedHistoryWorksWhileNextMessageIsStreaming() {
        var p = ConversationProjector()
        XCTAssertTrue(p.replaceWithHistory([
            historyMsg("u1", .user, "问一下", 100),
            historyMsg("a1", .assistant, "partial", 101),
        ]))

        p.apply(.messageStarted(messageId: "m2"))
        p.apply(.appendText(messageId: "m2", index: 0, text: "下一条"))
        XCTAssertTrue(p.isStreamingActive)

        XCTAssertTrue(p.mergeCommittedHistory([
            historyMsg("a1", .assistant, "final answer", 101),
        ]))

        XCTAssertEqual(p.messages.first { $0.effectiveId == "a1" }?.text, "final answer")
        let streaming = p.messages.first { $0.serverId == "m2" }
        XCTAssertEqual(streaming?.text, "下一条")
        XCTAssertTrue(streaming?.isStreaming ?? false)

        p.apply(.appendText(messageId: "m2", index: 0, text: "继续"))
        XCTAssertEqual(p.messages.first { $0.serverId == "m2" }?.text, "下一条继续")
    }

    ///  倾泻根因：`message_committed` 对账命中的是**正在流式的那一条**时，
    /// 旧实现把本地气泡整行换成服务端中途快照，`messageId → 气泡` 路由随即指向
    /// 一条不存在的行，后续 delta 全被 `updateBubble` 静默丢弃，直到收尾才一次性灌入全文。
    func testCommittedHistoryOfTheStreamingMessageKeepsAcceptingDeltas() {
        var p = ConversationProjector()
        p.appendUserMessage(id: "evt-long", text: "写一段长文")
        p.beginAssistant(id: "asst_pending_evt-long")
        p.apply(.messageStarted(messageId: "m1"))
        p.apply(.appendText(messageId: "m1", index: 0, text: "第一段"))
        p.apply(.appendText(messageId: "m1", index: 0, text: "第二段"))

        let localBubbleId = p.messages.first { $0.role == .assistant }?.id

        // 服务端此刻只落了前半段，是中途快照而不是权威全文。
        XCTAssertTrue(p.mergeCommittedHistory([
            ChatMessage(
                id: "m1",
                serverId: "m1",
                persistedId: "db_m1",
                role: .assistant,
                blocks: [.text(TextBlock(messageId: "m1", index: 0, text: "第一段"))],
                isStreaming: false
            ),
        ]))

        p.apply(.appendText(messageId: "m1", index: 0, text: "第三段"))

        let bubble = p.messages.first { $0.role == .assistant }
        XCTAssertEqual(p.messages.filter { $0.role == .assistant }.count, 1)
        XCTAssertEqual(bubble?.id, localBubbleId, "流式期不得替换本地气泡 id，否则路由变幽灵")
        XCTAssertEqual(bubble?.text, "第一段第二段第三段", "合并后续 delta 必须继续追加，而不是收尾倾泻")
        XCTAssertTrue(bubble?.isStreaming ?? false, "中途快照的 isStreaming=false 不得停掉本地流")
        XCTAssertEqual(bubble?.persistedId, "db_m1")
        XCTAssertEqual(bubble?.serverId, "m1")
    }

    /// 流式期即使服务端快照更长也不抢写正文；缺失部分继续由 live delta 平滑补齐。
    func testCommittedHistoryDefersRicherServerSnapshotWithoutBreakingRouting() {
        var p = ConversationProjector()
        p.apply(.messageStarted(messageId: "m1"))
        p.apply(.appendText(messageId: "m1", index: 0, text: "开头"))
        let localBubbleId = p.messages.first { $0.role == .assistant }?.id

        XCTAssertTrue(p.mergeCommittedHistory([
            ChatMessage(
                id: "m1",
                serverId: "m1",
                persistedId: "m1",
                role: .assistant,
                blocks: [.text(TextBlock(messageId: "m1", index: 0, text: "开头补齐的中段"))],
                isStreaming: false
            ),
        ]))

        XCTAssertEqual(
            p.messages.first { $0.role == .assistant }?.text,
            "开头",
            "committed 快照不得越过仍在 WS 队列里的 delta 抢写流式正文"
        )

        p.apply(.appendText(messageId: "m1", index: 0, text: "补齐的中段结尾"))

        let bubble = p.messages.first { $0.role == .assistant }
        XCTAssertEqual(bubble?.id, localBubbleId)
        XCTAssertEqual(bubble?.text, "开头补齐的中段结尾")
        XCTAssertTrue(bubble?.isStreaming ?? false)
    }

    /// ：可靠 `message_committed` 可能越过仍在 WS 队列里的高频 text delta。
    /// HTTP 快照若先把迟到后缀物化进流式气泡，后缀到达时就会被追加第二次；终态
    /// 全量历史虽会校正，但用户会先看到整段倾泻、再看到同一段重新流式输出。
    func testCommittedSnapshotDoesNotDoubleMaterializeDelayedLiveSuffix() {
        var p = ConversationProjector()
        let prefix = "| 序号 | 工具 | 结果 |\n| --- | --- | --- |\n"
        let delayedSuffix = "| 10 | ls -la | ✅ 目录为空 |\n\n总结：10 个调用中 9 成功，1 失败。"

        p.apply(.messageStarted(messageId: "m1"))
        p.apply(.appendText(messageId: "m1", index: 0, text: prefix))

        XCTAssertTrue(p.mergeCommittedHistory([
            ChatMessage(
                id: "m1",
                serverId: "m1",
                persistedId: "m1",
                role: .assistant,
                blocks: [.text(TextBlock(messageId: "m1", index: 0, text: prefix + delayedSuffix))],
                isStreaming: false
            ),
        ]))

        // 这段 delta 在 committed HTTP 快照之后才从 WS 队列出队，但语义上只应物化一次。
        p.apply(.appendText(messageId: "m1", index: 0, text: delayedSuffix))

        let bubble = p.messages.first { $0.role == .assistant }
        XCTAssertEqual(bubble?.text, prefix + delayedSuffix)
        XCTAssertTrue(bubble?.isStreaming ?? false)
    }

    /// relay 先落 persist_message / message_committed，再在 ACK 后广播原始六件套。
    /// 有乐观占位时，committed 全文不得先追加成第二条 assistant；首个 message_start
    /// 仍应认领占位，后续 delta 只物化一次。
    func testCommittedBeforeLiveDoesNotDuplicateOptimisticAssistant() {
        var p = ConversationProjector()
        let clientEventId = "client-long-turn"
        let prefix = "先列出结果。\n\n"
        let suffix = "| 10 | ls -la | ✅ |\n\n总结完成。"
        let committed = ChatMessage(
            id: "m1",
            serverId: "m1",
            persistedId: "m1",
            sourceClientEventId: clientEventId,
            role: .assistant,
            blocks: [.text(TextBlock(messageId: "m1", index: 0, text: prefix + suffix))],
            isStreaming: false
        )

        p.beginAssistant(
            id: "asst_pending_\(clientEventId)",
            sourceClientEventId: clientEventId
        )

        XCTAssertFalse(p.mergeCommittedHistory([committed]))
        XCTAssertEqual(p.messages.filter { $0.role == .assistant }.count, 1)
        XCTAssertEqual(p.messages.first?.text, "")

        p.apply(.messageStarted(messageId: "m1"))
        // committed 的 1s 重试此时可以闭合身份，但仍不能抢写正文。
        XCTAssertTrue(p.mergeCommittedHistory([committed]))
        XCTAssertEqual(p.messages.first?.text, "")
        p.apply(.appendText(messageId: "m1", index: 0, text: prefix))
        p.apply(.appendText(messageId: "m1", index: 0, text: suffix))

        let assistants = p.messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants.first?.id, "asst_pending_\(clientEventId)")
        XCTAssertEqual(assistants.first?.text, prefix + suffix)
        XCTAssertTrue(assistants.first?.isStreaming ?? false)
    }

    /// 观察端没有乐观占位时也不能把 committed 全文先画出来；message_start 到达后
    /// 再创建唯一 live 气泡，避免在权威全文后把同一批 delta 从头重放。
    func testCommittedBeforeLiveDoesNotPreMaterializeObserverAssistant() {
        var p = ConversationProjector()
        let fullText = "第一段\n\n第二段\n\n最终总结"
        let committed = ChatMessage(
            id: "m-observer",
            serverId: "m-observer",
            persistedId: "m-observer",
            role: .assistant,
            blocks: [.text(TextBlock(messageId: "m-observer", index: 0, text: fullText))],
            isStreaming: false
        )

        XCTAssertFalse(p.mergeCommittedHistory([committed]))
        XCTAssertTrue(p.messages.isEmpty)

        p.apply(.messageStarted(messageId: "m-observer"))
        p.apply(.appendText(messageId: "m-observer", index: 0, text: "第一段\n\n"))
        p.apply(.appendText(messageId: "m-observer", index: 0, text: "第二段\n\n最终总结"))

        let assistants = p.messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(assistants.first?.text, fullText)
        XCTAssertTrue(assistants.first?.isStreaming ?? false)
    }

    /// 流式期让 live 单写不等于放弃 HTTP 兜底：真实 seq gap 等到终态后仍由权威历史补齐。
    func testTerminalHistoryRepairsSnapshotDeferredWhileStreaming() {
        var p = ConversationProjector()
        let localPrefix = "已收到的前半段"
        let authoritativeText = localPrefix + "，以及弱网期间漏掉的后半段"
        let history = ChatMessage(
            id: "m1",
            serverId: "m1",
            persistedId: "m1",
            role: .assistant,
            blocks: [.text(TextBlock(messageId: "m1", index: 0, text: authoritativeText))],
            isStreaming: false
        )

        p.apply(.messageStarted(messageId: "m1"))
        p.apply(.appendText(messageId: "m1", index: 0, text: localPrefix))
        XCTAssertTrue(p.mergeCommittedHistory([history]))
        XCTAssertEqual(p.messages.first?.text, localPrefix)

        p.apply(.done(stopReason: "end_turn", errorInfo: nil))
        XCTAssertFalse(p.isStreamingActive)
        XCTAssertTrue(p.replaceWithHistory([history]))
        XCTAssertEqual(p.messages.first?.text, authoritativeText)
    }

    /// 已收尾的气泡被服务端行整行替换后（id 变了），迟到 / 重放事件仍应命中同一条气泡。
    func testCommittedHistoryRemapsRoutingAfterServerRowReplacesFinishedBubble() {
        var p = ConversationProjector()
        p.apply(.messageStarted(messageId: "m1"))
        p.apply(.appendText(messageId: "m1", index: 0, text: "第一段"))
        p.apply(.messageStop(messageId: "m1", stopReason: "end_turn"))

        XCTAssertTrue(p.mergeCommittedHistory([
            ChatMessage(
                id: "m1",
                serverId: "m1",
                persistedId: "db_m1",
                role: .assistant,
                blocks: [.text(TextBlock(messageId: "m1", index: 0, text: "第一段"))],
                isStreaming: false
            ),
        ]))

        p.apply(.appendText(messageId: "m1", index: 1, text: "补充"))

        XCTAssertEqual(p.messages.filter { $0.role == .assistant }.count, 1)
        XCTAssertEqual(p.messages.first { $0.role == .assistant }?.text, "第一段补充")
    }

    func testCommittedOptimisticUserStaysBeforeStreamingAssistant() {
        var p = ConversationProjector()
        let clientEventId = "client-current-turn"
        let localUserTime = Date(timeIntervalSince1970: 100)
        let assistantTime = Date(timeIntervalSince1970: 101)
        let serverUserTime = Date(timeIntervalSince1970: 102)

        p.appendUserMessage(
            id: clientEventId,
            text: "刚发出的消息",
            createdAt: localUserTime
        )
        p.beginAssistant(id: "assistant-current-turn", createdAt: assistantTime)

        let committedUser = ChatMessage(
            id: "server-user-current-turn",
            serverId: "server-user-current-turn",
            persistedId: "server-user-current-turn",
            clientEventId: clientEventId,
            role: .user,
            text: "刚发出的消息",
            isStreaming: false,
            createdAt: serverUserTime
        )
        XCTAssertTrue(p.mergeCommittedHistory([committedUser]))

        XCTAssertEqual(p.messages.map(\.role), [.user, .assistant])
        XCTAssertEqual(p.messages.first?.createdAt, localUserTime)
        XCTAssertTrue(p.messages.last?.isStreaming ?? false)

        p.endStreaming()
        XCTAssertTrue(p.replaceWithHistory([
            committedUser,
            ChatMessage(
                id: "server-assistant-current-turn",
                serverId: "server-assistant-current-turn",
                persistedId: "server-assistant-current-turn",
                role: .assistant,
                text: "完整回复",
                isStreaming: false,
                createdAt: serverUserTime.addingTimeInterval(1)
            ),
        ]))
        XCTAssertEqual(p.messages.map(\.role), [.user, .assistant])
        // 收尾对账也保住更早的乐观发出时刻，避免被服务端入库时间覆盖后乱序。
        XCTAssertEqual(p.messages.first?.createdAt, localUserTime)
    }

    /// 回归：服务端把 user.created_at 写成晚于本轮 assistant 时，收尾 replaceWithHistory
    /// 不得把用户气泡甩到 AI 回复下面（真机「666」复现）。
    func testReplaceWithHistoryKeepsUserBeforeAssistantWhenServerTimestampsInvert() {
        var p = ConversationProjector()
        let clientEventId = "client-666"
        let localUserTime = Date(timeIntervalSince1970: 200)
        let assistantTime = Date(timeIntervalSince1970: 201)
        // 服务端入库时间晚于已上屏的 assistant（常先开流再落库 user）。
        let serverUserTime = Date(timeIntervalSince1970: 205)

        p.appendUserMessage(id: clientEventId, text: "666", createdAt: localUserTime)
        p.beginAssistant(id: "asst_pending_\(clientEventId)", createdAt: assistantTime)
        p.apply(.messageStarted(messageId: "server-asst-666"))
        p.apply(.appendText(messageId: "server-asst-666", index: 0, text: "哈哈，这 666"))
        p.endStreaming()

        let serverUser = ChatMessage(
            id: "server-user-666",
            serverId: "server-user-666",
            persistedId: "server-user-666",
            clientEventId: clientEventId,
            role: .user,
            text: "666",
            createdAt: serverUserTime
        )
        let serverAssistant = ChatMessage(
            id: "server-asst-666",
            serverId: "server-asst-666",
            persistedId: "server-asst-666",
            role: .assistant,
            text: "哈哈，这 666",
            createdAt: assistantTime
        )

        XCTAssertTrue(p.replaceWithHistory([serverUser, serverAssistant]))
        XCTAssertEqual(p.messages.map(\.role), [.user, .assistant])
        XCTAssertEqual(p.messages.first?.text, "666")
        XCTAssertEqual(p.messages.first?.createdAt, localUserTime)
        XCTAssertTrue(p.messages.last?.text.contains("666") ?? false)
    }

    func testPrependHistoryNoNewReturnsZero() {
        var p = ConversationProjector()
        XCTAssertTrue(p.replaceWithHistory([historyMsg("m1", .user, "一", 101)]))
        XCTAssertEqual(p.prependHistory([historyMsg("m1", .user, "一", 101)]), 0)
        XCTAssertEqual(p.messages.count, 1)
    }

    func testToolLifecycleProjectsPhaseProgressDurationSafetyAndApproval() {
        let p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m-tool"]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "m-tool",
                "index": 1,
                "block": ["type": "tool_use", "id": "tool-1", "name": "shell", "input": [:]],
            ]),
            env(AgentStreamEvent.contentBlockDelta, [
                "message_id": "m-tool",
                "index": 1,
                "delta": ["type": "input_json_delta", "partial_json": #"{"command":"xcodebuild"}"#],
            ]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "m-tool", "index": 1]),
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "tool_started",
                "tool_name": "shell",
                "tool_call_id": "tool-1",
            ]),
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "tool_progress",
                "tool_name": "shell",
                "tool_call_id": "tool-1",
                "stdout": "Compile Swift\n",
                "output_bytes": 512,
                "truncated": true,
            ]),
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "tool_completed",
                "tool_name": "shell",
                "tool_call_id": "tool-1",
                "output": "Build succeeded",
                "duration_ms": 1_250,
                "suspicious": true,
            ]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "m-tool-result",
                "index": 0,
                "block": [
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "content": """
                    <approval_note>
                    User approved tool 'shell'.
                    </approval_note>

                    Build succeeded
                    """,
                    "is_error": false,
                ],
            ]),
            // 终态后的迟到快照必须被丢弃，不能让工具复活为 running。
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "tool_progress",
                "tool_name": "shell",
                "tool_call_id": "tool-1",
                "stdout": "stale",
            ]),
        ])

        guard let tool = assistant(p)?.toolCalls.first(where: { $0.toolCallId == "tool-1" }) else {
            return XCTFail("expected projected tool")
        }
        XCTAssertTrue(tool.finalized, "content block finalized only means args completed")
        XCTAssertEqual(tool.resolvedExecutionPhase, .succeeded)
        XCTAssertEqual(tool.durationMs, 1_250)
        XCTAssertEqual(tool.progressText, "Compile Swift\n")
        XCTAssertEqual(tool.progressOutputBytes, 512)
        XCTAssertTrue(tool.progressIsTruncated)
        XCTAssertTrue(tool.hasSuspiciousOutput)
        XCTAssertEqual(tool.approvalSource, .user)
        XCTAssertEqual(tool.resultText, "Build succeeded")
    }

    func testSSHOutputAppendsAndMonitorUsesStableRowWhileRuntimeStepStaysOutOfTools() {
        let p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m-runtime"]),
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "tool_started",
                "tool_name": "ssh_execute",
                "tool_call_id": "tool-ssh",
                "task_id": "task-ssh",
            ]),
            env(AgentStreamEvent.sshOutput, [
                "data": "first\n",
                "tool_call_id": "tool-ssh",
                "task_id": "task-ssh",
            ]),
            env(AgentStreamEvent.sshOutput, [
                "data": "second\n",
                "tool_call_id": "tool-ssh",
                "task_id": "task-ssh",
            ]),
            env(AgentStreamEvent.step, [
                "step_type": "thinking",
                "title": "分析",
                "status": "running",
                "step_id": "step-stable",
            ]),
            env(AgentStreamEvent.step, [
                "step_type": "thinking",
                "title": "分析",
                "status": "done",
                "step_id": "step-stable",
            ]),
            env(AgentStreamEvent.monitorStatus, [
                "monitor_id": "monitor-stable",
                "description": "观察构建",
                "command": "xcodebuild",
                "status": "running",
            ]),
            env(AgentStreamEvent.monitorStatus, [
                "monitor_id": "monitor-stable",
                "description": "观察构建",
                "command": "xcodebuild",
                "status": "stream_ended",
            ]),
        ])

        let tools = assistant(p)?.toolCalls ?? []
        let ssh = tools.first { $0.toolCallId == "tool-ssh" }
        XCTAssertEqual(ssh?.progressText, "first\nsecond\n")
        XCTAssertEqual(ssh?.resolvedExecutionPhase, .running)

        XCTAssertFalse(tools.contains { $0.name == "runtime_step" })

        let monitors = tools.filter { $0.toolCallId == "monitor:monitor-stable" }
        XCTAssertEqual(monitors.count, 1)
        XCTAssertEqual(monitors.first?.resolvedExecutionPhase, .succeeded)
    }

    func testRuntimeThinkingStepDoesNotDuplicateThinkingContentBlockAsTool() {
        let p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m-runtime"]),
            env(AgentStreamEvent.step, [
                "step_type": "thinking",
                "title": "Thinking… (iteration 2)",
                "status": "running",
                "step_id": "thinking-step",
            ]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "m-runtime",
                "index": 0,
                "block": [
                    "type": "thinking",
                    "thinking": "先分析",
                    "signature": "",
                ],
            ]),
            env(AgentStreamEvent.contentBlockDelta, [
                "message_id": "m-runtime",
                "index": 0,
                "delta": [
                    "type": "thinking_delta",
                    "thinking": "再执行",
                ],
            ]),
            env(AgentStreamEvent.contentBlockStop, [
                "message_id": "m-runtime",
                "index": 0,
            ]),
            env(AgentStreamEvent.step, [
                "step_type": "thinking",
                "title": "Thinking… (iteration 2)",
                "status": "done",
                "step_id": "thinking-step",
            ]),
            env(AgentStreamEvent.messageStop, [
                "message_id": "m-runtime",
                "stop_reason": "end_turn",
            ]),
        ])

        let message = assistant(p)
        XCTAssertEqual(message?.thinking.map(\.text), ["先分析再执行"])
        XCTAssertTrue(message?.toolCalls.isEmpty ?? false)
        XCTAssertFalse(p.isStreamingActive)
    }

    func testThinkingToolThenThinkingFormsOneFoldableTimelineWithoutChangingKinds() {
        let p = project([
            env(AgentStreamEvent.contentBlockStart, [
                "index": 0,
                "block": ["type": "thinking", "thinking": "先判断", "signature": ""],
            ]),
            env(AgentStreamEvent.contentBlockStop, ["index": 0]),
            env(AgentStreamEvent.contentBlockStart, [
                "index": 1,
                "block": ["type": "tool_use", "id": "tool-check", "name": "shell", "input": [:]],
            ]),
            env(AgentStreamEvent.contentBlockStop, ["index": 1]),
            env(AgentStreamEvent.contentBlockStart, [
                "index": 2,
                "block": ["type": "thinking", "thinking": "根据结果继续", "signature": ""],
            ]),
        ])

        let blocks = assistant(p)?.blocks ?? []
        let units = AssistantTimelineUnit.group(blocks)

        XCTAssertEqual(units.count, 1)
        guard case let .stepGroup(grouped) = units.first else {
            return XCTFail("思考→工具→继续思考应收束为一个可折叠步骤摘要")
        }
        XCTAssertEqual(grouped.map(\.index), [0, 1, 2])
        guard case let .thinking(first) = grouped[0],
              case let .tool(tool) = grouped[1],
              case let .thinking(second) = grouped[2] else {
            return XCTFail("折叠只改变视觉分组，不能改变 thinking/tool 的块身份")
        }
        XCTAssertTrue(first.completed)
        XCTAssertEqual(tool.name, "shell")
        XCTAssertFalse(second.completed)
    }

    func testThinkingPresentationMapsStreamingAndCompletionWithoutToolState() {
        let startedAt = Date(timeIntervalSince1970: 10)
        let streaming = ThinkingSegment(
            messageId: "m1",
            index: 0,
            text: "正在分析",
            completed: false,
            startedAt: startedAt
        )
        let completed = ThinkingSegment(
            messageId: "m1",
            index: 0,
            text: "已经分析",
            completed: true,
            startedAt: startedAt,
            stoppedAt: Date(timeIntervalSince1970: 12.1)
        )

        XCTAssertEqual(ThinkingStepPresentation.state(for: streaming), .streaming)
        XCTAssertEqual(
            ThinkingStepPresentation.state(for: completed),
            .completed(elapsedSeconds: 2)
        )
        // 时间线内联只留流式预览；完成后全文改走 ThinkingDetailSheet（底部抽屉）。
        XCTAssertTrue(ThinkingStepPresentation.showsInlinePreview(state: .streaming))
        XCTAssertFalse(
            ThinkingStepPresentation.showsInlinePreview(state: .completed(elapsedSeconds: 2))
        )
    }

    func testThinkingStreamRevealAdvancesGraduallyAndKeepsCharacterBoundaries() {
        XCTAssertEqual(ThinkingStreamReveal.nextVisibleCount(current: 0, target: 10), 1)
        XCTAssertEqual(ThinkingStreamReveal.nextVisibleCount(current: 8, target: 10), 9)
        XCTAssertEqual(ThinkingStreamReveal.nextVisibleCount(current: 10, target: 10), 10)
        XCTAssertEqual(ThinkingStreamReveal.visibleText("A👨🏽‍💻B", characterCount: 2), "A👨🏽‍💻")
    }

    func testThinkingStreamRevealPreviewTailKeepsLatestCharacters() {
        let long = String(repeating: "思", count: 900)
        let tail = ThinkingStreamReveal.previewTail(long, maxCharacters: 720)
        XCTAssertEqual(tail.count, 720)
        XCTAssertTrue(long.hasSuffix(tail))
        XCTAssertEqual(ThinkingStreamReveal.previewTail("短", maxCharacters: 720), "短")
    }

    func testThinkingDetailUsesChunkedPlainTextForLongContent() {
        XCTAssertEqual(
            ThinkingDetailContentPolicy.renderingMode(characterCount: 3_999),
            .markdown
        )
        XCTAssertEqual(
            ThinkingDetailContentPolicy.renderingMode(characterCount: 4_000),
            .chunkedPlainText
        )

        let source = String(repeating: "甲", count: 1_601) + "👨🏽‍💻"
        let chunks = ThinkingDetailContentPolicy.plainTextChunks(source)
        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks.joined(), source)
        XCTAssertEqual(chunks[0].count, 1_600)
        XCTAssertEqual(chunks[1], "甲👨🏽‍💻")
    }

    /// 2w 渐变只在 `-w → 0` 平移：左→右扫光，且视口始终被覆盖（不会整段透明）。
    func testShinyTextMotionGradientOffsetKeepsViewportCoveredAndSweepsLeftToRight() {
        let width: CGFloat = 100
        XCTAssertEqual(ShinyTextMotion.gradientOffsetX(phase: 0, textWidth: width), -width, accuracy: 0.000_1)
        XCTAssertEqual(ShinyTextMotion.gradientOffsetX(phase: 1, textWidth: width), 0, accuracy: 0.000_1)
        XCTAssertEqual(ShinyTextMotion.gradientOffsetX(phase: 0.5, textWidth: width), -width / 2, accuracy: 0.000_1)
        // 越界 phase 也必须夹紧，避免再次滑出视口。
        XCTAssertEqual(ShinyTextMotion.gradientOffsetX(phase: -0.2, textWidth: width), -width, accuracy: 0.000_1)
        XCTAssertEqual(ShinyTextMotion.gradientOffsetX(phase: 1.2, textWidth: width), 0, accuracy: 0.000_1)
        XCTAssertEqual(ShinyTextMotion.gradientFrameWidth(forTextWidth: 120), 240, accuracy: 0.000_1)
        XCTAssertEqual(ShinyTextMotion.gradientFrameWidth(forTextWidth: 0), 1, accuracy: 0.000_1)
    }

    /// tip 重建会 remount ShinyText；相位必须跟绝对时钟走，不能绑 onAppear。
    func testShinyTextMotionPhaseContinuesAcrossRemounts() {
        let duration: TimeInterval = 1.6
        let t0 = ShinyTextMotion.epoch.addingTimeInterval(0.8)
        let t1 = ShinyTextMotion.epoch.addingTimeInterval(0.8 + duration)
        XCTAssertEqual(
            ShinyTextMotion.phase(at: t0, duration: duration),
            ShinyTextMotion.phase(at: t1, duration: duration),
            accuracy: 0.001,
            "整周期后相位应重合——重建视图不会把扫光打回起点"
        )
        XCTAssertEqual(ShinyTextMotion.phase(at: ShinyTextMotion.epoch, duration: duration), 0, accuracy: 0.001)
    }

    func testShinyTextMotionStopsWhenInactiveOrOffscreenOrReduceMotion() {
        XCTAssertTrue(ShinyTextMotion.shouldAnimate(active: true, reduceMotion: false))
        XCTAssertFalse(ShinyTextMotion.shouldAnimate(active: false, reduceMotion: false))
        XCTAssertFalse(
            ShinyTextMotion.shouldAnimate(
                active: true,
                isVisible: false,
                reduceMotion: false
            )
        )
        XCTAssertFalse(ShinyTextMotion.shouldAnimate(active: true, reduceMotion: true))
        // 同屏多处运行态时，只有被协调器选中的那条扫光。
        XCTAssertFalse(
            ShinyTextMotion.shouldAnimate(
                active: true,
                isCoordinatedActive: false,
                reduceMotion: false
            )
        )
    }

    /// 对齐 Electron `syncActiveShinyText`：同时只让最后出现的一条扫光，其余静态。
    @MainActor
    func testShinyTextCoordinatorKeepsOnlyTheLatestVisibleTextActive() {
        let coordinator = ShinyTextCoordinator()

        let thinking = coordinator.register()
        XCTAssertTrue(coordinator.isActive(thinking))

        let tool = coordinator.register()
        XCTAssertTrue(coordinator.isActive(tool))
        XCTAssertFalse(coordinator.isActive(thinking), "新出现的运行态接管发光，旧的退成静态")

        coordinator.unregister(tool)
        XCTAssertTrue(coordinator.isActive(thinking), "最后一条消失后由仍在场的接回来")

        coordinator.unregister(thinking)
        XCTAssertNil(coordinator.activeToken)
        XCTAssertFalse(coordinator.isActive(nil))
    }

    // MARK: - turn_identity 内部标记不进气泡

    func testTurnIdentityMarkupStrippedFromDisplayText() {
        let raw = """
        <turn_identity agent_id="agent-1">这段历史回复由该 Agent 生成，不代表当前执行者的身份。</turn_identity>
        好的，我来处理。
        """
        XCTAssertEqual(AgentTurnIdentityMarkup.stripped(raw), "好的，我来处理。")

        XCTAssertEqual(
            AgentTurnIdentityMarkup.stripped(#"<turn_identity agent_id="a" />正文"#),
            "正文"
        )
        // 流式期只到货半截标签时也不能把尖括号原样画出来。
        XCTAssertEqual(
            AgentTurnIdentityMarkup.stripped(#"<turn_identity agent_id="a">正文"#),
            "正文"
        )
        XCTAssertEqual(AgentTurnIdentityMarkup.stripped("正文</turn_identity>"), "正文")
    }

    func testTurnIdentityStripKeepsOrdinaryTextUntouched() {
        let plain = "构建脚本里用 `<turn>` 占位，注意 a < b 的写法。"
        XCTAssertEqual(AgentTurnIdentityMarkup.stripped(plain), plain)
        XCTAssertEqual(AgentTurnIdentityMarkup.stripped(""), "")
    }

    func testShinyTextMotionMatchesElectronGradientAngle() {
        let width: CGFloat = 240
        let height: CGFloat = 20
        let axis = ShinyTextMotion.gradientAxis(tileWidth: width, height: height)
        let physicalDeltaX = (axis.end.x - axis.start.x) * width
        let physicalDeltaY = (axis.end.y - axis.start.y) * height

        XCTAssertEqual(
            physicalDeltaY / physicalDeltaX,
            CGFloat(tan(30.0 * Double.pi / 180.0)),
            accuracy: 0.000_1
        )
    }

    // MARK: - 合成 mini-message（后台命令终态）不建幽灵气泡

    /// ：文生图 CLI 转后台后，终结时 relay 广播一串 role="user" 的合成
    /// mini-message（message_start → content_block_start(tool_result) → stop → message_stop）。
    /// 它永远不会有 text 块，不能认领/新建气泡；终态 content 按 toolUseId 回填既有工具卡。
    func testSyntheticTerminalMiniMessageBackfillsToolWithoutGhostBubble() {
        let imageUrl = "https://example.com/bg-terminal.png"
        let inner = #"{"ok":true,"data":{"result_urls":["\#(imageUrl)"]}}"#
        let terminalContent = #"{"status":"completed","_terminal_update":true,"stdout":"\#(inner.replacingOccurrences(of: "\"", with: "\\\""))"}"#

        let p = project([
            // 先有正常一轮：assistant 消息带 media_image_generate 工具卡。
            env(AgentStreamEvent.messageStart, ["message_id": "m-asst"]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "m-asst",
                "index": 0,
                "block": ["type": "tool_use", "id": "tu-img", "name": "media_image_generate", "input": [:]],
            ]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "m-asst", "index": 0]),
            // 合成 mini-message 四件套（role="user"）。
            env(AgentStreamEvent.messageStart, [
                "message_id": "mini-1",
                "role": "user",
                "message_kind": "llm",
                "model_id": "tabtin-tool-runtime",
            ]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "mini-1",
                "index": 0,
                "block": [
                    "type": "tool_result",
                    "tool_use_id": "tu-img",
                    "content": terminalContent,
                    "is_error": false,
                ],
            ]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "mini-1", "index": 0]),
            env(AgentStreamEvent.messageStop, ["message_id": "mini-1"]),
        ])

        // 不新增气泡：user + 唯一的 assistant 气泡（m-asst 认领乐观占位）。
        XCTAssertEqual(p.messages.count, 2)
        XCTAssertEqual(p.messages.filter { $0.role == .assistant }.count, 1)

        guard let tool = assistant(p)?.toolCalls.first(where: { $0.toolCallId == "tu-img" }) else {
            return XCTFail("expected projected tool card")
        }
        XCTAssertEqual(tool.resultText, terminalContent)
        XCTAssertEqual(tool.resolvedExecutionPhase, .succeeded)
        // 解析器能从终态信封的嵌套 stdout 里剥出图 URL（MediaImageInlineView 同源）。
        XCTAssertEqual(MediaImageGenerateResultParser.parse(tool.resultText), imageUrl)

        // mini-1 的 message_stop 对未建气泡的 messageId 必须安全 no-op：
        // 不能把仍在流式的 assistant 气泡定格。
        XCTAssertTrue(assistant(p)?.isStreaming ?? false)
    }

    /// 回归：role="assistant" 的 message_start 仍正常建气泡。
    func testMessageStartWithAssistantRoleStillClaimsBubble() {
        let p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m-a", "role": "assistant"]),
        ])
        XCTAssertEqual(p.messages.count, 2)
        XCTAssertEqual(assistant(p)?.serverId, "m-a")
    }

    /// 回归：旧 relay 不带 role 字段时保持旧行为（建气泡），兼容历史事件。
    func testMessageStartWithoutRoleStillClaimsBubble() {
        let p = project([
            env(AgentStreamEvent.messageStart, ["message_id": "m-legacy"]),
        ])
        XCTAssertEqual(p.messages.count, 2)
        XCTAssertEqual(assistant(p)?.serverId, "m-legacy")
    }

}

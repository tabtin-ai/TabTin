import XCTest
@testable import Tabtin

/// StreamSession reducer 单测：用 WireDecoder 解码真实形态 envelope 再喂 reducer，
/// 端到端验证「envelope → DecodedStreamEvent → StreamUpdate + 累积状态」整条投射链路。
final class StreamSessionTests: XCTestCase {
    private let decoder = WireDecoder()

    private func env(_ short: String, _ payload: [String: Any]) -> WSEnvelope {
        WSEnvelope.build(type: AgentStreamEvent.fullType(short), deviceId: "ios-test", payload: payload)
    }

    /// 把一串 envelope 依次解码 + 折叠，返回全部 StreamUpdate 与终态 session。
    private func run(_ envelopes: [WSEnvelope]) -> (updates: [StreamUpdate], session: StreamSession) {
        var session = StreamSession()
        var all: [StreamUpdate] = []
        for e in envelopes {
            all.append(contentsOf: session.ingest(decoder.decode(e)))
        }
        return (all, session)
    }

    func testFullTextTurnAccumulates() {
        let (updates, session) = run([
            env(AgentStreamEvent.lifecycle, ["phase": "start"]),
            env(AgentStreamEvent.messageStart, ["message_id": "m1"]),
            env(AgentStreamEvent.contentBlockStart, ["message_id": "m1", "index": 0, "block": ["type": "text", "text": ""]]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m1", "index": 0, "delta": ["type": "text_delta", "text": "你好"]]),
            env(AgentStreamEvent.contentBlockDelta, ["message_id": "m1", "index": 0, "delta": ["type": "text_delta", "text": "世界"]]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "m1", "index": 0]),
            env(AgentStreamEvent.messageDelta, [
                "message_id": "m1",
                "delta": [:],
                "usage": ["input_tokens": 20, "output_tokens": 4],
            ]),
            env(AgentStreamEvent.messageDelta, [
                "message_id": "m1",
                "delta": ["stop_reason": "end_turn"],
            ]),
            env(AgentStreamEvent.messageStop, [
                "message_id": "m1",
                "error_info": [
                    "error_class": "INCOMPLETE_STREAM",
                    "partial_reason": "message_stop_fallback",
                ],
            ]),
            env(AgentStreamEvent.done, ["session_id": "s1", "stop_reason": "end_turn"]),
        ])

        let texts = updates.compactMap { u -> String? in
            if case let .appendText(_, _, t) = u { return t }
            return nil
        }
        XCTAssertEqual(texts.joined(), "你好世界")
        XCTAssertTrue(session.isFinished)
        XCTAssertEqual(session.currentMessageId, "m1")
        XCTAssertEqual(session.latestMessageUsage?.inputTokens, 20)
        XCTAssertEqual(session.latestMessageUsage?.outputTokens, 4)
        XCTAssertEqual(session.latestMessageStopErrorInfo?.partialReason, .messageStopFallback)
        XCTAssertTrue(updates.contains { if case .done = $0 { return true }; return false })
        XCTAssertTrue(updates.contains {
            if case let .messageStop(messageId, stopReason) = $0 {
                return messageId == "m1" && stopReason == "end_turn"
            }
            return false
        })
    }

    func testLiveFormalOssImagePreservesFileIdentityAndHTTPFallback() {
        let (updates, _) = run([
            env(AgentStreamEvent.messageStart, ["message_id": "m-image"]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "m-image",
                "index": 0,
                "block": [
                    "type": "tabtin_rich_content",
                    "kind": "image",
                    "summary": "永久图片",
                    "payload": [
                        "artifact_kind": "oss_file",
                        "file_id": "file-ios-live",
                        "file_name": "live.png",
                        "mime_type": "image/png",
                        "file_size": 4096,
                        "access_url": "https://oss.example.com/live.png",
                        "source_tool_use_id": "tool-use-ios-live",
                        "url": "tabtin://resource/file/file-ios-live?hint=tabfiles",
                    ],
                ],
            ]),
        ])

        guard case let .richContent(_, _, block) = updates.last else {
            return XCTFail("expected richContent")
        }
        XCTAssertEqual(block.fileId, "file-ios-live")
        XCTAssertEqual(block.url, "https://oss.example.com/live.png")
        XCTAssertEqual(block.filename, "live.png")
        XCTAssertEqual(block.fileSize, 4096)
        XCTAssertEqual(block.sourceToolUseId, "tool-use-ios-live")
    }

    func testMessageStopRejectsUnknownPartialReason() {
        let (_, session) = run([
            env(AgentStreamEvent.messageStart, ["message_id": "m1"]),
            env(AgentStreamEvent.messageStop, [
                "message_id": "m1",
                "error_info": [
                    "error_class": "INCOMPLETE_STREAM",
                    "partial_reason": "future_fallback",
                ],
            ]),
        ])

        XCTAssertNil(
            session.latestMessageStopErrorInfo,
            "未知 partial_reason 必须使严格枚举解码失败，不能作为开放字符串进入消费侧"
        )
    }

    func testMessageCommittedDecodedAsUpdate() {
        let (updates, _) = run([
            env(AgentStreamEvent.messageCommitted, ["message_id": "m1", "server_id": "db_1"]),
        ])

        guard case let .messageCommitted(messageId, serverId) = updates.first else {
            return XCTFail("expected messageCommitted")
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(serverId, "db_1")
    }

    func testMessageStopDoesNotReusePreviousMessageMetadata() {
        let (updates, session) = run([
            env(AgentStreamEvent.messageStart, ["message_id": "m1"]),
            env(AgentStreamEvent.messageDelta, [
                "message_id": "m1",
                "delta": ["stop_reason": "tool_use"],
                "usage": ["input_tokens": 12, "output_tokens": 3],
            ]),
            env(AgentStreamEvent.messageStop, [
                "message_id": "m1",
                "error_info": ["partial_reason": "message_stop_fallback"],
            ]),
            env(AgentStreamEvent.messageStart, ["message_id": "m2"]),
            env(AgentStreamEvent.messageStop, ["message_id": "m2"]),
        ])

        let stops = updates.compactMap { update -> (String?, String?)? in
            if case let .messageStop(messageId, stopReason) = update {
                return (messageId, stopReason)
            }
            return nil
        }
        XCTAssertEqual(stops.count, 2)
        XCTAssertEqual(stops[0].0, "m1")
        XCTAssertEqual(stops[0].1, "tool_use")
        XCTAssertEqual(stops[1].0, "m2")
        XCTAssertNil(stops[1].1)
        XCTAssertNil(session.latestMessageUsage)
        XCTAssertNil(session.latestMessageStopErrorInfo)
    }

    func testThinkingBlockRunningThenCompleted() {
        let (updates, _) = run([
            env(AgentStreamEvent.contentBlockStart, ["index": 0, "block": ["type": "thinking", "thinking": "想", "signature": ""]]),
            env(AgentStreamEvent.contentBlockDelta, ["index": 0, "delta": ["type": "thinking_delta", "thinking": "一下"]]),
            env(AgentStreamEvent.contentBlockStop, ["index": 0]),
        ])
        let thinking = updates.compactMap { u -> (String, Bool)? in
            if case let .thinking(_, _, text, completed) = u { return (text, completed) }
            return nil
        }
        XCTAssertEqual(thinking.count, 3)
        XCTAssertEqual(thinking.last?.0, "想一下")
        XCTAssertEqual(thinking.last?.1, true)        // 末次 completed
        XCTAssertEqual(thinking.first?.1, false)      // 首次 running
    }

    func testToolUseStartAccumulateFinalize() {
        let (updates, _) = run([
            env(AgentStreamEvent.contentBlockStart, ["index": 1, "block": ["type": "tool_use", "id": "tu_1", "name": "shell", "input": [:]]]),
            env(AgentStreamEvent.contentBlockDelta, ["index": 1, "delta": ["type": "input_json_delta", "partial_json": "{\"cmd\":"]]),
            env(AgentStreamEvent.contentBlockDelta, ["index": 1, "delta": ["type": "input_json_delta", "partial_json": "\"ls\"}"]]),
            env(AgentStreamEvent.contentBlockStop, ["index": 1]),
        ])
        guard case let .toolUseStarted(_, toolCallId, name, index) = updates.first else {
            return XCTFail("expected toolUseStarted first")
        }
        XCTAssertEqual(toolCallId, "tu_1")
        XCTAssertEqual(name, "shell")
        XCTAssertEqual(index, 1)
        guard case let .toolUseFinalized(_, _, _, _, inputJson) = updates.last else {
            return XCTFail("expected toolUseFinalized last")
        }
        XCTAssertEqual(inputJson, "{\"cmd\":\"ls\"}")
    }

    func testErrorFinishesSession() {
        let (updates, session) = run([
            env(AgentStreamEvent.persistError, ["error": "boom"]),
        ])
        XCTAssertTrue(session.isFinished)
        guard case let .error(errorInfo) = updates.first else { return XCTFail("expected error") }
        XCTAssertEqual(errorInfo.message, "boom")
    }

    func testHITLPassthrough() {
        let (updates, _) = run([
            env(AgentStreamEvent.approvalRequested, ["batch_id": "b1"]),
        ])
        guard case let .hitl(kind, _) = updates.first, kind == .approvalRequested else {
            return XCTFail("expected hitl approvalRequested")
        }
    }

    func testFirstEventFlag() {
        var session = StreamSession()
        XCTAssertFalse(session.hasReceivedFirstEvent)
        _ = session.ingest(decoder.decode(env(AgentStreamEvent.lifecycle, ["phase": "start"])))
        XCTAssertTrue(session.hasReceivedFirstEvent)
    }

    func testSilentSystemNoticeIsObservedButNotProjectedToUI() {
        let (updates, session) = run([
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "llm_timing",
                "severity": "silent",
                "content": "[llm_timing] django_upstream_request_start",
            ]),
        ])

        XCTAssertTrue(updates.isEmpty)
        XCTAssertTrue(session.hasReceivedFirstEvent)
    }

    func testLegacyLLMTimingNoticeWithoutSeverityIsNotProjectedToUI() {
        let (updates, _) = run([
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "llm_timing",
                "content": "[llm_timing] llm_request_to_first_text",
            ]),
        ])

        XCTAssertTrue(updates.isEmpty)
    }

    func testVisibleSystemNoticeStillPassesThrough() {
        let (updates, _) = run([
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "model_fallback",
                "severity": "warning",
                "content": "已切换到备用模型",
            ]),
        ])

        guard case let .systemNotice(noticeType, envelope) = updates.first else {
            return XCTFail("expected visible system notice")
        }
        XCTAssertEqual(noticeType, "model_fallback")
        XCTAssertEqual(envelope.payloadString("content"), "已切换到备用模型")
    }

    func testRuntimePresentationEventsAreNoLongerDropped() {
        let (updates, _) = run([
            env(AgentStreamEvent.step, [
                "step_type": "thinking",
                "title": "分析代码",
                "status": "running",
                "step_id": "step-1",
            ]),
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "tool_progress",
                "tool_name": "shell",
                "tool_call_id": "tool-1",
                "stdout": "building…",
                "output_bytes": 128,
            ]),
            env(AgentStreamEvent.monitorStatus, [
                "monitor_id": "monitor-1",
                "description": "观察构建",
                "status": "running",
            ]),
            env(AgentStreamEvent.sshOutput, [
                "data": "line 1\n",
                "task_id": "task-1",
                "tool_call_id": "tool-ssh",
            ]),
        ])

        XCTAssertTrue(updates.contains {
            if case let .runtimeStep(_, step) = $0 { return step.stepId == "step-1" }
            return false
        })
        XCTAssertTrue(updates.contains {
            if case let .toolExecution(update) = $0 {
                return update.toolCallId == "tool-1"
                    && update.phase == .running
                    && update.outputText == "building…"
                    && update.outputBytes == 128
            }
            return false
        })
        XCTAssertTrue(updates.contains {
            if case let .monitorStatus(_, status) = $0 { return status.monitorId == "monitor-1" }
            return false
        })
        XCTAssertTrue(updates.contains {
            if case let .sshOutput(_, output) = $0 {
                return output.output == "line 1\n" && output.toolCallId == "tool-ssh"
            }
            return false
        })
    }

    func testContextRuntimeStateTracksServerPressureAndCompactionLifecycle() {
        let (_, session) = run([
            env(AgentStreamEvent.contextPressure, [
                "pressure": 0.91,
                "level": "llmSummary",
                "estimated_tokens": 91_000,
                "context_window": 100_000,
                "model": "model-1",
            ]),
            env(AgentStreamEvent.compaction, [
                "phase": "start",
                "mode": "auto_condense",
            ]),
            env(AgentStreamEvent.compaction, [
                "phase": "end",
                "mode": "auto_condense",
                "stats": ["tokens_freed": 42_000],
            ]),
        ])

        XCTAssertEqual(session.contextRuntimeState.latestPressure?.percentage, 91)
        XCTAssertEqual(session.contextRuntimeState.latestPressure?.level, .llmSummary)
        XCTAssertEqual(session.contextRuntimeState.latestPressure?.estimatedTokens, 91_000)
        XCTAssertEqual(session.contextRuntimeState.latestPressure?.contextWindow, 100_000)
        XCTAssertEqual(session.contextRuntimeState.latestPressure?.model, "model-1")
        XCTAssertFalse(session.contextRuntimeState.compactionStatus.isInProgress)
        guard case let .completed(mode, stats) = session.contextRuntimeState.compactionStatus else {
            return XCTFail("expected completed compaction")
        }
        XCTAssertEqual(mode, "auto_condense")
        XCTAssertEqual(stats?.tokensFreed, 42_000)
    }

    func testContextRuntimeStateDoesNotInventPressurePercentage() {
        let (_, session) = run([
            env(AgentStreamEvent.contextPressure, [
                "pressure": 1.2,
                "level": "future_runtime_level",
                "estimatedTokens": 120_000,
                "contextWindow": 100_000,
            ]),
        ])

        XCTAssertNil(session.contextRuntimeState.latestPressure?.percentage)
        XCTAssertEqual(session.contextRuntimeState.latestPressure?.level, .unknown("future_runtime_level"))
    }
}

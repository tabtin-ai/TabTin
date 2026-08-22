import XCTest
@testable import Tabtin

/// WireDecoder（§4.3 解码层）纯函数单测：覆盖核心正文/思考流式路径、
/// message 终态元数据及 runtime 状态事件的真实 payload 形态。
final class WireDecoderTests: XCTestCase {
    private let decoder = WireDecoder()

    private func envelope(_ short: String, payload: [String: Any]) -> WSEnvelope {
        WSEnvelope.build(type: AgentStreamEvent.fullType(short), deviceId: "ios-test", payload: payload)
    }

    func testLifecycleDecodes() {
        let env = envelope(AgentStreamEvent.lifecycle, payload: ["phase": "start", "session_id": "s1"])
        guard case let .lifecycle(phase, sessionId) = decoder.decode(env) else {
            return XCTFail("expected lifecycle")
        }
        XCTAssertEqual(phase, "start")
        XCTAssertEqual(sessionId, "s1")
    }

    func testSingleHitlResolvedDecodesAsTerminalHITL() {
        let env = envelope(AgentStreamEvent.singleHitlResolved, payload: [
            "request_id": "request-1",
            "outcome": "skipped",
        ])

        guard case let .hitl(kind, decodedEnvelope) = decoder.decode(env) else {
            return XCTFail("expected single HITL terminal event")
        }
        XCTAssertTrue(kind == .singleHitlResolved)
        XCTAssertFalse(kind.isBlocking)
        XCTAssertEqual(decodedEnvelope.payloadString("request_id"), "request-1")
    }

    func testContentBlockDeltaTextDecodes() {
        let env = envelope(AgentStreamEvent.contentBlockDelta, payload: [
            "message_id": "m1",
            "index": 2,
            "delta": ["type": "text_delta", "text": "你好"],
        ])
        guard case let .contentBlockDelta(messageId, index, delta) = decoder.decode(env) else {
            return XCTFail("expected contentBlockDelta")
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(index, 2)
        guard case let .textDelta(payload) = delta else { return XCTFail("expected textDelta") }
        XCTAssertEqual(payload.text, "你好")
    }

    func testContentBlockDeltaThinkingDecodes() {
        let env = envelope(AgentStreamEvent.contentBlockDelta, payload: [
            "message_id": "m1",
            "index": 0,
            "delta": ["type": "thinking_delta", "thinking": "推理中"],
        ])
        guard case let .contentBlockDelta(_, _, delta) = decoder.decode(env),
              case let .thinkingDelta(payload) = delta else {
            return XCTFail("expected thinkingDelta")
        }
        XCTAssertEqual(payload.thinking, "推理中")
    }

    func testContentBlockStartTextDecodes() {
        let env = envelope(AgentStreamEvent.contentBlockStart, payload: [
            "message_id": "m1",
            "index": 0,
            "block": ["type": "text", "text": "hi"],
        ])
        guard case let .contentBlockStart(_, _, block) = decoder.decode(env),
              case let .text(payload) = block else {
            return XCTFail("expected text content block")
        }
        XCTAssertEqual(payload.text, "hi")
    }

    func testContentBlockStopDecodes() {
        let env = envelope(AgentStreamEvent.contentBlockStop, payload: ["message_id": "m1", "index": 1])
        guard case let .contentBlockStop(messageId, index) = decoder.decode(env) else {
            return XCTFail("expected contentBlockStop")
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertEqual(index, 1)
    }

    func testMessageDeltaDecodesNestedStopReasonAndCumulativeUsage() {
        let env = envelope(AgentStreamEvent.messageDelta, payload: [
            "message_id": "m1",
            "delta": [
                "stop_reason": "tool_use",
                "stop_sequence": "\n\nHuman:",
            ],
            "usage": [
                "input_tokens": 1_234,
                "output_tokens": 567,
                "cache_read_input_tokens": 100,
            ],
        ])

        guard case let .messageDelta(metadata) = decoder.decode(env) else {
            return XCTFail("expected messageDelta")
        }
        XCTAssertEqual(metadata.messageId, "m1")
        XCTAssertEqual(metadata.stopReason, "tool_use")
        XCTAssertEqual(metadata.stopSequence, "\n\nHuman:")
        XCTAssertEqual(metadata.usage?.inputTokens, 1_234)
        XCTAssertEqual(metadata.usage?.outputTokens, 567)
        XCTAssertEqual(metadata.usage?.cacheReadInputTokens, 100)
    }

    func testMessageStopDecodesPersistenceOverridesAndNestedErrorInfo() {
        let env = envelope(AgentStreamEvent.messageStop, payload: [
            "message_id": "m1",
            "persisted_id": "db_1",
            "block_id_overrides": [
                "0": "blk_renamed_0",
                "2": "blk_renamed_2",
            ],
            "error_info": [
                "error_class": "INCOMPLETE_STREAM",
                "error_message": "消息结束时仍有未完成内容块",
                "suggested_action": "none",
                "category": "protocol_error",
                "partial_reason": "message_stop_fallback",
            ],
        ])

        guard case let .messageStop(metadata) = decoder.decode(env) else {
            return XCTFail("expected messageStop")
        }
        XCTAssertEqual(metadata.messageId, "m1")
        XCTAssertEqual(metadata.persistedId, "db_1")
        XCTAssertEqual(metadata.blockIdOverrides["0"], "blk_renamed_0")
        XCTAssertEqual(metadata.errorInfo?.errorClass, "INCOMPLETE_STREAM")
        XCTAssertEqual(metadata.errorInfo?.category, .protocolError)
        XCTAssertEqual(metadata.errorInfo?.partialReason, .messageStopFallback)
    }

    func testMessageStopAcceptsLegacyNestedDeltaAndUsage() {
        let env = envelope(AgentStreamEvent.messageStop, payload: [
            "message_id": "m1",
            "delta": ["stop_reason": "aborted"],
            "usage": ["input_tokens": 20, "output_tokens": 4],
        ])

        guard case let .messageStop(metadata) = decoder.decode(env) else {
            return XCTFail("expected messageStop")
        }
        XCTAssertEqual(metadata.stopReason, "aborted")
        XCTAssertEqual(metadata.usage?.inputTokens, 20)
        XCTAssertEqual(metadata.usage?.outputTokens, 4)
    }

    func testRuntimeStatusEventsDecodeToTypedCases() {
        let step = envelope(AgentStreamEvent.step, payload: [
            "step_type": "thinking",
            "title": "分析代码",
            "status": "running",
            "step_id": "step_1",
        ])
        guard case let .step(decodedStep) = decoder.decode(step) else {
            return XCTFail("expected step")
        }
        XCTAssertEqual(decodedStep.stepId, "step_1")
        XCTAssertEqual(decodedStep.status, .running)

        let monitor = envelope(AgentStreamEvent.monitorStatus, payload: [
            "monitor_id": "monitor_1",
            "description": "观察构建",
            "command": "xcodebuild",
            "status": "running",
            "notify_on": "failure",
            "emit_interrupted": true,
        ])
        guard case let .monitorStatus(decodedMonitor) = decoder.decode(monitor) else {
            return XCTFail("expected monitorStatus")
        }
        XCTAssertEqual(decodedMonitor.monitorId, "monitor_1")
        XCTAssertEqual(decodedMonitor.status, "running")
        XCTAssertEqual(decodedMonitor.emitInterrupted, true)

        let compaction = envelope(AgentStreamEvent.compaction, payload: [
            "phase": "end",
            "mode": "auto",
            "stats": [
                "messages_before": 80,
                "messages_after": 20,
                "tokens_freed": 12_000,
            ],
        ])
        guard case let .compaction(decodedCompaction) = decoder.decode(compaction) else {
            return XCTFail("expected compaction")
        }
        XCTAssertEqual(decodedCompaction.phase, .end)
        XCTAssertEqual(decodedCompaction.stats?.messagesBefore, 80)
        XCTAssertEqual(decodedCompaction.stats?.tokensFreed, 12_000)

        let pressure = envelope(AgentStreamEvent.contextPressure, payload: [
            "pressure": 0.86,
            "level": "high",
            "estimatedTokens": 86_000,
            "contextWindow": 100_000,
            "model": "test-model",
        ])
        guard case let .contextPressure(decodedPressure) = decoder.decode(pressure) else {
            return XCTFail("expected contextPressure")
        }
        XCTAssertEqual(decodedPressure.pressure, 0.86)
        XCTAssertEqual(decodedPressure.estimatedTokens, 86_000)
        XCTAssertEqual(decodedPressure.contextWindow, 100_000)

        let ssh = envelope(AgentStreamEvent.sshOutput, payload: [
            "content": "build completed",
            "stream": "stdout",
            "session_id": "s1",
            "task_id": "task_1",
        ])
        guard case let .sshOutput(decodedSSH) = decoder.decode(ssh) else {
            return XCTFail("expected sshOutput")
        }
        XCTAssertEqual(decodedSSH.output, "build completed")
        XCTAssertEqual(decodedSSH.stream, "stdout")
        XCTAssertEqual(decodedSSH.sessionId, "s1")
        XCTAssertEqual(decodedSSH.taskId, "task_1")
    }

    func testDoneDecodes() {
        let env = envelope(AgentStreamEvent.done, payload: ["session_id": "s1", "stop_reason": "end_turn"])
        guard case let .done(sessionId, stopReason, errorInfo, withdrawApplied) = decoder.decode(env) else {
            return XCTFail("expected done")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(stopReason, "end_turn")
        XCTAssertNil(errorInfo)
        XCTAssertNil(withdrawApplied)
    }

    func testDoneDecodesWithdrawAppliedTrue() {
        let env = envelope(AgentStreamEvent.done, payload: [
            "session_id": "s1",
            "stop_reason": "cancelled",
            "withdraw_applied": true,
        ])
        guard case let .done(_, _, _, withdrawApplied) = decoder.decode(env) else {
            return XCTFail("expected done")
        }
        XCTAssertEqual(withdrawApplied, true)
    }

    func testDoneDecodesWithdrawAppliedFalse() {
        let env = envelope(AgentStreamEvent.done, payload: [
            "session_id": "s1",
            "stop_reason": "cancelled",
            "withdraw_applied": false,
        ])
        guard case let .done(_, _, _, withdrawApplied) = decoder.decode(env) else {
            return XCTFail("expected done")
        }
        XCTAssertEqual(withdrawApplied, false)
    }

    func testMessageStartDecodesRole() {
        // 后台命令终结时 relay 的合成 mini-message：role="user" / kind="llm"。
        let env = envelope(AgentStreamEvent.messageStart, payload: [
            "message_id": "mini-1",
            "role": "user",
            "message_kind": "llm",
            "model_id": "tabtin-tool-runtime",
        ])
        guard case let .messageStart(messageId, _, role) = decoder.decode(env) else {
            return XCTFail("expected messageStart")
        }
        XCTAssertEqual(messageId, "mini-1")
        XCTAssertEqual(role, "user")
    }

    func testMessageStartWithoutRoleKeepsNil() {
        let env = envelope(AgentStreamEvent.messageStart, payload: ["message_id": "m1"])
        guard case let .messageStart(messageId, _, role) = decoder.decode(env) else {
            return XCTFail("expected messageStart")
        }
        XCTAssertEqual(messageId, "m1")
        XCTAssertNil(role)
    }

    func testHITLClassification() {
        let env = envelope(AgentStreamEvent.askUserRequired, payload: ["questions": []])
        guard case let .hitl(kind, _) = decoder.decode(env), kind == .askUser else {
            return XCTFail("expected hitl askUser")
        }
    }

    func testProjectSessionDropsOnlyLegacyActionApprovalProtocol() {
        XCTAssertTrue(AgentStreamEvent.shouldDropLegacyActionApproval(
            AgentStreamEvent.actionApprovalRequest,
            isProjectSession: true
        ))
        XCTAssertTrue(AgentStreamEvent.shouldDropLegacyActionApproval(
            AgentStreamEvent.actionApprovalResolved,
            isProjectSession: true
        ))
        XCTAssertFalse(AgentStreamEvent.shouldDropLegacyActionApproval(
            AgentStreamEvent.actionApprovalRequest,
            isProjectSession: false
        ))
        XCTAssertFalse(AgentStreamEvent.shouldDropLegacyActionApproval(
            AgentStreamEvent.fullType(AgentStreamEvent.approvalRequested),
            isProjectSession: true
        ))
    }

    func testMalformedMessageDeltaFallsBackToUnhandled() {
        let env = envelope(AgentStreamEvent.messageDelta, payload: [:])
        guard case let .unhandled(eventType) = decoder.decode(env) else {
            return XCTFail("expected unhandled")
        }
        XCTAssertEqual(eventType, AgentStreamEvent.messageDelta)
    }

    func testNonStreamEnvelopeUnhandled() {
        let env = WSEnvelope.build(type: "billing.events", deviceId: "ios-test", payload: [:])
        guard case let .unhandled(eventType) = decoder.decode(env) else {
            return XCTFail("expected unhandled")
        }
        XCTAssertEqual(eventType, "billing.events")
    }

    func testMalformedDeltaFallsBackToUnhandled() {
        let env = envelope(AgentStreamEvent.contentBlockDelta, payload: [
            "message_id": "m1",
            "delta": ["type": "unknown_delta"],
        ])
        guard case .unhandled = decoder.decode(env) else {
            return XCTFail("expected unhandled for unknown delta type")
        }
    }
}

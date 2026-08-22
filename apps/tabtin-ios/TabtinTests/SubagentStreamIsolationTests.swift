import XCTest
@testable import Tabtin

/// ：父 topic 上带 `subagent_run_id` 的 raw `agent.stream.*` 不得灌进主气泡。
@MainActor
final class SubagentStreamIsolationTests: XCTestCase {
    private let sessionId = "session-9120"

    private func env(_ short: String, payload: [String: Any], threadId: String? = nil) -> WSEnvelope {
        WSEnvelope.build(
            type: AgentStreamEvent.fullType(short),
            deviceId: "ios-test",
            payload: payload,
            threadId: threadId ?? "chat-session-\(sessionId)"
        )
    }

    // MARK: - 纯函数门闩

    func testRoutingIsolatesTaggedContentBlockButNotSubagentMeta() {
        let tagged = env(AgentStreamEvent.contentBlockStart, payload: [
            "subagent_run_id": "child-1",
            "index": 0,
            "block": ["type": "thinking", "thinking": "子思考", "signature": ""],
        ])
        XCTAssertTrue(SubagentStreamRouting.shouldIsolateFromParentTimeline(tagged))
        XCTAssertNotNil(SubagentStreamRouting.rewriteAsSubagentStreamEvent(tagged))

        let viaAlias = env(AgentStreamEvent.contentBlockDelta, payload: [
            "subagent_id": "child-1",
            "index": 0,
            "delta": ["type": "thinking_delta", "thinking": "…"],
        ])
        XCTAssertTrue(SubagentStreamRouting.shouldIsolateFromParentTimeline(viaAlias))

        let parentThinking = env(AgentStreamEvent.contentBlockStart, payload: [
            "index": 0,
            "block": ["type": "thinking", "thinking": "父思考", "signature": ""],
        ])
        XCTAssertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(parentThinking))

        for short in [
            AgentStreamEvent.subagentStarted,
            AgentStreamEvent.subagentQueued,
            AgentStreamEvent.subagentProgress,
            AgentStreamEvent.subagentCompleted,
            AgentStreamEvent.subagentFailed,
            AgentStreamEvent.subagentStreamEvent,
        ] {
            let meta = env(short, payload: ["subagent_run_id": "child-1"])
            XCTAssertFalse(
                SubagentStreamRouting.shouldIsolateFromParentTimeline(meta),
                "meta \(short) must keep existing decode path"
            )
        }

        let persist = env("persist_message", payload: [
            "subagent_run_id": "child-1",
            "message_id": "m-x",
        ])
        XCTAssertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(persist))

        let messagePersisted = env(AgentStreamEvent.messagePersisted, payload: [
            "subagent_run_id": "child-1",
            "message_id": "m-x",
        ])
        XCTAssertFalse(SubagentStreamRouting.shouldIsolateFromParentTimeline(messagePersisted))
    }

    // MARK: - ViewModel 集成

    func testTaggedChildThinkingDoesNotLeakIntoParentMessages() {
        let vm = ConversationViewModel(sessionId: sessionId)

        // 父轮先开一轮，确保主 projector 有 assistant 槽位可被「误灌」。
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.messageStart, payload: [
            "_seq": 1,
            "message_id": "parent-m1",
            "model_id": "m",
        ]))
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockStart, payload: [
            "_seq": 2,
            "message_id": "parent-m1",
            "index": 0,
            "block": ["type": "text", "text": ""],
        ]))
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockDelta, payload: [
            "_seq": 3,
            "message_id": "parent-m1",
            "index": 0,
            "delta": ["type": "text_delta", "text": "父正文"],
        ]))

        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockStart, payload: [
            "_seq": 1,
            "message_id": "child-m1",
            "index": 0,
            "block": ["type": "thinking", "thinking": "子代理内心独白", "signature": ""],
            "subagent_run_id": "child-run",
        ]))
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockDelta, payload: [
            "_seq": 2,
            "message_id": "child-m1",
            "index": 0,
            "delta": ["type": "thinking_delta", "thinking": "继续想"],
            "subagent_run_id": "child-run",
        ]))
        vm.flushPublishForTesting()

        let parentThinkingTexts = vm.messages
            .filter { $0.role == .assistant }
            .flatMap(\.thinking)
            .map(\.text)
        XCTAssertFalse(
            parentThinkingTexts.contains(where: { $0.contains("子代理内心独白") || $0.contains("继续想") }),
            "child thinking must not appear in parent bubbles: \(parentThinkingTexts)"
        )
        XCTAssertEqual(
            vm.messages.filter { $0.role == .assistant }.map(\.text).joined(),
            "父正文"
        )

        let childThinking = vm.subagentRuns
            .first(where: { $0.runId == "child-run" })?
            .transcript
            .filter { $0.kind == .thinking }
            .compactMap(\.text)
            .joined()
        XCTAssertEqual(childThinking, "子代理内心独白继续想")
    }

    func testParentThinkingWithoutRunIdStillEntersMainBubble() {
        let vm = ConversationViewModel(sessionId: sessionId)

        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.messageStart, payload: [
            "_seq": 1,
            "message_id": "parent-m1",
        ]))
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockStart, payload: [
            "_seq": 2,
            "message_id": "parent-m1",
            "index": 0,
            "block": ["type": "thinking", "thinking": "主代理在想", "signature": ""],
        ]))
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockDelta, payload: [
            "_seq": 3,
            "message_id": "parent-m1",
            "index": 0,
            "delta": ["type": "thinking_delta", "thinking": "下一步"],
        ]))
        vm.flushPublishForTesting()

        let thinking = vm.messages
            .filter { $0.role == .assistant }
            .flatMap(\.thinking)
            .map(\.text)
            .joined()
        XCTAssertEqual(thinking, "主代理在想下一步")
        XCTAssertTrue(vm.subagentRuns.isEmpty)
    }

    func testChildSeqOneDoesNotResetParentReducer() {
        let vm = ConversationViewModel(sessionId: sessionId)

        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.messageStart, payload: [
            "_seq": 1,
            "message_id": "parent-m1",
        ]))
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockStart, payload: [
            "_seq": 2,
            "message_id": "parent-m1",
            "index": 0,
            "block": ["type": "text", "text": ""],
        ]))
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockDelta, payload: [
            "_seq": 3,
            "message_id": "parent-m1",
            "index": 0,
            "delta": ["type": "text_delta", "text": "你好"],
        ]))

        // 子 lifecycle / content 带着 _seq=1：若误进父通道会换新 reducer，后续父 delta 丢上下文。
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.lifecycle, payload: [
            "_seq": 1,
            "phase": "start",
            "subagent_run_id": "child-run",
        ]))
        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockStart, payload: [
            "_seq": 1,
            "message_id": "child-m1",
            "index": 0,
            "block": ["type": "thinking", "thinking": "隔离", "signature": ""],
            "subagent_run_id": "child-run",
        ]))

        vm.ingestEnvelopeForTesting(env(AgentStreamEvent.contentBlockDelta, payload: [
            "_seq": 4,
            "message_id": "parent-m1",
            "index": 0,
            "delta": ["type": "text_delta", "text": "世界"],
        ]))
        vm.flushPublishForTesting()

        let parentText = vm.messages
            .filter { $0.role == .assistant }
            .map(\.text)
            .joined()
        XCTAssertEqual(parentText, "你好世界")

        let childThinking = vm.subagentRuns
            .first(where: { $0.runId == "child-run" })?
            .transcript
            .filter { $0.kind == .thinking }
            .compactMap(\.text)
            .joined()
        XCTAssertEqual(childThinking, "隔离")

        let leaked = vm.messages.flatMap(\.thinking).map(\.text)
        XCTAssertFalse(leaked.contains(where: { $0.contains("隔离") }))
    }
}

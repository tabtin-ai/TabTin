import XCTest
@testable import Tabtin

/// Task 2：直播 / 历史 tool_result.presentation 透传到 ToolCall。
final class MediaImagePresentationPassthroughTests: XCTestCase {
    func testFormalArtifactSuppressesOnlyCorrelatedPreview() {
        let tool = ToolCall(
            toolCallId: "tool-use-1",
            index: 0,
            name: "run_terminal_command",
            inputJson: "{}",
            finalized: true,
            resultText: nil,
            isError: false,
            presentationKind: "media_image_generation",
            presentationPrompt: nil
        )

        XCTAssertTrue(MediaImageArtifactDedup.shouldSuppressPreview(
            tool: tool,
            formalToolUseIds: ["tool-use-1"]
        ))
        XCTAssertFalse(MediaImageArtifactDedup.shouldSuppressPreview(
            tool: tool,
            formalToolUseIds: ["tool-use-2"]
        ))
    }
    private let decoder = WireDecoder()

    private func env(_ short: String, _ payload: [String: Any]) -> WSEnvelope {
        WSEnvelope.build(type: AgentStreamEvent.fullType(short), deviceId: "ios-test", payload: payload)
    }

    func testLiveToolResultPresentationFillsToolCall() {
        var projector = ConversationProjector()
        projector.appendUserMessage(id: "evt_1", text: "画个红苹果")
        projector.beginAssistant(id: "asst_1")

        var session = StreamSession()
        let envelopes = [
            env(AgentStreamEvent.messageStart, ["message_id": "m-img"]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "m-img",
                "index": 1,
                "block": [
                    "type": "tool_use",
                    "id": "tu-img",
                    "name": "run_terminal_command",
                    "input": [:],
                ],
            ]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "m-img", "index": 1]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "m-img-result",
                "index": 0,
                "block": [
                    "type": "tool_result",
                    "tool_use_id": "tu-img",
                    "content": #"{"result_urls":["https://example.com/apple.png"]}"#,
                    "is_error": false,
                    "presentation": [
                        "kind": "media_image_generation",
                        "data": ["prompt": "红苹果"],
                    ],
                ],
            ]),
        ]
        for envelope in envelopes {
            for update in session.ingest(decoder.decode(envelope)) {
                projector.apply(update)
            }
        }

        guard let tool = projector.messages
            .first(where: { $0.role == .assistant })?
            .toolCalls
            .first(where: { $0.toolCallId == "tu-img" })
        else {
            return XCTFail("expected projected media tool")
        }
        XCTAssertTrue(tool.isMediaImageGeneration)
        XCTAssertEqual(tool.presentationKind, "media_image_generation")
        XCTAssertEqual(tool.presentationPrompt, "红苹果")
    }

    func testLifecycleToolStartedPresentationShowsGeneratingEarly() {
        var projector = ConversationProjector()
        projector.appendUserMessage(id: "evt_lifecycle", text: "画个蓝气球")
        projector.beginAssistant(id: "asst_lifecycle")

        var session = StreamSession()
        let envelopes = [
            env(AgentStreamEvent.messageStart, ["message_id": "m-life"]),
            env(AgentStreamEvent.contentBlockStart, [
                "message_id": "m-life",
                "index": 1,
                "block": [
                    "type": "tool_use",
                    "id": "tu-life",
                    "name": "run_terminal_command",
                    "input": [:],
                ],
            ]),
            env(AgentStreamEvent.contentBlockStop, ["message_id": "m-life", "index": 1]),
            env(AgentStreamEvent.systemNotice, [
                "notice_type": "tool_started",
                "tool_call_id": "tu-life",
                "tool_name": "run_terminal_command",
                "presentation": [
                    "kind": "media_image_generation",
                    "data": ["prompt": "蓝气球"],
                ],
            ]),
        ]
        for envelope in envelopes {
            for update in session.ingest(decoder.decode(envelope)) {
                projector.apply(update)
            }
        }

        guard let tool = projector.messages
            .first(where: { $0.role == .assistant })?
            .toolCalls
            .first(where: { $0.toolCallId == "tu-life" })
        else {
            return XCTFail("expected tool after lifecycle notice")
        }
        XCTAssertTrue(tool.isMediaImageGeneration, "tool_started.presentation 须在 tool_result 前驱动生成中态")
        XCTAssertEqual(tool.presentationPrompt, "蓝气球")
        XCTAssertEqual(tool.resolvedExecutionPhase, .running)
    }

    func testHistoryToolResultPresentationFillsToolCall() throws {
        let json = #"""
        {"messages":[
          {"id":"a-img","role":"assistant","content":"[工具调用]","content_blocks_json":[
            {"type":"tool_use","tool_use_id":"hist-img","name":"run_terminal_command","input":{}},
            {"type":"tool_result","tool_use_id":"hist-img","content":"{\"result_urls\":[\"https://example.com/a.png\"]}","is_error":false,
             "presentation":{"kind":"media_image_generation","data":{"prompt":"一只猫"}}}
          ]}
        ]}
        """#
        let resp = try JSONDecoder().decode(MessageHistoryResponse.self, from: Data(json.utf8))
        let message = try XCTUnwrap(MessageHistoryMapper.map(resp.messages).first)
        let tool = try XCTUnwrap(message.toolCalls.first(where: { $0.toolCallId == "hist-img" }))
        XCTAssertTrue(tool.isMediaImageGeneration)
        XCTAssertEqual(tool.presentationPrompt, "一只猫")
    }

    func testHistoryCrossMessageToolResultPresentation() throws {
        let json = #"""
        {"messages":[
          {"id":"a-use","role":"assistant","content":"[工具调用]","content_blocks_json":[
            {"type":"tool_use","tool_use_id":"cross-img","name":"run_terminal_command","input":{}}
          ]},
          {"id":"u-result","role":"user","content":"","content_blocks_json":[
            {"type":"tool_result","tool_use_id":"cross-img","content":"{\"result_urls\":[\"https://example.com/b.png\"]}","is_error":false,
             "presentation":{"kind":"media_image_generation","data":{"prompt":"蓝天"}}}
          ]}
        ]}
        """#
        let resp = try JSONDecoder().decode(MessageHistoryResponse.self, from: Data(json.utf8))
        let messages = MessageHistoryMapper.map(resp.messages)
        let tool = try XCTUnwrap(
            messages
                .first(where: { $0.id == "a-use" })?
                .toolCalls
                .first(where: { $0.toolCallId == "cross-img" })
        )
        XCTAssertTrue(tool.isMediaImageGeneration)
        XCTAssertEqual(tool.presentationPrompt, "蓝天")
        XCTAssertEqual(tool.resultText, #"{"result_urls":["https://example.com/b.png"]}"#)
    }
}

import XCTest
@testable import Tabtin

/// MB-25 本地缓存纯逻辑单测：`MessageBlockCodec` 有序块编解码 round-trip。
/// SwiftData 落盘路径（容器/队列）依赖运行时，不在纯单测覆盖，由 build + live 验证。
final class MessageCacheTests: XCTestCase {

    func testBlockCodecRoundTripPreservesOrderAndFields() {
        let thinkingStartedAt = Date(timeIntervalSince1970: 100)
        let thinkingStoppedAt = Date(timeIntervalSince1970: 103)
        let blocks: [MessageBlock] = [
            .thinking(ThinkingSegment(
                messageId: "m1",
                index: 0,
                text: "想一下",
                completed: true,
                startedAt: thinkingStartedAt,
                stoppedAt: thinkingStoppedAt
            )),
            .text(TextBlock(messageId: "m1", index: 1, text: "正文 a")),
            .tool(ToolCall(
                toolCallId: "tool-1", index: 2, name: "Read", inputJson: "{\"path\":\"a.swift\"}",
                finalized: true, resultText: "ok", isError: false)),
            .richContent(RichContentBlock(
                messageId: "m1",
                index: 3,
                kind: "search_results",
                summary: "web_search: TabTin",
                title: nil,
                groupId: nil,
                tableRows: [],
                tableSchema: nil,
                footer: nil,
                resourceType: nil,
                resourceName: nil,
                resourceId: nil,
                spaceName: nil,
                url: nil,
                filename: nil,
                mimeType: nil,
                fileSize: nil,
                totalRows: nil,
                widgetId: nil,
                format: nil,
                sourceCode: nil,
                mermaidSource: nil,
                query: "TabTin",
                searchResults: [
                    RichSearchResult(
                        title: "TabTin",
                        url: "https://www.example.com/",
                        snippet: "Agent 协作平台",
                        score: 0.9,
                        contentType: "web",
                        filePath: nil,
                        source: nil,
                        favicon: nil
                    )
                ],
                totalCount: 1,
                fileId: "file-rich-1",
                sourceToolUseId: "tool-use-rich-1"
            )),
            .text(TextBlock(messageId: "m1", index: 4, text: "正文 b")),
        ]

        let decoded = MessageBlockCodec.decode(MessageBlockCodec.encode(blocks))

        XCTAssertEqual(decoded.map(\.id), blocks.map(\.id), "块顺序与身份必须保持")
        guard case let .thinking(s) = decoded[0] else { return XCTFail("第 0 块应为 thinking") }
        XCTAssertEqual(s.text, "想一下")
        XCTAssertTrue(s.completed)
        XCTAssertEqual(s.startedAt, thinkingStartedAt)
        XCTAssertEqual(s.stoppedAt, thinkingStoppedAt)
        XCTAssertEqual(s.elapsedSeconds, 3)
        guard case let .tool(t) = decoded[2] else { return XCTFail("第 2 块应为 tool") }
        XCTAssertEqual(t.name, "Read")
        XCTAssertEqual(t.inputJson, "{\"path\":\"a.swift\"}")
        XCTAssertEqual(t.resultText, "ok")
        XCTAssertFalse(t.isError)
        guard case let .richContent(rich) = decoded[3] else {
            return XCTFail("第 3 块应为 rich content")
        }
        XCTAssertEqual(rich.query, "TabTin")
        XCTAssertEqual(rich.totalCount, 1)
        XCTAssertEqual(rich.searchResults.first?.url, "https://www.example.com/")
        XCTAssertEqual(rich.fileId, "file-rich-1")
        XCTAssertEqual(rich.sourceToolUseId, "tool-use-rich-1")
    }

    func testCachedMessageRoundTripPreservesIdentity() {
        let msg = ChatMessage(
            id: "client-uuid", serverId: "srv-1", persistedId: "db-1",
            clientEventId: "client-event-1", sourceClientEventId: "origin-user-1", role: .assistant,
            blocks: [.text(TextBlock(messageId: "srv-1", index: 0, text: "hello"))],
            stopReason: "end_turn"
        )
        let restored = CachedMessage.from(sessionId: "s1", msg: msg).toChatMessage()

        // effectiveId 作缓存键：persistedId 优先。
        XCTAssertEqual(restored.id, "db-1")
        XCTAssertEqual(restored.serverId, "srv-1")
        XCTAssertEqual(restored.persistedId, "db-1")
        XCTAssertEqual(restored.clientEventId, "client-event-1")
        XCTAssertEqual(restored.sourceClientEventId, "origin-user-1")
        XCTAssertEqual(restored.role, .assistant)
        XCTAssertEqual(restored.text, "hello")
        XCTAssertEqual(restored.stopReason, "end_turn")
        XCTAssertFalse(restored.isStreaming)
    }

    func testEmptyDataDecodesToEmptyBlocks() {
        XCTAssertTrue(MessageBlockCodec.decode(Data()).isEmpty)
    }
}

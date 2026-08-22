import XCTest
@testable import Tabtin

final class MessageQuoteTests: XCTestCase {
    func testAssistantReplyCanBeQuotedIntoComposer() {
        let message = ChatMessage(id: "a1", role: .assistant, text: "第一行\n第二行")
        XCTAssertEqual(MessageQuote.payload(for: message), "> Agent：\n> 第一行\n> 第二行\n\n")
    }

    func testComposerQuoteIsParsedSeparatelyFromEditableReply() {
        let draft = "> Agent：\n> 第一行\n> 第二行\n\n我的回复"

        let quote = MessageQuote.parseComposerDraft(draft)

        XCTAssertEqual(quote?.author, "Agent")
        XCTAssertEqual(quote?.content, "第一行\n第二行")
        XCTAssertEqual(quote?.reply, "我的回复")
    }

    func testQuotingAnotherMessageReplacesTheCurrentComposerQuote() {
        let current = "> Agent：\n> 旧内容\n\n已有回复"
        let message = ChatMessage(id: "u1", role: .user, text: "新内容")

        XCTAssertEqual(
            MessageQuote.replacingComposerQuote(in: current, with: message),
            "> 我：\n> 新内容\n\n已有回复"
        )
    }

    func testComposerQuoteCanBeRemovedWithoutChangingTheReply() {
        let current = "> Agent：\n> 引用内容\n\n已有回复"

        XCTAssertEqual(MessageQuote.removingComposerQuote(from: current), "已有回复")
    }

    func testEmptyAndStreamingRepliesCannotBeQuoted() {
        XCTAssertNil(MessageQuote.payload(for: ChatMessage(id: "a1", role: .assistant, text: "  ")))
        XCTAssertNil(MessageQuote.payload(for: ChatMessage(id: "a2", role: .assistant, text: "未完成", isStreaming: true)))
    }
}

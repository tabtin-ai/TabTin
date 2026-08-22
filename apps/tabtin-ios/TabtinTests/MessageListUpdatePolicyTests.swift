import SwiftUI
import UIKit
import XCTest
@testable import Tabtin

final class MessageListUpdatePolicyTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    @MainActor
    func testLargeHistoryOnlyInstantiatesVisibleMessageRows() {
        let messages = (0..<400).map { index in
            ChatMessage(
                id: "history-\(index)",
                role: index.isMultiple(of: 2) ? .user : .assistant,
                text: "第 \(index) 条历史消息，用于验证长会话不会一次性创建全部消息行。"
            )
        }
        let list = MessageListView(messages: messages) {
            EmptyView()
        }
        let host = UIHostingController(rootView: list)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        self.window = window
        window.rootViewController = host
        window.makeKeyAndVisible()

        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        host.view.layoutIfNeeded()

        let instantiatedRows = host.view.descendants {
            $0.accessibilityIdentifier?.hasPrefix("agent-message-cell-") == true
        }
        XCTAssertGreaterThan(instantiatedRows.count, 0)
        XCTAssertLessThan(
            instantiatedRows.count,
            80,
            "固定高度视口不应实例化 400 条历史消息的全部 SwiftUI 行"
        )
    }

    @MainActor
    func testMessageRowModelAppliesPureTextDeltaToLeafOnly() throws {
        let initial = ChatMessage(
            id: "a1",
            role: .assistant,
            blocks: [.text(TextBlock(messageId: "m1", index: 0, text: "Hel"))],
            isStreaming: true
        )
        var next = initial
        next.blocks = [.text(TextBlock(messageId: "m1", index: 0, text: "Hello"))]
        let model = MessageRowModel(message: initial)
        let leaf = try XCTUnwrap(model.textLeaves["text_m1_0"])

        XCTAssertTrue(model.applyTextLeaves(from: next))
        XCTAssertEqual(model.structuralGeneration, 0)
        XCTAssertEqual(model.structuralMessage.text, "Hel")
        XCTAssertEqual(model.snapshot().text, "Hello")
        XCTAssertEqual(leaf.block.text, "Hello")
        XCTAssertEqual(leaf.generation, 1)
    }

    @MainActor
    func testMessageRowModelRejectsNewTextBlockAsLeafOnlyChange() {
        let initial = ChatMessage(id: "a1", role: .assistant, isStreaming: true)
        var next = initial
        next.blocks = [.text(TextBlock(messageId: "m1", index: 0, text: "Hello"))]
        let model = MessageRowModel(message: initial)

        XCTAssertFalse(model.applyTextLeaves(from: next))
        XCTAssertTrue(model.textLeaves.isEmpty)
    }

    @MainActor
    func testMessageRowModelRejectsStreamingTerminalAsLeafOnlyChange() {
        let initial = ChatMessage(id: "a1", role: .assistant, text: "Hello", isStreaming: true)
        var terminal = initial
        terminal.isStreaming = false
        let model = MessageRowModel(message: initial)

        XCTAssertFalse(model.applyTextLeaves(from: terminal))
        model.replaceStructure(with: terminal)

        XCTAssertFalse(model.structuralMessage.isStreaming)
        XCTAssertEqual(model.structuralGeneration, 1)
    }

    @MainActor
    func testMessageRowModelRejectsFirstVisibleTextAfterWhitespace() {
        let initial = ChatMessage(
            id: "a1",
            role: .assistant,
            blocks: [.text(TextBlock(messageId: "m1", index: 0, text: "\n"))],
            isStreaming: true
        )
        var visible = initial
        visible.blocks = [.text(TextBlock(messageId: "m1", index: 0, text: "\nHello"))]
        let model = MessageRowModel(message: initial)

        XCTAssertFalse(model.applyTextLeaves(from: visible))
        XCTAssertEqual(model.structuralMessage.text, "\n")
    }
}

private extension UIView {
    func descendants(matching predicate: (UIView) -> Bool) -> [UIView] {
        subviews.flatMap { subview in
            (predicate(subview) ? [subview] : []) + subview.descendants(matching: predicate)
        }
    }
}

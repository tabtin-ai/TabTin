import XCTest
@testable import Tabtin

final class MessageListSameTurnPolicyTests: XCTestCase {
    func testHidesIdentityOnConsecutiveAssistantBubblesInSameTurn() {
        let user = ChatMessage(id: "u1", role: .user, text: "hi")
        let first = ChatMessage(id: "a1", role: .assistant, agentId: "agent-1", text: "step1")
        let second = ChatMessage(id: "a2", role: .assistant, agentId: "agent-1", text: "step2")
        let messages = [user, first, second]

        XCTAssertFalse(MessageListSameTurnPolicy.shouldHideAgentIdentity(for: first, in: messages))
        XCTAssertTrue(MessageListSameTurnPolicy.shouldHideAgentIdentity(for: second, in: messages))
    }

    func testShowsIdentityAgainAfterUserMessage() {
        let first = ChatMessage(id: "a1", role: .assistant, agentId: "agent-1", text: "one")
        let user = ChatMessage(id: "u2", role: .user, text: "again")
        let next = ChatMessage(id: "a3", role: .assistant, agentId: "agent-1", text: "two")
        let messages = [first, user, next]

        XCTAssertFalse(MessageListSameTurnPolicy.shouldHideAgentIdentity(for: next, in: messages))
    }

    func testShowsIdentityWhenAgentChanges() {
        let first = ChatMessage(id: "a1", role: .assistant, agentId: "agent-1", text: "one")
        let second = ChatMessage(id: "a2", role: .assistant, agentId: "agent-2", text: "two")
        let messages = [first, second]

        XCTAssertFalse(MessageListSameTurnPolicy.shouldHideAgentIdentity(for: second, in: messages))
    }

    func testSkipsSystemMessagesWhenScanningPreviousPeer() {
        let first = ChatMessage(id: "a1", role: .assistant, agentId: "agent-1", text: "one")
        let notice = ChatMessage(id: "s1", role: .system, text: "switched")
        let second = ChatMessage(id: "a2", role: .assistant, agentId: "agent-1", text: "two")
        let messages = [first, notice, second]

        XCTAssertTrue(MessageListSameTurnPolicy.shouldHideAgentIdentity(for: second, in: messages))
    }
}

import XCTest
#if canImport(Tabtin)
@testable import Tabtin
#endif

final class LastConversationMessageReplayCacheTests: XCTestCase {
    func testRememberMakesLatestMessageAvailableForReplay() {
        var cache = LastConversationMessageReplayCache<String>()

        cache.remember("message-1", for: "conversation-1")

        XCTAssertEqual(cache.replay(for: "conversation-1"), "message-1")
    }

    func testClearRemovesReplayForTargetConversation() {
        var cache = LastConversationMessageReplayCache<String>()
        cache.remember("message-1", for: "conversation-1")

        cache.clear(conversationId: "conversation-1")

        XCTAssertNil(cache.replay(for: "conversation-1"))
    }

    func testClearKeepsReplayForOtherConversations() {
        var cache = LastConversationMessageReplayCache<String>()
        cache.remember("message-1", for: "conversation-1")
        cache.remember("message-2", for: "conversation-2")

        cache.clear(conversationId: "conversation-1")

        XCTAssertEqual(cache.replay(for: "conversation-2"), "message-2")
    }

    func testClearAllRemovesEveryReplay() {
        var cache = LastConversationMessageReplayCache<String>()
        cache.remember("message-1", for: "conversation-1")
        cache.remember("message-2", for: "conversation-2")

        cache.clearAll()

        XCTAssertNil(cache.replay(for: "conversation-1"))
        XCTAssertNil(cache.replay(for: "conversation-2"))
    }
}

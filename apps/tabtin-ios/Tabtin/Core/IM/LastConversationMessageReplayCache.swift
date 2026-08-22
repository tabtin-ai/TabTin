import Foundation

struct LastConversationMessageReplayCache<Message> {
    private var messagesByConversationId: [String: Message] = [:]

    mutating func remember(_ message: Message, for conversationId: String) {
        messagesByConversationId[conversationId] = message
    }

    func replay(for conversationId: String) -> Message? {
        messagesByConversationId[conversationId]
    }

    mutating func clear(conversationId: String) {
        messagesByConversationId.removeValue(forKey: conversationId)
    }

    mutating func clearAll() {
        messagesByConversationId.removeAll()
    }
}

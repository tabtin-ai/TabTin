import Foundation

/// 会话标题只消费产品语义，不把传输层的系统占位名暴露给用户。
enum IMConversationTitlePolicy {
    private static let providerFallbacks: Set<String> = [
        "tabtin private conversation",
        "private conversation",
    ]

    static func resolve(
        conversationName: String,
        isDirectMessage: Bool,
        peerDisplayName: String?,
        directMessageFallback: String = "私信",
        conversationFallback: String = "会话"
    ) -> String {
        let name = normalized(conversationName)
        guard isDirectMessage else {
            return name.isEmpty ? conversationFallback : name
        }

        let peer = normalized(peerDisplayName ?? "")
        if isReadableDirectMessageName(peer) { return peer }
        if !name.isEmpty,
           isReadableDirectMessageName(name),
           !providerFallbacks.contains(name.lowercased()) {
            return name
        }
        return directMessageFallback
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isReadableDirectMessageName(_ value: String) -> Bool {
        !value.isEmpty && UUID(uuidString: value) == nil
    }
}

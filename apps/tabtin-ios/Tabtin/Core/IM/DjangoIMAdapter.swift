import Foundation

/// 推送里的 organization_id 只是发送方提示。跨组织会话要逐个查询当前用户可见目录，
/// 找到真正承载该会话的本地组织后再切换页面。
@MainActor
func resolveDjangoIMConversationOrganizationId(
    conversationId: String,
    candidateOrganizationIds: [String],
    loadConversations: @MainActor (String) async throws -> [IMConversation]
) async throws -> String? {
    for organizationId in candidateOrganizationIds where !organizationId.isEmpty {
        if try await loadConversations(organizationId).contains(where: { $0.id == conversationId }) {
            return organizationId
        }
    }
    return nil
}

private struct IMEmptyResponse: Decodable, Sendable {}

func djangoIMConversationPinBody(_ pinned: Bool) -> [String: Any] {
    ["pinned": pinned]
}

func djangoIMConversationMuteBody(_ muted: Bool) -> [String: Any] {
    ["muted": muted]
}

private struct DjangoIMGroupedSearch: Decodable, Sendable {
    let groups: [Group]

    struct Group: Decodable, Sendable {
        let conversationId: String
        let conversationName: String
        let conversationType: Int
        let conversationAvatarURL: String
        let matchCount: Int
        let messages: [IMMessage]

        enum CodingKeys: String, CodingKey {
            case conversationId = "conversation_id"
            case conversationName = "conversation_name"
            case conversationType = "conversation_type"
            case conversationAvatarURL = "conversation_avatar_url"
            case matchCount = "match_count"
            case messages
        }
    }
}

private struct DjangoIMReadReceipts: Decodable, Sendable {
    let readers: [Member]
    let unreaders: [Member]

    struct Member: Decodable, Sendable {
        let userId: String
        let name: String
        let avatar: String

        enum CodingKeys: String, CodingKey {
            case userId = "user_id"
            case name, avatar
        }
    }
}

/// 自建 IM 的 iOS 边界。Store 只认识领域协议；HTTP 信封、路径和 Centrifugo 拓扑留在 Adapter 外围。
@MainActor
final class DjangoIMAdapter: IMMessageTransport, IMConversationDataPlane {
    private struct ForwardedSource: Sendable {
        let messageId: Int
        let conversationId: String
        let conversationName: String
        let senderId: String
        let senderName: String
    }

    static let shared = DjangoIMAdapter()
    private var conversationChanged: (@MainActor @Sendable () -> Void)?

    private init() {}

    func setRealtimeListener(conversationId: String, listener: (@MainActor @Sendable (IMMessage) -> Void)?) {}

    func setConversationChangedListener(_ listener: (@MainActor @Sendable () -> Void)?) {
        conversationChanged = listener
    }

    func listConversations(organizationId: String) async throws -> [IMConversation] {
        try await APIClient.shared.get(
            path: Endpoints.IM.conversations,
            query: ["organization_id": organizationId]
        )
    }

    func resolveParticipantOrganizationId(
        conversationId: String,
        candidateOrganizationIds: [String]
    ) async throws -> String? {
        try await resolveDjangoIMConversationOrganizationId(
            conversationId: conversationId,
            candidateOrganizationIds: candidateOrganizationIds,
            loadConversations: { organizationId in
                try await self.listConversations(organizationId: organizationId)
            }
        )
    }

    func searchMessages(organizationId: String, query: String) async throws -> [IMMessageSearchResult] {
        let result: DjangoIMGroupedSearch = try await APIClient.shared.get(
            path: Endpoints.IM.groupedSearch,
            query: ["organization_id": organizationId, "q": query]
        )
        return result.groups.map { group in
            IMMessageSearchResult(
                conversation: IMConversation(
                    id: group.conversationId,
                    organizationId: organizationId,
                    spaceId: nil,
                    spaceName: "",
                    isTeamSpaceChannel: false,
                    isExternal: false,
                    type: group.conversationType,
                    name: group.conversationName,
                    avatarUrl: group.conversationAvatarURL,
                    memberCount: 0,
                    isArchived: false,
                    lastMessageAt: nil,
                    lastMessagePreview: "",
                    unreadCount: 0,
                    lastMessageSeq: 0,
                    createdAt: "",
                    dmPeerUserId: nil,
                    pinned: false,
                    isMuted: false
                ),
                matchedMessagePreview: group.messages.first?.content ?? "",
                matchCount: group.matchCount
            )
        }
    }

    func pinConversation(conversationId: String, pinned: Bool) async throws {
        let result: IMConversationPinResult = try await APIClient.shared.post(
            path: Endpoints.IM.pin(conversationId),
            body: djangoIMConversationPinBody(pinned)
        )
        guard result.pinned == pinned else { throw APIError.apiError("会话置顶状态未能同步，请重试") }
        conversationChanged?()
    }

    func setConversationMuted(conversationId: String, muted: Bool) async throws {
        let result: IMConversationMuteResult = try await APIClient.shared.post(
            path: Endpoints.IM.mute(conversationId),
            body: djangoIMConversationMuteBody(muted)
        )
        guard result.muted == muted else { throw APIError.apiError("会话免打扰状态未能同步，请重试") }
        conversationChanged?()
    }

    func markConversationRemoved(conversationId: String) { conversationChanged?() }

    func clearSession() { conversationChanged = nil }

    func fetchMessages(conversationId: String, before: Int?, limit: Int) async throws -> [IMMessage] {
        var query = ["limit": String(limit)]
        if let before { query["before"] = String(before) }
        return try await APIClient.shared.get(path: Endpoints.IM.messages(conversationId), query: query)
    }

    func fetchHistoryClearedSeq(conversationId: String) async throws -> Int {
        let state: IMHistoryState = try await APIClient.shared.get(path: Endpoints.IM.historyState(conversationId))
        return state.historyClearedSeq
    }

    func sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        clientRequestId: String
    ) async throws -> IMSendMessageResult {
        try await sendMessage(
            conversationId: conversationId, content: content, messageType: messageType,
            replyToId: replyToId, mentionedUserIds: mentionedUserIds,
            mentionedAgentIds: mentionedAgentIds, mentionAll: mentionAll,
            attachment: attachment, card: nil, clientRequestId: clientRequestId
        )
    }

    func sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        card: IMOutgoingCard?,
        clientRequestId: String
    ) async throws -> IMSendMessageResult {
        try await send(
            conversationId: conversationId, content: content, messageType: messageType,
            replyToId: replyToId, mentionedUserIds: mentionedUserIds,
            mentionedAgentIds: mentionedAgentIds, mentionAll: mentionAll,
            attachment: attachment, card: card, forwardedFrom: nil,
            clientRequestId: clientRequestId
        )
    }

    func forwardMessage(
        _ message: IMMessage,
        sourceConversationName: String,
        to conversationId: String,
        clientRequestId: String
    ) async throws -> IMSendMessageResult {
        let attachment = message.metadata?.fileId.map {
            IMOutgoingAttachment(
                fileId: $0,
                fileName: message.metadata?.fileName ?? "",
                fileSize: message.metadata?.fileSize ?? 0,
                fileType: message.metadata?.fileType ?? ""
            )
        }
        return try await send(
            conversationId: conversationId,
            content: message.content,
            messageType: message.messageType,
            replyToId: nil,
            mentionedUserIds: [],
            mentionedAgentIds: [],
            mentionAll: false,
            attachment: attachment,
            card: message.forwardableCard,
            forwardedFrom: ForwardedSource(
                messageId: message.id,
                conversationId: message.conversationId,
                conversationName: sourceConversationName,
                senderId: message.senderId,
                senderName: message.senderName
            ),
            clientRequestId: clientRequestId
        )
    }

    private func send(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        card: IMOutgoingCard?,
        forwardedFrom: ForwardedSource?,
        clientRequestId: String
    ) async throws -> IMSendMessageResult {
        try await APIClient.shared.post(
            path: Endpoints.IM.messages(conversationId),
            body: Self.messageBody(
                content: content,
                messageType: messageType,
                replyToId: replyToId,
                mentionedUserIds: mentionedUserIds,
                mentionedAgentIds: mentionedAgentIds,
                mentionAll: mentionAll,
                attachment: attachment,
                card: card,
                forwardedFrom: forwardedFrom,
                clientRequestId: clientRequestId
            )
        )
    }

    private nonisolated static func messageBody(
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        card: IMOutgoingCard?,
        forwardedFrom: ForwardedSource?,
        clientRequestId: String
    ) -> sending [String: Any] {
        var body: [String: Any] = [
            "content": content,
            "message_type": messageType,
            "client_request_id": clientRequestId,
        ]
        if let replyToId { body["reply_to_id"] = replyToId }
        var metadata: [String: Any] = [:]
        if !mentionedUserIds.isEmpty { metadata["mentioned_user_ids"] = mentionedUserIds }
        if !mentionedAgentIds.isEmpty { metadata["mentioned_agent_ids"] = mentionedAgentIds }
        if mentionAll { metadata["mention_all"] = true }
        if let attachment {
            metadata["file_id"] = attachment.fileId
            metadata["file_name"] = attachment.fileName
            metadata["file_size"] = attachment.fileSize
            metadata["file_type"] = attachment.fileType
        }
        if let card { metadata["card"] = card.requestPayload() }
        if let forwardedFrom {
            metadata["forwarded_from"] = [
                "original_message_id": forwardedFrom.messageId,
                "original_conversation_id": forwardedFrom.conversationId,
                "original_conversation_name": forwardedFrom.conversationName,
                "original_sender_id": forwardedFrom.senderId,
                "original_sender_name": forwardedFrom.senderName,
            ]
        }
        if !metadata.isEmpty { body["metadata"] = metadata }
        return body
    }

    func editMessage(conversationId: String, messageId: Int, content: String) async throws -> IMMessage {
        try await APIClient.shared.patch(path: Endpoints.IM.message(conversationId, messageId), body: ["content": content])
    }

    func recallMessage(conversationId: String, messageId: Int) async throws {
        let _: IMEmptyResponse = try await APIClient.shared.delete(path: Endpoints.IM.message(conversationId, messageId))
    }

    func addReaction(conversationId: String, messageId: Int, emoji: String) async throws {
        let _: IMEmptyResponse = try await APIClient.shared.post(
            path: Endpoints.IM.reactions(conversationId, messageId), body: ["emoji": emoji]
        )
    }

    func removeReaction(conversationId: String, messageId: Int, emoji: String) async throws {
        let _: IMEmptyResponse = try await APIClient.shared.request(
            "DELETE", path: Endpoints.IM.reactions(conversationId, messageId), query: ["emoji": emoji]
        )
    }

    func markRead(conversationId: String, visibleMessage: IMMessage) async throws -> Int {
        let _: IMEmptyResponse = try await APIClient.shared.post(
            path: Endpoints.IM.read(conversationId), body: ["last_message_id": visibleMessage.id]
        )
        return visibleMessage.seq
    }

    func fetchReadReceipts(conversationId: String, messageId: Int) async throws -> IMMessageReadReceipts {
        let result: DjangoIMReadReceipts = try await APIClient.shared.get(
            path: Endpoints.IM.readReceipts(conversationId, messageId)
        )
        func map(_ members: [DjangoIMReadReceipts.Member]) -> [IMReadReceiptMember] {
            members.map { IMReadReceiptMember(userId: $0.userId, name: $0.name, avatar: $0.avatar) }
        }
        return IMMessageReadReceipts(readers: map(result.readers), unreaders: map(result.unreaders))
    }

    func fetchPinnedMessages(conversationId: String) async throws -> [IMMessage] {
        try await APIClient.shared.get(path: Endpoints.IM.pinnedMessages(conversationId))
    }

    func pinMessage(conversationId: String, messageId: Int, pinned: Bool) async throws {
        if pinned {
            let _: IMMessage = try await APIClient.shared.post(
                path: Endpoints.IM.messagePin(conversationId, messageId), body: [:]
            )
        } else {
            let _: IMEmptyResponse = try await APIClient.shared.delete(
                path: Endpoints.IM.messagePin(conversationId, messageId)
            )
        }
    }

    func clearHistory(conversationId: String) async throws {
        _ = try await clearHistoryAndFetchWatermark(conversationId: conversationId)
    }

    func clearHistoryAndFetchWatermark(conversationId: String) async throws -> Int {
        let result: IMClearHistoryResult = try await APIClient.shared.post(
            path: Endpoints.IM.clearHistory(conversationId), body: [:]
        )
        return result.clearedSeq
    }

    func leaveConversation(conversationId: String) async throws {
        let _: IMEmptyResponse = try await APIClient.shared.post(path: Endpoints.IM.leave(conversationId), body: [:])
        conversationChanged?()
    }
}

import Foundation

/// TabChat IM (`/api/im/*`) REST 路径，扩展既有 `Endpoints.IM`。
///
/// `conversations` 已由 `Core/Network/Endpoints.swift` 的 `enum IM` 定义（团队 Space
/// 频道 / Project discussions 复用同一端点），此处只补充其余 IM 路径，避免重复声明。
/// 当前消息主链路契约真源：`apps/tabtin_django/apps/tabchat/api.py`。
///
/// TabChat 是「人↔人 / 群聊 / 团队频道 / @Agent」的即时通讯，与 Agent 对话
/// （`Endpoints.Chat`，`/chat/sessions/*`）是两套系统，不要混用。
extension Endpoints.IM {
    static let createDM = "/im/conversations/dm"
    static let createGroup = "/im/conversations/group"
    static let externalContacts = "/im/external-contacts"
    static let discoverExternalContact = "/im/external-contacts/discover"
    static let externalContactInvitations = "/im/external-contact-invitations"
    static let acceptExternalContact = "/im/external-contacts/accept"
    static let labels = "/im/labels"

    static func label(_ labelId: String) -> String { "/im/labels/\(labelId)" }

    static func conversationLabels(_ conversationId: String) -> String {
        "/im/conversations/\(conversationId)/labels"
    }

    static func conversationLabel(_ conversationId: String, _ labelId: String) -> String {
        "/im/conversations/\(conversationId)/labels/\(labelId)"
    }

    static func externalContact(_ contactId: String) -> String {
        "/im/external-contacts/\(contactId)"
    }

    static func externalContactInvitation(_ invitationId: String) -> String {
        "/im/external-contact-invitations/\(invitationId)"
    }

    static func messages(_ conversationId: String) -> String {
        "/im/conversations/\(conversationId)/messages"
    }

    static func conversation(_ id: String) -> String { "/im/conversations/\(id)" }
    static let groupedSearch = "/im/search/grouped"
    static func historyState(_ id: String) -> String { "/im/conversations/\(id)/history-state" }
    static func clearHistory(_ id: String) -> String { "/im/conversations/\(id)/clear-history" }
    static func leave(_ id: String) -> String { "/im/conversations/\(id)/leave" }
    static func pin(_ id: String) -> String { "/im/conversations/\(id)/pin" }
    static func mute(_ id: String) -> String { "/im/conversations/\(id)/mute" }
    static func members(_ id: String) -> String { "/im/conversations/\(id)/members" }
    static func member(_ id: String, _ userId: String) -> String {
        "/im/conversations/\(id)/members/\(userId)"
    }
    static func agent(_ id: String, _ agentId: String) -> String {
        "/im/conversations/\(id)/agents/\(agentId)"
    }
    static func agentBindings(_ id: String) -> String { "/im/conversations/\(id)/agent-bindings" }
    static func agentBinding(_ id: String, _ agentId: String) -> String {
        "/im/conversations/\(id)/agent-bindings/\(agentId)"
    }
    static func message(_ id: String, _ messageId: Int) -> String {
        "/im/conversations/\(id)/messages/\(messageId)"
    }
    static func agentTask(_ id: String, _ messageId: Int) -> String {
        message(id, messageId) + "/agent-task"
    }
    static func reactions(_ id: String, _ messageId: Int) -> String { message(id, messageId) + "/reactions" }
    static func messagePin(_ id: String, _ messageId: Int) -> String { message(id, messageId) + "/pin" }
    static func pinnedMessages(_ id: String) -> String { "/im/conversations/\(id)/pinned-messages" }
    static func readReceipts(_ id: String, _ messageId: Int) -> String { message(id, messageId) + "/read-receipts" }
    static func read(_ id: String) -> String { "/im/conversations/\(id)/read" }

    static func messageReferences(_ conversationId: String) -> String {
        "/im/conversations/\(conversationId)/message-references/resolve"
    }

    /// 搜索 organization 内可 @ 的 AI Agent（本人拥有的启用 bot）。
    static let agentsSearch = "/im/agents/search"

    static let handoffs = "/im/handoffs"
    static func handoff(_ id: String) -> String { "/im/handoffs/\(id)" }
    static func handoffActions(_ id: String) -> String { "/im/handoffs/\(id)/actions" }
    static func handoffRevoke(_ id: String) -> String { "/im/handoffs/\(id)/revoke" }
    static func handoffTakeOver(_ id: String) -> String { "/im/handoffs/\(id)/take-over-session" }

    static let sessionShares = "/chat/session-shares"
    static func sessionShare(_ id: String) -> String { "/chat/session-shares/\(id)" }
    static func sessionShareRevoke(_ id: String) -> String { "/chat/session-shares/\(id)/revoke" }
    static let sessionShareBatchGet = "/chat/session-shares/batch-get"
    static func sessionShareAccept(_ id: String) -> String { "/chat/session-shares/\(id)/accept" }
    static func sessionShareRetryDelivery(_ id: String) -> String {
        "/chat/session-shares/\(id)/delivery/retry"
    }

    static func sessionShareSharedChat(_ sessionId: String) -> String {
        "/chat/sessions/\(sessionId)/shared-chat"
    }

    static func sessionShareSharedExecutionStatus(_ sessionId: String) -> String {
        "/chat/sessions/\(sessionId)/shared-execution-status"
    }

    static let sessionContinuations = "/chat/session-continuations"
    static let sessionContinuationBatchGet = "/chat/session-continuations/batch-get"
    static func sessionContinuationCreateTask(_ id: String) -> String {
        "/chat/session-continuations/\(id)/create-task"
    }

    static let resourceCardPreview = "/im/resource-card-preview"
    static let resourceAccessRequests = "/im/resource-access-requests"
    static func resourceAccessRequestApprove(_ id: String) -> String {
        "/im/resource-access-requests/\(id)/approve"
    }

    static func spaceChannels(_ spaceId: String) -> String {
        "/im/spaces/\(spaceId)/channels"
    }

    /// Centrifugo Connect Proxy：由 Centrifugo 服务端回调 Django 鉴权，
    /// 客户端不直接请求（保留常量用于文档 / 诊断）。
    static let centrifugoConnect = "/im/centrifugo/connect"
}

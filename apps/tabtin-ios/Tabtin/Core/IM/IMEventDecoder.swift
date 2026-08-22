import Foundation

/// TabChat 实时事件（Centrifugo publication 解析结果）。
///
/// 覆盖消息、会话、已读、卡片状态和个人 Agent 提示；无法识别的新增事件保留 type，
/// 逐字段对齐 Electron `useCentrifugoClient.ts` 与后端 outbox payload。
enum IMRealtimeEvent: Sendable, Equatable {
    /// `chat:{conv}` 新消息，`data` 为完整 `IMMessage`。
    case message(IMMessage)
    /// `chat:{conv}` 消息被编辑，`data` 为完整（新）`IMMessage`。
    case messageEdited(IMMessage)
    /// `chat:{conv}` 消息被撤回（软删）。
    case messageDeleted(messageId: Int)
    /// `chat:{conv}` 消息被置顶，负载为完整消息。
    case messagePinned(IMMessage)
    /// `chat:{conv}` 消息被取消置顶。
    case messageUnpinned(messageId: Int)
    /// `chat:{conv}` 表情回应增删（`added=false` 为移除）。
    case reaction(messageId: Int, userId: String, emoji: String, added: Bool)
    /// `chat:{conv}` 已读回执：某用户已读到 `lastReadSeq`。
    case readReceipt(IMReadReceiptEvent)
    /// `personal:{userId}` 未读更新（前台会话列表角标即时刷新）。
    case unreadUpdate(IMUnreadUpdate)
    /// `personal:{userId}` 新会话（如新建 DM），`data` 为会话摘要（同列表项形状）。
    case conversationNew(IMConversation)
    /// 最后一条消息被编辑或撤回；只刷新目录摘要，不增加未读。
    case conversationPreviewUpdated(IMConversationPreviewUpdate)
    /// 当前用户给某会话贴/撕标签后的权威快照。
    case conversationLabelsUpdated(conversationId: String, labels: [IMConversationLabel])
    /// 共享会话参与者的资料发生变化；私聊目录就地更新，活动群详情按版本重拉。
    case userProfileUpdated(IMUserProfileUpdated)
    /// 会话资料或成员发生变化；详情和目录应重新拉取权威快照。
    case conversationChanged
    /// `chat:{conv}` 对端正在输入。
    case typing(userId: String)
    /// 交接包状态变化；卡片收到后按 id 重拉详情，不能信任事件快照替代权限校验。
    case handoffUpdate(handoffId: String)
    /// 任务共享状态变化；卡片按 share id 失效缓存并重拉详情。
    case sessionShareUpdate(shareId: String)
    /// Agent 可见文本增量；按 `messageRef` 聚合，`streamSeq` 负责去重与乱序保护。
    case agentMessageStream(IMAgentMessageStreamEvent)
    /// Agent 最终可见消息；替换同 `messageRef` 的临时流式消息。
    case agentMessageFinal(IMAgentMessageFinalEvent)
    /// Agent 执行失败；清理同 `messageRef` 的临时流式消息。
    case agentMessageError(IMAgentMessageErrorEvent)
    /// @Agent 执行失败；仅发起人 personal 频道可见，不在群里留失败消息。
    case aiError(agentName: String, reason: String)
    /// Agent 建议把当前请求转为独立任务；仅作轻量个人提示。
    case aiSuggestTask(conversationId: String?, messageId: Int?, agentName: String)
    /// 本期未处理的事件类型（保留 type 便于日志/后续扩展）。
    case unknown(type: String)
}

struct IMAgentMessageStreamEvent: Decodable, Sendable, Equatable {
    let conversationId: String
    let messageRef: String
    let agentSessionRef: String
    let senderId: String
    let senderName: String
    let senderAvatar: String
    let delta: String
    let streamSeq: Int
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case messageRef = "message_ref"
        case agentSessionRef = "agent_session_ref"
        case senderId = "sender_id"
        case senderName = "sender_name"
        case senderAvatar = "sender_avatar"
        case delta
        case streamSeq = "stream_seq"
        case createdAt = "created_at"
    }
}

struct IMAgentMessageFinalEvent: Decodable, Sendable, Equatable {
    let conversationId: String
    let messageRef: String
    let agentSessionRef: String
    let senderId: String
    let senderName: String
    let senderAvatar: String
    let content: String
    let messageType: Int
    let metadata: IMMessageMetadata?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case messageRef = "message_ref"
        case agentSessionRef = "agent_session_ref"
        case senderId = "sender_id"
        case senderName = "sender_name"
        case senderAvatar = "sender_avatar"
        case content
        case messageType = "message_type"
        case metadata
        case createdAt = "created_at"
    }
}

struct IMAgentMessageErrorEvent: Decodable, Sendable, Equatable {
    let conversationId: String
    let messageRef: String
    let agentSessionRef: String
    let senderId: String
    let senderName: String
    let senderAvatar: String

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case messageRef = "message_ref"
        case agentSessionRef = "agent_session_ref"
        case senderId = "sender_id"
        case senderName = "sender_name"
        case senderAvatar = "sender_avatar"
    }
}

struct IMConversationPreviewUpdate: Decodable, Sendable, Equatable {
    let conversationId: String
    let organizationId: String
    let directoryScopeId: String?
    let messageId: Int
    let messageSeq: Int
    let preview: String
    let lastMessageAt: String?

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case organizationId = "organization_id"
        case directoryScopeId = "directory_scope_id"
        case messageId = "message_id"
        case messageSeq = "message_seq"
        case lastMessageAt = "last_message_at"
        case preview
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        organizationId = try c.decodeIfPresent(String.self, forKey: .organizationId) ?? ""
        directoryScopeId = try c.decodeIfPresent(String.self, forKey: .directoryScopeId)
        messageId = try c.decodeIfPresent(Int.self, forKey: .messageId) ?? 0
        messageSeq = try c.decodeIfPresent(Int.self, forKey: .messageSeq) ?? 0
        preview = try c.decodeIfPresent(String.self, forKey: .preview) ?? ""
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
    }
}

/// `im.read.receipt` 负载（`message_service` L1686）。
struct IMReadReceiptEvent: Decodable, Sendable, Equatable {
    let conversationId: String
    let userId: String
    let lastReadMessageId: Int?
    let lastReadSeq: Int

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case userId = "user_id"
        case lastReadMessageId = "last_read_message_id"
        case lastReadSeq = "last_read_seq"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId) ?? ""
        userId = try c.decodeIfPresent(String.self, forKey: .userId) ?? ""
        lastReadMessageId = try? c.decodeIfPresent(Int.self, forKey: .lastReadMessageId)
        lastReadSeq = try c.decodeIfPresent(Int.self, forKey: .lastReadSeq) ?? 0
    }
}

/// `im.reaction.added` / `im.reaction.removed` 负载（`message_service` L1931）。
struct IMReactionEvent: Decodable, Sendable, Equatable {
    let messageId: Int
    let userId: String
    let emoji: String

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case userId = "user_id"
        case emoji
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try c.decodeIfPresent(Int.self, forKey: .messageId) ?? 0
        userId = try c.decodeIfPresent(String.self, forKey: .userId) ?? ""
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji) ?? ""
    }
}

/// `im.message.deleted` 负载（`message_service` L740）。
struct IMMessageDeletedEvent: Decodable, Sendable, Equatable {
    let messageId: Int

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try c.decodeIfPresent(Int.self, forKey: .messageId) ?? 0
    }
}

private struct IMAIErrorEvent: Decodable {
    let agentName: String
    let reason: String

    enum CodingKeys: String, CodingKey {
        case agentName = "agent_name"
        case reason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentName = try c.decodeIfPresent(String.self, forKey: .agentName) ?? ""
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
    }
}

private struct IMAISuggestTaskEvent: Decodable {
    let conversationId: String?
    let messageId: Int?
    let agentName: String

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case messageId = "message_id"
        case agentName = "agent_name"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId)
        messageId = try c.decodeIfPresent(Int.self, forKey: .messageId)
        agentName = try c.decodeIfPresent(String.self, forKey: .agentName) ?? ""
    }
}

/// `im.unread.update` 负载：两种形状共用同一 type——
/// 1) 新消息：带 `message_id` / `preview` 等（personal_base + mention）
/// 2) 已读回写：带 `marked_read` / `last_read_seq`（mark_as_read 后推给本人）
struct IMUnreadUpdate: Decodable, Sendable, Equatable {
    let conversationId: String
    let organizationId: String
    let directoryScopeId: String?
    let messageId: Int
    let messageSeq: Int
    let senderId: String
    let senderName: String
    let preview: String
    let lastMessageAt: String?
    let mention: Bool
    /// 非 nil 表示这是「已读回写」事件（应把该会话未读清零），与新消息事件互斥。
    let markedRead: Int?

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case organizationId = "organization_id"
        case directoryScopeId = "directory_scope_id"
        case messageId = "message_id"
        case messageSeq = "message_seq"
        case senderId = "sender_id"
        case senderName = "sender_name"
        case preview
        case lastMessageAt = "last_message_at"
        case mention
        case markedRead = "marked_read"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        organizationId = try c.decodeIfPresent(String.self, forKey: .organizationId) ?? ""
        directoryScopeId = try c.decodeIfPresent(String.self, forKey: .directoryScopeId)
        messageId = try c.decodeIfPresent(Int.self, forKey: .messageId) ?? 0
        messageSeq = try c.decodeIfPresent(Int.self, forKey: .messageSeq) ?? 0
        senderId = try c.decodeIfPresent(String.self, forKey: .senderId) ?? ""
        senderName = try c.decodeIfPresent(String.self, forKey: .senderName) ?? ""
        preview = try c.decodeIfPresent(String.self, forKey: .preview) ?? ""
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
        mention = try c.decodeIfPresent(Bool.self, forKey: .mention) ?? false
        markedRead = try? c.decodeIfPresent(Int.self, forKey: .markedRead)
    }

    /// 已读回写事件（应清零列表未读）。
    var isMarkedReadEvent: Bool { markedRead != nil }
}

/// `im.user.profile.updated` 负载。Django 会推给仍共享可见会话的参与者。
struct IMUserProfileUpdated: Decodable, Sendable, Equatable {
    let userId: String
    let nickname: String
    let username: String
    let avatar: String
    let avatarVersion: String
    let revision: Int

    enum CodingKeys: String, CodingKey {
        case userId = "id"
        case nickname, username, avatar, revision
        case avatarVersion = "avatar_version"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decodeIfPresent(String.self, forKey: .userId) ?? ""
        nickname = try c.decodeIfPresent(String.self, forKey: .nickname) ?? ""
        username = try c.decodeIfPresent(String.self, forKey: .username) ?? ""
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar) ?? ""
        avatarVersion = try c.decodeIfPresent(String.self, forKey: .avatarVersion) ?? ""
        revision = try c.decodeIfPresent(Int.self, forKey: .revision) ?? 0
    }

    var displayName: String {
        let preferred = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        return preferred.isEmpty
            ? username.trimmingCharacters(in: .whitespacesAndNewlines)
            : preferred
    }
}

/// Centrifugo publication 原始字节 → 类型化事件。
///
/// 外层信封形如 `{ "type": "im.*", "event_id": "...", "data": {...} }`；`im.typing` 例外，
/// 字段直接铺在顶层：`{ "type": "im.typing", "user_id": "..." }`。无法识别或解析失败返回
/// `nil`（调用方据此丢弃脏包，不影响连接）。
enum IMEventDecoder {
    private struct Head: Decodable {
        let type: String
    }

    private struct DataEnvelope<T: Decodable>: Decodable {
        let data: T
    }

    private struct TypingEnvelope: Decodable {
        let userId: String
        enum CodingKeys: String, CodingKey {
            case userId = "user_id"
        }
    }

    private struct HandoffUpdate: Decodable {
        let handoffId: String
        enum CodingKeys: String, CodingKey { case handoffId = "handoff_id" }
    }

    private struct SessionShareUpdate: Decodable {
        let shareId: String
        enum CodingKeys: String, CodingKey { case shareId = "share_id" }
    }

    private struct ConversationLabelsUpdated: Decodable {
        let conversationId: String
        let labels: [IMConversationLabel]

        enum CodingKeys: String, CodingKey {
            case conversationId = "conversation_id"
            case labels
        }
    }

    static func decode(_ raw: Data) -> IMRealtimeEvent? {
        let decoder = JSONDecoder()
        guard let head = try? decoder.decode(Head.self, from: raw) else { return nil }
        switch head.type {
        case "im.message":
            guard let env = try? decoder.decode(DataEnvelope<IMMessage>.self, from: raw) else { return nil }
            return .message(env.data)
        case "im.message.edited":
            guard let env = try? decoder.decode(DataEnvelope<IMMessage>.self, from: raw) else { return nil }
            return .messageEdited(env.data)
        case "im.message.deleted":
            guard let env = try? decoder.decode(DataEnvelope<IMMessageDeletedEvent>.self, from: raw) else { return nil }
            return .messageDeleted(messageId: env.data.messageId)
        case "im.message.pinned":
            guard let env = try? decoder.decode(DataEnvelope<IMMessage>.self, from: raw) else { return nil }
            return .messagePinned(env.data)
        case "im.message.unpinned":
            guard let env = try? decoder.decode(DataEnvelope<IMMessageDeletedEvent>.self, from: raw) else { return nil }
            return .messageUnpinned(messageId: env.data.messageId)
        case "im.reaction.added", "im.reaction.removed":
            guard let env = try? decoder.decode(DataEnvelope<IMReactionEvent>.self, from: raw) else { return nil }
            return .reaction(
                messageId: env.data.messageId,
                userId: env.data.userId,
                emoji: env.data.emoji,
                added: head.type == "im.reaction.added"
            )
        case "im.read.receipt":
            guard let env = try? decoder.decode(DataEnvelope<IMReadReceiptEvent>.self, from: raw) else { return nil }
            return .readReceipt(env.data)
        case "im.unread.update":
            guard let env = try? decoder.decode(DataEnvelope<IMUnreadUpdate>.self, from: raw) else { return nil }
            return .unreadUpdate(env.data)
        case "im.conversation.new":
            guard let env = try? decoder.decode(DataEnvelope<IMConversation>.self, from: raw) else { return nil }
            return .conversationNew(env.data)
        case "im.conversation.preview.updated":
            guard let env = try? decoder.decode(DataEnvelope<IMConversationPreviewUpdate>.self, from: raw) else {
                return nil
            }
            return .conversationPreviewUpdated(env.data)
        case "im.conversation.labels.updated":
            guard let env = try? decoder.decode(DataEnvelope<ConversationLabelsUpdated>.self, from: raw) else {
                return nil
            }
            return .conversationLabelsUpdated(
                conversationId: env.data.conversationId,
                labels: env.data.labels
            )
        case "im.user.profile.updated":
            guard let env = try? decoder.decode(DataEnvelope<IMUserProfileUpdated>.self, from: raw) else {
                return nil
            }
            return .userProfileUpdated(env.data)
        case "im.conversation.updated", "im.member.joined", "im.member.left":
            return .conversationChanged
        case "im.typing":
            guard let env = try? decoder.decode(TypingEnvelope.self, from: raw) else { return nil }
            return .typing(userId: env.userId)
        case "im.handoff.update":
            guard let env = try? decoder.decode(DataEnvelope<HandoffUpdate>.self, from: raw) else { return nil }
            return .handoffUpdate(handoffId: env.data.handoffId)
        case "im.session_share.update":
            guard let env = try? decoder.decode(DataEnvelope<SessionShareUpdate>.self, from: raw) else { return nil }
            return .sessionShareUpdate(shareId: env.data.shareId)
        case "im.agent.message.stream":
            guard let env = try? decoder.decode(DataEnvelope<IMAgentMessageStreamEvent>.self, from: raw) else {
                return nil
            }
            return .agentMessageStream(env.data)
        case "im.agent.message.final":
            guard let env = try? decoder.decode(DataEnvelope<IMAgentMessageFinalEvent>.self, from: raw) else {
                return nil
            }
            return .agentMessageFinal(env.data)
        case "im.agent.message.error":
            guard let env = try? decoder.decode(DataEnvelope<IMAgentMessageErrorEvent>.self, from: raw) else {
                return nil
            }
            return .agentMessageError(env.data)
        case "im.ai.error":
            guard let env = try? decoder.decode(DataEnvelope<IMAIErrorEvent>.self, from: raw) else { return nil }
            return .aiError(agentName: env.data.agentName, reason: env.data.reason)
        case "im.ai.suggest_task":
            guard let env = try? decoder.decode(DataEnvelope<IMAISuggestTaskEvent>.self, from: raw) else { return nil }
            return .aiSuggestTask(
                conversationId: env.data.conversationId,
                messageId: env.data.messageId,
                agentName: env.data.agentName
            )
        default:
            return .unknown(type: head.type)
        }
    }
}

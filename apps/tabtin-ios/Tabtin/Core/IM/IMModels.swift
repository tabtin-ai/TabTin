import Foundation

/// 单条消息最多允许的不同表情种类数；所有添加入口必须共用这一领域边界。
let imReactionKindLimit = 10

/// Django `SendMessageRequest.content` 的传输无关契约，按 Unicode scalar 计数以对齐 Python `len`。
let imMessageContentMaxLength = 10_000

func getIMMessageContentLength(_ content: String) -> Int { content.unicodeScalars.count }

func isIMMessageContentWithinLimit(_ content: String) -> Bool {
    getIMMessageContentLength(content) <= imMessageContentMaxLength
}

func canAddIMReaction(_ emoji: String, to reactions: [String: [String]]) -> Bool {
    if reactions[emoji]?.isEmpty == false { return true }
    return reactions.values.filter { !$0.isEmpty }.count < imReactionKindLimit
}

/// 会话类型，对齐后端 `tabchat.constants.ConversationType`。
enum IMConversationType: Int, Sendable {
    case dm = 1
    case group = 2
}

enum IMConversationSendError: LocalizedError, Sendable, Equatable {
    case removedMember

    var errorDescription: String? {
        switch self {
        case .removedMember:
            return "对方已不在组织，当前会话只读。"
        }
    }
}

struct IMConversationLabel: Decodable, Sendable, Identifiable, Equatable {
    static let systemMention = IMConversationLabel(
        id: "sys:mention",
        name: "@me",
        color: "#ef4444",
        isSystem: true
    )

    let id: String
    let name: String
    let color: String
    let isSystem: Bool
    let conversationCount: Int

    enum CodingKeys: String, CodingKey {
        case id, name, color
        case isSystem = "is_system"
        case conversationCount = "conversation_count"
    }

    init(
        id: String,
        name: String,
        color: String = "#6b7280",
        isSystem: Bool = false,
        conversationCount: Int = 0
    ) {
        self.id = id
        self.name = name
        self.color = color
        self.isSystem = isSystem
        self.conversationCount = conversationCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        color = try container.decodeIfPresent(String.self, forKey: .color) ?? "#6b7280"
        isSystem = try container.decodeIfPresent(Bool.self, forKey: .isSystem) ?? false
        conversationCount = try container.decodeIfPresent(Int.self, forKey: .conversationCount) ?? 0
    }
}

/// 会话列表项，对齐后端 `tabchat.schemas.ConversationOut`。
struct IMConversation: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    /// 会话的托管组织；外部会话对非发起方展示时，不等于其所在的目录组织。
    let organizationId: String
    /// 当前用户以哪个组织身份参与该会话。旧响应缺失时回退托管组织。
    var participantOrganizationId: String? = nil
    /// 当前会话应出现在哪个组织目录。外部会话的实时过滤、搜索与目录刷新使用该字段。
    var directoryScopeId: String? = nil
    let spaceId: String?
    let spaceName: String
    let isTeamSpaceChannel: Bool
    let isExternal: Bool
    let type: Int
    var name: String
    var avatarUrl: String
    let memberCount: Int
    let isArchived: Bool
    var lastMessageAt: String?
    var lastMessagePreview: String
    /// 未读数：进会话 mark-read / personal `im.unread.update` 会就地更新（Phase E）。
    var unreadCount: Int
    /// 统计 `unreadCount` 时会话已见的最高消息 seq 水位（后端同一致快照下发）。
    /// 仅用于列表加载在途的 baseline/delta 合并：加载窗口内 `seq > 水位` 的 realtime 未读才计净增量。
    var lastMessageSeq: Int = 0
    let createdAt: String
    let dmPeerUserId: String?
    /// 当前用户对该会话的置顶偏好。置顶/取消置顶后会在列表内就地更新。
    var pinned: Bool
    var isMuted: Bool
    /// 服务端基于当前成员状态给出的权威发送门禁；历史仍可读时可能为 false。
    var canSend: Bool = true
    var labels: [IMConversationLabel] = []

    enum CodingKeys: String, CodingKey {
        case id
        case organizationId = "organization_id"
        case participantOrganizationId = "participant_organization_id"
        case directoryScopeId = "directory_scope_id"
        case spaceId = "space_id"
        case spaceName = "space_name"
        case isTeamSpaceChannel = "is_team_space_channel"
        case isExternal = "is_external"
        case type
        case name
        case avatarUrl = "avatar_url"
        case memberCount = "member_count"
        case isArchived = "is_archived"
        case lastMessageAt = "last_message_at"
        case lastMessagePreview = "last_message_preview"
        case unreadCount = "unread_count"
        case lastMessageSeq = "last_message_seq"
        case createdAt = "created_at"
        case dmPeerUserId = "dm_peer_user_id"
        case pinned
        case isMuted = "is_muted"
        case canSend = "can_send"
        case labels
    }

    var conversationType: IMConversationType? { IMConversationType(rawValue: type) }

    /// 私聊仅剩当前成员时，对端已经离开当前组织。历史仍可读，但任何新消息都没有合法接收方。
    var isRemovedMemberDirectMessage: Bool {
        conversationType == .dm && memberCount < 2
    }

    var directoryOrganizationId: String {
        guard isExternal else { return organizationId }
        return [directoryScopeId, participantOrganizationId, organizationId]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? organizationId
    }

    var canReceiveMessages: Bool { canSend && !isRemovedMemberDirectMessage }
}

/// 正文搜索按会话聚合后的结果。摘要必须来自真实命中消息，不能复用最后一条消息。
struct IMMessageSearchResult: Sendable, Equatable {
    let conversation: IMConversation
    let matchedMessagePreview: String
    let matchCount: Int
}

extension IMConversation {
    /// 自定义解码：`last_message_seq` 为后加的加载水位字段，旧 / 其它 payload（如未带水位的
    /// `im.conversation.new` 摘要）可能不带它。合成 Decodable 会忽略默认值、缺键即抛错，
    /// 从而丢掉整条会话；这里对该字段用 `decodeIfPresent` 降级为 0，绝不让缺一个水位就丢会话。
    /// 放在 extension 内以保留结构体自动生成的 memberwise init。
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        organizationId = try c.decode(String.self, forKey: .organizationId)
        participantOrganizationId = try c.decodeIfPresent(String.self, forKey: .participantOrganizationId)
        directoryScopeId = try c.decodeIfPresent(String.self, forKey: .directoryScopeId)
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId)
        spaceName = try c.decode(String.self, forKey: .spaceName)
        isTeamSpaceChannel = try c.decode(Bool.self, forKey: .isTeamSpaceChannel)
        isExternal = try c.decodeIfPresent(Bool.self, forKey: .isExternal) ?? false
        type = try c.decode(Int.self, forKey: .type)
        name = try c.decode(String.self, forKey: .name)
        avatarUrl = try c.decode(String.self, forKey: .avatarUrl)
        memberCount = try c.decode(Int.self, forKey: .memberCount)
        isArchived = try c.decode(Bool.self, forKey: .isArchived)
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
        lastMessagePreview = try c.decode(String.self, forKey: .lastMessagePreview)
        unreadCount = try c.decode(Int.self, forKey: .unreadCount)
        lastMessageSeq = try c.decodeIfPresent(Int.self, forKey: .lastMessageSeq) ?? 0
        createdAt = try c.decode(String.self, forKey: .createdAt)
        dmPeerUserId = try c.decodeIfPresent(String.self, forKey: .dmPeerUserId)
        pinned = try c.decode(Bool.self, forKey: .pinned)
        isMuted = try c.decode(Bool.self, forKey: .isMuted)
        canSend = try c.decodeIfPresent(Bool.self, forKey: .canSend) ?? true
        labels = try c.decodeIfPresent([IMConversationLabel].self, forKey: .labels) ?? []
    }
}

/// 消息类型，对齐后端 `tabchat.constants.MessageType`。
enum IMMessageType: Int, Sendable {
    case text = 1
    case system = 2
    case file = 3
    case image = 4
}

/// 成员类型（TC-8：群聊可含 Agent 成员）。
enum IMMemberType: String, Sendable {
    case user
    case agent
}

/// 被回复消息的预览，对齐后端 `ReplyToPreview`。
struct IMReplyPreview: Decodable, Sendable, Equatable {
    let content: String
    let senderId: String
    /// 被引用的消息已经撤回、被删除或当前用户不再有访问权限。
    let isUnavailable: Bool
    let messageType: Int
    let hasAttachment: Bool
    let fileName: String

    enum CodingKeys: String, CodingKey {
        case content
        case senderId = "sender_id"
        case isUnavailable = "is_unavailable"
        case messageType = "message_type"
        case hasAttachment = "has_attachment"
        case fileName = "file_name"
    }

    init(
        content: String,
        senderId: String,
        isUnavailable: Bool = false,
        messageType: Int = IMMessageType.text.rawValue,
        hasAttachment: Bool = false,
        fileName: String = ""
    ) {
        self.content = content
        self.senderId = senderId
        self.isUnavailable = isUnavailable
        self.messageType = messageType
        self.hasAttachment = hasAttachment
        self.fileName = fileName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        senderId = try c.decodeIfPresent(String.self, forKey: .senderId) ?? ""
        isUnavailable = try c.decodeIfPresent(Bool.self, forKey: .isUnavailable) ?? false
        messageType = try c.decodeIfPresent(Int.self, forKey: .messageType) ?? IMMessageType.text.rawValue
        hasAttachment = try c.decodeIfPresent(Bool.self, forKey: .hasAttachment) ?? false
        fileName = try c.decodeIfPresent(String.self, forKey: .fileName) ?? ""
    }
}

/// 已读聚合（`read_receipt`）：后端仅在**本人发出**的消息列表项里下发（`message_service` L1511+）。
/// `readCount` = 已把该消息读进的收件人数，`recipientCount` = 群真人成员数（不含自己）。
struct IMReadReceipt: Decodable, Sendable, Equatable {
    let readCount: Int
    let recipientCount: Int

    enum CodingKeys: String, CodingKey {
        case readCount = "read_count"
        case recipientCount = "recipient_count"
    }

    init(readCount: Int, recipientCount: Int) {
        self.readCount = readCount
        self.recipientCount = recipientCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        readCount = try c.decodeIfPresent(Int.self, forKey: .readCount) ?? 0
        recipientCount = try c.decodeIfPresent(Int.self, forKey: .recipientCount) ?? 0
    }
}

struct IMReadReceiptMember: Sendable, Equatable, Identifiable {
    let userId: String
    let name: String
    let avatar: String

    var id: String { userId }
    var displayName: String { name.isEmpty ? userId : name }
}

struct IMMessageReadReceipts: Sendable, Equatable {
    let readers: [IMReadReceiptMember]
    let unreaders: [IMReadReceiptMember]
}

/// 转发消息的冻结来源。所有字段独立容错，避免第三方 metadata 中单个异常值拖垮整条消息。
struct IMForwardedFrom: Codable, Sendable, Equatable {
    let originalMessageId: Int?
    let originalConversationId: String?
    let originalConversationName: String?
    let originalSenderId: String?
    let originalSenderName: String?

    enum CodingKeys: String, CodingKey {
        case originalMessageId = "original_message_id"
        case originalConversationId = "original_conversation_id"
        case originalConversationName = "original_conversation_name"
        case originalSenderId = "original_sender_id"
        case originalSenderName = "original_sender_name"
    }

    init(
        originalMessageId: Int? = nil,
        originalConversationId: String? = nil,
        originalConversationName: String? = nil,
        originalSenderId: String? = nil,
        originalSenderName: String? = nil
    ) {
        self.originalMessageId = originalMessageId
        self.originalConversationId = originalConversationId
        self.originalConversationName = originalConversationName
        self.originalSenderId = originalSenderId
        self.originalSenderName = originalSenderName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        originalMessageId = try? c.decodeIfPresent(Int.self, forKey: .originalMessageId)
        originalConversationId = try? c.decodeIfPresent(String.self, forKey: .originalConversationId)
        originalConversationName = try? c.decodeIfPresent(String.self, forKey: .originalConversationName)
        originalSenderId = try? c.decodeIfPresent(String.self, forKey: .originalSenderId)
        originalSenderName = try? c.decodeIfPresent(String.self, forKey: .originalSenderName)
    }
}

enum IMForwardSourcePresentation {
    static func text(for source: IMForwardedFrom?, currentUserId: String?) -> String? {
        guard let source else { return nil }
        let senderId = source.originalSenderId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let currentUserId = currentUserId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if senderId?.isEmpty == false, senderId == currentUserId { return nil }

        let senderName = source.originalSenderName?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard senderId?.isEmpty == false || senderName?.isEmpty == false else { return nil }
        return "转发自 \(senderName?.isEmpty == false ? senderName ?? "未知成员" : "未知成员")"
    }
}

/// 消息 metadata 中客户端当前使用的字段（乐观发送幂等键、@ 列表）。
/// 后端 metadata 为自由字典，这里只捕获已用字段，其余忽略——避免为未用字段引入解析脆弱性。
struct IMMessageMetadata: Decodable, Sendable, Equatable {
    let clientRequestId: String?
    let messageRef: String?
    let kind: String?
    let tabtinMessageId: String?
    let agentSessionRef: String?
    let mentionedUserIds: [String]?
    let mentionedAgentIds: [String]?
    let mentionAll: Bool?
    let forwardedFrom: IMForwardedFrom?
    // 附件（file/image 消息）：URL 不落库，凭 file_id 走 attachment-url 端点换预签链。
    let fileId: String?
    let fileName: String?
    let fileSize: Int?
    let fileType: String?
    let downloadURL: String?
    let accessURL: String?
    let cdnURL: String?
    let url: String?
    // 资源卡（文本消息携带）：快照直接嵌在 metadata，渲染无需额外请求。
    let card: IMResourceCard?
    /// 从原始 payload 读取的 card.type。即使完整卡片无法解码，也要保留 handoff 等安全边界。
    let cardType: String?
    /// metadata.card 是否在服务端 payload 中出现过。
    ///
    /// card 是一块可扩展的自由 JSON。即使其中字段损坏、或该类型暂未被移动端实现，
    /// 也不能把它误当成可编辑的纯文本消息；保留这一位让 UI 安全地降级展示。
    let hasCardPayload: Bool

    enum CodingKeys: String, CodingKey {
        case clientRequestId = "client_request_id"
        case messageRef = "message_ref"
        case kind
        case tabtinMessageId = "tabtin_message_id"
        case agentSessionRef = "agent_session_ref"
        case mentionedUserIds = "mentioned_user_ids"
        case mentionedAgentIds = "mentioned_agent_ids"
        case mentionAll = "mention_all"
        case forwardedFrom = "forwarded_from"
        case fileId = "file_id"
        case fileName = "file_name"
        case fileSize = "file_size"
        case fileType = "file_type"
        case downloadURL = "download_url"
        case accessURL = "access_url"
        case cdnURL = "cdn_url"
        case url
        case card
    }

    private enum CardTypeCodingKeys: String, CodingKey { case type }

    /// 逐字段 `try?` 容错：后端 metadata 为自由字典，任一字段类型异常（如 card 非对象、
    /// file_size 下发成字符串）只降级该字段为 nil，绝不让整条消息——进而整页历史——解码失败。
    /// Swift 5+ `try?` 会自动展平 `decodeIfPresent` 的可选返回，不产生 `T??`。
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clientRequestId = try? c.decodeIfPresent(String.self, forKey: .clientRequestId)
        messageRef = try? c.decodeIfPresent(String.self, forKey: .messageRef)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        tabtinMessageId = try? c.decodeIfPresent(String.self, forKey: .tabtinMessageId)
        agentSessionRef = try? c.decodeIfPresent(String.self, forKey: .agentSessionRef)
        mentionedUserIds = try? c.decodeIfPresent([String].self, forKey: .mentionedUserIds)
        mentionedAgentIds = try? c.decodeIfPresent([String].self, forKey: .mentionedAgentIds)
        mentionAll = try? c.decodeIfPresent(Bool.self, forKey: .mentionAll)
        forwardedFrom = try? c.decodeIfPresent(IMForwardedFrom.self, forKey: .forwardedFrom)
        fileId = try? c.decodeIfPresent(String.self, forKey: .fileId)
        fileName = try? c.decodeIfPresent(String.self, forKey: .fileName)
        fileSize = try? c.decodeIfPresent(Int.self, forKey: .fileSize)
        fileType = try? c.decodeIfPresent(String.self, forKey: .fileType)
        downloadURL = try? c.decodeIfPresent(String.self, forKey: .downloadURL)
        accessURL = try? c.decodeIfPresent(String.self, forKey: .accessURL)
        cdnURL = try? c.decodeIfPresent(String.self, forKey: .cdnURL)
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        card = try? c.decodeIfPresent(IMResourceCard.self, forKey: .card)
        if let cardContainer = try? c.nestedContainer(keyedBy: CardTypeCodingKeys.self, forKey: .card) {
            cardType = try? cardContainer.decodeIfPresent(String.self, forKey: .type)
        } else {
            cardType = nil
        }
        hasCardPayload = c.contains(.card)
    }

    /// 本地构造（乐观发送补齐用）：POST 只回 id/seq，本地据请求字段拼一条完整 metadata。
    init(
        clientRequestId: String? = nil,
        messageRef: String? = nil,
        kind: String? = nil,
        tabtinMessageId: String? = nil,
        agentSessionRef: String? = nil,
        mentionedUserIds: [String]? = nil,
        mentionedAgentIds: [String]? = nil,
        mentionAll: Bool? = nil,
        forwardedFrom: IMForwardedFrom? = nil,
        fileId: String? = nil,
        fileName: String? = nil,
        fileSize: Int? = nil,
        fileType: String? = nil,
        downloadURL: String? = nil,
        accessURL: String? = nil,
        cdnURL: String? = nil,
        url: String? = nil,
        card: IMResourceCard? = nil,
        cardType: String? = nil,
        hasCardPayload: Bool? = nil
    ) {
        self.clientRequestId = clientRequestId
        self.messageRef = messageRef
        self.kind = kind
        self.tabtinMessageId = tabtinMessageId
        self.agentSessionRef = agentSessionRef
        self.mentionedUserIds = mentionedUserIds
        self.mentionedAgentIds = mentionedAgentIds
        self.mentionAll = mentionAll
        self.forwardedFrom = forwardedFrom
        self.fileId = fileId
        self.fileName = fileName
        self.fileSize = fileSize
        self.fileType = fileType
        self.downloadURL = downloadURL
        self.accessURL = accessURL
        self.cdnURL = cdnURL
        self.url = url
        self.card = card
        self.cardType = cardType ?? card?.type
        self.hasCardPayload = hasCardPayload ?? (card != nil)
    }

    func projectingAgent(kind: String, messageRef: String, agentSessionRef: String) -> IMMessageMetadata {
        IMMessageMetadata(
            clientRequestId: clientRequestId,
            messageRef: messageRef,
            kind: kind,
            tabtinMessageId: tabtinMessageId,
            agentSessionRef: agentSessionRef,
            mentionedUserIds: mentionedUserIds,
            mentionedAgentIds: mentionedAgentIds,
            mentionAll: mentionAll,
            forwardedFrom: forwardedFrom,
            fileId: fileId,
            fileName: fileName,
            fileSize: fileSize,
            fileType: fileType,
            downloadURL: downloadURL,
            accessURL: accessURL,
            cdnURL: cdnURL,
            url: url,
            card: card,
            cardType: cardType,
            hasCardPayload: hasCardPayload
        )
    }

    var inlineAttachmentURLs: [String] {
        [downloadURL, cdnURL, accessURL, url]
            .compactMap { raw in
                guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
                      value.lowercased().hasPrefix("http://") || value.lowercased().hasPrefix("https://")
                else { return nil }
                return value
            }
            .removingDuplicates()
    }

    func recoverableResourceCard(messageContent: String) -> IMResourceCard? {
        guard hasCardPayload, card == nil, let cardType else { return nil }
        switch cardType {
        case IMResourceCardType.document.rawValue, IMResourceCardType.table.rawValue, IMResourceCardType.contact.rawValue:
            return IMResourceCard(
                type: cardType,
                name: Self.recoverableCardTitle(type: cardType, content: messageContent) ?? ""
            )
        default:
            return nil
        }
    }

    private static func recoverableCardTitle(type: String, content: String) -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefixes: [String]
        switch type {
        case IMResourceCardType.document.rawValue:
            prefixes = ["[文档]", "[云文档]"]
        case IMResourceCardType.table.rawValue:
            prefixes = ["[表格]", "[多维表格]"]
        case IMResourceCardType.contact.rawValue:
            prefixes = ["[名片]"]
        default:
            prefixes = ["[资源]"]
        }
        for prefix in prefixes where trimmed.hasPrefix(prefix) {
            let title = String(trimmed.dropFirst(prefix.count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !title.isEmpty { return title }
        }
        return nil
    }
}

private extension Array where Element: Hashable {
    func removingDuplicates() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

/// 资源卡类型，对齐后端 `metadata.card.type`。
enum IMResourceCardType: String, Sendable {
    case space
    case agentSpace = "agent_space"
    case document
    case table
    case contact
    case sessionShare = "session_share"
}

/// 表格卡预览快照（对齐后端 `preview_table`）。
struct IMCardTableColumn: Codable, Sendable, Equatable, Identifiable {
    let key: String
    let label: String
    var id: String { key }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decodeIfPresent(String.self, forKey: .key) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
    }

    enum CodingKeys: String, CodingKey { case key, label }
}

struct IMCardTablePreview: Codable, Sendable, Equatable {
    let columns: [IMCardTableColumn]
    let rows: [[String: String]]
    let totalRows: Int

    enum CodingKeys: String, CodingKey {
        case columns, rows
        case totalRows = "total_rows"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        columns = try c.decodeIfPresent([IMCardTableColumn].self, forKey: .columns) ?? []
        rows = try c.decodeIfPresent([[String: String]].self, forKey: .rows) ?? []
        totalRows = try c.decodeIfPresent(Int.self, forKey: .totalRows) ?? 0
    }
}

/// 消息里的资源卡（文档 / 表格 / 名片），对齐后端 `_validate_card_metadata` 回填结构。
/// 只捕获渲染需要的字段，其余忽略——容忍后端多下发。
struct IMResourceCard: Codable, Sendable, Equatable {
    let type: String
    let name: String
    let icon: String?
    let displayNameSnapshot: String?
    let displayNameCamel: String?
    let nickname: String?
    let fileName: String?
    let description: String?
    let caption: String?
    let resourceId: String?
    let spaceId: String?
    let organizationId: String?
    let hintCarrierAppId: String?
    // 名片卡：
    let userId: String?
    let username: String?
    let avatar: String?
    // 表格卡：
    let previewTable: IMCardTablePreview?
    // 指令卡：
    let title: String?
    let promptText: String?
    let promptVersion: Int?
    // 对话接力卡：卡片只携带快照与 handoff_id，详情必须实时拉取独立交接包。
    let handoffId: String?
    let goalSnapshot: String?
    let initiatorType: String?
    let initiatorId: String?
    // 任务共享卡：
    let shareId: String?
    let sessionId: String?
    let sessionTitle: String?
    let ownerUserId: String?
    let granteeUserId: String?
    let canFork: Bool
    let canChat: Bool
    let status: String?
    let ownerDisplayName: String?
    let granteeDisplayName: String?
    // 新任务协作卡（session_share_v2）：只读消息快照，不复用旧共享卡控制接口。
    let schemaVersion: Int?
    let version: Int?
    let objectId: String?
    let titleSnapshot: String?
    let senderId: String?
    let recipientId: String?
    // Codex 会话文件卡：移动端可下载归档；桌面端可进一步导入本机 Codex。
    let codexSessionId: String?
    let codexSessionName: String?
    let suggestedWorkingDirectory: String?

    enum CodingKeys: String, CodingKey {
        case type, name, icon, description, caption
        case displayNameSnapshot = "display_name"
        case displayNameCamel = "displayName"
        case nickname
        case fileName = "file_name"
        case resourceId = "resource_id"
        case spaceId = "space_id"
        case organizationId = "organization_id"
        case hintCarrierAppId = "hint_carrier_app_id"
        case userId = "user_id"
        case username, avatar
        case previewTable = "preview_table"
        case title
        case promptText = "prompt_text"
        case promptVersion = "prompt_version"
        case handoffId = "handoff_id"
        case goalSnapshot = "goal_snapshot"
        case initiatorType = "initiator_type"
        case initiatorId = "initiator_id"
        case shareId = "share_id"
        case sessionId = "session_id"
        case sessionTitle = "session_title"
        case ownerUserId = "owner_user_id"
        case granteeUserId = "grantee_user_id"
        case canFork = "can_fork"
        case canChat = "can_chat"
        case status
        case ownerDisplayName = "owner_display_name"
        case granteeDisplayName = "grantee_display_name"
        case schemaVersion = "schema_version"
        case version
        case objectId = "object_id"
        case titleSnapshot = "title_snapshot"
        case senderId = "sender_id"
        case recipientId = "recipient_id"
        case codexSessionId = "codex_session_id"
        case codexSessionName = "codex_session_name"
        case suggestedWorkingDirectory = "suggested_working_directory"
    }
    private enum LegacyCodingKeys: String, CodingKey { case goal }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let legacy = try decoder.container(keyedBy: LegacyCodingKeys.self)
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        icon = try? c.decodeIfPresent(String.self, forKey: .icon)
        displayNameSnapshot = try? c.decodeIfPresent(String.self, forKey: .displayNameSnapshot)
        displayNameCamel = try? c.decodeIfPresent(String.self, forKey: .displayNameCamel)
        nickname = try? c.decodeIfPresent(String.self, forKey: .nickname)
        fileName = try? c.decodeIfPresent(String.self, forKey: .fileName)
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        caption = try? c.decodeIfPresent(String.self, forKey: .caption)
        resourceId = try? c.decodeIfPresent(String.self, forKey: .resourceId)
        spaceId = try? c.decodeIfPresent(String.self, forKey: .spaceId)
        organizationId = try? c.decodeIfPresent(String.self, forKey: .organizationId)
        hintCarrierAppId = try? c.decodeIfPresent(String.self, forKey: .hintCarrierAppId)
        userId = try? c.decodeIfPresent(String.self, forKey: .userId)
        username = try? c.decodeIfPresent(String.self, forKey: .username)
        avatar = try? c.decodeIfPresent(String.self, forKey: .avatar)
        previewTable = try? c.decodeIfPresent(IMCardTablePreview.self, forKey: .previewTable)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        promptText = try? c.decodeIfPresent(String.self, forKey: .promptText)
        promptVersion = try? c.decodeIfPresent(Int.self, forKey: .promptVersion)
        handoffId = try? c.decodeIfPresent(String.self, forKey: .handoffId)
        // 当前后端卡片快照使用 `goal`；兼容曾经试验过的 `goal_snapshot` 字段。
        goalSnapshot = (try? legacy.decodeIfPresent(String.self, forKey: .goal))
            ?? (try? c.decodeIfPresent(String.self, forKey: .goalSnapshot))
        initiatorType = try? c.decodeIfPresent(String.self, forKey: .initiatorType)
        initiatorId = try? c.decodeIfPresent(String.self, forKey: .initiatorId)
        shareId = try? c.decodeIfPresent(String.self, forKey: .shareId)
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        sessionTitle = try? c.decodeIfPresent(String.self, forKey: .sessionTitle)
        ownerUserId = try? c.decodeIfPresent(String.self, forKey: .ownerUserId)
        granteeUserId = try? c.decodeIfPresent(String.self, forKey: .granteeUserId)
        canFork = Self.decodeCompatibleBool(c, forKey: .canFork)
        canChat = Self.decodeCompatibleBool(c, forKey: .canChat)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        ownerDisplayName = try? c.decodeIfPresent(String.self, forKey: .ownerDisplayName)
        granteeDisplayName = try? c.decodeIfPresent(String.self, forKey: .granteeDisplayName)
        schemaVersion = try? c.decodeIfPresent(Int.self, forKey: .schemaVersion)
        version = try? c.decodeIfPresent(Int.self, forKey: .version)
        objectId = try? c.decodeIfPresent(String.self, forKey: .objectId)
        titleSnapshot = try? c.decodeIfPresent(String.self, forKey: .titleSnapshot)
        senderId = try? c.decodeIfPresent(String.self, forKey: .senderId)
        recipientId = try? c.decodeIfPresent(String.self, forKey: .recipientId)
        codexSessionId = try? c.decodeIfPresent(String.self, forKey: .codexSessionId)
        codexSessionName = try? c.decodeIfPresent(String.self, forKey: .codexSessionName)
        suggestedWorkingDirectory = try? c.decodeIfPresent(String.self, forKey: .suggestedWorkingDirectory)
    }

    init(
        type: String,
        name: String = "",
        icon: String? = nil,
        displayNameSnapshot: String? = nil,
        displayNameCamel: String? = nil,
        nickname: String? = nil,
        fileName: String? = nil,
        description: String? = nil,
        caption: String? = nil,
        resourceId: String? = nil,
        spaceId: String? = nil,
        organizationId: String? = nil,
        hintCarrierAppId: String? = nil,
        userId: String? = nil,
        username: String? = nil,
        avatar: String? = nil,
        previewTable: IMCardTablePreview? = nil,
        title: String? = nil,
        promptText: String? = nil,
        promptVersion: Int? = nil,
        handoffId: String? = nil,
        goalSnapshot: String? = nil,
        initiatorType: String? = nil,
        initiatorId: String? = nil,
        shareId: String? = nil,
        sessionId: String? = nil,
        sessionTitle: String? = nil,
        ownerUserId: String? = nil,
        granteeUserId: String? = nil,
        canFork: Bool = false,
        canChat: Bool = false,
        status: String? = nil,
        ownerDisplayName: String? = nil,
        granteeDisplayName: String? = nil,
        schemaVersion: Int? = nil,
        version: Int? = nil,
        objectId: String? = nil,
        titleSnapshot: String? = nil,
        senderId: String? = nil,
        recipientId: String? = nil,
        codexSessionId: String? = nil,
        codexSessionName: String? = nil,
        suggestedWorkingDirectory: String? = nil
    ) {
        self.type = type
        self.name = name
        self.icon = icon
        self.displayNameSnapshot = displayNameSnapshot
        self.displayNameCamel = displayNameCamel
        self.nickname = nickname
        self.fileName = fileName
        self.description = description
        self.caption = caption
        self.resourceId = resourceId
        self.spaceId = spaceId
        self.organizationId = organizationId
        self.hintCarrierAppId = hintCarrierAppId
        self.userId = userId
        self.username = username
        self.avatar = avatar
        self.previewTable = previewTable
        self.title = title
        self.promptText = promptText
        self.promptVersion = promptVersion
        self.handoffId = handoffId
        self.goalSnapshot = goalSnapshot
        self.initiatorType = initiatorType
        self.initiatorId = initiatorId
        self.shareId = shareId
        self.sessionId = sessionId
        self.sessionTitle = sessionTitle
        self.ownerUserId = ownerUserId
        self.granteeUserId = granteeUserId
        self.canFork = canFork
        self.canChat = canChat
        self.status = status
        self.ownerDisplayName = ownerDisplayName
        self.granteeDisplayName = granteeDisplayName
        self.schemaVersion = schemaVersion
        self.version = version
        self.objectId = objectId
        self.titleSnapshot = titleSnapshot
        self.senderId = senderId
        self.recipientId = recipientId
        self.codexSessionId = codexSessionId
        self.codexSessionName = codexSessionName
        self.suggestedWorkingDirectory = suggestedWorkingDirectory
    }

    var typedType: IMResourceCardType? { IMResourceCardType(rawValue: type) }

    private static func decodeCompatibleBool(
        _ container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) -> Bool {
        if let value = try? container.decode(Bool.self, forKey: key) { return value }
        guard let raw = try? container.decodeIfPresent(String.self, forKey: key) else { return false }
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "true", "1", "yes": return true
        default: return false
        }
    }

    var displayName: String {
        explicitDisplayName ?? fallbackDisplayName
    }

    func displayName(messageContent: String?) -> String {
        explicitDisplayName
            ?? titleFromFallbackContent(messageContent)
            ?? fallbackDisplayName
    }

    private var explicitDisplayName: String? {
        let values: [String?]
        switch typedType {
        case .contact:
            values = [name, displayNameSnapshot, displayNameCamel, nickname, title, username]
        case .document, .table, .space, .agentSpace:
            values = [name, title, displayNameSnapshot, displayNameCamel, fileName, caption]
        case .sessionShare:
            values = [sessionTitle, title, name]
        case .none:
            values = [name, title, displayNameSnapshot, displayNameCamel, fileName, caption]
        }
        return values.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
    }

    var fallbackDisplayName: String {
        switch typedType {
        case .contact: return "用户"
        case .document: return "云文档"
        case .table: return "表格"
        case .space, .agentSpace: return "工作空间"
        case .sessionShare: return "任务共享"
        case .none: return "资源"
        }
    }

    private func titleFromFallbackContent(_ content: String?) -> String? {
        guard let content else { return nil }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefixes: [String]
        switch typedType {
        case .contact:
            prefixes = ["[名片]"]
        case .document:
            prefixes = ["[文档]", "[云文档]"]
        case .table:
            prefixes = ["[表格]", "[多维表格]"]
        case .space, .agentSpace:
            prefixes = ["[工作空间]", "[Workspace]"]
        case .sessionShare:
            prefixes = ["[共享任务]", "[任务共享]"]
        case .none:
            prefixes = ["[资源]", "[文档]", "[云文档]", "[表格]", "[多维表格]", "[名片]"]
        }
        for prefix in prefixes where trimmed.hasPrefix(prefix) {
            let title = String(trimmed.dropFirst(prefix.count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !title.isEmpty { return title }
        }
        return nil
    }

    /// 指令卡独立于资源卡：正文是自包含数据，不应走文档 / 表格的资源打开逻辑。
    var promptCard: IMPromptCard? {
        guard type == IMOutgoingCardKind.prompt.rawValue,
              let promptText = promptText?.trimmingCharacters(in: .whitespacesAndNewlines),
              !promptText.isEmpty else {
            return nil
        }
        return IMPromptCard(title: title ?? "", promptText: promptText)
    }

    /// Workspace 卡只暴露 `space_id`；导航层必须解析 Workspace，不能冒充 Agent ID。
    var spaceCard: IMSpaceCard? {
        guard typedType == .space || typedType == .agentSpace,
              let spaceId = spaceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !spaceId.isEmpty else { return nil }
        return IMSpaceCard(
            type: type,
            spaceId: spaceId,
            displayName: displayName,
            icon: icon?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        )
    }

    var isHandoff: Bool {
        type == "handoff" && handoffId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    var sessionShareCard: IMSessionShareCard? {
        guard typedType == .sessionShare,
              let shareId = shareId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !shareId.isEmpty else { return nil }
        return IMSessionShareCard(
            shareId: shareId,
            sessionId: sessionId,
            sessionTitle: sessionTitle,
            ownerUserId: ownerUserId,
            granteeUserId: granteeUserId,
            canFork: canFork,
            canChat: canChat,
            status: status,
            ownerDisplayName: ownerDisplayName,
            granteeDisplayName: granteeDisplayName
        )
    }

    /// 新协议只携带可信快照。schema 或必需字段不完整时必须继续走不支持卡片兜底。
    var sessionShareV2Card: IMSessionShareV2Card? {
        guard type == "session_share_v2",
              schemaVersion == 1,
              let version, version >= 1,
              let objectId = objectId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !objectId.isEmpty,
              let title = titleSnapshot?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty,
              let senderId = senderId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !senderId.isEmpty,
              let recipientId = recipientId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !recipientId.isEmpty else { return nil }
        return IMSessionShareV2Card(
            objectId: objectId,
            title: title,
            senderId: senderId,
            recipientId: recipientId,
            version: version
        )
    }

    /// 续接卡沿用最小可信快照，但必须走独立详情 / 创建接口，不能复用 live share 状态。
    var sessionContinuationCard: IMSessionContinuationCard? {
        guard type == "session_continuation",
              schemaVersion == 1,
              let version, version >= 1,
              let objectId = objectId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !objectId.isEmpty,
              let title = titleSnapshot?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty,
              let senderId = senderId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !senderId.isEmpty,
              let recipientId = recipientId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !recipientId.isEmpty else { return nil }
        return IMSessionContinuationCard(
            objectId: objectId,
            title: title,
            senderId: senderId,
            recipientId: recipientId,
            version: version
        )
    }

    /// Codex 会话卡必须是 v1 且带稳定 ID/名称；未知 schema 继续走升级兜底。
    var codexSessionCard: IMCodexSessionCard? {
        guard type == "codex_session",
              schemaVersion == 1,
              let sessionId = codexSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty,
              let sessionName = codexSessionName?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionName.isEmpty else { return nil }
        let workingDirectory = suggestedWorkingDirectory?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
        return IMCodexSessionCard(
            sessionId: sessionId,
            sessionName: sessionName,
            suggestedWorkingDirectory: workingDirectory
        )
    }

    /// 解析资源卡的实际打开上下文。
    ///
    /// 历史卡片可能早于 organization_id 回填，回退到会话 Organization；组织级资源则
    /// 合法地没有 space_id，必须保留 nil 以走根级资源路由。
    func resolveOpenTarget(
        conversationOrganizationId: String,
        preview: IMResourceCardPreview? = nil
    ) -> IMResourceCardOpenTarget? {
        let resourceType: String
        switch typedType {
        case .document: resourceType = "tabdoc"
        case .table: resourceType = "tabdata"
        default: return nil
        }

        guard let resourceId = resourceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !resourceId.isEmpty else {
            return nil
        }
        let cardOrganizationId = organizationId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallbackOrganizationId = conversationOrganizationId.trimmingCharacters(in: .whitespacesAndNewlines)
        let previewOrganizationId = preview?.organizationId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedOrganizationId: String
        let resolvedSpaceId: String?
        if let previewOrganizationId, !previewOrganizationId.isEmpty {
            resolvedOrganizationId = previewOrganizationId
            resolvedSpaceId = preview?.spaceId?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nilIfEmpty
        } else if let cardOrganizationId, !cardOrganizationId.isEmpty {
            resolvedOrganizationId = cardOrganizationId
            resolvedSpaceId = spaceId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        } else {
            resolvedOrganizationId = fallbackOrganizationId
            resolvedSpaceId = spaceId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        }
        guard !resolvedOrganizationId.isEmpty else {
            return nil
        }

        return IMResourceCardOpenTarget(
            resourceType: resourceType,
            resourceId: resourceId,
            organizationId: resolvedOrganizationId,
            spaceId: resolvedSpaceId
        )
    }
}

struct IMSessionShareCard: Codable, Sendable, Equatable, Identifiable {
    let shareId: String
    let sessionId: String?
    let sessionTitle: String?
    let ownerUserId: String?
    let granteeUserId: String?
    let canFork: Bool
    let canChat: Bool
    let status: String?
    let ownerDisplayName: String?
    let granteeDisplayName: String?

    var id: String { shareId }

    enum CodingKeys: String, CodingKey {
        case shareId = "id"
        case sessionId = "session_id"
        case sessionTitle = "session_title"
        case ownerUserId = "owner_user_id"
        case granteeUserId = "grantee_user_id"
        case canFork = "can_fork"
        case canChat = "can_chat"
        case status
        case ownerDisplayName = "owner_display_name"
        case granteeDisplayName = "grantee_display_name"
    }

    var normalizedStatus: String { status == "revoked" ? "revoked" : "active" }
    var displayTitle: String {
        let title = sessionTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? "未命名任务" : title
    }
    var permissionLabel: String {
        if canChat { return "可控制" }
        if canFork { return "查看并创建副本" }
        return "实时查看"
    }
}

struct IMSessionShareListResponse: Decodable, Sendable, Equatable {
    let shares: [IMSessionShareCard]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        shares = try container.decodeIfPresent([IMSessionShareCard].self, forKey: .shares) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case shares
    }
}

struct IMSharedChatResult: Decodable, Sendable, Equatable {
    let messageId: String?
    let reply: String?
    let content: String?
    let modelId: String?
    let modelName: String?
    let traceId: String?
    let errorCategory: String?
    let errorMessage: String?
    let errorCode: String?

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case reply, content
        case modelId = "model_id"
        case modelName = "model_name"
        case traceId = "trace_id"
        case errorCategory = "error_category"
        case errorMessage = "error_message"
        case errorCode = "error_code"
    }
}

struct IMSharedExecutionStatus: Decodable, Sendable, Equatable {
    let reachable: Bool
    let errorCategory: String?
    let runtime: String?

    enum CodingKeys: String, CodingKey {
        case reachable
        case errorCategory = "error_category"
        case runtime
    }
}

struct IMSessionShareV2BatchRequest: Encodable {
    let objectIds: [String]

    enum CodingKeys: String, CodingKey {
        case objectIds = "object_ids"
    }
}

struct IMSessionShareV2BatchResponse: Decodable, Sendable, Equatable {
    let items: [IMSessionShareV2BatchItem]
}

struct IMSessionShareV2BatchItem: Decodable, Sendable, Equatable {
    let objectId: String
    let ok: Bool
    let detail: IMSessionShareV2Detail?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case objectId = "object_id"
        case ok, detail, error
    }
}

struct IMSessionShareV2Actions: Codable, Sendable, Equatable {
    let canJoin: Bool
    let canOpen: Bool
    let canStop: Bool
    let canRestore: Bool
    let canChangeAccess: Bool

    enum CodingKeys: String, CodingKey {
        case canJoin = "can_join"
        case canOpen = "can_open"
        case canStop = "can_stop"
        case canRestore = "can_restore"
        case canChangeAccess = "can_change_access"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        canJoin = try c.decodeIfPresent(Bool.self, forKey: .canJoin) ?? false
        canOpen = try c.decodeIfPresent(Bool.self, forKey: .canOpen) ?? false
        canStop = try c.decodeIfPresent(Bool.self, forKey: .canStop) ?? false
        canRestore = try c.decodeIfPresent(Bool.self, forKey: .canRestore) ?? false
        canChangeAccess = try c.decodeIfPresent(Bool.self, forKey: .canChangeAccess) ?? false
    }
}

struct IMSessionShareV2Detail: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let sessionId: String?
    let sessionTitle: String
    let workspaceId: String?
    let workspaceName: String?
    let ownerUserId: String
    let granteeUserId: String
    let canFork: Bool
    let canChat: Bool
    let status: String
    let forkedSessionId: String?
    let ownerDisplayName: String?
    let granteeDisplayName: String?
    let cardContract: String?
    let version: Int?
    let role: String?
    let phase: String?
    let accessMode: String?
    let actions: IMSessionShareV2Actions?

    enum CodingKeys: String, CodingKey {
        case id
        case sessionId = "session_id"
        case sessionTitle = "session_title"
        case workspaceId = "workspace_id"
        case workspaceName = "workspace_name"
        case ownerUserId = "owner_user_id"
        case granteeUserId = "grantee_user_id"
        case canFork = "can_fork"
        case canChat = "can_chat"
        case status
        case forkedSessionId = "forked_session_id"
        case ownerDisplayName = "owner_display_name"
        case granteeDisplayName = "grantee_display_name"
        case cardContract = "card_contract"
        case version, role, phase
        case accessMode = "access_mode"
        case actions
    }

    var cardSnapshot: IMSessionShareCard {
        IMSessionShareCard(
            shareId: id,
            sessionId: sessionId ?? "",
            sessionTitle: sessionTitle,
            ownerUserId: ownerUserId,
            granteeUserId: granteeUserId,
            canFork: canFork,
            canChat: canChat,
            status: status == "revoked" ? "revoked" : "active",
            ownerDisplayName: ownerDisplayName,
            granteeDisplayName: granteeDisplayName
        )
    }
}

/// `session_share_v2` 的可信消息快照；控制状态由详情接口加载。
struct IMSessionShareV2Card: Sendable, Equatable, Identifiable {
    let objectId: String
    let title: String
    let senderId: String
    let recipientId: String
    let version: Int

    var id: String { objectId }
}

struct IMSessionContinuationCard: Sendable, Equatable, Identifiable {
    let objectId: String
    let title: String
    let senderId: String
    let recipientId: String
    let version: Int

    var id: String { objectId }
}

struct IMSessionContinuationBatchRequest: Encodable {
    let objectIds: [String]

    enum CodingKeys: String, CodingKey {
        case objectIds = "object_ids"
    }
}

struct IMSessionContinuationBatchResponse: Decodable, Sendable, Equatable {
    let items: [IMSessionContinuationBatchItem]
}

struct IMSessionContinuationBatchItem: Decodable, Sendable, Equatable {
    let objectId: String
    let ok: Bool
    let detail: IMSessionContinuationDetail?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case objectId = "object_id"
        case ok, detail, error
    }
}

struct IMSessionContinuationEligibility: Codable, Sendable, Equatable {
    let canCreate: Bool
    let reason: String

    enum CodingKeys: String, CodingKey {
        case canCreate = "can_create"
        case reason
    }
}

struct IMSessionContinuationResource: Codable, Sendable, Equatable, Identifiable {
    let label: String?
    let unavailable: Bool
    let reason: String?

    var id: String { "\(label ?? "resource"):\(reason ?? "")" }

    private enum CodingKeys: String, CodingKey {
        case label, unavailable, reason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        unavailable = try container.decodeIfPresent(Bool.self, forKey: .unavailable) ?? false
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(label, forKey: .label)
        try container.encode(unavailable, forKey: .unavailable)
        try container.encodeIfPresent(reason, forKey: .reason)
    }
}

struct IMSessionContinuationDetail: Codable, Sendable, Equatable, Identifiable {
    let objectId: String
    let version: Int
    let role: String
    let titleSnapshot: String
    let contextStatus: String
    let snapshotTurnCount: Int
    let resourceStatus: String
    let resources: [IMSessionContinuationResource]
    let deliveryStatus: String
    let creationStatus: String
    let linkedSessionId: String?
    let targetWorkspaceId: String?
    let organizationId: String
    let eligibility: IMSessionContinuationEligibility
    let createdAt: String
    let updatedAt: String

    var id: String { objectId }

    enum CodingKeys: String, CodingKey {
        case objectId = "object_id"
        case version, role
        case titleSnapshot = "title_snapshot"
        case contextStatus = "context_status"
        case snapshotTurnCount = "snapshot_turn_count"
        case resourceStatus = "resource_status"
        case resources
        case deliveryStatus = "delivery_status"
        case creationStatus = "creation_status"
        case linkedSessionId = "linked_session_id"
        case targetWorkspaceId = "target_workspace_id"
        case organizationId = "organization_id"
        case eligibility
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

enum IMResourceCardPreviewStatus: String, Codable, Sendable, Equatable {
    case ok
    case deleted
    case forbidden
    case error
}

struct IMResourceCardPreview: Codable, Sendable, Equatable {
    let name: String?
    let spaceId: String?
    let organizationId: String?
    let currentUserRole: String?
    let description: String?
    let previewTable: IMCardTablePreview?

    enum CodingKeys: String, CodingKey {
        case name
        case spaceId = "space_id"
        case organizationId = "organization_id"
        case currentUserRole = "current_user_role"
        case description
        case previewTable = "preview_table"
    }
}

struct IMResourceCardPreviewResult: Codable, Sendable, Equatable {
    let status: IMResourceCardPreviewStatus
    let data: IMResourceCardPreview?
}

extension Notification.Name {
    static let imResourceCardStatusDidChange = Notification.Name("tabtin.im.resourceCardStatusDidChange")
    static let imSessionShareStatusDidChange = Notification.Name("tabtin.im.sessionShareStatusDidChange")
}

@MainActor
enum IMCardStatusMemoryCache {
    private static let maxResourcePreviews = 200
    private static let maxSessionShares = 200
    private static let maxCardDetails = 200
    private static let defaults = UserDefaults.standard
    private static let resourcePreviewsKey = "tabtin.im.cardStatus.resourcePreviews.v1"
    private static let requestedResourceAccessKey = "tabtin.im.cardStatus.requestedAccess.v1"
    private static let sessionSharesKey = "tabtin.im.cardStatus.sessionShares.v1"
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()
    private static var didLoadPersistentState = false
    private static var resourcePreviews: [String: IMResourceCardPreviewResult] = [:]
    private static var requestedResourceAccess: Set<String> = []
    private static var sessionShares: [String: IMSessionShareCard] = [:]
    private static var authoritativeSessionShares: [String: IMSessionShareCard] = [:]
    private static var sessionShareV2Details: [String: IMSessionShareV2Detail] = [:]
    private static var sessionContinuationDetails: [String: IMSessionContinuationDetail] = [:]

    static func resourceKey(for card: IMResourceCard) -> String? {
        guard let resourceId = card.resourceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !resourceId.isEmpty else {
            return nil
        }
        return "\(card.type):\(resourceId)"
    }

    static func resourcePreview(for card: IMResourceCard) -> IMResourceCardPreviewResult? {
        loadPersistentStateIfNeeded()
        guard let key = resourceKey(for: card) else { return nil }
        return resourcePreviews[key]
    }

    static func putResourcePreview(_ result: IMResourceCardPreviewResult, for card: IMResourceCard) {
        loadPersistentStateIfNeeded()
        guard let key = resourceKey(for: card) else { return }
        guard resourcePreviews[key] != result else { return }
        resourcePreviews[key] = result
        trimDictionary(&resourcePreviews, maxSize: maxResourcePreviews)
        persist(resourcePreviews, key: resourcePreviewsKey)
        postResourceStatusChanged(key: key, shouldRefresh: false)
    }

    static func markResourceAccessRequested(for card: IMResourceCard) {
        loadPersistentStateIfNeeded()
        guard let key = resourceKey(for: card) else { return }
        let inserted = requestedResourceAccess.insert(key).inserted
        if inserted {
            persist(Array(requestedResourceAccess), key: requestedResourceAccessKey)
            postResourceStatusChanged(key: key, shouldRefresh: false)
        }
    }

    static func hasRequestedResourceAccess(for card: IMResourceCard) -> Bool {
        loadPersistentStateIfNeeded()
        guard let key = resourceKey(for: card) else { return false }
        return requestedResourceAccess.contains(key)
    }

    static func handleResourceAccessEvent(_ envelope: WSEnvelope) {
        handleResourceAccessEvent(
            eventType: envelope.type,
            resourceType: envelope.payloadString("resource_type"),
            resourceId: envelope.payloadString("resource_id")
        )
    }

    static func handleResourceAccessEvent(
        eventType: String,
        resourceType: String?,
        resourceId: String?
    ) {
        loadPersistentStateIfNeeded()
        guard let cardType = cardType(forBackendResourceType: resourceType),
              let resourceId = resourceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !resourceId.isEmpty else {
            return
        }
        let key = "\(cardType):\(resourceId)"
        switch eventType {
        case "resource_access_revoked":
            let forbidden = IMResourceCardPreviewResult(status: .forbidden, data: nil)
            if resourcePreviews[key] != forbidden {
                resourcePreviews[key] = forbidden
                trimDictionary(&resourcePreviews, maxSize: maxResourcePreviews)
                persist(resourcePreviews, key: resourcePreviewsKey)
            }
        case "resource_access_granted", "resource_access_changed":
            if resourcePreviews.removeValue(forKey: key) != nil {
                persist(resourcePreviews, key: resourcePreviewsKey)
            }
            if requestedResourceAccess.remove(key) != nil {
                persist(Array(requestedResourceAccess), key: requestedResourceAccessKey)
            }
        default:
            return
        }
        postResourceStatusChanged(key: key, shouldRefresh: true)
    }

    static func sessionShare(id: String) -> IMSessionShareCard? {
        loadPersistentStateIfNeeded()
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return sessionShares[trimmed]
    }

    static func putSessionShare(_ card: IMSessionShareCard) {
        loadPersistentStateIfNeeded()
        let key = card.shareId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        let merged: IMSessionShareCard
        if let existing = sessionShares[key] {
            merged = IMSessionShareCard(
                shareId: card.shareId,
                sessionId: card.sessionId?.nilIfEmpty ?? existing.sessionId,
                sessionTitle: card.sessionTitle?.nilIfEmpty ?? existing.sessionTitle,
                ownerUserId: card.ownerUserId?.nilIfEmpty ?? existing.ownerUserId,
                granteeUserId: card.granteeUserId?.nilIfEmpty ?? existing.granteeUserId,
                canFork: card.canFork,
                canChat: card.canChat,
                status: card.status?.nilIfEmpty ?? existing.status,
                ownerDisplayName: card.ownerDisplayName?.nilIfEmpty ?? existing.ownerDisplayName,
                granteeDisplayName: card.granteeDisplayName?.nilIfEmpty ?? existing.granteeDisplayName
            )
        } else {
            merged = card
        }
        guard sessionShares[key] != merged else { return }
        sessionShares[key] = merged
        trimDictionary(&sessionShares, maxSize: maxSessionShares)
        persist(sessionShares, key: sessionSharesKey)
        NotificationCenter.default.post(
            name: .imSessionShareStatusDidChange,
            object: nil,
            userInfo: ["share_id": key]
        )
    }

    /// 消息里的旧共享卡只是快照；只有详情接口 / 控制动作返回的数据能阻止列表回收后重复拉取。
    static func authoritativeSessionShare(id: String) -> IMSessionShareCard? {
        let key = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return nil }
        return authoritativeSessionShares[key]
    }

    static func putAuthoritativeSessionShare(_ card: IMSessionShareCard) {
        let key = card.shareId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        putSessionShare(card)
        authoritativeSessionShares[key] = sessionShare(id: key) ?? card
        trimDictionary(&authoritativeSessionShares, maxSize: maxCardDetails)
    }

    static func sessionShareV2Detail(
        id: String,
        minimumVersion: Int
    ) -> IMSessionShareV2Detail? {
        let key = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty,
              let detail = sessionShareV2Details[key],
              (detail.version ?? 0) >= minimumVersion else {
            return nil
        }
        return detail
    }

    static func putSessionShareV2Detail(_ detail: IMSessionShareV2Detail) {
        let key = detail.id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        if let existing = sessionShareV2Details[key],
           (existing.version ?? 0) > (detail.version ?? 0) {
            return
        }
        sessionShareV2Details[key] = detail
        trimDictionary(&sessionShareV2Details, maxSize: maxCardDetails)
        putSessionShare(detail.cardSnapshot)
    }

    static func invalidateSessionShare(id: String) {
        let key = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        sessionShares.removeValue(forKey: key)
        persist(sessionShares, key: sessionSharesKey)
        authoritativeSessionShares.removeValue(forKey: key)
        sessionShareV2Details.removeValue(forKey: key)
    }

    static func sessionContinuationDetail(
        id: String,
        minimumVersion: Int
    ) -> IMSessionContinuationDetail? {
        let key = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty,
              let detail = sessionContinuationDetails[key],
              detail.version >= minimumVersion else {
            return nil
        }
        return detail
    }

    static func putSessionContinuationDetail(_ detail: IMSessionContinuationDetail) {
        let key = detail.objectId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        if let existing = sessionContinuationDetails[key], existing.version > detail.version {
            return
        }
        sessionContinuationDetails[key] = detail
        trimDictionary(&sessionContinuationDetails, maxSize: maxCardDetails)
    }

    private static func loadPersistentStateIfNeeded() {
        guard !didLoadPersistentState else { return }
        didLoadPersistentState = true
        if let data = defaults.data(forKey: resourcePreviewsKey),
           let cached = try? decoder.decode([String: IMResourceCardPreviewResult].self, from: data) {
            resourcePreviews = cached
            trimDictionary(&resourcePreviews, maxSize: maxResourcePreviews)
        }
        if let data = defaults.data(forKey: requestedResourceAccessKey),
           let cached = try? decoder.decode([String].self, from: data) {
            requestedResourceAccess = Set(cached)
        }
        if let data = defaults.data(forKey: sessionSharesKey),
           let cached = try? decoder.decode([String: IMSessionShareCard].self, from: data) {
            sessionShares = cached
            trimDictionary(&sessionShares, maxSize: maxSessionShares)
        }
    }

    private static func persist<T: Encodable>(_ value: T, key: String) {
        guard let data = try? encoder.encode(value) else { return }
        defaults.set(data, forKey: key)
    }

    private static func cardType(forBackendResourceType resourceType: String?) -> String? {
        switch resourceType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "tabdoc", "document": return IMResourceCardType.document.rawValue
        case "tabdata", "table": return IMResourceCardType.table.rawValue
        default: return nil
        }
    }

    private static func postResourceStatusChanged(key: String, shouldRefresh: Bool) {
        NotificationCenter.default.post(
            name: .imResourceCardStatusDidChange,
            object: nil,
            userInfo: [
                "resourceKey": key,
                "shouldRefresh": shouldRefresh,
            ]
        )
    }

    private static func trimDictionary<T>(_ dictionary: inout [String: T], maxSize: Int) {
        while dictionary.count > maxSize, let key = dictionary.keys.first {
            dictionary.removeValue(forKey: key)
        }
    }
}

/// 详情请求由会话持有，而不是由惰性列表里的单张卡持有。
///
/// SwiftUI 回收卡片会取消该卡的 `.task`，但这里创建的是独立任务；新的卡片观察者会等待同一请求，
/// 不会因为上下滑动反复击穿详情接口。
@MainActor
final class IMCardDetailRequestCoalescer<Value: Sendable> {
    private struct Entry {
        let id: UUID
        let task: Task<Result<Value, Error>, Never>
    }

    private var inFlight: [String: Entry] = [:]

    func load(
        key: String,
        request: @escaping @MainActor () async throws -> Value
    ) async -> Result<Value, Error> {
        if let existing = inFlight[key] {
            return await existing.task.value
        }

        let entryId = UUID()
        let task = Task { @MainActor in
            do {
                return Result<Value, Error>.success(try await request())
            } catch {
                return Result<Value, Error>.failure(error)
            }
        }
        inFlight[key] = Entry(id: entryId, task: task)
        let result = await task.value
        if inFlight[key]?.id == entryId {
            inFlight.removeValue(forKey: key)
        }
        return result
    }
}

@MainActor
final class IMConversationCardDetailRequestCoordinator {
    let legacySessionShares = IMCardDetailRequestCoalescer<IMSessionShareCard>()
    let sessionShareV2 = IMCardDetailRequestCoalescer<IMSessionShareV2Detail>()
    let sessionContinuations = IMCardDetailRequestCoalescer<IMSessionContinuationDetail>()
}

struct IMResourceAccessRequestInfo: Decodable, Sendable, Equatable {
    let id: String
    let resourceType: String
    let resourceId: String
    let role: String
    let status: String

    enum CodingKeys: String, CodingKey {
        case id, role, status
        case resourceType = "resource_type"
        case resourceId = "resource_id"
    }
}

/// 一张可复用的 AI 指令卡。它不绑定后端资源，用户可以将正文带入新任务后再选择 AI 分身和 Workspace。
struct IMPromptCard: Sendable, Equatable {
    let title: String
    let promptText: String

    var displayTitle: String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedTitle.isEmpty { return trimmedTitle }
        let firstLine = promptText
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
        return firstLine ?? "指令"
    }
}

struct IMCodexSessionCard: Sendable, Equatable {
    let sessionId: String
    let sessionName: String
    let suggestedWorkingDirectory: String?
}

struct IMSpaceCard: Sendable, Equatable {
    let type: String
    let spaceId: String
    let displayName: String
    let icon: String?
}

/// 客户端发送中的富卡类型。后端仍以 TEXT + metadata.card 落库；这里仅让发送、乐观态和重试共享一份
/// 明确的类型模型，避免在 UI 层散落无类型字典。
enum IMOutgoingCardKind: String, Codable, Sendable, Identifiable {
    case space
    case agentSpace = "agent_space"
    case document
    case table
    case contact
    case prompt
    case codexSession = "codex_session"

    var id: String { rawValue }
}

struct IMOutgoingCard: Codable, Sendable, Equatable {
    let kind: IMOutgoingCardKind
    let resourceId: String?
    let userId: String?
    let name: String
    let icon: String?
    let spaceId: String?
    let organizationId: String?
    let username: String?
    let avatar: String?
    let promptText: String?
    let title: String?
    let schemaVersion: Int?
    let codexSessionId: String?
    let codexSessionName: String?
    let suggestedWorkingDirectory: String?

    static func resource(
        kind: IMOutgoingCardKind,
        resourceId: String,
        name: String,
        spaceId: String?,
        organizationId: String?
    ) -> IMOutgoingCard {
        precondition(kind == .document || kind == .table)
        return IMOutgoingCard(
            kind: kind,
            resourceId: resourceId,
            userId: nil,
            name: name,
            icon: nil,
            spaceId: spaceId,
            organizationId: organizationId,
            username: nil,
            avatar: nil,
            promptText: nil,
            title: nil,
            schemaVersion: nil,
            codexSessionId: nil,
            codexSessionName: nil,
            suggestedWorkingDirectory: nil
        )
    }

    static func workspace(_ card: IMSpaceCard) -> IMOutgoingCard {
        guard let kind = IMOutgoingCardKind(rawValue: card.type),
              kind == .space || kind == .agentSpace else {
            preconditionFailure("Workspace card requires a Workspace card kind")
        }
        return IMOutgoingCard(
            kind: kind,
            resourceId: nil,
            userId: nil,
            name: card.displayName,
            icon: card.icon,
            spaceId: card.spaceId,
            organizationId: nil,
            username: nil,
            avatar: nil,
            promptText: nil,
            title: nil,
            schemaVersion: nil,
            codexSessionId: nil,
            codexSessionName: nil,
            suggestedWorkingDirectory: nil
        )
    }

    static func contact(userId: String, name: String, username: String?, avatar: String?) -> IMOutgoingCard {
        IMOutgoingCard(
            kind: .contact,
            resourceId: nil,
            userId: userId,
            name: name,
            icon: nil,
            spaceId: nil,
            organizationId: nil,
            username: username,
            avatar: avatar,
            promptText: nil,
            title: nil,
            schemaVersion: nil,
            codexSessionId: nil,
            codexSessionName: nil,
            suggestedWorkingDirectory: nil
        )
    }

    static func prompt(promptText: String, title: String) -> IMOutgoingCard {
        IMOutgoingCard(
            kind: .prompt,
            resourceId: nil,
            userId: nil,
            name: "",
            icon: nil,
            spaceId: nil,
            organizationId: nil,
            username: nil,
            avatar: nil,
            promptText: promptText,
            title: title,
            schemaVersion: nil,
            codexSessionId: nil,
            codexSessionName: nil,
            suggestedWorkingDirectory: nil
        )
    }

    static func codexSession(_ card: IMCodexSessionCard) -> IMOutgoingCard {
        IMOutgoingCard(
            kind: .codexSession,
            resourceId: nil,
            userId: nil,
            name: card.sessionName,
            icon: nil,
            spaceId: nil,
            organizationId: nil,
            username: nil,
            avatar: nil,
            promptText: nil,
            title: nil,
            schemaVersion: 1,
            codexSessionId: card.sessionId,
            codexSessionName: card.sessionName,
            suggestedWorkingDirectory: card.suggestedWorkingDirectory
        )
    }

    /// 请求体的 card JSON。资源 / 名片的权威快照由后端覆盖，指令卡由后端白名单重建。
    func requestPayload() -> [String: Any] {
        switch kind {
        case .space, .agentSpace:
            return ["type": kind.rawValue, "space_id": spaceId ?? ""]
        case .document, .table:
            return ["type": kind.rawValue, "resource_id": resourceId ?? ""]
        case .contact:
            return ["type": kind.rawValue, "user_id": userId ?? ""]
        case .prompt:
            var payload: [String: Any] = [
                "type": kind.rawValue,
                "prompt_text": promptText ?? "",
            ]
            if let title, !title.isEmpty { payload["title"] = title }
            return payload
        case .codexSession:
            var payload: [String: Any] = [
                "type": kind.rawValue,
                "schema_version": schemaVersion ?? 1,
                "codex_session_id": codexSessionId ?? "",
                "codex_session_name": codexSessionName ?? "",
            ]
            if let suggestedWorkingDirectory, !suggestedWorkingDirectory.isEmpty {
                payload["suggested_working_directory"] = suggestedWorkingDirectory
            }
            return payload
        }
    }

    /// POST 回包只有 id/seq，本地先据选择快照渲染；随后 realtime 权威回声会覆盖它。
    var localCard: IMResourceCard {
        IMResourceCard(
            type: kind.rawValue,
            name: name,
            icon: icon,
            resourceId: resourceId,
            spaceId: spaceId,
            organizationId: organizationId,
            hintCarrierAppId: kind == .document ? "tabdoc" : (kind == .table ? "tabdata" : nil),
            userId: userId,
            username: username,
            avatar: avatar,
            title: title,
            promptText: promptText,
            promptVersion: kind == .prompt ? 1 : nil,
            schemaVersion: schemaVersion,
            codexSessionId: codexSessionId,
            codexSessionName: codexSessionName,
            suggestedWorkingDirectory: suggestedWorkingDirectory
        )
    }

    /// 旧端 / 搜索 / 会话列表仍可读的 text 回退内容。
    var fallbackContent: String {
        switch kind {
        case .space, .agentSpace: return "[工作空间] \(name)"
        case .document: return "[文档] \(name)"
        case .table: return "[表格] \(name)"
        case .contact: return "[名片] \(name)"
        case .prompt:
            let firstLine = (promptText ?? "")
                .split(separator: "\n", omittingEmptySubsequences: true)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first(where: { !$0.isEmpty }) ?? "指令"
            let label = (title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? firstLine)
            return "[指令] \(String(label.prefix(60)))"
        case .codexSession:
            return "[Codex 会话] \(codexSessionName ?? name)"
        }
    }
}

struct IMResourceCardOpenTarget: Equatable, Sendable {
    let resourceType: String
    let resourceId: String
    let organizationId: String
    let spaceId: String?
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// 幂等创建/复用私信响应。
struct IMCreateDMResult: Decodable, Sendable, Equatable {
    let conversationId: String

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
    }
}

/// 创建群聊响应。与私信复用同一服务端响应形状，但保留独立模型以免调用点混淆两种行为。
struct IMCreateGroupResult: Decodable, Sendable, Equatable {
    let conversationId: String

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
    }
}

/// 消息发送回执；客户端据已知正文补齐乐观消息，随后由实时回声覆盖。
struct IMSendMessageResult: Decodable, Sendable, Equatable {
    let id: Int
    let seq: Int
    let conversationId: String
    let createdAt: String?
    let tabtinMessageId: String?

    enum CodingKeys: String, CodingKey {
        case id
        case seq
        case conversationId = "conversation_id"
        case createdAt = "created_at"
        case tabtinMessageId = "tabtin_message_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(Int.self, forKey: .id) ?? 0
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
        conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        tabtinMessageId = try c.decodeIfPresent(String.self, forKey: .tabtinMessageId)
    }

    init(id: Int, seq: Int, conversationId: String, createdAt: String? = nil, tabtinMessageId: String? = nil) {
        self.id = id
        self.seq = seq
        self.conversationId = conversationId
        self.createdAt = createdAt
        self.tabtinMessageId = tabtinMessageId
    }
}

/// 附件临时下载信息（按 file_id 从 OSS 权限接口换取）。
struct IMAttachmentURL: Decodable, Sendable, Equatable {
    let downloadURL: String
    let fileName: String
    let expiresIn: Int
    let candidateURLs: [String]

    enum CodingKeys: String, CodingKey {
        case downloadURL = "download_url"
        case fileName = "file_name"
        case expiresIn = "expires_in"
        case candidateURLs = "candidate_urls"
    }

    init(downloadURL: String, fileName: String, expiresIn: Int, candidateURLs: [String] = []) {
        self.downloadURL = downloadURL
        self.fileName = fileName
        self.expiresIn = expiresIn
        self.candidateURLs = candidateURLs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        downloadURL = try c.decodeIfPresent(String.self, forKey: .downloadURL) ?? ""
        fileName = try c.decodeIfPresent(String.self, forKey: .fileName) ?? ""
        expiresIn = try c.decodeIfPresent(Int.self, forKey: .expiresIn) ?? 0
        candidateURLs = try c.decodeIfPresent([String].self, forKey: .candidateURLs) ?? []
    }

    var displayURLs: [String] {
        ([downloadURL] + candidateURLs)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { raw in
                let lower = raw.lowercased()
                return lower.hasPrefix("http://") || lower.hasPrefix("https://")
            }
            .removingDuplicates()
    }
}

/// 单条消息，对齐后端 `_serialize_message`（`MessageOut` + 实际多下发的
/// `sender_type` / `is_pinned` / `edited_at`）。缺省字段容错解码，避免后端字段增减即解码失败。
struct IMMessage: Decodable, Sendable, Identifiable, Equatable {
    let id: Int
    let seq: Int
    let conversationId: String
    let senderId: String
    /// user | agent（后端 `_serialize_message` 实际下发，`MessageOut` schema 未列）。
    let senderType: String
    let senderName: String
    /// 撤回后服务端下发空串；本地也可就地清空（Phase E 撤回/编辑）。
    var content: String
    let messageType: Int
    let replyToId: Int?
    var replyToPreview: IMReplyPreview?
    let hasAttachment: Bool
    let metadata: IMMessageMetadata?
    var createdAt: String?
    /// 撤回态：服务端软删或本地乐观撤回（Phase E）。
    var isDeleted: Bool
    /// 编辑时间戳（非空即「已编辑」，Phase E）。
    var editedAt: String?
    var isPinned: Bool
    /// 本地内部字段：true 表示当前 isPinned 来自置顶事件或已 enrich 的历史页，可覆盖 false。
    var pinStateKnown: Bool
    /// emoji → 点了该表情的 userId 列表（Phase E 表情回应本地可就地增删）。
    var reactions: [String: [String]]
    /// 本地展示顺序：对齐 Electron Object.entries，已有表情保持位置，新表情追加。
    var reactionOrder: [String]
    /// 本地内部字段：true 表示 reactions 是服务端权威快照，空字典也必须覆盖旧状态。
    var reactionStateKnown: Bool
    /// 仅本人发出的消息在列表里附带的已读聚合（`read_receipt`）；DM/群已读呈现用。
    var readReceipt: IMReadReceipt?

    enum CodingKeys: String, CodingKey {
        case id
        case seq
        case conversationId = "conversation_id"
        case senderId = "sender_id"
        case senderType = "sender_type"
        case senderName = "sender_name"
        case content
        case messageType = "message_type"
        case replyToId = "reply_to_id"
        case replyToPreview = "reply_to_preview"
        case hasAttachment = "has_attachment"
        case metadata
        case createdAt = "created_at"
        case isDeleted = "is_deleted"
        case editedAt = "edited_at"
        case isPinned = "is_pinned"
        case reactions
        case reactionOrder = "reaction_order"
        case readReceipt = "read_receipt"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        seq = try c.decode(Int.self, forKey: .seq)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        senderId = try c.decode(String.self, forKey: .senderId)
        senderType = try c.decodeIfPresent(String.self, forKey: .senderType) ?? IMMemberType.user.rawValue
        senderName = try c.decodeIfPresent(String.self, forKey: .senderName) ?? ""
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        messageType = try c.decode(Int.self, forKey: .messageType)
        replyToId = try c.decodeIfPresent(Int.self, forKey: .replyToId)
        replyToPreview = try c.decodeIfPresent(IMReplyPreview.self, forKey: .replyToPreview)
        hasAttachment = try c.decodeIfPresent(Bool.self, forKey: .hasAttachment) ?? false
        // metadata 用 try?：即便整体不是对象（无法形成 keyed 容器）也只降级为 nil，
        // 不拖垮本条消息乃至整页历史解码。
        metadata = try? c.decodeIfPresent(IMMessageMetadata.self, forKey: .metadata)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        isDeleted = try c.decodeIfPresent(Bool.self, forKey: .isDeleted) ?? false
        editedAt = try c.decodeIfPresent(String.self, forKey: .editedAt)
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        pinStateKnown = c.contains(.isPinned)
        reactions = try c.decodeIfPresent([String: [String]].self, forKey: .reactions) ?? [:]
        reactionOrder = try c.decodeIfPresent([String].self, forKey: .reactionOrder) ?? Array(reactions.keys)
        reactionStateKnown = c.contains(.reactions)
        readReceipt = try? c.decodeIfPresent(IMReadReceipt.self, forKey: .readReceipt)
    }

    /// 本地构造：`POST` 只回 id/seq/created_at（非完整消息），据本地已知字段补齐一条乐观消息；
    /// 权威副本随 `chat:{conv}` 实时回声（同 id）覆盖。对齐 Android `ImMessage` 默认构造路径。
    init(
        id: Int,
        seq: Int,
        conversationId: String,
        senderId: String,
        senderType: String = IMMemberType.user.rawValue,
        senderName: String = "",
        content: String,
        messageType: Int,
        replyToId: Int? = nil,
        replyToPreview: IMReplyPreview? = nil,
        hasAttachment: Bool = false,
        metadata: IMMessageMetadata? = nil,
        createdAt: String? = nil,
        isDeleted: Bool = false,
        editedAt: String? = nil,
        isPinned: Bool = false,
        pinStateKnown: Bool = false,
        reactions: [String: [String]] = [:],
        reactionOrder: [String] = [],
        reactionStateKnown: Bool = false,
        readReceipt: IMReadReceipt? = nil
    ) {
        self.id = id
        self.seq = seq
        self.conversationId = conversationId
        self.senderId = senderId
        self.senderType = senderType
        self.senderName = senderName
        self.content = content
        self.messageType = messageType
        self.replyToId = replyToId
        self.replyToPreview = replyToPreview
        self.hasAttachment = hasAttachment
        self.metadata = metadata
        self.createdAt = createdAt
        self.isDeleted = isDeleted
        self.editedAt = editedAt
        self.isPinned = isPinned
        self.pinStateKnown = pinStateKnown
        self.reactions = reactions
        self.reactionOrder = reactionOrder.isEmpty ? Array(reactions.keys) : reactionOrder
        self.reactionStateKnown = reactionStateKnown
        self.readReceipt = readReceipt
    }

    var typedMessageType: IMMessageType? { IMMessageType(rawValue: messageType) }
    var isFromAgent: Bool { senderType == IMMemberType.agent.rawValue }

    /// 有效附件 id（image/file 消息 + metadata.file_id 非空）。
    var attachmentFileId: String? {
        guard hasAttachment, let fileId = metadata?.fileId, !fileId.isEmpty else { return nil }
        return fileId
    }
    var hasInlineAttachmentURL: Bool { metadata?.inlineAttachmentURLs.isEmpty == false }
    var isImageAttachment: Bool { typedMessageType == .image && (attachmentFileId != nil || hasAttachment || hasInlineAttachmentURL) }
    var isFileAttachment: Bool { typedMessageType == .file && (attachmentFileId != nil || hasAttachment || hasInlineAttachmentURL) }
    var attachmentFileName: String { metadata?.fileName ?? "" }
    var attachmentFileSize: Int? { metadata?.fileSize }

    /// 附件换链端点使用 TabTin 消息表主键，不使用传输游标。
    /// REST 历史消息本身的 `id` 就是后端主键；兼容消息可从 metadata 取后端主键。
    var attachmentLookupMessageId: Int? {
        if let tabtinMessageId = metadata?.tabtinMessageId.flatMap(Int.init) { return tabtinMessageId }
        return id > 0 ? id : nil
    }

    /// 携带的资源卡（文档/表格/名片）；仅当 card.type 是移动端已支持资源类型时返回。
    var resourceCard: IMResourceCard? {
        guard let metadata else { return nil }
        let card = metadata.card ?? metadata.recoverableResourceCard(messageContent: content)
        guard let card else { return nil }
        switch card.typedType {
        case .document, .table, .contact: return card
        case .space, .agentSpace: return card.spaceCard == nil ? nil : card
        default: return nil
        }
    }

    var resourceCardDisplayName: String? {
        guard let card = resourceCard else { return nil }
        return card.displayName(messageContent: content)
    }

    /// 携带的指令卡（prompt）。
    var promptCard: IMPromptCard? { metadata?.card?.promptCard }

    /// 携带的 Codex 会话归档卡；移动端保留为可下载文件，不声称支持本机导入。
    var codexSessionCard: IMCodexSessionCard? { metadata?.card?.codexSessionCard }

    /// 可安全转发的结构化卡片。只从已识别字段重建最小发送载荷，不复制任意 metadata JSON。
    var forwardableCard: IMOutgoingCard? {
        if let promptCard {
            return .prompt(promptText: promptCard.promptText, title: promptCard.title)
        }
        if let codexSessionCard {
            return .codexSession(codexSessionCard)
        }
        guard let card = resourceCard else { return nil }
        switch card.typedType {
        case .document, .table:
            guard let resourceId = card.resourceId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !resourceId.isEmpty else { return nil }
            return .resource(
                kind: card.typedType == .document ? .document : .table,
                resourceId: resourceId,
                name: card.displayName(messageContent: content),
                spaceId: card.spaceId,
                organizationId: card.organizationId
            )
        case .contact:
            guard let userId = card.userId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !userId.isEmpty else { return nil }
            return .contact(
                userId: userId,
                name: card.displayName(messageContent: content),
                username: card.username,
                avatar: card.avatar
            )
        case .space, .agentSpace:
            guard let spaceCard = card.spaceCard else { return nil }
            return .workspace(spaceCard)
        case .sessionShare, .none:
            return nil
        }
    }

    /// 携带的任务共享卡。
    var sessionShareCard: IMSessionShareCard? { metadata?.card?.sessionShareCard }

    /// 携带的新任务协作卡消息快照。
    var sessionShareV2Card: IMSessionShareV2Card? { metadata?.card?.sessionShareV2Card }

    /// 携带的冻结任务续接卡消息快照。
    var sessionContinuationCard: IMSessionContinuationCard? {
        metadata?.card?.sessionContinuationCard
    }

    /// 任意 metadata.card（包括未知/损坏类型）都不应允许编辑为普通文本。
    var hasStructuredCard: Bool { metadata?.hasCardPayload == true }

    /// 授权卡和冻结上下文卡都绑定原收发双方，不能把原 metadata 转发到另一段会话。
    var isForwardRestrictedCard: Bool {
        switch metadata?.cardType {
        case "handoff", "session_share", "session_share_v2", "session_continuation": return true
        default: return false
        }
    }

    /// 普通消息可转发；结构化卡必须能重建可信 payload，避免只转发降级文本。
    var canForward: Bool {
        !isForwardRestrictedCard && (!hasStructuredCard || forwardableCard != nil)
    }

    /// 已编辑（编辑时间戳非空且未撤回）。
    var isEdited: Bool { !isDeleted && (editedAt?.isEmpty == false) }

    /// 是否文本消息（编辑仅限没有任何 card payload 的文本）。
    var isPlainText: Bool { typedMessageType == .text && !hasStructuredCard }
}

/// 可 @ 的 Agent 摘要，对齐后端 `GET /im/agents/search` 返回项（本人拥有的启用 bot）。
struct IMAgentSummary: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let name: String
    let avatar: String

    enum CodingKeys: String, CodingKey {
        case id, name, avatar
    }

    init(id: String, name: String, avatar: String = "") {
        self.id = id
        self.name = name
        self.avatar = avatar
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar) ?? ""
    }

    var displayName: String { name.isEmpty ? "Agent" : name }
}

/// 团队频道消息升级为 Agent 会话后的导航与首发上下文。
struct IMAgentTaskThreadResult: Decodable, Sendable {
    let sessionId: String
    let threadId: String?
    let projectId: String
    let workspaceId: String?
    let organizationId: String
    let title: String
    let defaultPrompt: String
    let sourceMessageIds: [Int]

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case threadId = "thread_id"
        case projectId = "space_id"
        case workspaceId = "workspace_id"
        case organizationId = "organization_id"
        case title
        case defaultPrompt = "default_prompt"
        case sourceMessageIds = "source_message_ids"
    }
}

/// 普通群中 Agent 与执行 Workspace 的传输无关绑定。
struct IMConversationAgentBinding: Decodable, Sendable, Equatable, Identifiable {
    var id: String { agentId }
    let agentId: String
    let workspaceId: String
    let workspaceName: String
    let boundByUserId: String
    let boundAt: String?
    let canRebind: Bool
    let isExecutable: Bool

    enum CodingKeys: String, CodingKey {
        case agentId = "agent_id"
        case workspaceId = "workspace_id"
        case workspaceName = "workspace_name"
        case boundByUserId = "bound_by_user_id"
        case boundAt = "bound_at"
        case canRebind = "can_rebind"
        case isExecutable = "is_executable"
    }
}

struct IMConversationAgentBindingList: Decodable, Sendable, Equatable {
    let items: [IMConversationAgentBinding]
}

/// 会话置顶响应与兼容信封共用形状。
struct IMConversationPinResult: Decodable, Sendable, Equatable {
    let pinned: Bool
}

/// 旧 Django `POST .../mute` 响应形状，仅供兼容解码。
struct IMConversationMuteResult: Decodable, Sendable, Equatable {
    let muted: Bool
}

/// `POST /im/conversations/{id}/clear-history` 返回的个人可见性水位。
/// 共享实时通道可能延迟送达，客户端用该水位丢弃清空前的事件。
struct IMClearHistoryResult: Decodable, Sendable, Equatable {
    let clearedSeq: Int

    enum CodingKeys: String, CodingKey { case clearedSeq = "cleared_seq" }
}

/// `GET /im/conversations/{id}/history-state` 返回的当前用户个人可见性水位。
struct IMHistoryState: Decodable, Sendable, Equatable {
    let historyClearedSeq: Int

    enum CodingKeys: String, CodingKey { case historyClearedSeq = "history_cleared_seq" }
}

// MARK: - 对话接力

enum IMHandoffAction: String, Sendable {
    case acknowledge
    case takeOver = "take_over"
    case reject
}

struct IMHandoffChecklistItem: Decodable, Sendable, Equatable, Identifiable {
    let text: String
    let checked: Bool?
    let highRisk: Bool?
    var id: String { "\(text):\(checked == true):\(highRisk == true)" }

    enum CodingKeys: String, CodingKey {
        case text, checked
        case highRisk = "high_risk"
    }
}

struct IMHandoffRecipient: Decodable, Sendable, Equatable, Identifiable {
    let userId: String?
    let agentId: String?
    let state: String
    let note: String
    let stateChangedAt: String?
    var id: String { userId ?? agentId ?? "unknown" }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case agentId = "agent_id"
        case state, note
        case stateChangedAt = "state_changed_at"
    }
}

struct IMHandoffSourceLink: Decodable, Sendable, Equatable {
    let conversationId: String?
    let messageId: Int?
    let seq: Int?
    let spaceId: String?
    let organizationId: String?
    let sessionId: String?

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case messageId = "message_id"
        case seq
        case spaceId = "space_id"
        case organizationId = "organization_id"
        case sessionId = "session_id"
    }
}

struct IMHandoffFrozenAttachment: Decodable, Sendable, Equatable, Identifiable {
    let type: String
    let fileId: String
    let filename: String
    let mimeType: String
    let size: Int
    var id: String { fileId.isEmpty ? filename : fileId }

    enum CodingKeys: String, CodingKey {
        case type, filename, size
        case fileId = "file_id"
        case mimeType = "mime_type"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "file"
        fileId = try c.decodeIfPresent(String.self, forKey: .fileId) ?? ""
        filename = try c.decodeIfPresent(String.self, forKey: .filename) ?? "未命名文件"
        mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType) ?? ""
        size = try c.decodeIfPresent(Int.self, forKey: .size) ?? 0
    }
}

struct IMHandoffFrozenTurn: Decodable, Sendable, Equatable, Identifiable {
    let role: String
    let text: String
    let attachments: [IMHandoffFrozenAttachment]
    var id: String { "\(role):\(text):\(attachments.map(\.id).joined())" }

    enum CodingKeys: String, CodingKey { case role, text, attachments }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        attachments = (try? c.decodeIfPresent([IMHandoffFrozenAttachment].self, forKey: .attachments)) ?? []
    }
}

struct IMHandoffFrozenTranscript: Decodable, Sendable, Equatable {
    let title: String
    let messageCount: Int
    let truncated: Bool
    let turns: [IMHandoffFrozenTurn]

    enum CodingKeys: String, CodingKey {
        case title, truncated, turns
        case messageCount = "message_count"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Agent 会话记录"
        messageCount = try c.decodeIfPresent(Int.self, forKey: .messageCount) ?? 0
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        turns = try c.decodeIfPresent([IMHandoffFrozenTurn].self, forKey: .turns) ?? []
    }
}

struct IMHandoffReference: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let refType: String
    let resourceId: String
    let title: String
    let summary: String
    let sourceLink: IMHandoffSourceLink
    let accessible: Bool
    let deniedReason: String?
    let frozenSnapshot: IMHandoffFrozenTranscript?

    enum CodingKeys: String, CodingKey {
        case id, title, summary, accessible
        case refType = "ref_type"
        case resourceId = "resource_id"
        case sourceLink = "source_link"
        case deniedReason = "denied_reason"
        case frozenSnapshot = "frozen_snapshot"
    }
}

struct IMHandoffPackage: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let conversationId: String
    let organizationId: String
    let initiatorType: String
    let initiatorUserId: String?
    let initiatorAgentId: String?
    let goal: String
    let progress: [IMHandoffChecklistItem]
    let nextSteps: [IMHandoffChecklistItem]
    let risks: [IMHandoffChecklistItem]
    let scope: String
    let status: String
    let version: Int
    let cardMessageId: Int?
    let recipients: [IMHandoffRecipient]
    let references: [IMHandoffReference]

    enum CodingKeys: String, CodingKey {
        case id, goal, progress, risks, scope, status, version, recipients, references
        case conversationId = "conversation_id"
        case organizationId = "organization_id"
        case initiatorType = "initiator_type"
        case initiatorUserId = "initiator_user_id"
        case initiatorAgentId = "initiator_agent_id"
        case nextSteps = "next_steps"
        case cardMessageId = "card_message_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        organizationId = try c.decode(String.self, forKey: .organizationId)
        initiatorType = try c.decodeIfPresent(String.self, forKey: .initiatorType) ?? "user"
        initiatorUserId = try c.decodeIfPresent(String.self, forKey: .initiatorUserId)
        initiatorAgentId = try c.decodeIfPresent(String.self, forKey: .initiatorAgentId)
        goal = try c.decodeIfPresent(String.self, forKey: .goal) ?? "上下文交接"
        progress = try c.decodeIfPresent([IMHandoffChecklistItem].self, forKey: .progress) ?? []
        nextSteps = try c.decodeIfPresent([IMHandoffChecklistItem].self, forKey: .nextSteps) ?? []
        risks = try c.decodeIfPresent([IMHandoffChecklistItem].self, forKey: .risks) ?? []
        scope = try c.decodeIfPresent(String.self, forKey: .scope) ?? "continuable"
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "sent"
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 0
        cardMessageId = try c.decodeIfPresent(Int.self, forKey: .cardMessageId)
        recipients = try c.decodeIfPresent([IMHandoffRecipient].self, forKey: .recipients) ?? []
        references = try c.decodeIfPresent([IMHandoffReference].self, forKey: .references) ?? []
    }
}

struct IMAddMembersResult: Decodable, Sendable, Equatable {
    let addedUserIds: [String]
    let addedExternalContactIds: [String]

    enum CodingKeys: String, CodingKey {
        case addedUserIds = "added_user_ids"
        case addedExternalContactIds = "added_external_contact_ids"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        addedUserIds = try container.decodeIfPresent([String].self, forKey: .addedUserIds) ?? []
        addedExternalContactIds = try container.decodeIfPresent([String].self, forKey: .addedExternalContactIds) ?? []
    }
}

/// 会话成员，对齐后端 `MemberOut`。
struct IMMember: Decodable, Sendable, Identifiable, Equatable {
    let memberType: String
    let userId: String?
    let agentId: String?
    /// 成员在该会话里的参与组织；跨组织同一自然人的会话身份不跨目录复用。
    let participantOrganizationId: String?
    let nickname: String
    let username: String
    let avatar: String
    let role: Int
    let isMuted: Bool
    let pinned: Bool
    let joinedAt: String?
    let ownerUserId: String?
    let ownerDisplayName: String
    let isExecutionOnline: Bool?
    let isExternal: Bool
    let organizationName: String

    enum CodingKeys: String, CodingKey {
        case memberType = "member_type"
        case userId = "user_id"
        case agentId = "agent_id"
        case participantOrganizationId = "participant_organization_id"
        case nickname
        case username
        case avatar
        case role
        case isMuted = "is_muted"
        case pinned
        case joinedAt = "joined_at"
        case ownerUserId = "owner_user_id"
        case ownerDisplayName = "owner_display_name"
        case isExecutionOnline = "is_execution_online"
        case isExternal = "is_external"
        case organizationName = "organization_name"
    }

    init(
        memberType: String = IMMemberType.user.rawValue,
        userId: String? = nil,
        agentId: String? = nil,
        participantOrganizationId: String? = nil,
        nickname: String = "",
        username: String = "",
        avatar: String = "",
        role: Int = 0,
        isMuted: Bool = false,
        pinned: Bool = false,
        joinedAt: String? = nil,
        ownerUserId: String? = nil,
        ownerDisplayName: String = "",
        isExecutionOnline: Bool? = nil,
        isExternal: Bool = false,
        organizationName: String = ""
    ) {
        self.memberType = memberType
        self.userId = userId
        self.agentId = agentId
        self.participantOrganizationId = participantOrganizationId
        self.nickname = nickname
        self.username = username
        self.avatar = avatar
        self.role = role
        self.isMuted = isMuted
        self.pinned = pinned
        self.joinedAt = joinedAt
        self.ownerUserId = ownerUserId
        self.ownerDisplayName = ownerDisplayName
        self.isExecutionOnline = isExecutionOnline
        self.isExternal = isExternal
        self.organizationName = organizationName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memberType = try c.decodeIfPresent(String.self, forKey: .memberType) ?? IMMemberType.user.rawValue
        userId = try c.decodeIfPresent(String.self, forKey: .userId)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        participantOrganizationId = try c.decodeIfPresent(
            String.self,
            forKey: .participantOrganizationId
        )
        nickname = try c.decodeIfPresent(String.self, forKey: .nickname) ?? ""
        username = try c.decodeIfPresent(String.self, forKey: .username) ?? ""
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar) ?? ""
        role = try c.decodeIfPresent(Int.self, forKey: .role) ?? 0
        isMuted = try c.decodeIfPresent(Bool.self, forKey: .isMuted) ?? false
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        joinedAt = try c.decodeIfPresent(String.self, forKey: .joinedAt)
        ownerUserId = try c.decodeIfPresent(String.self, forKey: .ownerUserId)
        ownerDisplayName = try c.decodeIfPresent(String.self, forKey: .ownerDisplayName) ?? ""
        isExecutionOnline = try c.decodeIfPresent(Bool.self, forKey: .isExecutionOnline)
        isExternal = try c.decodeIfPresent(Bool.self, forKey: .isExternal) ?? false
        organizationName = try c.decodeIfPresent(String.self, forKey: .organizationName) ?? ""
    }

    /// 成员唯一标识：user 成员用 userId，agent 成员用 agentId。
    var id: String {
        if let userId { return "user:\(userId)" }
        if let agentId { return "agent:\(agentId)" }
        return "\(memberType):\(username)"
    }

    var typedMemberType: IMMemberType? { IMMemberType(rawValue: memberType) }
    var displayName: String { nickname.isEmpty ? username : nickname }
}

/// 会话详情，对齐后端 `ConversationDetailOut`（含成员列表）。
struct IMConversationDetail: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    /// 会话托管组织；外部会话的当前目录见 `directoryScopeId`。
    let organizationId: String
    let participantOrganizationId: String?
    let directoryScopeId: String?
    let spaceId: String?
    let spaceName: String
    let isTeamSpaceChannel: Bool
    let type: Int
    let name: String
    let avatarUrl: String
    let memberCount: Int
    let isArchived: Bool
    let lastMessageAt: String?
    let lastMessagePreview: String
    let createdBy: String
    let createdAt: String
    let members: [IMMember]
    let hasUnreadMention: Bool
    /// 外部群禁止加入 Agent；详情缺失时由会话目录和服务端继续兜底校验。
    let isExternal: Bool
    let canSend: Bool
    let labels: [IMConversationLabel]

    enum CodingKeys: String, CodingKey {
        case id
        case organizationId = "organization_id"
        case participantOrganizationId = "participant_organization_id"
        case directoryScopeId = "directory_scope_id"
        case spaceId = "space_id"
        case spaceName = "space_name"
        case isTeamSpaceChannel = "is_team_space_channel"
        case type
        case name
        case avatarUrl = "avatar_url"
        case memberCount = "member_count"
        case isArchived = "is_archived"
        case lastMessageAt = "last_message_at"
        case lastMessagePreview = "last_message_preview"
        case createdBy = "created_by"
        case createdAt = "created_at"
        case members
        case hasUnreadMention = "has_unread_mention"
        case isExternal = "is_external"
        case canSend = "can_send"
        case labels
    }

    init(
        id: String,
        organizationId: String,
        spaceId: String? = nil,
        spaceName: String = "",
        isTeamSpaceChannel: Bool = false,
        type: Int,
        name: String = "",
        avatarUrl: String = "",
        memberCount: Int = 0,
        isArchived: Bool = false,
        lastMessageAt: String? = nil,
        lastMessagePreview: String = "",
        createdBy: String = "",
        createdAt: String = "",
        members: [IMMember] = [],
        hasUnreadMention: Bool = false,
        isExternal: Bool = false,
        participantOrganizationId: String? = nil,
        directoryScopeId: String? = nil,
        canSend: Bool = true,
        labels: [IMConversationLabel] = []
    ) {
        self.id = id
        self.organizationId = organizationId
        self.participantOrganizationId = participantOrganizationId
        self.directoryScopeId = directoryScopeId
        self.spaceId = spaceId
        self.spaceName = spaceName
        self.isTeamSpaceChannel = isTeamSpaceChannel
        self.type = type
        self.name = name
        self.avatarUrl = avatarUrl
        self.memberCount = memberCount
        self.isArchived = isArchived
        self.lastMessageAt = lastMessageAt
        self.lastMessagePreview = lastMessagePreview
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.members = members
        self.hasUnreadMention = hasUnreadMention
        self.isExternal = isExternal
        self.canSend = canSend
        self.labels = labels
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        organizationId = try c.decode(String.self, forKey: .organizationId)
        participantOrganizationId = try c.decodeIfPresent(String.self, forKey: .participantOrganizationId)
        directoryScopeId = try c.decodeIfPresent(String.self, forKey: .directoryScopeId)
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId)
        spaceName = try c.decodeIfPresent(String.self, forKey: .spaceName) ?? ""
        isTeamSpaceChannel = try c.decodeIfPresent(Bool.self, forKey: .isTeamSpaceChannel) ?? false
        type = try c.decode(Int.self, forKey: .type)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl) ?? ""
        memberCount = try c.decodeIfPresent(Int.self, forKey: .memberCount) ?? 0
        isArchived = try c.decodeIfPresent(Bool.self, forKey: .isArchived) ?? false
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
        lastMessagePreview = try c.decodeIfPresent(String.self, forKey: .lastMessagePreview) ?? ""
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        members = try c.decodeIfPresent([IMMember].self, forKey: .members) ?? []
        hasUnreadMention = try c.decodeIfPresent(Bool.self, forKey: .hasUnreadMention) ?? false
        isExternal = try c.decodeIfPresent(Bool.self, forKey: .isExternal) ?? false
        canSend = try c.decodeIfPresent(Bool.self, forKey: .canSend) ?? true
        labels = try c.decodeIfPresent([IMConversationLabel].self, forKey: .labels) ?? []
    }

    var conversationType: IMConversationType? { IMConversationType(rawValue: type) }

    var isRemovedMemberDirectMessage: Bool {
        conversationType == .dm && memberCount < 2
    }

    var directoryOrganizationId: String {
        guard isExternal else { return organizationId }
        return [directoryScopeId, participantOrganizationId, organizationId]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? organizationId
    }

    var canReceiveMessages: Bool { canSend && !isRemovedMemberDirectMessage }
}

/// 列表与详情都可能先拿到成员移除事实；任一权威快照已表明 DM 无合法对端时即进入只读。
func isIMConversationReadOnly(
    snapshot: IMConversation?,
    detail: IMConversationDetail?
) -> Bool {
    snapshot?.canReceiveMessages == false
        || detail?.canReceiveMessages == false
}

func imForwardTargets(
    _ conversations: [IMConversation],
    excluding sourceConversationId: String,
    allowExternal: Bool = false
) -> [IMConversation] {
    conversations.filter { conversation in
        conversation.id != sourceConversationId
            && conversation.canReceiveMessages
            && (allowExternal || !conversation.isExternal)
    }
}

enum IMWireDate {
    /// Django 的 ISO8601 时间可能带微秒，也可能不带小数秒；两种信封都接受。
    static func parse(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }
}

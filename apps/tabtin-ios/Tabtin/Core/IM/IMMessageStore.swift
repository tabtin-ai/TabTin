import Foundation
import os

private func imPreciseTimestampString(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

/// 将消息按用户可见的发送时间排序。
///
/// `created_at` 是用户可见顺序真源；`seq` 仅在历史缓存缺时间戳时作为兼容兜底。
/// 时间相同则保留服务端返回顺序，避免同一秒内的消息被客户端擅自重排。
func imChronologicallySortedMessages(_ messages: [IMMessage]) -> [IMMessage] {
    let indexed = Array(messages.enumerated())
    return indexed.sorted { lhs, rhs in
        let leftDate = lhs.element.createdAt.flatMap(ISO8601DateParser.date(from:))
        let rightDate = rhs.element.createdAt.flatMap(ISO8601DateParser.date(from:))

        if let leftDate, let rightDate {
            if leftDate != rightDate { return leftDate < rightDate }
            return lhs.offset < rhs.offset
        }

        // 历史测试数据 / 极旧缓存可能没有 created_at。只有两边都缺失时才回退 seq；
        // 缺少时间戳的记录放在有时间戳记录之前，确保 suffix(maxMessages) 保留最新消息。
        if leftDate != nil { return false }
        if rightDate != nil { return true }
        if lhs.element.seq != rhs.element.seq { return lhs.element.seq < rhs.element.seq }
        return lhs.offset < rhs.offset
    }.map(\.element)
}

@MainActor
protocol IMMessageSnapshotCache: AnyObject {
    func messages(conversationId: String) -> [IMMessage]
    func store(conversationId: String, messages: [IMMessage])
    func clear(conversationId: String)
}

@MainActor
protocol IMPinnedMessageSnapshotCache: AnyObject {
    func pinnedMessages(conversationId: String) -> [IMMessage]
    func storePinnedMessages(conversationId: String, messages: [IMMessage])
}

@MainActor
protocol IMPendingMessageCache: AnyObject {
    func pending(scopeId: String, conversationId: String) -> [IMPendingMessage]
    func store(scopeId: String, conversationId: String, pending: [IMPendingMessage])
    func clear(scopeId: String, conversationId: String)
}

@MainActor
final class IMPendingMessageUserDefaultsCache: IMPendingMessageCache {
    static let shared = IMPendingMessageUserDefaultsCache()
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func pending(scopeId: String, conversationId: String) -> [IMPendingMessage] {
        guard let data = defaults.data(forKey: key(scopeId: scopeId, conversationId: conversationId)),
              let value = try? decoder.decode([IMPendingMessage].self, from: data) else { return [] }
        var seen: Set<String> = []
        return value.compactMap { item in
            guard seen.insert(item.clientRequestId).inserted else { return nil }
            var restored = item
            restored.status = .failed
            restored.errorMessage = nil
            return restored
        }
    }

    func store(scopeId: String, conversationId: String, pending: [IMPendingMessage]) {
        guard !pending.isEmpty else { clear(scopeId: scopeId, conversationId: conversationId); return }
        guard let data = try? encoder.encode(pending) else { return }
        defaults.set(data, forKey: key(scopeId: scopeId, conversationId: conversationId))
    }

    func clear(scopeId: String, conversationId: String) {
        defaults.removeObject(forKey: key(scopeId: scopeId, conversationId: conversationId))
    }

    private func key(scopeId: String, conversationId: String) -> String {
        "tabtin.im.pending.\(scopeId).\(conversationId)"
    }
}

@MainActor
final class IMPendingMessageNoopCache: IMPendingMessageCache {
    static let shared = IMPendingMessageNoopCache()
    func pending(scopeId: String, conversationId: String) -> [IMPendingMessage] { [] }
    func store(scopeId: String, conversationId: String, pending: [IMPendingMessage]) {}
    func clear(scopeId: String, conversationId: String) {}
}

@MainActor
final class IMPinnedMessageMemoryCache: IMPinnedMessageSnapshotCache {
    static let shared = IMPinnedMessageMemoryCache()

    private var snapshots: [String: [IMMessage]] = [:]

    func pinnedMessages(conversationId: String) -> [IMMessage] {
        snapshots[conversationId] ?? []
    }

    func storePinnedMessages(conversationId: String, messages: [IMMessage]) {
        snapshots[conversationId] = messages
            .filter { $0.conversationId == conversationId && !$0.isDeleted }
            .sorted { $0.seq > $1.seq }
    }

    func clearAll() {
        snapshots.removeAll()
    }
}

@MainActor
final class IMPinnedMessageCompositeCache: IMPinnedMessageSnapshotCache {
    private let caches: [IMPinnedMessageSnapshotCache]

    init(_ caches: [IMPinnedMessageSnapshotCache]) {
        self.caches = caches
    }

    func pinnedMessages(conversationId: String) -> [IMMessage] {
        for cache in caches {
            let messages = cache.pinnedMessages(conversationId: conversationId)
            if !messages.isEmpty { return messages }
        }
        return []
    }

    func storePinnedMessages(conversationId: String, messages: [IMMessage]) {
        caches.forEach { $0.storePinnedMessages(conversationId: conversationId, messages: messages) }
    }
}

@MainActor
final class IMMessageMemoryCache: IMMessageSnapshotCache {
    static let shared = IMMessageMemoryCache()

    private let maxMessages: Int
    private var snapshots: [String: [IMMessage]] = [:]

    init(maxMessages: Int = 100) {
        self.maxMessages = max(maxMessages, 1)
    }

    func messages(conversationId: String) -> [IMMessage] {
        snapshots[conversationId] ?? []
    }

    func store(conversationId: String, messages: [IMMessage]) {
        let visible = imChronologicallySortedMessages(
            messages.filter { $0.conversationId == conversationId }
        )
        snapshots[conversationId] = Array(visible.suffix(maxMessages))
    }

    func clear(conversationId: String) {
        snapshots.removeValue(forKey: conversationId)
    }

    func clearAll() {
        snapshots.removeAll()
    }
}

fileprivate final class IMMessageFileSnapshotIO: @unchecked Sendable {
    static let shared = IMMessageFileSnapshotIO()

    private let queue = DispatchQueue(label: "com.tabtin.mobile.im-message-snapshot-cache")

    func write(messages: [CachedIMMessage], to url: URL) {
        queue.async {
            do {
                let data = try JSONEncoder().encode(messages)
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try data.write(to: url, options: [.atomic])
            } catch {
                // 快照缓存是性能优化，不影响权威历史；写失败静默降级到网络 / 内存缓存。
            }
        }
    }

    func remove(_ url: URL) {
        queue.async {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

@MainActor
final class IMMessageFileSnapshotCache: IMMessageSnapshotCache {
    static let shared = IMMessageFileSnapshotCache()

    private let maxMessages: Int
    private let directoryURL: URL
    private let decoder = JSONDecoder()
    private let io: IMMessageFileSnapshotIO

    init(
        maxMessages: Int = 100,
        directoryURL: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("IMMessageSnapshots", isDirectory: true)
            ?? URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("IMMessageSnapshots", isDirectory: true)
    ) {
        self.maxMessages = max(maxMessages, 1)
        self.directoryURL = directoryURL
        self.io = .shared
    }

    func messages(conversationId: String) -> [IMMessage] {
        guard let data = try? Data(contentsOf: fileURL(conversationId: conversationId)) else { return [] }
        return Self.decodeMessages(
            data: data,
            conversationId: conversationId,
            maxMessages: maxMessages,
            decoder: decoder
        )
    }

    func messagesAsync(conversationId: String) async -> [IMMessage] {
        let maxMessages = maxMessages
        let url = fileURL(conversationId: conversationId)
        return await Task.detached(priority: .userInitiated) {
            guard let data = try? Data(contentsOf: url) else { return [] }
            return Self.decodeMessages(
                data: data,
                conversationId: conversationId,
                maxMessages: maxMessages,
                decoder: JSONDecoder()
            )
        }.value
    }

    func store(conversationId: String, messages: [IMMessage]) {
        let cached = imChronologicallySortedMessages(
            messages.filter { $0.conversationId == conversationId }
        )
            .suffix(maxMessages)
            .map(CachedIMMessage.init(message:))
        io.write(messages: cached, to: fileURL(conversationId: conversationId))
    }

    func clear(conversationId: String) {
        io.remove(fileURL(conversationId: conversationId))
    }

    private func fileURL(conversationId: String) -> URL {
        let encoded = Data(conversationId.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
        return directoryURL.appendingPathComponent(encoded).appendingPathExtension("json")
    }

    nonisolated private static func decodeMessages(
        data: Data,
        conversationId: String,
        maxMessages: Int,
        decoder: JSONDecoder
    ) -> [IMMessage] {
        if let cached = try? decoder.decode([CachedIMMessage].self, from: data) {
            return Array(imChronologicallySortedMessages(
                cached.compactMap { $0.message }
                    .filter { $0.conversationId == conversationId }
            ).suffix(maxMessages))
        }
        return []
    }
}

@MainActor
final class IMMessageCompositeCache: IMMessageSnapshotCache {
    private let caches: [IMMessageSnapshotCache]

    init(_ caches: [IMMessageSnapshotCache]) {
        self.caches = caches
    }

    func messages(conversationId: String) -> [IMMessage] {
        for cache in caches {
            let messages = cache.messages(conversationId: conversationId)
            if !messages.isEmpty { return messages }
        }
        return []
    }

    func store(conversationId: String, messages: [IMMessage]) {
        caches.forEach { $0.store(conversationId: conversationId, messages: messages) }
    }

    func clear(conversationId: String) {
        caches.forEach { $0.clear(conversationId: conversationId) }
    }
}

struct CachedIMMessage: Codable, Sendable {
    let id: Int
    let seq: Int
    let conversationId: String
    let senderId: String
    let senderType: String
    let senderName: String
    let content: String
    let messageType: Int
    let replyToId: Int?
    let replyToPreview: CachedIMReplyPreview?
    let hasAttachment: Bool
    let metadata: CachedIMMessageMetadata?
    let createdAt: String?
    let isDeleted: Bool
    let editedAt: String?
    let isPinned: Bool
    let reactions: [String: [String]]
    let reactionOrder: [String]?
    let readReceipt: CachedIMReadReceipt?

    init(message: IMMessage) {
        id = message.id
        seq = message.seq
        conversationId = message.conversationId
        senderId = message.senderId
        senderType = message.senderType
        senderName = message.senderName
        content = message.content
        messageType = message.messageType
        replyToId = message.replyToId
        replyToPreview = message.replyToPreview.map(CachedIMReplyPreview.init(preview:))
        hasAttachment = message.hasAttachment
        metadata = message.metadata.map(CachedIMMessageMetadata.init(metadata:))
        createdAt = message.createdAt
        isDeleted = message.isDeleted
        editedAt = message.editedAt
        isPinned = message.isPinned
        reactions = message.reactions
        reactionOrder = message.reactionOrder
        readReceipt = message.readReceipt.map(CachedIMReadReceipt.init(receipt:))
    }

    var message: IMMessage {
        IMMessage(
            id: id,
            seq: seq,
            conversationId: conversationId,
            senderId: senderId,
            senderType: senderType,
            senderName: senderName,
            content: content,
            messageType: messageType,
            replyToId: replyToId,
            replyToPreview: replyToPreview?.preview,
            hasAttachment: hasAttachment,
            metadata: metadata?.metadata,
            createdAt: createdAt,
            isDeleted: isDeleted,
            editedAt: editedAt,
            isPinned: isPinned,
            reactions: reactions,
            reactionOrder: reactionOrder ?? Array(reactions.keys),
            readReceipt: readReceipt?.receipt
        )
    }
}

struct CachedIMReplyPreview: Codable, Sendable {
    let content: String
    let senderId: String
    let isUnavailable: Bool
    let messageType: Int
    let hasAttachment: Bool
    let fileName: String

    init(preview: IMReplyPreview) {
        content = preview.content
        senderId = preview.senderId
        isUnavailable = preview.isUnavailable
        messageType = preview.messageType
        hasAttachment = preview.hasAttachment
        fileName = preview.fileName
    }

    var preview: IMReplyPreview {
        IMReplyPreview(
            content: content,
            senderId: senderId,
            isUnavailable: isUnavailable,
            messageType: messageType,
            hasAttachment: hasAttachment,
            fileName: fileName
        )
    }
}

struct CachedIMReadReceipt: Codable, Sendable {
    let readCount: Int
    let recipientCount: Int

    init(receipt: IMReadReceipt) {
        readCount = receipt.readCount
        recipientCount = receipt.recipientCount
    }

    var receipt: IMReadReceipt { IMReadReceipt(readCount: readCount, recipientCount: recipientCount) }
}

struct CachedIMMessageMetadata: Codable, Sendable {
    let clientRequestId: String?
    let messageRef: String?
    let kind: String?
    let tabtinMessageId: String?
    let agentSessionRef: String?
    let mentionedUserIds: [String]?
    let mentionedAgentIds: [String]?
    let mentionAll: Bool?
    let forwardedFrom: IMForwardedFrom?
    let fileId: String?
    let fileName: String?
    let fileSize: Int?
    let fileType: String?
    let downloadURL: String?
    let accessURL: String?
    let cdnURL: String?
    let url: String?
    let card: IMResourceCard?
    let cardType: String?
    let hasCardPayload: Bool

    init(metadata: IMMessageMetadata) {
        clientRequestId = metadata.clientRequestId
        messageRef = metadata.messageRef
        kind = metadata.kind
        tabtinMessageId = metadata.tabtinMessageId
        agentSessionRef = metadata.agentSessionRef
        mentionedUserIds = metadata.mentionedUserIds
        mentionedAgentIds = metadata.mentionedAgentIds
        mentionAll = metadata.mentionAll
        forwardedFrom = metadata.forwardedFrom
        fileId = metadata.fileId
        fileName = metadata.fileName
        fileSize = metadata.fileSize
        fileType = metadata.fileType
        downloadURL = metadata.downloadURL
        accessURL = metadata.accessURL
        cdnURL = metadata.cdnURL
        url = metadata.url
        card = metadata.card
        cardType = metadata.cardType
        hasCardPayload = metadata.hasCardPayload
    }

    var metadata: IMMessageMetadata {
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
}

@MainActor
final class IMMessageNoopCache: IMMessageSnapshotCache, IMPinnedMessageSnapshotCache {
    static let shared = IMMessageNoopCache()
    func messages(conversationId: String) -> [IMMessage] { [] }
    func store(conversationId: String, messages: [IMMessage]) {}
    func clear(conversationId: String) {}
    func pinnedMessages(conversationId: String) -> [IMMessage] { [] }
    func storePinnedMessages(conversationId: String, messages: [IMMessage]) {}
}

/// 一次发送尝试的结果，供 composer 决定是否清理输入 / 收敛附件用量。
/// - `enqueued`：已创建独立 pending，传输在后台按提交顺序执行；composer 可立即清理。
/// - `succeeded`：服务端返回稳定消息位置，可收敛附件 upload-stage 用量。
/// - `failedPending`：已乐观入队但网络失败（保留为可重试 pending），可清理 composer，但**不**收敛用量（留给重试）。
/// - `rejectedInFlight`：同一失败消息已经在重试，不能重复排队。
/// - `rejectedTooLong`：正文超过服务端消息契约，什么都没入队，保留 composer 让用户删减。
enum IMSendOutcome: Sendable, Equatable {
    case enqueued
    case succeeded
    case failedPending
    /// 清空记录期间完成的旧发送已不再保留为本地 pending，结果由安全重拉收敛。
    case discardedAfterClear
    case rejectedInFlight
    case rejectedTooLong
    case rejectedReadOnly

    /// 内容是否已进入发送管线（成功或已入队为 pending）——据此判断可否清理 composer。
    var didEnqueue: Bool {
        self != .rejectedInFlight && self != .rejectedTooLong && self != .rejectedReadOnly
    }
}

/// 单会话消息流的 REST 传输面，抽成协议以便 store 单测注入假实现（不打真网络）。
protocol IMMessageTransport: Sendable {
    /// 系统已明确离线时跳过传输层排队，让 pending 立即进入可重试失败态。
    var isSendAvailable: Bool { get }

    @MainActor
    func setRealtimeListener(conversationId: String, listener: (@MainActor @Sendable (IMMessage) -> Void)?)
    /// 拉历史：`before` 为消息 id 游标（向上翻页），返回按 seq 升序。
    func fetchMessages(conversationId: String, before: Int?, limit: Int) async throws -> [IMMessage]
    /// 当前用户的个人历史清空水位。必须在订阅共享实时通道前获取。
    func fetchHistoryClearedSeq(conversationId: String) async throws -> Int
    /// 发消息：`clientRequestId` 为幂等键（乐观发送必带）；
    /// `mentionedUserIds` / `mentionedAgentIds` 分别写入 metadata，后者会触发后端 @Agent 回复。
    /// 返回轻量结果（后端只回 id/seq/created_at）；完整消息由 store 据本地字段补齐、实时回声覆盖。
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
    ) async throws -> IMSendMessageResult

    /// 富卡仍是 TEXT + metadata.card。作为独立重载保留，既能让生产传输写出卡片，也让旧的测试
    /// fake transport 通过默认实现继续只关心基础发送路径。
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
    ) async throws -> IMSendMessageResult

    /// 编辑消息（仅本人文本）：返回服务端更新后的完整消息。
    func editMessage(conversationId: String, messageId: Int, content: String) async throws -> IMMessage
    /// 撤回消息（软删，2 分钟内、仅本人）。
    func recallMessage(conversationId: String, messageId: Int) async throws
    /// 添加表情回应。
    func addReaction(conversationId: String, messageId: Int, emoji: String) async throws
    /// 取消表情回应。
    func removeReaction(conversationId: String, messageId: Int, emoji: String) async throws
    /// 标记已读到可见消息 seq；返回数据面实际成功清理的权威水位。
    func markRead(conversationId: String, visibleMessage: IMMessage) async throws -> Int
    /// 查询群消息已读 / 未读成员明细。
    func fetchReadReceipts(conversationId: String, messageId: Int) async throws -> IMMessageReadReceipts
    /// 查询当前会话完整置顶消息列表，按 seq 降序返回。
    func fetchPinnedMessages(conversationId: String) async throws -> [IMMessage]
    /// 设置群消息置顶状态。
    func pinMessage(conversationId: String, messageId: Int, pinned: Bool) async throws
    /// 清除当前账号在该会话中的个人历史。
    func clearHistory(conversationId: String) async throws
    /// 清除个人历史并返回服务端实际建立的权威水位。
    func clearHistoryAndFetchWatermark(conversationId: String) async throws -> Int
    /// 当前账号退出会话。
    func leaveConversation(conversationId: String) async throws
    /// 转发仍通过同一消息数据面发送一条新消息。
    func forwardMessage(
        _ message: IMMessage,
        sourceConversationName: String,
        to conversationId: String,
        clientRequestId: String
    ) async throws -> IMSendMessageResult
}

/// Phase E 新增的传输方法给默认「未实现」实现，让既有仅关心发送/拉历史的假传输无需改动即可编译。
enum IMTransportError: Error { case unsupported }

/// 将历史消息链路的底层错误收敛为可行动、可本地化的页面文案。
///
/// 网络错误使用已有提示；其余错误由统一 API 契约收敛，避免 Store 识别 Provider 错误码。
enum IMHistoryErrorPresentation {
    static func message(for error: Error) -> String {
        if let urlError = urlError(from: error) {
            switch urlError.code {
            case .notConnectedToInternet,
                 .timedOut,
                 .networkConnectionLost,
                 .cannotConnectToHost,
                 .cannotFindHost,
                 .secureConnectionFailed:
                return L10n.Messages.networkError
            default:
                return L10n.Messages.historyTransportError(code: urlError.code.rawValue)
            }
        }

        return L10n.Messages.historyLoadFailed
    }

    private static func urlError(from error: Error) -> URLError? {
        if let urlError = error as? URLError {
            return urlError
        }
        guard let apiError = error as? APIError else { return nil }
        guard case let .networkError(underlyingError) = apiError else { return nil }
        return urlError(from: underlyingError)
    }
}

extension IMMessageTransport {
    var isSendAvailable: Bool { true }

    @MainActor
    func setRealtimeListener(conversationId: String, listener: (@MainActor @Sendable (IMMessage) -> Void)?) {}
    func fetchHistoryClearedSeq(conversationId: String) async throws -> Int { throw IMTransportError.unsupported }
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
        // 旧 fake transport 不需要认识富卡；真实 API transport 覆盖此协议要求来写 metadata.card。
        try await sendMessage(
            conversationId: conversationId,
            content: content,
            messageType: messageType,
            replyToId: replyToId,
            mentionedUserIds: mentionedUserIds,
            mentionedAgentIds: mentionedAgentIds,
            mentionAll: mentionAll,
            attachment: attachment,
            clientRequestId: clientRequestId
        )
    }
    func editMessage(conversationId: String, messageId: Int, content: String) async throws -> IMMessage {
        throw IMTransportError.unsupported
    }
    func recallMessage(conversationId: String, messageId: Int) async throws { throw IMTransportError.unsupported }
    func addReaction(conversationId: String, messageId: Int, emoji: String) async throws { throw IMTransportError.unsupported }
    func removeReaction(conversationId: String, messageId: Int, emoji: String) async throws { throw IMTransportError.unsupported }
    func markRead(conversationId: String, visibleMessage: IMMessage) async throws -> Int {
        throw IMTransportError.unsupported
    }
    func fetchReadReceipts(conversationId: String, messageId: Int) async throws -> IMMessageReadReceipts {
        throw IMTransportError.unsupported
    }
    func fetchPinnedMessages(conversationId: String) async throws -> [IMMessage] {
        throw IMTransportError.unsupported
    }
    func pinMessage(conversationId: String, messageId: Int, pinned: Bool) async throws { throw IMTransportError.unsupported }
    func clearHistory(conversationId: String) async throws { throw IMTransportError.unsupported }
    func clearHistoryAndFetchWatermark(conversationId: String) async throws -> Int {
        try await clearHistory(conversationId: conversationId)
        return 0
    }
    func leaveConversation(conversationId: String) async throws { throw IMTransportError.unsupported }
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
                fileType: message.metadata?.fileType ?? "",
                remoteURL: message.metadata?.accessURL
                    ?? message.metadata?.downloadURL
                    ?? message.metadata?.cdnURL
                    ?? message.metadata?.url
            )
        }
        return try await sendMessage(
            conversationId: conversationId,
            content: message.content,
            messageType: message.messageType,
            replyToId: nil,
            mentionedUserIds: [],
            mentionedAgentIds: [],
            mentionAll: false,
            attachment: attachment,
            card: message.forwardableCard,
            clientRequestId: clientRequestId
        )
    }
}

/// 乐观发送中的消息（尚未拿到服务端 id/seq）。以 `clientRequestId` 为幂等键，
/// 服务端返回或实时回声到达后据此收敛。
struct IMPendingMessage: Codable, Identifiable, Sendable, Equatable {
    enum Status: String, Codable, Sendable, Equatable {
        case sending
        case failed
    }

    let clientRequestId: String
    let content: String
    let messageType: Int
    let replyToId: Int?
    /// @ 人和 Agent 列表：重试时随原 pending 复用，保证幂等重发不丢 mention 语义。
    let mentionedUserIds: [String]
    let mentionedAgentIds: [String]
    let mentionAll: Bool
    let attachment: IMOutgoingAttachment?
    /// 富卡与附件一样必须留在 pending 中，才能在失败重试、POST 乐观确认中保持语义。
    let card: IMOutgoingCard?
    var createdAt: Date
    var errorMessage: String?
    var status: Status

    var id: String { clientRequestId }
}

struct IMOutgoingAttachment: Codable, Sendable, Equatable {
    let fileId: String
    let fileName: String
    let fileSize: Int
    let fileType: String
    let remoteURL: String?

    init(
        fileId: String,
        fileName: String,
        fileSize: Int,
        fileType: String,
        remoteURL: String? = nil
    ) {
        self.fileId = fileId
        self.fileName = fileName
        self.fileSize = fileSize
        self.fileType = fileType
        self.remoteURL = remoteURL
    }
}

/// 单会话消息流 store（Phase B）。
///
/// 职责：历史分页、乐观发送（幂等键去重）、实时消息合并、重连对账。消息按 `seq` 升序维护；
/// 服务端 POST 响应与 `chat:{conv}` 实时回声用消息 id 去重、用 `client_request_id` 收敛乐观态，
/// 因此「自己发的消息」两条路径到达都只留一条。本地持久缓存由 SwiftData 承载。
@MainActor
@Observable
final class IMMessageStore {
    let conversationId: String

    /// 已确认消息，按 seq 升序。
    private(set) var messages: [IMMessage] = [] {
        didSet {
            refreshPeerReadWaterline()
            let persistentMessages = messages.filter { $0.id > 0 }
            if persistentMessages.isEmpty {
                snapshotCache.clear(conversationId: conversationId)
            } else if canPersistSnapshot {
                snapshotCache.store(conversationId: conversationId, messages: persistentMessages)
            }
        }
    }
    /// 服务端返回的完整置顶列表，独立于当前已加载的历史页，按 seq 降序。
    private(set) var pinnedMessages: [IMMessage] = []
    /// 乐观发送中/失败的消息（UI 追加在已确认消息之后展示）。
    private(set) var pending: [IMPendingMessage] = []
    private(set) var isLoadingHistory = false
    /// 首次历史请求已经得到成功或失败结果。与 `isLoadingHistory` 分开建模：进入会话后还要先
    /// 建立个人清空水位，此时请求尚未启动，但 UI 也不能把暂时的空数组误判成“没有消息”。
    private(set) var hasCompletedInitialHistoryLoad = false
    /// 初始化时确实读到了上一轮完整快照；冷进入期间实时层先投递的“最新一条”不算快照。
    private(set) var hasCachedHistorySnapshot = false
    var isInitialHistoryRenderable: Bool {
        hasCachedHistorySnapshot || hasCompletedInitialHistoryLoad
    }
    private(set) var hasMoreHistory = true
    private(set) var historyError: String?
    /// 订阅确认落在首屏历史请求中时，请求收尾后再补一次最新页。
    private var latestRefreshPending = false
    /// 前插更早历史令牌：翻页成功后自增，UIKit 滚动层据此补偏移保持锚点不跳位。
    private(set) var earlierPrependToken = 0
    /// 对端已读水位（其他人 lastReadSeq 的最大值）；变化时刷新「已读」页脚。
    private(set) var peerReadWaterline = 0

    /// 是否存在传输中的消息；仅用于诊断观测，不再阻止继续提交下一条。
    private(set) var isSending = false
    private var activeSendAttemptCount = 0
    private var sendTail: Task<Void, Never>?

    /// 对端正在输入的 userId 集合（已排除本人；每人 3.5s 无新 typing 事件自动清除）。
    private(set) var typingUserIds: Set<String> = []
    /// handoff_id → 实时刷新版本；卡片以此为 task id 重拉独立交接包。
    private(set) var handoffVersions: [String: Int] = [:]
    /// share_id → 实时刷新版本；同时用于让卡片树重建并重拉权威详情。
    private(set) var sessionShareVersions: [String: Int] = [:]
    /// 会话资料 / 成员事件版本；详情页据此重拉权威会话快照。
    private(set) var conversationRevision = 0

    /// 当前登录用户 id：reaction 归属、typing 过滤、DM 已读「对端」判定用；由会话屏在 activate 注入。
    var currentUserId: String? {
        didSet { refreshPeerReadWaterline() }
    }

    private let transport: IMMessageTransport
    private let pageSize: Int
    private let snapshotCache: IMMessageSnapshotCache
    private let pinnedSnapshotCache: IMPinnedMessageSnapshotCache
    private let readStateCache: IMReadStateCache?
    private let pendingCache: IMPendingMessageCache
    private let cacheScopeId: String
    /// pending 同步落地后立即推进目录 subtitle，覆盖“发送后马上返回列表”的网络确认空窗。
    private let onMessageEnqueued: ((String) -> Void)?
    /// 服务端确认发送后，把完整消息交给目录层推进 subtitle；不依赖发送者收到 personal 回声。
    private let onMessageConfirmed: ((IMMessage) -> Void)?
    /// 冷进入的首批历史完成前，不把实时层提前投递的单条 latest 写成“完整缓存”。
    private var canPersistSnapshot = false
    /// 权威完整置顶列表一旦返回，迟到的磁盘快照不得再覆盖它。
    private var hasCompletedPinnedRefresh = false
    /// 置顶刷新代次：清空历史或发起更新刷新后，旧请求不得再把清空前的置顶写回。
    private var pinnedRefreshGeneration = 0
    /// 离开会话时释放被放弃的 pending 附件 upload-stage FileUsage（避免 OSS 资源泄漏，）。
    /// 由会话屏在构造时注入；实际 deactivate 侧写在屏上，store 只负责枚举待释放附件（便于单测）。
    private let onReleaseAbandonedAttachment: ((IMOutgoingAttachment) -> Void)?
    private let now: () -> Date
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "IMMessageStore")
    /// 详情与列表到达顺序不固定；保留详情的成员快照，与全局目录共同参与发送门禁。
    private var conversationDetailSnapshot: IMConversationDetail?

    /// userId → 其已读到的最大 seq（`im.read.receipt` 累积），DM 已读勾用。
    private var readSeqByUser: [String: Int] = [:]
    /// 每个 typing 用户的过期清除任务。
    private var typingExpiry: [String: Task<Void, Never>] = [:]
    /// 发送后一次性 latest 对账任务；连续发送只保留最后一次。
    private var postSendReceiptReconcileTask: Task<Void, Never>?
    /// 已提交请求的最大可见 seq，避免同一水位重复打 read 端点。
    private var lastMarkedReadSequence = 0

    /// 加载代次：只有最新一代允许写状态，避免翻页与刷新交错覆盖。
    private var loadGeneration = 0
    /// 个人清空记录的代次：发送在途时若发生变化，返回结果不得绕过服务端的可见性过滤写回本地。
    private var historyClearGeneration = 0
    /// 最近一次服务端确认的个人清空水位。共享实时通道可能在清空后才投递旧事件，
    /// 必须在合并前按该水位丢弃。
    private var historyClearedSeq = 0
    /// message_ref → 已应用的最大流式序号；进程内去重即可，最终消息仍由历史接口持久化。
    private var agentStreamSequenceByRef: [String: Int] = [:]
    /// 已收到 final/error 的 message_ref；阻止 Centrifugo 重连窗口中的迟到增量复活临时态。
    private var closedAgentMessageRefs: Set<String> = []
    /// 附件 upload-stage usage 的唯一所有权，以发送请求 id 跟踪，不能由展示用 pending 决定。
    /// 实时回声会先移除 pending，但 HTTP 发送请求仍可能尚未返回。
    private var trackedUploadStageAttachments: [String: IMOutgoingAttachment] = [:]

    init(
        conversationId: String,
        transport: IMMessageTransport = DjangoIMAdapter.shared,
        pageSize: Int = 30,
        snapshotCache: IMMessageSnapshotCache = IMMessageNoopCache.shared,
        initialSnapshotCache: IMMessageSnapshotCache? = nil,
        pinnedSnapshotCache: IMPinnedMessageSnapshotCache = IMMessageNoopCache.shared,
        initialPinnedSnapshotCache: IMPinnedMessageSnapshotCache? = nil,
        readStateCache: IMReadStateCache? = nil,
        pendingCache: IMPendingMessageCache = IMPendingMessageNoopCache.shared,
        cacheScopeId: String = "anonymous",
        onMessageEnqueued: ((String) -> Void)? = nil,
        onMessageConfirmed: ((IMMessage) -> Void)? = nil,
        onReleaseAbandonedAttachment: ((IMOutgoingAttachment) -> Void)? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.conversationId = conversationId
        self.transport = transport
        self.pageSize = pageSize
        self.snapshotCache = snapshotCache
        self.pinnedSnapshotCache = pinnedSnapshotCache
        self.readStateCache = readStateCache
        self.pendingCache = pendingCache
        self.cacheScopeId = cacheScopeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "anonymous"
            : cacheScopeId
        self.onMessageEnqueued = onMessageEnqueued
        self.onMessageConfirmed = onMessageConfirmed
        self.onReleaseAbandonedAttachment = onReleaseAbandonedAttachment
        self.now = now
        let cachedMessages = (initialSnapshotCache ?? snapshotCache).messages(conversationId: conversationId)
        self.messages = imChronologicallySortedMessages(cachedMessages)
        self.pinnedMessages = (initialPinnedSnapshotCache ?? pinnedSnapshotCache)
            .pinnedMessages(conversationId: conversationId)
            .sorted { $0.seq > $1.seq }
        self.hasCachedHistorySnapshot = !cachedMessages.isEmpty
        self.canPersistSnapshot = !cachedMessages.isEmpty
        self.pending = pendingCache.pending(scopeId: self.cacheScopeId, conversationId: conversationId)
        self.trackedUploadStageAttachments = Dictionary(uniqueKeysWithValues: self.pending.compactMap { item in
            item.attachment.map { (item.clientRequestId, $0) }
        })
    }

    func hydrateSnapshotIfNeeded(_ cachedMessages: [IMMessage]) {
        guard !cachedMessages.isEmpty,
              !hasCachedHistorySnapshot,
              !hasCompletedInitialHistoryLoad else { return }
        hasCachedHistorySnapshot = true
        canPersistSnapshot = true
        mergeConfirmed(cachedMessages)
    }

    func updateConversationDetail(_ detail: IMConversationDetail?) {
        guard detail?.id == conversationId || detail == nil else { return }
        conversationDetailSnapshot = detail
    }

    /// 冷启动从数据库恢复完整置顶快照；权威刷新已经完成后不允许旧缓存回写。
    func hydratePinnedSnapshotIfNeeded(_ cachedMessages: [IMMessage]) {
        guard !cachedMessages.isEmpty,
              pinnedMessages.isEmpty,
              !hasCompletedPinnedRefresh else { return }
        updatePinnedMessages(cachedMessages
            .filter { $0.conversationId == conversationId && !$0.isDeleted }
            .map { message in
                var pinned = message
                pinned.isPinned = true
                pinned.pinStateKnown = true
                return pinned
            }
            .sorted { $0.seq > $1.seq })
    }

    /// 冷启动从数据库恢复实时已读水位。与当前进程已经收到的回执取 max，绝不回退。
    func hydrateReadState(_ cachedWaterlines: [String: Int]) {
        for (readerId, seq) in cachedWaterlines where seq > (readSeqByUser[readerId] ?? 0) {
            readSeqByUser[readerId] = seq
        }
        refreshPeerReadWaterline()
    }

    private func replaceMessage(at index: Int, with message: IMMessage) {
        guard messages.indices.contains(index) else { return }
        var updated = messages
        updated[index] = message
        messages = resolveLoadedReplyPreviews(updated)
    }

    /// 离开会话或清空记录时调用：释放仍由本次发送拥有的附件 upload-stage FileUsage。
    /// 所有权按 request id 独立跟踪，因此实时回声先移除展示用 pending 也不会漏释放。
    func releaseAbandonedPendingAttachments() {
        let requestIds = Array(trackedUploadStageAttachments.keys)
        for requestId in requestIds {
            releaseTrackedUploadStageAttachment(clientRequestId: requestId)
        }
    }

    // MARK: - 历史加载

    /// 首屏加载：订阅已建立后，合并加载期间抵达的实时消息，不能用 REST 快照覆盖它们。
    func loadInitial() {
        Task {
            async let history: Void = loadHistory(
                reset: true,
                preservingCurrentMessages: true,
                marksInitialHistoryComplete: true
            )
            async let pinned: Void = refreshPinnedMessages()
            _ = await (history, pinned)
        }
    }

    /// 会话详情恢复活跃时静默补拉最新页。会话目录有时已更新 lastMessage，
    /// 但详情 listener 未及时投递到当前 store；这里只做 merge，不清空现有消息，也不展示加载态。
    func refreshLatest() {
        guard !isLoadingHistory else {
            latestRefreshPending = true
            return
        }
        Task { await refreshLatestNow() }
    }

    /// 供回归测试 await 的补拉入口。
    func refreshLatestNow() async {
        if isLoadingHistory {
            latestRefreshPending = true
        } else {
            latestRefreshPending = false
            await loadHistory(
                reset: true,
                preservingCurrentMessages: true,
                showsLoading: false,
                updatesHistoryAvailability: false
            )
        }
        await refreshPinnedMessages()
    }

    /// 完整置顶列表不依赖历史分页；失败时保留现有快照，避免网络抖动让顶部瞬间消失。
    func refreshPinnedMessages() async {
        pinnedRefreshGeneration += 1
        let generation = pinnedRefreshGeneration
        do {
            let snapshot = try await transport.fetchPinnedMessages(conversationId: conversationId)
            guard generation == pinnedRefreshGeneration else { return }
            hasCompletedPinnedRefresh = true
            applyPinnedSnapshot(snapshot)
        } catch IMTransportError.unsupported {
            // 旧测试传输没有完整置顶能力时，沿用当前消息页的已知状态。
        } catch {
            logger.warning("load pinned messages failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// 在订阅共享实时通道前建立个人历史可见性水位。失败时调用方须保持未订阅，
    /// 以免在未知水位下渲染延迟的旧事件。
    func initializeHistoryVisibility() async -> Bool {
        do {
            historyClearedSeq = max(historyClearedSeq, try await transport.fetchHistoryClearedSeq(conversationId: conversationId))
            return true
        } catch is CancellationError {
            return false
        } catch {
            historyError = IMHistoryErrorPresentation.message(for: error)
            logger.error("load history visibility failed conv=\(self.conversationId, privacy: .public): \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// 清空个人记录后的重拉。保留请求期间抵达的新实时消息，再以服务端的可见历史合并收敛。
    func reloadHistoryAfterClear() {
        Task { await loadHistoryAfterClear() }
    }

    /// 供清空时序和回归测试 await 的专用重拉入口。
    func loadHistoryAfterClear() async {
        await loadHistory(reset: true, preservingCurrentMessages: true)
    }

    /// 向上翻页（拉更早的消息）。
    func loadMore() {
        Task { await loadHistory(reset: false) }
    }

    /// 服务端清空个人历史成功后的本地同步。
    func clearLocalHistory(clearedThroughSeq: Int) {
        loadGeneration += 1
        historyClearGeneration += 1
        pinnedRefreshGeneration += 1
        historyClearedSeq = max(historyClearedSeq, clearedThroughSeq)
        messages = []
        hasCompletedPinnedRefresh = true
        updatePinnedMessages([])
        readSeqByUser.removeAll()
        peerReadWaterline = 0
        readStateCache?.clearReadState(scopeId: cacheScopeId, conversationId: conversationId)
        // 清空后不会再展示或重试这些 pending。无论已失败还是仍在途，附件的 upload-stage
        // usage 都必须立即释放；后续在途请求只可由安全重拉收敛，不能复活本地消息。
        releaseAbandonedPendingAttachments()
        pending = []
        pendingCache.clear(scopeId: cacheScopeId, conversationId: conversationId)
        isLoadingHistory = false
        hasCompletedInitialHistoryLoad = true
        hasMoreHistory = false
        historyError = nil
        latestRefreshPending = false
    }

    /// 启动阶段（目录、登录或实时会话建立）失败时也必须结束首屏 loading。
    /// 否则历史请求尚未开始，UI 会把空消息列表永久呈现为 ProgressView。
    func markInitialHistoryFailed(_ error: Error) {
        loadGeneration += 1
        isLoadingHistory = false
        historyError = IMHistoryErrorPresentation.message(for: error)
        hasCompletedInitialHistoryLoad = true
        canPersistSnapshot = true
    }

    /// 历史加载核心（可 await，供下拉刷新与测试）。`reset=true` 清空重拉，否则以最早消息为游标向上翻。
    func loadHistory(reset: Bool) async {
        await loadHistory(reset: reset, preservingCurrentMessages: false)
    }

    private func loadHistory(
        reset: Bool,
        preservingCurrentMessages: Bool,
        showsLoading: Bool = true,
        marksInitialHistoryComplete: Bool = false,
        updatesHistoryAvailability: Bool = true
    ) async {
        if reset {
            if updatesHistoryAvailability { hasMoreHistory = true }
        } else if !hasMoreHistory || isLoadingHistory {
            return
        }
        let before: Int? = reset ? nil : messages.first?.id
        loadGeneration += 1
        let generation = loadGeneration
        if showsLoading { isLoadingHistory = true }
        historyError = nil
        defer {
            if generation == loadGeneration {
                if showsLoading { isLoadingHistory = false }
                if marksInitialHistoryComplete {
                    hasCompletedInitialHistoryLoad = true
                    canPersistSnapshot = true
                    if !messages.isEmpty {
                        snapshotCache.store(conversationId: conversationId, messages: messages)
                    }
                }
                if latestRefreshPending {
                    latestRefreshPending = false
                    Task { await self.refreshLatestNow() }
                }
            }
        }
        do {
            let fetched = try await transport.fetchMessages(
                conversationId: conversationId,
                before: before,
                limit: pageSize + 1
            )
            guard generation == loadGeneration else { return }
            let orderedFetched = imChronologicallySortedMessages(fetched)
            let visiblePage = orderedFetched.count > pageSize
                ? Array(orderedFetched.suffix(pageSize))
                : orderedFetched
            if reset {
                if !preservingCurrentMessages {
                    messages = []
                }
            } else if !visiblePage.isEmpty {
                earlierPrependToken += 1
            }
            mergeConfirmed(visiblePage)
            if updatesHistoryAvailability {
                hasMoreHistory = orderedFetched.count > pageSize
            }
            logger.info("loaded \(visiblePage.count) messages conv=\(self.conversationId, privacy: .public) more=\(self.hasMoreHistory)")
        } catch is CancellationError {
            return
        } catch {
            guard generation == loadGeneration else { return }
            historyError = IMHistoryErrorPresentation.message(for: error)
            logger.error("load history failed conv=\(self.conversationId, privacy: .public) before=\(String(describing: before), privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - 发送

    /// 乐观发送：先落 pending，再 POST；成功用服务端消息收敛，失败标记 failed 供重试。
    func send(
        content: String,
        messageType: Int = IMMessageType.text.rawValue,
        replyToId: Int? = nil,
        mentionedUserIds: [String] = [],
        mentionedAgentIds: [String] = [],
        mentionAll: Bool = false,
        attachment: IMOutgoingAttachment? = nil,
        card: IMOutgoingCard? = nil
    ) {
        _ = enqueueSend(
            content: content,
            messageType: messageType,
            replyToId: replyToId,
            mentionedUserIds: mentionedUserIds,
            mentionedAgentIds: mentionedAgentIds,
            mentionAll: mentionAll,
            attachment: attachment,
            card: card
        )
    }

    /// 同步创建独立 pending，随后把传输追加到有序任务链；调用方可立即清空 composer。
    @discardableResult
    func enqueueSend(
        content: String,
        messageType: Int = IMMessageType.text.rawValue,
        replyToId: Int? = nil,
        mentionedUserIds: [String] = [],
        mentionedAgentIds: [String] = [],
        mentionAll: Bool = false,
        attachment: IMOutgoingAttachment? = nil,
        card: IMOutgoingCard? = nil,
        clientRequestId: String = UUID().uuidString,
        isRetry: Bool = false
    ) -> IMSendOutcome {
        if let rejected = prepareSend(
            content: content,
            messageType: messageType,
            replyToId: replyToId,
            mentionedUserIds: mentionedUserIds,
            mentionedAgentIds: mentionedAgentIds,
            mentionAll: mentionAll,
            attachment: attachment,
            card: card,
            clientRequestId: clientRequestId,
            isRetry: isRetry
        ) { return rejected }
        let sendHistoryClearGeneration = historyClearGeneration
        beginSendAttempt()
        let previous = sendTail
        let task = Task { @MainActor in
            _ = await previous?.value
            _ = await executePreparedSend(
                content: content,
                messageType: messageType,
                replyToId: replyToId,
                mentionedUserIds: mentionedUserIds,
                mentionedAgentIds: mentionedAgentIds,
                mentionAll: mentionAll,
                attachment: attachment,
                card: card,
                clientRequestId: clientRequestId,
                isRetry: isRetry,
                sendHistoryClearGeneration: sendHistoryClearGeneration
            )
        }
        sendTail = task
        return .enqueued
    }

    /// 发送核心（可 await，供测试）。返回是否成功。
    ///
    /// `clientRequestId` 为幂等键：首发默认生成新 UUID；**重试必须复用原键**——否则「首请求已被
    /// 服务端接受、但客户端因超时/断网未收到响应」时，换新键重发会绕过后端幂等，重复落一条消息。
    ///
    /// 不同首发各自拥有 pending，并按调用顺序进入传输；重试复用原键、原位复位为 sending。
    @discardableResult
    func performSend(
        content: String,
        messageType: Int = IMMessageType.text.rawValue,
        replyToId: Int? = nil,
        mentionedUserIds: [String] = [],
        mentionedAgentIds: [String] = [],
        mentionAll: Bool = false,
        attachment: IMOutgoingAttachment? = nil,
        card: IMOutgoingCard? = nil,
        clientRequestId: String = UUID().uuidString,
        isRetry: Bool = false
    ) async -> IMSendOutcome {
        if let rejected = prepareSend(
            content: content,
            messageType: messageType,
            replyToId: replyToId,
            mentionedUserIds: mentionedUserIds,
            mentionedAgentIds: mentionedAgentIds,
            mentionAll: mentionAll,
            attachment: attachment,
            card: card,
            clientRequestId: clientRequestId,
            isRetry: isRetry
        ) { return rejected }
        let sendHistoryClearGeneration = historyClearGeneration
        beginSendAttempt()
        let previous = sendTail
        let task = Task { @MainActor in
            _ = await previous?.value
            return await executePreparedSend(
                content: content,
                messageType: messageType,
                replyToId: replyToId,
                mentionedUserIds: mentionedUserIds,
                mentionedAgentIds: mentionedAgentIds,
                mentionAll: mentionAll,
                attachment: attachment,
                card: card,
                clientRequestId: clientRequestId,
                isRetry: isRetry,
                sendHistoryClearGeneration: sendHistoryClearGeneration
            )
        }
        sendTail = Task { @MainActor in _ = await task.value }
        return await task.value
    }

    private func prepareSend(
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        card: IMOutgoingCard?,
        clientRequestId: String,
        isRetry: Bool
    ) -> IMSendOutcome? {
        let conversationSnapshot = IMConversationStore.shared.conversations.first { $0.id == conversationId }
        if isIMConversationReadOnly(snapshot: conversationSnapshot, detail: conversationDetailSnapshot) {
            return .rejectedReadOnly
        }
        if messageType == IMMessageType.text.rawValue && !isIMMessageContentWithinLimit(content) {
            return .rejectedTooLong
        }
        if isRetry, pending.contains(where: {
            $0.clientRequestId == clientRequestId && $0.status == .sending
        }) { return .rejectedInFlight }
        upsertPending(
            clientRequestId: clientRequestId,
            content: content,
            messageType: messageType,
            replyToId: replyToId,
            mentionedUserIds: mentionedUserIds,
            mentionedAgentIds: mentionedAgentIds,
            mentionAll: mentionAll,
            attachment: attachment,
            card: card,
            // 重试是同一条本地历史的状态迁移，不应改时间后跳到消息流底部。
            refreshCreatedAt: false
        )
        onMessageEnqueued?(outgoingPreview(
            content: content,
            messageType: messageType,
            attachment: attachment
        ))
        if !transport.isSendAvailable {
            markPendingFailed(clientRequestId: clientRequestId, errorMessage: nil)
            return .failedPending
        }
        return nil
    }

    private func outgoingPreview(
        content: String,
        messageType: Int,
        attachment: IMOutgoingAttachment?
    ) -> String {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if messageType == IMMessageType.image.rawValue { return "图片" }
        if messageType == IMMessageType.file.rawValue || attachment != nil {
            let fileName = attachment?.fileName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return fileName.isEmpty ? "文件" : "文件：\(fileName)"
        }
        return "消息内容不可用"
    }

    private func executePreparedSend(
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        card: IMOutgoingCard?,
        clientRequestId: String,
        isRetry: Bool,
        sendHistoryClearGeneration: Int
    ) async -> IMSendOutcome {
        defer { endSendAttempt() }
        do {
            let saved = try await transport.sendMessage(
                conversationId: conversationId,
                content: content,
                messageType: messageType,
                replyToId: replyToId,
                mentionedUserIds: mentionedUserIds,
                mentionedAgentIds: mentionedAgentIds,
                mentionAll: mentionAll,
                attachment: attachment,
                card: card,
                clientRequestId: clientRequestId
            )
            guard saved.id > 0, saved.seq > 0, saved.conversationId == conversationId else {
                throw URLError(.badServerResponse)
            }
            let submittedAt = pending.first(where: { $0.clientRequestId == clientRequestId })?.createdAt
            removePending(clientRequestId: clientRequestId)
            if sendHistoryClearGeneration != historyClearGeneration {
                // 这条请求可能在清空水位之前已被服务端写入，也可能在之后完成；不能相信
                // 本地 POST 回包。重拉会按服务端个人可见性过滤，仅保留清空后的消息。
                await loadHistoryAfterClear()
                return .discardedAfterClear
            }
            releaseTrackedUploadStageAttachment(clientRequestId: clientRequestId)
            // 发送回执只带位置时，据本地已知字段补齐完整消息；实时回声随后覆盖。
            let userId = resolvedCurrentUserId()
            let local = IMMessage(
                id: saved.id,
                seq: saved.seq,
                conversationId: conversationId,
                senderId: userId,
                senderName: AuthService.shared.currentUser?.displayName ?? "",
                content: content,
                messageType: messageType,
                replyToId: replyToId,
                replyToPreview: localReplyPreview(replyToId: replyToId),
                hasAttachment: attachment != nil,
                metadata: IMMessageMetadata(
                    clientRequestId: clientRequestId,
                    mentionedUserIds: mentionedUserIds.isEmpty ? nil : mentionedUserIds,
                    mentionedAgentIds: mentionedAgentIds.isEmpty ? nil : mentionedAgentIds,
                    mentionAll: mentionAll ? true : nil,
                    fileId: attachment?.fileId,
                    fileName: attachment?.fileName,
                    fileSize: attachment?.fileSize,
                    fileType: attachment?.fileType,
                    accessURL: attachment?.remoteURL,
                    card: card?.localCard,
                    hasCardPayload: card != nil
                ),
                // 服务端时间精度不足时，本地提交毫秒可稳定区分同秒连续发送。
                createdAt: submittedAt.map(imPreciseTimestampString)
                    ?? saved.createdAt.flatMap { value in
                        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
                    }
            )
            mergeConfirmed([local])
            onMessageConfirmed?(local)
            schedulePostSendReceiptReconcile()
            return .succeeded
        } catch IMConversationSendError.removedMember {
            removePending(clientRequestId: clientRequestId)
            if isRetry {
                releaseTrackedUploadStageAttachment(clientRequestId: clientRequestId)
            } else {
                // 首发被最终门禁拒绝时 composer 仍持有附件；只交还所有权，不撤销其 usage。
                trackedUploadStageAttachments.removeValue(forKey: clientRequestId)
            }
            return .rejectedReadOnly
        } catch {
            if sendHistoryClearGeneration != historyClearGeneration {
                // 清空时已释放该附件的 upload-stage usage，失败结果不能再制造可重试 pending。
                return .discardedAfterClear
            }
            markPendingFailed(clientRequestId: clientRequestId, errorMessage: error.localizedDescription)
            logger.error("send failed: \(String(describing: error), privacy: .public)")
            return .failedPending
        }
    }

    /// 重试一条失败的乐观消息：**复用原 `clientRequestId`** 作幂等键，配合后端幂等，
    /// 保证「首请求已被服务端接受、客户端失败」时重试不会造成重复消息。
    func retry(_ pendingMessage: IMPendingMessage) {
        _ = enqueueSend(
            content: pendingMessage.content,
            messageType: pendingMessage.messageType,
            replyToId: pendingMessage.replyToId,
            mentionedUserIds: pendingMessage.mentionedUserIds,
            mentionedAgentIds: pendingMessage.mentionedAgentIds,
            mentionAll: pendingMessage.mentionAll,
            attachment: pendingMessage.attachment,
            card: pendingMessage.card,
            clientRequestId: pendingMessage.clientRequestId,
            isRetry: true
        )
    }

    private func beginSendAttempt() {
        activeSendAttemptCount += 1
        isSending = true
    }

    private func endSendAttempt() {
        activeSendAttemptCount = max(activeSendAttemptCount - 1, 0)
        isSending = activeSendAttemptCount > 0
    }

    /// read-receipt 实时事件有时只在下一次历史对账后稳定可见。
    /// 发送成功后做一次短延迟 latest merge，避免本人消息的已读扇形要等退出重进才刷新。
    private func schedulePostSendReceiptReconcile() {
        postSendReceiptReconcileTask?.cancel()
        postSendReceiptReconcileTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.refreshLatestNow()
        }
    }

    // MARK: - 编辑 / 撤回 / 表情（Phase E）

    /// 编辑消息（仅本人文本）：先乐观改本地，成功用服务端结果收敛，失败回滚。
    @discardableResult
    func editMessage(messageId: Int, newContent: String) async -> Bool {
        let trimmed = newContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let index = messages.firstIndex(where: { $0.id == messageId }) else { return false }
        guard isIMMessageContentWithinLimit(trimmed) else { return false }
        let original = messages[index]
        guard trimmed != original.content.trimmingCharacters(in: .whitespacesAndNewlines) else { return true }
        var optimistic = original
        optimistic.content = trimmed
        optimistic.editedAt = ISO8601DateFormatter().string(from: Date())
        replaceMessage(at: index, with: optimistic)
        do {
            let updated = try await transport.editMessage(
                conversationId: conversationId, messageId: messageId, content: trimmed
            )
            mergeConfirmed([updated])
            return true
        } catch {
            if let i = messages.firstIndex(where: { $0.id == messageId }) {
                replaceMessage(at: i, with: original)
            }
            logger.error("edit failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// 撤回消息：先乐观置撤回态，失败回滚。
    @discardableResult
    func recallMessage(messageId: Int) async -> Bool {
        guard let index = messages.firstIndex(where: { $0.id == messageId }) else { return false }
        let original = messages[index]
        var optimistic = original
        optimistic.isDeleted = true
        replaceMessage(at: index, with: optimistic)
        syncPinnedMessages([optimistic])
        do {
            try await transport.recallMessage(conversationId: conversationId, messageId: messageId)
            return true
        } catch {
            if let i = messages.firstIndex(where: { $0.id == messageId }) {
                replaceMessage(at: i, with: original)
                syncPinnedMessages([original])
            }
            logger.error("recall failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// 切换表情回应（本人是否已点该 emoji）：乐观增删本地，失败回滚；实时事件到达时幂等收敛。
    func toggleReaction(messageId: Int, emoji: String) {
        guard !emoji.isEmpty,
              let message = messages.first(where: { $0.id == messageId }) else { return }
        // 未注入 currentUserId 时回退读鉴权态，避免「点了表情没反应」。
        let userId = currentUserId ?? AuthService.shared.currentUser?.id
        guard let userId, !userId.isEmpty else {
            logger.error("toggleReaction skipped: no currentUserId")
            return
        }
        if currentUserId == nil { currentUserId = userId }
        let hasReacted = reactionUsers(messageId: messageId, emoji: emoji).contains(userId)
        guard hasReacted || canAddIMReaction(emoji, to: message.reactions) else {
            logger.info("reaction toggle skipped: reaction kind limit reached")
            return
        }
        applyReaction(messageId: messageId, userId: userId, emoji: emoji, added: !hasReacted)
        Task {
            do {
                if hasReacted {
                    try await transport.removeReaction(conversationId: conversationId, messageId: messageId, emoji: emoji)
                } else {
                    try await transport.addReaction(conversationId: conversationId, messageId: messageId, emoji: emoji)
                }
            } catch {
                applyReaction(messageId: messageId, userId: userId, emoji: emoji, added: hasReacted)
                logger.error("reaction toggle failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// 消息置顶成功后就地收敛列表，避免等待下一次历史刷新才看到状态变化。
    func setMessagePinned(messageId: Int, pinned: Bool) {
        if let index = messages.firstIndex(where: { $0.id == messageId }) {
            var updated = messages[index]
            updated.isPinned = pinned
            updated.pinStateKnown = true
            replaceMessage(at: index, with: updated)
            syncPinnedMessages([updated])
        } else if !pinned {
            updatePinnedMessages(pinnedMessages.filter { $0.id != messageId })
        }
    }

    func pinMessage(messageId: Int, pinned: Bool) async throws {
        do {
            try await transport.pinMessage(conversationId: conversationId, messageId: messageId, pinned: pinned)
            setMessagePinned(messageId: messageId, pinned: pinned)
        } catch {
            // 另一台设备可能已经完成同一操作，重复取消置顶可能按错误返回。
            // 用权威置顶列表静默对账；目标状态已达成时按幂等成功收敛。
            await refreshLatestNow()
            let isPinned = pinnedMessages.contains { $0.id == messageId }
            if isPinned == pinned { return }
            throw error
        }
    }

    private func applyPinnedSnapshot(_ snapshot: [IMMessage]) {
        let visible = snapshot
            .filter {
                $0.conversationId == conversationId
                    && !$0.isDeleted
                    && $0.seq > historyClearedSeq
            }
            .reduce(into: [Int: IMMessage]()) { result, message in
                var pinned = message
                pinned.isPinned = true
                pinned.pinStateKnown = true
                result[pinned.id] = pinned
            }
            .values
            .sorted { $0.seq > $1.seq }
        let pinnedIds = Set(visible.map(\.id))
        if !messages.isEmpty {
            messages = messages.map { message in
                var updated = message
                updated.isPinned = pinnedIds.contains(message.id)
                updated.pinStateKnown = true
                return updated
            }
        }
        updatePinnedMessages(visible)
    }

    private func syncPinnedMessages(_ incoming: [IMMessage]) {
        let known = incoming.filter(\.pinStateKnown)
        guard !known.isEmpty else { return }
        var updated = pinnedMessages
        for message in known {
            updated.removeAll { messagesShareStableIdentity($0, message) }
            if message.isPinned && !message.isDeleted {
                updated.append(message)
            }
        }
        updatePinnedMessages(updated.sorted { $0.seq > $1.seq })
    }

    private func updatePinnedMessages(_ messages: [IMMessage]) {
        pinnedMessages = messages
        pinnedSnapshotCache.storePinnedMessages(
            conversationId: conversationId,
            messages: messages
        )
    }

    func clearHistory() async throws {
        let localClearedThroughSeq = (messages + pinnedMessages).map(\.seq).max() ?? 0
        let serverClearedThroughSeq = try await transport.clearHistoryAndFetchWatermark(
            conversationId: conversationId
        )
        clearLocalHistory(clearedThroughSeq: max(localClearedThroughSeq, serverClearedThroughSeq))
    }

    func leaveConversation() async throws {
        try await transport.leaveConversation(conversationId: conversationId)
    }

    func forwardMessage(_ message: IMMessage, sourceConversationName: String, to conversationId: String) async throws {
        _ = try await transport.forwardMessage(
            message,
            sourceConversationName: sourceConversationName,
            to: conversationId,
            clientRequestId: UUID().uuidString.lowercased()
        )
    }

    // MARK: - 已读（Phase E）

    /// 标记已读到当前最新消息（进入会话 / 前台收到新消息时调用）；对同一水位不重复上报。
    /// 成功后再次清列表角标（`enterConversation` 已乐观清过；此处覆盖 reload 竞态）。
    func markReadUpToLatest() {
        // 仅当本会话在前台激活时推进已读：切后台（scenePhase 非 active）会注销活动会话，
        // 此时收到的新消息应保留未读、不推进 read waterline（对齐 Android lifecycle 语义）。
        guard IMConversationStore.shared.activeConversationId == conversationId else { return }
        guard let latest = messages.last, latest.seq > lastMarkedReadSequence else { return }
        let previousMarked = lastMarkedReadSequence
        let targetSequence = latest.seq
        let contextGeneration = IMConversationStore.shared.captureReadContextGeneration()
        lastMarkedReadSequence = targetSequence
        Task {
            do {
                let acknowledgedSequence = try await transport.markRead(
                    conversationId: conversationId,
                    visibleMessage: latest
                )
                IMConversationStore.shared.acknowledgeRead(
                    conversationId: conversationId,
                    throughSeq: acknowledgedSequence,
                    contextGeneration: contextGeneration
                )
                lastMarkedReadSequence = max(lastMarkedReadSequence, acknowledgedSequence)
            } catch {
                if lastMarkedReadSequence == targetSequence {
                    lastMarkedReadSequence = previousMarked
                }  // 允许下次重试
                logger.error("mark read failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// DM 已读判定：仅本人发出的消息。两路证据取或——
    /// ① 后端列表随消息下发的 `read_receipt` 聚合（覆盖「对端在我打开会话前就已读」）；
    /// ② 打开会话后实时 `im.read.receipt` 累积的对端已读 seq（覆盖在场时对端读到）。
    func isReadByPeer(_ message: IMMessage) -> Bool {
        guard message.senderId == currentUserId else { return false }
        if let receipt = message.readReceipt, receipt.readCount > 0 { return true }
        return message.seq > 0 && message.seq <= effectivePeerReadWaterline
    }

    /// 本人消息的已读聚合。历史页带的 readReceipt 与实时 read receipt 取并集，
    /// 避免对端刚读完时 UI 要等下一轮历史刷新才显示。
    func readProgress(for message: IMMessage) -> IMReadReceipt? {
        guard message.senderId == currentUserId else { return nil }
        let liveReadCount = readSeqByUser
            .filter { $0.key != currentUserId }
            .filter { message.seq > 0 && message.seq <= $0.value }
            .count
        let readCount = max(message.readReceipt?.readCount ?? 0, liveReadCount)
        let recipientCount = max(message.readReceipt?.recipientCount ?? 0, readCount)
        guard readCount > 0 || recipientCount > 0 else { return nil }
        return IMReadReceipt(readCount: readCount, recipientCount: recipientCount)
    }

    func fetchReadReceipts(for message: IMMessage) async throws -> IMMessageReadReceipts {
        try await transport.fetchReadReceipts(conversationId: conversationId, messageId: message.id)
    }

    // MARK: - 实时

    /// 消费 `chat:{conv}` 的原始 publication，分发到对应处理。非本会话/未识别的忽略。
    func applyRealtime(_ data: Data) {
        guard let event = IMEventDecoder.decode(data) else { return }
        switch event {
        case let .message(msg):
            ingestRealtimeMessage(msg)
        case let .messageEdited(msg):
            guard msg.conversationId == conversationId else { return }
            mergeConfirmed([msg])
        case let .messageDeleted(messageId):
            applyDeletedLocal(messageId: messageId)
        case let .messagePinned(message):
            var pinned = message
            pinned.isPinned = true
            pinned.pinStateKnown = true
            mergeConfirmed([pinned])
            syncPinnedMessages([pinned])
        case let .messageUnpinned(messageId):
            if let index = messages.firstIndex(where: { $0.id == messageId }) {
                var updated = messages[index]
                updated.isPinned = false
                updated.pinStateKnown = true
                replaceMessage(at: index, with: updated)
            }
            updatePinnedMessages(pinnedMessages.filter { $0.id != messageId })
        case let .reaction(messageId, userId, emoji, added):
            applyReaction(messageId: messageId, userId: userId, emoji: emoji, added: added)
        case let .readReceipt(receipt):
            applyReadReceipt(receipt)
        case let .typing(userId):
            applyTyping(userId: userId)
        case let .handoffUpdate(handoffId):
            guard !handoffId.isEmpty else { return }
            handoffVersions[handoffId, default: 0] += 1
        case let .sessionShareUpdate(shareId):
            guard !shareId.isEmpty else { return }
            IMCardStatusMemoryCache.invalidateSessionShare(id: shareId)
            sessionShareVersions[shareId, default: 0] += 1
        case let .agentMessageStream(payload):
            applyAgentMessageStream(payload)
        case let .agentMessageFinal(payload):
            applyAgentMessageFinal(payload)
        case let .agentMessageError(payload):
            applyAgentMessageError(payload)
        case .conversationChanged:
            conversationRevision += 1
        case .unreadUpdate, .conversationNew, .conversationPreviewUpdated,
             .conversationLabelsUpdated, .userProfileUpdated,
             .aiError, .aiSuggestTask, .unknown:
            break
        }
    }

    private func applyAgentMessageStream(_ payload: IMAgentMessageStreamEvent) {
        guard payload.conversationId == conversationId,
              !payload.messageRef.isEmpty,
              !payload.delta.isEmpty,
              !closedAgentMessageRefs.contains(payload.messageRef),
              payload.streamSeq > (agentStreamSequenceByRef[payload.messageRef] ?? 0) else { return }

        let index = messages.firstIndex { $0.metadata?.messageRef == payload.messageRef }
        let existing = index.map { messages[$0] }
        if existing?.metadata?.kind == "agent_final" { return }
        agentStreamSequenceByRef[payload.messageRef] = payload.streamSeq
        let metadata = (existing?.metadata ?? IMMessageMetadata())
            .projectingAgent(
                kind: "agent_stream",
                messageRef: payload.messageRef,
                agentSessionRef: payload.agentSessionRef
            )
        let projected = IMMessage(
            id: existing?.id ?? nextTransientMessageId(),
            seq: existing?.seq ?? 0,
            conversationId: conversationId,
            senderId: payload.senderId,
            senderType: IMMemberType.agent.rawValue,
            senderName: payload.senderName,
            content: (existing?.content ?? "") + payload.delta,
            messageType: IMMessageType.text.rawValue,
            metadata: metadata,
            createdAt: existing?.createdAt ?? payload.createdAt
        )
        if let index {
            messages[index] = mergeKnownState(existing: existing, incoming: projected)
        } else {
            messages = imChronologicallySortedMessages(messages + [projected])
        }
    }

    private func applyAgentMessageFinal(_ payload: IMAgentMessageFinalEvent) {
        guard payload.conversationId == conversationId, !payload.messageRef.isEmpty else { return }
        closedAgentMessageRefs.insert(payload.messageRef)
        agentStreamSequenceByRef[payload.messageRef] = nil
        let index = messages.firstIndex { $0.metadata?.messageRef == payload.messageRef }
        let existing = index.map { messages[$0] }
        let metadata = (payload.metadata ?? existing?.metadata ?? IMMessageMetadata())
            .projectingAgent(
                kind: "agent_final",
                messageRef: payload.messageRef,
                agentSessionRef: payload.agentSessionRef
            )
        let projected = IMMessage(
            id: existing?.id ?? nextTransientMessageId(),
            seq: existing?.seq ?? 0,
            conversationId: conversationId,
            senderId: payload.senderId,
            senderType: IMMemberType.agent.rawValue,
            senderName: payload.senderName,
            content: payload.content,
            messageType: payload.messageType,
            metadata: metadata,
            createdAt: payload.createdAt ?? existing?.createdAt
        )
        if let index {
            messages[index] = mergeKnownState(existing: existing, incoming: projected)
        } else {
            messages = imChronologicallySortedMessages(messages + [projected])
        }
    }

    private func applyAgentMessageError(_ payload: IMAgentMessageErrorEvent) {
        guard payload.conversationId == conversationId, !payload.messageRef.isEmpty else { return }
        closedAgentMessageRefs.insert(payload.messageRef)
        agentStreamSequenceByRef[payload.messageRef] = nil
        messages.removeAll {
            $0.id <= 0
                && $0.metadata?.messageRef == payload.messageRef
                && $0.metadata?.kind == "agent_stream"
        }
    }

    private func nextTransientMessageId() -> Int {
        let minimum = messages.lazy.map(\.id).filter { $0 < 0 }.min() ?? 0
        return minimum > Int.min ? minimum - 1 : Int.min
    }

    /// 旧 Provider 兼容入口；自建链路使用 [applyRealtime] 消费完整事件。
    func applyAuxiliaryRealtime(_ data: Data) {
        guard let event = IMEventDecoder.decode(data) else { return }
        switch event {
        case let .typing(userId):
            applyTyping(userId: userId)
        case let .handoffUpdate(handoffId):
            guard !handoffId.isEmpty else { return }
            handoffVersions[handoffId, default: 0] += 1
        default:
            break
        }
    }

    /// 实时撤回：把本地该消息置为撤回态（幂等）。
    private func applyDeletedLocal(messageId: Int) {
        guard let index = messages.firstIndex(where: { $0.id == messageId }) else { return }
        // 整条重赋：避免嵌套字段原地改写时 @Observable 不通知 SwiftUI。
        var updated = messages[index]
        updated.isDeleted = true
        updated.content = ""
        replaceMessage(at: index, with: updated)
        syncPinnedMessages([updated])
    }

    /// 表情增删的集合语义处理（本地乐观 + 实时回声共用；同一 userId 不重复、移除幂等）。
    private func applyReaction(messageId: Int, userId: String, emoji: String, added: Bool) {
        guard !userId.isEmpty, !emoji.isEmpty,
              let index = messages.firstIndex(where: { $0.id == messageId }) else { return }
        var updated = messages[index]
        var users = updated.reactions[emoji] ?? []
        if added {
            if !users.contains(userId) { users.append(userId) }
        } else {
            users.removeAll { $0 == userId }
        }
        if users.isEmpty {
            updated.reactions[emoji] = nil
            updated.reactionOrder.removeAll { $0 == emoji }
        } else {
            updated.reactions[emoji] = users
            if !updated.reactionOrder.contains(emoji) { updated.reactionOrder.append(emoji) }
        }
        // 整条重赋，确保 @Observable 触发 UI 刷新（嵌套 dict 原地写经常不通知）。
        replaceMessage(at: index, with: updated)
    }

    private func reactionUsers(messageId: Int, emoji: String) -> [String] {
        guard let index = messages.firstIndex(where: { $0.id == messageId }) else { return [] }
        return messages[index].reactions[emoji] ?? []
    }

    /// 已读回执：单调推进该用户已读 seq。
    private func applyReadReceipt(_ receipt: IMReadReceiptEvent) {
        guard receipt.conversationId == conversationId, !receipt.userId.isEmpty else { return }
        let previous = readSeqByUser[receipt.userId] ?? 0
        if receipt.lastReadSeq > previous {
            readSeqByUser[receipt.userId] = receipt.lastReadSeq
            readStateCache?.advanceReadWaterline(
                scopeId: cacheScopeId,
                conversationId: conversationId,
                readerId: receipt.userId,
                seq: receipt.lastReadSeq
            )
            refreshPeerReadWaterline()
        }
    }

    /// 历史页可能只给部分消息附带 readReceipt；已读语义是单调水位，因此任意更晚的
    /// 本人已读消息都能证明它之前的本人消息也已读，避免相邻卡片一条有圈一条消失。
    private var inferredReceiptWaterline: Int {
        guard let currentUserId else { return 0 }
        return messages.lazy
            .filter { $0.senderId == currentUserId && ($0.readReceipt?.readCount ?? 0) > 0 }
            .map(\.seq)
            .max() ?? 0
    }

    private var effectivePeerReadWaterline: Int {
        max(
            inferredReceiptWaterline,
            readSeqByUser.filter { $0.key != currentUserId }.values.max() ?? 0
        )
    }

    private func refreshPeerReadWaterline() {
        peerReadWaterline = effectivePeerReadWaterline
    }

    /// typing：插入并 3.5s 后自动清除（对齐 Electron TYPING_EXPIRE_MS）；排除本人。
    private func applyTyping(userId: String) {
        guard !userId.isEmpty, userId != currentUserId else { return }
        typingUserIds.insert(userId)
        typingExpiry[userId]?.cancel()
        typingExpiry[userId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3.5))
            guard let self, !Task.isCancelled else { return }
            self.typingUserIds.remove(userId)
            self.typingExpiry[userId] = nil
        }
    }

    /// 合并一条实时消息：先用 client_request_id 收敛可能的乐观态，再按 id 去重插入。
    func ingestRealtimeMessage(_ msg: IMMessage) {
        guard msg.conversationId == conversationId else { return }
        guard msg.seq > historyClearedSeq else {
            logger.debug("discarded cleared realtime message id=\(msg.id, privacy: .public)")
            return
        }
        if let sessionShare = msg.sessionShareCard {
            IMCardStatusMemoryCache.putSessionShare(sessionShare)
        }
        // `mergeConfirmed()` 先读取 pending 的毫秒级提交时间，再按 request id 收敛展示与附件。
        mergeConfirmed([resolveRealtimeReplyPreview(msg)])
    }

    /// 共享实时通道只下发安全占位；原消息已在当前消息流中且可见时才补回预览。
    private func resolveRealtimeReplyPreview(_ message: IMMessage) -> IMMessage {
        let existing = messages.first { $0.id == message.id }
        let merged = mergeKnownState(existing: existing, incoming: message)
        let context = messages.filter { $0.id != message.id } + [merged]
        return resolveLoadedReplyPreviews(context).first(where: { $0.id == message.id }) ?? merged
    }

    /// POST 成功只返回轻量确认数据。对于用户刚在当前会话可见范围内回复的原消息，
    /// 立即在本地构造引用预览，避免等待实时回声或重新进入会话后才出现引用 UI。
    /// 不在本地列表中的原消息仍不猜测内容，保持服务端后续下发的安全预览语义。
    private func localReplyPreview(replyToId: Int?) -> IMReplyPreview? {
        guard let replyToId,
              let source = messages.first(where: { $0.id == replyToId && !$0.isDeleted }) else {
            return nil
        }
        return IMReplyPreview(
            content: String(source.content.prefix(100)),
            senderId: source.senderId,
            messageType: source.messageType,
            hasAttachment: source.hasAttachment,
            fileName: source.attachmentFileName
        )
    }

    // MARK: - 合并（稳定消息身份去重、按发送时间升序）

    /// 服务端消息主键是确认态的稳定身份；乐观态由 `client_request_id` 与回包收敛。
    private func mergeConfirmed(_ incoming: [IMMessage]) {
        let pendingCreatedAtByRequestId = Dictionary(
            uniqueKeysWithValues: pending.map { ($0.clientRequestId, $0.createdAt) }
        )
        let visibleIncoming = incoming
            .filter { $0.seq > historyClearedSeq }
            .map { message in
                var resolved = message
                if let requestId = message.metadata?.clientRequestId,
                   let submittedAt = pendingCreatedAtByRequestId[requestId] {
                    resolved.createdAt = imPreciseTimestampString(submittedAt)
                }
                if resolved.pinStateKnown {
                    return resolved
                } else if pinnedMessages.contains(where: { messagesShareStableIdentity($0, message) }) {
                    resolved.isPinned = true
                    resolved.pinStateKnown = true
                } else if hasCompletedPinnedRefresh {
                    resolved.isPinned = false
                    resolved.pinStateKnown = true
                }
                return resolved
            }
        guard !visibleIncoming.isEmpty else { return }
        for message in visibleIncoming where message.id > 0 && message.isFromAgent {
            guard let messageRef = message.metadata?.messageRef, !messageRef.isEmpty,
                  message.metadata?.agentSessionRef?.isEmpty == false else { continue }
            closedAgentMessageRefs.insert(messageRef)
            agentStreamSequenceByRef[messageRef] = nil
        }
        Set(visibleIncoming.compactMap { $0.metadata?.clientRequestId }).forEach { requestId in
            removePending(clientRequestId: requestId)
            releaseTrackedUploadStageAttachment(clientRequestId: requestId)
        }
        var merged = messages
        for msg in visibleIncoming {
            if let index = merged.firstIndex(where: { messagesShareStableIdentity($0, msg) }) {
                merged[index] = mergeKnownState(existing: merged[index], incoming: msg)
            } else {
                merged.append(msg)
            }
        }
        messages = resolveLoadedReplyPreviews(imChronologicallySortedMessages(merged))
        syncPinnedMessages(visibleIncoming)
    }

    private func messagesShareStableIdentity(_ left: IMMessage, _ right: IMMessage) -> Bool {
        // Django Message 主键贯穿列表、编辑、撤回和已读链路；同一正数 id 必须收敛，
        // 否则会把重复 identifier 送进 diffable data source。
        if left.id > 0, right.id > 0, left.id == right.id {
            return true
        }

        // 业务卡状态投影可能生成新的消息行，但 message_ref 仍代表同一用户可见对象。
        let leftRef = left.metadata?.messageRef?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rightRef = right.metadata?.messageRef?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let leftRef, !leftRef.isEmpty, let rightRef, !rightRef.isEmpty {
            return leftRef == rightRef
        }

        let leftRequestId = left.metadata?.clientRequestId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rightRequestId = right.metadata?.clientRequestId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let leftRequestId, !leftRequestId.isEmpty,
           let rightRequestId, !rightRequestId.isEmpty {
            return leftRequestId == rightRequestId
        }

        return false
    }

    private func mergeKnownState(existing: IMMessage?, incoming: IMMessage) -> IMMessage {
        guard let existing else { return incoming }
        guard incoming.replyToId == nil && existing.replyToId != nil else {
            var merged = incoming
            merged.createdAt = preciseLocalCreatedAt(existing: existing, incoming: incoming)
            let deleted = merged.isDeleted || existing.isDeleted
            merged.isDeleted = deleted
            if deleted {
                merged.content = recalledDraftContent(existing: existing, incoming: incoming)
            }
            if merged.replyToPreview == nil { merged.replyToPreview = existing.replyToPreview }
            merged.isPinned = merged.pinStateKnown ? merged.isPinned : (merged.isPinned || existing.isPinned)
            merged.pinStateKnown = merged.pinStateKnown || existing.pinStateKnown
            if !merged.reactionStateKnown, merged.reactions.isEmpty { merged.reactions = existing.reactions }
            if !merged.reactionStateKnown, merged.reactionOrder.isEmpty { merged.reactionOrder = existing.reactionOrder }
            merged.reactionStateKnown = merged.reactionStateKnown || existing.reactionStateKnown
            if merged.readReceipt == nil { merged.readReceipt = existing.readReceipt }
            return merged
        }

        var merged = IMMessage(
            id: incoming.id,
            seq: incoming.seq,
            conversationId: incoming.conversationId,
            senderId: incoming.senderId,
            senderType: incoming.senderType,
            senderName: incoming.senderName,
            content: (incoming.isDeleted || existing.isDeleted)
                ? recalledDraftContent(existing: existing, incoming: incoming)
                : incoming.content,
            messageType: incoming.messageType,
            replyToId: existing.replyToId,
            replyToPreview: incoming.replyToPreview ?? existing.replyToPreview,
            hasAttachment: incoming.hasAttachment,
            metadata: incoming.metadata,
            createdAt: preciseLocalCreatedAt(existing: existing, incoming: incoming),
            isDeleted: incoming.isDeleted || existing.isDeleted,
            editedAt: incoming.editedAt,
            isPinned: incoming.pinStateKnown ? incoming.isPinned : (incoming.isPinned || existing.isPinned),
            pinStateKnown: incoming.pinStateKnown || existing.pinStateKnown,
            reactions: incoming.reactionStateKnown || !incoming.reactions.isEmpty ? incoming.reactions : existing.reactions,
            reactionOrder: incoming.reactionStateKnown || !incoming.reactions.isEmpty ? incoming.reactionOrder : existing.reactionOrder,
            reactionStateKnown: incoming.reactionStateKnown || existing.reactionStateKnown,
            readReceipt: incoming.readReceipt ?? existing.readReceipt
        )
        if merged.replyToPreview == nil { merged.replyToPreview = existing.replyToPreview }
        return merged
    }

    private func preciseLocalCreatedAt(existing: IMMessage, incoming: IMMessage) -> String? {
        let existingRequestId = existing.metadata?.clientRequestId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingRequestId = incoming.metadata?.clientRequestId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let existingRequestId, !existingRequestId.isEmpty, existingRequestId == incomingRequestId {
            return existing.createdAt ?? incoming.createdAt
        }
        return incoming.createdAt
    }

    private func recalledDraftContent(existing: IMMessage, incoming: IMMessage) -> String {
        guard incoming.senderId == currentUserId || existing.senderId == currentUserId else { return "" }
        return existing.content.isEmpty ? incoming.content : existing.content
    }

    private func resolveLoadedReplyPreviews(_ sourceMessages: [IMMessage]) -> [IMMessage] {
        let byId = Dictionary(sourceMessages.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        return sourceMessages.map { message in
            guard let replyToId = message.replyToId else { return message }
            guard let source = byId[replyToId] else { return message }
            var resolved = message
            if source.isDeleted {
                resolved.replyToPreview = IMReplyPreview(
                    content: "消息内容不可用",
                    senderId: source.senderId,
                    isUnavailable: true,
                    messageType: source.messageType,
                    hasAttachment: source.hasAttachment,
                    fileName: source.attachmentFileName
                )
                return resolved
            }
            resolved.replyToPreview = IMReplyPreview(
                content: String(source.content.prefix(100)),
                senderId: source.senderId,
                messageType: source.messageType,
                hasAttachment: source.hasAttachment,
                fileName: source.attachmentFileName
            )
            return resolved
        }
    }

    /// 落乐观态：新消息追加；同一 `clientRequestId`（重试）则原地复位为 sending，
    /// 复用幂等键、不新增一行 pending。
    private func upsertPending(
        clientRequestId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: [String],
        mentionedAgentIds: [String],
        mentionAll: Bool,
        attachment: IMOutgoingAttachment?,
        card: IMOutgoingCard?,
        refreshCreatedAt: Bool
    ) {
        if let index = pending.firstIndex(where: { $0.clientRequestId == clientRequestId }) {
            pending[index].status = .sending
            pending[index].errorMessage = nil
            if refreshCreatedAt {
                pending[index].createdAt = now()
            }
        } else {
            pending.append(
                IMPendingMessage(
                    clientRequestId: clientRequestId,
                    content: content,
                    messageType: messageType,
                    replyToId: replyToId,
                    mentionedUserIds: mentionedUserIds,
                    mentionedAgentIds: mentionedAgentIds,
                    mentionAll: mentionAll,
                    attachment: attachment,
                    card: card,
                    createdAt: now(),
                    errorMessage: nil,
                    status: .sending
                )
            )
        }
        if let attachment {
            trackedUploadStageAttachments[clientRequestId] = attachment
        }
        persistPending()
    }

    private func removePending(clientRequestId: String) {
        pending.removeAll { $0.clientRequestId == clientRequestId }
        persistPending()
    }

    private func releaseTrackedUploadStageAttachment(clientRequestId: String) {
        guard let attachment = trackedUploadStageAttachments.removeValue(forKey: clientRequestId) else { return }
        onReleaseAbandonedAttachment?(attachment)
    }

    private func markPendingFailed(clientRequestId: String, errorMessage: String?) {
        guard let index = pending.firstIndex(where: { $0.clientRequestId == clientRequestId }) else { return }
        pending[index].status = .failed
        pending[index].errorMessage = nil
        persistPending()
    }

    private func persistPending() {
        pendingCache.store(scopeId: cacheScopeId, conversationId: conversationId, pending: pending)
    }

    /// 注入的 currentUserId 优先；否则读鉴权态并回填 store，供发送/表情/已读判定共用。
    private func resolvedCurrentUserId() -> String {
        if let currentUserId, !currentUserId.isEmpty { return currentUserId }
        let userId = AuthService.shared.currentUser?.id ?? ""
        if !userId.isEmpty { self.currentUserId = userId }
        return userId
    }
}

import Foundation
// `@preconcurrency`：沿用旧 `tabtin-ios` MessageCacheService 的成熟豁免——`#Predicate { ... }`
// macro 展开发生在编译期，`@preconcurrency` 对 macro 合成代码内部的 keypath conformance
// 无副作用但零 runtime 风险，保留作为未来 Swift 编译器修复 `#Predicate` 时的零成本起点。
@preconcurrency import SwiftData

/// 单条会话消息的本地缓存行（SwiftData 持久化 schema，独立于视图模型态 `ChatMessage`）。
///
/// 与旧 `tabtin-ios` 的 `CachedMessage` 的关键差异：新版 `ChatMessage` 的真源是有序
/// `blocks: [MessageBlock]`（text/thinking/tool 穿插），不是「content + blocksJson」分桶。
/// 这里把有序块整体编码成 `blocksData`（见 `MessageBlockCodec`），读回时还原同一时间轴。
@Model
nonisolated final class CachedMessage {
    /// 缓存唯一键 = 该条消息当时的 `effectiveId`（persistedId ?? serverId ?? 本地 id）。
    /// 因为缓存按「整会话快照替换」写入（见 `MessageCacheStore.cacheMessages`），
    /// 同会话内 id 一定唯一，不存在旧版那种「client UUID → server id 漂移建重复行」的问题。
    @Attribute(.unique) var id: String
    var sessionId: String
    var role: String
    /// `[MessageBlock]` 的 JSON 编码（`MessageBlockCodec`）。
    var blocksData: Data
    var serverId: String?
    var persistedId: String?
    /// 本地 user 与服务端持久化 id 不同时，仍保留其幂等/轮次关联键。
    var clientEventId: String? = nil
    /// assistant 状态/回复所属的 user 轮次；离线重进后仍可恢复正确上下位置。
    var sourceClientEventId: String? = nil
    /// assistant 消息实际执行 Agent；缓存恢复后仍能显示正确身份。
    var agentId: String? = nil
    var stopReason: String?
    var errorMessage: String?
    var checkpointData: Data?
    var agentRunId: String?
    var errorCategory: String?
    var errorCode: String?
    var errorClass: String?
    var suggestedAction: String?
    var createdAt: Date
    /// 写入时间，用于会话级 LRU 淘汰。
    var cachedAt: Date

    init(
        id: String,
        sessionId: String,
        role: String,
        blocksData: Data,
        serverId: String?,
        persistedId: String?,
        clientEventId: String? = nil,
        sourceClientEventId: String? = nil,
        agentId: String? = nil,
        stopReason: String?,
        errorMessage: String?,
        checkpointData: Data?,
        agentRunId: String?,
        errorCategory: String?,
        errorCode: String?,
        errorClass: String?,
        suggestedAction: String?,
        createdAt: Date
    ) {
        self.id = id
        self.sessionId = sessionId
        self.role = role
        self.blocksData = blocksData
        self.serverId = serverId
        self.persistedId = persistedId
        self.clientEventId = clientEventId
        self.sourceClientEventId = sourceClientEventId
        self.agentId = agentId
        self.stopReason = stopReason
        self.errorMessage = errorMessage
        self.checkpointData = checkpointData
        self.agentRunId = agentRunId
        self.errorCategory = errorCategory
        self.errorCode = errorCode
        self.errorClass = errorClass
        self.suggestedAction = suggestedAction
        self.createdAt = createdAt
        self.cachedAt = Date()
    }

    func toChatMessage() -> ChatMessage {
        let checkpointRecord = checkpointData.flatMap {
            try? JSONDecoder().decode(ChatCheckpointRecord.self, from: $0)
        }
        return ChatMessage(
            id: id,
            serverId: serverId,
            persistedId: persistedId,
            clientEventId: clientEventId,
            sourceClientEventId: sourceClientEventId,
            role: ChatRole(rawValue: role) ?? .system,
            agentId: agentId,
            blocks: MessageBlockCodec.decode(blocksData),
            isStreaming: false,
            stopReason: stopReason,
            errorMessage: errorMessage,
            checkpointRecord: checkpointRecord,
            agentRunId: agentRunId,
            errorCategory: errorCategory,
            errorCode: errorCode,
            errorClass: errorClass,
            suggestedAction: suggestedAction,
            createdAt: createdAt
        )
    }

    static func from(sessionId: String, msg: ChatMessage) -> CachedMessage {
        let checkpointData = msg.checkpointRecord.flatMap {
            try? JSONEncoder().encode($0)
        }
        return CachedMessage(
            id: msg.effectiveId,
            sessionId: sessionId,
            role: msg.role.rawValue,
            blocksData: MessageBlockCodec.encode(msg.blocks),
            serverId: msg.serverId,
            persistedId: msg.persistedId,
            clientEventId: msg.clientEventId,
            sourceClientEventId: msg.sourceClientEventId,
            agentId: msg.agentId,
            stopReason: msg.stopReason,
            errorMessage: msg.errorMessage,
            checkpointData: checkpointData,
            agentRunId: msg.agentRunId,
            errorCategory: msg.errorCategory,
            errorCode: msg.errorCode,
            errorClass: msg.errorClass,
            suggestedAction: msg.suggestedAction,
            createdAt: msg.createdAt
        )
    }
}

/// `[MessageBlock]` ↔ `Data` 的纯编解码（`MessageBlock` 是带关联值的 enum、非 Codable，
/// 用扁平 DTO 做镜像）。纯函数、无 SwiftData 依赖，便于单测 round-trip。
enum MessageBlockCodec {
    private struct BlockDTO: Codable {
        enum Kind: String, Codable { case text, thinking, tool, attachment, richContent, contextRef }
        var kind: Kind
        var messageId: String? = nil
        var index: Int
        // text / thinking
        var text: String? = nil
        var citations: [Citation]? = nil
        // thinking
        var completed: Bool? = nil
        var startedAt: Date? = nil
        var stoppedAt: Date? = nil
        // tool
        var toolCallId: String? = nil
        var name: String? = nil
        var inputJson: String? = nil
        var finalized: Bool? = nil
        var resultText: String? = nil
        var isError: Bool? = nil
        // attachment
        var attachmentKind: String? = nil
        var filename: String? = nil
        var mimeType: String? = nil
        var size: Int64? = nil
        var url: String? = nil
        var fileId: String? = nil
        var sourceToolUseId: String? = nil
        // rich content
        var richKind: String? = nil
        var summary: String? = nil
        var title: String? = nil
        var groupId: String? = nil
        var tableRows: [[String]]? = nil
        var tableSchema: RichTableSchema? = nil
        var footer: String? = nil
        var resourceType: String? = nil
        var resourceName: String? = nil
        var richResourceId: String? = nil
        var richSpaceName: String? = nil
        var richURL: String? = nil
        var richFilename: String? = nil
        var richMimeType: String? = nil
        var richFileSize: Int64? = nil
        var totalRows: Int? = nil
        var widgetId: String? = nil
        var format: String? = nil
        var sourceCode: String? = nil
        var mermaidSource: String? = nil
        var query: String? = nil
        var searchResults: [RichSearchResult]? = nil
        var totalCount: Int? = nil
        // context ref
        var contextType: String? = nil
        var resourceId: String? = nil
        var contextURL: String? = nil
        var tableId: String? = nil
        var docId: String? = nil
        var rowIds: [String]? = nil
        var fieldIds: [String]? = nil
        var label: String? = nil
        var preview: String? = nil
        var spaceId: String? = nil
        var spaceName: String? = nil
        var locationHint: String? = nil
    }

    static func encode(_ blocks: [MessageBlock]) -> Data {
        let dtos = blocks.map { block -> BlockDTO in
            switch block {
            case let .text(b):
                return BlockDTO(kind: .text, messageId: b.messageId, index: b.index,
                                text: b.text, citations: b.citations.isEmpty ? nil : b.citations)
            case let .thinking(s):
                return BlockDTO(kind: .thinking, messageId: s.messageId, index: s.index,
                                text: s.text, completed: s.completed,
                                startedAt: s.startedAt, stoppedAt: s.stoppedAt)
            case let .tool(t):
                return BlockDTO(kind: .tool, messageId: nil, index: t.index,
                                toolCallId: t.toolCallId, name: t.name, inputJson: t.inputJson,
                                finalized: t.finalized, resultText: t.resultText, isError: t.isError)
            case let .attachment(a):
                return BlockDTO(kind: .attachment, messageId: a.messageId, index: a.index,
                                attachmentKind: a.kind.rawValue, filename: a.filename,
                                mimeType: a.mimeType, size: a.size, url: a.url, fileId: a.fileId)
            case let .richContent(r):
                return BlockDTO(kind: .richContent, messageId: r.messageId, index: r.index,
                                fileId: r.fileId, sourceToolUseId: r.sourceToolUseId,
                                richKind: r.kind, summary: r.summary,
                                title: r.title, groupId: r.groupId,
                                tableRows: r.tableRows, tableSchema: r.tableSchema,
                                footer: r.footer, resourceType: r.resourceType,
                                resourceName: r.resourceName, richResourceId: r.resourceId,
                                richSpaceName: r.spaceName, richURL: r.url, richFilename: r.filename,
                                richMimeType: r.mimeType, richFileSize: r.fileSize, totalRows: r.totalRows,
                                widgetId: r.widgetId, format: r.format, sourceCode: r.sourceCode,
                                mermaidSource: r.mermaidSource, query: r.query,
                                searchResults: r.searchResults.isEmpty ? nil : r.searchResults,
                                totalCount: r.totalCount)
            case let .contextRef(c):
                return BlockDTO(kind: .contextRef, messageId: c.messageId, index: c.index,
                                contextType: c.type, resourceId: c.resourceId, contextURL: c.url,
                                tableId: c.tableId, docId: c.docId,
                                rowIds: c.rowIds.isEmpty ? nil : c.rowIds,
                                fieldIds: c.fieldIds.isEmpty ? nil : c.fieldIds,
                                label: c.label,
                                preview: c.preview, spaceId: c.spaceId, spaceName: c.spaceName,
                                locationHint: c.locationHint)
            }
        }
        return (try? JSONEncoder().encode(dtos)) ?? Data()
    }

    static func decode(_ data: Data) -> [MessageBlock] {
        guard let dtos = try? JSONDecoder().decode([BlockDTO].self, from: data) else { return [] }
        return dtos.compactMap { dto -> MessageBlock? in
            switch dto.kind {
            case .text:
                return .text(TextBlock(messageId: dto.messageId, index: dto.index,
                                       text: dto.text ?? "", citations: dto.citations ?? []))
            case .thinking:
                return .thinking(ThinkingSegment(
                    messageId: dto.messageId, index: dto.index,
                    text: dto.text ?? "", completed: dto.completed ?? true,
                    startedAt: dto.startedAt, stoppedAt: dto.stoppedAt))
            case .tool:
                guard let toolCallId = dto.toolCallId else { return nil }
                return .tool(ToolCall(
                    toolCallId: toolCallId, index: dto.index, name: dto.name ?? "tool",
                    inputJson: dto.inputJson ?? "", finalized: dto.finalized ?? true,
                    resultText: dto.resultText, isError: dto.isError ?? false))
            case .attachment:
                let kind = AttachmentBlock.Kind(rawValue: dto.attachmentKind ?? "") ?? .file
                return .attachment(AttachmentBlock(
                    messageId: dto.messageId,
                    index: dto.index,
                    kind: kind,
                    filename: dto.filename ?? "附件",
                    mimeType: dto.mimeType,
                    size: dto.size,
                    url: dto.url,
                    fileId: dto.fileId
                ))
            case .richContent:
                return .richContent(RichContentBlock(
                    messageId: dto.messageId,
                    index: dto.index,
                    kind: dto.richKind ?? "rich_content",
                    summary: dto.summary ?? "",
                    title: dto.title,
                    groupId: dto.groupId,
                    tableRows: dto.tableSchema?.displayRows ?? dto.tableRows ?? [],
                    tableSchema: dto.tableSchema,
                    footer: dto.footer,
                    resourceType: dto.resourceType,
                    resourceName: dto.resourceName,
                    resourceId: dto.richResourceId,
                    spaceName: dto.richSpaceName,
                    url: dto.richURL,
                    filename: dto.richFilename,
                    mimeType: dto.richMimeType,
                    fileSize: dto.richFileSize,
                    totalRows: dto.totalRows,
                    widgetId: dto.widgetId,
                    format: dto.format,
                    sourceCode: dto.sourceCode,
                    mermaidSource: dto.mermaidSource,
                    query: dto.query,
                    searchResults: dto.searchResults ?? [],
                    totalCount: dto.totalCount,
                    fileId: dto.fileId,
                    sourceToolUseId: dto.sourceToolUseId
                ))
            case .contextRef:
                return .contextRef(ContextRefBlock(
                    messageId: dto.messageId,
                    index: dto.index,
                    type: dto.contextType ?? "context",
                    resourceId: dto.resourceId,
                    url: dto.contextURL,
                    tableId: dto.tableId,
                    docId: dto.docId,
                    rowIds: dto.rowIds ?? [],
                    fieldIds: dto.fieldIds ?? [],
                    label: dto.label ?? "上下文引用",
                    preview: dto.preview,
                    spaceId: dto.spaceId,
                    spaceName: dto.spaceName,
                    locationHint: dto.locationHint
                ))
            }
        }
    }
}

/// 会话消息的本地缓存（offline-first：进会话先秒显缓存、再 HTTP 对账，治理「网络抖动进会话空白」）。
///
/// 设计要点（与旧 `tabtin-ios` MessageCacheService 的取舍差异）：
/// - **整会话快照替换**：`cacheMessages` 先删该 session 旧行再批量插入当前完整列表。
///   因为上层（`ConversationProjector`）每次给的是「当前完整消息列表」而非增量，
///   replace-session 比旧版 upsert + persistedId 回填更简单且天然消除 client→server id 漂移建重复行。
/// - **读同步、写异步**：`getCachedMessages` 在主线程同步返回，供 `startSession` 首帧即时播种（无 await 间隙）；
///   写走串行队列后台落盘，不阻塞 UI。
/// - **会话级 LRU**：最多缓存 `maxCachedSessions` 个会话，按最近写入淘汰。
/// - **登出清空**：由 `WorkspaceStore` 的登出 hook 调 `clearAll()`（与其它 store 一致跟登录态走）。
final class MessageCacheStore: @unchecked Sendable {
    static let shared = MessageCacheStore()

    private var container: ModelContainer?
    private let queue = DispatchQueue(label: "com.tabtin.mobile.messagecache", qos: .utility)
    private let maxCachedSessions = 20

    private init() {
        do {
            let schema = Schema([CachedMessage.self])
            let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false, allowsSave: true)
            container = try ModelContainer(for: schema, configurations: [config])
        } catch {
            print("[MessageCacheStore] failed to create container: \(error)")
            container = nil
        }
    }

    /// 进会话首帧即时播种用：主线程同步读，命中返回按 createdAt 升序的缓存消息。
    @MainActor
    func getCachedMessages(sessionId: String) -> [ChatMessage] {
        guard let container else { return [] }
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.sessionId == sessionId },
            sortBy: [SortDescriptor(\.createdAt)]
        )
        guard let entities = try? context.fetch(descriptor), !entities.isEmpty else { return [] }
        return entities.map { $0.toChatMessage() }
    }

    /// 整会话快照替换落盘（异步）。过滤掉流式中 / 本地 inline 提案卡（plan/mode_switch）——
    /// 前者可能是半截内容，后者是本地态不该持久化。
    func cacheMessages(sessionId: String, messages: [ChatMessage]) {
        guard let container else { return }
        let snapshot = messages.filter {
            !$0.isStreaming
                && $0.planProposal == nil
                && $0.modeSwitchProposal == nil
                && !$0.isSubagentTranscript
                && !$0.isInternalContext
                && !$0.shouldHidePushNotification
        }
        queue.async { [weak self] in
            let context = ModelContext(container)
            self?.deleteRows(sessionId: sessionId, in: context)
            if !snapshot.isEmpty {
                for msg in snapshot {
                    context.insert(CachedMessage.from(sessionId: sessionId, msg: msg))
                }
                self?.evictOldSessions(using: context)
            }
            try? context.save()
        }
    }

    func clearSession(_ sessionId: String) {
        guard let container else { return }
        queue.async { [weak self] in
            let context = ModelContext(container)
            self?.deleteRows(sessionId: sessionId, in: context)
            try? context.save()
        }
    }

    func clearAll() {
        guard let container else { return }
        queue.async {
            let context = ModelContext(container)
            let descriptor = FetchDescriptor<CachedMessage>()
            guard let entities = try? context.fetch(descriptor) else { return }
            for entity in entities { context.delete(entity) }
            try? context.save()
        }
    }

    // MARK: - Private

    private func deleteRows(sessionId: String, in context: ModelContext) {
        let descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.sessionId == sessionId }
        )
        guard let entities = try? context.fetch(descriptor) else { return }
        for entity in entities { context.delete(entity) }
    }

    private func evictOldSessions(using context: ModelContext) {
        let descriptor = FetchDescriptor<CachedMessage>(
            sortBy: [SortDescriptor(\.cachedAt, order: .reverse)]
        )
        guard let all = try? context.fetch(descriptor) else { return }

        var sessionLatest: [String: Date] = [:]
        for msg in all {
            if msg.cachedAt > (sessionLatest[msg.sessionId] ?? .distantPast) {
                sessionLatest[msg.sessionId] = msg.cachedAt
            }
        }
        guard sessionLatest.count > maxCachedSessions else { return }

        let keep = Set(sessionLatest.sorted { $0.value > $1.value }.prefix(maxCachedSessions).map(\.key))
        for entity in all where !keep.contains(entity.sessionId) {
            context.delete(entity)
        }
        try? context.save()
    }
}

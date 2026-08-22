import Foundation
@preconcurrency import SwiftData

@MainActor
protocol IMReadStateCache: AnyObject {
    func advanceReadWaterline(
        scopeId: String,
        conversationId: String,
        readerId: String,
        seq: Int
    )
    func clearReadState(scopeId: String, conversationId: String)
}

@Model
nonisolated final class CachedIMDatabaseMessage {
    @Attribute(.unique) var key: String
    var scopeId: String
    var conversationId: String
    var messageId: Int
    var seq: Int
    var payload: Data
    var cachedAt: Date

    init(
        key: String,
        scopeId: String,
        conversationId: String,
        messageId: Int,
        seq: Int,
        payload: Data,
        cachedAt: Date
    ) {
        self.key = key
        self.scopeId = scopeId
        self.conversationId = conversationId
        self.messageId = messageId
        self.seq = seq
        self.payload = payload
        self.cachedAt = cachedAt
    }
}

@Model
nonisolated final class CachedIMPinnedMessage {
    @Attribute(.unique) var key: String
    var scopeId: String
    var conversationId: String
    var messageId: Int
    var seq: Int
    var payload: Data
    var cachedAt: Date

    init(
        key: String,
        scopeId: String,
        conversationId: String,
        messageId: Int,
        seq: Int,
        payload: Data,
        cachedAt: Date
    ) {
        self.key = key
        self.scopeId = scopeId
        self.conversationId = conversationId
        self.messageId = messageId
        self.seq = seq
        self.payload = payload
        self.cachedAt = cachedAt
    }
}

@Model
nonisolated final class CachedIMReadWaterline {
    @Attribute(.unique) var key: String
    var scopeId: String
    var conversationId: String
    var readerId: String
    var seq: Int
    var updatedAt: Date

    init(
        key: String,
        scopeId: String,
        conversationId: String,
        readerId: String,
        seq: Int,
        updatedAt: Date
    ) {
        self.key = key
        self.scopeId = scopeId
        self.conversationId = conversationId
        self.readerId = readerId
        self.seq = seq
        self.updatedAt = updatedAt
    }
}

@ModelActor
actor IMMessageDatabaseWorker {
    private var minimumAcceptedGeneration = 0
    private var latestMessageRevisionByConversation: [String: Int] = [:]
    private var latestPinnedRevisionByConversation: [String: Int] = [:]

    func messages(scopeId: String, conversationId: String, limit: Int) -> [IMMessage] {
        let descriptor = FetchDescriptor<CachedIMDatabaseMessage>(
            predicate: #Predicate {
                $0.scopeId == scopeId && $0.conversationId == conversationId
            },
            sortBy: [SortDescriptor(\CachedIMDatabaseMessage.seq)]
        )
        guard let rows = try? modelContext.fetch(descriptor) else { return [] }
        let decoder = JSONDecoder()
        let decoded = rows.compactMap { row in
            (try? decoder.decode(CachedIMMessage.self, from: row.payload))?.message
        }
        return Array(imChronologicallySortedMessages(decoded).suffix(limit))
    }

    func store(
        scopeId: String,
        conversationId: String,
        messages: [IMMessage],
        messageLimit: Int,
        conversationLimit: Int,
        generation: Int,
        revision: Int
    ) {
        guard generation >= minimumAcceptedGeneration else { return }
        let revisionKey = Self.messageRevisionKey(
            scopeId: scopeId,
            conversationId: conversationId
        )
        guard revision >= (latestMessageRevisionByConversation[revisionKey] ?? 0) else { return }
        latestMessageRevisionByConversation[revisionKey] = revision
        deleteMessages(scopeId: scopeId, conversationId: conversationId)
        let encoder = JSONEncoder()
        let now = Date()
        let visibleMessages = imChronologicallySortedMessages(
            messages.filter { $0.conversationId == conversationId }
        )
        for message in visibleMessages.suffix(messageLimit) {
            guard let payload = try? encoder.encode(CachedIMMessage(message: message)) else { continue }
            modelContext.insert(CachedIMDatabaseMessage(
                key: Self.messageKey(scopeId: scopeId, conversationId: conversationId, messageId: message.id),
                scopeId: scopeId,
                conversationId: conversationId,
                messageId: message.id,
                seq: message.seq,
                payload: payload,
                cachedAt: now
            ))
        }
        evictOldConversations(scopeId: scopeId, limit: conversationLimit)
        try? modelContext.save()
    }

    func pinnedMessages(scopeId: String, conversationId: String) -> [IMMessage] {
        let descriptor = FetchDescriptor<CachedIMPinnedMessage>(
            predicate: #Predicate {
                $0.scopeId == scopeId && $0.conversationId == conversationId
            },
            sortBy: [SortDescriptor(\CachedIMPinnedMessage.seq, order: .reverse)]
        )
        guard let rows = try? modelContext.fetch(descriptor) else { return [] }
        let decoder = JSONDecoder()
        return rows.compactMap { row in
            guard var message = (try? decoder.decode(CachedIMMessage.self, from: row.payload))?.message else {
                return nil
            }
            message.isPinned = true
            message.pinStateKnown = true
            return message
        }
    }

    func storePinnedMessages(
        scopeId: String,
        conversationId: String,
        messages: [IMMessage],
        generation: Int,
        revision: Int
    ) {
        guard generation >= minimumAcceptedGeneration else { return }
        let revisionKey = Self.pinnedRevisionKey(
            scopeId: scopeId,
            conversationId: conversationId
        )
        guard revision >= (latestPinnedRevisionByConversation[revisionKey] ?? 0) else { return }
        latestPinnedRevisionByConversation[revisionKey] = revision
        deletePinnedMessages(scopeId: scopeId, conversationId: conversationId)
        let encoder = JSONEncoder()
        let now = Date()
        for message in messages
            .filter({ $0.conversationId == conversationId && !$0.isDeleted })
            .sorted(by: { $0.seq > $1.seq }) {
            guard let payload = try? encoder.encode(CachedIMMessage(message: message)) else { continue }
            modelContext.insert(CachedIMPinnedMessage(
                key: Self.pinnedMessageKey(
                    scopeId: scopeId,
                    conversationId: conversationId,
                    messageId: message.id
                ),
                scopeId: scopeId,
                conversationId: conversationId,
                messageId: message.id,
                seq: message.seq,
                payload: payload,
                cachedAt: now
            ))
        }
        try? modelContext.save()
    }

    func clear(scopeId: String, conversationId: String, revision: Int) {
        let revisionKey = Self.messageRevisionKey(
            scopeId: scopeId,
            conversationId: conversationId
        )
        guard revision >= (latestMessageRevisionByConversation[revisionKey] ?? 0) else { return }
        latestMessageRevisionByConversation[revisionKey] = revision
        deleteMessages(scopeId: scopeId, conversationId: conversationId)
        deleteReadState(scopeId: scopeId, conversationId: conversationId)
        try? modelContext.save()
    }

    func advanceReadWaterline(
        scopeId: String,
        conversationId: String,
        readerId: String,
        seq: Int
    ) {
        let key = Self.waterlineKey(scopeId: scopeId, conversationId: conversationId, readerId: readerId)
        let descriptor = FetchDescriptor<CachedIMReadWaterline>(
            predicate: #Predicate { $0.key == key }
        )
        if let existing = try? modelContext.fetch(descriptor).first {
            guard seq > existing.seq else { return }
            existing.seq = seq
            existing.updatedAt = Date()
        } else {
            modelContext.insert(CachedIMReadWaterline(
                key: key,
                scopeId: scopeId,
                conversationId: conversationId,
                readerId: readerId,
                seq: seq,
                updatedAt: Date()
            ))
        }
        try? modelContext.save()
    }

    func readWaterlines(scopeId: String, conversationId: String) -> [String: Int] {
        let descriptor = FetchDescriptor<CachedIMReadWaterline>(
            predicate: #Predicate {
                $0.scopeId == scopeId && $0.conversationId == conversationId
            }
        )
        guard let rows = try? modelContext.fetch(descriptor) else { return [:] }
        return Dictionary(rows.map { ($0.readerId, $0.seq) }, uniquingKeysWith: max)
    }

    func clearReadState(scopeId: String, conversationId: String) {
        deleteReadState(scopeId: scopeId, conversationId: conversationId)
        try? modelContext.save()
    }

    func clearAll(generation: Int) {
        minimumAcceptedGeneration = max(minimumAcceptedGeneration, generation)
        if let rows = try? modelContext.fetch(FetchDescriptor<CachedIMDatabaseMessage>()) {
            rows.forEach(modelContext.delete)
        }
        if let rows = try? modelContext.fetch(FetchDescriptor<CachedIMReadWaterline>()) {
            rows.forEach(modelContext.delete)
        }
        if let rows = try? modelContext.fetch(FetchDescriptor<CachedIMPinnedMessage>()) {
            rows.forEach(modelContext.delete)
        }
        try? modelContext.save()
    }

    private func deleteMessages(scopeId: String, conversationId: String) {
        let descriptor = FetchDescriptor<CachedIMDatabaseMessage>(
            predicate: #Predicate {
                $0.scopeId == scopeId && $0.conversationId == conversationId
            }
        )
        (try? modelContext.fetch(descriptor))?.forEach(modelContext.delete)
    }

    private func deleteReadState(scopeId: String, conversationId: String) {
        let descriptor = FetchDescriptor<CachedIMReadWaterline>(
            predicate: #Predicate {
                $0.scopeId == scopeId && $0.conversationId == conversationId
            }
        )
        (try? modelContext.fetch(descriptor))?.forEach(modelContext.delete)
    }

    private func deletePinnedMessages(scopeId: String, conversationId: String) {
        let descriptor = FetchDescriptor<CachedIMPinnedMessage>(
            predicate: #Predicate {
                $0.scopeId == scopeId && $0.conversationId == conversationId
            }
        )
        (try? modelContext.fetch(descriptor))?.forEach(modelContext.delete)
    }

    private func evictOldConversations(scopeId: String, limit: Int) {
        let descriptor = FetchDescriptor<CachedIMDatabaseMessage>(
            predicate: #Predicate { $0.scopeId == scopeId },
            sortBy: [SortDescriptor(\CachedIMDatabaseMessage.cachedAt, order: .reverse)]
        )
        guard let rows = try? modelContext.fetch(descriptor) else { return }
        var latestByConversation: [String: Date] = [:]
        for row in rows {
            latestByConversation[row.conversationId] = max(
                latestByConversation[row.conversationId] ?? .distantPast,
                row.cachedAt
            )
        }
        guard latestByConversation.count > limit else { return }
        let keep = Set(latestByConversation.sorted { $0.value > $1.value }.prefix(limit).map(\.key))
        let evictedConversationIds = Set(rows.lazy
            .map(\.conversationId)
            .filter { !keep.contains($0) })
        rows.filter { evictedConversationIds.contains($0.conversationId) }.forEach(modelContext.delete)
        guard !evictedConversationIds.isEmpty else { return }
        let readRows = try? modelContext.fetch(FetchDescriptor<CachedIMReadWaterline>(
            predicate: #Predicate { $0.scopeId == scopeId }
        ))
        readRows?
            .filter { evictedConversationIds.contains($0.conversationId) }
            .forEach(modelContext.delete)
        let pinnedRows = try? modelContext.fetch(FetchDescriptor<CachedIMPinnedMessage>(
            predicate: #Predicate { $0.scopeId == scopeId }
        ))
        pinnedRows?
            .filter { evictedConversationIds.contains($0.conversationId) }
            .forEach(modelContext.delete)
    }

    private static func messageKey(scopeId: String, conversationId: String, messageId: Int) -> String {
        "\(scopeId):\(conversationId):message:\(messageId)"
    }

    private static func waterlineKey(scopeId: String, conversationId: String, readerId: String) -> String {
        "\(scopeId):\(conversationId):reader:\(readerId)"
    }

    private static func pinnedMessageKey(scopeId: String, conversationId: String, messageId: Int) -> String {
        "\(scopeId):\(conversationId):pinned:\(messageId)"
    }

    private static func messageRevisionKey(scopeId: String, conversationId: String) -> String {
        "\(scopeId)\u{0}\(conversationId)"
    }

    private static func pinnedRevisionKey(scopeId: String, conversationId: String) -> String {
        "\(scopeId)\u{0}\(conversationId)"
    }
}

/// IM 持久缓存模块：SwiftData 只承载可重建的消息快照与已读水位。
/// 数据库访问收口在 ModelActor，避免主线程阻塞和跨 actor 复用 ModelContext。
@MainActor
final class IMMessageDatabaseCache: IMMessageSnapshotCache, IMPinnedMessageSnapshotCache, IMReadStateCache {
    static let shared = IMMessageDatabaseCache()

    private let worker: IMMessageDatabaseWorker?
    private let maxMessagesPerConversation: Int
    private let maxConversations: Int
    private let scopeIdProvider: @MainActor () -> String
    private var operationGeneration = 0
    private var messageRevisionByConversation: [String: Int] = [:]
    private var pinnedRevisionByConversation: [String: Int] = [:]

    init(
        isStoredInMemoryOnly: Bool = false,
        maxMessagesPerConversation: Int = 100,
        maxConversations: Int = 50,
        scopeIdProvider: @escaping @MainActor () -> String = {
            let userId = AuthService.shared.currentUser?.id.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return userId.isEmpty ? "anonymous" : userId
        }
    ) {
        self.maxMessagesPerConversation = max(maxMessagesPerConversation, 1)
        self.maxConversations = max(maxConversations, 1)
        self.scopeIdProvider = scopeIdProvider
        do {
            let schema = Schema([
                CachedIMDatabaseMessage.self,
                CachedIMPinnedMessage.self,
                CachedIMReadWaterline.self,
            ])
            let configuration = ModelConfiguration(
                "TabTinIMCache",
                schema: schema,
                isStoredInMemoryOnly: isStoredInMemoryOnly,
                allowsSave: true
            )
            let container = try ModelContainer(for: schema, configurations: [configuration])
            worker = IMMessageDatabaseWorker(modelContainer: container)
        } catch {
            worker = nil
        }
    }

    /// 构造 Store 时只读进程内缓存；数据库首帧后通过 messagesAsync hydrate，绝不阻塞主线程。
    func messages(conversationId: String) -> [IMMessage] { [] }

    func store(conversationId: String, messages: [IMMessage]) {
        store(scopeId: resolvedScopeId(), conversationId: conversationId, messages: messages)
    }

    func clear(conversationId: String) {
        clear(scopeId: resolvedScopeId(), conversationId: conversationId)
    }

    func pinnedMessages(conversationId: String) -> [IMMessage] { [] }

    func storePinnedMessages(conversationId: String, messages: [IMMessage]) {
        storePinnedMessages(
            scopeId: resolvedScopeId(),
            conversationId: conversationId,
            messages: messages
        )
    }

    func messagesAsync(scopeId: String, conversationId: String) async -> [IMMessage] {
        guard let worker else { return [] }
        return await worker.messages(
            scopeId: normalizeScopeId(scopeId),
            conversationId: conversationId,
            limit: maxMessagesPerConversation
        )
    }

    func pinnedMessagesAsync(scopeId: String, conversationId: String) async -> [IMMessage] {
        guard let worker else { return [] }
        return await worker.pinnedMessages(
            scopeId: normalizeScopeId(scopeId),
            conversationId: conversationId
        )
    }

    func store(scopeId: String, conversationId: String, messages: [IMMessage]) {
        guard let worker else { return }
        let normalizedScopeId = normalizeScopeId(scopeId)
        let messageLimit = maxMessagesPerConversation
        let conversationLimit = maxConversations
        let generation = operationGeneration
        let revisionKey = "\(normalizedScopeId)\u{0}\(conversationId)"
        let revision = (messageRevisionByConversation[revisionKey] ?? 0) + 1
        messageRevisionByConversation[revisionKey] = revision
        Task {
            await worker.store(
                scopeId: normalizedScopeId,
                conversationId: conversationId,
                messages: messages,
                messageLimit: messageLimit,
                conversationLimit: conversationLimit,
                generation: generation,
                revision: revision
            )
        }
    }

    func clear(scopeId: String, conversationId: String) {
        guard let worker else { return }
        let normalizedScopeId = normalizeScopeId(scopeId)
        let revisionKey = "\(normalizedScopeId)\u{0}\(conversationId)"
        let revision = (messageRevisionByConversation[revisionKey] ?? 0) + 1
        messageRevisionByConversation[revisionKey] = revision
        Task {
            await worker.clear(
                scopeId: normalizedScopeId,
                conversationId: conversationId,
                revision: revision
            )
        }
    }

    func storePinnedMessages(scopeId: String, conversationId: String, messages: [IMMessage]) {
        guard let worker else { return }
        let normalizedScopeId = normalizeScopeId(scopeId)
        let generation = operationGeneration
        let revisionKey = "\(normalizedScopeId)\u{0}\(conversationId)"
        let revision = (pinnedRevisionByConversation[revisionKey] ?? 0) + 1
        pinnedRevisionByConversation[revisionKey] = revision
        Task {
            await worker.storePinnedMessages(
                scopeId: normalizedScopeId,
                conversationId: conversationId,
                messages: messages,
                generation: generation,
                revision: revision
            )
        }
    }

    func advanceReadWaterline(
        scopeId: String,
        conversationId: String,
        readerId: String,
        seq: Int
    ) {
        guard let worker, seq > 0 else { return }
        let normalizedReaderId = readerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedReaderId.isEmpty else { return }
        let normalizedScopeId = normalizeScopeId(scopeId)
        Task {
            await worker.advanceReadWaterline(
                scopeId: normalizedScopeId,
                conversationId: conversationId,
                readerId: normalizedReaderId,
                seq: seq
            )
        }
    }

    func readWaterlinesAsync(scopeId: String, conversationId: String) async -> [String: Int] {
        guard let worker else { return [:] }
        return await worker.readWaterlines(
            scopeId: normalizeScopeId(scopeId),
            conversationId: conversationId
        )
    }

    func clearReadState(scopeId: String, conversationId: String) {
        guard let worker else { return }
        let normalizedScopeId = normalizeScopeId(scopeId)
        Task { await worker.clearReadState(scopeId: normalizedScopeId, conversationId: conversationId) }
    }

    func clearAll() {
        guard let worker else { return }
        operationGeneration += 1
        let generation = operationGeneration
        Task { await worker.clearAll(generation: generation) }
    }

    private func resolvedScopeId() -> String { normalizeScopeId(scopeIdProvider()) }

    private func normalizeScopeId(_ scopeId: String) -> String {
        let normalized = scopeId.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? "anonymous" : normalized
    }
}

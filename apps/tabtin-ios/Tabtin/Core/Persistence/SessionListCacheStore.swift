import Foundation
@preconcurrency import SwiftData

/// 会话列表的本地缓存行（SwiftData 持久化）。一行 = 一个「作用域」的整张列表快照（JSON）。
///
/// 作用域 `scope` 区分两类列表：
/// - `"recent:<organizationId>"`：「最近」tab 的跨 Space 聚合（`[RecentSession]`）。
/// - `"space:<spaceId>"`：单个 Space 下的会话列表（`[ChatSession]`）。
///
/// 整张列表编码成一个 JSON `Data` 单行存（非每会话一行）——列表本就整体替换、需保序，
/// 单行快照最简单且天然保序；按作用域级 LRU 淘汰。
@Model
nonisolated final class CachedSessionList {
    @Attribute(.unique) var scope: String
    /// `[RecentSession]` 或 `[ChatSession]` 的 JSON 编码。
    var data: Data
    /// 写入时间，用于作用域级 LRU 淘汰。
    var cachedAt: Date

    init(scope: String, data: Data) {
        self.scope = scope
        self.data = data
        self.cachedAt = Date()
    }
}

/// 会话列表本地缓存（offline-first：进列表先秒显缓存、再 HTTP 对账，根治列表「刷一下」）。
///
/// 与 `MessageCacheStore` 同构的取舍：读同步（首帧即时播种）、写异步（不阻塞 UI）、
/// 整作用域快照替换、作用域级 LRU、登出 `clearAll()`。用**独立 store 文件**与消息缓存隔离，
/// 避免两个 `ModelContainer` 撞同一默认 store。
final class SessionListCacheStore: @unchecked Sendable {
    static let shared = SessionListCacheStore()

    private var container: ModelContainer?
    private let queue = DispatchQueue(label: "com.tabtin.mobile.sessionlistcache", qos: .utility)
    private let maxScopes = 40

    private init() {
        do {
            let schema = Schema([CachedSessionList.self])
            let url = URL.applicationSupportDirectory.appending(path: "TabtinSessionListCache.store")
            let config = ModelConfiguration(schema: schema, url: url)
            container = try ModelContainer(for: schema, configurations: [config])
        } catch {
            print("[SessionListCacheStore] failed to create container: \(error)")
            container = nil
        }
    }

    // MARK: - Recent（跨 Space 聚合）

    @MainActor
    func recent(organizationId: String) -> [RecentSession] {
        load(scope: "recent:\(organizationId)")
    }

    func cacheRecent(organizationId: String, sessions: [RecentSession]) {
        store(scope: "recent:\(organizationId)", value: sessions)
    }

    // MARK: - Space（单 Space 会话列表）

    @MainActor
    func spaceSessions(spaceId: String) -> [ChatSession] {
        load(scope: "space:\(spaceId)")
    }

    func cacheSpaceSessions(spaceId: String, sessions: [ChatSession]) {
        store(scope: "space:\(spaceId)", value: sessions)
    }

    /// 权威归档成功后，按明确的 Organization / Space 作用域同步两张离线快照。
    /// 不依赖当前选中的组织，避免从会话页返回时旧缓存把已归档项重新播种出来。
    @MainActor
    func markArchived(
        sessionId: String,
        organizationId: String,
        spaceId: String,
        recentSnapshot: [RecentSession]?
    ) {
        let updatedRecent: [RecentSession]
        if let recentSnapshot {
            // 当前默认目录仍存活时，它比磁盘快照更新，优先使用，避免回写旧字段。
            updatedRecent = recentSnapshot
        } else {
            updatedRecent = recent(organizationId: organizationId)
                .filter { $0.id != sessionId }
        }
        let updatedSpace: [ChatSession] = spaceSessions(spaceId: spaceId)
            .filter { $0.id != sessionId }
        cacheRecent(organizationId: organizationId, sessions: updatedRecent)
        cacheSpaceSessions(spaceId: spaceId, sessions: updatedSpace)
    }

    // MARK: - 通用读写

    @MainActor
    private func load<T: Decodable>(scope: String) -> [T] {
        guard let container else { return [] }
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<CachedSessionList>(
            predicate: #Predicate { $0.scope == scope }
        )
        guard let row = try? context.fetch(descriptor).first,
              let decoded = try? JSONDecoder().decode([T].self, from: row.data) else { return [] }
        return decoded
    }

    private func store<T: Encodable>(scope: String, value: [T]) {
        // 空列表也必须覆盖旧快照：会话刚被归档时，否则下次进列表会先闪回已归档项。
        guard let container,
              let data = try? JSONEncoder().encode(value) else { return }
        queue.async { [weak self] in
            let context = ModelContext(container)
            self?.deleteRow(scope: scope, in: context)
            context.insert(CachedSessionList(scope: scope, data: data))
            try? context.save()
            self?.evictOldScopes(using: context)
        }
    }

    func clearAll() {
        guard let container else { return }
        queue.async {
            let context = ModelContext(container)
            let descriptor = FetchDescriptor<CachedSessionList>()
            guard let rows = try? context.fetch(descriptor) else { return }
            for row in rows { context.delete(row) }
            try? context.save()
        }
    }

    // MARK: - Private

    private func deleteRow(scope: String, in context: ModelContext) {
        let descriptor = FetchDescriptor<CachedSessionList>(
            predicate: #Predicate { $0.scope == scope }
        )
        guard let rows = try? context.fetch(descriptor) else { return }
        for row in rows { context.delete(row) }
    }

    private func evictOldScopes(using context: ModelContext) {
        let descriptor = FetchDescriptor<CachedSessionList>(
            sortBy: [SortDescriptor(\.cachedAt, order: .reverse)]
        )
        guard let all = try? context.fetch(descriptor), all.count > maxScopes else { return }
        for row in all.dropFirst(maxScopes) { context.delete(row) }
        try? context.save()
    }
}

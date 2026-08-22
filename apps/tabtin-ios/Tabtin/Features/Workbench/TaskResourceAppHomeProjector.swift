import Foundation

// MARK: - App 范围

enum TaskWorkbenchContinueWindowPolicy {
    static func appKind(for resourceType: String) -> TaskResourceAppKind? {
        TaskResourceAppKind(rawValue: SpaceResource.normalizedType(resourceType))
    }

    static func usesContinueProcessingCard(for resourceType: String) -> Bool {
        appKind(for: resourceType) != nil
    }

    static func item(from output: TaskWorkbenchOutput) -> TaskResourceAppHomeItem {
        TaskResourceAppHomeItem(
            resourceType: SpaceResource.normalizedType(output.resourceType),
            resourceId: output.resourceId,
            title: output.title,
            subtitle: output.typeLabel,
            preview: output.preview,
            summary: nil,
            source: .deliverable,
            isPendingSync: !output.canOpen,
            canOpen: output.canOpen,
            isPrimary: true,
            contextItemId: output.resource?.id,
            organizationId: output.resource?.organizationId,
            resourceSpaceId: output.resource?.spaceId,
            lastVisitedAt: nil,
            updatedAt: output.timestamp
        )
    }
}

enum TaskResourceAppKind: String, Equatable, Sendable {
    case tabdoc
    case tabdata

    var resourceType: String { rawValue }

    var title: String {
        switch self {
        case .tabdoc: return L10n.WorkbenchAppHome.docTitle
        case .tabdata: return L10n.WorkbenchAppHome.tableTitle
        }
    }

    var continueActionTitle: String {
        switch self {
        case .tabdoc: return L10n.WorkbenchAppHome.continueWrite
        case .tabdata: return L10n.WorkbenchAppHome.continueHandle
        }
    }

    var agentActionTitle: String {
        switch self {
        case .tabdoc: return L10n.WorkbenchAppHome.agentDraft
        case .tabdata: return L10n.WorkbenchAppHome.agentBuild
        }
    }
}

enum TaskResourceAppHomeSource: String, Equatable, Sendable {
    case candidate
    case deliverable
    case pendingOverlay
    /// Task 投影为空时，用组织最近资源恢复工作；不冒充当前 Task 产出。
    case library
}

struct TaskResourceIdentity: Hashable, Sendable {
    let resourceType: String
    let resourceId: String

    init(resourceType: String, resourceId: String) {
        self.resourceType = SpaceResource.normalizedType(resourceType)
        self.resourceId = resourceId
    }
}

struct TaskResourceAppHomeSummary: Equatable, Sendable {
    var recordCount: Int?
    var fieldCount: Int?
    var fieldNames: [String]?
}

/// 首页投影输入（纯值）。Task 2 wire DTO 可映射到此结构。
struct TaskResourceAppHomeResource: Equatable, Sendable, Identifiable {
    var contextItemId: String?
    var resourceType: String
    var resourceId: String
    var title: String
    var preview: String?
    var summary: TaskResourceAppHomeSummary?
    var organizationId: String
    var resourceSpaceId: String?
    var source: TaskResourceAppHomeSource
    var taskRunId: String?
    var isPrimary: Bool
    var canOpen: Bool
    var createdAt: Date?
    var updatedAt: Date?
    var lastVisitedAt: Date?

    var id: String { "\(SpaceResource.normalizedType(resourceType)):\(resourceId)" }

    var identity: TaskResourceIdentity {
        TaskResourceIdentity(resourceType: resourceType, resourceId: resourceId)
    }
}

struct TaskResourceAppHomePendingOverlay: Equatable, Sendable {
    var resourceType: String
    var resourceId: String
    var title: String
    var preview: String?

    var identity: TaskResourceIdentity {
        TaskResourceIdentity(resourceType: resourceType, resourceId: resourceId)
    }
}

struct TaskResourceAppHomeItem: Equatable, Sendable, Identifiable {
    var resourceType: String
    var resourceId: String
    var title: String
    var subtitle: String?
    /// 小窗预览只消费服务端白名单字段；不能从 subtitle 反解析业务数据。
    var preview: String?
    var summary: TaskResourceAppHomeSummary?
    var source: TaskResourceAppHomeSource
    var isPendingSync: Bool
    var canOpen: Bool
    var isPrimary: Bool
    var contextItemId: String?
    var organizationId: String?
    var resourceSpaceId: String?
    var lastVisitedAt: Date?
    var updatedAt: Date?

    var id: String { "\(resourceType):\(resourceId)" }

    var identity: TaskResourceIdentity {
        TaskResourceIdentity(resourceType: resourceType, resourceId: resourceId)
    }
}

// MARK: - 组织资源库

/// App 首页下半区的组织资源范围。Task 资源和组织资源是两套归属语义，不能混用。
enum TaskResourceLibraryScope: String, CaseIterable, Identifiable, Equatable, Hashable, Sendable {
    case recent
    case all
    case shared

    var id: String { rawValue }

    var title: String {
        switch self {
        case .recent: return L10n.CloudDocs.browseRecent
        case .all: return L10n.CloudDocs.browseAll
        case .shared: return L10n.CloudDocs.browseShared
        }
    }
}

enum TaskResourceLibrarySource: String, Equatable, Sendable {
    case owned
    case shared
}

/// “你的文档 / 你的多维表”展示与打开所需的最小真实投影。
struct TaskResourceLibraryItem: Equatable, Sendable, Identifiable {
    var resourceType: String
    var resourceId: String
    var title: String
    var subtitle: String?
    var preview: String?
    var source: TaskResourceLibrarySource
    var contextItemId: String?
    var organizationId: String?
    var resourceSpaceId: String?
    var spaceName: String?
    var canOpen: Bool
    var isPinned: Bool
    var lastVisitedAt: Date?
    var updatedAt: Date?

    var id: String { "\(source.rawValue):\(resourceType):\(resourceId)" }

    var identity: TaskResourceIdentity {
        TaskResourceIdentity(resourceType: resourceType, resourceId: resourceId)
    }
}

struct TaskResourceLibrarySnapshot: Equatable, Sendable {
    var scope: TaskResourceLibraryScope
    var items: [TaskResourceLibraryItem]
    /// 截断前的命中数，用于决定是否展示“查看全部”。
    var totalCount: Int
    var searchQuery: String
}

/// 组织级云文档数据的轻量投影。输入已经由快速入口数据源按类型和范围分页。
enum TaskResourceLibraryProjector {
    static let recentDisplayLimit = 3

    static func project(
        appKind: TaskResourceAppKind,
        scope: TaskResourceLibraryScope,
        resources: [SpaceResource],
        sharedResources: [SharedResourceItem],
        searchQuery: String,
        totalCount: Int? = nil,
        excludingIdentity: TaskResourceIdentity? = nil
    ) -> TaskResourceLibrarySnapshot {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let unfiltered: [TaskResourceLibraryItem]

        switch scope {
        case .recent:
            // 服务端 Recent 本身已经按访问时间返回；同一时间戳下保留它（以及本地
            // optimistic overlay）的输入顺序，避免秒级时间精度把刚打开的资源按标题
            // 或 id 重新洗牌。
            unfiltered = resources.enumerated()
                .filter { $0.element.normalizedType == appKind.resourceType }
                .filter { $0.element.lastVisitedAt?.isEmpty == false }
                .map { (sourceIndex: $0.offset, item: makeOwnedItem($0.element)) }
                .sorted { lhs, rhs in
                    recentSort(
                        lhs.item,
                        rhs.item,
                        lhsSourceIndex: lhs.sourceIndex,
                        rhsSourceIndex: rhs.sourceIndex
                    )
                }
                .map(\.item)
        case .all:
            unfiltered = resources
                .filter { $0.normalizedType == appKind.resourceType }
                .map(makeOwnedItem)
                .sorted(by: allSort)
        case .shared:
            unfiltered = sharedResources
                .filter { sharedType($0) == appKind.resourceType }
                .map(makeSharedItem)
                .sorted(by: updatedSort)
        }

        let deduplicated = deduplicate(unfiltered)
        let available = deduplicated.filter { item in
            item.identity != excludingIdentity
        }
        let matches = query.isEmpty
            ? available
            : available.filter { item in
                item.title.lowercased().contains(query)
                    || item.subtitle?.lowercased().contains(query) == true
                    || item.preview?.lowercased().contains(query) == true
            }
        // 工作台这里只承担“快速恢复入口”，完整浏览由右上角知识库入口承载。
        // 三个范围都保持紧凑，避免把组织资源库整页复制进任务工作台。
        let visible = Array(matches.prefix(recentDisplayLimit))

        return TaskResourceLibrarySnapshot(
            scope: scope,
            items: visible,
            totalCount: totalCount ?? matches.count,
            searchQuery: searchQuery
        )
    }

    private static func makeOwnedItem(_ resource: SpaceResource) -> TaskResourceLibraryItem {
        let edited = resource.updatedAt.flatMap { RelativeTime.format($0) }
        let subtitle = [resource.spaceName, edited]
            .compactMap { normalizedText($0) }
            .joined(separator: " · ")
        return TaskResourceLibraryItem(
            resourceType: resource.normalizedType,
            resourceId: resource.resourceId,
            title: resource.displayTitle,
            subtitle: subtitle.isEmpty ? normalizedText(resource.preview) : subtitle,
            preview: normalizedText(resource.preview),
            source: .owned,
            contextItemId: resource.id,
            organizationId: normalizedText(resource.organizationId),
            resourceSpaceId: normalizedText(resource.spaceId),
            spaceName: resource.spaceName,
            canOpen: resource.canView != false && resource.appRoute != nil,
            isPinned: resource.isPinned == true,
            lastVisitedAt: resource.lastVisitedAt.flatMap { ISO8601DateParser.date(from: $0) },
            updatedAt: resource.updatedAt.flatMap { ISO8601DateParser.date(from: $0) }
        )
    }

    private static func makeSharedItem(_ resource: SharedResourceItem) -> TaskResourceLibraryItem {
        let owner = resource.sharedBy?.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = owner.flatMap { $0.isEmpty ? nil : L10n.CloudDocs.sharedBy($0) }
            ?? resource.updatedAt.flatMap { RelativeTime.format($0) }
        return TaskResourceLibraryItem(
            resourceType: sharedType(resource) ?? "",
            resourceId: resource.resourceId,
            title: resource.displayTitle,
            subtitle: subtitle,
            preview: normalizedText(resource.preview),
            source: .shared,
            contextItemId: resource.contextItemId,
            organizationId: normalizedText(resource.organizationId),
            resourceSpaceId: normalizedText(resource.spaceId),
            spaceName: nil,
            canOpen: resource.canView != false && resource.appRoute != nil,
            isPinned: false,
            lastVisitedAt: nil,
            updatedAt: resource.updatedAt.flatMap { ISO8601DateParser.date(from: $0) }
        )
    }

    private static func sharedType(_ resource: SharedResourceItem) -> String? {
        switch resource.resourceType {
        case .doc: return TaskResourceAppKind.tabdoc.resourceType
        case .table: return TaskResourceAppKind.tabdata.resourceType
        case .file: return nil
        }
    }

    private static func deduplicate(
        _ items: [TaskResourceLibraryItem]
    ) -> [TaskResourceLibraryItem] {
        var seen: Set<TaskResourceIdentity> = []
        return items.filter { seen.insert($0.identity).inserted }
    }

    private static func recentSort(
        _ lhs: TaskResourceLibraryItem,
        _ rhs: TaskResourceLibraryItem,
        lhsSourceIndex: Int,
        rhsSourceIndex: Int
    ) -> Bool {
        let left = lhs.lastVisitedAt ?? .distantPast
        let right = rhs.lastVisitedAt ?? .distantPast
        if left != right { return left > right }
        let leftUpdated = lhs.updatedAt ?? .distantPast
        let rightUpdated = rhs.updatedAt ?? .distantPast
        if leftUpdated != rightUpdated { return leftUpdated > rightUpdated }
        return lhsSourceIndex < rhsSourceIndex
    }

    private static func allSort(
        _ lhs: TaskResourceLibraryItem,
        _ rhs: TaskResourceLibraryItem
    ) -> Bool {
        if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
        return updatedSort(lhs, rhs)
    }

    private static func updatedSort(
        _ lhs: TaskResourceLibraryItem,
        _ rhs: TaskResourceLibraryItem
    ) -> Bool {
        let left = lhs.updatedAt ?? .distantPast
        let right = rhs.updatedAt ?? .distantPast
        if left != right { return left > right }
        if lhs.title != rhs.title {
            let titleOrder = lhs.title.localizedCaseInsensitiveCompare(rhs.title)
            if titleOrder != .orderedSame {
                return titleOrder == .orderedAscending
            }
        }
        return lhs.resourceId < rhs.resourceId
    }

    private static func normalizedText(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

// MARK: - 组织资源快速入口数据源

/// 工作台下半区只取每个范围的前三条预览；完整资源库由 CloudDocs 一级入口承载。
///
/// 这里不用 `CloudDocsViewModel.allRecentItems`：那个数组是云文档主入口的辅助缓存，
/// 既混合类型又只有首个 100 条。快速入口必须在分页前按 App 类型过滤，并让“最近”
/// 使用服务端的 per-user `visited_only` 排序，才能避免大组织里文档被其它资源挤掉。
@MainActor @Observable
final class TaskResourceLibraryViewModel {
    /// 多取一条给顶部“继续”卡去重，列表仍由 projector 限制为三条。
    static let previewPageSize = TaskResourceLibraryProjector.recentDisplayLimit + 1

    let organizationId: String
    let appKind: TaskResourceAppKind

    private(set) var resourcesByScope: [TaskResourceLibraryScope: [SpaceResource]] = [:]
    private(set) var sharedResources: [SharedResourceItem] = []
    private(set) var totalCounts: [TaskResourceLibraryScope: Int] = [:]
    private(set) var loadingScopes: Set<TaskResourceLibraryScope> = []
    private(set) var errorMessages: [TaskResourceLibraryScope: String] = [:]

    private var loadedQueries: [TaskResourceLibraryScope: String] = [:]
    private var requestGenerations: [TaskResourceLibraryScope: Int] = [:]
    /// 打开资源后立即置顶，但不能把这次本地写入冒充成一次成功的 Recent 请求。
    /// 独立 overlay 也能避免在途请求用旧响应覆盖刚刚发生的访问。
    private var optimisticRecentResources: [SpaceResource] = []

    init(organizationId: String, appKind: TaskResourceAppKind) {
        self.organizationId = organizationId
        self.appKind = appKind
    }

    func resources(for scope: TaskResourceLibraryScope) -> [SpaceResource] {
        resourcesByScope[scope] ?? []
    }

    func totalCount(for scope: TaskResourceLibraryScope) -> Int {
        totalCounts[scope] ?? 0
    }

    func isLoading(_ scope: TaskResourceLibraryScope) -> Bool {
        loadingScopes.contains(scope)
    }

    func errorMessage(for scope: TaskResourceLibraryScope) -> String? {
        errorMessages[scope]
    }

    func load(
        scope: TaskResourceLibraryScope,
        searchQuery: String,
        force: Bool = false
    ) async {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if !force, loadedQueries[scope] == query {
            return
        }

        let generation = (requestGenerations[scope] ?? 0) + 1
        requestGenerations[scope] = generation
        loadingScopes.insert(scope)
        errorMessages.removeValue(forKey: scope)
        defer {
            if requestGenerations[scope] == generation {
                loadingScopes.remove(scope)
            }
        }

        if loadedQueries[scope] != query {
            // 当前快照即将被清空，旧查询也必须同步失效；否则 A→B→A 快速切换时
            // 第二次 A 会命中旧 loaded 标记，却只看到为 B 清空后的空列表。
            loadedQueries.removeValue(forKey: scope)
            resourcesByScope[scope] = []
            if scope == .shared { sharedResources = [] }
            totalCounts[scope] = 0
        }

        do {
            switch scope {
            case .all, .recent:
                let response = try await loadOwned(scope: scope, searchQuery: query)
                guard requestGenerations[scope] == generation else { return }
                let loadedItems = scope == .recent && query.isEmpty
                    ? mergeOptimisticRecent(with: response.items)
                    : response.items
                resourcesByScope[scope] = loadedItems
                totalCounts[scope] = max(response.total ?? response.items.count, loadedItems.count)
            case .shared:
                let matchingType: [SharedResourceItem]
                let hasMore: Bool
                do {
                    let response = try await CloudDriveRepository.listSharedFeed(
                        organizationId: organizationId,
                        itemTypes: appKind.resourceType,
                        cursor: nil,
                        limit: Self.previewPageSize
                    )
                    matchingType = response.items.map { $0.asSharedResourceItem() }
                    hasMore = response.nextCursor?.isEmpty == false
                } catch where error.isHTTPNotFound {
                    // test / 滚动发布环境可能尚未提供统一 feed；只对真实路由 404 回退。
                    matchingType = try await SharedResourcesService.listSharedWithMe(
                        organizationId: organizationId,
                        resourceType: appKind == .tabdoc ? .doc : .table
                    )
                    hasMore = false
                }
                guard requestGenerations[scope] == generation else { return }
                let filtered = query.isEmpty
                    ? matchingType
                    : matchingType.filter {
                        $0.title.localizedCaseInsensitiveContains(query)
                            || $0.preview?.localizedCaseInsensitiveContains(query) == true
                    }
                sharedResources = Array(filtered.prefix(Self.previewPageSize))
                // shared-feed 是 cursor 契约，不返回精确 total；有下一页时保留“仍有更多”的下界。
                totalCounts[scope] = hasMore
                    ? max(filtered.count, Self.previewPageSize + 1)
                    : filtered.count
            }
            loadedQueries[scope] = query
        } catch {
            guard requestGenerations[scope] == generation else { return }
            guard !error.isCancellation else { return }
            errorMessages[scope] = Self.userMessage(for: error)
        }
    }

    /// 任务资源和组织资源共用同一 ContextItem。打开后先在本地 recent 置顶，
    /// 返回首页即可看到；访问上报失败不阻断真正的编辑器打开。
    func recordAccess(
        item: TaskResourceAppHomeItem,
        reportsToServer: Bool
    ) {
        guard let contextItemId = Self.normalized(item.contextItemId) else { return }
        optimisticallyInsertRecent(
            contextItemId: contextItemId,
            resourceType: item.resourceType,
            resourceId: item.resourceId,
            title: item.title,
            preview: item.preview,
            organizationId: item.organizationId,
            spaceId: item.resourceSpaceId,
            updatedAt: item.updatedAt,
            canOpen: item.canOpen
        )
        if reportsToServer {
            Task { await CloudDriveRepository.reportAccess(contextItemId: contextItemId) }
        }
    }

    func recordAccess(item: TaskResourceLibraryItem) {
        guard let contextItemId = Self.normalized(item.contextItemId) else { return }
        optimisticallyInsertRecent(
            contextItemId: contextItemId,
            resourceType: item.resourceType,
            resourceId: item.resourceId,
            title: item.title,
            preview: item.preview,
            organizationId: item.organizationId,
            spaceId: item.resourceSpaceId,
            updatedAt: item.updatedAt,
            canOpen: item.canOpen
        )
        Task { await CloudDriveRepository.reportAccess(contextItemId: contextItemId) }
    }

    private func loadOwned(
        scope: TaskResourceLibraryScope,
        searchQuery: String
    ) async throws -> SpaceResourceListResponse {
        if !searchQuery.isEmpty {
            return try await CloudDriveRepository.search(
                organizationId: organizationId,
                query: searchQuery,
                types: appKind.resourceType,
                page: 1,
                pageSize: Self.previewPageSize
            )
        }
        if scope == .recent {
            return try await CloudDriveRepository.listRecentItems(
                organizationId: organizationId,
                itemTypes: appKind.resourceType,
                page: 1,
                pageSize: Self.previewPageSize
            )
        }
        return try await APIClient.shared.get(
            path: Endpoints.Context.organizationContextItems(organizationId: organizationId),
            query: [
                "is_archived": "false",
                "item_types": appKind.resourceType,
                "page": "1",
                "page_size": "\(Self.previewPageSize)",
            ]
        )
    }

    private func optimisticallyInsertRecent(
        contextItemId: String,
        resourceType: String,
        resourceId: String,
        title: String,
        preview: String?,
        organizationId: String?,
        spaceId: String?,
        updatedAt: Date?,
        canOpen: Bool
    ) {
        let now = Date()
        var resource = SpaceResource(
            id: contextItemId,
            itemType: SpaceResource.normalizedType(resourceType),
            title: title,
            preview: preview,
            resourceId: resourceId,
            spaceId: spaceId,
            organizationId: Self.normalized(organizationId) ?? self.organizationId,
            metadata: nil,
            isArchived: false,
            isPinned: false,
            pinnedAt: nil,
            updatedAt: updatedAt.map(Self.timestampFormatter.string(from:)),
            createdAt: nil,
            spaceName: nil
        )
        resource.lastVisitedAt = Self.timestampFormatter.string(from: now)
        resource.canView = canOpen

        var recent = resourcesByScope[.recent] ?? []
        optimisticRecentResources.removeAll { $0.id == contextItemId }
        optimisticRecentResources.insert(resource, at: 0)
        optimisticRecentResources = Array(optimisticRecentResources.prefix(Self.previewPageSize))
        recent.removeAll { $0.id == contextItemId }
        recent.insert(resource, at: 0)
        resourcesByScope[.recent] = mergeOptimisticRecent(with: recent)
        totalCounts[.recent] = max(totalCounts[.recent] ?? 0, recent.count)
    }

    private func mergeOptimisticRecent(with loaded: [SpaceResource]) -> [SpaceResource] {
        var seen: Set<String> = []
        let merged = (optimisticRecentResources + loaded).filter {
            seen.insert($0.id).inserted
        }
        return Array(merged.prefix(Self.previewPageSize))
    }

    #if DEBUG
    func hasLoadedQueryForTest(
        _ scope: TaskResourceLibraryScope,
        searchQuery: String = ""
    ) -> Bool {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return loadedQueries[scope] == query
    }
    #endif

    private static let timestampFormatter = ISO8601DateFormatter()

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func userMessage(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

struct TaskResourceAppHomeSnapshot: Equatable, Sendable {
    var appKind: TaskResourceAppKind
    var title: String
    var continueActionTitle: String
    var agentActionTitle: String
    var continueItem: TaskResourceAppHomeItem?
    var items: [TaskResourceAppHomeItem]
    var searchQuery: String
}

// MARK: - Projector

/// 任务工作台「文档 / 多维表」App 首页纯投影。不依赖 API / Router / SwiftUI。
enum TaskResourceAppHomeProjector {
    private static let supportedTypes: Set<String> = [
        TaskResourceAppKind.tabdoc.rawValue,
        TaskResourceAppKind.tabdata.rawValue,
    ]

    static func project(
        appKind: TaskResourceAppKind,
        resources: [TaskResourceAppHomeResource],
        pendingOverlays: [TaskResourceAppHomePendingOverlay],
        currentlyOpen: TaskResourceIdentity?,
        searchQuery: String
    ) -> TaskResourceAppHomeSnapshot {
        let targetType = appKind.resourceType
        let merged = merge(
            appKind: appKind,
            resources: resources.filter { SpaceResource.normalizedType($0.resourceType) == targetType },
            pendingOverlays: pendingOverlays.filter {
                SpaceResource.normalizedType($0.resourceType) == targetType
            }
        )
        let continueItem = selectContinueItem(
            items: merged,
            currentlyOpen: currentlyOpen.flatMap { open in
                open.resourceType == targetType ? open : nil
            }
        )
        let sorted = sortItems(filter(items: merged, searchQuery: searchQuery))

        return TaskResourceAppHomeSnapshot(
            appKind: appKind,
            title: appKind.title,
            continueActionTitle: appKind.continueActionTitle,
            agentActionTitle: appKind.agentActionTitle,
            continueItem: continueItem,
            items: sorted,
            searchQuery: searchQuery
        )
    }

    /// 首屏“继续”优先当前 Task；Task 尚无投影时退到组织最近打开项。
    /// 这是恢复工作入口，不要求资源必须先被当前 Task 收录。
    static func resolveContinueItem(
        taskItem: TaskResourceAppHomeItem?,
        recentLibraryItems: [TaskResourceLibraryItem]
    ) -> TaskResourceAppHomeItem? {
        if let taskItem, taskItem.canOpen {
            return taskItem
        }
        guard let recent = recentLibraryItems.first(where: \.canOpen) else { return nil }
        return TaskResourceAppHomeItem(
            resourceType: recent.resourceType,
            resourceId: recent.resourceId,
            title: recent.title,
            subtitle: recent.subtitle ?? recent.preview,
            preview: recent.preview,
            summary: nil,
            source: .library,
            isPendingSync: false,
            canOpen: recent.canOpen,
            isPrimary: false,
            contextItemId: recent.contextItemId,
            organizationId: recent.organizationId,
            resourceSpaceId: recent.resourceSpaceId,
            lastVisitedAt: recent.lastVisitedAt,
            updatedAt: recent.updatedAt
        )
    }

    /// 白名单摘要：忽略错误类型与未知键，永不抛错。
    static func sanitizeSummary(_ raw: [String: Any]?) -> TaskResourceAppHomeSummary {
        guard let raw else {
            return TaskResourceAppHomeSummary(recordCount: nil, fieldCount: nil, fieldNames: nil)
        }
        var recordCount: Int?
        var fieldCount: Int?
        var fieldNames: [String]?

        if raw["record_count"] is Bool {
            // Bool 不能当数量
        } else if let value = raw["record_count"] as? Int {
            recordCount = value
        } else if let value = raw["record_count"] as? Double, value.rounded() == value {
            recordCount = Int(value)
        }

        if raw["field_count"] is Bool {
            // Bool 不能当数量
        } else if let value = raw["field_count"] as? Int {
            fieldCount = value
        } else if let value = raw["field_count"] as? Double, value.rounded() == value {
            fieldCount = Int(value)
        }

        if let value = raw["field_names"] as? [Any] {
            let names = value.compactMap { item -> String? in
                switch item {
                case let string as String:
                    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
                    return trimmed.isEmpty ? nil : trimmed
                case let number as NSNumber:
                    if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
                    return number.stringValue
                case let int as Int:
                    return String(int)
                case let double as Double:
                    return String(double)
                default:
                    return nil
                }
            }
            if !names.isEmpty {
                fieldNames = names
            }
        }

        return TaskResourceAppHomeSummary(
            recordCount: recordCount,
            fieldCount: fieldCount,
            fieldNames: fieldNames
        )
    }

    // MARK: Merge

    private static func merge(
        appKind: TaskResourceAppKind,
        resources: [TaskResourceAppHomeResource],
        pendingOverlays: [TaskResourceAppHomePendingOverlay]
    ) -> [TaskResourceAppHomeItem] {
        var byIdentity: [TaskResourceIdentity: TaskResourceAppHomeItem] = [:]

        for resource in resources {
            let type = SpaceResource.normalizedType(resource.resourceType)
            guard supportedTypes.contains(type), type == appKind.resourceType else { continue }
            let item = makeItem(from: resource, appKind: appKind, normalizedType: type)
            if let existing = byIdentity[item.identity] {
                byIdentity[item.identity] = prefer(existing, item)
            } else {
                byIdentity[item.identity] = item
            }
        }

        for overlay in pendingOverlays {
            let type = SpaceResource.normalizedType(overlay.resourceType)
            guard supportedTypes.contains(type), type == appKind.resourceType else { continue }
            let identity = TaskResourceIdentity(resourceType: type, resourceId: overlay.resourceId)
            if byIdentity[identity] != nil {
                continue
            }
            byIdentity[identity] = TaskResourceAppHomeItem(
                resourceType: type,
                resourceId: overlay.resourceId,
                title: overlay.title,
                subtitle: subtitle(appKind: appKind, preview: overlay.preview, summary: nil),
                preview: normalizedText(overlay.preview),
                summary: nil,
                source: .pendingOverlay,
                isPendingSync: true,
                canOpen: true,
                isPrimary: false,
                contextItemId: nil,
                organizationId: nil,
                resourceSpaceId: nil,
                lastVisitedAt: nil,
                updatedAt: nil
            )
        }

        return Array(byIdentity.values)
    }

    private static func prefer(
        _ lhs: TaskResourceAppHomeItem,
        _ rhs: TaskResourceAppHomeItem
    ) -> TaskResourceAppHomeItem {
        sourceRank(lhs.source) >= sourceRank(rhs.source) ? lhs : rhs
    }

    private static func sourceRank(_ source: TaskResourceAppHomeSource) -> Int {
        switch source {
        case .deliverable: return 2
        case .candidate: return 1
        case .pendingOverlay, .library: return 0
        }
    }

    private static func makeItem(
        from resource: TaskResourceAppHomeResource,
        appKind: TaskResourceAppKind,
        normalizedType: String
    ) -> TaskResourceAppHomeItem {
        TaskResourceAppHomeItem(
            resourceType: normalizedType,
            resourceId: resource.resourceId,
            title: resource.title,
            subtitle: subtitle(appKind: appKind, preview: resource.preview, summary: resource.summary),
            preview: normalizedText(resource.preview),
            summary: resource.summary,
            source: resource.source,
            isPendingSync: resource.source == .pendingOverlay,
            canOpen: resource.canOpen,
            isPrimary: resource.isPrimary,
            contextItemId: resource.contextItemId,
            organizationId: resource.organizationId,
            resourceSpaceId: resource.resourceSpaceId,
            lastVisitedAt: resource.lastVisitedAt,
            updatedAt: resource.updatedAt
        )
    }

    // MARK: Subtitle

    static func subtitle(
        appKind: TaskResourceAppKind,
        preview: String?,
        summary: TaskResourceAppHomeSummary?
    ) -> String? {
        switch appKind {
        case .tabdoc:
            return normalizedText(preview)
        case .tabdata:
            return tableSubtitle(summary)
        }
    }

    private static func tableSubtitle(_ summary: TaskResourceAppHomeSummary?) -> String? {
        guard let summary else { return nil }
        var parts: [String] = []
        if let recordCount = summary.recordCount {
            parts.append(L10n.WorkbenchAppHome.recordCount(recordCount))
        }
        if let fieldCount = summary.fieldCount {
            parts.append(L10n.WorkbenchAppHome.fieldCount(fieldCount))
        }
        if let names = summary.fieldNames?
            .map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) })
            .filter({ !$0.isEmpty }),
           !names.isEmpty {
            parts.append(ListFormatter.localizedString(byJoining: names))
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " · ")
    }

    private static func normalizedText(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: Continue

    private static func selectContinueItem(
        items: [TaskResourceAppHomeItem],
        currentlyOpen: TaskResourceIdentity?
    ) -> TaskResourceAppHomeItem? {
        let openableItems = items.filter(\.canOpen)
        guard !openableItems.isEmpty else { return nil }

        if let currentlyOpen,
           let openItem = openableItems.first(where: { $0.identity == currentlyOpen }) {
            return openItem
        }

        let confirmed = openableItems.filter { !$0.isPendingSync }
        guard !confirmed.isEmpty else { return nil }

        if let visited = confirmed
            .filter({ $0.lastVisitedAt != nil })
            .max(by: { lhs, rhs in
                let left = lhs.lastVisitedAt ?? .distantPast
                let right = rhs.lastVisitedAt ?? .distantPast
                if left != right { return left < right }
                return lhs.resourceId > rhs.resourceId
            }) {
            return visited
        }

        if let primary = confirmed
            .filter(\.isPrimary)
            .min(by: { $0.resourceId < $1.resourceId }) {
            return primary
        }

        return confirmed.max(by: { lhs, rhs in
            let left = lhs.updatedAt ?? .distantPast
            let right = rhs.updatedAt ?? .distantPast
            if left != right { return left < right }
            return lhs.resourceId > rhs.resourceId
        })
    }

    // MARK: Search / Sort

    private static func filter(
        items: [TaskResourceAppHomeItem],
        searchQuery: String
    ) -> [TaskResourceAppHomeItem] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return items }
        return items.filter { item in
            if item.title.lowercased().contains(query) { return true }
            if let subtitle = item.subtitle?.lowercased(), subtitle.contains(query) { return true }
            return false
        }
    }

    private static func sortItems(_ items: [TaskResourceAppHomeItem]) -> [TaskResourceAppHomeItem] {
        items.sorted { lhs, rhs in
            if lhs.isPendingSync != rhs.isPendingSync {
                return lhs.isPendingSync && !rhs.isPendingSync
            }
            if lhs.isPendingSync {
                return lhs.resourceId < rhs.resourceId
            }
            let left = lhs.updatedAt ?? .distantPast
            let right = rhs.updatedAt ?? .distantPast
            if left != right { return left > right }
            return lhs.resourceId < rhs.resourceId
        }
    }
}

import Foundation
import OSLog

/// 云文档的三个浏览分段，与 Electron 侧栏 browseView 一一对应。
enum CloudDocsBrowseView: String, CaseIterable, Identifiable, Hashable, Sendable {
    case all
    case recent
    case shared

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return L10n.CloudDocs.browseAll
        case .recent: return L10n.CloudDocs.browseRecent
        case .shared: return L10n.CloudDocs.browseShared
        }
    }
}

@MainActor @Observable
final class CloudDocsViewModel {
    /// 云文档域只收这两类，跟 Electron 的 item_types 口径一致。
    static let cloudDocItemTypes: Set<String> = ["tabdoc", "tabdata"]
    private static let itemTypesQuery = "tabdoc,tabdata"
    /// 与 Electron KNOWLEDGE_TREE_DEFAULT_DEPTH 对齐（后端 clamp 上限 10）。
    private static let treeDepth = 4
    /// 组织级 context-items 接口把 page_size clamp 到 100，要更多也没用。
    private static let recentPageSize = 100
    /// 本地补记访问时间用；与后端返回的 ISO8601 同格式，`ISO8601DateParser` 能读回来。
    private static let visitedAtFormatter = ISO8601DateFormatter()

    var browseView: CloudDocsBrowseView = .all
    var searchText: String = ""

    private(set) var treeRoots: [KnowledgeTreeNode] = []
    /// 只存节点 id：`KnowledgeTreeNode` 的合成 Hashable 会递归整棵子树，用节点做集合元素每次插入都是全子树哈希。
    private(set) var expandedNodeIds: Set<String> = []
    private(set) var loadingChildNodeIds: Set<String> = []

    private(set) var allRecentItems: [SpaceResource] = []
    private(set) var sharedItems: [SharedResourceItem] = []

    private(set) var isLoading = false
    private(set) var errorMessage: String?
    /// 「分享给我」独占的错误位。
    ///
    /// 不并进 `errorMessage`：那是整页错误态，分享一类资源挂了不该让另外两个分段一起空白。
    private(set) var sharedErrorMessage: String?
    private(set) var pinningIds: Set<String> = []
    /// 新建进行中：挡连点，并禁用右上角 Menu。
    private(set) var isCreating = false
    /// 新建失败文案；用弹窗呈现，不踩分段错误态。
    private(set) var createErrorMessage: String?

    private var organizationId: String?
    private var loadGeneration = 0
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "CloudDocs")

    /// 与云盘写入门槛一致：editor 及以上可新建。
    var canCreate: Bool {
        CloudDriveWriteCapability.canWrite(role: WorkspaceStore.shared.currentUserRole)
    }

    // MARK: - 派生状态

    var treeRows: [KnowledgeTreeFlatRow] {
        KnowledgeTreeFlattener.flatten(roots: treeRoots, expandedIds: expandedNodeIds)
    }

    var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var searchHits: [KnowledgeTreeSearchHit] {
        KnowledgeTreeFlattener.search(roots: treeRoots, keyword: searchText)
    }

    /// 「最近」= 本人访问过的云文档，按访问时间倒序。
    ///
    /// 与「按更新时间排的全部资源」不是一回事：没访问过的不进这个列表，
    /// 别人改动也不会把条目顶上来。时间相同或解析不出来时按标题定序，避免列表抖动。
    var recentItems: [SpaceResource] {
        allRecentItems
            .filter { Self.cloudDocItemTypes.contains($0.normalizedType) }
            .filter { $0.lastVisitedAt?.isEmpty == false }
            .sorted { lhs, rhs in
                let l = lhs.lastVisitedAt.flatMap(ISO8601DateParser.date(from:))?.timeIntervalSince1970 ?? 0
                let r = rhs.lastVisitedAt.flatMap(ISO8601DateParser.date(from:))?.timeIntervalSince1970 ?? 0
                if l == r { return lhs.displayTitle < rhs.displayTitle }
                return l > r
            }
    }

    var isEmpty: Bool {
        switch browseView {
        case .all: return treeRoots.isEmpty
        case .recent: return recentItems.isEmpty
        case .shared: return sharedItems.isEmpty
        }
    }

    // MARK: - 加载

    /// 三个分段各拉各的数据源，互不连坐。
    ///
    /// 任意一路失败只让它自己那个分段退化（错误或空态），另外两个照常显示——
    /// 尤其「分享给我」聚合了两个后端来源，最容易挂，不能把整页拖成错误页。
    func load(organizationId: String) async {
        loadGeneration += 1
        let generation = loadGeneration

        // 切组织必须先清空：否则新组织加载期间会继续显示上一个组织的文档标题。
        if let current = self.organizationId, current != organizationId {
            treeRoots = []
            allRecentItems = []
            sharedItems = []
            expandedNodeIds = []
            loadingChildNodeIds = []
        }
        self.organizationId = organizationId

        isLoading = treeRoots.isEmpty && allRecentItems.isEmpty && sharedItems.isEmpty
        errorMessage = nil
        sharedErrorMessage = nil

        async let treeRequest: KnowledgeTreeResponse = APIClient.shared.get(
            path: Endpoints.Context.organizationKnowledgeTree(organizationId: organizationId),
            query: ["item_types": Self.itemTypesQuery, "depth": "\(Self.treeDepth)"]
        )
        async let itemsRequest: SpaceResourceListResponse = APIClient.shared.get(
            path: Endpoints.Context.organizationContextItems(organizationId: organizationId),
            query: ["is_archived": "false", "page": "1", "page_size": "\(Self.recentPageSize)"]
        )
        async let sharedRequest: [SharedResourceItem] = SharedResourcesService.listSharedWithMe(
            organizationId: organizationId
        )

        var loadedRoots: [KnowledgeTreeNode]?
        var loadedItems: [SpaceResource]?
        var loadedShared: [SharedResourceItem]?
        // 取消不是失败：视图重建 / 切组织会取消整批请求，这时三路都静默，不留错误文案。
        var browseError: Error?
        var sharedError: Error?

        do {
            let response = try await treeRequest
            loadedRoots = response.roots
        } catch {
            if !error.isCancellation { browseError = error }
        }

        do {
            let response = try await itemsRequest
            loadedItems = response.items
        } catch {
            if !error.isCancellation, browseError == nil { browseError = error }
        }

        do {
            loadedShared = try await sharedRequest
        } catch {
            if !error.isCancellation { sharedError = error }
        }

        guard generation == loadGeneration else { return }

        if let loadedRoots { treeRoots = loadedRoots }
        if let loadedItems { allRecentItems = loadedItems }
        if let loadedShared { sharedItems = loadedShared }

        if let browseError {
            errorMessage = Self.userMessage(for: browseError)
            logger.error("云文档加载失败: \(browseError.localizedDescription)")
        }
        if let sharedError {
            sharedErrorMessage = Self.userMessage(for: sharedError)
            logger.error("分享给我加载失败: \(sharedError.localizedDescription)")
        }
        isLoading = false
    }

    // MARK: - 树展开

    func toggleExpansion(_ node: KnowledgeTreeNode) async {
        if expandedNodeIds.contains(node.id) {
            expandedNodeIds.remove(node.id)
            return
        }
        expandedNodeIds.insert(node.id)
        // 要不要补拉只看 childCount：后端对「真叶子」和「被 depth 截断」都返回 children: []。
        guard KnowledgeTreeFlattener.needsLazyChildren(node),
              !loadingChildNodeIds.contains(node.id),
              let organizationId else { return }

        loadingChildNodeIds.insert(node.id)
        defer { loadingChildNodeIds.remove(node.id) }

        do {
            let response: KnowledgeTreeChildrenResponse = try await APIClient.shared.get(
                path: Endpoints.Context.organizationKnowledgeTreeChildren(
                    organizationId: organizationId,
                    nodeId: node.id
                ),
                query: ["node_type": node.nodeType.rawValue, "item_types": Self.itemTypesQuery]
            )
            treeRoots = KnowledgeTreeFlattener.replacingChildren(
                in: treeRoots,
                nodeId: node.id,
                children: response.children
            )
        } catch {
            guard !error.isCancellation else { return }
            // 子节点拉取失败不该把整页打成错误态：折叠回去，让用户可以重试
            expandedNodeIds.remove(node.id)
            logger.error("加载子节点失败 node=\(node.id): \(error.localizedDescription)")
        }
    }

    // MARK: - 行操作

    func togglePin(contextItemId: String, isPinned: Bool) async {
        guard !pinningIds.contains(contextItemId) else { return }
        pinningIds.insert(contextItemId)
        defer { pinningIds.remove(contextItemId) }

        do {
            // 只关心成功与否：置顶后的最新状态由随后的整页刷新拉齐。
            let _: MessageResponse = try await APIClient.shared.patch(
                path: Endpoints.Context.contextItem(contextItemId),
                body: ["is_pinned": isPinned]
            )
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = Self.userMessage(for: error)
            logger.error("置顶切换失败 item=\(contextItemId): \(error.localizedDescription)")
            return
        }
        if let organizationId { await load(organizationId: organizationId) }
    }

    /// 在组织根新建一份云文档资源，成功后刷新列表并返回可打开路由。
    ///
    /// 类型扩展走 ``CloudDocsCreatableKind`` / ``CloudDocsCreateService``，本方法不写 switch。
    @discardableResult
    func create(_ kind: CloudDocsCreatableKind, title: String? = nil) async -> CloudDocsCreatedResource? {
        guard !isCreating else { return nil }
        guard canCreate else {
            createErrorMessage = L10n.CloudDrive.writeUnavailable
            return nil
        }
        guard let organizationId, !organizationId.isEmpty else {
            createErrorMessage = L10n.CloudDrive.writeUnavailable
            return nil
        }
        isCreating = true
        createErrorMessage = nil
        defer { isCreating = false }
        do {
            let created = try await CloudDocsCreateService.create(
                kind: kind,
                organizationId: organizationId,
                collectionId: nil,
                title: title
            )
            await load(organizationId: organizationId)
            return created
        } catch {
            guard !error.isCancellation else { return nil }
            createErrorMessage = Self.userMessage(for: error)
            logger.error("新建失败 kind=\(kind.rawValue): \(error.localizedDescription)")
            return nil
        }
    }

    func clearCreateError() {
        createErrorMessage = nil
    }

    /// 返回是否真的删成功，调用方据此决定要不要连带收走「当前打开」坞里的卡片。
    @discardableResult
    func delete(contextItemId: String) async -> Bool {
        do {
            let _: MessageResponse = try await APIClient.shared.delete(
                path: Endpoints.Context.contextItem(contextItemId)
            )
        } catch {
            guard !error.isCancellation else { return false }
            errorMessage = Self.userMessage(for: error)
            logger.error("删除失败 item=\(contextItemId): \(error.localizedDescription)")
            return false
        }
        if let organizationId { await load(organizationId: organizationId) }
        return true
    }

    /// 打开资源时记一笔访问，「最近」分段靠它排序。
    ///
    /// 本地先盖上访问时间：从浏览面 push 出去再返回不会触发整页刷新，
    /// 不先落本地的话，用户刚打开过的东西在「最近」里看不见。
    /// 上报 fire-and-forget：失败不影响打开，下次刷新会用服务端时间纠正。
    /// 分享项的合成 id（`shared:` 前缀）不是真实 context-item，不能上报。
    func recordAccess(contextItemId: String?) {
        guard let contextItemId, !contextItemId.isEmpty,
              !contextItemId.hasPrefix("shared:") else { return }

        if let index = allRecentItems.firstIndex(where: { $0.id == contextItemId }) {
            allRecentItems[index].lastVisitedAt = Self.visitedAtFormatter.string(from: Date())
        }

        Task {
            do {
                let _: MessageResponse = try await APIClient.shared.post(
                    path: Endpoints.Context.contextItemAccess(contextItemId)
                )
            } catch {
                logger.debug("记录访问失败 item=\(contextItemId): \(error.localizedDescription)")
            }
        }
    }

    func clearError() {
        errorMessage = nil
        sharedErrorMessage = nil
    }

    private static func userMessage(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    #if DEBUG
    func setTreeRootsForTest(_ roots: [KnowledgeTreeNode]) { treeRoots = roots }
    func setExpandedForTest(_ ids: Set<String>) { expandedNodeIds = ids }
    func setRecentItemsForTest(_ items: [SpaceResource]) { allRecentItems = items }
    func setSharedItemsForTest(_ items: [SharedResourceItem]) { sharedItems = items }
    #endif
}

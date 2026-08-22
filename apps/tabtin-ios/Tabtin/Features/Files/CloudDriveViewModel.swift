import Foundation
import UniformTypeIdentifiers

@MainActor @Observable
final class CloudDriveViewModel {
    let organizationId: String

    private(set) var collections: [OrganizationCollection] = []
    private(set) var resources: [SpaceResource] = []
    private(set) var sharedItems: [SharedResourceItem] = []
    /// 独立于当前目录列表的最近访问资源；加载失败不影响主列表。
    private(set) var resumeItem: SpaceResource?

    private(set) var scope: CloudDriveScope = .all
    private(set) var typeFilter: CloudDriveTypeFilter = .all
    private(set) var searchText: String = ""
    private(set) var currentCollectionId: String?

    private(set) var page = 1
    private(set) var hasMore = false
    private(set) var sharedCursor: String?

    private(set) var isInitialLoading = false
    private(set) var isRefreshing = false
    private(set) var isLoadingMore = false
    private(set) var pageError: String?
    private(set) var loadMoreError: String?
    /// 分享搜索翻页触达 `CloudDriveSharedSearchPolicy.maxFeedPages` 仍有下一页时为 true。
    private(set) var sharedSearchHitPageCap = false

    private(set) var isWriting = false
    private(set) var writeError: String?
    private(set) var uploadProgress: CloudDriveUploadProgress?
    private(set) var pendingMountCount = 0
    /// 创建/上传成功后由 UI 消费并导航；消费后清空。
    private(set) var pendingOpenRoute: SpaceAppRoute?
    /// TabFiles trash 后的短时撤销 / 永久删除入口。
    private(set) var trashedFileNotice: CloudDriveTrashedFileNotice?

    private var listTask: Task<Void, Never>?
    private var searchDebounceTask: Task<Void, Never>?
    private var requestGeneration = 0

    init(organizationId: String) {
        self.organizationId = organizationId
    }

    private var hasOrganizationWritePermission: Bool {
        CloudDriveWriteCapability.canWrite(role: WorkspaceStore.shared.currentUserRole)
    }

    var canCreate: Bool {
        CloudDriveWriteCapability.canCreate(
            hasOrganizationWritePermission: hasOrganizationWritePermission,
            scope: scope,
            isSearching: isSearching
        )
    }

    var canWrite: Bool {
        hasOrganizationWritePermission && scope == .all && !isSearching
    }

    var canManageFolders: Bool {
        CloudDriveHighRiskPolicy.canManageFolders(
            canWrite: canWrite,
            scope: scope,
            isSearching: isSearching
        )
    }

    var isSearching: Bool {
        !normalizedSearch.isEmpty
    }

    var breadcrumbPath: [OrganizationCollection] {
        guard let currentCollectionId else { return [] }
        return CloudDriveFolderLookup.path(to: currentCollectionId, in: collections)
    }

    var folderRows: [OrganizationCollection] {
        guard scope == .all, !isSearching else { return [] }
        return CloudDriveFolderLookup.children(of: currentCollectionId, in: collections)
    }

    var listRows: [CloudDriveListRow] {
        let filteredResources = resources.filter {
            typeFilter.matches(normalizedType: $0.normalizedType)
        }
        let filteredSharedItems = sharedItems.filter { item in
            typeFilter.matches(normalizedType: Self.normalizedType(for: item.resourceType))
        }
        if isSearching {
            let folderHits = localFolderSearchResults().map(CloudDriveListRow.folder)
            switch scope {
            case .shared:
                return folderHits + filteredSharedItems.map(CloudDriveListRow.shared)
            case .all, .recent:
                return folderHits + filteredResources.map(CloudDriveListRow.resource)
            }
        }
        switch scope {
        case .all:
            return folderRows.map(CloudDriveListRow.folder) + filteredResources.map(CloudDriveListRow.resource)
        case .recent:
            return filteredResources.map(CloudDriveListRow.resource)
        case .shared:
            return filteredSharedItems.map(CloudDriveListRow.shared)
        }
    }

    var hasListContent: Bool { !listRows.isEmpty }

    private var normalizedSearch: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func onAppear() {
        if collections.isEmpty && resources.isEmpty && sharedItems.isEmpty && pageError == nil {
            Task { await reload(isPullToRefresh: false) }
        }
        Task { await loadResumeItem() }
        Task { await retryPendingMounts() }
    }

    /// App 回到前台：RootView 可能已 `retryAll`，这里同步计数并补挂。
    func onSceneActive() {
        Task { await loadResumeItem() }
        Task { await retryPendingMounts() }
    }

    /// Store 被 RootView / 其它路径改写后由 View 转发；刷新 pending 计数，挂载变少时重拉列表。
    func onPendingMountStoreChanged() async {
        let previous = pendingMountCount
        await refreshPendingMountCount()
        if pendingMountCount < previous {
            await reload(isPullToRefresh: true)
        }
    }

    func setScope(_ next: CloudDriveScope) {
        guard next != scope else { return }
        scope = next
        if next != .all {
            currentCollectionId = nil
        }
        Task { await reload(isPullToRefresh: false) }
    }

    func setTypeFilter(_ next: CloudDriveTypeFilter) {
        guard next != typeFilter else { return }
        typeFilter = next
        Task { await reload(isPullToRefresh: false) }
    }

    func updateSearchText(_ text: String) {
        searchText = text
        searchDebounceTask?.cancel()
        searchDebounceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.reload(isPullToRefresh: false)
        }
    }

    func openFolder(_ collectionId: String?) {
        guard scope == .all else { return }
        currentCollectionId = collectionId
        Task { await reload(isPullToRefresh: false) }
    }

    func navigateBreadcrumb(to collectionId: String?) {
        openFolder(collectionId)
    }

    func refresh() async {
        await reload(isPullToRefresh: true)
        await loadResumeItem()
    }

    func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        loadMoreError = nil
        let generation = requestGeneration
        do {
            switch scope {
            case .shared:
                guard let cursor = sharedCursor, !cursor.isEmpty else {
                    hasMore = false
                    isLoadingMore = false
                    return
                }
                let response = try await CloudDriveRepository.listSharedFeed(
                    organizationId: organizationId,
                    itemTypes: typeFilter.itemTypesQuery,
                    cursor: cursor
                )
                guard generation == requestGeneration else { return }
                let mapped = response.items.map { $0.asSharedResourceItem() }
                let existing = Set(sharedItems.map(\.id))
                sharedItems.append(contentsOf: mapped.filter { !existing.contains($0.id) })
                sharedCursor = emptyToNil(response.nextCursor)
                hasMore = sharedCursor != nil
            case .all, .recent:
                let nextPage = page + 1
                let response: SpaceResourceListResponse
                if isSearching {
                    response = try await CloudDriveRepository.search(
                        organizationId: organizationId,
                        query: normalizedSearch,
                        types: typeFilter.itemTypesQuery,
                        page: nextPage
                    )
                } else if scope == .recent {
                    response = try await CloudDriveRepository.listRecentItems(
                        organizationId: organizationId,
                        itemTypes: typeFilter.itemTypesQuery,
                        page: nextPage
                    )
                } else {
                    response = try await CloudDriveRepository.listFolderItems(
                        organizationId: organizationId,
                        collectionId: currentCollectionId,
                        itemTypes: typeFilter.itemTypesQuery,
                        page: nextPage
                    )
                }
                guard generation == requestGeneration else { return }
                let existing = Set(resources.map(\.id))
                resources.append(contentsOf: response.items.filter { !existing.contains($0.id) })
                page = nextPage
                hasMore = computeHasMore(response: response, loadedCount: resources.count)
            }
        } catch {
            guard generation == requestGeneration else { return }
            guard !error.isCancellation else { return }
            loadMoreError = Self.userMessage(for: error)
        }
        if generation == requestGeneration {
            isLoadingMore = false
        }
    }

    func retryLoadMore() async {
        loadMoreError = nil
        await loadMore()
    }

    func recordAccess(contextItemId: String?) {
        guard let contextItemId, !contextItemId.isEmpty else { return }
        let visitedAt = ISO8601DateFormatter().string(from: Date())
        if let index = resources.firstIndex(where: { $0.id == contextItemId }) {
            resources[index].lastVisitedAt = visitedAt
            resumeItem = resources[index]
        } else if resumeItem?.id == contextItemId {
            resumeItem?.lastVisitedAt = visitedAt
        }
        Task {
            await CloudDriveRepository.reportAccess(contextItemId: contextItemId)
        }
    }

    func consumePendingOpenRoute() -> SpaceAppRoute? {
        defer { pendingOpenRoute = nil }
        return pendingOpenRoute
    }

    func clearWriteError() {
        writeError = nil
    }

    func clearTrashedFileNotice() {
        trashedFileNotice = nil
    }

    // MARK: - High-risk ops (Task 9)

    @discardableResult
    func renameFolder(collectionId: String, name: String) async -> Bool {
        guard canManageFolders, !isWriting else { return false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            writeError = L10n.CloudDrive.folderNameRequired
            return false
        }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        do {
            _ = try await CloudDriveRepository.renameCollection(collectionId: collectionId, name: trimmed)
            await reload(isPullToRefresh: true)
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    @discardableResult
    func moveFolder(collectionId: String, toParentId: String?) async -> Bool {
        guard canManageFolders, !isWriting else { return false }
        // 禁止移入自身或其子孙文件夹。
        if let toParentId {
            if collectionId == toParentId {
                writeError = L10n.CloudDrive.moveFolderIntoSelf
                return false
            }
            let flat = CloudDriveFolderLookup.flatten(collections)
            if let node = flat.first(where: { $0.id == collectionId }) {
                let descendantIds = Set(CloudDriveFolderLookup.flatten(node.children).map(\.id))
                if descendantIds.contains(toParentId) {
                    writeError = L10n.CloudDrive.moveFolderIntoSelf
                    return false
                }
            }
        }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        do {
            _ = try await CloudDriveRepository.moveCollection(
                collectionId: collectionId,
                parentId: toParentId
            )
            await reload(isPullToRefresh: true)
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    @discardableResult
    func deleteFolder(collectionId: String) async -> Bool {
        guard canManageFolders, !isWriting else { return false }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        do {
            try await CloudDriveRepository.deleteCollection(collectionId: collectionId)
            if currentCollectionId == collectionId {
                // 删当前文件夹 → 回到父级或根。
                let path = CloudDriveFolderLookup.path(to: collectionId, in: collections)
                currentCollectionId = path.dropLast().last?.id
            }
            await reload(isPullToRefresh: true)
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    /// Owner-only：`can_move` 为真才请求；ContextItemID 进 move-items。
    @discardableResult
    func moveResource(contextItemId: String, toCollectionId: String?) async -> Bool {
        guard canWrite, !isWriting else { return false }
        guard let resource = resources.first(where: { $0.contextItemId == contextItemId }) else {
            writeError = L10n.CloudDrive.moveOwnerOnly
            return false
        }
        guard CloudDriveHighRiskPolicy.canMoveResource(resource) else {
            writeError = L10n.CloudDrive.moveOwnerOnly
            return false
        }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        do {
            let updated = try await CloudDriveRepository.moveItems(
                organizationId: organizationId,
                contextItemIds: [contextItemId],
                collectionId: toCollectionId
            )
            if updated == 0 {
                writeError = L10n.CloudDrive.moveOwnerOnly
                return false
            }
            await reload(isPullToRefresh: true)
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    /// TabFiles trash —— 必须 FileRecordID。
    @discardableResult
    func trashTabFile(fileRecordId: String, title: String) async -> Bool {
        guard !isWriting else { return false }
        let trimmed = fileRecordId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            writeError = L10n.CloudDrive.missingFileRecordId
            return false
        }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        do {
            try await CloudDriveRepository.trashTabFile(
                organizationId: organizationId,
                fileRecordId: trimmed
            )
            trashedFileNotice = CloudDriveTrashedFileNotice(
                id: UUID().uuidString,
                fileRecordId: trimmed,
                title: title
            )
            await reload(isPullToRefresh: true)
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    @discardableResult
    func restoreTrashedTabFile(fileRecordId: String) async -> Bool {
        guard !isWriting else { return false }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        do {
            _ = try await CloudDriveRepository.restoreTabFile(
                organizationId: organizationId,
                fileRecordId: fileRecordId
            )
            if trashedFileNotice?.fileRecordId == fileRecordId {
                trashedFileNotice = nil
            }
            await reload(isPullToRefresh: true)
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    @discardableResult
    func permanentDeleteTrashedTabFile(fileRecordId: String) async -> Bool {
        guard !isWriting else { return false }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        do {
            try await CloudDriveRepository.permanentDeleteTabFile(
                organizationId: organizationId,
                fileRecordId: fileRecordId
            )
            if trashedFileNotice?.fileRecordId == fileRecordId {
                trashedFileNotice = nil
            }
            await reload(isPullToRefresh: true)
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    // MARK: - Writes

    @discardableResult
    func createFolder(name: String) async -> Bool {
        guard canCreate, !isWriting else { return false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            writeError = L10n.CloudDrive.folderNameRequired
            return false
        }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        do {
            let created = try await CloudDriveRepository.createCollection(
                organizationId: organizationId,
                name: trimmed,
                parentId: currentCollectionId
            )
            await reload(isPullToRefresh: true)
            openFolder(created.id)
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    @discardableResult
    func createDocument(title: String? = nil) async -> Bool {
        guard canCreate, !isWriting else { return false }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        let resolvedTitle = (title?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        } ?? L10n.CloudDocs.untitled
        do {
            let created = try await CloudDriveRepository.createDocument(
                organizationId: organizationId,
                collectionId: currentCollectionId,
                title: resolvedTitle
            )
            await reload(isPullToRefresh: true)
            pendingOpenRoute = .tabdoc(
                documentId: created.id,
                documentName: created.title?.nilIfEmpty ?? resolvedTitle
            )
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    @discardableResult
    func createTable(name: String? = nil) async -> Bool {
        guard canCreate, !isWriting else { return false }
        isWriting = true
        writeError = nil
        defer { isWriting = false }
        let resolvedName = (name?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        } ?? L10n.CloudDocs.untitled
        do {
            let created = try await CloudDriveRepository.createTable(
                organizationId: organizationId,
                collectionId: currentCollectionId,
                name: resolvedName
            )
            await reload(isPullToRefresh: true)
            pendingOpenRoute = .tabdata(
                tableId: created.id,
                tableName: created.name?.nilIfEmpty ?? resolvedName
            )
            return true
        } catch {
            guard !error.isCancellation else { return false }
            writeError = Self.userMessage(for: error)
            return false
        }
    }

    /// 系统文件选择器 → OSS → confirm → Organization mount。支持多文件顺序上传。
    func uploadFiles(from urls: [URL]) async {
        guard canCreate, !isWriting else { return }
        guard !urls.isEmpty else { return }
        isWriting = true
        writeError = nil
        defer {
            isWriting = false
            if uploadProgress?.phase == .ready || uploadProgress?.phase == .pendingMount {
                // 保留短时态给 UI；下一轮操作会覆盖
            }
        }

        let collectionId = currentCollectionId
        var lastMounted: SpaceResource?
        for url in urls {
            let accessed = url.startAccessingSecurityScopedResource()
            defer {
                if accessed { url.stopAccessingSecurityScopedResource() }
            }
            let fileName = url.lastPathComponent
            uploadProgress = CloudDriveUploadProgress(
                fileName: fileName,
                phase: .uploading,
                progress: 0,
                errorMessage: nil
            )
            do {
                let contentType = Self.mimeType(for: url)
                let result = try await OSSUploadService.shared.directUpload(
                    fileURL: url,
                    fileName: fileName,
                    contentType: contentType,
                    folder: CloudDriveRepository.tabfilesUploadFolder,
                    scope: CloudDriveRepository.tabfilesUploadScope(organizationId: organizationId)
                ) { [weak self] progress in
                    Task { @MainActor in
                        guard let self else { return }
                        self.uploadProgress = CloudDriveUploadProgress(
                            fileName: fileName,
                            phase: .uploading,
                            progress: progress,
                            errorMessage: nil
                        )
                    }
                }
                uploadProgress = CloudDriveUploadProgress(
                    fileName: fileName,
                    phase: .confirmed,
                    progress: 1,
                    errorMessage: nil
                )
                uploadProgress = CloudDriveUploadProgress(
                    fileName: fileName,
                    phase: .mounting,
                    progress: 1,
                    errorMessage: nil
                )
                do {
                    let mounted = try await CloudDriveRepository.mountUploadedFile(
                        organizationId: organizationId,
                        fileRecordId: result.fileId,
                        collectionId: collectionId,
                        title: fileName
                    )
                    await CloudDrivePendingMountStore.shared.remove(
                        fileRecordId: result.fileId,
                        organizationId: organizationId
                    )
                    lastMounted = mounted
                    uploadProgress = CloudDriveUploadProgress(
                        fileName: fileName,
                        phase: .ready,
                        progress: 1,
                        errorMessage: nil
                    )
                } catch {
                    guard !error.isCancellation else { return }
                    let message = Self.userMessage(for: error)
                    await CloudDrivePendingMountStore.shared.enqueue(
                        CloudDrivePendingMountTask(
                            fileRecordId: result.fileId,
                            organizationId: organizationId,
                            collectionId: collectionId,
                            title: fileName,
                            lastError: message
                        )
                    )
                    uploadProgress = CloudDriveUploadProgress(
                        fileName: fileName,
                        phase: .pendingMount,
                        progress: 1,
                        errorMessage: message
                    )
                    writeError = L10n.CloudDrive.mountPendingHint
                    await refreshPendingMountCount()
                }
            } catch {
                guard !error.isCancellation else { return }
                writeError = OSSBusinessError.userMessage(for: error)
                uploadProgress = CloudDriveUploadProgress(
                    fileName: fileName,
                    phase: .selected,
                    progress: 0,
                    errorMessage: writeError
                )
            }
        }

        await reload(isPullToRefresh: true)
        await refreshPendingMountCount()
        if let lastMounted, let route = lastMounted.appRoute {
            pendingOpenRoute = route
            recordAccess(contextItemId: lastMounted.contextItemId)
        }
    }

    func retryPendingMounts() async {
        let mounted = await CloudDrivePendingMountStore.shared.retryAll()
        await refreshPendingMountCount()
        if !mounted.isEmpty {
            await reload(isPullToRefresh: true)
            if let last = mounted.last, let route = last.appRoute {
                pendingOpenRoute = route
            }
        }
    }

    private func refreshPendingMountCount() async {
        let all = await CloudDrivePendingMountStore.shared.all()
        pendingMountCount = all.filter { $0.organizationId == organizationId }.count
    }

    // MARK: - Load

    private func loadResumeItem() async {
        do {
            let response = try await CloudDriveRepository.listRecentItems(
                organizationId: organizationId,
                itemTypes: CloudDriveTypeFilter.all.itemTypesQuery,
                page: 1,
                pageSize: 20
            )
            guard !Task.isCancelled else { return }
            resumeItem = CloudDriveResumeProjector.mostRecentlyVisited(in: response.items)
        } catch {
            // Hero 是非阻塞增强：网络失败时保留上次真实资源，不污染主列表错误态。
        }
    }

    private func reload(isPullToRefresh: Bool) async {
        listTask?.cancel()
        requestGeneration += 1
        let generation = requestGeneration
        pageError = nil
        loadMoreError = nil
        page = 1
        sharedCursor = nil
        hasMore = false
        sharedSearchHitPageCap = false

        if isPullToRefresh {
            isRefreshing = true
        } else if !hasListContent {
            isInitialLoading = true
        }

        listTask = Task { [weak self] in
            await self?.performReload(generation: generation, isPullToRefresh: isPullToRefresh)
        }
        await listTask?.value
    }

    private func performReload(generation: Int, isPullToRefresh: Bool) async {
        do {
            if scope == .all || isSearching {
                let loaded = try await CloudDriveRepository.listCollections(organizationId: organizationId)
                guard generation == requestGeneration else { return }
                collections = loaded
            }

            if isSearching {
                try await loadSearch(generation: generation)
            } else {
                switch scope {
                case .all:
                    try await loadFolderPage(generation: generation)
                case .recent:
                    try await loadRecentPage(generation: generation)
                case .shared:
                    try await loadSharedPage(generation: generation, reset: true)
                }
            }
        } catch {
            guard generation == requestGeneration else { return }
            guard !error.isCancellation else { return }
            pageError = Self.userMessage(for: error)
            if scope == .shared {
                sharedItems = []
            } else {
                resources = []
            }
        }

        guard generation == requestGeneration else { return }
        isInitialLoading = false
        isRefreshing = false
    }

    private func loadFolderPage(generation: Int) async throws {
        let response = try await CloudDriveRepository.listFolderItems(
            organizationId: organizationId,
            collectionId: currentCollectionId,
            itemTypes: typeFilter.itemTypesQuery,
            page: 1
        )
        guard generation == requestGeneration else { return }
        resources = response.items
        sharedItems = []
        page = 1
        hasMore = computeHasMore(response: response, loadedCount: resources.count)
    }

    private func loadRecentPage(generation: Int) async throws {
        let response = try await CloudDriveRepository.listRecentItems(
            organizationId: organizationId,
            itemTypes: typeFilter.itemTypesQuery,
            page: 1
        )
        guard generation == requestGeneration else { return }
        resources = response.items
        sharedItems = []
        page = 1
        hasMore = computeHasMore(response: response, loadedCount: resources.count)
    }

    private func loadSharedPage(generation: Int, reset: Bool) async throws {
        let response = try await CloudDriveRepository.listSharedFeed(
            organizationId: organizationId,
            itemTypes: typeFilter.itemTypesQuery,
            cursor: reset ? nil : sharedCursor
        )
        guard generation == requestGeneration else { return }
        sharedItems = response.items.map { $0.asSharedResourceItem() }
        resources = []
        sharedCursor = emptyToNil(response.nextCursor)
        hasMore = sharedCursor != nil
    }

    private func loadSearch(generation: Int) async throws {
        // 分享范围：shared-feed 无 `q`，翻页本地过滤至耗尽或页数上限；不与 org search 混游标。
        if scope == .shared {
            try await loadSharedSearch(generation: generation)
            return
        }

        let response = try await CloudDriveRepository.search(
            organizationId: organizationId,
            query: normalizedSearch,
            types: typeFilter.itemTypesQuery,
            page: 1
        )
        guard generation == requestGeneration else { return }
        resources = response.items
        sharedItems = []
        page = 1
        hasMore = computeHasMore(response: response, loadedCount: resources.count)
    }

    private func loadSharedSearch(generation: Int) async throws {
        let query = normalizedSearch
        var cursor: String?
        var pages = 0
        var matched: [SharedResourceItem] = []
        var seen = Set<String>()
        var hitCap = false

        repeat {
            let response = try await CloudDriveRepository.listSharedFeed(
                organizationId: organizationId,
                itemTypes: typeFilter.itemTypesQuery,
                cursor: cursor
            )
            guard generation == requestGeneration else { return }
            pages += 1
            for item in response.items.map({ $0.asSharedResourceItem() })
                where CloudDriveSharedSearchPolicy.matches(item, query: query) {
                if seen.insert(item.id).inserted {
                    matched.append(item)
                }
            }
            cursor = emptyToNil(response.nextCursor)
            if cursor != nil, pages >= CloudDriveSharedSearchPolicy.maxFeedPages {
                hitCap = true
                break
            }
        } while cursor != nil

        guard generation == requestGeneration else { return }
        sharedItems = matched
        resources = []
        sharedCursor = nil
        hasMore = false
        sharedSearchHitPageCap = hitCap
    }

    private func localFolderSearchResults() -> [OrganizationCollection] {
        let needle = normalizedSearch.lowercased()
        guard !needle.isEmpty else { return [] }
        return CloudDriveFolderLookup.flatten(collections).filter {
            $0.name.lowercased().contains(needle)
        }
    }

    private func computeHasMore(response: SpaceResourceListResponse, loadedCount: Int) -> Bool {
        if let total = response.total {
            return loadedCount < total
        }
        let size = response.pageSize ?? CloudDriveRepository.defaultPageSize
        return response.items.count >= size
    }

    private func emptyToNil(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func userMessage(for error: Error) -> String {
        if case APIError.apiErrorWithCode(_, let message) = error {
            return message
        }
        return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    private static func normalizedType(for sharedType: SharedResourceType) -> String {
        switch sharedType {
        case .doc: return "tabdoc"
        case .table: return "tabdata"
        case .file: return "tabfiles"
        }
    }

    private static func mimeType(for url: URL) -> String {
        if let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType {
            return type
        }
        return "application/octet-stream"
    }

    #if DEBUG
    func setCollectionsForTest(_ value: [OrganizationCollection]) { collections = value }
    func setResourcesForTest(_ value: [SpaceResource]) { resources = value }
    func setSharedForTest(_ value: [SharedResourceItem]) { sharedItems = value }
    func setScopeForTest(_ value: CloudDriveScope) { scope = value }
    func setSearchForTest(_ value: String) { searchText = value }
    func setTypeFilterForTest(_ value: CloudDriveTypeFilter) { typeFilter = value }
    func setCurrentCollectionForTest(_ value: String?) { currentCollectionId = value }
    #endif
}

private extension String {
    var nilIfEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

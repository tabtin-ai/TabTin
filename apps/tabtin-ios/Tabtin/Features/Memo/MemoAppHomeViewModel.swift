import Foundation

@MainActor @Observable
final class MemoAppHomeViewModel {
    let organizationId: String

    private(set) var memos: [CloudMemoSummary] = []
    private(set) var diaryItems: [AgentDiaryFeedItem] = []
    private(set) var heatmapBuckets: [MemoHeatmapBucket] = []
    private(set) var monthCount: Int = 0
    private(set) var tagStats: [MemoTagStatsItem] = []

    private(set) var viewKind: MemoAppHomeViewKind = .all
    private(set) var searchText: String = ""
    private(set) var selectedTags: [String] = []
    /// 热力格点击产生的日筛选；与「今日回顾」互斥覆盖 created_*。
    private(set) var heatmapDayKey: String?

    private(set) var nextCursor: String?
    private(set) var hasMore = false

    private(set) var isInitialLoading = false
    private(set) var isRefreshing = false
    private(set) var isLoadingMore = false
    private(set) var pageError: String?
    private(set) var loadMoreError: String?
    private(set) var heatmapError: String?
    private(set) var actionError: String?

    var draftContent: String = ""
    var draftTagsText: String = ""
    var draftColor: MemoColor = .none
    private(set) var isCreating = false
    private(set) var createError: String?

    /// 快捷落笔附件：create → OSS → attachments；失败不删正文。
    private(set) var draftAttachmentName: String?
    private(set) var attachmentPhase: MemoAttachmentPhase = .idle
    private(set) var attachmentError: String?
    private(set) var lastCreatedMemoIdForAttachment: String?
    private var draftAttachmentData: Data?
    private var draftAttachmentContentType: String = "application/octet-stream"

    private let requestGate = MemoListRequestGate()
    private var searchDebounceTask: Task<Void, Never>?
    private var listTask: Task<Void, Never>?
    private var heatmapTask: Task<Void, Never>?
    private let saveBusyMaxRetries = 2

    var timelineSections: [MemoTimelineSection] {
        MemoTimelineProjector.project(memos: memos)
    }

    var hasListContent: Bool {
        switch viewKind {
        case .agentDiary: return !diaryItems.isEmpty
        case .all, .today: return !memos.isEmpty
        }
    }

    var isSearching: Bool {
        !normalizedSearch.isEmpty || !selectedTags.isEmpty || heatmapDayKey != nil
    }

    private var normalizedSearch: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var draftTags: [String] {
        draftTagsText
            .split(whereSeparator: { $0 == "," || $0 == "，" || $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    init(organizationId: String) {
        self.organizationId = organizationId
    }

    func onAppear() {
        if memos.isEmpty && diaryItems.isEmpty && pageError == nil {
            Task { await reload(isPullToRefresh: false) }
        }
        if heatmapBuckets.isEmpty {
            Task { await loadHeatmap() }
        }
        if tagStats.isEmpty {
            Task { await loadTagStats() }
        }
    }

    func setViewKind(_ kind: MemoAppHomeViewKind) {
        guard kind != viewKind else { return }
        if kind == .agentDiary, !MemoAppHomeFeatureFlags.isOrganizationAgentDiaryEnabled {
            return
        }
        viewKind = kind
        heatmapDayKey = nil
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

    func toggleTag(_ tag: String) {
        if let idx = selectedTags.firstIndex(of: tag) {
            selectedTags.remove(at: idx)
        } else {
            selectedTags.append(tag)
        }
        Task { await reload(isPullToRefresh: false) }
    }

    func selectHeatmapDay(_ dayKey: String?) {
        guard heatmapDayKey != dayKey else {
            heatmapDayKey = nil
            Task { await reload(isPullToRefresh: false) }
            return
        }
        heatmapDayKey = dayKey
        if dayKey != nil, viewKind == .today {
            viewKind = .all
        }
        Task { await reload(isPullToRefresh: false) }
    }

    func refresh() async {
        await reload(isPullToRefresh: true)
        await loadHeatmap()
        await loadTagStats()
    }

    func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        guard let cursor = nextCursor, !cursor.isEmpty else { return }
        isLoadingMore = true
        loadMoreError = nil
        let token = await requestGate.begin()
        do {
            switch viewKind {
            case .agentDiary:
                let response = try await fetchDiary(cursor: cursor)
                guard await requestGate.isCurrent(token) else { return }
                let existing = Set(diaryItems.map(\.id))
                diaryItems.append(contentsOf: response.items.filter { !existing.contains($0.id) })
                nextCursor = response.nextCursor.isEmpty ? nil : response.nextCursor
                hasMore = response.hasMore
            case .all, .today:
                let response = try await fetchMemos(cursor: cursor)
                guard await requestGate.isCurrent(token) else { return }
                let existing = Set(memos.map(\.id))
                memos.append(contentsOf: response.items.filter { !existing.contains($0.id) })
                nextCursor = emptyToNil(response.nextCursor)
                hasMore = response.hasMore ?? !(response.nextCursor ?? "").isEmpty
            }
        } catch {
            guard await requestGate.isCurrent(token) else { return }
            guard !error.isCancellation else { return }
            loadMoreError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        if await requestGate.isCurrent(token) {
            isLoadingMore = false
        }
    }

    func retryLoadMore() async {
        loadMoreError = nil
        await loadMore()
    }

    func attachDraftFile(data: Data, fileName: String, contentType: String) {
        guard data.count > 0 else { return }
        draftAttachmentData = data
        draftAttachmentName = fileName
        draftAttachmentContentType = contentType.isEmpty ? "application/octet-stream" : contentType
        attachmentPhase = .selected
        attachmentError = nil
    }

    func clearDraftAttachment() {
        draftAttachmentData = nil
        draftAttachmentName = nil
        draftAttachmentContentType = "application/octet-stream"
        if lastCreatedMemoIdForAttachment == nil {
            attachmentPhase = .idle
            attachmentError = nil
        }
    }

    func createFromDraft() async {
        let content = draftContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !isCreating else { return }
        isCreating = true
        createError = nil
        attachmentError = nil
        let tags = draftTags
        let color = draftColor

        do {
            let created = try await postMemoWithSaveBusyRetry(
                organizationId: organizationId,
                content: content,
                tags: tags,
                color: color
            )
            // 正文已落库：清草稿文本；附件失败也不回滚正文。
            draftContent = ""
            draftTagsText = ""
            draftColor = .none
            if viewKind == .agentDiary {
                viewKind = .all
                memos = [created]
                await reload(isPullToRefresh: true)
            } else if shouldIncludeInCurrentFilters(created) {
                memos.insert(created, at: 0)
            }
            Task { await loadHeatmap() }

            if draftAttachmentData != nil {
                lastCreatedMemoIdForAttachment = created.id
                await uploadAttachment(for: created.id)
            }
        } catch {
            guard !error.isCancellation else {
                isCreating = false
                return
            }
            // 失败保留草稿（含 SAVE_BUSY 耗尽后）
            createError = Self.userMessage(for: error)
        }
        isCreating = false
    }

    /// 附件失败后的重试入口：不重新创建 Memo。
    func retryPendingAttachment() async {
        guard let memoId = lastCreatedMemoIdForAttachment,
              draftAttachmentData != nil,
              !isCreating else { return }
        await uploadAttachment(for: memoId)
    }

    private func postMemoWithSaveBusyRetry(
        organizationId: String,
        content: String,
        tags: [String],
        color: MemoColor
    ) async throws -> CloudMemoSummary {
        var attempt = 0
        while true {
            do {
                return try await APIClient.shared.post(
                    path: Endpoints.TabMemo.memos,
                    body: Self.makeCreateMemoBody(
                        organizationId: organizationId,
                        content: content,
                        tags: tags,
                        color: color
                    )
                )
            } catch {
                guard !error.isCancellation else { throw error }
                if Self.isSaveBusy(error), attempt < saveBusyMaxRetries {
                    attempt += 1
                    let delayMs = UInt64(300 * attempt)
                    try? await Task.sleep(for: .milliseconds(delayMs))
                    continue
                }
                throw error
            }
        }
    }

    private nonisolated static func makeCreateMemoBody(
        organizationId: String,
        content: String,
        tags: [String],
        color: MemoColor
    ) -> sending [String: Any] {
        var body: [String: Any] = [
            "organization_id": organizationId,
            "content_json": [String: Any](),
            "content_markdown": content,
            "source": "manual",
            "memo_type": "note",
        ]
        if !tags.isEmpty {
            body["tags"] = tags
        }
        if color != .none {
            body["color"] = color.rawValue
        }
        return body
    }

    private nonisolated static func makeAttachmentBody(
        fileRecordId: String,
        fileType: String
    ) -> sending [String: Any] {
        [
            "file_record_id": fileRecordId,
            "file_type": fileType,
        ]
    }

    private func uploadAttachment(for memoId: String) async {
        guard let data = draftAttachmentData else { return }
        let fileName = draftAttachmentName ?? "attachment"
        let contentType = draftAttachmentContentType
        attachmentPhase = .uploading
        attachmentError = nil
        do {
            let uploaded = try await OSSUploadService.shared.directUpload(
                data: data,
                fileName: fileName,
                contentType: contentType,
                folder: "tabmemo/attachments",
                scope: UploadScope(
                    module: "tabmemo",
                    contextType: "organization",
                    contextId: organizationId,
                    organizationId: organizationId,
                    isPublic: false
                )
            )
            attachmentPhase = .binding
            let fileType = contentType.hasPrefix("image/") ? "image" : "file"
            let _: [String: AnyCodable] = try await APIClient.shared.post(
                path: Endpoints.TabMemo.attachments(memoId),
                body: Self.makeAttachmentBody(
                    fileRecordId: uploaded.fileId,
                    fileType: fileType
                )
            )
            draftAttachmentData = nil
            draftAttachmentName = nil
            lastCreatedMemoIdForAttachment = nil
            attachmentPhase = .ready
            attachmentError = nil
        } catch {
            guard !error.isCancellation else { return }
            // 正文已保存；保留重试入口与本地附件数据
            attachmentPhase = .failed
            attachmentError = Self.userMessage(for: error)
            lastCreatedMemoIdForAttachment = memoId
        }
    }

    /// 仅认业务码 `SAVE_BUSY`（含 `apiErrorWithCode` 与 `responseError` 嵌入的 `[SAVE_BUSY]`）。
    /// 不把裸 HTTP 409 当成忙。
    private nonisolated static func isSaveBusy(_ error: Error) -> Bool {
        if let apiError = error as? APIError, apiError.businessCode == "SAVE_BUSY" {
            return true
        }
        return false
    }

    private nonisolated static func userMessage(for error: Error) -> String {
        if isSaveBusy(error) {
            return L10n.MemoAppHome.saveBusy
        }
        if case APIError.apiErrorWithCode(_, let message) = error {
            return message
        }
        return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    #if DEBUG
    nonisolated static func isSaveBusyForTesting(_ error: Error) -> Bool {
        isSaveBusy(error)
    }

    nonisolated static func userMessageForTesting(_ error: Error) -> String {
        userMessage(for: error)
    }
    #endif

    func setPinned(_ memo: CloudMemoSummary, pinned: Bool) async {
        let previous = memos
        if let idx = memos.firstIndex(where: { $0.id == memo.id }) {
            memos[idx] = memos[idx].withPinned(pinned)
        }
        do {
            let _: CloudMemoSummary = try await APIClient.shared.post(
                path: Endpoints.TabMemo.pin(memo.id),
                body: ["pinned": pinned]
            )
        } catch {
            guard !error.isCancellation else { return }
            memos = previous
            actionError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func trash(_ memo: CloudMemoSummary) async {
        let previous = memos
        memos.removeAll { $0.id == memo.id }
        do {
            let _: [String: AnyCodable] = try await APIClient.shared.post(
                path: Endpoints.TabMemo.trash(memo.id),
                body: [:]
            )
        } catch {
            guard !error.isCancellation else { return }
            memos = previous
            actionError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func removeMemo(id: String) {
        memos.removeAll { $0.id == id }
    }

    func applyPinned(id: String, pinned: Bool) {
        if let idx = memos.firstIndex(where: { $0.id == id }) {
            memos[idx] = memos[idx].withPinned(pinned)
        }
    }

    func clearActionError() {
        actionError = nil
    }

    /// 单测注入列表快照，不走网络。
    func replaceMemosForTesting(_ items: [CloudMemoSummary]) {
        memos = items
        diaryItems = []
        pageError = nil
    }

    // MARK: - Private

    private func reload(isPullToRefresh: Bool) async {
        listTask?.cancel()
        let token = await requestGate.begin()
        if isPullToRefresh {
            isRefreshing = true
        } else if !hasListContent {
            isInitialLoading = true
        }
        pageError = nil
        loadMoreError = nil
        nextCursor = nil
        hasMore = false

        listTask = Task { [weak self] in
            guard let self else { return }
            do {
                switch self.viewKind {
                case .agentDiary:
                    let response = try await self.fetchDiary(cursor: nil)
                    guard await self.requestGate.isCurrent(token) else { return }
                    self.diaryItems = response.items
                    self.memos = []
                    self.nextCursor = response.nextCursor.isEmpty ? nil : response.nextCursor
                    self.hasMore = response.hasMore
                case .all, .today:
                    let response = try await self.fetchMemos(cursor: nil)
                    guard await self.requestGate.isCurrent(token) else { return }
                    self.memos = response.items
                    self.diaryItems = []
                    self.nextCursor = self.emptyToNil(response.nextCursor)
                    self.hasMore = response.hasMore ?? !(response.nextCursor ?? "").isEmpty
                }
            } catch {
                guard await self.requestGate.isCurrent(token) else { return }
                guard !error.isCancellation else { return }
                if !self.hasListContent {
                    self.pageError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                } else {
                    self.loadMoreError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                }
            }
            if await self.requestGate.isCurrent(token) {
                self.isInitialLoading = false
                self.isRefreshing = false
            }
        }
        await listTask?.value
    }

    private func fetchMemos(cursor: String?) async throws -> CloudMemoListResponse {
        var query: [String: String] = [
            "organization_id": organizationId,
            "status": "active",
            "sort": "-created_at",
            "limit": "30",
        ]
        if let cursor, !cursor.isEmpty {
            query["cursor"] = cursor
        }
        if !normalizedSearch.isEmpty {
            query["search"] = normalizedSearch
        }
        if !selectedTags.isEmpty {
            query["tags"] = selectedTags.joined(separator: ",")
        }
        if let bounds = currentCreatedBounds() {
            query["created_after"] = MemoTimelineProjector.iso8601String(from: bounds.after)
            query["created_before"] = MemoTimelineProjector.iso8601String(from: bounds.before)
        }
        return try await APIClient.shared.get(path: Endpoints.TabMemo.memos, query: query)
    }

    private func fetchDiary(cursor: String?) async throws -> AgentDiaryFeedResponse {
        var query: [String: String] = [
            "organization_id": organizationId,
            "state": "active",
            "limit": "30",
        ]
        if let cursor, !cursor.isEmpty {
            query["cursor"] = cursor
        }
        if !normalizedSearch.isEmpty {
            query["search"] = normalizedSearch
        }
        return try await APIClient.shared.get(path: Endpoints.TabMemo.diaryFeed, query: query)
    }

    private func currentCreatedBounds() -> (after: Date, before: Date)? {
        if let dayKey = heatmapDayKey,
           let day = MemoTimelineProjector.date(fromServerDay: dayKey) {
            return MemoTimelineProjector.localDayBounds(for: day)
        }
        if viewKind == .today {
            return MemoTimelineProjector.localDayBounds(for: Date())
        }
        return nil
    }

    private func shouldIncludeInCurrentFilters(_ memo: CloudMemoSummary) -> Bool {
        if viewKind == .today || heatmapDayKey != nil {
            guard let bounds = currentCreatedBounds(),
                  let created = memo.createdDate else { return true }
            return created >= bounds.after && created < bounds.before
        }
        if !normalizedSearch.isEmpty {
            let q = normalizedSearch.lowercased()
            guard memo.displayText.lowercased().contains(q)
                    || memo.allTags.contains(where: { $0.lowercased().contains(q) }) else {
                return false
            }
        }
        if !selectedTags.isEmpty {
            let tagSet = Set(memo.tags)
            guard selectedTags.allSatisfy({ tagSet.contains($0) }) else { return false }
        }
        return true
    }

    private func loadHeatmap() async {
        heatmapTask?.cancel()
        heatmapTask = Task { [weak self] in
            guard let self else { return }
            do {
                let response: MemoHeatmapResponse = try await APIClient.shared.get(
                    path: Endpoints.TabMemo.heatmap,
                    query: [
                        "organization_id": self.organizationId,
                        "days": "84",
                    ]
                )
                guard !Task.isCancelled else { return }
                self.heatmapBuckets = response.buckets
                self.monthCount = MemoTimelineProjector.monthCount(from: response.buckets)
                self.heatmapError = nil
            } catch {
                guard !error.isCancellation else { return }
                // 热力图失败不阻塞主列表
                self.heatmapError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
        await heatmapTask?.value
    }

    private func loadTagStats() async {
        do {
            let response: MemoTagStatsResponse = try await APIClient.shared.get(
                path: Endpoints.TabMemo.tagStats,
                query: ["organization_id": organizationId]
            )
            tagStats = response.tags
        } catch {
            guard !error.isCancellation else { return }
            // 标签统计失败仍允许手输
        }
    }

    private func emptyToNil(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}

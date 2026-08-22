import Foundation
import os

enum NativeTabDocSaveState: Equatable, Sendable {
    case idle
    case dirty
    case saving
    case saved
    case conflict
    case permissionDenied
    case failed
}

enum NativeTabDocSaveCommitPolicy {
    static func hasEditsAfterSnapshot(
        currentTitle: String,
        currentBody: NativeTabDocBody,
        snapshot: NativeTabDocDraft
    ) -> Bool {
        guard currentTitle == snapshot.title else { return true }
        guard let currentData = stableSerializedData(currentBody),
              let snapshotData = stableSerializedData(snapshot.body)
        else {
            return true
        }
        return currentData != snapshotData
    }

    private static func stableSerializedData(_ body: NativeTabDocBody) -> Data? {
        try? JSONSerialization.data(
            withJSONObject: body.serializedJSON.mapValues(\.value),
            options: [.sortedKeys]
        )
    }

    static func canFinishFlush(
        isDirty: Bool,
        saveState: NativeTabDocSaveState,
        hasSaveInFlight: Bool
    ) -> Bool {
        !isDirty && saveState == .saved && !hasSaveInFlight
    }
}

@MainActor @Observable
final class NativeTabDocSession {
    typealias DetailRequest = @MainActor (String) async throws -> NativeTabDocDetail
    typealias WriteRequest = @MainActor (String, NativeTabDocDraft) async throws -> NativeTabDocWriteResponse
    typealias HistoryListRequest = @MainActor (String) async throws -> [NativeTabDocHistoryEntry]
    typealias RestoreRequest = @MainActor (String, String) async throws -> Void
    typealias CommentThreadsListRequest = @MainActor (String) async throws -> NativeTabDocCommentThreadListResponse
    typealias CommentThreadCreateRequest = @MainActor (String, sending [String: Any]) async throws -> NativeTabDocCommentThreadCreateResponse

    let documentId: String
    let organizationId: String

    private(set) var document: NativeTabDocDocument?
    private(set) var title: String
    private(set) var body = NativeTabDocBody(rootAttributes: ["type": AnyCodable("doc")], blocks: []) {
        didSet {
            guard body != oldValue, !commentThreads.isEmpty else { return }
            refreshCommentPresentations()
        }
    }
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var saveError: String?
    private(set) var saveState: NativeTabDocSaveState = .idle
    private(set) var canUndo = false
    private(set) var canRedo = false
    private(set) var localDraftForRecovery: NativeTabDocDraft?
    private(set) var versionHistories: [NativeTabDocHistoryEntry] = []
    private(set) var isLoadingHistories = false
    private(set) var isRestoringHistory = false
    private(set) var isShowingVersionHistory = false
    private(set) var versionHistoryMessage: String?
    private(set) var commentThreads: [NativeTabDocCommentThread] = []
    private(set) var commentPresentations: [NativeTabDocCommentPresentation] = []
    private(set) var isPostingComment = false
    private(set) var documentCommentDraft = ""
    private(set) var blockCommentDraft = ""
    private(set) var isShowingBlockCommentComposer = false
    private(set) var commentMessage: String?
    private var commentComposerBlockId: UUID?

    private let draftStore: NativeTabDocDraftStore
    private let userId: String
    private let sessionFence: NativeCloudSessionFence
    private let sessionIsCurrent: @MainActor () -> Bool
    private let detailRequest: DetailRequest
    private let writeRequest: WriteRequest
    private let historyListRequest: HistoryListRequest
    private let restoreRequest: RestoreRequest
    private let commentThreadsListRequest: CommentThreadsListRequest
    private let commentThreadCreateRequest: CommentThreadCreateRequest
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "NativeTabDoc")
    private var baseTitle: String
    private var baseBody = NativeTabDocBody(rootAttributes: ["type": AnyCodable("doc")], blocks: [])
    private var autosaveTask: Task<Void, Never>?
    private var saveTask: Task<Bool, Never>?
    private var saveGeneration = 0
    private var loadSequence = 0
    private var hasBaselineConflict = false
    private var activeBaseVersion: Int?
    private var activeBaseUpdatedAt: String?
    /// 网络失败时请求可能已落库；下一次 409 只用该快照识别本会话自己的远端写入。
    private var unacknowledgedSave: NativeTabDocDraft?
    private var undoStack: [NativeTabDocEditorSnapshot] = []
    private var redoStack: [NativeTabDocEditorSnapshot] = []
    private var pendingUndoSnapshot: NativeTabDocEditorSnapshot?
    private var textUndoTask: Task<Void, Never>?

    init(
        documentId: String,
        organizationId: String,
        fallbackTitle: String,
        draftStore: NativeTabDocDraftStore = NativeTabDocDraftStore(),
        userId: String? = nil,
        sessionGeneration: UInt64? = nil,
        sessionIsCurrent: (@MainActor () -> Bool)? = nil,
        detailRequest: DetailRequest? = nil,
        writeRequest: WriteRequest? = nil,
        historyListRequest: HistoryListRequest? = nil,
        restoreRequest: RestoreRequest? = nil,
        commentThreadsListRequest: CommentThreadsListRequest? = nil,
        commentThreadCreateRequest: CommentThreadCreateRequest? = nil
    ) {
        self.documentId = documentId
        self.organizationId = organizationId
        self.title = fallbackTitle
        self.baseTitle = fallbackTitle
        self.draftStore = draftStore
        let resolvedUserId = userId ?? AuthService.shared.currentUser?.id ?? "anonymous"
        let resolvedGeneration = sessionGeneration ?? AuthService.shared.sessionGeneration
        self.userId = resolvedUserId
        self.localDraftForRecovery = draftStore.load(
            documentId: documentId,
            userId: resolvedUserId,
            organizationId: organizationId
        )
        self.sessionFence = NativeCloudSessionFence(
            userId: resolvedUserId,
            generation: resolvedGeneration,
            organizationId: organizationId
        )
        self.sessionIsCurrent = sessionIsCurrent ?? {
            let auth = AuthService.shared
            return NativeCloudSessionFence(
                userId: resolvedUserId,
                generation: resolvedGeneration,
                organizationId: organizationId
            ).matches(
                userId: auth.currentUser?.id,
                generation: auth.sessionGeneration,
                organizationId: WorkspaceStore.shared.selectedOrganizationId
            )
        }
        self.detailRequest = detailRequest ?? { documentId in
            try await APIClient.shared.get(path: Endpoints.TabDoc.document(documentId))
        }
        self.writeRequest = writeRequest ?? { documentId, draft in
            try await APIClient.shared.post(
                path: Endpoints.TabDoc.documentContent(documentId),
                body: Self.saveBody(draft)
            )
        }
        self.historyListRequest = historyListRequest ?? { documentId in
            try await APIClient.shared.get(path: Endpoints.TabDoc.documentVersions(documentId))
        }
        self.restoreRequest = restoreRequest ?? { documentId, versionId in
            let _: NativeTabDocRestoreResponse = try await APIClient.shared.post(
                path: Endpoints.TabDoc.documentRestore(documentId),
                body: ["version_id": versionId]
            )
        }
        self.commentThreadsListRequest = commentThreadsListRequest ?? { documentId in
            try await APIClient.shared.get(path: Endpoints.TabDoc.documentCommentThreads(documentId))
        }
        self.commentThreadCreateRequest = commentThreadCreateRequest ?? { documentId, body in
            try await APIClient.shared.post(
                path: Endpoints.TabDoc.documentCommentThreads(documentId),
                body: body
            )
        }
    }

    var canEdit: Bool {
        sessionIsCurrent()
            && document?.canEdit == true
            && saveState != .permissionDenied
            && !hasBaselineConflict
            && NativeTabDocEditPolicy.allowsWholeDocumentEdit(body)
    }
    var canCreateComment: Bool {
        NativeTabDocCommentWritePolicy.canCreate(
            saveState: saveState,
            isReadOnly: !sessionIsCurrent()
                || document?.canEdit != true
                || saveState == .permissionDenied,
            requiresFullEditor: !NativeTabDocEditPolicy.allowsWholeDocumentEdit(body)
        )
    }
    var isDirty: Bool { title != baseTitle || body != baseBody }
    var hasUnsupportedBlocks: Bool { body.hasUnsupportedBlocks }
    var hasProjectedTableCells: Bool { body.hasProjectedTableCells }
    var canViewLocalDraftForRecovery: Bool {
        NativeTabDocLocalDraftRecoveryPolicy.canView(
            documentLoaded: document != nil,
            hasLocalDraft: localDraftForRecovery != nil
        )
    }

    @discardableResult
    func validateSession() -> Bool {
        requireCurrentSession()
    }

    func load() async {
        guard requireCurrentSession() else { return }
        guard !isLoading else { return }
        loadSequence += 1
        let sequence = loadSequence
        isLoading = true
        defer {
            if sequence == loadSequence { isLoading = false }
        }
        loadError = nil
        NativeTabDocInlineImageStore.shared.reset()
        logger.info("Loading native TabDoc id=\(self.documentId, privacy: .public)")
        do {
            let detail = try await detailRequest(documentId)
            guard sequence == loadSequence else { return }
            guard requireCurrentSession() else { return }
            guard NativeCloudOrganizationBoundary.matches(
                resourceOrganizationId: detail.document.organizationId,
                expectedOrganizationId: organizationId
            ) else {
                draftStore.remove(
                    documentId: documentId,
                    userId: userId,
                    organizationId: organizationId
                )
                clearProtectedContent()
                saveState = .permissionDenied
                loadError = L10n.TabDoc.permissionMessage
                return
            }
            guard detail.document.id == documentId else {
                rejectMismatchedDetailResponse(surfacesLoadError: true)
                return
            }
            document = detail.document
            baseTitle = detail.document.title
            baseBody = NativeTabDocBody.parse(
                json: detail.content.descriptionJSON,
                markdownFallback: detail.content.descriptionMarkdown
            )
            if let draft = draftStore.load(
                documentId: documentId,
                userId: userId,
                organizationId: organizationId
            ) {
                let baselineResolution = NativeTabDocDraftBaselinePolicy.resolve(
                    draftVersion: draft.baseVersion,
                    draftUpdatedAt: draft.baseUpdatedAt,
                    remoteVersion: detail.document.latestVersion,
                    remoteUpdatedAt: detail.document.updatedAt
                )
                if case .conflict = baselineResolution,
                   NativeTabDocConflictRebasePolicy.remoteMatchesCommittedSnapshot(
                    remoteTitle: baseTitle,
                    remoteBody: baseBody,
                    committedTitle: draft.title,
                    committedBody: draft.body
                   ) {
                    // 上次 REST 写入已成功，但协作回流又推进了版本时，App 可能在收到
                    // 成功响应前退出，留下一个“旧基线、内容已落云”的草稿。远端与草稿
                    // 严格语义等价时采用远端 canonical 版本，并清除伪冲突草稿。
                    draftStore.remove(
                        documentId: documentId,
                        userId: userId,
                        organizationId: organizationId
                    )
                    localDraftForRecovery = nil
                    title = baseTitle
                    body = baseBody
                    activeBaseVersion = detail.document.latestVersion
                    activeBaseUpdatedAt = detail.document.updatedAt
                    hasBaselineConflict = false
                    saveState = .saved
                    saveError = nil
                    logger.info("Resolved equivalent native TabDoc draft id=\(self.documentId, privacy: .public)")
                } else {
                    localDraftForRecovery = draft
                    title = draft.title
                    body = draft.body
                    switch baselineResolution {
                    case .resume(let version, let updatedAt):
                        activeBaseVersion = version
                        activeBaseUpdatedAt = updatedAt
                        hasBaselineConflict = false
                    case .conflict(let version, let updatedAt):
                        activeBaseVersion = version
                        activeBaseUpdatedAt = updatedAt
                        hasBaselineConflict = true
                    }
                    saveState = hasBaselineConflict ? .conflict : .dirty
                    if hasBaselineConflict {
                        saveError = L10n.TabDoc.conflictMessage
                    }
                }
            } else {
                localDraftForRecovery = nil
                title = baseTitle
                body = baseBody
                activeBaseVersion = detail.document.latestVersion
                activeBaseUpdatedAt = detail.document.updatedAt
                saveState = .saved
            }
            resetUndoHistory()
            logger.info("Loaded native TabDoc id=\(self.documentId, privacy: .public) blocks=\(self.body.blocks.count)")
            await loadCommentThreads(sequence: sequence)
        } catch {
            guard sequence == loadSequence else { return }
            guard requireCurrentSession() else { return }
            if NativeTabDocSaveFailurePolicy.mustPurgeLocalDraftAfterReadFailure(error) {
                draftStore.remove(
                    documentId: documentId,
                    userId: userId,
                    organizationId: organizationId
                )
                clearProtectedContent()
                saveState = .permissionDenied
            }
            loadError = error.localizedDescription
            logger.error("Native TabDoc load failed id=\(self.documentId, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
        }
    }

    func resolveImageSource(_ image: NativeTabDocImage) async -> URL? {
        guard requireCurrentSession() else { return nil }
        if let fileId = image.fileId, !fileId.isEmpty {
            do {
                let access: NativeTabDocImageAssetAccess = try await APIClient.shared.get(
                    path: Endpoints.TabDoc.documentImageAsset(documentId, fileId: fileId)
                )
                guard requireCurrentSession() else { return nil }
                return URL(string: access.url)
            } catch {
                guard requireCurrentSession() else { return nil }
                logger.warning(
                    "Native TabDoc image resolve failed id=\(self.documentId, privacy: .public) file=\(fileId, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
                )
            }
        }
        guard requireCurrentSession() else { return nil }
        return URL(string: image.source)
    }

    /// 行内图片与块级图片共用同一条鉴权链路：fileId 是稳定引用，优先换取短时签名地址；
    /// 换不到才退回文档里带的渲染期 src。两者都拿不到时返回 nil，呈现层退回 alt 占位。
    func resolveInlineImageSource(
        _ descriptor: NativeTabDocInlineImagePresentation.Descriptor
    ) async -> URL? {
        guard requireCurrentSession() else { return nil }
        if !descriptor.fileId.isEmpty {
            do {
                let access: NativeTabDocImageAssetAccess = try await APIClient.shared.get(
                    path: Endpoints.TabDoc.documentImageAsset(documentId, fileId: descriptor.fileId)
                )
                guard requireCurrentSession() else { return nil }
                if let url = URL(string: access.url) { return url }
            } catch {
                guard requireCurrentSession() else { return nil }
                logger.warning(
                    "Native TabDoc inline image resolve failed id=\(self.documentId, privacy: .public) file=\(descriptor.fileId, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
                )
            }
        }
        guard requireCurrentSession(), !descriptor.source.isEmpty else { return nil }
        return URL(string: descriptor.source)
    }

    func updateTitle(_ value: String) {
        guard canEdit else { return }
        scheduleTextUndo()
        title = value
        markDirty()
    }

    func updateBlock(id: UUID, text: String) {
        guard canEdit, let index = body.blocks.firstIndex(where: { $0.id == id }) else { return }
        guard body.blocks[index].kind.allowsInlineEditing else { return }
        scheduleTextUndo()
        body.blocks[index].text = text
        markDirty()
    }

    func updateBlockSpans(id: UUID, spans: [NativeTabDocInlineSpan]) {
        guard canEdit, let index = body.blocks.firstIndex(where: { $0.id == id }) else { return }
        guard body.blocks[index].kind.allowsInlineEditing else { return }
        scheduleTextUndo()
        body.blocks[index].spans = spans
        markDirty()
    }

    func mergeBlockWithPrevious(id: UUID) -> NativeTabDocEditorFocusDestination? {
        guard canEdit else { return nil }
        let result = NativeTabDocBackspacePolicy.mergeBlockWithPrevious(
            blocks: body.blocks,
            blockId: id
        )
        guard result.didMutate else { return nil }
        body.blocks = result.blocks
        markDirty()
        return result.focus
    }

    func updateListItem(blockId: UUID, itemId: UUID, text: String) {
        updateListItemSpans(blockId: blockId, itemId: itemId, spans: .nativeTabDocPlain(text))
    }

    func updateListItemSpans(
        blockId: UUID,
        itemId: UUID,
        spans: [NativeTabDocInlineSpan]
    ) {
        guard canEdit,
              let blockIndex = body.blocks.firstIndex(where: { $0.id == blockId })
        else { return }
        guard Self.containsListItem(in: body.blocks[blockIndex].listItems, id: itemId) else { return }
        scheduleTextUndo()
        guard mutateListItem(in: &body.blocks[blockIndex].listItems, id: itemId, transform: { (item: inout NativeTabDocListItem) in
            item.spans = spans
        }) else { return }
        markDirty()
    }

    func mergeListItemWithPrevious(
        blockId: UUID,
        itemId: UUID
    ) -> NativeTabDocEditorFocusDestination? {
        guard canEdit else { return nil }
        let result = NativeTabDocBackspacePolicy.mergeListItemWithPrevious(
            blocks: body.blocks,
            blockId: blockId,
            itemId: itemId
        )
        guard result.didMutate else { return nil }
        body.blocks = result.blocks
        markDirty()
        return result.focus
    }

    func toggleTask(blockId: UUID, itemId: UUID) {
        guard canEdit,
              let blockIndex = body.blocks.firstIndex(where: { $0.id == blockId })
        else { return }
        // 子列表 kind 独立于顶层 block：无序里可以套任务列表。勾选只能看该项所在那一层。
        guard Self.canToggleTask(
            in: body.blocks[blockIndex].listItems,
            id: itemId,
            listKind: body.blocks[blockIndex].kind
        ) else { return }
        pushUndo()
        var didToggle = false
        _ = mutateListItem(
            in: &body.blocks[blockIndex].listItems,
            id: itemId,
            listKind: body.blocks[blockIndex].kind
        ) { item, listKind in
            guard case .taskList = listKind else { return }
            item.isChecked.toggle()
            didToggle = true
        }
        if didToggle { markDirty() }
    }

    func addListItem(blockId: UUID, afterItemId: UUID? = nil) {
        guard canEdit, let index = body.blocks.firstIndex(where: { $0.id == blockId }) else { return }
        switch body.blocks[index].kind {
        case .bulletList, .orderedList, .taskList:
            // 指定目标项时插在该项同一层后面，避免在嵌套项上「添加一项」却跑到整张列表末尾。
            if let afterItemId {
                guard Self.containsListItem(in: body.blocks[index].listItems, id: afterItemId) else { return }
                pushUndo()
                guard insertListItem(in: &body.blocks[index].listItems, after: afterItemId) else { return }
            } else {
                pushUndo()
                body.blocks[index].listItems.append(NativeTabDocListItem())
            }
            markDirty()
        default:
            break
        }
    }

    func canIndentListItem(blockId: UUID, itemId: UUID) -> Bool {
        guard canEdit, let block = body.blocks.first(where: { $0.id == blockId }) else { return false }
        return Self.canIndentListItem(in: block.listItems, id: itemId, depth: 0)
    }

    func canOutdentListItem(blockId: UUID, itemId: UUID) -> Bool {
        guard canEdit, let block = body.blocks.first(where: { $0.id == blockId }) else { return false }
        return Self.canOutdentListItem(in: block.listItems, id: itemId, isTopLevel: true)
    }

    func indentListItem(blockId: UUID, itemId: UUID) {
        guard canEdit,
              let blockIndex = body.blocks.firstIndex(where: { $0.id == blockId })
        else { return }
        guard Self.canIndentListItem(in: body.blocks[blockIndex].listItems, id: itemId, depth: 0) else { return }
        pushUndo()
        switch applyIndent(
            in: &body.blocks[blockIndex].listItems,
            id: itemId,
            listKind: body.blocks[blockIndex].kind,
            depth: 0
        ) {
        case .applied:
            markDirty()
        case .notFound, .rejected:
            break
        }
    }

    func outdentListItem(blockId: UUID, itemId: UUID) {
        guard canEdit,
              let blockIndex = body.blocks.firstIndex(where: { $0.id == blockId })
        else { return }
        guard Self.canOutdentListItem(in: body.blocks[blockIndex].listItems, id: itemId, isTopLevel: true) else { return }
        pushUndo()
        switch applyOutdent(in: &body.blocks[blockIndex].listItems, id: itemId) {
        case .applied:
            markDirty()
        case .notFound, .rejected:
            break
        }
    }

    func removeListItem(blockId: UUID, itemId: UUID) {
        guard canEdit,
              let blockIndex = body.blocks.firstIndex(where: { $0.id == blockId })
        else { return }
        let topItems = body.blocks[blockIndex].listItems
        // 顶层只剩这一项时，删它（含子树）等于清空整张列表，与原先「只剩一项就拆掉 block」一致。
        if topItems.count == 1, topItems[0].id == itemId {
            pushUndo()
            body.blocks.remove(at: blockIndex)
            markDirty()
            return
        }
        guard Self.containsListItem(in: topItems, id: itemId) else { return }
        pushUndo()
        guard removeListItem(from: &body.blocks[blockIndex].listItems, id: itemId) else { return }
        markDirty()
    }

    /// 值语义下必须 inout 回写整条路径；命中即停，避免继续扫兄弟子树。
    @discardableResult
    private func mutateListItem(
        in items: inout [NativeTabDocListItem],
        id: UUID,
        transform: (inout NativeTabDocListItem) -> Void
    ) -> Bool {
        // 本重载不消费 kind；占位只为复用带层 kind 的同一条递归路径。
        mutateListItem(in: &items, id: id, listKind: .bulletList) { item, _ in
            transform(&item)
        }
    }

    @discardableResult
    private func mutateListItem(
        in items: inout [NativeTabDocListItem],
        id: UUID,
        listKind: NativeTabDocBlockKind,
        transform: (inout NativeTabDocListItem, NativeTabDocBlockKind) -> Void
    ) -> Bool {
        if let index = items.firstIndex(where: { $0.id == id }) {
            transform(&items[index], listKind)
            return true
        }
        for index in items.indices {
            guard var nested = items[index].nested else { continue }
            guard mutateListItem(
                in: &nested.items,
                id: id,
                listKind: nested.kind,
                transform: transform
            ) else { continue }
            items[index].nested = nested
            return true
        }
        return false
    }

    /// 空子列表写回会变成 `content: []`，桌面端/后端可能拒收，所以父项要摘掉容器而不是留空壳。
    @discardableResult
    private func removeListItem(
        from items: inout [NativeTabDocListItem],
        id: UUID
    ) -> Bool {
        if let index = items.firstIndex(where: { $0.id == id }) {
            items.remove(at: index)
            return true
        }
        for index in items.indices {
            guard var nested = items[index].nested else { continue }
            guard removeListItem(from: &nested.items, id: id) else { continue }
            items[index].nested = nested.items.isEmpty ? nil : nested
            return true
        }
        return false
    }

    private enum ListTreeEdit {
        case notFound
        case applied
        case rejected
    }

    @discardableResult
    private func insertListItem(
        in items: inout [NativeTabDocListItem],
        after id: UUID
    ) -> Bool {
        if let index = items.firstIndex(where: { $0.id == id }) {
            items.insert(NativeTabDocListItem(), at: index + 1)
            return true
        }
        for index in items.indices {
            guard var nested = items[index].nested else { continue }
            guard insertListItem(in: &nested.items, after: id) else { continue }
            items[index].nested = nested
            return true
        }
        return false
    }

    private static func canIndentListItem(
        in items: [NativeTabDocListItem],
        id: UUID,
        depth: Int
    ) -> Bool {
        if let index = items.firstIndex(where: { $0.id == id }) {
            return index > 0
                && depth + 1 + extraNestedDepth(of: items[index]) <= NativeTabDocNestedList.maxDepth
        }
        for item in items {
            guard let nested = item.nested else { continue }
            if canIndentListItem(in: nested.items, id: id, depth: depth + 1) {
                return true
            }
        }
        return false
    }

    private static func canOutdentListItem(
        in items: [NativeTabDocListItem],
        id: UUID,
        isTopLevel: Bool
    ) -> Bool {
        if items.contains(where: { $0.id == id }) {
            return !isTopLevel
        }
        for item in items {
            guard let nested = item.nested else { continue }
            if canOutdentListItem(in: nested.items, id: id, isTopLevel: false) {
                return true
            }
        }
        return false
    }

    private static func containsListItem(in items: [NativeTabDocListItem], id: UUID) -> Bool {
        if items.contains(where: { $0.id == id }) { return true }
        for item in items {
            guard let nested = item.nested else { continue }
            if containsListItem(in: nested.items, id: id) { return true }
        }
        return false
    }

    private static func canToggleTask(
        in items: [NativeTabDocListItem],
        id: UUID,
        listKind: NativeTabDocBlockKind
    ) -> Bool {
        if items.contains(where: { $0.id == id }) {
            if case .taskList = listKind { return true }
            return false
        }
        for item in items {
            guard let nested = item.nested else { continue }
            if canToggleTask(in: nested.items, id: id, listKind: nested.kind) {
                return true
            }
        }
        return false
    }

    private static func extraNestedDepth(of item: NativeTabDocListItem) -> Int {
        guard let nested = item.nested, !nested.items.isEmpty else { return 0 }
        return 1 + (nested.items.map(extraNestedDepth(of:)).max() ?? 0)
    }

    /// 新容器必须是「只有 type」的最小节点。抄父列表 rawNode 会把既有 blockId 一起带上，
    /// 两个容器就会共享同一身份，块评和分享锚点会指错对象。
    private static func minimalNestedListRawNode(
        for kind: NativeTabDocBlockKind
    ) -> [String: AnyCodable] {
        let type: String
        switch kind {
        case .orderedList: type = "orderedList"
        case .taskList: type = "taskList"
        default: type = "bulletList"
        }
        return ["type": AnyCodable(type)]
    }

    private func appendChild(
        to parent: inout NativeTabDocListItem,
        child: NativeTabDocListItem,
        layerKind: NativeTabDocBlockKind
    ) {
        if var nested = parent.nested {
            nested.items.append(child)
            parent.nested = nested
        } else {
            parent.nested = NativeTabDocNestedList(
                kind: layerKind,
                items: [child],
                rawNode: Self.minimalNestedListRawNode(for: layerKind)
            )
        }
    }

    private func appendChildren(
        to parent: inout NativeTabDocListItem,
        children: [NativeTabDocListItem],
        layerKind: NativeTabDocBlockKind
    ) {
        guard !children.isEmpty else { return }
        if var nested = parent.nested {
            nested.items.append(contentsOf: children)
            parent.nested = nested
        } else {
            parent.nested = NativeTabDocNestedList(
                kind: layerKind,
                items: children,
                rawNode: Self.minimalNestedListRawNode(for: layerKind)
            )
        }
    }

    private func applyIndent(
        in items: inout [NativeTabDocListItem],
        id: UUID,
        listKind: NativeTabDocBlockKind,
        depth: Int
    ) -> ListTreeEdit {
        if let index = items.firstIndex(where: { $0.id == id }) {
            guard index > 0,
                  depth + 1 + Self.extraNestedDepth(of: items[index]) <= NativeTabDocNestedList.maxDepth
            else { return .rejected }
            let moving = items.remove(at: index)
            appendChild(to: &items[index - 1], child: moving, layerKind: listKind)
            return .applied
        }
        for index in items.indices {
            guard var nested = items[index].nested else { continue }
            switch applyIndent(
                in: &nested.items,
                id: id,
                listKind: nested.kind,
                depth: depth + 1
            ) {
            case .notFound:
                continue
            case .applied:
                items[index].nested = nested
                return .applied
            case .rejected:
                return .rejected
            }
        }
        return .notFound
    }

    private func applyOutdent(
        in items: inout [NativeTabDocListItem],
        id: UUID
    ) -> ListTreeEdit {
        for index in items.indices {
            guard var nested = items[index].nested else { continue }
            if let childIndex = nested.items.firstIndex(where: { $0.id == id }) {
                var moving = nested.items[childIndex]
                // 后续兄弟必须跟着走：只提升当前项会把原来夹在它和后续兄弟之间的文档顺序拆断，
                // 渲染会变成「父项剩余子项」插到被提升项前面，看起来像文档被改坏了。
                let followers = Array(nested.items[(childIndex + 1)...])
                nested.items.removeSubrange(childIndex...)
                appendChildren(to: &moving, children: followers, layerKind: nested.kind)
                items[index].nested = nested.items.isEmpty ? nil : nested
                items.insert(moving, at: index + 1)
                return .applied
            }
            switch applyOutdent(in: &nested.items, id: id) {
            case .notFound:
                continue
            case .applied:
                items[index].nested = nested.items.isEmpty ? nil : nested
                return .applied
            case .rejected:
                return .rejected
            }
        }
        if items.contains(where: { $0.id == id }) {
            return .rejected
        }
        return .notFound
    }

    func updateTableCell(blockId: UUID, cellId: UUID, text: String) {
        updateTableCellSpans(blockId: blockId, cellId: cellId, spans: .nativeTabDocPlain(text))
    }

    func updateTableCellSpans(
        blockId: UUID,
        cellId: UUID,
        spans: [NativeTabDocInlineSpan]
    ) {
        guard canEdit,
              let blockIndex = body.blocks.firstIndex(where: { $0.id == blockId }),
              var table = body.blocks[blockIndex].table
        else { return }
        for rowIndex in table.rows.indices {
            guard let cellIndex = table.rows[rowIndex].cells.firstIndex(where: { $0.id == cellId }) else {
                continue
            }
            guard !table.isCellReadOnly(table.rows[rowIndex].cells[cellIndex]) else { return }
            scheduleTextUndo()
            table.rows[rowIndex].cells[cellIndex].spans = spans
            body.blocks[blockIndex].table = table
            markDirty()
            return
        }
    }

    func addTableRow(blockId: UUID, afterRowIndex: Int? = nil) {
        guard canEdit,
              let blockIndex = body.blocks.firstIndex(where: { $0.id == blockId }),
              var table = body.blocks[blockIndex].table,
              table.canAddRow
        else { return }
        let insertionIndex: Int
        if let afterRowIndex {
            guard table.rows.indices.contains(afterRowIndex) else { return }
            insertionIndex = afterRowIndex + 1
        } else {
            insertionIndex = table.rows.endIndex
        }
        pushUndo()
        let columnCount = max(table.columnCount, 1)
        table.rows.insert(NativeTabDocTableRow(
            cells: (0..<columnCount).map { _ in
                NativeTabDocTableCell(isReadOnlyProjection: false)
            }
        ), at: insertionIndex)
        body.blocks[blockIndex].table = table
        markDirty()
    }

    func addTableColumn(blockId: UUID, afterColumnIndex: Int? = nil) {
        guard canEdit,
              let blockIndex = body.blocks.firstIndex(where: { $0.id == blockId }),
              var table = body.blocks[blockIndex].table,
              table.canAddColumn,
              table.rows.allSatisfy({ $0.cells.count == table.columnCount })
        else { return }
        let insertionIndex: Int
        if let afterColumnIndex {
            guard (0..<table.columnCount).contains(afterColumnIndex) else { return }
            insertionIndex = afterColumnIndex + 1
        } else {
            insertionIndex = table.columnCount
        }
        pushUndo()
        for rowIndex in table.rows.indices {
            let isHeader = table.rows[rowIndex].cells.first?.isHeader ?? false
            table.rows[rowIndex].cells.insert(NativeTabDocTableCell(
                isHeader: isHeader,
                isReadOnlyProjection: false
            ), at: insertionIndex)
        }
        body.blocks[blockIndex].table = table
        markDirty()
    }

    func insertBlock(_ block: NativeTabDocBlock, after blockId: UUID?) {
        guard canEdit else { return }
        pushUndo()
        if let blockId, let index = body.blocks.firstIndex(where: { $0.id == blockId }) {
            body.blocks.insert(block, at: index + 1)
        } else {
            body.blocks.append(block)
        }
        markDirty()
    }

    func insertBlock(after blockId: UUID?, kind: NativeTabDocBlockKind) {
        guard canEdit else { return }
        pushUndo()
        let block = NativeTabDocBlock.new(kind: kind)
        if let blockId, let index = body.blocks.firstIndex(where: { $0.id == blockId }) {
            body.blocks.insert(block, at: index + 1)
        } else {
            body.blocks.append(block)
        }
        markDirty()
    }

    func removeBlock(id: UUID) {
        guard canEdit,
              let index = body.blocks.firstIndex(where: { $0.id == id }),
              body.blocks[index].kind.isSupported
        else { return }
        pushUndo()
        body.blocks.remove(at: index)
        markDirty()
    }

    func duplicateBlock(id: UUID) {
        guard canEdit,
              let index = body.blocks.firstIndex(where: { $0.id == id }),
              body.blocks[index].kind.isSupported
        else { return }
        pushUndo()
        body.blocks.insert(body.blocks[index].duplicatedForInsertion(), at: index + 1)
        markDirty()
    }

    func moveBlock(id: UUID, by offset: Int) {
        guard canEdit,
              offset == -1 || offset == 1,
              let index = body.blocks.firstIndex(where: { $0.id == id }),
              body.blocks[index].kind.isSupported
        else { return }
        let destination = index + offset
        guard body.blocks.indices.contains(destination) else { return }
        pushUndo()
        body.blocks.swapAt(index, destination)
        markDirty()
    }

    func convertBlock(id: UUID, to kind: NativeTabDocBlockKind) {
        guard canEdit,
              let index = body.blocks.firstIndex(where: { $0.id == id }),
              let converted = body.blocks[index].converted(to: kind)
        else { return }
        pushUndo()
        body.blocks[index] = converted
        markDirty()
    }

    func undo() {
        guard NativeTabDocUndoPolicy.canMutateHistory(canEdit: canEdit, saveState: saveState) else { return }
        flushPendingUndo()
        guard let snapshot = undoStack.popLast() else {
            refreshUndoAvailability()
            return
        }
        redoStack.append(currentEditorSnapshot())
        restoreEditorSnapshot(snapshot)
        refreshUndoAvailability()
    }

    func redo() {
        guard NativeTabDocUndoPolicy.canMutateHistory(canEdit: canEdit, saveState: saveState) else { return }
        flushPendingUndo()
        guard let snapshot = redoStack.popLast() else {
            refreshUndoAvailability()
            return
        }
        undoStack.append(currentEditorSnapshot())
        restoreEditorSnapshot(snapshot)
        refreshUndoAvailability()
    }

    @discardableResult
    func save() async -> Bool {
        cancelPendingAutosave()
        return await saveSingleFlight()
    }

    /// 完整编辑器是另一处可写表面。只有用户明确确认后，才丢弃当前文档的原生草稿。
    @discardableResult
    func discardDraftForFullEditor() -> Bool {
        guard requireCurrentSession() else { return false }
        cancelPendingAutosave()
        draftStore.remove(documentId: documentId, userId: userId, organizationId: organizationId)
        localDraftForRecovery = nil
        unacknowledgedSave = nil
        title = baseTitle
        body = baseBody
        activeBaseVersion = document?.latestVersion
        activeBaseUpdatedAt = document?.updatedAt
        hasBaselineConflict = false
        saveError = nil
        saveState = document == nil ? .idle : .saved
        resetUndoHistory()
        return true
    }

    func showVersionHistory() async {
        guard requireCurrentSession() else { return }
        isShowingVersionHistory = true
        versionHistoryMessage = nil
        await loadHistories()
    }

    func dismissVersionHistory() {
        isShowingVersionHistory = false
        isLoadingHistories = false
        isRestoringHistory = false
    }

    func clearVersionHistoryMessage() {
        versionHistoryMessage = nil
    }

    func restoreVersion(id: String) async {
        guard requireCurrentSession() else { return }
        guard canEdit else { return }
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        cancelPendingAutosave()
        isRestoringHistory = true
        defer { isRestoringHistory = false }
        do {
            try await restoreRequest(documentId, trimmed)
            versionHistoryMessage = L10n.TabDoc.versionRestored
            isShowingVersionHistory = false
            draftStore.remove(
                documentId: documentId,
                userId: userId,
                organizationId: organizationId
            )
            localDraftForRecovery = nil
            unacknowledgedSave = nil
            hasBaselineConflict = false
            saveError = nil
            saveState = .idle
            await load()
        } catch {
            versionHistoryMessage = L10n.TabDoc.versionRestoreFailed
        }
    }

    private func loadHistories() async {
        guard requireCurrentSession() else { return }
        isLoadingHistories = true
        defer { isLoadingHistories = false }
        do {
            versionHistories = try await historyListRequest(documentId)
            versionHistoryMessage = nil
        } catch {
            versionHistories = []
            versionHistoryMessage = L10n.TabDoc.versionLoadFailed
        }
    }

    /// 用户明确放弃冲突中的本地草稿后，必须重拉云端，不能停在分叉前的本地基线。
    func discardConflictingDraftAndReload() async {
        guard requireCurrentSession() else { return }
        cancelPendingAutosave()
        draftStore.remove(documentId: documentId, userId: userId, organizationId: organizationId)
        localDraftForRecovery = nil
        unacknowledgedSave = nil
        hasBaselineConflict = false
        saveError = nil
        saveState = .idle
        resetUndoHistory()
        await load()
    }

    @discardableResult
    func flush() async -> Bool {
        cancelPendingAutosave()
        persistDraft()

        while true {
            guard await saveSingleFlight() else { return false }
            if NativeTabDocSaveCommitPolicy.canFinishFlush(
                isDirty: isDirty,
                saveState: saveState,
                hasSaveInFlight: saveTask != nil
            ) {
                return true
            }
            guard canEdit, !hasBaselineConflict, isDirty else { return false }
        }
    }

    private func saveSingleFlight() async -> Bool {
        if let saveTask { return await saveTask.value }

        saveGeneration &+= 1
        let generation = saveGeneration
        let task = Task { @MainActor [weak self] in
            guard let self else { return false }
            let result = await self.performSave(allowEquivalentConflictRebase: true)
            if self.saveGeneration == generation {
                self.saveTask = nil
            }
            return result
        }
        saveTask = task
        return await task.value
    }

    private func performSave(allowEquivalentConflictRebase: Bool) async -> Bool {
        guard requireCurrentSession() else { return false }
        guard canEdit, let currentDocument = document else { return false }
        guard !hasBaselineConflict else {
            persistDraft()
            saveState = .conflict
            saveError = L10n.TabDoc.conflictMessage
            return false
        }
        guard isDirty else {
            saveState = .saved
            return true
        }

        persistDraft()
        let snapshot = NativeTabDocDraft(
            title: normalizedTitle,
            body: body,
            baseVersion: activeBaseVersion,
            baseUpdatedAt: activeBaseUpdatedAt
        )
        saveState = .saving
        saveError = nil
        logger.info("Saving native TabDoc id=\(self.documentId, privacy: .public) baseVersion=\(currentDocument.latestVersion ?? -1)")

        do {
            let response = try await writeRequest(documentId, snapshot)
            guard requireCurrentSession() else { return false }
            guard NativeCloudOrganizationBoundary.matches(
                    resourceOrganizationId: response.document.organizationId,
                    expectedOrganizationId: organizationId
                  )
            else {
                draftStore.remove(
                    documentId: documentId,
                    userId: userId,
                    organizationId: organizationId
                )
                clearProtectedContent()
                saveState = .permissionDenied
                saveError = L10n.TabDoc.permissionMessage
                return false
            }
            guard response.document.id == documentId else {
                persistDraft()
                hasBaselineConflict = true
                saveState = .conflict
                saveError = L10n.TabDoc.conflictMessage
                return false
            }
            unacknowledgedSave = nil
            document = response.document
            activeBaseVersion = response.document.latestVersion
            activeBaseUpdatedAt = response.document.updatedAt
            baseTitle = snapshot.title
            baseBody = snapshot.body
            if !NativeTabDocSaveCommitPolicy.hasEditsAfterSnapshot(
                currentTitle: normalizedTitle,
                currentBody: body,
                snapshot: snapshot
            ) {
                title = snapshot.title
                draftStore.remove(documentId: documentId, userId: userId, organizationId: organizationId)
                localDraftForRecovery = nil
                saveState = .saved
            } else {
                saveState = .dirty
                persistDraft()
                scheduleAutosave()
            }
            logger.info("Saved native TabDoc id=\(self.documentId, privacy: .public) version=\(response.document.latestVersion ?? -1)")
            return true
        } catch {
            guard requireCurrentSession() else { return false }
            let failure = NativeTabDocSaveFailurePolicy.resolve(error)
            persistDraft()
            switch failure {
            case .conflict:
                if allowEquivalentConflictRebase,
                   await rebaseEquivalentVersionAdvanceAndRetry() {
                    return true
                }
                if saveState == .permissionDenied { return false }
                hasBaselineConflict = true
                saveState = .conflict
                saveError = L10n.TabDoc.conflictMessage
            case .permissionDenied, .resourceUnavailable:
                await revalidateAfterWriteDenial()
            case .retryable:
                // 请求可能已在服务端提交，但成功响应在返回途中丢失。
                unacknowledgedSave = snapshot
                saveState = .failed
                saveError = error.localizedDescription
            case .terminal:
                saveState = .failed
                saveError = error.localizedDescription
            }
            logger.error("Native TabDoc save failed id=\(self.documentId, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// 生产协作链路可能在 REST 保存成功后继续推进版本，响应也可能在返回途中丢失。
    /// 只有远端仍严格等于最后一次已确认或未确认快照时，才推进 CAS 基线；真实协作者
    /// 变化仍停在冲突态。
    private func rebaseEquivalentVersionAdvanceAndRetry() async -> Bool {
        do {
            let detail = try await detailRequest(documentId)
            guard requireCurrentSession() else { return false }
            guard NativeCloudOrganizationBoundary.matches(
                resourceOrganizationId: detail.document.organizationId,
                expectedOrganizationId: organizationId
            ) else {
                draftStore.remove(documentId: documentId, userId: userId, organizationId: organizationId)
                clearProtectedContent()
                saveState = .permissionDenied
                saveError = L10n.TabDoc.permissionMessage
                return false
            }
            guard detail.document.id == documentId else {
                rejectMismatchedDetailResponse(surfacesLoadError: false)
                return false
            }

            let remoteBody = NativeTabDocBody.parse(
                json: detail.content.descriptionJSON,
                markdownFallback: detail.content.descriptionMarkdown
            )
            let pendingSave = unacknowledgedSave
            let remoteMatchesAcknowledged =
                NativeTabDocConflictRebasePolicy.remoteMatchesCommittedSnapshot(
                    remoteTitle: detail.document.title,
                    remoteBody: remoteBody,
                    committedTitle: baseTitle,
                    committedBody: baseBody
                )
            let remoteMatchesPending = pendingSave.map { pending in
                NativeTabDocConflictRebasePolicy.remoteMatchesCommittedSnapshot(
                    remoteTitle: detail.document.title,
                    remoteBody: remoteBody,
                    committedTitle: pending.title,
                    committedBody: pending.body
                )
            } == true
            guard detail.document.canEdit,
                  NativeTabDocEditPolicy.allowsWholeDocumentEdit(remoteBody),
                  remoteMatchesAcknowledged || remoteMatchesPending
            else { return false }

            document = detail.document
            activeBaseVersion = detail.document.latestVersion
            activeBaseUpdatedAt = detail.document.updatedAt
            baseTitle = detail.document.title
            baseBody = remoteBody
            hasBaselineConflict = false
            saveError = nil
            unacknowledgedSave = nil
            if remoteMatchesPending,
               let pendingSave,
               !NativeTabDocSaveCommitPolicy.hasEditsAfterSnapshot(
                    currentTitle: normalizedTitle,
                    currentBody: body,
                    snapshot: pendingSave
               ) {
                title = detail.document.title
                body = remoteBody
                draftStore.remove(
                    documentId: documentId,
                    userId: userId,
                    organizationId: organizationId
                )
                localDraftForRecovery = nil
                saveState = .saved
                return true
            }
            saveState = .dirty
            // 明确禁止第二次等价重基，避免生产异常时形成自动重试循环。
            return await performSave(allowEquivalentConflictRebase: false)
        } catch {
            guard requireCurrentSession() else { return false }
            if NativeTabDocSaveFailurePolicy.mustPurgeLocalDraftAfterReadFailure(error) {
                draftStore.remove(documentId: documentId, userId: userId, organizationId: organizationId)
                clearProtectedContent()
                saveState = .permissionDenied
                saveError = L10n.TabDoc.permissionMessage
            }
            return false
        }
    }

    private func revalidateAfterWriteDenial() async {
        do {
            let detail = try await detailRequest(documentId)
            guard requireCurrentSession() else { return }
            guard NativeCloudOrganizationBoundary.matches(
                resourceOrganizationId: detail.document.organizationId,
                expectedOrganizationId: organizationId
            ) else {
                draftStore.remove(documentId: documentId, userId: userId, organizationId: organizationId)
                clearProtectedContent()
                saveState = .permissionDenied
                saveError = L10n.TabDoc.permissionMessage
                return
            }
            guard detail.document.id == documentId else {
                rejectMismatchedDetailResponse(surfacesLoadError: false)
                return
            }

            document = detail.document
            baseTitle = detail.document.title
            baseBody = NativeTabDocBody.parse(
                json: detail.content.descriptionJSON,
                markdownFallback: detail.content.descriptionMarkdown
            )
            hasBaselineConflict = true
            saveState = .conflict
            saveError = L10n.TabDoc.conflictMessage
        } catch {
            guard requireCurrentSession() else { return }
            if NativeTabDocSaveFailurePolicy.mustPurgeLocalDraftAfterReadFailure(error) {
                draftStore.remove(documentId: documentId, userId: userId, organizationId: organizationId)
                clearProtectedContent()
                saveError = L10n.TabDoc.permissionMessage
            } else {
                saveError = error.localizedDescription
            }
            saveState = .permissionDenied
        }
    }

    private var normalizedTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? L10n.CloudDocs.untitled : trimmed
    }

    private func markDirty() {
        saveError = nil
        saveState = hasBaselineConflict ? .conflict : .dirty
        persistDraft()
        if !hasBaselineConflict { scheduleAutosave() }
    }

    private func currentEditorSnapshot() -> NativeTabDocEditorSnapshot {
        NativeTabDocEditorSnapshot(title: title, body: body, focusedBlockId: nil)
    }

    private func refreshUndoAvailability() {
        canUndo = !undoStack.isEmpty || pendingUndoSnapshot != nil
        canRedo = !redoStack.isEmpty
    }

    private func resetUndoHistory() {
        textUndoTask?.cancel()
        textUndoTask = nil
        pendingUndoSnapshot = nil
        undoStack.removeAll()
        redoStack.removeAll()
        refreshUndoAvailability()
    }

    private func scheduleTextUndo() {
        pendingUndoSnapshot = NativeTabDocUndoPolicy.captureTextPending(
            current: currentEditorSnapshot(),
            pending: pendingUndoSnapshot
        )
        textUndoTask?.cancel()
        textUndoTask = Task { [weak self] in
            try? await Task.sleep(
                for: .milliseconds(NativeTabDocUndoPolicy.textDebounceMilliseconds)
            )
            guard !Task.isCancelled else { return }
            self?.flushPendingUndo()
        }
        refreshUndoAvailability()
    }

    private func flushPendingUndo() {
        guard let snapshot = pendingUndoSnapshot else { return }
        pendingUndoSnapshot = nil
        textUndoTask?.cancel()
        textUndoTask = nil
        NativeTabDocUndoPolicy.push(snapshot, undo: &undoStack, redo: &redoStack)
        refreshUndoAvailability()
    }

    private func pushUndo() {
        flushPendingUndo()
        NativeTabDocUndoPolicy.push(currentEditorSnapshot(), undo: &undoStack, redo: &redoStack)
        refreshUndoAvailability()
    }

    private func restoreEditorSnapshot(_ snapshot: NativeTabDocEditorSnapshot) {
        title = snapshot.title
        body = snapshot.body
        markDirty()
    }

    private func scheduleAutosave() {
        autosaveTask?.cancel()
        autosaveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.2))
            guard !Task.isCancelled else { return }
            // 解除引用后再保存，避免 save() 把正在执行的 autosave task 自己取消。
            self?.autosaveTask = nil
            _ = await self?.saveSingleFlight()
        }
    }

    private func cancelPendingAutosave() {
        autosaveTask?.cancel()
        autosaveTask = nil
    }

    private func clearProtectedContent() {
        cancelPendingAutosave()
        localDraftForRecovery = nil
        unacknowledgedSave = nil
        document = nil
        title = ""
        body = NativeTabDocBody(rootAttributes: ["type": AnyCodable("doc")], blocks: [])
        baseTitle = ""
        baseBody = body
        activeBaseVersion = nil
        activeBaseUpdatedAt = nil
        hasBaselineConflict = false
        NativeTabDocInlineImageStore.shared.reset()
        resetUndoHistory()
    }

    private func rejectMismatchedDetailResponse(surfacesLoadError: Bool) {
        if let draft = draftStore.load(
            documentId: documentId,
            userId: userId,
            organizationId: organizationId
        ) {
            localDraftForRecovery = draft
            title = draft.title
            body = draft.body
            activeBaseVersion = draft.baseVersion
            activeBaseUpdatedAt = draft.baseUpdatedAt
        }
        hasBaselineConflict = true
        saveState = .conflict
        saveError = L10n.TabDoc.conflictMessage
        if surfacesLoadError { loadError = L10n.TabDoc.conflictMessage }
    }

    private func persistDraft() {
        guard requireCurrentSession() else { return }
        guard isDirty else { return }
        do {
            let draft = NativeTabDocDraft(
                title: normalizedTitle,
                body: body,
                baseVersion: activeBaseVersion,
                baseUpdatedAt: activeBaseUpdatedAt
            )
            try draftStore.save(
                draft,
                documentId: documentId,
                userId: userId,
                organizationId: organizationId
            )
            localDraftForRecovery = draft
        } catch {
            logger.error("Native TabDoc draft persist failed id=\(self.documentId, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
        }
    }

    @discardableResult
    private func requireCurrentSession() -> Bool {
        guard sessionIsCurrent() else {
            loadSequence &+= 1
            draftStore.remove(documentId: documentId, userId: userId, organizationId: organizationId)
            clearProtectedContent()
            saveState = .permissionDenied
            return false
        }
        return true
    }

    private nonisolated static func saveBody(_ draft: NativeTabDocDraft) -> sending [String: Any] {
        [
            "write_intent": "replace",
            "base_version": draft.baseVersion ?? NSNull(),
            // 有单调版本号时它就是唯一 CAS 真源；时间戳只给没有版本号的旧数据兜底。
            // 同时发送两者会因数据库时间精度/序列化差异产生“当前版本 N、提交版本 N”伪冲突。
            "base_updated_at": draft.baseVersion == nil
                ? (draft.baseUpdatedAt.map { $0 as Any } ?? NSNull())
                : NSNull(),
            "title": draft.title,
            "content_pm_json": draft.body.serializedJSON.mapValues(\.value),
            "content_markdown": draft.body.markdown,
            "content_plaintext": draft.body.plaintext,
        ]
    }

    func updateDocumentCommentDraft(_ value: String) {
        documentCommentDraft = value
    }

    func updateBlockCommentDraft(_ value: String) {
        blockCommentDraft = value
    }

    func startBlockComment(blockId: UUID) {
        guard canCreateComment else { return }
        guard let block = body.blocks.first(where: { $0.id == blockId }) else { return }
        guard block.persistentBlockId?.isEmpty == false else {
            commentMessage = L10n.TabDoc.commentMissingAnchor
            return
        }
        commentComposerBlockId = blockId
        blockCommentDraft = ""
        commentMessage = nil
        isShowingBlockCommentComposer = true
    }

    func dismissBlockCommentComposer() {
        isShowingBlockCommentComposer = false
        commentComposerBlockId = nil
        blockCommentDraft = ""
    }

    func submitDocumentComment() async {
        await postComment(
            text: documentCommentDraft,
            scope: "document",
            runtimeBlockId: nil
        )
    }

    func submitBlockComment() async {
        await postComment(
            text: blockCommentDraft,
            scope: "block",
            runtimeBlockId: commentComposerBlockId
        )
    }

    /// 正文停留在页面上时，别的端新增的评论不会自己冒出来；回到前台补拉一次，
    /// 且不碰正文，避免覆盖本地未保存草稿。
    func refreshComments() async {
        guard requireCurrentSession(), !documentId.isEmpty else { return }
        await loadCommentThreads(sequence: loadSequence)
    }

    private func loadCommentThreads(sequence: Int) async {
        do {
            let response = try await commentThreadsListRequest(documentId)
            guard sequence == loadSequence else { return }
            commentThreads = response.threads
            refreshCommentPresentations()
            if commentMessage == L10n.TabDoc.commentLoadFailed {
                commentMessage = nil
            }
        } catch {
            guard sequence == loadSequence else { return }
            // 静默失败会让「拉取失败」和「真的没有评论」长得一模一样。
            commentMessage = L10n.TabDoc.commentLoadFailed
            logger.error("Native TabDoc comment load failed id=\(self.documentId, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
        }
    }

    private func refreshCommentPresentations() {
        commentPresentations = NativeTabDocCommentPresentationPolicy.present(
            threads: commentThreads,
            blocks: body.blocks,
            labels: NativeTabDocCommentPresentationLabels(
                documentTitle: L10n.TabDoc.commentDocument,
                blockTitle: L10n.TabDoc.commentBlock,
                orphanedTitle: L10n.TabDoc.commentOrphaned,
                anonymousAuthor: L10n.TabDoc.commentAnonymous
            )
        )
    }

    private func postComment(text: String, scope: String, runtimeBlockId: UUID?) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !documentId.isEmpty else { return }
        guard canCreateComment, !isPostingComment else { return }
        var blockIds: [String] = []
        var blockType: String?
        var selectedText: String?
        if scope == "block" {
            guard let runtimeBlockId,
                  let block = body.blocks.first(where: { $0.id == runtimeBlockId }),
                  let persistentId = block.persistentBlockId, !persistentId.isEmpty
            else { return }
            blockIds = [persistentId]
            blockType = NativeTabDocCommentWritePolicy.proseMirrorBlockType(for: block.kind)
            let excerpt = block.text.trimmingCharacters(in: .whitespacesAndNewlines)
            selectedText = excerpt.isEmpty ? nil : String(excerpt.prefix(500))
        }
        isPostingComment = true
        commentMessage = nil
        let sequence = loadSequence
        do {
            let created = try await commentThreadCreateRequest(
                documentId,
                NativeTabDocCommentWritePolicy.createRequestBody(
                    text: trimmed,
                    scope: scope,
                    blockIds: blockIds,
                    blockType: blockType,
                    selectedText: selectedText
                )
            )
            guard sequence == loadSequence else { return }
            commentThreads.append(created.thread)
            refreshCommentPresentations()
            if scope == "document" {
                documentCommentDraft = ""
            } else {
                dismissBlockCommentComposer()
            }
            isPostingComment = false
        } catch {
            guard sequence == loadSequence else { return }
            isPostingComment = false
            commentMessage = L10n.TabDoc.commentSendFailed
        }
    }
}

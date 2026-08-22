import PhotosUI
import SwiftUI
import UIKit

enum NativeTabDocBlockGapPolicy {
    static func gap(
        previous: NativeTabDocBlockKind?,
        current: NativeTabDocBlockKind
    ) -> CGFloat {
        guard let previous else { return TTSpacing.xxl }
        if previous.isDivider || current.isDivider { return TTSpacing.xxxl }
        if case .heading(let level) = current {
            return level <= 2 ? TTSpacing.xxl : TTSpacing.lg
        }
        if case .heading = previous { return TTSpacing.xs }
        if previous.usesSectionGap || current.usesSectionGap { return TTSpacing.md }
        return 0
    }
}

enum NativeTabDocSaveIndicatorPolicy {
    static func shows(_ state: NativeTabDocSaveState) -> Bool {
        switch state {
        case .dirty, .saving, .saved, .conflict, .permissionDenied, .failed: true
        case .idle: false
        }
    }

    static func showsRetry(_ state: NativeTabDocSaveState) -> Bool {
        state == .failed
    }
}

struct NativeTabDocMoreMenu: Equatable {
    let showShareLink: Bool
    let showDirectMessage: Bool
    let showVersionHistory: Bool
    let showFullEditor: Bool
    let showSave: Bool
}

enum NativeTabDocMoreMenuPolicy {
    static func moreMenu(
        canShareLink: Bool,
        canSendDirectMessage: Bool,
        canOpenFullEditor: Bool,
        canSave: Bool
    ) -> NativeTabDocMoreMenu {
        NativeTabDocMoreMenu(
            showShareLink: canShareLink,
            showDirectMessage: canSendDirectMessage,
            showVersionHistory: true,
            showFullEditor: canOpenFullEditor,
            showSave: canSave
        )
    }
}

enum NativeTabDocEditChromePolicy {
    static func showsInlineMenu(
        canEdit: Bool,
        isFocused: Bool,
        isSelected: Bool = false
    ) -> Bool {
        canEdit && (isFocused || isSelected)
    }
}

enum NativeTabDocListMarkerMetrics {
    static let visualColumn = TTSpacing.xxl

    /// Only actionable markers (task checkbox) claim this; bullets and numbers stay decorative.
    static let hitTarget = TTSpacing.Control.minimumTouchTarget
}

enum NativeTabDocTableBlockActionPolicy {
    static func allowsMutation(requiresWholeTablePreservation _: Bool) -> Bool {
        false
    }
}

enum NativeTabDocTableHeaderStatus: Equatable {
    case readOnlyPreview
    case projectedCells(Int)
}

enum NativeTabDocTableHeaderStatusPolicy {
    static func status(
        for table: NativeTabDocTable,
        canEdit: Bool
    ) -> NativeTabDocTableHeaderStatus? {
        if !canEdit || table.requiresWholeTablePreservation {
            return .readOnlyPreview
        }
        if table.hasProjectedCells {
            return .projectedCells(table.projectedCellCount)
        }
        return nil
    }
}

enum NativeTabDocComplexContentNoticePresentation: Equatable {
    case wholeDocumentReadOnly
    case partialReadOnly
    case projectedTableCells
}

enum NativeTabDocComplexContentNoticePolicy {
    static func presentation(
        for body: NativeTabDocBody,
        canEdit: Bool
    ) -> NativeTabDocComplexContentNoticePresentation? {
        guard body.hasUnsupportedBlocks || body.hasProjectedTableCells else { return nil }
        guard canEdit else { return .wholeDocumentReadOnly }
        if body.hasUnsupportedBlocks {
            return NativeTabDocEditPolicy.allowsWholeDocumentEdit(body)
                ? .partialReadOnly
                : .wholeDocumentReadOnly
        }
        return .projectedTableCells
    }
}

private extension NativeTabDocBlockKind {
    var isDivider: Bool {
        if case .divider = self { return true }
        return false
    }

    var usesSectionGap: Bool {
        switch self {
        case .blockquote, .codeBlock, .image, .table, .unsupported: true
        default: false
        }
    }

    var isList: Bool {
        switch self {
        case .bulletList, .orderedList, .taskList: true
        default: false
        }
    }
}

struct NativeTabDocEditorScreen: View {
    @Environment(\.scenePhase) private var scenePhase

    let documentId: String
    let organizationId: String
    let spaceId: String?
    let fallbackTitle: String
    let locationHint: String?

    @State private var session: NativeTabDocSession
    @State private var workspace = WorkspaceStore.shared
    @State private var showsFullEditor = false
    @State private var showsSendToDM = false
    @State private var showsShareLink = false
    @State private var showsFullEditorDraftWarning = false
    @State private var isRequestingFullEditor = false
    @State private var surfacedError: String?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isUploadingImage = false
    @State private var documentBodyHeight: CGFloat = 0
    @State private var commentsHeight: CGFloat = 0
    @State private var editorFocusRequest: NativeTabDocRichTextFocusRequest?

    init(
        documentId: String,
        organizationId: String,
        spaceId: String?,
        fallbackTitle: String,
        locationHint: String?,
        session: NativeTabDocSession? = nil
    ) {
        self.documentId = documentId
        self.organizationId = organizationId
        self.spaceId = spaceId
        self.fallbackTitle = fallbackTitle
        self.locationHint = locationHint
        _session = State(initialValue: session ?? NativeTabDocSession(
            documentId: documentId,
            organizationId: organizationId,
            fallbackTitle: fallbackTitle
        ))
    }

    var body: some View {
        Group {
            if session.isLoading && session.document == nil {
                loadingState
            } else if let error = session.loadError, session.document == nil {
                errorState(
                    error,
                    localDraft: session.canViewLocalDraftForRecovery
                        ? session.localDraftForRecovery
                        : nil
                )
            } else {
                editor
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .toolbar { toolbar }
        .task { await session.load() }
        .onDisappear {
            guard session.validateSession() else { return }
            Task { _ = await session.flush() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard session.validateSession() else { return }
            if phase == .active {
                Task { await session.refreshComments() }
                return
            }
            guard phase == .background else { return }
            Task { _ = await session.flush() }
        }
        .onChange(of: workspace.selectedOrganizationId) { _, _ in
            selectedPhoto = nil
            showsFullEditor = false
            showsSendToDM = false
            showsShareLink = false
            _ = session.validateSession()
        }
        .onChange(of: session.saveError) { _, error in
            if !isRequestingFullEditor { surfacedError = error }
        }
        .onChange(of: selectedPhoto) { _, item in
            guard let item, session.validateSession() else { return }
            Task { await insertSelectedPhoto(item) }
        }
        .alert(
            L10n.TabDoc.saveFailedTitle,
            isPresented: Binding(
                get: { surfacedError != nil },
                set: { if !$0 { surfacedError = nil } }
            )
        ) {
            if session.saveState == .conflict {
                Button(L10n.TabDoc.discardDraftAndReload, role: .destructive) {
                    surfacedError = nil
                    Task { await session.discardConflictingDraftAndReload() }
                }
            }
            Button(L10n.Common.confirm, role: .cancel) { surfacedError = nil }
        } message: {
            Text(surfacedError ?? "")
        }
        .sheet(isPresented: $showsFullEditor) {
            NavigationStack {
                AuthenticatedWorkbenchResourceWebScreen(
                    resource: .document(id: documentId),
                    organizationId: organizationId,
                    spaceId: spaceId,
                    title: session.document?.title ?? fallbackTitle,
                    locationHint: locationHint
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(L10n.Common.close) { showsFullEditor = false }
                    }
                }
            }
        }
        .sheet(isPresented: $showsSendToDM) {
            CloudResourceSendToDMSheet(target: directMessageTarget)
        }
        .sheet(isPresented: $showsShareLink) {
            CloudDocsShareSheet(
                type: .document,
                resourceId: documentId,
                resourceTitle: session.document?.title ?? fallbackTitle
            )
        }
        .sheet(
            isPresented: Binding(
                get: { session.isShowingVersionHistory },
                set: { if !$0 { session.dismissVersionHistory() } }
            )
        ) {
            NativeTabDocVersionHistorySheet(session: session)
        }
        .sheet(
            isPresented: Binding(
                get: { session.isShowingBlockCommentComposer },
                set: { if !$0 { session.dismissBlockCommentComposer() } }
            )
        ) {
            NativeTabDocBlockCommentSheet(
                draft: session.blockCommentDraft,
                isPosting: session.isPostingComment,
                message: session.commentMessage,
                onDraftChange: { session.updateBlockCommentDraft($0) },
                onSubmit: { Task { await session.submitBlockComment() } },
                onDismiss: { session.dismissBlockCommentComposer() }
            )
        }
        .alert(
            L10n.TabDoc.versionHistory,
            isPresented: Binding(
                get: { session.versionHistoryMessage != nil && !session.isShowingVersionHistory },
                set: { if !$0 { session.clearVersionHistoryMessage() } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) { session.clearVersionHistoryMessage() }
        } message: {
            Text(session.versionHistoryMessage ?? "")
        }
        .onChange(of: showsFullEditor) { wasPresented, isPresented in
            guard wasPresented, !isPresented else { return }
            guard session.validateSession() else { return }
            Task { await session.load() }
        }
        .confirmationDialog(
            L10n.TabDoc.fullEditorDraftWarningTitle,
            isPresented: $showsFullEditorDraftWarning,
            titleVisibility: .visible
        ) {
            Button(L10n.TabDoc.fullEditorDiscardAndOpen, role: .destructive) {
                if session.discardDraftForFullEditor() { showsFullEditor = true }
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.TabDoc.fullEditorDraftWarningMessage)
        }
    }

    private var editor: some View {
        GeometryReader { proxy in
            let viewportWidth = max(proxy.size.width, 0)
            let contentWidth = NativeTabDocReadingWidthPolicy.contentWidth(
                viewportWidth: viewportWidth
            )
            let extraTop = NativeTabDocCommentDockPolicy.extraTop(
                viewportHeight: max(proxy.size.height - TTSpacing.md, 0),
                precedingHeight: documentBodyHeight + TTSpacing.xxl,
                footerContentHeight: commentsHeight
            )
            ScrollView {
                LazyVStack(alignment: .center, spacing: 0) {
                    VStack(alignment: .center, spacing: 0) {
                    documentHeader
                        .frame(width: contentWidth, alignment: .leading)

                    if session.saveState == .conflict {
                        conflictDraftNotice
                            .frame(width: contentWidth, alignment: .leading)
                    }

                    if let presentation = NativeTabDocComplexContentNoticePolicy.presentation(
                        for: session.body,
                        canEdit: session.canEdit
                    ) {
                        complexContentNotice(presentation)
                            .frame(width: contentWidth, alignment: .leading)
                    }

                    if session.body.blocks.isEmpty {
                        emptyBody
                            .frame(width: contentWidth, alignment: .leading)
                    } else {
                        ForEach(Array(session.body.blocks.enumerated()), id: \.element.id) { index, block in
                            let previousKind = index > 0 ? session.body.blocks[index - 1].kind : nil
                            NativeTabDocBlockView(
                                block: block,
                                isFirst: index == session.body.blocks.startIndex,
                                isLast: index == session.body.blocks.index(before: session.body.blocks.endIndex),
                                canEdit: session.canEdit,
                                imageURL: resolvedImageURL(for: block),
                                resolveImageURL: { image in
                                    await session.resolveImageSource(image)
                                },
                                resolveInlineImageURL: { descriptor in
                                    await session.resolveInlineImageSource(descriptor)
                                },
                                onChangeSpans: { session.updateBlockSpans(id: block.id, spans: $0) },
                                focusRequest: editorFocusRequest,
                                onBackspaceAtBlockStart: {
                                    requestEditorFocus(session.mergeBlockWithPrevious(id: block.id))
                                },
                                onChangeListItem: { itemId, spans in
                                    session.updateListItemSpans(blockId: block.id, itemId: itemId, spans: spans)
                                },
                                onBackspaceAtListItemStart: { itemId in
                                    requestEditorFocus(session.mergeListItemWithPrevious(
                                        blockId: block.id,
                                        itemId: itemId
                                    ))
                                },
                                onToggleTask: { session.toggleTask(blockId: block.id, itemId: $0) },
                                onAddListItem: { session.addListItem(blockId: block.id, afterItemId: $0) },
                                onIndentListItem: { session.indentListItem(blockId: block.id, itemId: $0) },
                                onOutdentListItem: { session.outdentListItem(blockId: block.id, itemId: $0) },
                                canIndentListItem: { session.canIndentListItem(blockId: block.id, itemId: $0) },
                                canOutdentListItem: { session.canOutdentListItem(blockId: block.id, itemId: $0) },
                                onDeleteListItem: { session.removeListItem(blockId: block.id, itemId: $0) },
                                onChangeTableCell: { cellId, spans in
                                    session.updateTableCellSpans(blockId: block.id, cellId: cellId, spans: spans)
                                },
                                onAddTableRow: {
                                    session.addTableRow(blockId: block.id, afterRowIndex: $0)
                                },
                                onAddTableColumn: {
                                    session.addTableColumn(blockId: block.id, afterColumnIndex: $0)
                                },
                                onInsertAfter: { session.insertBlock(after: block.id, kind: $0) },
                                onDuplicate: { session.duplicateBlock(id: block.id) },
                                onMoveUp: { session.moveBlock(id: block.id, by: -1) },
                                onMoveDown: { session.moveBlock(id: block.id, by: 1) },
                                onConvert: { session.convertBlock(id: block.id, to: $0) },
                                onDelete: { session.removeBlock(id: block.id) },
                                canAddComment: session.canCreateComment,
                                onAddComment: { session.startBlockComment(blockId: block.id) },
                                canUndo: session.canUndo,
                                canRedo: session.canRedo,
                                onUndo: { session.undo() },
                                onRedo: { session.redo() }
                            )
                            .frame(
                                width: NativeTabDocReadingWidthPolicy.blockWidth(
                                    viewportWidth: viewportWidth,
                                    kind: block.kind
                                ),
                                alignment: .leading
                            )
                            .padding(
                                .top,
                                NativeTabDocBlockGapPolicy.gap(
                                    previous: previousKind,
                                    current: block.kind
                                )
                            )
                        }
                    }
                    }
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.height
                    } action: { documentBodyHeight = $0 }

                    Color.clear.frame(height: extraTop)

                    NativeTabDocCommentsSection(
                        presentations: session.commentPresentations,
                        draft: session.documentCommentDraft,
                        canCreate: session.canCreateComment,
                        isPosting: session.isPostingComment,
                        message: session.commentMessage,
                        onDraftChange: { session.updateDocumentCommentDraft($0) },
                        onSubmit: { Task { await session.submitDocumentComment() } }
                    )
                    .frame(width: contentWidth, alignment: .leading)
                    .id("document-comments")
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.height
                    } action: { commentsHeight = $0 }
                }
                .padding(.top, TTSpacing.xxl)
                .padding(.bottom, TTSpacing.md)
                .frame(width: viewportWidth)
            }
        }
    }

    private var documentHeader: some View {
        TextField(
            L10n.TabDoc.titlePlaceholder,
            text: Binding(
                get: { session.title },
                set: { value in session.updateTitle(value) }
            ),
            axis: .vertical
        )
        .font(.tt.displaySemibold)
        .foregroundStyle(.tt.textPrimary)
        .disabled(!session.canEdit)
        .accessibilityLabel(L10n.TabDoc.titlePlaceholder)
    }

    private func requestEditorFocus(
        _ destination: NativeTabDocEditorFocusDestination?
    ) -> Bool {
        guard let destination else { return false }
        editorFocusRequest = NativeTabDocRichTextFocusRequest(destination: destination)
        return true
    }

    private var saveStateBadge: some View {
        Label(saveStateText, systemImage: saveStateIcon)
            .font(.tt.metaMedium)
            .foregroundStyle(saveStateColor)
            .labelStyle(.titleAndIcon)
            .contentTransition(.symbolEffect(.replace))
            .accessibilityLabel(saveStateText)
    }

    private var conflictDraftNotice: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            HStack(alignment: .top, spacing: TTSpacing.md) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.tt.iconFeature)
                    .foregroundStyle(.tt.iconWarning)
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    Text(L10n.TabDoc.saveConflict)
                        .font(.tt.bodyMedium)
                        .foregroundStyle(.tt.textPrimary)
                    Text(L10n.TabDoc.conflictMessage)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: TTSpacing.sm)
            }
            Button(L10n.TabDoc.discardDraftAndReload) {
                Task { await session.discardConflictingDraftAndReload() }
            }
            .font(.tt.bodyMedium)
            .foregroundStyle(.tt.textCritical)
        }
        .padding(TTSpacing.lg)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

    private func complexContentNotice(
        _ presentation: NativeTabDocComplexContentNoticePresentation
    ) -> some View {
        Button { requestFullEditor() } label: {
            HStack(alignment: .top, spacing: TTSpacing.md) {
                Image(systemName: complexContentNoticeIcon(for: presentation))
                    .font(.tt.iconFeature)
                    .foregroundStyle(.tt.iconAccent)
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    Text(complexContentNoticeTitle(for: presentation))
                        .font(.tt.bodyMedium)
                        .foregroundStyle(.tt.textPrimary)
                    Text(complexContentNoticeMessage(for: presentation))
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: TTSpacing.sm)
                Image(systemName: "arrow.up.right")
                    .font(.tt.iconBodyMedium)
                    .foregroundStyle(.tt.iconAccent)
            }
            .padding(TTSpacing.lg)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        }
        .buttonStyle(.plain)
        .accessibilityHint(L10n.TabDoc.openFullEditor)
    }

    private func complexContentNoticeIcon(
        for presentation: NativeTabDocComplexContentNoticePresentation
    ) -> String {
        presentation == .projectedTableCells ? "tablecells" : "square.stack.3d.up"
    }

    private func complexContentNoticeTitle(
        for presentation: NativeTabDocComplexContentNoticePresentation
    ) -> String {
        switch presentation {
        case .wholeDocumentReadOnly: L10n.TabDoc.complexContentTitle
        case .partialReadOnly: L10n.TabDoc.partialReadOnlyContentTitle
        case .projectedTableCells: L10n.TabDoc.complexTableContentTitle
        }
    }

    private func complexContentNoticeMessage(
        for presentation: NativeTabDocComplexContentNoticePresentation
    ) -> String {
        switch presentation {
        case .wholeDocumentReadOnly: L10n.TabDoc.complexContentMessage
        case .partialReadOnly: L10n.TabDoc.partialReadOnlyContentMessage
        case .projectedTableCells: L10n.TabDoc.complexTableContentMessage
        }
    }

    private var emptyBody: some View {
        Button {
            session.insertBlock(after: nil, kind: .paragraph)
        } label: {
            VStack(spacing: TTSpacing.md) {
                Image(systemName: "text.badge.plus")
                    .font(.tt.iconEmptyMD)
                    .foregroundStyle(.tt.iconAccent)
                Text(session.canEdit ? L10n.TabDoc.emptyEditable : L10n.TabDoc.emptyReadOnly)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TTSpacing.huge)
        }
        .buttonStyle(.plain)
        .disabled(!session.canEdit)
    }

    @ViewBuilder
    private func insertionButtons(after blockId: UUID?) -> some View {
        Button { session.insertBlock(after: blockId, kind: .paragraph) } label: {
            Label(L10n.TabDoc.blockParagraph, systemImage: "text.alignleft")
        }
        Button { session.insertBlock(after: blockId, kind: .heading(level: 1)) } label: {
            Label(L10n.TabDoc.blockHeading, systemImage: "textformat.size.larger")
        }
        Button { session.insertBlock(after: blockId, kind: .bulletList) } label: {
            Label(L10n.TabDoc.blockBullet, systemImage: "list.bullet")
        }
        Button { session.insertBlock(after: blockId, kind: .orderedList(start: 1)) } label: {
            Label(L10n.TabDoc.blockOrdered, systemImage: "list.number")
        }
        Button { session.insertBlock(after: blockId, kind: .taskList) } label: {
            Label(L10n.TabDoc.blockTask, systemImage: "checklist")
        }
        Button { session.insertBlock(after: blockId, kind: .blockquote) } label: {
            Label(L10n.TabDoc.blockQuote, systemImage: "quote.opening")
        }
        Button { session.insertBlock(after: blockId, kind: .codeBlock) } label: {
            Label(L10n.TabDoc.blockCode, systemImage: "chevron.left.forwardslash.chevron.right")
        }
        Button { session.insertBlock(after: blockId, kind: .divider) } label: {
            Label(L10n.TabDoc.blockDivider, systemImage: "minus")
        }
        PhotosPicker(selection: $selectedPhoto, matching: .images) {
            Label(L10n.TabDoc.blockImage, systemImage: "photo")
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if NativeTabDocSaveIndicatorPolicy.shows(session.saveState) {
            ToolbarItem(placement: .topBarTrailing) {
                if NativeTabDocSaveIndicatorPolicy.showsRetry(session.saveState) {
                    Button {
                        Task { _ = await session.save() }
                    } label: {
                        saveStateBadge
                    }
                    .accessibilityHint(L10n.Common.retry)
                } else {
                    saveStateBadge
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if session.canEdit {
                    Menu {
                        insertionButtons(after: session.body.blocks.last?.id)
                    } label: {
                        Label(L10n.TabDoc.addBlock, systemImage: "plus")
                    }
                    .disabled(isUploadingImage)
                    Divider()
                }
                if editorMoreMenu.showShareLink {
                    Button { showsShareLink = true } label: {
                        Label(L10n.CloudDocs.shareAction, systemImage: "link")
                    }
                }
                if editorMoreMenu.showDirectMessage {
                    Button { showsSendToDM = true } label: {
                        Label(L10n.CloudDocs.directMessageAction, systemImage: "paperplane")
                    }
                }
                if editorMoreMenu.showVersionHistory {
                    Button {
                        Task { await session.showVersionHistory() }
                    } label: {
                        Label(L10n.TabDoc.versionHistory, systemImage: "clock.arrow.circlepath")
                    }
                }
                if editorMoreMenu.showFullEditor {
                    Button { requestFullEditor() } label: {
                        Label(L10n.TabDoc.openFullEditor, systemImage: "safari")
                    }
                }
                if editorMoreMenu.showSave {
                    Button { Task { _ = await session.save() } } label: {
                        Label(L10n.TabDoc.saveNow, systemImage: "checkmark.circle")
                    }
                    .disabled(!session.isDirty || session.saveState == .conflict)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.tt.iconSubtitle)
                    .foregroundStyle(.tt.iconAccent)
            }
            .accessibilityLabel(L10n.Common.more)
        }
    }

    private var editorMoreMenu: NativeTabDocMoreMenu {
        NativeTabDocMoreMenuPolicy.moreMenu(
            canShareLink: !documentId.isEmpty
                && session.saveState != .permissionDenied
                && !session.canViewLocalDraftForRecovery,
            canSendDirectMessage: true,
            canOpenFullEditor: true,
            canSave: session.canEdit
        )
    }

    private var directMessageTarget: CloudResourceDMSendTarget {
        CloudResourceDMSendTarget(
            resourceType: .document,
            resourceId: documentId,
            title: session.document?.title ?? fallbackTitle,
            organizationId: session.document?.organizationId ?? organizationId,
            spaceId: session.document?.spaceId ?? spaceId,
            currentUserRole: session.document?.currentUserRole
        )
    }

    private func requestFullEditor() {
        guard session.validateSession() else { return }
        switch NativeTabDocFullEditorPolicy.preparation(
            isDirty: session.isDirty,
            saveState: session.saveState
        ) {
        case .open:
            showsFullEditor = true
        case .confirmDiscard:
            showsFullEditorDraftWarning = true
        case .saveFirst:
            Task {
                isRequestingFullEditor = true
                let flushSucceeded = await session.flush()
                isRequestingFullEditor = false
                guard session.validateSession() else { return }
                if flushSucceeded {
                    showsFullEditor = true
                } else if session.saveState == .conflict {
                    showsFullEditorDraftWarning = true
                } else {
                    surfacedError = session.saveError ?? L10n.TabDoc.fullEditorSaveRequired
                }
            }
        }
    }

    private func resolvedImageURL(for block: NativeTabDocBlock) -> URL? {
        guard let image = block.image, image.fileId == nil else { return nil }
        return URL(string: image.source)
    }

    @MainActor
    private func insertSelectedPhoto(_ item: PhotosPickerItem) async {
        guard session.validateSession() else { return }
        isUploadingImage = true
        defer {
            isUploadingImage = false
            selectedPhoto = nil
        }
        do {
            guard let sourceData = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: sourceData),
                  let uploadData = Self.mobileJPEGData(image)
            else {
                throw APIError.apiError(L10n.TabDoc.imageLoadFailed)
            }
            let fileName = "tabdoc-\(UUID().uuidString.lowercased()).jpg"
            let upload = try await OSSUploadService.shared.directUpload(
                data: uploadData,
                fileName: fileName,
                contentType: "image/jpeg",
                folder: "tabdoc/images",
                scope: UploadScope(
                    module: "tabdoc",
                    contextType: "document",
                    contextId: documentId,
                    organizationId: organizationId,
                    isPublic: false
                )
            )
            guard session.validateSession() else { return }
            session.insertBlock(
                .uploadedImageParagraph(
                    source: "",
                    fileId: upload.fileId,
                    alt: L10n.TabDoc.imageDefaultAlt
                ),
                after: session.body.blocks.last?.id
            )
        } catch {
            guard session.validateSession() else { return }
            surfacedError = OSSBusinessError.userMessage(for: error)
        }
    }

    private nonisolated static func mobileJPEGData(_ source: UIImage) -> Data? {
        let maxDimension: CGFloat = 2_048
        let largest = max(source.size.width, source.size.height)
        let target: UIImage
        if largest > maxDimension {
            let scale = maxDimension / largest
            let size = CGSize(width: source.size.width * scale, height: source.size.height * scale)
            target = UIGraphicsImageRenderer(size: size).image { _ in
                source.draw(in: CGRect(origin: .zero, size: size))
            }
        } else {
            target = source
        }
        return target.jpegData(compressionQuality: 0.82)
    }

    private var loadingState: some View {
        VStack(spacing: TTSpacing.lg) {
            ProgressView().tint(.tt.iconAccent)
            Text(L10n.TabDoc.loading)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String, localDraft: NativeTabDocDraft?) -> some View {
        ScrollView {
            VStack(spacing: TTSpacing.lg) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.tt.iconEmptyLG)
                    .foregroundStyle(.tt.textTertiary)
                Text(message)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                    .multilineTextAlignment(.center)
                Button(L10n.Common.retry) { Task { await session.load() } }
                    .buttonStyle(.borderedProminent)

                if let localDraft {
                    NativeTabDocLocalDraftRecoveryView(draft: localDraft)
                }
            }
            .padding(TTSpacing.xxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var saveStateText: String {
        switch session.saveState {
        case .idle: L10n.TabDoc.saveIdle
        case .dirty: L10n.TabDoc.saveDirty
        case .saving: L10n.TabDoc.saving
        case .saved: L10n.TabDoc.saved
        case .conflict: L10n.TabDoc.saveConflict
        case .permissionDenied: L10n.TabDoc.readOnly
        case .failed: L10n.TabDoc.saveFailed
        }
    }

    private var saveStateIcon: String {
        switch session.saveState {
        case .idle, .dirty: "circle"
        case .saving: "arrow.triangle.2.circlepath"
        case .saved: "checkmark.circle.fill"
        case .conflict: "arrow.triangle.branch"
        case .permissionDenied: "lock.fill"
        case .failed: "exclamationmark.circle.fill"
        }
    }

    private var saveStateColor: Color {
        switch session.saveState {
        case .idle: .tt.textTertiary
        case .dirty: .tt.textWarning
        case .saving: .tt.textAccent
        case .saved: .tt.textSuccess
        case .conflict, .permissionDenied, .failed: .tt.textCritical
        }
    }
}

private struct NativeTabDocLocalDraftRecoveryView: View {
    let draft: NativeTabDocDraft
    @State private var didCopy = false

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Label(L10n.TabDoc.localDraftTitle, systemImage: "doc.badge.clock")
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(L10n.TabDoc.localDraftMessage)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
            if !draft.title.isEmpty {
                Text(draft.title)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textPrimary)
            }
            Text(draft.body.plaintext.isEmpty ? L10n.TabDoc.localDraftEmpty : draft.body.plaintext)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                UIPasteboard.general.string = [draft.title, draft.body.plaintext]
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n\n")
                didCopy = true
            } label: {
                Label(
                    didCopy ? L10n.TabDoc.localDraftCopied : L10n.TabDoc.localDraftCopy,
                    systemImage: didCopy ? "checkmark" : "doc.on.doc"
                )
                .font(.tt.bodyMedium)
                .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget)
            }
            .buttonStyle(.bordered)
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }
}

/// 把嵌套列表先压成行，再单层 ForEach 画出来。
/// SwiftUI 计算属性不能直接递归返回 `some View`，压平后顺序也与文档 DFS 一致。
private struct ListRenderRow: Identifiable {
    let id: UUID
    let item: NativeTabDocListItem
    let depth: Int
    let kind: NativeTabDocBlockKind
    let ordinal: Int

    static func flattening(
        items: [NativeTabDocListItem],
        kind: NativeTabDocBlockKind,
        depth: Int = 0
    ) -> [Self] {
        items.enumerated().flatMap { ordinal, item in
            let row = ListRenderRow(
                id: item.id,
                item: item,
                depth: depth,
                kind: kind,
                ordinal: ordinal
            )
            guard let nested = item.nested, !nested.items.isEmpty else { return [row] }
            return [row] + flattening(
                items: nested.items,
                kind: nested.kind,
                depth: depth + 1
            )
        }
    }
}

private enum NativeTabDocListRenderMetrics {
    /// 与 Android 列表缩进同令牌；作用在整行，避免符号和上层错位。
    static let indentPerDepth = TTSpacing.xxl

    static func leadingInset(depth: Int) -> CGFloat {
        CGFloat(max(depth, 0)) * indentPerDepth
    }

    /// 按视觉深度轮换，避免多层无序都是同一个点、看不出层级。
    static func bulletMarker(depth: Int) -> String {
        switch depth % 3 {
        case 0: "•"
        case 1: "◦"
        default: "▪"
        }
    }
}

private struct NativeTabDocBlockView: View {
    let block: NativeTabDocBlock
    let isFirst: Bool
    let isLast: Bool
    let canEdit: Bool
    let imageURL: URL?
    let resolveImageURL: (NativeTabDocImage) async -> URL?
    let resolveInlineImageURL: (NativeTabDocInlineImagePresentation.Descriptor) async -> URL?
    let onChangeSpans: ([NativeTabDocInlineSpan]) -> Void
    let focusRequest: NativeTabDocRichTextFocusRequest?
    let onBackspaceAtBlockStart: () -> Bool
    let onChangeListItem: (UUID, [NativeTabDocInlineSpan]) -> Void
    let onBackspaceAtListItemStart: (UUID) -> Bool
    let onToggleTask: (UUID) -> Void
    let onAddListItem: (UUID?) -> Void
    let onIndentListItem: (UUID) -> Void
    let onOutdentListItem: (UUID) -> Void
    let canIndentListItem: (UUID) -> Bool
    let canOutdentListItem: (UUID) -> Bool
    let onDeleteListItem: (UUID) -> Void
    let onChangeTableCell: (UUID, [NativeTabDocInlineSpan]) -> Void
    let onAddTableRow: (Int?) -> Void
    let onAddTableColumn: (Int?) -> Void
    let onInsertAfter: (NativeTabDocBlockKind) -> Void
    let onDuplicate: () -> Void
    let onMoveUp: () -> Void
    let onMoveDown: () -> Void
    let onConvert: (NativeTabDocBlockKind) -> Void
    let onDelete: () -> Void
    var canAddComment: Bool = false
    var onAddComment: () -> Void = {}
    var canUndo: Bool = false
    var canRedo: Bool = false
    var onUndo: (() -> Void)? = nil
    var onRedo: (() -> Void)? = nil

    @State private var inspectedTableCell: NativeTabDocTableCellInspection?
    @State private var tableViewportWidth: CGFloat = 0
    @State private var focusedEditorIDs: Set<UUID> = []

    var body: some View {
        switch block.kind {
        case .divider:
            Divider()
                .contextMenu {
                    if canEdit { blockMenuItems() }
                }
        case .unsupported(let type):
            if NativeTabDocFormulaRenderer.isMathematicsBlock(type) {
                NativeTabDocFormulaBlockView(
                    latex: NativeTabDocFormulaRenderer.blockLatex(in: block.rawNode)
                )
                .contextMenu {
                    if canEdit { blockMenuItems() }
                }
            } else {
                unsupportedBlock(type: type)
            }
        case .bulletList, .orderedList, .taskList:
            listBlock
        case .image:
            imageBlock
        case .table:
            tableBlock
        case .paragraph, .heading, .blockquote, .codeBlock:
            inlineBlock
        }
    }

    private var inlineBlock: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            blockAccent
            NativeTabDocRichTextView(
                spans: block.spans,
                isEditable: canEdit,
                style: richTextStyle,
                textAlignment: block.textAlignment,
                placeholder: L10n.TabDoc.blockPlaceholder,
                onChange: onChangeSpans,
                onFocusChange: { updateEditorFocus(block.id, isFocused: $0) },
                focusRequest: focusRequest?.editorId == block.id ? focusRequest : nil,
                onBackspaceAtStart: onBackspaceAtBlockStart,
                inlineImageResolver: resolveInlineImageURL,
                canUndo: canUndo,
                canRedo: canRedo,
                onUndo: onUndo,
                onRedo: onRedo
            )
        }
        .padding(.vertical, block.kind == .codeBlock ? TTSpacing.sm : 0)
        .padding(.horizontal, block.kind == .codeBlock ? TTSpacing.md : 0)
        .background {
            if block.kind == .codeBlock {
                RoundedRectangle(cornerRadius: TTRadius.md).fill(.tt.bgSubtle)
            }
        }
        .overlay(alignment: .topTrailing) {
            if NativeTabDocEditChromePolicy.showsInlineMenu(
                canEdit: canEdit,
                isFocused: focusedEditorIDs.contains(block.id)
            ) {
                blockMenu()
            }
        }
    }

    @ViewBuilder
    private var blockAccent: some View {
        if case .blockquote = block.kind {
            RoundedRectangle(cornerRadius: TTRadius.full)
                .fill(.tt.borderLight)
                .frame(width: TTSpacing.xxs)
                .padding(.vertical, TTSpacing.xs)
        }
    }

    private var richTextStyle: NativeTabDocRichTextStyle {
        switch block.kind {
        case .heading(let level): NativeTabDocHeadingStylePolicy.style(for: level)
        case .blockquote: .bodySecondary
        case .codeBlock: .code
        default: .body
        }
    }

    private var listRenderRows: [ListRenderRow] {
        ListRenderRow.flattening(items: block.listItems, kind: block.kind)
    }

    private var listBlock: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(listRenderRows) { row in
                HStack(alignment: listRowAlignment(for: row.kind), spacing: TTSpacing.xs) {
                    listPrefix(row: row)
                    NativeTabDocRichTextView(
                        spans: row.item.spans,
                        isEditable: canEdit,
                        style: .body,
                        textAlignment: row.item.textAlignment,
                        placeholder: L10n.TabDoc.listItemPlaceholder,
                        onChange: { onChangeListItem(row.item.id, $0) },
                        onFocusChange: { updateEditorFocus(row.item.id, isFocused: $0) },
                        focusRequest: focusRequest?.editorId == row.item.id ? focusRequest : nil,
                        onBackspaceAtStart: { onBackspaceAtListItemStart(row.item.id) },
                        inlineImageResolver: resolveInlineImageURL,
                        canUndo: canUndo,
                        canRedo: canRedo,
                        onUndo: onUndo,
                        onRedo: onRedo
                    )
                }
                .padding(.leading, NativeTabDocListRenderMetrics.leadingInset(depth: row.depth))
                .overlay(alignment: .topTrailing) {
                    if NativeTabDocEditChromePolicy.showsInlineMenu(
                        canEdit: canEdit,
                        isFocused: focusedEditorIDs.contains(row.item.id)
                    ) {
                        blockMenu(focusedListItemId: row.item.id)
                    }
                }
            }
        }
    }

    private func listRowAlignment(for kind: NativeTabDocBlockKind) -> VerticalAlignment {
        if case .taskList = kind { return .top }
        return .firstTextBaseline
    }

    @ViewBuilder
    private func listPrefix(row: ListRenderRow) -> some View {
        // 前缀必须看该项所属那一层的 kind，不能用顶层 block.kind。
        switch row.kind {
        case .taskList:
            Button { onToggleTask(row.item.id) } label: {
                Image(systemName: row.item.isChecked ? "checkmark.square.fill" : "square")
                    .font(.tt.iconSubtitle)
                    .foregroundStyle(row.item.isChecked ? .tt.iconAccent : .tt.textTertiary)
                    .frame(
                        width: NativeTabDocListMarkerMetrics.hitTarget,
                        height: NativeTabDocListMarkerMetrics.hitTarget
                    )
                    .contentShape(Rectangle())
            }
            .frame(width: NativeTabDocListMarkerMetrics.visualColumn)
            .buttonStyle(.plain)
            .disabled(!canEdit)
            .accessibilityLabel(row.item.isChecked ? L10n.TabDoc.taskChecked : L10n.TabDoc.taskUnchecked)
        case .orderedList(let start):
            Text("\(start + row.ordinal).")
                .font(.tt.bodyMedium)
                .foregroundStyle(.tt.textSecondary)
                .frame(width: NativeTabDocListMarkerMetrics.visualColumn, alignment: .trailing)
        default:
            Text(NativeTabDocListRenderMetrics.bulletMarker(depth: row.depth))
                .font(.tt.subtitleMedium)
                .foregroundStyle(.tt.textSecondary)
                .frame(width: NativeTabDocListMarkerMetrics.visualColumn, alignment: .trailing)
        }
    }

    private var imageBlock: some View {
        NativeTabDocImageBlockView(
            image: block.image,
            initialURL: imageURL,
            resolveURL: {
                guard let image = block.image else { return nil }
                return await resolveImageURL(image)
            }
        )
        .contextMenu {
            if canEdit { blockMenuItems() }
        }
    }

    private func updateEditorFocus(_ id: UUID, isFocused: Bool) {
        if isFocused {
            focusedEditorIDs.insert(id)
        } else {
            focusedEditorIDs.remove(id)
        }
    }

    @ViewBuilder
    private var tableBlock: some View {
        if let table = block.table {
            let locksWholeTable = !NativeTabDocTableBlockActionPolicy.allowsMutation(
                requiresWholeTablePreservation: table.requiresWholeTablePreservation
            )
            let columnWidth = NativeTabDocTableColumnWidthPolicy.columnWidth(
                viewportWidth: tableViewportWidth,
                columnCount: table.columnCount
            )
            let contentWidth = NativeTabDocTableColumnWidthPolicy.contentWidth(
                viewportWidth: tableViewportWidth,
                columnCount: table.columnCount
            )
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                tableHeader(table)
                    .padding(.horizontal, TTSpacing.lg)

                ScrollView(.horizontal) {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(alignment: .top, spacing: 0) {
                            tableCoordinateCell(
                                "",
                                width: NativeTabDocTableColumnWidthPolicy.rowHeaderWidth,
                                height: NativeTabDocTableColumnWidthPolicy.coordinateHeaderHeight
                            )
                            ForEach(0..<table.columnCount, id: \.self) { columnIndex in
                                tableCoordinateCell(
                                    tableColumnLabel(columnIndex),
                                    width: columnWidth,
                                    height: NativeTabDocTableColumnWidthPolicy.coordinateHeaderHeight
                                )
                            }
                        }
                        ForEach(Array(table.rows.enumerated()), id: \.element.id) { rowIndex, row in
                            NativeTabDocEqualHeightRowLayout {
                                tableCoordinateCell(
                                    "\(rowIndex + 1)",
                                    width: NativeTabDocTableColumnWidthPolicy.rowHeaderWidth,
                                    height: TTSpacing.Control.minimumTouchTarget
                                )
                                ForEach(Array(row.cells.enumerated()), id: \.element.id) { columnIndex, cell in
                                    tableCell(
                                        cell,
                                        isReadOnly: locksWholeTable || cell.isReadOnlyProjection == true,
                                        table: table,
                                        rowIndex: rowIndex,
                                        columnIndex: columnIndex,
                                        contentWidth: contentWidth
                                    )
                                }
                            }
                        }
                    }
                }
                .scrollIndicators(.visible)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.width
                } action: { tableViewportWidth = $0 }

            }
            .sheet(item: $inspectedTableCell) { inspection in
                NativeTabDocTableCellInspectionSheet(
                    inspection: inspection,
                    resolveImageURL: resolveImageURL,
                    resolveInlineImageURL: resolveInlineImageURL,
                    onChange: { onChangeTableCell(inspection.id, $0) },
                    onInsertRowBelow: {
                        onAddTableRow(inspection.row - 1)
                    },
                    onInsertColumnRight: {
                        onAddTableColumn(inspection.column - 1)
                    },
                    canUndo: canUndo,
                    canRedo: canRedo,
                    onUndo: onUndo,
                    onRedo: onRedo
                )
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private func tableHeader(_ table: NativeTabDocTable) -> some View {
        let localizedCopyText = NativeTabDocTableProjectionLocalization.tableText(table)
        let allowsTableMutation = canEdit
            && NativeTabDocTableBlockActionPolicy.allowsMutation(
                requiresWholeTablePreservation: table.requiresWholeTablePreservation
            )
        return VStack(alignment: .leading, spacing: TTSpacing.xs) {
            HStack(spacing: TTSpacing.sm) {
                Label(
                    L10n.TabDoc.tableSummary(
                        table.rows.count,
                        table.presentationColumnCount
                    ),
                    systemImage: "tablecells"
                )
                .font(.tt.metaMedium)
                .foregroundStyle(.tt.textSecondary)

                if let status = NativeTabDocTableHeaderStatusPolicy.status(
                    for: table,
                    canEdit: allowsTableMutation
                ) {
                    Text(tableHeaderStatusLabel(status))
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                        .padding(.horizontal, TTSpacing.sm)
                        .padding(.vertical, TTSpacing.xxs)
                        .background(.tt.bgSubtle, in: Capsule())
                }

                Spacer(minLength: TTSpacing.xs)

                if canEdit {
                    Menu {
                        Button {
                            UIPasteboard.general.string = localizedCopyText
                        } label: {
                            Label(L10n.TabDoc.copyTable, systemImage: "doc.on.doc")
                        }
                        if allowsTableMutation {
                            Divider()
                            Button { onAddTableRow(nil) } label: {
                                Label(L10n.TabDoc.addTableRow, systemImage: "rectangle.split.1x2")
                            }
                            .disabled(!table.canAddRow)
                            Button { onAddTableColumn(nil) } label: {
                                Label(L10n.TabDoc.addTableColumn, systemImage: "rectangle.split.2x1")
                            }
                            .disabled(!table.canAddColumn)
                        }
                        Divider()
                        blockMenuItems(includeCopy: false)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.tt.iconBody)
                            .foregroundStyle(.tt.iconAccent)
                            .frame(
                                minWidth: TTSpacing.Control.minimumTouchTarget,
                                minHeight: TTSpacing.Control.minimumTouchTarget
                            )
                    }
                    .accessibilityLabel(L10n.TabDoc.tableActions)
                } else {
                    copyTableButton(localizedCopyText)
                }
            }

            if NativeTabDocTableColumnWidthPolicy.requiresHorizontalScrolling(
                viewportWidth: tableViewportWidth,
                columnCount: table.columnCount
            ) {
                Label(L10n.TabDoc.tableSwipeHint, systemImage: "arrow.left.and.right")
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
    }

    private func tableHeaderStatusLabel(_ status: NativeTabDocTableHeaderStatus) -> String {
        switch status {
        case .readOnlyPreview:
            L10n.TabDoc.tableReadOnlyPreview
        case .projectedCells(let count):
            L10n.TabDoc.tableProjectedCellsReadOnly(count)
        }
    }

    private func copyTableButton(_ text: String) -> some View {
        Button {
            UIPasteboard.general.string = text
        } label: {
            Image(systemName: "doc.on.doc")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.iconAccent)
                .frame(
                    minWidth: TTSpacing.Control.minimumTouchTarget,
                    minHeight: TTSpacing.Control.minimumTouchTarget
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.TabDoc.copyTable)
    }

    private func tableCell(
        _ cell: NativeTabDocTableCell,
        isReadOnly: Bool,
        table: NativeTabDocTable,
        rowIndex: Int,
        columnIndex: Int,
        contentWidth: CGFloat
    ) -> some View {
        let allowsTableMutation = NativeTabDocTableBlockActionPolicy.allowsMutation(
            requiresWholeTablePreservation: table.requiresWholeTablePreservation
        )
        let isEditable = canEdit && allowsTableMutation && !isReadOnly
        let localizedText = NativeTabDocTableProjectionLocalization.cellText(cell)
        return Button {
            inspectedTableCell = NativeTabDocTableCellInspection(
                id: cell.id,
                row: rowIndex + 1,
                column: columnIndex + 1,
                spans: isEditable
                    ? cell.spans
                    : [NativeTabDocInlineSpan(text: localizedText)],
                textAlignment: cell.textAlignment,
                readOnlyContent: isEditable
                    ? nil
                    : NativeTabDocBody.parseTableCellContent(cell.rawCell),
                isHeader: cell.isHeader,
                rowValues: table.rows[rowIndex].cells.map(
                    NativeTabDocTableProjectionLocalization.cellText
                ),
                columnValues: table.rows.map { row in
                    columnIndex < row.cells.count
                        ? NativeTabDocTableProjectionLocalization.cellText(row.cells[columnIndex])
                        : ""
                },
                tableValues: table.rows.map { row in
                    row.cells.map(NativeTabDocTableProjectionLocalization.cellText)
                },
                isEditable: isEditable,
                canInsertRow: canEdit && allowsTableMutation && table.canAddRow,
                canInsertColumn: canEdit && allowsTableMutation && table.canAddColumn
            )
        } label: {
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                Group {
                    if localizedText.isEmpty {
                        Text(L10n.TabDoc.tableCellEmpty)
                            .font(cell.isHeader ? .tt.bodyMedium : .tt.body)
                            .foregroundStyle(.tt.textTertiary)
                    } else {
                        NativeTabDocReadOnlyAlignedText(
                            text: localizedText,
                            spans: cell.spans,
                            style: cell.isHeader ? .tableHeader : .body,
                            textAlignment: cell.textAlignment
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(TTSpacing.sm)
        .frame(
            width: contentWidth + (TTSpacing.sm * 2),
            alignment: .topLeading
        )
        .frame(
            minHeight: TTSpacing.Control.minimumTouchTarget,
            maxHeight: .infinity,
            alignment: .topLeading
        )
        .background(
            cell.isHeader || isReadOnly
                ? .tt.bgSubtle
                : .tt.bgCanvasDefault
        )
        .overlay { Rectangle().stroke(.tt.borderLight, lineWidth: 1) }
        .accessibilityLabel(
            L10n.TabDoc.tableCellPosition(rowIndex + 1, columnIndex + 1)
        )
        .accessibilityValue(localizedText)
        .accessibilityHint(
            isEditable ? L10n.TabDoc.tableCellEditHint : L10n.TabDoc.tableCellOpenHint
        )
    }

    private func tableCoordinateCell(
        _ text: String,
        width: CGFloat,
        height: CGFloat
    ) -> some View {
        Text(text)
            .font(.tt.captionMedium)
            .foregroundStyle(.tt.textTertiary)
            .frame(width: width, alignment: .center)
            .frame(minHeight: height, maxHeight: .infinity, alignment: .center)
            .background(.tt.bgSubtle)
            .overlay { Rectangle().stroke(.tt.borderLight, lineWidth: 1) }
            .accessibilityHidden(text.isEmpty)
    }

    private func tableColumnLabel(_ index: Int) -> String {
        UnicodeScalar(65 + index).map(String.init) ?? "\(index + 1)"
    }

    private func unsupportedBlock(type: String) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.md) {
            Image(systemName: "puzzlepiece.extension")
                .font(.tt.iconFeature)
                .foregroundStyle(.tt.textTertiary)
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                Text(L10n.TabDoc.unsupportedBlock)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textSecondary)
                if let label = unsupportedContentLabel(for: type) {
                    Text(label)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
                if let preview = block.readablePreview {
                    Text(preview)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(8)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(TTSpacing.lg)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

    private func unsupportedContentLabel(for rawType: String) -> String? {
        NativeTabDocUnsupportedContentPresentation.label(for: rawType)
    }

    private func blockMenu(focusedListItemId: UUID? = nil) -> some View {
        Menu {
            blockMenuItems(focusedListItemId: focusedListItemId)
        } label: {
            Image(systemName: "ellipsis")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.textTertiary)
                .frame(
                    minWidth: TTSpacing.Control.minimumTouchTarget,
                    minHeight: TTSpacing.Control.minimumTouchTarget
                )
                .background(.tt.bgCanvasDefault.opacity(0.92), in: Circle())
        }
        .accessibilityLabel(L10n.Common.more)
    }

    @ViewBuilder
    private func blockMenuItems(includeCopy: Bool = true, focusedListItemId: UUID? = nil) -> some View {
        if block.kind.isList {
            Button { onAddListItem(focusedListItemId) } label: {
                Label(L10n.TabDoc.addListItem, systemImage: "plus")
            }
            if let itemId = focusedListItemId {
                // 能不能缩进只问 Session，避免菜单自己再走一遍树去猜父子关系。
                Button { onIndentListItem(itemId) } label: {
                    Label(L10n.TabDoc.listItemIndent, systemImage: "increase.indent")
                }
                .disabled(!canIndentListItem(itemId))
                Button { onOutdentListItem(itemId) } label: {
                    Label(L10n.TabDoc.listItemOutdent, systemImage: "decrease.indent")
                }
                .disabled(!canOutdentListItem(itemId))
            }
            if !listRenderRows.isEmpty {
                Menu {
                    ForEach(listRenderRows) { row in
                        Button(role: .destructive) { onDeleteListItem(row.item.id) } label: {
                            Label(listItemMenuLabel(row: row), systemImage: "minus.circle")
                        }
                    }
                } label: {
                    Label(L10n.CloudDocs.actionDelete, systemImage: "list.bullet.indent")
                }
            }
            Divider()
        }
        Button { onInsertAfter(.paragraph) } label: {
            Label(L10n.TabDoc.addBelow, systemImage: "plus")
        }
        Button(action: onDuplicate) {
            Label(L10n.TabDoc.duplicateBlock, systemImage: "plus.square.on.square")
        }
        if includeCopy, let text = copyableText {
            Button { UIPasteboard.general.string = text } label: {
                Label(L10n.TabDoc.copyText, systemImage: "doc.on.doc")
            }
        }
        if !block.conversionOptions.isEmpty {
            Menu {
                ForEach(block.conversionOptions, id: \.self) { kind in
                    Button { onConvert(kind) } label: {
                        Label(kind.conversionLabel, systemImage: kind.conversionSystemImage)
                    }
                }
            } label: {
                Label(L10n.TabDoc.convertBlock, systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
            }
        }
        Divider()
        Button(action: onMoveUp) {
            Label(L10n.TabDoc.moveBlockUp, systemImage: "arrow.up")
        }
        .disabled(isFirst)
        Button(action: onMoveDown) {
            Label(L10n.TabDoc.moveBlockDown, systemImage: "arrow.down")
        }
        .disabled(isLast)
        if canAddComment {
            Divider()
            Button(action: onAddComment) {
                Label(L10n.TabDoc.commentAdd, systemImage: "text.bubble")
            }
        }
        Divider()
        Button(role: .destructive, action: onDelete) {
            Label(L10n.CloudDocs.actionDelete, systemImage: "trash")
        }
    }

    private func listItemMenuLabel(row: ListRenderRow) -> String {
        let text = row.item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // 没有「第 N 层」文案，用空白缩进让删除菜单还能分辨嵌套项。
        let indent = String(repeating: "  ", count: row.depth)
        let number = "\(row.ordinal + 1)"
        return text.isEmpty ? "\(indent)\(number)" : "\(indent)\(number). \(text)"
    }

    private var copyableText: String? {
        let value: String
        switch block.kind {
        case .paragraph, .heading, .blockquote, .codeBlock:
            value = block.text
        case .bulletList, .orderedList, .taskList:
            value = block.listItems
                .flatMap(\.descendantPlainTexts)
                .joined(separator: "\n")
        case .table:
            value = block.table.map(NativeTabDocTableProjectionLocalization.tableText) ?? ""
        case .image:
            value = block.image?.alt ?? ""
        case .divider, .unsupported:
            value = ""
        }
        return value.isEmpty ? nil : value
    }
}

extension NativeTabDocBlockKind {
    var conversionLabel: String {
        switch self {
        case .paragraph: L10n.TabDoc.blockParagraph
        case .heading(let level): L10n.TabDoc.headingLevel(level)
        case .bulletList: L10n.TabDoc.blockBullet
        case .orderedList: L10n.TabDoc.blockOrdered
        case .taskList: L10n.TabDoc.blockTask
        case .blockquote: L10n.TabDoc.blockQuote
        case .codeBlock: L10n.TabDoc.blockCode
        case .image: L10n.TabDoc.blockImage
        case .table: L10n.TabDoc.blockTable
        case .divider: L10n.TabDoc.blockDivider
        case .unsupported(let type):
            NativeTabDocUnsupportedContentPresentation.label(for: type)
                ?? L10n.TabDoc.unsupportedBlock
        }
    }

    var conversionSystemImage: String {
        switch self {
        case .paragraph: "text.alignleft"
        case .heading: "textformat.size.larger"
        case .bulletList: "list.bullet"
        case .orderedList: "list.number"
        case .taskList: "checklist"
        case .blockquote: "quote.opening"
        case .codeBlock: "chevron.left.forwardslash.chevron.right"
        case .image: "photo"
        case .table: "tablecells"
        case .divider: "minus"
        case .unsupported: "puzzlepiece.extension"
        }
    }
}

enum NativeTabDocReadingWidthPolicy {
    static let maximumContentWidth: CGFloat = 720

    static func contentWidth(
        viewportWidth: CGFloat,
        horizontalPadding: CGFloat = TTSpacing.lg
    ) -> CGFloat {
        min(max(viewportWidth - horizontalPadding * 2, 0), maximumContentWidth)
    }

    static func blockWidth(
        viewportWidth: CGFloat,
        kind: NativeTabDocBlockKind
    ) -> CGFloat {
        switch kind {
        case .table:
            max(viewportWidth, 0)
        default:
            contentWidth(viewportWidth: viewportWidth)
        }
    }
}

enum NativeTabDocTableProjectionLocalization {
    static func cellText(_ cell: NativeTabDocTableCell) -> String {
        cell.projection?.rendered(labelFor: label) ?? cell.text
    }

    static func tableText(_ table: NativeTabDocTable) -> String {
        table.rows
            .map { row in row.cells.map(cellText).joined(separator: "\t") }
            .joined(separator: "\n")
    }

    private static func label(
        _ kind: NativeTabDocTableContentSummaryKind
    ) -> String {
        switch kind {
        case .whiteboard: L10n.TabDoc.unsupportedWhiteboard
        case .embeddedTable: L10n.TabDoc.unsupportedEmbeddedTable
        case .embeddedHTML: L10n.TabDoc.unsupportedEmbeddedHTML
        case .video: L10n.TabDoc.unsupportedVideo
        case .complexContent: L10n.TabDoc.unsupportedBlock
        }
    }
}

enum NativeTabDocUnsupportedContentPresentation {
    struct Labels {
        let whiteboard: String
        let embeddedTable: String
        let embeddedHTML: String
        let video: String

        static var localized: Labels {
            Labels(
                whiteboard: L10n.TabDoc.unsupportedWhiteboard,
                embeddedTable: L10n.TabDoc.unsupportedEmbeddedTable,
                embeddedHTML: L10n.TabDoc.unsupportedEmbeddedHTML,
                video: L10n.TabDoc.unsupportedVideo
            )
        }
    }

    static func label(
        for rawType: String,
        labels: Labels = .localized
    ) -> String? {
        guard let kind = NativeTabDocUnsupportedContentKind(rawType: rawType) else { return nil }
        return switch kind {
        case .whiteboard: labels.whiteboard
        case .embeddedTable: labels.embeddedTable
        case .embeddedHTML: labels.embeddedHTML
        case .video: labels.video
        }
    }
}

enum NativeTabDocTableColumnWidthPolicy {
    static let minimumColumnWidth: CGFloat = 120
    static let rowHeaderWidth: CGFloat = 36
    static let coordinateHeaderHeight: CGFloat = 32

    /// 共享列宽：先扣行号栏，再均分剩余视口，且不低于 120。
    /// available = max(viewportWidth - rowHeaderWidth, 0)
    /// columnWidth = max(available / columnCount, 120)
    static func columnWidth(
        viewportWidth: CGFloat,
        columnCount: Int,
        reservedRowHeaderWidth: CGFloat = rowHeaderWidth
    ) -> CGFloat {
        guard columnCount > 0 else { return 0 }
        let available = max(viewportWidth - reservedRowHeaderWidth, 0)
        return max(available / CGFloat(columnCount), minimumColumnWidth)
    }

    static func contentWidth(
        viewportWidth: CGFloat,
        columnCount: Int,
        horizontalPadding: CGFloat = TTSpacing.sm,
        reservedRowHeaderWidth: CGFloat = rowHeaderWidth
    ) -> CGFloat {
        max(
            columnWidth(
                viewportWidth: viewportWidth,
                columnCount: columnCount,
                reservedRowHeaderWidth: reservedRowHeaderWidth
            ) - (horizontalPadding * 2),
            0
        )
    }

    static func requiresHorizontalScrolling(
        viewportWidth: CGFloat,
        columnCount: Int,
        reservedRowHeaderWidth: CGFloat = rowHeaderWidth
    ) -> Bool {
        guard viewportWidth > 0, columnCount > 0 else { return false }
        return reservedRowHeaderWidth + minimumColumnWidth * CGFloat(columnCount) > viewportWidth
    }
}

enum NativeTabDocTableRowHeightPolicy {
    static func sharedHeight(cellHeights: [CGFloat]) -> CGFloat {
        max(cellHeights.max() ?? 0, 0)
    }
}

private struct NativeTabDocEqualHeightRowLayout: Layout {
    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        return CGSize(
            width: sizes.reduce(0) { $0 + $1.width },
            height: NativeTabDocTableRowHeightPolicy.sharedHeight(
                cellHeights: sizes.map(\.height)
            )
        )
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var x = bounds.minX
        for subview in subviews {
            let naturalSize = subview.sizeThatFits(.unspecified)
            subview.place(
                at: CGPoint(x: x, y: bounds.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: naturalSize.width, height: bounds.height)
            )
            x += naturalSize.width
        }
    }
}

private enum NativeTabDocImageBlockMetrics {
    static let minimumHeight = (TTSpacing.huge * 3) + TTSpacing.sm
}

/// 表格卡片最多会同时展示 2,000 个格子，预览只需要轻量 UILabel；
/// 完整 UITextView 编辑器仅在单元格检查面板里按需创建。
private struct NativeTabDocReadOnlyAlignedText: UIViewRepresentable {
    let text: String
    var spans: [NativeTabDocInlineSpan] = []
    let style: NativeTabDocRichTextStyle
    let textAlignment: NativeTabDocTextAlignment

    func makeUIView(context: Context) -> UILabel {
        let label = UILabel()
        label.numberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        label.adjustsFontForContentSizeCategory = true
        label.isUserInteractionEnabled = false
        label.isAccessibilityElement = false
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return label
    }

    func updateUIView(_ label: UILabel, context: Context) {
        if NativeTabDocTableCellPreviewTypography.usesAttributedPreview(spans) {
            label.attributedText = NativeTabDocTableCellPreviewTypography.attributedString(
                spans: spans,
                style: style,
                textAlignment: textAlignment,
                traitCollection: label.traitCollection
            )
        } else {
            label.attributedText = nil
            label.text = text
            label.font = style.scaledFont()
            label.textColor = style.textColor
            label.textAlignment = textAlignment.uiTextAlignment
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UILabel,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width else { return nil }
        uiView.preferredMaxLayoutWidth = width
        let fitted = uiView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        return CGSize(width: width, height: fitted.height)
    }
}

private struct NativeTabDocTableCellInspection: Identifiable {
    let id: UUID
    let row: Int
    let column: Int
    let spans: [NativeTabDocInlineSpan]
    let textAlignment: NativeTabDocTextAlignment
    let readOnlyContent: NativeTabDocBody?
    let isHeader: Bool
    let rowValues: [String]
    let columnValues: [String]
    let tableValues: [[String]]
    let isEditable: Bool
    let canInsertRow: Bool
    let canInsertColumn: Bool

    var text: String { spans.nativeTabDocPlainText }
}

private struct NativeTabDocTableCellInspectionSheet: View {
    @Environment(\.dismiss) private var dismiss

    let inspection: NativeTabDocTableCellInspection
    let resolveImageURL: (NativeTabDocImage) async -> URL?
    let resolveInlineImageURL: (NativeTabDocInlineImagePresentation.Descriptor) async -> URL?
    let onChange: ([NativeTabDocInlineSpan]) -> Void
    let onInsertRowBelow: () -> Void
    let onInsertColumnRight: () -> Void
    var canUndo: Bool = false
    var canRedo: Bool = false
    var onUndo: (() -> Void)? = nil
    var onRedo: (() -> Void)? = nil

    @State private var editedSpans: [NativeTabDocInlineSpan]

    init(
        inspection: NativeTabDocTableCellInspection,
        resolveImageURL: @escaping (NativeTabDocImage) async -> URL?,
        resolveInlineImageURL: @escaping (NativeTabDocInlineImagePresentation.Descriptor) async -> URL?,
        onChange: @escaping ([NativeTabDocInlineSpan]) -> Void,
        onInsertRowBelow: @escaping () -> Void,
        onInsertColumnRight: @escaping () -> Void,
        canUndo: Bool = false,
        canRedo: Bool = false,
        onUndo: (() -> Void)? = nil,
        onRedo: (() -> Void)? = nil
    ) {
        self.inspection = inspection
        self.resolveImageURL = resolveImageURL
        self.resolveInlineImageURL = resolveInlineImageURL
        self.onChange = onChange
        self.onInsertRowBelow = onInsertRowBelow
        self.onInsertColumnRight = onInsertColumnRight
        self.canUndo = canUndo
        self.canRedo = canRedo
        self.onUndo = onUndo
        self.onRedo = onRedo
        _editedSpans = State(initialValue: inspection.spans)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: TTSpacing.md) {
                Group {
                    if inspection.isEditable {
                        Label(L10n.TabDoc.tableCellEditable, systemImage: "pencil")
                    } else {
                        Text(L10n.TabDoc.tableCellComplexReadOnly)
                    }
                }
                .font(.tt.metaMedium)
                .foregroundStyle(
                    inspection.isEditable ? .tt.textAccent : .tt.textSecondary
                )
                .padding(.horizontal, TTSpacing.sm)
                .padding(.vertical, TTSpacing.xs)
                .background(.tt.bgSubtle, in: Capsule())

                Group {
                    if inspection.isEditable {
                        NativeTabDocRichTextView(
                            spans: editedSpans,
                            isEditable: true,
                            style: inspection.isHeader ? .tableHeader : .body,
                            textAlignment: inspection.textAlignment,
                            placeholder: L10n.TabDoc.tableCellPlaceholder,
                            onChange: { newSpans in
                                editedSpans = newSpans
                                onChange(newSpans)
                            },
                            onFocusChange: { _ in },
                            inlineImageResolver: resolveInlineImageURL,
                            canUndo: canUndo,
                            canRedo: canRedo,
                            onUndo: onUndo,
                            onRedo: onRedo
                        )
                        .accessibilityLabel(
                            L10n.TabDoc.tableCellPosition(
                                inspection.row,
                                inspection.column
                            )
                        )
                    } else if let readOnlyContent = inspection.readOnlyContent {
                        ScrollView {
                            NativeTabDocReadOnlyBodyView(
                                document: readOnlyContent,
                                resolveImageURL: resolveImageURL,
                                resolveInlineImageURL: resolveInlineImageURL
                            )
                        }
                    } else {
                        ScrollView {
                            Text(
                                inspection.text.isEmpty
                                    ? L10n.TabDoc.tableCellEmpty
                                    : inspection.text
                            )
                            .font(.tt.body)
                            .foregroundStyle(
                                inspection.text.isEmpty
                                    ? .tt.textTertiary
                                    : .tt.textPrimary
                            )
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(TTSpacing.md)
                .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))

                LazyVGrid(
                    columns: [GridItem(.flexible()), GridItem(.flexible())],
                    spacing: TTSpacing.sm
                ) {
                    copyButton(
                        title: L10n.TabDoc.copyTableCell,
                        systemImage: "doc.on.doc",
                        text: currentText
                    )
                    copyButton(
                        title: L10n.TabDoc.copyTableRow,
                        systemImage: "rectangle.split.1x2",
                        text: currentRowText
                    )
                    copyButton(
                        title: L10n.TabDoc.copyTableColumn,
                        systemImage: "rectangle.split.2x1",
                        text: currentColumnText
                    )
                    copyButton(
                        title: L10n.TabDoc.copyTable,
                        systemImage: "tablecells",
                        text: currentTableText
                    )
                }

                if inspection.canInsertRow || inspection.canInsertColumn {
                    HStack(spacing: TTSpacing.sm) {
                        structureButton(
                            title: L10n.TabDoc.insertTableRowBelow,
                            systemImage: "rectangle.split.1x2",
                            isEnabled: inspection.canInsertRow
                        ) {
                            onInsertRowBelow()
                            dismiss()
                        }
                        structureButton(
                            title: L10n.TabDoc.insertTableColumnRight,
                            systemImage: "rectangle.split.2x1",
                            isEnabled: inspection.canInsertColumn
                        ) {
                            onInsertColumnRight()
                            dismiss()
                        }
                    }
                }
            }
            .padding(TTSpacing.lg)
            .background(.tt.bgCanvasDefault)
            .navigationTitle(L10n.TabDoc.tableCellPosition(inspection.row, inspection.column))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.close) { dismiss() }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var currentText: String {
        inspection.isEditable ? editedSpans.nativeTabDocPlainText : inspection.text
    }

    private var currentRowText: String {
        var values = inspection.rowValues
        let index = inspection.column - 1
        if inspection.isEditable, index >= 0, index < values.count {
            values[index] = currentText
        }
        return values.joined(separator: "\t")
    }

    private var currentColumnText: String {
        var values = inspection.columnValues
        let index = inspection.row - 1
        if inspection.isEditable, index >= 0, index < values.count {
            values[index] = currentText
        }
        return values.joined(separator: "\n")
    }

    private var currentTableText: String {
        var rows = inspection.tableValues
        let rowIndex = inspection.row - 1
        let columnIndex = inspection.column - 1
        if inspection.isEditable,
           rowIndex >= 0,
           rowIndex < rows.count,
           columnIndex >= 0,
           columnIndex < rows[rowIndex].count {
            rows[rowIndex][columnIndex] = currentText
        }
        return rows
            .map { $0.joined(separator: "\t") }
            .joined(separator: "\n")
    }

    private func copyButton(
        title: String,
        systemImage: String,
        text: String
    ) -> some View {
        Button {
            UIPasteboard.general.string = text
        } label: {
            VStack(spacing: TTSpacing.xxs) {
                Image(systemName: systemImage)
                    .font(.tt.iconBody)
                Text(title)
                    .font(.tt.captionMedium)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
                .frame(
                    maxWidth: .infinity,
                    minHeight: TTSpacing.Control.minimumTouchTarget
                )
        }
        .buttonStyle(.bordered)
        .disabled(text.isEmpty)
        .accessibilityLabel(title)
    }

    private func structureButton(
        title: String,
        systemImage: String,
        isEnabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.tt.captionMedium)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(
                    maxWidth: .infinity,
                    minHeight: TTSpacing.Control.minimumTouchTarget
                )
        }
        .buttonStyle(.bordered)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
    }
}

/// 复用原生云文档块渲染器展示单元格里的 block content。
/// 详情态全部只读，所有编辑/结构回调均为空，关闭面板不会触发文档保存。
private struct NativeTabDocReadOnlyBodyView: View {
    let document: NativeTabDocBody
    let resolveImageURL: (NativeTabDocImage) async -> URL?
    let resolveInlineImageURL: (NativeTabDocInlineImagePresentation.Descriptor) async -> URL?

    var body: some View {
        if document.blocks.isEmpty {
            Text(L10n.TabDoc.tableCellEmpty)
                .font(.tt.body)
                .foregroundStyle(.tt.textTertiary)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            LazyVStack(alignment: .leading, spacing: TTSpacing.md) {
                ForEach(Array(document.blocks.enumerated()), id: \.element.id) { index, block in
                    NativeTabDocBlockView(
                        block: block,
                        isFirst: index == document.blocks.startIndex,
                        isLast: index == document.blocks.index(before: document.blocks.endIndex),
                        canEdit: false,
                        imageURL: nil,
                        resolveImageURL: resolveImageURL,
                        resolveInlineImageURL: resolveInlineImageURL,
                        onChangeSpans: { _ in },
                        focusRequest: nil,
                        onBackspaceAtBlockStart: { false },
                        onChangeListItem: { _, _ in },
                        onBackspaceAtListItemStart: { _ in false },
                        onToggleTask: { _ in },
                        onAddListItem: { _ in },
                        onIndentListItem: { _ in },
                        onOutdentListItem: { _ in },
                        canIndentListItem: { _ in false },
                        canOutdentListItem: { _ in false },
                        onDeleteListItem: { _ in },
                        onChangeTableCell: { _, _ in },
                        onAddTableRow: { _ in },
                        onAddTableColumn: { _ in },
                        onInsertAfter: { _ in },
                        onDuplicate: {},
                        onMoveUp: {},
                        onMoveDown: {},
                        onConvert: { _ in },
                        onDelete: {}
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct NativeTabDocImageBlockView: View {
    let image: NativeTabDocImage?
    let initialURL: URL?
    let resolveURL: () async -> URL?

    @State private var resolvedURL: URL?
    @State private var isResolving = false
    @State private var didResolve = false

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Group {
                if let resolvedURL {
                    AsyncImage(url: resolvedURL) { phase in
                        switch phase {
                        case .empty:
                            imagePlaceholder(showsProgress: true)
                        case .success(let loaded):
                            loaded
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity)
                                .accessibilityLabel(image?.alt.isEmpty == false ? image?.alt ?? "" : L10n.TabDoc.imageDefaultAlt)
                        case .failure:
                            imageFailure
                        @unknown default:
                            imageFailure
                        }
                    }
                } else if isResolving || !didResolve {
                    imagePlaceholder(showsProgress: true)
                } else {
                    imageFailure
                }
            }
            .frame(maxWidth: .infinity, minHeight: NativeTabDocImageBlockMetrics.minimumHeight)
            .background(.tt.bgSubtle)
            .clipShape(RoundedRectangle(cornerRadius: TTRadius.md))

            if let alt = image?.alt, !alt.isEmpty {
                Text(alt)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
            }
        }
        .task(id: imageIdentity) {
            resolvedURL = initialURL
            guard resolvedURL == nil else {
                didResolve = true
                return
            }
            isResolving = true
            resolvedURL = await resolveURL()
            isResolving = false
            didResolve = true
        }
    }

    private var imageIdentity: String {
        "\(image?.fileId ?? "")|\(image?.source ?? "")"
    }

    private func imagePlaceholder(showsProgress: Bool) -> some View {
        VStack(spacing: TTSpacing.sm) {
            if showsProgress { ProgressView() }
            Image(systemName: "photo")
                .font(.tt.iconFeature)
                .foregroundStyle(.tt.textTertiary)
        }
        .frame(maxWidth: .infinity, minHeight: NativeTabDocImageBlockMetrics.minimumHeight)
    }

    private var imageFailure: some View {
        VStack(spacing: TTSpacing.sm) {
            Image(systemName: "photo.badge.exclamationmark")
                .font(.tt.iconFeature)
                .foregroundStyle(.tt.textTertiary)
            Text(L10n.TabDoc.imageLoadFailed)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: NativeTabDocImageBlockMetrics.minimumHeight)
    }
}

private struct NativeTabDocVersionHistorySheet: View {
    let session: NativeTabDocSession

    var body: some View {
        NavigationStack {
            Group {
                if session.isLoadingHistories && session.versionHistories.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if session.versionHistories.isEmpty {
                    Text(session.versionHistoryMessage ?? L10n.TabDoc.versionEmpty)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(TTSpacing.xl)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    VStack(spacing: 0) {
                        if let message = session.versionHistoryMessage, !message.isEmpty {
                            Text(message)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, TTSpacing.lg)
                                .padding(.vertical, TTSpacing.sm)
                        }
                        List(session.versionHistories, id: \.id) { entry in
                            HStack(alignment: .center, spacing: TTSpacing.md) {
                                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                                    Text(
                                        NativeTabDocVersionHistoryPresentation.entryTitle(
                                            id: entry.id,
                                            name: entry.name,
                                            createdAt: entry.createdAt,
                                            isSnapshot: entry.isSnapshot,
                                            snapshotLabel: L10n.TabDoc.versionSnapshot,
                                            historyVersionLabel: L10n.TabDoc.versionUnnamed
                                        )
                                    )
                                    .font(.tt.body)
                                    .foregroundStyle(.tt.textPrimary)
                                    let subtitle = NativeTabDocVersionHistoryPresentation.entrySubtitle(
                                        createdAt: entry.createdAt
                                    )
                                    if !subtitle.isEmpty {
                                        Text(subtitle)
                                            .font(.tt.meta)
                                            .foregroundStyle(.tt.textSecondary)
                                    }
                                }
                                Spacer()
                                Button(L10n.TabDoc.versionRestore) {
                                    Task { await session.restoreVersion(id: entry.id) }
                                }
                                .disabled(session.isRestoringHistory || !session.canEdit)
                            }
                        }
                        .listStyle(.plain)
                    }
                }
            }
            .navigationTitle(L10n.TabDoc.versionHistory)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.close) { session.dismissVersionHistory() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

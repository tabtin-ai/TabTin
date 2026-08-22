import SwiftUI
import UniformTypeIdentifiers

/// Organization 级云盘 App 首页（读 + Task 8 写入 + Task 9 高风险操作）。
struct CloudDriveAppHomeView: View {
    @Bindable var viewModel: CloudDriveViewModel
    let appName: String
    let organizationName: String?
    let launchContext: AppHomeLaunchContext
    let conversationSink: CloudDriveConversationSink?
    let onBack: () -> Void
    /// 会话工作台以弹层承载时由右上角关闭；独立工作台仍保留返回。
    let onClose: (() -> Void)?
    let onOpenRoute: (SpaceAppRoute) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showActions = false
    @State private var showFileImporter = false
    @State private var showNewFolderAlert = false
    @State private var newFolderName = ""
    /// sheet 关闭后再呈现 fileImporter / alert，避免同帧双 present 失败。
    @State private var pendingAfterActions: CloudDriveDeferredPresentation?

    @State private var renameTarget: OrganizationCollection?
    @State private var renameDraft = ""
    @State private var deleteFolderTarget: OrganizationCollection?
    @State private var moveFolderTarget: OrganizationCollection?
    @State private var moveResourceContextItemId: String?
    @State private var showFolderPicker = false
    /// 文件夹 picker 选目标后，等 sheet 拆除再出强确认。
    @State private var pendingFolderMoveConfirm: PendingFolderMove?
    @State private var trashFileTarget: TrashFileTarget?
    @State private var collaboratorsTarget: CollaboratorsTarget?
    @State private var permanentDeleteTarget: CloudDriveTrashedFileNotice?
    @State private var sendToast: String?
    @State private var previewRow: CloudDriveListRow?
    @State private var visibleRowCount = 6

    private let rowBatchSize = 6

    private var canSendToConversation: Bool {
        launchContext.canOfferSendToConversation && conversationSink != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            content
        }
        .background(.tt.bgCanvasDefault)
        .toolbar(.hidden, for: .navigationBar)
        .task { viewModel.onAppear() }
        .onChange(of: viewModel.scope) { _, _ in resetVisibleRows() }
        .onChange(of: viewModel.typeFilter) { _, _ in resetVisibleRows() }
        .onChange(of: viewModel.searchText) { _, _ in resetVisibleRows() }
        .onChange(of: viewModel.currentCollectionId) { _, _ in resetVisibleRows() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                viewModel.onSceneActive()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .cloudDrivePendingMountStoreDidChange)) { _ in
            Task { await viewModel.onPendingMountStoreChanged() }
        }
        .sheet(item: $previewRow) { row in
            CloudDrivePreviewSheet(row: row) {
                open(row)
            }
            .workbenchCapsuleTopLayer()
        }
        .sheet(isPresented: $showActions, onDismiss: presentDeferredActionIfNeeded) {
            CloudDriveActionSheet(
                canWrite: viewModel.canCreate,
                isWriting: viewModel.isWriting,
                pendingMountCount: viewModel.pendingMountCount,
                onUpload: { pendingAfterActions = .fileImporter },
                onNewFolder: { pendingAfterActions = .newFolder },
                onNewDoc: {
                    Task {
                        if await viewModel.createDocument() {
                            openPendingRouteIfNeeded()
                        }
                    }
                },
                onNewTable: {
                    Task {
                        if await viewModel.createTable() {
                            openPendingRouteIfNeeded()
                        }
                    }
                },
                onRetryPendingMount: {
                    Task {
                        await viewModel.retryPendingMounts()
                        openPendingRouteIfNeeded()
                    }
                },
                onDismiss: { showActions = false }
            )
            .workbenchCapsuleTopLayer()
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .success(let urls):
                Task {
                    await viewModel.uploadFiles(from: urls)
                    openPendingRouteIfNeeded()
                }
            case .failure:
                // 不记录本地路径；选择器取消/失败只关闭
                break
            }
        }
        .alert(
            L10n.CloudDrive.newFolder,
            isPresented: $showNewFolderAlert
        ) {
            TextField(L10n.CloudDrive.folderNamePlaceholder, text: $newFolderName)
            Button(L10n.Common.cancel, role: .cancel) {}
            Button(L10n.Common.confirm) {
                Task {
                    _ = await viewModel.createFolder(name: newFolderName)
                }
            }
        } message: {
            Text(L10n.CloudDrive.newFolderMessage)
        }
        .alert(
            L10n.CloudDrive.operationFailed,
            isPresented: writeErrorPresented
        ) {
            Button(L10n.Common.confirm, role: .cancel) {
                viewModel.clearWriteError()
            }
        } message: {
            Text(viewModel.writeError ?? "")
        }
        .alert(
            L10n.CloudDrive.renameFolder,
            isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            )
        ) {
            TextField(L10n.CloudDrive.folderNamePlaceholder, text: $renameDraft)
            Button(L10n.Common.cancel, role: .cancel) { renameTarget = nil }
            Button(L10n.Common.confirm) {
                guard let target = renameTarget else { return }
                Task { _ = await viewModel.renameFolder(collectionId: target.id, name: renameDraft) }
            }
        } message: {
            Text(L10n.CloudDrive.renameFolderMessage)
        }
        .confirmationDialog(
            L10n.CloudDrive.deleteFolderTitle,
            isPresented: Binding(
                get: { deleteFolderTarget != nil },
                set: { if !$0 { deleteFolderTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n.CloudDrive.deleteFolderConfirm, role: .destructive) {
                guard let target = deleteFolderTarget else { return }
                Task { _ = await viewModel.deleteFolder(collectionId: target.id) }
            }
            Button(L10n.Common.cancel, role: .cancel) { deleteFolderTarget = nil }
        } message: {
            Text(L10n.CloudDrive.deleteFolderMessage)
        }
        .sheet(isPresented: $showFolderPicker, onDismiss: presentDeferredFolderMoveConfirmIfNeeded) {
            CloudDriveFolderPicker(
                collections: viewModel.collections,
                excludeCollectionId: moveFolderTarget?.id,
                onPick: { parentId in
                    showFolderPicker = false
                    if let folder = moveFolderTarget {
                        moveFolderTarget = nil
                        let targetName = folderMoveTargetDisplayName(parentId)
                        pendingFolderMoveConfirm = PendingFolderMove(
                            folder: folder,
                            targetParentId: parentId,
                            targetName: targetName
                        )
                    } else if let contextItemId = moveResourceContextItemId {
                        moveResourceContextItemId = nil
                        Task { _ = await viewModel.moveResource(contextItemId: contextItemId, toCollectionId: parentId) }
                    }
                },
                onCancel: {
                    showFolderPicker = false
                    moveFolderTarget = nil
                    moveResourceContextItemId = nil
                    pendingFolderMoveConfirm = nil
                }
            )
            .workbenchCapsuleTopLayer()
        }
        .confirmationDialog(
            L10n.CloudDrive.moveFolder,
            isPresented: Binding(
                get: { pendingFolderMoveConfirm != nil && !showFolderPicker },
                set: { if !$0 { pendingFolderMoveConfirm = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n.CloudDrive.moveFolderConfirm) {
                guard let pending = pendingFolderMoveConfirm else { return }
                pendingFolderMoveConfirm = nil
                Task {
                    _ = await viewModel.moveFolder(
                        collectionId: pending.folder.id,
                        toParentId: pending.targetParentId
                    )
                }
            }
            Button(L10n.Common.cancel, role: .cancel) { pendingFolderMoveConfirm = nil }
        } message: {
            if let pending = pendingFolderMoveConfirm {
                Text(
                    CloudDriveHighRiskPolicy.moveFolderConfirmMessage(
                        sourceName: pending.folder.name.isEmpty
                            ? L10n.CloudDrive.untitledFolder
                            : pending.folder.name,
                        targetName: pending.targetName
                    )
                )
            } else {
                Text("")
            }
        }
        .confirmationDialog(
            L10n.CloudDrive.moveToTrash,
            isPresented: Binding(
                get: { trashFileTarget != nil },
                set: { if !$0 { trashFileTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n.CloudDrive.moveToTrash, role: .destructive) {
                guard let target = trashFileTarget else { return }
                trashFileTarget = nil
                Task {
                    _ = await viewModel.trashTabFile(
                        fileRecordId: target.fileRecordId,
                        title: target.title
                    )
                }
            }
            Button(L10n.Common.cancel, role: .cancel) { trashFileTarget = nil }
        } message: {
            Text(L10n.CloudDrive.trashFileMessage)
        }
        .sheet(item: $collaboratorsTarget) { target in
            TabFilesCollaboratorsSheet(
                fileRecordId: target.fileRecordId,
                resourceTitle: target.title,
                canManage: target.canManage
            )
            .workbenchCapsuleTopLayer()
        }
        .confirmationDialog(
            L10n.CloudDrive.permanentDeleteTitle,
            isPresented: Binding(
                get: { permanentDeleteTarget != nil },
                set: { if !$0 { permanentDeleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n.CloudDrive.permanentDeleteConfirm, role: .destructive) {
                guard let target = permanentDeleteTarget else { return }
                Task {
                    _ = await viewModel.permanentDeleteTrashedTabFile(fileRecordId: target.fileRecordId)
                }
            }
            Button(L10n.Common.cancel, role: .cancel) { permanentDeleteTarget = nil }
        } message: {
            Text(L10n.CloudDrive.permanentDeleteMessage(permanentDeleteTarget?.title ?? ""))
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: TTSpacing.sm) {
                if let notice = viewModel.trashedFileNotice {
                    trashedBanner(notice)
                }
                if viewModel.isWriting, let progress = viewModel.uploadProgress {
                    uploadBanner(progress)
                }
                if let sendToast {
                    Text(sendToast)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textPrimary)
                        .padding(TTSpacing.md)
                        .frame(maxWidth: .infinity)
                        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
                        .padding(.horizontal, TTSpacing.md)
                }
            }
        }
    }

    private func trashedBanner(_ notice: CloudDriveTrashedFileNotice) -> some View {
        HStack(spacing: TTSpacing.sm) {
            Text(L10n.CloudDrive.trashedBanner(notice.title))
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button(L10n.CloudDrive.restore) {
                Task { _ = await viewModel.restoreTrashedTabFile(fileRecordId: notice.fileRecordId) }
            }
            .buttonStyle(.bordered)
            Button(L10n.CloudDrive.permanentDelete, role: .destructive) {
                permanentDeleteTarget = notice
            }
            .buttonStyle(.bordered)
            Button {
                viewModel.clearTrashedFileNotice()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.Common.cancel)
        }
        .padding(TTSpacing.md)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .padding(.horizontal, TTSpacing.md)
    }

    private func openPendingRouteIfNeeded() {
        if let route = viewModel.consumePendingOpenRoute() {
            onOpenRoute(route)
        }
    }

    private func presentDeferredActionIfNeeded() {
        guard let pending = pendingAfterActions else { return }
        pendingAfterActions = nil
        // 等 sheet 完全拆除后再 present，避免同帧冲突。
        DispatchQueue.main.async {
            switch pending {
            case .fileImporter:
                showFileImporter = true
            case .newFolder:
                newFolderName = ""
                showNewFolderAlert = true
            }
        }
    }

    private func presentDeferredFolderMoveConfirmIfNeeded() {
        // Binding 已用 `!showFolderPicker`；再踢一帧确保 confirmationDialog 能弹出。
        guard pendingFolderMoveConfirm != nil else { return }
        DispatchQueue.main.async {
            // 触发 view 刷新：pending 已在 onPick 写入。
            _ = pendingFolderMoveConfirm
        }
    }

    private func folderMoveTargetDisplayName(_ parentId: String?) -> String {
        guard let parentId, !parentId.isEmpty else {
            return L10n.CloudDrive.rootFolder
        }
        if let name = CloudDriveFolderLookup.flatten(viewModel.collections)
            .first(where: { $0.id == parentId })?
            .name,
           !name.isEmpty {
            return name
        }
        return L10n.CloudDrive.untitledFolder
    }

    private func uploadBanner(_ progress: CloudDriveUploadProgress) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(progress.fileName)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
            Text(uploadPhaseLabel(progress.phase))
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
            if progress.phase == .uploading {
                ProgressView(value: max(0, min(1, progress.progress)))
            }
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .padding(TTSpacing.md)
        .accessibilityElement(children: .combine)
    }

    private func uploadPhaseLabel(_ phase: CloudDriveUploadPhase) -> String {
        switch phase {
        case .selected: return L10n.CloudDrive.uploadPhaseSelected
        case .uploading: return L10n.CloudDrive.uploadPhaseUploading
        case .confirmed: return L10n.CloudDrive.uploadPhaseConfirmed
        case .mounting: return L10n.CloudDrive.uploadPhaseMounting
        case .ready: return L10n.CloudDrive.uploadPhaseReady
        case .pendingMount: return L10n.CloudDrive.uploadPhasePendingMount
        }
    }

    private var header: some View {
        CloudDriveAppChrome(
            title: appName,
            subtitle: organizationName,
            usesCloseIcon: onClose != nil,
            onDismiss: onClose ?? onBack,
            onCreate: { showActions = true }
        )
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isInitialLoading && !viewModel.hasListContent {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel(L10n.Common.loading)
        } else if let pageError = viewModel.pageError, !viewModel.hasListContent {
            pageErrorState(pageError)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: TTSpacing.lg) {
                    searchField

                    if shouldShowHero, let heroRow {
                        VStack(alignment: .leading, spacing: TTSpacing.sm) {
                            Text(L10n.WorkbenchAppHome.resumeRecent)
                                .font(.tt.bodySemibold)
                                .foregroundStyle(.tt.textPrimary)
                            CloudDriveResumeCard(row: heroRow) {
                                previewRow = heroRow
                            }
                        }
                    }

                    if CloudDriveHomeVisibilityPolicy.shouldShowQuickActions(
                        scope: viewModel.scope,
                        isSearching: viewModel.isSearching
                    ) {
                        quickActions
                    }

                    if !viewModel.isSearching, !viewModel.breadcrumbPath.isEmpty {
                        breadcrumb
                    }

                    scopePicker
                    typeFilter

                    if viewModel.sharedSearchHitPageCap {
                        sharedSearchCapNote
                    }

                    listBody
                    loadMoreFooter
                }
                .padding(TTSpacing.lg)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await viewModel.refresh() }
        }
    }

    private var searchField: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "magnifyingglass")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.textTertiary)
                .accessibilityHidden(true)
            TextField(
                L10n.CloudDrive.searchPlaceholder,
                text: Binding(
                    get: { viewModel.searchText },
                    set: { viewModel.updateSearchText($0) }
                )
            )
            .font(.tt.body)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            if !viewModel.searchText.isEmpty {
                Button {
                    viewModel.updateSearchText("")
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.tt.iconBody)
                        .foregroundStyle(.tt.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.WorkbenchAppHome.clearSearch)
            }
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.md)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

    private var quickActions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: TTSpacing.md) {
                uploadQuickAction
                newFolderQuickAction
            }
            VStack(spacing: TTSpacing.sm) {
                uploadQuickAction
                newFolderQuickAction
            }
        }
    }

    private var uploadQuickAction: some View {
        CloudDriveQuickActionButton(
            title: L10n.CloudDrive.uploadFile,
            systemImage: "square.and.arrow.up",
            isEnabled: viewModel.canCreate && !viewModel.isWriting
        ) {
            showFileImporter = true
        }
    }

    private var newFolderQuickAction: some View {
        CloudDriveQuickActionButton(
            title: L10n.CloudDrive.newFolder,
            systemImage: "folder.badge.plus",
            isEnabled: viewModel.canCreate && !viewModel.isWriting
        ) {
            newFolderName = ""
            showNewFolderAlert = true
        }
    }

    @ViewBuilder
    private var scopePicker: some View {
        let scopes: [CloudDriveScope] = [.recent, .all, .shared]

        if dynamicTypeSize.isAccessibilitySize {
            Picker(
                L10n.WorkbenchAppHome.libraryScope,
                selection: Binding(
                    get: { viewModel.scope.rawValue },
                    set: { viewModel.setScope(CloudDriveScope(rawValue: $0) ?? .all) }
                )
            ) {
                ForEach(scopes) { scope in
                    Text(scope.title).tag(scope.rawValue)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .accessibilityLabel(L10n.WorkbenchAppHome.libraryScope)
        } else {
            HStack(spacing: 5) {
                ForEach(scopes) { scope in
                    Button {
                        viewModel.setScope(scope)
                    } label: {
                        Text(scope.title)
                            .font(scope == viewModel.scope ? .tt.metaSemibold : .tt.meta)
                            .foregroundStyle(
                                scope == viewModel.scope ? .tt.textPrimary : .tt.textSecondary
                            )
                            .padding(.horizontal, TTSpacing.md)
                            .frame(minHeight: 44)
                            .background {
                                if scope == viewModel.scope {
                                    Capsule()
                                        .fill(.tt.bgBubbleIncoming)
                                        .overlay(
                                            Capsule()
                                                .strokeBorder(.tt.borderLight, lineWidth: 1)
                                        )
                                }
                            }
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(scope == viewModel.scope ? .isSelected : [])
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L10n.WorkbenchAppHome.libraryScope)
        }
    }

    private var typeFilter: some View {
        HStack {
            Text(L10n.CloudDrive.organizationCloud)
                .font(.tt.metaSemibold)
                .foregroundStyle(.tt.textSecondary)
            Spacer(minLength: TTSpacing.sm)
            Menu {
                ForEach(CloudDriveTypeFilter.allCases) { filter in
                    Button {
                        viewModel.setTypeFilter(filter)
                    } label: {
                        if viewModel.typeFilter == filter {
                            Label(filter.title, systemImage: "checkmark")
                        } else {
                            Text(filter.title)
                        }
                    }
                }
            } label: {
                HStack(spacing: TTSpacing.sm) {
                    Text(viewModel.typeFilter.title)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Image(systemName: "chevron.down")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textSecondary)
                }
                .padding(.horizontal, TTSpacing.md)
                .frame(minHeight: 44)
                .background(.tt.bgBubbleIncoming, in: Capsule())
                .overlay {
                    Capsule()
                        .stroke(.tt.borderLight, lineWidth: 0.5)
                }
            }
        }
    }

    @ViewBuilder
    private var breadcrumb: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: TTSpacing.xs) {
                breadcrumbButton(L10n.CloudDrive.rootFolder, collectionId: nil)
                ForEach(viewModel.breadcrumbPath) { folder in
                    Image(systemName: "chevron.right")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textTertiary)
                    breadcrumbButton(folder.name, collectionId: folder.id)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.CloudDrive.breadcrumb)
    }

    private func breadcrumbButton(_ title: String, collectionId: String?) -> some View {
        let selected = viewModel.currentCollectionId == collectionId
        return Button {
            viewModel.navigateBreadcrumb(to: collectionId)
        } label: {
            Text(title)
                .font(.tt.captionMedium)
                .foregroundStyle(selected ? .tt.textAccent : .tt.textSecondary)
                .lineLimit(1)
                .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private var listBody: some View {
        if viewModel.listRows.isEmpty {
            emptyState
        } else {
            VStack(spacing: 0) {
                ForEach(Array(visibleRows.enumerated()), id: \.element.id) { index, row in
                    HStack(spacing: 0) {
                        Button {
                            open(row)
                        } label: {
                            rowView(row)
                        }
                        .buttonStyle(.plain)

                        if hasVisibleMenu(row) {
                            Menu {
                                rowMenu(row)
                            } label: {
                                Image(systemName: "ellipsis")
                                    .font(.tt.iconBody)
                                    .foregroundStyle(.tt.textSecondary)
                                    .frame(width: 44, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityLabel(L10n.Common.more)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.tt.iconCaption)
                                .foregroundStyle(.tt.textTertiary)
                                .frame(width: 44, height: 44)
                                .accessibilityHidden(true)
                        }
                    }
                    .contextMenu { rowMenu(row) }

                    if index < visibleRows.count - 1 {
                        Divider()
                            .padding(.leading, 68)
                    }
                }
            }
            .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous)
                    .stroke(.tt.borderLight, lineWidth: 0.5)
            }
            .clipShape(RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous))
        }
    }

    private func rowView(_ row: CloudDriveListRow) -> some View {
        let presentation = CloudDriveRowPresentation(row: row)
        return HStack(spacing: TTSpacing.md) {
            CloudDriveResourceGlyph(kind: presentation.kind, size: 42)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                if let subtitle = subtitle(for: row) {
                    Text(subtitle)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var loadMoreFooter: some View {
        if let loadMoreError = viewModel.loadMoreError {
            VStack(spacing: TTSpacing.sm) {
                Text(loadMoreError)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .multilineTextAlignment(.center)
                Button(L10n.Common.retry) {
                    Task { await viewModel.retryLoadMore() }
                }
                .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TTSpacing.md)
        } else if viewModel.isLoadingMore {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, TTSpacing.md)
        } else if visibleRowCount < viewModel.listRows.count || viewModel.hasMore {
            Button {
                showMoreRows()
            } label: {
                Label(L10n.Common.more, systemImage: "chevron.down")
                    .font(.tt.metaSemibold)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tt.textAccent)
        }
    }

    private var emptyState: some View {
        VStack(spacing: TTSpacing.sm) {
            Image(systemName: "folder")
                .font(.tt.iconEmpty)
                .foregroundStyle(.tt.iconAccent.opacity(0.6))
            Text(emptyTitle)
                .font(.tt.bodyMedium)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
            if viewModel.sharedSearchHitPageCap {
                Text(L10n.CloudDrive.sharedSearchCappedNote)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, TTSpacing.xl)
    }

    private var sharedSearchCapNote: some View {
        Text(L10n.CloudDrive.sharedSearchCappedNote)
            .font(.tt.meta)
            .foregroundStyle(.tt.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(L10n.CloudDrive.sharedSearchCappedNote)
    }

    private func pageErrorState(_ message: String) -> some View {
        TTErrorStateView(message: message, prominence: .inline) {
            Task { await viewModel.refresh() }
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyTitle: String {
        if viewModel.isSearching { return L10n.CloudDocs.emptySearch }
        switch viewModel.scope {
        case .all: return L10n.CloudDocs.emptyAll
        case .recent: return L10n.CloudDocs.emptyRecent
        case .shared: return L10n.CloudDocs.emptyShared
        }
    }

    private func subtitle(for row: CloudDriveListRow) -> String? {
        switch row {
        case let .folder(folder):
            if let count = folder.itemCount {
                return L10n.CloudDrive.itemCount(count)
            }
            return L10n.CloudDrive.folderLabel
        case let .resource(resource):
            if viewModel.isSearching {
                if let collectionId = resource.collectionId,
                   let folder = CloudDriveFolderLookup.flatten(viewModel.collections)
                    .first(where: { $0.id == collectionId }) {
                    return folder.name
                }
                return L10n.CloudDrive.rootFolder
            }
            var parts: [String] = []
            if let rawDate = resource.lastVisitedAt ?? resource.updatedAt,
               let relative = RelativeTime.format(rawDate) {
                parts.append(relative)
            }
            if let size = resource.fileSizeBytes, size > 0 {
                parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
            }
            if parts.isEmpty, let owner = resource.owner?.presentableName {
                parts.append(owner)
            }
            return parts.isEmpty ? resource.typeLabel : parts.joined(separator: " · ")
        case let .shared(item):
            var parts: [String] = []
            if let name = item.sharedBy?.displayName, !name.isEmpty {
                parts.append(L10n.CloudDocs.sharedBy(name))
            }
            if let updatedAt = item.updatedAt, let relative = RelativeTime.format(updatedAt) {
                parts.append(relative)
            }
            if parts.isEmpty, !item.permission.isEmpty {
                parts.append(item.permission)
            }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
    }

    private var shouldShowHero: Bool {
        CloudDriveHomeVisibilityPolicy.shouldShowResumeHero(
            scope: viewModel.scope,
            isSearching: viewModel.isSearching,
            isAtRoot: viewModel.currentCollectionId == nil
        )
    }

    private var heroRow: CloudDriveListRow? {
        viewModel.resumeItem.map(CloudDriveListRow.resource)
    }

    private var visibleRows: [CloudDriveListRow] {
        Array(viewModel.listRows.prefix(visibleRowCount))
    }

    private var writeErrorPresented: Binding<Bool> {
        Binding(
            get: { viewModel.writeError != nil },
            set: { isPresented in
                if !isPresented { viewModel.clearWriteError() }
            }
        )
    }

    private func resetVisibleRows() {
        visibleRowCount = rowBatchSize
    }

    private func showMoreRows() {
        if visibleRowCount < viewModel.listRows.count {
            visibleRowCount = min(visibleRowCount + rowBatchSize, viewModel.listRows.count)
            return
        }
        guard viewModel.hasMore else { return }
        Task {
            await viewModel.loadMore()
            visibleRowCount = min(visibleRowCount + rowBatchSize, viewModel.listRows.count)
        }
    }

    private func hasVisibleMenu(_ row: CloudDriveListRow) -> Bool {
        switch row {
        case .folder: return viewModel.canManageFolders
        case .resource, .shared: return true
        }
    }

    private func open(_ row: CloudDriveListRow) {
        switch row {
        case let .folder(folder):
            viewModel.openFolder(folder.id)
        case let .resource(resource):
            viewModel.recordAccess(contextItemId: resource.contextItemId)
            if let route = resource.appRoute {
                onOpenRoute(route)
            }
        case let .shared(item):
            viewModel.recordAccess(contextItemId: item.contextItemId)
            if let route = item.appRoute {
                onOpenRoute(route)
            }
        }
    }

    @ViewBuilder
    private func rowMenu(_ row: CloudDriveListRow) -> some View {
        switch row {
        case .folder:
            EmptyView()
        case .resource, .shared:
            Button {
                previewRow = row
            } label: {
                Label(L10n.CloudDrive.preview, systemImage: "eye")
            }
        }
        rowContextMenu(row)
    }

    @ViewBuilder
    private func rowContextMenu(_ row: CloudDriveListRow) -> some View {
        switch row {
        case let .folder(folder):
            if viewModel.canManageFolders {
                Button {
                    renameDraft = folder.name
                    renameTarget = folder
                } label: {
                    Label(L10n.CloudDrive.renameFolder, systemImage: "pencil")
                }
                Button {
                    moveFolderTarget = folder
                    moveResourceContextItemId = nil
                    showFolderPicker = true
                } label: {
                    Label(L10n.CloudDrive.moveFolder, systemImage: "folder")
                }
                Button(role: .destructive) {
                    deleteFolderTarget = folder
                } label: {
                    Label(L10n.CloudDrive.deleteFolder, systemImage: "trash")
                }
            }
            // 文件夹永远不提供「发送到当前对话」

        case let .resource(resource):
            if CloudDriveHighRiskPolicy.canMoveResource(resource), viewModel.canWrite {
                Button {
                    moveResourceContextItemId = resource.contextItemId
                    moveFolderTarget = nil
                    showFolderPicker = true
                } label: {
                    Label(L10n.CloudDrive.moveItem, systemImage: "folder")
                }
            }
            if CloudDriveHighRiskPolicy.canManageTabFileCollaborators(resource),
               let fileRecordId = resource.fileRecordId {
                Button {
                    collaboratorsTarget = CollaboratorsTarget(
                        fileRecordId: fileRecordId,
                        title: resource.displayTitle,
                        canManage: resource.canShare == true
                    )
                } label: {
                    Label(L10n.CloudDrive.manageCollaborators, systemImage: "person.2")
                }
            }
            if CloudDriveHighRiskPolicy.canTrashTabFile(resource),
               let fileRecordId = resource.fileRecordId {
                Button(role: .destructive) {
                    trashFileTarget = TrashFileTarget(
                        fileRecordId: fileRecordId,
                        title: resource.displayTitle
                    )
                } label: {
                    Label(L10n.CloudDrive.moveToTrash, systemImage: "trash")
                }
            }
            if canSendToConversation,
               CloudDriveHighRiskPolicy.canSendToConversation(row: row, sink: conversationSink),
               let ref = CloudDriveHighRiskPolicy.mentionRef(
                for: resource,
                fallbackSpaceName: organizationName
               ) {
                Button {
                    conversationSink?.sendResource(ref)
                    sendToast = L10n.CloudDrive.sentToConversation
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        await MainActor.run { sendToast = nil }
                    }
                } label: {
                    Label(L10n.CloudDrive.sendToConversation, systemImage: "text.bubble")
                }
            }

        case let .shared(item):
            // 分享资源默认不可移动（owner-only）；仍可按 sink 发送。
            if canSendToConversation,
               CloudDriveHighRiskPolicy.canSendToConversation(row: row, sink: conversationSink),
               let ref = CloudDriveHighRiskPolicy.mentionRef(
                for: item,
                fallbackSpaceName: organizationName
               ) {
                Button {
                    conversationSink?.sendResource(ref)
                    sendToast = L10n.CloudDrive.sentToConversation
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        await MainActor.run { sendToast = nil }
                    }
                } label: {
                    Label(L10n.CloudDrive.sendToConversation, systemImage: "text.bubble")
                }
            }
        }
    }
}

private enum CloudDriveDeferredPresentation {
    case fileImporter
    case newFolder
}

private struct CollaboratorsTarget: Identifiable, Hashable {
    let fileRecordId: String
    let title: String
    let canManage: Bool
    var id: String { fileRecordId }
}

private struct TrashFileTarget: Identifiable, Hashable {
    let fileRecordId: String
    let title: String
    var id: String { fileRecordId }
}

private struct PendingFolderMove: Identifiable, Hashable {
    let folder: OrganizationCollection
    let targetParentId: String?
    let targetName: String
    var id: String { folder.id }
}

import Kingfisher
import SwiftUI
import UIKit

struct NativeTabDataScreen: View {
    let tableId: String
    let organizationId: String
    let spaceId: String?
    let fallbackTitle: String
    let locationHint: String?
    let onNativeFocusReport: ((NativeWorkbenchFocusReport) -> Void)?

    @Environment(\.scenePhase) private var scenePhase
    @State private var session: NativeTabDataSession
    @State private var workspace = WorkspaceStore.shared
    @State private var searchText = ""
    @State private var searchTask: Task<Void, Never>?
    @State private var selectedRecordId: String?
    @State private var creationRecord: NativeTabDataRecord?
    @State private var recoveryDraft: NativeTabDataLocalDraftSnapshot?
    @State private var showsFilter = false
    @State private var showsSort = false
    @State private var showsCreateField = false
    @State private var showsFullEditor = false
    @State private var showsSendToDM = false
    @State private var showsFullEditorDraftWarning = false
    @State private var showsFullEditorSavingWarning = false
    @State private var opensFullEditorAfterDetailDismiss = false
    @State private var surfacedError: String?
    @State private var surfacedNotice: String?
    @State private var noticeDismissTask: Task<Void, Never>?

    init(
        tableId: String,
        organizationId: String,
        spaceId: String?,
        fallbackTitle: String,
        locationHint: String?,
        onNativeFocusReport: ((NativeWorkbenchFocusReport) -> Void)? = nil,
        session: NativeTabDataSession? = nil
    ) {
        self.tableId = tableId
        self.organizationId = organizationId
        self.spaceId = spaceId
        self.fallbackTitle = fallbackTitle
        self.locationHint = locationHint
        self.onNativeFocusReport = onNativeFocusReport
        _session = State(initialValue: session ?? NativeTabDataSession(
            tableId: tableId,
            organizationId: organizationId
        ))
    }

    var body: some View {
        Group {
            if session.isLoading && session.table == nil {
                loadingState
            } else if let error = session.loadError, session.table == nil {
                errorState(error, localDrafts: session.localDraftSnapshots)
            } else {
                content
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .toolbar { toolbar }
        .task {
            session.startRealtime()
            await session.load()
            await session.warmUpMemberDirectory()
            reportNativeFocus()
        }
        .onChange(of: session.selectedViewId) { _, _ in reportNativeFocus() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, session.table != nil else { return }
            Task {
                await session.refresh()
                await session.warmUpMemberDirectory()
            }
        }
        .onChange(of: workspace.selectedOrganizationId) { _, _ in
            selectedRecordId = nil
            creationRecord = nil
            showsCreateField = false
            showsFullEditor = false
            showsSendToDM = false
            _ = session.validateSession()
        }
        .onChange(of: session.saveError) { _, value in surfacedError = value }
        .onChange(of: session.saveNotice) { _, value in surfaceNotice(value) }
        .onChange(of: selectedRecordId, initial: true) { _, value in
            session.setOpenRecordId(value)
        }
        .sheet(isPresented: $showsFilter) {
            NativeTabDataFilterSheet(session: session)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showsSort) {
            NativeTabDataSortSheet(
                fields: session.visibleFields,
                current: session.sortRule,
                onApply: { rule in Task { await session.applySort(rule) } }
            )
            .presentationDetents([.medium])
        }
        .sheet(isPresented: $showsCreateField) {
            NativeTabDataCreateFieldSheet(session: session)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showsSendToDM) {
            CloudResourceSendToDMSheet(target: directMessageTarget)
        }
        .sheet(isPresented: $showsFullEditor) {
            NavigationStack {
                AuthenticatedWorkbenchResourceWebScreen(
                    resource: .table(id: tableId),
                    organizationId: organizationId,
                    spaceId: spaceId,
                    title: displayTitle,
                    locationHint: locationHint
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(L10n.Common.close) { showsFullEditor = false }
                    }
                }
            }
        }
        .sheet(
            isPresented: Binding(
                get: { selectedRecordId != nil },
                set: { if !$0 { selectedRecordId = nil } }
            ),
            onDismiss: completeDeferredFullEditorHandoff
        ) {
            if let id = selectedRecordId, let record = session.record(id: id) {
                NavigationStack {
                    NativeTabDataRecordDetailScreen(
                        session: session,
                        record: record,
                        mode: .existing,
                        onOpenFullEditor: deferFullEditorUntilDetailDismisses,
                        onOpenRecord: { selectedRecordId = $0 }
                    )
                }
            }
        }
        .sheet(item: creationRecordBinding, onDismiss: completeDeferredFullEditorHandoff) { record in
            NavigationStack {
                NativeTabDataRecordDetailScreen(
                    session: session,
                    record: record,
                    mode: .creating,
                    onOpenFullEditor: deferFullEditorUntilDetailDismisses
                )
            }
        }
        .sheet(item: $recoveryDraft) { draft in
            NavigationStack {
                NativeTabDataLocalDraftRecoveryScreen(draft: draft)
            }
        }
        .onChange(of: showsFullEditor) { wasPresented, isPresented in
            guard wasPresented, !isPresented else { return }
            guard session.validateSession() else { return }
            Task { await session.load() }
        }
        .confirmationDialog(
            L10n.TabData.fullEditorBlockedTitle,
            isPresented: $showsFullEditorDraftWarning,
            titleVisibility: .visible
        ) {
            Button(L10n.TabData.fullEditorDiscardAndOpen, role: .destructive) {
                if session.discardAllDrafts() { showsFullEditor = true }
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.TabData.fullEditorBlockedMessage)
        }
        .alert(L10n.TabData.fullEditorSavingTitle, isPresented: $showsFullEditorSavingWarning) {
            Button(L10n.Common.confirm, role: .cancel) {}
        } message: {
            Text(L10n.TabData.fullEditorSavingMessage)
        }
        .alert(
            L10n.TabData.saveFailedTitle,
            isPresented: Binding(
                get: { surfacedError != nil },
                set: { if !$0 { surfacedError = nil } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) { surfacedError = nil }
        } message: {
            Text(surfacedError ?? "")
        }
        .overlay(alignment: .bottom) {
            if let surfacedNotice {
                NativeTabDataNoticeToast(message: surfacedNotice)
                    .padding(.horizontal, TTSpacing.md)
                    .padding(.bottom, TTSpacing.lg)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: surfacedNotice)
        .onDisappear {
            session.stopRealtime()
            noticeDismissTask?.cancel()
            noticeDismissTask = nil
        }
    }

    /// 协同冲突是提示不是错误：写入已经成功，用户不该被弹窗打断确认。
    private func surfaceNotice(_ message: String?) {
        noticeDismissTask?.cancel()
        surfacedNotice = message
        guard message != nil else { return }
        noticeDismissTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(3.2))
            guard !Task.isCancelled else { return }
            surfacedNotice = nil
            noticeDismissTask = nil
        }
    }

    private var creationRecordBinding: Binding<NativeTabDataRecord?> {
        Binding(
            get: { creationRecord },
            set: { next in
                if next == nil, let creationRecord {
                    session.finishCreation(for: creationRecord)
                }
                creationRecord = next
            }
        )
    }

    private func startCreation(from group: NativeTabDataRecordGroup? = nil) {
        if session.creationEntry == .viewLocalDraft,
           let resumable = session.resumableCreationRecord(),
           let draft = session.localDraftSnapshot(for: resumable) {
            recoveryDraft = draft
            return
        }
        creationRecord = group.map { session.beginCreation(from: $0) } ?? session.beginCreation()
    }

    private var displayTitle: String {
        NativeTabDataTitlePolicy.nonEmpty(
            session.table?.name,
            fallback: NativeTabDataTitlePolicy.nonEmpty(fallbackTitle, fallback: L10n.TabData.untitledTable)
        )
    }

    private func reportNativeFocus() {
        onNativeFocusReport?(NativeWorkbenchFocusReport(
            appType: "tabdata",
            resourceId: tableId,
            viewId: session.selectedViewId
        ))
    }

    private var content: some View {
        VStack(spacing: 0) {
            controls
            Divider()

            if !session.supportsNativeCards {
                complexView
            } else if session.isLoading {
                loadingState
            } else if let error = session.loadError, session.records.isEmpty, session.groups.isEmpty {
                errorState(error)
            } else if session.isKanban {
                groupedCards
            } else {
                recordCards
            }
        }
    }

    private var controls: some View {
        VStack(spacing: TTSpacing.md) {
            if session.views.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: TTSpacing.sm) {
                        ForEach(session.views) { view in
                            Button {
                                Task { await session.selectView(view.id) }
                            } label: {
                                Label(view.name, systemImage: viewIcon(view.viewType))
                                    .font(.tt.bodyMedium)
                                    .foregroundStyle(session.selectedViewId == view.id ? .tt.textOnAccent : .tt.textSecondary)
                                    .padding(.horizontal, TTSpacing.md)
                                    .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                                    .background(
                                        session.selectedViewId == view.id ? Color.tt.bgAccent : Color.tt.bgSubtle,
                                        in: Capsule()
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, TTSpacing.lg)
                }
            }

            if session.supportsNativeCards {
                HStack(spacing: TTSpacing.sm) {
                    HStack(spacing: TTSpacing.sm) {
                        Image(systemName: "magnifyingglass")
                            .font(.tt.iconBody)
                            .foregroundStyle(.tt.textTertiary)
                        TextField(L10n.TabData.searchPlaceholder, text: $searchText)
                            .font(.tt.body)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit { Task { await session.search(searchText) } }
                            .onChange(of: searchText) { _, value in
                                searchTask?.cancel()
                                searchTask = Task {
                                    try? await Task.sleep(for: .milliseconds(350))
                                    guard !Task.isCancelled else { return }
                                    await session.search(value)
                                }
                            }
                        if !searchText.isEmpty {
                            Button {
                                searchText = ""
                                Task { await session.search("") }
                            } label: {
                                Image(systemName: "xmark.circle.fill").font(.tt.iconBody)
                            }
                            .foregroundStyle(.tt.textTertiary)
                            .accessibilityLabel(L10n.TabData.searchPlaceholder)
                        }
                    }
                    .padding(.horizontal, TTSpacing.md)
                    .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))

                    controlButton(
                        session.filterRules.isEmpty
                            ? L10n.TabData.filter
                            : L10n.TabData.filterCount(session.filterRules.count),
                        icon: "line.3.horizontal.decrease.circle",
                        active: !session.filterRules.isEmpty,
                        count: session.filterRules.count
                    ) {
                        showsFilter = true
                    }
                    controlButton(L10n.TabData.sort, icon: "arrow.up.arrow.down.circle", active: session.sortRule != nil) {
                        showsSort = true
                    }
                }
                .padding(.horizontal, TTSpacing.lg)
            }
        }
        .padding(.vertical, TTSpacing.md)
        .background(.tt.bgCanvasDefault)
    }

    private func controlButton(
        _ label: String,
        icon: String,
        active: Bool,
        count: Int = 0,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: icon)
                    .font(.tt.iconSubtitle)
                if count > 0 {
                    Text("\(count)")
                        .font(.tt.caption)
                }
            }
            .foregroundStyle(active ? .tt.iconAccent : .tt.iconSecondary)
            .frame(minWidth: TTSpacing.Control.minimumTouchTarget, minHeight: TTSpacing.Control.minimumTouchTarget)
            .padding(.horizontal, count > 0 ? TTSpacing.sm : 0)
            .background(active ? Color.tt.bgSubtleSecondary : Color.clear, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var recordCards: some View {
        ScrollView {
            LazyVStack(spacing: TTSpacing.md) {
                listMeta
                ForEach(session.records) { record in
                    NativeTabDataCard(
                        record: record,
                        fields: session.fields,
                        view: session.selectedView,
                        directory: session.memberDirectory
                    ) {
                        selectedRecordId = record.id
                    }
                    .onAppear {
                        if record.id == session.records.last?.id, session.canLoadMore {
                            Task {
                                await session.loadMore()
                                await session.warmUpMemberDirectory()
                            }
                        }
                    }
                }
                if session.isLoadingMore {
                    ProgressView(L10n.TabData.loadingMore)
                        .font(.tt.body)
                        .padding(TTSpacing.lg)
                }
            }
            .padding(TTSpacing.lg)
        }
        .refreshable {
            await session.refresh()
            await session.warmUpMemberDirectory()
        }
        .overlay { emptyOverlay(if: session.records.isEmpty) }
    }

    private var groupedCards: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: TTSpacing.xxl) {
                listMeta
                ForEach(session.groups) { group in
                    VStack(alignment: .leading, spacing: TTSpacing.md) {
                        HStack(spacing: TTSpacing.sm) {
                            Circle()
                                .fill(groupColor(group.color))
                                .frame(width: TTSpacing.sm, height: TTSpacing.sm)
                            Text(group.groupLabel.isEmpty ? L10n.TabData.noValue : group.groupLabel)
                                .font(.tt.subtitleSemibold)
                                .foregroundStyle(.tt.textPrimary)
                            Text("\(group.count)")
                                .font(.tt.captionMedium)
                                .foregroundStyle(.tt.textTertiary)
                                .padding(.horizontal, TTSpacing.sm)
                                .padding(.vertical, TTSpacing.xs)
                                .background(.tt.bgSubtle, in: Capsule())
                        }

                        ForEach(group.records) { record in
                            NativeTabDataCard(
                                record: record,
                                fields: session.fields,
                                view: session.selectedView,
                                directory: session.memberDirectory
                            ) {
                                selectedRecordId = record.id
                            }
                        }
                        if session.creationEntry != .hidden {
                            Button {
                                startCreation(from: group)
                            } label: {
                                Label(L10n.TabData.addRecord, systemImage: "plus")
                                    .font(.tt.bodyMedium)
                                    .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget)
                            }
                            .buttonStyle(.bordered)
                        }
                        if group.hasMore {
                            Button {
                                Task {
                                    await session.loadMore(in: group)
                                    await session.warmUpMemberDirectory()
                                }
                            } label: {
                                Label(L10n.TabData.loadMore, systemImage: "chevron.down")
                                    .font(.tt.bodyMedium)
                                    .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
            .padding(TTSpacing.lg)
        }
        .refreshable {
            await session.refresh()
            await session.warmUpMemberDirectory()
        }
        .overlay { emptyOverlay(if: session.groups.isEmpty) }
    }

    private var listMeta: some View {
        HStack {
            Text("\(session.total) \(session.isKanban ? L10n.TabData.groupedCount : L10n.TabData.recordsCount)")
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)
            Spacer()
            if !session.canEdit {
                Label(L10n.TabData.readOnly, systemImage: "eye")
                    .font(.tt.metaMedium)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
    }

    @ViewBuilder
    private func emptyOverlay(if isEmpty: Bool) -> some View {
        if isEmpty, !session.isLoading, let kind = emptyKind {
            VStack(spacing: TTSpacing.md) {
                Image(systemName: "rectangle.stack.badge.plus")
                    .font(.tt.iconEmptyMD)
                    .foregroundStyle(.tt.iconAccent)
                Text(emptyTitle(kind))
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                Text(emptyMessage(kind))
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(TTSpacing.xxl)
        }
    }

    private var emptyKind: NativeTabDataEmptyKind? {
        NativeTabDataEmptyPolicy.kind(
            hasViews: !session.views.isEmpty,
            isKanban: session.isKanban,
            recordCount: session.isKanban
                ? session.groups.reduce(0) { $0 + $1.records.count }
                : session.records.count,
            hasActiveQuery: session.hasActiveQuery
        )
    }

    private func emptyTitle(_ kind: NativeTabDataEmptyKind) -> String {
        switch kind {
        case .noViews: L10n.TabData.emptyNoViews
        case .noMatches: L10n.TabData.emptyNoMatches
        case .noRecords, .emptyKanban: L10n.TabData.emptyNoRecords
        }
    }

    private func emptyMessage(_ kind: NativeTabDataEmptyKind) -> String {
        switch kind {
        case .noViews: L10n.TabData.emptyNoViewsHint
        case .noMatches: L10n.TabData.emptyNoMatchesHint
        case .noRecords: L10n.TabData.emptyNoRecordsHint
        case .emptyKanban: L10n.TabData.emptyKanbanHint
        }
    }

    private var complexView: some View {
        let viewName = session.selectedView?.name ?? ""
        let typeLabel = viewTypeLabel(
            viewType: session.selectedView?.viewType ?? "",
            fallback: viewName
        )
        return VStack(spacing: TTSpacing.lg) {
            Image(systemName: "rectangle.3.group")
                .font(.tt.iconEmptyLG)
                .foregroundStyle(.tt.iconAccent)
            Text(L10n.TabData.complexViewTitle(viewName))
                .font(.tt.titleSemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(L10n.TabData.complexViewMessage(typeLabel))
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
            Button(L10n.TabData.openFullEditor) { requestFullEditor() }
                .buttonStyle(.borderedProminent)
        }
        .padding(TTSpacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func viewTypeLabel(viewType: String, fallback: String) -> String {
        switch viewType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "calendar":
            return L10n.TabData.viewTypeCalendar
        case "gallery":
            return L10n.TabData.viewTypeGallery
        case "form":
            return L10n.TabData.viewTypeForm
        case "flashcard":
            return L10n.TabData.viewTypeFlashcard
        case "pivot":
            return L10n.TabData.viewTypePivot
        default:
            return fallback
        }
    }

    private var loadingState: some View {
        VStack(spacing: TTSpacing.lg) {
            ProgressView().tint(.tt.iconAccent)
            Text(L10n.TabData.loading).font(.tt.body).foregroundStyle(.tt.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(
        _ message: String,
        localDrafts: [NativeTabDataLocalDraftSnapshot] = []
    ) -> some View {
        ScrollView {
            VStack(spacing: TTSpacing.lg) {
                Image(systemName: "tablecells.badge.ellipsis")
                    .font(.tt.iconEmptyLG)
                    .foregroundStyle(.tt.textTertiary)
                Text(message)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                    .multilineTextAlignment(.center)
                Button(L10n.Common.retry) { Task { await session.load() } }
                    .buttonStyle(.borderedProminent)
                if !localDrafts.isEmpty {
                    localDraftRecoveryList(localDrafts)
                }
            }
            .padding(TTSpacing.xxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func localDraftRecoveryList(_ drafts: [NativeTabDataLocalDraftSnapshot]) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text(L10n.TabData.localDraftTitle)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(L10n.TabData.localDraftMessage)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
            ForEach(drafts) { draft in
                Button {
                    recoveryDraft = draft
                } label: {
                    HStack(spacing: TTSpacing.md) {
                        Image(systemName: draft.isCreation ? "plus.rectangle.on.rectangle" : "rectangle.and.pencil.and.ellipsis")
                            .font(.tt.iconBody)
                            .foregroundStyle(.tt.iconAccent)
                        VStack(alignment: .leading, spacing: TTSpacing.xs) {
                            Text(draft.isCreation ? L10n.TabData.localDraftNewRecord : L10n.TabData.localDraftRecord)
                                .font(.tt.bodyMedium)
                                .foregroundStyle(.tt.textPrimary)
                            Text(draft.fields.first?.value ?? L10n.TabData.noValue)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                                .lineLimit(2)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.tt.iconCaptionMedium)
                            .foregroundStyle(.tt.textTertiary)
                    }
                    .padding(TTSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if NativeTabDataSaveIndicatorPolicy.shows(session.saveState) {
                if NativeTabDataSaveIndicatorPolicy.showsRetry(session.saveState) {
                    Button {
                        Task { await session.retryFailedSave() }
                    } label: {
                        saveStateBadge
                    }
                    .accessibilityHint(L10n.Common.retry)
                } else {
                    saveStateBadge
                }
            }
            if session.creationEntry != .hidden {
                Button {
                    startCreation()
                } label: {
                    Image(systemName: "plus").font(.tt.iconSubtitle)
                }
                .accessibilityLabel(
                    session.creationEntry == .create
                        ? L10n.TabData.addRecord
                        : L10n.TabData.localDraftView
                )
            }
            Menu {
                if session.canEdit {
                    Button {
                        session.clearFieldCreationError()
                        showsCreateField = true
                    } label: {
                        Label(L10n.TabData.addField, systemImage: "rectangle.stack.badge.plus")
                    }
                }
                Button { showsSendToDM = true } label: {
                    Label(L10n.CloudDocs.directMessageAction, systemImage: "paperplane")
                }
                Button { requestFullEditor() } label: {
                    Label(L10n.TabData.openFullEditor, systemImage: "safari")
                }
            } label: {
                Image(systemName: "ellipsis.circle").font(.tt.iconSubtitle)
            }
            .accessibilityLabel(L10n.Common.more)
        }
    }

    private var saveStateBadge: some View {
        Label(saveStateText, systemImage: saveStateIcon)
            .font(.tt.metaMedium)
            .foregroundStyle(saveStateColor)
            .labelStyle(.titleAndIcon)
            .accessibilityLabel(saveStateText)
    }

    private var saveStateText: String {
        switch session.saveState {
        case .idle: L10n.TabDoc.saveIdle
        case .dirty: L10n.TabDoc.saveDirty
        case .saving: L10n.TabDoc.saving
        case .saved: L10n.TabDoc.saved
        case .conflict: L10n.TabData.saveConflictShort
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

    private var directMessageTarget: CloudResourceDMSendTarget {
        CloudResourceDMSendTarget(
            resourceType: .table,
            resourceId: tableId,
            title: displayTitle,
            organizationId: session.table?.organizationId ?? organizationId,
            spaceId: spaceId,
            currentUserRole: session.table?.currentUserRole
        )
    }

    private func requestFullEditor() {
        guard session.validateSession() else { return }
        switch NativeTabDataFullEditorPolicy.preparation(
            hasDirtyDrafts: session.hasDirtyDrafts,
            saveState: session.saveState
        ) {
        case .open:
            showsFullEditor = true
        case .confirmDiscard:
            showsFullEditorDraftWarning = true
        case .waitForSave:
            showsFullEditorSavingWarning = true
        }
    }

    private func deferFullEditorUntilDetailDismisses() {
        opensFullEditorAfterDetailDismiss = true
    }

    private func completeDeferredFullEditorHandoff() {
        guard opensFullEditorAfterDetailDismiss else { return }
        opensFullEditorAfterDetailDismiss = false
        requestFullEditor()
    }

    private func viewIcon(_ viewType: String) -> String {
        switch viewType.lowercased() {
        case "kanban": "rectangle.3.group"
        case "gallery": "square.grid.2x2"
        case "calendar": "calendar"
        case "form": "list.clipboard"
        case "flashcard": "rectangle.portrait.on.rectangle.portrait"
        case "pivot": "chart.bar.xaxis"
        default: "rectangle.stack"
        }
    }

    private func groupColor(_ value: String?) -> Color {
        guard let value, !value.isEmpty else { return .tt.textTertiary }
        return Color(hex: value)
    }
}

private struct NativeTabDataCard: View {
    let record: NativeTabDataRecord
    let fields: [NativeTabDataField]
    let view: NativeTabDataView?
    let directory: NativeTabDataMemberDirectory
    let onOpen: () -> Void

    var body: some View {
        let projection = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: view,
            directory: directory
        )
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 0) {
                if let coverUrl = projection.coverUrl, let url = URL(string: coverUrl) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        default:
                            Color.tt.bgSubtle
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 120, maxHeight: 190)
                    .clipped()
                    .accessibilityHidden(true)
                }
                cardBody(projection)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.tt.bgSubtleSecondary)
            .clipShape(RoundedRectangle(cornerRadius: TTRadius.md))
        }
        .buttonStyle(.plain)
        .accessibilityHint(L10n.TabData.recordTitle)
    }

    @ViewBuilder
    private func cardBody(_ projection: NativeTabDataCardProjection) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            HStack(alignment: .firstTextBaseline, spacing: TTSpacing.sm) {
                Text(projection.title)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
                Spacer(minLength: TTSpacing.sm)
                Image(systemName: "chevron.right")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(.tt.textTertiary)
            }
            if let group = projection.group {
                Text(group)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textAccent)
                    .padding(.horizontal, TTSpacing.sm)
                    .padding(.vertical, TTSpacing.xs)
                    .background(.tt.bgSubtleSecondary, in: Capsule())
            }
            ForEach(projection.fields) { field in
                HStack(alignment: .top, spacing: TTSpacing.md) {
                    Text(field.label)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .frame(width: TTSpacing.huge + TTSpacing.lg, alignment: .leading)
                        .lineLimit(1)
                    if field.members.isEmpty {
                        Text(field.value)
                            .font(.tt.body)
                            .foregroundStyle(.tt.textSecondary)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                    } else {
                        NativeTabDataMemberChips(members: field.members, avatarSize: 20, compact: true)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NativeTabDataLocalDraftRecoveryScreen: View {
    let draft: NativeTabDataLocalDraftSnapshot

    @Environment(\.dismiss) private var dismiss
    @State private var didCopy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    Label(L10n.TabData.localDraftReadOnly, systemImage: "lock.fill")
                        .font(.tt.subtitleSemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Text(L10n.TabData.localDraftMessage)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                }

                ForEach(draft.fields) { field in
                    VStack(alignment: .leading, spacing: TTSpacing.xs) {
                        Text(field.label)
                            .font(.tt.metaMedium)
                            .foregroundStyle(.tt.textTertiary)
                        Text(field.value.isEmpty ? L10n.TabData.noValue : field.value)
                            .font(.tt.body)
                            .foregroundStyle(.tt.textPrimary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(TTSpacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
                }

                Button {
                    UIPasteboard.general.string = draft.copyText
                    didCopy = true
                } label: {
                    Label(
                        didCopy ? L10n.TabData.localDraftCopied : L10n.TabData.localDraftCopy,
                        systemImage: didCopy ? "checkmark" : "doc.on.doc"
                    )
                    .font(.tt.bodyMedium)
                    .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget)
                }
                .buttonStyle(.borderedProminent)
                .disabled(draft.copyText.isEmpty)
            }
            .padding(TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(draft.isCreation ? L10n.TabData.localDraftNewRecord : L10n.TabData.localDraftRecord)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(L10n.Common.close) { dismiss() }
            }
        }
    }
}

private struct NativeTabDataRecordDetailScreen: View {
    enum Mode {
        case existing
        case creating
    }

    let session: NativeTabDataSession
    let record: NativeTabDataRecord
    let mode: Mode
    let onOpenFullEditor: () -> Void
    var onOpenRecord: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var confirmsDelete = false
    @State private var showsFullEditorDraftActions = false
    @State private var showsFullEditorSavingWarning = false
    @State private var showsNeighborDraftActions = false
    @State private var pendingNeighborId: String?
    @State private var surfacedError: String?

    var body: some View {
        Group {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: TTSpacing.xxl) {
                    recordHeader(displayedRecord)
                    VStack(alignment: .leading, spacing: TTSpacing.xl) {
                        ForEach(session.visibleFields) { field in
                            NativeTabDataFieldEditor(
                                field: field,
                                value: session.value(record: displayedRecord, field: field),
                                raw: displayedRecord.fields[field.id] ?? displayedRecord.fields[field.name],
                                directory: session.memberDirectory,
                                canEdit: session.canEdit && field.fieldType.isEditable,
                                searchMembers: { search, offset in
                                    try await session.searchOrganizationMembers(search: search, offset: offset)
                                },
                                onChange: { session.updateDraft(record: displayedRecord, field: field, value: $0) }
                            )
                        }
                    }
                }
                .padding(TTSpacing.lg)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: TTSpacing.sm) {
                    neighborBar
                    if session.canEdit { saveBar(displayedRecord) }
                }
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(L10n.TabData.recordTitle)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(L10n.Common.close) { dismiss() }
            }
            if session.canEdit, mode == .existing {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) { confirmsDelete = true } label: {
                        Image(systemName: "trash").font(.tt.iconBody)
                    }
                    .accessibilityLabel(L10n.TabData.deleteRecord)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: requestFullEditor) {
                    Image(systemName: "safari").font(.tt.iconBody)
                }
                .accessibilityLabel(L10n.TabData.openFullEditor)
            }
        }
        .confirmationDialog(L10n.TabData.deleteTitle, isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button(L10n.TabData.deleteRecord, role: .destructive) {
                Task { if await session.delete(record: record) { dismiss() } }
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.TabData.deleteMessage)
        }
        .confirmationDialog(
            L10n.TabData.fullEditorBlockedTitle,
            isPresented: $showsFullEditorDraftActions,
            titleVisibility: .visible
        ) {
            if canSaveCurrentDraftBeforeOpening {
                Button(L10n.TabData.fullEditorSaveAndOpen) {
                    Task { await saveCurrentDraftAndOpen() }
                }
            }
            Button(L10n.TabData.fullEditorDiscardAndOpen, role: .destructive) {
                guard session.discardAllDrafts() else { return }
                openFullEditorAfterDismiss()
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.TabData.fullEditorBlockedMessage)
        }
        .alert(L10n.TabData.fullEditorSavingTitle, isPresented: $showsFullEditorSavingWarning) {
            Button(L10n.Common.confirm, role: .cancel) {}
        } message: {
            Text(L10n.TabData.fullEditorSavingMessage)
        }
        .confirmationDialog(
            L10n.TabData.saveFailedTitle,
            isPresented: $showsNeighborDraftActions,
            titleVisibility: .visible
        ) {
            if session.draft(for: displayedRecord).canSubmit, session.canEdit {
                Button(L10n.TabData.save) {
                    Task { await saveCurrentDraftAndOpenNeighbor() }
                }
            }
            Button(L10n.TabData.discardAndContinue, role: .destructive) {
                session.discardDraft(for: displayedRecord)
                openPendingNeighbor()
            }
            Button(L10n.Common.cancel, role: .cancel) { pendingNeighborId = nil }
        }
        .onChange(of: session.saveError) { _, error in surfacedError = error }
        .alert(
            L10n.TabData.saveFailedTitle,
            isPresented: Binding(get: { surfacedError != nil }, set: { if !$0 { surfacedError = nil } })
        ) {
            Button(L10n.Common.confirm, role: .cancel) { surfacedError = nil }
        } message: {
            Text(surfacedError ?? "")
        }
    }

    private var displayedRecord: NativeTabDataRecord {
        session.record(id: record.id) ?? record
    }

    private func recordHeader(_ record: NativeTabDataRecord) -> some View {
        let projection = NativeTabDataCardProjection.make(
            record: record,
            fields: session.fields,
            view: session.selectedView,
            directory: session.memberDirectory
        )
        return Text(projection.title)
            .font(.tt.titleSemibold)
            .foregroundStyle(.tt.textPrimary)
    }

    private func saveBar(_ record: NativeTabDataRecord) -> some View {
        Button {
            Task {
                let succeeded: Bool
                switch mode {
                case .existing:
                    succeeded = await session.save(record: record)
                case .creating:
                    succeeded = await session.create(record: record) != nil
                }
                if succeeded { dismiss() }
            }
        } label: {
            if session.saveState == .saving {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget)
            } else {
                Label(L10n.TabData.save, systemImage: "checkmark")
                    .font(.tt.bodyMedium)
                    .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(
            !session.draft(for: record).canSubmit
                || session.saveState == .saving
                || session.saveState == .conflict
        )
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.sm)
        .background(.thinMaterial)
    }

    private var neighbor: NativeTabDataRecordNeighbor {
        NativeTabDataRecordNavigationPolicy.neighbors(
            recordIds: session.visibleRecordIds,
            currentId: displayedRecord.id
        )
    }

    private var neighborBar: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: TTSpacing.md) {
                neighborButton(
                    title: L10n.TabData.previousRecord,
                    enabled: neighbor.previousId != nil && session.saveState != .saving
                ) {
                    requestNeighbor(neighbor.previousId)
                }
                neighborButton(
                    title: L10n.TabData.nextRecord,
                    enabled: neighbor.nextId != nil && session.saveState != .saving
                ) {
                    requestNeighbor(neighbor.nextId)
                }
            }
            .padding(.horizontal, TTSpacing.lg)
            .padding(.vertical, TTSpacing.sm)
        }
        .background(.tt.bgCanvasDefault)
    }

    private func neighborButton(
        title: String,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.tt.bodyMedium)
                .foregroundStyle(enabled ? Color.tt.textPrimary : Color.tt.textSecondary)
                .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget)
        }
        .buttonStyle(.plain)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        .overlay {
            RoundedRectangle(cornerRadius: TTRadius.interactive)
                .strokeBorder(Color.tt.borderInteractive, lineWidth: 1)
        }
        .disabled(!enabled)
        .accessibilityLabel(title)
    }

    private func requestNeighbor(_ recordId: String?) {
        guard let recordId else { return }
        guard session.validateSession() else { return }
        if session.draft(for: displayedRecord).canSubmit {
            pendingNeighborId = recordId
            showsNeighborDraftActions = true
            return
        }
        onOpenRecord(recordId)
    }

    private func saveCurrentDraftAndOpenNeighbor() async {
        let succeeded: Bool
        switch mode {
        case .existing:
            succeeded = await session.save(record: displayedRecord)
        case .creating:
            succeeded = await session.create(record: displayedRecord) != nil
        }
        if succeeded { openPendingNeighbor() }
    }

    private func openPendingNeighbor() {
        guard let pendingNeighborId else { return }
        self.pendingNeighborId = nil
        onOpenRecord(pendingNeighborId)
    }

    private var canSaveCurrentDraftBeforeOpening: Bool {
        NativeTabDataFullEditorPolicy.canSaveCurrentDraft(
            hasDirtyFields: session.draft(for: record).canSubmit,
            canEdit: session.canEdit,
            saveState: session.saveState
        )
    }

    private func requestFullEditor() {
        guard session.validateSession() else { return }
        switch NativeTabDataFullEditorPolicy.preparation(
            hasDirtyDrafts: session.hasDirtyDrafts,
            saveState: session.saveState
        ) {
        case .open:
            openFullEditorAfterDismiss()
        case .confirmDiscard:
            showsFullEditorDraftActions = true
        case .waitForSave:
            showsFullEditorSavingWarning = true
        }
    }

    private func saveCurrentDraftAndOpen() async {
        guard session.validateSession() else { return }
        let succeeded: Bool
        switch mode {
        case .existing:
            succeeded = await session.save(record: record)
        case .creating:
            succeeded = await session.create(record: record) != nil
        }
        guard succeeded, session.validateSession() else { return }
        openFullEditorAfterDismiss()
    }

    private func openFullEditorAfterDismiss() {
        guard session.validateSession() else { return }
        onOpenFullEditor()
        dismiss()
    }
}

private struct NativeTabDataFieldEditor: View {
    let field: NativeTabDataField
    let value: NativeTabDataValue
    let raw: AnyCodable?
    let directory: NativeTabDataMemberDirectory
    let canEdit: Bool
    var searchMembers: ((String, Int) async throws -> (members: [NativeTabDataDirectoryMember], total: Int))? = nil
    let onChange: (NativeTabDataValue) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(spacing: TTSpacing.xs) {
                Text(field.name)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textPrimary)
                Spacer()
                if !canEdit {
                    Text(L10n.TabData.readOnlyField)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
            editor
        }
    }

    @ViewBuilder
    private var editor: some View {
        switch (field.fieldType, value) {
        case (.checkbox, .boolean(let checked)):
            Toggle(isOn: Binding(get: { checked }, set: { onChange(.boolean($0)) })) {
                Text(checked ? "✓" : L10n.TabData.noValue).font(.tt.body)
            }
            .disabled(!canEdit)
            .padding(.horizontal, TTSpacing.md)
            .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        case (.select, .selections(let selected)), (.singleSelect, .selections(let selected)):
            NativeTabDataChoiceEditor(
                field: field,
                selected: selected,
                multiple: false,
                canEdit: canEdit,
                onChange: onChange
            )
        case (.multiSelect, .selections(let selected)):
            NativeTabDataChoiceEditor(
                field: field,
                selected: selected,
                multiple: true,
                canEdit: canEdit,
                onChange: onChange
            )
        case (.date, .date(let date)):
            if canEdit {
                DatePicker(
                    field.name,
                    selection: Binding(get: { date ?? Date() }, set: { onChange(.date($0)) }),
                    displayedComponents: [.date]
                )
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, TTSpacing.md)
                .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
            } else {
                valueRow(value.displayText)
            }
        case (.user, _):
            NativeTabDataMemberEditor(
                field: field,
                selected: selectedUserIds,
                raw: raw,
                directory: directory,
                canEdit: canEdit,
                searchMembers: searchMembers,
                onChange: onChange
            )
        case (.createdBy, _), (.lastModifiedBy, _):
            NativeTabDataMemberValueRow(
                members: field.resolvedMembers(from: raw, value: value, directory: directory),
                canEdit: canEdit
            )
        case (.percent, .number(let number)):
            NativeTabDataPercentEditor(storedRatioRaw: number, canEdit: canEdit) { onChange(.number($0)) }
        case (.currency, .number(let number)):
            NativeTabDataCurrencyEditor(
                storedRaw: number,
                symbol: NativeTabDataNumberFormatPolicy.currencySymbol(field.options),
                precision: NativeTabDataNumberFormatPolicy.currencyPrecision(field.options),
                canEdit: canEdit
            ) { onChange(.number($0)) }
        case (.rating, .number(let number)):
            NativeTabDataRatingEditor(
                storedRaw: number,
                max: NativeTabDataNumberFormatPolicy.ratingMax(field.options),
                canEdit: canEdit
            ) { onChange(.number($0)) }
        case (.number, .number(let number)):
            TextField(
                L10n.TabData.noValue,
                text: Binding(get: { number }, set: { onChange(.number($0)) })
            )
            .keyboardType(.decimalPad)
            .font(.tt.body)
            .disabled(!canEdit)
            .padding(.horizontal, TTSpacing.md)
            .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        case (_, .text(let text)) where field.fieldType.isLongText:
            TextField(
                L10n.TabData.noValue,
                text: Binding(get: { text }, set: { onChange(.text($0)) }),
                axis: .vertical
            )
            .lineLimit(3...8)
            .font(.tt.body)
            .disabled(!canEdit)
            .padding(TTSpacing.md)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        case (_, .text(let text)):
            TextField(L10n.TabData.noValue, text: Binding(get: { text }, set: { onChange(.text($0)) }))
                .font(.tt.body)
                .disabled(!canEdit)
                .keyboardType(keyboardType)
                .textInputAutocapitalization(field.fieldType == .email || field.fieldType == .url ? .never : .sentences)
                .autocorrectionDisabled(field.fieldType == .email || field.fieldType == .url)
                .padding(.horizontal, TTSpacing.md)
                .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        default:
            valueRow(value.displayText)
        }
    }

    private func valueRow(_ text: String) -> some View {
        HStack {
            Text(text.isEmpty ? L10n.TabData.noValue : text)
                .font(.tt.body)
                .foregroundStyle(text.isEmpty ? .tt.textTertiary : .tt.textPrimary)
                .multilineTextAlignment(.leading)
            Spacer()
            if canEdit { Image(systemName: "chevron.up.chevron.down").font(.tt.iconCaption).foregroundStyle(.tt.textTertiary) }
        }
        .padding(.horizontal, TTSpacing.md)
        .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
    }

    private var keyboardType: UIKeyboardType {
        switch field.fieldType {
        case .email: .emailAddress
        case .phone: .phonePad
        case .url: .URL
        default: .default
        }
    }

    private var selectedUserIds: [String] {
        if case .selections(let ids) = value { return ids }
        return field.resolvedMembers(from: raw, value: value, directory: directory)
            .map(\.userId)
            .filter { !$0.isEmpty }
    }
}

/// 人员字段原生编辑器：折叠行对齐选项 chip + `+N`；点开后是可搜索的成员列表。
private struct NativeTabDataMemberEditor: View {
    let field: NativeTabDataField
    let selected: [String]
    let raw: AnyCodable?
    let directory: NativeTabDataMemberDirectory
    let canEdit: Bool
    let searchMembers: ((String, Int) async throws -> (members: [NativeTabDataDirectoryMember], total: Int))?
    let onChange: (NativeTabDataValue) -> Void

    @State private var showsPicker = false

    private var selectedMembers: [NativeTabDataMemberRef] {
        NativeTabDataMemberPickerPolicy.resolveSelected(
            ids: selected,
            raw: raw,
            directory: directory
        )
    }

    var body: some View {
        Button {
            if canEdit { showsPicker = true }
        } label: {
            memberValueRow
        }
        .disabled(!canEdit)
        .popover(isPresented: $showsPicker) {
            NavigationStack {
                NativeTabDataMemberPicker(
                    fieldName: field.name,
                    selected: selected,
                    selectedMembers: selectedMembers,
                    multiple: field.allowsMultipleUsers,
                    directory: directory,
                    searchMembers: searchMembers,
                    onChange: onChange,
                    onClose: { showsPicker = false }
                )
            }
            .presentationCompactAdaptation(.sheet)
            .presentationDetents([.medium, .large])
        }
    }

    private var memberValueRow: some View {
        HStack(spacing: TTSpacing.sm) {
            Group {
                if selectedMembers.isEmpty {
                    Text(L10n.TabData.selectNone)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textTertiary)
                } else if selectedMembers.count == 1, let member = selectedMembers.first {
                    NativeTabDataMemberChip(member: member)
                } else {
                    NativeTabDataMemberOverflowRow(members: selectedMembers)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
            if canEdit {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
        .padding(.horizontal, TTSpacing.md)
        .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
    }
}

private struct NativeTabDataMemberPicker: View {
    let fieldName: String
    let selected: [String]
    let selectedMembers: [NativeTabDataMemberRef]
    let multiple: Bool
    let directory: NativeTabDataMemberDirectory
    let searchMembers: ((String, Int) async throws -> (members: [NativeTabDataDirectoryMember], total: Int))?
    let onChange: (NativeTabDataValue) -> Void
    let onClose: () -> Void

    @State private var searchText = ""
    @State private var results: [NativeTabDataDirectoryMember] = []
    @State private var total = 0
    @State private var isLoading = false
    @State private var searchGeneration = 0
    /// 加载更多失败后停住自动请求，避免触底锚点反复重试；换搜索词或重开选择器才恢复。
    @State private var loadFailed = false

    var body: some View {
        List {
            if !selectedMembers.isEmpty {
                Section {
                    NativeTabDataMemberOverflowRow(
                        members: selectedMembers,
                        onRemove: { applyToggle($0) }
                    )
                    .listRowInsets(EdgeInsets(
                        top: TTSpacing.sm,
                        leading: TTSpacing.md,
                        bottom: TTSpacing.sm,
                        trailing: TTSpacing.md
                    ))
                }
            }
            if !multiple {
                Button(L10n.TabData.selectNone) {
                    onChange(.selections([]))
                    onClose()
                }
            }
            if loadFailed {
                Text(L10n.TabData.memberLoadFailed)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textTertiary)
            } else if results.isEmpty, !isLoading {
                Text(searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                     ? L10n.TabData.memberEmpty
                     : L10n.TabData.memberNoMatch)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textTertiary)
            }
            ForEach(results, id: \.userId) { member in
                Button {
                    applyToggle(member.userId)
                    if !multiple { onClose() }
                } label: {
                    HStack(spacing: TTSpacing.sm) {
                        NativeTabDataMemberAvatar(
                            member: NativeTabDataMemberRef(
                                userId: member.userId,
                                displayName: member.displayName,
                                avatarUrl: member.avatarUrl,
                                kind: .member
                            ),
                            size: 28
                        )
                        Text(member.displayName)
                            .font(.tt.body)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)
                        Spacer()
                        if selected.contains(member.userId) {
                            Image(systemName: "checkmark")
                                .font(.tt.iconCaption)
                                .foregroundStyle(.tt.textPrimary)
                        }
                    }
                    .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                }
            }
            if canLoadMore {
                HStack(spacing: TTSpacing.sm) {
                    ProgressView()
                    Text(L10n.TabData.memberLoadingMore)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .onAppear {
                    Task { await load(reset: false) }
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $searchText, prompt: L10n.TabData.memberSearchPlaceholder)
        .navigationTitle(fieldName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(L10n.Common.close, action: onClose)
            }
        }
        .task(id: searchText) {
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled else { return }
            await load(reset: true)
        }
    }

    private var canLoadMore: Bool {
        !results.isEmpty && results.count < total && !isLoading && !loadFailed
    }

    private func applyToggle(_ userId: String) {
        onChange(.selections(NativeTabDataMemberPickerPolicy.toggle(
            selected: selected,
            userId: userId,
            multiple: multiple
        )))
    }

    private func load(reset: Bool) async {
        guard let searchMembers else { return }
        let generation = searchGeneration + 1
        searchGeneration = generation
        isLoading = true
        if reset { loadFailed = false }
        let offset = reset ? 0 : results.count
        do {
            let page = try await searchMembers(searchText, offset)
            guard generation == searchGeneration else { return }
            if reset {
                results = page.members
            } else {
                let seen = Set(results.map(\.userId))
                results.append(contentsOf: page.members.filter { !seen.contains($0.userId) })
            }
            total = page.total
        } catch {
            guard generation == searchGeneration else { return }
            // 保留已加载结果：清空会让「加载失败」看起来像「组织里没有这个人」。
            loadFailed = true
        }
        isLoading = false
    }
}

private struct NativeTabDataMemberChip: View {
    let member: NativeTabDataMemberRef
    var onRemove: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            NativeTabDataMemberAvatar(member: member, size: 18)
            Text(member.displayName)
                .font(.tt.caption)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.TabData.memberRemove)
            }
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xxs)
        .background(.tt.bgCanvasDefault, in: Capsule())
    }
}

private struct NativeTabDataMemberOverflowRow: View {
    let members: [NativeTabDataMemberRef]
    var onRemove: ((String) -> Void)? = nil

    var body: some View {
        NativeTabDataChoiceOverflowLayout(chipCount: members.count, spacing: TTSpacing.xs) {
            ForEach(members) { member in
                NativeTabDataMemberChip(
                    member: member,
                    onRemove: onRemove.map { remove in { remove(member.userId) } }
                )
            }
            ForEach(1...max(members.count, 1), id: \.self) { hidden in
                NativeTabDataChoiceOverflowMark(count: hidden)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NativeTabDataMemberValueRow: View {
    let members: [NativeTabDataMemberRef]
    let canEdit: Bool

    var body: some View {
        HStack(alignment: .top) {
            NativeTabDataMemberChips(members: members, avatarSize: 24, compact: false)
            Spacer(minLength: 0)
            if canEdit {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
    }
}

private struct NativeTabDataMemberChips: View {
    let members: [NativeTabDataMemberRef]
    var avatarSize: CGFloat = 20
    var compact: Bool = false

    var body: some View {
        if members.isEmpty {
            Text(L10n.TabData.noValue)
                .font(.tt.body)
                .foregroundStyle(.tt.textTertiary)
        } else {
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                ForEach(members) { member in
                    HStack(spacing: TTSpacing.sm) {
                        NativeTabDataMemberAvatar(member: member, size: avatarSize)
                        Text(member.displayName)
                            .font(.tt.body)
                            .foregroundStyle(compact ? .tt.textSecondary : .tt.textPrimary)
                            .lineLimit(compact ? 1 : 2)
                    }
                }
            }
        }
    }
}

private struct NativeTabDataMemberAvatar: View {
    let member: NativeTabDataMemberRef
    var size: CGFloat

    var body: some View {
        if let url = member.avatarURL {
            KFImage(url)
                .placeholder { fallback }
                .onFailureView { fallback }
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(Circle())
        } else {
            fallback
        }
    }

    private var fallback: some View {
        IdentityColorAvatar(
            name: member.displayName,
            seed: IdentityAvatar.colorSeed(member.userId, fallbackName: member.displayName),
            size: size
        )
    }
}

/// 折叠行对齐原 `valueRow`；展开不用 SwiftUI `Menu`，因为它只能放 Text/Image，画不出彩色 chip。
/// iPad 用 popover 对齐 Web；iPhone 上 popover 会挤，所以 compact 适配成 sheet，方便多选连续勾选。
private struct NativeTabDataChoiceEditor: View {
    let field: NativeTabDataField
    let selected: [String]
    let multiple: Bool
    let canEdit: Bool
    let onChange: (NativeTabDataValue) -> Void

    @State private var showsPicker = false

    private var selectedOptions: [NativeTabDataSelectOption] {
        selected.compactMap { value in
            field.selectOptions.first { $0.value == value }
                ?? NativeTabDataSelectOption(value: value, label: value, color: nil)
        }
    }

    var body: some View {
        Button {
            if canEdit { showsPicker = true }
        } label: {
            choiceValueRow
        }
        .disabled(!canEdit)
        .popover(isPresented: $showsPicker) {
            NavigationStack {
                choicePicker
                    .navigationTitle(field.name)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(L10n.Common.close) { showsPicker = false }
                        }
                    }
            }
            .presentationCompactAdaptation(.sheet)
            .presentationDetents([.medium, .large])
        }
    }

    private var choiceValueRow: some View {
        HStack(spacing: TTSpacing.sm) {
            Group {
                if selectedOptions.isEmpty {
                    Text(L10n.TabData.selectNone)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textTertiary)
                } else if selectedOptions.count == 1, let option = selectedOptions.first {
                    NativeTabDataChoiceChip(
                        label: option.label,
                        color: option.color,
                        value: option.value
                    )
                } else {
                    NativeTabDataChoiceOverflowRow(options: selectedOptions)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
            if canEdit {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
        .padding(.horizontal, TTSpacing.md)
        .frame(maxWidth: .infinity, minHeight: TTSpacing.Control.minimumTouchTarget, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
    }

    private var choicePicker: some View {
        List {
            if !multiple {
                Button(L10n.TabData.selectNone) {
                    onChange(.selections([]))
                    showsPicker = false
                }
            }
            ForEach(field.selectOptions) { option in
                Button {
                    toggle(option)
                    if !multiple { showsPicker = false }
                } label: {
                    HStack(spacing: TTSpacing.sm) {
                        NativeTabDataChoiceChip(
                            label: option.label,
                            color: option.color,
                            value: option.value
                        )
                        Spacer()
                        if selected.contains(option.value) {
                            Image(systemName: "checkmark")
                                .font(.tt.iconCaption)
                                .foregroundStyle(.tt.textPrimary)
                        }
                    }
                    .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                }
            }
        }
        .listStyle(.plain)
    }

    private func toggle(_ option: NativeTabDataSelectOption) {
        if multiple {
            var values = selected
            if let index = values.firstIndex(of: option.value) {
                values.remove(at: index)
            } else {
                values.append(option.value)
            }
            onChange(.selections(values))
        } else {
            onChange(.selections([option.value]))
        }
    }
}

private struct NativeTabDataChoiceChip: View {
    let label: String
    let color: String?
    let value: String

    var body: some View {
        let colors = NativeTabDataChoiceColorPolicy.resolve(color: color, value: value)
        Text(label)
            .font(.tt.caption)
            .foregroundStyle(colors.foreground)
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xxs)
            .background(colors.background, in: Capsule())
    }
}

/// 折叠行按可用宽度决定露出几个 chip，放不下的收成中性 `+N`。不硬编码个数。
enum NativeTabDataChoiceOverflow {
    static func visibleCount(
        chipWidths: [CGFloat],
        overflowWidth: CGFloat,
        spacing: CGFloat,
        availableWidth: CGFloat
    ) -> Int {
        guard !chipWidths.isEmpty else { return 0 }
        guard availableWidth.isFinite, availableWidth > 0 else { return chipWidths.count }
        var all: CGFloat = 0
        for (index, width) in chipWidths.enumerated() {
            if index > 0 { all += spacing }
            all += width
        }
        if all <= availableWidth { return chipWidths.count }
        var used: CGFloat = 0
        var count = 0
        for width in chipWidths {
            let gap: CGFloat = count > 0 ? spacing : 0
            if used + gap + width + spacing + overflowWidth > availableWidth { break }
            used += gap + width
            count += 1
        }
        return count
    }
}

private struct NativeTabDataChoiceOverflowRow: View {
    let options: [NativeTabDataSelectOption]

    var body: some View {
        NativeTabDataChoiceOverflowLayout(chipCount: options.count, spacing: TTSpacing.xs) {
            ForEach(options) { option in
                NativeTabDataChoiceChip(
                    label: option.label,
                    color: option.color,
                    value: option.value
                )
            }
            ForEach(1...options.count, id: \.self) { hidden in
                NativeTabDataChoiceOverflowMark(count: hidden)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 按可用宽度放置 chip；放不下的用最后一组 `+N` 子视图，N 为实际隐藏个数。
private struct NativeTabDataChoiceOverflowLayout: Layout {
    let chipCount: Int
    var spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let placement = placement(in: proposal.width ?? 0, subviews: subviews)
        return CGSize(width: proposal.width ?? placement.width, height: placement.height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let placement = placement(in: bounds.width, subviews: subviews)
        var x = bounds.minX
        for (index, subview) in subviews.enumerated() {
            if placement.visibleIndices.contains(index) {
                let size = subview.sizeThatFits(.unspecified)
                subview.place(
                    at: CGPoint(x: x, y: bounds.minY + (placement.height - size.height) / 2),
                    proposal: ProposedViewSize(size)
                )
                x += size.width + spacing
            } else {
                subview.place(at: bounds.origin, proposal: .zero)
            }
        }
    }

    private func placement(in availableWidth: CGFloat, subviews: Subviews) -> (
        visibleIndices: Set<Int>,
        width: CGFloat,
        height: CGFloat
    ) {
        let chips = Array(subviews.prefix(chipCount))
        let overflows = Array(subviews.dropFirst(chipCount))
        let chipSizes = chips.map { $0.sizeThatFits(.unspecified) }
        let overflowProbe = overflows.last?.sizeThatFits(.unspecified) ?? .zero
        let visible = NativeTabDataChoiceOverflow.visibleCount(
            chipWidths: chipSizes.map(\.width),
            overflowWidth: overflowProbe.width,
            spacing: spacing,
            availableWidth: availableWidth
        )
        let hidden = chipCount - visible
        var indices = Set(0..<visible)
        var width: CGFloat = 0
        var height: CGFloat = 0
        for index in 0..<visible {
            if index > 0 { width += spacing }
            width += chipSizes[index].width
            height = max(height, chipSizes[index].height)
        }
        if hidden > 0, hidden - 1 < overflows.count {
            let overflowIndex = chipCount + hidden - 1
            indices.insert(overflowIndex)
            let overflowSize = overflows[hidden - 1].sizeThatFits(.unspecified)
            if visible > 0 { width += spacing }
            width += overflowSize.width
            height = max(height, overflowSize.height)
        }
        return (indices, width, max(height, overflowProbe.height))
    }
}

/// 保存成功但字段被他人改过时的轻提示：自动消失，不拦操作。
private struct NativeTabDataNoticeToast: View {
    let message: String

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.textWarning)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .strokeBorder(.tt.bgWarning.opacity(0.25), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.12), radius: 16, x: 0, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }
}

private struct NativeTabDataChoiceOverflowMark: View {
    let count: Int

    var body: some View {
        Text(L10n.TabData.selectMore(count))
            .font(.tt.caption)
            .foregroundStyle(.tt.textSecondary)
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xxs)
            .background(.tt.bgSubtle, in: Capsule())
    }
}

/// 详情编辑显示百分点数（`0.85` → `85`），提交时本地 `/100` 成比值。
/// 中间态只留在输入框，不写进草稿，避免把 `8.` 提前存成 8。
private struct NativeTabDataPercentEditor: View {
    let storedRatioRaw: String
    let canEdit: Bool
    let onCommit: (String) -> Void

    @State private var typed: String?

    private var displayed: String {
        typed
            ?? NativeTabDataNumberFormatPolicy.formatPercentEditorPoints(storedRatioRaw)
            ?? storedRatioRaw
    }

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            TextField(
                L10n.TabData.noValue,
                text: Binding(
                    get: { displayed },
                    set: { newValue in
                        typed = newValue
                        switch NativeTabDataNumberFormatPolicy.commitPercentEditor(
                            typed: newValue,
                            storedRatioRaw: storedRatioRaw
                        ) {
                        case .empty:
                            onCommit("")
                        case .ratio(let raw):
                            onCommit(raw)
                        case .intermediate:
                            break
                        }
                    }
                )
            )
            .keyboardType(.decimalPad)
            .font(.tt.body)
            .disabled(!canEdit)
            Text(L10n.TabData.percentSuffix)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, TTSpacing.md)
        .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        .onChange(of: storedRatioRaw) { _, _ in
            typed = nil
        }
    }
}

/// 符号在框外，框里只收数字；失焦后按精度回显，提交仍写纯数值。
private struct NativeTabDataCurrencyEditor: View {
    let storedRaw: String
    let symbol: String
    let precision: Int
    let canEdit: Bool
    let onCommit: (String) -> Void

    @State private var typed: String?
    @FocusState private var focused: Bool

    private var displayed: String {
        if focused || typed != nil {
            return typed ?? storedRaw
        }
        return NativeTabDataNumberFormatPolicy.formatCurrency(
            storedRaw,
            symbol: "",
            precision: precision
        ) ?? storedRaw
    }

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            Text(symbol)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .accessibilityHidden(true)
            TextField(
                L10n.TabData.noValue,
                text: Binding(
                    get: { displayed },
                    set: { newValue in
                        typed = newValue
                        let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                        if trimmed.isEmpty {
                            onCommit("")
                            return
                        }
                        if trimmed == "-" || trimmed == "+" || trimmed == "."
                            || trimmed == "-." || trimmed == "+." || trimmed.hasSuffix(".") {
                            return
                        }
                        if Double(trimmed) != nil {
                            onCommit(trimmed)
                        }
                    }
                )
            )
            .keyboardType(.decimalPad)
            .font(.tt.body)
            .disabled(!canEdit)
            .focused($focused)
        }
        .padding(.horizontal, TTSpacing.md)
        .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        .onChange(of: storedRaw) { _, _ in
            typed = nil
        }
        .onChange(of: focused) { _, isFocused in
            if !isFocused {
                typed = nil
            }
        }
    }
}

private struct NativeTabDataRatingEditor: View {
    let storedRaw: String
    let max: Int
    let canEdit: Bool
    let onCommit: (String) -> Void

    private var current: Int {
        NativeTabDataNumberFormatPolicy.clampRating(storedRaw, max: max) ?? 0
    }

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            ForEach(1...max, id: \.self) { star in
                Button {
                    onCommit(current == star ? "0" : String(star))
                } label: {
                    Text(star <= current ? "★" : "☆")
                        .font(.tt.subtitle)
                        .foregroundStyle(star <= current ? .tt.textWarning : .tt.textTertiary)
                        .frame(
                            minWidth: TTSpacing.Control.minimumTouchTarget,
                            minHeight: TTSpacing.Control.minimumTouchTarget
                        )
                }
                .buttonStyle(.plain)
                .disabled(!canEdit)
                .accessibilityLabel(L10n.TabData.ratingValue(star, max))
            }
            Spacer(minLength: 0)
        }
    }
}

private struct NativeTabDataCreateFieldSheet: View {
    let session: NativeTabDataSession

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var fieldType: NativeTabDataCreateFieldType = .text
    @State private var choicesText = ""

    private var choices: [String] {
        choicesText.components(separatedBy: .newlines)
    }

    private var request: NativeTabDataCreateFieldRequest {
        NativeTabDataCreateFieldRequest(
            tableId: session.tableId,
            name: name,
            fieldType: fieldType,
            choices: choices
        )
    }

    private var validationMessage: String? {
        guard let error = request.validationError(existingFields: session.fields) else { return nil }
        switch error {
        case .emptyName: return L10n.TabData.fieldNameRequired
        case .nameTooLong: return L10n.TabData.fieldNameTooLong
        case .duplicateName: return L10n.TabData.fieldNameDuplicate
        case .missingChoices: return L10n.TabData.fieldChoicesRequired
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(L10n.TabData.fieldName) {
                    TextField(L10n.TabData.fieldNamePlaceholder, text: $name)
                        .textInputAutocapitalization(.sentences)
                }
                Section(L10n.TabData.fieldType) {
                    Picker(L10n.TabData.fieldType, selection: $fieldType) {
                        ForEach(NativeTabDataCreateFieldType.allCases) { type in
                            Text(type.localizedTitle).tag(type)
                        }
                    }
                    .pickerStyle(.menu)
                }
                if fieldType.requiresChoices {
                    Section {
                        TextField(L10n.TabData.fieldChoices, text: $choicesText, axis: .vertical)
                            .lineLimit(3...8)
                    } footer: {
                        Text(L10n.TabData.fieldChoicesHint)
                    }
                }
                if let message = validationMessage ?? session.fieldCreationError {
                    Section {
                        Text(message)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textCritical)
                    }
                }
            }
            .navigationTitle(L10n.TabData.fieldCreateTitle)
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(session.isCreatingField)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                        .disabled(session.isCreatingField)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(session.isCreatingField ? L10n.TabData.fieldCreating : L10n.TabData.fieldCreate) {
                        Task {
                            if await session.createField(
                                name: name,
                                fieldType: fieldType,
                                choices: choices
                            ) {
                                dismiss()
                            }
                        }
                    }
                    .disabled(validationMessage != nil || session.isCreatingField || !session.canEdit)
                }
            }
        }
    }
}

private extension NativeTabDataCreateFieldType {
    var localizedTitle: String {
        switch self {
        case .text: L10n.TabData.fieldTypeText
        case .longText: L10n.TabData.fieldTypeLongText
        case .number: L10n.TabData.fieldTypeNumber
        case .select: L10n.TabData.fieldTypeSelect
        case .multiSelect: L10n.TabData.fieldTypeMultiSelect
        case .checkbox: L10n.TabData.fieldTypeCheckbox
        }
    }
}

private struct NativeTabDataFilterSheet: View {
    let session: NativeTabDataSession

    @Environment(\.dismiss) private var dismiss
    @State private var fieldId: String
    @State private var operatorName: String
    @State private var value: String

    init(session: NativeTabDataSession) {
        self.session = session
        let fields = Self.filterableFields(in: session.fields)
        let first = fields.first
        _fieldId = State(initialValue: first?.id ?? "")
        _operatorName = State(initialValue: first.map { NativeTabDataFilterQueryPolicy.defaultOperator(for: $0.fieldType) } ?? "equals")
        _value = State(initialValue: first?.fieldType == .checkbox ? "false" : "")
    }

    private var fields: [NativeTabDataField] {
        Self.filterableFields(in: session.fields)
    }

    private var selectedField: NativeTabDataField? {
        fields.first { $0.id == fieldId }
    }

    private var canApplyDraft: Bool {
        guard selectedField != nil else { return false }
        if selectedField?.fieldType == .checkbox { return true }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                if session.filterRules.count > 1 {
                    Picker(L10n.TabData.filterRecords, selection: logicBinding) {
                        Text(L10n.TabData.filterAll).tag(NativeTabDataFilterLogic.and)
                        Text(L10n.TabData.filterAny).tag(NativeTabDataFilterLogic.or)
                    }
                    .pickerStyle(.segmented)
                }
                if !session.filterRules.isEmpty {
                    Section {
                        ForEach(session.filterRules, id: \.fieldId) { rule in
                            HStack {
                                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                                    Text(fieldName(for: rule.fieldId))
                                        .font(.tt.body)
                                    Text(rule.value)
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textSecondary)
                                }
                                Spacer()
                                Button {
                                    Task { await session.removeFilter(fieldId: rule.fieldId) }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.tt.iconBody)
                                        .foregroundStyle(.tt.iconSecondary)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(L10n.TabData.filterRemove)
                            }
                        }
                    }
                }
                Section(L10n.TabData.filterAdd) {
                    Picker(L10n.TabData.filterChooseField, selection: $fieldId) {
                        ForEach(fields) { Text($0.name).tag($0.id) }
                    }
                    if selectedField?.fieldType == .checkbox {
                        Toggle(L10n.TabData.filterChecked, isOn: checkboxBinding)
                    } else {
                        Picker(L10n.TabData.filter, selection: $operatorName) {
                            ForEach(operators, id: \.self) { item in
                                Text(operatorLabel(item)).tag(item)
                            }
                        }
                        if usesChoiceList {
                            ForEach(selectedField?.selectOptions ?? []) { choice in
                                Button {
                                    toggleChoice(choice.value)
                                } label: {
                                    HStack {
                                        Text(choice.label)
                                            .font(.tt.body)
                                            .foregroundStyle(.tt.textPrimary)
                                        Spacer()
                                        if isChoiceSelected(choice.value) {
                                            Image(systemName: "checkmark")
                                                .font(.tt.iconCaption)
                                                .foregroundStyle(.tt.iconAccent)
                                        }
                                    }
                                }
                            }
                        } else {
                            TextField(L10n.TabData.filterValue, text: $value)
                                .keyboardType(valueKeyboard)
                        }
                    }
                    Button(L10n.TabData.filterApply) {
                        applyDraft()
                    }
                    .disabled(!canApplyDraft)
                }
            }
            .navigationTitle(L10n.TabData.filterRecords)
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: fieldId) { _, newId in
                resetDraft(for: fields.first { $0.id == newId })
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !session.filterRules.isEmpty {
                        Button(L10n.TabData.clearFilter) {
                            Task { await session.clearFilters() }
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.Common.close) { dismiss() }
                }
            }
        }
    }

    private var operators: [String] {
        guard let selectedField else { return ["equals"] }
        return NativeTabDataFilterQueryPolicy.operators(for: selectedField.fieldType)
    }

    private var usesChoiceList: Bool {
        guard let selectedField else { return false }
        switch selectedField.fieldType {
        case .select, .singleSelect, .multiSelect:
            return !selectedField.selectOptions.isEmpty
        default:
            return false
        }
    }

    private var valueKeyboard: UIKeyboardType {
        switch selectedField?.fieldType {
        case .number, .currency, .percent, .rating:
            .decimalPad
        default:
            .default
        }
    }

    private var logicBinding: Binding<NativeTabDataFilterLogic> {
        Binding(
            get: { session.filterLogic },
            set: { next in
                Task { await session.setFilterLogic(next) }
            }
        )
    }

    private var checkboxBinding: Binding<Bool> {
        Binding(
            get: { value == "true" },
            set: { value = $0 ? "true" : "false" }
        )
    }

    private func fieldName(for fieldId: String) -> String {
        session.fields.first { $0.id == fieldId }?.name ?? fieldId
    }

    private func operatorLabel(_ operatorName: String) -> String {
        switch operatorName {
        case "contains": L10n.TabData.contains
        case "not_equals": L10n.TabData.filterNotEquals
        case "greater_than": L10n.TabData.filterGreater
        case "less_than": L10n.TabData.filterLess
        default: L10n.TabData.equals
        }
    }

    private func isChoiceSelected(_ choice: String) -> Bool {
        selectedValues.contains(choice)
    }

    private var selectedValues: [String] {
        value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    private func toggleChoice(_ choice: String) {
        guard selectedField?.fieldType == .multiSelect else {
            value = choice
            return
        }
        var values = Set(selectedValues)
        if values.contains(choice) {
            values.remove(choice)
        } else {
            values.insert(choice)
        }
        value = selectedField?.selectOptions
            .map(\.value)
            .filter { values.contains($0) }
            .joined(separator: ",") ?? values.sorted().joined(separator: ",")
    }

    private func applyDraft() {
        guard let field = selectedField else { return }
        let normalized = field.fieldType == .checkbox
            ? (value == "true" ? "true" : "false")
            : value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty || field.fieldType == .checkbox else { return }
        let rule = NativeTabDataFilterRule(
            fieldId: field.id,
            operatorName: field.fieldType == .checkbox ? NativeTabDataFilterQueryPolicy.defaultOperator(for: field.fieldType) : operatorName,
            value: normalized
        )
        Task { await session.addFilter(rule) }
        resetDraft(for: field)
    }

    private func resetDraft(for field: NativeTabDataField?) {
        operatorName = field.map { NativeTabDataFilterQueryPolicy.defaultOperator(for: $0.fieldType) } ?? "equals"
        value = field?.fieldType == .checkbox ? "false" : ""
    }

    private static func filterableFields(in fields: [NativeTabDataField]) -> [NativeTabDataField] {
        fields.filter { NativeTabDataFilterQueryPolicy.isFilterable(fieldType: $0.fieldType, isHidden: $0.isHidden) }
    }
}

private struct NativeTabDataSortSheet: View {
    let fields: [NativeTabDataField]
    let current: NativeTabDataSortRule?
    let onApply: (NativeTabDataSortRule?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var fieldId: String
    @State private var descending: Bool

    init(fields: [NativeTabDataField], current: NativeTabDataSortRule?, onApply: @escaping (NativeTabDataSortRule?) -> Void) {
        self.fields = fields
        self.current = current
        self.onApply = onApply
        _fieldId = State(initialValue: current?.fieldId ?? fields.first?.id ?? "")
        _descending = State(initialValue: current?.descending ?? false)
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker(L10n.TabData.fieldsSection, selection: $fieldId) {
                    ForEach(fields) { Text($0.name).tag($0.id) }
                }
                Picker(L10n.TabData.sort, selection: $descending) {
                    Text(L10n.TabData.ascending).tag(false)
                    Text(L10n.TabData.descending).tag(true)
                }
                .pickerStyle(.segmented)
            }
            .navigationTitle(L10n.TabData.sort)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.TabData.clearSort) { onApply(nil); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.TabData.apply) {
                        onApply(fieldId.isEmpty ? nil : NativeTabDataSortRule(fieldId: fieldId, descending: descending))
                        dismiss()
                    }
                    .disabled(fieldId.isEmpty)
                }
            }
        }
    }
}

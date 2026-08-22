import Foundation
import SwiftUI

/// 任务工作台「文档 / 多维表」App 首页：本地搜索 + 投影展示态，
/// 打开详情仍压入 `navigationState.path`，返回落回本页。
/// 视觉对齐 `docs/agent-runtime/mobile-docs-tables-entry-redesign-demo.html`。
struct TaskResourceAppHomeView: View {
    let appKind: TaskResourceAppKind
    let resources: [TaskResourceAppHomeResource]
    let pendingOverlays: [TaskResourceAppHomePendingOverlay]
    let libraryViewModel: TaskResourceLibraryViewModel?
    let currentlyOpen: TaskResourceIdentity?
    let isLoading: Bool
    let isCreatingBlank: Bool
    let errorMessage: String?
    let blankCreateErrorMessage: String?
    let organizationName: String?
    /// taskPane 原生 modal 注入；nil 表示仍嵌在工作台自己的导航层。
    let onClose: (() -> Void)?
    let onBack: () -> Void
    let onRetry: () -> Void
    let onLoadLibrary: (TaskResourceLibraryScope, String, Bool) async -> Void
    let onCreateBlank: () -> Void
    let onRequestAgent: () -> Void
    let onOpen: (TaskResourceAppHomeItem) -> Void
    let onOpenLibrary: (TaskResourceLibraryItem) -> Void
    let onOpenLibraryHub: () -> Void
    let onPreviewFocusChange: (TaskResourceAppHomeItem?) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var searchQuery = ""
    @State private var libraryScope: TaskResourceLibraryScope = .recent
    @State private var previewItem: TaskResourceAppHomeItem?
    @State private var continueCollaboration: TaskResourceCollaborationState = .idle

    private var snapshot: TaskResourceAppHomeSnapshot {
        TaskResourceAppHomeProjector.project(
            appKind: appKind,
            resources: resources,
            pendingOverlays: pendingOverlays,
            currentlyOpen: currentlyOpen,
            searchQuery: searchQuery
        )
    }

    private var unfilteredSnapshot: TaskResourceAppHomeSnapshot {
        TaskResourceAppHomeProjector.project(
            appKind: appKind,
            resources: resources,
            pendingOverlays: pendingOverlays,
            currentlyOpen: currentlyOpen,
            searchQuery: ""
        )
    }

    private var librarySnapshot: TaskResourceLibrarySnapshot {
        let scope = effectiveLibraryScope
        let continueIdentity = isSearching ? nil : continueItem?.identity
        return TaskResourceLibraryProjector.project(
            appKind: appKind,
            scope: scope,
            resources: libraryViewModel?.resources(for: scope) ?? [],
            sharedResources: libraryViewModel?.sharedResources ?? [],
            // 搜索已经由组织级服务端搜索分页完成，不能再按标题/摘要二次丢结果。
            searchQuery: "",
            totalCount: libraryViewModel?.totalCount(for: scope),
            excludingIdentity: continueIdentity
        )
    }

    private var recentLibrarySnapshot: TaskResourceLibrarySnapshot {
        TaskResourceLibraryProjector.project(
            appKind: appKind,
            scope: .recent,
            resources: libraryViewModel?.resources(for: .recent) ?? [],
            sharedResources: [],
            searchQuery: "",
            totalCount: libraryViewModel?.totalCount(for: .recent)
        )
    }

    /// demo 的第一层永远是“恢复工作”：Task 资源优先，组织最近资源兜底。
    private var continueItem: TaskResourceAppHomeItem? {
        TaskResourceAppHomeProjector.resolveContinueItem(
            taskItem: snapshot.continueItem,
            recentLibraryItems: recentLibrarySnapshot.items
        )
    }

    /// 继续卡已经展示的 Task 资源不在下方重复出现；搜索时仍展示完整命中。
    private var taskSectionItems: [TaskResourceAppHomeItem] {
        guard !isSearching, let primary = snapshot.continueItem else { return snapshot.items }
        return snapshot.items.filter { $0.id != primary.id }
    }

    private var contentGlyphReference: AppIconReference {
        AppIconResolver.resolveContentGlyph(
            appId: appKind.resourceType,
            manifestIcon: appKind == .tabdoc ? "file-text" : "table"
        )
    }

    private var effectiveLibraryScope: TaskResourceLibraryScope {
        isSearching ? .all : libraryScope
    }

    private var hasTaskContent: Bool {
        !unfilteredSnapshot.items.isEmpty
    }

    private var isSearching: Bool {
        !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var palette: AppHomePalette {
        AppHomePalette(appKind: appKind)
    }

    var body: some View {
        VStack(spacing: 0) {
            if onClose == nil {
                appHomeChromeHeader(
                    title: titleText,
                    subtitle: organizationName,
                    backLabel: L10n.WorkbenchAppHome.backToWorkbench,
                    createLabel: blankActionTitle,
                    accent: palette.accent,
                    isCreating: isCreatingBlank,
                    onCreate: onCreateBlank,
                    onBack: onBack
                )
            }

            contentList
        }
        .background(palette.phone)
        .taskResourceAppHomeSystemNavigationChrome(
            enabled: onClose != nil,
            title: titleText,
            subtitle: organizationName,
            accent: palette.accent,
            onCreate: onCreateBlank,
            isCreateDisabled: isCreatingBlank,
            createLabel: blankActionTitle,
            onClose: onClose
        )
        .sheet(item: $previewItem) { item in
            TaskResourceContinuePreviewSheet(
                appKind: appKind,
                actionTitle: continueActionTitle,
                originText: continueOriginText(for: item),
                recencyText: continueRecency(for: item),
                iconReference: contentGlyphReference,
                item: item,
                accent: palette.accent,
                accentSoft: palette.accentSoft,
                onClose: { previewItem = nil },
                onContinue: {
                    previewItem = nil
                    onOpen(item)
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .workbenchCapsuleTopLayer()
        }
        .task(id: libraryLoadTaskID) {
            await onLoadLibrary(effectiveLibraryScope, searchQuery, false)
        }
        .task(id: continueCollaborationTaskID) {
            await loadContinueCollaboration()
        }
        .onChange(of: previewItem) { _, item in
            onPreviewFocusChange(item)
        }
        .onDisappear {
            onPreviewFocusChange(nil)
        }
    }

    private var libraryLoadTaskID: String {
        "\(appKind.rawValue)|\(effectiveLibraryScope.rawValue)|\(searchQuery)"
    }

    private var continueCollaborationTaskID: String {
        guard !isSearching, let item = continueItem else { return "\(appKind.rawValue)|none" }
        return "\(item.identity.resourceType)|\(item.identity.resourceId)"
    }

    @MainActor
    private func loadContinueCollaboration() async {
        continueCollaboration = .idle
        guard !isSearching, let item = continueItem,
              let shareType = CloudShareResourceType.from(normalizedType: item.resourceType)
        else { return }

        let identity = item.identity
        continueCollaboration = .loading
        do {
            let snapshot = try await CloudDocsShareService.shared.collaborationSnapshot(
                type: shareType,
                resourceId: item.resourceId
            )
            try Task.checkCancellation()
            guard continueItem?.identity == identity else { return }
            continueCollaboration = .loaded(Self.collaborationPeople(from: snapshot))
        } catch is CancellationError {
            return
        } catch {
            guard continueItem?.identity == identity else { return }
            continueCollaboration = .unavailable
        }
    }

    private static func collaborationPeople(
        from snapshot: CloudDocsCollaboratorList
    ) -> [TaskResourceCollaborationPerson] {
        var seen: Set<String> = []
        var people: [TaskResourceCollaborationPerson] = []

        if let owner = snapshot.owner, !owner.userId.isEmpty {
            seen.insert(owner.userId)
            people.append(TaskResourceCollaborationPerson(
                id: owner.userId,
                name: collaborationName(nickname: owner.nickname, email: owner.email),
                avatarURL: owner.avatar
            ))
        }

        // 静态分享成员不是在线 presence；协作信息只统计真正可编辑的人。
        for collaborator in snapshot.collaborators
        where collaborator.canEdit
            && seen.insert(collaborator.userId).inserted {
            people.append(TaskResourceCollaborationPerson(
                id: collaborator.userId,
                name: collaborationName(
                    nickname: collaborator.nickname,
                    email: collaborator.email
                ),
                avatarURL: collaborator.avatar
            ))
        }
        return people
    }

    private static func collaborationName(nickname: String, email: String) -> String {
        let name = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        let fallback = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback.isEmpty ? L10n.WorkbenchAppHome.collaboratorFallbackName : fallback
    }

    private var titleText: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.docTitle
        case .tabdata: return L10n.WorkbenchAppHome.tableTitle
        }
    }

    private var agentActionTitle: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.agentDraft
        case .tabdata: return L10n.WorkbenchAppHome.agentBuild
        }
    }

    private var continueActionTitle: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.continueWrite
        case .tabdata: return L10n.WorkbenchAppHome.continueHandle
        }
    }

    private var blankActionTitle: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.blankDoc
        case .tabdata: return L10n.WorkbenchAppHome.blankTable
        }
    }

    private var blankActionSubtitle: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.blankDocSubtitle
        case .tabdata: return L10n.WorkbenchAppHome.blankTableSubtitle
        }
    }

    private var agentActionSubtitle: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.agentDraftSubtitle
        case .tabdata: return L10n.WorkbenchAppHome.agentBuildSubtitle
        }
    }

    private var searchPlaceholder: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.searchDocPlaceholder
        case .tabdata: return L10n.WorkbenchAppHome.searchTablePlaceholder
        }
    }

    private var libraryTitle: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.libraryDocs
        case .tabdata: return L10n.WorkbenchAppHome.libraryTables
        }
    }

    private var libraryHubTitle: String {
        switch appKind {
        case .tabdoc: return L10n.WorkbenchAppHome.knowledgeBase
        case .tabdata: return L10n.WorkbenchAppHome.viewAll
        }
    }

    private var contentList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                searchField

                if !isSearching {
                    if let continueItem {
                        VStack(alignment: .leading, spacing: TTSpacing.xs) {
                            HStack(alignment: .firstTextBaseline, spacing: TTSpacing.sm) {
                                Text(continueActionTitle)
                                    .font(.tt.subtitleSemibold)
                                    .foregroundStyle(palette.textPrimary)
                                    .accessibilityAddTraits(.isHeader)

                                Spacer(minLength: 0)

                                if let recency = continueRecency(for: continueItem) {
                                    Text(recency)
                                        .font(.tt.meta)
                                        .foregroundStyle(palette.textTertiary)
                                }
                            }

                            TaskResourceContinueCard(
                                appKind: appKind,
                                actionTitle: continueActionTitle,
                                originText: continueOriginText(for: continueItem),
                                iconReference: contentGlyphReference,
                                item: continueItem,
                                collaboration: continueCollaboration,
                                accent: palette.accent,
                                accentSoft: palette.accentSoft,
                                surface: palette.surface,
                                line: palette.line,
                                onPreview: { previewItem = continueItem }
                            )
                        }
                        .padding(.top, TTSpacing.lg)
                    }

                    createActionsRow
                        .padding(.top, TTSpacing.md)

                    if let blankCreateErrorMessage, !blankCreateErrorMessage.isEmpty {
                        Text(blankCreateErrorMessage)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textCritical)
                            .padding(.top, TTSpacing.xs)
                    }
                }

                librarySection
                    .padding(.top, TTSpacing.xl)

                taskContentSection
                    .padding(.top, TTSpacing.xl)
            }
            .padding(.horizontal, TTSpacing.lg)
            .padding(.top, TTSpacing.sm)
            .padding(.bottom, TTSpacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var searchField: some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(palette.textTertiary)
                .accessibilityHidden(true)
            TextField(
                searchPlaceholder,
                text: $searchQuery
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.tt.body)
            .foregroundStyle(palette.textPrimary)
            if isSearching {
                Button {
                    searchQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(palette.textTertiary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.WorkbenchAppHome.clearSearch)
            }
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, 12)
        .background(
            palette.surfaceSoft,
            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
        )
        .accessibilityElement(children: .contain)
    }

    private func continueOriginText(for item: TaskResourceAppHomeItem) -> String {
        switch item.source {
        case .library:
            return L10n.WorkbenchAppHome.resumeRecent
        case .candidate, .deliverable, .pendingOverlay:
            return L10n.WorkbenchAppHome.resumeTask
        }
    }

    private func continueRecency(for item: TaskResourceAppHomeItem) -> String? {
        guard let date = item.lastVisitedAt ?? item.updatedAt else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private var createActionsRow: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: TTSpacing.sm) {
                blankCreateCard
                agentActionCard
            }
            VStack(spacing: TTSpacing.sm) {
                blankCreateCard
                agentActionCard
            }
        }
    }

    private var blankCreateCard: some View {
        Button(action: onCreateBlank) {
            createActionCardLabel(
                title: blankActionTitle,
                subtitle: blankActionSubtitle,
                systemImage: "plus",
                showsProgress: isCreatingBlank
            )
        }
        .buttonStyle(.plain)
        .disabled(isCreatingBlank)
        .accessibilityHint(L10n.WorkbenchAppHome.blankCreateHint)
    }

    private var agentActionCard: some View {
        Button(action: onRequestAgent) {
            createActionCardLabel(
                title: agentActionTitle,
                subtitle: agentActionSubtitle,
                systemImage: "wand.and.stars",
                showsProgress: false
            )
        }
        .buttonStyle(.plain)
        .disabled(isCreatingBlank)
        .accessibilityHint(L10n.WorkbenchAppHome.agentHint)
    }

    private func createActionCardLabel(
        title: String,
        subtitle: String,
        systemImage: String,
        showsProgress: Bool
    ) -> some View {
        HStack(alignment: .center, spacing: TTSpacing.sm) {
            Group {
                if showsProgress {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(palette.accent)
                }
            }
            .frame(width: 32, height: 32)
            .background(
                palette.accentSoft,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(palette.textPrimary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(1)

                Text(subtitle)
                    .font(.tt.caption)
                    .foregroundStyle(palette.textTertiary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xs)
        .frame(maxWidth: .infinity, minHeight: 58, alignment: .center)
        .background(
            palette.surface,
            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(palette.line, lineWidth: 1)
        )
        .opacity(isCreatingBlank && !showsProgress ? 0.55 : 1)
    }

    @ViewBuilder
    private var taskContentSection: some View {
        if isLoading && !hasTaskContent {
            HStack(spacing: TTSpacing.sm) {
                ProgressView()
                    .controlSize(.small)
                Text(L10n.WorkbenchAppHome.loadingTaskContent)
                    .font(.tt.meta)
                    .foregroundStyle(palette.textSecondary)
            }
            .frame(maxWidth: .infinity, minHeight: 64)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(L10n.Common.loading)
        } else {
            if let errorMessage = normalized(errorMessage) {
                inlineErrorState(message: errorMessage, onRetry: onRetry)
            }

            if !taskSectionItems.isEmpty {
                HStack(spacing: TTSpacing.xs) {
                    Text(L10n.WorkbenchAppHome.sectionTaskContent)
                        .font(.tt.captionSemibold)
                        .foregroundStyle(palette.textSecondary)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 0)
                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel(L10n.Common.loading)
                    }
                }

                VStack(spacing: 0) {
                    ForEach(taskSectionItems) { item in
                        resourceRow(item)
                        if item.id != taskSectionItems.last?.id {
                            Divider()
                                .overlay(palette.line)
                                .padding(.horizontal, TTSpacing.sm)
                        }
                    }
                }
                .background(
                    palette.surface,
                    in: RoundedRectangle(cornerRadius: 17, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .strokeBorder(palette.line, lineWidth: 1)
                )
            }
        }
    }

    private var librarySection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: TTSpacing.sm) {
                Text(libraryTitle)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)

                Spacer(minLength: 0)

                Button(action: onOpenLibraryHub) {
                    HStack(spacing: 3) {
                        Text(libraryHubTitle)
                            .font(.tt.meta)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                    .foregroundStyle(palette.textSecondary)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                    .buttonStyle(.plain)
                    .accessibilityHint(L10n.WorkbenchAppHome.openLibraryHubHint)
            }

            if !isSearching {
                if dynamicTypeSize.isAccessibilitySize {
                    Picker(
                        L10n.WorkbenchAppHome.libraryScope,
                        selection: Binding(
                            get: { libraryScope.rawValue },
                            set: { libraryScope = TaskResourceLibraryScope(rawValue: $0) ?? .recent }
                        )
                    ) {
                        ForEach(TaskResourceLibraryScope.allCases) { scope in
                            Text(scope.title).tag(scope.rawValue)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .accessibilityLabel(L10n.WorkbenchAppHome.libraryScope)
                } else {
                    HStack(spacing: 5) {
                        ForEach(TaskResourceLibraryScope.allCases) { scope in
                            Button {
                                libraryScope = scope
                            } label: {
                                Text(scope.title)
                                    .font(scope == libraryScope ? .tt.metaSemibold : .tt.meta)
                                    .foregroundStyle(
                                        scope == libraryScope
                                            ? palette.textPrimary
                                            : palette.textSecondary
                                    )
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 44)
                                    .background {
                                        if scope == libraryScope {
                                            Capsule()
                                                .fill(palette.surface)
                                                .overlay(
                                                    Capsule()
                                                        .strokeBorder(palette.line, lineWidth: 1)
                                                )
                                        }
                                    }
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(scope == libraryScope ? .isSelected : [])
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(L10n.WorkbenchAppHome.libraryScope)
                }
            }

            if let message = activeLibraryErrorMessage {
                inlineErrorState(message: message) {
                    Task {
                        await onLoadLibrary(effectiveLibraryScope, searchQuery, true)
                    }
                }
                if !librarySnapshot.items.isEmpty {
                    libraryResourceList
                }
            } else if isActiveLibraryLoading && librarySnapshot.items.isEmpty {
                HStack(spacing: TTSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text(L10n.WorkbenchAppHome.loadingLibrary(libraryTitle))
                        .font(.tt.meta)
                        .foregroundStyle(palette.textSecondary)
                }
                .frame(maxWidth: .infinity, minHeight: 112)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(L10n.Common.loading)
            } else if librarySnapshot.items.isEmpty {
                libraryEmptyState
            } else {
                libraryResourceList
            }
        }
        .padding(.top, TTSpacing.sm)
    }

    private var activeLibraryErrorMessage: String? {
        normalized(libraryViewModel?.errorMessage(for: effectiveLibraryScope))
    }

    private var isActiveLibraryLoading: Bool {
        libraryViewModel?.isLoading(effectiveLibraryScope) ?? true
    }

    private var libraryResourceList: some View {
        let items = librarySnapshot.items
        return LazyVStack(spacing: 0) {
            ForEach(items) { item in
                libraryResourceRow(item)
                if item.id != items.last?.id {
                    Divider()
                        .overlay(palette.line)
                        .padding(.horizontal, TTSpacing.sm)
                }
            }
        }
        .background(
            palette.surface,
            in: RoundedRectangle(cornerRadius: 17, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .strokeBorder(palette.line, lineWidth: 1)
        )
    }

    private func libraryResourceRow(_ item: TaskResourceLibraryItem) -> some View {
        Button {
            guard item.canOpen else { return }
            onOpenLibrary(item)
        } label: {
            HStack(alignment: .center, spacing: TTSpacing.sm) {
                AppIconImage(reference: contentGlyphReference, size: 20)
                    .frame(width: 40, height: 40)
                    .background(
                        palette.accentSoft,
                        in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                    )
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        Text(item.title)
                            .font(.tt.body)
                            .fontWeight(.semibold)
                            .foregroundStyle(item.canOpen ? palette.textPrimary : palette.textTertiary)
                            .lineLimit(1)
                            .multilineTextAlignment(.leading)
                        if item.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.tt.textWarning)
                                .accessibilityLabel(L10n.WorkbenchAppHome.pinned)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    if let subtitle = normalized(item.subtitle) {
                        Text(subtitle)
                            .font(.tt.meta)
                            .foregroundStyle(palette.textSecondary)
                            .lineLimit(1)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                Image(systemName: item.canOpen ? "chevron.right" : "lock.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(palette.textTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!item.canOpen)
        .accessibilityHint(
            item.canOpen
                ? L10n.WorkbenchAppHome.openNamed(item.title)
                : L10n.WorkbenchAppHome.noViewPermission
        )
    }

    private var libraryEmptyState: some View {
        VStack(spacing: TTSpacing.sm) {
            if isSearching {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(palette.accent)
                    .accessibilityHidden(true)
            } else {
                AppIconImage(reference: contentGlyphReference, size: 28)
                    .accessibilityHidden(true)
            }
            Text(libraryEmptyTitle)
                .font(.tt.body)
                .fontWeight(.medium)
                .foregroundStyle(palette.textPrimary)
                .multilineTextAlignment(.center)
            Text(libraryEmptySubtitle)
                .font(.tt.meta)
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 132)
        .padding(.horizontal, TTSpacing.lg)
        .background(
            palette.surfaceSoft,
            in: RoundedRectangle(cornerRadius: 17, style: .continuous)
        )
    }

    private var libraryEmptyTitle: String {
        if isSearching { return L10n.WorkbenchAppHome.librarySearchEmpty(appKind.title) }
        switch effectiveLibraryScope {
        case .recent: return L10n.WorkbenchAppHome.libraryRecentEmpty(appKind.title)
        case .all: return L10n.WorkbenchAppHome.libraryAllEmpty(appKind.title)
        case .shared: return L10n.WorkbenchAppHome.librarySharedEmpty(appKind.title)
        }
    }

    private var libraryEmptySubtitle: String {
        if isSearching { return L10n.WorkbenchAppHome.librarySearchEmptySubtitle }
        switch effectiveLibraryScope {
        case .recent: return L10n.WorkbenchAppHome.libraryRecentEmptySubtitle
        case .all: return L10n.WorkbenchAppHome.libraryAllEmptySubtitle
        case .shared: return L10n.WorkbenchAppHome.librarySharedEmptySubtitle
        }
    }

    private func inlineErrorState(
        message: String,
        onRetry: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .center, spacing: TTSpacing.sm) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(.red)
                .accessibilityHidden(true)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(palette.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(L10n.Common.retry, action: onRetry)
                .font(.tt.meta)
                .buttonStyle(.bordered)
                .tint(palette.accent)
                .frame(minHeight: 44)
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.xs)
        .background(
            palette.surfaceSoft,
            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
        )
    }

    private func normalized(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    private func resourceRow(_ item: TaskResourceAppHomeItem) -> some View {
        Button {
            guard item.canOpen else { return }
            onOpen(item)
        } label: {
            HStack(alignment: .center, spacing: TTSpacing.sm) {
                AppIconImage(reference: contentGlyphReference, size: 20)
                    .frame(width: 40, height: 40)
                    .background(
                        palette.accentSoft,
                        in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                    )
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.tt.body)
                        .fontWeight(.medium)
                        .foregroundStyle(item.canOpen ? palette.textPrimary : palette.textTertiary)
                        .lineLimit(1)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let subtitle = item.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.tt.meta)
                            .foregroundStyle(palette.textSecondary)
                            .lineLimit(1)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if item.isPendingSync {
                    Text(L10n.WorkbenchAppHome.syncing)
                        .font(.tt.meta)
                        .foregroundStyle(palette.textTertiary)
                        .accessibilityLabel(L10n.WorkbenchAppHome.syncingA11y)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(palette.textTertiary)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!item.canOpen)
        .accessibilityHint(item.canOpen ? L10n.WorkbenchAppHome.openHint : "")
    }

}

/// 继续卡只负责打开这个安全预览；真正进入编辑器由底部主按钮触发。
private struct TaskResourceContinuePreviewSheet: View {
    let appKind: TaskResourceAppKind
    let actionTitle: String
    let originText: String
    let recencyText: String?
    let iconReference: AppIconReference
    let item: TaskResourceAppHomeItem
    let accent: Color
    let accentSoft: Color
    let onClose: () -> Void
    let onContinue: () -> Void

    private var previewText: String? {
        normalized(item.preview)
    }

    private var fieldNames: [String] {
        item.summary?.fieldNames?.compactMap { normalized($0) } ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            previewHeader

            previewContent
                .padding(.horizontal, 13)
                .padding(.bottom, 13)

            previewActions
        }
        .background(
            Color.tt.bgCanvasDefault,
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.tt.borderLight, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var previewContent: some View {
        switch appKind {
        case .tabdoc:
            documentPreview
        case .tabdata:
            tablePreview
        }
    }

    private var previewHeader: some View {
        HStack(alignment: .center, spacing: 10) {
            AppIconImage(reference: iconReference, size: 20)
                .frame(width: 40, height: 40)
                .background(
                    accentSoft,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(headerMetaText)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
                Text(item.title)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.tt.textPrimary)
                    .frame(width: 40, height: 40)
                    .background(Color.tt.bgSubtle, in: Circle())
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.Common.close)
        }
        .padding(.horizontal, 13)
        .padding(.top, 13)
        .padding(.bottom, 10)
    }

    private var headerMetaText: String {
        guard let recencyText = normalized(recencyText) else { return actionTitle }
        return "\(actionTitle) · \(recencyText)"
    }

    private var documentPreview: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 6) {
                Circle()
                    .fill(accent)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
                Text(originText)
                    .font(.tt.captionSemibold)
                    .foregroundStyle(accent)
            }

            Text(item.title)
                .font(.tt.titleSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let previewText {
                Text(previewText)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                    .multilineTextAlignment(.leading)
                    .lineSpacing(3)
                    .lineLimit(7)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                previewUnavailable(L10n.WorkbenchAppHome.documentPreviewUnavailable)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, minHeight: 232, maxHeight: 232, alignment: .topLeading)
        .clipped()
        .background(
            Color.tt.bgBubbleIncoming,
            in: RoundedRectangle(cornerRadius: 15, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(accent.opacity(0.14), lineWidth: 1)
        )
    }

    private var tablePreview: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: TTSpacing.sm) {
                Circle()
                    .fill(accent)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
                Text(originText)
                    .font(.tt.captionSemibold)
                    .foregroundStyle(accent)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if !tableMetricText.isEmpty {
                    Text(tableMetricText)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                }
            }

            Text(item.title)
                .font(.tt.titleSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            tableGridPreview
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, minHeight: 232, maxHeight: 232, alignment: .topLeading)
        .clipped()
        .background(
            Color.tt.bgBubbleIncoming,
            in: RoundedRectangle(cornerRadius: 15, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(accent.opacity(0.14), lineWidth: 1)
        )
    }

    private var tableGridPreview: some View {
        TabularPreviewArtwork(
            title: item.title,
            content: TabularPreviewContent(fieldNames: fieldNames, previewText: previewText),
            accent: accent,
            compact: false
        )
        .frame(minHeight: 108)
    }

    private var tableMetricText: String {
        var parts: [String] = []
        if let recordCount = item.summary?.recordCount {
            parts.append(L10n.WorkbenchAppHome.recordCount(recordCount))
        }
        if let fieldCount = item.summary?.fieldCount {
            parts.append(L10n.WorkbenchAppHome.fieldCount(fieldCount))
        }
        return parts.joined(separator: " · ")
    }

    private var previewActions: some View {
        GeometryReader { proxy in
            let gap = TTSpacing.sm
            let availableWidth = max(0, proxy.size.width - gap)
            HStack(spacing: gap) {
                Button(L10n.WorkbenchAppHome.previewLater, action: onClose)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .frame(width: availableWidth / 2.65, height: 44)
                    .background(
                        Color.tt.bgSubtle,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )

                Button(action: onContinue) {
                    HStack(spacing: TTSpacing.xs) {
                        Text(actionTitle)
                        Image(systemName: "arrow.right")
                            .font(.system(size: 13, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.white)
                    .frame(width: availableWidth * 1.65 / 2.65, height: 44)
                    .background(
                        accent,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
                }
                .disabled(!item.canOpen)
                .opacity(item.canOpen ? 1 : 0.5)
                .accessibilityHint(L10n.WorkbenchAppHome.openNamed(item.title))
            }
            .buttonStyle(.plain)
        }
        .frame(height: 44)
        .padding(.horizontal, 13)
        .padding(.bottom, 13)
    }

    private func previewUnavailable(_ message: String) -> some View {
        Text(message)
            .font(.tt.meta)
            .foregroundStyle(.tt.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
    }

    private func normalized(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }
}

struct TaskResourceCollaborationPerson: Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let avatarURL: String?
}

enum TaskResourceCollaborationState: Equatable, Sendable {
    case idle
    case loading
    case loaded([TaskResourceCollaborationPerson])
    case unavailable
}

/// 「继续写 / 继续处理」卡：白色区域说明恢复上下文，右侧彩色窗只承载固定画布预览。
struct TaskResourceContinueCard: View {
    let appKind: TaskResourceAppKind
    let actionTitle: String
    let originText: String
    let iconReference: AppIconReference
    let item: TaskResourceAppHomeItem
    let collaboration: TaskResourceCollaborationState
    var accent: Color = .tt.textAccent
    var accentSoft: Color = .tt.bgSubtle
    var surface: Color = .tt.bgBubbleIncoming
    var line: Color = .tt.borderLight
    let onPreview: () -> Void

    var body: some View {
        Button(action: onPreview) {
            HStack(alignment: .top, spacing: 13) {
                continueContext

                TaskResourceMiniPreview(
                    appKind: appKind,
                    iconReference: iconReference,
                    item: item,
                    accent: accent,
                    accentSoft: accentSoft,
                    line: line
                )
                // demo 的右侧画布是固定槽位；内容只截断，不参与尺寸计算。
                .frame(width: 114, height: 124)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 156, alignment: .leading)
            .background(
                surface,
                in: RoundedRectangle(cornerRadius: 22, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(line, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!item.canOpen)
        .accessibilityLabel(L10n.WorkbenchAppHome.continuePreviewNamed(actionTitle, title: item.title))
        .accessibilityHint(L10n.WorkbenchAppHome.continuePreviewHint)
    }

    private var continueContext: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Circle()
                    .fill(accent)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
                Text(originText)
                    .font(.tt.captionSemibold)
                    .foregroundStyle(accent)
                    .lineLimit(1)
            }

            Text(item.title)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(2)
                .minimumScaleFactor(0.88)
                .padding(.top, 8)

            Text(summaryText)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(2)
                .lineSpacing(1)
                .padding(.top, 5)

            Spacer(minLength: 6)

            if item.isPendingSync {
                HStack(spacing: 5) {
                    ProgressView()
                        .controlSize(.mini)
                    Text(L10n.WorkbenchAppHome.syncing)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            } else {
                TaskResourceCollaborationMeta(
                    state: collaboration,
                    surface: surface
                )
            }
        }
        .frame(maxWidth: .infinity, minHeight: 124, alignment: .topLeading)
    }

    private var summaryText: String {
        let preview = item.preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard appKind == .tabdata else {
            if !preview.isEmpty { return preview }
            return item.subtitle ?? L10n.WorkbenchAppHome.documentPreviewUnavailable
        }

        var parts: [String] = []
        if let count = item.summary?.recordCount {
            parts.append(L10n.WorkbenchAppHome.recordCount(count))
        }
        if let count = item.summary?.fieldCount {
            parts.append(L10n.WorkbenchAppHome.fieldCount(count))
        }
        if !preview.isEmpty { parts.append(preview) }
        if parts.isEmpty, let subtitle = item.subtitle { parts.append(subtitle) }
        return parts.isEmpty ? L10n.WorkbenchAppHome.tablePreviewUnavailable : parts.joined(separator: " · ")
    }
}

private struct TaskResourceCollaborationMeta: View {
    let state: TaskResourceCollaborationState
    let surface: Color

    @ViewBuilder
    var body: some View {
        switch state {
        case .loading:
            HStack(spacing: 5) {
                ProgressView()
                    .controlSize(.mini)
                Text(L10n.WorkbenchAppHome.collaborationLoading)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
        case .loaded(let people) where people.count > 1:
            HStack(spacing: 7) {
                HStack(spacing: -4) {
                    ForEach(Array(people.prefix(2))) { person in
                        IdentityColorAvatar(
                            name: person.name,
                            seed: person.id,
                            imageUrl: person.avatarURL,
                            size: 19
                        )
                        .overlay(Circle().stroke(surface, lineWidth: 2))
                    }
                }
                .accessibilityHidden(true)

                Text(L10n.WorkbenchAppHome.collaborationPeople(people.count))
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
        case .loaded(let people) where !people.isEmpty:
            let person = people[0]
            HStack(spacing: 7) {
                IdentityColorAvatar(
                    name: person.name,
                    seed: person.id,
                    imageUrl: person.avatarURL,
                    size: 19
                )
                .overlay(Circle().stroke(surface, lineWidth: 2))
                .accessibilityHidden(true)

                Text(L10n.WorkbenchAppHome.maintainedBy(person.name))
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
        case .idle, .unavailable, .loaded:
            EmptyView()
        }
    }
}

private struct TaskResourceMiniPreview: View {
    let appKind: TaskResourceAppKind
    let iconReference: AppIconReference
    let item: TaskResourceAppHomeItem
    let accent: Color
    let accentSoft: Color
    let line: Color

    private var previewText: String? {
        let value = item.preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    private var fieldNames: [String] {
        Array((item.summary?.fieldNames ?? []).compactMap { value in
            let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? nil : name
        }.prefix(3))
    }

    var body: some View {
        Group {
            switch appKind {
            case .tabdoc:
                documentPreview
            case .tabdata:
                tablePreview
            }
        }
        .accessibilityHidden(true)
    }

    private var documentPreview: some View {
        VStack(alignment: .leading, spacing: 6) {
            resourceTypePill

            Text(item.title)
                .font(.tt.metaSemibold)
                .foregroundStyle(accent)
                .lineLimit(1)

            Text(previewText ?? L10n.WorkbenchAppHome.documentPreviewUnavailable)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.leading)
                .lineSpacing(2)
                .lineLimit(3)
                .padding(7)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(.tt.bgBubbleIncoming.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))

            Spacer(minLength: 0)
        }
        .padding(9)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            accentSoft,
            in: RoundedRectangle(cornerRadius: 15, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(accent.opacity(0.42), lineWidth: 1)
        )
    }

    private var tablePreview: some View {
        VStack(alignment: .leading, spacing: 6) {
            resourceTypePill

            Text(item.title)
                .font(.tt.metaSemibold)
                .foregroundStyle(accent)
                .lineLimit(1)

            tablePreviewGrid
        }
        .padding(9)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            accentSoft,
            in: RoundedRectangle(cornerRadius: 15, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(accent.opacity(0.42), lineWidth: 1)
        )
    }

    private var resourceTypePill: some View {
        HStack(spacing: 4) {
            AppIconImage(reference: iconReference, size: 13)
            Text(appKind == .tabdata
                 ? L10n.WorkbenchAppHome.tablePreviewType
                 : L10n.WorkbenchAppHome.documentPreviewType)
                .font(.tt.captionMedium.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(accent)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(.tt.bgBubbleIncoming.opacity(0.78), in: Capsule())
    }

    private var tablePreviewGrid: some View {
        VStack(alignment: .leading, spacing: 3) {
            if !fieldNames.isEmpty {
                HStack(spacing: 4) {
                    ForEach(Array(fieldNames.prefix(2).enumerated()), id: \.offset) { _, field in
                        Text(field)
                            .font(.tt.caption)
                            .foregroundStyle(accent)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                Divider().overlay(accent.opacity(0.16))
            }

            Text(previewText ?? L10n.WorkbenchAppHome.tableRowsUnavailable)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.leading)
                .lineLimit(fieldNames.isEmpty ? 2 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let count = item.summary?.recordCount {
                Text(L10n.WorkbenchAppHome.recordCount(count))
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
        }
        .padding(7)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.tt.bgBubbleIncoming.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// App 首页共用顶栏：左返回 + 居中上下文标题（对齐入口 redesign demo）。
@MainActor
@ViewBuilder
func appHomeChromeHeader(
    title: String,
    subtitle: String?,
    backLabel: String,
    createLabel: String,
    accent: Color = Color.tt.textAccent,
    isCreating: Bool,
    onCreate: @escaping () -> Void,
    onBack: @escaping () -> Void
) -> some View {
    ZStack {
        VStack(spacing: 1) {
            Text(title)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)

        HStack(spacing: 0) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(accent)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(backLabel)

            Spacer(minLength: 0)

            Button(action: onCreate) {
                Group {
                    if isCreating {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "plus")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(accent)
                    }
                }
                .frame(width: 44, height: 44)
                .background(Color.tt.bgSubtle, in: Circle())
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(isCreating)
            .accessibilityLabel(createLabel)
            .accessibilityHint(L10n.WorkbenchAppHome.blankCreateHint)
        }
    }
    .padding(.horizontal, TTSpacing.sm)
    .padding(.vertical, TTSpacing.xs)
    .frame(minHeight: 60)
}

/// 其它 App 首页沿用既有顶栏，避免文档 / 多维表 redesign 改变它们的可见布局。
@MainActor
@ViewBuilder
func appHomeChromeHeader(
    title: String,
    subtitle: String?,
    accent: Color = Color.tt.textAccent,
    onBack: (() -> Void)? = nil,
    onCreate: (() -> Void)? = nil,
    onClose: (() -> Void)? = nil
) -> some View {
    HStack(alignment: .center, spacing: TTSpacing.sm) {
        if let onBack {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(accent)
                    .frame(width: 44, height: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.WorkbenchAppHome.backToWorkbench)
        }

        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)

        Spacer(minLength: 0)

        if let onCreate {
            Button(action: onCreate) {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(accent)
            .accessibilityLabel("新建")
        }

        if let onClose {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tt.iconAccent)
            .accessibilityLabel("关闭")
        }
    }
    .padding(.horizontal, TTSpacing.lg)
    .frame(maxWidth: .infinity, minHeight: 52)
    .overlay(alignment: .bottom) {
        Rectangle().fill(.tt.borderLight).frame(height: 0.5)
    }
}

/// 文档 / 多维表会话弹层使用单一左上关闭键，避免与预览层出现两个退出按钮。
@MainActor
private struct TaskResourceAppHomeSystemNavigationChrome: ViewModifier {
    let enabled: Bool
    let title: String
    let subtitle: String?
    let accent: Color
    let onCreate: (() -> Void)?
    let isCreateDisabled: Bool
    let createLabel: String?
    let onClose: (() -> Void)?

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        if let onClose {
                            Button(action: onClose) {
                                Image(systemName: "xmark")
                                    .frame(width: 44, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityLabel(L10n.Common.close)
                        }
                    }

                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 1) {
                            Text(title)
                                .font(.tt.subtitleSemibold)
                                .foregroundStyle(.tt.textPrimary)
                            if let subtitle, !subtitle.isEmpty {
                                Text(subtitle)
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }

                    ToolbarItem(placement: .primaryAction) {
                        if let onCreate {
                            Button(action: onCreate) {
                                Group {
                                    if isCreateDisabled {
                                        ProgressView()
                                            .controlSize(.small)
                                    } else {
                                        Image(systemName: "plus")
                                            .font(.system(size: 16, weight: .semibold))
                                            .foregroundStyle(accent)
                                    }
                                }
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                            }
                            .disabled(isCreateDisabled)
                            .accessibilityLabel(createLabel ?? L10n.WorkbenchAppHome.blankCreateHint)
                        }
                    }
                }
        } else {
            content
        }
    }
}

extension View {
    @ViewBuilder
    fileprivate func taskResourceAppHomeSystemNavigationChrome(
        enabled: Bool,
        title: String,
        subtitle: String?,
        accent: Color = .tt.textAccent,
        onCreate: (() -> Void)? = nil,
        isCreateDisabled: Bool = false,
        createLabel: String? = nil,
        onClose: (() -> Void)? = nil
    ) -> some View {
        modifier(TaskResourceAppHomeSystemNavigationChrome(
            enabled: enabled,
            title: title,
            subtitle: subtitle,
            accent: accent,
            onCreate: onCreate,
            isCreateDisabled: isCreateDisabled,
            createLabel: createLabel,
            onClose: onClose
        ))
    }
}

/// 其它 App 首页保留既有系统导航栏，避免文档 / 多维表 redesign 扩散视觉变化。
@MainActor
struct AppHomeSystemNavigationChrome: ViewModifier {
    let enabled: Bool
    let title: String
    let subtitle: String?
    let accent: Color
    let onCreate: (() -> Void)?
    let isCreateDisabled: Bool
    let onClose: (() -> Void)?

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 1) {
                            Text(title)
                                .font(.tt.captionSemibold)
                                .foregroundStyle(.tt.textPrimary)
                                .lineLimit(1)
                            if let subtitle, !subtitle.isEmpty {
                                Text(subtitle)
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textTertiary)
                                    .lineLimit(1)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        if let onCreate {
                            Button(action: onCreate) {
                                Image(systemName: "plus")
                            }
                            .foregroundStyle(accent)
                            .disabled(isCreateDisabled)
                            .accessibilityLabel("新建")
                        }
                        if let onClose {
                            Button(action: onClose) {
                                Image(systemName: "xmark")
                            }
                            .foregroundStyle(.tt.iconAccent)
                            .accessibilityLabel("关闭")
                        }
                    }
                }
        } else {
            content
        }
    }
}

extension View {
    @ViewBuilder
    func appHomeSystemNavigationChrome(
        enabled: Bool,
        title: String,
        subtitle: String?,
        accent: Color = .tt.textAccent,
        onCreate: (() -> Void)? = nil,
        isCreateDisabled: Bool = false,
        onClose: (() -> Void)? = nil
    ) -> some View {
        modifier(AppHomeSystemNavigationChrome(
            enabled: enabled,
            title: title,
            subtitle: subtitle,
            accent: accent,
            onCreate: onCreate,
            isCreateDisabled: isCreateDisabled,
            onClose: onClose
        ))
    }
}

struct AppHomePalette {
    let phone: Color
    let surface: Color
    let surfaceSoft: Color
    let textPrimary: Color
    let textSecondary: Color
    let textTertiary: Color
    let line: Color
    let accent: Color
    let accentSoft: Color

    init(appKind: TaskResourceAppKind) {
        phone = .tt.bgCanvasDefault
        surface = .tt.bgBubbleIncoming
        surfaceSoft = .tt.bgSubtleSecondary
        textPrimary = .tt.textPrimary
        textSecondary = .tt.textSecondary
        textTertiary = .tt.textTertiary
        line = .tt.borderLight

        let resolvedAccent: Color = appKind == .tabdoc ? .tt.textRunning : .tt.textSuccess
        accent = resolvedAccent
        accentSoft = resolvedAccent.opacity(0.11)
    }
}

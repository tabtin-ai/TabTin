import SwiftUI

private enum ProjectDetailSection: String, CaseIterable, Identifiable {
    case discussion
    case assets
    case activity
    case members

    var id: String { rawValue }

    var title: String {
        switch self {
        case .discussion: return L10n.Project.tabDiscussion
        case .assets: return L10n.Project.tabAssets
        case .activity: return L10n.Project.tabActivity
        case .members: return L10n.Project.tabMembers
        }
    }
}

/// Project 的移动协作页。讨论、资产、动态保持只读；任务遥控和主要 Agent 设置按权限开放。
struct ProjectDetailScreen: View {
    @State private var store: ProjectDetailStore
    @State private var section: ProjectDetailSection = .discussion
    @State private var showTaskComposer = false
    @State private var memberActionMessage: String?
    @State private var isOpeningDirectMessage = false
    private let loadsRemote: Bool
    private let onStartTask: (String, String?, ProjectCompanionWorkspace) -> Void
    private let onOpenIMConversation: (IMConversationTarget) -> Void
    private let conversationService: IMConversationServing

    init(
        project: Project,
        onStartTask: @escaping (String, String?, ProjectCompanionWorkspace) -> Void = { _, _, _ in },
        onOpenIMConversation: @escaping (IMConversationTarget) -> Void = { _ in },
        conversationService: IMConversationServing = IMConversationService()
    ) {
        _store = State(initialValue: ProjectDetailStore(project: project))
        loadsRemote = true
        self.onStartTask = onStartTask
        self.onOpenIMConversation = onOpenIMConversation
        self.conversationService = conversationService
    }

    init(
        project: Project,
        snapshot: ProjectDetailSnapshot,
        onStartTask: @escaping (String, String?, ProjectCompanionWorkspace) -> Void = { _, _, _ in },
        onOpenIMConversation: @escaping (IMConversationTarget) -> Void = { _ in },
        conversationService: IMConversationServing = IMConversationService()
    ) {
        _store = State(initialValue: ProjectDetailStore(project: project, snapshot: snapshot))
        loadsRemote = false
        self.onStartTask = onStartTask
        self.onOpenIMConversation = onOpenIMConversation
        self.conversationService = conversationService
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: TTSpacing.xl) {
                header
                executionNotice
                taskLauncher

                Picker(L10n.Project.sectionPickerLabel, selection: $section) {
                    ForEach(ProjectDetailSection.allCases) { item in
                        Text(item.title).tag(item)
                    }
                }
                .pickerStyle(.segmented)

                if store.isLoading {
                    ProgressView(L10n.Common.loading)
                        .frame(maxWidth: .infinity, minHeight: 220)
                } else {
                    if store.loadError != nil {
                        partialErrorBanner
                    }
                    sectionContent
                }
            }
            .padding(.horizontal, TTSpacing.lg)
            .padding(.vertical, TTSpacing.xl)
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(store.project.name)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .refreshable {
            if loadsRemote { await store.reload() }
        }
        .task {
            if loadsRemote { await store.reload() }
        }
        .sheet(isPresented: $showTaskComposer) {
            ProjectTaskComposerSheet(
                project: store.project,
                workspace: store.project.myWorkspace
            ) { agentId in
                guard let workspace = store.project.myWorkspace else { return }
                showTaskComposer = false
                // 只打开一个空的 ConversationScreen 草稿。Session 与首发都延后给草稿链路。
                onStartTask("", agentId, workspace)
            }
            .presentationDetents([.large])
        }
        .alert("提示", isPresented: Binding(
            get: { memberActionMessage != nil },
            set: { if !$0 { memberActionMessage = nil } }
        )) {
            Button("好", role: .cancel) { memberActionMessage = nil }
        } message: {
            Text(memberActionMessage ?? "")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.Project.headerLabel)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
            Text(store.project.displayDescription ?? L10n.Project.fallbackDescription)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: TTSpacing.md) {
                Label(
                    L10n.Project.memberCount(store.project.memberCount ?? 1),
                    systemImage: "person.2"
                )
                if let time = store.project.displayTime {
                    Label(time, systemImage: "clock")
                }
            }
            .font(.tt.caption)
            .foregroundStyle(.tt.textTertiary)
        }
    }

    private var executionNotice: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: "info.circle")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.iconAccent)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                Text(L10n.Project.executionTitle)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                Text(executionDescription)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(TTSpacing.md)
        .background(.tt.bgAccent.opacity(0.08), in: RoundedRectangle(cornerRadius: TTRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .strokeBorder(.tt.bgAccent.opacity(0.16), lineWidth: 0.5)
        )
    }

    private var executionDescription: String {
        guard let workspace = store.project.myWorkspace else {
            // 详情请求失败时 my_workspace 只是拉取失败，不代表未准备执行环境——提示重试而非误导。
            return store.detailFailed ? L10n.Project.taskLoadFailed : L10n.Project.executionUnavailable
        }
        if let name = workspace.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return L10n.Project.executionReadyWorkspace(name)
        }
        return L10n.Project.executionReady
    }

    private var taskLauncher: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Button {
                showTaskComposer = true
            } label: {
                Label(L10n.Project.startTask, systemImage: "paperplane.fill")
                    .font(.tt.bodySemibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.tt.bgAccent)
            .disabled(store.project.myWorkspace == nil)

            // detailFailed 时执行说明已展示失败文案，这里不再重复；仅在真无 workspace 时提示。
            if store.project.myWorkspace == nil, !store.detailFailed {
                Text(L10n.Project.taskNoWorkspace)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch section {
        case .discussion:
            ProjectDiscussionsSection(items: store.discussions)
        case .assets:
            ProjectAssetsSection(items: store.assets)
        case .activity:
            ProjectActivitySection(items: store.activities, projectName: store.project.name)
        case .members:
            ProjectMembersSection(
                items: store.participants,
                canManage: store.project.canManage == true,
                isUpdating: store.isUpdatingPrimaryAgent || isOpeningDirectMessage,
                currentUserId: AuthService.shared.currentUser?.id,
                onSetPrimaryAgent: { agentId in
                    Task { await store.setPrimaryAgent(agentId) }
                },
                onOpenMemberDirectMessage: openMemberDirectMessage,
                onAgentMemberTap: {
                    memberActionMessage = "当前 IM 后端暂不支持与 Agent 建立一对一私信。"
                }
            )
        }
    }

    private func openMemberDirectMessage(userId: String, displayName: String) {
        guard !userId.isEmpty else {
            memberActionMessage = "成员信息不完整，暂时无法发起私信。"
            return
        }
        let currentUserId = AuthService.shared.currentUser?.id
        guard userId != currentUserId else { return }
        let organizationId = store.project.organizationId
        guard !organizationId.isEmpty else {
            memberActionMessage = "组织信息尚未就绪，请稍后重试。"
            return
        }
        guard !isOpeningDirectMessage else { return }
        isOpeningDirectMessage = true
        Task {
            defer { isOpeningDirectMessage = false }
            do {
                let id = try await resolveDirectMessageConversationId(
                    conversations: IMConversationStore.shared.conversations,
                    organizationId: organizationId,
                    otherUserId: userId
                ) {
                    try await conversationService.createOrGetDM(
                        organizationId: organizationId,
                        otherUserId: userId
                    )
                }
                guard !id.isEmpty else {
                    memberActionMessage = "暂时无法打开私信。"
                    return
                }
                IMConversationStore.shared.rememberDirectMessage(
                    conversationId: id,
                    organizationId: organizationId,
                    otherUserId: userId,
                    displayName: displayName
                )
                onOpenIMConversation(IMConversationTarget(
                    conversationId: id,
                    title: displayName.isEmpty ? "私信" : displayName
                ))
            } catch {
                memberActionMessage = error.localizedDescription
            }
        }
    }

    private var partialErrorBanner: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.tt.textWarning)
            Text(L10n.Project.partialLoadError)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
            Spacer(minLength: 0)
            Button(L10n.Common.retry) { Task { await store.reload() } }
                .font(.tt.caption)
        }
        .padding(TTSpacing.md)
        .background(.tt.bgWarning.opacity(0.10), in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }
}

private struct ProjectSectionIntro: View {
    let text: String
    var showsReadOnlyHint = true

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: "eye")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.iconSecondary)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(text)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if showsReadOnlyHint {
                    Text(L10n.Project.readOnlyHint)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
        }
    }
}

private struct ProjectDiscussionsSection: View {
    let items: [ProjectDiscussion]

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            ProjectSectionIntro(text: L10n.Project.discussionIntro)
            if items.isEmpty {
                ProjectEmptyCard(text: L10n.Project.discussionEmpty, icon: "bubble.left.and.bubble.right")
            } else {
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        HStack(alignment: .top, spacing: TTSpacing.md) {
                            Image(systemName: "number")
                                .font(.tt.iconBody)
                                .foregroundStyle(.tt.iconAccent)
                                .frame(width: 30, height: 30)
                                .background(.tt.bgAccent.opacity(0.10), in: RoundedRectangle(cornerRadius: TTRadius.sm))
                            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                                HStack(spacing: TTSpacing.xs) {
                                    Text(item.name)
                                        .font(.tt.bodySemibold)
                                        .foregroundStyle(.tt.textPrimary)
                                    if item.unreadCount > 0 {
                                        Text("\(item.unreadCount)")
                                            .font(.tt.caption)
                                            .foregroundStyle(.white)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(.tt.bgAccent, in: Capsule())
                                    }
                                }
                                Text(discussionDescription(item))
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textSecondary)
                                    .lineLimit(2)
                                if let count = item.memberCount {
                                    Text(L10n.Project.discussionMemberCount(count))
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textTertiary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(TTSpacing.md)
                        if item.id != items.last?.id {
                            Divider().padding(.leading, 58)
                        }
                    }
                }
                .projectCard()
            }
        }
    }

    private func discussionDescription(_ item: ProjectDiscussion) -> String {
        if let preview = item.lastMessagePreview?.trimmingCharacters(in: .whitespacesAndNewlines), !preview.isEmpty {
            return preview
        }
        switch item.name {
        case "#general": return L10n.Project.discussionGeneral
        case "#agent-updates": return L10n.Project.discussionAgentUpdates
        default: return L10n.Project.discussionIntro
        }
    }
}

private struct ProjectAssetsSection: View {
    let items: [SpaceResource]

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            ProjectSectionIntro(text: L10n.Project.assetsIntro)
            if items.isEmpty {
                ProjectEmptyCard(text: L10n.Project.assetsEmpty, icon: "tray")
            } else {
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        HStack(spacing: TTSpacing.md) {
                            Image(systemName: item.icon)
                                .font(.tt.iconSubtitle)
                                .foregroundStyle(.tt.iconAccent)
                                .frame(width: 34, height: 34)
                                .background(.tt.bgAccent.opacity(0.10), in: RoundedRectangle(cornerRadius: TTRadius.sm))
                            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                Text(item.title.isEmpty ? L10n.Project.unnamedAsset : item.title)
                                    .font(.tt.bodySemibold)
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(1)
                                HStack(spacing: TTSpacing.xs) {
                                    Text(item.typeLabel)
                                    if let time = RelativeTime.format(item.updatedAt ?? item.createdAt ?? "") {
                                        Text("·")
                                        Text(time)
                                    }
                                }
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(TTSpacing.md)
                        if item.id != items.last?.id {
                            Divider().padding(.leading, 62)
                        }
                    }
                }
                .projectCard()
            }
        }
    }
}

private struct ProjectActivitySection: View {
    let items: [ProjectActivityEvent]
    let projectName: String

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            ProjectSectionIntro(text: L10n.Project.activityIntro)
            if items.isEmpty {
                ProjectEmptyCard(text: L10n.Project.activityEmpty, icon: "clock.arrow.circlepath")
            } else {
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        HStack(alignment: .top, spacing: TTSpacing.md) {
                            Image(systemName: icon(for: item.eventType))
                                .font(.tt.iconBody)
                                .foregroundStyle(.tt.iconSecondary)
                                .frame(width: 30, height: 30)
                                .background(.tt.bgSubtleSecondary, in: RoundedRectangle(cornerRadius: TTRadius.sm))
                            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                Text(description(for: item))
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textPrimary)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let time = item.displayTime {
                                    Text(time)
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textTertiary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(TTSpacing.md)
                        if item.id != items.last?.id {
                            Divider().padding(.leading, 58)
                        }
                    }
                }
                .projectCard()
            }
        }
    }

    private func description(for item: ProjectActivityEvent) -> String {
        let supported = [
            "space_created", "member_joined", "member_left", "member_role_changed",
            "asset_created", "asset_archived", "asset_restored", "agent_run_started",
            "agent_run_completed", "agent_run_failed", "settings_updated", "channel_created",
            "channel_renamed", "channel_archived",
        ]
        guard supported.contains(item.eventType) else { return L10n.Project.activityGeneric }
        let actor = nonEmpty(item.actorName) ?? L10n.Project.unknownActor
        let target = nonEmpty(item.targetName) ?? (item.eventType == "settings_updated" ? projectName : L10n.Project.unknownTarget)
        return L10n.Project.activity(item.eventType, actor: actor, target: target)
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    private func icon(for type: String) -> String {
        switch type {
        case "space_created": return "folder.badge.plus"
        case "member_joined": return "person.badge.plus"
        case "member_left": return "person.badge.minus"
        case "member_role_changed", "settings_updated": return "gearshape"
        case "asset_created": return "square.and.arrow.down"
        case "asset_archived", "asset_restored": return "archivebox"
        case "agent_run_started", "agent_run_completed", "agent_run_failed": return "sparkles"
        case "channel_created", "channel_renamed", "channel_archived": return "number"
        default: return "clock"
        }
    }
}

private struct ProjectMembersSection: View {
    let items: [ProjectParticipant]
    let canManage: Bool
    let isUpdating: Bool
    let currentUserId: String?
    let onSetPrimaryAgent: (String) -> Void
    let onOpenMemberDirectMessage: (String, String) -> Void
    let onAgentMemberTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            ProjectSectionIntro(text: L10n.Project.membersIntro, showsReadOnlyHint: false)
            if items.isEmpty {
                ProjectEmptyCard(text: L10n.Project.membersEmpty, icon: "person.2.slash")
            } else {
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        let isSelf = item.kind == .member
                            && !(item.userId ?? "").isEmpty
                            && item.userId == currentUserId
                        let canOpenDirectMessage = item.kind == .member
                            && !isSelf
                            && !(item.userId ?? "").isEmpty
                        HStack(spacing: TTSpacing.md) {
                            Button {
                                switch item.kind {
                                case .agent:
                                    onAgentMemberTap()
                                case .member:
                                    guard let userId = item.userId, canOpenDirectMessage else { return }
                                    onOpenMemberDirectMessage(userId, item.name)
                                }
                            } label: {
                                HStack(spacing: TTSpacing.md) {
                                    ZStack {
                                        Circle().fill(.tt.bgAccent.opacity(item.kind == .agent ? 0.14 : 0.08))
                                        if item.kind == .agent {
                                            Image(systemName: "sparkles")
                                                .font(.tt.iconBody)
                                                .foregroundStyle(.tt.iconAccent)
                                        } else {
                                            Text(String(item.name.prefix(1)).uppercased())
                                                .font(.tt.bodySemibold)
                                                .foregroundStyle(.tt.textSecondary)
                                        }
                                    }
                                    .frame(width: 36, height: 36)
                                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                        Text(item.name)
                                            .font(.tt.bodySemibold)
                                            .foregroundStyle(.tt.textPrimary)
                                        Text("\(kindTitle(item.kind)) · \(displayRole(item))")
                                            .font(.tt.caption)
                                            .foregroundStyle(.tt.textTertiary)
                                        if let responsibility = nonEmpty(item.responsibility) {
                                            Text(responsibility)
                                                .font(.tt.caption)
                                                .foregroundStyle(.tt.textSecondary)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                    if canOpenDirectMessage {
                                        Image(systemName: "chevron.right")
                                            .font(.tt.iconCaption)
                                            .foregroundStyle(.tt.textTertiary)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(item.kind == .member && !canOpenDirectMessage)
                            .accessibilityLabel(memberAccessibilityLabel(item, isSelf: isSelf))

                            if item.kind == .agent, let agentId = item.agentId {
                                if item.isPrimary {
                                    Text(L10n.Project.primaryAgentBadge)
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.iconAccent)
                                } else if canManage {
                                    Button(L10n.Project.setPrimaryAgent) {
                                        onSetPrimaryAgent(agentId)
                                    }
                                    .font(.tt.caption)
                                    .disabled(isUpdating)
                                }
                            }
                        }
                        .padding(TTSpacing.md)
                        if item.id != items.last?.id {
                            Divider().padding(.leading, 64)
                        }
                    }
                }
                .projectCard()
            }
        }
    }

    private func memberAccessibilityLabel(_ item: ProjectParticipant, isSelf: Bool) -> String {
        switch item.kind {
        case .agent:
            return "\(item.name)，Agent，暂不支持私信"
        case .member:
            if isSelf { return "\(item.name)，自己" }
            return "\(item.name)，打开私信"
        }
    }

    private func kindTitle(_ kind: ProjectParticipant.Kind) -> String {
        kind == .agent ? L10n.Project.agentKind : L10n.Project.memberKind
    }

    private func roleTitle(_ role: String) -> String {
        OrganizationRole(rawValue: role)?.title ?? role.capitalized
    }

    private func displayRole(_ item: ProjectParticipant) -> String {
        nonEmpty(item.roleLabel) ?? roleTitle(item.role)
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

private struct ProjectEmptyCard: View {
    let text: String
    let icon: String

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: icon)
                .foregroundStyle(.tt.iconSecondary)
            Text(text)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(TTSpacing.lg)
        .projectCard()
    }
}

private extension View {
    func projectCard() -> some View {
        background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            )
    }
}

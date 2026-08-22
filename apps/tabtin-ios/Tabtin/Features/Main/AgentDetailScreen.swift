import SwiftUI

private enum AgentDetailSection: String, CaseIterable, Identifiable {
    case memory
    case recentTasks
    case skills
    case tools

    var id: String { rawValue }

    var title: String {
        switch self {
        case .skills: return L10n.Project.myAgentsSkills
        case .tools: return L10n.Project.myAgentsTools
        case .memory: return L10n.Project.myAgentsMemory
        case .recentTasks: return L10n.Project.myAgentsRecentTasks
        }
    }
}

private enum AgentMemorySection: String, CaseIterable, Identifiable {
    case overview
    case records

    var id: String { rawValue }
    var title: String {
        switch self {
        case .overview: return L10n.Project.myAgentsMemoryOverview
        case .records: return L10n.Project.myAgentsMemoryRecords
        }
    }
}

func agentMemoryTypeLabel(_ memoryType: String) -> String {
    switch memoryType {
    case "about_you": return L10n.Project.myAgentsMemoryTypeAboutYou
    case "insight": return L10n.Project.myAgentsMemoryTypeInsight
    case "task_summary": return L10n.Project.myAgentsMemoryTypeTaskSummary
    case "diary": return L10n.Project.myAgentsMemoryTypeDiary
    default: return L10n.Project.myAgentsMemory
    }
}

func agentMemoryDisplayTitle(memoryType: String, title: String) -> String {
    let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedType = memoryType.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTitle.isEmpty,
          normalizedTitle.caseInsensitiveCompare(normalizedType) != .orderedSame else {
        return agentMemoryTypeLabel(normalizedType)
    }
    return normalizedTitle
}

/// AI分身的移动工作台：保留桌面端的身份、人设、携带技能、记忆与近期任务语义，
/// 以手机上更自然的纵向详情页承载，而不是把信息塞回列表弹层。
struct AgentDetailScreen: View {
    @State private var detailStore: AgentDetailStore
    @State private var agentsStore = MyAgentsStore.shared
    @State private var showEdit = false
    @State private var showSkillPicker = false
    @State private var skillAddedToast: String?
    @State private var showDeactivateConfirm = false
    @State private var skillToRemove: AgentSkillLink?
    @State private var memoryToForget: AgentMemoryRecord?
    @State private var memoryToCorrect: AgentMemoryRecord?
    @State private var actionError: String?
    @State private var selectedSection: AgentDetailSection = .memory
    @State private var selectedMemorySection: AgentMemorySection = .overview
    @State private var portraitStore = UserPortraitObservable()

    let onOpenConversation: (ConversationTarget) -> Void
    let onDeactivated: () -> Void

    init(
        agentId: String,
        initialAgent: OrganizationAgent? = nil,
        onOpenConversation: @escaping (ConversationTarget) -> Void,
        onDeactivated: @escaping () -> Void
    ) {
        _detailStore = State(initialValue: AgentDetailStore(
            agentId: agentId,
            initialAgent: initialAgent
        ))
        self.onOpenConversation = onOpenConversation
        self.onDeactivated = onDeactivated
    }

    var body: some View {
        Group {
            if let agent = detailStore.agent {
                detail(agent)
            } else if detailStore.isLoading {
                ProgressView(L10n.Common.loading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = detailStore.errorMessage {
                ContentUnavailableView {
                    Label(L10n.Project.myAgentsLoadFailed, systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button(L10n.Common.retry) { Task { await detailStore.load() } }
                }
            } else {
                ContentUnavailableView {
                    Label(L10n.Project.myAgentsLoadFailed, systemImage: "person.crop.circle.badge.questionmark")
                } description: {
                    Text("暂时无法获取 AI 分身详情。")
                } actions: {
                    Button(L10n.Common.retry) { Task { await detailStore.load() } }
                }
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(L10n.Project.segmentAiAvatar)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: detailStore.agentId) { await detailStore.load() }
        .sheet(isPresented: $showEdit) {
            if let agent = detailStore.agent {
                NavigationStack {
                    AgentEditSheet(agent: agent, store: agentsStore) { updated in
                        detailStore.apply(updated)
                        showEdit = false
                    }
                }
            }
        }
        .sheet(isPresented: $showSkillPicker) {
            if let agent = detailStore.agent,
               let organizationId = agent.organizationId,
               !organizationId.isEmpty {
                NavigationStack {
                    AgentSkillPickerSheet(
                        organizationId: organizationId,
                        attachedKeys: Set(detailStore.skills.map(\.skillCanonicalKey)),
                        onAttachSelected: { keys in
                            let attached = try await detailStore.attachSkills(canonicalKeys: keys)
                            guard !attached.isEmpty else { return }
                            showSkillPicker = false
                            let names = attached.map { $0.name.isEmpty ? $0.skillCanonicalKey : $0.name }
                            if let feedback = AgentSkillAttachFeedback.from(names: names) {
                                switch feedback {
                                case .single(let name):
                                    skillAddedToast = L10n.Project.myAgentsSkillAdded(name)
                                case .batch(let firstName, let count):
                                    skillAddedToast = L10n.Project.myAgentsSkillsAddedBatch(firstName, count)
                                }
                                Task {
                                    try? await Task.sleep(nanoseconds: 1_800_000_000)
                                    await MainActor.run { skillAddedToast = nil }
                                }
                            }
                        },
                        onDismiss: { showSkillPicker = false }
                    )
                }
            }
        }
        .sheet(item: $memoryToCorrect) { memory in
            NavigationStack {
                MemoryCorrectSheet(
                    memory: memory,
                    onSave: { content in
                        try await detailStore.correct(memory, content: content)
                    },
                    onDismiss: {
                        memoryToCorrect = nil
                    }
                )
            }
        }
        .alert(L10n.Project.myAgentsDeactivateTitle, isPresented: $showDeactivateConfirm) {
            Button(L10n.Project.myAgentsDeactivate, role: .destructive) {
                Task { await deactivate() }
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.Project.myAgentsDeactivateBody(detailStore.agent?.displayName ?? ""))
        }
        .alert(
            L10n.Project.myAgentsRemoveSkillTitle,
            isPresented: Binding(
                get: { skillToRemove != nil },
                set: { if !$0 { skillToRemove = nil } }
            )
        ) {
            Button(L10n.Project.myAgentsRemoveSkill, role: .destructive) {
                guard let skill = skillToRemove else { return }
                skillToRemove = nil
                Task { await remove(skill) }
            }
            Button(L10n.Common.cancel, role: .cancel) { skillToRemove = nil }
        } message: {
            Text(L10n.Project.myAgentsRemoveSkillBody(skillToRemove?.name ?? ""))
        }
        .alert(
            L10n.Project.myAgentsForgetMemoryTitle,
            isPresented: Binding(
                get: { memoryToForget != nil },
                set: { if !$0 { memoryToForget = nil } }
            )
        ) {
            Button(L10n.Project.myAgentsForgetMemory, role: .destructive) {
                guard let memory = memoryToForget else { return }
                memoryToForget = nil
                Task { await forget(memory) }
            }
            Button(L10n.Common.cancel, role: .cancel) { memoryToForget = nil }
        } message: {
            Text(L10n.Project.myAgentsForgetMemoryBody)
        }
        .alert(L10n.Project.myAgentsActionFailed, isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
        .overlay(alignment: .bottom) {
            if let skillAddedToast {
                Text(skillAddedToast)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textPrimary)
                    .padding(TTSpacing.md)
                    .frame(maxWidth: .infinity)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
                    .padding(.horizontal, TTSpacing.md)
                    .padding(.bottom, TTSpacing.xl)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3), value: skillAddedToast)
    }

    private func detail(_ agent: OrganizationAgent) -> some View {
        VStack(spacing: 0) {
            profileCard(agent)
                .padding(.horizontal, TTSpacing.md)
                .padding(.top, TTSpacing.md)

            Picker(L10n.Project.segmentAiAvatar, selection: $selectedSection) {
                ForEach(AgentDetailSection.allCases) { section in
                    Text(section.title).tag(section)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.lg)

            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.lg) {
                    sectionContent
                    if agent.isDefault != true {
                        Button(role: .destructive) { showDeactivateConfirm = true } label: {
                            Label(L10n.Project.myAgentsDeactivate, systemImage: "minus.circle")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(.tt.textCritical)
                        .disabled(agentsStore.isMutating)
                        .padding(.top, TTSpacing.sm)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, TTSpacing.md)
                .padding(.bottom, TTSpacing.xxxl)
            }
            .refreshable { await detailStore.load() }
        }
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch selectedSection {
        case .skills:
            skillsCard
        case .tools:
            toolsCard
        case .memory:
            memoryCard
        case .recentTasks:
            recentTasksCard
        }
    }

    private func profileCard(_ agent: OrganizationAgent) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            HStack(alignment: .center, spacing: TTSpacing.md) {
                AgentAvatarView(agent: agent, size: 64)
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    Text(agent.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(2)
                    HStack(spacing: TTSpacing.xs) {
                        detailPill(agent.isFromTemplate
                            ? L10n.Project.myAgentsSourceTemplate
                            : L10n.Project.myAgentsSourceCustom)
                        if agent.isDefault == true {
                            detailPill(L10n.Project.myAgentsDefault, accent: true)
                        }
                    }
                }
                Spacer(minLength: 0)
                Button(L10n.Project.myAgentsEdit) { showEdit = true }
                    .buttonStyle(.bordered)
                    .disabled(agentsStore.isMutating)
            }

            if let time = RelativeTime.format(agent.updatedAt ?? agent.createdAt ?? "") {
                Text(L10n.Project.myAgentsUpdatedAt(time))
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }
            Divider().overlay(.tt.borderLight)
            Button { showEdit = true } label: {
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    AgentDetailSectionHeader(
                        title: L10n.Project.myAgentsPersonaRules,
                        systemImage: "scroll"
                    )
                    let rules = agent.customRules?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    Text(rules.isEmpty ? L10n.Project.myAgentsDetailRulesEmpty : rules)
                        .font(.tt.meta)
                        .foregroundStyle(rules.isEmpty ? .tt.textTertiary : .tt.textPrimary)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .disabled(agentsStore.isMutating)
        }
        .agentDetailCard()
    }

    private var skillsCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text(L10n.Project.myAgentsSkillsHint)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)

            Button {
                showSkillPicker = true
            } label: {
                Label(L10n.Project.myAgentsAddSkill, systemImage: "plus")
                    .font(.tt.meta)
            }
            .buttonStyle(.bordered)
            .disabled(detailStore.agent?.organizationId?.isEmpty != false)

            if detailStore.isLoading && detailStore.skills.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if detailStore.skills.isEmpty {
                emptySection(L10n.Project.myAgentsSkillsEmpty, systemImage: "puzzlepiece.extension")
            } else {
                VStack(spacing: TTSpacing.xs) {
                    ForEach(detailStore.skills) { skill in
                        HStack(spacing: TTSpacing.sm) {
                            SkillGlyphView(size: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(skill.name)
                                    .font(.tt.metaSemibold)
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(1)
                                if let description = skill.description?.trimmingCharacters(in: .whitespacesAndNewlines),
                                   !description.isEmpty {
                                    Text(description)
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textSecondary)
                                        .lineLimit(2)
                                }
                                if skill.locked {
                                    Text(L10n.Project.myAgentsSkillLocked)
                                        .font(.tt.captionMedium)
                                        .foregroundStyle(.tt.textTertiary)
                                }
                            }
                            Spacer(minLength: 0)
                            Toggle("", isOn: Binding(
                                get: { skill.enabled },
                                set: { enabled in
                                    Task { await setSkillEnabled(skill, enabled: enabled) }
                                }
                            ))
                            .labelsHidden()
                            .disabled(skill.locked || detailStore.mutatingSkillKeys.contains(skill.id))
                            if !skill.locked {
                                Button(role: .destructive) { skillToRemove = skill } label: {
                                    Image(systemName: "minus.circle")
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel(L10n.Project.myAgentsRemoveSkill)
                                .disabled(detailStore.mutatingSkillKeys.contains(skill.id))
                            }
                        }
                        .padding(.vertical, TTSpacing.xs)
                        if skill.id != detailStore.skills.last?.id {
                            Divider().overlay(.tt.borderLight)
                        }
                    }
                }
            }
        }
        .agentDetailCard()
    }

    /// 工具携带集：问在线 Electron 的已挂载 MCP（只读列表，挂载请在电脑端管理）。
    private var toolsCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text(L10n.Project.myAgentsToolsHint)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)

            if detailStore.mcpDeviceOffline {
                Text(L10n.Project.myAgentsToolsDeviceOffline)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textWarning)
                Text(L10n.Project.myAgentsToolsManageOnDesktop)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
            } else {
                Text(L10n.Project.myAgentsToolsManageOnDesktop)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
            }

            if let mcpLoadError = detailStore.mcpLoadError, !detailStore.mcpDeviceOffline {
                Text(mcpLoadError)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textWarning)
            }

            if detailStore.isLoading && detailStore.mcpConnections.isEmpty && !detailStore.mcpDeviceOffline {
                ProgressView().frame(maxWidth: .infinity)
            } else if detailStore.mcpDeviceOffline {
                emptySection(L10n.Project.myAgentsToolsDeviceOffline, systemImage: "desktopcomputer")
            } else if detailStore.mcpConnections.isEmpty {
                emptySection(L10n.Project.myAgentsToolsNotMounted, systemImage: "cable.connector")
            } else {
                VStack(spacing: TTSpacing.xs) {
                    ForEach(detailStore.mcpConnections) { connection in
                        HStack(spacing: TTSpacing.sm) {
                            ConnectorBrandGlyphView(
                                query: .init(
                                    name: connection.name,
                                    endpointUrl: connection.endpointForBrand
                                ),
                                size: 28
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                Text(connection.name.isEmpty ? connection.id : connection.name)
                                    .font(.tt.metaSemibold)
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(1)
                                HStack(spacing: TTSpacing.xs) {
                                    Text(connection.source?.isOrganization == true
                                         ? L10n.Project.myAgentsToolsSourceOrg
                                         : L10n.Project.myAgentsToolsSourceLocal)
                                        .font(.tt.captionMedium)
                                        .foregroundStyle(.tt.textTertiary)
                                    if !connection.transportKind.isEmpty {
                                        Text(connection.transportKind.uppercased())
                                            .font(.tt.caption)
                                            .foregroundStyle(.tt.textTertiary)
                                    }
                                }
                                if !connection.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                    Text(connection.description)
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textSecondary)
                                        .lineLimit(2)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, TTSpacing.xs)
                        .accessibilityHint(L10n.Project.myAgentsToolsManageOnDesktop)
                        if connection.id != detailStore.mcpConnections.last?.id {
                            Divider().overlay(.tt.borderLight)
                        }
                    }
                }
            }
        }
        .agentDetailCard()
    }

    private var memoryCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Picker(L10n.Project.myAgentsMemory, selection: $selectedMemorySection) {
                ForEach(AgentMemorySection.allCases) { section in
                    Text(section.title).tag(section)
                }
            }
            .pickerStyle(.segmented)

            Text(selectedMemorySection == .overview
                 ? L10n.Project.myAgentsMemoryOverviewHint
                 : L10n.Project.myAgentsMemoryRecordsHint)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)

            if selectedMemorySection == .overview, let agent = detailStore.agent {
                UserPortraitPanelView(
                    observable: portraitStore,
                    organizationId: agent.organizationId ?? "",
                    agentId: agent.id,
                    canManage: true
                )
            } else if detailStore.isLoading && detailStore.memories.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if detailStore.memories.isEmpty {
                emptySection(L10n.Project.myAgentsMemoryEmpty, systemImage: "brain")
            } else {
                VStack(spacing: TTSpacing.md) {
                    ForEach(detailStore.memories) { memory in
                        VStack(alignment: .leading, spacing: TTSpacing.xs) {
                            HStack(alignment: .firstTextBaseline, spacing: TTSpacing.sm) {
                                Text(agentMemoryDisplayTitle(
                                    memoryType: memory.memoryType,
                                    title: memory.title
                                ))
                                    .font(.tt.metaSemibold)
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(1)
                                Spacer()
                                Button(L10n.Project.myAgentsCorrectMemory) {
                                    memoryToCorrect = memory
                                }
                                .buttonStyle(.borderless)
                                .font(.tt.captionMedium)
                                .disabled(
                                    detailStore.forgettingMemoryIds.contains(memory.id) ||
                                    detailStore.correctingMemoryIds.contains(memory.id)
                                )
                                Button(L10n.Project.myAgentsForgetMemory, role: .destructive) {
                                    memoryToForget = memory
                                }
                                .buttonStyle(.borderless)
                                .font(.tt.captionMedium)
                                .disabled(
                                    detailStore.forgettingMemoryIds.contains(memory.id) ||
                                    detailStore.correctingMemoryIds.contains(memory.id)
                                )
                            }
                            Text(memory.content)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                                .lineLimit(3)
                            if !memory.tags.isEmpty {
                                Text(memory.tags.prefix(3).map { "#\($0)" }.joined(separator: "  "))
                                    .font(.tt.captionMedium)
                                    .foregroundStyle(.tt.textTertiary)
                                    .lineLimit(1)
                            }
                        }
                        if memory.id != detailStore.memories.last?.id {
                            Divider().overlay(.tt.borderLight)
                        }
                    }
                }
            }
        }
        .agentDetailCard()
    }

    private var recentTasksCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text(L10n.Project.myAgentsRecentTasksHint)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)

            if detailStore.isLoading && detailStore.sessions.isEmpty && detailStore.projectTasks.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if detailStore.sessions.isEmpty && detailStore.projectTasks.isEmpty {
                emptySection(L10n.Project.myAgentsRecentTasksEmpty, systemImage: "checklist")
            } else {
                VStack(spacing: TTSpacing.xs) {
                    ForEach(detailStore.sessions.prefix(10)) { session in
                        recentSessionRow(session)
                    }
                    ForEach(detailStore.projectTasks.prefix(10)) { task in
                        projectTaskRow(task)
                    }
                }
            }
        }
        .agentDetailCard()
    }

    @ViewBuilder
    private func recentSessionRow(_ session: RecentSession) -> some View {
        if let target = RecentConversationTargetResolver.resolve(
            session,
            fallbackOrganizationId: WorkspaceStore.shared.selectedOrganizationId
        ) {
            Button { onOpenConversation(target) } label: {
                activityRow(
                    title: session.displayTitle,
                    subtitle: session.spaceName ?? session.projectName ?? L10n.Project.myAgentsChat,
                    time: session.displayTime,
                    systemImage: "bubble.left.and.bubble.right"
                )
            }
            .buttonStyle(.plain)
        } else {
            activityRow(
                title: session.displayTitle,
                subtitle: session.spaceName ?? session.projectName ?? L10n.Project.myAgentsChat,
                time: session.displayTime,
                systemImage: "bubble.left.and.bubble.right"
            )
        }
    }

    private func projectTaskRow(_ task: AgentProjectTask) -> some View {
        activityRow(
            title: task.title,
            subtitle: task.project?.name ?? task.workStatus ?? task.assignmentStatus ?? L10n.Project.myAgentsProjectTask,
            time: RelativeTime.format(task.updatedAt ?? ""),
            systemImage: "checkmark.circle"
        )
    }

    private func activityRow(title: String, subtitle: String, time: String?, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: systemImage)
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 22, height: 22)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                Text(subtitle)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if let time {
                Text(time)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, TTSpacing.xs)
    }

    private func detailPill(_ title: String, accent: Bool = false) -> some View {
        Text(title)
            .font(.tt.captionMedium)
            .foregroundStyle(accent ? .tt.textAccent : .tt.textSecondary)
            .padding(.horizontal, TTSpacing.xs)
            .padding(.vertical, 3)
            .background(
                accent ? Color.tt.bgAccent.opacity(0.12) : Color.tt.bgSubtle,
                in: Capsule()
            )
    }

    private func emptySection(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.tt.meta)
            .foregroundStyle(.tt.textTertiary)
            .frame(maxWidth: .infinity, minHeight: 76)
    }

    private func setSkillEnabled(_ skill: AgentSkillLink, enabled: Bool) async {
        do {
            try await detailStore.setSkillEnabled(skill, enabled: enabled)
        } catch {
            guard !error.isCancellation else { return }
            actionError = error.localizedDescription
        }
    }

    private func remove(_ skill: AgentSkillLink) async {
        do {
            try await detailStore.removeSkill(skill)
        } catch {
            guard !error.isCancellation else { return }
            actionError = error.localizedDescription
        }
    }

    private func forget(_ memory: AgentMemoryRecord) async {
        do {
            try await detailStore.forget(memory)
        } catch {
            guard !error.isCancellation else { return }
            actionError = error.localizedDescription
        }
    }

    private func deactivate() async {
        guard let agent = detailStore.agent else { return }
        do {
            try await agentsStore.deactivate(agentId: agent.id)
            onDeactivated()
        } catch {
            guard !error.isCancellation else { return }
            actionError = error.localizedDescription
        }
    }
}

private struct MemoryCorrectSheet: View {
    let memory: AgentMemoryRecord
    let onSave: (String) async throws -> Void
    let onDismiss: () -> Void

    @State private var draft: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        memory: AgentMemoryRecord,
        onSave: @escaping (String) async throws -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.memory = memory
        self.onSave = onSave
        self.onDismiss = onDismiss
        _draft = State(initialValue: memory.content)
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        !isSaving && !trimmedDraft.isEmpty && trimmedDraft != memory.content
    }

    var body: some View {
        Form {
            Section {
                TextField(L10n.Project.myAgentsCorrectMemoryTitle, text: $draft, axis: .vertical)
                    .lineLimit(4...10)
                    .disabled(isSaving)
            } footer: {
                Text(L10n.Project.myAgentsCorrectMemoryHint)
            }
        }
        .navigationTitle(L10n.Project.myAgentsCorrectMemoryTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(L10n.Common.cancel) { onDismiss() }
                    .disabled(isSaving)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if isSaving {
                        ProgressView()
                    } else {
                        Text(L10n.Common.save)
                    }
                }
                .disabled(!canSave)
            }
        }
        .alert(L10n.Project.myAgentsActionFailed, isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func save() async {
        guard canSave else {
            onDismiss()
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            try await onSave(trimmedDraft)
            onDismiss()
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }
}

private struct AgentDetailSectionHeader: View {
    let title: String
    let systemImage: String

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(.tt.bodySemibold)
            .foregroundStyle(.tt.textPrimary)
    }
}

/// 从组织可见技能池挑选未携带项，挂到当前 AI 分身；支持勾选后批量添加。
private struct AgentSkillPickerSheet: View {
    let organizationId: String
    let attachedKeys: Set<String>
    let onAttachSelected: ([String]) async throws -> Void
    let onDismiss: () -> Void

    @State private var candidates: [AgentSkillPickerCandidate] = []
    @State private var searchText = ""
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var selectedKeys: Set<String> = []
    @State private var isSubmitting = false
    @State private var actionError: String?

    private var filtered: [AgentSkillPickerCandidate] {
        AgentSkillPickerFilter.available(
            catalog: candidates,
            attachedKeys: attachedKeys,
            query: searchText
        )
    }

    private var selectedSkills: [AgentSkillPickerCandidate] {
        filtered.filter { selectedKeys.contains($0.canonicalKey) }
    }

    var body: some View {
        List {
            Section {
                TextField(L10n.Project.myAgentsAddSkillSearch, text: $searchText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            if isLoading && candidates.isEmpty {
                HStack {
                    Spacer()
                    ProgressView(L10n.Common.loading)
                    Spacer()
                }
                .listRowSeparator(.hidden)
            } else if let loadError, candidates.isEmpty {
                Text(loadError)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textCritical)
                    .listRowSeparator(.hidden)
            } else if filtered.isEmpty {
                ContentUnavailableView(
                    L10n.Project.myAgentsAddSkillEmpty,
                    systemImage: "puzzlepiece.extension",
                    description: Text(searchText.isEmpty
                        ? "组织可见技能都已在携带集中，或暂时没有可添加项。"
                        : "换个关键词再试试。")
                )
                .listRowSeparator(.hidden)
            } else {
                Section {
                    ForEach(filtered) { skill in
                        Button {
                            toggle(skill)
                        } label: {
                            HStack(alignment: .top, spacing: TTSpacing.sm) {
                                Image(systemName: selectedKeys.contains(skill.canonicalKey)
                                      ? "checkmark.circle.fill"
                                      : "circle")
                                    .foregroundStyle(selectedKeys.contains(skill.canonicalKey)
                                                     ? .tt.iconAccent
                                                     : .tt.textTertiary)
                                SkillGlyphView(size: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(skill.name)
                                        .font(.tt.metaSemibold)
                                        .foregroundStyle(.tt.textPrimary)
                                        .lineLimit(1)
                                    if !skill.description.isEmpty {
                                        Text(skill.description)
                                            .font(.tt.caption)
                                            .foregroundStyle(.tt.textSecondary)
                                            .lineLimit(2)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(isSubmitting)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(L10n.Project.myAgentsAddSkillTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(L10n.Common.cancel) { onDismiss() }
                    .disabled(isSubmitting)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    submit()
                } label: {
                    if isSubmitting {
                        ProgressView()
                    } else if selectedSkills.count <= 1 {
                        Text(L10n.Project.myAgentsAddSkillAction)
                    } else {
                        Text(L10n.Project.myAgentsAddSkillActionCount(selectedSkills.count))
                    }
                }
                .disabled(selectedSkills.isEmpty || isSubmitting)
            }
        }
        .interactiveDismissDisabled(isSubmitting)
        .task(id: organizationId) { await load() }
        .onChange(of: attachedKeys) { _, newKeys in
            selectedKeys.subtract(newKeys)
        }
        .alert(L10n.Project.myAgentsActionFailed, isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
    }

    private func load() async {
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            let response: AgentSkillPickerCatalogResponse = try await APIClient.shared.get(
                path: Endpoints.Skills.visible,
                query: ["organization_id": organizationId]
            )
            candidates = response.skills
        } catch {
            guard !error.isCancellation else { return }
            loadError = error.localizedDescription
        }
    }

    private func toggle(_ skill: AgentSkillPickerCandidate) {
        if selectedKeys.contains(skill.canonicalKey) {
            selectedKeys.remove(skill.canonicalKey)
        } else {
            selectedKeys.insert(skill.canonicalKey)
        }
    }

    private func submit() {
        let keys = selectedSkills.map(\.canonicalKey)
        guard !keys.isEmpty, !isSubmitting else { return }
        isSubmitting = true
        Task {
            defer { isSubmitting = false }
            do {
                try await onAttachSelected(keys)
            } catch {
                guard !error.isCancellation else { return }
                actionError = error.localizedDescription
            }
        }
    }
}


enum AgentSkillAttachFeedback: Equatable {
    case single(name: String)
    case batch(firstName: String, count: Int)

    static func from(names: [String]) -> AgentSkillAttachFeedback? {
        let cleaned = names
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard let first = cleaned.first else { return nil }
        if cleaned.count == 1 {
            return .single(name: first)
        }
        return .batch(firstName: first, count: cleaned.count)
    }
}

enum AgentSkillPickerFilter {

    static func available(
        catalog: [AgentSkillPickerCandidate],
        attachedKeys: Set<String>,
        query: String
    ) -> [AgentSkillPickerCandidate] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return catalog.filter { skill in
            guard !attachedKeys.contains(skill.canonicalKey) else { return false }
            return SkillMarketFilters.matchesVisibleSearch(
                query: trimmed,
                visibleFields: [skill.name, skill.description]
            )
        }
    }
}

struct AgentSkillPickerCandidate: Identifiable, Equatable, Sendable {
    let canonicalKey: String
    let name: String
    let description: String
    let emoji: String

    var id: String { canonicalKey }

}

private struct AgentSkillPickerCatalogResponse: Decodable {
    let skills: [AgentSkillPickerCandidate]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let entries = try container.decodeIfPresent([AgentSkillPickerCatalogEntry].self, forKey: .skills) ?? []
        skills = entries.map {
            AgentSkillPickerCandidate(
                canonicalKey: $0.canonicalKey,
                name: $0.displayName,
                description: $0.description,
                emoji: $0.emoji
            )
        }
    }

    private enum CodingKeys: String, CodingKey { case skills }
}

private struct AgentSkillPickerCatalogEntry: Decodable {
    let canonicalKey: String
    let displayName: String
    let description: String
    let emoji: String

    private enum CodingKeys: String, CodingKey {
        case skillId = "skill_id"
        case skillKey = "skill_key"
        case name
        case displayName = "display_name"
        case description, emoji
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let skillId = try c.decodeIfPresent(String.self, forKey: .skillId) ?? ""
        canonicalKey = try c.decodeIfPresent(String.self, forKey: .skillKey) ?? skillId
        let name = try c.decodeIfPresent(String.self, forKey: .name) ?? canonicalKey
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? name
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji) ?? ""
    }
}

private extension View {
    func agentDetailCard() -> some View {
        padding(TTSpacing.md)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

@MainActor @Observable
final class AgentDetailStore {
    let agentId: String
    private(set) var agent: OrganizationAgent?
    private(set) var skills: [AgentSkillLink] = []
    /// Electron 本机已挂载且启用的 MCP（不是组织全量列表）。
    private(set) var mcpConnections: [AgentLocalMcpAttachment] = []
    /// 电脑离线 / 无可用 Electron / 查询超时。
    private(set) var mcpDeviceOffline = false
    private(set) var mcpLoadError: String?
    private(set) var memories: [AgentMemoryRecord] = []
    private(set) var sessions: [RecentSession] = []
    private(set) var projectTasks: [AgentProjectTask] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var mutatingSkillKeys: Set<String> = []
    private(set) var forgettingMemoryIds: Set<String> = []
    private(set) var correctingMemoryIds: Set<String> = []

    init(agentId: String, initialAgent: OrganizationAgent? = nil) {
        self.agentId = agentId
        agent = initialAgent
    }

    func load() async {
        guard !agentId.isEmpty else { return }
        isLoading = agent == nil
        errorMessage = nil
        mcpDeviceOffline = false
        mcpLoadError = nil
        defer { isLoading = false }

        do {
            let loaded: OrganizationAgent = try await APIClient.shared.get(
                path: Endpoints.Agent.detail(agentId)
            )
            agent = loaded
            let organizationId = loaded.organizationId ?? WorkspaceStore.shared.selectedOrganizationId ?? ""
            guard !organizationId.isEmpty else { return }

            async let skillsResponse = loadSkills()
            async let mcpResult = loadMcpAttachments()
            async let memoriesResponse = loadMemories(organizationId: organizationId)
            async let sessionsResponse = loadSessions(organizationId: organizationId)
            async let tasksResponse = loadProjectTasks(organizationId: organizationId)

            skills = await skillsResponse?.skills ?? []
            let mcp = await mcpResult
            mcpConnections = mcp.connections
            mcpDeviceOffline = mcp.deviceOffline
            mcpLoadError = mcp.errorMessage
            memories = await memoriesResponse?.items ?? []
            sessions = await sessionsResponse?.sessions ?? []
            projectTasks = await tasksResponse?.tasks ?? []
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func apply(_ updated: OrganizationAgent) {
        agent = updated
    }

    func setSkillEnabled(_ skill: AgentSkillLink, enabled: Bool) async throws {
        guard !skill.locked, mutatingSkillKeys.insert(skill.id).inserted else { return }
        defer { mutatingSkillKeys.remove(skill.id) }
        let updated: AgentSkillLink = try await APIClient.shared.patch(
            path: Endpoints.Agent.skill(agentId, key: skill.skillCanonicalKey),
            body: ["enabled": enabled]
        )
        replaceSkill(updated)
    }

    func attachSkill(canonicalKey: String) async throws {
        _ = try await attachSkills(canonicalKeys: [canonicalKey])
    }

    @discardableResult
    func attachSkills(canonicalKeys: [String]) async throws -> [AgentSkillLink] {
        // 保序去重，批量提示「已添加 xx 等 n 个」以勾选顺序的首个名为准。
        var seen = Set<String>()
        var keys: [String] = []
        for raw in canonicalKeys {
            let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            keys.append(key)
        }
        guard !keys.isEmpty else { return [] }

        var attached: [AgentSkillLink] = []
        var lastError: Error?
        for key in keys {
            guard mutatingSkillKeys.insert(key).inserted else { continue }
            defer { mutatingSkillKeys.remove(key) }
            do {
                let link: AgentSkillLink = try await APIClient.shared.post(
                    path: Endpoints.Agent.skills(agentId),
                    body: ["skill_canonical_key": key, "enabled": true]
                )
                replaceSkill(link)
                attached.append(link)
            } catch {
                guard !error.isCancellation else { throw error }
                lastError = error
            }
        }
        if attached.isEmpty, let lastError {
            throw lastError
        }
        return attached
    }

    func removeSkill(_ skill: AgentSkillLink) async throws {
        guard !skill.locked, mutatingSkillKeys.insert(skill.id).inserted else { return }
        defer { mutatingSkillKeys.remove(skill.id) }
        let _: AgentSkillRemovalResult = try await APIClient.shared.delete(
            path: Endpoints.Agent.skill(agentId, key: skill.skillCanonicalKey)
        )
        skills.removeAll { $0.id == skill.id }
    }

    func forget(_ memory: AgentMemoryRecord) async throws {
        guard let organizationId = agent?.organizationId ?? WorkspaceStore.shared.selectedOrganizationId,
              forgettingMemoryIds.insert(memory.id).inserted else { return }
        defer { forgettingMemoryIds.remove(memory.id) }
        let _: AgentMemoryMutationResult = try await APIClient.shared.post(
            path: Endpoints.AgentMemory.forget(memory.id),
            body: [
                "organization_id": organizationId,
                "agent_id": agentId,
            ]
        )
        memories.removeAll { $0.id == memory.id }
    }

    func correct(_ memory: AgentMemoryRecord, content: String) async throws {
        guard let organizationId = agent?.organizationId ?? WorkspaceStore.shared.selectedOrganizationId,
              correctingMemoryIds.insert(memory.id).inserted else { return }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != memory.content else {
            correctingMemoryIds.remove(memory.id)
            return
        }
        defer { correctingMemoryIds.remove(memory.id) }
        let replacement: AgentMemoryRecord = try await APIClient.shared.post(
            path: Endpoints.AgentMemory.correct(memory.id),
            body: [
                "organization_id": organizationId,
                "agent_id": agentId,
                "content": trimmed,
                "memory_type": memory.memoryType,
            ]
        )
        if let index = memories.firstIndex(where: { $0.id == memory.id }) {
            memories[index] = replacement
        } else {
            memories.insert(replacement, at: 0)
        }
    }

    private func replaceSkill(_ updated: AgentSkillLink) {
        if let index = skills.firstIndex(where: { $0.id == updated.id }) {
            skills[index] = updated
        } else {
            skills.append(updated)
        }
    }

    private func loadSkills() async -> AgentSkillLinkListResponse? {
        try? await APIClient.shared.get(path: Endpoints.Agent.skills(agentId))
    }

    /// 按 agentId 问在线 Electron；离线码映射为 deviceOffline，其它失败记 mcpLoadError。
    private func loadMcpAttachments() async -> McpAttachmentsLoadResult {
        do {
            let response: AgentLocalMcpAttachmentListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.localMcpAttachments(agentId: agentId)
            )
            return McpAttachmentsLoadResult(connections: response.connections)
        } catch {
            guard !error.isCancellation else { return McpAttachmentsLoadResult() }
            if Self.isDeviceRuntimeUnavailable(error) {
                return McpAttachmentsLoadResult(deviceOffline: true)
            }
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return McpAttachmentsLoadResult(errorMessage: message)
        }
    }

    /// HTTP 409 `DEVICE_RUNTIME_*` 与 504 `TASK_TIMEOUT` 均视为电脑侧不可达。
    private static func isDeviceRuntimeUnavailable(_ error: Error) -> Bool {
        let code = (error as? APIError)?.businessCode?.uppercased() ?? ""
        if code == "DEVICE_RUNTIME_OFFLINE"
            || code == "DEVICE_RUNTIME_UNAVAILABLE"
            || code == "TASK_TIMEOUT" {
            return true
        }
        if let apiError = error as? APIError,
           case .serverError(let status, _) = apiError {
            // 裸 409/504 且无业务码时也按不可达处理（契约未合入时的兜底）。
            return (status == 409 || status == 504) && code.isEmpty
        }
        return false
    }

    private func loadMemories(organizationId: String) async -> AgentMemoryRecordListResponse? {
        try? await APIClient.shared.get(
            path: Endpoints.AgentMemory.memories,
            query: [
                "organization_id": organizationId,
                "agent_id": agentId,
                "limit": "20",
                "governance_view": "true",
            ]
        )
    }

    private func loadSessions(organizationId: String) async -> RecentSessionListResponse? {
        try? await APIClient.shared.get(
            path: Endpoints.Chat.sessionsAll,
            query: [
                "organization_id": organizationId,
                "agent_id": agentId,
                "status": "active",
                "limit": "10",
            ]
        )
    }

    private func loadProjectTasks(organizationId: String) async -> AgentProjectTaskListResponse? {
        try? await APIClient.shared.get(
            path: Endpoints.Context.agentProjectTasks(organizationId: organizationId, agentId: agentId),
            query: ["limit": "10"]
        )
    }
}

private struct McpAttachmentsLoadResult: Sendable {
    var connections: [AgentLocalMcpAttachment] = []
    var deviceOffline = false
    var errorMessage: String?
}

import Foundation
import SwiftUI

/// 移动端自动化：以按时间的日程列表承载现有 Tracker，不把桌面周/月密集日历硬塞到手机。
struct MobileAutomationScreen: View {
    let organizationId: String
    let workspaces: [Space]

    @State private var agents = MyAgentsStore.shared
    @State private var router = MainRouter.shared
    @State private var store: TabTrackerStore
    @State private var selectedTab: MobileAutomationTab = .schedule
    @State private var authoringRequest: AutomationAuthoringRequest?
    @State private var templates: [TrackerTemplate] = []
    @State private var isLoadingTemplates = false
    @State private var templateError: String?
    @State private var draft: MobileAutomationDraft?

    init(organizationId: String, workspaces: [Space]) {
        self.organizationId = organizationId
        self.workspaces = workspaces
        _store = State(initialValue: TabTrackerStore(organizationId: organizationId))
    }

    private var activeAgents: [OrganizationAgent] {
        agents.agents.filter { $0.isActive != false }
    }

    private var scheduledTrackers: [Tracker] {
        store.trackers.sorted { lhs, rhs in
            let lhsNext = TrackerDateFormatting.parse(lhs.nextRunAt) ?? .distantFuture
            let rhsNext = TrackerDateFormatting.parse(rhs.nextRunAt) ?? .distantFuture
            if lhsNext != rhsNext { return lhsNext < rhsNext }
            return lhs.createdAt > rhs.createdAt
        }
    }

    var body: some View {
        List {
            Section {
                Picker("内容", selection: $selectedTab) {
                    ForEach(MobileAutomationTab.allCases) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
            }

            switch selectedTab {
            case .schedule:
                scheduleContent
            case .templates:
                templateContent
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("自动化")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    draft = MobileAutomationDraft()
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("新建自动化任务")
            }
        }
        .navigationDestination(for: Tracker.self) { tracker in
            MobileAutomationDetailDestination(
                store: store,
                trackerId: tracker.id,
                // 本屏只管新建，编辑复用与列表页同一套 AutomationAuthoringSheet——
                // 两处各写一份表单迟早会让校验口径分叉。
                onRequestEdit: { target in
                    authoringRequest = .edit(target, workspaceId: target.workspaceId ?? target.spaceId)
                }
            )
        }
        .task(id: organizationId) {
            await load()
        }
        .onDisappear {
            store.stopRealtime()
        }
        .refreshable {
            await refresh()
        }
        .sheet(item: $draft) { draft in
            MobileAutomationEditorSheet(
                draft: draft,
                agents: activeAgents,
                workspaces: workspaces,
                store: store,
                onCreated: {
                    Task { await store.loadTrackers() }
                }
            )
            .presentationDetents([.large])
        }
        .sheet(item: $authoringRequest) { request in
            // 手机端不提供「转交 Agent 接着聊」——那条路径依赖列表页的会话回链上下文。
            AutomationAuthoringSheet(
                request: request,
                canHandOffToAgent: false,
                onHandOff: {}
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var scheduleContent: some View {
        if store.isLoading && store.trackers.isEmpty {
            HStack {
                Spacer()
                ProgressView("正在加载日程…")
                Spacer()
            }
            .listRowSeparator(.hidden)
        } else if let error = store.loadError, store.trackers.isEmpty {
            TTErrorStateView(
                message: error,
                systemImage: nil,
                prominence: .inline,
                palette: .critical
            ) { Task { await store.loadTrackers() } }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TTSpacing.xl)
            .listRowSeparator(.hidden)
        } else if scheduledTrackers.isEmpty {
            ContentUnavailableView(
                "还没有自动化任务",
                systemImage: "clock.badge.plus",
                description: Text("点击右上角 +，选择任务、执行 AI 分身、工作区与频率。")
            )
            .frame(maxWidth: .infinity)
            .padding(.vertical, TTSpacing.xxl)
            .listRowSeparator(.hidden)
        } else {
            Section("按时间") {
                ForEach(scheduledTrackers) { tracker in
                    NavigationLink(value: tracker) {
                        MobileAutomationRow(tracker: tracker, agentName: agentName(for: tracker))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var templateContent: some View {
        if isLoadingTemplates && templates.isEmpty {
            HStack {
                Spacer()
                ProgressView("正在加载模板…")
                Spacer()
            }
            .listRowSeparator(.hidden)
        } else if let templateError, templates.isEmpty {
            TTErrorStateView(
                message: templateError,
                systemImage: nil,
                prominence: .inline,
                palette: .critical
            ) { Task { await loadTemplates() } }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TTSpacing.xl)
            .listRowSeparator(.hidden)
        } else {
            Section {
                ForEach(templates) { template in
                    Button {
                        draft = MobileAutomationDraft(template: template)
                    } label: {
                        MobileAutomationTemplateRow(template: template)
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text("模板")
            } footer: {
                Text("模板只会预填任务和频率；创建前仍由你确认执行 AI 分身和工作区。")
            }
        }
    }

    private func agentName(for tracker: Tracker) -> String? {
        guard let agentId = tracker.agentId else { return nil }
        return activeAgents.first(where: { $0.id == agentId })?.displayName
    }

    private func load() async {
        // 订阅按 Workspace 分 topic；不传就等于不订阅，列表将收不到运行进度推送。
        store.startRealtime(workspaceIds: workspaces.map(\.id))
        async let agentsLoad: Void = agents.load(organizationId: organizationId)
        async let trackersLoad: Void = store.loadTrackers()
        async let templatesLoad: Void = loadTemplates()
        _ = await (agentsLoad, trackersLoad, templatesLoad)
    }

    private func refresh() async {
        async let trackersLoad: Void = store.loadTrackers()
        async let templatesLoad: Void = loadTemplates()
        _ = await (trackersLoad, templatesLoad)
    }

    private func loadTemplates() async {
        isLoadingTemplates = templates.isEmpty
        templateError = nil
        defer { isLoadingTemplates = false }
        do {
            templates = try await store.loadTemplates()
        } catch {
            guard !error.isCancellation else { return }
            templateError = error.localizedDescription
        }
    }
}

/// 详情页的 push 包装。
///
/// ``TrackerDetailScreen`` 把「删完之后去哪」交给调用方决定；列表页用自己的
/// selection 状态收口，而本屏走 `NavigationLink(value:)`，路径在祖先 stack 里、
/// 拿不到。这里用 `dismiss` 就地出栈，免得为此改动别处也在用的详情页。
private struct MobileAutomationDetailDestination: View {
    let store: TabTrackerStore
    let trackerId: String
    let onRequestEdit: (Tracker) -> Void

    @State private var router = MainRouter.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        TrackerDetailScreen(
            store: store,
            trackerId: trackerId,
            initialRunId: nil,
            onOpenConversation: { router.openConversation($0) },
            onRequestEdit: onRequestEdit,
            showsCloseButton: false,
            onClose: {},
            onDeleted: { dismiss() }
        )
    }
}

private enum MobileAutomationTab: String, CaseIterable, Identifiable {
    case schedule
    case templates

    var id: String { rawValue }
    var title: String { self == .schedule ? "日程" : "模板" }
}

private struct MobileAutomationRow: View {
    let tracker: Tracker
    let agentName: String?

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: tracker.triggerType.displayIcon)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 26, height: 26)
                .background(Color.tt.bgSubtleSecondary, in: RoundedRectangle(cornerRadius: TTRadius.xs))

            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xs) {
                    Text(tracker.name)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    TrackerStatusBadge(status: tracker.status)
                }
                Text(scheduleSummary)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
                if let agentName, !agentName.isEmpty {
                    Text("由 \(agentName) 执行")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                }
            }

            Spacer(minLength: 0)
            if let next = TrackerDateFormatting.display(tracker.nextRunAt), tracker.status == .active {
                Text(next)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .multilineTextAlignment(.trailing)
            }
        }
        .padding(.vertical, TTSpacing.xxs)
    }

    private var scheduleSummary: String {
        MobileAutomationFrequency.summary(triggerType: tracker.triggerType, config: tracker.triggerConfig)
    }
}

private struct MobileAutomationTemplateRow: View {
    let template: TrackerTemplate

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: systemImage)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 28, height: 28)
                .background(Color.tt.bgSubtleSecondary, in: RoundedRectangle(cornerRadius: TTRadius.xs))
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(template.name)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                Text(template.description)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(2)
                Text(MobileAutomationFrequency.summary(triggerType: template.triggerType, config: template.triggerConfig))
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.tt.iconCaptionMedium)
                .foregroundStyle(.tt.textTertiary)
                .padding(.top, 6)
        }
        .padding(.vertical, TTSpacing.xxs)
    }

    private var systemImage: String {
        switch template.iconKey {
        case "newspaper": return "newspaper"
        case "file-text": return "doc.text"
        case "users": return "person.2"
        case "messages-square": return "bubble.left.and.bubble.right"
        case "book-open": return "book"
        default: return "sparkles"
        }
    }
}

struct MobileAutomationEditorSheet: View {
    let draft: MobileAutomationDraft
    let agents: [OrganizationAgent]
    let workspaces: [Space]
    let store: TabTrackerStore
    let onCreated: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var instructions: String
    @State private var selectedAgentId: String
    @State private var selectedWorkspaceId: String
    @State private var frequency: MobileAutomationFrequency
    @State private var runAt: Date
    @State private var isCreating = false
    @State private var creationError: String?

    init(
        draft: MobileAutomationDraft,
        agents: [OrganizationAgent],
        workspaces: [Space],
        store: TabTrackerStore,
        initialWorkspaceId: String? = nil,
        onCreated: @escaping () -> Void
    ) {
        self.draft = draft
        self.agents = agents
        self.workspaces = workspaces
        self.store = store
        self.onCreated = onCreated
        _name = State(initialValue: draft.name)
        _instructions = State(initialValue: draft.instructions)
        _selectedAgentId = State(initialValue: agents.first(where: { $0.isDefault == true })?.id ?? agents.first?.id ?? "")
        _selectedWorkspaceId = State(initialValue: workspaces.first(where: { $0.id == initialWorkspaceId })?.id ?? workspaces.first?.id ?? "")
        _frequency = State(initialValue: draft.frequency)
        _runAt = State(initialValue: draft.runAt)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("任务") {
                    TextField("自动化任务名称", text: $name)
                    VStack(alignment: .leading, spacing: TTSpacing.xs) {
                        Text("任务说明")
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                        TextEditor(text: $instructions)
                            .frame(minHeight: 110)
                    }
                }

                Section("谁来执行") {
                    Picker("AI 分身", selection: $selectedAgentId) {
                        if agents.isEmpty {
                            Text("暂无可用 AI 分身").tag("")
                        } else {
                            ForEach(agents) { agent in
                                Text(agent.displayName).tag(agent.id)
                            }
                        }
                    }
                    Picker("工作区", selection: $selectedWorkspaceId) {
                        if workspaces.isEmpty {
                            Text("暂无可用工作区").tag("")
                        } else {
                            ForEach(workspaces) { workspace in
                                Text(workspace.name).tag(workspace.id)
                            }
                        }
                    }
                }

                Section {
                    Picker("频率", selection: $frequency) {
                        ForEach(MobileAutomationFrequency.allCases) { frequency in
                            Text(frequency.title).tag(frequency)
                        }
                    }
                    if frequency != .manual {
                        DatePicker("执行时间", selection: $runAt, displayedComponents: .hourAndMinute)
                    }
                } header: {
                    Text("何时执行")
                } footer: {
                    Text(frequency.description)
                }
            }
            .navigationTitle("新建自动化任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isCreating ? "创建中…" : "创建") {
                        create()
                    }
                    .disabled(
                        isCreating ||
                        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        selectedAgentId.isEmpty ||
                        selectedWorkspaceId.isEmpty
                    )
                }
            }
        }
        .alert("创建失败", isPresented: Binding(
            get: { creationError != nil },
            set: { if !$0 { creationError = nil } }
        )) {
            Button("好", role: .cancel) { creationError = nil }
        } message: {
            Text(creationError ?? "")
        }
    }

    private func create() {
        guard !isCreating else { return }
        isCreating = true
        Task {
            defer { isCreating = false }
            do {
                let trigger = frequency.trigger(runAt: runAt)
                var snapshot: [String: Any] = [
                    "created_via": "ui",
                    "final_values": [
                        "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
                        "instructions": instructions.trimmingCharacters(in: .whitespacesAndNewlines),
                        "agent_id": selectedAgentId,
                        "workspace_id": selectedWorkspaceId,
                        "frequency": frequency.rawValue,
                        "activate_on_create": true,
                    ],
                ]
                if let templateId = draft.templateId { snapshot["template_id"] = templateId }
                if let templateVersion = draft.templateVersion { snapshot["template_version"] = templateVersion }
                let created = try await store.createTracker(
                    name: name,
                    description: "",
                    triggerType: trigger.type,
                    triggerConfig: trigger.config,
                    agentId: selectedAgentId,
                    workspaceId: selectedWorkspaceId,
                    instructions: instructions,
                    intentSnapshot: snapshot
                )
                try await store.activateTracker(created.id)
                onCreated()
                dismiss()
            } catch {
                creationError = error.localizedDescription
            }
        }
    }
}

struct MobileAutomationDraft: Identifiable {
    let id = UUID()
    let name: String
    let instructions: String
    let frequency: MobileAutomationFrequency
    let runAt: Date
    let templateId: String?
    let templateVersion: String?

    init() {
        name = ""
        instructions = ""
        frequency = .weekdays
        runAt = Self.defaultTime(hour: 9, minute: 0)
        templateId = nil
        templateVersion = nil
    }

    init(template: TrackerTemplate) {
        name = template.defaultName
        instructions = template.instructions
        frequency = MobileAutomationFrequency.from(template: template)
        runAt = Self.time(from: template.triggerConfig) ?? Self.defaultTime(hour: 9, minute: 0)
        templateId = template.id
        templateVersion = template.version
    }

    private static func time(from config: [String: AnyCodable]) -> Date? {
        let cron = config["cron_expression"]?.stringValue ?? config["expression"]?.stringValue ?? ""
        let parts = cron.split(separator: " ")
        guard parts.count == 5, let minute = Int(parts[0]), let hour = Int(parts[1]) else { return nil }
        return defaultTime(hour: hour, minute: minute)
    }

    private static func defaultTime(hour: Int, minute: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }
}

enum MobileAutomationFrequency: String, CaseIterable, Identifiable {
    case everyDay
    case weekdays
    case weekly
    case manual

    var id: String { rawValue }

    var title: String {
        switch self {
        case .everyDay: return "每天"
        case .weekdays: return "工作日"
        case .weekly: return "每周一"
        case .manual: return "手动运行"
        }
    }

    var description: String {
        switch self {
        case .everyDay: return "每天在所选时间自动运行。"
        case .weekdays: return "每个工作日在所选时间自动运行。"
        case .weekly: return "每周一在所选时间自动运行。"
        case .manual: return "创建后保持启用，但只会在你点“立即运行”时执行。"
        }
    }

    func trigger(runAt: Date) -> (type: TrackerTriggerType, config: [String: Any]) {
        guard self != .manual else { return (.manual, [:]) }
        let components = Calendar.current.dateComponents([.hour, .minute], from: runAt)
        let hour = components.hour ?? 9
        let minute = components.minute ?? 0
        let dayOfWeek: String
        switch self {
        case .everyDay: dayOfWeek = "*"
        case .weekdays: dayOfWeek = "1-5"
        case .weekly: dayOfWeek = "1"
        case .manual: dayOfWeek = "*"
        }
        return (
            .cron,
            [
                "cron_expression": "\(minute) \(hour) * * \(dayOfWeek)",
                "timezone": TimeZone.current.identifier,
                "catchup_policy": "skip",
            ]
        )
    }

    static func from(template: TrackerTemplate) -> MobileAutomationFrequency {
        guard template.triggerType == .cron else { return .manual }
        let cron = template.triggerConfig["cron_expression"]?.stringValue
            ?? template.triggerConfig["expression"]?.stringValue
            ?? ""
        let parts = cron.split(separator: " ")
        guard parts.count == 5 else { return .manual }
        switch parts[4] {
        case "1-5": return .weekdays
        case "1": return .weekly
        case "*": return .everyDay
        default: return .manual
        }
    }

    static func summary(triggerType: TrackerTriggerType, config: [String: AnyCodable]) -> String {
        guard triggerType == .cron else { return triggerType.displayLabel }
        let cron = config["cron_expression"]?.stringValue ?? config["expression"]?.stringValue ?? ""
        let parts = cron.split(separator: " ")
        guard parts.count == 5, let minute = Int(parts[0]), let hour = Int(parts[1]) else {
            return "按计划自动运行"
        }
        let time = String(format: "%02d:%02d", hour, minute)
        switch parts[4] {
        case "1-5": return "每个工作日 \(time)"
        case "1": return "每周一 \(time)"
        case "*": return "每天 \(time)"
        default: return "按计划自动运行"
        }
    }
}

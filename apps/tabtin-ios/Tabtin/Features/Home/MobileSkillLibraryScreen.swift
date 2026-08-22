import SwiftUI

/// 组织级「技能和连接器」市场：浏览可见目录并进入只读详情。
/// 携带启停 / 添加 / 移除收敛到 AI 分身详情页的技能携带集。
struct MobileSkillLibraryScreen: View {
    let organizationId: String
    let onStartTask: (String, String?) -> Void

    @State private var agents = MyAgentsStore.shared
    @State private var store = MobileSkillLibraryStore()
    @State private var marketTab: CapabilityMarketTab
    @State private var sourceChip: SkillMarketSourceChip = .recommended
    @State private var categoryChip: SkillMarketCategoryChip = .all
    @State private var searchText = ""
    @State private var connectorSource: ConnectorMarketSource = .recommended
    @State private var connectorSearchText = ""
    @State private var selectedSkill: MobileSkillListItem?
    @State private var showSkillDetail = false

    init(
        organizationId: String,
        initialAgentId: String? = nil,
        initialMarketTab: CapabilityMarketTab = .skills,
        onStartTask: @escaping (String, String?) -> Void = { _, _ in }
    ) {
        self.organizationId = organizationId
        self.onStartTask = onStartTask
        // initialAgentId 保留签名以兼容旧入口；携带管理已迁到 Agent 详情页。
        _ = initialAgentId
        _marketTab = State(initialValue: initialMarketTab)
    }

    private var activeAgents: [OrganizationAgent] {
        agents.agents.filter { $0.isActive != false }
    }

    private var currentUserId: String {
        AuthService.shared.currentUser?.id ?? ""
    }

    private var filteredSkills: [MobileSkillListItem] {
        store.skills.filter { skill in
            let input = skill.marketFilterInput
            guard SkillMarketFilters.matchesMarketplaceSourceFilter(
                input,
                filter: sourceChip,
                currentUserId: currentUserId,
                currentOrganizationId: organizationId
            ) else { return false }
            guard SkillMarketFilters.matchesMarketplaceCategoryFilter(
                input, filter: categoryChip
            ) else { return false }
            return SkillMarketFilters.matchesVisibleSearch(
                query: searchText,
                visibleFields: [
                    skill.displayName,
                    skill.description,
                    skill.sourceLabel,
                    skill.version,
                ] + Array(skill.tags.prefix(2))
            )
        }
    }

    private var visibleConnectors: [MobileConnectorMarketItem] {
        MobileConnectorMarket.visibleItems(
            source: connectorSource,
            query: connectorSearchText,
            recommended: store.recommendedConnectors,
            organization: store.organizationConnectors,
            mine: store.mineConnectors
        )
    }

    var body: some View {
        // Tab 贴在导航栏下方，避免 insetGrouped 首 section 把切换键顶得太靠下。
        VStack(spacing: 0) {
            Picker("市场对象", selection: $marketTab) {
                ForEach(CapabilityMarketTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, TTSpacing.md)
            .padding(.top, TTSpacing.xs)
            .padding(.bottom, TTSpacing.sm)
            .accessibilityLabel("技能和连接器")

            List {
                switch marketTab {
                case .skills:
                    skillsContent
                case .connectors:
                    connectorsContent
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .background(Color.tt.bgCanvasDefault)
        .navigationTitle("技能和连接器")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reloadCurrentTab() }
        .task(id: organizationId) {
            await prepare()
        }
        .task(id: "\(organizationId):\(marketTab.rawValue):\(connectorSource.rawValue)") {
            if marketTab == .connectors {
                await store.loadConnectorShelf(
                    connectorSource,
                    organizationId: organizationId
                )
            }
        }
        .navigationDestination(isPresented: $showSkillDetail) {
            if let skill = selectedSkill {
                MobileSkillDetailScreen(
                    skill: skill,
                    agents: activeAgents,
                    onStartTask: { prompt, agentId in onStartTask(prompt, agentId) }
                )
            }
        }
    }

    @ViewBuilder
    private var skillsContent: some View {
        Section {
            TextField("搜索技能", text: $searchText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            SkillMarketFilterChips(
                showSourceRow: true,
                sourceChip: $sourceChip,
                categoryChip: $categoryChip
            )
            .listRowInsets(EdgeInsets(
                top: TTSpacing.sm,
                leading: TTSpacing.md,
                bottom: TTSpacing.sm,
                trailing: TTSpacing.md
            ))
        }

        if store.isLoading && store.skills.isEmpty {
            loadingRow("正在加载技能库…")
        } else if let loadError = store.loadError, store.skills.isEmpty {
            errorRow(loadError) { Task { await reloadSkills() } }
        } else if filteredSkills.isEmpty {
            emptyRow(
                title: "没有匹配的技能",
                systemImage: "magnifyingglass",
                description: "换个来源/分类或关键词，或稍后下拉刷新。"
            )
        } else {
            if let warning = store.loadError {
                Section {
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textWarning)
                        .accessibilityIdentifier("skill-market-refresh-warning")
                }
            }
            Section {
                ForEach(filteredSkills) { skill in
                    Button {
                        selectedSkill = skill
                        showSkillDetail = true
                    } label: {
                        MobileSkillRow(skill: skill)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private var connectorsContent: some View {
        Section {
            TextField(L10n.CapabilityMarket.connectorSearch, text: $connectorSearchText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("connector-market-search")

            CapabilityMarketSourceTabs(
                selection: $connectorSource,
                onSelect: selectConnectorSource
            )
            .listRowInsets(EdgeInsets(
                top: TTSpacing.sm,
                leading: TTSpacing.md,
                bottom: TTSpacing.sm,
                trailing: TTSpacing.md
            ))
        }

        if isLoadingSelectedConnectorShelf && selectedConnectorShelfItems.isEmpty {
            loadingRow(L10n.CapabilityMarket.connectorLoading)
        } else if let error = selectedConnectorShelfError, selectedConnectorShelfItems.isEmpty {
            errorRow(error) {
                Task {
                    await store.loadConnectorShelf(
                        connectorSource,
                        organizationId: organizationId,
                        force: true
                    )
                }
            }
        } else if visibleConnectors.isEmpty {
            emptyRow(
                title: connectorSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? connectorSource.emptyTitle
                    : L10n.CapabilityMarket.noMatches,
                systemImage: connectorSource == .mine ? "desktopcomputer" : "cable.connector",
                description: connectorSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? connectorSource.emptyDescription
                    : L10n.CapabilityMarket.tryAnotherSearch
            )
        } else {
            if let warning = selectedConnectorShelfError {
                Section {
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textWarning)
                        .accessibilityIdentifier("connector-market-partial-warning")
                }
            }
            Section {
                ForEach(visibleConnectors) { item in
                    MarketConnectorRow(item: item)
                }
            } footer: {
                Text(L10n.Project.myAgentsToolsManageOnDesktop)
            }
        }
    }

    private var selectedConnectorShelfItems: [MobileConnectorMarketItem] {
        switch connectorSource {
        case .recommended: store.recommendedConnectors
        case .organization: store.organizationConnectors
        case .mine: store.mineConnectors
        }
    }

    private var isLoadingSelectedConnectorShelf: Bool {
        switch connectorSource {
        case .recommended: false
        case .organization: store.isLoadingOrganizationConnectors
        case .mine: store.isLoadingMineConnectors
        }
    }

    private var selectedConnectorShelfError: String? {
        switch connectorSource {
        case .recommended: nil
        case .organization: store.organizationConnectorsError
        case .mine: store.mineConnectorsError
        }
    }

    private func selectConnectorSource(_ source: ConnectorMarketSource) {
        connectorSearchText = MobileConnectorMarket.searchAfterSelecting(
            currentSource: connectorSource,
            newSource: source,
            currentQuery: connectorSearchText
        )
        connectorSource = source
    }

    private func loadingRow(_ message: String) -> some View {
        HStack {
            Spacer()
            ProgressView(message)
            Spacer()
        }
        .listRowSeparator(.hidden)
    }

    private func errorRow(_ message: String, onRetry: @escaping () -> Void) -> some View {
        TTErrorStateView(
            message: message,
            systemImage: nil,
            prominence: .inline,
            palette: .critical,
            onRetry: onRetry
        )
        .frame(maxWidth: .infinity)
        .padding(.vertical, TTSpacing.xl)
        .listRowSeparator(.hidden)
    }

    private func emptyRow(title: String, systemImage: String, description: String) -> some View {
        ContentUnavailableView(
            title,
            systemImage: systemImage,
            description: Text(description)
        )
        .frame(maxWidth: .infinity)
        .padding(.vertical, TTSpacing.xxl)
        .listRowSeparator(.hidden)
    }

    private func prepare() async {
        await agents.load(organizationId: organizationId)
        await reloadSkills()
    }

    private func reloadSkills() async {
        await store.load(organizationId: organizationId, agents: activeAgents)
    }

    private func reloadCurrentTab() async {
        switch marketTab {
        case .skills:
            await reloadSkills()
        case .connectors:
            await store.loadConnectorShelf(
                connectorSource,
                organizationId: organizationId,
                force: true
            )
        }
    }
}

/// 两行 chips：来源（accent 实心）+ 分类（accent 描边浅底）。跟主题 token，不硬编码 teal / 黑底。
private struct SkillMarketFilterChips: View {
    let showSourceRow: Bool
    @Binding var sourceChip: SkillMarketSourceChip
    @Binding var categoryChip: SkillMarketCategoryChip

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            if showSourceRow {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: TTSpacing.sm) {
                        ForEach(SkillMarketSourceChip.allCases) { chip in
                            sourceChipView(chip)
                        }
                    }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TTSpacing.sm) {
                    ForEach(SkillMarketCategoryChip.allCases) { chip in
                        categoryChipView(chip)
                    }
                }
            }
        }
    }

    private func sourceChipView(_ chip: SkillMarketSourceChip) -> some View {
        let selected = sourceChip == chip
        return Text(chip.title)
            .font(.tt.captionMedium)
            .foregroundStyle(selected ? Color.tt.textOnAccent : Color.tt.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(selected ? Color.tt.bgAccent : Color.tt.bgSubtle, in: Capsule())
            .onTapGesture { sourceChip = chip }
    }

    private func categoryChipView(_ chip: SkillMarketCategoryChip) -> some View {
        let selected = categoryChip == chip
        return Text(chip.title)
            .font(selected ? .tt.captionSemibold : .tt.captionMedium)
            .foregroundStyle(selected ? Color.tt.iconAccent : Color.tt.textSecondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule()
                    .fill(selected ? Color.tt.bgAccent.opacity(0.10) : Color.clear)
            )
            .overlay(
                Capsule()
                    .strokeBorder(
                        selected ? Color.tt.bgAccent.opacity(0.40) : Color.tt.borderLight,
                        lineWidth: 1
                    )
            )
            .onTapGesture { categoryChip = chip }
    }
}

private struct CapabilityMarketSourceTabs: View {
    @Binding var selection: ConnectorMarketSource
    let onSelect: (ConnectorMarketSource) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: TTSpacing.sm) {
                ForEach(ConnectorMarketSource.allCases) { source in
                    let selected = selection == source
                    Button {
                        onSelect(source)
                    } label: {
                        Text(source.title)
                            .font(.tt.captionMedium)
                            .foregroundStyle(
                                selected ? Color.tt.textOnAccent : Color.tt.textSecondary
                            )
                            .padding(.horizontal, TTSpacing.md)
                            .padding(.vertical, 7)
                            .background(
                                selected ? Color.tt.bgAccent : Color.tt.bgSubtle,
                                in: Capsule()
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("connector-market-source-\(source.rawValue)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.CapabilityMarket.connectorSources)
    }
}

private struct MarketConnectorRow: View {
    let item: MobileConnectorMarketItem

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            ConnectorBrandGlyphView(
                query: .init(
                    catalogId: item.catalogId,
                    name: item.name,
                    endpointUrl: item.endpoint
                ),
                size: 30
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(item.name)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                HStack(spacing: TTSpacing.xs) {
                    Text(item.source.title)
                    if let deviceName = item.deviceName, !deviceName.isEmpty {
                        Text(deviceName)
                    }
                    if !item.transport.isEmpty {
                        Text(item.transport.uppercased())
                    }
                }
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
                if !item.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(item.description)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, TTSpacing.xxs)
        .accessibilityHint(L10n.Project.myAgentsToolsManageOnDesktop)
    }
}

private struct MobileSkillRow: View {
    let skill: MobileSkillListItem

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            SkillGlyphView(size: 30)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: TTSpacing.xs) {
                    Text(skill.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if skill.isAttached {
                        Text(skill.isEnabled ? "已启用" : "已停用")
                            .font(.tt.captionMedium)
                            .foregroundStyle(skill.isEnabled ? .tt.textSuccess : .tt.textTertiary)
                    }
                }
                if !skill.description.isEmpty {
                    Text(skill.description)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(2)
                }
                HStack(spacing: TTSpacing.xs) {
                    Text(skill.sourceLabel)
                    if !skill.version.isEmpty {
                        Text(skill.version)
                    }
                    if !skill.tags.isEmpty {
                        Text(skill.tags.prefix(2).joined(separator: " · "))
                            .lineLimit(1)
                    }
                }
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
            }

            Spacer(minLength: TTSpacing.xs)
            Image(systemName: "chevron.right")
                .font(.tt.iconCaptionMedium)
                .foregroundStyle(.tt.textTertiary)
                .padding(.top, 6)
        }
        .padding(.vertical, TTSpacing.xxs)
    }
}

/// 技能详情只读：展示元数据与携带概况；添加/启停/移除在 AI 分身携带集完成。
private struct MobileSkillDetailScreen: View {
    let skill: MobileSkillListItem
    let agents: [OrganizationAgent]
    let onStartTask: (String, String?) -> Void

    @State private var quickUseAgentId: String

    init(
        skill: MobileSkillListItem,
        agents: [OrganizationAgent],
        onStartTask: @escaping (String, String?) -> Void
    ) {
        self.skill = skill
        self.agents = agents
        self.onStartTask = onStartTask
        let preferred = skill.bindings.first(where: \.enabled)?.agentId
            ?? skill.bindings.first?.agentId
            ?? agents.first(where: { $0.isDefault == true })?.id
            ?? agents.first?.id
            ?? ""
        _quickUseAgentId = State(initialValue: preferred)
    }

    private var readinessText: String {
        if skill.bindings.isEmpty { return "尚未添加到 AI 分身" }
        return skill.bindings.contains(where: { $0.enabled }) ? "已就绪" : "已添加，尚未启用"
    }

    private var readinessIcon: String {
        skill.bindings.contains(where: { $0.enabled }) ? "checkmark.circle.fill" : "exclamationmark.circle"
    }

    private var readinessColor: Color {
        skill.bindings.contains(where: { $0.enabled }) ? .tt.textSuccess : .tt.textSecondary
    }

    var body: some View {
        Form {
            Section {
                HStack(alignment: .top, spacing: TTSpacing.sm) {
                    SkillGlyphView(size: 44, cornerRadius: TTRadius.sm)
                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                        Text(skill.displayName)
                            .font(.tt.bodySemibold)
                        Text(skill.sourceLabel)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                if !skill.description.isEmpty {
                    Text(skill.description)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                }
                if !skill.tags.isEmpty {
                    Text(skill.tags.prefix(6).joined(separator: " · "))
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                }
            }

            Section {
                if skill.bindings.isEmpty {
                    Text("尚未添加给任何 AI 分身")
                        .foregroundStyle(.tt.textSecondary)
                } else {
                    ForEach(skill.bindings) { binding in
                        HStack {
                            Text(binding.agentName)
                            Spacer()
                            Text(binding.enabled ? "已启用" : "已停用")
                                .font(.tt.captionMedium)
                                .foregroundStyle(binding.enabled ? .tt.textSuccess : .tt.textTertiary)
                        }
                    }
                }
            } header: {
                Text("已绑定 AI 分身")
            } footer: {
                Text("添加、启用或移除请到对应 AI 分身详情的技能携带集。")
            }

            Section {
                Label(readinessText, systemImage: readinessIcon)
                    .foregroundStyle(readinessColor)
            } header: {
                Text("就绪状态")
            }

            if !skill.quickUse.isEmpty, !agents.isEmpty {
                Section {
                    Picker("用哪个 AI 分身发起", selection: $quickUseAgentId) {
                        ForEach(agents) { agent in
                            Text(agent.displayName).tag(agent.id)
                        }
                    }
                    ForEach(skill.quickUse) { preset in
                        NavigationLink {
                            MobileSkillQuickUseScreen(
                                skillName: skill.displayName,
                                preset: preset,
                                onStartTask: { prompt in onStartTask(prompt, quickUseAgentId) }
                            )
                        } label: {
                            Label(preset.label, systemImage: "sparkles")
                        }
                        .disabled(quickUseAgentId.isEmpty)
                    }
                } header: {
                    Text("快速使用")
                } footer: {
                    Text("填写所需信息后，会用所选 AI 分身发起一个新任务。")
                }
            }
        }
        .navigationTitle("技能详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// 技能预设不是编辑器：它只收集预设声明的输入，并把生成的任务说明交给任务页。
private struct MobileSkillQuickUseScreen: View {
    let skillName: String
    let preset: MobileSkillQuickUsePreset
    let onStartTask: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: String] = [:]

    private var requiredKeys: Set<String> { Set(preset.canSubmitKeys) }

    private var canStart: Bool {
        requiredKeys.allSatisfy { !(values[$0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var body: some View {
        Form {
            Section {
                Text(skillName)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                Text(preset.label)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
            }

            if !preset.variables.isEmpty {
                Section("填写内容") {
                    ForEach(preset.variables) { variable in
                        input(for: variable)
                    }
                }
            }

            Section {
                Button {
                    onStartTask(preset.render(values: values))
                    dismiss()
                } label: {
                    Label("用此技能新建任务", systemImage: "square.and.pencil")
                        .frame(maxWidth: .infinity)
                }
                .disabled(!canStart)
            } footer: {
                if !requiredKeys.isEmpty {
                    Text("请填写所有必填项后再开始。")
                }
            }
        }
        .navigationTitle("快速使用")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func input(for variable: MobileSkillQuickUseVariable) -> some View {
        let title = variable.label.isEmpty ? variable.key : variable.label
        switch variable.type {
        case "textarea":
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                Text(requiredKeys.contains(variable.key) ? "\(title) *" : title)
                TextEditor(text: valueBinding(for: variable.key))
                    .frame(minHeight: 100)
            }
        case "select":
            Picker(requiredKeys.contains(variable.key) ? "\(title) *" : title, selection: valueBinding(for: variable.key)) {
                Text("请选择").tag("")
                ForEach(variable.options) { option in
                    Text(option.label).tag(option.value)
                }
            }
        case "toggle":
            Toggle(title, isOn: boolBinding(for: variable.key))
        default:
            TextField(
                requiredKeys.contains(variable.key) ? "\(title) *" : title,
                text: valueBinding(for: variable.key),
                prompt: variable.placeholder.isEmpty ? nil : Text(variable.placeholder)
            )
            .keyboardType(variable.type == "number" ? .decimalPad : .default)
        }
    }

    private func valueBinding(for key: String) -> Binding<String> {
        Binding(
            get: { values[key] ?? "" },
            set: { values[key] = $0 }
        )
    }

    private func boolBinding(for key: String) -> Binding<Bool> {
        Binding(
            get: { (values[key] ?? "false") == "true" },
            set: { values[key] = $0 ? "true" : "false" }
        )
    }
}

@MainActor @Observable
private final class MobileSkillLibraryStore {
    private(set) var skills: [MobileSkillListItem] = []
    private(set) var credentials: [MobileCredentialItem] = []
    private(set) var recommendedConnectors: [MobileConnectorMarketItem] = []
    private(set) var organizationConnectors: [MobileConnectorMarketItem] = []
    private(set) var mineConnectors: [MobileConnectorMarketItem] = []
    private(set) var isLoading = false
    private(set) var isLoadingOrganizationConnectors = false
    private(set) var isLoadingMineConnectors = false
    private(set) var loadError: String?
    private(set) var organizationConnectorsError: String?
    private(set) var mineConnectorsError: String?

    private var organizationId = ""
    private var agentsById: [String: OrganizationAgent] = [:]
    private var loadSequence = 0
    private var connectorLoadSequences = Dictionary(
        uniqueKeysWithValues: ConnectorMarketSource.allCases.map { ($0, 0) }
    )
    private var loadedConnectorSources: Set<ConnectorMarketSource> = []
    private var connectorOrganizationId = ""

    init() {
        recommendedConnectors = Self.makeRecommendedConnectors()
    }

    func skill(for id: String) -> MobileSkillListItem? {
        skills.first { $0.id == id }
    }

    func load(organizationId: String, agents: [OrganizationAgent]) async {
        loadSequence += 1
        let sequence = loadSequence
        self.organizationId = organizationId
        agentsById = Dictionary(uniqueKeysWithValues: agents.map { ($0.id, $0) })
        isLoading = skills.isEmpty
        loadError = nil

        do {
            async let catalogRequest: MobileVisibleSkillResponse = APIClient.shared.get(
                path: Endpoints.Skills.visible,
                query: ["organization_id": organizationId]
            )
            async let credentialsRequest: [MobileCredentialItem] = APIClient.shared.get(
                path: Endpoints.CredentialVault.list,
                query: ["category": "api_key"]
            )

            let catalog = try await catalogRequest
            var agentLinks: [(OrganizationAgent, [MobileAgentSkillLink])] = []
            for agent in agents {
                let response: MobileAgentSkillLinkResponse = try await APIClient.shared.get(
                    path: Endpoints.Agent.skills(agent.id)
                )
                agentLinks.append((agent, response.skills))
            }
            let loadedCredentials = (try? await credentialsRequest) ?? []
            guard sequence == loadSequence else { return }

            credentials = loadedCredentials
            skills = Self.merge(
                catalog: catalog.skills,
                userGates: catalog.userGates,
                agentLinks: agentLinks
            )
            loadError = nil
        } catch {
            guard sequence == loadSequence, !error.isCancellation else { return }
            loadError = CapabilityMarketErrorPresentation.message(
                for: error,
                fallback: L10n.CapabilityMarket.skillLoadFailed
            )
        }
        if sequence == loadSequence { isLoading = false }
    }

    /// 每次只读取当前货架。来源切换、重试和下拉刷新都不会等待或改写其他货架。
    /// “我的”仍逐设备容错，单台失败时保留其他设备的结果。
    func loadConnectorShelf(
        _ source: ConnectorMarketSource,
        organizationId: String,
        force: Bool = false
    ) async {
        prepareConnectorOrganization(organizationId)
        guard force || !loadedConnectorSources.contains(source) else { return }

        if source == .recommended {
            recommendedConnectors = Self.makeRecommendedConnectors()
            loadedConnectorSources.insert(.recommended)
            return
        }

        connectorLoadSequences[source, default: 0] += 1
        let sequence = connectorLoadSequences[source, default: 0]
        setConnectorLoading(true, for: source)
        setConnectorError(nil, for: source)

        switch source {
        case .recommended:
            return
        case .organization:
            let result = await Self.loadOrganizationConnectors(organizationId: organizationId)
            guard isCurrentConnectorRequest(
                source: source,
                sequence: sequence,
                organizationId: organizationId
            ) else { return }
            switch result {
            case .success(let items):
                organizationConnectors = items
                loadedConnectorSources.insert(.organization)
            case .failure(let error):
                organizationConnectorsError = CapabilityMarketErrorPresentation.message(
                    for: error,
                    fallback: L10n.CapabilityMarket.connectorLoadFailed
                )
            }
        case .mine:
            let result = await Self.loadMineConnectors(organizationId: organizationId)
            guard isCurrentConnectorRequest(
                source: source,
                sequence: sequence,
                organizationId: organizationId
            ) else { return }
            switch result {
            case .success(let result):
                mineConnectors = result.items
                loadedConnectorSources.insert(.mine)
                switch MobileConnectorMarket.mineReadFailure(
                    failedDeviceCount: result.failedDeviceCount,
                    totalDeviceCount: result.totalDeviceCount
                ) {
                case .partial:
                    mineConnectorsError = L10n.CapabilityMarket.minePartialFailure
                case .all:
                    mineConnectorsError = L10n.CapabilityMarket.mineAllDevicesFailed
                case nil:
                    mineConnectorsError = nil
                }
            case .failure(let error):
                mineConnectorsError = CapabilityMarketErrorPresentation.message(
                    for: error,
                    fallback: L10n.CapabilityMarket.connectorLoadFailed
                )
            }
        }
        setConnectorLoading(false, for: source)
    }

    private func prepareConnectorOrganization(_ organizationId: String) {
        guard connectorOrganizationId != organizationId else { return }
        connectorOrganizationId = organizationId
        self.organizationId = organizationId
        for source in ConnectorMarketSource.allCases {
            connectorLoadSequences[source, default: 0] += 1
        }
        loadedConnectorSources.removeAll()
        recommendedConnectors = Self.makeRecommendedConnectors()
        organizationConnectors = []
        mineConnectors = []
        isLoadingOrganizationConnectors = false
        isLoadingMineConnectors = false
        organizationConnectorsError = nil
        mineConnectorsError = nil
    }

    private func isCurrentConnectorRequest(
        source: ConnectorMarketSource,
        sequence: Int,
        organizationId: String
    ) -> Bool {
        !Task.isCancelled &&
            connectorOrganizationId == organizationId &&
            connectorLoadSequences[source] == sequence
    }

    private func setConnectorLoading(_ isLoading: Bool, for source: ConnectorMarketSource) {
        switch source {
        case .recommended:
            break
        case .organization:
            isLoadingOrganizationConnectors = isLoading && organizationConnectors.isEmpty
        case .mine:
            isLoadingMineConnectors = isLoading && mineConnectors.isEmpty
        }
    }

    private func setConnectorError(_ error: String?, for source: ConnectorMarketSource) {
        switch source {
        case .recommended:
            break
        case .organization:
            organizationConnectorsError = error
        case .mine:
            mineConnectorsError = error
        }
    }

    private nonisolated static func makeRecommendedConnectors() -> [MobileConnectorMarketItem] {
        ConnectorBrandIconResolver.recommendedCatalog().map { entry in
            MobileConnectorMarketItem(
                id: "recommended:\(entry.id)",
                catalogId: entry.id,
                name: entry.title,
                description: Self.recommendedDescription(for: entry.descriptionKey),
                transport: "",
                endpoint: "",
                deviceName: nil,
                source: .recommended
            )
        }
    }

    private nonisolated static func recommendedDescription(for key: String) -> String {
        L10n.CapabilityMarket.recommendedDescription(key)
    }

    private nonisolated static func loadOrganizationConnectors(
        organizationId: String
    ) async -> Result<[MobileConnectorMarketItem], Error> {
        do {
            let response: OrgMcpConnectionListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.organizationMcpConnections(
                    organizationId: organizationId
                )
            )
            return .success(MobileConnectorMarket.organizationItems(from: response.connections))
        } catch {
            return .failure(error)
        }
    }

    private struct MineLoadResult: Sendable {
        let items: [MobileConnectorMarketItem]
        let failedDeviceCount: Int
        let totalDeviceCount: Int
    }

    private nonisolated static func loadMineConnectors(
        organizationId: String
    ) async -> Result<MineLoadResult, Error> {
        do {
            let deviceResponse: RuntimeDeviceListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.devices,
                query: ["organization_id": organizationId]
            )
            let batches = await withTaskGroup(
                of: Result<MobileConnectorDeviceBatch, Error>.self,
                returning: [Result<MobileConnectorDeviceBatch, Error>].self
            ) { group in
                for device in deviceResponse.devices {
                    group.addTask {
                        do {
                            let response: DeviceMcpConnectionListResponse = try await APIClient.shared.get(
                                path: Endpoints.Context.deviceMcpConnections(deviceId: device.id)
                            )
                            let name = device.name?.trimmingCharacters(
                                in: .whitespacesAndNewlines
                            )
                            return .success(MobileConnectorDeviceBatch(
                                deviceId: device.id,
                                deviceName: name?.isEmpty == false
                                    ? name!
                                    : L10n.SpaceList.unnamedDevice,
                                connections: response.connections
                            ))
                        } catch {
                            return .failure(error)
                        }
                    }
                }
                var results: [Result<MobileConnectorDeviceBatch, Error>] = []
                for await result in group { results.append(result) }
                return results
            }
            let successfulBatches = batches.compactMap { result in
                try? result.get()
            }
            return .success(MineLoadResult(
                items: MobileConnectorMarket.mineItems(from: successfulBatches),
                failedDeviceCount: batches.count - successfulBatches.count,
                totalDeviceCount: batches.count
            ))
        } catch {
            return .failure(error)
        }
    }

    func attach(_ skill: MobileSkillListItem, to agentId: String) async throws -> MobileAgentSkillLink {
        let link: MobileAgentSkillLink = try await APIClient.shared.post(
            path: Endpoints.Agent.skills(agentId),
            body: ["skill_canonical_key": skill.canonicalKey, "enabled": true]
        )
        apply(link: link, to: skill.id, agentId: agentId)
        return link
    }

    func setEnabled(_ skill: MobileSkillListItem, for agentId: String, enabled: Bool) async throws -> MobileAgentSkillLink {
        let link: MobileAgentSkillLink = try await APIClient.shared.patch(
            path: Endpoints.Agent.skill(agentId, key: skill.canonicalKey),
            body: ["enabled": enabled]
        )
        apply(link: link, to: skill.id, agentId: agentId)
        return link
    }

    func setCredential(_ skill: MobileSkillListItem, for agentId: String, credentialId: String?) async throws -> MobileAgentSkillLink {
        let link: MobileAgentSkillLink = try await APIClient.shared.patch(
            path: Endpoints.Agent.skill(agentId, key: skill.canonicalKey),
            body: Self.makeSetCredentialBody(credentialId: credentialId)
        )
        apply(link: link, to: skill.id, agentId: agentId)
        return link
    }

    private nonisolated static func makeSetCredentialBody(credentialId: String?) -> sending [String: Any] {
        let credentialValue: Any = credentialId ?? NSNull()
        return ["config_json": ["credential_id": credentialValue]]
    }

    func detach(_ skill: MobileSkillListItem, from agentId: String) async throws {
        let _: MobileAgentSkillDetachResponse = try await APIClient.shared.delete(
            path: Endpoints.Agent.skill(agentId, key: skill.canonicalKey)
        )
        guard let index = skills.firstIndex(where: { $0.id == skill.id }) else { return }
        skills[index].bindings.removeAll { $0.agentId == agentId }
        skills[index].updateAggregateState()
    }

    private func apply(link: MobileAgentSkillLink, to skillId: String, agentId: String) {
        guard let agent = agentsById[agentId] else { return }
        if let index = skills.firstIndex(where: { $0.id == skillId }) {
            skills[index].bindings.removeAll { $0.agentId == agentId }
            skills[index].bindings.append(MobileSkillAgentBinding(agent: agent, link: link))
            skills[index].updateAggregateState()
        } else {
            var item = MobileSkillListItem(link: link)
            item.bindings = [MobileSkillAgentBinding(agent: agent, link: link)]
            item.updateAggregateState()
            skills.insert(item, at: 0)
        }
    }

    private static func merge(
        catalog: [MobileSkillCatalogEntry],
        userGates: [String: Bool],
        agentLinks: [(OrganizationAgent, [MobileAgentSkillLink])]
    ) -> [MobileSkillListItem] {
        let bindingsByKey = Dictionary(grouping: agentLinks.flatMap { agent, links in
            links.map { MobileSkillAgentBinding(agent: agent, link: $0) }
        }, by: \.canonicalKey)
        let uniqueCatalog = StableSkillCatalogProjection.unique(
            catalog,
            canonicalKey: \.canonicalKey
        )
        var merged = uniqueCatalog.map { entry -> MobileSkillListItem in
            var item = MobileSkillListItem(
                catalog: entry,
                link: nil,
                acquired: SkillMarketFilters.isAcquired(
                    canonicalKey: entry.canonicalKey,
                    userGates: userGates
                )
            )
            item.bindings = bindingsByKey[entry.canonicalKey] ?? []
            item.updateAggregateState()
            return item
        }
        let catalogKeys = Set(uniqueCatalog.map(\.canonicalKey))
        merged.append(contentsOf: bindingsByKey
            .filter { !catalogKeys.contains($0.key) }
            .map { key, bindings in
                var item = MobileSkillListItem(
                    link: bindings[0].link,
                    acquired: SkillMarketFilters.isAcquired(canonicalKey: key, userGates: userGates)
                )
                item.bindings = bindings
                item.updateAggregateState()
                return item
            })
        return merged.sorted {
            if $0.isAttached != $1.isAttached { return $0.isAttached && !$1.isAttached }
            return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }
}

enum StableSkillCatalogProjection {
    static func unique<Item>(
        _ items: [Item],
        canonicalKey: (Item) -> String
    ) -> [Item] {
        var seen = Set<String>()
        return items.filter { item in
            let key = canonicalKey(item)
            guard !key.isEmpty else { return false }
            return seen.insert(key).inserted
        }
    }
}

enum CapabilityMarketErrorPresentation {
    static func message(for error: Error, fallback: String) -> String {
        isNetworkFailure(error) ? L10n.Messages.networkError : fallback
    }

    private static func isNetworkFailure(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return networkCodes.contains(urlError.code)
        }
        if let apiError = error as? APIError,
           case let .networkError(underlyingError) = apiError {
            return isNetworkFailure(underlyingError)
        }
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return false }
        return networkCodes.contains(URLError.Code(rawValue: nsError.code))
    }

    private static let networkCodes: Set<URLError.Code> = [
        .notConnectedToInternet,
        .timedOut,
        .networkConnectionLost,
        .cannotConnectToHost,
        .cannotFindHost,
        .dnsLookupFailed,
        .secureConnectionFailed,
    ]
}

private struct MobileSkillListItem: Identifiable {
    let id: String
    let canonicalKey: String
    let displayName: String
    let description: String
    let emoji: String
    let source: String
    let visibility: String
    let version: String
    let tags: [String]
    let category: String
    let appId: String
    let distribution: String
    let ownerUserId: String
    let organizationId: String
    let acquired: Bool
    let requiresCredential: Bool
    let quickUse: [MobileSkillQuickUsePreset]
    var isAttached: Bool
    var isEnabled: Bool
    var isLocked: Bool
    var credentialId: String?
    var bindings: [MobileSkillAgentBinding]

    var marketFilterInput: SkillMarketFilterInput {
        SkillMarketFilterInput(
            source: source,
            visibility: visibility,
            appId: appId.isEmpty ? nil : appId,
            distribution: distribution.isEmpty ? nil : distribution,
            category: category.isEmpty ? nil : category,
            ownerUserId: ownerUserId.isEmpty ? nil : ownerUserId,
            organizationId: organizationId.isEmpty ? nil : organizationId,
            acquired: acquired
        )
    }

    init(catalog: MobileSkillCatalogEntry, link: MobileAgentSkillLink?, acquired: Bool) {
        id = catalog.canonicalKey
        canonicalKey = catalog.canonicalKey
        displayName = catalog.displayName
        description = catalog.description
        emoji = catalog.emoji
        source = catalog.source
        visibility = catalog.visibility
        version = catalog.version
        tags = catalog.tags
        category = catalog.category
        appId = catalog.appId
        distribution = catalog.distribution
        ownerUserId = catalog.ownerUserId
        organizationId = catalog.organizationId
        self.acquired = acquired
        requiresCredential = !catalog.primaryEnv.isEmpty
        quickUse = catalog.quickUse
        isAttached = link != nil || catalog.installed
        isEnabled = link?.enabled ?? (catalog.agentEnabled && catalog.enabled)
        isLocked = link?.locked ?? false
        credentialId = link?.credentialId
        bindings = []
    }

    init(link: MobileAgentSkillLink, acquired: Bool = false) {
        id = link.canonicalKey
        canonicalKey = link.canonicalKey
        displayName = link.name
        description = link.description
        emoji = link.emoji
        source = link.source
        visibility = ""
        version = ""
        tags = []
        category = ""
        appId = ""
        distribution = ""
        ownerUserId = ""
        organizationId = ""
        self.acquired = acquired
        requiresCredential = link.credentialId != nil
        quickUse = []
        isAttached = true
        isEnabled = link.enabled
        isLocked = link.locked
        credentialId = link.credentialId
        bindings = []
    }

    func isAttached(to agentId: String) -> Bool {
        bindings.contains { $0.agentId == agentId }
    }

    mutating func updateAggregateState() {
        isAttached = !bindings.isEmpty
        isEnabled = bindings.contains { $0.enabled }
        isLocked = bindings.allSatisfy { $0.locked }
        credentialId = bindings.first?.credentialId
    }

    var sourceLabel: String {
        switch source {
        case "platform": return "平台技能"
        case "app": return "应用技能"
        case "user": return "团队技能"
        case "workspace": return "工作区技能"
        case "device": return "设备技能"
        default: return "技能"
        }
    }

}

private struct MobileSkillAgentBinding: Identifiable {
    let agentId: String
    let agentName: String
    let canonicalKey: String
    let enabled: Bool
    let locked: Bool
    let credentialId: String?
    let link: MobileAgentSkillLink

    var id: String { agentId }

    init(agent: OrganizationAgent, link: MobileAgentSkillLink) {
        agentId = agent.id
        agentName = agent.displayName
        canonicalKey = link.canonicalKey
        enabled = link.enabled
        locked = link.locked
        credentialId = link.credentialId
        self.link = link
    }
}

private struct MobileVisibleSkillResponse: Decodable {
    let skills: [MobileSkillCatalogEntry]
    let userGates: [String: Bool]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        skills = try container.decodeIfPresent([MobileSkillCatalogEntry].self, forKey: .skills) ?? []
        userGates = try container.decodeIfPresent([String: Bool].self, forKey: .userGates) ?? [:]
    }

    private enum CodingKeys: String, CodingKey {
        case skills
        case userGates = "user_gates"
    }
}

private struct MobileSkillQuickUsePreset: Decodable, Hashable, Identifiable {
    let id: String
    let label: String
    let promptTemplate: String
    let variables: [MobileSkillQuickUseVariable]
    let canSubmitKeys: [String]

    private enum CodingKeys: String, CodingKey {
        case id, label, variables
        case promptTemplate
        case canSubmitKeys
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        promptTemplate = try c.decodeIfPresent(String.self, forKey: .promptTemplate) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? promptTemplate
        id = try c.decodeIfPresent(String.self, forKey: .id)
            ?? "\(label)-\(promptTemplate)"
        variables = try c.decodeIfPresent([MobileSkillQuickUseVariable].self, forKey: .variables) ?? []
        canSubmitKeys = try c.decodeIfPresent([String].self, forKey: .canSubmitKeys) ?? []
    }

    func render(values: [String: String]) -> String {
        variables.reduce(promptTemplate) { prompt, variable in
            prompt.replacingOccurrences(of: "{{\(variable.key)}}", with: values[variable.key] ?? "")
        }
    }
}

private struct MobileSkillQuickUseVariable: Decodable, Hashable, Identifiable {
    let key: String
    let type: String
    let label: String
    let placeholder: String
    let options: [MobileSkillQuickUseOption]

    var id: String { key }

    private enum CodingKeys: String, CodingKey {
        case key, type, label, placeholder, options
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "input"
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder) ?? ""
        options = try c.decodeIfPresent([MobileSkillQuickUseOption].self, forKey: .options) ?? []
    }
}

private struct MobileSkillQuickUseOption: Decodable, Hashable, Identifiable {
    let value: String
    let label: String

    var id: String { value }

    private enum CodingKeys: String, CodingKey { case value, label }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        value = try c.decode(String.self, forKey: .value)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? value
    }
}

private struct MobileSkillCatalogEntry: Decodable {
    let canonicalKey: String
    let displayName: String
    let description: String
    let emoji: String
    let source: String
    let visibility: String
    let version: String
    let tags: [String]
    let category: String
    let appId: String
    let distribution: String
    let ownerUserId: String
    let organizationId: String
    let primaryEnv: String
    let quickUse: [MobileSkillQuickUsePreset]
    let installed: Bool
    let enabled: Bool
    let agentEnabled: Bool

    private enum CodingKeys: String, CodingKey {
        case skillId = "skill_id"
        case skillKey = "skill_key"
        case name
        case displayName = "display_name"
        case description, emoji, source, visibility, installed, enabled, version, tags, category, distribution
        case appId = "app_id"
        case ownerUserId = "owner_user_id"
        case organizationId = "organization_id"
        case primaryEnv = "primary_env"
        case agentEnabled = "agent_enabled"
        case quickUse = "quick_use"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let skillId = try c.decodeIfPresent(String.self, forKey: .skillId) ?? ""
        canonicalKey = try c.decodeIfPresent(String.self, forKey: .skillKey) ?? skillId
        let name = try c.decodeIfPresent(String.self, forKey: .name) ?? canonicalKey
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? name
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji) ?? ""
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "user"
        visibility = try c.decodeIfPresent(String.self, forKey: .visibility) ?? ""
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? ""
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? ""
        appId = try c.decodeIfPresent(String.self, forKey: .appId) ?? ""
        distribution = try c.decodeIfPresent(String.self, forKey: .distribution) ?? ""
        ownerUserId = try c.decodeIfPresent(String.self, forKey: .ownerUserId) ?? ""
        organizationId = try c.decodeIfPresent(String.self, forKey: .organizationId) ?? ""
        primaryEnv = try c.decodeIfPresent(String.self, forKey: .primaryEnv) ?? ""
        quickUse = try c.decodeIfPresent([MobileSkillQuickUsePreset].self, forKey: .quickUse) ?? []
        installed = try c.decodeIfPresent(Bool.self, forKey: .installed) ?? false
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        agentEnabled = try c.decodeIfPresent(Bool.self, forKey: .agentEnabled) ?? false
    }
}

private struct MobileAgentSkillLinkResponse: Decodable {
    let skills: [MobileAgentSkillLink]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        skills = try container.decodeIfPresent([MobileAgentSkillLink].self, forKey: .skills) ?? []
    }

    private enum CodingKeys: String, CodingKey { case skills }
}

private struct MobileAgentSkillLink: Decodable {
    let canonicalKey: String
    let source: String
    let enabled: Bool
    let locked: Bool
    let config: [String: AnyCodable]
    let name: String
    let description: String
    let emoji: String

    private enum CodingKeys: String, CodingKey {
        case canonicalKey = "skill_canonical_key"
        case source, enabled, locked, name, description, emoji
        case config = "config_json"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        canonicalKey = try c.decodeIfPresent(String.self, forKey: .canonicalKey) ?? ""
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "user"
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        config = try c.decodeIfPresent([String: AnyCodable].self, forKey: .config) ?? [:]
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? canonicalKey
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji) ?? ""
    }

    var credentialId: String? { config["credential_id"]?.stringValue }
}

private struct MobileAgentSkillDetachResponse: Decodable {
    let found: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        found = try c.decodeIfPresent(Bool.self, forKey: .found) ?? false
    }

    private enum CodingKeys: String, CodingKey { case found }
}

private struct MobileCredentialItem: Decodable, Identifiable {
    let id: String
    let serviceName: String
    let displayNameRaw: String
    let isActive: Bool

    private enum CodingKeys: String, CodingKey {
        case id
        case serviceName = "service_name"
        case displayNameRaw = "display_name"
        case isActive = "is_active"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        serviceName = try c.decodeIfPresent(String.self, forKey: .serviceName) ?? ""
        displayNameRaw = try c.decodeIfPresent(String.self, forKey: .displayNameRaw) ?? ""
        isActive = try c.decodeIfPresent(Bool.self, forKey: .isActive) ?? true
    }

    var displayName: String {
        displayNameRaw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? serviceName : displayNameRaw
    }
}

import SwiftUI

/// Agent 选择网格：头像在上、名字在下，每行 4 个；名字超出最大长度截断。
private enum ComposerAgentGridLayout {
    static let columnsPerRow = 4
    /// 展示上限（按字素计）；中文约一行四列时的可读宽度。
    static let maxNameLength = 8
    static let avatarSize: CGFloat = 52
    static let columns = Array(
        repeating: GridItem(.flexible(minimum: 64), spacing: TTSpacing.sm),
        count: columnsPerRow
    )

    static func displayName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > maxNameLength else { return trimmed }
        return String(trimmed.prefix(maxNameLength)) + "…"
    }
}

// MARK: - 抽屉布局

private enum ComposerDrawerLayout {
    /// 与系统拖拽条之间留白，避免内容贴顶。
    static let topContentInset: CGFloat = TTSpacing.xxxl
    static let toolTileCornerRadius: CGFloat = TTRadius.lg
    static let toolTileSpacing: CGFloat = TTSpacing.sm
}

/// 任务设置抽屉顶部四宫格：等宽圆角方块，图标与短标签紧凑居中。
private struct ComposerToolTile: View {
    let tool: ComposerTool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: TTSpacing.xs) {
                Image(systemName: tool.icon)
                    .font(.tt.iconFeature)
                    .foregroundStyle(.tt.textPrimary)
                    .symbolRenderingMode(.monochrome)
                Text(tool.gridTitle)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .aspectRatio(1, contentMode: .fit)
            .background(
                RoundedRectangle(
                    cornerRadius: ComposerDrawerLayout.toolTileCornerRadius,
                    style: .continuous
                )
                .fill(.tt.bgSubtleSecondary)
            )
            .contentShape(RoundedRectangle(
                cornerRadius: ComposerDrawerLayout.toolTileCornerRadius,
                style: .continuous
            ))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tool.title)
    }
}

// MARK: - 任务设置抽屉（四合一）

/// Composer 工具条唯一入口：顶部一排四格（原「+」里的附件能力），
/// 下方列表汇总「执行 Agent / 工作方式 / 审批权限」；点行 push 二级选择。
/// 选附件会先关抽屉再回调；设置项选完 pop 回一级，方便连续改。
struct ComposerSettingsDrawer: View {
    @Environment(\.dismiss) private var dismiss
    let agentOptions: [ComposerTaskAgentOption]
    let selectedAgentId: String?
    let agentTitle: String
    let agentIsMutable: Bool
    let currentMode: ComposerModeOption
    let currentApproval: ComposerApprovalOption
    let permitsRelaxedApproval: Bool
    let onSelectTool: (ComposerTool) -> Void
    let onAgentChange: (ComposerTaskAgentOption) -> Void
    let onModeChange: (String) -> Void
    let onApprovalModeChange: (String) -> Void

    @State private var path: [Route] = []
    @State private var awaitingFullAccess: ComposerApprovalOption?

    private enum Route: Hashable {
        case agent
        case mode
        case approval
    }

    private var selectedAgent: ComposerTaskAgentOption? {
        agentOptions.first { $0.id == selectedAgentId }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    toolsGrid
                        .listRowInsets(
                            EdgeInsets(
                                top: TTSpacing.sm,
                                leading: TTSpacing.lg,
                                bottom: TTSpacing.sm,
                                trailing: TTSpacing.lg
                            )
                        )
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }

                Section {
                    settingRow(
                        title: "执行 Agent",
                        value: agentTitle,
                        route: .agent
                    ) {
                        if let selectedAgent {
                            AgentAvatar(option: selectedAgent, size: 24)
                        } else {
                            Image(systemName: "person.crop.circle")
                                .font(.tt.iconSubtitle)
                                .foregroundStyle(.tt.textAccent)
                                .frame(width: 24, height: 24)
                        }
                    }

                    settingRow(
                        title: "工作方式",
                        value: currentMode.title,
                        route: .mode
                    ) {
                        Image(systemName: currentMode.icon)
                            .font(.tt.iconSubtitle)
                            .foregroundStyle(currentMode.tint)
                            .frame(width: 24, height: 24)
                    }

                    settingRow(
                        title: "审批权限",
                        value: currentApproval.title,
                        route: .approval
                    ) {
                        Image(systemName: currentApproval.icon)
                            .font(.tt.iconSubtitle)
                            .foregroundStyle(currentApproval.tint)
                            .frame(width: 24, height: 24)
                    }
                }
                .listSectionSeparator(.hidden)
            }
            .listStyle(.plain)
            .listSectionSpacing(TTSpacing.lg)
            .scrollContentBackground(.hidden)
            .background(.tt.bgCanvasDefault)
            .contentMargins(.top, ComposerDrawerLayout.topContentInset, for: .scrollContent)
            .toolbar(path.isEmpty ? .hidden : .visible, for: .navigationBar)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .agent:
                    agentPage
                case .mode:
                    modePage
                case .approval:
                    approvalPage
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.tt.bgCanvasDefault)
    }

    private var toolsGrid: some View {
        HStack(spacing: ComposerDrawerLayout.toolTileSpacing) {
            ForEach(ComposerTool.allCases) { tool in
                ComposerToolTile(tool: tool) {
                    // 先关抽屉，再打开相册 / 文件选择器，避免 sheet 叠 sheet。
                    dismiss()
                    DispatchQueue.main.async {
                        onSelectTool(tool)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func settingRow(
        title: String,
        value: String,
        route: Route,
        @ViewBuilder leading: () -> some View
    ) -> some View {
        Button {
            path.append(route)
        } label: {
            HStack(spacing: TTSpacing.md) {
                leading()
                Text(title)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                Spacer(minLength: TTSpacing.sm)
                Text(value)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(
            EdgeInsets(
                top: TTSpacing.sm,
                leading: TTSpacing.lg,
                bottom: TTSpacing.sm,
                trailing: TTSpacing.lg
            )
        )
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .accessibilityLabel("\(title)：\(value)")
        .accessibilityHint("打开\(title)选择")
    }

    // MARK: 二级页

    private var agentPage: some View {
        ScrollView {
            if agentOptions.isEmpty {
                Text("Agent 信息未提供")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(TTSpacing.lg)
            } else {
                ComposerAgentPickerGrid(
                    agents: agentOptions,
                    selectedAgentId: selectedAgentId,
                    agentIsMutable: agentIsMutable,
                    onSelect: { agent in
                        onAgentChange(agent)
                        path.removeLast(path.count)
                    }
                )
                .padding(.horizontal, TTSpacing.lg)
                .padding(.vertical, TTSpacing.md)
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle("执行 Agent")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var modePage: some View {
        ComposerOptionList(
            options: ComposerModeOption.selectable,
            selectedId: currentMode.id,
            onSelect: { option in
                onModeChange(option.id)
                path.removeLast(path.count)
            }
        ) { option in
            (option.title, option.summary, option.icon, option.tint)
        }
        .navigationTitle("工作方式")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var approvalPage: some View {
        ComposerOptionList(
            options: ComposerApprovalOption.selectable,
            selectedId: currentApproval.id,
            disabledReason: { option in
                option.approval == .alwaysAsk || permitsRelaxedApproval
                    ? nil
                    : "当前组织未开放此审批权限"
            },
            onSelect: { option in
                if option.requiresRiskConfirmation {
                    awaitingFullAccess = option
                } else {
                    onApprovalModeChange(option.id)
                    path.removeLast(path.count)
                }
            }
        ) { option in
            (option.title, option.summary, option.icon, option.tint)
        }
        .navigationTitle("审批权限")
        .navigationBarTitleDisplayMode(.inline)
        .alert(
            "开启完全访问？",
            isPresented: Binding(
                get: { awaitingFullAccess != nil },
                set: { if !$0 { awaitingFullAccess = nil } }
            ),
            presenting: awaitingFullAccess
        ) { option in
            Button("继续开启", role: .destructive) {
                onApprovalModeChange(option.id)
                awaitingFullAccess = nil
                path.removeLast(path.count)
            }
            Button("取消", role: .cancel) {
                awaitingFullAccess = nil
            }
        } message: { _ in
            Text("完全访问会在组织安全上限内尽量减少操作前的打断。请仅在你信任当前 Agent、执行位置和任务内容时开启。")
        }
    }
}

private struct ComposerAgentPickerGrid: View {
    let agents: [ComposerTaskAgentOption]
    let selectedAgentId: String?
    let agentIsMutable: Bool
    let onSelect: (ComposerTaskAgentOption) -> Void

    var body: some View {
        LazyVGrid(columns: ComposerAgentGridLayout.columns, spacing: TTSpacing.md) {
            ForEach(agents) { agent in
                let isSelected = agent.id == selectedAgentId
                Button {
                    onSelect(agent)
                } label: {
                    ComposerAgentGridCell(
                        agent: agent,
                        isSelected: isSelected,
                        showsLock: !agentIsMutable && isSelected
                    )
                }
                .buttonStyle(.plain)
                .disabled(!agent.isAvailable || (!agentIsMutable && !isSelected))
                .accessibilityLabel(
                    "Agent：\(agent.name)\(isSelected ? "，已选中" : "")\(agent.isAvailable ? "" : "，\(agent.unavailableReason ?? "当前不可用")")\(agentIsMutable ? "" : "，不可更换")"
                )
                .accessibilityHint(agentIsMutable ? "选择执行 Agent" : "当前暂不可更换执行 Agent")
            }
        }
    }
}

private struct ComposerAgentGridCell: View {
    let agent: ComposerTaskAgentOption
    let isSelected: Bool
    let showsLock: Bool

    var body: some View {
        VStack(spacing: TTSpacing.xs) {
            ZStack(alignment: .topTrailing) {
                AgentAvatar(option: agent, size: ComposerAgentGridLayout.avatarSize)
                    .overlay {
                        Circle()
                            .strokeBorder(
                                isSelected ? Color.tt.bgAccent : Color.clear,
                                lineWidth: 2
                            )
                    }

                if showsLock {
                    Image(systemName: "lock.fill")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textOnAccent)
                        .padding(3)
                        .background(Circle().fill(.tt.bgAccent))
                        .offset(x: 4, y: -4)
                } else if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.tt.iconSubtitle)
                        .foregroundStyle(.tt.bgAccent)
                        .background(Circle().fill(.tt.bgCanvasDefault).padding(1))
                        .offset(x: 4, y: -4)
                }
            }

            Text(ComposerAgentGridLayout.displayName(agent.name))
                .font(.tt.captionSemibold)
                .foregroundStyle(agent.isAvailable ? .tt.textPrimary : .tt.textTertiary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
        .padding(.vertical, TTSpacing.xs)
        .padding(.horizontal, 2)
        .opacity(agent.isAvailable ? 1 : 0.55)
        .contentShape(Rectangle())
    }
}

struct AgentAvatar: View {
    let option: ComposerTaskAgentOption
    var size: CGFloat = 34

    var body: some View {
        Group {
            if let preset = option.avatarPreset {
                Image(preset.imageName)
                    .resizable()
                    .scaledToFill()
            } else if let url = resolvedAvatarURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        letterPlaceholder
                    }
                }
            } else if let glyph = emojiOrTextGlyph {
                Text(glyph)
                    .font(.system(size: size * 0.45))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.tt.bgSubtle)
            } else {
                letterPlaceholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var resolvedAvatarURL: URL? {
        guard let raw = option.avatar?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return nil }
        return url
    }

    /// 非 URL 的短文本（emoji / 单字）才当字形用；预置 key 已由 avatarPreset 承接。
    private var emojiOrTextGlyph: String? {
        guard option.avatarPreset == nil,
              resolvedAvatarURL == nil,
              let raw = option.avatar?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              AgentAvatarPreset(rawValue: raw) == nil
        else { return nil }
        return raw
    }

    private var letterPlaceholder: some View {
        ZStack {
            Circle().fill(.tt.bgAccent.opacity(0.14))
            Text(String(option.name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(.tt.iconAccent)
        }
    }
}

/// Composer 模型选择抽屉：从工具条模型名点按拉起，与任务设置抽屉同一交互范式。
/// L1 只选模型；有运行设置能力时底部露出「运行设置」入口，打开 L2 二级 sheet。
struct ComposerModelSelectionDrawer: View {
    @Environment(\.dismiss) private var dismiss
    let models: [ChatModel]
    let providers: [String: ChatModelProviderMetadata]
    let selectedModelId: String?
    let selectedContextTierId: String?
    let selectedThinkingMode: ChatModelThinkingMode?
    let onSelect: (ChatModel) -> Void
    let onSelectContextTier: (String) -> Void
    let onSelectThinkingMode: (ChatModelThinkingMode) -> Void

    @State private var runtimeSettingsModel: ChatModel?

    private var selectedModel: ChatModel? {
        guard let selectedModelId else { return nil }
        return models.first(where: { $0.id == selectedModelId })
    }

    private var showsRuntimeSettingsEntry: Bool {
        selectedModel?.showsRuntimeSettings == true
    }

    private var runtimeSettingsSummary: String? {
        ComposerRuntimeSettingsProjection.runtimeSummary(
            model: selectedModel,
            selectedTierId: selectedContextTierId,
            selectedThinkingMode: selectedThinkingMode
        )
    }

    private var modelGroups: [(source: ChatModelSource, models: [ChatModel])] {
        ChatModelSource.allCases.compactMap { source in
            let sourceModels = models.filter { $0.source == source }
            return sourceModels.isEmpty ? nil : (source, sourceModels)
        }
    }

    var body: some View {
        Group {
            if models.isEmpty {
                Text("暂无可用模型")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(.horizontal, TTSpacing.lg)
                    .padding(.top, ComposerDrawerLayout.topContentInset)
                    .padding(.bottom, TTSpacing.lg)
            } else {
                // List 在 sheet 里会铺满整块可视区；用 safeAreaInset 钉住底部入口，
                // 并自动抬高滚动内容，避免「运行设置」遮住最后一个模型。
                List {
                    ForEach(modelGroups, id: \.source) { group in
                        Section {
                            ForEach(group.models) { model in
                                modelRow(model)
                                    .listRowInsets(
                                        EdgeInsets(
                                            top: TTSpacing.xs,
                                            leading: TTSpacing.lg,
                                            bottom: TTSpacing.xs,
                                            trailing: TTSpacing.lg
                                        )
                                    )
                                    .listRowSeparator(.hidden)
                                    .listRowBackground(Color.clear)
                            }
                        } header: {
                            Text(group.source.title)
                                .font(.tt.captionSemibold)
                                .foregroundStyle(.tt.textTertiary)
                                .textCase(nil)
                                .accessibilityAddTraits(.isHeader)
                        }
                        .listSectionSeparator(.hidden)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .contentMargins(
                    .top,
                    ComposerDrawerLayout.topContentInset,
                    for: .scrollContent
                )
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if showsRuntimeSettingsEntry {
                        runtimeSettingsEntry
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.tt.bgCanvasDefault)
        .sheet(item: $runtimeSettingsModel) { model in
            ComposerRuntimeSettingsSheet(
                model: model,
                providerIconURL: providers[model.provider]?.iconURL,
                selectedContextTierId: selectedContextTierId,
                selectedThinkingMode: selectedThinkingMode,
                onSelectContextTier: onSelectContextTier,
                onSelectThinkingMode: onSelectThinkingMode
            )
        }
    }

    private var runtimeSettingsEntry: some View {
        Button {
            runtimeSettingsModel = selectedModel
        } label: {
            HStack(alignment: .center, spacing: TTSpacing.md) {
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text("运行设置")
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Text(runtimeSettingsSummary ?? "上下文长度、思考强度")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(2)
                }
                Spacer(minLength: TTSpacing.sm)
                Image(systemName: "chevron.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous)
                    .fill(.tt.bgSubtleSecondary)
            )
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous)
                    .strokeBorder(.tt.borderLight, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, TTSpacing.lg)
        .padding(.top, TTSpacing.sm)
        .padding(.bottom, TTSpacing.lg)
        // 实色底，避免列表滚到入口后方透出来
        .background(.tt.bgCanvasDefault)
        .accessibilityLabel("运行设置")
        .accessibilityHint("调整上下文长度与思考强度")
        .accessibilityValue(runtimeSettingsSummary ?? "")
    }

    @ViewBuilder
    private func modelRow(_ model: ChatModel) -> some View {
        Button {
            onSelect(model)
            // 选模型留在 L1，方便继续进运行设置；不自动 dismiss。
        } label: {
            HStack(spacing: TTSpacing.sm) {
                ProviderBrandIcon(
                    iconURL: providers[model.provider]?.iconURL,
                    size: 24
                )

                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    HStack(spacing: TTSpacing.xs) {
                        Text(model.displayName)
                            .font(.tt.bodySemibold)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        if let promotionCreditSummary = model.promotionCreditSummary {
                            Text(promotionCreditSummary)
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                                .lineLimit(1)
                        }
                    }

                    HStack(spacing: TTSpacing.xxs) {
                        ForEach(ModelSelectionProjection.capabilityLabels(for: model), id: \.self) { label in
                            Text(label)
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textSecondary)
                                .padding(.horizontal, TTSpacing.xxs)
                                .padding(.vertical, 2)
                                .background(.tt.bgSubtle, in: Capsule())
                        }
                    }
                }

                Spacer(minLength: TTSpacing.sm)

                if model.id == selectedModelId {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.tt.iconBody)
                        .foregroundStyle(.tt.iconAccent)
                        .accessibilityLabel("当前选择")
                }
            }
            .frame(minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(model.displayName)，\(ModelSelectionProjection.capabilityLabels(for: model).joined(separator: "、"))"
                + (model.id == selectedModelId ? "，当前选择" : "")
        )
    }
}

/// L2 运行设置：上下文长度 + 思考强度芯片组（文案冻结，不抄 Electron 双栏）。
struct ComposerRuntimeSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let model: ChatModel
    let providerIconURL: String?
    let selectedContextTierId: String?
    let selectedThinkingMode: ChatModelThinkingMode?
    let onSelectContextTier: (String) -> Void
    let onSelectThinkingMode: (ChatModelThinkingMode) -> Void

    private var activeContextTierId: String? {
        ComposerRuntimeSettingsProjection.resolveActiveContextTierId(
            model: model,
            selectedTierId: selectedContextTierId
        )
    }

    private var thinkingCapability: ChatModelThinkingCapability? {
        model.thinkingCapability
    }

    private var activeThinkingMode: ChatModelThinkingMode? {
        guard let thinkingCapability else { return nil }
        return ComposerRuntimeSettingsProjection.resolveActiveThinkingMode(
            capability: thinkingCapability,
            selected: selectedThinkingMode
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.xl) {
                    modelPill

                    if model.showsContextLengthSection {
                        contextSection
                    }

                    if let thinkingCapability {
                        thinkingSection(capability: thinkingCapability)
                    }

                    if !model.showsContextLengthSection && thinkingCapability == nil {
                        Text("当前模型无可调运行设置")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                .padding(.horizontal, TTSpacing.lg)
                .padding(.top, TTSpacing.sm)
                .padding(.bottom, TTSpacing.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle("运行设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("返回") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.tt.bgCanvasDefault)
    }

    private var modelPill: some View {
        HStack(spacing: TTSpacing.sm) {
            ProviderBrandIcon(iconURL: providerIconURL, size: 22)
            Text(model.displayName)
                .font(.tt.metaSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .fill(.tt.bgSubtleSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .strokeBorder(.tt.borderLight, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var contextSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text("上下文长度")
                .font(.tt.caption)
                .foregroundStyle(.tt.textPrimary)

            if model.canSelectContextTier {
                FlowChipWrap {
                    ForEach(model.selectableContextTiers) { tier in
                        runtimeChip(
                            title: tier.label,
                            isActive: tier.id == activeContextTierId,
                            showsBeta: tier.tags.contains(where: { $0.caseInsensitiveCompare("beta") == .orderedSame }),
                            isReadOnly: false
                        ) {
                            onSelectContextTier(tier.id)
                        }
                    }
                }
            } else if let tokens = model.contextWindowTokens, tokens > 0 {
                runtimeChip(
                    title: ComposerRuntimeSettingsProjection.formatContextWindowLabel(tokens),
                    isActive: true,
                    showsBeta: false,
                    isReadOnly: true
                ) {}
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("上下文长度")
    }

    private func thinkingSection(capability: ChatModelThinkingCapability) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text("思考强度")
                .font(.tt.caption)
                .foregroundStyle(.tt.textPrimary)

            FlowChipWrap {
                ForEach(capability.modes, id: \.rawValue) { mode in
                    runtimeChip(
                        title: mode.displayLabel,
                        isActive: mode == activeThinkingMode,
                        showsBeta: false,
                        isReadOnly: false
                    ) {
                        onSelectThinkingMode(mode)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("思考强度")
    }

    private func runtimeChip(
        title: String,
        isActive: Bool,
        showsBeta: Bool,
        isReadOnly: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: TTSpacing.xxs) {
                Text(title)
                    .font(.tt.meta)
                if showsBeta {
                    Text("Beta")
                        .font(.tt.captionSemibold)
                        .foregroundStyle(isActive ? .tt.textAccent : .tt.textWarning)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(
                            (isActive ? Color.tt.bgAccent.opacity(0.16) : Color.tt.bgWarning.opacity(0.12)),
                            in: RoundedRectangle(cornerRadius: TTRadius.xs, style: .continuous)
                        )
                }
            }
            .foregroundStyle(isActive ? .tt.textAccent : .tt.textSecondary)
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                    .fill(isActive ? Color.tt.bgAccent.opacity(0.12) : Color.tt.bgSubtle)
            )
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                    .strokeBorder(
                        isActive ? Color.tt.bgAccent.opacity(0.28) : Color.clear,
                        lineWidth: 1
                    )
            )
        }
        .buttonStyle(.plain)
        .disabled(isReadOnly)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .accessibilityLabel(showsBeta ? "\(title)，Beta" : title)
    }
}

/// 简易横向换行芯片容器（运行设置芯片组）。
private struct FlowChipWrap<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        // iOS 16+ Layout；芯片数量少，用 LazyVGrid 自适应足够。
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 72), spacing: TTSpacing.sm, alignment: .leading)],
            alignment: .leading,
            spacing: TTSpacing.sm
        ) {
            content()
        }
    }
}

struct ProviderBrandIcon: View {
    let iconURL: String?
    var size: CGFloat = 20

    var body: some View {
        Group {
            if let url = ProviderIconURLResolver.resolve(iconURL) {
                AsyncImage(url: url) { phase in
                    if case let .success(image) = phase {
                        image.resizable().scaledToFit()
                    } else {
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var fallback: some View {
        Image(systemName: "cpu")
            .font(.system(size: size * 0.65, weight: .semibold))
            .foregroundStyle(.tt.textAccent)
    }
}

/// 通用选项列表（push 版）：图标 + 标题 + 说明 + 选中态；
/// 供任务设置抽屉的二级页复用，不带 NavigationStack 壳。
private struct ComposerOptionList<Option: Identifiable & Equatable>: View where Option.ID == String {
    let options: [Option]
    let selectedId: String
    let disabledReason: (Option) -> String?
    let onSelect: (Option) -> Void
    let content: (Option) -> (title: String, summary: String, icon: String, tint: Color)

    init(
        options: [Option],
        selectedId: String,
        disabledReason: @escaping (Option) -> String? = { _ in nil },
        onSelect: @escaping (Option) -> Void,
        content: @escaping (Option) -> (title: String, summary: String, icon: String, tint: Color)
    ) {
        self.options = options
        self.selectedId = selectedId
        self.disabledReason = disabledReason
        self.onSelect = onSelect
        self.content = content
    }

    var body: some View {
        List(options) { option in
            let presentation = content(option)
            let unavailableReason = disabledReason(option)
            Button { onSelect(option) } label: {
                HStack(alignment: .top, spacing: TTSpacing.md) {
                    Image(systemName: presentation.icon)
                        .font(.tt.iconSubtitle)
                        .foregroundStyle(presentation.tint)
                        .frame(width: 24, height: 24)
                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                        Text(presentation.title).font(.tt.bodySemibold)
                        Text(presentation.summary)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let unavailableReason {
                            Text(unavailableReason)
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textWarning)
                        }
                    }
                    Spacer(minLength: 0)
                    if option.id == selectedId {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.tt.iconAccent)
                    }
                }
                .padding(.vertical, TTSpacing.xxs)
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(unavailableReason != nil)
            .accessibilityLabel("\(presentation.title)，\(presentation.summary)\(option.id == selectedId ? "，已选中" : "")\(unavailableReason.map { "，\($0)" } ?? "")")
        }
    }
}

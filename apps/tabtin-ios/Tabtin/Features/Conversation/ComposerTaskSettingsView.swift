import SwiftUI

/// Composer 的紧凑设置入口。
///
/// Agent/mode、审批与执行位置共用输入井工具栏。模型属于会话级上下文，由
/// Conversation 顶部导航承载；Composer 不再为设置项生成第二行。
struct ComposerTaskSettingsView: View {
    let agentName: String?
    let agentOptions: [ComposerTaskAgentOption]
    let selectedAgentId: String?
    /// 个人 Workspace 会话可改；团队 Space 会话的执行归属保持只读。
    let agentIsMutable: Bool
    let currentMode: String
    let currentApprovalMode: String
    let workspaceName: String?
    let executionLocationHint: String?
    /// 草稿态可切换执行 Workspace；已有会话保持只读说明。
    var canSwitchExecutionWorkspace: Bool = false
    var executionWorkspaceOptions: [ComposerExecutionWorkspaceOption] = []
    var selectedExecutionWorkspaceId: String? = nil
    let permitsRelaxedApproval: Bool
    let disabled: Bool
    let onAgentChange: (ComposerTaskAgentOption) -> Void
    let onModeChange: (String) -> Void
    let onApprovalModeChange: (String) -> Void
    let onExecutionLocationHelp: () -> Void
    var onSelectExecutionWorkspace: (ComposerExecutionWorkspaceOption) -> Void = { _ in }
    var onSelectTool: (ComposerTool) -> Void = { _ in }

    @State private var showSettingsDrawer = false

    private var agentTitle: String {
        let name = agentName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "当前 Agent" : name
    }

    private var mode: ComposerModeOption {
        ComposerModeOption(mode: ChatAgentMode.resolve(currentMode))
    }

    private var selectedAgent: ComposerTaskAgentOption? {
        if let selectedAgentId,
           let selected = agentOptions.first(where: { $0.id == selectedAgentId }) {
            return selected
        }
        return agentOptions.first(where: { $0.name == agentTitle })
    }

    private var approval: ComposerApprovalOption {
        ComposerApprovalOption(
            approval: ChatApprovalMode.resolve(currentApprovalMode) ?? .alwaysAsk
        )
    }

    var body: some View {
        toolbarControls
        .accessibilityElement(children: .contain)
        .sheet(isPresented: $showSettingsDrawer) {
            ComposerSettingsDrawer(
                agentOptions: agentOptions,
                selectedAgentId: selectedAgent?.id,
                agentTitle: agentTitle,
                agentIsMutable: agentIsMutable,
                currentMode: mode,
                currentApproval: approval,
                permitsRelaxedApproval: permitsRelaxedApproval,
                onSelectTool: onSelectTool,
                onAgentChange: onAgentChange,
                onModeChange: onModeChange,
                onApprovalModeChange: onApprovalModeChange
            )
        }
    }

    private var toolbarControls: some View {
        HStack(spacing: 0) {
            settingsControl
            executionLocationControl
        }
    }

    /// 唯一入口：灰色圆底「+」；附件与 Agent / 工作方式 / 审批
    /// 一并收进抽屉（上宫格、下列表）。
    private var settingsControl: some View {
        Button {
            showSettingsDrawer = true
        } label: {
            Image(systemName: "plus")
                .font(.tt.iconCaptionMedium)
                .foregroundStyle(disabled ? .tt.textTertiary : .tt.textSecondary)
                .frame(width: 28, height: 28)
                .background(Circle().fill(.tt.bgSubtle))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(
            "任务设置。Agent：\(agentTitle)；工作方式：\(mode.title)；审批权限：\(approval.title)"
        )
        .accessibilityHint("打开任务设置，可添加附件、更换执行 Agent、工作方式和审批权限")
    }

    /// 已有会话的执行 Workspace 已定，工具条不再展示文件夹入口（会话信息里可看）。
    /// 仅草稿且可选多个执行 Workspace 时保留切换菜单。
    @ViewBuilder
    private var executionLocationControl: some View {
        if canSwitchExecutionWorkspace,
           executionWorkspaceOptions.count > 1,
           let workspace = normalizedWorkspaceName {
            Menu {
                ForEach(executionWorkspaceOptions) { option in
                    Button {
                        onSelectExecutionWorkspace(option)
                    } label: {
                        Label(
                            option.name,
                            systemImage: option.id == selectedExecutionWorkspaceId
                                ? "checkmark"
                                : "folder"
                        )
                    }
                }
            } label: {
                Image(systemName: "folder")
                    .font(.tt.iconBody)
                    .foregroundStyle(.tt.textSecondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .accessibilityLabel("执行于：\(workspace)")
            .accessibilityHint("选择执行 Workspace")
        }
    }

    private var normalizedWorkspaceName: String? {
        let name = workspaceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? nil : name
    }
}

struct ComposerTaskAgentOption: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    var subtitle: String? = nil
    /// 自定义头像 URL，或遗留的 emoji / 短文本 icon。
    var avatar: String? = nil
    /// 与 Electron /「我的 Agent」列表同一套 `avatar_key` 预置图；优先于 URL。
    var avatarPreset: AgentAvatarPreset? = nil
    var defaultModelName: String? = nil
    var isAvailable = true
    var unavailableReason: String? = nil
}

struct ComposerExecutionWorkspaceOption: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let organizationId: String
}

struct ComposerModeOption: Identifiable, Equatable {
    let mode: ChatAgentMode
    let title: String
    let summary: String
    let icon: String
    let tint: Color

    var id: String { mode.rawValue }

    static var selectable: [ComposerModeOption] {
        ChatAgentMode.allCases.map(ComposerModeOption.init(mode:))
    }

    init(mode: ChatAgentMode) {
        self.mode = mode
        switch mode {
        case .ask:
            (title, summary, icon, tint) = ("问答", "搜索、分析和解释，不主动改动内容", "questionmark.bubble", .blue)
        case .agent:
            (title, summary, icon, tint) = ("执行", "使用工具完成任务", "terminal", .tt.textSuccess)
        case .plan:
            (title, summary, icon, tint) = ("规划", "先形成计划，再决定是否执行", "map", .tt.textWarning)
        case .group:
            (title, summary, icon, tint) = ("PMO", "拆解任务、跟进进度，并调度子 Agent", "person.3", .tt.textAccent)
        }
    }
}

struct ComposerApprovalOption: Identifiable, Equatable {
    let approval: ChatApprovalMode
    let title: String
    let summary: String
    let icon: String
    let tint: Color
    let requiresRiskConfirmation: Bool

    var id: String { approval.rawValue }

    static var selectable: [ComposerApprovalOption] {
        ChatApprovalMode.allCases.map(ComposerApprovalOption.init(approval:))
    }

    init(approval: ChatApprovalMode) {
        self.approval = approval
        switch approval {
        case .alwaysAsk:
            (title, summary, icon, tint, requiresRiskConfirmation) = (
                "请求权限", "操作前先请求授权", "checkmark.shield", .tt.textSecondary, false
            )
        case .auto:
            (title, summary, icon, tint, requiresRiskConfirmation) = (
                "自动通过", "常规操作自动批准，高风险仍会询问", "shield", .tt.textWarning, false
            )
        case .fullAccess:
            (title, summary, icon, tint, requiresRiskConfirmation) = (
                "全部允许", "无需授权直接执行", "exclamationmark.shield", .tt.textCritical, true
            )
        }
    }

    var accessibilityHint: String {
        requiresRiskConfirmation
            ? "全部允许会减少操作前的确认，点按可查看风险说明"
            : summary
    }
}

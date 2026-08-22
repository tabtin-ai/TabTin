import SwiftUI

/// Project 的任务入口只补齐归档与执行现场语义，随后统一进入 ConversationScreen 草稿。
/// 它不创建 Session、不收集任务正文，也不重复提供 Agent 前置选择。
struct ProjectTaskComposerSheet: View {
    let project: Project
    let workspace: ProjectCompanionWorkspace?
    let onOpenDraft: (String?) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: TTSpacing.lg) {
                archiveDestination
                executionLocation
                Text("任务内容、资料和执行方式将在下一步的对话草稿中统一设置。")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(TTSpacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(.tt.bgCanvasDefault)
            .navigationTitle(L10n.Project.taskTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("开始撰写任务") {
                        onOpenDraft(executionAgentId)
                    }
                    .disabled(workspace == nil)
                }
            }
        }
    }

    private var archiveDestination: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label("归档到 Project", systemImage: "folder.badge.gearshape")
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(project.name)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgAccent.opacity(0.08), in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

    @ViewBuilder
    private var executionLocation: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label("执行位置", systemImage: "desktopcomputer")
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            if let workspace {
                Text(workspace.name?.nonEmpty ?? project.name)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                if let status = workspace.controlDeviceStatus?.nonEmpty {
                    Text(deviceStatusDescription(status))
                        .font(.tt.caption)
                        .foregroundStyle(deviceStatusColor(status))
                }
            } else {
                Text(L10n.Project.taskNoWorkspace)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textWarning)
            }
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

    /// 有绑定时作为草稿的默认 Agent；没有绑定也允许进入草稿再选择。
    private var executionAgentId: String? {
        workspace?.executionAgentId?.nonEmpty ?? workspace?.agentId?.nonEmpty
    }

    private func deviceStatusDescription(_ status: String) -> String {
        switch status.lowercased() {
        case "online": return L10n.SpaceList.deviceOnline
        case "busy": return L10n.SpaceList.deviceBusy
        case "offline": return L10n.SpaceList.deviceOffline
        default: return L10n.SpaceList.deviceUnknown
        }
    }

    private func deviceStatusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "online": return .tt.textSuccess
        case "busy": return .tt.textWarning
        case "offline": return .tt.textTertiary
        default: return .tt.textSecondary
        }
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

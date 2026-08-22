import SwiftUI

enum ChatSessionInfoPolicy {
    static func copyStatusText(_ raw: String?) -> String? {
        switch raw {
        case "pending": return "消息正在后台复制；完成前请勿发送新消息"
        case "complete": return "复制完成"
        case "failed": return "消息复制失败"
        case let value? where !value.isEmpty: return "复制状态：\(value)"
        default: return nil
        }
    }

    static func display(_ value: String?) -> String {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return "未提供"
        }
        return value
    }

    static func modeTitle(_ raw: String?) -> String {
        let normalized = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !normalized.isEmpty else { return "未提供" }
        guard let mode = ChatAgentMode(rawValue: normalized) else { return normalized }
        return ComposerModeOption(mode: mode).title
    }

    static func approvalTitle(_ raw: String?) -> String {
        let normalized = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !normalized.isEmpty else { return "未提供" }
        guard let approval = ChatApprovalMode(rawValue: normalized) else { return normalized }
        return ComposerApprovalOption(approval: approval).title
    }
}

/// 会话是独立的工作单元：本页只展示 `ChatSessionSchema` 或当前执行现场明确提供的事实。
/// 缺字段一律标为“未提供”，不从标题、默认值或 Workspace 推断会话配置。
struct ConversationSessionInfoSheet: View {
    let session: ChatSession
    let agentName: String?
    let workspaceName: String?
    let deviceName: String?
    let deviceStatus: String?
    let runtimeStatus: String?
    let onRename: (String) async throws -> ChatSession

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var isSaving = false
    @State private var saveError: String?

    init(
        session: ChatSession,
        agentName: String?,
        workspaceName: String?,
        deviceName: String?,
        deviceStatus: String?,
        runtimeStatus: String?,
        onRename: @escaping (String) async throws -> ChatSession
    ) {
        self.session = session
        self.agentName = agentName
        self.workspaceName = workspaceName
        self.deviceName = deviceName
        self.deviceStatus = deviceStatus
        self.runtimeStatus = runtimeStatus
        self.onRename = onRename
        _title = State(initialValue: session.title ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("会话") {
                    TextField("会话标题", text: $title)
                    Button(isSaving ? "正在保存…" : "保存标题") {
                        saveTitle()
                    }
                    .disabled(isSaving || normalizedTitle == session.title)
                    if let saveError {
                        Text(saveError).foregroundStyle(.tt.textCritical)
                    }
                    LabeledContent("会话 ID", value: session.id)
                    LabeledContent("会话状态", value: ChatSessionInfoPolicy.display(session.status))
                    if let runtimeStatus, !runtimeStatus.isEmpty {
                        LabeledContent("当前运行", value: runtimeStatus)
                    }
                    if let createdAt = session.createdAt {
                        LabeledContent("创建时间", value: createdAt)
                    }
                }

                Section("冻结配置") {
                    LabeledContent(
                        "Agent",
                        value: ChatSessionInfoPolicy.display(agentName ?? session.agentId)
                    )
                    LabeledContent("模式", value: ChatSessionInfoPolicy.modeTitle(session.agentMode))
                    LabeledContent("审批", value: ChatSessionInfoPolicy.approvalTitle(session.approvalMode))
                    LabeledContent(
                        "模型",
                        value: ChatSessionInfoPolicy.display(
                            session.currentModelName
                                ?? session.currentModelId
                                ?? session.defaultModelName
                                ?? session.defaultModelId
                        )
                    )
                    if let tier = session.contextTierId {
                        LabeledContent("上下文档位", value: tier)
                    }
                }

                Section("执行现场") {
                    LabeledContent("Workspace", value: workspaceName ?? ChatSessionInfoPolicy.display(session.workspaceId))
                    LabeledContent("设备", value: ChatSessionInfoPolicy.display(deviceName))
                    if let deviceStatus, !deviceStatus.isEmpty {
                        LabeledContent("设备状态", value: deviceStatus)
                    }
                    if let projectId = session.projectId {
                        LabeledContent("Project", value: projectId)
                    }
                }

                if session.forkedFromId != nil || session.forkCount != nil || session.forkCopyStatus != nil || !(session.warnings ?? []).isEmpty {
                    Section("分支血缘") {
                        if let parent = session.forkedFromId {
                            // 当前 scope 没有已解析的父会话入口，诚实展示 ID 而不伪造跳转。
                            LabeledContent("来源会话", value: parent)
                        }
                        if let point = session.forkPointMessageId {
                            LabeledContent("分叉消息", value: point)
                        }
                        if let count = session.forkCount {
                            LabeledContent("子分支", value: "\(count)")
                        }
                        if let copy = ChatSessionInfoPolicy.copyStatusText(session.forkCopyStatus) {
                            Text(copy)
                        }
                        ForEach(session.warnings ?? [], id: \.self) { warning in
                            Label(warning, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.tt.textWarning)
                        }
                    }
                }
            }
            .navigationTitle("会话信息")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }

    private var normalizedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func saveTitle() {
        guard !normalizedTitle.isEmpty else {
            saveError = "标题不能为空"
            return
        }
        isSaving = true
        saveError = nil
        Task {
            do {
                _ = try await onRename(normalizedTitle)
                isSaving = false
            } catch {
                isSaving = false
                saveError = "保存失败：\(error.localizedDescription)"
            }
        }
    }
}

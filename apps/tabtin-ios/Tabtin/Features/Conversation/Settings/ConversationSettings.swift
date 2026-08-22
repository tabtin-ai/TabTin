import AVFoundation
import Foundation
import os
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// MARK: - 会话设置

struct ConversationSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var store = WorkspaceStore.shared
    @State private var settingsStore = AgentSettingsStore()
    @State private var showDeleteConfirm = false
    @State private var deleteInputValue = ""
    @State private var isDeleting = false
    @State private var errorMessage: String?

    let spaceId: String

    private var space: Space? {
        store.spaces.first { $0.id == spaceId }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    header

                    Spacer().frame(height: TTSpacing.xxxl)

                    settingsGroup {
                        NavigationLink { SpaceBasicInfoEditor(spaceId: spaceId) } label: {
                            settingsRow(icon: "pencil", title: "基础信息")
                        }
                        NavigationLink { SpaceRulesEditor(settingsStore: settingsStore) } label: {
                            settingsRow(icon: "list.bullet.clipboard", title: "自定义规则", value: truncatedPreview(settingsStore.workspace?.customRules))
                        }
                        NavigationLink { SpaceWorkTypeEditor(settingsStore: settingsStore) } label: {
                            settingsRow(icon: "folder.badge.gearshape", title: "工作类型", value: workTypeSummary)
                        }
                    }

                    Spacer().frame(height: TTSpacing.xxxl)

                    settingsGroup {
                        NavigationLink {
                            MemorySettingsEditor(
                                organizationId: space?.organizationId ?? store.selectedOrganizationId,
                            )
                        } label: {
                            settingsRow(icon: "brain.head.profile", title: "记忆")
                        }
                        NavigationLink {
                            SkillsManagementEditor(
                                spaceId: spaceId,
                                organizationId: space?.organizationId ?? store.selectedOrganizationId,
                                preferredAgentId: space?.primaryAgentId
                            )
                        } label: {
                            settingsRow(icon: "sparkles", title: "Skill")
                        }
                        NavigationLink { SubAgentListEditor(spaceId: spaceId) } label: {
                            settingsRow(icon: "cpu", title: "子 Agent")
                        }
                    }

                    Spacer().frame(height: TTSpacing.xxxl)

                    settingsGroup {
                        NavigationLink { SecuritySettingsEditor(spaceId: spaceId, settingsStore: settingsStore) } label: {
                            settingsRow(icon: "shield.checkered", title: "安全", value: (WorkspaceStore.shared.allowMemberYolo && settingsStore.allowYoloMode) ? "YOLO" : nil)
                        }
                        NavigationLink { ExecutionLimitsEditor(settingsStore: settingsStore) } label: {
                            settingsRow(icon: "gauge.with.dots.needle.33percent", title: "执行限制", value: settingsStore.executionLimitsSummary)
                        }
                    }

                    Spacer().frame(height: TTSpacing.xxxl)

                    settingsGroup {
                        NavigationLink { ArchivedSessionsEditor(spaceId: spaceId) } label: {
                            settingsRow(icon: "archivebox", title: "归档会话")
                        }
                        NavigationLink { TrashBinEditor(spaceId: spaceId) } label: {
                            settingsRow(icon: "trash", title: "回收站")
                        }
                    }

                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textCritical)
                            .padding(.horizontal, TTSpacing.xl)
                            .padding(.top, TTSpacing.lg)
                    }

                    Spacer().frame(height: TTSpacing.xxxl)
                    dangerSection
                    Spacer().frame(height: TTSpacing.huge)
                }
            }
            .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .ttToolbarBackground()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .font(.tt.bodySemibold)
                }
            }
        }
        .alert("删除这个 Workspace？", isPresented: $showDeleteConfirm) {
            TextField("输入 Workspace 名称", text: $deleteInputValue)
            Button("删除", role: .destructive) {
                Task { await deleteSpace() }
            }
            Button("取消", role: .cancel) {
                deleteInputValue = ""
            }
        } message: {
            Text("请输入「\(space?.name ?? "")」确认删除。此操作会删除该 Workspace 及其会话，Agent 和设备不会被删除。")
        }
        .ttLoading(isDeleting)
        .task {
            if space == nil {
                await store.loadSpaces()
            }
            await settingsStore.load(space: space)
        }
        .onChange(of: space?.agentId) { _, _ in
            Task { await settingsStore.load(space: space) }
        }
        .alert("操作失败", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("好", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var header: some View {
        VStack(spacing: TTSpacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.tt.bgAccent.opacity(0.14))
                    .frame(width: 56, height: 56)
                Text(String((space?.name ?? "A").prefix(1)).uppercased())
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.iconAccent)
            }

            VStack(spacing: TTSpacing.xs) {
                Text(space?.name ?? "Workspace")
                    .font(.tt.titleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                if let desc = space?.description, !desc.isEmpty {
                    Text(desc)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, TTSpacing.xl)
        .padding(.horizontal, TTSpacing.xl)
    }

    private func settingsGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            content()
        }
        .padding(.horizontal, TTSpacing.xl)
    }

    private func settingsRow(icon: String, title: String, value: String? = nil) -> some View {
        HStack(spacing: TTSpacing.md) {
            Image(systemName: icon)
                .font(.tt.iconSubtitle)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 28)
            Text(title)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
            Spacer()
            if let value, !value.isEmpty {
                Text(value)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
            Image(systemName: "chevron.right")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textTertiary)
        }
        .padding(.vertical, TTSpacing.lg)
        .contentShape(Rectangle())
    }

    private var dangerSection: some View {
        VStack(spacing: 0) {
            Button {
                deleteInputValue = ""
                showDeleteConfirm = true
            } label: {
                HStack(spacing: TTSpacing.md) {
                    Image(systemName: "trash")
                        .font(.tt.iconSubtitle)
                        .foregroundStyle(.tt.textCritical)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                        Text("删除 Workspace")
                            .font(.tt.body)
                            .foregroundStyle(.tt.textCritical)
                        Text("永久删除前需要完整确认流程。")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                    Spacer()
                }
                .padding(.vertical, TTSpacing.lg)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, TTSpacing.xl)
    }

    private var workTypeSummary: String? {
        guard let workspace = settingsStore.workspace else { return nil }
        if let label = WorkType.displayLabel(workspace.workingDirType) {
            return label
        }
        if !workspace.workingDir.isEmpty {
            return "待选择"
        }
        return nil
    }

    private func truncatedPreview(_ text: String?, maxLength: Int = 15) -> String {
        guard let text, !text.isEmpty else { return "" }
        let firstLine = text.components(separatedBy: .newlines).first ?? text
        let trimmed = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count > maxLength { return String(trimmed.prefix(maxLength)) + "..." }
        return trimmed
    }

    private func deleteSpace() async {
        guard let space else { return }
        guard deleteInputValue.trimmingCharacters(in: .whitespacesAndNewlines) == space.name else {
            errorMessage = "Workspace 名称不匹配"
            return
        }
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await store.deleteSpace(space.id)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SpaceBasicInfoEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var store = WorkspaceStore.shared
    @State private var name = ""
    @State private var description = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    let spaceId: String

    private enum Field { case name, description }

    private var space: Space? {
        store.spaces.first { $0.id == spaceId }
    }

    private var isDirty: Bool {
        guard let space else { return false }
        return name.trimmingCharacters(in: .whitespacesAndNewlines) != space.name
            || description.trimmingCharacters(in: .whitespacesAndNewlines) != (space.description ?? "")
    }

    var body: some View {
        ScrollView {
            VStack(spacing: TTSpacing.xl) {
                field(title: "名称") {
                    TextField("Workspace 名称", text: $name)
                        .font(.tt.body)
                        .focused($focusedField, equals: .name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(TTSpacing.md)
                        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
                }
                field(title: "描述") {
                    TextField("描述这个 Workspace", text: $description, axis: .vertical)
                        .font(.tt.body)
                        .lineLimit(2...4)
                        .focused($focusedField, equals: .description)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(TTSpacing.md)
                        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
                }
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                }
            }
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle("基础信息")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") { Task { await save() } }
                    .font(.tt.bodySemibold)
                    .disabled(!isDirty || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
            }
        }
        .ttLoading(isSaving)
        .onAppear { load() }
    }

    private func field<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Text(title)
                .font(.tt.metaSemibold)
                .foregroundStyle(.tt.textSecondary)
            content()
        }
    }

    private func load() {
        guard let space else { return }
        name = space.name
        description = space.description ?? ""
    }

    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await store.updateSpace(spaceId, name: name, description: description)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Agent 设置轻量模型

private enum SettingsJSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: SettingsJSONValue])
    case array([SettingsJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: SettingsJSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([SettingsJSONValue].self) {
            self = .array(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var objectValue: [String: SettingsJSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var intValue: Int? {
        if case .number(let value) = self { return Int(value) }
        return nil
    }
}

private struct AgentSettingsAgent: Codable, Identifiable, Sendable {
    let id: String
    let organizationId: String?
    var name: String?
    var agentConfig: [String: SettingsJSONValue]?

    enum CodingKeys: String, CodingKey {
        case id, name
        case organizationId = "organization_id"
        case agentConfig = "agent_config"
    }

    var allowYoloMode: Bool {
        agentConfig?["security"]?.objectValue?["allow_yolo_mode"]?.boolValue ?? false
    }

    var workspaceRoot: String? {
        agentConfig?["workspace_root"]?.stringValue
    }

}

private struct ApprovalMemoDisplayEntry: Identifiable, Equatable, Sendable {
    let key: String
    let decision: String
    let scopeDescription: String?
    let reason: String?
    var id: String { key }
}

@MainActor @Observable
private final class AgentSettingsStore {
    private(set) var agent: AgentSettingsAgent?
    private(set) var workspace: WorkspaceSummary?
    private(set) var isLoading = false
    private(set) var loadError: String?

    func load(space: Space?) async {
        guard let space else {
            loadError = "当前 Workspace 尚未加载"
            return
        }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            workspace = try await APIClient.shared.get(
                path: Endpoints.Context.workspace(space.id)
            )
        } catch {
            loadError = error.localizedDescription
            return
        }
        guard let agentId = space.executionAgentId ?? space.agentId else {
            agent = nil
            return
        }
        do {
            agent = try await APIClient.shared.get(path: Endpoints.Agent.detail(agentId))
        } catch {
            // Workspace 设置不能因关联 Agent 暂时不可读而整体失效；安全项降级为空。
            agent = nil
            loadError = error.localizedDescription
        }
    }

    @discardableResult
    func update(body: sending [String: Any]) async throws -> AgentSettingsAgent {
        guard let agent else { throw APIError.apiError("Agent 尚未加载") }
        let updated: AgentSettingsAgent = try await APIClient.shared.put(
            path: Endpoints.Agent.detail(agent.id),
            body: body
        )
        self.agent = updated
        return updated
    }

    @discardableResult
    func updateWorkspace(body: sending [String: Any]) async throws -> WorkspaceSummary {
        guard let workspace else { throw APIError.apiError("Workspace 尚未加载") }
        let updated: WorkspaceSummary = try await APIClient.shared.patch(
            path: Endpoints.Context.workspace(workspace.id),
            body: body
        )
        self.workspace = updated
        return updated
    }

    var allowYoloMode: Bool { agent?.allowYoloMode ?? false }

    var executionLimitsSummary: String {
        guard let limits = workspace?.executionLimits else { return "" }
        var parts: [String] = []
        if let iterations = limits.maxIterationsPerRun { parts.append("\(iterations)轮") }
        if let credits = limits.maxCreditsPerRun, !credits.isEmpty { parts.append(credits) }
        return parts.joined(separator: " / ")
    }
}

// MARK: - 自定义规则

private struct SpaceRulesEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var settingsStore: AgentSettingsStore
    @State private var text = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var isFocused: Bool

    private var isDirty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines) != (settingsStore.workspace?.customRules ?? "")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                TextField("写下 Agent 在这个 Workspace 里应始终遵守的工作规则", text: $text, axis: .vertical)
                    .font(.tt.body)
                    .lineLimit(5...20)
                    .focused($isFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .settingsFieldChrome()

                Text("这些规则会随会话上下文一起交给 Agent，适合放长期偏好、交付标准和边界。")
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)

                settingsError(errorMessage)
            }
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle("自定义规则")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") { Task { await save() } }
                    .font(.tt.bodySemibold)
                    .disabled(!isDirty || isSaving)
            }
        }
        .ttLoading(isSaving)
        .onAppear {
            text = settingsStore.workspace?.customRules ?? ""
            isFocused = true
        }
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            _ = try await settingsStore.updateWorkspace(body: [
                "custom_rules": text.trimmingCharacters(in: .whitespacesAndNewlines)
            ])
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 工作类型

private enum WorkType {
    struct Option: Identifiable {
        let value: String
        let title: String
        let desc: String
        var id: String { value }
    }

    static let options = [
        Option(value: "code", title: "代码项目", desc: "默认围绕仓库、终端、代码修改和验证组织工作。"),
        Option(value: "doc", title: "文档项目", desc: "默认围绕文档、资料整理、写作和审阅组织工作。"),
        Option(value: "mixed", title: "混合项目", desc: "适合同时包含代码、文档、表格、浏览器等多种工作面。"),
    ]

    static func displayLabel(_ type: String?) -> String? {
        switch type {
        case "code": return "代码"
        case "doc": return "文档"
        case "mixed": return "混合"
        default: return nil
        }
    }
}

private struct SpaceWorkTypeEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var settingsStore: AgentSettingsStore
    @State private var selectedType = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var workingDir: String { settingsStore.workspace?.workingDir ?? "" }
    private var hasWorkingDir: Bool { !workingDir.isEmpty }
    private var isDirty: Bool {
        hasWorkingDir && !selectedType.isEmpty && selectedType != (settingsStore.workspace?.workingDirType ?? "")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    Text("工作目录")
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textSecondary)
                    if hasWorkingDir {
                        Label(workingDir, systemImage: "folder")
                            .font(.tt.codeSM)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(3)
                            .truncationMode(.middle)
                            .padding(TTSpacing.sm)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
                    } else {
                        Text("这个 Agent 还没有绑定工作目录，因此不能单独设置工作类型。")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }

                if hasWorkingDir {
                    VStack(alignment: .leading, spacing: TTSpacing.sm) {
                        Text("工作类型")
                            .font(.tt.metaSemibold)
                            .foregroundStyle(.tt.textSecondary)
                        ForEach(WorkType.options) { option in
                            Button {
                                selectedType = option.value
                            } label: {
                                settingsChoiceRow(
                                    selected: selectedType == option.value,
                                    title: option.title,
                                    subtitle: option.desc
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                settingsError(errorMessage)
            }
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle("工作类型")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .toolbar {
            if hasWorkingDir {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { Task { await save() } }
                        .font(.tt.bodySemibold)
                        .disabled(!isDirty || isSaving)
                }
            }
        }
        .ttLoading(isSaving)
        .onAppear { selectedType = settingsStore.workspace?.workingDirType ?? "" }
    }

    private func save() async {
        guard hasWorkingDir, !selectedType.isEmpty else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            _ = try await settingsStore.updateWorkspace(body: ["working_dir_type": selectedType])
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 记忆

private struct RecordStyleConfig: Decodable {
    let enabled: Bool
}

private struct MemorySettingsEditor: View {
    let organizationId: String?
    @State private var enabled = true
    @State private var savedEnabled: Bool?
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var isDirty: Bool {
        guard let savedEnabled else { return false }
        return enabled != savedEnabled
    }

    var body: some View {
        Form {
            Section {
                Text("此偏好会同步到当前 Organization 的所有设备。关闭后，对话不会被用于沉淀记忆或生成你的画像。")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
            }

            Section("关于你") {
                Toggle("启用记忆", isOn: $enabled)
                    .tint(.tt.bgAccent)
                    .disabled(isLoading || isSaving)
            }

            if let errorMessage {
                Section { settingsError(errorMessage) }
            }
        }
        .ttFormStyle()
        .navigationTitle("记忆")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") { Task { await save() } }
                    .font(.tt.bodySemibold)
                    .disabled(!isDirty || isLoading || isSaving)
            }
        }
        .ttLoading(isLoading || isSaving)
        .task(id: organizationId) { await load() }
    }

    private func load() async {
        guard let organizationId, !organizationId.isEmpty else {
            isLoading = false
            errorMessage = "当前没有可用的 Organization，暂时无法读取记忆偏好。"
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let config: RecordStyleConfig = try await APIClient.shared.get(
                path: Endpoints.TabMemo.recordStyle,
                query: ["organization_id": organizationId]
            )
            guard !Task.isCancelled else { return }
            enabled = config.enabled
            savedEnabled = config.enabled
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func save() async {
        guard let organizationId, !organizationId.isEmpty, isDirty else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let updated: RecordStyleConfig = try await APIClient.shared.patch(
                path: Endpoints.TabMemo.recordStyle,
                body: ["enabled": enabled],
                query: ["organization_id": organizationId],
            )
            guard !Task.isCancelled else { return }
            enabled = updated.enabled
            savedEnabled = updated.enabled
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 安全

private struct SecuritySettingsEditor: View {
    let spaceId: String
    @Bindable var settingsStore: AgentSettingsStore
    @State private var allowYoloMode = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var revokingKey: String?
    @State private var showClearAllConfirm = false
    @State private var approvalMemo: SettingsApprovalMemoSnapshot?

    /// 组织准入天花板：组织未开放时 YOLO 开关置灰、强制关闭、不下发。
    private var orgAllowsYolo: Bool { WorkspaceStore.shared.allowMemberYolo }
    private var approvalMemoListenerKey: String { "security-approval-memo-\(spaceId)" }

    private var isDirty: Bool {
        settingsStore.agent != nil && orgAllowsYolo && allowYoloMode != settingsStore.allowYoloMode
    }

    var body: some View {
        List {
            Section {
                Toggle(isOn: $allowYoloMode) {
                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                        Text("YOLO 模式")
                            .font(.tt.body)
                            .foregroundStyle(.tt.textPrimary)
                        Text("允许 Agent 在工作区内更少打断地执行动作；高风险红线仍由后端拦截。")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                .tint(.tt.bgAccent)
                .disabled(!orgAllowsYolo)
                if !orgAllowsYolo {
                    Text("组织未开放 YOLO，请联系组织所有者在团队设置中开启「允许成员使用宽松审批」后再启用。")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textWarning)
                }
            }

            Section("工作区") {
                if let root = settingsStore.agent?.workspaceRoot, !root.isEmpty {
                    Label(root, systemImage: "folder")
                        .font(.tt.codeSM)
                        .lineLimit(2)
                        .truncationMode(.middle)
                } else {
                    Text("未配置工作区")
                        .foregroundStyle(.tt.textTertiary)
                }
            }

            Section {
                let entries = approvalMemo?.displayEntries ?? []
                if entries.isEmpty {
                    Text("暂无已记忆的授权决策")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                } else {
                    ForEach(entries) { entry in
                        HStack(spacing: TTSpacing.sm) {
                            Image(systemName: entry.decision == "allow" ? "checkmark.circle" : "xmark.circle")
                                .foregroundStyle(entry.decision == "allow" ? .tt.bgSuccess : .tt.bgCritical)
                            VStack(alignment: .leading, spacing: 2) {
                                Text((entry.scopeDescription ?? "").isEmpty ? entry.key : (entry.scopeDescription ?? entry.key))
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(2)
                                if let reason = entry.reason, !reason.isEmpty {
                                    Text(reason)
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textTertiary)
                                        .lineLimit(2)
                                }
                            }
                            Spacer()
                            if revokingKey == entry.key {
                                ProgressView().controlSize(.mini)
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                Task { await revoke(entry.key) }
                            } label: {
                                Label("撤销", systemImage: "trash")
                            }
                        }
                    }
                }
            } header: {
                HStack {
                    Text("已记忆的授权")
                    Spacer()
                    if !(approvalMemo?.displayEntries ?? []).isEmpty {
                        Button("清空全部") { showClearAllConfirm = true }
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textCritical)
                    }
                }
            }

            if let errorMessage {
                Section { settingsError(errorMessage) }
            }
        }
        .ttListStyle()
        .navigationTitle("安全")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") { Task { await save() } }
                    .font(.tt.bodySemibold)
                    .disabled(!isDirty || isSaving)
            }
        }
        .ttLoading(isSaving)
        .alert("清空所有已记忆的授权？", isPresented: $showClearAllConfirm) {
            Button("清空", role: .destructive) { Task { await clearAllMemo() } }
            Button("取消", role: .cancel) {}
        }
        .onAppear { allowYoloMode = orgAllowsYolo && settingsStore.allowYoloMode }
        .task {
            registerApprovalMemoListener()
            await loadApprovalMemo()
        }
        .onDisappear {
            RealtimeGateway.shared.removeEnvelopeListener(key: approvalMemoListenerKey)
        }
    }

    private func save() async {
        // 组织未开放天花板时不下发（后端也会夹回，客户端先兜一层，避免误导用户已保存）。
        guard orgAllowsYolo else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        let config: [String: Any] = ["security": ["allow_yolo_mode": allowYoloMode]]
        do {
            _ = try await settingsStore.update(body: ["agent_config": config])
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func revoke(_ key: String) async {
        guard let generation = approvalMemo?.generation else { return }
        revokingKey = key
        defer { revokingKey = nil }
        do {
            let snapshot: SettingsApprovalMemoSnapshot = try await APIClient.shared.delete(
                path: Endpoints.Context.approvalMemoEntry(workspaceId: spaceId, key: key),
                headers: ["If-Match": String(generation)]
            )
            approvalMemo = snapshot
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearAllMemo() async {
        do {
            let snapshot: SettingsApprovalMemoSnapshot = try await APIClient.shared.post(
                path: "\(Endpoints.Context.approvalMemo(workspaceId: spaceId))/_revoke_all"
            )
            approvalMemo = snapshot
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadApprovalMemo() async {
        do {
            let snapshot: SettingsApprovalMemoSnapshot = try await APIClient.shared.get(
                path: Endpoints.Context.approvalMemo(workspaceId: spaceId)
            )
            if snapshot.generation >= (approvalMemo?.generation ?? -1) {
                approvalMemo = snapshot
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func registerApprovalMemoListener() {
        RealtimeGateway.shared.addEnvelopeListener(key: approvalMemoListenerKey) { envelope in
            guard envelope.type == AgentStreamEvent.actionApprovalMemoUpdated,
                  envelope.payloadString("workspace_id") == spaceId,
                  let generation = envelope.payload["generation"]?.intValue,
                  generation > (approvalMemo?.generation ?? -1)
            else { return }
            Task { @MainActor in await loadApprovalMemo() }
        }
    }
}

private struct SettingsApprovalMemoSnapshot: Decodable, Sendable {
    let entries: [String: SettingsApprovalMemoEntry]
    let generation: Int

    var displayEntries: [ApprovalMemoDisplayEntry] {
        entries.map { key, entry in
            ApprovalMemoDisplayEntry(
                key: key,
                decision: entry.decision,
                scopeDescription: entry.scopeDescription,
                reason: entry.reason
            )
        }
        .sorted { $0.key < $1.key }
    }
}

private struct SettingsApprovalMemoEntry: Decodable, Sendable {
    let decision: String
    let scopeDescription: String?
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case decision
        case scopeDescription = "scope_description"
        case reason
    }
}

// MARK: - 执行限制

private struct ExecutionLimitsEditor: View {
    @Bindable var settingsStore: AgentSettingsStore
    @State private var maxIterationsText = ""
    @State private var maxCreditsText = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    private enum Field { case iterations, credits }

    private var isDirty: Bool {
        let savedIterations = settingsStore.workspace?.executionLimits?.maxIterationsPerRun
        let savedCredits = settingsStore.workspace?.executionLimits?.maxCreditsPerRun ?? ""
        return normalizedIterations != savedIterations
            || maxCreditsText.trimmingCharacters(in: .whitespacesAndNewlines) != savedCredits
    }

    private var normalizedIterations: Int? {
        let trimmed = maxIterationsText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : Int(trimmed)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                Text("限制单次 Agent 执行的最大轮数与额度。留空表示使用后端默认值。")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)

                settingsField(title: "最大执行轮数", hint: "例如 20。过小会让复杂任务提前停止。") {
                    TextField("使用默认", text: $maxIterationsText)
                        .keyboardType(.numberPad)
                        .focused($focusedField, equals: .iterations)
                        .settingsFieldChrome()
                }

                settingsField(title: "最大额度", hint: "可以填写十进制数；留空则不覆盖默认额度。") {
                    TextField("使用默认", text: $maxCreditsText)
                        .keyboardType(.decimalPad)
                        .focused($focusedField, equals: .credits)
                        .settingsFieldChrome()
                }

                settingsError(errorMessage)
            }
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle("执行限制")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") { Task { await save() } }
                    .font(.tt.bodySemibold)
                    .disabled(!isDirty || isSaving)
            }
        }
        .ttLoading(isSaving)
        .onAppear { load() }
    }

    private func load() {
        if let iterations = settingsStore.workspace?.executionLimits?.maxIterationsPerRun {
            maxIterationsText = String(iterations)
        }
        maxCreditsText = settingsStore.workspace?.executionLimits?.maxCreditsPerRun ?? ""
    }

    private func save() async {
        let iterationText = maxIterationsText.trimmingCharacters(in: .whitespacesAndNewlines)
        let creditText = maxCreditsText.trimmingCharacters(in: .whitespacesAndNewlines)
        let iterations = iterationText.isEmpty ? nil : Int(iterationText)

        if !iterationText.isEmpty && (iterations == nil || (iterations ?? 0) < 1) {
            errorMessage = "最大执行轮数需要是大于 0 的整数"
            return
        }
        if !creditText.isEmpty && (Double(creditText) == nil || (Double(creditText) ?? 0) <= 0) {
            errorMessage = "最大额度需要是大于 0 的数字"
            return
        }

        var limits: [String: Any] = [:]
        limits["max_iterations_per_run"] = iterations ?? NSNull()
        limits["max_credits_per_run"] = creditText.isEmpty ? NSNull() : creditText

        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            _ = try await settingsStore.updateWorkspace(body: ["execution_limits": limits])
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 技能

private struct SkillConfig: Codable, Equatable, Sendable {
    var enabled: Bool?
    var apiKey: String?
    ///  后 Electron 已迁到凭据库；后端 config 可能只回 `credential_id`。
    var credentialId: String?
    var env: [String: String]?

    init(
        enabled: Bool? = nil,
        apiKey: String? = nil,
        credentialId: String? = nil,
        env: [String: String]? = nil
    ) {
        self.enabled = enabled
        self.apiKey = apiKey
        self.credentialId = credentialId
        self.env = env
    }

    enum CodingKeys: String, CodingKey {
        case enabled
        case apiKey = "api_key"
        case credentialId = "credential_id"
        case env
    }

    var hasConfiguredSecret: Bool {
        if let apiKey, !apiKey.isEmpty { return true }
        if let credentialId, !credentialId.isEmpty { return true }
        return false
    }
}

private struct SkillConfigsResponse: Decodable, Sendable {
    let configs: [String: SkillConfig]
}

private struct SkillRequirements: Codable, Equatable, Sendable {
    let bins: [String]?
    let anyBins: [String]?
    let env: [String]?
    let config: [String]?

    enum CodingKeys: String, CodingKey {
        case bins
        case anyBins = "any_bins"
        case env, config
    }
}

private struct SkillInstallSpec: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let formula: String?
    let package: String?
    let module: String?
    let url: String?
    let bins: [String]?
    let label: String?
    let os: [String]?
}

private enum SkillReadiness: String, CaseIterable, Sendable {
    case ready
    case needsConfig
    case needsInstall
    case executionEnvironmentUnknown

    var label: String {
        switch self {
        case .ready: "就绪"
        case .needsConfig: "需配置"
        case .needsInstall: "需安装"
        case .executionEnvironmentUnknown: "执行环境待确认"
        }
    }

    var sortOrder: Int {
        switch self {
        case .ready: 0
        case .needsConfig: 1
        case .needsInstall: 2
        case .executionEnvironmentUnknown: 3
        }
    }
}

private struct SpaceSkill: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let description: String?
    var isEnabled: Bool?
    let category: String?
    let version: String?
    let skillKey: String?
    let source: String?
    let emoji: String?
    let primaryEnv: String?
    let osFilter: [String]?
    let always: Bool?
    let requires: SkillRequirements?
    let install: [SkillInstallSpec]?
    let homepage: String?
    let appId: String?
    let tags: [String]?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, category, version, source, emoji, homepage
        case tags, status, requires, install, always
        case skillId = "skill_id"
        case isEnabled = "is_enabled"
        case skillKey = "skill_key"
        case primaryEnv = "primary_env"
        case osFilter = "os_filter"
        case appId = "app_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let decodedId = try? c.decode(String.self, forKey: .id) {
            id = decodedId
        } else {
            id = try c.decode(String.self, forKey: .skillId)
        }
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        description = try c.decodeIfPresent(String.self, forKey: .description)
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .isEnabled)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        skillKey = try c.decodeIfPresent(String.self, forKey: .skillKey)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        primaryEnv = try c.decodeIfPresent(String.self, forKey: .primaryEnv)
        osFilter = try c.decodeIfPresent([String].self, forKey: .osFilter)
        always = try c.decodeIfPresent(Bool.self, forKey: .always)
        requires = try c.decodeIfPresent(SkillRequirements.self, forKey: .requires)
        install = try c.decodeIfPresent([SkillInstallSpec].self, forKey: .install)
        homepage = try c.decodeIfPresent(String.self, forKey: .homepage)
        appId = try c.decodeIfPresent(String.self, forKey: .appId)
        tags = try c.decodeIfPresent([String].self, forKey: .tags)
        status = try c.decodeIfPresent(String.self, forKey: .status)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(isEnabled, forKey: .isEnabled)
        try c.encodeIfPresent(category, forKey: .category)
        try c.encodeIfPresent(version, forKey: .version)
        try c.encodeIfPresent(skillKey, forKey: .skillKey)
        try c.encodeIfPresent(source, forKey: .source)
        try c.encodeIfPresent(emoji, forKey: .emoji)
        try c.encodeIfPresent(primaryEnv, forKey: .primaryEnv)
        try c.encodeIfPresent(osFilter, forKey: .osFilter)
        try c.encodeIfPresent(always, forKey: .always)
        try c.encodeIfPresent(requires, forKey: .requires)
        try c.encodeIfPresent(install, forKey: .install)
        try c.encodeIfPresent(homepage, forKey: .homepage)
        try c.encodeIfPresent(appId, forKey: .appId)
        try c.encodeIfPresent(tags, forKey: .tags)
        try c.encodeIfPresent(status, forKey: .status)
    }

    var sourceLabel: String {
        switch source {
        case "marketplace", "market": "市场"
        case "managed": "已安装"
        case "local_agent": "本地"
        case "system": "系统"
        case "app": "内置"
        default: source ?? ""
        }
    }

    func isEnabledInSpace(_ configs: [String: SkillConfig]) -> Bool {
        if let skillKey, let enabled = configs[skillKey]?.enabled { return enabled }
        if let isEnabled { return isEnabled }
        if let status { return status == "enabled" }
        return true
    }

    func computeReadiness(_ config: SkillConfig?) -> SkillReadiness {
        let requiredEnv = requires?.env ?? []
        if !requiredEnv.isEmpty {
            let envObj = config?.env ?? [:]
            let hasSecret = config?.hasConfiguredSecret == true
            for key in requiredEnv {
                if key == primaryEnv {
                    if !hasSecret && envObj[key] == nil { return .needsConfig }
                } else {
                    if envObj[key] == nil { return .needsConfig }
                }
            }
        }

        // iOS 是远程控制端，Skill 实际运行在 Workspace 绑定的执行设备上。
        // 在服务端尚未返回该设备的平台与依赖探测结果前，不能拿手机 OS 推断兼容性。
        if let osFilter, !osFilter.isEmpty {
            return .executionEnvironmentUnknown
        }

        let requiredBins = requires?.bins ?? []
        if !requiredBins.isEmpty, let specs = install, !specs.isEmpty {
            let common: Set<String> = ["curl", "bash", "sh", "python3", "node"]
            if requiredBins.contains(where: { !common.contains($0) }) {
                return .needsInstall
            }
        }

        return .ready
    }
}

/// Skill 列表 + 配置的短时缓存（ 后按 organization + agent 锚定）。
/// `actor` 自身已满足 Sendable，勿手动加 `: Sendable`。
private actor SkillsCache {
    static let shared = SkillsCache()

    struct CacheEntry: Sendable {
        let skills: [SpaceSkill]
        let configs: [String: SkillConfig]
        let fetchedAt: Date
    }

    private var entries: [String: CacheEntry] = [:]
    private let ttl: TimeInterval = 60

    private func cacheKey(organizationId: String, agentId: String) -> String {
        "org:\(organizationId)|agent:\(agentId)"
    }

    func get(organizationId: String, agentId: String) -> CacheEntry? {
        let key = cacheKey(organizationId: organizationId, agentId: agentId)
        guard let entry = entries[key],
              Date().timeIntervalSince(entry.fetchedAt) < ttl else {
            entries.removeValue(forKey: key)
            return nil
        }
        return entry
    }

    func set(
        organizationId: String,
        agentId: String,
        skills: [SpaceSkill],
        configs: [String: SkillConfig]
    ) {
        let key = cacheKey(organizationId: organizationId, agentId: agentId)
        entries[key] = CacheEntry(skills: skills, configs: configs, fetchedAt: Date())
    }

    func invalidate(organizationId: String, agentId: String) {
        entries.removeValue(forKey: cacheKey(organizationId: organizationId, agentId: agentId))
    }
}

private struct SkillListResponse: Decodable, Sendable {
    let skills: [SpaceSkill]
    let total: Int?
}

private struct SettingsPatchResponse: Decodable, Sendable {}

@MainActor @Observable
private final class SkillsSettingsStore {
    private(set) var skills: [SpaceSkill] = []
    private(set) var configs: [String: SkillConfig] = [:]
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var resolvedOrganizationId: String?
    private(set) var resolvedAgentId: String?
    var actionError: String?
    var togglingIds: Set<String> = []

    func load(
        organizationId: String?,
        preferredAgentId: String?,
        forceRefresh: Bool = false
    ) async {
        guard let organizationId, !organizationId.isEmpty else {
            loadError = "缺少 Organization，无法加载 Skill"
            return
        }

        isLoading = skills.isEmpty
        loadError = nil
        defer { isLoading = false }

        do {
            let agentId = try await resolveAgentId(
                organizationId: organizationId,
                preferredAgentId: preferredAgentId
            )
            resolvedOrganizationId = organizationId
            resolvedAgentId = agentId

            if !forceRefresh,
               let cached = await SkillsCache.shared.get(
                organizationId: organizationId,
                agentId: agentId
               ) {
                skills = cached.skills
                configs = cached.configs
                return
            }

            // UI 面板优先 /skills/visible（含未启用）；失败再退 /skills/index。
            let query = ["organization_id": organizationId, "agent_id": agentId]
            let response: SkillListResponse
            do {
                response = try await APIClient.shared.get(
                    path: Endpoints.Skills.visible,
                    query: query
                )
            } catch {
                guard !error.isCancellation else { return }
                response = try await APIClient.shared.get(
                    path: Endpoints.Skills.index,
                    query: query
                )
            }
            skills = response.skills
            do {
                let configResponse: SkillConfigsResponse = try await APIClient.shared.get(
                    path: Endpoints.Skills.config,
                    query: query
                )
                configs = configResponse.configs
            } catch {
                guard !error.isCancellation else { return }
                configs = [:]
            }
            await SkillsCache.shared.set(
                organizationId: organizationId,
                agentId: agentId,
                skills: skills,
                configs: configs
            )
        } catch {
            guard !error.isCancellation else { return }
            loadError = error.localizedDescription
        }
    }

    func toggle(skill: SpaceSkill, enabled: Bool) async {
        guard let organizationId = resolvedOrganizationId,
              let agentId = resolvedAgentId else {
            actionError = "Skill 作用域尚未就绪"
            return
        }
        guard let skillKey = skill.skillKey, !skillKey.isEmpty else {
            actionError = "该 Skill 缺少 skill_key，无法切换"
            return
        }
        togglingIds.insert(skill.id)
        actionError = nil
        defer { togglingIds.remove(skill.id) }
        do {
            let _: SettingsPatchResponse = try await APIClient.shared.patch(
                path: Endpoints.Skills.config(skillKey),
                body: [
                    "organization_id": organizationId,
                    "agent_id": agentId,
                    "enabled": enabled,
                ]
            )
            var config = configs[skillKey] ?? SkillConfig()
            config.enabled = enabled
            configs[skillKey] = config
            await SkillsCache.shared.invalidate(organizationId: organizationId, agentId: agentId)
        } catch {
            actionError = error.localizedDescription
        }
    }

    @discardableResult
    func saveConfig(skill: SpaceSkill, apiKey: String) async -> Bool {
        guard let organizationId = resolvedOrganizationId,
              let agentId = resolvedAgentId else {
            actionError = "Skill 作用域尚未就绪"
            return false
        }
        guard let skillKey = skill.skillKey else { return false }
        actionError = nil
        do {
            // Electron 已迁 credential_id；iOS 暂无凭据库 UI，先把密钥写入 env[primaryEnv]。
            var body: [String: Any] = [
                "organization_id": organizationId,
                "agent_id": agentId,
            ]
            if let primaryEnv = skill.primaryEnv, !primaryEnv.isEmpty {
                body["env"] = [primaryEnv: apiKey]
            } else {
                body["env"] = ["API_KEY": apiKey]
            }
            let _: SettingsPatchResponse = try await APIClient.shared.patch(
                path: Endpoints.Skills.config(skillKey),
                body: body
            )
            var config = configs[skillKey] ?? SkillConfig()
            config.apiKey = apiKey
            if var env = config.env {
                if let primaryEnv = skill.primaryEnv, !primaryEnv.isEmpty {
                    env[primaryEnv] = apiKey
                } else {
                    env["API_KEY"] = apiKey
                }
                config.env = env
            } else if let primaryEnv = skill.primaryEnv, !primaryEnv.isEmpty {
                config.env = [primaryEnv: apiKey]
            } else {
                config.env = ["API_KEY": apiKey]
            }
            configs[skillKey] = config
            await SkillsCache.shared.invalidate(organizationId: organizationId, agentId: agentId)
            return true
        } catch {
            if error.isCancellation { return false }
            actionError = error.localizedDescription
            return false
        }
    }

    /// Workspace 已不再挂 agent_id；优先用调用方传入，否则取组织默认/首个活跃 Agent。
    private func resolveAgentId(organizationId: String, preferredAgentId: String?) async throws -> String {
        if let preferredAgentId {
            let trimmed = preferredAgentId.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        let response: OrganizationAgentListResponse = try await APIClient.shared.get(
            path: Endpoints.Agent.list,
            query: ["organization_id": organizationId]
        )
        if let defaultAgent = response.agents.first(where: {
            $0.isActive != false && $0.isDefault == true
        }) {
            return defaultAgent.id
        }
        if let firstActive = response.agents.first(where: { $0.isActive != false }) {
            return firstActive.id
        }
        throw APIError.apiError("当前组织没有可用 Agent，无法管理 Skill")
    }
}

struct SkillsManagementEditor: View {
    let spaceId: String
    let organizationId: String?
    let preferredAgentId: String?
    @State private var store = SkillsSettingsStore()
    @State private var configuringSkill: SpaceSkill?
    @State private var apiKeyDraft = ""
    @State private var isSavingConfig = false

    init(
        spaceId: String,
        organizationId: String? = nil,
        preferredAgentId: String? = nil
    ) {
        self.spaceId = spaceId
        self.organizationId = organizationId
        self.preferredAgentId = preferredAgentId
    }

    private func readiness(for skill: SpaceSkill) -> SkillReadiness {
        skill.computeReadiness(store.configs[skill.skillKey ?? ""])
    }

    private var sortedSkills: [SpaceSkill] {
        store.skills.sorted { lhs, rhs in
            let lo = readiness(for: lhs).sortOrder
            let ro = readiness(for: rhs).sortOrder
            if lo != ro { return lo < ro }
            return lhs.name.localizedCompare(rhs.name) == .orderedAscending
        }
    }

    private var readinessCounts: [SkillReadiness: Int] {
        store.skills.reduce(into: [:]) { counts, skill in
            counts[readiness(for: skill), default: 0] += 1
        }
    }

    private func reload(forceRefresh: Bool = false) async {
        await store.load(
            organizationId: organizationId,
            preferredAgentId: preferredAgentId,
            forceRefresh: forceRefresh
        )
    }

    var body: some View {
        Group {
            if store.isLoading && store.skills.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let loadError = store.loadError, store.skills.isEmpty {
                settingsRetryState(message: loadError) { Task { await reload() } }
            } else if store.skills.isEmpty {
                ContentUnavailableView("没有可用 Skill", systemImage: "sparkles")
            } else {
                List {
                    if let error = store.actionError {
                        Section { settingsError(error) }
                    }
                    Section {
                        SkillReadinessSummary(counts: readinessCounts)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                    ForEach(sortedSkills) { skill in
                        SkillRow(
                            skill: skill,
                            readiness: readiness(for: skill),
                            enabled: skill.isEnabledInSpace(store.configs),
                            isToggling: store.togglingIds.contains(skill.id),
                            onConfigure: {
                                let cfg = store.configs[skill.skillKey ?? ""]
                                apiKeyDraft = cfg?.apiKey
                                    ?? cfg?.env?[skill.primaryEnv ?? ""]
                                    ?? ""
                                configuringSkill = skill
                            },
                            onToggle: { enabled in
                                Task { await store.toggle(skill: skill, enabled: enabled) }
                            }
                        )
                    }
                }
                .ttListStyle()
                .refreshable { await reload(forceRefresh: true) }
            }
        }
        .navigationTitle("Skill")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .task(id: "\(spaceId)|\(organizationId ?? "")|\(preferredAgentId ?? "")") {
            await reload()
        }
        .sheet(item: $configuringSkill) { skill in
            SkillConfigSheet(
                skill: skill,
                apiKey: $apiKeyDraft,
                onSave: {
                    guard !isSavingConfig else { return }
                    isSavingConfig = true
                    Task {
                        let saved = await store.saveConfig(skill: skill, apiKey: apiKeyDraft)
                        isSavingConfig = false
                        if saved { configuringSkill = nil }
                    }
                },
                onCancel: { configuringSkill = nil }
            )
        }
    }
}

private struct SkillReadinessSummary: View {
    let counts: [SkillReadiness: Int]

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.xs) {
            ForEach(SkillReadiness.allCases, id: \.self) { readiness in
                VStack(spacing: TTSpacing.xxs) {
                    Circle()
                        .fill(skillReadinessColor(readiness))
                        .frame(width: 8, height: 8)
                    Text("\(counts[readiness] ?? 0)")
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Text(readiness.label)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, TTSpacing.md)
        .padding(.horizontal, TTSpacing.lg)
    }
}

private struct SkillRow: View {
    let skill: SpaceSkill
    let readiness: SkillReadiness
    let enabled: Bool
    let isToggling: Bool
    let onConfigure: () -> Void
    let onToggle: (Bool) -> Void

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            Text(skill.emoji ?? "✦")
                .font(.tt.subtitle)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: TTSpacing.xs) {
                    Text(skill.name)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textPrimary)
                    if let version = skill.version, !version.isEmpty {
                        Text("v\(version)")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                    Circle()
                        .fill(skillReadinessColor(readiness))
                        .frame(width: 6, height: 6)
                }
                if let description = skill.description, !description.isEmpty {
                    Text(description)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(2)
                }
                HStack(spacing: TTSpacing.xs) {
                    if let source = skill.source, !source.isEmpty {
                        Text(skill.sourceLabel)
                    }
                    if let category = skill.category, !category.isEmpty {
                        Text(category)
                    }
                    if readiness == .ready, skill.primaryEnv != nil {
                        Button(action: onConfigure) {
                            Label("配置", systemImage: "gearshape")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.bgAccent)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
            }
            Spacer()
            trailingControl
        }
        .padding(.vertical, TTSpacing.xs)
    }

    @ViewBuilder
    private var trailingControl: some View {
        if isToggling {
            ProgressView().controlSize(.mini)
        } else if readiness == .ready {
            Toggle("", isOn: Binding(
                get: { enabled },
                set: { onToggle($0) }
            ))
            .labelsHidden()
            .tint(.tt.bgAccent)
        } else {
            VStack(alignment: .trailing, spacing: TTSpacing.xxs) {
                switch readiness {
                case .needsConfig:
                    Button("配置", action: onConfigure)
                        .font(.tt.caption)
                        .buttonStyle(.bordered)
                case .needsInstall:
                    Text("请在执行设备安装")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .multilineTextAlignment(.trailing)
                case .executionEnvironmentUnknown:
                    Text("待执行设备确认")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .multilineTextAlignment(.trailing)
                case .ready:
                    EmptyView()
                }

                // 非就绪状态不能直接启用，但已启用的 Skill 仍必须允许安全停用。
                if enabled {
                    Button("停用") { onToggle(false) }
                        .font(.tt.caption)
                        .buttonStyle(.plain)
                        .foregroundStyle(.tt.textCritical)
                }
            }
            .frame(minWidth: 88, alignment: .trailing)
        }
    }
}

private func skillReadinessColor(_ readiness: SkillReadiness) -> Color {
    switch readiness {
    case .ready: .tt.bgSuccess
    case .needsConfig: .tt.bgWarning
    case .needsInstall: Color(hex: 0x2196F3)
    case .executionEnvironmentUnknown: .tt.textTertiary
    }
}

private struct SkillConfigSheet: View {
    let skill: SpaceSkill
    @Binding var apiKey: String
    let onSave: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: TTSpacing.md) {
                        if let emoji = skill.emoji, !emoji.isEmpty {
                            Text(emoji).font(.tt.iconEmptyMD)
                        }
                        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                            Text(skill.name).font(.tt.bodySemibold)
                            if let version = skill.version, !version.isEmpty {
                                Text("v\(version)")
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                        }
                    }
                    if let desc = skill.description, !desc.isEmpty {
                        Text(desc)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }

                if let primaryEnv = skill.primaryEnv {
                    Section {
                        SecureField(primaryEnv, text: $apiKey)
                            .textContentType(.password)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    } header: {
                        Text("API Key")
                    } footer: {
                        Text("此密钥仅用于该 Workspace 的 \(primaryEnv)，加密存储于服务端")
                    }
                }

                if let reqs = skill.requires {
                    Section(header: Text("依赖")) {
                        if let bins = reqs.bins, !bins.isEmpty {
                            LabeledContent("需要命令") {
                                Text(bins.joined(separator: ", "))
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textSecondary)
                            }
                        }
                        if let env = reqs.env, !env.isEmpty {
                            LabeledContent("环境变量") {
                                Text(env.joined(separator: ", "))
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textSecondary)
                            }
                        }
                    }
                }

                if let specs = skill.install, !specs.isEmpty {
                    Section {
                        ForEach(specs) { spec in
                            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                Text(installCommand(for: spec))
                                    .font(.tt.codeSM)
                                    .foregroundStyle(.tt.textPrimary)
                                    .textSelection(.enabled)
                                if let lbl = spec.label {
                                    Text(lbl)
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textTertiary)
                                }
                            }
                        }
                    } header: {
                        Text("安装指南")
                    } footer: {
                        Text("需要在桌面端（Electron/Daemon）执行安装，移动端不运行 Skill")
                    }
                }

                Section(header: Text("来源")) {
                    LabeledContent("类型") {
                        Text(skill.sourceLabel)
                    }
                    if let homepage = skill.homepage, let url = URL(string: homepage) {
                        Link("主页", destination: url)
                    }
                }
            }
            .navigationTitle("Skill 配置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", action: onCancel)
                }
                if skill.primaryEnv != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存", action: onSave)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func installCommand(for spec: SkillInstallSpec) -> String {
        switch spec.kind {
        case "brew": "brew install \(spec.formula ?? spec.id)"
        case "pip": "pip install \(spec.package ?? spec.id)"
        case "node": "npm install -g \(spec.package ?? spec.id)"
        case "go": "go install \(spec.module ?? spec.id)"
        default: spec.label ?? spec.id
        }
    }
}

// MARK: - 子 Agent

private struct SubAgentTemplate: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let spaceId: String
    var name: String
    var description: String
    var icon: String
    var systemPrompt: String
    var subagentType: String
    var thinkingLevel: String?
    var defaultMode: String
    var appId: String?
    var isEnabled: Bool
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, icon
        case spaceId = "space_id"
        case systemPrompt = "system_prompt"
        case subagentType = "subagent_type"
        case thinkingLevel = "thinking_level"
        case defaultMode = "default_mode"
        case appId = "app_id"
        case isEnabled = "is_enabled"
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? ""
        systemPrompt = try c.decodeIfPresent(String.self, forKey: .systemPrompt) ?? ""
        subagentType = try c.decodeIfPresent(String.self, forKey: .subagentType) ?? "execute"
        thinkingLevel = try c.decodeIfPresent(String.self, forKey: .thinkingLevel)
        defaultMode = try c.decodeIfPresent(String.self, forKey: .defaultMode) ?? "wait"
        appId = try c.decodeIfPresent(String.self, forKey: .appId)
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? true
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

private struct SubAgentTemplateListResponse: Decodable, Sendable {
    let items: [SubAgentTemplate]
}

@MainActor @Observable
private final class SubAgentSettingsStore {
    private(set) var templates: [SubAgentTemplate] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    var actionError: String?

    func load(spaceId: String) async {
        isLoading = templates.isEmpty
        loadError = nil
        defer { isLoading = false }
        do {
            let response: SubAgentTemplateListResponse = try await APIClient.shared.get(
                path: Endpoints.Orchestration.subagentTemplates(spaceId: spaceId)
            )
            templates = response.items
        } catch {
            guard !error.isCancellation else { return }
            loadError = error.localizedDescription
        }
    }

    func create(spaceId: String, body: sending [String: Any]) async throws {
        let created: SubAgentTemplate = try await APIClient.shared.post(
            path: Endpoints.Orchestration.subagentTemplates(spaceId: spaceId),
            body: body
        )
        templates.insert(created, at: 0)
    }

    func update(spaceId: String, templateId: String, body: sending [String: Any]) async throws {
        let updated: SubAgentTemplate = try await APIClient.shared.put(
            path: Endpoints.Orchestration.subagentTemplate(spaceId: spaceId, templateId: templateId),
            body: body
        )
        if let idx = templates.firstIndex(where: { $0.id == templateId }) {
            templates[idx] = updated
        }
    }

    func delete(spaceId: String, templateId: String) async throws {
        let _: ApiEnvelope<String?> = try await APIClient.shared.delete(
            path: Endpoints.Orchestration.subagentTemplate(spaceId: spaceId, templateId: templateId)
        )
        templates.removeAll { $0.id == templateId }
    }
}

private struct SubAgentListEditor: View {
    let spaceId: String
    @State private var store = SubAgentSettingsStore()
    @State private var editorTemplate: SubAgentTemplate?
    @State private var showCreate = false
    @State private var deleteTarget: SubAgentTemplate?

    var body: some View {
        Group {
            if store.isLoading && store.templates.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let loadError = store.loadError, store.templates.isEmpty {
                settingsRetryState(message: loadError) { Task { await store.load(spaceId: spaceId) } }
            } else if store.templates.isEmpty {
                ContentUnavailableView {
                    Label("还没有子 Agent", systemImage: "cpu")
                } description: {
                    Text("可以创建用于探索、计划或执行的专用子 Agent。")
                } actions: {
                    Button { showCreate = true } label: {
                        Label("新建子 Agent", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.tt.bgAccent)
                }
            } else {
                List {
                    if let error = store.actionError {
                        Section { settingsError(error) }
                    }
                    ForEach(store.templates) { template in
                        Button { editorTemplate = template } label: {
                            SubAgentTemplateRow(template: template)
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button(role: .destructive) {
                                deleteTarget = template
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        }
                    }
                }
                .ttListStyle()
                .refreshable { await store.load(spaceId: spaceId) }
            }
        }
        .navigationTitle("子 Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showCreate = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("新建子 Agent")
            }
        }
        .ttToolbarBackground()
        .task { await store.load(spaceId: spaceId) }
        .sheet(isPresented: $showCreate) {
            NavigationStack {
                SubAgentTemplateEditor(spaceId: spaceId, store: store, template: nil)
            }
        }
        .sheet(item: $editorTemplate) { template in
            NavigationStack {
                SubAgentTemplateEditor(spaceId: spaceId, store: store, template: template)
            }
        }
        .alert("删除这个子 Agent？", isPresented: Binding(
            get: { deleteTarget != nil },
            set: { if !$0 { deleteTarget = nil } }
        )) {
            Button("删除", role: .destructive) {
                guard let target = deleteTarget else { return }
                Task {
                    do {
                        try await store.delete(spaceId: spaceId, templateId: target.id)
                    } catch {
                        store.actionError = error.localizedDescription
                    }
                    deleteTarget = nil
                }
            }
            Button("取消", role: .cancel) { deleteTarget = nil }
        }
    }
}

private struct SubAgentTemplateRow: View {
    let template: SubAgentTemplate

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            Image(systemName: template.isEnabled ? "cpu.fill" : "cpu")
                .foregroundStyle(template.isEnabled ? .tt.iconAccent : .tt.textTertiary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(template.name.isEmpty ? "未命名子 Agent" : template.name)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                Text(typeLabel(template.subagentType) + " · " + modeLabel(template.defaultMode))
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                if !template.description.isEmpty {
                    Text(template.description)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(2)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textTertiary)
        }
        .padding(.vertical, TTSpacing.xs)
    }

    private func typeLabel(_ type: String) -> String {
        switch type {
        case "explore": return "探索"
        case "plan": return "计划"
        case "execute": return "执行"
        default: return type
        }
    }

    private func modeLabel(_ mode: String) -> String {
        mode == "background" ? "后台" : "等待"
    }
}

private struct SubAgentTemplateEditor: View {
    @Environment(\.dismiss) private var dismiss
    let spaceId: String
    @Bindable var store: SubAgentSettingsStore
    let template: SubAgentTemplate?

    @State private var name = ""
    @State private var description = ""
    @State private var systemPrompt = ""
    @State private var subagentType = "execute"
    @State private var defaultMode = "wait"
    @State private var thinkingLevel = ""
    @State private var isEnabled = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var isNew: Bool { template == nil }

    var body: some View {
        Form {
            Section("基础信息") {
                TextField("名称", text: $name)
                TextField("描述", text: $description, axis: .vertical)
                    .lineLimit(2...4)
                Toggle("启用", isOn: $isEnabled)
                    .tint(.tt.bgAccent)
            }
            Section("任务角色") {
                Picker("类型", selection: $subagentType) {
                    Text("探索").tag("explore")
                    Text("计划").tag("plan")
                    Text("执行").tag("execute")
                }
                Picker("模式", selection: $defaultMode) {
                    Text("等待完成").tag("wait")
                    Text("后台运行").tag("background")
                }
                Picker("思考强度", selection: $thinkingLevel) {
                    Text("默认").tag("")
                    Text("低").tag("low")
                    Text("中").tag("medium")
                    Text("高").tag("high")
                }
            }
            Section("系统提示词") {
                TextField("描述这个子 Agent 的职责、边界和产出格式", text: $systemPrompt, axis: .vertical)
                    .lineLimit(5...16)
            }
            if let errorMessage {
                Section { settingsError(errorMessage) }
            }
        }
        .ttFormStyle()
        .navigationTitle(isNew ? "新建子 Agent" : "编辑子 Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { dismiss() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") { Task { await save() } }
                    .font(.tt.bodySemibold)
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
            }
        }
        .ttLoading(isSaving)
        .onAppear { load() }
    }

    private func load() {
        guard let template else { return }
        name = template.name
        description = template.description
        systemPrompt = template.systemPrompt
        subagentType = template.subagentType
        defaultMode = template.defaultMode
        thinkingLevel = template.thinkingLevel ?? ""
        isEnabled = template.isEnabled
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        let body: [String: Any] = [
            "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
            "description": description.trimmingCharacters(in: .whitespacesAndNewlines),
            "system_prompt": systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines),
            "subagent_type": subagentType,
            "default_mode": defaultMode,
            "thinking_level": thinkingLevel,
            "is_enabled": isEnabled,
        ]
        do {
            if let template {
                try await store.update(spaceId: spaceId, templateId: template.id, body: body)
            } else {
                try await store.create(spaceId: spaceId, body: body)
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 归档会话

@MainActor @Observable
private final class ArchivedSessionsSettingsStore {
    private(set) var sessions: [ChatSession] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    var actionError: String?
    var restoringIds: Set<String> = []

    func load(spaceId: String) async {
        isLoading = sessions.isEmpty
        loadError = nil
        defer { isLoading = false }
        do {
            let response: ChatSessionListResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.sessions,
                query: ["space_id": spaceId, "status": "archived", "limit": "50"]
            )
            sessions = response.sessions.sorted {
                ($0.lastMessageAt ?? $0.updatedAt ?? "") > ($1.lastMessageAt ?? $1.updatedAt ?? "")
            }
        } catch {
            guard !error.isCancellation else { return }
            loadError = error.localizedDescription
        }
    }

    func restore(_ session: ChatSession) async {
        restoringIds.insert(session.id)
        actionError = nil
        defer { restoringIds.remove(session.id) }
        do {
            let _: ChatSession = try await APIClient.shared.put(
                path: Endpoints.Chat.session(session.id),
                body: ["status": "active"]
            )
            sessions.removeAll { $0.id == session.id }
        } catch {
            actionError = error.localizedDescription
        }
    }

    func delete(_ session: ChatSession) async {
        actionError = nil
        do {
            let _: ApiEnvelope<String?> = try await APIClient.shared.delete(path: Endpoints.Chat.session(session.id))
            sessions.removeAll { $0.id == session.id }
        } catch {
            actionError = error.localizedDescription
        }
    }
}

private struct ArchivedSessionsEditor: View {
    let spaceId: String
    @State private var store = ArchivedSessionsSettingsStore()
    @State private var deleteTarget: ChatSession?

    var body: some View {
        Group {
            if store.isLoading && store.sessions.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let loadError = store.loadError, store.sessions.isEmpty {
                settingsRetryState(message: loadError) { Task { await store.load(spaceId: spaceId) } }
            } else if store.sessions.isEmpty {
                ContentUnavailableView {
                    Label("没有归档会话", systemImage: "archivebox")
                } description: {
                    Text("归档后的会话会出现在这里，可恢复回会话列表。")
                }
            } else {
                List {
                    Section {
                        Text("归档后的会话不会出现在普通会话列表中，但历史内容仍会保留。")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                    if let error = store.actionError {
                        Section { settingsError(error) }
                    }
                    ForEach(store.sessions) { session in
                        HStack(spacing: TTSpacing.md) {
                            Image(systemName: "bubble.left")
                                .foregroundStyle(.tt.textTertiary)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text((session.title ?? "").isEmpty ? "未命名会话" : (session.title ?? "未命名会话"))
                                    .font(.tt.body)
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(1)
                                if let time = session.lastMessageAt ?? session.updatedAt {
                                    Text(RelativeTime.format(time) ?? "")
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textTertiary)
                                }
                            }
                            Spacer()
                            if store.restoringIds.contains(session.id) {
                                ProgressView().controlSize(.mini)
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button {
                                Task { await store.restore(session) }
                            } label: {
                                Label("恢复", systemImage: "arrow.uturn.backward")
                            }
                            .tint(.tt.bgAccent)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                deleteTarget = session
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        }
                    }
                }
                .ttListStyle()
                .refreshable { await store.load(spaceId: spaceId) }
            }
        }
        .navigationTitle("归档会话")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .task { await store.load(spaceId: spaceId) }
        .alert("删除这个归档会话？", isPresented: Binding(
            get: { deleteTarget != nil },
            set: { if !$0 { deleteTarget = nil } }
        )) {
            Button("删除", role: .destructive) {
                guard let target = deleteTarget else { return }
                Task {
                    await store.delete(target)
                    deleteTarget = nil
                }
            }
            Button("取消", role: .cancel) { deleteTarget = nil }
        }
    }
}

// MARK: - 回收站

private struct TrashedItem: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let itemType: String
    let title: String
    let preview: String?
    let resourceId: String?
    let spaceId: String?
    let updatedAt: String?
    let trashedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, preview
        case itemType = "item_type"
        case resourceId = "resource_id"
        case spaceId = "space_id"
        case updatedAt = "updated_at"
        case trashedAt = "trashed_at"
    }

    var displayTime: String? {
        guard let trashedAt else { return nil }
        return RelativeTime.format(trashedAt)
    }

    var daysLeft: Int {
        guard let trashedAt else { return 30 }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallback = ISO8601DateFormatter()
        fallback.formatOptions = [.withInternetDateTime]
        let date = formatter.date(from: trashedAt) ?? fallback.date(from: trashedAt)
        guard let date else { return 30 }
        let daysPassed = Calendar.current.dateComponents([.day], from: date, to: Date()).day ?? 0
        return max(0, 30 - daysPassed)
    }
}

private enum TrashScope: Equatable, Sendable {
    case space(String)
    case organization(String)

    var listPath: String {
        switch self {
        case .space(let id): Endpoints.Trash.list(spaceId: id)
        case .organization(let id): Endpoints.Trash.organizationList(organizationId: id)
        }
    }

    var emptyPath: String {
        switch self {
        case .space(let id): Endpoints.Trash.empty(spaceId: id)
        case .organization(let id): Endpoints.Trash.organizationEmpty(organizationId: id)
        }
    }

    var organizationId: String? {
        guard case .organization(let id) = self else { return nil }
        return id
    }
}

private struct TrashedItemsResponse: Decodable, Sendable {
    let items: [TrashedItem]
    let total: Int?
    let page: Int?
    let pageSize: Int?

    enum CodingKeys: String, CodingKey {
        case items, total, page
        case pageSize = "page_size"
    }
}

@MainActor @Observable
private final class TrashSettingsStore {
    private(set) var items: [TrashedItem] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    var actionError: String?
    var restoringIds: Set<String> = []

    func load(scope: TrashScope) async {
        isLoading = items.isEmpty
        loadError = nil
        defer { isLoading = false }
        do {
            let response: TrashedItemsResponse = try await APIClient.shared.get(
                path: scope.listPath,
                query: ["page_size": "200"]
            )
            items = response.items.sorted {
                ($0.trashedAt ?? $0.updatedAt ?? "") > ($1.trashedAt ?? $1.updatedAt ?? "")
            }
        } catch {
            guard !error.isCancellation else { return }
            loadError = error.localizedDescription
        }
    }

    func restore(_ item: TrashedItem, scope: TrashScope) async {
        restoringIds.insert(item.id)
        actionError = nil
        defer { restoringIds.remove(item.id) }
        do {
            let resourceId = item.resourceId ?? item.id
            let path = try trashActionPath(item: item, resourceId: resourceId, action: .restore, scope: scope)
            let _: ApiEnvelope<String?> = try await APIClient.shared.post(path: path)
            items.removeAll { $0.id == item.id }
        } catch {
            actionError = error.localizedDescription
        }
    }

    func permanentDelete(_ item: TrashedItem, scope: TrashScope) async {
        actionError = nil
        do {
            let resourceId = item.resourceId ?? item.id
            let path = try trashActionPath(item: item, resourceId: resourceId, action: .permanent, scope: scope)
            let _: ApiEnvelope<String?> = try await APIClient.shared.delete(path: path)
            items.removeAll { $0.id == item.id }
        } catch {
            actionError = error.localizedDescription
        }
    }

    func empty(scope: TrashScope) async {
        actionError = nil
        do {
            let _: ApiEnvelope<String?> = try await APIClient.shared.post(path: scope.emptyPath)
            items.removeAll()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

private enum TrashAction {
    case restore
    case permanent
}

private enum TrashActionError: LocalizedError {
    case missingHost

    var errorDescription: String? { "该资源缺少所属 Workspace，暂时无法执行此操作。" }
}

private func trashActionPath(
    item: TrashedItem,
    resourceId: String,
    action: TrashAction,
    scope: TrashScope
) throws -> String {
    if ["tabfiles", "file"].contains(canonicalTrashType(item.itemType)),
       let organizationId = scope.organizationId {
        switch action {
        case .restore:
            return Endpoints.Context.organizationFileRestore(organizationId: organizationId, fileRecordId: resourceId)
        case .permanent:
            return Endpoints.Context.organizationFilePermanent(organizationId: organizationId, fileRecordId: resourceId)
        }
    }

    guard let spaceId = item.spaceId ?? {
        if case .space(let id) = scope { return id }
        return nil
    }() else {
        throw TrashActionError.missingHost
    }

    switch action {
    case .restore:
        return Endpoints.Trash.restore(itemType: item.itemType, resourceId: resourceId, spaceId: spaceId)
    case .permanent:
        return Endpoints.Trash.permanent(itemType: item.itemType, resourceId: resourceId, spaceId: spaceId)
    }
}

struct TrashBinEditor: View {
    private let scope: TrashScope
    @State private var store = TrashSettingsStore()
    @State private var deleteTarget: TrashedItem?
    @State private var showEmptyConfirm = false

    init(spaceId: String) {
        scope = .space(spaceId)
    }

    init(organizationId: String) {
        scope = .organization(organizationId)
    }

    var body: some View {
        Group {
            if store.isLoading && store.items.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let loadError = store.loadError, store.items.isEmpty {
                settingsRetryState(message: loadError) { Task { await store.load(scope: scope) } }
            } else if store.items.isEmpty {
                ContentUnavailableView {
                    Label("回收站为空", systemImage: "trash")
                } description: {
                    Text("删除的文档、表格、画布等资源会先出现在这里。")
                }
            } else {
                List {
                    Section {
                        Text("回收站资源可恢复，也可永久删除。永久删除后无法撤销。")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                    if let error = store.actionError {
                        Section { settingsError(error) }
                    }
                    ForEach(store.items) { item in
                        HStack(spacing: TTSpacing.md) {
                            Image(systemName: trashIcon(for: item.itemType))
                                .foregroundStyle(.tt.textTertiary)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title.isEmpty ? "未命名资源" : item.title)
                                    .font(.tt.body)
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(1)
                                HStack(spacing: TTSpacing.xs) {
                                    Text(trashTypeLabel(item.itemType))
                                    if let time = item.displayTime {
                                        Text("·")
                                        Text(time)
                                    }
                                    Text("·")
                                    Text("剩余 \(item.daysLeft) 天")
                                }
                                .font(.tt.caption)
                                .foregroundStyle(item.daysLeft <= 7 ? .orange : .tt.textTertiary)
                            }
                            Spacer()
                            if store.restoringIds.contains(item.id) {
                                ProgressView().controlSize(.mini)
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button {
                                Task { await store.restore(item, scope: scope) }
                            } label: {
                                Label("恢复", systemImage: "arrow.uturn.backward")
                            }
                            .tint(.tt.bgAccent)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                deleteTarget = item
                            } label: {
                                Label("永久删除", systemImage: "trash")
                            }
                        }
                    }
                }
                .ttListStyle()
                .refreshable { await store.load(scope: scope) }
            }
        }
        .navigationTitle("回收站")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !store.items.isEmpty {
                    Button("清空") { showEmptyConfirm = true }
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                }
            }
        }
        .ttToolbarBackground()
        .task { await store.load(scope: scope) }
        .alert("清空回收站？", isPresented: $showEmptyConfirm) {
            Button("清空", role: .destructive) { Task { await store.empty(scope: scope) } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("将永久删除 \(store.items.count) 个资源，无法撤销。")
        }
        .alert("永久删除这个资源？", isPresented: Binding(
            get: { deleteTarget != nil },
            set: { if !$0 { deleteTarget = nil } }
        )) {
            Button("永久删除", role: .destructive) {
                guard let target = deleteTarget else { return }
                Task {
                    await store.permanentDelete(target, scope: scope)
                    deleteTarget = nil
                }
            }
            Button("取消", role: .cancel) { deleteTarget = nil }
        }
    }
}

private func canonicalTrashType(_ raw: String) -> String {
    let legacy: [String: String] = [
        "document": "tabdoc", "table": "tabdata", "slide": "tabslide",
        "video": "tabvideo", "code": "tabcode",
        "memo": "tabmemo", "canvas": "tabwhiteboard", "ppt": "tabslide",
    ]
    return legacy[raw] ?? raw
}

private func trashIcon(for itemType: String) -> String {
    switch canonicalTrashType(itemType) {
    case "tabdoc": return "doc.text"
    case "tabdata": return "tablecells"
    case "tabslide": return "rectangle.on.rectangle"
    case "tabvideo": return "video"
    case "tabcode": return "chevron.left.forwardslash.chevron.right"
    case "tabmemo": return "note.text"
    case "tabwhiteboard": return "pencil.and.outline"
    default: return "doc"
    }
}

private func trashTypeLabel(_ itemType: String) -> String {
    switch canonicalTrashType(itemType) {
    case "tabdoc": return "文档"
    case "tabdata": return "表格"
    case "tabslide": return "幻灯片"
    case "tabvideo": return "视频"
    case "tabcode": return "代码"
    case "tabmemo": return "Memo"
    case "tabwhiteboard": return "画布"
    default: return itemType
    }
}

// MARK: - 设置页通用小组件

@ViewBuilder
private func settingsError(_ message: String?) -> some View {
    if let message, !message.isEmpty {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.tt.meta)
            .foregroundStyle(.tt.textCritical)
    }
}

private func settingsRetryState(message: String, retry: @escaping () -> Void) -> some View {
    VStack(spacing: TTSpacing.lg) {
        Image(systemName: "wifi.exclamationmark")
            .font(.tt.iconEmptyLG)
            .foregroundStyle(.tt.textTertiary.opacity(0.45))
        Text(message)
            .font(.tt.meta)
            .foregroundStyle(.tt.textTertiary)
            .multilineTextAlignment(.center)
        Button("重试", action: retry)
            .font(.tt.bodySemibold)
            .foregroundStyle(.tt.textAccent)
    }
    .padding(TTSpacing.xxl)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
}

@ViewBuilder
private func settingsField<Content: View>(
    title: String,
    hint: String,
    @ViewBuilder content: () -> Content
) -> some View {
    VStack(alignment: .leading, spacing: TTSpacing.xs) {
        Text(title)
            .font(.tt.metaSemibold)
            .foregroundStyle(.tt.textSecondary)
        Text(hint)
            .font(.tt.caption)
            .foregroundStyle(.tt.textTertiary)
        content()
    }
}

private func settingsChoiceRow(selected: Bool, title: String, subtitle: String) -> some View {
    HStack(alignment: .top, spacing: TTSpacing.sm) {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.tt.iconSubtitle)
            .foregroundStyle(selected ? .tt.iconAccent : .tt.textTertiary)
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            Text(title)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
            Text(subtitle)
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)
                .multilineTextAlignment(.leading)
        }
        Spacer(minLength: 0)
    }
    .padding(TTSpacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    .overlay(
        RoundedRectangle(cornerRadius: TTRadius.sm)
            .strokeBorder(selected ? .tt.iconAccent : .clear, lineWidth: 1.5)
    )
    .contentShape(Rectangle())
}

private extension View {
    func settingsFieldChrome() -> some View {
        self
            .padding(TTSpacing.md)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }
}

private struct UnavailableSettingsDetail: View {
    let title: String
    let description: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "wrench.and.screwdriver")
        } description: {
            Text(description)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
    }
}

private struct SettingsInfoRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title)
                .foregroundStyle(.tt.textSecondary)
            Spacer(minLength: TTSpacing.md)
            Text(value)
                .font(.tt.codeSM)
                .foregroundStyle(.tt.textTertiary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

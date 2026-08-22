import SwiftUI

/// ➕ 新建面板。
///
/// 统一新建任务入口：
///   - 只在入口确定执行 Workspace；Agent 选择由 ConversationScreen 的草稿设置统一承接
///   - 「继续设置」只打开携带草稿的 ConversationScreen，不在这里创建 Session 或首发
///   - 「保存 Memo」：仍写入所选 Workspace
struct ComposeSheet: View {
    @Binding var isPresented: Bool

    @State private var store = WorkspaceStore.shared
    @State private var draft: String
    @State private var contextRefs: [MentionContextRef]
    @State private var contextResources: [SpaceResource]
    @State private var selectedWorkspace: Space?
    @State private var infoMessage: String?
    @State private var isSavingMemo = false
    @FocusState private var focused: Bool

    static let lastWorkspaceKey = "tabtin_compose_last_workspace_id"

    private var workspaces: [Space] {
        store.spaces.filter(\.isExecutionSpace)
    }

    private var hasContent: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !contextRefs.isEmpty
    }

    private var canSend: Bool {
        hasContent && selectedWorkspace != nil
    }

    private var canSaveMemo: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && selectedWorkspace != nil
    }

    init(
        isPresented: Binding<Bool>,
        initialDraft: String = "",
        initialContextRefs: [MentionContextRef] = [],
        initialContextResources: [SpaceResource] = []
    ) {
        _isPresented = isPresented
        _draft = State(initialValue: initialDraft)
        _contextRefs = State(initialValue: initialContextRefs)
        _contextResources = State(initialValue: initialContextResources)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                taskSetupBar
                Divider().opacity(0.4)
                contextRefBar
                textInputArea
                bottomActions
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle(L10n.Compose.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n.Common.cancel) { isPresented = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            if store.spaces.isEmpty { await store.loadSpaces() }
            resolveDefaults()
            try? await Task.sleep(for: .milliseconds(250))
            focused = true
        }
        .onChange(of: store.spaces.map(\.id)) { _, _ in resolveDefaults() }
        .alert(L10n.Compose.noticeTitle, isPresented: Binding(
            get: { infoMessage != nil },
            set: { if !$0 { infoMessage = nil } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { infoMessage = nil }
        } message: {
            Text(infoMessage ?? "")
        }
    }

    // MARK: - Task setup (Workspace)

    @ViewBuilder
    private var taskSetupBar: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Text(L10n.Compose.taskSetup)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
                .padding(.horizontal, TTSpacing.lg)
                .padding(.top, TTSpacing.sm)

            if workspaces.isEmpty {
                setupHint(L10n.Compose.noWorkspace, systemImage: "folder.badge.questionmark")
            } else {
                workspaceMenu
            }
        }
        .padding(.bottom, TTSpacing.sm)
    }

    private func setupHint(_ text: String, systemImage: String) -> some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: systemImage)
                .foregroundStyle(.tt.textWarning)
            Text(text)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
            Spacer()
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.sm)
    }

    private var workspaceMenu: some View {
        Menu {
            ForEach(workspaces) { workspace in
                Button {
                    selectedWorkspace = workspace
                    UserDefaults.standard.set(workspace.id, forKey: Self.lastWorkspaceKey)
                } label: {
                    Label(
                        workspace.name,
                        systemImage: workspace.id == selectedWorkspace?.id ? "checkmark" : "folder"
                    )
                }
            }
        } label: {
            setupChip(
                label: L10n.Compose.pickWorkspaceLabel,
                value: selectedWorkspace?.name ?? L10n.Compose.pickWorkspaceTitle
            )
        }
        .buttonStyle(.plain)
    }

    private func setupChip(label: String, value: String) -> some View {
        HStack(spacing: TTSpacing.sm) {
            Text(label)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
            HStack(spacing: TTSpacing.xs) {
                Text(value)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, 6)
            .background(Capsule().fill(.tt.bgSubtle))
            Spacer()
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    // MARK: - Text input

    private var textInputArea: some View {
        ZStack(alignment: .topLeading) {
            if draft.isEmpty {
                Text(L10n.Compose.placeholder)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textTertiary)
                    .padding(.horizontal, TTSpacing.lg + 4)
                    .padding(.top, TTSpacing.md + 8)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $draft)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, TTSpacing.lg - 4)
                .padding(.top, TTSpacing.sm)
                .focused($focused)
        }
        .frame(maxHeight: .infinity)
    }

    @ViewBuilder
    private var contextRefBar: some View {
        if !contextRefs.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TTSpacing.xs) {
                    ForEach(contextRefs) { ref in
                        ContextRefChip(ref: ref) {
                            contextRefs.removeAll { $0.id == ref.id }
                            contextResources.removeAll { $0.resourceId == ref.resourceId }
                        }
                    }
                }
                .padding(.horizontal, TTSpacing.lg)
                .padding(.vertical, TTSpacing.sm)
            }
            Divider().opacity(0.4)
        }
    }

    // MARK: - Bottom actions

    private var bottomActions: some View {
        HStack(spacing: TTSpacing.md) {
            Spacer()

            Button {
                Task { await saveMemo() }
            } label: {
                HStack(spacing: 4) {
                    if isSavingMemo {
                        ProgressView().scaleEffect(0.75)
                    } else {
                        Text(L10n.Compose.saveAsMemo)
                            .font(.tt.bodySemibold)
                    }
                }
                .foregroundStyle(canSaveMemo ? .tt.textAccent : .tt.textTertiary)
                .padding(.horizontal, TTSpacing.lg)
                .padding(.vertical, TTSpacing.sm + 2)
                .background(
                    Capsule().stroke(canSaveMemo ? .tt.bgAccent.opacity(0.4) : .tt.borderLight, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(!canSaveMemo || isSavingMemo)

            Button { openTaskDraft() } label: {
                HStack(spacing: 4) {
                    Text("继续设置").font(.tt.bodySemibold)
                    Image(systemName: "arrow.right").font(.tt.iconCaption)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, TTSpacing.lg)
                .padding(.vertical, TTSpacing.sm + 2)
                .background(Capsule().fill(.tt.bgAccent.opacity(canSend ? 1 : 0.4)))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.md)
        .background(.tt.bgCanvasDefault)
    }

    // MARK: - Logic

    private func resolveDefaults() {
        if selectedWorkspace == nil || !workspaces.contains(where: { $0.id == selectedWorkspace?.id }) {
            let lastId = UserDefaults.standard.string(forKey: Self.lastWorkspaceKey)
            selectedWorkspace = workspaces.first { $0.id == lastId }
                ?? workspaces.first(where: { $0.isDefault == true })
                ?? workspaces.first
        }
    }

    /// 这里的输入只作为统一 Composer 的预填草稿；实际 Session 创建与发送由其首发链路负责。
    private func openTaskDraft() {
        guard let workspace = selectedWorkspace else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !contextRefs.isEmpty else { return }

        UserDefaults.standard.set(workspace.id, forKey: Self.lastWorkspaceKey)
        let target = ConversationTarget(
            title: workspace.name,
            workspaceId: workspace.id,
            organizationId: workspace.organizationId,
            startsNewSession: true,
            initialMessage: text,
            initialContextRefs: contextRefs,
            initialContextResources: contextResources
        )
        isPresented = false
        MainRouter.shared.openConversation(target)
    }

    private func saveMemo() async {
        guard let workspace = selectedWorkspace else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        isSavingMemo = true
        infoMessage = nil
        let body: [String: Any] = [
            "organization_id": workspace.organizationId,
            "space_id": workspace.id,
            "content_json": [String: Any](),
            "content_markdown": text,
            "source": "manual",
            "memo_type": "note",
        ]
        do {
            let _: CloudMemoSummary = try await APIClient.shared.post(
                path: Endpoints.TabMemo.memos,
                body: body
            )
            UserDefaults.standard.set(workspace.id, forKey: Self.lastWorkspaceKey)
            isPresented = false
        } catch {
            infoMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isSavingMemo = false
    }
}

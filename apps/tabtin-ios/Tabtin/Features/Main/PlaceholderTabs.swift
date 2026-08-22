import SwiftUI

// legacy: 底栏/旧入口已退役，零调用保留。
struct CloudMemoScreen: View {
    let organizationId: String?
    let spaces: [Space]

    @State private var vm = CloudMemoViewModel()
    @State private var isEditorPresented = false
    @State private var selectedMemoContext: CloudMemoDetailContext?
    @State private var selectedStatus: CloudMemoStatus = .active
    @State private var actionErrorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            if organizationId != nil {
                Picker("Memo 状态", selection: $selectedStatus) {
                    ForEach(CloudMemoStatus.allCases) { status in
                        Text(status.title).tag(status)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, TTSpacing.lg)
                .padding(.vertical, TTSpacing.sm)
            }
            memoContent
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle("Memo")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $selectedMemoContext) { context in
            CloudMemoDetailScreen(
                context: context,
                onStatusChanged: { vm.removeMemo(id: $0) }
            )
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if selectedStatus == .active {
                    Button { isEditorPresented = true } label: {
                        TaskPrimaryNavIconView(
                            icon: .newTask,
                            size: 21,
                            color: .tt.iconAccent
                        )
                    }
                    .accessibilityLabel("新建 Memo")
                    .disabled(organizationId == nil)
                }
            }
        }
        .sheet(isPresented: $isEditorPresented) {
            CloudMemoEditorSheet(
                spaces: spaces,
                onCancel: { isEditorPresented = false },
                onSave: { content, spaceId in
                    try await vm.createMemo(
                        organizationId: organizationId,
                        content: content,
                        spaceId: spaceId
                    )
                    isEditorPresented = false
                }
            )
        }
        .alert(
            "操作失败",
            isPresented: Binding(
                get: { actionErrorMessage != nil },
                set: { if !$0 { actionErrorMessage = nil } }
            )
        ) {
            Button("好", role: .cancel) { actionErrorMessage = nil }
        } message: {
            Text(actionErrorMessage ?? "")
        }
        .task(id: "\(organizationId ?? ""):\(selectedStatus.rawValue)") { await load() }
    }

    @ViewBuilder
    private var memoContent: some View {
        Group {
            if organizationId == nil {
                ContentUnavailableView("未选择组织", systemImage: "person.2")
            } else if vm.isLoading && vm.memos.isEmpty {
                ProgressView("正在加载 Memo…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let message = vm.errorMessage, vm.memos.isEmpty {
                TTErrorStateView(
                    message: message,
                    title: L10n.MemoAppHome.loadFailed,
                    systemImage: "wifi.exclamationmark",
                    prominence: .inline
                ) { Task { await load() } }
                .padding(TTSpacing.lg)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if vm.memos.isEmpty {
                ContentUnavailableView {
                    Label(selectedStatus == .active ? "还没有 Memo" : "没有已归档的 Memo", systemImage: "note.text")
                } description: {
                    Text(selectedStatus == .active
                         ? "在手机上快速记一条，之后可以继续交给 Agent 整理。"
                         : "长按当前 Memo 可将它归档到这里。")
                } actions: {
                    if selectedStatus == .active {
                        Button("新建 Memo") { isEditorPresented = true }
                            .buttonStyle(.borderedProminent)
                            .tint(.tt.bgAccent)
                    }
                }
            } else {
                List {
                    ForEach(vm.memos) { memo in
                        Button {
                            selectedMemoContext = CloudMemoDetailContext(
                                memoId: memo.id,
                                title: memo.displayText,
                                spaceName: vm.spaceName(for: memo),
                                status: selectedStatus
                            )
                        } label: {
                            MemoRowView(
                                memo: memo,
                                spaceName: vm.spaceName(for: memo)
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button {
                                Task { await changeStatus(memo) }
                            } label: {
                                Label(
                                    selectedStatus == .active ? "归档" : "恢复",
                                    systemImage: selectedStatus == .active ? "archivebox" : "arrow.uturn.backward"
                                )
                            }
                        }
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.plain)
                .refreshable { await load() }
            }
        }
    }

    private func load() async {
        await vm.load(organizationId: organizationId, spaces: spaces, status: selectedStatus)
    }

    private func changeStatus(_ memo: CloudMemoSummary) async {
        do {
            if selectedStatus == .active {
                try await vm.archive(id: memo.id)
            } else {
                try await vm.restore(id: memo.id)
            }
        } catch {
            guard !error.isCancellation else { return }
            actionErrorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

private struct CloudMemoEditorSheet: View {
    let spaces: [Space]
    var onCancel: () -> Void
    var onSave: (String, String?) async throws -> Void

    @State private var content = ""
    @State private var selectedSpaceId: String?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    private var trimmed: String {
        content.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextEditor(text: $content)
                    .font(.tt.body)
                    .scrollContentBackground(.hidden)
                    .padding(TTSpacing.md)
                    .background(.tt.bgCanvasDefault)
                    .focused($focused)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textCritical)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, TTSpacing.lg)
                        .padding(.vertical, TTSpacing.xs)
                }

                HStack(spacing: TTSpacing.sm) {
                    Menu {
                        Button("个人 Memo") { selectedSpaceId = nil }
                        if !spaces.isEmpty {
                            Divider()
                            ForEach(spaces) { space in
                                Button(space.name) { selectedSpaceId = space.id }
                            }
                        }
                    } label: {
                        Label(selectedSpaceName, systemImage: "person.crop.square")
                            .font(.tt.meta)
                            .lineLimit(1)
                    }
                    .buttonStyle(.bordered)

                    Spacer(minLength: 0)

                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving {
                            ProgressView().scaleEffect(0.75)
                        } else {
                            Text("保存")
                                .font(.tt.bodySemibold)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.tt.bgAccent)
                    .disabled(trimmed.isEmpty || isSaving)
                }
                .padding(TTSpacing.lg)
                .background(.tt.bgCanvasDefault)
            }
            .navigationTitle("新建 Memo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", action: onCancel)
                        .disabled(isSaving)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            selectedSpaceId = spaces.first?.id
            focused = true
        }
    }

    private var selectedSpaceName: String {
        guard let selectedSpaceId,
              let space = spaces.first(where: { $0.id == selectedSpaceId }) else {
            return "个人 Memo"
        }
        return space.name
    }

    private func save() async {
        guard !trimmed.isEmpty else { return }
        isSaving = true
        errorMessage = nil
        do {
            try await onSave(trimmed, selectedSpaceId)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isSaving = false
    }
}

@MainActor @Observable
private final class CloudMemoViewModel {
    private(set) var memos: [CloudMemoSummary] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    private var spaceNamesById: [String: String] = [:]
    private var loadedContext: String?
    private var loadGeneration = 0

    func load(organizationId: String?, spaces: [Space], status: CloudMemoStatus = .active) async {
        loadGeneration += 1
        let generation = loadGeneration
        guard let organizationId else {
            memos = []
            errorMessage = nil
            loadedContext = nil
            isLoading = false
            return
        }
        let context = "\(organizationId):\(status.rawValue)"
        if loadedContext != context {
            loadedContext = context
            memos = []
        }
        spaceNamesById = Dictionary(uniqueKeysWithValues: spaces.map { ($0.id, $0.name) })
        isLoading = memos.isEmpty
        errorMessage = nil
        do {
            let response: CloudMemoListResponse = try await APIClient.shared.get(
                path: Endpoints.TabMemo.memos,
                query: [
                    "organization_id": organizationId,
                    "status": status.rawValue,
                    "memo_type": "note,bookmark",
                    "sort": "-updated_at",
                    "limit": "80",
                ]
            )
            guard generation == loadGeneration, loadedContext == context else { return }
            memos = response.items.sorted { $0.sortTimestamp > $1.sortTimestamp }
        } catch {
            guard generation == loadGeneration, loadedContext == context else { return }
            guard !error.isCancellation else {
                isLoading = false
                return
            }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        if generation == loadGeneration {
            isLoading = false
        }
    }

    func createMemo(organizationId: String?, content: String, spaceId: String?) async throws {
        guard let organizationId else { throw APIError.apiError("未选择组织") }
        var body: [String: Any] = [
            "organization_id": organizationId,
            "content_json": [String: Any](),
            "content_markdown": content,
            "source": "manual",
            "memo_type": "note",
        ]
        if let spaceId, !spaceId.isEmpty {
            body["space_id"] = spaceId
        }
        let created: CloudMemoSummary = try await APIClient.shared.post(
            path: Endpoints.TabMemo.memos,
            body: body
        )
        memos.insert(created, at: 0)
        memos = memos.sorted { $0.sortTimestamp > $1.sortTimestamp }
    }

    func archive(id: String) async throws {
        let _: [String: AnyCodable] = try await APIClient.shared.post(
            path: Endpoints.TabMemo.archive(id),
            body: [:]
        )
        removeMemo(id: id)
    }

    func restore(id: String) async throws {
        let _: CloudMemoSummary = try await APIClient.shared.post(
            path: Endpoints.TabMemo.restore(id),
            body: [:]
        )
        removeMemo(id: id)
    }

    func removeMemo(id: String) {
        memos.removeAll { $0.id == id }
    }

    func spaceName(for memo: CloudMemoSummary) -> String? {
        guard let spaceId = memo.spaceId else { return nil }
        return spaceNamesById[spaceId]
    }
}

struct CloudFileInfoScreen: View {
    let resource: SpaceResource
    var spaceName: String? = nil

    @State private var showCopiedToast = false
    @Environment(\.openURL) private var openURL

    private var metadata: [String: AnyCodable] { resource.metadata ?? [:] }

    private var fileName: String {
        metadata.firstString("file_name", "filename", "name", "original_name", "display_name")
            ?? resource.displayTitle
    }

    private var mimeType: String? {
        metadata.firstString("mime_type", "mime", "content_type", "contentType")
    }

    private var fileSizeText: String? {
        let bytes = metadata.firstInt("size", "file_size", "size_bytes", "bytes")
            ?? metadata.firstDouble("size", "file_size", "size_bytes", "bytes").map(Int.init)
        guard let bytes, bytes > 0 else { return nil }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    private var fileURL: URL? {
        let raw = metadata.firstString(
            "preview_url",
            "download_url",
            "file_url",
            "url",
            "oss_url",
            "dist_oss_url",
            "storage_url"
        ) ?? resource.preview
        guard let raw, !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.lg) {
                header
                if let url = fileURL {
                    linkSection(url)
                }
                infoSection
            }
            .padding(TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(fileName)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .top) {
            if showCopiedToast {
                copiedToast.transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Image(systemName: "folder")
                .font(.tt.iconEmptyMDSemibold)
                .foregroundStyle(.tt.iconAccent)
            Text(fileName)
                .font(.tt.subtitle)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(3)
            Text(resource.preview ?? "文件资源")
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(TTSpacing.lg)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private func linkSection(_ url: URL) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text("可用操作")
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            Button { openURL(url) } label: {
                Label("打开文件链接", systemImage: "arrow.up.right.square")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button { copy(url) } label: {
                Label("复制链接", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ShareLink(item: url) {
                Label("系统分享", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .buttonStyle(.bordered)
    }

    private var infoSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text("文件信息")
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            infoRow("类型", mimeType ?? resource.typeLabel)
            if let fileSizeText {
                infoRow("大小", fileSizeText)
            }
            infoRow("资源 ID", resource.resourceId)
            infoRow("Space", resource.spaceName ?? spaceName ?? resource.spaceId ?? "组织云端")
            if fileURL == nil {
                Text("当前资源没有可用的预览或下载链接，仍可通过「发给 Agent」让 Agent 继续处理。")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .padding(.top, TTSpacing.xs)
            }
        }
        .padding(TTSpacing.lg)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Text(label)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }

    private var copiedToast: some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.tt.bgSuccess)
            Text("链接已复制").font(.tt.meta).foregroundStyle(.tt.textPrimary)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.sm)
        .background(Capsule().fill(.tt.bgSubtle).shadow(color: .black.opacity(0.08), radius: 8, y: 4))
        .padding(.top, TTSpacing.md)
    }

    private func copy(_ url: URL) {
        UIPasteboard.general.string = url.absoluteString
        withAnimation(.spring(duration: 0.3)) { showCopiedToast = true }
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.spring(duration: 0.3)) { showCopiedToast = false }
        }
    }
}

private extension Dictionary where Key == String, Value == AnyCodable {
    func firstString(_ keys: String...) -> String? {
        for key in keys {
            if let value = self[key]?.stringValue, !value.isEmpty {
                return value
            }
        }
        return nil
    }

    func firstInt(_ keys: String...) -> Int? {
        for key in keys {
            if let value = self[key]?.intValue {
                return value
            }
        }
        return nil
    }

    func firstDouble(_ keys: String...) -> Double? {
        for key in keys {
            if let value = self[key]?.doubleValue {
                return value
            }
        }
        return nil
    }
}

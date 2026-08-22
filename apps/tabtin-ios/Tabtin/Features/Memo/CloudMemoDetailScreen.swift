import SwiftUI

struct CloudMemoDetailScreen: View {
    let context: CloudMemoDetailContext
    /// trash / archive / restore 后从 active 列表移除（或由调用方自行解释）。
    var onStatusChanged: ((String) -> Void)?
    /// 置顶变更写回列表投影。
    var onPinnedChanged: ((String, Bool) -> Void)?

    init(
        context: CloudMemoDetailContext,
        onStatusChanged: ((String) -> Void)? = nil,
        onPinnedChanged: ((String, Bool) -> Void)? = nil
    ) {
        self.context = context
        self.onStatusChanged = onStatusChanged
        self.onPinnedChanged = onPinnedChanged
    }

    @Environment(\.dismiss) private var dismiss
    @State private var memo: CloudMemoSummary?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var actionErrorMessage: String?
    @State private var retagMessage: String?
    @State private var isChangingStatus = false
    @State private var isRetagging = false
    @State private var isPinning = false
    @State private var retagTask: Task<Void, Never>?

    var body: some View {
        Group {
            if isLoading && memo == nil {
                ProgressView(L10n.MemoAppHome.loadingDetail)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage, memo == nil {
                TTErrorStateView(
                    message: errorMessage,
                    title: L10n.MemoAppHome.loadFailed,
                    systemImage: "wifi.exclamationmark",
                    prominence: .inline
                ) { Task { await load() } }
                .padding(TTSpacing.lg)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: TTSpacing.lg) {
                        header
                        Text((memo?.displayText ?? context.title).trimmingCharacters(in: .whitespacesAndNewlines))
                            .font(.tt.body)
                            .foregroundStyle(.tt.textPrimary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(TTSpacing.lg)
                            .background(
                                (memo?.memoColor.softBackground ?? .tt.bgSubtle),
                                in: RoundedRectangle(cornerRadius: TTRadius.sm)
                            )

                        if let tags = memo?.tags, !tags.isEmpty {
                            tagSection(L10n.MemoAppHome.tagsSection, tags: tags)
                        }
                        if let aiTags = memo?.aiTags, !aiTags.isEmpty {
                            tagSection(L10n.MemoAppHome.aiTagsSection, tags: aiTags)
                        }
                    }
                    .padding(TTSpacing.lg)
                }
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(L10n.MemoAppHome.detailTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { retag() } label: {
                    if isRetagging {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "wand.and.sparkles")
                    }
                }
                .disabled(isRetagging || memo == nil)
                .accessibilityLabel(L10n.MemoAppHome.retag)

                Menu {
                    if let memo {
                        Button {
                            Task { await setPinned(!memo.isPinned) }
                        } label: {
                            Label(
                                memo.isPinned ? L10n.MemoAppHome.unpin : L10n.MemoAppHome.pin,
                                systemImage: memo.isPinned ? "pin.slash" : "pin"
                            )
                        }
                        .disabled(isPinning)
                    }

                    Button { Task { await changeStatus() } } label: {
                        Label(
                            isArchived ? L10n.MemoAppHome.restore : L10n.MemoAppHome.archive,
                            systemImage: isArchived ? "arrow.uturn.backward" : "archivebox"
                        )
                    }
                    .disabled(isChangingStatus || memo == nil)

                    Button(role: .destructive) {
                        Task { await moveToTrash() }
                    } label: {
                        Label(L10n.MemoAppHome.moveToTrash, systemImage: "trash")
                    }
                    .disabled(isChangingStatus || memo == nil)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel(L10n.Common.more)
            }
        }
        .alert(
            L10n.MemoAppHome.operationFailed,
            isPresented: Binding(
                get: { actionErrorMessage != nil },
                set: { if !$0 { actionErrorMessage = nil } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) { actionErrorMessage = nil }
        } message: {
            Text(actionErrorMessage ?? "")
        }
        .alert(
            L10n.MemoAppHome.hintTitle,
            isPresented: Binding(
                get: { retagMessage != nil },
                set: { if !$0 { retagMessage = nil } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) { retagMessage = nil }
        } message: {
            Text(retagMessage ?? "")
        }
        .task { await load() }
        .onDisappear { retagTask?.cancel() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label(context.spaceName ?? L10n.MemoAppHome.personalMemo, systemImage: "note.text")
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textSecondary)
            if let memo {
                HStack(spacing: TTSpacing.xs) {
                    if memo.isPinned {
                        Label(L10n.MemoAppHome.pinned, systemImage: "pin.fill")
                    }
                    if let updatedAt = memo.updatedAt ?? memo.createdAt {
                        Text(updatedAt)
                    }
                }
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var isArchived: Bool {
        if let status = memo?.status {
            return status == CloudMemoStatus.archived.rawValue
        }
        return context.status == .archived
    }

    private func tagSection(_ title: String, tags: [String]) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(title)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textSecondary)
            MemoTagFlow(spacing: TTSpacing.xs, rowSpacing: TTSpacing.xs) {
                ForEach(tags, id: \.self) { tag in
                    MemoTagChip(tag: tag, horizontalPadding: TTSpacing.sm, verticalPadding: 5)
                }
            }
        }
    }

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        do {
            memo = try await APIClient.shared.get(path: Endpoints.TabMemo.memo(context.memoId))
        } catch {
            guard !error.isCancellation else {
                isLoading = false
                return
            }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    private func setPinned(_ pinned: Bool) async {
        guard !isPinning else { return }
        isPinning = true
        defer { isPinning = false }
        do {
            let updated: CloudMemoSummary = try await APIClient.shared.post(
                path: Endpoints.TabMemo.pin(context.memoId),
                body: ["pinned": pinned]
            )
            memo = updated
            onPinnedChanged?(context.memoId, updated.isPinned)
        } catch {
            guard !error.isCancellation else { return }
            actionErrorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func moveToTrash() async {
        guard !isChangingStatus else { return }
        isChangingStatus = true
        defer { isChangingStatus = false }
        do {
            let _: [String: AnyCodable] = try await APIClient.shared.post(
                path: Endpoints.TabMemo.trash(context.memoId),
                body: [:]
            )
            onStatusChanged?(context.memoId)
            dismiss()
        } catch {
            guard !error.isCancellation else { return }
            actionErrorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func changeStatus() async {
        guard !isChangingStatus else { return }
        isChangingStatus = true
        defer { isChangingStatus = false }
        do {
            if isArchived {
                let _: CloudMemoSummary = try await APIClient.shared.post(
                    path: Endpoints.TabMemo.restore(context.memoId),
                    body: [:]
                )
            } else {
                let _: [String: AnyCodable] = try await APIClient.shared.post(
                    path: Endpoints.TabMemo.archive(context.memoId),
                    body: [:]
                )
            }
            onStatusChanged?(context.memoId)
            dismiss()
        } catch {
            guard !error.isCancellation else { return }
            actionErrorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func retag() {
        guard !isRetagging else { return }
        isRetagging = true
        retagTask = Task { @MainActor in
            defer { isRetagging = false }
            do {
                let previousTags = memo?.aiTags ?? []
                let _: [String: AnyCodable] = try await APIClient.shared.post(
                    path: Endpoints.TabMemo.retag(context.memoId),
                    body: [:]
                )
                var tagsUpdated = false
                for _ in 0..<8 {
                    try await Task.sleep(for: .seconds(3))
                    try Task.checkCancellation()
                    do {
                        let refreshed: CloudMemoSummary = try await APIClient.shared.get(
                            path: Endpoints.TabMemo.memo(context.memoId)
                        )
                        memo = refreshed
                        if refreshed.aiTags != previousTags {
                            tagsUpdated = true
                            break
                        }
                    } catch {
                        if error.isCancellation { throw CancellationError() }
                    }
                }
                retagMessage = tagsUpdated
                    ? L10n.MemoAppHome.retagUpdated
                    : L10n.MemoAppHome.retagPending
            } catch {
                guard !error.isCancellation else { return }
                actionErrorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

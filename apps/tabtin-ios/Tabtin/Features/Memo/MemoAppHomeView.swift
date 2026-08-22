import SwiftUI

/// Organization 级 Memo App 首页。空 `spaceId`；任务工作台只提供进入与返回。
struct MemoAppHomeView: View {
    @Bindable var viewModel: MemoAppHomeViewModel
    let appName: String
    let organizationName: String?
    let onBack: () -> Void
    /// 会话工作台以弹层承载时由右上角关闭；独立工作台仍保留返回。
    let onClose: (() -> Void)?
    let onOpenMemo: (CloudMemoSummary) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let memoAccent = Color(red: 0.90, green: 0.33, blue: 0.44)

    var body: some View {
        VStack(spacing: 0) {
            if onClose == nil {
                header
            }
            content
        }
        .background(phoneBackground)
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .appHomeSystemNavigationChrome(
            enabled: onClose != nil,
            title: appName,
            subtitle: organizationName,
            accent: memoAccent,
            onClose: onClose
        )
        .task { viewModel.onAppear() }
        .alert(
            L10n.MemoAppHome.operationFailed,
            isPresented: Binding(
                get: { viewModel.actionError != nil },
                set: { if !$0 { viewModel.clearActionError() } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) { viewModel.clearActionError() }
        } message: {
            Text(viewModel.actionError ?? "")
        }
    }

    private var phoneBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.10, green: 0.09, blue: 0.09)
            : Color(red: 0.97, green: 0.97, blue: 0.96)
    }

    private var header: some View {
        appHomeChromeHeader(
            title: appName,
            subtitle: organizationName,
            accent: memoAccent,
            onBack: onBack
        )
        .background(phoneBackground)
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isInitialLoading && !viewModel.hasListContent {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel(L10n.Common.loading)
        } else if let pageError = viewModel.pageError, !viewModel.hasListContent {
            pageErrorState(pageError)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: TTSpacing.md) {
                    searchField
                    MemoHeatmapView(
                        buckets: viewModel.heatmapBuckets,
                        monthCount: viewModel.monthCount,
                        selectedDayKey: viewModel.heatmapDayKey,
                        onSelectDay: { viewModel.selectHeatmapDay($0) }
                    )
                    MemoQuickComposer(viewModel: viewModel)
                    viewKindPicker
                    tagChips
                    listBody
                    loadMoreFooter
                }
                .padding(TTSpacing.lg)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await viewModel.refresh() }
        }
    }

    private var searchField: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.tt.textTertiary)
                .accessibilityHidden(true)
            TextField(
                L10n.MemoAppHome.searchPlaceholder,
                text: Binding(
                    get: { viewModel.searchText },
                    set: { viewModel.updateSearchText($0) }
                )
            )
            .font(.tt.meta)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L10n.MemoAppHome.searchPlaceholder)
    }

    private var viewKindPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: TTSpacing.xs) {
                ForEach(MemoAppHomeViewKind.visibleCases) { kind in
                    let selected = viewModel.viewKind == kind
                    Button {
                        viewModel.setViewKind(kind)
                    } label: {
                        Text(title(for: kind))
                            .font(.tt.captionMedium)
                            .foregroundStyle(selected ? .tt.textOnAccent : .tt.textSecondary)
                            .padding(.horizontal, TTSpacing.md)
                            .padding(.vertical, TTSpacing.xs)
                            .background(selected ? memoAccent : .tt.bgSubtle, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityLabel(title(for: kind))
                }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: viewModel.viewKind)
    }

    @ViewBuilder
    private var tagChips: some View {
        if !viewModel.tagStats.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TTSpacing.xs) {
                    ForEach(viewModel.tagStats.prefix(12), id: \.name) { tag in
                        Button {
                            viewModel.toggleTag(tag.name)
                        } label: {
                            MemoTagChip(
                                tag: tag.name,
                                isSelected: viewModel.selectedTags.contains(tag.name)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(
                            viewModel.selectedTags.contains(tag.name) ? .isSelected : []
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var listBody: some View {
        switch viewModel.viewKind {
        case .agentDiary:
            diaryList
        case .all, .today:
            memoTimeline
        }
    }

    @ViewBuilder
    private var memoTimeline: some View {
        if viewModel.memos.isEmpty {
            emptyState
        } else {
            ForEach(viewModel.timelineSections) { section in
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    Text(section.title)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(section.items) { memo in
                        memoButton(memo)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var diaryList: some View {
        if viewModel.diaryItems.isEmpty {
            emptyState
        } else {
            ForEach(viewModel.diaryItems) { item in
                AgentDiaryRowView(item: item)
            }
        }
    }

    private func memoButton(_ memo: CloudMemoSummary) -> some View {
        Button {
            onOpenMemo(memo)
        } label: {
            MemoRowView(memo: memo)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                Task { await viewModel.setPinned(memo, pinned: !memo.isPinned) }
            } label: {
                Label(
                    memo.isPinned ? L10n.MemoAppHome.unpin : L10n.MemoAppHome.pin,
                    systemImage: memo.isPinned ? "pin.slash" : "pin"
                )
            }
            Button(role: .destructive) {
                Task { await viewModel.trash(memo) }
            } label: {
                Label(L10n.MemoAppHome.moveToTrash, systemImage: "trash")
            }
        }
        .onAppear {
            if memo.id == viewModel.memos.last?.id {
                Task { await viewModel.loadMore() }
            }
        }
    }

    @ViewBuilder
    private var loadMoreFooter: some View {
        if let loadMoreError = viewModel.loadMoreError {
            VStack(spacing: TTSpacing.sm) {
                Text(loadMoreError)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textCritical)
                    .multilineTextAlignment(.center)
                Button(L10n.Common.retry) {
                    Task { await viewModel.retryLoadMore() }
                }
                .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TTSpacing.md)
        } else if viewModel.isLoadingMore {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, TTSpacing.md)
                .accessibilityLabel(L10n.Common.loading)
        } else if viewModel.hasMore {
            Color.clear
                .frame(height: 1)
                .onAppear {
                    Task { await viewModel.loadMore() }
                }
        }
    }

    private var emptyState: some View {
        VStack(spacing: TTSpacing.sm) {
            Image(systemName: "note.text")
                .font(.system(size: 28))
                .foregroundStyle(memoAccent.opacity(0.8))
            Text(emptyTitle)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(emptySubtitle)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, TTSpacing.xxl)
        .accessibilityElement(children: .combine)
    }

    private var emptyTitle: String {
        if viewModel.isSearching {
            return L10n.MemoAppHome.searchEmptyTitle
        }
        switch viewModel.viewKind {
        case .today: return L10n.MemoAppHome.emptyTodayTitle
        case .agentDiary: return L10n.MemoAppHome.emptyDiaryTitle
        case .all: return L10n.MemoAppHome.emptyTitle
        }
    }

    private var emptySubtitle: String {
        if viewModel.isSearching {
            return L10n.MemoAppHome.searchEmptySubtitle
        }
        switch viewModel.viewKind {
        case .today: return L10n.MemoAppHome.emptyTodaySubtitle
        case .agentDiary: return L10n.MemoAppHome.emptyDiarySubtitle
        case .all: return L10n.MemoAppHome.emptySubtitle
        }
    }

    private func pageErrorState(_ message: String) -> some View {
        // Memo 有自己的 accent（memoAccent），按钮 tint 走注入而不是全局 token。
        TTErrorStateView(
            message: message,
            title: L10n.MemoAppHome.loadFailed,
            systemImage: "wifi.exclamationmark",
            palette: .init(
                icon: Color.tt.textCritical,
                text: Color.tt.textSecondary,
                accent: memoAccent
            )
        ) { Task { await viewModel.refresh() } }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func title(for kind: MemoAppHomeViewKind) -> String {
        switch kind {
        case .all: return L10n.MemoAppHome.viewAll
        case .today: return L10n.MemoAppHome.viewToday
        case .agentDiary: return L10n.MemoAppHome.viewAgentDiary
        }
    }
}

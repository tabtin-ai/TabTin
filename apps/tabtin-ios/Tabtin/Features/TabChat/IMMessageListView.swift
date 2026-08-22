import SwiftUI
import UIKit

/// IM 消息列表滚动层：UIKit `UICollectionView` 负责滚动、复用和可见性；
/// 单条消息仍复用 SwiftUI 气泡实现，通过 `UIHostingConfiguration` 挂进 cell。
///
/// 旧实现是在 `UIScrollView` 里放一个 `UIHostingController(rootView: 全量消息 VStack)`。
/// 这会让 SwiftUI 为了计算完整 intrinsic height 一次性构建所有消息，屏幕外图片附件
/// 也会触发 `.task`。这里把“列表第 1 层”交给 UIKit 复用，避免屏幕外消息进场。
struct IMMessageListView<Footer: View>: View {
    let contentKey: IMMessageListContentKey
    /// 非消息数据变化但需要刷新可见 cell 的 UI 状态，比如多选状态。
    var renderVersion: String = ""
    var scrollToBottomToken: Int = 0
    var scrollToMessageRequest: IMMessageScrollRequest? = nil
    var earlierPrependToken: Int = 0
    var leadingSystemNotice: String? = nil
    var isLoadingEarlier: Bool = false
    var earlierLoadError: String? = nil
    var onLoadEarlier: () -> Void = {}
    var onRetryEarlier: () -> Void = {}
    var rowContent: (_ message: IMMessage, _ previousMessage: IMMessage?) -> AnyView
    var pendingContent: (_ pending: IMPendingMessage) -> AnyView
    var typingContent: () -> AnyView
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        IMChatCollectionView(
            contentKey: contentKey,
            renderVersion: renderVersion,
            scrollToBottomToken: scrollToBottomToken,
            scrollToMessageRequest: scrollToMessageRequest,
            earlierPrependToken: earlierPrependToken,
            leadingSystemNotice: leadingSystemNotice,
            onLoadEarlier: onLoadEarlier,
            rowContent: rowContent,
            pendingContent: pendingContent,
            typingContent: typingContent
        )
        // 会话切换时必须销毁旧的 UIKit 滚动控制器。否则新会话首帧可能沿用上一个
        // controller 的 contentOffset / content，造成旧位置或列表顶部短暂闪现。
        .id(contentKey.conversationId)
        .overlay(alignment: .top) {
            if isLoadingEarlier {
                ProgressView()
                    .controlSize(.small)
                    .padding(8)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.top, 8)
                    .transition(.opacity)
            } else if let earlierLoadError {
                IMEarlierHistoryRetryBanner(
                    message: earlierLoadError,
                    onRetry: onRetryEarlier
                )
                .padding(.horizontal, TTSpacing.lg)
                .padding(.top, TTSpacing.sm)
                .transition(.opacity)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer() }
    }
}

/// 驱动 UIKit 滚动层是否重建内容的判据（消息真变化才重测高，键盘/safeArea 无关重算跳过）。
struct IMMessageListContentKey: Equatable {
    let conversationId: String
    let messages: [IMMessage]
    let pending: [IMPendingMessage]
    let typingActive: Bool
    let peerReadWaterline: Int
    var initialHistoryReady: Bool = true
}

enum IMMessageListInitialScrollPolicy {
    static func hasRenderableContent(
        messageCount: Int,
        pendingCount: Int,
        typingActive: Bool
    ) -> Bool {
        messageCount > 0 || pendingCount > 0 || typingActive
    }
}

enum IMMessageListProjection {
    /// Diffable data source 要求 item identifier 全局唯一。保留首次出现的位置、采用
    /// 最后一次出现的权威内容，既不打乱时间线，也能让刷新态覆盖旧态。
    static func uniqueMessages(_ messages: [IMMessage]) -> [IMMessage] {
        var orderedIds: [Int] = []
        var latestById: [Int: IMMessage] = [:]
        for message in messages {
            if latestById[message.id] == nil {
                orderedIds.append(message.id)
            }
            latestById[message.id] = message
        }
        return orderedIds.compactMap { latestById[$0] }
    }

    static func uniquePending(_ pending: [IMPendingMessage]) -> [IMPendingMessage] {
        var orderedIds: [String] = []
        var latestById: [String: IMPendingMessage] = [:]
        for message in pending {
            if latestById[message.id] == nil {
                orderedIds.append(message.id)
            }
            latestById[message.id] = message
        }
        return orderedIds.compactMap { latestById[$0] }
    }
}

enum IMEarlierHistoryLoadPolicy {
    static func shouldRequest(
        hasScrollableContent: Bool,
        distanceFromTop: CGFloat,
        threshold: CGFloat,
        isUserInteracting: Bool,
        isArmed: Bool
    ) -> Bool {
        hasScrollableContent
            && distanceFromTop <= threshold
            && isUserInteracting
            && isArmed
    }
}

enum IMEarlierHistoryRetryPolicy {
    static func errorMessage(
        historyError: String?,
        messageCount: Int,
        hasMoreHistory: Bool,
        isLoadingHistory: Bool
    ) -> String? {
        guard messageCount > 0,
              hasMoreHistory,
              !isLoadingHistory,
              let historyError,
              !historyError.isEmpty else { return nil }
        return historyError
    }
}

private struct IMEarlierHistoryRetryBanner: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.tt.textCritical)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(2)
            Spacer(minLength: TTSpacing.sm)
            Button(L10n.Common.retry, action: onRetry)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }
}

struct IMMessageScrollRequest: Equatable {
    let messageId: Int
    let token: Int
}

// MARK: - UIViewControllerRepresentable

private struct IMChatCollectionView: UIViewControllerRepresentable {
    let contentKey: IMMessageListContentKey
    let renderVersion: String
    let scrollToBottomToken: Int
    let scrollToMessageRequest: IMMessageScrollRequest?
    let earlierPrependToken: Int
    let leadingSystemNotice: String?
    let onLoadEarlier: () -> Void
    let rowContent: (_ message: IMMessage, _ previousMessage: IMMessage?) -> AnyView
    let pendingContent: (_ pending: IMPendingMessage) -> AnyView
    let typingContent: () -> AnyView

    func makeUIViewController(context: Context) -> IMChatCollectionController {
        IMChatCollectionController(initiallyPinnedToBottom: true)
    }

    func updateUIViewController(_ controller: IMChatCollectionController, context: Context) {
        controller.onLoadEarlier = onLoadEarlier
        controller.update(
            contentKey: contentKey,
            renderVersion: renderVersion,
            rowContent: rowContent,
            pendingContent: pendingContent,
            typingContent: typingContent,
            scrollToBottomToken: scrollToBottomToken,
            scrollToMessageRequest: scrollToMessageRequest,
            earlierPrependToken: earlierPrependToken,
            leadingSystemNotice: leadingSystemNotice
        )
    }
}

// MARK: - Collection controller

/// IM 专用 UICollectionView 控制器：贴底 / 键盘 inset / 前插锚点 / 上拉加载。
final class IMChatCollectionController: UIViewController, UICollectionViewDelegate {
    private let collectionView: UICollectionView
    private var dataSource: UICollectionViewDiffableDataSource<Int, IMMessageListRow>!
    private var contentSizeObservation: NSKeyValueObservation?
    private var pinnedToBottom: Bool
    private var didInitialScroll = false
    private var hasRenderableInitialContent = false
    private var lastScrollToBottomToken = 0
    private var lastScrollToMessageRequest: IMMessageScrollRequest?
    private var lastEarlierPrependToken = 0
    private var renderedKey: IMMessageListContentKey?
    private var renderedVersion = ""
    private var renderedLeadingSystemNotice: String?
    private var pendingPrependAnchor: IMCollectionViewportAnchor?
    private var prependAnchorClearWorkItem: DispatchWorkItem?
    private var animatedBottomDeadline: Date = .distantPast
    private var suppressBottomAnimationUntil: Date = .distantPast
    private var lastBoundsHeight: CGFloat = 0
    private var isCoveredByNavigation = false
    private var navigationFrozenContentOffset: CGPoint?
    private var navigationViewportFreezeUntil: Date = .distantPast
    private var pendingCoveredNavigationUpdate: IMChatCoveredNavigationUpdate?
    private var earlierLoadArmed = true
    private let threshold: CGFloat = 40
    private let topLoadThreshold: CGFloat = 120

    private var rows: [IMMessageListRow] = []
    private var messages: [IMMessage] = []
    private var pendingMessages: [IMPendingMessage] = []
    private var rowContent: (_ message: IMMessage, _ previousMessage: IMMessage?) -> AnyView = { _, _ in AnyView(EmptyView()) }
    private var pendingContent: (_ pending: IMPendingMessage) -> AnyView = { _ in AnyView(EmptyView()) }
    private var typingContent: () -> AnyView = { AnyView(EmptyView()) }
    private var leadingSystemNotice: String?

    var onLoadEarlier: () -> Void = {}

    init(initiallyPinnedToBottom: Bool) {
        pinnedToBottom = initiallyPinnedToBottom

        collectionView = UICollectionView(frame: .zero, collectionViewLayout: Self.makeLayout())
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.backgroundColor = .clear
        collectionView.delegate = self
        collectionView.keyboardDismissMode = .onDrag
        collectionView.alwaysBounceVertical = true
        collectionView.contentInsetAdjustmentBehavior = .always
        collectionView.register(UICollectionViewCell.self, forCellWithReuseIdentifier: IMMessageHostingCell.reuseIdentifier)
        dataSource = UICollectionViewDiffableDataSource<Int, IMMessageListRow>(
            collectionView: collectionView
        ) { [weak self] collectionView, indexPath, row in
            self?.configuredCell(in: collectionView, at: indexPath, for: row)
        }
        view.addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tap.cancelsTouchesInView = false
        collectionView.addGestureRecognizer(tap)

        contentSizeObservation = collectionView.observe(\.contentSize, options: [.old, .new]) { [weak self] _, change in
            guard let self, change.oldValue?.height != change.newValue?.height else { return }
            MainActor.assumeIsolated {
                if !self.didInitialScroll {
                    self.finishInitialScrollIfReady()
                    return
                }
                if self.isCoveredByNavigation {
                    self.keepNavigationOffsetFrozenIfNeeded()
                    return
                }
                if Date() < self.navigationViewportFreezeUntil {
                    self.keepNavigationOffsetFrozenIfNeeded()
                    return
                }
                if self.restorePrependAnchorIfNeeded() {
                    return
                }
                self.maintainBottomIfPinned(immediately: true)
            }
        }
    }

    func update(
        contentKey: IMMessageListContentKey,
        renderVersion: String,
        rowContent: @escaping (_ message: IMMessage, _ previousMessage: IMMessage?) -> AnyView,
        pendingContent: @escaping (_ pending: IMPendingMessage) -> AnyView,
        typingContent: @escaping () -> AnyView,
        scrollToBottomToken: Int,
        scrollToMessageRequest: IMMessageScrollRequest?,
        earlierPrependToken: Int,
        leadingSystemNotice: String?
    ) {
        self.rowContent = rowContent
        self.pendingContent = pendingContent
        self.typingContent = typingContent
        self.leadingSystemNotice = leadingSystemNotice
        updateInitialRenderableState(for: contentKey, leadingSystemNotice: leadingSystemNotice)

        if isCoveredByNavigation {
            pendingCoveredNavigationUpdate = IMChatCoveredNavigationUpdate(
                contentKey: contentKey,
                renderVersion: renderVersion,
                scrollToBottomToken: scrollToBottomToken,
                scrollToMessageRequest: scrollToMessageRequest,
                earlierPrependToken: earlierPrependToken,
                leadingSystemNotice: leadingSystemNotice
            )
            keepNavigationOffsetFrozenIfNeeded()
            return
        }

        applyUpdate(
            contentKey: contentKey,
            renderVersion: renderVersion,
            scrollToBottomToken: scrollToBottomToken,
            scrollToMessageRequest: scrollToMessageRequest,
            earlierPrependToken: earlierPrependToken,
            leadingSystemNotice: leadingSystemNotice
        )
    }

    private func applyUpdate(
        contentKey: IMMessageListContentKey,
        renderVersion: String,
        scrollToBottomToken: Int,
        scrollToMessageRequest: IMMessageScrollRequest?,
        earlierPrependToken: Int,
        leadingSystemNotice: String?
    ) {
        let isEarlierPrepend = earlierPrependToken != lastEarlierPrependToken
        if isEarlierPrepend {
            lastEarlierPrependToken = earlierPrependToken
            pendingPrependAnchor = captureViewportAnchor()
            pinnedToBottom = false
        }

        if renderedKey != contentKey
            || renderedVersion != renderVersion
            || renderedLeadingSystemNotice != leadingSystemNotice {
            renderedKey = contentKey
            renderedVersion = renderVersion
            renderedLeadingSystemNotice = leadingSystemNotice
            messages = contentKey.initialHistoryReady
                ? IMMessageListProjection.uniqueMessages(contentKey.messages)
                : []
            pendingMessages = IMMessageListProjection.uniquePending(contentKey.pending)
            rows = Self.makeRows(
                messages: messages,
                pending: pendingMessages,
                typingActive: contentKey.typingActive,
                leadingSystemNotice: leadingSystemNotice
            )
            applySnapshot(preservingPrependAnchor: isEarlierPrepend)
        }

        if let scrollToMessageRequest,
           scrollToMessageRequest != lastScrollToMessageRequest {
            lastScrollToMessageRequest = scrollToMessageRequest
            pinnedToBottom = false
            clearPrependAnchor()
            scrollToMessage(id: scrollToMessageRequest.messageId)
        }

        guard scrollToBottomToken != lastScrollToBottomToken else { return }
        lastScrollToBottomToken = scrollToBottomToken
        pinnedToBottom = true
        clearPrependAnchor()
        suppressBottomAnimationUntil = .distantPast
        animatedBottomDeadline = Date().addingTimeInterval(0.4)
        maintainBottomIfPinned()
    }

    @objc private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
        )
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard collectionView.bounds.height > 0 else { return }
        let boundsChanged = collectionView.bounds.height != lastBoundsHeight
        lastBoundsHeight = collectionView.bounds.height

        if !didInitialScroll {
            finishInitialScrollIfReady()
            return
        }
        if isCoveredByNavigation {
            keepNavigationOffsetFrozenIfNeeded()
            return
        }
        if Date() < navigationViewportFreezeUntil {
            keepNavigationOffsetFrozenIfNeeded()
            return
        }
        if boundsChanged { maintainBottomIfPinned(immediately: true) }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        isCoveredByNavigation = true
        navigationFrozenContentOffset = collectionView.contentOffset
        navigationViewportFreezeUntil = .distantPast
        pinnedToBottom = false
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard isCoveredByNavigation else { return }
        isCoveredByNavigation = false
        navigationViewportFreezeUntil = Date().addingTimeInterval(0.45)
        UIView.performWithoutAnimation {
            let contentChanged = applyCoveredNavigationUpdateIfNeeded()
            if contentChanged {
                collectionView.collectionViewLayout.invalidateLayout()
                collectionView.layoutIfNeeded()
            }
            keepNavigationOffsetFrozenIfNeeded()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard navigationFrozenContentOffset != nil else { return }
        keepNavigationOffsetFrozenIfNeeded()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.keepNavigationOffsetFrozenIfNeeded()
            self.navigationFrozenContentOffset = nil
            self.navigationViewportFreezeUntil = .distantPast
        }
    }

    private func configuredCell(
        in collectionView: UICollectionView,
        at indexPath: IndexPath,
        for row: IMMessageListRow
    ) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: IMMessageHostingCell.reuseIdentifier,
            for: indexPath
        )
        cell.backgroundColor = .clear
        cell.contentView.backgroundColor = .clear

        cell.accessibilityIdentifier = row.accessibilityIdentifier
        cell.contentConfiguration = UIHostingConfiguration {
            rowView(for: row)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .margins(.all, 0)
        return cell
    }

    // MARK: UIScrollViewDelegate

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        clearPrependAnchor()
        dismissKeyboard()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let isUserInteracting = scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating
        guard isUserInteracting else { return }
        navigationViewportFreezeUntil = .distantPast
        navigationFrozenContentOffset = nil
        pinnedToBottom = distanceFromBottom <= threshold
        if distanceFromTop > topLoadThreshold {
            earlierLoadArmed = true
        } else if IMEarlierHistoryLoadPolicy.shouldRequest(
            hasScrollableContent: hasScrollableContent,
            distanceFromTop: distanceFromTop,
            threshold: topLoadThreshold,
            isUserInteracting: isUserInteracting,
            isArmed: earlierLoadArmed
        ) {
            earlierLoadArmed = false
            onLoadEarlier()
        }
    }

    func scrollViewDidChangeAdjustedContentInset(_ scrollView: UIScrollView) {
        if isCoveredByNavigation {
            keepNavigationOffsetFrozenIfNeeded()
            return
        }
        if Date() < navigationViewportFreezeUntil {
            keepNavigationOffsetFrozenIfNeeded()
            return
        }
        maintainBottomIfPinned(immediately: true)
    }

    // MARK: 贴底

    private var maxOffsetY: CGFloat {
        collectionView.contentSize.height + collectionView.adjustedContentInset.bottom - collectionView.bounds.height
    }

    private var distanceFromBottom: CGFloat {
        max(0, maxOffsetY - collectionView.contentOffset.y)
    }

    private var distanceFromTop: CGFloat {
        max(0, collectionView.contentOffset.y + collectionView.adjustedContentInset.top)
    }

    private var hasScrollableContent: Bool {
        collectionView.contentSize.height
            + collectionView.adjustedContentInset.top
            + collectionView.adjustedContentInset.bottom
            > collectionView.bounds.height + 1
    }

    private func maintainBottomIfPinned(immediately: Bool = false) {
        guard pinnedToBottom, !isCoveredByNavigation, Date() >= navigationViewportFreezeUntil else { return }
        let updateOffset = { [weak self] in
            guard let self else { return }
            let shouldAnimate = Date() < self.animatedBottomDeadline
                && Date() >= self.suppressBottomAnimationUntil
            self.setOffsetToBottom(animated: shouldAnimate)
        }
        if immediately {
            updateOffset()
        } else {
            DispatchQueue.main.async(execute: updateOffset)
        }
    }

    private func finishInitialScrollIfReady() {
        guard !didInitialScroll,
              hasRenderableInitialContent,
              collectionView.bounds.height > 0,
              !rows.isEmpty else { return }
        didInitialScroll = true
        suppressBottomAnimationUntil = Date().addingTimeInterval(1.0)
        if pinnedToBottom { setOffsetToBottom(animated: false) }
    }

    private func updateInitialRenderableState(
        for contentKey: IMMessageListContentKey,
        leadingSystemNotice: String? = nil
    ) {
        if !didInitialScroll && (
            leadingSystemNotice != nil || IMMessageListInitialScrollPolicy.hasRenderableContent(
               messageCount: contentKey.initialHistoryReady ? contentKey.messages.count : 0,
               pendingCount: contentKey.pending.count,
               typingActive: contentKey.typingActive
            )
        ) {
            hasRenderableInitialContent = true
        }
    }

    private func setOffsetToBottom(animated: Bool) {
        guard collectionView.bounds.height > 0, !rows.isEmpty else { return }
        collectionView.layoutIfNeeded()
        let lastIndex = rows.count - 1
        let indexPath = IndexPath(item: lastIndex, section: 0)
        collectionView.scrollToItem(at: indexPath, at: .bottom, animated: animated)
    }

    private func applyCoveredNavigationUpdateIfNeeded() -> Bool {
        guard let pending = pendingCoveredNavigationUpdate else { return false }
        pendingCoveredNavigationUpdate = nil
        updateInitialRenderableState(
            for: pending.contentKey,
            leadingSystemNotice: pending.leadingSystemNotice
        )
        var contentChanged = false

        if pending.earlierPrependToken != lastEarlierPrependToken {
            lastEarlierPrependToken = pending.earlierPrependToken
            clearPrependAnchor()
        }

        if renderedKey != pending.contentKey
            || renderedVersion != pending.renderVersion
            || renderedLeadingSystemNotice != pending.leadingSystemNotice {
            renderedKey = pending.contentKey
            renderedVersion = pending.renderVersion
            renderedLeadingSystemNotice = pending.leadingSystemNotice
            messages = pending.contentKey.initialHistoryReady ? pending.contentKey.messages : []
            pendingMessages = pending.contentKey.pending
            rows = Self.makeRows(
                messages: messages,
                pending: pendingMessages,
                typingActive: pending.contentKey.typingActive,
                leadingSystemNotice: pending.leadingSystemNotice
            )
            applySnapshot(preservingPrependAnchor: false)
            contentChanged = true
            if !didInitialScroll, hasRenderableInitialContent {
                finishInitialScrollIfReady()
            }
        }

        lastScrollToBottomToken = pending.scrollToBottomToken
        lastScrollToMessageRequest = pending.scrollToMessageRequest
        clearPrependAnchor()
        pinnedToBottom = false
        animatedBottomDeadline = .distantPast
        suppressBottomAnimationUntil = Date().addingTimeInterval(0.45)
        return contentChanged
    }

    private func keepNavigationOffsetFrozenIfNeeded() {
        guard let frozenOffset = navigationFrozenContentOffset,
              collectionView.bounds.height > 0,
              collectionView.contentSize.height > 0 else { return }
        let minY = -collectionView.adjustedContentInset.top
        let maxY = max(minY, maxOffsetY)
        let targetY = min(max(frozenOffset.y, minY), maxY)
        guard abs(targetY - collectionView.contentOffset.y) > 0.5 else { return }
        collectionView.setContentOffset(CGPoint(x: frozenOffset.x, y: targetY), animated: false)
    }

    private func scrollToMessage(id: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  let indexPath = self.dataSource.indexPath(for: .message(id: id))
            else { return }
            self.collectionView.scrollToItem(
                at: indexPath,
                at: .top,
                animated: true
            )
        }
    }

    private func applySnapshot(preservingPrependAnchor: Bool) {
        var snapshot = NSDiffableDataSourceSnapshot<Int, IMMessageListRow>()
        snapshot.appendSections([0])
        var seenRows = Set<IMMessageListRow>()
        let uniqueRows = rows.filter { seenRows.insert($0).inserted }
        snapshot.appendItems(uniqueRows, toSection: 0)

        let existingRows = Set(dataSource.snapshot().itemIdentifiers)
        let rowsToRefresh = uniqueRows.filter { existingRows.contains($0) }
        snapshot.reconfigureItems(rowsToRefresh)

        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            guard let self else { return }
            self.collectionView.layoutIfNeeded()
            if preservingPrependAnchor {
                _ = self.restorePrependAnchorIfNeeded()
            }
            if !self.didInitialScroll, self.hasRenderableInitialContent {
                self.finishInitialScrollIfReady()
            }
        }
    }

    private func captureViewportAnchor() -> IMCollectionViewportAnchor? {
        collectionView.layoutIfNeeded()
        let candidates = collectionView.indexPathsForVisibleItems.compactMap { indexPath -> IMCollectionViewportAnchor? in
            guard let row = dataSource.itemIdentifier(for: indexPath),
                  let attributes = collectionView.layoutAttributesForItem(at: indexPath)
            else { return nil }
            return IMCollectionViewportAnchor(
                row: row,
                viewportY: attributes.frame.minY - collectionView.contentOffset.y
            )
        }
        return candidates.min { lhs, rhs in
            abs(lhs.viewportY) < abs(rhs.viewportY)
        }
    }

    @discardableResult
    private func restorePrependAnchorIfNeeded() -> Bool {
        guard let anchor = pendingPrependAnchor,
              let indexPath = dataSource.indexPath(for: anchor.row)
        else { return false }
        collectionView.layoutIfNeeded()
        guard let attributes = collectionView.layoutAttributesForItem(at: indexPath) else { return false }

        let minY = -collectionView.adjustedContentInset.top
        let maxY = max(minY, maxOffsetY)
        let targetY = min(max(attributes.frame.minY - anchor.viewportY, minY), maxY)
        if abs(targetY - collectionView.contentOffset.y) > 0.5 {
            collectionView.setContentOffset(CGPoint(x: collectionView.contentOffset.x, y: targetY), animated: false)
        }
        schedulePrependAnchorClear()
        return true
    }

    private func schedulePrependAnchorClear() {
        prependAnchorClearWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.pendingPrependAnchor = nil
            self?.prependAnchorClearWorkItem = nil
        }
        prependAnchorClearWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: workItem)
    }

    private func clearPrependAnchor() {
        prependAnchorClearWorkItem?.cancel()
        prependAnchorClearWorkItem = nil
        pendingPrependAnchor = nil
    }

    private func rowView(for row: IMMessageListRow) -> AnyView {
        switch row {
        case .message(let id):
            guard let index = messages.firstIndex(where: { $0.id == id }) else {
                return AnyView(EmptyView())
            }
            let message = messages[index]
            let previous = index > 0 ? messages[index - 1] : nil
            return rowContent(message, previous)
        case .pending(let id):
            guard let pending = pendingMessages.first(where: { $0.id == id }) else {
                return AnyView(EmptyView())
            }
            return pendingContent(pending)
        case .typing:
            return typingContent()
        case .systemNotice:
            guard let leadingSystemNotice else { return AnyView(EmptyView()) }
            return AnyView(
                Text(leadingSystemNotice)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .accessibilityLabel(leadingSystemNotice)
            )
        }
    }

    static func makeRows(
        messages: [IMMessage],
        pending: [IMPendingMessage],
        typingActive: Bool,
        leadingSystemNotice: String? = nil
    ) -> [IMMessageListRow] {
        let orderedPending = pending.sorted { $0.createdAt < $1.createdAt }
        var pendingIndex = 0
        var rows: [IMMessageListRow] = []
        rows.reserveCapacity(messages.count + pending.count + (typingActive ? 1 : 0) + (leadingSystemNotice == nil ? 0 : 1))
        if leadingSystemNotice != nil { rows.append(.systemNotice) }

        for message in messages {
            if let messageDate = imParseTimestamp(message.createdAt) {
                while pendingIndex < orderedPending.count,
                      orderedPending[pendingIndex].createdAt <= messageDate {
                    rows.append(.pending(id: orderedPending[pendingIndex].id))
                    pendingIndex += 1
                }
            }
            rows.append(.message(id: message.id))
        }
        while pendingIndex < orderedPending.count {
            rows.append(.pending(id: orderedPending[pendingIndex].id))
            pendingIndex += 1
        }
        if typingActive { rows.append(.typing) }
        return rows
    }

    private static func makeLayout() -> UICollectionViewLayout {
        let itemSize = NSCollectionLayoutSize(
            widthDimension: .fractionalWidth(1.0),
            heightDimension: .estimated(44)
        )
        let item = NSCollectionLayoutItem(layoutSize: itemSize)
        let groupSize = NSCollectionLayoutSize(
            widthDimension: .fractionalWidth(1.0),
            heightDimension: .estimated(44)
        )
        let group = NSCollectionLayoutGroup.vertical(layoutSize: groupSize, subitems: [item])
        let section = NSCollectionLayoutSection(group: group)
        section.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0)
        section.interGroupSpacing = 0
        return UICollectionViewCompositionalLayout(section: section)
    }
}

enum IMMessageListRow: Hashable {
    case systemNotice
    case message(id: Int)
    case pending(id: String)
    case typing

    var accessibilityIdentifier: String {
        switch self {
        case .systemNotice:
            return "im-conversation-created-notice"
        case .message(let id):
            return "im-message-cell-\(id)"
        case .pending(let id):
            return "im-pending-cell-\(id)"
        case .typing:
            return "im-typing-cell"
        }
    }
}

private struct IMCollectionViewportAnchor {
    let row: IMMessageListRow
    let viewportY: CGFloat
}

private enum IMMessageHostingCell {
    static let reuseIdentifier = "IMMessageHostingCell"
}

private struct IMChatCoveredNavigationUpdate {
    let contentKey: IMMessageListContentKey
    let renderVersion: String
    let scrollToBottomToken: Int
    let scrollToMessageRequest: IMMessageScrollRequest?
    let earlierPrependToken: Int
    let leadingSystemNotice: String?
}


struct IMMessageAnchorView: UIViewRepresentable {
    let messageId: Int

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isAccessibilityElement = false
        view.accessibilityIdentifier = "im-message-anchor-\(messageId)"
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        uiView.accessibilityIdentifier = "im-message-anchor-\(messageId)"
    }
}

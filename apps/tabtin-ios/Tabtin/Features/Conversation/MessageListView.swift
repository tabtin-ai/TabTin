import SwiftUI
import UIKit

/// 消息间距：步骤组行本身已有触控高度，用 xs 避免「执行详情」连续行看起来像双倍行距。
private let messageListItemSpacing: CGFloat = TTSpacing.xs
/// regular 宽度下消息阅读列上限（与 draft 态 `maxWidth: 620` 同量级，略放宽到 680）。
private let messageReadingColumnMaxWidth: CGFloat = 680

private struct MessageListFooterHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// 消息列表：滚动容器 + 自动贴底 + 底部输入区。空态给引导文案。
///
/// **滚动层由 UICollectionView + Diffable Data Source 管理**：以 RenderUnit 为稳定行身份，
/// 单条消息仍由 SwiftUI 气泡渲染。UIKit 独占滚动 / 键盘 / 贴底，同时只构建可见 Cell，
/// 避免长会话一次性构建和重测整列 Markdown。
///
/// 输入区作为底部 overlay 悬浮在完整高度的消息列表上。实测 footer 高度同步给
/// `ChatScrollView.contentInset.bottom`，保证内容滚动时能经过玻璃下方、贴底时最后一条消息
/// 又能停在输入区上方；键盘避让仍由 SwiftUI 改变容器 bounds，贴底逻辑沿用同一条链路。
struct MessageListView<Footer: View>: View {
    let messages: [ChatMessage]
    /// 当前末条消息的引用型展示模型；纯文本 delta 只更新其正文叶子。
    var tipRowModel: MessageRowModel? = nil
    var tipRowLayoutRevision: Int = 0
    var agentOptions: [ComposerTaskAgentOption] = []
    var subagentRuns: [SubagentRun] = []
    /// 取消单个子 Agent（best-effort 上行 subagent.cancel）。
    var onCancelSubagent: (String) -> Void = { _ in }
    var onExecutePlan: (PlanProposal) async -> PlanExecutionResult = {
        _ in .failed("暂时无法执行，请重试。")
    }
    var onOpenPlan: (PlanProposal) -> Void = { _ in }
    var onApproveModeSwitch: (ModeSwitchProposal) -> Void = { _ in }
    var onIgnoreProposal: (String) -> Void = { _ in }
    var onRewind: (ChatMessage) -> Void = { _ in }
    var onRollbackAgentRun: (String) -> Void = { _ in }
    var editingMessageId: String?
    var isEditSubmitting: Bool = false
    var editError: String?
    var onCopyMessage: (ChatMessage) -> Void = { _ in }
    var onQuoteMessage: (ChatMessage) -> Void = { _ in }
    var onEditMessage: (ChatMessage) -> Void = { _ in }
    var onCancelEdit: () -> Void = {}
    var onSubmitEdit: (ChatMessage, String) -> Void = { _, _ in }
    var onForkMessage: (ChatMessage) -> Void = { _ in }
    var onErrorAction: (ChatErrorAction, ChatMessage) -> Void = { _, _ in }
    var isReadOnly: Bool = false
    var emptyStateText: String = "开始和 Agent 对话吧"
    /// 强制贴底令牌：每次自增即强制滚到底（无视当前是否在看历史），用于「发送消息后跳到底」。
    var scrollToBottomToken: Int = 0
    /// 外部入口要定位的列表 row id；消息窗口尚未加载时为 nil。
    var scrollTargetMessageId: String?
    /// 短暂高亮的列表 row id。
    var highlightedMessageId: String?
    /// 带消息锚点进入时禁止首帧默认贴底，等待目标窗口加载后再精确定位。
    var preventsInitialBottomScroll: Bool = false
    /// 正在上拉加载更早历史：顶部显示转圈（不进滚动内容，避免干扰锚点偏移计算）。
    var isLoadingEarlier: Bool = false
    /// 前插更早历史令牌：变化即记录可见 RenderUnit 锚点，Diffable 更新后恢复相对视口位置。
    var earlierPrependToken: Int = 0
    /// 滚动接近顶部时触发（加载更早历史）；防重入交给上层 isLoadingEarlier / hasMoreEarlier。
    var onLoadEarlier: () -> Void = {}
    /// 滚动态变化（去重后才发）：上层据此把 Composer 收成阅读态胶囊。
    var onScrollStateChange: (MessageListScrollState) -> Void = { _ in }
    /// 底部输入区（HITL 面板 + 输入栏）；作为悬浮 overlay 渲染。
    @ViewBuilder var footer: () -> Footer
    @State private var footerHeight: CGFloat = 0
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var visibleMessages: [ChatMessage] {
        messages.filter {
            !$0.isRedundantAgentSwitchNotice
                && !$0.shouldHidePushNotification
                && !$0.isTimelineTransparent
        }
    }

    /// 仅 regular 施加阅读宽度；compact 保持全宽以免小屏浪费。
    private var readingColumnMaxWidth: CGFloat? {
        horizontalSizeClass == .regular ? messageReadingColumnMaxWidth : nil
    }

    var body: some View {
        ChatScrollView(
            messages: visibleMessages,
            tipRowModel: tipRowModel,
            tipRowLayoutRevision: tipRowLayoutRevision,
            agentOptions: agentOptions,
            subagentRuns: subagentRuns,
            // footer 实测不含顶部羽化；可读重叠单独加上，避免末条消息被渐变吃掉。
            bottomContentInset: footerHeight + ComposerTopScrimMetrics.readableOverlap,
            readingColumnMaxWidth: readingColumnMaxWidth,
            onCancelSubagent: onCancelSubagent,
            onExecutePlan: onExecutePlan,
            onOpenPlan: onOpenPlan,
            onApproveModeSwitch: onApproveModeSwitch,
            onIgnoreProposal: onIgnoreProposal,
            onRewind: onRewind,
            onRollbackAgentRun: onRollbackAgentRun,
            editingMessageId: editingMessageId,
            isEditSubmitting: isEditSubmitting,
            editError: editError,
            onCopyMessage: onCopyMessage,
            onQuoteMessage: onQuoteMessage,
            onEditMessage: onEditMessage,
            onCancelEdit: onCancelEdit,
            onSubmitEdit: onSubmitEdit,
            onForkMessage: onForkMessage,
            onErrorAction: onErrorAction,
            isReadOnly: isReadOnly,
            scrollToBottomToken: scrollToBottomToken,
            scrollTargetMessageId: scrollTargetMessageId,
            highlightedMessageId: highlightedMessageId,
            preventsInitialBottomScroll: preventsInitialBottomScroll,
            earlierPrependToken: earlierPrependToken,
            onLoadEarlier: onLoadEarlier,
            onScrollStateChange: onScrollStateChange
        )
        .overlay(alignment: .top) {
            if isLoadingEarlier {
                ProgressView()
                    .controlSize(.small)
                    .padding(8)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.top, TTSpacing.sm)
                    .transition(.opacity)
            }
        }
        .overlay { if visibleMessages.isEmpty { emptyState } }
        .overlay(alignment: .bottom) {
            footer()
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: MessageListFooterHeightPreferenceKey.self,
                            value: proxy.size.height
                        )
                    }
                }
                .zIndex(1)
        }
        .onPreferenceChange(MessageListFooterHeightPreferenceKey.self) { height in
            guard abs(footerHeight - height) > 0.5 else { return }
            footerHeight = height
        }
    }

    private var emptyState: some View {
        VStack(spacing: TTSpacing.sm) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.tt.iconEmptyMD)
                .foregroundStyle(.tt.iconAccent.opacity(0.6))
            Text(emptyStateText)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
        }
    }
}

// MARK: - UICollectionView 承载层

/// UIKit CollectionView 负责滚动、复用和稳定身份；单个 RenderUnit 仍复用原 SwiftUI 视图。
private struct ChatScrollView: UIViewControllerRepresentable {
    let messages: [ChatMessage]
    let tipRowModel: MessageRowModel?
    let tipRowLayoutRevision: Int
    let agentOptions: [ComposerTaskAgentOption]
    let subagentRuns: [SubagentRun]
    let bottomContentInset: CGFloat
    let readingColumnMaxWidth: CGFloat?
    let onCancelSubagent: (String) -> Void
    let onExecutePlan: (PlanProposal) async -> PlanExecutionResult
    let onOpenPlan: (PlanProposal) -> Void
    let onApproveModeSwitch: (ModeSwitchProposal) -> Void
    let onIgnoreProposal: (String) -> Void
    let onRewind: (ChatMessage) -> Void
    let onRollbackAgentRun: (String) -> Void
    let editingMessageId: String?
    let isEditSubmitting: Bool
    let editError: String?
    let onCopyMessage: (ChatMessage) -> Void
    let onQuoteMessage: (ChatMessage) -> Void
    let onEditMessage: (ChatMessage) -> Void
    let onCancelEdit: () -> Void
    let onSubmitEdit: (ChatMessage, String) -> Void
    let onForkMessage: (ChatMessage) -> Void
    let onErrorAction: (ChatErrorAction, ChatMessage) -> Void
    let isReadOnly: Bool
    let scrollToBottomToken: Int
    let scrollTargetMessageId: String?
    let highlightedMessageId: String?
    let preventsInitialBottomScroll: Bool
    let earlierPrependToken: Int
    let onLoadEarlier: () -> Void
    let onScrollStateChange: (MessageListScrollState) -> Void

    func makeUIViewController(context: Context) -> ChatScrollController {
        ChatScrollController(initiallyPinnedToBottom: !preventsInitialBottomScroll)
    }

    func updateUIViewController(_ controller: ChatScrollController, context: Context) {
        controller.onLoadEarlier = onLoadEarlier
        controller.onScrollStateChange = onScrollStateChange
        controller.update(
            messages: messages,
            renderUnits: messageRenderUnits,
            agentOptions: agentOptions,
            subagentRuns: subagentRuns,
            hasLooseRuns: !unanchoredSubagentRuns().isEmpty,
            tipRowLayoutRevision: tipRowLayoutRevision,
            editingMessageId: editingMessageId,
            isEditSubmitting: isEditSubmitting,
            editError: editError,
            isReadOnly: isReadOnly,
            bottomContentInset: bottomContentInset,
            readingColumnMaxWidth: readingColumnMaxWidth,
            rowContent: { unit in AnyView(renderUnit(unit)) },
            looseRunsContent: { AnyView(looseRunsView) },
            scrollToBottomToken: scrollToBottomToken,
            scrollTargetMessageId: scrollTargetMessageId,
            highlightedMessageId: highlightedMessageId,
            earlierPrependToken: earlierPrependToken
        )
    }

    private var messageRenderUnits: [MessageListRenderUnit] {
        MessageListRenderUnit.group(messages)
    }

    @ViewBuilder
    private var looseRunsView: some View {
        let runs = unanchoredSubagentRuns()
        if !runs.isEmpty {
            SubagentInlineProgressSection(runs: runs, onCancelSubagent: onCancelSubagent)
        }
    }

    @ViewBuilder
    private func renderUnit(_ unit: MessageListRenderUnit) -> some View {
        switch unit {
        case let .single(message):
            if let tipRowModel, tipRowModel.id == message.id {
                MessageRowModelHost(model: tipRowModel) { structuralMessage, model in
                    AnyView(messageRow(structuralMessage, model: model))
                }
            } else {
                messageRow(message)
            }
        case let .stepGroup(groupedMessages):
            // 连续纯步骤子轮合成**一个** ExecutionGroupRow（抽屉），对齐 Electron
            // collapseConsecutiveToolCards；不再恢复  已删的「N 个步骤」内联折叠。
            if let tipRowModel, groupedMessages.contains(where: { $0.id == tipRowModel.id }) {
                MessageRowModelHost(model: tipRowModel) { _, model in
                    let live = groupedMessages.map { message in
                        message.id == model.id ? model.snapshot() : message
                    }
                    return AnyView(crossMessageExecutionGroup(live))
                }
            } else {
                crossMessageExecutionGroup(groupedMessages)
            }
        }
    }

    /// 跨消息步骤组：扁平化所有执行步骤 → 单一「执行详情 · N 步」。
    private func crossMessageExecutionGroup(_ messages: [ChatMessage]) -> some View {
        let stepBlocks = messages.flatMap(\.blocks).filter(ExecutionStepPresentation.isExecutionStep)
        let first = messages.first
        let last = messages.last
        let hideIdentity = first.map {
            MessageListSameTurnPolicy.shouldHideAgentIdentity(for: $0, in: self.messages)
        } ?? true
        let agent = first.flatMap(agentOption(for:))
        let awaitingPhase: AgentAwaitingThoughtPhase = {
            guard let last, last.isStreaming, last.errorMessage == nil else { return .hidden }
            return AgentAwaitingThoughtPresentation.resolvePhase(
                sessionPulseVisible: true,
                isLastAssistantMessage: true,
                blocks: messages.flatMap(\.blocks)
            )
        }()
        let isHighlighted = messages.contains { $0.id == highlightedMessageId }

        return VStack(alignment: .leading, spacing: messageListItemSpacing) {
            if let agent, !hideIdentity {
                HStack(spacing: TTSpacing.xs) {
                    AgentAvatar(option: agent, size: 22)
                    Text(agent.name)
                        .font(ConversationTypography.metaFont)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, TTSpacing.xxs)
            }

            if stepBlocks.count >= 2 {
                ExecutionGroupRow(blocks: stepBlocks)
            } else {
                ForEach(stepBlocks, id: \.id) { block in
                    ExecutionStepTimelineRow(block: block)
                }
            }

            switch awaitingPhase {
            case .pending:
                AwaitingThinkingView(mode: .thinking)
            case .planningNext:
                AwaitingThinkingView(mode: .planningNext)
            case .hidden:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, TTSpacing.xxl)
        .background(
            isHighlighted ? Color.tt.bgAccent.opacity(0.12) : Color.clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            if isHighlighted {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.tt.bgAccent.opacity(0.65), lineWidth: 1.5)
            }
        }
        .background {
            // 保留各子消息锚点，外部 scroll-to-message 仍可定位。
            ZStack {
                ForEach(messages, id: \.id) { message in
                    MessageAnchorMarker(messageId: message.id)
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: isHighlighted)
    }

    private func messageRow(_ message: ChatMessage, model: MessageRowModel? = nil) -> some View {
        let runs = anchoredSubagentRuns(for: message)
        let latestMessage = { model?.snapshot() ?? message }
        return VStack(alignment: .leading, spacing: messageListItemSpacing) {
            MessageBubbleView(
                message: message,
                textLeafModels: model?.textLeaves ?? [:],
                agentOption: agentOption(for: message),
                hideAgentIdentity: MessageListSameTurnPolicy.shouldHideAgentIdentity(
                    for: message,
                    in: messages
                ),
                subagentRuns: runs,
                formalMediaArtifactToolUseIds: formalMediaArtifactToolUseIds,
                onCancelSubagent: onCancelSubagent,
                onExecutePlan: onExecutePlan,
                onOpenPlan: onOpenPlan,
                onApproveModeSwitch: onApproveModeSwitch,
                onIgnoreProposal: onIgnoreProposal,
                onRewind: onRewind,
                onRollbackAgentRun: onRollbackAgentRun,
                isEditing: editingMessageId == message.id,
                isEditSubmitting: isEditSubmitting && editingMessageId == message.id,
                editError: editingMessageId == message.id ? editError : nil,
                onCopyMessage: { _ in onCopyMessage(latestMessage()) },
                onQuoteMessage: { _ in onQuoteMessage(latestMessage()) },
                onEditMessage: { _ in onEditMessage(latestMessage()) },
                onCancelEdit: onCancelEdit,
                onSubmitEdit: { _, text in onSubmitEdit(latestMessage(), text) },
                onForkMessage: { _ in onForkMessage(latestMessage()) },
                onErrorAction: { action, _ in onErrorAction(action, latestMessage()) },
                isReadOnly: isReadOnly
            )
            let trailingRuns = runsWithoutToolAnchor(runs, in: message)
            if !trailingRuns.isEmpty {
                SubagentInlineProgressSection(runs: trailingRuns, onCancelSubagent: onCancelSubagent)
                    .padding(.leading, TTSpacing.sm)
            }
        }
        .background(
            highlightedMessageId == message.id ? Color.tt.bgAccent.opacity(0.12) : Color.clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            if highlightedMessageId == message.id {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.tt.bgAccent.opacity(0.65), lineWidth: 1.5)
            }
        }
        .background(MessageAnchorMarker(messageId: message.id))
        .animation(.easeOut(duration: 0.2), value: highlightedMessageId == message.id)
    }

    private var formalMediaArtifactToolUseIds: Set<String> {
        Set(messages.flatMap { message in
            message.blocks.compactMap { block -> String? in
                guard case let .richContent(rich) = block,
                      rich.kind == "image",
                      rich.fileId != nil else { return nil }
                return rich.sourceToolUseId
            }
        })
    }

    private func agentOption(for message: ChatMessage) -> ComposerTaskAgentOption? {
        guard message.role == .assistant,
              let agentId = message.agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !agentId.isEmpty else { return nil }
        return agentOptions.first(where: { $0.id == agentId })
            ?? ComposerTaskAgentOption(id: agentId, name: "Agent")
    }

    private func anchoredSubagentRuns(for message: ChatMessage) -> [SubagentRun] {
        let toolIds = Set(message.toolCalls.map(\.toolCallId))
        let messageIds = message.identityKeys
        return subagentRuns.filter { run in
            if let parentToolCallId = run.parentToolCallId, !parentToolCallId.isEmpty,
               toolIds.contains(parentToolCallId) {
                return true
            }
            if let parentMessageId = run.parentMessageId, !parentMessageId.isEmpty,
               messageIds.contains(parentMessageId) {
                return true
            }
            return false
        }
    }

    private func unanchoredSubagentRuns() -> [SubagentRun] {
        let allToolIds = Set(messages.flatMap { $0.toolCalls.map(\.toolCallId) })
        let allMessageIds = Set(messages.flatMap { message in Array(message.identityKeys) })
        return subagentRuns.filter { run in
            if let parentToolCallId = run.parentToolCallId, !parentToolCallId.isEmpty,
               allToolIds.contains(parentToolCallId) {
                return false
            }
            if let parentMessageId = run.parentMessageId, !parentMessageId.isEmpty,
               allMessageIds.contains(parentMessageId) {
                return false
            }
            return true
        }
    }

    private func runsWithoutToolAnchor(_ runs: [SubagentRun], in message: ChatMessage) -> [SubagentRun] {
        let toolIds = Set(message.toolCalls.map(\.toolCallId))
        return runs.filter { run in
            guard let parentToolCallId = run.parentToolCallId, !parentToolCallId.isEmpty else {
                return true
            }
            return !toolIds.contains(parentToolCallId)
        }
    }
}

/// SwiftUI 消息行在 UIKit 承载树中的可定位锚点。
private struct MessageAnchorMarker: UIViewRepresentable {
    let messageId: String

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.accessibilityIdentifier = Self.identifier(for: messageId)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        view.accessibilityIdentifier = Self.identifier(for: messageId)
    }

    static func identifier(for messageId: String) -> String {
        "chat-message-anchor-\(messageId)"
    }
}

/// 只观察行模型的结构快照与叶子字典。正文字符串由字典里的叶子模型自行观察，
/// 因而文本增长不会让本行气泡壳重新求值。
private struct MessageRowModelHost: View {
    @Bindable var model: MessageRowModel
    let content: (ChatMessage, MessageRowModel) -> AnyView

    var body: some View {
        content(model.structuralMessage, model)
    }
}

enum MessageListRenderUnit: Identifiable, Equatable {
    case single(ChatMessage)
    /// 连续纯步骤子轮；渲染为单一 `ExecutionGroupRow`（不是旧 CrossMessageStepGroup）。
    case stepGroup([ChatMessage])

    var id: MessageListRenderUnitID {
        switch self {
        case let .single(message):
            return .message(message.id)
        case let .stepGroup(messages):
            return .stepGroup(messages.map(\.id))
        }
    }

    /// 消息内折叠由 `AssistantTimelineUnit` 负责；此处把**连续**纯步骤子轮合成一个单元，
    /// 避免时间线上出现多个「执行详情 · N 步」锚点（对齐 Electron 连续工具卡折叠）。
    static func group(_ messages: [ChatMessage]) -> [MessageListRenderUnit] {
        var units: [MessageListRenderUnit] = []
        var index = 0

        while index < messages.count {
            let message = messages[index]
            guard message.isCrossMessageStepOnly else {
                units.append(.single(message))
                index += 1
                continue
            }

            var end = index + 1
            while end < messages.count, messages[end].isCrossMessageStepOnly {
                end += 1
            }

            let run = Array(messages[index..<end])
            // 两条及以上连续纯步骤子轮才跨消息合成；单条子轮仍走 MessageBubbleView
            //（其内部 AssistantTimelineUnit 已按 ≥2 步收成执行组）。
            if run.count > 1 {
                units.append(.stepGroup(run))
            } else {
                units.append(contentsOf: run.map { .single($0) })
            }
            index = end
        }

        return units
    }

}

/// Diffable Data Source 只使用不变的视觉单元身份，不把可变 ChatMessage 快照当 ID。
enum MessageListRenderUnitID: Hashable {
    case message(String)
    case stepGroup([String])

    var messageIDs: [String] {
        switch self {
        case let .message(id): [id]
        case let .stepGroup(ids): ids
        }
    }
}

extension ChatMessage {
    /// 可并入跨消息执行组：无正文 / 提案 / 错误，且至少有一步思考或普通工具。
    ///
    /// `checkpointRecord` 只是回退锚点元数据（历史接口每条 assistant 都会带），
    /// 不能当成分组边界——否则长链路每个工具各占一条消息，永远铺不开。
    var isCrossMessageStepOnly: Bool {
        guard role == .assistant,
              planProposal == nil,
              modeSwitchProposal == nil,
              errorMessage == nil else {
            return false
        }
        let stepCount = blocks.reduce(0) { count, block in
            count + (ExecutionStepPresentation.isExecutionStep(block) ? 1 : 0)
        }
        guard stepCount > 0 else { return false }
        return blocks.allSatisfy { block in
            ExecutionStepPresentation.isExecutionStep(block)
                || AgentAwaitingThoughtPresentation.isInertWhitespaceText(block)
        }
    }

    /// 时间线透明壳：无提案 / 错误 / checkpoint，且无可视块（含仅 turn_identity）。
    /// 流式占位气泡保留；历史空壳与合成 tool_result carrier 必须剔除，否则会切开「执行详情」。
    var isTimelineTransparent: Bool {
        if isStreaming { return false }
        guard planProposal == nil,
              modeSwitchProposal == nil,
              errorMessage == nil,
              checkpointRecord == nil else {
            return false
        }
        if role == .system,
           !isCompactionSummary,
           !CompactionSummaryPresentation.isInProgressPlaceholder(self) {
            // SystemNotice 只展示正文。缓存或旧历史里即使残留富内容块，正文为空时
            // 也必须整行透明，否则会退化成一个孤立的 info 图标。
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if blocks.isEmpty { return true }
        return blocks.allSatisfy {
            AgentAwaitingThoughtPresentation.isInertWhitespaceText($0)
        }
    }
}

// MARK: - Subagent inline progress

private struct SubagentInlineProgressSection: View {
    let runs: [SubagentRun]
    var onCancelSubagent: (String) -> Void = { _ in }

    private var sortedRuns: [SubagentRun] {
        runs.sorted {
            ($0.startedAt ?? $0.endedAt ?? 0) < ($1.startedAt ?? $1.endedAt ?? 0)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: "person.2")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.iconAccent)
                Text("子 Agent")
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textSecondary)
                Text("\(runs.count)")
                    .font(.tt.codeXS)
                    .foregroundStyle(.tt.textTertiary)
            }
            ForEach(sortedRuns) { run in
                SubagentInlineProgressCard(run: run, onCancel: { onCancelSubagent(run.runId) })
            }
        }
        .padding(.trailing, TTSpacing.xxl)
    }
}

private struct SubagentInlineProgressCard: View {
    let run: SubagentRun
    var onCancel: (() -> Void)? = nil
    @State private var isExpanded = false
    @State private var showDetail = false
    /// 本地「尝试停止」态：上行没有 ACK，只有 cancelled 终态回流后才能确认已取消。
    @State private var isCancelling = false

    /// 活跃态（未达终态）才可取消：pending / queued / running。
    private var showsCancelControl: Bool {
        guard onCancel != nil else { return false }
        return run.status == .pending || run.status == .queued || run.status == .running
    }

    private var presentation: SubagentRunPresentation {
        SubagentPresentationPolicy.presentation(for: run, cancellationRequested: isCancelling)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: TTSpacing.sm) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: TTSpacing.sm) {
                        statusIcon
                            .frame(width: 18, height: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(run.displayTitle)
                                .font(.tt.metaSemibold)
                                .foregroundStyle(.tt.textPrimary)
                                .lineLimit(1)
                            if let hint = subtitle {
                                Text(hint)
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textTertiary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                        if let durationMs = run.durationMs, durationMs > 0 {
                            Label(formatElapsed(durationMs), systemImage: "clock")
                                .font(.tt.codeXS)
                                .foregroundStyle(.tt.textTertiary)
                        }
                        statusBadge
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if showsCancelControl {
                    stopButton
                }
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm)

            if run.status == .running || run.status == .pending {
                progressBar
            }

            if isExpanded {
                details
                    .padding(.horizontal, TTSpacing.md)
                    .padding(.bottom, TTSpacing.sm)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.md).strokeBorder(border, lineWidth: 0.5))
        .onChange(of: run.status) { _, status in
            if status.isTerminal { isCancelling = false }
        }
        .sheet(isPresented: $showDetail) {
            SubagentDetailSheet(run: run)
        }
    }

    @ViewBuilder
    private var stopButton: some View {
        Button {
            guard !isCancelling else { return }
            isCancelling = true
            onCancel?()
        } label: {
            if isCancelling {
                Text(presentation.cancelLabel ?? "尝试停止中")
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textTertiary)
            } else {
                Image(systemName: "stop.circle")
                    .font(.tt.iconBody)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
        .buttonStyle(.plain)
        .disabled(!presentation.canRequestCancel)
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel(
            isCancelling
                ? "正在尝试停止子 Agent：\(run.displayTitle)"
                : "停止子 Agent：\(run.displayTitle)"
        )
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch run.status {
        case .pending, .running:
            ProgressView().controlSize(.mini)
        case .queued:
            Image(systemName: "clock")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textTertiary)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textSuccess)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textCritical)
        case .cancelled:
            Image(systemName: "stop.circle.fill")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textTertiary)
        }
    }

    private var statusBadge: some View {
        Text(statusLabel)
            .font(.tt.captionSemibold)
            .foregroundStyle(statusColor)
            .padding(.horizontal, TTSpacing.xs)
            .padding(.vertical, 2)
            .background(statusColor.opacity(0.12), in: Capsule())
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle().fill(.tt.borderLight.opacity(0.35))
                Rectangle()
                    .fill(.tt.iconAccent)
                    .frame(width: geo.size.width * 0.32)
                    .opacity(0.8)
            }
        }
        .frame(height: 2)
    }

    @ViewBuilder
    private var details: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Divider().overlay(.tt.borderLight)
            if let task = run.task, !task.isEmpty, task != run.label {
                detailBlock(title: "任务", text: task, color: .tt.textPrimary)
            }
            if let latestProgress = presentation.latestProgress {
                detailBlock(title: "最新进展", text: latestProgress, color: .tt.textPrimary)
            }
            if let conclusion = presentation.terminalConclusion {
                detailBlock(
                    title: run.status == .completed ? "结果摘要" : "终态结论",
                    text: conclusion,
                    color: run.status == .failed ? .tt.textCritical : .tt.textPrimary
                )
            } else if let summary = run.summary, !summary.isEmpty {
                detailBlock(title: "最新进展", text: summary, color: .tt.textPrimary)
            }
            if let guidance = presentation.failureGuidance {
                detailBlock(title: "后续操作", text: guidance, color: .tt.textSecondary)
            }
            detailBlock(title: "执行证据", text: presentation.evidenceSummary, color: .tt.textSecondary)
            if !run.transcript.isEmpty {
                SubagentEvidencePreview(items: Array(run.transcript.suffix(2)))
            }
            if let stats = run.stats, !stats.isEmpty {
                statsLine(stats)
            }
            let streamSteps = SubagentDetailSectioning.sections(for: run).steps
            if !streamSteps.isEmpty {
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    Text("执行步骤 (\(streamSteps.count))")
                        .font(.tt.captionSemibold)
                        .foregroundStyle(.tt.textSecondary)
                    VStack(alignment: .leading, spacing: TTSpacing.xs) {
                        ForEach(Array(streamSteps.enumerated()), id: \.element.id) { index, item in
                            Text("\(index + 1). \(item.title ?? item.kind.rawValue)")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textSecondary)
                        }
                    }
                }
            }
            Button {
                showDetail = true
            } label: {
                Label("查看完整记录", systemImage: "doc.text.magnifyingglass")
                    .font(.tt.metaSemibold)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tt.textAccent)
            .accessibilityHint("打开子 Agent 的完整执行流与工具记录")
        }
    }

    private func detailBlock(title: String, text: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            Text(title)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
            Text(text)
                .font(.tt.meta)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
                .copyOnLongPress(text)
        }
    }

    @ViewBuilder
    private func statsLine(_ stats: SubagentRunStats) -> some View {
        HStack(spacing: TTSpacing.sm) {
            if let total = stats.totalTokens {
                Text("总 token \(total)")
            }
            if let input = stats.inputTokens {
                Text("输入 \(input)")
            }
            if let output = stats.outputTokens {
                Text("输出 \(output)")
            }
            if let credits = stats.creditsConsumed, credits > 0 {
                Text("消耗 \(formatCredits(credits)) 点")
            }
        }
        .font(.tt.caption)
        .foregroundStyle(.tt.textTertiary)
        .lineLimit(1)
    }

    private func formatCredits(_ value: Double) -> String {
        if value == value.rounded(), value < 10000 { return String(format: "%.0f", value) }
        if value < 1 { return String(format: "%.3f", value) }
        return String(format: "%.1f", value)
    }

    private var subtitle: String? {
        presentation.subtitle
    }

    private var statusLabel: String {
        presentation.statusLabel
    }

    private var statusColor: Color {
        switch run.status {
        case .pending, .running: return .tt.iconAccent
        case .queued: return .tt.textTertiary
        case .completed: return .tt.textSuccess
        case .failed: return .tt.textCritical
        case .cancelled: return .tt.textTertiary
        }
    }

    private var background: Color {
        run.status == .failed ? .tt.bgCritical.opacity(0.08) : .tt.bgSubtle
    }

    private var border: Color {
        run.status == .failed ? .tt.textCritical.opacity(0.3) : .tt.borderLight
    }

    private func formatElapsed(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let seconds = Double(ms) / 1000
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        return String(format: "%.0fm%.0fs", (seconds / 60).rounded(.down), seconds.truncatingRemainder(dividingBy: 60))
    }
}

/// 终态卡片直接露出最近两条执行流，避免用户只能相信“完成/失败”结论而找不到证据。
private struct SubagentEvidencePreview: View {
    let items: [SubagentTranscriptItem]

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            Text("最近执行流")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
            ForEach(items) { item in
                HStack(alignment: .top, spacing: TTSpacing.xs) {
                    Image(systemName: icon(for: item))
                        .font(.tt.iconCaption)
                        .foregroundStyle(item.isError ? .tt.textCritical : .tt.textTertiary)
                        .frame(width: 14)
                    Text(item.title ?? item.text ?? label(for: item))
                        .font(.tt.caption)
                        .foregroundStyle(item.isError ? .tt.textCritical : .tt.textSecondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(TTSpacing.xs)
        .background(.tt.bgSubtleSecondary, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private func label(for item: SubagentTranscriptItem) -> String {
        switch item.kind {
        case .assistant: return "子 Agent 回复"
        case .thinking: return "子 Agent 思考"
        case .tool: return "工具调用"
        case .richContent: return "生成内容"
        case .contextRef: return "上下文引用"
        case .system: return "系统事件"
        case .error: return "错误"
        }
    }

    private func icon(for item: SubagentTranscriptItem) -> String {
        switch item.kind {
        case .assistant: return "sparkles"
        case .thinking: return "brain"
        case .tool: return "wrench.and.screwdriver"
        case .richContent: return "rectangle.3.group"
        case .contextRef: return "square.grid.2x2"
        case .system: return "info.circle"
        case .error: return "exclamationmark.triangle.fill"
        }
    }
}

private struct SubagentInlineToolStepRow: View {
    let index: Int
    let step: SubagentToolStep
    @State private var expanded = false

    private var hasDetail: Bool {
        step.inputDetail?.isEmpty == false
            || step.outputDetail?.isEmpty == false
            || step.error?.isEmpty == false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            Button {
                guard hasDetail else { return }
                withAnimation(.easeInOut(duration: 0.15)) {
                    expanded.toggle()
                }
            } label: {
                HStack(alignment: .top, spacing: TTSpacing.xs) {
                    Image(systemName: step.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .font(.tt.iconCaption)
                        .foregroundStyle(step.success ? .tt.textSuccess : .tt.textCritical)
                        .padding(.top, 1)
                    Text("\(index)")
                        .font(.tt.codeXS)
                        .foregroundStyle(.tt.textTertiary)
                        .frame(width: 16, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: TTSpacing.xs) {
                            Text(step.toolName)
                                .font(.tt.captionSemibold)
                                .foregroundStyle(step.success ? .tt.textPrimary : .tt.textCritical)
                                .lineLimit(1)
                            if let elapsedMs = step.elapsedMs, elapsedMs > 0 {
                                Text(formatElapsed(elapsedMs))
                                    .font(.tt.codeXS)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                        }
                        if let summary = preferredSummary, !summary.isEmpty {
                            Text(summary)
                                .font(.tt.codeXS)
                                .foregroundStyle(step.success ? .tt.textSecondary : .tt.textCritical.opacity(0.8))
                                .lineLimit(2)
                                .copyOnLongPress(summary)
                        }
                    }
                    Spacer(minLength: 0)
                    if hasDetail {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                            .padding(.top, 3)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(!hasDetail)

            if expanded, hasDetail {
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    if let error = step.error, !error.isEmpty {
                        detailBlock(title: "错误", text: error, color: .tt.textCritical)
                    }
                    if let input = step.inputDetail, !input.isEmpty {
                        detailBlock(title: "输入", text: input, color: .tt.textPrimary)
                    }
                    if let output = step.outputDetail, !output.isEmpty {
                        detailBlock(title: "输出", text: output, color: .tt.textPrimary)
                    }
                }
                .padding(.leading, 32)
            }
        }
    }

    private var preferredSummary: String? {
        if let error = step.error, !step.success, !error.isEmpty { return error }
        if let output = step.outputSummary, !output.isEmpty { return output }
        return step.inputSummary
    }

    private func detailBlock(title: String, text: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
            ScrollView {
                Text(text)
                    .font(.tt.codeXS)
                    .foregroundStyle(color)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 120)
            .padding(TTSpacing.xs)
            .background(.tt.bgCanvasDefault, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        }
    }

    private func formatElapsed(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let seconds = Double(ms) / 1000
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        return String(format: "%.0fm%.0fs", (seconds / 60).rounded(.down), seconds.truncatingRemainder(dividingBy: 60))
    }
}

/// Agent 聊天滚动控制器：UICollectionView + Diffable Data Source。
/// 贴底策略：
///   - `contentSize` 变（新消息 / 流式 / 历史）→ 若停在底部则贴底。
///   - `adjustedContentInset` 变（键盘弹 / 收）→ 若停在底部则贴底（delegate 回调）。
///   - 「是否停在底部」只在**用户真实拖动**（`scrollViewDidScroll` 且 isTracking/Dragging/Decelerating）
///     时更新——键盘 / 程序滚动不污染它，故键盘弹起用键盘前的判定，距离由真实 inset 精确得出。
final class ChatScrollController: UIViewController, UICollectionViewDelegate {
    private let collectionView: UICollectionView
    private var dataSource: UICollectionViewDiffableDataSource<Int, MessageListCollectionRow>!
    private var contentSizeObservation: NSKeyValueObservation?
    private var pinnedToBottom: Bool
    private var didInitialScroll = false
    private var lastScrollToBottomToken = 0
    private var lastScrollTargetMessageId: String?
    private var pendingScrollTargetMessageId: String?
    var onLoadEarlier: () -> Void = {}
    var onScrollStateChange: (MessageListScrollState) -> Void = { _ in }
    private var lastPublishedScrollState = MessageListScrollState.settledAtBottom
    private let topLoadThreshold: CGFloat = 120
    private var lastEarlierPrependToken = 0
    private var renderedMessages: [ChatMessage] = []
    private var renderedUnits: [MessageListRenderUnit] = []
    private var renderedAgentOptions: [ComposerTaskAgentOption] = []
    private var renderedSubagentRuns: [SubagentRun] = []
    private var renderedHasLooseRuns = false
    private var renderedEditingMessageId: String?
    private var renderedIsEditSubmitting = false
    private var renderedEditError: String?
    private var renderedIsReadOnly = false
    private var renderedHighlightedMessageId: String?
    private var renderedReadingColumnMaxWidth: CGFloat?
    private var lastTipRowLayoutRevision = 0
    private var hasRenderedOnce = false
    private var unitsByID: [MessageListRenderUnitID: MessageListRenderUnit] = [:]
    private var hasLooseRuns = false
    private var rowContent: (MessageListRenderUnit) -> AnyView = { _ in AnyView(EmptyView()) }
    private var looseRunsContent: () -> AnyView = { AnyView(EmptyView()) }
    private var pendingPrependAnchor: MessageListViewportAnchor?
    private var prependAnchorClearWorkItem: DispatchWorkItem?
    private var animatedBottomDeadline: Date = .distantPast
    private var lastBoundsHeight: CGFloat = 0
    private let threshold: CGFloat = 40

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
        collectionView.register(
            UICollectionViewCell.self,
            forCellWithReuseIdentifier: MessageListHostingCell.reuseIdentifier
        )
        dataSource = UICollectionViewDiffableDataSource<Int, MessageListCollectionRow>(
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
                if self.restorePrependAnchorIfNeeded() { return }
                if self.attemptScrollToPendingMessage() { return }
                self.maintainBottomIfPinned(immediately: true)
            }
        }
    }

    func update(
        messages: [ChatMessage],
        renderUnits: [MessageListRenderUnit],
        agentOptions: [ComposerTaskAgentOption],
        subagentRuns: [SubagentRun],
        hasLooseRuns: Bool,
        tipRowLayoutRevision: Int,
        editingMessageId: String?,
        isEditSubmitting: Bool,
        editError: String?,
        isReadOnly: Bool,
        bottomContentInset: CGFloat,
        readingColumnMaxWidth: CGFloat?,
        rowContent: @escaping (MessageListRenderUnit) -> AnyView,
        looseRunsContent: @escaping () -> AnyView,
        scrollToBottomToken: Int,
        scrollTargetMessageId: String?,
        highlightedMessageId: String?,
        earlierPrependToken: Int
    ) {
        self.rowContent = rowContent
        self.looseRunsContent = looseRunsContent
        let resolvedBottomInset = max(0, bottomContentInset)
        if abs(collectionView.contentInset.bottom - resolvedBottomInset) > 0.5 {
            collectionView.contentInset.bottom = resolvedBottomInset
            collectionView.verticalScrollIndicatorInsets.bottom = resolvedBottomInset
        }

        let isEarlierPrepend = earlierPrependToken != lastEarlierPrependToken
        if isEarlierPrepend {
            lastEarlierPrependToken = earlierPrependToken
            pendingPrependAnchor = captureViewportAnchor()
            pinnedToBottom = false
        }

        let metadataChanged = !hasRenderedOnce
            || agentOptions != renderedAgentOptions
            || subagentRuns != renderedSubagentRuns
            || hasLooseRuns != renderedHasLooseRuns
            || editingMessageId != renderedEditingMessageId
            || isEditSubmitting != renderedIsEditSubmitting
            || editError != renderedEditError
            || isReadOnly != renderedIsReadOnly
            || highlightedMessageId != renderedHighlightedMessageId
            || readingColumnMaxWidth != renderedReadingColumnMaxWidth

        if metadataChanged || messages != renderedMessages || renderUnits.map(\.id) != renderedUnits.map(\.id) {
            applyCollectionUpdate(
                messages: messages,
                renderUnits: renderUnits,
                agentOptions: agentOptions,
                subagentRuns: subagentRuns,
                hasLooseRuns: hasLooseRuns,
                editingMessageId: editingMessageId,
                isEditSubmitting: isEditSubmitting,
                editError: editError,
                isReadOnly: isReadOnly,
                highlightedMessageId: highlightedMessageId,
                readingColumnMaxWidth: readingColumnMaxWidth,
                refreshAllExistingRows: metadataChanged,
                preservingPrependAnchor: isEarlierPrepend
            )
        } else {
            PerfTrace.mark("collectionVC.skip")
        }

        if tipRowLayoutRevision != lastTipRowLayoutRevision {
            lastTipRowLayoutRevision = tipRowLayoutRevision
            invalidateTipRowLayout()
        }

        if scrollTargetMessageId != lastScrollTargetMessageId {
            lastScrollTargetMessageId = scrollTargetMessageId
            pendingScrollTargetMessageId = scrollTargetMessageId
            if scrollTargetMessageId != nil {
                pinnedToBottom = false
                clearPrependAnchor()
                DispatchQueue.main.async { [weak self] in
                    _ = self?.attemptScrollToPendingMessage()
                }
            }
        }
        guard scrollToBottomToken != lastScrollToBottomToken else { return }
        lastScrollToBottomToken = scrollToBottomToken
        pinnedToBottom = true
        clearPrependAnchor()
        animatedBottomDeadline = Date().addingTimeInterval(0.4)
        maintainBottomIfPinned()
    }

    private func applyCollectionUpdate(
        messages: [ChatMessage],
        renderUnits: [MessageListRenderUnit],
        agentOptions: [ComposerTaskAgentOption],
        subagentRuns: [SubagentRun],
        hasLooseRuns: Bool,
        editingMessageId: String?,
        isEditSubmitting: Bool,
        editError: String?,
        isReadOnly: Bool,
        highlightedMessageId: String?,
        readingColumnMaxWidth: CGFloat?,
        refreshAllExistingRows: Bool,
        preservingPrependAnchor: Bool
    ) {
        let previousUnits = Dictionary(uniqueKeysWithValues: renderedUnits.map { ($0.id, $0) })
        let previousSubagentRuns = renderedSubagentRuns
        hasRenderedOnce = true
        renderedMessages = messages
        renderedUnits = renderUnits
        renderedAgentOptions = agentOptions
        renderedSubagentRuns = subagentRuns
        renderedHasLooseRuns = hasLooseRuns
        renderedEditingMessageId = editingMessageId
        renderedIsEditSubmitting = isEditSubmitting
        renderedEditError = editError
        renderedIsReadOnly = isReadOnly
        renderedHighlightedMessageId = highlightedMessageId
        renderedReadingColumnMaxWidth = readingColumnMaxWidth
        unitsByID = Dictionary(uniqueKeysWithValues: renderUnits.map { ($0.id, $0) })
        self.hasLooseRuns = hasLooseRuns

        var rows = renderUnits.map { MessageListCollectionRow.unit($0.id) }
        if hasLooseRuns { rows.append(.looseSubagents) }
        var snapshot = NSDiffableDataSourceSnapshot<Int, MessageListCollectionRow>()
        snapshot.appendSections([0])
        snapshot.appendItems(rows, toSection: 0)

        let existingRows = Set(dataSource.snapshot().itemIdentifiers)
        let changedRows = rows.filter { row in
            guard existingRows.contains(row) else { return false }
            if refreshAllExistingRows { return true }
            switch row {
            case let .unit(id):
                return previousUnits[id] != unitsByID[id]
            case .looseSubagents:
                return previousSubagentRuns != subagentRuns
            }
        }
        snapshot.reconfigureItems(changedRows)

        PerfTrace.mark("collectionVC.apply(\(messages.count),units=\(renderUnits.count))")
        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            guard let self else { return }
            self.collectionView.layoutIfNeeded()
            if preservingPrependAnchor { _ = self.restorePrependAnchorIfNeeded() }
            if !self.didInitialScroll { self.finishInitialScrollIfReady() }
            if self.attemptScrollToPendingMessage() { return }
            self.maintainBottomIfPinned(immediately: true)
        }
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
        if !didInitialScroll { finishInitialScrollIfReady() }
        if restorePrependAnchorIfNeeded() { return }
        if boundsChanged { maintainBottomIfPinned(immediately: true) }
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        clearPrependAnchor()
        dismissKeyboard()
        publishScrollState(isUserScrolling: true)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating else { return }
        pinnedToBottom = distanceFromBottom <= threshold
        publishScrollState(isUserScrolling: true)
        if distanceFromTop <= topLoadThreshold { onLoadEarlier() }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        guard !decelerate else { return }
        publishScrollState(isUserScrolling: false)
        maintainBottomIfPinned()
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        publishScrollState(isUserScrolling: false)
        maintainBottomIfPinned()
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        publishScrollState(isUserScrolling: false)
    }

    func scrollViewDidChangeAdjustedContentInset(_ scrollView: UIScrollView) {
        maintainBottomIfPinned()
    }

    private func publishScrollState(isUserScrolling: Bool) {
        publish(
            MessageListScrollState(
                isUserScrolling: isUserScrolling,
                isAtBottom: distanceFromBottom <= threshold
            )
        )
    }

    private func publish(_ state: MessageListScrollState) {
        guard state != lastPublishedScrollState else { return }
        lastPublishedScrollState = state
        onScrollStateChange(state)
    }

    private var maxOffsetY: CGFloat {
        collectionView.contentSize.height
            + collectionView.adjustedContentInset.bottom
            - collectionView.bounds.height
    }

    private var distanceFromBottom: CGFloat {
        max(0, maxOffsetY - collectionView.contentOffset.y)
    }

    private var distanceFromTop: CGFloat {
        max(0, collectionView.contentOffset.y + collectionView.adjustedContentInset.top)
    }

    private func maintainBottomIfPinned(immediately: Bool = false) {
        guard pinnedToBottom else { return }
        guard !collectionView.isTracking,
              !collectionView.isDragging,
              !collectionView.isDecelerating else { return }
        if immediately {
            setOffsetToBottom(animated: Date() < animatedBottomDeadline)
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.setOffsetToBottom(animated: Date() < self.animatedBottomDeadline)
            }
        }
    }

    @discardableResult
    private func attemptScrollToPendingMessage() -> Bool {
        guard let messageId = pendingScrollTargetMessageId,
              let unit = renderedUnits.first(where: { $0.id.messageIDs.contains(messageId) }),
              let indexPath = dataSource.indexPath(for: .unit(unit.id))
        else { return false }
        collectionView.layoutIfNeeded()
        guard let attributes = collectionView.layoutAttributesForItem(at: indexPath) else { return false }
        let minY = -collectionView.adjustedContentInset.top
        let maxY = max(minY, maxOffsetY)
        let targetY = min(
            max(attributes.frame.midY - collectionView.bounds.height * 0.35, minY),
            maxY
        )
        collectionView.setContentOffset(CGPoint(x: 0, y: targetY), animated: false)
        pendingScrollTargetMessageId = nil
        return true
    }

    private func setOffsetToBottom(animated: Bool) {
        guard collectionView.bounds.height > 0, !renderedUnits.isEmpty || hasLooseRuns else { return }
        collectionView.layoutIfNeeded()
        let minY = -collectionView.adjustedContentInset.top
        let targetY = max(minY, maxOffsetY)
        guard abs(targetY - collectionView.contentOffset.y) > 0.5 else { return }
        collectionView.setContentOffset(CGPoint(x: 0, y: targetY), animated: animated)
        guard !collectionView.isTracking, !collectionView.isDragging else { return }
        publish(MessageListScrollState.settledAtBottom)
    }

    private func invalidateTipRowLayout() {
        guard let tip = renderedUnits.last,
              dataSource.indexPath(for: .unit(tip.id)) != nil
        else { return }
        let row = MessageListCollectionRow.unit(tip.id)
        var snapshot = dataSource.snapshot()
        if snapshot.indexOfItem(row) != nil {
            snapshot.reconfigureItems([row])
            dataSource.apply(snapshot, animatingDifferences: false)
        }
        collectionView.collectionViewLayout.invalidateLayout()
        collectionView.setNeedsLayout()
    }

    private func finishInitialScrollIfReady() {
        guard !didInitialScroll,
              collectionView.bounds.height > 0,
              !dataSource.snapshot().itemIdentifiers.isEmpty else { return }
        didInitialScroll = true
        if !attemptScrollToPendingMessage(), pinnedToBottom { setOffsetToBottom(animated: false) }
    }

    private func configuredCell(
        in collectionView: UICollectionView,
        at indexPath: IndexPath,
        for row: MessageListCollectionRow
    ) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: MessageListHostingCell.reuseIdentifier,
            for: indexPath
        )
        cell.backgroundColor = .clear
        cell.contentView.backgroundColor = .clear
        cell.accessibilityIdentifier = row.accessibilityIdentifier
        cell.contentConfiguration = UIHostingConfiguration {
            rowView(for: row)
                .padding(.horizontal, TTSpacing.lg)
                .frame(maxWidth: renderedReadingColumnMaxWidth ?? .infinity, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
        }
        .margins(.all, 0)
        return cell
    }

    private func rowView(for row: MessageListCollectionRow) -> AnyView {
        switch row {
        case let .unit(id):
            guard let unit = unitsByID[id] else { return AnyView(EmptyView()) }
            return rowContent(unit)
        case .looseSubagents:
            return looseRunsContent()
        }
    }

    private func captureViewportAnchor() -> MessageListViewportAnchor? {
        collectionView.layoutIfNeeded()
        let candidates = collectionView.indexPathsForVisibleItems.compactMap { indexPath -> MessageListViewportAnchor? in
            guard let row = dataSource.itemIdentifier(for: indexPath),
                  let attributes = collectionView.layoutAttributesForItem(at: indexPath)
            else { return nil }
            return MessageListViewportAnchor(
                row: row,
                viewportY: attributes.frame.minY - collectionView.contentOffset.y
            )
        }
        return candidates.min { abs($0.viewportY) < abs($1.viewportY) }
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
            collectionView.setContentOffset(
                CGPoint(x: collectionView.contentOffset.x, y: targetY),
                animated: false
            )
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
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: workItem)
    }

    private func clearPrependAnchor() {
        prependAnchorClearWorkItem?.cancel()
        prependAnchorClearWorkItem = nil
        pendingPrependAnchor = nil
    }

    private static func makeLayout() -> UICollectionViewLayout {
        let itemSize = NSCollectionLayoutSize(
            widthDimension: .fractionalWidth(1),
            heightDimension: .estimated(80)
        )
        let item = NSCollectionLayoutItem(layoutSize: itemSize)
        let groupSize = NSCollectionLayoutSize(
            widthDimension: .fractionalWidth(1),
            heightDimension: .estimated(80)
        )
        let group = NSCollectionLayoutGroup.vertical(layoutSize: groupSize, subitems: [item])
        let section = NSCollectionLayoutSection(group: group)
        section.contentInsets = NSDirectionalEdgeInsets(
            top: TTSpacing.md,
            leading: 0,
            bottom: TTSpacing.md,
            trailing: 0
        )
        section.interGroupSpacing = messageListItemSpacing
        return UICollectionViewCompositionalLayout(section: section)
    }
}

private enum MessageListCollectionRow: Hashable {
    case unit(MessageListRenderUnitID)
    case looseSubagents

    var accessibilityIdentifier: String {
        switch self {
        case let .unit(id):
            return "agent-message-cell-\(id.messageIDs.joined(separator: "-"))"
        case .looseSubagents:
            return "agent-message-cell-loose-subagents"
        }
    }
}

private struct MessageListViewportAnchor {
    let row: MessageListCollectionRow
    let viewportY: CGFloat
}

private enum MessageListHostingCell {
    static let reuseIdentifier = "MessageListHostingCell"
}

/// 同用户轮连续 assistant 气泡只在首条显示执行身份（对齐 Electron hideAgentBadge）。
enum MessageListSameTurnPolicy {
    static func shouldHideAgentIdentity(
        for message: ChatMessage,
        in messages: [ChatMessage]
    ) -> Bool {
        guard message.role == .assistant else { return false }
        guard let index = messages.firstIndex(where: { $0.id == message.id }), index > 0 else {
            return false
        }
        for offset in stride(from: index - 1, through: 0, by: -1) {
            let previous = messages[offset]
            switch previous.role {
            case .user:
                return false
            case .system:
                continue
            case .assistant:
                let previousAgent = previous.agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let currentAgent = message.agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !previousAgent.isEmpty, !currentAgent.isEmpty, previousAgent != currentAgent {
                    return false
                }
                return true
            }
        }
        return false
    }
}

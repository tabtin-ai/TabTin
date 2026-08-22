import SwiftUI
import UIKit
@preconcurrency import MarkdownUI

private let assistantTimelineItemSpacing: CGFloat = TTSpacing.xs

/// 把工具 inputJson 解析成字典（含 `kwargs` 展平），供子 Agent 派发判定等复用。
private func subagentToolInputObject(from raw: String) -> [String: Any]? {
    guard let data = raw.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any]
    else { return nil }
    if let kwargs = object["kwargs"] as? [String: Any] {
        return object.merging(kwargs) { current, _ in current }
    }
    return object
}

/// 单条消息气泡。user 右对齐非对称圆角气泡；assistant 全宽无气泡 + 有序 BlockTimeline；
/// system 居中胶囊。视觉**优先对齐 Electron**（其次旧 iOS）：
/// - 只读工具（read / search / grep…）→ 无背景紧凑行（CompactToolRow）；
/// - 副作用工具（bash / sql / edit / write…）→ 无背景 step row（ToolStepCard），
///   展开后再露出下沉详情区；
/// - 成功工具默认折叠，运行中 / 失败默认展开；失败态（is_error）用红色状态图标 + 红色标签。
/// - 思考段与紧凑工具共用「step row」视觉（无整卡背景、弱化色）；
/// - 流式不画闪烁光标，末尾用小转圈表达生成中（对齐 Electron BlockTimeline 尾 spinner）。
/// 工具结果（tool_result）已接通数据管线：展开态按工具类型渲染 terminal / diff / SQL / search 等专用详情。
struct MessageBubbleView: View {
    let message: ChatMessage
    /// 仅流式展示路径注入。正文 delta 命中引用叶子时，气泡壳不读取高频字符串。
    var textLeafModels: [String: MessageTextLeafModel] = [:]
    /// 由消息级 agentId 解析出的身份；nil 表示老消息没有可归属的执行者。
    var agentOption: ComposerTaskAgentOption?
    /// 同用户轮续写气泡隐藏身份牌（对齐 Electron `hideAgentBadge`）。
    var hideAgentIdentity: Bool = false
    var subagentRuns: [SubagentRun] = []
    var formalMediaArtifactToolUseIds: Set<String> = []
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
    var isEditing = false
    var isEditSubmitting = false
    var editError: String?
    var onCopyMessage: (ChatMessage) -> Void = { _ in }
    var onQuoteMessage: (ChatMessage) -> Void = { _ in }
    var onEditMessage: (ChatMessage) -> Void = { _ in }
    var onCancelEdit: () -> Void = {}
    var onSubmitEdit: (ChatMessage, String) -> Void = { _, _ in }
    var onForkMessage: (ChatMessage) -> Void = { _ in }
    var onErrorAction: (ChatErrorAction, ChatMessage) -> Void = { _, _ in }
    var isReadOnly = false
    @State private var previewAttachment: AttachmentBlock?

    var body: some View {
        Group {
            if isEditing, message.role == .user {
                UserMessageInlineEditor(
                    originalText: message.text,
                    isSubmitting: isEditSubmitting,
                    errorMessage: editError,
                    onCancel: onCancelEdit,
                    onSubmit: { onSubmitEdit(message, $0) }
                )
            } else {
                renderedMessage.contextMenu { messageActions }
            }
        }
        .sheet(item: $previewAttachment) { attachment in
            ChatAttachmentPreviewSheet(attachment: attachment)
        }
    }

    @ViewBuilder
    private var renderedMessage: some View {
        // 对齐 Electron SystemMessageRenderer：压缩检查点 / 进行中 pill，禁止摘要正文。
        if CompactionSummaryPresentation.isInProgressPlaceholder(message) {
            CompactionStatusPill(style: .inProgress)
        } else if message.isCompactionSummary {
            CompactionStatusPill(style: .checkpoint)
        } else if message.isPushNotification {
            // 对齐 Electron PushNotificationBubble：伪用户消息 → 系统通知卡，不裸显 XML。
            pushNotificationNotice
        } else {
            switch message.role {
            case .user:
                userBubble
            case .assistant:
                if let plan = message.planProposal {
                    PlanProposalCard(message: message, proposal: plan,
                                     onExecute: onExecutePlan, onOpen: onOpenPlan)
                } else if let mode = message.modeSwitchProposal {
                    ModeSwitchProposalCard(message: message, proposal: mode,
                                           onApprove: onApproveModeSwitch, onIgnore: onIgnoreProposal)
                } else {
                    assistantBlock
                }
            case .system:
                systemNotice
            }
        }
    }

    @ViewBuilder
    private var messageActions: some View {
        if message.isCompactionSummary
            || CompactionSummaryPresentation.isInProgressPlaceholder(message)
            || message.isPushNotification {
            // 压缩 pill / 后台完成通知不是可编辑用户话。
            EmptyView()
        } else {
            compactionSafeMessageActions
        }
    }

    @ViewBuilder
    private var compactionSafeMessageActions: some View {
        Button {
            onCopyMessage(message)
        } label: {
            Label("复制", systemImage: "doc.on.doc")
        }

        if !isReadOnly, MessageQuote.payload(for: message) != nil {
            Button {
                onQuoteMessage(message)
            } label: {
                Label("引用", systemImage: "quote.bubble")
            }
        }

        if !isReadOnly, message.role == .user, !message.isPushNotification {
            Button {
                onEditMessage(message)
            } label: {
                Label("编辑并重发", systemImage: "pencil")
            }
            .disabled(!message.isEditableUserText)
        }

        if !isReadOnly {
            Button {
                onForkMessage(message)
            } label: {
                Label("从这里分叉", systemImage: "arrow.branch")
            }
        }

        // 与 Electron 一致：先允许对已结束的 assistant 消息请求回退预览，
        // 由服务端返回实际可恢复的对话、文件和资源范围。checkpointRecord
        // 只是随历史返回的可选展示元数据，不能据此隐藏入口。
        if !isReadOnly, message.role == .assistant, !message.isStreaming {
            Button {
                onRewind(message)
            } label: {
                Label("回滚到这里", systemImage: "arrow.uturn.backward")
            }
        }

        if !isReadOnly, message.role == .assistant,
           let agentRunId = message.agentRunId,
           !agentRunId.isEmpty {
            Button {
                onRollbackAgentRun(agentRunId)
            } label: {
                Label("回滚本轮", systemImage: "arrow.uturn.backward.circle")
            }
        }
    }

    // MARK: - User

    private var userAttachments: [AttachmentBlock] {
        message.blocks.compactMap { block in
            guard case let .attachment(attachment) = block else { return nil }
            return attachment
        }
    }

    private var userTextBlocks: [TextBlock] {
        message.blocks.compactMap { block in
            guard case let .text(text) = block else { return nil }
            return text
        }
    }

    private var userBubble: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: TTSpacing.xs) {
                ForEach(userAttachments) { attachment in
                    AttachmentBlockCard(attachment: attachment) { previewAttachment = attachment }
                }
                ForEach(userTextBlocks) { text in
                    if !text.text.isEmpty {
                        userTextBubble(text.text)
                    }
                }
                ForEach(message.blocks) { block in
                    switch block {
                    case .text, .attachment:
                        EmptyView()
                    case let .contextRef(ref):
                        ContextRefBlockCard(block: ref)
                            .frame(maxWidth: 280)
                    default:
                        EmptyView()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func userTextBubble(_ text: String) -> some View {
        if let quote = MessageQuote.parseComposerDraft(text) {
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                sentMessageQuote(quote)
                if !quote.reply.isEmpty {
                    Text(quote.reply)
                        .font(ConversationTypography.bodyFont)
                        .lineSpacing(ConversationTypography.bodyLineSpacing)
                        .foregroundStyle(.tt.textPrimary)
                }
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm + 2)
            .background(TTBubbleShape.outgoing.fill(.tt.bgBubbleOutgoing))
        } else {
            Text(text)
                .font(ConversationTypography.bodyFont)
                .lineSpacing(ConversationTypography.bodyLineSpacing)
                .foregroundStyle(.tt.textPrimary)
                .padding(.horizontal, TTSpacing.md)
                .padding(.vertical, TTSpacing.sm + 2)
                .background(TTBubbleShape.outgoing.fill(.tt.bgBubbleOutgoing))
        }
    }

    private func sentMessageQuote(_ quote: ComposerMessageQuote) -> some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "quote.bubble")
                .font(.tt.iconCaptionMedium)
                .foregroundStyle(.tt.textAccent)
                .frame(width: 24, height: 24)
                .background(.tt.iconAccent.opacity(0.10), in: Circle())

            VStack(alignment: .leading, spacing: 0) {
                Text(quote.author == "我" ? "引用我的消息" : "引用 Agent 的回复")
                    .font(.tt.metaMedium)
                    .foregroundStyle(.tt.textAccent)
                    .lineLimit(1)
                Text(quote.content.replacingOccurrences(of: "\n", with: " "))
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.interactive))
        .accessibilityElement(children: .combine)
    }

    // MARK: - Assistant

    private var assistantBlock: some View {
        VStack(alignment: .leading, spacing: assistantTimelineItemSpacing) {
            if let agentOption, !hideAgentIdentity {
                assistantIdentity(agentOption)
            }
            // 有序时间轴：思考 / 正文 / 工具按 content_block index 真实流序穿插（与 Electron 一致）。
            // 连续执行步骤收敛成一行执行组，详情走抽屉——时间线保持可读。
            ForEach(assistantTimelineUnits) { unit in
                switch unit {
                case let .single(block):
                    blockView(block)
                case let .stepGroup(blocks):
                    ExecutionGroupRow(blocks: blocks)
                }
            }
            // 对齐 Electron AgentAwaitingThought：pending / planningNext 挂在时间线之后；
            // 空 thinking 不占行，由本壳承接，避免把已 settle 的执行组挤到底。
            switch awaitingThoughtPhase {
            case .pending:
                AwaitingThinkingView(mode: .thinking)
            case .planningNext:
                AwaitingThinkingView(mode: .planningNext)
            case .hidden:
                EmptyView()
            }
            if ChatErrorPresentation.shouldPresent(message: message) {
                AssistantErrorCard(message: message, fallbackMessage: message.errorMessage ?? "") { action in
                    onErrorAction(action, message)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, TTSpacing.xxl)
    }

    /// 紧凑身份行放在正文上方，不为整条消息预留头像侧栏：小屏仍保留完整正文宽度，
    /// Dynamic Type 放大时名称截断为一行，头像维持可辨识的 22pt。
    private func assistantIdentity(_ agent: ComposerTaskAgentOption) -> some View {
        HStack(spacing: TTSpacing.xs) {
            AgentAvatar(option: agent, size: 22)
            Text(agent.name)
                .font(ConversationTypography.metaFont)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Agent：\(agent.name)")
        .padding(.bottom, TTSpacing.xxs)
    }

    private var assistantTimelineUnits: [AssistantTimelineUnit] {
        AssistantTimelineUnit.group(assistantTimelineBlocks)
    }

    private var assistantTimelineBlocks: [MessageBlock] {
        if ChatErrorPresentation.isNeutralInterruption(message: message) {
            return message.blocks.filter { block in
                guard case let .text(text) = block else { return true }
                return !ChatErrorPresentation.isRuntimeAbortDiagnostic(text.text)
            }
        }
        return message.blocks
    }

    /// 末条流式 assistant 才挂等待壳；同轮续写气泡由调用方保证通常只有 tip 在 streaming。
    private var awaitingThoughtPhase: AgentAwaitingThoughtPhase {
        AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible: message.isStreaming && message.errorMessage == nil,
            isLastAssistantMessage: message.isStreaming,
            blocks: assistantTimelineBlocks
        )
    }

    @ViewBuilder
    private func blockView(_ block: MessageBlock) -> some View {
        switch block {
        case let .thinking(seg):
            ThinkingStepView(segment: seg)
        case let .tool(tool):
            if tool.isMediaImageGeneration {
                if !MediaImageArtifactDedup.shouldSuppressPreview(
                    tool: tool,
                    formalToolUseIds: formalMediaArtifactToolUseIds
                ) {
                    MediaImageInlineView(tool: tool, imageGallery: richImageGallery)
                }
            } else if isSubagentTool(tool) {
                let run = subagentRun(for: tool)
                SubagentDispatchInlineRow(
                    tool: tool,
                    run: run,
                    onCancel: run.map { r in { onCancelSubagent(r.runId) } }
                )
            } else {
                ToolCardRegistryView(tool: tool)
            }
        case let .attachment(attachment):
            AttachmentBlockCard(attachment: attachment) { previewAttachment = attachment }
        case let .richContent(block):
            RichContentBlockCard(block: block, imageGallery: richImageGallery)
        case let .contextRef(block):
            ContextRefBlockCard(block: block)
        case let .text(textBlock):
            if let leaf = textLeafModels[textBlock.id] {
                MessageTextLeafView(model: leaf)
            } else {
                let displayText = AgentTurnIdentityMarkup.stripped(textBlock.text)
                if !displayText.isEmpty || !textBlock.citations.isEmpty {
                    TextContentBlockView(
                        block: textBlock,
                        displayText: displayText,
                        isStreaming: message.isStreaming
                    )
                }
            }
        }
    }

    private func isSubagentTool(_ tool: ToolCall) -> Bool {
        subagentDispatchToolNames.contains(tool.name)
            && isSubagentDispatchInput(subagentToolInputObject(from: tool.inputJson))
    }

    private func subagentRun(for tool: ToolCall) -> SubagentRun? {
        subagentRuns.first { run in
            run.parentToolCallId == tool.toolCallId
        }
    }

    private var richImageGallery: [RichImageGalleryItem] {
        message.blocks.compactMap { block in
            guard case let .richContent(richBlock) = block else { return nil }
            return RichImageGalleryItem(block: richBlock)
        }
    }

    // MARK: - System

    private var systemNotice: some View {
        HStack {
            Spacer(minLength: TTSpacing.xxl)
            HStack(alignment: .top, spacing: TTSpacing.xs) {
                Image(systemName: "info.circle.fill")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .padding(.top, 2)
                Markdown(message.text)
                    .markdownTheme(.tabtinSystemNotice)
                    .copyOnLongPress(message.text)
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm)
            .background(
                Capsule(style: .continuous)
                    .fill(.tt.bgSubtle)
                    .overlay(Capsule(style: .continuous).strokeBorder(.tt.borderLight, lineWidth: 0.5))
            )
            Spacer(minLength: TTSpacing.xxl)
        }
    }

    /// 后台任务完成通知：居中系统卡 + 一句话摘要（绝不裸显 `<task-notification>` XML）。
    private var pushNotificationNotice: some View {
        let summary = PushNotificationVisibility.displaySummary(
            triggeredBy: message.triggeredBy,
            text: message.text
        )
        return HStack {
            Spacer(minLength: TTSpacing.xxl)
            HStack(alignment: .top, spacing: TTSpacing.xs) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text("系统通知")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                    Text(summary)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm)
            .frame(maxWidth: 360, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                    .fill(.tt.bgSubtle)
                    .overlay(
                        RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                            .strokeBorder(.tt.borderLight, lineWidth: 0.5)
                    )
            )
            Spacer(minLength: TTSpacing.xxl)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("系统通知，\(summary)")
    }
}

/// 连续执行步骤何时收成组头。移动端竖屏两步起折，详情进抽屉。
enum ExecutionGroupPolicy {
    static let collapseCount = 2
}

/// 助手单条消息内的执行时间线。思考和工具保持各自 `MessageBlock` 身份，只在视觉上
/// 归入同一个执行组；这让「思考 → 工具 → 继续思考」既连续，又不会把思考伪装成工具。

enum AssistantTimelineUnit: Identifiable {
    case single(MessageBlock)
    case stepGroup([MessageBlock])

    var id: String {
        switch self {
        case let .single(block):
            return block.id
        case let .stepGroup(blocks):
            let first = blocks.first?.id ?? "empty"
            let last = blocks.last?.id ?? first
            return "step_group_\(first)_\(last)_\(blocks.count)"
        }
    }

    static func group(_ blocks: [MessageBlock]) -> [AssistantTimelineUnit] {
        var units: [AssistantTimelineUnit] = []
        var index = 0

        while index < blocks.count {
            let block = blocks[index]
            // 空 text 对齐 Electron isInertResultEntry：跳过、不打断连续执行段。
            if AgentAwaitingThoughtPresentation.isInertWhitespaceText(block) {
                index += 1
                continue
            }
            guard isCollapsibleStep(block) else {
                units.append(.single(block))
                index += 1
                continue
            }

            var run: [MessageBlock] = [block]
            var end = index + 1
            while end < blocks.count {
                let next = blocks[end]
                if AgentAwaitingThoughtPresentation.isInertWhitespaceText(next) {
                    end += 1
                    continue
                }
                guard isCollapsibleStep(next) else { break }
                run.append(next)
                end += 1
            }

            // 两步起就收成执行组：移动端竖屏放不下连续步骤。
            if run.count >= ExecutionGroupPolicy.collapseCount {
                units.append(.stepGroup(run))
            } else {
                units.append(contentsOf: run.map { .single($0) })
            }
            index = end
        }

        return units
    }

    /// 分组口径与组行 / 抽屉共用 `ExecutionStepPresentation`，避免「谁算一步」在
    /// 两处各写一份后漂移（子 Agent 派发另有聚合形态，不进执行组）。
    private static func isCollapsibleStep(_ block: MessageBlock) -> Bool {
        ExecutionStepPresentation.isExecutionStep(block)
    }
}

private struct SubagentDispatchInlineRow: View {
    let tool: ToolCall
    let run: SubagentRun?
    var onCancel: (() -> Void)? = nil
    @State private var showDetail = false
    /// 本地「取消中」态：点 stop 即置位，显示「取消中…」；终态回流后活跃态消失、按钮自然隐藏。
    @State private var isCancelling = false

    private var input: [String: Any] { subagentToolInputObject(from: tool.inputJson) ?? [:] }
    /// 活跃态（未达终态）才可取消：pending / queued / running。
    private var canCancel: Bool {
        guard onCancel != nil, let status else { return false }
        return status == .pending || status == .queued || status == .running
    }
    private var title: String {
        compact(run?.displayTitle)
            ?? compact(stringValue("description", "prompt", "task", "instructions", "message", in: input), limit: 72)
            ?? "子 Agent"
    }
    private var assignee: String? {
        stringValue("subagent_type", "agent_type", "agent", "role", "name", in: input)
    }
    private var status: SubagentStatus? { run?.status }
    /// 反查到 run 就有完整记录可读；否则至少还有工具本身的入参 / 结果。
    private var hasDetail: Bool {
        run != nil || !tool.inputJson.isEmpty || tool.hasResult || tool.isError
    }

    /// 子 Agent 派发行与工具行同一交互口径：时间线只留一行，详情一律进抽屉
    /// （有 run 走完整执行记录，没有则退回该次派发调用的输入 / 结果）。
    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            Button {
                guard hasDetail else { return }
                showDetail = true
            } label: {
                HStack(spacing: TTSpacing.xs) {
                    statusIcon
                        .frame(width: 16, height: 16)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title)
                            .font(.tt.metaSemibold)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)
                        if let metaText {
                            Text(metaText)
                                .font(.tt.codeXS)
                                .foregroundStyle(.tt.textTertiary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    Text(statusLabel)
                        .font(.tt.captionSemibold)
                        .foregroundStyle(statusColor)
                    if hasDetail {
                        Image(systemName: "chevron.right")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                .padding(.vertical, 2)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasDetail)

            if canCancel {
                stopButton
            }
        }
        .sheet(isPresented: $showDetail) {
            if let run {
                SubagentDetailSheet(run: run)
            } else {
                ExecutionDetailSheet(blocks: [.tool(tool)])
            }
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
                Text("取消中…")
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textTertiary)
            } else {
                Image(systemName: "stop.circle")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
        .buttonStyle(.plain)
        .disabled(isCancelling)
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel("停止子 Agent：\(title)")
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch status {
        case .pending, .running:
            ProgressView().controlSize(.mini).tint(.tt.iconAccent)
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
        case nil:
            if tool.isExecutionRunning {
                ProgressView().controlSize(.mini).tint(.tt.iconAccent)
            } else if tool.resolvedExecutionPhase == .failed {
                Image(systemName: "xmark.circle.fill")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textCritical)
            } else {
                Image(systemName: "person.2")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
    }

    private var metaText: String? {
        var parts: [String] = []
        if let assignee, !assignee.isEmpty, assignee != title {
            parts.append(assignee)
        }
        if let run {
            if let stepCount = run.stepCount, stepCount > 0 { parts.append("\(stepCount) 步") }
            if let latestTool = run.latestTool, !latestTool.isEmpty {
                let activity: String
                switch run.latestToolStatus {
                case .pending, .running: activity = "\(latestTool) 执行中"
                case .completed: activity = "\(latestTool) 已完成"
                case .failed: activity = "\(latestTool) 失败"
                case nil: activity = latestTool
                }
                parts.append(activity)
            }
            if let durationMs = run.durationMs {
                parts.append(ToolExecutionDisplay.duration(durationMs))
            }
            if let summary = compact(run.summary, limit: 56) {
                parts.append(summary)
            }
        } else if tool.isExecutionRunning {
            parts.append("启动中")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var statusLabel: String {
        switch status {
        case .pending: return "等待"
        case .queued: return "排队中"
        case .running: return "运行中"
        case .completed: return "完成"
        case .failed: return "失败"
        case .cancelled: return "取消"
        case nil:
            if tool.isExecutionRunning { return "启动中" }
            return tool.resolvedExecutionPhase == .failed ? "失败" : "已派发"
        }
    }

    private var statusColor: Color {
        switch status {
        case .pending, .running:
            return .tt.iconAccent
        case .queued:
            return .tt.textTertiary
        case .completed:
            return .tt.textSuccess
        case .failed:
            return .tt.textCritical
        case .cancelled:
            return .tt.textTertiary
        case nil:
            if tool.isExecutionRunning { return .tt.iconAccent }
            return tool.resolvedExecutionPhase == .failed ? .tt.textCritical : .tt.textSecondary
        }
    }

    private func compact(_ value: String?, limit: Int = 72) -> String? {
        guard let value = value?.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty else { return nil }
        return value.count > limit ? String(value.prefix(limit - 1)) + "…" : value
    }

    private func stringValue(_ keys: String..., in object: [String: Any]) -> String? {
        for key in keys {
            guard let value = object[key] else { continue }
            let text: String
            switch value {
            case let string as String:
                text = string
            case let number as NSNumber:
                text = number.stringValue
            default:
                text = String(describing: value)
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && trimmed != "null" { return trimmed }
        }
        return nil
    }
}

private extension ChatMessage {
    var isEditableUserText: Bool {
        guard role == .user,
              !isCompactionSummary,
              !isPushNotification,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return blocks.allSatisfy {
            switch $0 {
            case .text, .attachment, .contextRef:
                return true
            case .thinking, .tool, .richContent:
                return false
            }
        }
    }
}

// MARK: - Compaction status pill（对齐 Electron SystemMessageRenderer）

private enum CompactionStatusPillStyle {
    case inProgress
    case checkpoint
}

/// Electron：`border-border/60 bg-muted/30` + History 14px + caption；进行中用 ShinyText。
private struct CompactionStatusPill: View {
    let style: CompactionStatusPillStyle

    var body: some View {
        HStack {
            Spacer(minLength: TTSpacing.xxl)
            HStack(spacing: TTSpacing.sm) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(.tt.textTertiary)
                Group {
                    switch style {
                    case .inProgress:
                        ShinyText(text: L10n.Agent.compactionInProgress, active: true)
                    case .checkpoint:
                        Text(L10n.Agent.compactionCheckpoint)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary.opacity(0.9))
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm)
            .background(
                Capsule(style: .continuous)
                    .fill(.tt.bgSubtle.opacity(0.55))
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(.tt.borderLight.opacity(0.7), lineWidth: 0.5)
                    )
            )
            Spacer(minLength: TTSpacing.xxl)
        }
        .padding(.vertical, TTSpacing.xs)
        .accessibilityLabel(
            style == .inProgress
                ? L10n.Agent.compactionInProgress
                : L10n.Agent.compactionCheckpoint
        )
    }
}

private struct UserMessageInlineEditor: View {
    let originalText: String
    let isSubmitting: Bool
    let errorMessage: String?
    var onCancel: () -> Void
    var onSubmit: (String) -> Void

    @State private var text: String
    @FocusState private var focused: Bool

    init(
        originalText: String,
        isSubmitting: Bool,
        errorMessage: String?,
        onCancel: @escaping () -> Void,
        onSubmit: @escaping (String) -> Void
    ) {
        self.originalText = originalText
        self.isSubmitting = isSubmitting
        self.errorMessage = errorMessage
        self.onCancel = onCancel
        self.onSubmit = onSubmit
        _text = State(initialValue: originalText)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSubmit: Bool {
        !isSubmitting
            && !trimmed.isEmpty
            && trimmed != originalText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: TTSpacing.xs) {
            TextEditor(text: $text)
                .focused($focused)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
                .frame(minHeight: 72, maxHeight: 220)
                .scrollContentBackground(.hidden)
                .padding(TTSpacing.sm)
                .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
                .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderInteractive, lineWidth: 1))
                .disabled(isSubmitting)

            Text("编辑会回滚此后的对话，并用新内容重新发送。")
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)

            if let errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textCritical)
                    .multilineTextAlignment(.trailing)
            }

            HStack(spacing: TTSpacing.sm) {
                Spacer(minLength: 0)
                Button("取消", action: onCancel)
                    .font(.tt.captionSemibold)
                    .buttonStyle(.plain)
                    .foregroundStyle(.tt.textSecondary)
                    .disabled(isSubmitting)
                Button {
                    onSubmit(trimmed)
                } label: {
                    HStack(spacing: TTSpacing.xxs) {
                        if isSubmitting {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(.tt.textOnAccent)
                        }
                        Text(isSubmitting ? "重发中" : "重发")
                            .font(.tt.captionSemibold)
                    }
                    .foregroundStyle(canSubmit || isSubmitting ? .tt.textOnAccent : .tt.textOnAccent.opacity(0.5))
                    .padding(.horizontal, TTSpacing.sm)
                    .padding(.vertical, TTSpacing.xxs)
                    .background(Capsule().fill(canSubmit || isSubmitting ? .tt.bgAccent : .tt.bgAccentDisabled))
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .accessibilityLabel(isSubmitting ? "正在重发" : "重发")
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 52)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                focused = true
            }
        }
    }
}

// MARK: - 复制（长按）

extension View {
    /// 长按弹「复制」菜单，替代 `.textSelection(.enabled)`。
    /// textSelection 会给每个文本视图常驻文本交互机制，首响应者/键盘一变就同步重铺，
    /// 长会话里每次点输入框卡几百 ms；contextMenu 懒加载（仅长按时构建），无此开销。
    func copyOnLongPress(_ text: String) -> some View {
        contextMenu {
            Button {
                UIPasteboard.general.string = text
            } label: {
                Label("复制", systemImage: "doc.on.doc")
            }
        }
    }
}

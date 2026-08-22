import SwiftUI

// MARK: - 执行步骤口径

/// 「执行步骤」= 一次思考或一次（非子 Agent）工具调用。
///
/// 时间线只呈现**执行组**这一行锚点，步骤本身的输入 / 输出 / 全文一律进底部抽屉
/// （`ExecutionDetailSheet`）。这与 Electron `CollapsibleToolCardGroup` 的分组口径同源，
/// 差异只在展开容器：桌面端就地内联展开，移动端小屏改为抽屉，避免长执行把正文和
/// Composer 顶出屏幕。
enum ExecutionStepPresentation {
    static func isExecutionStep(_ block: MessageBlock) -> Bool {
        switch block {
        case .thinking:
            return true
        case let .tool(tool):
            // 文生图是主时间线交付面，不进执行组（对齐 DiffCard；勿学 Electron ）。
            if tool.isMediaImageGeneration { return false }
            return !subagentDispatchToolNames.contains(tool.name)
        case .text, .attachment, .richContent, .contextRef:
            return false
        }
    }

    /// 步骤行文案。与时间线单步行、抽屉标题共用同一份，避免两处各自拼接后漂移。
    static func label(for block: MessageBlock) -> String {
        switch block {
        case let .thinking(segment):
            return ThinkingStepPresentation.label(
                for: ThinkingStepPresentation.state(for: segment)
            )
        case let .tool(tool):
            return ToolPresentation.of(tool.name).timelineLabel(
                from: tool.inputJson,
                runtimeTitle: tool.runtimeTitle
            )
        case .text, .attachment, .richContent, .contextRef:
            return ""
        }
    }

    /// Lucide 图标名（与 Electron 同一套导出，见 `scripts/ios-export-lucide-chat-icons.mjs`）。
    static func iconName(for block: MessageBlock) -> String {
        switch block {
        case .thinking:
            return "Brain"
        case let .tool(tool):
            return ToolPresentation.of(tool.name).icon
        case .text, .attachment, .richContent, .contextRef:
            return "Wrench"
        }
    }

    static func isRunning(_ block: MessageBlock) -> Bool {
        switch block {
        case let .thinking(segment):
            return !segment.completed
        case let .tool(tool):
            return tool.isExecutionRunning
        case .text, .attachment, .richContent, .contextRef:
            return false
        }
    }

    static func isFailed(_ block: MessageBlock) -> Bool {
        guard case let .tool(tool) = block else { return false }
        return tool.isError || tool.resolvedExecutionPhase == .failed
    }

    /// 安全护栏命中的证据。抽屉化后不能再自动弹层打断用户，改由组行常驻警示图标表达。
    static func isSuspicious(_ block: MessageBlock) -> Bool {
        guard case let .tool(tool) = block else { return false }
        return tool.hasSuspiciousOutput
    }
}

/// 执行组的聚合状态。组行只呈现这一层摘要——步数 + 失败 / 可疑，
/// 让用户不点开也能判断「这一段有没有出事」。
struct ExecutionGroupSummary: Equatable, Sendable {
    let stepCount: Int
    let runningCount: Int
    let failedCount: Int
    let hasSuspicious: Bool
    /// **末尾**步骤仍在执行时 = 该步 block id；否则 nil。
    ///
    /// 只认末尾这一步（对齐 Electron `activeTailId`）：中间步骤结果滞后不应把整组打散，
    /// 而正在跑的尾步必须留在时间线上实时可见，否则运行中界面看起来像卡死。
    let activeTailId: String?

    init(blocks: [MessageBlock]) {
        let steps = blocks.filter(ExecutionStepPresentation.isExecutionStep)
        stepCount = steps.count
        runningCount = steps.filter(ExecutionStepPresentation.isRunning).count
        failedCount = steps.filter(ExecutionStepPresentation.isFailed).count
        hasSuspicious = steps.contains(where: ExecutionStepPresentation.isSuspicious)
        // 空 streaming thinking 不算可见尾步（对齐 Electron ThinkingBlockView return null），
        // 否则会在组头下再画一行「思考中…」，并把后续步骤视觉上挤到底。
        if let last = steps.last,
           ExecutionStepPresentation.isRunning(last),
           !AgentAwaitingThoughtPresentation.isEmptyStreamingThinking(last) {
            activeTailId = last.id
        } else {
            activeTailId = nil
        }
    }

    var isRunning: Bool { runningCount > 0 }

    /// 组行右侧的结果摘要。成功态不留「已完成」噪声，只在需要复核时出声。
    var statusText: String? {
        failedCount > 0 ? L10n.Agent.executionFailedCount(failedCount) : nil
    }

    var accessibilityLabel: String {
        var parts = [L10n.Agent.executionDetail, L10n.Agent.executionStepCount(stepCount)]
        if let statusText { parts.append(statusText) }
        if hasSuspicious { parts.append(L10n.Agent.executionSuspicious) }
        return parts.joined(separator: "，")
    }
}

/// 抽屉里步骤是否默认展开。
///
/// 口径：**用户点进来最想先看到的先展开**——只有一步时直接铺开（点单步行进来就是要看它），
/// 多步时只展开正在跑的、失败的和安全护栏命中的，其余保持折叠，避免十几步全文一次倾泻。
enum ExecutionStepDetailExpansion {
    static func initialExpanded(for block: MessageBlock, isSoleStep: Bool) -> Bool {
        if isSoleStep { return true }
        return ExecutionStepPresentation.isRunning(block)
            || ExecutionStepPresentation.isFailed(block)
            || ExecutionStepPresentation.isSuspicious(block)
    }

    /// 打开抽屉时滚动定位的目标：优先失败步，其次运行中步；都没有则从头读。
    static func focusTargetId(in blocks: [MessageBlock]) -> String? {
        if let failed = blocks.first(where: ExecutionStepPresentation.isFailed) {
            return failed.id
        }
        return blocks.first(where: ExecutionStepPresentation.isRunning)?.id
    }
}

// MARK: - 执行组行（时间线锚点）

/// 连续执行步骤在时间线上的**唯一**呈现：一行组头 + （仅当末步在跑时）露出的活跃尾步。
///
/// 点组头打开 `ExecutionDetailSheet` 读全部步骤详情。组头本身不做内联展开——移动端
/// 竖屏里内联展开工具详情会把命令、diff、SQL 结果整段塞进阅读流，正文和 Composer
/// 被顶走，这正是本次抽屉化要消除的问题。
struct ExecutionGroupRow: View {
    let blocks: [MessageBlock]

    @State private var showDetailSheet = false

    private var summary: ExecutionGroupSummary { ExecutionGroupSummary(blocks: blocks) }

    private var activeTailBlock: MessageBlock? {
        guard let activeTailId = summary.activeTailId else { return nil }
        return blocks.last { $0.id == activeTailId }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            Button {
                showDetailSheet = true
            } label: {
                HStack(spacing: TTSpacing.xs) {
                    ConversationStepIcon(name: "Layers")

                    ConversationStepLabel(text: headline)

                    if summary.hasSuspicious {
                        Image(systemName: "shield.lefthalf.filled")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textWarning)
                            .accessibilityHidden(true)
                    }
                    if let statusText = summary.statusText {
                        Text(statusText)
                            .font(.tt.codeXS)
                            .foregroundStyle(.tt.textCritical)
                            .lineLimit(1)
                    }

                    Image(systemName: "chevron.right")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textTertiary)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, TTSpacing.xxs)
                // 视觉行高收紧；整行仍可点，宽度拉满保证触控面积。
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summary.accessibilityLabel)
            .accessibilityHint(L10n.Agent.executionDetailHint)

            if let activeTailBlock {
                ExecutionStepTimelineRow(block: activeTailBlock)
                    .padding(.leading, TTSpacing.sm)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(.tt.borderLight)
                            .frame(width: 1)
                    }
                    .padding(.leading, TTSpacing.xs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $showDetailSheet) {
            ExecutionDetailSheet(blocks: blocks)
        }
    }

    /// 「执行详情 · 8 步」。运行中不改文案——正在做什么由下方露出的活跃尾步实时表达。
    private var headline: String {
        "\(L10n.Agent.executionDetail) · \(L10n.Agent.executionStepCount(summary.stepCount))"
    }
}

/// 时间线上的单个执行步骤行（未成组，或成组后露出的活跃尾步）。
struct ExecutionStepTimelineRow: View {
    let block: MessageBlock

    var body: some View {
        switch block {
        case let .thinking(segment):
            ThinkingStepView(segment: segment)
        case let .tool(tool):
            ToolCardRegistryView(tool: tool)
        case .text, .attachment, .richContent, .contextRef:
            EmptyView()
        }
    }
}

// MARK: - 执行详情抽屉

/// 执行详情抽屉。时间线只留组行锚点，命令、diff、SQL 结果和思考全文都在这里读。
///
/// - 步骤按真实流序排列，思考与工具保持各自身份（折叠只改变视觉分组，不把思考伪装成工具）；
/// - 打开即定位到失败 / 运行中的那一步——用户点进来通常是为了找问题；
/// - 流式期间父视图重算会同步刷新本抽屉内容，正在跑的步骤实时更新。
struct ExecutionDetailSheet: View {
    let blocks: [MessageBlock]

    @Environment(\.dismiss) private var dismiss
    @State private var detent: PresentationDetent

    init(blocks: [MessageBlock]) {
        self.blocks = blocks
        // 单步（从时间线单行点进来）半屏够读；整组执行详情内容长，直接给整屏。
        _detent = State(
            initialValue: blocks.filter(ExecutionStepPresentation.isExecutionStep).count <= 1
                ? .medium
                : .large
        )
    }

    private var steps: [MessageBlock] {
        blocks.filter(ExecutionStepPresentation.isExecutionStep)
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: TTSpacing.md) {
                        ForEach(steps) { step in
                            ExecutionStepDetailRow(
                                block: step,
                                isSoleStep: steps.count == 1
                            )
                            .id(step.id)
                        }
                    }
                    .padding(.horizontal, TTSpacing.lg)
                    .padding(.vertical, TTSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onAppear {
                    guard let target = ExecutionStepDetailExpansion.focusTargetId(in: steps) else {
                        return
                    }
                    proxy.scrollTo(target, anchor: .top)
                }
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n.Common.close) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
    }

    /// 单步时标题就是那一步本身（「思考了 8 秒」/「执行命令」），多步才叫「执行详情」。
    private var title: String {
        guard steps.count == 1, let only = steps.first else {
            return L10n.Agent.executionDetail
        }
        return ExecutionStepPresentation.label(for: only)
    }
}

/// 抽屉里的一步：标题行 + 可展开的详情体。
private struct ExecutionStepDetailRow: View {
    let block: MessageBlock
    let isSoleStep: Bool

    @State private var expanded: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(block: MessageBlock, isSoleStep: Bool) {
        self.block = block
        self.isSoleStep = isSoleStep
        _expanded = State(
            initialValue: ExecutionStepDetailExpansion.initialExpanded(
                for: block,
                isSoleStep: isSoleStep
            )
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            // 只有一步时抽屉本身就是这一步，不再给一个能把内容收起来的空标题行。
            if !isSoleStep {
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                        expanded.toggle()
                    }
                } label: {
                    HStack(spacing: TTSpacing.xs) {
                        ConversationStepIcon(name: ExecutionStepPresentation.iconName(for: block))

                        ConversationStepLabel(
                            text: ExecutionStepPresentation.label(for: block),
                            isRunning: ExecutionStepPresentation.isRunning(block)
                        )

                        if ExecutionStepPresentation.isSuspicious(block) {
                            Image(systemName: "shield.lefthalf.filled")
                                .font(.tt.iconCaption)
                                .foregroundStyle(.tt.textWarning)
                                .accessibilityHidden(true)
                        }
                        if ExecutionStepPresentation.isFailed(block) {
                            Text(L10n.Agent.executionStepFailed)
                                .font(.tt.codeXS)
                                .foregroundStyle(.tt.textCritical)
                        }

                        Spacer(minLength: 0)
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            if expanded {
                detailBody
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private var detailBody: some View {
        switch block {
        case let .thinking(segment):
            ThinkingDetailContent(segment: segment)
                .padding(.leading, isSoleStep ? 0 : TTSpacing.lg)
        case let .tool(tool):
            ToolDetailSections(tool: tool)
                .padding(TTSpacing.sm)
                .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtleSecondary))
                .padding(.leading, isSoleStep ? 0 : TTSpacing.lg)
        case .text, .attachment, .richContent, .contextRef:
            EmptyView()
        }
    }
}

#if DEBUG
#Preview("执行组") {
    let blocks: [MessageBlock] = [
        .thinking(ThinkingSegment(
            messageId: "preview",
            index: 0,
            text: "先看一眼工程结构，再决定从哪个文件动手。",
            completed: true,
            startedAt: Date(timeIntervalSince1970: 0),
            stoppedAt: Date(timeIntervalSince1970: 3)
        )),
        .tool(ToolCall(
            toolCallId: "t1",
            index: 1,
            name: "read_file",
            inputJson: #"{"path":"/repo/Package.swift"}"#,
            finalized: true,
            resultText: "// swift-tools-version:5.9"
        )),
        .tool(ToolCall(
            toolCallId: "t2",
            index: 2,
            name: "bash",
            inputJson: #"{"command":"swift build"}"#,
            finalized: true,
            resultText: #"{"exit_code":1,"stderr":"error: no such module"}"#,
            isError: true
        )),
    ]

    return ScrollView {
        VStack(alignment: .leading, spacing: TTSpacing.lg) {
            ExecutionGroupRow(blocks: blocks)
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Color(uiColor: .systemBackground))
}
#endif

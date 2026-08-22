import SwiftUI
@preconcurrency import MarkdownUI

/// 子 Agent 状态图标——与主对话区派发行 / 内联卡同一套 SF Symbol + token。
struct SubagentStatusIcon: View {
    let status: SubagentStatus

    var body: some View {
        switch status {
        case .pending, .running:
            ProgressView()
                .controlSize(.mini)
                .tint(.tt.iconAccent)
                .frame(width: 18, height: 18)
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
}

/// 子 Agent 完整记录的统一 Sheet 承载层。
///
/// 工具锚定卡片与 loose / trailing 卡片都只负责触发本容器，避免两条展示路径
/// 各自维护一套详情布局与关闭行为。
struct SubagentDetailSheet: View {
    let run: SubagentRun
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SubagentDetailView(run: run)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("完成") { dismiss() }
                    }
                }
        }
    }
}

/// 子 Agent 详情：紧凑头 + 指令 / 中间步骤 / 结果三块。
///
/// 切分见 `SubagentDetailSectioning`；只渲染 transcript 步骤轨，不并列
/// 独立的「工具步 (toolHistory)」节。
struct SubagentDetailView: View {
    let run: SubagentRun

    var body: some View {
        let presentation = SubagentPresentationPolicy.presentation(for: run)
        let sections = SubagentDetailSectioning.sections(for: run)

        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.md) {
                compactHeader(presentation: presentation)

                detailBlock(title: "指令", meta: "来自父 Agent") {
                    if let instruction = sections.instruction {
                        Text(instruction)
                            .font(.tt.body)
                            .foregroundStyle(.tt.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                            .copyOnLongPress(instruction)
                    } else {
                        emptyPlaceholder("暂无任务说明")
                    }
                }

                detailBlock(title: "中间步骤", meta: "\(sections.steps.count)") {
                    if sections.steps.isEmpty {
                        emptyPlaceholder("暂无中间步骤")
                    } else {
                        VStack(alignment: .leading, spacing: TTSpacing.sm) {
                            ForEach(sections.steps) { item in
                                SubagentStepItemView(item: item)
                            }
                        }
                    }
                }

                detailBlock(title: "结果", meta: nil) {
                    resultContent(sections.result)
                }
            }
            .padding(TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle("子 Agent")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Compact header

    private func compactHeader(presentation: SubagentRunPresentation) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(spacing: TTSpacing.sm) {
                SubagentStatusIcon(status: run.status)
                Text(run.displayTitle)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: TTSpacing.xs) {
                    statusPill(presentation.statusLabel)
                    metaPills
                }
                .fixedSize(horizontal: true, vertical: false)

                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    statusPill(presentation.statusLabel)
                    HStack(spacing: TTSpacing.xs) { metaPills }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var metaPills: some View {
        if let stepCount = run.stepCount {
            metaPill("\(stepCount) 步")
        }
        if let elapsedMs = run.durationMs ?? run.elapsedMs {
            metaPill(formatElapsed(elapsedMs))
        }
    }

    private func statusPill(_ label: String) -> some View {
        Text(label)
            .font(.tt.captionSemibold)
            .foregroundStyle(statusPillForeground)
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xxs)
            .background(statusPillForeground.opacity(0.12), in: Capsule())
    }

    private func metaPill(_ text: String) -> some View {
        Text(text)
            .font(.tt.captionSemibold)
            .foregroundStyle(.tt.textSecondary)
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xxs)
            .background(.tt.bgSubtle, in: Capsule())
    }

    private var statusPillForeground: Color {
        switch run.status {
        case .completed: return .tt.textSuccess
        case .failed: return .tt.textCritical
        case .cancelled: return .tt.textTertiary
        case .pending, .queued, .running: return .tt.iconAccent
        }
    }

    // MARK: - Section chrome

    private func detailBlock<Content: View>(
        title: String,
        meta: String?,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: TTSpacing.sm) {
                Text(title)
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textSecondary)
                Spacer(minLength: 0)
                if let meta, !meta.isEmpty {
                    Text(meta)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.tt.bgSubtle)

            content()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(TTSpacing.md)
                .background(.tt.bgBubbleIncoming)
        }
        .clipShape(RoundedRectangle(cornerRadius: TTRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        )
    }

    // MARK: - Result

    @ViewBuilder
    private func resultContent(_ result: SubagentDetailResultSection) -> some View {
        if result.isPendingResult {
            emptyPlaceholder("尚未给出结果")
        } else {
            VStack(alignment: .leading, spacing: TTSpacing.md) {
                ForEach(Array(result.assistantTexts.enumerated()), id: \.offset) { _, text in
                    Markdown(text)
                        .markdownTheme(.tabtin)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .copyOnLongPress(text)
                }

                if let conclusion = result.terminalConclusion {
                    conclusionBar(conclusion)
                }

                if let guidance = result.failureGuidance {
                    Text(guidance)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if result.assistantTexts.isEmpty,
                   result.terminalConclusion == nil,
                   result.failureGuidance == nil {
                    emptyPlaceholder("暂无结果")
                }
            }
        }
    }

    @ViewBuilder
    private func conclusionBar(_ text: String) -> some View {
        let isFailure = run.status == .failed
        // 无 assistant 正文时结论即结果本体，不再套一层「结果摘要」标题框。
        // 失败仍保留「失败结论」标签，方便扫错误原因。
        if isFailure {
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text("失败结论")
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textCritical)
                Text(text)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textCritical)
                    .fixedSize(horizontal: false, vertical: true)
                    .copyOnLongPress(text)
            }
            .padding(TTSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color.tt.bgCritical.opacity(0.08),
                in: RoundedRectangle(cornerRadius: TTRadius.sm)
            )
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .strokeBorder(Color.tt.bgCritical.opacity(0.25), lineWidth: 0.5)
            )
        } else {
            Text(text)
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .copyOnLongPress(text)
        }
    }

    private func emptyPlaceholder(_ text: String) -> some View {
        Text(text)
            .font(.tt.meta)
            .foregroundStyle(.tt.textTertiary)
    }

    private func formatElapsed(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let seconds = Double(ms) / 1000
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        return String(format: "%.0fm%.0fs", (seconds / 60).rounded(.down), seconds.truncatingRemainder(dividingBy: 60))
    }
}

// MARK: - Thinking 标题（对齐主对话纪律）

/// 子 Agent transcript 思考行标题。有 started/stopped 才算「思考了 N 秒」，否则用「思考」。
enum SubagentThinkingStepPresentation {
    static func label(for item: SubagentTranscriptItem) -> String {
        guard item.kind == .thinking else {
            return item.title?.isEmpty == false ? item.title! : "思考"
        }
        if !item.isFinal {
            return L10n.Agent.thinkingInProgress
        }
        if let seconds = elapsedSeconds(for: item), seconds >= 1 {
            return L10n.Agent.thinkingCompletedIn(seconds)
        }
        return L10n.Agent.thinkingCompleted
    }

    static func elapsedSeconds(for item: SubagentTranscriptItem) -> Int? {
        guard let started = item.startedAt, let stopped = item.stoppedAt else { return nil }
        let elapsed = stopped.timeIntervalSince(started)
        guard elapsed >= 1 else { return nil }
        return max(1, Int(elapsed.rounded()))
    }
}

// MARK: - Step items (thinking / tool / …；不含 assistant)

private struct SubagentStepItemView: View {
    let item: SubagentTranscriptItem

    var body: some View {
        switch item.kind {
        case .thinking:
            SubagentTranscriptThinkingCard(item: item)
        case .tool:
            SubagentTranscriptToolCard(item: item)
        case .richContent:
            if let block = item.richContent {
                RichContentBlockCard(block: block)
            } else {
                SubagentTranscriptCollapsibleTextCard(
                    icon: "rectangle.3.group",
                    title: item.title ?? "富内容",
                    text: item.text,
                    color: .tt.textPrimary
                )
            }
        case .contextRef:
            if let block = item.contextRef {
                SubagentContextRefMiniCard(block: block)
            } else {
                SubagentTranscriptCollapsibleTextCard(
                    icon: "square.grid.2x2",
                    title: item.title ?? "上下文引用",
                    text: item.text,
                    color: .tt.textPrimary
                )
            }
        case .system:
            SubagentTranscriptCollapsibleTextCard(
                icon: "info.circle",
                title: item.title ?? "事件",
                text: item.text,
                color: .tt.textPrimary
            )
        case .error:
            SubagentTranscriptCollapsibleTextCard(
                icon: "exclamationmark.triangle.fill",
                title: item.title ?? "错误",
                text: item.text,
                color: .tt.textCritical
            )
        case .assistant:
            EmptyView()
        }
    }
}

/// 思考行：默认收起，标题对齐主对话；预览最多 2 行，展开后全文。
private struct SubagentTranscriptThinkingCard: View {
    let item: SubagentTranscriptItem
    @State private var expanded = false

    private var title: String {
        SubagentThinkingStepPresentation.label(for: item)
    }

    private var bodyText: String? {
        guard let text = item.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        return text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard bodyText != nil else { return }
                withAnimation(.easeInOut(duration: 0.16)) { expanded.toggle() }
            } label: {
                HStack(spacing: TTSpacing.xs) {
                    // 与主对话 ThinkingStepView 同一 Lucide Brain。
                    ConversationStepIcon(name: "Brain")
                    Text(title)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if bodyText != nil {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                .padding(.horizontal, TTSpacing.sm)
                .padding(.vertical, TTSpacing.xs)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(bodyText == nil)

            if let text = bodyText {
                if expanded {
                    Text(text)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, TTSpacing.sm)
                        .padding(.bottom, TTSpacing.sm)
                        .copyOnLongPress(text)
                } else {
                    Text(text)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(2)
                        .padding(.horizontal, TTSpacing.sm)
                        .padding(.bottom, TTSpacing.sm)
                }
            }
        }
        .background(.tt.bgSubtleSecondary, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.sm)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        )
    }
}

private struct SubagentTranscriptToolCard: View {
    let item: SubagentTranscriptItem
    @State private var expanded = false

    private var toolName: String {
        item.title?.isEmpty == false ? item.title! : "工具调用"
    }

    private var presentation: ToolPresentation {
        .of(toolName)
    }

    private var canExpand: Bool {
        item.inputText?.isEmpty == false || item.outputText?.isEmpty == false || item.text?.isEmpty == false
    }

    private var statusLabel: String? {
        if item.isError { return "失败" }
        if !item.isFinal { return "进行中" }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard canExpand else { return }
                withAnimation(.easeInOut(duration: 0.16)) { expanded.toggle() }
            } label: {
                HStack(spacing: TTSpacing.xs) {
                    // 与主对话 ToolTimelineStepRow 同一 Lucide 工具图标，不再叠 checkmark。
                    ConversationStepIcon(name: presentation.icon)
                    Text(toolName)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if let statusLabel {
                        Text(statusLabel)
                            .font(.tt.codeXS)
                            .foregroundStyle(item.isError ? .tt.textCritical : .tt.textTertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if canExpand {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                .padding(.horizontal, TTSpacing.sm)
                .padding(.vertical, TTSpacing.xs)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canExpand)

            if expanded {
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    if let input = item.inputText, !input.isEmpty {
                        codeBlock(title: "输入", text: input, isError: false)
                    }
                    if let output = item.outputText, !output.isEmpty {
                        codeBlock(title: item.isError ? "错误" : "结果", text: output, isError: item.isError)
                    } else if let text = item.text, !text.isEmpty {
                        codeBlock(title: "详情", text: text, isError: item.isError)
                    }
                }
                .padding(.horizontal, TTSpacing.sm)
                .padding(.bottom, TTSpacing.sm)
            }
        }
        .background(
            (item.isError ? Color.tt.bgCritical.opacity(0.06) : Color.tt.bgSubtleSecondary),
            in: RoundedRectangle(cornerRadius: TTRadius.sm)
        )
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.sm)
                .strokeBorder(
                    item.isError ? Color.tt.bgCritical.opacity(0.35) : Color.tt.borderLight,
                    lineWidth: 0.5
                )
        )
    }

    private func codeBlock(title: String, text: String, isError: Bool) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            Text(title)
                .font(.tt.captionMedium)
                .foregroundStyle(isError ? .tt.textCritical : .tt.textTertiary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.tt.codeXS)
                    .foregroundStyle(isError ? .tt.textCritical : .tt.textPrimary)
                    .padding(TTSpacing.xs)
                    .copyOnLongPress(text)
            }
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.xs))
        }
    }
}

/// system / error / 无结构化 rich·context 的回落卡片：短文直接可读，过长默认折叠。
private struct SubagentTranscriptCollapsibleTextCard: View {
    let icon: String
    let title: String
    let text: String?
    var color: Color = .tt.textPrimary

    @State private var expanded = false

    private static let collapseCharacterThreshold = 160

    private var trimmedText: String? {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var isLong: Bool {
        (trimmedText?.count ?? 0) > Self.collapseCharacterThreshold
    }

    private var isCritical: Bool { color == .tt.textCritical }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: TTSpacing.sm) {
                Image(systemName: icon)
                    .font(.tt.iconCaption)
                    .foregroundStyle(isCritical ? .tt.textCritical : .tt.iconAccent)
                    .frame(width: 18)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    HStack(spacing: TTSpacing.xs) {
                        Text(title)
                            .font(.tt.captionSemibold)
                            .foregroundStyle(isCritical ? .tt.textCritical : .tt.textSecondary)
                        Spacer(minLength: 0)
                        if isLong {
                            Button {
                                withAnimation(.easeInOut(duration: 0.16)) { expanded.toggle() }
                            } label: {
                                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                    .font(.tt.iconCaption)
                                    .foregroundStyle(.tt.textTertiary)
                                    .frame(minWidth: 44, minHeight: 28, alignment: .trailing)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if let text = trimmedText {
                        Text(text)
                            .font(.tt.meta)
                            .foregroundStyle(color)
                            .lineLimit(isLong && !expanded ? 3 : nil)
                            .fixedSize(horizontal: false, vertical: true)
                            .copyOnLongPress(text)
                    }
                }
            }
            .padding(TTSpacing.sm)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            (isCritical ? Color.tt.bgCritical.opacity(0.06) : Color.tt.bgSubtleSecondary),
            in: RoundedRectangle(cornerRadius: TTRadius.sm)
        )
    }
}

private struct SubagentContextRefMiniCard: View {
    let block: ContextRefBlock

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: icon)
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 18)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(typeLabel)
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textSecondary)
                Text(block.label)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                if let preview = block.preview, !preview.isEmpty {
                    Text(preview)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(3)
                }
                if let location = block.locationHint, !location.isEmpty {
                    Text(location)
                        .font(.tt.codeXS)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(TTSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtleSecondary, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private var typeLabel: String {
        switch block.type {
        case "table_selection", "table": return "表格引用"
        case "doc_selection", "document", "doc": return "文档引用"
        case "web", "webpage", "search_result": return "网页引用"
        case "code", "code_file": return "代码引用"
        default: return "上下文引用"
        }
    }

    private var icon: String {
        switch block.type {
        case "table_selection", "table": return "tablecells"
        case "doc_selection", "document", "doc": return "doc.text"
        case "web", "webpage", "search_result": return "globe"
        case "code", "code_file": return "chevron.left.forwardslash.chevron.right"
        default: return "square.grid.2x2"
        }
    }
}
